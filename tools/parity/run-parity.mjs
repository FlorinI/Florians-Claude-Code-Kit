// run-parity.mjs — the rendering golden test for the Node status line.
//
// For every fixture under tools/parity/fixtures/<name>/, feed the fixture stdin to the Node renderer
// (home/statusline.mjs) and compare against committed goldens:
//   1. rendered stdout  — must be BYTE-IDENTICAL to golden.txt (this is what the user sees).
//   2. the project-local sidecar JSON — STRUCTURALLY equal (float tolerance) to golden-sidecar.json.
//
// Run `node tools/parity/run-parity.mjs` (or `npm run parity`) to check; pass `--bless` to (re)write
// the goldens from the current Node output — do that only when the change in output is intended.
// Optionally pass a fixture name to limit to one: `node ... run-parity.mjs --bless small-young`.
//
// Determinism: the engine runs in its OWN temp HOME + temp project dir (so the dual sidecar,
// per-session stats, agent rollups and daily counter land in throwaway dirs and never touch the real
// machine), reads the SAME read-only transcript (so file mtime/ctime are stable), and gets a FROZEN
// clock via CLAUDE_SL_NOW_EPOCH (from the fixture's meta.json) plus TZ=UTC. See tools/parity/capture.md.
//
// A fixture dir contains:
//   stdin.json          — the CC stdin payload (transcript_path + workspace.current_dir are rewritten).
//   meta.json           — { nowEpoch: <epoch seconds> } and optionally { env: {...} }.
//   transcript.jsonl    — (optional) the session transcript; the engine reads this exact file.
//   seed/               — (optional) files copied into <tempCwd>/.claude/ before the run (e.g.
//                         statusline-stats/<id>.json) to exercise the incremental byte-offset path.
//   home-seed/          — (optional) files copied into <tempHome>/.claude/ (e.g. stats-cache.json).
//   golden.txt          — committed reference stdout bytes (written by --bless).
//   golden-sidecar.json — committed reference sidecar JSON (written by --bless).

import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync,
  readdirSync, copyFileSync, statSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const fixturesDir = join(here, 'fixtures');
const nodeScript = join(repo, 'home', 'statusline.mjs');

const FLOAT_TOL = 1e-9;

// Two levels of normalization, because the golden sidecar has two jobs: it is what this runner
// COMPARES against, and it is also the frozen snapshot run-trio-parity.mjs FEEDS to the trio. So a
// field the comparison can ignore is not automatically a field the file may omit.
//
// normPaths — applied on both sides of the comparison AND to what `--bless` writes. Both paths
// point into this run's throwaway temp directories, so writing them verbatim put a fresh random
// path in the committed golden on every bless: files changing with no change in behaviour, and a
// diff a reviewer has to sift for the real edits. The trio overwrites both fields before use.
// Idempotent — the basename of a basename is itself, so re-normalizing a golden is a no-op.
const normPaths = (s) => {
  if (!s || typeof s !== 'object') return s;
  const out = { ...s };
  if (typeof out.transcriptPath === 'string') out.transcriptPath = out.transcriptPath.replace(/\\/g, '/').split('/').pop();
  if (typeof out.agentsCachePath === 'string') out.agentsCachePath = out.agentsCachePath.replace(/\\/g, '/').split('/').pop();
  return out;
};
// normSidecar — comparison only. aliveSec / activityPct derive from the transcript FILE's birthtime
// (statSync), which git checkout / copy resets to "now", so the raw value differs on every clone.
// The render clamps it, so stdout stays stable; only the raw sidecar value is unstable. They must
// still be WRITTEN, because handover-facts reads activityPct out of the frozen snapshot and states
// it — drop them from the file and the trio's ACTIVITY line changes.
const normSidecar = (s) => {
  const out = normPaths(s);
  if (!out || typeof out !== 'object') return out;
  delete out.aliveSec;
  delete out.activityPct;
  return out;
};

function copyDirInto(srcDir, dstDir) {
  if (!existsSync(srcDir)) return;
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name);
    const d = join(dstDir, name);
    if (statSync(s).isDirectory()) { mkdirSync(d, { recursive: true }); copyDirInto(s, d); }
    else copyFileSync(s, d);
  }
}

// Latest "timestamp":"…" in a transcript, as epoch ms (UTC ISO strings). Used to pin the file's
// mtime so the mtime-derived `tps` is reproducible across checkouts.
function latestTimestampMs(file) {
  let max = null;
  const re = /"timestamp"\s*:\s*"([^"]+)"/g;
  const text = readFileSync(file, 'utf8');
  let m;
  while ((m = re.exec(text)) !== null) {
    const ms = Date.parse(m[1]);
    if (!Number.isNaN(ms) && (max === null || ms > max)) max = ms;
  }
  return max;
}

