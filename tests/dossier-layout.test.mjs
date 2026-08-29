import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// dossier-layout — the mechanics tests for the Dossier IV two-column grid (2026-08-22, bsl6.1.0.0).
//
// Spec: .claude/plans/260822-statusline-dossier4-spec.md
// Acceptance examples (frozen at [G1], commit 788d72a): .claude/plans/260822-statusline-dossier4-acceptance.md
//
// Every assertion below refines within an acceptance example and cites it. None of them may
// contradict one: an example that cannot pass as written is a spec event, not a test to adjust.
//
// WIDTH IS COUNTED, NEVER MEASURED. The spec (§4) fixes one cell per code point on the
// ANSI-stripped string, and every glyph in the design is Unicode-ambiguous-width. So these tests
// count code points and make no claim about how a terminal draws them — a terminal that draws ❆ or
// █ double-wide pushes that one row's tail right, which the spec accepts as a documented tolerance.
// The live-render check at [G2.5] is what covers the visual result.

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', 'tools', 'parity', 'fixtures');

// A fixture is a directory that contains stdin.json — a stray dir (scratch, editor leftovers) is not one.
const dirs = () => readdirSync(FIX).filter((n) => statSync(join(FIX, n)).isDirectory() && existsSync(join(FIX, n, 'stdin.json')));
// Blessed only — a fixture's goldens appear when it is blessed, and the bless is a separate reviewed
// act at the quality gate. `fixture inventory` below is the row that fails while any dir is unblessed.
const blessed = () => dirs().filter((n) => existsSync(join(FIX, n, 'golden.txt')));

