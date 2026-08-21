#!/usr/bin/env node
// claude-launch.mjs — cross-platform Claude Code launcher.
//
// Titles + colors the terminal tab from the CURRENT project's identity and applies per-project
// model/effort, then launches Claude Code. Operates on the current directory, so ONE deployed copy
// (~/.claude/claude-launch.mjs) serves every project — invoked via a tiny `cc` shell function the
// installer adds to your shell profile ($PROFILE on Windows, ~/.zshrc or ~/.bashrc on macOS/Linux).
//
// Reads <cwd>/.claude/session-identity.json:
//   name   -> session name/title via `--name <name>@<branch>` on a FRESH launch; omitted when the
//             user's argv is resume-shaped, so Claude Code restores that session's own stored name.
//             Falls back through three tiers: identity name -> repo name (origin slug, else git
//             top-level folder) -> cwd folder leaf. --name is a flag, so it sets the prompt box /
//             /resume picker / terminal title without ever colliding with a user prompt.
//   color  -> the terminal tab background (best-effort, per terminal: Windows Terminal & iTerm2) AND
//             the Claude session color via a "/color <color>" initial prompt — but the initial-prompt
//             slot holds one thing, so /color is injected only when the user supplied no prompt.
//   model  -> `--model <model>`  if set
//   effort -> `--effort <level>` if set
//
// Title/name = [<title-prefix>] <identity name | repo name | folder leaf>@<branch> [<title-suffix>].
//
// Launcher-owned flags (self-consumed — never forwarded to claude, never seen by the prompt scan):
//   --config-dir <path>    run claude against another config home (CLAUDE_CONFIG_DIR, child env only)
//   --title-prefix <text>  prepend to the title   --title-suffix <text>  append to the title
//   --no-vscode            force the VS Code co-launch (and tiling) off regardless of CC_VSCODE
//   --print-title / --print-tabcolor   the shell-function seams (see below)

