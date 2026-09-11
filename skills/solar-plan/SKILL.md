---
name: solar-plan
description: Trigger host-owned, tool-free Solar Max planning and two-role review from current workflow provenance. Optimized for Solar Pro4 Max: structured step decomposition, complete contract coverage, strong self-check.

---

# Solar Plan — Solar Pro4 Optimized

**Goal**: Produce a complete, reviewed ExecutionContractV3 that drives verified execution. Planning turns the current original request, research, saved interview decisions, corrections, non-goals, deferrals, and relevant source excerpts into a bounded executable plan.

**Solar Pro4 advantage**: Strong reasoning about dependencies, verification, and completeness. Use it to produce plans where every requirement traces to a step, every step has an exact capability and gate, and selfCheck confirms full coverage.

## Trigger Host Planning

At an active plan stage, call exactly:

```text
solar_plan_ready({})
```

This is a **trigger**, not a plan submission or writer. Do not:

- Inspect workspace source
- Author `plan.md`
- Supply `path`, `alignment`, `conflicts`, source IDs, context IDs, revisions, findings, or receipts

The host derives the current workflow, input, source, and disk identities; selects and hashes bounded provenance; and owns every role context and artifact write.

If the controller has surfaced a specific unresolved research or user-decision gap instead of an active planning trigger, use only the narrowest requested detour:

```text
solar_revisit({stage:'research', gap:'specific factual or feasibility gap',
  evidence:'current evidence and why it is insufficient'})
solar_revisit({stage:'interview', gap:'specific user decision or conflict',
  evidence:'saved answer/research references and the unresolved choice'})
```

Do not restart the whole workflow or repeat a detour that added no material information.

## Host-Owned Role Cycle

`solar_plan_ready({})` runs this bounded sequence:

1. **Planner** — Fresh tool-free Solar Pro4 Max session receives only host-selected provenance. Produces complete current plan.
2. **Approach Reviewer** — Distinct fresh session inspects the full plan. Software: architecture and feasibility. Research: methodology, evidence quality, document structure.
3. **Critic** — Distinct fresh session inspects whole-plan scope, risk, verification, and acceptance.
4. **Revision** — Every actionable finding is visible and revision-bound. Material findings start a fresh Planner attempt returning a complete revised plan plus resolution mapping.
5. **Re-review** — Both reviewers inspect the entire new plan in fresh contexts. Blocked, unresolved, malformed, stale, or failed reviews cannot advance.

All three roles use separate in-memory Pi SDK sessions with:
- No tools or resource discovery
- Explicit `upstage/solar-pro4`
- `thinkingLevel: "max"`

They are correlated same-model review signals, **not** independent proof. Receipts and structural validation do not replace command gates or qualitative human acceptance.

## Solar Pro4 Planner Reasoning Framework

When producing the plan, think through these steps in order:

### Step 1: Restate the goal

From the original request and saved interview, write **one sentence** that captures the intended outcome. If you cannot, the plan will lack focus.

### Step 2: List requirements with provenance

For each requirement:
- Give it a stable ID (R1, R2, ...)
- Write a concise description of the observable outcome
- Cite its source: original request, saved answer ID, or research claim ID

Do not invent requirements. Every requirement must trace to something in the provenance.

### Step 3: For each requirement, decide the artifact and check

Ask:
- What concrete file/artifact proves this requirement is met?
- What observable check verifies that artifact?

This drives the artifact table and gate design.

### Step 4: Order steps by dependency

For each step, decide:
- What inputs must exist before this step runs? (declare in `dependsOn`)
- What outputs does this step produce? (declare in `outputs`)
- What requirement does this step satisfy? (declare in `requires`)

**Rule**: A step cannot consume an artifact before any step produces it.

### Step 5: For every step, name exact capabilities

Each step declares:
- Exact host tool name (e.g., `write`, `bash`, `read`)
- For read/write: exact canonical workspace-relative paths
- For command: exact approved command(s)

**No vague capabilities.** "Use a shell command" is insufficient. "Run `python verify.py --check outputs.json`" is precise.

### Step 6: Design gates for every artifact

Every non-evidence artifact needs:
- Exactly one producing step
- At least one gate that verifies it
- `command` or `human` acceptance

**Command gate**: An exact non-destructive command whose exit status encodes the passing condition.

**Human/rubric gate**: A qualitative judgment criterion. Never disguise a rubric as a command gate.

### Step 7: Write selfCheck honestly

selfCheck must:
- Cover every requirement exactly once with actual covering steps and gates
- Cover every produced artifact exactly once with its producer and acceptance gates
- Leave `unresolved` as `[]`

selfCheck is a coverage map for structural validation, **not** reviewer authority.

## Required ExecutionContractV3 Structure

