import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// source-invariants — static checks pinned by the 2026-07-14 Claude-5 correctness sprint's
// acceptance rows (A5, E4, F2, F3-order, D4). They read source text, not behaviour: each one
// guards a property that has no runtime observable (a constants-not-config constraint, a deleted
// stale comment, which write primitive a call site uses, top-to-bottom execution order).

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const src = (p) => readFileSync(join(repo, ...p.split('/')), 'utf8');
// The public-kit marker. This file ships in the kit, and the kit has neither the exporter nor
// SPEC.md — so the exporter's absence says "this checkout is the public kit". A bare existsSync on a
// private doc cannot tell the kit from a deletion; this can (docs/260908-suite-skip-guards-spec.md §2).
const IN_PUBLIC_KIT = !existsSync(join(repo, 'tools', 'export-public.mjs'));

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

test('S1 — statusline.mjs: no version gate / interim marker left; SL_VERSION is 6.x', () => {
  const s = src('home/statusline.mjs');
  // Retired strings: each was pinned by an earlier sprint and must not come back. The froz5 family
  // joins the list with the 2026-08-21 removal (SL_VERSION 6.0.0.0).
  for (const bad of ['verGte', '[2, 1, 219]', 'FROZ5-STALE-CURVE interim', 'delete at the Phase 2',
    '(fresh)', 'BgFroz5', 'Froz5RGB']) {
    assert.ok(!s.includes(bad), `statusline.mjs must not contain: ${bad}`);
  }
  assert.match(s, /export const SL_VERSION = '6\.\d+\.\d+\.\d+';/);
});

test('S2 — handover-facts.mjs prose + the leg-driver export surface after the froz5 removal', () => {
  const s = src('home/handover-facts.mjs');
  for (const bad of ['pre-Opus-5 prompt cut', 'curve=stale', 'predates the Opus-5 prompt cut',
    // the four required froz5 prose strings the previous sprint pinned IN — all deleted by the removal
    'era=warm-open', 'baseline=provisional', 'opened on a warm shared prefix', 'typical at this depth']) {
    assert.ok(!s.includes(bad), `handover-facts.mjs must not contain: ${bad}`);
  }
  assert.ok(!/sessionTier === 'sonnet'\s*\?/.test(s), 'the tier-keyed warm-rewrite gloss must be gone (generation-keyed now)');
  for (const good of ['never had cache-preserving injection']) {
    assert.ok(s.includes(good), `handover-facts.mjs must contain: ${good}`);
  }
  // A5 still holds with the reduced leg-driver exports
  const ld = src('home/leg-driver.mjs');
  for (const bad of ['fetch(', 'node:http', 'node:https', 'process.env']) assert.ok(!ld.includes(bad), `leg-driver.mjs must not contain: ${bad}`);
  // Survivors. `median` stays — the forecast uses it. `isColdStartLeg` LEAVES this list because it
  // stops being EXPORTED (D5), not because it is gone: getDriver still calls it for the `opened
  // cold` opener label, and S2b below pins that it is still defined and still called.
  for (const exp of ['median', 'isSyntheticLeg', 'servingTierReport']) {
    assert.match(ld, new RegExp(`export (const|function) ${exp}\\b`), `leg-driver.mjs exports ${exp}`);
  }
  for (const gone of ['FRESH_N', 'FRESH_WINDOW', 'FRESH_WRITE_SHARE', 'writeShare', 'isWriteHeavyLeg', 'pickFreshBaseline', 'isColdStartLeg']) {
    assert.ok(!new RegExp(`export (const|function) ${gone}\\b`).test(ld), `leg-driver.mjs must not export ${gone}`);
  }
});

// S3's harvest half died with tools/calibration/ (froz5-removal, 2026-08-21). Its home/ half is
// independent of froz5 and stays: those files are the public kit's own surface, and a new import
// there is exactly what this row exists to catch.
test('S3 — import surface: home/ imports only node: built-ins and its own siblings', () => {
  // THE LIST IS HARD-CODED, so a new module is unswept until it is added here — which is why
  // `home/quota-ladder.mjs` joins it in the sprint that creates it. `home/quota-probe.mjs` is
  // deliberately NOT here: it is private and does not exist in a public-kit checkout, where this
  // file also runs. Its counterpart is `P11` in tests/quota-probe.test.mjs.
  for (const f of ['home/statusline.mjs', 'home/leg-driver.mjs', 'home/handover-facts.mjs', 'home/quota-ladder.mjs']) {
    for (const spec of importSpecifiers(src(f))) {
      assert.ok(spec.startsWith('node:') || /^\.\/[\w-]+\.mjs$/.test(spec), `${f} imports ${spec}`);
    }
  }
});

test('S5-ladder — home/quota-ladder.mjs is PURE: no clock, no environment, no file I/O', () => {
  // The ladder is what makes the probe's window objects provable offline, and that property rests on
  // both moments arriving as ARGUMENTS. The same rule MergeQuotaWindow already lives by: a module that
  // takes its own clock cannot be pinned by a test, and the eight drawn cells would then only be
  // checkable through a render.
  const s = src('home/quota-ladder.mjs');
  const code = s.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  for (const banned of ['Date.now', 'new Date', 'hrtime', 'nowEpoch', 'node:fs', 'node:os', 'node:child_process', 'process.env', 'readFileSync', 'writeFileSync']) {
    assert.ok(!code.includes(banned), `home/quota-ladder.mjs must not name ${banned} — both moments are parameters and it opens nothing`);
  }
  // Positive half, so "pure" cannot be satisfied by an empty file: the two functions the probe and
  // the status line both import are here and both take their moments.
  assert.match(s, /export function QuotaCells\(rl, winSec, now\)/, 'QuotaCells takes `now` as a parameter');
  assert.match(s, /export function QuotaWindow\(c, rl, observedAt, now\)/, 'QuotaWindow takes both moments as parameters');
});

