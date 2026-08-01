import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// launcher-vscode (rows H1–H6) — the cc launcher's VS Code co-launch, exercised through the
// CC_LAUNCH_DRYRUN seam: the launcher prints its full plan (VS Code action/target/spawnOpts +
// the claude argv) as one JSON line and spawns NOTHING. The dry-run shares the REAL spawnOpts
// and argv objects with the live path, so asserting the plan asserts the launch. PATH is pinned
// to a shim dir so neither a real `code` nor a real `claude` can leak in; the shims are inert
// files that only need to exist for the launcher's PATH resolver.

const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, '..', 'home', 'claude-launch.mjs');

// Shim dir with a fake `claude` (always) and optionally a fake `code` — both POSIX and .cmd forms.
function makeShims({ withCode }) {
  const d = mkdtempSync(join(tmpdir(), 'ccl-shim-'));
  const names = withCode ? ['claude', 'code'] : ['claude'];
  for (const n of names) {
    writeFileSync(join(d, n + '.cmd'), '@echo off\r\nexit /b 0\r\n', 'utf8');
    writeFileSync(join(d, n), '#!/bin/sh\nexit 0\n', 'utf8');
    try { chmodSync(join(d, n), 0o755); } catch {}
  }
  return d;
}

// ccVscode: a string sets CC_VSCODE to that value; null leaves it UNSET in the child env.
// ccVscodeTile: same convention for CC_VSCODE_TILE (the default-on tiling switch).
// args:     extra argv handed to the launcher (the launcher-owned flags, a user prompt, …).
// identity: written to <proj>/.claude/session-identity.json so name/color are deterministic.
// dryRun:   false runs WITHOUT the dry-run seam — for the --print-title / --print-tabcolor
//           early exits, which return raw text (not JSON) and must fire before any side effect.
// wtSession: sets WT_SESSION so the Windows-Terminal tab-color escape is non-empty.
// USERPROFILE/HOME are pinned to the throwaway project dir so `~` expansion is deterministic and
// the launcher can never resolve a path in the real home.
function runLauncher({
  workspaces = [], withCode = true, ccVscode = '1', ccVscodeTile = null,
  args = [], identity = null, dryRun = true, wtSession = null,
}) {
  const proj = mkdtempSync(join(tmpdir(), 'ccl-proj-'));
  const shims = makeShims({ withCode });
  try {
    for (const w of workspaces) writeFileSync(join(proj, w), '{}', 'utf8');
    if (identity) {
      mkdirSync(join(proj, '.claude'), { recursive: true });
      writeFileSync(join(proj, '.claude', 'session-identity.json'), JSON.stringify(identity), 'utf8');
    }
    const env = {
      PATH: shims,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: proj, HOME: proj,
      ...(dryRun ? { CC_LAUNCH_DRYRUN: '1' } : {}),
      ...(wtSession === null ? {} : { WT_SESSION: wtSession }),
      ...(ccVscode === null ? {} : { CC_VSCODE: ccVscode }),
      ...(ccVscodeTile === null ? {} : { CC_VSCODE_TILE: ccVscodeTile }),
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
      TEMP: process.env.TEMP, TMP: process.env.TMP,
    };
    const res = spawnSync(process.execPath, [launcher, ...args], { cwd: proj, env, encoding: 'utf8' });
    const plan = (dryRun && res.stdout.trim()) ? JSON.parse(res.stdout.trim().split('\n').pop()) : null;
    return { res, plan, proj };
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(shims, { recursive: true, force: true });
  }
}

test('H1 — exactly one .code-workspace: VS Code opens the workspace file, detached', () => {
  const { res, plan } = runLauncher({ workspaces: ['proj.code-workspace'] });
  assert.equal(res.status, 0);
  assert.equal(plan.vscode.action, 'workspace');
  assert.equal(plan.vscode.target, 'proj.code-workspace');
  assert.equal(plan.vscode.spawnOpts.detached, true);
  assert.equal(plan.vscode.spawnOpts.stdio, 'ignore');
  assert.equal(plan.vscode.spawnOpts.unref, true);
  assert.ok(Array.isArray(plan.claude.argv) && plan.claude.argv.length > 0, 'claude still launches');
});

