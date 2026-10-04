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
// Zero dependencies beyond node: built-ins.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
