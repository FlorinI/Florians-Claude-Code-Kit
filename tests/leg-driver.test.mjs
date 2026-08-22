import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getScannedLegs, getDriver, testColdLeg, testWarmRewriteLeg, tierWeight, TIER_BASE,
  servingTierReport, isSyntheticLeg,
} from '../home/leg-driver.mjs';
// `pickFreshBaseline` left this import list with the froz5 removal (2026-08-21, D5). Keeping it here
// would take the WHOLE file down at module load, not just the one row that used it.
import { writeFileSync as writeFile } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'legscan.jsonl');
const home = join(here, '..', 'home');

// leg-driver.mjs is the sole engine now (the pwsh leg-driver.ps1 was retired in the handover-check
// Node cutover). These lock its scan/cold/driver behavior; the /handover-check trio that consumes
// them is regression-tested end-to-end in tools/parity/run-trio-parity.mjs.

test('getScannedLegs — dedups by message.id (6 lines, 4 unique assistant legs)', () => {
  const js = getScannedLegs(fixture);
  assert.equal(js.length, 4);
});

// ---- leg-pricing-truth sprint (2026-08-16): tierWeight + per-leg model -------------------------
test('W1 — tierWeight table: TIER_BASE[leg]/TIER_BASE[main] for mapped pairs, 1.0 otherwise', () => {
  const mains = ['fable', 'opus', 'sonnet', 'haiku', 'mythos'];
  const legs = { 'claude-fable-5': 'fable', 'claude-opus-5': 'opus', 'claude-sonnet-5': 'sonnet', 'claude-haiku-4-5': 'haiku', 'claude-mythos-1': 'mythos' };
  for (const main of mains) {
    for (const [model, t] of Object.entries(legs)) {
      assert.equal(tierWeight(model, main), TIER_BASE[t] / TIER_BASE[main], `${model} on ${main}`);
    }
    for (const unmapped of ['claude-x', '', null, undefined]) {
      assert.equal(tierWeight(unmapped, main), 1.0, `${JSON.stringify(unmapped)} on ${main} must be 1.0`);
    }
  }
  // spot values from the acceptance arithmetic
  assert.equal(tierWeight('claude-sonnet-5', 'fable'), 0.2);
  assert.equal(tierWeight('claude-fable-5', 'sonnet'), 5);
  assert.equal(tierWeight('claude-mythos-1', 'opus'), 2);
  assert.equal(tierWeight('claude-opus-5', 'opus'), 1);
  // an unmapped / null MAIN never weights anything
  for (const main of [null, 'other', undefined]) {
    for (const model of Object.keys(legs)) assert.equal(tierWeight(model, main), 1.0, `${model} on main ${main}`);
  }
});

test('W2 — display-form and id-form of the same model weigh the same', () => {
  assert.equal(tierWeight('Sonnet 5', 'fable'), 0.2);
  assert.equal(tierWeight('claude-sonnet-5', 'fable'), 0.2);
  assert.equal(tierWeight('Fable 5 (1M context)', 'sonnet'), 5);
});

test('W3 — getScannedLegs carries the raw model string ("" when the line has none); dedup unchanged', () => {
  const js = getScannedLegs(fixture);
  assert.equal(js.length, 4);
  assert.deepEqual(js.map((l) => l.model), ['claude-opus-4-8-20260115', '', 'claude-sonnet-5', '']);
});

