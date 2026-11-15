// open-dialogues.mjs — the open dialogues this session takes part in (docs/dialogue.md, the
// two-party harness). One module, four users:
//
//  - the status line (statusline.mjs) calls the DETECTION on every transcript line it scans and
//    reads the STATE FILE the probe writes. It never opens a dialogue file itself: dialogue files
//    often sit on network shares, and a render must never wait on one.
//  - the PROBE (`node open-dialogues.mjs --probe <rollup stats path> <state path>`), started by the
//    status line in the background, reads the tail of each dialogue file under a per-file time
//    limit and a hard deadline, and writes the state file atomically.
//  - /handover Step 0 runs `--session` (a compact summary, the full report in a Markdown file) and
//    the two writers of a dialogue file, `--close` and `--append`. Both open existing files only —
//    nothing here creates one.
//  - the pickup rejoin runs `--status <file>`, one time-limited read, before it arms a watch.
//
// Detection rule: an `assistant` transcript line with a `tool_use` block whose string
// `input.command`, after dropping leading blank lines and leading `#` lines, BEGINS with the
// protocol §6 watch: `$f = "<file>"; $me = "<label>"` (PowerShell) or `f="<file>"; me="<label>"`
// (bash). A command that only CARRIES a watch command inside a string (a launch prompt, a
// clipboard copy) does not begin with it, so it does not count.
//
// Node 18 APIs only: the public kit's CI runs this on Linux, macOS and Windows, Node 18 to 22.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve, isAbsolute, basename, dirname } from 'node:path';
import { EOL, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nowEpoch, atomicWriteFile } from './_sl-compat.mjs';
import { resolveConfigHome } from './sidecar-path.mjs';

// --- The named limits (docs name them, never their values) ------------------------------------
// The probe interval: how old a state entry may get before a render starts a new probe.
export const PROBE_INTERVAL_SEC = 30;
// The per-file time limit: one dialogue file's open + read (and `--close`'s open + read + write).
export const FILE_TIMEOUT_MS = 5000;
// The hard deadline: the probe writes what it has and exits, whatever is still pending.
export const PROBE_DEADLINE_MS = 15000;
// The pid-reuse window: a probe guard older than this counts as stale even if its pid is alive.
export const PID_REUSE_SEC = 600;

// The CLAUDE_SL_DIALOGUE_* overrides (the test seam). Unset or invalid → the constant.
function envNumber(env, name, fallback, { allowZero = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) return fallback;
  return n;
}
export function resolveLimits(env = process.env) {
  return {
    intervalSec: envNumber(env, 'CLAUDE_SL_DIALOGUE_INTERVAL_SEC', PROBE_INTERVAL_SEC),
    fileMs: envNumber(env, 'CLAUDE_SL_DIALOGUE_FILE_MS', FILE_TIMEOUT_MS),
    deadlineMs: envNumber(env, 'CLAUDE_SL_DIALOGUE_DEADLINE_MS', PROBE_DEADLINE_MS),
    reuseSec: envNumber(env, 'CLAUDE_SL_DIALOGUE_REUSE_SEC', PID_REUSE_SEC),
    closeDelayMs: envNumber(env, 'CLAUDE_SL_DIALOGUE_CLOSE_DELAY_MS', 0, { allowZero: true }),
  };
}
function withDefaults(limits) {
  return { ...resolveLimits({}), ...(limits || {}) };
}

// --- Detection ----------------------------------------------------------------------------------
// The raw-line pre-test: the watch's `$me = "` / `me="` as it appears JSON-encoded. A line without
// it never reaches the content-block inspection, so ordinary lines cost one substring search.
const PRETEST_PS = 'me = \\"';
const PRETEST_BASH = 'me=\\"';
// Test seam: how many lines passed the pre-test and were inspected.
export const detectionStats = { inspected: 0 };

