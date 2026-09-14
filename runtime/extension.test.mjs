import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const modules = new Map([
  ["@earendil-works/pi-coding-agent", `
    export async function createAgentSession() { throw new Error("Tests inject a roleSessionFactory"); }
    export class DefaultResourceLoader {}
    export function getAgentDir() { return "."; }
    export class SessionManager { static inMemory() { return {}; } }
    export class SettingsManager { static inMemory() { return {}; } }
  `],
  ["@earendil-works/pi-tui", `export class Text { constructor(text) { this.text = text; } }`],
  ["typebox", `
    const node = (type, fields = {}) => ({ type, ...fields });
    export const Type = {
      Object: (properties, options = {}) => node("object", { properties, ...options }),
      Array: (items, options = {}) => node("array", { items, ...options }),
      String: (options = {}) => node("string", options),
      Number: (options = {}) => node("number", options),
      Boolean: (options = {}) => node("boolean", options),
      Literal: value => ({ const: value }),
      Union: anyOf => ({ anyOf }),
      Optional: value => value,
      Null: () => node("null"),
    };
  `],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = modules.get(specifier);
    if (source !== undefined) return { url: `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { installLiteRuntime } = await import("./extension.ts");
const { WORKFLOW_STATE, recoverWorkflow } = await import("./workflow.ts");
const { renderHarnessRolePrompt } = await import("./harness.ts");

const SOLAR_MODEL = {
  provider: "upstage",
  id: "solar-pro4",
  reasoning: true,
  input: ["text"],
  thinkingLevelMap: { max: "max" },
};
const GENERIC_MODEL = { provider: "fixture", id: "generic", reasoning: false, input: ["text"] };

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(callback) {
  const base = realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, "solar-extension-unit-"));
  try {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace);
    return await callback(workspace, root);
  } finally {
    assert.equal(path.dirname(realpathSync(root)), base);
    assert.ok(path.basename(root).startsWith("solar-extension-unit-"));
    rmSync(root, { recursive: true, force: true });
  }
}

class FakePi {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.handlers = new Map();
    this.tools = new Map();
    this.commands = new Map();
    this.entries = [];
    this.sentMessages = [];
    this.sentUserMessages = [];
    this.notifications = [];
    this.providers = [];
    this.activeTools = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"];
    this.entrySequence = 0;
    this.aborts = 0;
    this.execCalls = [];
    this.execImpl = options.exec ?? (async () => ({ code: 0, stdout: "passed", stderr: "", killed: false }));
    this.ctx = {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getBranch: () => this.entries },
      modelRegistry: {
        find: (provider, id) => provider === "upstage" && id === "solar-pro4" ? SOLAR_MODEL : undefined,
        getProvider: () => undefined,
      },
      model: SOLAR_MODEL,
      scopedModels: [],
      thinkingLevel: "max",
      isIdle: () => true,
      isProjectTrusted: () => false,
      signal: undefined,
      abort: () => { this.aborts += 1; },
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "",
      waitForIdle: async () => undefined,
      ui: {
        setWidget: () => undefined,
        setStatus: () => undefined,
        notify: (message, level) => { this.notifications.push({ message, level }); },
      },
    };
  }

  on(name, handler) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  registerTool(tool) {
    this.tools.set(tool.name, tool);
  }

  registerCommand(name, command) {
    this.commands.set(name, command);
  }

  registerProvider(name, config) {
    this.providers.push({ name, config });
  }

  appendEntry(customType, data) {
    this.entries.push({ type: "custom", id: `entry-${++this.entrySequence}`, customType, data: structuredClone(data) });
  }

  sendMessage(message, options) {
    this.sentMessages.push({ message: structuredClone(message), options: structuredClone(options) });
  }

  sendUserMessage(message, options) {
    this.sentUserMessages.push({ message, options: structuredClone(options) });
  }

  getActiveTools() {
    return [...this.activeTools];
  }

  getAllTools() {
    return [...new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", ...this.tools.keys()])].map(name => ({ name }));
  }

  setActiveTools(names) {
    this.activeTools = [...names];
  }

  getThinkingLevel() {
    return this.ctx.thinkingLevel;
  }

  async exec(file, args, options) {
    this.execCalls.push({ file, args: structuredClone(args), options: { ...options } });
    return this.execImpl(file, args, options);
  }

  async emit(name, event, ctx = this.ctx) {
    let returned;
    for (const handler of this.handlers.get(name) ?? []) {
      const value = await handler(event, ctx);
      if (value !== undefined) returned = value;
    }
    return returned;
  }

  async startInput(text) {
    const intercepted = await this.emit("input", { type: "input", text, source: "interactive" });
    if (intercepted?.action === "handled") return intercepted;
    const id = `message-${++this.entrySequence}`;
    this.entries.push({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
    await this.emit("before_agent_start", { type: "before_agent_start", prompt: text, systemPrompt: "base" });
    return { action: "continue", id };
  }

  async callTool(name, params, signal = new AbortController().signal) {
    const tool = this.tools.get(name);
    assert.ok(tool, `Missing fake-host tool ${name}`);
    return tool.execute(`tool-${++this.entrySequence}`, params, signal, undefined, this.ctx);
  }

  async command(name, argument = "") {
    const command = this.commands.get(name);
    assert.ok(command, `Missing fake-host command ${name}`);
    return command.handler(argument, this.ctx);
  }

  workflow() {
    return recoverWorkflow(this.entries);
  }

  latest(customType) {
    return [...this.entries].reverse().find(entry => entry.type === "custom" && entry.customType === customType)?.data;
  }
}

function createRoleFactory(responder, stats = {}) {
  stats.requests ??= [];
  stats.sessions ??= [];
  return async request => {
    stats.requests.push(request);
    const state = { model: { provider: "upstage", id: "solar-pro4" }, thinkingLevel: "max", tools: [], messages: [] };
    const sessionStats = { aborts: 0, disposals: 0, prompts: [] };
    stats.sessions.push(sessionStats);
    return {
      state,
      systemPrompt: request.systemPrompt,
      async prompt(text, options) {
        sessionStats.prompts.push({ text, options });
        const output = await responder(request, sessionStats);
        if (output !== undefined) state.messages.push({
          role: "assistant",
          provider: "upstage",
          model: "solar-pro4",
          stopReason: "stop",
          content: [{ type: "text", text: output }],
        });
      },
      abort() { sessionStats.aborts += 1; },
      dispose() { sessionStats.disposals += 1; },
      getActiveToolNames() { return []; },
    };
  };
}

function installHost(workspace, responder, options = {}) {
  const roleStats = {};
  const pi = new FakePi(workspace, options);
  let id = 0;
  installLiteRuntime(pi, {
    roleSessionFactory: createRoleFactory(responder, roleStats),
    roleIdFactory: kind => `${kind}-${++id}`,
    web: { getApiKey: () => undefined },
    documents: { getApiKey: () => undefined },
  });
  return { pi, roleStats };
}

function contractFixture({ gateKind = "rubric", gateCount = 1 } = {}) {
  const gates = Array.from({ length: gateCount }, (_, index) => ({
    id: `G${index + 1}`,
    kind: gateKind,
    check: gateKind === "command" ? `verify result ${index + 1}` : `Inspect result.txt against rubric ${index + 1}.`,
    pass: gateKind === "command" ? `The exact current result passes check ${index + 1}.` : `The current result satisfies qualitative rubric ${index + 1}.`,
    evidence: ["A1"],
  }));
  return {
    version: 3,
    domain: "software",
    requirements: [{ id: "R1", description: "Create the exact bounded result.", source: "Original request." }],
    artifacts: [{ id: "A1", path: "result.txt", kind: "final", acceptance: gateKind === "command" ? "command" : "human", gates: gates.map(gate => gate.id) }],
    capabilities: [{ id: "C1", kind: "write", tool: "write", paths: ["result.txt"], commands: [] }],
    steps: [{
      id: "S1",
      title: "Create the bounded result",
      feasibility: "The exact host write tool and local path are available.",
      inputs: [],
      outputs: ["A1"],
      actions: ["Write the exact current result bytes."],
      dependsOn: [],
      requires: ["R1"],
      gates: gates.map(gate => gate.id),
      capabilities: ["C1"],
    }],
    gates,
    selfCheck: {
      review: "Checked scope, feasibility, dependencies, capabilities, artifacts, gates, and acceptance.",
      requirementCoverage: [{ requirementId: "R1", stepIds: ["S1"], gateIds: gates.map(gate => gate.id), explanation: "S1 creates A1 and its gates evaluate R1." }],
      artifactCoverage: [{ artifactId: "A1", stepId: "S1", gateIds: gates.map(gate => gate.id), explanation: "S1 is the sole producer and the descriptor gates accept A1." }],
      unresolved: [],
    },
  };
}

function planText(contract, revisionNote = "Initial complete plan.") {
  return [
    "# Plan",
    "Status: ready",
    "",
    "## Goal and scope",
    "Create only result.txt from the selected requirements.",
    "",
    "## Steps and validation",
    "1. Create result.txt and run every exact descriptor-bound gate.",
    "",
    "## Design review",
    "One bounded artifact and exact write capability are sufficient.",
    "",
    "## Risk review and revisions",
    revisionNote,
    "",
    "## Acceptance criteria",
    "Current result bytes satisfy every declared command or human gate.",
    "",
    "## Remaining uncertainties",
    "No hidden structural uncertainty remains; qualitative judgment stays human-owned.",
    "",
    "## Execution contract",
    "```json",
    JSON.stringify(contract, null, 2),
    "```",
    "",
  ].join("\n");
}

function reviewFixture(contract, role, planRevision, overrides = {}) {
  const steps = contract.steps.filter(step => step.requires.includes("R1"));
  return {
    version: 1,
    role,
    planRevision,
    domain: contract.domain,
    verdict: "pass",
    assessment: {
      focus: role === "critic" ? "whole_plan_scope_risk_verification_acceptance" : "software_architecture_feasibility",
      analysis: role === "critic" ? "The whole current plan binds scope, risk, checks, and acceptance." : "The current architecture and exact capabilities are feasible.",
    },
    requirementCoverage: [{ requirementId: "R1", status: "covered", stepIds: steps.map(step => step.id), gateIds: [...new Set(steps.flatMap(step => step.gates))], explanation: "The named step and gates cover the selected requirement." }],
    findings: [],
    limitations: ["Separate context, but correlated same-model review evidence."],
    ...overrides,
  };
}

function passingResponder(contract, plan = planText(contract)) {
  return request => request.role === "planner"
    ? JSON.stringify({ planMarkdown: plan, resolutions: [] })
    : JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
}

function readyProposal(answer) {
  const hash = sha256(answer.text);
  const dimension = { score: 1, evidence: [answer.id], gap: "" };
  return {
    goal: dimension,
    constraints: dimension,
    success: dimension,
    blockers: [],
    deferred: [],
    intent: "Create the exact bounded local result.",
    changeReason: "The current answer fixes the outcome, constraint, and observable success.",
    question: "",
    strategy: "ready",
    currentGapId: null,
    materialState: { topics: [{ topicId: "result", kind: "decision", normalizedValue: "create the exact bounded local result", sourceContentHashes: [hash] }], gaps: [], claims: [] },
    readiness: { status: "ready", goalSentence: "Create the exact bounded local result.", materialGaps: [], contradictions: [] },
  };
}

function openProposal(answers, strategy, question) {
  const first = answers[0];
  const latest = answers.at(-1);
  const dimension = { score: 0.5, evidence: [latest.id], gap: "The exact success condition remains unknown." };
  return {
    goal: dimension,
    constraints: dimension,
    success: dimension,
    blockers: ["The exact success condition remains unknown."],
    deferred: [],
    intent: "Create a local result after resolving its success condition.",
    changeReason: "The same named success gap remains open.",
    question,
    strategy,
    currentGapId: "GAP1",
    materialState: {
      topics: [{ topicId: "local-result", kind: "constraint", normalizedValue: "keep the result local", sourceContentHashes: [sha256(first.text)] }],
      gaps: [{ gapId: "GAP1", status: "open", normalizedSummary: "exact success condition remains unknown" }],
      claims: [],
    },
    readiness: { status: "not_ready", materialGaps: [{ id: "GAP1", issue: "The exact success condition remains unknown.", evidenceIds: [latest.id], researchable: false }], contradictions: [] },
  };
}

async function startAndInitialize(pi, text) {
  await pi.emit("session_start", { type: "session_start", reason: "startup" });
  return pi.startInput(text);
}

function assertToolSucceeded(result, label) {
  const text = result?.content?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? "";
  assert.notEqual(result?.details?.workflowValidationError, true, `${label} failed: ${text}`);
}

test("explicit no-gap wire values preserve all interview readiness guards", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Create the exact bounded local result.");
  const entry = pi.entries.find(item => item.type === "message" && item.message.role === "user");
  const answer = { id: entry.id, text: entry.message.content[0].text };
  const missing = readyProposal(answer);
  delete missing.currentGapId;
  assert.equal((await pi.callTool("solar_interview_round", missing)).details.interviewValidationError, true);
  const empty = { ...readyProposal(answer), currentGapId: "" };
  assert.equal((await pi.callTool("solar_interview_round", empty)).details.interviewValidationError, true);
  const unresolved = { ...openProposal([answer], "question", "What defines success?"), currentGapId: null };
  assert.equal((await pi.callTool("solar_interview_round", unresolved)).details.interviewValidationError, true);
  const ready = readyProposal(answer);
  const result = await pi.callTool("solar_interview_round", ready);
  assertToolSucceeded(result, "canonical ready wire");
  assert.equal(result.details.state.status, "awaiting_goal_confirmation");
  assert.equal(result.details.state.proposal.currentGapId, undefined);
  assert.equal(ready.currentGapId, null, "Wire input is not mutated during domain normalization");
  assert.equal(pi.latest("solar-interview-closure-v2"), undefined);
}));

