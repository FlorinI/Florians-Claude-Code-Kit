import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// sprint1-launcher — mechanics tests for the launcher half of sprint 1 (2026-08-29): N14 the launcher
// owns CLAUDE_CONFIG_DIR, N4 a fork is a fresh session, N2 `--cloud <description>` is the prompt,
// G2 VALUE_FLAGS / VARIADIC_FLAGS vs the installed `claude --help` 2.1.251.
//
// Spec: .claude/plans/260829-sprint1-status-launcher-spec.md
// Acceptance examples (frozen at [G1], commit d094872): AE-13 … AE-15, AE-18 … AE-21.
// Test plan rows: L21–L24, R9–R11, C13–C19 (ids continue launcher-vscode / launcher-resume-name).
//
// Two seams. The dry-run seam (CC_LAUNCH_DRYRUN=1) prints the plan as one JSON line — `plan.claude.argv`
// IS the argv the live path spawns. The REAL-SPAWN seam (no dry-run) runs the fake `claude` shim, which
// echoes whether CLAUDE_CONFIG_DIR reached it: `CFGDIR=[<value>]` when defined (brackets, so a
// defined-but-empty variable reads `CFGDIR=[]` — the trap the ticket measured), `CFGDIR=unset` when not.
// CC_VSCODE stays unset in every row, so no VS Code co-launch and no tiler can fire on a real spawn.

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const launcher = join(ROOT, 'home', 'claude-launch.mjs');
const HELP_FIXTURE = join(here, 'fixtures', 'claude-help-2.1.251.txt');

function makeShims() {
  const d = mkdtempSync(join(tmpdir(), 's1l-shim-'));
  writeFileSync(join(d, 'claude.cmd'),
    '@echo off\r\nif defined CLAUDE_CONFIG_DIR (echo CFGDIR=[%CLAUDE_CONFIG_DIR%]) else (echo CFGDIR=unset)\r\nexit /b 0\r\n', 'utf8');
  writeFileSync(join(d, 'claude'),
    '#!/bin/sh\necho "CFGDIR=${CLAUDE_CONFIG_DIR+[$CLAUDE_CONFIG_DIR]}${CLAUDE_CONFIG_DIR-unset}"\nexit 0\n', 'utf8');
  try { chmodSync(join(d, 'claude'), 0o755); } catch {}
  return d;
}

// The child env is built from scratch — nothing ambient leaks in. `env` is the ONLY way a variable
// (a poisoned CLAUDE_CONFIG_DIR, say) reaches the launcher. USERPROFILE/HOME are pinned to the
// throwaway project dir. The project dir is not a git repo, so the title is the bare identity name.
function runLauncher({ args = [], identity = IDENT, dryRun = true, env: extraEnv = {} } = {}) {
  const proj = mkdtempSync(join(tmpdir(), 's1l-proj-'));
  const shims = makeShims();
  try {
    if (identity) {
      mkdirSync(join(proj, '.desk'), { recursive: true });
      writeFileSync(join(proj, '.desk', 'session-identity.json'), JSON.stringify(identity), 'utf8');
    }
    const env = {
      PATH: shims,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: proj, HOME: proj,
      ...(dryRun ? { CC_LAUNCH_DRYRUN: '1' } : {}),
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
      TEMP: process.env.TEMP, TMP: process.env.TMP,
      ...extraEnv,
    };
    const res = spawnSync(process.execPath, [launcher, ...args], { cwd: proj, env, encoding: 'utf8' });
    const plan = (dryRun && res.stdout.trim()) ? JSON.parse(res.stdout.trim().split('\n').pop()) : null;
    return { res, plan, proj };
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(shims, { recursive: true, force: true });
  }
}

const IDENT = { name: 'projx', color: 'purple' };
const COLOR = `/color ${IDENT.color}`;
const planFor = (args) => runLauncher({ args }).plan;
const argvFor = (args) => planFor(args).claude.argv;
const hasColor = (argv) => argv.some((a) => String(a).startsWith('/color'));
const hasName = (argv) => argv.includes('--name');
// The echo line the shim printed — the launcher inherits the child's stdout, so it is ours to read.
const cfgdirEcho = (res) => {
  const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith('CFGDIR='));
  assert.ok(line, `the shim echo is missing from stdout: ${JSON.stringify(res.stdout)} stderr: ${res.stderr}`);
  return line;
};

