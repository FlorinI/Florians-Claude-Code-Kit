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
import { resolveSidecarPath, resolveConfigHome } from './sidecar-path.mjs';
import { getScannedLegs, testColdLeg, testWarmRewriteLeg, ModelTier, tierWeight, M_CACHE_READ, FRESH_N } from './leg-driver.mjs';
import { psRound, fmtN, mathRoundD, nowEpoch } from './_sl-compat.mjs';
import { sanitizeSessionName } from './sanitize-name.mjs';

const BT = '`';          // literal backtick → inline-code spans render light-blue in the assistant message
const MID = '·';    // ·
const TIMES = '×';  // ×
const NDASH = '–';  // –
const WARN = '⚠';   // ⚠

const configHome = resolveConfigHome();
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
// Each side is named in words when a name is known (the id fragment stays in brackets so it still
// cross-references `from session <hex>` stamps and tab titles), id fragment alone otherwise. The
// snapshot's name was persisted in the sidecar at write time; THIS session's name comes from the
// per-session stats file the status line writes (a session that never rendered one → id only).
const sessionLabel = (name, sid8) => name ? `${name} [${sid8}]` : sid8;
// Every name read from a file goes through the SHARED sanitizer (sanitize-name.mjs — the status line
// runs the same function on write), so the single-line, control-free, capped invariant holds however
// the file was written: by another tool, by a hand edit, or by a lagging machine's build.
function readOwnSessionName(sid) {
  const projRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (const dir of [join(projRoot, '.claude', 'statusline-stats'), join(configHome, 'statusline-stats')]) {
    let name = null;
    // try wraps ONE candidate's read+parse only: a corrupt or truncated project-local file must fall
    // through to the config-home file, never abort the search.
    try {
      const p = join(dir, sid + '.json');
      if (!existsSync(p)) continue;
      name = sanitizeSessionName(JSON.parse(readFileSync(p, 'utf8'))?.sessionName);
    } catch { continue; }
    if (name) return name;
  }
  return null;
}
const mySid = process.env.CLAUDE_CODE_SESSION_ID;
if (mySid && s.sessionId && String(mySid) !== String(s.sessionId)) {
  const snapSid8 = String(s.sessionId).slice(0, Math.min(8, String(s.sessionId).length));
  const mySid8 = String(mySid).slice(0, Math.min(8, String(mySid).length));
  const myName = readOwnSessionName(String(mySid));
  const snapName = sanitizeSessionName(s.sessionName);
  process.stdout.write(`FOREIGN\nthis session: ${sessionLabel(myName, mySid8)}\nsnapshot belongs to: ${sessionLabel(snapName, snapSid8)} (${s.gitRepo ? s.gitRepo : '(no repo)'})`);
  process.exit(0);
}

// Freeze the EXACT snapshot this run used → render-legspark/render-spikes (--frozen) read THIS file, so all
// three renderers see the SAME session even if a concurrent same-project session clobbers the live sidecar
// between reads. Best-effort; a freeze failure just falls them back to the live sidecar.
try { copyFileSync(sidecar, join(configHome, 'handover-frozen.json')); } catch { /* best effort */ }

// Cold-tax facts come from the SAME single scan render-spikes uses (getScannedLegs + testColdLeg), NOT the
// persisted incremental nColdLegs — that accumulator lags a full re-scan after any mid-session cold-logic
// change. Full-scanning here makes the fact sheet and the panel agree by construction. The PROSPECTIVE cold
// fields (stake/band/clock) still come from the sidecar below.
const scanLegs = getScannedLegs(s.transcriptPath);
const coldLegs = scanLegs.filter(testColdLeg);
const nColdScan = coldLegs.length;
// Each leg's avoidable units are tier-weighted (tierWeight vs the main tier — the status line's own
// per-leg weight), so a cold leg paid under another tier carries that tier's price, not the main's.
const mainTierScan = ModelTier(s.model);
const avoidableEff = (l) => (l.cwUnits - l.cw * M_CACHE_READ) * tierWeight(l.model, mainTierScan);
const coldWastedUsdScan = (nColdScan > 0 && s.base != null)
  ? mathRoundD(coldLegs.reduce((a, l) => a + avoidableEff(l), 0) * Number(s.base), 2)
  : 0;
