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
function runLauncher({ workspaces = [], withCode = true, ccVscode = '1' }) {
  const proj = mkdtempSync(join(tmpdir(), 'ccl-proj-'));
  const shims = makeShims({ withCode });
  try {
    for (const w of workspaces) writeFileSync(join(proj, w), '{}', 'utf8');
    const env = {
      PATH: shims,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      CC_LAUNCH_DRYRUN: '1',
      ...(ccVscode === null ? {} : { CC_VSCODE: ccVscode }),
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
