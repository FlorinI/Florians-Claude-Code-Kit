// render-spikes.mjs — top-N cost spikes with a deterministic decomposition (Layer 1, no LLM).
//
// Node port of render-spikes.ps1. The sparkline shows WHERE the spikes are; this says WHY each was
// expensive. The raw per-leg token mix isn't cached, so this re-scans the transcript on demand (via the
// shared getScannedLegs), prices the priciest legs, and labels each by its dominant cost driver. Plain
// mono text — it goes in the /handover-check markdown report. Read-only; off the hot path. Flags:
//   --top <N>   number of spikes (default 3)
//   --mono      bare glyph, no ANSI (the report path; an assistant message strips ANSI to junk)
//   --frozen    read the run-local snapshot handover-facts.mjs froze (consistent across renderers)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveSidecarPath } from './sidecar-path.mjs';
import { getScannedLegs, testColdLeg, getDriver, M_CACHE_READ, M_OUTPUT } from './leg-driver.mjs';
import { fmtN, nowEpoch, psRound } from './_sl-compat.mjs';

const argv = process.argv.slice(2);
const Mono = argv.includes('--mono');
const Frozen = argv.includes('--frozen');
const topIdx = argv.indexOf('--top');
const Top = topIdx >= 0 && argv[topIdx + 1] != null ? Number(argv[topIdx + 1]) : 3;

const ESC = '\x1b';
const MID = '·';
const claudeHome = process.env.USERPROFILE || homedir();
function done(s) { process.stdout.write(s); process.exit(0); }

// ❆ cold-tax marker. Default = deep blue (256-colour 33), matching the status line; --mono = the bare
// glyph with NO ANSI, for the report path (an assistant message strips ANSI to literal junk).
const snow = Mono ? '❆' : `${ESC}[38;5;33m❆${ESC}[0m`;

const frozen = join(claudeHome, '.claude', 'handover-frozen.json');
const sidecar = (Frozen && existsSync(frozen)) ? frozen : resolveSidecarPath(process.env.CLAUDE_PROJECT_DIR || process.cwd());
if (!sidecar || !existsSync(sidecar)) done('(no status-line snapshot yet — press Enter on an empty prompt, then re-run)');
let snap;
try { snap = JSON.parse(readFileSync(sidecar, 'utf8')); } catch { snap = null; }
if (!snap) done('(no status-line snapshot yet — press Enter on an empty prompt, then re-run)');
const tpath = snap.transcriptPath;
if (!tpath || !existsSync(tpath)) done('(no transcript path in the snapshot — render the status line once after deploying, then re-run)');

