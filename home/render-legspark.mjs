// render-legspark.mjs — deterministic WIDE per-leg cost sparkline for /handover-check.
//
// Node port of render-legspark.ps1. Reads the FULL per-leg dollar array (legCosts) from the
// status-line sidecar and renders a colored, multi-row height chart. MUST be run as a TOOL CALL
// (a script execution), not pasted as assistant text: tool-result blocks render ANSI colour; markdown
// message text does not. The status line itself is NOT touched — this only READS the sidecar.
//
// Colour/scale mirror the status line's hot bar (LegRGB anchors + 0.30 muted tint). Flags:
//   --mono            plain glyphs, no ANSI — for the always-visible markdown report
//   --avg <N>         trailing N-leg moving average (default 10); --avg 0 = raw per-leg
//   --frozen          read the run-local snapshot handover-facts.mjs froze (consistent across renderers)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveSidecarPath } from './sidecar-path.mjs';
import { psRound, mathRoundD, nowEpoch } from './_sl-compat.mjs';

const argv = process.argv.slice(2);
const Mono = argv.includes('--mono');
const Frozen = argv.includes('--frozen');
const avgIdx = argv.indexOf('--avg');
const Avg = avgIdx >= 0 && argv[avgIdx + 1] != null ? Number(argv[avgIdx + 1]) : 10;

const ESC = '\x1b';
const MID = '·';
const NDASH = '–';
const W = 100; // fixed chart width — CC exposes no terminal width to scripts; buckets if more legs
const R = 3;   // rows of vertical resolution → R*8 = 24 height levels

const claudeHome = process.env.USERPROFILE || homedir();
function done(s) { process.stdout.write(s); process.exit(0); }

// --frozen: read the run-local snapshot handover-facts.mjs froze for THIS /handover-check, so all three
// renderers see the SAME session even if a concurrent same-project session clobbers the live sidecar.
const frozen = join(claudeHome, '.claude', 'handover-frozen.json');
const sidecar = (Frozen && existsSync(frozen)) ? frozen : resolveSidecarPath(process.env.CLAUDE_PROJECT_DIR || process.cwd());
if (!sidecar || !existsSync(sidecar)) done('(no status-line snapshot yet — press Enter on an empty prompt to render one)');
let snap;
try { snap = JSON.parse(readFileSync(sidecar, 'utf8')); } catch { snap = null; }
if (!snap) done('(no status-line snapshot yet — press Enter on an empty prompt to render one)');

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

let legs = (snap.legCosts || []).filter((x) => x != null).map(Number);
if (legs.length === 0) done('(no per-leg cost data in snapshot)');

const rawPeak = Math.max(...legs); // captured before smoothing, surfaced in the header

// --- optional trailing moving average ---
if (Avg > 1) {
  legs = legs.map((_, i) => {
    const lo = Math.max(0, i - Avg + 1);
    const win = legs.slice(lo, i + 1);
    return win.reduce((a, b) => a + b, 0) / win.length;
  });
}

// --- bucket to width (raw averaging, no smoothing) ---
const n = legs.length;
let cells;
if (n <= W) {
  cells = legs;
} else {
  cells = [];
  for (let c = 0; c < W; c++) {
    const a = Math.floor(c * n / W);
    let b = Math.floor((c + 1) * n / W);
    if (b <= a) b = a + 1;
    const win = legs.slice(a, Math.min(b, n));
    cells.push(win.reduce((x, y) => x + y, 0) / win.length);
  }
}
const cols = cells.length;

// --- gradient: identical anchors to the status line's LegRGB ---
function LegRGB(cost) {
  const gA = 0.05, yA = 0.28, rA = 0.50;
  const g = [0, 215, 0], y = [215, 215, 0], r = [215, 0, 0];
  if (cost <= gA) return g;
  if (cost >= rA) return r;
  if (cost <= yA) {
    const t = (cost - gA) / (yA - gA);
    return [psRound(g[0] + (y[0] - g[0]) * t), psRound(g[1] + (y[1] - g[1]) * t), psRound(g[2] + (y[2] - g[2]) * t)];
  }
  const t = (cost - yA) / (rA - yA);
  return [psRound(y[0] + (r[0] - y[0]) * t), psRound(y[1] + (r[1] - y[1]) * t), psRound(y[2] + (r[2] - y[2]) * t)];
}

// --- heights, relative to the session peak ---
let peak = Math.max(...cells);
const min = Math.min(...cells);
if (peak <= 0) peak = 1;
const levels = R * 8;
const heights = cells.map((v) => {
  let h = psRound(v / peak * levels);
  if (v > 0 && h < 1) h = 1;
  if (h > levels) h = levels;
  return h;
});

const tint = 0.30;
const blocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// --- render rows top→bottom ---
const outRows = [];
for (let row = R - 1; row >= 0; row--) {
  let sb = '';
  if (Mono) {
    // Empty cells use a NON-BREAKING space (U+00A0): a run of literal spaces collapses in markdown,
    // sliding tall-bar glyphs out of column. NBSP is never collapsed. Block glyphs already don't collapse.
    const gap = ' ';
    for (let c = 0; c < cols; c++) {
      let portion = heights[c] - row * 8;
      if (portion < 0) portion = 0;
      if (portion > 8) portion = 8;
      sb += portion <= 0 ? gap : blocks[portion];
    }
  } else {
    let last = '_';
    for (let c = 0; c < cols; c++) {
      let portion = heights[c] - row * 8;
      if (portion < 0) portion = 0;
      if (portion > 8) portion = 8;
      let need, glyph;
      if (portion <= 0) {
        need = ''; glyph = ' ';
      } else {
        const rgb = LegRGB(cells[c]);
        const m0 = Math.trunc(rgb[0] * tint), m1 = Math.trunc(rgb[1] * tint), m2 = Math.trunc(rgb[2] * tint);
        if (portion >= 8) { need = `${ESC}[0m${ESC}[48;2;${m0};${m1};${m2}m`; glyph = ' '; }
        else { need = `${ESC}[0m${ESC}[38;2;${m0};${m1};${m2}m`; glyph = blocks[portion]; }
      }
      if (need !== last) {
        sb += need === '' ? `${ESC}[0m` : need;
        last = need;
      }
      sb += glyph;
    }
    sb += `${ESC}[0m`;
  }
  outRows.push(sb);
}

// --- header / scale legend ---
const pk = mathRoundD(peak, 2), mn = mathRoundD(min, 2);
const mode = Avg > 1 ? `trailing-${Avg}-leg avg` : 'raw';
const tail = Mono ? 'height ∝ cost (peak = full)' : `height ∝ cost (peak = full)  ${MID}  colour: grn $0.05 → ylw $0.28 → red $0.50`;
let hdr = `per-leg $/leg [${mode}]  ${MID}  oldest→newest  ${MID}  n=${n}  ${MID}  range $${mn}${NDASH}$${pk}`;
if (Avg > 1) hdr += `  ${MID}  raw peak $${mathRoundD(rawPeak, 2)}`;
hdr += `  ${MID}  ${tail}`;
if (n > W) hdr += `  ${MID}  ${n} legs → ${W} cols`;

const chart = stamp + '\n' + hdr + '\n' + outRows.join('\n');

// --- durable full copy in case the inline tool output ever clips ---
try { writeFileSync(join(claudeHome, '.claude', 'legspark.ansi'), chart, 'utf8'); } catch { /* best effort */ }

process.stdout.write(chart);
process.exit(0);
