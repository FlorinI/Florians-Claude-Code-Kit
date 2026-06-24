---
description: Join a dual-session dialogue as one Party — read the protocol + dialogue file, take exactly one turn, and arm a background watcher that self-re-invokes you when the baton returns. Pairs with /dialogue-convene.
---

# /dialogue-join — become a Party and drive your turns

Usage: `/dialogue-join "<DIALOGUE_FILE>" <YOUR-LABEL>` (optional third arg: an explicit protocol path).

You are one Party in a two-session written dialogue. Your whole job each time you're invoked is: **take at most one turn, then arm the watch and stop.** The watcher re-invokes you when it's your turn again, so this skill runs many times over the life of one dialogue.

Parse `$ARGUMENTS`: first token = dialogue file path, second = `<YOUR-LABEL>`. If either is missing, ask. The third token, if present, is the protocol path; otherwise use the deployed `~/.claude/dialogue-protocol.md` (resolve `~` via `$env:USERPROFILE` / `$HOME`).

## Step 0 — load the rules (first invocation only)

Read the **protocol doc** in full, then the **dialogue file**. On later (watcher-triggered) invocations the protocol is already in context — just re-read the dialogue file's tail for new turns. The protocol is authoritative; this skill is only the operational loop. Pay special attention to §3 (turn format + completion check), §4 (consensus handshake), and §5 (the defer rule + `PROPOSE DEFER` handshake).

## Step 1 — completion check (§3)

Look at the **last non-empty line** of the dialogue file:

- **`BATON → <YOUR-LABEL>`** → it's your turn. Go to Step 2.
- **`BATON → CONVENER`** → the dialogue has ended (consensus or defer). **Do not take a turn.** Surface the final turn to the Convener (the joint summary, or the Decision Request) and **stop — do not arm the watch.**
- **`BATON → <other party>`**, or **no baton line at the end** (a half-written or interrupted turn) → not yours / not ready. **Do not process.** Skip to Step 3 (arm the watch) — or, if the file ends with no baton at all, flag the interrupted write to the Convener per §7 rather than waiting blindly.

## Step 2 — take exactly one turn

Read everything since the previous baton. Then compose **one** turn per the protocol:

- Apply the **§5 defer gates** before building on any open question: resolve from reachable ground truth if you can (cite `file:line`); log local assumptions in the ledger format; and if a STOP condition fires (unreachable AND (a call OR foundational), or the ≥3-assumption trip-wire), open the **defer handshake** with `PROPOSE DEFER` rather than guessing.
- If you're answering a `PROPOSE DEFER` from the other party: first attempt Gate 1 yourself and say what you checked — **resolve/decline** if you can, else **co-sign** with your own leaning and `DEFER TO CONVENER`.
- If you think it's settled, use `PROPOSE CONSENSUS`; if you're ratifying, include the **joint summary for the Convener** and baton `→ CONVENER`.

Append the turn (never edit prior turns). End with exactly one baton line. Write **only your own turn** — never the other party's.

If your baton is `→ CONVENER` (you just ratified consensus or co-signed a defer): **stop here. Do not arm the watch.** Tell the Convener the dialogue has ended and show the final turn.

## Step 3 — arm the watcher (background, self-re-invoking)

Otherwise, arm the §6 watch as a **background** command (run_in_background), substituting the real file path and your label. When it exits, the harness re-invokes you automatically — that's the self-drive:

```powershell
$f = "<DIALOGUE_FILE>"; $me = "<YOUR-LABEL>"; $max = 600; for ($i=0; $i -lt $max; $i++) { $last = (Get-Content -LiteralPath $f | Where-Object { $_.Trim() -ne "" } | Select-Object -Last 1); if ($last -match "BATON.*CONVENER") { Write-Output "CONVENER"; Write-Output $last; exit 0 }; if ($last -match "BATON.*$me") { Write-Output "YOUR_TURN"; Write-Output $last; exit 0 }; Start-Sleep -Seconds 10 }; Write-Output "TIMEOUT"; Write-Output $last
```

Then **stop** and report one line to the Convener (e.g. "Turn N written; watching for the baton"). Do not keep talking — the next thing that happens is the watcher waking you.

## On wake (the watcher exited)

Read its output:
- **`YOUR_TURN`** → go back to **Step 1** (the baton is yours; take your next turn, then re-arm).
- **`CONVENER`** → the dialogue ended. **Do not re-arm.** Read the final turn from the file and surface it to the Convener (joint summary or Decision Request), then end.
- **`TIMEOUT`** → ~100 min with no baton. Report the stall to the Convener; offer to re-arm rather than guessing.

## Guardrails

- **One turn per invocation.** Never write the other party's turn or continue past your own baton.
- **Append-only.** Never edit or delete existing turns, including your own.
- Never act on a half-written turn (no trailing baton) — wait or flag it.
- Default to resolve-and-proceed; defer only when a §5 STOP condition fires, and always via the `PROPOSE DEFER` handshake so it's co-signed.
