import test from "node:test";
import assert from "node:assert/strict";
import {
  assessInterview,
  classifyInterviewProgress,
  confirmInterview,
  finishInterview,
  goalToken,
  interviewConfirmationToken,
  interviewContentHash,
  isInterviewFinishRequest,
  recoverInterview,
  renderInterview,
  renderInterviewClosure,
  INTERVIEW_STATE,
  INTERVIEW_REVIEW_STATE,
  INTERVIEW_CLOSURE_STATE,
} from "./interview.ts";

const answers = [{ id: "answer-1", text: "Offline; success is independent reasoning." }];

function openMaterial(sourceText = answers[0].text) {
  return {
    topics: [{ topicId: "goal", kind: "decision", normalizedValue: "offline independent reasoning", sourceContentHashes: [interviewContentHash(sourceText)] }],
    gaps: [{ gapId: "observable", status: "open", normalizedSummary: "observable proof of independent reasoning" }],
    claims: [],
  };
}

function proposal(score = 0.5, overrides = {}) {
  const dimension = () => ({ score, evidence: ["answer-1"], gap: score < 1 ? "Meaning needs clarification" : "" });
  return {
    goal: dimension(),
    constraints: dimension(),
    success: dimension(),
    blockers: [],
    intent: "Improve independent reasoning offline.",
    changeReason: "The user defined the intended outcome.",
    question: "What observable behavior demonstrates independent reasoning?",
    strategy: "question",
    currentGapId: "observable",
    materialState: openMaterial(),
    readiness: {
      status: "not_ready",
      materialGaps: [{ id: "observable", issue: "Observable proof is not yet chosen.", evidenceIds: ["answer-1"], researchable: false }],
      contradictions: [],
    },
    ...overrides,
  };
}

function readyProposal(score = 0.5, sourceText = answers[0].text) {
  const input = proposal(score);
  input.question = "";
  input.strategy = "ready";
  delete input.currentGapId;
  input.materialState = {
    topics: [{ topicId: "goal", kind: "decision", normalizedValue: "build an offline independent-reasoning exercise with an observable worked example", sourceContentHashes: [interviewContentHash(sourceText)] }],
    gaps: [{ gapId: "observable", status: "resolved", normalizedSummary: "a worked example is the observable proof" }],
    claims: [],
  };
  input.readiness = {
    status: "ready",
    goalSentence: "Build an offline exercise whose worked example demonstrates independent reasoning.",
    materialGaps: [],
    contradictions: [],
  };
  return input;
}

function correctedProposal(score, answer, value = "use a worked example rather than a numeric score") {
  const input = proposal(score);
  input.materialState.topics[0] = {
    topicId: "goal",
    kind: "correction",
    normalizedValue: value,
    sourceContentHashes: [interviewContentHash(answer.text)],
  };
  input.changeReason = "The latest answer materially corrected the intended outcome.";
  return input;
}

test("older Solar and Lite sessions retain answers and a terminal closure record", () => {
  for (const prefix of ["solar", "lite"]) {
    const entries = [{ type: "message", id: "old-start", message: { role: "user", content: `<skill name="${prefix}-interview">Old instructions</skill>\nOriginal intention.` } }];
    let recovered = recoverInterview(entries);
    assert.equal(recovered.active, true);
    assert.equal(recovered.anchorId, "old-start");
    assert.equal(recovered.answers[0].text, "Original intention.");
    const closure = finishInterview(undefined, recovered.answers, recovered.anchorId, "/solar-interview finish");
    recovered = recoverInterview([...entries, { type: "custom", customType: "solar-interview-closure-v1", data: closure }]);
    assert.equal(recovered.active, false);
    assert.deepEqual(recovered.closure, closure);
  }
});

test("every assessed round displays an advisory score and material change without score gating", () => {
  const first = assessInterview(proposal(), undefined, answers, "answer-1");
  const answer2 = { id: "answer-2", text: "Use a worked example as the observable behavior." };
  const next = assessInterview(correctedProposal(0.7, answer2), first, [...answers, answer2], "answer-1");
  assert.match(renderInterview(first), /50.0%.*no prior verified score.*informational only/);
  assert.match(renderInterview(first), /Scores are advisory only.*explicit early finish/);
  assert.match(renderInterview(next), /30.0%.*-20.0 percentage points.*round 2/);
  assert.equal(next.progress.progressed, true);
  assert.match(renderInterview(next, true), /모호성 30.0%/);
});

