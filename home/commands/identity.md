---
description: View or update this project's session identity (name/color/model/effort) in .claude/session-identity.json — the file the `cc` launcher reads to name and color each session — then echo paste-ready /rename, /color, /model, /effort lines for the live session.
argument-hint: "[show] | name <text> | color <name> | model <id> | effort <level>"
---

# /identity

Manage the **remembered** session identity for this project — the `name` / `color` / `model` /
`effort` stored in `<project>/.claude/session-identity.json`. The **`cc` launcher**
(`~/.claude/claude-launch.mjs`) reads this file at launch to title and color the terminal tab and to
apply per-project `--model` / `--effort`.

Four fields, three surfaces:

- **Remembered** = the JSON file. Persists across sessions. Only a file edit changes it — that's what
  `/identity` writes.
- **Live (paste)** = `name`, `color`, `model`, `effort` — each has a built-in slash command that
  applies to the **running** session immediately: `/rename`, `/color`, `/model <id>`, `/effort <level>`.
  These have **no programmatic API** ([anthropics/claude-code#58588]) and the model **cannot invoke
  them** — so `/identity` finishes by handing you the exact lines to paste. `model`/`effort` are *also*
  read by the `cc` launcher, which adds `--model <id>` / `--effort <level>` to `claude` at launch — so
  persisting them makes future `cc` launches start with that model/effort, while the paste-line changes
  *this* session now.

[anthropics/claude-code#58588]: https://github.com/anthropics/claude-code/issues/58588

## Arguments

`$ARGUMENTS` is free-form — parse it leniently:

- **`show`** → read-only: report all four fields and the paste-lines. Change nothing.
- **empty (no args)** → report what's set, then run **Interactive setup** (below) for each *unset*
  field. If all four are set, this collapses to `show`.
- `name ...` → set/replace `name` (everything up to a `/`, `;`, or a `color`/`model`/`effort` keyword;
  names may contain spaces).
- `color ...` → set/replace `color` (one token).
- `model ...` → set/replace `model` (one token — a Claude model id or alias passed verbatim to
  `claude --model`, e.g. `opus`, `sonnet`, `claude-opus-4-8`). Accept any non-empty token.
- `effort ...` → set/replace `effort`. **Validate** against `low | medium | high | xhigh | max`; if
  it isn't one of those, don't persist it — list the levels and ask.
- to **clear** a field: `<field> none` (or `unset`) → remove that key.
- any combination, in any order, separated by `/`, `;`, `,`, or whitespace.

If a clause is malformed or you can't tell what to change, ask one short question rather than guessing.

## Procedure

1. **Resolve the target file:** `.claude/session-identity.json` under the project root
   (`$CLAUDE_PROJECT_DIR` if set, else the current working directory) — the same file the `cc`
   launcher reads. Use your file tools (Read / Write / Edit); it's plain JSON, no shell required.
2. **Read current state.** If the file exists, parse it. If it doesn't and the request is `show`/empty,
   say so and stop.
3. **Route:**
   - `show`, or empty-with-all-set → report each field ("not set" for any missing), echo the
     paste-lines (step 6), write nothing.
   - empty-with-any-unset → report what's set, then **Interactive setup** for each unset field.
   - explicit clauses → skip the pickers; go to step 4.
4. **Merge.** Apply only the fields asked for; **preserve every other key** already in the file
   (forward-compat — the schema may grow). Validate `effort` as above; accept `model` verbatim. A
   `<field> none`/`unset`/empty clause **removes** that key.
5. **Write back** pretty-printed, 2-space indent, UTF-8 without BOM, trailing newline — matching the
   existing file's shape. Create `.claude/` if missing. Confirm in one line what each changed value is
   now (old → new).
6. **Echo the live-apply paste-lines.** For each field that is set, print the exact command
   on its own line in a fenced block:

   ```
   /rename <name>@<branch>
   /color <color>
   /model <id>
   /effort <level>
   ```

   **The `/rename` line must append the current git branch** — `<name>@<branch>` — so the pasted name
   matches what the `cc` launcher titles the session (`base@branch`). Resolve `<branch>` with
   `git branch --show-current`, falling back to the short HEAD (`git rev-parse --short HEAD`) when
   detached; if the project isn't a git repo or has no branch, emit the bare `/rename <name>`. `/color`
   takes no suffix.

   Chained slash commands don't parse past the first, so they **must be pasted separately** — say so.
   On a `show`, frame them as "to restore this session's identity, paste each."

   `model` and `effort` **DO have live paste-lines** — `/model <id>` and `/effort <level>` take effect
   on the running session immediately, like `/rename` and `/color`. Echo them for any field that is set.
   Persisting them *additionally* makes the next `cc` launch start with that model/effort. (`/effort`
   invalidates the prompt cache when it changes — a one-time token cost.) Don't claim they only apply
   next launch.

## Interactive setup (no-arg, unset fields)

Run a picker **only** for each unset field, in order **model → effort → color → name**. Don't
re-prompt for a field already set. `model` and `effort` are optional per-project overrides most
projects leave unset, so each picker for them includes a prominent **"Leave unset"** choice.

### Model (optional — usually unset)

Offer via `AskUserQuestion`: `opus`, `sonnet`, `haiku` (aliases pick the latest of each tier), the
auto-"Other" (the user can type any id/alias `claude --model` accepts), and an explicit
**"Leave unset"**. On a pick: persist `model` (steps 4–5) and echo the `/model <id>` paste-line
(step 6) — it applies to this session immediately *and* seeds future `cc` launches. On "Leave unset":
write nothing for `model`.

### Effort (optional — usually unset)

The levels are `low | medium | high | xhigh | max` (5 — over the `AskUserQuestion` 4-option cap), so
present them as a short line and ask the user to reply with one (or leave unset):

```
effort levels:  low · medium · high · xhigh · max     (or: leave unset)
```

On a reply: validate, persist `effort` (steps 4–5) and echo the `/effort <level>` paste-line (step 6) —
it applies to this session immediately *and* seeds future `cc` launches. On "leave unset": write
nothing for `effort`.

### Color (show the hues, don't just list words)

`/color` accepts 8 named colors: **red, blue, green, yellow, purple, orange, pink, cyan**. They exceed
the 4-option cap and can't show hue inside `AskUserQuestion`, so render a **swatch row** in a tool
block. The kit ships with Node, so use it (no shell-specific script needed — adapt the quoting to your
shell):

```sh
node -e "const c={red:[225,95,95],orange:[235,160,80],yellow:[225,205,95],green:[95,200,130],blue:[120,170,240],purple:[185,135,235],pink:[240,145,200],cyan:[120,205,215]},e=String.fromCharCode(27);let r='';for(const n in c){const[R,G,B]=c[n];r+=e+'[48;2;'+R+';'+G+';'+B+'m'+e+'[38;2;0;0;0m '+n+' '+e+'[0m  ';}console.log('  '+r.trimEnd());"
```

Then ask which color they want (they reply with a name). On reply: persist `color` (steps 4–5) and
echo the `/color <name>` paste-line (step 6). The RGB values approximate Claude Code's palette — close
enough to choose by.

### Name (smart defaults, easy skip)

A blank "type a name" prompt is low value. Derive **2–3 candidate names** from repo signals — the
project folder name, the project `CLAUDE.md` H1 title, the current git branch, the theme of recent
work — and offer them via `AskUserQuestion`, plus the auto-"Other" and an explicit **"Leave unset"** so
skipping is one tap. On a pick: persist `name` (steps 4–5) and echo `/rename <name>@<branch>` (step 6).
On "Leave unset": write nothing for `name`.

## Notes

- `/identity` changes the **remembered** value immediately. For `name`/`color`/`model`/`effort`, the
  **live** session only updates when you paste the matching line (`/rename`, `/color`, `/model <id>`,
  `/effort <level>`) — state that plainly; don't imply it already happened. Don't claim model/effort
  only apply next launch: they have live paste-lines *and* also seed future `cc` launches.
- `effort` must be one of `low | medium | high | xhigh | max`; `model` is passed verbatim to
  `claude --model` (validate effort, accept model leniently).
- Keep `color` to one the built-in `/color` accepts: **red, blue, green, yellow, purple, orange,
  pink, cyan**. If the user passes something off (a hex code, a sentence, an unknown name), flag it
  before writing rather than persisting a value `/color` will reject.
- This command does not commit anything. Whether `session-identity.json` is tracked or git-ignored is
  a separate, per-project decision.