const WATCH_PS = /^\$f = "([^"]*)"; \$me = "([^"]*)"/;
const WATCH_BASH = /^f="([^"]*)"; me="([^"]*)"/;

// The command's watch, or null. Leading blank lines and leading `#` lines (a `#posix:` marker) are
// dropped first; an unfilled template (`<` in the file or the label) is not a watch.
export function parseWatchCommand(command) {
  if (typeof command !== 'string') return null;
  const lines = command.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('#'))) i++;
  const head = lines.slice(i).join('\n');
  let m = WATCH_PS.exec(head), shell = 'powershell';
  if (!m) { m = WATCH_BASH.exec(head); shell = 'bash'; }
  if (!m) return null;
  const [, file, label] = m;
  if (!file || !label || file.includes('<') || label.includes('<')) return null;
  return { file, label, shell };
}

// The identity of a dialogue: its absolute path, lowercased with `/` separators on Windows,
// unchanged elsewhere.
export function dialogueKey(file, platform = process.platform) {
  const s = String(file);
  return platform === 'win32' ? s.toLowerCase().replace(/\\/g, '/') : s;
}

function resolveDialoguePath(file, lineCwd, fallbackCwd) {
  if (isAbsolute(file)) return resolve(file);
  const base = lineCwd || fallbackCwd;
  return base ? resolve(base, file) : resolve(file);
}

// Record one entry in `list` (in place): one entry per key; a later arm replaces the label, the
// shell and the command.
function mergeDialogue(list, entry) {
  const k = dialogueKey(entry.file);
  const i = list.findIndex((x) => x && dialogueKey(x.file) === k);
  if (i < 0) list.push(entry);
  else list[i] = { ...list[i], label: entry.label, shell: entry.shell, command: entry.command };
}

// THE detection, one transcript line at a time. `parsed` is the line's already-parsed object when
// the caller has one (the status line's scan); otherwise the line is parsed here. Returns true when
// the line contributed a dialogue.
export function detectDialoguesInLine(line, fallbackCwd, list, parsed) {
  if (typeof line !== 'string' || (!line.includes(PRETEST_PS) && !line.includes(PRETEST_BASH))) return false;
  detectionStats.inspected++;
  let p = parsed;
  if (p === undefined) { try { p = JSON.parse(line); } catch { return false; } }
  if (!p || p.type !== 'assistant') return false;
  const content = p?.message?.content;
  if (!Array.isArray(content)) return false;
  let found = false;
  for (const b of content) {
    if (!b || b.type !== 'tool_use' || typeof b?.input?.command !== 'string') continue;
    const w = parseWatchCommand(b.input.command);
    if (!w) continue;
    const lineCwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
    mergeDialogue(list, {
      file: resolveDialoguePath(w.file, lineCwd, fallbackCwd),
      label: w.label, shell: w.shell, command: b.input.command,
    });
    found = true;
  }
  return found;
}

// The detection over a whole text (the backfill, `--session`).
export function detectDialoguesInText(text, fallbackCwd, list = []) {
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line) detectDialoguesInLine(line, fallbackCwd, list);
  }
  return list;
}

