# Rendering golden test — fixtures & capture

`run-parity.mjs` feeds each fixture's stdin to the Node renderer (`home/statusline.mjs`) and compares
the result against committed goldens:

- **stdout** (`golden.txt`) — must be **byte-identical** (this is what the user sees).
- **sidecar JSON** (`golden-sidecar.json`, vs `<cwd>/.claude/statusline-last.json`) — **structurally
  equal** with float tolerance (`1e-9`), so a harmless float-formatting difference never fails a run.

Run all fixtures: `npm run parity`  ·  one fixture: `node tools/parity/run-parity.mjs <name>`.
Exit code is non-zero on any diff. Unit tests for the rendering primitives: `npm test`.

When you intentionally change the rendered output, re-bless the goldens and commit them alongside the
code change: `node tools/parity/run-parity.mjs --bless` (or `--bless <name>` for one). Review the
golden diff before committing — it is the human-readable record of what the change did to the output.

## How determinism is achieved

- **Frozen clock.** Each fixture's `meta.json` sets `nowEpoch`; the harness exports it as
  `CLAUDE_SL_NOW_EPOCH`, honoured by `nowEpoch()` in `_sl-compat.mjs` (unset in production → the real
  clock). `TZ=UTC` pins date formatting.
- **Isolated writes.** The engine runs in its own temp `HOME` + temp project dir, so the dual
  sidecar, per-session stats, agent rollups and daily counter land in throwaway dirs and never touch
  the real machine.
- **Stable transcript.** The engine reads the fixture's read-only `transcript.jsonl`, so file
  mtime/ctime (which drive `aliveSec` and turn-TPS) are stable across runs.

### Every timestamp in a fixture is relative to its own `nowEpoch`

**A quota window's `resets_at` must be written as an offset from the fixture's `meta.json`
`nowEpoch`, never as the absolute time it was captured at.** The engine derives elapsed time through
the window as `elapsed% = (window − (resets_at − now)) / window`, with `now` being the frozen
`nowEpoch` — so pairing a real capture's `resets_at` with a frozen clock produces an arbitrary
elapsed fraction, and elapsed% is what selects which of the three quota regimes renders (verdict
machinery at/above `QUOTA_VERDICT_MIN_PCT` consumed; the ratio projection only at/above
`QUOTA_PROJECTION_MIN_ELAPSED_PCT` elapsed; `resets` alone below it).

**This trap is silent.** A fixture that lands in the wrong regime still renders, still blesses, and
still passes forever after — it simply asserts against a regime nobody intended, so the edge the
fixture was written to pin goes unguarded while the row reports green. Compute the value: for a
window of `W` seconds meant to sit `E` fraction elapsed, `resets_at = nowEpoch + W × (1 − E)`. The
same rule governs every other absolute time a fixture carries — leg timestamps (which drive the cold
clock and its TTL window) and seed-file times included.

## Fixture layout

```
fixtures/<name>/
  stdin.json          # the CC stdin payload; transcript_path + workspace.current_dir are rewritten
  meta.json           # { "note": "<what this fixture captures>", "nowEpoch": <epoch seconds> }
                      #   (optionally { "env": {...} }). The harness reads nowEpoch and env only;
                      #   `note` is for the reader. Name the SHAPE — opener behaviour, tier
                      #   composition, placeholder legs, leg count — never a statistic that can move.
  transcript.jsonl    # (optional) the session transcript — the engine reads this exact file
  seed/               # (optional) copied into <tempCwd>/.claude/ before the run (e.g.
                      #            statusline-stats/<sessionId>.json — exercises the incremental path)
  home-seed/          # (optional) copied into <tempHome>/.claude/ (e.g. stats-cache.json daily counter)
  golden.txt          # committed reference stdout bytes (written by --bless)
  golden-sidecar.json # committed reference sidecar JSON (written by --bless)
```

For a sub-agent fixture, put the agent transcripts under
`fixtures/<name>/transcript/subagents/agent-*.jsonl` (the status line derives the subagents dir from
the main transcript path: `<transcript-minus-.jsonl>/subagents`).

## A sample of the spread

The suite carries far more fixtures than this table lists; these are the ones worth reading first to
see what a fixture is for. `ls fixtures/` is the authority on what exists.

| fixture        | exercises |
|----------------|-----------|
| `small-young`  | 2 legs, low cost, a calm sub-50% quota window (rows render, β machinery suppressed), no flags, `trend` ≤8 legs |
| `mixed`        | dual quota (pace gauges), cold tax + cooling stake, big-leg spotlight, `trend` ≤8 legs |
| `bucketed`     | 20 legs → the `trend` strip buckets into its 8 right-anchored chips, yellow absolute-rot band |
| `capped`       | quota at/over a band edge → cap-reached / cap-band rendering |
| `overcap`      | 5h >100% ("over cap"/on credits), 7d =100% ("cap reached" hedge) |
| `expired-cold` | last leg >TTL ago → `cold? >1h` expired branch |
| `no-transcript`| missing transcript file → rollup null, null-safety, quota only |
| `agents`       | sub-agent fleet → agents line + base de-inflation over the combined unit pool |
| `incremental`  | pre-seeded stats (`seed/`) → `hadPrior` + last-leg-cost delta |
| `legs-tier-mix` | Sonnet opening leg on a Fable main → per-leg tier weight (leg 1 $0.28, not the blend's $0.83) |
| `resumed-run`  | 12 legs banked in `seed/` at $6, stdin cost $0.50 → detected resume (`runStartLeg 12`, `COST_RESUME_NOTE`) |
| `resumed-nohistory` | same 13-leg transcript, no seed → `legPricingSuspect` tripwire (chip + facts note) |
| `agents-progressive` | one agent message id on 3 lines, `output_tokens` 5/5/5000 → max-wins banking (agents $0.25) |

## Capturing a real fixture

The live status line dumps its stdin when `CLAUDE_STATUSLINE_DEBUG=1` is set
(`~/.claude/.claude/statusline-input-sample.json` — i.e. `$ClaudeHome/.claude/...`). To turn a real
session into a fixture:

1. Render once with the env var set; copy the dumped JSON to `fixtures/<name>/stdin.json`.
2. Copy the file at its `transcript_path` to `fixtures/<name>/transcript.jsonl`.
3. Add `meta.json` with a `nowEpoch` near the capture time (so cold/quota states are realistic) and a
   one-line `note` saying what the fixture captures.
4. Rewrite every absolute timestamp in the copied `stdin.json` as an offset from that `nowEpoch` —
   each window's `resets_at` above all (see **Every timestamp in a fixture is relative to its own
   `nowEpoch`**). A real capture's reset times mean nothing against a frozen clock.
5. `node tools/parity/run-parity.mjs --bless <name>` to write the golden, then eyeball `golden.txt`
   to confirm the rendered line looks right before committing.

Note: the harness rewrites `transcript_path` and `workspace.current_dir` in the copied stdin, so leave
the originals as-is — they're overwritten per run.
