---
description: Dump the in-head topics of this session, triage each into a bucket (handover / memory / project-docs / do-now), act on them, and write a handover file for the next session to pick up. Say "/handover ok" to run non-interactively with default buckets.
---

# /handover — deliberate session handover

You are about to do a clean session handover. Don't `/clear` yet; the user will do that after the handover file is written.

## Invocation — `/handover` vs `/handover ok`

If the command was invoked with the argument **`ok`** (case-insensitive — `ok`, `OK`, `Ok` all count), run the flow **with the proposed default buckets and no confirmation prompt** — but NOT silently. Specifically, in this order:

1. Draft the eight coordinates (Step 1) internally. You do not need to print the long-form draft.
2. **Print the Step-2 triage summary table** — the compact `N. [bucket] item` list, defaults already filled in, in the exact format the interactive flow uses (see Step 2). Show it BEFORE acting on or writing anything. This is the recap the user reacts to: because it lands before any M/D/X action or file write, the user can scan it and hit Esc to interrupt and correct course if a bucket is wrong.
3. Do NOT pause for triage adjustments and do NOT ask for confirmation. After printing the table, continue straight on in the same turn — act on the M, D, and X items (Step 3), write the handover file (Step 4), and report (Step 5).

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

Show each item's **proposed default bucket** (the Step-2 letter: `H` / `M` / `D` / `X` / `—`) in brackets immediately after the number, in **both** this long-form draft and the Step-2 triage — so the user reads each full item together with its disposition, no cross-referencing. The bracket is a proposal; the user adjusts it in Step 2.

Layout — named heading; running counter continuing across the section boundary without resetting; `[bucket]` right after each number:

```
## Goal
1. [—] <session-only item>
2. [H] <already-persisted item, dimmed>

## Recent changes
3. [H] <item>
4. [M] <working-style preference>
5. [D] <durable project decision>
```

Present the draft to the user for review.

## Step 2 — triage each item into a bucket

Every numbered item gets a disposition — the triage is a **1:1 echo of the draft**: exactly one line per item, **same number, same order, same bracket** as the long-form draft, 1..N. Never summarize, merge, renumber, or drop; if the draft has 21 items, the triage has 21 lines. (Observed failure: 21 draft items collapsed into 7 renumbered topic lines, so no triage line mapped back to a draft item.) The bracket was already proposed inline in Step 1; this compact view just gathers them for quick adjustment. The buckets:

- **H — Handover doc.** Carry forward as orientation for the next session. Forward-looking state: work in flight, blockers, half-formed plans, next steps you are NOT doing now.
- **M — Claude memory.** A durable fact about *how to work with the user, or how Claude should behave* — a working-style preference, a correction, a validated pattern, a reference Claude will want again. Persist now to a memory file (frontmatter + a one-line `MEMORY.md` pointer). Audience: **future Claude sessions**; it lives in Claude's memory dir, never in the repo.
- **D — Project docs.** A durable fact about *the project itself* — a decision ("X over Y because Z"), a constraint, an architectural choice, a convention, a roadmap item. Persist now into the repo's own documentation (`SPEC.md`, `docs/…`, `CLAUDE.md`, an ADR/roadmap — whatever the project uses). Audience: **anyone working on the project**; it's version-controlled and ships with the code.
- **X — Execute now.** Do it before exiting — run the command, make the edit, commit, file the issue.
- **— — Drop.** Not worth any bucket (e.g. already-persisted noise, resolved trivia).