The host Planner must produce `plan.md` containing:

- `Status: ready`
- `## Goal and scope` — one-sentence goal + scope boundaries
- `## Steps and validation` — dependency-ordered steps with observable checks
- `## Design review` — design/method decisions and rationale
- `## Risk review and revisions` — known risks and mitigations
- `## Acceptance criteria` — how each artifact is accepted
- `## Remaining uncertainties` — honest unknowns
- `## Execution contract` — exactly one fenced JSON `ExecutionContractV3`

```json
{
  "version": 3,
  "domain": "software" | "research",
  "requirements": [
    {"id": "R1", "description": "observable requirement", "source": "exact provenance reference"}
  ],
  "artifacts": [
    {"id": "A1", "path": "canonical/workspace-relative-output",
     "kind": "final" | "intermediate" | "evidence",
     "acceptance": "command" | "human" | "none",
     "gates": ["G1"]}
  ],
  "capabilities": [
    {"id": "C1", "kind": "read" | "write" | "command",
     "tool": "exact_host_tool_name",
     "paths": ["canonical/workspace-relative-path"],
     "commands": ["exact command"]}
  ],
  "steps": [
    {"id": "S1", "title": "bounded outcome",
     "feasibility": "observed support and remaining assumptions",
     "inputs": [], "outputs": ["A1"],
     "actions": ["concrete action"],
     "dependsOn": [], "requires": ["R1"],
     "gates": ["G1"], "capabilities": ["C1"]}
  ],
  "gates": [
    {"id": "G1", "kind": "command" | "rubric",
     "check": "exact non-destructive command or qualitative rubric",
     "pass": "observable passing condition",
     "evidence": ["A1"]}
  ],
  "selfCheck": {
    "review": "scope, ordering, feasibility, risk, and acceptance checked",
    "requirementCoverage": [
      {"requirementId": "R1", "stepIds": ["S1"], "gateIds": ["G1"],
       "explanation": "how the step and gate cover R1"}
    ],
    "artifactCoverage": [
      {"artifactId": "A1", "stepId": "S1", "gateIds": ["G1"],
       "explanation": "how A1 is produced and accepted"}
    ],
    "unresolved": []
  }
}
```

## Contract Quality Rules

### Requirements
- One to 40 meaningful requirements, never padding.
- Each requirement maps to an actual step and one of that step's gates.
- Source must cite exact provenance (original request, saved answer, or research).

### Artifacts
- Every non-evidence artifact has exactly one producing step.
- Final artifacts use canonical workspace-relative paths.
- Final artifacts have `command` or `human` acceptance.
- Artifact.gates and Gate.evidence are reciprocal.

### Capabilities
- Each capability names one exact host tool.
- Read/write capabilities list exact paths and `commands: []`.
- Command capabilities list exact approved commands and any affected declared paths.
- Remove unused or speculative authority.

### Steps
- One to 40 meaningful dependency-ordered steps.
- Each step declares: inputs, outputs, requirements, dependencies, actions, feasibility, gates, capabilities.
- Produced inputs require a dependency path to their producer.
- `dependsOn` names earlier steps and is acyclic.

### Gates
- Command gates are exact non-destructive commands encoding their passing condition in exit status.
- Rubric gates are qualitative judgment criteria with named evidence.
- A rubric is never disguised as command proof.

### selfCheck
- Covers every requirement exactly once.
- Covers every produced artifact exactly once.
- `unresolved` must be `[]`.
- Each coverage entry cites an actual covering step and one of that step's gates.

## Solar Pro4 Common Plan Failures to Avoid

- Requirements in prose with no producing step
- Steps consuming artifacts before any step produces them
- Capabilities naming a tool but no exact path or command
- Final artifacts with `acceptance: "none"`
- Gates whose check is a vague qualitative statement rather than an exact command or named rubric
- selfCheck resolving to `[]` when requirements or produced artifacts exist
- Accepting selfCheck as proof instead of inspecting the full contract
- Duplicate or invented finding IDs across reviewers
- Vague `requiredChange` that does not name a concrete plan location
- Padding with extra steps to look thorough
- Omitting feasibility notes for steps with remaining assumptions

## Boundaries

**Executable work**: A completely reviewed plan stops at `awaiting_gate_review` and exposes only the current reviewed digest. Only the user's exact `/solar-workflow approve <current-token>` authorizes that revision. A later plan or artifact-descriptor change invalidates prior review, checkpoint reuse, approval, final checks, and acceptance authority.

**Planning-only work**: The same complete Planner → Approach Reviewer → Critic → revision/re-review cycle runs first. It then stops at `planning_complete` with no approval token, execute tool, or execution follow-up.

Do not claim completion in an ordinary final reply. Planning advances only through the host trigger and its current reviewed state.
