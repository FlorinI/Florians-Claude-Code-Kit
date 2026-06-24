---
description: Dump the in-head topics of this session, triage each into a bucket (handover / persist / do-now), act on them, and write a handover file for the next session to pick up. Say "/handover ok" to run non-interactively with default buckets.
---

# /handover — deliberate session handover

You are about to do a clean session handover. Don't `/clear` yet; the user will do that after the handover file is written.

## Invocation — `/handover` vs `/handover ok`

If the command was invoked with the argument **`ok`** (case-insensitive — `ok`, `OK`, `Ok` all count), run the flow **with the proposed default buckets and no confirmation prompt** — but NOT silently. Specifically, in this order:

1. Draft the eight coordinates (Step 1) internally. You do not need to print the long-form draft.
2. **Print the Step-2 triage summary table** — the compact `N. [bucket] item` list, defaults already filled in, in the exact format the interactive flow uses (see Step 2). Show it BEFORE acting on or writing anything. This is the recap the user reacts to: because it lands before any M/X action or file write, the user can scan it and hit Esc to interrupt and correct course if a bucket is wrong.
3. Do NOT pause for triage adjustments and do NOT ask for confirmation. After printing the table, continue straight on in the same turn — act on the M and X items (Step 3), write the handover file (Step 4), and report (Step 5).

The only pauses still permitted are the deliberate-action confirmations in Step 3 for outward-facing or hard-to-reverse X items (commits, pushes, deletes, sends) — those are never auto-run off defaults.

Otherwise (plain `/handover`), run the full interactive flow below: present the draft, take the user's triage adjustments, then act.

## Step 1 — draft the eight coordinates

Without reading any new files, draft the handover by filling in the sections below from your conversational context. Be concrete and specific — "Discussed the rewrite" is weak; "Agreed lesson 5 opens at the gateway-ASIN question; AMC source still unsourced" is right.

1. **Goal** — What are we trying to accomplish? One or two sentences naming the objective and why it matters.
2. **What was tried** — What approaches were explored this session, especially any that failed or were abandoned and why.
3. **Decisions & constraints discovered** — Choices that were made ("X over Y because Z") and constraints that surfaced ("the API doesn't support batch mode") that aren't captured in code or git history.
4. **Recent changes** — What was actually modified this session. Concrete: file paths, what changed in each, commit hashes if any.
5. **Files in flight** — Files still being actively edited or that have uncommitted changes.
6. **Next steps** — What to do next, in priority order. Note blockers inline ("step 3 is blocked on user confirming the schema").
7. **User preferences** — Working-style signals that surfaced this session: communication preferences, conventions the user corrected you on, patterns they validated. Only things the next session's Claude would otherwise have to re-learn.
8. **Other context** — Anything that doesn't fit the sections above but would be useful to the next session: half-formed hypotheses, anomalies noticed but not pursued, tangential observations.

Omit a section entirely if it genuinely has nothing to say (e.g. no failures occurred → skip "What was tried"). Never pad a section with filler.

### Persisted vs. session-only split

Within each section, classify every item into one of two sub-groups:

- **Already persisted** — the item is captured somewhere durable: committed code, git history, a memory file, a spec, a GitHub PR/issue, CLAUDE.md, etc. These survive without the handover. Show them dimmed (indented under an "Already persisted:" label) so the user can skim or prune them.
- **Session-only** — the item exists only in this conversation's context. This is the core payload of the handover: decisions not yet documented, observations not yet acted on, user preferences not yet saved to memory, half-formed plans, blockers discovered but not filed. Show these prominently (indented under a "Session-only:" label).

If a section has only persisted items, still include it but mark it — the user may want to drop the whole section. If a section has only session-only items, omit the "Already persisted:" label.

**Render the eight coordinates as named headings in the draft** (`## Goal`, `## What was tried`, …) — do NOT carry the `1.`–`8.` ordinals from the checklist above into your output. Those number *this instruction list*, not the draft; mirroring them in creates a second numbering that collides with the item counter below.

Number every bullet/item sequentially from 1 to N across all sections (the counter does NOT reset between sections). This is the **only** numbering in the draft, which is what lets the user reference any item — e.g. "drop 7", "edit 3" — instead of describing it by position within a section. (Observed failure: a draft that numbered the *sections* 1–8 was then forced to put items on letters a–u to dodge the clash, which broke "drop 7 / edit 3" entirely.)

Show each item's **proposed default bucket** (the Step-2 letter: `H` / `M` / `X` / `—`) in brackets immediately after the number, in **both** this long-form draft and the Step-2 triage — so the user reads each full item together with its disposition, no cross-referencing. The bracket is a proposal; the user adjusts it in Step 2.

