# Handover

A session accumulates context that the next session can't see. The handover ritual writes that state
to a file the next session automatically picks up.

## /handover

Run `/handover` to dump the in-flight topics of the current session, triage each, and write a
handover file to `<cwd>/.desk/handovers/`, named `<timestamp>-<slug>.md` — the timestamp keeps
the directory sorted chronologically, the slug says what that handover is about.

## Auto-pickup

The installer adds a small block to your `~/.claude/CLAUDE.md` instructing Claude, at the start of
every session, to:

1. Look in `<cwd>/.desk/handovers/` for `*.md` files that are **not** `*.consumed.md`, newest first.
2. Let your first message choose: `take` (the newest), `take 2`, `take 1 3`, `take all`, `peek` / `peek 2` (read
   without consuming) or `skip` (none). Any other first message loads the note when there is one, and
   none when there are several.
3. Rename each note it loads to insert `.consumed` before `.md` (the consumed marker) **before** reading it.
4. Read it and use it as orientation for the session, then defer to the project's own conventions.

A matching `SessionStart` hook (`session-start-handover.mjs`) surfaces pending handovers at launch: one by
name, several as a numbered list with the keywords.

A launcher that starts a session not meant to continue the work (a search, an always-on helper) sets
`CC_SKIP_HANDOVER_PICKUP=1` in that session's environment: the hook then reports no pending note to
the pickup check, and its start-up line says pickup is off, so the note stays pending for its own session.

## /handover-check

`/handover-check` reads the current status-line snapshot and gives a plain-language verdict on
whether it's time to hand over — weighing cost-per-leg, context fill and quality signals, and the
distance to the auto-compact wall.
