// statusline.mjs — the live status-line renderer.
//
// Reads the Claude Code stdin JSON, renders the multi-cluster ANSI line to stdout, and writes the
// sidecar snapshot + per-session/agent rollup caches. All numeric formatting / rounding / timestamp
// parsing goes through _sl-compat.mjs. Rendering is guarded by the Node golden test
// (tools/parity/run-parity.mjs) against committed fixtures. See docs/roadmap.md.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  nowEpoch, psRound, fmtN, mathRoundD, parseUtcEpoch, parseUtcMs, atomicWriteFile, sweepStaleFiles,
} from './_sl-compat.mjs';
import {
  getDriver, testColdLeg, ModelTier, TIER_BASE, tierWeight,
  M_INPUT, M_CACHE_WRITE_5M, M_CACHE_WRITE_1H, M_CACHE_READ, M_OUTPUT,
  isSyntheticLeg, servingTierReport, median, DRIVER_VERBS,
} from './leg-driver.mjs';
import { resolveConfigHome } from './sidecar-path.mjs';
import { sanitizeSessionName } from './sanitize-name.mjs';

// Status-line software version (OUR version). Rendered as a trailing `bsl<ver>` badge.
// Bump on any change that shifts what the numbers mean.
// (The installer auto-ticks the BUILD digit on deploy of a changed cluster.)
export const SL_VERSION = '6.1.1.0';

// The USER config home this session belongs to — CLAUDE_CONFIG_DIR when set, else ~/.claude. Every
// user-level read (settings.json, stats-cache.json) and write (the global sidecar, the rollup caches)
// goes through it, so a second-subscription session sees its own state. PROJECT-level paths
// (<cwd>/.claude/…) are per-project, not per-subscription, and are deliberately untouched.
const ConfigHome = resolveConfigHome();
const NOW = nowEpoch();

let input_json = '';
try { input_json = readFileSync(0, 'utf8'); } catch {}
let d = {};
try { d = JSON.parse(input_json); } catch { d = {}; }

if (process.env.CLAUDE_STATUSLINE_DEBUG === '1') {
  try { writeFileSync(join(ConfigHome, 'statusline-input-sample.json'), input_json, 'utf8'); } catch {}
}