Layout — named heading; running counter continuing across the section boundary without resetting; `[bucket]` right after each number:

```
## Goal
1. [—] <session-only item>
2. [H] <already-persisted item, dimmed>

## Recent changes
3. [H] <item>
4. [M] <item>
```

Present the draft to the user for review.

## Step 2 — triage each item into a bucket

Every numbered item gets a disposition — the triage is a **1:1 echo of the draft**: exactly one line per item, **same number, same order, same bracket** as the long-form draft, 1..N. Never summarize, merge, renumber, or drop; if the draft has 21 items, the triage has 21 lines. (Observed failure: 21 draft items collapsed into 7 renumbered topic lines, so no triage line mapped back to a draft item.) The bracket was already proposed inline in Step 1; this compact view just gathers them for quick adjustment. The buckets:

- **H — Handover doc.** Carry forward as orientation for the next session. Forward-looking state: work in flight, blockers, half-formed plans, next steps you are NOT doing now.
- **M — Memory / specs.** Persist durably *right now*. Working-style signals & preferences → a memory file; durable decisions, constraints, architecture, or roadmap → the relevant project spec/doc. You choose memory vs. spec per item, as appropriate.
- **X — Execute now.** Do it before exiting — run the command, make the edit, commit, file the issue.
- **— — Drop.** Not worth any bucket (e.g. already-persisted noise, resolved trivia).

Default heuristics: preferences / working-style → **M** (memory); durable decisions / constraints / roadmap → **M** (spec); quick actionable tasks the user wants done → **X**; forward-looking state & blockers → **H**; already-persisted items → **—** unless worth restating in H.

Present compactly, defaults already filled in — one line per draft item, reusing the draft's numbers (this echoes items 1–N; a real list runs to whatever N was, not a summarized handful):

```
1. [—] Session goal (recorded here, work done)
2. [H] No MCP loaded this session — a restart picks it up
3. [M] Board X is the real roadmap (→ memory)
4. [M] "design principles" = the Visual Identity Brief (→ memory)
5. [H] Design-system file looks thin — drift risk to confirm
6. [X] Deploy statusline to ~/.claude
7. [—] sparkline anchor fix (already committed)
…  (one line per item, through N)
```

Then offer the shorthand:

> `Legend: H = handover · M = memory/specs · X = do now · — = drop.`
> `Adjust with shorthand (e.g. "2X 5H 7-9—") or say "ok" to accept the defaults.`

Accept item-suffix shorthand (`2X`), ranges (`7-9M`), or bucket-grouped (`H 1 2 5; X 3`). Re-show the updated list after each change until the user confirms.

## Step 3 — act on X and M (before writing the file)

Do these first so the handover file can record their outcomes.

- **X items** — execute now, in a sensible order. For anything outward-facing or hard to reverse (commits, pushes, deletes, sends), confirm with the user first per the usual deliberate-action rules. Report what each did.
- **M items** — persist now. Memory files follow the memory-file conventions (frontmatter + a one-line `MEMORY.md` pointer); spec/doc items get written or appended to the right file. Show the user each destination.

If an M item lands in a spec/doc, it no longer needs to live in the handover body — a one-line pointer ("persisted to `docs/X`") is enough.

## Step 4 — write the handover file (H items)

Compute the timestamp as `<YYYY-MM-DDTHH-MM-SS>` (local time, hyphens not colons so it's a valid Windows filename).

Write to `<cwd>/.claude/handovers/<timestamp>.md`. Create the `.claude/handovers/` directory if it doesn't exist.

The file carries the **H** items as its forward-looking payload (in their eight-section structure), plus a short **Resolved before clear** section recording what was executed (X, with outcomes) and persisted (M, with destinations), so the next session sees the full picture.

File shape:

```markdown
---
created: <ISO timestamp>
project: <basename of cwd>
model: <current model display name>
---

# Handover from <timestamp>

## Goal

<...H items...>

## What was tried

<...H items...>

## Decisions & constraints discovered

<...H items...>

## Recent changes

<...H items...>

## Files in flight

<...H items...>

## Next steps

<...H items...>

## User preferences

<...H items...>

## Other context

<...H items...>

## Resolved before clear

- **Executed (X):** <what was done, with outcomes>
- **Persisted (M):** <what was saved, with destinations — memory slug / doc path>
```

Omit any section (including "Resolved before clear") that has nothing in it.

## Step 5 — report and stop

Tell the user the path you wrote to and remind them: "Run `/clear` when ready. Your next session in this directory will auto-load the handover and mark it consumed."

Do not run `/clear` yourself — that's for the user.
