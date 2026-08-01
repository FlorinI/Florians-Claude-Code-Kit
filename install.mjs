#!/usr/bin/env node
// install-base.mjs — the pure, generic, manifest-driven Claude Code deployer.
//
// This is the PUBLIC base installer. It knows nothing about Florian's private env: it takes a
// manifest describing what to deploy and drops it into a user's ~/.claude, respecting any files
// and config that are already there. It is used two ways:
//   • As a CLI in the public kit:  node install.mjs  (defaults to manifest.public.json beside it)
//   • Imported as a module by the private repo's wrapper, which calls runInstall() once with the
//     public manifest and again with a private manifest, then layers on Windows-only steps.
//
// Design contract (docs/roadmap.md → "Phase 2 design"):
//   • Deploy files verbatim per the manifest.
//   • MERGE into settings.json — only the keys we own (statusLine + a SessionStart handover hook).
//   • MERGE a sentinel-bounded block into CLAUDE.md — never overwrite the user's instructions.
//   • STRICT conflict-abort: before writing anything, abort if a manifest file collides with a
//     file we don't own, or if the user already has a statusLine we don't own. --force overrides.
//   • Record what we own in ~/.claude/.fcck-install.json (provenance) so re-runs are clean and
//     `uninstall` removes exactly what we added — and nothing the user brought.
//   • PRUNE retired files: on re-install (CLI sets opts.prune), files in provenance that the current
//     manifest no longer ships are deleted — so dropping a manifest entry cleans the file off every
//     machine on next install. Only ever kit-owned files; never user content. Gated behind opts.prune
//     so the two-manifest accumulation path (runInstall once per manifest) can't mistake the other
//     manifest's files for orphans.
//
// Zero dependencies, zero PowerShell, zero platform assumptions. Node's stdlib only.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const KIT_NAME = "Florian's Claude Code Kit";
const PROVENANCE_FILE = '.fcck-install.json';
const PROVENANCE_VERSION = 1;

// The CLAUDE.md block the installer sentinel-merges into a user's ~/.claude/CLAUDE.md. Inlined
// (not a separate file) so the public artifact has one fewer moving part. The BEGIN/END markers
// are the merge anchors: re-install replaces what's between them; uninstall removes the whole block.
const FCCK_BEGIN = '<!-- FCCK:BEGIN — managed by Florian\'s Claude Code Kit. Don\'t edit between these markers; your edits above/below are preserved. -->';
const FCCK_END = '<!-- FCCK:END -->';
const FCCK_BLOCK_BODY = `## Session handover pickup (runs first, every session)

Before any other on-session-start behavior, check the working directory for a pending handover:

1. List files in \`<cwd>/.claude/handovers/\` matching \`*.md\` but NOT \`*.consumed.md\`.
2. If one or more exist, pick the most recent by filename (ISO timestamps sort lexicographically).
3. **Rename the file** to insert \`.consumed\` before \`.md\` — do this BEFORE reading it. That's the consumed marker.
4. Read the renamed file and use it as orientation for this session.
5. Open the first turn by acknowledging the resume in one sentence and summarizing what was loaded
   (3–4 lines max), then defer to the project's own conventions.
6. After the first turn, treat the handover as one-time orientation — don't re-quote it as a source of truth.

If no unconsumed handover exists, proceed normally.`;

const FCCK_BLOCK = `${FCCK_BEGIN}\n${FCCK_BLOCK_BODY}\n${FCCK_END}`;

// ── small helpers ───────────────────────────────────────────────────────────

function toForwardSlash(p) {
  return p.replace(/\\/g, '/');
}

// Substitute {{CLAUDE_HOME}} (forward-slashed) into any string in an arbitrary JSON value.
// Forward slashes are deliberate: a backslashed path broke `node "...\statusline.mjs"` on macOS
// (the original symptom that motivated the Node port) and forward slashes work on every platform.
function substituteHome(value, claudeHomeFwd) {
  if (typeof value === 'string') return value.split('{{CLAUDE_HOME}}').join(claudeHomeFwd);
  if (Array.isArray(value)) return value.map((v) => substituteHome(v, claudeHomeFwd));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteHome(v, claudeHomeFwd);
    return out;
  }
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonIfExists(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeFileEnsuringDir(path, content) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content);
}

