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
import { getScannedLegs, testColdLeg, getDriver, M_CACHE_READ } from './leg-driver.mjs';
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

// --- session-local cost (parity with the status line's costBaseline /clear fix) ---
let sessionCost = Number(snap.costUsd);
if (snap.costBaseline != null) sessionCost = Math.max(0, Number(snap.costUsd) - Number(snap.costBaseline));
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
const out = outLines.join('\n');

try { writeFileSync(join(claudeHome, '.claude', 'spikes.txt'), out, 'utf8'); } catch { /* best effort */ }

process.stdout.write(out);
process.exit(0);
