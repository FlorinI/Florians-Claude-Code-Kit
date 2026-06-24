---
description: Interview me one question at a time to reach shared understanding of a feature before any plan is written. Each question comes with your recommended answer + the trade-off. No implementation plan until I say "alignment complete".
argument-hint: "[feature or problem, one line]"
---

# /grill-me

Pin down a feature through a **one-question-at-a-time interview** until we share an understanding of it. The output of this skill is *alignment*, not code — you do **not** write the implementation plan until I explicitly say **"alignment complete"**.

## The contract

- **One question per turn.** Never batch. Ask, wait for my answer, then ask the next. A wall of questions defeats the point.
- **Recommend, don't just ask.** Every question carries *your* recommended answer and the trade-off behind it — the cost of going the other way. I'm reacting to a proposal, not filling in a blank form. Make the recommendation concrete enough that "yes" is a complete answer.
- **Adapt.** Let my answer reshape what you ask next. If an answer closes a branch, skip its follow-ups; if it opens a risk, dig there. Don't read from a fixed script.
- **Track the gaps.** Keep a running sense of which areas below are still open, and steer toward the load-bearing unknowns first — the answers that, if they went the other way, would change the whole shape.
- **Hold the line on the plan.** No implementation plan, no code, no file layout, no step list until I say the magic words. If I ask for the plan early, point back to the open areas and ask whether I want to align them first or cut the interview short.

## Areas to cover

Work through these, but in the order the feature demands — not top-to-bottom by rote:

1. **User goal** — who is this for and what are they actually trying to accomplish? What does success look like from their side?
2. **Scope** — the smallest version that delivers the goal. What's explicitly *in* for v1.
3. **Edge cases** — empty/error/concurrent/large-input states; what happens when the happy path doesn't hold.
4. **Data model** — what's stored, its shape, where it lives, migrations/back-compat.
5. **UI** — surfaces, states, affordances; what the user sees and touches (skip fast if headless).
6. **Tests** — what proves it works; the cases worth pinning down before building.
7. **Rollout** — how it ships: flag, migration, phased, big-bang; how it's reverted if wrong.
8. **Risks** — what could break, regress, or surprise us; the assumptions that would sink the design if false.
9. **Out-of-scope** — what we are deliberately *not* doing, stated out loud so it doesn't creep back in.

## Question shape

Each question, keep it tight:

> **[Area]** — *the question.*
> **Recommend:** your proposed answer.
> **Trade-off:** what you give up by choosing it / the cost of the alternative.

Ask follow-ups in the same shape. When an area is settled, you may say so in one line and move on.

## When I say "alignment complete"

Only then:

1. Emit a compact **alignment summary** — the resolved decision for each area we covered, plus the explicit out-of-scope list. This is the shared understanding, captured.
2. *Then* write the implementation plan off that summary.

If I never say it, you never write the plan — you keep interviewing or stop when I stop.

---

If `$ARGUMENTS` names the feature, open with a one-line read-back of what you understand the feature to be, then ask your first question. If it's empty, ask me what we're aligning on before anything else.
