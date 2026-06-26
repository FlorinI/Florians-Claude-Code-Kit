// install.test.mjs — smoke test for the manifest-driven base installer (install.mjs).
//
// Exercises the Phase-1 contract end to end against throwaway CLAUDE_HOME temp dirs:
//   • clean install deploys files, merges settings (statusLine forward-slashed + SessionStart hook),
//     sentinel-merges the CLAUDE.md block, and writes provenance;
//   • install MERGES — it preserves a user's own settings keys, hooks, and CLAUDE.md content;
//   • a planted file conflict and a pre-existing foreign statusLine ABORT before any write;
//   • --force overrides; re-install is idempotent; uninstall reverses exactly what we added;
//   • the CLI reports the right exit codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { runInstall, runUninstall, planInstall } from '../install.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const MANIFEST = join(REPO_ROOT, 'manifest.public.json');
const BASE = join(REPO_ROOT, 'install.mjs');
const quiet = () => {};

function freshHome() {
  return mkdtempSync(join(tmpdir(), 'fcck-home-'));
}

function baseOpts(home, extra = {}) {
  // shellHome = home keeps the launcher's shell-profile write inside the throwaway dir (never the
  // real ~/.zshrc / PowerShell profile).
  return { manifest: MANIFEST, sourceRoot: REPO_ROOT, claudeHome: home, shellHome: home, log: quiet, ...extra };
}

function withHome(fn) {
  const home = freshHome();
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('clean install deploys files, merges settings, block, and provenance', () => {
  withHome((home) => {
    const res = runInstall(baseOpts(home));
    assert.equal(res.ok, true);

    // Files deployed.
    assert.ok(existsSync(join(home, 'statusline.mjs')), 'statusline.mjs deployed');
    assert.ok(existsSync(join(home, '_sl-compat.mjs')), '_sl-compat.mjs deployed');
    assert.ok(existsSync(join(home, 'commands', 'handover.md')), 'commands/handover.md deployed');
    assert.ok(existsSync(join(home, 'skills', 'rca', 'SKILL.md')), 'rca skill tree deployed');
    assert.ok(existsSync(join(home, 'skills', 'rca', 'references', 'heavy-rca.md')), 'nested rca file deployed');

    // settings.json: statusLine forward-slashed and substituted; SessionStart hook present.
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.equal(settings.statusLine.type, 'command');
    assert.match(settings.statusLine.command, /node ".*\/statusline\.mjs"/);
    assert.ok(!settings.statusLine.command.includes('\\'), 'statusLine path is forward-slashed (Mac fix)');
    assert.ok(settings.statusLine.command.includes(home.replace(/\\/g, '/')), 'CLAUDE_HOME substituted');
    const startGroup = settings.hooks.SessionStart.find((g) => g.matcher === 'startup');
    assert.ok(startGroup, 'SessionStart startup group exists');
    const ourHook = startGroup.hooks.find((h) => (h.args || []).some((a) => a.includes('session-start-handover.mjs')));
    assert.ok(ourHook, 'handover hook present');
    assert.ok(!ourHook.args[0].includes('\\'), 'hook arg path is forward-slashed');

    // CLAUDE.md block.
    const md = readFileSync(join(home, 'CLAUDE.md'), 'utf8');
    assert.ok(md.includes('FCCK:BEGIN'), 'FCCK begin marker');
    assert.ok(md.includes('FCCK:END'), 'FCCK end marker');
    assert.ok(md.includes('Session handover pickup'), 'block body present');

    // Provenance.
    const prov = JSON.parse(readFileSync(join(home, '.fcck-install.json'), 'utf8'));
    assert.ok(prov.files.includes('statusline.mjs'));
    assert.ok(prov.files.includes('skills/rca/SKILL.md'));
    assert.ok(prov.settingsKeys.includes('statusLine'));
    assert.equal(prov.claudeMdBlock, true);
    assert.ok(prov.hook && prov.hook.event === 'SessionStart');
  });
});

test('install merges — preserves the user\'s settings, hooks, and CLAUDE.md', () => {
  withHome((home) => {
    // Pre-seed a user's settings.json with their own key and their own SessionStart hook,
    // and a CLAUDE.md with their own content.
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      theme: 'dark',
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo', args: ['hi'] }] },
        ],
      },
    }, null, 2));
    writeFileSync(join(home, 'CLAUDE.md'), '# My rules\n\nDo the thing.\n');

    const res = runInstall(baseOpts(home));
    assert.equal(res.ok, true);

    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.equal(settings.theme, 'dark', 'user key preserved');
    const startGroup = settings.hooks.SessionStart.find((g) => g.matcher === 'startup');
    // User's echo hook AND our handover hook both present in the same matcher group.
    assert.ok(startGroup.hooks.some((h) => h.command === 'echo'), 'user hook preserved');
    assert.ok(startGroup.hooks.some((h) => (h.args || []).some((a) => a.includes('session-start-handover.mjs'))), 'our hook appended');

    const md = readFileSync(join(home, 'CLAUDE.md'), 'utf8');
    assert.ok(md.includes('# My rules'), 'user CLAUDE.md content preserved');
    assert.ok(md.includes('Do the thing.'), 'user CLAUDE.md body preserved');
    assert.ok(md.includes('FCCK:BEGIN'), 'our block appended');
  });
});

