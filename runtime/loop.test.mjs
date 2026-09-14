import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acceptFinalReview,
  approveGateReview,
  artifactTableRevision,
  assertExecutionAuthority,
  beginPlanRevision,
  canonicalPlanPath,
  captureAcceptanceManifest,
  captureFinalManifest,
  classifyRecoveryProgress,
  completePlanReview,
  createRoleContextBundle,
  decodePlannerOutput,
  digest,
  evidenceFile,
  executionExpectation,
  finishVerification,
  initializeLoop,
  NATIVE_TOOL_AUTHORITY_ENTRY,
  nextStep,
  recordPlanReview,
  recordStep,
  requireApprovedPlan,
  researchReady,
  reserveRoleAttempt,
  resumeLoop,
  revisitWorkflow,
  runGates,
  settleRoleAttempt,
  structuredRevision,
  validateCurrentPlanReview,
  validateExecutionPlan,
  validateFindingResolutions,
  validateNativeToolAuthorityReceipt,
  validatePlanReview,
  validateRoleContextBundle,
  validateSolarRoleRequest,
  validateStepApproach,
} from "./loop.ts";
import {
  buildPlannerResponseSchema,
  countPlanSteps,
  EXECUTION_CONTRACT_ID_PATTERN,
  PLANNER_SECTION_HEADINGS,
} from "./planner-output.ts";
import { workspaceIdentity } from "./workflow.ts";

async function fixture(callback) {
  const base = realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, "solar-loop-unit-"));
  try {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    return await callback(workspace, root);
  } finally {
    assert.equal(path.dirname(realpathSync(root)), base);
    assert.ok(path.basename(root).startsWith("solar-loop-unit-"));
    rmSync(root, { recursive: true, force: true });
  }
}

function contractFixture(stepCount = 2, domain = "software") {
  const requirements = Array.from({ length: stepCount }, (_, index) => ({
    id: `REQ${index + 1}`,
    description: `Deliver bounded outcome ${index + 1}.`,
    source: `Original request item ${index + 1}.`,
  }));
  const artifacts = Array.from({ length: stepCount }, (_, index) => ({
    id: `ART${index + 1}`,
    path: `result-${index + 1}.txt`,
    kind: index === stepCount - 1 ? "final" : "intermediate",
    acceptance: "command",
    gates: [`GATE${index + 1}`],
  }));
  const gates = Array.from({ length: stepCount }, (_, index) => ({
    id: `GATE${index + 1}`,
    kind: "command",
    check: `verify outcome ${index + 1}`,
    pass: `Outcome ${index + 1} is present and valid.`,
    evidence: [`ART${index + 1}`],
  }));
  const capabilities = [];
  const steps = Array.from({ length: stepCount }, (_, index) => {
    const stepCapabilities = [];
    if (index) {
      capabilities.push({ id: `READ${index}`, kind: "read", tool: "read", paths: [`result-${index}.txt`], commands: [] });
      stepCapabilities.push(`READ${index}`);
    }
    capabilities.push({ id: `WRITE${index + 1}`, kind: "write", tool: "write", paths: [`result-${index + 1}.txt`], commands: [] });
    stepCapabilities.push(`WRITE${index + 1}`);
    return {
      id: `STEP${index + 1}`,
      title: `Produce outcome ${index + 1}`,
      feasibility: "Uses only exact local files and declared built-in tools.",
      inputs: index ? [`ART${index}`] : [],
      outputs: [`ART${index + 1}`],
      actions: [`Write and inspect outcome ${index + 1}.`],
      dependsOn: index ? [`STEP${index}`] : [],
      requires: [`REQ${index + 1}`],
      gates: [`GATE${index + 1}`],
      capabilities: stepCapabilities,
    };
  });
  return {
    version: 3,
    domain,
    requirements,
    artifacts,
    capabilities,
    steps,
    gates,
    selfCheck: {
      review: "Checked scope, dependency order, capabilities, feasibility, risks, artifacts, and acceptance.",
      requirementCoverage: requirements.map((requirement, index) => ({ requirementId: requirement.id, stepIds: [`STEP${index + 1}`], gateIds: [`GATE${index + 1}`], explanation: "The named step produces the required artifact and its gate checks it." })),
      artifactCoverage: artifacts.map((artifact, index) => ({ artifactId: artifact.id, stepId: `STEP${index + 1}`, gateIds: [...artifact.gates], explanation: "The producer and descriptor-bound gate are explicit." })),
      unresolved: [],
    },
  };
}

function planText(contract = contractFixture()) {
  return `# Plan\nStatus: ready\n\n## Execution contract\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n\n## Notes\nThe prose is supplementary.\n`;
}

function plannerSections(contract = contractFixture(), overrides = {}) {
  return {
    goalAndScope: "Deliver the exact requested artifacts within the declared scope.",
    stepsAndValidation: contract.steps.map((step, index) => `${index + 1}. ${step.title}; run ${step.gates.join(", ")}.`).join("\n"),
    designReview: "Use only the dependency order, artifact boundaries, and capabilities declared in the contract.",
    riskReviewAndRevisions: "Reject stale inputs, undeclared authority, and outputs that lack current gate evidence.",
    acceptanceCriteria: "Every declared final artifact satisfies its bound command or human acceptance gate.",
    remainingUncertainties: "None in this bounded fixture; all required inputs and checks are explicit.",
    ...overrides,
  };
}

function plannerOutput(contract = contractFixture(), resolutions = [], sections = plannerSections(contract)) {
  return JSON.stringify({ status: "ready", sections, contract, resolutions });
}

function diskPlan(workflow) {
  return { workspaceId: workflow.workspaceId, path: workflow.plan.path, text: workflow.plan.text, revision: workflow.revision };
}

function commitAuthority(workflow, mode) {
  return { diskPlan: diskPlan(workflow), expectation: executionExpectation(workflow, mode) };
}

function roleSuccess(workflow, { role, inputRevision, planRevision, outputRevision, repair = false, contextId } = {}) {
  const ordinal = workflow.budgets.roleCalls + 1;
  const attemptId = `${role}-attempt-${ordinal}`;
  const actualContextId = contextId ?? `${role}-context-${ordinal}`;
  let next = reserveRoleAttempt(workflow, {
    attemptId,
    contextId: actualContextId,
    role,
    inputRevision,
    ...(planRevision ? { planRevision } : {}),
    repair,
    ...(repair ? { repairOf: `${role}-attempt-${Math.max(1, ordinal - 1)}` } : {}),
    startedAt: ordinal * 1_000,
    deadlineAt: ordinal * 1_000 + 180_000,
  });
  next = settleRoleAttempt(next, attemptId, "succeeded", "A structurally valid role response was captured before the deadline.");
  return {
    workflow: next,
    receipt: {
      contextId: actualContextId,
      role,
      provider: "upstage",
      modelId: "solar-pro4",
      thinkingLevel: "max",
      inputRevision,
      ...(planRevision ? { planRevision } : {}),
      outputRevision,
      attemptId,
      attemptOrdinal: ordinal,
      repair,
      bundleRevision: inputRevision,
      policy: {
        sessionPersistence: "memory",
        tools: [],
        customTools: [],
        resourceDiscovery: { extensions: false, skills: false, promptTemplates: false, themes: false, contextFiles: false },
        compaction: "disabled",
        agentRetries: 0,
        providerRetries: 0,
        providerTimeoutMs: 180000,
        deadlineMs: 180000,
        attemptAccounting: "sdk_session_attempts",
      },
    },
  };
}

function beginReviewing(workflow, contract = contractFixture(), wireResolutions = []) {
  const visibleOutput = plannerOutput(contract, wireResolutions);
  const decoded = decodePlannerOutput(visibleOutput, workflow);
  const inputRevision = digest(`planner bundle ${workflow.id} ${workflow.revision ?? "initial"}`);
  const role = roleSuccess(workflow, { role: "planner", inputRevision, ...(workflow.revision ? { planRevision: workflow.revision } : {}), outputRevision: digest(visibleOutput) });
  return beginPlanRevision(role.workflow, { path: workflow.plan?.path ?? path.join(workflow.cwd ?? process.cwd(), ".solar-workflow", workflow.id, "plan.md"), text: decoded.planMarkdown, revision: digest(decoded.planMarkdown) }, { plannerReceipt: role.receipt, inputRevision, visibleOutput, resolutions: decoded.resolutions });
}

function reviewFixture(workflow, role, overrides = {}) {
  const review = {
    version: 1,
    role,
    planRevision: workflow.revision,
    domain: workflow.plan.contract.domain,
    verdict: "pass",
    assessment: {
      focus: role === "critic" ? "whole_plan_scope_risk_verification_acceptance" : workflow.plan.contract.domain === "software" ? "software_architecture_feasibility" : "research_methodology_evidence_structure",
      analysis: role === "critic" ? "Reviewed whole-plan scope, risks, verification, and acceptance." : "Reviewed the current domain's approach feasibility and structural method.",
    },
    requirementCoverage: workflow.plan.contract.requirements.map(requirement => {
      const steps = workflow.plan.contract.steps.filter(step => step.requires.includes(requirement.id));
      return { requirementId: requirement.id, status: "covered", stepIds: steps.map(step => step.id), gateIds: [...new Set(steps.flatMap(step => step.gates))], explanation: "Current plan locations and gates cover this requirement." };
    }),
    findings: [],
    limitations: ["This is a correlated same-model structural and qualitative review signal."],
    ...overrides,
  };
  return review;
}

function appendReview(workflow, role, overrides = {}, receiptOverrides = {}) {
  const review = reviewFixture(workflow, role, overrides);
  const inputRevision = digest(`${role} bundle ${workflow.revision}`);
  const visibleOutput = JSON.stringify(review);
  const roleRun = roleSuccess(workflow, { role, inputRevision, planRevision: workflow.revision, outputRevision: digest(visibleOutput), ...receiptOverrides });
  return recordPlanReview(roleRun.workflow, review, roleRun.receipt, inputRevision, visibleOutput);
}

function fullyReviewed(workflow, contract = contractFixture()) {
  let current = beginReviewing(workflow, contract);
  current = appendReview(current, "approach_reviewer");
  current = appendReview(current, "critic");
  return completePlanReview(current, { alignment: "The exact requirements, artifacts, capabilities, and gates match the saved intent.", conflicts: [] });
}

