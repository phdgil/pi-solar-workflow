import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  expectedFixtureOutput,
  fixtureManifest,
  getHarnessFixture,
  gradeHarnessResult,
  listHarnessFixtures,
  sha256Text,
  validateFixtureGoal,
  validateSyntheticApproval,
} from "../scripts/harness-fixtures.mjs";
import {
  auditObservedOperations,
  boundedRunTimeout,
  experimentProtocolReceipt,
  parseHarnessArguments,
  reconcileHostApproval,
  RpcClient,
  runFixtureFlow,
  runStatus,
  summarizeObservedMetrics,
} from "../scripts/harness-experiment.mjs";

const FRESH_HELD_OUT_CASES = [
  "execute-module-alias-heldout",
  "execute-access-matrix-heldout",
];

function validExecuteContract(caseName = "execute-summary") {
  const fixture = getHarnessFixture(caseName);
  const output = fixture.outputPaths[0];
  return {
    version: 3,
    domain: "software",
    requirements: [{ id: "R1", description: "Produce the exact fixture result.", source: "Confirmed synthetic request." }],
    artifacts: [
      ...fixture.allowedReadPaths.map((file, index) => ({ id: `I${index + 1}`, path: file, kind: "evidence", acceptance: "none", gates: [] })),
      { id: "A1", path: output, kind: "final", acceptance: "command", gates: ["G1"] },
    ],
    capabilities: [
      { id: "C1", kind: "read", tool: "read", paths: fixture.allowedReadPaths, commands: [] },
      { id: "C2", kind: "write", tool: "write", paths: [output], commands: [] },
    ],
    steps: [{
      id: "S1",
      title: "Create the fixture result",
      feasibility: "The named files and tools are available.",
      inputs: fixture.allowedReadPaths.map((_file, index) => `I${index + 1}`),
      outputs: ["A1"],
      actions: ["Read the immutable inputs and write the one declared output."],
      dependsOn: [],
      requires: ["R1"],
      gates: ["G1"],
      capabilities: ["C1", "C2"],
    }],
    gates: [{ id: "G1", kind: "command", check: fixture.evaluatorCommand, pass: "The evaluator exits zero.", evidence: ["A1"] }],
    selfCheck: {
      review: "The single bounded output is checked by the supplied evaluator.",
      requirementCoverage: [{ requirementId: "R1", stepIds: ["S1"], gateIds: ["G1"], explanation: "S1 produces and G1 checks the result." }],
      artifactCoverage: [{ artifactId: "A1", stepId: "S1", gateIds: ["G1"], explanation: "S1 is the sole producer." }],
      unresolved: [],
    },
  };
}

test("campaign deadline bounds each repeat and reserves shutdown time", () => {
  const deadline = "2026-09-21T04:11:29.631Z";
  const end = Date.parse(deadline);
  assert.equal(boundedRunTimeout(1_200_000, deadline, end - 2_000_000), 1_200_000);
  assert.equal(boundedRunTimeout(1_200_000, deadline, end - 90_000), 60_000);
  assert.equal(boundedRunTimeout(1_200_000, deadline, end - 30_000), null);
  assert.equal(boundedRunTimeout(1_200_000, deadline, end + 1), null);
  assert.throws(() => boundedRunTimeout(1_200_000, "not-a-date"), /UTC ISO/);
  const args = ["--checkout", ".", "--label", "bounded", "--output", "out", "--case", "research-local"];
  assert.equal(parseHarnessArguments([...args, "--deadline-at", deadline]).deadlineAt, deadline);
  assert.throws(() => parseHarnessArguments([...args, "--deadline-at", "2026-09-21"]), /UTC ISO/);
  assert.throws(() => parseHarnessArguments([...args, "--deadline-at", deadline, "--deadline-at", deadline]), /only once/);
});

test("role deadline receipts do not establish intrinsic provider failure", () => {
  const interruptions = [{ source: "role_attempt", stopReason: "timed_out" }, { source: "role_attempt", stopReason: "cancelled" }];
  assert.deepEqual(runStatus({ passed: false }, {}, null, interruptions, { status: "paused" }),
    { status: "failed", reason: "role_session_interrupted" });
  assert.equal(runStatus({ passed: false }, {}, null,
    [...interruptions, { source: "assistant_entry", stopReason: "error" }], {}).reason, "provider_failure");
  assert.equal(runStatus({ passed: true }, {}, null, [], {}).status, "completed");
});

function fileSnapshots(caseName, outputContent) {
  const fixture = getHarnessFixture(caseName);
  const before = Object.fromEntries(Object.entries(fixture.files).map(([file, content]) => [file, { type: "file", bytes: Buffer.byteLength(content), sha256: sha256Text(content) }]));
  const after = structuredClone(before);
  if (outputContent !== undefined) {
    after[fixture.outputPaths[0]] = { type: "file", bytes: Buffer.byteLength(outputContent), sha256: sha256Text(outputContent) };
  }
  return { before, after };
}

function roleReceipts() {
  return Object.fromEntries(["planner", "approach_reviewer", "critic"].map((role, index) => [role, {
    role,
    attemptId: `attempt-${index}`,
    contextId: `context-${index}`,
    provider: "upstage",
    modelId: "solar-pro4",
    outputRevision: "a".repeat(64),
  }]));
}

function canonicalTestValue(value) {
  if (Array.isArray(value)) return value.map(canonicalTestValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalTestValue(child)]));
  }
  return value;
}

function canonicalTestDigest(value) {
  return sha256Text(JSON.stringify(canonicalTestValue(value)));
}

