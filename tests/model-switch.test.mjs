import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { servingTierReport } from '../home/leg-driver.mjs';
import { rowByLabel } from './_grid.mjs';

// model-switch (rows D1/D3, rewritten by sprint 3 spec §A1) — stateful two-render tests of the
// TRANSCRIPT-derived model switch. A "switch" is a price-TIER change between two banked legs'
// served models (modelSwitchReport, derived per render — never persisted); a display-label change
// alone stamps nothing, and id-form vs display-form of the same model / same-tier upgrades never
// stamp. Runs the real engine as a subprocess against kept temp dirs (the parity harness can't do
// multi-render statefulness).

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
  const stdout = execFileSync(process.execPath, [engine], {
    input: JSON.stringify(stdin),
    // CLAUDE_CONFIG_DIR is pinned POSITIVELY (never deleted) so the child's user-level state stays
    // inside the temp home even when this suite is launched from a second-subscription session.
    env: { ...process.env, USERPROFILE: dirs.home, HOME: dirs.home, CLAUDE_CONFIG_DIR: join(dirs.home, '.claude'), CLAUDE_PROJECT_DIR: dirs.cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW) },
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
  return {
    stats: JSON.parse(readFileSync(join(dirs.cwd, '.claude', 'statusline-stats', 'msw-test-1.json'), 'utf8')),
    sidecar: JSON.parse(readFileSync(join(dirs.cwd, '.claude', 'statusline-last.json'), 'utf8')),
    stdout, plain: stdout.replace(/\x1b\[[0-9;]*m/g, ''),
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

test('D1 — a fable→sonnet TRANSCRIPT boundary at leg 13: id-form sidecar key, and NO stats-file stamp', () => {
  // Rewritten by sprint 3 (spec §A1): the switch is driven through the served models — legs 1–12
  // fable, leg 13 sonnet — not through the label (which also moves here, as a real /model switch
  // would). The stats file carries neither stamp key at any render: the key is derived.
  withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 12; i++) lines += leg(i, 'claude-fable-5');
    writeFileSync(dirs.transcript, lines, 'utf8');
    const r1 = render(dirs, 'Fable 5 (1M context)', 1.8);
    assert.equal(r1.stats.mainModel, 'Fable 5 (1M context)');
    assert.equal(r1.stats.nLegs, 12);
    assert.ok(!('modelSwitch' in r1.stats) && !('modelSwitchedAtLeg' in r1.stats), 'the stats file never carries the stamp');
    assert.ok(!('modelSwitch' in r1.sidecar), 'no sidecar key before the boundary');
    appendFileSync(dirs.transcript, leg(13, 'claude-sonnet-5'), 'utf8');
    const r2 = render(dirs, 'Sonnet 5', 2.0);
    assert.equal(r2.stats.nLegs, 13);
    assert.equal(r2.stats.mainModel, 'Sonnet 5');
    assert.ok(!('modelSwitch' in r2.stats) && !('modelSwitchedAtLeg' in r2.stats), 'derived per render, never persisted (spec §0.3)');
    assert.deepEqual(r2.sidecar.modelSwitch, { atLeg: 13, from: 'claude-fable-5', to: 'claude-sonnet-5' });
  });
});

test('D3 — id-form vs display-form of the SAME label, unmapped transcript: no switch stamped', () => {
  // Negative case kept from the display era: the transcript's `claude-x` legs are unmapped, so no
  // tier ever serves — and a label-string change (id-form → display-form) is not a switch.
  const { r2 } = twoRenders('claude-fable-5', 'Fable 5 (1M context)');
  assert.equal(r2.stats.mainModel, 'Fable 5 (1M context)');
  assert.ok(!('modelSwitch' in r2.stats), 'the stats file never carries the stamp');
  assert.equal(r2.stats.modelSwitchedAtLeg, undefined);
  assert.ok(!('modelSwitch' in r2.sidecar), 'sidecar must not carry modelSwitch');
});

test('D3 — same-tier upgrade (Opus 4.7 → Opus 4.8): no switch stamped', () => {
  const { r2 } = twoRenders('Opus 4.7', 'Opus 4.8 (1M context)');
  assert.equal(r2.stats.mainModel, 'Opus 4.8 (1M context)');
  assert.ok(!('modelSwitch' in r2.stats));
  assert.ok(!('modelSwitch' in r2.sidecar));
});