function runNode(fixDir, stdinObj, nowEpoch, extraEnv) {
  const tempHome = mkdtempSync(join(tmpdir(), 'slgolden-home-'));
  const tempCwd = mkdtempSync(join(tmpdir(), 'slgolden-cwd-'));
  mkdirSync(join(tempHome, '.claude'), { recursive: true });
  mkdirSync(join(tempCwd, '.claude'), { recursive: true });
  copyDirInto(join(fixDir, 'home-seed'), join(tempHome, '.claude'));
  copyDirInto(join(fixDir, 'seed'), join(tempCwd, '.claude'));

  const stdin = structuredClone(stdinObj);
  const transcript = join(fixDir, 'transcript.jsonl');
  if (existsSync(transcript)) {
    stdin.transcript_path = transcript;
    // The engine derives `tps` (tokens/sec) from the transcript FILE's mtime. git checkout / copy
    // reset mtime to "now", which is non-reproducible and breaks the golden across machines / CI.
    // Pin mtime to the transcript's latest message timestamp (content-derived → deterministic, and
    // the semantically correct "turn end"). Applied for both --bless and check, so goldens match.
    const endMs = latestTimestampMs(transcript);
    if (endMs != null) { const s = endMs / 1000; utimesSync(transcript, s, s); }
  }
  stdin.workspace = stdin.workspace || {};
  stdin.workspace.current_dir = tempCwd;
  if ('cwd' in stdin) stdin.cwd = tempCwd;

  const env = {
    ...process.env,
    USERPROFILE: tempHome,
    HOME: tempHome,
    // POSITIVE pin, never a delete: the cluster resolves its user config home from
    // CLAUDE_CONFIG_DIR when set, so a value inherited from the surrounding shell (a session
    // launched against a second subscription) would make the child read that home's settings.json
    // and write its caches there — nondeterministic goldens plus pollution outside the temp home.
    // Pinning it to the temp home's .claude makes the run identical from any session.
    CLAUDE_CONFIG_DIR: join(tempHome, '.claude'),
    CLAUDE_PROJECT_DIR: tempCwd,
    TZ: 'UTC',
    CLAUDE_SL_NOW_EPOCH: String(nowEpoch),
  };
  // Inherited shell value must not flip goldens; a fixture that needs it sets it via meta.env.
  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  Object.assign(env, extraEnv || {});

  let stdout = execFileSync(process.execPath, [nodeScript],
    { input: JSON.stringify(stdin), env, maxBuffer: 64 * 1024 * 1024 });
  // strip a leading UTF-8 BOM if a shell inserts one (we want the rendered bytes only)
  if (stdout.length >= 3 && stdout[0] === 0xEF && stdout[1] === 0xBB && stdout[2] === 0xBF) {
    stdout = stdout.subarray(3);
  }

  const sidecarPath = join(tempCwd, '.claude', 'statusline-last.json');
  let sidecar = null;
  if (existsSync(sidecarPath)) {
    try { sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')); } catch { sidecar = '<unparseable>'; }
  }
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
  return { stdout, sidecar };
}

// Structural compare with float tolerance + key-set equality.
function diffStruct(a, b, path = '') {
  const diffs = [];
  if (a === b) return diffs;
  const ta = a === null ? 'null' : typeof a;
  const tb = b === null ? 'null' : typeof b;
  if (ta === 'number' && tb === 'number') {
    if (Math.abs(a - b) > FLOAT_TOL) diffs.push(`${path}: ${a} != ${b}`);
    return diffs;
  }
  if (ta !== tb) { diffs.push(`${path}: type ${ta} != ${tb} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`); return diffs; }
  if (ta === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) { diffs.push(`${path}: array-ness differs`); return diffs; }
    if (Array.isArray(a)) {
      if (a.length !== b.length) diffs.push(`${path}: array length ${a.length} != ${b.length}`);
      for (let i = 0; i < Math.max(a.length, b.length); i++) diffs.push(...diffStruct(a[i], b[i], `${path}[${i}]`));
      return diffs;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) { diffs.push(`${path}.${k}: missing in golden`); continue; }
      if (!(k in b)) { diffs.push(`${path}.${k}: missing in output`); continue; }
      diffs.push(...diffStruct(a[k], b[k], `${path}.${k}`));
    }
    return diffs;
  }
  if (a !== b) diffs.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  return diffs;
}