test('H2 — no .code-workspace: falls back to opening the folder', () => {
  const { plan } = runLauncher({ workspaces: [] });
  assert.equal(plan.vscode.action, 'folder');
  assert.equal(plan.vscode.target, '.');
});

test('H3 — two .code-workspace files: never guesses, opens the folder', () => {
  const { plan } = runLauncher({ workspaces: ['a.code-workspace', 'b.code-workspace'] });
  assert.equal(plan.vscode.action, 'folder');
  assert.equal(plan.vscode.target, '.');
});

test('H4 — `code` missing from PATH: silent skip, claude launch untouched', () => {
  const { res, plan } = runLauncher({ workspaces: ['proj.code-workspace'], withCode: false });
  assert.equal(res.status, 0);
  assert.equal(plan.vscode.action, 'skip-no-cli');
  assert.equal(res.stderr, '', 'no error output');
  assert.ok(plan.claude.argv.length > 0, 'claude still launches');
});

test('H5 — CC_VSCODE unset (public-kit default): no VS Code launch at all', () => {
  const { plan } = runLauncher({ workspaces: ['proj.code-workspace'], ccVscode: null });
  assert.equal(plan.vscode.action, 'off');
  assert.equal(plan.vscode.target, null);
});

test('H5 — CC_VSCODE=0 is falsy under CC’s env-truthiness parse', () => {
  const { plan } = runLauncher({ workspaces: [], ccVscode: '0' });
  assert.equal(plan.vscode.action, 'off');
});

test('H6 — never blocking: single fire-and-forget spawn site (detached + unref, no wait)', () => {
  // Behavioural half: the plan's spawnOpts (shared with the live path) are fire-and-forget.
  const { plan } = runLauncher({ workspaces: [] });
  assert.equal(plan.vscode.spawnOpts.detached, true);
  assert.equal(plan.vscode.spawnOpts.unref, true);
  // Structural half: exactly one VS Code spawn site, async spawn + immediate unref — the claude
  // launch can never wait on it, even when `code` hangs.
  const src = readFileSync(launcher, 'utf8');
  assert.match(src, /spawn\(vsExe, vsArgs, VS_SPAWN_OPTS\)\.unref\(\);/);
  assert.equal((src.match(/VS_SPAWN_OPTS\)/g) || []).length, 1, 'one spawn site shares the asserted opts');
});

// --- window tiling (Windows side-by-side), asserted through the same dry-run seam ----------------
// tile.enabled is computed purely from platform + env + vsPlan, so it is deterministic and spawns
// nothing. The enabled/reason split is platform-dependent, so enabled-true assertions are win32-only
// while the reason/field checks that don't depend on win32 run on every OS.
const IS_WIN = process.platform === 'win32';

test('T1 — win32 + CC_VSCODE=1 + a workspace: tiling on, terminal-left/50-50, workspace projectMatch', () => {
  const { plan } = runLauncher({ workspaces: ['proj.code-workspace'] });
  assert.ok(plan.tile, 'tile block always present in the plan');
  assert.equal(plan.tile.side, 'terminal-left');
  assert.equal(plan.tile.ratio, 0.5);
  assert.equal(plan.tile.captureMethod, 'foreground-sync');
  assert.equal(plan.tile.snapGroup, true, 'tiler forms a real snap group, not a bare reposition');
  assert.equal(plan.tile.projectMatch, 'proj', 'workspace base without the .code-workspace extension');
  assert.equal(typeof plan.tile.titleMatch, 'string');
  if (IS_WIN) { assert.equal(plan.tile.enabled, true); assert.equal(plan.tile.reason, 'on'); }
  else { assert.equal(plan.tile.enabled, false); assert.equal(plan.tile.reason, 'not-win32'); }
});

test('T2 — CC_VSCODE unset: tiling off with reason vscode-off (any OS)', () => {
  const { plan } = runLauncher({ workspaces: ['proj.code-workspace'], ccVscode: null });
  assert.equal(plan.tile.enabled, false);
  assert.equal(plan.tile.reason, 'vscode-off');
});

test('T3 — win32 + CC_VSCODE_TILE=off: VS Code still opens, tiling disabled by flag', () => {
  const { plan } = runLauncher({ workspaces: [], ccVscodeTile: 'off' });
  assert.equal(plan.vscode.action, 'folder', 'VS Code co-launch is unaffected by the tile flag');
  assert.equal(plan.tile.enabled, false);
  assert.equal(plan.tile.reason, IS_WIN ? 'disabled-flag' : 'not-win32');
});

