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
