# The status line

`statusline.mjs` reads the Claude Code status-line stdin payload and renders a fixed-width,
colour-coded **dossier**: a two-column grid, not a single line. It is the same engine that runs as
the author's daily driver; this kit ships it verbatim. This page is the overview — the authority on
any detail is the engine itself.

## Layout — the two-column grid

**Six always-present fixed rows**, then a variable block of **spotlight-leg** rows.

```
col 1                                    53 54 55 56                                        117
|<-------------- LEFT COLUMN 53 -------->|  │  |<-------------- RIGHT COLUMN 62 ------------>|
```

- **Left column: exactly 53 cells.** A hard invariant — it is what positions the divider, and the
  divider *is* the grid.
- **Divider: `│ `** (U+2502 then a space), 2 cells, in chrome gray. It renders on **every** row,
  including one whose right half is empty; there the trailing space is trimmed, so the divider ends
  up the line's last glyph.
- **Right column: 62 cells.** Total line width: **117 cells**.
- Inside each half the **label field is right-aligned** — 6 cells on the left, 7 on the right — then
  two spaces, then the **value field** (45 cells left, 53 right). So every label in a column ends at
  the same screen column and all its values start at the same one.
- The **left column never overruns.** Its two unbounded strings — the model display name and a
  spotlight leg's driver text — truncate on the right with a trailing `…`; every other left-half
  field is bounded by its formatter.
- The **right column may overrun and never truncates.** Nothing renders to its right, so a long repo
  slug, several caveat chips or a long driver simply make that one line longer. No number is ever
  truncated and no caveat is ever abbreviated to fit.

**Empty clusters keep their address.** A cluster with nothing to say still renders its **label**;
only the value is absent. Nothing collapses and no row goes missing, so the grid holds its shape on
every session — which is the point: a reader can tell "calm" from "no data", and every cluster sits
at a predictable screen position. The quota gauges are the one variation: they state the absence in
one token (`n/a`) rather than leaving a half-empty row that reads as a rendering bug.

### The six fixed rows

| Row | left half | right half |
|---|---|---|
| 1 | **`model`** — display name + effort level | **`cost`** — session total, last leg, next-leg forecast, recent-leg median, cold tax paid |
| 2 | **`ctx`** — tokens/window + distance to the compaction wall | **`trend`** — eight per-leg cost chips + the leg count |
| 3 | **`5h`** — quota gauge (+ a verdict when the window is loud) | **`7d`** — the same, for the 7-day window |
| 4 | *(no label)* — the 5h runway + `resets` | *(no label)* — the 7d runway + `resets` |
| 5 | **`⁂`** — sub-agent fleet aggregate | **`repo`** — slug@branch + sync glyph + version badges |
| 6 | **`cold`** — what a cold resume would cost next | **`flags`** — off-default settings + every earned caveat |

### Rows 7+ — spotlight legs, two to a row

An expensive leg gets its own cell: `<glyph> <index>` in the label field, then `$<usd>`, then what
the leg actually **did** (`re-cached ~80k`, `generated ~2k output`, …). The block is
`ceil(legs / 2)` rows tall, or absent entirely when no leg is expensive enough to spotlight.
Placement is **newest first, left before right** — index 0 → row 7 left, 1 → row 7 right, 2 → row 8
left, and so on. On an **odd** count the last row's right half is left empty and its divider still
renders; the block never borrows the free half beside a fixed row.

## What the numbers mean

A **leg** is one assistant API call. A tool-using turn spans several legs, so per-leg is
finer-grained than per-turn.

- **Row 1 right — `cost`.** `$<total>` cumulative session spend · `last $<x>` the most recent leg's
  *realized* cost · `next $<x>` a composition-weighted *forecast* of the next leg · `med<N> $<x>` the
  **median** of the last up-to-8 legs' dollars, the label carrying the real count · `cold $<x>` the
  cold-cache tax already paid. The realized leg, the forecast and the median are the **same measure on
  the same gradient**, so the three read directly against each other. A median (not a mean) because one
  fat compaction leg must not drag the typical-leg figure into a hotter band than any ordinary leg
  occupies.
- **Row 2 left — `ctx`.** Tokens in context against the model window, coloured by **absolute** token
  count, plus `wall` — the distance to the next auto-compaction. `wall` is quiet by design at every
  distance (`wall off` when auto-compact is disabled, `wall ~<n>` when the window had to be estimated)
  and turns red only at `wall NOW`, once the headroom is gone.
- **Row 2 right — `trend`.** Eight 6-cell chips of per-leg dollars, oldest left, newest right.
  **Position 8 always holds the most recent leg**, so the rightmost cell is a stable anchor; `··` marks
  a cell with no leg, and the bare number after the strip is the total leg count. Past 8 legs the cells
  bucket, staying anchored at the right.