test('D5 — AE-1: a switch the label never showed (constant label, transcript opus → fable at leg 4) is reported', () => {
  withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 5; i++) lines += leg(i, i <= 3 ? 'claude-opus-5' : 'claude-fable-5');
    writeFileSync(dirs.transcript, lines, 'utf8');
    const r = render(dirs, 'Fable 5 (1M context)', 1.0);
    assert.deepEqual(r.sidecar.modelSwitch, { atLeg: 4, from: 'claude-opus-5', to: 'claude-fable-5' });
    assert.ok(!('modelSwitch' in r.stats) && !('modelSwitchedAtLeg' in r.stats), 'no stats stamp');
    assert.ok(!('tierMismatch' in r.sidecar), 'the labelled tier did serve → no label caveat');
    const sheet = factsSheet(dirs);
    const notes = sheet.split('\n').filter((l) => l.startsWith('COST_MODELSWITCH_NOTE:'));
    assert.equal(notes.length, 1, `exactly one note: ${JSON.stringify(notes)}`);
    assert.match(notes[0], /claude-opus-5 → claude-fable-5 at leg 4/);
    assert.ok(!sheet.includes('COST_TIER_NOTE'), 'and no tier caveat');
  });
});

test('D6 — AE-2: one model throughout under its own label → no key, no note', () => {
  withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 8; i++) lines += leg(i, 'claude-opus-5');
    writeFileSync(dirs.transcript, lines, 'utf8');
    const r = render(dirs, 'Opus 5', 1.2);
    assert.ok(!('modelSwitch' in r.sidecar), 'no key');
    assert.ok(!('modelSwitch' in r.stats) && !('modelSwitchedAtLeg' in r.stats), 'no stats stamp');
    assert.ok(!factsSheet(dirs).includes('COST_MODELSWITCH_NOTE'), 'no note');
  });
});

test('D8 — unmapped or empty served models never open or close a boundary', () => {
  // `''` and `claude-x` legs interleave a constant opus tier: a mapped→unmapped→same-mapped-tier
  // sequence is not a boundary, so a stray unmapped line can neither invent nor hide a switch.
  // (`<synthetic>` lines are dropped before banking — isSyntheticLeg — so they never reach this.)
  withDirs((dirs) => {
    const models = ['claude-opus-5', '', 'claude-x', 'claude-opus-5', 'claude-x', 'claude-opus-5'];
    writeFileSync(dirs.transcript, models.map((m, i) => leg(i + 1, m)).join(''), 'utf8');
    const r = render(dirs, 'Opus 5', 1.0);
    assert.ok(!('modelSwitch' in r.sidecar), 'no key on a constant mapped tier with unmapped noise');
    assert.ok(!('modelSwitch' in r.stats) && !('modelSwitchedAtLeg' in r.stats), 'no stats stamp');
  });
});

test('D9 — incremental: a boundary banked in a LATER render is derived from the banked array', () => {
  withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 3; i++) lines += leg(i, 'claude-opus-5');
    writeFileSync(dirs.transcript, lines, 'utf8');
    const r1 = render(dirs, 'Opus 5', 0.6);
    assert.ok(!('modelSwitch' in r1.sidecar), 'no key before the boundary lands');
    appendFileSync(dirs.transcript, leg(4, 'claude-fable-5') + leg(5, 'claude-fable-5'), 'utf8');
    const r2 = render(dirs, 'Opus 5', 1.4);
    assert.deepEqual(r2.sidecar.modelSwitch, { atLeg: 4, from: 'claude-opus-5', to: 'claude-fable-5' },
      'the derivation reads the banked perLegModels, so it survives the render boundary and the projection pass');
  });
});

// ═══ froz5-truth sprint (2026-08-21): the tier-mismatch REPORT, end to end (T1 rows S10–S16) ═══════
// The report answers "does the model label name a price tier that has never served in this run?" and
// drives three things and nothing else: a dim cluster-1 chip, a conditional sidecar key, and one
// fact-sheet caveat. It gates NO number. Spec .claude/plans/260821-froz5-truth-spec.md §2.4 / D1 / D9.
// The unit-level predicate rows (S1–S9) live in leg-driver.test.mjs; these drive the real renderers.

const FABLE = 'claude-fable-5', OPUS = 'claude-opus-5', SONNET = 'claude-sonnet-5';

