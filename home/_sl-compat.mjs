// _sl-compat.mjs — numeric/temporal primitives shared by the Node status-line cluster.
//
// These pin the exact .NET/PowerShell number-formatting and timestamp semantics the status line was
// built against (the line was originally a PowerShell renderer), so rendering stays stable across
// engines/Node versions and the goldens don't drift. Centralising them is the single biggest
// correctness lever; every site that formats a number or reads the clock goes through here.
// See tools/parity/ for the golden test.
//
// The three traps these close (vs. naive JS):
//   1. Integer rounding. PowerShell [int] and [Math]::Round(x) use banker's rounding
//      (round-half-to-EVEN); JS Math.round is half-away-from-zero. → psRound.
//   2. Decimal formatting. PowerShell's '{0:N2}'/'{0:N1}'/'{0:N0}' (.NET Core) round the
//      EXACT binary value half-to-even and group thousands with ','. JS toFixed rounds
//      half-AWAY on exact binary ties (0.125→0.13 vs .NET 0.12; 0.25→0.3 vs .NET 0.2)
//      and never groups. → fmtN.
//   3. UTC timestamp parsing. The .NET DateTimeOffset.Parse(..., AssumeUniversal) treats
//      a bare (offset-less) ISO datetime as UTC; JS Date.parse treats it as LOCAL. → parseUtcEpoch.