test("the planning dispatcher cannot read workspace or package implementation files", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local plan.");
  assert.deepEqual(pi.activeTools.sort(), ["solar_plan_ready", "solar_revisit"].sort());
  for (const file of ["records.json", "harness/skills/planner/SKILL.md"]) {
    const denied = await pi.emit("tool_call", { type: "tool_call", toolCallId: `denied-${file}`, toolName: "read", input: { path: file } });
    assert.equal(denied.block, true);
    assert.equal(denied.terminate, true);
  }
}));

test("active stages bind only their packaged role and inactive conversations do not", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await pi.emit("session_start", { type: "session_start", reason: "startup" });
  const event = { type: "before_agent_start", prompt: "Continue the current task.", systemPrompt: "base" };
  assert.equal(await pi.emit("before_agent_start", event), undefined);
  await pi.startInput("/skill:solar-research Record a local decision. --research-only --local-only");
  const research = await pi.emit("before_agent_start", event);
  assert.equal(research.systemPrompt, `base\n${renderHarnessRolePrompt("researcher")}`);
  assert.ok(!research.systemPrompt.includes(renderHarnessRolePrompt("executor")));
  await pi.command("solar-workflow", "stop");
  assert.equal(await pi.emit("before_agent_start", event), undefined);
  await pi.startInput("/skill:solar-interview Clarify the local output. --plan-only");
  const interview = await pi.emit("before_agent_start", event);
  assert.equal(interview.systemPrompt, `base\n${renderHarnessRolePrompt("interviewer")}`);
  assert.ok(!interview.systemPrompt.includes(renderHarnessRolePrompt("researcher")));
}));