function executionWorkflow(workspace, contract = contractFixture(), overrides = {}) {
  const text = planText(contract);
  const planPath = path.join(workspace, ".solar-workflow", "workflow-test", "plan.md");
  const revision = digest(text);
  return initializeLoop({
    id: "workflow-test",
    stage: "execute",
    status: "active",
    originalTask: "Create verified local outputs.",
    cwd: workspace,
    workspaceId: workspaceIdentity(workspace),
    autoExecute: true,
    plan: { path: planPath, text, revision, contract },
    revision,
    artifactTableRevision: artifactTableRevision(contract.artifacts),
    approval: revision,
    approvalArtifactTableRevision: artifactTableRevision(contract.artifacts),
    planning: { revisionState: "reviewed" },
    results: {},
    attempts: {},
    ...overrides,
  });
}

function currentFile(workspace, artifactId, filename) {
  return { artifactId, ...evidenceFile(workspace, filename) };
}

function gateResult(workspace, contract, id, overrides = {}) {
  const gate = contract.gates.find(item => item.id === id);
  const files = gate.evidence.flatMap(artifactId => {
    const artifact = contract.artifacts.find(item => item.id === artifactId);
    try { return [currentFile(workspace, artifactId, artifact.path)]; } catch { return []; }
  });
  return { id, kind: gate.kind, acceptance: gate.kind === "command" ? "current_command" : "qualitative_human", passed: true, code: 0, killed: false, stdout: "current check passed", stderr: "", errors: [], files, ...overrides };
}

function checkpointAll(workflow) {
  let current = workflow;
  for (const step of workflow.plan.contract.steps) {
    for (const artifactId of step.outputs) {
      const artifact = workflow.plan.contract.artifacts.find(item => item.id === artifactId);
      writeFileSync(path.join(workflow.cwd, artifact.path), `verified ${step.id}: ${artifact.path}`);
    }
    const files = step.outputs.map(artifactId => {
      const artifact = workflow.plan.contract.artifacts.find(item => item.id === artifactId);
      return currentFile(workflow.cwd, artifactId, artifact.path);
    });
    const gates = step.gates.map(id => gateResult(workflow.cwd, workflow.plan.contract, id));
    current = recordStep(current, { stepId: step.id, summary: `Produced and verified ${step.id}.`, approach: { id: `APPROACH${step.id}`, description: `Write the exact declared output for ${step.id} and inspect current gate evidence.` }, files, gates }, commitAuthority(current, { kind: "step", stepId: step.id }));
  }
  return current;
}

test("native tool authority receipts use one strict, required, non-normalizing wire", () => {
  assert.equal(NATIVE_TOOL_AUTHORITY_ENTRY, "solar-native-tool-authority-v1");
  const call = Object.freeze({ assistantEntryId: "assistant-é", toolCallId: "call-1", toolName: "write" });
  const coverage = Object.freeze({
    version: 1,
    kind: "coverage",
    scope: "main_session_native_tool_hooks",
    dispatch: "every_call",
    result: "every_execution_allowed_call",
  });
  const execution = Object.freeze({
    version: 1,
    kind: "dispatch",
    call,
    stateEntryId: "state-1",
    stepId: "STEP1",
    decision: "execution_allowed",
    code: null,
  });
  const current = Object.freeze({ version: 1, kind: "result", call, decision: "current", code: null });
  for (const receipt of [coverage, execution, current]) {
    const before = structuredClone(receipt);
    assert.equal(validateNativeToolAuthorityReceipt(receipt), receipt);
    assert.deepEqual(receipt, before);
  }

  for (const code of [
    "duplicate_call",
    "mixed_control_batch",
    "interview_budget",
    "interview_read_denied",
    "waiting_boundary",
    "model_identity",
    "stage_tool_denied",
    "execution_guard_rejected",
  ]) {
    const receipt = { version: 1, kind: "dispatch", call, stateEntryId: null, stepId: null, decision: "blocked", code };
    assert.equal(validateNativeToolAuthorityReceipt(receipt), receipt);
  }
  for (const code of [
    "authority_recheck_failed",
    "authorization_already_invalidated",
    "duplicate_result",
    "unknown_authorization",
  ]) {
    const receipt = { version: 1, kind: "result", call, decision: "invalidated", code };
    assert.equal(validateNativeToolAuthorityReceipt(receipt), receipt);
  }
  const dispatchAllowed = { version: 1, kind: "dispatch", call, stateEntryId: null, stepId: null, decision: "dispatch_allowed", code: null };
  assert.equal(validateNativeToolAuthorityReceipt(dispatchAllowed), dispatchAllowed);

  const invalid = [
    null,
    {},
    { ...coverage, version: 2 },
    { version: 1, kind: "coverage", scope: coverage.scope, dispatch: coverage.dispatch },
    { ...coverage, extra: true },
    { version: 1, kind: "dispatch", call, stateEntryId: null, stepId: null, decision: "dispatch_allowed" },
    { ...dispatchAllowed, call: { toolCallId: "call-1", toolName: "write" } },
    { ...dispatchAllowed, call: { ...call, extra: true } },
    { ...dispatchAllowed, call: { ...call, assistantEntryId: "" } },
    { ...dispatchAllowed, call: { ...call, toolCallId: " call-1" } },
    { ...dispatchAllowed, call: { ...call, toolName: "write\n" } },
    { ...dispatchAllowed, stateEntryId: "state 1" },
    { ...dispatchAllowed, stepId: "\u0000" },
    { ...dispatchAllowed, code: "stage_tool_denied" },
    { ...dispatchAllowed, decision: "blocked", code: null },
    { ...dispatchAllowed, decision: "blocked", code: "unknown_block" },
    { ...execution, stateEntryId: null },
    { ...execution, stepId: null },
    { ...execution, stepId: "" },
    { ...execution, code: "execution_guard_rejected" },
    { ...execution, extra: true },
    { version: 1, kind: "result", call, decision: "current" },
    { ...current, code: "duplicate_result" },
    { ...current, decision: "invalidated", code: null },
    { ...current, decision: "invalidated", code: "execution_guard_rejected" },
    { ...current, decision: "unknown" },
    { ...current, extra: true },
    { ...current, kind: "unknown" },
  ];
  for (const receipt of invalid) assert.throws(() => validateNativeToolAuthorityReceipt(receipt));
});

test("ExecutionContractV3 requires artifacts, capabilities, gates, and complete self-checks", () => {
  assert.throws(() => validateExecutionPlan("# Plan\n## Execution contract\nDescribe work in prose."), /fenced json ExecutionContractV3/);
  const old = contractFixture();
  old.version = 2;
  assert.throws(() => validateExecutionPlan(planText(old)), /version 3/);

  const missingCapability = contractFixture();
  missingCapability.steps[0].capabilities = [];
  assert.throws(() => validateExecutionPlan(planText(missingCapability)), /nonempty array/);

  const uncovered = contractFixture();
  uncovered.selfCheck.requirementCoverage.pop();
  assert.throws(() => validateExecutionPlan(planText(uncovered)), /every requirement exactly once/);

  assert.deepEqual(validateExecutionPlan(planText()).steps.map(step => step.id), ["STEP1", "STEP2"]);
});

test("Planner wire renders exact canonical Markdown without copying envelope syntax", () => {
  const contract = {
    version: 3,
    domain: "software",
    requirements: [{ id: "R", description: "Deliver A.", source: "Request." }],
    artifacts: [{ id: "A", path: "a.txt", kind: "final", acceptance: "command", gates: ["G"] }],
    capabilities: [{ id: "C", kind: "write", tool: "write", paths: ["a.txt"], commands: [] }],
    steps: [{
      id: "S",
      title: "Write A",
      feasibility: "The declared write tool supports a.txt.",
      inputs: [],
      outputs: ["A"],
      actions: ["Write and inspect a.txt."],
      dependsOn: [],
      requires: ["R"],
      gates: ["G"],
      capabilities: ["C"],
    }],
    gates: [{ id: "G", kind: "command", check: "Inspect a.txt.", pass: "The exact required bytes are present.", evidence: ["A"] }],
    selfCheck: {
      review: "Reviewed.",
      requirementCoverage: [{ requirementId: "R", stepIds: ["S"], gateIds: ["G"], explanation: "S and G cover R." }],
      artifactCoverage: [{ artifactId: "A", stepId: "S", gateIds: ["G"], explanation: "S produces A and G checks it." }],
      unresolved: [],
    },
  };
  const sections = {
    remainingUncertainties: "None; this fixture supplies the complete bounded input.",
    acceptanceCriteria: "The bound command check passes for a.txt.",
    riskReviewAndRevisions: "Reject undeclared or unverified output.",
    designReview: "Use the one declared write boundary.",
    stepsAndValidation: "1. Write a.txt and inspect its exact bytes.",
    goalAndScope: "Deliver a.txt.",
  };
  const visibleOutput = JSON.stringify({ resolutions: [], contract, sections, status: "ready" });
  const expected = `# Plan
Status: ready

## Goal and scope
Deliver a.txt.

## Steps and validation
1. Write a.txt and inspect its exact bytes.

## Design review
Use the one declared write boundary.

## Risk review and revisions
Reject undeclared or unverified output.

## Acceptance criteria
The bound command check passes for a.txt.

## Remaining uncertainties
None; this fixture supplies the complete bounded input.

## Execution contract
\`\`\`json
{
  "artifacts": [
    {
      "acceptance": "command",
      "gates": [
        "G"
      ],
      "id": "A",
      "kind": "final",
      "path": "a.txt"
    }
  ],
  "capabilities": [
    {
      "commands": [],
      "id": "C",
      "kind": "write",
      "paths": [
        "a.txt"
      ],
      "tool": "write"
    }
  ],
  "domain": "software",
  "gates": [
    {
      "check": "Inspect a.txt.",
      "evidence": [
        "A"
      ],
      "id": "G",
      "kind": "command",
      "pass": "The exact required bytes are present."
    }
  ],
  "requirements": [
    {
      "description": "Deliver A.",
      "id": "R",
      "source": "Request."
    }
  ],
  "selfCheck": {
    "artifactCoverage": [
      {
        "artifactId": "A",
        "explanation": "S produces A and G checks it.",
        "gateIds": [
          "G"
        ],
        "stepId": "S"
      }
    ],
    "requirementCoverage": [
      {
        "explanation": "S and G cover R.",
        "gateIds": [
          "G"
        ],
        "requirementId": "R",
        "stepIds": [
          "S"
        ]
      }
    ],
    "review": "Reviewed.",
    "unresolved": []
  },
  "steps": [
    {
      "actions": [
        "Write and inspect a.txt."
      ],
      "capabilities": [
        "C"
      ],
      "dependsOn": [],
      "feasibility": "The declared write tool supports a.txt.",
      "gates": [
        "G"
      ],
      "id": "S",
      "inputs": [],
      "outputs": [
        "A"
      ],
      "requires": [
        "R"
      ],
      "title": "Write A"
    }
  ],
  "version": 3
}
\`\`\`
`;
  const decoded = decodePlannerOutput(visibleOutput, {});
  assert.equal(decoded.planMarkdown, expected);
  assert.deepEqual(decoded.contract, contract);
  assert.deepEqual(decoded.resolutions, []);
  assert.equal(countPlanSteps(sections.stepsAndValidation), 1);
  assert.equal(Object.isFrozen(PLANNER_SECTION_HEADINGS), true);
  assert.equal(PLANNER_SECTION_HEADINGS.every(entry => Object.isFrozen(entry)), true);
  assert.deepEqual(PLANNER_SECTION_HEADINGS.map(([key, heading]) => [key, heading]), [
    ["goalAndScope", "Goal and scope"],
    ["stepsAndValidation", "Steps and validation"],
    ["designReview", "Design review"],
    ["riskReviewAndRevisions", "Risk review and revisions"],
    ["acceptanceCriteria", "Acceptance criteria"],
    ["remainingUncertainties", "Remaining uncertainties"],
  ]);
});

