import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, utimesSync, chmodSync, readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EOL, tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  REPO, MODULE, ENGINE, FIXDIR, STUB, NOW, PS_TEMPLATE, psWatch, bashWatch, legLine, toolLine, userLine,
  sandbox, render, renderAsync, writeTranscript, readJson, readJsonOr, dialoguesOf, keyOf, hasPath, hasValue,
  entryFor, cli, cliAsync, FAST_LIMITS, pidAlive, waitProbeExit, sleep, deadPid, guardPid, hangingPath,
  fixtureText, placeFixture, placeSessionTranscript, lsDir, strip, noOfflineHang, childEnv,
} from './_open-dialogues-harness.mjs';

// open-dialogues — the mechanics rows of the open-dialogues sprint (2026-11-05).
//
// Spec: docs/261105-open-dialogues-spec.md. Test plan (acceptance examples frozen at [G1]):
// docs/261105-open-dialogues-test-plan.md. Every row refines within an acceptance example and never
// contradicts one; a row that cannot pass as written against a correct build is a spec event, not a
// test to loosen.
//
// Covers detection (§3), the rollup key and its backfill, the tail classifier and the probe (§4),
// the probe guard and its test seams, `--session` (§6 step 1), `--close` (§6 step 4) and the Node-18
// guard. Exported to the public kit, so it runs on three operating systems and three Node versions:
// no machine path, no private name, and posix-only rows skip by `process.platform` alone.
//
// Shared rules (test plan): every engine run sets CLAUDE_SL_DIALOGUE_PROBE=off unless the row is about
// the probe start; every real probe is a child process with its limits cut well under a second; a row
// that lets a real probe start waits for the pid in the guard to exit before deleting its temp dir.

