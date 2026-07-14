#!/usr/bin/env node
// claude-launch.mjs — cross-platform Claude Code launcher.
//
// Titles + colors the terminal tab from the CURRENT project's identity and applies per-project
// model/effort, then launches Claude Code. Operates on the current directory, so ONE deployed copy
// (~/.claude/claude-launch.mjs) serves every project — invoked via a tiny `cc` shell function the
// installer adds to your shell profile ($PROFILE on Windows, ~/.zshrc or ~/.bashrc on macOS/Linux).
//
// Reads <cwd>/.claude/session-identity.json:
//   name   -> session name/title via `--name <name>@<branch>`, ALWAYS. Falls back through three tiers:
//             identity name -> repo name (origin slug, else git top-level folder) -> cwd folder leaf.
//             --name is a flag, so it sets the prompt box / /resume picker / terminal title without
//             ever colliding with a user prompt.
//   color  -> the terminal tab background (best-effort, per terminal: Windows Terminal & iTerm2) AND
//             the Claude session color via a "/color <color>" initial prompt — but the initial-prompt
//             slot holds one thing, so /color is injected only when the user supplied no prompt.
//   model  -> `--model <model>`  if set
//   effort -> `--effort <level>` if set
//
// Title/name = <identity name | repo name | folder leaf>@<branch>.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const ESC = '\x1b';
const BEL = '\x07';
const loc = process.cwd();

// --- identity ---------------------------------------------------------------------------------
let id = {};
try { id = JSON.parse(readFileSync(join(loc, '.claude', 'session-identity.json'), 'utf8')) || {}; } catch {}
const idName = typeof id.name === 'string' ? id.name.trim() : '';
const idColor = typeof id.color === 'string' ? id.color.trim() : '';
const idModel = typeof id.model === 'string' ? id.model.trim() : '';
const idEffort = typeof id.effort === 'string' ? id.effort.trim() : '';

