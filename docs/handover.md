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

1. Look in `<cwd>/.desk/handovers/` for a `*.md` file that is **not** `*.consumed.md`.
2. Pick the most recent (ISO timestamps sort lexicographically).
3. Rename it to insert `.consumed` before `.md` (the consumed marker) **before** reading it.
4. Read it and use it as orientation for the session, then defer to the project's own conventions.

A matching `SessionStart` hook (`session-start-handover.mjs`) surfaces a pending handover at launch.

## /handover-check

`/handover-check` reads the current status-line snapshot and gives a plain-language verdict on
whether it's time to hand over — weighing cost-per-leg against context fill and quality signals.
