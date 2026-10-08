import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, utimesSync, appendFileSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// session-title (rows ST1–ST11) — the shared title module, home/session-title.mjs: the one place a
// session's title is computed (identity read, base name, branch, title). Its function names are the
// implementer's choice, so every row drives the module through its binding surface, the command line:
//   node session-title.mjs [--topic <slug>]   →   one line, `/rename <title>`
// with the directory taken from CLAUDE_PROJECT_DIR, else the current directory, and the title markers
// from CC_TITLE_PREFIX / CC_TITLE_SUFFIX. The launcher's agreement with it is pinned in
// launcher-vscode.test.mjs (rows LT1, LT2).
//
// This file ships with the module in the public kit, so it is generic: the markers are the neutral
// [P] / [S], and no row names a private caller.
//
// Hermetic by construction: every fixture is a throwaway folder under one temp root; every spawn gets
// GIT_CONFIG_NOSYSTEM=1, a temp HOME/USERPROFILE (so no machine git config leaks in) and
// GIT_CEILING_DIRECTORIES at the temp root (so git never discovers a repository above it); the
// inherited CC_TITLE_PREFIX / CC_TITLE_SUFFIX / CLAUDE_PROJECT_DIR are deleted unless a row sets them,
// so the suite gives the same answer inside a marked session as in a plain shell.

const here = dirname(fileURLToPath(import.meta.url));
const MODULE = join(here, '..', 'home', 'session-title.mjs');
const LAUNCHER = join(here, '..', 'home', 'claude-launch.mjs');

const ROOT = mkdtempSync(join(tmpdir(), 'st-root-'));
const FAKE_HOME = join(ROOT, '_home');
mkdirSync(FAKE_HOME, { recursive: true });
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch {} });

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CC_TITLE_PREFIX|CC_TITLE_SUFFIX|CLAUDE_PROJECT_DIR|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_CEILING_DIRECTORIES|GIT_TRACE)$/i.test(k)) delete env[k];
  }
  const out = { ...env, GIT_CONFIG_NOSYSTEM: '1', HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, GIT_CEILING_DIRECTORIES: ROOT };
  // Environment names are case-insensitive on Windows (process.env carries `Path` there), so an
  // override replaces every casing of its name rather than sitting beside it.
  for (const k of Object.keys(extra)) {
    for (const o of Object.keys(out)) if (o !== k && o.toUpperCase() === k.toUpperCase()) delete out[o];
    out[k] = extra[k];
  }
  return out;
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=qa', '-c', 'user.email=qa@x', ...args], { cwd, env: baseEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

let seq = 0;
function freshDir(leaf) {
  const d = join(ROOT, `${String(++seq).padStart(2, '0')}`, leaf);
  mkdirSync(d, { recursive: true });
  return d;
}

// A repo on `branch` with one commit (commit: false leaves it unborn).
function makeRepo(leaf, { branch = 'main', commit = true, origin = null } = {}) {
  const d = freshDir(leaf);
  git(d, 'init', '-q', '-b', branch);
  if (origin) git(d, 'remote', 'add', 'origin', origin);
  if (commit) {
    writeFileSync(join(d, 'f.txt'), 'x\n', 'utf8');
    git(d, 'add', 'f.txt');
    git(d, 'commit', '-q', '-m', 'init');
  }
  return d;
}

function writeIdentity(dir, sub, raw) {
  mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, sub, 'session-identity.json'), typeof raw === 'string' ? raw : JSON.stringify(raw), 'utf8');
}

// Runs the module's command-line entry. `cwd` is the working directory; `env` adds variables.
function cli(cwd, { args = [], env = {} } = {}) {
  const r = spawnSync(process.execPath, [MODULE, ...args], { cwd, env: baseEnv(env), encoding: 'utf8' });
  return r;
}

// The one line the CLI prints, asserting the contract (exit 0, nothing on stderr, exactly one line).
function line(cwd, opts) {
  assert.ok(existsSync(MODULE), 'home/session-title.mjs exists (the shared title module)');
  const r = cli(cwd, opts);
  assert.equal(r.status, 0, `session-title.mjs exited ${r.status}: ${r.stderr}`);
  assert.equal(r.stderr, '', 'the command-line entry writes nothing to stderr');
  assert.ok(r.stdout.endsWith('\n') && r.stdout.indexOf('\n') === r.stdout.length - 1,
    `exactly one line plus a newline, got ${JSON.stringify(r.stdout)}`);
  return r.stdout.slice(0, -1);
}

const leafOf = (p) => p.split(/[\\/]/).filter(Boolean).pop();

