import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// model-switch (rows D1/D3) — stateful two-render tests of the per-session rollup's model
// stamping. A "switch" is a price-TIER change (ModelTier(old) !== ModelTier(new)); id-form vs
// display-form of the same model and same-tier upgrades must NOT stamp. Runs the real engine as
// a subprocess against kept temp dirs (the parity harness can't do multi-render statefulness).

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, '..', 'home', 'statusline.mjs');
const NOW = 1781750000;

const leg = (i, model) => JSON.stringify({
  type: 'assistant',
  timestamp: `2026-06-18T02:${String(9 + i).padStart(2, '0')}:00.000Z`,
  message: { id: `t${i}`, model, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20000 } },
}) + '\n';

function render(dirs, displayName, cost) {
  const stdin = {
    model: { display_name: displayName },
    version: '2.1.142', effort: { level: 'high' },
    context_window: { used_percentage: 15, total_input_tokens: 150000, context_window_size: 1000000 },
    transcript_path: dirs.transcript, session_id: 'msw-test-1',
    cost: { total_cost_usd: cost, total_api_duration_ms: 300000 },
    workspace: { current_dir: dirs.cwd }, rate_limits: {},
  };
  execFileSync(process.execPath, [engine], {
    input: JSON.stringify(stdin),
    // CLAUDE_CONFIG_DIR is pinned POSITIVELY (never deleted) so the child's user-level state stays
    // inside the temp home even when this suite is launched from a second-subscription session.
    env: { ...process.env, USERPROFILE: dirs.home, HOME: dirs.home, CLAUDE_CONFIG_DIR: join(dirs.home, '.claude'), CLAUDE_PROJECT_DIR: dirs.cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW) },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stats: JSON.parse(readFileSync(join(dirs.cwd, '.claude', 'statusline-stats', 'msw-test-1.json'), 'utf8')),
    sidecar: JSON.parse(readFileSync(join(dirs.cwd, '.claude', 'statusline-last.json'), 'utf8')),
  };
}

function withDirs(fn) {
  const home = mkdtempSync(join(tmpdir(), 'msw-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'msw-cwd-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const transcript = join(cwd, 'transcript.jsonl');
  try { return fn({ home, cwd, transcript }); }
  finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Two renders: legs 1–12 under `first`, then leg 13 appended and rendered under `second`.
function twoRenders(first, second) {
  return withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 12; i++) lines += leg(i, 'claude-x');
    writeFileSync(dirs.transcript, lines, 'utf8');
    const r1 = render(dirs, first, 1.8);
    appendFileSync(dirs.transcript, leg(13, 'claude-x'), 'utf8');
    const r2 = render(dirs, second, 2.0);
    return { r1, r2 };
  });
}

test('D1 — fable→sonnet at leg 13 stamps mainModel + modelSwitchedAtLeg + sidecar modelSwitch', () => {
  const { r1, r2 } = twoRenders('Fable 5 (1M context)', 'Sonnet 5');
  assert.equal(r1.stats.mainModel, 'Fable 5 (1M context)');
  assert.equal(r1.stats.nLegs, 12);
  assert.ok(!('modelSwitch' in r1.stats), 'no stamp before the switch');
  assert.ok(!('modelSwitch' in r1.sidecar), 'no sidecar key before the switch');

  assert.equal(r2.stats.nLegs, 13);
  assert.equal(r2.stats.mainModel, 'Sonnet 5');
  assert.equal(r2.stats.modelSwitchedAtLeg, 13);
  assert.deepEqual(r2.stats.modelSwitch, { atLeg: 13, from: 'Fable 5 (1M context)', to: 'Sonnet 5' });
  assert.deepEqual(r2.sidecar.modelSwitch, { atLeg: 13, from: 'Fable 5 (1M context)', to: 'Sonnet 5' });
});

test('D3 — id-form vs display-form of the SAME model: no switch stamped', () => {
  const { r2 } = twoRenders('claude-fable-5', 'Fable 5 (1M context)');
  assert.equal(r2.stats.mainModel, 'Fable 5 (1M context)');
  assert.ok(!('modelSwitch' in r2.stats), 'raw-string change must not stamp');
  assert.equal(r2.stats.modelSwitchedAtLeg, undefined);
  assert.ok(!('modelSwitch' in r2.sidecar), 'sidecar must not carry modelSwitch');
});

test('D3 — same-tier upgrade (Opus 4.7 → Opus 4.8): no switch stamped', () => {
  const { r2 } = twoRenders('Opus 4.7', 'Opus 4.8 (1M context)');
  assert.equal(r2.stats.mainModel, 'Opus 4.8 (1M context)');
  assert.ok(!('modelSwitch' in r2.stats));
  assert.ok(!('modelSwitch' in r2.sidecar));
});