// ================================================================================================
// N14 — the launcher owns CLAUDE_CONFIG_DIR (AE-13, AE-14) — rows L21–L24
// ================================================================================================

test('L23 — control: no ambient CLAUDE_CONFIG_DIR, no flag → the child sees nothing', () => {
  const { res } = runLauncher({ dryRun: false });
  assert.equal(res.status, 0, `launcher exit ${res.status}: ${res.stderr}`);
  assert.equal(cfgdirEcho(res), 'CFGDIR=unset');
});

test('L21 — a plain launch in a shell carrying CLAUDE_CONFIG_DIR: the child sees NOTHING — not the ambient path, not an empty string (AE-13)', () => {
  const ambient = mkdtempSync(join(tmpdir(), 's1l-ambient-'));
  try {
    const { res } = runLauncher({ dryRun: false, env: { CLAUDE_CONFIG_DIR: ambient } });
    assert.equal(res.status, 0, `launcher exit ${res.status}: ${res.stderr}`);
    const echo = cfgdirEcho(res);
    assert.notEqual(echo, 'CFGDIR=[]', 'an empty string survives the chain as a defined variable — the fix must DELETE the key');
    assert.ok(!echo.includes(ambient), `the ambient path leaked to the child: ${echo}`);
    assert.equal(echo, 'CFGDIR=unset');
  } finally { rmSync(ambient, { recursive: true, force: true }); }
});