test('planted file conflict aborts before any write', () => {
  withHome((home) => {
    // A foreign statusline.mjs the user already had (no provenance → not ours).
    writeFileSync(join(home, 'statusline.mjs'), '// the user\'s own file\n');

    const res = runInstall(baseOpts(home));
    assert.equal(res.ok, false, 'install refused');
    assert.ok(res.conflicts.some((c) => c.kind === 'file'), 'file conflict reported');

    // Nothing else written — the abort is before any write.
    assert.ok(!existsSync(join(home, '_sl-compat.mjs')), 'no other file written');
    assert.ok(!existsSync(join(home, '.fcck-install.json')), 'no provenance written');
    assert.equal(readFileSync(join(home, 'statusline.mjs'), 'utf8'), '// the user\'s own file\n', 'foreign file untouched');
  });
});

test('pre-existing foreign statusLine aborts', () => {
  withHome((home) => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'their-statusline', refreshInterval: 5 },
    }, null, 2));

    const res = runInstall(baseOpts(home));
    assert.equal(res.ok, false);
    assert.ok(res.conflicts.some((c) => c.kind === 'statusLine'), 'statusLine conflict reported');
    assert.ok(!existsSync(join(home, '.fcck-install.json')), 'no provenance written');
  });
});

test('--force overrides conflicts', () => {
  withHome((home) => {
    writeFileSync(join(home, 'statusline.mjs'), '// the user\'s own file\n');
    const res = runInstall(baseOpts(home, { force: true }));
    assert.equal(res.ok, true);
    assert.ok(readFileSync(join(home, 'statusline.mjs'), 'utf8').includes('SL_VERSION') ||
      readFileSync(join(home, 'statusline.mjs'), 'utf8').length > 50, 'foreign file overwritten with ours');
    assert.ok(existsSync(join(home, '.fcck-install.json')));
  });
});

test('re-install is idempotent (no conflict on our own files)', () => {
  withHome((home) => {
    assert.equal(runInstall(baseOpts(home)).ok, true);
    const res2 = runInstall(baseOpts(home));
    assert.equal(res2.ok, true, 'second install does not treat our own files as conflicts');
    assert.equal(res2.conflicts.length, 0);

    // CLAUDE.md block not duplicated.
    const md = readFileSync(join(home, 'CLAUDE.md'), 'utf8');
    assert.equal((md.match(/FCCK:BEGIN/g) || []).length, 1, 'block appears exactly once');
  });
});

test('dry-run writes nothing', () => {
  withHome((home) => {
    const res = runInstall(baseOpts(home, { dryRun: true }));
    assert.equal(res.ok, true);
    assert.ok(!existsSync(join(home, 'statusline.mjs')), 'dry-run wrote no files');
    assert.ok(!existsSync(join(home, '.fcck-install.json')), 'dry-run wrote no provenance');
  });
});

