# Validation and external acceptance

## Evidence status: Unreleased

The controller-rigor changes described in this checkout require fresh verification. At the time this documentation was updated, no deterministic suite, Pi smoke, package/install check, deployment, live Solar/Tavily/Unstructured call, frozen baseline comparison, or qualitative acceptance run had been recorded for this revision. Do not treat planned coverage, source inspection, schema validity, or earlier checkout results as a pass.

Historical releases and earlier working-tree checks remain historical evidence for their own bytes only. They do not validate the current interview, role-session, authority, artifact-identity, or final-freshness changes. See the corresponding tag and [changelog](../CHANGELOG.md) when reproducing an old release.

### Evidence classes must remain separate

| Evidence class | What it can establish | What it cannot establish |
| --- | --- | --- |
| Pure and fake-session deterministic tests | Contract parsing, state transitions, budgets, lifecycle races, authority predicates, hashes, and failure handling under controlled inputs. | Live provider behavior, semantic plan quality, research usefulness, or human document quality. |
| Offline real-Pi smoke | Package discovery and integration with a scripted/local endpoint and isolated Pi state. | A live Solar judgment or hosted research-service result. |
| Package/source-installed manifest | Which reviewed bytes were packaged or installed. | Runtime correctness or model quality. |
| Separately authorized frozen baseline/candidate run | Observable behavior under the two fixed tasks and common infrastructure. | Universal model superiority or behavior outside those cases. |
| Current qualitative human review | Acceptance of the named report/evidence bytes at that moment. | Perpetual filesystem integrity or an objective numeric quality guarantee. |

A test fixture, mock model, or source/type review must never be described as a live model result. A hosted retrieval receipt proves retrieval, not factual correctness. A human rubric decision is not replaced by a model score.

## Deterministic verification plan

These commands are verification instructions, not results. Run them only after implementation authorization, from the reviewed source checkout, with no dependency installation and no suppressed warnings:

```powershell
node --test <changed-test-file-1> <changed-test-file-2>
npm test
```

Inspect the `test:pi` script first. Run it only when the inspected fixture is offline and isolated:

```powershell
npm run test:pi
```

Packaging inspection is likewise a separate check:

```powershell
npm pack --dry-run --json
```

The deterministic evidence set must cover at least:

1. `tools:[]`, explicit Solar/Max, a fresh in-memory manager, all discovery disabled, bounded provenance included, and excluded content absent.
2. Already-cancelled, never/late creation, never/late prompt, deadline, stop, and shutdown races; no late prompt/write/receipt; every obtained session aborted/disposed exactly once; budget refusal before spawn.
3. Same-gap duplicate “I don’t know,” fresh IDs, flat scores, and duplicate receipt/content as no progress; a genuine correction at flat score as progress; identical words on a different substantive topic handled by that topic’s ledger state.
4. Current ready goal/token normal closure; stale token, gap, contradiction, or stale review rejection; exact early finish preserving open state; ambiguous text not advancing.
5. Typed research-only and detour submission without generic write/edit/shell; stale, malformed, missing-lineage, or collision cases not overwriting; gap/answer/source lineage surviving reload.
6. Fresh Planner, Approach Reviewer, and Critic contexts and current receipts; material/blocked/malformed/stale reviews not advancing; all attempts and repairs counted; same-model correlation displayed.
   - Native Planner schema reaches the installed SDK/provider without changing Solar Max or enabling tools. Canonical raw-output-to-Markdown/resolution binding rejects forged artifacts, old envelopes, malformed contracts, heading/fence injection and unchanged canonical revisions.
7. Fully reviewed planning-only completion with no approval or execute path.
8. The same authority guard protecting model tools and direct host gates; a stop/revision/workflow change during gate A preventing gate B; wrong-step rejection and a valid final rerun.
9. Artifact path/kind/acceptance/gate rebinding clearing reuse and approval while preserving bytes/history; an identical descriptor table retaining only otherwise eligible checkpoints.
10. Duplicate failed approach rejected as repair; a distinct approach plus new diagnostic continuing; no-outcome recovery pausing with best work.
11. A modified final invalidating a constant report and human token; current command-only finals auto-completing only when all conditions pass; every rubric/human final waiting.
12. Windows case, `..`, absolute path, junction, alternate-data-stream, and collision defenses; generic preapproval mutators denied while controlled public research/controller artifacts remain possible.
13. Explicit package file literals, optional host peers, no dependencies/bundles/install hooks, exactly four skills, the `solar-pro4`/Max mapping, public-doc privacy, installed-copy isolation, and unchanged GJC/unrelated-work manifests.