test("Planner schema mirrors bounded V3 arrays and request-time tools and findings", () => {
  const tools = ["read", "write"];
  const findingIds = ["ARCH1", "CRIT1"];
  const schema = buildPlannerResponseSchema(tools, findingIds);
  const definitions = schema.$defs;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["status", "sections", "contract", "resolutions"]);
  assert.deepEqual(definitions.capability.properties.tool.enum, tools);
  assert.deepEqual(definitions.resolution.properties.findingId.enum, findingIds);
  assert.deepEqual(
    [schema.properties.resolutions.minItems, schema.properties.resolutions.maxItems],
    [findingIds.length, findingIds.length],
  );
  assert.equal(definitions.executionContract.properties.steps.maxItems, 40);
  assert.equal(definitions.step.properties.outputs.minItems, 1);
  assert.equal(definitions.gate.properties.evidence.minItems, 1);
  assert.equal(definitions.artifact.properties.gates.minItems, 0);
  assert.equal(definitions.capability.properties.paths.minItems, 0);
  assert.equal(definitions.capability.properties.commands.minItems, 0);
  assert.equal(definitions.selfCheck.properties.unresolved.maxItems, 0);
  assert.match(definitions.sections.properties.stepsAndValidation.description, /'1\. '/);
  assert.match(definitions.step.properties.requires.description, /requirements\[\]\.id/);
  assert.match(definitions.gate.properties.check.description, /exact authorized command/);
  assert.equal(buildPlannerResponseSchema(["read"], []).properties.resolutions.maxItems, 0);
  tools.push("bash");
  findingIds.push("LATE1");
  assert.deepEqual(definitions.capability.properties.tool.enum, ["read", "write"]);
  assert.deepEqual(definitions.resolution.properties.findingId.enum, ["ARCH1", "CRIT1"]);
});

test("native free-form strings avoid substring grammars while host nonblank guards remain authoritative", () => {
  const schema = buildPlannerResponseSchema(["read", "write"], []);
  for (const name of ["text", "path"]) {
    assert.equal(Object.hasOwn(schema.$defs[name], "pattern"), false);
    assert.equal(schema.$defs[name].minLength, 1);
  }
  assert.equal(schema.$defs.identifier.pattern, EXECUTION_CONTRACT_ID_PATTERN);
  const contract = contractFixture(1);
  for (const [key] of PLANNER_SECTION_HEADINGS) {
    assert.throws(() => decodePlannerOutput(plannerOutput(contract, [], plannerSections(contract, { [key]: " \t\n " })), {}), /Supply/);
  }
  const blankDescription = contractFixture(1);
  blankDescription.requirements[0].description = " \t ";
  assert.throws(() => decodePlannerOutput(plannerOutput(blankDescription), {}), /Supply/);
  const blankPath = contractFixture(1);
  blankPath.artifacts[0].path = " \t ";
  assert.throws(() => decodePlannerOutput(plannerOutput(blankPath), {}), /Supply/);
  const decoded = decodePlannerOutput(plannerOutput(contract), {});
  assert.equal(decoded.contract.artifacts[0].path, contract.artifacts[0].path);
});

test("Planner decoder rejects old envelopes, section injection, invalid step prose, and invalid V3 contracts", async t => {
  const contract = contractFixture(1);
  await t.test("old planMarkdown envelope", () => {
    assert.throws(() => decodePlannerOutput(JSON.stringify({ planMarkdown: planText(contract), resolutions: [] }), {}), /unsupported fields: planMarkdown/);
  });
  await t.test("unknown section key", () => {
    assert.throws(() => decodePlannerOutput(plannerOutput(contract, [], plannerSections(contract, { notes: "Competing content." })), {}), /sections contains unsupported fields: notes/);
  });
  await t.test("top-level heading injection", () => {
    assert.throws(() => decodePlannerOutput(plannerOutput(contract, [], plannerSections(contract, { designReview: "Review.\n## Forged section\nInjected." })), {}), /cannot inject a competing top-level heading/);
    assert.throws(() => decodePlannerOutput(plannerOutput(contract, [], plannerSections(contract, { designReview: "Forged section\n===" })), {}), /cannot inject a competing top-level heading/);
  });
  await t.test("fence injection", () => {
    assert.throws(() => decodePlannerOutput(plannerOutput(contract, [], plannerSections(contract, { acceptanceCriteria: "Evidence:\n```json\n{}\n```" })), {}), /cannot inject a Markdown fence/);
  });
  await t.test("no visible bounded step", () => {
    assert.throws(() => decodePlannerOutput(plannerOutput(contract, [], plannerSections(contract, { stepsAndValidation: "Perform the work without a visible bounded step label." })), {}), /one to 40 visibly bounded steps; found 0/);
  });
  await t.test("object-valued contract required", () => {
    const payload = { status: "ready", sections: plannerSections(contract), contract: JSON.stringify(contract), resolutions: [] };
    assert.throws(() => decodePlannerOutput(JSON.stringify(payload), {}), /object-valued ExecutionContractV3/);
  });
  await t.test("existing V3 semantics remain authoritative", () => {
    const invalid = contractFixture(1);
    invalid.steps[0].outputs = [];
    assert.throws(() => decodePlannerOutput(plannerOutput(invalid), {}), /nonempty array/);
  });
  await t.test("initial planning cannot invent resolutions", () => {
    const invented = [{ findingId: "FAKE1", status: "resolved", changedLocations: ["steps.STEP1"], explanation: "Invented." }];
    assert.throws(() => decodePlannerOutput(plannerOutput(contract, invented), {}), /cannot invent finding resolutions/);
  });
  await t.test("recovery requires changed canonical plan bytes", () => {
    const output = plannerOutput(contract);
    const decoded = decodePlannerOutput(output, {});
    assert.throws(
      () => decodePlannerOutput(output, { plan: { text: decoded.planMarkdown }, gap: "Current recovery gap", revision: digest(decoded.planMarkdown) }),
      /recovery gap requires changed plan bytes/,
    );
  });
  await t.test("current findings require changed canonical plan bytes", () => {
    const initialOutput = plannerOutput(contract);
    const initial = decodePlannerOutput(initialOutput, {});
    const resolution = [{ findingId: "F1", status: "resolved", changedLocations: ["steps.STEP1"], explanation: "Claimed change." }];
    const workflow = {
      revision: digest(initial.planMarkdown),
      planning: { reviewFindings: [{ id: "F1", severity: "material", summary: "Change required.", requiredChange: "Change the plan.", planLocations: ["steps.STEP1"] }] },
    };
    assert.throws(() => decodePlannerOutput(plannerOutput(contract, resolution), workflow), /review findings require a materially changed full plan/);
  });
});

test("contract IDs retain their exact grammar and report it on filename-shaped IDs", () => {
  for (const id of ["input.json", "nested/input", "_artifact"]) {
    const contract = contractFixture(1);
    contract.artifacts[0].id = id;
    assert.throws(() => validateExecutionPlan(planText(contract)), error =>
      error.message.includes(EXECUTION_CONTRACT_ID_PATTERN) && error.message.includes("path fields"));
  }
  for (const id of ["0-artifact_", "A".repeat(80)]) {
    const contract = JSON.parse(JSON.stringify(contractFixture(1)).replaceAll('"ART1"', JSON.stringify(id)));
    assert.equal(validateExecutionPlan(planText(contract)).artifacts[0].id, id);
  }
});

test("plan validation rejects stale references, cycles, non-actionable finals, and gate/artifact disagreement", async t => {
  const cases = [
    ["requirement coverage", contract => { contract.steps[1].requires = ["REQ1"]; }, /Every requirement/],
    ["unused gates", contract => { contract.steps[1].gates = ["GATE1"]; }, /Every command\/rubric gate/],
    ["forward dependency", contract => { contract.steps[0].dependsOn = ["STEP2"]; }, /earlier steps/],
    ["unknown input", contract => { contract.steps[1].inputs = ["UNKNOWN"]; }, /unknown input artifact/],
    ["unknown output", contract => { contract.steps[0].outputs = ["UNKNOWN"]; }, /unknown output artifact/],
    ["unknown capability", contract => { contract.steps[1].capabilities = ["UNKNOWN"]; }, /unknown capability/],
    ["artifact IDs are not requirements", contract => { contract.steps[0].requires = [contract.artifacts[0].id]; }, /requirement/],
    ["missing final acceptance", contract => { contract.artifacts[1].acceptance = "none"; }, /final artifact needs command or human/],
    ["human without rubric", contract => { contract.artifacts[1].acceptance = "human"; }, /human acceptance needs/],
    ["unreciprocated gate", contract => { contract.artifacts[1].gates = ["GATE1"]; }, /must list the artifact as evidence|bindings must be reciprocal/],
    ["unresolved self-check", contract => { contract.selfCheck.unresolved = ["Integration is unknown"]; }, /Resolve or explicitly return/],
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, () => {
    const contract = contractFixture();
    mutate(contract);
    assert.throws(() => validateExecutionPlan(planText(contract)), expected);
  });
});

