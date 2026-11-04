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
// THE MERGE TAKES NO CLOCK. Each stored reading carries its own `reportedAt` — THE MOMENT THE
// READING WAS OBSERVED, which is the session's own last banked leg (its last API call), clamped at
// the render clock and at the window's end. It is written by the status line that produced it (see
// QuotaWindow in statusline.mjs), so the age travels INSIDE the reading. The merge's job is choosing
// which of two readings to keep; the one stamp it ever adjusts is a clamp UP to the stored stamp at
// rule 3 (below), never a clock reading.
//
// The split is deliberate: MergeQuotaWindow and FiveHourGone are pure and hold the whole ordering
// and drop rules, so every branch of them is reachable offline without a render; WriteQuotaFile does
// the I/O around them and decides nothing. ReadQuotaFile is the read-only half the status line uses
// to name an absent window, and QuotaAbsence is that naming rule, pure.
//
// THE ONE WAY A WINDOW LEAVES THE FILE. A 5-hour window that ended without a successor is removed
// when an API response that carried no 5-hour window was observed more than the grace after it
// ended — the shape of a plan that has no 5-hour window at all. Only a real API observation counts
// as evidence (the caller says so with `fiveHourAbsent`); a stored stamp is never evidence, because
// it may be a render-clock stand-in written by a render that had no banked leg.
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
// A usable reading: an object with a finite numeric `resetsAt`. The same test MergeQuotaWindow's
// rule 1 applies to a stored window.
const usable = (w) => !!w && typeof w === 'object' && isNum(w.resetsAt);

