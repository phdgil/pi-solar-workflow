# pi-solar-workflow

**Research the context. Sharpen the intention. Approve a plan. Verify the current result.**

`pi-solar-workflow` is a Windows-only, role-and-skill harness for [pi](https://github.com/earendil-works/pi) 0.85.1 and Upstage Solar Pro4 Max. Its four public stages are **research -> interview -> plan -> execute**:

- `solar-research`
- `solar-interview`
- `solar-plan`
- `solar-execute`

Six explicit agent definitions in [harness/agents.json](harness/agents.json) bind dedicated procedural skills. Researcher, Interviewer and Executor run as stage-specific main-session roles; Planner, Approach Reviewer and Critic run in fresh tool-free sessions. The existing controller is the deterministic orchestrator, not an extra model agent. Internal skills are loaded explicitly from the package rather than exposed as additional public commands. See the [design and live experiment protocol](docs/HARNESS_DESIGN.md); role separation is a hypothesis to test, not a performance guarantee.

The main role and the Planner, Approach Reviewer, and Critic roles must resolve to registry-configured Upstage `solar-pro4` with Max thinking or stop truthfully. The three planning roles use fresh, separate Pi sessions, but they use the same model and supplied evidence; their reviews are correlated self-review signals, not independent consensus or proof.

This project is experimental and independent of pi, Upstage, GJC, and OMX. It does not install credentials, change model/provider configuration, patch the Pi SDK, or change GJC. Current controller behavior and model quality must be verified separately; documentation is not a test result.

**Measured status:** the harness has not demonstrated superiority or convergence. Real full-loop trials encountered invalid model contracts and deadlines; passing regression tests does not establish high-quality autonomous execution. Read the [actual experiment results and limitations](docs/HARNESS_EXPERIMENTS.md) before adoption.

## Install into Pi

The implementation target is Windows with Node.js 22.19+, Git when installing from Git, and `@earendil-works/pi-coding-agent` 0.85.1. Installation or deployment is a separate approval boundary. After reviewing the source, an authorized installation can use placeholders such as:

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1
pi install "<source-checkout>"
pi
```

The local checkout contains the Unreleased controller contract. Tagged `v0.3.0` is a historical baseline and does not provide these guarantees. The package installs the runtime and exactly four skills; copying one `SKILL.md` is insufficient.

Source edits do not update an already installed copy. After separately approving an installation/update, use the documented Windows mechanism, then compare every shipped source file and all four skill files with the installed copy. For example:

```powershell
Get-FileHash -Algorithm SHA256 "<source-checkout>\runtime\extension.ts"
Get-FileHash -Algorithm SHA256 "<installed-package>\runtime\extension.ts"
```

Repeat for the explicit package manifest; matching names alone are not evidence of matching bytes. Never patch the installed Pi SDK or GJC. In an open Pi session use `/reload` after updating the package; after restarting Pi, reopen the conversation with `/resume`. See [installation](docs/INSTALL.md) for credential and package-registration guidance.

Before starting a workflow, use Pi's normal `/model` and `/thinking` selectors to choose the configured Upstage `solar-pro4` model and Max thinking. The workflow reads the registry but does not write provider/model configuration; a missing or mismatched required model stops rather than falling back.

## Workflow

| Stage | Entry or handoff | Result |
| --- | --- | --- |
| Research | `/skill:solar-research` | The controller validates a typed evidence submission and owns the saved research artifact. An initial pass enters interview, `--research-only` ends at `research_complete`, and a useful detour returns to its saved caller. |
| Interview | Host handoff or `/skill:solar-interview` | Saves answers, corrections, open gaps, and an advisory assessment. Normal readiness requires exact goal confirmation; explicit finish is an early, labeled exit. |
| Plan | Interview closure or a planning detour | Produces a bounded plan for software/application or research/analysis/document work, then passes separate Approach and Critic review contexts. |
| Execute | `/solar-workflow approve <revision>` | Runs only the exact reviewed revision, one dependency-ready step and guarded evidence gate at a time. |

Start in one conversation and task folder:

```text
/skill:solar-research Use <task-folder>. Research the supplied context, clarify my intention, plan the work, and execute only after I approve the reviewed plan revision.
```

Corrections remain saved and override older interpretations. Research detours preserve the original request, answer history, caller, and gap. A detour may return only with relevant learned evidence and a named improved question, or with a truthful blocked result and limitations.

### Interview closure and stagnation

When the current answer/research heads support a one-sentence goal with no material gap, contradiction, or stale review, Pi shows that exact goal and a current 12-character lowercase hexadecimal token. Normal closure is:

```text
/solar-interview confirm <current-token>
```

A new answer or research result invalidates the token. A generic “yes,” quoted command, topical mention of planning, or assistant prose cannot close the interview.

The user may deliberately bypass normal readiness at any score:

```text
/solar-interview finish
/solar-interview finish plan-only
```

That path is recorded as **early** and carries unresolved, contradictory, deferred, and stale-assessment items forward instead of presenting them as resolved. Early closure itself grants only a planning handoff, never execution authority; only a later exact reviewed-plan approval can authorize execution. `finish plan-only` prevents that later execution path as well.

Progress is based on material information, not a new ID, receipt, URL, hash, score, or repeated wording. A changed decision or correction, narrowed/resolved gap, relevant claim backed by different source content, changed diagnostic, passing gate, resolved plan finding, or changed output can count. After one same-gap no-information result the workflow must reframe or take a targeted research detour. If that distinct strategy also adds no material information, it pauses with saved work and concrete choices; it does not claim completion.

### Context-separated plan review

Planner, Approach Reviewer, and Critic attempts receive a controller-selected provenance bundle and `tools:[]`; extension, skill, prompt-template, and context-file discovery are disabled. Each attempt uses a new in-memory Pi session, explicit `solar-pro4`, and `thinkingLevel: "max"`. The Approach Reviewer checks architecture/feasibility for software work or methodology/evidence/document structure for research work. The Critic checks whole-plan scope, risk, verification, and acceptance.

One attempt has a 180-second deadline covering session creation and prompting. Defaults are at most **12 SDK session attempts**, **3 repair attempts**, and **3 review revisions**. Repairs consume both an attempt and a repair. These are local controller/session-attempt budgets—not HTTP-request, retry, token, throughput, or provider quotas. Timed-out, cancelled, late, stale, or invalid attempts cannot write artifacts or passing receipts.

Material findings require a full Planner revision, a location-bound resolution record, and fresh reviews by both reviewers. Unresolved, blocked, malformed, or stale reviews cannot advance. A planning-only request still completes the entire parse/review/revision cycle, then stops at `planning_complete` with no approval token, execution tool, or execution follow-up.

### Exact approval and guarded verification

A fully reviewed executable plan is staged for human inspection; it is not authority to mutate product output. Review its requirements, artifact table, steps, capabilities, PowerShell commands, rubrics, and findings, then use one of:

```text
/solar-workflow approve <revision>
/solar-workflow revise <feedback>
/solar-workflow stop
```

Approval binds the exact reviewed plan digest and artifact-table revision. A plan or artifact descriptor change clears checkpoint reuse, approval, final checks, review, and acceptance authority while retaining files and history as non-authoritative recovery evidence.

Before approval, ordinary product mutation is default-denied. Only reads, controlled research, and controller-owned workflow artifacts are allowed. During execution the same fresh authority check guards model tools and direct host gate dispatch. It runs before each gate, immediately before each `pi.exec`, and before committing each result. A stop, revision, workflow change, wrong step, or stale approval aborts the remaining batch.

Approved command gates use PowerShell, run with the user's permissions rather than a sandbox, and must encode their pass threshold and exit nonzero on failure. A step report identifies its approach and evidence. Repeating a failed approach/evidence does not count as repair; exhausted recovery preserves the best artifacts and diagnostics and pauses.

Final verification hashes every declared final before gates, reruns all approved gates, and hashes finals again. Changed or missing bytes make the batch stale. Command-only finals may complete automatically only when every current gate and manifest passes. Any rubric or human-accepted final waits for qualitative review of the named evidence and:

```text
/solar-workflow accept <revision>
```

Acceptance is bound to the current plan, artifact table, checks, and file hashes. A changed file invalidates it. A human `revise` verdict returns to planning and requires fresh review and approval; there is no aggregate model score standing in for qualitative acceptance.

## Controller-owned research

`solar_research_ready` submits evidence, inference, uncertainty, and user-decision claims plus source/receipt lineage, limitations, the remaining gap, and an optional next question. The controller validates the expected artifact revision and detour lineage, renders `.solar-workflow/<workflow-id>/research.md`, and performs a revision-safe replacement. Stale submissions, malformed lineage, or an unowned collision do not overwrite bytes or advance the stage.

Tavily may retrieve public search/page evidence, and Unstructured may extract public PDF/Office results. Search snippets alone cannot satisfy evidence handoff. Use private environment variables for service keys and `--local-only` or `--no-web` to exclude external research. Each pass allows three basic searches, three page reads, and two public-document reads; a document is bounded to 10 MiB and 120 seconds. These are application safeguards, not service quotas. Receipts prove retrieval, not factual correctness; partial extraction and limitations must remain visible.

## Status and boundaries

```text
/solar-workflow status
/solar-workflow resume
/solar-workflow limits cycles=3 detours=8 turns=120
```

`resume` continues only an already authorized stage and never approves a revision. Existing cycle/detour/turn limits and the separate SDK role-attempt/review budgets stop no-progress loops without deleting saved answers, corrections, research, or best work.

This workflow is not an OS sandbox. Package installation, dependency changes, publishing, commits, destructive commands, credentials, and external-system mutations require separate explicit authority. See [workflow details](docs/WORKFLOW.md), [validation and the frozen external protocol](docs/VALIDATION.md), and [references and provenance](docs/REFERENCES.md).

Original package code and documentation are [MIT licensed](LICENSE). Model and hosted-service access are not granted by that license.
