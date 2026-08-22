// leg-driver.mjs — shared per-leg cost-DRIVER labeller (single source of truth).
// Node port of leg-driver.ps1. Imported by statusline.mjs (big-leg spotlight, hot path),
// render-spikes.mjs and handover-facts.mjs (the /handover-check report), so the live line
// and the report row can never drift. Pure functions, no side effects.
//
// A leg record carries: cwUnits (per-tier cache-write units), cr (cache_read tokens),
// out (output tokens), inT (fresh input tokens), cw (cache_creation tokens), gapToPrev
// (idle seconds since the previous leg, or null), coldTtl (the prior leg's cache TTL, sec),
// prevWarm (the prior leg's cr+cw).

import { readFileSync } from 'node:fs';
import { psRound, parseUtcEpoch } from './_sl-compat.mjs';

// Composition weights — list-price ratios; cache-write is TIER-DEPENDENT (1h 2x / 5m 1.25x).
// MUST stay in sync with statusline.mjs's cacheWriteUnits.
export const M_INPUT = 1.0;
export const M_CACHE_WRITE_5M = 1.25;
export const M_CACHE_WRITE_1H = 2.0;
export const M_CACHE_READ = 0.10;
export const M_OUTPUT = 5.0;

// Headline $/MTok INPUT price per model family — hand-maintained constants, never fetched (no
// pricing-page parsing, no config, no env). The RATIOS drive every tier-weighted split (a leg's or
// an agent's units scale by TIER_BASE[legTier] / TIER_BASE[mainTier] — see tierWeight); the
// ABSOLUTE value anchors only the list-price sanity check (statusline.mjs's legPricingSuspect
// tripwire: base vs TIER_BASE[mainTier] / 1e6 $/unit). Update by hand when a list price changes.
export const TIER_BASE = { fable: 10, mythos: 10, opus: 5, sonnet: 2, haiku: 1 };

// Model → coarse pricing tier. Works on BOTH the id form ("claude-opus-4-8-20260115", agent
// transcripts) and the display form ("Opus 4.8 (1M context)", the stdin payload), so a
// main-vs-agent comparison can never read a format difference as a tier difference. Absent or
// empty-string model → null, and null NEVER counts as a tier: every pre-change agents cache lacks
// `model` forever (incremental offsets), and the cache's initialized/transient state is '' — the
// tier-mix warn must not fire on either. A present, NON-EMPTY, unmapped string is 'other': visible
// in the chip and counted for warn-firing, but excluded from tier weighting (weight 1.0).
export function ModelTier(m) {
  if (!m) return null;
  const s = String(m).toLowerCase();
  for (const t of ['opus', 'sonnet', 'haiku', 'fable', 'mythos']) if (s.includes(t)) return t;
  return 'other';
}

// The ONE tier-weight function — price weight of a leg (or an agent) relative to the MAIN tier:
// TIER_BASE[ModelTier(model)] / TIER_BASE[mainTier] when both tiers are mapped, else 1.0 (absent /
// empty / unmapped model, or an unmapped/null main → the recompute never guesses). Used by the
// status line (per-leg + per-agent effective units), render-spikes (same weights, so the panel and
// the agents chip agree by construction) and handover-facts (weighted cold/warm tax).
export function tierWeight(model, mainTier) {
  const t = ModelTier(model);
  if (t === null || TIER_BASE[t] == null || mainTier == null || TIER_BASE[mainTier] == null) return 1.0;
  return TIER_BASE[t] / TIER_BASE[mainTier];
}