// --- git branch + repo slug -------------------------------------------------------------------
function git(args) {
  try { return execFileSync('git', args, { cwd: loc, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}
let branch = git(['branch', '--show-current']) || git(['rev-parse', '--short', 'HEAD']);

// Session name falls back through three tiers: identity name -> repo name -> folder leaf.
const folder = loc.split(/[\\/]/).filter(Boolean).pop() || loc;   // 3rd: current directory leaf
let repo = '';                                                    // 2nd: the git repo's own name
const origin = git(['config', '--get', 'remote.origin.url']);
if (origin) { const m = origin.replace(/\.git$/, '').match(/([^:/]+)$/); if (m) repo = m[1]; }
if (!repo) { const top = git(['rev-parse', '--show-toplevel']); if (top) repo = top.split(/[\\/]/).filter(Boolean).pop() || ''; }
const base = idName || repo || folder;                            // 1st: explicit /identity name
const title = branch ? `${base}@${branch}` : base;

// --- terminal title (OSC 2 — portable) + tab color (per terminal) -----------------------------
function termWrite(seq) { try { if (process.stdout.isTTY) process.stdout.write(seq); } catch {} }
if (title) termWrite(`${ESC}]2;${title}${BEL}`);

// Identity color names (Claude Code's /color palette) -> RGB.
const COLORS = {
  red: [204, 51, 51], orange: [217, 122, 30], yellow: [217, 194, 46], green: [60, 168, 75],
  blue: [47, 116, 208], purple: [138, 79, 196], pink: [209, 95, 156], cyan: [54, 168, 184],
  gray: [122, 122, 122], grey: [122, 122, 122], white: [204, 204, 204],
};
const rgb = idColor ? COLORS[idColor.toLowerCase()] : null;
if (rgb) {
  const [r, g, b] = rgb;
  if (process.env.WT_SESSION) {
    // Windows Terminal: OSC 4 sets palette index 264 = the tab background. Persists all session.
    const hx = (n) => n.toString(16).padStart(2, '0');
    termWrite(`${ESC}]4;264;rgb:${hx(r)}/${hx(g)}/${hx(b)}${ESC}\\`);
  } else if (process.env.TERM_PROGRAM === 'iTerm.app') {
    // iTerm2: proprietary OSC 6 tab color, one sequence per RGB component.
    termWrite(`${ESC}]6;1;bg;red;brightness;${r}${BEL}`);
    termWrite(`${ESC}]6;1;bg;green;brightness;${g}${BEL}`);
    termWrite(`${ESC}]6;1;bg;blue;brightness;${b}${BEL}`);
  }
  // Other terminals (Terminal.app, gnome-terminal, …) have no portable tab-bg escape — skip. The
  // /color initial prompt below still tints Claude's own UI there.
}

// --- build the claude command line ------------------------------------------------------------
const cli = [];
if (idModel) cli.push('--model', idModel);
if (idEffort) cli.push('--effort', idEffort);
if (title) cli.push('--name', title);            // always set the session name/title (a flag)
const userArgs = process.argv.slice(2);
cli.push(...userArgs);

// The single initial-prompt slot carries "/color <color>" — injected ONLY when the user gave no
// prompt of their own. Flags (and their values, per `claude --help`) are not a prompt, so `cc --chrome`
// still self-colors but `cc "do X"` is left untouched. Unknown flags are treated as boolean — a
// mis-read only skips the /color, never clobbers a real prompt.
const VALUE_FLAGS = new Set([
  '--add-dir', '--agent', '--agents', '--allowed-tools', '--append-system-prompt', '--betas',
  '--debug-file', '--disallowed-tools', '--effort', '--fallback-model', '--file', '--input-format',
  '--json-schema', '--max-budget-usd', '--mcp-config', '--model', '--name', '--output-format',
  '--permission-mode', '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix',
  '--session-id', '--setting-sources', '--settings', '--system-prompt', '--tools',
]);
let userHasPrompt = false;
for (let i = 0; i < userArgs.length; i++) {
  const a = userArgs[i];
  if (a.startsWith('-')) {
    const name = a.split('=')[0];
    if (VALUE_FLAGS.has(name) && !a.includes('=')) i++;   // consume the flag's value
    continue;
  }
  userHasPrompt = true; break;                            // a bare positional = the user's prompt
}
if (!userHasPrompt && idColor) cli.push(`/color ${idColor}`);

// --- resolve + launch claude ------------------------------------------------------------------
// CC's own env-truthiness convention: only '1' / 'true' / 'yes' / 'on' (lowercased, trimmed) are
// truthy; every other value — '0', 'off', '', junk — is falsy. Kept local; this file has no deps.
function EnvTruthy(v) { return v != null && ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase().trim()); }

// PATH + PATHEXT-aware executable resolver (Windows shims are .cmd/.bat, not bare names).
function resolveOnPath(name) {
  const PATH = process.env.PATH || '';
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try { if (existsSync(p) && statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}
const claudePath = resolveOnPath('claude');
if (!claudePath) { console.error('claude executable not found on PATH.'); process.exit(1); }

// Windows .cmd/.bat shims must be run through the shell; native binaries spawn directly.
function shimVector(exe, args) {
  const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
  return viaCmd ? [process.env.ComSpec || 'cmd.exe', '/c', exe, ...args] : [exe, ...args];
}
const claudeArgv = shimVector(claudePath, cli);

// --- VS Code co-launch (env-gated; default off) -------------------------------------------------
// CC_VSCODE truthy → open VS Code on this project, detached, before claude launches. Exactly one
// *.code-workspace at the cwd root opens that workspace; zero or multiple open the folder (never
// guess between two). `code` missing from PATH → skip silently. The claude launch never waits on
// or fails because of this step.
const VS_SPAWN_OPTS = { detached: true, stdio: 'ignore' };
let vsPlan = { action: 'off', target: null, exe: null };
if (EnvTruthy(process.env.CC_VSCODE)) {
  let action = 'folder', target = '.';
  try {
    const ws = readdirSync(loc).filter((n) => n.toLowerCase().endsWith('.code-workspace'));
    if (ws.length === 1) { action = 'workspace'; target = ws[0]; }
  } catch {}
  const codePath = resolveOnPath('code');
  vsPlan = codePath ? { action, target, exe: codePath } : { action: 'skip-no-cli', target: null, exe: null };
}

// --- dry-run seam: print the launch plan as ONE JSON line, spawn nothing ------------------------
if (EnvTruthy(process.env.CC_LAUNCH_DRYRUN)) {
  process.stdout.write(JSON.stringify({
    vscode: { action: vsPlan.action, target: vsPlan.target, spawnOpts: { ...VS_SPAWN_OPTS, unref: true } },
    claude: { argv: claudeArgv },
  }) + '\n');
  process.exit(0);
}

if (vsPlan.exe) {
  try {
    const [vsExe, ...vsArgs] = shimVector(vsPlan.exe, [vsPlan.target]);
    spawn(vsExe, vsArgs, VS_SPAWN_OPTS).unref();   // the one VS Code spawn site
  } catch { /* never block or fail the claude launch */ }
}

const res = spawnSync(claudeArgv[0], claudeArgv.slice(1), { stdio: 'inherit' });
process.exit(typeof res.status === 'number' ? res.status : (res.error ? 1 : 0));
