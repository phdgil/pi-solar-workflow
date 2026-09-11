import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  SOLAR_ROLE_BUNDLE_MAX_BYTES,
  SOLAR_ROLE_DEADLINE_MS,
  SOLAR_ROLE_EXCERPT_MAX_BYTES,
  buildRoleContextBundle,
  canonicalWorkspaceSource,
  createPiSdkSolarRoleSessionFactory,
  createSolarRoleBudget,
  createSolarRoleRunner,
  requireSolarMaxModel,
  reserveSolarRoleBudget,
  validateRoleContextBundle,
} from "./roles.ts";

const MODEL = {
  provider: "upstage",
  id: "solar-pro4",
  name: "Solar Pro 4",
  reasoning: true,
  thinkingLevelMap: { max: "max" },
};
const SYSTEM_PROMPT = "Act as an isolated planning role.";

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function baseBundle() {
  const content = JSON.stringify({ requirement: "Keep output current." });
  return buildRoleContextBundle({
    mandatory: [{
      kind: "requirement",
      source: "requirement-head",
      sourceType: "state",
      selection: { whole: true },
      content,
      expectedSha256: hash(content),
    }],
  });
}

function baseInput(overrides = {}) {
  const bundle = overrides.bundle ?? baseBundle();
  return {
    workflowId: "workflow-1",
    role: "planner",
    inputRevision: bundle.bundleRevision,
    planRevision: hash("plan-revision-1"),
    systemPrompt: SYSTEM_PROMPT,
    prompt: "Return the reviewed plan.",
    bundle,
    ...overrides,
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

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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

function assistant(text = "visible result", overrides = {}) {
  return {
    role: "assistant",
    provider: "upstage",
    model: "solar-pro4",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "hidden chain of thought" },
      { type: "text", text },
    ],
    ...overrides,
  };
}

function fakeSession(options = {}) {
  const stats = {
    promptCalls: 0,
    abortCalls: 0,
    disposeCalls: 0,
    prompts: [],
  };
  const session = {
    state: {
      model: MODEL,
      thinkingLevel: "max",
      tools: [],
      messages: [],
      ...options.state,
    },
    systemPrompt: options.systemPrompt ?? `${SYSTEM_PROMPT}\nCurrent working directory: C:/workspace`,
    sessionManager: options.sessionManager,
    settingsManager: options.settingsManager,
    sessionFile: options.sessionFile,
    getActiveToolNames: () => options.activeTools ?? [],
    async prompt(text, promptOptions) {
      stats.promptCalls += 1;
      stats.prompts.push({ text, options: promptOptions });
      if (options.prompt) await options.prompt(session);
      else session.state.messages.push(assistant(options.output));
    },
    async abort() {
      stats.abortCalls += 1;
      if (options.abort) await options.abort();
    },
    dispose() {
      stats.disposeCalls += 1;
      if (options.dispose) options.dispose();
    },
  };
  return { session, stats };
}

function incrementalIds() {
  const counts = { attempt: 0, context: 0 };
  return kind => `${kind}-${++counts[kind]}`;
}

function fakeBoundary(options = {}) {
  let budget = options.budget ?? createSolarRoleBudget();
  const events = [];
  const attempts = [];
  const commits = [];
  return {
    events,
    attempts,
    commits,
    get budget() {
      return budget;
    },
    reserveAttempt(input) {
      events.push(["reserve", input]);
      if (options.reserve) return options.reserve(input);
      const reservation = reserveSolarRoleBudget(budget, input.repair);
      budget = reservation.budget;
      return { attemptOrdinal: reservation.attemptOrdinal };
    },
    current(identity) {
      events.push(["current", identity]);
      return options.current ? options.current(identity, events) : true;
    },
    recordAttempt(attempt) {
      events.push(["record", attempt.status]);
      attempts.push(attempt);
      return options.recordAttempt?.(attempt);
    },
    commit(result) {
      events.push(["commit", result.receipt.contextId]);
      commits.push(result);
      return options.commit?.(result);
    },
  };
}

function terminalAttempt(boundary) {
  return boundary.attempts.filter(attempt => attempt.terminalReason).at(-1);
}