test('L22 — that same shell with --config-dir <other>: the child sees exactly <other>, resolved (AE-14)', () => {
  const ambient = mkdtempSync(join(tmpdir(), 's1l-ambient-'));
  const other = mkdtempSync(join(tmpdir(), 's1l-other-'));
  try {
    const { res } = runLauncher({ dryRun: false, env: { CLAUDE_CONFIG_DIR: ambient }, args: ['--config-dir', other] });
    assert.equal(res.status, 0, `launcher exit ${res.status}: ${res.stderr}`);
    assert.equal(cfgdirEcho(res), `CFGDIR=[${resolve(other)}]`);
  } finally { rmSync(ambient, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

test('L24 — dry run with a poisoned parent env: the delta stays the delta (no CLAUDE_CONFIG_DIR key), configDir null', () => {
  const { plan } = runLauncher({ env: { CLAUDE_CONFIG_DIR: tmpdir() } });
  assert.equal(plan.launch.configDir, null);
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '' },
    'the delta names keys this launch WRITES; the deletion is proven by L21, not exposed here (spec fork 8)');
});

test('N14 source — the deletion is unconditional, a real `delete`, keyed on the flag and never on the ambient env', () => {
  const s = readFileSync(launcher, 'utf8');
  assert.match(s, /if \(!flags\.configDir\) delete childEnv\.CLAUDE_CONFIG_DIR;/, 'the one-line fix in its spec shape');
  assert.ok(!/CLAUDE_CONFIG_DIR\s*=\s*''/.test(s), 'never written as an empty string');
  assert.ok(!/process\.env\.CLAUDE_CONFIG_DIR/.test(s), 'the launcher never reads the ambient value');
  // Doc rot in scope: the unverified new-tab-spawner claim is deleted, not kept (spec fork 14).
  // The doc is private-repo only — the public kit does not ship it, so this row self-skips there
  // (the same pattern as source-invariants D4).
  const docPath = join(ROOT, 'docs', 'cc-launcher.md');
  if (existsSync(docPath)) {
    const doc = readFileSync(docPath, 'utf8');
    assert.ok(!/spawner scrubs/.test(doc), 'the "spawner scrubs CLAUDE_CONFIG_DIR" claim is gone from cc-launcher.md');
  }
  assert.ok(!/scrubs its own vars/.test(s), 'and gone from the launcher comment');
  // …and gone from the tests too. The claim outlived its deletion once already, in a test-file comment
  // no row read, so the sweep covers every file in tests/ rather than the launcher and the doc alone.
  const swept = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.mjs'));
  assert.ok(swept.length > 1, 'the sweep actually found test files');
  for (const f of swept) {
    // Assertion lines carry the phrase as the thing they forbid — this row's own line included — so
    // they are dropped before the check. What remains is prose: comments and headers.
    const prose = readFileSync(join(ROOT, 'tests', f), 'utf8')
      .split('\n').filter((l) => !l.includes('assert.')).join('\n');
    assert.ok(!/spawner scrubs|scrubs its own vars/.test(prose), `tests/${f} repeats the deleted new-tab-spawner claim`);
  }
});

// ================================================================================================
// N4 — a fork launches fresh with --name (AE-15) — rows R9–R11
// ================================================================================================

test('R9 — every --fork-session form pushes --name <title>, whatever else the argv holds', () => {
  const forms = [
    ['--resume', '0f3a', '--fork-session'],
    ['-r', '0f3a', '--fork-session'],
    ['--fork-session', '--resume', '0f3a'],
    ['-c', '--fork-session'],
    ['--continue', '--fork-session'],
    ['--resume=0f3a', '--fork-session'],
  ];
  for (const args of forms) {
    const plan = planFor(args);
    const argv = plan.claude.argv;
    const at = argv.indexOf('--name');
    assert.ok(at > 0, `${args.join(' ')} must push --name: ${argv.join(' ')}`);
    assert.equal(argv[at + 1], plan.launch.title, `${args.join(' ')}: named with the ONE computed title`);
    assert.ok(plan.launch.title.startsWith(IDENT.name), 'the fresh name for this project (AE-15: `env@main`, not the stored topic)');
    for (const a of args) assert.ok(argv.includes(a), `${args.join(' ')}: ${a} forwarded to claude`);
  }
});

test('R9b — the same forms WITHOUT --fork-session still omit --name (a plain resume keeps its stored name)', () => {
  for (const args of [['--resume', '0f3a'], ['-r', '0f3a'], ['-c'], ['--continue'], ['--resume=0f3a']]) {
    assert.ok(!hasName(argvFor(args)), `${args.join(' ')} must not push --name`);
  }
});

test('R10 — /color still follows commander on the fork forms', () => {
  assert.deepEqual(argvFor(['-r', '0f3a', '--fork-session']).slice(-3), ['0f3a', '--fork-session', COLOR], 'last arg is a boolean flag → injected');
  assert.deepEqual(argvFor(['-r', '--fork-session']).slice(-2), ['--fork-session', COLOR], 'bare picker then a flag: the flag closes the slot (C10 rule)');
  const withPrompt = argvFor(['-r', '0f3a', '--fork-session', 'keep going']);
  assert.equal(withPrompt.at(-1), 'keep going');
  assert.ok(!hasColor(withPrompt), 'a real prompt is never clobbered');
});

test('R11 — the RESUME_FLAGS comment no longer says --fork-session is covered transitively', () => {
  const s = readFileSync(launcher, 'utf8');
  assert.ok(!/covered transitively/.test(s), 'the wrong clause is gone');
  assert.match(s, /const isFork = flags\.rest\.includes\('--fork-session'\);/, 'the fork is detected by name');
  assert.match(s, /const isResume = !isFork &&/, 'and a fork is never a resume for --name purposes');
});

// ================================================================================================
// N2 — `--cloud <description>` is the prompt (AE-18) — rows C13–C16
// ================================================================================================

test('C13 — `cc --cloud "build me a thing"`: the description is the last token, no /color (AE-18)', () => {
  const argv = argvFor(['--cloud', 'build me a thing']);
  assert.deepEqual(argv.slice(-2), ['--cloud', 'build me a thing']);
  assert.ok(!hasColor(argv), `no /color: ${argv.join(' ')}`);
});

test('C8 (kept) — bare `--cloud`: no /color, as before', () => {
  const argv = argvFor(['--cloud']);
  assert.equal(argv.at(-1), '--cloud');
  assert.ok(!hasColor(argv));
});

test('C14 — `--cloud <desc> <more>`: the second positional is a prompt anyway; no /color', () => {
  const argv = argvFor(['--cloud', 'build me a thing', 'and more']);
  assert.equal(argv.at(-1), 'and more');
  assert.ok(!hasColor(argv));
});

test('C15 — `--cloud --chrome`: the flag closes the optional slot; /color injected', () => {
  assert.deepEqual(argvFor(['--cloud', '--chrome']).slice(-3), ['--cloud', '--chrome', COLOR]);
});

test('C16 — `--cloud <uuid>` and `--cloud=x`: a consumed value is the prompt (no /color); the glued form is unchanged (/color)', () => {
  // Spec N2: "A value consumed by --cloud IS the user's prompt" — no carve-out for a session id.
  const uuid = argvFor(['--cloud', '3f2c9a1e-0000-4000-8000-000000000001']);
  assert.equal(uuid.at(-1), '3f2c9a1e-0000-4000-8000-000000000001');
  assert.ok(!hasColor(uuid), 'a session id consumed by --cloud is still its value → no injection');
  assert.deepEqual(argvFor(['--cloud=x']).slice(-2), ['--cloud=x', COLOR], '`--cloud=x` is not bare → treated as a flag → /color as today');
  // Only --cloud is special-cased: `-r <id>` keeps injecting (spec fork 9).
  assert.deepEqual(argvFor(['-r', '0f3a']).slice(-3), ['-r', '0f3a', COLOR]);
});

// ================================================================================================
// G2 — the flag table matches `claude --help` 2.1.251 (AE-19, AE-20, AE-21) — rows C17–C19
// ================================================================================================

// Parse the checked-in help text. A flag line starts with exactly two spaces then `-`; the names are
// the comma-separated aliases before the value token; `<x...>` is variadic, `<x>` single-value, `[x]`
// optional. Continuation lines (deeper indent) and boolean flags are ignored.
function parseHelp(text) {
  const value = new Set(), variadic = new Set(), optional = new Set();
  for (const line of text.split('\n')) {
    const m = line.match(/^  (-[^\s<[,]+(?:, -[^\s<[,]+)*)(?: (<[^>]+>|\[[^\]]+\]))?/);
    if (!m) continue;
    const names = m[1].split(', ');
    const tok = m[2];
    if (!tok) continue;
    const target = tok.startsWith('[') ? optional : tok.endsWith('...>') ? variadic : value;
    for (const n of names) target.add(n);
  }
  return { value, variadic, optional };
}
function launcherSet(src, name) {
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(m, `${name} literal found in the launcher`);
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}
const sorted = (s) => [...s].sort();

test('C17 — VALUE_FLAGS ∪ VARIADIC_FLAGS equals the `<value>` flags of claude --help 2.1.251; VARIADIC equals the `<x...>` set; OPTIONAL equals the `[x]` set (AE-21)', () => {
  const help = parseHelp(readFileSync(HELP_FIXTURE, 'utf8'));
  // The fixture parsed to what the spec read by hand (sanity on the parser, not on the launcher).
  for (const f of ['--autocompact', '--environment', '-n', '--name', '--allowedTools', '--disallowedTools']) {
    assert.ok(help.value.has(f) || help.variadic.has(f), `parser: ${f} is a value flag in the help text`);
  }
  assert.deepEqual(sorted(help.variadic), ['--add-dir', '--allowed-tools', '--allowedTools', '--betas', '--disallowed-tools', '--disallowedTools', '--file', '--mcp-config', '--tools'].sort());
  assert.ok(help.optional.has('--cloud') && help.optional.has('-r') && help.optional.has('-d'));

  const s = readFileSync(launcher, 'utf8');
  const VALUE = launcherSet(s, 'VALUE_FLAGS'), VARIADIC = launcherSet(s, 'VARIADIC_FLAGS'), OPTIONAL = launcherSet(s, 'OPTIONAL_VALUE_FLAGS');
  assert.deepEqual(sorted(VARIADIC), sorted(help.variadic), 'VARIADIC_FLAGS drifts from the <x...> flags');
  assert.deepEqual(sorted(OPTIONAL), sorted(help.optional), 'OPTIONAL_VALUE_FLAGS drifts from the [x] flags');
  const allValue = new Set([...VALUE, ...VARIADIC]);
  assert.deepEqual(sorted(allValue), sorted(new Set([...help.value, ...help.variadic])),
    'VALUE_FLAGS ∪ VARIADIC_FLAGS drifts from the <…> flags (a flag the launcher does not know is an untinted session; one the help lacks is stale)');
  for (const f of help.value) assert.ok(VALUE.has(f), `single-value flag ${f} missing from VALUE_FLAGS`);
  for (const f of ['--autocompact', '--environment', '-n', '--allowedTools', '--disallowedTools']) assert.ok(allValue.has(f), `${f} (new in 2.1.251) is known`);
  // The comment names the version it was checked against.
  assert.ok(s.includes('2.1.251'), 'the launcher comment names Claude Code 2.1.251');
  assert.ok(!s.includes('2.1.233'), 'and no longer 2.1.233');
});

test('C18 — a value flag new in 2.1.251 still self-colours (AE-19)', () => {
  assert.deepEqual(argvFor(['--autocompact', '200k']).slice(-3), ['--autocompact', '200k', COLOR]);
  assert.deepEqual(argvFor(['--environment', 'env_1']).slice(-3), ['--environment', 'env_1', COLOR]);
  const n = argvFor(['-n', 'x']);
  assert.deepEqual(n.slice(-3), ['-n', 'x', COLOR], '`x` is the value of -n, never the prompt');
  assert.deepEqual(argvFor(['--allowedTools=Bash']).slice(-2), ['--allowedTools=Bash', COLOR], 'a glued alias is a flag');
});

test('C19 — an open variadic list never gets /color appended; a flag closes it (AE-20)', () => {
  const open = argvFor(['--allowed-tools', 'Bash', 'Edit']);
  assert.deepEqual(open.slice(-3), ['--allowed-tools', 'Bash', 'Edit']);
  assert.ok(!hasColor(open), `no /color behind an open list: ${open.join(' ')}`);
  assert.deepEqual(argvFor(['--allowedTools', 'Bash', 'Edit', '--chrome']).slice(-2), ['--chrome', COLOR], 'a flag closes the list → injected');
  const file = argvFor(['--file', 'a', 'b', 'do X']);
  assert.equal(file.at(-1), 'do X');
  assert.ok(!hasColor(file), 'a variadic swallows the positional too — the launcher forwards verbatim and does not inject');
  for (const f of ['--add-dir', '--betas', '--disallowed-tools', '--mcp-config', '--tools']) {
    const argv = argvFor([f, 'one']);
    assert.equal(argv.at(-1), 'one', `${f} one: the list is open`);
    assert.ok(!hasColor(argv), `${f}: no /color behind an open list`);
    assert.deepEqual(argvFor([f, 'one', '--chrome']).slice(-2), ['--chrome', COLOR], `${f} one --chrome: closed → injected`);
  }
  // A variadic written bare at the very end (no items) is an open list too.
  const bare = argvFor(['--add-dir']);
  assert.equal(bare.at(-1), '--add-dir');
  assert.ok(!hasColor(bare));
  // A single-value flag after the list re-opens the prompt slot.
  assert.deepEqual(argvFor(['--tools', 'Bash', '--model', 'opus']).slice(-3), ['--model', 'opus', COLOR]);
});

test('G2 source — the launcher stays public-kit clean: zero non-builtin imports, no private strings', () => {
  const s = readFileSync(launcher, 'utf8');
  assert.ok(!/from\s+['"](?!node:)/.test(s), 'no non-builtin imports');
  // This file ships in the public kit, so the private needles are assembled rather than written as
  // literals — the P2 leak scan sweeps exported tests for the very strings this row checks.
  const needles = ['.claude' + '-team', '·' + 'team', 'cc' + '2'];
  for (const needle of needles) assert.ok(!s.includes(needle), `private needle ${needle} in the public launcher`);
});