test('S2b — isColdStartLeg survives un-exported and is still called by getDriver (D5)', () => {
  const ld = src('home/leg-driver.mjs');
  assert.match(ld, /function isColdStartLeg\b/, 'the function itself must survive');
  assert.ok(/isColdStartLeg\(/.test(ld.replace(/function isColdStartLeg\b/, '')), 'and must still have a caller inside leg-driver.mjs');
  assert.match(ld, /opened cold/, 'the opener label it backs is still rendered');
});

// ---- froz5 removal (2026-08-21, bsl6.0.0.0): the completeness + negative-prose guards ----------
// These are the cheap tests that prove REMOVED rather than display-gated off. S3's old harvest
// import-surface row died with tools/calibration/.

test('S4 — completeness guard: no froz5 / fresh-baseline identifier survives anywhere in home/*.mjs', () => {
  // `isColdStartLeg` is DELIBERATELY absent from this pattern — it survives as an internal function
  // (D5). Everything else in the apparatus is gone: the constants, the picker, its two helpers, the
  // sidecar keys and the rollup's opening-window fields.
  //
  // ONE PINNED EXCEPTION (spec §A9.1, 2026-08-22), and it is pinned POSITIVELY rather than by
  // loosening the pattern. `home/statusline.mjs` may name `openingLegs` in exactly one place: the
  // ROLLUP_COMPAT_KEYS declaration and the comment block above it, which hold the key open for the
  // deployed 5.x reader. Dropping `openingLeg` from PAT instead would let a future edit resurrect the
  // entire opening-window bank with no test going red — so the exception is asserted, not tolerated.
  const PAT = /froz5|Froz5|FRESH_N|FRESH_WINDOW|FRESH_WRITE_SHARE|pickFreshBaseline|isWriteHeavyLeg|writeShare|freshLeg|openingLeg|firstLegColdStart/;
  const FILES = ['statusline.mjs', 'leg-driver.mjs', 'handover-facts.mjs', '_sl-compat.mjs',
    'render-legspark.mjs', 'render-spikes.mjs', 'sanitize-name.mjs', 'sidecar-path.mjs'];

  const sl = src('home/statusline.mjs');

  // (1) The exception has EXACTLY the declared shape: one entry, named openingLegs, an empty array.
  const decl = /^\s*const ROLLUP_COMPAT_KEYS = \{ openingLegs: \[\] \};$/m;
  assert.match(sl, decl,
    'ROLLUP_COMPAT_KEYS must be exactly one entry, `openingLegs`, valued `[]` (spec §A9.1)');
  assert.equal((sl.match(/ROLLUP_COMPAT_KEYS =/g) || []).length, 1,
    'declared once — a second declaration would make the pinned shape meaningless');
  // ...and it is folded into the derived key set rather than special-cased at the write site.
  assert.match(sl, /\.\.\.Object\.keys\(ROLLUP_COMPAT_KEYS\)/,
    'the compat keys reach ROLLUP_KEYS by derivation, not by a hand-written key name');

  // (2) The exception is CONFINED. Strip the declaration and the contiguous comment block above it,
  // then run the unmodified pattern over what remains: statusline.mjs must be clean like every other
  // file. A stray `openingLegs` anywhere else in the file still fails.
  const lines = sl.split('\n');
  const declIdx = lines.findIndex((l) => decl.test(l));
  assert.ok(declIdx > 0, 'the compat declaration must be findable to bound the exception');
  let from = declIdx;
  while (from > 0 && /^\s*\/\//.test(lines[from - 1])) from--;
  const exempt = new Set();
  for (let i = from; i <= declIdx; i++) exempt.add(i + 1);

  for (const f of FILES) {
    const p = join(repo, 'home', f);
    // A COMPLETENESS GUARD THAT SKIPS A FILE IS NOT A COMPLETENESS GUARD. All eight are in
    // manifest.public.json, so they are in every checkout that exists — private repo and public kit
    // alike — and the only way this path is ever reached is a deletion. The `continue` that used to
    // sit here silently narrowed the sweep by one file per deletion and left the row green
    // (2026-09-09 suite-integrity sprint §4.2 site 5).
    assert.ok(existsSync(p),
      `home/${f} is missing — it ships in manifest.public.json, so its absence is a build gap, and letting the sweep skip it would shrink this completeness guard without anything going red`);
    const isEngine = f === 'statusline.mjs';
    const hits = readFileSync(p, 'utf8').split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([n, l]) => PAT.test(l) && !(isEngine && exempt.has(n)));
    assert.deepEqual(hits, [], `home/${f}: ${hits.length} surviving froz5 identifier line(s) — ${hits.slice(0, 5).map(([n, l]) => `:${n} ${l.trim().slice(0, 70)}`).join(' | ')}`);
  }

  // (3) The exemption covers `openingLegs` ONLY. The two other retired opening-window keys stay
  // forbidden outright, statusline.mjs included — the exempt block must not smuggle them back in.
  for (const k of ['firstLegColdStart', 'openingLegCw', 'pickFreshBaseline']) {
    assert.ok(!sl.includes(k), `home/statusline.mjs must not name ${k} anywhere, exempt block included`);
  }
});

test('S15 — the relay never invents WHERE the expensive legs are (spec §A9.2)', () => {
  // WHY THIS ROW EXISTS AND WHY IT IS HERE. Both files are prose read by a composer: they emit no
  // bytes, so no golden and no mechanics test can see them. The old text told the composer that a
  // recent median below the session mean means the fat legs "sit earlier in the session ... not a
  // trend" — false on 20 of 114 real sessions, and false *because* of the median this build chose:
  // on a full 8-leg window a lone fat leg INSIDE the window shifts the median at most one rank, to
  // the next ordinary leg's price rather than toward the spike's — shorter windows hold less firmly,
  // and two fat legs in a short window can put a fat leg's own size into the figure (see the
  // handover-facts.mjs comment). Same family as S13.
  // `home/commands/handover-check.md` ships in the public kit (manifest.public.json:19) and this test
  // file is exported too, so its half runs everywhere. `.claude/commands/interpret-statusline.md` is
  // private-repo only: it is asserted in the private repo, where its absence is a build gap, and not
  // read in the kit, which does not ship it. The gate is the KIT MARKER, not the file — a bare
  // `existsSync` on the relay could not tell the kit from a deletion, and the deletion is what this
  // row exists to catch (2026-09-09 suite-integrity sprint §4.2 site 1).
  const isPath = join(repo, '.claude', 'commands', 'interpret-statusline.md');
  const RELAYS = { 'home/commands/handover-check.md': src('home/commands/handover-check.md') };
  if (!IN_PUBLIC_KIT) {
    assert.ok(existsSync(isPath),
      '.claude/commands/interpret-statusline.md is missing — it is the SECOND relay §A9.2 rewrote, and the banned phrases below run over the union of both; in the private repo its absence is a build gap');
    RELAYS['.claude/commands/interpret-statusline.md'] = readFileSync(isPath, 'utf8');
  }

  // NEGATIVE — the union of the banned phrases runs over BOTH files, not one each. §A9.2 rewrote the
  // same error class in two places; a phrase migrating from one file to the other is the likely way
  // this comes back.
  const BANNED = ['earlier in the session', 'not a trend', 'the rate is picking up'];
  for (const [rel, text] of Object.entries(RELAYS)) {
    for (const bad of BANNED) {
      assert.ok(!text.includes(bad),
        `${rel} states where the expensive legs are, or denies a trend, from two summary figures: "${bad}"`);
    }
  }

  // POSITIVE — and this half matters more. A rewrite can invent a NEW false sentence that dodges
  // every banned phrase; it cannot dodge having to point at the thing that actually answers the
  // question. Each file must name its own two sources of truth.
  const hc = RELAYS['home/commands/handover-check.md'];
  const costBullet = hc.split('\n').find((l) => l.includes('**Cost**') && l.includes('COST_RECENT'));
  assert.ok(costBullet, 'the COST_RECENT bullet must exist');
  assert.ok(costBullet.includes('TRAJECTORY'),
    'the COST_RECENT bullet must name TRAJECTORY as where the DIRECTION comes from');
  assert.ok(/spikes panel/.test(costBullet),
    'the COST_RECENT bullet must name the spikes panel as where the LOCATION comes from');
  assert.ok(/does \*\*not\*\* tell you where those legs are/.test(costBullet),
    'and must say outright that the comparison does not locate the legs');

  const is = RELAYS['.claude/commands/interpret-statusline.md'];
  if (is) {
    // The Cost read specifically — `recent-leg median` also appears in the capture checklist near the
    // top of the file, which is not the sentence under guard.
    const chipLine = is.split('\n').find((l) => l.startsWith('- **Cost**'));
    assert.ok(chipLine && chipLine.includes('recent-leg median'), 'the Cost read must exist and name the chip');
    // TWO independent sources of truth for direction, which is the whole point of this row — the chip
    // alone cannot say which way the rate is moving. The second source is the per-leg strip, which the
    // Dossier IV re-layout renamed from "sparkline" to `trend` (spec §7.2); the assertion follows the
    // label, and the requirement that there be TWO of them is unchanged.
    assert.ok(/trajectory shape/.test(chipLine) && /\btrend\b/.test(chipLine),
      'the chip sentence must send the reader to the trajectory shape AND the trend strip for direction');
  }

  // ANTI-CONTRADICTION — the Cost bullet and the your-call bullet must carry the SAME rule. The
  // ticket's repro had the two giving opposite readings of the same eight legs on one sheet.
  assert.ok(/If TRAJECTORY says climbing, say climbing/.test(hc),
    'the Cost bullet must defer to TRAJECTORY on direction');
  assert.ok(/cost direction here MUST match TRAJECTORY/.test(hc),
    'and the your-call bullet must still carry the mirror-image rule');
});

test('S5 — negative prose guard: nothing claims spend is normal / expected / on-curve / overstated', () => {
  // The depth curve is gone, so every claim that rested on it must go with it. Comments included:
  // a comment saying the sheet grades spend against a curve misleads the next reader exactly as
  // much as an emitted string would.
  const BANNED = [
    'on curve', 'on-curve', 'above the curve', 'below the curve', 'depth curve', 'context curve',
    'typical at this depth', 'typical for', 'usually shows', 'normal for', 'normal cost',
    'a fresh leg', 'fresh leg', 'fresh baseline', 'the multiple',
    'overstate', 'overstates', 'overstated', 'residual', 'confidence=',
    'froz5', 'Froz5',
  ];
  // Scoped to the two files that made the claim. `overstate*` is NOT swept in statusline.mjs — a
  // surviving comment there is about the old compact-window overstating 1M headroom, unrelated to
  // cost. `understated` stays legal everywhere: the fast-mode and suspect-leg-pricing notes both
  // still say it, correctly.
  for (const rel of ['home/handover-facts.mjs', 'home/commands/handover-check.md']) {
    const lines = src(rel).split('\n');
    for (const bad of BANNED) {
      const hits = lines.map((l, i) => [i + 1, l])
        .filter(([, l]) => l.toLowerCase().includes(bad.toLowerCase()))
        // "understated"/"understates" legitimately contain no banned substring; guard the one
        // overlap explicitly so the ban cannot silently kill a surviving true statement.
        .filter(([, l]) => !(bad.startsWith('overstate') && /understate/i.test(l) && !/overstate/i.test(l)));
      assert.deepEqual(hits.map(([n, l]) => `:${n} ${l.trim().slice(0, 90)}`), [],
        `${rel} still says "${bad}"`);
    }
  }
});

// ---- AV-1 … AV-4: the "average" retirement guard (froz5-removal amendment, spec §A1b) ----------
//
// THE RULE: a median may not be called an average anywhere a reader can see it. The chip and
// COST_RECENT report the MEDIAN of the last min(8, N) per-leg dollars, so every surviving "recent
// average" is a lie in the display — and there were 14 of them across source, docs, the command
// files and the PUBLIC-DOC GENERATOR.
//
// WHY THE BAN IS NOT THE WORD "average". Five live locations use it correctly and a blanket ban would
// force them wrong: the legspark's `--avg N` trailing MOVING AVERAGE (home/render-legspark.mjs and
// its gloss in handover-check.md), the sparkline's buckets, which genuinely are means of $/leg
// (docs/status-line.md, docs/roadmap.md), and two lines of docs/status-line-redesign.md that describe
// the RETIRED design — history the spec explicitly forbids rewriting. So the ban is on the chip's
// retired NAMES, in two differently-scoped sets.

// Assembled from fragments on purpose: the sweep below includes tests/, so a whole literal written
// here would fail the very guard this file defines.
const AV3_PATTERNS = [
  'recent ' + 'average',
  'recent-' + 'average',
  'per-leg ' + 'average',
  'actually ' + 'averaged',
  'not ' + 'median',
  'MEAN, ' + 'not',
];

test('AV-1 — no emitted string in handover-facts.mjs calls the recent figure an average', () => {
  // Spec §A1b's explicit ask, and the cheapest possible pin of the LABEL to the STATISTIC.
  const s = src('home/handover-facts.mjs');
  assert.ok(!s.includes('legs ' + 'average'), 'the emitted COST_RECENT string must say `median`');
  // The positive half used to pin the literal fragment `' legs median '`. Dossier IV renamed the
  // status line's chip to `med<N>` and §6.4 puts this file's prose in the same sprint so the two
  // cannot disagree — so the surrounding wording moved, legitimately. What must not move is the
  // STATISTIC'S NAME appearing in the emitted string, which is the whole point of the AV family.
  assert.match(s, /'[^']*\bmedian\b[^']*'|median of the last/,
    'the emitted COST_RECENT string must still name the statistic `median`');
});

test('AV-2 — handover-facts.mjs contains no form of "averag" at all, comments included', () => {
  // This file takes a TOTAL ban with no carve-out: verified that nothing else in it used the word.
  // Comments count — a comment describing the recent figure as an average misleads the next reader
  // exactly as much as the emitted string would, and it is how a correct string gets "fixed" back.
  const hits = src('home/handover-facts.mjs').split('\n')
    .map((l, i) => [i + 1, l]).filter(([, l]) => /averag/i.test(l));
  assert.deepEqual(hits.map(([n, l]) => `:${n} ${l.trim().slice(0, 90)}`), []);
});

// THE LIVE SURFACE — the tree a reader or a future editor actually meets, walked once here for
// every row that sweeps it (AV-3, AV-QP). Excluded: superseded docs, the sprint machinery (plans /
// sprints / handovers / chain / inbox — working notes, not the product), the parity fixtures
// (committed goldens, blessed from the code) and build output.
const LIVE_ROOTS = ['home', 'docs', 'tests', 'tools', 'SPEC.md', 'CLAUDE.md', '.claude/commands', '.claude/skills'];
const LIVE_EXCLUDED = [
  /^docs[\\/]_superseded/, /^\.claude[\\/](plans|sprints)/, /^\.desk[\\/]handovers/, /^\.sprint-chain/,
  /^\.inbox/, /^tools[\\/]parity[\\/]fixtures/, /^build/, /^node_modules/,
];
function liveSurfaceFiles(roots = LIVE_ROOTS) {
  const files = [];
  const walk = (rel) => {
    if (LIVE_EXCLUDED.some((r) => r.test(rel))) return;
    const abs = join(repo, rel);
    // skip-guards: a tree walk over ROOTS that legitimately differ between the kit and the private repo (SPEC.md, .claude/) — each caller's vacuity guard names a file that must be in every checkout, so a broken walk is caught there and not by this line.
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) { for (const n of readdirSync(abs)) walk(join(rel, n)); return; }
    files.push(rel);
  };
  for (const r of roots) walk(r);
  return files;
}

