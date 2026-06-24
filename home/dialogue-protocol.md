# Dual-Session Dialogue — PROTOCOL (reusable, topic-agnostic)

> A reusable harness for making **two Claude Code sessions discuss a topic, in writing, to a defined end-state** (consensus — or a deliberate hand-back to the human) — with no human relaying messages between them. This file is the **generic rules**; it does **not** change between topics. The per-use specifics (the topic, which session is which, the goal) live in the **dialogue file's header**, created fresh for each conversation by `/dialogue-convene`.
>
> Roles in this document: the **Convener** is the human who starts the dialogue and receives the result; **Party A** and **Party B** are the two sessions. Everything below is written so any two sessions, on any topic, can run it. The companion skills are `/dialogue-convene` (set up + emit the launch prompts) and `/dialogue-join` (become a Party and drive turns).

---

## 1. Per-use setup (the Convener does this once)

Normally `/dialogue-convene` does this for you. It fills in the three variables this protocol leaves open and writes a fresh **dialogue file**:

- **TOPIC** — what the two sessions are discussing.
- **PARTIES** — a label for each session (e.g. `Session-A` / `Session-B`, or meaningful names like `PM-Claude` / `Clawnaty-Claude`). Labels must be **distinct and non-overlapping** (one must not be a substring of the other) and contain only letters, digits, and hyphens (they're used in a regex match — see §6).
- **GOAL / definition of done** — what ends the dialogue. Default: **consensus + a joint summary addressed to the Convener.**

It also records which session opens (**Party A** writes Turn 1), then prints two paste-ready launch prompts (§8). From then on the Convener doesn't carry messages — the sessions self-drive via the waiting mechanic in §6.

A minimal dialogue-file header looks like:
```
# <TOPIC> — Dialogue
> Parties: <PARTY-A-LABEL> (opens, Turn 1) ↔ <PARTY-B-LABEL>. Rules: see dialogue-protocol.md.
> Goal: <what "done" means>.
---
```

## 2. The goal (definition of done)

Reach the **GOAL stated in the dialogue header.** Unless the header says otherwise, that means a **consensus** both parties explicitly ratify, captured as a **joint summary addressed to the Convener**. The aim is the best joint result, not winning — concede when the other party is right; surface the constraints only your side knows. There is a second, legitimate ending: a **deliberate hand-back to the Convener** when a decision genuinely isn't yours to make (§5).

## 3. Turn-taking rules

1. **Append-only.** Never edit, reword, or delete the other party's turns — or your own past turns. Add each new turn at the **end** of the dialogue file.

2. **Turn format** — every turn is exactly:
   ```
   ## Turn N — <YOUR-LABEL>
   <your content>

   — <YOUR-LABEL> · END OF TURN · BATON → <OTHER-PARTY-LABEL>
   ```
   The last line is the **baton line** — the only legitimate way to end a turn. It always names who moves next.

3. **Completion check (this is the "don't start before I'm finished" guard).** Before reading deeply or composing anything, look at the **last non-empty line** of the dialogue file:
   - If it is a baton line naming **you** (`BATON → <YOUR-LABEL>`): the previous turn is **complete** — read everything since the prior baton, then write your turn.
   - If it names the **other** party or `CONVENER`, or there is **no baton line at the very end**: a turn is unwritten or still being written — **do NOT process or reply. Wait** (see §6). Never act on a half-written turn.

4. **One turn per invocation.** Write exactly one turn, end with your baton line, then **STOP.** Do not write the other party's turn. Do not continue past your own baton.

5. **Turn numbers** are mandatory and strictly increasing (Turn 1, 2, 3, …). Timestamps optional.

## 4. Reaching consensus (the consensus handshake)

1. When you believe the result is settled, end your turn with a clearly-marked **proposal** and a baton of the form:
   `— <YOUR-LABEL> · END OF TURN · PROPOSE CONSENSUS · BATON → <OTHER-PARTY-LABEL>`
2. The other party then either:
   - **Ratifies** — appends a turn with any final amendments, the **joint summary for the Convener**, and a baton: `— <YOUR-LABEL> · END OF TURN · RATIFY CONSENSUS · BATON → CONVENER`; **or**
   - **Continues** — a normal turn, if not yet satisfied.
3. **Done** when one party has signed `PROPOSE CONSENSUS` and the other, in the next turn, signs `RATIFY CONSENSUS` (amendments folded in are fine; genuinely new objections mean it's *not* done — keep going). The ratifying turn **must** contain the joint summary for the Convener: the agreed result, the key decisions, and any open questions. After that, **both parties stop and await the Convener.**

> The literal token `CONVENER` in a final baton signals "discussion over, human's turn." Keep using that exact word (not the human's name) so the waiting mechanic in §6 detects the end generically. It is reserved for the two endings — consensus (§4) and defer (§5).

## 5. When to defer to the Convener (the defer rule + handshake)

Some decisions aren't the sessions' to make. The danger is two-sided: **deferring on trivia** you could resolve yourselves wastes the Convener's time and defeats the point; **building an empire of assumptions** wastes tokens and is costly to unwind. This section makes "should we stop and ask?" a procedure, not a feeling. **Default is resolve-and-proceed.** You defer only when a STOP condition fires.

### 5.1 The three gates

Before building on any open question, run these in order:

1. **Resolvability.** Can it be settled from ground truth *either party can actually reach* — code, files, repo history, the tools you have, the dialogue so far?
   - **Yes → resolve it now** (read the source, cite `file:line`). This is a *research* question, not a human question. Never defer it.
   - No → Gate 2.
2. **Fact vs. call.** Is the open question a *fact* you simply can't reach, or a *call* — a preference, priority, scope boundary, budget, risk appetite, or anything with external/irreversible consequences or business intent?
   - **It's a call → DEFER** (via the handshake, §5.3), regardless of how small or how confident you feel. The sessions have no legitimate basis to decide it.
   - It's an unreachable fact → Gate 3.
3. **Blast radius.** If you assume and you're wrong, what unwinds?
   - **Local / cheap** — affects only this sub-point, revisable next turn via an append-only correction → **proceed with a *logged* assumption** (§5.2). Don't defer.
   - **Foundational** — later turns will build on it; being wrong means redoing prior turns or changing the dialogue's conclusion → **DEFER before building on it.**

You defer only when the conjunction holds: **unreachable AND (it's a call OR it's foundational).** That conjunction is what keeps deferral off trivia.

### 5.2 The assumption ledger (anti-"empire" trip-wire)

Every "proceed with assumption" (Gate 3-local) must be logged inline in the turn:
```
ASSUMPTION: <X> — basis: <why>, blast: local, revisit-if: <signal>
```
Two **countable** triggers turn a pile of small assumptions into a defer:
1. A single decision-chain accumulates **≥3 stacked, unresolved, load-bearing assumptions** → the empire is forming → DEFER with the ledger attached, even though each step looked local.
2. A later turn would rest on an assumption the **other party explicitly flagged as uncertain** → DEFER rather than cementing it.

### 5.3 The defer handshake (so a defer carries *both* parties' positions)

A defer is *triggered* on one party's turn, but the Convener should receive a **co-signed** request that reflects both sessions — and a premature/timid defer should be caught before it reaches the human. So deferring is a two-step handshake, mirroring §4:

1. The party that wants to defer does **not** baton to the Convener. It ends its turn with:
   `— <LABEL> · END OF TURN · PROPOSE DEFER · BATON → <OTHER PARTY>`
   and states: the **question**, **which gate fired**, **its own leaning**, and a **draft Decision Request**.
2. The other party's next turn does exactly one of:
   - **Resolve / decline** — first it **must** attempt Gate 1 itself and say what it checked. If it *can* resolve it ("here's the ground truth, `file:line`") or judges it local ("here's my assumption, let's proceed"), it takes a normal turn and the dialogue continues — **no human bothered.**
   - **Co-sign** — only after confirming Gate 1 is genuinely exhausted ("Gate-1 checked: <what I checked / why unreachable>"). It adds **its own leaning**, finalizes the joint Decision Request, and ends:
     `— <LABEL> · END OF TURN · DEFER TO CONVENER · BATON → CONVENER`

The defer that reaches the Convener is therefore co-signed by construction and carries **both** leanings; when they disagree, the Convener sees a genuine articulated fork (which is when human input is most valuable). One party can't unilaterally escalate — the other gets a veto-or-resolve first. All defers, gate-triggered and trip-wire-triggered alike, route through `PROPOSE DEFER`.

### 5.4 The Decision Request

A co-signed defer's final turn must contain a **Decision Request** for the Convener:
- the specific question(s);
- **which gate fired** (so the Convener can see it isn't timidity);
- the options, each with **both parties' leanings**;
- what is **blocked** until it's answered.

### 5.5 Resuming after the Convener answers

Both watchers stop on the `BATON → CONVENER` handoff. To resume: the Convener appends a short answer block ending `— CONVENER · END OF TURN · BATON → <party>`, then re-invokes `/dialogue-join` in that one session. Its completion check sees the baton, it reads the answer, takes the next turn, and re-arms — ping-pong resumes.

## 6. The background waiting mechanic (how you self-drive)

So the two sessions converge **without the Convener passing messages**, each session watches the dialogue file in the background and wakes itself when the baton returns. `/dialogue-join` arms this for you; the mechanic is documented here.

**When you first join:**
- If you are **Party A** (opener): write Turn 1, then arm the watch.
- If you are **Party B**: the baton is already yours (Party A opened) — take your turn now, then arm the watch.

**Arming the watch** — run this as a **background** command (it polls every 10s and exits the moment your turn is due, or when a turn has been handed to the Convener — consensus *or* defer, both end `BATON → CONVENER`). Substitute `<DIALOGUE_FILE>` and your own `<YOUR-LABEL>`:

```powershell
$f = "<DIALOGUE_FILE>"; $me = "<YOUR-LABEL>"; $max = 600; for ($i=0; $i -lt $max; $i++) { $last = (Get-Content -LiteralPath $f | Where-Object { $_.Trim() -ne "" } | Select-Object -Last 1); if ($last -match "BATON.*CONVENER") { Write-Output "CONVENER"; Write-Output $last; exit 0 }; if ($last -match "BATON.*$me") { Write-Output "YOUR_TURN"; Write-Output $last; exit 0 }; Start-Sleep -Seconds 10 }; Write-Output "TIMEOUT"; Write-Output $last
```

*(POSIX/bash equivalent, if a session isn't on PowerShell:)*
```bash
f="<DIALOGUE_FILE>"; me="<YOUR-LABEL>"; for i in $(seq 1 600); do last=$(grep -v '^[[:space:]]*$' "$f" | tail -n1); case "$last" in *BATON*CONVENER*) echo "CONVENER"; echo "$last"; exit 0;; *BATON*"$me"*) echo "YOUR_TURN"; echo "$last"; exit 0;; esac; sleep 10; done; echo "TIMEOUT"; echo "$last"
```

**On wake:**
- Output `YOUR_TURN` → the other party finished and the baton is yours: read the new turn(s), write your reply per §3–§5, then **re-arm** the watch.
- Output `CONVENER` → a turn was handed to the Convener (consensus or defer): **stop. Do not re-arm.** Surface the final turn (joint summary or Decision Request) to the Convener and end.
- Output `TIMEOUT` → ~100 min passed with no baton to you: report the stall to the Convener rather than guessing; optionally re-arm.

This is exactly the loop both parties run: *take turn → arm watch → wake on baton → take turn → …* until `CONVENER`.

## 7. Hygiene

- Keep turns focused — prefer converging over exhausting every tangent. Cite sources/`file:line` so the other party can verify.
- Each side owns ground truth about its own domain; correct the other's misreads rather than letting them stand.
- If the file ever ends **without** a baton (an interrupted write), **do not guess** — flag it to the Convener rather than processing a partial turn.
- Choose Party labels that won't collide in a regex (distinct, non-overlapping, `[A-Za-z0-9-]` only). If a label must contain regex-special characters, escape it in the watch command.
- The `CONVENER` end-token is reserved — don't use it as a Party label.
- Default to resolve-and-proceed (§5). Deferring is a real move, not a reflex — but never cement a foundational guess to avoid asking.

## 8. Launch prompts (generated by `/dialogue-convene`)

`/dialogue-convene` prints these with the paths and labels filled in. Shown here for reference.

**To the opener (Party A):**
> You are Party A in a dual-session dialogue. Run `/dialogue-join <DIALOGUE_FILE> <PARTY-A-LABEL>`. It will read the protocol (`<PROTOCOL_PATH>`) and the dialogue file, then have you write **Turn 1** opening the topic, end with your baton line, and arm the background watch so you self-drive. Continue until consensus or defer (`BATON → CONVENER`), then stop and give me the result. Don't prompt me between turns — the other session self-drives too.

**To the responder (Party B):**
> You are Party B in a dual-session dialogue. Run `/dialogue-join <DIALOGUE_FILE> <PARTY-B-LABEL>`. The baton is already yours — it will have you take your turn now, end with your baton line, and arm the background watch. Drive to consensus per §4 (or defer per §5); when you ratify, include the joint summary for me. Don't prompt me between turns.
