// session-start-handover.mjs — Claude Code SessionStart hook (portable, Node).
//
// The handover-pickup signal of the SessionStart event, kept as its own portable Node hook so it is
// cross-platform. It registers under hooks.SessionStart; any other SessionStart hooks present run in
// parallel, and Claude Code surfaces each systemMessage (order not guaranteed — cosmetic).
//
// Emits a single JSON object { systemMessage, continue:true } on stdout, exit 0:
//   - pending handover (a non-consumed *.md under <cwd>/.claude/handovers/) → tell the user to load it.
//   - otherwise → a one-line greeting noting whether the project has a CLAUDE.md.
// The actual pickup procedure is driven by the CLAUDE.md instructions, not this hook.

import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let pendingHandover = null;
const handoverDir = join(cwd, '.claude', 'handovers');
if (existsSync(handoverDir)) {
  try {
    const pending = readdirSync(handoverDir)
      .filter((n) => n.endsWith('.md') && !n.endsWith('.consumed.md'))
      .sort()              // ISO timestamps sort lexicographically
      .reverse();          // most recent first
    if (pending.length) pendingHandover = pending[0];
  } catch { /* unreadable dir → no handover */ }
}

const cwdName = basename(cwd);
const claudeMdNote = existsSync(join(cwd, 'CLAUDE.md')) ? 'CLAUDE.md present' : 'no CLAUDE.md';

// ANSI styling. Survives JSON encoding. If the renderer strips escapes the text still reads fine; if it
// honors them, the handover signal pops. Chips kept narrow (the renderer extends bg to end-of-line).
const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const HANDOVER_CHIP = `${ESC}[1;30;103m`; // bold black-on-bright-yellow

const msg = pendingHandover
  ? `\n${HANDOVER_CHIP} HANDOVER ${RESET} .claude/handovers/${pendingHandover} ready - say anything (eg. 'go') to load.`
  : `\n[${cwdName}] No pending handover - ${claudeMdNote}.`;

process.stdout.write(JSON.stringify({ systemMessage: msg, continue: true }));
process.exit(0);
