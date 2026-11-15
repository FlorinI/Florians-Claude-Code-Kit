// _open-dialogues-harness.mjs — shared rigs for open-dialogues.test.mjs and
// open-dialogues-render.test.mjs (open-dialogues sprint, spec docs/261105-open-dialogues-spec.md).
//
// Not a test file (no `.test.` in the name, so `node --test` never runs it on its own). Exported to
// the public kit beside the two suites that import it.
//
// Every engine run here goes to a CHILD `node statusline.mjs` in a throwaway home + project dir, with
// CLAUDE_SL_DIALOGUE_PROBE=off unless the caller passes a probe setting (test-plan shared rules). Every
// real probe runs as a child too, with the CLAUDE_SL_DIALOGUE_* limits cut well under a second, so a
// hanging read can never keep `node --test` alive. A row that lets a real probe start must call
// `waitProbeExit` on the pid recorded in the guard before it removes its temp directory: the probe never
// deletes its guard, so waiting for the guard to disappear would wait forever (test-plan finding N5).

import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, '..');
export const ENGINE = join(REPO, 'home', 'statusline.mjs');
export const MODULE = join(REPO, 'home', 'open-dialogues.mjs');
export const FIXDIR = join(here, 'fixtures', 'open-dialogues');
export const STUB = join(FIXDIR, 'stub-probe.mjs');
export const IS_WIN = process.platform === 'win32';

// A frozen clock for every engine run: 2026-06-18T12:00:00Z.
export const NOW = 1781784000;

// ---- watch commands, built from the protocol's own §6 templates ---------------------------------
// Read from home/dialogue-protocol.md rather than retyped, so the fixtures follow the template the
// sessions really run. The unfilled template is itself a fixture (D-4).
const protocol = readFileSync(join(REPO, 'home', 'dialogue-protocol.md'), 'utf8').split(/\r?\n/);
export const PS_TEMPLATE = protocol.find((l) => l.startsWith('$f = "<DIALOGUE_FILE>"; $me = "<YOUR-LABEL>"'));
export const BASH_TEMPLATE = protocol.find((l) => l.startsWith('f="<DIALOGUE_FILE>"; me="<YOUR-LABEL>"'));
if (!PS_TEMPLATE || !BASH_TEMPLATE) throw new Error('dialogue-protocol.md §6 watch templates not found');

export const psWatch = (file, label) => PS_TEMPLATE.replace('<DIALOGUE_FILE>', file).replace('<YOUR-LABEL>', label);
// The bash variant as this env runs it: behind a `#posix:` first line.
export const bashWatch = (file, label) => '#posix: dialogue watch, the bash variant\n'
  + BASH_TEMPLATE.replace('<DIALOGUE_FILE>', file).replace('<YOUR-LABEL>', label);

// ---- transcript lines ---------------------------------------------------------------------------
const USAGE = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20000, output_tokens: 500 };
let tsSeq = 0;
const ts = () => new Date(Date.UTC(2026, 5, 18, 2, 0, 0) + (tsSeq++) * 1000).toISOString();

// One leg's first line (a text block) — the line the leg scan banks.
export function legLine(id, { cwd, usage = USAGE } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts(), ...(cwd !== undefined ? { cwd } : {}),
    message: { id, model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }], usage },
  });
}
// A tool_use line. Claude Code writes one line per content block, all with the same message.id, so a
// watch normally sits on a REPEATED id — the leg scan's dedup skips it (spec §2).
export function toolLine(id, command, { cwd, name = 'PowerShell', usage = USAGE } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts(), ...(cwd !== undefined ? { cwd } : {}),
    message: {
      id, model: 'claude-opus-5', role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_' + id + '_' + tsSeq, name, input: { command, run_in_background: true, description: 'Arm the dialogue watch' } }],
      usage,
    },
  });
}
export function userLine(text) {
  return JSON.stringify({ type: 'user', timestamp: ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: text }] } });
}
export const jsonl = (lines) => lines.join('\n') + '\n';