// Transcript read cap (golden-test determinism). When CLAUDE_SL_TRANSCRIPT_MAXBYTES is set, the
// rollup scan reads the transcript only up to this byte length, so a fixture replay sees a fixed view
// of the transcript. Unset (production) → read to EOF.
const TRANSCRIPT_MAXBYTES = process.env.CLAUDE_SL_TRANSCRIPT_MAXBYTES ? Number(process.env.CLAUDE_SL_TRANSCRIPT_MAXBYTES) : null;
function claudeStateDir(projRoot) {
  return projRoot ? join(projRoot, '.claude') : ConfigHome;
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

// Auto-compact fires at `min(auto-compact window, model window)`. The window is NOT in the status-line
// payload; we resolve it the way CC does. CC's resolver (function `KV`, extracted from the running
// binary 2.1.233 on 2026-08-16), first hit wins:
//
//   1. env CLAUDE_CODE_AUTO_COMPACT_WINDOW — when the string is non-empty. Parsed by CC's `Tg`:
//      trim; an integer in exponent form (`5e5`) → that number; digits grouped by `_ , space NBSP
//      NNBSP` (`500,000`, `500_000`) → separators stripped; otherwise `parseInt(v, 10)` (`500k` → 500,
//      `abc` → NaN). NaN or ≤ 0 → INVALID → ignored, fall through to 2 (CC logs "using default").
//      > 1e6 → CAPPED to 1e6; then FLOORED at 1e5 (`Math.max(1e5, n)`), so `500k` → 500 → 100k.
//      `/autocompact` reports "CLAUDE_CODE_AUTO_COMPACT_WINDOW is set and takes precedence" — the
//      setting is ignored while the env var is valid.
//   2. settings `autoCompactWindow` (USER settings.json; /autocompact PERSISTS the user's choice
//      there the instant it changes — authoritative, no observer-effect). Read through zod
//      `.int().min(1e5).max(1e6).optional().catch(undefined)`: an integer in [1e5, 1e6] is used;
//      ANYTHING else (non-integer, string, out of range, `null`, absent) is `undefined` = auto. NOT
//      clamped — it DROPS to auto (asymmetric with the env channel, which clamps).
//   3. client-data / experiment / model-tuned default — server-delivered (~500k on the 1M models via
//      the tengu_amber_redwood3 gate), invisible to us → we estimate it and flag the estimate.
//
// Blind channel: the `--autocompact` CLI flag has no payload field; we do not guess it.
// The old behaviour (model window × 0.95) overstated 1M headroom by ~450k and never warned before
// compaction (caught live 2026-07: compacted at 466k while to-compact read 484k).
const AUTO_COMPACT_1M = 500000;   // model-tuned `auto` default for the 1M regime (estimate; drifts server-side)
const CW_GROUPED = /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/;
const CW_EXPONENT = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/;
function ccParseInt(v) {   // CC's `Tg`
  const t = String(v).trim();
  if (t.length <= 32 && CW_EXPONENT.test(t)) { const n = Number(t); return Number.isInteger(n) ? n : NaN; }
  if (CW_GROUPED.test(t)) return parseInt(t.replace(/[_,\u00A0\u202F ]/g, ''), 10);
  return parseInt(t, 10);
}
function readAutoCompactWindow() {
  try {
    const env = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    if (env !== undefined && env !== '') {
      let n = ccParseInt(env);
      if (!Number.isNaN(n) && n > 0) {
        if (n > 1e6) n = 1e6;
        return { win: Math.max(1e5, n), source: 'env' };
      }
    }
    const s = readJson(join(ConfigHome, 'settings.json'));
    const v = s ? s.autoCompactWindow : undefined;
    if (Number.isInteger(v) && v >= 1e5 && v <= 1e6) return { win: v, source: 'settings' };
  } catch {}
  return { win: null, source: null };
}
// Effective auto-compact window + whether it's an ESTIMATE (on `auto`, using the default) vs an
// authoritative value resolved from env / settings.
function CompactWindow(ctxSize) {
  const { win } = readAutoCompactWindow();
  if (typeof win === 'number') return { win: Math.min(win, ctxSize), estimate: false };
  if (ctxSize >= 700000) return { win: AUTO_COMPACT_1M, estimate: true };   // 1M on `auto` → estimated default
  return { win: ctxSize, estimate: false };                                 // 200k `auto` ≈ the model window
}
function CompactAt(ctxSize) { return psRound(CompactWindow(ctxSize).win * 0.95); }
// Auto-compact can also be OFF entirely — then the countdown (and its red `NOW`) is a lie: compaction
// never fires. CC checks THREE off switches, in this order, and so do we:
//
//   function GH(){ if(te.DISABLE_COMPACT) return!1;
//                  if(_r(process.env.DISABLE_AUTO_COMPACT)) return!1;
//                  return Ju("autoCompactEnabled",!0).value }
//
// Both env vars parse through the SAME truthiness rule: `te.DISABLE_COMPACT` is `Fe.bool()`, which is
// `_r(String(v))`, and `_r` is `["1","true","yes","on"].includes(v.toLowerCase().trim())`. So only
// '1' / 'true' / 'yes' / 'on' disable auto-compact; EVERY other value — including 'off', 'no', '0',
// 'false', '' and junk — leaves it ON and the countdown must keep rendering.
//
// Extracted from the running CC binary: 2026-07-04 (2.1.198, DISABLE_AUTO_COMPACT only) and
// re-extracted 2026-08-08 (2.1.225, all three + the shared parser). If CC's parser drifts, this
// allowlist must follow. Tickets: 2026-07-04-acoff-env-predicate-vs-cc,
// 2026-07-04-disable-compact-sibling-switch.
const CC_TRUTHY = ['1', 'true', 'yes', 'on'];
const ccEnvTrue = (v) => v != null && CC_TRUTHY.includes(String(v).toLowerCase().trim());
function autoCompactDisabled() {
  if (ccEnvTrue(process.env.DISABLE_COMPACT)) return true;
  if (ccEnvTrue(process.env.DISABLE_AUTO_COMPACT)) return true;
  const s = readJson(join(ConfigHome, 'settings.json'));
  if (s && s.autoCompactEnabled === false) return true;
  return false;
}
const AC_OFF = autoCompactDisabled();

// --- ANSI color helpers ----------------------------------------------------
// TWO non-signal tones and nothing else: chrome is 256-colour 240 (`DarkGray` — every label, unit,
// separator, connective and deliberately-quiet value), and a neutral value carries NO SGR at all.
// There is no second gray: SGR-2 is retired from this file entirely, and so is colour 250. Every
// other colour below is a CALIBRATED LADDER, where the colour is the meaning.
const ESC = '\x1b';
const Red = (t) => `${ESC}[31m${t}${ESC}[0m`;
const Green = (t) => `${ESC}[32m${t}${ESC}[0m`;
const Yellow = (t) => `${ESC}[33m${t}${ESC}[0m`;
const RedBold = (t) => `${ESC}[1;31m${t}${ESC}[0m`;
const White = (t) => `${ESC}[97m${t}${ESC}[0m`;
const Orange = (t) => `${ESC}[38;5;208m${t}${ESC}[0m`;
const Magenta = (t) => `${ESC}[95m${t}${ESC}[0m`;
const BrightCyan = (t) => `${ESC}[96m${t}${ESC}[0m`;
const DarkGray = (t) => `${ESC}[38;5;240m${t}${ESC}[0m`;
const ColdBlue = (t) => `${ESC}[38;5;33m${t}${ESC}[0m`;

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
  if (v < 1) return DarkGray(text);
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

// The trend row's chips: foreground at the cell's own gradient colour, background at 30% of that
// same colour. The caller passes the WHOLE slot (value plus its pad), so the tint covers every cell
// of the slot and adjacent chips form one continuous band with no untinted gap between them.
function BgTint(rgb, text) {
  const m0 = psRound(rgb[0] * 0.30), m1 = psRound(rgb[1] * 0.30), m2 = psRound(rgb[2] * 0.30);
  return `${ESC}[38;2;${rgb[0]};${rgb[1]};${rgb[2]};48;2;${m0};${m1};${m2}m${text}${ESC}[0m`;
}

// --- Grid geometry ---------------------------------------------------------
// A fixed two-column grid: a 53-cell left column, the 2-cell divider `│ `, then a 62-cell right
// column — 117 cells in all. The left column's width positions the divider, so it NEVER overruns:
// its two unbounded strings (the model name, a spotlight driver) truncate with `…`. The right column
// may overrun and never truncates, because nothing renders to the right of it.
//
// Width is counted on the ANSI-stripped string, ONE CELL PER CODE POINT. Classified against the
// Unicode EastAsianWidth data, the glyphs this layout emits are either AMBIGUOUS — `▁▂▃▄▅▆▇█`
// (U+2581–2588), `→` U+2192, `←` U+2190, `│` U+2502, `◆` U+25C6, `·` U+00B7, `…` U+2026, `×` U+00D7,
// `—` U+2014 — or NEUTRAL: `⁂` U+2042, `⚠` U+26A0, `❆` U+2746. NOTHING here is Wide or Fullwidth, so
// no glyph is unconditionally double-width; only the Ambiguous ones can draw double, and only on a
// CJK-configured font or locale. Each glyph sits in a padded field of fixed width and each HALF is
// padded independently, so a double-drawn glyph pushes that one row's tail right — carrying that
// row's own divider when it is in the left half — and every other row keeps its alignment. A per-row
// effect, never a column-wide one. `…` is the one that matters most: it is the left column's
// truncation marker, and the left column is what positions the divider. See docs/status-line.md.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visLen(s) { return [...String(s).replace(ANSI_RE, '')].length; }
function padTo(s, n) { const d = n - visLen(s); return d > 0 ? s + ' '.repeat(d) : s; }
function padStartTo(s, n) { const d = n - visLen(s); return d > 0 ? ' '.repeat(d) + s : s; }
function rtrim(s) { return String(s).replace(/ +$/, ''); }
// Right-truncate an UNSTYLED string to n cells, marking the cut with a trailing `…`.
function truncTo(s, n) {
  const cp = [...String(s)];
  if (cp.length <= n) return String(s);
  return cp.slice(0, Math.max(0, n - 1)).join('') + '…';
}
const LEFT_LABEL_W = 6, LEFT_VALUE_W = 45, LEFT_HALF_W = 53;
const RIGHT_LABEL_W = 7, RIGHT_VALUE_W = 53;
// One grid row. Labels are right-aligned in their own field, so within a column every label ends at
// the same screen column and the value text starts immediately after. The left half is padded to
// exactly 53 cells, so the divider lands in column 54 on EVERY row — including a row whose right
// half is empty, where the trailing space is trimmed and the divider is the line's last glyph.
// A ROW MAY NOT BEGIN WITH WHITESPACE. Leading spaces are stripped before the row reaches the
// screen, and every row's label leaves a different number of them (`model` 1 … the label-less
// runway row 8), so each row slid left by a different amount and the grid visibly bent — the right
// half dragged along with it, which is why the right column's labels staggered too. One near-black
// `.` takes the place of the FIRST pad space: position 0 is never whitespace, so nothing is
// stripped. ASCII, so it cannot misdraw; it REPLACES a space rather than being prepended, so the
// row stays 53 cells and no layout math moves. Interior padding was never affected.
const LEAD_DOT = `${ESC}[38;5;234m.${ESC}[0m`;
function guardLead(s) { return s.startsWith(' ') ? LEAD_DOT + s.slice(1) : s; }
// A label belongs to its value: a half with nothing to say renders as blank space, not as a label
// standing alone, and a row with nothing to say on either side does not render at all (returns
// null — the assembler filters it). This replaced the Dossier IV "six always-present rows, empty
// cluster shows its label alone" rule: a bare `cold` or `flags` is noise, and the agents label was
// worse, printing a glyph on every session that has never spawned an agent.
function gridRow(lLabel, lValue, rLabel, rValue) {
  const lHas = visLen(lValue) > 0, rHas = visLen(rValue) > 0;
  if (!lHas && !rHas) return null;
  const left = padTo(rtrim(padStartTo(lHas ? lLabel : '', LEFT_LABEL_W) + '  ' + lValue), LEFT_HALF_W);
  const right = rtrim(padStartTo(rHas ? rLabel : '', RIGHT_LABEL_W) + (rHas ? '  ' + rValue : ''));
  return guardLead(right ? left + DarkGray('│ ') + right : left + DarkGray('│'));
}

// === Per-session cumulative-token rollups (incremental transcript scan) =====
function UpdateSessionRollups(sessionId, tpath, currentCost, projRoot, mainModel, sessionName) {
  if (!sessionId || !tpath || !existsSync(tpath)) return null;
  const statsDir = join(claudeStateDir(projRoot), 'statusline-stats');
  try { if (!existsSync(statsDir)) mkdirSync(statsDir, { recursive: true }); } catch {}
  const statsPath = join(statsDir, sessionId + '.json');
  let r = existsSync(statsPath) ? readJson(statsPath) : null;
  const hadPrior = r !== null;
  // The stats file's own mtime = the last render's time (read BEFORE this render overwrites it); it
  // is the sweep trigger's only state — see the housekeeping sweep below.
  let priorMtimeSec = null;
  if (hadPrior) { try { priorMtimeSec = statSync(statsPath).mtimeMs / 1000; } catch {} }
  const freshRollup = () => ({
    lastByteOffset: 0, nLegs: 0, sumUnits: 0, sumOutputTokens: 0, lastMsgId: '',
    lastInputBilled: 0, lastOutputTokens: 0, lastSeenCost: 0, lastLegCost: null,
    perLegUnits: [], perLegOwnUnits: [], perLegModels: [], lastLegTs: null, lastWarm: 0,
    nColdLegs: 0, coldWastedUnits: 0, lastColdLegIdx: 0, lastColdWastedUnits: 0,
    lastLegTtlSec: 0, recentWriteTtls: [], recentLegs: [], mainModel: '',
    runIdx: 0, runStartLeg: 0,
  });
  // The stats file is written as a PROJECTION of the declared shape, never as "the object we read
  // plus whatever it already had": UpdateSessionRollups mutates what it reads and writes it back, so
  // a key nothing writes any more rides along for the life of the session file (a retired key
  // survives even a forced full re-bank). The key list is DERIVED from freshRollup(), not
  // hand-maintained — a field added to the fresh shape is preserved automatically and only genuinely
  // unknown keys drop. The three optional keys are the ones assigned outside the fresh shape, all
  // conditional and all live; losing sessionName would silently break the fact sheet's FOREIGN
  // naming. No version marker: a marker is itself a new key, and the older build that resets on a
  // missing required key ignores every key it does not know — so a marker could only ever help
  // readers built after it exists, which are exactly the readers that need no help.
  // BACK-COMPAT, one entry, retire per spec §A9.1 (2026-08-22): the 5.x build — deployed until every
  // config home installs 6.x — lists `openingLegs` in its requiredFields, so a stats file without it
  // reads as structurally unusable and gets RESET, destroying sessionName, modelSwitch,
  // modelSwitchedAtLeg and runStartLeg, none of which a later render can re-derive. Nothing in this
  // build reads or fills the key; it is a placeholder that keeps a lagging reader from throwing the
  // file away. RETIRE IT once every config home on every machine reports SL_VERSION >= 6.0.0.0 —
  // one grep per machine, so the condition is checkable rather than remembered.
  // Ticket: .inbox/2026-08-22-retire-openinglegs-rollup-compat-key.md
  const ROLLUP_COMPAT_KEYS = { openingLegs: [] };
  const ROLLUP_OPTIONAL_KEYS = ['modelSwitchedAtLeg', 'modelSwitch', 'sessionName'];
  const ROLLUP_KEYS = new Set([...Object.keys(freshRollup()), ...ROLLUP_OPTIONAL_KEYS,
    ...Object.keys(ROLLUP_COMPAT_KEYS)]);
  if (!hadPrior) r = freshRollup();

  // perLegModels (4.4) is REQUIRED (not additive): a pre-4.4 stats file triggers the one-time full
  // rescan so every banked leg gets its model (else old legs would stay flat-priced).
  const requiredFields = ['lastByteOffset', 'nLegs', 'sumUnits', 'sumOutputTokens',
    'lastMsgId', 'lastInputBilled', 'lastOutputTokens', 'lastSeenCost',
    'lastLegCost', 'perLegUnits', 'perLegOwnUnits', 'perLegModels'];
  let needsReset = false;
  for (const f of requiredFields) { if (!(f in r)) { needsReset = true; break; } }
  if (needsReset) {
    r = freshRollup();
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
  if (!('mainModel' in r)) r.mainModel = '';
  if (!('runIdx' in r)) r.runIdx = 0;
  if (!('runStartLeg' in r)) r.runStartLeg = 0;
  const skipLastLegCost = needsReset;
  const nLegsBefore = Number(r.nLegs);

  // Resume detection — BEFORE the scan (it needs nLegs as of the previous run). total_cost_usd is
  // per-run (CC resets it on resume/clear) while the rollup spans every run of the transcript, so a
  // cost that fell below the last seen one marks a new run: the pricing window (base = this run's
  // cost / this run's units) starts at the current leg count; earlier legs stay listed and are
  // priced at this run's rate (sidecar runStartLeg says so).
  if (hadPrior && !needsReset && Number(currentCost) < Number(r.lastSeenCost) - 1e-9) {
    r.runIdx = Number(r.runIdx) + 1;
    r.runStartLeg = Number(r.nLegs);
    r.lastSeenCost = 0;
    r.lastLegCost = null;
  }

  try {
    if (existsSync(tpath)) {
      let fileBuf = readFileSync(tpath);
      if (TRANSCRIPT_MAXBYTES != null && fileBuf.length > TRANSCRIPT_MAXBYTES) fileBuf = fileBuf.subarray(0, TRANSCRIPT_MAXBYTES);
      const totalLen = fileBuf.length;
      if (Number(r.lastByteOffset) > totalLen) {
        r.lastByteOffset = 0; r.nLegs = 0; r.sumUnits = 0; r.sumOutputTokens = 0;
        r.lastInputBilled = 0; r.lastOutputTokens = 0; r.perLegUnits = []; r.perLegOwnUnits = [];
        r.perLegModels = []; r.runStartLeg = 0;
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
              // First-wins adjacent dedup — HAZARD: exact for MAIN transcripts (per-block dup lines
              // carry byte-identical usage); agent transcripts carry PROGRESSIVE output_tokens and
              // are handled by the max-wins branch in UpdateAgentRollups, never by this scan.
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
              const legModel = String(p?.message?.model ?? '');
              // Placeholder lines are NOT legs (isSyntheticLeg — the SAME predicate getScannedLegs
              // uses, so the two scans can never disagree): a `<synthetic>` line or an all-zero-usage
              // line processed no tokens. Skipped AFTER the message-id dedup and BEFORE any state is
              // touched, so it consumes no leg index and no sparkline cell,
              // and — critically — does not reset the cold-cache clock: it refreshed no cache.
              // `lastMsgId` is deliberately left alone, so its own duplicate lines are dropped by
              // this same test rather than by the adjacent-dedup slot a real leg needs.
              if (isSyntheticLeg({ model: legModel, inT: inTok, cw: cwTok, cr: crTok, out: outTok })) continue;
              r.nLegs = Number(r.nLegs) + 1;
              r.sumUnits = Number(r.sumUnits) + units;
              r.sumOutputTokens = Number(r.sumOutputTokens) + outTok;
              r.lastMsgId = msgId;
              r.lastInputBilled = inTok + cwTok + crTok;
              r.lastOutputTokens = outTok;
              r.perLegUnits.push(units);
              r.perLegOwnUnits.push(ownUnits);
              r.perLegModels.push(legModel);
              let legTs = null;
              if (p.timestamp) legTs = parseUtcEpoch(p.timestamp);
              const prevWarm = Number(r.lastWarm); // tokens warm one leg ago
              if (legTs != null && r.lastLegTs != null) {
                const gap = legTs - Number(r.lastLegTs);
                const prevTtl = Number(r.lastLegTtlSec) > 0 ? Number(r.lastLegTtlSec) : 300;
                const blBigRewrite = (cwTok >= 50000 && crTok < 0.5 * cwTok);
                const blCollapsed = (prevWarm > 0 && crTok < prevWarm * 0.7);
                // Twin of leg-driver.mjs testColdLeg — keep the thresholds (50000 / 0.5 / 0.7 / 8000)
                // in lockstep. A collapse WITHOUT a TTL-exceeding gap is the `compacted` display class
                // (getDriver) and deliberately does NOT count here: `gap > prevTtl` keeps the cold-tax
                // counters clean of mid-session compactions.
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
              r.recentLegs.push({ idx: Number(r.nLegs), inT: inTok, cw: cwTok, cwUnits, cr: crTok, out: outTok, units, gapToPrev: blGap, coldTtl: blTtl, prevWarm, model: legModel });
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
  r.lastSeenCost = Number(currentCost);

  // Model stamping — a mid-session PRICE-TIER change (never a raw-string change: id-form vs
  // display-form and same-tier upgrades share a tier) marks per-leg DOLLARS non-comparable across
  // the switch. The stamp persists for the rest of the session; the sidecar carries it verbatim.
  const prevTier = ModelTier(r.mainModel);
  const newTier = ModelTier(mainModel);
  if (prevTier !== null && newTier !== null && prevTier !== newTier) {
    r.modelSwitchedAtLeg = Number(r.nLegs);
    r.modelSwitch = { atLeg: Number(r.nLegs), from: String(r.mainModel), to: String(mainModel) };
  }
  if (mainModel) r.mainModel = String(mainModel);
  // Session name (payload session_name: /rename · --name, else the AI title) — persisted so the
  // fact sheet's FOREIGN guard can name THIS session in words; a nameless render never clears it.
  if (sessionName) r.sessionName = sessionName;

  // Write the projection (see ROLLUP_KEYS above), not `r` itself — anything outside the declared
  // shape is dropped here rather than carried forward forever. Existing key order is preserved.
  const rOut = {};
  for (const k of Object.keys(r)) { if (ROLLUP_KEYS.has(k)) rOut[k] = r[k]; }
  // A back-compat key already in the file rode through the loop above untouched; one that was never
  // there gets stamped now, so a file this build CREATED is also safe for a lagging reader.
  for (const [k, v] of Object.entries(ROLLUP_COMPAT_KEYS)) if (!(k in rOut)) rOut[k] = v;
  try { atomicWriteFile(statsPath, JSON.stringify(rOut, null, 2)); } catch {}

  // Housekeeping sweep — runs on a NEW session's first render OR on a session's first render on a
  // new UTC day (the stats file's pre-write mtime vs NOW, calendar-day compare). "New session only"
  // was too rare: sessions here live for days, so nothing reclaimed stale entries for weeks; and
  // ConfigHome/statusline-stats is only ever written when the payload has no cwd, so nothing else
  // reclaims it. Cutoff 7 days. Stats dirs: .json = expired session state (incl. .agents.json /
  // .nudge.json), .tmp. = an orphaned atomic-write temp — a concurrent writer's in-flight temp is
  // never that old. The current session's own files (every `<sessionId>.` name) are never touched.
  // Sidecar dirs (<cwd>/.claude and ConfigHome itself) are swept ONLY for the sidecar's own orphaned
  // temps — never statusline-last.json, never any other file there. Best-effort, never throws.
  const utcDay = (sec) => Math.floor(sec / 86400);
  const doSweep = !hadPrior || (priorMtimeSec !== null && utcDay(priorMtimeSec) < utcDay(NOW));
  if (doSweep) {
    try {
      const cutoff = NOW - 7 * 86400;
      const stateMatch = (n) => n.endsWith('.json') || n.includes('.tmp.');
      const sidecarTmpMatch = (n) => n.startsWith('statusline-last.json.tmp.');
      const keep = { match: stateMatch, keepPrefix: sessionId + '.' };
      sweepStaleFiles(statsDir, cutoff, keep);
      const globalStatsDir = join(ConfigHome, 'statusline-stats');
      if (globalStatsDir !== statsDir) sweepStaleFiles(globalStatsDir, cutoff, keep);
      if (projRoot) sweepStaleFiles(join(projRoot, '.claude'), cutoff, { match: sidecarTmpMatch });
      sweepStaleFiles(ConfigHome, cutoff, { match: sidecarTmpMatch });
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
// (Model → pricing tier lives in leg-driver.mjs's ModelTier — shared with handover-facts.)
// `runIdx` = the main rollup's current run (see UpdateSessionRollups' resume detection). Every
// entry is stamped with the run it was FIRST seen in; only this run's agents count toward the
// aggregate, matching total_cost_usd's "this run" scope.
function UpdateAgentRollups(sessionId, tpath, projRoot, mainTier, runIdx) {
  if (!sessionId || !tpath) return null;
  const subDir = tpath.replace(/\.jsonl$/, '') + require_sep() + 'subagents';
  if (!existsSync(subDir)) return null;
  const statsDir = join(claudeStateDir(projRoot), 'statusline-stats');
  try { if (!existsSync(statsDir)) mkdirSync(statsDir, { recursive: true }); } catch {}
  const cachePath = join(statsDir, sessionId + '.agents.json');
  let cache = existsSync(cachePath) ? readJson(cachePath) : null;
  if (cache === null || !('agents' in cache)) cache = { lastScanTs: 0, agents: [] };
  if (isNil(cache.agents)) cache.agents = [];
  runIdx = Number(runIdx) || 0;
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
        if (!e) { e = { path: fp, offset: 0, units: 0, ownUnits: 0, legs: 0, out: 0, maxCtx: 0, maxLegUnits: 0, label: '', model: '', lastMsgId: '', lastOut: 0, lastLegUnits: 0, run: runIdx }; byPath[fp] = e; }
        if (!('run' in e)) e.run = runIdx;
        // Idle skip: an unchanged transcript (same mtime, same size as the banked offset) is not
        // re-read and not label-backfilled. `mtimeMs` is bookkeeping only, never counted/displayed;
        // an entry without it (older cache) takes the full path once and gains it.
        let len = 0, mtimeMs = null; try { const st = statSync(fp); len = st.size; mtimeMs = st.mtimeMs; } catch {}
        if (mtimeMs !== null && e.mtimeMs === mtimeMs && Number(e.offset) === len) continue;
        if (mtimeMs !== null) e.mtimeMs = mtimeMs;
        if (Number(e.offset) > len) { e.offset = 0; e.units = 0; e.ownUnits = 0; e.legs = 0; e.out = 0; e.maxCtx = 0; e.maxLegUnits = 0; e.label = ''; e.model = ''; e.lastMsgId = ''; e.lastOut = 0; e.lastLegUnits = 0; e.run = runIdx; }
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
                  if (p?.message?.model) e.model = String(p.message.model);
                  const mid = p?.message?.id;
                  if (!mid) continue;
                  const u = p?.message?.usage;
                  if (!u) continue;
                  const outTok = Number(u.output_tokens) || 0;
                  if (mid === e.lastMsgId) {
                    // Max-wins on output_tokens: agent transcripts stream one line per content
                    // block with PROGRESSIVE output_tokens (the last line carries the total; the
                    // first is a tiny partial). Input/cache fields are identical across the group,
                    // so only the output delta is banked. lastOut/lastLegUnits persist per entry, so
                    // a group straddling two scans still resolves.
                    const prevOut = Number(e.lastOut) || 0;
                    if (outTok > prevOut) {
                      const dU = (outTok - prevOut) * M_OUTPUT;
                      e.units = Number(e.units) + dU;
                      e.ownUnits = Number(e.ownUnits) + dU;
                      e.out = Number(e.out) + (outTok - prevOut);
                      e.lastOut = outTok;
                      e.lastLegUnits = Number(e.lastLegUnits) + dU;
                      if (Number(e.lastLegUnits) > Number(e.maxLegUnits || 0)) e.maxLegUnits = Number(e.lastLegUnits);
                    }
                    continue;
                  }
                  const inTok = Number(u.input_tokens) || 0, cwTok = Number(u.cache_creation_input_tokens) || 0;
                  const crTok = Number(u.cache_read_input_tokens) || 0;
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
                  e.lastOut = outTok;
                  e.lastLegUnits = legU;
                } catch {}
              }
              e.offset = Number(e.offset) + consumed;
            }
          } catch {}
        }
        if (!e.label) e.label = agentLabelFromFileHead(fp) || agentIdFromPath(fp);
      }
      cache.lastScanTs = nEpoch;
      cache.run = runIdx;
      cache.agents = Object.values(byPath);
      try { atomicWriteFile(cachePath, JSON.stringify(cache, null, 2)); } catch {}
    } catch {}
  }
  // This run's agents only: a prior run's agents are not in total_cost_usd, so they leave the
  // divisor AND the fleet line (one meaning — "this run's agents"). Entries without a run stamp
  // (pre-4.4 caches, throttled seeds) count as current.
  const live = cache.agents.filter((a) => a && Number(a.legs) > 0 && (a.run ?? runIdx) === runIdx);
  if (live.length === 0) return null;
  let sumUnits = 0, sumEffUnits = 0, sumLegs = 0, sumOut = 0, sumMaxCtx = 0, maxCtx = 0, maxUnits = 0;
  const tierCounts = {};
  for (const a of live) {
    const tier = ModelTier(a.model);
    // Tier-weighted effective units (tierWeight — the same function render-spikes uses): an
    // agent's units scale by its tier's headline input price relative to the MAIN tier, so the
    // main-vs-agents $ split of total_cost_usd stays honest when tiers mix. The total itself is
    // never recomputed — only its attribution.
    const w = tierWeight(a.model, mainTier);
    sumUnits += Number(a.units); sumEffUnits += Number(a.units) * w;
    sumLegs += Number(a.legs); sumOut += Number(a.out);
    sumMaxCtx += Number(a.maxCtx);
    if (Number(a.maxCtx) > maxCtx) maxCtx = Number(a.maxCtx);
    if (Number(a.units) > maxUnits) maxUnits = Number(a.units);
    if (tier) tierCounts[tier] = (tierCounts[tier] || 0) + 1;
  }
  // No median of the per-agent peak contexts: the fleet cluster no longer displays one, and the
  // sidecar never carried it (`agentCtxMax` is the surviving snapshot key). The median over agent
  // peak contexts is guarded directly by tests/agent-ctx-median.test.mjs.
  return { nAgents: live.length, sumUnits, sumEffUnits, sumLegs, sumOut, sumMaxCtx, maxCtx, maxUnits, tierCounts, cachePath };
}
function require_sep() { return process.platform === 'win32' ? '\\' : '/'; }

// === Row 1 left: model + effort ============================================
const model = (d?.model?.display_name) ? d.model.display_name : 'unknown';
// Tier from the RAW payload model (never the 'unknown' render fallback, which would read as a
// real 'other' tier): absent display_name → null → no tier-mix contribution, weight 1.0.
const mainTier = ModelTier(d?.model?.display_name);
const version = d?.version;
const effort = (d?.effort?.level) ? d.effort.level : '?';
const style = (d?.output_style?.name) ? d.output_style.name : 'default';
const fast = d?.fast_mode;
const fastMode = fast === true;
const thinking = d?.thinking?.enabled;

// The name is neutral (no SGR, no bold) and is one of the two unbounded strings in the left column,
// so it truncates at its 30-cell budget. `v<version>` moved to the repo cluster and the serving-tier
// chip to the flags cluster, so nothing else lands in this field.
const MODEL_NAME_W = 30;
const modelValue = truncTo(model, MODEL_NAME_W) + '  ' + DarkGray('effort ') + ColorEffort(effort);

// === Row 2 left: context window ============================================
// `fillPct` / `fillState` still feed the sidecar; the `%` fill chip that displayed them is gone, as
// is the `/handover-check` advert.
const ctxPct = d?.context_window?.used_percentage;
const ctxUsed = d?.context_window?.total_input_tokens;
const ctxSize = d?.context_window?.context_window_size;
let ctxValue = '';
if (!isNil(ctxUsed) && !isNil(ctxSize)) {
  let wall;
  if (AC_OFF) {
    // Auto-compact is off — no countdown, no red NOW: compaction will not fire.
    wall = DarkGray('off');
  } else {
    const cw = CompactWindow(ctxSize);
    const compactAt = psRound(cw.win * 0.95);
    const remaining = compactAt - ctxUsed;
    // `~` = the window is an ESTIMATE (on `auto`, using the model-tuned default) — shown ONLY when it's also
    // near the bar (remaining < 200k), so a calm line never carries it and an authoritative
    // override (a real number read from settings) never marks. One glyph, event-gated.
    const est = (cw.estimate && remaining < 200000) ? '~' : '';
    // The distance is a quiet fact and is never band-coloured. NOW is the exception: past the
    // compaction point the field stops being a distance and becomes a hard event, marker included.
    wall = remaining > 0 ? DarkGray(est + FmtNum(remaining)) : RedBold(est + 'NOW');
  }
  ctxValue = ColorByTokenCount(ctxUsed, FmtNum(ctxUsed)) + DarkGray('/' + FmtNum(ctxSize))
    + '  ' + DarkGray('wall ') + wall;
}

// === Row 1 right: cost =====================================================
let costTotalPart = null, costLastPart = null, costNextPart = null, costMedPart = null;
const tpath = d?.transcript_path;
const sessionId = d?.session_id;
// session_name = the /rename · --name custom name, else the AI-generated title; absent when neither.
// Sanitized through the SHARED sanitizer (sanitize-name.mjs — the fact sheet runs the same function
// on read, so the invariant holds whoever wrote the file): single-line, control- and backtick-free,
// capped, and null rather than '' when it reduces to nothing. Never rendered here (the tab title +
// CC's header already carry it) — persisted for handover-facts only.
const sessionName = sanitizeSessionName(d?.session_name);
const costUsd = d?.cost?.total_cost_usd;
const ctxTok = d?.context_window?.total_input_tokens;
const cwd = (d?.workspace?.current_dir) ? d.workspace.current_dir : d?.cwd;

if (!isNil(costUsd)) costTotalPart = ColorCost(costUsd, '$' + fmtN(costUsd, 2));
let rollup = null;
if (sessionId && tpath && !isNil(costUsd)) rollup = UpdateSessionRollups(sessionId, tpath, costUsd, cwd, d?.model?.display_name ?? '', sessionName);

let sessionCost = costUsd;
let agentAgg = null;
const runIdx = rollup ? Number(rollup.runIdx) || 0 : 0;
const runStartLeg = rollup ? Number(rollup.runStartLeg) || 0 : 0;
if (sessionId && tpath) { try { agentAgg = UpdateAgentRollups(sessionId, tpath, cwd, mainTier, runIdx); } catch {} }
// Transcript-vs-display tier PROVENANCE — "the label names a tier that has never served in this
// run". Pure provenance: it drives one flags-cluster chip, a conditional sidecar key and a
// fact-sheet caveat, and gates NO number (the display tier cancels out of per-leg dollars — see
// servingTierReport). Reads arrays already in hand — no extra file read, no re-scan on the hot path.
// It renders as a caveat chip on the flags row (chrome-coloured: provenance, not alarm).
const tierMismatch = rollup ? servingTierReport(rollup.perLegModels, runStartLeg, d?.model?.display_name ?? '') : null;
// Per-leg EFFECTIVE units = raw units × the leg's tier weight relative to the main tier (a Sonnet
// opening leg on a Fable session weighs 0.2). `base` = this run's total_cost_usd over this run's
// effective units (main legs from runStartLeg on + this run's tier-weighted agents), so every $
// derived from units below is tier-true and run-anchored, and mainSessionUsd + agentsUsd ≡
// total_cost_usd by construction (both are shares of the same divisor). Legs before runStartLeg
// (a resumed session's earlier runs) are still priced — at this run's rate.
const perLegEff = rollup ? rollup.perLegUnits.map((u, i) => Number(u) * tierWeight(rollup.perLegModels?.[i], mainTier)) : [];
let runMainEff = 0; for (let i = runStartLeg; i < perLegEff.length; i++) runMainEff += perLegEff[i];
const agentUnits = agentAgg ? Number(agentAgg.sumEffUnits) : 0;
const totalUnits = runMainEff + agentUnits;
let agentsUsd = null, mainSessionUsd = null, baseTrue = null;
if (totalUnits > 0 && sessionCost > 0) {
  baseTrue = Number(sessionCost) / totalUnits;
  mainSessionUsd = baseTrue * runMainEff;
  agentsUsd = baseTrue * agentUnits;
}
// Sanity tripwire for the resume the detection cannot reach (no local history): a base far below
// the main tier's list price means the units span more than the cost does. Flag, never recompute.
const listUnitUsd = (mainTier != null && mainTier in TIER_BASE) ? TIER_BASE[mainTier] / 1e6 : null; // list $/unit at the main tier
const legPricingSuspect = (listUnitUsd != null && baseTrue != null && baseTrue < 0.5 * listUnitUsd);
let perLegCostArr = [];
if (rollup && totalUnits > 0 && sessionCost > 0) {
  perLegCostArr = perLegEff.map((u) => baseTrue * u);
}
let forecast = null;
if (rollup && sessionCost > 0 && Number(rollup.nLegs) > 0
  && totalUnits > 0 && !isNil(ctxTok) && ctxTok > 0) {
  const base = baseTrue;
  const floorUnits = M_CACHE_READ * Number(ctxTok);
  const ownArr = rollup.perLegOwnUnits.slice();
  const ownTail = ownArr.length > 5 ? ownArr.slice(ownArr.length - 5) : ownArr;
  // Raw — the next leg runs at the CURRENT tier (weight 1 against itself).
  const nextUnits = floorUnits + Median(ownTail);
  forecast = base * nextUnits;
  costNextPart = DarkGray('next ') + ColorLegCell(forecast, '$' + fmtN(forecast, 2));
}
if (rollup && !isNil(rollup.lastLegCost) && Number(rollup.lastLegCost) > 0) {
  const ltc = Number(rollup.lastLegCost);
  costLastPart = DarkGray('last ') + ColorLegCell(ltc, '$' + fmtN(ltc, 2));
}
// The recent RATE — the MEDIAN of the last min(8, N) per-leg dollars, the same figures `last leg`
// and the sparkline already show (perLegCostArr, so `base` is untouched and no per-leg dollar is
// recomputed by another route). Median, NOT mean: this chip is a per-leg dollar figure, on the
// per-leg gradient, between two other typical-leg figures — one compaction leg pulling a mean into
// the red band while every ordinary leg sat in yellow is a confidently wrong colour, which is the
// exact failure this build set out to delete. Spikes are the spikes panel's job; the cold-tax line
// counts them too. Same exported `median` as the `next` forecast's own-work term (leg-driver.mjs —
// even count → mean of the middle two), so the chip and the forecast are one statistic from one
// implementation. The label carries the REAL count (`last 3` … `last 8`), so the chip never claims a
// window it does not have; suppressed below 2 legs (at 1 it would just duplicate `last leg`). Same
// ColorLegCell gradient as `last leg` and `next`, so the three dollar figures on the line are one
// measure read against each other.
// It is labelled `med<N>`, not `last <N>`: with the realized last-leg figure two fields away and
// labelled `last`, a median labelled `last 8` would read as another member of the same series when
// the two are different statistics — one realized leg versus the median of N.
const recentN = Math.min(8, perLegCostArr.length);
if (recentN >= 2) {
  const recentUsd = median(perLegCostArr.slice(-recentN));
  costMedPart = DarkGray('med' + recentN + ' ') + ColorLegCell(recentUsd, '$' + fmtN(recentUsd, 2));
}
// The two $-reading caveats this cluster used to carry — the Fable/Opus gate calibration and the
// fast-premium understatement — are chips on the flags row now; the money row carries figures only.

// === Row 6 left: cold cache ================================================
// Retrospective: only the tax FIGURE survives, and it renders on the COST row as `cold $x.xx`. The
// tax percentage, the `legs C/T (P%)` count and share, and the recent-cold segment that dated the
// last paid re-cache are gone; every counter that fed them is still computed and still reaches the
// sidecar.
let coldStakes = null, coldRemain = null, coldBand = null;
let costColdPart = null;
let coldValue = '';
if (rollup && Number(rollup.nColdLegs) >= 1 && totalUnits > 0 && sessionCost > 0) {
  const coldTax = baseTrue * Number(rollup.coldWastedUnits);
  costColdPart = DarkGray('cold ') + ColorCost(coldTax, '$' + fmtN(coldTax, 2));
}
// Prospective: what a cold resume would cost from here — the only thing this row displays. Gates are
// unchanged: the $0.25 stake floor, and the calm-band suppression (`wCol === '2'`), which leaves the
// row EMPTY through the runway where every leg resets the clock and there is nothing to act on. The
// snowflake marker is gone from the fixed rows — the label names the cluster and the countdown
// carries the calm-to-cooling ramp — and survives as the spotlight cold-leg glyph.
if (rollup && !isNil(ctxTok) && ctxTok > 0 && totalUnits > 0 && sessionCost > 0) {
  const coldBase = baseTrue;
  const ttlSec = ('lastLegTtlSec' in rollup && Number(rollup.lastLegTtlSec) > 0) ? Number(rollup.lastLegTtlSec) : 300;
  coldStakes = coldBase * Number(ctxTok) * (CacheWriteMult(ttlSec) - M_CACHE_READ);
  if (coldStakes >= 0.25) {
    const stakesStr = '+$' + fmtN(coldStakes, 2);
    if (!isNil(rollup.lastLegTs)) {
      coldRemain = ttlSec - (NOW - Number(rollup.lastLegTs));
      if (coldRemain > 0) {
        // wCol is now purely the calm-band GATE; the ramp the row renders is tCol. tCol's own calm
        // rung is the chrome tone rather than SGR-2 — it is unreachable (the two calm conditions are
        // the same threshold) and this file emits no second gray.
        let wCol, tCol, amtBright;
        if (ttlSec >= 3600) {
          wCol = coldRemain > 2400 ? '2' : '38;5;33';
          tCol = coldRemain > 2400 ? '38;5;240' : coldRemain > 1200 ? '38;5;33'
            : coldRemain > 600 ? '97' : coldRemain > 300 ? '38;5;220'
              : coldRemain > 120 ? '38;5;208' : '1;31';
          amtBright = (coldRemain <= 600);
        } else {
          wCol = coldRemain > 240 ? '2' : '38;5;33';
          tCol = coldRemain > 240 ? '38;5;240' : coldRemain > 180 ? '97'
            : coldRemain > 120 ? '38;5;220' : coldRemain > 60 ? '38;5;208' : '1;31';
          amtBright = (coldRemain <= 180);
        }
        coldBand = ttlSec >= 3600
          ? (coldRemain > 2400 ? 'calm' : coldRemain > 600 ? 'heads-up' : coldRemain > 300 ? 'act-soon' : 'urgent')
          : (coldRemain > 240 ? 'calm' : coldRemain > 120 ? 'heads-up' : coldRemain > 60 ? 'act-soon' : 'urgent');
        const amt = amtBright ? ColorLegCell(coldStakes, stakesStr) : DarkGray(stakesStr);
        if (wCol !== '2') {
          // Keep-warm alternative (display-only): a `max_tokens: 0` API ping refreshes the still-warm
          // cache at cache-READ price — base × ctx × 0.10, TTL-independent — vs the full rebuild
          // stake shown next to it. Only meaningful while cooling (nothing left to refresh once expired).
          const keepWarmUsd = coldBase * Number(ctxTok) * M_CACHE_READ;
          coldValue = DarkGray('in ') + `${ESC}[${tCol}m${FmtDuration(psRound(coldRemain))}${ESC}[0m`
            + ' ' + amt + DarkGray(' · keep-warm $' + fmtN(keepWarmUsd, 2));
        }
      } else {
        const ttlLabel = ttlSec >= 3600 ? '>1h' : '>5m';
        coldBand = 'expired';
        coldValue = ColdBlue('?') + ' ' + RedBold(ttlLabel) + ' ' + ColorLegCell(coldStakes, stakesStr);
      }
    } else {
      coldBand = 'expired';
      coldValue = DarkGray('risk ') + ColorLegCell(coldStakes, stakesStr);
    }
  }
}

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
      // Since ~CC 2.1.209 every user line carries "origin":{"kind":...}: typed prompts are
      // "human"; system-injected entries (task-notification etc.) are anything else — skip those only.
      if (/"origin"\s*:\s*\{/.test(line) && !/"origin"\s*:\s*\{[^}]*"kind"\s*:\s*"human"/.test(line)) continue;
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
      // The Bun-era writer (≥ ~2.1.215) emits one assistant line PER CONTENT BLOCK, each repeating
      // the same message.id + full usage — dedup on message.id so a K-block reply counts once.
      // Id-less usage lines keep counting individually (cannot be deduped). HAZARD: first-wins is
      // exact for MAIN transcripts only (identical usage per dup line); agent transcripts carry
      // PROGRESSIVE output_tokens — see the max-wins branch in UpdateAgentRollups.
      const seenTpsIds = new Set();
      for (let i = latestUserIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message && parsed.message.usage && parsed.message.usage.output_tokens) {
            const msgId = parsed.message.id;
            if (msgId) {
              if (seenTpsIds.has(msgId)) continue;
              seenTpsIds.add(msgId);
            }
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
        tpsRendered = DarkGray('turn ') + FmtDuration(psRound(duration)) + DarkGray(' @ ') + coloredTps;
      }
    }
  } catch {}
}


