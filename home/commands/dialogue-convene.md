---
description: Set up a dual-session dialogue — create the dialogue file with its header and emit two paste-ready launch prompts for the two sessions. Run once, before any turns. Pairs with /dialogue-join.
---

# /dialogue-convene — set up a two-session written dialogue

Convene a **dual-session dialogue**: two Claude Code sessions discuss a topic in writing, in a shared append-only file, self-driving to consensus (or a deliberate hand-back to you) with no human relaying messages. This command does the **setup only** — it does not play. The rules the parties follow live in the protocol doc; this skill just creates the per-use dialogue file and hands you the two launch prompts.

Protocol doc (canonical rules): `~/.claude/dialogue-protocol.md` — resolve `~` via `$env:USERPROFILE` (Windows) or `$HOME`. Read it if you need the rule details; you don't need to copy it.

## Step 1 — gather the four blanks

From `$ARGUMENTS` if given, else ask the user (a single `AskUserQuestion` with free text is fine). Collect:

1. **TOPIC** — what the two sessions discuss (one or two sentences).
2. **PARTIES** — two labels, one per session. **Validate**: distinct, **non-overlapping** (neither a substring of the other), `[A-Za-z0-9-]` only. Reject `CONVENER` (reserved). If invalid, ask again. Suggest meaningful names (e.g. `PM-Claude` / `Clawnaty-Claude`) over `Session-A`/`Session-B` when the user's context implies them.
3. **GOAL / definition of done** — default **"consensus + a joint summary addressed to the Convener."** Accept an override.
4. **Dialogue file path** — where to create it. Default: `<cwd>\<topic-slug>-dialogue.md`. Confirm or take a path. Also confirm **who opens** (writes Turn 1) — default Party A.

## Step 2 — create the dialogue file

Write the file at the chosen path with this header (fill the blanks; nothing after the `---` yet):

```
# <TOPIC> — Dialogue
> Parties: <PARTY-A-LABEL> (opens, Turn 1) ↔ <PARTY-B-LABEL>. Rules: see dialogue-protocol.md.
> Goal: <GOAL>.
---
```

If the file already exists and is non-empty, **stop and warn** rather than overwriting — a dialogue may be in progress.

## Step 3 — emit the two launch prompts

Resolve the absolute protocol path (`<PROTOCOL_PATH>` = the deployed `~/.claude/dialogue-protocol.md`) and the absolute dialogue-file path (`<DIALOGUE_FILE>`). Print both prompts with every placeholder filled in:

**Prompt A (opener) — paste into the first session:**
> You are Party A in a dual-session dialogue. Run `/dialogue-join "<DIALOGUE_FILE>" <PARTY-A-LABEL>`. It will read the protocol (`<PROTOCOL_PATH>`) and the dialogue file, then have you write **Turn 1** opening the topic, end with your baton line, and arm the background watch so you self-drive. Continue until consensus or defer (`BATON → CONVENER`), then stop and give me the result. Don't prompt me between turns — the other session self-drives too.

**Prompt B (responder) — paste into the second session:**
> You are Party B in a dual-session dialogue. Run `/dialogue-join "<DIALOGUE_FILE>" <PARTY-B-LABEL>`. The baton is already yours — it will have you take your turn now, end with your baton line, and arm the background watch. Drive to consensus per §4 (or defer per §5); when you ratify, include the joint summary for me. Don't prompt me between turns.

Then copy **Prompt B** to the clipboard for convenience:
```powershell
Set-Clipboard -Value '<PROMPT-B-TEXT>'
```

## Step 4 — tell the user what to do next

Print, concisely:
1. Paste **Prompt A** into one session (it becomes `<PARTY-A-LABEL>` and writes Turn 1).
2. Open a second session and paste **Prompt B** (already on your clipboard) — it becomes `<PARTY-B-LABEL>`.
3. The two self-drive from there. They stop and surface to you on **consensus** (joint summary) or **defer** (a co-signed Decision Request). To resume after answering a defer, see §5.5 of the protocol.

The convening session itself can be one of the players — just paste Prompt A into it after this command finishes.