const lastColdLegsAgoScan = nColdScan > 0 ? scanLegs.length - Number(coldLegs[coldLegs.length - 1].idx) : null;

// Warm-rewrite tax — the same avoidable-premium formula the cold tax uses ((cwUnits − cw×0.10) × base,
// per-leg site: render-spikes.mjs), summed over genuine warm-rewrite legs ONLY. The partition comes
// from the classifier (testWarmRewriteLeg, leg-driver.mjs — getDriver's class order: cold first, then
// compacted, then bigRewrite; opening leg excluded), so a big cache write is billed into exactly one
// of {cold tax, compacted, warm-rewrite tax} and the spikes label always agrees with the money.
// Raw signal, no smoothing/caps. CC adopted cache-preserving mid-conversation injection, then
// rolled it back on Sonnet 5 in 2.1.201 — so the tax is EXPECTED on Sonnet 5, informational on
// older Sonnet generations (which never had the injection), and notable on every other model
// (the per-model gloss at the emit site resolves which, keyed on the display string's generation).
const warmRewriteLegs = scanLegs.filter(testWarmRewriteLeg);
const nWarmScan = warmRewriteLegs.length;
const warmTaxUsdScan = (nWarmScan > 0 && s.base != null)
  ? mathRoundD(warmRewriteLegs.reduce((a, l) => a + avoidableEff(l), 0) * Number(s.base), 2)
  : 0;

// ---- TUNABLES (recalibrate here) ----
const COST_FLOOR_FINE = 0.28;   // next-leg $ below this → cost verdict is FINE regardless of froz5
const COST_FLOOR_STEEP = 0.45;  // between FINE and this, cost can read "climbing" at most — never "expensive"
// froz5 curve, anchors and residual thresholds are COPIES of tools/calibration/froz5-fit.json (the
// fit artifact `tools/calibration/harvest-froz5.mjs` writes from the fleet's post-CC-2.1.209
// cold-start sessions, era v5 — see docs/froz5-calibration-samples.md "Fit"). Re-run the harvest
// and copy the numbers here + into statusline.mjs's Froz5RGB / froz5State together; a fit-sync
// test pins the copies. FROZ5_CLIMB = anchors.yellow (= curve at 256k), FROZ5_STEEP = anchors.orange
// (curve at 500k); FROZ5_CURVE_MINK = the first knot's k.
const FROZ5_CLIMB = 2.3;        // froz5 trend bands (aligned to the Froz5RGB gradient anchors)
const FROZ5_STEEP = 4.2;
const WINDOW_1M = 700000;       // windowSize at/above this is the 1M regime (token-count leads quality)
// froz5 CAUSE resolver — residual vs the empirical context→froz5 curve (1M regime).
const FROZ5_CURVE = [{ k: 50, r: 1.38 }, { k: 150, r: 1.68 }, { k: 250, r: 2.27 }, { k: 350, r: 3.22 }, { k: 450, r: 3.72 }, { k: 550, r: 4.6 }, { k: 650, r: 5.72 }];
const FROZ5_RESID_HEAVY = 0.70; // residual below → heavy start (p25 of the fit's residuals)
const FROZ5_RESID_LIGHT = 1.30; // residual above → light start (p75)
const FROZ5_CURVE_MINK = 50;   // below this ctxK the curve extrapolates → confidence=low

// ---- number formatters (backticks ON — these fragments are FINAL; downstream must not reformat) ----
function FmtUsd(v) { if (v == null) return `${BT}$?${BT}`; const d = Number(v); if (d >= 0 && d < 0.005) return `${BT}<$0.01${BT}`; return `${BT}$` + fmtN(d, 2) + BT; }
function FmtK(t) { if (t == null) return `${BT}?${BT}`; return BT + psRound(Number(t) / 1000) + 'k' + BT; }
function FmtPct(v) { if (v == null) return `${BT}?${BT}`; return BT + psRound(Number(v)) + '%' + BT; }
function FmtRatio(v) { if (v == null) return `${BT}?${BT}`; return BT + fmtN(Number(v), 2) + TIMES + BT; }
function FmtMin(sec) { if (sec == null) return '~?'; return '~' + BT + psRound(Number(sec) / 60) + ' min' + BT; }

