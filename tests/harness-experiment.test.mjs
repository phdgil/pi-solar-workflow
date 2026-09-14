import assert from "node:assert/strict";
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
  experimentProtocolReceipt,
  parseHarnessArguments,
  RpcClient,
  runFixtureFlow,
  runStatus,
  summarizeObservedMetrics,
} from "../scripts/harness-experiment.mjs";

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

test("fixture catalog includes the development cases and a distinct held-out execute variation", () => {
  const listed = listHarnessFixtures();
  assert.deepEqual(listed.map(item => item.name), [
    "research-local",
    "interview-correction",
    "plan-software",
    "execute-summary",
    "execute-inventory-heldout",
  ]);
  assert.equal(listed.find(item => item.name === "execute-inventory-heldout").heldOut, true);
  assert.notDeepEqual(expectedFixtureOutput("execute-summary"), expectedFixtureOutput("execute-inventory-heldout"));
  assert.notEqual(fixtureManifest("execute-summary").fixtureSha256, fixtureManifest("execute-inventory-heldout").fixtureSha256);
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

test("a runner timeout is not relabeled as a provider cause by its own cancellation", () => {
  const termination = [{ source: "assistant_entry", stopReason: "aborted", message: "Request was aborted" }];
  assert.equal(runStatus({ passed: false }, {}, new Error("Run deadline exceeded"), termination, {}).reason, "runner_or_controller_error");
  assert.equal(runStatus({ passed: false }, {}, undefined, [{ source: "assistant_entry", stopReason: "error" }], {}).reason, "provider_failure");
});

test("a timeout after approval preserves its boundary for operation auditing", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "solar-flow-failure-"));
  try {
    const fixture = getHarnessFixture("execute-summary");
    const planPath = path.join(workspace, "plan.md");
    writeFileSync(planPath, "Fixture plan bytes for the isolated flow test.", "utf8");
    let prompts = 0;
    const client = {
      events: [],
      async prompt(message) {
        prompts += 1;
        this.events.push({ type: "prompt_observed", message });
        if (message.startsWith("/solar-workflow approve ")) {
          this.events.push({ type: "tool_execution_start", toolName: "write", args: { path: "summary.json", content: "{}" } });
          throw new Error("Synthetic post-approval timeout");
        }
      },
      async entries() {
        return [{ type: "custom", customType: "solar-interview-state-v2", data: {
          goalToken: "abcdefabcdef",
          proposal: { readiness: { status: "ready", materialGaps: [], contradictions: [], goalSentence: "Read input.json and create JSON summary.json." } },
        } }];
      },
    };
    const runtime = {
      recoverWorkflow: () => prompts < 2 ? { stage: "interview" } : {
        stage: "plan", status: "awaiting_gate_review", autoExecute: true,
        revision: "a".repeat(64), plan: { path: planPath }, planning: { revisionState: "reviewed" },
      },
      validateExecutionPlan: () => validExecuteContract(),
    };
    const flow = { prompts: [], confirmation: null, approval: null, approvalBoundaryEventIndex: null, blockedReason: null, unsafe: false, planContract: null };
    await assert.rejects(runFixtureFlow(fixture, client, runtime, workspace, Date.now() + 1000, flow), /post-approval timeout/);
    assert.equal(flow.approval.approved, true);
    assert.equal(flow.approvalBoundaryEventIndex, 2);
    assert.equal(flow.prompts.length, 3);
    const audit = auditObservedOperations(client.events, { fixture, workspace, approvalEventIndex: flow.approvalBoundaryEventIndex });
    assert.deepEqual(audit.preApprovalMutations, []);
    assert.deepEqual(audit.unauthorized, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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
  const wrong = `${JSON.stringify({ groups: [], recordCount: 5, grandTotal: 7 })}\n`;
  const snapshots = fileSnapshots("execute-summary", wrong);
  const approval = validateSyntheticApproval(validExecuteContract(), "execute-summary");
  const observation = {
    preflight: { passed: true },
    process: { exitCode: 0, signal: null },
    providerFailures: [],
    events: [],
    entries: [{
      type: "custom",
      customType: "solar-interview-closure-v2",
      data: { mode: "normal", completionAuthority: "user_confirmation", confirmedGoal: { sentence: "Read input.json and create only the JSON result summary.json." } },
    }],
    workflow: { stage: "execute", status: "complete", planning: { reviewReceipts: roleReceipts() } },
    beforeFiles: snapshots.before,
    afterFiles: snapshots.after,
    outputContents: { "summary.json": wrong },
    operationAudit: { unauthorized: [], preApprovalMutations: [] },
    approval,
  };
  const grade = gradeHarnessResult("execute-summary", observation);
  assert.equal(grade.passed, false);
  assert.equal(grade.assertions.find(item => item.id === "output_matches_independent_expected_value").passed, false);
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