test("shutdown uses the current event context rather than a captured expired context", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await pi.emit("session_start", { type: "session_start", reason: "startup" });
  const cleared = [];
  const shutdownContext = { ...pi.ctx, ui: {
    setWidget: name => cleared.push(name),
    setStatus: name => cleared.push(name),
  } };
  pi.ctx.ui.setWidget = () => { throw new Error("Captured context is stale"); };
  pi.ctx.ui.setStatus = () => { throw new Error("Captured context is stale"); };
  await pi.emit("session_shutdown", { type: "session_shutdown" }, shutdownContext);
  assert.deepEqual(cleared, ["solar-interview", "solar-workflow", "solar-rate", "solar-workflow"]);
  const expiredContext = new Proxy({}, { get() { throw new Error("Post-shutdown context is stale"); } });
  const count = pi.entries.length;
  await pi.emit("turn_end", { type: "turn_end" }, expiredContext);
  await pi.emit("agent_settled", { type: "agent_settled" }, expiredContext);
  assert.equal(pi.entries.length, count, "Late callbacks cannot write state after shutdown");
}));

test("planning sessions receive their dedicated package roles rather than the dispatcher skill", async () => fixture(async workspace => {
  const { pi, roleStats } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-plan Produce a local result. --plan-only");
  const dispatcher = await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "Continue.", systemPrompt: "base" });
  assert.match(dispatcher.systemPrompt, /planning dispatcher, not the Planner/);
  assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), "defined planning roles");
  assert.deepEqual(roleStats.requests.map(request => request.role), ["planner", "approach_reviewer", "critic"]);
  for (const request of roleStats.requests) {
    assert.equal(request.systemPrompt, renderHarnessRolePrompt(request.role));
    assert.doesNotMatch(request.prompt, /<solar-pro4-reasoning>/);
  }
  assert.equal(pi.workflow().status, "planning_complete");
}));

test("host validates and atomically persists ResearchContractV2 before research-only completion", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-research Record a local decision. --research-only --local-only");
  const initial = pi.workflow();
  assert.equal(initial.version, 3);
  assert.deepEqual(pi.activeTools.sort(), ["read", "solar_research_ready"].sort());

  const malformed = await pi.callTool("solar_research_ready", {
    expectedArtifactRevision: null,
    contract: { version: 2, mode: "initial", outcome: "ready", claims: [], sources: [], learnedClaimIds: [], remainingGap: "none" },
  });
  assert.equal(malformed.details.workflowValidationError, true);
  assert.equal(pi.workflow().status, "active");
  assert.equal(existsSync(path.join(workspace, ".solar-workflow", initial.id, "research.md")), false);

  const submission = {
    expectedArtifactRevision: null,
    contract: {
      version: 2,
      mode: "initial",
      outcome: "ready",
      claims: [{ id: "C1", kind: "user_decision", text: "Keep the result local.", sourceIds: [] }],
      sources: [],
      learnedClaimIds: ["C1"],
      remainingGap: "No factual research gap remains.",
    },
  };
  const result = await pi.callTool("solar_research_ready", submission);
  const completed = pi.workflow();
  assert.equal(result.details.status, "research_complete");
  assert.equal(completed.status, "research_complete");
  assert.equal(completed.research.contract.version, 2);
  assert.equal(completed.research.relativePath, `.solar-workflow/${completed.id}/research.md`);
  assert.equal(readFileSync(completed.research.path, "utf8"), completed.research.text);
  assert.equal(completed.research.revision, sha256(completed.research.text));
  assert.equal(pi.sentUserMessages.length, 0, "Research-only validation must not start interview inference");

  const bytes = readFileSync(completed.research.path, "utf8");
  const stale = await pi.callTool("solar_research_ready", submission);
  assert.equal(stale.details.workflowValidationError, true);
  assert.equal(readFileSync(completed.research.path, "utf8"), bytes, "A stale submission must not overwrite controller bytes");
}));

test("unowned reserved research collision is preserved and cannot complete", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-research Research locally. --research-only --local-only");
  const current = pi.workflow();
  const target = path.join(workspace, ".solar-workflow", current.id, "research.md");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "user-owned bytes", "utf8");
  const result = await pi.callTool("solar_research_ready", {
    expectedArtifactRevision: null,
    contract: {
      version: 2,
      mode: "initial",
      outcome: "ready",
      claims: [{ id: "C1", kind: "user_decision", text: "Keep it local.", sourceIds: [] }],
      sources: [],
      learnedClaimIds: ["C1"],
      remainingGap: "none remains",
    },
  });
  assert.equal(result.details.workflowValidationError, true);
  assert.match(result.content[0].text, /unowned file|no overwrite/iu);
  assert.equal(readFileSync(target, "utf8"), "user-owned bytes");
  assert.equal(pi.workflow().status, "active");
}));