// Detect the newline style of an existing text file so merges don't churn CRLF↔LF.
function detectNewline(text) {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── manifest expansion ────────────────────────────────────────────────────────
// A manifest file entry may be a single file ({source, dest}) or a directory tree
// ({source, dest, dir:true}). expandFiles() flattens directory entries into concrete
// per-file {source, dest} pairs so the rest of the installer only ever sees real files.

function walkDir(absDir) {
  const out = [];
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    if (statSync(abs).isDirectory()) out.push(...walkDir(abs));
    else out.push(abs);
  }
  return out;
}

function expandFiles(manifest, sourceRoot) {
  const files = [];
  for (const entry of manifest.files || []) {
    const srcAbs = resolve(sourceRoot, entry.source);
    if (entry.dir) {
      if (!existsSync(srcAbs)) throw new Error(`manifest source directory not found: ${entry.source}`);
      for (const fileAbs of walkDir(srcAbs)) {
        const rel = toForwardSlash(fileAbs.slice(srcAbs.length + 1));
        files.push({
          sourceAbs: fileAbs,
          dest: toForwardSlash(join(entry.dest, rel)),
        });
      }
    } else {
      if (!existsSync(srcAbs)) throw new Error(`manifest source file not found: ${entry.source}`);
      files.push({ sourceAbs: srcAbs, dest: toForwardSlash(entry.dest) });
    }
  }
  return files;
}

// ── settings.json merge ────────────────────────────────────────────────────────

const HOOK_EVENT = 'SessionStart';

// Find an existing SessionStart hook entry that matches ours by command + args (so a re-install
// updates in place and uninstall can find it). Returns {groupIndex, hookIndex} or null.
function findOurHook(settings, ourHook, matcher) {
  const groups = settings?.hooks?.[HOOK_EVENT];
  if (!Array.isArray(groups)) return null;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (group?.matcher !== matcher) continue;
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    for (let hi = 0; hi < hooks.length; hi++) {
      const h = hooks[hi];
      if (h?.command === ourHook.command && deepEqual(h?.args, ourHook.args)) {
        return { groupIndex: gi, hookIndex: hi };
      }
    }
  }
  return null;
}

// ── CLAUDE.md sentinel merge ──────────────────────────────────────────────────

function hasFcckBlock(text) {
  return text.includes(FCCK_BEGIN) && text.includes(FCCK_END);
}

function upsertFcckBlock(existingText, nl) {
  const block = FCCK_BLOCK.split('\n').join(nl);
  if (!existingText) return block + nl;
  if (hasFcckBlock(existingText)) {
    // Replace everything between (and including) the markers, preserving surrounding content.
    const re = new RegExp(`${escapeRegExp(FCCK_BEGIN)}[\\s\\S]*?${escapeRegExp(FCCK_END)}`);
    return existingText.replace(re, block);
  }
  // Append, ensuring a blank line of separation.
  const trimmed = existingText.replace(/\s+$/, '');
  return `${trimmed}${nl}${nl}${block}${nl}`;
}

