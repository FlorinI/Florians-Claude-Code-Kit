import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
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

// Shim dir with a fake `claude` (default) and optionally a fake `code` — both POSIX and .cmd forms.
// `withClaude: false` builds a `code`-only PATH (P9: pair mode must not need `claude`).
function makeShims({ withCode, withClaude = true }) {
  const d = mkdtempSync(join(tmpdir(), 'ccl-shim-'));
  const names = [...(withClaude ? ['claude'] : []), ...(withCode ? ['code'] : [])];
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
// identity: written to <proj>/.desk/session-identity.json so name/color are deterministic.
// dryRun:   false runs WITHOUT the dry-run seam — for the --print-title / --print-tabcolor
//           early exits, which return raw text (not JSON) and must fire before any side effect.
// wtSession: sets WT_SESSION so the Windows-Terminal tab-color escape is non-empty.
// env:      extra vars added to the child environment — the ONLY way anything reaches the launcher's
//           env, since the child env below is built from scratch rather than inherited. Every case
//           that cares about an ambient var (a poisoned CC_TITLE_* pair, say) states it here, so no
//           result depends on the shell the suite happens to run in.
// USERPROFILE/HOME are pinned to the throwaway project dir so `~` expansion is deterministic and
// the launcher can never resolve a path in the real home.
function runLauncher({
  workspaces = [], withCode = true, withClaude = true, ccVscode = '1', ccVscodeTile = null,
  args = [], identity = null, dryRun = true, wtSession = null, env: extraEnv = {},
}) {
  const proj = mkdtempSync(join(tmpdir(), 'ccl-proj-'));
  const shims = makeShims({ withCode, withClaude });
  try {
    for (const w of workspaces) writeFileSync(join(proj, w), '{}', 'utf8');
    if (identity) {
      mkdirSync(join(proj, '.desk'), { recursive: true });
      writeFileSync(join(proj, '.desk', 'session-identity.json'), JSON.stringify(identity), 'utf8');
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
      ...extraEnv,
    };
    const res = spawnSync(process.execPath, [launcher, ...args], { cwd: proj, env, encoding: 'utf8' });
    const plan = (dryRun && res.stdout.trim()) ? JSON.parse(res.stdout.trim().split('\n').pop()) : null;
    return { res, plan, proj };
  } finally {
    rmTree(proj);
    rmTree(shims);
  }
}

// A cleanup that survives a detached shim still holding the directory. On a LIVE (non-dry-run) pair
// run the launcher spawns the `code` shim DETACHED and unrefs it, and that shim's own cmd.exe keeps
// the project directory as its cwd for a moment after the launcher has exited — so a bare rmSync
// throws EBUSY and fails a row over a Windows file-locking artifact of the harness rather than over
// anything asserted. `rmSync`'s own maxRetries does not cover this case on Windows; a spin does.
// It never masks a real failure: after the budget the last error is thrown.
function rmTree(dir) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (Date.now() > deadline) throw e;
      const until = Date.now() + 50;
      while (Date.now() < until) { /* the harness has no async seam here — a short spin */ }
    }
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
  // ONE SITE EACH, counted — added 2026-09-09. Order alone is not enough: the pair-mode work inserts
  // a guarded Esc between and after the two snaps, and the obvious wrong way to make a snap "take"
  // is to send the gesture twice. A second `SnapKey 0x27` after the terminal's snap re-raises the
  // picker over the half that was just filled and leaves focus on VS Code, which is the arrangement
  // acceptance example A1 forbids — and the old index comparison was still green against it.
  assert.equal((src.match(/SnapKey 0x27/g) || []).length, 1,
    'exactly one SnapKey 0x27 site — the gesture is driven once per window, and a pair-only second one is a different arrangement, not a retry');
  assert.equal((src.match(/SnapKey 0x25/g) || []).length, 1,
    'exactly one SnapKey 0x25 site, for the same reason');
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

// --- launcher-owned flags (rows L1–L18) -----------------------------------------------------------
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

