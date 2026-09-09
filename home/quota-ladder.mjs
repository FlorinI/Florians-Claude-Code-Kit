// quota-ladder.mjs — the quota ladder: two windows' rate-limit readings turned into the gauge, the
// rung, the verdict and the runway, plus the eleven-key reading the quota file carries.
//
// PURE BY CONTRACT: no clock, no environment, no file I/O. Both moments arrive as arguments — `now`
// (the render/observation clock, epoch seconds) and `observedAt` (when the reading was taken). That
// is the same property that makes MergeQuotaWindow provable offline, applied to the ladder.
//
// TWO CALLERS, ONE LADDER. `home/statusline.mjs` renders it and resolves `observedAt` from the
// session's own last banked leg; `home/quota-probe.mjs` builds it from the rate-limit response
// headers of its own HTTP request and stamps that request's moment. It lives in its own module
// rather than inside statusline.mjs because statusline.mjs RENDERS on import — it reads stdin at
// module scope — so nothing can import a function out of it.
//
// This module decides nothing about where a reading is stored: WriteQuotaFile in
// `home/quota-file.mjs` is the single writer, and it takes what QuotaWindow returns.

import { psRound, FmtDurShort } from './_sl-compat.mjs';

const isNil = (v) => v === null || v === undefined;

const qBlocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
// BOTH rows now render at every quota level, so what changes with the level is which machinery runs.
// Two regimes, two named boundaries:
//   • Below QUOTA_VERDICT_MIN_PCT the beta rung machinery does not run AT ALL — no beta, no rung, no
//     bump, no imperative. beta = 1 - t/q is unstable when little of the window has elapsed (2%
//     consumed in 1% elapsed projects "slow down hard"), which is exactly what the old >=50% row
//     suppression kept off the screen. What renders instead is the ratio projection: where this
//     window is heading, with no instruction attached.
//   • The projection has its own floor, QUOTA_PROJECTION_MIN_ELAPSED_PCT, because rho = q/t blows up
//     as t approaches zero. Below it the row is the gauge and `resets`, nothing else.
// At and above the verdict floor the beta maths, the >=8h bump, the rung mapping and the at-cap
// override run exactly as before. Colour rule: BELOW the floor the
// gauge renders NEUTRAL — col === null, no SGR at all, like the repo slug — because no signal is
// claimed there, so no colour is spent. At rung 0 the beta machinery has run and CLEARED the window,
// and that earned verdict renders GREEN (ANSI 32, the file's Green — the quota ladder is plain ANSI):
// gauge and verdict both. Calm-before-the-floor and cleared-above-the-floor are different facts and
// now look different. The row-4 runway/projection renders off detailCol — the rung colour for rungs
// 1-3 and at-cap, chrome (null) at rung 0 and below the floor — so the green never reaches row 4.
export const QUOTA_VERDICT_MIN_PCT = 50;
export const QUOTA_PROJECTION_MIN_ELAPSED_PCT = 10;
function QLvl(p) { let l = psRound(p / 100.0 * 8); if (p > 0 && l < 1) l = 1; if (l > 8) l = 8; return l; }
export function QuotaCells(rl, winSec, now) {
  if (!rl || isNil(rl.used_percentage)) return null;
  const consumed = Number(rl.used_percentage);
  let elapsed = null;
  if (rl.resets_at) {
    const remain = Number(rl.resets_at) - now;
    elapsed = ((winSec - remain) / winSec) * 100.0;
    if (elapsed < 0) elapsed = 0; if (elapsed > 100) elapsed = 100;
  }
  const q = consumed / 100.0;
  const t = !isNil(elapsed) ? elapsed / 100.0 : null;
  const cbar = qBlocks[QLvl(consumed)];
  const ebar = !isNil(elapsed) ? qBlocks[QLvl(elapsed)] : ' ';
  const qn = psRound(consumed);
  const tn = !isNil(elapsed) ? psRound(elapsed) : null;
  // ONE COMPOSITION, TWO RENDERINGS. `core` is the gauge itself; `mid` is this line's own cell, which
  // is `core` inside its arrows. The fleet tray draws `core` — the arrows frame nothing its columns
  // do not already frame — and composing `mid` from `core` is what keeps this line byte-identical.
  const core = `${qn}%${cbar}${ebar}` + (!isNil(tn) ? `${tn}%` : '');
  const mid = '→' + core + '←';
  const resets = rl.resets_at ? 'resets ' + FmtDurShort(psRound(Number(rl.resets_at) - now)) : null;
  if (consumed < QUOTA_VERDICT_MIN_PCT) {
    // TWO named gates, and the projection is silent unless BOTH open.
    //   enoughElapsed — rho = q/t blows up as t approaches zero, so a projection off a sliver of
    //     elapsed time would be shown and disbelieved.
    //   underPace — `ends ~N% · M% spare` is the CALM phrasing, and rho is NOT bounded by 1: a
    //     window running ahead of the clock projects past 100% and a NEGATIVE spare (20% consumed
    //     in 12% elapsed reads `ends ~163% · -63% spare`). Below the verdict floor this cluster
    //     deliberately refuses to project a blackout at all, because beta is unstable this early —
    //     so for over-pace-but-young the honest output is SILENCE, not a nonsense number. Nothing
    //     is hidden: the gauge beside it already shows consumed against elapsed, and the reader can
    //     draw their own conclusion. This is the same condition rung 0 encodes above the floor
    //     (`beta <= 0` is exactly `t >= q`), so the two regimes agree on what "calm" means.
    const enoughElapsed = !isNil(elapsed) && elapsed >= QUOTA_PROJECTION_MIN_ELAPSED_PCT;
    const underPace = !isNil(elapsed) && consumed <= elapsed;
    const projection = (enoughElapsed && underPace)
      ? `ends ~${psRound((q / t) * 100)}% ` + '·' + ` ${psRound((1 - q / t) * 100)}% spare` : null;
    return {
      col: null, detailCol: null, mid, core, verdict: null, detail: projection, resets,
      // The structured half (spec §4.1). It exists so the fleet tray can AGREE with this row rather
      // than re-derive it: the ladder runs once, here, and the QUOTA FILE carries its outputs.
      rung: null, exhausted: (consumed >= 100), belowFloor: true,
      actSec: null, darkSec: null, note: null,
    };
  }
  const exhausted = (consumed >= 100);
  let beta = null, B = null, S = null;
  if (!isNil(t) && t > 0 && !exhausted) {
    beta = Math.max(0, 1.0 - (t / q));
    B = beta * winSec;
    S = q > t ? ((t / q) - t) * winSec : 0;
  }
  let rung;
  if (exhausted) rung = 3;
  else if (isNil(beta)) rung = consumed >= 90 ? 3 : consumed >= 70 ? 1 : 0;
  else if (beta <= 0) rung = 0;
  else if (beta <= 0.10) rung = 1;
  else if (beta <= 0.25) rung = 2;
  else rung = 3;
  if (!isNil(B) && B >= 28800 && rung < 3) rung++;
  let col = rung === 0 ? '32' : rung === 1 ? '38;5;220' : rung === 2 ? '38;5;208' : '1;31';
  let verdict, detail;
  // The figures the detail sentence spells out, kept as numbers for the quota file (§4.1). Each is
  // set on exactly the branch that produced the sentence, so a figure the row did not state is null
  // rather than recomputed behind it.
  let actSec = null, darkSec = null, note = null;
  if (exhausted) {
    col = '38;5;208';
    // The verdict drops the window label: the label field already carries 5h / 7d, and dropping the
    // repeat is what makes the exhausted state fit a half-width column.
    if (consumed > 100) { verdict = 'over cap'; detail = 'on usage credits ' + '·' + ' paying overage'; }
    else { verdict = 'cap reached'; detail = 'on credits, or blocked til reset'; }
    note = detail;
  } else {
    verdict = rung === 0 ? 'you can keep this pace' : rung === 1 ? 'slow down just a bit' : rung === 2 ? 'slow down' : 'slow down hard';
    if (rung === 0 && !isNil(t) && t > 0) {
      const rho = q / t;
      detail = `ends ~${psRound(rho * 100)}% ` + '·' + ` ${psRound((1 - rho) * 100)}% spare`;
    } else if (!isNil(B)) {
      detail = FmtDurShort(S) + ' to act ' + '→' + ' ' + FmtDurShort(B) + ' dark';
      actSec = psRound(S);
      darkSec = psRound(B);
    } else {
      detail = null;
    }
  }
  // detailCol: the runway keeps the rung colour only when it is a warning (rungs 1-3, at-cap);
  // rung 0's `ends ~N% · M% spare` is chrome — the green names the gauge and the verdict only.
  const detailCol = rung === 0 ? null : col;
  return {
    col, detailCol, mid, core, verdict, detail, resets,
    rung, exhausted, belowFloor: false,
    actSec, darkSec, note,
  };
}

