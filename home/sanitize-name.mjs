// sanitize-name.mjs — the ONE session-name sanitizer, applied on BOTH write and read.
//
// A session name reaches the status line from the payload (`session_name` = the /rename · --name
// custom name, else Claude Code's own AI title) and reaches the fact sheet from a persisted file
// (the sidecar, or a per-session stats file that may have been written by another tool, a hand edit,
// or a lagging machine's build). Both ends call this function, so the invariant holds whoever wrote
// the file — that independence IS the point of sharing it.
//
// The invariant: a name is a non-empty, single-line string of at most NAME_CAP code points carrying
// no ANSI escape sequence, no C0/C1 control byte, no DEL, no zero-width or invisible formatting
// character, no backtick, and no run of whitespace longer than one space; trimmed at both ends.
// Anything that reduces to empty is `null` (absent), never an empty string.
//
// Backticks are STRIPPED, not escaped: the fact sheet renders the name inside a Markdown inline-code
// span, and a backtick cannot be escaped inside one.
//
// No imports by design — this is the hot path's dependency (statusline.mjs) as well as the fact
// sheet's, and `home/*.mjs` carries zero runtime dependencies.

export const NAME_CAP = 80;

// ANSI escapes are stripped FIRST, so a CSI body ('[31m') leaves with its ESC byte instead of
// surviving as literal text once the ESC alone is removed as a control character.
const ANSI_CSI = /\x1B\[[0-?]*[ -\/]*[@-~]/g;
const CTRL = /[\x00-\x1F\x7F-\x9F]/g;   // C0 + DEL + C1
// Invisible formatting characters: zero-width space, ZWNJ, ZWJ (U+200B..U+200D), word joiner
// (U+2060), BOM (U+FEFF). Composed from code points rather than written as escapes so this source
// file carries no invisible bytes of its own.
const INVISIBLE = new RegExp('[' + String.fromCharCode(0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF) + ']', 'g');

export function sanitizeSessionName(v) {
  if (typeof v !== 'string') return null;
  let s = v.replace(ANSI_CSI, '').replace(CTRL, '').replace(INVISIBLE, '').replace(/`/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // Cap by CODE POINT (Array.from), never by UTF-16 unit, so a surrogate pair straddling the cut is
  // never split into a lone surrogate. Over the cap → the first NAME_CAP-1 plus an ellipsis, so the
  // result is exactly NAME_CAP code points.
  const cps = Array.from(s);
  return cps.length > NAME_CAP ? cps.slice(0, NAME_CAP - 1).join('') + '…' : s;
}
