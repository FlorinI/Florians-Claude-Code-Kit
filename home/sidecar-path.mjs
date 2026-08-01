// sidecar-path.mjs — the shared path helpers for the status-line cluster. Two jobs:
//
//  1. resolveConfigHome() — WHICH user config home the cluster reads/writes. Claude Code's
//     CLAUDE_CONFIG_DIR names that home DIRECTLY (settings.json, stats-cache.json, projects/ all sit
//     at its root — there is no nested .claude), so it is used verbatim when set; otherwise the home
//     is <USERPROFILE|homedir>/.claude. Every consumer in the cluster resolves through this one
//     function so a second-subscription session reads ITS settings and writes ITS caches instead of
//     the default home's. Project-level state (<project>/.claude/…) is deliberately NOT affected —
//     it is per-project, not per-subscription.
//
//  2. resolveSidecarPath() — WHICH status-line sidecar a stateless consumer should READ. The status
//     line writes its snapshot to BOTH a project-local file (<project>/.claude/statusline-last.json)
//     and the global <config-home>/statusline-last.json. The project-local file is the source of
//     truth; this resolver returns it if it exists, else the global fallback — so render-legspark.mjs,
//     render-spikes.mjs and the /handover-check subagent agree.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function resolveConfigHome() {
  const cd = process.env.CLAUDE_CONFIG_DIR;
  if (cd && String(cd).trim()) return resolve(String(cd).trim());
  return join(process.env.USERPROFILE || homedir(), '.claude');
}

export function resolveSidecarPath(dir) {
  if (!dir || !String(dir).trim()) {
    dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
  const projLocal = join(dir, '.claude', 'statusline-last.json');
  if (existsSync(projLocal)) return projLocal;
  return join(resolveConfigHome(), 'statusline-last.json');
}
