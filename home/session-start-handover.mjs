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
// SEVERAL PENDING NOTES: the banner lists them all, numbered newest first, with the keywords that
// choose between them (take N / take N M / take all / skip / peek). `--list [projectDir]` prints the
// same list, one absolute path per line, for the pickup procedure.
//
// ALSO A CLI: `node session-start-handover.mjs --find [projectDir]` prints the absolute path of the
// pending note (empty when there is none) and exits 0, skipping the JSON entirely. This exists so the
// CLAUDE.md pickup procedure CALLS the resolution below instead of restating it in PowerShell — one
// rule, one implementation, covered by the tests that already drive this file. The chip cannot serve
// that purpose: it travels in `systemMessage`, which reaches the user's terminal, while
// `hookSpecificOutput.additionalContext` is the only hook channel that reaches the model.
//
// OPT-OUT: CC_SKIP_HANDOVER_PICKUP=1 (exactly "1") switches pickup off for this session. A launcher
// that starts a session not meant to continue the work (a search, an always-on helper) sets it, so the
// note stays pending for the session it was written for. `--find` then prints nothing, whether or not
// a note is pending, and the chip says pickup is off instead of inviting a load. The variable is
// inherited by every process the session starts, including the shell that runs `--find`.

import { readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// `--find [dir]`: the optional directory argument wins over the environment, so a session whose shell
// has moved out of the project root still resolves against the right project.
const argv = process.argv.slice(2);
const findAt = argv.indexOf('--find');
const FIND_MODE = findAt !== -1;
const cliAt = FIND_MODE ? findAt : argv.indexOf('--list');
const findDir = cliAt !== -1 && argv[cliAt + 1] && !argv[cliAt + 1].startsWith('--') ? argv[cliAt + 1] : null;

const cwd = findDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SKIP_PICKUP = process.env.CC_SKIP_HANDOVER_PICKUP === '1';

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

// EVERY pending note, for the banner and `--list`: both directories merged and numbered newest first
// by filename, so the number Florian types is the number the banner shows and the line `--list`
// prints. (`--find` keeps its older single-note rule — first directory wins — for any pickup
// procedure that still calls it.)
const allPending = [];
for (const rel of ['.desk/handovers', '.claude/handovers']) {
  const dir = join(cwd, ...rel.split('/'));
  if (!existsSync(dir)) continue;
  try {
    for (const n of readdirSync(dir)) {
      if (n.endsWith('.md') && !n.endsWith('.consumed.md')) allPending.push({ rel, name: n });
    }
  } catch { /* unreadable dir → skip it */ }
}
allPending.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

// CLI mode ends here: the resolved path, or nothing at all. Empty output means no pending note —
// callers must not read it as an error. With pickup off, nothing is printed either way.
if (FIND_MODE) {
  if (pendingHandover && !SKIP_PICKUP) process.stdout.write(join(cwd, ...handoverRel.split('/'), pendingHandover));
  process.exit(0);
}
// `--list [dir]`: every pending note's absolute path, one per line, numbered order (newest first).
const listAt = argv.indexOf('--list');
if (listAt !== -1) {
  if (!SKIP_PICKUP) process.stdout.write(allPending.map((p) => join(cwd, ...p.rel.split('/'), p.name)).join('\n'));
  process.exit(0);
}

const cwdName = basename(cwd);
const claudeMdNote = existsSync(join(cwd, 'CLAUDE.md')) ? 'CLAUDE.md present' : 'no CLAUDE.md';

// ANSI styling. Survives JSON encoding. If the renderer strips escapes the text still reads fine; if it
// honors them, the handover signal pops. Chips kept narrow (the renderer extends bg to end-of-line).
const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const HANDOVER_CHIP = `${ESC}[1;30;103m`; // bold black-on-bright-yellow

// The keywords the pickup procedure acts on (the "Session handover pickup" firmware block). With one
// note, any other first message still loads it; with several, any other message loads none.
const KEYS_ONE = `say 'take' (or anything) to load it · 'peek' to read it without consuming · 'skip' to leave it`;
const KEYS_MANY = `'take 2' one · 'take 1 3' several · 'take all' · 'skip' none · 'peek' or 'peek 2' to read without consuming`;
const noteLine = (p, i) => `  ${i + 1}  ${p.rel}/${p.name}`;

const msg = pendingHandover && SKIP_PICKUP
  ? `\n[${cwdName}] Handover pickup is off in this session; ${handoverRel}/${pendingHandover} stays pending for its own session.`
  : allPending.length > 1
  ? `\n${HANDOVER_CHIP} HANDOVERS ${RESET} ${allPending.length} pending, newest first:\n` +
    allPending.map(noteLine).join('\n') + `\n${KEYS_MANY}`
  : pendingHandover
  ? `\n${HANDOVER_CHIP} HANDOVER ${RESET} ${handoverRel}/${pendingHandover} ready - ${KEYS_ONE}.`
  : `\n[${cwdName}] No pending handover - ${claudeMdNote}.`;

process.stdout.write(JSON.stringify({ systemMessage: msg, continue: true }));
process.exit(0);