// ── ST1 — no repository ──────────────────────────────────────────────────────────────────────────
test('ST1 — no repo, no identity: the title is the folder leaf; --topic appends `: <topic>`', () => {
  // Red if: the folder-leaf tier is dropped, or the topic is composed with another separator.
  const d = freshDir('plainfolder');
  assert.equal(line(d), '/rename plainfolder');
  assert.equal(line(d, { args: ['--topic', 'x'] }), '/rename plainfolder: x');
});

// ── ST2 — a named repo on main ───────────────────────────────────────────────────────────────────
test('ST2 — repo on main, identity name `env`: `env@main`; markers wrap it with single spaces', () => {
  // Red if: the branch is dropped, `@main` is special-cased away (there is no default-branch
  // exception), or a marker is dropped or joined without a space.
  const d = makeRepo('named');
  writeIdentity(d, '.desk', { name: 'env' });
  assert.equal(line(d), '/rename env@main');
  assert.equal(line(d, { env: { CC_TITLE_PREFIX: '[P]', CC_TITLE_SUFFIX: '[S]' } }), '/rename [P] env@main [S]');
  assert.equal(line(d, { args: ['--topic', 'foo'], env: { CC_TITLE_PREFIX: '[P]', CC_TITLE_SUFFIX: '[S]' } }),
    '/rename [P] env@main: foo [S]', 'the topic joins the core, inside the markers');
});

// ── ST3 — the base-name chain ────────────────────────────────────────────────────────────────────
test('ST3 — the base chain: origin slug (https and scp forms), trailing-slash origin and no origin fall to the top-level leaf, from a subfolder too', () => {
  // Red if: any tier is reordered, `.git` is not stripped, the scp `host:a/proj` form is not split on
  // `:`/`/`, the trailing-slash origin produces an empty base, or a subfolder's own leaf is used.
  const https = makeRepo('top-https', { origin: 'https://x/y/proj.git' });
  assert.equal(line(https), '/rename proj@main');
  const scp = makeRepo('top-scp', { origin: 'git@host:a/proj' });
  assert.equal(line(scp), '/rename proj@main');
  const slash = makeRepo('top-slash', { origin: 'https://x/y/proj/' });
  assert.equal(line(slash), '/rename top-slash@main', 'no slug match: falls through to the top-level leaf, as the launcher does today');
  const none = makeRepo('top-none');
  assert.equal(line(none), '/rename top-none@main');
  const sub = join(none, 'deeper', 'sub');
  mkdirSync(sub, { recursive: true });
  assert.equal(line(sub), '/rename top-none@main', 'run from a subfolder: the top-level leaf, not the subfolder');
});

// ── ST4 — detached HEAD ──────────────────────────────────────────────────────────────────────────
test('ST4 — detached HEAD: `<base>@<short sha>`', () => {
  // Red if: the short-HEAD fallback is dropped (title would lose its @ part) or the full sha is used.
  const d = makeRepo('detached');
  git(d, 'checkout', '-q', '--detach');
  const short = git(d, 'rev-parse', '--short', 'HEAD');
  const out = line(d);
  assert.match(out, /^\/rename detached@[0-9a-f]{7,}$/);
  assert.equal(out, `/rename detached@${short}`);
});

// ── ST5 — unborn branch ──────────────────────────────────────────────────────────────────────────
test('ST5 — a repo with no commits: the unborn branch name', () => {
  // Red if: the branch read requires a commit (rev-parse first), so a fresh repo shows no branch.
  const d = makeRepo('unborn', { branch: 'trunk', commit: false });
  assert.equal(line(d), '/rename unborn@trunk');
});

// ── ST6 — a git worktree ─────────────────────────────────────────────────────────────────────────
test('ST6 — a worktree on branch feat: its own branch; base the origin slug, else the worktree folder leaf', () => {
  // Red if: the branch comes from the main checkout, or the base uses the main checkout's folder.
  const withRemote = makeRepo('wt-main-r', { origin: 'https://x/y/proj.git' });
  const wtR = join(dirname(withRemote), 'wt-feat-r');
  git(withRemote, 'worktree', 'add', '-q', '-b', 'feat', wtR);
  assert.equal(line(wtR), '/rename proj@feat');

  const noRemote = makeRepo('wt-main');
  const wt = join(dirname(noRemote), 'wt-feat');
  git(noRemote, 'worktree', 'add', '-q', '-b', 'feat', wt);
  assert.equal(line(wt), '/rename wt-feat@feat');
});