// True median — even count → mean of the middle two (same semantics as statusline.mjs's Median()).
// The old psRound(length/2) index picked an upper-middle-ish element (with banker's rounding it even
// landed on the MAX for 3 legs), which skewed the `spiky` trajectory verdict.
function median(arr) {
  const vals = arr.filter((x) => x !== null && x !== undefined).map(Number).sort((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return 0.0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2.0;
}

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
// Session name (sidecar `sessionName`, present only when the payload carried one) sits between the
// repo and the id fragment; absent → the line is unchanged.
const sidecarName = sanitizeSessionName(s.sessionName);
const nameSpan = sidecarName ? `${BT}${sidecarName}${BT} ${MID} ` : '';
let identity = `**Reading** ${BT}${repo}${BT} ${MID} ${nameSpan}${BT}${sid8}${BT} ${MID} ${s.model} ${MID} ${FmtK(s.ctxTokens)} ctx ${MID} rendered ${BT}${ageF}${BT} ago`;
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

// Resolve the froz5 CAUSE up-front (reused verbatim by the COST section below) so the HEADLINE can
// neutralize a ratio that's a resolved artifact: a light/heavy-start-inflated or cold-pumped froz5 must
// NOT read as real cost pressure, or the one-line verdict contradicts the cost paragraph that calls it
// benign. A non-artifact (on-curve/unknown) ratio still drives the trend rule unchanged.
const is1M = (Number(s.windowSize) >= WINDOW_1M);
const ctxK = s.ctxTokens != null ? Number(s.ctxTokens) / 1000 : null;
// Warm-open marker (sidecar `froz5CalibStale`, behaviour-gated by the status line): the session's
// leg 1 read a shared prefix from cache — the pre-CC-2.1.209 opener, or a sibling-warmed launch — so
// its pristine floor is smaller than the post-2.1.209 cold-start sessions the curve was fit on and
// the ratio can read a little ABOVE the curve → confidence drops to low, the cause stays indicative.
const froz5Stale = s.froz5CalibStale === true;
// Baseline provisional: fewer than FRESH_N warm legs found so far (window still open).
const freshLegN = s.freshLegN != null ? Number(s.freshLegN) : null;
const froz5Provisional = (freshLegN != null && freshLegN > 0 && freshLegN < FRESH_N);
const coldInMedian = (lastColdLegsAgoScan != null && Number(lastColdLegsAgoScan) < 5);
const sessionTier = ModelTier(s.model);
// The fifth cause is GATED (bsl5.0.7.0): it preempts the other four only when the baseline is not at
// full strength. The baseline is tier-free, so a mid-session tier switch no longer invalidates it —
// both sides of the ratio are this session's own token-work at one price, and the depth curve still
// applies. What the switch does invalidate is comparing per-leg DOLLARS across it, which is a caveat
// (a COST_RUN_NOTE below), not a reason to disown the ratio. With a weak or absent anchor there is no
// depth reading worth defending, so the switch still leads — as it did before.
const froz5AnchorWeak = (freshLegN == null || freshLegN < FRESH_N);
let froz5Cause = 'unknown', froz5Resid = null, froz5Exp = null, froz5Conf = 'low';
if (s.modelSwitch && froz5AnchorWeak) {
  froz5Cause = 'model-switched';
} else if (froz5 != null && ctxK != null && is1M) {
  froz5Exp = Froz5Expected(ctxK);
  froz5Resid = froz5 / froz5Exp;
  // Warm-open marker, an extrapolated curve, or a provisional baseline → confidence=low.
  froz5Conf = (froz5Stale || ctxK < FROZ5_CURVE_MINK || froz5Provisional) ? 'low' : 'ok';
  froz5Cause = froz5Resid < FROZ5_RESID_HEAVY ? 'heavy-start'
    : (froz5Resid <= FROZ5_RESID_LIGHT ? 'on-curve'
      : (coldInMedian ? 'cold-pumped' : 'light-start'));
}
const benignFroz5 = (froz5Cause === 'light-start' || froz5Cause === 'heavy-start' || froz5Cause === 'cold-pumped');
const trend = froz5 == null ? 0 : (froz5 < FROZ5_CLIMB ? 0 : (froz5 < FROZ5_STEEP ? 1 : 2));
// Resolved artifact → grade cost on the ABSOLUTE next-leg $ alone (COST_CHAR's "grounding number"),
// so the headline can't false-elevate on an inflated ratio; only a non-artifact ratio may escalate.
let cLevelRaw;
if (nextUsd == null || nextUsd < COST_FLOOR_FINE) cLevelRaw = 0;
else if (benignFroz5) cLevelRaw = (nextUsd < COST_FLOOR_STEEP ? 0 : 1);
else cLevelRaw = (nextUsd < COST_FLOOR_STEEP ? Math.min(1, trend) : trend);
const cLevel = ({ 0: 0, 1: 2 })[cLevelRaw] ?? 3;
const hLevel = Math.max(qLevel, cLevel);
const hPol = hLevel <= 1 ? '+' : '-';
const hDriver = cLevel > qLevel ? 'cost' : (qLevel > cLevel ? 'quality' : 'both');

// Agent-spend prominence, proportional to share of session cost (denominator matches the status line's
// agentsUsd/sessionCost): <1/3 = minor aside only (COST_DETAIL) · 1/3–1/2 = a headline tail · ≥1/2 = leads Cost.
const sessionCostVal = Number(s.costUsd);
const agentShare = (Number(s.nAgents) > 0 && s.agentsUsd != null && sessionCostVal > 0) ? Number(s.agentsUsd) / sessionCostVal : null;
const agentPct = agentShare != null ? psRound(agentShare * 100) : null;
const agentTier = agentShare == null ? 'none' : (agentShare >= 0.5 ? 'lead' : (agentShare >= (1 / 3) ? 'headline' : 'minor'));
let hText = ['Plenty of room', 'Getting deeper', 'Wind down soon', 'Time to hand over'][hLevel];
// ⅓–½ tails the headline; ≥½ gets BOTH the headline tail AND the Cost-section lead (below).
if (agentTier === 'headline' || agentTier === 'lead') hText += ` ${MID} sub-agents are ${agentPct}% of spend`;

// ---- COST (is1M / ctxK / the froz5 cause are all resolved above, before the headline) ----
const costLead = 'each leg ~' + FmtUsd(nextUsd) + ', ' + FmtRatio(froz5) + ' a fresh leg';
const costTotal = FmtUsd(s.costUsd) + ' total';
let costChar;
switch (froz5Cause) {
  case 'model-switched': costChar = 'the model switched mid-session (' + String(s.modelSwitch.from) + ' → ' + String(s.modelSwitch.to) + ' at leg ' + Math.trunc(Number(s.modelSwitch.atLeg)) + ') — legs before and after are priced on different models, so the ratio and the depth curve do not apply; the absolute next-leg $ is the number to trust'; break;
  case 'heavy-start': costChar = 'started heavy — the early warm legs were expensive (big outputs, or a doc-heavy opening that fell back to write-heavy legs), lifting the fresh-leg baseline, so the ratio sits low for this depth; cost is flat-to-falling, not escalating — the absolute next-leg $ is the number to trust'; break;
  case 'light-start': costChar = 'started cheap — the early warm legs were unusually light, so even modest context growth reads as a high multiple; the ratio overstates escalation, so the absolute next-leg $ is the grounding number'; break;
  case 'cold-pumped': costChar = 'a recent cold re-cache is pumping the next-leg forecast, so the multiple overstates steady-state escalation — it subsides as the cold leg ages out (see the cold line)'; break;
  case 'on-curve': costChar = 'tracking the normal cost-vs-depth curve — neither a heavy/light start nor a cold leg is distorting the ratio'; break;
  default:
    if (froz5 == null) costChar = 'no cost trend yet';
    else if (froz5 < 1.0) costChar = 'sub-1 — the next leg is cheaper than the session\'s early warm legs; context has not outgrown them';
    else if (froz5 < FROZ5_CLIMB) costChar = 'roughly breaking even with a fresh early leg';
    else if (froz5 < FROZ5_STEEP) costChar = 'climbing — context cost is outgrowing the early baseline';
    else costChar = 'steep — context cost is well above the early baseline';
}
// Warm-open marker: residual-derived causes get the corrected-direction caveat (the curve is fit on
// post-2.1.209 cold-start sessions; a warm-open session's smaller pristine floor reads a little
// ABOVE it, so a light-start call is the one to hold loosely); model-switched (preempts the
// resolver) and the no-curve default branch stay untouched.
if (froz5Stale && (froz5Cause === 'heavy-start' || froz5Cause === 'light-start' || froz5Cause === 'cold-pumped' || froz5Cause === 'on-curve')) {
  costChar += ' — low confidence: this session opened on a warm shared prefix (pre-2.1.209 regime, or a sibling-warmed launch), so its pristine floor is smaller than the post-2.1.209 curve\'s and the ratio can read a little above the curve; treat a light-start call as indicative; the absolute next-leg $ is still real';
}
let costDetail = '(none)';
if (Number(s.nAgents) > 0 && s.mainSessionUsd != null) {
  costDetail = 'main ' + FmtUsd(s.mainSessionUsd) + ` ${MID} agents ` + FmtUsd(s.agentsUsd) + ' over ' + BT + Math.trunc(Number(s.agentLegs)) + BT + ' legs';
}
// ≥1/2 of spend is sub-agents → a lead fragment the composer OPENS the Cost section with (agents ARE the story).
let costAgentsLead = '(none)';
if (agentTier === 'lead') {
  costAgentsLead = 'most of the spend is sub-agents — ' + FmtUsd(s.agentsUsd) + ' of ' + FmtUsd(sessionCostVal)
    + ' (' + BT + agentPct + '%' + BT + ') across ' + BT + Math.trunc(Number(s.agentLegs)) + BT + ' legs from '
    + BT + Math.trunc(Number(s.nAgents)) + BT + ' agents';
}

// ---- COLD ----
const ttlName = Number(s.coldTtlSec) === 3600 ? '~1-hour cache' : (Number(s.coldTtlSec) === 300 ? '5-minute cache' : '5-minute cache (assumed)');
const warm = FmtMin(s.coldCoolRemainSec);
const stake = FmtUsd(s.coldStakeUsd);
// Keep-warm alternative for the act-soon/urgent branches: a `max_tokens: 0` API ping re-warms the
// still-warm cache at cache-READ price — base × ctx × 0.10 (TTL-independent), vs the rebuild stake.
const keepWarmUsd = (s.base != null && s.ctxTokens != null) ? Number(s.base) * Number(s.ctxTokens) * M_CACHE_READ : null;
const keepWarmClause = keepWarmUsd != null
  ? ' (a ' + FmtUsd(keepWarmUsd) + ' keep-warm API refresh — max_tokens:0 — buys the same warmth without a real send)'
  : '';
let coldOut = '(omit)';
switch (String(s.coldBand)) {
  case 'calm': if (s.coldStakeUsd != null) coldOut = 'calm — idling past the cache lifetime would add ' + stake + ' to resume; no urgency'; break;
  case 'heads-up': coldOut = 'the ' + ttlName + ' is starting to cool (' + warm + ' of warmth left) — a send keeps it warm'; break;
  case 'act-soon': coldOut = 'send within ' + warm + ' to keep the ' + ttlName + ' warm; let it cool and resuming adds a one-time ' + stake + keepWarmClause; break;
  case 'urgent': coldOut = 'the ' + ttlName + ' is about to expire (' + warm + ' left) — a send now keeps it warm; otherwise your next resume adds a one-time ' + stake + keepWarmClause; break;
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
  // The ≥85% band names the wall it is near — but with auto-compact off there IS no wall, and saying
  // so here contradicted QUALITY_HEADROOM two lines down ("no compaction will fire"). The fact sheet
  // never hands the composer a contradiction to smooth over. Cliff semantics below 85% are unchanged:
  // the ~60% cliff is a quality effect of context depth, not a compaction artifact.
  const topBand = s.autoCompactOff === true
    ? ' fill — near the raw window limit'
    : ' fill — near the auto-compact wall';
  fillBand = f < 50 ? ' fill — well under the ~60% cliff'
    : f < 60 ? ' fill — approaching the ~60% cliff'
      : f < 70 ? ' fill — at/just past the ~60% cliff'
        : f < 85 ? ' fill — well past the ~60% cliff'
          : topBand;
}
const tokSig = FmtK(s.ctxTokens) + ', ' + absState + ' band' + (qWord ? ' — ' + qWord : '');
const fillSig = FmtPct(s.fillPct) + fillBand;
const qLead = is1M ? tokSig : fillSig;
const qSecondary = is1M ? fillSig : tokSig;
// Auto-compact off → never say "N to compact": compaction will not fire. (toCompact is null then.)
const qHeadroom = s.autoCompactOff === true
  ? 'auto-compact is off — no compaction will fire; the session runs to the raw window (manage context by hand)'
  : FmtK(s.toCompact) + ' to compact';

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
  const midSlice = lc.slice(third, lc.length - third);
  const midAvg = midSlice.length ? avg(midSlice) : (firstAvg + lastAvg) / 2;
  const med = median(lc);
  const max = Math.max(...lc);
  const climbing = (firstAvg > 0 && lastAvg > firstAvg * 1.3);
  const spiky = (med > 0 && max > med * 2.5);
  // Whole-session ARC vs the RECENT direction. A heavy-start / mid-peak session can climb OVERALL yet be
  // flat-to-down lately; a bare "climbing" then contradicts a "flat-to-falling" Cost read (COST_CHAR). If
  // the recent tail has come well off the session's peak stretch, say so instead of "climbing".
  const peakSeg = Math.max(firstAvg, midAvg, lastAvg);
  const recentOffPeak = (peakSeg > 0 && lastAvg < peakSeg * 0.85);
  const base = (climbing && recentOffPeak) ? 'climbed earlier, flat-to-down recently'
    : (climbing ? 'climbing' : 'flat');
  trajShape = spiky ? (base === 'flat' ? 'mostly flat with spikes' : base + ', with spikes') : base;
}

// ---- YOUR CALL (polarity deterministic from the headline) ----
const ycPol = hPol;
let ycBasis;
if (hLevel === 0) ycBasis = 'both axes fine — room to continue on recent context';
else if (hLevel === 1) ycBasis = 'getting deeper but still fine — recent work stays sharp; only reaching back for details buried deep in old context softens, so hand over / /clear only if that is next';
else if (hDriver === 'cost') ycBasis = 'cost is the pressure — hand over / /clear if cost matters; a few more legs are fine on recent context';
else if (hDriver === 'quality') ycBasis = 'quality is the pressure (deep-history recall) — hand over / /clear if you need reliable old-context recall; fine to continue on recent work';
// hDriver === 'both'. Only call cost "climbing" when the ratio itself is trending up; a benign
// (heavy/light-start, cold-pumped) ratio elevated cost via the absolute-$ floor — per-leg is HIGH but
// FLAT, and saying "climbing" would contradict COST_CHAR's "flat-to-falling".
else if (benignFroz5 || trend === 0) ycBasis = 'quality is in the degradation band and each leg is already pricey — cost is high but flat, not climbing — lean toward handing over';
else ycBasis = 'both cost and quality are climbing — lean toward handing over';

// ---- emit the fact sheet ----
emit(`IDENTITY: ${identity}`);
emit(`STALE: ${stale ? 'yes — tell the user to press Enter on an empty prompt in the session they mean, then re-run' : 'no'}`);
emit(`HEADLINE_DIFF: ${hPol} ${hText}`);
emit(`HEADLINE_BASIS: driver=${hDriver}; quality=${absState} (lvl ${qLevel}); cost=froz5 ${froz5} / next ${nextUsd} (lvl ${cLevel})`);
emit(`COST_LEAD: ${costLead}`);
emit(`COST_TOTAL: ${costTotal}`);
emit(`COST_CHAR: ${costChar}`);
// Residual branch tags: the warm-open era marker and/or the provisional-baseline count.
emit(`COST_FROZ5: cause=${froz5Cause}` + (froz5Cause === 'model-switched'
  ? ' — ratio not comparable across the switch'
  : (froz5Resid != null
    ? '; froz5 ' + FmtRatio(froz5) + ' vs ' + FmtRatio(froz5Exp) + ' typical at this depth (residual ' + fmtN(froz5Resid, 2) + TIMES + `); confidence=${froz5Conf}`
      + (froz5Stale ? '; era=warm-open (curve fit on post-2.1.209 cold-start sessions)' : '')
      + (froz5Provisional ? `; baseline=provisional (${freshLegN} of ${FRESH_N} warm legs)` : '')
    : ' (curve n/a — 200k window or missing data)')));
emit(`COST_DETAIL: ${costDetail}`);
emit(`COST_AGENTS_TIER: ${agentTier}`);
emit(`COST_AGENTS_LEAD: ${costAgentsLead}`);
// Run-window notes (schema 4): a detected resume, and/or the list-price tripwire the detection
// cannot reach. Both may fire; the resumed line comes first.
if (s.runStartLeg != null && Number(s.runStartLeg) > 0) {
  emit(`COST_RUN_NOTE: resumed session — legs 1${NDASH}${Math.trunc(Number(s.runStartLeg))} predate this run; the total covers this run only, earlier legs are priced at this run's rate`);
}
if (s.legPricingSuspect === true) {
  emit(`COST_RUN_NOTE: leg $ suspect — session rate far below list price (resumed without local history?); per-leg $ are understated, the total is CC's own`);
}
// A mid-session model switch with a FULL-STRENGTH anchor (the gate above): the depth cause resolved
// normally, so the switch is reported here as a dollar-comparability footnote instead of replacing
// the explanation. With a weak anchor it is the COST_CHAR lead instead, and this line is absent.
if (s.modelSwitch && !froz5AnchorWeak) {
  emit(`COST_RUN_NOTE: the model switched mid-session (${String(s.modelSwitch.from)} → ${String(s.modelSwitch.to)} at leg ${Math.trunc(Number(s.modelSwitch.atLeg))}) — legs before and after were priced on different models, so comparing per-leg $ across the switch is not like-for-like; the multiple and the depth curve still hold (both sides measure this session's own token-work at one price)`);
}
// Fast mode: CC's total_cost_usd omits the fast premium. Warn, don't recompute — no factor.
if (s.fastMode === true) {
  emit(`COST_FAST_NOTE: fast mode on — every $ in this sheet excludes the fast premium; per-leg $, the forecast and the total are understated (CC's own figure, not recomputed)`);
}
// Transcript-vs-display tier provenance (sidecar `tierMismatch`, present only when the labelled tier
// has never served in this run): the label is wrong, no number is. Pure provenance, like the fast
// caveat — never a reason to distrust the ratio, which is tier-free.
if (s.tierMismatch && s.tierMismatch.serving) {
  emit(`COST_TIER_NOTE: the model label reads ${BT}${s.model}${BT}, but every leg in this run was served by ${BT}${String(s.tierMismatch.serving)}${BT} — a label fact only: the $ and the multiple in this sheet do not depend on which label is shown`);
}
// temporary — removed by Stage B (dollar-gate re-anchor): the $ verdict floors (COST_FLOOR_*) are
// calibrated on Fable/Opus headline pricing, so on a sonnet/haiku main they grade too leniently.
if (sessionTier === 'sonnet' || sessionTier === 'haiku') {
  emit('COST_GATES_NOTE: $ thresholds calibrated for Fable/Opus pricing');
}
emit(`COLD: ${coldOut}`);
// Gloss keyed on the model GENERATION read off the sidecar's display string: Sonnet 5 (5.x) had
// cache-preserving injection and lost it in CC 2.1.201 (expected); older Sonnet generations never
// had it (informational, not a regression); every other tier — worth a look.
const isSonnet5 = sessionTier === 'sonnet' && /sonnet[\s-]?5\b/i.test(String(s.model));
const isOtherSonnet = sessionTier === 'sonnet' && !isSonnet5;
emit('WARM_REWRITE_TAX: ' + (nWarmScan >= 1
  ? FmtUsd(warmTaxUsdScan) + ' over ' + BT + nWarmScan + BT + ' leg(s) — big cache rewrites without an idle expiry, billed at write price instead of read; separate from (never double-counted with) the cold tax'
    + (isSonnet5
      ? '; expected — CC 2.1.201 dropped cache-preserving injection on Sonnet 5'
      : (isOtherSonnet
        ? '; informational on this Sonnet generation — it never had cache-preserving injection, so a rewrite here is not a regression signal'
        : '; unexpected on this model — worth a look'))
  : '(none)'));
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
