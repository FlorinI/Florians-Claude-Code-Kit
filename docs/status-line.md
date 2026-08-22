# The status line

`statusline.mjs` reads the Claude Code status-line stdin payload and renders a single dense line.
It is the same engine that runs as the author's daily driver; this kit ships it verbatim.

## Clusters

The line is grouped into clusters, each surfacing one question at a glance:

- **Cost** — last-leg cost, a composition-weighted forecast for the next leg, and a recent-leg median
  chip showing what a typical recent leg cost, so the forecast reads against the real recent rate.
- **Sparkline** — a per-leg cost history so spikes are visible at a glance.
- **Context** — dual-axis usage (tokens in context vs the model window) and headroom to the next
  auto-compact.
- **Cold-cache tax** — when a leg re-creates the prompt cache after it expired, the avoidable premium
  is tallied so you can see what cold starts cost you.
- **Quota** — 5-hour and 7-day rate-limit chips, shown only when they're worth a glance (e.g. past
  half-full), not as an always-on gauge.

## Determinism & testing

The renderer writes a small per-project sidecar (`statusline-last.json`) and per-session stats under
`~/.claude`. The parity goldens (`tools/parity/`) feed frozen stdin + a frozen clock into the engine
in a throwaway HOME and assert the rendered bytes and the sidecar match committed references — so any
change to the output is a deliberate, reviewed re-bless. Bless with the two explicit commands:

    node tools/parity/run-parity.mjs --bless
    node tools/parity/run-trio-parity.mjs --bless

Do NOT use `npm run parity -- --bless`: `parity` is an `&&` chain, so npm appends the flag to the
LAST command only — the trio goldens get blessed and `golden.txt` / `golden-sidecar.json` stay stale
while the suite reports success.
