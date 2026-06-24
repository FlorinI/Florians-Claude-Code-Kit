// handover-facts.mjs — deterministic fact sheet for /handover-check (Layer 1, no LLM).
//
// Node port of handover-facts.ps1. Reads the status-line sidecar snapshot and resolves EVERY
// classification + pre-formats EVERY number (backticks already on, ready to paste), so the Sonnet
// compose step never derives a band, applies a threshold, or formats a fragment — it only weaves
// these facts into prose. The headline COST rule is the FIXED one (froz5 trend gated by an absolute
// $/leg floor, so a light-start-inflated ratio on cheap legs can't false-fire "wind down"). Output
// is a labelled fact sheet consumed by the subagent — NOT pasted to the user. Read-only, off the hot
// path (runs only when /handover-check is invoked).
//
// All thresholds live in the TUNABLES block — recalibrate there; keep in sync with docs/status-line.md.
// Numeric/clock semantics come from _sl-compat.mjs (psRound = [int]/[Math]::Round, fmtN = '{0:N2}',
// mathRoundD = [Math]::Round(x,2), nowEpoch = the frozen-clock seam), so the fact sheet matches the
// retired pwsh original byte-for-byte.

import { readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveSidecarPath } from './sidecar-path.mjs';
import { getScannedLegs, testColdLeg, M_CACHE_READ } from './leg-driver.mjs';
import { psRound, fmtN, mathRoundD, nowEpoch } from './_sl-compat.mjs';

const BT = '`';          // literal backtick → inline-code spans render light-blue in the assistant message
const MID = '·';    // ·
const TIMES = '×';  // ×
const NDASH = '–';  // –
const WARN = '⚠';   // ⚠

const claudeHome = process.env.USERPROFILE || homedir();
const lines = [];
const emit = (s) => lines.push(s);
function flushAndExit() { process.stdout.write(lines.join('\n')); process.exit(0); }

// ---- resolve + read the sidecar ----
const sidecar = resolveSidecarPath(process.env.CLAUDE_PROJECT_DIR || process.cwd());
if (!sidecar || !existsSync(sidecar)) { process.stdout.write('MISSING'); process.exit(0); }
let s;
try { s = JSON.parse(readFileSync(sidecar, 'utf8')); } catch { s = null; }
if (!s) { process.stdout.write('MISSING'); process.exit(0); }

// FOREIGN guard — is this snapshot actually MINE? The status line writes one sidecar per project (and a
// global fallback); a session that never renders a status line (e.g. the desktop app) writes none, so the
// resolver silently hands us another session's snapshot. The discriminator is the session id, NOT age:
// CLAUDE_CODE_SESSION_ID is set for spawned processes and the sidecar stores the full sessionId, so a
// definite mismatch means "wrong session → abort". (Staleness stays a soft warning below.) When the env id
// is absent we can't verify ownership — proceed unchanged.
const mySid = process.env.CLAUDE_CODE_SESSION_ID;
if (mySid && s.sessionId && String(mySid) !== String(s.sessionId)) {
  const snapSid8 = String(s.sessionId).slice(0, Math.min(8, String(s.sessionId).length));
  const mySid8 = String(mySid).slice(0, Math.min(8, String(mySid).length));
  process.stdout.write(`FOREIGN\nthis session: ${mySid8}\nsnapshot belongs to: ${snapSid8} (${s.gitRepo ? s.gitRepo : '(no repo)'})`);
  process.exit(0);
}

// Freeze the EXACT snapshot this run used → render-legspark/render-spikes (--frozen) read THIS file, so all
// three renderers see the SAME session even if a concurrent same-project session clobbers the live sidecar
// between reads. Best-effort; a freeze failure just falls them back to the live sidecar.
try { copyFileSync(sidecar, join(claudeHome, '.claude', 'handover-frozen.json')); } catch { /* best effort */ }