test("InterviewRoundV2 requires current goal token for normal closure and planning-only runs all roles", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi, roleStats } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-interview Create the exact bounded local result. --plan-only");
  const answer = [...pi.entries].reverse().find(entry => entry.type === "message" && entry.message.role === "user");
  const report = await pi.callTool("solar_interview_round", readyProposal({ id: answer.id, text: answer.message.content[0].text }));
  assert.equal(report.details.state.version, 2);
  assert.equal(report.details.state.status, "awaiting_goal_confirmation");
  assert.equal(report.details.state.answerHead, answer.id);
  assert.equal(report.details.state.researchHead, null);

  await pi.startInput("/solar-interview confirm deadbeefdead");
  assert.equal(pi.latest("solar-interview-closure-v2"), undefined);
  assert.equal(pi.workflow().stage, "interview");

  const token = report.details.state.goalToken;
  await pi.startInput(`/solar-interview confirm ${token}`);
  const closure = pi.latest("solar-interview-closure-v2");
  assert.equal(closure.mode, "normal");
  assert.equal(closure.confirmedGoal.token, token);
  assert.equal(closure.planningOnly, true);
  assert.equal(closure.executionAuthority, "none");
  assert.equal(pi.workflow().stage, "plan");

  const planned = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(planned, "planning-only role cycle");
  const final = pi.workflow();
  assert.equal(planned.details.status, "planning_complete");
  assert.equal(final.status, "planning_complete");
  assert.equal(final.plan.contract.version, 3);
  assert.equal(final.approval, undefined);
  assert.equal(final.planning.revisionState, "reviewed");
  assert.deepEqual(roleStats.requests.map(request => request.role), ["planner", "approach_reviewer", "critic"]);
  assert.equal(new Set(final.roleCommits.map(commit => commit.contextId)).size, 3);
  const visibleOutputs = pi.entries.filter(entry => entry.customType === "solar-role-visible-output-v1").map(entry => entry.data);
  assert.equal(visibleOutputs.length, 3);
  assert.ok(visibleOutputs.every(commit => commit.output && commit.receipt.outputRevision === sha256(commit.output) && commit.outputBytes === Buffer.byteLength(commit.output)));
  assert.ok(roleStats.sessions.every(session => session.disposals === 1));
  assert.equal(pi.sentUserMessages.some(item => item.message.startsWith("/skill:solar-execute")), false);
}));

test("initial isolated role requests include exact schemas while denied private sources are never selected", async () => fixture(async workspace => {
  const contract = contractFixture();
  const publicSentinel = "AUTHORIZED_PUBLIC_SOURCE_7b85";
  const privateSentinel = "DENIED_PRIVATE_SENTINEL_91ce";
  writeFileSync(path.join(workspace, "public.txt"), publicSentinel, "utf8");
  mkdirSync(path.join(workspace, "private"));
  writeFileSync(path.join(workspace, "private", "session.txt"), privateSentinel, "utf8");
  const { pi, roleStats } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Use public.txt as evidence, but do not read private/session.txt.");
  const result = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(result, "schema/private-source planning cycle");

  const planner = roleStats.requests.find(request => request.role === "planner");
  const approach = roleStats.requests.find(request => request.role === "approach_reviewer");
  const critic = roleStats.requests.find(request => request.role === "critic");
  const bundle = JSON.stringify(planner.bundle);
  assert.match(bundle, new RegExp(publicSentinel));
  assert.doesNotMatch(bundle, new RegExp(privateSentinel));
  assert.doesNotMatch(bundle, /private\/session\.txt/iu);
  assert.match(bundle, /do not read \[explicitly denied workspace source\]/iu);
  assert.ok(planner.bundle.omitted.some(item => /explicitly denied.*not opened or disclosed/iu.test(item.reason)));

  for (const field of ["requirements", "artifacts", "acceptance", "capabilities", "paths", "commands", "requires", "dependsOn", "gates", "selfCheck", "requirementCoverage", "artifactCoverage", "unresolved"]) {
    assert.match(planner.prompt, new RegExp(`"${field}"`), `Initial Planner request omitted ExecutionContractV3 field ${field}`);
  }
  assert.match(planner.prompt, /ExecutionContractV3 exact reference rules:/u);
  assert.match(planner.prompt, /Planner visible response exact JSON shape:/u);
  assert.match(approach.prompt, /PlanReview exact JSON shape:/u);
  assert.match(approach.prompt, /Finding IDs are unique within and across both reviews/u);
  assert.match(approach.prompt, /ExecutionContractV3 exact JSON shape:/u);
  assert.match(critic.prompt, /PlanReview exact JSON shape:/u);
  assert.match(critic.prompt, /whole_plan_scope_risk_verification_acceptance/u);
}));

test("research provenance is minimized to typed content and a relative controller path", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi, roleStats } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-research Establish local context before planning. --local-only");
  const research = await pi.callTool("solar_research_ready", {
    expectedArtifactRevision: null,
    contract: {
      version: 2,
      mode: "initial",
      outcome: "ready",
      claims: [{ id: "LOCAL1", kind: "user_decision", text: "Keep the outcome local and evidence-linked.", sourceIds: [] }],
      sources: [],
      learnedClaimIds: ["LOCAL1"],
      remainingGap: "The exact goal still requires interview confirmation.",
    },
  });
  assert.equal(research.details.stage, "interview");
  const persistedResearch = pi.workflow().research;
  assert.ok(path.isAbsolute(persistedResearch.path));

  await pi.startInput("/skill:solar-interview resume Confirm the local evidence-linked outcome.");
  const answer = [...pi.entries].reverse().find(entry => entry.type === "message" && entry.message.role === "user");
  const report = await pi.callTool("solar_interview_round", readyProposal({ id: answer.id, text: answer.message.content[0].text }));
  await pi.startInput(`/solar-interview confirm ${report.details.state.goalToken}`);
  const planned = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(planned, "research-to-plan role cycle");

  const provenance = roleStats.requests.find(request => request.role === "planner").bundle;
  const researchItem = JSON.parse(provenance.items.find(item => item.kind === "research").content);
  assert.equal(researchItem.version, 2);
  assert.match(researchItem.relativePath, /^\.solar-workflow\//u);
  assert.equal(researchItem.contract.version, 2);
  assert.equal(Object.hasOwn(researchItem, "path"), false);
  const bundle = JSON.stringify(provenance);
  assert.match(bundle, /Keep the outcome local and evidence-linked/u);
  assert.doesNotMatch(bundle, /"path":/u);
  assert.equal(bundle.includes(workspace), false);
  assert.equal(bundle.includes(workspace.replaceAll("\\", "/")), false);
}));

