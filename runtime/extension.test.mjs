import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const { NATIVE_TOOL_AUTHORITY_ENTRY, validateNativeToolAuthorityReceipt } = await import("./loop.ts");
const { renderHarnessRolePrompt } = await import("./harness.ts");
const { EXECUTION_CONTRACT_ID_PATTERN } = await import("./planner-output.ts");
const {
  expectedFixtureOutput,
  getHarnessFixture,
  gradeHarnessResult,
  validateSyntheticApproval,
} = await import("../scripts/harness-fixtures.mjs");

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

function textValues(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach(item => textValues(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach(item => textValues(item, result));
  return result;
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
    this.unavailableTools = new Set(options.unavailableTools ?? []);
    this.entrySequence = 0;
    this.aborts = 0;
    this.execCalls = [];
    this.execImpl = options.exec ?? (async () => ({ code: 0, stdout: "passed", stderr: "", killed: false }));
    this.ctx = {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: {
        getBranch: () => this.entries,
        getSessionDir: () => options.sessionDir ?? (options.sessionFile ? path.dirname(options.sessionFile) : ""),
        getSessionFile: () => options.sessionFile,
      },
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
    return [...new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", ...this.tools.keys()])]
      .filter(name => !this.unavailableTools.has(name))
      .map(name => ({ name }));
  }

  setActiveTools(names) {
    const configured = new Set(this.getAllTools().map(tool => tool.name));
    this.activeTools = names.filter(name => configured.has(name));
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

function retainAssistantToolCalls(pi, calls) {
  const id = `assistant-${++pi.entrySequence}`;
  pi.entries.push({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: calls.map(call => ({
        type: "toolCall",
        id: call.toolCallId,
        name: call.toolName,
        arguments: structuredClone(call.input ?? {}),
      })),
    },
  });
  return id;
}

async function emitRetainedToolCall(pi, event, siblingCalls = [], ctx = pi.ctx) {
  const assistantEntryId = retainAssistantToolCalls(pi, [event, ...siblingCalls]);
  const outcome = await pi.emit("tool_call", event, ctx);
  return { assistantEntryId, outcome };
}

function nativeToolAuthorityEntries(pi, kind) {
  return pi.entries
    .filter(entry => entry.type === "custom" && entry.customType === NATIVE_TOOL_AUTHORITY_ENTRY)
    .filter(entry => kind === undefined || entry.data?.kind === kind)
    .map(entry => ({ ...entry, data: validateNativeToolAuthorityReceipt(entry.data) }));
}

function createRoleFactory(responder, stats = {}) {
  stats.requests ??= [];
  stats.sessions ??= [];
  return async request => {
    stats.requests.push(request);
    const state = {
      model: {
        provider: "upstage",
        id: "solar-pro4",
        api: "openai-completions",
        ...(request.responseSchema === undefined ? {} : {
          samplingParams: {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "solar_planner_output",
                strict: true,
                schema: structuredClone(request.responseSchema),
              },
            },
          },
        }),
      },
      thinkingLevel: "max",
      tools: [],
      messages: [],
    };
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushUntil(predicate, message) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

class FakeClock {
  time = 0;
  nextId = 1;
  timers = new Map();

  now() {
    return this.time;
  }

  setTimeout(callback, delayMs) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  tick(milliseconds) {
    this.time += milliseconds;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.time)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) return;
      const [id, timer] = due[0];
      this.timers.delete(id);
      timer.callback();
    }
  }
}

function installHost(workspace, responder, options = {}) {
  const roleStats = {};
  const pi = new FakePi(workspace, options);
  let id = 0;
  installLiteRuntime(pi, {
    roleSessionFactory: createRoleFactory(responder, roleStats),
    roleIdFactory: kind => `${kind}-${++id}`,
    agentDir: options.agentDir ?? path.join(path.dirname(workspace), "agent"),
    ...(options.roleClock === undefined ? {} : { roleClock: options.roleClock }),
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

const FIXTURE_SECTION_HEADINGS = [
  ["goalAndScope", "Goal and scope"],
  ["stepsAndValidation", "Steps and validation"],
  ["designReview", "Design review"],
  ["riskReviewAndRevisions", "Risk review and revisions"],
  ["acceptanceCriteria", "Acceptance criteria"],
  ["remainingUncertainties", "Remaining uncertainties"],
];

function plannerSections(revisionNote = "Initial complete plan.") {
  return {
    goalAndScope: "Create only result.txt from the selected requirements.",
    stepsAndValidation: "1. Create result.txt and run every exact descriptor-bound gate.",
    designReview: "One bounded artifact and exact write capability are sufficient.",
    riskReviewAndRevisions: revisionNote,
    acceptanceCriteria: "Current result bytes satisfy every declared command or human gate.",
    remainingUncertainties: "No hidden structural uncertainty remains; qualitative judgment stays human-owned.",
  };
}

function canonicalFixtureValue(value) {
  if (Array.isArray(value)) return value.map(canonicalFixtureValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalFixtureValue(child)]));
}

function planText(contract, sectionsOrRevisionNote = plannerSections()) {
  const sections = typeof sectionsOrRevisionNote === "string" ? plannerSections(sectionsOrRevisionNote) : sectionsOrRevisionNote;
  const lines = ["# Plan", "Status: ready", ""];
  for (const [key, heading] of FIXTURE_SECTION_HEADINGS) lines.push(`## ${heading}`, sections[key].trim(), "");
  lines.push("## Execution contract", "```json", JSON.stringify(canonicalFixtureValue(contract), null, 2), "```", "");
  return lines.join("\n");
}

function plannerOutput(contract, sectionsOrRevisionNote = plannerSections(), resolutions = []) {
  const sections = typeof sectionsOrRevisionNote === "string" ? plannerSections(sectionsOrRevisionNote) : sectionsOrRevisionNote;
  return JSON.stringify({ status: "ready", sections, contract, resolutions });
}

function dereferenceSchema(root, value) {
  let current = value;
  const seen = new Set();
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    assert.match(current.$ref, /^#\//u);
    assert.ok(!seen.has(current.$ref), `Circular schema reference ${current.$ref}`);
    seen.add(current.$ref);
    current = current.$ref.slice(2).split("/").reduce((node, segment) => node[segment.replaceAll("~1", "/").replaceAll("~0", "~")], root);
  }
  return current;
}

function schemaNodes(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  return [value, ...Object.values(value).flatMap(item => schemaNodes(item, seen))];
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

function passingResponder(contract, sectionsOrRevisionNote = plannerSections()) {
  return request => request.role === "planner"
    ? plannerOutput(contract, sectionsOrRevisionNote)
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

test("interview model contract separates evidence IDs, content hashes, dimension gaps, and solo-report budget", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Create the exact bounded local result.");
  const entry = pi.entries.find(item => item.type === "message" && item.message.role === "user");
  const answer = { id: entry.id, text: entry.message.content[0].text };
  const tool = pi.tools.get("solar_interview_round");
  assert.match(tool.description, /only tool call/u);
  for (const name of ["goal", "constraints", "success", "context"]) {
    assert.match(tool.parameters.properties[name].properties.evidence.description, /Exact saved answer IDs only/u);
    assert.match(tool.parameters.properties[name].properties.gap.description, /If score is below 1/u);
  }
  assert.match(tool.parameters.properties.materialState.properties.topics.items.properties.sourceContentHashes.description, /only in MaterialState sourceContentHashes/u);
  assert.match(tool.parameters.properties.readiness.properties.materialGaps.items.properties.evidenceIds.description, /Exact saved answer IDs only/u);
  assert.match(tool.parameters.properties.readiness.description, /Never mark an unknown ready/u);

  const messages = [structuredClone(entry.message)];
  const firstContext = await pi.emit("context", { type: "context", messages });
  const firstText = firstContext.messages.flatMap(message => message.content).filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.ok(firstText.includes(`Exact saved answer IDs allowed in every evidence/evidenceIds array: ${JSON.stringify([answer.id])}`));
  assert.ok(firstText.includes(`Exact content hashes allowed only in MaterialState sourceContentHashes: ${JSON.stringify([sha256(answer.text)])}`));
  assert.match(firstText, /6 of 6 interview-stage tool calls remain/u);

  for (const id of ["read-one", "read-two"]) {
    assert.equal(await pi.emit("tool_call", { type: "tool_call", toolCallId: id, toolName: "read", input: { path: `${id}.txt` } }), undefined);
  }
  const laterContext = await pi.emit("context", { type: "context", messages });
  const laterText = laterContext.messages.flatMap(message => message.content).filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(laterText, /4 of 6 interview-stage tool calls remain/u);

  const invalid = readyProposal(answer);
  invalid.goal.evidence = [sha256(answer.text)];
  const rejected = await pi.callTool("solar_interview_round", invalid);
  const rejectionText = rejected.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.equal(rejected.details.interviewValidationError, true);
  assert.match(rejectionText, /INTERVIEWROUNDV2 SERIALIZATION AND DISPATCH PREFLIGHT/u);
  assert.ok(rejectionText.includes(`Exact saved answer IDs allowed in every evidence/evidenceIds array: ${JSON.stringify([answer.id])}`));

  for (const id of ["read-three", "read-four", "read-five", "read-six"]) {
    assert.equal(await pi.emit("tool_call", { type: "tool_call", toolCallId: id, toolName: "read", input: { path: `${id}.txt` } }), undefined);
  }
  const exhausted = await pi.emit("tool_call", { type: "tool_call", toolCallId: "read-seven", toolName: "read", input: { path: "read-seven.txt" } });
  assert.equal(exhausted.block, true);
  assert.equal(exhausted.terminate, true);
  assert.match(exhausted.reason, /Interview tool budget reached/u);

  pi.entries.push({
    type: "message",
    id: "mixed-assistant",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "mixed-report", name: "solar_interview_round", arguments: invalid },
        { type: "toolCall", id: "mixed-read", name: "read", arguments: { path: "input.json" } },
      ],
    },
  });
  const mixed = await pi.emit("tool_call", { type: "tool_call", toolCallId: "mixed-report", toolName: "solar_interview_round", input: invalid });
  assert.equal(mixed.block, true);
  assert.equal(mixed.terminate, true);
  assert.match(mixed.reason, /must be the only tool call in its assistant response/u);
}));

test("interview context supplies inline identity and labels a retained assessment stale after correction", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Create one local evidence file named result.txt.");
  const firstEntry = pi.entries.find(entry => entry.type === "message" && entry.message.role === "user");
  const firstAnswer = { id: firstEntry.id, text: firstEntry.message.content[0].text };
  const decisionPrompt = await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "Assess the current saved specification.", systemPrompt: "base" });
  const firstMessages = await pi.emit("context", { type: "context", messages: [structuredClone(firstEntry.message)] });
  const firstText = `${decisionPrompt.systemPrompt}\n${textValues(firstMessages.messages).join("\n")}`;
  assert.match(firstText, /current answers, exact saved-answer IDs, separately labeled content hashes, answer head, research head/u);
  assert.match(firstText, /read is optional and only for necessary, authorized, existing evidence/u);
  assert.match(firstText, /self-contained specification goes directly to solar_interview_round/u);
  assert.match(firstText, /required tool selection .* does not imply a preliminary read/u);
  assert.match(firstText, /Skill-location and head hints .* grant no backing-file lookup authority/u);
  assert.match(firstText, /Latest saved assessment \(preserved history; current-head match: false\): null/u);

  const firstReport = await pi.callTool("solar_interview_round", readyProposal(firstAnswer));
  assertToolSucceeded(firstReport, "first current-head assessment");
  const staleToken = firstReport.details.state.goalToken;
  await pi.startInput("Correction: write final.csv instead, with the same local-only observable success.");
  const correctionEntry = [...pi.entries].reverse().find(entry => entry.type === "message" && entry.message.role === "user");
  const corrected = await pi.emit("context", { type: "context", messages: [structuredClone(correctionEntry.message)] });
  const correctedText = textValues(corrected.messages).join("\n");
  const expectedIds = [firstEntry.id, correctionEntry.id];
  const expectedHashes = [sha256(firstAnswer.text), sha256(correctionEntry.message.content[0].text)];
  assert.ok(correctedText.includes(`Exact saved answer IDs allowed in every evidence/evidenceIds array: ${JSON.stringify(expectedIds)}`));
  assert.ok(correctedText.includes(`Exact content hashes allowed only in MaterialState sourceContentHashes: ${JSON.stringify(expectedHashes)}`));
  assert.ok(correctedText.includes(`Latest saved assessment (preserved history; current-head match: false): ${JSON.stringify(firstReport.details.state)}`));
  assert.ok(correctedText.includes(`Current answer head: ${JSON.stringify(correctionEntry.id)}. Current research head: null.`));
  assert.match(correctedText, /6 of 6 interview-stage tool calls remain/u);

  await pi.startInput(`/solar-interview confirm ${staleToken}`);
  assert.equal(pi.latest("solar-interview-closure-v2"), undefined, "A correction must keep the prior assessment token stale");
  assert.equal(pi.workflow().stage, "interview");
}));

test("interview read dispatch rejects canonical private identities before any underlying read", async () => fixture(async (workspace, root) => {
  const privateSentinel = "SYNTHETIC_PRIVATE_STATE_NOT_A_SECRET_84d2";
  const agentDir = path.join(root, "agent-private");
  const sessionFile = path.join(root, "session.jsonl");
  const piState = path.join(workspace, ".pi");
  const evidenceDir = path.join(workspace, "evidence");
  mkdirSync(agentDir);
  mkdirSync(piState);
  mkdirSync(evidenceDir);
  writeFileSync(path.join(agentDir, "auth.json"), privateSentinel, "utf8");
  writeFileSync(sessionFile, privateSentinel, "utf8");
  writeFileSync(path.join(piState, "answer-head.json"), privateSentinel, "utf8");
  writeFileSync(path.join(evidenceDir, "SKILL.md"), "authorized user evidence", "utf8");
  symlinkSync(agentDir, path.join(workspace, "agent-alias"), process.platform === "win32" ? "junction" : "dir");

  const { pi } = installHost(workspace, passingResponder(contractFixture()), { agentDir, sessionDir: root, sessionFile });
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Use evidence/SKILL.md as existing evidence for one local output.");
  const userEntry = pi.entries.find(entry => entry.type === "message" && entry.message.role === "user");
  await pi.emit("context", { type: "context", messages: [structuredClone(userEntry.message)] });

  const underlyingReads = [];
  const dispatchRead = async (id, target) => {
    const event = { type: "tool_call", toolCallId: id, toolName: "read", input: { path: target } };
    const decision = await pi.emit("tool_call", event);
    if (!decision?.block) {
      underlyingReads.push(target);
      readFileSync(path.isAbsolute(target) ? target : path.resolve(workspace, target.replace(/[\\/]/gu, path.sep)), "utf8");
    }
    return decision;
  };
  const packageImplementation = fileURLToPath(new URL("./extension.ts", import.meta.url));
  const privateAliases = [
    ".pi/answer-head.json",
    path.join(workspace, ".pi", "answer-head.json"),
    `evidence${path.sep}..${path.sep}${process.platform === "win32" ? ".PI" : ".pi"}\\answer-head.json`,
    path.join("agent-alias", "auth.json"),
    packageImplementation,
    path.join("..", "session.jsonl"),
  ];
  for (const [index, target] of privateAliases.entries()) {
    const denied = await dispatchRead(`private-${index + 1}`, target);
    assert.equal(denied.block, true);
    assert.equal(denied.terminate, true);
    assert.match(denied.reason, /Interview read denied before dispatch/u);
    assert.doesNotMatch(denied.reason, new RegExp(privateSentinel));
  }
  assert.deepEqual(underlyingReads, []);

  const syntheticLateResult = await pi.emit("tool_result", {
    type: "tool_result",
    toolCallId: "private-1",
    toolName: "read",
    input: { path: ".pi/answer-head.json" },
    content: [{ type: "text", text: privateSentinel }],
    details: undefined,
    isError: false,
  });
  assert.equal(syntheticLateResult.isError, true);
  assert.equal(syntheticLateResult.details.staleExecutionResult, true);
  assert.match(syntheticLateResult.content[0].text, /Interview read denied before dispatch/u);
  assert.doesNotMatch(syntheticLateResult.content[0].text, new RegExp(privateSentinel));

  const duplicate = await dispatchRead("private-1", ".pi/answer-head.json");
  assert.equal(duplicate.block, true);
  assert.match(duplicate.reason, /Duplicate tool-call ID/u);
  const afterDenials = await pi.emit("context", { type: "context", messages: [structuredClone(userEntry.message)] });
  assert.match(textValues(afterDenials.messages).join("\n"), /0 of 6 interview-stage tool calls remain/u);
  const exhausted = await dispatchRead("after-private-budget", "evidence/SKILL.md");
  assert.equal(exhausted.block, true);
  assert.match(exhausted.reason, /Interview tool budget reached/u);
  assert.deepEqual(underlyingReads, []);
}));

