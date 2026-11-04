// quota-merge-pure — the kit-portable coverage of home/quota-file.mjs: the merge ordering rule
// (MergeQuotaWindow) and the writer around it (WriteQuotaFile). Imports the module, calls it, and
// touches nothing outside a throwaway temp directory. No child process, no PowerShell, no docs, no
// path into the private repo — so it runs identically in the public kit and here.
//
// WHY THIS FILE EXISTS BESIDE quota-merge.test.mjs. The public kit ships home/quota-file.mjs (the
// status line imports it at module scope) but until this file none of the tests that cover it were in
// the exported list, so a regression in the ordering rule would reach every kit user with public CI
// green. quota-merge.test.mjs cannot be the fix: it renders the real status line in a child process
// and drives the fleet tray through pwsh, and that tray is private. It stays private, unchanged; the
// rows here duplicate its pure coverage on purpose rather than moving anything out of it.
//
// ── Acceptance examples (observable outcomes; the mechanics rows below refine within them) ──────
//
// AE-1 — The later reset time wins regardless of who wrote first
//   Two status lines in one config home report the same 5h window; one saw it reset an hour later
//   than the other. Whichever writes second, the file holds the reading with the later reset moment.
//
// AE-2 — The same window, the higher consumption wins
//   Two readings name the same reset moment; one says 40% used, the other 41%. The file holds 41%,
//   whichever arrived last.
//
// AE-3 — An unchanged reading re-confirmed later dates the row by the re-confirmation
//   A session re-reports the same percentage of the same window ten minutes after the stored one.
//   The file's reading is now dated ten minutes later, and every field comes from the re-report.
//
// AE-4 — A corrupt quota file is treated as empty and rewritten cleanly
//   The quota file holds truncated JSON, or a shape from an older build. The next render neither
//   fails nor keeps the old content: the file is a valid current-schema file with that render's reading.
//
// AE-5 — An identical reading does not touch the file
//   A render reproduces the stored file byte for byte. The file's modification time does not move.
//
// AE-6 — A narrow payload never wipes the other window
//   The stored file holds both windows; a render carries only the 5h one. The 7d reading in the
//   file is byte-identical afterwards, while the 5h one advanced.
//   One exception: a write flagged `fiveHourAbsent` (an API response that carried no 5-hour window)
//   whose 7-day observation came more than the grace after the stored 5-hour window ended removes
//   that ended 5-hour window. A running 5-hour window is never removed.
//
// ── Row map ─────────────────────────────────────────────────────────────────────────────────────
//   P1  schema constants                        P7  argument-order symmetry (AE-1, AE-2)
//   P2  rule 1: any reading beats none          P8  writer: missing file → created, byte-exact (AE-4)
//   P3  rule 2: later resetsAt (AE-1)           P9  writer: unusable/foreign-schema file replaced (AE-4)
//   P4  rule 3: higher usedPercentage (AE-2)    P10 writer: identical bytes → no rewrite (AE-5)
//   P5  rule 4: later reportedAt, whole (AE-3)  P11 writer: per-key independence, no-window no-write (AE-6)
//   P6  non-numeric fields count as absent      P12 writer: never throws
//   P13  rule 3: a higher figure never carries the row's date backwards (clamp)
//   P13b rule 3: higher AND newer → incoming by reference, its own stamp (copy only when clamping)
//   P13c rule 3: stored stamp missing/non-numeric → incoming by reference, no clamp, no throw
//   P14  writer: returns one verdict per incoming window ('written' | 'kept' | 'dropped'); {} when nothing decided
//   P15  writer: the drop rule — an ended 5h window leaves the file only on flagged evidence (AE-6's exception)
//   P16  pure tables: FiveHourGone (the drop predicate) and QuotaAbsence (the status line's absent label); arities
//   P17  ReadQuotaFile: the parsed schema-2 object or null, never a throw

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MergeQuotaWindow, WriteQuotaFile, QUOTA_SCHEMA, QUOTA_FILE_NAME,
  FiveHourGone, QuotaAbsence, ReadQuotaFile, FIVE_HOUR_DROP_GRACE_SEC,
} from '../home/quota-file.mjs';

const NOW = 1788051200;
const OPEN = NOW + 3600;

// A window as the file holds it and as a render hands it in — the same shape on both sides, because
// `reportedAt` travels inside the reading. The three ordering keys plus a few drawn ones, so a row
// can tell "the incoming object won whole" from "only its stamp was grafted on".
function win({ used = 47.2, resets = OPEN, reported = NOW - 600, gauge = 'g' } = {}) {
  return { usedPercentage: used, resetsAt: resets, reportedAt: reported, gauge, rung: 0 };
}

// ── P1 ──────────────────────────────────────────────────────────────────────────────────────────

test('P1 — the schema constants are what the file\'s reader requires', () => {
  // The reader accepts exactly schema 2 and draws nothing for any other value. A build that bumps
  // this number must do so on purpose, with the reader — so the constant is pinned, not read back.
  assert.equal(QUOTA_SCHEMA, 2, 'QUOTA_SCHEMA is 2');
  assert.equal(QUOTA_FILE_NAME, 'statusline-quota.json', 'the file name is what the reader opens');
  assert.equal(MergeQuotaWindow.length, 2,
    'MergeQuotaWindow(stored, incoming) takes two parameters and no clock — a third is where a stamp would ride in');
});

// ── P2: rule 1 — any reading beats none ─────────────────────────────────────────────────────────

test('P2 — rule 1: with no usable stored reading the incoming one wins, whatever it is', () => {
  const inc = win({ used: 40 });
  for (const stored of [null, undefined, 'nonsense', 42, true]) {
    assert.ok(Object.is(MergeQuotaWindow(stored, inc), inc),
      `stored=${String(stored)}: a non-object stored is no stored reading — incoming wins by reference`);
  }
  // A stored OBJECT without a numeric resetsAt is not a reading either: it cannot be placed in time.
  for (const resetsAt of [undefined, null, 'soon', NaN, Infinity, -Infinity, '1788054800']) {
    const stored = { ...win({ used: 99 }), resetsAt };
    assert.ok(Object.is(MergeQuotaWindow(stored, inc), inc),
      `stored.resetsAt=${String(resetsAt)}: an undated stored object is no stored reading — incoming wins`);
  }
  // Rule 1 does not inspect the incoming object at all: with nothing stored it is returned as-is,
  // even undated. (The writer never hands the merge a falsy incoming — P11 pins that on its side.)
  const undated = { usedPercentage: 5 };
  assert.ok(Object.is(MergeQuotaWindow(null, undated), undated), 'rule 1 returns the incoming object without looking at it');

  // The mirror: a DATED stored reading against an undated incoming keeps the stored one. A reading
  // that cannot be placed in time cannot displace one that can.
  const s = win({ used: 10 });
  for (const resetsAt of [undefined, null, 'soon', NaN, '9999999999']) {
    assert.ok(Object.is(MergeQuotaWindow(s, { ...win({ used: 99 }), resetsAt }), s),
      `incoming.resetsAt=${String(resetsAt)}: an undated incoming loses to a dated stored reading`);
  }
  // A primitive incoming has no resetsAt either, so it loses the same way rather than throwing.
  for (const inc2 of ['x', 7, true]) {
    assert.ok(Object.is(MergeQuotaWindow(s, inc2), s), `incoming=${String(inc2)}: a primitive incoming loses to a dated stored`);
  }
});