test("artifact coverage excludes immutable inputs and reports the exact expected produced IDs", () => {
  const contract = contractFixture(1);
  contract.artifacts.push({ id: "INPUT", path: "input.json", kind: "evidence", acceptance: "none", gates: [] });
  validateExecutionPlan(planText(contract));
  contract.selfCheck.artifactCoverage.push({ ...contract.selfCheck.artifactCoverage[0], artifactId: "INPUT" });
  assert.throws(() => validateExecutionPlan(planText(contract)), error =>
    error.message.includes("no immutable input evidence") &&
    error.message.includes(`Expected artifact IDs: ${contract.artifacts[0].id}.`));
});

test("canonical plan paths fail closed for Windows traversal, drive, ADS, controller state, and case collisions", () => {
  for (const value of ["../outside.txt", "C:/outside.txt", "result.txt:stream", "folder\\result.txt", "/absolute.txt", "CON.txt", "folder/../result.txt", ".gjc/config.json", ".solar-workflow/id/plan.md"]) assert.throws(() => canonicalPlanPath(value), /workspace-relative|canonical|unsafe|reserved|cannot target/);
  assert.equal(canonicalPlanPath("nested/result.txt"), "nested/result.txt");
  const collision = contractFixture();
  collision.artifacts[0].path = "Result.txt";
  collision.artifacts[1].path = "result.TXT";
  assert.throws(() => validateExecutionPlan(planText(collision)), /case-insensitive/);
});

test("evidence resolution rejects a junction or symlink that escapes the workflow workspace", () => fixture((workspace, root) => {
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "evidence.txt"), "outside bytes");
  symlinkSync(outside, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => evidenceFile(workspace, "linked/evidence.txt"), /inside the workflow workspace/);
}));

test("artifact descriptor digest is order-stable but rebind-sensitive", () => {
  const artifacts = contractFixture().artifacts;
  assert.equal(artifactTableRevision(artifacts), artifactTableRevision([...artifacts].reverse()));
  for (const mutate of [
    artifact => { artifact.path = "renamed.txt"; },
    artifact => { artifact.kind = "evidence"; },
    artifact => { artifact.acceptance = "human"; },
    artifact => { artifact.gates = ["OTHER"]; },
  ]) {
    const changed = structuredClone(artifacts);
    mutate(changed[0]);
    assert.notEqual(artifactTableRevision(changed), artifactTableRevision(artifacts));
  }
});

test("role provenance bundles bind exact selected bytes and reject silent truncation or tampering", () => {
  const content = "Exact saved requirement text.";
  const item = { kind: "requirement", source: "REQ1", sha256: digest(content), selection: { whole: true }, bytes: Buffer.byteLength(content), content };
  const bundle = createRoleContextBundle([item], [{ source: "large-source.txt", reason: "Optional source excerpt exceeded the bounded relevance selection." }]);
  assert.equal(validateRoleContextBundle(bundle).bundleRevision, bundle.bundleRevision);
  assert.throws(() => validateRoleContextBundle({ ...bundle, items: [{ ...item, content: `${content} changed` }] }), /byte count|digest/);
  const oversized = "x".repeat(128 * 1024 + 1);
  assert.throws(() => createRoleContextBundle([{ kind: "source_excerpt", source: "source.txt", sha256: digest(oversized), selection: { startLine: 1, endLine: 2 }, bytes: Buffer.byteLength(oversized), content: oversized }]), /source excerpt exceeds/);

  const responseSchema = { type: "object", properties: { status: { enum: ["ready"] } } };
  const request = {
    workflowId: "roles",
    contextId: "planner-context",
    role: "planner",
    inputRevision: bundle.bundleRevision,
    systemPrompt: "Plan only from selected provenance.",
    prompt: "Return the exact Planner envelope.",
    bundle,
    responseSchema,
  };
  const validated = validateSolarRoleRequest(request, "roles");
  assert.deepEqual(validated.responseSchema, responseSchema);
  assert.notEqual(validated.responseSchema, responseSchema);
  assert.notEqual(validated.responseSchema.properties, responseSchema.properties);
  assert.throws(() => validateSolarRoleRequest({ ...request, role: "critic" }, "roles"), /Only Planner role requests/);
  assert.throws(() => validateSolarRoleRequest({ ...request, responseSchema: [] }, "roles"), /JSON Schema object/);
});

test("role attempt budgets count SDK sessions and repairs before dispatch", () => {
  let workflow = initializeLoop({ id: "roles", stage: "plan", status: "active" });
  assert.deepEqual({ reviewRevisions: workflow.limits.reviewRevisions, roleCalls: workflow.limits.roleCalls, roleRepairs: workflow.limits.roleRepairs, repairs: workflow.limits.repairs }, { reviewRevisions: 3, roleCalls: 12, roleRepairs: 3, repairs: 3 });
  for (let index = 0; index < 12; index += 1) {
    workflow = reserveRoleAttempt(workflow, { attemptId: `ATTEMPT${index}`, contextId: `CONTEXT${index}`, role: "planner", inputRevision: digest(`input ${index}`), repair: false, startedAt: index * 200_000, deadlineAt: index * 200_000 + 180_000 });
    workflow = settleRoleAttempt(workflow, `ATTEMPT${index}`, "failed", "Deterministic invalid response.");
  }
  assert.equal(workflow.budgets.roleCalls, 12);
  assert.equal(workflow.budgets.roleRepairs, 0);
  assert.throws(() => reserveRoleAttempt(workflow, { attemptId: "OVER", contextId: "OVERCTX", role: "critic", inputRevision: digest("over"), planRevision: digest("plan"), repair: false, startedAt: 1, deadlineAt: 180_001 }), /session-attempt budget exhausted/);

  let repairs = initializeLoop({ id: "repairs", stage: "plan", status: "active" });
  repairs = reserveRoleAttempt(repairs, { attemptId: "BASE", contextId: "BASECTX", role: "critic", inputRevision: digest("base"), planRevision: digest("plan"), repair: false, startedAt: 0, deadlineAt: 180_000 });
  repairs = settleRoleAttempt(repairs, "BASE", "failed", "Invalid initial output.");
  let repairOf = "BASE";
  for (let index = 0; index < 3; index += 1) {
    repairs = reserveRoleAttempt(repairs, { attemptId: `REPAIR${index}`, contextId: `REPAIRCTX${index}`, role: "critic", inputRevision: digest(`repair ${index}`), planRevision: digest("plan"), repair: true, repairOf, startedAt: (index + 1) * 200_000, deadlineAt: (index + 1) * 200_000 + 180_000 });
    repairs = settleRoleAttempt(repairs, `REPAIR${index}`, "failed", "Still invalid.");
    repairOf = `REPAIR${index}`;
  }
  assert.throws(() => reserveRoleAttempt(repairs, { attemptId: "REPAIR4", contextId: "REPAIRCTX4", role: "critic", inputRevision: digest("repair 4"), planRevision: digest("plan"), repair: true, repairOf, startedAt: 800_000, deadlineAt: 980_000 }), /repair budget exhausted/);
});

test("beginPlanRevision binds raw Planner bytes, canonical artifact bytes, artifact revision, and settled attempt", () => fixture(workspace => {
  const workflow = initializeLoop({ id: "wire-binding", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true });
  const payload = { status: "ready", sections: plannerSections(), contract: contractFixture(), resolutions: [] };
  const visibleOutput = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  const decoded = decodePlannerOutput(visibleOutput, workflow);
  const inputRevision = digest("wire-binding Planner bundle");
  const role = roleSuccess(workflow, { role: "planner", inputRevision, outputRevision: digest(visibleOutput) });
  const artifact = {
    path: path.join(workspace, ".solar-workflow", workflow.id, "plan.md"),
    text: decoded.planMarkdown,
    revision: digest(decoded.planMarkdown),
  };
  const options = { plannerReceipt: role.receipt, inputRevision, visibleOutput, resolutions: decoded.resolutions };

  assert.throws(
    () => beginPlanRevision(role.workflow, { ...artifact, text: `${artifact.text}\n`, revision: digest(`${artifact.text}\n`) }, options),
    /artifact bytes do not match the canonical plan/,
  );
  assert.throws(
    () => beginPlanRevision(role.workflow, { ...artifact, revision: digest("forged artifact revision") }, options),
    /artifact revision does not match/,
  );
  assert.throws(
    () => beginPlanRevision(role.workflow, artifact, { ...options, visibleOutput: `${visibleOutput}\n` }),
    /output receipt does not bind/,
  );
  for (const status of ["cancelled", "stale"]) {
    const rejected = {
      ...role.workflow,
      roleAttempts: role.workflow.roleAttempts.map(attempt => attempt.attemptId === role.receipt.attemptId ? { ...attempt, status } : attempt),
    };
    assert.throws(() => beginPlanRevision(rejected, artifact, options), /successfully settled/);
  }

  const accepted = beginPlanRevision(role.workflow, artifact, options);
  assert.equal(accepted.planning.plannerOutputRevision, digest(visibleOutput));
  assert.equal(accepted.plan.text, decoded.planMarkdown);
  assert.equal(accepted.plan.revision, digest(decoded.planMarkdown));
  assert.notEqual(accepted.planning.plannerOutputRevision, accepted.plan.revision);
}));

