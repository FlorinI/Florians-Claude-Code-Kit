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

// Get-ScannedLegs — authoritative transcript scan for the /handover-check renderers. Per-leg
// token mix -> weighted units, idle gap, effective-durable prior TTL. Dedup by message.id.
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
    idx++;
    const inT = Number(u.input_tokens) || 0;
    const cw = Number(u.cache_creation_input_tokens) || 0;
    const cr = Number(u.cache_read_input_tokens) || 0;
    const out = Number(u.output_tokens) || 0;
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
    legs.push({ idx, inT, cw, cwUnits, cr, out, units, gapToPrev, coldTtl: durablePrevTtl, prevWarm });
    prevWarm = cr + cw; // warm tokens for the NEXT leg's collapse test
    if (legTtl > 0) { recentTtls.push(legTtl); if (recentTtls.length > 8) recentTtls = recentTtls.slice(-8); }
  }
  return legs;
}
