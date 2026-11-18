// leg-driver.mjs — shared per-leg cost-DRIVER labeller and per-model price table (single source of
// truth). Imported by statusline.mjs (big-leg spotlight, hot path), render-spikes.mjs and
// handover-facts.mjs (the /handover-check report), so the live line and the report row can never
// drift. Pure functions, no side effects.
//
// A leg record carries: cwUnits (per-tier cache-write units), cr (cache_read tokens),
// out (output tokens), inT (fresh input tokens), cw (cache_creation tokens), gapToPrev
// (idle seconds since the previous leg, or null), coldTtl (the prior leg's cache TTL, sec),
// prevWarm (the prior leg's cr+cw).

import { readFileSync } from 'node:fs';
import { psRound, parseUtcEpoch } from './_sl-compat.mjs';

// Composition weights — list-price ratios to the model's INPUT price. Cache writes (1h 2x / 5m
// 1.25x) and output (5x) hold on every model, so they stay global. The cache-READ multiplier varies
// by model and lives in MODEL_PRICES; M_CACHE_READ is the STORAGE BASIS: every banked figure (the
// stats file's perLegUnits / coldWastedUnits / coldLegs[].avoidableUnits / recentLegs[].units, the
// agents cache's units / maxLegUnits) is banked with reads at 0.10x, and readers convert to the
// model's own read rate at read time (pricedUnits / pricedRecentUnits / pricedColdAvoidable).
// Changing M_CACHE_READ would change what every stored number means — it never changes.
// MUST stay in sync with statusline.mjs's CacheWriteUnits.
export const M_INPUT = 1.0;
export const M_CACHE_WRITE_5M = 1.25;
export const M_CACHE_WRITE_1H = 2.0;
export const M_CACHE_READ = 0.10;
export const M_OUTPUT = 5.0;

// The read multiplier for a model with no table entry — the pricing page's "all other models" rate.
export const DEFAULT_READ_MULT = 0.10;

// Per-model list prices — hand-maintained constants, never fetched (no pricing-page parsing, no
// config, no env). Update by hand when a list price changes; this table is the ONE place prices live.
// `input` = $ per million input tokens; `read` = the cache-read price as a multiple of input.
// The input RATIOS drive every model-weighted split (priceWeight); the ABSOLUTE input price anchors
// only the list-price sanity check (statusline.mjs's legPricingSuspect tripwire). Haiku 5.5 is
// priced at its prompt ≤ 100K card (its > 100K card needs per-leg prompt size, which is not stored).
// Keys are normalized model keys (modelKey): `<family>-<major>[-<minor>]`.
export const MODEL_PRICES = {
  'fable-5-2': { input: 8, read: 0.025 },
  'mythos-5-2': { input: 8, read: 0.025 },
  'fable-5-1': { input: 10, read: 0.025 },
  'mythos-5-1': { input: 10, read: 0.025 },
  'fable-5': { input: 10, read: 0.10 },
  'mythos-5': { input: 10, read: 0.10 },
  'opus-5-5': { input: 4, read: 0.05 },
  'opus-5': { input: 5, read: 0.10 },
  'opus-4-8': { input: 5, read: 0.10 },
  'opus-4-7': { input: 5, read: 0.10 },
  'opus-4-6': { input: 5, read: 0.10 },
  'opus-4-5': { input: 5, read: 0.10 },
  'opus-4-1': { input: 15, read: 0.10 },
  'opus-4': { input: 15, read: 0.10 },
  'sonnet-5-5': { input: 2, read: 0.05 },
  'sonnet-5': { input: 2, read: 0.10 },
  'sonnet-4-6': { input: 3, read: 0.10 },
  'sonnet-4-5': { input: 3, read: 0.10 },
  'sonnet-4': { input: 3, read: 0.10 },
  'haiku-5-5': { input: 0.10, read: 0.10 },
  'haiku-4-5': { input: 1, read: 0.10 },
};