function artifactTableReceipt(contract) {
  return canonicalTestDigest(contract.artifacts.map(artifact => ({
    id: artifact.id,
    path: artifact.path,
    kind: artifact.kind,
    acceptance: artifact.acceptance,
    gates: [...artifact.gates].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id)));
}

function eligibleFixtureReceipt(contract, caseName) {
  const validation = validateSyntheticApproval(contract, caseName);
  return {
    safe: validation.safe,
    eligible: validation.approved,
    decision: validation.approved ? "eligible_synthetic_fixture" : "ineligible_synthetic_fixture",
    policyDecision: validation.decision,
    caseName: validation.caseName,
    evaluatorCommand: validation.evaluatorCommand,
    violations: [...validation.violations],
  };
}

function acceptedHostApprovalReceipt(eligibility, workflow, eventIndex = 0) {
  const flow = {
    approvalEligibility: eligibility,
    approvalRequest: {
      workflowId: workflow.id,
      planRevision: workflow.revision,
      artifactTableRevision: workflow.artifactTableRevision,
      entryWatermark: "entry-before-approval",
      eventIndex,
      command: `/solar-workflow approve ${workflow.revision.slice(0, 12)}`,
      dispatched: true,
      rpcRequestId: "harness-synthetic-approval",
    },
    approval: null,
    approvalBoundaryEventIndex: null,
  };
  reconcileHostApproval(flow, {
    since: flow.approvalRequest.entryWatermark,
    entries: [{
      type: "custom",
      customType: "solar-workflow-state-v1",
      id: "entry-host-grant",
      data: { ...structuredClone(workflow), stage: "execute", status: "active" },
    }],
    leafId: "entry-host-grant",
  });
  return flow.approval;
}

function refreshFinalReview(observation) {
  const workflow = observation.workflow;
  workflow.finalReview = canonicalTestDigest({
    planRevision: workflow.revision,
    artifactTableRevision: workflow.artifactTableRevision,
    finalChecks: workflow.finalChecks,
    finalManifest: workflow.finalManifest,
  });
}

function syntheticPlanText(contract) {
  return [
    "# Synthetic reviewed plan",
    "",
    "## Execution contract",
    "```json",
    JSON.stringify(contract, null, 2),
    "```",
    "",
  ].join("\n");
}

function syntheticWorkspaceIdentity(cwd) {
  const normalized = path.resolve(cwd).replaceAll("\\", "/").replace(/\/$/u, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function rebindCompletedPlan(observation, planText) {
  const workflow = observation.workflow;
  workflow.plan.text = planText;
  workflow.revision = sha256Text(planText);
  workflow.plan.revision = workflow.revision;
  observation.afterFiles[workflow.plan.relativePath] = {
    type: "file",
    bytes: Buffer.byteLength(planText),
    sha256: workflow.revision,
  };
  workflow.artifactTableRevision = artifactTableReceipt(workflow.plan.contract);
  workflow.approval = workflow.revision;
  workflow.approvalArtifactTableRevision = workflow.artifactTableRevision;
  workflow.planning.reviewedAtRevision = workflow.revision;
  for (const manifest of [workflow.finalManifestBefore, workflow.finalManifest, workflow.acceptanceManifest]) {
    manifest.planRevision = workflow.revision;
    manifest.artifactTableRevision = workflow.artifactTableRevision;
  }
  refreshFinalReview(observation);
}

function evaluateFixtureOutput(caseName, output) {
  const fixture = getHarnessFixture(caseName);
  const workspace = mkdtempSync(path.join(os.tmpdir(), "solar-fixture-oracle-"));
  try {
    for (const [file, content] of Object.entries(fixture.files)) writeFileSync(path.join(workspace, file), content, "utf8");
    writeFileSync(path.join(workspace, fixture.outputPaths[0]), `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return spawnSync(process.execPath, ["evaluator.mjs"], { cwd: workspace, encoding: "utf8" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function completedExecuteObservation(caseName, output) {
  const fixture = getHarnessFixture(caseName);
  const outputPath = fixture.outputPaths[0];
  const inputPath = fixture.allowedReadPaths.find(file => file !== "evaluator.mjs");
  const raw = `${JSON.stringify(output, null, 2)}\n`;
  const snapshots = fileSnapshots(caseName, raw);
  const contract = validExecuteContract(caseName);
  const planText = syntheticPlanText(contract);
  const revision = sha256Text(planText);
  const artifactTableRevision = artifactTableReceipt(contract);
  const workflowId = `synthetic-${caseName}`;
  const cwd = path.resolve(os.tmpdir(), "solar-harness-synthetic-workspace");
  const workspaceId = syntheticWorkspaceIdentity(cwd);
  const planRelativePath = `.solar-workflow/${workflowId}/plan.md`;
  const planPath = path.join(cwd, ...planRelativePath.split("/"));
  snapshots.after[planRelativePath] = { type: "file", bytes: Buffer.byteLength(planText), sha256: revision };
  const receiptFor = artifact => {
    const observed = snapshots.after[artifact.path];
    return { artifactId: artifact.id, path: artifact.path, hash: observed.sha256, bytes: observed.bytes };
  };
  const manifest = kinds => ({
    planRevision: revision,
    artifactTableRevision,
    kinds: [...kinds].sort(),
    files: contract.artifacts.filter(artifact => kinds.includes(artifact.kind)).sort((left, right) => left.id.localeCompare(right.id)).map(receiptFor),
  });
  const finalManifest = manifest(["final"]);
  const acceptanceManifest = manifest(["evidence", "final"]);
  const finalChecks = contract.gates.map(gate => ({
    id: gate.id,
    kind: "command",
    acceptance: "current_command",
    passed: true,
    code: 0,
    killed: false,
    stdout: "fixture evaluator passed\n",
    stderr: "",
    errors: [],
    files: gate.evidence.map(artifactId => receiptFor(contract.artifacts.find(artifact => artifact.id === artifactId))),
  }));
  const observation = {
    preflight: { passed: true },
    process: { exitCode: 0, signal: null },
    providerFailures: [],
    events: [],
    entries: [{
      type: "custom",
      customType: "solar-interview-closure-v2",
      data: { mode: "normal", completionAuthority: "user_confirmation", confirmedGoal: { sentence: `Read ${inputPath} and create only JSON ${outputPath}.` } },
    }],
    workflow: {
      id: workflowId,
      version: 3,
      stage: "execute",
      status: "complete",
      cwd,
      workspaceId,
      revision,
      artifactTableRevision,
      plan: {
        path: planPath,
        relativePath: planRelativePath,
        text: planText,
        revision,
        workspaceId,
        contract: structuredClone(contract),
      },
      planning: { revisionState: "reviewed", reviewedAtRevision: revision, reviewReceipts: roleReceipts() },
      approval: revision,
      approvalArtifactTableRevision: artifactTableRevision,
      results: Object.fromEntries(contract.steps.map(step => [step.id, { step: step.id, passed: true }])),
      finalChecks,
      finalManifestBefore: structuredClone(finalManifest),
      finalManifest,
      acceptanceManifest,
    },
    beforeFiles: snapshots.before,
    afterFiles: snapshots.after,
    outputContents: { [outputPath]: raw },
    operationAudit: { approvalEventIndex: 0, unauthorized: [], preApprovalMutations: [] },
    planContract: structuredClone(contract),
  };
  observation.approvalEligibility = eligibleFixtureReceipt(contract, caseName);
  observation.approval = acceptedHostApprovalReceipt(observation.approvalEligibility, observation.workflow);
  refreshFinalReview(observation);
  return observation;
}

test("fixture catalog contains five development cases and two post-C16 fresh held-out cases", () => {
  const listed = listHarnessFixtures();
  assert.deepEqual(listed.map(item => item.name), [
    "research-local",
    "interview-correction",
    "plan-software",
    "execute-summary",
    "execute-inventory-heldout",
    ...FRESH_HELD_OUT_CASES,
  ]);
  const inventory = listed.find(item => item.name === "execute-inventory-heldout");
  assert.equal(inventory.heldOut, false);
  assert.match(inventory.description, /prior campaign; retained as development-only/u);
  assert.match(getHarnessFixture(inventory.name).initialPrompt, /synthetic development fixture/u);
  assert.deepEqual(listed.filter(item => item.heldOut).map(item => item.name), FRESH_HELD_OUT_CASES);

  const executeCases = ["execute-summary", "execute-inventory-heldout", ...FRESH_HELD_OUT_CASES];
  assert.equal(new Set(executeCases.map(name => JSON.stringify(expectedFixtureOutput(name)))).size, executeCases.length);
  assert.equal(new Set(executeCases.map(name => fixtureManifest(name).fixtureSha256)).size, executeCases.length);
});

test("the specification-only interview states its zero-filesystem authority", () => {
  const fixture = getHarnessFixture("interview-correction");
  assert.deepEqual(fixture.files, {});
  assert.deepEqual(fixture.allowedReadPaths, []);
  assert.match(fixture.initialPrompt, /no filesystem reads or writes are authorized/u);
  assert.match(fixture.initialPrompt, /prospective names, not existing files to inspect/u);
  assert.equal(fixtureManifest(fixture.name).initialPrompt, fixture.initialPrompt);
  const workspace = process.platform === "win32" ? "C:\\fixture" : "/fixture";
  const audit = auditObservedOperations(
    ["records.json", ".pi/state/interview.json"].map(file => ({ type: "tool_execution_start", toolName: "read", args: { path: file } })),
    { fixture: fixture.name, workspace, approvalEventIndex: null },
  );
  assert.equal(audit.unauthorized.length, 2);
  assert.ok(audit.unauthorized.every(operation => operation.reason === "read_outside_fixture"));
});

test("execution requests explicitly state the domain enforced by the unchanged approval guard", () => {
  for (const { name, kind } of listHarnessFixtures()) {
    if (kind !== "execute") continue;
    const fixture = getHarnessFixture(name);
    assert.match(fixture.initialPrompt, /ExecutionContractV3 domain software/u);
    assert.equal(fixtureManifest(name).initialPrompt, fixture.initialPrompt);
    assert.equal(getHarnessFixture(name).initialPrompt, fixture.initialPrompt);
    const contract = validExecuteContract(name);
    assert.equal(validateSyntheticApproval(contract, name).approved, true);
    contract.domain = "research";
    const rejected = validateSyntheticApproval(contract, name);
    assert.equal(rejected.approved, false);
    assert.ok(rejected.violations.includes("not_validated_software_v3_contract"));
  }
});

test("runner argument parsing is import-safe and applies bounded defaults", () => {
  const options = parseHarnessArguments(["--checkout", "checkout", "--label", "candidate", "--output", "out", "--case", "research-local"]);
  assert.equal(options.repeat, 1);
  assert.equal(options.timeoutMs, 600_000);
  assert.deepEqual(options.exactArgs, ["--checkout", "checkout", "--label", "candidate", "--output", "out", "--case", "research-local"]);
  assert.equal(parseHarnessArguments(["--list"]).list, true);
  assert.throws(() => parseHarnessArguments(["--checkout", "x", "--label", "x", "--output", "x", "--case", "unknown"]), /Unknown --case/u);
  assert.throws(() => parseHarnessArguments(["--checkout", "x", "--label", "x", "--output", "x", "--case", "research-local", "--repeat", "0"]), /positive integer|between/u);
});

test("synthetic approval accepts only the exact allowlisted local authority", () => {
  const decision = validateSyntheticApproval(validExecuteContract(), "execute-summary");
  assert.equal(decision.approved, true);
  assert.equal(decision.decision, "approved_synthetic_fixture");
  assert.deepEqual(decision.violations, []);

  const nonExecute = validateSyntheticApproval(validExecuteContract(), "plan-software");
  assert.equal(nonExecute.approved, false);
  assert.ok(nonExecute.violations.includes("case_not_on_synthetic_execute_allowlist"));
});

test("programmatic confirmation rejects drifted paths, format, and mutation scope", () => {
  const exact = validateFixtureGoal("execute-summary", "Read input.json and create only JSON summary.json.");
  assert.equal(exact.accepted, true);
  const drifted = validateFixtureGoal("execute-summary", "Read input.json, install a helper, and publish YAML to report.yaml.");
  assert.equal(drifted.accepted, false);
  assert.ok(drifted.violations.includes("goal_omits_required_path:summary.json"));
  assert.ok(drifted.violations.includes("goal_changes_output_format"));
  assert.ok(drifted.violations.includes("goal_broadens_mutation_scope"));
  assert.ok(drifted.violations.includes("goal_names_path_outside_fixture:report.yaml"));
});

test("explicit prohibitions do not become false unsafe-intent findings", () => {
  const safe = "Read input.json and create JSON summary.json; do not modify input.json or evaluator.mjs; without network access; do not install dependencies.";
  assert.equal(validateFixtureGoal("execute-summary", safe).accepted, true);
  assert.equal(validateFixtureGoal("execute-summary", `${safe} Then publish the output.`).accepted, false);
  assert.equal(validateFixtureGoal("execute-summary", "Read input.json and create JSON summary.json; modify input.json.").accepted, false);
  const contract = validExecuteContract();
  contract.steps[0].actions.push("Do not install dependencies; do not publish results; without network access.");
  assert.equal(validateSyntheticApproval(contract, "execute-summary").approved, true);
  contract.steps[0].actions.push("Do not install dependencies, but publish results.");
  assert.equal(validateSyntheticApproval(contract, "execute-summary").approved, false);
});

test("fresh held-out execute fixtures retain exact JSON confirmation and approval bounds", () => {
  for (const caseName of FRESH_HELD_OUT_CASES) {
    const fixture = getHarnessFixture(caseName);
    const outputPath = fixture.outputPaths[0];
    const inputPath = fixture.allowedReadPaths.find(file => file !== "evaluator.mjs");
    assert.equal(fixture.kind, "execute");
    assert.equal(fixture.heldOut, true);
    assert.deepEqual(fixture.outputPaths, [outputPath]);
    assert.equal(path.extname(outputPath), ".json");
    assert.deepEqual(Object.keys(fixture.files), fixture.allowedReadPaths);
    assert.equal(Object.hasOwn(fixture.files, outputPath), false);
    assert.equal(fixture.evaluatorCommand, "node evaluator.mjs");
    assert.deepEqual(fixture.goalPolicy, { requiredPaths: [inputPath, outputPath], format: "json" });

    const promptMaterial = [fixture.initialPrompt, ...fixture.answers].join("\n");
    assert.equal(promptMaterial.includes(JSON.stringify(expectedFixtureOutput(caseName))), false);
    assert.equal(validateFixtureGoal(caseName, `Read ${inputPath} and create only JSON ${outputPath}.`).accepted, true);
    const drifted = validateFixtureGoal(caseName, `Read ${inputPath}, install a helper, and publish YAML to stray.json.`);
    assert.equal(drifted.accepted, false);
    assert.ok(drifted.violations.includes(`goal_omits_required_path:${outputPath}`));
    assert.ok(drifted.violations.includes("goal_changes_output_format"));
    assert.ok(drifted.violations.includes("goal_broadens_mutation_scope"));
    assert.ok(drifted.violations.includes("goal_names_path_outside_fixture:stray.json"));

    const exact = validateSyntheticApproval(validExecuteContract(caseName), caseName);
    assert.equal(exact.approved, true);
    assert.equal(exact.decision, "approved_synthetic_fixture");
    assert.deepEqual(exact.violations, []);
    const widened = validExecuteContract(caseName);
    widened.capabilities[1].paths.push(inputPath);
    const rejected = validateSyntheticApproval(widened, caseName);
    assert.equal(rejected.approved, false);
    assert.ok(rejected.violations.includes(`write_to_immutable_path:${inputPath}`));
  }
});

test("protocol fingerprint binds the executing driver and independent grader", () => {
  const receipt = experimentProtocolReceipt();
  for (const name of ["harness-experiment.mjs", "harness-fixtures.mjs"]) {
    assert.equal(receipt.fileSha256[name], sha256Text(readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8")));
  }
  assert.match(receipt.protocolSha256, /^[a-f0-9]{64}$/u);
});

test("RPC protocol errors survive absent pending requests and incomplete EOF", async () => {
  const client = Object.assign(Object.create(RpcClient.prototype), {
    protocolError: null, stdoutBuffer: "", rejected: [],
    failPending(error) { this.rejected.push(error); },
  });
  client.consumeLine("not a JSON protocol record");
  assert.match(client.protocolError.message, /non-JSON stdout/);
  await assert.rejects(client.request("get_entries", {}, Date.now() + 100), /non-JSON stdout/);
  const partial = Object.assign(Object.create(RpcClient.prototype), { protocolError: null, stdoutBuffer: '{"type":' });
  partial.finishProtocol();
  assert.match(partial.protocolError.message, /incomplete stdout record/);
});

test("RPC entry cursors are forwarded exactly and unavailable or malformed evidence fails closed", async () => {
  const calls = [];
  const client = Object.assign(Object.create(RpcClient.prototype), {
    async request(type, fields) {
      calls.push({ type, fields });
      return { data: { entries: [{ id: "after-watermark" }], leafId: "after-watermark" } };
    },
  });
  assert.deepEqual(await client.entryPage(Date.now() + 1000, 500, "entry-watermark"), {
    entries: [{ id: "after-watermark" }],
    leafId: "after-watermark",
  });
  assert.deepEqual(calls, [{ type: "get_entries", fields: { since: "entry-watermark" } }]);

  client.request = async () => { throw new Error("Entry not found: entry-watermark"); };
  await assert.rejects(client.entryPage(Date.now() + 1000, 500, "entry-watermark"), /Entry not found/u);
  client.request = async () => ({ data: { entries: null, leafId: 42 } });
  await assert.rejects(client.entryPage(Date.now() + 1000, 500, "entry-watermark"), /malformed cursor receipt/u);
  client.request = async () => ({ data: { entries: [{ id: "rewound" }, { id: "actual-tail" }], leafId: "rewound" } });
  await assert.rejects(client.entryPage(Date.now() + 1000, 500), /unique final entry ID/u);
  client.request = async () => ({ data: { entries: [{ id: "duplicate" }, { id: "duplicate" }], leafId: "duplicate" } });
  await assert.rejects(client.entryPage(Date.now() + 1000, 500), /duplicate entry IDs/u);
  client.request = async () => ({ data: { entries: [{ id: "entry-watermark" }], leafId: "entry-watermark" } });
  await assert.rejects(client.entryPage(Date.now() + 1000, 500, "entry-watermark"), /repeated its exclusive cursor/u);
  client.request = async () => ({ data: { entries: [{ id: "exact-grant" }, { id: "" }], leafId: "" } });
  await assert.rejects(client.entryPage(Date.now() + 1000, 500, "entry-watermark"), /malformed ID/u);
});

test("a runner timeout is not relabeled as a provider cause by its own cancellation", () => {
  const termination = [{ source: "assistant_entry", stopReason: "aborted", message: "Request was aborted" }];
  assert.equal(runStatus({ passed: false }, {}, new Error("Run deadline exceeded"), termination, {}).reason, "runner_or_controller_error");
  assert.equal(runStatus({ passed: false }, {}, undefined, [{ source: "assistant_entry", stopReason: "error" }], {}).reason, "provider_failure");
});

async function approvalFlowScenario({
  planStatus = "awaiting_gate_review",
  revisionState = "reviewed",
  onApproval,
  afterApproval,
  approvalPreflightError,
  afterApprovalError,
  olderSameRevisionGrant = false,
  preDispatchEvidenceError = null,
  preDispatchPage = null,
  boundedEvidenceError = null,
  boundedPage = null,
} = {}) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "solar-flow-failure-"));
  try {
    const fixture = getHarnessFixture("execute-summary");
    const planPath = path.join(workspace, "plan.md");
    const planText = "Fixture plan bytes for the isolated flow test.";
    const contract = validExecuteContract();
    const revision = sha256Text(planText);
    const artifactTableRevision = artifactTableReceipt(contract);
    writeFileSync(planPath, planText, "utf8");
    const planWorkflow = {
      id: "approval-flow-fixture",
      stage: "plan",
      status: planStatus,
      autoExecute: true,
      revision,
      artifactTableRevision,
      plan: { path: planPath, revision, contract },
      planning: { revisionState },
    };
    let entrySequence = 0;
    const entriesLog = [
      {
        type: "custom",
        customType: "solar-interview-state-v2",
        id: `entry-${++entrySequence}`,
        data: {
          goalToken: "abcdefabcdef",
          proposal: { readiness: { status: "ready", materialGaps: [], contradictions: [], goalSentence: "Read input.json and create JSON summary.json." } },
        },
      },
      {
        type: "custom",
        customType: "solar-workflow-state-v1",
        id: `entry-${++entrySequence}`,
        data: { version: 3, id: planWorkflow.id, stage: "interview", status: "active" },
      },
    ];
    const client = {
      events: [],
      workflow: { id: planWorkflow.id, stage: "interview", status: "active" },
      entriesLog,
      entryPageCalls: [],
      appendWorkflow(workflow) {
        this.workflow = structuredClone(workflow);
        const entry = {
          type: "custom",
          customType: "solar-workflow-state-v1",
          id: `entry-${++entrySequence}`,
          data: { version: 3, ...structuredClone(workflow) },
        };
        this.entriesLog.push(entry);
        return entry;
      },
      appendRecord(entry) {
        this.entriesLog.push({ id: `entry-${++entrySequence}`, ...structuredClone(entry) });
      },
      async prompt(message, _deadline, options = {}) {
        if (message.startsWith("/solar-workflow approve ") && approvalPreflightError) throw approvalPreflightError;
        options.onDispatched?.({ id: `harness-fixture-${entrySequence + 1}`, type: "prompt" });
        this.events.push({ type: "prompt_observed", message });
        if (message.startsWith("/solar-interview confirm ")) {
          if (olderSameRevisionGrant) this.appendWorkflow({
            ...structuredClone(planWorkflow),
            stage: "execute",
            status: "active",
            approval: planWorkflow.revision,
            approvalArtifactTableRevision: planWorkflow.artifactTableRevision,
          });
          this.appendWorkflow(planWorkflow);
        }
        if (message.startsWith("/solar-workflow approve ")) {
          await onApproval?.({ client: this, planWorkflow, message });
        }
        if (message.startsWith("/solar-workflow approve ")) await afterApproval?.({ client: this, planWorkflow, message });
        if (message.startsWith("/solar-workflow approve ") && afterApprovalError) throw afterApprovalError;
      },
      async entryPage(_deadline, _maximumWaitMs, since) {
        this.entryPageCalls.push(since ?? null);
        if (since === undefined && preDispatchEvidenceError) throw preDispatchEvidenceError;
        if (since !== undefined && boundedEvidenceError) throw boundedEvidenceError;
        if (since === undefined && preDispatchPage) return structuredClone(preDispatchPage({ client: this, planWorkflow }));
        if (since !== undefined && boundedPage) return structuredClone(boundedPage({ client: this, planWorkflow, since }));
        let entries = this.entriesLog;
        if (since !== undefined) {
          const index = entries.findIndex(entry => entry.id === since);
          if (index < 0) throw new Error(`Entry not found: ${since}`);
          entries = entries.slice(index + 1);
        }
        return { entries: structuredClone(entries), leafId: this.entriesLog.at(-1)?.id ?? null };
      },
      async entries() {
        return structuredClone(this.entriesLog);
      },
    };
    const runtime = {
      recoverWorkflow: entries => structuredClone([...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "solar-workflow-state-v1")?.data),
      validateExecutionPlan: () => structuredClone(contract),
    };
    const flow = { prompts: [], confirmation: null, approvalEligibility: null, approval: null, approvalRequest: null, approvalBoundaryEventIndex: null, blockedReason: null, unsafe: false, planContract: null };
    let result;
    let error;
    try {
      result = await runFixtureFlow(fixture, client, runtime, workspace, Date.now() + 10_000, flow);
    } catch (caught) {
      error = caught;
    }
    const audit = auditObservedOperations(client.events, { fixture, workspace, approvalEventIndex: flow.approvalBoundaryEventIndex });
    return { fixture, flow, result, error, client, audit, planWorkflow };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("eligible paused or unreviewed plans do not claim or request host approval", async () => {
  for (const state of [
    { label: "paused", planStatus: "paused", revisionState: "awaiting_reviews" },
    { label: "unreviewed", planStatus: "awaiting_gate_review", revisionState: "awaiting_reviews" },
  ]) {
    const observed = await approvalFlowScenario(state);
    assert.equal(observed.error, undefined, state.label);
    assert.equal(observed.flow.approvalEligibility.eligible, true, state.label);
    assert.equal(observed.flow.approval.approved, false, state.label);
    assert.equal(observed.flow.approval.decision, "host_approval_not_requested", state.label);
    assert.deepEqual(observed.flow.approval.violations, ["workflow_not_ready_for_host_approval"], state.label);
    assert.equal(observed.flow.approvalRequest, null, state.label);
    assert.equal(observed.flow.approvalBoundaryEventIndex, null, state.label);
    assert.equal(observed.audit.approvalEventIndex, null, state.label);
    assert.deepEqual(observed.client.entryPageCalls, [], state.label);
    assert.equal(observed.flow.prompts.some(prompt => prompt.startsWith("/solar-workflow approve ")), false, state.label);
  }

  const rejectedBeforeDispatch = await approvalFlowScenario({
    approvalPreflightError: new Error("Synthetic RPC pre-dispatch rejection"),
  });
  assert.match(rejectedBeforeDispatch.error?.message ?? "", /pre-dispatch rejection/u);
  assert.equal(rejectedBeforeDispatch.flow.approvalRequest.dispatched, false);
  assert.equal(rejectedBeforeDispatch.flow.approvalRequest.rpcRequestId, null);
  assert.equal(rejectedBeforeDispatch.flow.approval.approved, false);
  assert.deepEqual(rejectedBeforeDispatch.flow.approval.violations, ["approval_request_not_dispatched"]);
  assert.equal(rejectedBeforeDispatch.flow.approvalBoundaryEventIndex, null);
  assert.equal(rejectedBeforeDispatch.audit.approvalEventIndex, null);
});

test("rejected or stale approval commands leave all following mutations pre-approval", async () => {
  const rejected = await approvalFlowScenario({
    afterApproval: ({ client }) => {
      client.appendRecord({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Approval rejected." }] } });
      client.events.push({ type: "tool_execution_start", toolName: "write", args: { path: "summary.json", content: "{}" } });
    },
  });
  assert.equal(rejected.error, undefined);
  assert.equal(rejected.flow.approvalEligibility.eligible, true);
  assert.equal(rejected.flow.approval.approved, false);
  assert.equal(rejected.flow.approval.decision, "host_approval_unconfirmed");
  assert.equal(rejected.flow.approvalBoundaryEventIndex, null);
  assert.equal(rejected.audit.approvalEventIndex, null);
  assert.equal(rejected.flow.approval.request.eventIndex, 2);
  assert.equal(rejected.flow.approval.request.planRevision, rejected.planWorkflow.revision);
  assert.equal(rejected.flow.approval.request.artifactTableRevision, rejected.planWorkflow.artifactTableRevision);
  assert.equal(rejected.flow.approval.request.dispatched, true);
  assert.match(rejected.flow.approval.request.rpcRequestId, /^harness-/u);
  assert.match(rejected.flow.approval.request.entryWatermark, /^entry-/u);
  assert.equal(rejected.flow.prompts.at(-1), rejected.flow.approval.request.command);
  assert.equal(rejected.audit.preApprovalMutations.length, 1);
  assert.equal(rejected.audit.unauthorized.length, 1);
  assert.equal(rejected.audit.operations.at(-1).phase, "before_approval");

  const stale = await approvalFlowScenario({
    onApproval: ({ client, planWorkflow }) => {
      client.appendWorkflow({
        ...structuredClone(planWorkflow),
        stage: "execute",
        status: "active",
        approval: planWorkflow.revision,
        approvalArtifactTableRevision: "0".repeat(64),
      });
    },
  });
  assert.equal(stale.error, undefined);
  assert.equal(stale.flow.approval.approved, false);
  assert.equal(stale.flow.approvalBoundaryEventIndex, null);
  assert.equal(stale.audit.approvalEventIndex, null);
  assert.deepEqual(stale.flow.approval.violations, ["matching_host_approval_not_observed"]);
  assert.equal(stale.result.blockedReason, "host_approval_not_confirmed");
});

test("dispatched timeouts and unavailable bounded history never establish an approval boundary", async () => {
  const timedOut = await approvalFlowScenario({
    afterApprovalError: new Error("Synthetic dispatched approval timeout"),
  });
  assert.match(timedOut.error?.message ?? "", /dispatched approval timeout/u);
  assert.equal(timedOut.flow.approval.request.dispatched, true);
  assert.match(timedOut.flow.approval.request.rpcRequestId, /^harness-/u);
  assert.match(timedOut.flow.approval.request.entryWatermark, /^entry-/u);
  assert.equal(timedOut.flow.approval.approved, false);
  assert.equal(timedOut.flow.approvalBoundaryEventIndex, null);
  assert.equal(timedOut.audit.approvalEventIndex, null);
  assert.deepEqual(timedOut.flow.approval.violations, ["matching_host_approval_not_observed"]);

  const unavailable = await approvalFlowScenario({
    boundedEvidenceError: new Error("Entry not found: pre-dispatch cursor"),
  });
  assert.equal(unavailable.error, undefined);
  assert.equal(unavailable.flow.approval.request.dispatched, true);
  assert.equal(unavailable.flow.approval.approved, false);
  assert.equal(unavailable.flow.approvalBoundaryEventIndex, null);
  assert.equal(unavailable.audit.approvalEventIndex, null);
  assert.match(unavailable.flow.approval.violations[0], /^request_bounded_grant_evidence_unavailable:Entry not found/u);
  assert.equal(unavailable.result.blockedReason, "host_approval_not_confirmed");

  const noWatermark = await approvalFlowScenario({
    preDispatchEvidenceError: new Error("get_entries unavailable"),
  });
  assert.equal(noWatermark.error, undefined);
  assert.equal(noWatermark.flow.approvalRequest, null);
  assert.equal(noWatermark.flow.approval.approved, false);
  assert.equal(noWatermark.flow.approval.decision, "host_approval_not_requested");
  assert.match(noWatermark.flow.approval.violations[0], /^approval_request_not_dispatched:get_entries unavailable/u);
  assert.equal(noWatermark.flow.approvalBoundaryEventIndex, null);
  assert.equal(noWatermark.audit.approvalEventIndex, null);
  assert.equal(noWatermark.result.blockedReason, "host_approval_evidence_unavailable");
  assert.equal(noWatermark.flow.prompts.some(prompt => prompt.startsWith("/solar-workflow approve ")), false);
});

test("an older same-revision grant before the request watermark is not attributable", async () => {
  const observed = await approvalFlowScenario({ olderSameRevisionGrant: true });
  assert.equal(observed.error, undefined);
  assert.equal(observed.flow.approval.request.dispatched, true);
  assert.equal(observed.flow.approval.request.entryWatermark, observed.client.entriesLog.at(-1).id);
  assert.ok(observed.client.entriesLog.some(entry =>
    entry.id !== observed.flow.approval.request.entryWatermark
    && entry.data?.approval === observed.planWorkflow.revision));
  assert.equal(observed.flow.approval.approved, false);
  assert.equal(observed.flow.approvalBoundaryEventIndex, null);
  assert.equal(observed.audit.approvalEventIndex, null);
  assert.deepEqual(observed.flow.approval.violations, ["matching_host_approval_not_observed"]);
});

test("rewound or duplicate pre-dispatch pages cannot expose an older matching grant", async () => {
  const rewound = await approvalFlowScenario({
    olderSameRevisionGrant: true,
    preDispatchPage: ({ client }) => {
      const oldGrantIndex = client.entriesLog.findIndex(entry => entry.data?.approval);
      assert.ok(oldGrantIndex > 0);
      return {
        entries: client.entriesLog,
        leafId: client.entriesLog[oldGrantIndex - 1].id,
      };
    },
  });
  assert.equal(rewound.error, undefined);
  assert.equal(rewound.flow.approvalRequest, null);
  assert.equal(rewound.flow.approval.approved, false);
  assert.match(rewound.flow.approval.violations[0], /approval_request_not_dispatched:RPC get_entries leaf must be the unique final entry ID/u);
  assert.equal(rewound.flow.approvalBoundaryEventIndex, null);
  assert.equal(rewound.audit.approvalEventIndex, null);
  assert.equal(rewound.flow.prompts.some(prompt => prompt.startsWith("/solar-workflow approve ")), false);

  const duplicate = await approvalFlowScenario({
    preDispatchPage: ({ client }) => {
      const entries = [...client.entriesLog, structuredClone(client.entriesLog.at(-1))];
      return { entries, leafId: entries.at(-1).id };
    },
  });
  assert.equal(duplicate.error, undefined);
  assert.equal(duplicate.flow.approvalRequest, null);
  assert.equal(duplicate.flow.approval.approved, false);
  assert.match(duplicate.flow.approval.violations[0], /approval_request_not_dispatched:RPC get_entries returned duplicate entry IDs/u);
  assert.equal(duplicate.flow.approvalBoundaryEventIndex, null);
  assert.equal(duplicate.audit.approvalEventIndex, null);
});

test("malformed post-cursor pages cannot mutate approval or its audit boundary", () => {
  const observation = completedExecuteObservation("execute-summary", expectedFixtureOutput("execute-summary"));
  const request = structuredClone(observation.approval.request);
  const grant = {
    type: "custom",
    customType: "solar-workflow-state-v1",
    id: "entry-new-grant",
    data: { ...structuredClone(observation.workflow), stage: "execute", status: "active" },
  };
  const malformed = [
    ["repeated watermark", {
      since: request.entryWatermark,
      entries: [{ ...structuredClone(grant), id: request.entryWatermark }, { id: "entry-tail", type: "message" }],
      leafId: "entry-tail",
    }, /repeated its exclusive cursor/u],
    ["duplicate IDs", {
      since: request.entryWatermark,
      entries: [structuredClone(grant), { id: grant.id, type: "message" }],
      leafId: grant.id,
    }, /duplicate entry IDs/u],
    ["non-tail leaf", {
      since: request.entryWatermark,
      entries: [structuredClone(grant), { id: "entry-tail", type: "message" }],
      leafId: grant.id,
    }, /unique final entry ID/u],
    ["empty observation leaf", {
      since: request.entryWatermark,
      entries: [structuredClone(grant), { id: "", type: "message" }],
      leafId: "",
    }, /malformed ID/u],
  ];
  for (const [label, evidence, diagnostic] of malformed) {
    const flow = {
      approvalEligibility: structuredClone(observation.approvalEligibility),
      approvalRequest: structuredClone(request),
      approval: null,
      approvalBoundaryEventIndex: null,
    };
    reconcileHostApproval(flow, evidence);
    assert.equal(flow.approval.approved, false, label);
    assert.equal(flow.approval.grant, null, label);
    assert.equal(flow.approvalBoundaryEventIndex, null, label);
    assert.match(flow.approval.violations[0], diagnostic, label);
  }
});

test("only an exact host grant advances the audit boundary, including before a later failure", async () => {
  const grant = ({ client, planWorkflow }) => {
    client.appendWorkflow({
      ...structuredClone(planWorkflow),
      stage: "execute",
      status: "active",
      approval: planWorkflow.revision,
      approvalArtifactTableRevision: planWorkflow.artifactTableRevision,
    });
  };
  const writeAfterGrant = ({ client }) => {
    client.events.push({ type: "tool_execution_start", toolName: "write", args: { path: "summary.json", content: "{}" } });
  };
  const accepted = await approvalFlowScenario({ onApproval: grant, afterApproval: writeAfterGrant });
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.flow.approval.approved, true);
  assert.equal(accepted.flow.approval.decision, "approved_current_host_grant");
  assert.equal(accepted.flow.approval.request.eventIndex, 2);
  assert.equal(accepted.flow.approval.request.dispatched, true);
  assert.match(accepted.flow.approval.request.entryWatermark, /^entry-/u);
  assert.match(accepted.flow.approval.grant.entryId, /^entry-/u);
  assert.match(accepted.flow.approval.grant.observedLeafId, /^entry-/u);
  assert.notEqual(accepted.flow.approval.grant.entryId, accepted.flow.approval.request.entryWatermark);
  assert.equal(accepted.flow.approvalBoundaryEventIndex, 2);
  assert.equal(accepted.audit.approvalEventIndex, 2);
  assert.ok(accepted.flow.approval.request.eventIndex
    < accepted.client.events.findIndex(event => event.type === "tool_execution_start"));
  assert.deepEqual(accepted.audit.preApprovalMutations, []);
  assert.deepEqual(accepted.audit.unauthorized, []);

  const failed = await approvalFlowScenario({
    onApproval: grant,
    afterApproval: ({ client, planWorkflow }) => {
      writeAfterGrant({ client });
      client.appendWorkflow({
        ...structuredClone(planWorkflow),
        status: "paused",
        planning: { revisionState: "awaiting_reviews" },
      });
    },
    afterApprovalError: new Error("Synthetic failure after exact host approval"),
  });
  assert.match(failed.error?.message ?? "", /failure after exact host approval/u);
  assert.equal(failed.client.workflow.status, "paused");
  assert.equal(failed.client.workflow.approval, undefined);
  assert.equal(failed.flow.approval.approved, true);
  assert.equal(failed.flow.approvalBoundaryEventIndex, 2);
  assert.equal(failed.audit.approvalEventIndex, 2);
  assert.equal(failed.flow.approval.grant.planRevision, failed.planWorkflow.revision);
  assert.equal(failed.flow.approval.grant.artifactTableRevision, failed.planWorkflow.artifactTableRevision);
  const grantIndex = failed.client.entriesLog.findIndex(entry => entry.id === failed.flow.approval.grant.entryId);
  const clearIndex = failed.client.entriesLog.findIndex((entry, index) => index > grantIndex && entry.data?.status === "paused");
  assert.ok(grantIndex >= 0 && clearIndex > grantIndex, "The exact grant and its later clearing state must both precede recovery.");
  assert.equal(failed.flow.approval.grant.observedLeafId, failed.client.entriesLog[clearIndex].id);
  assert.deepEqual(failed.client.entryPageCalls, [null, failed.flow.approval.request.entryWatermark]);
  assert.deepEqual(failed.audit.preApprovalMutations, []);
  assert.deepEqual(failed.audit.unauthorized, []);
});

test("synthetic approval rejects path escape and immutable-input mutation", () => {
  const malicious = validExecuteContract();
  malicious.capabilities[1].paths = ["../outside.json", "input.json"];
  malicious.artifacts[2].path = "C:/outside.json";
  const decision = validateSyntheticApproval(malicious, "execute-summary");
  assert.equal(decision.approved, false);
  assert.ok(decision.violations.some(item => item.startsWith("path_outside_fixture:")));
  assert.ok(decision.violations.some(item => item.startsWith("write_to_immutable_path:")));
  assert.ok(decision.violations.some(item => item.startsWith("artifact_outside_fixture:")));
});

test("synthetic approval rejects command chaining, malicious actions, and human or rubric acceptance", () => {
  const malicious = validExecuteContract();
  malicious.capabilities.push({ id: "C3", kind: "command", tool: "bash", paths: ["summary.json"], commands: ["node evaluator.mjs; curl https://example.invalid"] });
  malicious.steps[0].capabilities.push("C3");
  malicious.steps[0].actions.push("Publish the output to a network service.");
  malicious.gates[0] = { id: "G1", kind: "rubric", check: "Looks plausible", pass: "A reviewer likes it", evidence: ["A1"] };
  malicious.artifacts.at(-1).acceptance = "human";
  const decision = validateSyntheticApproval(malicious, "execute-summary");
  assert.equal(decision.approved, false);
  assert.ok(decision.violations.some(item => item.startsWith("command_not_exact_evaluator:")));
  assert.ok(decision.violations.some(item => item.startsWith("unsafe_step_action:")));
  assert.ok(decision.violations.some(item => item.startsWith("non_command_gate:")));
  assert.ok(decision.violations.some(item => item.startsWith("human_acceptance_forbidden:")));
});

test("independent output grading rejects an incorrect result even when workflow receipts claim completion", () => {
  const observation = completedExecuteObservation("execute-summary", { groups: [], recordCount: 5, grandTotal: 7 });
  const grade = gradeHarnessResult("execute-summary", observation);
  assert.equal(grade.passed, false);
  assert.equal(grade.assertions.find(item => item.id === "command_only_workflow_completed").passed, true);
  assert.equal(grade.assertions.find(item => item.id === "output_matches_independent_expected_value").passed, false);
});

test("grading distinguishes fixture eligibility from an exact current host approval grant", () => {
  const expected = expectedFixtureOutput("execute-summary");
  const assertionFor = observation => gradeHarnessResult("execute-summary", observation).assertions.find(item => item.id === "synthetic_plan_was_safely_approved");
  const accepted = completedExecuteObservation("execute-summary", expected);
  assert.equal(assertionFor(accepted).passed, true);

  const failedAfterGrant = completedExecuteObservation("execute-summary", expected);
  Object.assign(failedAfterGrant.workflow, {
    stage: "plan",
    status: "paused",
    approval: undefined,
    approvalArtifactTableRevision: undefined,
  });
  const failedAfterGrantAssertion = assertionFor(failedAfterGrant);
  assert.equal(failedAfterGrantAssertion.passed, true, "A matching observed grant remains attributable after a later same-revision failure.");
  assert.deepEqual(failedAfterGrantAssertion.evidence.checks, { policyEligible: true, exactRequest: true, exactGrant: true });

  const eligibleOnly = completedExecuteObservation("execute-summary", expected);
  Object.assign(eligibleOnly.approval, {
    approved: false,
    decision: "host_approval_unconfirmed",
    grant: null,
    violations: ["matching_host_approval_not_observed"],
  });
  assert.equal(eligibleOnly.approvalEligibility.eligible, true);
  assert.equal(assertionFor(eligibleOnly).passed, false);

  const undispatched = completedExecuteObservation("execute-summary", expected);
  undispatched.approval.request.dispatched = false;
  undispatched.approval.request.rpcRequestId = null;
  assert.equal(assertionFor(undispatched).passed, false);

  const paused = completedExecuteObservation("execute-summary", expected);
  Object.assign(paused.workflow, { stage: "plan", status: "paused", approval: undefined, approvalArtifactTableRevision: undefined });
  paused.workflow.planning.revisionState = "awaiting_reviews";
  Object.assign(paused.approval, {
    approved: false,
    decision: "host_approval_not_requested",
    request: null,
    grant: null,
    violations: ["workflow_not_ready_for_host_approval"],
  });
  assert.equal(paused.approvalEligibility.eligible, true);
  const pausedAssertion = assertionFor(paused);
  assert.equal(pausedAssertion.passed, false);
  assert.equal(pausedAssertion.evidence.checks.policyEligible, true);
  assert.equal(pausedAssertion.evidence.checks.exactRequest, false);
  assert.equal(pausedAssertion.evidence.checks.exactGrant, false);

  const staleRequest = completedExecuteObservation("execute-summary", expected);
  staleRequest.approval.request.planRevision = "0".repeat(64);
  assert.equal(assertionFor(staleRequest).passed, false);

  const staleGrant = completedExecuteObservation("execute-summary", expected);
  staleGrant.approval.grant.artifactTableRevision = "0".repeat(64);
  assert.equal(assertionFor(staleGrant).passed, false);

  const unavailableGrantEntry = completedExecuteObservation("execute-summary", expected);
  unavailableGrantEntry.approval.grant.entryId = null;
  assert.equal(assertionFor(unavailableGrantEntry).passed, false);

  const staleAuditBoundary = completedExecuteObservation("execute-summary", expected);
  staleAuditBoundary.operationAudit.approvalEventIndex = null;
  assert.equal(assertionFor(staleAuditBoundary).passed, false);
});

test("command-only completion requires current bound receipts rather than a complete status string", () => {
  const expected = expectedFixtureOutput("execute-summary");
  const valid = completedExecuteObservation("execute-summary", expected);
  const validAssertion = gradeHarnessResult("execute-summary", valid).assertions.find(item => item.id === "command_only_workflow_completed");
  assert.equal(validAssertion.passed, true, JSON.stringify(validAssertion.evidence));
  assert.match(valid.workflow.finalReview, /^[a-f0-9]{64}$/u);
  assert.equal(valid.workflow.finalReview, validAssertion.evidence.expectedFinalReview);
  assert.equal(validAssertion.evidence.checks.observedPlan, true);

  const statusOnly = gradeHarnessResult("execute-summary", {
    workflow: { version: 3, stage: "execute", status: "complete" },
  }).assertions.find(item => item.id === "command_only_workflow_completed");
  assert.equal(statusOnly.passed, false);

  const observedPlanCases = [
    ["removed controller plan snapshot", observation => {
      delete observation.afterFiles[observation.workflow.plan.relativePath];
    }],
    ["changed controller plan snapshot", observation => {
      const changed = `${observation.workflow.plan.text}\nchanged after completion\n`;
      observation.afterFiles[observation.workflow.plan.relativePath] = {
        type: "file",
        bytes: Buffer.byteLength(changed),
        sha256: sha256Text(changed),
      };
    }],
    ["special-file controller plan snapshot", observation => {
      observation.afterFiles[observation.workflow.plan.relativePath] = {
        type: "symlink",
        bytes: 0,
        sha256: null,
      };
    }],
  ];
  for (const [label, mutate] of observedPlanCases) {
    const observation = completedExecuteObservation("execute-summary", expected);
    mutate(observation);
    const completion = gradeHarnessResult("execute-summary", observation).assertions.find(item => item.id === "command_only_workflow_completed");
    assert.equal(completion.passed, false, label);
    assert.equal(completion.evidence.checks.observedPlan, false, `${label}: observed plan binding`);
    assert.equal(completion.evidence.checks.currentContract, true, `${label}: saved contract remained current`);
    assert.equal(completion.evidence.checks.currentAuthority, true, `${label}: saved revisions remained current`);
    assert.equal(completion.evidence.checks.stableFinalManifest, true, `${label}: saved final manifests remained current`);
    assert.equal(completion.evidence.checks.acceptanceManifest, true, `${label}: saved acceptance manifest remained current`);
    assert.equal(completion.evidence.checks.gateResults, true, `${label}: saved gate receipts remained current`);
    assert.equal(completion.evidence.checks.finalReviewDigest, true, `${label}: saved final digest remained current`);
  }

  const diskContractCases = [
    ["missing fenced execution contract", "# Synthetic reviewed plan\n"],
    ["malformed fenced execution contract", "# Synthetic reviewed plan\n\n## Execution contract\n```json\n{\"version\":\n```\n"],
    ["mismatched fenced execution contract", observation => {
      const mismatched = structuredClone(observation.workflow.plan.contract);
      mismatched.requirements[0].description = "Different disk-plan requirement bytes.";
      return syntheticPlanText(mismatched);
    }],
  ];
  for (const [label, plan] of diskContractCases) {
    const observation = completedExecuteObservation("execute-summary", expected);
    rebindCompletedPlan(observation, typeof plan === "function" ? plan(observation) : plan);
    const completion = gradeHarnessResult("execute-summary", observation).assertions.find(item => item.id === "command_only_workflow_completed");
    assert.equal(completion.passed, false, label);
    assert.equal(completion.evidence.checks.currentContract, false, `${label}: parsed contract binding`);
    assert.equal(completion.evidence.checks.currentAuthority, true, `${label}: plan revision was rebound`);
    assert.equal(completion.evidence.checks.observedPlan, true, `${label}: observed plan bytes were rebound`);
    assert.equal(completion.evidence.checks.stableFinalManifest, true, `${label}: final manifests were rebound`);
    assert.equal(completion.evidence.checks.acceptanceManifest, true, `${label}: acceptance manifest was rebound`);
    assert.equal(completion.evidence.checks.finalReviewDigest, true, `${label}: final digest was rebound`);
  }

  const cases = [
    ["missing final-review digest", observation => { delete observation.workflow.finalReview; }, "finalReviewDigest"],
    ["forged final-review digest", observation => { observation.workflow.finalReview = "f".repeat(64); }, "finalReviewDigest"],
    ["stale plan approval", observation => { observation.workflow.approval = "0".repeat(64); }, "currentAuthority"],
    ["stale approved artifact table", observation => { observation.workflow.approvalArtifactTableRevision = "0".repeat(64); }, "currentAuthority"],
    ["stale persisted plan revision", observation => { observation.workflow.plan.revision = "0".repeat(64); }, "currentAuthority"],
    ["missing independently read contract", observation => { delete observation.planContract; }, "currentContract"],
    ["stale independently read contract", observation => { observation.planContract.requirements[0].description = "stale contract"; }, "currentContract"],
    ["stale pre-final manifest revision", observation => {
      observation.workflow.finalManifestBefore.planRevision = "0".repeat(64);
      refreshFinalReview(observation);
    }, "stableFinalManifest"],
    ["stale final manifest revision", observation => {
      observation.workflow.finalManifest.planRevision = "0".repeat(64);
      refreshFinalReview(observation);
    }, "stableFinalManifest"],
    ["stale acceptance manifest table", observation => {
      observation.workflow.acceptanceManifest.artifactTableRevision = "0".repeat(64);
      refreshFinalReview(observation);
    }, "acceptanceManifest"],
    ["missing pre-final manifest", observation => {
      delete observation.workflow.finalManifestBefore;
      refreshFinalReview(observation);
    }, "stableFinalManifest"],
    ["missing final manifest", observation => {
      delete observation.workflow.finalManifest;
      refreshFinalReview(observation);
    }, "stableFinalManifest"],
    ["missing acceptance manifest", observation => {
      delete observation.workflow.acceptanceManifest;
      refreshFinalReview(observation);
    }, "acceptanceManifest"],
    ["wrong final artifact descriptor", observation => {
      observation.workflow.finalManifestBefore.files[0].path = "input.json";
      observation.workflow.finalManifest.files[0].path = "input.json";
      refreshFinalReview(observation);
    }, "stableFinalManifest"],
    ["changed observed final hash", observation => {
      observation.afterFiles["summary.json"].sha256 = "0".repeat(64);
    }, "stableFinalManifest"],
    ["changed observed final byte count", observation => {
      observation.afterFiles["summary.json"].bytes += 1;
    }, "stableFinalManifest"],
    ["changed observed evidence hash", observation => {
      observation.afterFiles["input.json"].sha256 = "0".repeat(64);
    }, "acceptanceManifest"],
    ["changed observed evidence byte count", observation => {
      observation.afterFiles["input.json"].bytes += 1;
    }, "acceptanceManifest"],
    ["missing approved gate result", observation => {
      observation.workflow.finalChecks = [];
      refreshFinalReview(observation);
    }, "gateResults"],
    ["duplicate approved gate result", observation => {
      observation.workflow.finalChecks.push(structuredClone(observation.workflow.finalChecks[0]));
      refreshFinalReview(observation);
    }, "gateResults"],
    ["failed approved gate result", observation => {
      Object.assign(observation.workflow.finalChecks[0], { passed: false, code: 1 });
      refreshFinalReview(observation);
    }, "gateResults"],
    ["killed approved gate result", observation => {
      Object.assign(observation.workflow.finalChecks[0], { passed: false, killed: true });
      refreshFinalReview(observation);
    }, "gateResults"],
    ["errored approved gate result", observation => {
      Object.assign(observation.workflow.finalChecks[0], { passed: false, errors: ["capture failed"] });
      refreshFinalReview(observation);
    }, "gateResults"],
    ["malformed approved gate result", observation => {
      delete observation.workflow.finalChecks[0].errors;
      refreshFinalReview(observation);
    }, "gateResults"],
    ["non-command gate result", observation => {
      Object.assign(observation.workflow.finalChecks[0], { kind: "rubric", acceptance: "qualitative_human" });
      refreshFinalReview(observation);
    }, "gateResults"],
    ["non-current command acceptance", observation => {
      observation.workflow.finalChecks[0].acceptance = "qualitative_human";
      refreshFinalReview(observation);
    }, "gateResults"],
    ["omitted declared gate evidence", observation => {
      observation.workflow.finalChecks[0].files = [];
      refreshFinalReview(observation);
    }, "gateResults"],
    ["duplicate declared gate evidence", observation => {
      observation.workflow.finalChecks[0].files.push(structuredClone(observation.workflow.finalChecks[0].files[0]));
      refreshFinalReview(observation);
    }, "gateResults"],
    ["malformed final manifest hash", observation => {
      observation.workflow.finalManifestBefore.files[0].hash = "not-a-hash";
      observation.workflow.finalManifest.files[0].hash = "not-a-hash";
      refreshFinalReview(observation);
    }, "stableFinalManifest"],
    ["pending completion", observation => {
      observation.workflow.status = "awaiting_final_review";
    }, "state"],
  ];

  for (const [label, mutate, failedCheck] of cases) {
    const observation = completedExecuteObservation("execute-summary", expected);
    mutate(observation);
    const completion = gradeHarnessResult("execute-summary", observation).assertions.find(item => item.id === "command_only_workflow_completed");
    assert.equal(completion.passed, false, label);
    assert.equal(completion.evidence.checks[failedCheck], false, `${label}: ${failedCheck}`);
  }
});

test("human or rubric completion is not command-only completion", () => {
  const observation = completedExecuteObservation("execute-summary", expectedFixtureOutput("execute-summary"));
  const workflow = observation.workflow;
  workflow.plan.contract.artifacts.find(artifact => artifact.kind === "final").acceptance = "human";
  workflow.plan.contract.gates[0].kind = "rubric";
  Object.assign(workflow.finalChecks[0], {
    kind: "rubric",
    acceptance: "qualitative_human",
    stdout: "Qualitative rubric captured for explicit human review; it is not command proof.",
  });
  observation.planContract = structuredClone(workflow.plan.contract);
  rebindCompletedPlan(observation, syntheticPlanText(workflow.plan.contract));

  const completion = gradeHarnessResult("execute-summary", observation).assertions.find(item => item.id === "command_only_workflow_completed");
  assert.equal(completion.passed, false);
  assert.equal(completion.evidence.checks.currentAuthority, true);
  assert.equal(completion.evidence.checks.commandContract, false);
  assert.ok(completion.evidence.contractViolations.some(violation => /non_command_gate|human_acceptance_forbidden/u.test(violation)));
});

test("fresh held-out evaluator and independent grading oracles reject materially wrong branch, ordering, and edge-value outputs", () => {
  for (const caseName of FRESH_HELD_OUT_CASES) {
    const expected = expectedFixtureOutput(caseName);
    const evaluatorPass = evaluateFixtureOutput(caseName, expected);
    assert.equal(evaluatorPass.status, 0, evaluatorPass.stderr || evaluatorPass.error?.message);
    assert.equal(gradeHarnessResult(caseName, completedExecuteObservation(caseName, expected)).passed, true);

    const alteredOutputs = [];
    if (caseName === "execute-module-alias-heldout") {
      assert.deepEqual(new Set(expected.resolutions.map(item => item.status)), new Set(["mapped", "unmapped"]));
      assert.ok(expected.aliasUsage.some(item => item.count === 0));
      assert.ok(expected.resolutions.some(item => item.status === "unmapped" && item.alias === null && item.target === null));

      const longestPrefixWasLost = structuredClone(expected);
      const nestedImport = longestPrefixWasLost.resolutions.find(item => item.id === "widget");
      nestedImport.alias = "@core/";
      nestedImport.target = "./src/core/ui/button.mjs";
      longestPrefixWasLost.aliasUsage.find(item => item.key === "@core/").count += 1;
      longestPrefixWasLost.aliasUsage.find(item => item.key === "@core/ui/").count -= 1;
      alteredOutputs.push(longestPrefixWasLost);

      const exactAliasBecamePrefix = structuredClone(expected);
      const exactSubpath = exactAliasBecamePrefix.resolutions.find(item => item.id === "legacy-subpath");
      exactSubpath.status = "mapped";
      exactSubpath.alias = "legacy-api";
      exactSubpath.target = "./compat/api.mjs/v2";
      exactAliasBecamePrefix.aliasUsage.find(item => item.key === "legacy-api").count += 1;
      exactAliasBecamePrefix.counts.mapped += 1;
      exactAliasBecamePrefix.counts.unmapped -= 1;
      alteredOutputs.push(exactAliasBecamePrefix);

      const unusedAliasWasDropped = structuredClone(expected);
      unusedAliasWasDropped.aliasUsage = unusedAliasWasDropped.aliasUsage.filter(item => item.count !== 0);
      alteredOutputs.push(unusedAliasWasDropped);

      const resolutionSortWasLost = structuredClone(expected);
      resolutionSortWasLost.resolutions.reverse();
      alteredOutputs.push(resolutionSortWasLost);
    } else {
      assert.equal(caseName, "execute-access-matrix-heldout");
      assert.ok(expected.accounts.some(account => account.effective.length === 0));
      assert.ok(expected.permissionUsage.some(item => item.accountCount === 0));
      assert.ok(expected.accounts.some(account => account.denied.some(permission => !account.effective.includes(permission))));

      const denyPrecedenceWasLost = structuredClone(expected);
      denyPrecedenceWasLost.accounts.find(account => account.id === "bea").effective.unshift("build:run");
      denyPrecedenceWasLost.permissionUsage.find(item => item.permission === "build:run").accountCount += 1;
      alteredOutputs.push(denyPrecedenceWasLost);

      const unappliedDenyWasDropped = structuredClone(expected);
      unappliedDenyWasDropped.accounts.find(account => account.id === "cy").denied = [];
      alteredOutputs.push(unappliedDenyWasDropped);

      const zeroUsagePermissionWasDropped = structuredClone(expected);
      zeroUsagePermissionWasDropped.permissionUsage = zeroUsagePermissionWasDropped.permissionUsage.filter(item => item.accountCount !== 0);
      alteredOutputs.push(zeroUsagePermissionWasDropped);

      const accountSortWasLost = structuredClone(expected);
      accountSortWasLost.accounts.reverse();
      alteredOutputs.push(accountSortWasLost);
    }

    assert.equal(alteredOutputs.length, 4);
    for (const altered of alteredOutputs) {
      const evaluatorFailure = evaluateFixtureOutput(caseName, altered);
      assert.notEqual(evaluatorFailure.status, 0);
      const grade = gradeHarnessResult(caseName, completedExecuteObservation(caseName, altered));
      assert.equal(grade.passed, false);
      assert.equal(grade.assertions.find(item => item.id === "output_matches_independent_expected_value").passed, false);
    }
  }
});

test("interview grading reads Pi user message text-block arrays and preserves correction evidence", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Authoritative correction: withdraw the YAML-only statement completely. JSON remains required." }],
      },
    },
    {
      type: "custom",
      customType: "solar-interview-state-v2",
      data: { proposal: { readiness: { status: "not_ready", materialGaps: [], contradictions: [{ id: "format-conflict" }] } } },
    },
    {
      type: "custom",
      customType: "solar-interview-state-v2",
      data: { goalToken: "abcdef123456", proposal: { readiness: { status: "ready", materialGaps: [], contradictions: [] } } },
    },
  ];
  const grade = gradeHarnessResult("interview-correction", {
    preflight: { passed: true },
    process: { exitCode: 0, signal: null },
    providerFailures: [],
    events: [],
    entries,
    workflow: { stage: "interview", status: "active" },
    beforeFiles: {},
    afterFiles: {},
    operationAudit: { unauthorized: [], preApprovalMutations: [] },
  });
  assert.equal(grade.passed, true);
  assert.equal(grade.assertions.find(item => item.id === "authoritative_correction_was_saved").passed, true);
});

