import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rowByLabel } from './_grid.mjs';

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
// BLESSED fixtures only. A fixture directory exists as soon as its inputs are written, but its
// goldens appear only when it is blessed — and the bless is deliberately a separate, reviewed act at
// the quality gate, not something a test run performs. Every sweep below reads goldens, so an
// unblessed directory would make them throw ENOENT instead of asserting. `tests/dossier-layout.test.mjs`
// owns the complementary check: that no fixture directory stays unblessed.
const allFixtures = () => readdirSync(FIX)
  .filter((n) => statSync(join(FIX, n)).isDirectory())
  .filter((n) => existsSync(join(FIX, n, 'golden.txt')));

// ---- froz5-removal (2026-08-21, bsl6.0.0.0) shared helpers -------------------------------------
// The seven sidecar keys the removal deletes (D3). Deleted, never display-gated off.
const REMOVED_KEYS = ['froz5Ratio', 'froz5State', 'freshLegUsd', 'freshLegN',
  'froz5CalibStale', 'firstLegColdStart', 'openingLegCw'];

// The recent-median chip on the cost row, ANSI-stripped. Dossier IV (2026-08-22) renamed the label
// from `last <N>` to `med<N>` (spec §6.3) — the realized last-leg figure is now labelled `last`, so a
// median two fields away called `last 8` would read as another member of the same series. The `| `
// field separator went with the same re-layout. The window count in the label is still the REAL
// count, `med2` … `med8`; that invariant is the whole reason this helper reads the number back out
// rather than assuming 8.
const chipOf = (f) => {
  const m = /med(\d+) \$([\d.,]+)/.exec(stdout(f));
  return m ? { n: Number(m[1]), usd: m[2] } : null;
};
// Independent half-to-even 2-dp formatter — the renderer's fmtN(x, 2) rounds half-to-EVEN, so
// toFixed(2) disagrees on exact ties (0.125 → 0.12, not 0.13). Deliberately not imported from
// home/_sl-compat.mjs: an independent computation is the point of this guard.
const fmt2 = (x) => {
  const [ip, dp = ''] = Math.abs(x).toFixed(30).split('.');
  let n = BigInt(ip + dp.slice(0, 2).padEnd(2, '0'));
  const rest = dp.slice(2), first = rest[0] ?? '0';
  if (first > '5') n += 1n;
  else if (first === '5') { if (/[1-9]/.test(rest.slice(1))) n += 1n; else if (n % 2n === 1n) n += 1n; }
  return `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
};
// D1's chip, as amended by spec §A1: the MEDIAN of the last min(8, len) entries of legCosts,
// suppressed below 2 legs. Even count → the mean of the two middle values, the convention the
// exported `median` already uses and the one the `next` forecast is computed with.
const windowOf = (s) => {
  const lc = Array.isArray(s.legCosts) ? s.legCosts.map(Number) : [];
  if (lc.length < 2) return null;
  return lc.slice(-Math.min(8, lc.length));
};
const medianOf = (win) => {
  const v = win.slice().sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const chipExpect = (s) => {
  const win = windowOf(s);
  return win ? { n: win.length, usd: fmt2(medianOf(win)) } : null;
};
// D2a's three-rung dollar ladder. The two floors are handover-facts.mjs's COST_FLOOR_* — unchanged
// in value by this sprint; only the gate that used to sit in front of them is gone.
const ladderCLevel = (nextUsd) =>
  (nextUsd == null || Number(nextUsd) < 0.28) ? 0 : (Number(nextUsd) < 0.45 ? 2 : 3);
const qLevelOf = (s) => Math.max(
  ({ pristine: 0, green: 0, yellow: 1, orange: 2, red: 3 })[String(s.ctxAbsState)] ?? 0,
  s.fillPct == null ? 0 : (Number(s.fillPct) < 50 ? 0 : (Number(s.fillPct) < 70 ? 2 : 3)));

// ---- A: tier-weighted cost split -------------------------------------------------------------
test('A1 — mixed tiers, honest shares: $40 splits 37.50 / 2.50 (sonnet agent ×0.2)', () => {
  const s = sidecar('a1-tier-weighted');
  assert.equal(s.costUsd, 40);
  assert.equal(s.mainSessionUsd, 37.5); // 3.0M / 3.2M effective units × $40
  assert.equal(s.agentsUsd, 2.5);       // 0.2M / 3.2M × $40 — NOT the unweighted $10
  const line = stdout('a1-tier-weighted');
  assert.match(line, /\$2\.50 6%/); // fleet line: no parens (spec §7.5)
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
  assert.match(line, /\b12 ag\b/);
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

// ---- C: median regression — SUPERSEDED, moved off the display (Dossier IV, 2026-08-22) ----------
//
// C1 and C2 asserted `med 127.2k` and `med 43.2k·max 43.2k` on the rendered agents line. The Dossier
// IV re-layout DELETES that display string — spec §7.5, a Florian deletion: "Medium and max, we could
// remove altogether. The whole parentheses can go." Left here, both rows would have gone green by
// losing their subject instead of by keeping their property true.
//
// REPLACED BY, and not merely deleted:
//   • tests/agent-ctx-median.test.mjs 0a — the median function on those exact two value sets
//     ([79,400 · 174,900] → 127,150, asserted NOT to be the 174,900 max), plus the general
//     even-count property so a literal cannot be special-cased to pass;
//   • tests/agent-ctx-median.test.mjs 0c — `agentCtxMax` still carries the peak these rows read off
//     the screen, swept across every agent fixture (the max half survives in the sidecar per spec §3);
//   • tests/source-invariants.test.mjs 0b — the engine's own unexported `Median` copy, by source shape.
//
// The bug they were built for stays covered: 2026-06-24, the median of two agent peak contexts
// rendering as the max. What changed is that the guard no longer reaches it through a string.
// The replacements were landed GREEN against the pre-change render before this deletion, so there was
// no window in which the tree was green because an assertion had been removed.

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

test('D2 — the model-switch note fires on modelSwitch ALONE, once, with no ratio/curve clause', () => {
  // REWRITTEN by the froz5-removal sprint (2026-08-21, D2c + D7). The note used to be one of two
  // mutually-exclusive branches split by fresh-leg anchor strength: `COST_CHAR`'s `model-switched`
  // cause on a weak anchor, a `COST_RUN_NOTE` caveat on a full-strength one. Both halves of that
  // gate died with the baseline, so ONE note now fires whenever the sidecar carries `modelSwitch` —
  // under its own label (`COST_MODELSWITCH_NOTE`, D7), never the shared `COST_RUN_NOTE`.
  // Asserted as a SWEEP so the blast radius is pinned across all 73, not on one fixture.
  let withSwitch = 0;
  for (const f of allFixtures()) {
    const s = sidecar(f);
    const txt = facts(f);
    const notes = txt.split('\n').filter((l) => l.startsWith('COST_MODELSWITCH_NOTE: '));
    if (s.modelSwitch) {
      withSwitch++;
      assert.equal(notes.length, 1, `${f}: modelSwitch set → exactly one COST_MODELSWITCH_NOTE (got ${notes.length})`);
      assert.ok(notes[0].includes('the model switched mid-session'), `${f}: note wording`);
      assert.ok(!notes[0].includes('the multiple'), `${f}: the ratio clause must be gone`);
      assert.ok(!notes[0].includes('depth curve'), `${f}: the curve clause must be gone`);
    } else {
      assert.equal(notes.length, 0, `${f}: no modelSwitch → no COST_MODELSWITCH_NOTE`);
    }
    assert.ok(!txt.includes('cause=model-switched'), `${f}: the COST_CHAR cause is gone`);
  }
  assert.ok(withSwitch >= 1, `vacuity guard: no fixture carries modelSwitch (found ${withSwitch})`);
  // The boundary fixture: the note names both models and the leg, and nothing else about it moved.
  assert.match(facts('model-switch'), /COST_MODELSWITCH_NOTE: the model switched mid-session \(Fable 5 \(1M context\) → Sonnet 5 at leg 13\)/);
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

// ---- J: the froz5 warm-open marker rows (J1/J2/J3) died with the metric (froz5-removal, 2026-08-21).
// The `froz5CalibStale` / `firstLegColdStart` keys they pinned no longer exist; the schema guard (L5)
// asserts their absence across all 73 goldens, which is the stronger property.

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
  // froz5-removal (2026-08-21): the fresh-leg baseline, the ratio and their provisional/confidence
  // tags are gone. What replaces them on this line is the last-N chip over the same four dollars —
  // the MEDIAN of them (spec §A1), so the two middle legs sorted are 0.2797 and 0.40 →
  // `last 4 $0.34`. NOT the retired mean of 0.412425, which one $0.77 leg pulled up: this fixture is
  // the smallest case where the two statistics visibly disagree.
  assert.deepEqual(chipOf('legs-tier-mix'), { n: 4, usd: '0.34' });
  assert.ok(!stdout('legs-tier-mix').includes('(fresh)'), 'no ratio chip survives');
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
  // D7 (froz5-removal): the shared COST_RUN_NOTE label is retired; the resumed caveat gets its own.
  assert.match(facts('resumed-run'), /COST_RESUME_NOTE: resumed session — legs 1–12 predate this run; the total covers this run only, earlier legs are priced\s+at this run's rate/);
  assert.match(stdout('resumed-run'), /last \$0\.50/);
});

test('K3 — resumed-nohistory: flagged, never faked (legs stay CC-anchored at $0.04, suspect chip + note)', () => {
  const s = sidecar('resumed-nohistory');
  assert.equal(s.legPricingSuspect, true);
  assert.equal(s.runStartLeg, 0);
  assert.equal(s.legCosts[0], 0.0385);
  // Dossier IV moved this caveat off the sparkline onto the flags row (spec §7.8 chip 4) — row 6
  // right is the one field allowed to run long, so the caveat keeps its full text.
  const flagsRow = rowByLabel(stdout('resumed-nohistory'), 'flags');
  assert.ok(flagsRow && flagsRow.includes('flags'), `flags row present: ${JSON.stringify(flagsRow)}`);
  assert.ok(flagsRow.trimEnd().endsWith('⚠ leg $ suspect: base far below list (resumed without history?)'),
    `chip on the flags row: ${JSON.stringify(flagsRow)}`);
  const f = facts('resumed-nohistory');
  // D7 (froz5-removal): its own label, so it can co-occur with the resume note without the sheet
  // emitting one key twice.
  assert.match(f, /COST_LEGPRICE_NOTE: leg \$ suspect — session rate far below list price \(resumed without local history\?\); per-leg \$ are\s+understated, the total is CC's own/);
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
  assert.match(stdout('agents-progressive'), /\$0\.25 33%/); // fleet line: no parens (spec §7.5)
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

test('K6 — model-switch: every dollar stays exactly where the leg-pricing sprint put it', () => {
  // The froz5-truth sprint (2026-08-21) proved these dollars by moving the baseline OFF tier
  // weighting; froz5-removal (same day) deleted the baseline and the multiple outright, so what this
  // row now guards is the surviving half — the per-leg / forecast / total dollars, which the removal
  // must not touch. The `= 1.1x $0.20 (fresh)` tail is gone; the cost line ends at `next $0.23`
  // plus the new chip.
  const s = sidecar('model-switch');
  assert.equal(s.costUsd, 12.2, 'session total');
  assert.equal(s.legCosts[0], 1, 'first per-leg cell');
  assert.equal(s.legCosts[12], 0.2, 'last per-leg cell');
  near(s.nextLegUsd, 0.23, 1e-9, 'next-leg $'); // 115,000 raw × 2e-6 — the forecast was always raw
  near(s.lastLegUsd, 0.2, 1e-9, 'last-leg $');
  near(s.base, 2e-6, 1e-12, 'base');
  assert.deepEqual(s.modelSwitch, { atLeg: 13, from: 'Fable 5 (1M context)', to: 'Sonnet 5' }, 'D1 stays');
  assert.ok(!('legPricingSuspect' in s));
  const line = stdout('model-switch');
  assert.match(line, /next \$0\.23/);
  assert.ok(!line.includes('(fresh)'), 'the ratio tail is gone');
  assert.deepEqual(chipOf('model-switch'), chipExpect(s), 'the chip is the median of the legCosts tail');
});

test('K7 — schema 6 + runStartLeg present in every golden sidecar (0 / 12 with a transcript, null without)', () => {
  for (const f of allFixtures()) {
    const s = sidecar(f);
    assert.equal(s.schema, 6, `${f}: schema`);
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

// J3 (the marker-vs-parent ratio equality) died with froz5Ratio / froz5State — froz5-removal, 2026-08-21.

// ---- L: froz5-recal (2026-08-16 sprint 2) — shape-based fresh baseline, era by behaviour, schema 5 ---
// Hand-computed from the spec's F1 / F3 tables (S1 weights, 1h writes, opus list 5e-6 $/unit); see
// .claude/plans/2026-08-16-froz5-recalibration-test-plan.md §4.3.
const withTranscript = (f) => existsSync(join(FIX, f, 'transcript.jsonl'));
const SHORT_OUTPUT_ONLY = ['a1-tier-weighted', 'a3-empty-model', 'b1-chip-main', 'b2-mythos', 'b3-unmapped', 'b4-absent-model', 'median-even', 'median-single', 'agents-progressive'];

test('L1 — cold-open-then-warm: the opener reads "opened cold ~57k" and its dollars are untouched', () => {
  // The fresh-leg baseline / ratio / provisional-tag pins died with froz5 (froz5-removal,
  // 2026-08-21). What this fixture still proves is the leg-1 SHAPE label (backed by isColdStartLeg,
  // which survives un-exported per D5) and that the removal moved no dollar.
  const s = sidecar('cold-open-then-warm');
  near(s.nextLegUsd, 0.10051, 1e-5, 'nextLegUsd');
  near(s.legCosts[0], 0.5775, 1e-9, 'legCosts[0]');  // 115,502 × 5e-6
  near(s.base, 5e-6, 1e-12, 'base');
  assert.equal(s.schema, 6);
  assert.match(stdout('cold-open-then-warm'), /next \$0\.10/);
  assert.ok(!stdout('cold-open-then-warm').includes('(fresh)'));
  assert.match(spikes('cold-open-then-warm'), /Leg 1  ·  \$0\.58  ·  opened cold ~57k \(whole context written, no cached prefix\)/);
  assert.ok(!spikes('cold-open-then-warm').includes('warm rewrite'), 'the opener is never a warm rewrite');
  assert.match(facts('cold-open-then-warm'), /WARM_REWRITE_TAX: \(none\)/);
});

test('L2 — cold-open-then-writes: 13 legs, opener label and dollars intact', () => {
  const s = sidecar('cold-open-then-writes');
  assert.equal(s.nLegs, 13);
  near(s.legCosts[0], 0.5775, 1e-9, 'legCosts[0]');
  assert.ok(!stdout('cold-open-then-writes').includes('(fresh)'));
  assert.match(spikes('cold-open-then-writes'), /Leg 1  ·  \$0\.58  ·  opened cold ~57k/);
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
  assert.equal(a.nextLegUsd, b.nextLegUsd);   // was froz5Ratio before the removal — same property
  assert.deepEqual(chipOf('warmtax-sonnet'), chipOf('warmtax-sonnet46'), 'identical legs → identical chip');
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

test('L7 — short output-only fixtures: no ratio chip, `next $` still shown, chip only where ≥2 legs', () => {
  // Nine fixtures render `next $X` with no ratio tail. EIGHT of them gain the last-N chip;
  // agents-progressive has exactly ONE banked leg, so its chip is suppressed (D1's n<2 gate). That
  // one-fixture split is the whole reason this row is a sweep rather than a blanket assertion.
  let withChip = 0, without = 0;
  for (const f of SHORT_OUTPUT_ONLY) {
    const s = sidecar(f);
    assert.ok(!stdout(f).includes('(fresh)'), `${f}: no ratio chip`);
    assert.match(stdout(f), /next \$/, `${f}: next $ still shown`);
    assert.ok(!facts(f).includes('COST_CHAR'), `${f}: COST_CHAR is gone`);
    assert.ok(!facts(f).includes('COST_FROZ5'), `${f}: COST_FROZ5 is gone`);
    assert.deepEqual(chipOf(f), chipExpect(s), `${f}: chip vs legCosts tail`);
    if (chipOf(f)) withChip++; else without++;
  }
  assert.equal(without, 1, 'exactly one (agents-progressive, 1 leg) suppresses the chip');
  assert.equal(withChip, 8, 'the other eight gain it');
  assert.equal(chipOf('agents-progressive'), null, 'agents-progressive is the suppressed one');
});

test('L9 — warm-open vs keepwarm-1h: the reshape adds exactly 1,200 units (leg 1 +12k read)', () => {
  const a = sidecar('warm-open'), b = sidecar('keepwarm-1h');
  // parent: Σ 100,000 units at $2.00 → base 2e-5, legCosts[0] = 10,000 × base = 0.20
  near(b.base * 100000, 2.0, 1e-9, 'keepwarm-1h Σunits');
  near(b.legCosts[0], 0.2, 1e-9, 'keepwarm-1h legCosts[0]');
  // reshaped: Σ 101,200 → base 2/101,200; legCosts[0] = 11,200 × base
  near(a.base * 101200, 2.0, 1e-9, 'warm-open Σunits = parent + 1,200');
  // legCosts are stored at 4 dp → tolerance 5e-5
  near(a.legCosts[0], 11200 * a.base, 5e-5, 'warm-open legCosts[0] = 11,200 units × base');
  assert.equal(a.legCosts.length, b.legCosts.length);
  for (let i = 1; i < a.legCosts.length; i++) near(a.legCosts[i], 10000 * a.base * (i === 5 ? 5 : 1), 5e-5, `warm-open legCosts[${i}]`);
});

// ---- M: froz5 REMOVAL (2026-08-21 sprint, bsl6.0.0.0) ------------------------------------------
// M1–M6 replace the deleted J/L froz5 rows. M2, M2b and M3 are Assertions B, the spike row and
// D-class-8 from the sprint's one-off delta proof, promoted into standing tests so the property
// survives whatever happens to that script. They are the piece of the proof that must not be thrown
// away — and M2b is the one that fails on a silent revert of the chip to the mean.

test('M1 — schema guard: every golden sidecar is schema 6, carries none of the seven removed keys', () => {
  let withLegs = 0;
  for (const f of allFixtures()) {
    const s = sidecar(f);
    assert.equal(s.schema, 6, `${f}: schema`);
    for (const k of REMOVED_KEYS) {
      assert.ok(!(k in s), `${f}: removed key ${k} is still in the sidecar — removed, not display-gated off`);
    }
    // legCosts is what the chip, TRAJECTORY and the sparkline all read; it must not have been lost
    // in the deletion. Present-and-non-empty on every fixture that has a rollup at all.
    if (withTranscript(f) && s.nLegs != null && Number(s.nLegs) > 0) {
      assert.ok(Array.isArray(s.legCosts) && s.legCosts.length > 0, `${f}: legCosts must survive`);
      withLegs++;
    }
  }
  assert.ok(withLegs >= 45, `vacuity guard: only ${withLegs} fixtures checked for legCosts`);
});

test('M2 — chip guard: the rendered `last N $x` equals MEDIAN(legCosts tail), absent exactly below 2 legs', () => {
  let present = 0, absent = 0;
  for (const f of allFixtures()) {
    const want = chipExpect(sidecar(f));
    assert.deepEqual(chipOf(f), want, `${f}: chip`);
    if (want) present++; else absent++;
  }
  // ABSENT is the exact pin, and it is pinned rather than PRESENT because it is the number that
  // survives the corpus growing: 21 fixtures have no legs at all and one (agents-progressive) has a
  // single leg. Any fixture gaining or losing its chip moves this number, which is the defect this
  // row exists to catch. PRESENT is derived, so adding a fixture never forces a recount — the
  // Dossier IV sprint added seven, every one of them a copy of a parent with ≥2 banked legs.
  assert.equal(absent, 22, 'fixtures suppressing the chip (21 with no legs, 1 with a single leg)');
  assert.equal(present, allFixtures().length - 22, 'every other fixture shows it');
});

test('M2b — spike guard: where the window holds a fat leg, the chip is strictly BELOW the window mean', () => {
  // "One fat leg cannot lift the chip", stated as its own standing assertion rather than as a
  // restatement of M2's formula. It survives a refactor of that formula and it is what fails on a
  // silent revert to the mean — which is exactly the defect this amendment exists to fix, measured on
  // a real 180-leg session where one $6.02 compaction leg put the chip in the red band while `next`
  // sat in yellow and every ordinary leg cost about a third of a dollar.
  //
  // "Fat" = a leg at 2x the window's own median or more. Measured against the pre-sprint corpus:
  // 24 of the 51 chip-bearing windows qualify, so this row has real coverage, not a hypothetical.
  let qualifying = 0;
  for (const f of allFixtures()) {
    const win = windowOf(sidecar(f));
    if (!win) continue;
    const med = medianOf(win);
    const mean = win.reduce((a, b) => a + b, 0) / win.length;
    if (!(med > 0 && Math.max(...win) >= med * 2)) continue;
    qualifying++;
    assert.ok(med < mean,
      `${f}: window holds a leg at >=2x its median, so the median (${med}) must sit strictly below the mean (${mean})`);
    // and the RENDERED chip is that median, not something between it and the mean
    const chip = chipOf(f);
    assert.ok(chip, `${f}: no chip in golden.txt though legCosts has ${win.length} entries — a stale (unblessed) golden reads as a missing chip, so say so rather than throwing`);
    assert.equal(chip.usd, fmt2(med), `${f}: the rendered chip is the median`);
  }
  assert.equal(qualifying, 24, 'windows carrying a leg at >=2x their own median');
});

test('M3 — verdict guard: HEADLINE_BASIS `cost=next N (lvl L)` follows D2a\'s three-rung dollar ladder', () => {
  const seen = new Set();
  for (const f of allFixtures()) {
    const s = sidecar(f);
    const m = /HEADLINE_BASIS: driver=(\w+); quality=\S+ \(lvl (\d)\); cost=next (\S+) \(lvl (\d)\)/.exec(facts(f));
    assert.ok(m, `${f}: HEADLINE_BASIS not in the post-removal form (no froz5 term, cost=next only)`);
    const qL = qLevelOf(s), cL = ladderCLevel(s.nextLegUsd);
    assert.equal(Number(m[4]), cL, `${f}: cost level vs ladder(nextLegUsd ${s.nextLegUsd})`);
    assert.equal(Number(m[2]), qL, `${f}: quality level`);
    const driver = cL > qL ? 'cost' : (qL > cL ? 'quality' : 'both');
    assert.equal(m[1], driver, `${f}: driver`);
    // the headline rung is max(quality, cost), and its polarity follows
    const hL = Math.max(qL, cL);
    const rung = ['Plenty of room', 'Getting deeper', 'Wind down soon', 'Time to hand over'][hL];
    assert.ok(facts(f).includes(`HEADLINE_DIFF: ${hL <= 1 ? '+' : '-'} ${rung}`), `${f}: HEADLINE_DIFF should read "${hL <= 1 ? '+' : '-'} ${rung}"`);
    seen.add(cL);
  }
  // All three rungs must be reachable — a ladder that only ever returns 0 would pass every row above.
  assert.deepEqual([...seen].sort(), [0, 2, 3], `vacuity guard: cost levels actually observed ${[...seen]}`);
});

test('M4 — sheet/line agreement: COST_RECENT reads `(none)` exactly where the chip is absent', () => {
  let none = 0, valued = 0;
  for (const f of allFixtures()) {
    const chip = chipOf(f);
    const m = /^COST_RECENT: (.*)$/m.exec(facts(f));
    assert.ok(m, `${f}: COST_RECENT line missing`);
    if (!chip) { assert.equal(m[1], '(none)', `${f}: no chip → (none)`); none++; continue; }
    valued++;
    assert.notEqual(m[1], '(none)', `${f}: chip present but the sheet says (none)`);
    // The sheet must quote the SAME number and the SAME window as the line, and must still name the
    // recent figure a `median` while the session figure stays a `mean`. The two are computed in two
    // different files from two different arrays (perLegCostArr in statusline.mjs, legCosts in
    // handover-facts.mjs), so a one-sided fix must be impossible to land.
    //
    // Dossier IV (2026-08-22) loosened this row in EXACTLY ONE dimension. The chip's label was
    // renamed to `med<N>` (spec §6.3) and §6.4 puts the sheet's prose in the same sprint so the two
    // cannot drift — which makes the sentence's exact phrasing the developer's call, not this test's.
    // Everything load-bearing stays pinned, and pinned separately so a failure names which half
    // broke: the figure, the window count, the statistic's name, and the session-mean half. A sheet
    // quoting a different window or a different dollar than the line still fails, which is the row's
    // whole purpose.
    const usdRe = chip.usd.replace('.', '\\.');
    assert.match(m[1], new RegExp(`\\$${usdRe}\\b`),
      `${f}: COST_RECENT must quote the chip's own figure ($${chip.usd}): ${m[1]}`);
    assert.match(m[1], new RegExp(`\\b${chip.n}\\b`),
      `${f}: COST_RECENT must quote the chip's own window count (${chip.n}): ${m[1]}`);
    assert.match(m[1], /\bmedian\b/, `${f}: the recent figure must be named a median: ${m[1]}`);
    assert.match(m[1], /session mean `\$[\d.,]+` over `\d+` legs/,
      `${f}: the session-mean half must survive verbatim: ${m[1]}`);
    assert.ok(!/averag/i.test(m[1]), `${f}: the recent figure is a median and may not be called an average`);
  }
  // Same pinning choice as M2: the exact number is the ABSENT one, the other is derived.
  assert.equal(none, 22);
  assert.equal(valued, allFixtures().length - 22);
});