// The one parse of the file's text, shared by the writer and the reader: the object when the text
// parses to a schema-2 object, else null. Never throws.
function parseQuotaText(text) {
  if (!text) return null;
  try {
    const p = JSON.parse(text);
    return (p && typeof p === 'object' && !Array.isArray(p) && p.schema === QUOTA_SCHEMA) ? p : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// FiveHourGone(fiveHour, sevenDay) — true when `sevenDay`, a reading from an API response that
// carried no 5-hour window, was observed more than FIVE_HOUR_DROP_GRACE_SEC after `fiveHour` ended.
// PURE; takes no clock — it compares two epochs, as the merge rules do.
//
// WHY THE GRACE. A session dates its reading by its last transcript leg, which can land a little
// after the moment the headers arrived — a long response straddling a 5-hour reset. Claude Code
// drops the ended window from that payload, and without a grace the straddle would remove a real
// window. A single response streaming longer than the grace across a reset still would; the next
// response brings the window back under merge rule 1, so the error lasts one message.
export const FIVE_HOUR_DROP_GRACE_SEC = 900;

export function FiveHourGone(fiveHour, sevenDay) {
  if (!usable(fiveHour) || !usable(sevenDay)) return false;
  const seen = numOrNull(sevenDay.reportedAt);
  return seen !== null && seen > fiveHour.resetsAt + FIVE_HOUR_DROP_GRACE_SEC;
}

// ---------------------------------------------------------------------------
// QuotaAbsence(key, otherInPayload, file, now) — why a window the payload did not carry is absent.
// `key`: 'fiveHour' | 'sevenDay'. `otherInPayload`: the OTHER window is in this render's payload.
// `file`: ReadQuotaFile's result (or null). `now`: the render clock — the display may read a clock;
// the writer's rules may not.
//
//   'none'  — the file holds a 7-day reading and no 5-hour reading: the writer dropped the 5-hour
//             window, or the home never had one. Reads the file's SHAPE, never a stamp: a stored
//             stamp may be a render-clock stand-in and proves nothing.
//   'reset' — the stored window is usable and either the other window is in this payload (this
//             session made an API call and Claude Code has since removed this window, which it does
//             only once the window's `resets_at` passes) or the stored window has ended.
//   null    — nothing known: the plain `n/a`.
export function QuotaAbsence(key, otherInPayload, file, now) {
  if (key === 'fiveHour' && usable(file?.sevenDay) && !usable(file?.fiveHour)) return 'none';
  const stored = file?.[key];
  if (usable(stored) && (otherInPayload || stored.resetsAt <= now)) return 'reset';
  return null;
}

// ---------------------------------------------------------------------------
// ReadQuotaFile(configHome) — the parsed file when it parses and its `schema` is 2, else null.
// Never throws, including for a non-string home.
export function ReadQuotaFile(configHome) {
  try { return parseQuotaText(readFileSync(join(configHome, QUOTA_FILE_NAME), 'utf8')); }
  catch { return null; }
}

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
//                                    The incoming reading wins entire EXCEPT for a stamp that would
//                                    move the row's date backwards: that stamp is clamped up to the
//                                    stored one.
//   4. equal `resetsAt` AND equal `usedPercentage`
//                                 -> the LATER `reportedAt`, and it wins WHOLE. Equal on all three
//                                    -> STORED, so the bytes do not move and the unchanged write
//                                    below is skipped.
//
// WHY THE LATER OBSERVATION WINS A TIE. A reading that re-observes an unchanged percentage is
// independent evidence that the percentage was still that value at the moment it was observed.
// Discarding it dated the row by THE LAST TIME THE NUMBER MOVED rather than by the last time it was
// seen, and on the `7d` row — where a whole percentage point takes tens of minutes to turn over —
// the tray drew `as of 120m` on a value re-confirmed seconds earlier.
//
// THE RULE NOW FIRES ON RE-OBSERVATIONS ONLY, AND THAT IS THE POINT. Since the stamp is the
// observation moment, an ECHO — an idle session re-rendering the payload of an API call it already
// reported — carries the OLDER stamp and loses this tie, leaving the bytes exactly where they were.
// A genuine re-observation at an unchanged percentage still wins it and still moves the bytes.
//
// WHY IT TAKES THE WHOLE OBJECT rather than only the stamp. The elapsed half of a reading is
// computed from the RENDER CLOCK, not from the payload: at equal consumption a later render produces
// a later elapsed figure inside the gauge, a shorter runway and possibly a calmer rung. Grafting the
// later stamp onto the stored object would draw a fresh date beside a stale elapsed bar. Every field
// of the later object is at least as current as the stored one and none is worse, so it is taken
// entire.
//
// THE ANTI-ZOMBIE PROPERTY SURVIVES THIS RELAXATION, and this rule is not what holds it. A session
// re-rendering a stale payload either names an older window (rule 2 refuses it) or names the same
// window, where two things stop it. Its stamp is the old observation's moment, so it does not beat a
// later reading on rule 4 at all; and if that window has already reset, QuotaWindow's clamp makes
// both stamps exactly `resetsAt`, so the tie is TOTAL, stored wins, and the bytes do not move. No
// number of re-renders can freshen the date on a dead window.
//
// RULE 4 READS A STAMP; IT DOES NOT WRITE ONE. This function still takes two parameters and no clock.
//
// WHY RULE 3 CLAMPS THE STAMP, AND WHY THAT IS NOT A FABRICATION. A session's stamp is its own last
// banked API call, which can predate a reading another session already delivered — so a higher
// percentage could arrive carrying an older date and drag the row's `as of` backwards. Within one
// window consumption only rises, so a reading reporting a higher figure cannot have been observed
// BEFORE one reporting a lower figure: the stored stamp is a true lower bound on the incoming
// observation's moment, and taking it is a clamp, not a guess. The clamp builds a COPY of the
// incoming object; neither argument is mutated, and a copy is allocated only when the clamp fires.
//
// A window with no numeric `resetsAt` is not a shape our own writer can produce: QuotaWindow refuses
// to build one, because a reading with no reset moment has no age and no countdown. It is handled
// here only as "no stored reading", never carried forward. A window with no numeric `reportedAt` is
// not one either; at a tie it loses to one that has a stamp, which is the same direction rules 2 and
// 3 take for a missing field.
//
// The stored object is returned BY REFERENCE when it wins — same object, same bytes, same
// `reportedAt`. Every branch except the rule-3 clamp returns one of its arguments, and nothing in
// this function writes a field of either.
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
  const sp = numOrNull(stored.reportedAt);
  const ip = numOrNull(incoming.reportedAt);
  if (iu !== su) {
    if (iu < su) return stored;
    return (sp !== null && ip !== null && ip < sp) ? { ...incoming, reportedAt: sp } : incoming;
  }
  if (sp === null) return incoming;
  if (ip === null) return stored;
  return ip > sp ? incoming : stored;
}

// ---------------------------------------------------------------------------
// WriteQuotaFile(configHome, windows, { fiveHourAbsent }) — read, merge each window key
// independently, drop an ended 5-hour window when this write is evidence, write.
//
// A window the payload did not carry is LEFT IN THE FILE UNTOUCHED: a session whose payload holds
// only `five_hour` must never wipe a good `sevenDay`. A render carrying no usable window writes
// nothing at all and never clears the file.
//
// THE ONE EXCEPTION: THE DROP. The caller passes `fiveHourAbsent: true` only when this write's
// stamps are a real API observation (a session's banked leg, or the probe's own request) AND that
// response carried no 5-hour window at all. Then, after the merge, a stored `fiveHour` for which
// FiveHourGone(stored, incoming sevenDay) holds is deleted and its verdict is `'dropped'`. The
// evidence is THIS WRITE'S OWN incoming `sevenDay`, never the stored one: a stored stamp may be a
// render-clock stand-in written by a render that had no banked leg, and proves nothing about any
// response. The incoming reading wins or loses its own merge independently; the drop reads its stamp
// either way, because that stamp is the moment of the response this write observed. A caller that
// passes no options never drops.
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
// WHICH RENDERS IT SKIPS. Merge rule 4 advances `reportedAt` on a tie, but the stamp is now the
// OBSERVATION moment, so only a render carrying a NEW observation can advance it: an idle session's
// re-render produces the stamp it produced last time, the merge is a total tie, and no bytes move.
// A home whose window has reset writes nothing either (the clamp makes every one of those renders a
// total tie), and a home nobody is rendering in writes nothing because it does not render. What is
// left is one write per genuine new reading, and each of those costs the tray's TWO-SECOND POLL
// THREAD one re-parse — a thread that already enumerates the whole session tree on every tick, so
// one small JSON file per config home is not its cost centre. The PAINT thread still opens nothing,
// which is the property the tray's responsiveness actually rests on.
//
// THE RACE, stated plainly: two renders whose read->rename windows overlap can lose the later
// update. The file is never torn (the rename is atomic) and never holds garbage; what it can hold,
// briefly, is the loser's reading. The clobbering write still had to pass the merge against the
// state IT read, so a reading that loses a race is never worse than one merge step behind, and a
// stale reading can never win at all. The pathological case — a nine-day-old snapshot overwriting a
// live one — is excluded by the rule regardless of timing.
//
// RETURNS ONE VERDICT PER WINDOW THE PAYLOAD CARRIED, plus `fiveHour: 'dropped'` when the drop
// fired: `{ fiveHour?, sevenDay? }`, each `'written'`, `'kept'` or `'dropped'`. The two windows merge
// independently, so one file-wide answer would be one answer to two questions. Every path that
// decided nothing — no usable window, or the catch — returns `{}`.
//
// Never throws: a failure loses one render's update and nothing else.
export function WriteQuotaFile(configHome, windows, { fiveHourAbsent = false } = {}) {
  try {
    const incoming = windows && typeof windows === 'object' ? windows : {};
    if (!WINDOW_KEYS.some((k) => incoming[k])) return {};
    const path = join(configHome, QUOTA_FILE_NAME);
    let text = null;
    try { text = readFileSync(path, 'utf8'); } catch { text = null; }
    // A missing, unparseable or foreign-schema file reads as {} and is replaced — none of them
    // carries a reading this build can vouch for.
    const cur = parseQuotaText(text) || {};
    const out = { schema: QUOTA_SCHEMA };
    const verdicts = {};
    for (const k of WINDOW_KEYS) {
      const stored = (cur[k] && typeof cur[k] === 'object') ? cur[k] : null;
      if (incoming[k]) {
        out[k] = MergeQuotaWindow(stored, incoming[k]);
        // `written` vs `kept` is the MERGE's own answer, read off object identity: MergeQuotaWindow
        // returns the stored object BY REFERENCE when it wins, so `out[k] === stored` is the whole
        // test and it needs no second parse. `kept` means this window's submitted reading did not
        // survive the merge.
        verdicts[k] = (out[k] === stored) ? 'kept' : 'written';
      } else if (stored) out[k] = stored;
    }
    if (fiveHourAbsent && out.fiveHour && FiveHourGone(out.fiveHour, incoming.sevenDay)) {
      delete out.fiveHour;
      verdicts.fiveHour = 'dropped';
    }
    const json = JSON.stringify(out, null, 2);
    // A skipped write cannot make a `written` verdict lie: every merge branch in which the incoming
    // reading wins requires a field to differ (`resetsAt`, `usedPercentage` or `reportedAt`), so
    // incoming winning implies different bytes, and the skip fires only when the bytes are equal.
    if (json === text) return verdicts;
    atomicWriteFile(path, json);
    return verdicts;
  } catch { return {}; /* one render's update, nothing else */ }
}