function hexDiff(golden, out) {
  const n = Math.min(golden.length, out.length);
  let i = 0;
  while (i < n && golden[i] === out[i]) i++;
  const start = Math.max(0, i - 16);
  const slice = (buf) => Array.from(buf.subarray(start, i + 24)).map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const decode = (buf) => JSON.stringify(buf.subarray(start, i + 24).toString('utf8'));
  return [
    `  first byte diff at offset ${i} (golden len ${golden.length}, output len ${out.length})`,
    `  golden: ${slice(golden)}`,
    `  output: ${slice(out)}`,
    `  golden: ${decode(golden)}`,
    `  output: ${decode(out)}`,
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const bless = args.includes('--bless');
  const only = args.find((a) => !a.startsWith('--')); // optional fixture name filter
  if (!existsSync(nodeScript)) {
    console.error(`Node renderer not found: ${nodeScript}`);
    process.exit(2);
  }
  if (!existsSync(fixturesDir)) {
    console.error(`No fixtures dir: ${fixturesDir}`);
    process.exit(2);
  }
  const fixtures = readdirSync(fixturesDir)
    .filter((n) => statSync(join(fixturesDir, n)).isDirectory())
    .filter((n) => !only || n === only)
    .sort();
  if (fixtures.length === 0) { console.error('No fixtures found.'); process.exit(2); }

  const results = [];
  for (const name of fixtures) {
    const fixDir = join(fixturesDir, name);
    const stdinObj = JSON.parse(readFileSync(join(fixDir, 'stdin.json'), 'utf8'));
    const meta = existsSync(join(fixDir, 'meta.json'))
      ? JSON.parse(readFileSync(join(fixDir, 'meta.json'), 'utf8')) : {};
    const nowEpoch = meta.nowEpoch ?? Math.floor(Date.now() / 1000);
    const goldenStdoutPath = join(fixDir, 'golden.txt');
    const goldenSidecarPath = join(fixDir, 'golden-sidecar.json');

    let out, err = null;
    try {
      out = runNode(fixDir, stdinObj, nowEpoch, meta.env);
    } catch (e) {
      err = e.stderr ? e.stderr.toString() : e.message;
    }
    if (err) { results.push({ name, ok: false, detail: `ERROR running engine:\n${err}` }); continue; }

    if (bless) {
      writeFileSync(goldenStdoutPath, out.stdout);
      writeFileSync(goldenSidecarPath, JSON.stringify(normPaths(out.sidecar), null, 2) + '\n', 'utf8');
      results.push({ name, ok: true, detail: 'blessed' });
      continue;
    }

    if (!existsSync(goldenStdoutPath) || !existsSync(goldenSidecarPath)) {
      results.push({ name, ok: false, detail: 'no golden — run with --bless to create it' });
      continue;
    }
    const goldenStdout = readFileSync(goldenStdoutPath);
    const goldenSidecar = JSON.parse(readFileSync(goldenSidecarPath, 'utf8'));
    // The trailing `bsl<ver>` badge is the auto-ticked build number (set by the installer), orthogonal to
    // rendering — normalize it on both sides so a build bump never fails the golden test.
    const normVer = (buf) => buf.toString('utf8').replace(/bsl\d+(?:\.\d+)+/g, 'bsl<ver>');
    const stdoutOk = normVer(goldenStdout) === normVer(out.stdout);
    const sidecarDiffs = diffStruct(normSidecar(goldenSidecar), normSidecar(out.sidecar), 'sidecar');
    const ok = stdoutOk && sidecarDiffs.length === 0;
    let detail = '';
    if (!stdoutOk) detail += `STDOUT mismatch:\n${hexDiff(goldenStdout, out.stdout)}\n`;
    if (sidecarDiffs.length) detail += `SIDECAR mismatch (${sidecarDiffs.length}):\n  ${sidecarDiffs.slice(0, 30).join('\n  ')}\n`;
    results.push({ name, ok, detail });
  }

  console.log(`\n=== ${bless ? 'bless' : 'golden'} results ===`);
  let failed = 0;
  for (const r of results) {
    console.log(`${bless ? 'WROTE' : (r.ok ? 'PASS' : 'FAIL')}  ${r.name}`);
    if (!r.ok) { failed++; console.log(r.detail.split('\n').map((l) => '    ' + l).join('\n')); }
  }
  console.log(`\n${results.length - failed}/${results.length} ${bless ? 'written' : 'passed'}`);
  process.exit(failed ? 1 : 0);
}

main();