test('T4 — win32 + `code` missing: tiling gated off (vscode-no-cli)', () => {
  const { plan } = runLauncher({ workspaces: ['proj.code-workspace'], withCode: false });
  assert.equal(plan.tile.enabled, false);
  assert.equal(plan.tile.reason, IS_WIN ? 'vscode-no-cli' : 'not-win32');
});

test('T5 — CC_VSCODE_TILE truthy/falsy variants parse as a default-on flag (win32)', { skip: !IS_WIN }, () => {
  for (const v of ['1', 'on', 'true', 'yes']) {
    assert.equal(runLauncher({ workspaces: [], ccVscodeTile: v }).plan.tile.enabled, true, `${v} → on`);
  }
  for (const v of ['0', 'off', 'false', 'no']) {
    assert.equal(runLauncher({ workspaces: [], ccVscodeTile: v }).plan.tile.enabled, false, `${v} → off`);
  }
});

// --- snap-group gesture + exit re-title (structural, OS-independent) ------------------------------
// These assert the launcher SOURCE, not runtime behaviour: the snap gesture and the exit re-title
// only fire on a live win32 launch (no dry-run seam), so they're verified by shape, like H6.

test('T6 — the tiler forms a snap group VS-Code-right-first then terminal-left (focus ends on terminal)', () => {
  const src = readFileSync(launcher, 'utf8');
  // The gesture is driven by simulated Win+arrow (keybd_event) — no snap-group API exists.
  assert.match(src, /keybd_event/, 'drives the snap gesture via keybd_event');
  // Order matters: VS Code (Win+Right, 0x27) must be snapped BEFORE the terminal (Win+Left, 0x25),
  // so the last-snapped window (terminal) keeps focus.
  const right = src.indexOf('SnapKey 0x27');
  const left = src.indexOf('SnapKey 0x25');
  assert.ok(right > 0 && left > 0, 'both snap directions present');
  assert.ok(right < left, 'VS Code snaps right first, terminal snaps left second');
  // Foreground lock must be lifted for a background process to focus each window before snapping.
  assert.match(src, /SPI_SETFOREGROUNDLOCKTIMEOUT|0x2001/, 'zeroes the foreground lock timeout');
  assert.match(src, /AttachThreadInput/, 'attaches to the foreground input queue to steal focus');
});

test('T7 — the launcher re-asserts the tab title after Claude Code exits (name persists on the prompt)', () => {
  const src = readFileSync(launcher, 'utf8');
  // The OSC 2 re-emit must live AFTER the claude spawnSync, not only before it.
  const spawn = src.indexOf('spawnSync(claudeArgv[0]');
  const lastOsc = src.lastIndexOf('ESC}]2;${title}');
  assert.ok(spawn > 0 && lastOsc > spawn, 'an OSC 2 title write follows the claude spawnSync');
});

// --- launcher-owned flags (rows L1–L13) -----------------------------------------------------------
// The four self-consumed flags — --config-dir / --title-prefix / --title-suffix / --no-vscode —
// asserted through the same dry-run seam. Two properties carry the whole feature and each has a
// dedicated row: a self-consumed flag NEVER reaches the claude argv (L3/L5/L10), and the marker
// reaches EVERY title consumer from one computation (L2). Values here are deliberately generic —
// this file ships in the public kit, so it carries no caller's naming policy.

const IDENT = { name: 'projx', color: 'purple' };

// The unmarked title for a given fixture, taken from the launcher itself: the repo/branch part is
// environment-dependent, so every marker assertion is expressed relative to this baseline rather
// than against a hardcoded string that would be wrong on someone else's checkout.
function coreTitle(extra = {}) {
  return runLauncher({ workspaces: [], identity: IDENT, ...extra }).plan.launch.title;
}

test('L1 — no launcher flags: the launch block is inert and the child env gains nothing', () => {
  const { res, plan } = runLauncher({ workspaces: [], identity: IDENT });
  assert.equal(res.status, 0);
  assert.equal(plan.launch.configDir, null);
  assert.equal(plan.launch.titlePrefix, '');
  assert.equal(plan.launch.titleSuffix, '');
  assert.equal(plan.launch.noVsCode, false);
  assert.equal(plan.claude.envDelta, null, 'no env delta when --config-dir is absent');
  assert.equal(plan.launch.title, plan.tile.titleMatch);
});

