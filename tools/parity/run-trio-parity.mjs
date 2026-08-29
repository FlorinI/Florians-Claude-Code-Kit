// run-trio-parity.mjs — golden regression test for the /handover-check trio (Node).
//
// For every fixture under tools/parity/fixtures/<name>/, feed the fixture's golden-sidecar.json as the
// frozen snapshot (transcriptPath rewritten to the fixture transcript) and run the three Node renderers:
//   handover-facts.mjs       → golden-facts.txt
//   render-legspark.mjs      → golden-legspark.txt  (--mono --frozen)
//   render-spikes.mjs        → golden-spikes.txt    (--mono --frozen)
// Output must be BYTE-IDENTICAL to the committed goldens. Run `node tools/parity/run-trio-parity.mjs`
// (pass `--bless` to write goldens; pass a fixture name to limit to one).
//
// This is the Node-only regression lock on the trio. The Node↔PowerShell EQUIVALENCE was established
// once on a live session at cutover (the pwsh trio was retired in the same change); these goldens guard
// against future drift. Determinism mirrors run-parity.mjs: a throwaway temp HOME + project dir, the
// fixture's frozen nowEpoch (CLAUDE_SL_NOW_EPOCH) + TZ=UTC, and CLAUDE_CODE_SESSION_ID UNSET so the
// FOREIGN ownership guard doesn't fire on the harness's own session id.
//
// Fixtures WITH sub-agents (transcript/subagents/) first run the status-line engine once into the temp
// cwd — same stdin rewrite, seeds and env as run-parity.mjs — so the agents cache exists there; the golden
// sidecar's agentsCachePath is then rewritten to that temp cache and render-spikes renders the agent
// panel. Fixtures without agents keep the plain path (no engine run).

import {
  readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync, statSync,
  copyFileSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const fixturesDir = join(here, 'fixtures');
const homeDir = join(repo, 'home');
const SCRIPTS = {
  facts: { file: join(homeDir, 'handover-facts.mjs'), args: [], golden: 'golden-facts.txt' },
  legspark: { file: join(homeDir, 'render-legspark.mjs'), args: ['--mono', '--frozen'], golden: 'golden-legspark.txt' },
  spikes: { file: join(homeDir, 'render-spikes.mjs'), args: ['--mono', '--frozen'], golden: 'golden-spikes.txt' },
};

const engineScript = join(homeDir, 'statusline.mjs');

function copyDirInto(srcDir, dstDir) {
  if (!existsSync(srcDir)) return;
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name);
    const d = join(dstDir, name);
    if (statSync(s).isDirectory()) { mkdirSync(d, { recursive: true }); copyDirInto(s, d); }
    else copyFileSync(s, d);
  }
}

// Latest "timestamp" in the transcript (epoch ms) — pins the file mtime like run-parity.mjs does.
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

// One engine render into the temp dirs (mirrors run-parity.mjs's runNode) — used only for fixtures
// with sub-agents, so their agents cache exists under <tempCwd>/.claude/statusline-stats/.
function preRunEngine(fixDir, tempHome, tempCwd, transcript, env, meta) {
  copyDirInto(join(fixDir, 'home-seed'), join(tempHome, '.claude'));
  copyDirInto(join(fixDir, 'seed'), join(tempCwd, '.claude'));
  const stdin = JSON.parse(readFileSync(join(fixDir, 'stdin.json'), 'utf8'));
  stdin.transcript_path = transcript;
  const endMs = latestTimestampMs(transcript);
  if (endMs != null) { const s = endMs / 1000; utimesSync(transcript, s, s); }
  stdin.workspace = stdin.workspace || {};
  stdin.workspace.current_dir = tempCwd;
  if ('cwd' in stdin) stdin.cwd = tempCwd;
  execFileSync(process.execPath, [engineScript],
    { input: JSON.stringify(stdin), env: { ...env, ...(meta.env || {}) }, maxBuffer: 64 * 1024 * 1024 });
}

