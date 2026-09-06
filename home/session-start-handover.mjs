// session-start-handover.mjs — Claude Code SessionStart hook (portable, Node).
//
// The handover-pickup signal of the SessionStart event, kept as its own portable Node hook so it is
// cross-platform. It registers under hooks.SessionStart; any other SessionStart hooks present run in
// parallel, and Claude Code surfaces each systemMessage (order not guaranteed — cosmetic).
//
// Emits a single JSON object { systemMessage, continue:true } on stdout, exit 0:
//   - pending handover (a non-consumed *.md under <cwd>/.desk/handovers/) → tell the user to load it.
//   - otherwise → a one-line greeting noting whether the project has a CLAUDE.md.
// The actual pickup procedure is driven by the CLAUDE.md instructions, not this hook.
//
// ALSO A CLI: `node session-start-handover.mjs --find [projectDir]` prints the absolute path of the
// pending note (empty when there is none) and exits 0, skipping the JSON entirely. This exists so the
// CLAUDE.md pickup procedure CALLS the resolution below instead of restating it in PowerShell — one
// rule, one implementation, covered by the tests that already drive this file. The chip cannot serve
// that purpose: it travels in `systemMessage`, which reaches the user's terminal, while
// `hookSpecificOutput.additionalContext` is the only hook channel that reaches the model.

import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// `--find [dir]`: the optional directory argument wins over the environment, so a session whose shell
// has moved out of the project root still resolves against the right project.
const argv = process.argv.slice(2);
const findAt = argv.indexOf('--find');
const FIND_MODE = findAt !== -1;
const findDir = FIND_MODE && argv[findAt + 1] && !argv[findAt + 1].startsWith('--') ? argv[findAt + 1] : null;

const cwd = findDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Handovers live in <cwd>/.desk/handovers/ — ours, and outside the namespace repos blanket-ignore.
// `.claude/handovers/` is the LEGACY location, still scanned so a repo whose notes haven't moved
// yet is still picked up; drop it once every config home has installed the move. First dir that
// holds a pending note wins, and the banner names the dir it actually found.
let pendingHandover = null;
let handoverRel = '.desk/handovers';
for (const rel of ['.desk/handovers', '.claude/handovers']) {
  const dir = join(cwd, ...rel.split('/'));
  if (!existsSync(dir)) continue;
  try {
    const pending = readdirSync(dir)
      .filter((n) => n.endsWith('.md') && !n.endsWith('.consumed.md'))
      .sort()              // ISO timestamps sort lexicographically
      .reverse();          // most recent first
    if (pending.length) { pendingHandover = pending[0]; handoverRel = rel; break; }
  } catch { /* unreadable dir → try the next */ }
}

// CLI mode ends here: the resolved path, or nothing at all. Empty output means no pending note —
// callers must not read it as an error.
if (FIND_MODE) {
  if (pendingHandover) process.stdout.write(join(cwd, ...handoverRel.split('/'), pendingHandover));
  process.exit(0);
}

const cwdName = basename(cwd);
const claudeMdNote = existsSync(join(cwd, 'CLAUDE.md')) ? 'CLAUDE.md present' : 'no CLAUDE.md';

// ANSI styling. Survives JSON encoding. If the renderer strips escapes the text still reads fine; if it
// honors them, the handover signal pops. Chips kept narrow (the renderer extends bg to end-of-line).
const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const HANDOVER_CHIP = `${ESC}[1;30;103m`; // bold black-on-bright-yellow

const msg = pendingHandover
  ? `\n${HANDOVER_CHIP} HANDOVER ${RESET} ${handoverRel}/${pendingHandover} ready - say anything (eg. 'go') to load.`
  : `\n[${cwdName}] No pending handover - ${claudeMdNote}.`;

process.stdout.write(JSON.stringify({ systemMessage: msg, continue: true }));
process.exit(0);
