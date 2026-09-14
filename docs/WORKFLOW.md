# Research -> interview -> plan -> execute

pi-solar-workflow is a Windows-only Pi 0.85.1 controller for exactly four skills: `solar-research`, `solar-interview`, `solar-plan`, and `solar-execute`. Every main or delegated model role must resolve to Upstage `solar-pro4` with Max thinking or fail visibly. Select the main model and thinking level with Pi's normal `/model` and `/thinking` controls; the workflow does not rewrite provider/model configuration or fall back to another model. Normal flow moves forward, but evidence may justify a bounded return to an earlier stage without discarding the original request, answers, corrections, or research.

## Commands and authority

### Harness roles

The four public skills are stage dispatchers. The package's `harness/agents.json` defines six roles and links each to one dedicated `harness/skills/<role>/SKILL.md`. `runtime/harness.ts` loads these explicit package files without workspace skill discovery. A missing or invalid role/skill fails closed.

Research, interview and execution bind their current role to the main-session system prompt; this does not create independent child contexts for those stages. Planning loads the Planner and the two distinct reviewer skills into the existing isolated Pi sessions while keeping SDK `noSkills` and tool isolation enabled. Role-specific procedures are not duplicated in the public stage skills or controller constants.

The main planning dispatcher has only `solar_plan_ready` and `solar_revisit`, not filesystem `read`. The host selects provenance and loads private worker skills; the model must not locate those package files itself.

At the interview tool boundary, `currentGapId` is required: explicit `null` for a substantively ready report, or the exact nonempty readiness gap/contradiction ID otherwise. The host converts null to the existing domain V2 absent-gap representation before running all readiness, source and freshness validators. Null cannot turn an unresolved report into a ready one.

The controller retains sole authority over state, bounded dispatch, review identities, approval and final verification. See [the role definitions and experiment protocol](HARNESS_DESIGN.md). Actual model quality must be measured separately from structural controller tests.

| Command | Effect |
| --- | --- |
| `/solar-workflow status` | Shows the current stage, reviewed/approved revision, detours, steps, and budgets. |
| `/solar-workflow approve <revision>` | Approves exactly the displayed, fully reviewed plan revision and starts execution. |
| `/solar-workflow revise <feedback>` | Invalidates current approval/acceptance authority and returns the staged plan to planning. |
| `/solar-workflow accept <revision>` | Accepts current qualitative evidence for the exact revision after file freshness is rechecked. |
| `/solar-workflow stop` | Saves state and removes continuation authority. |
| `/solar-workflow resume` | Resumes only the stage/revision already authorized; it grants no approval. |
| `/solar-workflow limits cycles=N detours=N turns=N` | Adjusts the existing cycle, detour, and main-session turn budgets. |

Interview closure commands are deliberately distinct:

| Command | Effect |
| --- | --- |
| `/solar-interview confirm <current-token>` | Normal closure: confirms the exact current ready goal. |
| `/solar-interview finish` | Explicit early closure at any score; open and stale items remain labeled. |
| `/solar-interview finish plan-only` | Early closure and a hard planning-only boundary. |
| `/solar-interview continue` | Continues with another consequential question. |
| `/solar-interview review` | Reassesses saved evidence without pretending a new answer was supplied. |
| `/solar-interview pause`, `resume`, `stop`, `status` | Saves, resumes, stops, or displays interview state without implicit advancement. |

Quotations, assistant prose, a plain “yes,” or merely mentioning a command never grant authority. Interrupted work is not success. Exhausted budgets pause with retained evidence and actionable choices.

## 1. Research

```text
/skill:solar-research Use <task-folder>. Investigate <question> using <allowed-sources>.
```

Research keeps the original intention separate from claims. A submission identifies:

- evidence, inference, uncertainty, and user-decision claims;
- sources and successful retrieval receipt IDs;
- limitations and the remaining gap;
- learned claim IDs; and
- for a useful detour, a named next question with its gap and rationale.

The model does not write the authoritative research artifact. `solar_research_ready` submits a versioned contract and the artifact revision it expects. The controller validates size, claim/source/receipt lineage, workflow/gap/answer-head identity, and disk freshness before it renders and revision-safely replaces `.solar-workflow/<workflow-id>/research.md`. A stale revision, malformed contract, missing receipt, or unowned collision leaves existing bytes untouched and keeps the stage repairable.

On an initial pass, a valid ready result may enter interview. `--research-only` validates and persists the submission before ending at `research_complete`; a blocked result cannot masquerade as advancement. During a detour, the controller returns to the saved caller only for the same gap and answer head. Prior research and every saved answer/correction remain available. A useful return contains relevant new source content and a named improved question; when evidence is unavailable, the result says `blocked` with limitations rather than inventing an answer.

Search snippets are discovery leads, not retrieved evidence. Tavily can retrieve public search/pages and Unstructured can extract public PDF/Office results. Each research pass permits three basic searches, three page reads, and two public-document reads; a document is bounded to 10 MiB and 120 seconds. These are application safeguards, not Tavily/Unstructured contractual quotas. A receipt proves retrieval, not semantic correctness. `--local-only` or `--no-web` excludes external research.