test('L2 — prefix/suffix compose ONE title that reaches --name and the tiler alike', () => {
  const core = coreTitle();
  const { plan } = runLauncher({ workspaces: [], identity: IDENT, args: ['--title-prefix', 'P', '--title-suffix', '·s'] });
  const marked = `P ${core} ·s`;
  assert.equal(plan.launch.title, marked);
  assert.equal(plan.launch.titlePrefix, 'P');
  assert.equal(plan.launch.titleSuffix, '·s');
  const nameAt = plan.claude.argv.indexOf('--name');
  assert.ok(nameAt > 0, '--name is passed to claude');
  assert.equal(plan.claude.argv[nameAt + 1], marked, 'the MARKED title is what claude is named');
  assert.equal(plan.tile.titleMatch, marked, 'the tiler matches the marked window title');
});

test('L3 — --config-dir sets the child env delta and never leaks into the claude argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccl-cfg-'));
  try {
    const { plan } = runLauncher({ workspaces: [], identity: IDENT, args: ['--config-dir', dir] });
    assert.equal(plan.launch.configDir, resolve(dir));
    assert.deepEqual(plan.claude.envDelta, { CLAUDE_CONFIG_DIR: resolve(dir) }, 'delta only — never the whole env');
    assert.ok(!plan.claude.argv.includes('--config-dir'), 'flag stripped from the claude argv');
    assert.ok(!plan.claude.argv.includes(dir), 'its VALUE is stripped too (never a stray positional)');
    assert.ok(!plan.claude.argv.includes(resolve(dir)), 'nor the resolved form');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L4 — --config-dir expands a leading ~ and resolves to an absolute path', () => {
  for (const spec of ['~/alt', '~\\alt']) {
    const { plan, proj } = runLauncher({ workspaces: [], identity: IDENT, args: ['--config-dir', spec] });
    assert.equal(plan.launch.configDir, resolve(join(proj, 'alt')), `${spec} expands against the home dir`);
  }
});