import { writeFileSync, renameSync, unlinkSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// atomicWriteFile(path, text) — crash-safe state write: write to a temp file in the SAME directory
// (rename is only atomic within one filesystem), then rename over the target. A kill between the
// two steps leaves the ORIGINAL file intact plus an orphaned <path>.tmp.<pid>, which no reader
// ever opens (readers target exact filenames) and the writers' housekeeping sweeps. On error the
// temp is unlinked best-effort and the error rethrown — callers keep their own try/catch policy.
export function atomicWriteFile(path, text) {
  const tmp = path + '.tmp.' + process.pid;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// sweepStaleFiles(dir, cutoffEpoch, { match, keepPrefix }) — the writers' housekeeping sweep for
// the state files atomicWriteFile produces. Removes every entry of `dir` (non-recursive) whose
// mtime (epoch seconds) is older than `cutoffEpoch` and whose name passes `match(name)`, skipping
// names that start with `keepPrefix` (the caller's own live files). Best-effort by contract: a
// missing dir, an unreadable entry, a concurrent delete — every error is swallowed, nothing throws.
export function sweepStaleFiles(dir, cutoffEpoch, { match, keepPrefix } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    try {
      if (keepPrefix && name.startsWith(keepPrefix)) continue;
      if (typeof match === 'function' && !match(name)) continue;
      const fp = join(dir, name);
      if (statSync(fp).mtimeMs / 1000 < cutoffEpoch) rmSync(fp, { force: true });
    } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Clock seam. Mirrors statusline-bloated.ps1's $script:NowEpoch / Get-NowLocal.
// CLAUDE_SL_NOW_EPOCH (epoch seconds, UTC) freezes "now" for the parity harness;
// unset → the real clock. nowEpoch() is the integer-seconds value used everywhere the
// pwsh side reads [int]$script:NowEpoch (== [int][double]::Parse(Get-Date -UFormat %s)).
export function nowEpoch() {
  const env = process.env.CLAUDE_SL_NOW_EPOCH;
  if (env) return Math.trunc(Number(env));
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// psRound(x) — integer round-half-to-even, matching PowerShell [int]x and [Math]::Round(x).
//   [int]2.5 -> 2, [int]3.5 -> 4, [int]0.5 -> 0, [int]-0.5 -> 0, [int]-1.5 -> -2, [int]99.383 -> 99.
export function psRound(x) {
  const fl = Math.floor(x);
  const fr = x - fl;
  if (fr < 0.5) return fl;
  if (fr > 0.5) return fl + 1;
  return (fl % 2 === 0) ? fl : fl + 1; // exact .5 -> nearest even
}

// ---------------------------------------------------------------------------
// mathRoundD(x, d) — replicate .NET [Math]::Round(x, d) (used for SIDECAR fields, not stdout).
// .NET Math.Round(double,int) scales by 10^d, rounds half-to-even, unscales — so the x*10^d
// FP error is part of the result (e.g. Round(2.355,2) -> 2.36, UNLIKE the "N2" formatter which
// rounds the exact value to 2.35). JS uses the same IEEE multiply, so psRound(x*p)/p matches.
export function mathRoundD(x, d) {
  const p = 10 ** d;
  return psRound(x * p) / p;
}

// ---------------------------------------------------------------------------
// fmtN(x, d) — replicate .NET Core "N{d}" composite formatting (PowerShell '{0:N<d>}' -f x):
// round the exact binary value of x to d decimals using round-half-to-EVEN, then group the
// integer part in threes with ',' (en-US — the machine culture this cluster targets).
//
// Implementation: take a high-precision decimal expansion of |x| (toFixed at d+18 places —
// far past any tie boundary), then round to d places with pure integer/string math (BigInt),
// so neither the x*10^d scaling error nor toFixed's away-on-tie rule can intrude.
export function fmtN(x, d = 0) {
  const neg = x < 0;
  const ax = Math.abs(x);
  const P = Math.min(d + 18, 100);
  const hp = ax.toFixed(P); // correctly-rounded long expansion; exact ties end in 5 then zeros
  const dot = hp.indexOf('.');
  const ip = dot < 0 ? hp : hp.slice(0, dot);
  const dp = dot < 0 ? '' : hp.slice(dot + 1);
  const keep = dp.slice(0, d);
  const rest = dp.slice(d); // tail beyond the d-th decimal — decides the rounding
  let n = BigInt(ip + keep.padEnd(d, '0')); // integer value scaled by 10^d (floored)
  if (rest.length) {
    const first = rest[0];
    if (first > '5') n += 1n;
    else if (first === '5') {
      if (/[1-9]/.test(rest.slice(1))) n += 1n;        // strictly > .5 -> up
      else if (n % 2n === 1n) n += 1n;                  // exact .5 tie -> half to even
    }
  }
  let s = n.toString();
  let intPart, fracPart;
  if (d > 0) {
    while (s.length <= d) s = '0' + s;
    intPart = s.slice(0, s.length - d);
    fracPart = s.slice(s.length - d);
  } else {
    intPart = s;
    fracPart = '';
  }
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = (neg && n !== 0n) ? '-' : '';
  return d > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

// ---------------------------------------------------------------------------
// parseUtcEpoch(s) — epoch SECONDS (floored) from an ISO-8601 timestamp string, treating a
// bare offset-less datetime as UTC (mirrors .NET AssumeUniversal). Returns null on failure.
// Matches the leg-scan path: [DateTimeOffset]::Parse(..., AssumeUniversal|AdjustToUniversal).ToUnixTimeSeconds().
export function parseUtcEpoch(s) {
  if (s == null) return null;
  let str = String(s);
  // If there's no trailing Z and no explicit ±HH:MM offset on the time part, assume UTC.
  if (!/[zZ]$/.test(str) && !/[+-]\d{2}:?\d{2}$/.test(str)) str += 'Z';
  const t = Date.parse(str);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 1000);
}

// parseUtcMs(s) — like parseUtcEpoch but keeps millisecond precision (for sub-second
// durations, e.g. the turn-TPS math). Returns null on failure. Mirrors
// [DateTime]::Parse(s).ToUniversalTime() used at statusline-bloated.ps1 ~L1111.
export function parseUtcMs(s) {
  if (s == null) return null;
  let str = String(s);
  if (!/[zZ]$/.test(str) && !/[+-]\d{2}:?\d{2}$/.test(str)) str += 'Z';
  const t = Date.parse(str);
  return Number.isNaN(t) ? null : t;
}
