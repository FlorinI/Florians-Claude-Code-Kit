import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, copyFileSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  REPO, ENGINE, NOW, psWatch, legLine, toolLine, sandbox, render, writeTranscript, readJson, keyOf, strip,
} from './_open-dialogues-harness.mjs';

// open-dialogues-render — the status-line chip of the open-dialogues sprint (2026-11-05): its bytes,
// its cells, its place on the `flags` row, the sidecar key, the parity fixtures' pins, and the
// /handover-check fact-sheet line.
//
// Spec: docs/261105-open-dialogues-spec.md §5 and §10. Test plan rows C-1 to C-5 and F-1, and the
// "Parity fixtures" table. Exported to the public kit beside open-dialogues.test.mjs.
//
// Two kinds of row live here. LIVE rows render through a child engine with a seeded state file and
// the probe off, so they need no golden. GOLDEN rows read the committed dlg-* parity goldens; those
// are blessed at the quality gate, and until then each golden row fails loudly by name rather than
// passing on a missing file (the dossier-layout row 20 discipline).

const BADGE_SGR = '\x1b[1;38;5;231;48;5;96m';
const RESET = '\x1b[0m';
const CHROME = '\x1b[38;5;240m';
const badge = (n) => `${BADGE_SGR} ${n} ${n === 1 ? 'dialogue' : 'dialogues'} open ${RESET}`;
const RIGHT_VALUE_W = 53;              // the right column's value field (statusline.mjs)
const cells = (s) => [...strip(s)].length;   // the engine's visLen: one cell per code point, ANSI stripped
const normVer = (s) => s.replace(/bsl\d+(?:\.\d+)+/g, 'bsl<ver>');
// Does one SGR sequence set a background? Parsed, not pattern-matched: `38;5;n` / `38;2;r;g;b` carry
// sub-parameters that a substring test would misread (`38;5;48` is a foreground).
function setsBackground(seq) {
  const p = seq.slice(2, -1).split(';').map(Number);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 38 || p[i] === 48) {
      if (p[i] === 48) return true;
      i += p[i + 1] === 5 ? 2 : (p[i + 1] === 2 ? 4 : 0);
    } else if ((p[i] >= 40 && p[i] <= 47) || (p[i] >= 100 && p[i] <= 107)) return true;
  }
  return false;
}

// A flags row holding only `text` (plain, pads included) and the bsl badge, right-aligned at the end
// of the 53-cell value field. The badge token is read from the row itself, so a BUILD tick never moves it.
const bslOf = (row) => /bsl\d+(?:\.\d+)+/.exec(row)[0];
const aloneRow = (text, row) => '  flags  ' + text + ' '.repeat(RIGHT_VALUE_W - cells(text) - bslOf(row).length) + bslOf(row);

// The flags row is the row that carries the `bsl` badge; its right half is everything after `│ `.
function flagsRow(raw) {
  const rows = raw.split('\n');
  const i = rows.findIndex((r) => /bsl\d/.test(strip(r)));
  assert.ok(i >= 0, `no flags row (bsl badge) in:\n${strip(raw)}`);
  const plainRow = strip(rows[i]);
  const rawRow = rows[i];
  const rawRight = rawRow.slice(rawRow.indexOf('│') + 1);
  return { index: i, raw: rawRow, plain: plainRow, right: plainRow.slice(plainRow.indexOf('│') + 2), rawRight };
}

// A live render: one PowerShell watch per state; a state of null leaves that dialogue never-probed.
function dlgRender(states, { payloadExtra = {}, prefix = 'odr' } = {}) {
  const sb = sandbox(prefix);
  const files = states.map((_, i) => join(sb.files, `d${i}-dialogue.md`));
  const lines = [];
  files.forEach((f, i) => { lines.push(legLine(`m${i}`)); lines.push(toolLine(`m${i}`, psWatch(f, 'Api-Claude'))); });
  const t = writeTranscript(sb, 'odr-1', lines);
  const dialogues = {};
  states.forEach((st, i) => {
    if (st) dialogues[keyOf(files[i])] = { file: files[i], state: st, lastLine: st === 'open' ? '— Web-Claude · END OF TURN · BATON → Api-Claude' : null, checkedAt: NOW - 5 };
  });
  mkdirSync(sb.statsDir, { recursive: true });
  writeFileSync(sb.statePath('odr-1'), JSON.stringify({ v: 1, checkedAt: NOW - 5, dialogues }));
  try {
    const raw = render(sb, 'odr-1', t, { payloadExtra });
    const sidecar = readJson(join(sb.cwd, '.claude', 'statusline-stats', 'odr-1.sidecar.json'));
    return { raw, plain: strip(raw), flags: flagsRow(raw), sidecar };
  } finally { rmSync(sb.root, { recursive: true, force: true }); }
}

