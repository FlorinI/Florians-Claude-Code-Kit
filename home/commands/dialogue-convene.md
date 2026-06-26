---
description: Set up a dialogue between this session and any other agent — create the dialogue file, emit one assume-nothing launch prompt for the other party, then play Party A yourself (write Turn 1 + self-drive). Run once, to start.
---

# /dialogue-convene — start a two-party written dialogue

Convene a **two-party dialogue**: this session and one other agent discuss a topic in writing, in a shared append-only file, self-driving to consensus (or a deliberate hand-back to you) with no human relaying messages. The other party can be **another Claude Code session or any other agentic tool** (Cursor, etc.) — the launch prompt you emit assumes it has *none* of Claude Code's skills, memory, or conventions and spells out everything it needs.

The rules both parties follow live in the protocol doc; this skill creates the per-use dialogue file, emits the other party's launch prompt, and then plays **Party A** in this very session.

Protocol doc (canonical rules): `~/.claude/dialogue-protocol.md` — resolve `~` via `$env:USERPROFILE` (Windows) or `$HOME`. Read it before Step 4; you don't need to copy it.

## Step 1 — gather the blanks

From `$ARGUMENTS` if given, else ask the user (a single `AskUserQuestion` with free text is fine). Collect:

1. **TOPIC** — what the two parties discuss (one or two sentences).
2. **PARTIES** — two labels. **This session is Party A** (it opens, Turn 1); the other agent is Party B. **Validate**: distinct, **non-overlapping** (neither a substring of the other), `[A-Za-z0-9-]` only. Reject `CONVENER` (reserved). If invalid, ask again. Suggest meaningful names (e.g. `PM-Claude` / `Cursor-Web`) over `Session-A`/`Session-B` when the user's context implies them.
3. **GOAL / definition of done** — default **"consensus + a joint summary addressed to the Convener."** Accept an override.
4. **Dialogue file path** — where to create it. Default: `<cwd>\<topic-slug>-dialogue.md`. Confirm or take a path.

## Step 2 — create the dialogue file

Write the file at the chosen path with this header (fill the blanks; nothing after the `---` yet):

```
# <TOPIC> — Dialogue
> Parties: <PARTY-A-LABEL> (opens, Turn 1) ↔ <PARTY-B-LABEL>. Rules: see dialogue-protocol.md.
> Goal: <GOAL>.
---
```

If the file already exists and is non-empty, **stop and warn** rather than overwriting — a dialogue may be in progress.

## Step 3 — emit ONE launch prompt for the other party

Resolve the absolute protocol path (`<PROTOCOL_PATH>` = the deployed `~/.claude/dialogue-protocol.md`) and the absolute dialogue-file path (`<DIALOGUE_FILE>`). Build the **universal, assume-nothing launch prompt** for Party B by filling §8 of the protocol — the canonical template — with these values. It must be self-contained: an agent with no Claude Code skills, memory, or conventions can act on it using only the prompt plus the two files it names. Print it in a copy-paste block, then copy it to the clipboard:

```powershell
Set-Clipboard -Value '<PARTY-B-LAUNCH-PROMPT>'
```

The prompt's load-bearing parts (all spelled out, nothing assumed):
- **Framing line first:** "You have none of this project's skills, memories, or conventions — everything you need is below and in two files."
- **What to read:** the protocol (`<PROTOCOL_PATH>`) in full, then the dialogue file (`<DIALOGUE_FILE>`). Call out §3 (turn format + completion check), §4 (consensus), §5 (defer).
- **Identity:** "You are `<PARTY-B-LABEL>`; the other party is `<PARTY-A-LABEL>`. The baton is already yours — `<PARTY-A-LABEL>` opens with Turn 1."
- **Turn + baton grammar** (the exact turn shape and the baton line), and the **completion check** (act only when the last non-empty line batons to you; `BATON → CONVENER` = ended).
- **The three self-drive tiers** (§6) with `<DIALOGUE_FILE>` and `<PARTY-B-LABEL>` substituted into the watcher. Tiers are by **capability**, not by product: Tier 1 = host re-invokes on background-exit (confirmed for both Claude Code and Cursor); Tier 2 = ~15s self-poll in its own terminal; Tier 3 = human nudge. Fill the Tier-1 `<WATCH_COMMAND>` with the §6 watcher for the other party's **OS** — PowerShell by default (the common on-Windows case — turnkey), the bash variant for a macOS/Linux party. (OS picks the shell; capability picks the tier — they're independent.)
- **Stop condition:** on `BATON → CONVENER` (consensus joint summary, or defer Decision Request), surface the result to the human and stop.

## Step 4 — play Party A yourself (don't paste anything to this session)

You convened here, so **this session is Party A** — do not ask the user to paste a prompt into it. Read the protocol now, then follow **§6 as Party A**: write **Turn 1** opening the topic, end with your baton line (`BATON → <PARTY-B-LABEL>`), and arm the §6 background watch (PowerShell variant — this is a Claude Code session) so you self-drive. Then stop and report one line (e.g. "Turn 1 written; watching for the baton"). From here you take exactly one turn each time the watcher wakes you, until consensus or defer — then surface the result and stop.

## Step 5 — tell the user what to do next

Print, concisely:
1. **Party B prompt is on your clipboard** — paste it into the other agent (another Claude Code session, Cursor, etc.). It becomes `<PARTY-B-LABEL>` and replies to Turn 1.
2. **This session is now Party A** and has written Turn 1; it self-drives from here. The two ping-pong unattended and stop, surfacing to you, on **consensus** (joint summary) or **defer** (a co-signed Decision Request). To resume after answering a defer, see §5.5 of the protocol.
3. **Recovery:** if a party's watcher dies or its session is lost, re-paste that party's universal prompt (same template, that party's label) — its completion check resumes wherever the baton sits.
