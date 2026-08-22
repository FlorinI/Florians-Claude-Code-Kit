---
description: Read the current status-line snapshot and explain — in plain terms — whether it's time to hand over (cost vs quality), with the practical reads.
---

# /handover-check

Explain the current session's status line to the user in plain, practical terms — the read a smart person who doesn't live in Opus session-management would want.

The heavy lifting is **deterministic**: a Layer-1 script (`handover-facts.mjs`) resolves every classification/verdict and pre-formats every number, so the **isolated subagent** only has to *compose* — weave the facts into insightful prose. This keeps the check off the very context it measures, kills the band-misread and backtick-mangle classes (the model can't fumble what it's handed), and **front-loads every tool call** so the report is **one uninterrupted reply** (Claude Code collapses/fragments tool output — nothing must land mid-prose).

## How to run

Two phases — **all data-gathering first, then one report.**

**Phase 1 — gather (emit NO prose yet).** Order matters: the fact sheet runs FIRST and **freezes** the exact snapshot, then the two charts read that frozen copy (`--frozen`) so all three see the SAME session — even if a concurrent same-project session clobbers the live sidecar between reads (the within-report session-split bug).
1. Run the fact sheet **alone** first — it writes the freeze. (`$HOME` expands in both PowerShell and bash; Node accepts the forward slashes on Windows too. On Florian's Windows boxes, use the PowerShell tool per the project convention.)

       node "$HOME/.claude/handover-facts.mjs"

   If it prints `MISSING`, tell the user to let the status line render once (press Enter on an empty prompt) and re-run — stop here.
   If its first line is `FOREIGN`, this session has no status-line snapshot of its own and the resolver fell back to **another session's** sidecar (the following lines give this session vs the snapshot's owner — each named in words with its id fragment in brackets when that session has a name, id fragment alone otherwise; relay them as given). This is the signature of a session that never renders a status line — the **Claude Code desktop app** is the common case. Do NOT report the numbers: they belong to a different session and would be meaningless here. Tell the user plainly that handover-check can't read this session (no live status line — e.g. the desktop app) and that it works from a terminal session where the status line renders — then **stop here**.
   If its first line is `SCHEMA_MISMATCH`, the snapshot was written by a status line of a different build than this reader, so its shape is one this reader does not know. The following lines give the schema version this reader expects, the version the snapshot carries, and the one instruction that clears it — relay all of them as given. Do NOT report any numbers, and do NOT run the charts or the subagent: there is no reading here, only the fix. Then **stop here**.