test("open issues do not replace raw ambiguity", () => {
  const input = proposal(0.35);
  input.blockers = ["Conflicting non-goal"];
  const state = assessInterview(input, undefined, answers, "answer-1");
  assert.equal(state.raw, 65);
  assert.equal(state.ambiguity, 65);
});

test("ambiguity may increase while a genuine correction still counts as progress", () => {
  const first = assessInterview(proposal(0.99), undefined, answers, "answer-1");
  const answer2 = { id: "answer-2", text: "Correction: use the opposite observable behavior." };
  const input = correctedProposal(0.8, answer2, "use the opposite observable behavior");
  input.blockers = ["New contradictory requirement"];
  const next = assessInterview(input, first, [...answers, answer2], "answer-1");
  assert.equal(next.ambiguity, 20);
  assert.equal(next.delta, 19);
  assert.equal(next.progress.progressed, true);
  assert.deepEqual(next.proposal.blockers, input.blockers);
});

test("no score automatically finishes or prevents explicit early closure", () => {
  for (const score of [0, 0.25, 0.9499, 0.951, 1]) {
    const state = assessInterview(proposal(score), undefined, answers, "answer-1");
    assert.equal(state.status, "interviewing");
    assert.equal(state.threshold, undefined);
    const closure = finishInterview(state, answers, "answer-1", "/solar-interview finish", false, { researchHead: null });
    assert.equal(closure.status, "user_finished");
    assert.equal(closure.mode, "early");
  }
});

test("current goal token creates normal closure and stale answer or research heads reject it", () => {
  const state = assessInterview(readyProposal(), undefined, answers, "answer-1", { researchHead: "research-r1" });
  const token = goalToken(state);
  assert.equal(token.length, 12);
  assert.equal(state.goalToken, token);
  assert.equal(interviewConfirmationToken(`/solar-interview confirm ${token}`), token);
  assert.equal(interviewConfirmationToken("/solar-interview confirm"), undefined);
  assert.equal(interviewConfirmationToken("yes"), undefined);
  assert.equal(state.status, "awaiting_goal_confirmation");
  assert.match(renderInterview(state), new RegExp(token));
  assert.throws(() => confirmInterview(state, answers, "answer-1", "000000000000", { researchHead: "research-r1" }), /stale or incorrect/);
  assert.throws(() => confirmInterview(state, [...answers, { id: "answer-2", text: "A later correction." }], "answer-1", token, { researchHead: "research-r1" }), /stale/);
  assert.throws(() => confirmInterview(state, answers, "answer-1", token, { researchHead: "research-r2" }), /stale/);
  const early = finishInterview(state, answers, "answer-1", "/solar-interview finish", false, { researchHead: "research-r1" });
  assert.equal(early.mode, "early");
  assert.equal(early.confirmedGoal, undefined);
  assert.equal(early.unconfirmedGoal.revision, state.goalRevision);
  const closure = confirmInterview(state, answers, "answer-1", token, { researchHead: "research-r1", request: `/solar-interview confirm ${token}` });
  assert.equal(closure.mode, "normal");
  assert.equal(closure.completionAuthority, "user_confirmation");
  assert.equal(closure.assessmentCurrent, true);
  assert.equal(closure.confirmedGoal.revision, state.goalRevision);
  assert.equal(closure.confirmedGoal.token, token);
  assert.equal(closure.executionAuthority, "none");
  assert.match(renderInterviewClosure(closure), /normally closed.*confirmed/i);
  const recovered = recoverInterview([
    { type: "message", id: "answer-1", message: { role: "user", content: "/skill:solar-interview Offline; success is independent reasoning." } },
    { type: "custom", customType: INTERVIEW_STATE, data: state },
    { type: "custom", customType: INTERVIEW_CLOSURE_STATE, data: closure },
  ], { researchHead: "research-r1" });
  assert.equal(recovered.active, false);
  assert.deepEqual(recovered.closure, closure);
});