test("interview read dispatch matches Pi read path aliases without denying ordinary aliases", async () => fixture(async workspace => {
  const homeAgentName = `solar-private-agent-${process.pid}`;
  const agentDir = path.join(os.homedir(), homeAgentName);
  const piState = path.join(workspace, ".pi");
  const ordinary = path.join(workspace, "ordinary evidence.txt");
  mkdirSync(piState);
  writeFileSync(path.join(piState, "answer-head.json"), "synthetic controller state", "utf8");
  writeFileSync(ordinary, "authorized ordinary alias evidence", "utf8");
  const { pi } = installHost(workspace, passingResponder(contractFixture()), { agentDir });
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Use the authorized ordinary evidence.");

  const privateAliases = [
    "@.pi/answer-head.json",
    pathToFileURL(path.join(piState, "answer-head.json")).href,
    `~/${homeAgentName}/auth.json`,
    path.toNamespacedPath(path.join(piState, "answer-head.json")),
  ];
  for (const [index, target] of privateAliases.entries()) {
    const denied = await pi.emit("tool_call", { type: "tool_call", toolCallId: `resolver-private-${index + 1}`, toolName: "read", input: { path: target } });
    assert.equal(denied.block, true);
    assert.match(denied.reason, /Interview read denied before dispatch/u);
  }
  const allowed = await pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "resolver-ordinary",
    toolName: "read",
    input: { path: pathToFileURL(ordinary).href },
  });
  assert.equal(allowed, undefined);
  assert.equal(readFileSync(ordinary, "utf8"), "authorized ordinary alias evidence");
  if (process.platform === "win32") {
    const ambiguous = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "resolver-ambiguous-namespace",
      toolName: "read",
      input: { path: String.raw`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1\state` },
    });
    assert.equal(ambiguous.block, true);
    assert.match(ambiguous.reason, /unsupported or ambiguous syntax.*Only drive and UNC Windows filesystem namespace paths are supported/iu);
  }
}));

test("interview read dispatch protects NTFS stream aliases without banning ordinary evidence streams", { skip: process.platform !== "win32" }, async () => fixture(async (workspace, root) => {
  const privateSentinel = "SYNTHETIC_NTFS_SESSION_SENTINEL_NOT_A_SECRET_30f1";
  const namedPrivateSentinel = "SYNTHETIC_NAMED_STREAM_SENTINEL_NOT_A_SECRET_45be";
  const ordinarySentinel = "AUTHORIZED_NTFS_EVIDENCE_STREAM_80dc";
  const sessionFile = path.join(root, "current-session.jsonl");
  const defaultSessionStream = `${sessionFile}::$DATA`;
  const namedSessionStream = `${sessionFile}:private-state`;
  const controllerRoot = path.join(workspace, ".pi");
  const ordinaryFile = path.join(workspace, "ordinary-evidence.txt");
  const ordinaryStream = `${ordinaryFile}:authorized-evidence`;
  mkdirSync(controllerRoot);
  writeFileSync(sessionFile, privateSentinel, "utf8");
  writeFileSync(namedSessionStream, namedPrivateSentinel, "utf8");
  writeFileSync(ordinaryFile, "ordinary base bytes", "utf8");
  writeFileSync(ordinaryStream, ordinarySentinel, "utf8");
  assert.equal(readFileSync(defaultSessionStream, "utf8"), privateSentinel, "The Windows default-stream alias must reproduce the protected session bytes");
  assert.equal(readFileSync(namedSessionStream, "utf8"), namedPrivateSentinel, "The named private stream fixture must be readable by Node");
  assert.equal(readFileSync(ordinaryStream, "utf8"), ordinarySentinel, "The named ordinary evidence stream fixture must be readable by Node");

  const { pi } = installHost(workspace, passingResponder(contractFixture()), { sessionDir: root, sessionFile });
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Use the authorized ordinary evidence stream.");
  const underlyingReads = [];
  const dispatchRead = async (id, target) => {
    const decision = await pi.emit("tool_call", { type: "tool_call", toolCallId: id, toolName: "read", input: { path: target } });
    if (decision?.block) return { decision };
    underlyingReads.push(target);
    return { decision, text: readFileSync(target, "utf8") };
  };
  const privateAliases = [
    defaultSessionStream,
    namedSessionStream,
    path.toNamespacedPath(defaultSessionStream),
    `${controllerRoot}::$DATA`,
    `${controllerRoot}:controller-state`,
  ];
  for (const [index, target] of privateAliases.entries()) {
    const { decision } = await dispatchRead(`ntfs-private-${index + 1}`, target);
    assert.equal(decision.block, true);
    assert.equal(decision.terminate, true);
    assert.match(decision.reason, /Interview read denied before dispatch/u);
    assert.doesNotMatch(decision.reason, new RegExp(`${privateSentinel}|${namedPrivateSentinel}`));
  }
  assert.deepEqual(underlyingReads, [], "No NTFS private stream alias may reach the underlying read");

  const allowed = await dispatchRead("ntfs-ordinary-evidence", path.toNamespacedPath(ordinaryStream));
  assert.equal(allowed.decision, undefined);
  assert.equal(allowed.text, ordinarySentinel);
  assert.deepEqual(underlyingReads, [path.toNamespacedPath(ordinaryStream)], "Only the ordinary evidence stream may execute");
}));

test("interview read dispatch applies credential and session identity to NTFS backing files", { skip: process.platform !== "win32" }, async () => fixture(async (workspace, root) => {
  const envFile = path.join(root, ".env");
  const envDefaultStream = `${envFile}::$DATA`;
  const npmrcFile = path.join(root, ".npmrc");
  const npmrcNamedStream = `${npmrcFile}:registry-token`;
  const sessionBackingFile = path.join(root, "stream-backed-session.jsonl");
  const configuredSessionStream = `${sessionBackingFile}:active-session`;
  const alternateSessionStream = `${sessionBackingFile}:alternate-state`;
  writeFileSync(envFile, "synthetic env dotfile", "utf8");
  writeFileSync(npmrcFile, "synthetic npmrc base", "utf8");
  writeFileSync(npmrcNamedStream, "synthetic npmrc named stream", "utf8");
  writeFileSync(sessionBackingFile, "synthetic session backing bytes", "utf8");
  writeFileSync(configuredSessionStream, "synthetic configured session stream", "utf8");
  writeFileSync(alternateSessionStream, "synthetic alternate session stream", "utf8");
  assert.equal(readFileSync(envDefaultStream, "utf8"), "synthetic env dotfile");
  assert.equal(readFileSync(npmrcNamedStream, "utf8"), "synthetic npmrc named stream");
  assert.equal(readFileSync(configuredSessionStream, "utf8"), "synthetic configured session stream");

  const { pi } = installHost(workspace, passingResponder(contractFixture()), {
    sessionDir: root,
    sessionFile: configuredSessionStream,
  });
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Assess the inline specification without private credential or session state.");
  const underlyingReads = [];
  const privateAliases = [
    envDefaultStream,
    npmrcNamedStream,
    sessionBackingFile,
    alternateSessionStream,
  ];
  for (const [index, target] of privateAliases.entries()) {
    const decision = await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: `ntfs-backing-private-${index + 1}`,
      toolName: "read",
      input: { path: target },
    });
    if (!decision?.block) {
      underlyingReads.push(target);
      readFileSync(target, "utf8");
    }
    assert.equal(decision.block, true);
    assert.equal(decision.terminate, true);
    assert.match(decision.reason, index < 2 ? /credential-bearing dotfiles/u : /current Pi session file is private/u);
  }
  assert.deepEqual(underlyingReads, [], "Credential streams and every stream of the configured session backing file must be denied before read execution");
}));

test("interview read dispatch denies an exact-session hard link at the designated research path without denying an ordinary research artifact", async () => fixture(async (workspace, root) => {
  const privateSentinel = "session-hardlink-private".padEnd(35, "_");
  const sessionFile = path.join(root, "current-session.jsonl");
  const ordinarySibling = path.join(workspace, "ordinary-sibling.jsonl");
  assert.equal(Buffer.byteLength(privateSentinel, "utf8"), 35);
  writeFileSync(sessionFile, privateSentinel, "utf8");
  writeFileSync(ordinarySibling, "authorized ordinary sibling evidence", "utf8");

  const { pi } = installHost(workspace, passingResponder(contractFixture()), { sessionDir: root, sessionFile });
  await startAndInitialize(pi, "/skill:solar-research Establish local context before interview. --local-only");
  const returned = await pi.callTool("solar_research_ready", {
    expectedArtifactRevision: null,
    contract: {
      version: 2,
      mode: "initial",
      outcome: "ready",
      claims: [{ id: "LOCAL1", kind: "user_decision", text: "Use the authorized local evidence.", sourceIds: [] }],
      sources: [],
      learnedClaimIds: ["LOCAL1"],
      remainingGap: "The exact deliverable still needs interview confirmation.",
    },
  });
  assert.equal(returned.details.stage, "interview");
  await pi.startInput("/skill:solar-interview resume Use only the authorized local evidence. --plan-only");
  const current = pi.workflow();
  const ordinaryResearchText = current.research.text;
  rmSync(current.research.path);
  linkSync(sessionFile, current.research.path);

  assert.notEqual(realpathSync(sessionFile), realpathSync(current.research.path), "The hard-link regression requires distinct canonical path spellings");
  const sessionStat = statSync(sessionFile, { bigint: true });
  const hardLinkStat = statSync(current.research.path, { bigint: true });
  assert.notEqual(sessionStat.dev, 0n);
  assert.notEqual(sessionStat.ino, 0n);
  assert.equal(hardLinkStat.dev, sessionStat.dev);
  assert.equal(hardLinkStat.ino, sessionStat.ino);
  assert.equal(readFileSync(current.research.path, "utf8"), privateSentinel);

  const underlyingReads = [];
  const dispatchRead = async (id, target) => {
    const decision = await pi.emit("tool_call", { type: "tool_call", toolCallId: id, toolName: "read", input: { path: target } });
    if (decision?.block) return { decision };
    const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(workspace, target);
    underlyingReads.push(resolvedTarget);
    return { decision, text: readFileSync(resolvedTarget, "utf8") };
  };
  const denied = await dispatchRead("hard-linked-designated-research", current.research.relativePath);
  assert.equal(denied.decision.block, true);
  assert.equal(denied.decision.terminate, true);
  assert.match(denied.decision.reason, /current Pi session file is private/u);
  assert.doesNotMatch(denied.decision.reason, new RegExp(privateSentinel));
  assert.deepEqual(underlyingReads, [], "The hard-linked designated research path must be rejected before underlying read execution");

  rmSync(current.research.path);
  writeFileSync(current.research.path, ordinaryResearchText, "utf8");
  const ordinaryResearchStat = statSync(current.research.path, { bigint: true });
  assert.notEqual(`${ordinaryResearchStat.dev}:${ordinaryResearchStat.ino}`, `${sessionStat.dev}:${sessionStat.ino}`);
  const allowedResearch = await dispatchRead("ordinary-designated-research", current.research.relativePath);
  assert.equal(allowedResearch.decision, undefined);
  assert.equal(allowedResearch.text, ordinaryResearchText);
  assert.deepEqual(underlyingReads, [current.research.path], "An ordinary designated research artifact must retain its exact read exception");

  const allowedSibling = await dispatchRead("ordinary-hardlink-sibling", path.basename(ordinarySibling));
  assert.equal(allowedSibling.decision, undefined);
  assert.equal(allowedSibling.text, "authorized ordinary sibling evidence");
  assert.deepEqual(underlyingReads, [current.research.path, ordinarySibling], "No generic hard-link or sibling filename ban may be introduced");
}));

test("interview reads preserve non-private evidence and the exact current research artifact exception", async () => fixture(async (workspace, root) => {
  const localEvidence = path.join(workspace, "evidence", "SKILL.md");
  const externalEvidence = path.join(root, "outside-evidence.txt");
  const jsonlEvidence = path.join(workspace, "records.jsonl");
  const sessionNotes = path.join(workspace, "session_notes.md");
  const applicationSessionEvidence = path.join(workspace, "application-session-directory", "evidence.txt");
  const sessionFile = path.join(root, "current-session.jsonl");
  mkdirSync(path.dirname(localEvidence));
  mkdirSync(path.dirname(applicationSessionEvidence));
  writeFileSync(localEvidence, "legitimate Markdown-named user evidence", "utf8");
  writeFileSync(externalEvidence, "legitimate external user evidence", "utf8");
  writeFileSync(jsonlEvidence, "legitimate JSONL user evidence", "utf8");
  writeFileSync(sessionNotes, "legitimate session-named user evidence", "utf8");
  writeFileSync(applicationSessionEvidence, "legitimate application-session directory evidence", "utf8");
  writeFileSync(sessionFile, "synthetic current Pi session bytes", "utf8");

  const first = installHost(workspace, passingResponder(contractFixture()), { sessionDir: root, sessionFile }).pi;
  await startAndInitialize(first, "/skill:solar-interview --plan-only Use the supplied workspace and sibling evidence.");
  const firstEntry = first.entries.find(entry => entry.type === "message" && entry.message.role === "user");
  await first.emit("context", { type: "context", messages: [structuredClone(firstEntry.message)] });
  const sessionRead = await first.emit("tool_call", { type: "tool_call", toolCallId: "current-session", toolName: "read", input: { path: sessionFile } });
  assert.equal(sessionRead.block, true);
  assert.match(sessionRead.reason, /current Pi session file is private/u);
  for (const [id, target] of [
    ["local-evidence", "evidence/SKILL.md"],
    ["jsonl-evidence", "records.jsonl"],
    ["session-notes", "session_notes.md"],
    ["application-session-evidence", "application-session-directory/evidence.txt"],
    ["session-container-sibling", externalEvidence],
  ]) {
    assert.equal(await first.emit("tool_call", { type: "tool_call", toolCallId: id, toolName: "read", input: { path: target } }), undefined);
    assert.match(readFileSync(path.isAbsolute(target) ? target : path.join(workspace, target), "utf8"), /legitimate/u);
  }

  const researchWorkspace = path.join(root, "research-workspace");
  mkdirSync(researchWorkspace);
  const second = installHost(researchWorkspace, passingResponder(contractFixture())).pi;
  await startAndInitialize(second, "/skill:solar-research Establish local context before interview. --local-only");
  const returned = await second.callTool("solar_research_ready", {
    expectedArtifactRevision: null,
    contract: {
      version: 2,
      mode: "initial",
      outcome: "ready",
      claims: [{ id: "LOCAL1", kind: "user_decision", text: "Use the local evidence-linked context.", sourceIds: [] }],
      sources: [],
      learnedClaimIds: ["LOCAL1"],
      remainingGap: "The exact deliverable still needs interview confirmation.",
    },
  });
  assert.equal(returned.details.stage, "interview");
  await second.startInput("/skill:solar-interview resume Produce one local evidence-linked result. --plan-only");
  const researchEntry = [...second.entries].reverse().find(entry => entry.type === "message" && entry.message.role === "user");
  const researchContext = await second.emit("context", { type: "context", messages: [structuredClone(researchEntry.message)] });
  const current = second.workflow();
  assert.ok(textValues(researchContext.messages).join("\n").includes(`Exact current host-designated research artifact read exception: ${JSON.stringify([current.research.relativePath])}`));
  const packageRole = fileURLToPath(new URL("../harness/skills/interviewer/SKILL.md", import.meta.url));
  const packageRoleRead = await second.emit("tool_call", { type: "tool_call", toolCallId: "package-role", toolName: "read", input: { path: packageRole } });
  assert.equal(packageRoleRead.block, true);
  assert.match(packageRoleRead.reason, /Interview read denied before dispatch/u);
  writeFileSync(path.join(researchWorkspace, ".env"), "synthetic credential dotfile", "utf8");
  const credentialRead = await second.emit("tool_call", { type: "tool_call", toolCallId: "credential-dotfile", toolName: "read", input: { path: ".env" } });
  assert.equal(credentialRead.block, true);
  assert.match(credentialRead.reason, /credential-bearing dotfiles/u);
  assert.equal(await second.emit("tool_call", { type: "tool_call", toolCallId: "current-research", toolName: "read", input: { path: current.research.relativePath } }), undefined);
  assert.equal(await second.emit("tool_call", { type: "tool_call", toolCallId: "current-research-absolute", toolName: "read", input: { path: current.research.path } }), undefined);
  assert.equal(readFileSync(current.research.path, "utf8"), current.research.text);

  mkdirSync(path.join(researchWorkspace, "private"));
  writeFileSync(path.join(researchWorkspace, "private", "evidence.txt"), "legitimate private-domain user evidence", "utf8");
  assert.equal(await second.emit("tool_call", { type: "tool_call", toolCallId: "private-word-evidence", toolName: "read", input: { path: "private/evidence.txt" } }), undefined);
  const sibling = path.join(path.dirname(current.research.path), "controller-state.txt");
  writeFileSync(sibling, "synthetic controller state", "utf8");
  const siblingRead = await second.emit("tool_call", { type: "tool_call", toolCallId: "other-controller", toolName: "read", input: { path: path.relative(researchWorkspace, sibling) } });
  assert.equal(siblingRead.block, true);
  assert.match(siblingRead.reason, /Interview read denied before dispatch/u);
}));

