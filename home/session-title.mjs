#!/usr/bin/env node
// session-title.mjs — the one place a session's title is computed.
//
// The `cc` launcher titles the terminal tab and names the session with it; anything that offers a
// session a paste-ready `/rename` line takes the same four rules from this module, so the line a
// session is offered always matches the title its tab carries.
//
//   1. Identity read. <dir>/.desk/session-identity.json when it parses to a JSON object (not an
//      array, not null, not a bare string or number); else <dir>/.claude/session-identity.json (the
//      legacy location) under the same test; else no identity.
//   2. Base name. The identity's `name`, trimmed, when it is a non-empty string; else the origin
//      remote slug (a trailing `.git` removed, then the last segment after `/` or `:`); else the leaf
//      of the git top-level folder; else the leaf of <dir>.
//   3. Branch. The current branch; else the short HEAD (detached); else none. Every git call runs in
//      <dir> with stderr discarded; a failed call is an empty result.
//   4. Title. The core is `<base>@<branch>`, or `<base>` with no branch (a topic appends
//      `: <topic>` to the core). The title is [prefix, core, suffix] with empty parts dropped,
//      joined by single spaces.
//
// Command-line entry: `node session-title.mjs [--topic <slug>]` prints one line, `/rename <title>`.
// The directory is CLAUDE_PROJECT_DIR, else the current directory; the markers are CC_TITLE_PREFIX /
// CC_TITLE_SUFFIX from the environment. A missing or blank `--topic` value means no topic.
//
// The EXIT TITLE: the title the tab keeps after Claude Code exits. The launcher watches its child's
// registry entry while the session runs and, after it exits, resolves the session's final name here:
//   readRegistryEntry(configDir, pid)  <configDir>/sessions/<pid>.json -> { sessionId, name } | null
//   findTranscript(configDir, sid)     <configDir>/projects/*/<sid>.jsonl, the newest when two hold it
//   lastCustomTitle(file)              the transcript's last custom-title line, read backwards, 16 MiB
//   composeExitTitle({...})            transcript name, else registry name, sanitised, markers applied;
//                                      renamed only when the result differs from the launch title
//   exitTitlePath / writeExitTitleFile / readExitTitleFile
//                                      the hand-off to the shell's `--print-title` call: one file per
//                                      shell process id, read once and deleted whatever it says
//
// Zero dependencies beyond node: built-ins and the sibling session-name sanitizer.

import { readFileSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeSessionName } from './sanitize-name.mjs';

const IDENTITY_DIRS = ['.desk', '.claude'];
const IDENTITY_FILE = 'session-identity.json';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The last path segment of a folder path, or the path itself when it has none.
export function dirLeaf(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
}

// Rule 1. `{ identity, file }`: the parsed object and the path it came from, or both null when no
// file holds a JSON object — so a caller can tell "no valid identity file" from "a valid one".
export function readIdentity(dir) {
  for (const sub of IDENTITY_DIRS) {
    const file = join(dir, sub, IDENTITY_FILE);
    try {
      const v = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (isObject(v)) return { identity: v, file };
    } catch { /* absent, unreadable or not JSON: try the next location */ }
  }
  return { identity: null, file: null };
}

// The identity's usable name: a non-empty string after trimming, else ''.
export function identityName(identity) {
  return isObject(identity) && typeof identity.name === 'string' ? identity.name.trim() : '';
}

function git(dir, args) {
  try {
    return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 })
      .toString().trim();
  } catch { return ''; }
}

// Rule 2.
export function baseName(dir, identity) {
  const name = identityName(identity);
  if (name) return name;
  const origin = git(dir, ['config', '--get', 'remote.origin.url']);
  if (origin) { const m = origin.replace(/\.git$/, '').match(/([^:/]+)$/); if (m) return m[1]; }
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top) { const leaf = top.split(/[\\/]/).filter(Boolean).pop(); if (leaf) return leaf; }
  return dirLeaf(dir);
}

// Rule 3.
export function currentBranch(dir) {
  return git(dir, ['branch', '--show-current']) || git(dir, ['rev-parse', '--short', 'HEAD']);
}