// ---- the sandbox --------------------------------------------------------------------------------
export function sandbox(prefix = 'odlg') {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const home = join(root, 'home');
  const cfg = join(home, '.claude');
  const cwd = join(root, 'proj');
  const files = join(root, 'files');
  for (const d of [cfg, join(cwd, '.claude'), files]) mkdirSync(d, { recursive: true });
  const statsDir = join(cwd, '.claude', 'statusline-stats');
  const pids = [];
  return {
    root, home, cfg, cwd, files, statsDir, pids,
    rollupPath: (sid) => join(statsDir, `${sid}.json`),
    statePath: (sid) => join(statsDir, `${sid}.dialogues.json`),
    guardPath: (sid) => join(statsDir, `${sid}.dialogue-probe.json`),
    async cleanup() {
      // Every registered pid is a probe or stub this row started; a row that needed it to finish has
      // already waited. End the rest, then wait until each is really gone before deleting the dir.
      for (const pid of pids) { try { process.kill(pid); } catch { /* already exited */ } }
      for (const pid of pids) await waitProbeExit(pid, 30000);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// The environment every child gets: the sandbox home, a frozen clock, the probe OFF unless overridden,
// and none of the CLAUDE_SL_DIALOGUE_* values the surrounding shell may carry.
export function childEnv(sb, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_SL_DIALOGUE_') || k.startsWith('STUB_PROBE_')) delete env[k];
  delete env.NODE_TEST_CONTEXT;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  Object.assign(env, {
    USERPROFILE: sb.home, HOME: sb.home, CLAUDE_CONFIG_DIR: sb.cfg, CLAUDE_PROJECT_DIR: sb.cwd,
    TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW), CLAUDE_SL_DIALOGUE_PROBE: 'off',
  });
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = String(v); }
  return env;
}

export function payload(sb, sid, transcript, extra = {}) {
  return JSON.stringify({
    model: { display_name: 'Opus 5' }, version: '2.1.142', effort: { level: 'high' },
    context_window: { used_percentage: 5, total_input_tokens: 50000, context_window_size: 1000000 },
    transcript_path: transcript, session_id: sid,
    cost: { total_cost_usd: 0.25, total_api_duration_ms: 60000 },
    workspace: { current_dir: sb.cwd }, cwd: sb.cwd, rate_limits: {},
    ...extra,
  });
}

export function writeTranscript(sb, sid, lines, name = `${sid}.jsonl`) {
  const p = join(sb.root, name);
  writeFileSync(p, jsonl(lines), 'utf8');
  return p;
}

// One synchronous render. Returns stdout as a string.
export function render(sb, sid, transcript, { env = {}, payloadExtra = {} } = {}) {
  return execFileSync(process.execPath, [ENGINE], {
    input: payload(sb, sid, transcript, payloadExtra), env: childEnv(sb, env), maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
}

// One render the way a host runs it: piped stdout, resolved on `close` (stdout ended AND the process
// exited). Resolves { ms, stdout, code }.
export function renderAsync(sb, sid, transcript, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [ENGINE], { env: childEnv(sb, env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, stdout: out, code }));
    child.stdin.end(payload(sb, sid, transcript));
  });
}

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const readJsonOr = (p, dflt = null) => { try { return readJson(p); } catch { return dflt; } };

// The rollup's `dialogues` list. The spec names the key and what each entry holds (the file path,
// this session's label, the shell variant, the exact command) but not the entry's field names, so the
// rows find values, never fields: an array or an object map both read as a list of entries.
export function dialoguesOf(rollup) {
  const d = rollup ? rollup.dialogues : undefined;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') return Object.values(d);
  return [];
}
// The item-1 key: the absolute path lowercased with `\` turned into `/` on Windows, unchanged elsewhere.
export const keyOf = (p) => (IS_WIN ? String(p).toLowerCase().replace(/\\/g, '/') : String(p));
export const values = (e) => Object.values(e || {});
export const hasPath = (e, p) => values(e).some((v) => typeof v === 'string' && keyOf(v) === keyOf(p));
export const hasValue = (e, v) => values(e).some((x) => x === v);
export const entryFor = (entries, p) => entries.find((e) => hasPath(e, p));

// ---- the module's three CLIs --------------------------------------------------------------------
// Each runs as a child with a timeout, so a hang fails the row instead of the whole suite.
export function cli(args, { env = {}, sb, timeout = 20000, input, module = MODULE } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [module, ...args], {
    env: sb ? childEnv(sb, env) : { ...process.env, ...env }, encoding: 'utf8', timeout, windowsHide: true, input,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - t0, error: r.error };
}
export function cliAsync(args, { env = {}, sb } = {}) {
  const child = spawn(process.execPath, [MODULE, ...args], { env: sb ? childEnv(sb, env) : { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  child.stdout.on('data', (b) => { stdout += b; });
  const t0 = Date.now();
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 })));
  return { child, done };
}

// Short limits for every real probe / --session / --close a row runs (spec §4 test seam).
export const FAST_LIMITS = {
  CLAUDE_SL_DIALOGUE_FILE_MS: 300,
  CLAUDE_SL_DIALOGUE_DEADLINE_MS: 1500,
};