test('AV-3 — the chip\'s retired names appear nowhere on the live surface', () => {
  const files = liveSurfaceFiles();
  // Vacuity guard. NOT a file count: this row ships in the public kit, whose tree is a fraction of
  // the private one (33 files against ~190), so a count floor calibrated here goes red there. Name
  // the two files that must be in EVERY checkout instead.
  for (const must of ['home/statusline.mjs', 'home/handover-facts.mjs']) {
    assert.ok(files.some((f) => f.replace(/\\/g, '/') === must), `the walk missed ${must} — the sweep is not running`);
  }
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(repo, f), 'utf8'); } catch { continue; }
    text.split('\n').forEach((l, i) => {
      for (const p of AV3_PATTERNS) {
        if (l.toLowerCase().includes(p.toLowerCase())) { hits.push(`${f}:${i + 1} [${p}] ${l.trim().slice(0, 80)}`); break; }
      }
    });
  }
  assert.deepEqual(hits, [], `the chip is a median; these lines still call it an average:\n  ${hits.join('\n  ')}`);
});

// ---- AV-QP (2026-09-09): the retired quota-probe LAUNCH mechanism leaves no trace ---------------
// The probe used to start a bare `claude` and wait for its status line to write the quota file. That
// mechanism is deleted: there is no launched session, no pid file, no orphan sweep, no launcher rung.
// This row is what keeps its vocabulary from surviving in prose or in a test, which is how a reader
// ends up implementing against a mechanism that does not run (acceptance example QH-16).
//
// ASSEMBLED FROM FRAGMENTS, like AV3_PATTERNS, because the sweep includes tests/ — a whole literal
// written here would fail the guard this row defines.
//
// `moved`, `timeout` and `died` are DELIBERATELY ABSENT from the pattern. They are ordinary English
// words and would fire on unrelated prose, which is how a sweep gets loosened until it proves
// nothing. The outcome vocabulary is closed by the probe's own suite instead.
const AVQP_NAMES = [
  'Get-CCQP' + 'KillOrder', 'Select-CCQP' + 'Orphans', 'Select-CCQP' + 'Cycle',
  'Get-CCQP' + 'LaunchCommand', 'Write-CCQP' + 'Log', 'Format-CCQP' + 'LogLine', 'CCQP' + '_LAUNCHER',
  'home-' + 'fresh', 'orphans-' + 'swept',
];
// The retired FILE names are swept with one narrow exemption: a line that PRUNES or MIGRATES a dead
// file has to be able to name it (install.mjs's RETIRED_LIVE entries, the harness's legacy-drift task
// action, the installer row that seeds a home with residue). The exemption is a marker on the line
// itself rather than a file allow-list, so it cannot quietly grow into "tests may say anything".
// ANCHORED, and the reason is the defect SM1 exists for one level up: a needle for the retired
// script's name is a SUBSTRING test, and the LIVE setup script — named all over the docs and the
// harness — ends with that same name. A bare needle fires on every mention of a file that is very
// much still in service, and it was doing exactly that. The lookbehind requires the retired name to
// start a path segment, so a `setup-` prefix no longer satisfies it.
const AVQP_FILES = [
  new RegExp('(?<![\\w-])quota-probe\\' + '.ps1'),
  new RegExp('(?<![\\w-])quota-probe\\' + '.pid'),
];
const AVQP_PRUNE_MARKERS = [/RETIRED_LIVE/, /legacy/i, /retired/i, /prune/i, /C:\\old/];