test('M5 — key uniqueness (D7): no `KEY:` label appears twice in any fact sheet', () => {
  for (const f of allFixtures()) {
    const seen = new Map();
    for (const line of facts(f).split('\n')) {
      const m = /^([A-Z0-9_]+):/.exec(line);
      if (m) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, c]) => c > 1);
    assert.deepEqual(dupes, [], `${f}: repeated label(s) — the sheet is a KEY: value contract and a reader cannot tell a second value from a corrected one`);
    assert.ok(!seen.has('COST_RUN_NOTE'), `${f}: COST_RUN_NOTE is retired (D7 split it three ways)`);
  }
});

test('M7 — label registration (D7): every emittable label is in handover-check.md, or on the known-gap list', () => {
  // Paired with M5. An UNREGISTERED label is silently dropped by the composer — that is row S13 from
  // the previous sprint, and it is exactly the trap D7 walks into. This row generalises past the
  // three new labels: it fails on ANY future label added to the fact sheet without registering it.
  //
  // FOUR labels are on a documented allow-list because they were already unregistered BEFORE this
  // sprint (verified against the pre-sprint goldens at ref 6b6f116 — the same four, no more). They
  // are NOT this sprint's debt and are NOT fixed here; two of them look like real gaps worth a
  // ticket and are reported as such. Listing them in code rather than weakening the assertion is
  // what keeps them visible.
  const KNOWN_GAPS = new Set([
    'HEADLINE_BASIS',     // internal evidence line; the composer is told to relay HEADLINE_DIFF instead
    'COST_AGENTS_TIER',   // a routing tier for the composer's own branching, not a fact to relay
    'COST_GATES_NOTE',    // GAP: on a sonnet/haiku main the reader is never told the $ gates grade leniently
    'WARM_REWRITE_TAX',   // GAP: the warm-rewrite tax has no bullet at all, so it never reaches the reader
  ]);
  const md = readFileSync(join(here, '..', 'home', 'commands', 'handover-check.md'), 'utf8');
  const emitted = new Set();
  for (const f of allFixtures()) {
    for (const line of facts(f).split('\n')) {
      const m = /^([A-Z0-9_]+):/.exec(line);
      if (m) emitted.add(m[1]);
    }
  }
  assert.ok(emitted.size >= 20, `vacuity guard: only ${emitted.size} labels seen`);
  const unregistered = [...emitted].filter((l) => !md.includes(l) && !KNOWN_GAPS.has(l)).sort();
  assert.deepEqual(unregistered, [], 'a label the composer cannot see is a fact the reader never gets');
  // The allow-list may not grow silently either: an entry that got registered should leave it.
  const stale = [...KNOWN_GAPS].filter((l) => md.includes(l)).sort();
  assert.deepEqual(stale, [], 'these are now registered — drop them from KNOWN_GAPS');
});

test('M6 — the three D7 labels fire on their own gates, across all 73', () => {
  let resume = 0, legprice = 0;
  for (const f of allFixtures()) {
    const s = sidecar(f);
    const txt = facts(f);
    const has = (k) => txt.split('\n').filter((l) => l.startsWith(k + ': ')).length;
    const wantResume = s.runStartLeg != null && Number(s.runStartLeg) > 0;
    const wantLegPrice = s.legPricingSuspect === true;
    assert.equal(has('COST_RESUME_NOTE'), wantResume ? 1 : 0, `${f}: COST_RESUME_NOTE vs runStartLeg ${s.runStartLeg}`);
    assert.equal(has('COST_LEGPRICE_NOTE'), wantLegPrice ? 1 : 0, `${f}: COST_LEGPRICE_NOTE vs legPricingSuspect`);
    if (wantResume) resume++;
    if (wantLegPrice) legprice++;
  }
  assert.ok(resume >= 1 && legprice >= 1, `vacuity guard: resume ${resume}, legprice ${legprice}`);
});