test("provenance bundles hash exact bytes, exclude private context, and omit oversized optional excerpts without clipping", () => {
  const mandatory = "Exact requirement bytes: 한글";
  const included = "export const answer = 42;";
  const privateText = "private token must never reach the child";
  const oversized = "x".repeat(SOLAR_ROLE_EXCERPT_MAX_BYTES + 1);
  const bundle = buildRoleContextBundle({
    mandatory: [{
      kind: "requirement",
      source: "requirement-7",
      sourceType: "state",
      selection: { whole: true },
      content: mandatory,
      expectedSha256: hash(mandatory),
    }],
    optionalExcerpts: [
      {
        kind: "source_excerpt",
        source: "src/answer.ts",
        sourceType: "workspace",
        selection: { startLine: 4, endLine: 4 },
        content: included,
      },
      {
        kind: "source_excerpt",
        source: "private/session.txt",
        sourceType: "workspace",
        selection: { startLine: 1, endLine: 1 },
        content: privateText,
      },
      {
        kind: "source_excerpt",
        source: "src/oversized.txt",
        sourceType: "workspace",
        selection: { whole: true },
        content: oversized,
      },
    ],
    exclusions: [{
      source: "private",
      sourceType: "workspace",
      match: "tree",
      reason: "private workspace material excluded by host",
    }],
  });

  assert.equal(bundle.items[0].content, mandatory);
  assert.equal(bundle.items[0].bytes, Buffer.byteLength(mandatory));
  assert.equal(bundle.items[0].sha256, hash(mandatory));
  assert.equal(bundle.items[1].source, "src/answer.ts");
  assert.equal(bundle.items[1].content, included);
  assert.equal(bundle.totalBytes, bundle.items.reduce((total, item) => total + Buffer.byteLength(item.content), 0));
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) <= SOLAR_ROLE_BUNDLE_MAX_BYTES);
  assert.deepEqual(validateRoleContextBundle(bundle), bundle);
  assert.match(bundle.omitted.find(item => item.source === "private/session.txt").reason, /private/);
  assert.match(bundle.omitted.find(item => item.source === "src/oversized.txt").reason, /131072/);
  assert.equal(JSON.stringify(bundle).includes(privateText), false);
  assert.equal(JSON.stringify(bundle).includes(oversized), false);
});

test("mandatory provenance is never silently clipped or bypassed through excluded and noncanonical sources", () => {
  assert.throws(() => buildRoleContextBundle({
    mandatory: [{
      kind: "requirement",
      source: "requirement-head",
      sourceType: "state",
      selection: { whole: true },
      content: "m".repeat(SOLAR_ROLE_BUNDLE_MAX_BYTES),
    }],
  }), /exceeds.*mandatory content was not clipped/);

  assert.throws(() => buildRoleContextBundle({
    mandatory: [{
      kind: "plan",
      source: ".gjc/private-plan.md",
      sourceType: "workspace",
      selection: { whole: true },
      content: "private plan",
    }],
  }), /mandatory.*excluded/);

  assert.throws(() => buildRoleContextBundle({
    mandatory: [{
      kind: "requirement",
      source: "requirement-head",
      sourceType: "state",
      selection: { whole: true },
      content: "changed bytes",
      expectedSha256: hash("old bytes"),
    }],
  }), /does not match/);
  assert.throws(() => canonicalWorkspaceSource("src\\answer.ts"), /forward slashes/);
  assert.throws(() => canonicalWorkspaceSource("src/../private.txt"), /dot, or parent/);

  const bundle = baseBundle();
  const tampered = structuredClone(bundle);
  tampered.items[0].content += " changed";
  assert.throws(() => validateRoleContextBundle(tampered), /byte count/);
});

