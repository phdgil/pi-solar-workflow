---
name: solar-execute
description: Execute only the current approved step capabilities, then let host guards run gates, repairs, and fresh final verification. Optimized for Solar Pro4 Max: precise step execution, honest approach documentation, clean gate reporting.

---

# Solar Execute — Solar Pro4 Optimized

**Goal**: Execute one approved step at a time with precise tool usage, honest reporting, and clean gate satisfaction. Each step produces its declared output, passes its declared gates, and advances the workflow.

**Solar Pro4 advantage**: Strong instruction following and tool-use precision. Use it to execute exactly what the plan declares — no more, no less.

## Execution Loop

For each step:

1. **Read the host-supplied step**: current step ID, declared inputs, dependencies, capabilities (exact tools, paths, commands), and gates.
2. **Confirm inputs exist**: Verify declared input artifacts are present at their declared paths before acting.
3. **Execute the bounded action**: Use only the declared tools, canonical paths, and exact commands. Do not infer adjacent authority.
4. **Verify output exists**: Confirm the output artifact exists at its declared path before reporting.
5. **Report via `solar_step_done`**: Provide exact step ID, concrete summary, approach, and evidence paths.

## Calling `solar_step_done`

After completing one bounded step:

```text
solar_step_done({
  stepId: 'S1',
  summary: 'what observable work changed and why it satisfies this step',
  approach: {
    id: 'stable-approach-id',
    description: 'specific method actually used and the evidence it produced'
  },
  evidence: ['canonical/workspace-relative-evidence-path']
})
```

### Payload Rules

| Field | Requirement |
|-------|-------------|
| `stepId` | The current step ID supplied by the host, not a guessed alias |
| `summary` | What changed and why current evidence satisfies the step gates; do not claim gates passed before the host runs them |
| `approach.id` | Stable short identifier for the method used |
| `approach.description` | The real method, not merely a new name; specific enough that a retry could differ from it |
| `evidence` | Current canonical workspace-relative files relevant to the step, including declared outputs or diagnostics |

Do not supply caller-owned plan, approval, input revision, gate status, or manifest fields. The host reloads fresh workflow state and the disk plan, derives the exact dispatch expectation, and checks everything.

## Solar Pro4 Execution Precision

### Before Acting

1. **Confirm the step is current**: The host says "work on S1" — work on S1, not S2 or "whatever seems next."
2. **Read the capabilities**: If the step declares `capabilities: [{tool: "write", paths: ["output/result.json"]}]`, use `write` to create `output/result.json`. Do not use `bash` to write it unless the step also declares a `bash` capability with an exact command.
3. **Check dependencies**: If `dependsOn: ["S0"]`, confirm S0's outputs exist before proceeding.

### During Execution

1. **Use exact commands**: If the step declares `commands: ["python transform.py --input data.json --output result.json"]`, run that exact command. Do not add flags, change arguments, or substitute a different script.
2. **Stay in scope**: Do not install dependencies, commit, publish, or change external systems unless the approved capability explicitly covers that action.
3. **Preserve credentials and unrelated work**: Do not touch files outside the declared paths.

### After Execution

1. **Verify the output artifact exists** at its declared path before calling `solar_step_done`.
2. **Hash it mentally**: Know what content you produced. The host will hash it and compare.
3. **Write an honest summary**: "Created result.json with transformed records. Input had 12 records, output has 12 records matching the schema. Gate G1 will verify the schema."

## Failed Step and Repair

When a gate fails, output is missing, or a tool error occurs:

**Do not claim completion.** Preserve best artifacts and visible diagnostics.

### Targeted Retry

For a materially different repair approach:

```text
solar_step_done({
  stepId: 'S1',
  summary: 'result of the materially different repair',
  approach: {
    id: 'changed-approach-id',
    description: 'what changed in method and what new relevant evidence it produced',
    differsFrom: 'exact-prior-approach-id'
  },
  evidence: ['canonical/current-diagnostic-or-output']
})
```

### What Counts as a Valid Retry

A changed approach must produce:
- A relevant new diagnostic, **or**
- A passing gate, **or**
- Plan resolution, **or**
- Changed output bytes

**Not valid**: New ID, reworded description, duplicate command output, unchanged bytes.

### Repair Limits

Repair limits are controller-owned. When exhausted, return to a user decision or replan — not false completion.

## Detours During Execution

When execution exposes a factual, intent, or feasibility defect, use the narrowest allowed detour:

```text
solar_revisit({stage:'research', gap:'specific evidence gap',
  evidence:'current files, gate output, and why the gap matters'})
solar_revisit({stage:'interview', gap:'specific user decision or conflict',
  evidence:'saved decisions plus current execution evidence'})
solar_revisit({stage:'plan', gap:'specific contract, capability, ordering, or failed-gate defect',
  evidence:'current gate output, files, and attempted approaches'})
```

Detours preserve original intention, answers, research history, artifacts, and diagnostics. A plan detour creates a new revision requiring full role review and fresh human approval.

**Do not repeat a no-information detour.**

## Final Verification

After every step has a passing host record and the host reports no step remains, request final verification:

```text
solar_step_done({
  stepId: 'final',
  summary: 'request fresh final verification of all declared final artifacts and gates',
  approach: {
    id: 'final-verification',
    description: 'rehash current finals, rerun every approved gate, and compare the post-gate manifest'
  },
  evidence: ['canonical/declared-final-path']
})
```

`stepId: "final"` authorizes **verification only** — it never re-enables arbitrary step mutation.

### Final Verification Process

1. Host hashes every final artifact before gates.
2. Host runs every exact approved gate under final authority.
3. Host hashes finals after gates.
4. Host compares pre/post manifests.

A missing or changed file, stale plan, changed descriptor table, failed gate, or manifest mismatch routes to repair/replan.

### Completion Paths

**Command-only finals**: May auto-complete when every final is command-accepted, every gate passes, no rubric exists, and pre/post manifests match.

**Human/rubric finals**: Stop at `awaiting_final_review`. The user must inspect current evidence and use `/solar-workflow accept <current-token>` or `/solar-workflow revise <feedback>`.

Acceptance rehashes final and evidence files; changed bytes invalidate the token.

## Solar Pro4 Common Execution Failures to Avoid

- Acting on a stale or wrong step ID
- Using a tool, path, or command not declared in the current step's capabilities
- Reporting evidence that does not exist at the declared path
- Repeating the same failed approach under a new ID
- Claiming completion before the host commits the gate result
- Adding extra work beyond what the step declares
- Installing dependencies or changing external systems without explicit capability
- Writing a static progress report instead of actual artifact output
- Claiming a gate passed when the host hasn't verified it yet
- Suppressing warnings or failures

## Honest Reporting

The host gate records, current manifests, and required human qualitative acceptance are authoritative. When you report:

- **Say what you did**, not what you hoped would happen.
- **Say what evidence exists**, not what you think should exist.
- **Say when a gate failed**, not when you think it should pass.
- **Say when you're blocked**, not when you want to pretend progress.

An ordinary final reply, static `progress.md`, old token, self-reported test result, or generic model judgment cannot complete execution.