test("explicit early finish remains distinct and preserves unresolved V2 material state", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-interview Keep a local result but ask about success. --plan-only");
  const initial = pi.entries.find(entry => entry.type === "message");
  const answers = [{ id: initial.id, text: initial.message.content[0].text }];
  await pi.callTool("solar_interview_round", openProposal(answers, "question", "What exact observable result means success?"));
  await pi.startInput("/solar-interview finish plan-only");
  const closure = pi.latest("solar-interview-closure-v2");
  assert.equal(closure.mode, "early");
  assert.equal(closure.completionAuthority, "user_explicit_finish");
  assert.equal(closure.unresolved[0].id, "GAP1");
  assert.equal(closure.planningOnly, true);
  assert.equal(closure.confirmedGoal, undefined);
  assert.equal(pi.workflow().stage, "plan");
}));

test("interview detours settle on closure and a new post-close research gap preserves the closed answer head", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-plan --plan-only --local-only Create a reviewed local result.");
  const firstDetourResult = await pi.callTool("solar_revisit", {
    stage: "interview",
    gap: "Confirm the exact qualitative success boundary.",
    evidence: "The planning request does not choose the qualitative success boundary.",
  });
  assert.equal(firstDetourResult.details.stage, "interview");
  const firstDetourId = pi.workflow().detours.at(-1).id;

  await pi.startInput("/skill:solar-interview resume The result succeeds when its current text states the exact local outcome.");
  const answer = [...pi.entries].reverse().find(entry => entry.type === "message" && entry.message.role === "user");
  const report = await pi.callTool("solar_interview_round", readyProposal({ id: answer.id, text: answer.message.content[0].text }));
  await pi.startInput(`/solar-interview confirm ${report.details.state.goalToken}`);
  const afterClosure = pi.workflow();
  const closedInterview = structuredClone(afterClosure.interview);
  assert.equal(afterClosure.stage, "plan");
  assert.equal(afterClosure.detours.find(item => item.id === firstDetourId).outcome, "answered");
  assert.match(afterClosure.detours.find(item => item.id === firstDetourId).endEvidenceDigest, /^[a-f0-9]{64}$/u);

  const secondDetourResult = await pi.callTool("solar_revisit", {
    stage: "research",
    gap: "Determine whether the local output format preserves the required evidence marker.",
    evidence: "This factual format issue was discovered only after normal goal confirmation.",
  });
  assert.equal(secondDetourResult.details.stage, "research");
  const openResearch = pi.workflow().detours.at(-1);
  assert.notEqual(openResearch.id, firstDetourId);
  assert.match(openResearch.gapId, /^gap-[a-f0-9]{16}$/u);
  assert.equal(openResearch.answerHeadId, closedInterview.answerHead);
  assert.deepEqual(pi.workflow().interview, closedInterview, "Registering a new research gap must not reopen or falsify closed readiness");

  const returned = await pi.callTool("solar_research_ready", {
    expectedArtifactRevision: null,
    contract: {
      version: 2,
      mode: "detour",
      gapId: openResearch.gapId,
      answerHeadId: openResearch.answerHeadId,
      outcome: "narrowed",
      claims: [{ id: "FORMAT1", kind: "user_decision", text: "Use a plain UTF-8 text evidence marker.", sourceIds: [] }],
      sources: [],
      learnedClaimIds: ["FORMAT1"],
      remainingGap: "The reviewed plan must bind the marker to its acceptance gate.",
      nextQuestion: {
        text: "Should the plan bind the UTF-8 marker to the final acceptance gate?",
        addressesGapId: openResearch.gapId,
        rationale: "The newly registered format finding narrows the post-confirmation planning gap.",
      },
    },
  });
  assert.equal(returned.details.stage, "plan");
  const completedResearch = pi.workflow().detours.at(-1);
  assert.equal(completedResearch.outcome, "narrowed");
  assert.equal(completedResearch.answerHeadId, closedInterview.answerHead);
  assert.equal(pi.workflow().detours.find(item => item.id === firstDetourId).outcome, "answered");
  assert.deepEqual(pi.workflow().interview, closedInterview);

  await pi.callTool("solar_revisit", {
    stage: "interview",
    gap: "A later consequential preference remains undecided.",
    evidence: "Research narrowed the factual issue but cannot choose the user's preference.",
  });
  await pi.startInput("/skill:solar-interview resume Preserve the prior confirmed answer head.");
  await pi.startInput("/solar-interview finish");
  assert.equal(pi.workflow().stage, "plan");
  assert.equal(pi.workflow().detours.at(-1).target, "interview");
  assert.equal(pi.workflow().detours.at(-1).outcome, "blocked");
  assert.match(pi.workflow().detours.at(-1).endEvidenceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(pi.workflow().interview.answerHead, closedInterview.answerHead);
}));

test("executable early closure retains open state but cannot execute before exact reviewed-plan approval", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-interview --local-only Create a local result with an undecided success condition.");
  const initial = pi.entries.find(entry => entry.type === "message");
  const answers = [{ id: initial.id, text: initial.message.content[0].text }];
  await pi.callTool("solar_interview_round", openProposal(answers, "question", "What exact observable result means success?"));
  await pi.startInput("/solar-interview finish");
  const closure = pi.latest("solar-interview-closure-v2");
  assert.equal(closure.mode, "early");
  assert.equal(closure.planningOnly, false);
  assert.equal(closure.executionAuthority, "none");
  assert.equal(closure.unresolved[0].id, "GAP1");
  assert.equal(pi.workflow().approval, undefined);

  const directBeforeReview = await pi.startInput("/skill:solar-execute bypass");
  assert.equal(directBeforeReview.action, "handled");
  assert.equal(pi.workflow().stage, "plan");
  assert.equal(pi.workflow().approval, undefined);

  const planned = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(planned, "early executable planning cycle");
  assert.equal(pi.workflow().status, "awaiting_gate_review");
  assert.equal(pi.workflow().approval, undefined);
  const directBeforeApproval = await pi.startInput("/skill:solar-execute still-bypass");
  assert.equal(directBeforeApproval.action, "handled");
  assert.equal(pi.workflow().status, "awaiting_gate_review");
  assert.equal(pi.workflow().approval, undefined);
}));

