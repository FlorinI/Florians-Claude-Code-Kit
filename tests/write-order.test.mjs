import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, chmodSync, renameSync,
} from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// write-order (row F3) — the sidecar snapshot is written in two phases: phase 1 BEFORE the git
// subprocess cluster (gitRepo = the PREVIOUS snapshot's value), phase 2 after it refreshes
// gitRepo off the live git read (seeding the chain; carries the last-known value when git fails).
//
// Platform split: the ordering proof instruments `git` with a PATH shim that records whether the
// sidecar already exists when git runs. Node's child_process cannot spawn .cmd/.bat shims without
// a shell (CVE-2024-27980), so the shim test runs on POSIX only (public CI: ubuntu + macos);
// Windows keeps the gitRepo-reuse proof here plus the source-order invariant in
// source-invariants.test.mjs (statusline.mjs is a top-to-bottom script, so source order is
// execution order).

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, '..', 'home', 'statusline.mjs');
const NOW = 1781750000;

function setupDirs() {
  const home = mkdtempSync(join(tmpdir(), 'wo-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'wo-cwd-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  return { home, cwd };
}
const stdinFor = (cwd) => JSON.stringify({
  model: { display_name: 'Fable 5 (1M context)' },
  version: '2.1.142', effort: { level: 'high' },
  context_window: { used_percentage: 3, total_input_tokens: 8000, context_window_size: 1000000 },
  transcript_path: join(cwd, 'nope.jsonl'), session_id: 'wo-1',
  cost: { total_cost_usd: 0.4, total_api_duration_ms: 5000 },
  workspace: { current_dir: cwd }, rate_limits: {},
});

test('F3 — sidecar gitRepo reuses the previous snapshot value, not a fresh git read', () => {
  const { home, cwd } = setupDirs();
  try {
    const sidecar = join(cwd, '.claude', 'statusline-last.json');
    writeFileSync(sidecar, JSON.stringify({ gitRepo: 'seeded/repo@main' }), 'utf8');
    execFileSync(process.execPath, [engine], {
      input: stdinFor(cwd),
      // CLAUDE_CONFIG_DIR is pinned POSITIVELY (never deleted) so the child's user-level state stays
      // inside the temp home even when this suite is launched from a second-subscription session.
      env: { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW) },
      maxBuffer: 64 * 1024 * 1024,
    });
    const snap = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(snap.gitRepo, 'seeded/repo@main', 'gitRepo must carry the previous snapshot value');
    assert.equal(snap.sessionId, 'wo-1', 'snapshot otherwise refreshed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('F3 — instrumented order: git shim sees the sidecar already on disk', { skip: process.platform === 'win32' ? 'POSIX-only shim (Node cannot spawn .cmd shims shell-less); Windows is covered by the source-order invariant' : false }, () => {
  const { home, cwd } = setupDirs();
  const shimDir = mkdtempSync(join(tmpdir(), 'wo-shim-'));
  try {
    const sidecar = join(cwd, '.claude', 'statusline-last.json');
    const marker = join(shimDir, 'marker.log');
    const shim = join(shimDir, 'git');
    writeFileSync(shim, `#!/bin/sh\nif [ -e "$SL_TEST_SIDECAR" ]; then echo yes >> "$SL_TEST_MARKER"; else echo no >> "$SL_TEST_MARKER"; fi\nexit 1\n`, 'utf8');
    chmodSync(shim, 0o755);
    execFileSync(process.execPath, [engine], {
      input: stdinFor(cwd),
      env: {
        ...process.env,
        PATH: shimDir + delimiter + (process.env.PATH || ''),
        USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW),
        SL_TEST_SIDECAR: sidecar, SL_TEST_MARKER: marker,
      },
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.ok(existsSync(marker), 'vacuity guard: the git shim must actually have run');
    const seen = readFileSync(marker, 'utf8').trim().split('\n');
    assert.ok(seen.length >= 1);
    for (const line of seen) assert.equal(line, 'yes', 'sidecar must exist before every git call');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  }
});

// gitRepo seeding (ticket 2026-07-14-gitrepo-chain-never-seeded) — the phase-2 write must
// PRODUCE the value the phase-1 carry-forward reuses: without it the chain only ever copies
// itself (fresh projects null forever, existing ones frozen at a pre-4.3.0.0 relic). Needs a
// real `git` on PATH (present on all three public-CI images); skipped when git is unavailable.
function haveGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
function git(cwd, args) {
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
}

test('gitRepo — render 1 in a real repo SEEDS the live slug; a branch switch propagates; broken git carries previous', { skip: haveGit() ? false : 'git not on PATH' }, () => {
  const { home, cwd } = setupDirs();
  try {
    git(cwd, ['init', '-b', 'main']);
    git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/widgets.git']);
    git(cwd, ['commit', '--allow-empty', '-m', 'x']);
    const sidecar = join(cwd, '.claude', 'statusline-last.json');
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW) };
    const render = () => {
      execFileSync(process.execPath, [engine], { input: stdinFor(cwd), env, maxBuffer: 64 * 1024 * 1024 });
      return JSON.parse(readFileSync(sidecar, 'utf8'));
    };

    // Render 1 (no prior sidecar): the phase-2 write seeds the LIVE slug — never null.
    assert.equal(render().gitRepo, 'acme/widgets@main', 'first render must seed the live repo slug');

    // Render 2 after a branch change: the identity follows the live git state.
    git(cwd, ['checkout', '-b', 'feature']);
    assert.equal(render().gitRepo, 'acme/widgets@feature', 'a branch switch must propagate');

    // Broken .git: the render still succeeds and the identity carries the last-known value.
    renameSync(join(cwd, '.git'), join(cwd, '.git-off'));
    const snap = render();
    assert.equal(snap.gitRepo, 'acme/widgets@feature', 'broken git must carry the previous value, not decay to null');
    assert.equal(snap.sessionId, 'wo-1', 'snapshot otherwise refreshed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