test("workspace mismatch preserves owner-private identities without reviving its role or research exception", async () => fixture(async (ownerWorkspace, root) => {
  const contextWorkspace = path.join(root, "workspace-b");
  const sessionFile = path.join(root, "custom-sibling-session.jsonl");
  const ordinaryEvidence = path.join(root, "ordinary-external-evidence.txt");
  mkdirSync(contextWorkspace);
  writeFileSync(sessionFile, "synthetic current Pi session", "utf8");
  writeFileSync(ordinaryEvidence, "authorized external evidence", "utf8");
  mkdirSync(path.join(ownerWorkspace, ".pi"));
  writeFileSync(path.join(ownerWorkspace, ".pi", "answer-head.json"), "owner-private-state", "utf8");

  const { pi } = installHost(ownerWorkspace, passingResponder(contractFixture()), { sessionDir: root, sessionFile });
  await startAndInitialize(pi, "/skill:solar-research Establish local context before interview. --local-only");
  const returned = await pi.callTool("solar_research_ready", {
    expectedArtifactRevision: null,
    contract: {
      version: 2,
      mode: "initial",
      outcome: "ready",
      claims: [{ id: "LOCAL1", kind: "user_decision", text: "Use the owner workspace evidence.", sourceIds: [] }],
      sources: [],
      learnedClaimIds: ["LOCAL1"],
      remainingGap: "The exact deliverable still needs interview confirmation.",
    },
  });
  assert.equal(returned.details.stage, "interview");
  await pi.startInput("/skill:solar-interview resume Produce one owner-workspace result. --plan-only");
  const owner = pi.workflow();
  const sameRelativeInContext = path.join(contextWorkspace, owner.research.relativePath);
  mkdirSync(path.dirname(sameRelativeInContext), { recursive: true });
  writeFileSync(sameRelativeInContext, "not the owner research artifact", "utf8");

  const ownerRequest = await pi.emit("before_provider_request", {
    payload: {
      model: "solar-pro4",
      reasoning_effort: "max",
      messages: [{ role: "system", content: "base system contract" }, { role: "user", content: "continue" }],
      tools: [{ type: "function", function: { name: "solar_interview_round" } }],
      parallel_tool_calls: true,
    },
  });
  assert.match(textValues(ownerRequest.messages).join("\n"), /Active Solar main-session stage: interview/u);
  const contextB = {
    ...pi.ctx,
    cwd: contextWorkspace,
    sessionManager: {
      ...pi.ctx.sessionManager,
      getBranch: () => pi.entries,
      getSessionDir: () => root,
      getSessionFile: () => sessionFile,
    },
  };
  const mismatchRequest = await pi.emit("before_provider_request", { payload: ownerRequest }, contextB);
  const mismatchText = textValues(mismatchRequest.messages).join("\n");
  assert.doesNotMatch(mismatchText, /solar-workflow-main-instructions-v1|Package-defined Solar harness role/u);
  assert.ok(mismatchRequest.messages.some(message => message.content === "base system contract"));
  const sentBeforeSettle = pi.sentMessages.length;
  await pi.emit("agent_settled", { type: "agent_settled" }, contextB);
  assert.equal(pi.sentMessages.length, sentBeforeSettle, "A mismatched provider boundary must not revive interview repair follow-ups");

  const deniedTargets = [
    path.join(ownerWorkspace, ".pi", "answer-head.json"),
    owner.research.path,
    owner.research.relativePath,
    sessionFile,
  ];
  for (const [index, target] of deniedTargets.entries()) {
    const denied = await pi.emit("tool_call", { type: "tool_call", toolCallId: `mismatch-private-${index + 1}`, toolName: "read", input: { path: target } }, contextB);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /Interview read denied before dispatch/u);
  }
  assert.equal(await pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "mismatch-ordinary-evidence",
    toolName: "read",
    input: { path: ordinaryEvidence },
  }, contextB), undefined);
  assert.equal(readFileSync(ordinaryEvidence, "utf8"), "authorized external evidence");
}));

test("active workflow requests serialize tool generation without changing dormant requests or grants", async () => fixture(async workspace => {
  const base = {
    model: "solar-pro4", reasoning_effort: "max", messages: [],
    tools: [{ type: "function", function: { name: "solar_interview_round" } }],
    parallel_tool_calls: true, max_tokens: 131072,
  };
  const dormant = installHost(workspace, passingResponder(contractFixture())).pi;
  assert.equal(await dormant.emit("before_provider_request", { payload: base }), undefined);
  for (const [stage, tool] of [["interview", "solar_interview_round"], ["research", "solar_research_ready"], ["plan", "solar_plan_ready"]]) {
    const { pi } = installHost(workspace, passingResponder(contractFixture()));
    await startAndInitialize(pi, `/skill:solar-${stage} --plan-only Produce a bounded local result.`);
    const payload = { ...base, tools: [{ type: "function", function: { name: tool } }] };
    const before = structuredClone(payload);
    const next = await pi.emit("before_provider_request", { payload });
    assert.equal(next.parallel_tool_calls, false);
    assert.deepEqual(next.tools, payload.tools);
    assert.equal(next.max_tokens, payload.max_tokens);
    assert.equal(next.reasoning_effort, "max");
    assert.deepEqual(payload, before);
    if (stage === "interview") assert.equal(next.tool_choice, "required");
    const system = next.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.equal(system.split("<solar-workflow-main-instructions-v1>").length - 1, 1);
    if (stage === "plan") {
      assert.match(system, /Solar planning dispatcher, not the Planner/u);
      assert.doesNotMatch(system, /Package-defined Solar harness role/u);
    } else {
      assert.ok(system.includes(renderHarnessRolePrompt(stage === "interview" ? "interviewer" : "researcher")));
    }
  }
}));

test("automatic interview follow-ups rebind one owned role frame across multiple reads", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Use the supplied evidence to produce one local result.");
  const turnEntry = await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "Continue the current interview.", systemPrompt: "base system contract\nthird-party system contract" });
  const entryFrame = /<solar-workflow-main-instructions-v1>[\s\S]*?<\/solar-workflow-main-instructions-v1>/u.exec(turnEntry.systemPrompt)?.[0];
  assert.ok(entryFrame);
  const payload = {
    model: "solar-pro4",
    reasoning_effort: "max",
    messages: [
      { role: "system", content: "base system contract" },
      { role: "system", content: "third-party system contract" },
      { role: "user", content: "current interview turn" },
    ],
    tools: [
      { type: "function", function: { name: "read" } },
      { type: "function", function: { name: "solar_interview_round" } },
    ],
    parallel_tool_calls: true,
  };
  const initial = await pi.emit("before_provider_request", { payload });
  const initialSystem = initial.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  assert.equal(initialSystem.split("<solar-workflow-main-instructions-v1>").length - 1, 1);
  assert.equal(initialSystem.split("# Package-defined Solar harness role").length - 1, 1);
  assert.ok(initialSystem.includes(renderHarnessRolePrompt("interviewer")));
  assert.equal(initial.messages.find(message => typeof message.content === "string" && message.content.includes("<solar-workflow-main-instructions-v1>")).content, entryFrame);
  assert.ok(initial.messages.some(message => message.content === "base system contract"));
  assert.ok(initial.messages.some(message => message.content === "third-party system contract"));
  assert.equal(initial.parallel_tool_calls, false);
  assert.equal(initial.tool_choice, "required");

  assert.equal(await pi.emit("tool_call", { type: "tool_call", toolCallId: "followup-read-one", toolName: "read", input: { path: "evidence-one.txt" } }), undefined);
  const automaticOne = await pi.emit("before_provider_request", { payload: { ...payload, parallel_tool_calls: false } });
  const automaticOneSystem = automaticOne.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  assert.equal(automaticOneSystem.split("<solar-workflow-main-instructions-v1>").length - 1, 1);
  assert.ok(automaticOneSystem.includes(renderHarnessRolePrompt("interviewer")));

  assert.equal(await pi.emit("tool_call", { type: "tool_call", toolCallId: "followup-read-two", toolName: "read", input: { path: "evidence-two.txt" } }), undefined);
  const automaticTwo = await pi.emit("before_provider_request", { payload: { ...payload, messages: automaticOne.messages, parallel_tool_calls: false, tool_choice: "required" } });
  assert.equal(automaticTwo, undefined, "An already-bound automatic follow-up must not duplicate or rewrite its owned role frame");
}));

test("owned main-role frames replace stale roles and disappear after stop without changing other system content", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Clarify one local result.");
  const basePayload = {
    model: "solar-pro4",
    reasoning_effort: "max",
    messages: [
      { role: "system", content: "base system contract" },
      { role: "system", content: "third-party system contract" },
      { role: "user", content: "continue" },
    ],
    tools: [{ type: "function", function: { name: "solar_interview_round" } }],
    parallel_tool_calls: true,
  };
  const interviewRequest = await pi.emit("before_provider_request", { payload: basePayload });
  await pi.command("solar-workflow", "stop");
  await pi.startInput("/skill:solar-research --research-only --local-only Record one local decision.");
  const researchRequest = await pi.emit("before_provider_request", {
    payload: {
      ...basePayload,
      messages: interviewRequest.messages,
      tools: [{ type: "function", function: { name: "solar_research_ready" } }],
    },
  });
  const researchSystem = researchRequest.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  assert.equal(researchSystem.split("<solar-workflow-main-instructions-v1>").length - 1, 1);
  assert.equal(researchSystem.split("# Package-defined Solar harness role").length - 1, 1);
  assert.ok(researchSystem.includes(renderHarnessRolePrompt("researcher")));
  assert.ok(!researchSystem.includes(renderHarnessRolePrompt("interviewer")));
  assert.ok(researchRequest.messages.some(message => message.content === "base system contract"));
  assert.ok(researchRequest.messages.some(message => message.content === "third-party system contract"));

  await pi.command("solar-workflow", "stop");
  const dormant = await pi.emit("before_provider_request", { payload: researchRequest });
  const dormantSystem = dormant.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
  assert.doesNotMatch(dormantSystem, /solar-workflow-main-instructions-v1|Package-defined Solar harness role/u);
  assert.ok(dormant.messages.some(message => message.content === "base system contract"));
  assert.ok(dormant.messages.some(message => message.content === "third-party system contract"));
  assert.deepEqual(dormant.tools, researchRequest.tools);
  assert.equal(dormant.parallel_tool_calls, researchRequest.parallel_tool_calls);
}));

test("active provider instruction binding fails closed on a malformed owned frame", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Clarify one local result.");
  const aborts = pi.aborts;
  const result = await pi.emit("before_provider_request", {
    payload: {
      model: "solar-pro4",
      reasoning_effort: "max",
      messages: [
        { role: "system", content: "base system contract" },
        { role: "system", content: "<solar-workflow-main-instructions-v1>\nincomplete stale binding" },
      ],
      tools: [{ type: "function", function: { name: "solar_interview_round" } }],
      parallel_tool_calls: true,
    },
  });
  assert.equal(result, undefined);
  assert.equal(pi.aborts, aborts + 1);
  assert.equal(pi.workflow().status, "paused");
  assert.match(pi.workflow().reason, /instruction binding failed closed.*frame is incomplete/iu);
  assert.match(pi.notifications.at(-1).message, /instruction binding failed closed/iu);
  assert.deepEqual(pi.activeTools, ["read"]);
}));

test("stopped interviews restore ordinary reads beyond the assessment budget while paused interviews retain private denial", async () => fixture(async workspace => {
  mkdirSync(path.join(workspace, ".pi"));
  writeFileSync(path.join(workspace, ".pi", "answer-head.json"), "synthetic controller state", "utf8");
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Clarify one local result.");
  const bound = await pi.emit("before_provider_request", {
    payload: {
      model: "solar-pro4",
      reasoning_effort: "max",
      messages: [{ role: "system", content: "base system contract" }, { role: "user", content: "continue" }],
      tools: [{ type: "function", function: { name: "solar_interview_round" } }],
      parallel_tool_calls: true,
    },
  });
  for (let index = 1; index <= 6; index += 1) {
    assert.equal(await pi.emit("tool_call", { type: "tool_call", toolCallId: `active-budget-${index}`, toolName: "read", input: { path: `ordinary-${index}.txt` } }), undefined);
  }
  await pi.command("solar-workflow", "stop");
  assert.equal(pi.workflow().status, "stopped");
  for (let index = 1; index <= 8; index += 1) {
    assert.equal(await pi.emit("tool_call", { type: "tool_call", toolCallId: `stopped-read-${index}`, toolName: "read", input: { path: `ordinary-after-stop-${index}.txt` } }), undefined);
  }
  const stoppedRequest = await pi.emit("before_provider_request", { payload: bound });
  assert.doesNotMatch(textValues(stoppedRequest.messages).join("\n"), /solar-workflow-main-instructions-v1|Package-defined Solar harness role/u);
  assert.ok(stoppedRequest.messages.some(message => message.content === "base system contract"));

  await pi.startInput("/skill:solar-interview --plan-only Clarify another local result.");
  const entry = [...pi.entries].reverse().find(item => item.type === "message" && item.message.role === "user");
  const answer = { id: entry.id, text: entry.message.content[0].text };
  await pi.emit("context", { type: "context", messages: [structuredClone(entry.message)] });
  assertToolSucceeded(await pi.callTool("solar_interview_round", openProposal([answer], "question", "What exact result means success?")), "open paused-state report");
  await pi.command("solar-interview", "pause");
  assert.equal(pi.workflow().status, "paused");
  const denied = await pi.emit("tool_call", { type: "tool_call", toolCallId: "paused-private-read", toolName: "read", input: { path: ".pi/answer-head.json" } });
  assert.equal(denied.block, true);
  assert.match(denied.reason, /Interview read denied before dispatch/u);
}));