test("an execute-stage fact discovered after normal closure gets new research lineage without reopening readiness", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-interview --local-only Create the exact bounded local result.");
  const answer = pi.entries.find(entry => entry.type === "message");
  const report = await pi.callTool("solar_interview_round", readyProposal({ id: answer.id, text: answer.message.content[0].text }));
  await pi.startInput(`/solar-interview confirm ${report.details.state.goalToken}`);
  const confirmed = structuredClone(pi.workflow().interview);
  const planned = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(planned, "execute-stage research setup");
  await pi.command("solar-workflow", `approve ${pi.workflow().revision.slice(0, 12)}`);
  assert.equal(pi.workflow().stage, "execute");

  const result = await pi.callTool("solar_revisit", {
    stage: "research",
    gap: "Determine whether a newly observed local format constraint affects the approved output.",
    evidence: "The constraint appeared after planning and needs factual inspection before mutation.",
  });
  assert.equal(result.details.stage, "research");
  const detour = pi.workflow().detours.at(-1);
  assert.match(detour.gapId, /^gap-[a-f0-9]{16}$/u);
  assert.equal(detour.answerHeadId, confirmed.answerHead);
  assert.equal(detour.from, "execute");
  assert.equal(pi.workflow().approval, undefined);
  assert.deepEqual(pi.workflow().interview, confirmed);
  assert.equal(confirmed.assessment.proposal.readiness.status, "ready");
}));

test("same-gap duplicate information requires a distinct strategy and then pauses with retained answers", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-interview Keep the result local; I do not know the success condition.");
  const initial = pi.entries.find(entry => entry.type === "message");
  let answers = [{ id: initial.id, text: initial.message.content[0].text }];
  await pi.callTool("solar_interview_round", openProposal(answers, "question", "What exact observable result means success?"));

  await pi.startInput("I still do not know.");
  const second = [...pi.entries].reverse().find(entry => entry.type === "message" && entry.message.role === "user");
  answers = [...answers, { id: second.id, text: "I still do not know." }];
  const reframed = await pi.callTool("solar_interview_round", openProposal(answers, "reframe", "Would a concrete example define the success boundary?"));
  assert.equal(reframed.details.state.recovery.status, "recovering");
  assert.equal(reframed.details.state.recovery.consecutiveNoProgress, 1);

  await pi.startInput("I still do not know.");
  const third = [...pi.entries].reverse().find(entry => entry.type === "message" && entry.message.role === "user");
  answers = [...answers, { id: third.id, text: "I still do not know." }];
  const paused = await pi.callTool("solar_interview_round", openProposal(answers, "blocked", ""));
  assert.equal(paused.details.state.status, "paused");
  assert.equal(paused.details.state.recovery.status, "paused");
  assert.equal(paused.details.state.recovery.consecutiveNoProgress, 2);
  assert.deepEqual(paused.details.state.recovery.retained.answerIds, answers.map(answer => answer.id));
  assert.equal(pi.workflow().status, "paused");
  assert.match(pi.workflow().reason, /No material information changed/iu);
}));

test("unsupported active interview state pauses without migration or lost history", async () => fixture(async workspace => {
  const contract = contractFixture();
  const { pi } = installHost(workspace, passingResponder(contract));
  await startAndInitialize(pi, "/skill:solar-interview Preserve this answer.");
  const workflow = pi.workflow();
  const anchorId = pi.entries.find(entry => entry.type === "message").id;
  const unsupported = { version: 99, anchorId, status: "interviewing", proposal: { question: "unsupported" }, opaque: { preserve: true } };
  pi.appendEntry("solar-interview-state-v2", unsupported);
  await pi.emit("session_start", { type: "session_start", reason: "reload" });
  assert.deepEqual(pi.entries.findLast(entry => entry.customType === "solar-interview-state-v2").data, unsupported);
  assert.equal(pi.workflow().id, workflow.id);
  assert.equal(pi.workflow().status, "paused");
  assert.match(pi.workflow().reason, /unsupported/iu);
  assert.equal(pi.workflow().approval, undefined);
}));

test("material findings cause a full Planner revision and both fresh re-reviews", async () => fixture(async workspace => {
  const contract = contractFixture();
  const firstPlan = planText(contract, "Initial risk description needs a concrete recovery boundary.");
  const revisedPlan = planText(contract, "Revision resolves F1 by naming the no-progress pause and retained-evidence recovery boundary.");
  let plannerCalls = 0;
  let approachCalls = 0;
  let criticCalls = 0;
  const responder = request => {
    if (request.role === "planner") {
      plannerCalls += 1;
      return plannerCalls === 1
        ? JSON.stringify({ planMarkdown: firstPlan, resolutions: [] })
        : JSON.stringify({ planMarkdown: revisedPlan, resolutions: [{ findingId: "F1", status: "resolved", changedLocations: ["## Risk review and revisions"], explanation: "The revised plan names the bounded recovery and preserved evidence." }] });
    }
    if (request.role === "approach_reviewer") {
      approachCalls += 1;
      return JSON.stringify(reviewFixture(contract, request.role, request.planRevision, approachCalls === 1 ? {
        verdict: "revise",
        findings: [{ id: "F1", severity: "material", summary: "Recovery is not actionable.", requiredChange: "Name the bounded no-progress pause and retained evidence.", planLocations: ["## Risk review and revisions"] }],
      } : {}));
    }
    criticCalls += 1;
    return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
  };
  const { pi, roleStats } = installHost(workspace, responder);
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result plan.");
  const result = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(result, "finding revision role cycle");
  const current = pi.workflow();
  assert.equal(current.status, "planning_complete");
  assert.equal(current.revision, sha256(revisedPlan));
  assert.equal(current.planning.revisionOrdinal, 2);
  assert.equal(current.planning.findingResolutions[0].findingId, "F1");
  assert.equal(current.planning.findingResolutions[0].status, "resolved");
  assert.deepEqual(roleStats.requests.map(request => request.role), ["planner", "approach_reviewer", "critic", "planner", "approach_reviewer", "critic"]);
  assert.equal(approachCalls, 2);
  assert.equal(criticCalls, 2);
  assert.equal(new Set(current.roleCommits.map(commit => commit.contextId)).size, 6);
  assert.ok(current.planning.history.some(item => item.reviewFindings.some(finding => finding.id === "F1")));
  assert.equal(current.approval, undefined);
}));

