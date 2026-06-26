# Florian's Claude Code Kit

[![CI](https://github.com/FlorinI/Florians-Claude-Code-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/FlorinI/Florians-Claude-Code-Kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)

A few **guardrails for [Claude Code](https://claude.com/claude-code)** — a handful of workflow slash
commands and a status line that catch the failures agentic coding hits most: building the wrong thing,
losing the thread between sessions, overspending, fixing the wrong bug. Installed into your
`~/.claude` with a conflict-safe, *mergeful* installer that never clobbers what you already have.

Pure Node, zero dependencies, no PowerShell. Works on macOS, Linux, and Windows. It's not a complete
safety net — just a few well-placed guards for the mistakes that cost the most.

## What you get

Each piece guards against a specific way agentic coding goes wrong:

- **`/grill-me`** — *guards alignment.* Before any plan, Claude interviews you one question at a time
  (each with a recommended answer and the trade-off) and writes nothing until you say "alignment
  complete" — so building the wrong thing gets caught before a line of code exists.
- **`/handover`** — *guards continuity.* Dumps a session's in-flight state to a handover file the next
  session auto-picks up, so you stop losing the thread between sessions.
- **A dense, drillable status line** (`statusline.mjs`) — *guards cost & context.* Per-leg cost with a
  composition-weighted forecast, a baseline-ratio chip, a per-leg sparkline, dual-axis context usage,
  to-compact headroom, cold-cache tax tracking, and 5h/7d quota chips that surface only when they matter.
- **The `rca` skill** — *guards debugging.* Forces a falsifiable hypothesis and a disconfirming check
  before any fix, and right-sizes itself: a quick inline diagnosis for a cheap bug, a full documented
  analysis when the fix gates something expensive or irreversible.
- **`/dialogue-convene`** — a two-party dialogue harness (the other party can be any agent, not just
  Claude Code); composes with `/grill-me` as an alignment gate.
- **`/handover-check`** — a plain-language "is it time to hand over?" read of the current status line.
- **`/identity` + the `cc` launcher** — *guard your attention across parallel sessions.* Name and
  color each session's terminal tab from a per-project identity file (`/identity` shows a color swatch
  and suggests names — no JSON by hand), so many open sessions stay legible at a glance
  ([see below](#the-cc-launcher--per-project-identity--colored-tabs)).

## Install

```sh
git clone https://github.com/FlorinI/Florians-Claude-Code-Kit.git
cd Florians-Claude-Code-Kit
node install.mjs
```

The installer:

- **Deploys** the files above into `~/.claude`.
- **Merges** (never overwrites) your `settings.json`: it sets `statusLine` and adds a `SessionStart`
  handover hook, leaving every other key — and your existing hooks — untouched.
- **Merges** a small handover-pickup block into your `~/.claude/CLAUDE.md` between
  `<!-- FCCK:BEGIN -->` / `<!-- FCCK:END -->` markers; your own content above and below is preserved.
- **Aborts before writing anything** if a file would collide with one you already have, or if you
  already have a `statusLine` it doesn't manage. Pass `--force` to override.
- **Records what it installed** in `~/.claude/.fcck-install.json` so re-runs are clean and uninstall
  removes exactly what it added.

```sh
node install.mjs --dry-run     # preview; write nothing
node install.mjs --force       # overwrite conflicting files / statusLine
node install.mjs uninstall     # remove everything the kit installed
```

Restart Claude Code after installing for the `settings.json` changes to take effect.

## How it works

The installer is **manifest-driven**: `manifest.public.json` lists the files to deploy and the
settings keys to merge. `install.mjs` is a generic deployer — usable as a CLI or imported as a module
(`runInstall` / `runUninstall` / `planInstall`).

`statusLine` is wired with forward-slash paths so a single `~/.claude/statusline.mjs` works
identically on every platform.

See [docs/status-line.md](docs/status-line.md) and [docs/handover.md](docs/handover.md).

## The `cc` launcher — per-project identity & colored tabs

The installer also adds a tiny **`cc`** shell function (to your PowerShell `$PROFILE` on Windows, or
`~/.zshrc` / `~/.bashrc` on macOS/Linux). Run `cc` instead of `claude` and it reads a per-project
`<cwd>/.claude/session-identity.json` to title and color the session before launching:

```json
{ "name": "my-project", "color": "blue", "model": "", "effort": "" }
```

Set it up with the **`/identity`** command — it shows a color swatch, suggests names from the repo,
and writes the file for you — or edit the JSON directly. The launcher then:

- **Names the tab** `name@branch` — falling back to the repo name, then the folder leaf, when `name`
  is unset — so your terminal title bar and Claude's `/resume` picker tell sessions apart.
- **Colors the session.** This is the part that pays off when you keep several sessions open at once.
  It works in two layers:

  | Layer | Terminals | What you get |
  |---|---|---|
  | Terminal **tab background** | Windows Terminal, macOS iTerm2 | the tab itself is tinted — visible in the tab strip and alt-tab **even when Claude isn't focused** |
  | Claude Code's **own UI** | every platform / terminal | the `/color` is applied inside the session |

  So Windows Terminal and iTerm2 users get a colored tab in the OS chrome; on any other terminal
  (Terminal.app, gnome-terminal, …) you still get the in-session color.
- **Applies `--model` / `--effort`** per project when those fields are set.

Colors accept any name from Claude Code's `/color` palette: `red`, `orange`, `yellow`, `green`,
`blue`, `purple`, `pink`, `cyan`. Any arguments you pass to `cc` are forwarded straight through to
`claude`.

## Development

```sh
npm test          # unit + install smoke tests
npm run parity    # status-line + handover rendering golden tests
```

CI runs both on a Linux / macOS / Windows matrix (see `.github/workflows/ci.yml`).

## Support & contributing

This is a personal tool I share best-effort. Issues and pull requests are welcome, but there is
**no guaranteed response time** — I maintain it in spare time. Bug reports (especially cross-platform
ones) and small, focused PRs are the most likely to land. Nobody pushes to `main` directly; changes
come in as reviewed pull requests.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, [SECURITY.md](SECURITY.md) for reporting
anything sensitive, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the (short) ground rules.

## License

MIT © Florian Ilia