// === Row 2 right: per-leg cost trend =======================================
// Bucketing is today's algorithm verbatim: N <= 8 is one leg per cell with LEFT padding, so
// position 8 stays the newest-leg anchor; above 8 the rightmost N mod 8 buckets take ceil(N/8) legs
// and the rest floor(N/8). Zero legs is not a special case — it is the N <= 8 path with an empty
// array, so the widget shows its shape instead of an unexplained gap.
const TREND_SLOT_W = 6;
let trendValue = '';
{
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
  // The value is left-aligned so the $ signs line up across the strip, and the tint covers the
  // WHOLE slot — pad included — so adjacent chips form one continuous band. A value needing 6 or
  // more cells (a leg >= $10) keeps its one tinted pad space and pushes the row's tail right by one.
  // An absent cell is untinted placeholder dots in the same 6 cells.
  const cells = bucketAvgs.map((c) => {
    if (isNil(c)) return DarkGray('··') + ' '.repeat(TREND_SLOT_W - 2);
    const v = '$' + fmtN(c, 2);
    return BgTint(LegRGB(c), v + ' '.repeat(Math.max(1, TREND_SLOT_W - visLen(v))));
  });
  trendValue = cells.join('') + ' ' + DarkGray(String(n));
}

// === Row 5 left: sub-agent fleet ===========================================
// The median-and-max parenthetical is gone (agentCtxMax survives in the sidecar; per-agent detail
// lives in /handover-check's agent panel). The tier-mix caveat moves to the flags row.
let agentsValue = '';
let tierMixChip = null;
if (agentAgg && Number(agentAgg.nAgents) > 0) {
  const aParts = [];
  aParts.push(String(Number(agentAgg.nAgents)) + DarkGray(' ag'));
  aParts.push(DarkGray('sum ') + FmtNum(Number(agentAgg.sumMaxCtx)));
  if (!isNil(agentsUsd)) {
    let costChip = ColorCost(agentsUsd, '$' + fmtN(agentsUsd, 2));
    if (sessionCost > 0) costChip += ' ' + DarkGray(psRound(100.0 * Number(agentsUsd) / Number(sessionCost)).toString() + '%');
    aParts.push(costChip);
  }
  const avgLegs = Number(agentAgg.nAgents) > 0 ? Number(agentAgg.sumLegs) / Number(agentAgg.nAgents) : 0;
  aParts.push(fmtN(avgLegs, 1) + DarkGray(' l/ag'));
  agentsValue = aParts.join(DarkGray(' · '));
  // Tier-mix chip: main named separately from the per-tier agent head-count, so the main+agents
  // totals can never misread (12 agents vs a 13-entry tier sum). Fires when main + agents span
  // more than one tier — 'other' (present-but-unmapped model) counts, absent/empty models never
  // do (pre-change caches with no `model` field can't fire this). The $ split itself is
  // tier-weighted above; the chip stays as the visibility layer. It renders on the flags row, in
  // full, breakdown included — that row is the one allowed to run long.
  const agTiers = agentAgg.tierCounts || {};
  const agTierNames = Object.keys(agTiers).sort();
  const distinct = new Set(agTierNames);
  if (mainTier) distinct.add(mainTier);
  if (distinct.size > 1) {
    const agList = agTierNames.map((t) => `${t}×${agTiers[t]}`).join('·');
    const mainPart = mainTier ? `main·${mainTier}` : null;
    const agPart = agList ? `ag ${agList}` : null;
    tierMixChip = DarkGray('⚠ tier-mix ' + [mainPart, agPart].filter(Boolean).join(' + '));
  }
}