// Cold-tax facts come from the SAME single scan render-spikes uses (getScannedLegs + testColdLeg), NOT the
// persisted incremental nColdLegs — that accumulator lags a full re-scan after any mid-session cold-logic
// change. Full-scanning here makes the fact sheet and the panel agree by construction. The PROSPECTIVE cold
// fields (stake/band/clock) still come from the sidecar below.
const scanLegs = getScannedLegs(s.transcriptPath);
const coldLegs = scanLegs.filter(testColdLeg);
const nColdScan = coldLegs.length;
const coldWastedUsdScan = (nColdScan > 0 && s.base != null)
  ? mathRoundD(coldLegs.reduce((a, l) => a + (l.cwUnits - l.cw * M_CACHE_READ), 0) * Number(s.base), 2)
  : 0;
const lastColdLegsAgoScan = nColdScan > 0 ? scanLegs.length - Number(coldLegs[coldLegs.length - 1].idx) : null;

// ---- TUNABLES (recalibrate here) ----
const COST_FLOOR_FINE = 0.28;   // next-leg $ below this → cost verdict is FINE regardless of froz5
const COST_FLOOR_STEEP = 0.45;  // between FINE and this, cost can read "climbing" at most — never "expensive"
const FROZ5_CLIMB = 1.8;        // froz5 trend bands (aligned to the Froz5RGB gradient anchors)
const FROZ5_STEEP = 2.8;
const WINDOW_1M = 700000;       // windowSize at/above this is the 1M regime (token-count leads quality)
// froz5 CAUSE resolver — residual vs the empirical context→froz5 curve (1M regime).
const FROZ5_CURVE = [{ k: 124, r: 0.7 }, { k: 252, r: 1.4 }, { k: 401, r: 2.3 }, { k: 555, r: 2.9 }, { k: 800, r: 3.9 }];
const FROZ5_RESID_HEAVY = 0.70; // residual below → heavy/resumed start
const FROZ5_RESID_LIGHT = 1.40; // residual above → light start
const FROZ5_CURVE_MINK = 124;   // below this ctxK the curve extrapolates → confidence=low

// ---- number formatters (backticks ON — these fragments are FINAL; downstream must not reformat) ----
function FmtUsd(v) { if (v == null) return `${BT}$?${BT}`; const d = Number(v); if (d >= 0 && d < 0.005) return `${BT}<$0.01${BT}`; return `${BT}$` + fmtN(d, 2) + BT; }
function FmtK(t) { if (t == null) return `${BT}?${BT}`; return BT + psRound(Number(t) / 1000) + 'k' + BT; }
function FmtPct(v) { if (v == null) return `${BT}?${BT}`; return BT + psRound(Number(v)) + '%' + BT; }
function FmtRatio(v) { if (v == null) return `${BT}?${BT}`; return BT + fmtN(Number(v), 2) + TIMES + BT; }
function FmtMin(sec) { if (sec == null) return '~?'; return '~' + BT + psRound(Number(sec) / 60) + ' min' + BT; }

// Empirical context→froz5 curve: the typical ratio at a given depth (ctxK = ctxTokens/1000),
// piecewise-linear through FROZ5_CURVE with linear extrapolation off both ends (floored).
function Froz5Expected(ctxK) {
  const c = FROZ5_CURVE;
  let a, b;
  if (ctxK <= c[0].k) { a = c[0]; b = c[1]; }
  else if (ctxK >= c[c.length - 1].k) { a = c[c.length - 2]; b = c[c.length - 1]; }
  else {
    a = c[0]; b = c[1];
    for (let i = 0; i < c.length - 1; i++) { if (ctxK >= c[i].k && ctxK <= c[i + 1].k) { a = c[i]; b = c[i + 1]; break; } }
  }
  const slope = (b.r - a.r) / (b.k - a.k);
  return Math.max(0.15, a.r + slope * (ctxK - a.k));
}

