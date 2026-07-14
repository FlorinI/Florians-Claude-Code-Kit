import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// source-invariants — static checks pinned by the 2026-07-14 Claude-5 correctness sprint's
// acceptance rows (A5, E4, F2, F3-order, D4). They read source text, not behaviour: each one
// guards a property that has no runtime observable (a constants-not-config constraint, a deleted
// stale comment, which write primitive a call site uses, top-to-bottom execution order).

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const src = (p) => readFileSync(join(repo, ...p.split('/')), 'utf8');

// ---- A5: TIER_BASE is literal constants — no fetching, no config, no env ----------------------
test('A5 — TIER_BASE is a hand-maintained literal map in leg-driver.mjs', () => {
  const s = src('home/leg-driver.mjs');
  assert.match(s, /export const TIER_BASE = \{ fable: 10, mythos: 10, opus: 5, sonnet: 2, haiku: 1 \};/);
});

test('A5 — leg-driver.mjs has no network or env surface at all', () => {
  const s = src('home/leg-driver.mjs');
  for (const bad of ['fetch(', 'node:http', 'node:https', 'process.env']) {
    assert.ok(!s.includes(bad), `leg-driver.mjs must not contain: ${bad}`);
  }
});

// ---- E4: the stale "waiting for CC adoption" framing is gone ----------------------------------
test('E4 — handover-facts.mjs no longer frames the warm-rewrite tax as pending CC adoption', () => {
  const s = src('home/handover-facts.mjs');
  assert.ok(!s.includes('The day CC adopts'), 'stale forward-looking framing still present');
  assert.ok(!/waiting for CC adoption/i.test(s), 'stale framing still present');
});

// ---- F2: all three state writers go through atomicWriteFile ------------------------------------
test('F2 — stats, agents cache, and both sidecar writes use atomicWriteFile', () => {
  const s = src('home/statusline.mjs');
  assert.match(s, /atomicWriteFile\(statsPath,/, 'per-session stats writer');
  assert.match(s, /atomicWriteFile\(cachePath,/, 'agents cache writer');
  const sidecarWrites = s.match(/atomicWriteFile\([^)]*statusline-last\.json[^)]*\)/g) || [];
  assert.equal(sidecarWrites.length, 2, 'project + home sidecar writes');
  // No state target may still use the bare primitive.
  for (const bad of [/writeFileSync\(statsPath/, /writeFileSync\(cachePath/, /writeFileSync\([^)\n]*statusline-last\.json/]) {
    assert.ok(!bad.test(s), `bare writeFileSync on a state file: ${bad}`);
  }
});

// ---- F3 (static half): sidecar write precedes the git cluster ----------------------------------
// statusline.mjs is a top-to-bottom script, so source order IS execution order. The behavioural
// half (a git shim observing the sidecar on disk) lives in write-order.test.mjs.
test('F3 — sidecar snapshot block sits above the git cluster', () => {
  const s = src('home/statusline.mjs');
  const sidecarAt = s.indexOf('=== Sidecar snapshot ===');
  const gitAt = s.indexOf('=== Cluster 6: git ===');
  assert.ok(sidecarAt > 0 && gitAt > 0, 'section markers present');
  assert.ok(sidecarAt < gitAt, 'sidecar write must precede the git subprocess cluster');
});

// ---- D4: calibration sample rows carry the session model ---------------------------------------
// Private-repo docs; skipped when absent so this suite stays runnable from a public checkout.
test('D4 — samples table header + interpret-statusline row template carry a model column', (t) => {
  const samples = join(repo, 'docs', 'froz5-calibration-samples.md');
  const command = join(repo, '.claude', 'commands', 'interpret-statusline.md');
  if (!existsSync(samples) || !existsSync(command)) {
    t.skip('private-repo docs not present in this checkout');
    return;
  }
  const header = readFileSync(samples, 'utf8').split('\n').find((l) => l.startsWith('| date |'));
  assert.ok(header, 'samples table header found');
  assert.match(header, /\| model \|/, 'samples header carries a model column');
  const tmpl = readFileSync(command, 'utf8');
  assert.match(tmpl, /\| date \| git \| model \|/, 'interpret-statusline row template carries model');
});
