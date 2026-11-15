---
description: Dump the in-head topics of this session, triage each into a bucket (handover / memory / project-docs / do-now), act on them, and write a handover file for the next session to pick up. Leading keywords, any order — "ok" runs non-interactively with default buckets, "push" commits and pushes at the very end, "light" writes no handover file; any further text is a note to the next session ("/handover ok push resume once the env is prepared").
---

# /handover — deliberate session handover

You are about to do a clean session handover. Don't `/clear` yet; the user will do that after the handover file is written.

## Invocation — keywords, then the intent note

The arguments open with zero or more **keywords**, in any order and any case, each a whole word:

| Keyword | Effect |
|---|---|
| `ok` | Non-interactive: default buckets, no triage prompt (see below). |
| `push` | Commit and push everything this session changed, as the very last step (Step 5). |
| `light` | No handover file: Step 4 is skipped. Everything else runs — the triage and the M, D and X items. |

Keywords combine freely, and repeating one changes nothing. Keyword reading stops at the first word that is not a keyword; that word and everything after it is the **intent note**.

| Invocation | Mode | Intent note |
|---|---|---|
| `/handover ok I'll get back to this on my other computer.` | non-interactive | `I'll get back to this on my other computer.` |
| `/handover This is step two of five; the plan lives in another repo.` | interactive | the whole argument |
| `/handover ok push` | non-interactive, then commit and push | none |
| `/handover light ok push` | non-interactive, no file, then commit and push | none |
| `/handover push Back on Monday.` | interactive, then commit and push | `Back on Monday.` |
| `/handover` | interactive | none |

`okay, later…` is a note: `okay,` is not a keyword. If a note must itself start with a keyword word, the user quotes it: `/handover "push the release tomorrow"`.

### `ok` — non-interactive

With `ok`, run the flow **with the proposed default buckets and no confirmation prompt** — but NOT silently. Specifically, in this order:

1. Draft the eight coordinates (Step 1) internally. You do not need to print the long-form draft.
2. **Print the Step-2 triage summary table** — the compact `N. [bucket] item` list, defaults already filled in, in the exact format the interactive flow uses (see Step 2). Show it BEFORE acting on or writing anything. This is the recap the user reacts to: because it lands before any M/D/X action or file write, the user can scan it and hit Esc to interrupt and correct course if a bucket is wrong.
3. Do NOT pause for triage adjustments and do NOT ask for confirmation. After printing the table, continue straight on in the same turn — act on the M, D, and X items (Step 3), write the handover file (Step 4), push if asked (Step 5), and report (Step 6).

