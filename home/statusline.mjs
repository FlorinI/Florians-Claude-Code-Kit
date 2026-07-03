// statusline.mjs — the live status-line renderer.
//
// Reads the Claude Code stdin JSON, renders the multi-cluster ANSI line to stdout, and writes the
// sidecar snapshot + per-session/agent rollup caches. All numeric formatting / rounding / timestamp
// parsing goes through _sl-compat.mjs. Rendering is guarded by the Node golden test
// (tools/parity/run-parity.mjs) against committed fixtures. See docs/roadmap.md.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  nowEpoch, psRound, fmtN, mathRoundD, parseUtcEpoch, parseUtcMs,
} from './_sl-compat.mjs';
import {
  getDriver, testColdLeg,
  M_INPUT, M_CACHE_WRITE_5M, M_CACHE_WRITE_1H, M_CACHE_READ, M_OUTPUT,
} from './leg-driver.mjs';

// Status-line software version (OUR version). Rendered as a trailing `bsl<ver>` badge.
// Bump on any change that shifts what the numbers mean.
// (The installer auto-ticks the BUILD digit on deploy of a changed cluster.)
export const SL_VERSION = '4.2.7.0';

const ClaudeHome = process.env.USERPROFILE || homedir();
const NOW = nowEpoch();

let input_json = '';
try { input_json = readFileSync(0, 'utf8'); } catch {}
let d = {};
try { d = JSON.parse(input_json); } catch { d = {}; }

if (process.env.CLAUDE_STATUSLINE_DEBUG === '1') {
  try { writeFileSync(join(ClaudeHome, '.claude', 'statusline-input-sample.json'), input_json, 'utf8'); } catch {}
}

// Transcript read cap (golden-test determinism). When CLAUDE_SL_TRANSCRIPT_MAXBYTES is set, the
// rollup scan reads the transcript only up to this byte length, so a fixture replay sees a fixed view
// of the transcript. Unset (production) → read to EOF.
const TRANSCRIPT_MAXBYTES = process.env.CLAUDE_SL_TRANSCRIPT_MAXBYTES ? Number(process.env.CLAUDE_SL_TRANSCRIPT_MAXBYTES) : null;
function claudeStateDir(projRoot) {
  return projRoot ? join(projRoot, '.claude') : join(ClaudeHome, '.claude');
}

// --- helpers ---------------------------------------------------------------
const isNil = (v) => v === null || v === undefined;
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function pad2(n) { return String(n).padStart(2, '0'); }