test('L1 — no launcher flags: the launch block is inert and the child env gains nothing but cleared markers', () => {
  const { res, plan } = runLauncher({ workspaces: [], identity: IDENT });
  assert.equal(res.status, 0);
  assert.equal(plan.launch.configDir, null);
  assert.equal(plan.launch.titlePrefix, '');
  assert.equal(plan.launch.titleSuffix, '');
  assert.equal(plan.launch.noVsCode, false);
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '' },
    'the markers are cleared (every launch owns them); no CLAUDE_CONFIG_DIR, nothing else added');
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
    assert.deepEqual(plan.claude.envDelta,
      { CLAUDE_CONFIG_DIR: resolve(dir), CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '' },
      'the config home plus the always-cleared markers — delta only, never the whole env');
    assert.ok(!plan.claude.argv.includes('--config-dir'), 'flag stripped from the claude argv');
    assert.ok(!plan.claude.argv.includes(dir), 'its VALUE is stripped too (never a stray positional)');
    assert.ok(!plan.claude.argv.includes(resolve(dir)), 'nor the resolved form');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L4 — --config-dir expands a leading ~ and resolves to an absolute path', () => {
  // Both separators expand the tilde on every platform, but they do NOT converge on the same path.
  // Only Windows treats `\` as a separator; on POSIX it is an ordinary filename character, so `~\alt`
  // legitimately means a file called `\alt` under the home dir. Asserting `~\alt === ~/alt` everywhere
  // is a Windows-centric reading, so the expectation is computed per platform rather than skipped —
  // the tilde expansion itself stays covered on all three CI legs.
  const win = process.platform === 'win32';
  for (const [spec, leaf] of [['~/alt', 'alt'], ['~\\alt', win ? 'alt' : '\\alt']]) {
    const { plan, proj } = runLauncher({ workspaces: [], identity: IDENT, args: ['--config-dir', spec] });
    assert.equal(plan.launch.configDir, resolve(join(proj, leaf)), `${spec} expands against the home dir`);
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
    assert.deepEqual(plan.claude.envDelta, {
      CLAUDE_CONFIG_DIR: resolve(dir), CC_TITLE_PREFIX: 'P', CC_TITLE_SUFFIX: '·s',
    }, 'config-dir + markers → all three keys, delta only');
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
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '' },
    'no CLAUDE_CONFIG_DIR from a valueless flag — only the markers every launch clears');
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
    // P12 — pair mode (rows P1–P11 below) reuses the chain: `code` missing and tiling off, paired.
    runLauncher({ workspaces: [], identity: IDENT, withCode: false, args: ['--pair-vscode'] }).plan.tile.reason,
    runLauncher({ workspaces: [], identity: IDENT, ccVscodeTile: 'off', args: ['--pair-vscode'] }).plan.tile.reason,
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

// Rows L14–L20: the title markers reach the claude child env as CC_TITLE_PREFIX / CC_TITLE_SUFFIX —
// delta-only alongside CLAUDE_CONFIG_DIR (L5 asserts the three-key shape) — so an in-session
// consumer (/identity's rename lines) can re-compose the marked title.
//
// BOTH keys are always present: the flag's value when it was given, '' otherwise. A launch is
// authoritative over the markers, so a plain `cc` in a shell that inherited a marker (a tab spawned
// from a marked session — L19) clears it rather than adopting it. The keys are unconditional by
// design, never keyed off the ambient env, so the delta a launch reports is the same in every shell;
// L19/L20 pin that by launching with a deliberately poisoned parent env.
//
// The delta stays the DELTA ONLY — a key with an empty value names something this launch sets and
// leaks nothing of the inherited environment.

test('L14 — markers without --config-dir: the env delta is exactly the two marker keys', () => {
  const { plan } = runLauncher({ workspaces: [], identity: IDENT, args: ['--title-prefix', 'P', '--title-suffix', '·s'] });
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: 'P', CC_TITLE_SUFFIX: '·s' },
    'two keys, no CLAUDE_CONFIG_DIR — delta only, never the whole env');
});

test('L15 — a one-sided marker: its own key carries the value, the other is cleared', () => {
  const pre = runLauncher({ workspaces: [], identity: IDENT, args: ['--title-prefix', 'P'] });
  assert.deepEqual(pre.plan.claude.envDelta, { CC_TITLE_PREFIX: 'P', CC_TITLE_SUFFIX: '' },
    'prefix alone → prefix set, suffix cleared');
  const suf = runLauncher({ workspaces: [], identity: IDENT, args: ['--title-suffix', '·s'] });
  assert.deepEqual(suf.plan.claude.envDelta, { CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '·s' },
    'suffix alone → suffix set, prefix cleared');
});

test('L16 — an empty-string marker value is a cleared marker, indistinguishable from an absent flag', () => {
  const { res, plan } = runLauncher({ workspaces: [], identity: IDENT, args: ['--title-prefix', ''] });
  assert.equal(res.status, 0);
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '' },
    'an explicitly empty marker clears its key, and nothing else applies');
});

test('L17 — a dangling --title-prefix is inert: stripped, marker cleared, never fatal', () => {
  const { res, plan } = runLauncher({ workspaces: [], identity: IDENT, args: ['--title-prefix'] });
  assert.equal(res.status, 0);
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '' },
    'a valueless flag adds no marker value — the keys are the cleared pair');
  assert.ok(!plan.claude.argv.includes('--title-prefix'), 'still stripped from the claude argv');
  assert.ok(plan.claude.argv.length > 0, 'claude still launches');
});

test('L18 — a non-ASCII marker round-trips into the env delta unchanged', () => {
  const glyph = '🧪';
  const { plan } = runLauncher({ workspaces: [], identity: IDENT, args: ['--title-prefix', glyph] });
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: glyph, CC_TITLE_SUFFIX: '' });
});

// L19/L20 are the regression pair for the inherited-marker bug: CC_TITLE_PREFIX / CC_TITLE_SUFFIX are
// ordinary environment variables, so a shell descended from a marked session hands them to whatever
// runs next. The launcher therefore writes both keys on EVERY launch — empty when no flag was given.
// Both launch into the SAME pre-marked parent env and differ only in whether title flags were given.
// The values are the file's generic P / ·s — this file ships in the public kit, so it carries no
// caller's naming policy; the mechanism is what is under test, not the marker text.
const INHERITED = { CC_TITLE_PREFIX: 'P', CC_TITLE_SUFFIX: '·s' };

