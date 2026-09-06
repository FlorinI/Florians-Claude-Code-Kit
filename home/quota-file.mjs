// quota-file.mjs — the per-config-home quota file: `<config-home>/statusline-quota.json`.
//
// WHAT THIS FILE EXISTS TO FIX. Claude Code hands every process the `rate_limits` its OWN last API
// call returned, so at any instant the sessions in one config home hold readings of the same counter
// taken at different times. A reading is therefore not a fact about the home — it is an OBSERVATION,
// and observations have to be ordered before one of them can be displayed. A single slot rewritten
// by whichever session rendered last shows whichever observation happened to be youngest in wall-
// clock write order, which is not the same thing as the freshest reading, and in practice was days
// out. So this file is MERGED, never overwritten, and the ordering comes from the reading itself:
// `resetsAt` first, then `usedPercentage` within one window, and — only to break a tie between those
// two — the later `reportedAt`. Nothing here consults a file's modification time, the writing
// session's identity, or the render clock.
//
// THE MERGE STAMPS NOTHING, AND TAKES NO CLOCK. Each stored reading carries its own `reportedAt` —
// the moment it was taken, written once by the status line that produced it (see QuotaWindow in
// statusline.mjs) — so the age travels INSIDE the reading. The merge's only job is choosing which of
// two readings to keep, which is all it should ever have been.
//
// Two functions, and the split is deliberate: MergeQuotaWindow is pure and holds the whole ordering
// rule, so every branch of it is reachable offline without a render; WriteQuotaFile does the I/O
// around it and decides nothing.
//
// It lives in its own module rather than inside statusline.mjs because statusline.mjs RENDERS on
// import — it reads stdin at module scope — so nothing can import a function out of it. Being
// importable is what makes the ordering rule unit-testable, which is the property that failed here
// once already.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from './_sl-compat.mjs';

// The file's format version. It HAS a reader and the reader requires it: the fleet tray accepts
// exactly 2 and refuses anything else, drawing no rows for that home rather than misreading a shape
// it does not know. A tray built before a fork degrades to silence — the honest direction.
//
// IT MOVED TO 2 BECAUSE THE SHAPE GENUINELY FORKED: five per-window keys were removed
// (`windowSec`, `consumedPct`, `elapsedPct`, `sparePct`, `observedAt`) and one added (`reportedAt`),
// and `observedAt` is REQUIRED by the previously deployed reader. This is the escape hatch's first
// real use.
export const QUOTA_SCHEMA = 2;
export const QUOTA_FILE_NAME = 'statusline-quota.json';
// `5h` before `7d`, always, so two writers of the same readings produce the same bytes.
const WINDOW_KEYS = ['fiveHour', 'sevenDay'];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x) => (isNum(x) ? x : null);

// ---------------------------------------------------------------------------
// MergeQuotaWindow(stored, incoming) — which of two readings of ONE window survives. PURE: both
// objects arrive as arguments, no file is touched, NO CLOCK IS TAKEN, and this is the single
// implementation of "which reading wins".
//
// The rules, first one that decides:
//   1. no usable `stored`         -> incoming. Any reading beats none. A stored object without a
//                                    numeric `resetsAt` counts as no stored reading — and a file
//                                    whose `schema` is not 2 has already been read as {} by the
//                                    caller, so every one of its windows lands on this branch.
//   2. different `resetsAt`       -> the LATER one. A later reset moment is a later window; the
//                                    earlier one has ended.
//   3. equal `resetsAt`           -> the same window, so the tie-break is consumption: the HIGHER
//                                    `usedPercentage`, because within a window it only rises.
//   4. equal `resetsAt` AND equal `usedPercentage`
//                                 -> the LATER `reportedAt`, and it wins WHOLE. Equal on all three
//                                    -> STORED, so the bytes do not move and the unchanged write
//                                    below is skipped.
//
// WHY THE LATER REPORT WINS A TIE. A render that re-reports an unchanged percentage is independent
// evidence that the percentage was still that value at the moment it reported. Discarding it dated
// the row by THE LAST TIME THE NUMBER MOVED rather than by the last time it was reported, and on the
// `7d` row — where a whole percentage point takes tens of minutes to turn over — the tray drew
// `as of 120m` on a value re-confirmed seconds earlier.
//
// WHY IT TAKES THE WHOLE OBJECT rather than only the stamp. The elapsed half of a reading is
// computed from the RENDER CLOCK, not from the payload: at equal consumption a later render produces
// a later elapsed figure inside the gauge, a shorter runway and possibly a calmer rung. Grafting the
// later stamp onto the stored object would draw a fresh date beside a stale elapsed bar. Every field
// of the later object is at least as current as the stored one and none is worse, so it is taken
// entire.
//
// THE ANTI-ZOMBIE PROPERTY SURVIVES THIS RELAXATION, and the clamp is what holds it — not this rule.
// A session re-rendering a stale payload either names an older window (rule 2 refuses it) or names
// the same window; and if that window has already reset, QuotaWindow's clamp makes both stamps
// exactly `resetsAt`, so the tie is TOTAL, stored wins, and the bytes do not move. No number of
// re-renders can freshen the date on a dead window.
//
// RULE 4 READS A STAMP; IT DOES NOT WRITE ONE. This function still takes two parameters and no clock.
//
// A window with no numeric `resetsAt` is not a shape our own writer can produce: QuotaWindow refuses
// to build one, because a reading with no reset moment has no age and no countdown. It is handled
// here only as "no stored reading", never carried forward. A window with no numeric `reportedAt` is
// not one either; at a tie it loses to one that has a stamp, which is the same direction rules 2 and
// 3 take for a missing field.
//
// The stored object is returned BY REFERENCE when it wins — same object, same bytes, same
// `reportedAt`. Nothing in this function writes a field.
export function MergeQuotaWindow(stored, incoming) {
  if (!stored || typeof stored !== 'object') return incoming;
  const sr = numOrNull(stored.resetsAt);
  if (sr === null) return incoming;
  const ir = numOrNull(incoming.resetsAt);
  if (ir === null) return stored;
  if (sr !== ir) return ir > sr ? incoming : stored;
  const su = numOrNull(stored.usedPercentage);
  const iu = numOrNull(incoming.usedPercentage);
  if (su === null) return incoming;
  if (iu === null) return stored;
  if (iu !== su) return iu > su ? incoming : stored;
  const sp = numOrNull(stored.reportedAt);
  const ip = numOrNull(incoming.reportedAt);
  if (sp === null) return incoming;
  if (ip === null) return stored;
  return ip > sp ? incoming : stored;
}