// A known family whose version has no row is priced as that family's NEWEST model.
export const FAMILY_NEWEST = {
  opus: 'opus-5-5', sonnet: 'sonnet-5-5', haiku: 'haiku-5-5', fable: 'fable-5-2', mythos: 'mythos-5-2',
};
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'];

// Model string → normalized MODEL_PRICES key, or null. Reads BOTH name forms: the id
// ("claude-opus-5-5", "claude-opus-4-8-20260115", "claude-opus-4-8[1m]") and the display name
// ("Opus 5.5 (1M context)", "Claude Opus 4.8 Extended Thinking (1M context)"). The version is the
// one- or two-digit major (and optional one- or two-digit minor) right after the family word, so an
// 8-digit date suffix is never read as a version. Known family with no matching row (or no version)
// → FAMILY_NEWEST; no known family, empty or absent → null. Memoized: the hot path calls it per leg.
const keyMemo = new Map();
export function modelKey(m) {
  if (!m) return null;
  const s = String(m).toLowerCase();
  if (keyMemo.has(s)) return keyMemo.get(s);
  let key = null;
  const fam = FAMILIES.find((f) => s.includes(f));
  if (fam) {
    const v = s.slice(s.indexOf(fam) + fam.length).match(/^[\s-]*(\d{1,2})(?!\d)(?:[.-](\d{1,2})(?!\d))?/);
    const major = v ? v[1] : null;
    const minor = v && v[2] != null && v[2] !== '0' ? v[2] : null;
    const exact = major == null ? null : (minor != null ? `${fam}-${major}-${minor}` : `${fam}-${major}`);
    key = (exact && exact in MODEL_PRICES) ? exact : FAMILY_NEWEST[fam];
  }
  keyMemo.set(s, key);
  return key;
}

// The model's { input, read } row, or null when it has no entry.
export function modelPrice(m) {
  const k = modelKey(m);
  return k ? MODEL_PRICES[k] : null;
}
// $ per million input tokens, or null when the model has no entry.
export function inputPrice(m) {
  const p = modelPrice(m);
  return p ? p.input : null;
}
// The model's cache-read multiplier; DEFAULT_READ_MULT (0.10) when it has no entry.
export function readMult(m) {
  const p = modelPrice(m);
  return p ? p.read : DEFAULT_READ_MULT;
}

// The ONE price-weight function — price weight of a leg (or an agent) relative to the MAIN model:
// inputPrice(model) / inputPrice(mainModel) when both have an entry, else 1.0 (absent / empty /
// unmapped model or main → the recompute never guesses). Used by the status line (per-leg +
// per-agent effective units), render-spikes (same weights, so the panel and the agents chip agree by
// construction) and handover-facts (weighted cold/warm tax). The read RATE is not part of the
// weight: each leg's units are converted at its own model's read rate first (pricedUnits & co.),
// whether or not the main model is mapped.
export function priceWeight(model, mainModel) {
  const a = inputPrice(model), b = inputPrice(mainModel);
  if (a == null || b == null || b <= 0) return 1.0;
  return a / b;
}

// Read-time conversions from the storage basis (reads at M_CACHE_READ) to the model's own read rate.
// A banked leg or agent: `units − ownUnits` is exactly the read term at 0.10 (cr × 0.10), so
// priced = own + (units − own) × read× ÷ 0.10. An own figure that is not a number (an entry from a
// build that did not bank it) leaves the units unconverted.
export function pricedUnits(units, ownUnits, model) {
  const u = Number(units), o = Number(ownUnits);
  if (!Number.isFinite(u)) return 0;
  if (ownUnits == null || !Number.isFinite(o)) return u;
  return o + (u - o) * (readMult(model) / M_CACHE_READ);
}
// A recentLegs record (full token mix kept): priced = units − cr × (0.10 − read×).
export function pricedRecentUnits(rec) {
  return Number(rec?.units) - (Number(rec?.cr) || 0) * (M_CACHE_READ - readMult(rec?.model));
}
// A coldLegs record: avoidable = stored + cw × (0.10 − read×) when the record carries `cw` (banked
// from 6.1.19 on), else the stored figure (overstated by cw × (0.10 − read×), zero for 0.10x models).
export function pricedColdAvoidable(rec) {
  const stored = Number(rec?.avoidableUnits);
  const cw = rec?.cw;
  if (cw == null || !Number.isFinite(Number(cw))) return stored;
  return stored + Number(cw) * (M_CACHE_READ - readMult(rec?.model));
}