function FmtAge(sec) {
  sec = psRound(sec);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${psRound(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
  if (sec < 86400) return `${psRound(sec / 3600)}h${String(psRound((sec % 3600) / 60)).padStart(2, '0')}m`;
  return `${psRound(sec / 86400)}d${String(psRound((sec % 86400) / 3600)).padStart(2, '0')}h`;
}
// True median — even count → mean of the middle two (same semantics as statusline.mjs's Median()).
// The old upper-middle index read the FATTER of 2 agents as the median, so it rendered "1.0x med".
function median(arr) {
  const vals = arr.filter((x) => x !== null && x !== undefined).map(Number).sort((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return 0.0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2.0;
}
const sid = snap.sessionId ? String(snap.sessionId).slice(0, Math.min(8, String(snap.sessionId).length)) : '????????';
const repo = snap.gitRepo ? snap.gitRepo : '(no repo)';
let stamp;
if (snap.renderedAt) {
  const age = nowEpoch() - Number(snap.renderedAt);
  const staleTag = age > 180 ? '  ⚠ STALE' : '';
  stamp = `from session ${sid} ${MID} ${repo} ${MID} rendered ${FmtAge(age)} ago${staleTag}`;
} else {
  stamp = `from session ${sid} ${MID} ${repo} ${MID} rendered (age unknown)`;
}

// --- scan transcript via the ONE shared scan, so the panel and the fact sheet agree by construction ---
const legs = getScannedLegs(tpath);
const sumUnits = legs.reduce((a, l) => a + l.units, 0);
if (legs.length === 0 || sumUnits <= 0) done('(no priced legs in the transcript yet)');

// --- session cost — total_cost_usd IS session-local (CC resets it on /clear since 2.1.211) ---
let sessionCost = Number(snap.costUsd);
// Use the status line's DE-INFLATED base (sessionCost / (main + sub-agent units)) from the sidecar, so the
// spike $ and the avoidable cold tax reconcile with the status line. Fall back to the local main-only base
// only for pre-bsl4.0.0.0 snapshots that lack the field.
const base = snap.base != null ? Number(snap.base) : (sessionCost > 0 ? sessionCost / sumUnits : 0);

// --- top-N by cost (units is monotonic with $, base flat), oldest=leg 1 ---
const topLegs = [...legs].sort((a, b) => b.units - a.units).slice(0, Top);
let anyCold = false;
const bodyLines = [];
for (const l of topLegs) {
  const usd = '$' + fmtN(l.units * base, 2);
  let drv = getDriver(l);
  const isCold = testColdLeg(l);
  if (isCold) {
    anyCold = true;
    // Surface THIS leg's avoidable premium INSIDE the driver text: (write units − read-equivalent) × base —
    // the exact quantity the status line's cumulative tax sums.
    const legTax = (l.cwUnits - l.cw * M_CACHE_READ) * base;
    if (drv.endsWith(')')) drv = drv.slice(0, -1) + ('; $' + fmtN(legTax, 2) + ' avoidable cold tax)');
  }
  const mark = isCold ? `${snow} ` : '  ';
  bodyLines.push(`${mark} Leg ${l.idx}  ${MID}  ${usd}  ${MID}  ${drv}`);
}
const legend = anyCold ? `  ${MID}  ${snow} = counted in the cold tax` : '';
const outLines = [stamp, `top ${topLegs.length} cost spikes  ${MID}  of ${legs.length} legs  ${MID}  session-$ basis  ${MID}  leg 1 = oldest${legend}`];
outLines.push(...bodyLines);

// --- sub-agent spikes (aggregate per agent) -------------------------------------------------------
// Agents NEVER appear in the per-leg list above: the scan covers the main transcript only, and
// per-leg data is deliberately not kept for agents (aggregate-only, D2). This second table surfaces
// the FAT AGENTS instead — whole-lifetime $ per agent from the status line's agents cache, with the
// cause decomposed from the same composition weights (re-read vs loaded vs generated).
if (snap.agentsCachePath && existsSync(snap.agentsCachePath) && base > 0) {
  try {
    const acache = JSON.parse(readFileSync(snap.agentsCachePath, 'utf8'));
    const liveAg = (acache.agents || []).filter((a) => a && Number(a.legs) > 0);
    if (liveAg.length > 0) {
      const medU = median(liveAg.map((a) => Number(a.units)));
      const topAg = [...liveAg].sort((a, b) => Number(b.units) - Number(a.units)).slice(0, Top);
      const agUsd = liveAg.reduce((s, a) => s + Number(a.units), 0) * base;
      const agPct = sessionCost > 0 ? ` (${psRound(100 * agUsd / sessionCost)}%)` : '';
      // Workflow siblings can share a long identical preamble even past the TASK marker; re-window
      // colliding labels to start near their mutual divergence point so each row shows what DIFFERS.
      const groups = {};
      for (const a of topAg) { const k = String(a.label || '').slice(0, 24); (groups[k] = groups[k] || []).push(a); }
      const disp = new Map();
      for (const k of Object.keys(groups)) {
        const g = groups[k];
        if (g.length < 2 || !k) { for (const a of g) disp.set(a, String(a.label || '')); continue; }
        let cp = String(g[0].label || '');
        for (const a of g.slice(1)) { const s = String(a.label || ''); let i = 0; while (i < cp.length && i < s.length && cp[i] === s[i]) i++; cp = cp.slice(0, i); }
        for (const a of g) {
          const s = String(a.label || '');
          disp.set(a, (cp.length >= 24 && s.length > cp.length) ? '…' + s.slice(Math.max(0, cp.length - 8)) : s);
        }
      }
      const seen = {};
      const agLines = [];
      for (const a of topAg) {
        const aid = String(a.path).replace(/^.*agent-/, '').replace(/\.jsonl$/, '');
        let label = disp.get(a) || aid.slice(0, 9);
        if (label.length > 58) label = label.slice(0, 57) + '…';
        if (seen[label]) label = label.slice(0, 50) + ` [${aid.slice(0, 5)}]`;
        seen[label] = true;
        const usd = '$' + fmtN(Number(a.units) * base, 2);
        const xMed = medU > 0 ? `${fmtN(Number(a.units) / medU, 1)}x med` : '—';
        // decomposition from the stored aggregates: re-read (cache_read) / ingest (input+cache_write) / output
        const reRead = Number(a.units) - Number(a.ownUnits);
        const outU = Number(a.out) * M_OUTPUT;
        const ingest = Math.max(0, Number(a.ownUnits) - outU);
        let cause;
        if (reRead >= ingest && reRead >= outU) cause = `mostly re-reading its context (${a.legs} legs over ~${psRound(Number(a.maxCtx) / 1000)}k)`;
        else if (ingest >= outU) cause = `mostly loading content (ctx grew to ~${psRound(Number(a.maxCtx) / 1000)}k)`;
        else cause = `mostly generating output (~${psRound(Number(a.out) / 1000)}k out)`;
        const peak = Number(a.maxLegUnits) > 0 ? `  ${MID}  peak leg $${fmtN(Number(a.maxLegUnits) * base, 2)}` : '';
        agLines.push(`   "${label}"  ${MID}  ${usd}  ${MID}  ${xMed}  ${MID}  ${a.legs} legs${peak}  ${MID}  ${cause}`);
      }
      outLines.push('');
      outLines.push(`top ${topAg.length} agents  ${MID}  of ${liveAg.length}  ${MID}  $${fmtN(agUsd, 2)}${agPct}  ${MID}  whole-agent totals (agents never appear in the leg list above)`);
      outLines.push(...agLines);
    }
  } catch { /* best effort — the leg table above already rendered */ }
}
const out = outLines.join('\n');

try { writeFileSync(join(claudeHome, '.claude', 'spikes.txt'), out, 'utf8'); } catch { /* best effort */ }

process.stdout.write(out);
process.exit(0);