test("stopped interview workspace mismatches preserve ordinary reads in current and freshly restored runtimes", async () => fixture(async (ownerWorkspace, root) => {
  const contextWorkspace = path.join(root, "workspace-b");
  const ordinaryEvidence = path.join(contextWorkspace, "ordinary-evidence.txt");
  mkdirSync(contextWorkspace);
  writeFileSync(ordinaryEvidence, "authorized ordinary evidence", "utf8");
  const { pi } = installHost(ownerWorkspace, passingResponder(contractFixture()));
  await startAndInitialize(pi, "/skill:solar-interview --plan-only Clarify one local result.");
  for (let index = 1; index <= 6; index += 1) {
    assert.equal(await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: `owner-active-budget-${index}`,
      toolName: "read",
      input: { path: ordinaryEvidence },
    }), undefined);
  }
  await pi.command("solar-workflow", "stop");
  const stopped = pi.workflow();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.cwd, realpathSync(ownerWorkspace));

  const mismatchContext = {
    ...pi.ctx,
    cwd: contextWorkspace,
    sessionManager: {
      ...pi.ctx.sessionManager,
      getBranch: () => pi.entries,
    },
  };
  for (let index = 1; index <= 2; index += 1) {
    assert.equal(await pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: `stopped-mismatch-read-${index}`,
      toolName: "read",
      input: { path: ordinaryEvidence },
    }, mismatchContext), undefined);
    assert.equal(readFileSync(ordinaryEvidence, "utf8"), "authorized ordinary evidence");
  }
  assert.equal(pi.workflow().status, "stopped");
  assert.equal(pi.workflow().cwd, stopped.cwd);
  assert.equal(pi.workflow().workspaceId, stopped.workspaceId);

  const { pi: restored } = installHost(contextWorkspace, passingResponder(contractFixture()));
  restored.entries.push(...structuredClone(pi.entries));
  await restored.emit("session_start", { type: "session_start", reason: "reload" });
  assert.equal(restored.workflow().status, "stopped");
  assert.equal(restored.workflow().cwd, stopped.cwd);
  assert.equal(restored.workflow().workspaceId, stopped.workspaceId);
  assert.ok(restored.activeTools.includes("write"), "A fresh mismatched restore must retain dormant ordinary host tools");
  assert.ok(!restored.activeTools.some(name => name.startsWith("solar_")), "A fresh mismatched restore must not revive foreign workflow authority");
  for (let index = 1; index <= 7; index += 1) {
    assert.equal(await restored.emit("tool_call", {
      type: "tool_call",
      toolCallId: `fresh-stopped-mismatch-read-${index}`,
      toolName: "read",
      input: { path: ordinaryEvidence },
    }), undefined);
  }
  assert.equal(readFileSync(ordinaryEvidence, "utf8"), "authorized ordinary evidence");
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
  assert.ok(research.systemPrompt.startsWith("base\n<solar-workflow-main-instructions-v1>\nActive Solar main-session stage: research\n"));
  assert.ok(research.systemPrompt.includes(renderHarnessRolePrompt("researcher")));
  assert.ok(research.systemPrompt.endsWith("</solar-workflow-main-instructions-v1>"));
  assert.ok(!research.systemPrompt.includes(renderHarnessRolePrompt("executor")));
  await pi.command("solar-workflow", "stop");
  assert.equal(await pi.emit("before_agent_start", event), undefined);
  await pi.startInput("/skill:solar-interview Clarify the local output. --plan-only");
  const interview = await pi.emit("before_agent_start", event);
  assert.ok(interview.systemPrompt.startsWith("base\n<solar-workflow-main-instructions-v1>\nActive Solar main-session stage: interview\n"));
  assert.ok(interview.systemPrompt.includes(renderHarnessRolePrompt("interviewer")));
  assert.ok(interview.systemPrompt.endsWith("</solar-workflow-main-instructions-v1>"));
  assert.match(interview.systemPrompt, /use the host-provided current answers/);
  assert.match(interview.systemPrompt, /Do not locate or read backing session\/state files/);
  assert.match(interview.systemPrompt, /If authoritative context is missing, state that limitation/);
  assert.match(interview.systemPrompt, /self-contained specification goes directly to solar_interview_round/u);
  assert.match(interview.systemPrompt, /Skill-location and head hints .* grant no backing-file lookup authority/u);
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
  const dispatcher = await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "Continue.", systemPrompt: "base\nStale built-in guidance: use read or bash to inspect files." });
  assert.match(dispatcher.systemPrompt, /planning dispatcher, not the Planner/);
  assert.match(dispatcher.systemPrompt, /active tool names for this dispatcher turn are exactly \["solar_plan_ready","solar_revisit"\]/u);
  assert.match(dispatcher.systemPrompt, /Do not call read, bash, powershell, shell commands, or any file\/discovery tool/u);
  assert.match(dispatcher.systemPrompt, /earlier built-in tool guidance .* is stale for this turn/u);
  const staleBash = await pi.emit("tool_call", { type: "tool_call", toolCallId: "stale-bash", toolName: "bash", input: { command: "ls -la workspace" } });
  assert.equal(staleBash.block, true);
  assert.match(staleBash.reason, /default-denied in the active plan stage/u);
  assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), "defined planning roles");
  assert.deepEqual(roleStats.requests.map(request => request.role), ["planner", "approach_reviewer", "critic"]);
  for (const request of roleStats.requests) {
    assert.equal(request.systemPrompt, renderHarnessRolePrompt(request.role));
    assert.doesNotMatch(request.prompt, /<solar-pro4-reasoning>/);
    if (request.role === "planner") {
      assert.ok(request.prompt.includes(EXECUTION_CONTRACT_ID_PATTERN));
      assert.ok(request.responseSchema);
      assert.doesNotMatch(request.prompt, /ExecutionContractV3 exact JSON shape:/u);
      assert.doesNotMatch(request.prompt, /"planMarkdown"/u);
      assert.match(request.prompt, /object-valued ExecutionContractV3, never a JSON string/u);
      assert.match(request.prompt, /Filenames and paths are prohibited only in record ID and ID-reference fields/u);
      assert.match(request.prompt, /allowed in path fields, exact authorized commands, provenance citations, and descriptive prose/u);
    } else {
      assert.equal(Object.hasOwn(request, "responseSchema"), false);
    }
  }
  assert.equal(pi.workflow().status, "planning_complete");
}));

test("an obsolete Planner envelope is repaired under the unchanged initial schema without invented findings", async () => fixture(async workspace => {
  const contract = contractFixture();
  let plannerCalls = 0;
  const responder = request => {
    if (request.role !== "planner") return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
    plannerCalls += 1;
    return plannerCalls === 1
      ? JSON.stringify({ planMarkdown: planText(contract), resolutions: [] })
      : plannerOutput(contract);
  };
  const { pi, roleStats } = installHost(workspace, responder);
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

  assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), "Planner envelope repair");
  const current = pi.workflow();
  const plannerRequests = roleStats.requests.filter(request => request.role === "planner");
  assert.equal(plannerRequests.length, 2);
  assert.ok(plannerRequests.every(request => request.responseSchema && typeof request.responseSchema === "object"));
  assert.deepEqual(plannerRequests[1].responseSchema, plannerRequests[0].responseSchema);
  assert.equal(Object.hasOwn(plannerRequests[0].responseSchema.properties, "planMarkdown"), false);
  assert.deepEqual(plannerRequests[0].responseSchema.required, ["status", "sections", "contract", "resolutions"]);
  for (const request of plannerRequests) {
    const resolutionsSchema = dereferenceSchema(request.responseSchema, request.responseSchema.properties.resolutions);
    assert.equal(resolutionsSchema.minItems, 0);
    assert.equal(resolutionsSchema.maxItems, 0);
  }
  assert.ok(plannerRequests.every(request => !request.prompt.includes("Current findings:")));
  assert.ok(plannerRequests.every(request => !request.bundle.items.some(item => /:finding:/u.test(item.source))));
  assert.match(plannerRequests[1].prompt, /REPAIR OF/u);
  assert.deepEqual(current.planning.findingResolutions, []);
  assert.equal(current.plan.text, planText(contract));
  assert.equal(readFileSync(current.plan.path, "utf8"), planText(contract));
  assert.equal(current.roleValidationFailures.length, 1);
  const plannerOutputs = pi.entries
    .filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner")
    .map(entry => entry.data.output);
  assert.deepEqual(plannerOutputs, [
    JSON.stringify({ planMarkdown: planText(contract), resolutions: [] }),
    plannerOutput(contract),
  ]);
}));

test("syntactically valid reviewer semantic failures consume a bounded repair before authority commit", async () => fixture(async workspace => {
  const contract = contractFixture();
  const rejectedOutput = "{}";
  let approachCalls = 0;
  let repairedOutput;
  const { pi, roleStats } = installHost(workspace, request => {
    if (request.role === "planner") return plannerOutput(contract);
    if (request.role === "approach_reviewer") {
      approachCalls += 1;
      if (approachCalls === 1) return rejectedOutput;
      const repaired = reviewFixture(contract, request.role, request.planRevision);
      repaired.assessment.analysis = ` ${repaired.assessment.analysis}\n`;
      repairedOutput = JSON.stringify(repaired);
      return repairedOutput;
    }
    return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
  });
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

  assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), "reviewer semantic repair");
  const current = pi.workflow();
  const approachRequests = roleStats.requests.filter(request => request.role === "approach_reviewer");
  const approachAttempts = current.roleAttempts.filter(attempt => attempt.role === "approach_reviewer");
  assert.deepEqual(roleStats.requests.map(request => request.role), ["planner", "approach_reviewer", "approach_reviewer", "critic"]);
  assert.equal(approachRequests.length, 2);
  assert.equal(approachRequests[1].repairOf, approachAttempts[0].attemptId);
  assert.ok(approachRequests[1].prompt.startsWith(`${approachRequests[0].prompt}\n\nREPAIR OF ${approachAttempts[0].attemptId}:`));
  assert.ok(approachRequests[1].prompt.endsWith(`${rejectedOutput}\n[END REPAIR CONTEXT]`));
  assert.ok(Buffer.byteLength(approachRequests[1].prompt, "utf8") <= 64 * 1024);
  assert.equal(current.roleValidationFailures.length, 1);
  assert.equal(current.roleValidationFailures[0].role, "approach_reviewer");
  assert.match(current.roleValidationFailures[0].error, /PlanReview|Approach Reviewer|approach_reviewer/u);
  const normalizedReview = JSON.parse(repairedOutput);
  normalizedReview.assessment.analysis = normalizedReview.assessment.analysis.trim();
  assert.deepEqual(current.planning.reviews.approach_reviewer, normalizedReview);
  assert.deepEqual(
    pi.entries
      .filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "approach_reviewer")
      .map(entry => entry.data.output),
    [rejectedOutput, repairedOutput],
  );
  assert.deepEqual({ roleCalls: current.budgets.roleCalls, roleRepairs: current.budgets.roleRepairs }, { roleCalls: 4, roleRepairs: 1 });
}));

test("a duplicate finding across reviewers is rejected inside the Critic repair boundary", async () => fixture(async workspace => {
  const contract = contractFixture();
  const duplicateFinding = {
    id: "SHARED-FINDING",
    severity: "advisory",
    summary: "Keep the qualitative boundary explicit.",
    requiredChange: "Retain the exact current-byte acceptance wording.",
    planLocations: ["## Acceptance criteria"],
  };
  let criticCalls = 0;
  let rejectedOutput;
  let repairedOutput;
  const { pi, roleStats } = installHost(workspace, request => {
    if (request.role === "planner") return plannerOutput(contract);
    if (request.role === "approach_reviewer") {
      return JSON.stringify(reviewFixture(contract, request.role, request.planRevision, { findings: [duplicateFinding] }));
    }
    criticCalls += 1;
    if (criticCalls === 1) {
      rejectedOutput = JSON.stringify(reviewFixture(contract, request.role, request.planRevision, { findings: [duplicateFinding] }));
      return rejectedOutput;
    }
    repairedOutput = JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
    return repairedOutput;
  });
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

  assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), "cross-review finding repair");
  const current = pi.workflow();
  const criticRequests = roleStats.requests.filter(request => request.role === "critic");
  const criticAttempts = current.roleAttempts.filter(attempt => attempt.role === "critic");
  assert.deepEqual(roleStats.requests.map(request => request.role), ["planner", "approach_reviewer", "critic", "critic"]);
  assert.equal(criticRequests[1].repairOf, criticAttempts[0].attemptId);
  assert.ok(criticRequests[1].prompt.endsWith(`${rejectedOutput}\n[END REPAIR CONTEXT]`));
  assert.ok(Buffer.byteLength(criticRequests[1].prompt, "utf8") <= 64 * 1024);
  assert.equal(current.roleValidationFailures.length, 1);
  assert.equal(current.roleValidationFailures[0].role, "critic");
  assert.match(current.roleValidationFailures[0].error, /Finding IDs must be unique across both current reviewers/u);
  assert.deepEqual(current.planning.reviews.critic, JSON.parse(repairedOutput));
  assert.deepEqual(current.planning.reviewFindings.map(finding => ({ id: finding.id, role: finding.role })), [{ id: "SHARED-FINDING", role: "approach_reviewer" }]);
  assert.deepEqual(
    pi.entries
      .filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "critic")
      .map(entry => entry.data.output),
    [rejectedOutput, repairedOutput],
  );
  assert.deepEqual({ roleCalls: current.budgets.roleCalls, roleRepairs: current.budgets.roleRepairs }, { roleCalls: 4, roleRepairs: 1 });
}));

test("trailing whitespace in rejected native JSON remains verbatim without invalidating the repair request", async () => fixture(async workspace => {
  const contract = contractFixture();
  const rejectedOutput = `${plannerOutput(contract).slice(0, -2)} \n\t\n  `;
  assert.throws(() => JSON.parse(rejectedOutput));
  let plannerCalls = 0;
  const { pi, roleStats } = installHost(workspace, request => {
    if (request.role !== "planner") return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
    plannerCalls += 1;
    return plannerCalls === 1 ? rejectedOutput : plannerOutput(contract);
  });
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");
  assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), "whitespace-preserving native JSON repair");
  const requests = roleStats.requests.filter(request => request.role === "planner");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].prompt, requests[1].prompt.trim());
  assert.ok(requests[1].prompt.endsWith(`${rejectedOutput}\n[END REPAIR CONTEXT]`));
  assert.deepEqual(requests[1].responseSchema, requests[0].responseSchema);
  const outputs = pi.entries.filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner");
  assert.equal(outputs[0].data.output, rejectedOutput);
  assert.equal(pi.workflow().roleValidationFailures.length, 1);
  assert.equal(pi.workflow().status, "planning_complete");
}));

test("a timed-out repair retains the latest rejected semantic candidate while repairOf advances", { timeout: 15_000 }, async () => fixture(async workspace => {
  const contract = contractFixture();
  const rejectedOutput = JSON.stringify({ planMarkdown: planText(contract), resolutions: [] });
  const clock = new FakeClock();
  const hanging = deferred();
  let plannerCalls = 0;
  const { pi, roleStats } = installHost(workspace, request => {
    if (request.role !== "planner") return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
    plannerCalls += 1;
    if (plannerCalls === 1) return rejectedOutput;
    if (plannerCalls === 2) return hanging.promise;
    return plannerOutput(contract);
  }, { roleClock: clock });
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

  const planning = pi.callTool("solar_plan_ready", {});
  await flushUntil(() => plannerCalls === 2, "Timed-out Planner repair prompt did not start");
  clock.tick(180_000);
  await flushUntil(() => plannerCalls === 3, "Planner retry prompt after timeout did not start");
  assertToolSucceeded(await planning, "semantic evidence retention");
  const current = pi.workflow();
  const plannerRequests = roleStats.requests.filter(request => request.role === "planner");
  const plannerAttempts = current.roleAttempts.filter(attempt => attempt.role === "planner");
  const attemptFor = request => plannerAttempts.find(attempt => attempt.contextId === request.contextId);
  assert.equal(plannerRequests.length, 3);
  assert.equal(plannerAttempts.length, 3);
  assert.equal(plannerRequests[0].repairOf, undefined);
  assert.equal(plannerRequests[1].repairOf, attemptFor(plannerRequests[0]).attemptId);
  assert.equal(plannerRequests[2].repairOf, attemptFor(plannerRequests[1]).attemptId);
  assert.deepEqual(plannerAttempts.map(attempt => attempt.status), ["succeeded", "timed_out", "succeeded"]);
  assert.equal(plannerAttempts[1].terminalReason, "deadline");
  assert.equal(current.roleValidationFailures.length, 2);
  assert.match(current.roleValidationFailures[1].error, /reached its 180000 ms creation-and-prompt deadline/u);
  assert.match(plannerRequests[2].prompt, new RegExp(`REPAIR OF ${attemptFor(plannerRequests[1]).attemptId}:`, "u"));
  assert.match(plannerRequests[2].prompt, new RegExp(`Latest completed rejected visible candidate: ${attemptFor(plannerRequests[0]).attemptId}`, "u"));
  assert.ok(plannerRequests[2].prompt.includes(current.roleValidationFailures[0].error));
  assert.ok(plannerRequests[2].prompt.includes(current.roleValidationFailures[1].error));
  assert.ok(rejectedOutput.length < 16_000);
  assert.ok(plannerRequests[1].prompt.endsWith(`${rejectedOutput}\n[END REPAIR CONTEXT]`));
  assert.ok(plannerRequests[2].prompt.endsWith(`${rejectedOutput}\n[END REPAIR CONTEXT]`));
  assert.deepEqual(plannerRequests[1].bundle, plannerRequests[0].bundle);
  assert.deepEqual(plannerRequests[2].bundle, plannerRequests[0].bundle);
  assert.deepEqual(plannerRequests[1].responseSchema, plannerRequests[0].responseSchema);
  assert.deepEqual(plannerRequests[2].responseSchema, plannerRequests[0].responseSchema);
  const inventorySnapshots = plannerRequests.map(request => request.bundle.items.find(item => item.source.endsWith(":environment:pi-tool-inventory")).content);
  assert.equal(new Set(inventorySnapshots).size, 1);
  assert.deepEqual({ roleCalls: current.budgets.roleCalls, roleRepairs: current.budgets.roleRepairs }, { roleCalls: 5, roleRepairs: 2 });
  const plannerOutputs = pi.entries.filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner");
  assert.deepEqual(plannerOutputs.map(entry => entry.data.output), [rejectedOutput, plannerOutput(contract)]);
  assert.ok(plannerOutputs.every(entry => entry.data.outputRevision === sha256(entry.data.output)));
  assert.equal(roleStats.sessions[1].aborts, 1);
  assert.equal(roleStats.sessions[1].disposals, 1);
}));