import { readFileSync, existsSync, statSync, readdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const ESC = '\x1b';
const BEL = '\x07';
const loc = process.cwd();

// --- launcher's own flags (self-consumed) -------------------------------------------------------
// Four flags belong to the LAUNCHER, not to claude. They are stripped from the argv forwarded to
// claude AND from the prompt scan, so `cc --config-dir <d> "do X"` still detects "do X" as the
// user's prompt (and therefore still suppresses the /color injection). Because they never reach the
// scan they need no VALUE_FLAGS entry. Malformed input is inert, never fatal: a value-taking flag
// given as the last element is ignored and still stripped.
//
//   --config-dir <path>    launch claude against a different config home (CLAUDE_CONFIG_DIR in the
//                          SPAWNED CHILD's env only). `~/` or `~\` expands; the result is absolute.
//   --title-prefix <text>  prepended to the computed title, one space separator
//   --title-suffix <text>  appended to the computed title, one space separator
//   --no-vscode            force the VS Code co-launch (and hence tiling) off, whatever CC_VSCODE says
//
// Prefix/suffix are deliberately generic: `--config-dir` alone changes NOTHING visually. A caller
// that wants a visual marker for a second subscription opts into it explicitly.
function expandTilde(p) {
  const s = String(p);
  return (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) ? join(homedir(), s.slice(1)) : s;
}
function parseLauncherFlags(argv) {
  const o = { configDir: null, titlePrefix: '', titleSuffix: '', noVsCode: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-vscode') { o.noVsCode = true; continue; }
    if (a === '--config-dir' || a === '--title-prefix' || a === '--title-suffix') {
      const v = argv[i + 1];
      i++;                                       // consume the value (or fall off the end — inert)
      if (v == null) continue;
      if (a === '--config-dir') o.configDir = resolve(expandTilde(v));
      else if (a === '--title-prefix') o.titlePrefix = v;
      else o.titleSuffix = v;
      continue;
    }
    o.rest.push(a);
  }
  return o;
}
const flags = parseLauncherFlags(process.argv.slice(2));

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
const core = branch ? `${base}@${branch}` : base;
// ONE title computation, upstream of every consumer — the --print-title seam, the OSC 2 paints, the
// `--name` handed to claude, and the tiler's titleMatch. So a marker supplied by the caller rides
// into all of them by construction, with no second place to drift out of sync.
const title = [flags.titlePrefix, core, flags.titleSuffix].filter(Boolean).join(' ');

// --- `--print-title` seam: emit the resolved title and exit, nothing else ---------------------
// The shell `cc` function calls this after Claude Code exits so that PWSH ITSELF re-owns the tab
// title. A title set by a child process (this launcher, or claude) reverts the moment the child
// exits — Windows Terminal falls back to the shell's own title, i.e. the profile default
// ("PowerShell"). Only the shell process setting $Host.UI.RawUI.WindowTitle makes it stick. So the
// launcher exposes the computed title here; the shell writes it. Early-exit BEFORE any OSC / color /
// VS Code / claude side effect — this call prints one line and does nothing else.
if (flags.rest.includes('--print-title')) { process.stdout.write(title); process.exit(0); }

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
const hx = (n) => n.toString(16).padStart(2, '0');
// Windows Terminal paints the tab background via OSC 4 palette index 264. Computed once, then used
// both to paint the tab live (below) AND handed back to the shell via `--print-tabcolor` so PWSH can
// re-paint after CC exits. Empty string when there's no color or we're not in Windows Terminal.
const wtTabColorOSC = (rgb && process.env.WT_SESSION)
  ? `${ESC}]4;264;rgb:${hx(rgb[0])}/${hx(rgb[1])}/${hx(rgb[2])}${ESC}\\`
  : '';

// --- `--print-tabcolor` seam: echo the WT tab-color escape and exit ---------------------------
// Companion to `--print-title`. Windows Terminal reverts a child-set tab color the moment the child
// (this launcher / claude) exits, so the tab drops its identity color when CC quits. The shell `cc`
// function re-emits this escape from PWSH ITSELF after CC returns — the shell process outlives CC, so
// the color sticks past the session exactly as $Host.UI.RawUI.WindowTitle makes the title stick.
// Prints nothing on non-WT terminals or when no color is set.
if (flags.rest.includes('--print-tabcolor')) { process.stdout.write(wtTabColorOSC); process.exit(0); }

if (rgb) {
  const [r, g, b] = rgb;
  if (process.env.WT_SESSION) {
    // Windows Terminal: OSC 4 sets palette index 264 = the tab background. Reverts on child exit —
    // the shell re-emits it via --print-tabcolor to make it persist past the session.
    termWrite(wtTabColorOSC);
  } else if (process.env.TERM_PROGRAM === 'iTerm.app') {
    // iTerm2: proprietary OSC 6 tab color, one sequence per RGB component. iTerm keeps a child's tab
    // color after the child exits, so it needs no shell re-emit — the live paint is enough.
    termWrite(`${ESC}]6;1;bg;red;brightness;${r}${BEL}`);
    termWrite(`${ESC}]6;1;bg;green;brightness;${g}${BEL}`);
    termWrite(`${ESC}]6;1;bg;blue;brightness;${b}${BEL}`);
  }
  // Other terminals (Terminal.app, gnome-terminal, …) have no portable tab-bg escape — skip. The
  // /color initial prompt below still tints Claude's own UI there.
}

// --- build the claude command line ------------------------------------------------------------
// Flags that mean "continue an EXISTING session". Claude Code persists a session's display name and
// restores it on resume when `--name` is absent — but passing `--name` overwrites the restored name,
// destroying any `: <topic>` suffix the user had set via /rename. So on a resume-shaped argv the
// launcher stays out of the way and pushes no `--name`. Matched on the flag NAME, so `--resume <id>`
// and `--resume=<id>` both count. Deliberately excluded: `--session-id` (names a NEW session),
// `--cloud` (a bare description creates a new session), `--fork-session` (never appears without
// `--resume`/`--continue`, so it is covered transitively).
const RESUME_FLAGS = new Set(['-r', '--resume', '-c', '--continue', '--from-pr', '--teleport']);
const isResume = flags.rest.some((a) => RESUME_FLAGS.has(a.split('=')[0]));

const cli = [];
if (idModel) cli.push('--model', idModel);
if (idEffort) cli.push('--effort', idEffort);
if (title && !isResume) cli.push('--name', title);   // fresh launch only — a resume keeps its own name
const userArgs = flags.rest;                     // the launcher's own flags never reach claude
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
// Flags whose value is OPTIONAL (`--flag [value]` in `claude --help`, Claude Code 2.1.233). Commander
// gives such a flag the next argv token as its value iff one follows and it does not start with '-'.
// So a bare `cc --resume` (= "open the picker") must NOT get "/color …" appended — claude would read
// it as the session id. When the last user arg is one of these written bare, the picker is the
// user's prompt and nothing is injected; `cc -r <id>` still gets /color as the prompt.
const OPTIONAL_VALUE_FLAGS = new Set([
  '--cloud', '-d', '--debug', '--from-pr', '--prompt-suggestions', '--remote-control',
  '-r', '--resume', '--teleport', '-w', '--worktree',
]);
let userHasPrompt = false;
for (let i = 0; i < userArgs.length; i++) {
  const a = userArgs[i];
  if (a.startsWith('-')) {
    const name = a.split('=')[0];
    const bare = !a.includes('=');
    if (VALUE_FLAGS.has(name) && bare) i++;               // consume the flag's value
    else if (OPTIONAL_VALUE_FLAGS.has(name) && bare) {
      const next = userArgs[i + 1];
      if (next !== undefined && !next.startsWith('-')) i++;  // commander: next non-flag token = value
    }
    continue;
  }
  userHasPrompt = true; break;                            // a bare positional = the user's prompt
}
const lastArg = userArgs[userArgs.length - 1];
const lastIsBareOptional = lastArg !== undefined && lastArg.startsWith('-')
  && !lastArg.includes('=') && OPTIONAL_VALUE_FLAGS.has(lastArg);
if (!userHasPrompt && !lastIsBareOptional && idColor) cli.push(`/color ${idColor}`);

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

// The env delta scopes to the CLAUDE CHILD only — not the VS Code co-launch, not the tiler, and not
// this launcher's own identity/git reads (those are per-project, not per-config-home). Three inputs,
// each independent: `--config-dir` → CLAUDE_CONFIG_DIR; the title markers → CC_TITLE_PREFIX /
// CC_TITLE_SUFFIX, exported so in-session title composition (the /identity rename lines) can
// reproduce the full marked title. null when none apply — the delta is never the inherited env.
const envDelta = {};
if (flags.configDir) envDelta.CLAUDE_CONFIG_DIR = flags.configDir;
if (flags.titlePrefix) envDelta.CC_TITLE_PREFIX = flags.titlePrefix;
if (flags.titleSuffix) envDelta.CC_TITLE_SUFFIX = flags.titleSuffix;
const childEnvDelta = Object.keys(envDelta).length ? envDelta : null;
const childEnv = childEnvDelta ? { ...process.env, ...childEnvDelta } : process.env;

// --- VS Code co-launch (env-gated; default off) -------------------------------------------------
// CC_VSCODE truthy → open VS Code on this project, detached, before claude launches. Exactly one
// *.code-workspace at the cwd root opens that workspace; zero or multiple open the folder (never
// guess between two). `code` missing from PATH → skip silently. The claude launch never waits on
// or fails because of this step.
const VS_SPAWN_OPTS = { detached: true, stdio: 'ignore' };
let vsPlan = { action: 'off', target: null, exe: null };
// `--no-vscode` forces the co-launch off REGARDLESS of CC_VSCODE — the profile sets that var
// globally, so an env-only opt-out can't express "this one session, without VS Code". vsPlan stays
// {action:'off'}, so tiling gates off through the existing path (tileEnabled needs vsPlan.exe) and
// reports the existing 'vscode-off' reason — the reason taxonomy is not extended.
if (!flags.noVsCode && EnvTruthy(process.env.CC_VSCODE)) {
  let action = 'folder', target = '.';
  try {
    const ws = readdirSync(loc).filter((n) => n.toLowerCase().endsWith('.code-workspace'));
    if (ws.length === 1) { action = 'workspace'; target = ws[0]; }
  } catch {}
  const codePath = resolveOnPath('code');
  vsPlan = codePath ? { action, target, exe: codePath } : { action: 'skip-no-cli', target: null, exe: null };
}

// --- Windows side-by-side tiling (on by default when VS Code co-launches) ------------------------
// When cc co-launches VS Code on Windows, tile the launching terminal to the left half and VS Code
// to the right half (50/50) of the terminal's monitor, then form a REAL Windows 11 snap group so
// the pair hover-previews and restores together on the taskbar. Windows exposes no API to create a
// snap group, so the tiler drives the actual snap gesture (simulated Win+arrow): VS Code snaps
// right first, the terminal snaps left second — leaving focus on the terminal, where cc was issued.
// A plain SetWindowPos pre-positions both halves first, so if the OS snap feature is off the layout
// still lands (just without the group). Inline PowerShell via -EncodedCommand — no new deployed
// artifact, so the public kit stays coherent. Always best-effort: never blocks/fails the claude
// launch. EnvOff is the inverse of EnvTruthy for a DEFAULT-ON flag (only an explicit off value
// disables); CC_VSCODE_TILE unset ⇒ on.
function EnvOff(v) { return v != null && ['0', 'off', 'false', 'no'].includes(String(v).toLowerCase().trim()); }
const tileEnabled = process.platform === 'win32' && !!vsPlan.exe && !EnvOff(process.env.CC_VSCODE_TILE);
const tileReason = tileEnabled ? 'on'
  : vsPlan.action === 'off' ? 'vscode-off'                 // CC_VSCODE falsy → no co-launch (any OS)
  : process.platform !== 'win32' ? 'not-win32'
  : vsPlan.action === 'skip-no-cli' ? 'vscode-no-cli'      // `code` missing from PATH
  : EnvOff(process.env.CC_VSCODE_TILE) ? 'disabled-flag'
  : 'off';
// VS Code titles its windows "<folder> - Visual Studio Code" / "<workspace> (Workspace) - …", so the
// match token is the workspace base (sans extension) or the cwd leaf — derived here, offline-testable.
const projectMatch = vsPlan.action === 'workspace'
  ? String(vsPlan.target).replace(/\.code-workspace$/i, '')
  : folder;
const tilePlan = {
  enabled: tileEnabled, reason: tileReason, side: 'terminal-left', ratio: 0.5,
  captureMethod: 'foreground-sync', snapGroup: true, titleMatch: title, projectMatch,
  pollMs: 5000, pollStepMs: 200,
};

// Debug (opt-in): CC_TILE_DEBUG truthy → the launcher + tiler append a trace to %TEMP%\cc-tile.log.
const tileDbg = EnvTruthy(process.env.CC_TILE_DEBUG);
const TILE_LOG = `${process.env.TEMP || process.env.TMP || '.'}\\cc-tile.log`;
function tlog(m) { if (tileDbg) { try { appendFileSync(TILE_LOG, `[node ${new Date().toISOString()}] ${m}\n`); } catch {} } }

// Inline-PowerShell plumbing: encode as base64(UTF-16LE) and run via -EncodedCommand — sidesteps all
// quoting of the HWND / name@branch title, and is ExecutionPolicy-proof.
// NOTE: NO `detached: true`. DETACHED_PROCESS gives powershell.exe no console at all, and the console
// host then fails to initialize and never runs the script. `windowsHide` (CREATE_NO_WINDOW) gives it
// a HIDDEN console instead — which works. The tiler finishes within ~5s while the launcher is still
// blocked on the claude spawnSync, so it never needs to outlive the parent; `.unref()` is enough.
const TILE_SPAWN_OPTS = { stdio: 'ignore', windowsHide: true };
function psEncode(src) { return Buffer.from(src, 'utf16le').toString('base64'); }
function b64utf8(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
function psArgs(src) { return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', psEncode(src)]; }

// Synchronous, race-free capture of the foreground (= launching terminal) HWND, done BEFORE VS Code
// opens (the terminal is guaranteed foreground then). Window-hidden + console-inheriting → no focus
// steal. Returns a decimal HWND string, or null on any failure (→ tiling silently skipped).
function captureForegroundHwnd() {
  const ps = `Add-Type -Namespace CC -Name FG -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();';[Console]::Out.Write([CC.FG]::GetForegroundWindow().ToInt64())`;
  const r = spawnSync('powershell.exe', psArgs(ps), { stdio: ['ignore', 'pipe', 'pipe'], timeout: 4000, windowsHide: true });
  const out = (r.stdout ? r.stdout.toString() : '').trim();
  tlog(`capture: status=${r.status} out=${JSON.stringify(out)} err=${JSON.stringify((r.stderr || '').toString().trim())}`);
  return /^-?\d+$/.test(out) && out !== '0' ? out : null;
}

// The detached tiler: polls up to pollMs for the VS Code window (Code.exe, title contains the project
// token), then restores + SetWindowPos the terminal↔VS Code to the two halves of the terminal's
// monitor. All-or-nothing: moves nothing unless BOTH windows resolve. SWP_NOACTIVATE keeps focus.
function spawnTiler(hwnd, plan) {
  spawn('powershell.exe', psArgs(tilerScript(hwnd, plan)), TILE_SPAWN_OPTS).unref();
}
function tilerScript(hwnd, plan) {
  return `$ErrorActionPreference='SilentlyContinue'
try {
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class CCW{
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h,uint f);
 [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m,ref MONITORINFO mi);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int cx,int cy,uint f);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool f);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte sc,uint f,UIntPtr x);
 [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a,uint p,IntPtr v,uint w);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [StructLayout(LayoutKind.Sequential)] public struct RECT{public int left,top,right,bottom;}
 [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO{public int cbSize;public RECT rcMonitor;public RECT rcWork;public uint dwFlags;}
}
'@
try{[void][CCW]::SetProcessDpiAwarenessContext([IntPtr](-4))}catch{}
$titleMatch=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64utf8(plan.titleMatch)}')).ToLowerInvariant()
$projectMatch=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64utf8(plan.projectMatch)}')).ToLowerInvariant()
$termHwnd=[IntPtr][long]${hwnd}
$ratio=${plan.ratio}; $pollMs=${plan.pollMs}; $stepMs=${plan.pollStepMs}
$dbg=${tileDbg ? 1 : 0}
$log=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64utf8(TILE_LOG)}'))
function Dbg($m){if($dbg){try{Add-Content -LiteralPath $log -Value ("[tiler {0}] {1}" -f (Get-Date -Format o),$m)}catch{}}}
function Title([IntPtr]$h){$sb=New-Object Text.StringBuilder 512;[void][CCW]::GetWindowText($h,$sb,512);$sb.ToString()}
function Cands(){
 $l=New-Object Collections.ArrayList
 $cb=[CCW+EnumProc]{param($h,$x) if([CCW]::IsWindowVisible($h)){$t=Title $h;if($t.Length -gt 0){[void]$l.Add([pscustomobject]@{h=$h;t=$t})}};return $true}
 [void][CCW]::EnumWindows($cb,[IntPtr]::Zero);$l
}
Dbg "start termHwnd=${hwnd} titleMatch=[$titleMatch] projectMatch=[$projectMatch] poll=$pollMs"
# Terminal: TRUST the captured foreground HWND (it was foreground at cc-time, by construction). Only
# fall back to a title-enum when capture returned nothing — the title can lag the OSC-2 update.
$term=[IntPtr]::Zero
if($termHwnd -ne [IntPtr]::Zero -and [CCW]::IsWindow($termHwnd)){$term=$termHwnd;Dbg "term=captured $termHwnd title=[$(Title $termHwnd)]"}
if($term -eq [IntPtr]::Zero){$m=@(Cands|Where-Object{$_.t.ToLowerInvariant().Contains($titleMatch)});if($m.Count -ge 1){$term=$m[0].h;Dbg "term=title-enum $($m[0].h)"}}
if($term -eq [IntPtr]::Zero){Dbg "term UNRESOLVED -> no-op";return}
$code=[IntPtr]::Zero
$deadline=(Get-Date).AddMilliseconds($pollMs);$tries=0
while((Get-Date) -lt $deadline -and $code -eq [IntPtr]::Zero){
 $tries++
 $cm=@(Cands|Where-Object{$_.h -ne $term -and $_.t.ToLowerInvariant().Contains('visual studio code') -and $_.t.ToLowerInvariant().Contains($projectMatch)})
 if($cm.Count -ge 1){$code=$cm[0].h;Dbg "code=$($cm[0].h) title=[$($cm[0].t)] tries=$tries"}else{Start-Sleep -Milliseconds $stepMs}
}
if($code -eq [IntPtr]::Zero){Dbg "code UNRESOLVED tries=$tries; VSCode windows seen: $((Cands|Where-Object{$_.t.ToLowerInvariant().Contains('visual studio code')}|ForEach-Object{$_.t}) -join ' || ')";return}
$mon=[CCW]::MonitorFromWindow($term,2)
$mi=New-Object CCW+MONITORINFO;$mi.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($mi)
$gm=[CCW]::GetMonitorInfo($mon,[ref]$mi)
$w=$mi.rcWork.right-$mi.rcWork.left;$h=$mi.rcWork.bottom-$mi.rcWork.top
$lw=[int][Math]::Floor($w*$ratio);$x=$mi.rcWork.left;$y=$mi.rcWork.top
$flags=[uint32](0x0004 -bor 0x0010)  # SWP_NOZORDER|SWP_NOACTIVATE
# Pre-position both halves on the terminal's monitor. Two jobs: it lands the layout even if the OS
# snap feature is off (no group, but still tiled), and it anchors BOTH windows to this monitor so
# the Win+arrow snaps below target the correct display.
[void][CCW]::ShowWindow($term,9);[void][CCW]::ShowWindow($code,9)
$r2=[CCW]::SetWindowPos($code,[IntPtr]::Zero,($x+$lw),$y,($w-$lw),$h,$flags)
$r1=[CCW]::SetWindowPos($term,[IntPtr]::Zero,$x,$y,$lw,$h,$flags)
Dbg "getMon=$gm rcWork=[$($mi.rcWork.left),$($mi.rcWork.top),$($mi.rcWork.right),$($mi.rcWork.bottom)] W=$w lw=$lw termSWP=$r1 codeSWP=$r2"
# Form a real snap group by driving the actual snap gesture. Focusing a window from a background
# process is normally blocked by the foreground lock, so zero its timeout and briefly attach to the
# current foreground thread's input queue around each SetForegroundWindow (the documented dance).
[void][CCW]::SystemParametersInfo(0x2001,0,[IntPtr]::Zero,0)  # SPI_SETFOREGROUNDLOCKTIMEOUT=0
function Focus([IntPtr]$h){
 $fg=[CCW]::GetForegroundWindow();$cur=[CCW]::GetCurrentThreadId();$fgpid=[uint32]0
 $fgt=[CCW]::GetWindowThreadProcessId($fg,[ref]$fgpid)
 [void][CCW]::AttachThreadInput($cur,$fgt,$true)
 [void][CCW]::ShowWindow($h,9);[void][CCW]::BringWindowToTop($h);$ok=[CCW]::SetForegroundWindow($h)
 [void][CCW]::AttachThreadInput($cur,$fgt,$false);return $ok
}
function SnapKey([byte]$arrow){  # tap Win+<arrow>: LWin=0x5B down, arrow down/up, LWin up (KEYUP=0x2)
 [CCW]::keybd_event(0x5B,0,0,[UIntPtr]::Zero);[CCW]::keybd_event($arrow,0,0,[UIntPtr]::Zero)
 [CCW]::keybd_event($arrow,0,2,[UIntPtr]::Zero);[CCW]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)
}
# VS Code RIGHT first (0x27), terminal LEFT second (0x25) -> focus ends on the terminal.
$f1=Focus $code;Start-Sleep -Milliseconds 150;SnapKey 0x27
Start-Sleep -Milliseconds 400   # let Snap Assist settle before the second snap pairs the group
$f2=Focus $term;Start-Sleep -Milliseconds 150;SnapKey 0x25
Dbg "snap: focusCode=$f1 winRight; focusTerm=$f2 winLeft DONE"
}catch{Dbg "EXCEPTION $_"}`;
}

// --- dry-run seam: print the launch plan as ONE JSON line, spawn nothing ------------------------
if (EnvTruthy(process.env.CC_LAUNCH_DRYRUN)) {
  process.stdout.write(JSON.stringify({
    launch: {
      title, titlePrefix: flags.titlePrefix, titleSuffix: flags.titleSuffix,
      configDir: flags.configDir, noVsCode: flags.noVsCode,
    },
    vscode: { action: vsPlan.action, target: vsPlan.target, spawnOpts: { ...VS_SPAWN_OPTS, unref: true } },
    // envDelta is the DELTA ONLY — never the inherited environment, so a dry-run captured in a CI
    // log can't spill anything. null when the launch adds nothing to the child's env.
    claude: { argv: claudeArgv, envDelta: childEnvDelta },
    tile: {
      enabled: tilePlan.enabled, reason: tilePlan.reason, side: tilePlan.side, ratio: tilePlan.ratio,
      captureMethod: tilePlan.captureMethod, snapGroup: tilePlan.snapGroup, titleMatch: tilePlan.titleMatch,
      projectMatch: tilePlan.projectMatch, pollMs: tilePlan.pollMs,
    },
  }) + '\n');
  process.exit(0);
}

// Windows tiling: capture the launching terminal's HWND BEFORE VS Code opens (foreground = terminal
// at this instant). Any failure → null → tiling silently skipped; the claude launch is untouched.
let termHwnd = null;
if (tilePlan.enabled) {
  tlog(`plan=${JSON.stringify(tilePlan)}`);
  try { termHwnd = captureForegroundHwnd(); } catch (e) { termHwnd = null; tlog(`capture threw ${e}`); }
}

if (vsPlan.exe) {
  try {
    const [vsExe, ...vsArgs] = shimVector(vsPlan.exe, [vsPlan.target]);
    spawn(vsExe, vsArgs, VS_SPAWN_OPTS).unref();   // the one VS Code spawn site
  } catch { /* never block or fail the claude launch */ }
}

// Windows tiling: spawn the detached tiler (best-effort; never blocks or fails the claude launch).
if (tilePlan.enabled && termHwnd) { try { spawnTiler(termHwnd, tilePlan); tlog(`tiler spawned termHwnd=${termHwnd}`); } catch (e) { tlog(`tiler spawn threw ${e}`); } }
else if (tilePlan.enabled) { tlog(`tiler NOT spawned (termHwnd=${termHwnd})`); }

const res = spawnSync(claudeArgv[0], claudeArgv.slice(1), { stdio: 'inherit', env: childEnv });

// Re-assert the tab title on exit. Claude Code retitles the terminal while it runs and leaves it on
// its own title when it quits. This OSC 2 restores <name@branch> on terminals that keep a child's
// title after the child exits (iTerm2 / most *nix terminals). Windows Terminal instead reverts to
// the shell's own title on child exit, so there the `cc` function re-owns it via --print-title +
// $Host.UI.RawUI.WindowTitle — this write is harmless there (same string, pwsh overwrites it next).
if (title) termWrite(`${ESC}]2;${title}${BEL}`);

process.exit(typeof res.status === 'number' ? res.status : (res.error ? 1 : 0));
