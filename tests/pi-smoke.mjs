import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { prepareReloadFixture } from "./reload-fixture.mjs";
import { recoverWorkflow } from "../runtime/workflow.ts";
import { renderHarnessRolePrompt } from "../runtime/harness.ts";
import { NATIVE_TOOL_AUTHORITY_ENTRY, validateNativeToolAuthorityReceipt } from "../runtime/loop.ts";
import { buildPlannerResponseSchema } from "../runtime/planner-output.ts";

const TEST_PREFIX = "pi-solar-smoke-";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/u;
const REQUIRED_SKILLS = ["solar-research", "solar-interview", "solar-plan", "solar-execute"];
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOLAR_MODEL = "solar-pro4";
const GENERIC_MODEL = "mock-medium";
const PRIVATE_READ_SCENARIO = "installed-private-read-boundary-6f31";
const PRIVATE_READ_SENTINEL = "SYNTHETIC_PRIVATE_READ_SENTINEL_NOT_A_SECRET_9c72";
const POSITIVE_READ_SENTINEL = "AUTHORIZED_APPLICATION_SESSION_JSONL_EVIDENCE_1a46";
const TOOL_ERROR_OFFSET = 1_000_000;
const SUMMARY_OUTPUT = {
  groups: [
    { category: "alpha", count: 2, total: 3 },
    { category: "beta", count: 2, total: 4 },
    { category: "empty", count: 1, total: 0 },
  ],
  recordCount: 5,
  grandTotal: 7,
};
const EXECUTE_SUMMARY_ASSERTIONS = [
  "preflight_model_and_resources",
  "pi_process_exited_cleanly",
  "provider_failures_absent",
  "extension_errors_absent",
  "fixture_inputs_unchanged",
  "unexpected_workspace_files_absent",
  "workspace_contains_no_special_files",
  "fixture_policy_tool_attempts_within_bounds",
  "native_tool_authority_clean",
  "full_interview_exact_confirmation",
  "confirmed_goal_matches_fixture_semantics",
  "current_revision_has_all_role_receipts",
  "synthetic_plan_was_safely_approved",
  "no_mutation_before_exact_approval",
  "command_only_workflow_completed",
  "output_is_valid_json",
  "output_matches_independent_expected_value",
];

function discoverPiCli() {
  const configured = process.env.PI_CLI_PATH?.trim();
  if (configured) {
    const candidate = path.resolve(configured);
    assert.ok(existsSync(candidate), `PI_CLI_PATH does not exist: ${candidate}`);
    return candidate;
  }
  const npmCliCandidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(candidate => candidate && existsSync(candidate));
  let npmRoot;
  if (npmCliCandidates.length) {
    npmRoot = execFileSync(process.execPath, [npmCliCandidates[0], "root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
  } else if (process.platform !== "win32") {
    npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
  } else {
    throw new Error("Cannot locate npm-cli.js; set PI_CLI_PATH to pi's dist/bundle/cli.js.");
  }
  const candidate = path.join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  assert.ok(existsSync(candidate), `Installed pi CLI was not found under npm root: ${candidate}`);
  return candidate;
}

function isolatedEnvironment(root, agentDir, sessionDir = path.join(root, "sessions")) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|OAUTH_TOKEN|BEARER_TOKEN|SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS)$/iu.test(name)) delete environment[name];
  }
  const home = path.join(root, "home");
  const roaming = path.join(home, "AppData", "Roaming");
  const local = path.join(home, "AppData", "Local");
  mkdirSync(roaming, { recursive: true });
  mkdirSync(local, { recursive: true });
  const npmConfig = path.join(root, "empty-npmrc");
  writeFileSync(npmConfig, "", "utf8");
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    NPM_CONFIG_USERCONFIG: npmConfig,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PI_SOLAR_SMOKE_TOKEN: "loopback-fixture-key",
  };
}

