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
//
// ── Row map ─────────────────────────────────────────────────────────────────────────────────────
//   P1  schema constants                        P7  argument-order symmetry (AE-1, AE-2)
//   P2  rule 1: any reading beats none          P8  writer: missing file → created, byte-exact (AE-4)
//   P3  rule 2: later resetsAt (AE-1)           P9  writer: unusable/foreign-schema file replaced (AE-4)
//   P4  rule 3: higher usedPercentage (AE-2)    P10 writer: identical bytes → no rewrite (AE-5)
//   P5  rule 4: later reportedAt, whole (AE-3)  P11 writer: per-key independence, no-window no-write (AE-6)
//   P6  non-numeric fields count as absent      P12 writer: never throws

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MergeQuotaWindow, WriteQuotaFile, QUOTA_SCHEMA, QUOTA_FILE_NAME } from '../home/quota-file.mjs';

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
  const higher = win({ used: 41, reported: NOW - 7200 });
  assert.ok(Object.is(MergeQuotaWindow(s, higher), higher), 'higher usedPercentage wins even with an older stamp');
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
    ['rule 3', win({ used: 40, reported: NOW }), win({ used: 41, reported: NOW - 7200 })],
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