// ── P3: rule 2 — the later reset moment is the later window ─────────────────────────────────────

test('P3 — rule 2: a different resetsAt decides on its own; the later window wins whatever the consumption', () => {
  const s = win({ resets: NOW + 1000, used: 99, reported: NOW + 500 });
  const later = win({ resets: NOW + 20000, used: 1, reported: NOW - 90000 });
  assert.ok(Object.is(MergeQuotaWindow(s, later), later),
    'a later resetsAt wins even at lower consumption and an older report stamp — the earlier window has ended');
  const earlier = win({ resets: NOW + 500, used: 100, reported: NOW + 999 });
  assert.ok(Object.is(MergeQuotaWindow(s, earlier), s),
    'an earlier resetsAt loses even at 100% and a fresher stamp — it describes a window that has ended');
  // Consumption and stamp are never consulted when the reset moments differ: strip them and the
  // outcome is unchanged.
  assert.equal(MergeQuotaWindow({ resetsAt: NOW + 1000 }, { resetsAt: NOW + 1001 }).resetsAt, NOW + 1001,
    'rule 2 needs nothing but resetsAt on either side');
  assert.equal(MergeQuotaWindow({ resetsAt: NOW + 1001 }, { resetsAt: NOW + 1000 }).resetsAt, NOW + 1001,
    'and in the other direction too');
});

// ── P4: rule 3 — same window, the higher consumption wins ───────────────────────────────────────

test('P4 — rule 3: at equal resetsAt the higher usedPercentage wins; a lower one is an older reading', () => {
  const s = win({ used: 40, reported: NOW });
  const higher = win({ used: 41, reported: NOW + 60 });
  assert.ok(Object.is(MergeQuotaWindow(s, higher), higher), 'higher usedPercentage with a newer stamp wins by reference');
  // An OLDER stamp does not stop a higher figure winning — its stamp is clamped (P13 pins the clamp).
  assert.equal(MergeQuotaWindow(s, win({ used: 41, reported: NOW - 7200 })).usedPercentage, 41,
    'higher usedPercentage wins even with an older stamp');
  const lower = win({ used: 39, reported: NOW + 7200 });
  assert.ok(Object.is(MergeQuotaWindow(s, lower), s), 'a LOWER usedPercentage loses even with a fresher stamp — the naive >= gets this wrong');
  // A fractional step counts: 47.2 beats 47.19.
  assert.equal(MergeQuotaWindow(win({ used: 47.19 }), win({ used: 47.2 })).usedPercentage, 47.2, 'a fractional rise is a rise');
  // usedPercentage missing on one side: the side that has one wins (same direction as rule 2 for a
  // missing field).
  const noPct = { resetsAt: OPEN, reportedAt: NOW + 99999 };
  assert.ok(Object.is(MergeQuotaWindow(noPct, s), s), 'stored without a numeric usedPercentage loses to one that has it');
  assert.ok(Object.is(MergeQuotaWindow(s, noPct), s), 'incoming without a numeric usedPercentage loses to one that has it');
});

// ── P5: rule 4 — total tie on window and consumption, the later REPORT wins whole ───────────────

test('P5 — rule 4: equal resetsAt and usedPercentage → the later reportedAt wins, and the whole object comes with it', () => {
  const stored = win({ reported: NOW - 600, gauge: 'stale-bar' });
  const fresher = { ...win({ reported: NOW, gauge: 'fresh-bar' }), rung: 2, verdict: 'slow down' };
  const out = MergeQuotaWindow(stored, fresher);
  assert.ok(Object.is(out, fresher), 'the INCOMING OBJECT is returned by reference — not the stored one with a new stamp');
  assert.deepEqual(out, fresher, 'every field of it: gauge, rung, verdict included');
  assert.equal(out.gauge, 'fresh-bar', 'the elapsed bar is the fresh one — a stamp-only graft would keep the stale bar under a fresh date');

  // An earlier report loses: the date never moves backwards.
  const older = win({ reported: NOW - 7200 });
  assert.ok(Object.is(MergeQuotaWindow(stored, older), stored), 'an earlier incoming stamp loses');

  // Equal on all three → the STORED object itself, so the writer's byte compare sees no change.
  const same = win({ reported: NOW - 600, gauge: 'other-bar' });
  assert.ok(Object.is(MergeQuotaWindow(stored, same), stored),
    'a total tie returns the stored object by reference — even when a drawn field differs, the stamp decides and it is equal');

  // Rule 4 is ordered BELOW rule 3: a fresher report of a lower figure still loses.
  const lowerFresher = win({ used: 12, reported: NOW });
  assert.ok(Object.is(MergeQuotaWindow(stored, lowerFresher), stored), 'a later stamp cannot rescue a lower consumption figure');

  // reportedAt missing on one side at a tie: the side that has a stamp wins.
  const noStamp = { usedPercentage: 47.2, resetsAt: OPEN };
  assert.ok(Object.is(MergeQuotaWindow(noStamp, stored), stored), 'stored with no numeric reportedAt loses the tie to one with a stamp');
  assert.ok(Object.is(MergeQuotaWindow(stored, noStamp), stored), 'incoming with no numeric reportedAt loses the tie to one with a stamp');
  // Neither has a stamp: the stored side's missing field is checked first, so incoming is returned —
  // the same "a missing field on stored yields to incoming" direction rules 2 and 3 take. Not a shape
  // the writer produces (QuotaWindow always stamps); pinned so a reordering of the checks is visible.
  const noStamp2 = { usedPercentage: 47.2, resetsAt: OPEN, gauge: 'z' };
  assert.ok(Object.is(MergeQuotaWindow(noStamp, noStamp2), noStamp2), 'no stamp on either side → incoming, by the stored-side check running first');
});

// ── P6: what counts as a number ─────────────────────────────────────────────────────────────────

test('P6 — a non-finite or non-number field counts as ABSENT, never coerced: NaN, Infinity, numeric strings', () => {
  // The ordering compares numbers only. A numeric STRING that would compare "later" if coerced must
  // not: '9999999999' > 1788054800 is true after Number(), and the merge must not do that.
  const s = win({ used: 40, reported: NOW });
  const stringReset = { ...win({ used: 99 }), resetsAt: '9999999999' };
  assert.ok(Object.is(MergeQuotaWindow(s, stringReset), s), 'a string resetsAt is absent, not a later window');

  const stringPct = win({ used: '99', reported: NOW + 100 });
  assert.ok(Object.is(MergeQuotaWindow(s, stringPct), s), 'a string usedPercentage is absent — the stored numeric one wins the tie-break');
  const nanPct = win({ used: NaN, reported: NOW + 100 });
  assert.ok(Object.is(MergeQuotaWindow(s, nanPct), s), 'a NaN usedPercentage is absent');
  const infPct = win({ used: Infinity, reported: NOW + 100 });
  assert.ok(Object.is(MergeQuotaWindow(s, infPct), s), 'an Infinity usedPercentage is absent — Number.isFinite, not typeof');

  const stringStamp = win({ used: 40, reported: '9999999999' });
  assert.ok(Object.is(MergeQuotaWindow(s, stringStamp), s), 'a string reportedAt is absent — the stored stamped reading wins the tie');
  const nanStamp = win({ used: 40, reported: NaN });
  assert.ok(Object.is(MergeQuotaWindow(s, nanStamp), s), 'a NaN reportedAt is absent');

  // The same on the stored side: an absent-by-shape field on stored loses to a real one on incoming.
  const storedNanPct = win({ used: NaN, reported: NOW + 100 });
  assert.ok(Object.is(MergeQuotaWindow(storedNanPct, s), s), 'stored NaN usedPercentage loses to a numeric incoming');
  const storedStrStamp = win({ used: 40, reported: '2000000000' });
  assert.ok(Object.is(MergeQuotaWindow(storedStrStamp, s), s), 'stored string reportedAt loses the tie to a numeric incoming stamp');

  // Zero and negatives are real numbers and compare as such.
  assert.equal(MergeQuotaWindow(win({ used: 0 }), win({ used: 0.1 })).usedPercentage, 0.1, '0 is a number, 0.1 beats it');
  assert.equal(MergeQuotaWindow(win({ used: 0.1 }), win({ used: 0 })).usedPercentage, 0.1, 'and 0 does not beat 0.1');
});