test('W4 — one weight function: TIER_BASE[ is used outside leg-driver only by the statusline tripwire', () => {
  const sl = readFileSync(join(home, 'statusline.mjs'), 'utf8').split('\n');
  const slHits = sl.filter((l) => l.includes('TIER_BASE[') && !l.trim().startsWith('//'));
  assert.equal(slHits.length, 1, `statusline.mjs TIER_BASE[ sites: ${slHits.join(' | ')}`);
  assert.match(slHits[0], /TIER_BASE\[mainTier\] \/ 1e6/);
  const rs = readFileSync(join(home, 'render-spikes.mjs'), 'utf8').split('\n');
  assert.equal(rs.filter((l) => l.includes('TIER_BASE[') && !l.trim().startsWith('//')).length, 0, 'render-spikes must go through tierWeight');
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
  // D4.f — first leg (gap null) + bigRewrite: the opening leg is never a "rewrite" (froz5-recal decision 8) —
  // cr 100 > 0 → not a cold start → plain "loaded". W5 below covers the cold-start / big-input openers.
  const f = { cwUnits: 75000, cr: 100, out: 200, inT: 0, cw: 60000, prevWarm: 0, gapToPrev: null, coldTtl: 300 };
  assert.equal(getDriver(f), 'loaded ~60k new context');
  // bigRewrite with short gap but NO collapse (cr ≥ 0.7·prevWarm) → warm rewrite (the D3 tax shape).
  const g = { cwUnits: 75000, cr: 10000, out: 200, inT: 0, cw: 60000, prevWarm: 8800, gapToPrev: 60, coldTtl: 300 };
  assert.equal(getDriver(g), 're-cached ~60k (warm rewrite, not new content)');
  assert.equal(testColdLeg(g), false);
});

// ---- froz5-recal sprint (2026-08-16): opening-leg labels, ts/speed on scanned legs, partition guard ------
test('W5 — getDriver opening leg (gapToPrev null, cw-dominant): cold-start → "opened cold", else "loaded … new context"', () => {
  const cold = { cwUnits: 114000, cr: 0, out: 300, inT: 2, cw: 57000, prevWarm: 0, gapToPrev: null, coldTtl: 3600 };
  assert.equal(getDriver(cold), 'opened cold ~57k (whole context written, no cached prefix)');
  const warmOpen = { cwUnits: 120000, cr: 20000, out: 300, inT: 0, cw: 60000, prevWarm: 0, gapToPrev: null, coldTtl: 3600 };
  assert.equal(getDriver(warmOpen), 'loaded ~60k new context');
  const bigInput = { cwUnits: 400000, cr: 0, out: 200, inT: 1000, cw: 200000, prevWarm: 0, gapToPrev: null, coldTtl: 3600 };
  assert.equal(getDriver(bigInput), 'loaded ~200k new context');
  // with a previous leg the bigRewrite wording is unchanged, and a cold-start-shaped leg that is NOT the
  // opener still reads by its class (gap 60 ≤ ttl, no collapse → warm rewrite)
  const later = { cwUnits: 120000, cr: 100, out: 200, inT: 0, cw: 60000, prevWarm: 100, gapToPrev: 60, coldTtl: 3600 };
  assert.equal(getDriver(later), 're-cached ~60k (warm rewrite, not new content)');
  const coldShapeLater = { cwUnits: 114000, cr: 0, out: 300, inT: 2, cw: 57000, prevWarm: 0, gapToPrev: 60, coldTtl: 3600 };
  assert.equal(getDriver(coldShapeLater), 're-cached ~57k (warm rewrite, not new content)');
  // the boundary: cw exactly 8000, in 100, cr 0 → cold; in 101 → loaded
  const b = { cwUnits: 16000, cr: 0, out: 10, inT: 100, cw: 8000, prevWarm: 0, gapToPrev: null, coldTtl: 3600 };
  assert.equal(getDriver(b), 'opened cold ~8k (whole context written, no cached prefix)');
  assert.equal(getDriver({ ...b, inT: 101 }), 'loaded ~8k new context');
});