test("timeout-only repairs advance attempt identity without manufacturing candidate output", { timeout: 15_000 }, async () => fixture(async workspace => {
  const contract = contractFixture();
  const clock = new FakeClock();
  const hanging = deferred();
  let plannerCalls = 0;
  const { pi, roleStats } = installHost(workspace, request => {
    if (request.role !== "planner") return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
    plannerCalls += 1;
    return plannerCalls <= 2 ? hanging.promise : plannerOutput(contract);
  }, { roleClock: clock });
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

  const planning = pi.callTool("solar_plan_ready", {});
  await flushUntil(() => plannerCalls === 1, "First Planner timeout prompt did not start");
  clock.tick(180_000);
  await flushUntil(() => plannerCalls === 2, "Second Planner timeout prompt did not start");
  clock.tick(180_000);
  await flushUntil(() => plannerCalls === 3, "Budgeted Planner retry prompt did not start");
  assertToolSucceeded(await planning, "timeout-only repair");

  const current = pi.workflow();
  const plannerRequests = roleStats.requests.filter(request => request.role === "planner");
  const plannerAttempts = current.roleAttempts.filter(attempt => attempt.role === "planner");
  const attemptFor = request => plannerAttempts.find(attempt => attempt.contextId === request.contextId);
  assert.deepEqual(plannerAttempts.map(attempt => attempt.status), ["timed_out", "timed_out", "succeeded"]);
  assert.deepEqual(plannerAttempts.slice(0, 2).map(attempt => attempt.terminalReason), ["deadline", "deadline"]);
  assert.equal(plannerRequests[1].repairOf, attemptFor(plannerRequests[0]).attemptId);
  assert.equal(plannerRequests[2].repairOf, attemptFor(plannerRequests[1]).attemptId);
  for (const request of plannerRequests.slice(1)) {
    assert.match(request.prompt, /No completed rejected visible candidate is available/u);
    assert.match(request.prompt, /no output was manufactured for repair context/u);
    assert.doesNotMatch(request.prompt, /Prior visible output \(untrusted\):/u);
  }
  assert.equal(current.roleValidationFailures.length, 2);
  assert.ok(current.roleValidationFailures.every(failure => /reached its 180000 ms creation-and-prompt deadline/u.test(failure.error)));
  assert.deepEqual({ roleCalls: current.budgets.roleCalls, roleRepairs: current.budgets.roleRepairs }, { roleCalls: 5, roleRepairs: 2 });
  const plannerOutputs = pi.entries.filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner");
  assert.deepEqual(plannerOutputs.map(entry => entry.data.output), [plannerOutput(contract)]);
  assert.equal(roleStats.sessions[0].aborts, 1);
  assert.equal(roleStats.sessions[0].disposals, 1);
  assert.equal(roleStats.sessions[1].aborts, 1);
  assert.equal(roleStats.sessions[1].disposals, 1);
}));

test("cancellation after a semantic rejection does not consume or dispatch another repair", { timeout: 15_000 }, async () => fixture(async workspace => {
  const contract = contractFixture();
  const rejectedOutput = JSON.stringify({ planMarkdown: planText(contract), resolutions: [] });
  const hanging = deferred();
  let plannerCalls = 0;
  const { pi, roleStats } = installHost(workspace, request => {
    if (request.role !== "planner") return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
    plannerCalls += 1;
    return plannerCalls === 1 ? rejectedOutput : hanging.promise;
  });
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

  const controller = new AbortController();
  const planning = pi.callTool("solar_plan_ready", {}, controller.signal);
  await flushUntil(() => plannerCalls === 2, "Planner repair prompt did not start before cancellation");
  controller.abort();
  const result = await planning;
  assert.equal(result.details.workflowValidationError, true);

  const current = pi.workflow();
  const plannerRequests = roleStats.requests.filter(request => request.role === "planner");
  const plannerAttempts = current.roleAttempts.filter(attempt => attempt.role === "planner");
  assert.equal(current.status, "paused");
  assert.equal(plannerRequests.length, 2);
  assert.deepEqual(plannerAttempts.map(attempt => attempt.status), ["succeeded", "cancelled"]);
  assert.equal(plannerAttempts[1].terminalReason, "request_cancelled");
  assert.equal(plannerRequests[1].repairOf, plannerAttempts[0].attemptId);
  assert.equal(current.roleValidationFailures.length, 1);
  assert.deepEqual({ roleCalls: current.budgets.roleCalls, roleRepairs: current.budgets.roleRepairs }, { roleCalls: 2, roleRepairs: 1 });
  const plannerOutputs = pi.entries.filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner");
  assert.deepEqual(plannerOutputs.map(entry => entry.data.output), [rejectedOutput]);
  assert.equal(plannerOutputs[0].data.outputRevision, sha256(rejectedOutput));
  assert.equal(roleStats.sessions[1].aborts, 1);
  assert.equal(roleStats.sessions[1].disposals, 1);
}));