// Rule 4, from parts already resolved.
export function composeTitle({ base, branch = '', topic = '', prefix = '', suffix = '' }) {
  let core = branch ? `${base}@${branch}` : base;
  if (topic) core += `: ${topic}`;
  return [prefix, core, suffix].filter(Boolean).join(' ');
}

// All four rules for one directory. `identity` may be passed when the caller already read it
// (undefined → read here).
export function sessionTitle(dir, { identity, topic = '', prefix = '', suffix = '' } = {}) {
  const id = identity === undefined ? readIdentity(dir).identity : identity;
  return composeTitle({
    base: baseName(dir, id),
    branch: currentBranch(dir),
    topic, prefix, suffix,
  });
}

// ── the exit title ──────────────────────────────────────────────────────────────────────────────

// A session id is used as a file name, so it must be one path segment of plain characters: the test
// the rename nudge already applies before it builds a transcript path.
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const isSessionId = (v) => typeof v === 'string' && SESSION_ID_RE.test(v);

// One registry entry, <configDir>/sessions/<pid>.json, written by Claude Code for a live session.
// `{ sessionId, name }` when the file parses to an object whose `pid` is this pid and whose
// `sessionId` is path-safe; `name` is the entry's name when `nameSource` is "user", else ''. Anything
// else (missing, half-written, unreadable, another pid, a hostile id) → null, and the caller keeps its
// previous reading.
export function readRegistryEntry(configDir, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const v = JSON.parse(readFileSync(join(configDir, 'sessions', `${pid}.json`), 'utf8').replace(/^﻿/, ''));
    if (!isObject(v) || v.pid !== pid || !isSessionId(v.sessionId)) return null;
    const name = v.nameSource === 'user' && typeof v.name === 'string' ? v.name : '';
    return { sessionId: v.sessionId, name };
  } catch { return null; }
}

// The session's transcript: <configDir>/projects/<any folder>/<sessionId>.jsonl. Found by scanning the
// project folders for that exact file name, so Claude Code's folder-name munging is never
// re-implemented. Two folders holding it (a copy, a moved cwd) → the most recently modified. A
// hostile id never reaches the filesystem.
export function findTranscript(configDir, sessionId) {
  if (!isSessionId(sessionId)) return null;
  const root = join(configDir, 'projects');
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  let best = null;
  let bestMtime = -Infinity;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(root, e.name, `${sessionId}.jsonl`);
    try {
      const s = statSync(p);
      if (s.isFile() && s.mtimeMs > bestMtime) { best = p; bestMtime = s.mtimeMs; }
    } catch { /* not in this folder */ }
  }
  return best;
}

export const TRANSCRIPT_WINDOW_BYTES = 16 * 1024 * 1024;
const READ_CHUNK = 64 * 1024;

// The customTitle of one transcript line, or null when the line is not a custom-title record with a
// string title. Only a line that contains the record type is decoded, so a multi-megabyte tool result
// costs a byte search, not a JSON parse.
function customTitleOf(line) {
  if (!line.includes('"custom-title"')) return null;
  try {
    const v = JSON.parse(line.toString('utf8'));
    return isObject(v) && v.type === 'custom-title' && typeof v.customTitle === 'string' ? v.customTitle : null;
  } catch { return null; }
}

// The session's current name as its transcript records it: the LAST line whose JSON has
// type "custom-title" and a string customTitle (written at launch for --name, on /rename, and
// re-stamped every few turns). Read BACKWARDS in chunks and stopped at the first match; at most the
// last 16 MiB is read, so a huge transcript cannot hold the prompt back. Lines are split on the LF
// byte, which never occurs inside a UTF-8 multi-byte sequence, so no chunk boundary can split a line
// or a code point. A line cut by the window's start is not a whole line and is not read. null when
// there is none, or the file cannot be read.
export function lastCustomTitle(file, { windowBytes = TRANSCRIPT_WINDOW_BYTES } = {}) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const floor = Math.max(0, size - windowBytes);
    let pos = size;
    let parts = [];               // the pieces, in file order, of a line whose start is before `pos`
    while (pos > floor) {
      const len = Math.min(READ_CHUNK, pos - floor);
      pos -= len;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, pos + got);
        if (n <= 0) break;
        got += n;
      }
      let end = got;
      for (let i = got - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        const piece = buf.subarray(i + 1, end);
        const line = parts.length ? Buffer.concat([piece, ...parts]) : piece;
        parts = [];
        const t = customTitleOf(line);
        if (t !== null) return t;
        end = i;
      }
      if (end > 0) parts.unshift(buf.subarray(0, end));
    }
    if (floor === 0 && parts.length) return customTitleOf(Buffer.concat(parts));
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } } }
}

