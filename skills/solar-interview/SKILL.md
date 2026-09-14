---
name: solar-interview
description: "Start, continue, or reassess the Solar interview harness to clarify intention, resolve corrections and conflicting constraints, and confirm a current goal. Interview confirmation grants planning handoff only, never execution."
---

# Solar Interview Harness

The controller binds `interviewer` and injects `solar-interviewer-practice`. Do not locate or read package skill files yourself. The agent clarifies intention; the controller owns saved heads, readiness freshness, material-progress checks and closure.

## Execution

1. Use the host's saved original answers, corrections, research head, exact saved-answer ID list, separately labeled source hashes and current assessment. Do not make the user repeat settled information.
2. Follow the bound Interviewer procedure: one consequential gap and at most one question per turn.
3. Finish authorized reads first, reuse successful results, then call `solar_interview_round` once as the only tool call in that assistant response. Never mix a report or `solar_revisit` with reads or another tool. The six-call interview budget counts reads and invalid reports, so reserve one call for the complete report.
4. For a factual gap use `solar_revisit({stage:'research', gap, evidence})`; the host preserves the return route and answer history.

## Wire preflight

- Every dimension `evidence`, deferral `evidence`, and readiness `evidenceIds` item is one bare exact saved answer ID from the host list. Never put content hashes, explanations, labels, or filenames there.
- Only MaterialState `sourceContentHashes` fields use the separately supplied 64-character content hashes.
- Check `goal`, `constraints`, `success`, and optional `context` independently. Each score below `1` needs its own nonempty unresolved `gap`, even when the same gap appears elsewhere.
- Each readiness material gap or contradiction needs nonempty exact saved-answer `evidenceIds`.
- Substantive readiness still requires no material gaps, contradictions, or blockers, one grounded goal sentence, `strategy: "ready"`, and explicit `currentGapId: null`. Never mark an unknown ready to satisfy serialization.

## Closure and recovery

- Normal closure is only the user's exact `/solar-interview confirm <current-token>` after the host displays a current one-sentence goal and its 12-character token. New answers or research invalidate old tokens.
- `/solar-interview finish` is an explicit early exit carrying all unresolved/contradictory/deferred items into planning. `/solar-interview finish plan-only` also disables subsequent execution.
- Plain agreement, quotations, assistant prose or discussion of planning is not confirmation.
- One no-information result requires a genuinely different reframe or targeted research. A second unsuccessful strategy pauses with evidence preserved; changing IDs or wording is not progress.
- `/solar-interview review`, `retry`, `continue`, `resume` and `pause` use current saved state. Retrying a report does not create a new answer.

## Scenarios

- Normal: the saved request already states goal, constraints and observable success → current ready report → host token → user confirmation.
- Failure: two consequential answers conflict → one targeted clarification, not a ready report based on a high score.
