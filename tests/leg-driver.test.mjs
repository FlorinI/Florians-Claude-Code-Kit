import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getScannedLegs, getDriver, testColdLeg } from '../home/leg-driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'legscan.jsonl');

// leg-driver.mjs is the sole engine now (the pwsh leg-driver.ps1 was retired in the handover-check
// Node cutover). These lock its scan/cold/driver behavior; the /handover-check trio that consumes
// them is regression-tested end-to-end in tools/parity/run-trio-parity.mjs.

test('getScannedLegs — dedups by message.id (6 lines, 4 unique assistant legs)', () => {
  const js = getScannedLegs(fixture);
  assert.equal(js.length, 4);
});

test('testColdLeg — flags the post-idle big-rewrite leg (m3), not the warm ones', () => {
  const js = getScannedLegs(fixture);
  // m3 is leg idx 3: gap 1970s > 300s TTL, cw 60000 >= 50000, cr 100 < 0.5*cw -> cold
  assert.equal(testColdLeg(js[2]), true, 'm3 should be cold');
  assert.equal(testColdLeg(js[0]), false, 'm1 (first, no gap) not cold');
  assert.equal(testColdLeg(js[1]), false, 'm2 (warm) not cold');
});

test('getDriver — compacted: collapse-with-short-gap three-way classification (D4 boundary table)', () => {
  // D4.a — gap ≤ ttl, collapse (cr < 0.7·prevWarm), cw in [8k, 50k): the NEW compacted class, never cold.
  const a = { cwUnits: 15000, cr: 100000, out: 200, inT: 0, cw: 12000, prevWarm: 200000, gapToPrev: 60, coldTtl: 300 };
  assert.equal(getDriver(a), 'compacted ~12k (context collapsed, no idle gap)');
  assert.equal(testColdLeg(a), false, 'D4.a must not enter the cold tax');
  // D4.b — same collapse but gap = ttl+1 → cold, unchanged.
  const b = { ...a, gapToPrev: 301 };
  assert.equal(getDriver(b), 're-cached ~12k (cold — cache expired after idle)');
  assert.equal(testColdLeg(b), true, 'D4.b stays in the cold tax');
  // D4.c — collapse AND bigRewrite with short gap → compacted wins (pinned at the freeze).
  const c = { cwUnits: 75000, cr: 100, out: 200, inT: 0, cw: 60000, prevWarm: 200000, gapToPrev: 60, coldTtl: 300 };
  assert.equal(getDriver(c), 'compacted ~60k (context collapsed, no idle gap)');
  assert.equal(testColdLeg(c), false, 'D4.c short gap never cold');
  // D4.d — cr EXACTLY 0.7·prevWarm → NOT collapsed (strict <) → today's label unchanged.
  const d = { ...a, cr: 140000 };
  assert.equal(getDriver(d), 'loaded ~12k new context');
  // D4.e — prevWarm 0 (no prior warm set) → never compacted.
  const e = { ...a, prevWarm: 0, cr: 0 };
  assert.equal(getDriver(e), 'loaded ~12k new context');
  // D4.f — first leg (gap null) + bigRewrite → warm rewrite unchanged.
  const f = { cwUnits: 75000, cr: 100, out: 200, inT: 0, cw: 60000, prevWarm: 0, gapToPrev: null, coldTtl: 300 };
  assert.equal(getDriver(f), 're-cached ~60k (warm rewrite, not new content)');
  // bigRewrite with short gap but NO collapse (cr ≥ 0.7·prevWarm) → warm rewrite (the D3 tax shape).
  const g = { cwUnits: 75000, cr: 10000, out: 200, inT: 0, cw: 60000, prevWarm: 8800, gapToPrev: 60, coldTtl: 300 };
  assert.equal(getDriver(g), 're-cached ~60k (warm rewrite, not new content)');
  assert.equal(testColdLeg(g), false);
});

test('getDriver — labels match the dominant weighted term', () => {
  const cold = { cwUnits: 120000, cr: 100, out: 600, inT: 80, cw: 60000, prevWarm: 20050, gapToPrev: 1970, coldTtl: 300 };
  assert.equal(getDriver(cold), 're-cached ~60k (cold — cache expired after idle)');
  const out = { cwUnits: 1000, cr: 100, out: 4000, inT: 80, cw: 800, prevWarm: 0, gapToPrev: null, coldTtl: 300 };
  assert.equal(getDriver(out), 'generated ~4k output');
  const reread = { cwUnits: 100, cr: 500000, out: 100, inT: 80, cw: 0, prevWarm: 0, gapToPrev: null, coldTtl: 300 };
  assert.equal(getDriver(reread), 're-read deep context (~500k)');
  const fresh = { cwUnits: 100, cr: 100, out: 100, inT: 90000, cw: 0, prevWarm: 0, gapToPrev: null, coldTtl: 300 };
  assert.equal(getDriver(fresh), 'large fresh input (~90k)');
});