test("plan reviews keep receipts, findings, resolutions, and revision state separate", () => fixture(workspace => {
  let workflow = initializeLoop({ id: "reviews", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true });
  workflow = beginReviewing(workflow);
  assert.equal(workflow.planning.revisionState, "awaiting_reviews");
  assert.equal(workflow.planning.reviewReceipts.planner.role, "planner");
  assert.deepEqual(workflow.planning.reviewFindings, []);

  const material = [{ id: "ARCH1", severity: "material", summary: "Atomic output replacement is missing.", requiredChange: "Add an atomic replacement action and verification.", planLocations: ["steps.STEP2.actions"] }];
  workflow = appendReview(workflow, "approach_reviewer", { verdict: "revise", findings: material });
  assert.equal(workflow.planning.revisionState, "awaiting_reviews");
  workflow = appendReview(workflow, "critic");
  assert.equal(workflow.status, "revision_required");
  assert.equal(workflow.planning.reviewFindings[0].id, "ARCH1");
  assert.equal(workflow.planning.reviewReceipts.approach_reviewer.contextId === workflow.planning.reviewReceipts.critic.contextId, false);

  const revisedContract = structuredClone(workflow.plan.contract);
  revisedContract.steps[1].actions.push("Replace the final file atomically after validation.");
  const visibleOutput = plannerOutput(revisedContract, [{
    findingId: "ARCH1",
    status: "resolved",
    changedLocations: ["steps.STEP2.actions"],
    explanation: "Added an atomic replacement action to the complete revised plan.",
  }]);
  const decoded = decodePlannerOutput(visibleOutput, workflow);
  const revisedText = decoded.planMarkdown;
  assert.throws(() => validateFindingResolutions([{ version: 1, findingId: "ARCH1", fromPlanRevision: digest("stale"), toPlanRevision: digest(revisedText), status: "resolved", changedLocations: ["steps.STEP2.actions"], explanation: "Added the action." }], workflow.planning.reviewFindings, { fromPlanRevision: workflow.revision, toPlanRevision: digest(revisedText) }), /stale/);

  const inputRevision = digest("revised planner bundle");
  const planner = roleSuccess(workflow, { role: "planner", inputRevision, planRevision: workflow.revision, outputRevision: digest(visibleOutput) });
  const revised = beginPlanRevision(planner.workflow, { path: workflow.plan.path, text: revisedText, revision: digest(revisedText) }, { plannerReceipt: planner.receipt, inputRevision, visibleOutput, resolutions: decoded.resolutions });
  assert.equal(revised.planning.revisionState, "awaiting_reviews");
  assert.deepEqual(revised.planning.findingResolutions.map(item => item.findingId), ["ARCH1"]);
  assert.equal(revised.planning.findingResolutions[0].fromPlanRevision, workflow.revision);
  assert.equal(revised.planning.findingResolutions[0].toPlanRevision, digest(revisedText));
  assert.deepEqual(revised.planning.reviewFindings, []);
  assert.equal(revised.planning.history.length, 1);
}));

test("blocked findings remain active across resume and require a changed resolving revision with exact lineage", () => fixture(workspace => {
  let workflow = beginReviewing(initializeLoop({ id: "blocked-lineage", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true }));
  const finding = {
    id: "BLOCK1",
    severity: "material",
    summary: "The final replacement cannot yet be verified as atomic.",
    requiredChange: "Add and verify an atomic final replacement action.",
    planLocations: ["steps.STEP2.actions"],
  };
  workflow = appendReview(workflow, "approach_reviewer", { verdict: "blocked", findings: [finding] });
  workflow = appendReview(workflow, "critic");
  const firstRevision = workflow.revision;

  const blockedContract = structuredClone(workflow.plan.contract);
  blockedContract.steps[1].actions.push("Record that atomic replacement remains blocked until the required mechanism is identified.");
  const blockedOutput = plannerOutput(blockedContract, [{
    findingId: finding.id,
    status: "blocked",
    changedLocations: [],
    explanation: "The revised plan records the blocker, but cannot yet supply the required atomic replacement mechanism.",
  }]);
  const blockedDecoded = decodePlannerOutput(blockedOutput, workflow);
  const blockedInputRevision = digest("blocked lineage Planner bundle");
  const blockedPlanner = roleSuccess(workflow, { role: "planner", inputRevision: blockedInputRevision, planRevision: firstRevision, outputRevision: digest(blockedOutput) });
  const blocked = beginPlanRevision(
    blockedPlanner.workflow,
    { path: workflow.plan.path, text: blockedDecoded.planMarkdown, revision: digest(blockedDecoded.planMarkdown) },
    { plannerReceipt: blockedPlanner.receipt, inputRevision: blockedInputRevision, visibleOutput: blockedOutput, resolutions: blockedDecoded.resolutions },
  );
  const blockedRevision = blocked.revision;
  assert.notEqual(blockedRevision, firstRevision);
  assert.equal(blocked.status, "revision_required");
  assert.equal(blocked.planning.revisionState, "blocked");
  assert.deepEqual(blocked.planning.reviewFindings, [{ ...finding, role: "approach_reviewer" }]);
  assert.deepEqual(
    blocked.planning.findingResolutions.map(({ findingId, fromPlanRevision, toPlanRevision, status }) => ({ findingId, fromPlanRevision, toPlanRevision, status })),
    [{ findingId: finding.id, fromPlanRevision: firstRevision, toPlanRevision: blockedRevision, status: "blocked" }],
  );

  const blockedPlanningSnapshot = structuredClone(blocked.planning);
  const resumed = resumeLoop({ ...blocked, status: "paused", reason: "The blocked planning obligation awaits an ordinary resume." });
  assert.equal(resumed.status, "active");
  assert.deepEqual(resumed.planning.reviewFindings, blocked.planning.reviewFindings);

  const identicalOutput = plannerOutput(blockedContract, []);
  const identicalInputRevision = digest("identical blocked lineage Planner bundle");
  const identicalPlanner = roleSuccess(resumed, { role: "planner", inputRevision: identicalInputRevision, planRevision: blockedRevision, outputRevision: digest(identicalOutput) });
  assert.throws(
    () => beginPlanRevision(
      identicalPlanner.workflow,
      { path: resumed.plan.path, text: resumed.plan.text, revision: resumed.revision },
      { plannerReceipt: identicalPlanner.receipt, inputRevision: identicalInputRevision, visibleOutput: identicalOutput, resolutions: [] },
    ),
    /review findings require a materially changed full plan/,
  );

  const resolvedContract = structuredClone(blockedContract);
  resolvedContract.steps[1].actions.push("Atomically replace the validated final artifact and verify the exact resulting bytes.");
  const resolvedOutput = plannerOutput(resolvedContract, [{
    findingId: finding.id,
    status: "resolved",
    changedLocations: ["steps.STEP2.actions"],
    explanation: "The complete revised plan now requires both atomic replacement and exact-byte verification.",
  }]);
  const resolvedDecoded = decodePlannerOutput(resolvedOutput, resumed);
  const resolvedInputRevision = digest("resolved lineage Planner bundle");
  const resolvedPlanner = roleSuccess(resumed, { role: "planner", inputRevision: resolvedInputRevision, planRevision: blockedRevision, outputRevision: digest(resolvedOutput) });
  const resolved = beginPlanRevision(
    resolvedPlanner.workflow,
    { path: resumed.plan.path, text: resolvedDecoded.planMarkdown, revision: digest(resolvedDecoded.planMarkdown) },
    { plannerReceipt: resolvedPlanner.receipt, inputRevision: resolvedInputRevision, visibleOutput: resolvedOutput, resolutions: resolvedDecoded.resolutions },
  );
  assert.notEqual(resolved.revision, blockedRevision);
  assert.equal(resolved.planning.revisionState, "awaiting_reviews");
  assert.deepEqual(resolved.planning.reviewFindings, []);
  assert.deepEqual(
    resolved.planning.findingResolutions.map(({ findingId, fromPlanRevision, toPlanRevision, status }) => ({ findingId, fromPlanRevision, toPlanRevision, status })),
    [{ findingId: finding.id, fromPlanRevision: blockedRevision, toPlanRevision: resolved.revision, status: "resolved" }],
  );
  assert.deepEqual(
    resolved.planning.history.at(-1).findingResolutions.map(({ findingId, fromPlanRevision, toPlanRevision, status }) => ({ findingId, fromPlanRevision, toPlanRevision, status })),
    [{ findingId: finding.id, fromPlanRevision: firstRevision, toPlanRevision: blockedRevision, status: "blocked" }],
  );
  assert.deepEqual(resolved.planning.history.at(-1).reviewFindings, [{ ...finding, role: "approach_reviewer" }]);
  assert.deepEqual(blocked.planning, blockedPlanningSnapshot);
}));

test("beginPlanRevision rejects a forged resolution that differs from the raw Planner mapping", () => fixture(workspace => {
  let workflow = beginReviewing(initializeLoop({ id: "resolution-binding", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true }));
  workflow = appendReview(workflow, "approach_reviewer", {
    verdict: "revise",
    findings: [{
      id: "ARCH1",
      severity: "material",
      summary: "The final replacement is not atomic.",
      requiredChange: "Add an atomic replacement action.",
      planLocations: ["steps.STEP2.actions"],
    }],
  });
  workflow = appendReview(workflow, "critic");

  const contract = structuredClone(workflow.plan.contract);
  contract.steps[1].actions.push("Atomically replace the validated final artifact.");
  const visibleOutput = plannerOutput(contract, [{
    findingId: "ARCH1",
    status: "resolved",
    changedLocations: ["steps.STEP2.actions"],
    explanation: "The revised action now requires atomic replacement.",
  }]);
  const decoded = decodePlannerOutput(visibleOutput, workflow);
  const inputRevision = digest("resolution-binding Planner bundle");
  const role = roleSuccess(workflow, { role: "planner", inputRevision, planRevision: workflow.revision, outputRevision: digest(visibleOutput) });
  const artifact = { path: workflow.plan.path, text: decoded.planMarkdown, revision: digest(decoded.planMarkdown) };
  const forged = decoded.resolutions.map(resolution => ({ ...resolution, explanation: "A different but structurally valid explanation." }));
  assert.throws(
    () => beginPlanRevision(role.workflow, artifact, { plannerReceipt: role.receipt, inputRevision, visibleOutput, resolutions: forged }),
    /do not match the mappings derived from the exact visible Planner output/,
  );
}));

test("a Critic material finding forces a full revision and both fresh re-reviews", () => fixture(workspace => {
  let workflow = beginReviewing(initializeLoop({ id: "critic-revision", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true }));
  workflow = appendReview(workflow, "approach_reviewer");
  workflow = appendReview(workflow, "critic", {
    verdict: "revise",
    findings: [{
      id: "CRIT1",
      severity: "material",
      summary: "The final acceptance condition is ambiguous.",
      requiredChange: "Make the final gate's observable passing condition explicit.",
      planLocations: ["gates.GATE2.pass"],
    }],
  });
  assert.equal(workflow.status, "revision_required");
  assert.equal(workflow.planning.reviewFindings[0].role, "critic");
  const firstContexts = new Set(workflow.roleAttempts.map(attempt => attempt.contextId));

  const revisedContract = structuredClone(workflow.plan.contract);
  revisedContract.gates[1].pass = "Outcome 2 exists, matches the current approved bytes, and satisfies its exact requirement.";
  const visibleOutput = plannerOutput(revisedContract, [{
    findingId: "CRIT1",
    status: "resolved",
    changedLocations: ["gates.GATE2.pass"],
    explanation: "The complete revised plan now states the exact final-byte acceptance condition.",
  }]);
  const decoded = decodePlannerOutput(visibleOutput, workflow);
  const revisedText = decoded.planMarkdown;
  const inputRevision = digest("critic revision planner bundle");
  const planner = roleSuccess(workflow, { role: "planner", inputRevision, planRevision: workflow.revision, outputRevision: digest(visibleOutput) });
  let revised = beginPlanRevision(planner.workflow, { path: workflow.plan.path, text: revisedText, revision: digest(revisedText) }, { plannerReceipt: planner.receipt, inputRevision, visibleOutput, resolutions: decoded.resolutions });
  revised = appendReview(revised, "approach_reviewer");
  revised = appendReview(revised, "critic");
  assert.equal(revised.planning.revisionState, "ready_to_complete");
  assert.equal(revised.planning.reviews.approach_reviewer.planRevision, revised.revision);
  assert.equal(revised.planning.reviews.critic.planRevision, revised.revision);
  const allContexts = revised.roleAttempts.map(attempt => attempt.contextId);
  assert.equal(new Set(allContexts).size, 6);
  assert.ok(allContexts.slice(3).every(contextId => !firstContexts.has(contextId)));
}));