// ── ST7 — the identity read ──────────────────────────────────────────────────────────────────────
test('ST7 — identity read: a valid .desk object wins; a bare value, an array, null or broken JSON falls back to .claude; {} and a blank name use the chain', () => {
  // Red if: the read tests truthiness or `?? ` instead of "is a JSON object" (a bare value would then
  // hide the legacy file), or it counts properties (so `{}` would fall through), or a blank name wins.
  const fresh = (leaf) => freshDir(leaf);
  {
    const d = fresh('both-valid');
    writeIdentity(d, '.desk', { name: 'deskname' });
    writeIdentity(d, '.claude', { name: 'legacyname' });
    assert.equal(line(d), '/rename deskname');
  }
  for (const [label, raw] of [['a bare string', '"hello"'], ['a number', '42'], ['an array', '[1,2]'], ['null', 'null'], ['broken JSON', '{not json']]) {
    const d = fresh('fallback');
    writeIdentity(d, '.desk', raw);
    writeIdentity(d, '.claude', { name: 'legacyname' });
    assert.equal(line(d), '/rename legacyname', `.desk holding ${label}: the .claude identity is used`);
  }
  {
    const d = fresh('legacy-only');
    writeIdentity(d, '.claude', { name: 'legacyname' });
    assert.equal(line(d), '/rename legacyname', 'only the legacy file: it is the identity');
  }
  {
    const d = fresh('empty-object');
    writeIdentity(d, '.desk', {});
    writeIdentity(d, '.claude', { name: 'legacyname' });
    assert.equal(line(d), '/rename empty-object', '.desk `{}` is an identity with no name: the chain applies, not the legacy file');
  }
  for (const blank of ['', '   ']) {
    const d = fresh('blank-name');
    writeIdentity(d, '.desk', { name: blank });
    assert.equal(line(d), '/rename blank-name', `name ${JSON.stringify(blank)}: the chain`);
  }
  {
    const d = fresh('padded');
    writeIdentity(d, '.desk', { name: '  spaced  ' });
    assert.equal(line(d), '/rename spaced', 'the name is trimmed');
  }
});

// ── ST8 — markers ────────────────────────────────────────────────────────────────────────────────
test('ST8 — markers: empty and unset are dropped; a whitespace marker is kept, as the launcher composes today', () => {
  // Red if: an empty marker leaves a stray space, or the module trims markers differently from the
  // launcher's `[prefix, core, suffix].filter(Boolean).join(' ')` (the pre-change composition).
  const d = freshDir('markers');
  assert.equal(line(d), '/rename markers', 'unset');
  assert.equal(line(d, { env: { CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '' } }), '/rename markers', 'empty strings');
  assert.equal(line(d, { env: { CC_TITLE_PREFIX: '[P]' } }), '/rename [P] markers', 'prefix only');
  assert.equal(line(d, { env: { CC_TITLE_SUFFIX: '[S]' } }), '/rename markers [S]', 'suffix only');
  const today = [' ', 'markers', ''].filter(Boolean).join(' ');
  assert.equal(line(d, { env: { CC_TITLE_PREFIX: ' ' } }), `/rename ${today}`, 'a single-space marker is not empty, so it is kept');
});

