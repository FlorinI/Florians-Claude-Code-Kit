---
name: rca
description: 'Disciplined root-cause analysis for diagnosing why something is broken. Use whenever the user is debugging a bug, regression, incident, outage, flaky or intermittent behavior, a failing test, or asks "why is X happening" / "why did this break" / "whats causing this" — even if they never say the words "root cause." It forces a falsifiable hypothesis and a disconfirming check BEFORE any fix. It self-triages depth — a quick inline diagnosis for cheap reversible issues, or a full documented RCA when a fix or finding gates an expensive or irreversible decision (migration, rebuild, data backfill, pricing / security / auth change) or when the user asks for a written RCA. Also trigger when the user explicitly requests a "light RCA", "quick RCA", "heavy RCA", or "full RCA".'
---

# Root Cause Analysis

When something is broken, the cheap and tempting move is to name the first plausible cause and fix it. That is the single most common way root-cause analysis goes wrong, and it is precisely the failure mode of a fluent model: producing a confident, well-argued, *wrong* cause. The entire job of this skill is to make one habit automatic on every path — **state what would prove the hypothesis wrong, then go check before touching the fix.** Everything else is just how much rigor to spend on the writeup.

## On invocation: triage the depth, then proceed (do not ask)

The moment this skill triggers, choose a depth from the context you already have. Do **not** interrogate the user with a stakes questionnaire — that ceremony is exactly what this skill is designed to avoid, and it taxes the common (cheap) case hardest. Infer the stakes, announce your choice in one sentence, and proceed. The user keeps a veto either way.

**Default to the light path.** Escalate to the heavy path if any of these hold:

- The fix or finding **gates an expensive or hard-to-reverse decision** — schema migration, data backfill, system rebuild, pricing or contract change, an irreversible deploy.
- It touches a **high blast-radius surface** — auth, payments, money movement, data deletion, security, privacy.
- It is a **recurring or repeat failure**, or a whole class of bug, not a one-off.
- The user **asked for a written / full / documented RCA**.

Honor explicit overrides in both directions. "Quick diagnosis" or "just fix it" means light even when signals are present — if you think that's genuinely risky, say so in one line and then proceed as asked. "Full RCA" or "write it up" means heavy.

Announce in one line, then go. Don't wait for a reply. For example:

- "Low-stakes and reversible, so I'll do a quick diagnosis. Say 'go deep' if you want the full RCA."
- "This gates the migration, so I'll do a full documented RCA."
- "You asked for the writeup, proceeding heavy."

One more rule that holds on both paths: **do not narrate the steps as you work** ("now doing Step 4..."). The user should see the observation, the check, and the fix — never the machinery. The steps below are internal scaffolding for you, not a script to read aloud.

## The core (runs on both paths)

This is the method. Light and heavy run the *same* spine; they differ only in how much evidence apparatus gets documented afterward.

1. **Observation.** State precisely what is wrong, as observed, with no cause attached yet. Keep the symptom separate from your theory of it.
2. **Hypothesis + prediction.** Propose a cause, and a prediction that follows from it: "if this is the cause, then ___ should be true," or "changing ___ should produce ___."
3. **Falsify, then check.** State what would *disprove* the hypothesis ("this is wrong if ___"), then go get that evidence. In Claude Code this is runnable, not a thought experiment: write and run the test that fails if you're wrong, grep the code, reproduce the failure, pull the log or trace, run the A/B. Prefer a check that *could* disconfirm over one that can only confirm. An executed check outranks any amount of plausible argument.
4. **Fix.** Only once the hypothesis has survived the check. Apply the smallest change that addresses the cause, not the symptom.

If the check kills the hypothesis, that is success, not failure — form the next hypothesis and repeat. Never reach for the fix on a hypothesis you have not tried to break.

## Light path (the default)

Stay inline in the conversation. No file. Keep the readout short — a few lines, no headers, no evidence table, no step labels:

- What's wrong (the observation).
- Your hypothesis and the prediction it implies.
- The check you actually ran and what it showed — including anything it ruled out.
- The fix.

If you considered and dismissed an alternative cause, a single "ruled out X because Y" line is plenty. That's the whole output. Resist dressing it up.

## Heavy path

Read `references/heavy-rca.md` and follow the template there. It produces a documented Steps 0–6 RCA as a markdown artifact (written to a file in the repo next to the fix, or to a path the user names), with a confidence-rated evidence table and an explicit primary-vs-contributing-cause analysis. Only pull this file in when triage selected heavy — the light path should never carry this apparatus into context.