test("cross-role finding ID collisions fail closed before one resolution can satisfy both", () => fixture(workspace => {
  let workflow = beginReviewing(initializeLoop({ id: "finding-collision", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true }));
  const approachFinding = {
    id: "SHARED1",
    severity: "material",
    summary: "The write approach is not atomic.",
    requiredChange: "Add an atomic replacement action.",
    planLocations: ["steps.STEP2.actions"],
  };
  workflow = appendReview(workflow, "approach_reviewer", { verdict: "revise", findings: [approachFinding] });
  const criticFinding = {
    id: "SHARED1",
    severity: "material",
    summary: "The human acceptance boundary is incomplete.",
    requiredChange: "Bind acceptance to all final and evidence bytes.",
    planLocations: ["gates.GATE2.pass"],
  };
  assert.throws(
    () => appendReview(workflow, "critic", { verdict: "revise", findings: [criticFinding] }),
    /Finding IDs must be unique across both current reviewers/,
  );
  assert.equal(workflow.planning.reviews.critic, undefined);
  assert.deepEqual(workflow.planning.reviewFindings.map(finding => [finding.role, finding.id]), [["approach_reviewer", "SHARED1"]]);

  const collidingFindings = [
    workflow.planning.reviewFindings[0],
    { ...criticFinding, role: "critic" },
  ];
  const resolution = {
    version: 1,
    findingId: "SHARED1",
    fromPlanRevision: workflow.revision,
    toPlanRevision: digest("candidate revision"),
    status: "resolved",
    changedLocations: ["steps.STEP2.actions"],
    explanation: "This changes only the approach finding's location.",
  };
  const expectation = { fromPlanRevision: workflow.revision, toPlanRevision: digest("candidate revision") };
  assert.throws(() => validateFindingResolutions([resolution], collidingFindings, expectation), /Map every current review finding/);
  assert.throws(() => validateFindingResolutions([resolution, structuredClone(resolution)], collidingFindings, expectation), /unknown or duplicate current finding/);
}));

test("validateCurrentPlanReview is pure and enforces current reviewer authority", () => fixture(workspace => {
  const workflow = beginReviewing(initializeLoop({ id: "pure-review-validation", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true }));
  const review = reviewFixture(workflow, "approach_reviewer");
  const workflowSnapshot = structuredClone(workflow);
  const reviewSnapshot = structuredClone(review);
  assert.deepEqual(validateCurrentPlanReview(workflow, review, "approach_reviewer"), review);
  assert.deepEqual(workflow, workflowSnapshot);
  assert.deepEqual(review, reviewSnapshot);

  assert.throws(() => validateCurrentPlanReview({ ...workflow, status: "revision_required" }, review, "approach_reviewer"), /No current plan revision is accepting isolated reviews/);
  assert.throws(() => validateCurrentPlanReview(workflow, review, "critic"), /version\/role does not match/);
  assert.throws(() => validateCurrentPlanReview(workflow, review, "planner"), /Validate only an Approach Reviewer or Critic/);
  assert.throws(() => validateCurrentPlanReview(workflow, { ...review, planRevision: digest("stale review") }, "approach_reviewer"), /stale/);
  assert.throws(() => validateCurrentPlanReview(workflow, { ...review, domain: "research" }, "approach_reviewer"), /domain does not match/);
  assert.throws(() => validateCurrentPlanReview(workflow, { ...review, requirementCoverage: [] }, "approach_reviewer"), /assess every current requirement/);

  const finding = {
    id: "DUPLICATE1",
    severity: "material",
    summary: "The replacement action is not atomic.",
    requiredChange: "Require an atomic replacement action.",
    planLocations: ["steps.STEP2.actions"],
  };
  const withApproachReview = appendReview(workflow, "approach_reviewer", { verdict: "revise", findings: [finding] });
  const reviewedSnapshot = structuredClone(withApproachReview);
  assert.throws(() => validateCurrentPlanReview(withApproachReview, reviewFixture(withApproachReview, "approach_reviewer"), "approach_reviewer"), /already reviewed/);
  const collidingCritic = reviewFixture(withApproachReview, "critic", { verdict: "revise", findings: [{ ...finding }] });
  assert.throws(() => validateCurrentPlanReview(withApproachReview, collidingCritic, "critic"), /Finding IDs must be unique across both current reviewers/);
  assert.deepEqual(withApproachReview, reviewedSnapshot);
}));

test("matching current reviews pass while stale/mismatched reviews and shared contexts fail", () => fixture(workspace => {
  let workflow = beginReviewing(initializeLoop({ id: "matching", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true }));
  const stale = reviewFixture(workflow, "approach_reviewer", { planRevision: digest("stale") });
  assert.throws(() => validatePlanReview(stale, { role: "approach_reviewer", planRevision: workflow.revision, contract: workflow.plan.contract }), /stale/);
  const exactReview = reviewFixture(workflow, "approach_reviewer");
  const exactOutput = JSON.stringify(exactReview);
  const exactInput = digest(`exact visible output ${workflow.revision}`);
  const exactRun = roleSuccess(workflow, { role: "approach_reviewer", inputRevision: exactInput, planRevision: workflow.revision, outputRevision: digest(exactOutput) });
  assert.throws(() => recordPlanReview(exactRun.workflow, exactReview, exactRun.receipt, exactInput, `${exactOutput}\n`), /output receipt does not bind/);

  workflow = appendReview(workflow, "approach_reviewer");
  const sharedContext = workflow.planning.reviewReceipts.approach_reviewer.contextId;
  assert.throws(() => appendReview(workflow, "critic", {}, { contextId: sharedContext }), /unique|distinct fresh context/);
  workflow = appendReview(workflow, "critic");
  assert.equal(workflow.planning.revisionState, "ready_to_complete");
  const reviewed = completePlanReview(workflow, { alignment: "Current requirements and gates match.", conflicts: [] });
  assert.equal(reviewed.status, "awaiting_gate_review");
}));

test("research plans require methodology/evidence/structure approach review focus", () => fixture(workspace => {
  const workflow = beginReviewing(initializeLoop({ id: "research-plan", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: false }), contractFixture(1, "research"));
  const wrong = reviewFixture(workflow, "approach_reviewer", { assessment: { focus: "software_architecture_feasibility", analysis: "Wrong domain focus." } });
  assert.throws(() => validatePlanReview(wrong, { role: "approach_reviewer", planRevision: workflow.revision, contract: workflow.plan.contract }), /research_methodology_evidence_structure/);
  const correct = reviewFixture(workflow, "approach_reviewer");
  assert.equal(validatePlanReview(correct, { role: "approach_reviewer", planRevision: workflow.revision, contract: workflow.plan.contract }).assessment.focus, "research_methodology_evidence_structure");
}));

test("reviewed planning-only completes without an approval token or execute path", () => fixture(workspace => {
  const base = initializeLoop({ id: "plan-only", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: false });
  const complete = fullyReviewed(base);
  assert.equal(complete.status, "planning_complete");
  assert.equal(complete.stage, "plan");
  assert.equal(complete.approval, undefined);
  assert.equal("approvalToken" in complete, false);
  assert.match(complete.reason, /No execution approval token/);
  assert.throws(() => approveGateReview(complete, complete.revision.slice(0, 12), diskPlan(complete)), /No fully reviewed executable plan/);
}));

test("human approval binds the exact reviewed plan and artifact table", () => fixture(workspace => {
  const reviewed = fullyReviewed(initializeLoop({ id: "approval", stage: "plan", status: "active", cwd: workspace, workspaceId: workspaceIdentity(workspace), autoExecute: true }));
  const token = reviewed.revision.slice(0, 12);
  assert.throws(() => approveGateReview(reviewed, "wrong-token", diskPlan(reviewed)), /exact current reviewed revision/);
  assert.throws(() => approveGateReview(reviewed, token, { ...diskPlan(reviewed), text: `${reviewed.plan.text}\nchanged`, revision: digest(`${reviewed.plan.text}\nchanged`) }), /changed after review/);
  const approved = approveGateReview(reviewed, token, diskPlan(reviewed));
  assert.equal(approved.approval, reviewed.revision);
  assert.equal(approved.approvalArtifactTableRevision, reviewed.artifactTableRevision);
}));

test("descriptor rebinding invalidates checkpoints and authority while preserving bytes and history", () => fixture(workspace => {
  const completed = checkpointAll(executionWorkflow(workspace));
  const oldSnapshots = structuredClone(completed.snapshots);
  const oldHistory = structuredClone(completed.history);
  const changed = structuredClone(completed.plan.contract);
  changed.artifacts[1].path = "renamed-final.txt";
  changed.capabilities.find(capability => capability.id === "WRITE2").paths = ["renamed-final.txt"];
  const coverage = changed.selfCheck.artifactCoverage.find(item => item.artifactId === "ART2");
  coverage.explanation = "The rebound final path remains explicitly produced and checked.";
  const planning = { ...completed, stage: "plan", status: "active", approval: undefined, approvalArtifactTableRevision: undefined };
  const revised = beginReviewing(planning, changed);
  assert.equal(revised.artifactDescriptorChanged, true);
  assert.deepEqual(revised.results, {});
  assert.equal(revised.approval, undefined);
  assert.deepEqual(revised.snapshots, oldSnapshots);
  assert.deepEqual(revised.history, oldHistory);
  assert.equal(revised.nonAuthoritativeEvidence.at(-1).reason, "artifact_descriptor_changed");
  assert.equal(nextStep(revised).id, "STEP1");
}));