test("an honestly blocked local-only research contract completes the fixture without inventing evidence", () => {
  const snapshots = fileSnapshots("research-local");
  const contract = {
    outcome: "blocked",
    sources: [],
    claims: [{ id: "U1", kind: "uncertainty", text: "The local notes conflict between 30 and 90 days.", sourceIds: [] }],
    remainingGap: "Authenticated provenance is needed to resolve the retention period.",
  };
  const grade = gradeHarnessResult("research-local", {
    preflight: { passed: true },
    process: { exitCode: 0, signal: null },
    providerFailures: [],
    events: [],
    entries: [],
    workflow: { stage: "research", status: "paused", research: { contract } },
    beforeFiles: snapshots.before,
    afterFiles: snapshots.after,
    operationAudit: { unauthorized: [], preApprovalMutations: [] },
  });
  assert.equal(grade.passed, true);
  assert.equal(grade.assertions.find(item => item.id === "honest_research_boundary_recorded").passed, true);
});

test("operation audit rejects pre-approval mutation and evaluator command drift", () => {
  const workspace = process.platform === "win32" ? "C:\\fixture" : "/fixture";
  const events = [
    { type: "tool_execution_start", toolName: "write", args: { path: "summary.json" } },
    { type: "tool_execution_start", toolName: "read", args: { path: "input.json" } },
    { type: "tool_execution_start", toolName: "bash", args: { command: "node evaluator.mjs && echo bypass" } },
  ];
  const audit = auditObservedOperations(events, { fixture: "execute-summary", workspace, approvalEventIndex: 2 });
  assert.equal(audit.preApprovalMutations.length, 1);
  assert.equal(audit.unauthorized.length, 2);
  assert.equal(audit.operations[1].authorized, true);
});

test("observed accounting keeps main assistant usage separate from role attempts and receipts", () => {
  const receipt = {
    role: "planner",
    attemptId: "attempt-1",
    contextId: "context-1",
    provider: "upstage",
    modelId: "solar-pro4",
    outputRevision: "b".repeat(64),
    attemptOrdinal: 1,
    repair: false,
  };
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 16 } } },
    { type: "custom", customType: "solar-workflow-state-v1", data: { planning: { reviewReceipts: { planner: receipt } } } },
  ];
  const workflow = { roleAttempts: [{ role: "planner", attemptId: "attempt-1", contextId: "context-1", attemptOrdinal: 1, repair: false, status: "succeeded" }] };
  const metrics = summarizeObservedMetrics(entries, workflow, { assistantMessages: 1, tokens: { total: 16 } });
  assert.equal(metrics.mainSessionAssistantCallsObserved, 1);
  assert.equal(metrics.mainSessionAssistantUsageObserved.totalTokens, 16);
  assert.equal(metrics.roleSessionAttemptsObserved.length, 1);
  assert.equal(metrics.roleReceiptsObserved.length, 1);
  assert.equal(metrics.roleSessionTokensObserved, null);
});