test('L5 — all four flags at once: every effect holds simultaneously', () => {
  const core = coreTitle();
  const dir = mkdtempSync(join(tmpdir(), 'ccl-cfg-'));
  try {
    const { plan } = runLauncher({
      workspaces: ['proj.code-workspace'], identity: IDENT,
      args: ['--config-dir', dir, '--title-prefix', 'P', '--title-suffix', '·s', '--no-vscode'],
    });
    assert.equal(plan.launch.title, `P ${core} ·s`);
    assert.deepEqual(plan.claude.envDelta, { CLAUDE_CONFIG_DIR: resolve(dir) });
    assert.equal(plan.launch.noVsCode, true);
    assert.equal(plan.vscode.action, 'off');
    assert.equal(plan.tile.enabled, false);
    for (const f of ['--config-dir', '--title-prefix', '--title-suffix', '--no-vscode', 'P', '·s', dir]) {
      assert.ok(!plan.claude.argv.includes(f), `${f} never reaches claude`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L6 — --print-title prints the MARKED title and exits before any side effect', () => {
  const core = coreTitle();
  const { res } = runLauncher({
    workspaces: [], identity: IDENT, dryRun: false, wtSession: 'x',
    args: ['--title-prefix', 'P', '--title-suffix', '·s', '--print-title'],
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, `P ${core} ·s`, 'exactly the marked title, nothing else');
  assert.ok(!res.stdout.includes('\x1b'), 'the early exit precedes every OSC write');
  assert.equal(res.stderr, '');
});

test('L7 — --print-tabcolor is byte-identical with and without the new flags', () => {
  const bare = runLauncher({ workspaces: [], identity: IDENT, dryRun: false, wtSession: 'x', args: ['--print-tabcolor'] });
  const flagged = runLauncher({
    workspaces: [], identity: IDENT, dryRun: false, wtSession: 'x',
    args: ['--config-dir', tmpdir(), '--title-prefix', 'P', '--title-suffix', '·s', '--no-vscode', '--print-tabcolor'],
  });
  assert.ok(bare.res.stdout.includes('\x1b]4;264;'), 'the WT tab-color escape is actually being produced');
  assert.equal(flagged.res.stdout, bare.res.stdout, 'the tab-color seam is untouched by the new flags');
});

test('L8 — a user prompt is still detected THROUGH the launcher flags (no /color clobber)', () => {
  const dir = tmpdir();
  const { plan } = runLauncher({
    workspaces: [], identity: IDENT,
    args: ['--config-dir', dir, '--title-prefix', 'P', 'do X'],
  });
  assert.ok(plan.claude.argv.includes('do X'), 'the real prompt is forwarded');
  assert.ok(!plan.claude.argv.some((a) => String(a).startsWith('/color')), 'no /color injected over a real prompt');
});

test('L9 — the same flags with NO prompt still self-color', () => {
  const { plan } = runLauncher({
    workspaces: [], identity: IDENT,
    args: ['--config-dir', tmpdir(), '--title-prefix', 'P', '--title-suffix', '·s', '--no-vscode'],
  });
  assert.ok(plan.claude.argv.includes('/color purple'), 'the launcher flags are invisible to the prompt scan');
});

test('L10 — malformed input is inert: a dangling value-flag is stripped, never fatal', () => {
  const { res, plan } = runLauncher({ workspaces: [], identity: IDENT, args: ['--config-dir'] });
  assert.equal(res.status, 0);
  assert.equal(plan.launch.configDir, null);
  assert.equal(plan.claude.envDelta, null);
  assert.ok(!plan.claude.argv.includes('--config-dir'), 'still stripped from the claude argv');
  assert.ok(plan.claude.argv.length > 0, 'claude still launches');
});

test('L11 — a non-ASCII title prefix survives the round-trip unchanged', () => {
  const core = coreTitle();
  const glyph = '🧪';
  const { plan } = runLauncher({ workspaces: [], identity: IDENT, args: ['--title-prefix', glyph] });
  assert.equal(plan.launch.titlePrefix, glyph);
  assert.equal(plan.launch.title, `${glyph} ${core}`);
  assert.equal(plan.claude.argv[plan.claude.argv.indexOf('--name') + 1], `${glyph} ${core}`);
});

test('L12 — --no-vscode overrides CC_VSCODE=1: no co-launch, no tiling, claude unaffected', () => {
  const { res, plan } = runLauncher({
    workspaces: ['proj.code-workspace'], identity: IDENT, ccVscode: '1', args: ['--no-vscode'],
  });
  assert.equal(res.status, 0);
  assert.equal(plan.launch.noVsCode, true);
  assert.equal(plan.vscode.action, 'off');
  assert.equal(plan.vscode.target, null);
  assert.equal(plan.tile.enabled, false);
  assert.equal(plan.tile.reason, 'vscode-off', 'gates off through the EXISTING reason, no new taxonomy');
  assert.ok(plan.claude.argv.length > 0, 'claude still launches');
});

test('L13 — the tile reason taxonomy is unchanged by the new flags', () => {
  const KNOWN = new Set(['on', 'vscode-off', 'not-win32', 'vscode-no-cli', 'disabled-flag', 'off']);
  const reasons = [
    runLauncher({ workspaces: [], identity: IDENT, args: ['--no-vscode'] }).plan.tile.reason,
    runLauncher({ workspaces: [], identity: IDENT, args: ['--config-dir', tmpdir()] }).plan.tile.reason,
    runLauncher({ workspaces: [], identity: IDENT, withCode: false }).plan.tile.reason,
    runLauncher({ workspaces: [], identity: IDENT, ccVscodeTile: 'off' }).plan.tile.reason,
  ];
  for (const r of reasons) assert.ok(KNOWN.has(r), `unknown tile reason introduced: ${r}`);
  // …and the source itself grew no new reason literal. Only the RESULT positions of the ternary
  // chain are reasons (`? 'x'` / `: 'x'`); a quoted operand like `!== 'win32'` is a condition.
  const src = readFileSync(launcher, 'utf8');
  const block = src.slice(src.indexOf('const tileReason'), src.indexOf('const projectMatch'));
  const produced = [...block.matchAll(/[?:]\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(produced.length >= 5, 'the reason chain was found and parsed');
  for (const lit of produced) assert.ok(KNOWN.has(lit), `new reason literal in source: '${lit}'`);
});