// ── ST9 — git missing ────────────────────────────────────────────────────────────────────────────
test('ST9 — git not on PATH: the identity name or the folder leaf, no branch, no throw, no stderr', (t) => {
  // Red if: a missing git throws, writes stderr, or the module shells out through a shell that fails.
  const d = makeRepo('nogit-repo', { origin: 'https://x/y/proj.git' });
  const env = baseEnv({ PATH: dirname(process.execPath) });
  const probe = spawnSync('git', ['--version'], { env, encoding: 'utf8' });
  if (probe.status === 0) { t.skip('git lives beside node on this machine, so the row cannot take it off PATH'); return; }
  const run = (cwd) => {
    const r = spawnSync(process.execPath, [MODULE], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.equal(r.stderr, '', 'no stderr when git is missing');
    return r.stdout;
  };
  assert.ok(existsSync(MODULE), 'home/session-title.mjs exists');
  assert.equal(run(d), '/rename nogit-repo\n', 'no git: no origin slug, no branch — the folder leaf');
  writeIdentity(d, '.desk', { name: 'idn' });
  assert.equal(run(d), '/rename idn\n', 'no git: the identity name, no branch');
});

// ── ST10 — the command-line entry ────────────────────────────────────────────────────────────────
test('ST10 — CLI: a spaced topic, CLAUDE_PROJECT_DIR over the cwd, a missing or blank --topic means no topic', () => {
  // Red if: the topic is split on whitespace, the cwd outranks CLAUDE_PROJECT_DIR, or a bare --topic
  // composes `name: ` with an empty topic.
  const proj = makeRepo('projdir');
  writeIdentity(proj, '.desk', { name: 'pd' });
  const other = freshDir('elsewhere');
  assert.equal(line(proj, { args: ['--topic', 'a b'] }), '/rename pd@main: a b');
  assert.equal(line(other, { env: { CLAUDE_PROJECT_DIR: proj } }), '/rename pd@main', 'CLAUDE_PROJECT_DIR outranks the cwd');
  assert.equal(line(other), '/rename elsewhere', 'without it, the cwd');
  assert.equal(line(proj, { args: ['--topic'] }), '/rename pd@main', '--topic with no value: no topic');
  assert.equal(line(proj, { args: ['--topic', ''] }), '/rename pd@main', 'an empty topic: no topic');
  assert.equal(line(proj, { args: ['--topic', '   '] }), '/rename pd@main', 'a blank topic: no topic');
});

// ── ST11 — source invariants (the public half) ───────────────────────────────────────────────────
test('ST11 — the module imports only node: built-ins and its one sibling ./sanitize-name.mjs, and the launcher restates none of the four rules', () => {
  // Red if: the module gains a dependency, or the launcher keeps its own git calls or identity path
  // (the four rules must live only in the module).
  assert.ok(existsSync(MODULE), 'home/session-title.mjs exists');
  const mod = readFileSync(MODULE, 'utf8');
  const specifiers = [
    ...mod.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm),
    ...mod.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ...mod.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  assert.ok(specifiers.length >= 1, 'the module\'s imports were found');
  // Re-pinned 2026-10-08 (title/log/Chrome sprint, item 1, spec step 7): the exit-title composer runs every
  // name through sanitizeSessionName, the one session-name sanitizer, which ships beside the module in the kit.
  for (const s of specifiers) assert.ok(s.startsWith('node:') || s === './sanitize-name.mjs', `the module imports ${s} — only node: built-ins and ./sanitize-name.mjs are allowed`);

  const launcher = readFileSync(LAUNCHER, 'utf8');
  for (const needle of ['remote.origin.url', '--show-toplevel', '--show-current']) {
    assert.ok(!launcher.includes(needle), `home/claude-launch.mjs still contains ${needle} — the module owns the git calls`);
  }
  assert.ok(!/['"`][^'"`\n]*session-identity\.json/.test(launcher),
    'home/claude-launch.mjs still carries an identity-file path literal — the module owns the identity read');
  assert.match(launcher, /from\s+['"]\.\/session-title\.mjs['"]/, 'not vacuous: the launcher imports the module');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// XT1–XT9 — the exit title (title/log/Chrome sprint, item 1)
// Spec:      docs/261008-title-log-chrome-sprint-spec.md item 1 (frozen at [G1], f47e3c0)
// Test plan: docs/261008-title-log-chrome-sprint-test-plan.md §3.1
// Binds the module's exports by import (spec step 7): readRegistryEntry, findTranscript,
// lastCustomTitle (+ TRANSCRIPT_WINDOW_BYTES), composeExitTitle, exitTitlePath, writeExitTitleFile,
// readExitTitleFile. Markers are the neutral [P] / [S]: this file ships in the public kit.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

const ST = await import(pathToFileURL(MODULE).href);
const IS_WIN32 = process.platform === 'win32';

function cfgHome() { return freshDir('cfg'); }
function regEntry(cfg, pid, body) {
  mkdirSync(join(cfg, 'sessions'), { recursive: true });
  writeFileSync(join(cfg, 'sessions', `${pid}.json`), typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
}
function transcript(cfg, folder, sid, lines, { eol = '\n', trailing = true } = {}) {
  const d = join(cfg, 'projects', folder);
  mkdirSync(d, { recursive: true });
  const p = join(d, `${sid}.jsonl`);
  const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join(eol) + (trailing ? eol : '');
  writeFileSync(p, body, 'utf8');
  return p;
}
const ct = (name, sid = 'sid-1') => ({ type: 'custom-title', customTitle: name, sessionId: sid });
const userLine = (i = 0) => ({ type: 'user', message: { role: 'user', content: `hello ${i}` }, sessionId: 'sid-1' });

test('XT1 — registry reader: a valid user-named entry yields its id and name; every damaged form yields nothing', () => {
  // Red if: the pid check or the sessionId pattern is dropped.
  const cfg = cfgHome();
  regEntry(cfg, 4242, { pid: 4242, sessionId: 'abc-123_x.y', cwd: 'C:\\w', name: 'beta', nameSource: 'user', kind: 'interactive' });
  assert.deepEqual(ST.readRegistryEntry(cfg, 4242), { sessionId: 'abc-123_x.y', name: 'beta' });
  regEntry(cfg, 4243, { pid: 4243, sessionId: 'auto-1', name: 'ai title', nameSource: 'auto' });
  assert.deepEqual(ST.readRegistryEntry(cfg, 4243), { sessionId: 'auto-1', name: '' }, 'nameSource other than "user": the id, no name');
  regEntry(cfg, 4244, { pid: 9999, sessionId: 'x', name: 'n', nameSource: 'user' });
  assert.equal(ST.readRegistryEntry(cfg, 4244), null, 'a wrong pid inside the file');
  regEntry(cfg, 4245, '{"pid":12');
  assert.equal(ST.readRegistryEntry(cfg, 4245), null, 'half-written');
  for (const [pid, body] of [[4246, '[]'], [4247, '"x"'], [4248, '42'], [4249, 'null']]) {
    regEntry(cfg, pid, body);
    assert.equal(ST.readRegistryEntry(cfg, pid), null, `non-object ${body}`);
  }
  assert.equal(ST.readRegistryEntry(cfg, 5555), null, 'missing file');
  mkdirSync(join(cfg, 'sessions', '5556.json'), { recursive: true });
  assert.equal(ST.readRegistryEntry(cfg, 5556), null, 'a directory in the file\'s place');
  for (const [pid, sid] of [[4250, '..\\x'], [4251, 'a/b'], [4252, ''], [4253, 42], [4254, '..']]) {
    regEntry(cfg, pid, { pid, sessionId: sid, name: 'n', nameSource: 'user' });
    const r = ST.readRegistryEntry(cfg, pid);
    if (sid === '..') {
      // `..` matches the path-safety pattern; it is safe only because the finder joins it with `.jsonl`.
      assert.ok(r === null || r.sessionId === '..', 'a dotted id is either refused or passed whole');
    } else {
      assert.equal(r, null, `hostile sessionId ${JSON.stringify(sid)}`);
    }
  }
});

test('XT2 — transcript finder: any project folder, the newest of two, a hostile id never opens a file', () => {
  // Red if: the sid reaches join() unchecked, or the first folder found wins over the newest.
  const cfg = cfgHome();
  const p = transcript(cfg, 'C--unrelated-folder', 'sid-a', [ct('x', 'sid-a')]);
  assert.equal(ST.findTranscript(cfg, 'sid-a'), p, 'found in whichever projects/* folder holds it');
  assert.equal(ST.findTranscript(cfg, 'sid-none'), null, 'absent → nothing');
  assert.equal(ST.findTranscript(freshDir('empty-cfg'), 'sid-a'), null, 'no projects folder → nothing');
  const older = transcript(cfg, 'A-first', 'sid-two', [ct('old', 'sid-two')]);
  const newer = transcript(cfg, 'Z-second', 'sid-two', [ct('new', 'sid-two')]);
  const t0 = Date.now() / 1000;
  utimesSync(older, t0 - 100, t0 - 100);
  utimesSync(newer, t0 - 10, t0 - 10);
  assert.equal(ST.findTranscript(cfg, 'sid-two'), newer, 'two folders → the most recently modified');
  utimesSync(older, t0, t0);
  assert.equal(ST.findTranscript(cfg, 'sid-two'), older, 'and the order follows the mtime, not the folder name');
  // A real file one level above projects/*, reachable only through `..`.
  writeFileSync(join(cfg, 'secret.jsonl'), JSON.stringify(ct('SECRET')) + '\n');
  writeFileSync(join(cfg, 'projects', 'secret.jsonl'), JSON.stringify(ct('SECRET')) + '\n');
  for (const sid of ['..\\..\\secret', '../secret', '..\\secret', 'a/b', '']) {
    assert.equal(ST.findTranscript(cfg, sid), null, `hostile sid ${JSON.stringify(sid)} → nothing`);
  }
});

test('XT3 — last custom title: the last valid line wins; agent-name, malformed and numeric titles skipped; LF, CRLF and no trailing newline agree', () => {
  // Red if: the first match wins, or a malformed line stops the read.
  const cfg = cfgHome();
  const lines = [
    userLine(1), ct('first'), userLine(2), ct('second'),
    { type: 'agent-name', agentName: 'NOT-ME', sessionId: 'sid-1' },
    { type: 'custom-title', customTitle: 42, sessionId: 'sid-1' },
    '{"type":"custom-title","customTitle":"broken',
    userLine(3),
  ];
  for (const [label, opts] of [['LF', {}], ['CRLF', { eol: '\r\n' }], ['no trailing newline', { trailing: false }], ['CRLF no trailing', { eol: '\r\n', trailing: false }]]) {
    const p = transcript(cfg, `p-${label.replace(/\s/g, '')}`, 'sid-1', lines, opts);
    assert.equal(ST.lastCustomTitle(p), 'second', `${label}: the last valid custom-title wins`);
  }
  const onlyLast = transcript(cfg, 'last-line', 'sid-1', [userLine(), ct('a'), ct('z')], { trailing: false });
  assert.equal(ST.lastCustomTitle(onlyLast), 'z', 'a title on the final, unterminated line is read');
  const none = transcript(cfg, 'none', 'sid-1', [userLine(), { type: 'agent-name', agentName: 'x' }]);
  assert.equal(ST.lastCustomTitle(none), null, 'no custom-title → nothing');
  assert.equal(ST.lastCustomTitle(join(cfg, 'missing.jsonl')), null, 'missing file → nothing');
  const empty = join(cfg, 'empty.jsonl'); writeFileSync(empty, '');
  assert.equal(ST.lastCustomTitle(empty), null, 'empty file → nothing');
});

test('XT4 — the 16 MiB window: a 17 MiB transcript with its only title in the first MiB → nothing; 1 MiB from the end → found; within 2 s', () => {
  // Red if: the whole file is read, or the window is smaller than 16 MiB.
  assert.equal(ST.TRANSCRIPT_WINDOW_BYTES, 16 * 1024 * 1024, 'the window is 16 MiB');
  const cfg = cfgHome();
  const pad = JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) }) + '\n';
  const MiB = 1024 * 1024;
  const padOf = (bytes) => pad.repeat(Math.ceil(bytes / pad.length));
  const early = join(cfg, 'early.jsonl');
  writeFileSync(early, padOf(0.5 * MiB) + JSON.stringify(ct('EARLY')) + '\n' + padOf(16.5 * MiB));
  const late = join(cfg, 'late.jsonl');
  writeFileSync(late, padOf(16 * MiB) + JSON.stringify(ct('LATE')) + '\n' + padOf(1 * MiB));
  let t = Date.now();
  assert.equal(ST.lastCustomTitle(early), null, 'a title older than the last 16 MiB is not read');
  assert.ok(Date.now() - t < 2000, `the windowed miss returns within 2 s (took ${Date.now() - t} ms)`);
  t = Date.now();
  assert.equal(ST.lastCustomTitle(late), 'LATE', 'a title 1 MiB from the end is found');
  assert.ok(Date.now() - t < 2000, `and within 2 s (took ${Date.now() - t} ms)`);
  // 15 MiB from the end is inside the window too, so the window is not smaller than 16 MiB.
  const deep = join(cfg, 'deep.jsonl');
  writeFileSync(deep, padOf(1 * MiB) + JSON.stringify(ct('DEEP')) + '\n' + padOf(15 * MiB));
  assert.equal(ST.lastCustomTitle(deep), 'DEEP', 'a title 15 MiB from the end is inside the window');
});

test('XT5 — read boundaries: a name with an emoji and Romanian letters comes back whole wherever a 4 KiB or 64 KiB boundary falls inside its line', () => {
  // Red if: a chunk boundary splits a line or a code point.
  const cfg = cfgHome();
  const NAME = 'șantier 🧭 Țară ăîâ — nume';
  const line = Buffer.from(JSON.stringify(ct(NAME)) + '\n', 'utf8');
  const head = Buffer.from(JSON.stringify(userLine()) + '\n', 'utf8');
  const failures = [];
  for (const block of [4096, 65536]) {
    for (let o = 1; o < line.length; o++) {
      // Bytes after the title line, so that a read boundary `block` bytes from the end falls `o` bytes
      // into the line (counted from the line's end).
      const tailLen = block - o;
      const tail = Buffer.from('{"type":"assistant","p":"' + 'y'.repeat(Math.max(0, tailLen - 28)) + '"}\n', 'utf8').subarray(0, tailLen);
      const fixed = Buffer.concat([tail.subarray(0, Math.max(0, tail.length - 1)), Buffer.from('\n')]);
      const p = join(cfg, `b-${block}-${o}.jsonl`);
      writeFileSync(p, Buffer.concat([head, line, fixed]));
      const got = ST.lastCustomTitle(p);
      if (got !== NAME) failures.push(`block ${block}, offset ${o}: ${JSON.stringify(got)}`);
      rmSync(p);
    }
  }
  assert.deepEqual(failures.slice(0, 5), [], `${failures.length} placements returned a broken name`);
});

test('XT6 — the exit-title rule over the matrix: transcript beats registry; markers added once, never doubled; no candidate → the launch title', () => {
  // Red if: a marker is doubled or dropped, or the order of sources is swapped.
  const LAUNCH_BY = { '': 'proj@main', P: '[P] proj@main', S: 'proj@main [S]', PS: '[P] proj@main [S]' };
  for (const prefix of ['', '[P]']) {
    for (const suffix of ['', '[S]']) {
      const launchTitle = LAUNCH_BY[(prefix ? 'P' : '') + (suffix ? 'S' : '')];
      const exp = (n) => {
        let s = n;
        if (prefix && !s.startsWith(prefix)) s = `${prefix} ${s}`;
        if (suffix && !s.endsWith(suffix)) s = `${s} ${suffix}`;
        return s;
      };
      for (const nameShape of ['bare', 'with-prefix', 'with-suffix', 'with-both']) {
        const base = 'beta';
        const name = { bare: base, 'with-prefix': `${prefix || '[P]'} ${base}`, 'with-suffix': `${base} ${suffix || '[S]'}`, 'with-both': `${prefix || '[P]'} ${base} ${suffix || '[S]'}` }[nameShape];
        const want = exp(name);
        const both = ST.composeExitTitle({ transcriptName: name, registryName: 'REGISTRY', launchTitle, prefix, suffix });
        assert.deepEqual(both, { title: want, renamed: true }, `prefix=${prefix} suffix=${suffix} ${nameShape}: transcript wins`);
        const regOnly = ST.composeExitTitle({ transcriptName: null, registryName: name, launchTitle, prefix, suffix });
        assert.deepEqual(regOnly, { title: want, renamed: true }, `prefix=${prefix} suffix=${suffix} ${nameShape}: registry when no transcript name`);
        if (prefix) assert.equal(want.split(prefix).length - 1, 1, 'the prefix appears once');
        if (suffix) assert.equal(want.split(suffix).length - 1, 1, 'the suffix appears once');
      }
      const none = ST.composeExitTitle({ transcriptName: null, registryName: null, launchTitle, prefix, suffix });
      assert.deepEqual(none, { title: launchTitle, renamed: false }, `prefix=${prefix} suffix=${suffix}: no candidate → the launch title, byte-equal`);
      const emptyReg = ST.composeExitTitle({ transcriptName: null, registryName: '', launchTitle, prefix, suffix });
      assert.deepEqual(emptyReg, { title: launchTitle, renamed: false }, 'an empty registry name (nameSource not "user") is no candidate');
      // A name that is the launch title once the markers are applied is NOT a rename (spec rule 2.5).
      const same = ST.composeExitTitle({ transcriptName: 'proj@main', registryName: null, launchTitle, prefix, suffix });
      assert.deepEqual(same, { title: launchTitle, renamed: false }, `prefix=${prefix} suffix=${suffix}: the launch name is not a rename`);
    }
  }
  // The nudge's line in the generic markers, and a hand rename (AE-1.2, AE-1.3 shapes).
  assert.deepEqual(ST.composeExitTitle({ transcriptName: '[P] proj@main: topic [S]', launchTitle: '[P] proj@main [S]', prefix: '[P]', suffix: '[S]' }),
    { title: '[P] proj@main: topic [S]', renamed: true });
  assert.deepEqual(ST.composeExitTitle({ transcriptName: 'notes', launchTitle: '[P] proj@main [S]', prefix: '[P]', suffix: '[S]' }),
    { title: '[P] notes [S]', renamed: true });
});

test('XT7 — sanitising: escapes-only falls through to the registry name; control bytes stripped; 100 code points → 80 ending in …', () => {
  // Red if: the composer skips sanitizeSessionName, or an empty result stops the fallthrough.
  const launchTitle = 'proj@main';
  assert.deepEqual(ST.composeExitTitle({ transcriptName: '\x1b[31m\x1b[0m\x07', registryName: 'from-registry', launchTitle }),
    { title: 'from-registry', renamed: true }, 'a transcript name that sanitises to empty falls through to the registry name (ruling 1.2)');
  assert.deepEqual(ST.composeExitTitle({ transcriptName: '\x1b[31m', registryName: '\x07\x1b[0m', launchTitle }),
    { title: launchTitle, renamed: false }, 'both empty after sanitising → the launch title');
  const r = ST.composeExitTitle({ transcriptName: 'be\x07ta \x1b[31mred\x1b[0m', launchTitle });
  assert.equal(r.title, 'beta red', 'BEL and a CSI sequence are stripped');
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(r.title));
  const long = 'ă'.repeat(60) + '🧭'.repeat(40);   // 100 code points, astral ones at the cut
  const c = ST.composeExitTitle({ transcriptName: long, launchTitle });
  const cps = Array.from(c.title);
  assert.equal(cps.length, 80, '80 code points');
  assert.equal(cps.at(-1), '…', 'ending in …');
  assert.equal(cps.slice(0, 79).join(''), Array.from(long).slice(0, 79).join(''), 'the first 79 code points kept, no surrogate split');
});

test('XT8 — the exit-title file: matching fields within 60 s round-trip; every mismatch returns nothing; the file is gone after every read', () => {
  // Red if: any field is not compared, or the file survives a read.
  const dir = freshDir('tmp');
  const ppid = 31337;
  const base = { title: '[P] beta [S]', cwd: join(ROOT, 'Proj'), configDir: join(ROOT, 'cfgX'), titlePrefix: '[P]', titleSuffix: '[S]' };
  const ask = { cwd: base.cwd, configDir: base.configDir, titlePrefix: '[P]', titleSuffix: '[S]' };
  const now = Date.now();
  const roundTrip = (fileFields, askFields) => {
    ST.writeExitTitleFile(ppid, { ...base, writtenAt: now, ...fileFields }, dir);
    assert.ok(existsSync(ST.exitTitlePath(ppid, dir)), 'the file was written');
    const got = ST.readExitTitleFile(ppid, { ...ask, now, ...askFields }, dir);
    assert.ok(!existsSync(ST.exitTitlePath(ppid, dir)), 'the file is gone after the read, whatever it decided');
    return got;
  };
  assert.equal(ST.exitTitlePath(ppid, dir), join(dir, `cc-exit-title-${ppid}.json`), 'the file is keyed by the shell pid');
  assert.equal(roundTrip({}, {}), '[P] beta [S]', 'matching and fresh → its title');
  const written = JSON.parse((() => { ST.writeExitTitleFile(ppid, { ...base, writtenAt: now }, dir); const s = readFileSync(ST.exitTitlePath(ppid, dir), 'utf8'); rmSync(ST.exitTitlePath(ppid, dir)); return s; })());
  assert.deepEqual(Object.keys(written).sort(), ['configDir', 'cwd', 'title', 'titlePrefix', 'titleSuffix', 'writtenAt'].sort(), 'the spec\'s six fields');
  assert.equal(typeof written.writtenAt, 'number', 'writtenAt is epoch milliseconds, a number (ruling 1.3)');
  const caseOnly = roundTrip({ cwd: base.cwd.toUpperCase() }, {});
  if (IS_WIN32) assert.equal(caseOnly, '[P] beta [S]', 'Windows: a case-only cwd difference still matches');
  else assert.equal(caseOnly, null, 'elsewhere a case-only cwd difference does not match');
  assert.equal(roundTrip({ cwd: join(ROOT, 'Other') }, {}), null, 'cwd differing');
  assert.equal(roundTrip({ configDir: join(ROOT, 'cfgY') }, {}), null, 'configDir differing');
  assert.equal(roundTrip({ configDir: null }, {}), null, 'configDir absent on one side');
  assert.equal(roundTrip({ titlePrefix: '[Q]' }, {}), null, 'titlePrefix differing');
  assert.equal(roundTrip({ titleSuffix: '' }, {}), null, 'titleSuffix differing');
  assert.equal(roundTrip({ writtenAt: now - 61000 }, {}), null, '61 s old');
  assert.equal(roundTrip({ writtenAt: now - 60000 }, {}), '[P] beta [S]', '60 s old is accepted (the boundary)');
  writeFileSync(ST.exitTitlePath(ppid, dir), '{"title": "x", ');
  assert.equal(ST.readExitTitleFile(ppid, ask, dir), null, 'malformed JSON');
  assert.ok(!existsSync(ST.exitTitlePath(ppid, dir)), 'a malformed file is deleted too');
  assert.equal(ST.readExitTitleFile(ppid, ask, dir), null, 'missing file');
});

test('XT9 — source: the module imports only node: built-ins and ./sanitize-name.mjs; the launcher re-implements no transcript or registry logic', () => {
  // Red if: transcript logic is re-implemented in the launcher (spec step 7: the helpers live in the module).
  const mod = readFileSync(MODULE, 'utf8');
  const specs = [...mod.matchAll(/^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(specs.includes('./sanitize-name.mjs'), 'the module imports the one session-name sanitizer');
  for (const s of specs) assert.ok(s.startsWith('node:') || s === './sanitize-name.mjs', `unexpected import ${s}`);
  const launcher = readFileSync(LAUNCHER, 'utf8');
  assert.ok(!launcher.includes('custom-title'), 'the launcher carries no custom-title literal');
  assert.ok(!launcher.includes('.jsonl'), 'the launcher carries no .jsonl literal');
  assert.ok(!/['"`]sessions['"`]/.test(launcher), 'the launcher composes no sessions/ path of its own');
  for (const fn of ['readRegistryEntry', 'findTranscript', 'lastCustomTitle', 'composeExitTitle', 'writeExitTitleFile', 'readExitTitleFile']) {
    assert.match(launcher, new RegExp(`\\b${fn}\\b`), `the launcher uses the module's ${fn}`);
  }
});