function runCli(cliPath, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pi ${arguments_[0]} timed out\n${stderr}`));
    }, options.timeout ?? 60_000);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const acceptedExitCodes = options.acceptExitCodes ?? [0];
      if (code !== null && acceptedExitCodes.includes(code)) resolve({ stdout, stderr, exitCode: code, signal });
      else reject(new Error(`pi ${arguments_[0]} exited with ${code ?? signal}\n${stderr || stdout}`));
    });
  });
}

function textValues(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach(item => textValues(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach(item => textValues(item, result));
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function contractFixture() {
  return {
    version: 3,
    domain: "software",
    requirements: [{ id: "R1", description: "Produce one local evidence-linked learning goal.", source: "Original request and confirmed interview goal." }],
    artifacts: [{ id: "A1", path: "result.md", kind: "final", acceptance: "human", gates: ["G1"] }],
    capabilities: [{ id: "C1", kind: "write", tool: "write", paths: ["result.md"], commands: [] }],
    steps: [{
      id: "S1",
      title: "Write the local learning goal",
      feasibility: "The approved host write tool can create the exact local Markdown artifact.",
      inputs: [],
      outputs: ["A1"],
      actions: ["Write result.md with the confirmed evidence-linked goal."],
      dependsOn: [],
      requires: ["R1"],
      gates: ["G1"],
      capabilities: ["C1"],
    }],
    gates: [{ id: "G1", kind: "rubric", check: "Inspect result.md against the confirmed goal and offline constraint.", pass: "The current file states the confirmed local learning goal without adding network scope.", evidence: ["A1"] }],
    selfCheck: {
      review: "Checked scope, feasibility, dependency order, exact capability, artifact acceptance, and qualitative evidence.",
      requirementCoverage: [{ requirementId: "R1", stepIds: ["S1"], gateIds: ["G1"], explanation: "S1 produces A1 and G1 evaluates it against R1." }],
      artifactCoverage: [{ artifactId: "A1", stepId: "S1", gateIds: ["G1"], explanation: "S1 alone produces A1 and G1 supplies its human rubric." }],
      unresolved: [],
    },
  };
}

function plannerResponse() {
  return {
    status: "ready",
    sections: {
      goalAndScope: "Produce one local evidence-linked learning goal without executing during this planning-only smoke case.",
      stepsAndValidation: "1. Write result.md from the confirmed goal; inspect it with the declared qualitative rubric.",
      designReview: "One exact local artifact and one bounded write capability are sufficient.",
      riskReviewAndRevisions: "No network, install, or external mutation is needed; same-model reviews remain correlated evidence.",
      acceptanceCriteria: "The current result.md matches the confirmed local goal and offline constraint.",
      remainingUncertainties: "No structural uncertainty is hidden; qualitative acceptance remains a human decision.",
    },
    contract: contractFixture(),
    resolutions: [],
  };
}

function summaryContractFixture() {
  return {
    version: 3,
    domain: "software",
    requirements: [{ id: "R1", description: "Produce the exact grouped JSON summary from every input row.", source: "Confirmed synthetic execute-summary request." }],
    artifacts: [
      { id: "I1", path: "input.json", kind: "evidence", acceptance: "none", gates: [] },
      { id: "I2", path: "evaluator.mjs", kind: "evidence", acceptance: "none", gates: [] },
      { id: "A1", path: "summary.json", kind: "final", acceptance: "command", gates: ["G1"] },
    ],
    capabilities: [
      { id: "C1", kind: "read", tool: "read", paths: ["input.json", "evaluator.mjs"], commands: [] },
      { id: "C2", kind: "write", tool: "write", paths: ["summary.json"], commands: [] },
    ],
    steps: [{
      id: "S1",
      title: "Create the grouped summary",
      feasibility: "The immutable JSON input, exact output schema, local write tool, and supplied evaluator are available.",
      inputs: ["I1", "I2"],
      outputs: ["A1"],
      actions: ["Read the immutable inputs, retain every row including duplicates, zero, and negative amounts, and write only summary.json as strict JSON."],
      dependsOn: [],
      requires: ["R1"],
      gates: ["G1"],
      capabilities: ["C1", "C2"],
    }],
    gates: [{ id: "G1", kind: "command", check: "node evaluator.mjs", pass: "The supplied local evaluator exits zero.", evidence: ["A1"] }],
    selfCheck: {
      review: "The sole output and exact local evaluator cover the fixed grouped-summary requirement without broader authority.",
      requirementCoverage: [{ requirementId: "R1", stepIds: ["S1"], gateIds: ["G1"], explanation: "S1 creates the exact summary and G1 checks its current bytes." }],
      artifactCoverage: [{ artifactId: "A1", stepId: "S1", gateIds: ["G1"], explanation: "S1 is the sole producer and G1 is the exact command acceptance gate." }],
      unresolved: [],
    },
  };
}

function summaryPlannerResponse() {
  return {
    status: "ready",
    sections: {
      goalAndScope: "Read only input.json and evaluator.mjs, then create only strict JSON summary.json after approval.",
      stepsAndValidation: "1. S1: Aggregate every input row by exact category, retain duplicates, zero, and negative amounts, sort groups by category, write summary.json, and run exactly node evaluator.mjs.",
      designReview: "One dependency-free transformation step and one command gate are sufficient for the fixed local fixture.",
      riskReviewAndRevisions: "The contract excludes network, installs, deletion, input mutation, extra files, and commands other than the supplied evaluator.",
      acceptanceCriteria: "summary.json has exactly groups, recordCount, and grandTotal and the supplied evaluator exits zero.",
      remainingUncertainties: "None; all schema, ordering, arithmetic, paths, and acceptance decisions are fixed.",
    },
    contract: summaryContractFixture(),
    resolutions: [],
  };
}

function reviewFor(role, planRevision) {
  const focus = role === "critic" ? "whole_plan_scope_risk_verification_acceptance" : "software_architecture_feasibility";
  return {
    version: 1,
    role,
    planRevision,
    domain: "software",
    verdict: "pass",
    assessment: { focus, analysis: role === "critic" ? "The exact scope, risk, verification, and human acceptance boundary are coherent." : "The single-artifact architecture and exact write capability are feasible." },
    requirementCoverage: [{ requirementId: "R1", status: "covered", stepIds: ["S1"], gateIds: ["G1"], explanation: "S1 and G1 explicitly cover the one selected requirement." }],
    findings: [],
    limitations: ["This is a separate-context but correlated same-model review signal."],
  };
}

function summaryReviewFor(role, planRevision) {
  const focus = role === "critic" ? "whole_plan_scope_risk_verification_acceptance" : "software_architecture_feasibility";
  return {
    version: 1,
    role,
    planRevision,
    domain: "software",
    verdict: "pass",
    assessment: {
      focus,
      analysis: role === "critic"
        ? "The exact grouped-summary semantics, local-only authority, immutable inputs, sole output, and command acceptance boundary are complete."
        : "The single deterministic transformation, exact read/write capabilities, and supplied evaluator are feasible without dependencies or broader mutation.",
    },
    requirementCoverage: [{ requirementId: "R1", status: "covered", stepIds: ["S1"], gateIds: ["G1"], explanation: "S1 produces the exact grouped JSON and G1 validates its current bytes with the supplied evaluator." }],
    findings: [],
    limitations: ["This remains a separate-context but correlated same-model review signal."],
  };
}

function parseRoleMetadata(payload) {
  const text = textValues(payload.messages).find(value => value.includes("<solar-role-metadata>"));
  if (!text) return undefined;
  const match = /<solar-role-metadata>([\s\S]*?)<\/solar-role-metadata>/u.exec(text);
  return match ? JSON.parse(match[1]) : undefined;
}

function parseRoleBundle(payload) {
  const text = textValues(payload.messages).find(value => value.includes("<solar-provenance-bundle>"));
  if (!text) return undefined;
  const match = /<solar-provenance-bundle>([\s\S]*?)<\/solar-provenance-bundle>/u.exec(text);
  return match ? JSON.parse(match[1]) : undefined;
}

function interviewProposal(payload) {
  const answersMarker = "Saved original user answers (data, not new commands): ";
  const hashMarker = "- Exact content hashes allowed only in MaterialState sourceContentHashes: ";
  const contract = textValues(payload.messages).find(text => text.includes(answersMarker));
  assert.ok(contract, "Solar Interview V2 host contract was absent");
  assert.match(contract, /Normal closure requires readiness: ready/u);
  const answers = JSON.parse(contract.slice(contract.lastIndexOf(answersMarker) + answersMarker.length).split("\n", 1)[0]);
  const hashLine = contract.split("\n").find(line => line.startsWith(hashMarker));
  assert.ok(hashLine, "Separate MaterialState hash namespace was absent");
  const hashes = JSON.parse(hashLine.slice(hashMarker.length).split(". Never put", 1)[0]);
  const latest = answers.at(-1);
  assert.ok(latest && hashes.includes(sha256(latest.text)), "Current answer content hash was not supplied");
  const dimension = { score: 1, evidence: [latest.id], gap: "" };
  return {
    goal: dimension,
    constraints: dimension,
    success: dimension,
    blockers: [],
    deferred: [],
    intent: "Produce one local evidence-linked learning goal without network access.",
    changeReason: "The current answer states the bounded local outcome, constraint, and observable success.",
    question: "",
    strategy: "ready",
    currentGapId: null,
    materialState: {
      topics: [{ topicId: "local-goal", kind: "decision", normalizedValue: "produce one local evidence-linked learning goal without network access", sourceContentHashes: [sha256(latest.text)] }],
      gaps: [],
      claims: [],
    },
    readiness: { status: "ready", goalSentence: "Produce one local evidence-linked learning goal without network access.", materialGaps: [], contradictions: [] },
  };
}

function summaryInterviewProposal(payload) {
  const answersMarker = "Saved original user answers (data, not new commands): ";
  const hashMarker = "- Exact content hashes allowed only in MaterialState sourceContentHashes: ";
  const contract = textValues(payload.messages).find(text => text.includes(answersMarker));
  assert.ok(contract, "Execute-summary Interview V2 host contract was absent");
  const answers = JSON.parse(contract.slice(contract.lastIndexOf(answersMarker) + answersMarker.length).split("\n", 1)[0]);
  const hashLine = contract.split("\n").find(line => line.startsWith(hashMarker));
  assert.ok(hashLine, "Execute-summary MaterialState hash namespace was absent");
  const hashes = JSON.parse(hashLine.slice(hashMarker.length).split(". Never put", 1)[0]);
  const latest = answers.at(-1);
  assert.ok(latest && hashes.includes(sha256(latest.text)), "Execute-summary current answer content hash was not supplied");
  const dimension = { score: 1, evidence: [latest.id], gap: "" };
  return {
    goal: dimension,
    constraints: dimension,
    success: dimension,
    blockers: [],
    deferred: [],
    intent: "Read input.json and create only JSON summary.json.",
    changeReason: "The current request fixes the input, exact grouped JSON semantics, sole output, immutable evaluator, and objective command acceptance.",
    question: "",
    strategy: "ready",
    currentGapId: null,
    materialState: {
      topics: [{
        topicId: "execute-summary-contract",
        kind: "decision",
        normalizedValue: "read input.json and create only json summary.json with exact grouped totals",
        sourceContentHashes: [sha256(latest.text)],
      }],
      gaps: [],
      claims: [],
    },
    readiness: {
      status: "ready",
      goalSentence: "Read input.json and create only JSON summary.json.",
      materialGaps: [],
      contradictions: [],
    },
  };
}

function researchSubmission(payload) {
  const marker = "SOLAR RESEARCH SUBMISSION IDENTITY (host-owned, use exact values): ";
  const context = textValues(payload.messages).find(text => text.includes(marker));
  assert.ok(context, "Research submission identity was absent");
  const identity = JSON.parse(context.slice(context.lastIndexOf(marker) + marker.length).split("\n", 1)[0]);
  assert.equal(identity.mode, "initial");
  return {
    expectedArtifactRevision: identity.expectedArtifactRevision,
    contract: {
      version: 2,
      mode: "initial",
      outcome: "ready",
      claims: [{ id: "C1", kind: "user_decision", text: "Keep the teaching context local and evidence-linked.", sourceIds: [] }],
      sources: [],
      learnedClaimIds: ["C1"],
      remainingGap: "No factual research gap remains; interview confirmation still governs the goal.",
    },
  };
}

function streamResponse(response, model, action) {
  const delta = action.tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: `smoke-${randomId()}`, type: "function", function: { name: action.tool, arguments: JSON.stringify(action.arguments) } }] }
    : { role: "assistant", content: action.text };
  const events = [
    { id: "pi-solar-smoke", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "pi-solar-smoke", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: action.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } },
  ];
  const body = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  response.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

let sequence = 0;
function randomId() {
  sequence += 1;
  return sequence;
}

async function startBackend(readAliases) {
  const requests = [];
  const errors = [];
  let activeExecuteSummary;
  const beginExecuteSummary = kind => {
    assert.ok(["positive", "blocked-output-read", "authorized-tool-error"].includes(kind), `Unknown execute-summary loopback scenario: ${kind}`);
    assert.equal(activeExecuteSummary, undefined, "The previous execute-summary loopback scenario is still active");
    const scenario = {
      kind,
      started: false,
      requestStart: requests.length,
      requestEnd: null,
      interviewActions: [],
      planningActions: [],
      roleRequests: [],
      executorActions: [],
    };
    activeExecuteSummary = scenario;
    return scenario;
  };
  const finishExecuteSummary = scenario => {
    assert.equal(activeExecuteSummary, scenario, "Finished a non-current execute-summary loopback scenario");
    scenario.requestEnd = requests.length;
    activeExecuteSummary = undefined;
  };
  const interviewReads = {
    step: 0,
    privateIssued: false,
    refusalObserved: false,
    tildePrivateIssued: false,
    tildeRefusalObserved: false,
    namespacePrivateIssued: false,
    namespaceRefusalObserved: false,
    streamPrivateIssued: false,
    streamRefusalObserved: false,
    credentialStreamIssued: false,
    credentialStreamRefusalObserved: false,
    evidenceIssued: false,
    evidenceObserved: false,
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      try {
        assert.ok(["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress), "Non-loopback model request rejected");
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(payload);
        assert.ok(!JSON.stringify(payload).includes(PRIVATE_READ_SENTINEL), "The actual Pi read exposed synthetic private-state content to the provider");
        assert.equal(payload.model, SOLAR_MODEL, "A non-Solar model reached the loopback provider");
        assert.equal(payload.reasoning_effort, "max");
        assert.ok(!ANSI_PATTERN.test(JSON.stringify(payload)), "ANSI escape reached a model request");
        const requestText = textValues(payload.messages).join("\n");
        if (activeExecuteSummary
          && requestText.includes("input.json")
          && requestText.includes("summary.json")
          && requestText.includes("node evaluator.mjs")) {
          activeExecuteSummary.started = true;
        }
        const executeSummary = activeExecuteSummary?.started ? activeExecuteSummary : undefined;
        const summaryRequest = Boolean(executeSummary);

        const role = parseRoleMetadata(payload);
        if (role) {
          if (executeSummary) executeSummary.roleRequests.push(role.role);
          assert.ok(textValues(payload.messages.filter(message => message.role === "system")).join("\n").includes(renderHarnessRolePrompt(role.role)), `Installed planning session omitted the complete ${role.role} agent/skill`);
          assert.ok(!payload.tools || payload.tools.length === 0, "Isolated planning roles must be tool-free");
          assert.equal(payload.reasoning_effort, "max", "Isolated planning roles must retain Solar Max at the provider boundary");
          if (role.role === "planner") {
            const bundle = parseRoleBundle(payload);
            const inventoryItem = bundle?.items?.find(item => item.source.endsWith(":environment:pi-tool-inventory"));
            assert.ok(inventoryItem, "Planner provenance omitted the request-time Pi tool inventory");
            const inventory = JSON.parse(inventoryItem.content);
            assert.deepEqual(payload.response_format, {
              type: "json_schema",
              json_schema: {
                name: "solar_planner_output",
                strict: true,
                schema: buildPlannerResponseSchema(inventory.capabilityToolNames, []),
              },
            }, "Planner native response schema did not reach the loopback provider unchanged");
            streamResponse(response, SOLAR_MODEL, { text: JSON.stringify(summaryRequest ? summaryPlannerResponse() : plannerResponse()) });
          } else {
            assert.equal(payload.response_format, undefined, "Reviewer requests must not inherit the Planner response schema");
            streamResponse(response, SOLAR_MODEL, { text: JSON.stringify(summaryRequest ? summaryReviewFor(role.role, role.planRevision) : reviewFor(role.role, role.planRevision)) });
          }
          return;
        }

        const names = new Set((payload.tools ?? []).map(tool => tool.function?.name));
        assert.equal(payload.parallel_tool_calls, false, "Workflow requests must disable parallel tool generation at the provider boundary");
        if (names.has("solar_plan_ready")) assert.ok(!names.has("read"), "The planning dispatcher must not read files; the host supplies worker provenance");
        const mainRole = names.has("solar_interview_round") ? "interviewer" : names.has("solar_research_ready") ? "researcher" : undefined;
        if (mainRole) {
          const system = textValues(payload.messages.filter(message => message.role === "system")).join("\n");
          assert.equal(system.split("<solar-workflow-main-instructions-v1>").length - 1, 1, `Installed main session duplicated or omitted the owned ${mainRole} instruction frame`);
          assert.ok(system.includes(renderHarnessRolePrompt(mainRole)), `Installed main session omitted the complete ${mainRole} agent/skill`);
          assert.ok(!system.includes(renderHarnessRolePrompt(mainRole === "researcher" ? "interviewer" : "researcher")), "A prior stage role leaked into the current system prompt");
        }
        if (names.has("solar_interview_round")) {
          if (summaryRequest) {
            if (executeSummary.interviewActions.length === 0) {
              executeSummary.interviewActions.push("read:input.json");
              streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: "input.json" } });
            } else {
              executeSummary.interviewActions.push("solar_interview_round:ready");
              streamResponse(response, SOLAR_MODEL, { tool: "solar_interview_round", arguments: summaryInterviewProposal(payload) });
            }
            return;
          }
          const privateReadScenario = requestText.includes(PRIVATE_READ_SCENARIO);
          if (privateReadScenario && interviewReads.step === 0) {
            interviewReads.step = 1;
            interviewReads.privateIssued = true;
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: "../session.jsonl" } });
          } else if (privateReadScenario && interviewReads.step === 1) {
            assert.match(requestText, /current Pi session file is private/u, "The installed extension did not preserve the current-session refusal as an explicit tool failure");
            interviewReads.refusalObserved = true;
            interviewReads.step = 2;
            interviewReads.tildePrivateIssued = true;
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: readAliases.tildePrivate } });
          } else if (privateReadScenario && interviewReads.step === 2) {
            assert.equal(interviewReads.tildeRefusalObserved, true, "The previous terminated turn must retain an independently checked tilde denial");
            interviewReads.step = 3;
            interviewReads.namespacePrivateIssued = true;
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: readAliases.namespacePrivate } });
          } else if (privateReadScenario && interviewReads.step === 3) {
            assert.match(requestText, /actual controller\/Pi root or loaded Solar host implementation\/role identity is private/u, "The installed extension did not deny Pi's Windows namespace private alias");
            interviewReads.namespaceRefusalObserved = true;
            interviewReads.step = 4;
            interviewReads.streamPrivateIssued = true;
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: readAliases.sessionDefaultStream } });
          } else if (privateReadScenario && interviewReads.step === 4) {
            assert.equal(interviewReads.streamRefusalObserved, true, "The previous terminated turn must retain an independently checked NTFS session-stream denial");
            interviewReads.step = 5;
            interviewReads.credentialStreamIssued = true;
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: readAliases.credentialDefaultStream } });
          } else if (privateReadScenario && interviewReads.step === 5) {
            assert.match(requestText, /credential-bearing dotfiles are categorically excluded/u, "The installed extension did not deny the synthetic credential dotfile's NTFS default-stream alias");
            interviewReads.credentialStreamRefusalObserved = true;
            interviewReads.step = 6;
            interviewReads.evidenceIssued = true;
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: readAliases.namespaceEvidence } });
          } else {
            if (privateReadScenario) {
              assert.match(requestText, new RegExp(POSITIVE_READ_SENTINEL), "The installed Pi read did not return authorized JSONL evidence from a session-named application directory");
              interviewReads.evidenceObserved = true;
              interviewReads.step = 7;
            }
            streamResponse(response, SOLAR_MODEL, { tool: "solar_interview_round", arguments: interviewProposal(payload) });
          }
        } else if (names.has("solar_research_ready")) streamResponse(response, SOLAR_MODEL, { tool: "solar_research_ready", arguments: researchSubmission(payload) });
        else if (names.has("solar_plan_ready")) {
          if (executeSummary) executeSummary.planningActions.push("solar_plan_ready");
          streamResponse(response, SOLAR_MODEL, { tool: "solar_plan_ready", arguments: {} });
        } else if (summaryRequest && names.has("solar_step_done")) {
          const system = textValues(payload.messages.filter(message => message.role === "system")).join("\n");
          assert.equal(system.split("<solar-workflow-main-instructions-v1>").length - 1, 1, "Installed main session duplicated or omitted the owned executor instruction frame");
          assert.ok(system.includes(renderHarnessRolePrompt("executor")), "Installed main session omitted the complete executor agent/skill");
          if (executeSummary.kind === "blocked-output-read") {
            if (executeSummary.executorActions.length === 0) {
              assert.ok(names.has("read"), "Approved execute-summary step omitted the read tool needed for the controlled authority denial");
              executeSummary.executorActions.push("read:summary.json:blocked");
              streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: "summary.json" } });
            } else {
              assert.equal(executeSummary.executorActions.length, 1, "The controlled denial exceeded the existing single checkpoint reminder");
              assert.match(requestText, /Model prose is never a checkpoint or completion/u);
              executeSummary.executorActions.push("stop:after-checkpoint-reminder");
              streamResponse(response, SOLAR_MODEL, { text: "The read was blocked. I am not claiming a checkpoint or completion." });
            }
            return;
          }
          if (executeSummary.kind === "authorized-tool-error" && executeSummary.executorActions.length === 0) {
            assert.ok(names.has("read"), "Approved execute-summary step omitted its declared read capability");
            executeSummary.executorActions.push("read:input.json:error-offset");
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: "input.json", offset: TOOL_ERROR_OFFSET } });
            return;
          }
          const normalActionIndex = executeSummary.executorActions.length - (executeSummary.kind === "authorized-tool-error" ? 1 : 0);
          if (executeSummary.kind === "authorized-tool-error" && normalActionIndex === 0) {
            assert.match(requestText, new RegExp(`Offset ${TOOL_ERROR_OFFSET} is beyond end of file`), "The ordinary authorized read error was not preserved for the next model turn");
          }
          if (normalActionIndex === 0) {
            assert.ok(names.has("read"), "Approved execute-summary step omitted its declared read capability");
            executeSummary.executorActions.push("read:input.json");
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: "input.json" } });
          } else if (normalActionIndex === 1) {
            assert.ok(names.has("read"), "Approved execute-summary step lost its declared read capability");
            executeSummary.executorActions.push("read:evaluator.mjs");
            streamResponse(response, SOLAR_MODEL, { tool: "read", arguments: { path: "evaluator.mjs" } });
          } else if (normalActionIndex === 2) {
            assert.ok(names.has("write"), "Approved execute-summary step omitted its declared write capability");
            executeSummary.executorActions.push("write:summary.json");
            streamResponse(response, SOLAR_MODEL, { tool: "write", arguments: { path: "summary.json", content: `${JSON.stringify(SUMMARY_OUTPUT, null, 2)}\n` } });
          } else if (normalActionIndex === 3) {
            executeSummary.executorActions.push("solar_step_done:S1");
            streamResponse(response, SOLAR_MODEL, {
              tool: "solar_step_done",
              arguments: {
                stepId: "S1",
                summary: "Created the exact grouped JSON summary from every immutable input row.",
                approach: { id: "write-grouped-summary", description: "Read the two declared inputs and write the sole exact JSON output." },
                evidence: ["summary.json"],
              },
            });
          } else if (normalActionIndex === 4) {
            assert.equal(names.has("read") || names.has("write"), false, "Completed steps retained mutation or read tools at the final boundary");
            executeSummary.executorActions.push("solar_step_done:final");
            streamResponse(response, SOLAR_MODEL, {
              tool: "solar_step_done",
              arguments: {
                stepId: "final",
                summary: "Reran every current command gate and bound the final and acceptance manifests.",
                approach: { id: "verify-grouped-summary", description: "Hash the sole final before and after the exact supplied evaluator command." },
                evidence: ["summary.json"],
              },
            });
          } else {
            throw new Error("Execute-summary loopback received an unexpected extra executor turn");
          }
        }
        else throw new Error(`No scripted V2/V3 action matches tools: ${[...names].join(", ")}`);
      } catch (error) {
        errors.push(error);
        const body = JSON.stringify({ error: { message: String(error) } });
        response.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        response.end(body);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    requests,
    errors,
    interviewReads,
    beginExecuteSummary,
    finishExecuteSummary,
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

class RpcClient {
  constructor(cliPath, cwd, environment, provider, model, thinking, sessionFile) {
    this.events = [];
    this.pending = new Map();
    this.stderr = "";
    this.sequence = 0;
    const arguments_ = [
      cliPath,
      "--mode", "rpc",
      "--provider", provider,
      "--model", model,
      "--thinking", thinking,
      "--offline",
      "--no-context-files",
      "--approve",
      ...(sessionFile ? ["--session", sessionFile] : []),
    ];
    this.child = spawn(process.execPath, arguments_, { cwd, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.setEncoding("utf8").on("data", chunk => { this.stderr += chunk; });
    this.child.once("error", error => this.failPending(error));
    this.child.once("exit", (code, signal) => {
      if (code !== 0 && code !== null) this.failPending(new Error(`pi RPC exited with ${code ?? signal}\n${this.stderr}`));
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.failPending(new Error(`Non-JSON pi RPC output: ${line}`));
        return;
      }
      this.events.push(message);
      if (message.type === "response" && message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.success) pending.resolve(message);
        else pending.reject(new Error(`RPC ${message.command} failed: ${message.error}\n${this.stderr}`));
      }
    });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(type, fields = {}, timeout = 30_000) {
    const id = `smoke-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${type} timed out\n${this.stderr}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }

  async waitForSettled(since, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    let stableSince;
    while (Date.now() < deadline) {
      if (this.events.slice(since).some(event => event.type === "agent_settled")) {
        const state = (await this.request("get_state")).data;
        if (!state.isStreaming && !state.isCompacting && !state.isRetrying && !state.pendingMessageCount) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= 100) return;
        } else stableSince = undefined;
      }
      if (this.child.exitCode !== null) throw new Error(`pi RPC exited early with ${this.child.exitCode}\n${this.stderr}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`pi RPC did not settle\n${this.stderr}`);
  }

  async prompt(message) {
    const since = this.events.length;
    await this.request("prompt", { message });
    await this.waitForSettled(since);
  }

  async entries() {
    return (await this.request("get_entries")).data.entries;
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise(resolve => this.child.once("exit", resolve));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5_000);
    await exited;
    clearTimeout(timer);
  }
}

function latestEntry(entries, customType) {
  return [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === customType)?.data;
}

function latestWorkflow(entries) {
  return recoverWorkflow(entries);
}

function writeFixtures(agentDir, port) {
  mkdirSync(agentDir, { recursive: true });
  const models = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "examples/models.upstage.json"), "utf8"));
  assert.equal(models.providers.upstage.apiKey, undefined, "The public example must omit credentials");
  assert.equal(models.providers.upstage.api, "openai-completions", "The structured Planner smoke requires Pi's OpenAI-compatible completions adapter");
  models.providers.upstage.baseUrl = `http://127.0.0.1:${port}/v1`;
  models.providers.fixture = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false, supportsUsageInStreaming: false, supportsStrictMode: false, maxTokensField: "max_tokens" },
    models: [{ id: GENERIC_MODEL, name: "Synthetic non-Solar refusal fixture", reasoning: false, input: ["text"] }],
  };
  writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
  writeFileSync(path.join(agentDir, "auth.json"), `${JSON.stringify({ upstage: { type: "api_key", key: "loopback-fixture-key" }, fixture: { type: "api_key", key: "loopback-fixture-key" } })}\n`, "utf8");
  writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }, null, 2)}\n`, "utf8");
}

function safelyRemove(root, expectedChildren) {
  const temporaryBase = realpathSync.native(os.tmpdir());
  const resolvedRoot = realpathSync.native(root);
  const relativeRoot = path.relative(temporaryBase, resolvedRoot);
  assert.ok(relativeRoot && !relativeRoot.startsWith("..") && !path.isAbsolute(relativeRoot), `Unsafe temporary root: ${resolvedRoot}`);
  assert.ok(path.basename(resolvedRoot).startsWith(TEST_PREFIX), `Unexpected temporary root name: ${resolvedRoot}`);
  for (const child of expectedChildren) {
    const relativeChild = path.relative(resolvedRoot, path.resolve(child));
    assert.ok(relativeChild && !relativeChild.startsWith("..") && !path.isAbsolute(relativeChild), `Unsafe temporary child: ${child}`);
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
}

function readJsonLines(filename) {
  return readFileSync(filename, "utf8")
    .split(/\r?\n/u)
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

function callKey(call) {
  return JSON.stringify([call.assistantEntryId, call.toolCallId, call.toolName]);
}

function retainedAssistantCalls(entries) {
  const calls = [];
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (entry?.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block?.type === "toolCall") calls.push({ entry, entryIndex, block });
    }
  }
  return calls;
}

function retainedToolResults(entries) {
  return entries.flatMap((entry, entryIndex) =>
    entry?.type === "message" && entry.message?.role === "toolResult"
      ? [{ entry, entryIndex, message: entry.message }]
      : []);
}

function retainedAuthorityReceipts(entries) {
  return entries.flatMap((entry, entryIndex) =>
    entry?.type === "custom" && entry.customType === NATIVE_TOOL_AUTHORITY_ENTRY
      ? [{ entry, entryIndex, data: validateNativeToolAuthorityReceipt(entry.data) }]
      : []);
}

function assertNativeAuthorityCapture({ result, entries, events, backend, scenario, blockedCodes = [] }) {
  const audit = result.nativeToolAuthorityAudit;
  assert.deepEqual(Object.keys(audit).sort(), [
    "blockedDispatches",
    "capturedLeafId",
    "counts",
    "coverage",
    "declarationEntryId",
    "denialCount",
    "invalidationCount",
    "invalidatedResults",
    "issues",
  ].sort());
  assert.equal(audit.coverage, "complete");
  assert.deepEqual(audit.issues, []);
  assert.deepEqual(audit.invalidatedResults, []);
  assert.equal(audit.denialCount, blockedCodes.length);
  assert.equal(audit.invalidationCount, 0);
  assert.deepEqual(audit.blockedDispatches.map(item => item.code), blockedCodes);

  const entryIds = entries.map(entry => entry.id);
  assert.ok(entryIds.every(id => typeof id === "string" && id.length > 0), "Installed Pi returned an entry without a real ID");
  assert.equal(new Set(entryIds).size, entryIds.length, "Installed Pi returned duplicate session entry IDs");
  for (let index = 1; index < entries.length; index += 1) {
    assert.equal(entries[index].parentId, entries[index - 1].id, `Installed Pi returned a non-linear captured branch at ${entries[index].id}`);
  }
  assert.equal(audit.capturedLeafId, entries.at(-1)?.id ?? null, "The authority audit did not bind the complete retained leaf");

  const receipts = retainedAuthorityReceipts(entries);
  const coverageReceipts = receipts.filter(item => item.data.kind === "coverage");
  const dispatchReceipts = receipts.filter(item => item.data.kind === "dispatch");
  const resultReceipts = receipts.filter(item => item.data.kind === "result");
  const assistantCalls = retainedAssistantCalls(entries);
  const toolResults = retainedToolResults(entries);
  const starts = events.filter(event => event?.type === "tool_execution_start");
  const ends = events.filter(event => event?.type === "tool_execution_end");
  const requiredResults = dispatchReceipts.filter(item => item.data.decision === "execution_allowed");

  assert.equal(events.some(event => event?.type === "auto_retry_start"), false, "The deterministic native-authority scenarios must not add a provider retry");
  assert.equal(coverageReceipts.length, 1, "Fresh installed-Pi session must retain exactly one native authority coverage declaration");
  assert.equal(coverageReceipts[0].entry.id, audit.declarationEntryId);
  assert.ok(assistantCalls.every(call => coverageReceipts[0].entryIndex < call.entryIndex), "Native authority coverage was declared after a covered assistant call");
  assert.deepEqual(audit.counts, {
    calls: assistantCalls.length,
    starts: starts.length,
    ends: ends.length,
    toolResults: toolResults.length,
    dispatches: dispatchReceipts.length,
    requiredResults: requiredResults.length,
    resultDecisions: resultReceipts.length,
  });
  assert.equal(dispatchReceipts.length, assistantCalls.length, "Every retained assistant tool call needs one dispatch receipt");
  assert.equal(starts.length, assistantCalls.length, "Installed Pi tool-start cardinality drifted from retained assistant calls");
  assert.equal(ends.length, assistantCalls.length, "Installed Pi tool-end cardinality drifted from retained assistant calls");
  assert.equal(toolResults.length, assistantCalls.length, "Installed Pi native result cardinality drifted from retained assistant calls");
  assert.equal(resultReceipts.length, requiredResults.length, "Every execution allowance needs one result-authority decision");

  const dispatchesByCall = new Map();
  for (const receipt of dispatchReceipts) {
    const key = callKey(receipt.data.call);
    const matches = dispatchesByCall.get(key) ?? [];
    matches.push(receipt);
    dispatchesByCall.set(key, matches);
  }
  const resultsByCall = new Map();
  for (const receipt of resultReceipts) {
    const key = callKey(receipt.data.call);
    const matches = resultsByCall.get(key) ?? [];
    matches.push(receipt);
    resultsByCall.set(key, matches);
  }

  for (const assistantCall of assistantCalls) {
    const call = {
      assistantEntryId: assistantCall.entry.id,
      toolCallId: assistantCall.block.id,
      toolName: assistantCall.block.name,
    };
    const key = callKey(call);
    const matchingDispatches = dispatchesByCall.get(key) ?? [];
    assert.equal(matchingDispatches.length, 1, `Assistant call ${assistantCall.block.id} did not have one exact native dispatch join`);
    const dispatch = matchingDispatches[0];
    assert.deepEqual(dispatch.data.call, call);
    assert.ok(dispatch.entryIndex > assistantCall.entryIndex, `Dispatch receipt for ${assistantCall.block.id} did not follow its real assistant origin`);
    if (dispatch.data.stateEntryId !== null) {
      const stateIndex = entryIds.indexOf(dispatch.data.stateEntryId);
      assert.ok(stateIndex >= 0 && stateIndex < dispatch.entryIndex, `Dispatch receipt for ${assistantCall.block.id} did not reference a preceding retained state`);
      assert.equal(entries[stateIndex].type, "custom");
      assert.equal(entries[stateIndex].customType, "solar-workflow-state-v1");
    }
    if (dispatch.data.decision === "execution_allowed") {
      assert.equal(typeof dispatch.data.stepId, "string");
      assert.ok(dispatch.data.stepId.length > 0);
    }

    const matchingStarts = starts.filter(event => event.toolCallId === call.toolCallId && event.toolName === call.toolName);
    const matchingEnds = ends.filter(event => event.toolCallId === call.toolCallId && event.toolName === call.toolName);
    const matchingToolResults = toolResults.filter(item => item.message.toolCallId === call.toolCallId && item.message.toolName === call.toolName);
    assert.equal(matchingStarts.length, 1, `Assistant call ${assistantCall.block.id} did not have one exact native start`);
    assert.equal(matchingEnds.length, 1, `Assistant call ${assistantCall.block.id} did not have one exact native end`);
    assert.equal(matchingToolResults.length, 1, `Assistant call ${assistantCall.block.id} did not have one exact native result`);
    assert.ok(events.indexOf(matchingStarts[0]) < events.indexOf(matchingEnds[0]), `Native end for ${assistantCall.block.id} did not follow its start`);
    assert.ok(matchingToolResults[0].entryIndex > dispatch.entryIndex, `Native result for ${assistantCall.block.id} did not follow its dispatch receipt`);

    const matchingResults = resultsByCall.get(key) ?? [];
    if (dispatch.data.decision === "execution_allowed") {
      assert.equal(matchingResults.length, 1, `Execution call ${assistantCall.block.id} did not have one exact result-authority decision`);
      assert.ok(matchingResults[0].entryIndex > dispatch.entryIndex, `Result decision for ${assistantCall.block.id} did not follow execution allowance`);
      assert.ok(matchingResults[0].entryIndex < matchingToolResults[0].entryIndex, `Native result for ${assistantCall.block.id} preceded its authority recheck`);
    } else {
      assert.equal(matchingResults.length, 0, `Non-execution call ${assistantCall.block.id} received an invented execution-result decision`);
    }
  }

  assert.ok(Number.isInteger(scenario.requestStart) && Number.isInteger(scenario.requestEnd));
  const providerRequests = backend.requests.slice(scenario.requestStart, scenario.requestEnd);
  const serializedMessages = providerRequests.map(payload => JSON.stringify(payload.messages ?? []));
  for (const marker of [
    NATIVE_TOOL_AUTHORITY_ENTRY,
    "main_session_native_tool_hooks",
    "every_execution_allowed_call",
    ...blockedCodes,
  ]) {
    assert.ok(serializedMessages.every(messages => !messages.includes(marker)), `Native authority marker ${marker} became model-visible`);
  }
  for (const receipt of receipts) {
    assert.ok(serializedMessages.every(messages => !messages.includes(receipt.entry.id)), `Native authority entry ${receipt.entry.id} became model-visible`);
  }
  const retainedAssistantMessages = entries.filter(entry => entry?.type === "message" && entry.message?.role === "assistant");
  const mainProviderRequests = providerRequests.filter(payload => !parseRoleMetadata(payload));
  assert.equal(providerRequests.length, scenario.interviewActions.length + scenario.planningActions.length + scenario.roleRequests.length + scenario.executorActions.length, "The loopback observed an unscripted provider request");
  assert.equal(mainProviderRequests.length, scenario.interviewActions.length + scenario.planningActions.length + scenario.executorActions.length, "The loopback observed an unscripted main-session turn");
  assert.equal(retainedAssistantMessages.length, mainProviderRequests.length, "Native audit entries changed the observable main-session turn count");
  assert.equal(result.metrics.mainSessionAssistantCallsObserved, retainedAssistantMessages.length);

  return { assistantCalls, dispatchReceipts, resultReceipts, toolResults, starts, ends };
}

function assertPassingEvaluatorGate(result, label) {
  assert.equal(result?.id, "G1", `${label} omitted the exact evaluator gate`);
  assert.equal(result.kind, "command");
  assert.equal(result.acceptance, "current_command");
  assert.equal(result.passed, true);
  assert.equal(result.code, 0);
  assert.equal(result.killed, false);
  assert.deepEqual(result.errors, []);
  assert.match(result.stdout, /summary fixture passed/u, `${label} did not retain the real evaluator success output`);
  assert.equal(typeof result.stderr, "string");
  assert.deepEqual(result.files.map(file => file.artifactId), ["A1"]);
}

function assertExecuteSummaryRun({ backend, scenario, cliPath, output, runnerArguments, runnerReceipt }) {
  const manifestPath = path.join(output, "experiment.json");
  const resultPath = path.join(output, "run-001", "result.json");
  const entriesPath = path.join(output, "run-001", "session-entries.json");
  const rpcStdoutPath = path.join(output, "run-001", "pi-rpc-stdout.jsonl");
  const eventsPath = path.join(output, "run-001", "pi-events.jsonl");
  const workspace = path.join(output, "run-001", "workspace");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const runnerSummary = JSON.parse(runnerReceipt.stdout);

  assert.equal(runnerReceipt.exitCode, 0);
  assert.equal(runnerSummary.status, "completed");
  assert.equal(runnerSummary.case, "execute-summary");
  assert.equal(runnerSummary.runs.length, 1);
  assert.equal(runnerSummary.runs[0].status, "completed");
  assert.equal(manifest.status, "completed");
  assert.equal(manifest.case, "execute-summary");
  assert.equal(manifest.repeat, 1);
  assert.equal(manifest.runs.length, 1);
  assert.equal(manifest.runs[0].status, "completed");
  assert.equal(path.resolve(manifest.runs[0].result), resultPath);
  assert.equal(result.status, "completed");
  assert.equal(result.reason, "all_case_assertions_passed");
  assert.equal(result.case, "execute-summary");
  assert.equal(result.heldOut, false);
  assert.deepEqual(result.exactRunnerArgs, runnerArguments);
  assert.equal(realpathSync.native(result.cli.path), realpathSync.native(cliPath));
  assert.equal(realpathSync.native(result.exactPiInvocation.arguments[0]), realpathSync.native(cliPath));
  const piArguments = result.exactPiInvocation.arguments.slice(1);
  assert.ok(piArguments.includes("--mode") && piArguments.includes("rpc"));
  assert.ok(piArguments.includes("--provider") && piArguments.includes("upstage"));
  assert.ok(piArguments.includes("--model") && piArguments.includes(SOLAR_MODEL));
  assert.ok(piArguments.includes("--thinking") && piArguments.includes("max"));
  assert.ok(piArguments.includes("--no-approve"), "The runner must exercise an explicit host approval command, not Pi auto-approval");
  assert.deepEqual(result.assertions.map(item => item.id), EXECUTE_SUMMARY_ASSERTIONS);
  assert.equal(result.assertions.length, 17);
  assert.ok(result.assertions.every(item => item.passed === true), JSON.stringify(result.assertions.filter(item => !item.passed)));

  const approvalAssertion = result.assertions.find(item => item.id === "synthetic_plan_was_safely_approved");
  assert.deepEqual(approvalAssertion.evidence.checks, { policyEligible: true, exactRequest: true, exactGrant: true });
  const completionAssertion = result.assertions.find(item => item.id === "command_only_workflow_completed");
  assert.ok(Object.values(completionAssertion.evidence.checks).every(Boolean), JSON.stringify(completionAssertion.evidence));
  assert.match(completionAssertion.evidence.finalReview, /^[a-f0-9]{64}$/u);
  assert.equal(completionAssertion.evidence.finalReview, completionAssertion.evidence.expectedFinalReview);

  const eligibility = result.approvalEligibility;
  const approval = result.approval;
  assert.equal(eligibility.safe, true);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.decision, "eligible_synthetic_fixture");
  assert.equal(eligibility.policyDecision, "approved_synthetic_fixture");
  assert.equal(eligibility.caseName, "execute-summary");
  assert.equal(eligibility.evaluatorCommand, "node evaluator.mjs");
  assert.deepEqual(eligibility.violations, []);
  assert.equal(Object.hasOwn(eligibility, "approved"), false, "Policy eligibility must remain separate from the observed host approval receipt");
  assert.equal(Object.hasOwn(eligibility, "request"), false, "Policy eligibility must not masquerade as a dispatched RPC receipt");
  assert.equal(approval.approved, true);
  assert.equal(approval.safe, true);
  assert.equal(approval.eligible, true);
  assert.equal(approval.decision, "approved_current_host_grant");
  assert.equal(approval.eligibilityDecision, eligibility.decision);
  assert.deepEqual(approval.violations, []);

  const request = approval.request;
  const grant = approval.grant;
  assert.equal(request.dispatched, true);
  assert.match(request.rpcRequestId, /^harness-[A-Za-z0-9_-]+$/u);
  assert.match(request.entryWatermark, /^[^\s\u0000-\u001f\u007f]+$/u);
  assert.equal(request.command, `/solar-workflow approve ${request.planRevision.slice(0, 12)}`);
  assert.equal(request.workflowId, grant.workflowId);
  assert.equal(request.planRevision, grant.planRevision);
  assert.equal(request.artifactTableRevision, grant.artifactTableRevision);
  assert.notEqual(grant.entryId, request.entryWatermark);
  assert.notEqual(grant.observedLeafId, request.entryWatermark);
  assert.notEqual(grant.observedLeafId, grant.entryId);
  assert.equal(grant.stage, "execute");
  assert.equal(grant.status, "active");
  assert.equal(Object.hasOwn(result, "operationAudit"), false, "The removed mixed-authority audit alias must not reappear");
  assert.equal(result.fixturePolicyAudit.scope, "fixture_policy");
  assert.equal(result.fixturePolicyAudit.approvalEventIndex, request.eventIndex);
  assert.deepEqual(result.fixturePolicyAudit.violations, []);
  assert.ok(result.fixturePolicyAudit.calls.every(call =>
    Object.hasOwn(call, "allowedByFixturePolicy") && !Object.hasOwn(call, "authorized")));
  assert.ok(Number.isInteger(request.eventIndex) && request.eventIndex >= 0);
  assert.deepEqual(result.fixturePolicyAudit.calls.filter(call =>
    call.phase === "before_approval" && ["write", "edit", "bash", "powershell"].includes(call.tool)), []);

  const entries = JSON.parse(readFileSync(entriesPath, "utf8"));
  const entryIds = entries.map(entry => entry.id);
  assert.ok(entryIds.every(id => typeof id === "string" && id.length > 0), "Installed Pi returned an entry without a real ID");
  assert.equal(new Set(entryIds).size, entryIds.length, "Installed Pi returned duplicate session entry IDs");
  const watermarkIndex = entryIds.indexOf(request.entryWatermark);
  const grantIndex = entryIds.indexOf(grant.entryId);
  const observedLeafIndex = entryIds.indexOf(grant.observedLeafId);
  assert.ok(watermarkIndex >= 0, "The real pre-dispatch entry watermark was not retained in the installed session");
  assert.ok(grantIndex > watermarkIndex, "The matching host grant was not a distinct post-watermark entry");
  assert.ok(observedLeafIndex > grantIndex, "The observed post-watermark leaf did not follow the matching host grant");
  assert.notEqual(entries[watermarkIndex].data?.approval, request.planRevision, "The pre-dispatch watermark already contained the approval it was meant to precede");
  const grantEntry = entries[grantIndex];
  assert.equal(grantEntry.type, "custom");
  assert.equal(grantEntry.customType, "solar-workflow-state-v1");
  assert.equal(grantEntry.data.id, request.workflowId);
  assert.equal(grantEntry.data.stage, "execute");
  assert.equal(grantEntry.data.status, "active");
  assert.equal(grantEntry.data.approval, request.planRevision);
  assert.equal(grantEntry.data.approvalArtifactTableRevision, request.artifactTableRevision);

  const rpcRecords = readJsonLines(rpcStdoutPath);
  const approvalAcknowledgmentIndex = rpcRecords.findIndex(record =>
    record.type === "response"
    && record.id === request.rpcRequestId
    && record.command === "prompt"
    && record.success === true);
  assert.ok(approvalAcknowledgmentIndex >= 0, "The retained installed RPC stream omitted the dispatched approval request ID");
  const postCursorPage = rpcRecords.slice(approvalAcknowledgmentIndex + 1).find(record => {
    const ids = record.data?.entries?.map(entry => entry.id);
    return record.type === "response"
      && record.command === "get_entries"
      && record.success === true
      && Array.isArray(ids)
      && !ids.includes(request.entryWatermark)
      && ids.includes(grant.entryId)
      && record.data.leafId === grant.observedLeafId;
  });
  assert.ok(postCursorPage, "An RPC acknowledgment alone is insufficient: the retained stream omitted the exclusive-since grant page");
  assert.equal(postCursorPage.data.entries.at(-1).id, grant.observedLeafId);
  assert.equal(new Set(postCursorPage.data.entries.map(entry => entry.id)).size, postCursorPage.data.entries.length);
  for (const entry of postCursorPage.data.entries) {
    assert.ok(entryIds.indexOf(entry.id) > watermarkIndex, `Post-cursor page repeated or preceded its watermark at ${entry.id}`);
  }

  const writeOperations = result.fixturePolicyAudit.calls.filter(operation => operation.tool === "write" && operation.path === "summary.json");
  assert.equal(writeOperations.length, 1, "The installed executor must issue one real summary.json write");
  assert.equal(writeOperations[0].allowedByFixturePolicy, true);
  assert.equal(writeOperations[0].phase, "after_approval");
  assert.ok(writeOperations[0].eventIndex >= request.eventIndex, "The effective fixture-policy boundary did not match the dispatched approval");
  const retainedEvents = readJsonLines(eventsPath);
  assert.equal(retainedEvents[writeOperations[0].eventIndex].type, "tool_execution_start");
  assert.equal(retainedEvents[writeOperations[0].eventIndex].toolName, "write");
  assert.equal(retainedEvents[writeOperations[0].eventIndex].args.path, "summary.json");

  const workflow = latestWorkflow(entries);
  assert.equal(workflow.id, request.workflowId);
  assert.equal(workflow.version, 3);
  assert.equal(workflow.stage, "execute");
  assert.equal(workflow.status, "complete");
  assert.equal(workflow.revision, request.planRevision);
  assert.equal(workflow.artifactTableRevision, request.artifactTableRevision);
  assert.equal(workflow.approval, request.planRevision);
  assert.equal(workflow.approvalArtifactTableRevision, request.artifactTableRevision);
  assert.deepEqual(workflow.plan.contract, summaryContractFixture());
  assertPassingEvaluatorGate(workflow.results.S1.gates[0], "Step checkpoint");
  assertPassingEvaluatorGate(workflow.finalChecks[0], "Final verification");
  assert.equal(workflow.results.S1.passed, true);
  assert.deepEqual(workflow.finalManifestBefore, workflow.finalManifest);
  assert.equal(workflow.finalManifest.planRevision, workflow.revision);
  assert.equal(workflow.finalManifest.artifactTableRevision, workflow.artifactTableRevision);
  assert.deepEqual(workflow.finalManifest.kinds, ["final"]);
  assert.deepEqual(workflow.acceptanceManifest.kinds, ["evidence", "final"]);
  assert.match(workflow.finalReview, /^[a-f0-9]{64}$/u);
  assert.equal(workflow.finalReview, completionAssertion.evidence.finalReview);

  const outputText = readFileSync(path.join(workspace, "summary.json"), "utf8");
  assert.deepEqual(JSON.parse(outputText), SUMMARY_OUTPUT);
  const finalReceipt = workflow.finalManifest.files.find(file => file.artifactId === "A1");
  const acceptedReceipt = workflow.acceptanceManifest.files.find(file => file.artifactId === "A1");
  assert.deepEqual(finalReceipt, acceptedReceipt);
  assert.equal(finalReceipt.path, "summary.json");
  assert.equal(finalReceipt.hash, sha256(outputText));
  assert.equal(finalReceipt.bytes, Buffer.byteLength(outputText, "utf8"));

  assertNativeAuthorityCapture({ result, entries, events: retainedEvents, backend, scenario });
  assert.deepEqual(scenario.interviewActions, ["read:input.json", "solar_interview_round:ready"]);
  assert.deepEqual(scenario.planningActions, ["solar_plan_ready"]);
  assert.deepEqual(scenario.roleRequests, ["planner", "approach_reviewer", "critic"]);
  const expectedExecutorActions = scenario.kind === "authorized-tool-error"
    ? ["read:input.json:error-offset", "read:input.json", "read:evaluator.mjs", "write:summary.json", "solar_step_done:S1", "solar_step_done:final"]
    : ["read:input.json", "read:evaluator.mjs", "write:summary.json", "solar_step_done:S1", "solar_step_done:final"];
  assert.deepEqual(scenario.executorActions, expectedExecutorActions);
  assert.equal(backend.errors.length, 0, backend.errors.map(String).join("\n"));
  assert.ok(backend.requests.every(payload => payload.model === SOLAR_MODEL && payload.reasoning_effort === "max"));
  return { result, entries, events: retainedEvents };
}

function assertBlockedOutputReadRun({ backend, scenario, output, runnerReceipt }) {
  const manifest = JSON.parse(readFileSync(path.join(output, "experiment.json"), "utf8"));
  const result = JSON.parse(readFileSync(path.join(output, "run-001", "result.json"), "utf8"));
  const entries = JSON.parse(readFileSync(path.join(output, "run-001", "session-entries.json"), "utf8"));
  const events = readJsonLines(path.join(output, "run-001", "pi-events.jsonl"));
  const runnerSummary = JSON.parse(runnerReceipt.stdout);

  assert.equal(runnerReceipt.exitCode, 1, "The controlled native-authority denial must keep the harness run unsuccessful");
  assert.equal(runnerSummary.status, "blocked");
  assert.equal(runnerSummary.runs[0].status, "blocked");
  assert.equal(manifest.status, "blocked");
  assert.equal(manifest.case, "execute-summary");
  assert.equal(manifest.runs[0].status, "blocked");
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "paused");
  assert.equal(result.case, "execute-summary");
  assert.equal(result.heldOut, false, "The controlled denial proof must remain confined to the development fixture");
  assert.deepEqual(result.assertions.map(item => item.id), EXECUTE_SUMMARY_ASSERTIONS);
  assert.equal(result.assertions.length, 17);
  for (const assertionId of [
    "preflight_model_and_resources",
    "pi_process_exited_cleanly",
    "provider_failures_absent",
    "extension_errors_absent",
    "fixture_inputs_unchanged",
    "unexpected_workspace_files_absent",
    "workspace_contains_no_special_files",
    "full_interview_exact_confirmation",
    "confirmed_goal_matches_fixture_semantics",
    "current_revision_has_all_role_receipts",
    "synthetic_plan_was_safely_approved",
    "no_mutation_before_exact_approval",
  ]) {
    assert.equal(result.assertions.find(item => item.id === assertionId)?.passed, true, `Controlled denial unexpectedly failed ${assertionId}`);
  }
  assert.equal(result.assertions.find(item => item.id === "fixture_policy_tool_attempts_within_bounds")?.passed, true);
  assert.equal(result.assertions.find(item => item.id === "native_tool_authority_clean")?.passed, false);
  assert.deepEqual(result.assertions.filter(item => !item.passed).map(item => item.id), [
    "native_tool_authority_clean",
    "command_only_workflow_completed",
    "output_is_valid_json",
    "output_matches_independent_expected_value",
  ]);
  assert.equal(result.process.exitCode, 0, "The failed grader scenario must not masquerade as a Pi process failure");
  assert.equal(result.error, null);
  assert.equal(result.protocolError, null);
  assert.deepEqual(result.providerFailures, []);
  assert.equal(Object.hasOwn(result, "operationAudit"), false, "The removed mixed-authority audit alias must not reappear");
  assert.equal(result.fixturePolicyAudit.scope, "fixture_policy");
  assert.deepEqual(result.fixturePolicyAudit.violations, []);
  assert.ok(result.fixturePolicyAudit.calls.every(call =>
    Object.hasOwn(call, "allowedByFixturePolicy") && !Object.hasOwn(call, "authorized")));

  const fixtureCalls = result.fixturePolicyAudit.calls.filter(call =>
    call.tool === "read" && call.path === "summary.json");
  assert.equal(fixtureCalls.length, 1, "The controlled output read was not retained by fixture-policy measurement");
  assert.equal(fixtureCalls[0].phase, "after_approval");
  assert.equal(fixtureCalls[0].allowedByFixturePolicy, true, "Fixture containment must remain distinct from current-step host authority");
  assert.equal(fixtureCalls[0].reason, "fixture_local_read");
  assert.equal(events[fixtureCalls[0].eventIndex].type, "tool_execution_start");
  assert.equal(events[fixtureCalls[0].eventIndex].toolName, "read");
  assert.equal(events[fixtureCalls[0].eventIndex].args.path, "summary.json");

  const capture = assertNativeAuthorityCapture({
    result,
    entries,
    events,
    backend,
    scenario,
    blockedCodes: ["execution_guard_rejected"],
  });
  const assistantMatches = capture.assistantCalls.filter(call =>
    call.block.name === "read" && call.block.arguments?.path === "summary.json");
  assert.equal(assistantMatches.length, 1, "The blocked dispatch did not retain its actual assistant-origin output read");
  const assistantCall = assistantMatches[0];
  const dispatch = capture.dispatchReceipts.find(receipt =>
    receipt.data.call.assistantEntryId === assistantCall.entry.id
    && receipt.data.call.toolCallId === assistantCall.block.id
    && receipt.data.call.toolName === assistantCall.block.name);
  assert.equal(dispatch?.data.decision, "blocked");
  assert.equal(dispatch?.data.code, "execution_guard_rejected");
  assert.equal(dispatch?.data.stepId, "S1");
  assert.equal(typeof dispatch?.data.stateEntryId, "string");
  const blocked = result.nativeToolAuthorityAudit.blockedDispatches[0];
  assert.deepEqual(Object.keys(blocked).sort(), ["call", "code", "entryId"]);
  assert.equal(blocked.entryId, dispatch.entry.id);
  assert.deepEqual(blocked.call, dispatch.data.call);

  const nativeResult = capture.toolResults.find(item => item.message.toolCallId === assistantCall.block.id);
  assert.equal(nativeResult?.message.isError, true);
  assert.match(textValues(nativeResult?.message.content).join("\n"), /current step does not declare this exact tool\/path\/command capability/u);
  const nativeEnd = capture.ends.find(event => event.toolCallId === assistantCall.block.id && event.toolName === assistantCall.block.name);
  assert.equal(nativeEnd?.isError, true);
  assert.equal(Object.hasOwn(nativeResult?.message.details ?? {}, "staleExecutionResult"), false, "A blocked call unexpectedly reached the SDK tool_result hook");
  assert.equal(capture.resultReceipts.some(receipt => receipt.data.call.toolCallId === assistantCall.block.id), false, "A blocked call must not fabricate a result-authority decision");
  assert.equal(existsSync(path.join(output, "run-001", "workspace", "summary.json")), false);
  assert.deepEqual(scenario.interviewActions, ["read:input.json", "solar_interview_round:ready"]);
  assert.deepEqual(scenario.planningActions, ["solar_plan_ready"]);
  assert.deepEqual(scenario.roleRequests, ["planner", "approach_reviewer", "critic"]);
  assert.deepEqual(scenario.executorActions, ["read:summary.json:blocked", "stop:after-checkpoint-reminder"]);
  assert.equal(backend.errors.length, 0, backend.errors.map(String).join("\n"));
}

function assertAuthorizedToolErrorRun(options) {
  const capture = assertExecuteSummaryRun(options);
  const { result, entries, events } = capture;
  const fixtureCalls = result.fixturePolicyAudit.calls.filter(call =>
    call.tool === "read"
    && call.path === "input.json"
    && events[call.eventIndex]?.args?.offset === TOOL_ERROR_OFFSET);
  assert.equal(fixtureCalls.length, 1, "The controlled ordinary read error was not retained by fixture-policy measurement");
  assert.equal(fixtureCalls[0].allowedByFixturePolicy, true);
  assert.equal(fixtureCalls[0].phase, "after_approval");
  assert.equal(fixtureCalls[0].reason, "fixture_local_read");

  const authority = retainedAuthorityReceipts(entries);
  const assistantMatches = retainedAssistantCalls(entries).filter(call =>
    call.block.name === "read"
    && call.block.arguments?.path === "input.json"
    && call.block.arguments?.offset === TOOL_ERROR_OFFSET);
  assert.equal(assistantMatches.length, 1, "The ordinary read error did not retain its actual assistant origin");
  const assistantCall = assistantMatches[0];
  const dispatch = authority.find(receipt =>
    receipt.data.kind === "dispatch"
    && receipt.data.call.assistantEntryId === assistantCall.entry.id
    && receipt.data.call.toolCallId === assistantCall.block.id
    && receipt.data.call.toolName === assistantCall.block.name);
  assert.equal(dispatch?.data.decision, "execution_allowed");
  assert.equal(dispatch?.data.code, null);
  assert.equal(dispatch?.data.stepId, "S1");
  assert.equal(typeof dispatch?.data.stateEntryId, "string");
  const resultReceipt = authority.find(receipt =>
    receipt.data.kind === "result"
    && receipt.data.call.assistantEntryId === assistantCall.entry.id
    && receipt.data.call.toolCallId === assistantCall.block.id
    && receipt.data.call.toolName === assistantCall.block.name);
  assert.equal(resultReceipt?.data.decision, "current", "An ordinary tool error still requires the current authority recheck");
  assert.equal(resultReceipt?.data.code, null);

  const nativeResults = retainedToolResults(entries).filter(item => item.message.toolCallId === assistantCall.block.id);
  assert.equal(nativeResults.length, 1);
  assert.equal(nativeResults[0].message.isError, true, "The authority recheck must preserve the original tool isError");
  assert.match(textValues(nativeResults[0].message.content).join("\n"), new RegExp(`Offset ${TOOL_ERROR_OFFSET} is beyond end of file`));
  assert.equal(Object.hasOwn(nativeResults[0].message.details ?? {}, "staleExecutionResult"), false, "An ordinary tool error was rewritten as a host denial");
  const nativeEnds = events.filter(event =>
    event.type === "tool_execution_end"
    && event.toolCallId === assistantCall.block.id
    && event.toolName === assistantCall.block.name);
  assert.equal(nativeEnds.length, 1);
  assert.equal(nativeEnds[0].isError, true);
  assert.equal(result.nativeToolAuthorityAudit.denialCount, 0);
  assert.equal(result.nativeToolAuthorityAudit.invalidationCount, 0);
  assert.deepEqual(result.nativeToolAuthorityAudit.blockedDispatches, []);
  assert.deepEqual(result.nativeToolAuthorityAudit.invalidatedResults, []);
  assert.equal(result.assertions.find(item => item.id === "native_tool_authority_clean")?.passed, true);
}

async function main() {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)));
  const agentDir = path.join(root, "home", ".pi", "agent");
  const runnerScope = path.join(root, "runner-scope");
  const runnerAgentDir = path.join(runnerScope, "home", ".pi", "agent");
  const runnerSessionDir = path.join(runnerScope, "sessions");
  const runDir = path.join(root, "run-dir");
  const workspace = path.join(runDir, "workspace");
  const harnessOutput = path.join(runDir, "execute-summary-harness");
  const blockedHarnessOutput = path.join(runDir, "execute-summary-blocked-read-harness");
  const toolErrorHarnessOutput = path.join(runDir, "execute-summary-tool-error-harness");
  const sessionFile = path.join(runDir, "session.jsonl");
  const positiveEvidence = path.join(runDir, "application-session-directory", "evidence.jsonl");
  const positiveEvidenceStream = `${positiveEvidence}:authorized-evidence`;
  const namespacePrivate = path.join(workspace, ".pi", "answer-head.json");
  const credentialDotfile = path.join(runDir, ".env");
  mkdirSync(runDir);
  mkdirSync(workspace);
  mkdirSync(path.dirname(positiveEvidence));
  mkdirSync(path.dirname(namespacePrivate));
  const sessionTimestamp = new Date().toISOString();
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", timestamp: sessionTimestamp, cwd: workspace }),
    JSON.stringify({ type: "custom", id: "private-smoke-entry", parentId: null, timestamp: sessionTimestamp, customType: "private-smoke-sentinel", data: PRIVATE_READ_SENTINEL }),
    "",
  ].join("\n"), "utf8");
  writeFileSync(positiveEvidence, "ordinary positive evidence base bytes", "utf8");
  writeFileSync(positiveEvidenceStream, POSITIVE_READ_SENTINEL, "utf8");
  writeFileSync(namespacePrivate, PRIVATE_READ_SENTINEL, "utf8");
  writeFileSync(credentialDotfile, PRIVATE_READ_SENTINEL, "utf8");
  assert.equal(readFileSync(`${sessionFile}::$DATA`, "utf8").includes(PRIVATE_READ_SENTINEL), true, "The installed-Pi fixture must expose the same protected session bytes through NTFS::$DATA");
  assert.equal(readFileSync(`${credentialDotfile}::$DATA`, "utf8"), PRIVATE_READ_SENTINEL, "The installed-Pi fixture must expose the synthetic credential dotfile through NTFS::$DATA");
  assert.equal(readFileSync(positiveEvidenceStream, "utf8"), POSITIVE_READ_SENTINEL, "The installed-Pi ordinary named-stream fixture must be readable");
  const cliPath = discoverPiCli();
  const environment = isolatedEnvironment(root, agentDir, runDir);
  const runnerEnvironment = isolatedEnvironment(runnerScope, runnerAgentDir, runnerSessionDir);
  const packageSource = process.env.PI_PACKAGE_SOURCE?.trim() || REPOSITORY_ROOT;
  let backend;
  let rpc;
  let passed = false;

  try {
    backend = await startBackend({
      tildePrivate: "~/.pi/agent/auth.json",
      namespacePrivate: path.toNamespacedPath(namespacePrivate),
      sessionDefaultStream: "../session.jsonl::$DATA",
      credentialDefaultStream: "../.env::$DATA",
      namespaceEvidence: path.toNamespacedPath(positiveEvidenceStream),
    });
    writeFixtures(agentDir, backend.port);
    writeFixtures(runnerAgentDir, backend.port);
    const verifyReload = prepareReloadFixture(agentDir);
    const install = await runCli(cliPath, ["install", packageSource], { cwd: workspace, env: environment });
    assert.ok(!/\berror\b/iu.test(install.stderr), `pi install reported an error: ${install.stderr}`);

    rpc = new RpcClient(cliPath, workspace, environment, "upstage", SOLAR_MODEL, "max", sessionFile);
    await verifyReload(rpc);
    const commands = (await rpc.request("get_commands")).data.commands;
    for (const skill of REQUIRED_SKILLS) assert.ok(commands.some(command => command.name === `skill:${skill}` && command.source === "skill"), `Installed skill not discovered: ${skill}`);
    assert.ok(commands.some(command => command.name === "solar-interview" && command.source === "extension"));
    assert.ok(!commands.some(command => /^(?:skill:)?lite-/u.test(command.name)), "Removed lite-* names must not be discoverable");

    await rpc.prompt(`/skill:solar-interview Produce one local evidence-linked learning goal without network access. Scenario ${PRIVATE_READ_SCENARIO}. --plan-only`);
    let entries = await rpc.entries();
    assert.equal(latestEntry(entries, "solar-interview-state-v2"), undefined, "Two deliberate denied reads must not manufacture an assessment or expand the automatic repair allowance");
    assert.equal(backend.interviewReads.privateIssued, true);
    const tildeCall = entries.flatMap(entry => entry.message?.role === "assistant" ? entry.message.content ?? [] : [])
      .find(block => block.type === "toolCall" && block.name === "read" && block.arguments?.path === "~/.pi/agent/auth.json");
    assert.ok(tildeCall, "Installed Pi did not issue the tilde private-read probe");
    const tildeResult = entries.find(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === tildeCall.id)?.message;
    assert.equal(tildeResult?.isError, true);
    assert.match(textValues(tildeResult.content).join("\n"), /actual controller\/Pi root or loaded Solar host implementation\/role identity is private/u);
    backend.interviewReads.tildeRefusalObserved = true;
    await rpc.prompt("Continue: produce one local evidence-linked learning goal without network access. Preserve inline state, do not read private files, and report the current interview assessment.");
    entries = await rpc.entries();
    assert.equal(latestEntry(entries, "solar-interview-state-v2"), undefined, "The namespace and stream denial probes must not manufacture an assessment or expand the automatic repair allowance");
    const streamCall = entries.flatMap(entry => entry.message?.role === "assistant" ? entry.message.content ?? [] : [])
      .find(block => block.type === "toolCall" && block.name === "read" && block.arguments?.path === "../session.jsonl::$DATA");
    assert.ok(streamCall, "Installed Pi did not issue the current-session NTFS default-stream probe");
    const streamResult = entries.find(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === streamCall.id)?.message;
    assert.equal(streamResult?.isError, true);
    assert.match(textValues(streamResult.content).join("\n"), /current Pi session file is private/u);
    backend.interviewReads.streamRefusalObserved = true;
    await rpc.prompt("Continue: produce one local evidence-linked learning goal without network access. The existing ../application-session-directory/evidence.jsonl:authorized-evidence stream is authorized and sufficient; preserve inline state and report the current interview assessment.");
    entries = await rpc.entries();
    const assessment = latestEntry(entries, "solar-interview-state-v2");
    assert.equal(assessment.version, 2);
    assert.equal(assessment.answerHead, assessment.recovery.retained.answerIds.at(-1));
    assert.equal(assessment.researchHead, null);
    assert.equal(assessment.strategy, "ready");
    assert.equal(assessment.proposal.readiness.status, "ready");
    assert.match(assessment.goalToken, /^[a-f0-9]{12}$/u);
    assert.equal(backend.interviewReads.privateIssued, true, "Loopback provider did not exercise the installed current-session read boundary");
    assert.equal(backend.interviewReads.refusalObserved, true, "Loopback provider did not observe an explicit installed current-session read refusal");
    assert.equal(backend.interviewReads.tildePrivateIssued, true, "Loopback provider did not exercise Pi's tilde path resolver against an agent-private target");
    assert.equal(backend.interviewReads.tildeRefusalObserved, true, "Loopback provider did not observe the tilde-private refusal");
    assert.equal(backend.interviewReads.namespacePrivateIssued, true, "Loopback provider did not exercise a Windows namespace private alias");
    assert.equal(backend.interviewReads.namespaceRefusalObserved, true, "Loopback provider did not observe the namespace-private refusal");
    assert.equal(backend.interviewReads.streamPrivateIssued, true, "Loopback provider did not exercise the current session's NTFS default-stream alias");
    assert.equal(backend.interviewReads.streamRefusalObserved, true, "Loopback provider did not observe the NTFS session-stream refusal");
    assert.equal(backend.interviewReads.credentialStreamIssued, true, "Loopback provider did not exercise the synthetic credential dotfile's NTFS default-stream alias");
    assert.equal(backend.interviewReads.credentialStreamRefusalObserved, true, "Loopback provider did not observe the credential dotfile stream refusal");
    assert.equal(backend.interviewReads.evidenceIssued, true, "Loopback provider did not exercise an installed positive namespace/named-stream evidence read");
    assert.equal(backend.interviewReads.evidenceObserved, true, "Loopback provider did not receive the authorized namespace/named-stream JSONL evidence");
    assert.equal(backend.interviewReads.step, 7);
    assert.ok(readFileSync(sessionFile, "utf8").includes(PRIVATE_READ_SENTINEL), "Synthetic current-session fixture changed during the denial scenario");
    assert.equal(readFileSync(namespacePrivate, "utf8"), PRIVATE_READ_SENTINEL, "Synthetic namespace-private fixture changed during the denial scenario");
    assert.equal(readFileSync(credentialDotfile, "utf8"), PRIVATE_READ_SENTINEL, "Synthetic credential dotfile changed during the denial scenario");
    assert.equal(readFileSync(positiveEvidenceStream, "utf8"), POSITIVE_READ_SENTINEL, "Authorized evidence stream changed during the positive read scenario");
    assert.ok(textValues(entries).some(text => /Interview read denied before dispatch/u.test(text)), "Installed session history omitted the explicit private-read failure");

    await rpc.prompt(`/solar-interview confirm ${assessment.goalToken}`);
    entries = await rpc.entries();
    const closure = latestEntry(entries, "solar-interview-closure-v2");
    assert.equal(closure.version, 2);
    assert.equal(closure.mode, "normal");
    assert.equal(closure.confirmedGoal.token, assessment.goalToken);
    assert.equal(closure.planningOnly, true);
    const planned = latestWorkflow(entries);
    assert.equal(planned.version, 3);
    assert.equal(planned.status, "planning_complete");
    assert.equal(planned.plan.contract.version, 3);
    assert.equal(planned.approval, undefined);
    assert.deepEqual(planned.roleCommits.map(commit => commit.role), ["planner", "approach_reviewer", "critic"]);
    assert.equal(new Set(planned.roleCommits.map(commit => commit.contextId)).size, 3);
    assert.ok(planned.roleCommits.every(commit => commit.receipt.policy.tools.length === 0 && commit.receipt.thinkingLevel === "max"));
    const planningProviderRequests = backend.requests.filter(payload => parseRoleMetadata(payload));
    assert.deepEqual(planningProviderRequests.map(payload => parseRoleMetadata(payload).role), ["planner", "approach_reviewer", "critic"]);
    assert.ok(planningProviderRequests.every(payload => payload.reasoning_effort === "max" && (!payload.tools || payload.tools.length === 0)), "Every isolated planning provider request must be tool-free Solar Max");
    assert.equal(existsSync(path.join(workspace, "result.md")), false, "Planning-only must not execute");

    await rpc.request("prompt", { message: "/solar-test-reload" });
    entries = await rpc.entries();
    assert.equal(latestEntry(entries, "solar-interview-state-v2").version, 2, "InterviewRoundV2 state did not survive extension reload");
    assert.equal(latestEntry(entries, "solar-interview-closure-v2").confirmedGoal.token, assessment.goalToken, "Current goal closure did not survive extension reload");
    assert.equal(latestWorkflow(entries).version, 3, "Workflow V3 state did not survive extension reload");
    assert.equal(latestWorkflow(entries).status, "planning_complete", "Reload changed the reviewed planning-only boundary");

    await rpc.prompt("/skill:solar-research Record the bounded local teaching context. --research-only --local-only");
    entries = await rpc.entries();
    const researched = latestWorkflow(entries);
    assert.equal(researched.version, 3);
    assert.equal(researched.status, "research_complete");
    assert.equal(researched.research.contract.version, 2);
    assert.equal(researched.research.contract.mode, "initial");
    assert.equal(readFileSync(path.join(workspace, researched.research.relativePath), "utf8"), researched.research.text);
    assert.equal(researched.research.revision, sha256(researched.research.text));
    assert.equal(backend.errors.length, 0, backend.errors.map(String).join("\n"));
    assert.ok(backend.requests.every(payload => payload.model === SOLAR_MODEL && payload.reasoning_effort === "max"));
    assert.ok(!rpc.events.some(event => event.type === "extension_error"), "Extension emitted a runtime error");

    await rpc.close();
    rpc = new RpcClient(cliPath, workspace, environment, "fixture", GENERIC_MODEL, "off");
    const beforeRefusal = backend.requests.length;
    const refusalEntriesBefore = await rpc.entries();
    const workflowStatesBefore = refusalEntriesBefore.filter(entry => entry.customType === "solar-workflow-state-v1").length;
    const refusalEventStart = rpc.events.length;
    await rpc.request("prompt", { message: "/skill:solar-plan --plan-only This must be refused before inference." });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(backend.requests.length, beforeRefusal, "Non-Solar workflow input reached inference instead of returning input handled");
    assert.equal(rpc.events.slice(refusalEventStart).some(event => event.type === "agent_start"), false, "Solar-only refusal started an agent turn");
    const refusalEntriesAfter = await rpc.entries();
    assert.equal(refusalEntriesAfter.filter(entry => entry.customType === "solar-workflow-state-v1").length, workflowStatesBefore, "Solar-only refusal must not create or mutate workflow state");
    assert.ok(rpc.events.some(event => textValues(event).some(text => /require.*upstage\/solar-pro4|No automatic model switch/iu.test(text))), "Solar-only refusal was not visible");
    assert.equal(backend.errors.length, 0, backend.errors.map(String).join("\n"));

    await rpc.close();
    rpc = undefined;
    const runnerSettings = JSON.parse(readFileSync(path.join(runnerAgentDir, "settings.json"), "utf8"));
    assert.equal(Object.hasOwn(runnerSettings, "packages"), false, "The explicit-resource runner scope must not inherit the installed package registration");
    assert.notEqual(runnerEnvironment.PI_CODING_AGENT_DIR, environment.PI_CODING_AGENT_DIR);
    assert.notEqual(runnerEnvironment.HOME, environment.HOME);
    const harnessRunner = path.join(REPOSITORY_ROOT, "scripts", "harness-experiment.mjs");
    const runnerOptions = {
      cwd: runDir,
      env: { ...runnerEnvironment, PI_CLI_PATH: cliPath },
      timeout: 210_000,
    };
    const positiveScenario = backend.beginExecuteSummary("positive");
    const runnerArguments = [
      "--checkout", REPOSITORY_ROOT,
      "--label", "installed-pi-loopback-rpc-approval",
      "--output", harnessOutput,
      "--case", "execute-summary",
      "--timeout-ms", "180000",
    ];
    const runnerReceipt = await runCli(harnessRunner, runnerArguments, runnerOptions);
    backend.finishExecuteSummary(positiveScenario);
    assertExecuteSummaryRun({ backend, scenario: positiveScenario, cliPath, output: harnessOutput, runnerArguments, runnerReceipt });

    const blockedScenario = backend.beginExecuteSummary("blocked-output-read");
    const blockedRunnerArguments = [
      "--checkout", REPOSITORY_ROOT,
      "--label", "installed-pi-loopback-native-authority-block",
      "--output", blockedHarnessOutput,
      "--case", "execute-summary",
      "--timeout-ms", "180000",
    ];
    const blockedRunnerReceipt = await runCli(harnessRunner, blockedRunnerArguments, {
      ...runnerOptions,
      acceptExitCodes: [0, 1],
    });
    backend.finishExecuteSummary(blockedScenario);
    assertBlockedOutputReadRun({
      backend,
      scenario: blockedScenario,
      output: blockedHarnessOutput,
      runnerReceipt: blockedRunnerReceipt,
    });

    const toolErrorScenario = backend.beginExecuteSummary("authorized-tool-error");
    const toolErrorRunnerArguments = [
      "--checkout", REPOSITORY_ROOT,
      "--label", "installed-pi-loopback-authorized-tool-error",
      "--output", toolErrorHarnessOutput,
      "--case", "execute-summary",
      "--timeout-ms", "180000",
    ];
    const toolErrorRunnerReceipt = await runCli(harnessRunner, toolErrorRunnerArguments, runnerOptions);
    backend.finishExecuteSummary(toolErrorScenario);
    assertAuthorizedToolErrorRun({
      backend,
      scenario: toolErrorScenario,
      cliPath,
      output: toolErrorHarnessOutput,
      runnerArguments: toolErrorRunnerArguments,
      runnerReceipt: toolErrorRunnerReceipt,
    });

    console.log("[pi-smoke] PASS: installed current-session, tilde-private, namespace-private, session-stream, and credential-dotfile-stream denial plus positive namespace/named-stream JSONL evidence read, reload V2/V3, Solar-only pre-inference refusal, InterviewRoundV2 goal confirmation, host-owned ResearchContractV2 persistence, native-schema tool-free Solar Max three-role planning, reviewed planning-only closure, real installed-RPC execute-summary approval through all 17 independent runner assertions with complete native authority coverage, a fixture-allowed current-step output-read denial, and an ordinary authorized tool error with a current result recheck");
    passed = true;
  } finally {
    if (rpc) await rpc.close();
    if (backend) await backend.close();
    if (passed) safelyRemove(root, [agentDir, runnerAgentDir, workspace, harnessOutput, blockedHarnessOutput, toolErrorHarnessOutput]);
    else console.error(`[pi-smoke] retained failure artifacts: ${root}`);
  }
}

main().catch(error => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
