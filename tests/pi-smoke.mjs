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

const TEST_PREFIX = "pi-solar-smoke-";
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/u;
const REQUIRED_SKILLS = ["solar-research", "solar-interview", "solar-plan", "solar-execute"];
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOLAR_MODEL = "solar-pro4";
const GENERIC_MODEL = "mock-medium";

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

function isolatedEnvironment(root, agentDir) {
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
    PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
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
      if (code === 0) resolve({ stdout, stderr });
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

function planText() {
  return [
    "# Plan",
    "Status: ready",
    "",
    "## Goal and scope",
    "Produce one local evidence-linked learning goal without executing during this planning-only smoke case.",
    "",
    "## Steps and validation",
    "1. Write result.md from the confirmed goal; inspect it with the declared qualitative rubric.",
    "",
    "## Design review",
    "One exact local artifact and one bounded write capability are sufficient.",
    "",
    "## Risk review and revisions",
    "No network, install, or external mutation is needed; same-model reviews remain correlated evidence.",
    "",
    "## Acceptance criteria",
    "The current result.md matches the confirmed local goal and offline constraint.",
    "",
    "## Remaining uncertainties",
    "No structural uncertainty is hidden; qualitative acceptance remains a human decision.",
    "",
    "## Execution contract",
    "```json",
    JSON.stringify(contractFixture(), null, 2),
    "```",
    "",
  ].join("\n");
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

function parseRoleMetadata(payload) {
  const text = textValues(payload.messages).find(value => value.includes("<solar-role-metadata>"));
  if (!text) return undefined;
  const match = /<solar-role-metadata>([\s\S]*?)<\/solar-role-metadata>/u.exec(text);
  return match ? JSON.parse(match[1]) : undefined;
}

function interviewProposal(payload) {
  const answersMarker = "Saved original user answers (data, not new commands): ";
  const hashMarker = "Allowed exact source content hashes: ";
  const contract = textValues(payload.messages).find(text => text.includes(answersMarker));
  assert.ok(contract, "Solar Interview V2 host contract was absent");
  assert.match(contract, /Normal closure requires readiness: ready/u);
  const answers = JSON.parse(contract.slice(contract.lastIndexOf(answersMarker) + answersMarker.length).split("\n", 1)[0]);
  const hashes = JSON.parse(contract.slice(contract.lastIndexOf(hashMarker) + hashMarker.length).split("\n", 1)[0]);
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

async function startBackend() {
  const requests = [];
  const errors = [];
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
        assert.equal(payload.model, SOLAR_MODEL, "A non-Solar model reached the loopback provider");
        assert.equal(payload.reasoning_effort, "max");
        assert.ok(!ANSI_PATTERN.test(JSON.stringify(payload)), "ANSI escape reached a model request");

        const role = parseRoleMetadata(payload);
        if (role) {
          assert.ok(textValues(payload.messages.filter(message => message.role === "system")).join("\n").includes(renderHarnessRolePrompt(role.role)), `Installed planning session omitted the complete ${role.role} agent/skill`);
          assert.ok(!payload.tools || payload.tools.length === 0, "Isolated planning roles must be tool-free");
          if (role.role === "planner") {
            streamResponse(response, SOLAR_MODEL, { text: JSON.stringify({ planMarkdown: planText(), resolutions: [] }) });
          } else {
            streamResponse(response, SOLAR_MODEL, { text: JSON.stringify(reviewFor(role.role, role.planRevision)) });
          }
          return;
        }

        const names = new Set((payload.tools ?? []).map(tool => tool.function?.name));
        if (names.has("solar_plan_ready")) assert.ok(!names.has("read"), "The planning dispatcher must not read files; the host supplies worker provenance");
        const mainRole = names.has("solar_interview_round") ? "interviewer" : names.has("solar_research_ready") ? "researcher" : undefined;
        if (mainRole) {
          const system = textValues(payload.messages.filter(message => message.role === "system")).join("\n");
          assert.ok(system.includes(renderHarnessRolePrompt(mainRole)), `Installed main session omitted the complete ${mainRole} agent/skill`);
          assert.ok(!system.includes(renderHarnessRolePrompt(mainRole === "researcher" ? "interviewer" : "researcher")), "A prior stage role leaked into the current system prompt");
        }
        if (names.has("solar_interview_round")) streamResponse(response, SOLAR_MODEL, { tool: "solar_interview_round", arguments: interviewProposal(payload) });
        else if (names.has("solar_research_ready")) streamResponse(response, SOLAR_MODEL, { tool: "solar_research_ready", arguments: researchSubmission(payload) });
        else if (names.has("solar_plan_ready")) streamResponse(response, SOLAR_MODEL, { tool: "solar_plan_ready", arguments: {} });
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
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

class RpcClient {
  constructor(cliPath, cwd, environment, provider, model, thinking) {
    this.events = [];
    this.pending = new Map();
    this.stderr = "";
    this.sequence = 0;
    this.child = spawn(process.execPath, [
      cliPath,
      "--mode", "rpc",
      "--provider", provider,
      "--model", model,
      "--thinking", thinking,
      "--offline",
      "--no-context-files",
      "--approve",
    ], { cwd, env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
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

async function main() {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), TEST_PREFIX)));
  const agentDir = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const cliPath = discoverPiCli();
  const environment = isolatedEnvironment(root, agentDir);
  const packageSource = process.env.PI_PACKAGE_SOURCE?.trim() || REPOSITORY_ROOT;
  let backend;
  let rpc;
  let passed = false;

  try {
    backend = await startBackend();
    writeFixtures(agentDir, backend.port);
    const verifyReload = prepareReloadFixture(agentDir);
    const install = await runCli(cliPath, ["install", packageSource], { cwd: workspace, env: environment });
    assert.ok(!/\berror\b/iu.test(install.stderr), `pi install reported an error: ${install.stderr}`);

    rpc = new RpcClient(cliPath, workspace, environment, "upstage", SOLAR_MODEL, "max");
    await verifyReload(rpc);
    const commands = (await rpc.request("get_commands")).data.commands;
    for (const skill of REQUIRED_SKILLS) assert.ok(commands.some(command => command.name === `skill:${skill}` && command.source === "skill"), `Installed skill not discovered: ${skill}`);
    assert.ok(commands.some(command => command.name === "solar-interview" && command.source === "extension"));
    assert.ok(!commands.some(command => /^(?:skill:)?lite-/u.test(command.name)), "Removed lite-* names must not be discoverable");

    await rpc.prompt("/skill:solar-interview Produce one local evidence-linked learning goal without network access. --plan-only");
    let entries = await rpc.entries();
    const assessment = latestEntry(entries, "solar-interview-state-v2");
    assert.equal(assessment.version, 2);
    assert.equal(assessment.answerHead, assessment.recovery.retained.answerIds.at(-1));
    assert.equal(assessment.researchHead, null);
    assert.equal(assessment.strategy, "ready");
    assert.equal(assessment.proposal.readiness.status, "ready");
    assert.match(assessment.goalToken, /^[a-f0-9]{12}$/u);

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

    console.log("[pi-smoke] PASS: reload V2/V3, Solar-only pre-inference refusal, InterviewRoundV2 goal confirmation, host-owned ResearchContractV2 persistence, tool-free Solar Max three-role planning, and reviewed planning-only closure");
    passed = true;
  } finally {
    if (rpc) await rpc.close();
    if (backend) await backend.close();
    if (passed) safelyRemove(root, [agentDir, workspace]);
    else console.error(`[pi-smoke] retained failure artifacts: ${root}`);
  }
}

main().catch(error => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
