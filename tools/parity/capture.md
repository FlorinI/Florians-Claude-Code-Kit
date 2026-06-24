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

## Fixture layout

```
fixtures/<name>/
  stdin.json          # the CC stdin payload; transcript_path + workspace.current_dir are rewritten
  meta.json           # { "nowEpoch": <epoch seconds> }   (optionally { "env": {...} })
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

## Current fixtures (the spread)

| fixture        | exercises |
|----------------|-----------|
| `small-young`  | 2 legs, low cost, sub-50% quota (suppressed), no flags, sparkline ≤8 |
| `mixed`        | dual quota (pace gauges), cold tax + cooling stake, big-leg spotlight, sparkline ≤8 |
| `bucketed`     | 20 legs → >8 sparkline bucketing (`$/leg avg`), yellow abs+fill bands, advert flag |
| `capped`       | quota at/over a band edge → cap-reached / cap-band rendering |
| `overcap`      | 5h >100% ("over cap"/on credits), 7d =100% ("cap reached" hedge) |
| `expired-cold` | last leg >TTL ago → `cold? >1h` expired branch |
| `no-transcript`| missing transcript file → rollup null, null-safety, quota only |
| `agents`       | sub-agent fleet → agents line + base de-inflation over the combined unit pool |
| `incremental`  | pre-seeded stats (`seed/`) → `hadPrior` + last-leg-cost delta + costBaseline |

## Capturing a real fixture

The live status line dumps its stdin when `CLAUDE_STATUSLINE_DEBUG=1` is set
(`~/.claude/.claude/statusline-input-sample.json` — i.e. `$ClaudeHome/.claude/...`). To turn a real
session into a fixture:

1. Render once with the env var set; copy the dumped JSON to `fixtures/<name>/stdin.json`.
2. Copy the file at its `transcript_path` to `fixtures/<name>/transcript.jsonl`.
3. Add `meta.json` with a `nowEpoch` near the capture time (so cold/quota states are realistic).
4. `node tools/parity/run-parity.mjs --bless <name>` to write the golden, then eyeball `golden.txt`
   to confirm the rendered line looks right before committing.

Note: the harness rewrites `transcript_path` and `workspace.current_dir` in the copied stdin, so leave
the originals as-is — they're overwritten per run.
