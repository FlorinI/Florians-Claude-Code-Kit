import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psRound, fmtN, parseUtcEpoch, parseUtcMs, nowEpoch } from '../home/_sl-compat.mjs';

// Expected values are GROUND TRUTH captured from PowerShell 7.6 on en-US (the deploy target):
//   [int]x / [Math]::Round(x)   and   '{0:N<d>}' -f x
// See the probe in the migration session. Any divergence here is a real parity bug.

test('psRound — banker\'s rounding matches PowerShell [int]/[Math]::Round', () => {
  const cases = [[0.5, 0], [1.5, 2], [2.5, 2], [3.5, 4], [-0.5, 0], [-1.5, -2], [99.383, 99], [56.25, 56], [4.5, 4]];
  for (const [x, exp] of cases) assert.equal(psRound(x), exp, `psRound(${x})`);
});

test('fmtN d=2 — matches .NET N2 (incl. exact-tie half-to-even)', () => {
  const cases = [
    [0.125, '0.12'], [0.135, '0.14'], [0.005, '0.01'], [0.015, '0.01'],
    [0.025, '0.03'], [2.345, '2.35'], [2.355, '2.35'], [1234.5, '1,234.50'],
  ];
  for (const [x, exp] of cases) assert.equal(fmtN(x, 2), exp, `fmtN(${x},2)`);
});

test('fmtN d=1 — matches .NET N1 (incl. exact-tie half-to-even)', () => {
  const cases = [
    [0.05, '0.1'], [0.15, '0.1'], [0.25, '0.2'], [1.25, '1.2'], [1.35, '1.4'], [12345.65, '12,345.6'],
  ];
  for (const [x, exp] of cases) assert.equal(fmtN(x, 1), exp, `fmtN(${x},1)`);
});

test('fmtN d=0 — matches .NET N0 (banker\'s + grouping)', () => {
  const cases = [
    [0.5, '0'], [1.5, '2'], [2.5, '2'], [1234.5, '1,234'], [1234567, '1,234,567'],
  ];
  for (const [x, exp] of cases) assert.equal(fmtN(x, 0), exp, `fmtN(${x},0)`);
});

test('fmtN — typical status-line dollar/ratio/token values', () => {
  assert.equal(fmtN(1.23, 2), '1.23');
  assert.equal(fmtN(154.29, 2), '154.29');
  assert.equal(fmtN(51001 / 1e3, 1), '51.0');     // FmtNum k-path
  assert.equal(fmtN(1000000 / 1e6, 2), '1.00');   // FmtNum M-path
  assert.equal(fmtN(899000, 0), '899,000');
  assert.equal(fmtN(0, 2), '0.00');
});

test('parseUtcEpoch — Z-suffixed ISO parsed as UTC, floored to seconds', () => {
  // 2026-06-18T12:34:56.789Z
  const e = parseUtcEpoch('2026-06-18T12:34:56.789Z');
  assert.equal(e, Math.floor(Date.UTC(2026, 5, 18, 12, 34, 56, 789) / 1000));
});

test('parseUtcEpoch — bare offset-less datetime assumed UTC (AssumeUniversal)', () => {
  const withZ = parseUtcEpoch('2026-06-18T12:34:56Z');
  const bare = parseUtcEpoch('2026-06-18T12:34:56');
  assert.equal(bare, withZ, 'bare datetime must equal the same instant marked Z');
});

test('parseUtcEpoch — explicit offset honoured, not double-shifted', () => {
  const off = parseUtcEpoch('2026-06-18T15:34:56+03:00');
  const utc = parseUtcEpoch('2026-06-18T12:34:56Z');
  assert.equal(off, utc);
});

test('parseUtcEpoch — junk returns null', () => {
  assert.equal(parseUtcEpoch('not a date'), null);
  assert.equal(parseUtcEpoch(null), null);
});

test('parseUtcMs — keeps millisecond precision', () => {
  assert.equal(parseUtcMs('2026-06-18T12:34:56.789Z'), Date.UTC(2026, 5, 18, 12, 34, 56, 789));
});

test('nowEpoch — honours CLAUDE_SL_NOW_EPOCH', () => {
  const prev = process.env.CLAUDE_SL_NOW_EPOCH;
  process.env.CLAUDE_SL_NOW_EPOCH = '1781740000';
  try {
    assert.equal(nowEpoch(), 1781740000);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_SL_NOW_EPOCH;
    else process.env.CLAUDE_SL_NOW_EPOCH = prev;
  }
});