for (const diagnosticCase of [
  { label: "ASCII", unit: "x" },
  { label: "multibyte", unit: "界" },
]) {
  test(`oversized ${diagnosticCase.label} validation diagnostics remain recorded while a byte-bounded repair succeeds`, async () => fixture(async workspace => {
    const contract = contractFixture();
    const unsupportedKey = `${diagnosticCase.label}-ERROR-BEGIN-${diagnosticCase.unit.repeat(36_000)}-${diagnosticCase.label}-ERROR-END`;
    const rejectedOutput = JSON.stringify({
      status: "ready",
      sections: plannerSections(),
      contract,
      resolutions: [],
      [unsupportedKey]: true,
    });
    const completeError = `Planner output contains unsupported fields: ${unsupportedKey}.`;
    assert.ok(Buffer.byteLength(completeError, "utf8") > 8 * 1024);
    assert.ok(Buffer.byteLength(rejectedOutput, "utf8") < 256 * 1024);
    let plannerCalls = 0;
    const { pi, roleStats } = installHost(workspace, request => {
      if (request.role !== "planner") return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
      plannerCalls += 1;
      return plannerCalls === 1 ? rejectedOutput : plannerOutput(contract);
    });
    await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

    assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), `${diagnosticCase.label} diagnostic repair`);
    const current = pi.workflow();
    const plannerRequests = roleStats.requests.filter(request => request.role === "planner");
    const plannerAttempts = current.roleAttempts.filter(attempt => attempt.role === "planner");
    const repairRequest = plannerRequests[1];
    assert.equal(plannerRequests.length, 2);
    assert.equal(repairRequest.repairOf, plannerAttempts[0].attemptId);
    assert.equal(repairRequest.prompt.slice(0, plannerRequests[0].prompt.length), plannerRequests[0].prompt);
    assert.ok(repairRequest.prompt.startsWith(`${plannerRequests[0].prompt}\n\nREPAIR OF ${plannerAttempts[0].attemptId}: `));
    assert.ok(repairRequest.prompt.endsWith("\n[END REPAIR CONTEXT]"));
    assert.ok(Buffer.byteLength(repairRequest.prompt, "utf8") <= 64 * 1024);

    const latestErrorStart = repairRequest.prompt.indexOf(`REPAIR OF ${plannerAttempts[0].attemptId}: `) + `REPAIR OF ${plannerAttempts[0].attemptId}: `.length;
    const latestErrorEnd = repairRequest.prompt.indexOf("\nReturn a complete corrected response, not a patch.", latestErrorStart);
    const retainedErrorMarker = "Retained semantic validation error for that candidate: ";
    const retainedErrorStart = repairRequest.prompt.indexOf(retainedErrorMarker) + retainedErrorMarker.length;
    const retainedErrorEnd = repairRequest.prompt.indexOf("\nPrior visible output (untrusted):", retainedErrorStart);
    const latestErrorPresentation = repairRequest.prompt.slice(latestErrorStart, latestErrorEnd);
    const retainedErrorPresentation = repairRequest.prompt.slice(retainedErrorStart, retainedErrorEnd);
    for (const presentation of [latestErrorPresentation, retainedErrorPresentation]) {
      assert.ok(Buffer.byteLength(presentation, "utf8") <= 8 * 1024);
      assert.match(presentation, /^\[UNTRUSTED VALIDATION ERROR VERBATIM EXCERPT:/u);
      assert.match(presentation, /omitted \d+\./u);
      assert.match(presentation, /\[OMITTED \d+ SOURCE CHARACTERS/u);
      assert.match(presentation, /\[END UNTRUSTED VALIDATION ERROR VERBATIM EXCERPT\]$/u);
    }
    assert.equal(repairRequest.prompt.includes(completeError), false);

    const outputMarker = "Prior visible output (untrusted):\n";
    const outputStart = repairRequest.prompt.indexOf(outputMarker) + outputMarker.length;
    const outputExcerpt = repairRequest.prompt.slice(outputStart, -"\n[END REPAIR CONTEXT]".length);
    assert.ok(outputExcerpt.length <= 16_000);
    assert.match(outputExcerpt, /^\[UNTRUSTED JSON VERBATIM EXCERPT:/u);
    assert.match(outputExcerpt, /omitted \d+\./u);
    assert.ok(outputExcerpt.includes(`${diagnosticCase.label}-ERROR-END`));

    assert.equal(current.roleValidationFailures.length, 1);
    assert.equal(current.roleValidationFailures[0].error, completeError);
    assert.deepEqual(
      pi.entries
        .filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner")
        .map(entry => entry.data.output),
      [rejectedOutput, plannerOutput(contract)],
    );
    assert.equal(current.status, "planning_complete");
  }));
}

test("oversized repair context is marked, bounded, and retains verbatim contract tail evidence", async () => fixture(async workspace => {
  const contract = contractFixture();
  const rejectedContract = structuredClone(contract);
  rejectedContract.capabilities = [{
    id: "C1",
    kind: "command",
    tool: "command",
    paths: ["result.txt"],
    commands: ["node checker.mjs"],
  }];
  rejectedContract.steps[0].feasibility = "The unavailable capability kind was incorrectly treated as an installed tool.";
  rejectedContract.steps[0].actions = ["Run only the exact declared checker command."];
  rejectedContract.selfCheck.artifactCoverage[0].explanation = "TAIL-COVERAGE-SENTINEL binds the sole producer and descriptor gate.";
  const oversizedSections = plannerSections();
  oversizedSections.goalAndScope = `Create only the bounded result. ${"bounded scope ".repeat(800)}`;
  oversizedSections.designReview = `Keep the design within the exact declared capability. ${"review ".repeat(1_500)}`;
  const oversizedOutput = plannerOutput(rejectedContract, oversizedSections);
  assert.ok(oversizedOutput.length > 16_000);
  let plannerCalls = 0;
  const { pi, roleStats } = installHost(workspace, request => {
    if (request.role !== "planner") return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
    plannerCalls += 1;
    return plannerCalls === 1 ? oversizedOutput : plannerOutput(contract);
  });
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

  assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), "bounded oversized repair context");
  const repairRequest = roleStats.requests.filter(request => request.role === "planner")[1];
  const marker = "Prior visible output (untrusted):\n";
  const markerOffset = repairRequest.prompt.indexOf(marker);
  assert.notEqual(markerOffset, -1);
  assert.ok(repairRequest.prompt.endsWith("\n[END REPAIR CONTEXT]"));
  const excerpt = repairRequest.prompt.slice(markerOffset + marker.length, -"\n[END REPAIR CONTEXT]".length);
  assert.ok(excerpt.length <= 16_000, `Repair excerpt exceeded its 16000-character envelope: ${excerpt.length}`);
  assert.match(excerpt, /^\[UNTRUSTED JSON VERBATIM EXCERPT:/u);
  assert.match(excerpt, /omitted \d+\./u);
  assert.match(excerpt, /\[OMITTED \d+ SOURCE CHARACTERS/u);
  assert.match(excerpt, /\[END UNTRUSTED JSON VERBATIM EXCERPT\]$/u);
  assert.ok(excerpt.includes('"contract":'));
  assert.ok(excerpt.includes('"requirementCoverage"'));
  assert.ok(excerpt.includes('"artifactCoverage"'));
  assert.ok(excerpt.includes("TAIL-COVERAGE-SENTINEL"));
  assert.ok(excerpt.includes('"resolutions":[]'));
  assert.equal(excerpt.includes(oversizedSections.goalAndScope), false);

  const plannerOutputs = pi.entries.filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner");
  assert.deepEqual(plannerOutputs.map(entry => entry.data.output), [oversizedOutput, plannerOutput(contract)]);
  assert.equal(plannerOutputs[0].data.outputBytes, Buffer.byteLength(oversizedOutput, "utf8"));
  assert.equal(plannerOutputs[0].data.outputRevision, sha256(oversizedOutput));
}));

test("oversized malformed JSON remains labeled untrusted verbatim text with no fabricated candidate", async () => fixture(async workspace => {
  const contract = contractFixture();
  const malformedOutput = `{"status":"ready","sections":{"goalAndScope":"${"x".repeat(20_000)}MALFORMED-TAIL-SENTINEL`;
  let plannerCalls = 0;
  const { pi, roleStats } = installHost(workspace, request => {
    if (request.role !== "planner") return JSON.stringify(reviewFixture(contract, request.role, request.planRevision));
    plannerCalls += 1;
    return plannerCalls === 1 ? malformedOutput : plannerOutput(contract);
  });
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Create a reviewed local result.");

  assertToolSucceeded(await pi.callTool("solar_plan_ready", {}), "malformed oversized repair context");
  const repairRequest = roleStats.requests.filter(request => request.role === "planner")[1];
  const marker = "Prior visible output (untrusted):\n";
  const markerOffset = repairRequest.prompt.indexOf(marker);
  assert.notEqual(markerOffset, -1);
  assert.ok(repairRequest.prompt.endsWith("\n[END REPAIR CONTEXT]"));
  const excerpt = repairRequest.prompt.slice(markerOffset + marker.length, -"\n[END REPAIR CONTEXT]".length);
  assert.ok(excerpt.length <= 16_000);
  assert.match(excerpt, /^\[UNTRUSTED MALFORMED JSON VERBATIM EXCERPT:/u);
  assert.match(excerpt, /\[OMITTED \d+ SOURCE CHARACTERS/u);
  assert.match(excerpt, /MALFORMED-TAIL-SENTINEL/u);
  assert.match(excerpt, /\[END UNTRUSTED MALFORMED JSON VERBATIM EXCERPT\]$/u);
  assert.doesNotMatch(excerpt, /"contract":/u);

  const plannerOutputs = pi.entries.filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner");
  assert.deepEqual(plannerOutputs.map(entry => entry.data.output), [malformedOutput, plannerOutput(contract)]);
  assert.equal(plannerOutputs[0].data.outputRevision, sha256(malformedOutput));
}));

test("a syntactically valid plan with a nonexistent capability tool is refused before persistence or review", async () => fixture(async workspace => {
  const contract = contractFixture();
  contract.capabilities = [{
    id: "C1",
    kind: "command",
    tool: "command",
    paths: ["result.txt"],
    commands: ["node checker.mjs"],
  }];
  contract.steps[0].feasibility = "The capability kind was incorrectly repeated as though it were an installed Pi tool name.";
  contract.steps[0].actions = ["Run only the exact declared checker command."];
  const invalidSections = plannerSections();
  invalidSections.designReview = "One bounded artifact and declared command capability are sufficient.";
  const { pi, roleStats } = installHost(workspace, passingResponder(contract, invalidSections));
  await startAndInitialize(pi, "/skill:solar-plan --plan-only Run only node checker.mjs for result.txt; add no command or path grant.");
  const workflowId = pi.workflow().id;

  const result = await pi.callTool("solar_plan_ready", {});
  assert.equal(result.details.workflowValidationError, true);
  const current = pi.workflow();
  assert.equal(current.status, "paused");
  assert.equal(current.plan, undefined);
  assert.equal(current.approval, undefined);
  assert.equal(existsSync(path.join(workspace, ".solar-workflow", workflowId, "plan.md")), false);
  assert.deepEqual(roleStats.requests.map(request => request.role), ["planner", "planner", "planner", "planner"]);
  assert.equal(current.roleValidationFailures.length, 3);
  assert.ok(current.roleValidationFailures.every(failure => /Planner candidate: .*unavailable Pi capability tool name "command"/u.test(failure.error)));
  const rawOutputs = pi.entries.filter(entry => entry.customType === "solar-role-visible-output-v1");
  assert.equal(rawOutputs.length, 4, "Every rejected visible Planner output remains preserved");
  assert.ok(rawOutputs.every(entry => {
    const payload = JSON.parse(entry.data.output);
    return !Object.hasOwn(payload, "planMarkdown")
      && payload.status === "ready"
      && payload.sections.designReview === invalidSections.designReview
      && JSON.stringify(payload.contract) === JSON.stringify(contract);
  }));
}));

test("receipt-bound host tool evidence accepts an exact configured name and rechecks it without widening grants", async () => fixture(async workspace => {
  const contract = contractFixture();
  const exactCapability = {
    id: "C1",
    kind: "command",
    tool: "powershell",
    paths: ["result.txt"],
    commands: ["node checker.mjs"],
  };
  contract.capabilities = [exactCapability];
  contract.steps[0].feasibility = "The configured Pi powershell tool can run the one exact user-scoped checker command.";
  contract.steps[0].actions = ["Run only node checker.mjs against result.txt."];
  const sections = plannerSections();
  sections.designReview = "One bounded artifact and exact declared powershell capability are sufficient.";
  const { pi, roleStats } = installHost(workspace, passingResponder(contract, sections));
  await startAndInitialize(pi, "/skill:solar-plan Create result.txt using only node checker.mjs; grant no other command or path.");

  const planned = await pi.callTool("solar_plan_ready", {});
  assertToolSucceeded(planned, "configured capability planning");
  let current = pi.workflow();
  assert.equal(current.status, "awaiting_gate_review");
  assert.deepEqual(current.plan.contract.capabilities, [exactCapability]);
  for (const request of roleStats.requests) {
    const item = request.bundle.items.find(candidate => candidate.source.endsWith(":environment:pi-tool-inventory"));
    assert.ok(item, `${request.role} omitted host tool environment evidence`);
    assert.equal(item.kind, "finding");
    assert.equal(item.sha256, sha256(item.content));
    assert.match(item.limitation, /observation only.*grants no tool, path, or command authority/iu);
    const inventory = JSON.parse(item.content);
    assert.equal(inventory.sourceApi, "ExtensionAPI.getAllTools");
    assert.equal(inventory.authority, "environment_evidence_only");
    assert.ok(inventory.configuredToolNames.includes("powershell"));
    assert.ok(inventory.configuredToolNames.includes("solar_plan_ready"));
    assert.ok(inventory.capabilityToolNames.includes("powershell"));
    assert.ok(!inventory.capabilityToolNames.includes("solar_plan_ready"));
    assert.ok(!inventory.capabilityToolNames.includes("command"));
    assert.match(request.prompt, /inventory is environment evidence only, never authorization/u);
    assert.equal(request.inputRevision, request.bundle.bundleRevision);
    const commit = current.roleCommits.find(candidate => candidate.contextId === request.contextId);
    assert.equal(commit.receipt.bundleRevision, request.bundle.bundleRevision);
  }

  pi.unavailableTools.add("powershell");
  await pi.command("solar-workflow", `approve ${current.revision.slice(0, 12)}`);
  current = pi.workflow();
  assert.equal(current.status, "awaiting_gate_review");
  assert.equal(current.approval, undefined);
  assert.match(pi.notifications.at(-1).message, /Execution approval: .*unavailable Pi capability tool name "powershell"/u);

  pi.unavailableTools.delete("powershell");
  await pi.command("solar-workflow", `approve ${current.revision.slice(0, 12)}`);
  current = pi.workflow();
  assert.equal(current.stage, "execute");
  assert.equal(current.status, "active");
  assert.deepEqual(current.plan.contract.capabilities, [exactCapability]);
  assert.deepEqual(pi.activeTools.sort(), ["powershell", "solar_step_done", "solar_revisit"].sort());
  assert.ok(!pi.activeTools.includes("bash"));
  assert.ok(!pi.activeTools.includes("read"));
  assert.ok(!pi.activeTools.includes("write"));
  const widened = await pi.emit("tool_call", {
    type: "tool_call",
    toolCallId: "widened-checker-command",
    toolName: "powershell",
    input: { command: "node checker.mjs --extra" },
  });
  assert.equal(widened.block, true);
  assert.match(widened.reason, /does not declare this exact tool\/path\/command capability/u);
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
  const expectedPlan = planText(contract);
  const expectedPlannerOutput = plannerOutput(contract);
  const plannerOutputEntry = visibleOutputs.find(entry => entry.role === "planner");
  assert.equal(final.plan.text, expectedPlan);
  assert.equal(readFileSync(final.plan.path, "utf8"), expectedPlan);
  assert.equal(final.revision, sha256(expectedPlan));
  assert.equal(final.plan.revision, sha256(expectedPlan));
  assert.equal(plannerOutputEntry.output, expectedPlannerOutput);
  assert.equal(plannerOutputEntry.receipt.outputRevision, sha256(expectedPlannerOutput));
  assert.equal(final.planning.plannerOutputRevision, sha256(expectedPlannerOutput));
  assert.notEqual(final.revision, plannerOutputEntry.receipt.outputRevision, "Rendered artifact bytes and raw Planner wire bytes have distinct bound revisions");
  for (const request of roleStats.requests.filter(request => request.role !== "planner")) {
    const planItem = request.bundle.items.find(item => item.kind === "plan");
    assert.ok(planItem, `${request.role} did not receive the persisted plan`);
    assert.equal(planItem.content, expectedPlan);
    assert.equal(planItem.sha256, sha256(expectedPlan));
    assert.equal(request.planRevision, sha256(expectedPlan));
    assert.equal(Object.hasOwn(request, "responseSchema"), false);
  }
  assert.ok(roleStats.sessions.every(session => session.disposals === 1));
  assert.equal(pi.sentUserMessages.some(item => item.message.startsWith("/skill:solar-execute")), false);
}));

test("initial isolated role requests bind the native Planner schema while denied private sources are never selected", async () => fixture(async workspace => {
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

  const plannerSchema = planner.responseSchema;
  assert.ok(plannerSchema && typeof plannerSchema === "object");
  assert.equal(plannerSchema.type, "object");
  assert.equal(plannerSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(plannerSchema.properties), ["status", "sections", "contract", "resolutions"]);
  assert.deepEqual(plannerSchema.required, ["status", "sections", "contract", "resolutions"]);
  assert.deepEqual(dereferenceSchema(plannerSchema, plannerSchema.properties.status).enum, ["ready"]);
  const sectionsSchema = dereferenceSchema(plannerSchema, plannerSchema.properties.sections);
  assert.deepEqual(Object.keys(sectionsSchema.properties), FIXTURE_SECTION_HEADINGS.map(([key]) => key));
  assert.deepEqual(sectionsSchema.required, FIXTURE_SECTION_HEADINGS.map(([key]) => key));
  assert.ok(FIXTURE_SECTION_HEADINGS.every(([key]) => dereferenceSchema(plannerSchema, sectionsSchema.properties[key]).minLength === 1));
  const contractSchema = dereferenceSchema(plannerSchema, plannerSchema.properties.contract);
  assert.equal(contractSchema.type, "object");
  const capabilityRecord = schemaNodes(plannerSchema).find(node =>
    node?.type === "object"
    && node.properties
    && ["id", "kind", "tool", "paths", "commands"].every(field => Object.hasOwn(node.properties, field)));
  assert.ok(capabilityRecord, "Native Planner schema omitted the ExecutionContractV3 capability record");
  const plannerInventory = JSON.parse(planner.bundle.items.find(item => item.source.endsWith(":environment:pi-tool-inventory")).content);
  const schemaToolNames = dereferenceSchema(plannerSchema, capabilityRecord.properties.tool).enum;
  assert.deepEqual(schemaToolNames, ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
  assert.deepEqual(schemaToolNames, plannerInventory.capabilityToolNames);
  const resolutionsSchema = dereferenceSchema(plannerSchema, plannerSchema.properties.resolutions);
  assert.equal(resolutionsSchema.type, "array");
  assert.equal(resolutionsSchema.maxItems, 0);
  assert.ok(schemaNodes(plannerSchema).filter(node => node?.type === "object").every(node => node.additionalProperties === false));
  const serializedSchema = JSON.stringify(plannerSchema);
  for (const field of ["requirements", "artifacts", "acceptance", "capabilities", "paths", "commands", "requires", "dependsOn", "gates", "selfCheck", "requirementCoverage", "artifactCoverage", "unresolved"]) {
    assert.match(serializedSchema, new RegExp(`"${field}"`), `Native Planner schema omitted ExecutionContractV3 field ${field}`);
    assert.doesNotMatch(planner.prompt, new RegExp(`"${field}"`), `Planner prompt duplicated native schema field ${field}`);
  }
  assert.match(planner.prompt, /ExecutionContractV3 exact reference rules:/u);
  assert.match(planner.prompt, /exact root fields status, sections, contract, and resolutions/u);
  assert.doesNotMatch(planner.prompt, /ExecutionContractV3 exact JSON shape:/u);
  assert.equal(Object.hasOwn(approach, "responseSchema"), false);
  assert.equal(Object.hasOwn(critic, "responseSchema"), false);
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
        ? plannerOutput(contract, "Initial risk description needs a concrete recovery boundary.")
        : plannerOutput(contract, "Revision resolves F1 by naming the no-progress pause and retained-evidence recovery boundary.", [{ findingId: "F1", status: "resolved", changedLocations: ["## Risk review and revisions"], explanation: "The revised plan names the bounded recovery and preserved evidence." }]);
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
  const plannerRequests = roleStats.requests.filter(request => request.role === "planner");
  const initialResolutionsSchema = dereferenceSchema(plannerRequests[0].responseSchema, plannerRequests[0].responseSchema.properties.resolutions);
  const revisionResolutionsSchema = dereferenceSchema(plannerRequests[1].responseSchema, plannerRequests[1].responseSchema.properties.resolutions);
  const resolutionRecord = dereferenceSchema(plannerRequests[1].responseSchema, revisionResolutionsSchema.items);
  assert.equal(initialResolutionsSchema.maxItems, 0);
  assert.equal(revisionResolutionsSchema.minItems, 1);
  assert.equal(revisionResolutionsSchema.maxItems, 1);
  const schemaFindingIds = dereferenceSchema(plannerRequests[1].responseSchema, resolutionRecord.properties.findingId).enum;
  const bundledFindingIds = plannerRequests[1].bundle.items
    .filter(item => /:finding:/u.test(item.source))
    .map(item => JSON.parse(item.content).id);
  assert.deepEqual(schemaFindingIds, ["F1"]);
  assert.deepEqual(schemaFindingIds, bundledFindingIds);
  const plannerWires = pi.entries
    .filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner")
    .map(entry => JSON.parse(entry.data.output));
  assert.equal(plannerWires[0].sections.riskReviewAndRevisions, "Initial risk description needs a concrete recovery boundary.");
  assert.equal(plannerWires[1].sections.riskReviewAndRevisions, "Revision resolves F1 by naming the no-progress pause and retained-evidence recovery boundary.");
  assert.notEqual(plannerWires[1].sections.riskReviewAndRevisions, plannerWires[0].sections.riskReviewAndRevisions);
  assert.deepEqual(plannerWires[1].contract, contract);
  for (const request of roleStats.requests.slice(4)) {
    const planItem = request.bundle.items.find(item => item.kind === "plan");
    assert.equal(planItem.content, revisedPlan);
    assert.equal(planItem.sha256, sha256(revisedPlan));
    assert.equal(request.planRevision, sha256(revisedPlan));
    assert.equal(Object.hasOwn(request, "responseSchema"), false);
  }
  assert.equal(readFileSync(current.plan.path, "utf8"), revisedPlan);
  assert.equal(current.planning.findingResolutions[0].toPlanRevision, sha256(revisedPlan));
  assert.equal(approachCalls, 2);
  assert.equal(criticCalls, 2);
  assert.equal(new Set(current.roleCommits.map(commit => commit.contextId)).size, 6);
  assert.ok(current.planning.history.some(item => item.reviewFindings.some(finding => finding.id === "F1")));
  assert.equal(current.approval, undefined);
}));

test("a Critic-origin material finding triggers a full revision and both re-reviews", async () => fixture(async workspace => {
  const contract = contractFixture();
  const firstSections = plannerSections("The initial acceptance discussion lacks an explicit stale-output boundary.");
  const revisedSections = plannerSections("Revision resolves CF1 by binding qualitative acceptance to current final bytes.");
  revisedSections.acceptanceCriteria = "Human qualitative acceptance applies only to the exact current final bytes reviewed after all current gates.";
  const firstPlan = planText(contract, firstSections);
  const revisedPlan = planText(contract, revisedSections);
  let plannerCalls = 0;
  let criticCalls = 0;
  const responder = request => {
    if (request.role === "planner") {
      plannerCalls += 1;
      return plannerCalls === 1
        ? plannerOutput(contract, firstSections)
        : plannerOutput(contract, revisedSections, [{ findingId: "CF1", status: "resolved", changedLocations: ["## Risk review and revisions", "## Acceptance criteria"], explanation: "The full revision now binds acceptance to current final bytes." }]);
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
  const revisionRequest = roleStats.requests.filter(request => request.role === "planner")[1];
  const resolutionsSchema = dereferenceSchema(revisionRequest.responseSchema, revisionRequest.responseSchema.properties.resolutions);
  const resolutionRecord = dereferenceSchema(revisionRequest.responseSchema, resolutionsSchema.items);
  assert.equal(resolutionsSchema.minItems, 1);
  assert.equal(resolutionsSchema.maxItems, 1);
  assert.deepEqual(dereferenceSchema(revisionRequest.responseSchema, resolutionRecord.properties.findingId).enum, ["CF1"]);
  const revisedWire = pi.entries
    .filter(entry => entry.customType === "solar-role-visible-output-v1" && entry.data.role === "planner")
    .map(entry => JSON.parse(entry.data.output))[1];
  assert.equal(revisedWire.sections.riskReviewAndRevisions, "Revision resolves CF1 by binding qualitative acceptance to current final bytes.");
  assert.equal(revisedWire.sections.acceptanceCriteria, revisedSections.acceptanceCriteria);
  assert.notEqual(revisedWire.sections.acceptanceCriteria, firstSections.acceptanceCriteria);
  assert.equal(readFileSync(current.plan.path, "utf8"), revisedPlan);
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
    return plannerOutput(contract);
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

async function reviewedExecution(workspace, { gateKind = "command", gateCount = 1, contract: suppliedContract, exec } = {}) {
  const contract = suppliedContract ?? contractFixture({ gateKind, gateCount });
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

test("native authority coverage and dormant dispatch decisions use exact retained call identities", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await pi.emit("session_start", { type: "session_start", reason: "startup" });
  const coverage = nativeToolAuthorityEntries(pi, "coverage");
  assert.equal(coverage.length, 1);
  assert.equal(pi.entries[0].id, coverage[0].id);
  assert.deepEqual(coverage[0].data, {
    version: 1,
    kind: "coverage",
    scope: "main_session_native_tool_hooks",
    dispatch: "every_call",
    result: "every_execution_allowed_call",
  });

  const ordinary = { type: "tool_call", toolCallId: "dormant-read", toolName: "read", input: { path: "input.txt" } };
  const ordinaryDispatch = await emitRetainedToolCall(pi, ordinary);
  assert.equal(ordinaryDispatch.outcome, undefined);
  const allowed = nativeToolAuthorityEntries(pi, "dispatch").find(entry => entry.data.call.toolCallId === ordinary.toolCallId);
  assert.deepEqual(allowed.data, {
    version: 1,
    kind: "dispatch",
    call: {
      assistantEntryId: ordinaryDispatch.assistantEntryId,
      toolCallId: ordinary.toolCallId,
      toolName: ordinary.toolName,
    },
    stateEntryId: null,
    stepId: null,
    decision: "dispatch_allowed",
    code: null,
  });

  const duplicate = await pi.emit("tool_call", ordinary);
  assert.equal(duplicate.block, true);
  assert.equal(duplicate.terminate, true);
  assert.match(duplicate.reason, /Duplicate tool-call ID/u);

  const mixedEvent = { type: "tool_call", toolCallId: "mixed-control", toolName: "solar_revisit", input: {} };
  const mixed = await emitRetainedToolCall(pi, mixedEvent, [
    { type: "tool_call", toolCallId: "mixed-read", toolName: "read", input: { path: "input.txt" } },
  ]);
  assert.equal(mixed.outcome.block, true);
  assert.equal(mixed.outcome.terminate, true);
  assert.match(mixed.outcome.reason, /must be the only tool call/u);

  const decisions = nativeToolAuthorityEntries(pi, "dispatch").map(entry => ({
    toolCallId: entry.data.call.toolCallId,
    decision: entry.data.decision,
    code: entry.data.code,
  }));
  assert.deepEqual(decisions, [
    { toolCallId: "dormant-read", decision: "dispatch_allowed", code: null },
    { toolCallId: "dormant-read", decision: "blocked", code: "duplicate_call" },
    { toolCallId: "mixed-control", decision: "blocked", code: "mixed_control_batch" },
  ]);
}));

test("an active duplicate call binds its blocked receipt to current persisted state without replacing the original authorization", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace);
  const call = {
    type: "tool_call",
    toolCallId: "active-duplicate-write",
    toolName: "write",
    input: { path: "result.txt", content: "current" },
  };
  const first = await emitRetainedToolCall(pi, call);
  assert.equal(first.outcome, undefined);
  const currentState = [...pi.entries].reverse().find(entry =>
    entry.type === "custom"
    && entry.customType === WORKFLOW_STATE
    && entry.data?.id === pi.workflow().id);
  assert.ok(currentState?.id);

  const duplicate = await pi.emit("tool_call", { ...call, input: { path: "result.txt", content: "must not replace authorization" } });
  assert.equal(duplicate.block, true);
  assert.equal(duplicate.terminate, true);
  assert.match(duplicate.reason, /Duplicate tool-call ID/u);
  const duplicateReceipt = nativeToolAuthorityEntries(pi, "dispatch").find(entry =>
    entry.data.call.toolCallId === call.toolCallId
    && entry.data.decision === "blocked"
    && entry.data.code === "duplicate_call");
  assert.ok(duplicateReceipt);
  assert.equal(duplicateReceipt.data.call.assistantEntryId, first.assistantEntryId);
  assert.equal(duplicateReceipt.data.stateEntryId, currentState.id);
  assert.ok(pi.entries.findIndex(entry => entry.id === currentState.id) < pi.entries.findIndex(entry => entry.id === duplicateReceipt.id));

  const result = await pi.emit("tool_result", {
    type: "tool_result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    content: [{ type: "text", text: "original authorized result" }],
    details: undefined,
    isError: false,
  });
  assert.equal(result, undefined);
  assert.ok(nativeToolAuthorityEntries(pi, "result").some(entry =>
    entry.data.call.assistantEntryId === first.assistantEntryId
    && entry.data.call.toolCallId === call.toolCallId
    && entry.data.decision === "current"));
}));

test("native dispatch block codes observe every existing guard without changing its outcome", async () => fixture(async workspace => {
  const interviewHost = installHost(workspace, passingResponder(contractFixture())).pi;
  await startAndInitialize(interviewHost, "/skill:solar-interview --plan-only Clarify the bounded result.");
  const deniedRead = await emitRetainedToolCall(interviewHost, {
    type: "tool_call",
    toolCallId: "audit-private-read",
    toolName: "read",
    input: { path: ".pi/private-state.json" },
  });
  assert.equal(deniedRead.outcome.block, true);
  assert.equal(deniedRead.outcome.terminate, true);
  assert.match(deniedRead.outcome.reason, /Interview read denied before dispatch/u);
  for (let index = 2; index <= 6; index += 1) {
    const allowed = await emitRetainedToolCall(interviewHost, {
      type: "tool_call",
      toolCallId: `audit-interview-read-${index}`,
      toolName: "read",
      input: { path: `ordinary-${index}.txt` },
    });
    assert.equal(allowed.outcome, undefined);
  }
  const exhausted = await emitRetainedToolCall(interviewHost, {
    type: "tool_call",
    toolCallId: "audit-interview-read-7",
    toolName: "read",
    input: { path: "ordinary-7.txt" },
  });
  assert.equal(exhausted.outcome.block, true);
  assert.equal(exhausted.outcome.terminate, true);
  assert.match(exhausted.outcome.reason, /Interview tool budget reached/u);

  const waitingHost = installHost(workspace, passingResponder(contractFixture())).pi;
  await startAndInitialize(waitingHost, "/skill:solar-plan Create the reviewed bounded plan.");
  assertToolSucceeded(await waitingHost.callTool("solar_plan_ready", {}), "waiting-boundary plan");
  assert.equal(waitingHost.workflow().status, "awaiting_gate_review");
  const waiting = await emitRetainedToolCall(waitingHost, {
    type: "tool_call",
    toolCallId: "audit-waiting-write",
    toolName: "write",
    input: { path: "result.txt", content: "blocked" },
  });
  assert.equal(waiting.outcome.block, true);
  assert.equal(waiting.outcome.terminate, true);
  assert.match(waiting.outcome.reason, /waiting for an explicit human\/recovery boundary/u);

  const executionHost = (await reviewedExecution(workspace)).pi;
  const controlAllowed = await emitRetainedToolCall(executionHost, {
    type: "tool_call",
    toolCallId: "audit-control-allowed",
    toolName: "solar_revisit",
    input: {},
  });
  assert.equal(controlAllowed.outcome, undefined);
  const controlReceipt = nativeToolAuthorityEntries(executionHost, "dispatch").find(entry => entry.data.call.toolCallId === "audit-control-allowed");
  assert.equal(controlReceipt.data.decision, "dispatch_allowed");
  assert.equal(controlReceipt.data.code, null);
  assert.equal(controlReceipt.data.stepId, null);

  const stageDenied = await emitRetainedToolCall(executionHost, {
    type: "tool_call",
    toolCallId: "audit-stage-read",
    toolName: "read",
    input: { path: "result.txt" },
  });
  assert.equal(stageDenied.outcome.block, true);
  assert.equal(stageDenied.outcome.terminate, true);
  assert.match(stageDenied.outcome.reason, /default-denied/u);

  executionHost.ctx.model = GENERIC_MODEL;
  const modelDenied = await emitRetainedToolCall(executionHost, {
    type: "tool_call",
    toolCallId: "audit-model-write",
    toolName: "write",
    input: { path: "result.txt", content: "blocked" },
  });
  assert.equal(modelDenied.outcome.block, true);
  assert.equal(modelDenied.outcome.terminate, true);
  assert.match(modelDenied.outcome.reason, /model\/thinking identity changed/u);
  executionHost.ctx.model = SOLAR_MODEL;

  const guardDenied = await emitRetainedToolCall(executionHost, {
    type: "tool_call",
    toolCallId: "audit-undeclared-write",
    toolName: "write",
    input: { path: "undeclared.txt", content: "blocked" },
  });
  assert.equal(guardDenied.outcome.block, true);
  assert.equal(guardDenied.outcome.terminate, true);
  assert.match(guardDenied.outcome.reason, /does not declare|default-denied/iu);

  const codes = [
    ...nativeToolAuthorityEntries(interviewHost, "dispatch"),
    ...nativeToolAuthorityEntries(waitingHost, "dispatch"),
    ...nativeToolAuthorityEntries(executionHost, "dispatch"),
  ].filter(entry => entry.data.decision === "blocked").map(entry => entry.data.code);
  assert.deepEqual(new Set(codes), new Set([
    "interview_budget",
    "interview_read_denied",
    "waiting_boundary",
    "model_identity",
    "stage_tool_denied",
    "execution_guard_rejected",
  ]));
  for (const host of [interviewHost, waitingHost, executionHost]) {
    for (const receipt of nativeToolAuthorityEntries(host, "dispatch")) {
      assert.equal(typeof receipt.data.stateEntryId, "string");
      const stateIndex = host.entries.findIndex(entry => entry.id === receipt.data.stateEntryId);
      const receiptIndex = host.entries.findIndex(entry => entry.id === receipt.id);
      assert.ok(stateIndex >= 0 && stateIndex < receiptIndex);
      assert.equal(host.entries[stateIndex].customType, WORKFLOW_STATE);
    }
  }
}));

test("execution receipts bind persisted state and original calls across ordinary errors and stale results", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace);
  const ordinaryCall = {
    type: "tool_call",
    toolCallId: "audit-ordinary-error",
    toolName: "write",
    input: { path: "result.txt", content: "attempted" },
  };
  const ordinaryDispatch = await emitRetainedToolCall(pi, ordinaryCall);
  assert.equal(ordinaryDispatch.outcome, undefined);
  const dispatchEntry = nativeToolAuthorityEntries(pi, "dispatch").find(entry => entry.data.call.toolCallId === ordinaryCall.toolCallId);
  assert.equal(dispatchEntry.data.decision, "execution_allowed");
  assert.equal(dispatchEntry.data.code, null);
  assert.equal(dispatchEntry.data.call.assistantEntryId, ordinaryDispatch.assistantEntryId);
  assert.equal(dispatchEntry.data.stepId, "S1");
  const stateIndex = pi.entries.findIndex(entry => entry.id === dispatchEntry.data.stateEntryId);
  const dispatchIndex = pi.entries.findIndex(entry => entry.id === dispatchEntry.id);
  assert.ok(stateIndex >= 0 && stateIndex < dispatchIndex);
  assert.equal(pi.entries[stateIndex].customType, WORKFLOW_STATE);

  pi.entries.push({
    type: "message",
    id: `assistant-${++pi.entrySequence}`,
    message: { role: "assistant", content: [{ type: "text", text: "A later assistant message cannot replace the original call origin." }] },
  });
  const ordinaryError = {
    type: "tool_result",
    toolCallId: ordinaryCall.toolCallId,
    toolName: ordinaryCall.toolName,
    input: ordinaryCall.input,
    content: [{ type: "text", text: "The native write tool reported an ordinary error." }],
    details: { ordinaryToolError: true },
    isError: true,
  };
  const originalError = structuredClone(ordinaryError);
  assert.equal(await pi.emit("tool_result", ordinaryError), undefined);
  assert.deepEqual(ordinaryError, originalError);
  const current = nativeToolAuthorityEntries(pi, "result").find(entry => entry.data.call.toolCallId === ordinaryCall.toolCallId);
  assert.deepEqual(current.data, {
    version: 1,
    kind: "result",
    call: {
      assistantEntryId: ordinaryDispatch.assistantEntryId,
      toolCallId: ordinaryCall.toolCallId,
      toolName: ordinaryCall.toolName,
    },
    decision: "current",
    code: null,
  });

  const duplicate = await pi.emit("tool_result", ordinaryError);
  assert.equal(duplicate.isError, true);
  assert.equal(duplicate.details.staleExecutionResult, true);
  assert.ok(nativeToolAuthorityEntries(pi, "result").some(entry =>
    entry.data.call.toolCallId === ordinaryCall.toolCallId
    && entry.data.decision === "invalidated"
    && entry.data.code === "duplicate_result"));

  const staleCall = {
    type: "tool_call",
    toolCallId: "audit-stale-recheck",
    toolName: "write",
    input: { path: "result.txt", content: "late" },
  };
  assert.equal((await emitRetainedToolCall(pi, staleCall)).outcome, undefined);
  pi.appendEntry(WORKFLOW_STATE, { ...pi.workflow(), status: "stopped", reason: "Injected stale result authority." });
  const stale = await pi.emit("tool_result", {
    type: "tool_result",
    toolCallId: staleCall.toolCallId,
    toolName: staleCall.toolName,
    input: staleCall.input,
    content: [{ type: "text", text: "late native output" }],
    details: undefined,
    isError: false,
  });
  assert.equal(stale.isError, true);
  assert.equal(stale.details.staleExecutionResult, true);
  assert.ok(nativeToolAuthorityEntries(pi, "result").some(entry =>
    entry.data.call.toolCallId === staleCall.toolCallId
    && entry.data.decision === "invalidated"
    && entry.data.code === "authority_recheck_failed"));

  const unknownResult = {
    type: "tool_result",
    toolCallId: "audit-unknown-result",
    toolName: "write",
    input: { path: "result.txt" },
    content: [{ type: "text", text: "unknown native output" }],
    details: undefined,
    isError: false,
  };
  const unknownAssistantEntryId = retainAssistantToolCalls(pi, [unknownResult]);
  const unknown = await pi.emit("tool_result", unknownResult);
  assert.equal(unknown.isError, true);
  assert.equal(unknown.details.staleExecutionResult, true);
  assert.ok(nativeToolAuthorityEntries(pi, "result").some(entry =>
    entry.data.call.assistantEntryId === unknownAssistantEntryId
    && entry.data.call.toolCallId === unknownResult.toolCallId
    && entry.data.decision === "invalidated"
    && entry.data.code === "unknown_authorization"));

  const tombstoneHost = (await reviewedExecution(workspace)).pi;
  const tombstoneCall = {
    type: "tool_call",
    toolCallId: "audit-tombstoned-result",
    toolName: "write",
    input: { path: "result.txt", content: "late" },
  };
  assert.equal((await emitRetainedToolCall(tombstoneHost, tombstoneCall)).outcome, undefined);
  await tombstoneHost.command("solar-workflow", "stop");
  const tombstoned = await tombstoneHost.emit("tool_result", {
    type: "tool_result",
    toolCallId: tombstoneCall.toolCallId,
    toolName: tombstoneCall.toolName,
    input: tombstoneCall.input,
    content: [{ type: "text", text: "late native output" }],
    details: undefined,
    isError: false,
  });
  assert.equal(tombstoned.isError, true);
  assert.equal(tombstoned.details.staleExecutionResult, true);
  assert.ok(nativeToolAuthorityEntries(tombstoneHost, "result").some(entry =>
    entry.data.call.toolCallId === tombstoneCall.toolCallId
    && entry.data.decision === "invalidated"
    && entry.data.code === "authorization_already_invalidated"));
}));

test("execution dispatch and result receipt append failures preserve authorization behavior and shutdown synthesizes no result", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace);
  const appendEntry = pi.appendEntry.bind(pi);
  const nativeEntryCount = nativeToolAuthorityEntries(pi).length;
  let nativeAttempts = 0;
  pi.appendEntry = (customType, data) => {
    if (customType === NATIVE_TOOL_AUTHORITY_ENTRY) {
      nativeAttempts += 1;
      throw new Error("private native append failure");
    }
    return appendEntry(customType, data);
  };

  const completedCall = {
    type: "tool_call",
    toolCallId: "execution-append-failure",
    toolName: "write",
    input: { path: "result.txt", content: "current despite audit failure" },
  };
  assert.equal((await emitRetainedToolCall(pi, completedCall)).outcome, undefined);
  assert.equal(nativeAttempts, 1);
  assert.equal(nativeToolAuthorityEntries(pi).length, nativeEntryCount);
  assert.match(pi.notifications.at(-1).message, /could not persist.*audit coverage is incomplete/iu);
  assert.doesNotMatch(pi.notifications.at(-1).message, /private native append failure/u);

  const completedResult = {
    type: "tool_result",
    toolCallId: completedCall.toolCallId,
    toolName: completedCall.toolName,
    input: completedCall.input,
    content: [{ type: "text", text: "ordinary native result" }],
    details: undefined,
    isError: false,
  };
  assert.equal(await pi.emit("tool_result", completedResult), undefined);
  assert.equal(nativeAttempts, 2);
  assert.equal(nativeToolAuthorityEntries(pi).length, nativeEntryCount);
  const duplicateResult = await pi.emit("tool_result", completedResult);
  assert.equal(duplicateResult.isError, true);
  assert.equal(duplicateResult.details.staleExecutionResult, true);
  assert.equal(nativeAttempts, 3, "A failed result receipt must not prevent the existing consumed tombstone");

  const pendingCall = {
    type: "tool_call",
    toolCallId: "execution-pending-shutdown",
    toolName: "write",
    input: { path: "result.txt", content: "pending" },
  };
  assert.equal((await emitRetainedToolCall(pi, pendingCall)).outcome, undefined);
  assert.equal(nativeAttempts, 4);
  const attemptsBeforeShutdown = nativeAttempts;
  const resultEntriesBeforeShutdown = nativeToolAuthorityEntries(pi, "result").length;
  await pi.emit("session_shutdown", { type: "session_shutdown", reason: "test" });
  assert.equal(nativeAttempts, attemptsBeforeShutdown);
  assert.equal(nativeToolAuthorityEntries(pi, "result").length, resultEntriesBeforeShutdown);
}));