// ── P7: the winner does not depend on argument order ────────────────────────────────────────────

test('P7 — for two distinct readings the same object wins from either argument position', () => {
  const pairs = [
    ['rule 2', win({ resets: NOW + 1000, used: 99 }), win({ resets: NOW + 20000, used: 1 })],
    // Higher AND newer, so no clamp fires and the winner is an input by reference (P13 covers the clamp).
    ['rule 3', win({ used: 40, reported: NOW }), win({ used: 41, reported: NOW + 7200 })],
    ['rule 4', win({ reported: NOW - 600, gauge: 'a' }), win({ reported: NOW, gauge: 'b' })],
    ['rule 1 vs undated', { ...win({ used: 99 }), resetsAt: null }, win({ used: 5 })],
    ['rule 3 vs no pct', { resetsAt: OPEN, reportedAt: NOW }, win({ used: 40 })],
  ];
  for (const [label, a, b] of pairs) {
    const ab = MergeQuotaWindow(a, b);
    const ba = MergeQuotaWindow(b, a);
    assert.ok(Object.is(ab, ba), `${label}: the same object wins whichever side it arrives on`);
    assert.ok(Object.is(ab, a) || Object.is(ab, b), `${label}: and the winner is one of the two inputs, not a copy`);
  }
  // Total tie is the one place order shows: stored wins by reference, and that is the point (no write).
  const x = win(); const y = win();
  assert.ok(Object.is(MergeQuotaWindow(x, y), x) && Object.is(MergeQuotaWindow(y, x), y),
    'a total tie returns whichever object was STORED — the merge prefers the bytes already on disk');
});

// ── P13: rule 3 never moves the row's date backwards (backlog-clear spec §5.3, A-B3-1) ──────────

test('P13 — rule 3: a reading that wins on a higher percentage can never carry the row\'s date backwards', () => {
  // A-B3-1: 60% stored as of T, then 62% arrives for the same window stamped two hours EARLIER.
  // Within one window consumption only rises, so 62% cannot have been observed before 60% was: the
  // stored stamp is a floor on the incoming observation's moment.
  const T = NOW;
  const stored = win({ used: 60, reported: T, gauge: 'old-bar' });
  const incoming = win({ used: 62, reported: T - 7200, gauge: 'new-bar' });
  const storedCopy = { ...stored }; const incomingCopy = { ...incoming };
  const out = MergeQuotaWindow(stored, incoming);
  assert.equal(out.usedPercentage, 62, 'the higher figure wins');
  assert.ok(out.reportedAt >= T, `the result is dated at or after the stored stamp T=${T}, got ${out.reportedAt} — the row's "as of" never moves backwards`);
  assert.equal(out.gauge, 'new-bar', 'every other field comes from the incoming reading (it still wins entire, stamp aside)');
  assert.equal(out.resetsAt, OPEN, 'same window');
  assert.deepEqual(stored, storedCopy, 'the stored argument is not mutated');
  assert.deepEqual(incoming, incomingCopy, 'the incoming argument is not mutated — the clamp builds a copy');
  // Property 1 (§5.2) at the neighbouring branch: when the stored reading wins it is still returned by reference.
  assert.ok(Object.is(MergeQuotaWindow(incoming, stored), incoming), 'a lower figure still loses, stored returned by reference');
});

test('P13b — rule 3: a higher AND newer reading is returned by reference with its own stamp (the copy happens only when the clamp fires)', () => {
  // A-B3-2: 60% as of 14:00, then 62% stamped 14:30 → 62% as of 14:30.
  const stored = win({ used: 60, reported: NOW });
  const incoming = win({ used: 62, reported: NOW + 1800 });
  const out = MergeQuotaWindow(stored, incoming);
  assert.ok(Object.is(out, incoming), 'no clamp needed → the incoming object itself, not a copy');
  assert.equal(out.reportedAt, NOW + 1800, 'dated by its own, newer stamp');
  // Equal stamps are not "backwards" either: no copy.
  const same = win({ used: 62, reported: NOW });
  assert.ok(Object.is(MergeQuotaWindow(stored, same), same), 'an equal stamp needs no clamp — returned by reference');
});

test('P13c — rule 3: incoming wins but a stamp is missing or non-numeric → incoming by reference, no clamp, no throw', () => {
  const incoming = win({ used: 62, reported: NOW - 7200 });
  for (const reportedAt of [undefined, null, 'soon', NaN, Infinity, '1788051200']) {
    const stored = { ...win({ used: 60 }), reportedAt };
    let out;
    assert.doesNotThrow(() => { out = MergeQuotaWindow(stored, incoming); }, `stored.reportedAt=${String(reportedAt)}: no throw`);
    assert.ok(Object.is(out, incoming), `stored.reportedAt=${String(reportedAt)}: nothing to clamp against — incoming by reference`);
  }
  // And the mirror: an incoming with no numeric stamp is not given one.
  const noStamp = { ...win({ used: 62 }), reportedAt: 'x' };
  assert.ok(Object.is(MergeQuotaWindow(win({ used: 60, reported: NOW }), noStamp), noStamp),
    'incoming.reportedAt non-numeric: incoming by reference, no stamp invented');
});