// === Rows 3 and 4: quota gauge + runway ====================================
const qBlocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const nowQ = NOW;
// BOTH rows now render at every quota level, so what changes with the level is which machinery runs.
// Two regimes, two named boundaries:
//   • Below QUOTA_VERDICT_MIN_PCT the beta rung machinery does not run AT ALL — no beta, no rung, no
//     bump, no imperative. beta = 1 - t/q is unstable when little of the window has elapsed (2%
//     consumed in 1% elapsed projects "slow down hard"), which is exactly what the old >=50% row
//     suppression kept off the screen. What renders instead is the ratio projection: where this
//     window is heading, with no instruction attached.
//   • The projection has its own floor, QUOTA_PROJECTION_MIN_ELAPSED_PCT, because rho = q/t blows up
//     as t approaches zero. Below it the row is the gauge and `resets`, nothing else.
// At and above the verdict floor the beta maths, the >=8h bump, the rung mapping and the at-cap
// override run exactly as before — with rung 0 rendering chrome instead of green, because these rows
// are always on now and a green row on every calm session would make calm the loudest thing here.
const QUOTA_VERDICT_MIN_PCT = 50;
const QUOTA_PROJECTION_MIN_ELAPSED_PCT = 10;
const QUOTA_CALM_COL = '38;5;240';
function QLvl(p) { let l = psRound(p / 100.0 * 8); if (p > 0 && l < 1) l = 1; if (l > 8) l = 8; return l; }
function QuotaCells(rl, winSec) {
  if (!rl || isNil(rl.used_percentage)) return null;
  const consumed = Number(rl.used_percentage);
  let elapsed = null;
  if (rl.resets_at) {
    const remain = Number(rl.resets_at) - nowQ;
    elapsed = ((winSec - remain) / winSec) * 100.0;
    if (elapsed < 0) elapsed = 0; if (elapsed > 100) elapsed = 100;
  }
  const q = consumed / 100.0;
  const t = !isNil(elapsed) ? elapsed / 100.0 : null;
  const cbar = qBlocks[QLvl(consumed)];
  const ebar = !isNil(elapsed) ? qBlocks[QLvl(elapsed)] : ' ';
  const qn = psRound(consumed);
  const tn = !isNil(elapsed) ? psRound(elapsed) : null;
  const mid = '→' + `${qn}%${cbar}${ebar}` + (!isNil(tn) ? `${tn}%` : '') + '←';
  const resets = rl.resets_at ? 'resets ' + FmtDurShort(psRound(Number(rl.resets_at) - nowQ)) : null;
  if (consumed < QUOTA_VERDICT_MIN_PCT) {
    // TWO named gates, and the projection is silent unless BOTH open.
    //   enoughElapsed — rho = q/t blows up as t approaches zero, so a projection off a sliver of
    //     elapsed time would be shown and disbelieved.
    //   underPace — `ends ~N% · M% spare` is the CALM phrasing, and rho is NOT bounded by 1: a
    //     window running ahead of the clock projects past 100% and a NEGATIVE spare (20% consumed
    //     in 12% elapsed reads `ends ~163% · -63% spare`). Below the verdict floor this cluster
    //     deliberately refuses to project a blackout at all, because beta is unstable this early —
    //     so for over-pace-but-young the honest output is SILENCE, not a nonsense number. Nothing
    //     is hidden: the gauge beside it already shows consumed against elapsed, and the reader can
    //     draw their own conclusion. This is the same condition rung 0 encodes above the floor
    //     (`beta <= 0` is exactly `t >= q`), so the two regimes agree on what "calm" means.
    const enoughElapsed = !isNil(elapsed) && elapsed >= QUOTA_PROJECTION_MIN_ELAPSED_PCT;
    const underPace = !isNil(elapsed) && consumed <= elapsed;
    const projection = (enoughElapsed && underPace)
      ? `ends ~${psRound((q / t) * 100)}% ` + '·' + ` ${psRound((1 - q / t) * 100)}% spare` : null;
    return { col: QUOTA_CALM_COL, mid, verdict: null, detail: projection, resets };
  }
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
  let col = rung === 0 ? QUOTA_CALM_COL : rung === 1 ? '38;5;220' : rung === 2 ? '38;5;208' : '1;31';
  let verdict, detail;
  if (exhausted) {
    col = '38;5;208';
    // The verdict drops the window label: the label field already carries 5h / 7d, and dropping the
    // repeat is what makes the exhausted state fit a half-width column.
    if (consumed > 100) { verdict = 'over cap'; detail = 'on usage credits ' + '·' + ' paying overage'; }
    else { verdict = 'cap reached'; detail = 'on credits, or blocked til reset'; }
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
  return { col, mid, verdict, detail, resets };
}
// An absent window states the fact in ONE token, rather than leaving a half-empty row that reads as
// a rendering bug.
function QuotaGaugeValue(c) {
  if (!c) return DarkGray('n/a');
  let s = `${ESC}[${c.col}m${c.mid}${ESC}[0m` + DarkGray(' time');
  if (c.verdict) s += '  ' + `${ESC}[${c.col}m${c.verdict}${ESC}[0m`;
  return s;
}
// The detail renders as ONE string in the row's rung colour, its connectives included: it is a
// sentence, not chrome, and splitting it into coloured and grey fragments would fight the alarm.
// When the assembled half would overflow its value field, `resets` is the field that drops — the
// least load-bearing figure on the row (the gauge's elapsed bar already says where in the window you
// are), and the last one, so dropping it leaves no hole.
function QuotaDetailValue(c, valueW) {
  if (!c) return '';
  const parts = [];
  if (c.detail) parts.push(`${ESC}[${c.col}m${c.detail}${ESC}[0m`);
  if (c.resets) parts.push(DarkGray(c.resets));
  if (parts.length === 0) return '';
  const full = parts.join(DarkGray(' · '));
  if (visLen(full) > valueW && c.detail && c.resets) return `${ESC}[${c.col}m${c.detail}${ESC}[0m`;
  return full;
}
const q5 = QuotaCells(d?.rate_limits?.five_hour, 18000);
const q7 = QuotaCells(d?.rate_limits?.seven_day, 604800);

// === Rows 7+: big-leg spotlight ============================================
// Selection is today's code, untouched. A cell shows the glyph, the leg index, the dollars and what
// the leg DID — the multiple-of-median and the age in legs are gone, as is the word `Leg` before the
// index (the glyph plus a number in the label field is unambiguous, and the label field is where it
// aligns with the fixed rows above).
const BIG_LEG_FLOOR_USD = 3.00;
const BIG_LEG_MULT = 3.0;
const BIG_LEG_MIN_USD = 0.50;
const BIG_LEG_WINDOW = 8;
// Colour is spent only on what happened: the leading verb of the driver, and — on a leg that went
// cold — the words saying the cache had expired. The verb list is exported by leg-driver.mjs, the
// file that owns the driver strings, so the two cannot drift.
function ColorDriver(drv) {
  const verb = DRIVER_VERBS.find((v) => drv.startsWith(v));
  const rest = verb ? drv.slice(verb.length) : drv;
  const head = verb ? `${ESC}[38;5;180m${verb}${ESC}[0m` : '';
  const COLD = 'cache expired';
  const i = rest.indexOf(COLD);
  if (i < 0) return head + (rest ? DarkGray(rest) : '');
  const before = rest.slice(0, i), after = rest.slice(i + COLD.length);
  return head + (before ? DarkGray(before) : '') + ColdBlue(COLD) + (after ? DarkGray(after) : '');
}
// A LEFT cell's driver truncates to fit: the left column's 53 cells position the divider, so a left
// cell that overran would bend the grid. A RIGHT cell's driver is never truncated — nothing renders
// to its right, so running long costs nothing. The same leg can therefore read in full on the right
// and clipped on the left; that is the decision, not an accident.
function SpotlightValue(cell, valueW, truncate) {
  const usd = ColorLegCell(cell.usd, '$' + fmtN(cell.usd, 2));
  const drv = truncate ? truncTo(cell.drv, valueW - visLen(usd) - 2) : cell.drv;
  return usd + '  ' + ColorDriver(drv);
}
let bigLegCells = [];
if (rollup && ('recentLegs' in rollup) && !isNil(baseTrue) && baseTrue > 0
  && !isNil(rollup.perLegUnits) && rollup.perLegUnits.length >= 1) {
  // Effective (tier-weighted) units throughout, like the trend strip.
  const medTail = perLegEff.length > 20 ? perLegEff.slice(perLegEff.length - 20) : perLegEff;
  const medUsd = Number(baseTrue) * Median(medTail);
  const nL = Number(rollup.nLegs);
  const blRows = [];
  for (const rec of rollup.recentLegs) {
    const legsAgo = nL - Number(rec.idx);
    if (legsAgo < 0 || legsAgo >= BIG_LEG_WINDOW) continue;
    const usd = Number(baseTrue) * Number(rec.units) * tierWeight(rec.model, mainTier);
    const isBig = (usd >= BIG_LEG_FLOOR_USD) || (medUsd > 0 && usd >= (BIG_LEG_MULT * medUsd) && usd >= BIG_LEG_MIN_USD);
    if (!isBig) continue;
    const glyph = testColdLeg(rec) ? ColdBlue('❆') : `${ESC}[38;5;179m◆${ESC}[0m`;
    const idx = String(Number(rec.idx));
    // An index of 5 or more digits drops the separating space rather than pushing the value column.
    const label = glyph + (idx.length >= 5 ? '' : ' ') + DarkGray(idx);
    blRows.push({ legsAgo, label, usd, drv: getDriver(rec) });
  }
  blRows.sort((a, b) => a.legsAgo - b.legsAgo);
  bigLegCells = blRows;
}

// === Cluster 5: session (built; display gated) =============================
const costParts = [];
let aliveSec = null;
if (tpath && existsSync(tpath)) {
  try { aliveSec = psRound(NOW - statSync(tpath).birthtimeMs / 1000); } catch {}
}
const apiSec = d?.cost?.total_api_duration_ms ? psRound(Number(d.cost.total_api_duration_ms) / 1000) : null;
if (!isNil(aliveSec) && !isNil(apiSec)) costParts.push(DarkGray(FmtDuration(aliveSec) + ' alive / ' + FmtDuration(apiSec) + ' api'));
else if (!isNil(aliveSec)) costParts.push(DarkGray(FmtDuration(aliveSec) + ' alive'));
else if (!isNil(apiSec)) costParts.push(DarkGray(FmtDuration(apiSec) + ' api'));
if (!isNil(d?.cost?.total_lines_added) || !isNil(d?.cost?.total_lines_removed)) {
  costParts.push(DarkGray(`+${d.cost.total_lines_added}/-${d.cost.total_lines_removed} lines`));
}
if (tpsRendered) costParts.push(tpsRendered);
if (tailWarning) costParts.push(RedBold('tail!'));
// today: chip — CC's stats-cache.json aggregates every session of this config home. A row is one
// blended number per model; since CC 2.1.221 (dailyModelTokensVersion 5) that number includes cache
// reads/writes, older files count input+output only — the label says which. Sidecar `todayTokens`
// carries the same fact (conditional key, present only when the chip fires).
let todayTokens = null;
const dailyStatsPath = join(ConfigHome, 'stats-cache.json');
if (existsSync(dailyStatsPath)) {
  try {
    const stats = readJson(dailyStatsPath);
    const today = new Date(NOW * 1000).toISOString().slice(0, 10); // UTC yyyy-MM-dd — CC keys rows by toISOString().split('T')[0]
    const todayEntry = Array.isArray(stats?.dailyModelTokens) ? stats.dailyModelTokens.find((e) => e && e.date === today) : null;
    if (todayEntry) {
      let sumToday = 0;
      for (const k of Object.keys(todayEntry.tokensByModel || {})) sumToday += Number(todayEntry.tokensByModel[k]) || 0;
      if (sumToday > 0) {
        const dmv = Number(stats.dailyModelTokensVersion) || 0;
        const includesCache = dmv >= 5;
        const n = sumToday >= 1e9 ? fmtN(sumToday / 1e9, 2) + 'B' : FmtNum(sumToday);
        costParts.push(DarkGray(`today: ${n} tokens ${includesCache ? 'incl. cache' : 'in+out only'} · all sessions`));
        todayTokens = { date: today, tokens: sumToday, includesCache, dailyModelTokensVersion: dmv };
      }
    }
  } catch {}
}
const line5 = costParts.length > 0 ? DarkGray('session: ') + costParts.join(DarkGray(' | ')) : null;

// === Sidecar snapshot ======================================================
// Two-phase write. Phase 1 (here) runs BEFORE the git subprocess cluster below, so a slow or
// hung git can never delay the snapshot that /handover-check and the render-* panels consume:
// it carries the full cost/context state plus the PREVIOUS render's gitRepo, and a cancellation
// mid-git still leaves this fresh snapshot behind. Phase 2 (after the git cluster) re-writes the
// SAME snapshot with only gitRepo refreshed off the live git read — live when git resolves a
// repo, the last-known value when it doesn't (the identity never decays on a git failure).
// Both phases go through the same atomic writer.
let sidecarSnapshot = null;
function writeSidecar(json) {
  if (cwd) {
    const projDir = join(cwd, '.claude');
    if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
    atomicWriteFile(join(projDir, 'statusline-last.json'), json);
  }
  atomicWriteFile(join(ConfigHome, 'statusline-last.json'), json);
}
try {
  const absState = isNil(ctxUsed) ? null
    : ctxUsed < 32000 ? 'pristine' : ctxUsed < 128000 ? 'green' : ctxUsed < 256000 ? 'yellow' : ctxUsed < 500000 ? 'orange' : 'red';
  const fillStateV = isNil(ctxPct) ? null
    : ctxPct < 50 ? 'green' : ctxPct < 70 ? 'yellow' : ctxPct < 85 ? 'orange' : 'red';
  // Auto-compact off → toCompact is null (there is no compaction point) + the always-present
  // autoCompactOff flag, so handover-facts can phrase headroom honestly instead of "N to compact".
  const toCompactTok = (!AC_OFF && !isNil(ctxUsed) && !isNil(ctxSize)) ? CompactAt(ctxSize) - ctxUsed : null;
  const activityPct = (aliveSec && Number(aliveSec) > 0 && !isNil(apiSec)) ? mathRoundD(100.0 * apiSec / aliveSec, 1) : null;
  let coldStakeUsd = null, coldState = null, coldCoolRemainSec = null;
  if (!isNil(coldStakes) && coldStakes >= 0.25) {
    coldStakeUsd = mathRoundD(Number(coldStakes), 2);
    if (rollup && !isNil(rollup.lastLegTs)) {
      if (!isNil(coldRemain) && coldRemain > 0) { coldState = 'cooling'; coldCoolRemainSec = psRound(coldRemain); }
      else coldState = 'cold';
    } else coldState = 'idle-cold';
  }
  const sidecarPath = cwd ? join(cwd, '.claude', 'statusline-last.json') : join(ConfigHome, 'statusline-last.json');
  const prevSnap = readJson(sidecarPath);
  const prevGitRepo = (prevSnap && !isNil(prevSnap.gitRepo)) ? prevSnap.gitRepo : null;
  const snapshot = {
    schema: 6,
    sessionId: sessionId ?? null,
    renderedAt: NOW,
    transcriptPath: tpath ?? null,
    model,
    // Present ONLY when a mid-session tier switch occurred (keeps the golden blast radius to the
    // switch fixtures; consumers already handle absent keys).
    ...(rollup && rollup.modelSwitch ? { modelSwitch: rollup.modelSwitch } : {}),
    // Present ONLY when the display tier is mapped and has NEVER served in this run (see
    // servingTierReport): { display, serving }. Provenance for the fact sheet's COST_TIER_NOTE — it
    // gates no number. Additive + conditional, so no schema bump (the fastMode / sessionName
    // precedent).
    ...(tierMismatch ? { tierMismatch } : {}),
    windowSize: ctxSize ?? null,
    effort,
    ctxTokens: ctxUsed ?? null,
    fillPct: ctxPct ?? null,
    ctxAbsState: absState,
    fillState: fillStateV,
    toCompact: toCompactTok,
    autoCompactOff: AC_OFF,
    costUsd: costUsd ?? null,
    nextLegUsd: forecast,
    lastLegUsd: rollup ? (rollup.lastLegCost ?? null) : null,
    nLegs: rollup ? Number(rollup.nLegs) : null,
    // First leg of the CURRENT run (0 = the session's first run); legs before it predate this
    // run and are priced at this run's rate. Present whenever a rollup exists.
    runStartLeg: rollup ? Number(rollup.runStartLeg) : null,
    // Present ONLY when the base sits far below the main tier's list price (a resume the
    // detection could not see — no local history); the $ are flagged, never recomputed.
    ...(legPricingSuspect ? { legPricingSuspect: true } : {}),
    // Present ONLY when fast mode is on: every $ in this sidecar excludes the fast premium.
    ...(fastMode ? { fastMode: true } : {}),
    // Present ONLY when the payload carries a session_name: the snapshot owner's name, persisted at
    // write time so the fact sheet's FOREIGN guard can name that side in words.
    ...(sessionName ? { sessionName } : {}),
    // Present ONLY when today's row exists in stats-cache.json with a positive sum: what the
    // today: chip (session line) states, incl. whether the number counts cache tokens.
    ...(todayTokens ? { todayTokens } : {}),
    nColdLegs: rollup ? Number(rollup.nColdLegs) : null,
    coldWastedUsd: (rollup && totalUnits > 0 && sessionCost > 0) ? mathRoundD(baseTrue * Number(rollup.coldWastedUnits), 2) : null,
    lastColdTaxUsd: (rollup && totalUnits > 0 && sessionCost > 0 && ('lastColdWastedUnits' in rollup)) ? mathRoundD(baseTrue * Number(rollup.lastColdWastedUnits), 2) : null,
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
    gitRepo: prevGitRepo,
  };
  sidecarSnapshot = snapshot;
  writeSidecar(JSON.stringify(snapshot));
} catch {}

// === Cluster 6: git ========================================================
// The sync glyph is hoisted out of the porcelain parse so the repo cluster can render it during
// row assembly at the end of the file — the two-phase sidecar write must not wait on git.
let gitSync = null;
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
    gitSync = sync;
  }
}

