// handover-facts.mjs — deterministic fact sheet for /handover-check (Layer 1, no LLM).
//
// Node port of handover-facts.ps1. Reads the status-line sidecar snapshot and resolves EVERY
// classification + pre-formats EVERY number (backticks already on, ready to paste), so the Sonnet
// compose step never derives a band, applies a threshold, or formats a fragment — it only weaves
// these facts into prose. The headline COST rule is a MONEY rule: the absolute forecast next-leg $
// on a three-rung dollar ladder (COST_FLOOR_FINE / COST_FLOOR_STEEP), nothing else. Output is a
// labelled fact sheet consumed by the subagent — NOT pasted to the user. Read-only, off the hot
// path (runs only when /handover-check is invoked).
//
// All thresholds live in the TUNABLES block — recalibrate there; keep in sync with docs/status-line.md.
// Numeric/clock semantics come from _sl-compat.mjs (psRound = [int]/[Math]::Round, fmtN = '{0:N2}',
// mathRoundD = [Math]::Round(x,2), nowEpoch = the frozen-clock seam), so the fact sheet matches the
// retired pwsh original byte-for-byte.

import { readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSidecarPath, resolveConfigHome } from './sidecar-path.mjs';
import { getScannedLegs, testColdLeg, testWarmRewriteLeg, ModelTier, tierWeight, median, M_CACHE_READ } from './leg-driver.mjs';
import { psRound, fmtN, mathRoundD, nowEpoch } from './_sl-compat.mjs';
import { sanitizeSessionName } from './sanitize-name.mjs';

const BT = '`';          // literal backtick → inline-code spans render light-blue in the assistant message
const MID = '·';    // ·
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