// A leg table with a real token mix. Leg 1 is a post-2.1.209 cold-start opener unless `warmOpen`,
// which makes it read a cached prefix instead — the shape that used to raise the warm-open marker.
function tokenLeg(i, model, [inT, cw, cr, out]) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.parse('2026-06-18T02:10:00.000Z') + (i - 1) * 60000).toISOString(),
    message: { id: `tm${i}`, model, usage: {
      input_tokens: inT, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out,
      cache_creation: { ephemeral_1h_input_tokens: cw, ephemeral_5m_input_tokens: 0 },
    } },
  }) + '\n';
}
const unitsOf = ([inT, cw, cr, out]) => inT + 2 * cw + 0.1 * cr + 5 * out;
// 12 legs: a write-heavy opener then 11 warm legs → 5 warm inside the window → full strength.
function table({ warmOpen = false, nWarm = 11 } = {}) {
  const T = [warmOpen ? [0, 5000, 12000, 200] : [2, 57000, 0, 300]];
  for (let k = 2; k <= 1 + nWarm; k++) T.push([2, 1000, 50000 + 3000 * (k - 2), 200]);
  while (T.length < 12) T.push([2, 22000, 59800, 500]);   // write-heavy filler (share 0.269)
  return T;
}
// Renders one table under one display label, at list price for that label's tier.
function renderTable(dirs, T, display, tierBase) {
  writeFileSync(dirs.transcript, T.map((t, i) => tokenLeg(i + 1, dirs.model, t)).join(''), 'utf8');
  const cost = T.reduce((a, t) => a + unitsOf(t), 0) * (tierBase / 1e6);
  return render(dirs, display, cost);
}
const withModel = (model, fn) => withDirs((dirs) => fn({ ...dirs, model }));

test('S10 — the sidecar key is present only when the report fires', () => {
  // The "and the schema does NOT bump" half of this row retired with the froz5 removal: schema is 6
  // now, bumped for the seven DELETED keys, not for this additive one. The anchor-strength assertion
  // went with `freshLegN`.
  // FIRES: 12 opus legs under a Fable label — fable is mapped and has never served.
  withModel(OPUS, (dirs) => {
    const r = renderTable(dirs, table(), 'Fable 5 (1M context)', 10);
    assert.deepEqual(r.sidecar.tierMismatch, { display: 'fable', serving: 'opus' });
    assert.equal(r.sidecar.schema, 6);
  });
  // SILENT: the same legs under the label that actually served.
  withModel(OPUS, (dirs) => {
    const r = renderTable(dirs, table(), 'Opus 5', 5);
    assert.ok(!('tierMismatch' in r.sidecar), 'the label is accurate → no key at all');
    assert.equal(r.sidecar.schema, 6);
  });
  // SILENT: an unmapped label has nothing to check.
  withModel(OPUS, (dirs) => {
    const r = renderTable(dirs, table(), 'Zed 9', 5);
    assert.ok(!('tierMismatch' in r.sidecar), 'unmapped display → no key');
  });
});