// --- Reading a dialogue file under a time limit -------------------------------------------------
// How many raced file operations have not settled yet. A read blocked on a share that does not
// answer occupies a libuv pool thread, and a normal process exit joins those threads, so it would
// wait for the share after all; the CLI ends itself the hard way while one is pending (see below).
let pendingOps = 0;
// Resolves to { value } | { error } | { timeout: true }; never rejects. A late result of a timed-out
// open is closed when it arrives.
function race(promise, ms) {
  pendingOps++;
  promise.then(() => { pendingOps--; }, () => { pendingOps--; });
  return new Promise((done) => {
    let settled = false;
    const t = setTimeout(() => { settled = true; done({ timeout: true }); }, Math.max(0, ms));
    promise.then(
      (value) => {
        if (!settled) { settled = true; clearTimeout(t); done({ value }); }
        else if (value && typeof value.close === 'function') value.close().catch(() => {});
      },
      (error) => { if (!settled) { settled = true; clearTimeout(t); done({ error }); } },
    );
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The last non-empty line of a text: trailing `\r` dropped, a leading BOM dropped; null when none.
export function lastNonEmptyLine(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let l = lines[i].replace(/\r$/, '');
    if (i === 0) l = l.replace(/^﻿/, '');
    if (l.trim() !== '') return l;
  }
  return null;
}
const isClosedLine = (l) => typeof l === 'string' && l.includes('DIALOGUE CLOSED');

// Read backward from the end in chunks until the bytes hold a line break before the last non-empty
// content (or the start of the file). Cutting at a `\n` byte never splits a UTF-8 character.
const TAIL_CHUNK = 8192;
const isBlankByte = (c) => c === 0x0a || c === 0x0d || c === 0x20 || c === 0x09;
// A dialogue is a regular file. A directory or a pipe at the path is a read failure (unreadable),
// never an empty dialogue — on Windows a directory opens without error.
async function regularFileSize(fh) {
  const st = await fh.stat();
  if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' });
  return st.size;
}
async function readLastLineFromHandle(fh) {
  const size = await regularFileSize(fh);
  let pos = size;
  let buf = Buffer.alloc(0);
  for (;;) {
    let end = buf.length;
    while (end > 0 && isBlankByte(buf[end - 1])) end--;
    if (end > 0) {
      const nl = buf.lastIndexOf(0x0a, end - 1);
      if (nl >= 0) return lastNonEmptyLine(buf.subarray(nl + 1, end).toString('utf8'));
    }
    if (pos === 0) return end > 0 ? lastNonEmptyLine(buf.subarray(0, end).toString('utf8')) : null;
    const start = Math.max(0, pos - TAIL_CHUNK);
    const chunk = Buffer.alloc(pos - start);
    const { bytesRead } = await fh.read(chunk, 0, chunk.length, start);
    buf = Buffer.concat([chunk.subarray(0, bytesRead), buf]);
    pos = start;
  }
}

// Open a dialogue file read-only within `ms`, run `fn(handle)` within what is left, close it.
// → { state: 'ok', value } | { state: 'missing' } | { state: 'unreadable' }.
async function withReadHandle(file, ms, fn) {
  const t0 = Date.now();
  const o = await race(open(file, 'r'), ms);
  if (o.timeout) return { state: 'unreadable' };
  if (o.error) return { state: o.error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  const fh = o.value;
  try {
    const r = await race(fn(fh), ms - (Date.now() - t0));
    if (r.timeout || r.error) return { state: 'unreadable' };
    return { state: 'ok', value: r.value };
  } finally {
    fh.close().catch(() => {});
  }
}

// Classify one dialogue file from its tail: open | closed | missing | unreadable.
export async function classifyDialogueFile(file, fileMs = FILE_TIMEOUT_MS) {
  const r = await withReadHandle(file, fileMs, readLastLineFromHandle);
  if (r.state !== 'ok') return { state: r.state, lastLine: null };
  return { state: isClosedLine(r.value) ? 'closed' : 'open', lastLine: r.value };
}

// --- The state file and the chip's counts -------------------------------------------------------
// How the dialogues of a rollup stand, from the state file: `open` is the chip's total (never-probed,
// open, unreadable and missing all count; closed does not); `due` says a probe should start.
export function dialogueStatus(dialogues, state, now, intervalSec = PROBE_INTERVAL_SEC) {
  let open = 0, unreadable = 0, missing = 0, due = false;
  const entries = (state && typeof state.dialogues === 'object' && state.dialogues) || {};
  const seen = new Set();
  for (const dl of Array.isArray(dialogues) ? dialogues : []) {
    if (!dl || typeof dl.file !== 'string') continue;
    const k = dialogueKey(dl.file);
    if (seen.has(k)) continue;
    seen.add(k);
    const e = Object.prototype.hasOwnProperty.call(entries, k) ? entries[k] : null;
    const st = e && typeof e.state === 'string' ? e.state : null;
    if (st === 'closed') continue;
    open++;
    if (st === 'unreadable') unreadable++;
    if (st === 'missing') missing++;
    const at = e ? Number(e.checkedAt) : NaN;
    if (!st || !Number.isFinite(at) || now - at > intervalSec) due = true;
  }
  return { open, unreadable, missing, due };
}

function readJsonFile(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// The probe: classify every dialogue of the rollup not already known closed, and write the state
// file atomically. Closed is final: a closed entry is carried forward unchanged and never re-read.
// Never touches the guard file (only a render removes it, once it is stale).
export async function probeDialogues(rollupPath, statePath, limits) {
  const lim = withDefaults(limits);
  const rollup = readJsonFile(rollupPath);
  const dialogues = rollup && Array.isArray(rollup.dialogues) ? rollup.dialogues : [];
  const prior = readJsonFile(statePath);
  const out = { ...((prior && typeof prior.dialogues === 'object' && prior.dialogues) || {}) };
  const pending = new Map();
  for (const dl of dialogues) {
    if (!dl || typeof dl.file !== 'string') continue;
    const k = dialogueKey(dl.file);
    if (pending.has(k) || (out[k] && out[k].state === 'closed')) continue;
    pending.set(k, dl.file);
  }
  const results = new Map();
  const jobs = [...pending].map(([k, file]) => classifyDialogueFile(file, lim.fileMs)
    .then((r) => { results.set(k, { ...r, checkedAt: nowEpoch() }); }));
  let timer;
  await Promise.race([
    Promise.all(jobs),
    new Promise((r) => { timer = setTimeout(r, lim.deadlineMs); }),
  ]);
  clearTimeout(timer);
  const now = nowEpoch();
  for (const [k, file] of pending) {
    const r = results.get(k) || { state: 'unreadable', lastLine: null, checkedAt: now };
    out[k] = { file, state: r.state, lastLine: r.lastLine ?? null, checkedAt: r.checkedAt };
  }
  const state = { v: 1, checkedAt: now, dialogues: out };
  atomicWriteFile(statePath, JSON.stringify(state, null, 2));
  return state;
}

// --- `--session`: the whole report for /handover Step 0 ----------------------------------------
const TURN_HEADER = /^##\s+Turn\s+(\d+)\s*[—–-]+\s*(.*?)\s*$/;
const isBatonLine = (l) => /^\s*—/.test(l) && /\bBATON\b/.test(l);
// A signed line (spec §6 step 1, Amendment 3): `— <label> · …`, `<label>` one word of letters, digits
// and hyphens.
const isSignedLine = (l) => /^\s*—\s*[A-Za-z0-9-]+\s+·/.test(l);

function dialogueName(file) {
  return basename(file).replace(/\.md$/i, '').replace(/-dialogue$/i, '');
}

function otherLabelFrom(text, me) {
  const m = /^>?\s*Parties:\s*([A-Za-z0-9-]+)[^\n]*?(?:↔|<->)\s*([A-Za-z0-9-]+)/m.exec(text);
  if (!m) return null;
  if (m[1] === me) return m[2];
  if (m[2] === me) return m[1];
  return null;
}

// Turn structure of a dialogue file, verbatim. Offsets index the text; `lineEnd` excludes the line
// break, `next` is where the following line starts.
function analyzeTurns(text) {
  const lines = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl < 0 ? text.length : nl + 1;
    let lineEnd = nl < 0 ? text.length : nl;
    if (lineEnd > pos && text[lineEnd - 1] === '\r') lineEnd--;
    lines.push({ start: pos, lineEnd, next, text: text.slice(pos, lineEnd) });
    pos = next;
  }
  // Which `## ` headings open a block (spec §6 step 1, Amendments 2 and 3): a `Turn N — …` heading; a
  // heading the Convener authored (it begins with `Convener` / `Convener's`, or one of its ` — ` parts
  // is exactly `CONVENER`); or any heading once the block before it has ended, its last non-empty line
  // (Markdown rules `---` aside) a signed line `— <label> · …` — every baton and the close line, and an
  // entry signed without a baton (`— <party> · AFTER`). Every other `## ` heading is a subheading of
  // the block it sits in (`## Joint summary for the Convener` inside a ratifying turn): it changes
  // neither that block's turn number nor `lastTurn`.
  const turns = [];
  let ended = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].text;
    if (/^##\s/.test(l)) {
      const header = l.replace(/^##\s+/, '').trim();
      const m = TURN_HEADER.exec(l);
      if (m || isConvenerHeading(header) || ended) {
        turns.push({ n: m ? Number(m[1]) : null, header, from: i });
        ended = false;
        continue;
      }
    }
    if (turns.length && l.trim() && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)) ended = isSignedLine(l) || isBatonLine(l) || isClosedLine(l);
  }
  for (let t = 0; t < turns.length; t++) turns[t].to = t + 1 < turns.length ? turns[t + 1].from : lines.length;
  return { lines, turns };
}

function isConvenerHeading(header) {
  return /^convener(?:['’]s)?\b/i.test(header) || header.split(' — ').some((p) => p.trim() === 'CONVENER');
}

export function describeDialogueText(text, me) {
  const { lines, turns } = analyzeTurns(text);
  const lastTurn = turns.length ? turns[turns.length - 1].header : null;
  let ratifiedTurn = null, ratifiedText = null, afterRatifyText = null;
  for (let t = turns.length - 1; t >= 0 && ratifiedTurn === null; t--) {
    for (let i = turns[t].to - 1; i >= turns[t].from; i--) {
      const l = lines[i].text;
      if (isBatonLine(l) && l.includes('RATIFY CONSENSUS') && turns[t].n !== null) {
        ratifiedTurn = turns[t].n;
        ratifiedText = text.slice(lines[turns[t].from].start, lines[i].lineEnd);
        afterRatifyText = text.slice(lines[i].next);
        break;
      }
    }
  }
  return {
    otherLabel: otherLabelFrom(text, me),
    lastLine: lastNonEmptyLine(text),
    lastTurn, ratifiedTurn, ratifiedText, afterRatifyText,
  };
}

function findTranscript(home, sessionId) {
  const projects = join(home, 'projects');
  let dirs;
  try { dirs = readdirSync(projects, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = join(projects, d.name, sessionId + '.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

// This session's id and the dialogues its transcript has armed, or null when either is not found.
export function findSessionDialogues(env = process.env) {
  const sessionId = String(env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (!sessionId) return null;
  const tpath = findTranscript(resolveConfigHome(), sessionId);
  if (!tpath) return null;
  let text;
  try { text = readFileSync(tpath, 'utf8'); } catch { return null; }
  return { sessionId, found: detectDialoguesInText(text, process.cwd()) };
}

// --- The rejoin command: the CURRENT protocol §6 watch ------------------------------------------
// A kept dialogue is rejoined with the watch the deployed protocol prescribes today, filled with the
// dialogue's file and this session's label — never the command copied from the transcript, which may
// be an older template (one without the `$n0` guard wakes at once on every hand-off to the Convener,
// and one without a `DIALOGUE CLOSED` branch never hears the close). The protocol is the
// `dialogue-protocol.md` deployed beside this module, in the same config home.
const PROTOCOL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'dialogue-protocol.md');
let watchTemplates;
function protocolWatchTemplates() {
  if (watchTemplates !== undefined) return watchTemplates;
  watchTemplates = { powershell: null, bash: null };
  let text;
  try { text = readFileSync(PROTOCOL_PATH, 'utf8'); } catch { return watchTemplates; }
  for (const m of text.matchAll(/^```(powershell|bash)[ \t]*\r?\n([\s\S]*?)\r?\n```/gm)) {
    const body = m[2];
    if (m[1] === 'powershell' && !watchTemplates.powershell && body.startsWith('$f = "<DIALOGUE_FILE>"; $me = "<YOUR-LABEL>"')) watchTemplates.powershell = body;
    if (m[1] === 'bash' && !watchTemplates.bash && body.startsWith('f="<DIALOGUE_FILE>"; me="<YOUR-LABEL>"')) watchTemplates.bash = body;
  }
  return watchTemplates;
}
// The current watch for one entry, or null when the protocol or its block cannot be found. The bash
// variant keeps the leading `#` lines of the command the session ran (this env's `#posix:` marker).
export function rejoinCommandFor(dl) {
  const tpl = protocolWatchTemplates()[dl.shell === 'bash' ? 'bash' : 'powershell'];
  if (!tpl) return null;
  // split/join, not String.replace: a path may hold `$&` or `$1`, which replace() would expand.
  const filled = tpl.split('<DIALOGUE_FILE>').join(dl.file).split('<YOUR-LABEL>').join(dl.label);
  if (dl.shell !== 'bash') return filled;
  const lead = [];
  for (const l of String(dl.command ?? '').split(/\r?\n/)) {
    if (l.trimStart().startsWith('#')) lead.push(l);
    else if (l.trim() !== '') break;
  }
  return lead.length ? lead.join('\n') + '\n' + filled : filled;
}

// Read one whole dialogue file under the per-file limit → { state, text } (text only when read).
async function readDialogueFile(file, fileMs) {
  const r = await withReadHandle(file, fileMs, async (fh) => { await regularFileSize(fh); return fh.readFile({ encoding: 'utf8' }); });
  return r.state === 'ok' ? { state: 'ok', text: r.value } : { state: r.state, text: null };
}

// The full report, every field. `pre` is an earlier findSessionDialogues() result, so the CLI reads
// the transcript once.
export async function sessionReport(env = process.env, limits, pre) {
  const lim = withDefaults(limits);
  const s = pre === undefined ? findSessionDialogues(env) : pre;
  if (!s) return { session: null, dialogues: [] };
  const { sessionId, found } = s;
  const entries = await Promise.all(found.map(async (dl) => {
    const r = await readDialogueFile(dl.file, lim.fileMs);
    const base = { name: dialogueName(dl.file), file: dl.file, label: dl.label };
    const tail = { command: dl.command, rejoinCommand: rejoinCommandFor(dl) };
    const nulls = { otherLabel: null, lastLine: null, lastTurn: null, ratifiedTurn: null, ratifiedText: null, afterRatifyText: null };
    if (r.state !== 'ok') return { ...base, ...nulls, state: r.state, ...tail };
    const desc = describeDialogueText(r.text, dl.label);
    if (isClosedLine(desc.lastLine)) return null;
    return {
      ...base, otherLabel: desc.otherLabel, state: 'open', lastLine: desc.lastLine, lastTurn: desc.lastTurn,
      ratifiedTurn: desc.ratifiedTurn, ratifiedText: desc.ratifiedText, afterRatifyText: desc.afterRatifyText,
      ...tail,
    };
  }));
  return { session: sessionId, dialogues: entries.filter(Boolean) };
}

// The printed summary leaves out the four unbounded fields; the Markdown report file holds them.
// (A command output over about 30,000 characters reaches a Claude Code session only as a short
// preview, and `afterRatifyText` has no size bound.)
const LONG_FIELDS = ['ratifiedText', 'afterRatifyText', 'command', 'rejoinCommand'];
export function compactReport(report, reportFile) {
  return {
    session: report.session,
    reportFile: reportFile ?? null,
    dialogues: report.dialogues.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !LONG_FIELDS.includes(k)))),
  };
}
// A fence longer than every backtick run in the text, so the text can never close it early.
function fenced(text, lang = '') {
  const runs = String(text).match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
}
export function reportMarkdown(report) {
  const out = [`# Open dialogues of session ${report.session}`, ''];
  report.dialogues.forEach((d, i) => {
    out.push(`## ${i + 1}. ${d.name}`, '');
    for (const k of ['name', 'file', 'label', 'otherLabel', 'state', 'lastLine', 'lastTurn', 'ratifiedTurn']) {
      out.push(`- ${k}: ${d[k] === null || d[k] === undefined ? 'null' : String(d[k])}`);
    }
    out.push('');
    const block = (title, v, lang) => { out.push(`### ${title}`, '', v === null || v === undefined ? 'null' : fenced(v, lang), ''); };
    block('rejoinCommand', d.rejoinCommand, d.rejoinCommand && !/^\s*(#|f=)/.test(d.rejoinCommand) ? 'powershell' : 'bash');
    block('ratifiedText', d.ratifiedText, 'text');
    block('afterRatifyText', d.afterRatifyText, 'text');
  });
  return out.join('\n');
}
// Writes the Markdown report and returns its path: `outPath`, else the operating system's temp folder.
export function writeSessionReport(report, outPath) {
  const p = outPath ? resolve(outPath) : join(tmpdir(), `open-dialogues-${String(report.session).replace(/[^A-Za-z0-9-]/g, '_')}.md`);
  atomicWriteFile(p, reportMarkdown(report));
  return p;
}

// `--status <file>`: one time-limited read for the rejoin at pickup. Never writes.
export async function dialogueStatusOf(file, limits) {
  const lim = withDefaults(limits);
  const r = await readDialogueFile(file, lim.fileMs);
  if (r.state !== 'ok') return { state: r.state, lastLine: null, lastTurn: null };
  const desc = describeDialogueText(r.text, '');
  return { state: isClosedLine(desc.lastLine) ? 'closed' : 'open', lastLine: desc.lastLine, lastTurn: desc.lastTurn };
}

// --- The two writers: `--close` and `--append` --------------------------------------------------
// Nothing else writes a dialogue file, and neither ever creates one: each opens the file only if it
// already exists (`r+` never creates), within the per-file time limit, reads it, and appends unless
// its last non-empty line already says DIALOGUE CLOSED. Line breaks: the file's own (its first line
// break, else os.EOL); one leading break when the file does not end in one; every written line ends
// in it. `closeDelayMs` waits between the read and the write (the test seam for `unconfirmed`).
// → 'written' | 'already-closed' | 'missing' | 'unreadable' | 'unconfirmed'.
export const CLOSE_LINE = '— CONVENER · DIALOGUE CLOSED';
async function appendToDialogue(file, linesOf, limits) {
  const lim = withDefaults(limits);
  const t0 = Date.now();
  const left = () => lim.fileMs - (Date.now() - t0);
  const o = await race(open(file, 'r+'), lim.fileMs);
  if (o.timeout) return 'unreadable';
  if (o.error) return o.error.code === 'ENOENT' ? 'missing' : 'unreadable';
  const fh = o.value;
  try {
    const rd = await race(regularFileSize(fh).then(() => fh.readFile()), left());
    if (rd.timeout) return 'unconfirmed';
    if (rd.error) return 'unreadable';
    const buf = rd.value;
    const text = buf.toString('utf8');
    if (isClosedLine(lastNonEmptyLine(text))) return 'already-closed';
    if (lim.closeDelayMs > 0) await sleep(lim.closeDelayMs);
    if (left() <= 0) return 'unconfirmed';
    const firstNl = text.indexOf('\n');
    const eol = firstNl < 0 ? EOL : (firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n');
    const lead = buf.length > 0 && buf[buf.length - 1] !== 0x0a ? eol : '';
    const payload = lead + linesOf().map((l) => l + eol).join('');
    const wr = await race(fh.write(payload, buf.length, 'utf8'), left());
    if (wr.timeout || wr.error) return 'unconfirmed';
    return 'written';
  } finally {
    fh.close().catch(() => {});
  }
}
// The close: a one-line record, a blank line, the close line.
// → 'closed' | 'already-closed' | 'missing' | 'unreadable' | 'unconfirmed'.
export async function closeDialogue(file, record, limits) {
  const r = await appendToDialogue(file, () => ['> ' + record, '', CLOSE_LINE], limits);
  return r === 'written' ? 'closed' : r;
}
// A Convener block (or any text) appended to an open dialogue, its line breaks rewritten to the
// file's own; trailing blank lines dropped.
// → 'appended' | 'already-closed' | 'missing' | 'unreadable' | 'unconfirmed'.
export async function appendDialogue(file, text, limits) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const r = await appendToDialogue(file, () => lines, limits);
  return r === 'written' ? 'appended' : r;
}

// --- The libuv pool for reads that run side by side ---------------------------------------------
// An open blocked on a share that does not answer holds a libuv pool thread until the share gives
// up. Files read side by side each need a thread of their own, or a local file queues behind the
// hanging ones and times out as unreadable. The pool size is fixed when the pool first starts, which
// for an ES module is already during loading, so it can only be set in a process's environment
// before it starts: the status line sets it when it spawns the probe, and `--session` re-executes
// itself once when the pool it was started with is too small.
export const POOL_HEADROOM = 4;
const LIBUV_DEFAULT_POOL = 4, LIBUV_MAX_POOL = 1024;
const inheritedPool = (env) => Number(env.UV_THREADPOOL_SIZE) || LIBUV_DEFAULT_POOL;
// The pool to start a process with that reads `nFiles` files side by side.
export function poolSizeFor(nFiles, env = process.env) {
  return Math.min(LIBUV_MAX_POOL, Math.max(inheritedPool(env), Number(nFiles) + POOL_HEADROOM));
}
// Run this same CLI again in a child whose pool fits `nFiles`, when this process's pool does not.
// Returns the child's exit code, or null when no re-exec is needed or it could not start. The child
// carries CLAUDE_SL_DIALOGUE_POOL_REEXEC=1 and never re-executes again, so it cannot loop.
function reexecWithPool(nFiles) {
  if (process.env.CLAUDE_SL_DIALOGUE_POOL_REEXEC === '1') return null;
  if (nFiles <= inheritedPool(process.env)) return null;
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, UV_THREADPOOL_SIZE: String(poolSizeFor(nFiles)), CLAUDE_SL_DIALOGUE_POOL_REEXEC: '1' },
  });
  if (r.error) return null;
  return r.status === null ? 1 : r.status;
}

// --- CLI ----------------------------------------------------------------------------------------
// Each mode resolves to [exit code, stdout text].
async function main(argv) {
  const [mode, a, b, c] = argv;
  if (mode === '--probe' && a && b) {
    try { await probeDialogues(a, b, resolveLimits()); } catch {}
    return [0, ''];
  }
  if (mode === '--session') {
    // `--session [--json] [--out <path>]`: the compact summary on stdout and the full report in a
    // Markdown file, or with `--json` the full report on stdout and no file.
    const rest = argv.slice(1);
    const json = rest.includes('--json');
    const oi = rest.indexOf('--out');
    const outPath = oi >= 0 ? rest[oi + 1] : undefined;
    if (oi >= 0 && !outPath) return usage();
    const pre = findSessionDialogues(process.env);
    const code = pre ? reexecWithPool(pre.found.length) : null;
    if (code !== null) return [code, ''];
    const report = await sessionReport(process.env, resolveLimits(), pre);
    if (json) return [0, JSON.stringify(report, null, 2) + '\n'];
    const reportFile = report.session === null ? null : writeSessionReport(report, outPath);
    return [0, JSON.stringify(compactReport(report, reportFile), null, 2) + '\n'];
  }
  // `--status`, `--close` and `--append` need no pool of their own: each works on one file, one
  // operation at a time, so nothing can queue behind a hanging open.
  if (mode === '--status' && a) {
    return [0, JSON.stringify(await dialogueStatusOf(a, resolveLimits())) + '\n'];
  }
  if (mode === '--close' && a && b === '--record' && typeof c === 'string') {
    return [0, await closeDialogue(a, c, resolveLimits()) + '\n'];
  }
  if (mode === '--append' && a && b === '--text-file' && c) {
    // The block arrives in a UTF-8 file the session wrote with its own write tool (spec §6 step 7,
    // Amendment 2): stdin from Windows PowerShell 5.1 is re-encoded to ASCII, and a multi-line
    // argument needs shell escaping. A leading byte-order mark is dropped (the decoder's default); the
    // file is never deleted. A file that is not valid UTF-8 or holds a NUL byte — what a shell writes
    // as UTF-16 or in the ANSI code page — is refused, since the dialogue is append-only (Amendment 3).
    let buf = null;
    try { buf = readFileSync(c); } catch {}
    let text = '';
    if (buf) {
      try { text = buf.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = null; }
      if (text === null) { process.stderr.write(`--append: the text file ${c} is not valid UTF-8 or holds a NUL byte; nothing written\n`); return [2, '']; }
    }
    if (!text.trim()) { process.stderr.write(`--append: the text file ${c} is missing or empty; nothing written\n`); return [2, '']; }
    return [0, await appendDialogue(a, text, resolveLimits()) + '\n'];
  }
  return usage();
}
function usage() {
  process.stderr.write('usage: open-dialogues.mjs --probe <rollup> <state> | --session [--json] [--out <path>]'
    + ' | --status <file> | --close <file> --record <text> | --append <file> --text-file <path>\n');
  return [2, ''];
}

const isMain = (() => {
  try { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
// The end of a CLI run, once stdout has flushed. With nothing pending, a normal exit. With a file
// operation still pending (a share that does not answer), a normal exit would join the pool thread
// blocked in it and wait for the share: on Windows an SMB open to an unreachable host holds
// process.exit until the network redirector gives up (build check B0, 2026-11-05). A self-kill ends
// the process at once instead (exit status 1 on Windows, SIGKILL elsewhere); what it printed is still
// the result.
function finish(code) {
  if (pendingOps > 0) { try { process.kill(process.pid, 'SIGKILL'); } catch {} }
  process.exit(code);
}
if (isMain) {
  main(process.argv.slice(2)).then(
    ([code, out]) => { if (out) process.stdout.write(out, () => finish(code)); else finish(code); },
    () => finish(1),
  );
}