- **Row 5 left — `⁂`.** The sub-agent fleet **aggregate**: agent count, summed peak context, agent
  dollars and their share of session spend, mean legs per agent. Sub-agent cost is divided out of the
  per-leg dollar base, so the per-leg figures are real main-session costs while `$<total>` stays the
  real wallet total.
- **Row 6 left — `cold`.** The **prospective** stake only: the extra a leg pays if it resumes after the
  prompt cache has expired, plus the countdown to that point. The tax already *paid* is the `cold $<x>`
  figure on row 1.

## The three quota regimes

Rows 3 and 4 render for both windows on every session. What changes with the consumed level is
*which machinery runs* behind them, gated by two named constants in `statusline.mjs`:

```js
const QUOTA_VERDICT_MIN_PCT = 50;            // at/above this consumed %, the full projection machinery runs
const QUOTA_PROJECTION_MIN_ELAPSED_PCT = 10; // below it, the calm-case projection needs this much elapsed
```

| Regime | Row 3 | Row 4 | Colour |
|---|---|---|---|
| consumed < 50, elapsed ≥ 10 | gauge + `time` | `ends ~N% · M% spare` + `resets <t>` | all chrome |
| consumed < 50, elapsed < 10 | gauge + `time` | `resets <t>` alone | all chrome |
| consumed ≥ 50 | gauge + `time` + a verdict | the runway detail + `resets <t>` | the rung's colour |
| window absent | label + `n/a` | blank | chrome |

**Below `QUOTA_VERDICT_MIN_PCT` the blackout-projection machinery does not run at all** — no
projected blackout, no runway, no rung colour, no imperative. The projection is genuinely unstable
when little of the window has elapsed: a window 2% consumed after 1% elapsed projects "slow down
hard", which is nonsense on a session that has barely started. Rendering the rows *without* that
machinery keeps the instability off the screen while still showing the calm case honestly.

**`QUOTA_PROJECTION_MIN_ELAPSED_PCT` is a second, separate floor.** What renders below the verdict
floor is the ratio projection `ends ~N% · M% spare` (consumed ÷ elapsed) — a statement about where
the window is heading, with **no imperative attached**. That ratio blows up as elapsed time
approaches zero, so it is **withheld** below 10% elapsed and row 4 shows `resets` alone: a
projection computed off a sliver of elapsed time would be shown and disbelieved. Neither floor is
redundant — the first keeps an unstable imperative off the screen, the second keeps a meaningless
number off it.

## The `flags` row — off-default settings only

Row 6 right carries everything a reader must know about *how this session is configured* and *how its
numbers must be read*, in one fixed order. **Its empty state — the label alone — is the common,
healthy case.**

**Only off-default settings appear.** Each mode chip fires on one state only: fast mode is named when
it is **on**, extended thinking when it is **off**, the output style only when it is **not** the
default. The reassuring half of each pair never renders anywhere on the display, because a line that
announces every default is a line nobody reads. After the mode chips come the conditional caveats —
a cost figure that excludes the fast-mode premium, dollar gates calibrated for a different price
tier, a serving-tier mismatch, a main-plus-agent tier mix — ordered by how much each changes the way
a number must be read, each kept verbatim. This is the one row allowed to run long, so no chip is
ever abbreviated to fit.

## Colour: two quiet tones, then calibrated ladders

- **Chrome — 256-colour 240.** Every label, unit, separator, connective word, the divider, the
  placeholder dots, and every deliberately-quiet value.
- **Neutral — no SGR at all** (the terminal's own foreground): the model name, the agent count, the
  repo slug and branch.

**There is no second gray.** SGR-2 and 256-colour 250 are retired from the engine outright, and
`tests/source-invariants.test.mjs` greps to keep them out. Everything else on the display is a
**calibrated ladder** where the colour *is* the meaning: the session-cost ladder, the absolute
context-token bands, the quota rungs, the cold-cache cooling ramp, the git sync glyphs — and the
per-leg `$` gradient, one continuous gradient shared by the forecast, the realized last leg, the
median, every trend chip and every spotlight leg, so equal dollars render identically wherever they
sit. The **trend strip is the only tinted element** anywhere on the display, which keeps tint one
language rather than a second gray.

## Determinism & testing

The renderer writes a small per-project sidecar (`statusline-last.json`) and per-session stats under
`~/.claude`. The parity goldens (`tools/parity/`) feed frozen stdin + a frozen clock into the engine
in a throwaway HOME and assert the rendered bytes and the sidecar match committed references — so any
change to the output is a deliberate, reviewed re-bless. Bless with the two explicit commands:

    node tools/parity/run-parity.mjs --bless
    node tools/parity/run-trio-parity.mjs --bless

Do NOT use `npm run parity -- --bless`: `parity` is an `&&` chain, so npm appends the flag to the
LAST command only — the trio goldens get blessed and `golden.txt` / `golden-sidecar.json` stay stale
while the suite reports success.