test("normal readiness rejects blockers, contradictions, open gaps, and a pending review", () => {
  const contradiction = readyProposal();
  contradiction.readiness.contradictions = [{ id: "conflict", issue: "Offline and cloud-only requirements conflict.", evidenceIds: ["answer-1"] }];
  assert.throws(() => assessInterview(contradiction, undefined, answers, "answer-1"), /cannot contain.*contradictions/i);

  const blocked = readyProposal();
  blocked.blockers = ["A material decision remains"];
  assert.throws(() => assessInterview(blocked, undefined, answers, "answer-1"), /cannot contain.*blockers/i);

  const notReady = assessInterview(proposal(), undefined, answers, "answer-1");
  assert.throws(() => goalToken(notReady), /No current ready goal/);

  const current = assessInterview(readyProposal(), undefined, answers, "answer-1");
  assert.throws(() => confirmInterview(current, answers, "answer-1", goalToken(current), { researchHead: null, reviewPending: true }), /review.*pending/i);
});

test("typed contradictions persist alongside independent material-gap coverage", () => {
  const input = proposal();
  input.question = "Which evaluation mode resolves the offline and cloud-only conflict?";
  input.materialState.gaps[0] = {
    gapId: "evaluation-mode",
    status: "open",
    normalizedSummary: "offline delivery conflicts with cloud-only evaluation",
  };
  input.currentGapId = "delivery-conflict";
  input.readiness.materialGaps = [{
    id: "evaluation-mode",
    issue: "The conflicting evaluation mode remains unresolved.",
    evidenceIds: ["answer-1"],
    researchable: false,
  }];
  input.readiness.contradictions = [{
    id: "delivery-conflict",
    issue: "Offline delivery conflicts with cloud-only evaluation.",
    evidenceIds: ["answer-1"],
  }];

  const state = assessInterview(input, undefined, answers, "answer-1");
  assert.deepEqual(state.proposal.readiness.materialGaps, input.readiness.materialGaps);
  assert.deepEqual(state.proposal.readiness.contradictions, input.readiness.contradictions);
  assert.notEqual(state.proposal.readiness.materialGaps[0].id, state.proposal.readiness.contradictions[0].id);

  const recovered = recoverInterview([
    { type: "message", id: "answer-1", message: { role: "user", content: `<skill name="solar-interview">instructions</skill>\n${answers[0].text}` } },
    { type: "custom", customType: INTERVIEW_STATE, data: state },
  ]);
  assert.deepEqual(recovered.state.proposal.readiness, state.proposal.readiness);
  assert.deepEqual(recovered.state.proposal.readiness.materialGaps[0].evidenceIds, ["answer-1"]);
  assert.deepEqual(recovered.state.proposal.readiness.contradictions[0].evidenceIds, ["answer-1"]);

  const omittedCoverage = structuredClone(input);
  omittedCoverage.readiness.materialGaps = [];
  assert.throws(
    () => assessInterview(omittedCoverage, undefined, answers, "answer-1"),
    /Readiness omits current material gap evaluation-mode/,
  );

  const falselyReady = structuredClone(input);
  falselyReady.question = "";
  falselyReady.strategy = "ready";
  delete falselyReady.currentGapId;
  falselyReady.readiness.status = "ready";
  falselyReady.readiness.goalSentence = "Build an offline exercise evaluated only through a cloud service.";
  assert.throws(
    () => assessInterview(falselyReady, undefined, answers, "answer-1"),
    /Ready interviews cannot contain material gaps, contradictions, or blockers/,
  );
});

test("new answers and research invalidate a recovered goal without deleting it", () => {
  const state = assessInterview(readyProposal(), undefined, answers, "answer-1", { researchHead: "research-r1" });
  const start = { type: "message", id: "answer-1", message: { role: "user", content: "/skill:solar-interview My goal" } };
  const base = recoverInterview([
    start,
    { type: "custom", customType: INTERVIEW_STATE, data: state },
    { type: "custom", customType: "solar-workflow-state-v2", data: { researchArtifactRevision: "research-r1" } },
  ]);
  assert.equal(base.goalCurrent, true);

  const newAnswer = recoverInterview([
    start,
    { type: "custom", customType: INTERVIEW_STATE, data: state },
    { type: "message", id: "answer-2", message: { role: "user", content: "One correction." } },
  ], { researchHead: "research-r1" });
  assert.equal(newAnswer.goalCurrent, false);
  assert.match(newAnswer.invalidatedGoal.reason, /newer saved answer/i);
  assert.equal(newAnswer.state.goalRevision, state.goalRevision);

  const newResearch = recoverInterview([
    start,
    { type: "custom", customType: INTERVIEW_STATE, data: state },
    { type: "custom", customType: "solar-workflow-state-v2", data: { researchArtifactRevision: "research-r2" } },
  ]);
  assert.equal(newResearch.goalCurrent, false);
  assert.match(newResearch.invalidatedGoal.reason, /research/i);
});