// ── the writer ──────────────────────────────────────────────────────────────────────────────────

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'qmp-'));
  return { dir, path: join(dir, QUOTA_FILE_NAME), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const readText = (h) => readFileSync(h.path, 'utf8');

// The exact bytes the writer produces for one 5h reading: two-space JSON, `schema` first, windows
// in the fixed order fiveHour then sevenDay, keys in the order the window object carries them, no
// trailing newline. Pinned as a literal so a formatting change is a visible diff, not a surprise
// to the reader that parses this file.
const FIVE = { usedPercentage: 47.2, resetsAt: OPEN, reportedAt: NOW };
const SEVEN = { usedPercentage: 88, resetsAt: NOW + 172800, reportedAt: NOW };
const FIVE_ONLY_BYTES = [
  '{',
  '  "schema": 2,',
  '  "fiveHour": {',
  '    "usedPercentage": 47.2,',
  `    "resetsAt": ${OPEN},`,
  `    "reportedAt": ${NOW}`,
  '  }',
  '}',
].join('\n');
const BOTH_BYTES = [
  '{',
  '  "schema": 2,',
  '  "fiveHour": {',
  '    "usedPercentage": 47.2,',
  `    "resetsAt": ${OPEN},`,
  `    "reportedAt": ${NOW}`,
  '  },',
  '  "sevenDay": {',
  '    "usedPercentage": 88,',
  `    "resetsAt": ${NOW + 172800},`,
  `    "reportedAt": ${NOW}`,
  '  }',
  '}',
].join('\n');

test('P8 — writer: a missing file is created with schema 2 and exactly these bytes', () => {
  const h = tempHome();
  try {
    assert.ok(!existsSync(h.path), 'vacuity guard: the temp home starts empty');
    WriteQuotaFile(h.dir, { fiveHour: FIVE });
    assert.equal(readText(h), FIVE_ONLY_BYTES, 'the file holds the schema, the one window, two-space indented, no trailing newline');
    assert.equal(JSON.parse(readText(h)).schema, QUOTA_SCHEMA, 'and parses back with the current schema');

    // Both windows, from empty: fiveHour before sevenDay regardless of the order the payload named them.
    const h2 = tempHome();
    try {
      WriteQuotaFile(h2.dir, { sevenDay: SEVEN, fiveHour: FIVE });
      assert.equal(readText(h2), BOTH_BYTES, 'window order in the file is fixed (5h then 7d), not the payload\'s key order');
    } finally { h2.cleanup(); }

    // No temp file is left behind by a successful atomic write.
    assert.ok(!existsSync(h.path + '.tmp.' + process.pid), 'the atomic write\'s temp file was renamed away');
  } finally { h.cleanup(); }
});

test('P9 — writer: an unparseable, non-object, or foreign-schema file reads as empty and is replaced', () => {
  const junk = [
    ['not json', 'not json at all'],
    ['truncated', '{"schema":2,"fiveHour":{"reportedAt":178'],
    ['empty', ''],
    ['array', '[]'],
    ['array with schema-shaped content', '[{"schema":2}]'],
    ['schema 1', JSON.stringify({ schema: 1, fiveHour: { usedPercentage: 99, resetsAt: NOW + 99999, observedAt: NOW } }, null, 2)],
    ['schema 3', JSON.stringify({ schema: 3, fiveHour: { usedPercentage: 99, resetsAt: NOW + 99999, reportedAt: NOW } }, null, 2)],
    ['schema as string', JSON.stringify({ schema: '2', fiveHour: { usedPercentage: 99, resetsAt: NOW + 99999, reportedAt: NOW } }, null, 2)],
    ['no schema', JSON.stringify({ fiveHour: { usedPercentage: 99, resetsAt: NOW + 99999, reportedAt: NOW } }, null, 2)],
  ];
  for (const [label, text] of junk) {
    const h = tempHome();
    try {
      writeFileSync(h.path, text, 'utf8');
      assert.doesNotThrow(() => WriteQuotaFile(h.dir, { fiveHour: FIVE }), `${label}: the writer does not throw`);
      // The stored reading in the schema-1/3 cases names a LATER window than FIVE — and still loses,
      // because a foreign-schema file is discarded WHOLE before any merge; its windows never reach
      // rule 2.
      assert.equal(readText(h), FIVE_ONLY_BYTES, `${label}: replaced by a clean schema-2 file holding this render's reading, nothing carried over`);
    } finally { h.cleanup(); }
  }

  // A schema-2 file whose window VALUE is not an object: that key reads as no stored reading; the
  // other window, if well-formed, survives untouched.
  const h = tempHome();
  try {
    writeFileSync(h.path, JSON.stringify({ schema: 2, fiveHour: 5, sevenDay: SEVEN }, null, 2), 'utf8');
    WriteQuotaFile(h.dir, { fiveHour: FIVE });
    assert.equal(readText(h), BOTH_BYTES, 'a non-object window value is no stored reading for that key; the good sevenDay stays');
    // And a non-object window key with NO incoming for it is dropped rather than carried forward.
    writeFileSync(h.path, JSON.stringify({ schema: 2, fiveHour: FIVE, sevenDay: 'junk' }, null, 2), 'utf8');
    WriteQuotaFile(h.dir, { fiveHour: { ...FIVE, usedPercentage: 47.3 } });
    assert.equal(JSON.parse(readText(h)).sevenDay, undefined, 'a junk window value with nothing incoming is not carried forward');
  } finally { h.cleanup(); }
});

test('P10 — writer: an identical merge writes nothing — the file\'s mtime does not move', async () => {
  const h = tempHome();
  try {
    WriteQuotaFile(h.dir, { fiveHour: FIVE, sevenDay: SEVEN });
    const before = statSync(h.path);
    await new Promise((r) => setTimeout(r, 25));
    // The same readings again — total tie on every key — so the merged text equals the text read.
    WriteQuotaFile(h.dir, { fiveHour: { ...FIVE }, sevenDay: { ...SEVEN } });
    assert.equal(readText(h), BOTH_BYTES, 'the bytes are unchanged');
    assert.equal(statSync(h.path).mtimeMs, before.mtimeMs, 'and the file was not rewritten — no rename, no mtime movement');
    assert.ok(!existsSync(h.path + '.tmp.' + process.pid), 'no temp file was created either');

    // Vacuity guard: a reading that differs DOES rewrite, so the stillness above is the byte compare
    // and not a writer that never writes twice.
    await new Promise((r) => setTimeout(r, 25));
    WriteQuotaFile(h.dir, { fiveHour: { ...FIVE, reportedAt: NOW + 600 } });
    assert.notEqual(statSync(h.path).mtimeMs, before.mtimeMs, 'a fresher stamp (rule 4) does rewrite the file');
    assert.equal(JSON.parse(readText(h)).fiveHour.reportedAt, NOW + 600, 'and the new stamp is what it holds');
  } finally { h.cleanup(); }
});

test('P11 — writer: each window key merges on its own; a payload with no usable window writes nothing', () => {
  const h = tempHome();
  try {
    WriteQuotaFile(h.dir, { fiveHour: FIVE, sevenDay: SEVEN });
    const sevenBefore = JSON.stringify(JSON.parse(readText(h)).sevenDay);

    // Only 5h in the payload: 7d stays byte-identical, 5h advances (rule 3).
    WriteQuotaFile(h.dir, { fiveHour: { ...FIVE, usedPercentage: 60, reportedAt: NOW + 300 } });
    const after = JSON.parse(readText(h));
    assert.equal(JSON.stringify(after.sevenDay), sevenBefore, 'the window the payload did not carry is untouched, stamp included');
    assert.equal(after.fiveHour.usedPercentage, 60, 'while the carried window advanced');

    // Each key merges independently: a payload can WIN on one key and LOSE on the other in one call.
    WriteQuotaFile(h.dir, {
      fiveHour: { ...FIVE, usedPercentage: 10, reportedAt: NOW + 900 },       // lower → loses rule 3
      sevenDay: { ...SEVEN, resetsAt: NOW + 172800 + 3600, usedPercentage: 1 }, // later window → wins rule 2
    });
    const mixed = JSON.parse(readText(h));
    assert.equal(mixed.fiveHour.usedPercentage, 60, '5h: the lower incoming lost, the stored 60 stands');
    assert.equal(mixed.sevenDay.resetsAt, NOW + 172800 + 3600, '7d: the later window won');
    assert.equal(mixed.sevenDay.usedPercentage, 1, '7d: and starts from its own figure');

    // No usable window → no write at all, file byte-identical, whatever shape the payload takes.
    const text = readText(h);
    const mtime = statSync(h.path).mtimeMs;
    for (const windows of [undefined, null, {}, 'x', 7, [], { fiveHour: null, sevenDay: undefined }, { fiveHour: 0, sevenDay: '' }, { other: FIVE }]) {
      WriteQuotaFile(h.dir, windows);
      assert.equal(readText(h), text, `windows=${JSON.stringify(windows) ?? String(windows)}: the file is byte-identical`);
      assert.equal(statSync(h.path).mtimeMs, mtime, 'and was not rewritten');
    }
  } finally { h.cleanup(); }

  // The same with NO file present: a payload without a window does not create one.
  const h2 = tempHome();
  try {
    for (const windows of [undefined, {}, { fiveHour: null }]) {
      WriteQuotaFile(h2.dir, windows);
      assert.ok(!existsSync(h2.path), `windows=${String(windows && JSON.stringify(windows))}: knowing nothing creates no file`);
    }
  } finally { h2.cleanup(); }
});

test('P12 — writer: it never throws — a config home that is a file, a missing home, a non-string home', () => {
  const h = tempHome();
  try {
    // The "directory" is a regular file, so both the read (ENOTDIR) and the write fail.
    const asFile = join(h.dir, 'not-a-dir');
    writeFileSync(asFile, 'i am a file', 'utf8');
    assert.doesNotThrow(() => WriteQuotaFile(asFile, { fiveHour: FIVE }), 'a config home that is a file loses one write and nothing else');
    assert.equal(readFileSync(asFile, 'utf8'), 'i am a file', 'and the file standing in its way is untouched');

    // A config home that does not exist: atomicWriteFile cannot create the directory, so the write
    // fails silently. (The status line creates its home elsewhere before rendering; this writer does
    // not widen its own blast radius by creating directories.)
    const missing = join(h.dir, 'no', 'such', 'home');
    assert.doesNotThrow(() => WriteQuotaFile(missing, { fiveHour: FIVE }), 'a missing config home does not throw');
    assert.ok(!existsSync(missing), 'and no directory was created for it');

    // A non-string home makes path.join throw a TypeError — inside the writer's guard.
    for (const bad of [undefined, null, 42, {}]) {
      assert.doesNotThrow(() => WriteQuotaFile(bad, { fiveHour: FIVE }), `configHome=${String(bad)}: swallowed`);
    }

    // No orphaned temp file from any of the failures above.
    assert.deepEqual(
      [asFile + '.tmp.' + process.pid, join(missing, QUOTA_FILE_NAME + '.tmp.' + process.pid)].filter(existsSync), [],
      'the failed writes left no temp file behind');
  } finally { h.cleanup(); }
});

// ── P14: the writer's return value — one verdict per incoming window (backlog-clear spec §6.1) ───

test('P14 — writer: returns one verdict per window the payload carried, as the merge decided; {} when nothing was decided', () => {
  const h = tempHome();
  try {
    // From empty: every carried window is written; a window the payload did not carry has no entry.
    assert.deepEqual(WriteQuotaFile(h.dir, { fiveHour: FIVE }), { fiveHour: 'written' },
      'one entry per INCOMING window only — no sevenDay entry for a window the payload did not carry');
    assert.deepEqual(WriteQuotaFile(h.dir, { fiveHour: FIVE, sevenDay: SEVEN }), { fiveHour: 'kept', sevenDay: 'written' },
      '5h re-sent identically is a total tie (stored wins → kept); 7d is new (written)');

    // Nothing new: both kept, and the file is not rewritten (the verdict does not depend on a write).
    const mtime = statSync(h.path).mtimeMs;
    assert.deepEqual(WriteQuotaFile(h.dir, { fiveHour: { ...FIVE }, sevenDay: { ...SEVEN } }), { fiveHour: 'kept', sevenDay: 'kept' },
      'an unchanged payload reports both windows kept');
    assert.equal(statSync(h.path).mtimeMs, mtime, 'and wrote nothing');

    // Split outcome (A-B4-1): 5h wins on a newer stamp, 7d loses on a lower figure — and 7d's stored
    // reading, date included, is untouched.
    const seven0 = JSON.stringify(JSON.parse(readText(h)).sevenDay);
    assert.deepEqual(
      WriteQuotaFile(h.dir, { fiveHour: { ...FIVE, reportedAt: NOW + 600 }, sevenDay: { ...SEVEN, usedPercentage: 87, reportedAt: NOW + 600 } }),
      { fiveHour: 'written', sevenDay: 'kept' }, 'each window gets its own verdict');
    assert.equal(JSON.stringify(JSON.parse(readText(h)).sevenDay), seven0, 'the kept 7d reading is byte-identical, reportedAt included');

    // A clamped win (P13) is still `written`: the reading survived, with its date floored.
    assert.deepEqual(WriteQuotaFile(h.dir, { sevenDay: { ...SEVEN, usedPercentage: 90, reportedAt: NOW - 7200 } }), { sevenDay: 'written' },
      'a higher figure with an older stamp wins (clamped) → written');
    assert.equal(JSON.parse(readText(h)).sevenDay.reportedAt, NOW, 'and the file holds the clamped stamp, not the older one');

    // No usable window → {} (and, per P11, no write).
    for (const windows of [undefined, null, {}, 'x', 7, [], { fiveHour: null, sevenDay: undefined }, { other: FIVE }]) {
      assert.deepEqual(WriteQuotaFile(h.dir, windows), {},
        `windows=${JSON.stringify(windows) ?? String(windows)}: a payload with no usable window decides nothing → {}`);
    }
  } finally { h.cleanup(); }

  // The catch path → {}, never a throw and never a verdict for a write that failed.
  const h2 = tempHome();
  try {
    const asFile = join(h2.dir, 'not-a-dir');
    writeFileSync(asFile, 'i am a file', 'utf8');
    let r;
    assert.doesNotThrow(() => { r = WriteQuotaFile(asFile, { fiveHour: FIVE }); }, 'an unwritable target does not throw');
    assert.deepEqual(r, {}, 'an unwritable target (config home is a file) returns {} from the catch — no `written` for bytes that never landed');
    for (const bad of [undefined, null, 42, {}]) {
      assert.deepEqual(WriteQuotaFile(bad, { fiveHour: FIVE }), {}, `configHome=${String(bad)}: the catch path returns {}`);
    }
  } finally { h2.cleanup(); }
});
// ── P15: the drop rule — an ended 5h window leaves only on flagged evidence (five-hour-display spec §3.1) ──
//
// The file holds a 5h window that ended at END. A write flagged `fiveHourAbsent` (the caller observed an
// API response with no 5-hour window) whose INCOMING 7d reading was observed more than
// FIVE_HOUR_DROP_GRACE_SEC after END removes that 5h window and reports `fiveHour: 'dropped'`. Nothing
// else removes a window: no flag, a stored stamp, a running window, the 7d window — all leave it.

const END = NOW - 2 * 86400;                 // the stored 5h window ended two days before NOW (the live Ultra shape)
const DEAD5 = { usedPercentage: 12, resetsAt: END, reportedAt: END - 600 };
const OLD7 = { usedPercentage: 50, resetsAt: NOW + 3 * 86400, reportedAt: END - 600 };   // observed BEFORE the 5h end
const seven = (reported, used = 54) => ({ usedPercentage: used, resetsAt: NOW + 3 * 86400, reportedAt: reported });
const fileText = (o) => JSON.stringify({ schema: 2, ...o }, null, 2);
const VERDICT_WORDS = new Set(['written', 'kept', 'dropped']);
const seenVerdicts = [];
const W = (dir, windows, opts) => {
  const r = (opts === undefined) ? WriteQuotaFile(dir, windows) : WriteQuotaFile(dir, windows, opts);
  for (const v of Object.values(r)) seenVerdicts.push(v);
  return r;
};

test('P15a — the drop fires at +901 s past the 5h end, not at +900 or +899; the verdict is `dropped`; the file keeps 7d only', () => {
  for (const [delta, drops] of [[901, true], [900, false], [899, false], [86400, true]]) {
    const h = tempHome();
    try {
      writeFileSync(h.path, fileText({ fiveHour: DEAD5, sevenDay: OLD7 }), 'utf8');
      const inc = seven(END + delta);
      const r = W(h.dir, { sevenDay: inc }, { fiveHourAbsent: true });
      const f = JSON.parse(readText(h));
      if (drops) {
        assert.equal(f.fiveHour, undefined, `+${delta}: the ended 5h window is gone`);
        assert.deepEqual(r, { fiveHour: 'dropped', sevenDay: 'written' }, `+${delta}: verdict fiveHour 'dropped', and 7d as its merge decided`);
        assert.equal(readText(h), fileText({ sevenDay: inc }), `+${delta}: the file is schema 2 + the 7d reading, exactly these bytes`);
      } else {
        assert.deepEqual(f.fiveHour, DEAD5, `+${delta}: within the grace the 5h window stays, byte for byte`);
        assert.equal(r.fiveHour, undefined, `+${delta}: no 5h verdict — nothing happened to it`);
      }
      assert.ok(f.sevenDay, `+${delta}: sevenDay is never dropped`);
    } finally { h.cleanup(); }
  }
});

test('P15b — the evidence is the INCOMING 7d stamp: a stored 7d observed before the 5h end does not stop it (AE-2), and the incoming reading need not win its merge', () => {
  // AE-2's mechanism: the stored 7d was observed before END (OLD7); the render's own observation drops.
  const h = tempHome();
  try {
    writeFileSync(h.path, fileText({ fiveHour: DEAD5, sevenDay: OLD7 }), 'utf8');
    W(h.dir, { sevenDay: seven(END + 5 * 3600) }, { fiveHourAbsent: true });
    assert.equal(JSON.parse(readText(h)).fiveHour, undefined, 'dropped on the incoming observation alone');

    // The incoming 7d LOSES its merge (lower figure, same window) — its stamp still dates the response.
    const hi7 = { ...seven(END - 600), usedPercentage: 90 };
    writeFileSync(h.path, fileText({ fiveHour: DEAD5, sevenDay: hi7 }), 'utf8');
    const r = W(h.dir, { sevenDay: seven(END + 5 * 3600, 54) }, { fiveHourAbsent: true });
    const f = JSON.parse(readText(h));
    assert.equal(f.fiveHour, undefined, 'the drop reads the incoming stamp whether or not the incoming reading won');
    assert.deepEqual(f.sevenDay, hi7, 'and the 7d merge is untouched by the drop: the stored, higher reading stands');
    assert.deepEqual(r, { fiveHour: 'dropped', sevenDay: 'kept' }, 'verdicts: 5h dropped, 7d kept');
  } finally { h.cleanup(); }
});

test('P15c — no flag, no drop: third argument omitted, or `fiveHourAbsent: false`, leaves the ended 5h window byte-identical', () => {
  for (const opts of [undefined, { fiveHourAbsent: false }, {}]) {
    const h = tempHome();
    try {
      writeFileSync(h.path, fileText({ fiveHour: DEAD5, sevenDay: OLD7 }), 'utf8');
      const r = W(h.dir, { sevenDay: seven(END + 901) }, opts);
      const f = JSON.parse(readText(h));
      assert.equal(JSON.stringify(f.fiveHour), JSON.stringify(DEAD5), `opts=${JSON.stringify(opts)}: fiveHour byte-identical`);
      assert.equal(r.fiveHour, undefined, `opts=${JSON.stringify(opts)}: no 5h verdict`);
    } finally { h.cleanup(); }
  }
});

test('P15d — the stored 7d stamp is never evidence: stored 7d past the 5h end + grace, flagged incoming 7d BEFORE the end → 5h stays', () => {
  // A stored 7d may carry a render-clock stamp from a render with no banked leg (spec §3.2). It must not
  // count. The incoming, flagged reading was observed before the 5h window ended, so nothing drops.
  const h = tempHome();
  try {
    const stored7 = seven(END + 3 * 3600, 60);           // stamped well past END + 900
    writeFileSync(h.path, fileText({ fiveHour: DEAD5, sevenDay: stored7 }), 'utf8');
    W(h.dir, { sevenDay: seven(END - 600, 61) }, { fiveHourAbsent: true });
    const f = JSON.parse(readText(h));
    assert.equal(JSON.stringify(f.fiveHour), JSON.stringify(DEAD5), 'fiveHour stays: only this write\'s incoming stamp can drop it');
  } finally { h.cleanup(); }
});

test('P15e — a running 5h window is never dropped: flagged 7d-only write against it, or a flagged write that carries one', () => {
  const RUN5 = { usedPercentage: 30, resetsAt: NOW + 600, reportedAt: NOW - 300 };
  const h = tempHome();
  try {
    // AE-6 holds for running windows: a flagged 7d-only write leaves a running 5h window byte-identical.
    writeFileSync(h.path, fileText({ fiveHour: RUN5, sevenDay: OLD7 }), 'utf8');
    const r = W(h.dir, { sevenDay: seven(NOW) }, { fiveHourAbsent: true });
    assert.equal(JSON.stringify(JSON.parse(readText(h)).fiveHour), JSON.stringify(RUN5), 'running 5h byte-identical');
    assert.equal(r.fiveHour, undefined, 'and no 5h verdict');

    // The same write carries a running 5h window (a newer one than the stored dead window): it is stored, not dropped.
    writeFileSync(h.path, fileText({ fiveHour: DEAD5, sevenDay: OLD7 }), 'utf8');
    const r2 = W(h.dir, { fiveHour: RUN5, sevenDay: seven(NOW) }, { fiveHourAbsent: true });
    assert.deepEqual(JSON.parse(readText(h)).fiveHour, RUN5, 'the carried running window is in the file');
    assert.equal(r2.fiveHour, 'written', 'its verdict is written, not dropped');
  } finally { h.cleanup(); }
});

test('P15f — after a drop, a second identical flagged write writes nothing and reports no 5h verdict', async () => {
  const h = tempHome();
  try {
    writeFileSync(h.path, fileText({ fiveHour: DEAD5, sevenDay: OLD7 }), 'utf8');
    const inc = seven(END + 86400);
    assert.equal(W(h.dir, { sevenDay: inc }, { fiveHourAbsent: true }).fiveHour, 'dropped', 'vacuity guard: the first write dropped');
    const before = statSync(h.path).mtimeMs;
    const bytes = readText(h);
    await new Promise((res) => setTimeout(res, 25));
    const r = W(h.dir, { sevenDay: { ...inc } }, { fiveHourAbsent: true });
    assert.deepEqual(r, { sevenDay: 'kept' }, 'the second write drops nothing — `dropped` appears only on the write that removed the window');
    assert.equal(readText(h), bytes, 'bytes unchanged');
    assert.equal(statSync(h.path).mtimeMs, before, 'mtime still: the byte-identical skip still applies after a drop');
  } finally { h.cleanup(); }
});

test('P15g — an incoming ENDED 5h window without the flag is stored under rule 1 and not dropped; the flag never drops sevenDay', () => {
  const h = tempHome();
  try {
    writeFileSync(h.path, fileText({ sevenDay: OLD7 }), 'utf8');
    for (const opts of [undefined, { fiveHourAbsent: false }]) {
      const r = W(h.dir, { fiveHour: DEAD5, sevenDay: seven(END + 86400) }, opts);
      assert.deepEqual(JSON.parse(readText(h)).fiveHour, DEAD5, `opts=${JSON.stringify(opts)}: the ended window wins rule 1 against an empty slot and stays`);
      assert.notEqual(r.fiveHour, 'dropped', 'no drop without the flag');
    }

    // The 7d window has no drop rule (spec §3.6): a flagged write never removes it, even an ended one.
    const DEAD7 = { usedPercentage: 99, resetsAt: END, reportedAt: END - 60 };
    writeFileSync(h.path, fileText({ fiveHour: { ...DEAD5, resetsAt: NOW + 600 }, sevenDay: DEAD7 }), 'utf8');
    W(h.dir, { fiveHour: { ...DEAD5, resetsAt: NOW + 600, reportedAt: NOW } }, { fiveHourAbsent: true });
    assert.deepEqual(JSON.parse(readText(h)).sevenDay, DEAD7, 'an ended sevenDay stays in the file');

    // A flagged write with no usable incoming window keeps the early return: nothing decided, nothing written.
    writeFileSync(h.path, fileText({ fiveHour: DEAD5, sevenDay: OLD7 }), 'utf8');
    const mt = statSync(h.path).mtimeMs;
    assert.deepEqual(W(h.dir, {}, { fiveHourAbsent: true }), {}, 'no window → {} even when flagged');
    assert.equal(statSync(h.path).mtimeMs, mt, 'and no write');
    assert.deepEqual(JSON.parse(readText(h)).fiveHour, DEAD5, 'the dead window is still there: no evidence arrived');
  } finally { h.cleanup(); }
});

test('P15h — the drop keeps the writer\'s guarantees: schema-2 refusal, never throws, {} from the catch', () => {
  const h = tempHome();
  try {
    // A foreign-schema file reads as {}: nothing stored, so nothing to drop — the incoming 7d is written.
    writeFileSync(h.path, JSON.stringify({ schema: 1, fiveHour: DEAD5 }), 'utf8');
    assert.deepEqual(W(h.dir, { sevenDay: seven(END + 86400) }, { fiveHourAbsent: true }), { sevenDay: 'written' },
      'a schema-1 file is discarded whole; no `dropped` for a window that was never read');
    for (const bad of [undefined, null, 42, {}]) {
      assert.deepEqual(WriteQuotaFile(bad, { sevenDay: seven(END + 86400) }, { fiveHourAbsent: true }), {}, `configHome=${String(bad)}: {} from the catch`);
    }
  } finally { h.cleanup(); }
});

test('P14b — the verdict vocabulary is exactly written | kept | dropped', () => {
  // Collected from every P15 write above (node:test runs a file's tests in order).
  assert.ok(seenVerdicts.length > 0, 'vacuity guard: the P15 rows recorded verdicts');
  for (const v of seenVerdicts) assert.ok(VERDICT_WORDS.has(v), `verdict ${JSON.stringify(v)} is one of written | kept | dropped`);
  for (const w of VERDICT_WORDS) assert.ok(seenVerdicts.includes(w), `and ${w} occurs at least once`);
});

// ── P16: the pure rules as tables ───────────────────────────────────────────────────────────────

test('P16a — FiveHourGone(fiveHour, sevenDay): true only past the 5h end + 900 s; false for anything it cannot place in time', () => {
  assert.equal(FIVE_HOUR_DROP_GRACE_SEC, 900, 'the grace is 900 s');
  const f = { usedPercentage: 1, resetsAt: END, reportedAt: END - 60 };
  const s = (rep) => ({ usedPercentage: 5, resetsAt: NOW + 86400, reportedAt: rep });
  assert.equal(FiveHourGone(f, s(END + 901)), true, '+901 → true');
  assert.equal(FiveHourGone(f, s(END + 900)), false, '+900 → false (strictly more than the grace)');
  assert.equal(FiveHourGone(f, s(END + 899)), false, '+899 → false');
  assert.equal(FiveHourGone(f, s(END - 1)), false, 'before the end → false');
  for (const [label, a, b] of [
    ['fiveHour undefined', undefined, s(END + 901)], ['fiveHour null', null, s(END + 901)],
    ['sevenDay undefined', f, undefined], ['sevenDay null', f, null],
    ['fiveHour primitive', 5, s(END + 901)], ['sevenDay primitive', f, 'x'],
  ]) assert.equal(FiveHourGone(a, b), false, `${label} → false`);
  for (const bad of [undefined, null, 'x', String(END), NaN, Infinity]) {
    assert.equal(FiveHourGone({ ...f, resetsAt: bad }, s(END + 9999)), false, `fiveHour.resetsAt=${String(bad)} → false`);
    assert.equal(FiveHourGone(f, { ...s(END + 9999), resetsAt: bad }), false, `sevenDay.resetsAt=${String(bad)} → false (not a usable reading)`);
    assert.equal(FiveHourGone(f, s(bad)), false, `sevenDay.reportedAt=${String(bad)} → false`);
  }
  // Pure: no clock (a stubbed Date.now changes nothing), no mutation.
  const fc = { ...f }; const sc = s(END + 901); const scc = { ...sc };
  const realNow = Date.now;
  try {
    Date.now = () => 0;
    assert.equal(FiveHourGone(fc, sc), true, 'the answer does not depend on the clock');
    Date.now = () => 9e15;
    assert.equal(FiveHourGone(fc, s(END + 900)), false, 'in either direction');
  } finally { Date.now = realNow; }
  assert.deepEqual(fc, f, 'fiveHour not mutated'); assert.deepEqual(sc, scc, 'sevenDay not mutated');
});

test('P16b — QuotaAbsence: `none` reads the file\'s shape — a usable 7d and no usable 5h — whatever the stamps', () => {
  const run7 = { usedPercentage: 54, resetsAt: NOW + 86400, reportedAt: NOW - 60 };
  const end7 = { usedPercentage: 54, resetsAt: NOW - 60, reportedAt: NOW - 3600 };
  const files = [
    { schema: 2, sevenDay: run7 },
    { schema: 2, sevenDay: end7 },
    { schema: 2, sevenDay: { ...run7, reportedAt: 'x' } },
    { schema: 2, sevenDay: run7, fiveHour: { usedPercentage: 1, resetsAt: 'soon', reportedAt: NOW } },
    { schema: 2, sevenDay: run7, fiveHour: null },
    { schema: 2, sevenDay: run7, fiveHour: 5 },
  ];
  for (const file of files) {
    for (const other of [true, false]) {
      for (const now of [NOW, NOW + 10 * 86400]) {
        assert.equal(QuotaAbsence('fiveHour', other, file, now), 'none',
          `fiveHour, other=${other}, file=${JSON.stringify(file)}: none`);
      }
    }
  }
  // No mirror for the 7d window (spec §3.6): a file with 5h and no 7d never says `none` for 7d.
  const only5 = { schema: 2, fiveHour: { usedPercentage: 1, resetsAt: NOW + 600, reportedAt: NOW } };
  for (const other of [true, false]) assert.equal(QuotaAbsence('sevenDay', other, only5, NOW), null, `sevenDay, 5h-only file, other=${other}: null`);
});

test('P16c — QuotaAbsence: `reset` from each trigger alone, `null` otherwise', () => {
  const run5 = { usedPercentage: 30, resetsAt: NOW + 600, reportedAt: NOW - 60 };
  const run7 = { usedPercentage: 54, resetsAt: NOW + 86400, reportedAt: NOW - 60 };
  const both = { schema: 2, fiveHour: run5, sevenDay: run7 };
  // Trigger 1: the other window is in this payload, the stored window still running.
  assert.equal(QuotaAbsence('fiveHour', true, both, NOW), 'reset', '5h: other in payload, stored running → reset');
  assert.equal(QuotaAbsence('sevenDay', true, both, NOW), 'reset', '7d: other in payload, stored running → reset');
  // Neither trigger: stored running, other not in payload → null (a session before its first response).
  assert.equal(QuotaAbsence('fiveHour', false, both, NOW), null, '5h: running, other absent → null');
  assert.equal(QuotaAbsence('sevenDay', false, both, NOW), null, '7d: running, other absent → null');
  // Trigger 2: the stored window has ended (resetsAt <= now), nothing in the payload.
  for (const key of ['fiveHour', 'sevenDay']) {
    const R = both[key].resetsAt;
    assert.equal(QuotaAbsence(key, false, both, R + 60), 'reset', `${key}: ended 60 s ago, other absent → reset`);
    assert.equal(QuotaAbsence(key, false, both, R), 'reset', `${key}: resetsAt === now → reset (the edge is inclusive)`);
    assert.equal(QuotaAbsence(key, false, both, R - 1), null, `${key}: one second before the end → null`);
  }
  // Ultra after a weekly reset: 7d ended, no 5h → 5h none, 7d reset.
  const ultraEnded = { schema: 2, sevenDay: { ...run7, resetsAt: NOW - 60 } };
  assert.equal(QuotaAbsence('fiveHour', false, ultraEnded, NOW), 'none', 'Ultra weekly reset: 5h none');
  assert.equal(QuotaAbsence('sevenDay', false, ultraEnded, NOW), 'reset', 'Ultra weekly reset: 7d reset');
  // A stored window that cannot be placed in time is not a reading.
  const badReset = { schema: 2, fiveHour: { ...run5, resetsAt: 'x' } };
  assert.equal(QuotaAbsence('fiveHour', true, badReset, NOW), null, 'a 5h with non-numeric resetsAt and no 7d → null');
  // Files with no window at all.
  for (const file of [null, undefined, {}, { schema: 2 }]) {
    for (const key of ['fiveHour', 'sevenDay']) {
      for (const other of [true, false]) {
        assert.equal(QuotaAbsence(key, other, file, NOW), null, `${key}, other=${other}, file=${JSON.stringify(file)}: null`);
      }
    }
  }
});

test('P16d — arity pins: FiveHourGone(2), QuotaAbsence(4), WriteQuotaFile(2, the options argument has a default)', () => {
  assert.equal(FiveHourGone.length, 2, 'FiveHourGone(fiveHour, sevenDay): two parameters and no clock');
  assert.equal(QuotaAbsence.length, 4, 'QuotaAbsence(key, otherInPayload, file, now)');
  assert.equal(WriteQuotaFile.length, 2, 'WriteQuotaFile(configHome, windows, { fiveHourAbsent } = {})');
});

// ── P17: ReadQuotaFile ──────────────────────────────────────────────────────────────────────────

test('P17 — ReadQuotaFile: the parsed object for a schema-2 file, null for anything else, never a throw', () => {
  const h = tempHome();
  try {
    assert.equal(ReadQuotaFile(h.dir), null, 'missing file → null');
    WriteQuotaFile(h.dir, { fiveHour: FIVE, sevenDay: SEVEN });
    assert.deepEqual(ReadQuotaFile(h.dir), JSON.parse(BOTH_BYTES), 'reads back exactly what the writer wrote');
    for (const [label, text] of [
      ['not json', 'not json'], ['truncated', '{"schema":2,"fiveHour":{'], ['empty', ''],
      ['array', '[]'], ['null', 'null'], ['number', '5'], ['string', '"x"'],
      ['schema 1', JSON.stringify({ schema: 1, sevenDay: SEVEN })],
      ['schema 3', JSON.stringify({ schema: 3, sevenDay: SEVEN })],
      ['schema "2"', JSON.stringify({ schema: '2', sevenDay: SEVEN })],
      ['no schema', JSON.stringify({ sevenDay: SEVEN })],
    ]) {
      writeFileSync(h.path, text, 'utf8');
      let r;
      assert.doesNotThrow(() => { r = ReadQuotaFile(h.dir); }, `${label}: no throw`);
      assert.equal(r, null, `${label}: null`);
    }
    writeFileSync(h.path, JSON.stringify({ schema: 2, sevenDay: SEVEN }), 'utf8');
    assert.deepEqual(ReadQuotaFile(h.dir), { schema: 2, sevenDay: SEVEN }, 'a 7d-only schema-2 file reads back as itself');
  } finally { h.cleanup(); }

  // The quota path is a directory; the home is a file; the home is not a string.
  const h2 = tempHome();
  try {
    mkdirSync(h2.path);
    assert.equal(ReadQuotaFile(h2.dir), null, 'quota path is a directory → null');
    const asFile = join(h2.dir, 'not-a-dir');
    writeFileSync(asFile, 'i am a file', 'utf8');
    assert.equal(ReadQuotaFile(asFile), null, 'config home is a file → null');
    for (const bad of [undefined, null, 42, {}]) {
      let r;
      assert.doesNotThrow(() => { r = ReadQuotaFile(bad); }, `configHome=${String(bad)}: no throw`);
      assert.equal(r, null, `configHome=${String(bad)}: null`);
    }
  } finally { h2.cleanup(); }
});