// SCHEMA guard — the snapshot's shape version must match EXACTLY, or this reader refuses and prints
// nothing else. The measured failure it prevents is a wrong cost verdict with no complaint: a reader
// built for another schema finds a key it needs absent, reads `undefined`, and silently demotes the
// money axis (measured: two rungs low, plus a bare `?` in prose). Degrading is not available — the
// reader cannot know which of its facts are schema-independent for a shape it does not recognise —
// and "warn and continue" leaves the wrong verdict on screen under a caveat, which is how a
// confidently wrong number survives. REFUSE, in BOTH directions: the mechanism (a needed key absent)
// runs either way, and an older snapshot is benign only by accident of one particular step. One
// rule, one comparison, no per-version reasoning. Exit 0 — a refusal is an answer, like MISSING and
// FOREIGN. Placement is load-bearing: BEFORE the freeze copy below, so a snapshot this reader
// rejects is never frozen and the two chart renderers never draw it.
// NOTE this protects skew from schema 6 onward only. A reader BUILT before schema 6 has no guard and
// never will; that window closes by installing this build in both config homes, not by this field.
const SIDECAR_SCHEMA = 6;
const snapSchema = s.schema;
const snapSchemaIsNum = typeof snapSchema === 'number' && Number.isFinite(snapSchema);
if (!(snapSchemaIsNum && snapSchema === SIDECAR_SCHEMA)) {
  // Report what was actually found — never `undefined` at the reader. A non-numeric value (the
  // string '6' is the trap a loose `==` would pass) is quoted as written.
  const found = snapSchemaIsNum ? String(snapSchema)
    : (snapSchema === undefined ? '(none)' : JSON.stringify(snapSchema) ?? '(none)');
  const fix = (snapSchemaIsNum && snapSchema > SIDECAR_SCHEMA)
    ? 'update this config home (`git pull && node install.mjs`), then re-run'
    : `an older status-line build wrote this snapshot — if another session in this project runs from a different config home, sync that home (${BT}node install.mjs --claude-home <path>${BT}) first; then press Enter on an empty prompt here and re-run`;
  process.stdout.write(`SCHEMA_MISMATCH\nthis reader expects schema ${BT}${SIDECAR_SCHEMA}${BT}\nsnapshot was written with schema ${BT}${found}${BT}\n${fix}`);
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
// null (never 0) when legs were counted but the run has no cost basis yet (s.base null — the state
// between a detected resume and the first new leg): the emit site then states the count and says
// "not priced yet" instead of formatting a fabricated $0.00.
const coldWastedUsdScan = nColdScan > 0
  ? (s.base != null ? mathRoundD(coldLegs.reduce((a, l) => a + avoidableEff(l), 0) * Number(s.base), 2) : null)
  : 0;

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
// Same null-basis rule as coldWastedUsdScan above: legs counted, no basis → null, never $0.00.
const warmTaxUsdScan = nWarmScan > 0
  ? (s.base != null ? mathRoundD(warmRewriteLegs.reduce((a, l) => a + avoidableEff(l), 0) * Number(s.base), 2) : null)
  : 0;

// ---- TUNABLES (recalibrate here) ----
// The two dollar floors ARE the cost verdict — a three-rung ladder on the forecast next-leg $:
// below FINE → rung 0 (plenty of room) · FINE to STEEP → rung 2 (wind down soon) · at/above STEEP
// → rung 3 (time to hand over). A missing forecast reads as rung 0.
const COST_FLOOR_FINE = 0.28;
const COST_FLOOR_STEEP = 0.45;
const WINDOW_1M = 700000;       // windowSize at/above this is the 1M regime (token-count leads quality)

// ---- number formatters (backticks ON — these fragments are FINAL; downstream must not reformat) ----
function FmtUsd(v) { if (v == null) return `${BT}$?${BT}`; const d = Number(v); if (d >= 0 && d < 0.005) return `${BT}<$0.01${BT}`; return `${BT}$` + fmtN(d, 2) + BT; }
function FmtK(t) { if (t == null) return `${BT}?${BT}`; return BT + psRound(Number(t) / 1000) + 'k' + BT; }
function FmtPct(v) { if (v == null) return `${BT}?${BT}`; return BT + psRound(Number(v)) + '%' + BT; }
function FmtMin(sec) { if (sec == null) return '~?'; return '~' + BT + psRound(Number(sec) / 60) + ' min' + BT; }

// `median` comes from leg-driver.mjs (imported above) — ONE implementation, one convention, shared
// with the status line's `last N` chip and the next-leg forecast's own-work term. Even count → mean
// of the middle two. Both call sites here (the recent-rate figure, the `spiky` trajectory test) pass
// a non-empty array, so its empty→null case is unreachable.

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

// ---- HEADLINE (cost+quality only; cold never touches it). Cost rule: the dollar ladder. ----
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
const nextUsd = s.nextLegUsd != null ? Number(s.nextLegUsd) : null;
const is1M = (Number(s.windowSize) >= WINDOW_1M);
const sessionTier = ModelTier(s.model);

// The cost verdict is the MONEY, and only the money: the forecast next-leg $ on the two floors'
// three-rung ladder. No depth normalization, no cross-session comparison — the sheet reports what a
// leg costs, never whether that cost is "normal" for a session this deep.
let cLevelRaw;
if (nextUsd == null || nextUsd < COST_FLOOR_FINE) cLevelRaw = 0;
else if (nextUsd < COST_FLOOR_STEEP) cLevelRaw = 1;
else cLevelRaw = 2;
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

// ---- COST ----
const costLead = 'each leg ~' + FmtUsd(nextUsd);
const costTotal = FmtUsd(s.costUsd) + ' total';
// Per-leg dollars, straight from the sidecar (the same array TRAJECTORY reads and the status line's
// trend strip / `last` / `med<N>` chip show). MEASUREMENT, never a verdict.
const lc = (s.legCosts || []).map(Number);
// The recent RATE — the MEDIAN of the last min(8, N) legs, computed with the SAME exported `median`
// the status line's `med<N> $x.xx` chip and the next-leg forecast use, so the line and the sheet
// state one number from one implementation. The prose QUOTES the chip's own label, so a reader can
// match the sheet against the line at a glance; the label carries the real window count, never a
// literal 8. The window of 8 is NOT a tunable here: it must stay in
// lockstep with the chip's own `Math.min(8, …)` in statusline.mjs, or the line and the sheet
// disagree about what "recent" means. `(none)` below 2 legs (nothing typical to report; at 1 leg it
// would just repeat what a leg costs), matching the file's convention for COST_DETAIL /
// COST_AGENTS_LEAD.
// TWO different statistics in one line, deliberately: the recent figure is the TYPICAL leg, how
// firmly depending on the window it names; the session figure is total spend spread over every leg,
// which a fat leg does lift. How firmly the recent figure holds depends on the N it names. At N=8
// one fat leg shifts it by the gap between two ordinary legs, not by its own size. Shorter windows tend to
// resist less: fewer ordinary legs, further apart, so the same one-rank shift moves it further, and
// two fat legs in one short window can put a fat leg's own size into the figure. At N=2 the median
// IS the mean of the two legs, so a single fat leg sets it outright.
// Never write that one fat leg cannot lift it, and never quote a multiplier here: the ceilings are a
// property of whatever sessions happen to be on disk, so any figure written down goes stale and the
// next reader cannot tell that it has. State the direction; leave the size to the spikes panel. So a recent median above the session mean means the typical leg genuinely got more
// expensive, while below it means expensive legs are carrying the session mean — with NO claim about
// where those legs are, and no denial that they are the most recent ones (a median is built to resist
// exactly those legs). The spikes panel locates them; TRAJECTORY gives the direction.
let costRecent = '(none)';
const recentN = Math.min(8, lc.length);
if (recentN >= 2) {
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  costRecent = BT + 'med' + recentN + BT + ' (median of the last ' + recentN + ' legs) '
    + FmtUsd(median(lc.slice(-recentN)))
    + '/leg; session mean ' + FmtUsd(mean(lc)) + ' over ' + BT + lc.length + BT + ' legs';
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
  // Priced → the "so far" dollars; no basis yet (null) → the count stands, no invented figure.
  const tax = coldWastedUsdScan != null
    ? 'cold tax so far: ' + FmtUsd(coldWastedUsdScan) + ' over ' + BT + nColdScan + BT + ' leg(s)'
    : BT + nColdScan + BT + ' cold leg(s) so far — not priced yet (no leg of this run has a cost basis)';
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
// Past the wall (toCompact <= 0, the render's `wall NOW`) → say so; the sidecar keeps the true signed
// measurement and only the prose branches, so a negative distance never reaches the reader.
const qHeadroom = s.autoCompactOff === true
  ? 'auto-compact is off — no compaction will fire; the session runs to the raw window (manage context by hand)'
  : (typeof s.toCompact === 'number' && s.toCompact <= 0)
    ? (s.toCompact === 0
      ? 'at the auto-compact wall — compaction is due on the next turn'
      : 'past the auto-compact wall by ' + FmtK(-s.toCompact) + ' — compaction is due on the next turn')
    : FmtK(s.toCompact) + ' to compact';

// ---- ACTIVITY (omit when sub-agents ran — activity% is agent-polluted) ----
let act;
if (Number(s.nAgents) > 0) act = '(omit — ' + Math.trunc(Number(s.nAgents)) + ' sub-agents ran; activity% folds their parallel compute, so it does not signal your work pattern)';
else if (s.activityPct != null) act = 'the model was generating ' + FmtPct(s.activityPct) + ' of the elapsed wall-clock (this times LLM generation only) — the rest is tool calls and your read/think time in unknown proportion';
else act = '(omit)';

// ---- TRAJECTORY (shape + range from legCosts, resolved in the COST section above) ----
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
  // Whole-session ARC vs the RECENT direction. A session that peaked mid-way can climb OVERALL yet be
  // flat-to-down lately; a bare "climbing" then misreads where the spend is heading. If the recent
  // tail has come well off the session's peak stretch, say so instead of "climbing".
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
// hDriver === 'both'. Only call cost "climbing" when the MEASURED per-leg spend is climbing — the
// dollar ladder elevates cost on the absolute $ alone, so an expensive session can be perfectly
// flat. TRAJECTORY (computed from legCosts) is the one direction fact the sheet has, so the your-call
// lean reads off it and the two lines can never contradict each other.
else if (!trajShape.startsWith('climbing')) ycBasis = 'quality is in the degradation band and each leg is already pricey — cost is high but flat, not climbing — lean toward handing over';
else ycBasis = 'both cost and quality are climbing — lean toward handing over';

// ---- emit the fact sheet ----
emit(`IDENTITY: ${identity}`);
emit(`STALE: ${stale ? 'yes — tell the user to press Enter on an empty prompt in the session they mean, then re-run' : 'no'}`);
emit(`HEADLINE_DIFF: ${hPol} ${hText}`);
emit(`HEADLINE_BASIS: driver=${hDriver}; quality=${absState} (lvl ${qLevel}); cost=next ${nextUsd} (lvl ${cLevel})`);
emit(`COST_LEAD: ${costLead}`);
emit(`COST_TOTAL: ${costTotal}`);
emit(`COST_RECENT: ${costRecent}`);
emit(`COST_DETAIL: ${costDetail}`);
emit(`COST_AGENTS_TIER: ${agentTier}`);
emit(`COST_AGENTS_LEAD: ${costAgentsLead}`);
// Run-window caveats. ONE LABEL PER CAVEAT — these three can co-occur in a single sheet, and the
// sheet is a `KEY: value` contract: a key that appears twice with different content is unparseable
// (the reader cannot tell a second value from a corrected one). Every label here must also be
// registered in home/commands/handover-check.md's relayable list, or the composer silently drops it.
if (s.runStartLeg != null && Number(s.runStartLeg) > 0) {
  emit(`COST_RESUME_NOTE: resumed session — legs 1${NDASH}${Math.trunc(Number(s.runStartLeg))} predate this run; the total covers this run only, earlier legs are priced at this run's rate`);
}
if (s.legPricingSuspect === true) {
  emit(`COST_LEGPRICE_NOTE: leg $ suspect — session rate far below list price (resumed without local history?); per-leg $ are understated, the total is CC's own`);
}
// A mid-session model switch, stated once and always: the fact is about DOLLAR comparability, which
// a switch always breaks.
if (s.modelSwitch) {
  emit(`COST_MODELSWITCH_NOTE: the model switched mid-session (${String(s.modelSwitch.from)} → ${String(s.modelSwitch.to)} at leg ${Math.trunc(Number(s.modelSwitch.atLeg))}) — legs before and after were priced on different models, so comparing per-leg $ across the switch is not like-for-like`);
}
// Fast mode: CC's total_cost_usd omits the fast premium. Warn, don't recompute — no factor.
if (s.fastMode === true) {
  emit(`COST_FAST_NOTE: fast mode on — every $ in this sheet excludes the fast premium; per-leg $, the forecast and the total are understated (CC's own figure, not recomputed)`);
}
// Transcript-vs-display tier provenance (sidecar `tierMismatch`, present only when the labelled tier
// has never served in this run): the label is wrong, no number is. Pure provenance, like the fast
// caveat — the DISPLAY TIER CANCELS out of per-leg dollars (`base` = cost / Σ(rawᵢ × wᵢ /
// TIER_BASE[main]) and a leg's dollars are rawᵢ × wᵢ × base, so TIER_BASE[main] divides out).
if (s.tierMismatch && s.tierMismatch.serving) {
  emit(`COST_TIER_NOTE: the model label reads ${BT}${s.model}${BT}, but every leg in this run was served by ${BT}${String(s.tierMismatch.serving)}${BT} — a label fact only: the $ in this sheet does not depend on which label is shown`);
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
  ? (warmTaxUsdScan != null
    ? FmtUsd(warmTaxUsdScan) + ' over ' + BT + nWarmScan + BT + ' leg(s) — big cache rewrites without an idle expiry, billed at write price instead of read; separate from (never double-counted with) the cold tax'
    : BT + nWarmScan + BT + ' leg(s) — not priced yet (no cost basis in this run)')
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