test('L19 — a plain launch in a shell carrying inherited markers clears them (never adopts them)', () => {
  const { res, plan } = runLauncher({ workspaces: [], identity: IDENT, env: INHERITED });
  assert.equal(res.status, 0);
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: '', CC_TITLE_SUFFIX: '' },
    'both markers overwritten with empty — the child cannot read the ambient pair');
  // The same clearing shows in the title this launch composes: unmarked, exactly as in a clean shell.
  assert.equal(plan.launch.titlePrefix, '');
  assert.equal(plan.launch.titleSuffix, '');
  assert.equal(plan.launch.title, coreTitle(), 'no prefix, no suffix — the inherited pair is not read');
  for (const m of [INHERITED.CC_TITLE_PREFIX, INHERITED.CC_TITLE_SUFFIX]) {
    assert.ok(!plan.claude.argv.includes(m), `the inherited marker ${m} never reaches the claude argv`);
  }
});

test('L20 — a marked launch in that same shell still marks its session, from its FLAGS', () => {
  const core = coreTitle();
  // Deliberately different from the inherited pair, so the assertion tells "the flags were used"
  // apart from "the ambient value happened to survive".
  const { plan } = runLauncher({
    workspaces: [], identity: IDENT, env: INHERITED,
    args: ['--title-prefix', 'Q', '--title-suffix', '·q'],
  });
  assert.deepEqual(plan.claude.envDelta, { CC_TITLE_PREFIX: 'Q', CC_TITLE_SUFFIX: '·q' },
    'the flags win over the inherited pair — exported for the in-session title consumer');
  assert.equal(plan.launch.title, `Q ${core} ·q`, 'and the composed title carries both');
});

// --- /color injection vs optional-value flags (rows C1–C12) --------------------------------------
// Spec: .claude/plans/2026-08-16-launcher-and-settings-hygiene-spec.md §1 (A1–A4). Claude Code's
// commander gives an OPTIONAL-value flag (`--resume [value]`, …) the next argv token as its value
// iff one follows and does not start with '-'. So a bare `cc --resume` must NOT get "/color …"
// appended — claude would read the colour as a session id. Asserted through the same dry-run seam:
// `plan.claude.argv` IS the argv the live path spawns.

const argvFor = (args) => runLauncher({ workspaces: [], identity: IDENT, args }).plan.claude.argv;
const COLOR = `/color ${IDENT.color}`;
const hasColor = (argv) => argv.some((a) => String(a).startsWith('/color'));

test('C1 — bare `cc`: the last token is `/color <colour>` (A2)', () => {
  const argv = argvFor([]);
  assert.equal(argv.at(-1), COLOR);
});

test('C2 — `cc --resume` (bare = picker): argv ends with --resume, no /color anywhere (A1)', () => {
  const argv = argvFor(['--resume']);
  assert.equal(argv.at(-1), '--resume');
  assert.ok(!hasColor(argv), `no /color: ${argv.join(' ')}`);
});

test('C3 — `cc -r` (short bare form): no /color', () => {
  const argv = argvFor(['-r']);
  assert.equal(argv.at(-1), '-r');
  assert.ok(!hasColor(argv));
});

test('C4 — `cc -r <id>`: the id stays the flag\'s value and /color follows as the prompt (A3)', () => {
  const argv = argvFor(['-r', '0f3a']);
  assert.deepEqual(argv.slice(-3), ['-r', '0f3a', COLOR]);
});

test('C5 — `cc --resume=<id>` (value glued with `=` is not bare): /color injected', () => {
  const argv = argvFor(['--resume=0f3a']);
  assert.deepEqual(argv.slice(-2), ['--resume=0f3a', COLOR]);
});

test('C6 — `cc "do X"`: the user prompt is the last token, no /color (A4)', () => {
  const argv = argvFor(['do X']);
  assert.equal(argv.at(-1), 'do X');
  assert.ok(!hasColor(argv));
});

test('C7 — `cc --chrome` (boolean flag): still self-colours', () => {
  const argv = argvFor(['--chrome']);
  assert.deepEqual(argv.slice(-2), ['--chrome', COLOR]);
});

test('C8 — bare `--debug` / `--teleport` / `--cloud`: no /color (each is an optional-value flag)', () => {
  for (const f of ['--debug', '--teleport', '--cloud', '-d']) {
    const argv = argvFor([f]);
    assert.equal(argv.at(-1), f, `${f} stays last`);
    assert.ok(!hasColor(argv), `${f}: no /color injected`);
  }
});

test('C9 — `cc -w feat` (optional flag WITH a value): /color injected as the prompt', () => {
  const argv = argvFor(['-w', 'feat']);
  assert.deepEqual(argv.slice(-3), ['-w', 'feat', COLOR]);
});

