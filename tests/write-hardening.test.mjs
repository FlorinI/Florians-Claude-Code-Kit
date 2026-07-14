import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { atomicWriteFile } from '../home/_sl-compat.mjs';

// write-hardening (rows F1/F2-behavioural) — the atomic-write helper's contract, plus the
// post-kill recovery path: a crash between temp-write and rename leaves the original target
// intact and an orphaned <path>.tmp.<pid>; the next render must run clean, keep the cost
// baseline, and tolerate the orphan. (Which call sites USE the helper is source-invariants F2.)

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, '..', 'home', 'statusline.mjs');
const NOW = 1781750000;

function tempDir() { return mkdtempSync(join(tmpdir(), 'wh-')); }

test('atomicWriteFile — writes content and leaves no temp residue', () => {
  const d = tempDir();
  try {
    const p = join(d, 'state.json');
    atomicWriteFile(p, '{"a":1}');
    assert.equal(readFileSync(p, 'utf8'), '{"a":1}');
    atomicWriteFile(p, '{"a":2}'); // overwrite path
    assert.equal(readFileSync(p, 'utf8'), '{"a":2}');
    assert.deepEqual(readdirSync(d), ['state.json'], 'no .tmp.* residue');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('atomicWriteFile — failed write throws, cleans its temp, never half-writes the target', () => {
  const d = tempDir();
  try {
    // Target is an existing DIRECTORY → renameSync fails on every platform.
    const p = join(d, 'blocked');
    mkdirSync(p);
    writeFileSync(join(p, 'inner.txt'), 'x', 'utf8'); // non-empty, so POSIX rename can't replace it
    assert.throws(() => atomicWriteFile(p, 'clobber'));
    assert.ok(existsSync(join(p, 'inner.txt')), 'target untouched');
    assert.deepEqual(readdirSync(d), ['blocked'], 'temp cleaned up after the failure');
    // Nonexistent parent → the temp write itself fails; still throws, still no residue.
    assert.throws(() => atomicWriteFile(join(d, 'no-such-dir', 'x.json'), 'x'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('F1 — post-kill state (intact stats + orphaned temp): baseline survives, render runs clean', () => {
  const home = mkdtempSync(join(tmpdir(), 'wh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'wh-cwd-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const transcript = join(cwd, 'transcript.jsonl');
    const legLine = (i) => JSON.stringify({
      type: 'assistant', timestamp: `2026-06-18T02:2${i}:00.000Z`,
      message: { id: `w${i}`, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5000 } },
    }) + '\n';
    writeFileSync(transcript, legLine(0) + legLine(1) + legLine(2), 'utf8');

    const stdinFor = (cost) => JSON.stringify({
      model: { display_name: 'Fable 5 (1M context)' },
      version: '2.1.142', effort: { level: 'high' },
      context_window: { used_percentage: 5, total_input_tokens: 50000, context_window_size: 1000000 },
      transcript_path: transcript, session_id: 'wh-kill-1',
      cost: { total_cost_usd: cost, total_api_duration_ms: 60000 },
      workspace: { current_dir: cwd }, rate_limits: {},
    });
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_PROJECT_DIR: cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW) };
    const run = (cost) => execFileSync(process.execPath, [engine], { input: stdinFor(cost), env, maxBuffer: 64 * 1024 * 1024 });

    // Render 1 establishes the stats file; ≤5 legs → costBaseline latches to the current cost.
    run(0.25);
    const statsPath = join(cwd, '.claude', 'statusline-stats', 'wh-kill-1.json');
    assert.equal(JSON.parse(readFileSync(statsPath, 'utf8')).costBaseline, 0.25);

    // Simulate the kill's aftermath: the target survived, plus an orphaned temp full of garbage.
    const orphan = statsPath + '.tmp.99999';
    writeFileSync(orphan, '{"nLegs": 999, "TRUNCATED', 'utf8');

    // Render 2 must run clean off the intact stats file — baseline kept, no reset, orphan ignored.
    const out = run(0.3);
    assert.ok(out.length > 0, 'render produced output');
    const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
    assert.equal(stats.costBaseline, 0.25, 'cost baseline NOT reset');
    assert.equal(stats.nLegs, 3, 'legs preserved, garbage temp never read');
    // Tolerated: the orphan is dead weight, never promoted to state (swept by age later).
    if (existsSync(orphan)) {
      assert.equal(readFileSync(orphan, 'utf8'), '{"nLegs": 999, "TRUNCATED', 'orphan left as-is');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