The only pauses still permitted are the Step-0 stop for open dialogues, and the deliberate-action confirmations in Step 3 for outward-facing or hard-to-reverse X items (deletes, sends, and commits or pushes other than Step 5's) — those are never auto-run off defaults. Every such question is asked **right after the table, all together, before any action** — never after the file is written or the push is done, because whatever its answer changes must land before the push.

Otherwise (no `ok`), run the full interactive flow below: present the draft, take the user's triage adjustments, then act.

### The intent note — any other text in the arguments

The intent note is the user's message to the session that picks this handover up — why they are stopping and what they plan to do next. No keyword introduces it, and quotes are optional (strip one pair of surrounding quotes if present).

With `light` there is no file to carry a note, so leftover text is not an intent note: record it nowhere, and quote it in the Step-6 report as "not recorded: `light` writes no handover file".

When an intent note is present:

- Record it **verbatim** at the top of the handover file, under `## Intent`, above Goal (Step 4). Never paraphrase, correct, or merge it into the eight coordinates — it is the user's own words and outranks the drafted sections.
- Show it at the top of the Step-2 triage, above item 1, in both modes (see Step 2).
- Lead the slug with it (Step 4).
- Echo it back in the Step-6 report so the user sees exactly what was recorded.

## Step 0 — open dialogues

Step 0 runs before Step 1, in every mode: interactive, `ok`, `light`, `push`. The `ok` keyword approves the triage buckets; it never approves anything about a dialogue.

A **dialogue** is the two-party harness of `/dialogue-convene`: two agent sessions take turns in a shared file, and each runs a background watch command that wakes it when the baton comes back. Ending this session stops its watch, and the other party then waits with no one answering. Only the Convener (the user) closes a dialogue, by the line `— CONVENER · DIALOGUE CLOSED`. Nothing in the handover ever creates a dialogue file.

`<config home>` below is `$env:CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`.

1. Run `node "<config home>/open-dialogues.mjs" --session`. It finds this session by `CLAUDE_CODE_SESSION_ID`, finds its transcript, finds every dialogue this session armed a watch for, and reads each dialogue file under a time limit. Closed dialogues are left out. Each dialogue carries:
   - `name`, `file`, `label` (this session's label) and `otherLabel` (the other party's, or `null`);
   - `state`: `open` (the file was read), `missing` (the file is no longer at this path) or `unreadable` (it could not be read in time, for example on a share that does not answer), and `lastLine` (the file's last non-empty line);
   - `lastTurn` (the heading of the last **block** in the file, whatever its form: `Turn 5 — Api-Claude`, a Convener block such as `Convener's answer (relayed by Api-Claude)`, or a party's note; `null` if there is none);

     **Which `## ` headings open a block.** A heading opens a new block when any of these holds; otherwise it is a subheading inside the block it sits in, and changes neither that block's turn number nor `lastTurn`:
     - it is a turn heading, `Turn <N> — <author>`;
     - **the Convener is its author**: its text begins with the word `Convener` or `Convener's` (any case), or one of its ` — `-separated parts is exactly `CONVENER`. This covers every real form (`Convener — <name> …`, `Convener's answer …`, `Convener — resume …`, `Closed — CONVENER`, `Turn <N> — CONVENER`). A heading that only mentions the Convener (`Joint summary for the Convener`) is not one;
     - the block before it has already ended: its last non-empty line, Markdown rules (`---`) aside, is a **signed line**, `— <label> · …`, where `<label>` is one word of letters, digits and hyphens. Every baton line and the close line are signed lines, and so is an entry signed without a baton, such as `— <party> · AFTER`. This is how a party's post-dialogue note, written after a baton, becomes its own block, and how each of several entries signed without a baton stays its own block.

     So a party that heads its joint summary `## Joint summary for the Convener` inside its ratifying turn keeps that turn whole: `ratifiedTurn`, `ratifiedText` and `lastTurn` all name the turn.
   - `ratifiedTurn` (the number of the most recent turn whose baton carries the literal words `RATIFY CONSENSUS`, or `null`), `ratifiedText` (that turn's full text, header to baton line), and `afterRatifyText` (everything in the file after that turn, verbatim);
   - `command` (the exact watch command last run, as found in the transcript; kept for diagnosis, never re-run);
   - `rejoinCommand`: the **current** protocol §6 watch for this file and label, in the shell this session used, built from the protocol deployed in the config home. It is `null` when the protocol or its watch block cannot be found.

   For a `missing` or `unreadable` file, every field read from the file is `null`; `rejoinCommand` is still built. When a file did not answer in time, the script ends itself with a non-zero exit status after printing; what it printed is still the result.

   **What it prints, and where the full report goes.** It prints a compact JSON summary, `{ "session": "<id>", "reportFile": "<path>", "dialogues": [ … ] }`, whose entries hold every field above except `ratifiedText`, `afterRatifyText`, `command` and `rejoinCommand`. The full report is the Markdown file at `reportFile`: one section per dialogue, the compact fields as a list, then `rejoinCommand`, `ratifiedText` and `afterRatifyText`, each in its own fenced block.
   - **The session judges only from this output and its report file.** Read the report file in full when any entry has a `ratifiedTurn` (rule (a) needs the texts) and when you write the handover note (Step 4 needs `rejoinCommand`). Do not open a dialogue file with your own tools during Step 0: those have no time limit on a share.
   - If it prints `"session": null`, it could not find this session or its transcript. Then use your own memory: every dialogue you remember arming a watch for is treated as listed, with state `unreadable`.
2. **No dialogue listed:** Step 0 prints nothing and the handover goes on to Step 1. Leave no trace of this step: the reply, the draft, the triage table, the handover file and the Step 6 report say nothing about dialogues, not even that there are none. This covers Step 0's result only: work this session did on dialogues is reported like any other work.
3. **For each listed dialogue, decide whether it may close itself.** It may only when both hold:
   - **(a) It has run its course.** The most recent `RATIFY CONSENSUS` turn hands the floor to the Convener; nothing follows it except Convener blocks approving it and party turns that only acknowledge; and its joint summary leaves no open question for the Convener and no step either party said it would still take in the dialogue. Read this from `ratifiedText` and `afterRatifyText`. Only the literal `RATIFY CONSENSUS` qualifies: a hand-off worded otherwise (`AGREED, AWAITING FLORIAN`, `FINAL TEXT FOR APPROVAL`) does not, however close its meaning. A `DEFER TO CONVENER` that waits for an answer never qualifies. A missing or unreadable file never qualifies. **If you are unsure whether it has run its course, it has not.**
   - **(b) The user approved the result.** The approval is visible either in this session's chat, given after the consensus reached the user and referring to it, or in the dialogue file as a Convener block after the ratifying turn. Silence is not approval. The `ok` keyword is not approval. An approval of something else is not approval. If you are unsure, it is not approval. The intent note is not approval either (step 6 below).
4. **Both hold:** close it without asking, through the script. `--close` and `--append` (step 7) are the only two ways Step 0 writes a dialogue file, and both open existing files only:

   ```
   node "<config home>/open-dialogues.mjs" --close "<file>" --record "Closed at handover by <LABEL> on <YYYY-MM-DD>: consensus ratified in Turn <N>; the Convener approved it <in <LABEL>'s chat | in Turn <M>>."
   ```

   `--close` opens the file only if it already exists, within a time limit, and appends the record and the close line `— CONVENER · DIALOGUE CLOSED` unless the file is already closed. It prints one word: `closed`, `already-closed`, `missing` (the file does not exist; nothing was created), `unreadable` (it could not be opened or read), or `unconfirmed` (the time limit passed after the open succeeded, so the lines may or may not have landed). The printed word is the result, whatever the exit status.
   - On `closed` or `already-closed`, print one line: ``Closed dialogue `<name>` at handover: the parties ratified a consensus in Turn <N>, and you approved it <where>.`` If the other party runs the current §6 watch, it exits `CLOSED` within one poll. A watch armed from the template before 2026-11-04 has no `CLOSED` branch and keeps waiting until it times out.
   - On any other result, the dialogue was not closed: it joins the stop in step 5, and "Where it stands" says what `--close` reported.
5. **Any dialogue left:** stop, print the stop message below, and wait for the user. Nothing else runs: no draft, no triage table, no M/D/X action, no file.
   - **One retry for unreadable files, before the stop message.** If any entry is `unreadable`, run `--session` once more and use the second result. A dialogue it now reads gets the replies of its new state. One still `unreadable` stays so.
6. **The intent note never decides a dialogue.** `/handover ok close the dialogue` records "close the dialogue" as the intent note, verbatim, as always. It is a message to the next session, so it is not read as `close`, `keep` or approval. When the note mentions a dialogue, the stop message quotes it on its own line above the replies (`Your note says: "<note>". Reply close <n> to act on it.`), so acting on it costs one short reply.
7. **The user's reply.**
   - `close <n>` runs `--close` with the record `Closed at handover by <LABEL> on <YYYY-MM-DD>, on the Convener's word.` (an explicit instruction from the Convener). If it reports anything but `closed` or `already-closed`, say so in one line and ask again for that dialogue, offering `keep` or `forget`.
   - `keep <n>` marks the dialogue for the handover note (Step 4, `## Open dialogues`).
   - `forget <n>` leaves the dialogue out of the note and writes nothing anywhere. It is offered for a `missing` file (there is nothing to close), an `unreadable` one, and after a failed `--close`. It is not offered for a dialogue whose file was read, because a readable open dialogue can be closed.
   - `close` is offered only for a dialogue whose file was read, on the first run or the retry. It is never offered for a `missing` or `unreadable` file.
   - With a single dialogue, a bare `close`, `keep` or `forget` is enough. Several at once are fine: `close 1, keep 2`.
   - **Other words for the same choice.** A reply that names one of the offered choices in other words is that choice: `keep both`, `close all`, `yes, close it`, `drop it`. Restate your reading in one line (`Taking that as: close 1, close 2.`) and act on it in the same turn. "All" and "both" apply each dialogue's own offered choices: `close all` closes the dialogues `close` is offered for and asks again about the rest.
   - **A bare word with several dialogues listed asks which.** `close`, `keep` or `forget` alone, or a reply that could mean more than one dialogue or more than one choice, gets one question back: `Which dialogue: 1, 2, or both?`. Nothing is written until the answer comes.
   - **A real answer to a dialogue** (a reply that decides something inside the dialogue rather than choosing `close`, `keep` or `forget`) is the Convener's word for it and is handled as the protocol says (§5.5: appended as a Convener block). Append it only for a dialogue whose state is `open`, and only through the script:

     ```
     node "<config home>/open-dialogues.mjs" --append "<file>" --text-file "<path>"
     ```

     **The block's body is the user's reply, word for word.** Between the heading and the baton line that protocol §5.5 gives the block, put the words of the reply that answer the dialogue, exactly as the user wrote them: nothing reworded, nothing added, nothing left out except the words of a choice made in the same reply (`keep 1, and …`). Any reading of it, such as the date a "Monday" stands for, goes to the user in the chat, never into the block. If a word looks misheard, ask before appending; never correct it in the block.

     **The block travels in a UTF-8 file, not on stdin.** First write the block with your own file-write tool (which writes UTF-8) to a new file in the operating system's temp folder, then pass its path as `<path>`. Start the block with a blank line, so it stands apart from the turn before it. Why a file:
     - **Stdin is not safe on Windows PowerShell 5.1.** 5.1 pipes text to a native program in `$OutputEncoding`, which defaults to ASCII there: every `—`, `·` and `→` lands as `?`, and a UTF-8 byte-order mark lands in the middle of the dialogue file. The dialogue is append-only, so the damage stays.
     - **An argument is safe for the encoding but not for the shape.** A multi-line block full of quotes, `$` and backticks needs shell escaping that differs between PowerShell and bash, and a long block meets the Windows command-line length limit.
     - **A file has none of these problems** in either shell: nothing is re-encoded and nothing is escaped.

     The script reads the text file as UTF-8, drops a leading byte-order mark if one is there, refuses an empty or missing text file (exit 2, nothing written), and never deletes it. It also refuses a text file that is not valid UTF-8 or that holds a NUL byte, which is what a file a shell wrote as UTF-16 or in the ANSI code page looks like: exit 2, one stderr line naming the file, nothing written. `--append` opens the file the way `--close` does: existing files only, the same time limit, the same line-break rules. It writes nothing if the last non-empty line contains `DIALOGUE CLOSED`. It prints one word: `appended`, `already-closed`, `missing`, `unreadable` or `unconfirmed`. For a `missing` or `unreadable` dialogue, or on any result but `appended`, say in one line that you cannot write there and ask again for that dialogue. If the script refuses the text file instead (exit 2, one stderr line naming the text file), write the block again with your own file-write tool to a new file, under a new name in the temp folder, and run the command once more with that new path; only if that run is refused too, say in one line that the text file could not be read, not that you cannot write to the dialogue, and ask again for that dialogue.
   - The handover stays stopped until every dialogue has a `close`, a `keep` or a `forget`.
8. **Resume** from Step 1 with the same keywords and the same intent note. The user does not retype the command.

**The stop message, exactly.** The first block is a one-line `diff` fence so it renders red. `<n>`, names, labels and paths are filled in; "dialogue" takes the singular for one (`- HANDOVER STOPPED: this session takes part in 1 open dialogue.`).

````
```diff
- HANDOVER STOPPED: this session takes part in <n> open dialogues.
```

Ending this session stops its watch on each dialogue below, and the other party would then wait with
no one answering. Decide each one, and the handover continues from where it stopped.

**1. `261105-pricing-review`** — this session is `Api-Claude`; the other party is `Web-Claude`.
File: `G:\Shared drives\Team\example-project\discussion\261105-pricing-review-dialogue.md`
Where it stands: the floor is with you. The two parties ratified a consensus in Turn 7, and I have not seen your okay on it.

**2. `261104-schema-migration`** — this session is `Docs-Claude`; the other party is `Cursor-Agent`.
File: `C:\projects\example-app\261104-schema-migration-dialogue.md`
Where it stands: the file is no longer at this path; it was deleted or moved. There is nothing to close.

Reply for each dialogue:
- `close 1` — I append the close line to the file. If the other party runs the current watch, it stops within a minute.
- `keep 1` — the handover note carries the dialogue, and the next session in this folder rejoins it and keeps watching.
- `forget 2` — I leave it out of the handover note and write nothing.

For example: `close 1, forget 2`.
````

**The reply lines are per dialogue.** A dialogue whose file was read gets `close` and `keep`. A `missing` one gets `keep` and `forget`, never `close`. An `unreadable` one (still unreadable after the retry in step 5, and every dialogue of the `"session": null` fallback) gets `keep` and `forget`, never `close`, because a close on a file that does not answer would only fail into the next case. One whose `--close` failed gets `keep` and `forget`. The example line uses the real numbers.

"Where it stands" is one plain sentence, chosen from the facts. The first row that matches wins. A baton line matches the baton rows by its target alone, whatever words come before `BATON` (so `CLARIFICATION · BATON → Web-Claude` is a baton to the other party).

| Last line | Sentence |
|---|---|
| baton to this session | `the baton is with you: this session owes the next turn.` |
| baton to the other party | ``the baton is with `<other>`; they owe the next turn.`` |
| `RATIFY CONSENSUS · … · BATON → CONVENER`, no okay seen | `the floor is with you. The two parties ratified a consensus in Turn <N>, and I have not seen your okay on it.` |
| ratified, okay seen, but the summary leaves something open | `the floor is with you. You approved the consensus of Turn <N>, but it leaves open: <the open item, in a few words>.` |
| `DEFER TO CONVENER · … · BATON → CONVENER` | `the floor is with you: the decision request in Turn <N> waits for your answer.` |
| any other hand-off to the Convener (`… · BATON → CONVENER` without `RATIFY CONSENSUS` or `DEFER TO CONVENER`, such as `AGREED, AWAITING FLORIAN`, `NOTE`, a plain `END OF TURN`) | ``the floor is with you: Turn <N> handed it to you (`<the baton's words>`).`` |
| no baton line, and `lastTurn` is a Convener block (the Convener is its author, as Step 0 step 1 defines it) | `the last block is the Convener's (<its heading>); no party has the baton.` |
| no baton at the end | `the last turn has no baton line; it may still be being written.` |
| file `missing` | `the file is no longer at this path; it was deleted or moved. There is nothing to close.` |
| file `unreadable` | `I could not read the file, so I cannot tell where it stands.` |
| `--close` reported `missing`, `unreadable` or `unconfirmed` | `I tried to close it, and the close did not land: <the reported word, in plain words>.` |

**Where `<N>` comes from.** In the two `RATIFY CONSENSUS` rows, `<N>` is `ratifiedTurn`. In every other row, `<N>` is the number of `lastTurn` only when `lastTurn` is a turn heading (`Turn <N> — <author>`). For any other heading, the sentence quotes the heading as it stands in place of `Turn <N>`, and never takes a number out of it: a note headed `Post-dialogue note 11 — <party> — 2026-11-06` reads ``the floor is with you: `Post-dialogue note 11 — <party> — 2026-11-06` handed it to you (`NOTE`).``, not "Turn 11". `<the baton's words>` are the words between the party label and `BATON → CONVENER`, separators dropped: `END OF TURN · AGREED, AWAITING FLORIAN`, `NOTE`, `END OF TURN`.

**With `light`.** There is no note to carry a dialogue, so the `keep` line reads instead: `` `keep 1` — `light` writes no handover note, so nothing carries the dialogue: it stays open with no one watching from this side. ``

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
**With `light`, H is not a bucket** — there is no file to carry it. An item that would default to H defaults to — instead, unless it is worth persisting as M or D. The legend omits H.

**M vs D — which target?** The split is about *audience and ownership*, not importance. Three tests, any one decides it:
- **Audience** — would a new human teammate, with no access to Claude's memory, need this to work on the project? Yes → **D**. It only helps *Claude* serve the user better → **M**.
- **Aboutness** — is the fact about the *product/codebase* (why it's built this way, what a constraint is)? → **D**. Is it about the *collaboration* (how the user likes to work, a correction, a preference)? → **M**.
- **Ownership** — does it belong in version control and survive a fresh clone? → **D**. Does it belong to the user's personal Claude env, across all projects? → **M**.

When an item is genuinely both (a decision that also revealed a working-style preference), split it: the decision → **D**, the preference → **M**. When a project has no docs home for it yet, that's a **D** item whose action is "create the doc" — don't downgrade it to **M** just because the file doesn't exist.

Default heuristics: preferences / working-style / corrections / validated patterns → **M** (Claude memory); durable decisions / constraints / architecture / conventions / roadmap → **D** (project docs); quick actionable tasks the user wants done → **X**; forward-looking state & blockers → **H**; already-persisted items → **—** unless worth restating in H.

**If the user gave an intent note, open the triage with it**, as a bold line above item 1, verbatim — `**Intent:** <note>`. It is the lens for the buckets: an item that serves the stated next step belongs in **H**, and one that doesn't may not belong at all. The intent line is not numbered and takes no bucket.

**If Step 0 found any dialogue,** add under the `**Intent:**` line (or first, when there is no intent), above item 1, one unnumbered line with no bucket: ``**Dialogues:** closed `<name>`; carried `<name>`, `<name>`; forgotten `<name>`.`` Each part only when it has a name; the line is omitted when Step 0 found none.

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

- **X items** — execute now, in a sensible order. For anything outward-facing or hard to reverse (commits, pushes, deletes, sends), confirm with the user first per the usual deliberate-action rules. Report what each did. With `push`, the session's own commit and push are Step 5, not X items.
- **M items** — persist now to Claude memory, following the memory-file conventions (frontmatter + a one-line `MEMORY.md` pointer). Show the user the memory slug.
- **D items** — write or append to the right project doc (`SPEC.md`, `docs/…`, `CLAUDE.md`, roadmap, or a new ADR); create the doc if the project has no home for it yet. Show the user each destination path.

If a D item lands in a project doc, it no longer needs to live in the handover body — a one-line pointer ("documented in `docs/X`") is enough.

## Step 4 — write the handover file (H items)

With `light`, skip this step.

Compute the timestamp as `<YYYY-MM-DDTHH-MM-SS>` (local time, hyphens not colons so it's a filesystem-safe filename on every OS — colons are invalid on Windows).

Then add a **slug** naming what the handover is *about*: 2–4 kebab-case words drawn from the semantics of the H payload — `sprint-chain-flight`, `cold-tax-recal`, `handover-file-naming` — never a generic filler like `session`, `work`, or `misc`. A handover usually has one dominant topic; when the payload genuinely splits across two or three unrelated topics, join their slugs with commas and no spaces (`sprint-chain-flight,inbox-triage`). Lowercase ASCII letters, digits, hyphens, and those separating commas only.

When the user gave an intent note, its slug comes **first**: 2–4 kebab-case words for the intent itself (`other-computer`, `after-env-prep`, `opt-step-2-of-5`), then a comma, then the payload slug — `other-computer,sync-homes`.

Write to `<cwd>/.desk/handovers/<timestamp>-<slug>.md`. Create the `.desk/handovers/` directory if it doesn't exist.

**Scaffold `.desk/.gitignore` when it is missing** — one line, `handovers/*.consumed.md`, plus a comment saying consumed notes are spent and only unconsumed ones belong in the repo. Only unconsumed handovers live in the repo; a consumed one is a note some session already loaded. The rule sits *inside* `.desk/` rather than in the repo's root `.gitignore` because `.desk/` is this env's own directory — so it needs no entry in a file the project owns, no per-machine git config, and it survives a fresh clone. Never add a `.desk` rule to the repo's root `.gitignore`.

`.desk/` is the project's own store for what this env persists — the handover notes and `session-identity.json`. It sits outside `.claude/`, which repos routinely blanket-ignore, so a handover written here is visible to git by default and can travel to another machine. Whether and when to commit it is the user's call: never offer to commit, and never nudge. The `push` keyword is that call. A repo that still has notes under the old `.claude/handovers/` is still picked up at session start; new ones go to `.desk/`.

The timestamp stays the leading component so the files still sort chronologically by name (which is how session pickup finds the most recent one); the slug is what makes a directory listing readable months later.

The file carries the **H** items as its forward-looking payload (in their eight-section structure), plus a short **Resolved before clear** section recording what was executed (X, with outcomes), persisted to memory (M), and documented in the project (D), so the next session sees the full picture.

**The kept dialogues.** Every dialogue the user answered `keep` for in Step 0 goes into an `## Open dialogues` section, placed directly after `## Intent` (or first, when there is no intent), because the next session acts on it before anything else. One sub-block per kept dialogue:

````markdown
## Open dialogues

The session that loads this note rejoins each dialogue below before its first reply. First check the
file with `node "<config home>/open-dialogues.mjs" --status "<file>"`. If it reports `missing` or
`unreadable`, do not arm the watch: say so and ask Florian whether to keep it (arm the watch anyway;
it starts working when the file is back) or forget it. If it reports `closed`, do not arm; say it
closed. If it reports `open`: read the protocol (`dialogue-protocol.md` in your config home), §3 to
§6; read the dialogue file; run the completion check on its last non-empty line and act on it as the
protocol says; then run the watch command below as a background command. Peeking at this note
rejoins nothing.

### 1. 261104-schema-migration

- **File:** `C:\projects\example-app\261104-schema-migration-dialogue.md`
- **You are:** `Docs-Claude`. **The other party:** `Cursor-Agent`.
- **At handover (2026-11-05 18:40):** last line `— Docs-Claude · END OF TURN · BATON → Cursor-Agent`. The baton is with `Cursor-Agent`.
- **Accountable for the open hand-off:** `Docs-Claude` (only when the last hand-off names one)
- **Kept because:** <the user's reason, in their words, when they gave one>
- **Watch command:**

  ```powershell
  <the report's `rejoinCommand`, verbatim and in full>
  ```
````

A kept dialogue whose file was `missing` or `unreadable` at handover is carried the same way, with its state in the "At handover" line. The next session's `--status` check (above) decides what happens: it arms the watch only when the file answers, or when the user says keep.

**The watch command is the report's `rejoinCommand`**, verbatim and in full, never shortened, taken from the report file: the **current** protocol §6 watch, filled with the dialogue's file and this session's label. "Same file, same label" means those two values, never the old command text: a watch armed from the template before 2026-11-04 has no `$n0` guard and no `CLOSED` branch, so re-running it would wake at once on every hand-off to the Convener and never hear the close. Use the code fence of the shell it is written for (`powershell`, or `bash` for a command that begins with `f="` or a `#` line). If `rejoinCommand` is `null`, the line reads `- **Watch command:** the protocol §6 watch, with $f = "<file>" and $me = "<label>"`, and the next session fills it from the protocol it reads.

File shape:

```markdown
---
created: <ISO timestamp>
project: <basename of cwd>
model: <current model display name>
---

# Handover from <timestamp>

## Intent

> <the user's intent note, verbatim — omit this section when none was given>

## Open dialogues

<...the kept dialogues, as above — omit this section when none was kept...>

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
- **Dialogues closed:** <name> (<on your word | ratified and approved>)
- **Dialogues forgotten:** <name> (<missing | close did not land>)
```

The two dialogue bullets appear only when Step 0 closed or forgot a dialogue.

Omit any section (including "Resolved before clear") that has nothing in it.

## Step 5 — commit and push (only with `push`)

This step runs last, after every step that writes a file, so nothing the handover changes lands after the push. The keyword is the user's authorization for this commit and push; ask nothing more.

1. For each git repository this session changed files in, run git from the repository root.
2. Stage by explicit path: the files this session changed and, without `light`, the new handover file. Never `git add -A` or `git add .` — other sessions may have uncommitted work in the same repository.
3. Commit with a message naming what the session did, then push.
4. If the push fails (no remote, rejected, hook refusal), stop and report the error. Never force-push and never skip hooks.

## Step 6 — report and stop

Tell the user the path you wrote to, quote the intent note if one was recorded, and remind them: "Run `/clear` when ready. Your next session in this directory will auto-load the handover and mark it consumed." With `push`, add each commit hash and push result.

With `light`, there is no path: list what was done instead (X, M, D, and the other Step-3 results), and omit the `/clear` reminder.

When Step 0 kept any dialogue, add one line: "The next session here rejoins: `<name>`, `<name>`." With `light`, the line reads instead: "Left open with no one watching from this side: `<name>`." When Step 0 found no dialogue, say nothing about dialogues, not even that there are none (Step 0 step 2).

Do not run `/clear` yourself — that's for the user.
