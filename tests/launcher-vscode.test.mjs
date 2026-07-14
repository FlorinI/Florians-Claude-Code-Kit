import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
function runLauncher({ workspaces = [], withCode = true, ccVscode = '1', ccVscodeTile = null }) {
  const proj = mkdtempSync(join(tmpdir(), 'ccl-proj-'));
  const shims = makeShims({ withCode });
  try {
    for (const w of workspaces) writeFileSync(join(proj, w), '{}', 'utf8');
    const env = {
      PATH: shims,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      CC_LAUNCH_DRYRUN: '1',
      ...(ccVscode === null ? {} : { CC_VSCODE: ccVscode }),
      ...(ccVscodeTile === null ? {} : { CC_VSCODE_TILE: ccVscodeTile }),
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
      TEMP: process.env.TEMP, TMP: process.env.TMP,
    };
    const res = spawnSync(process.execPath, [launcher], { cwd: proj, env, encoding: 'utf8' });
    return { res, plan: res.stdout.trim() ? JSON.parse(res.stdout.trim().split('\n').pop()) : null };
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