test('W6 — getScannedLegs carries ts (epoch s | null) and speed (raw usage.speed | ""); count/dedup unchanged', () => {
  const js = getScannedLegs(fixture);
  assert.equal(js.length, 4);
  assert.deepEqual(js.map((l) => l.ts), [
    Date.parse('2026-06-18T00:00:00.000Z') / 1000,
    Date.parse('2026-06-18T00:00:30.000Z') / 1000,
    Date.parse('2026-06-18T00:33:20.000Z') / 1000,
    Date.parse('2026-06-18T00:40:00.000Z') / 1000,
  ]);
  assert.deepEqual(js.map((l) => l.speed), ['', '', '', 'fast']);
  assert.deepEqual(js.map((l) => l.idx), [1, 2, 3, 4], 'first-wins dedup keeps m2 once');
  // a line without a timestamp → ts null
  const tmp = join(tmpdir(), `legscan-nots-${process.pid}.jsonl`);
  writeFileSync(tmp, JSON.stringify({ type: 'assistant', message: { id: 'x1', usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }) + '\n', 'utf8');
  try { assert.equal(getScannedLegs(tmp)[0].ts, null); } finally { rmSync(tmp, { force: true }); }
});

test('W7 — testWarmRewriteLeg still excludes the opening leg (decision 8 did not move the partition)', () => {
  const opener = { cwUnits: 114000, cr: 0, out: 300, inT: 2, cw: 57000, prevWarm: 0, gapToPrev: null, coldTtl: 3600 };
  assert.equal(testWarmRewriteLeg(opener), false);
  const later = { ...opener, gapToPrev: 60 }; // prevWarm 0 → not a collapse → not compacted
  assert.equal(testWarmRewriteLeg(later), true, 'same shape with a previous leg IS a warm rewrite');
});

// ---- froz5-truth sprint (2026-08-21): servingTierReport (T1 rows S1–S9) --------------------------
// The report answers ONE question — "does the model label name a price tier that has never served in
// this run?" — and drives a dim chip, a conditional sidecar key and a fact-sheet caveat. It gates NO
// number: the froz5 baseline is tier-free now, so there is no tier for it to get wrong. Spec
// .claude/plans/260821-froz5-truth-spec.md §2.4 / D1 / D9.

const FABLE = 'claude-fable-5', OPUS = 'claude-opus-5', SONNET = 'claude-sonnet-5', HAIKU = 'claude-haiku-4-5';
const rep = (models, start, display) => servingTierReport(models, start, display);

test('S1 — display tier mapped and ABSENT from the run: report fires, naming the modal tier that served', () => {
  assert.deepEqual(rep(Array(12).fill(OPUS), 0, 'Fable 5 (1M context)'), { display: 'fable', serving: 'opus' });
  // the MODAL tier is named, not merely the first one seen
  assert.deepEqual(rep([SONNET, OPUS, OPUS, OPUS], 0, 'Fable 5'), { display: 'fable', serving: 'opus' });
  assert.deepEqual(rep([OPUS, SONNET, SONNET, SONNET], 0, 'Fable 5'), { display: 'fable', serving: 'sonnet' });
  // display-form and id-form of the label both resolve
  assert.deepEqual(rep(Array(3).fill(OPUS), 0, 'claude-fable-5'), { display: 'fable', serving: 'opus' });
  // the payload is exactly two fields — a chip's text, never a number
  assert.deepEqual(Object.keys(rep(Array(3).fill(OPUS), 0, 'Fable 5')).sort(), ['display', 'serving']);
});

test('S2 — display tier present as a MINORITY (one leg out of many): NO report', () => {
  // This is the row that separates the amended presence rule from the withdrawn modal-tier rule: a
  // modal rule would still fire here, because fable is not the modal tier. Presence, not majority.
  const models = [...Array(11).fill(OPUS), FABLE];
  assert.equal(rep(models, 0, 'Fable 5 (1M context)'), null, 'one fable leg is enough to silence it');
  // and label-served-late's real shape: 117 opus then 7 fable, label fable
  const real = [...Array(117).fill(OPUS), ...Array(7).fill(FABLE)];
  assert.equal(rep(real, 0, 'Fable 5 (1M context)'), null, 'the real 124-leg shape reports nothing');
});

test('S3 — latching: one leg at the display tier turns the report OFF, and nothing turns it back on', () => {
  const models = Array(12).fill(OPUS);
  // ON before
  assert.deepEqual(rep(models, 0, 'Fable 5'), { display: 'fable', serving: 'opus' }, 'ON while fable has never served');
  // OFF the moment a fable leg lands
  const afterSwitch = [...models, FABLE];
  assert.equal(rep(afterSwitch, 0, 'Fable 5'), null, 'OFF once fable serves');
  // …and no later leg can turn it back on, however many off-tier legs follow. Within a run a tier's
  // presence only ever grows, which is what makes the report un-flappable.
  for (let extra = 1; extra <= 30; extra++) {
    assert.equal(rep([...afterSwitch, ...Array(extra).fill(OPUS)], 0, 'Fable 5'), null, `still OFF after +${extra} opus legs`);
  }
});

test('S4 — changing the display tier RE-ASKS the question, even after it had latched off', () => {
  const models = [...Array(12).fill(OPUS), FABLE];
  assert.equal(rep(models, 0, 'Fable 5'), null, 'latched off under the fable label');
  // /model → Sonnet 5. Sonnet has never served, so the report is correct to appear now.
  assert.deepEqual(rep(models, 0, 'Sonnet 5'), { display: 'sonnet', serving: 'opus' }, 'the new label re-asks');
  // …and switching to a label that HAS served stays silent
  assert.equal(rep(models, 0, 'Opus 5'), null);
});

test('S5 — unmapped / empty / absent leg models are ignored; an unmapped or absent DISPLAY reports nothing', () => {
  // Leg side: 'other', '' and absent never count as a tier, so they cannot silence the report…
  assert.deepEqual(rep([OPUS, '', null, undefined, 'claude-zed-9', OPUS], 0, 'Fable 5'),
    { display: 'fable', serving: 'opus' }, 'noise legs are skipped, opus still the modal tier');
  // …and they cannot BE the serving tier either.
  assert.equal(rep(['', null, 'claude-zed-9'], 0, 'Fable 5'), null, 'no mapped leg tier → nothing to report');
  // Display side: an unmapped or absent label means there is nothing to check.
  for (const d of ['Zed 9', '', null, undefined]) {
    assert.equal(rep(Array(5).fill(OPUS), 0, d), null, `display ${JSON.stringify(d)} → no report`);
  }
});

test('S6 — no mapped leg tier anywhere in the run: no report (never a report against nothing)', () => {
  assert.equal(rep([], 0, 'Fable 5'), null, 'empty list');
  assert.equal(rep(null, 0, 'Fable 5'), null, 'null list');
  assert.equal(rep(undefined, 0, 'Fable 5'), null, 'absent list');
  assert.equal(rep(Array(8).fill(''), 0, 'Fable 5'), null, 'all empty strings');
  assert.equal(rep(Array(8).fill('claude-zed-9'), 0, 'Fable 5'), null, "all 'other'");
});

test('S7 — sampling starts at the RUN start, not at leg 0: an earlier run of another tier is not consulted', () => {
  // A resumed session whose first run really did run fable. From leg 2 on, only opus served, so the
  // fable label names a tier that has not served IN THIS RUN — which is the honest answer.
  const models = [FABLE, FABLE, OPUS, OPUS, OPUS];
  assert.equal(rep(models, 0, 'Fable 5'), null, 'whole session: fable served, so nothing to report');
  assert.deepEqual(rep(models, 2, 'Fable 5'), { display: 'fable', serving: 'opus' }, 'this run only: it has not');
  // A runStartLeg past the end, or a junk value, degrades to "no legs in this run" / "from 0".
  assert.equal(rep(models, 99, 'Fable 5'), null, 'run starts past the end → no legs → no report');
  assert.equal(rep(models, -5, 'Fable 5'), null, 'negative clamps to 0 → fable served');
  assert.equal(rep(models, NaN, 'Fable 5'), null, 'NaN clamps to 0');
});

test('S8 — ties in "which tier did serve" break to the higher TIER_BASE, and no number moves across the tie', () => {
  const a = rep([OPUS, OPUS, FABLE, FABLE], 0, 'Haiku 4.5');
  const b = rep([FABLE, FABLE, OPUS, OPUS], 0, 'Haiku 4.5');
  assert.deepEqual(a, { display: 'haiku', serving: 'fable' }, 'fable (base 10) beats opus (base 5)');
  assert.deepEqual(b, a, 'and the answer does not depend on which tier was seen first');
  assert.ok(TIER_BASE.fable > TIER_BASE.opus, 'the tie-break really is on TIER_BASE');
  // The tie decides CHIP TEXT only. Its old second half — the same legs through the tier-blind
  // baseline picker giving one answer either way — went with pickFreshBaseline (froz5-removal, D5).
});

test('S9 — the report reads arrays already in hand: no file read, no transcript re-scan', () => {
  // In the style of W4 above. Two independent guarantees:
  //   • the FUNCTION cannot read anything — its body names no fs call and no scan;
  //   • the CALL SITE passes only rollup fields and the payload's display name, so nothing had to be
  //     re-read to build its arguments. statusline.mjs is the hot path (every 10 s, every session).
  const drv = readFileSync(join(home, 'leg-driver.mjs'), 'utf8');
  const body = drv.slice(drv.indexOf('export function servingTierReport('));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  for (const forbidden of ['readFileSync', 'getScannedLegs', 'statSync', 'existsSync', 'require(']) {
    assert.ok(!fn.includes(forbidden), `servingTierReport must not ${forbidden}`);
  }
  const sl = readFileSync(join(home, 'statusline.mjs'), 'utf8').split('\n');
  const sites = sl.map((l, i) => ({ n: i + 1, l })).filter(({ l }) => /servingTierReport\(/.test(l) && !l.trim().startsWith('//'));
  assert.equal(sites.length, 1, `exactly one call site: ${JSON.stringify(sites)}`);
  const call = sites[0].l;
  assert.match(call, /servingTierReport\(\s*rollup\.perLegModels\s*,/, 'first argument is the persisted per-leg model array');
  assert.match(call, /runStartLeg/, 'second argument is the run window already computed');
  assert.match(call, /display_name/, 'third argument is the payload label');
  for (const forbidden of ['readFileSync', 'getScannedLegs']) {
    assert.ok(!call.includes(forbidden), `the call site must not ${forbidden}: ${call}`);
  }
});

// ---- froz5-truth sprint: isSyntheticLeg (T3 rows Y2–Y5, Y7) ---------------------------------------
// Claude Code records an API overload (a 529) as an assistant line with no billed tokens. Counting it
// distorts the leg count, the sparkline (a $0.00 cell) and the opening window's composition. EITHER
// signal fires — the model literal alone would decay silently if CC renamed it; all-zero alone would
// miss a placeholder that reported a stray counter. Spec §2.4 / D8.

test('Y2 — arm one alone: the `<synthetic>` model string with NON-ZERO usage is skipped', () => {
  assert.equal(isSyntheticLeg({ model: '<synthetic>', inT: 10, cw: 5000, cr: 90000, out: 400 }), true);
  assert.equal(isSyntheticLeg({ model: '<synthetic>', inT: 0, cw: 0, cr: 0, out: 1 }), true);
  // exact literal only — a near-miss name is a real model
  assert.equal(isSyntheticLeg({ model: '<synthetic-2>', inT: 1, cw: 0, cr: 0, out: 1 }), false);
  assert.equal(isSyntheticLeg({ model: 'synthetic', inT: 1, cw: 0, cr: 0, out: 1 }), false);
  assert.equal(isSyntheticLeg({ model: '<SYNTHETIC>', inT: 1, cw: 0, cr: 0, out: 1 }), false, 'case-sensitive literal');
});

test('Y3 — arm two alone: an ORDINARY model string with all four counters zero is skipped', () => {
  assert.equal(isSyntheticLeg({ model: OPUS, inT: 0, cw: 0, cr: 0, out: 0 }), true);
  assert.equal(isSyntheticLeg({ model: '', inT: 0, cw: 0, cr: 0, out: 0 }), true);
  assert.equal(isSyntheticLeg({ inT: 0, cw: 0, cr: 0, out: 0 }), true, 'absent model, all zero');
  assert.equal(isSyntheticLeg({}), true, 'nothing at all reads as all-zero');
  assert.equal(isSyntheticLeg(), true, 'called with no argument at all → no throw');
});

test('Y4 — near-miss: ONE counter at 1 with an ordinary model is KEPT (AE-10, unrecognised ≠ fake)', () => {
  for (const k of ['inT', 'cw', 'cr', 'out']) {
    const leg = { model: OPUS, inT: 0, cw: 0, cr: 0, out: 0, [k]: 1 };
    assert.equal(isSyntheticLeg(leg), false, `${k} = 1 → a real leg`);
  }
  // an UNRECOGNISED model that really consumed and produced tokens is a leg, not a placeholder
  assert.equal(isSyntheticLeg({ model: 'claude-zed-9', inT: 2, cw: 0, cr: 40000, out: 900 }), false);
  assert.equal(isSyntheticLeg({ model: 'some-brand-new-model', inT: 0, cw: 0, cr: 0, out: 1 }), false);
});

test('Y5 — evaluated on the DEDUPED record: a placeholder repeated under one id is skipped once and steals no dedup slot', () => {
  // Main transcripts repeat one message.id per content block. A LINE-level predicate would drop a
  // real leg that happened to share an id group with a placeholder; an id-level one cannot.
  const tmp = join(tmpdir(), `legscan-synth-${process.pid}.jsonl`);
  const mk = (id, model, u, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage: {
    input_tokens: u[0], cache_creation_input_tokens: u[1], cache_read_input_tokens: u[2], output_tokens: u[3],
    cache_creation: { ephemeral_1h_input_tokens: u[1], ephemeral_5m_input_tokens: 0 } } } });
  writeFile(tmp, [
    mk('r1', OPUS, [2, 57000, 0, 300], '2026-06-18T00:00:00.000Z'),
    mk('s1', '<synthetic>', [0, 0, 0, 0], '2026-06-18T00:01:00.000Z'),   // three lines, one id
    mk('s1', '<synthetic>', [0, 0, 0, 0], '2026-06-18T00:01:01.000Z'),
    mk('s1', '<synthetic>', [0, 0, 0, 0], '2026-06-18T00:01:02.000Z'),
    mk('r2', OPUS, [2, 800, 57000, 200], '2026-06-18T00:02:00.000Z'),
    mk('r2', OPUS, [2, 800, 57000, 200], '2026-06-18T00:02:01.000Z'),    // an ordinary dup group
  ].join('\n') + '\n', 'utf8');
  try {
    const legs = getScannedLegs(tmp);
    assert.equal(legs.length, 2, 'two real legs, the placeholder group gone');
    assert.deepEqual(legs.map((l) => l.idx), [1, 2], 'and the surviving legs are renumbered 1..n');
    assert.ok(legs.every((l) => !isSyntheticLeg(l)), 'no placeholder survives');
    // The real leg after the placeholder keeps its own numbers — it did not inherit the skip.
    assert.equal(legs[1].cr, 57000);
    assert.equal(legs[1].units, 2 + 2 * 800 + 0.1 * 57000 + 5 * 200);
  } finally { rmSync(tmp, { force: true }); }
});

test('Y7 — ONE shared predicate: both scans call the same exported isSyntheticLeg', () => {
  // A future divergence between the transcript scan and the rollup scan would make the leg count and
  // the froz5 window disagree about what a turn is — the exact class of bug T3 fixes.
  const drv = readFileSync(join(home, 'leg-driver.mjs'), 'utf8');
  assert.match(drv, /export function isSyntheticLeg\(/, 'exported once from leg-driver');
  assert.equal((drv.match(/function isSyntheticLeg\(/g) || []).length, 1, 'defined exactly once');
  const sl = readFileSync(join(home, 'statusline.mjs'), 'utf8');
  assert.match(sl, /isSyntheticLeg/, 'statusline imports it');
  assert.ok(!/function isSyntheticLeg\(|const isSyntheticLeg\s*=/.test(sl), 'statusline must not define its own copy');
  const imports = sl.slice(0, sl.indexOf('\n\n', sl.indexOf('leg-driver.mjs')));
  assert.match(imports, /isSyntheticLeg/, 'and it comes from the leg-driver import block');
  // getScannedLegs (the trio's scan) calls it too — same module, so the same function by construction.
  const scan = drv.slice(drv.indexOf('export function getScannedLegs('));
  assert.match(scan, /isSyntheticLeg\(/, 'getScannedLegs applies the predicate');
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