// THE SCOPE IS THE LIVING SURFACE, AND THE DATED ARTIFACTS ARE NOT PART OF IT. `docs/YYMMDD-*.md`
// files are point-in-time records — specs and test plans, including this sprint's own, which name the
// retired script precisely because they are the documents that RETIRE it. The project's rule is that
// a record keeps its own claim and a living doc carries the current one; `docs/_superseded/` is the
// same category one step later. So the sweep runs over the docs a reader consults for CURRENT
// behaviour (fleet-tray.md, status-line.md, machine-onboarding.md, cc-launcher.md, SPEC.md,
// CLAUDE.md), the shipped code, the suites and the harness.
const AVQP_EXCLUDED = [/^docs[\\/]\d{6}-/];

test('AV-QP — the retired launch mechanism\'s names appear nowhere on the live surface', { skip: IN_PUBLIC_KIT ? 'public kit checkout: the probe and the fleet tray are private' : false }, () => {
  const files = liveSurfaceFiles().filter((f) => !AVQP_EXCLUDED.some((r) => r.test(f)));
  for (const must of ['home/statusline.mjs', 'tools/fleet-tray/test-fleet-tray.ps1']) {
    assert.ok(files.some((f) => f.replace(/\\/g, '/') === must), `the walk missed ${must} — the sweep is not running`);
  }
  const hits = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(repo, f), 'utf8'); } catch { continue; }
    text.split('\n').forEach((l, i) => {
      for (const p of AVQP_NAMES) {
        if (l.includes(p)) { hits.push(`${f}:${i + 1} [${p}] ${l.trim().slice(0, 80)}`); return; }
      }
      for (const p of AVQP_FILES) {
        if (!p.test(l)) continue;
        if (AVQP_PRUNE_MARKERS.some((m) => m.test(l))) return;   // a line that removes or migrates it
        hits.push(`${f}:${i + 1} [${p.source}] ${l.trim().slice(0, 80)}`);
        return;
      }
    });
  }
  assert.deepEqual(hits, [], `the launch probe is gone; these lines still describe it:\n  ${hits.join('\n  ')}`);
});

test('AV-4 — the PUBLIC-DOC GENERATOR, and the documents it generates, name the median', () => {
  // THE ROW THAT EARNS ITS KEEP. The other three read source files a developer is already editing.
  // This one reads the GENERATOR and its OUTPUT — the failure it exists to catch is
  // `docs/status-line.md` corrected while the public kit still calls the chip an average, because
  // the public docs are generated and editing docs/ does not touch them.
  //
  // This row runs in two different trees and checks the same property from each end:
  //   • the private repo owns the generator, plus build/public/* once an export has happened;
  //   • the exported kit has no generator — but ITS OWN README.md and docs/status-line.md ARE the
  //     generated documents, so the kit's CI guards its own prose on 3 OS x 3 Node.
  const genPath = join(repo, 'tools', 'export-public.mjs');
  const targets = [];
  if (existsSync(genPath)) {
    targets.push(['tools/export-public.mjs', readFileSync(genPath, 'utf8')]);
    for (const rel of ['build/public/README.md', 'build/public/docs/status-line.md']) {
      const p = join(repo, ...rel.split('/'));
      // skip-guards: BUILD OUTPUT, not a repo artifact — build/ is gitignored and absent on a fresh clone, so its absence says "no export has been run here", never "a file was deleted".
      if (existsSync(p)) targets.push([rel, readFileSync(p, 'utf8')]);
    }
  } else {
    for (const rel of ['README.md', 'docs/status-line.md']) {
      const p = join(repo, ...rel.split('/'));
      // skip-guards: the kit branch — these are the kit's OWN generated documents, guarded by the kit's own CI on 3 OS x 3 Node; the private repo reaches the branch above instead.
      if (existsSync(p)) targets.push([rel, readFileSync(p, 'utf8')]);
    }
  }
  assert.ok(targets.length >= 1, 'neither the generator nor a generated document was found');
  for (const [name, text] of targets) {
    for (const p of AV3_PATTERNS) {
      assert.ok(!text.toLowerCase().includes(p.toLowerCase()), `${name} still calls the chip an average: "${p}"`);
    }
    assert.match(text, /recent-leg median/, `${name} must name the statistic in the term of art`);
  }
});