// === Sidecar gitRepo refresh (phase 2 of the sidecar write) ================
// Seeds/updates the identity chain the phase-1 write reuses: fresh slug when git resolved one,
// carry the last-known value when it didn't. No other snapshot field changes between the phases.
try {
  if (sidecarSnapshot) {
    sidecarSnapshot.gitRepo = repo ?? sidecarSnapshot.gitRepo;
    writeSidecar(JSON.stringify(sidecarSnapshot));
  }
} catch {}

// The session line (Florian's choice, 2026-08-17) has NO row in the grid. It is still BUILT above and
// its facts still feed the sidecar — aliveSec, apiSec, tps, activityPct, linesAdded, linesRemoved and
// the conditional todayTokens — it simply is not rendered. The old `ShowSessionLine` gate is gone
// rather than kept: the assembler below has no branch that could read it, and a constant documenting
// an intent it no longer enforces is worse than no constant.

// === Row assembly — the dossier grid =======================================
// Up to six fixed rows in a frozen order, then a variable block of spotlight rows, two legs to a
// row. A cluster with nothing to say contributes NOTHING — no label, no glyph — and a fixed row
// whose two halves are both silent drops out (gridRow returns null, filtered below). So the grid
// keeps its column geometry on every session but not its height.
const costValue = [costTotalPart, costLastPart, costNextPart, costMedPart, costColdPart]
  .filter(Boolean).join('  ');

