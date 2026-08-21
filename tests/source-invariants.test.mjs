import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// source-invariants — static checks pinned by the 2026-07-14 Claude-5 correctness sprint's
// acceptance rows (A5, E4, F2, F3-order, D4). They read source text, not behaviour: each one
// guards a property that has no runtime observable (a constants-not-config constraint, a deleted
// stale comment, which write primitive a call site uses, top-to-bottom execution order).

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const src = (p) => readFileSync(join(repo, ...p.split('/')), 'utf8');

// ---- A5: TIER_BASE is literal constants — no fetching, no config, no env ----------------------
test('A5 — TIER_BASE is a hand-maintained literal map in leg-driver.mjs', () => {
  const s = src('home/leg-driver.mjs');
  assert.match(s, /export const TIER_BASE = \{ fable: 10, mythos: 10, opus: 5, sonnet: 2, haiku: 1 \};/);
});

test('A5 — leg-driver.mjs has no network or env surface at all', () => {
  const s = src('home/leg-driver.mjs');
  for (const bad of ['fetch(', 'node:http', 'node:https', 'process.env']) {
    assert.ok(!s.includes(bad), `leg-driver.mjs must not contain: ${bad}`);
  }
});

// ---- E4: the stale "waiting for CC adoption" framing is gone ----------------------------------
test('E4 — handover-facts.mjs no longer frames the warm-rewrite tax as pending CC adoption', () => {
  const s = src('home/handover-facts.mjs');
  assert.ok(!s.includes('The day CC adopts'), 'stale forward-looking framing still present');
  assert.ok(!/waiting for CC adoption/i.test(s), 'stale framing still present');
});

// ---- F2: all three state writers go through atomicWriteFile ------------------------------------
test('F2 — stats, agents cache, and both sidecar writes use atomicWriteFile', () => {
  const s = src('home/statusline.mjs');
  assert.match(s, /atomicWriteFile\(statsPath,/, 'per-session stats writer');
  assert.match(s, /atomicWriteFile\(cachePath,/, 'agents cache writer');
  const sidecarWrites = s.match(/atomicWriteFile\([^)]*statusline-last\.json[^)]*\)/g) || [];
  assert.equal(sidecarWrites.length, 2, 'project + home sidecar writes');
  // No state target may still use the bare primitive.
  for (const bad of [/writeFileSync\(statsPath/, /writeFileSync\(cachePath/, /writeFileSync\([^)\n]*statusline-last\.json/]) {
    assert.ok(!bad.test(s), `bare writeFileSync on a state file: ${bad}`);
  }
});

// ---- F3 (static half): sidecar write precedes the git cluster ----------------------------------
// statusline.mjs is a top-to-bottom script, so source order IS execution order. The behavioural
// half (a git shim observing the sidecar on disk) lives in write-order.test.mjs.
test('F3 — sidecar snapshot block sits above the git cluster', () => {
  const s = src('home/statusline.mjs');
  const sidecarAt = s.indexOf('=== Sidecar snapshot ===');
  const gitAt = s.indexOf('=== Cluster 6: git ===');
  assert.ok(sidecarAt > 0 && gitAt > 0, 'section markers present');
  assert.ok(sidecarAt < gitAt, 'sidecar write must precede the git subprocess cluster');
});

// ---- froz5-recal (2026-08-16 sprint 2): S1–S3 -------------------------------------------------
// The version gate, its interim comments and the pre-fit caveat prose have no runtime observable once
// gone; the harvest's zero-deps rule and home/'s closed import surface likewise.
const importSpecifiers = (s) => [...s.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

test('S1 — statusline.mjs: no version gate / interim marker left; SL_VERSION is 5.x', () => {
  const s = src('home/statusline.mjs');
  for (const bad of ['verGte', '[2, 1, 219]', 'FROZ5-STALE-CURVE interim', 'delete at the Phase 2']) {
    assert.ok(!s.includes(bad), `statusline.mjs must not contain: ${bad}`);
  }
  assert.match(s, /export const SL_VERSION = '5\.\d+\.\d+\.\d+';/);
});

test('S2 — handover-facts.mjs: corrected-direction prose in, pre-fit caveat and tier-keyed gloss out', () => {
  const s = src('home/handover-facts.mjs');
  for (const bad of ['pre-Opus-5 prompt cut', 'curve=stale', 'predates the Opus-5 prompt cut']) {
    assert.ok(!s.includes(bad), `handover-facts.mjs must not contain: ${bad}`);
  }
  assert.ok(!/sessionTier === 'sonnet'\s*\?/.test(s), 'the tier-keyed warm-rewrite gloss must be gone (generation-keyed now)');
  for (const good of ['era=warm-open (curve fit on post-2.1.209 cold-start sessions)', 'baseline=provisional', 'never had cache-preserving injection', 'opened on a warm shared prefix']) {
    assert.ok(s.includes(good), `handover-facts.mjs must contain: ${good}`);
  }
  // A5 still holds with the new leg-driver exports
  const ld = src('home/leg-driver.mjs');
  for (const bad of ['fetch(', 'node:http', 'node:https', 'process.env']) assert.ok(!ld.includes(bad), `leg-driver.mjs must not contain: ${bad}`);
  for (const exp of ['FRESH_N', 'FRESH_WINDOW', 'FRESH_WRITE_SHARE', 'median', 'writeShare', 'isWriteHeavyLeg', 'isColdStartLeg', 'pickFreshBaseline']) {
    assert.match(ld, new RegExp(`export (const|function) ${exp}\\b`), `leg-driver.mjs exports ${exp}`);
  }
});

// The harvest is private-repo tooling and does not ship in the public kit, so its half is guarded
// the way D4 guards the private docs below. The home/ half asserts in every checkout — those files
// are the kit's own surface, and a new import there is exactly what this row exists to catch.
test('S3 — import surface: the harvest imports only node: built-ins + ../../home/leg-driver.mjs; home/ imports nothing new', () => {
  if (existsSync(join(repo, 'tools', 'calibration', 'harvest-froz5.mjs'))) {
    const hv = importSpecifiers(src('tools/calibration/harvest-froz5.mjs'));
    assert.ok(hv.length >= 2, `harvest imports found: ${hv}`);
    for (const spec of hv) {
      assert.ok(spec.startsWith('node:') || spec === '../../home/leg-driver.mjs', `harvest-froz5.mjs imports ${spec}`);
    }
  }
  for (const f of ['home/statusline.mjs', 'home/leg-driver.mjs', 'home/handover-facts.mjs']) {
    for (const spec of importSpecifiers(src(f))) {
      assert.ok(spec.startsWith('node:') || /^\.\/[\w-]+\.mjs$/.test(spec), `${f} imports ${spec}`);
    }
  }
});

// ---- D4: calibration sample rows carry the session model ---------------------------------------
// Private-repo docs; skipped when absent so this suite stays runnable from a public checkout.
test('D4 — samples table header + interpret-statusline row template carry a model column', (t) => {
  const samples = join(repo, 'docs', 'froz5-calibration-samples.md');
  const command = join(repo, '.claude', 'commands', 'interpret-statusline.md');
  if (!existsSync(samples) || !existsSync(command)) {
    t.skip('private-repo docs not present in this checkout');
    return;
  }
  const header = readFileSync(samples, 'utf8').split('\n').find((l) => l.startsWith('| date |'));
  assert.ok(header, 'samples table header found');
  assert.match(header, /\| model \|/, 'samples header carries a model column');
  const tmpl = readFileSync(command, 'utf8');
  assert.match(tmpl, /\| date \| git \| model \|/, 'interpret-statusline row template carries model');
});