test("ambiguous and wrong-name native origins leave no fabricated dispatch while preserving dormant tool allowance", async () => fixture(async workspace => {
  const { pi } = installHost(workspace, passingResponder(contractFixture()));
  await pi.emit("session_start", { type: "session_start", reason: "startup" });

  const ambiguous = {
    type: "tool_call",
    toolCallId: "ambiguous-origin",
    toolName: "read",
    input: { path: "input.txt" },
  };
  retainAssistantToolCalls(pi, [ambiguous]);
  retainAssistantToolCalls(pi, [ambiguous]);
  assert.equal(await pi.emit("tool_call", ambiguous), undefined);
  assert.equal(nativeToolAuthorityEntries(pi, "dispatch").some(entry => entry.data.call.toolCallId === ambiguous.toolCallId), false);
  assert.match(pi.notifications.at(-1).message, /could not attribute.*exactly one retained assistant entry/iu);

  const wrongName = {
    type: "tool_call",
    toolCallId: "wrong-name-origin",
    toolName: "read",
    input: { path: "input.txt" },
  };
  retainAssistantToolCalls(pi, [{ ...wrongName, toolName: "write" }]);
  assert.equal(await pi.emit("tool_call", wrongName), undefined);
  assert.equal(nativeToolAuthorityEntries(pi, "dispatch").some(entry => entry.data.call.toolCallId === wrongName.toolCallId), false);
  assert.match(pi.notifications.at(-1).message, /could not attribute.*exactly one retained assistant entry/iu);
}));

