import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
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
test('ST11 — the module imports only node: built-ins, and the launcher restates none of the four rules', () => {
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
  for (const s of specifiers) assert.ok(s.startsWith('node:'), `the module imports ${s} — only node: built-ins are allowed`);

  const launcher = readFileSync(LAUNCHER, 'utf8');
  for (const needle of ['remote.origin.url', '--show-toplevel', '--show-current']) {
    assert.ok(!launcher.includes(needle), `home/claude-launch.mjs still contains ${needle} — the module owns the git calls`);
  }
  assert.ok(!/['"`][^'"`\n]*session-identity\.json/.test(launcher),
    'home/claude-launch.mjs still carries an identity-file path literal — the module owns the identity read');
  assert.match(launcher, /from\s+['"]\.\/session-title\.mjs['"]/, 'not vacuous: the launcher imports the module');
});
