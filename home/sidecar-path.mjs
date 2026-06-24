// sidecar-path.mjs — resolve which status-line sidecar a stateless consumer should READ.
// Node port of sidecar-path.ps1. The status line writes its snapshot to BOTH a project-local
// file (<project>/.claude/statusline-last.json) and the global ~/.claude/statusline-last.json.
// The project-local file is the source of truth; this resolver returns it if it exists, else the
// global fallback — so render-legspark.mjs, render-spikes.mjs and the /handover-check subagent agree.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function resolveSidecarPath(dir) {
  if (!dir || !String(dir).trim()) {
    dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
  const projLocal = join(dir, '.claude', 'statusline-last.json');
  if (existsSync(projLocal)) return projLocal;
  const home = process.env.USERPROFILE || homedir();
  return join(home, '.claude', 'statusline-last.json');
}