test("invalid evidence and repeated assessment cannot fabricate progress", () => {
  const invalid = proposal();
  invalid.goal.evidence = ["invented-answer"];
  assert.throws(() => assessInterview(invalid, undefined, answers, "answer-1"), /evidence/);
  const state = assessInterview(proposal(), undefined, answers, "answer-1");
  assert.throws(() => assessInterview(proposal(), state, answers, "answer-1"), /already/);
});

test("reload retains original answers and a V2 assessment without rewriting the brief", () => {
  const start = { type: "message", id: "answer-1", message: { role: "user", content: '<skill name="solar-interview">old instructions</skill> My real goal' } };
  const state = assessInterview(proposal(), undefined, answers, "answer-1");
  const entries = [start, { type: "custom", customType: INTERVIEW_STATE, data: state }];
  const recovered = recoverInterview(entries);
  assert.equal(recovered.active, true);
  assert.equal(recovered.answers[0].text, "My real goal");
  assert.deepEqual(recovered.state, state);
  entries.push({ type: "message", id: "answer-2", message: { role: "user", content: "/skill:solar-plan plan only" } });
  assert.equal(recoverInterview(entries).active, false);
});

test("unsupported active state shapes preserve subsequent history and pause instead of migrating readiness", () => {
  const recovered = recoverInterview([
    { type: "message", id: "answer-1", message: { role: "user", content: "/skill:solar-interview Original intention" } },
    { type: "custom", customType: "solar-interview-state-v1", data: { version: 1, anchorId: "answer-1", answerId: "answer-1", status: "interviewing", proposal: { question: "Legacy question?" } } },
    { type: "message", id: "answer-2", message: { role: "user", content: "A saved correction after the old state." } },
  ]);
  assert.equal(recovered.active, false);
  assert.equal(recovered.state, undefined);
  assert.equal(recovered.answers.length, 2);
  assert.equal(recovered.answers[1].text, "A saved correction after the old state.");
  assert.equal(recovered.unsupportedState.version, 1);
  assert.match(recovered.pause.reason, /unsupported.*preserved/i);
  assert.deepEqual(recovered.pause.retainedAnswerIds, ["answer-1", "answer-2"]);
  assert.ok(recovered.pause.choices.some(choice => choice.id === "finish_early"));
});

test("legacy option answers retain the question and choices they answer", () => {
  const recovered = recoverInterview([
    { type: "message", id: "start", message: { role: "user", content: "/skill:solar-interview Clarify my intention" } },
    { type: "message", id: "question", message: { role: "assistant", content: "Choose A: independent reasoning; B: speed." } },
    { type: "message", id: "reply", message: { role: "user", content: "A" } },
  ]);
  assert.equal(recovered.answers[1].text, "A");
  assert.match(recovered.answers[1].question, /A: independent reasoning/);
});

test("a questionnaire cannot masquerade as one interview question", () => {
  for (const question of ["What subject? What age?", "1. Subject?\n2. Age?", "x".repeat(501)]) {
    assert.throws(() => assessInterview({ ...proposal(), question }, undefined, answers, "answer-1"), /ONE short question/);
  }
});

test("a new skill invocation starts a separate interview; resume retains the original", () => {
  const first = { type: "message", id: "old-start", message: { role: "user", content: "/skill:solar-interview First task" } };
  const old = { ...assessInterview(proposal(0.99), undefined, answers, "old-start"), status: "paused" };
  const entries = [first, { type: "custom", customType: INTERVIEW_STATE, data: old }];
  const resumed = recoverInterview([...entries, { type: "message", id: "resume", message: { role: "user", content: "/skill:solar-interview Resume the interview" } }]);
  assert.equal(resumed.anchorId, "old-start");
  assert.deepEqual(resumed.answers.map(answer => answer.id), ["old-start"]);
  const fresh = recoverInterview([...entries, { type: "message", id: "new-start", message: { role: "user", content: "/skill:solar-interview A different task" } }]);
  assert.equal(fresh.anchorId, "new-start");
  assert.equal(fresh.state, undefined);
  assert.deepEqual(fresh.answers.map(answer => answer.id), ["new-start"]);
});