// ---- IDENTITY + staleness ----
const now = nowEpoch();
const ageSec = s.renderedAt != null ? psRound(now - Number(s.renderedAt)) : null;
let ageF;
if (ageSec == null) ageF = 'age unknown';
else if (ageSec < 60) ageF = `${ageSec}s`;
else if (ageSec < 3600) ageF = `${psRound(ageSec / 60)}m${String(ageSec % 60).padStart(2, '0')}s`;
else if (ageSec < 86400) ageF = `${psRound(ageSec / 3600)}h${String(psRound((ageSec % 3600) / 60)).padStart(2, '0')}m`;
else ageF = `${psRound(ageSec / 86400)}d${String(psRound((ageSec % 86400) / 3600)).padStart(2, '0')}h`;
const stale = (ageSec != null && ageSec > 180);
const sid8 = s.sessionId ? String(s.sessionId).slice(0, Math.min(8, String(s.sessionId).length)) : '????????';
const repo = s.gitRepo ? s.gitRepo : '(no repo)';
let identity = `**Reading** ${BT}${repo}${BT} ${MID} ${BT}${sid8}${BT} ${MID} ${s.model} ${MID} ${FmtK(s.ctxTokens)} ctx ${MID} rendered ${BT}${ageF}${BT} ago`;
if (stale) identity += ` ${BT}${WARN} snapshot looks stale${BT}`;

// ---- HEADLINE (cost+quality only; cold never touches it). FIXED cost rule: froz5 trend gated by $/leg. ----
const absState = String(s.ctxAbsState);
const rotLevel = ({ pristine: 0, green: 0, yellow: 1, orange: 2, red: 3 })[absState] ?? 0;
const fillLevel = s.fillPct == null ? 0 : (Number(s.fillPct) < 50 ? 0 : (Number(s.fillPct) < 70 ? 2 : 3));
const qLevel = Math.max(rotLevel, fillLevel);
const qWord = ({
  pristine: 'sharp', green: 'sharp',
  yellow: 'mild weakening on hard multi-fact recall',
  orange: 'real degradation on complex full-context reasoning',
  red: 'heavy degradation',
})[absState] ?? 'sharp';
const froz5 = s.froz5Ratio != null ? Number(s.froz5Ratio) : null;
const nextUsd = s.nextLegUsd != null ? Number(s.nextLegUsd) : null;
const trend = froz5 == null ? 0 : (froz5 < FROZ5_CLIMB ? 0 : (froz5 < FROZ5_STEEP ? 1 : 2));
const cLevelRaw = (nextUsd == null || nextUsd < COST_FLOOR_FINE) ? 0
  : (nextUsd < COST_FLOOR_STEEP ? Math.min(1, trend) : trend);
const cLevel = ({ 0: 0, 1: 2 })[cLevelRaw] ?? 3;
const hLevel = Math.max(qLevel, cLevel);
const hText = ['Plenty of room', 'Getting deeper', 'Wind down soon', 'Time to hand over'][hLevel];
const hPol = hLevel <= 1 ? '+' : '-';
const hDriver = cLevel > qLevel ? 'cost' : (qLevel > cLevel ? 'quality' : 'both');

// ---- COST ----
const is1M = (Number(s.windowSize) >= WINDOW_1M);
const costLead = 'each leg ~' + FmtUsd(nextUsd) + ', ' + FmtRatio(froz5) + ' a fresh leg';
const costTotal = FmtUsd(s.costUsd) + ' total';
const ctxK = s.ctxTokens != null ? Number(s.ctxTokens) / 1000 : null;
const coldInMedian = (lastColdLegsAgoScan != null && Number(lastColdLegsAgoScan) < 5);
let froz5Cause = 'unknown', froz5Resid = null, froz5Exp = null, froz5Conf = 'low';
if (froz5 != null && ctxK != null && is1M) {
  froz5Exp = Froz5Expected(ctxK);
  froz5Resid = froz5 / froz5Exp;
  froz5Conf = ctxK < FROZ5_CURVE_MINK ? 'low' : 'ok';
  froz5Cause = froz5Resid < FROZ5_RESID_HEAVY ? 'heavy-start'
    : (froz5Resid <= FROZ5_RESID_LIGHT ? 'on-curve'
      : (coldInMedian ? 'cold-pumped' : 'light-start'));
}
let costChar;
switch (froz5Cause) {
  case 'heavy-start': costChar = 'started heavy — a big opening leg (often a resume that front-loads reads) lifts the fresh-leg baseline, so the ratio sits low for this depth; cost is flat-to-falling, not escalating — the absolute next-leg $ is the number to trust'; break;
  case 'light-start': costChar = 'started cheap — a light opening leg makes even modest context growth read as a high multiple; the ratio overstates escalation, so the absolute next-leg $ is the grounding number'; break;
  case 'cold-pumped': costChar = 'a recent cold re-cache is pumping the next-leg forecast, so the multiple overstates steady-state escalation — it subsides as the cold leg ages out (see the cold line)'; break;
  case 'on-curve': costChar = 'tracking the normal cost-vs-depth curve — neither a heavy/light start nor a cold leg is distorting the ratio'; break;
  default:
    if (froz5 == null) costChar = 'no cost trend yet';
    else if (froz5 < 1.0) costChar = 'sub-1 — caching is winning; the next leg is cheaper than a cold early leg';
    else if (froz5 < FROZ5_CLIMB) costChar = 'roughly breaking even with a fresh early leg';
    else if (froz5 < FROZ5_STEEP) costChar = 'climbing — context cost is outgrowing the early baseline';
    else costChar = 'steep — context cost is well above the early baseline';
}
let costDetail = '(none)';
if (Number(s.nAgents) > 0 && s.mainSessionUsd != null) {
  costDetail = 'main ' + FmtUsd(s.mainSessionUsd) + ` ${MID} agents ` + FmtUsd(s.agentsUsd) + ' over ' + BT + Math.trunc(Number(s.agentLegs)) + BT + ' legs';
}

