import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { median } from '../home/leg-driver.mjs';

// agent-ctx-median — the direct guard on the agent peak-context MEDIAN.
//
// WHY THIS FILE EXISTS. Until the Dossier IV re-layout (2026-08-22) this property was guarded by
// tests C1 and C2 in goldens-invariants.test.mjs, which asserted the strings `med 127.2k` and
// `med 43.2k·max 43.2k` on the rendered agents line. The re-layout DELETES that display string
// (spec §7.5 — a Florian deletion: "Medium and max, we could remove altogether"), so those two rows
// would have gone green by losing their subject rather than by keeping it true.
//
// The bug they were built for is real and dated: 2026-06-24, the median of two agent peak contexts
// rendering as the MAX. That bug class does not care whether the number reaches a screen. So the
// guard moves here, off the display and onto the computation, and it is deliberately written to pass
// BOTH before and after the re-layout — it reads no golden.txt and no rendered string at all.
//
// Three parts, each stating what it actually proves:
//   0a  the median function itself, on the exact value sets the two fixtures were captured to carry;
//   0b  the engine's own unexported copy of it — in source-invariants.test.mjs, by source shape,
//       because it cannot be imported (see the note there);
//   0c  the MAX half, which keeps a corpus guard because it survives in the sidecar as agentCtxMax.

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', 'tools', 'parity', 'fixtures');
const sidecar = (f) => JSON.parse(readFileSync(join(FIX, f, 'golden-sidecar.json'), 'utf8'));
// Blessed fixtures only: a fixture's goldens are written at the quality gate, so an unblessed
// directory would make this sweep throw ENOENT instead of asserting.
const allFixtures = () => readdirSync(FIX)
  .filter((n) => statSync(join(FIX, n)).isDirectory())
  .filter((n) => existsSync(join(FIX, n, 'golden-sidecar.json')));

// The two agent peak contexts the `median-even` fixture carries. 174,900 is the fixture's own
// sidecar `agentCtxMax` (asserted in 0c below, so this pair cannot drift from the fixture silently);
// 79,400 is its second agent's peak, which the sidecar does not carry — it is visible in the
// fixture's spikes panel as `1 legs over ~79k` and it is the value the retired C1 named in words.
const EVEN_PEAKS = [79400, 174900];
const EVEN_MEDIAN = 127150;   // (79,400 + 174,900) / 2 — what the retired C1 saw as `med 127.2k`
const EVEN_MAX = 174900;      // what an upper-median bug would have returned instead

// ---- 0a: the median function, on the retired rows' own value sets ------------------------------

test('0a — even count: the median is the mean of the middle two, never the max (C1 re-pointed)', () => {
  assert.equal(median(EVEN_PEAKS), EVEN_MEDIAN);
  assert.notEqual(median(EVEN_PEAKS), EVEN_MAX,
    'the 2026-06-24 bug: an upper-median implementation returns the max on an even count');
  // Order must not matter — the retired row could only ever see one arrival order.
  assert.equal(median([...EVEN_PEAKS].reverse()), EVEN_MEDIAN);
});

test('0a — single value: median == max is legitimate, not the bug (C2 re-pointed)', () => {
  const peak = sidecar('median-single').agentCtxMax;
  assert.equal(peak, 43200, 'the fixture still carries the single-agent peak C2 named');
  // With one agent the median IS the max, which is why C2 existed as a companion to C1: it pins
  // that the equality is legitimate here, so a future reader cannot "fix" C1 by making them agree.
  assert.equal(median([peak]), peak);
  assert.equal(median([peak]), 43200);
});

test('0a — the even-count property holds generally, not just on the fixture pair', () => {
  // A regression could satisfy the literal above by special-casing it. This row states the property.
  for (const vals of [[1, 3], [10, 20, 30, 40], [5, 5, 9, 9], [0, 100], [2, 4, 6, 8, 10, 12]]) {
    const m = median(vals);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    assert.ok(m >= min && m <= max, `${vals}: median ${m} out of range`);
    if (min !== max) assert.ok(m < max, `${vals}: median ${m} must sit strictly below the max`);
  }
  // Odd counts keep returning a member of the set; empty is null (the exported contract).
  assert.equal(median([7, 1, 5]), 5);
  assert.equal(median([]), null);
});

// ---- 0c: the MAX half keeps its corpus guard (it survives in the sidecar) -----------------------

test('0c — agentCtxMax still carries the peak the retired rows read off the screen', () => {
  assert.equal(sidecar('median-even').agentCtxMax, EVEN_MAX);
  assert.equal(sidecar('median-even').nAgents, 2, 'the even-count shape is what makes C1 meaningful');
  assert.equal(sidecar('median-single').agentCtxMax, 43200);
  assert.equal(sidecar('median-single').nAgents, 1);
});

test('0c — every agent fixture reports a usable peak context in the sidecar', () => {
  // Display-independent by construction: the re-layout drops `(med …·max …)` from the line but
  // cannot touch agentCtxMax (spec §3 — it comes from the agent aggregate, not from a string).
  let checked = 0;
  for (const f of allFixtures()) {
    const s = sidecar(f);
    if (!s.nAgents || Number(s.nAgents) === 0) continue;
    assert.ok(typeof s.agentCtxMax === 'number' && s.agentCtxMax > 0,
      `${f}: nAgents ${s.nAgents} but agentCtxMax is ${JSON.stringify(s.agentCtxMax)}`);
    checked++;
  }
  assert.ok(checked >= 14, `vacuity guard: only ${checked} agent fixtures checked`);
});

// ---- the fixtures this guard depends on must not quietly disappear ------------------------------

test('0c — the two median fixtures still exist and still carry agent transcripts', () => {
  for (const f of ['median-even', 'median-single']) {
    assert.ok(existsSync(join(FIX, f, 'transcript', 'subagents')),
      `${f}: the agent transcripts this guard is calibrated on are gone`);
  }
});