test("reference formatting is normalized only when an existing ID is unambiguous", () => {
  const input = proposal();
  input.goal.evidence = ["User said this (answer answer-1)"];
  const state = assessInterview(input, undefined, answers, "answer-1");
  assert.deepEqual(state.proposal.goal.evidence, ["answer-1"]);
  assert.deepEqual(input.goal.evidence, ["User said this (answer answer-1)"]);
  input.goal.evidence = ["unknown-ID"];
  assert.throws(() => assessInterview(input, undefined, answers, "answer-1"), /Available IDs/);
});

test("evidence-backed deferred choices remain visible but do not create readiness", () => {
  const input = proposal(0.99);
  input.deferred = [{ topic: "Exact algorithm and citation format", evidence: ["answer-1"], reason: "The user explicitly assigned these choices to the later student project." }];
  const state = assessInterview(input, undefined, answers, "answer-1");
  assert.equal(state.ambiguity, 1);
  assert.equal(state.status, "interviewing");
  assert.deepEqual(state.proposal.deferred, input.deferred);
  assert.throws(() => assessInterview({ ...input, blockers: [input.deferred[0].topic] }, undefined, answers, "answer-1"), /both.*deferred.*blocker/i);
  assert.throws(() => assessInterview({ ...input, deferred: [{ ...input.deferred[0], evidence: ["unknown"] }] }, undefined, answers, "answer-1"), /deferred.*evidence/i);
});

test("a saved-answer report repair appends audit history but cannot claim information progress", () => {
  const first = assessInterview({ ...proposal(0.9), blockers: ["Algorithm choice"] }, undefined, answers, "answer-1");
  const input = { ...proposal(0.99), deferred: [{ topic: "Algorithm choice", evidence: ["answer-1"], reason: "Explicitly left to planning by the user." }] };
  assert.throws(() => assessInterview(input, first, answers, "answer-1"), /already/);
  const reviewed = assessInterview(input, first, answers, "answer-1", { reassess: true });
  assert.equal(reviewed.round, first.round);
  assert.equal(reviewed.answerHead, first.answerHead);
  assert.equal(reviewed.history.length, first.history.length + 1);
  assert.equal(reviewed.history.at(-1).action, "review");
  assert.equal(reviewed.history.at(-1).materialProgress, false);
  assert.equal(reviewed.assessmentKind, "review");
  assert.equal(first.ambiguity, 10);
  assert.equal(reviewed.delta, -9);
  assert.match(renderInterview(reviewed), /saved.answer review/i);
});

test("open issues remain visible and explicit early finish preserves them", () => {
  const state = assessInterview({ ...proposal(0.99), blockers: ["Offline-only goal conflicts with mandatory cloud execution"] }, undefined, answers, "answer-1");
  const closure = finishInterview(state, answers, "answer-1", "/solar-interview finish plan-only", false, { researchHead: null });
  assert.equal(state.ambiguity, 1);
  assert.equal(closure.mode, "early");
  assert.equal(closure.completionAuthority, "user_explicit_finish");
  assert.equal(closure.planningOnly, true);
  assert.deepEqual(closure.blockers, state.proposal.blockers);
  assert.deepEqual(closure.unresolved, state.proposal.readiness.materialGaps);
  assert.doesNotMatch(renderInterview(state), /<=5/);
  assert.match(renderInterview(state), /Offline-only goal/);
  assert.match(renderInterviewClosure(closure), /ended early/i);
  assert.match(renderInterviewClosure(closure), /cannot create execution authority/i);
});

test("a missing next question remains valid with high ambiguity and open issues", () => {
  for (const question of [undefined, null, ""]) {
    const state = assessInterview({ ...proposal(0.5), question, blockers: ["An issue left for planning"] }, undefined, answers, "answer-1");
    assert.equal(state.status, "awaiting_choice");
    assert.equal(state.ambiguity, 50);
    assert.match(renderInterview(state), /explicit early finish at any score/i);
  }
});