test('uninstall reverses exactly what we added, preserving user content', () => {
  withHome((home) => {
    // User content present before install.
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      theme: 'dark',
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo', args: ['hi'] }] }] },
    }, null, 2));
    writeFileSync(join(home, 'CLAUDE.md'), '# My rules\n\nKeep me.\n');

    runInstall(baseOpts(home));
    const un = runUninstall(baseOpts(home));
    assert.equal(un.ok, true);

    // Our files gone.
    assert.ok(!existsSync(join(home, 'statusline.mjs')), 'our file removed');
    assert.ok(!existsSync(join(home, 'skills', 'rca')), 'our skill dir removed');
    assert.ok(!existsSync(join(home, '.fcck-install.json')), 'provenance removed');

    // User content intact.
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.equal(settings.theme, 'dark', 'user key kept');
    assert.equal(settings.statusLine, undefined, 'our statusLine removed');
    const startGroup = settings.hooks.SessionStart.find((g) => g.matcher === 'startup');
    assert.ok(startGroup.hooks.some((h) => h.command === 'echo'), 'user hook kept');
    assert.ok(!startGroup.hooks.some((h) => (h.args || []).some((a) => a.includes('session-start-handover.mjs'))), 'our hook removed');

    const md = readFileSync(join(home, 'CLAUDE.md'), 'utf8');
    assert.ok(md.includes('# My rules'), 'user CLAUDE.md kept');
    assert.ok(!md.includes('FCCK:BEGIN'), 'our block removed');
  });
});

test('uninstall removes a CLAUDE.md that held only our block', () => {
  withHome((home) => {
    runInstall(baseOpts(home));               // no pre-existing CLAUDE.md → file holds only our block
    runUninstall(baseOpts(home));
    assert.ok(!existsSync(join(home, 'CLAUDE.md')), 'CLAUDE.md removed when it held only our block');
  });
});

test('CLI: conflict exits non-zero, clean exits zero', () => {
  withHome((home) => {
    // Sandbox HOME so the launcher's setupLauncher (which uses homedir() when no shellHome is
    // passed) writes a profile inside the throwaway dir, NEVER the real ~/.zshrc / PowerShell profile.
    const env = { ...process.env, USERPROFILE: home, HOME: home };
    // Plant a conflict, run the CLI, expect exit 1.
    writeFileSync(join(home, 'statusline.mjs'), '// theirs\n');
    let code = 0;
    try {
      execFileSync('node', [BASE, '--manifest', MANIFEST, '--source-root', REPO_ROOT, '--claude-home', home], { stdio: 'pipe', env });
    } catch (e) {
      code = e.status;
    }
    assert.equal(code, 1, 'conflict → exit 1');

    // Force it through, expect exit 0.
    execFileSync('node', [BASE, '--manifest', MANIFEST, '--source-root', REPO_ROOT, '--claude-home', home, '--force'], { stdio: 'pipe', env });
    assert.ok(existsSync(join(home, '.fcck-install.json')), 'forced install succeeded via CLI');
  });
});

test('CLI: --help exits zero', () => {
  const out = execFileSync('node', [BASE, '--help'], { encoding: 'utf8' });
  assert.match(out, /Usage:/);
});

test('clean install adds the cc launcher shell function; uninstall removes it', () => {
  withHome((home) => {
    runInstall(baseOpts(home));
    // The profile path is platform-specific; find whichever one was written under the sandbox home.
    const candidates = [
      join(home, 'Documents', 'PowerShell', 'profile.ps1'),
      join(home, '.zshrc'),
      join(home, '.bash_profile'),   // macOS + bash (login shell) — see launcherProfile()
      join(home, '.bashrc'),
    ];
    const profile = candidates.find((p) => existsSync(p));
    assert.ok(profile, 'a shell profile was written');
    const body = readFileSync(profile, 'utf8');
    assert.match(body, /\bcc\b/, 'cc function present');
    assert.match(body, /claude-launch\.mjs/, 'launcher function points at claude-launch.mjs');

    const prov = JSON.parse(readFileSync(join(home, '.fcck-install.json'), 'utf8'));
    assert.ok(prov.launcher && prov.launcher.command === 'cc', 'launcher recorded in provenance');

    runUninstall(baseOpts(home));
    const after = existsSync(profile) ? readFileSync(profile, 'utf8') : '';
    assert.ok(!/claude-launch\.mjs/.test(after), 'launcher block removed on uninstall');
  });
});