function removeFcckBlock(existingText, nl) {
  if (!existingText || !hasFcckBlock(existingText)) return existingText;
  const re = new RegExp(`\\n*${escapeRegExp(FCCK_BEGIN)}[\\s\\S]*?${escapeRegExp(FCCK_END)}\\n*`);
  const out = existingText.replace(re, nl);
  return out.replace(/\s+$/, '') + (out.trim() ? nl : '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── launcher shell-function setup ──────────────────────────────────────────────
// Cross-platform: add a marker-bounded shell function (default `cc`) to the user's shell profile
// that invokes the deployed launcher (`node <claudeHome>/<script>`). Windows → the PowerShell
// profile; macOS/Linux → ~/.zshrc or ~/.bashrc (chosen from $SHELL). Re-install updates the block
// in place; uninstall removes exactly it. Pure Node, no shell-out.
const LAUNCHER_BEGIN = `# >>> ${KIT_NAME} (cc launcher) >>>`;
const LAUNCHER_END = `# <<< ${KIT_NAME} (cc launcher) <<<`;

// `platform` defaults to process.platform and is the ONLY platform read in here — the win32 branch,
// the bash/zsh rc choice and the darwin default all consult it, so an override produces a wholly
// consistent POSIX (or Windows) form rather than a half-and-half one. That makes the generated
// non-native line assertable from a single machine, which is the point of the seam.
function launcherProfile(claudeHome, shellHome, platform = process.platform) {
  const home = shellHome || homedir();
  const fwd = toForwardSlash(claudeHome);
  // Fixed args a variant always passes (e.g. a different config home). Each is emitted individually
  // double-quoted with the shell's own escape for an embedded quote; nothing else is escaped. With no
  // fixed args the rendered fragment is EMPTY, so the primary function stays byte-identical to the
  // pre-variants form on both platforms.
  const fixed = (args, esc) => (Array.isArray(args) && args.length)
    ? ' ' + args.map((a) => `"${String(a).split('"').join(esc)}"`).join(' ')
    : '';
  if (platform === 'win32') {
    return {
      path: join(home, 'Documents', 'PowerShell', 'profile.ps1'),  // pwsh 7 CurrentUserAllHosts
      // After the launch returns, pwsh re-owns BOTH the tab title and its color: Windows Terminal
      // reverts a child-set title (to the shell's own) and a child-set tab color the moment the child
      // exits, so only the shell re-asserting them makes <name@branch> and the identity color stick past
      // CC. `--print-title` echoes the resolved title; `--print-tabcolor` echoes the OSC tab-color
      // escape (empty on non-WT); the launch itself paints both while CC runs. Wrapped in try/catch so a
      // headless/no-console host can't error the prompt.
      // The fixed args go to ALL THREE invocations. They must: `--print-title` resolves the title from
      // the same inputs as the launch, so a probe missing them would re-title the tab with an UNMARKED
      // string the instant CC exits — the marker would appear to work and then silently vanish.
      fnLine: (cmd, script, args) => {
        const fx = fixed(args, '`"');
        return `function ${cmd} { node "${fwd}/${script}"${fx} @args; try { $t = (node "${fwd}/${script}"${fx} --print-title 2>$null); if ($t) { $Host.UI.RawUI.WindowTitle = $t }; $c = (node "${fwd}/${script}"${fx} --print-tabcolor 2>$null); if ($c) { [Console]::Write($c) } } catch {} }`;
      },
    };
  }
  const sh = (process.env.SHELL || '').toLowerCase();
  // zsh sources ~/.zshrc for every interactive shell (login or not), so it's always right. bash on
  // macOS, though, starts as a LOGIN shell (Terminal.app/iTerm2) that reads ~/.bash_profile, not
  // ~/.bashrc — so target .bash_profile there; on Linux, GUI terminals start non-login shells that
  // read ~/.bashrc.
  const rc = sh.includes('zsh') ? '.zshrc'
    : sh.includes('bash') ? (platform === 'darwin' ? '.bash_profile' : '.bashrc')
      : (platform === 'darwin' ? '.zshrc' : '.bashrc');
  return {
    path: join(home, rc),
    fnLine: (cmd, script, args) => `${cmd}() { node "${fwd}/${script}"${fixed(args, '\\"')} "$@"; }`,
  };
}

// opts.variants: [{ command, args: [...] }] — extra launcher functions with fixed leading args,
// emitted inside the SAME marker-bounded block as the primary, one per line. Content-free by design:
// the caller supplies the names and the argument values, this only knows how to render them. With no
// variants the block is byte-identical to the pre-variants form.
// opts.platform: override the platform the profile path + function form are derived for (D9) —
// defaults to process.platform; its only misuse is deliberately generating a foreign form.
export function setupLauncher(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const claudeHome = resolve(opts.claudeHome || join(homedir(), '.claude'));
  const command = opts.command || 'cc';
  const script = opts.script || 'claude-launch.mjs';
  const variants = Array.isArray(opts.variants) ? opts.variants : [];
  const { path: profilePath, fnLine } = launcherProfile(claudeHome, opts.shellHome, opts.platform);
  const existed = existsSync(profilePath);
  const existing = existed ? readFileSync(profilePath, 'utf8') : '';
  const nl = existed ? detectNewline(existing) : '\n';
  const lines = [fnLine(command, script, [])];
  for (const v of variants) {
    if (!v || !v.command) continue;
    lines.push(fnLine(v.command, script, v.args || []));
  }
  const block = `${LAUNCHER_BEGIN}\n${lines.join('\n')}\n${LAUNCHER_END}`.split('\n').join(nl);
  const re = new RegExp(`${escapeRegExp(LAUNCHER_BEGIN)}[\\s\\S]*?${escapeRegExp(LAUNCHER_END)}`);
  let next;
  if (re.test(existing)) next = existing.replace(re, () => block);
  else if (existing.trim()) next = existing.replace(/\s+$/, '') + nl + nl + block + nl;
  else next = block + nl;
  if (next === existing) { log(`  launcher  ${command} already current in ${profilePath}`); return { profile: profilePath, command }; }
  if (opts.dryRun) { log(`  launcher  would ${existed ? 'update' : 'add'} ${command} in ${profilePath}`); return { profile: profilePath, command }; }
  writeFileEnsuringDir(profilePath, next);
  log(`  launcher  ${command} ${existed ? 'updated' : 'added'} in ${profilePath} (open a new shell to use it)`);
  return { profile: profilePath, command };
}

export function removeLauncher(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const claudeHome = resolve(opts.claudeHome || join(homedir(), '.claude'));
  // opts.platform mirrors setupLauncher's override so a block written for a foreign platform can be
  // removed again (the block is marker-bounded, so this removes the primary AND every variant).
  const { path: profilePath } = launcherProfile(claudeHome, opts.shellHome, opts.platform);
  if (!existsSync(profilePath)) return;
  const text = readFileSync(profilePath, 'utf8');
  const re = new RegExp(`\\n*${escapeRegExp(LAUNCHER_BEGIN)}[\\s\\S]*?${escapeRegExp(LAUNCHER_END)}\\n*`);
  if (!re.test(text)) return;
  if (opts.dryRun) { log(`  launcher  would remove launcher function from ${profilePath}`); return; }
  const nl = detectNewline(text);
  const stripped = text.replace(re, nl);
  writeFileSync(profilePath, stripped.replace(/\s+$/, '') + (stripped.trim() ? nl : ''));
  log(`  launcher  removed launcher function from ${profilePath}`);
}

// ── planning ────────────────────────────────────────────────────────────────
// planInstall() computes everything without touching disk: the file writes, the settings merge,
// the CLAUDE.md merge, and — crucially — the conflict list. Apply happens only after the plan is
// clean (or --force). This is what makes the "abort before any write" guarantee real.

export function planInstall(opts) {
  // applySettings / applyClaudeMd default true (the public CLI behaviour). The private repo's
  // wrapper sets them false: it reuses this base only to deploy FILES (+ provenance), because it
  // owns settings.json (full template) and CLAUDE.md (SHARED/LOCAL) itself, byte-for-byte.
  const applySettings = opts.applySettings !== false;
  const applyClaudeMd = opts.applyClaudeMd !== false;
  const applyLauncher = opts.applyLauncher !== false;
  const claudeHome = resolve(opts.claudeHome || join(homedir(), '.claude'));
  const claudeHomeFwd = toForwardSlash(claudeHome);
  const manifestPath = resolve(opts.manifest);
  const manifest = readJson(manifestPath);
  const sourceRoot = resolve(opts.sourceRoot || dirname(manifestPath));

  const files = expandFiles(manifest, sourceRoot);
  const provenance = readJsonIfExists(join(claudeHome, PROVENANCE_FILE), null);
  const ownedFiles = new Set(provenance?.files || []);

  // Orphans: files this kit deployed on a previous run (recorded in provenance) that this manifest
  // no longer ships — e.g. a command we retired. They're pruned on apply when opts.prune is set, so
  // removing a manifest entry is all it takes to clean a file off every machine on next install. Only
  // ever kit-owned files: never touches anything the user brought. (Pruning is gated behind opts.prune
  // so the documented two-manifest accumulation path — runInstall called once per manifest — can't see
  // the other manifest's files as orphans and delete them.)
  const currentDests = new Set(files.map((f) => f.dest));
  const orphans = [...ownedFiles].filter((d) => !currentDests.has(d));

  const conflicts = [];

  // File conflicts: a dest that already exists and we don't own it.
  const fileWrites = [];
  for (const f of files) {
    const destAbs = join(claudeHome, f.dest);
    const exists = existsSync(destAbs);
    const owned = ownedFiles.has(f.dest);
    if (exists && !owned) {
      conflicts.push({ kind: 'file', dest: f.dest, detail: `~/.claude/${f.dest} already exists and is not managed by ${KIT_NAME}` });
    }
    const newContent = readFileSync(f.sourceAbs);
    fileWrites.push({ destAbs, dest: f.dest, content: newContent, exists, owned });
  }

  // Settings merge plan.
  const settingsPath = join(claudeHome, 'settings.json');
  const settings = readJsonIfExists(settingsPath, {});
  const settingsExisted = existsSync(settingsPath);
  const ownedKeys = new Set(provenance?.settingsKeys || []);

  const settingsPlan = { sets: [], hook: null };
  const manifestSettings = substituteHome(manifest.settings || {}, claudeHomeFwd);

  if (applySettings) {
    // statusLine: a singleton key — a pre-existing one we don't own is a hard conflict.
    if (manifestSettings.statusLine) {
      const existing = settings.statusLine;
      const owned = ownedKeys.has('statusLine');
      if (existing !== undefined && !owned && !deepEqual(existing, manifestSettings.statusLine)) {
        conflicts.push({ kind: 'statusLine', detail: '~/.claude/settings.json already defines a statusLine not managed by ' + KIT_NAME });
      }
      settingsPlan.sets.push({ key: 'statusLine', value: manifestSettings.statusLine });
    }

    // SessionStart handover hook: additive — never a conflict. Ensure-present semantics.
    if (manifestSettings.sessionStartHook) {
      const matcher = manifestSettings.sessionStartHook.matcher;
      const hook = manifestSettings.sessionStartHook.hook;
      settingsPlan.hook = { matcher, hook };
    }
  }

  // CLAUDE.md merge plan.
  const claudeMdPath = join(claudeHome, 'CLAUDE.md');
  const claudeMdExisted = existsSync(claudeMdPath);
  const claudeMdText = claudeMdExisted ? readFileSync(claudeMdPath, 'utf8') : '';

  const launcherConfig = applyLauncher ? (manifest.launcher || null) : null;

  return {
    kitName: KIT_NAME,
    applySettings,
    applyClaudeMd,
    launcherConfig,
    shellHome: opts.shellHome,
    claudeHome,
    claudeHomeFwd,
    manifestPath,
    sourceRoot,
    files: fileWrites,
    orphans,
    settingsPath,
    settings,
    settingsExisted,
    settingsPlan,
    claudeMdPath,
    claudeMdExisted,
    claudeMdText,
    provenance,
    conflicts,
  };
}

// ── apply ─────────────────────────────────────────────────────────────────────

export function runInstall(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const plan = planInstall(opts);

  if (plan.conflicts.length && !opts.force) {
    log('');
    log(`ABORT: ${plan.kitName} install would collide with existing files / config in ${plan.claudeHome}:`);
    for (const c of plan.conflicts) log(`  ✗ ${c.detail}`);
    log('');
    log('  Nothing was written. Resolve the conflicts, or re-run with --force to overwrite.');
    log('');
    return { ok: false, conflicts: plan.conflicts, plan };
  }

  if (opts.dryRun) {
    log('');
    log(`DRY RUN — ${plan.kitName} → ${plan.claudeHome}`);
    for (const f of plan.files) {
      log(`  ${f.exists ? 'update' : 'create'}  ~/.claude/${f.dest}`);
    }
    if (opts.prune) for (const o of plan.orphans) log(`  prune   (retired) ~/.claude/${o}`);
    for (const s of plan.settingsPlan.sets) log(`  settings  set ${s.key}`);
    if (plan.settingsPlan.hook) log(`  settings  ensure SessionStart hook (${basename(plan.settingsPlan.hook.hook.args?.[0] || 'hook')})`);
    if (plan.applyClaudeMd) log(`  CLAUDE.md  ${plan.claudeMdExisted ? (hasFcckBlock(plan.claudeMdText) ? 'update block' : 'append block') : 'create with block'}`);
    if (plan.launcherConfig) {
      setupLauncher({ claudeHome: plan.claudeHome, command: plan.launcherConfig.command, script: plan.launcherConfig.script, variants: plan.launcherConfig.variants, shellHome: plan.shellHome, dryRun: true, log });
    }
    if (plan.conflicts.length) {
      log('  (--force) overwriting:');
      for (const c of plan.conflicts) log(`    ! ${c.detail}`);
    }
    log('');
    log('Dry run complete. No changes made.');
    return { ok: true, dryRun: true, conflicts: plan.conflicts, plan };
  }

  // 1. Files. When pruning, the new provenance is exactly what this manifest ships (orphans dropped);
  // otherwise we accumulate onto any prior install's set (the two-manifest path).
  const writtenFiles = new Set(opts.prune ? [] : (plan.provenance?.files || []));
  for (const f of plan.files) {
    writeFileEnsuringDir(f.destAbs, f.content);
    writtenFiles.add(f.dest);
    log(`  ${f.exists ? 'update' : 'create'}  ~/.claude/${f.dest}`);
  }

  // 1b. Prune orphans — kit-owned files this manifest no longer ships. Only files recorded in
  // provenance; never user content. Empty dirs left behind are swept (never past claudeHome).
  if (opts.prune) {
    for (const o of plan.orphans) {
      const abs = join(plan.claudeHome, o);
      if (existsSync(abs)) {
        rmSync(abs, { force: true });
        log(`  prune   (retired) ~/.claude/${o}`);
      }
      pruneEmptyDirs(dirname(abs), plan.claudeHome);
    }
  }

  // 2. settings.json merge. Skipped entirely when applySettings is false (the private wrapper
  // owns settings.json) — we must not even re-serialize the user's file in that mode.
  const settings = plan.settings;
  const ownedKeys = new Set(plan.provenance?.settingsKeys || []);
  let hookProvenance = plan.provenance?.hook || null;
  if (plan.applySettings) {
  for (const s of plan.settingsPlan.sets) {
    settings[s.key] = s.value;
    ownedKeys.add(s.key);
    log(`  settings  set ${s.key}`);
  }
  if (plan.settingsPlan.hook) {
    const { matcher, hook } = plan.settingsPlan.hook;
    if (!settings.hooks) settings.hooks = {};
    if (!Array.isArray(settings.hooks[HOOK_EVENT])) settings.hooks[HOOK_EVENT] = [];
    const found = findOurHook(settings, hook, matcher);
    if (found) {
      settings.hooks[HOOK_EVENT][found.groupIndex].hooks[found.hookIndex] = hook;
    } else {
      let group = settings.hooks[HOOK_EVENT].find((g) => g.matcher === matcher);
      if (!group) {
        group = { matcher, hooks: [] };
        settings.hooks[HOOK_EVENT].push(group);
      }
      if (!Array.isArray(group.hooks)) group.hooks = [];
      group.hooks.push(hook);
    }
    hookProvenance = { event: HOOK_EVENT, matcher, command: hook.command, args: hook.args };
    log('  settings  ensure SessionStart handover hook');
  }
  const settingsNl = plan.settingsExisted ? detectNewline(readFileSync(plan.settingsPath, 'utf8')) : '\n';
  writeFileEnsuringDir(plan.settingsPath, JSON.stringify(settings, null, 2).split('\n').join(settingsNl) + settingsNl);
  }

  // 3. CLAUDE.md sentinel merge. Skipped when applyClaudeMd is false (private wrapper owns it).
  let claudeMdBlock = plan.provenance?.claudeMdBlock || false;
  if (plan.applyClaudeMd) {
    const mdNl = plan.claudeMdExisted ? detectNewline(plan.claudeMdText) : '\n';
    const mergedMd = upsertFcckBlock(plan.claudeMdText, mdNl);
    writeFileEnsuringDir(plan.claudeMdPath, mergedMd);
    claudeMdBlock = true;
    log(`  CLAUDE.md  ${plan.claudeMdExisted ? (hasFcckBlock(plan.claudeMdText) ? 'updated block' : 'appended block') : 'created with block'}`);
  }

  // 3b. Launcher shell function (cross-platform). Skipped when applyLauncher is false / no config.
  let launcherProv = plan.provenance?.launcher || null;
  if (plan.launcherConfig) {
    // `variants` is optional in the manifest (absent from manifest.public.json) — a kit user with two
    // subscriptions can declare extra launcher functions declaratively instead of importing the module.
    const r = setupLauncher({ claudeHome: plan.claudeHome, command: plan.launcherConfig.command, script: plan.launcherConfig.script, variants: plan.launcherConfig.variants, shellHome: plan.shellHome, log });
    launcherProv = { profile: r.profile, command: r.command };
  }

  // 4. Provenance — merge with any prior install (so a wrapper calling us twice accumulates).
  const provenance = {
    kit: KIT_NAME,
    version: PROVENANCE_VERSION,
    installedAt: new Date().toISOString(),
    files: [...writtenFiles].sort(),
    settingsKeys: [...ownedKeys].sort(),
    hook: hookProvenance,
    claudeMdBlock,
    launcher: launcherProv,
  };
  writeFileEnsuringDir(join(plan.claudeHome, PROVENANCE_FILE), JSON.stringify(provenance, null, 2) + '\n');

  log('');
  log(`Install complete. ${plan.files.length} file(s) deployed to ${plan.claudeHome}.`);
  log('Restart Claude Code for settings.json changes to take effect.');
  return { ok: true, conflicts: plan.conflicts, plan, provenance };
}

export function runUninstall(opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const claudeHome = resolve(opts.claudeHome || join(homedir(), '.claude'));
  const provPath = join(claudeHome, PROVENANCE_FILE);
  const provenance = readJsonIfExists(provPath, null);
  if (!provenance) {
    log(`No ${PROVENANCE_FILE} found in ${claudeHome} — nothing to uninstall.`);
    return { ok: true, removed: 0 };
  }

  if (opts.dryRun) {
    log(`DRY RUN — would uninstall ${provenance.kit} from ${claudeHome}`);
    for (const f of provenance.files || []) log(`  remove  ~/.claude/${f}`);
    for (const k of provenance.settingsKeys || []) log(`  settings  unset ${k}`);
    if (provenance.hook) log('  settings  remove SessionStart handover hook');
    if (provenance.claudeMdBlock) log('  CLAUDE.md  remove block');
    if (provenance.launcher) removeLauncher({ claudeHome, command: provenance.launcher.command, shellHome: opts.shellHome, dryRun: true, log });
    log('  remove  ~/.claude/' + PROVENANCE_FILE);
    return { ok: true, dryRun: true };
  }

  let removed = 0;
  // 1. Files.
  for (const f of provenance.files || []) {
    const abs = join(claudeHome, f);
    if (existsSync(abs)) {
      rmSync(abs, { force: true });
      removed++;
      log(`  remove  ~/.claude/${f}`);
    }
    pruneEmptyDirs(dirname(abs), claudeHome);
  }

  // 2. settings.json — remove owned keys + our hook.
  const settingsPath = join(claudeHome, 'settings.json');
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, 'utf8');
    const nl = detectNewline(text);
    const settings = JSON.parse(text);
    for (const k of provenance.settingsKeys || []) {
      delete settings[k];
      log(`  settings  unset ${k}`);
    }
    if (provenance.hook && settings.hooks?.[provenance.hook.event]) {
      const groups = settings.hooks[provenance.hook.event];
      for (const group of groups) {
        if (!Array.isArray(group.hooks)) continue;
        group.hooks = group.hooks.filter(
          (h) => !(h?.command === provenance.hook.command && deepEqual(h?.args, provenance.hook.args)),
        );
      }
      // Drop now-empty groups, then the event/hooks containers if empty.
      settings.hooks[provenance.hook.event] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length);
      if (!settings.hooks[provenance.hook.event].length) delete settings.hooks[provenance.hook.event];
      if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
      log('  settings  remove SessionStart handover hook');
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2).split('\n').join(nl) + nl);
  }

  // 3. CLAUDE.md — remove our sentinel block, preserve the rest.
  const claudeMdPath = join(claudeHome, 'CLAUDE.md');
  if (provenance.claudeMdBlock && existsSync(claudeMdPath)) {
    const text = readFileSync(claudeMdPath, 'utf8');
    const nl = detectNewline(text);
    const stripped = removeFcckBlock(text, nl);
    if (stripped.trim()) writeFileSync(claudeMdPath, stripped);
    else rmSync(claudeMdPath, { force: true }); // file held only our block → remove it
    log('  CLAUDE.md  removed block');
  }

  // 3b. Launcher shell function.
  if (provenance.launcher) removeLauncher({ claudeHome, command: provenance.launcher.command, shellHome: opts.shellHome, log });

  // 4. Provenance file itself.
  rmSync(provPath, { force: true });
  log('');
  log(`Uninstall complete. Removed ${provenance.kit} from ${claudeHome}.`);
  return { ok: true, removed };
}