test("same-gap duplicate answers require a different strategy, then pause with retained work", () => {
  const first = assessInterview(proposal(0.5), undefined, answers, "answer-1", { artifactRefs: ["research.md#initial"] });
  const duplicate = { id: "answer-2", text: answers[0].text };
  const reframed = proposal(0.9, { strategy: "reframe", question: "Which single worked example would make the outcome observable?" });
  const second = assessInterview(reframed, first, [...answers, duplicate], "answer-1", { artifactRefs: ["research.md#initial"] });
  assert.equal(second.progress.progressed, false);
  assert.notEqual(second.delta, 0);
  assert.equal(second.recovery.status, "recovering");
  assert.equal(second.recovery.selectedStrategy, "reframe");

  const duplicateAgain = { id: "answer-3", text: answers[0].text };
  const research = proposal(0.5, { strategy: "research", question: "" });
  const paused = assessInterview(research, second, [...answers, duplicate, duplicateAgain], "answer-1", { artifactRefs: ["research.md#initial", "research.md#detour"] });
  assert.equal(paused.status, "paused");
  assert.equal(paused.recovery.status, "paused");
  assert.equal(paused.recovery.consecutiveNoProgress, 2);
  assert.deepEqual(paused.recovery.retained.answerIds, ["answer-1", "answer-2", "answer-3"]);
  assert.deepEqual(paused.recovery.retained.artifactRefs, ["research.md#initial", "research.md#detour"]);
  assert.equal(paused.recovery.gap.gapId, "observable");
  assert.ok(paused.recovery.choices.some(choice => choice.id === "finish_early"));
  assert.match(renderInterview(paused), /Paused without material-information progress/);
});

test("fresh topic IDs cannot turn repeated same-gap noninformation into progress", () => {
  const first = assessInterview(proposal(0.5), undefined, answers, "answer-1");
  const duplicate = { id: "answer-2", text: answers[0].text };
  const renamed = proposal(0.5, { strategy: "reframe", question: "Which observable result would distinguish success from failure?" });
  renamed.materialState.topics[0].topicId = "renamed-goal-2";
  const second = assessInterview(renamed, first, [...answers, duplicate], "answer-1");
  assert.equal(second.progress.progressed, false);
  assert.match(second.progress.ignored.join(" "), /fresh ID or provenance is not progress/i);
  assert.equal(second.recovery.status, "recovering");

  const duplicateAgain = { id: "answer-3", text: answers[0].text };
  const renamedAgain = proposal(0.5, { strategy: "research", question: "" });
  renamedAgain.materialState.topics[0].topicId = "renamed-goal-3";
  const paused = assessInterview(renamedAgain, second, [...answers, duplicate, duplicateAgain], "answer-1");
  assert.equal(paused.progress.progressed, false);
  assert.equal(paused.status, "paused");
  assert.equal(paused.recovery.consecutiveNoProgress, 2);
  assert.deepEqual(paused.recovery.attempts.slice(-2).map(attempt => attempt.progressed), [false, false]);
});

test("fresh answer IDs, score movement, prose, and duplicate source bytes are not material progress", () => {
  const before = openMaterial();
  const same = structuredClone(before);
  same.topics[0].sourceContentHashes = [interviewContentHash(answers[0].text)];
  assert.equal(classifyInterviewProgress(before, same, "observable").progressed, false);
  const reinterpretation = structuredClone(before);
  reinterpretation.topics[0].normalizedValue = "model prose claims a different decision";
  assert.equal(classifyInterviewProgress(before, reinterpretation, "observable").progressed, false);

  const duplicateClaim = structuredClone(before);
  duplicateClaim.claims = [{ gapId: "observable", normalizedClaim: "No method is known yet.", sourceContentHashes: [interviewContentHash(answers[0].text)] }];
  const rewordedClaim = structuredClone(duplicateClaim);
  rewordedClaim.claims.push({ gapId: "observable", normalizedClaim: "A differently worded unsupported claim.", sourceContentHashes: [interviewContentHash(answers[0].text)] });
  const classified = classifyInterviewProgress(duplicateClaim, rewordedClaim, "observable");
  assert.equal(classified.progressed, false);
  assert.match(classified.ignored.join(" "), /reuses source bytes/i);
});