test('S11 — the chip is QUIET and sits on the flags row', () => {
  // REDUCED by the froz5 removal (2026-08-21), then RELOCATED by Dossier IV (2026-08-22): the chip
  // leaves cluster 1's model field for the flags row (spec §7.8 chip 7, §9 row 10), and its wrapper
  // moves from SGR-2 to the single chrome gray 240 (spec §5). Its contract is otherwise unchanged and
  // is what this row still guards: quiet, uncoloured, provenance rather than alarm.
  withModel(OPUS, (dirs) => {
    const r = renderTable(dirs, table(), 'Fable 5 (1M context)', 10);
    // Assert the exact wrapper, so a future change to a coloured chip fails here rather than being
    // noticed on screen. 240 is the ONE gray — SGR-2 is retired file-wide.
    assert.ok(r.stdout.includes('\x1b[38;5;240m⚠ serving:opus\x1b[0m'),
      `gray-240-wrapped chip absent:\n${JSON.stringify(rowByLabel(r.stdout, 'flags'))}`);
    assert.ok(!r.stdout.includes('\x1b[2m'), 'SGR-2 is retired — there is no second gray (spec §5)');
    // …and it carries no attention colour of its own. 240 is chrome, so exclude it by name rather
    // than banning every 38;5 sequence.
    assert.ok(!/\x1b\[38;5;(?!240m)[0-9;]*m[^\x1b]*serving:/.test(r.stdout), 'the chip must not be coloured');
    assert.ok(!/\x1b\[(?:1;)?3[1-7]m[^\x1b]*serving:/.test(r.stdout), 'nor carry a basic-ANSI colour');
    // It lives on the flags row — row 6 of the fixed block — and has LEFT the model row.
    const lines = r.plain.split('\n');
    assert.match(rowByLabel(r.plain, 'flags'), /⚠ serving:opus/, `the flags row carries it: ${rowByLabel(r.plain, 'flags')}`);
    assert.ok(!lines[0].includes('serving:'), `and the model row does not: ${lines[0]}`);
  });
  // A warm-open leg 1 (what used to raise the `?` marker) still renders the chip, and no ratio tail
  // comes back with it — the negative half of AE-1, driven live rather than read off a golden.
  withModel(OPUS, (dirs) => {
    const r = renderTable(dirs, table({ warmOpen: true }), 'Fable 5 (1M context)', 10);
    assert.deepEqual(r.sidecar.tierMismatch, { display: 'fable', serving: 'opus' });
    const lines = r.plain.split('\n');
    assert.match(rowByLabel(r.plain, 'flags'), /⚠ serving:opus/, 'chip still on the flags row');
    assert.ok(!r.plain.includes('(fresh)'), 'no ratio tail');
    assert.ok(!/=\s*[\d.]+x/.test(r.plain), 'and no `= N.Nx` multiple anywhere on any line');
  });
});

test('S12 — the fact sheet emits COST_TIER_NOTE exactly once, naming both the label and the serving tier', () => {
  const FIX = join(here, '..', 'tools', 'parity', 'fixtures');
  // Present: label-never-served is the fixture built for this (12 opus legs, Fable label).
  const fired = readFileSync(join(FIX, 'label-never-served', 'golden-facts.txt'), 'utf8');
  const notes = fired.split('\n').filter((l) => l.startsWith('COST_TIER_NOTE:'));
  assert.equal(notes.length, 1, `exactly one note: ${JSON.stringify(notes)}`);
  assert.match(notes[0], /Fable 5 \(1M context\)/, 'names the LABEL');
  assert.match(notes[0], /`opus` served the most legs/, 'and names the tier that did serve');
  // It is a label fact only — it must not claim a number changed. D2d (froz5-removal) cut "and the
  // multiple" from the claim, so it now reads "the `$` in this sheet does not depend …".
  assert.match(notes[0], /does not depend on which label is shown/, 'states it gates no number');
  assert.ok(!notes[0].includes('the multiple'), 'and no longer claims anything about a multiple');
  // Absent everywhere the key is absent — checked across every fixture, so the blast radius is pinned.
  for (const f of readdirSync(FIX)) {
    const sc = join(FIX, f, 'golden-sidecar.json');
    const fx = join(FIX, f, 'golden-facts.txt');
    if (!existsSync(sc) || !existsSync(fx)) continue;
    const hasKey = 'tierMismatch' in JSON.parse(readFileSync(sc, 'utf8'));
    const hasNote = readFileSync(fx, 'utf8').includes('COST_TIER_NOTE:');
    assert.equal(hasNote, hasKey, `${f}: note ${hasNote ? 'present' : 'absent'} but key ${hasKey ? 'present' : 'absent'}`);
  }
});

test('S13 — handover-check.md registers every caveat label the fact sheet can emit', () => {
  // Not documentation: that file enumerates the labels the composer may relay, so an UNLISTED label
  // is silently dropped and the caveat never reaches the reader. D7 (froz5-removal) retired the
  // shared COST_RUN_NOTE and split it three ways, which makes this row the guard that the split was
  // registered as well as implemented.
  const md = readFileSync(join(here, '..', 'home', 'commands', 'handover-check.md'), 'utf8');
  const cost = md.split('\n').find((l) => l.includes('COST_FAST_NOTE'));
  assert.ok(cost, 'the Cost bullet enumerates caveat labels');
  for (const label of ['COST_RESUME_NOTE', 'COST_LEGPRICE_NOTE', 'COST_MODELSWITCH_NOTE',
    'COST_FAST_NOTE', 'COST_TIER_NOTE']) {
    assert.ok(cost.includes(label), `${label} is not in the relayable list — it would be silently dropped`);
  }
  assert.ok(!md.includes('COST_RUN_NOTE'), 'the retired shared label must be gone from the list too');
  // …and the file tells the composer what to SAY about each, not merely that they exist.
  assert.match(md, /tier caveat/i, 'the composer is told how to render the tier caveat');
  assert.match(md, /partway through|mid-session/i, 'and how to render the model-switch caveat');
  assert.match(md, /COST_RECENT/, 'the new recent-leg-median key is registered (D2g)');
  assert.ok(!md.includes('COST_FROZ5') && !md.includes('COST_CHAR'), 'and the two deleted keys are gone');
});

test('S14 — the switch note is UNCONDITIONAL on modelSwitch, with no ratio/curve tail', () => {
  // REWRITTEN by froz5-removal (2026-08-21, D2c + D7). The D11 gate this row used to exercise —
  // full-strength anchor keeps the depth cause, one below and the switch preempts — had both of its
  // branches deleted with the baseline. One note now fires on `modelSwitch` alone.
  const FIX = join(here, '..', 'tools', 'parity', 'fixtures');
  const ms = JSON.parse(readFileSync(join(FIX, 'model-switch', 'golden-sidecar.json'), 'utf8'));
  // Sprint 3 (spec §A1, F2): from/to are the TRANSCRIPT model ids, always — the golden re-worded.
  assert.deepEqual(ms.modelSwitch, { atLeg: 13, from: 'claude-fable-5', to: 'claude-sonnet-5' });
  const f = readFileSync(join(FIX, 'model-switch', 'golden-facts.txt'), 'utf8');
  assert.ok(!/cause=model-switched/.test(f), 'the COST_CHAR cause is gone');
  assert.ok(!f.includes('COST_FROZ5'), 'and so is the ratio line');
  assert.match(f, /COST_MODELSWITCH_NOTE: the model switched mid-session .* comparing per-leg \$ across the switch is not like-for-like/,
    'the switch is stated once, under its own label, as a dollar-comparability caveat');
  assert.ok(!f.includes('the multiple and the depth curve still hold'), 'the ratio/curve tail is cut');
  // A LIVE switch on a session too short to have had a full-strength anchor: under the old gate this
  // was the branch where the switch preempted the depth cause. It must now produce the same single
  // note, because the note no longer depends on anchor strength at all. (Sprint 3, spec §A1: the
  // switch is a TRANSCRIPT fact, so it is driven through a served-model change — leg 4 lands on
  // sonnet — not through the display label, which stamps nothing on its own.)
  withModel(OPUS, (dirs) => {
    const T = table({ nWarm: 2 }).slice(0, 3);
    writeFileSync(dirs.transcript, T.map((t, i) => tokenLeg(i + 1, OPUS, t)).join(''), 'utf8');
    const cost = T.reduce((a, t) => a + unitsOf(t), 0) * 5e-6;
    render(dirs, 'Opus 5', cost);
    appendFileSync(dirs.transcript, tokenLeg(4, SONNET, [2, 1000, 50000, 200]), 'utf8');
    const r2 = render(dirs, 'Sonnet 5', cost + 0.01);
    assert.deepEqual(r2.sidecar.modelSwitch, { atLeg: 4, from: OPUS, to: SONNET },
      'the switch stamped on a 4-leg session, from the transcript ids');
    assert.ok(!('freshLegN' in r2.sidecar), 'and there is no anchor-strength key left to gate on');
  });
});

test('S15 — model-switch is SILENT because the displayed tier really did serve at leg 13 (AE-7, row S2)', () => {
  // Pinning the REASON, not just the absence: this fixture is 12 fable legs then ONE sonnet leg,
  // under a Sonnet label. The presence rule looks at the whole run, so one sonnet leg is enough —
  // and that is the behaviour AE-7 requires ("the label is accurate, because that model really did
  // serve"). Without this row the silence is an unexplained missing key in a golden.
  const FIX = join(here, '..', 'tools', 'parity', 'fixtures');
  const models = readFileSync(join(FIX, 'model-switch', 'transcript.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).message.model);
  assert.deepEqual(models, [...Array(12).fill(FABLE), SONNET], 'the 13th leg IS sonnet');
  const s = JSON.parse(readFileSync(join(FIX, 'model-switch', 'golden-sidecar.json'), 'utf8'));
  assert.ok(!('tierMismatch' in s), 'so the report is correctly silent');
  assert.equal(s.runStartLeg, 0, 'and the whole run is in scope, so leg 13 counts');
  assert.equal(servingTierReport(models, 0, 'Sonnet 5'), null, 'asserted on the predicate itself');
  // The discriminator: drop that one leg and it fires. If this ever stops firing, the presence rule
  // has been broken in the silent direction — which no golden absence would reveal.
  assert.deepEqual(servingTierReport(models.slice(0, 12), 0, 'Sonnet 5'), { display: 'sonnet', serving: 'fable' });
});

test('S16 — BOTH transpositions render the chip: label dearer than served, and label cheaper than served', () => {
  // d7e61e54's direction — label fable (TIER_BASE 10) over opus legs (5).
  withModel(OPUS, (dirs) => {
    const r = renderTable(dirs, table(), 'Fable 5 (1M context)', 10);
    assert.deepEqual(r.sidecar.tierMismatch, { display: 'fable', serving: 'opus' });
    assert.match(rowByLabel(r.plain, 'flags'), /⚠ serving:opus/);
  });
  // The TRANSPOSE — label sonnet (2) over fable legs (10). Same predicate, opposite price direction.
  // Worth its own row because the report must be indifferent to which side is dearer: it answers
  // "did the labelled tier ever serve", never "which way would a price correction go".
  withModel(FABLE, (dirs) => {
    const r = renderTable(dirs, table(), 'Sonnet 5', 2);
    assert.deepEqual(r.sidecar.tierMismatch, { display: 'sonnet', serving: 'fable' });
    assert.match(rowByLabel(r.plain, 'flags'), /⚠ serving:fable/);
    assert.equal(r.sidecar.schema, 6);
  });
  // …and a third tier pair, so nothing is hard-coded to fable/opus/sonnet.
  withModel(SONNET, (dirs) => {
    const r = renderTable(dirs, table(), 'Haiku 4.5', 1);
    assert.deepEqual(r.sidecar.tierMismatch, { display: 'haiku', serving: 'sonnet' });
  });
});

// ═══ sprint 3 (2026-08-29, spec §A1): the switch is a TRANSCRIPT fact — QA rows D7/D10–D12 ═════════
// The stamp is derived per render from the banked per-leg models (modelSwitchReport); a display-label
// change alone neither adds nor removes it, and the stats file no longer carries it (spec §0.3 — the
// stats-file half of row D5 is asserted inside D7 here). The D1/D3 rewrite and rows D5/D6/D8/D9 are
// the developer's; these four are QA's.

// Runs the fact sheet against the state the render above just wrote, the way a /handover-check would.
function factsSheet(dirs) {
  const env = {
    ...process.env, USERPROFILE: dirs.home, HOME: dirs.home,
    CLAUDE_CONFIG_DIR: join(dirs.home, '.claude'), CLAUDE_PROJECT_DIR: dirs.cwd,
    TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW + 5),
  };
  delete env.CLAUDE_CODE_SESSION_ID;   // else the FOREIGN ownership guard fires
  return execFileSync(process.execPath, [join(here, '..', 'home', 'handover-facts.mjs')],
    { env, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
}

test('D7 — label and transcript switch at the SAME render: one key with the transcript ids, one note, no stats-file stamp', () => {
  withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 12; i++) lines += leg(i, FABLE);
    writeFileSync(dirs.transcript, lines, 'utf8');
    const r1 = render(dirs, 'Fable 5 (1M context)', 1.8);
    assert.ok(!('modelSwitch' in r1.sidecar), 'no key before the boundary');
    assert.ok(!('modelSwitch' in r1.stats) && !('modelSwitchedAtLeg' in r1.stats),
      'the stats file never carries the stamp keys (spec §0.3 — the D5 stats-file half)');
    appendFileSync(dirs.transcript, leg(13, SONNET), 'utf8');
    const r2 = render(dirs, 'Sonnet 5', 2.0);
    assert.deepEqual(r2.sidecar.modelSwitch, { atLeg: 13, from: FABLE, to: SONNET },
      'from/to are the transcript ids, ALWAYS (F2) — even at the render where the label moved too');
    assert.ok(!('modelSwitch' in r2.stats) && !('modelSwitchedAtLeg' in r2.stats),
      'the stats file carries neither key at the switch render either');
    const sheet = factsSheet(dirs);
    const notes = sheet.split('\n').filter((l) => l.startsWith('COST_MODELSWITCH_NOTE:'));
    assert.equal(notes.length, 1, `one note, never two (label + transcript is ONE switch): ${JSON.stringify(notes)}`);
    assert.match(notes[0], /claude-fable-5 → claude-sonnet-5 at leg 13/, 'named with the ids and the leg');
    assert.equal(sheet.split('switched mid-session').length - 1, 1, 'the fact is stated once in the whole sheet');
  });
});

test('D10 — F3: detection spans the WHOLE banked history — a boundary before runStartLeg still stamps', () => {
  withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 12; i++) lines += leg(i, i <= 3 ? OPUS : FABLE);
    writeFileSync(dirs.transcript, lines, 'utf8');
    const r0 = render(dirs, 'Fable 5 (1M context)', 6.0);
    assert.deepEqual(r0.sidecar.modelSwitch, { atLeg: 4, from: OPUS, to: FABLE }, 'stamped in run 0');
    // The resume (cost drops to 0) opens run 1 at leg 12 — the only boundary (leg 4) lies BEFORE it.
    // Pre-resume legs' dollars are still displayed at this run's rate, so their comparability matters.
    const r1 = render(dirs, 'Fable 5 (1M context)', 0);
    assert.equal(r1.stats.runIdx, 1, 'the resume was detected (P1 shape)');
    assert.equal(r1.stats.runStartLeg, 12);
    assert.deepEqual(r1.sidecar.modelSwitch, { atLeg: 4, from: OPUS, to: FABLE },
      'the pre-resume boundary still stamps — detection is not gated on runStartLeg');
    appendFileSync(dirs.transcript, leg(13, FABLE), 'utf8');
    const r2 = render(dirs, 'Fable 5 (1M context)', 0.5);
    assert.deepEqual(r2.sidecar.modelSwitch, { atLeg: 4, from: OPUS, to: FABLE }, 'and survives the first new leg');
  });
});