// The flags cluster, in the frozen order: the two mode chips, the style chip, then the five
// conditional caveats ordered by how much each changes the way a number must be read. Every chip
// keeps its text verbatim — this row is allowed to run long, so width is never a reason to
// abbreviate a caveat into ambiguity. Each mode chip fires on ONE state only — fast mode is named
// when it is on, thinking when it is off — so the reassuring half of either pair never renders.
const flagChips = [];
if (fastMode) flagChips.push(DarkGray('fast ') + Magenta('on'));
if (thinking === false) flagChips.push(DarkGray('think ') + BrightCyan('off'));
// The style name is the chip's VALUE and carries the colour, exactly as `fast on` and `think off`
// do — the whole chip in chrome gray made the one flag most likely to be on the hardest to see.
if (style && style !== 'default') flagChips.push(DarkGray('style ') + White(style));
if (legPricingSuspect && perLegCostArr.length > 0) {
  flagChips.push(DarkGray('⚠ leg $ suspect: base far below list (resumed without history?)'));
}
// Fast mode: CC's total_cost_usd omits the fast premium, so every $ shown is low. Warn, don't
// recompute — no factor is quoted here by design (it lives in watch/dependency-surface.md).
if (fastMode && !isNil(costUsd)) flagChips.push(DarkGray('⚠ $ excludes fast premium (understated)'));
// temporary — removed by Stage B (dollar-gate re-anchor): the $ color bands / verdict floors are
// calibrated on Fable/Opus headline pricing, so on a sonnet/haiku main the dollars gate too hot.
if (!isNil(costUsd) && (mainTier === 'sonnet' || mainTier === 'haiku')) {
  flagChips.push(DarkGray('⚠ $-gates Fable/Opus-calibrated'));
}
if (tierMismatch) flagChips.push(DarkGray('⚠ serving:' + tierMismatch.serving));
if (tierMixChip) flagChips.push(tierMixChip);
const flagsValue = flagChips.join('  ');

