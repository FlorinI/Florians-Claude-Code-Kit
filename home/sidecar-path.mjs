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
//  2. resolveSidecarPath(dir, sid) — WHICH status-line snapshot a stateless consumer should READ.
//     The status line writes one snapshot per session, beside its rollup:
//     <project>/.claude/statusline-stats/<sid>.sidecar.json, or <config-home>/statusline-stats/
//     <sid>.sidecar.json when its payload had no cwd. `sid` defaults to CLAUDE_CODE_SESSION_ID, which
//     Claude Code sets in its tool processes, so render-legspark.mjs, render-spikes.mjs and
//     handover-facts.mjs (the /handover-check fact sheet) all read the calling session's own file.
//     With a sid: the project file, else the home file, else null. Without one: the newest
//     *.sidecar.json by mtime in the project's stats folder, else the home's, else null. null means
//     "no snapshot" to every reader.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const SIDECAR_SUFFIX = '.sidecar.json';

export function resolveConfigHome() {
  const cd = process.env.CLAUDE_CONFIG_DIR;
  if (cd && String(cd).trim()) return resolve(String(cd).trim());
  return join(process.env.USERPROFILE || homedir(), '.claude');
}

// The newest *.sidecar.json in `statsDir` by mtime, or null (missing folder, none there).
function newestSidecar(statsDir) {
  let names;
  try { names = readdirSync(statsDir); } catch { return null; }
  let best = null, bestMs = -Infinity;
  for (const name of names) {
    if (!name.endsWith(SIDECAR_SUFFIX)) continue;
    const fp = join(statsDir, name);
    try {
      const st = statSync(fp);
      if (st.isFile() && st.mtimeMs > bestMs) { best = fp; bestMs = st.mtimeMs; }
    } catch {}
  }
  return best;
}

export function resolveSidecarPath(dir, sid = process.env.CLAUDE_CODE_SESSION_ID) {
  if (!dir || !String(dir).trim()) {
    dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
  const projStats = join(dir, '.claude', 'statusline-stats');
  const homeStats = join(resolveConfigHome(), 'statusline-stats');
  const id = sid ? String(sid).trim() : '';
  if (id) {
    for (const statsDir of [projStats, homeStats]) {
      const fp = join(statsDir, id + SIDECAR_SUFFIX);
      if (existsSync(fp)) return fp;
    }
    return null;
  }
  return newestSidecar(projStats) ?? newestSidecar(homeStats);
}