// ---- COLD ----
const ttlName = Number(s.coldTtlSec) === 3600 ? '~1-hour cache' : (Number(s.coldTtlSec) === 300 ? '5-minute cache' : '5-minute cache (assumed)');
const warm = FmtMin(s.coldCoolRemainSec);
const stake = FmtUsd(s.coldStakeUsd);
let coldOut = '(omit)';
switch (String(s.coldBand)) {
  case 'calm': if (s.coldStakeUsd != null) coldOut = 'calm — idling past the cache lifetime would add ' + stake + ' to resume; no urgency'; break;
  case 'heads-up': coldOut = 'the ' + ttlName + ' is starting to cool (' + warm + ' of warmth left) — a send keeps it warm'; break;
  case 'act-soon': coldOut = 'send within ' + warm + ' to keep the ' + ttlName + ' warm; let it cool and resuming adds a one-time ' + stake; break;
  case 'urgent': coldOut = 'the ' + ttlName + ' is about to expire (' + warm + ' left) — a send now keeps it warm; otherwise your next resume adds a one-time ' + stake; break;
  case 'expired':
    coldOut = String(s.coldState) === 'cold'
      ? 'your recent resume re-cached the context for ' + stake + ' — already paid; you are warm again now'
      : 'the cache has likely gone cold; your next send rebuilds it for a one-time ' + stake;
    break;
}
if (nColdScan >= 1) {
  const tax = 'cold tax so far: ' + FmtUsd(coldWastedUsdScan) + ' over ' + BT + nColdScan + BT + ' leg(s)';
  coldOut = coldOut === '(omit)' ? tax : coldOut + '; ' + tax;
}

// ---- QUALITY (1M → token-count leads; 200k → fill leads) ----
let fillBand = '';
if (s.fillPct != null) {
  const f = Number(s.fillPct);
  fillBand = f < 50 ? ' fill — well under the ~60% cliff'
    : f < 60 ? ' fill — approaching the ~60% cliff'
      : f < 70 ? ' fill — at/just past the ~60% cliff'
        : f < 85 ? ' fill — well past the ~60% cliff'
          : ' fill — near the auto-compact wall';
}
const tokSig = FmtK(s.ctxTokens) + ', ' + absState + ' band' + (qWord ? ' — ' + qWord : '');
const fillSig = FmtPct(s.fillPct) + fillBand;
const qLead = is1M ? tokSig : fillSig;
const qSecondary = is1M ? fillSig : tokSig;
const qHeadroom = FmtK(s.toCompact) + ' to compact';

// ---- ACTIVITY (omit when sub-agents ran — activity% is agent-polluted) ----
let act;
if (Number(s.nAgents) > 0) act = '(omit — ' + Math.trunc(Number(s.nAgents)) + ' sub-agents ran; activity% folds their parallel compute, so it does not signal your work pattern)';
else if (s.activityPct != null) act = 'the model was generating ' + FmtPct(s.activityPct) + ' of the elapsed wall-clock (this times LLM generation only) — the rest is tool calls and your read/think time in unknown proportion';
else act = '(omit)';

