import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// ---- A: tier-weighted cost split -------------------------------------------------------------
test('A1 — mixed tiers, honest shares: $40 splits 37.50 / 2.50 (sonnet agent ×0.2)', () => {
  const s = sidecar('a1-tier-weighted');
  assert.equal(s.costUsd, 40);
  assert.equal(s.costBaseline, 0);
  assert.equal(s.mainSessionUsd, 37.5); // 3.0M / 3.2M effective units × $40
  assert.equal(s.agentsUsd, 2.5);       // 0.2M / 3.2M × $40 — NOT the unweighted $10
  const line = stdout('a1-tier-weighted');
  assert.match(line, /\$2\.50 \(6%\)/);
  assert.match(line, /⚠ tier-mix main·fable \+ ag sonnet×1/);
});

test('A4 — attribution never changes the total: split sums to sessionCost to the cent', () => {
  for (const f of ['a1-tier-weighted', 'b2-mythos', 'b3-unmapped', 'a3-empty-model', 'b4-absent-model']) {
    const s = sidecar(f);
    assert.notEqual(s.agentsUsd, null, `${f}: agentsUsd must be non-null (vacuity guard)`);
    const sessionCost = s.costUsd - (s.costBaseline ?? 0);
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

test('D2 — fifth cause preempts: cause=model-switched, none of the four legacy causes', () => {
  const f = facts('model-switch');
  assert.match(f, /COST_FROZ5: cause=model-switched — ratio not comparable across the switch/);
  for (const c of ['cause=heavy-start', 'cause=light-start', 'cause=cold-pumped', 'cause=on-curve', 'cause=unknown']) {
    assert.ok(!f.includes(c), `legacy cause leaked: ${c}`);
  }
  assert.match(f, /Fable 5 \(1M context\) → Sonnet 5 at leg 13/);
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