function FmtPct(v) { return isNil(v) ? '--' : fmtN(v, 0) + '%'; }
function FmtNum(v) {
  if (isNil(v)) return '--';
  if (v >= 1e6) return fmtN(v / 1e6, 2) + 'M';
  if (v >= 1e3) return fmtN(v / 1e3, 1) + 'k';
  return fmtN(v, 0);
}
function FmtDuration(sec) {
  if (isNil(sec)) return '--';
  sec = psRound(sec);
  if (sec < 0) return 'now';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${pad2(sec % 60)}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${pad2(Math.floor((sec % 3600) / 60))}m`;
  return `${Math.floor(sec / 86400)}d${pad2(Math.floor((sec % 86400) / 3600))}h`;
}
function FmtDurShort(sec) {
  if (isNil(sec)) return '--';
  sec = Math.floor(Number(sec));
  if (sec < 0) sec = 0;
  if (sec >= 86400) { const dd = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600); return h === 0 ? `${dd}d` : `${dd}d${h}h`; }
  if (sec >= 3600) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return m === 0 ? `${h}h` : `${h}h${m}m`; }
  return `${psRound(sec / 60)}m`;
}
function Median(arr) {
  const vals = arr.filter((x) => !isNil(x)).map(Number).sort((a, b) => a - b);
  const n = vals.length;
  if (n === 0) return 0.0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return vals[mid];
  return (vals[mid - 1] + vals[mid]) / 2.0;
}

function CacheWriteMult(ttlSec) { return ttlSec >= 3600 ? M_CACHE_WRITE_1H : M_CACHE_WRITE_5M; }
function CacheWriteUnits(cw1h, cw5m, cwTotal) {
  cw1h = Number(cw1h) || 0; cw5m = Number(cw5m) || 0; cwTotal = Number(cwTotal) || 0;
  return (cw1h + cw5m) > 0 ? cw1h * M_CACHE_WRITE_1H + cw5m * M_CACHE_WRITE_5M : cwTotal * M_CACHE_WRITE_5M;
}

// Auto-compact fires at `min(autoCompactWindow, model window)`. The window is NOT in the status-line
// payload, but `/autocompact` PERSISTS the user's choice to ~/.claude/settings.json as top-level
// `autoCompactWindow`, written the instant it changes — so we read it directly (authoritative, immediate,
// no observer-effect). Three states: a NUMBER = an override; `null` = `auto`; key ABSENT = `auto`. `null`
// and absent are IDENTICAL → fall back to the model-tuned default (hence the `typeof === 'number'` test,
// never "key present"). On `auto` the default is server-delivered (~500k on the 1M models, via the
// tengu_amber_redwood3 gate) so we can't read the exact number — we estimate it and flag the estimate.
// The old behaviour (model window × 0.95) overstated 1M headroom by ~450k and never warned before
// compaction (caught live 2026-07: compacted at 466k while to-compact read 484k).
const AUTO_COMPACT_1M = 500000;   // model-tuned `auto` default for the 1M regime (estimate; drifts server-side)
function readAutoCompactWindow() {
  // Written to USER settings by /autocompact. (A project-level override would be a future refinement.)
  const s = readJson(join(ClaudeHome, '.claude', 'settings.json'));
  return (s && typeof s.autoCompactWindow === 'number') ? s.autoCompactWindow : null;
}
// Effective auto-compact window + whether it's an ESTIMATE (on `auto`, using the default) vs an
// authoritative override we read from settings.
function CompactWindow(ctxSize) {
  const set = readAutoCompactWindow();
  if (typeof set === 'number') return { win: Math.min(set, ctxSize), estimate: false };
  if (ctxSize >= 700000) return { win: AUTO_COMPACT_1M, estimate: true };   // 1M on `auto` → estimated default
  return { win: ctxSize, estimate: false };                                 // 200k `auto` ≈ the model window
}
function CompactAt(ctxSize) { return psRound(CompactWindow(ctxSize).win * 0.95); }

// --- ANSI color helpers ----------------------------------------------------
const ESC = '\x1b';
const Dim = (t) => `${ESC}[2m${t}${ESC}[0m`;
const Bold = (t) => `${ESC}[1m${t}${ESC}[0m`;
const Red = (t) => `${ESC}[31m${t}${ESC}[0m`;
const Green = (t) => `${ESC}[32m${t}${ESC}[0m`;
const Yellow = (t) => `${ESC}[33m${t}${ESC}[0m`;
const Cyan = (t) => `${ESC}[36m${t}${ESC}[0m`;
const RedBold = (t) => `${ESC}[1;31m${t}${ESC}[0m`;
const White = (t) => `${ESC}[97m${t}${ESC}[0m`;
const Orange = (t) => `${ESC}[38;5;208m${t}${ESC}[0m`;
const Magenta = (t) => `${ESC}[95m${t}${ESC}[0m`;
const BrightCyan = (t) => `${ESC}[96m${t}${ESC}[0m`;
const DarkGray = (t) => `${ESC}[38;5;240m${t}${ESC}[0m`;
const DimWhite = (t) => `${ESC}[38;5;250m${t}${ESC}[0m`;
const ColdBlue = (t) => `${ESC}[38;5;33m${t}${ESC}[0m`;
const BoldBright = (t) => `${ESC}[1;97m${t}${ESC}[0m`;

function ColorEffort(lvl) {
  switch (lvl) {
    case 'low': return `${ESC}[38;5;220m${lvl}${ESC}[0m`;
    case 'medium': return `${ESC}[38;5;40m${lvl}${ESC}[0m`;
    case 'high': return `${ESC}[38;5;147m${lvl}${ESC}[0m`;
    case 'xhigh': return `${ESC}[38;5;61m${lvl}${ESC}[0m`;
    case 'max': return `${ESC}[1;38;5;255mMAX${ESC}[0m`;
    default: return lvl;
  }
}
function ColorCost(v, text) {
  if (isNil(v)) return text;
  if (v < 1) return Dim(text);
  if (v <= 5) return text;
  if (v <= 10) return White(text);
  if (v <= 20) return Yellow(text);
  if (v <= 50) return Orange(text);
  return RedBold(text);
}
function ColorByTokenCount(tokens, text) {
  if (isNil(tokens)) return text;
  if (tokens < 32000) return `${ESC}[38;5;46m${text}${ESC}[0m`;
  if (tokens < 128000) return `${ESC}[38;5;40m${text}${ESC}[0m`;
  if (tokens < 256000) return Yellow(text);
  if (tokens < 500000) return Orange(text);
  return RedBold(text);
}
function ColorHigh(v, text, okMax, warnMax) {
  if (isNil(v)) return text;
  if (v < okMax) return Green(text);
  if (v < warnMax) return Yellow(text);
  return RedBold(text);
}
function ColorLow(v, text, okMin, warnMin) {
  if (isNil(v)) return text;
  if (v > okMin) return Green(text);
  if (v > warnMin) return Yellow(text);
  return RedBold(text);
}

function LegRGB(cost) {
  const greenAnchor = 0.05, yellowAnchor = 0.28, redAnchor = 0.50;
  const g = [0, 215, 0], y = [215, 215, 0], r = [215, 0, 0];
  if (cost <= greenAnchor) return g;
  if (cost >= redAnchor) return r;
  if (cost <= yellowAnchor) {
    const t = (cost - greenAnchor) / (yellowAnchor - greenAnchor);
    return [psRound(g[0] + (y[0] - g[0]) * t), psRound(g[1] + (y[1] - g[1]) * t), psRound(g[2] + (y[2] - g[2]) * t)];
  }
  const t = (cost - yellowAnchor) / (redAnchor - yellowAnchor);
  return [psRound(y[0] + (r[0] - y[0]) * t), psRound(y[1] + (r[1] - y[1]) * t), psRound(y[2] + (r[2] - y[2]) * t)];
}
function ColorLegCell(cost, text) {
  if (isNil(cost)) return text;
  const rgb = LegRGB(cost);
  return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${ESC}[0m`;
}

const BAND_GREEN = [0, 200, 0];
const BAND_YELLOW = [220, 200, 0];
const BAND_ORANGE = [255, 140, 0];
const BAND_RED = [210, 0, 0];
function BgTint(rgb, text) {
  const m0 = psRound(rgb[0] * 0.30), m1 = psRound(rgb[1] * 0.30), m2 = psRound(rgb[2] * 0.30);
  return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]};48;2;${m0};${m1};${m2}m ${text} ${ESC}[0m`;
}
function BgFill(pct, text) {
  if (isNil(pct)) return Dim(text);
  if (pct < 50) return BgTint(BAND_GREEN, text);
  if (pct < 70) return BgTint(BAND_YELLOW, text);
  if (pct < 85) return BgTint(BAND_ORANGE, text);
  return BgTint(BAND_RED, text);
}
function Froz5RGB(ratio) {
  const stops = [
    [0.5, BAND_GREEN],
    [1.0, [230, 230, 230]],
    [1.8, BAND_YELLOW],
    [2.8, BAND_ORANGE],
    [3.8, BAND_RED],
  ];
  if (ratio <= stops[0][0]) return stops[0][1];
  if (ratio >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i], hi = stops[i + 1];
    if (ratio <= hi[0]) {
      const t = (ratio - lo[0]) / (hi[0] - lo[0]);
      const a = lo[1], b = hi[1];
      return [psRound(a[0] + (b[0] - a[0]) * t), psRound(a[1] + (b[1] - a[1]) * t), psRound(a[2] + (b[2] - a[2]) * t)];
    }
  }
  return stops[stops.length - 1][1];
}
function BgFroz5(ratio, text) {
  if (isNil(ratio)) return Dim(text);
  return BgTint(Froz5RGB(ratio), text);
}

const DIM_SEP = Dim(' | ');

// === Per-session cumulative-token rollups (incremental transcript scan) =====
function UpdateSessionRollups(sessionId, tpath, currentCost, projRoot) {
  if (!sessionId || !tpath || !existsSync(tpath)) return null;
  const statsDir = join(claudeStateDir(projRoot), 'statusline-stats');
  try { if (!existsSync(statsDir)) mkdirSync(statsDir, { recursive: true }); } catch {}
  const statsPath = join(statsDir, sessionId + '.json');
  let r = existsSync(statsPath) ? readJson(statsPath) : null;
  const hadPrior = r !== null;
  const freshRollup = () => ({
    lastByteOffset: 0, nLegs: 0, sumUnits: 0, sumOutputTokens: 0, lastMsgId: '',
    lastInputBilled: 0, lastOutputTokens: 0, lastSeenCost: 0, lastLegCost: null,
    perLegUnits: [], perLegOwnUnits: [], costBaseline: null, lastLegTs: null, lastWarm: 0,
    nColdLegs: 0, coldWastedUnits: 0, lastColdLegIdx: 0, lastColdWastedUnits: 0,
    lastLegTtlSec: 0, recentWriteTtls: [], recentLegs: [],
  });
  if (!hadPrior) r = freshRollup();

  const requiredFields = ['lastByteOffset', 'nLegs', 'sumUnits', 'sumOutputTokens',
    'lastMsgId', 'lastInputBilled', 'lastOutputTokens', 'lastSeenCost',
    'lastLegCost', 'perLegUnits', 'perLegOwnUnits', 'costBaseline'];
  const priorBaseline = ('costBaseline' in r) ? r.costBaseline : null;
  let needsReset = false;
  for (const f of requiredFields) { if (!(f in r)) { needsReset = true; break; } }
  if (needsReset) {
    r = freshRollup();
    r.costBaseline = (priorBaseline !== null) ? priorBaseline : 0;
  }
  if (isNil(r.perLegUnits)) r.perLegUnits = [];
  if (isNil(r.perLegOwnUnits)) r.perLegOwnUnits = [];
  // Patch additive cold-cache fields onto an existing (non-reset) rollup that predates them.
  if (!('lastLegTs' in r)) r.lastLegTs = null;
  if (!('lastWarm' in r)) r.lastWarm = 0;
  if (!('nColdLegs' in r)) r.nColdLegs = 0;
  if (!('coldWastedUnits' in r)) r.coldWastedUnits = 0;
  if (!('lastColdLegIdx' in r)) r.lastColdLegIdx = 0;
  if (!('lastColdWastedUnits' in r)) {
    r.lastColdWastedUnits = (Number(r.nColdLegs) === 1) ? Number(r.coldWastedUnits) : 0;
  }
  if (!('lastLegTtlSec' in r)) r.lastLegTtlSec = 0;
  if (!('recentWriteTtls' in r)) r.recentWriteTtls = [];
  if (!('recentLegs' in r)) r.recentLegs = [];
  const skipLastLegCost = needsReset;
  const nLegsBefore = Number(r.nLegs);

  try {
    if (existsSync(tpath)) {
      let fileBuf = readFileSync(tpath);
      if (TRANSCRIPT_MAXBYTES != null && fileBuf.length > TRANSCRIPT_MAXBYTES) fileBuf = fileBuf.subarray(0, TRANSCRIPT_MAXBYTES);
      const totalLen = fileBuf.length;
      if (Number(r.lastByteOffset) > totalLen) {
        r.lastByteOffset = 0; r.nLegs = 0; r.sumUnits = 0; r.sumOutputTokens = 0;
        r.lastInputBilled = 0; r.lastOutputTokens = 0; r.perLegUnits = []; r.perLegOwnUnits = [];
        if ('recentWriteTtls' in r) r.recentWriteTtls = [];
        if ('recentLegs' in r) r.recentLegs = [];
        if ('lastWarm' in r) r.lastWarm = 0;
      }
      if (Number(r.lastByteOffset) < totalLen) {
        const newText = fileBuf.subarray(Number(r.lastByteOffset)).toString('utf8');
        const lastNl = newText.lastIndexOf('\n');
        if (lastNl >= 0) {
          const processable = newText.substring(0, lastNl + 1);
          const consumedBytes = Buffer.byteLength(processable, 'utf8');
          for (let line of processable.split('\n')) {
            line = line.trim();
            if (!line) continue;
            if (!/"type"\s*:\s*"assistant"/.test(line)) continue;
            try {
              const p = JSON.parse(line);
              if (p.type !== 'assistant') continue;
              const msgId = p?.message?.id;
              if (!msgId || msgId === r.lastMsgId) continue;
              const u = p?.message?.usage;
              if (!u) continue;
              const inTok = Number(u.input_tokens) || 0;
              const cwTok = Number(u.cache_creation_input_tokens) || 0;
              const crTok = Number(u.cache_read_input_tokens) || 0;
              const outTok = Number(u.output_tokens) || 0;
              const cw1h = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
              const cw5m = Number(u.cache_creation?.ephemeral_5m_input_tokens) || 0;
              const legTtlSec = cw1h > 0 ? 3600 : (cw5m > 0 ? 300 : 0);
              const cwUnits = CacheWriteUnits(cw1h, cw5m, cwTok);
              const units = inTok * M_INPUT + cwUnits + crTok * M_CACHE_READ + outTok * M_OUTPUT;
              const ownUnits = inTok * M_INPUT + cwUnits + outTok * M_OUTPUT;
              r.nLegs = Number(r.nLegs) + 1;
              r.sumUnits = Number(r.sumUnits) + units;
              r.sumOutputTokens = Number(r.sumOutputTokens) + outTok;
              r.lastMsgId = msgId;
              r.lastInputBilled = inTok + cwTok + crTok;
              r.lastOutputTokens = outTok;
              r.perLegUnits.push(units);
              r.perLegOwnUnits.push(ownUnits);
              let legTs = null;
              if (p.timestamp) legTs = parseUtcEpoch(p.timestamp);
              const prevWarm = Number(r.lastWarm); // tokens warm one leg ago
              if (legTs != null && r.lastLegTs != null) {
                const gap = legTs - Number(r.lastLegTs);
                const prevTtl = Number(r.lastLegTtlSec) > 0 ? Number(r.lastLegTtlSec) : 300;
                const blBigRewrite = (cwTok >= 50000 && crTok < 0.5 * cwTok);
                const blCollapsed = (prevWarm > 0 && crTok < prevWarm * 0.7);
                if (gap > prevTtl && cwTok >= 8000 && (blBigRewrite || blCollapsed)) {
                  const thisColdWaste = cwUnits - (cwTok * M_CACHE_READ);
                  r.nColdLegs = Number(r.nColdLegs) + 1;
                  r.coldWastedUnits = Number(r.coldWastedUnits) + thisColdWaste;
                  r.lastColdWastedUnits = thisColdWaste;
                  r.lastColdLegIdx = Number(r.nLegs);
                }
              }
              if (!('recentLegs' in r)) r.recentLegs = [];
              const blGap = (legTs != null && r.lastLegTs != null) ? legTs - Number(r.lastLegTs) : null;
              const blTtl = Number(r.lastLegTtlSec) > 0 ? Number(r.lastLegTtlSec) : 300;
              r.recentLegs.push({ idx: Number(r.nLegs), inT: inTok, cw: cwTok, cwUnits, cr: crTok, out: outTok, units, gapToPrev: blGap, coldTtl: blTtl, prevWarm });
              if (r.recentLegs.length > 12) r.recentLegs = r.recentLegs.slice(-12);
              if (legTs != null) r.lastLegTs = legTs;
              r.lastWarm = crTok + cwTok;
              if (legTtlSec > 0) {
                if (!('recentWriteTtls' in r)) r.recentWriteTtls = [];
                r.recentWriteTtls.push(legTtlSec);
                if (r.recentWriteTtls.length > 8) r.recentWriteTtls = r.recentWriteTtls.slice(-8);
                r.lastLegTtlSec = r.recentWriteTtls.includes(3600) ? 3600 : 300;
              }
            } catch {}
          }
          r.lastByteOffset = Number(r.lastByteOffset) + consumedBytes;
        }
      }
    }
  } catch {}

  if (hadPrior && !skipLastLegCost && Number(r.nLegs) > nLegsBefore) {
    const delta = Number(currentCost) - Number(r.lastSeenCost);
    if (delta > 0) r.lastLegCost = delta;
  }
  if (('costBaseline' in r) && r.costBaseline !== null && Number(r.costBaseline) > Number(currentCost)) {
    r.costBaseline = null;
  }
  if (('costBaseline' in r) && r.costBaseline === null && Number(r.nLegs) > 0) {
    r.costBaseline = (Number(r.nLegs) <= 5) ? Number(currentCost) : 0;
  }
  r.lastSeenCost = Number(currentCost);

  try { writeFileSync(statsPath, JSON.stringify(r, null, 2), 'utf8'); } catch {}

  if (!hadPrior) {
    try {
      const cutoff = NOW - 7 * 86400;
      const self = sessionId + '.json';
      for (const name of readdirSync(statsDir)) {
        if (!name.endsWith('.json') || name === self) continue;
        try {
          const fp = join(statsDir, name);
          if (statSync(fp).mtimeMs / 1000 < cutoff) rmSync(fp, { force: true });
        } catch {}
      }
    } catch {}
  }
  return r;
}

// === Sub-agent cost rollup =================================================
const AGENT_SCAN_THROTTLE = 15;
function walkAgentFiles(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) walkAgentFiles(fp, out);
    else if (e.isFile() && /^agent-.*\.jsonl$/.test(e.name)) out.push(fp);
  }
}
// Agent label = the task, read from the agent's FIRST user message (the parent-issued prompt). The
// transcript carries no harness metadata (no description/label field), so prompt text is the only
// in-file source. Boilerplate openers are stripped so the task shows from the first character.
function agentLabelFromText(s) {
  if (!s) return '';
  let t = String(s).replace(/\s+/g, ' ').trim();
  // Structured prompts (workflow fan-outs especially) bury the task after a long SHARED preamble;
  // measured on real siblings, divergence starts right at a "TASK:" marker — prefer the text after it.
  const m = t.match(/\b(?:your )?task\b\s*(?:\([^)]{0,60}\))?\s*[:—–]\s*/i);
  if (m && t.length - (m.index + m[0].length) >= 12) t = t.slice(m.index + m[0].length);
  t = t.replace(/^you are (an? |the )?/i, '').replace(/^context\s*[—:–-]+\s*/i, '');
  t = t.replace(/^[#*`>\s]+/, '');
  return t.slice(0, 160);
}
function agentLabelFromEntry(p) {
  const c = p?.message?.content;
  if (typeof c === 'string') return agentLabelFromText(c);
  if (Array.isArray(c)) { for (const b of c) { if (b && b.type === 'text' && typeof b.text === 'string') return agentLabelFromText(b.text); } }
  return '';
}
// One-time backfill for cache entries scanned before labels existed: read only the file head.
function agentLabelFromFileHead(fp) {
  try {
    const fd = openSync(fp, 'r');
    const buf = Buffer.alloc(262144);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t || !/"type"\s*:\s*"user"/.test(t)) continue;
      try { const p = JSON.parse(t); if (p.type === 'user') { const l = agentLabelFromEntry(p); if (l) return l; } } catch {}
    }
  } catch {}
  return '';
}
function agentIdFromPath(fp) { return String(fp).replace(/^.*agent-/, '').replace(/\.jsonl$/, '').slice(0, 9); }
function UpdateAgentRollups(sessionId, tpath, projRoot) {
  if (!sessionId || !tpath) return null;
  const subDir = tpath.replace(/\.jsonl$/, '') + require_sep() + 'subagents';
  if (!existsSync(subDir)) return null;
  const statsDir = join(claudeStateDir(projRoot), 'statusline-stats');
  try { if (!existsSync(statsDir)) mkdirSync(statsDir, { recursive: true }); } catch {}
  const cachePath = join(statsDir, sessionId + '.agents.json');
  let cache = existsSync(cachePath) ? readJson(cachePath) : null;
  if (cache === null || !('agents' in cache)) cache = { lastScanTs: 0, agents: [] };
  if (isNil(cache.agents)) cache.agents = [];
  const nEpoch = NOW;
  const byPath = {};
  for (const a of cache.agents) { if (a && a.path) byPath[String(a.path)] = a; }
  const doScan = (cache.agents.length === 0) || ((nEpoch - Number(cache.lastScanTs)) >= AGENT_SCAN_THROTTLE);
  if (doScan) {
    try {
      const files = [];
      walkAgentFiles(subDir, files);
      for (const fp of files) {
        let e = byPath[fp];
        if (!e) { e = { path: fp, offset: 0, units: 0, ownUnits: 0, legs: 0, out: 0, maxCtx: 0, maxLegUnits: 0, label: '', lastMsgId: '' }; byPath[fp] = e; }
        let len = 0; try { len = statSync(fp).size; } catch {}
        if (Number(e.offset) > len) { e.offset = 0; e.units = 0; e.ownUnits = 0; e.legs = 0; e.out = 0; e.maxCtx = 0; e.maxLegUnits = 0; e.label = ''; e.lastMsgId = ''; }
        if (Number(e.offset) < len) {
          try {
            const buf = readFileSync(fp);
            const txt = buf.subarray(Number(e.offset)).toString('utf8');
            const lastNl = txt.lastIndexOf('\n');
            if (lastNl >= 0) {
              const proc = txt.substring(0, lastNl + 1);
              const consumed = Buffer.byteLength(proc, 'utf8');
              for (let line of proc.split('\n')) {
                line = line.trim();
                if (!line) continue;
                if (!e.label && /"type"\s*:\s*"user"/.test(line)) {
                  try { const up = JSON.parse(line); if (up.type === 'user') { const lbl = agentLabelFromEntry(up); if (lbl) e.label = lbl; } } catch {}
                  continue;
                }
                if (!/"type"\s*:\s*"assistant"/.test(line)) continue;
                try {
                  const p = JSON.parse(line);
                  if (p.type !== 'assistant') continue;
                  const mid = p?.message?.id;
                  if (!mid || mid === e.lastMsgId) continue;
                  const u = p?.message?.usage;
                  if (!u) continue;
                  const inTok = Number(u.input_tokens) || 0, cwTok = Number(u.cache_creation_input_tokens) || 0;
                  const crTok = Number(u.cache_read_input_tokens) || 0, outTok = Number(u.output_tokens) || 0;
                  const cwUnits = CacheWriteUnits(u.cache_creation?.ephemeral_1h_input_tokens, u.cache_creation?.ephemeral_5m_input_tokens, cwTok);
                  const legU = inTok * M_INPUT + cwUnits + crTok * M_CACHE_READ + outTok * M_OUTPUT;
                  e.units = Number(e.units) + legU;
                  e.ownUnits = Number(e.ownUnits) + (inTok * M_INPUT + cwUnits + outTok * M_OUTPUT);
                  if (legU > Number(e.maxLegUnits || 0)) e.maxLegUnits = legU;
                  e.legs = Number(e.legs) + 1;
                  e.out = Number(e.out) + outTok;
                  const ctx = inTok + cwTok + crTok;
                  if (ctx > Number(e.maxCtx)) e.maxCtx = ctx;
                  e.lastMsgId = mid;
                } catch {}
              }
              e.offset = Number(e.offset) + consumed;
            }
          } catch {}
        }
        if (!e.label) e.label = agentLabelFromFileHead(fp) || agentIdFromPath(fp);
      }
      cache.lastScanTs = nEpoch;
      cache.agents = Object.values(byPath);
      try { writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8'); } catch {}
    } catch {}
  }
  const live = cache.agents.filter((a) => a && Number(a.legs) > 0);
  if (live.length === 0) return null;
  let sumUnits = 0, sumLegs = 0, sumOut = 0, sumMaxCtx = 0, maxCtx = 0, maxUnits = 0;
  const ctxList = [];
  for (const a of live) {
    sumUnits += Number(a.units); sumLegs += Number(a.legs); sumOut += Number(a.out);
    sumMaxCtx += Number(a.maxCtx); ctxList.push(Number(a.maxCtx));
    if (Number(a.maxCtx) > maxCtx) maxCtx = Number(a.maxCtx);
    if (Number(a.units) > maxUnits) maxUnits = Number(a.units);
  }
  const ctxSorted = ctxList.slice().sort((x, y) => x - y);
  const medCtx = ctxSorted[Math.floor(ctxSorted.length / 2)];
  return { nAgents: live.length, sumUnits, sumLegs, sumOut, sumMaxCtx, medCtx, maxCtx, maxUnits, cachePath };
}
function require_sep() { return process.platform === 'win32' ? '\\' : '/'; }

// === Cluster 1: model + flags ==============================================
const model = (d?.model?.display_name) ? d.model.display_name : 'unknown';
const version = d?.version;
const effort = (d?.effort?.level) ? d.effort.level : '?';
const style = (d?.output_style?.name) ? d.output_style.name : 'default';
const fast = d?.fast_mode;
const thinking = d?.thinking?.enabled;

const line1Parts = [];
const modelLabel = version ? Bold(model) + Dim(` v${version}`) : Bold(model);
line1Parts.push(modelLabel);
line1Parts.push(Dim('effort:') + ColorEffort(effort));
if (!isNil(fast)) line1Parts.push(Dim('fast:') + (fast ? Magenta('on') : 'off'));
if (!isNil(thinking)) line1Parts.push(Dim('think:') + (thinking ? 'on' : BrightCyan('off')));
if (style && style !== 'default') line1Parts.push(Dim('style:') + style);
line1Parts.push(DarkGray(`bsl${SL_VERSION}`));
const line1 = line1Parts.join(DIM_SEP);

// === Cluster 2: context window =============================================
const ctxPct = d?.context_window?.used_percentage;
const ctxUsed = d?.context_window?.total_input_tokens;
const ctxSize = d?.context_window?.context_window_size;
const ctxParts = [];
if (!isNil(ctxUsed) && !isNil(ctxSize)) {
  ctxParts.push(Dim('ctx ') + ColorByTokenCount(ctxUsed, FmtNum(ctxUsed)) + Dim('/' + FmtNum(ctxSize)));
}
if (!isNil(ctxPct)) ctxParts.push(BgFill(ctxPct, FmtPct(ctxPct)));
if (!isNil(ctxUsed) && !isNil(ctxSize)) {
  const cw = CompactWindow(ctxSize);
  const compactAt = psRound(cw.win * 0.95);
  const remaining = compactAt - ctxUsed;
  // `~` = the window is an ESTIMATE (on `auto`, using the model-tuned default) — shown ONLY when it's also
  // near the bar (yellow/red, remaining < 200k), so a calm line never carries it and an authoritative
  // override (a real number read from settings) never marks. One glyph, event-gated.
  const est = (cw.estimate && remaining < 200000) ? '~' : '';
  if (remaining > 0) ctxParts.push(Dim('to-compact ') + ColorLow(remaining, est + FmtNum(remaining), 200000, 50000));
  else ctxParts.push(RedBold('to-compact ' + est + 'NOW'));
}
const absLvl = isNil(ctxUsed) ? 0 : (ctxUsed < 128000 ? 0 : ctxUsed < 256000 ? 1 : ctxUsed < 500000 ? 2 : 3);
const fillLvl = isNil(ctxPct) ? 0 : (ctxPct < 50 ? 0 : ctxPct < 70 ? 1 : ctxPct < 85 ? 2 : 3);
const advWorst = Math.max(absLvl, fillLvl);
if (advWorst >= 1 && ctxParts.length > 0) {
  const advLvl = (absLvl === fillLvl) ? advWorst : advWorst - 1;
  const advFlag = advLvl === 3 ? RedBold('⚑') : advLvl === 2 ? Orange('⚑') : advLvl === 1 ? Yellow('⚑') : DimWhite('⚑');
  ctxParts.push(advFlag + Dim(' /handover-check'));
}
const line2 = ctxParts.length > 0 ? ctxParts.join(DIM_SEP) : null;

// === Cluster 3: cost density ===============================================
const cacheParts = [];
const tpath = d?.transcript_path;
const sessionId = d?.session_id;
const costUsd = d?.cost?.total_cost_usd;
const ctxTok = d?.context_window?.total_input_tokens;
const cwd = (d?.workspace?.current_dir) ? d.workspace.current_dir : d?.cwd;

if (!isNil(costUsd)) cacheParts.push(ColorCost(costUsd, '$' + fmtN(costUsd, 2)));
let rollup = null;
if (sessionId && tpath && !isNil(costUsd)) rollup = UpdateSessionRollups(sessionId, tpath, costUsd, cwd);

let sessionCost = costUsd;
if (rollup && ('costBaseline' in rollup) && rollup.costBaseline !== null) {
  sessionCost = Number(costUsd) - Number(rollup.costBaseline);
  if (sessionCost < 0) sessionCost = 0;
}
let agentAgg = null;
if (sessionId && tpath) { try { agentAgg = UpdateAgentRollups(sessionId, tpath, cwd); } catch {} }
const agentUnits = agentAgg ? Number(agentAgg.sumUnits) : 0;
const mainUnits = rollup ? Number(rollup.sumUnits) : 0;
const totalUnits = mainUnits + agentUnits;
let agentsUsd = null, mainSessionUsd = null, baseTrue = null;
if (totalUnits > 0 && sessionCost > 0) {
  baseTrue = Number(sessionCost) / totalUnits;
  mainSessionUsd = baseTrue * mainUnits;
  agentsUsd = baseTrue * agentUnits;
}
let perLegCostArr = [];
let nextPart = null;
if (rollup && !isNil(rollup.perLegUnits) && Number(rollup.sumUnits) > 0 && sessionCost > 0) {
  const base = Number(sessionCost) / totalUnits;
  perLegCostArr = rollup.perLegUnits.map((u) => base * Number(u));
}
let forecast = null, ratio = null, freshBaseline = null;
if (rollup && sessionCost > 0 && Number(rollup.nLegs) > 0
  && Number(rollup.sumUnits) > 0 && !isNil(ctxTok) && ctxTok > 0) {
  const base = Number(sessionCost) / totalUnits;
  const floorUnits = M_CACHE_READ * Number(ctxTok);
  const ownArr = rollup.perLegOwnUnits.slice();
  const ownTail = ownArr.length > 5 ? ownArr.slice(ownArr.length - 5) : ownArr;
  const nextUnits = floorUnits + Median(ownTail);
  forecast = base * nextUnits;
  const unitsArr = rollup.perLegUnits.slice();
  const bn = Math.min(5, unitsArr.length);
  let freshUnits = 0; for (let i = 0; i < bn; i++) freshUnits += Number(unitsArr[i]);
  if (bn > 0) freshUnits = freshUnits / bn;
  freshBaseline = freshUnits > 0 ? base * freshUnits : null;
  ratio = freshUnits > 0 ? nextUnits / freshUnits : null;
  const forecastStr = '$' + fmtN(forecast, 2);
  let part = Dim('next ') + ColorLegCell(forecast, forecastStr);
  if (!isNil(ratio)) {
    const ratioStr = fmtN(ratio, 1) + 'x';
    const freshStr = '$' + fmtN(freshBaseline, 2);
    part += Dim(' =') + BgFroz5(ratio, ratioStr) + Dim(`${freshStr} (fresh)`);
  }
  nextPart = part;
}
if (rollup && !isNil(rollup.lastLegCost) && Number(rollup.lastLegCost) > 0) {
  const ltc = Number(rollup.lastLegCost);
  cacheParts.push(Dim('last leg ') + ColorLegCell(ltc, '$' + fmtN(ltc, 2)));
}
if (nextPart) cacheParts.push(nextPart);

// === Cold-cache stats line =================================================
const snow = '❆ ';
let coldMarkerCol = '2';
let coldStakes = null, coldRemain = null, coldBand = null;
let coldRecent = false;
const RECENT_COLD_WINDOW = 8;
const coldParts = [];
if (rollup && Number(rollup.nColdLegs) >= 1 && Number(rollup.sumUnits) > 0 && sessionCost > 0) {
  const coldBaseRate = Number(sessionCost) / totalUnits;
  const coldTax = coldBaseRate * Number(rollup.coldWastedUnits);
  const nCold = Number(rollup.nColdLegs);
  const taxPct = (!isNil(costUsd) && Number(costUsd) > 0) ? psRound(100.0 * coldTax / Number(costUsd)) : 0;
  const nL = Number(rollup.nLegs);
  coldParts.push(Dim('Tax ') + Dim(taxPct.toString() + '% (') + ColorCost(coldTax, '$' + fmtN(coldTax, 2)) + Dim(')'));
  const lastColdIdx = ('lastColdLegIdx' in rollup) ? Number(rollup.lastColdLegIdx) : 0;
  const legsAgo = lastColdIdx > 0 ? nL - lastColdIdx : 9999;
  coldRecent = (lastColdIdx > 0 && legsAgo < RECENT_COLD_WINDOW);
  if (coldRecent) {
    let lastColdUnits = ('lastColdWastedUnits' in rollup) ? Number(rollup.lastColdWastedUnits) : 0;
    if (lastColdUnits <= 0 && nCold === 1) lastColdUnits = Number(rollup.coldWastedUnits);
    const lastColdTax = coldBaseRate * lastColdUnits;
    if (lastColdTax >= 0.005) {
      const recencyTag = legsAgo <= 0 ? 'just paid' : legsAgo === 1 ? '1 leg ago' : `${legsAgo} legs ago`;
      coldParts.push(`${ESC}[38;5;33m$${fmtN(lastColdTax, 2)} ${recencyTag}${ESC}[0m`);
    }
  }
  const legPct = nL > 0 ? psRound(100.0 * nCold / nL) : 0;
  coldParts.push(Dim(`legs ${nCold}/${nL} (${legPct}%)`));
}
if (rollup && !isNil(ctxTok) && ctxTok > 0 && Number(rollup.sumUnits) > 0 && sessionCost > 0) {
  const coldBase = Number(sessionCost) / totalUnits;
  const ttlSec = ('lastLegTtlSec' in rollup && Number(rollup.lastLegTtlSec) > 0) ? Number(rollup.lastLegTtlSec) : 300;
  coldStakes = coldBase * Number(ctxTok) * (CacheWriteMult(ttlSec) - M_CACHE_READ);
  if (coldStakes >= 0.25) {
    const stakesStr = '+$' + fmtN(coldStakes, 2);
    if (!isNil(rollup.lastLegTs)) {
      const nEpoch = NOW;
      coldRemain = ttlSec - (nEpoch - Number(rollup.lastLegTs));
      if (coldRemain > 0) {
        let wCol, tCol, amtBright;
        if (ttlSec >= 3600) {
          wCol = coldRemain > 2400 ? '2' : '38;5;33';
          tCol = coldRemain > 2400 ? '2' : coldRemain > 1200 ? '38;5;33'
            : coldRemain > 600 ? '97' : coldRemain > 300 ? '38;5;220'
              : coldRemain > 120 ? '38;5;208' : '1;31';
          amtBright = (coldRemain <= 600);
        } else {
          wCol = coldRemain > 240 ? '2' : '38;5;33';
          tCol = coldRemain > 240 ? '2' : coldRemain > 180 ? '97'
            : coldRemain > 120 ? '38;5;220' : coldRemain > 60 ? '38;5;208' : '1;31';
          amtBright = (coldRemain <= 180);
        }
        coldBand = ttlSec >= 3600
          ? (coldRemain > 2400 ? 'calm' : coldRemain > 600 ? 'heads-up' : coldRemain > 300 ? 'act-soon' : 'urgent')
          : (coldRemain > 240 ? 'calm' : coldRemain > 120 ? 'heads-up' : coldRemain > 60 ? 'act-soon' : 'urgent');
        coldMarkerCol = wCol;
        const amt = amtBright ? ColorLegCell(coldStakes, stakesStr) : Dim(stakesStr);
        if (wCol !== '2') {
          coldParts.push(`${ESC}[${wCol}mcold${ESC}[0m${ESC}[${tCol}m in ${FmtDuration(psRound(coldRemain))} ${ESC}[0m` + amt);
        }
      } else {
        const ttlLabel = ttlSec >= 3600 ? '>1h' : '>5m';
        coldBand = 'expired';
        coldMarkerCol = '38;5;33';
        coldParts.push(ColdBlue('cold?') + `${ESC}[1;31m ${ttlLabel} ${ESC}[0m` + ColorLegCell(coldStakes, stakesStr));
      }
    } else {
      coldBand = 'expired';
      coldMarkerCol = '38;5;33';
      coldParts.push(ColdBlue('cold') + Dim(' risk ') + ColorLegCell(coldStakes, stakesStr));
    }
  }
}
if (coldRecent && coldMarkerCol === '2') coldMarkerCol = '38;5;33';

// === Full-turn TPS =========================================================
const tailBytes = 2097152;
let tailWarning = false;
let tpsRendered = null;
let tps = null;
if (tpath && existsSync(tpath)) {
  try {
    const fileBuf = readFileSync(tpath);
    const len = fileBuf.length;
    const tailSize = Math.min(tailBytes, len);
    const tail = fileBuf.subarray(len - tailSize).toString('utf8');
    const lines = tail.split('\n');
    const startIdx = len > tailSize ? 1 : 0;
    let latestUserMs = null, latestUserIdx = -1;
    for (let i = lines.length - 1; i >= startIdx; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      if (!/"type"\s*:\s*"user"/.test(line)) continue;
      if (!/"timestamp"/.test(line)) continue;
      if (/"tool_result"/.test(line)) continue;
      if (/"isMeta"\s*:\s*true/.test(line)) continue;
      if (/"origin"\s*:\s*\{/.test(line)) continue;
      const lastTsIdx = line.lastIndexOf('"timestamp"');
      if (lastTsIdx < 0) continue;
      const tsSection = line.substring(lastTsIdx, lastTsIdx + Math.min(120, line.length - lastTsIdx));
      const m = tsSection.match(/"timestamp"\s*:\s*"([^"]+)"/);
      if (m) {
        const ms = parseUtcMs(m[1]);
        if (ms != null) { latestUserMs = ms; latestUserIdx = i; break; }
      }
    }
    if (latestUserMs == null && len > tailSize) tailWarning = true;
    if (latestUserMs != null) {
      let outputSum = 0;
      for (let i = latestUserIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message && parsed.message.usage && parsed.message.usage.output_tokens) {
            outputSum += Number(parsed.message.usage.output_tokens);
          }
        } catch {}
      }
      let latestMs = statSync(tpath).mtimeMs;
      if (latestMs < latestUserMs) latestMs = latestUserMs;
      if (outputSum > 0) {
        let duration = (latestMs - latestUserMs) / 1000;
        if (duration < 0.001) duration = 0.001;
        tps = outputSum / duration;
        const tpsStr = fmtN(tps, 0) + 't/s';
        const coloredTps = ColorLow(tps, tpsStr, 30, 15);
        tpsRendered = Dim('turn ') + FmtDuration(psRound(duration)) + Dim(' @ ') + coloredTps;
      }
    }
  } catch {}
}

const line3 = cacheParts.length > 0 ? cacheParts.join(DIM_SEP) : null;
const coldLine = coldParts.length > 0 ? `${ESC}[${coldMarkerCol}m${snow}${ESC}[0m` + coldParts.join(DIM_SEP) : null;

// === Cluster 5: per-leg cost sparkline (8 buckets) =========================
let legsLine = null;
if (perLegCostArr.length > 0) {
  const maxBuckets = 8;
  const costs = perLegCostArr.slice();
  const n = costs.length;
  let bucketAvgs = [];
  if (n <= maxBuckets) {
    for (const c of costs) bucketAvgs.push(c);
  } else {
    const rem = n % maxBuckets;
    const bigSize = Math.ceil(n / maxBuckets);
    const smallSize = Math.floor(n / maxBuckets);
    let idx = 0;
    for (let b = 0; b < maxBuckets; b++) {
      const size = (b >= (maxBuckets - rem)) ? bigSize : smallSize;
      let sum = 0;
      for (let i = 0; i < size; i++) { sum += costs[idx]; idx++; }
      bucketAvgs.push(sum / size);
    }
  }
  const missing = maxBuckets - bucketAvgs.length;
  if (missing > 0) { const pad = new Array(missing).fill(null); bucketAvgs = pad.concat(bucketAvgs); }
  const cells = bucketAvgs.map((c) => isNil(c) ? Dim(' ····· ') : BgTint(LegRGB(c), '$' + fmtN(c, 2)));
  const legLabel = n <= maxBuckets ? '$/leg: ' : '$/leg avg: ';
  legsLine = Dim(legLabel) + Dim('[old] ') + cells.join('') + Dim(' [new]') + Dim(` (${n})`);
}

// === Cluster 5b: sub-agent fleet ===========================================
let agentsLine = null;
if (agentAgg && Number(agentAgg.nAgents) > 0) {
  const aParts = [];
  aParts.push(String(Number(agentAgg.nAgents)));
  aParts.push(Dim('Σctx ') + FmtNum(Number(agentAgg.sumMaxCtx)) + Dim(' (med ') + FmtNum(Number(agentAgg.medCtx)) + Dim('·max ') + FmtNum(Number(agentAgg.maxCtx)) + Dim(')'));
  if (!isNil(agentsUsd)) {
    let costChip = ColorCost(agentsUsd, '$' + fmtN(agentsUsd, 2));
    if (sessionCost > 0) costChip += Dim(' (') + psRound(100.0 * Number(agentsUsd) / Number(sessionCost)).toString() + Dim('%)');
    aParts.push(costChip);
  }
  const avgLegs = Number(agentAgg.nAgents) > 0 ? Number(agentAgg.sumLegs) / Number(agentAgg.nAgents) : 0;
  aParts.push(fmtN(avgLegs, 1) + Dim(' legs/ag'));
  agentsLine = Dim('agents: ') + aParts.join(DIM_SEP);
}

// === Cluster 4: quota ======================================================
const qBlocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const nowQ = NOW;
function QLvl(p) { let l = psRound(p / 100.0 * 8); if (p > 0 && l < 1) l = 1; if (l > 8) l = 8; return l; }
function QuotaLine(label, rl, winSec) {
  if (!rl || isNil(rl.used_percentage)) return null;
  const consumed = Number(rl.used_percentage);
  if (consumed < 50) return null;
  let elapsed = null;
  if (rl.resets_at) {
    const remain = Number(rl.resets_at) - nowQ;
    elapsed = ((winSec - remain) / winSec) * 100.0;
    if (elapsed < 0) elapsed = 0; if (elapsed > 100) elapsed = 100;
  }
  const q = consumed / 100.0;
  const t = !isNil(elapsed) ? elapsed / 100.0 : null;
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
  let col = rung === 0 ? '38;5;40' : rung === 1 ? '38;5;220' : rung === 2 ? '38;5;208' : '1;31';
  let verdict, detail;
  if (exhausted) {
    col = '38;5;208';
    if (consumed > 100) { verdict = `${label} over cap`; detail = 'on usage credits ' + '·' + ' paying overage'; }
    else { verdict = `${label} cap reached`; detail = 'on credits, or blocked til reset'; }
  } else {
    verdict = rung === 0 ? 'you can keep this pace' : rung === 1 ? 'slow down just a bit' : rung === 2 ? 'slow down' : 'slow down hard';
    if (rung === 0 && !isNil(t) && t > 0) {
      const rho = q / t;
      detail = `ends ~${psRound(rho * 100)}% ` + '·' + ` ${psRound((1 - rho) * 100)}% spare`;
    } else if (!isNil(B)) {
      detail = FmtDurShort(S) + ' to act ' + '→' + ' ' + FmtDurShort(B) + ' dark';
    } else {
      detail = null;
    }
  }
  const cbar = qBlocks[QLvl(consumed)];
  const ebar = !isNil(elapsed) ? qBlocks[QLvl(elapsed)] : ' ';
  const qn = psRound(consumed);
  const tn = !isNil(elapsed) ? psRound(elapsed) : null;
  const mid = '→' + `${qn}%${cbar}${ebar}` + (!isNil(tn) ? `${tn}%` : '') + '←';
  const gauge = Dim(`${label} quota `) + `${ESC}[${col}m${mid}${ESC}[0m` + Dim(' time');
  let s = gauge;
  if (verdict) s += DIM_SEP + `${ESC}[${col}m${verdict}${ESC}[0m`;
  if (detail) s += DIM_SEP + `${ESC}[${col}m${detail}${ESC}[0m`;
  if (rl.resets_at) s += DIM_SEP + Dim('resets ' + FmtDurShort(psRound(Number(rl.resets_at) - nowQ)));
  return s;
}
const qLines = [];
const q5 = QuotaLine('5h', d?.rate_limits?.five_hour, 18000);
const q7 = QuotaLine('7d', d?.rate_limits?.seven_day, 604800);
if (q5) qLines.push(q5);
if (q7) qLines.push(q7);

// === Cluster 4b: big-leg spotlight =========================================
const BIG_LEG_FLOOR_USD = 3.00;
const BIG_LEG_MULT = 3.0;
const BIG_LEG_MIN_USD = 0.50;
const BIG_LEG_WINDOW = 8;
let bigLegLines = [];
if (rollup && ('recentLegs' in rollup) && !isNil(baseTrue) && baseTrue > 0
  && !isNil(rollup.perLegUnits) && rollup.perLegUnits.length >= 1) {
  const allUnits = rollup.perLegUnits.map(Number);
  const medTail = allUnits.length > 20 ? allUnits.slice(allUnits.length - 20) : allUnits;
  const medUsd = Number(baseTrue) * Median(medTail);
  const nL = Number(rollup.nLegs);
  const blRows = [];
  for (const rec of rollup.recentLegs) {
    const legsAgo = nL - Number(rec.idx);
    if (legsAgo < 0 || legsAgo >= BIG_LEG_WINDOW) continue;
    const usd = Number(baseTrue) * Number(rec.units);
    const isBig = (usd >= BIG_LEG_FLOOR_USD) || (medUsd > 0 && usd >= (BIG_LEG_MULT * medUsd) && usd >= BIG_LEG_MIN_USD);
    if (!isBig) continue;
    const drv = getDriver(rec);
    const isCold = testColdLeg(rec);
    const mk = isCold ? ColdBlue('❆') : `${ESC}[38;5;179m◆${ESC}[0m`;
    const scale = medUsd > 0 ? (' ' + fmtN(usd / medUsd, 1) + 'x med') : '';
    const ago = legsAgo <= 0 ? 'this leg' : legsAgo === 1 ? '1 leg ago' : `${legsAgo} legs ago`;
    const dot = '·';
    const line = mk + ' ' + Dim(`Leg ${Number(rec.idx)}`) + Dim(` ${dot} `) + ColorLegCell(usd, '$' + fmtN(usd, 2)) + Dim(` ${dot} `) + `${ESC}[38;5;180m${drv}${ESC}[0m` + Dim(`${scale} ${dot} ${ago}`);
    blRows.push({ legsAgo, line });
  }
  blRows.sort((a, b) => a.legsAgo - b.legsAgo);
  bigLegLines = blRows.map((x) => x.line);
}

// === Cluster 5: session (built; display gated) =============================
const costParts = [];
let aliveSec = null;
if (tpath && existsSync(tpath)) {
  try { aliveSec = psRound(NOW - statSync(tpath).birthtimeMs / 1000); } catch {}
}
const apiSec = d?.cost?.total_api_duration_ms ? psRound(Number(d.cost.total_api_duration_ms) / 1000) : null;
if (!isNil(aliveSec) && !isNil(apiSec)) costParts.push(Dim(FmtDuration(aliveSec) + ' alive / ' + FmtDuration(apiSec) + ' api'));
else if (!isNil(aliveSec)) costParts.push(Dim(FmtDuration(aliveSec) + ' alive'));
else if (!isNil(apiSec)) costParts.push(Dim(FmtDuration(apiSec) + ' api'));
if (!isNil(d?.cost?.total_lines_added) || !isNil(d?.cost?.total_lines_removed)) {
  costParts.push(Dim(`+${d.cost.total_lines_added}/-${d.cost.total_lines_removed} lines`));
}
if (tpsRendered) costParts.push(tpsRendered);
if (tailWarning) costParts.push(RedBold('tail!'));
const dailyStatsPath = join(ClaudeHome, '.claude', 'stats-cache.json');
if (existsSync(dailyStatsPath)) {
  try {
    const stats = readJson(dailyStatsPath);
    const today = new Date(NOW * 1000).toISOString().slice(0, 10); // UTC yyyy-MM-dd (matches Get-NowLocal under TZ=UTC)
    const todayEntry = stats?.dailyModelTokens?.find((e) => e.date === today);
    if (todayEntry) {
      let sumToday = 0;
      for (const k of Object.keys(todayEntry.tokensByModel || {})) sumToday += Number(todayEntry.tokensByModel[k]) || 0;
      if (sumToday > 0) costParts.push(Dim('today:' + FmtNum(sumToday)));
    }
  } catch {}
}
const line5 = costParts.length > 0 ? Dim('session: ') + costParts.join(DIM_SEP) : null;

// === Cluster 6: git ========================================================
let gitLine = null;
let repo = null;
if (cwd) {
  let porcelain = null;
  try {
    porcelain = execFileSync('git', ['-C', cwd, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter((x) => x.length);
  } catch { porcelain = null; }
  if (porcelain && porcelain.length) {
    let branch = '?', ahead = 0, behind = 0, dirty = false, hasUpstream = false, detached = false;
    for (const pl of porcelain) {
      let m;
      if ((m = pl.match(/^# branch\.head (.+)$/))) { branch = m[1]; if (branch === '(detached)') detached = true; }
      else if (/^# branch\.upstream /.test(pl)) hasUpstream = true;
      else if ((m = pl.match(/^# branch\.ab \+(\d+) -(\d+)$/))) { ahead = Number(m[1]); behind = Number(m[2]); }
      else if (/^[12?u!]/.test(pl)) dirty = true;
    }
    let sync;
    if (detached) sync = Red('…');
    else if (!hasUpstream) sync = Yellow('!');
    else if (ahead > 0 && behind > 0) sync = RedBold(`⇅↑${ahead}↓${behind}`);
    else if (ahead > 0) sync = Yellow(`↑${ahead}`);
    else if (behind > 0) sync = Yellow(`↓${behind}`);
    else sync = Green('✓');
    if (dirty) sync = Yellow('*') + sync;
    let remote = '';
    let remoteUrl = null;
    try { remoteUrl = execFileSync('git', ['-C', cwd, '--no-optional-locks', 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    if (remoteUrl) {
      const u = remoteUrl.replace(/\.git$/, '');
      const m = u.match(/[:/]([^:/]+)\/([^:/]+)$/);
      if (m) remote = `${m[1]}/${m[2]}`;
    }
    repo = remote ? `${remote}@${branch}` : branch;
    gitLine = Dim('git: ') + repo + ' ' + sync;
  }
}

// === Sidecar snapshot ======================================================
try {
  const absState = isNil(ctxUsed) ? null
    : ctxUsed < 32000 ? 'pristine' : ctxUsed < 128000 ? 'green' : ctxUsed < 256000 ? 'yellow' : ctxUsed < 500000 ? 'orange' : 'red';
  const fillStateV = isNil(ctxPct) ? null
    : ctxPct < 50 ? 'green' : ctxPct < 70 ? 'yellow' : ctxPct < 85 ? 'orange' : 'red';
  const froz5State = isNil(ratio) ? null
    : ratio < 1.0 ? 'green' : ratio < 1.8 ? 'white' : ratio < 2.8 ? 'yellow' : ratio < 3.8 ? 'orange' : 'red';
  const toCompactTok = (!isNil(ctxUsed) && !isNil(ctxSize)) ? CompactAt(ctxSize) - ctxUsed : null;
  const activityPct = (aliveSec && Number(aliveSec) > 0 && !isNil(apiSec)) ? mathRoundD(100.0 * apiSec / aliveSec, 1) : null;
  let coldStakeUsd = null, coldState = null, coldCoolRemainSec = null;
  if (!isNil(coldStakes) && coldStakes >= 0.25) {
    coldStakeUsd = mathRoundD(Number(coldStakes), 2);
    if (rollup && !isNil(rollup.lastLegTs)) {
      if (!isNil(coldRemain) && coldRemain > 0) { coldState = 'cooling'; coldCoolRemainSec = psRound(coldRemain); }
      else coldState = 'cold';
    } else coldState = 'idle-cold';
  }
  const snapshot = {
    schema: 3,
    sessionId: sessionId ?? null,
    renderedAt: NOW,
    transcriptPath: tpath ?? null,
    costBaseline: rollup ? (rollup.costBaseline ?? null) : null,
    model,
    windowSize: ctxSize ?? null,
    effort,
    ctxTokens: ctxUsed ?? null,
    fillPct: ctxPct ?? null,
    ctxAbsState: absState,
    fillState: fillStateV,
    toCompact: toCompactTok,
    costUsd: costUsd ?? null,
    nextLegUsd: forecast,
    froz5Ratio: ratio,
    froz5State,
    freshLegUsd: freshBaseline,
    lastLegUsd: rollup ? (rollup.lastLegCost ?? null) : null,
    nLegs: rollup ? Number(rollup.nLegs) : null,
    nColdLegs: rollup ? Number(rollup.nColdLegs) : null,
    coldWastedUsd: (rollup && Number(rollup.sumUnits) > 0 && sessionCost > 0) ? mathRoundD((Number(sessionCost) / totalUnits) * Number(rollup.coldWastedUnits), 2) : null,
    lastColdTaxUsd: (rollup && Number(rollup.sumUnits) > 0 && sessionCost > 0 && ('lastColdWastedUnits' in rollup)) ? mathRoundD((Number(sessionCost) / totalUnits) * Number(rollup.lastColdWastedUnits), 2) : null,
    lastColdLegsAgo: (rollup && ('lastColdLegIdx' in rollup) && Number(rollup.lastColdLegIdx) > 0) ? Number(rollup.nLegs) - Number(rollup.lastColdLegIdx) : null,
    coldStakeUsd,
    coldState,
    coldBand,
    coldCoolRemainSec,
    coldTtlSec: (rollup && ('lastLegTtlSec' in rollup) && Number(rollup.lastLegTtlSec) > 0) ? Number(rollup.lastLegTtlSec) : null,
    legCosts: perLegCostArr.map((x) => mathRoundD(Number(x), 4)),
    aliveSec,
    apiSec,
    activityPct,
    linesAdded: d?.cost?.total_lines_added ?? null,
    linesRemoved: d?.cost?.total_lines_removed ?? null,
    tps: !isNil(tps) ? psRound(tps) : null,
    base: baseTrue,
    nAgents: agentAgg ? Number(agentAgg.nAgents) : null,
    agentsUsd: !isNil(agentsUsd) ? mathRoundD(Number(agentsUsd), 2) : null,
    mainSessionUsd: !isNil(mainSessionUsd) ? mathRoundD(Number(mainSessionUsd), 2) : null,
    agentLegs: agentAgg ? Number(agentAgg.sumLegs) : null,
    agentCtxMax: agentAgg ? Number(agentAgg.maxCtx) : null,
    agentsCachePath: agentAgg ? (agentAgg.cachePath ?? null) : null,
    gitRepo: repo ?? null,
  };
  const json = JSON.stringify(snapshot);
  if (cwd) {
    const projDir = join(cwd, '.claude');
    if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'statusline-last.json'), json, 'utf8');
  }
  writeFileSync(join(ClaudeHome, '.claude', 'statusline-last.json'), json, 'utf8');
} catch {}

const ShowSessionLine = false;

const out = [];
out.push(line1);
if (line2) out.push(line2);
for (const q of qLines) if (q) out.push(q);
if (line3) out.push(line3);
if (coldLine) out.push(coldLine);
for (const bl of bigLegLines) if (bl) out.push(bl);
if (legsLine) out.push(legsLine);
if (agentsLine) out.push(agentsLine);
if (line5 && ShowSessionLine) out.push(line5);
if (gitLine) out.push(gitLine);

process.stdout.write(out.join('\n'));