## 2. Interview

The interviewer asks at most one consequential question per turn and records an evidence-linked round after each answer. Ambiguity dimensions remain advisory. Scores cannot automatically finish the interview, require a minimum number of rounds, or make repeated wording useful.

Corrections are first-class saved decisions and override older answers or research inference. The current material state tracks:

- decisions, corrections, constraints, and success definitions by substantive topic and normalized value;
- open, narrowed, and resolved gaps; and
- relevant claims by gap and source-content hash.

IDs, receipt IDs, URLs, titles, hashes, prose length, and score changes locate or summarize evidence; alone they are neither progress nor stagnation. Progress requires a relevant material change, such as a new/changed decision or correction, a narrowed/resolved gap, a different source-backed claim, a changed verified diagnostic, a passing gate, a resolved plan finding, or changed output bytes. The same short words can still be meaningful for a different substantive topic.

After one no-progress answer on the current gap, the next strategy must be a genuine reframe or targeted research detour. If that distinct strategy also adds no material information, the interview pauses with the precise gap, attempt trace, saved answers, corrections, and choices. Unchanged resume cannot clear that state; new evidence or user direction can.

### Normal readiness

A normal ready assessment must be current for the answer and research heads, contain exactly one goal sentence, and have no material gaps, contradictions, or stale review. The controller enters `awaiting_goal_confirmation`, derives a goal revision, and displays its current 12-character lowercase hexadecimal token. Only this exact command normal-closes:

```text
/solar-interview confirm <current-token>
```

Any new answer or research result invalidates the token. Normal confirmation records the exact goal sentence that the user accepted.

### Labeled early finish

The user remains free to stop questioning at any score:

```text
/solar-interview finish
```

This creates `mode: early`. It preserves unresolved, contradictory, deferred, and stale-assessment items for planning and never presents normal readiness as achieved. Early closure grants a planning handoff, not execution authority; only a later exact reviewed-plan approval may authorize execution. Narrowly recognized direct English/Korean finish requests have the same semantics; quoted or hypothetical text does not. `/solar-interview finish plan-only` additionally prevents any execution path.

When interview needs a factual answer it can request:

```text
solar_revisit({stage:'research',gap:'specific gap',evidence:'saved answers and observed reason'})
```

The returned evidence must retain the same gap/answer lineage. The controller, not the model, decides whether the transition is structurally current.

## 3. Plan and review

Planning reads the original request, complete research history, saved answers and corrections, non-goals, deferrals, unresolved issues, and task-relevant project evidence. It supports both:

- software/application plans with architecture, feasibility, integration, commands, and outputs; and
- research/analysis/document plans with methodology, source quality, evidence handling, document structure, and qualitative acceptance.

A versioned execution contract contains the domain; requirements; final/intermediate/evidence artifact descriptors; 1–40 bounded dependency-ordered steps; inputs, actions, outputs, capabilities, and feasibility; command/rubric gates; and a whole-plan self-check. Every final artifact must be produced by a step, mapped to a gate, and marked for command or human acceptance. Structural validity does not prove semantic coverage or feasibility.

Planning may revisit a missing fact or user decision:

```text
solar_revisit({stage:'research',gap:'factual or feasibility gap',evidence:'what was inspected'})
solar_revisit({stage:'interview',gap:'user decision or conflict',evidence:'answer and research references'})
```

### Separate, tool-free contexts

Planner, Approach Reviewer, and Critic each run in a fresh `SessionManager.inMemory(...)` Pi session with supported nonpersistent settings, explicit `solar-pro4`, `thinkingLevel: "max"`, and `tools:[]`. Extension, skill, prompt-template, and context-file discovery are disabled. Children cannot browse the workspace or inherit hidden main-session reasoning.

The controller supplies a canonical, hashed provenance bundle containing mandatory requirements, research, answers, current plan/findings, and selected source excerpts. The serialized UTF-8 bundle is capped at 256 KiB and each optional source excerpt at 32 KiB. Mandatory contracts are never silently truncated; missing or oversized evidence creates a visible research/revision blocker.

Each creation-plus-prompt attempt has one 180,000 ms deadline. The controller reserves budget before creation, rechecks workflow/input/plan identity after every await, ignores late output, and aborts/disposes obtained sessions. Defaults are:

- 12 SDK **session attempts** total;
- 3 repair attempts; and
- 3 review revisions.

A repair consumes one session attempt and one repair. These counters do not represent HTTP calls, provider retries, tokens, throughput, rate limits, or billing quotas.

The Approach Reviewer and Critic see the full current plan bundle in distinct contexts. The former checks domain-specific approach and feasibility; the latter checks whole-plan scope, risk, verification, and acceptance. Their receipts bind role, context, input revision, plan revision, model, Max thinking, attempt, and output revision. Because all roles use Solar Pro4 Max and controller-selected evidence, the reviews are correlated signals, not independent proof.

