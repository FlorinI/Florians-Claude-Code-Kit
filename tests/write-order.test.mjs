import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, chmodSync, renameSync,
  readdirSync, statSync, utimesSync, unlinkSync,
} from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// write-order (row F3) — the sidecar snapshot is written in two phases: phase 1 BEFORE the git
// subprocess cluster (gitRepo = the PREVIOUS snapshot's value), phase 2 after it refreshes
// gitRepo off the live git read (seeding the chain; carries the last-known value when git fails).
//
// The snapshot is one file per session, beside the rollup: <cwd>/.claude/statusline-stats/
// <session_id>.sidecar.json, or <config home>/statusline-stats/<session_id>.sidecar.json when the
// payload has no cwd. Nothing is written to statusline-last.json any more (rows M1/M2 below, the
// idle-session CPU fix: Claude Code watches <config home> and <cwd>/.claude one level deep, and a
// write there woke every session watching them).
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
const SID = 'wo-1';

function setupDirs() {
  const home = mkdtempSync(join(tmpdir(), 'wo-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'wo-cwd-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  return { home, cwd };
}
// The per-session snapshot, in the project and in the config home.
const projSidecar = (cwd, sid = SID) => join(cwd, '.claude', 'statusline-stats', `${sid}.sidecar.json`);
const homeSidecar = (home, sid = SID) => join(home, '.claude', 'statusline-stats', `${sid}.sidecar.json`);
const stdinFor = (cwd, patch) => {
  const s = {
    model: { display_name: 'Fable 5 (1M context)' },
    version: '2.1.142', effort: { level: 'high' },
    context_window: { used_percentage: 3, total_input_tokens: 8000, context_window_size: 1000000 },
    transcript_path: join(cwd, 'nope.jsonl'), session_id: SID,
    cost: { total_cost_usd: 0.4, total_api_duration_ms: 5000 },
    workspace: { current_dir: cwd }, rate_limits: {},
  };
  if (patch) patch(s);
  return JSON.stringify(s);
};
// CLAUDE_CONFIG_DIR is pinned POSITIVELY (never deleted) so the child's user-level state stays
// inside the temp home even when this suite is launched from a second-subscription session.
const envFor = (home, cwd, now = NOW, extra = {}) => {
  const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(now), CLAUDE_SL_DIALOGUE_PROBE: 'off' };
  delete env.CC_QUOTA_PROBE;
  return Object.assign(env, extra);
};
const renderIn = (home, cwd, { now = NOW, patch, extra } = {}) => execFileSync(process.execPath, [engine], {
  input: stdinFor(cwd, patch), env: envFor(home, cwd, now, extra), maxBuffer: 64 * 1024 * 1024,
}).toString('utf8');

// Every file under `root` whose name satisfies `pred`, recursively.
function findNamed(root, pred) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (pred(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

// Write detection: pin the file's mtime to a moment the render cannot produce (T−1000 on the frozen
// clock; a real write stamps the machine's wall clock), then ask whether it moved.
const MARK = NOW - 1000;
const mark = (p) => utimesSync(p, MARK, MARK);
const wasWritten = (p) => Math.round(statSync(p).mtimeMs / 1000) !== MARK;

test('F3 — sidecar gitRepo reuses the previous snapshot value, not a fresh git read', () => {
  const { home, cwd } = setupDirs();
  try {
    const sidecar = projSidecar(cwd);
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, JSON.stringify({ gitRepo: 'seeded/repo@main' }), 'utf8');
    renderIn(home, cwd);
    const snap = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(snap.gitRepo, 'seeded/repo@main', 'gitRepo must carry the previous snapshot value');
    assert.equal(snap.sessionId, SID, 'snapshot otherwise refreshed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('F3 — instrumented order: git shim sees the sidecar already on disk', { skip: process.platform === 'win32' ? 'POSIX-only shim (Node cannot spawn .cmd shims shell-less); Windows is covered by the source-order invariant' : false }, () => {
  const { home, cwd } = setupDirs();
  const shimDir = mkdtempSync(join(tmpdir(), 'wo-shim-'));
  try {
    const sidecar = projSidecar(cwd);
    const marker = join(shimDir, 'marker.log');
    const shim = join(shimDir, 'git');
    writeFileSync(shim, `#!/bin/sh\nif [ -e "$SL_TEST_SIDECAR" ]; then echo yes >> "$SL_TEST_MARKER"; else echo no >> "$SL_TEST_MARKER"; fi\nexit 1\n`, 'utf8');
    chmodSync(shim, 0o755);
    execFileSync(process.execPath, [engine], {
      input: stdinFor(cwd),
      env: {
        ...envFor(home, cwd),
        PATH: shimDir + delimiter + (process.env.PATH || ''),
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
    const sidecar = projSidecar(cwd);
    const render = () => {
      renderIn(home, cwd);
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
    assert.equal(snap.sessionId, SID, 'snapshot otherwise refreshed');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── M1: where the snapshot lands, and that statusline-last.json is written nowhere ──────────────
//
// Four renders: an ordinary one, one under CC_QUOTA_PROBE=1 (the retired guard's marker — with no
// home-level write there is nothing left for it to guard, so it changes nothing), one whose payload
// has no cwd, one with no session_id. None may leave a `statusline-last.json*` anywhere in either
// tree; each prints its status line.
const M1_CASES = [
  { name: 'ordinary', where: 'project' },
  { name: 'CC_QUOTA_PROBE=1', extra: { CC_QUOTA_PROBE: '1' }, where: 'project' },
  { name: 'no cwd', patch: (s) => { delete s.workspace; delete s.cwd; }, where: 'home' },
  { name: 'no session_id', patch: (s) => { delete s.session_id; }, where: 'nowhere' },
];

for (const c of M1_CASES) {
  test(`M1 — ${c.name}: the snapshot lands ${c.where === 'nowhere' ? 'nowhere' : 'in the ' + c.where + ' statusline-stats folder'}, and no statusline-last.json* is written`, () => {
    const { home, cwd } = setupDirs();
    try {
      const out = renderIn(home, cwd, { patch: c.patch, extra: c.extra });
      assert.ok(out.length > 0, 'the render still prints its status line');

      const legacy = [...findNamed(home, (n) => n.startsWith('statusline-last.json')), ...findNamed(cwd, (n) => n.startsWith('statusline-last.json'))];
      assert.deepEqual(legacy, [], 'this build writes statusline-last.json nowhere — home or project, final file or temp');

      const sidecars = [...findNamed(home, (n) => n.endsWith('.sidecar.json')), ...findNamed(cwd, (n) => n.endsWith('.sidecar.json'))];
      if (c.where === 'nowhere') {
        assert.deepEqual(sidecars, [], 'no session_id → no snapshot at all');
        return;
      }
      const expected = c.where === 'project' ? projSidecar(cwd) : homeSidecar(home);
      assert.deepEqual(sidecars, [expected], `exactly one snapshot, at ${expected}`);
      const snap = JSON.parse(readFileSync(expected, 'utf8'));
      assert.equal(snap.schema, 6, 'the same snapshot shape as before');
      assert.equal(snap.sessionId, SID, 'and it is this session\'s');
      assert.equal(snap.renderedAt, NOW);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// ── M2: the skip test — clock-only change skips, the 120 s heartbeat writes ────────────────────
//
// `writeSidecar` writes only when (a) the file is missing or unparseable, (b) the snapshot differs on
// a key other than renderedAt / aliveSec / activityPct / coldCoolRemainSec, or (c) the file's
// renderedAt is 120 s old or more, not a number, or in the future. An idle session's snapshot is
// then at most 130 s old, under every reader's 180 s STALE threshold.

test('M2 — heartbeat: renders at T+10 and T+119 write nothing; T+120 writes', () => {
  const { home, cwd } = setupDirs();
  try {
    const p = projSidecar(cwd);
    renderIn(home, cwd, { now: NOW });
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).renderedAt, NOW, 'the first render writes (missing file)');

    mark(p);
    renderIn(home, cwd, { now: NOW + 10 });
    assert.ok(!wasWritten(p), 'T+10: only clock keys moved → no write');
    renderIn(home, cwd, { now: NOW + 119 });
    assert.ok(!wasWritten(p), 'T+119: still under the heartbeat → no write');
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).renderedAt, NOW, 'the file still carries the T snapshot');

    renderIn(home, cwd, { now: NOW + 120 });
    assert.ok(wasWritten(p), 'T+120: the heartbeat writes');
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).renderedAt, NOW + 120, 'and the new snapshot is the T+120 one');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('M2 — a non-clock change inside the heartbeat writes at once', () => {
  const { home, cwd } = setupDirs();
  try {
    const p = projSidecar(cwd);
    renderIn(home, cwd, { now: NOW });
    mark(p);
    renderIn(home, cwd, { now: NOW + 10, patch: (s) => { s.cost.total_cost_usd = 0.9; } });
    assert.ok(wasWritten(p), 'costUsd moved → write, whatever the age');
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).costUsd, 0.9);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('M2 — the file decides: renderedAt in the future, non-numeric or the file unparseable or missing → a write; a fresh numeric renderedAt → none', () => {
  const { home, cwd } = setupDirs();
  try {
    const p = projSidecar(cwd);
    renderIn(home, cwd, { now: NOW });
    const good = JSON.parse(readFileSync(p, 'utf8'));
    // Each variant is the file the T render left, with ONLY its renderedAt (or its bytes) altered, so
    // the snapshot's other keys match and nothing but the file's own state can force the write.
    const variants = [
      { name: 'renderedAt 5 s old (control)', text: JSON.stringify({ ...good, renderedAt: NOW - 5 }), expectWrite: false },
      { name: 'renderedAt in the future', text: JSON.stringify({ ...good, renderedAt: NOW + 500 }), expectWrite: true },
      { name: 'renderedAt a numeric string', text: JSON.stringify({ ...good, renderedAt: String(NOW) }), expectWrite: true },
      { name: 'renderedAt absent', text: JSON.stringify(Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'renderedAt'))), expectWrite: true },
      { name: 'unparseable', text: '{"schema":6,', expectWrite: true },
    ];
    for (const v of variants) {
      writeFileSync(p, v.text, 'utf8');
      mark(p);
      renderIn(home, cwd, { now: NOW });
      assert.equal(wasWritten(p), v.expectWrite, `${v.name}: ${v.expectWrite ? 'a write' : 'no write'}`);
      if (v.expectWrite) assert.equal(JSON.parse(readFileSync(p, 'utf8')).renderedAt, NOW, `${v.name}: the rewritten file is this render's snapshot`);
    }
    unlinkSync(p);
    renderIn(home, cwd, { now: NOW + 10 });
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).renderedAt, NOW + 10, 'missing file → a write');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('M2 — phase 2 writes only when gitRepo changed', { skip: haveGit() ? false : 'git not on PATH' }, () => {
  const { home, cwd } = setupDirs();
  try {
    git(cwd, ['init', '-b', 'main']);
    git(cwd, ['remote', 'add', 'origin', 'https://example.com/acme/widgets.git']);
    git(cwd, ['commit', '--allow-empty', '-m', 'x']);
    const p = projSidecar(cwd);
    renderIn(home, cwd, { now: NOW });
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).gitRepo, 'acme/widgets@main', 'seeded by phase 2');

    // Nothing changed: phase 1 skips (clock keys only) and so must phase 2 (same gitRepo).
    mark(p);
    renderIn(home, cwd, { now: NOW + 10 });
    assert.ok(!wasWritten(p), 'same gitRepo → neither phase writes');

    // A branch switch: phase 1 still sees the carried-forward gitRepo and skips; phase 2 sees the new
    // slug and writes — the only write in this render is phase 2's.
    git(cwd, ['checkout', '-b', 'feature']);
    renderIn(home, cwd, { now: NOW + 20 });
    assert.ok(wasWritten(p), 'gitRepo changed → phase 2 writes');
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).gitRepo, 'acme/widgets@feature');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