test("identical short text can materially answer a different substantive topic", () => {
  const shortAnswers = [{ id: "answer-1", text: "I don't know." }];
  const hash = interviewContentHash("I don't know.");
  const firstProposal = proposal(0.5, {
    currentGapId: "rounding",
    question: "Which rounding policy should the output use?",
    materialState: {
      topics: [{ topicId: "rounding", kind: "decision", normalizedValue: "i don't know", sourceContentHashes: [hash] }],
      gaps: [{ gapId: "rounding", status: "open", normalizedSummary: "rounding policy remains unknown" }],
      claims: [],
    },
    readiness: {
      status: "not_ready",
      materialGaps: [{ id: "rounding", issue: "Rounding policy remains unknown.", evidenceIds: ["answer-1"], researchable: false }],
      contradictions: [],
    },
  });
  const first = assessInterview(firstProposal, undefined, shortAnswers, "answer-1");
  const secondProposal = proposal(0.5, {
    currentGapId: "error-output",
    question: "Which error-output policy should the command use?",
    materialState: {
      topics: [
        ...structuredClone(first.materialState.topics),
        { topicId: "error-output", kind: "decision", normalizedValue: "I DON'T KNOW.", sourceContentHashes: [hash] },
      ],
      gaps: [
        ...structuredClone(first.materialState.gaps),
        { gapId: "error-output", status: "open", normalizedSummary: "error output policy remains unknown" },
      ],
      claims: [],
    },
    readiness: {
      status: "not_ready",
      materialGaps: [
        { id: "rounding", issue: "Rounding policy remains unknown.", evidenceIds: ["answer-1"], researchable: false },
        { id: "error-output", issue: "Error output policy remains unknown.", evidenceIds: ["answer-1"], researchable: false },
      ],
      contradictions: [],
    },
  });
  const second = assessInterview(secondProposal, first, [...shortAnswers, { id: "answer-2", text: "I don't know." }], "answer-1");
  assert.equal(second.progress.progressed, true);
  assert.deepEqual(second.progress.reasons, [{ kind: "topic", topicId: "error-output", change: "new" }]);
});

test("a genuine correction at a flat score resets recovery", () => {
  const first = assessInterview(proposal(0.5), undefined, answers, "answer-1");
  const duplicate = { id: "answer-2", text: answers[0].text };
  const recovering = assessInterview(proposal(0.5, { strategy: "reframe", question: "Would a worked example or a rubric be observable?" }), first, [...answers, duplicate], "answer-1");
  assert.equal(recovering.recovery.status, "recovering");

  const correction = { id: "answer-3", text: "Correction: a worked example is required; a rubric is not." };
  const corrected = assessInterview(correctedProposal(0.5, correction), recovering, [...answers, duplicate, correction], "answer-1");
  assert.equal(corrected.ambiguity, recovering.ambiguity);
  assert.equal(corrected.progress.progressed, true);
  assert.equal(corrected.recovery.status, "clear");
  assert.equal(corrected.recovery.consecutiveNoProgress, 0);
});

test("duplicate research bytes do not reset recovery, while a new supported claim does", () => {
  const researchText = "Public evidence says a worked example can expose reasoning.";
  const researchHash = interviewContentHash(researchText);
  const initial = proposal(0.5);
  initial.materialState.claims = [{ gapId: "observable", normalizedClaim: "A worked example can expose reasoning.", sourceContentHashes: [researchHash] }];
  const first = assessInterview(initial, undefined, answers, "answer-1", { researchHead: "research-r1", researchContentHashes: [researchHash] });

  const duplicate = proposal(0.5, { strategy: "research", question: "" });
  duplicate.materialState.claims = structuredClone(initial.materialState.claims);
  const second = assessInterview(duplicate, first, answers, "answer-1", { researchHead: "research-r2", researchContentHashes: [researchHash] });
  assert.equal(second.assessmentKind, "research_return");
  assert.equal(second.progress.progressed, false);
  assert.equal(second.recovery.status, "recovering");

  const newText = "A concrete worked example can be compared against a stated reasoning trace.";
  const newHash = interviewContentHash(newText);
  const learned = correctedProposal(0.5, answers[0], "require a worked example and its reasoning trace");
  learned.materialState.claims = [
    ...structuredClone(initial.materialState.claims),
    { gapId: "observable", normalizedClaim: "A reasoning trace makes the worked example inspectable.", sourceContentHashes: [newHash] },
  ];
  const third = assessInterview(learned, second, answers, "answer-1", { researchHead: "research-r3", researchContentHashes: [researchHash, newHash] });
  assert.equal(third.progress.progressed, true);
  assert.equal(third.recovery.status, "clear");
});