// ---- TRAJECTORY (shape + range from legCosts) ----
const lc = (s.legCosts || []).map(Number);
const trajRange = lc.length > 0 ? FmtUsd(Math.min(...lc)) + NDASH + FmtUsd(Math.max(...lc)) : `${BT}?${BT}`;
let trajShape = 'flat';
if (lc.length >= 3) {
  const third = Math.max(1, psRound(lc.length / 3));
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const firstAvg = avg(lc.slice(0, third));
  const lastAvg = avg(lc.slice(lc.length - third));
  const sorted = [...lc].sort((a, b) => a - b);
  const med = sorted[psRound(sorted.length / 2)];
  const max = Math.max(...lc);
  const climbing = (firstAvg > 0 && lastAvg > firstAvg * 1.3);
  const spiky = (med > 0 && max > med * 2.5);
  trajShape = climbing && spiky ? 'climbing, with spikes' : (climbing ? 'climbing' : (spiky ? 'mostly flat with spikes' : 'flat'));
}

// ---- YOUR CALL (polarity deterministic from the headline) ----
const ycPol = hPol;
let ycBasis;
if (hLevel === 0) ycBasis = 'both axes fine — room to continue on recent context';
else if (hLevel === 1) ycBasis = 'getting deeper but still fine — recent work stays sharp; only reaching back for details buried deep in old context softens, so hand over / /clear only if that is next';
else if (hDriver === 'cost') ycBasis = 'cost is the pressure — hand over / /clear if cost matters; a few more legs are fine on recent context';
else if (hDriver === 'quality') ycBasis = 'quality is the pressure (deep-history recall) — hand over / /clear if you need reliable old-context recall; fine to continue on recent work';
else ycBasis = 'both cost and quality are climbing — lean toward handing over';

// ---- emit the fact sheet ----
emit(`IDENTITY: ${identity}`);
emit(`STALE: ${stale ? 'yes — tell the user to press Enter on an empty prompt in the session they mean, then re-run' : 'no'}`);
emit(`HEADLINE_DIFF: ${hPol} ${hText}`);
emit(`HEADLINE_BASIS: driver=${hDriver}; quality=${absState} (lvl ${qLevel}); cost=froz5 ${froz5} / next ${nextUsd} (lvl ${cLevel})`);
emit(`COST_LEAD: ${costLead}`);
emit(`COST_TOTAL: ${costTotal}`);
emit(`COST_CHAR: ${costChar}`);
emit(`COST_FROZ5: cause=${froz5Cause}` + (froz5Resid != null ? '; froz5 ' + FmtRatio(froz5) + ' vs ' + FmtRatio(froz5Exp) + ' typical at this depth (residual ' + fmtN(froz5Resid, 2) + TIMES + `); confidence=${froz5Conf}` : ' (curve n/a — 200k window or missing data)'));
emit(`COST_DETAIL: ${costDetail}`);
emit(`COLD: ${coldOut}`);
emit(`QUALITY_LEAD: ${qLead}`);
emit(`QUALITY_SECONDARY: ${qSecondary}`);
emit(`QUALITY_HEADROOM: ${qHeadroom}`);
emit('QUALITY_CAVEAT: stays sharp on recent work; only digging up details buried deep in a long history gets unreliable');
emit(`ACTIVITY: ${act}`);
emit(`TRAJECTORY: ${trajShape}, range ${trajRange}`);
emit(`YOURCALL_POLARITY: ${ycPol}`);
emit(`YOURCALL_BASIS: ${ycBasis}`);

// Move every approximate-tilde INSIDE the adjacent code span. A bare "~`" breaks the terminal's markdown
// parser (swallows the opening backtick, shifting the span pairing). "`~" renders identically but parses
// cleanly. (See reference: the ~backtick markdown bug.)
let out = lines.join('\n').split('~' + BT).join(BT + '~');
process.stdout.write(out);
process.exit(0);
