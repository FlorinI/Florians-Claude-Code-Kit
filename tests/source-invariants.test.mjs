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
  for (const f of ['home/statusline.mjs', 'home/leg-driver.mjs', 'home/handover-facts.mjs']) {
    for (const spec of importSpecifiers(src(f))) {
      assert.ok(spec.startsWith('node:') || /^\.\/[\w-]+\.mjs$/.test(spec), `${f} imports ${spec}`);
    }
  }
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
    if (!existsSync(p)) continue;
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
  // trend" — false on 20 of 114 real sessions, and false *because* of the median this build chose: a
  // median is built so a lone fat leg INSIDE the window shifts it at most one position, to the next
  // ordinary leg's price rather than toward the spike's. Same family as S13.
  // `home/commands/handover-check.md` ships in the public kit (manifest.public.json:19) and this test
  // file is exported too, so its half runs everywhere. `.claude/commands/interpret-statusline.md` is
  // private-repo only — same treatment as the D4 private-docs row below: assert it where it exists,
  // skip it where it cannot. It is NEVER skipped on Florian's checkout, which is where it is read.
  const isPath = join(repo, '.claude', 'commands', 'interpret-statusline.md');
  const RELAYS = { 'home/commands/handover-check.md': src('home/commands/handover-check.md') };
  if (existsSync(isPath)) RELAYS['.claude/commands/interpret-statusline.md'] = readFileSync(isPath, 'utf8');

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
    assert.ok(/trajectory shape/.test(chipLine) && /sparkline/.test(chipLine),
      'the chip sentence must send the reader to the trajectory shape and the sparkline for direction');
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
  assert.match(s, /' legs median '/, 'and it must actually say it');
});

test('AV-2 — handover-facts.mjs contains no form of "averag" at all, comments included', () => {
  // This file takes a TOTAL ban with no carve-out: verified that nothing else in it used the word.
  // Comments count — a comment describing the recent figure as an average misleads the next reader
  // exactly as much as the emitted string would, and it is how a correct string gets "fixed" back.
  const hits = src('home/handover-facts.mjs').split('\n')
    .map((l, i) => [i + 1, l]).filter(([, l]) => /averag/i.test(l));
  assert.deepEqual(hits.map(([n, l]) => `:${n} ${l.trim().slice(0, 90)}`), []);
});

test('AV-3 — the chip\'s retired names appear nowhere on the live surface', () => {
  // Scope: the surface a reader or a future editor actually meets. Excluded: superseded docs, the
  // sprint machinery (plans / sprints / handovers / chain / inbox — working notes, not the product),
  // the parity fixtures (committed goldens, blessed from the code) and build output.
  const ROOTS = ['home', 'docs', 'tests', 'tools', 'SPEC.md', 'CLAUDE.md', '.claude/commands', '.claude/skills'];
  const EXCLUDED = [
    /^docs[\\/]_superseded/, /^\.claude[\\/](plans|sprints|handovers)/, /^\.sprint-chain/,
    /^\.inbox/, /^tools[\\/]parity[\\/]fixtures/, /^build/, /^node_modules/,
  ];
  const files = [];
  const walk = (rel) => {
    if (EXCLUDED.some((r) => r.test(rel))) return;
    const abs = join(repo, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) { for (const n of readdirSync(abs)) walk(join(rel, n)); return; }
    files.push(rel);
  };
  for (const r of ROOTS) walk(r);
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
      if (existsSync(p)) targets.push([rel, readFileSync(p, 'utf8')]);
    }
  } else {
    for (const rel of ['README.md', 'docs/status-line.md']) {
      const p = join(repo, ...rel.split('/'));
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

// ---- D4: calibration sample rows carry the session model ---------------------------------------
// Private-repo docs; skipped when absent so this suite stays runnable from a public checkout.
// The era-v5 file was archived to docs/_superseded/ by the froz5 removal and a fresh live samples
// file took its place (D4) — /interpret-statusline appends one row per screenshot, so it needs a
// live target.
test('D4 — samples table header + interpret-statusline row template carry a model column', (t) => {
  const samples = join(repo, 'docs', 'statusline-calibration-samples.md');
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