test("user early closure preserves unassessed answers and cancels a pending review across restart", () => {
  const first = assessInterview(proposal(0.5), undefined, answers, "answer-1");
  const latestAnswers = [...answers, { id: "answer-2", text: "Correction: further details; the rest belongs to planning.", kind: "correction" }];
  const closure = finishInterview(first, latestAnswers, "answer-1", "/solar-interview finish", true, { researchHead: null });
  assert.equal(closure.mode, "early");
  assert.equal(closure.assessmentCurrent, false);
  assert.deepEqual(closure.answers, latestAnswers);
  assert.equal(closure.answers[1].kind, "correction");
  assert.deepEqual(closure.assessment, first);
  assert.equal(finishInterview(undefined, answers, "answer-1", "/solar-interview finish").assessment, null);
  const entries = [
    { type: "message", id: "answer-1", message: { role: "user", content: "/skill:solar-interview Start" } },
    { type: "custom", customType: INTERVIEW_STATE, data: first },
    { type: "custom", customType: INTERVIEW_REVIEW_STATE, data: { anchorId: "answer-1", answerHead: "answer-1", status: "pending" } },
    { type: "custom", customType: INTERVIEW_CLOSURE_STATE, data: closure },
  ];
  const recovered = recoverInterview(structuredClone(entries));
  assert.equal(recovered.active, false);
  assert.equal(recovered.reviewing, false);
  assert.equal(recovered.closure.assessmentCurrent, false);
  assert.equal(recovered.closure.mode, "early");
});

test("only direct finish actions match; sufficient, yes, planning phrases, quotations, and negation do not", () => {
  for (const message of [
    "/solar-interview finish",
    "/solar-interview finish plan-only",
    "Stop the interview.",
    "Please finish this interview now.",
    "Let's end the interview.",
    "인터뷰를 종료해 주세요.",
    "인터뷰를 끝내 주세요.",
  ]) assert.equal(isInterviewFinishRequest(message), true, message);
  for (const message of [
    "Yes",
    "That's enough",
    "Sufficient.",
    "I have provided sufficient details.",
    "Move on to planning.",
    "The plan should explain when to stop the interview.",
    "What if I say finish the interview?",
    "Do not stop the interview.",
    "The document says 'stop the interview'.",
    '"Finish the interview."',
    "충분합니다.",
    "계획으로 넘어가자.",
    "인터뷰를 종료하지 마세요.",
  ]) assert.equal(isInterviewFinishRequest(message), false, message);
  assert.throws(() => finishInterview(undefined, answers, "answer-1", "That's enough"), /explicit finish-interview action/i);
});

test("an unfinished saved-answer review survives restart and clears only on accepted review", () => {
  const first = assessInterview(proposal(0.99), undefined, answers, "answer-1");
  const entries = [
    { type: "message", id: "answer-1", message: { role: "user", content: "/skill:solar-interview Initial intention" } },
    { type: "custom", customType: INTERVIEW_STATE, data: first },
    { type: "custom", customType: INTERVIEW_REVIEW_STATE, data: { anchorId: "answer-1", answerHead: "answer-1", status: "pending" } },
  ];
  assert.equal(recoverInterview(structuredClone(entries)).reviewing, true);
  assert.equal(recoverInterview([...entries, { type: "custom", customType: INTERVIEW_STATE, data: { ...first, status: "paused" } }]).reviewing, true);
  const review = assessInterview(proposal(0.99), first, answers, "answer-1", { reassess: true });
  assert.equal(recoverInterview([...entries, { type: "custom", customType: INTERVIEW_STATE, data: review }]).reviewing, false);
  assert.equal(recoverInterview([...entries, { type: "message", id: "answer-2", message: { role: "user", content: "A new answer supersedes that review." } }]).reviewing, false);
});