const SID = 'odlg-sess-1';
const MOD_SRC = () => readFileSync(MODULE, 'utf8');
const CLOSE_LINE = '— CONVENER · DIALOGUE CLOSED';
const stubEnv = (log, sleepMs = 0) => ({ CLAUDE_SL_DIALOGUE_PROBE: STUB, STUB_PROBE_LOG: log, STUB_PROBE_SLEEP_MS: sleepMs });
const stubStarts = (log) => {
  let text = '';
  try { text = readFileSync(log, 'utf8'); } catch { return []; }   // no log: the stub never started
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
// The stub's starts once the log holds at least `n`, or as it stands after `timeoutMs`. A render
// returns before its detached stub has loaded node, and under a loaded suite that start outlasts
// any fixed sleep (seen 2026-11-09 under a full `npm test`) — so a row that expects a
// start polls for it. A row that expects NO start keeps its fixed sleep: there a late start can only
// hide a defect, never fail a correct build.
const waitStarts = async (log, n = 1, timeoutMs = 15000) => {
  const t0 = Date.now();
  let s = [];
  for (;;) {
    try { s = stubStarts(log); } catch { s = []; }   // a line caught mid-append: read again
    if (s.length >= n || Date.now() - t0 >= timeoutMs) return s;
    await sleep(25);
  }
};
const rollupOf = (sb, sid = SID) => readJson(sb.rollupPath(sid));

// A session whose transcript arms one PowerShell watch per file, on repeated-id lines.
function armedTranscript(sb, files, { sid = SID, label = 'Api-Claude', extraLines = [] } = {}) {
  const lines = [];
  files.forEach((f, i) => { lines.push(legLine(`m${i}`)); lines.push(toolLine(`m${i}`, psWatch(f, label))); });
  lines.push(...extraLines);
  return writeTranscript(sb, sid, lines);
}
// The rollup the probe reads, produced by the engine itself (probe off) — so the probe rows never
// depend on the rollup entry's field names, which the spec leaves to the build.
function armedRollup(sb, files, opts = {}) {
  const t = armedTranscript(sb, files, opts);
  render(sb, opts.sid || SID, t);
  return { transcript: t, rollup: sb.rollupPath(opts.sid || SID), state: sb.statePath(opts.sid || SID) };
}
const probe = (sb, r, env = {}) => cli(['--probe', r.rollup, r.state], { sb, env: { ...FAST_LIMITS, ...env } });
const stateEntry = (st, file) => (st && st.dialogues ? st.dialogues[keyOf(file)] : undefined);

// The hang rows' per-file limit: well under the ~2 s an unanswered SMB open takes to fail by itself on
// Windows, so the limit is what ends the read. A hang row proves it really waited by finishing no
// sooner than its limit, and proves the limit ended it by finishing soon after (node startup included).
const HANG_FILE_MS = 500;
function assertNearLimit(ms, limitMs, what) {
  assert.ok(ms >= limitMs, `${what}: finished in ${ms} ms, before its ${limitMs} ms limit — the path did not hang, so the row tested nothing`);
  assert.ok(ms < limitMs + 1200, `${what}: finished in ${ms} ms, long after its ${limitMs} ms limit`);
}

// =================================================================================================
// Detection and paths — spec §3, §14.1, §14.10, §14.11
// =================================================================================================

// The composite transcript fixture: every carrier the spec rules out, beside the three real arms.
// Paths are a {{DIR}} placeholder, substituted with a temp dir (JSON-escaped), so no machine path
// enters the repo or the kit.
function detectTranscript(sb) {
  const dir = JSON.stringify(sb.files).slice(1, -1);
  const text = readFileSync(join(FIXDIR, 'transcript-detect.jsonl'), 'utf8').split('{{DIR}}').join(dir);
  const p = join(sb.root, `${SID}.jsonl`);
  writeFileSync(p, text, 'utf8');
  return p;
}

test('D-1+D-2+D-3+D-4+D-6 — the composite transcript yields exactly the three real arms (fixture transcript-detect.jsonl)', () => {
  const sb = sandbox();
  try {
    const t = detectTranscript(sb);
    render(sb, SID, t);
    const entries = dialoguesOf(rollupOf(sb));
    const want = ['alpha', 'beta', 'gamma'].map((n) => join(sb.files, `${n}-dialogue.md`));
    assert.equal(entries.length, 3, `exactly alpha, beta and gamma are dialogues; got ${JSON.stringify(entries)}`);
    for (const w of want) assert.ok(entryFor(entries, w), `missing an entry for ${w}`);
    for (const carrier of ['carrier', 'heredoc', 'delta', 'echo', 'textblock', 'template']) {
      assert.ok(!entries.some((e) => JSON.stringify(e).includes(`${carrier}-dialogue.md`)),
        `${carrier}-dialogue.md is carried, unfilled or echoed — never armed by this session (D-2, D-4, D-6)`);
    }
    assert.ok(hasValue(entryFor(entries, want[1]), 'bash'), 'beta was armed by the bash variant behind #posix: (D-3)');
    assert.ok(hasValue(entryFor(entries, want[0]), 'powershell'), 'alpha was armed by the PowerShell variant');
    assert.ok(hasValue(entryFor(entries, want[2]), 'powershell'), 'gamma: leading blank lines and two # lines are dropped before the match (D-3)');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('D-1 — a PowerShell watch on a REPEATED message.id line is found: absolute path, label, shell, command byte-equal', () => {
  const sb = sandbox();
  try {
    const f = join(sb.files, 'alpha-dialogue.md');
    const cmd = psWatch(f, 'Api-Claude');
    const t = writeTranscript(sb, SID, [legLine('m1'), toolLine('m1', cmd)]);
    render(sb, SID, t);
    const r = rollupOf(sb);
    const entries = dialoguesOf(r);
    assert.equal(entries.length, 1, `one dialogue: ${JSON.stringify(r.dialogues)}`);
    const e = entries[0];
    assert.ok(hasValue(e, f), `the entry holds the absolute path ${f}: ${JSON.stringify(e)}`);
    assert.ok(hasValue(e, 'Api-Claude'), 'the entry holds this session\'s label');
    assert.ok(hasValue(e, 'powershell'), 'the entry names the shell variant `powershell`');
    assert.ok(hasValue(e, cmd), 'the entry holds the watch command byte-equal to input.command');
    assert.equal(r.nLegs, 1, 'the leg scan still banks the id once — detection runs before the dedup skip, never instead of it');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('D-2 — a Set-Clipboard command and a here-string launch prompt carrying a full watch are not participation', () => {
  const sb = sandbox();
  try {
    const f = join(sb.files, 'carrier-dialogue.md');
    const watch = psWatch(f, 'Web-Claude');
    const clip = `Set-Clipboard -Value '${watch.replace(/'/g, "''")}'`;
    const here = `$prompt = @'\nPaste this into the other session.\n${watch}\n'@\nSet-Clipboard -Value $prompt`;
    const t = writeTranscript(sb, SID, [legLine('m1'), toolLine('m1', clip), legLine('m2'), toolLine('m2', here)]);
    render(sb, SID, t);
    assert.deepEqual(dialoguesOf(rollupOf(sb)), [], 'only a command that BEGINS with the watch arms one (spec §2, AE-6)');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('D-3 — the bash variant behind `#posix:`, and a command with leading blank lines and two # lines, are found', () => {
  const sb = sandbox();
  try {
    const fb = join(sb.files, 'beta-dialogue.md');
    const fg = join(sb.files, 'gamma-dialogue.md');
    const cb = bashWatch(fb, 'Api-Claude');
    const cg = '\n\n# arm the watch\n# second comment line\n' + psWatch(fg, 'Api-Claude');
    const t = writeTranscript(sb, SID, [legLine('m1'), toolLine('m1', cb, { name: 'Bash' }), legLine('m2'), toolLine('m2', cg)]);
    render(sb, SID, t);
    const entries = dialoguesOf(rollupOf(sb));
    assert.equal(entries.length, 2);
    const eb = entryFor(entries, fb), eg = entryFor(entries, fg);
    assert.ok(eb && hasValue(eb, 'bash') && hasValue(eb, cb), `bash arm found with shell bash and its full command: ${JSON.stringify(eb)}`);
    assert.ok(eg && hasValue(eg, 'powershell') && hasValue(eg, cg), `the commented arm is found and its command kept byte-equal: ${JSON.stringify(eg)}`);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('D-4 — the unfilled template, and a filled file with an unfilled label, are not found', () => {
  const sb = sandbox();
  try {
    const f = join(sb.files, 'delta-dialogue.md');
    const t = writeTranscript(sb, SID, [
      legLine('m1'), toolLine('m1', PS_TEMPLATE),
      legLine('m2'), toolLine('m2', psWatch(f, '<YOUR-LABEL>')),
    ]);
    render(sb, SID, t);
    assert.deepEqual(dialoguesOf(rollupOf(sb)), [], 'a `<` in the file or the label is an unfilled template (spec §3)');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('D-5 — two arms of one file under different spellings give ONE entry with the later label and command (Windows); case-distinct paths are two elsewhere', () => {
  const sb = sandbox();
  try {
    const a = join(sb.files, 'Alpha-Dialogue.md');
    const b = sb.files.replace(/\\/g, '/') + '/alpha-dialogue.md';
    const ca = psWatch(a, 'Api-Claude'), cb = psWatch(b, 'Web-Claude');
    const t = writeTranscript(sb, SID, [legLine('m1'), toolLine('m1', ca), legLine('m2'), toolLine('m2', cb)]);
    render(sb, SID, t);
    const entries = dialoguesOf(rollupOf(sb));
    if (process.platform === 'win32') {
      assert.equal(entries.length, 1, `one dialogue: the key is the path lowercased with / (spec §3): ${JSON.stringify(entries)}`);
      assert.ok(hasValue(entries[0], 'Web-Claude'), 'the later label replaces the earlier one');
      assert.ok(hasValue(entries[0], cb), 'the later command replaces the earlier one');
      assert.ok(!hasValue(entries[0], 'Api-Claude'));
    } else {
      assert.equal(entries.length, 2, 'off Windows the key is the path unchanged, so a case difference is a different file');
    }
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('D-6 — a watch only in a user line or a text block is not found; a non-string input.command is skipped without throwing', () => {
  const sb = sandbox();
  try {
    const f = join(sb.files, 'echo-dialogue.md');
    const textBlock = JSON.stringify({
      type: 'assistant', timestamp: '2026-06-18T02:30:00.000Z',
      message: { id: 'm3', model: 'claude-opus-5', content: [{ type: 'text', text: psWatch(f, 'Api-Claude') }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
    });
    const badCmd = JSON.stringify({
      type: 'assistant', timestamp: '2026-06-18T02:31:00.000Z',
      message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'toolu_bad', name: 'PowerShell', input: { command: ['$f = "x"; $me = "y"'] } }] },
    });
    const t = writeTranscript(sb, SID, [legLine('m1'), userLine(psWatch(f, 'Api-Claude')), textBlock, badCmd]);
    const out = render(sb, SID, t);
    assert.ok(out.length > 0, 'the render completed');
    assert.deepEqual(dialoguesOf(rollupOf(sb)), []);
    assert.equal(rollupOf(sb).nLegs, 2, 'the leg scan is unaffected by the skipped lines');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('D-8 — a relative $f resolves against the line\'s cwd, falling back to the payload\'s cwd', () => {
  const sb = sandbox();
  try {
    const lineCwd = join(sb.root, 'proj-b');
    const t = writeTranscript(sb, SID, [
      legLine('m1', { cwd: lineCwd }), toolLine('m1', psWatch('sub/a-dialogue.md', 'Api-Claude'), { cwd: lineCwd }),
      legLine('m2'), toolLine('m2', psWatch('sub/b-dialogue.md', 'Api-Claude')),
    ]);
    render(sb, SID, t);
    const entries = dialoguesOf(rollupOf(sb));
    assert.equal(entries.length, 2);
    assert.ok(entryFor(entries, join(lineCwd, 'sub', 'a-dialogue.md')), `relative to the line's cwd: ${JSON.stringify(entries)}`);
    assert.ok(entryFor(entries, join(sb.cwd, 'sub', 'b-dialogue.md')), `no line cwd → the payload's cwd: ${JSON.stringify(entries)}`);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('D-7 — a line without the `me = \\"` / `me=\\"` pre-test text never reaches the content-block inspection (the module\'s test counter)', async () => {
  const mod = await import(pathToFileURL(MODULE).href);
  assert.ok(mod.detectionStats && typeof mod.detectionStats.inspected === 'number', 'the module exports its inspection counter (detectionStats.inspected)');
  assert.equal(typeof mod.detectDialoguesInText, 'function');
  const f = '/x/alpha-dialogue.md';
  const ordinary = [legLine('o1'), legLine('o2'), userLine('no watch here'), toolLine('o2', 'Get-ChildItem -Recurse')];
  const before = mod.detectionStats.inspected;
  mod.detectDialoguesInText(ordinary.join('\n'), '/x', []);
  assert.equal(mod.detectionStats.inspected - before, 0, 'ordinary lines cost one substring search and nothing more');
  const list = mod.detectDialoguesInText([...ordinary, toolLine('o3', psWatch(f, 'Api-Claude')), toolLine('o4', bashWatch(f, 'Api-Claude'), { name: 'Bash' })].join('\n'), '/x', []);
  assert.equal(mod.detectionStats.inspected - before, 2, 'only the two watch lines pass the pre-test');
  assert.equal(list.length, 1, 'and they are one dialogue');
});

// =================================================================================================
// Rollup — spec §3 invariants, §14.2, §14.3
// =================================================================================================

const LEG_ARRAYS = ['perLegUnits', 'perLegOwnUnits', 'perLegModels', 'seenMsgIds', 'coldLegs', 'recentLegs'];
const LEG_SCALARS = ['nLegs', 'sumUnits', 'sumOutputTokens', 'lastByteOffset', 'lastMsgId'];

test('R-1 — `dialogues` is in freshRollup() and never in requiredFields; a stats file without it is patched, never reset', () => {
  const src = readFileSync(ENGINE, 'utf8');
  const fresh = /const freshRollup = \(\) => \(\{([\s\S]*?)\}\);/.exec(src);
  assert.ok(fresh, 'freshRollup() found in statusline.mjs');
  assert.match(fresh[1], /\bdialogues\s*:/, 'dialogues joins freshRollup(), so the projection keeps it');
  const req = /const requiredFields = \[([\s\S]*?)\];/.exec(src);
  assert.ok(req, 'requiredFields found');
  assert.ok(!/['"]dialogues['"]/.test(req[1]), 'dialogues must never be required: a lagging reader would reset the file');

  const sb = sandbox();
  try {
    const t = writeTranscript(sb, SID, [legLine('m1'), legLine('m2')]);
    render(sb, SID, t);
    const r = rollupOf(sb);
    delete r.dialogues;
    r.sessionName = 'kept-name';
    r.runStartLeg = 1;
    writeFileSync(sb.rollupPath(SID), JSON.stringify(r, null, 2));
    render(sb, SID, t);
    const after = rollupOf(sb);
    assert.equal(after.sessionName, 'kept-name', 'no reset: sessionName survives');
    assert.equal(after.runStartLeg, 1, 'no reset: runStartLeg survives');
    assert.ok('dialogues' in after, 'the key is patched onto the existing file');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('R-2 — backfill: a stats file at the end of the transcript without `dialogues` gains the earlier watch; every leg array is untouched', () => {
  const sb = sandbox();
  try {
    const f = join(sb.files, 'alpha-dialogue.md');
    const t = armedTranscript(sb, [f], { extraLines: [legLine('m8'), legLine('m9')] });
    render(sb, SID, t);
    const seed = rollupOf(sb);
    delete seed.dialogues;                      // what a pre-feature build wrote
    assert.equal(seed.lastByteOffset, statSync(t).size, 'precondition: the seed already sits at the transcript end');
    writeFileSync(sb.rollupPath(SID), JSON.stringify(seed, null, 2));
    render(sb, SID, t);
    const r = rollupOf(sb);
    assert.ok(entryFor(dialoguesOf(r), f), `the watch armed before the deploy is found: ${JSON.stringify(r.dialogues)}`);
    for (const k of LEG_ARRAYS) assert.deepEqual(r[k], seed[k], `${k} is deep-equal to the seed`);
    for (const k of LEG_SCALARS) assert.deepEqual(r[k], seed[k], `${k} unchanged`);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('R-3 — a second render does not duplicate the entry; a stats file with the key stripped backfills to the same result', () => {
  const sb = sandbox();
  try {
    const f = join(sb.files, 'alpha-dialogue.md');
    const t = armedTranscript(sb, [f]);
    render(sb, SID, t);
    const first = rollupOf(sb).dialogues;
    render(sb, SID, t);
    assert.deepEqual(rollupOf(sb).dialogues, first, 'a second render changes nothing');
    assert.equal(dialoguesOf(rollupOf(sb)).length, 1);
    const r = rollupOf(sb); delete r.dialogues;
    writeFileSync(sb.rollupPath(SID), JSON.stringify(r, null, 2));
    render(sb, SID, t);
    assert.deepEqual(rollupOf(sb).dialogues, first, 'a lagging build that drops the key triggers the same backfill — harmless');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('R-4 — the truncation reset empties `dialogues` with the other arrays, and the rescan refills it', () => {
  const sb = sandbox();
  try {
    const fa = join(sb.files, 'alpha-dialogue.md'), fb = join(sb.files, 'beta-dialogue.md');
    const t = armedTranscript(sb, [fa], { extraLines: [legLine('m7'), legLine('m8'), legLine('m9')] });
    render(sb, SID, t);
    assert.ok(entryFor(dialoguesOf(rollupOf(sb)), fa));
    const shorter = [legLine('n1'), toolLine('n1', psWatch(fb, 'Api-Claude'))].join('\n') + '\n';
    assert.ok(Buffer.byteLength(shorter) < statSync(t).size, 'precondition: the rewrite is shorter than the offset');
    writeFileSync(t, shorter, 'utf8');
    render(sb, SID, t);
    const entries = dialoguesOf(rollupOf(sb));
    assert.equal(entries.length, 1, `only the rescanned arm remains: ${JSON.stringify(entries)}`);
    assert.ok(entryFor(entries, fb));
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('R-5 — legscan.jsonl with watch lines injected on repeated-id lines banks leg arrays deep-equal to legscan.jsonl alone', () => {
  const sb = sandbox();
  try {
    const base = readFileSync(join(REPO, 'tests', 'fixtures', 'legscan.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
    const tPlain = writeTranscript(sb, 'plain-1', base, 'plain.jsonl');
    const injected = [];
    let n = 0;
    for (const l of base) {
      injected.push(l);
      let p; try { p = JSON.parse(l); } catch { continue; }
      if (p.type === 'assistant' && p.message && p.message.id) {
        injected.push(toolLine(p.message.id, psWatch(join(sb.files, `inj${n++}-dialogue.md`), 'Api-Claude'), { usage: p.message.usage }));
      }
    }
    assert.ok(n >= 3, `vacuity: watches injected on ${n} lines`);
    const tInj = writeTranscript(sb, 'inj-1', injected, 'inj.jsonl');
    render(sb, 'plain-1', tPlain);
    render(sb, 'inj-1', tInj);
    const a = rollupOf(sb, 'plain-1'), b = rollupOf(sb, 'inj-1');
    for (const k of [...LEG_ARRAYS, 'nLegs', 'sumUnits', 'sumOutputTokens', 'nColdLegs', 'coldWastedUnits']) {
      assert.deepEqual(b[k], a[k], `${k}: the leg scan's results do not change (spec §3)`);
    }
    assert.equal(dialoguesOf(b).length, n, 'and every injected arm is a dialogue');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('R-6 — a session with no watch command, rendered three times with the probe NOT off: no state file, no guard, no probe started', () => {
  const sb = sandbox();
  try {
    const log = join(sb.root, 'stub.log');
    const t = writeTranscript(sb, SID, [legLine('m1'), legLine('m2')]);
    for (let i = 0; i < 3; i++) render(sb, SID, t, { env: stubEnv(log) });
    assert.equal(existsSync(sb.statePath(SID)), false, `${SID}.dialogues.json must not exist`);
    assert.equal(existsSync(sb.guardPath(SID)), false, `${SID}.dialogue-probe.json must not exist`);
    assert.deepEqual(stubStarts(log), [], 'the stub probe was never started');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

// =================================================================================================
// State and probe — spec §4, §14.4, §14.5. The probe runs as `--probe <rollup> <state>` in a child.
// =================================================================================================

test('Q-1 — tail classifier: CLOSED with blanks/CRLF/BOM, a baton line is open, a 64 KB last line is read whole, a multibyte tail is intact', () => {
  const sb = sandbox();
  try {
    const closedLf = placeFixture(sb, 'closed-dialogue.md');
    const closedCrlf = placeFixture(sb, 'crlf-bom-trailing-blank-dialogue.md', { crlf: true, bom: true });
    writeFileSync(closedCrlf, readFileSync(closedCrlf, 'utf8') + '\r\n\r\n   \r\n');   // trailing blank lines
    const baton = placeFixture(sb, 'baton-to-other-dialogue.md');
    const bigClosed = join(sb.files, 'big-closed-dialogue.md');
    // DIALOGUE CLOSED sits at the START of a 64 KB last line: a reader that cut the line at its tail
    // window would see only `x`s and call the dialogue open.
    writeFileSync(bigClosed, fixtureText('baton-to-other-dialogue.md') + '\n' + CLOSE_LINE + ' ' + 'x'.repeat(65536) + '\n');
    const bigLine = 'y'.repeat(65536);
    const bigOpen = join(sb.files, 'big-open-dialogue.md');
    writeFileSync(bigOpen, fixtureText('baton-to-other-dialogue.md') + '\n' + bigLine + '\n');
    const mbLast = '— Web-Claude · END OF TURN · BATON → Api-Claude';
    const mb = join(sb.files, 'multibyte-dialogue.md');
    writeFileSync(mb, ('→·€𝄞 ').repeat(40000) + '\n\n' + mbLast + '\n');

    const r = armedRollup(sb, [closedLf, closedCrlf, baton, bigClosed, bigOpen, mb]);
    const res = probe(sb, r);
    assert.equal(res.status, 0, `the probe exits 0: ${res.stderr}`);
    const st = readJson(r.state);
    const s = (f) => stateEntry(st, f);
    assert.equal(s(closedLf)?.state, 'closed', 'LF close line');
    assert.equal(s(closedCrlf)?.state, 'closed', 'CRLF + BOM + trailing blank lines: still closed');
    assert.equal(s(baton)?.state, 'open', 'a baton line is open');
    assert.equal(s(baton)?.lastLine, '— Api-Claude · END OF TURN · BATON → Web-Claude', 'lastLine is the last non-empty line, no line ending');
    assert.equal(s(bigClosed)?.state, 'closed', 'a 64 KB last line is read whole, not cut at the tail window');
    assert.equal(s(bigOpen)?.state, 'open');
    assert.equal(s(bigOpen)?.lastLine, bigLine, 'the 64 KB last line is stored intact');
    assert.equal(s(mb)?.lastLine, mbLast, 'a tail window that starts inside a multibyte character leaves the last line intact');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('Q-2 — ENOENT is `missing`; a directory at the path is `unreadable`; lastLine is null for both', () => {
  const sb = sandbox();
  try {
    const gone = join(sb.files, 'gone-dialogue.md');
    const dir = join(sb.files, 'dir-dialogue.md');
    mkdirSync(dir);
    const r = armedRollup(sb, [gone, dir]);
    assert.equal(probe(sb, r).status, 0);
    const st = readJson(r.state);
    assert.equal(stateEntry(st, gone)?.state, 'missing');
    assert.equal(stateEntry(st, gone)?.lastLine, null);
    assert.equal(stateEntry(st, dir)?.state, 'unreadable');
    assert.equal(stateEntry(st, dir)?.lastLine, null);
    assert.equal(existsSync(gone), false, 'the probe never creates a dialogue file');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('Q-2b — a file the process may not read is `unreadable` (posix permissions)', { skip: process.platform === 'win32' ? 'Windows: no chmod-based read denial; the directory case of Q-2 covers the other-error branch there' : false }, () => {
  const sb = sandbox();
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md', { as: 'noread-dialogue.md' });
    chmodSync(f, 0o000);
    const r = armedRollup(sb, [f]);
    assert.equal(probe(sb, r).status, 0);
    const e = stateEntry(readJson(r.state), f);
    chmodSync(f, 0o644);
    assert.equal(e?.state, 'unreadable');
    assert.equal(e?.lastLine, null);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('Q-3 — a hanging path is `unreadable` within the per-file limit; five at once still end by the hard deadline with the state written; the guard is left alone', { skip: noOfflineHang() }, async () => {
  const sb = sandbox();
  const hangs = [];
  try {
    hangs.push(await hangingPath(sb.files, 'h0'));
    const r1 = armedRollup(sb, [hangs[0].path], { sid: 'q3-one' });
    // Per-file limit well below the deadline (and, on Windows, below the ~2 s an unanswered SMB open
    // takes to fail by itself): ending near the limit proves the limit, not the network, ended it.
    const one = probe(sb, r1, { CLAUDE_SL_DIALOGUE_FILE_MS: HANG_FILE_MS, CLAUDE_SL_DIALOGUE_DEADLINE_MS: 6000 });
    assert.equal(one.error, undefined, `probe did not finish: ${one.error}`);
    assertNearLimit(one.ms, HANG_FILE_MS, 'one hanging file ends at its per-file limit');
    assert.equal(stateEntry(readJson(r1.state), hangs[0].path)?.state, 'unreadable');

    for (let i = 1; i <= 5; i++) hangs.push(await hangingPath(sb.files, `h${i}`));
    const five = hangs.slice(1).map((h) => h.path);
    const r5 = armedRollup(sb, five, { sid: 'q3-five' });
    const guard = sb.guardPath('q3-five');
    const guardBody = JSON.stringify({ pid: null, startedAt: NOW });
    writeFileSync(guard, guardBody);
    // Five reads saturate libuv's default pool of four; the per-file limit is longer than the deadline,
    // so only the hard deadline can end this probe.
    const res = probe(sb, r5, { CLAUDE_SL_DIALOGUE_FILE_MS: 20000, CLAUDE_SL_DIALOGUE_DEADLINE_MS: 1000 });
    assert.equal(res.error, undefined, `probe did not finish: ${res.error}`);
    assertNearLimit(res.ms, 1000, 'five pending reads: the probe ends at its hard deadline');
    const st = readJsonOr(r5.state);
    assert.ok(st, 'the state file is written at the deadline');
    for (const p of five) assert.equal(stateEntry(st, p)?.state, 'unreadable', `${p} is unreadable`);
    assert.equal(readFileSync(guard, 'utf8'), guardBody, 'the probe never touches the guard');
  } finally {
    for (const h of hangs) await h.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test('Q-4 — closed is final: re-probing a closed entry over a hanging path ends at once, entry byte-equal; a missing file that appears is re-read and becomes open', async () => {
  const sb = sandbox();
  let hang = null;
  try {
    const f = placeFixture(sb, 'closed-dialogue.md', { as: 'final-dialogue.md' });
    const later = join(sb.files, 'later-dialogue.md');
    const r = armedRollup(sb, [f, later]);
    assert.equal(probe(sb, r).status, 0);
    const before = readJson(r.state);
    assert.equal(stateEntry(before, f)?.state, 'closed');
    assert.equal(stateEntry(before, later)?.state, 'missing');
    // Replace the closed file with something that would read differently: a FIFO with no writer on
    // posix (it would hang), a directory on Windows (it would be unreadable).
    rmSync(f);
    if (process.platform === 'win32') mkdirSync(f);
    else execFileSync('mkfifo', [f]);
    placeFixture(sb, 'baton-to-other-dialogue.md', { as: 'later-dialogue.md' });
    const res = probe(sb, r, { CLAUDE_SL_NOW_EPOCH: NOW + 600, CLAUDE_SL_DIALOGUE_FILE_MS: 3000, CLAUDE_SL_DIALOGUE_DEADLINE_MS: 6000 });
    assert.ok(res.ms < 2500, `nothing left to wait on: the closed entry is never read again (${res.ms} ms)`);
    const after = readJson(r.state);
    assert.deepEqual(stateEntry(after, f), stateEntry(before, f), 'the closed entry is carried forward byte-equal, checkedAt included');
    assert.equal(stateEntry(after, later)?.state, 'open', 'a missing file is re-read on every probe');
  } finally {
    if (hang) await hang.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test('Q-5 — the state write is atomic: no `.tmp.` file is left behind', () => {
  const sb = sandbox();
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md');
    const r = armedRollup(sb, [f]);
    assert.equal(probe(sb, r).status, 0);
    assert.ok(readJsonOr(r.state), 'vacuity: the state was written');
    assert.deepEqual(lsDir(sb.statsDir).filter((n) => n.includes('.tmp.')), [], 'no temp file left behind');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

// Needs a read that blocks INSIDE the probe: a FIFO with no writer on posix, an unanswered UNC open on
// Windows (it fails by itself after about 2 s, so the kill at 700 ms lands first).
test('Q-5b — a probe killed mid-run leaves the previous state intact', { skip: noOfflineHang() }, async () => {
  const sb = sandbox();
  let hang = null;
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md');
    const r = armedRollup(sb, [f]);
    assert.equal(probe(sb, r).status, 0);
    const prev = readFileSync(r.state);
    hang = await hangingPath(sb.files, 'kill');
    const r2 = armedRollup(sb, [f, hang.path]);
    const { child, done } = cliAsync(['--probe', r2.rollup, r2.state], { sb, env: { CLAUDE_SL_DIALOGUE_FILE_MS: 20000, CLAUDE_SL_DIALOGUE_DEADLINE_MS: 20000 } });
    await sleep(700);
    child.kill('SIGKILL');
    await done;
    assert.deepEqual(readFileSync(r2.state), prev, 'a killed probe leaves the previous state byte-intact');
  } finally {
    if (hang) await hang.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test('Q-6 — the state file has the §4 shape; an unknown extra key changes nothing the status line renders', () => {
  const sb = sandbox();
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md');
    const r = armedRollup(sb, [f]);
    assert.equal(probe(sb, r).status, 0);
    const st = readJson(r.state);
    assert.equal(st.v, 1);
    assert.equal(typeof st.checkedAt, 'number');
    assert.equal(typeof st.dialogues, 'object');
    assert.deepEqual(Object.keys(st.dialogues), [keyOf(f)], 'keyed by the item-1 key');
    const e = st.dialogues[keyOf(f)];
    assert.deepEqual(Object.keys(e).sort(), ['checkedAt', 'file', 'lastLine', 'state'], 'each entry holds file, state, lastLine and checkedAt');
    assert.equal(e.file, f);
    const a = render(sb, SID, r.transcript);
    st.zzzUnknown = { any: 1 };
    st.dialogues[keyOf(f)].zzzUnknown = true;
    writeFileSync(r.state, JSON.stringify(st));
    const b = render(sb, SID, r.transcript);
    assert.equal(b, a, 'readers ignore keys they do not know');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

async function noDialogueMedian(sb) {
  const tNone = writeTranscript(sb, 'q7-none', [legLine('m1'), legLine('m2')]);
  const base = [];
  for (let i = 0; i < 5; i++) base.push((await renderAsync(sb, 'q7-none', tNone)).ms);
  base.sort((x, y) => x - y);
  return base[2];
}

test('Q-7 — a render never waits for the process it starts: closed (stdout ended, process exited) within the no-dialogue spread while that process still runs (B0 Part 1)', async () => {
  // The started process is the stub, sleeping well past any render: it is spawned by the SAME call
  // as the real probe, so a spawn that let the child inherit the host's stdout fails here on every OS.
  const sb = sandbox();
  try {
    const median = await noDialogueMedian(sb);
    const f = placeFixture(sb, 'baton-to-other-dialogue.md');
    const t = armedTranscript(sb, [f], { sid: 'q7-stub' });
    const log = join(sb.root, 'stub.log');
    const run = await renderAsync(sb, 'q7-stub', t, { env: stubEnv(log, 120000) });
    const starts = await waitStarts(log);
    assert.equal(starts.length, 1, 'the render started its probe');
    sb.pids.push(starts[0].pid);
    assert.ok(pidAlive(starts[0].pid), 'the started process is still running after the render closed');
    assert.ok(run.ms <= median + 1500, `render ${run.ms.toFixed(0)} ms vs no-dialogue median ${median.toFixed(0)} ms — the render must not wait for its probe`);
    assert.match(strip(run.stdout), /bsl\d/, 'stdout was complete at close');
  } finally { await sb.cleanup(); }
});

test('Q-7b — the same with the REAL probe on a hanging path (posix FIFO, Windows unanswered UNC)', { skip: noOfflineHang() }, async () => {
  const sb = sandbox();
  let hang = null;
  try {
    const median = await noDialogueMedian(sb);
    hang = await hangingPath(sb.files, 'q7');
    const t = writeTranscript(sb, 'q7-hang', [legLine('m1'), toolLine('m1', psWatch(hang.path, 'Api-Claude'))]);
    const env = { CLAUDE_SL_DIALOGUE_PROBE: undefined, CLAUDE_SL_DIALOGUE_FILE_MS: 1200, CLAUDE_SL_DIALOGUE_DEADLINE_MS: 1500 };
    const run = await renderAsync(sb, 'q7-hang', t, { env });
    const pid = await guardPid(sb, 'q7-hang');
    assert.ok(pid, 'the render claimed the guard and recorded the probe pid');
    assert.ok(pidAlive(pid), 'the probe is still running when the render has already closed');
    assert.ok(run.ms <= median + 1500, `render ${run.ms.toFixed(0)} ms vs no-dialogue median ${median.toFixed(0)} ms — the render must not wait for its probe`);
    assert.match(strip(run.stdout), /bsl\d/, 'stdout was complete at close');
  } finally {
    for (const pid of sb.pids) await waitProbeExit(pid, 30000);
    if (hang) await hang.close();
    await sb.cleanup();
  }
});

test('Q-8 — under CLAUDE_SL_NOW_EPOCH the probe stamps both checkedAt fields with the frozen epoch; an entry younger than the interval starts no probe', async () => {
  const sb = sandbox();
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md');
    const r = armedRollup(sb, [f]);
    assert.equal(probe(sb, r, { CLAUDE_SL_NOW_EPOCH: NOW + 7 }).status, 0);
    const st = readJson(r.state);
    assert.equal(st.checkedAt, NOW + 7, 'top-level checkedAt is the frozen epoch');
    assert.equal(stateEntry(st, f).checkedAt, NOW + 7, 'the entry\'s checkedAt is the frozen epoch');

    const log = join(sb.root, 'stub.log');
    // Younger than the interval by the frozen clock → no probe.
    render(sb, SID, r.transcript, { env: { ...stubEnv(log), CLAUDE_SL_NOW_EPOCH: NOW + 7 + 20, CLAUDE_SL_DIALOGUE_INTERVAL_SEC: 60 } });
    await sleep(400);
    assert.deepEqual(stubStarts(log), [], 'an entry younger than the interval starts no probe');
    // Vacuity: older than the interval by the same clock → one start.
    render(sb, SID, r.transcript, { env: { ...stubEnv(log), CLAUDE_SL_NOW_EPOCH: NOW + 7 + 120, CLAUDE_SL_DIALOGUE_INTERVAL_SEC: 60 } });
    const starts = await waitStarts(log);
    assert.equal(starts.length, 1, 'an entry older than the interval starts one');
    sb.pids.push(starts[0].pid);
  } finally { await sb.cleanup(); }
});

test('Q-10 — four constants are named at the top of open-dialogues.mjs; the docs name them and the overrides, never their values', () => {
  const src = MOD_SRC();
  const head = src.slice(0, src.search(/^(export\s+)?(async\s+)?function\b/m));
  const consts = [...head.matchAll(/^(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*([0-9][0-9_]*(?:\s*\*\s*[0-9_]+)*)\s*;/gm)].map((m) => m[1]);
  assert.ok(consts.length >= 4, `the probe interval, the per-file limit, the hard deadline and the pid-reuse window are numeric constants before the first function: saw ${consts.join(', ')}`);
  const OVERRIDES = ['CLAUDE_SL_DIALOGUE_PROBE', 'CLAUDE_SL_DIALOGUE_INTERVAL_SEC', 'CLAUDE_SL_DIALOGUE_FILE_MS',
    'CLAUDE_SL_DIALOGUE_DEADLINE_MS', 'CLAUDE_SL_DIALOGUE_REUSE_SEC', 'CLAUDE_SL_DIALOGUE_CLOSE_DELAY_MS'];
  for (const o of OVERRIDES) assert.ok(src.includes(o) || readFileSync(ENGINE, 'utf8').includes(o), `${o} is read by the cluster`);
  // The doc rows are private-repo files; in the kit the generated docs are checked by the export rows.
  const docs = ['status-line.md', 'dialogue.md', 'handover.md'].map((n) => join(REPO, 'docs', n));
  const kit = !existsSync(join(REPO, 'tools', 'export-public.mjs'));
  if (kit) return;
  const sl = readFileSync(docs[0], 'utf8');
  for (const c of consts.slice(0, 4)) assert.ok(sl.includes(c), `docs/status-line.md names the constant ${c}`);
  for (const o of OVERRIDES) assert.ok(sl.includes(o), `docs/status-line.md names the override ${o}`);
  const VALUE = /\b\d+(?:\.\d+)?\s*-?\s*(?:ms|s|sec|secs|seconds?|minutes?|mins?)\b/i;
  for (const d of docs) {
    readFileSync(d, 'utf8').split('\n').forEach((line, i) => {
      if (![...consts, ...OVERRIDES].some((n) => line.includes(n))) return;
      assert.ok(!VALUE.test(line), `${d}:${i + 1} states a value beside a constant or override (CLAUDE.md "Never write a measured constant into prose"): ${line.trim()}`);
    });
  }
});

test('Q-11 — open-dialogues.mjs uses no API newer than Node 18', () => {
  const src = MOD_SRC();
  for (const api of ['AbortSignal.any', 'fs.glob', 'Promise.withResolvers', 'import.meta.dirname', 'import.meta.filename', 'process.getBuiltinModule', 'Array.fromAsync']) {
    assert.ok(!src.includes(api), `${api} is newer than Node 18 — the public CI runs Node 18`);
  }
  assert.ok(!/import\s*\{[^}]*\bglob(Sync)?\b[^}]*\}\s*from\s*['"]node:fs/.test(src), 'no glob / globSync import from node:fs (Node 22)');
});

// =================================================================================================
// The guard and the test seams — spec §4, §14.9. A stub probe logs its start; like the real probe it
// never touches the guard.
// =================================================================================================

function guardRig(prefix) {
  const sb = sandbox(prefix);
  const f = placeFixture(sb, 'baton-to-other-dialogue.md');
  const t = armedTranscript(sb, [f]);
  const log = join(sb.root, 'stub.log');
  return { sb, f, t, log };
}

test('G-1 — CLAUDE_SL_DIALOGUE_PROBE=off with a stale seeded state: no guard, nothing spawned, the chip still reflects the state', () => {
  const { sb, f, t } = guardRig('g1');
  try {
    mkdirSync(sb.statsDir, { recursive: true });
    const seeded = JSON.stringify({ v: 1, checkedAt: NOW - 3600, dialogues: { [keyOf(f)]: { file: f, state: 'unreadable', lastLine: null, checkedAt: NOW - 3600 } } });
    writeFileSync(sb.statePath(SID), seeded);
    const out = strip(render(sb, SID, t));
    assert.equal(existsSync(sb.guardPath(SID)), false, 'no guard file appears');
    assert.equal(readFileSync(sb.statePath(SID), 'utf8'), seeded, 'nothing rewrote the state: no probe ran');
    assert.ok(out.includes('1 dialogue open'), `the chip reads the seeded state: ${out}`);
    assert.ok(out.includes('(1 unreadable)'), 'and names it unreadable');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('G-2 — a stub path is started with the rollup stats path and the state path, and the guard is rewritten with its pid', async () => {
  const { sb, t, log } = guardRig('g2');
  try {
    render(sb, SID, t, { env: stubEnv(log) });
    const starts = await waitStarts(log);
    assert.equal(starts.length, 1, 'one start');
    sb.pids.push(starts[0].pid);
    assert.deepEqual(starts[0].argv.map(keyOf), [sb.rollupPath(SID), sb.statePath(SID)].map(keyOf), 'the two arguments');
    const g = readJson(sb.guardPath(SID));
    assert.equal(g.pid, starts[0].pid, 'the guard holds the stub\'s pid');
    assert.equal(typeof g.startedAt, 'number');
  } finally { await sb.cleanup(); }
});

test('G-3 — two renders at the same moment start exactly one probe; twenty more while it sleeps start none', async () => {
  const { sb, t, log } = guardRig('g3');
  try {
    // The stub outlives every render below by a wide margin even on a loaded CI runner, then is killed.
    const env = stubEnv(log, 120000);
    await Promise.all([renderAsync(sb, SID, t, { env }), renderAsync(sb, SID, t, { env })]);
    await waitStarts(log);
    await sleep(300);   // room for a second start, which would be the defect
    assert.equal(stubStarts(log).length, 1, 'the exclusive create admits one render');
    for (let i = 0; i < 20; i++) render(sb, SID, t, { env });
    await sleep(200);
    const starts = stubStarts(log);
    assert.equal(starts.length, 1, 'a live guard blocks every later start');
    try { process.kill(starts[0].pid); } catch {}
    sb.pids.push(starts[0].pid);
  } finally { await sb.cleanup(); }
});

test('G-4 — guard outcomes: two live cases start nothing; three stale cases replace the guard and start one probe', async () => {
  const dead = deadPid();
  const cases = [
    { name: 'pid null, startedAt within one interval', guard: { pid: null, startedAt: NOW - 5 }, starts: 0 },
    { name: 'live pid, startedAt within the reuse window', guard: { pid: process.pid, startedAt: NOW - 60 }, starts: 0 },
    { name: 'pid null, startedAt older than one interval', guard: { pid: null, startedAt: NOW - 120 }, starts: 1 },
    { name: 'dead pid', guard: { pid: dead, startedAt: NOW - 5 }, starts: 1 },
    { name: 'live pid, startedAt older than the reuse window', guard: { pid: process.pid, startedAt: NOW - 1200 }, starts: 1 },
  ];
  for (const c of cases) {
    const { sb, t, log } = guardRig('g4');
    try {
      mkdirSync(sb.statsDir, { recursive: true });
      const body = JSON.stringify(c.guard);
      writeFileSync(sb.guardPath(SID), body);
      render(sb, SID, t, { env: { ...stubEnv(log), CLAUDE_SL_DIALOGUE_INTERVAL_SEC: 30, CLAUDE_SL_DIALOGUE_REUSE_SEC: 600 } });
      if (c.starts) await waitStarts(log, c.starts); else await sleep(300);
      const starts = stubStarts(log);
      assert.equal(starts.length, c.starts, `${c.name}: ${c.starts ? 'stale → one start' : 'live → nothing starts'}`);
      if (c.starts) {
        sb.pids.push(starts[0].pid);
        assert.equal(readJson(sb.guardPath(SID)).pid, starts[0].pid, `${c.name}: the replaced guard holds the new stub's pid`);
      } else {
        assert.equal(readFileSync(sb.guardPath(SID), 'utf8'), body, `${c.name}: a live guard is left as it is`);
      }
    } finally { await sb.cleanup(); }
  }
});

test('G-5 — the probe never deletes its guard after a normal finish; the next render finds the pid dead and starts one', async () => {
  await guardOutlivesProbe('normal');
});

test('G-5d — the same after a probe ends at its hard deadline', { skip: noOfflineHang() }, async () => {
  await guardOutlivesProbe('deadline');
});

// G-5d's proof that the hard deadline, not the network, ended the probe. It times the probe's OWN
// run: from the moment its node process is running (a preload logs it, before the module loads) to
// the moment it wrote its state (the state file's modification time). Node start-up and the render
// are outside that span, so a loaded machine does not stretch it. The network is the bound's
// opponent: on Windows an unanswered SMB open gives up by itself after about 2 s at the soonest,
// a FIFO never does, and the per-file limit is set far beyond both. So a span inside
// [deadline, deadline + margin) can only have been ended by the deadline.
const G5D_DEADLINE_MS = 800;
const G5D_MARGIN_MS = 1000;   // the module load and the state write; stays under the network's ~2 s
function probeStartLog(sb) {
  const pre = join(sb.root, 'probe-start.cjs');
  const log = join(sb.root, 'probe-start.log');
  writeFileSync(pre, "if (process.argv.includes('--probe')) require('fs').appendFileSync("
    + `${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, t: Date.now() }) + '\\n');\n`);
  return {
    // Forward slashes: inside NODE_OPTIONS' double quotes a backslash is an escape.
    env: { NODE_OPTIONS: `--require "${pre.replace(/\\/g, '/')}"` },
    at: (pid) => {
      let lines = [];
      try { lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
      const hit = lines.find((x) => x.pid === pid);
      return hit ? hit.t : null;
    },
  };
}
function probeSpanMs(startMs, statePath) {
  assert.ok(Number.isFinite(startMs), 'the probe logged the moment it was running (NODE_OPTIONS preload)');
  assert.ok(existsSync(statePath), 'the probe wrote its state');
  return Math.round(statSync(statePath).mtimeMs - startMs);
}
const G5D_ATTEMPTS = 3;

async function guardOutlivesProbe(variant) {
  // A TEST-NET address that failed once fails at once for a while after (Windows caches the failure),
  // and another run may have used it: then the path does not hang and the row would test nothing. So
  // the deadline variant takes a fresh address when its span shows no hang, up to G5D_ATTEMPTS times,
  // and only the last attempt reports it. A span past the bound is never retried.
  for (let attempt = 1; attempt <= G5D_ATTEMPTS; attempt++) {
    if (await guardOutlivesProbeOnce(variant, attempt === G5D_ATTEMPTS) !== 'no-hang') return;
  }
}

async function guardOutlivesProbeOnce(variant, lastAttempt) {
  {
    const { sb, t: tLocal, log } = guardRig('g5');
    let hang = null;
    try {
      let t = tLocal;
      if (variant === 'deadline') {
        hang = await hangingPath(sb.files, 'g5');
        t = writeTranscript(sb, SID, [legLine('m1'), toolLine('m1', psWatch(hang.path, 'Api-Claude'))]);
      }
      // The deadline variant: the per-file limit is set far past the deadline and past the network's
      // own give-up, so only the deadline can end the read inside the bound checked below.
      const started = variant === 'deadline' ? probeStartLog(sb) : null;
      const limits = started
        ? { CLAUDE_SL_DIALOGUE_FILE_MS: 30000, CLAUDE_SL_DIALOGUE_DEADLINE_MS: G5D_DEADLINE_MS, ...started.env }
        : { CLAUDE_SL_DIALOGUE_FILE_MS: 1500, CLAUDE_SL_DIALOGUE_DEADLINE_MS: 800 };
      render(sb, SID, t, { env: { CLAUDE_SL_DIALOGUE_PROBE: undefined, ...limits } });
      const pid = await guardPid(sb, SID);
      assert.ok(pid, `${variant}: the guard records the probe pid`);
      assert.ok(await waitProbeExit(pid, 40000), `${variant}: the probe exits`);
      if (started) {
        const ms = probeSpanMs(started.at(pid), sb.statePath(SID));
        if (ms < G5D_DEADLINE_MS && !lastAttempt) return 'no-hang';
        assert.ok(ms >= G5D_DEADLINE_MS, `the probe wrote its state ${ms} ms after it was running, before its ${G5D_DEADLINE_MS} ms deadline, on ${G5D_ATTEMPTS} fresh paths — no path hung, so the row tested nothing`);
        assert.ok(ms < G5D_DEADLINE_MS + G5D_MARGIN_MS, `the probe wrote its state ${ms} ms after it was running, past its ${G5D_DEADLINE_MS} ms deadline + ${G5D_MARGIN_MS} ms — the deadline did not end it`);
      }
      assert.ok(existsSync(sb.guardPath(SID)), `${variant}: the guard is still on disk after the probe exited`);
      assert.equal(readJson(sb.guardPath(SID)).pid, pid, `${variant}: with that probe's pid`);
      assert.ok(readJsonOr(sb.statePath(SID)), `${variant}: the probe wrote its state`);
      render(sb, SID, t, { env: { ...stubEnv(log), CLAUDE_SL_NOW_EPOCH: NOW + 3600 } });
      const starts = await waitStarts(log);
      assert.equal(starts.length, 1, `${variant}: the next render that needs a probe replaces the dead guard and starts one`);
      sb.pids.push(starts[0].pid);
      assert.equal(readJson(sb.guardPath(SID)).pid, starts[0].pid);
    } finally {
      for (const p of sb.pids) await waitProbeExit(p, 20000);
      if (hang) await hang.close();
      await sb.cleanup();
    }
  }
}

test('G-5c — a probe still alive past its own deadline keeps its guard live: renders during that span start nothing (offline half of B0)', async () => {
  // The lingering probe is played by the stub, which outlives every deadline: on Windows a probe
  // blocked in an SMB open can outlive its exit call, and no offline path reproduces that.
  const { sb, t, log } = guardRig('g5c');
  try {
    render(sb, SID, t, { env: stubEnv(log, 120000) });
    const first = await waitStarts(log);
    assert.equal(first.length, 1);
    sb.pids.push(first[0].pid);
    for (const dt of [60, 120, 300]) {
      render(sb, SID, t, { env: { ...stubEnv(log, 120000), CLAUDE_SL_NOW_EPOCH: NOW + dt, CLAUDE_SL_DIALOGUE_DEADLINE_MS: 500 } });
    }
    await sleep(200);
    assert.equal(stubStarts(log).length, 1, 'past its deadline and its interval, a live pid within the reuse window still holds the guard');
    try { process.kill(first[0].pid); } catch {}
  } finally { await sb.cleanup(); }
});

test('G-6 — CLAUDE_SL_DIALOGUE_PROBE set to a relative path or a missing file starts the DEFAULT probe', async () => {
  for (const bad of ['tests/fixtures/open-dialogues/stub-probe.mjs', join(REPO, 'tests', 'fixtures', 'open-dialogues', 'no-such-probe.mjs')]) {
    const { sb, f, t, log } = guardRig('g6');
    try {
      render(sb, SID, t, { env: { CLAUDE_SL_DIALOGUE_PROBE: bad, STUB_PROBE_LOG: log, ...FAST_LIMITS } });
      const pid = await guardPid(sb, SID);
      assert.ok(pid, `${bad}: a probe was started`);
      await waitProbeExit(pid, 20000);
      assert.deepEqual(stubStarts(log), [], `${bad}: never the stub`);
      assert.equal(stateEntry(readJsonOr(sb.statePath(SID)), f)?.state, 'open', `${bad}: the real probe classified the dialogue`);
    } finally { await sb.cleanup(); }
  }
});

test('G-6b — each CLAUDE_SL_DIALOGUE_* limit, unset or invalid (`abc`, `-1`, empty), resolves to its constant; a valid one replaces it', async () => {
  const mod = await import(pathToFileURL(MODULE).href);
  assert.equal(typeof mod.resolveLimits, 'function', 'the module exports its override resolution');
  const dflt = mod.resolveLimits({});
  const VARS = {
    CLAUDE_SL_DIALOGUE_INTERVAL_SEC: 'intervalSec', CLAUDE_SL_DIALOGUE_FILE_MS: 'fileMs',
    CLAUDE_SL_DIALOGUE_DEADLINE_MS: 'deadlineMs', CLAUDE_SL_DIALOGUE_REUSE_SEC: 'reuseSec',
  };
  const CONST = { intervalSec: mod.PROBE_INTERVAL_SEC, fileMs: mod.FILE_TIMEOUT_MS, deadlineMs: mod.PROBE_DEADLINE_MS, reuseSec: mod.PID_REUSE_SEC };
  for (const [v, k] of Object.entries(VARS)) {
    assert.equal(typeof CONST[k], 'number', `${k}'s constant is exported`);
    assert.equal(dflt[k], CONST[k], `${v} unset → the constant`);
    for (const bad of ['abc', '-1', '', '   ']) assert.equal(mod.resolveLimits({ [v]: bad })[k], CONST[k], `${v}=${JSON.stringify(bad)} → the constant`);
    assert.equal(mod.resolveLimits({ [v]: '123' })[k], 123, `${v}=123 replaces the constant`);
  }
  assert.equal(dflt.closeDelayMs, 0, 'the close delay defaults to 0');
  assert.equal(mod.resolveLimits({ CLAUDE_SL_DIALOGUE_CLOSE_DELAY_MS: 'abc' }).closeDelayMs, 0);
  assert.equal(mod.resolveLimits({ CLAUDE_SL_DIALOGUE_CLOSE_DELAY_MS: '400' }).closeDelayMs, 400);
});

test('G-5b — a spawn that fails leaves no guard behind (source guard: no offline way makes spawning node itself fail)', () => {
  // The plan's behavioural form needs a spawn that throws; the engine spawns process.execPath, which
  // always exists, and the spec defines no seam to make it throw. So the two halves are pinned in the
  // source: the spawn sits in a try, and a failed spawn (a throw, or a child with no pid) unlinks the guard.
  const src = readFileSync(ENGINE, 'utf8');
  const at = src.indexOf('spawn(process.execPath');
  assert.ok(at > 0, 'the probe is spawned with process.execPath');
  const around = src.slice(Math.max(0, at - 400), at + 600);
  assert.match(around, /try\s*\{[^}]*spawn\(process\.execPath/, 'the spawn sits inside a try');
  assert.match(around, /if\s*\(\s*!child\s*\|\|\s*!child\.pid\s*\)\s*\{[^}]*unlinkSync\(guardPath\)/, 'a spawn with no child or no pid deletes the guard at once');
});

test('G-7 — every file under tests/ and tools/parity/ that runs statusline.mjs in a temp dir sets CLAUDE_SL_DIALOGUE_PROBE', () => {
  const dirs = [join(REPO, 'tests'), join(REPO, 'tools', 'parity')];
  const spawners = [];
  for (const d of dirs) {
    for (const n of readdirSync(d).filter((x) => x.endsWith('.mjs')).sort()) {
      const text = readFileSync(join(d, n), 'utf8');
      // Names bound to a path that ends in statusline.mjs, then a child-process call that runs one.
      const names = [...text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*['"`]statusline\.mjs['"`]/g)].map((m) => m[1]);
      const runs = names.some((v) => new RegExp(`(?:execFileSync|execFile|spawnSync|spawn)\\(\\s*process\\.execPath\\s*,\\s*\\[\\s*${v}\\b`).test(text))
        || /(?:execFileSync|execFile|spawnSync|spawn)\(\s*process\.execPath\s*,\s*\[\s*join\([^\]]*['"`]statusline\.mjs['"`]/.test(text);
      if (runs && /mkdtemp/.test(text)) spawners.push({ file: `${d === dirs[0] ? 'tests' : 'tools/parity'}/${n}`, text });
    }
  }
  assert.ok(spawners.length >= 6, `vacuity: the scan found ${spawners.length} engine-running files`);
  // Exempt by name, with the reason checked rather than trusted. config-home.test.mjs is frozen by
  // launcher-color-mod.test.mjs K12 (byte-unchanged against env a14b66f), so it cannot take the env
  // line. It never arms a watch, and a session with no dialogue starts no probe (spec §4, pinned by
  // R-6) — so the exemption holds only while the file contains no watch command text at all.
  const EXEMPT = { 'tests/config-home.test.mjs': 'frozen by launcher-color-mod K12; arms no watch, so no probe can start' };
  for (const s of spawners.filter((x) => EXEMPT[x.file])) {
    assert.ok(!/\$me = |\bme=\\?"|<DIALOGUE_FILE>|psWatch|bashWatch/.test(s.text),
      `${s.file} is exempt only because it arms no dialogue watch (${EXEMPT[s.file]}); it now carries watch text, so it must set CLAUDE_SL_DIALOGUE_PROBE=off`);
  }
  const missing = spawners.filter((s) => !EXEMPT[s.file] && !s.text.includes('CLAUDE_SL_DIALOGUE_PROBE')).map((s) => s.file);
  assert.deepEqual(missing, [], 'spec §4: a harness that renders in a temp dir it deletes sets CLAUDE_SL_DIALOGUE_PROBE=off (or waits for the recorded probe pid)');
});

// =================================================================================================
// `--session` — spec §6 step 1, §14.7
// =================================================================================================

function sessionRig(fixtures, { sid = 'sess-s', label = 'Api-Claude' } = {}) {
  const sb = sandbox('sess');
  const files = fixtures.map((n) => (n.startsWith('/') || /^[A-Za-z]:|^\\\\/.test(n) ? n : placeFixture(sb, n)));
  const lines = [];
  files.forEach((f, i) => { lines.push(legLine(`s${i}`)); lines.push(toolLine(`s${i}`, psWatch(f, label))); });
  placeSessionTranscript(sb, sid, lines);
  const run = (env = {}, timeout = 20000) => {
    const r = cli(['--session', '--json'], { sb, env: { CLAUDE_CODE_SESSION_ID: sid, ...FAST_LIMITS, ...env }, timeout });
    assert.equal(r.error, undefined, `--session did not exit within ${timeout} ms (stdout so far: ${r.stdout.slice(0, 200)}): ${r.error}`);
    // The printed JSON is the result. With a read still pending the CLI writes it and then kills its
    // own process (status 1 on Windows, a signal elsewhere), so the status is not part of the contract.
    assert.ok(r.status === 0 || r.status === 1 || r.signal === 'SIGKILL', `--session ended abnormally: status ${r.status}, signal ${r.signal}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  return { sb, files, run, sid };
}
const byFile = (out, f) => out.dialogues.find((d) => keyOf(d.file) === keyOf(f));

test('S-1 — a ratified dialogue okayed in the file: every field, ratifiedText and afterRatifyText byte-exact', () => {
  const { sb, files, run, sid } = sessionRig(['ratified-okayed-in-file-dialogue.md']);
  try {
    const out = run();
    assert.equal(out.session, sid);
    const d = byFile(out, files[0]);
    assert.ok(d, JSON.stringify(out));
    const text = fixtureText('ratified-okayed-in-file-dialogue.md');
    assert.equal(d.name, 'ratified-okayed-in-file', 'name: no `.md`, no trailing `-dialogue`');
    assert.equal(d.label, 'Api-Claude');
    assert.equal(d.otherLabel, 'Web-Claude', 'from the Parties: line');
    assert.equal(d.state, 'open');
    assert.equal(d.lastLine, '— Web-Claude · END OF TURN · BATON → CONVENER');
    assert.equal(d.lastTurn, 'Turn 7 — Web-Claude');
    assert.equal(d.ratifiedTurn, 5);
    const start = text.indexOf('## Turn 5 — Api-Claude');
    const batonLine = '— Api-Claude · END OF TURN · RATIFY CONSENSUS · ACCOUNTABLE → Api-Claude · BATON → CONVENER';
    const end = text.indexOf(batonLine) + batonLine.length;
    // Header through baton line. The spec leaves the baton line's own line ending unassigned, so it
    // may close ratifiedText or sit between the two fields; nothing else may.
    assert.equal(d.ratifiedText.replace(/\r?\n$/, ''), text.slice(start, end), 'ratifiedText is Turn 5, header to baton line');
    const rest = text.slice(start + d.ratifiedText.length);
    assert.ok(d.afterRatifyText === rest || d.afterRatifyText === rest.replace(/^\r?\n/, ''),
      `afterRatifyText is everything after Turn 5's baton line, verbatim: ${JSON.stringify(d.afterRatifyText.slice(0, 40))}`);
    assert.ok(d.afterRatifyText.includes('## Turn 6 — CONVENER') && d.afterRatifyText.includes('## Turn 7 — Web-Claude'));
    assert.equal(d.command, psWatch(files[0], 'Api-Claude'), 'command is the exact watch command');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-2 — a deferred dialogue: no ratified fields; lastLine is the defer baton', () => {
  const { sb, files, run } = sessionRig(['deferred-dialogue.md']);
  try {
    const d = byFile(run(), files[0]);
    assert.equal(d.ratifiedTurn, null);
    assert.equal(d.ratifiedText, null);
    assert.equal(d.afterRatifyText, null);
    assert.equal(d.lastLine, '— Api-Claude · END OF TURN · DEFER TO CONVENER · ACCOUNTABLE → Api-Claude · BATON → CONVENER');
    assert.equal(d.lastTurn, 'Turn 3 — Api-Claude');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-3 — a dialogue mid-turn: lastLine is the prose line, state open', () => {
  const { sb, files, run } = sessionRig(['midturn-dialogue.md']);
  try {
    const d = byFile(run(), files[0]);
    assert.equal(d.state, 'open');
    assert.equal(d.lastLine, 'A fixed ceiling starves the large runs. I am still measuring the three largest runs from last week');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

const FILE_FIELDS = ['otherLabel', 'lastLine', 'lastTurn', 'ratifiedTurn', 'ratifiedText', 'afterRatifyText'];

test('S-4 — a missing file: state missing, every field read from the file null', () => {
  const sb0 = sandbox('s4');
  try {
    const gone = join(sb0.files, 'gone-dialogue.md');
    const { sb, run } = sessionRig([gone]);
    try {
      const d = byFile(run(), gone);
      assert.equal(d.state, 'missing');
      for (const k of FILE_FIELDS) assert.equal(d[k], null, `${k} is null for a missing file`);
      assert.equal(d.label, 'Api-Claude', 'the fields from the transcript stay');
      assert.equal(d.name, 'gone');
      assert.equal(existsSync(gone), false);
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  } finally { rmSync(sb0.root, { recursive: true, force: true }); }
});

test('S-5 — a directory at the path: unreadable with the null fields', () => {
  const sb0 = sandbox('s5');
  try {
    const dir = join(sb0.files, 'dir-dialogue.md');
    mkdirSync(dir);
    const { sb, run } = sessionRig([dir]);
    try {
      const d = byFile(run(), dir);
      assert.equal(d?.state, 'unreadable', JSON.stringify(d));
      for (const k of FILE_FIELDS) assert.equal(d[k], null, `${k} null`);
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  } finally { rmSync(sb0.root, { recursive: true, force: true }); }
});

test('S-5b — a hanging path: unreadable with the null fields, ending at the per-file limit', { skip: noOfflineHang() }, async () => {
  const sb0 = sandbox('s5');
  const hang = await hangingPath(sb0.files, 's5');
  try {
    const { sb, run } = sessionRig([hang.path]);
    try {
      const t0 = Date.now();
      const out = run({ CLAUDE_SL_DIALOGUE_FILE_MS: HANG_FILE_MS, CLAUDE_SL_DIALOGUE_DEADLINE_MS: 6000 }, 8000);
      assertNearLimit(Date.now() - t0, HANG_FILE_MS, 'the hanging read ends at its per-file limit');
      for (const p of [hang.path]) {
        const d = byFile(out, p);
        assert.equal(d?.state, 'unreadable', `${p}: ${JSON.stringify(d)}`);
        for (const k of FILE_FIELDS) assert.equal(d[k], null, `${p}: ${k} null`);
      }
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  } finally { await hang.close(); rmSync(sb0.root, { recursive: true, force: true }); }
});

test('S-6 — a closed dialogue is left out', () => {
  const { sb, files, run } = sessionRig(['closed-dialogue.md', 'baton-to-me-dialogue.md']);
  try {
    const out = run();
    assert.equal(byFile(out, files[0]), undefined, 'closed → not listed');
    assert.ok(byFile(out, files[1]), 'vacuity: the open one is listed');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-7 — no session id, or no transcript for it: "session": null', () => {
  const sb = sandbox('s7');
  try {
    const a = cli(['--session', '--json'], { sb, env: { CLAUDE_CODE_SESSION_ID: undefined } });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(JSON.parse(a.stdout).session, null, 'CLAUDE_CODE_SESSION_ID unset');
    const b = cli(['--session', '--json'], { sb, env: { CLAUDE_CODE_SESSION_ID: 'no-such-session' } });
    assert.equal(b.status, 0, b.stderr);
    assert.equal(JSON.parse(b.stdout).session, null, 'no <config home>/projects/*/<id>.jsonl');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-8 — the transcript is found under CLAUDE_CONFIG_DIR, never under the default home', () => {
  const sb = sandbox('s8');
  try {
    const fDefault = placeFixture(sb, 'baton-to-me-dialogue.md', { as: 'default-home-dialogue.md' });
    const fSecond = placeFixture(sb, 'baton-to-other-dialogue.md', { as: 'second-home-dialogue.md' });
    const cfg2 = join(sb.home, '.claude-second');
    placeSessionTranscript(sb, 'sess-8', [legLine('x1'), toolLine('x1', psWatch(fDefault, 'Api-Claude'))], { cfg: sb.cfg });
    placeSessionTranscript(sb, 'sess-8', [legLine('y1'), toolLine('y1', psWatch(fSecond, 'Api-Claude'))], { cfg: cfg2 });
    const r = cli(['--session', '--json'], { sb, env: { CLAUDE_CODE_SESSION_ID: 'sess-8', CLAUDE_CONFIG_DIR: cfg2 } });
    const out = JSON.parse(r.stdout);
    assert.equal(out.session, 'sess-8');
    assert.ok(byFile(out, fSecond), 'the second home\'s transcript is the one read');
    assert.equal(byFile(out, fDefault), undefined, 'the default home is never consulted');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-9 — ratified then continued: ratifiedTurn 5, afterRatifyText holds Turn 6', () => {
  const { sb, files, run } = sessionRig(['ratified-then-continued-dialogue.md']);
  try {
    const d = byFile(run(), files[0]);
    assert.equal(d.ratifiedTurn, 5);
    assert.ok(d.afterRatifyText.includes('## Turn 6 — Web-Claude'));
    assert.ok(d.afterRatifyText.includes('PROPOSE CONSENSUS · BATON → Api-Claude'));
    assert.equal(d.lastTurn, 'Turn 6 — Web-Claude');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-10 — no Parties: line: otherLabel null', () => {
  const { sb, files, run } = sessionRig(['no-parties-line-dialogue.md']);
  try {
    const d = byFile(run(), files[0]);
    assert.equal(d.otherLabel, null);
    assert.equal(d.state, 'open');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-11 — two arms of one file: `command` is byte-equal to the LATER command', () => {
  const sb = sandbox('s11');
  try {
    const f = placeFixture(sb, 'baton-to-me-dialogue.md');
    const c1 = psWatch(f, 'Api-Claude');
    const c2 = psWatch(f, 'Api-Claude').replace('$max = 116', '$max = 117');
    placeSessionTranscript(sb, 'sess-11', [legLine('a'), toolLine('a', c1), legLine('b'), toolLine('b', c2)]);
    const out = JSON.parse(cli(['--session', '--json'], { sb, env: { CLAUDE_CODE_SESSION_ID: 'sess-11', ...FAST_LIMITS } }).stdout);
    assert.equal(out.dialogues.length, 1);
    assert.equal(out.dialogues[0].command, c2);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

// =================================================================================================
// `--close` — spec §6 step 4, §14.8. Each row checks the one-word output and the file's bytes after.
// =================================================================================================

const REC = 'Closed at handover by Api-Claude on 2026-11-05, on the Convener\'s word.';
const close = (sb, f, env = {}) => cli(['--close', f, '--record', REC], { sb, env: { ...FAST_LIMITS, ...env } });
const word = (r) => r.stdout.trim();

test('K-1 — an open LF file ending in a line break: `closed`, exactly the record and the close line appended, every earlier byte unchanged', () => {
  const sb = sandbox('k1');
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md');
    const before = readFileSync(f);
    const r = close(sb, f);
    assert.equal(word(r), 'closed', r.stderr);
    const after = readFileSync(f);
    assert.deepEqual(after.subarray(0, before.length), before, 'every earlier byte unchanged');
    assert.equal(after.subarray(before.length).toString('utf8'), `> ${REC}\n\n${CLOSE_LINE}\n`, 'no extra blank line in front');
    const rr = armedRollup(sb, [f]);
    probe(sb, rr);
    assert.equal(stateEntry(readJson(rr.state), f)?.state, 'closed', 'a probe afterward classifies it closed');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-2 — an open CRLF file: `closed`, every appended line ends in CRLF', () => {
  const sb = sandbox('k2');
  try {
    const f = placeFixture(sb, 'crlf-open-dialogue.md', { crlf: true });
    const before = readFileSync(f);
    assert.equal(word(close(sb, f)), 'closed');
    const after = readFileSync(f);
    assert.deepEqual(after.subarray(0, before.length), before);
    assert.equal(after.subarray(before.length).toString('utf8'), `> ${REC}\r\n\r\n${CLOSE_LINE}\r\n`);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-3 — an already-closed file: `already-closed`, bytes and modification time unchanged', () => {
  const sb = sandbox('k3');
  try {
    const f = placeFixture(sb, 'closed-dialogue.md');
    utimesSync(f, NOW - 86400, NOW - 86400);
    const before = readFileSync(f), mtime = statSync(f).mtimeMs;
    assert.equal(word(close(sb, f)), 'already-closed');
    assert.deepEqual(readFileSync(f), before);
    assert.equal(statSync(f).mtimeMs, mtime, 'nothing was written, so the mtime did not move');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-4 — a missing path: `missing`; the path still does not exist and its parent holds the same entries', () => {
  const sb = sandbox('k4');
  try {
    const f = join(sb.files, 'gone-dialogue.md');
    const ls = lsDir(sb.files);
    assert.equal(word(close(sb, f)), 'missing');
    assert.equal(existsSync(f), false, 'nothing in the handover ever creates a dialogue file');
    assert.deepEqual(lsDir(sb.files), ls, 'no stray file in the parent either');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-5 — a directory at the path, or a read-only file: `unreadable`, nothing written', () => {
  const sb = sandbox('k5');
  try {
    const dir = join(sb.files, 'dir-dialogue.md');
    mkdirSync(dir);
    assert.equal(word(close(sb, dir)), 'unreadable');
    assert.deepEqual(lsDir(dir), []);
    const ro = placeFixture(sb, 'baton-to-other-dialogue.md', { as: 'ro-dialogue.md' });
    const before = readFileSync(ro);
    chmodSync(ro, 0o444);
    const w = word(close(sb, ro));
    chmodSync(ro, 0o644);
    assert.equal(w, 'unreadable', 'an open for writing that fails is `unreadable`');
    assert.deepEqual(readFileSync(ro), before);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-6 — a hanging path ends within the per-file limit, printing `unreadable` or `unconfirmed`', { skip: noOfflineHang() }, async () => {
  const sb = sandbox('k6');
  const hang = await hangingPath(sb.files, 'k6');
  try {
    const r = cli(['--close', hang.path, '--record', REC], { sb, env: { ...FAST_LIMITS, CLAUDE_SL_DIALOGUE_FILE_MS: HANG_FILE_MS }, timeout: 8000 });
    assert.equal(r.error, undefined, `did not finish: ${r.error}`);
    assertNearLimit(r.ms, HANG_FILE_MS, 'ends at its per-file limit');
    assert.ok(['unreadable', 'unconfirmed'].includes(word(r)), `got ${JSON.stringify(word(r))}`);
  } finally { await hang.close(); rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-7 — `unconfirmed` on demand: closeDialogue with closeDelayMs > fileMs, and the CLI with the delay override, write nothing; delay 0 closes', () => {
  const sb = sandbox('k7');
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md');
    const before = readFileSync(f);
    const r = cli(['--close', f, '--record', REC], { sb, env: { CLAUDE_SL_DIALOGUE_FILE_MS: 200, CLAUDE_SL_DIALOGUE_CLOSE_DELAY_MS: 400 } });
    assert.equal(word(r), 'unconfirmed', r.stderr);
    assert.deepEqual(readFileSync(f), before, 'the CLI wrote nothing');
    const modUrl = new URL('file://' + (MODULE.startsWith('/') ? '' : '/') + MODULE.replace(/\\/g, '/')).href;
    const js = `import(${JSON.stringify(modUrl)}).then((m) => Promise.resolve(m.closeDialogue(process.argv[1], process.argv[2], { fileMs: 200, closeDelayMs: 400 }))).then((w) => process.stdout.write(String(w)))`;
    const out = childRun(['--input-type=module', '-e', js, f, REC], sb);
    assert.equal(out.trim(), 'unconfirmed', 'closeDialogue(file, record, { fileMs: 200, closeDelayMs: 400 })');
    assert.deepEqual(readFileSync(f), before, 'the function wrote nothing');
    assert.equal(word(close(sb, f)), 'closed', 'delay 0, the default, closes');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-8 — source guard: every open of a dialogue path is \'r\' or \'r+\'; no create-capable write touches one', () => {
  const src = MOD_SRC().split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const m of src.matchAll(/\bopen(?:Sync)?\s*\(([^)]*)\)/g)) {
    const flags = /,\s*['"]([a-z+]+)['"]/.exec(m[1]);
    // The state file and the guard are not dialogue paths: the guard is claimed with 'wx' by the
    // status line, never by this module, and the state is written by atomicWriteFile.
    assert.ok(!flags || ['r', 'r+'].includes(flags[1]), `an open with flag '${flags && flags[1]}' — only 'r' or 'r+' may open a dialogue path: ${m[0]}`);
  }
  assert.ok(!/\bappendFile(Sync)?\s*\(/.test(src), 'no appendFile: it creates a missing file');
  assert.ok(!/flags?\s*:\s*['"](a|a\+|w|w\+|wx)['"]/.test(src), 'no create-capable flag option');
});

test('K-9 — a file with no final line break gets one leading line ending, so its last line is byte-unchanged (LF and CRLF)', () => {
  const sb = sandbox('k9');
  try {
    for (const crlf of [false, true]) {
      const f = placeFixture(sb, 'no-trailing-newline-dialogue.md', { as: `ntn-${crlf ? 'crlf' : 'lf'}-dialogue.md`, crlf, finalBreak: false });
      const before = readFileSync(f);
      assert.ok(!/\n$/.test(before.toString('utf8')), 'precondition: no final break');
      assert.equal(word(close(sb, f)), 'closed');
      const nl = crlf ? '\r\n' : '\n';
      assert.equal(readFileSync(f).toString('utf8'), before.toString('utf8') + `${nl}> ${REC}${nl}${nl}${CLOSE_LINE}${nl}`);
    }
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-10 — a file with no line break at all: every written line ends in os.EOL', () => {
  const sb = sandbox('k10');
  try {
    const f = join(sb.files, 'oneline-dialogue.md');
    const one = '— Api-Claude · END OF TURN · BATON → Web-Claude';
    writeFileSync(f, one);
    assert.equal(word(close(sb, f)), 'closed');
    assert.equal(readFileSync(f, 'utf8'), `${one}${EOL}> ${REC}${EOL}${EOL}${CLOSE_LINE}${EOL}`);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

function childRun(args, sb) {
  const r = spawnSync(process.execPath, args, { cwd: sb.root, encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  return (r.stdout || '') + (r.status ? `\n[exit ${r.status}] ${r.stderr}` : '');
}

// =================================================================================================
// Amendment 1 (spec §17, approved 2026-11-07; test plan "G2.5 findings") — the rejoin command, the
// new last-line shapes, the report file, `--status` and `--append`. Spec §14 row 16.
// =================================================================================================

// The protocol §6 templates as they stood before commit e5af633 (2026-11-04): no `$n0` guard and no
// `DIALOGUE CLOSED` branch. Most transcripts of the time armed these; re-running one wakes at once
// on every hand-off to the Convener and never hears a close (G25-1).
const OLD_PS = '$f = "<DIALOGUE_FILE>"; $me = "<YOUR-LABEL>"; $max = 116; for ($i=0; $i -lt $max; $i++) { $last = (Get-Content -LiteralPath $f | Where-Object { $_.Trim() -ne "" } | Select-Object -Last 1); if ($last -match "BATON.*CONVENER") { Write-Output "CONVENER"; Write-Output $last; exit 0 }; if ($last -match "BATON.*$me") { Write-Output "YOUR_TURN"; Write-Output $last; exit 0 }; Start-Sleep -Seconds 30 }; Write-Output "TIMEOUT"; Write-Output $last';
const OLD_BASH = 'f="<DIALOGUE_FILE>"; me="<YOUR-LABEL>"; for i in $(seq 1 116); do last=$(grep -v \'^[[:space:]]*$\' "$f" | tail -n1); case "$last" in *BATON*CONVENER*) echo "CONVENER"; echo "$last"; exit 0;; *BATON*"$me"*) echo "YOUR_TURN"; echo "$last"; exit 0;; esac; sleep 30; done; echo "TIMEOUT"; echo "$last"';
const fill = (tpl, file, label) => tpl.replace('<DIALOGUE_FILE>', file).replace('<YOUR-LABEL>', label);
const lf = (s) => String(s).replace(/\r\n/g, '\n');

function oldArmSession(sb, sid, entries) {
  const lines = [];
  entries.forEach(({ file, label = 'Api-Claude', bash = false }, i) => {
    lines.push(legLine(`o${i}`));
    lines.push(bash ? toolLine(`o${i}`, '#posix: dialogue watch, the bash variant\n' + fill(OLD_BASH, file, label), { name: 'Bash' })
      : toolLine(`o${i}`, fill(OLD_PS, file, label)));
  });
  placeSessionTranscript(sb, sid, lines);
}
const sessionJson = (sb, sid, env = {}, module) => {
  const r = cli(['--session', '--json'], { sb, env: { CLAUDE_CODE_SESSION_ID: sid, ...FAST_LIMITS, ...env }, module });
  assert.equal(r.error, undefined, `--session --json did not finish: ${r.error}`);
  return JSON.parse(r.stdout);
};

test('S-12 — rejoinCommand is the CURRENT §6 watch for the file and label, whatever old template the transcript armed; command keeps the old text', () => {
  const sb = sandbox('s12');
  try {
    const fPs = placeFixture(sb, 'ratified-no-okay-dialogue.md', { as: 'ps-dialogue.md' });
    const fSh = placeFixture(sb, 'ratified-no-okay-dialogue.md', { as: 'sh-dialogue.md' });
    const gone = join(sb.files, 'gone-dialogue.md');
    oldArmSession(sb, 'sess-12', [{ file: fPs }, { file: fSh, bash: true }, { file: gone }]);
    const out = sessionJson(sb, 'sess-12');
    const ps = byFile(out, fPs), sh = byFile(out, fSh), gn = byFile(out, gone);
    assert.equal(ps.command, fill(OLD_PS, fPs, 'Api-Claude'), 'command is the old text, kept for diagnosis');
    assert.equal(lf(ps.rejoinCommand), psWatch(fPs, 'Api-Claude'), 'rejoinCommand is the current PowerShell watch, file and label filled');
    for (const s of ['$n0', 'DIALOGUE CLOSED']) assert.ok(ps.rejoinCommand.includes(s), `the rejoin command carries ${s}`);
    assert.equal(lf(sh.rejoinCommand), bashWatch(fSh, 'Api-Claude'), 'the bash variant keeps the `#posix:` comment line and takes the current bash watch');
    assert.ok(sh.rejoinCommand.includes('DIALOGUE CLOSED'));
    assert.equal(gn.state, 'missing');
    assert.equal(lf(gn.rejoinCommand), psWatch(gone, 'Api-Claude'), 'a missing file still gets its rejoin command');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-12b — with no protocol beside the module, rejoinCommand is null', () => {
  const sb = sandbox('s12b');
  try {
    // A copy of the module and its relative imports, in a folder with no dialogue-protocol.md.
    const dir = join(sb.root, 'bare-home');
    mkdirSync(dir);
    const copied = new Set();
    const copy = (n) => {
      copied.add(n);
      const src = readFileSync(join(REPO, 'home', n), 'utf8');
      writeFileSync(join(dir, n), src);
      for (const m of src.matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) if (!copied.has(m[1])) copy(m[1]);
    };
    copy('open-dialogues.mjs');
    const f = placeFixture(sb, 'baton-to-me-dialogue.md');
    oldArmSession(sb, 'sess-12b', [{ file: f }]);
    const out = sessionJson(sb, 'sess-12b', {}, join(dir, 'open-dialogues.mjs'));
    assert.equal(byFile(out, f).rejoinCommand, null, 'the protocol or its block cannot be found → null');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

// The carried command must behave: quiet on a hand-off already in the file, `CLOSED` on a closed one.
// Run in the shell it names, with the loop cut to three polls a second apart.
function hasPwsh() { try { return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 30000 }).status === 0; } catch { return false; } }
const K11_SKIP = process.platform === 'win32' ? (hasPwsh() ? false : 'pwsh is not on PATH') : false;
function runWatch(cmd, shell) {
  const short = shell === 'powershell'
    ? cmd.replace('$max = 116', '$max = 3').replace('Start-Sleep -Seconds 30', 'Start-Sleep -Seconds 1')
    : cmd.replace('seq 1 116', 'seq 1 3').replace('sleep 30', 'sleep 1');
  assert.notEqual(short, cmd, 'the loop was shortened (the template still has its 116 polls of 30 s)');
  const t0 = Date.now();
  const r = shell === 'powershell'
    ? spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', short], { encoding: 'utf8', timeout: 30000 })
    : spawnSync('bash', ['-c', short], { encoding: 'utf8', timeout: 30000 });
  return { first: (r.stdout || '').trim().split(/\r?\n/)[0], ms: Date.now() - t0, out: r.stdout + r.stderr };
}

test('K-11 — the carried rejoin command waits quietly on a hand-off to the Convener and exits CLOSED on a closed file; the old command does neither', { skip: K11_SKIP }, () => {
  const sb = sandbox('k11');
  try {
    const shell = process.platform === 'win32' ? 'powershell' : 'bash';
    const handoff = placeFixture(sb, 'ratified-no-okay-dialogue.md', { as: 'handoff-dialogue.md' });
    // Kept while open, closed after the handover: --session leaves closed dialogues out, so the rejoin
    // command is taken while the file is open and the close line lands afterward.
    const later = placeFixture(sb, 'baton-to-other-dialogue.md', { as: 'closes-later-dialogue.md' });
    oldArmSession(sb, 'sess-11', [{ file: handoff, bash: shell === 'bash' }, { file: later, bash: shell === 'bash' }]);
    const out = sessionJson(sb, 'sess-11');
    const a = runWatch(lf(byFile(out, handoff).rejoinCommand), shell);
    assert.equal(a.first, 'TIMEOUT', `a hand-off already in the file does not wake the rejoined session: ${a.out}`);
    assert.ok(a.ms >= 2000, `it polled through the loop instead of exiting on its first poll (${a.ms} ms)`);
    const laterCmd = lf(byFile(out, later).rejoinCommand);
    assert.equal(cli(['--close', later, '--record', REC], { sb, env: FAST_LIMITS }).stdout.trim(), 'closed');
    const b = runWatch(laterCmd, shell);
    assert.equal(b.first, 'CLOSED', `a closed dialogue is heard as closed: ${b.out}`);
    // Why the row exists: the transcript's own command loops on the first and never hears the second.
    const old = runWatch(lf(byFile(out, handoff).command), shell);
    assert.equal(old.first, 'CONVENER', 'vacuity: the old command wakes at once on the hand-off');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-13 — a hand-off worded otherwise (`AGREED, AWAITING FLORIAN · BATON → CONVENER`): lastLine and lastTurn as written, ratifiedTurn null', () => {
  const { sb, files, run } = sessionRig(['agreed-awaiting-dialogue.md']);
  try {
    const d = byFile(run(), files[0]);
    assert.equal(d.lastLine, '— Web-Claude · END OF TURN · AGREED, AWAITING FLORIAN · BATON → CONVENER');
    assert.equal(d.lastTurn, 'Turn 2 — Web-Claude');
    assert.equal(d.ratifiedTurn, null, 'only the literal RATIFY CONSENSUS counts as a ratify');
    assert.equal(d.ratifiedText, null);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-14 — a file that ends in a Convener block with no baton: lastTurn is that heading, lastLine its last sentence', () => {
  const { sb, files, run } = sessionRig(['convener-block-no-baton-dialogue.md']);
  try {
    const d = byFile(run(), files[0]);
    assert.equal(d.lastTurn, 'Convener\'s answer (relayed by Api-Claude)', 'lastTurn is the last `## ` heading, whatever its form');
    assert.equal(d.lastLine, 'Ship the bar this month. The consensus is approved.');
    assert.equal(d.ratifiedTurn, 3);
    assert.ok(d.afterRatifyText.includes('## Convener\'s answer (relayed by Api-Claude)'));
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

// Amendment 2 (G25-7): a `## ` heading opens a block only when it is a turn heading, the Convener is its
// author, or the block before it has ended in a baton or the close line. A subheading inside a party's
// ratifying turn, even one that names the Convener, keeps the turn whole.
test('S-16 — a ratifying turn with a `## Joint summary for the Convener` subheading: ratifiedTurn, ratifiedText and lastTurn all name the turn', () => {
  const sb0 = sandbox('s16');
  try {
    const plain = join(sb0.files, 'plain-subheading-dialogue.md');
    writeFileSync(plain, fixtureText('ratified-subheading-dialogue.md').replace('## Joint summary for the Convener', '## Joint summary'), 'utf8');
    const { sb, files, run } = sessionRig(['ratified-subheading-dialogue.md', plain]);
    try {
      const out = run();
      const text = fixtureText('ratified-subheading-dialogue.md');
      const batonLine = '— Api-Claude · END OF TURN · RATIFY CONSENSUS · ACCOUNTABLE → Api-Claude · BATON → CONVENER';
      const d = byFile(out, files[0]);
      assert.equal(d.ratifiedTurn, 3, 'the subheading naming the Convener does not hide the ratification');
      const start = text.indexOf('## Turn 3 — Api-Claude');
      assert.equal(d.ratifiedText.replace(/\r?\n$/, ''), text.slice(start, text.indexOf(batonLine) + batonLine.length),
        'ratifiedText runs from `## Turn 3` to the baton, the subheading inside it');
      assert.ok(d.ratifiedText.includes('## Joint summary for the Convener'));
      assert.equal(d.lastTurn, 'Turn 3 — Api-Claude', 'the subheading is not the last block');
      assert.equal(d.lastLine, batonLine);
      const p = byFile(out, files[1]);
      assert.equal(p.ratifiedTurn, 3);
      assert.equal(p.lastTurn, 'Turn 3 — Api-Claude', 'a subheading that does not name the Convener is not the last block either');
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  } finally { rmSync(sb0.root, { recursive: true, force: true }); }
});

// The third opener: a party's note written after a baton is its own block, a Markdown rule (`---`)
// between the baton and the note notwithstanding. The ratification it follows stays where it was.
test('S-16b — a post-dialogue note after the ratifying baton, behind a `---` rule: lastTurn is the note, ratifiedTurn still the turn', () => {
  const sb0 = sandbox('s16b');
  try {
    const note = '## Post-dialogue note 11 — Web-Claude (deploy done, not a turn) — 2026-11-06T18:50:09Z\nThe nightly sync ran once, clean.\n\n— Web-Claude · NOTE · BATON → CONVENER\n';
    const f = join(sb0.files, 'note-after-ratify-dialogue.md');
    writeFileSync(f, fixtureText('ratified-subheading-dialogue.md') + '\n---\n\n' + note, 'utf8');
    const { sb, run } = sessionRig([f]);
    try {
      const d = byFile(run(), f);
      assert.equal(d.lastTurn, 'Post-dialogue note 11 — Web-Claude (deploy done, not a turn) — 2026-11-06T18:50:09Z', 'the note opens its own block');
      assert.equal(d.ratifiedTurn, 3);
      assert.ok(d.afterRatifyText.includes(note.trimEnd()), 'the note is after the ratified turn');
      assert.equal(d.lastLine, '— Web-Claude · NOTE · BATON → CONVENER');
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  } finally { rmSync(sb0.root, { recursive: true, force: true }); }
});

// Amendment 3 (G25-12): a block ends on any signed line `— <label> · …`, not only on a baton or the close
// line. A writer that signs its entries without a baton (`— <party> · AFTER`) keeps each entry its own
// block, so `lastTurn` names the entry the file ends in — never an older entry it was merged into.
test('S-17 — entries signed without a baton each stay their own block: lastTurn is the last entry, also when the file is cut after each one', () => {
  const sb0 = sandbox('s17');
  try {
    const text = fixtureText('signed-entries-dialogue.md');
    const entries = [
      ['Ledger-Claude — BEFORE (deals 101 A, 102 B) — 2026-11-05T20:11Z', '— Ledger-Claude · BEFORE'],
      ['Ledger-Claude — AFTER (deals 101 A, 102 B) — 2026-11-06T09:40Z', '— Ledger-Claude · AFTER'],
      ['Ledger-Claude — BEFORE (deal 103 C) — 2026-11-07T15:02Z', '— Ledger-Claude · BEFORE'],
    ];
    // The same file cut after each signed, baton-less entry: each cut ends in that entry's own block.
    const cuts = entries.map(([heading, signed], i) => {
      const f = join(sb0.files, `signed-cut-${i + 1}-dialogue.md`);
      const end = text.indexOf(signed, text.indexOf(`## ${heading}`));
      assert.ok(end > 0, `the fixture holds entry ${i + 1}`);
      writeFileSync(f, text.slice(0, end + signed.length) + '\n', 'utf8');
      return f;
    });
    const { sb, files, run } = sessionRig(['signed-entries-dialogue.md', ...cuts]);
    try {
      const out = run();
      const d = byFile(out, files[0]);
      assert.equal(d.lastTurn, 'Ledger-Claude — the tax line needs a decision — 2026-11-09T11:26Z',
        'the hand-off to the Convener is its own block, not merged into the first baton-less entry');
      assert.equal(d.lastLine, '— Ledger-Claude · NOTE · BATON → CONVENER');
      assert.equal(d.ratifiedTurn, null);
      cuts.forEach((f, i) => {
        const c = byFile(out, f);
        assert.equal(c.lastTurn, entries[i][0], `cut after entry ${i + 1}: lastTurn is that entry`);
        assert.equal(c.lastLine, entries[i][1]);
      });
    } finally { rmSync(sb.root, { recursive: true, force: true }); }
  } finally { rmSync(sb0.root, { recursive: true, force: true }); }
});

test('S-15 — a report over 30,000 characters is written whole to the report file; the printed summary stays small and compact', () => {
  const sb = sandbox('s15');
  try {
    const f = join(sb.files, 'long-dialogue.md');
    const tail = Array.from({ length: 12 }, (_, i) => `## Turn ${4 + i} — ${i % 2 ? 'Api-Claude' : 'Web-Claude'}\n` + 'A long note with a ```` fenced aside. '.repeat(70) + `\n\n— ${i % 2 ? 'Api-Claude' : 'Web-Claude'} · END OF TURN · NOTE · BATON → ${i % 2 ? 'Web-Claude' : 'Api-Claude'}\n\n`).join('');
    writeFileSync(f, fixtureText('ratified-no-okay-dialogue.md') + '\n' + tail);
    oldArmSession(sb, 'sess-15', [{ file: f }]);
    const reportPath = join(sb.root, 'report.md');
    const r = cli(['--session', '--out', reportPath], { sb, env: { CLAUDE_CODE_SESSION_ID: 'sess-15', ...FAST_LIMITS } });
    assert.ok(r.stdout.length < 1024, `the printed summary stays under 1 KB (${r.stdout.length} characters)`);
    const sum = JSON.parse(r.stdout);
    assert.equal(sum.session, 'sess-15');
    assert.equal(keyOf(resolve(sum.reportFile)), keyOf(reportPath), '--out names the report file');
    const e = sum.dialogues.find((x) => keyOf(x.file) === keyOf(f));
    for (const k of ['ratifiedText', 'afterRatifyText', 'command', 'rejoinCommand']) assert.equal(k in e, false, `the summary leaves out ${k}`);
    for (const k of ['name', 'file', 'label', 'otherLabel', 'state', 'lastLine', 'lastTurn', 'ratifiedTurn']) assert.ok(k in e, `the summary keeps ${k}`);
    const full = sessionJson(sb, 'sess-15');
    const d = byFile(full, f);
    assert.ok(d.afterRatifyText.length > 30000, `precondition: the report is over 30,000 characters (${d.afterRatifyText.length})`);
    const report = lf(readFileSync(reportPath, 'utf8'));
    for (const k of ['afterRatifyText', 'ratifiedText', 'rejoinCommand']) {
      const text = lf(d[k]).replace(/\n$/, '');
      const at = report.indexOf(text);
      assert.ok(at >= 0, `the report file holds ${k} whole`);
      const before = report.slice(0, at).replace(/\n$/, '');
      const fence = /(`{3,})[^\n`]*$/.exec(before.slice(before.lastIndexOf('\n') + 1));
      assert.ok(fence, `${k} opens with a fence line`);
      const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
      assert.ok(fence[1].length > longestRun, `${k}'s fence (${fence[1].length}) is longer than any backtick run inside it (${longestRun})`);
    }
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('S-15b — without --out, the report file sits in the operating system\'s temp folder', () => {
  const sb = sandbox('s15b');
  let p = null;
  try {
    const f = placeFixture(sb, 'baton-to-me-dialogue.md');
    oldArmSession(sb, 'sess-15b', [{ file: f }]);
    const sum = JSON.parse(cli(['--session'], { sb, env: { CLAUDE_CODE_SESSION_ID: 'sess-15b', ...FAST_LIMITS } }).stdout);
    p = sum.reportFile;
    assert.equal(typeof p, 'string');
    assert.ok(keyOf(resolve(p)).startsWith(keyOf(tmpdir())), `${p} is under ${tmpdir()}`);
    assert.ok(statSync(p).size > 0, 'the report file was written');
  } finally {
    if (p) rmSync(p, { force: true });
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// ---- `--status <file>` (spec §8, Amendment 1) ---------------------------------------------------

const status = (sb, f, env = {}) => {
  const r = cli(['--status', f], { sb, env: { ...FAST_LIMITS, ...env }, timeout: 8000 });
  assert.equal(r.error, undefined, `--status did not finish: ${r.error}`);
  const line = r.stdout.trim();
  assert.equal(line.split('\n').length, 1, `one JSON line: ${line}`);
  return { ...JSON.parse(line), ms: r.ms };
};

test('ST-1 — --status reports each of its four states, with lastLine and lastTurn, and never writes', () => {
  const sb = sandbox('st1');
  try {
    const open = placeFixture(sb, 'baton-to-other-dialogue.md');
    const closed = placeFixture(sb, 'closed-dialogue.md');
    const gone = join(sb.files, 'gone-dialogue.md');
    const dir = join(sb.files, 'dir-dialogue.md');
    mkdirSync(dir);
    for (const p of [open, closed]) utimesSync(p, NOW - 86400, NOW - 86400);
    const snap = (p) => [readFileSync(p), statSync(p).mtimeMs];
    const before = [snap(open), snap(closed)];
    const ls = lsDir(sb.files);
    const a = status(sb, open);
    assert.equal(a.state, 'open');
    assert.equal(a.lastLine, '— Api-Claude · END OF TURN · BATON → Web-Claude');
    assert.equal(a.lastTurn, 'Turn 3 — Api-Claude');
    const c = status(sb, closed);
    assert.equal(c.state, 'closed');
    assert.equal(c.lastLine, CLOSE_LINE);
    const m = status(sb, gone);
    assert.equal(m.state, 'missing');
    assert.equal(m.lastLine, null);
    assert.equal(status(sb, dir).state, 'unreadable');
    assert.deepEqual([snap(open), snap(closed)], before, 'bytes and modification times unchanged');
    assert.deepEqual(lsDir(sb.files), ls, 'nothing created — the missing path is still missing');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('ST-2 — --status on a hanging path is `unreadable` at its per-file limit', { skip: noOfflineHang() }, async () => {
  const sb = sandbox('st2');
  try {
    const hang = await hangingPath(sb.files, 'st2');
    const s = status(sb, hang.path, { CLAUDE_SL_DIALOGUE_FILE_MS: HANG_FILE_MS });
    assert.equal(s.state, 'unreadable');
    assertNearLimit(s.ms, HANG_FILE_MS, '--status on a hanging path');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

// ---- `--append <file>` (spec §6 step 7, Amendment 1) --------------------------------------------

const BLOCK = '## Turn 4 — CONVENER\nHold the second ask until the quote arrives.\n\n— CONVENER · END OF TURN · BATON → Web-Claude\n';
// Amendment 2 (G25-9): the block travels in a UTF-8 text file, never on stdin. The text file sits in
// the sandbox root, outside the dialogue folder whose listing the rows compare.
let appendSeq = 0;
const append = (sb, f, env = {}, text = BLOCK) => {
  const tf = join(sb.root, `append-block-${++appendSeq}.md`);
  writeFileSync(tf, text, 'utf8');
  return cli(['--append', f, '--text-file', tf], { sb, env: { ...FAST_LIMITS, ...env }, timeout: 8000 });
};

test('K-12 — --append on an open file appends the block, every earlier byte unchanged, in the file\'s line ending', () => {
  const sb = sandbox('k12');
  try {
    for (const crlf of [false, true]) {
      const f = placeFixture(sb, 'baton-to-other-dialogue.md', { as: `app-${crlf ? 'crlf' : 'lf'}-dialogue.md`, crlf });
      const before = readFileSync(f);
      const r = append(sb, f);
      assert.equal(r.stdout.trim(), 'appended', r.stderr);
      const after = readFileSync(f);
      assert.deepEqual(after.subarray(0, before.length), before, 'every earlier byte unchanged');
      const added = after.subarray(before.length).toString('utf8');
      const nl = crlf ? '\r\n' : '\n';
      assert.equal(added.replace(new RegExp(`^(${nl})+`), ''), BLOCK.replace(/\n/g, nl), 'the block, line for line, each line ending in the file\'s own line ending');
      if (crlf) assert.ok(!/[^\r]\n/.test(added), 'no bare LF in a CRLF file');
    }
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-12b — --append on a missing path prints `missing` and creates nothing; on a closed file `already-closed` and writes nothing', () => {
  const sb = sandbox('k12b');
  try {
    const gone = join(sb.files, 'gone-dialogue.md');
    const ls = lsDir(sb.files);
    assert.equal(append(sb, gone).stdout.trim(), 'missing');
    assert.equal(existsSync(gone), false, 'nothing in the handover ever creates a dialogue file');
    assert.deepEqual(lsDir(sb.files), ls, 'the parent holds the same entries');
    const closed = placeFixture(sb, 'closed-dialogue.md');
    utimesSync(closed, NOW - 86400, NOW - 86400);
    const before = readFileSync(closed), mt = statSync(closed).mtimeMs;
    assert.equal(append(sb, closed).stdout.trim(), 'already-closed');
    assert.deepEqual(readFileSync(closed), before);
    assert.equal(statSync(closed).mtimeMs, mt);
    const dir = join(sb.files, 'dir-dialogue.md');
    mkdirSync(dir);
    assert.equal(append(sb, dir).stdout.trim(), 'unreadable');
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-12c — --append on a hanging path ends at its per-file limit, printing `unreadable` or `unconfirmed`', { skip: noOfflineHang() }, async () => {
  const sb = sandbox('k12c');
  try {
    const hang = await hangingPath(sb.files, 'k12c');
    const r = append(sb, hang.path, { CLAUDE_SL_DIALOGUE_FILE_MS: HANG_FILE_MS });
    assert.equal(r.error, undefined, `did not finish: ${r.error}`);
    assertNearLimit(r.ms, HANG_FILE_MS, '--append on a hanging path');
    assert.ok(['unreadable', 'unconfirmed'].includes(r.stdout.trim()), `got ${JSON.stringify(r.stdout.trim())}`);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-12d — appendDialogue(file, text, { fileMs, closeDelayMs }) with the delay past the limit is `unconfirmed` and writes nothing', () => {
  const sb = sandbox('k12d');
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md');
    const before = readFileSync(f);
    const modUrl = pathToFileURL(MODULE).href;
    const js = `import(${JSON.stringify(modUrl)}).then((m) => Promise.resolve(m.appendDialogue(process.argv[1], process.argv[2], { fileMs: 200, closeDelayMs: 400 }))).then((w) => process.stdout.write(String(w)))`;
    assert.equal(childRun(['--input-type=module', '-e', js, f, BLOCK], sb).trim(), 'unconfirmed');
    assert.deepEqual(readFileSync(f), before, 'nothing written');
    assert.equal(append(sb, f, { CLAUDE_SL_DIALOGUE_FILE_MS: 200, CLAUDE_SL_DIALOGUE_CLOSE_DELAY_MS: 400 }).stdout.trim(), 'unconfirmed', 'the CLI honors the delay override');
    assert.deepEqual(readFileSync(f), before);
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

// Amendment 2 (G25-9): Windows PowerShell 5.1 pipes text to a native program in an ASCII
// $OutputEncoding, so a block on stdin lands garbled. The block now travels in a UTF-8 text file; this
// row writes it from powershell.exe both ways a session can make that file (its own write tool, which
// writes UTF-8 without a byte-order mark, and 5.1's `Set-Content -Encoding UTF8`, which adds one) and
// requires the dialogue's new bytes to be the block's UTF-8, with no byte-order mark anywhere.
function winPs51() {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    return r.status === 0 && r.stdout.trim() === '5';
  } catch { return false; }
}
const K13_SKIP = process.platform !== 'win32' ? 'Windows only: Windows PowerShell 5.1 is a Windows shell' : (winPs51() ? false : 'powershell.exe (Windows PowerShell 5.1) is not available');
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
function ps51(script, sb, env = {}) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
    { env: childEnv(sb, { ...FAST_LIMITS, ...env }), encoding: 'utf8', timeout: 60000, windowsHide: true });
}

test('K-13 — from Windows PowerShell 5.1, --append --text-file lands the block byte-exact in UTF-8, with no byte-order mark', { skip: K13_SKIP }, () => {
  const sb = sandbox('k13');
  try {
    const want = Buffer.from(BLOCK, 'utf8');
    // Vacuity: in this shell, the same block piped to a native program does NOT arrive as its UTF-8.
    const piped = ps51(`$b = @'\n${BLOCK}\n'@\n$b | & ${psq(process.execPath)} -e ${psq("process.stdout.write(require('fs').readFileSync(0).toString('hex'))")}`, sb);
    assert.equal(piped.status, 0, piped.stderr);
    assert.ok(!piped.stdout.trim().includes(want.toString('hex').slice(0, 40)), `vacuity: 5.1 really re-encodes a pipe (got ${piped.stdout.trim().slice(0, 60)})`);
    for (const how of ['write-tool', 'set-content']) {
      const f = placeFixture(sb, 'baton-to-other-dialogue.md', { as: `k13-${how}-dialogue.md` });
      const tf = join(sb.root, `k13-${how}-block.md`);
      let make = '';
      if (how === 'write-tool') writeFileSync(tf, BLOCK, 'utf8');
      else make = `Set-Content -LiteralPath ${psq(tf)} -Encoding UTF8 -NoNewline -Value @'\n${BLOCK}\n'@\n`;
      const before = readFileSync(f);
      const r = ps51(`${make}& ${psq(process.execPath)} ${psq(MODULE)} --append ${psq(f)} --text-file ${psq(tf)}\n`, sb);
      assert.equal(r.stdout.trim(), 'appended', `${how}: ${r.stderr}`);
      const after = readFileSync(f);
      assert.deepEqual(after.subarray(0, before.length), before, `${how}: every earlier byte unchanged`);
      let added = after.subarray(before.length);
      while (added[0] === 0x0a) added = added.subarray(1);
      assert.equal(added.toString('hex'), want.toString('hex'), `${how}: the new bytes are the block's UTF-8 (got ${JSON.stringify(added.toString('utf8'))})`);
      assert.equal(after.indexOf(Buffer.from([0xef, 0xbb, 0xbf])), -1, `${how}: no byte-order mark in the dialogue file`);
    }
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

// Amendment 3 (G25-13): a text file that does not decode as UTF-8, or that holds a NUL byte, is refused —
// exit 2, one stderr line naming the file, the dialogue's bytes and mtime unchanged, the text file kept.
// The dialogue is append-only, so a wrongly decoded block would stay in it for good.
function assertRefused(how, tf, r, f, before, mt, { oneLine = true } = {}) {
  assert.equal(r.status, 2, `${how}: exit 2 (stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)})`);
  assert.equal(r.stdout.trim(), '', `${how}: no result word`);
  assert.ok(r.stderr.includes(tf), `${how}: the stderr line names the text file: ${r.stderr}`);
  if (oneLine) assert.equal(r.stderr.trim().split('\n').length, 1, `${how}: one stderr line: ${r.stderr}`);
  assert.deepEqual(readFileSync(f), before, `${how}: the dialogue's bytes are unchanged`);
  assert.equal(statSync(f).mtimeMs, mt, `${how}: the dialogue is not touched`);
  assert.ok(existsSync(tf), `${how}: the text file is never deleted`);
}
// The block in a single-byte ANSI code page (1252 and 1250 agree here): `—` is 0x97, `·` is 0xB7, and `→`
// has no code, so the shell writes `?`. This is what Windows PowerShell 5.1's plain `Set-Content` writes.
const ansiBlock = () => Buffer.from(BLOCK.replace(/—/g, '\x97').replace(/·/g, '\xb7').replace(/→/g, '?'), 'latin1');

test('K-13b — --append refuses a UTF-16 or ANSI text file and one holding a NUL byte; the dialogue stays byte-identical, and UTF-8 still appends', () => {
  const sb = sandbox('k13b');
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md', { as: 'k13b-dialogue.md' });
    utimesSync(f, NOW - 86400, NOW - 86400);
    const before = readFileSync(f), mt = statSync(f).mtimeMs;
    const bad = {
      'utf-16 le, no byte-order mark (Node `utf16le`)': Buffer.from(BLOCK, 'utf16le'),
      'utf-16 le with a byte-order mark (5.1 `Out-File`)': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(BLOCK, 'utf16le')]),
      'ansi code page (5.1 plain `Set-Content`)': ansiBlock(),
      'utf-8 holding a NUL byte': Buffer.from(BLOCK.replace('Hold the', 'Hold\0the'), 'utf8'),
    };
    let i = 0;
    for (const [how, bytes] of Object.entries(bad)) {
      const tf = join(sb.root, `k13b-${++i}-block.md`);
      writeFileSync(tf, bytes);
      const r = cli(['--append', f, '--text-file', tf], { sb, env: FAST_LIMITS, timeout: 8000 });
      assertRefused(how, tf, r, f, before, mt);
    }
    // Not vacuous: the same block in UTF-8, with and without a byte-order mark, appends to the same file.
    for (const bom of [false, true]) {
      const g = placeFixture(sb, 'baton-to-other-dialogue.md', { as: `k13b-ok-${bom ? 'bom' : 'plain'}-dialogue.md` });
      const gb = readFileSync(g);
      const tf = join(sb.root, `k13b-ok-${bom ? 'bom' : 'plain'}-block.md`);
      writeFileSync(tf, (bom ? '\ufeff' : '') + BLOCK, 'utf8');
      const r = cli(['--append', g, '--text-file', tf], { sb, env: FAST_LIMITS, timeout: 8000 });
      assert.equal(r.stdout.trim(), 'appended', `utf-8${bom ? ' with a byte-order mark' : ''}: ${r.stderr}`);
      let added = readFileSync(g).subarray(gb.length);
      while (added[0] === 0x0a) added = added.subarray(1);
      assert.equal(added.toString('hex'), Buffer.from(BLOCK, 'utf8').toString('hex'));
    }
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-13b (Windows PowerShell 5.1) — a text file made by `Out-File` or by plain `Set-Content` is refused, the dialogue byte-identical', { skip: K13_SKIP }, () => {
  const sb = sandbox('k13b51');
  try {
    const f = placeFixture(sb, 'baton-to-other-dialogue.md', { as: 'k13b51-dialogue.md' });
    utimesSync(f, NOW - 86400, NOW - 86400);
    const before = readFileSync(f), mt = statSync(f).mtimeMs;
    for (const [how, make] of [['out-file', (tf) => `$b | Out-File -LiteralPath ${psq(tf)}`], ['set-content', (tf) => `Set-Content -LiteralPath ${psq(tf)} -Value $b`]]) {
      const tf = join(sb.root, `k13b51-${how}-block.md`);
      const r = ps51(`$b = @'\n${BLOCK}\n'@\n${make(tf)}\n& ${psq(process.execPath)} ${psq(MODULE)} --append ${psq(f)} --text-file ${psq(tf)}\nexit $LASTEXITCODE\n`, sb);
      // Vacuity: the shell really wrote something other than the block's UTF-8.
      const made = readFileSync(tf);
      assert.notEqual(made.toString('hex'), Buffer.from(BLOCK, 'utf8').toString('hex'), `${how}: 5.1 wrote the block as UTF-8, so the row tests nothing`);
      // 5.1 wraps a native program's stderr in its own error record, so the line count is the shell's, not the module's.
      assertRefused(how, tf, r, f, before, mt, { oneLine: false });
    }
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
});

test('K-8b — the two writers are the module\'s only writes to a dialogue path: closeDialogue and appendDialogue both exported, no create-capable open', () => {
  const src = MOD_SRC();
  assert.match(src, /export\s+(async\s+)?function\s+appendDialogue\s*\(/, 'appendDialogue is exported');
  assert.match(src, /export\s+(async\s+)?function\s+closeDialogue\s*\(/, 'closeDialogue is exported');
  assert.ok(src.includes("'--append'"), 'the --append mode exists');
  assert.ok(src.includes("'--status'"), 'the --status mode exists');
  // K-8 above already holds every open in the module to 'r' / 'r+' and bans appendFile: --append included.
});