test("a Critic-origin material finding triggers a full revision and both re-reviews", async () => fixture(async workspace => {
  const contract = contractFixture();
  const firstPlan = planText(contract, "The initial acceptance discussion lacks an explicit stale-output boundary.");
  const revisedPlan = planText(contract, "Revision resolves CF1 by binding qualitative acceptance to current final bytes.");
  let plannerCalls = 0;
  let criticCalls = 0;
  const responder = request => {
    if (request.role === "planner") {
      plannerCalls += 1;
      return plannerCalls === 1
        ? JSON.stringify({ planMarkdown: firstPlan, resolutions: [] })
        : JSON.stringify({ planMarkdown: revisedPlan, resolutions: [{ findingId: "CF1", status: "resolved", changedLocations: ["## Risk review and revisions", "## Acceptance criteria"], explanation: "The full revision now binds acceptance to current final bytes." }] });
    }
    if (request.role === "critic") {
      criticCalls += 1;
      return JSON.stringify(reviewFixture(contract, request.role, request.planRevision, criticCalls === 1 ? {
        verdict: "revise",
        findings: [{ id: "CF1", severity: "material", summary: "Acceptance freshness is underspecified.", requiredChange: "Bind qualitative acceptance to current final bytes.", planLocations: ["## Acceptance criteria"] }],
      } : {}));
    }
    return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
  };
  const { pi, roleStats } = installHost(workspace, responder);
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a current-output-bound plan.");
  const result = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(result, "Critic-origin finding revision cycle");
  const current = pi.workflow();
  assert.equal(current.status, "planning_complete");
  assert.equal(current.revision, sha256(revisedPlan));
  assert.equal(current.planning.findingResolutions[0].findingId, "CF1");
  assert.deepEqual(roleStats.requests.map(request => request.role), ["planner", "approach_reviewer", "critic", "planner", "approach_reviewer", "critic"]);
  assert.equal(current.planning.history[0].reviews.critic.verdict, "revise");
  assert.equal(new Set(current.roleCommits.map(commit => commit.contextId)).size, 6);
}));

test("model drift during a pending Planner attempt stops and cannot commit late output", async () => fixture(async workspace => {
  const contract = contractFixture();
  let pi;
  const responder = async request => {
    assert.equal(request.role, "planner");
    pi.ctx.model = GENERIC_MODEL;
    await pi.emit("model_select", { type: "model_select", model: GENERIC_MODEL, previousModel: SOLAR_MODEL, source: "set" });
    return JSON.stringify({ planMarkdown: planText(contract), resolutions: [] });
  };
  ({ pi } = installHost(workspace, responder));
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed plan.");
  const workflowId = pi.workflow().id;
  const result = await pi.callTool("solar_plan_ready", {});
  assert.equal(result.details.workflowValidationError, true);
  assert.equal(pi.workflow().status, "paused");
  assert.match(pi.workflow().reason, /model changed|model\/thinking identity/iu);
  assert.equal(pi.workflow().plan, undefined);
  assert.equal(pi.workflow().roleCommits?.length ?? 0, 0);
  assert.equal(existsSync(path.join(workspace, ".solar-workflow", workflowId, "plan.md")), false);
}));

async function reviewedExecution(workspace, { gateKind = "command", gateCount = 1, exec } = {}) {
  const contract = contractFixture({ gateKind, gateCount });
  const { pi } = installHost(workspace, passingResponder(contract), { exec });
  await startAndInitialize(pi, "/skill:solar-plan Create and execute the exact bounded result.");
  const planned = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(planned, "executable role cycle");
  assert.equal(pi.workflow().status, "awaiting_gate_review");
  await pi.command("solar-workflow", `approve ${pi.workflow().revision.slice(0, 12)}`);
  assert.equal(pi.workflow().stage, "execute");
  assert.equal(pi.workflow().status, "active");
  return { pi, contract };
}

test("only approved execution binds the Executor and retains exact tool capabilities", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace);
  const result = await pi.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: pi.sentUserMessages.at(-1).message,
    systemPrompt: "base",
  });
  assert.equal(result.systemPrompt, `base\n${renderHarnessRolePrompt("executor")}`);
  assert.deepEqual(pi.activeTools.sort(), ["write", "solar_step_done", "solar_revisit"].sort());
  assert.equal((await pi.emit("tool_call", {
    type: "tool_call", toolCallId: "harness-outside", toolName: "write",
    input: { path: "undeclared.txt", content: "not authorized" },
  })).block, true);
}));

test("the actual resume command restores reloaded execution and final-review verification states", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace, { gateKind: "rubric" });
  await pi.emit("session_start", { type: "session_start", reason: "reload" });
  assert.equal(pi.workflow().status, "paused");
  await pi.command("solar-workflow", "resume");
  assert.equal(pi.workflow().stage, "execute");
  assert.equal(pi.workflow().status, "active");
  assert.ok(pi.sentUserMessages.at(-1).message.startsWith("/skill:solar-execute"));

  writeFileSync(path.join(workspace, "result.txt"), "current qualitative result", "utf8");
  await pi.callTool("solar_step_done", {
    stepId: "S1",
    summary: "Created the exact current qualitative result.",
    approach: { id: "resume-write", description: "Reuse the reviewed exact write capability after reload." },
    evidence: ["result.txt"],
  });
  await pi.callTool("solar_step_done", {
    stepId: "final",
    summary: "Capture fresh final and acceptance manifests.",
    approach: { id: "resume-final", description: "Rehash the final around every approved rubric gate." },
    evidence: ["result.txt"],
  });
  assert.equal(pi.workflow().status, "awaiting_final_review");
  await pi.command("solar-workflow", "resume");
  assert.equal(pi.workflow().stage, "execute");
  assert.equal(pi.workflow().status, "active");
  assert.ok(pi.sentUserMessages.at(-1).message.startsWith("/skill:solar-execute"));
}));

test("stop and model drift tombstone late execution results, duplicate call IDs, and unknown result IDs", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace, { gateKind: "command" });
  const call = { type: "tool_call", toolCallId: "late-stop", toolName: "write", input: { path: "result.txt", content: "current" } };
  assert.equal(await pi.emit("tool_call", call), undefined);
  const duplicate = await pi.emit("tool_call", { ...call, input: { path: "result.txt", content: "overwritten duplicate" } });
  assert.equal(duplicate.block, true);
  assert.match(duplicate.reason, /Duplicate tool-call ID/iu);

  await pi.command("solar-workflow", "stop");
  const stoppedLate = await pi.emit("tool_result", {
    type: "tool_result",
    toolCallId: "late-stop",
    toolName: "write",
    input: call.input,
    content: [{ type: "text", text: "late write" }],
    details: undefined,
    isError: false,
  });
  assert.equal(stoppedLate.isError, true);
  assert.equal(stoppedLate.details.staleExecutionResult, true);
  const unknownStopped = await pi.emit("tool_result", {
    type: "tool_result",
    toolCallId: "unknown-after-stop",
    toolName: "write",
    input: { path: "result.txt" },
    content: [{ type: "text", text: "unknown" }],
    details: undefined,
    isError: false,
  });
  assert.equal(unknownStopped.isError, true);
  assert.equal(unknownStopped.details.staleExecutionResult, true);
  assert.equal(pi.workflow().results?.S1, undefined);

  await pi.command("solar-workflow", "resume");
  assert.equal(pi.workflow().status, "active");
  const driftCall = { type: "tool_call", toolCallId: "late-drift", toolName: "write", input: { path: "result.txt", content: "current" } };
  assert.equal(await pi.emit("tool_call", driftCall), undefined);
  pi.ctx.model = GENERIC_MODEL;
  await pi.emit("model_select", { type: "model_select", model: GENERIC_MODEL, previousModel: SOLAR_MODEL, source: "set" });
  assert.equal(pi.workflow().status, "paused");
  const driftLate = await pi.emit("tool_result", {
    type: "tool_result",
    toolCallId: "late-drift",
    toolName: "write",
    input: driftCall.input,
    content: [{ type: "text", text: "late drift write" }],
    details: undefined,
    isError: false,
  });
  assert.equal(driftLate.isError, true);
  assert.equal(driftLate.details.staleExecutionResult, true);
  const unknownDrift = await pi.emit("tool_result", {
    type: "tool_result",
    toolCallId: "unknown-after-drift",
    toolName: "write",
    input: { path: "result.txt" },
    content: [{ type: "text", text: "unknown" }],
    details: undefined,
    isError: false,
  });
  assert.equal(unknownDrift.isError, true);
  assert.equal(unknownDrift.details.staleExecutionResult, true);
  assert.equal(pi.workflow().results?.S1, undefined);
}));