**M vs D — which target?** The split is about *audience and ownership*, not importance. Three tests, any one decides it:
- **Audience** — would a new human teammate, with no access to Claude's memory, need this to work on the project? Yes → **D**. It only helps *Claude* serve the user better → **M**.
- **Aboutness** — is the fact about the *product/codebase* (why it's built this way, what a constraint is)? → **D**. Is it about the *collaboration* (how the user likes to work, a correction, a preference)? → **M**.
- **Ownership** — does it belong in version control and survive a fresh clone? → **D**. Does it belong to the user's personal Claude env, across all projects? → **M**.

When an item is genuinely both (a decision that also revealed a working-style preference), split it: the decision → **D**, the preference → **M**. When a project has no docs home for it yet, that's a **D** item whose action is "create the doc" — don't downgrade it to **M** just because the file doesn't exist.

Default heuristics: preferences / working-style / corrections / validated patterns → **M** (Claude memory); durable decisions / constraints / architecture / conventions / roadmap → **D** (project docs); quick actionable tasks the user wants done → **X**; forward-looking state & blockers → **H**; already-persisted items → **—** unless worth restating in H.

Present compactly, defaults already filled in — one line per draft item, reusing the draft's numbers (this echoes items 1–N; a real list runs to whatever N was, not a summarized handful):

```
1. [—] Session goal (recorded here, work done)
2. [H] No MCP loaded this session — a restart picks it up
3. [D] Board X is the real roadmap (→ docs/roadmap)
4. [M] The user prefers dense, drillable displays (→ memory)
5. [H] Design-system file looks thin — drift risk to confirm
6. [X] Deploy statusline to ~/.claude
7. [—] sparkline anchor fix (already committed)
…  (one line per item, through N)
```

Then offer the shorthand:

> `Legend: H = handover · M = Claude memory · D = project docs · X = do now · — = drop.`
> `Adjust with shorthand (e.g. "2X 5H 7-9D") or say "ok" to accept the defaults.`

Accept item-suffix shorthand (`2X`), ranges (`7-9M`), or bucket-grouped (`H 1 2 5; X 3`). Re-show the updated list after each change until the user confirms.

## Step 3 — act on X, M, and D (before writing the file)

Do these first so the handover file can record their outcomes.

- **X items** — execute now, in a sensible order. For anything outward-facing or hard to reverse (commits, pushes, deletes, sends), confirm with the user first per the usual deliberate-action rules. Report what each did.
- **M items** — persist now to Claude memory, following the memory-file conventions (frontmatter + a one-line `MEMORY.md` pointer). Show the user the memory slug.
- **D items** — write or append to the right project doc (`SPEC.md`, `docs/…`, `CLAUDE.md`, roadmap, or a new ADR); create the doc if the project has no home for it yet. Show the user each destination path.

If a D item lands in a project doc, it no longer needs to live in the handover body — a one-line pointer ("documented in `docs/X`") is enough.

## Step 4 — write the handover file (H items)

Compute the timestamp as `<YYYY-MM-DDTHH-MM-SS>` (local time, hyphens not colons so it's a filesystem-safe filename on every OS — colons are invalid on Windows).

Then add a **slug** naming what the handover is *about*: 2–4 kebab-case words drawn from the semantics of the H payload — `sprint-chain-flight`, `cold-tax-recal`, `handover-file-naming` — never a generic filler like `session`, `work`, or `misc`. A handover usually has one dominant topic; when the payload genuinely splits across two or three unrelated topics, join their slugs with commas and no spaces (`sprint-chain-flight,inbox-triage`). Lowercase ASCII letters, digits, hyphens, and those separating commas only.

Write to `<cwd>/.desk/handovers/<timestamp>-<slug>.md`. Create the `.desk/handovers/` directory if it doesn't exist.

**Scaffold `.desk/.gitignore` when it is missing** — one line, `handovers/*.consumed.md`, plus a comment saying consumed notes are spent and only unconsumed ones belong in the repo. Only unconsumed handovers live in the repo; a consumed one is a note some session already loaded. The rule sits *inside* `.desk/` rather than in the repo's root `.gitignore` because `.desk/` is this env's own directory — so it needs no entry in a file the project owns, no per-machine git config, and it survives a fresh clone. Never add a `.desk` rule to the repo's root `.gitignore`.

`.desk/` is the project's own store for what this env persists — the handover notes and `session-identity.json`. It sits outside `.claude/`, which repos routinely blanket-ignore, so a handover written here is visible to git by default and can travel to another machine. Whether and when to commit it is the user's call: never offer to commit, and never nudge. A repo that still has notes under the old `.claude/handovers/` is still picked up at session start; new ones go to `.desk/`.

The timestamp stays the leading component so the files still sort chronologically by name (which is how session pickup finds the most recent one); the slug is what makes a directory listing readable months later.

The file carries the **H** items as its forward-looking payload (in their eight-section structure), plus a short **Resolved before clear** section recording what was executed (X, with outcomes), persisted to memory (M), and documented in the project (D), so the next session sees the full picture.

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
- **Persisted to memory (M):** <memory slug(s)>
- **Documented in the project (D):** <doc path(s)>
```

Omit any section (including "Resolved before clear") that has nothing in it.

## Step 5 — report and stop

Tell the user the path you wrote to and remind them: "Run `/clear` when ready. Your next session in this directory will auto-load the handover and mark it consumed."

Do not run `/clear` yourself — that's for the user.
