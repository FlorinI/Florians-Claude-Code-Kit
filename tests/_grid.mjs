// Shared row lookup for the dossier grid. NOT a test file — `node --test "tests/**/*.test.mjs"`
// does not pick it up.
//
// A fixed row is no longer at a fixed index: a row whose two halves are both silent does not render
// at all (statusline.mjs `gridRow` returns null), so `lines[5]` is only the flags row on a session
// that happens to fill every row above it. Find a row by the label it carries instead.
//
// Position 0 of every row is a near-black `.` standing in for the first pad space — a row may not
// begin with whitespace or the pad is stripped before it reaches the screen — so the left label
// field is read with that dot put back to a space.

const STRIP = /\x1b\[[0-9;]*m/g;
const LEFT_LABEL_W = 6, RIGHT_LABEL_W = 7;

/** The row (ANSI intact) whose left OR right label is `label`, or '' when no row carries it. */
export function rowByLabel(out, label) {
  for (const row of String(out).split('\n')) {
    const p = row.replace(STRIP, '');
    const i = p.indexOf('│');
    const left = (i < 0 ? p : p.slice(0, i)).replace(/^\./, ' ');
    const right = i < 0 ? '' : p.slice(i + 1).replace(/^ /, '');
    if (left.slice(0, LEFT_LABEL_W).trim() === label) return row;
    if (right.slice(0, RIGHT_LABEL_W).trim() === label) return row;
  }
  return '';
}

/** The flags row, ANSI intact — '' when the session raised no flags and the row did not render. */
export const flagsRow = (out) => rowByLabel(out, 'flags');