test("identical descriptors retain only exact hash-matching dependency checkpoints", () => fixture(workspace => {
  const completed = checkpointAll(executionWorkflow(workspace));
  const planning = { ...completed, stage: "plan", status: "active", approval: undefined, approvalArtifactTableRevision: undefined };
  const identical = beginReviewing(planning, structuredClone(completed.plan.contract));
  assert.deepEqual(Object.keys(identical.results), ["STEP1", "STEP2"]);

  writeFileSync(path.join(workspace, "result-1.txt"), "changed after checkpoint");
  const hashChanged = beginReviewing({ ...planning, budgets: { ...planning.budgets, reviewRevisions: 0 }, roleAttempts: [] }, structuredClone(completed.plan.contract));
  assert.deepEqual(hashChanged.results, {});
}));

test("research detours preserve exact lineage and research-only completion stops", () => fixture(workspace => {
  const current = executionWorkflow(workspace, contractFixture(), { stage: "interview", status: "active", approval: undefined, answerHeadId: "ANSWER1", researchPass: 1, returns: [] });
  const detour = revisitWorkflow(current, { stage: "research", gap: "Confirm one local format fact", evidence: "The saved answer and plan lack a source.", gapId: "GAP1", answerHeadId: "ANSWER1", evidenceDigest: digest("starting material evidence") });
  assert.equal(detour.detours.at(-1).target, "research");
  assert.equal(detour.detours.at(-1).answerHeadId, "ANSWER1");
  assert.equal(detour.approval, undefined);
  const artifactText = "validated controller-owned research";
  const detourContract = { version: 2, mode: "detour", outcome: "narrowed", remainingGap: "Narrowed gap" };
  const detourSubmission = { contract: detourContract, contractRevision: structuredRevision(detourContract), materialDigest: digest("new material evidence") };
  assert.throws(() => researchReady(detour, { path: path.join(workspace, "research.md"), relativePath: "research.md", text: artifactText, revision: digest(artifactText) }, detourSubmission), /controller-reserved/);
  const detourArtifact = { path: path.join(workspace, ".solar-workflow", detour.id, "research.md"), relativePath: `.solar-workflow/${detour.id}/research.md`, text: artifactText, revision: digest(artifactText) };
  const returned = researchReady(detour, detourArtifact, detourSubmission);
  assert.equal(returned.stage, "interview");
  assert.equal(returned.detours.at(-1).outcome, "narrowed");
  assert.equal(returned.detours.at(-1).endEvidenceDigest, digest("new material evidence"));

  const researchOnly = initializeLoop({ id: "research-only", stage: "research", status: "active", cwd: workspace, autoInterview: false });
  const researchOnlyArtifact = { path: path.join(workspace, ".solar-workflow", researchOnly.id, "research.md"), relativePath: `.solar-workflow/${researchOnly.id}/research.md`, text: artifactText, revision: digest(artifactText) };
  const initialContract = { version: 2, mode: "initial", outcome: "ready", remainingGap: "None" };
  const stopped = researchReady(researchOnly, researchOnlyArtifact, { contract: initialContract, contractRevision: structuredRevision(initialContract), materialDigest: digest("evidence") });
  assert.equal(stopped.status, "research_complete");
  assert.equal(stopped.stage, "research");
}));

test("repeated materially identical gaps and existing loop bounds stop without losing work", () => fixture(workspace => {
  const base = executionWorkflow(workspace, contractFixture(), { stage: "interview", status: "active", approval: undefined, researchPass: 0 });
  const input = { stage: "research", gap: "Missing local fact", evidence: "No evidence file exists.", gapId: "GAP1", answerHeadId: "ANSWER1", evidenceDigest: digest("same evidence") };
  const first = revisitWorkflow(base, input);
  const closedDetours = first.detours.map(item => ({ ...item, outcome: "blocked", endEvidenceDigest: item.startEvidenceDigest }));
  const repeated = revisitWorkflow({ ...first, stage: "interview", detours: closedDetours }, { ...input, gap: " missing LOCAL fact ", evidence: " no EVIDENCE file exists. " });
  assert.equal(repeated.status, "limited");
  assert.match(repeated.reason, /New IDs, hashes, scores/);
  assert.throws(() => resumeLoop(repeated), /no-progress/);

  const cycleLimited = revisitWorkflow(executionWorkflow(workspace, contractFixture(), { cycle: 3 }), { stage: "plan", gap: "Final checks regressed", evidence: "A command gate failed." });
  assert.equal(cycleLimited.status, "limited");
  assert.equal(cycleLimited.approval, undefined);
  assert.equal(resumeLoop({ ...cycleLimited, limits: { ...cycleLimited.limits, cycles: 4 } }).status, "active");
}));

test("shared authority denies stale approval, later steps, undeclared operations, and final mutation tools", () => fixture(workspace => {
  const current = executionWorkflow(workspace);
  const snapshot = diskPlan(current);
  const stepExpectation = executionExpectation(current, { kind: "step", stepId: "STEP1" });
  assert.doesNotThrow(() => assertExecutionAuthority(current, snapshot, stepExpectation, { tool: "write", access: "write", path: "result-1.txt" }));
  assert.throws(() => assertExecutionAuthority(current, snapshot, { ...stepExpectation, mode: { kind: "step", stepId: "STEP2" } }), /current dependency-ready step/);
  assert.throws(() => assertExecutionAuthority(current, snapshot, stepExpectation, { tool: "write", access: "write", path: "result-2.txt" }), /does not declare/);
  assert.throws(() => requireApprovedPlan({ ...current, approval: digest("stale") }, snapshot, { kind: "step", stepId: "STEP1" }), /approval/);
  assert.throws(() => assertExecutionAuthority(current, { ...snapshot, text: `${snapshot.text}\nchanged`, revision: digest(`${snapshot.text}\nchanged`) }, stepExpectation), /changed on disk/);

  const completed = checkpointAll(current);
  const finalExpectation = executionExpectation(completed, { kind: "final" });
  assert.throws(() => assertExecutionAuthority(completed, diskPlan(completed), finalExpectation, { tool: "write", access: "write", path: "result-2.txt" }), /Final mode never authorizes/);
}));

test("gate-A authority drift blocks gate B and leaves no batch result to commit", () => fixture(async workspace => {
  const completed = checkpointAll(executionWorkflow(workspace));
  const expectation = executionExpectation(completed, { kind: "final" });
  const manifests = {
    before: captureFinalManifest(completed),
    after: captureFinalManifest(completed),
    acceptance: captureAcceptanceManifest(completed),
  };
  const cases = [
    {
      name: "workflow ID",
      mutate: state => { state.fresh = { ...state.fresh, id: "different-workflow" }; },
      error: /expectation is stale/,
    },
    {
      name: "plan revision",
      mutate: state => { state.fresh = { ...state.fresh, revision: digest("different plan revision") }; },
      error: /expectation is stale/,
    },
    {
      name: "disk plan bytes",
      mutate: state => {
        const text = `${state.disk.text}\nchanged during gate A`;
        state.disk = { ...state.disk, text, revision: digest(text) };
      },
      error: /changed on disk/,
    },
    {
      name: "approval",
      mutate: state => { state.fresh = { ...state.fresh, approval: digest("different approval") }; },
      error: /approval/,
    },
    {
      name: "artifact descriptor digest",
      mutate: state => { state.fresh = { ...state.fresh, artifactTableRevision: digest("different descriptor table") }; },
      error: /expectation is stale/,
    },
  ];
  for (const scenario of cases) {
    const state = { fresh: completed, disk: diskPlan(completed) };
    const dispatches = [];
    let returned;
    let committed;
    await assert.rejects(async () => {
      returned = await runGates({
        identifiers: ["GATE1", "GATE2"],
        expectation,
        guard: () => ({ fresh: state.fresh, diskPlan: state.disk }),
        exec: async (_file, args) => {
          dispatches.push(args.at(-1));
          scenario.mutate(state);
          return { code: 0, stdout: `gate A changed ${scenario.name}`, stderr: "" };
        },
      });
      committed = finishVerification(completed, returned, manifests, commitAuthority(completed, { kind: "final" }));
    }, scenario.error, scenario.name);
    assert.equal(dispatches.length, 1, scenario.name);
    assert.match(dispatches[0], /verify outcome 1/, scenario.name);
    assert.equal(returned, undefined, scenario.name);
    assert.equal(committed, undefined, scenario.name);
    assert.equal(completed.finalChecks, undefined, scenario.name);
  }
}));

test("a valid final batch reruns every exact approved command gate under fresh authority", () => fixture(async workspace => {
  const completed = checkpointAll(executionWorkflow(workspace));
  let execCalls = 0;
  let guardCalls = 0;
  const results = await runGates({
    identifiers: ["GATE1", "GATE2"],
    expectation: executionExpectation(completed, { kind: "final" }),
    guard: () => {
      guardCalls += 1;
      return { fresh: completed, diskPlan: diskPlan(completed) };
    },
    exec: async () => {
      execCalls += 1;
      return { code: 0, stdout: "current command passed", stderr: "" };
    },
  });
  assert.equal(execCalls, 2);
  assert.ok(guardCalls >= 10);
  assert.deepEqual(results.map(result => [result.id, result.acceptance, result.passed]), [
    ["GATE1", "current_command", true],
    ["GATE2", "current_command", true],
  ]);
}));

test("guarded gates distinguish current command results from qualitative rubric capture", () => fixture(async workspace => {
  const contract = contractFixture(1);
  contract.artifacts[0].acceptance = "human";
  contract.gates[0].kind = "rubric";
  contract.gates[0].check = "Review source fidelity and reasoning caveats.";
  const completed = checkpointAll(executionWorkflow(workspace, contract));
  let execCalls = 0;
  const results = await runGates({
    identifiers: ["GATE1"],
    expectation: executionExpectation(completed, { kind: "final" }),
    guard: () => ({ fresh: completed, diskPlan: diskPlan(completed) }),
    exec: async () => { execCalls += 1; return { code: 0, stdout: "must not run", stderr: "" }; },
  });
  assert.equal(execCalls, 0);
  assert.equal(results[0].acceptance, "qualitative_human");
  assert.match(results[0].stdout, /not command proof/);
}));