// Remove now-empty directories created by our install, walking up but never past claudeHome.
function pruneEmptyDirs(dir, claudeHome) {
  let cur = resolve(dir);
  const root = resolve(claudeHome);
  while (cur.startsWith(root) && cur !== root) {
    try {
      if (readdirSync(cur).length === 0) {
        rmdirSync(cur);   // empty-dir only; throws (and we stop) if anything is left
        cur = dirname(cur);
      } else break;
    } catch {
      break;
    }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = { command: 'install' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--source-root') opts.sourceRoot = argv[++i];
    else if (a === '--claude-home') opts.claudeHome = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length) opts.command = positional[0];
  return opts;
}

const HELP = `${KIT_NAME} — installer

Usage:
  node install.mjs [install]        Deploy into ~/.claude (merges, never clobbers)
  node install.mjs uninstall        Remove everything this kit installed
  node install.mjs --dry-run        Preview without writing

Options:
  --force, -f          Overwrite conflicting files / statusLine
  --dry-run, -n        Show the plan, write nothing
  --manifest <path>    Manifest to deploy (default: manifest.public.json beside this script)
  --source-root <dir>  Root that manifest source paths resolve against (default: manifest's dir)
  --claude-home <dir>  Target home (default: ~/.claude)
  --help, -h           This help
`;

export function main(argv = process.argv.slice(2), scriptDir) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (!opts.manifest && opts.command !== 'uninstall') {
    opts.manifest = join(scriptDir || process.cwd(), 'manifest.public.json');
  }
  try {
    let result;
    if (opts.command === 'uninstall') result = runUninstall(opts);
    else if (opts.command === 'install') result = runInstall({ ...opts, prune: true });
    else throw new Error(`unknown command: ${opts.command}`);
    if (!result.ok) process.exitCode = 1;
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exitCode = 2;
  }
}

// Run as CLI only when invoked directly (not when imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), dirname(fileURLToPath(import.meta.url)));
}
