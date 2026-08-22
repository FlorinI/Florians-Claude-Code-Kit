import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { atomicWriteFile } from '../home/_sl-compat.mjs';

// write-hardening (rows F1/F2-behavioural) — the atomic-write helper's contract, plus the
// post-kill recovery path: a crash between temp-write and rename leaves the original target
// intact and an orphaned <path>.tmp.<pid>; the next render must run clean off the intact stats
// file (no rollup reset) and tolerate the orphan. (Which call sites USE the helper is
// source-invariants F2.)

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, '..', 'home', 'statusline.mjs');
const NOW = 1781750000;

function tempDir() { return mkdtempSync(join(tmpdir(), 'wh-')); }

test('atomicWriteFile — writes content and leaves no temp residue', () => {
  const d = tempDir();
  try {
    const p = join(d, 'state.json');
    atomicWriteFile(p, '{"a":1}');
    assert.equal(readFileSync(p, 'utf8'), '{"a":1}');
    atomicWriteFile(p, '{"a":2}'); // overwrite path
    assert.equal(readFileSync(p, 'utf8'), '{"a":2}');
    assert.deepEqual(readdirSync(d), ['state.json'], 'no .tmp.* residue');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('atomicWriteFile — failed write throws, cleans its temp, never half-writes the target', () => {
  const d = tempDir();
  try {
    // Target is an existing DIRECTORY → renameSync fails on every platform.
    const p = join(d, 'blocked');
    mkdirSync(p);
    writeFileSync(join(p, 'inner.txt'), 'x', 'utf8'); // non-empty, so POSIX rename can't replace it
    assert.throws(() => atomicWriteFile(p, 'clobber'));
    assert.ok(existsSync(join(p, 'inner.txt')), 'target untouched');
    assert.deepEqual(readdirSync(d), ['blocked'], 'temp cleaned up after the failure');
    // Nonexistent parent → the temp write itself fails; still throws, still no residue.
    assert.throws(() => atomicWriteFile(join(d, 'no-such-dir', 'x.json'), 'x'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('F1 — post-kill state (intact stats + orphaned temp): stats survive, render runs clean', () => {
  const home = mkdtempSync(join(tmpdir(), 'wh-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'wh-cwd-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const transcript = join(cwd, 'transcript.jsonl');
    const legLine = (i) => JSON.stringify({
      type: 'assistant', timestamp: `2026-06-18T02:2${i}:00.000Z`,
      message: { id: `w${i}`, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5000 } },
    }) + '\n';
    writeFileSync(transcript, legLine(0) + legLine(1) + legLine(2), 'utf8');

    const stdinFor = (cost) => JSON.stringify({
      model: { display_name: 'Fable 5 (1M context)' },
      version: '2.1.142', effort: { level: 'high' },
      context_window: { used_percentage: 5, total_input_tokens: 50000, context_window_size: 1000000 },
      transcript_path: transcript, session_id: 'wh-kill-1',
      cost: { total_cost_usd: cost, total_api_duration_ms: 60000 },
      workspace: { current_dir: cwd }, rate_limits: {},
    });
    // CLAUDE_CONFIG_DIR is pinned POSITIVELY (never deleted) so the child's user-level state stays
    // inside the temp home even when this suite is launched from a second-subscription session.
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW) };
    const run = (cost) => execFileSync(process.execPath, [engine], { input: stdinFor(cost), env, maxBuffer: 64 * 1024 * 1024 });

    // Render 1 establishes the stats file. The costBaseline mechanism was removed 2026-07-27
    // (CC resets total_cost_usd on /clear since 2.1.211): fresh rollups must not carry the key.
    run(0.25);
    const statsPath = join(cwd, '.claude', 'statusline-stats', 'wh-kill-1.json');
    const stats1 = JSON.parse(readFileSync(statsPath, 'utf8'));
    assert.ok(!('costBaseline' in stats1), 'fresh rollup carries no costBaseline key');
    assert.equal(stats1.lastSeenCost, 0.25, 'render 1 latched its cost');

    // Simulate the kill's aftermath: the target survived, plus an orphaned temp full of garbage.
    const orphan = statsPath + '.tmp.99999';
    writeFileSync(orphan, '{"nLegs": 999, "TRUNCATED', 'utf8');

    // Render 2 must run clean off the INTACT stats file, ignoring the orphan. Grow the transcript
    // by one leg so the no-reset proof is discriminating: a new leg prices at
    // currentCost − lastSeenCost = 0.30 − 0.25 = 0.05 only when render 1's state was carried
    // forward — the reset path (freshRollup + skipLastLegCost) would leave lastLegCost null.
    writeFileSync(transcript, legLine(0) + legLine(1) + legLine(2) + legLine(3), 'utf8');
    const out = run(0.3);
    assert.ok(out.length > 0, 'render produced output');
    const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
    assert.equal(stats.nLegs, 4, 'incremental scan picked up the new leg, garbage temp never read');
    assert.ok(Math.abs(stats.lastLegCost - 0.05) < 1e-9,
      `state carried forward, no reset: lastLegCost ${stats.lastLegCost} != 0.05`);
    assert.equal(stats.lastSeenCost, 0.3, 'render 2 latched its cost');
    // Tolerated: the orphan is dead weight, never promoted to state (swept by age later).
    if (existsSync(orphan)) {
      assert.equal(readFileSync(orphan, 'utf8'), '{"nLegs": 999, "TRUNCATED', 'orphan left as-is');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── RP-1 … RP-6: the stats-file projection (froz5-removal amendment, spec §A3) ───────────────────
//
// WHY. UpdateSessionRollups used to mutate the object it read and write it straight back, so a key
// nothing writes any more was carried forward for the LIFE of the session file — verified to survive
// even a forced full re-bank of 180 legs. Three retired opening-window keys were still sitting in
// live stats files after the code that wrote them was deleted, which defeats this sprint's headline
// property ("removed, not gated off"): the completeness guard greps the source and cannot see a dead
// key that is alive in data.
//
// The ruling: write a PROJECTION of the declared shape (Object.keys(freshRollup()) plus three
// conditional keys), not the object that was read. The list is DERIVED, so a field added to the fresh
// shape is preserved automatically and only genuinely unknown keys drop.
//
// These rows use an inline transcript only — this file ships in the public kit
// (tools/export-public.mjs:107-112), so it may not reach for a private fixture.

// AMENDED by spec §A9.1 (2026-08-22). `openingLegs` is NO LONGER dropped: the deployed 5.x build
// lists it in its own requiredFields, so a file without it reads as structurally unusable and gets
// RESET — wiping sessionName / modelSwitch / modelSwitchedAtLeg / runStartLeg, none of which a later
// render can re-derive. It is now a declared, empty, never-filled compatibility placeholder. The
// constant therefore SPLITS rather than shrinking: dropping the key from a list and asserting nothing
// in its place is the vacuous pass this suite exists to prevent.
const DROPPED_KEYS = ['firstLegColdStart', 'openingLegCw'];
const COMPAT_KEY = 'openingLegs';
const JUNK_KEY = 'inventedByNobody';

// The PREVIOUS build's required-key list, copied verbatim from 6b6f116:home/statusline.mjs:326-328.
// Pinned as a literal on purpose: it pins the COMPATIBILITY PROPERTY ("a reader that can still run
// tolerates what we write") rather than one historical binary, and it is what RP-7 evaluates.
// RETIRE together with ROLLUP_COMPAT_KEYS, once every config home reports SL_VERSION >= 6.0.0.0
// (.inbox/2026-08-22-retire-openinglegs-rollup-compat-key.md).
const PREV_BUILD_REQUIRED_FIELDS = ['lastByteOffset', 'nLegs', 'sumUnits', 'sumOutputTokens',
  'lastMsgId', 'lastInputBilled', 'lastOutputTokens', 'lastSeenCost',
  'lastLegCost', 'perLegUnits', 'perLegOwnUnits', 'perLegModels', 'openingLegs'];

function legLine(i, ts) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { id: `rp${i}`, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5000 } },
  }) + '\n';
}

// A session that can be rendered repeatedly, growing a leg at a time.
function projectionRig() {
  const home = mkdtempSync(join(tmpdir(), 'rp-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rp-cwd-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const transcript = join(cwd, 'transcript.jsonl');
  const sid = 'rp-proj-1';
  const env = {
    ...process.env, USERPROFILE: home, HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd,
    TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW),
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  const statsPath = join(cwd, '.claude', 'statusline-stats', sid + '.json');
  const write = (nLegs) => {
    let t = '';
    for (let i = 0; i < nLegs; i++) t += legLine(i, `2026-06-18T02:${String(20 + i).padStart(2, '0')}:00.000Z`);
    writeFileSync(transcript, t, 'utf8');
  };
  const render = ({ legs, cost, model = 'Fable 5 (1M context)', sessionName = null }) => {
    write(legs);
    const stdin = {
      model: { display_name: model },
      version: '2.1.142', effort: { level: 'high' },
      context_window: { used_percentage: 5, total_input_tokens: 50000, context_window_size: 1000000 },
      transcript_path: transcript, session_id: sid,
      cost: { total_cost_usd: cost, total_api_duration_ms: 60000 },
      workspace: { current_dir: cwd }, rate_limits: {},
    };
    if (sessionName) stdin.session_name = sessionName;
    const out = execFileSync(process.execPath, [engine], { input: JSON.stringify(stdin), env, maxBuffer: 64 * 1024 * 1024 });
    return out.toString('utf8');
  };
  const stats = () => JSON.parse(readFileSync(statsPath, 'utf8'));
  const cleanup = () => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); };
  return { home, cwd, sid, env, statsPath, render, stats, cleanup };
}

test('RP-1/RP-2/RP-4 — retired + unknown keys drop, the compat key stays and stays EMPTY, every live value survives, and it is idempotent', () => {
  const rig = projectionRig();
  try {
    // Render 1 establishes a real stats file, the way the previous build would have left one.
    rig.render({ legs: 3, cost: 0.30 });
    const before = rig.stats();
    // Now make it a file the PREVIOUS build wrote: three retired rollup keys plus one junk key that
    // never belonged there at all. `openingLegs` carries a NON-empty bank, so the assertion below
    // distinguishes "rode through untouched" from "reset to the declared empty placeholder".
    const seeded = { ...before, openingLegs: [1, 2, 3], firstLegColdStart: true, openingLegCw: 41234, [JUNK_KEY]: 'x' };
    writeFileSync(rig.statsPath, JSON.stringify(seeded, null, 2), 'utf8');

    // A render that banks a leg. AE-31.
    rig.render({ legs: 4, cost: 0.40 });
    const after = rig.stats();

    // RP-1 — the two genuinely-retired keys and the junk key are gone.
    for (const k of [...DROPPED_KEYS, JUNK_KEY]) {
      assert.ok(!(k in after), `${k} must be dropped by the projection, not carried forward`);
    }
    // RP-1 (§A9.1) — the compat key is RETAINED. A pre-existing value rides through untouched: the
    // key is in ROLLUP_KEYS, so the projection copies it, and the post-projection stamp only fills a
    // key that is ABSENT. Asserting the value (not just presence) is what proves the projection did
    // not quietly start writing the bank again.
    assert.ok(COMPAT_KEY in after, `${COMPAT_KEY} must survive: the previous build treats it as required`);
    assert.deepEqual(after[COMPAT_KEY], [1, 2, 3], 'an existing compat value rides through untouched');

    // RP-2 — no live value is lost, and the incremental scan is NOT silently reset into a full
    // re-bank. A reset would look green on the surface (the file still parses, the numbers still
    // render) and quietly re-price every historical leg at today's tier.
    for (const k of Object.keys(before)) {
      assert.ok(k in after, `live key ${k} must survive the projection`);
    }
    assert.equal(after.nLegs, before.nLegs + 1, 'exactly one new leg banked');
    assert.ok(after.lastByteOffset >= before.lastByteOffset && after.lastByteOffset > 0,
      `lastByteOffset went backwards → the scan restarted: ${before.lastByteOffset} → ${after.lastByteOffset}`);
    assert.equal(after.perLegUnits.length, before.perLegUnits.length + 1, 'perLegUnits grew, did not restart');
    assert.equal(after.perLegModels.length, before.perLegModels.length + 1, 'perLegModels grew, did not restart');
    assert.deepEqual(after.perLegUnits.slice(0, before.perLegUnits.length), before.perLegUnits,
      'the already-banked legs kept their units');

    // RP-4 — idempotent. A second render adds nothing back and takes nothing more away.
    rig.render({ legs: 4, cost: 0.40 });
    const again = rig.stats();
    for (const k of [...DROPPED_KEYS, JUNK_KEY]) assert.ok(!(k in again), `${k} must not resurrect`);
    assert.deepEqual(again[COMPAT_KEY], [1, 2, 3], 'the compat key is still untouched after a second pass');
    assert.deepEqual(Object.keys(again), Object.keys(after), 'the key set is stable across renders');
  } finally { rig.cleanup(); }
});

test('RP-7 — AE-32: what this build writes still satisfies the PREVIOUS build\'s required-key list', () => {
  // THE BLOCKING DEFECT THIS ROW EXISTS FOR. The 5.x reader's whole compatibility check is
  // `for (const f of requiredFields) if (!(f in r)) needsReset = true` — and on reset it calls
  // freshRollup(), destroying sessionName, modelSwitch, modelSwitchedAtLeg and runStartLeg. Measured
  // on real session 30ec7e5a: a 6.x render followed by a 5.x render silently threw the session away,
  // with every mechanics test green, because Florian's two config homes install by separate manual
  // commands and share one per-project stats file.
  //
  // TWO directions, because they fail by different doors:
  //   (a) a file the PREVIOUS build already wrote  -> the key must RIDE THROUGH the projection;
  //   (b) a file this build CREATED from nothing   -> the key must be STAMPED by the write site.
  // A compat entry implemented as "keep it if present" passes (a) and fails (b) — and (b) is the
  // ordinary case for every session started from today on.
  const missing = (r) => PREV_BUILD_REQUIRED_FIELDS.filter((f) => !(f in r));

  // (a) — inherited from the previous build.
  const rigA = projectionRig();
  try {
    rigA.render({ legs: 3, cost: 0.30, sessionName: 'ledger-rework' });
    const before = rigA.stats();
    writeFileSync(rigA.statsPath, JSON.stringify(
      { ...before, openingLegs: [1, 2, 3], firstLegColdStart: true, openingLegCw: 41234 }, null, 2), 'utf8');
    rigA.render({ legs: 4, cost: 0.40, sessionName: 'ledger-rework' });
    const after = rigA.stats();
    assert.deepEqual(missing(after), [],
      `the previous build would RESET this file (missing: ${missing(after).join(', ')}) and wipe the session`);
  } finally { rigA.cleanup(); }

  // (b) — created under this build, never touched by the old one.
  const rigB = projectionRig();
  try {
    rigB.render({ legs: 3, cost: 0.30, sessionName: 'born-on-six' });
    const fresh = rigB.stats();
    assert.deepEqual(missing(fresh), [],
      `a file THIS build created is unreadable to the previous one (missing: ${missing(fresh).join(', ')})`);
    // And the survival is real, not just structural: the four values a reset would destroy.
    rigB.render({ legs: 4, cost: 0.40, model: 'Sonnet 5', sessionName: 'born-on-six' });
    const s = rigB.stats();
    assert.equal(s.sessionName, 'born-on-six');
    assert.ok(s.modelSwitch, 'modelSwitch is stamped only at the render where the switch happened');
    assert.equal(typeof s.modelSwitchedAtLeg, 'number');
    assert.equal(typeof s.runStartLeg, 'number');
    assert.deepEqual(missing(s), [], 'still readable by the previous build after the switch render');
  } finally { rigB.cleanup(); }
});

test('RP-8 — nothing ever FILLS the compat key: it is a placeholder, not a revived field', () => {
  // Spec §A9.6 invariant. A file created under this build gets `openingLegs: []` stamped; no amount
  // of banking may put anything in it. This is the row that goes red if someone later "restores" the
  // opening-window bank behind the compat entry's name.
  const rig = projectionRig();
  try {
    for (let legs = 2; legs <= 9; legs++) {
      rig.render({ legs, cost: 0.10 * legs });
      assert.deepEqual(rig.stats()[COMPAT_KEY], [],
        `the compat key must stay empty at ${legs} banked legs — nothing may write to it`);
    }
  } finally { rig.cleanup(); }
});

test('RP-3 — the three optional keys survive, asserted through to what a READER sees', () => {
  // Spec §A3 names losing this trio as the one way the projection can do harm, so it is pinned end to
  // end rather than as a key-presence check. `sessionName` is the dangerous one: the status line reads
  // the name from the payload every render, so a dropped key is INVISIBLE there — it only surfaces in
  // the fact sheet's FOREIGN block, which names THIS session by reading the stats file.
  const rig = projectionRig();
  try {
    rig.render({ legs: 3, cost: 0.30, sessionName: 'ledger-rework' });
    // A mid-session PRICE-TIER change stamps modelSwitch / modelSwitchedAtLeg.
    rig.render({ legs: 4, cost: 0.40, model: 'Sonnet 5', sessionName: 'ledger-rework' });
    const s = rig.stats();
    assert.equal(s.sessionName, 'ledger-rework', 'sessionName survives the projection');
    assert.equal(typeof s.modelSwitchedAtLeg, 'number', 'modelSwitchedAtLeg survives');
    assert.ok(s.modelSwitch && s.modelSwitch.to === 'Sonnet 5', 'modelSwitch survives with its value');

    // One more render, so the projection has run again over a file that already carries all three.
    rig.render({ legs: 5, cost: 0.50, model: 'Sonnet 5', sessionName: 'ledger-rework' });
    const s2 = rig.stats();
    assert.equal(s2.sessionName, 'ledger-rework');
    assert.ok(s2.modelSwitch, 'modelSwitch still there after a second projection pass');

    const facts = join(here, '..', 'home', 'handover-facts.mjs');
    const sidecarPath = join(rig.cwd, '.claude', 'statusline-last.json');

    // READER-VISIBLE #1 — the model-switch caveat still reaches the sheet. The sidecar carries
    // modelSwitch straight from the rollup, so a projection that dropped the key would silently
    // delete the caveat on the NEXT render, with nothing on screen to say it had gone.
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    assert.ok(sidecar.modelSwitch, 'the rollup key reached the sidecar');
    const sheet = execFileSync(process.execPath, [facts], { env: rig.env, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
    assert.match(sheet, /^COST_MODELSWITCH_NOTE: the model switched mid-session/m,
      'the caveat still appears in the sheet');

    // READER-VISIBLE #2 — the fact sheet names this session in words. It can only do that by reading
    // sessionName out of the STATS FILE (handover-facts.mjs readOwnSessionName), so this assertion
    // fails the moment the projection drops the key. The status line itself would not notice: it
    // reads the name from the payload on every render.
    const foreign = { schema: 6, sessionId: 'someone-elses-session', renderedAt: NOW, gitRepo: null };
    writeFileSync(sidecarPath, JSON.stringify(foreign), 'utf8');
    const out = execFileSync(process.execPath, [facts], {
      env: { ...rig.env, CLAUDE_CODE_SESSION_ID: rig.sid }, maxBuffer: 32 * 1024 * 1024,
    }).toString('utf8');
    assert.match(out, /^FOREIGN/, 'the guard fired, so we are on the naming path');
    assert.ok(out.includes('ledger-rework'),
      `the sheet must name this session in words, not by id alone: ${JSON.stringify(out)}`);
  } finally { rig.cleanup(); }
});

test('RP-5 — the key list is DERIVED from freshRollup(), never a hand-maintained retired-key list', () => {
  // Spec §A3 rejected `delete r.openingLegs` and its siblings for two reasons, and this row pins
  // both: (a) a hand list needs a new entry for every future rollup removal — the exact "nobody
  // remembered" failure these tickets keep finding; (b) naming a dead key inside home/*.mjs would
  // collide head-on with the completeness guard in source-invariants, which greps that directory for
  // `openingLeg|firstLegColdStart`.
  const src = readFileSync(engine, 'utf8');
  assert.match(src, /const ROLLUP_KEYS = new Set\(\[\.\.\.Object\.keys\(freshRollup\(\)\), \.\.\.ROLLUP_OPTIONAL_KEYS,\s*\.\.\.Object\.keys\(ROLLUP_COMPAT_KEYS\)\]\)/,
    'ROLLUP_KEYS is derived from the fresh shape plus the two DECLARED lists — never a hand-written key set');
  assert.match(src, /const ROLLUP_OPTIONAL_KEYS = \['modelSwitchedAtLeg', 'modelSwitch', 'sessionName'\]/,
    'and the optional list is exactly the three keys assigned outside that shape');
  // §A9.1: only the two genuinely-retired keys are banned from the source now. `openingLegs` is the
  // one declared exception, and its shape is pinned POSITIVELY by source-invariants S4 — not left as
  // a hole in this loop.
  for (const k of DROPPED_KEYS) {
    assert.ok(!src.includes(k), `home/statusline.mjs must not name the retired key ${k}`);
  }
  // The write goes through the projection, not the object that was read.
  assert.match(src, /for \(const k of Object\.keys\(r\)\) \{ if \(ROLLUP_KEYS\.has\(k\)\) rOut\[k\] = r\[k\]; \}/,
    'the write is a projection');
  // ...and the compat stamp runs AFTER it, or a file this build created never gets the key (RP-7b).
  assert.match(src, /for \(const \[k, v\] of Object\.entries\(ROLLUP_COMPAT_KEYS\)\) if \(!\(k in rOut\)\) rOut\[k\] = v;/,
    'the compat keys are stamped onto the projection when absent');
  assert.doesNotMatch(src, /atomicWriteFile\(statsPath, JSON\.stringify\(r,/,
    'the raw object is no longer written');
});

test('RP-6 — the projection is NOT over-applied: the sub-agent rollup keeps an unknown key', () => {
  // Spec §A3 puts <sid>.agents.json explicitly out of scope: same mechanism, no dead keys, and no
  // declared shape to project against. A copy-pasted projection there would drop live agent state.
  const home = mkdtempSync(join(tmpdir(), 'rp6-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'rp6-cwd-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const transcript = join(cwd, 'transcript.jsonl');
    const subDir = join(cwd, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(transcript, legLine(0, '2026-06-18T02:20:00.000Z') + legLine(1, '2026-06-18T02:21:00.000Z'), 'utf8');
    writeFileSync(join(subDir, 'agent-a.jsonl'),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-06-18T02:20:30.000Z',
        message: { id: 'a1', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2000 } },
      }) + '\n', 'utf8');
    const env = {
      ...process.env, USERPROFILE: home, HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd,
      TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(NOW),
    };
    delete env.CLAUDE_CODE_SESSION_ID;
    const stdin = JSON.stringify({
      model: { display_name: 'Fable 5 (1M context)' },
      version: '2.1.142', effort: { level: 'high' },
      context_window: { used_percentage: 5, total_input_tokens: 50000, context_window_size: 1000000 },
      transcript_path: transcript, session_id: 'rp6-1',
      cost: { total_cost_usd: 0.3, total_api_duration_ms: 60000 },
      workspace: { current_dir: cwd }, rate_limits: {},
    });
    execFileSync(process.execPath, [engine], { input: stdin, env, maxBuffer: 64 * 1024 * 1024 });
    const agentsPath = join(cwd, '.claude', 'statusline-stats', 'rp6-1.agents.json');
    assert.ok(existsSync(agentsPath), 'the sub-agent rollup was written');
    const a = JSON.parse(readFileSync(agentsPath, 'utf8'));
    a[JUNK_KEY] = 'keep me';
    writeFileSync(agentsPath, JSON.stringify(a, null, 2), 'utf8');
    execFileSync(process.execPath, [engine], { input: stdin, env, maxBuffer: 64 * 1024 * 1024 });
    const after = JSON.parse(readFileSync(agentsPath, 'utf8'));
    assert.equal(after[JUNK_KEY], 'keep me',
      'the agents rollup has no declared shape to project against — it must not be projected');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