// One window's quota reading, as the quota file carries it for the fleet tray (docs/fleet-tray.md).
// ELEVEN KEYS, AND EVERY ONE HAS A READER (spec §4.2): `usedPercentage` orders the merge and ranks
// the tray's `next`; `resetsAt` orders the merge, drives the countdown and decides whether a window
// has reset; `reportedAt` is the age; the remaining eight are drawn.
//
// THE LADDER IS NOT RE-DERIVED ANYWHERE: everything below is what QuotaCells already computed, plus
// the two raw payload fields. The tray recomputes exactly two figures, both pure elapsed time — the
// `resets` countdown and the `as of` age — off epochs, which do not go stale the way a formatted
// duration does.
//
// NO WINDOW WITHOUT A RESET MOMENT. Without one there is no age and no countdown, so the row would
// be a photograph with no date — which is the one thing the tray's whole layout exists to prevent.
// Today's payloads always carry `resets_at`; if that ever changes the block goes quiet for that
// window, which is the honest outcome.
//
// `reportedAt` — WHEN THIS READING WAS OBSERVED, and the mechanism the tray's `as of` rests on. It
// is stamped here, once, and TRAVELS INSIDE THE READING: the merge never restamps it, so a session
// re-rendering a nine-day-old payload carries the old stamp forward unchanged. That is what makes
// the anti-zombie property structural rather than a rule some merge branch has to defend.
//
// THE OBSERVATION MOMENT IS THE CALLER'S TO RESOLVE, because the two callers observe differently and
// only they know how. A rendering session's payload came from ITS OWN last API call, so the session
// passes that call's moment (its last banked leg). The quota probe's own HTTP request IS the API
// call, so it passes the moment that request's response headers arrived. Either way `observedAt` is
// when the numbers in `rl` were true, in epoch SECONDS — the same unit as `resets_at` and `now`.
//
// THE CLAMP HAS TWO HALVES AND BOTH ARE LOAD-BEARING.
//   min(…, resets_at): a reading cannot have been taken after the window it names ended, so a
//   reading whose window had already closed is at least as old as that closure. Without it a session
//   idle for days stamps TODAY on a stale payload — the tray would draw `as of 0m` beside `window
//   has reset`, the exact contradiction this file has already shipped once. It is also what keeps a
//   dead window's bytes still: every re-render of it produces the same clamped stamp, a total merge
//   tie, and no write.
//   min(…, now): an observation moment cannot legitimately be in the future, so a clock-skewed
//   transcript must not be able to stamp a reading forward.
export function QuotaWindow(c, rl, observedAt, now) {
  if (!c || isNil(rl.resets_at)) return null;
  const resetsAt = Number(rl.resets_at);
  if (!Number.isFinite(resetsAt)) return null;
  return {
    usedPercentage: Number(rl.used_percentage),
    resetsAt,
    reportedAt: Math.min(observedAt, now, resetsAt),
    gauge: c.core,
    rung: c.rung,
    exhausted: c.exhausted,
    belowFloor: c.belowFloor,
    verdict: c.verdict ?? null,
    actSec: c.actSec,
    darkSec: c.darkSec,
    note: c.note,
  };
}
