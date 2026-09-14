---
name: solar-plan
description: "Start or revise the host-owned Solar planning harness: isolated Planner, Approach Reviewer and Critic sessions produce and review the current execution contract. Planning-only requests complete review but cannot expose execution authority."
---

# Solar Planning Harness

This main-session entry dispatches a team of defined roles; it is not the Planner itself. The controller explicitly loads each packaged agent definition and dedicated skill into a fresh, tool-free Pi session using `upstage/solar-pro4` with `thinkingLevel: max`.

| Role | Dedicated skill | Responsibility |
|---|---|---|
| planner | solar-planner-practice | Complete actionable plan and finding resolutions |
| approach_reviewer | solar-approach-reviewer-practice | Practical architecture or methodology and feasibility |
| critic | solar-critic-practice | Intent, scope, risk, false-success detection and acceptance |

## Dispatch

At an active planning stage call exactly `solar_plan_ready({})`.

These are host-loaded skill identifiers, not files for you to locate. Do not read package implementation files or load a worker's skill yourself. This dispatcher has only the planning and detour control tools.

Do not inspect workspace source, author `plan.md`, submit a path, choose provenance, or manufacture a review receipt. The host selects current provenance, supplies the authoritative schemas, hashes inputs and owns all writes.

## Host execution order

1. Planner returns the complete `planMarkdown` and `resolutions` JSON, including one `ExecutionContractV3`.
2. Host validates requirements, artifacts, capabilities, dependency order and gate relationships.
3. Approach Reviewer and Critic inspect the full current plan in separate contexts and return `PlanReview` JSON.
4. Material findings require a full Planner revision, location-bound resolutions and fresh review by both roles. Malformed, blocked, stale or unresolved output cannot advance.
5. Executable work stops at `awaiting_gate_review`. Only exact user `/solar-workflow approve <current-token>` authorizes that reviewed revision.
6. Planning-only work completes the same review cycle and stops at `planning_complete`, without an approval token or execution follow-up.

The three roles use the same model and supplied evidence. Separate contexts reduce direct contamination; they do not establish independent consensus or replace tests and human qualitative acceptance.

## Detours and limits

A host-surfaced factual gap uses `solar_revisit({stage:'research', gap, evidence})`; an unresolved user decision uses `stage:'interview'`. Choose only the named gap, not a whole-workflow restart. Existing attempt/repair/revision budgets remain controller-owned. A failed definition load or missing model is an error, never permission to fall back.

## Scenarios

- Normal: confirmed scope → complete contract → both current reviews → approval boundary.
- Failure: a gate checks only that a file exists despite a content requirement → material finding → revised gate → fresh reviews; no self-reported pass.
