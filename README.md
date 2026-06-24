# Florian's Claude Code Kit

[![CI](https://github.com/FlorinI/Florians-Claude-Code-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/FlorinI/Florians-Claude-Code-Kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)

A cross-platform **status line for [Claude Code](https://claude.com/claude-code)** plus a handful of
workflow slash commands — installed into your `~/.claude` with a conflict-safe, *mergeful* installer
that never clobbers what you already have.

Pure Node, zero dependencies, no PowerShell. Works on macOS, Linux, and Windows.

## What you get

- **A dense, drillable status line** (`statusline.mjs`): per-leg cost with a composition-weighted
  forecast, a baseline-ratio chip, a per-leg sparkline, dual-axis context usage, to-compact headroom,
  cold-cache tax tracking, and 5h/7d quota chips that surface only when they matter.
- **`/handover`** — dump a session's in-flight state to a handover file the next session auto-picks up.
- **`/handover-check`** — a plain-language "is it time to hand over?" read of the current status line.
- **`/dialogue-convene` + `/dialogue-join`** — a two-session dialogue harness.
- **`/grill-me`** — an interview-first alignment ritual before you write a plan.
- **The `rca` skill** — disciplined root-cause analysis.

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
