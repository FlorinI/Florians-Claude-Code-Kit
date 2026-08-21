import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// goldens-invariants — hand-computed pins on the COMMITTED parity goldens, independent of the
// bless mechanism. `--bless` regenerates goldens from current output, so a blind re-bless can
// silently absorb a regression; these literals came from the acceptance-examples arithmetic
// (2026-07-14 Claude-5 correctness sprint) and fail even after a bless. If one fails after an
// INTENDED behaviour change, recompute the number by hand from the examples doc — never copy
// the new output in.

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', 'tools', 'parity', 'fixtures');
const sidecar = (f) => JSON.parse(readFileSync(join(FIX, f, 'golden-sidecar.json'), 'utf8'));
const stdout = (f) => readFileSync(join(FIX, f, 'golden.txt'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
const facts = (f) => readFileSync(join(FIX, f, 'golden-facts.txt'), 'utf8');
const allFixtures = () => readdirSync(FIX).filter((n) => statSync(join(FIX, n)).isDirectory());

// ---- A: tier-weighted cost split -------------------------------------------------------------
test('A1 — mixed tiers, honest shares: $40 splits 37.50 / 2.50 (sonnet agent ×0.2)', () => {
  const s = sidecar('a1-tier-weighted');
  assert.equal(s.costUsd, 40);
  assert.equal(s.mainSessionUsd, 37.5); // 3.0M / 3.2M effective units × $40
  assert.equal(s.agentsUsd, 2.5);       // 0.2M / 3.2M × $40 — NOT the unweighted $10
  const line = stdout('a1-tier-weighted');
  assert.match(line, /\$2\.50 \(6%\)/);
  assert.match(line, /⚠ tier-mix main·fable \+ ag sonnet×1/);
});

test('A4 — attribution never changes the total: split sums to sessionCost to the cent', () => {
  for (const f of ['a1-tier-weighted', 'b2-mythos', 'b3-unmapped', 'a3-empty-model', 'b4-absent-model',
    // K9 (leg-pricing-truth sprint): tier-mix legs, resumed run, no-history, progressive agent, rebalanced switch
    'legs-tier-mix', 'resumed-run', 'resumed-nohistory', 'agents-progressive', 'model-switch']) {
    const s = sidecar(f);
    assert.notEqual(s.agentsUsd, null, `${f}: agentsUsd must be non-null (vacuity guard)`);
    const sessionCost = s.costUsd; // total_cost_usd IS session-local (CC resets it on /clear since 2.1.211)
    assert.ok(Math.abs(s.mainSessionUsd + s.agentsUsd - sessionCost) < 0.005,
      `${f}: ${s.mainSessionUsd} + ${s.agentsUsd} != ${sessionCost}`);
  }
});

test('A6 — handover-facts KPI consumes the corrected agentsUsd ($2.50, tier minor)', () => {
  const f = facts('a1-tier-weighted');
  assert.match(f, /COST_DETAIL: main `\$37\.50` · agents `\$2\.50` over `1` legs/);
  assert.match(f, /COST_AGENTS_TIER: minor/);
});

test('A3/B4 — empty-string and absent model: invisible, weight 1.0 ($10.00, no chip)', () => {
  for (const f of ['a3-empty-model', 'b4-absent-model']) {
    const s = sidecar(f);
    assert.equal(s.agentsUsd, 10); // 1.0M of 4.0M units × $40 — unweighted
    assert.ok(!stdout(f).includes('tier-mix'), `${f}: chip must not fire`);
  }
});

// ---- B: chip + families -----------------------------------------------------------------------
test('B1 — chip names main separately; agents head-count stays 12', () => {
  const line = stdout('b1-chip-main');
  assert.match(line, /agents: 12 \|/);
  assert.match(line, /⚠ tier-mix main·fable \+ ag fable×11·sonnet×1/);
});

test('B2 — mythos weighted at its map price (opus main: $20.00, not the weight-1.0 $12.50)', () => {
  const s = sidecar('b2-mythos');
  assert.equal(s.agentsUsd, 20); // 1.0M × (10/5) = 2.0M of 5.0M × $50
  assert.equal(s.mainSessionUsd, 30);
  assert.match(stdout('b2-mythos'), /⚠ tier-mix main·opus \+ ag mythos×1/);
});

test('B3 — unmapped id is visible as `other`, weighted 1.0', () => {
  const s = sidecar('b3-unmapped');
  assert.equal(s.agentsUsd, 10); // weight 1.0: 1.0M of 4.0M × $40
  assert.match(stdout('b3-unmapped'), /⚠ tier-mix main·fable \+ ag other×1/);
});

test('B1-format also landed on the pre-existing tier-mix fixture', () => {
  assert.match(stdout('tier-mix'), /⚠ tier-mix main·opus \+ ag opus×1·sonnet×1/);
});

test('B5 — uniform tiers / model-less agents: no chip (regression guard)', () => {
  for (const f of ['tier-same', 'tier-nomodel']) {
    assert.ok(!stdout(f).includes('tier-mix'), `${f}: chip must not fire`);
  }
});

// ---- C: median regression ----------------------------------------------------------------------
test('C1 — even count [79.4k, 174.9k]: med 127.2k, never the max (2026-06-24 screenshot bug)', () => {
  const line = stdout('median-even');
  assert.match(line, /med 127\.2k/);
  assert.ok(!line.includes('med 174.9k'), 'upper-median bug: med must not equal max');
  assert.match(line, /max 174\.9k/);
});

test('C2 — single agent: med == max == 43.2k is legitimate', () => {
  assert.match(stdout('median-single'), /med 43\.2k·max 43\.2k/);
});

// ---- D: model switch ----------------------------------------------------------------------------
test('D1 — sidecar carries modelSwitch {atLeg: 13, from, to} on a tier change', () => {
  const s = sidecar('model-switch');
  assert.deepEqual(s.modelSwitch, { atLeg: 13, from: 'Fable 5 (1M context)', to: 'Sonnet 5' });
});

test('D1 — no-switch fixtures carry NO modelSwitch key (golden blast radius stays contained)', () => {
  for (const f of ['a1-tier-weighted', 'agents', 'small-young', 'tier-mix', 'warmtax']) {
    assert.ok(!('modelSwitch' in sidecar(f)), `${f}: unexpected modelSwitch key`);
  }
});

test('D2 — the fifth cause is GATED: it preempts only where the baseline is NOT full strength', () => {
  // REWRITTEN by the froz5-truth sprint (2026-08-21, decision D11). Before it, a stamped
  // `modelSwitch` preempted the four depth causes unconditionally, so the fact sheet printed "the
  // ratio and the depth curve do not apply" — over a number this sprint makes correct. That would
  // have thrown away the sprint's own win, so the preempt now requires a weak anchor
  // (freshLegN < FRESH_N, or no baseline at all) and at full strength the switch is appended as a
  // dollar-comparability caveat instead. Asserted as a SWEEP, so the blast radius is pinned across
  // every fixture rather than on one.
  const FRESH_N = 5;
  for (const f of allFixtures()) {
    const s = sidecar(f);
    const txt = facts(f);
    if (!txt.includes('cause=model-switched')) continue;
    const weak = s.freshLegN == null || Number(s.freshLegN) < FRESH_N || s.froz5Ratio == null;
    assert.ok(weak, `${f}: the fifth cause preempted on a FULL-STRENGTH anchor (freshLegN ${s.freshLegN}, ratio ${s.froz5Ratio}) — D11's gate is not holding`);
  }
  // model-switch is the fixture at exactly full strength, and it is the boundary case: the depth
  // cause must resolve and the switch must survive as a caveat, naming both models.
  const ms = sidecar('model-switch');
  assert.equal(ms.freshLegN, FRESH_N, 'model-switch sits exactly at full strength');
  const f = facts('model-switch');
  assert.match(f, /COST_FROZ5: cause=(heavy-start|light-start|cold-pumped|on-curve)/, 'a depth cause resolves');
  assert.ok(!f.includes('cause=model-switched'), 'and the fifth cause does NOT preempt');
  assert.match(f, /Fable 5 \(1M context\) → Sonnet 5 at leg 13/, 'the switch is still reported, as a caveat');
});

// ---- E: warm-rewrite tax gloss -------------------------------------------------------------------
test('E1 — Sonnet main: tax glossed as expected (CC 2.1.201)', () => {
  assert.match(facts('warmtax-sonnet'), /WARM_REWRITE_TAX: .*expected — CC 2\.1\.201 dropped cache-preserving injection on Sonnet 5/);
});

test('E2 — Opus main: tax glossed as unexpected/worth a look', () => {
  assert.match(facts('warmtax'), /WARM_REWRITE_TAX: .*unexpected on this model — worth a look/);
});

test('E3 — zero tax: no model clause at all', () => {
  const f = facts('warmtax-first');
  assert.match(f, /WARM_REWRITE_TAX: \(none\)/);
  assert.ok(!f.includes('worth a look') && !f.includes('CC 2.1.201'));
});

// ---- G: gap-week guard ----------------------------------------------------------------------------
test('G1 — sonnet/haiku main: dim chip on the cost cluster + COST_GATES_NOTE emit', () => {
  for (const f of ['gapweek-sonnet', 'small-young', 'no-transcript']) {
    assert.match(stdout(f), /⚠ \$-gates Fable\/Opus-calibrated/, `${f}: chip missing`);
    assert.match(facts(f), /COST_GATES_NOTE: \$ thresholds calibrated for Fable\/Opus pricing/, `${f}: emit missing`);
  }
});

test('G2 — Fable/Opus main: no chip, no COST_GATES_NOTE', () => {
  for (const f of ['a1-tier-weighted', 'b2-mythos', 'agents', 'warmtax']) {
    assert.ok(!stdout(f).includes('$-gates'), `${f}: chip must not fire`);
    assert.ok(!facts(f).includes('COST_GATES_NOTE'), `${f}: emit must not fire`);
  }
});

// ---- H: costBaseline removal (2026-07-27 Phase 1 sprint, M2) ------------------------------------
test('H1 — costBaseline is GONE from every golden sidecar (mechanism removed outright)', () => {
  for (const f of allFixtures()) {
    assert.ok(!('costBaseline' in sidecar(f)), `${f}: stale costBaseline key in golden`);
  }
});

// ---- I: turn-TPS message.id dedup (2026-07-27 Phase 1 sprint, M1) -------------------------------
// Hand-computed pin: the tps-dedup transcript's last turn is msg A ×3 adjacent duplicate lines
// (same message.id, output_tokens 500 → counts ONCE) + one id-less usage line (150 → still counts,
// cannot be deduped) + msg B (distinct id, 250), over a 10 s turn (file mtime pinned to the last
// content timestamp by the harness). (500 + 150 + 250) / 10 = 90 — pre-fix the duplicates made it
// (1500 + 150 + 250) / 10 = 190. No stdout pin: the session line carrying the tps chip is
// display-gated off (ShowSessionLine = false, statusline.mjs), so the sidecar `tps` — the single
// computation site feeding both — is the assertable surface.
test('I1 — turn-TPS dedups per-content-block duplicate lines: tps == 90, not 190', () => {
  assert.equal(sidecar('tps-dedup').tps, 90);
});

// ---- J: froz5 warm-open marker (2026-07-27 Phase 1 M3; re-gated by behaviour in froz5-recal, F4) --
test('J1 — froz5CalibStale only on the two warm-open fixtures {froz5-stale, bucketed} (golden blast radius)', () => {
  const WARM_OPEN = new Set(['froz5-stale', 'bucketed']);
  for (const f of allFixtures()) {
    if (WARM_OPEN.has(f)) assert.equal(sidecar(f).froz5CalibStale, true, `${f}: marker expected`);
    else assert.ok(!('froz5CalibStale' in sidecar(f)), `${f}: unexpected froz5CalibStale key`);
  }
});

test('J2 — froz5-stale (leg 1 read a 12k prefix): flag present, chip `2.2x?`, facts era=warm-open + corrected caveat', () => {
  const s = sidecar('froz5-stale');
  assert.equal(s.froz5CalibStale, true);
  assert.equal(s.firstLegColdStart, false);
  assert.match(stdout('froz5-stale'), /2\.2x\?/); // keepwarm legs 2–6 median = 10,000 units = the old first-5 mean → 2.2 still
  const f = facts('froz5-stale');
  assert.match(f, /COST_FROZ5: cause=[a-z-]+; .*confidence=low; era=warm-open \(curve fit on post-2\.1\.209 cold-start sessions\)/);
  assert.match(f, /COST_CHAR: .*low confidence: this session opened on a warm shared prefix \(pre-2\.1\.209 regime, or a sibling-warmed launch\)/);
  assert.ok(!f.includes('prompt cut') && !f.includes('curve=stale'), 'the pre-fit caveat is gone');
});

// ---- K: leg-pricing-truth (2026-08-16 sprint) — tier-true, run-anchored per-leg $ ------------------
// Hand-computed at list price (S1 weights in 1 · cw1h 2 · cr 0.10 · out 5; TIER_BASE fable 10 · opus 5 ·
// sonnet 2 $/MTok). See .claude/plans/2026-08-16-leg-pricing-truth-test-plan.md §2 for the arithmetic.
const spikes = (f) => readFileSync(join(FIX, f, 'golden-spikes.txt'), 'utf8');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('K1 — legs-tier-mix: a Sonnet opening leg on a Fable main prices at Sonnet (0.2797, never 0.83)', () => {
  const s = sidecar('legs-tier-mix');
  // leg 1: 2 + 69,900×2 + 10×5 = 139,852 raw × 0.2 = 27,970.4 eff × 1e-5
  assert.deepEqual(s.legCosts, [0.2797, 0.77, 0.4, 0.2]);
  near(s.base, 1e-5, 1e-12, 'base');
  // froz5-recal (F6): warm legs = 3,4 only (shares 1.00 / 0.30 / 0.05 / 0.02) → median(40,000, 20,000) × 1e-5;
  // own tail median 50,000 + 0.1 × 107,000 = 60,700 units → ratio 2.0233; provisional (2 of 5).
  near(s.freshLegUsd, 0.30, 1e-9, 'freshLegUsd');
  near(s.froz5Ratio, 2.0233, 1e-3, 'froz5Ratio');
  assert.equal(s.freshLegN, 2);
  assert.equal(s.firstLegColdStart, true);
  assert.equal(s.openingLegCw, 69900);
  assert.match(stdout('legs-tier-mix'), /= 2\.0x \$0\.30 \(fresh\)/);
  assert.match(facts('legs-tier-mix'), /; baseline=provisional \(2 of 5 warm legs\)/);
  assert.match(facts('legs-tier-mix'), /confidence=low/);
  assert.equal(s.mainSessionUsd, 1.65);
  assert.equal(s.agentsUsd, 0);
  assert.equal(s.runStartLeg, 0);
  assert.ok(!('legPricingSuspect' in s), 'healthy session must not trip the tripwire');
  assert.ok(!('modelSwitch' in s), 'payload model is constant — no switch');
  const line = stdout('legs-tier-mix');
  for (const cell of ['$0.28', '$0.77', '$0.40', '$0.20']) assert.ok(line.includes(cell), `sparkline cell ${cell}`);
  assert.ok(!line.includes('$0.83'), 'the Fable-dominated blend price must not appear');
  const sp = spikes('legs-tier-mix');
  const order = ['Leg 2  ·  $0.77', 'Leg 3  ·  $0.40', 'Leg 1  ·  $0.28'].map((t) => sp.indexOf(t));
  assert.ok(order.every((i) => i >= 0), `spikes rows present: ${order}`);
  assert.ok(order[0] < order[1] && order[1] < order[2], `spikes rows in $ order: ${order}`);
});

test('K2 — resumed-run: the new leg costs what CC says; earlier legs at this run\'s rate; facts say resumed', () => {
  const s = sidecar('resumed-run');
  assert.equal(s.runStartLeg, 12);
  assert.equal(s.legCosts.length, 13);
  assert.ok(s.legCosts.every((c) => c === 0.5), `every leg 0.5: ${s.legCosts}`);
  near(s.base, 5e-6, 1e-12, 'base');
  assert.equal(s.mainSessionUsd, 0.5);
  assert.equal(s.lastLegUsd, 0.5);
  assert.ok(!('legPricingSuspect' in s));
  assert.match(facts('resumed-run'), /COST_RUN_NOTE: resumed session — legs 1–12 predate this run; the total covers this run only, earlier legs are priced\s+at this run's rate/);
  assert.match(stdout('resumed-run'), /last leg \$0\.50/);
});

test('K3 — resumed-nohistory: flagged, never faked (legs stay CC-anchored at $0.04, suspect chip + note)', () => {
  const s = sidecar('resumed-nohistory');
  assert.equal(s.legPricingSuspect, true);
  assert.equal(s.runStartLeg, 0);
  assert.equal(s.legCosts[0], 0.0385);
  const legsLine = stdout('resumed-nohistory').split('\n').find((l) => l.includes('$/leg'));
  assert.ok(legsLine, '$/leg line present');
  assert.ok(legsLine.trimEnd().endsWith('⚠ leg $ suspect: base far below list (resumed without history?)'), `chip at line end: ${JSON.stringify(legsLine)}`);
  const f = facts('resumed-nohistory');
  assert.match(f, /COST_RUN_NOTE: leg \$ suspect — session rate far below list price \(resumed without local history\?\); per-leg \$ are\s+understated, the total is CC's own/);
  assert.ok(!f.includes('resumed session —'), 'no detected-resume note without a stats seed');
});

test('K4 — agents-progressive: streamed agent output counted in full (agents $0.25 of $0.751)', () => {
  const s = sidecar('agents-progressive');
  assert.equal(s.agentsUsd, 0.25);
  assert.equal(s.mainSessionUsd, 0.5);
  near(s.base, 1e-5, 1e-12, 'base');
  assert.equal(s.nAgents, 1);
  const sp = spikes('agents-progressive');
  assert.match(sp, /top 1 agents\s+·\s+of 1\s+·\s+\$0\.25 \(33%\)/);
  assert.match(sp, /mostly generating output \(~5k out\)/);
  assert.match(stdout('agents-progressive'), /\$0\.25 \(33%\)/);
});

// every fixture that renders agents: transcript/subagents/ on disk, or an agents cache in seed/
const agentFixtures = () => allFixtures().filter((f) => {
  if (existsSync(join(FIX, f, 'transcript', 'subagents'))) return true;
  const sd = join(FIX, f, 'seed', 'statusline-stats');
  return existsSync(sd) && readdirSync(sd).some((n) => n.endsWith('.agents.json'));
});

test('K5 — the spikes agent panel quotes the same dollars as the agents chip, every agent fixture', () => {
  const fx = agentFixtures();
  assert.ok(fx.length >= 16, `expected ≥16 agent fixtures, found ${fx.length}: ${fx}`);
  for (const f of fx) {
    const s = sidecar(f);
    const m = spikes(f).match(/^top \d+ agents\s+·\s+of \d+\s+·\s+\$([\d.]+)/m);
    assert.ok(m, `${f}: agent panel header missing in golden-spikes.txt`);
    assert.equal(m[1], Number(s.agentsUsd).toFixed(2), `${f}: panel total vs sidecar agentsUsd`);
  }
  // spot pins from the acceptance arithmetic (tier-weighted, not raw)
  assert.match(spikes('a1-tier-weighted'), /top 1 agents\s+·\s+of 1\s+·\s+\$2\.50 \(6%\)/); // raw pricing would say $12.50
  assert.match(spikes('tier-mix'), /\$2\.06 \(43%\)/);
  assert.match(spikes('b2-mythos'), /\$20\.00 \(40%\)/);
  assert.match(spikes('b3-unmapped'), /top 1 agents\s+·\s+of 1\s+·\s+\$10\.00/);
  assert.match(spikes('b4-absent-model'), /top 1 agents\s+·\s+of 1\s+·\s+\$10\.00/);
});

test('K6 — model-switch on RAW units: the multiple and the fresh-leg $ move, every dollar stays put', () => {
  // model-switch is the sprint's ONE permitted mover (froz5-truth, 2026-08-21). Its twelve opening
  // legs are Fable under a Sonnet label, so the retired accessor multiplied each by
  // TIER_BASE.fable / TIER_BASE.sonnet = 5 — inflating the baseline to 500,000 units ($1.00) and
  // deflating the multiple to 0.23×. Raw units give 100,000 units ($0.20) and 1.15×.
  //
  // Note the DIRECTION: here the label names the CHEAPER tier, so the old baseline was too LARGE and
  // the corrected multiple RISES. On a session whose label names the dearer tier (froz5-tier-unserved,
  // froz5-offtier-open) it falls. The fix removes a distortion; it does not push one way.
  const s = sidecar('model-switch');
  // ── the two fields §6.2 permits to move, and their exact new values
  near(s.freshLegUsd, 0.2, 1e-9, 'fresh-leg $ = 100,000 raw units × base 2e-6');
  assert.equal(s.froz5Ratio, 1.15, 'multiple = nextLegUsd / freshLegUsd = 0.23 / 0.20');
  assert.equal(s.freshLegN, 5, 'the anchor strength itself did not move');
  assert.match(stdout('model-switch'), /next \$0\.23 = 1\.1x \$0\.20 \(fresh\)/);
  // ── and the AE-17 evidence: every dollar is byte-for-byte what it was before the change
  assert.equal(s.costUsd, 12.2, 'session total');
  assert.equal(s.legCosts[0], 1, 'first per-leg cell');
  assert.equal(s.legCosts[12], 0.2, 'last per-leg cell');
  near(s.nextLegUsd, 0.23, 1e-9, 'next-leg $'); // 115,000 raw × 2e-6 — the forecast was always raw
  near(s.lastLegUsd, 0.2, 1e-9, 'last-leg $');
  near(s.base, 2e-6, 1e-12, 'base');
  assert.deepEqual(s.modelSwitch, { atLeg: 13, from: 'Fable 5 (1M context)', to: 'Sonnet 5' }, 'D1 stays');
  assert.ok(!('legPricingSuspect' in s));
  // The fall/rise factor is exactly the weight that was removed — nothing else entered.
  near(1 / (s.froz5Ratio / 0.23), 0.2, 1e-9, 'the multiple moved by exactly 1 / tierWeight(fable, sonnet) = 1/5');
});

test('K7 — schema 5 + runStartLeg present in every golden sidecar (0 / 12 with a transcript, null without)', () => {
  for (const f of allFixtures()) {
    const s = sidecar(f);
    assert.equal(s.schema, 5, `${f}: schema`);
    assert.ok('runStartLeg' in s, `${f}: runStartLeg missing`);
    if (s.nLegs === null) assert.equal(s.runStartLeg, null, `${f}: no rollup → null`);
    else assert.ok(s.runStartLeg === 0 || s.runStartLeg === 12, `${f}: runStartLeg ${s.runStartLeg}`);
  }
});

test('K8 — legPricingSuspect key only on resumed-nohistory (golden blast radius)', () => {
  for (const f of allFixtures()) {
    if (f === 'resumed-nohistory') continue;
    assert.ok(!('legPricingSuspect' in sidecar(f)), `${f}: unexpected legPricingSuspect key`);
  }
});

test('K10 — no agent panel where no agents exist', () => {
  for (const f of ['small-young', 'incremental', 'legs-tier-mix', 'resumed-run']) {
    assert.ok(!/^top \d+ agents/m.test(spikes(f)), `${f}: unexpected agent panel`);
  }
});

test('J3 — marker never touches the number: ratio/state identical to the clone parent keepwarm-1h', () => {
  const a = sidecar('froz5-stale');
  const b = sidecar('keepwarm-1h');
  assert.equal(a.froz5Ratio, b.froz5Ratio); // 2.2 — raw signal, no cap/smoothing/suppression
  assert.equal(a.froz5State, b.froz5State); // chip color driver unchanged
  // parent stays confidence=ok — proves the ok→low flip above is the warm-open gate, nothing else
  assert.match(facts('keepwarm-1h'), /confidence=ok/);
  assert.ok(!stdout('keepwarm-1h').includes('x?'), 'parent chip must not carry the ? suffix');
  assert.ok(!('froz5CalibStale' in b), 'parent (leg 1 cr 0, cw 5000 — unknown shape) carries no marker');
});

// ---- L: froz5-recal (2026-08-16 sprint 2) — shape-based fresh baseline, era by behaviour, schema 5 ---
// Hand-computed from the spec's F1 / F3 tables (S1 weights, 1h writes, opus list 5e-6 $/unit); see
// .claude/plans/2026-08-16-froz5-recalibration-test-plan.md §4.3.
const withTranscript = (f) => existsSync(join(FIX, f, 'transcript.jsonl'));
// Fixtures whose leg 1 is the post-2.1.209 cold-start opener (cr 0 · in ≤ 100 · cw ≥ 8000), read off the
// transcripts: keepwarm-5m (in 0 · cw exactly 8000 — the boundary), legs-tier-mix (in 2 · cw 69,900), and the
// two F1/F3 fixtures. Every other transcript opener fails a clause (agents/capped/… carry in 200; small-young /
// tps-dedup in 150; bucketed / froz5-stale read a prefix; warmtax-first carries 1000 in; the a/b/median/agents-
// progressive/model-switch/resumed-* openers are output-only or prompt-less).
// froz5-truth sprint (2026-08-21) adds five fixtures whose leg 1 is a post-2.1.209 cold-start opener
// (cr 0, inT ≤ 100, cw ≥ 8k): the two real-session reductions, the mismatch-chip fixture, the
// low-warm fallback fixture, and the placeholder twin of fresh-fallback. session-name-hostile clones
// session-named's output-only legs, so its opener is NOT a cold start and it stays out of this set.
const COLD_START = new Set(['keepwarm-5m', 'legs-tier-mix', 'fresh-post209', 'fresh-fallback',
  'froz5-tier-mislabel', 'froz5-offtier-open', 'froz5-tier-unserved', 'froz5-lowwarm-single', 'froz5-synthetic-mid']);
const SHORT_OUTPUT_ONLY = ['a1-tier-weighted', 'a3-empty-model', 'b1-chip-main', 'b2-mythos', 'b3-unmapped', 'b4-absent-model', 'median-even', 'median-single', 'agents-progressive'];

test('L1 — fresh-post209 (F1): the baseline is a warm leg ($0.06), the opener reads "opened cold ~57k"', () => {
  const s = sidecar('fresh-post209');
  near(s.freshLegUsd, 0.05891, 1e-5, 'freshLegUsd'); // median(8302, 11782, 12082, 19302, 11602) = 11,782 × 5e-6
  near(s.froz5Ratio, 1.7062, 1e-3, 'froz5Ratio');    // (0.1 × 91,000 + 11,002) / 11,782
  near(s.nextLegUsd, 0.10051, 1e-5, 'nextLegUsd');
  assert.equal(s.freshLegN, 5);
  assert.equal(s.firstLegColdStart, true);
  assert.equal(s.openingLegCw, 57000);
  near(s.legCosts[0], 0.5775, 1e-9, 'legCosts[0]');  // 115,502 × 5e-6
  near(s.base, 5e-6, 1e-12, 'base');
  assert.ok(!('froz5CalibStale' in s), 'cold-start opener → no marker');
  assert.equal(s.schema, 5);
  assert.match(stdout('fresh-post209'), /next \$0\.10 = 1\.7x \$0\.06 \(fresh\)/);
  assert.ok(!stdout('fresh-post209').includes('x?'));
  assert.match(spikes('fresh-post209'), /Leg 1  ·  \$0\.58  ·  opened cold ~57k \(whole context written, no cached prefix\)/);
  assert.ok(!spikes('fresh-post209').includes('warm rewrite'), 'the opener is never a warm rewrite');
  const f = facts('fresh-post209');
  assert.ok(!f.includes('provisional'), 'five warm legs → not provisional');
  assert.match(f, /WARM_REWRITE_TAX: \(none\)/);
  assert.match(f, /COST_FROZ5: cause=[a-z-]+; froz5 `1\.71×` vs `1\.50×` typical at this depth/); // curve at 91k = 1.38 + 0.30 × 0.41
  assert.match(f, /confidence=ok/);
});

test('L2 — fresh-fallback (F3): window closed with 0 warm legs → fallback on legs 2–6 ($0.27), not provisional', () => {
  const s = sidecar('fresh-fallback');
  near(s.freshLegUsd, 0.26751, 1e-5, 'freshLegUsd'); // median(45,502 … 61,502) = 53,502 × 5e-6
  assert.equal(s.freshLegN, 5);
  assert.equal(s.firstLegColdStart, true);
  assert.equal(s.openingLegCw, 57000);
  assert.equal(s.nLegs, 13);
  near(s.legCosts[0], 0.5775, 1e-9, 'legCosts[0]');
  assert.match(stdout('fresh-fallback'), /\$0\.27 \(fresh\)/);
  assert.ok(!facts('fresh-fallback').includes('provisional'));
  assert.match(spikes('fresh-fallback'), /Leg 1  ·  \$0\.58  ·  opened cold ~57k/);
});

test('L3 — warm-rewrite gloss by Sonnet generation: 4.6 informational (no 2.1.201), Sonnet 5 expected, Opus worth a look', () => {
  const f46 = facts('warmtax-sonnet46');
  assert.match(f46, /WARM_REWRITE_TAX: .*informational on this Sonnet generation — it never had cache-preserving injection, so a rewrite here is not a regression signal/);
  assert.ok(!f46.includes('2.1.201'), 'Sonnet 4.6 never cites the 2.1.201 rollback');
  assert.ok(!f46.includes('worth a look'));
  assert.equal(sidecar('warmtax-sonnet46').model, 'Sonnet 4.6 (1M context)');
  // the byte-copy parent and the Opus sibling keep E1 / E2; E3 (zero tax) unchanged
  assert.match(facts('warmtax-sonnet'), /expected — CC 2\.1\.201 dropped cache-preserving injection on Sonnet 5/);
  assert.match(facts('warmtax'), /unexpected on this model — worth a look/);
  assert.match(facts('warmtax-first'), /WARM_REWRITE_TAX: \(none\)/);
  // same transcript → same dollars: only the gloss differs between warmtax-sonnet and -sonnet46
  const a = sidecar('warmtax-sonnet'), b = sidecar('warmtax-sonnet46');
  assert.deepEqual(a.legCosts, b.legCosts);
  assert.equal(a.froz5Ratio, b.froz5Ratio);
});

test('L4 — opening-leg spotlight labels: cold-start openers read "opened cold", others "loaded … new context", never "warm rewrite"', () => {
  assert.match(spikes('legs-tier-mix'), /Leg 1  ·  \$0\.28  ·  opened cold ~70k \(whole context written, no cached prefix\)/);
  assert.match(spikes('keepwarm-5m'), /Leg 1  ·  \$0\.20  ·  opened cold ~8k \(whole context written, no cached prefix\)/); // cw = 8000, the boundary
  assert.match(spikes('warmtax-first'), /Leg 1  ·  \$1\.35  ·  loaded ~200k new context/);   // 1000 fresh input → not cold-start; no longer "re-cached"
  assert.match(spikes('agents'), /Leg 1  ·  \$1\.48  ·  loaded ~40k new context/);           // in 200 > 100 → not cold-start
  for (const f of allFixtures()) {
    if (!withTranscript(f)) continue;
    const m = spikes(f).match(/^\s*(?:❆\s+)?Leg 1  ·  \$[\d.]+  ·  (.*)$/m);
    if (m) assert.ok(!m[1].includes('warm rewrite'), `${f}: Leg 1 labelled as a warm rewrite: ${m[1]}`);
  }
});

test('L5 — schema-5 sweep (F8): the three new keys typed per fixture; firstLegColdStart true exactly on the cold-start openers', () => {
  for (const f of allFixtures()) {
    const s = sidecar(f);
    assert.equal(s.schema, 5, `${f}: schema`);
    for (const k of ['firstLegColdStart', 'openingLegCw', 'freshLegN']) assert.ok(k in s, `${f}: ${k} missing`);
    if (withTranscript(f)) {
      assert.equal(typeof s.firstLegColdStart, 'boolean', `${f}: firstLegColdStart type`);
      assert.ok(Number.isInteger(s.openingLegCw), `${f}: openingLegCw int`);
      assert.ok(Number.isInteger(s.freshLegN), `${f}: freshLegN int`);
      assert.equal(s.firstLegColdStart, COLD_START.has(f), `${f}: firstLegColdStart`);
    } else {
      assert.equal(s.firstLegColdStart, null, `${f}: no transcript → null`);
      assert.equal(s.openingLegCw, null, `${f}: no transcript → null`);
      assert.equal(s.freshLegN, null, `${f}: no transcript → null`);
    }
  }
});

test('L6 — froz5 trio consistency: ratio / freshLegUsd / state null together ⇔ freshLegN 0; marker only on the two warm-open fixtures', () => {
  for (const f of allFixtures()) {
    const s = sidecar(f);
    if (!withTranscript(f)) continue;
    const nulls = [s.froz5Ratio == null, s.freshLegUsd == null, s.froz5State == null];
    assert.ok(nulls.every((x) => x === nulls[0]), `${f}: froz5 trio must be null together: ${JSON.stringify([s.froz5Ratio, s.freshLegUsd, s.froz5State])}`);
    assert.equal(nulls[0], s.freshLegN === 0, `${f}: trio null ⇔ freshLegN 0 (freshLegN ${s.freshLegN})`);
    if (s.froz5CalibStale === true) assert.ok(['bucketed', 'froz5-stale'].includes(f), `${f}: unexpected marker`);
  }
});

test('L7 — short output-only fixtures: no ratio chip, trio null, "no cost trend yet"; the agent panel dollars stand', () => {
  for (const f of SHORT_OUTPUT_ONLY) {
    const s = sidecar(f);
    assert.equal(s.froz5Ratio, null, `${f}: froz5Ratio`);
    assert.equal(s.freshLegN, 0, `${f}: freshLegN`);
    assert.equal(s.firstLegColdStart, false, `${f}: firstLegColdStart`);
    assert.ok(!stdout(f).includes('(fresh)'), `${f}: no ratio chip`);
    assert.match(stdout(f), /next \$/, `${f}: next $ still shown`);
    assert.match(facts(f), /COST_CHAR: no cost trend yet/, `${f}: facts`);
    assert.match(facts(f), /COST_FROZ5: cause=unknown \(curve n\/a/, `${f}: no cause`);
  }
});

test('L8 — model-switch / resumed-*: 12 output-only legs → fallback = legs 1–5 = median = mean; dollars unchanged', () => {
  const ms = sidecar('model-switch');
  // Raw units (froz5-truth, 2026-08-21): 100,000 units × base 2e-6. Was $1.00 under the retired
  // tier-weighted accessor, which multiplied these Fable legs by 5 against the Sonnet label. The
  // FALLBACK ARM and the picked legs are unchanged — only the price basis moved.
  near(ms.freshLegUsd, 0.2, 1e-9, 'model-switch freshLegUsd');
  assert.equal(ms.freshLegN, 5);
  assert.equal(ms.firstLegColdStart, false);
  assert.equal(ms.openingLegCw, 0);
  const rr = sidecar('resumed-run');
  assert.equal(rr.freshLegUsd, 0.5);
  assert.equal(rr.freshLegN, 5);
  assert.equal(rr.firstLegColdStart, false);
  assert.equal(rr.openingLegCw, 0);
  const rn = sidecar('resumed-nohistory');
  near(rn.freshLegUsd, 100000 * rn.base, 1e-9, 'resumed-nohistory freshLegUsd = 100,000 units × base'); // 0.0385-shaped
  assert.equal(rn.freshLegN, 5);
  assert.equal(rn.firstLegColdStart, false);
  assert.equal(rn.openingLegCw, 0);
  assert.match(facts('resumed-run'), /COST_RUN_NOTE: resumed session/);
});

test('L9 — froz5-stale vs keepwarm-1h: the F4 reshape adds exactly 1,200 units (leg 1 +12k read); ratio/state equal', () => {
  const a = sidecar('froz5-stale'), b = sidecar('keepwarm-1h');
  // parent: Σ 100,000 units at $2.00 → base 2e-5, legCosts[0] = 10,000 × base = 0.20
  near(b.base * 100000, 2.0, 1e-9, 'keepwarm-1h Σunits');
  near(b.legCosts[0], 0.2, 1e-9, 'keepwarm-1h legCosts[0]');
  // reshaped: Σ 101,200 → base 2/101,200; legCosts[0] = 11,200 × base
  near(a.base * 101200, 2.0, 1e-9, 'froz5-stale Σunits = parent + 1,200');
  // legCosts are stored at 4 dp → tolerance 5e-5
  near(a.legCosts[0], 11200 * a.base, 5e-5, 'froz5-stale legCosts[0] = 11,200 units × base');
  assert.equal(a.legCosts.length, b.legCosts.length);
  for (let i = 1; i < a.legCosts.length; i++) near(a.legCosts[i], 10000 * a.base * (i === 5 ? 5 : 1), 5e-5, `froz5-stale legCosts[${i}]`);
  assert.equal(a.froz5Ratio, b.froz5Ratio);
  assert.equal(a.froz5State, b.froz5State);
  assert.equal(a.freshLegN, b.freshLegN);
  assert.equal(a.openingLegCw, 5000);
});

test('L10 — provisional tag ⇔ fewer than 5 warm legs, on every 1M fixture with a ratio', () => {
  let provisional = 0, full = 0;
  for (const f of allFixtures()) {
    const s = sidecar(f);
    if (!withTranscript(f) || s.froz5Ratio == null || Number(s.windowSize) < 700000 || 'modelSwitch' in s) continue;
    const fx = facts(f);
    if (s.freshLegN < 5) {
      provisional++;
      assert.match(fx, new RegExp(`; baseline=provisional \\(${s.freshLegN} of 5 warm legs\\)`), `${f}: provisional tag`);
      assert.match(fx, /confidence=low/, `${f}: confidence=low`);
    } else {
      full++;
      assert.ok(!fx.includes('provisional'), `${f}: no provisional tag at freshLegN 5`);
    }
  }
  assert.ok(provisional >= 10 && full >= 5, `vacuity guard: provisional ${provisional}, full ${full}`);
});
