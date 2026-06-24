# Heavy RCA Template (Steps 0–6)

Use this only when triage selected the heavy path. Produce a **markdown file** — write it into the repo next to the fix, or to a path the user names. The point of all this apparatus is *defensibility*: a reader should be able to trace every cause back to evidence, and trust that "primary cause" is a tested claim rather than a guess. If that property isn't worth the effort here, you should have stayed on the light path.

State this method note at the top of the artifact so the reader knows the rules you held yourself to:

> This RCA follows the 7-step chain, Steps 0 to 6. Step 3 states explicit falsification conditions. Step 4 cites at least 2 independent sources, each with an H/M/L confidence rating. Step 5 names one primary cause plus 2–3 contributing factors, with the four primary-cause tests applied.

## Header block

- **Area / package:** what system or surface this covers
- **Anchors:** the specific failure(s) this RCA explains (e.g. ticket IDs, symptoms)
- **Owner / accountable:** who owns the fix
- **Date / version / status**

## Per anchor, walk Steps 0–6

### Step 0. Current State
Tools in use, owners, and how the relevant flow works *today* — including current config values. This is the shared baseline a reader (or a client who knows the system better than you) needs in order to follow everything below. Don't skip it just because it feels obvious to you.

### Step 1. Observation
The precise, factual symptom as observed. No cause yet. Separate what happened from why you think it happened.

### Step 2. Hypothesis
The proposed cause, plus the prediction it implies: "if this is correct, then ___." A hypothesis with no testable prediction is an opinion — rewrite it until it makes a claim about the world you can check.

### Step 3. Test
Explicit falsification conditions — **"Disproved if ___."** List the concrete checks or experiments that could kill the hypothesis, then actually run them. The best test is one whose likely outcome you are not already sure of. If every listed condition is one you know won't happen, you haven't designed a real test.

### Step 4. Evidence
A table, minimum 2 *independent* sources:

| # | Source | Finding | Date | Confidence |
|---|--------|---------|------|------------|
| 1 | e.g. code `path:line` | what it shows | date | H: direct observation |
| 2 | e.g. reproduced run / trace ID | what it shows | date | H: controlled A/B, same input |

Rate each H / M / L with a one-clause reason. Distinguish direct evidence (code you read, a trace, behavior you reproduced) from reported or secondhand claims. The strongest row is an *executed* test, not a citation — weight accordingly.

### Step 5. Root Cause
**Primary cause:** name exactly one, then justify it against the four tests:

1. **Collapse** — does removing this cause make the whole cluster of symptoms disappear, or most of it?
2. **Symptom vs cause** — is this the cause, or is it itself a downstream symptom of something deeper?
3. **Evidence concentration** — does your high-confidence evidence actually converge here?
4. **Intervention prerequisite** — do the other candidate fixes only become effective once this one is addressed?

**Contributing factors:** 2–3, each tied back to its anchor ("Deduced from ___"). These are the conditions that amplified or enabled the failure without being the primary driver.

### Step 6. Intervention
The fix, plus a KPI or measurement for before/after, plus ship criteria. State plainly what the fix does **not** address — naming the residual is how you avoid implying one cause explained everything.

## Guardrail: resist the single-root-cause reflex

For complex or emergent failures (an LLM agent system very much qualifies), one clean "root cause" is often a fiction — the failure is the product of several interacting conditions. The primary-plus-contributing structure exists precisely so you don't flatten that. If a failure genuinely has no single primary cause, say so and present the interacting factors honestly rather than forcing one into the "primary" slot to satisfy the template.