// The exit title, from the session's final name. Candidates in order: the transcript's name, then the
// registry's. Each passes through the one session-name sanitizer; one that sanitises to empty falls
// through to the next. The launch's markers are then applied: the prefix is prepended (with a space)
// unless the name already starts with it, the suffix appended unless the name already ends with it.
// `renamed` is true only when the result differs from the launch title; otherwise — and when no
// candidate survives — `title` is the launch title itself.
export function composeExitTitle({ transcriptName = null, registryName = null, launchTitle = '', prefix = '', suffix = '' } = {}) {
  for (const candidate of [transcriptName, registryName]) {
    let name = sanitizeSessionName(candidate);
    if (!name) continue;
    if (prefix && !name.startsWith(prefix)) name = `${prefix} ${name}`;
    if (suffix && !name.endsWith(suffix)) name = `${name} ${suffix}`;
    return name === launchTitle ? { title: launchTitle, renamed: false } : { title: name, renamed: true };
  }
  return { title: launchTitle, renamed: false };
}

// The hand-off file between a launch and the shell's `--print-title` call. Keyed by the SHELL's
// process id: both calls are direct children of the same shell, so each passes its own ppid.
export function exitTitlePath(ppid, dir = tmpdir()) {
  return join(dir, `cc-exit-title-${ppid}.json`);
}

// Write the file for a renamed session. `writtenAt` is epoch milliseconds. Never throws; true when
// the file was written.
export function writeExitTitleFile(ppid, { title, cwd, configDir = null, titlePrefix = '', titleSuffix = '', writtenAt = Date.now() }, dir = tmpdir()) {
  try {
    writeFileSync(exitTitlePath(ppid, dir), JSON.stringify({ title, cwd, configDir, titlePrefix, titleSuffix, writtenAt }));
    return true;
  } catch { return false; }
}

// Delete the file, if any. Never throws.
export function deleteExitTitleFile(ppid, dir = tmpdir()) {
  try { rmSync(exitTitlePath(ppid, dir), { force: true }); } catch { /* best effort */ }
}

// Read the file and DELETE it, whatever it says. Its title is returned only when `cwd` (compared
// case-insensitively on Windows), `configDir`, `titlePrefix` and `titleSuffix` all equal the caller's
// and `writtenAt` is at most 60 s old; every other case — missing, malformed, mismatched, stale — is
// null, and the caller recomputes the title.
export function readExitTitleFile(ppid, { cwd, configDir = null, titlePrefix = '', titleSuffix = '', now = Date.now() } = {}, dir = tmpdir()) {
  const p = exitTitlePath(ppid, dir);
  let v;
  try { v = JSON.parse(readFileSync(p, 'utf8')); } catch { v = null; }
  deleteExitTitleFile(ppid, dir);
  if (!isObject(v) || typeof v.title !== 'string' || !v.title) return null;
  const fold = (s) => (process.platform === 'win32' && typeof s === 'string' ? s.toLowerCase() : s);
  if (typeof v.cwd !== 'string' || fold(v.cwd) !== fold(cwd)) return null;
  if ((v.configDir ?? null) !== (configDir ?? null)) return null;
  if (v.titlePrefix !== titlePrefix || v.titleSuffix !== titleSuffix) return null;
  if (typeof v.writtenAt !== 'number' || !Number.isFinite(v.writtenAt) || now - v.writtenAt > 60000) return null;
  return v.title;
}

function isMain() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const run = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === run.toLowerCase() : self === run;
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--topic');
  const topic = i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1].trim() : '';
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const title = sessionTitle(dir, {
    topic,
    prefix: process.env.CC_TITLE_PREFIX || '',
    suffix: process.env.CC_TITLE_SUFFIX || '',
  });
  process.stdout.write(`/rename ${title}\n`);
}