2. **Then**, in **one message**, run the two charts with `--frozen` AND spawn the subagent (they're independent):

         node "$HOME/.claude/render-legspark.mjs" --mono --frozen
         node "$HOME/.claude/render-spikes.mjs" --mono --frozen

   - **Agent** tool — `subagent_type: general-purpose`, `model: sonnet`, `description: handover-check read`, `prompt:` the indented block under *Subagent prompt* below, with the **`handover-facts.mjs` output pasted into the `FACT SHEET:` slot**. It does NO tool calls — it only composes — and returns Style-B markdown. (Sonnet, not Haiku: the compose step is one cheap call, and Sonnet is more reliable at adding *correct* insight without bending a band's meaning — Haiku once wrote "the ~60% cliff where things get sharp", which is inverted.)

   `-Mono` gives plain glyphs (no ANSI — the message surface strips colour). The fact sheet, legspark, and spikes now all read one frozen snapshot, so they're mutually consistent.

**Phase 2 — verify, then emit ONE message.** FIRST cross-check consistency: the 8-hex session id in the fact sheet's IDENTITY line must match the `from session <hex>` stamp on **both** legspark and spikes. If any differ, the freeze didn't hold (a concurrent same-project session clobbered the snapshot mid-run) — discard everything and re-run Phase 1 **once**. If they still differ after the retry, emit the report but prepend a bold warning that the snapshot may be cross-session and the numbers shouldn't be trusted. Otherwise, write the whole report as a single reply, **no tool calls interleaved**, wrapped top and bottom by the separator so it stands out from the surrounding tool calls and chat. Put a blank line after the top separator and before the bottom one so each renders on its own line:
- **top separator** (verbatim, own line):

      ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ /handover-check ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪

- the subagent's read, pasted **verbatim** (it's already Style-B markdown — add nothing);
- then the two renders under it, each copied **verbatim** into its own plain fenced code block (` ``` `) — **legspark first, spikes second**;
- then one closing line, e.g. *Ask a follow-up — e.g. "what would clearing save me?"*
- **bottom separator** (verbatim, own line):

      ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪

## Style B — the report's look

The report lands in the **assistant message**, the one surface that never collapses. It renders **bold**, light-blue `inline code`, and green/red ` ```diff ` blocks — nothing else (raw ANSI is stripped). The fact sheet already supplies backticked numbers and `+`/`-` polarities; the subagent just places them. Markdown is NOT parsed inside a diff block, so bold/backticks never go there. The two renders are monospace and uncoloured — expected.

## The renders (Phase 1)

- **handover-facts** (`handover-facts.mjs`) — the deterministic fact sheet: resolves the headline verdict (cost rule = **the absolute next-leg `$`, on a three-rung dollar ladder** — plenty of room / wind down soon / time to hand over), the cold-band wording, the quality lead, activity keep/omit, trajectory shape, and the your-call lean; every number arrives backtick-wrapped. Tunable thresholds live at the top of the script.
- **legspark** (`render-legspark.mjs --mono`) — trailing-10-leg moving average of per-leg $, oldest→newest (smooths spikes to show the trend); header reports the raw peak.
- **spikes** (`render-spikes.mjs --mono`) — up to TWO tables. First: the 3 priciest **main-thread legs**, each with **why** (loaded new context / generated output / re-read deep context); `❆` marks legs counted in the cold tax. Second (only when the session spawned sub-agents): the 3 **fattest agents** — whole-agent totals with task label, `$`, ×-median, legs, peak leg, and dominant cause (re-reading context / loading content / generating output). Sub-agent cost NEVER appears in the leg table (the leg scan covers the main transcript only; agents are kept aggregate-only by design), so heavy agent spend surfaces in the agents table, never as leg spikes. Complements legspark (shape vs. the worst + cause).

Copy legspark and spikes verbatim into their fenced blocks — do not redraw, recolour, re-scale, or describe them.

## Subagent prompt

    You are the /handover-check explainer. Below is a deterministic FACT SHEET — every number is already formatted (backticks on) and every classification/verdict is already resolved. Your ONLY job is to compose the report as fluent, insightful Style-B markdown prose. Do NOT recompute, reclassify, reformat, or add/remove backticks; do NOT invent numbers. If a value reads `?`, omit that detail.

    The fact-sheet KEYS — the ALL-CAPS labels before each colon (IDENTITY:, HEADLINE_DIFF:, COST_LEAD:, COST_RECENT:, QUALITY_LEAD:, YOURCALL_BASIS:, etc.) — are for YOU only. NEVER print a key name in the report; use only the value to the RIGHT of the colon.

    FACT SHEET:
    {paste the full handover-facts.mjs output here, verbatim}

    Write the report in the order below. Use the fact-sheet fragments verbatim where given; your value-add is the connective EXPLANATION and the decision insight a busy human wants — not a restatement of the numbers. Plain words, ~grade-10, concise but genuinely insightful. Say "leg" (one model call), never "turn".

    • IDENTITY — emit the IDENTITY line verbatim. Then, on the next line in *italics*: "*Snapshot is from just before this check ran — it doesn't count the check's own cost or context.*" If the STALE field is not "no", append its instruction to the identity line.
    • HEADLINE — a one-line ```diff block whose single line is the HEADLINE_DIFF value verbatim (it already starts with "+ " or "- "). Nothing else in the block; never put backticks or bold inside it.
    • **Cost** — a prose line. If COST_AGENTS_LEAD is not "(none)", OPEN the Cost section with it — spawned agents are the headline fact of this session's cost, so lead with that — then give the per-leg read; you may drop COST_DETAIL in that case (the lead already states the split). Otherwise open with COST_LEAD and COST_TOTAL, then use COST_RECENT and TRAJECTORY together as the insight slot: COST_RECENT says what the typical recent leg has cost (the median of the last few legs) beside the whole-session mean, and TRAJECTORY says the measured SHAPE of that spend (flat / climbing / climbed earlier then flat-to-down / with spikes). Explain in your own words what the two together mean for the decision. The two figures in COST_RECENT are different statistics on purpose: the recent one is the TYPICAL leg and the session one is total spend spread over every leg, which a fat leg does lift. How firm the TYPICAL figure is depends on the `N` COST_RECENT names: at `8` a fat leg can move it by the gap between two ordinary legs at most, so call it the typical leg; below `8` it is drawn from few legs and a fat one among them can drag it up a rank, and at `2` the median simply is the mean of the two legs, so a single fat leg sets it outright — so at any `N` under `8`, say the recent figure rests on only that many legs and may sit high because one of them was fat, and never call it a figure one fat leg cannot lift. Comparing the two tells you exactly one thing: whether the typical recent leg is running above or below the session's own per-leg mean. ABOVE means the typical leg has genuinely got more expensive. BELOW means expensive legs are carrying the session mean — it does **not** tell you where those legs are, and it does **not** rule out that they are the most recent ones, because a median is built to resist exactly those legs. Never read a location or a direction out of this comparison: TRAJECTORY gives the direction, and the spikes panel names each expensive leg by its leg number against the session's total. If TRAJECTORY says climbing, say climbing, whichever way the two figures sit. These are MEASUREMENTS of this session's own dollars: never compare them against what other sessions cost, and never call the spend normal or expected — the sheet has no cross-session comparison and must not imply one. If COST_RECENT is "(none)" there are fewer than two legs, so just skip the recent read. If COST_DETAIL is not "(none)" and you didn't lead with COST_AGENTS_LEAD, weave it in. If any COST_RESUME_NOTE, COST_LEGPRICE_NOTE, COST_MODELSWITCH_NOTE, COST_FAST_NOTE or COST_TIER_NOTE lines are present, END the Cost line with each caveat in plain words — for the resume caveat, say the earlier legs came from a previous run and the total covers this run only; for the leg-price caveat, say the per-leg dollars look understated because the session's rate sits far below list price, and that the total is Claude Code's own figure; for the model-switch caveat, say the model changed partway through, so per-leg dollars before and after the switch are not like-for-like; for the fast caveat, say the dollars in this report are low because fast mode's premium is not counted, and NEVER supply a multiplier or a corrected figure; for the tier caveat, say the model label on the status line names one model but every leg actually ran on the other, and that this changes no number in the report.
    • **Cold** — if COLD is "(omit)", skip this line ENTIRELY. Otherwise a prose line conveying COLD at its stated volume — do not escalate beyond what it says.
    • **Quality** — a prose line: lead with QUALITY_LEAD, add QUALITY_SECONDARY as a secondary aside, state QUALITY_HEADROOM, and fold in QUALITY_CAVEAT.
    • **Activity** — if ACTIVITY starts with "(omit", skip this line ENTIRELY. Otherwise a prose line from it.
    • **Trajectory** — a prose line from TRAJECTORY (shape + range). Do NOT guess what caused spikes — the spike panel the main session appends carries the resolved cause per leg. In particular, never attribute per-leg spikes to "sub-agent work": agents never appear in the per-leg data (their cost is aggregate-only, in the agents table), so a main-leg spike is by construction NOT an agent.
    • YOUR CALL — a one-line ```diff block starting with the YOURCALL_POLARITY sign ("+" or "-"), framing YOURCALL_BASIS as a crisp, human recommendation in your own words. The cost direction here MUST match TRAJECTORY — never call cost "climbing" if TRAJECTORY reports a flat shape (high-but-flat is not climbing). Never put backticks or bold inside the block.

    Output ONLY the blocks above — no preamble, and no trailing notes (the main session appends the charts and a follow-up line).