// =================================================================================================
// C-1 / C-1b / C-1c / C-2 — the badge, live
// =================================================================================================

test('C-1 — the badge\'s exact bytes: singular, plural, and a two-digit count that grows and abbreviates nothing', () => {
  assert.ok(dlgRender(['open']).flags.raw.includes(badge(1)), 'the 1-dialogue badge, one pad space inside the fill each side');
  assert.ok(dlgRender(['open', 'open', null]).flags.raw.includes(badge(3)), 'the 3-dialogue badge; a never-probed dialogue counts open');
  const twelve = dlgRender(Array(12).fill('open')).flags.raw;
  assert.ok(twelve.includes(`${BADGE_SGR} 12 dialogues open ${RESET}`), 'a count of 12 grows the badge');
  assert.equal(badge(1), '\x1b[1;38;5;231;48;5;96m 1 dialogue open \x1b[0m');
});

test('C-1b — the suffix sits OUTSIDE the badge, after one space, as chrome-240 plain text', () => {
  for (const [states, text] of [
    [['open', 'open', 'unreadable'], '(1 unreadable)'],
    [['open', 'missing'], '(1 missing)'],
    [['open', 'unreadable', 'missing'], '(1 unreadable, 1 missing)'],
  ]) {
    const { flags } = dlgRender(states);
    const b = badge(states.length);
    const at = flags.raw.indexOf(b);
    assert.ok(at >= 0, `the badge renders: ${JSON.stringify(flags.raw)}`);
    const after = flags.raw.slice(at + b.length);
    // One space, then the chrome text; the space may sit just inside or just outside the chrome SGR.
    const m = /^( \x1b\[38;5;240m|\x1b\[38;5;240m )(\([^)]*\))\x1b\[0m/.exec(after);
    assert.ok(m, `the suffix follows the badge's reset after one space, in chrome 240: ${JSON.stringify(after.slice(0, 60))}`);
    assert.equal(m[2], text);
    assert.ok(!/48;/.test(after.slice(0, m[0].length)), 'no suffix byte carries the fill');
  }
});

test('C-1c — cells: 17 and 18 with the pads; the gaps; `bsl` right-aligned at the column end with the badge counted', () => {
  assert.equal(cells(badge(1)), 17);
  assert.equal(cells(badge(3)), 18);
  // One open dialogue, nothing else on the row: the bsl badge ends at the right column's last cell.
  const one = dlgRender(['open']).flags.right;
  assert.equal(one, aloneRow(' 1 dialogue open ', one));
  // Spec §5 "Placement", row 1 — `2 dialogues open` alone. The rule (the badge's 18 cells counted,
  // bsl right-aligned) puts 25 spaces between `open` and `bsl`; the spec's own drawing shows 24, a
  // one-cell miscount of the illustration, reported as a spec finding. This row pins the rule.
  const two = dlgRender(['open', 'open']).flags.right;
  assert.equal(two.length, 9 + RIGHT_VALUE_W, 'the right half is the 7-cell label, the 2-cell gap and the full 53-cell value');
  assert.equal(two, aloneRow(' 2 dialogues open ', two));
  assert.equal(two.indexOf('bsl') - two.indexOf('open') - 'open'.length, 25, 'the badge\'s right pad plus 24 spaces of padding');
  // Spec §5 row 2 — the badge, then `fast on` three spaces later (pad plus gap). With fast mode on
  // and a cost present the fast-premium caveat also fires, which the spec's drawing leaves out.
  const fast = dlgRender(['open'], { payloadExtra: { fast_mode: true, output_style: { name: 'Explanatory' } } }).flags.right;
  assert.ok(fast.startsWith('  flags   1 dialogue open   fast on  style Explanatory  '), JSON.stringify(fast));
  // Spec §5 row 3 — the suffix one space after the pad; the row overruns, so bsl follows two spaces on.
  const mixed = dlgRender(['open', 'unreadable', 'missing']).flags.right;
  assert.equal(normVer(mixed), '  flags   3 dialogues open  (1 unreadable, 1 missing)  bsl<ver>');
});

test('C-2 — the badge is the FIRST chip on the flags row, before `fast on`; alone, the row is `flags`, the badge and `bsl`', () => {
  const fast = dlgRender(['open'], { payloadExtra: { fast_mode: true } }).flags;
  assert.ok(fast.rawRight.indexOf(BADGE_SGR) >= 0 && fast.rawRight.indexOf(BADGE_SGR) < fast.rawRight.indexOf('fast '), 'order 0');
  assert.match(fast.right, /^ {2}flags {3}1 dialogue open {3}fast on /);
  const alone = dlgRender(['open']).flags.right;
  assert.match(alone, /^ {2}flags {3}1 dialogue open +bsl\S+$/, 'flags, the badge, the bsl badge — nothing else');
});

test('C-3 — the plum fill appears in statusline.mjs only in the dialogue badge; no other flag carries a background', () => {
  const code = readFileSync(ENGINE, 'utf8').split('\n').filter((l) => !l.trim().startsWith('//'));
  const plum = code.filter((l) => l.includes('48;5;96'));
  assert.equal(plum.length, 1, `one source line carries the plum fill: ${plum.join(' | ')}`);
  assert.ok(plum[0].includes('1;38;5;231;48;5;96'), 'and it is the badge SGR');
  const backgrounds = code.filter((l) => /48;[25];/.test(l));
  assert.equal(backgrounds.length, 2, `exactly two background sites: the trend tint and the badge: ${backgrounds.map((l) => l.trim()).join(' | ')}`);
  assert.ok(backgrounds.some((l) => l.includes('48;2;') && /BgTint|m0/.test(l)), 'the other is the trend strip\'s tint');
  // On a live row carrying every flag kind at once: the badge is the only background on the row.
  const { flags } = dlgRender(['open', 'unreadable'], { payloadExtra: { fast_mode: true, output_style: { name: 'Explanatory' }, thinking: { enabled: false } } });
  const bgSeqs = [...flags.raw.matchAll(/\x1b\[[0-9;]*m/g)].map((m) => m[0]).filter(setsBackground);
  assert.deepEqual([...new Set(bgSeqs)], [BADGE_SGR], `only the badge carries a background on the flags row: ${JSON.stringify(bgSeqs)}`);
  const one = dlgRender(['open']).raw;
  const fi = flagsRow(one).index;
  one.split('\n').forEach((row, i) => { if (i !== fi) assert.ok(!row.includes(BADGE_SGR), `row ${i + 1}: the badge belongs to the flags row only`); });
});

test('C-4 — the sidecar carries openDialogues only at n ≥ 1; `open` is the chip\'s total; schema stays 6', () => {
  const none = dlgRender(['closed', 'closed']).sidecar;
  assert.equal('openDialogues' in none, false, 'every dialogue closed → no key');
  assert.equal(none.schema, 6);
  const mixed = dlgRender(['open', 'unreadable', 'missing', 'closed', null]).sidecar;
  assert.deepEqual(mixed.openDialogues, { open: 4, unreadable: 1, missing: 1 }, 'open = the chip total, unreadable and missing included; closed excluded; never-probed counted');
  assert.equal(mixed.schema, 6);
  const chip = dlgRender(['open', 'unreadable', 'missing', 'closed', null]).flags.right;
  assert.ok(chip.includes('4 dialogues open'), 'the chip shows the same total');
});

// =================================================================================================
// The parity fixtures — live checks (no golden needed) and golden pins (blessed at the gate)
// =================================================================================================

const FIX = join(REPO, 'tools', 'parity', 'fixtures');
const DLG = ['dlg-one-open', 'dlg-three-unreadable-fast', 'dlg-one-missing', 'dlg-four-mixed-fast', 'dlg-closed', 'dlg-none-twin', 'dlg-backfill', 'dlg-never-probed'];
const isWatchLine = (l) => { try { const p = JSON.parse(l); return (p?.message?.content || []).some((b) => b?.type === 'tool_use' && /^(#[^\n]*\n)*\$?f ?= ?"/.test(String(b?.input?.command || '').replace(/^\s+/, ''))); } catch { return false; } };

function copyDirInto(src, dst) {
  let names;
  try { names = readdirSync(src); } catch { return; }   // a fixture with no seed/ directory seeds nothing
  for (const n of names) {
    const s = join(src, n), d = join(dst, n);
    if (statSync(s).isDirectory()) { mkdirSync(d, { recursive: true }); copyDirInto(s, d); } else copyFileSync(s, d);
  }
}
function latestTsMs(text) {
  let max = null;
  for (const m of text.matchAll(/"timestamp"\s*:\s*"([^"]+)"/g)) { const ms = Date.parse(m[1]); if (!Number.isNaN(ms) && (max === null || ms > max)) max = ms; }
  return max;
}
// One fixture through the engine the way run-parity.mjs runs it (temp home + cwd, seeds copied, the
// payload's paths rewritten, the transcript mtime pinned), with the probe off. `twin` drops every
// watch line and the dialogue state seed: the same session as if it had never joined a dialogue.
function runFixture(name, { twin = false } = {}) {
  const fixDir = join(FIX, name);
  const home = mkdtempSync(join(tmpdir(), 'odr-home-')), cwd = mkdtempSync(join(tmpdir(), 'odr-cwd-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(cwd, '.claude'), { recursive: true });
    copyDirInto(join(fixDir, 'seed'), join(cwd, '.claude'));
    const stdin = JSON.parse(readFileSync(join(fixDir, 'stdin.json'), 'utf8'));
    const meta = JSON.parse(readFileSync(join(fixDir, 'meta.json'), 'utf8'));
    let text = readFileSync(join(fixDir, 'transcript.jsonl'), 'utf8');
    const statsDir = join(cwd, '.claude', 'statusline-stats');
    if (twin) {
      text = text.split('\n').filter((l) => !isWatchLine(l)).join('\n');
      rmSync(join(statsDir, `${stdin.session_id}.dialogues.json`), { force: true });
    }
    const tr = join(cwd, 'transcript.jsonl');
    writeFileSync(tr, text);
    const endMs = latestTsMs(text);
    if (endMs != null) utimesSync(tr, endMs / 1000, endMs / 1000);
    stdin.transcript_path = tr;
    stdin.workspace = { ...(stdin.workspace || {}), current_dir: cwd };
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(meta.nowEpoch), CLAUDE_SL_DIALOGUE_PROBE: 'off' };
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const raw = execFileSync(process.execPath, [ENGINE], { input: JSON.stringify(stdin), env, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
    const sidecar = JSON.parse(readFileSync(join(statsDir, `${stdin.session_id}.sidecar.json`), 'utf8'));
    const stats = JSON.parse(readFileSync(join(statsDir, `${stdin.session_id}.json`), 'utf8'));
    return { raw, sidecar, stats, guard: existsSync(join(statsDir, `${stdin.session_id}.dialogue-probe.json`)), sid: stdin.session_id };
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

test('PF-1 — every dlg-* fixture with a dialogue changes ONLY the flags row and the sidecar\'s openDialogues against its no-dialogue twin (live)', () => {
  for (const name of DLG.filter((n) => n !== 'dlg-none-twin')) {
    const a = runFixture(name), b = runFixture(name, { twin: true });
    const ra = a.raw.split('\n'), rb = b.raw.split('\n');
    const fa = flagsRow(a.raw).index, fb = flagsRow(b.raw).index;
    assert.equal(fa, fb, `${name}: the flags row sits at the same row index`);
    assert.equal(ra.length, rb.length, `${name}: same row count`);
    ra.forEach((row, i) => { if (i !== fa) assert.equal(row, rb[i], `${name}: row ${i + 1} must not change`); });
    const sa = { ...a.sidecar }, sbb = { ...b.sidecar };
    delete sa.openDialogues;
    for (const s of [sa, sbb]) { delete s.transcriptPath; delete s.agentsCachePath; delete s.aliveSec; delete s.activityPct; }
    assert.deepEqual(sa, sbb, `${name}: the sidecar differs by openDialogues alone`);
  }
});

test('PF-2 — dlg-backfill: the chip appears and the stats file\'s leg arrays match the seed; dlg-never-probed counts open and creates no guard (live)', () => {
  const seed = JSON.parse(readFileSync(join(FIX, 'dlg-backfill', 'seed', 'statusline-stats', 'dlg-backfill-1.json'), 'utf8'));
  assert.equal('dialogues' in seed, false, 'precondition: the seed predates the key');
  const bf = runFixture('dlg-backfill');
  assert.ok(strip(bf.raw).includes('1 dialogue open'), 'the backfill found the watch armed before the seed was written');
  for (const k of ['perLegUnits', 'perLegOwnUnits', 'perLegModels', 'seenMsgIds', 'coldLegs', 'recentLegs', 'nLegs', 'lastByteOffset']) {
    assert.deepEqual(bf.stats[k], seed[k], `dlg-backfill: ${k} is the seed's`);
  }
  const np = runFixture('dlg-never-probed');
  assert.ok(flagsRow(np.raw).right.includes(' 1 dialogue open '), 'never-probed counts open');
  assert.ok(!/\(\d+ (unreadable|missing)/.test(flagsRow(np.raw).right), 'and is neither unreadable nor missing');
  assert.equal(np.guard, false, 'with the probe off, no guard file is created');
});

// The golden pins. Each fixture's goldens are blessed at the quality gate; a missing golden fails here
// by name.
const golden = (name, file) => {
  const p = join(FIX, name, file);
  assert.ok(existsSync(p), `${name}/${file} is not blessed yet — bless the dlg-* fixtures at the quality gate (node tools/parity/run-parity.mjs --bless ${name}, then the trio runner)`);
  return readFileSync(p, 'utf8');
};
const factsLast = (name) => golden(name, 'golden-facts.txt').replace(/\s+$/, '').split('\n').pop();
const PIN = {
  'dlg-one-open': { flags: (r) => assert.equal(r, aloneRow(' 1 dialogue open ', r)), side: { open: 1, unreadable: 0, missing: 0 }, facts: 'DIALOGUES: this session takes part in `1` open dialogue; /handover will stop until you decide each one' },
  'dlg-three-unreadable-fast': { flags: (r) => assert.ok(r.startsWith('  flags   3 dialogues open  (1 unreadable)  fast on  '), r), side: { open: 3, unreadable: 1, missing: 0 }, facts: 'DIALOGUES: this session takes part in `3` open dialogues (`1` unreadable); /handover will stop until you decide each one' },
  'dlg-one-missing': { flags: (r) => assert.equal(r, aloneRow(' 1 dialogue open  (1 missing)', r)), side: { open: 1, unreadable: 0, missing: 1 }, facts: 'DIALOGUES: this session takes part in `1` open dialogue (`1` missing); /handover will stop until you decide each one' },
  'dlg-four-mixed-fast': { flags: (r) => assert.ok(r.startsWith('  flags   4 dialogues open  (1 unreadable, 1 missing)  fast on  '), r), side: { open: 4, unreadable: 1, missing: 1 }, facts: 'DIALOGUES: this session takes part in `4` open dialogues (`1` unreadable, `1` missing); /handover will stop until you decide each one' },
  'dlg-backfill': { flags: (r) => assert.equal(r, aloneRow(' 1 dialogue open ', r)), side: { open: 1, unreadable: 0, missing: 0 } },
  'dlg-never-probed': { flags: (r) => assert.equal(r, aloneRow(' 1 dialogue open ', r)), side: { open: 1, unreadable: 0, missing: 0 } },
};

test('PF-3 — the dlg-* goldens carry the pinned flags row, the sidecar key and the trio\'s DIALOGUES line (C-1, C-1b, C-1c, F-1)', () => {
  for (const [name, pin] of Object.entries(PIN)) {
    const g = golden(name, 'golden.txt');
    const fr = flagsRow(g);
    pin.flags(fr.right);
    assert.ok(fr.raw.includes(BADGE_SGR), `${name}: the badge's fill is in the golden bytes`);
    const side = JSON.parse(golden(name, 'golden-sidecar.json'));
    assert.deepEqual(side.openDialogues, pin.side, `${name}: sidecar openDialogues`);
    assert.equal(side.schema, 6);
    if (pin.facts) assert.equal(factsLast(name), pin.facts, `${name}: the DIALOGUES line is the sheet's last line`);
  }
});

test('C-5 — dlg-closed\'s golden.txt is byte-equal to dlg-none-twin\'s, and neither sidecar has openDialogues', () => {
  assert.equal(golden('dlg-closed', 'golden.txt'), golden('dlg-none-twin', 'golden.txt'));
  for (const n of ['dlg-closed', 'dlg-none-twin']) {
    assert.equal('openDialogues' in JSON.parse(golden(n, 'golden-sidecar.json')), false, n);
    assert.ok(!/DIALOGUES:/.test(golden(n, 'golden-facts.txt')), `${n}: no DIALOGUES line`);
  }
});

// =================================================================================================
// F-1 — the /handover-check fact sheet's DIALOGUES line (spec §10), live
// =================================================================================================

function facts(sidecar) {
  const home = mkdtempSync(join(tmpdir(), 'odr-fh-')), cwd = mkdtempSync(join(tmpdir(), 'odr-fc-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(cwd, '.claude'), { recursive: true });
    mkdirSync(join(cwd, '.claude', 'statusline-stats'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'statusline-stats', `${sidecar.sessionId}.sidecar.json`), JSON.stringify(sidecar));
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_PROJECT_DIR: cwd, TZ: 'UTC', CLAUDE_SL_NOW_EPOCH: String(sidecar.renderedAt) };
    delete env.CLAUDE_CODE_SESSION_ID;
    return execFileSync(process.execPath, [join(REPO, 'home', 'handover-facts.mjs')], { env, cwd, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

test('F-1 — DIALOGUES is emitted only with openDialogues, as the LAST line, right after YOURCALL_BASIS; singular for one, nonzero parts only', () => {
  const base = JSON.parse(readFileSync(join(FIX, 'fast-on', 'golden-sidecar.json'), 'utf8'));
  base.transcriptPath = join(FIX, 'fast-on', 'transcript.jsonl');
  const plainSheet = facts(base);
  assert.ok(!plainSheet.includes('DIALOGUES:'), 'no key → no line');
  const plainLines = plainSheet.replace(/\s+$/, '').split('\n');
  assert.match(plainLines[plainLines.length - 1], /^YOURCALL_BASIS:/, 'precondition: YOURCALL_BASIS closes the sheet today');
  const S = '; /handover will stop until you decide each one';
  for (const [od, line] of [
    [{ open: 1, unreadable: 0, missing: 0 }, 'DIALOGUES: this session takes part in `1` open dialogue' + S],
    [{ open: 2, unreadable: 0, missing: 0 }, 'DIALOGUES: this session takes part in `2` open dialogues' + S],
    [{ open: 2, unreadable: 1, missing: 0 }, 'DIALOGUES: this session takes part in `2` open dialogues (`1` unreadable)' + S],
    [{ open: 3, unreadable: 0, missing: 2 }, 'DIALOGUES: this session takes part in `3` open dialogues (`2` missing)' + S],
    [{ open: 2, unreadable: 1, missing: 1 }, 'DIALOGUES: this session takes part in `2` open dialogues (`1` unreadable, `1` missing)' + S],
  ]) {
    const sheet = facts({ ...base, openDialogues: od }).replace(/\s+$/, '').split('\n');
    assert.equal(sheet[sheet.length - 1], line, JSON.stringify(od));
    assert.deepEqual(sheet.slice(0, -1), plainLines, `${JSON.stringify(od)}: every other line is what it is without the key`);
  }
});
