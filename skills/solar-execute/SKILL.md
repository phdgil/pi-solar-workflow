---
name: solar-execute
description: "Continue the approved Solar execution harness, repair a failed current step, or request fresh final verification. Exact reviewed-plan approval is required; mentioning execution or rerunning an old token does not grant authority."
---

# Solar Execution Harness

The controller binds `executor` and injects `solar-executor-practice`. Do not locate or read package skill files yourself. The agent produces the approved work; the host owns capability checks, gate dispatch, hashing, checkpointing and acceptance freshness.

## Execution

1. Read the host-supplied current step, dependencies, inputs, outputs, exact tools/paths/commands and gates.
2. Follow the bound Executor's procedure. Perform only the currently approved step; no adjacent installation, external mutation, commit or speculative cleanup.
3. Report actual work through `solar_step_done({stepId, summary, approach:{id,description}, evidence})` using current workspace-relative evidence paths. Do not supply approval, plan revision, gate status or manifest fields.
4. The host rechecks authority, runs gates and commits the current result. Do not claim pass before that result exists.

## Repair and handoff

- Preserve diagnostics and best artifacts. A changed method must yield new relevant diagnostics, changed outputs, resolved findings or passing gates. A new approach ID alone is not repair.
- A retry uses `approach.differsFrom` to identify the actual prior method.
- A contract/capability defect uses a named `solar_revisit` planning detour; material changes require full review and fresh human approval. Research/interview detours remain narrow and lineage-preserving.
- Exhausted limits pause instead of claiming completion. A stop or stale identity blocks further dispatch and commits.

## Final boundary

When the host reports no step remains, use `solar_step_done` with `stepId:'final'` to request verification only. This grants no product mutation.

The host hashes all finals, reruns approved gates, then hashes again. Missing/changed bytes or stale authority invalidate the result. Current command-only finals may complete automatically. Rubric/human finals stop at `awaiting_final_review` for actual user `/solar-workflow accept <current-token>` or revision; the Executor cannot accept on the user's behalf.

## Scenarios

- Normal: exact step output → independent host gate → current checkpoint → fresh final verification.
- Failure: file exists but its values are wrong → failed check and targeted repair, not successful completion based on existence or a 'mental hash'.