// Transcript-vs-display tier PROVENANCE — "the model label names a tier that has never served in
// this run". Drives a dim chip, a conditional sidecar key and a fact-sheet caveat; it gates NO
// number. The display tier CANCELS out of per-leg dollars: `base` = cost / Σ(rawᵢ × wᵢ /
// TIER_BASE[mainTier]) and each leg's dollars are rawᵢ × wᵢ × base, so TIER_BASE[mainTier] appears
// once in each and divides out — a mislabelled display tier misprices no dollar figure.
// `legModels` = the run's per-leg raw model strings, sampled from `runStartLeg` on (a resumed
// session's earlier runs may legitimately be another tier). Returns { display, serving } or null.
//
// PRESENCE-based, not majority-based: within one run a tier's presence only ever grows, so the
// report latches OFF the moment the labelled tier serves once and can never flap back on. Changing
// the display label (a /model switch) re-asks the question, which is correct.
export function servingTierReport(legModels, runStartLeg, displayName) {
  const display = ModelTier(displayName);
  if (display === null || TIER_BASE[display] == null) return null; // absent or unmapped label → nothing to report
  const arr = Array.isArray(legModels) ? legModels : [];
  const start = Math.max(0, Number(runStartLeg) || 0);
  const counts = new Map();
  for (let i = start; i < arr.length; i++) {
    const t = ModelTier(arr[i]);
    if (t === null || TIER_BASE[t] == null) continue; // absent / empty / 'other' never counts as a tier
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  if (counts.size === 0) return null;      // no mapped leg tier anywhere → no report against nothing
  if (counts.has(display)) return null;    // the label names a tier that really has served
  let serving = null, best = -1;
  for (const [t, n] of counts) {
    if (n > best || (n === best && TIER_BASE[t] > TIER_BASE[serving])) { best = n; serving = t; }
  }
  return { display, serving }; // ties break to the higher TIER_BASE — chip TEXT only, never a number
}

// Dominant cost DRIVER = the largest WEIGHTED term. Mirrors Get-Driver in leg-driver.ps1.
export function getDriver(l) {
  // Term order matches the pwsh hashtable's practical argmax; weighted ties are measure-zero
  // for real token counts, so first-seen-max is a safe, deterministic tie-break.
  const terms = [
    ['cw', l.cwUnits],
    ['cr', l.cr * 0.10],
    ['out', l.out * 5.0],
    ['inp', l.inT * 1.0],
  ];
  let winner = terms[0][0], best = terms[0][1];
  for (const [k, v] of terms) { if (v > best) { best = v; winner = k; } }
  switch (winner) {
    case 'cw': {
      const bigRewrite = (l.cw >= 50000 && l.cr < l.cw * 0.5);
      if (testColdLeg(l)) return `re-cached ~${psRound(l.cw / 1000)}k (cold — cache expired after idle)`;
      if (testCompactedLeg(l)) return `compacted ~${psRound(l.cw / 1000)}k (context collapsed, no idle gap)`;
      // The opening leg (gapToPrev == null) has no previous warm baseline, so its write is never a
      // "rewrite" — it either opened cold (the post-CC-2.1.209 signature: whole context written, no
      // cached prefix) or simply loaded new context. Same partition testWarmRewriteLeg uses.
      if (l.gapToPrev == null) {
        if (isColdStartLeg(l)) return `opened cold ~${psRound(l.cw / 1000)}k (whole context written, no cached prefix)`;
        return `loaded ~${psRound(l.cw / 1000)}k new context`;
      }
      if (bigRewrite) return `re-cached ~${psRound(l.cw / 1000)}k (warm rewrite, not new content)`;
      return `loaded ~${psRound(l.cw / 1000)}k new context`;
    }
    case 'out': return `generated ~${psRound(l.out / 1000)}k output`;
    case 'cr': return `re-read deep context (~${psRound(l.cr / 1000)}k)`;
    default: return `large fresh input (~${psRound(l.inT / 1000)}k)`;
  }
}

// Test-ColdLeg — the ONE cold-tax predicate, shared everywhere. Mirrors leg-driver.ps1.
export function testColdLeg(l) {
  const bigRewrite = (l.cw >= 50000 && l.cr < l.cw * 0.5);
  const collapsed = (l.prevWarm > 0 && l.cr < l.prevWarm * 0.7);
  return l.gapToPrev != null && l.gapToPrev > l.coldTtl
    && l.cw >= 8000 && (bigRewrite || collapsed);
}

// Test-CompactedLeg — the ONE compacted predicate. The warm set COLLAPSED (cr < 0.7×prevWarm)
// WITHOUT a TTL-exceeding idle gap — context was dropped mid-session (client /compact today,
// server-side compaction tomorrow), not an expiry. Same collapse test as testColdLeg but with the
// gap condition INVERTED, so this class and the cold class partition collapse events by gap; it
// never touches the cold tax (testColdLeg requires gap > coldTtl and runs first in getDriver).
// When collapse and bigRewrite both hold, compacted wins — collapse is the stronger signal
// (pinned at the 2026-07-04 freeze).
export function testCompactedLeg(l) {
  return l.gapToPrev != null && l.gapToPrev <= l.coldTtl
    && l.prevWarm > 0 && l.cr < l.prevWarm * 0.7 && l.cw >= 8000;
}

// Test-WarmRewriteLeg — the ONE warm-rewrite-TAX predicate (handover-facts' WARM_REWRITE_TAX sum).
// Follows getDriver's cw-branch class order — cold first, then compacted, then bigRewrite — so the
// spikes label and the billed class agree by construction, and the leg classes form a clean
// partition: a big cache write lands in exactly one of {cold tax, compacted, warm-rewrite tax}.
// The opening leg (gapToPrev == null) is excluded outright: with no previous warm baseline its
// context load could never have been a cache read, so the premium is unavoidable — not a rewrite.
export function testWarmRewriteLeg(l) {
  const bigRewrite = (l.cw >= 50000 && l.cr < l.cw * 0.5);
  return bigRewrite && l.gapToPrev != null && !testColdLeg(l) && !testCompactedLeg(l);
}

// Placeholder line, not a leg — the ONE synthetic predicate, shared by BOTH transcript scans
// (getScannedLegs below and statusline.mjs's UpdateSessionRollups), so the leg count, the sparkline
// and the recent-leg median chip can never disagree about what counts as a turn. Claude Code records
// an API overload (a 529) as an assistant line with no billed tokens; counting it distorts the leg
// count and the sparkline (a $0.00 cell).
//
// EITHER signal fires, deliberately: the model string alone would decay silently if CC renamed the
// literal, and all-zero-usage alone would miss a synthetic line that reported a stray counter.
// The trade: a REAL leg with all four counters at zero would be dropped from the leg count and the
// sparkline. That cannot be a billable call (a request with no prompt and no output was never one)
// and its dollars were zero either way, so no money moves.
// MUST be evaluated on a DEDUPED leg record, never on a raw assistant line — main transcripts repeat
// one message.id per content block, so a line-level predicate would double-count.
export function isSyntheticLeg({ model, inT, cw, cr, out } = {}) {
  if (String(model) === '<synthetic>') return true;
  return (Number(inT) || 0) === 0 && (Number(cw) || 0) === 0
    && (Number(cr) || 0) === 0 && (Number(out) || 0) === 0;
}

// True median — even count → mean of the middle two; empty → null. Used by the next-leg forecast.
export function median(arr) {
  const vals = arr.filter((x) => x !== null && x !== undefined && !Number.isNaN(Number(x))).map(Number).sort((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2.0;
}

// The post-CC-2.1.209 opener signature on leg 1: nothing read from cache, (near-)zero fresh input,
// the whole context written. The cw ≥ 8000 floor keeps a zero-usage `<synthetic>` line or a
// no-cache stub from reading as a cold start (a real opener writes ≥ 8k by construction).
// INTERNAL — the one consumer is getDriver above, which uses it to label leg 1 `opened cold`.
function isColdStartLeg(l) {
  const inT = Number(l?.inT) || 0, cw = Number(l?.cw) || 0, cr = Number(l?.cr) || 0;
  return cr === 0 && inT <= 100 && cw >= 8000;
}

// Get-ScannedLegs — authoritative transcript scan for the /handover-check renderers. Per-leg
// token mix -> weighted units, idle gap, effective-durable prior TTL, raw `model` string ('' when
// the line carries none), `ts` (epoch seconds | null), `speed` (raw usage.speed string or '').
// Placeholder lines (isSyntheticLeg) are dropped after the dedup, so they consume no leg index.
// Dedup by message.id, first-wins — HAZARD: main transcripts repeat one
// message.id per content block with byte-identical usage (verified 94/94 groups), so first-wins is
// exact here; AGENT transcripts carry PROGRESSIVE output_tokens across a group and need the
// max-wins branch in statusline.mjs's UpdateAgentRollups — never point this scan at an agent file.
// Returns [] on a missing/unreadable transcript. Mirrors leg-driver.ps1.
export function getScannedLegs(transcriptPath) {
  if (!transcriptPath) return [];
  let text;
  try { text = readFileSync(transcriptPath, 'utf8'); } catch { return []; }
  const seen = new Set();
  const legs = [];
  let idx = 0, prevTs = null, prevWarm = 0;
  let recentTtls = [];
  for (const rawLine of text.split('\n')) {
    if (!/"type"\s*:\s*"assistant"/.test(rawLine)) continue;
    let p;
    try { p = JSON.parse(rawLine); } catch { continue; }
    const mid = p?.message?.id;
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    const u = p?.message?.usage;
    if (u == null) continue;
    const inT = Number(u.input_tokens) || 0;
    const cw = Number(u.cache_creation_input_tokens) || 0;
    const cr = Number(u.cache_read_input_tokens) || 0;
    const out = Number(u.output_tokens) || 0;
    const model = String(p?.message?.model ?? '');
    // Placeholder lines are not legs (see isSyntheticLeg). Skipped AFTER the message-id dedup, so a
    // multi-line placeholder is dropped once; it consumes no leg index and leaves prevTs / prevWarm /
    // recentTtls untouched (it processed no tokens, so it refreshed no cache).
    if (isSyntheticLeg({ model, inT, cw, cr, out })) continue;
    idx++;
    const cw1h = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
    const cw5m = Number(u.cache_creation?.ephemeral_5m_input_tokens) || 0;
    const cwUnits = (cw1h + cw5m) > 0
      ? cw1h * M_CACHE_WRITE_1H + cw5m * M_CACHE_WRITE_5M
      : cw * M_CACHE_WRITE_5M;
    const units = inT * M_INPUT + cwUnits + cr * M_CACHE_READ + out * M_OUTPUT;
    const legTtl = cw1h > 0 ? 3600 : (cw5m > 0 ? 300 : 0);
    let legTs = null;
    if (p.timestamp) legTs = parseUtcEpoch(p.timestamp);
    const gapToPrev = (legTs != null && prevTs != null) ? legTs - prevTs : null;
    if (legTs != null) prevTs = legTs;
    const durablePrevTtl = recentTtls.includes(3600) ? 3600 : 300;
    const speed = String(u.speed ?? '');
    legs.push({ idx, inT, cw, cwUnits, cr, out, units, gapToPrev, coldTtl: durablePrevTtl, prevWarm, model, ts: legTs, speed });
    prevWarm = cr + cw; // warm tokens for the NEXT leg's collapse test
    if (legTtl > 0) { recentTtls.push(legTtl); if (recentTtls.length > 8) recentTtls = recentTtls.slice(-8); }
  }
  return legs;
}