test('C10 — a bare optional flag followed by another flag: the flag is not its value; injection follows the LAST arg', () => {
  // `--resume --chrome`: --resume is bare (next token starts with '-'), but the last arg is a boolean
  // flag, so the picker is not the prompt slot — /color is injected. Mirrors commander exactly.
  assert.deepEqual(argvFor(['--resume', '--chrome']).slice(-3), ['--resume', '--chrome', COLOR]);
  // `--chrome --resume`: last arg is bare optional → nothing injected.
  const argv = argvFor(['--chrome', '--resume']);
  assert.equal(argv.at(-1), '--resume');
  assert.ok(!hasColor(argv));
});

test('C11 — a real prompt after an optional flag is never clobbered', () => {
  const argv = argvFor(['-r', '0f3a', 'do X']);
  assert.equal(argv.at(-1), 'do X');
  assert.ok(!hasColor(argv));
});

test('C12 — OPTIONAL_VALUE_FLAGS carries exactly the optional-value flags of `claude --help` (2.1.251; set unchanged since 2.1.233)', () => {
  const src = readFileSync(launcher, 'utf8');
  const m = src.match(/const OPTIONAL_VALUE_FLAGS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'OPTIONAL_VALUE_FLAGS literal found');
  const flags = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(flags, ['--cloud', '--debug', '--from-pr', '--prompt-suggestions', '--remote-control',
    '--resume', '--teleport', '--worktree', '-d', '-r', '-w'].sort());
  // Public file: zero deps, zero private references (the launcher ships in the kit).
  assert.ok(!/from\s+['"](?!node:)/.test(src), 'no non-builtin imports');
});

// --- pair mode (rows P1–P14) ---------------------------------------------------------------------
// Test plan: docs/260908-vscode-pair-test-plan.md Part 3. `--pair-vscode` runs the EXISTING VS Code
// co-launch + tiler against process.cwd() and exits 0 without launching claude — the machinery a
// running session uses to get its editor back (the /vscode command). Asserted through the same
// dry-run seam: `plan.launch.mode` says 'pair' or 'launch', `plan.claude.argv` is empty in pair
// mode, and the tile block gains `captureMethod: 'parent-walk'` (fallback 'foreground-sync'),
// `terminalPid`, and `wait` (pair mode waits for the tiler instead of unref'ing it).

const PAIR = ['--pair-vscode'];
const oneLine = (s) => s.trim().length > 0 && s.trim().split('\n').length === 1;

test('P1 — pair mode with CC_VSCODE unset: VS Code on, plan says pair, claude not launched', () => {
  const { res, plan } = runLauncher({ workspaces: [], identity: IDENT, ccVscode: null, args: PAIR });
  assert.equal(res.status, 0);
  assert.equal(plan.launch.mode, 'pair');
  assert.equal(plan.vscode.action, 'folder');
  assert.equal(plan.vscode.target, '.', 'cwd, exactly as at launch');
  assert.deepEqual(plan.claude.argv, [], 'nothing is launched');
  assert.ok(oneLine(res.stdout), 'stdout is exactly one line of JSON');
  assert.equal(res.stderr, '');
});

test('P2 — pair mode with CC_VSCODE=0: the flag wins over the env', () => {
  const { plan } = runLauncher({ workspaces: [], identity: IDENT, ccVscode: '0', args: PAIR });
  assert.equal(plan.launch.mode, 'pair');
  assert.equal(plan.vscode.action, 'folder');
});

test('P3 — a normal launch reports mode launch, still launches claude, still captures by foreground (T1 unchanged)', () => {
  const { plan } = runLauncher({ workspaces: [], identity: IDENT });
  assert.equal(plan.launch.mode, 'launch');
  assert.ok(plan.claude.argv.length > 0);
  assert.equal(plan.tile.captureMethod, 'foreground-sync');
});

test('P4 — `--pair-vscode --no-vscode` is a usage error: non-zero, one stderr line naming both, no plan', () => {
  let ref = null;
  for (const dryRun of [true, false]) {
    for (const args of [['--pair-vscode', '--no-vscode'], ['--no-vscode', '--pair-vscode']]) {
      const { res } = runLauncher({ workspaces: [], identity: IDENT, dryRun, args });
      const label = `${args.join(' ')} dryRun=${dryRun}`;
      assert.notEqual(res.status, 0, `${label}: exits non-zero`);
      assert.equal(res.stdout, '', `${label}: no plan, even under dry-run`);
      assert.ok(oneLine(res.stderr), `${label}: exactly one stderr line, got ${JSON.stringify(res.stderr)}`);
      assert.ok(res.stderr.includes('--pair-vscode') && res.stderr.includes('--no-vscode'), `${label}: names both flags`);
      if (ref === null) ref = res.stderr; else assert.equal(res.stderr, ref, `${label}: byte-identical across orderings`);
    }
  }
});

test('P5 — `code` missing in pair mode: vscode-no-cli in the plan; live path exits non-zero with one line', () => {
  const dry = runLauncher({ workspaces: [], identity: IDENT, withCode: false, args: PAIR });
  assert.equal(dry.plan.vscode.action, 'skip-no-cli');
  assert.equal(dry.plan.tile.reason, IS_WIN ? 'vscode-no-cli' : 'not-win32');
  // Live half is safe: with no `code` nothing can spawn (tiling is gated on vsPlan.exe).
  const live = runLauncher({ workspaces: [], identity: IDENT, withCode: false, dryRun: false, args: PAIR });
  assert.notEqual(live.res.status, 0);
  assert.equal(live.res.stdout, '');
  assert.ok(oneLine(live.res.stderr), `one stderr line, got ${JSON.stringify(live.res.stderr)}`);
  assert.ok(live.res.stderr.includes('vscode-no-cli'), 'the existing reason names the failure');
});

test('P6 — exactly one .code-workspace in the cwd: pair mode opens the workspace (H1 reused)', () => {
  const { plan } = runLauncher({ workspaces: ['proj.code-workspace'], identity: IDENT, args: PAIR });
  assert.equal(plan.launch.mode, 'pair');
  assert.equal(plan.vscode.action, 'workspace');
  assert.equal(plan.vscode.target, 'proj.code-workspace');
  assert.equal(plan.tile.projectMatch, 'proj');
});

test('P7 — CC_VSCODE_TILE=off in pair mode: VS Code on, tiling off by flag', () => {
  const { plan } = runLauncher({ workspaces: [], identity: IDENT, ccVscodeTile: 'off', args: PAIR });
  assert.equal(plan.launch.mode, 'pair');
  assert.equal(plan.vscode.action, 'folder');
  assert.equal(plan.tile.enabled, false);
  assert.equal(plan.tile.reason, IS_WIN ? 'disabled-flag' : 'not-win32');
});

// --- the terminal-window resolver (the parent-process walk), rows P8a–P8f -----------------------
// The walk cannot run against a real process tree from a test (our ancestry is node → node --test,
// never WindowsTerminal.exe), so it is a pure function over a process table, reached through the
// dry-run seam: CC_LAUNCH_PROCTABLE names a JSON file of [{pid, ppid, name}] and CC_LAUNCH_PROCPID
// is the start pid. Both are honoured only under CC_LAUNCH_DRYRUN. The tables live here rather than
// as checked-in files: the exporter copies fixtures one by one, and an inline table travels with
// this public suite by construction. Synthetic pids (1000–9999) can never be mistaken for real ones.
const P = (pid, ppid, name) => ({ pid, ppid, name });
const CHAIN_TAIL = [P(4100, 1200, 'WindowsTerminal.exe'), P(1200, 0, 'explorer.exe')];
const PROCTABLES = {
  'chain-found': [P(9001, 8002, 'node.exe'), P(8002, 7003, 'pwsh.exe'), P(7003, 6004, 'claude.exe'), P(6004, 4100, 'pwsh.exe'), ...CHAIN_TAIL],
  'chain-no-wt': [P(9001, 8002, 'node.exe'), P(8002, 7003, 'pwsh.exe'), P(7003, 6004, 'claude.exe'), P(6004, 4100, 'pwsh.exe'), P(4100, 1200, 'conhost.exe'), P(1200, 0, 'explorer.exe')],
  'chain-broken': [P(9001, 8002, 'node.exe'), P(8002, 7003, 'pwsh.exe'), P(7003, 5555, 'claude.exe'), ...CHAIN_TAIL],   // 5555 is absent
  'chain-cycle': [P(9001, 8002, 'node.exe'), P(8002, 9001, 'pwsh.exe'), ...CHAIN_TAIL],
  'chain-lower': [P(9001, 8002, 'node.exe'), P(8002, 4100, 'pwsh.exe'), P(4100, 1200, 'windowsterminal.exe'), P(1200, 0, 'explorer.exe')],
  'chain-near-miss': [P(9001, 8002, 'node.exe'), P(8002, 4100, 'pwsh.exe'), P(4100, 1200, 'notWindowsTerminal.exe'), P(1200, 0, 'explorer.exe')],
};

// Writes the named table to a temp file and runs the launcher with the seam pointed at it.
function runWalk(name, { pair = true, startPid = 9001 } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ccl-proc-'));
  try {
    const file = join(d, `${name}.json`);
    writeFileSync(file, JSON.stringify(PROCTABLES[name]), 'utf8');
    return runLauncher({
      workspaces: [], identity: IDENT, args: pair ? PAIR : [],
      env: { CC_LAUNCH_PROCTABLE: file, CC_LAUNCH_PROCPID: String(startPid) },
    });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test('P8a — the chain reaches Windows Terminal: parent-walk, its pid reported', () => {
  const { res, plan } = runWalk('chain-found');
  assert.equal(res.status, 0);
  assert.equal(plan.tile.captureMethod, 'parent-walk');
  assert.equal(plan.tile.terminalPid, 4100);
});

test('P8b — the chain ends at the root without Windows Terminal: foreground fallback, no pid', () => {
  const { plan } = runWalk('chain-no-wt');
  assert.equal(plan.tile.captureMethod, 'foreground-sync');
  assert.equal(plan.tile.terminalPid, null);
});

test('P8c — a broken link (ppid absent from the table): fallback, no throw', () => {
  const { res, plan } = runWalk('chain-broken');
  assert.equal(res.status, 0);
  assert.equal(plan.tile.captureMethod, 'foreground-sync');
  assert.equal(plan.tile.terminalPid, null);
});

test('P8d — a cycle (a → b → a): the walk terminates and falls back', () => {
  const { res, plan } = runWalk('chain-cycle');
  assert.equal(res.status, 0, 'no hang, no throw');
  assert.equal(plan.tile.captureMethod, 'foreground-sync');
  assert.equal(plan.tile.terminalPid, null);
});

test('P8e — the process name matches case-insensitively and by whole basename only', () => {
  assert.equal(runWalk('chain-found').plan.tile.terminalPid, 4100, 'WindowsTerminal.exe');
  assert.equal(runWalk('chain-lower').plan.tile.terminalPid, 4100, 'windowsterminal.exe');
  const near = runWalk('chain-near-miss').plan.tile;
  assert.equal(near.terminalPid, null, 'notWindowsTerminal.exe is not a match');
  assert.equal(near.captureMethod, 'foreground-sync');
});

test('P8f — a normal launch never reads the table: the seam is inert outside pair mode', () => {
  const { plan } = runWalk('chain-found', { pair: false });
  assert.equal(plan.tile.captureMethod, 'foreground-sync');
  assert.ok(!('terminalPid' in plan.tile), 'no terminalPid key at all — distinct from P8b\'s null');
});

// --- behaviour the dry-run cannot reach: structural rows (the T6/H6 pattern) ----------------------

test('P9 — pair mode does not require `claude` on PATH; a launch still does', () => {
  const pair = runLauncher({ workspaces: [], identity: IDENT, withClaude: false, args: PAIR });
  assert.equal(pair.res.status, 0, `pair mode without claude: ${pair.res.stderr}`);
  assert.equal(pair.plan.launch.mode, 'pair');
  const launch = runLauncher({ workspaces: [], identity: IDENT, withClaude: false });
  assert.equal(launch.res.status, 1, 'launch mode without claude still exits 1');
  assert.match(launch.res.stderr, /claude executable not found/);
});

test('P10 — pair mode keeps the snap gesture, focus ending on the terminal (one tiler serves both modes)', () => {
  const { plan } = runLauncher({ workspaces: [], identity: IDENT, args: PAIR });
  assert.equal(plan.tile.snapGroup, true);
  // T6's order assertions are the other half of this row and run unchanged above.
  const src = readFileSync(launcher, 'utf8');
  assert.equal((src.match(/SnapKey 0x27/g) || []).length, 1, 'one snap-right site — no pair-only variant of the gesture');
});

test('P11 — pair mode WAITS for the tiler (never unref\'d, never detached); launch mode does not', () => {
  const pair = runLauncher({ workspaces: [], identity: IDENT, args: PAIR }).plan;
  const launch = runLauncher({ workspaces: [], identity: IDENT }).plan;
  assert.equal(pair.tile.wait, true);
  assert.equal(launch.tile.wait, false);
  const src = readFileSync(launcher, 'utf8');
  // A synchronous spawn of the tiler exists, with a timeout bound (its exact value is the developer's;
  // it must be at least the poll deadline plus slack, so a hung tiler cannot hang /vscode forever).
  const sync = src.match(/spawnSync\(\s*'powershell\.exe'\s*,\s*psArgs\(tilerScript\([\s\S]*?\)\s*;/);
  assert.ok(sync, 'a spawnSync of the tiler script exists (the pair-mode wait)');
  assert.match(sync[0], /timeout\s*:/, 'the wait is bounded by a timeout');
  const lit = sync[0].match(/timeout\s*:\s*(\d+)/);
  if (lit) assert.ok(Number(lit[1]) >= pair.tile.pollMs + 2000, `literal timeout ${lit[1]} ≥ pollMs + 2000`);
  else assert.match(sync[0], /pollMs/, 'a non-literal timeout is expressed in terms of the poll deadline');
  // The memory-recorded trap: DETACHED_PROCESS gives powershell.exe no console; the opts stay as they are.
  assert.match(src, /const TILE_SPAWN_OPTS = \{ stdio: 'ignore', windowsHide: true \};/);
});

// The doc is private-repo only. The skip keys on the CHECKOUT, not on the doc: the kit ships neither
// the exporter nor SPEC.md, so the exporter's absence says "this is the public kit", whereas a bare
// existsSync on the doc could not tell the kit from a deletion. In the private repo a missing doc is
// a build gap and fails the row (docs/260908-suite-skip-guards-spec.md §2, §4).
const IN_PUBLIC_KIT = !existsSync(join(here, '..', 'tools', 'export-public.mjs'));
const DOC = join(here, '..', 'docs', 'cc-launcher.md');
test('P14 — the flag and the command are documented in docs/cc-launcher.md, in one section', { skip: IN_PUBLIC_KIT ? 'public kit checkout: the private docs do not ship' : false }, () => {
  assert.ok(existsSync(DOC), 'docs/cc-launcher.md exists in the private repo');
  const doc = readFileSync(DOC, 'utf8');
  assert.ok(doc.includes('--pair-vscode'), 'the flag is documented');
  assert.ok(doc.includes('/vscode'), 'the command is documented');
  const sections = doc.split(/^## /m);
  assert.ok(sections.some((s) => s.includes('--pair-vscode') && s.includes('/vscode')),
    'one ## section mentions both the flag and the command');
});

// The inline PowerShell the launcher emits, bounded by `tilerScript`'s own body. Several rows below
// count keystrokes inside it, and counting them over the whole module would fold in the launcher's
// own ANSI constants and its prose.
function tilerSource(src) {
  const at = src.indexOf('function tilerScript(');
  assert.ok(at > 0, 'home/claude-launch.mjs must declare tilerScript() — it is the script whose keystrokes these rows count');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('tilerScript body is unbalanced');
}

// --- P15–P18: the guarded Esc, the result readback, and the trace encoding -------------------------
// 2026-09-09 suite-integrity sprint §6. Three findings from the pair-mode G2.5 pass land here:
// the tiler's Snap Assist dismissal must be guarded, the reported `tile` value must be the tiler's
// own account of what happened rather than the fact it was spawned, and the tiler's trace must
// round-trip the session's identity emoji.

test('P15 — the tiler sends exactly ONE Esc, and only after finding the foreground is neither window', () => {
  // WHY THE GUARD IS NOT OPTIONAL, AND WHY THIS IS A ROW RATHER THAN A COMMENT. The left half hosts a
  // LIVE CLAUDE CODE SESSION. An Esc delivered there interrupts whatever the user was typing — so an
  // unguarded second Esc, added later by someone reasoning only about Snap Assist, is a defect that
  // no window-free test can otherwise see. The Esc exists at all because the first snap raises the
  // Snap Assist picker, which then holds the keyboard: without the dismissal the terminal's own snap
  // never lands and the next keystroke goes to a window picker for up to about two minutes.
  const src = readFileSync(launcher, 'utf8');
  const tiler = tilerSource(src);

  // VK_ESCAPE IS COUNTED BY ITS BYTE, ANYWHERE IN THE TILER — not by the variable the current build
  // happens to hold it in, and not by the word "Esc", which appears in prose and in the launcher's
  // own ANSI `ESC` constant. `$esc2 = [byte]0x1B` beside the first one is the shape a second,
  // unguarded dismissal actually takes, and a needle keyed on `$esc` would not see it.
  const escBytes = [...tiler.matchAll(/0x1B\b/gi)];
  assert.equal(escBytes.length, 1,
    `VK_ESCAPE (0x1B) appears ${escBytes.length} times in the tiler script — exactly one Esc site may exist, because a second one is a second chance to interrupt the live Claude session in the left half`);

  // And that one site is reached only from a foreground read that found NEITHER window. The guard is
  // read as a span: the `GetForegroundWindow()` call, both comparands, and the keystroke, in order,
  // inside one enclosing block.
  const guard = src.match(/\$fgNow\s*=\s*\[CCW\]::GetForegroundWindow\(\)[\s\S]{0,400}?keybd_event\(\s*\$esc/);
  assert.ok(guard, 'the Esc must be preceded by a GetForegroundWindow() read in the same block — an unconditional Esc lands in the live Claude session');
  assert.match(guard[0], /\$term/, '…and the read must be compared against the TERMINAL handle');
  assert.match(guard[0], /\$code/, '…and against the VS CODE handle — the Esc fires only when the foreground is neither');
});

// The six result fixtures of the test plan, plus the four degradation cases the developer drove
// through the real launcher. The key names are the seam's, read from home/claude-launch.mjs and not
// invented here: `terminal` / `vscode`, each { found, placed, snapped }, plus `foreground`.
const TILE_FIXTURES = [
  ['R-tiled', { v: 1, terminal: { found: true, placed: true, snapped: true }, vscode: { found: true, placed: true, snapped: true }, foreground: 'terminal' }, 'tiled', 'terminal'],
  ['R-nogroup', { v: 1, terminal: { found: true, placed: true, snapped: false }, vscode: { found: true, placed: true, snapped: true }, foreground: 'terminal' }, 'tiled-no-group', 'terminal'],
  ['R-novs', { v: 1, terminal: { found: true, placed: true, snapped: true }, vscode: { found: false, placed: false, snapped: false }, foreground: 'terminal' }, 'no-vscode-window', 'terminal'],
  ['R-noterm', { v: 1, terminal: { found: false, placed: false, snapped: false }, vscode: { found: true, placed: true, snapped: true }, foreground: 'other' }, 'no-terminal-window', 'other'],
  ['R-focus', { v: 1, terminal: { found: true, placed: true, snapped: true }, vscode: { found: true, placed: true, snapped: true }, foreground: 'vscode' }, 'tiled', 'other'],
  ['R-notplaced', { v: 1, terminal: { found: true, placed: false, snapped: false }, vscode: { found: true, placed: true, snapped: true }, foreground: 'terminal' }, 'unknown', 'terminal'],
];

// The degradation set: nothing here is a result, and every one of them must report `unknown` rather
// than the `tiled` the old `tile:"on"` reported for a tiler that timed out or died.
const TILE_DEGRADED = [
  ['R-missing (no file at the named path)', null],
  ['unparsable bytes', '{"terminal":'],
  ['an empty file', ''],
  ['a JSON array', '[]'],
  ['an object with `found` but no per-window objects', '{"v":1,"found":true}'],
  ['a per-window object whose `found` is not a boolean', '{"v":1,"terminal":{"found":"yes"},"vscode":{"found":true}}'],
];

function pairSummary(fakePath) {
  const { res } = runLauncher({
    workspaces: [], identity: IDENT, dryRun: false, args: PAIR,
    env: { CC_TILE_FAKE_RESULT: fakePath },
  });
  assert.equal(res.status, 0, `pair run exited ${res.status}: ${res.stderr}`);
  assert.ok(oneLine(res.stdout), `the pair summary is exactly one line of JSON (got: ${JSON.stringify(res.stdout)})`);
  return JSON.parse(res.stdout.trim());
}

test('P16 — the reported `tile` is the TILER\'S OWN ACCOUNT of what happened, driven through CC_TILE_FAKE_RESULT', () => {
  // WHAT THIS REPLACES. `tile:"on"` meant "the tiler was spawned". The tiler's no-op returns (no VS
  // Code window, no terminal window) and a spawnSync timeout were all invisible in it, and
  // home/commands/vscode.md turned that value into the word "tiled" — so a run whose terminal snap
  // had failed reported a snap group that was not there. The seam is the only way to cover the
  // mapping offline: it needs no window, no platform and no keystroke.
  const dir = mkdtempSync(join(tmpdir(), 'ccl-tile-'));
  try {
    for (const [name, payload, tile, focus] of TILE_FIXTURES) {
      const p = join(dir, `${name}.json`);
      writeFileSync(p, JSON.stringify(payload), 'utf8');
      const s = pairSummary(p);
      assert.equal(s.tile, tile, `${name}: tile`);
      assert.equal(s.focus, focus, `${name}: focus — the OS's answer to "who gets the next keystroke", which is what acceptance example A1 promises`);
      assert.equal(s.mode, 'pair', `${name}: still a pair summary`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P17 — a result that is absent, truncated or malformed reports `unknown` — never a tiling that succeeded', () => {
  // THE FIXTURE THAT MATTERS MOST is the missing file: that is the timed-out or dead tiler, which is
  // exactly the case that reported `tiled` before this sprint. The rest pin the DIRECTION of the
  // degradation: only a literal `true` counts as a claim, so a half-written result can make a
  // SMALLER claim and never a larger one.
  const dir = mkdtempSync(join(tmpdir(), 'ccl-degr-'));
  try {
    for (const [what, bytes] of TILE_DEGRADED) {
      const p = join(dir, 'result.json');
      rmSync(p, { force: true });
      if (bytes !== null) writeFileSync(p, bytes, 'utf8');
      const s = pairSummary(p);
      assert.equal(s.tile, 'unknown', `${what}: reports unknown`);
      assert.equal(s.focus, 'other', `${what}: and claims nothing about focus either`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P18 — no `on` literal survives in the pair summary, and the trace is written BOM-less UTF-8', () => {
  const src = readFileSync(launcher, 'utf8');

  // (a) THE RETIRED VALUE. `tile: 'on'` is what "the tiling code ran" was spelled as; the vocabulary
  //     is now what the arrangement became. A literal `'on'` in a tile position would mean the old
  //     report survived somewhere alongside the new one.
  assert.ok(!/tile\s*:\s*['"]on['"]/.test(src),
    "home/claude-launch.mjs still writes `tile: 'on'` somewhere — the summary reports what the arrangement BECAME, not that the tiler was started");

  // (b) THE TRACE ENCODING. The tiler runs under powershell.exe — Windows PowerShell 5.1 — whose
  //     Add-Content default is the ANSI code page. A session title carries a colour emoji and a
  //     separator glyph, and every non-ASCII character in it reached the trace file as a question
  //     mark or a replacement character — which makes the trace useless for identifying WHICH
  //     session a line came from, and identifying the session is what the trace is read for. The
  //     launcher's own appendFileSync writes BOM-less UTF-8 to the SAME file, so the tiler has to
  //     match it. `-Encoding utf8` is not the fix: PowerShell 5.1 writes a BOM with it, mid-file, in
  //     a log two processes append to.
  const dbg = src.match(/function Dbg\(\$m\)\{[\s\S]{0,400}?\n/);
  assert.ok(dbg, 'the tiler defines a Dbg trace function');
  assert.match(dbg[0], /\[IO\.File\]::AppendAllText\(/,
    'the tiler\'s Dbg must write through [IO.File]::AppendAllText — a bare Add-Content writes the ANSI code page and mangles the identity emoji the trace is read for');
  assert.match(dbg[0], /\[Text\.UTF8Encoding\]::new\(\$false\)/,
    '…with a BOM-LESS UTF8Encoding, matching what the launcher\'s own appendFileSync writes to the same file');
  assert.ok(!/-Encoding\s+utf8/i.test(dbg[0]),
    "…and never `-Encoding utf8`, which on PowerShell 5.1 writes a BOM in the middle of a file two processes append to");
});