test('re-install does not duplicate the launcher block', () => {
  withHome((home) => {
    runInstall(baseOpts(home));
    runInstall(baseOpts(home));
    const candidates = [join(home, 'Documents', 'PowerShell', 'profile.ps1'), join(home, '.zshrc'), join(home, '.bash_profile'), join(home, '.bashrc')];
    const profile = candidates.find((p) => existsSync(p));
    const body = readFileSync(profile, 'utf8');
    assert.equal((body.match(/claude-launch\.mjs/g) || []).length, 1, 'launcher line appears exactly once');
  });
});

test('re-install with prune removes files the manifest no longer ships (and only those)', () => {
  withHome((home) => {
    // First install with the real manifest, pruning on.
    assert.equal(runInstall(baseOpts(home, { prune: true })).ok, true);
    const victim = join(home, 'commands', 'handover-check.md');
    const keeper = join(home, 'commands', 'handover.md');
    assert.ok(existsSync(victim), 'precondition: victim deployed');
    assert.ok(existsSync(keeper), 'precondition: keeper deployed');

    // Build a manifest that drops one file entry, write it anywhere (sourceRoot still = REPO_ROOT).
    const full = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    full.files = full.files.filter((e) => e.source !== 'home/commands/handover-check.md');
    const trimmed = join(home, '_trimmed-manifest.json');
    writeFileSync(trimmed, JSON.stringify(full, null, 2));

    const res = runInstall(baseOpts(home, { manifest: trimmed, prune: true }));
    assert.equal(res.ok, true);
    assert.ok(!existsSync(victim), 'dropped file pruned');
    assert.ok(existsSync(keeper), 'still-shipped sibling kept');

    // Provenance no longer lists the pruned file; still lists a keeper.
    const prov = JSON.parse(readFileSync(join(home, '.fcck-install.json'), 'utf8'));
    assert.ok(!prov.files.includes('commands/handover-check.md'), 'pruned file dropped from provenance');
    assert.ok(prov.files.includes('commands/handover.md'), 'keeper retained in provenance');
  });
});

test('prune leaves user-owned files untouched (prunes only what provenance records)', () => {
  withHome((home) => {
    runInstall(baseOpts(home, { prune: true }));
    // A file the user dropped in themselves — never in our provenance.
    const userFile = join(home, 'commands', 'my-own.md');
    writeFileSync(userFile, '# mine\n');

    // Re-install with a manifest missing a real entry; the user's file must survive regardless.
    const full = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    full.files = full.files.filter((e) => e.source !== 'home/commands/handover-check.md');
    const trimmed = join(home, '_trimmed-manifest.json');
    writeFileSync(trimmed, JSON.stringify(full, null, 2));
    runInstall(baseOpts(home, { manifest: trimmed, prune: true }));

    assert.ok(existsSync(userFile), 'user-owned file not pruned');
    assert.equal(readFileSync(userFile, 'utf8'), '# mine\n', 'user file untouched');
  });
});

test('without prune, re-install accumulates provenance (two-manifest path stays safe)', () => {
  withHome((home) => {
    runInstall(baseOpts(home));                 // prune off (default)
    const full = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    full.files = full.files.filter((e) => e.source !== 'home/commands/handover-check.md');
    const trimmed = join(home, '_trimmed-manifest.json');
    writeFileSync(trimmed, JSON.stringify(full, null, 2));
    runInstall(baseOpts(home, { manifest: trimmed }));   // prune still off

    // Old file stays on disk and in provenance — no pruning happened.
    assert.ok(existsSync(join(home, 'commands', 'handover-check.md')), 'file kept when prune off');
    const prov = JSON.parse(readFileSync(join(home, '.fcck-install.json'), 'utf8'));
    assert.ok(prov.files.includes('commands/handover-check.md'), 'accumulated provenance retains it');
  });
});

test('planInstall surfaces conflicts without writing', () => {
  withHome((home) => {
    writeFileSync(join(home, 'leg-driver.mjs'), '// theirs\n');
    const plan = planInstall(baseOpts(home));
    assert.ok(plan.conflicts.length >= 1, 'conflict surfaced in plan');
    assert.ok(!existsSync(join(home, '.fcck-install.json')), 'planning wrote nothing');
  });
});