const STRIP = /\x1b\[[0-9;]*m/g;
const raw = (f) => readFileSync(join(FIX, f, 'golden.txt'), 'utf8');
const plain = (f) => raw(f).replace(STRIP, '');
const stdinOf = (f) => JSON.parse(readFileSync(join(FIX, f, 'stdin.json'), 'utf8'));
const metaOf = (f) => JSON.parse(readFileSync(join(FIX, f, 'meta.json'), 'utf8'));
const visLen = (s) => s.replace(STRIP, '').length;

// ---- the grid ----------------------------------------------------------------------------------
const LEFT_CELLS = 53;          // spec §4 — hard invariant: it positions the divider
const DIV = '│ ';               // columns 54-55
const LEFT_LABEL = 6, RIGHT_LABEL = 7, GAP = 2;

// One row split at the divider. Works on the raw row (escapes intact) and on the plain one.
function halves(row) {
  const i = row.indexOf('│');
  if (i < 0) return { hasDivider: false, left: row, right: null };
  return { hasDivider: true, left: row.slice(0, i), right: row.slice(i + 1).replace(/^ /, ''), at: i };
}
// Position 0 of every row is a near-black `.` standing in for the first pad space — a row may not
// begin with whitespace or the pad is stripped before it reaches the screen (see statusline.mjs
// `guardLead`). Every field measurement below wants the cell it occupies, not its identity, so the
// dot is read back as the space it replaced. Test 0 is what pins the dot itself.
const unlead = (r) => r.replace(/^\./, ' ');
const plainRows = (f) => plain(f).split('\n').map(unlead);
const rawRows = (f) => raw(f).split('\n');
// A fixed row is no longer at a fixed index: a row whose two halves are both silent does not render
// (statusline.mjs `gridRow` returns null), so the block below finds rows by the label they carry.
const labelPair = (row) => { const h = halves(row); return [leftLabel(h.left), rightLabel(h.right)]; };
const isSpotlight = (row) => /^[❆◆]/.test(labelPair(row)[0]);
const rowIndexByLabel = (f, label) =>
  plainRows(f).findIndex((r) => { const [l, rr] = labelPair(r); return l === label || rr === label; });
const rowWithLabel = (f, label) => { const i = rowIndexByLabel(f, label); return i < 0 ? null : plainRows(f)[i]; };
// Where the fixed block ends and the spotlight block begins.
const nFixed = (f) => { const i = plainRows(f).findIndex(isSpotlight); return i < 0 ? plainRows(f).length : i; };
// label / value of a half, on the PLAIN text
const leftLabel = (h) => h.slice(0, LEFT_LABEL).trim();
const leftValue = (h) => h.slice(LEFT_LABEL + GAP);
const rightLabel = (h) => (h ?? '').slice(0, RIGHT_LABEL).trim();
const rightValue = (h) => (h ?? '').slice(RIGHT_LABEL + GAP);

// The six fixed rows, in frozen order (spec §6-§7). Row 4 (index 3) is the runway row and carries
// no label in either half.
const FIXED = [
  ['model', 'cost'],
  ['ctx', 'trend'],
  ['5h', '7d'],
  ['', ''],
  ['⁂', 'repo'],
  ['cold', 'flags'],
];

// ================================================================================================
// 1. The cell-width table — this comes FIRST because every geometry assertion below is meaningless
//    if the counting rule is wrong.
// ================================================================================================

test('1 — cell-width table: every glyph in the design counts as exactly one cell', () => {
  // The spec's counting rule is "one cell per code point on the ANSI-stripped string". This row pins
  // that each glyph the layout uses IS one code point — an accidental combining sequence or a
  // surrogate pair would silently break every padded field.
  const GLYPHS = ['│', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '→', '←', '·', '❆', '◆', '⁂', '⚠', 'Σ', '…', '~', '$', '%'];
  for (const g of GLYPHS) {
    assert.equal([...g].length, 1, `${g} is not a single code point`);
    assert.equal(visLen(g), 1, `${g} does not count as one cell`);
  }
  // And the divider is exactly two cells: U+2502 then one space (spec §4).
  assert.equal(DIV.length, 2);
  assert.equal([...DIV].length, 2);
  assert.equal(DIV, '│ ');
});

// ================================================================================================
// Geometry — A1, A2, A10
// ================================================================================================

test('0 — every row begins with the near-black pad dot, never with whitespace', () => {
  // A row that starts with a space loses that space before it reaches the screen. Each row's label
  // leaves a different number of leading spaces, so the rows slid left by different amounts and the
  // grid bent — the right half dragged along, which is why the right column's labels staggered too.
  // The dot REPLACES the first pad space, so the row is still 53 cells (test 2 holds that line).
  let rows = 0;
  for (const f of blessed()) {
    for (const row of rawRows(f)) {
      assert.ok(row.startsWith('\x1b[38;5;234m.\x1b[0m'),
        `${f}: a row must open with the pad dot, not whitespace: ${JSON.stringify(row.slice(0, 24))}`);
      rows++;
    }
  }
  assert.ok(rows >= 400, `vacuity guard: only ${rows} rows checked`);
});

test('2 — the left column is exactly 53 cells on every row of every golden (A1)', () => {
  let rows = 0;
  for (const f of blessed()) {
    plainRows(f).forEach((row, i) => {
      const h = halves(row);
      assert.ok(h.hasDivider, `${f} row ${i + 1}: no divider — every row is a grid row (A1)`);
      assert.equal(h.left.length, LEFT_CELLS,
        `${f} row ${i + 1}: left column is ${h.left.length} cells, not ${LEFT_CELLS}\n  ${JSON.stringify(h.left)}`);
      rows++;
    });
  }
  assert.ok(rows >= 400, `vacuity guard: only ${rows} rows checked`);
});

test('3 — the divider sits at columns 54-55 on every row, empty right half included (A1, A10)', () => {
  for (const f of blessed()) {
    plainRows(f).forEach((row, i) => {
      const at = row.indexOf('│');
      assert.equal(at, LEFT_CELLS, `${f} row ${i + 1}: divider at column ${at + 1}, not 54`);
      // `│ ` — the divider owns its trailing space, so a row with an empty right half still shows it.
      // A row whose right half is empty is right-trimmed, so it may end at the bar itself.
      const after = row.slice(at + 1);
      assert.ok(after === '' || after.startsWith(' '),
        `${f} row ${i + 1}: the divider must be followed by its space or end the row: ${JSON.stringify(after)}`);
    });
    // Every row's divider is at the same column — stated as its own property, since that is what a
    // reader sees (A1) and a per-row assertion could pass on a corpus where each fixture drifted.
    const cols = new Set(plainRows(f).map((r) => r.indexOf('│')));
    assert.deepEqual([...cols], [LEFT_CELLS], `${f}: divider column varies across rows: ${[...cols]}`);
  }
});

test('4 — no rendered row carries trailing whitespace (spec §7.4)', () => {
  for (const f of blessed()) {
    plainRows(f).forEach((row, i) => {
      assert.equal(row, row.replace(/\s+$/, ''),
        `${f} row ${i + 1}: trailing whitespace — the assembler must right-trim every row`);
    });
  }
});

test('5 — labels are right-aligned in their field and every label in a column ends at one column (A1)', () => {
  for (const f of blessed()) {
    for (const [i, row] of plainRows(f).entries()) {
      const h = halves(row);
      // Left: 6-cell field then a 2-cell gap. A label shorter than 6 is space-padded on the LEFT.
      // Right-aligned means leading spaces and NO trailing space; the content itself may contain a
      // space — a spotlight row's label is `<glyph> <idx>` (spec §7.9), e.g. `   ◆ 6`.
      const ALIGNED = /^ *$|^ *\S(.*\S)?$/;
      const lf = h.left.slice(0, LEFT_LABEL);
      assert.match(lf, ALIGNED, `${f} row ${i + 1}: left label field is not right-aligned: ${JSON.stringify(lf)}`);
      assert.equal(h.left.slice(LEFT_LABEL, LEFT_LABEL + GAP).trim(), '',
        `${f} row ${i + 1}: the 2-cell gap after the left label is not blank`);
      if (h.right) {
        const rf = h.right.slice(0, RIGHT_LABEL);
        assert.match(rf, ALIGNED, `${f} row ${i + 1}: right label field is not right-aligned: ${JSON.stringify(rf)}`);
      }
    }
  }
});

test('6 — the fixed rows keep their frozen ORDER; a silent one is skipped, never reordered (A2)', () => {
  for (const f of blessed()) {
    const rows = plainRows(f).slice(0, nFixed(f));
    let p = 0, matched = 0;
    for (const row of rows) {
      const [l, r] = labelPair(row);
      let k = -1;
      for (let i = p; i < FIXED.length; i++) {
        const [fl, fr] = FIXED[i];
        if ((l === fl || l === '') && (r === fr || r === '')) { k = i; break; }
      }
      assert.ok(k >= 0, `${f}: ${JSON.stringify(row)} is not the next fixed row in the frozen order`);
      p = k + 1; matched++;
    }
    assert.ok(matched >= 1, `${f}: not one fixed row rendered`);
    // model/cost can never be silent, so it always leads.
    assert.deepEqual(labelPair(plainRows(f)[0]), ['model', 'cost'], `${f}: the model row leads`);
  }
});

// ================================================================================================
// The trend strip — A15
// ================================================================================================

// A tinted chip: BgTint emits foreground+background in ONE sequence (`38;2;R;G;B;48;2;r;g;b`).
const TINTED = /\x1b\[38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+m(.*?)\x1b\[0m/g;

test('7 — every trend chip is a 6-cell slot and the tint covers all six (A15)', () => {
  let chips = 0;
  for (const f of blessed()) {
    const row = rawRows(f)[1];                       // row 2 — ctx | trend
    const right = halves(row).right ?? '';
    for (const m of right.matchAll(TINTED)) {
      const cells = visLen(m[1]);
      const value = m[1].trimEnd();
      // The slot is 6 cells. Spec §7.2 carries ONE sanctioned exception: a value needing 6 or more
      // cells of its own (a leg at $10 or more) fills the slot, and a single tinted pad space is still
      // appended so two values never abut — so the run is the value's own width plus one, and the
      // row's tail pushes right. `overcap` renders $33.37 and $10.77 and is the fixture that reaches it.
      const want = value.length >= 6 ? value.length + 1 : 6;
      assert.equal(cells, want,
        `${f}: a trend chip's tinted run is ${cells} cells, expected ${want} for the value ${JSON.stringify(value)} — call BgTint with the slot's content instead of letting it self-pad (spec §7.2)`);
      // Either way the ground covers the pad: the run must end in a space, never a bare value.
      assert.match(m[1], / $/, `${f}: the tinted ground must cover the pad space, not stop at the value: ${JSON.stringify(m[1])}`);
      chips++;
    }
  }
  assert.ok(chips >= 300, `vacuity guard: only ${chips} tinted chips seen`);
});

test('8 — adjacent trend chips form one continuous band with no untinted cell between them (A15)', () => {
  for (const f of blessed()) {
    const right = halves(rawRows(f)[1]).right ?? '';
    // Between one TINTED chip's reset and the next tinted chip's opening there must be NOTHING — no
    // space, no separator. That is what makes the value cells read as one band rather than eight
    // buttons. The placeholder run is deliberately excluded: `··` cells are untinted chrome with
    // untinted padding (spec §7.2), so the placeholder-to-first-chip boundary legitimately carries
    // the placeholder's own pad and is not a gap in the band.
    const CHIP_TO_CHIP = /\x1b\[38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+m[^\x1b]*\x1b\[0m([^\x1b]*)(?=\x1b\[38;2;\d+;\d+;\d+;48;2;)/g;
    const between = [...right.matchAll(CHIP_TO_CHIP)].map((m) => m[1]);
    for (const gap of between) {
      assert.equal(gap, '',
        `${f}: ${JSON.stringify(gap)} sits between two tinted trend chips — the band must be unbroken (A15)`);
    }
    // Non-vacuity: a fixture with two or more value cells must actually exercise a chip-to-chip join.
    const nChips = [...right.matchAll(TINTED)].length;
    if (nChips >= 2) assert.ok(between.length >= 1, `${f}: ${nChips} chips but no chip-to-chip boundary examined`);
  }
});

test('9 — placeholder trend cells are untinted dots, still 6 cells wide (A15)', () => {
  let seen = 0;
  for (const f of blessed()) {
    const rowRaw = halves(rawRows(f)[1]).right ?? '';
    const rowPlain = halves(plainRows(f)[1]).right ?? '';
    if (!rowPlain.includes('··')) continue;
    seen++;
    // No tinted run may contain a placeholder: `··` is chrome, not a value.
    for (const m of rowRaw.matchAll(TINTED)) {
      assert.ok(!m[1].includes('··'), `${f}: a placeholder cell is tinted — it must be plain chrome (spec §7.2)`);
    }
    // Each placeholder occupies its own 6-cell slot: the value field's cells divide into 6s.
    const field = rowPlain.slice(RIGHT_LABEL + GAP);
    const strip = field.slice(0, 48);
    assert.equal(strip.length, 48, `${f}: the eight trend slots are not 48 cells: ${JSON.stringify(strip)}`);
    for (let i = 0; i < 8; i++) {
      const slot = strip.slice(i * 6, i * 6 + 6);
      assert.equal(slot.length, 6, `${f}: trend slot ${i + 1} is ${slot.length} cells`);
      assert.ok(/··/.test(slot) || /\$/.test(slot), `${f}: trend slot ${i + 1} is neither a value nor a placeholder: ${JSON.stringify(slot)}`);
    }
  }
  assert.ok(seen >= 8, `vacuity guard: only ${seen} fixtures exercise placeholder cells`);
});

test('10 — the trend strip is the only tinted element anywhere on the display (A15)', () => {
  for (const f of blessed()) {
    rawRows(f).forEach((row, i) => {
      if (i === 1) return;                            // the trend row is where tint belongs
      const hits = [...row.matchAll(/48;2;/g)];
      assert.equal(hits.length, 0,
        `${f} row ${i + 1}: a tinted background outside the trend row — deleting the % fill chip leaves the trend cells as the line's only tinted language (spec §5)`);
    });
  }
});

// ================================================================================================
// Quota — the three regimes and both constant edges. A5, A6, A7, A8, A9
// ================================================================================================

const W = { five_hour: 18000, seven_day: 604800 };
const IMPERATIVES = ['you can keep this pace', 'slow down just a bit', 'slow down hard', 'slow down'];

// What regime a window is in, computed from the payload + the fixture's frozen clock — never read
// back off the render, so the render has something independent to be compared against.
function regimeOf(f, win) {
  const rl = stdinOf(f)?.rate_limits?.[win];
  if (!rl || rl.used_percentage === null || rl.used_percentage === undefined) return 'absent';
  const now = metaOf(f).nowEpoch;
  const consumed = Number(rl.used_percentage);
  const elapsed = rl.resets_at == null ? null
    : Math.min(100, Math.max(0, ((W[win] - (Number(rl.resets_at) - now)) / W[win]) * 100));
  if (consumed >= 100) return 'cap';
  if (consumed >= 50) return 'verdict';
  if (elapsed == null || elapsed < 10) return 'calm-bare';
  // Below the verdict floor the projection ALSO requires spending to be at or behind the clock
  // (coordinator ruling, 2026-08-22). `ends ~N% · M% spare` is the calm phrasing and it means nothing
  // while consumption runs ahead of pace: it produced `ends ~200% · -100% spare`, a negative "spare".
  // The cluster already refuses to project a blackout this early because β is unstable here, so
  // silence is the correct output and the gauge still shows both numbers.
  return consumed <= elapsed ? 'calm-projecting' : 'calm-overpace';
}
const quotaHalf = (f, win) => {
  const rows = plainRows(f);
  const gi = rows.findIndex((r) => labelPair(r)[0] === '5h');
  const h3 = gi < 0 ? null : halves(rows[gi]);
  // The runway row carries no label in either half and sits directly under the gauge row. It does
  // not render when both windows have nothing to say, so it may simply be absent.
  const next = gi < 0 ? null : rows[gi + 1];
  const h4 = next && labelPair(next).every((x) => x === '') ? halves(next) : null;
  return win === 'five_hour'
    ? { gauge: h3 ? leftValue(h3.left) : '', runway: h4 ? leftValue(h4.left) : '' }
    : { gauge: h3 ? rightValue(h3.right) : '', runway: h4 ? rightValue(h4.right) : '' };
};

test('11 — the gauge row always renders; the runway row renders when a window has a runway (A5-A9)', () => {
  let withRunway = 0, without = 0;
  for (const f of blessed()) {
    const rows = plainRows(f);
    const gi = rows.findIndex((r) => labelPair(r)[0] === '5h');
    assert.ok(gi >= 0, `${f}: the gauge row always renders`);
    assert.deepEqual(labelPair(rows[gi]), ['5h', '7d'], `${f}: both quota labels on the gauge row`);
    assert.ok(halves(rows[gi]).hasDivider, `${f}: the gauge row renders both halves`);
    const next = rows[gi + 1];
    const rendered = !!next && labelPair(next).every((x) => x === '');
    const said = (quotaHalf(f, 'five_hour').runway + quotaHalf(f, 'seven_day').runway).trim() !== '';
    assert.equal(rendered, said,
      `${f}: the label-less runway row renders exactly when a window has something to say`);
    if (rendered) withRunway++; else without++;
  }
  assert.ok(withRunway >= 1 && without >= 1,
    `vacuity guard: both states must occur in the corpus (with ${withRunway}, without ${without})`);
});

test('12 — the three quota regimes are distinguishable, per window, per fixture (A5, A6, A7)', () => {
  const counts = { absent: 0, 'calm-bare': 0, 'calm-overpace': 0, 'calm-projecting': 0, verdict: 0, cap: 0 };
  for (const f of blessed()) {
    for (const win of ['five_hour', 'seven_day']) {
      const r = regimeOf(f, win);
      counts[r]++;
      const { gauge, runway } = quotaHalf(f, win);
      const hasImperative = IMPERATIVES.some((v) => gauge.includes(v));
      const hasProjection = /ends ~\d+% · -?\d+% spare/.test(runway);
      const hasResets = /resets /.test(runway);
      if (r === 'absent') {
        assert.match(gauge, /^n\/a\b/, `${f}/${win}: an absent window states the fact in one token (A9)`);
        assert.equal(runway.trim(), '', `${f}/${win}: an absent window's runway half is blank (A9)`);
        continue;
      }
      assert.match(gauge, /→\d+%.*\d*%?←/, `${f}/${win}: the gauge must render in every present regime`);
      if (r === 'calm-bare') {
        assert.ok(!hasImperative, `${f}/${win}: below the verdict floor no imperative may render (A6): ${gauge}`);
        assert.ok(!hasProjection, `${f}/${win}: too little elapsed to project — the projection must be withheld (A6): ${runway}`);
        assert.ok(hasResets, `${f}/${win}: resets still renders (A6): ${runway}`);
      } else if (r === 'calm-overpace') {
        assert.ok(!hasImperative, `${f}/${win}: below the verdict floor no imperative may render: ${gauge}`);
        assert.ok(!hasProjection, `${f}/${win}: spending runs ahead of the clock — the calm projection must be withheld: ${runway}`);
        assert.ok(hasResets, `${f}/${win}: resets still renders: ${runway}`);
      } else if (r === 'calm-projecting') {
        assert.ok(!hasImperative, `${f}/${win}: below the verdict floor no imperative may render (A5): ${gauge}`);
        assert.ok(hasProjection, `${f}/${win}: the ratio projection must render (A5): ${runway}`);
      } else if (r === 'verdict') {
        assert.ok(hasImperative, `${f}/${win}: at or above the verdict floor an imperative must render (A7): ${gauge}`);
      } else if (r === 'cap') {
        assert.match(gauge, /\b(cap reached|over cap)\b/, `${f}/${win}: the cap state must be named (A8): ${gauge}`);
      }
    }
  }
  // Every regime must actually occur, or the row above proves nothing.
  for (const k of Object.keys(counts)) {
    assert.ok(counts[k] >= 1, `vacuity guard: regime ${k} never occurs in the corpus (${JSON.stringify(counts)})`);
  }
});

test('13 — the verdict-floor edge flips only across the boundary (A5, A7)', () => {
  // quota-verdict-edge holds 49% on the 5h window and 50% on the 7d window, both at the same elapsed
  // fraction, so the ONLY visible difference between the two halves is the imperative. That is what
  // makes it an edge test rather than two unrelated renderings.
  const f = 'quota-verdict-edge';
  // Loud, never silent: a single-fixture row that RETURNED while its fixture was unblessed would
  // pass vacuously, which is the failure mode these edge rows exist to rule out.
  assert.ok(existsSync(join(FIX, f, 'golden.txt')),
    `${f} is not blessed yet, so this guard cannot run — bless it at the quality gate (see the fixture-inventory row)`);
  assert.equal(regimeOf(f, 'five_hour'), 'calm-projecting', 'the 5h side must sit just BELOW the floor');
  assert.equal(regimeOf(f, 'seven_day'), 'verdict', 'the 7d side must sit exactly AT the floor');
  const lo = quotaHalf(f, 'five_hour'), hi = quotaHalf(f, 'seven_day');
  assert.ok(!IMPERATIVES.some((v) => lo.gauge.includes(v)), `just below the floor: no imperative (${lo.gauge})`);
  assert.ok(IMPERATIVES.some((v) => hi.gauge.includes(v)), `exactly at the floor: an imperative (${hi.gauge})`);
  // Both halves still project, so the projection is NOT what the boundary controls.
  assert.match(lo.runway, /ends ~\d+% · -?\d+% spare/);
  assert.match(hi.runway, /ends ~\d+% · -?\d+% spare/);
});

test('14 — the projection-floor edge flips only across the boundary (A5, A6)', () => {
  // quota-elapsed-edge holds 9% elapsed on the 5h window and 11% on the 7d window, both windows
  // calm, so the only difference is whether the projection renders at all.
  const f = 'quota-elapsed-edge';
  // Loud, never silent: a single-fixture row that RETURNED while its fixture was unblessed would
  // pass vacuously, which is the failure mode these edge rows exist to rule out.
  assert.ok(existsSync(join(FIX, f, 'golden.txt')),
    `${f} is not blessed yet, so this guard cannot run — bless it at the quality gate (see the fixture-inventory row)`);
  assert.equal(regimeOf(f, 'five_hour'), 'calm-bare', 'the 5h side must sit just BELOW the projection floor');
  assert.equal(regimeOf(f, 'seven_day'), 'calm-projecting', 'the 7d side must sit just ABOVE it');
  const lo = quotaHalf(f, 'five_hour'), hi = quotaHalf(f, 'seven_day');
  assert.ok(!/ends ~/.test(lo.runway), `too early to project — withheld (${lo.runway})`);
  assert.match(hi.runway, /ends ~\d+% · \d+% spare/, `past the floor — projected (${hi.runway})`);
  assert.match(lo.runway, /resets /, 'resets renders either way');
  assert.match(hi.runway, /resets /);
});

test('32 — over pace but still young: gauge and resets, and NO negative spare', () => {
  // THE REGRESSION GUARD for the negative-spare defect (found 2026-08-22, ruled a defect the same
  // day). `quota-overpace-young` reproduced it exactly: 40% consumed in 20% elapsed rendered
  // `ends ~200% · -100% spare`, a projection whose own arithmetic says the window ends at twice its
  // size and leaves minus one hundred percent spare. The 7d half of the same fixture is under pace and
  // DOES project, so one render carries both sides of the condition.
  const f = 'quota-overpace-young';
  // Loud, never silent: a single-fixture row that RETURNED while its fixture was unblessed would
  // pass vacuously, which is the failure mode these edge rows exist to rule out.
  assert.ok(existsSync(join(FIX, f, 'golden.txt')),
    `${f} is not blessed yet, so this guard cannot run — bless it at the quality gate (see the fixture-inventory row)`);
  assert.equal(regimeOf(f, 'five_hour'), 'calm-overpace', 'the 5h side must be over pace and young');
  assert.equal(regimeOf(f, 'seven_day'), 'calm-projecting', 'the 7d side must be under pace and projecting');

  const over = quotaHalf(f, 'five_hour');
  // NON-VACUITY FIRST. A row that silently rendered empty would satisfy every negative below, so
  // prove there is something there before asserting what is not.
  assert.notEqual(over.gauge.trim(), '', 'the over-pace gauge must render — an empty row would pass every check below');
  assert.match(over.gauge, /→40%.*20%←/, `the gauge still shows both numbers: ${over.gauge}`);
  assert.notEqual(over.runway.trim(), '', 'the over-pace runway must render its resets figure, not nothing');
  assert.match(over.runway, /resets /, `resets renders: ${over.runway}`);

  // The absences, now that the row is known to be non-empty.
  assert.ok(!over.runway.includes('-'), `no minus sign may appear on the row: ${over.runway}`);
  assert.ok(!/spare/.test(over.runway), `no spare figure while spending runs ahead of pace: ${over.runway}`);
  assert.ok(!/ends ~/.test(over.runway), `no projection while spending runs ahead of pace: ${over.runway}`);
  assert.ok(!IMPERATIVES.some((v) => over.gauge.includes(v)), `no imperative below the verdict floor: ${over.gauge}`);
  // The row is gauge + resets and nothing else.
  assert.match(over.runway.trim(), /^resets \S+$/, `the runway half is resets alone: ${JSON.stringify(over.runway)}`);

  // And the under-pace half beside it is unaffected — the ruling narrowed the projection, not killed it.
  const under = quotaHalf(f, 'seven_day');
  assert.match(under.runway, /ends ~\d+% · \d+% spare/, `the under-pace half still projects: ${under.runway}`);
  assert.ok(!under.runway.includes('-'), `and its spare is positive: ${under.runway}`);
});

test('33 — a model name past its budget truncates at 29 code points plus an ellipsis (spec §4)', () => {
  const f = 'model-name-long';
  // Loud, never silent: a single-fixture row that RETURNED while its fixture was unblessed would
  // pass vacuously, which is the failure mode these edge rows exist to rule out.
  assert.ok(existsSync(join(FIX, f, 'golden.txt')),
    `${f} is not blessed yet, so this guard cannot run — bless it at the quality gate (see the fixture-inventory row)`);
  const NAME = stdinOf(f).model.display_name;
  assert.ok([...NAME].length > 30, `the fixture's name must exceed the 30-cell budget (got ${[...NAME].length})`);
  const value = leftValue(halves(plainRows(f)[0]).left);
  const shown = value.split('  ')[0];               // the name field, before the 2-cell gap
  assert.equal([...shown].length, 30, `the name field is 30 cells: ${JSON.stringify(shown)}`);
  assert.ok(shown.endsWith('…'), `it must end in the ellipsis: ${JSON.stringify(shown)}`);
  assert.equal(shown, [...NAME].slice(0, 29).join('') + '…', 'exactly 29 code points of the name, then the ellipsis');
  // The truncation exists so the left column still positions the divider — the consequence, asserted
  // here on the one fixture that can actually reach it.
  assert.equal(halves(plainRows(f)[0]).left.length, LEFT_CELLS);
  // The effort field survives beside it: truncating the name must not push anything off the row.
  assert.match(value, /effort \S+/, `the effort field still renders: ${value}`);
});

test('15 — a below-floor quota half is never green (AE-1 as re-frozen at e1c6db5)', () => {
  // Sprint 1 N19, re-frozen 2026-08-29 (commit e1c6db5, Florian's ruling): only BELOW the verdict
  // floor is the gauge neutral-and-never-green. The second half this row used to carry ("rung 0
  // must render 240, not green", Dossier IV §7.3) is superseded by that ruling and DELETED — rung 0
  // at/above the floor now renders ANSI-32 green, pinned by sprint1-status.test.mjs row 35b.
  const GREENS = ['38;5;40', '\x1b[32m'];   // the retired Dossier-IV rung-0 colour + the new rung-0 green
  for (const f of blessed()) {
    for (const win of ['five_hour', 'seven_day']) {
      const r = regimeOf(f, win);
      if (r !== 'calm-bare' && r !== 'calm-projecting' && r !== 'absent') continue;
      const rowsRaw = rawRows(f);
      const half = win === 'five_hour' ? halves(rowsRaw[2]).left : (halves(rowsRaw[2]).right ?? '');
      for (const g of GREENS) {
        assert.ok(!half.includes(g),
          `${f}/${win}: a below-floor window renders green (${JSON.stringify(g)}) — under 50% consumed there is no verdict, so green here would make silence the loudest thing on screen`);
      }
    }
  }
});

test('16 — at cap: the verdict drops the window label and the hedge survives in full (A8)', () => {
  let seen = 0;
  for (const f of blessed()) {
    for (const win of ['five_hour', 'seven_day']) {
      if (regimeOf(f, win) !== 'cap') continue;
      seen++;
      const label = win === 'five_hour' ? '5h' : '7d';
      const { gauge, runway } = quotaHalf(f, win);
      assert.ok(!gauge.includes(`${label} cap`) && !gauge.includes(`${label} over`),
        `${f}/${win}: the verdict repeats the window label, which the label field already carries (A8): ${gauge}`);
      assert.match(gauge, /\b(cap reached|over cap)\b/, `${f}/${win}: ${gauge}`);
      // The hedge is never abbreviated. When the half would overflow, `resets` is what drops — and
      // nothing else — so the sentence itself is always whole.
      const hedge = /on credits, or blocked til reset|on usage credits · paying overage/;
      assert.match(runway, hedge, `${f}/${win}: the at-cap detail must render in full (A8): ${runway}`);
      const overflows = visLen(runway) > 45 && win === 'five_hour';
      if (overflows) assert.ok(!/resets /.test(runway), `${f}/${win}: an overflowing half drops resets, not the sentence (A8)`);
    }
  }
  assert.ok(seen >= 2, `vacuity guard: only ${seen} at-cap halves`);
});

// ================================================================================================
// Flags — A11, A12, A13, A14
// ================================================================================================

const CAVEATS = [
  '⚠ leg $ suspect: base far below list (resumed without history?)',
  '⚠ $ excludes fast premium (understated)',
  '⚠ $-gates Fable/Opus-calibrated',
  '⚠ serving:',
  '⚠ tier-mix ',
];
const flagsOf = (f) => { const r = rowWithLabel(f, 'flags'); return r ? rightValue(halves(r).right) : ''; };

test('17 — the setting flags render exactly on their own conditions (A11, A12, A13)', () => {
  let fastOn = 0, thinkOff = 0, styled = 0;
  for (const f of blessed()) {
    const d = stdinOf(f);
    const flags = flagsOf(f);
    const wantFast = d.fast_mode === true;
    const wantThink = d?.thinking?.enabled === false;
    const style = d?.output_style?.name;
    const wantStyle = !!style && style !== 'default';

    assert.equal(/\bfast on\b/.test(flags), wantFast, `${f}: fast on vs fast_mode ${JSON.stringify(d.fast_mode)}: ${flags}`);
    assert.equal(/\bthink off\b/.test(flags), wantThink, `${f}: think off vs thinking ${JSON.stringify(d.thinking)}: ${flags}`);
    assert.equal(/\bstyle \S/.test(flags), wantStyle, `${f}: style vs output_style ${JSON.stringify(style)}: ${flags}`);
    if (wantStyle) assert.ok(flags.includes(`style ${style}`), `${f}: the style flag names the style itself (A13): ${flags}`);
    if (wantFast) fastOn++;
    if (wantThink) thinkOff++;
    if (wantStyle) styled++;
  }
  assert.ok(fastOn >= 2 && thinkOff >= 2 && styled >= 2,
    `vacuity guard: fast ${fastOn}, think ${thinkOff}, style ${styled}`);
});

test('18 — `fast off` and `think on` render nowhere, in any fixture (A11)', () => {
  for (const f of blessed()) {
    const p = plain(f);
    assert.ok(!/\bfast off\b/.test(p) && !/fast:off/.test(p), `${f}: fast off must never render (A11)`);
    assert.ok(!/\bthink on\b/.test(p) && !/think:on/.test(p), `${f}: think on must never render (A11)`);
  }
});

test('19 — all five caveat chips live on the flags row, verbatim, and nowhere else (A11, A14)', () => {
  const seen = new Map(CAVEATS.map((c) => [c, 0]));
  for (const f of blessed()) {
    const rows = plainRows(f);
    const flags = flagsOf(f);
    for (const c of CAVEATS) {
      if (!plain(f).includes(c)) continue;
      seen.set(c, seen.get(c) + 1);
      assert.ok(flags.includes(c), `${f}: "${c}" must sit in the flags cluster (A14) — found elsewhere on the display`);
      // and on no other row
      const fi = rowIndexByLabel(f, 'flags');
      rows.forEach((row, i) => {
        if (i === fi) return;
        assert.ok(!row.includes(c), `${f} row ${i + 1}: "${c}" belongs on the flags row only`);
      });
    }
    // The one this sprint MOVED: it used to sit next to the money.
    if (flags.includes('⚠ $ excludes fast premium (understated)')) {
      assert.ok(!plainRows(f)[0].includes('excludes fast premium'),
        `${f}: the fast-premium caveat must leave the cost row (A11)`);
    }
  }
  for (const [c, n] of seen) assert.ok(n >= 1, `vacuity guard: caveat never fires in the corpus: ${c}`);
});

test('20 — the crowded flags row keeps every chip whole (A14)', () => {
  const f = 'flags-many';
  // Loud, never silent: a single-fixture row that RETURNED while its fixture was unblessed would
  // pass vacuously, which is the failure mode these edge rows exist to rule out.
  assert.ok(existsSync(join(FIX, f, 'golden.txt')),
    `${f} is not blessed yet, so this guard cannot run — bless it at the quality gate (see the fixture-inventory row)`);
  const flags = flagsOf(f);
  for (const want of ['fast on', 'think off', 'style Explanatory']) {
    assert.ok(flags.includes(want), `${f}: ${want} missing from a row built to carry all of them: ${flags}`);
  }
  assert.ok(flags.includes('⚠ $ excludes fast premium (understated)'), `${f}: the fast caveat, in full`);
  assert.ok(flags.includes('⚠ $-gates Fable/Opus-calibrated'), `${f}: the gates caveat, in full`);
  assert.ok(!flags.includes('…'), `${f}: the right column never truncates — no caveat may be abbreviated (A14)`);
});

// ================================================================================================
// Empty clusters — A4
// ================================================================================================

test('21 — a cluster with nothing to say contributes nothing: no label, no glyph, no blank row (A4)', () => {
  // Supersedes the Dossier IV rule that an empty cluster rendered its label alone. A bare `cold` or
  // `flags` is noise, and the agents label was worse: it printed a glyph on every session that had
  // never spawned an agent.
  const empties = { cold: 0, fleet: 0, flags: 0 };
  for (const f of blessed()) {
    for (const row of plainRows(f)) {
      const h = halves(row);
      const [l, r] = labelPair(row);
      if (l !== '') assert.notEqual(leftValue(h.left).trim(), '',
        `${f}: left label "${l}" renders with no value: ${JSON.stringify(row)}`);
      if (r !== '') assert.notEqual(rightValue(h.right).trim(), '',
        `${f}: right label "${r}" renders with no value: ${JSON.stringify(row)}`);
      assert.notEqual(row.replace(/│/g, '').trim(), '',
        `${f}: a row silent on both sides must not render at all: ${JSON.stringify(row)}`);
    }
    if (rowIndexByLabel(f, 'cold') < 0) empties.cold++;
    if (rowIndexByLabel(f, '⁂') < 0) empties.fleet++;
    if (rowIndexByLabel(f, 'flags') < 0) empties.flags++;
  }
  assert.ok(empties.flags >= 20, `vacuity guard: ${empties.flags} suppressed flags clusters (expected >=20)`);
  assert.ok(empties.cold >= 30, `vacuity guard: ${empties.cold} suppressed cold clusters (expected >=30)`);
  assert.ok(empties.fleet >= 55, `vacuity guard: ${empties.fleet} suppressed fleet clusters (expected >=55)`);
});

// ================================================================================================
// Spotlight legs — A3, A10
// ================================================================================================

const spotlightRows = (f) => plainRows(f).slice(nFixed(f));

test('22 — spotlight legs pair two to a row, newest first, odd count leaving the right half empty (A3, A10)', () => {
  let odd = 0, even = 0;
  for (const f of blessed()) {
    const rows = spotlightRows(f);
    if (rows.length === 0) continue;
    // A spotlight cell puts `<glyph> <idx>` in the LABEL field and `$<usd>  <driver>` in the value
    // field (spec §7.9) — the glyph aligns with the fixed rows' labels above it, which is the point.
    const cells = [];
    rows.forEach((row, i) => {
      const h = halves(row);
      assert.ok(h.hasDivider, `${f} spotlight row ${i + 1}: the divider renders on every spotlight row (A10)`);
      const Llab = h.left.slice(0, LEFT_LABEL).trim(), Lval = leftValue(h.left).trim();
      const Rlab = (h.right ?? '').slice(0, RIGHT_LABEL).trim(), Rval = rightValue(h.right).trim();
      assert.notEqual(Llab, '', `${f} spotlight row ${i + 1}: a spotlight row's left half is never the empty one`);
      cells.push({ label: Llab, value: Lval });
      if (Rlab !== '' || Rval !== '') cells.push({ label: Rlab, value: Rval });
    });
    // Leg indices descend: newest first, left before right, row by row.
    const idx = cells.map((c) => {
      const m = /^([❆◆])\s*(\d+)$/.exec(c.label);
      assert.ok(m, `${f}: a spotlight label field is not "<glyph> <index>": ${JSON.stringify(c.label)}`);
      assert.match(c.value, /^\$[\d.,]+ /, `${f}: a spotlight value field must open with its dollar figure: ${JSON.stringify(c.value)}`);
      return Number(m[2]);
    });
    for (let i = 1; i < idx.length; i++) {
      assert.ok(idx[i] < idx[i - 1], `${f}: spotlight order must be newest-first: ${idx}`);
    }
    assert.equal(rows.length, Math.ceil(cells.length / 2), `${f}: ${cells.length} legs must occupy ${Math.ceil(cells.length / 2)} rows`);
    if (cells.length % 2 === 1) {
      odd++;
      const last = halves(rows[rows.length - 1]);
      // Empty means empty in BOTH fields of that half — no orphan glyph in the label field either.
      assert.equal((last.right ?? '').trim(), '',
        `${f}: an odd leg count leaves the final row's right half EMPTY — the block never borrows it (A10)`);
    } else even++;
  }
  assert.ok(odd >= 3, `vacuity guard: only ${odd} odd-count fixtures`);
  assert.ok(even >= 3, `vacuity guard: only ${even} even-count fixtures`);
});

test('34 — on a spotlight row colour is spent only on what happened (A19)', () => {
  // A19: everything on the row is quiet gray EXCEPT the marker glyph, the leg's dollar figure, the
  // verb that opens the description, and — on a leg that went cold — the words saying the cache had
  // expired. Asserted as a whitelist over the row's actual colour runs, so a NEW coloured element
  // anywhere on the row fails rather than slipping through a spot check.
  const CHROME = '38;5;240';
  const ALLOWED = new Set(['38;5;33', '38;5;179', '38;5;180', CHROME]);
  let rows = 0, verbs = 0, colds = 0;
  for (const f of blessed()) {
    for (const [i, row] of rawRows(f).slice(nFixed(f)).entries()) {
      rows++;
      for (const m of row.matchAll(/\x1b\[([0-9;]+)m([^\x1b]*)/g)) {
        const [code, text] = [m[1], m[2]];
        if (code === '0' || text === '') continue;
        // Position 0's near-black `.` stands in for a pad space (statusline.mjs `guardLead`); it is
        // padding, not an element of the row.
        if (code === '38;5;234' && text === '.') continue;
        // the dollar figure rides the shared truecolor per-leg gradient
        if (/^38;2;\d+;\d+;\d+$/.test(code)) {
          assert.match(text.trim(), /^\$[\d.,]+$/,
            `${f} spotlight row ${i + 1}: only the leg's dollar may carry the gradient, not ${JSON.stringify(text)}`);
          continue;
        }
        assert.ok(ALLOWED.has(code),
          `${f} spotlight row ${i + 1}: unexpected colour ${code} on ${JSON.stringify(text)} — A19 allows only the glyph, the dollar, the verb and \`cache expired\``);
        if (code === '38;5;180') { verbs++; assert.ok(text.trim().length > 0, 'the verb run is non-empty'); }
        if (code === '38;5;33' && /cache expired/.test(text)) colds++;
      }
    }
  }
  assert.ok(rows >= 30, `vacuity guard: only ${rows} spotlight rows examined`);
  assert.ok(verbs >= 30, `vacuity guard: only ${verbs} coloured verbs seen — the verb must actually be coloured`);
  assert.ok(colds >= 3, `vacuity guard: only ${colds} \`cache expired\` runs in cold blue`);
});

test('23 — the word `Leg` is gone from spotlight cells; no multiple, no age (A16)', () => {
  for (const f of blessed()) {
    for (const [i, row] of spotlightRows(f).entries()) {
      assert.ok(!/\bLeg \d/.test(row), `${f} spotlight row ${i + 1}: the word Leg is dropped (A16): ${row}`);
      assert.ok(!/x med\b/.test(row), `${f} spotlight row ${i + 1}: the x-median multiple is deleted (A16)`);
      assert.ok(!/\b(this leg|\d+ legs? ago)\b/.test(row), `${f} spotlight row ${i + 1}: the age in legs is deleted (A16)`);
    }
  }
});

// ================================================================================================
// The wall — A17, A18
// ================================================================================================

const wallOf = (f) => {
  const m = /wall (\S+)/.exec(leftValue(halves(plainRows(f)[1]).left));
  return m ? m[1] : null;
};

test('24 — the ordinary wall value, the estimate and `off` are all chrome gray (A17)', () => {
  const states = { off: 0, plain: 0, est: 0 };
  for (const f of blessed()) {
    const w = wallOf(f);
    if (w === null) continue;
    if (w === 'NOW' || w === '~NOW') continue;                 // A18's case
    const rowRaw = halves(rawRows(f)[1]).left;
    // The band ladders that must NOT colour this field.
    for (const hot of ['38;5;220', '38;5;208', '1;31', '38;5;40', '38;5;46']) {
      const seg = rowRaw.slice(rowRaw.indexOf('wall'));
      assert.ok(!seg.includes(hot),
        `${f}: the wall field carries ${hot} — the ordinary distance is never band-coloured (A17): ${w}`);
    }
    if (w === 'off') states.off++;
    else if (w.startsWith('~')) states.est++;
    else states.plain++;
  }
  assert.ok(states.off >= 5, `vacuity guard: ${states.off} 'wall off' fixtures`);
  assert.ok(states.plain >= 30, `vacuity guard: ${states.plain} plain-distance fixtures`);
  assert.ok(states.est >= 1, `vacuity guard: ${states.est} estimate-marker fixtures — wall-estimate must render it (A17)`);
});

test('25 — past the wall, the field is red bold, tilde included (A18)', () => {
  // The coordinator's ruling on the spec's line-279-vs-283 ambiguity, 2026-08-22: `~NOW` renders
  // ENTIRELY red bold. Pinned here so the question cannot be silently re-opened.
  let seen = 0;
  for (const f of blessed()) {
    const w = wallOf(f);
    if (w !== 'NOW' && w !== '~NOW') continue;
    seen++;
    const left = halves(rawRows(f)[1]).left;
    const m = /\x1b\[1;31m(~?NOW)\x1b\[0m/.exec(left);
    assert.ok(m, `${f}: the passed-the-wall field must be one red-bold run (A18): ${JSON.stringify(left.slice(-60))}`);
    assert.equal(m[1], w, `${f}: the whole value is inside the red-bold run — a gray tilde outside it splits the alarm`);
  }
  assert.ok(seen >= 2, `vacuity guard: only ${seen} past-the-wall fixtures`);
});

test('26 — the ctx token count keeps its band colour beside the quiet wall (A17)', () => {
  let coloured = 0;
  for (const f of blessed()) {
    const left = halves(rawRows(f)[1]).left;
    if (!/ctx/.test(left)) continue;
    if (/38;5;46|38;5;40|38;5;33|38;5;208|1;31/.test(left.slice(0, left.indexOf('wall') >= 0 ? left.indexOf('wall') : left.length))) coloured++;
  }
  assert.ok(coloured >= 30, `vacuity guard: only ${coloured} fixtures colour the token count — the band ladder must survive (A17)`);
});

// ================================================================================================
// Deleted elements — A16
// ================================================================================================

test('27 — every deleted element is absent from every golden (A16)', () => {
  const GONE = [
    [/\/handover-check/, 'the /handover-check advert'],
    [/⚑/, 'the advert flag glyph'],
    [/\[old\]|\[new\]/, 'the sparkline old/new anchors'],
    [/\$\/leg/, 'the $/leg caption'],
    [/tax \d+%/, 'the cold tax percentage'],
    [/legs \d+\/\d+ \(\d+%\)/, 'the cold leg count and share'],
    [/just paid|\d+ legs? ago/, 'the recent-cold recency tag'],
    [/x med\b/, 'the spotlight median multiple'],
    [/\(med [\d.]+[kM]?·max/, 'the fleet median/max parenthetical'],
    [/\(\d+\)\s*$/m, 'the parenthesised trend leg count'],
    [/\bΣctx\b/, 'the old fleet Σctx label (now `Σ`)'],
    [/\bsum\b/, 'the fleet sum label (now `Σ`, sprint 1 N20)'],
  ];
  for (const f of blessed()) {
    const p = plain(f);
    for (const [re, what] of GONE) {
      assert.ok(!re.test(p), `${f}: ${what} still renders (A16)`);
    }
  }
});

test('28 — the fill-percentage chip is gone from the ctx row (A16)', () => {
  for (const f of blessed()) {
    const ctx = leftValue(halves(plainRows(f)[1]).left);
    // The row keeps `<tokens>/<window>  wall <value>` and nothing shaped like a standalone percent.
    assert.ok(!/\b\d+%/.test(ctx), `${f}: a percentage still renders on the ctx row (A16): ${ctx}`);
  }
});

// ================================================================================================
// Fixture hygiene
// ================================================================================================

test('29 — fixture inventory: every fixture directory is blessed', () => {
  // FAILS BY DESIGN between BUILD and the quality gate. A fixture's inputs land in the build; its
  // goldens are written at the gate, fixture by fixture, with the diff reviewed — that is deliberately
  // the moment the sprint's sidecar invariant is most at risk, so it gets its own reviewed pass. This
  // row is what stops a fixture being forgotten there.
  const unblessed = dirs().filter((n) => !existsSync(join(FIX, n, 'golden.txt')));
  assert.deepEqual(unblessed, [], `unblessed fixtures — bless them at the quality gate: ${unblessed.join(', ')}`);
});

test('30 — every fixture is well-formed: parseable inputs, frozen clock, a matching seed id', () => {
  for (const f of dirs()) {                       // ALL dirs, blessed or not — inputs must be valid now
    const sp = join(FIX, f, 'stdin.json');
    const mp = join(FIX, f, 'meta.json');
    assert.ok(existsSync(sp), `${f}: stdin.json missing`);
    const d = JSON.parse(readFileSync(sp, 'utf8'));
    assert.ok(existsSync(mp), `${f}: meta.json missing`);
    const meta = JSON.parse(readFileSync(mp, 'utf8'));
    assert.equal(typeof meta.nowEpoch, 'number', `${f}: meta.json must pin a frozen clock`);
    assert.ok(meta.nowEpoch > 1_600_000_000, `${f}: nowEpoch looks wrong: ${meta.nowEpoch}`);
    // A seeded stats file is keyed by session id; a mismatch silently disables the incremental path.
    const seed = join(FIX, f, 'seed', 'statusline-stats');
    if (existsSync(seed)) {
      const stats = readdirSync(seed).filter((n) => n.endsWith('.json') && !n.endsWith('.agents.json'));
      for (const s of stats) {
        assert.equal(s, `${d.session_id}.json`,
          `${f}: seed stats file ${s} does not match session_id ${d.session_id} — the seed would be ignored`);
      }
    }
  }
});

test('31 — the quota fixtures\' resets_at match their stated elapsed fractions exactly', () => {
  // The three quota fixtures exist to pin two constants from both sides, so their elapsed fractions
  // are the fixture. Recomputed here from the frozen clock, because a wrong resets_at would make the
  // edge tests assert against the wrong regime and still look green.
  const EXPECT = {
    'quota-calm-both': { five_hour: 0.30, seven_day: 0.30 },
    'quota-verdict-edge': { five_hour: 0.60, seven_day: 0.60 },
    'quota-elapsed-edge': { five_hour: 0.09, seven_day: 0.11 },
  };
  for (const [f, wins] of Object.entries(EXPECT)) {
    if (!existsSync(join(FIX, f))) continue;
    const d = stdinOf(f), now = metaOf(f).nowEpoch;
    for (const [win, frac] of Object.entries(wins)) {
      const rl = d.rate_limits[win];
      assert.ok(rl, `${f}: ${win} must be present`);
      const elapsed = (W[win] - (Number(rl.resets_at) - now)) / W[win];
      assert.ok(Math.abs(elapsed - frac) < 1e-6,
        `${f}/${win}: elapsed ${elapsed} != the intended ${frac} (resets_at ${rl.resets_at}, now ${now})`);
    }
  }
});