test('D11 — F4: two boundaries in the transcript → ONE key naming the LATEST', () => {
  withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 12; i++) lines += leg(i, i <= 4 ? OPUS : (i <= 8 ? FABLE : OPUS));
    writeFileSync(dirs.transcript, lines, 'utf8');
    const r = render(dirs, 'Opus 5', 6.0);
    assert.deepEqual(r.sidecar.modelSwitch, { atLeg: 9, from: FABLE, to: OPUS },
      'opus → fable → opus names the return boundary, not the first');
    const sheet = factsSheet(dirs);
    const notes = sheet.split('\n').filter((l) => l.startsWith('COST_MODELSWITCH_NOTE:'));
    assert.equal(notes.length, 1, `one note on a double switch: ${JSON.stringify(notes)}`);
    assert.match(notes[0], /at leg 9/);
    assert.ok(!notes[0].includes('leg 5'), 'the earlier boundary is not the one named');
  });
});

test('D12 — the false-stamp regression, live: a display flip over a constant-tier transcript stamps NOTHING', () => {
  // The `flags-many` shape. Before this sprint the display-based detector stamped Opus → Sonnet here,
  // which the fixture's own COST_TIER_NOTE contradicted — the label caveat said opus did the serving
  // while the stamp claimed a switch away from it. Driven live rather than read off the re-blessed
  // golden, so it cannot come back silently.
  withDirs((dirs) => {
    let lines = '';
    for (let i = 1; i <= 12; i++) lines += leg(i, OPUS);
    writeFileSync(dirs.transcript, lines, 'utf8');
    render(dirs, 'Opus 5', 1.8);
    appendFileSync(dirs.transcript, leg(13, OPUS), 'utf8');
    const r2 = render(dirs, 'Sonnet 5', 2.0);
    assert.ok(!('modelSwitch' in r2.sidecar), 'no sidecar key — no leg was ever served at another tier');
    assert.ok(!('modelSwitch' in r2.stats) && !('modelSwitchedAtLeg' in r2.stats), 'no stats stamp');
    const sheet = factsSheet(dirs);
    assert.ok(!sheet.includes('COST_MODELSWITCH_NOTE'), 'no switch note');
    assert.match(sheet, /COST_TIER_NOTE:.*`opus` served the most legs/,
      'the LABEL caveat still fires — sonnet never served; that is the different fact, and the only one');
  });
});