// Model → coarse FAMILY. Label provenance only (servingTierReport, the fact sheet's gates note): no
// dollar figure reads it. Works on both name forms. Absent or empty-string model → null, and null
// NEVER counts as a family: every pre-change agents cache lacks `model` forever (incremental
// offsets), and the cache's initialized/transient state is ''. A present, NON-EMPTY string with no
// known family is 'other'.
export function ModelTier(m) {
  if (!m) return null;
  const s = String(m).toLowerCase();
  for (const t of FAMILIES) if (s.includes(t)) return t;
  return 'other';
}
const familyInput = (t) => MODEL_PRICES[FAMILY_NEWEST[t]].input;

// Transcript-vs-display tier PROVENANCE — "the model label names a tier that has never served in
// this run". Drives a dim chip, a conditional sidecar key and a fact-sheet caveat; it gates NO
// number. The display model CANCELS out of per-leg dollars: `base` = cost / Σ(rawᵢ × wᵢ) with
// wᵢ = inputᵢ / input(main), and each leg's dollars are rawᵢ × wᵢ × base, so input(main) appears
// once in each and divides out — a mislabelled display model misprices no per-leg dollar figure.
// `legModels` = the run's per-leg raw model strings, sampled from `runStartLeg` on (a resumed
// session's earlier runs may legitimately be another tier). Returns { display, serving } or null.
//
// PRESENCE-based, not majority-based: within one run a tier's presence only ever grows, so the
// report latches OFF the moment the labelled tier serves once and can never flap back on. Changing
// the display label (a /model switch) re-asks the question, which is correct.
export function servingTierReport(legModels, runStartLeg, displayName) {
  const display = ModelTier(displayName);
  if (display === null || display === 'other') return null; // absent or unmapped label → nothing to report
  const arr = Array.isArray(legModels) ? legModels : [];
  const start = Math.max(0, Number(runStartLeg) || 0);
  const counts = new Map();
  for (let i = start; i < arr.length; i++) {
    const t = ModelTier(arr[i]);
    if (t === null || t === 'other') continue; // absent / empty / 'other' never counts as a tier
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  if (counts.size === 0) return null;      // no mapped leg tier anywhere → no report against nothing
  if (counts.has(display)) return null;    // the label names a tier that really has served
  let serving = null, best = -1;
  for (const [t, n] of counts) {
    if (n > best || (n === best && familyInput(t) > familyInput(serving))) { best = n; serving = t; }
  }
  return { display, serving }; // ties break to the family whose newest model costs more — chip TEXT only, never a number
}

// Transcript MODEL SWITCH — "the served model's PRICE changed between two legs of the transcript".
// The sibling of servingTierReport: that one answers the LABEL question (does the display name
// match what served?); this one marks the per-leg-DOLLAR comparability break a real price change
// causes. Two legs differ when their MODEL_PRICES rows differ in input price or read multiplier
// (Fable 5.1 → 5.2 is a switch; Opus 4.8 → Opus 5, identical rates, is not). Derived per render from
// the banked per-leg models — never persisted — so a stats-file reset cannot destroy it and a stale
// display-based stamp cannot survive in old files.
// Walks the WHOLE banked history (pre-resume legs' dollars are still displayed at this run's rate,
// so their comparability matters). Each mapped leg is compared against the PREVIOUS mapped leg;
// unmapped models ('' / no known family) never open or close a boundary. An off-price opening leg
// IS a switch — the detector cannot distinguish "CC routed the opener" from "the user started
// elsewhere and switched", and both distort the trend reading identically. On more than one
// boundary the LATEST wins (one note, last-wins — today's semantics).
// Returns { atLeg, from, to } — atLeg = 1-based index of the first banked leg served at the new
// price; from/to = the raw transcript model strings either side of that boundary — or null.
export function modelSwitchReport(legModels) {
  const arr = Array.isArray(legModels) ? legModels : [];
  let prevIdx = -1, prevPrice = null;
  let latest = null;
  for (let i = 0; i < arr.length; i++) {
    const p = modelPrice(arr[i]);
    if (p === null) continue; // unmapped never opens or closes a boundary
    if (prevPrice !== null && (p.input !== prevPrice.input || p.read !== prevPrice.read)) {
      latest = { atLeg: i + 1, from: String(arr[prevIdx]), to: String(arr[i]) };
    }
    prevPrice = p; prevIdx = i;
  }
  return latest;
}

// Dominant cost DRIVER = the largest WEIGHTED term; the read term at the leg's own model's rate.
export function getDriver(l) {
  // Term order matches the pwsh hashtable's practical argmax; weighted ties are measure-zero
  // for real token counts, so first-seen-max is a safe, deterministic tie-break.
  const terms = [
    ['cw', l.cwUnits],
    ['cr', l.cr * readMult(l.model)],
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

// The leading verb phrase of every form getDriver can return. The status line colours the verb apart
// from the rest of the driver text, and this list is what lets it do that without re-spelling a
// single driver string: the verbs live in the file that owns the strings, so the two cannot drift.
// Ordered LONGEST FIRST, so a longest-prefix match is unambiguous.
export const DRIVER_VERBS = [
  'large fresh input',
  'opened cold',
  're-cached',
  'compacted',
  'generated',
  're-read',
  'loaded',
];

// The ONE cold-premium dollar gate, both sides. PROSPECTIVELY the status line shows a cold stake only
// at or above it; RETROSPECTIVELY a cold-shaped leg is counted in the cold tax (the `cold $x` chip,
// the sidecar's nColdLegs / coldWastedUsd, the fact sheet's COLD line, the spikes panel's ❆) only when
// its own avoidable premium — (write units − read-equivalent at the leg's model's read rate) × base,
// price-weighted — is at or above
// it. One quantity, one gate: a leg is counted after exactly when a leg its size would have been
// warned about before.
export const COLD_PREMIUM_MIN_USD = 0.25;

// Test-ColdLeg — the ONE cold SHAPE predicate, shared everywhere: an idle gap longer than the prior
// cache's TTL, and either a low read-back against the write or a collapsed warm set. It carries NO
// size floor — how much a cold leg cost is the dollar gate's question (COLD_PREMIUM_MIN_USD), asked by
// every consumer that reports money. getDriver's `re-cached … (cold — cache expired after idle)` label
// uses this ungated shape: the label says what happened, the tax counts what it cost.
export function testColdLeg(l) {
  const lowReadBack = (l.cr < l.cw * 0.5);
  const collapsed = (l.prevWarm > 0 && l.cr < l.prevWarm * 0.7);
  return l.gapToPrev != null && l.gapToPrev > l.coldTtl && (lowReadBack || collapsed);
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
// token mix -> weighted units (reads at the leg's OWN model's read multiplier — this scan reads no
// stored units, so it prices directly rather than at the storage basis), idle gap, effective-durable prior TTL, raw `model` string ('' when
// the line carries none), `ts` (epoch seconds | null), `speed` (raw usage.speed string or '').
// Placeholder lines (isSyntheticLeg) are dropped after the dedup, so they consume no leg index.
// Dedup by message.id, first-wins — HAZARD: main transcripts repeat one
// message.id per content block with byte-identical usage (verified 94/94 groups), so first-wins is
// exact here; AGENT transcripts carry PROGRESSIVE output_tokens across a group and need the
// max-wins branch in statusline.mjs's UpdateAgentRollups — never point this scan at an agent file.
// Returns [] on a missing/unreadable transcript.
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
    const units = inT * M_INPUT + cwUnits + cr * readMult(model) + out * M_OUTPUT;
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