test("step checkpoints require current artifacts, exact gates, and materially changed retry approaches", () => fixture(workspace => {
  const workflow = executionWorkflow(workspace, contractFixture(1));
  writeFileSync(path.join(workspace, "result-1.txt"), "partial output");
  const files = [currentFile(workspace, "ART1", "result-1.txt")];
  const failedGate = gateResult(workspace, workflow.plan.contract, "GATE1", { passed: false, code: 1, stdout: "", stderr: "parse error row 4" });
  const failed = recordStep(workflow, { stepId: "STEP1", summary: "The first approach produced a parse error.", approach: { id: "APPROACH1", description: "Parse and write in one pass." }, files, gates: [failedGate] }, commitAuthority(workflow, { kind: "step", stepId: "STEP1" }));
  assert.equal(failed.results.STEP1.passed, false);
  assert.equal(failed.attempts.STEP1, 1);
  assert.throws(() => validateStepApproach(failed, "STEP1", { id: "NEWID", description: "Parse and write in one pass.", differsFrom: "APPROACH1" }), /new ID alone/);

  const changedGate = { ...failedGate, code: 2, stderr: "validation now reaches atomic replacement" };
  const retry = recordStep(failed, { stepId: "STEP1", summary: "Separated validation from replacement and reached a new diagnostic.", approach: { id: "APPROACH2", description: "Validate every row before a separate atomic replacement.", differsFrom: "APPROACH1" }, files, gates: [changedGate] }, commitAuthority(failed, { kind: "step", stepId: "STEP1" }));
  assert.equal(retry.status, "active");
  assert.equal(retry.results.STEP1.progress.material, true);
  assert.ok(retry.results.STEP1.progress.reasons.some(reason => reason.startsWith("diagnostic_changed")));
}));

test("a distinct repair with IDs-only/no evidence progress pauses with best retained artifacts", () => fixture(workspace => {
  const workflow = executionWorkflow(workspace, contractFixture(1));
  writeFileSync(path.join(workspace, "result-1.txt"), "same partial output");
  const files = [currentFile(workspace, "ART1", "result-1.txt")];
  const gate = gateResult(workspace, workflow.plan.contract, "GATE1", { passed: false, code: 1, stdout: "attempt id 111", stderr: "same failure" });
  const first = recordStep(workflow, { stepId: "STEP1", summary: "Initial failure retained.", approach: { id: "APPROACH1", description: "Write the output directly." }, files, gates: [gate] }, commitAuthority(workflow, { kind: "step", stepId: "STEP1" }));
  const duplicateEvidenceGate = { ...gate, stdout: "attempt id 222" };
  const paused = recordStep(first, { stepId: "STEP1", summary: "Different mechanics did not change evidence.", approach: { id: "APPROACH2", description: "Write a temporary file and replace the output.", differsFrom: "APPROACH1" }, files, gates: [duplicateEvidenceGate] }, commitAuthority(first, { kind: "step", stepId: "STEP1" }));
  assert.equal(paused.status, "paused");
  assert.equal(paused.limitStop.kind, "no_relevant_progress");
  assert.match(paused.reason, /Best retained artifacts: result-1\.txt/);
  assert.equal(paused.bestRecovery.STEP1.files[0].hash, files[0].hash);
}));

test("recovery progress ignores IDs but recognizes gates, diagnostics, and actual output bytes", () => {
  const hash = digest("same");
  const previous = { files: [{ path: "final.txt", hash, bytes: 4 }], gates: [{ id: "GATE1", passed: false, code: 1, stdout: "attempt id 111", stderr: "same failure", errors: [] }] };
  assert.equal(classifyRecoveryProgress(previous, { files: [{ path: "final.txt", hash, bytes: 4 }], gates: [{ id: "GATE1", passed: false, code: 1, stdout: "attempt id 222", stderr: "same failure", errors: [] }] }).material, false);
  assert.equal(classifyRecoveryProgress(previous, { files: [{ path: "final.txt", hash: digest("changed"), bytes: 7 }], gates: previous.gates }).material, true);
  assert.equal(classifyRecoveryProgress(previous, { files: previous.files, gates: [{ ...previous.gates[0], passed: true, code: 0 }] }).material, true);
});

test("successful checkpoints snapshot declared output bytes with a one MiB aggregate cap", () => fixture(workspace => {
  const contract = contractFixture(1);
  contract.artifacts = Array.from({ length: 9 }, (_, index) => ({ id: `ART${index + 1}`, path: `chunk-${index + 1}.bin`, kind: index === 8 ? "final" : "intermediate", acceptance: "command", gates: ["GATE1"] }));
  contract.capabilities[0].paths = contract.artifacts.map(item => item.path);
  contract.steps[0].outputs = contract.artifacts.map(item => item.id);
  contract.gates[0].evidence = contract.artifacts.map(item => item.id);
  contract.selfCheck.artifactCoverage = contract.artifacts.map(item => ({ artifactId: item.id, stepId: "STEP1", gateIds: ["GATE1"], explanation: "One step explicitly produces and checks this chunk." }));
  const workflow = executionWorkflow(workspace, validateExecutionPlan(planText(contract)));
  for (const artifact of contract.artifacts) writeFileSync(path.join(workspace, artifact.path), Buffer.alloc(128 * 1024, 3));
  const files = contract.artifacts.map(item => currentFile(workspace, item.id, item.path));
  const recorded = recordStep(workflow, { stepId: "STEP1", summary: "Captured all declared outputs.", approach: { id: "CHUNKS", description: "Write and hash each bounded declared chunk." }, files, gates: [gateResult(workspace, contract, "GATE1")] }, commitAuthority(workflow, { kind: "step", stepId: "STEP1" }));
  const snapshots = contract.artifacts.map(item => recorded.snapshots[item.path]);
  assert.equal(snapshots.filter(snapshot => "content" in snapshot).length, 8);
  assert.equal(snapshots.reduce((total, snapshot) => total + (snapshot.content ? snapshot.bytes : 0), 0), 1024 * 1024);
}));

test("pre/post final manifests prevent a static report from standing in for changed finals", () => fixture(workspace => {
  const completed = checkpointAll(executionWorkflow(workspace));
  const before = captureFinalManifest(completed);
  const report = path.join(workspace, "verification-report.txt");
  writeFileSync(report, "constant passing report");
  writeFileSync(path.join(workspace, "result-2.txt"), "changed final after the report");
  const after = captureFinalManifest(completed);
  const acceptance = captureAcceptanceManifest(completed);
  const gates = completed.plan.contract.gates.map(gate => gateResult(workspace, completed.plan.contract, gate.id));
  const stale = finishVerification(completed, gates, { before, after, acceptance }, commitAuthority(completed, { kind: "final" }));
  assert.equal(stale.stage, "plan");
  assert.equal(stale.approval, undefined);
  assert.match(stale.gap, /final artifact bytes changed/);
}));

test("current command-only finals auto-complete only with matching manifests", () => fixture(workspace => {
  const completed = checkpointAll(executionWorkflow(workspace));
  const before = captureFinalManifest(completed);
  const gates = completed.plan.contract.gates.map(gate => gateResult(workspace, completed.plan.contract, gate.id));
  const after = captureFinalManifest(completed);
  const acceptance = captureAcceptanceManifest(completed);
  const done = finishVerification(completed, gates, { before, after, acceptance }, commitAuthority(completed, { kind: "final" }));
  assert.equal(done.status, "complete");
  assert.match(done.reason, /current command gates/);
  assert.equal(done.finalManifest.files[0].artifactId, "ART2");
}));

test("human final review rejects an evidence-only mutation after its token", () => fixture(workspace => {
  const contract = contractFixture(1);
  contract.artifacts[0].acceptance = "human";
  contract.gates[0].kind = "rubric";
  contract.gates[0].check = "Review fidelity, reasoning, structure, and caveats.";
  contract.artifacts.push({ id: "EVIDENCE1", path: "review-evidence.txt", kind: "evidence", acceptance: "none", gates: ["GATE1"] });
  contract.capabilities[0].paths.push("review-evidence.txt");
  contract.steps[0].outputs.push("EVIDENCE1");
  contract.gates[0].evidence.push("EVIDENCE1");
  contract.selfCheck.artifactCoverage.push({ artifactId: "EVIDENCE1", stepId: "STEP1", gateIds: ["GATE1"], explanation: "The final step produces distinct qualitative-review evidence and binds it to the rubric." });
  const validated = validateExecutionPlan(planText(contract));
  const completed = checkpointAll(executionWorkflow(workspace, validated));
  const before = captureFinalManifest(completed);
  const gates = [gateResult(workspace, validated, "GATE1")];
  const after = captureFinalManifest(completed);
  const acceptance = captureAcceptanceManifest(completed);
  const awaiting = finishVerification(completed, gates, { before, after, acceptance }, commitAuthority(completed, { kind: "final" }));
  assert.equal(awaiting.status, "awaiting_final_review");
  const token = awaiting.finalReview.slice(0, 12);
  const finalAtToken = captureFinalManifest(awaiting);
  writeFileSync(path.join(workspace, "review-evidence.txt"), "changed evidence after human token");
  assert.deepEqual(captureFinalManifest(awaiting), finalAtToken);
  const current = captureAcceptanceManifest(awaiting);
  assert.throws(() => acceptFinalReview(awaiting, token, current, diskPlan(awaiting)), /changed after final checks/);
  assert.equal(awaiting.status, "awaiting_final_review");
  assert.throws(() => acceptFinalReview(awaiting, "stale-token", acceptance, diskPlan(awaiting)), /exact current final-review token/);
}));

test("final gate failure returns to planning and discards approval while retaining manifests", () => fixture(workspace => {
  const completed = checkpointAll(executionWorkflow(workspace));
  const before = captureFinalManifest(completed);
  const after = captureFinalManifest(completed);
  const acceptance = captureAcceptanceManifest(completed);
  const gates = completed.plan.contract.gates.map(gate => gateResult(workspace, completed.plan.contract, gate.id));
  gates[0] = { ...gates[0], passed: false, code: 2, stderr: "regression" };
  const regressed = finishVerification(completed, gates, { before, after, acceptance }, commitAuthority(completed, { kind: "final" }));
  assert.equal(regressed.stage, "plan");
  assert.equal(regressed.status, "active");
  assert.equal(regressed.approval, undefined);
  assert.deepEqual(regressed.finalChecks.map(gate => gate.id), ["GATE1", "GATE2"]);
  assert.equal(regressed.finalManifest.planRevision, completed.revision);
}));