Every actionable finding is mapped to a changed plan location or marked blocked. A material finding requires a fresh Planner attempt, a full plan revision, resolution mapping, and fresh reviews by both reviewers. A stale, malformed, failed, blocked, or unresolved review cannot advance. Reviewers do not manufacture ceremonial findings when the plan already resolves a probe.

`solar_plan_ready(...)` validates and stages only the fully reviewed current digest. For executable work, the user reviews it before `/solar-workflow approve <revision>`. For planning-only work, the same complete parse/review/revision cycle ends at `planning_complete`; no approval token, execute tool, or execution follow-up is emitted.

## 4. Execute and verify

Execution receives only an exact reviewed revision with current human approval. Before any product mutation, one shared authority predicate checks the workspace/workflow identity, active execute stage, disk plan digest, approval, artifact-table revision, stop signal, and operation mode.

- **Step mode:** only the current dependency-ready step and its declared tools, paths, commands, and gates are authorized.
- **Final mode:** no step remains; only the exact approved gates may rerun. Final mode does not re-enable arbitrary mutation tools.

The same check protects model tool calls and direct host gates. Gate execution checks fresh state before every gate, immediately before every `pi.exec`, and after each result before commit. If an earlier gate or external action changes identity, stage, revision, approval, or descriptors, the remaining gates do not launch. Rubric capture is guarded too.

A completed step reports its approach and evidence:

```text
solar_step_done({step:'S1',summary:'what changed and why',evidence:['<evidence-file>'],approach:{id:'A1',description:'...'}})
```

Approved commands run in Windows PowerShell with user permissions, not in a path-confined sandbox. They time out after 60 seconds, must be non-destructive, and must encode the displayed pass condition and exit nonzero on failure. The runtime checks exit status, evidence identity/freshness, and declared files; it cannot infer arbitrary semantic thresholds from prose.

A failed step has at most three execution attempts. A targeted retry must use a genuinely changed approach. Repeating failed approach/evidence is no progress. When recovery is exhausted, the controller preserves best artifacts and diagnostics and pauses instead of completing.

### Checkpoint and artifact identity

The controller hashes the canonical artifact descriptor table. Changing an artifact path, kind, acceptance mode, or gate binding—even under the same ID—clears reusable results, approval, final checks, final review, and acceptance. Files, snapshots, attempts, and history remain as explicitly non-authoritative recovery evidence. An identical table may reuse only otherwise eligible step/gate/file-hash checkpoints, and final gates still rerun.

### Current finals and human acceptance

Final verification hashes every declared final, reruns every exact approved gate under final authority, then hashes finals again. Missing or changed bytes make the batch stale and return it to repair/replanning. A command-only plan auto-completes only if every final is command-accepted, every gate passes, no rubric exists, and the before/after manifests agree.

Any rubric or human-accepted final creates a final-review digest bound to the plan revision, artifact-table revision, final checks, and final manifest. The user reviews the current named evidence and chooses:

```text
/solar-workflow accept <revision>
/solar-workflow revise <feedback>
```

Acceptance first rehashes every final/evidence file. A change invalidates the token. Qualitative work is accepted by a human judgment with rationale, not a synthetic aggregate model score.

## Artifacts and preserved state

| Artifact/state | Authority |
| --- | --- |
| Controller-owned `research.md` | Validated evidence/lineage for the current workflow revision. |
| Saved answers, corrections, gaps, and research history | Persistent context across stages and detours. |
| Reviewed `plan.md` plus execution contract | Candidate scope and gates; not approval by itself. |
| Approval, dispatch checks, gate records, artifact-table revision, and final manifest | Authoritative only while all bound identities remain current. |
| `progress.md`, old files, snapshots, attempts, and best results | Human recovery/audit evidence; never implicit authority. |

For each completed step, `recordStep` stores verified contents up to 128 KiB per file and 1 MiB across active-workflow snapshot contents. Files through 16 MiB may be hash-only; larger outputs need a bounded verification report. Historical versions are deduplicated records rather than a promise that the entire session stays under 1 MiB.

There is no automatic destructive rollback. Stopping or invalidating authority preserves useful bytes but does not certify them.

## Boundaries and deployment

Before exact plan approval, ordinary product writes and external mutations are default-denied. Allowed preapproval activity is limited to reads, controlled public research, and controller-owned workflow artifacts. Installation, dependency changes, commits, publishing, destructive commands, credentials, and external-system changes require separate explicit authority.

The controller is not an OS sandbox. PowerShell gates run with the user's permissions. Solar role separation does not create independent model consensus. Hosted retrieval and schemas do not prove factual correctness. The implementation target is Windows; other operating systems are outside acceptance.

Source changes and installation are separate. A deployment must be separately approved, copy only the reviewed Pi Solar package through the documented Windows mechanism, compare source and installed hashes for the explicit package file list and four skills, and leave the installed Pi SDK, GJC, provider/model configuration, and unrelated user work unchanged.

Unsupported active persisted contract versions pause with an actionable error; the controller does not silently migrate them or dispatch work under an unknown shape.