test("missing native origins, state provenance, and receipt persistence never fabricate decisions or change guards", async () => fixture(async workspace => {
  const missingOriginHost = installHost(workspace, passingResponder(contractFixture())).pi;
  await missingOriginHost.emit("session_start", { type: "session_start", reason: "startup" });
  const missingOrigin = await missingOriginHost.emit("tool_call", {
    type: "tool_call",
    toolCallId: "missing-origin",
    toolName: "read",
    input: { path: "input.txt" },
  });
  assert.equal(missingOrigin, undefined);
  assert.equal(nativeToolAuthorityEntries(missingOriginHost, "dispatch").length, 0);
  assert.match(missingOriginHost.notifications.at(-1).message, /could not attribute.*audit coverage is incomplete/iu);

  const failingPersistenceHost = installHost(workspace, passingResponder(contractFixture())).pi;
  const appendEntry = failingPersistenceHost.appendEntry.bind(failingPersistenceHost);
  let nativeAttempts = 0;
  failingPersistenceHost.appendEntry = (customType, data) => {
    if (customType === NATIVE_TOOL_AUTHORITY_ENTRY) {
      nativeAttempts += 1;
      throw new Error("sensitive append failure detail");
    }
    return appendEntry(customType, data);
  };
  await failingPersistenceHost.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(nativeAttempts, 1);
  const persistenceCall = {
    type: "tool_call",
    toolCallId: "persistence-failure",
    toolName: "read",
    input: { path: "input.txt" },
  };
  assert.equal((await emitRetainedToolCall(failingPersistenceHost, persistenceCall)).outcome, undefined);
  assert.equal(nativeAttempts, 2);
  assert.equal(nativeToolAuthorityEntries(failingPersistenceHost).length, 0);
  assert.match(failingPersistenceHost.notifications.at(-1).message, /could not persist.*audit coverage is incomplete/iu);
  assert.doesNotMatch(failingPersistenceHost.notifications.at(-1).message, /sensitive append failure detail/u);
  const persistenceBlocked = await emitRetainedToolCall(failingPersistenceHost, {
    type: "tool_call",
    toolCallId: "persistence-blocked",
    toolName: "solar_revisit",
    input: {},
  }, [{ type: "tool_call", toolCallId: "persistence-sibling", toolName: "read", input: { path: "input.txt" } }]);
  assert.equal(persistenceBlocked.outcome.block, true);
  assert.equal(persistenceBlocked.outcome.terminate, true);
  assert.match(persistenceBlocked.outcome.reason, /must be the only tool call/u);
  assert.equal(nativeAttempts, 3);

  const missingStateHost = (await reviewedExecution(workspace)).pi;
  const currentState = [...missingStateHost.entries].reverse().find(entry => entry.type === "custom" && entry.customType === WORKFLOW_STATE);
  assert.ok(currentState);
  delete currentState.id;
  const executionCall = {
    type: "tool_call",
    toolCallId: "missing-state",
    toolName: "write",
    input: { path: "result.txt", content: "still authorized by the unchanged runtime guard" },
  };
  assert.equal((await emitRetainedToolCall(missingStateHost, executionCall)).outcome, undefined);
  assert.equal(nativeToolAuthorityEntries(missingStateHost, "dispatch").some(entry => entry.data.call.toolCallId === executionCall.toolCallId), false);
  assert.match(missingStateHost.notifications.at(-1).message, /could not bind.*audit coverage is incomplete/iu);
  assert.equal(await missingStateHost.emit("tool_result", {
    type: "tool_result",
    toolCallId: executionCall.toolCallId,
    toolName: executionCall.toolName,
    input: executionCall.input,
    content: [{ type: "text", text: "ordinary native result" }],
    details: undefined,
    isError: false,
  }), undefined);
  assert.ok(nativeToolAuthorityEntries(missingStateHost, "result").some(entry =>
    entry.data.call.toolCallId === executionCall.toolCallId
    && entry.data.decision === "current"));
  const resultCount = nativeToolAuthorityEntries(missingStateHost, "result").length;
  const orphan = await missingStateHost.emit("tool_result", {
    type: "tool_result",
    toolCallId: "missing-result-origin",
    toolName: "write",
    input: { path: "result.txt" },
    content: [{ type: "text", text: "unattributed native result" }],
    details: undefined,
    isError: false,
  });
  assert.equal(orphan.isError, true);
  assert.equal(orphan.details.staleExecutionResult, true);
  assert.equal(nativeToolAuthorityEntries(missingStateHost, "result").length, resultCount);
  assert.match(missingStateHost.notifications.at(-1).message, /could not attribute.*audit coverage is incomplete/iu);
}));

test("the harness grader accepts a real command-only controller completion digest", async () => fixture(async workspace => {
  const caseName = "execute-summary";
  const harnessFixture = getHarnessFixture(caseName);
  const outputPath = harnessFixture.outputPaths[0];
  const artifacts = [
    ...harnessFixture.allowedReadPaths.map((file, index) => ({ id: `I${index + 1}`, path: file, kind: "evidence", acceptance: "none", gates: [] })),
    { id: "A1", path: outputPath, kind: "final", acceptance: "command", gates: ["G1"] },
  ];
  const contract = {
    version: 3,
    domain: "software",
    requirements: [{ id: "R1", description: "Produce the exact fixture result.", source: "Confirmed synthetic request." }],
    artifacts,
    capabilities: [
      { id: "C1", kind: "read", tool: "read", paths: harnessFixture.allowedReadPaths, commands: [] },
      { id: "C2", kind: "write", tool: "write", paths: [outputPath], commands: [] },
    ],
    steps: [{
      id: "S1",
      title: "Create the fixture result",
      feasibility: "The named files and tools are available.",
      inputs: harnessFixture.allowedReadPaths.map((_file, index) => `I${index + 1}`),
      outputs: ["A1"],
      actions: ["Read the immutable inputs and write the one declared output."],
      dependsOn: [],
      requires: ["R1"],
      gates: ["G1"],
      capabilities: ["C1", "C2"],
    }],
    gates: [{ id: "G1", kind: "command", check: harnessFixture.evaluatorCommand, pass: "The evaluator exits zero.", evidence: ["A1"] }],
    selfCheck: {
      review: "The single bounded output is checked by the supplied evaluator.",
      requirementCoverage: [{ requirementId: "R1", stepIds: ["S1"], gateIds: ["G1"], explanation: "S1 produces and G1 checks the result." }],
      artifactCoverage: [{ artifactId: "A1", stepId: "S1", gateIds: ["G1"], explanation: "S1 is the sole producer." }],
      unresolved: [],
    },
  };
  const snapshot = content => ({ type: "file", bytes: Buffer.byteLength(content), sha256: sha256(content) });
  const beforeFiles = {};
  for (const [file, content] of Object.entries(harnessFixture.files)) {
    writeFileSync(path.join(workspace, file), content, "utf8");
    beforeFiles[file] = snapshot(content);
  }

  const { pi } = await reviewedExecution(workspace, { contract });
  const rawOutput = `${JSON.stringify(expectedFixtureOutput(caseName), null, 2)}\n`;
  writeFileSync(path.join(workspace, outputPath), rawOutput, "utf8");
  assertToolSucceeded(await pi.callTool("solar_step_done", {
    stepId: "S1",
    summary: "Created the exact current fixture result.",
    approach: { id: "write-fixture", description: "Write the sole declared JSON result from the immutable fixture input." },
    evidence: [outputPath],
  }), "fixture checkpoint");
  assertToolSucceeded(await pi.callTool("solar_step_done", {
    stepId: "final",
    summary: "Rerun every current command gate and bind the final manifests.",
    approach: { id: "final-fixture", description: "Hash the declared final around the exact evaluator command." },
    evidence: [outputPath],
  }), "fixture final verification");

  const workflow = pi.workflow();
  assert.equal(workflow.status, "complete");
  assert.match(workflow.finalReview, /^[a-f0-9]{64}$/u);
  const observedPlanText = readFileSync(workflow.plan.path, "utf8");
  assert.equal(observedPlanText, workflow.plan.text);
  const afterFiles = {
    ...structuredClone(beforeFiles),
    [outputPath]: snapshot(rawOutput),
    [workflow.plan.relativePath]: snapshot(observedPlanText),
  };
  const eligibilityValidation = validateSyntheticApproval(workflow.plan.contract, caseName);
  const approvalEligibility = {
    safe: eligibilityValidation.safe,
    eligible: eligibilityValidation.approved,
    decision: "eligible_synthetic_fixture",
    policyDecision: eligibilityValidation.decision,
    caseName: eligibilityValidation.caseName,
    evaluatorCommand: eligibilityValidation.evaluatorCommand,
    violations: [...eligibilityValidation.violations],
  };
  const grantEntryIndex = pi.entries.findIndex(entry =>
    entry.type === "custom"
    && entry.customType === WORKFLOW_STATE
    && entry.data?.stage === "execute"
    && entry.data?.approval === workflow.revision
    && entry.data?.approvalArtifactTableRevision === workflow.artifactTableRevision);
  assert.ok(grantEntryIndex > 0, "The actual controller approval grant must follow an existing entry watermark.");
  const entryWatermark = pi.entries[grantEntryIndex - 1].id;
  const approvalRequest = {
    workflowId: workflow.id,
    planRevision: workflow.revision,
    artifactTableRevision: workflow.artifactTableRevision,
    entryWatermark,
    eventIndex: 0,
    command: `/solar-workflow approve ${workflow.revision.slice(0, 12)}`,
    dispatched: true,
    rpcRequestId: "harness-fakepi-approval",
  };
  const approvalFlow = {
    approvalEligibility,
    approvalRequest,
    approval: null,
    approvalBoundaryEventIndex: null,
  };
  const { auditNativeToolAuthority, reconcileHostApproval } = await import("../scripts/harness-experiment.mjs");
  reconcileHostApproval(approvalFlow, {
    since: entryWatermark,
    entries: pi.entries.slice(grantEntryIndex),
    leafId: pi.entries.at(-1).id,
  });
  const authorityEntries = [{
    id: "authority-coverage",
    parentId: null,
    timestamp: "2026-09-14T22:00:00.000Z",
    type: "custom",
    customType: NATIVE_TOOL_AUTHORITY_ENTRY,
    data: {
      version: 1,
      kind: "coverage",
      scope: "main_session_native_tool_hooks",
      dispatch: "every_call",
      result: "every_execution_allowed_call",
    },
  }];
  const nativeToolAuthorityAudit = auditNativeToolAuthority([], {
    entries: authorityEntries,
    leafId: authorityEntries[0].id,
    finalCaptureComplete: true,
  });
  const grade = gradeHarnessResult(caseName, {
    preflight: { passed: true },
    process: { exitCode: 0, signal: null },
    providerFailures: [],
    events: [],
    entries: [{
      type: "custom",
      customType: "solar-interview-closure-v2",
      data: {
        mode: "normal",
        completionAuthority: "user_confirmation",
        confirmedGoal: { sentence: "Read input.json and create only JSON summary.json." },
      },
    }],
    workflow,
    beforeFiles,
    afterFiles,
    outputContents: { [outputPath]: rawOutput },
    fixturePolicyAudit: { scope: "fixture_policy", calls: [], violations: [], approvalEventIndex: approvalFlow.approvalBoundaryEventIndex, preApprovalMutations: [] },
    planContract: structuredClone(workflow.plan.contract),
    approvalEligibility,
    approval: approvalFlow.approval,
    nativeToolAuthorityAudit,
  });
  const approvalAssertion = grade.assertions.find(item => item.id === "synthetic_plan_was_safely_approved");
  const completion = grade.assertions.find(item => item.id === "command_only_workflow_completed");
  assert.equal(approvalAssertion.passed, true, JSON.stringify(approvalAssertion.evidence));
  assert.equal(completion.passed, true, JSON.stringify(completion.evidence));
  assert.equal(completion.evidence.finalReview, workflow.finalReview);
  assert.equal(grade.passed, true, JSON.stringify(grade.assertions.filter(item => !item.passed)));
}));

test("only approved execution binds the Executor and retains exact tool capabilities", async () => fixture(async workspace => {
  const { pi } = await reviewedExecution(workspace);
  const result = await pi.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: pi.sentUserMessages.at(-1).message,
    systemPrompt: "base",
  });
  assert.ok(result.systemPrompt.startsWith("base\n<solar-workflow-main-instructions-v1>\nActive Solar main-session stage: execute\n"));
  assert.ok(result.systemPrompt.includes(renderHarnessRolePrompt("executor")));
  assert.ok(result.systemPrompt.endsWith("</solar-workflow-main-instructions-v1>"));
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