// `no repo` is two words, not the label alone: the label alone would leave the version badges
// sitting directly after `repo` and reading as the repo's own name.
const versionBadges = (version ? DarkGray('v' + version) + '  ' : '') + DarkGray('bsl' + SL_VERSION);
const repoValue = (repo ? repo + ' ' + gitSync : DarkGray('no repo')) + '  ' + versionBadges;

const rows = [];
rows.push(gridRow(DarkGray('model'), modelValue, DarkGray('cost'), costValue));
rows.push(gridRow(DarkGray('ctx'), ctxValue, DarkGray('trend'), trendValue));
rows.push(gridRow(DarkGray('5h'), QuotaGaugeValue(q5), DarkGray('7d'), QuotaGaugeValue(q7)));
rows.push(gridRow('', QuotaDetailValue(q5, LEFT_VALUE_W), '', QuotaDetailValue(q7, RIGHT_VALUE_W)));
rows.push(gridRow(DarkGray('⁂'), agentsValue, DarkGray('repo'), repoValue));
rows.push(gridRow(DarkGray('cold'), coldValue, DarkGray('flags'), flagsValue));
// Newest leg first, left before right. On an odd count the last row's right half stays empty — the
// block never borrows the free half beside a fixed row and never promotes a leg into it.
for (let i = 0; i < bigLegCells.length; i += 2) {
  const a = bigLegCells[i], b = bigLegCells[i + 1];
  rows.push(gridRow(a.label, SpotlightValue(a, LEFT_VALUE_W, true),
    b ? b.label : '', b ? SpotlightValue(b, RIGHT_VALUE_W, false) : ''));
}

process.stdout.write(rows.filter(Boolean).join('\n'));