// ---------------------------------------------------------------------------
// WriteQuotaFile(configHome, windows) — read, merge each window key independently, write.
//
// A window the payload did not carry is LEFT IN THE FILE UNTOUCHED: a session whose payload holds
// only `five_hour` must never wipe a good `sevenDay`. A render carrying no usable window writes
// nothing at all and never clears the file.
//
// A FILE WHOSE `schema` IS NOT 2 READS AS {} — the stored object is discarded WHOLE, not projected
// window by window. A schema-1 window carries no `reportedAt`, and there is no honest way to derive
// one; projecting it forward would let a fifteen-key object leak into a file stamped eleven. This
// fires on the FIRST render after install, not in a corner: both live config homes hold a schema-1
// file today, and in at least one of them the stored reading is the fresher one — so that first
// render discards a good reading and replaces it with whatever the rendering session holds. The cost
// is one render, and the block is correct from then on.
//
// AN UNCHANGED MERGE WRITES NOTHING, and that is a requirement rather than an optimisation. The
// tray re-parses a home's file only when its LastWriteTimeUtc moved, so rewriting identical bytes on
// every render would move that stamp constantly and re-parse every home on every 2-second poll,
// defeating the cache the poll thread depends on. The test is a BYTE COMPARISON against the text
// just read — normative because it needs no field list to stay in sync with the schema.
//
// IT FIRES LESS OFTEN THAN IT USED TO, AND THAT IS ACCEPTED RATHER THAN WORKED AROUND. Merge rule 4
// advances `reportedAt` on a tie, so a home whose sessions keep rendering now writes on every render
// and the tray re-parses it on the following poll. That cost lands on the tray's TWO-SECOND POLL
// THREAD, which already enumerates the whole session tree on every tick — one small JSON file per
// config home is not that thread's cost centre, and the PAINT thread still opens nothing, which is
// the property the tray's responsiveness actually rests on. A home whose window has reset writes
// nothing at all (the clamp makes every one of those renders a total tie) and a home nobody is
// rendering in writes nothing because it does not render.
//
// THE RACE, stated plainly: two renders whose read->rename windows overlap can lose the later
// update. The file is never torn (the rename is atomic) and never holds garbage; what it can hold,
// briefly, is the loser's reading. The clobbering write still had to pass the merge against the
// state IT read, so a reading that loses a race is never worse than one merge step behind, and a
// stale reading can never win at all. The pathological case — a nine-day-old snapshot overwriting a
// live one — is excluded by the rule regardless of timing.
//
// Never throws: a failure loses one render's update and nothing else.
export function WriteQuotaFile(configHome, windows) {
  try {
    const incoming = windows && typeof windows === 'object' ? windows : {};
    if (!WINDOW_KEYS.some((k) => incoming[k])) return;
    const path = join(configHome, QUOTA_FILE_NAME);
    let text = null;
    try { text = readFileSync(path, 'utf8'); } catch { text = null; }
    // A missing, unparseable or foreign-schema file reads as {} and is replaced — none of them
    // carries a reading this build can vouch for.
    let cur = {};
    if (text) {
      try {
        const p = JSON.parse(text);
        if (p && typeof p === 'object' && !Array.isArray(p) && p.schema === QUOTA_SCHEMA) cur = p;
      } catch { cur = {}; }
    }
    const out = { schema: QUOTA_SCHEMA };
    for (const k of WINDOW_KEYS) {
      const stored = (cur[k] && typeof cur[k] === 'object') ? cur[k] : null;
      if (incoming[k]) out[k] = MergeQuotaWindow(stored, incoming[k]);
      else if (stored) out[k] = stored;
    }
    const json = JSON.stringify(out, null, 2);
    if (json === text) return;
    atomicWriteFile(path, json);
  } catch { /* one render's update, nothing else */ }
}