A failing check is evidence of an unresolved defect, not permission to weaken the assertion, suppress a warning, or substitute a prose claim.

## Source, package, and deployment evidence

Implementation verification must compare a pre-edit preservation manifest with the current approved source scope. Public reports contain only portable relative paths, hashes, tool versions, and redacted evidence—never credentials, private task content, or full session exports.

Deployment is not part of source implementation. Under separate deployment approval:

1. Inspect the explicit `package.json.files` list and package dry-run result.
2. Update only the installed Pi Solar package through the documented Windows package mechanism.
3. Hash every shipped source file and each of the four skill files in both source and installed locations.
4. Require exact path/byte agreement and exactly four Solar skills.
5. Confirm the installed Pi SDK, GJC, provider/model configuration, credentials, and unrelated user work did not change.
6. Run only the separately approved offline load smoke.

Example comparison shape:

```powershell
Get-FileHash -Algorithm SHA256 "<source-checkout>\runtime\extension.ts"
Get-FileHash -Algorithm SHA256 "<installed-package>\runtime\extension.ts"
```

Repeat for the complete explicit manifest. No installation or installed-copy command is claimed to have run in this documentation update.

## Frozen two-case external baseline protocol

This protocol is live/human evidence and requires separate authorization after deterministic verification and deployment approval. Do not loosen or redesign it after seeing candidate output.

### Freeze before either run

Before observing candidate output, create one signed/hash-identified manifest containing:

- baseline and candidate package hashes;
- Node and Windows versions;
- both common external task prompts;
- the user answer/correction scripts;
- exact fixture bytes;
- commit-pinned public URLs and source hashes;
- service and privacy policy;
- approval decisions;
- fault-injection timing;
- exact command oracles;
- the human rubric; and
- evaluator identity.

Use separate clean Pi homes and workspaces, with the same Solar Pro4 Max and service availability. Keep each version’s installed skills, internal prompts, commands, state, and artifact formats unmodified. “Same prompts” means the common external task and user script, not candidate-only internal instructions imposed on the baseline.

### Case S — `WIN-CLI-SOLAR-CSV`

External prompt, exactly:

> Create a dependency-free Node 22 Windows CLI `solar-summary.mjs` that reads a supplied CSV path and safely writes `daily-summary.json`; clarify material ambiguity and preserve unrelated files.

Freeze these valid rows:

```text
(2026-06-01T23:30:00+09:00,1000,30)
(2026-06-02T00:00:00+09:00,500,60)
(2026-06-02T10:00:00+09:00,1200,30)
```

The ordered expected daily values are:

```text
2026-06-01: {"energyKWh":0.5,"peakWatts":1000}
2026-06-02: {"energyKWh":1.1,"peakWatts":1200}
```

Also freeze an invalid CSV fixture and the exact sentinel bytes of a pre-existing output. Invalid input must exit nonzero and leave those sentinel bytes unchanged.

The correction script is fixed: group by the literal date in each offset timestamp, not by UTC conversion; validate all rows before replacement; round energy to at most three decimals.

Probes:

- **Same-gap no-information:** answer “I don’t know” twice to the same unresolved rounding/error question. After a distinct reframe or research strategy, provide the frozen correction so material progress can resume.
- **Review:** inspect atomic-output, error, and offset handling. A surviving defect must create an actionable finding mapped to a revision and followed by both re-reviews. Never fabricate a finding if Planner already removed the defect. Across both cases, at least one actual actionable reviewer finding is required for the review-finding observation; otherwise record `not observed` without a ceremonial rerun.
- **Recovery/no false completion:** give the first approved implementation attempt the invalid fixture/failing command, then require a genuinely changed repair. Only an actual `node --test` result and the exact frozen valid/invalid output commands may support completion.
- **Freshness:** mutate a declared final before the final rerun. Current checks must replace old evidence before completion.

### Case R — `PUBLIC-PI-CONTROL-REPORT`

External prompt, exactly:

> Write a 900–1200 word `pi-workflow-controls.md` comparing when a Pi workflow rule belongs in a skill, extension, or both, for a Windows-only approval workflow; use official public evidence, distinguish evidence/inference/user choice/unknown, and do not change GJC.

Before both runs, resolve one Pi repository commit and pin/hash its public `docs/skills.md` and `docs/extensions.md` URLs.

The correction is fixed: Pi only; all GJC and model configuration remain unchanged; mainline public documentation is not proof of installed-version behavior.

Probes and required output:

- **Same-gap/detour:** answer “I don’t know” twice when asked whether skills alone can enforce tool calls/persistence. The candidate transition expected for observation is no-progress -> reframe or research detour -> return to the same gap with cited evidence and a named improved question. The human records the gap, before/after question, learned source, and an `improved` or `not improved` rationale.
- **Report checks:** 900–1200 words; both pinned citations; a comparison table covering instruction loading, tool/event enforcement, persistent state, and approval boundary; explicit evidence/inference/decision/unknown labels; and a Windows/Pi/GJC caveat.
- **Review:** Approach Reviewer covers methodology, source quality, evidence, and document structure; Critic covers scope and acceptance. A real material or advisory issue must be actionable. Any material issue requires a revision and both re-reviews. If no issue exists, record that honestly rather than manufacture one; the combined cases still require one actual finding for the review-finding observation.
- **Recovery:** preserve a deliberately incomplete draft and require a changed approach rather than false completion.
- **Staleness and qualitative acceptance:** after `awaiting_final_review`, alter the report and attempt acceptance; it must fail. Restore or revise and reverify current bytes. A human then records `accept` or `revise` against source fidelity, reasoning trace, structure, recommendation alignment, and caveats. There is no numeric threshold.

### Neutral observation record

Use one table with these rows, in this order:

1. `load/model`
2. `initial research`
3. `question/correction`
4. `same-gap recovery`
5. `detour`
6. `closure`
7. `plan detail`
8. `approach review`
9. `critic`
10. `revision/re-review`
11. `approval`
12. `execution/checkpoints`
13. `failed check/changed approach`
14. `staleness`
15. `completion`

Each baseline and candidate cell includes native transcript references, native files/state, command results, hashes, human decisions, and exactly one status: `met`, `not met`, `capability absent`, `not applicable`, or `infrastructure invalid`.

Do not synthesize candidate-only execution contracts, goal tokens, reviewer receipts, or artifact formats for the baseline. A missing baseline feature is `capability absent`, not a harness failure. A baseline native stop, pause, idle, or error after successful load and task attempt is a product observation even without a matching candidate phase. A product crash after valid launch is also a product result.

`Infrastructure invalid` is limited to a broken/corrupt fixture or harness, a common credential/service outage, inability to launch either isolated environment, or evaluator interruption before native state is observable. Repair shared infrastructure and rerun both sides at most once under the same authorization and frozen envelope. Do not rerun merely to obtain favorable model prose or a review finding.

### Shared rubric and acceptance

For every observation row, record a written rationale—never an aggregate model score—covering:

- intent/correction fidelity;
- evidence/citation integrity;
- question relevance and nonrepetition;
- material-progress recovery;
- plan executability;
- review trace and actionability;
- approval and side-effect authority;
- verified repair;
- current-output correctness;
- truthful completion; and
- human report quality.

Across the two cases, the candidate must demonstrate the approved A1–A11 outcomes: registry-confirmed Solar/Max roles and bounded lifecycle; typed, truthful research; useful lineage-preserving detours; normal goal confirmation and labeled early finish; information-based stagnation; executable and fully reviewed planning-only plans; context-separated correlated reviews with resolved findings; exact approval and guarded current-output verification; changed-approach recovery without false completion; the frozen native-format comparison; and unchanged GJC/configuration/unrelated work. The baseline is measured in its native form and is not required to implement candidate formats.

A current human decision remains mandatory for the qualitative report. Deterministic success cannot pre-authorize live services, deployment, or human acceptance, and live prose cannot override a deterministic authority/freshness failure.

## Known limitations

- Structural validators and hashes establish references and byte identity, not complete semantic understanding, optimal plans, or factual truth.
- Planner, Approach Reviewer, and Critic are context-separated but all use Solar Pro4 Max; their judgments are correlated.
- The 180-second deadline, 12 session attempts, 3 repairs, and 3 review revisions are controller attempt bounds, not HTTP/token quotas or provider guarantees.
- Hosted search/document extraction can be partial; receipts do not prove the extracted conclusion. Private/local document upload is outside scope.
- Approval is not an OS sandbox. Approved PowerShell and Pi tools run with the user’s permissions.
- Final manifests certify checked bytes at a boundary, not immutable files afterward.
- Acceptance is Windows-only. No macOS/Linux or universal-model claim is made.
- The frozen cases measure two tasks, not general superiority or long-horizon production reliability.

Report versions, hashes, native outcomes, and redacted evidence. Do not publish credentials, private answers, private research inputs, or full session exports by default.