test("model operations and direct gates share fresh authority; stale gate A prevents gate B and checkpoint commit", async () => fixture(async workspace => {
  let pi;
  let dispatches = 0;
  ({ pi } = await reviewedExecution(workspace, {
    gateKind: "command",
    gateCount: 2,
    exec: async () => {
      dispatches += 1;
      if (dispatches === 1) {
        const fresh = pi.workflow();
        pi.appendEntry(WORKFLOW_STATE, { ...fresh, status: "stopped", reason: "Injected stale boundary." });
      }
      return { code: 0, stdout: "passed", stderr: "", killed: false };
    },
  }));

  const allowed = await pi.emit("tool_call", { type: "tool_call", toolCallId: "allowed-write", toolName: "write", input: { path: "result.txt", content: "current" } });
  assert.equal(allowed, undefined);
  const denied = await pi.emit("tool_call", { type: "tool_call", toolCallId: "denied-write", toolName: "write", input: { path: "later.txt", content: "no" } });
  assert.equal(denied.block, true);
  assert.match(denied.reason, /does not declare|default-denied/iu);

  writeFileSync(path.join(workspace, "result.txt"), "current", "utf8");
  const result = await pi.callTool("solar_step_done", {
    stepId: "S1",
    summary: "Created the exact current result; host gates decide acceptance.",
    approach: { id: "initial-write", description: "Write result.txt through the exact declared host capability." },
    evidence: ["result.txt"],
  });
  assert.equal(result.details.workflowValidationError, true);
  assert.equal(dispatches, 1, "Gate B dispatched after gate A invalidated authority");
  assert.equal(pi.workflow().status, "stopped");
  assert.equal(pi.workflow().results?.S1, undefined);

  const staleResult = await pi.emit("tool_result", { type: "tool_result", toolCallId: "allowed-write", toolName: "write", input: { path: "result.txt" }, content: [{ type: "text", text: "wrote" }], details: undefined, isError: false });
  assert.equal(staleResult.isError, true);
  assert.equal(staleResult.details.staleExecutionResult, true);
}));

test("changed final bytes during the guarded final batch cannot complete", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace, { gateKind: "command" });
  writeFileSync(path.join(workspace, "result.txt"), "step-current", "utf8");
  const checkpoint = await pi.callTool("solar_step_done", {
    stepId: "S1",
    summary: "Created current result bytes.",
    approach: { id: "write-current", description: "Write the exact declared final artifact." },
    evidence: ["result.txt"],
  });
  assert.equal(checkpoint.details.status, "active");
  assert.equal(pi.workflow().results.S1.passed, true);

  pi.execImpl = async () => {
    writeFileSync(path.join(workspace, "result.txt"), "changed-during-final", "utf8");
    return { code: 0, stdout: "passed", stderr: "", killed: false };
  };
  const final = await pi.callTool("solar_step_done", {
    stepId: "final",
    summary: "Run fresh final manifests and all exact gates.",
    approach: { id: "final-verification", description: "Hash finals before and after the current gate batch." },
    evidence: ["result.txt"],
  });
  assert.equal(final.details.status, "active");
  assert.equal(pi.workflow().stage, "plan");
  assert.equal(pi.workflow().approval, undefined);
  assert.match(pi.workflow().gap, /changed during final verification/iu);
  assert.notEqual(pi.workflow().finalManifestBefore.files[0].hash, pi.workflow().finalManifest.files[0].hash);
}));

test("human final acceptance token becomes stale when a declared final changes", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace, { gateKind: "rubric" });
  writeFileSync(path.join(workspace, "result.txt"), "qualitative-current", "utf8");
  await pi.callTool("solar_step_done", {
    stepId: "S1",
    summary: "Created the current qualitative final.",
    approach: { id: "write-qualitative", description: "Write the declared human-accepted final artifact." },
    evidence: ["result.txt"],
  });
  await pi.callTool("solar_step_done", {
    stepId: "final",
    summary: "Capture current final and qualitative evidence manifests.",
    approach: { id: "final-rubric", description: "Hash the current final around the rubric capture." },
    evidence: ["result.txt"],
  });
  const waiting = pi.workflow();
  assert.equal(waiting.status, "awaiting_final_review");
  const token = waiting.finalReview.slice(0, 12);
  writeFileSync(path.join(workspace, "result.txt"), "changed-after-review", "utf8");
  await pi.command("solar-workflow", `accept ${token}`);
  assert.equal(pi.workflow().status, "awaiting_final_review");
  assert.ok(pi.notifications.some(item => /changed after final checks|changed/iu.test(item.message)));
}));

test("non-Solar input is handled before workflow inference and does not auto-switch model", async () => fixture(async workspace => {
  const contract = contractFixture();
  let roleCalls = 0;
  const { pi } = installHost(workspace, request => {
    roleCalls += 1;
    return passingResponder(contract)(request);
  });
  await pi.emit("session_start", { type: "session_start", reason: "startup" });
  pi.ctx.model = GENERIC_MODEL;
  pi.ctx.thinkingLevel = "off";
  const result = await pi.startInput("/skill:solar-plan --plan-only Refuse before inference.");
  assert.equal(result.action, "handled");
  assert.equal(pi.workflow(), undefined);
  assert.equal(roleCalls, 0);
  assert.equal(pi.sentUserMessages.length, 0);
  assert.ok(pi.notifications.some(item => /upstage\/solar-pro4|thinking level max/iu.test(item.message)));
  assert.equal(pi.ctx.model, GENERIC_MODEL, "The extension must not switch models automatically");
  assert.equal(pi.ctx.thinkingLevel, "off", "The extension must not persist or change thinking configuration");
}));