test("the injected Pi SDK factory pins empty tools, disabled discovery, in-memory settings, Solar Pro4 Max, and distinct managers", async () => {
  const settingsCalls = [];
  const sessionManagers = [];
  const loaders = [];
  const createCalls = [];
  class FakeLoader {
    constructor(options) {
      this.options = options;
      this.reloads = 0;
      loaders.push(this);
    }
    async reload() { this.reloads += 1; }
    getExtensions() { return { extensions: [], errors: [] }; }
    getSkills() { return { skills: [] }; }
    getPrompts() { return { prompts: [] }; }
    getThemes() { return { themes: [] }; }
    getAgentsFiles() { return { agentsFiles: [] }; }
    getSystemPrompt() { return this.options.systemPrompt; }
    getSystemPromptSource() { return undefined; }
    getAppendSystemPrompt() { return []; }
  }
  const sdk = {
    SettingsManager: {
      inMemory(settings, managerOptions) {
        const manager = {
          settings,
          managerOptions,
          getCompactionSettings: () => ({ enabled: settings.compaction.enabled }),
          getRetrySettings: () => ({ enabled: settings.retry.enabled, maxRetries: settings.retry.maxRetries }),
          getProviderRetrySettings: () => ({ ...settings.retry.provider }),
        };
        settingsCalls.push(manager);
        return manager;
      },
    },
    SessionManager: {
      inMemory(cwd) {
        const manager = { cwd, serial: sessionManagers.length + 1 };
        sessionManagers.push(manager);
        return manager;
      },
    },
    DefaultResourceLoader: FakeLoader,
    async createAgentSession(options) {
      createCalls.push(options);
      const made = fakeSession({
        sessionManager: options.sessionManager,
        settingsManager: options.settingsManager,
        systemPrompt: `${options.resourceLoader.options.systemPrompt}\nCurrent working directory: ${options.cwd}`,
      });
      return { session: made.session };
    },
  };
  const registryCalls = [];
  const registry = {
    find(provider, modelId) {
      registryCalls.push([provider, modelId]);
      return MODEL;
    },
  };
  const model = requireSolarMaxModel(registry);
  const factory = createPiSdkSolarRoleSessionFactory({
    sdk,
    cwd: "C:/workspace",
    agentDir: "C:/pi-home/agent",
    solarMaxModel: model,
  });
  const bundle = baseBundle();
  const request = {
    ...baseInput({ bundle }),
    contextId: "context-one",
  };
  const first = await factory(request);
  const second = await factory({ ...request, contextId: "context-two" });

  assert.deepEqual(registryCalls, [["upstage", "solar-pro4"]]);
  assert.equal(createCalls.length, 2);
  assert.notEqual(settingsCalls[0], settingsCalls[1]);
  assert.notEqual(sessionManagers[0], sessionManagers[1]);
  assert.notEqual(first, second);
  for (let index = 0; index < createCalls.length; index += 1) {
    const call = createCalls[index];
    assert.equal(call.model, MODEL);
    assert.equal(call.thinkingLevel, "max");
    assert.deepEqual(call.tools, []);
    assert.deepEqual(call.customTools, []);
    assert.equal(call.noTools, "all");
    assert.deepEqual(call.scopedModels, [{ model: MODEL, thinkingLevel: "max" }]);
    assert.equal(call.sessionManager, sessionManagers[index]);
    assert.equal(call.settingsManager, settingsCalls[index]);
    assert.equal(loaders[index].reloads, 1);
    assert.deepEqual(
      {
        noExtensions: loaders[index].options.noExtensions,
        noSkills: loaders[index].options.noSkills,
        noPromptTemplates: loaders[index].options.noPromptTemplates,
        noThemes: loaders[index].options.noThemes,
        noContextFiles: loaders[index].options.noContextFiles,
      },
      { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    );
    assert.deepEqual(settingsCalls[index].settings.compaction, { enabled: false });
    assert.deepEqual(settingsCalls[index].settings.retry, {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      provider: { maxRetries: 0, maxRetryDelayMs: 0, timeoutMs: 180000 },
    });
    assert.equal(settingsCalls[index].managerOptions.projectTrusted, false);
  }
  first.dispose();
  second.dispose();

  assert.throws(() => createPiSdkSolarRoleSessionFactory({
    sdk,
    cwd: "C:/workspace",
    agentDir: "C:/pi-home/agent",
    solarMaxModel: { ...MODEL, id: "fallback-model" },
  }), /registry-confirmed upstage\/solar-pro4/);
});

test("successful attempts commit only visible output behind a final identity check and fresh receipt", async () => {
  const sessions = [];
  const requests = [];
  const diagnostics = [];
  const runner = createSolarRoleRunner({
    idFactory: incrementalIds(),
    diagnostic: value => diagnostics.push(value),
    async sessionFactory(request) {
      requests.push(request);
      const made = fakeSession();
      sessions.push(made);
      return made.session;
    },
  });
  const boundary = fakeBoundary();
  const first = await runner.run(baseInput(), boundary);
  const second = await runner.run(baseInput({ role: "critic", planRevision: hash("plan-revision-2") }), boundary);

  assert.equal(first.output, "visible result");
  assert.equal(first.output.includes("hidden chain of thought"), false);
  assert.equal(first.receipt.provider, "upstage");
  assert.equal(first.receipt.modelId, "solar-pro4");
  assert.equal(first.receipt.thinkingLevel, "max");
  assert.equal(first.receipt.inputRevision, first.receipt.bundleRevision);
  assert.equal(first.receipt.bundleRevision, baseInput().bundle.bundleRevision);
  assert.equal(first.receipt.outputRevision, hash("visible result"));
  assert.equal(first.receipt.attemptOrdinal, 1);
  assert.equal(first.receipt.repair, false);
  assert.equal(first.receipt.policy.deadlineMs, SOLAR_ROLE_DEADLINE_MS);
  assert.equal(first.receipt.policy.attemptAccounting, "sdk_session_attempts");
  assert.notEqual(first.receipt.contextId, second.receipt.contextId);
  assert.notEqual(first.receipt.attemptId, second.receipt.attemptId);
  assert.equal(second.receipt.attemptOrdinal, 2);
  assert.equal(boundary.commits.length, 2);
  const firstReservation = boundary.events.find(event => event[0] === "reserve")[1];
  assert.equal(firstReservation.deadlineAt - firstReservation.startedAt, SOLAR_ROLE_DEADLINE_MS);
  assert.equal(boundary.events.at(-1)[0], "commit");
  assert.equal(boundary.events.at(-2)[0], "current");
  assert.equal(requests[0].contextId, "context-1");
  assert.equal(requests[0].signal instanceof AbortSignal, true);
  assert.match(sessions[0].stats.prompts[0].text, /solar-role-metadata/);
  assert.match(sessions[0].stats.prompts[0].text, new RegExp(first.receipt.bundleRevision));
  assert.deepEqual(sessions[0].stats.prompts[0].options, { expandPromptTemplates: false, source: "extension" });
  assert.deepEqual(sessions.map(item => item.stats.disposeCalls), [1, 1]);
  assert.deepEqual(sessions.map(item => item.stats.abortCalls), [0, 0]);
  assert.equal(diagnostics.filter(item => item.code === "completed").length, 2);
  assert.equal(JSON.stringify(diagnostics).includes("hidden chain of thought"), false);
});

test("digit-leading canonical workflow UUIDs are valid role identities", async () => {
  const workflowId = "7f07a075-61c0-4dc8-8b0c-e0dc848ca74b";
  const runner = createSolarRoleRunner({
    idFactory: incrementalIds(),
    diagnostic() {},
    async sessionFactory() {
      return fakeSession().session;
    },
  });
  const boundary = fakeBoundary();
  const result = await runner.run(baseInput({ workflowId }), boundary);

  assert.equal(result.attempt.workflowId, workflowId);
  assert.equal(boundary.events.find(event => event[0] === "reserve")[1].workflowId, workflowId);
  assert.equal(boundary.commits[0].receipt.attemptId, result.receipt.attemptId);
});

test("a never-resolving creation times out, and a late-created session is aborted and disposed without prompting", async () => {
  const clock = new FakeClock();
  const creation = deferred();
  const late = fakeSession();
  const diagnostics = [];
  let factoryCalls = 0;
  const runner = createSolarRoleRunner({
    clock,
    idFactory: incrementalIds(),
    diagnostic: value => diagnostics.push(value),
    sessionFactory() {
      factoryCalls += 1;
      return creation.promise;
    },
  });
  const boundary = fakeBoundary();
  const pending = runner.run(baseInput(), boundary);
  const rejected = assert.rejects(pending, error => error.code === "deadline" && error.attempt.status === "timed_out");
  await flush();
  clock.tick(SOLAR_ROLE_DEADLINE_MS);
  await rejected;

  assert.equal(factoryCalls, 1);
  assert.equal(boundary.commits.length, 0);
  assert.equal(terminalAttempt(boundary).terminalReason, "deadline");
  creation.resolve(late.session);
  await flush();
  assert.equal(late.stats.promptCalls, 0);
  assert.equal(late.stats.abortCalls, 1);
  assert.equal(late.stats.disposeCalls, 1);
  assert.ok(diagnostics.some(item => item.code === "late_session_disposed"));
});

test("a never-resolving prompt times out, disposes once, and ignores output that arrives late", async () => {
  const clock = new FakeClock();
  const prompt = deferred();
  const promptStarted = deferred();
  const made = fakeSession({
    async prompt(session) {
      promptStarted.resolve();
      await prompt.promise;
      session.state.messages.push(assistant("late visible output"));
    },
  });
  const diagnostics = [];
  const runner = createSolarRoleRunner({
    clock,
    idFactory: incrementalIds(),
    diagnostic: value => diagnostics.push(value),
    sessionFactory: async () => made.session,
  });
  const boundary = fakeBoundary();
  const pending = runner.run(baseInput(), boundary);
  const rejected = assert.rejects(pending, error => error.code === "deadline");
  await promptStarted.promise;
  assert.equal(made.stats.promptCalls, 1);
  clock.tick(SOLAR_ROLE_DEADLINE_MS);
  assert.equal(made.stats.abortCalls, 1);
  assert.equal(made.stats.disposeCalls, 1);
  await rejected;
  assert.equal(made.stats.disposeCalls, 1);
  assert.equal(boundary.commits.length, 0);

  prompt.resolve();
  await flush();
  assert.equal(boundary.commits.length, 0);
  assert.equal(made.stats.disposeCalls, 1);
  assert.ok(diagnostics.some(item => item.code === "late_output_ignored"));
});

test("creation and prompt rejection persist terminal reasons and dispose every obtained session once", async t => {
  await t.test("creation rejection", async () => {
    const boundary = fakeBoundary();
    const runner = createSolarRoleRunner({
      idFactory: incrementalIds(),
      diagnostic: () => {},
      sessionFactory: async () => { throw new Error("provider detail must not surface"); },
    });
    await assert.rejects(runner.run(baseInput(), boundary), error => {
      assert.equal(error.code, "session_creation_failed");
      assert.equal(error.message.includes("provider detail"), false);
      return true;
    });
    assert.equal(terminalAttempt(boundary).terminalReason, "session_creation_failed");
    assert.equal(boundary.commits.length, 0);
  });

  await t.test("prompt rejection", async () => {
    const made = fakeSession({ prompt: async () => { throw new Error("secret provider body"); } });
    const boundary = fakeBoundary();
    const runner = createSolarRoleRunner({ idFactory: incrementalIds(), diagnostic: () => {}, sessionFactory: async () => made.session });
    await assert.rejects(runner.run(baseInput(), boundary), error => {
      assert.equal(error.code, "prompt_failed");
      assert.equal(error.message.includes("secret provider body"), false);
      return true;
    });
    assert.equal(terminalAttempt(boundary).terminalReason, "prompt_failed");
    assert.equal(made.stats.abortCalls, 1);
    assert.equal(made.stats.disposeCalls, 1);
  });
});

test("caller cancellation, stop, and shutdown make late work non-authoritative", async t => {
  await t.test("already-aborted request is rejected before budget reservation", async () => {
    const controller = new AbortController();
    controller.abort();
    let factoryCalls = 0;
    const boundary = fakeBoundary();
    const runner = createSolarRoleRunner({
      idFactory: incrementalIds(),
      diagnostic: () => {},
      sessionFactory: async () => {
        factoryCalls += 1;
        return fakeSession().session;
      },
    });
    await assert.rejects(runner.run(baseInput({ signal: controller.signal }), boundary), error => error.code === "request_cancelled");
    assert.equal(factoryCalls, 0);
    assert.equal(boundary.events.length, 0);
  });

  await t.test("caller abort during prompt", async () => {
    const prompt = deferred();
    const made = fakeSession({ prompt: async () => prompt.promise });
    const controller = new AbortController();
    const boundary = fakeBoundary();
    const runner = createSolarRoleRunner({ idFactory: incrementalIds(), diagnostic: () => {}, sessionFactory: async () => made.session });
    const pending = runner.run(baseInput({ signal: controller.signal }), boundary);
    const rejected = assert.rejects(pending, error => error.code === "request_cancelled");
    await flush();
    controller.abort();
    await rejected;
    assert.equal(made.stats.abortCalls, 1);
    assert.equal(made.stats.disposeCalls, 1);
    assert.equal(boundary.commits.length, 0);
    prompt.resolve();
    await flush();
    assert.equal(boundary.commits.length, 0);
  });

  await t.test("stop during creation cleans up a late session", async () => {
    const creation = deferred();
    const made = fakeSession();
    const boundary = fakeBoundary();
    const runner = createSolarRoleRunner({ idFactory: incrementalIds(), diagnostic: () => {}, sessionFactory: () => creation.promise });
    const pending = runner.run(baseInput(), boundary);
    const rejected = assert.rejects(pending, error => error.code === "stopped");
    await flush();
    runner.stop();
    await rejected;
    creation.resolve(made.session);
    await flush();
    assert.equal(made.stats.promptCalls, 0);
    assert.equal(made.stats.abortCalls, 1);
    assert.equal(made.stats.disposeCalls, 1);
  });

  await t.test("shutdown cancels current work and rejects later dispatches", async () => {
    const prompt = deferred();
    const made = fakeSession({ prompt: async () => prompt.promise });
    const boundary = fakeBoundary();
    const runner = createSolarRoleRunner({ idFactory: incrementalIds(), diagnostic: () => {}, sessionFactory: async () => made.session });
    const pending = runner.run(baseInput(), boundary);
    const rejected = assert.rejects(pending, error => error.code === "shutdown");
    await flush();
    runner.shutdown();
    await rejected;
    assert.equal(made.stats.abortCalls, 1);
    assert.equal(made.stats.disposeCalls, 1);
    const secondBoundary = fakeBoundary();
    await assert.rejects(runner.run(baseInput(), secondBoundary), error => error.code === "runner_shutdown");
    assert.equal(secondBoundary.events.length, 0);
    prompt.resolve();
  });
});

test("stale workflow identity after prompting blocks receipt commit", async () => {
  const made = fakeSession();
  let currentCalls = 0;
  const boundary = fakeBoundary({ current: () => ++currentCalls < 5 });
  const runner = createSolarRoleRunner({ idFactory: incrementalIds(), diagnostic: () => {}, sessionFactory: async () => made.session });
  await assert.rejects(runner.run(baseInput(), boundary), error => error.code === "stale_identity" && error.attempt.status === "stale");
  assert.equal(currentCalls, 5);
  assert.equal(boundary.commits.length, 0);
  assert.equal(terminalAttempt(boundary).terminalReason, "stale_identity");
  assert.equal(made.stats.disposeCalls, 1);
});

test("an input revision that does not bind the exact bundle is rejected before budget reservation", async () => {
  let factoryCalls = 0;
  const boundary = fakeBoundary();
  const runner = createSolarRoleRunner({
    idFactory: incrementalIds(),
    diagnostic: () => {},
    sessionFactory: async () => {
      factoryCalls += 1;
      return fakeSession().session;
    },
  });
  await assert.rejects(
    runner.run(baseInput({ inputRevision: hash("different bundle") }), boundary),
    /inputRevision must bind the exact provenance bundle/,
  );
  assert.equal(factoryCalls, 0);
  assert.equal(boundary.events.length, 0);
});

test("attempt and repair exhaustion reject before creating an SDK session", async () => {
  let factoryCalls = 0;
  const runner = createSolarRoleRunner({
    idFactory: incrementalIds(),
    diagnostic: () => {},
    sessionFactory: async () => {
      factoryCalls += 1;
      return fakeSession().session;
    },
  });

  const exhaustedCalls = fakeBoundary({
    budget: createSolarRoleBudget({ roleCalls: 12, maxRoleCalls: 12 }),
  });
  await assert.rejects(runner.run(baseInput(), exhaustedCalls), error => error.code === "budget_rejected");
  assert.equal(factoryCalls, 0);
  assert.equal(exhaustedCalls.commits.length, 0);

  let repairBudget = createSolarRoleBudget({ maxRoleCalls: 12, maxRoleRepairs: 0 });
  const exhaustedRepairs = fakeBoundary({
    reserve(input) {
      const reservation = reserveSolarRoleBudget(repairBudget, input.repair);
      repairBudget = reservation.budget;
      return { attemptOrdinal: reservation.attemptOrdinal };
    },
  });
  await assert.rejects(runner.run(baseInput({ repairOf: "attempt-prior" }), exhaustedRepairs), error => error.code === "budget_rejected");
  assert.equal(repairBudget.roleCalls, 0, "repair reservation is atomic and consumes neither budget when exhausted");
  assert.equal(factoryCalls, 0);
});

test("tool calls, fallback identity, and thinking-only output are rejected without a passing receipt", async t => {
  const cases = [
    {
      name: "tool call",
      message: assistant("not authoritative", { content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] }),
      code: "policy_violation",
    },
    {
      name: "fallback model",
      message: assistant("fallback", { model: "other-model" }),
      code: "policy_violation",
    },
    {
      name: "thinking only",
      message: assistant("", { content: [{ type: "thinking", thinking: "hidden only" }] }),
      code: "invalid_visible_output",
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const made = fakeSession({
        async prompt(session) {
          session.state.messages.push(fixture.message);
        },
      });
      const boundary = fakeBoundary();
      const runner = createSolarRoleRunner({ idFactory: incrementalIds(), diagnostic: () => {}, sessionFactory: async () => made.session });
      await assert.rejects(runner.run(baseInput(), boundary), error => error.code === fixture.code);
      assert.equal(boundary.commits.length, 0);
      assert.equal(made.stats.disposeCalls, 1);
    });
  }
});