// ---- processes ----------------------------------------------------------------------------------
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export async function waitProbeExit(pid, timeoutMs = 30000) {
  const t0 = Date.now();
  while (pidAlive(pid) && Date.now() - t0 < timeoutMs) await sleep(50);
  return !pidAlive(pid);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A pid that is certainly dead: one above every operating system's pid range (Linux caps pids at
// 2^22, macOS at 99999, Windows hands out multiples of 4 far below 2^30), so no process can hold it.
// The pid of a child that has already exited is NOT certainly dead: under a loaded suite Windows
// hands that pid to a new process within seconds (measured 2026-11-09), and a guard naming it then
// reads as live.
export function deadPid() {
  return 1073741820;   // 2^30 - 4: a multiple of 4, since Windows ignores a pid's two low bits
}
// The pid recorded in the guard, once the claiming render has written it.
export async function guardPid(sb, sid, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const g = readJsonOr(sb.guardPath(sid));
    if (g && Number.isInteger(g.pid)) { sb.pids.push(g.pid); return g.pid; }
    await sleep(25);
  }
  return null;
}

// ---- hanging paths ------------------------------------------------------------------------------
// A path whose open does not answer for a while. Linux / macOS: a FIFO with no writer, whose open
// blocks until a writer appears (never, here). Windows: a UNC path to a reserved documentation
// address (RFC 5737 TEST-NET-1/2/3), whose SMB open waits on a host that never replies — on FAT2 for
// about 2 s or more. A named pipe no longer serves: the probe stats a path before reading it and calls
// anything that is not a regular file `unreadable` at once. Windows caches a host that failed (a
// repeated address fails in about 100 ms), so every call takes a fresh address, starting at a random
// point of the pool so consecutive runs do not reuse the last run's addresses. A row that relies on the
// wait keeps its per-file limit well under 2 s, so the limit ends the read rather than the network,
// and asserts it really waited. Returns { path, close }; close() releases a FIFO-side resource where
// there is one (none today) and is safe to call either way.
const TEST_NETS = ['192.0.2', '198.51.100', '203.0.113'];
let uncSeq = Math.floor(Math.random() * TEST_NETS.length * 254);
const freshUnc = (name) => {
  const i = (uncSeq++) % (TEST_NETS.length * 254);
  return `\\\\${TEST_NETS[Math.floor(i / 254)]}.${(i % 254) + 1}\\x\\${name}-dialogue.md`;
};
export async function hangingPath(dir, name = 'hang') {
  if (!IS_WIN) {
    const p = join(dir, `${name}-dialogue.md`);
    execFileSync('mkfifo', [p]);
    return { path: p, close: async () => {} };
  }
  return { path: freshUnc(name), close: async () => {} };
}

// The skip reason for every row that needs a hang, or false when this host can produce one. Posix
// always can (the FIFO). Windows can only when an SMB open to a TEST-NET address stays unanswered, and
// a CI network may refuse it at once instead — then those rows would fail without testing anything, so
// they skip, saying why. Checked once per process: a child opens a fresh TEST-NET path and reports
// whether the open is still pending after 300 ms, then kills itself (an open that is still pending
// would otherwise hold its exit).
let offlineHang;
export function noOfflineHang() {
  if (process.platform !== 'win32') return false;
  if (offlineHang === undefined) {
    const js = "const fs = require('fs/promises'); let done = false;"
      + " const say = (w) => process.stdout.write(w, () => process.kill(process.pid, 'SIGKILL'));"
      + " fs.open(process.argv[1], 'r').then(() => { done = true; say('answered'); }, () => { done = true; say('refused'); });"
      + " setTimeout(() => { if (!done) say('pending'); }, 300);";
    const r = spawnSync(process.execPath, ['-e', js, freshUnc('hang-check')], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    offlineHang = (r.stdout || '').trim() === 'pending';
  }
  return offlineHang ? false : 'this host refuses TEST-NET at once; no offline Windows hang available';
}

// ---- dialogue fixture files ---------------------------------------------------------------------
// The CRLF and BOM variants are rebuilt at run time from LF text: the kit's checkout normalizes line
// endings (`* text=auto eol=lf`), so a committed CRLF file reaches its CI as LF.
export const fixtureText = (name) => readFileSync(join(FIXDIR, name), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
export function placeFixture(sb, name, { as = name, crlf = false, bom = false, finalBreak = true, sub = '' } = {}) {
  let t = fixtureText(name);
  if (!finalBreak) t = t.replace(/\n+$/, '');
  if (crlf) t = t.replace(/\n/g, '\r\n');
  if (bom) t = '﻿' + t;
  const dir = join(sb.files, sub);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, as);
  writeFileSync(p, t, 'utf8');
  return p;
}

// A temp config home holding `projects/<p>/<sid>.jsonl`, for `--session` (spec §6 step 1).
export function placeSessionTranscript(sb, sid, lines, { cfg = sb.cfg, project = 'example-project' } = {}) {
  const d = join(cfg, 'projects', project);
  mkdirSync(d, { recursive: true });
  const p = join(d, `${sid}.jsonl`);
  writeFileSync(p, jsonl(lines), 'utf8');
  return p;
}

export const lsDir = (d) => (existsSync(d) ? readdirSync(d).sort() : []);
export const ANSI = /\x1b\[[0-9;]*m/g;
export const strip = (s) => String(s).replace(ANSI, '');