// ---- Dossier IV (2026-08-22, bsl6.1.0.0): the source-only half of the re-layout -----------------
// Each row here guards something with no runtime observable: a helper whose last caller went away, a
// string that must be unreachable rather than merely unreached, a version, a doc that would otherwise
// lie. The rendered half lives in tests/dossier-layout.test.mjs.

// Negative source scans below run on CODE ONLY. A comment that names a retired string is not a
// regression — it is usually the developer documenting the invariant, which is exactly what
// statusline.mjs now does for SGR-2, for `fast off`/`think on`, and for the deleted cold segments.
// Scanning raw text made all three of those read as failures. Strips block comments and line
// comments; a `//` inside a string literal would be over-stripped, which can only LOSE coverage on
// that line, never invent a pass — and none of the needles here can hide behind one.
const codeOnly = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

test('D4-1 — SGR-2 is fully retired: there is no second gray anywhere in the engine', () => {
  // Spec §5, and §10.2 asks QA to pin it. "There is no second gray" is literal: chrome collapses to
  // 256-colour 240, so the dim SGR-2 sequence must not survive ANYWHERE — including inside
  // ColorCost's under-$1 rung, which is the one place it would plausibly be left behind.
  const s = codeOnly(src('home/statusline.mjs'));
  const dim = [...s.matchAll(/\\x1b\[2m|\$\{ESC\}\[2m|\x1b\[2m/g)];
  assert.deepEqual(dim.map((m) => m[0]), [],
    `home/statusline.mjs still emits SGR-2 (${dim.length} occurrence(s)) — every gray is 240 now (spec §5)`);
  // The helper itself, and the second gray it produced, are gone by name.
  assert.ok(!/^const Dim = /m.test(s), 'the Dim helper must be deleted, not just unused');
  assert.ok(!/^const DimWhite = /m.test(s), 'DimWhite was the second gray — deleted');
  assert.ok(!/^const DIM_SEP = /m.test(s), 'DIM_SEP went with the ` | ` separators');
  // And no 250 colour code sneaks in as a near-miss gray (spec §10.2).
  assert.ok(!/38;5;250\b/.test(s) && !/\[250m/.test(s),
    'a 250 colour code is a second gray by another route (spec §10.2)');
});

test('D4-2 — the deleted display elements are removed from the source, not display-gated off', () => {
  // Paired with dossier-layout.test.mjs's absence sweep over the goldens. That sweep proves the
  // strings do not RENDER on this corpus; this one proves they cannot render at all.
  const s = codeOnly(src('home/statusline.mjs'));
  const GONE = [
    ["' /handover-check'", 'the advert text'],
    ['⚑', 'the advert glyph'],
    ['BgFill', 'the % fill chip renderer'],
    ['BAND_GREEN', 'the fill-chip band constants'],
    ['BAND_YELLOW', 'the fill-chip band constants'],
    ['BAND_ORANGE', 'the fill-chip band constants'],
    ['BAND_RED', 'the fill-chip band constants'],
    ["'[old] '", 'the sparkline old anchor'],
    ["' [new]'", 'the sparkline new anchor'],
    ['$/leg', 'the sparkline caption'],
    ["'x med'", 'the spotlight median multiple'],
    ['legs ago', 'the recency tag'],
    ["'just paid'", 'the recency tag'],
    ['Σctx', 'the old fleet label — `Σ` now'],
    ["'·max '", 'the fleet median/max parenthetical'],
    ["'to-compact '", 'the old wall label'],
  ];
  for (const [needle, what] of GONE) {
    assert.ok(!s.includes(needle), `home/statusline.mjs still contains ${needle} — ${what} (spec §9)`);
  }
  // The retrospective cold tax percentage and the cold leg count/share.
  assert.ok(!/taxPct/.test(s), 'the cold tax PERCENTAGE is a Florian deletion (spec §7.7)');
  assert.ok(!/legPct/.test(s), 'the cold legs count/share is a Florian deletion (spec §7.7)');
});

test('D4-3 — `fast off` and `think on` are unreachable by construction', () => {
  // Not "absent from the goldens" — absent from the code. The old renderer emitted both whenever the
  // payload carried the key at all, so a surviving else-branch would put them back on screen for the
  // 12 fixtures that set fast_mode: false.
  const s = codeOnly(src('home/statusline.mjs'));
  // Each flag is ASSEMBLED from a gray unit plus a coloured value, so neither `fast on` nor `fast off`
  // ever appears as a contiguous literal — which makes a substring ban on the phrase worthless. What
  // is worth pinning is that each unit has exactly ONE call site, of exactly one shape. One call site
  // of a known shape is what makes the opposite value unreachable.
  const fastSites = [...s.matchAll(/'fast '/g)];
  const thinkSites = [...s.matchAll(/'think '/g)];
  assert.equal(fastSites.length, 1, `the fast flag must have exactly one call site (found ${fastSites.length})`);
  assert.equal(thinkSites.length, 1, `the think flag must have exactly one call site (found ${thinkSites.length})`);
  assert.match(s, /\('fast '\) \+ Magenta\('on'\)/,
    'the single fast call site emits `on` in magenta and nothing else — spec §7.8 chip 1');
  assert.match(s, /\('think '\) \+ BrightCyan\('off'\)/,
    'the single think call site emits `off` in bright cyan and nothing else — spec §7.8 chip 2');
  // And the old colon forms, which rendered BOTH values, are gone outright.
  assert.ok(!/fast:off|fast:on/.test(s), 'the `fast:<v>` form rendered both values — gone');
  assert.ok(!/think:on|think:off/.test(s), 'the `think:<v>` form rendered both values — gone');
  // The rendered half — that `fast on` / `think off` appear exactly on their own conditions across
  // every fixture, and their opposites nowhere — is dossier-layout.test.mjs items 17 and 18.
});

test('D4-4 — the driver verb list has ONE home, and it is the file that owns the strings', () => {
  // Spec §7.9. Colouring the leading verb needs to know the verb phrases; re-spelling them in
  // statusline.mjs is what would let the two drift silently the next time getDriver gains a form.
  const ld = src('home/leg-driver.mjs');
  assert.match(ld, /export const DRIVER_VERBS = \[/, 'leg-driver.mjs exports DRIVER_VERBS');
  const sl = src('home/statusline.mjs');
  assert.match(sl, /DRIVER_VERBS/, 'statusline.mjs consumes it');
  // getDriver's contract is unchanged — render-spikes.mjs reads the same string.
  assert.match(ld, /export function getDriver|export const getDriver/, 'getDriver stays exported');
  // The verb phrases themselves must not be re-spelled in the engine.
  for (const verb of ['re-cached', 'compacted', 'opened cold', 'large fresh input']) {
    assert.ok(!sl.includes(`'${verb}`) && !sl.includes(`"${verb}`),
      `home/statusline.mjs re-spells the driver verb "${verb}" — it must come from DRIVER_VERBS`);
  }
});

test('D4-5 — SL_VERSION is 6.1.11 (PATCH: the quota file gains a second writer, a header probe with no session)', () => {
  const s = src('home/statusline.mjs');
  // The BUILD digit is auto-ticked by install.mjs on deploy, so pin X.Y.Z and let B float.
  const m = /export const SL_VERSION = '(\d+)\.(\d+)\.(\d+)\.(\d+)';/.exec(s);
  assert.ok(m, 'SL_VERSION must be a four-part version');
  assert.equal(`${m[1]}.${m[2]}.${m[3]}`, '6.1.11',
    'X.Y.Z is 6.1.11: one behaviour-affecting change a deployment note can name — `<config-home>/statusline-quota.json` now has a SECOND WRITER, a header probe with no session (`home/quota-probe.mjs`), which reads the rate-limit response headers of its own minimal API request every quarter hour and writes them through the same merge; the cluster changes with it, since `statusline.mjs` loses the quota ladder to the new `home/quota-ladder.mjs` and `_sl-compat.mjs` gains `FmtDurShort`. Not X: no displayed figure changes meaning, no threshold moves, the rendered line is byte-identical (npm run parity, no golden blessed) and the calibration samples stay comparable. Not Y: no new cluster or line appears on the status line — the new module is a MOVE, not a display. Where the call is close the project\'s rule is to prefer Z. 6.1.10.x is the deployed build and cannot be reused; B resets to 0 and install.mjs ticks it from there, so a trailing `.1` appearing later is an ordinary re-deploy tick, not a finding');
});

test('D4-6 — the docs describe the grid instead of the retired stack', () => {
  // Project rule: fix rot at its source. Both files are in the spec's scope (§12) and both would
  // otherwise describe a layout that no longer exists.
  const doc = src('docs/status-line.md');
  assert.ok(!/Seven clusters, top to bottom/.test(doc),
    'docs/status-line.md still opens with the retired seven-cluster stack');
  for (const stale of ['⚑ /handover-check', '[old] ', ' [new]', 'tax 7%', 'legs 2/60']) {
    assert.ok(!doc.includes(stale), `docs/status-line.md still documents a deleted element: ${stale}`);
  }
  assert.match(doc, /two-column|dossier/i, 'and it must actually describe the new layout');

  // interpret-statusline.md has its own row below (D4-7) — it needs more than a three-string check.
});

test('D4-8 — docs/fleet-tray.md carries BOTH halves of what `as of` can and cannot tell you', { skip: IN_PUBLIC_KIT ? 'public kit checkout: the fleet tray and its documentation do not ship' : false }, () => {
  // WHY A DOC SENTENCE IS PINNED BY A TEST, AND WHY THIS ONE.
  //
  // Spec §4.3 case 3 is the one place the quota block can show a fresh date on a materially stale
  // number: the OTHER MACHINE is burning quota, so every reading taken here is stale-low, every merge
  // is a tie, and idle renders keep the date moving while the window is still open — the clamp never
  // fires, because the window has not ended. Nothing on this panel can see that, and nothing on it
  // ever could: the other machine is invisible from here.
  //
  // It is NOT an acceptance example, and the reason is the form rule rather than convenience. An
  // acceptance example names a concrete scenario with an observable outcome; this is a property of
  // the whole block, and the only scenario that exercises it has an outcome nobody would want to
  // pin — the panel showing a number that is too low beside a date that looks fresh, which is correct
  // behaviour under a limit rather than a desirable rendering. Written as an example it would be
  // unfailable.
  //
  // So it lives in the documentation, and this row is what stops it being edited away. TWO
  // ASSERTIONS, EACH NAMING WHICH HALF IT PROTECTS, because the failure mode is a later trim that
  // keeps the reassuring clause and drops the limit — leaving a doc that says what the field means
  // and no longer says what it cannot mean.
  //
  // PRIVATE-REPO ONLY, AND THE GUARD KEYS ON THE CHECKOUT, NOT ON EITHER FILE. The fleet tray is
  // private by construction, so the exported public kit ships this suite WITHOUT `docs/fleet-tray.md`
  // — a row that simply read the file turns the kit's own suite red (its CI is the only CI this
  // project has). It used to key on the TOOL, which reads as "no tray, no doc" and is silent about
  // the case that matters: a deleted tray in the private repo left the row green and unrun. Where
  // this is the private repo, the tray and its documentation must BOTH be present, and a deleted tray
  // is a build gap rather than a reason to stop checking (2026-09-09 suite-integrity sprint §4.2
  // site 2, §4.4).
  const docPath = join(repo, 'docs', 'fleet-tray.md');
  assert.ok(existsSync(join(repo, 'home', 'fleet-tray.ps1')),
    'home/fleet-tray.ps1 is missing — the tray is what this documentation documents; in the private repo its absence is a build gap');
  assert.ok(existsSync(docPath),
    'docs/fleet-tray.md is missing — it is the only surface that can carry the limit of `as of`; in the private repo its absence is a build gap');
  const doc = readFileSync(docPath, 'utf8');

  // HALF 1 — WHAT IT DOES SAY, RE-PINNED 2026-09-09 TO THE OBSERVED WORDING. The stamp is no longer
  // the moment a session REPORTED the reading; it is the moment the reading was OBSERVED — the API
  // call, in this config home, that produced it. "in this config home" is the load-bearing phrase in
  // both wordings, not decoration: it is what scopes the claim to one machine's own sessions.
  assert.match(doc, /as of[^.]{0,40}how long ago this reading was \*?observed\*?[^.]{0,80}in this config home/i,
    'docs/fleet-tray.md must say that `as of` is how long ago this reading was OBSERVED — the API call, IN THIS CONFIG HOME, that produced it '
    + '(quota-semantics spec §2.5) — the scope of the claim is the half that makes it true');

  // HALF 2 — WHAT IT DOES NOT SAY: it is not a measure of how current the subscription's true
  // consumption is. This is the half a trim removes first, because it is the uncomfortable one.
  assert.match(doc, /not a measure of how current[^.]{0,80}true consumption/i,
    'docs/fleet-tray.md must also say that `as of` is NOT a measure of how current the subscription’s true consumption is (spec §4.3) '
    + '— the limit is the half that stops the first half being read as a freshness guarantee');
});

test('D4-9 — docs/fleet-tray.md says the age can exceed the probe\'s interval, and why', { skip: IN_PUBLIC_KIT ? 'public kit checkout: the fleet tray and its documentation do not ship' : false }, () => {
  // WHY THIS SENTENCE IS PINNED. It is the answer to a ticket that was filed once already
  // (`.inbox/2026-09-09-the-probe-bounds-the-age-of-the-newest-reading-not-the-displayed-one.md`):
  // the refresh probe runs every quarter hour, so an `as of 41m` on a five-hour row looks like a dead
  // probe. It is not — within one window the panel keeps the HIGHEST reading, because consumption
  // only rises, and dates it by when THAT reading was observed. A later observation reporting a
  // lower figure does not replace it, so the row can legitimately age past the probe's interval.
  //
  // An unguarded doc sentence rots, and this one exists precisely so the question is not re-filed.
  // Same shape and same reason as D4-8 above, which is the precedent for pinning exactly this kind
  // of sentence.
  const docPath = join(repo, 'docs', 'fleet-tray.md');
  assert.ok(existsSync(docPath),
    'docs/fleet-tray.md is missing — in the private repo its absence is a build gap');
  const doc = readFileSync(docPath, 'utf8');

  assert.match(doc, /age can be older than[^.]{0,40}probe'?s interval/i,
    'docs/fleet-tray.md must say the age can be OLDER than the refresh probe\'s interval (quota-semantics spec §2.5) — without it, an ageing row reads as a dead probe');
  assert.match(doc, /keeps the \*?highest\*? reading/i,
    'and it must say WHY: the panel keeps the HIGHEST reading it has seen within one window, because consumption only rises');
  assert.match(doc, /quota-probe\.log/,
    'and it must send the reader to `<home>\\quota-probe.log` for probe health — the whole point of the bullet is that the date on the row is not that signal');
});

test('D4-7 — interpret-statusline.md reads the labels that actually ship', { skip: IN_PUBLIC_KIT ? 'public kit checkout: the private docs do not ship' : false }, () => {
  // WHY THIS ROW IS BIGGER THAN A SPOT CHECK. This file tells a reader (often a cheap model) which
  // fields to pull off a screenshot, and it then writes ONE ROW PER SCREENSHOT into
  // docs/statusline-calibration-samples.md. A misread here does not just confuse someone — it puts a
  // wrong number into the dataset that drives the $/leg dollar-gate and quality-band recalibration,
  // where nothing downstream can tell a mis-parsed row from a real one.
  //
  // Its previous guard tested exactly three strings, which is why it stayed green through the Dossier
  // IV re-layout while the file still sent readers hunting for `last 8`, for the window on row 1, and
  // for cold strings the line can no longer emit.
  // Private-repo only, gated on the KIT MARKER and not on the file — the D4 shape exactly. Gating on
  // the document meant a deletion silently retired the row, which is the one failure it exists to
  // catch: this file is what tells a cheap model which fields to pull off a screenshot, and a wrong
  // number here reaches the calibration dataset with nothing downstream able to tell it from a real
  // one (2026-09-09 suite-integrity sprint §4.2 site 3).
  const isPath = join(repo, '.claude', 'commands', 'interpret-statusline.md');
  assert.ok(existsSync(isPath),
    '.claude/commands/interpret-statusline.md is missing — it is what /interpret-statusline reads to parse a screenshot into a calibration row; in the private repo its absence is a build gap');
  const is = readFileSync(isPath, 'utf8');

  // POSITIVE — the vocabulary that actually ships. A rewrite can dodge any blacklist; it cannot dodge
  // having to name the fields a reader must find on screen.
  const MUST = [
    [/two-column|dossier/i, 'describe the two-column grid'],
    [/`med<N>`|`med\d`/, 'name the recent-median chip as `med<N>`, its shipped label'],
    [/`trend`|trend strip/, 'name the `trend` strip — the per-leg cost cells are not a "sparkline" any more'],
    [/read here on row 2|window[^.]{0,80}\brow 2\b/, 'say the context WINDOW is read on row 2, not off the model row'],
    [/`wall`/, 'name the `wall` field — the headroom label'],
  ];
  for (const [re, what] of MUST) {
    assert.match(is, re, `interpret-statusline.md must ${what}`);
  }

  // POSITIVE — it must WARN about the two cold elements the line no longer emits, because a reader
  // who goes looking for them either invents them or reports the screenshot as broken.
  assert.match(is, /No `❆` marker|no `❆` marker/i,
    'interpret-statusline.md must warn that no ❆ marker appears on the fixed rows any more');
  assert.match(is, /no "N legs ago" recency tag|there is no "N legs ago"/i,
    'interpret-statusline.md must warn that the "N legs ago" recency tag is gone');

  // POSITIVE — and it must keep explaining that the CALIBRATION TABLE's column names are historical.
  // `to-compact` and `last8$` stay as column headers on purpose so old rows remain comparable, and the
  // instruction to record the `wall` / `med<N>` figures under them is the only thing standing between
  // that decision and a silently mixed dataset. This is why the two names are NOT banned below.
  assert.match(is, /predate the Dossier IV re-layout|keep their names/,
    'interpret-statusline.md must keep the caveat that the calibration columns retain their historical names');

  // NEGATIVE — retired reading instructions. Every pattern here was verified clean against the live
  // file, and `to-compact` / `last8$` are deliberately absent from this list per the caveat above.
  const RETIRED = [
    [/at the end of line 1/, 'the model row no longer ends with the version badge'],
    [/\bgit cluster\b/, 'the git facts are the `repo` cluster on row 5 right'],
    [/`legs:`|\blegs:\s/, 'the sparkline label `legs:` is deleted'],
    [/\blast 8\b/, 'the chip is `med<N>`; `last 8` was its retired label'],
    [/`last N`/, 'same — the chip label is `med<N>`'],
    [/\bsparkline/i, 'the per-leg strip is the `trend` cluster'],
    [/⚑/, 'the /handover-check advert flag is deleted'],
    [/Tax \d+%|`Tax `/, 'the cold tax PERCENTAGE is deleted; only `cold $<x>` survives'],
    [/legs \d+\/\d+/, 'the cold `legs C/T (P%)` count is deleted'],
    [/❆ Tax/, 'the ❆ marker left the fixed rows'],
    [/x med\b/, 'the spotlight `N.Nx med` multiple is deleted'],
  ];
  for (const [re, why] of RETIRED) {
    assert.ok(!re.test(is), `interpret-statusline.md still sends the reader after a retired element ${re} — ${why}`);
  }
});

// ---- Dossier IV (2026-08-22, bsl6.1.0.0): 0b — the engine's own copy of the median -------------
//
// The BUILD PRECONDITION's third part. `home/statusline.mjs` has its OWN `Median` (not the exported
// `median` in leg-driver.mjs) with three call sites; the re-layout deletes only the agents-line one,
// so the function survives with two callers and keeps mattering. It is not exported, so no unit test
// can import it — the behavioural guard lives in tests/agent-ctx-median.test.mjs against the exported
// twin, and THIS row pins the engine copy's even-count branch by source shape.
//
// This is the weakest assertion in the sprint's test plan and it is written down as such: it would
// catch the two implementations diverging, and it would not catch a subtler rewrite that keeps the
// shape. Exporting `Median` to make it testable was rejected — the spec allows exactly one new export
// in this sprint (DRIVER_VERBS in leg-driver.mjs) and widening a module surface for a test is a worse
// trade than naming the limit.
test('0b — statusline.mjs\'s own Median averages the middle two on an even count', () => {
  const s = src('home/statusline.mjs');
  const at = s.indexOf('function Median(arr) {');
  assert.ok(at > 0, 'the engine keeps its own Median (two surviving call sites after the re-layout)');
  // The function body, bounded by the next top-level close-brace line.
  const body = s.slice(at, s.indexOf('\n}', at) + 2);
  assert.match(body, /\(vals\[mid - 1\] \+ vals\[mid\]\) \/ 2\.0/,
    'the even-count branch must average the two middle values — returning vals[mid] alone is the 2026-06-24 bug');
  assert.match(body, /n % 2 === 1 \? vals\[mid\]|if \(n % 2 === 1\) return vals\[mid\]/,
    'and the odd-count branch must still return the middle member');
});

// ---- sprint 3 (2026-08-29, spec §D5): the spikes fallback is DELETED, not gated (F7 — row NB-2) --
test('NB-2 — render-spikes.mjs never derives a $ basis by dividing session cost by a unit sum', () => {
  // The deleted fallback was `sessionCost / sumUnits` — written for pre-bsl4.0 snapshots that LACKED
  // the `base` key, and firing on the published-null state instead (resume, no new leg), where it
  // priced every leg at a fabricated rate (~1.4% of list on the ticket's live case). F7 ruled
  // delete, not gate: no schema-6 writer emits a snapshot without the key, so the absent-key case
  // cannot reach this line. The absence is pinned at the source so no rewrite can quietly divide the
  // session cost by a unit aggregate again. (`agUsd / sessionCost` — division BY the cost — is a
  // percentage and stays legal; the ban is on cost as the NUMERATOR over units.)
  const s = codeOnly(src('home/render-spikes.mjs'));
  const hits = s.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /(?:sessionCost|costUsd)\s*\/\s*\w*[uU]nits\w*/.test(l));
  assert.deepEqual(hits.map(([n, l]) => `:${n} ${l.trim().slice(0, 90)}`), [],
    'render-spikes.mjs re-grew a cost/units fallback');
  // The positive half — the exact replacement the spec pins: the snapshot's own value, or null.
  assert.match(s, /const base = snap\.base != null \? Number\(snap\.base\) : null;/,
    'base is snap.base or null, nothing else (spec §D5 exact change)');
});

// ---- D4: calibration sample rows carry the session model ---------------------------------------
// Private-repo docs; skipped in the public kit, which ships neither file (keyed on IN_PUBLIC_KIT, not
// on the docs); asserted in the private repo, where a missing file means /interpret-statusline has
// nowhere to write. The era-v5 file was archived to docs/_superseded/ by the froz5 removal and a
// fresh live samples file took its place (D4) — /interpret-statusline appends one row per screenshot,
// so it needs a live target.
test('D4 — samples table header + interpret-statusline row template carry a model column', { skip: IN_PUBLIC_KIT ? 'public kit checkout: the private docs do not ship' : false }, () => {
  const samples = join(repo, 'docs', 'statusline-calibration-samples.md');
  const command = join(repo, '.claude', 'commands', 'interpret-statusline.md');
  assert.ok(existsSync(samples),
    'docs/statusline-calibration-samples.md is missing — it is where /interpret-statusline appends one row per screenshot; in the private repo its absence is a build gap');
  assert.ok(existsSync(command),
    '.claude/commands/interpret-statusline.md is missing — it is what resolves the samples file by name; in the private repo its absence is a build gap');
  const header = readFileSync(samples, 'utf8').split('\n').find((l) => l.startsWith('| date |'));
  assert.ok(header, 'samples table header found');
  assert.match(header, /\| model \|/, 'samples header carries a model column');
  const tmpl = readFileSync(command, 'utf8');
  assert.match(tmpl, /\| date \| git \| model \|/, 'interpret-statusline row template carries model');
});

// ---- N11 (sprint 4 2026-08-29, AE-6): the lone-fat-leg claim is window-scoped wherever it appears --
// A median's resistance to one fat leg is a per-window-size property, not a law: at the full
// window of eight the shift is one rank (the gap between two ordinary legs); shorter windows are
// less protected; with two fat legs in a short window the reported figure can be a fat leg's own
// price. This row keeps the absolute from creeping back into either chip test file as an unscoped
// comment or title. Banned needles are assembled by concatenation and positive needles use \s+
// escapes, so this row's own source satisfies none of them — the pins bite on the S15 rationale.
test('N11 — the lone-fat-leg absolutes are window-scoped in the two chip test files', () => {
  // This file ships in the public kit; last8-chip.test.mjs does not — so it is asserted in the
  // private repo, where its absence is a build gap, and not read in the kit. Gated on the KIT
  // MARKER rather than on the file: keyed on the file, a deletion made this sweep cover one file
  // instead of two and nothing went red (2026-09-09 suite-integrity sprint §4.2 site 4).
  const files = {
    'tests/source-invariants.test.mjs': readFileSync(join(here, 'source-invariants.test.mjs'), 'utf8'),
  };
  const l8 = join(here, 'last8-chip.test.mjs');
  if (!IN_PUBLIC_KIT) {
    assert.ok(existsSync(l8),
      'tests/last8-chip.test.mjs is missing — it is the SECOND of the two chip test files this row sweeps; in the private repo its absence is a build gap');
    files['tests/last8-chip.test.mjs'] = readFileSync(l8, 'utf8');
  }
  const BANNED = ['cannot' + ' lift', 'does not' + ' lift', 'never' + ' lift',
    'at most one' + ' position', 'at most one' + ' rank'];
  const QUALIFIER = /8-leg|N=8|med8|full window/;
  for (const [rel, text] of Object.entries(files)) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const b of BANNED) {
        if (!line.includes(b)) continue;
        const scoped = QUALIFIER.test(line) || (i > 0 && QUALIFIER.test(lines[i - 1]));
        assert.ok(scoped,
          `${rel}:${i + 1} states the absolute without naming the window it holds for: "${line.trim().slice(0, 90)}"`);
      }
    });
  }
  // Positive half — the true property must be STATED, not deleted (regex needles: their \s+ escapes
  // keep this row's own source from satisfying them).
  const s = files['tests/source-invariants.test.mjs'];
  assert.match(s, /full\s+8-leg\s+window/, 'the S15 rationale scopes the one-rank claim to the full 8-leg window');
  assert.match(s, /hold\s+less\s+firmly/, 'the S15 rationale states that shorter windows hold less firmly');
  assert.match(s, /own\s+size\s+into\s+the\s+figure/, 'the S15 rationale states the two-fat-legs short-window break');
});