function runTrio(fixDir, nowEpoch, meta) {
  const tempHome = mkdtempSync(join(tmpdir(), 'trio-home-'));
  const tempCwd = mkdtempSync(join(tmpdir(), 'trio-cwd-'));
  mkdirSync(join(tempHome, '.claude'), { recursive: true });
  mkdirSync(join(tempCwd, '.claude'), { recursive: true });

  try {
    const env = {
      ...process.env,
      USERPROFILE: tempHome,
      HOME: tempHome,
      // POSITIVE pin, never a delete — see run-parity.mjs. The trio reads/writes handover-frozen.json,
      // legspark.ansi and spikes.txt under the resolved config home, so an inherited CLAUDE_CONFIG_DIR
      // would both perturb the goldens and write outside the temp home.
      CLAUDE_CONFIG_DIR: join(tempHome, '.claude'),
      CLAUDE_PROJECT_DIR: tempCwd,
      TZ: 'UTC',
      CLAUDE_SL_NOW_EPOCH: String(nowEpoch),
    };
    delete env.CLAUDE_CODE_SESSION_ID; // else the FOREIGN guard fires on the harness's own session

    // Frozen snapshot = the fixture's golden sidecar, with transcriptPath pointed at the fixture transcript.
    const sidecar = JSON.parse(readFileSync(join(fixDir, 'golden-sidecar.json'), 'utf8'));
    const transcript = join(fixDir, 'transcript.jsonl');
    if (existsSync(transcript)) sidecar.transcriptPath = transcript;
    else sidecar.transcriptPath = null;
    // Sub-agent fixtures: pre-run the engine so the agents cache exists in the temp cwd, then point the
    // golden sidecar's agentsCachePath at it (the committed path is a long-deleted temp dir).
    if (existsSync(transcript) && existsSync(join(fixDir, 'transcript', 'subagents'))) {
      preRunEngine(fixDir, tempHome, tempCwd, transcript, env, meta);
      if (sidecar.sessionId) sidecar.agentsCachePath = join(tempCwd, '.claude', 'statusline-stats', `${sidecar.sessionId}.agents.json`);
    }
    // handover-facts reads the live sidecar (project-local) then freezes it; render-* read the freeze.
    // (Written AFTER the pre-run, so the trio sees the committed golden, not the engine's fresh sidecar.)
    writeFileSync(join(tempCwd, '.claude', 'statusline-last.json'), JSON.stringify(sidecar), 'utf8');

    const out = {};
    for (const [key, spec] of Object.entries(SCRIPTS)) {
      const buf = execFileSync(process.execPath, [spec.file, ...spec.args],
        { env, maxBuffer: 64 * 1024 * 1024 });
      out[key] = buf.toString('utf8');
    }
    return out;
  } finally {
    // Cleanup runs on the throw path too — a failing fixture must not strand temp dirs.
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempCwd, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const bless = args.includes('--bless');
  const only = args.find((a) => !a.startsWith('--'));
  const fixtures = readdirSync(fixturesDir)
    .filter((n) => statSync(join(fixturesDir, n)).isDirectory())
    // A fixture is a directory that contains stdin.json — a stray dir (scratch, editor leftovers) is not one.
    .filter((n) => existsSync(join(fixturesDir, n, 'stdin.json')))
    .filter((n) => !only || n === only)
    .sort();

  const results = [];
  for (const name of fixtures) {
    const fixDir = join(fixturesDir, name);
    const meta = existsSync(join(fixDir, 'meta.json'))
      ? JSON.parse(readFileSync(join(fixDir, 'meta.json'), 'utf8')) : {};
    const nowEpoch = meta.nowEpoch ?? Math.floor(Date.now() / 1000);

    let out, err = null;
    try { out = runTrio(fixDir, nowEpoch, meta); }
    catch (e) { err = e.stderr ? e.stderr.toString() : e.message; }
    if (err) { results.push({ name, ok: false, detail: `ERROR:\n${err}` }); continue; }

    if (bless) {
      for (const spec of Object.values(SCRIPTS)) writeFileSync(join(fixDir, spec.golden), out[Object.keys(SCRIPTS).find((k) => SCRIPTS[k] === spec)], 'utf8');
      results.push({ name, ok: true, detail: 'blessed' });
      continue;
    }

    const fails = [];
    for (const [key, spec] of Object.entries(SCRIPTS)) {
      const gp = join(fixDir, spec.golden);
      if (!existsSync(gp)) { fails.push(`${key}: no golden — run --bless`); continue; }
      const golden = readFileSync(gp, 'utf8');
      if (golden !== out[key]) {
        let i = 0; while (i < golden.length && i < out[key].length && golden[i] === out[key][i]) i++;
        fails.push(`${key}: mismatch at char ${i}\n      golden: ${JSON.stringify(golden.slice(Math.max(0, i - 10), i + 30))}\n      output: ${JSON.stringify(out[key].slice(Math.max(0, i - 10), i + 30))}`);
      }
    }
    results.push({ name, ok: fails.length === 0, detail: fails.join('\n    ') });
  }

  console.log(`\n=== ${bless ? 'bless' : 'trio golden'} results ===`);
  let failed = 0;
  for (const r of results) {
    console.log(`${bless ? 'WROTE' : (r.ok ? 'PASS' : 'FAIL')}  ${r.name}`);
    if (!r.ok) { failed++; console.log('    ' + r.detail); }
  }
  console.log(`\n${results.length - failed}/${results.length} ${bless ? 'written' : 'passed'}`);
  process.exit(failed ? 1 : 0);
}

main();
