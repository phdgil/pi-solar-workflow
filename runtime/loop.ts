import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const LOOP_LIMITS = Object.freeze({ cycles: 5, detours: 12, turns: 200, reviewRevisions: 5, roleCalls: 16, roleRepairs: 4, repairs: 5 });
export const SNAPSHOT_STATE = "lite-output-snapshot-v1";
export const PLAN_REVIEW_CORRELATION_NOTICE = "Planner, Approach Reviewer, and Critic use separate tool-free Solar Pro4 Max contexts. They are correlated same-model review signals, not independent proof; command gates and explicit human qualitative acceptance retain authority.";
export const ROLE_ATTEMPT_TIMEOUT_MS = 180_000;
export const PROVENANCE_LIMITS = Object.freeze({ bundleBytes: 1_024 * 1024, sourceExcerptBytes: 128 * 1024 });
export const SOLAR_PRO4_CONTEXT_HINTS = Object.freeze({
  planner: {
    reasoningFramework: "Think step by step: (1) restate the goal in one sentence from the original request, (2) list each requirement with its provenance source, (3) for each requirement decide the concrete artifact it produces and the observable check that proves it, (4) order steps so each input exists before its consumer, (5) for every step name the exact tool, exact path or exact command, and the exact gate that verifies the output, (6) verify selfCheck covers every requirement and every produced artifact exactly once with no unresolved item left behind.",
    commonFailures: ["Requirements that appear in prose but have no producing step", "Steps that consume an artifact before any step produces it", "Capabilities that name a tool but no exact path or command", "Final artifacts with acceptance:none", "Gates whose check is a vague qualitative statement rather than an exact command or a named rubric", "selfCheck resolving to [] when requirements or produced artifacts exist"]
  },
  reviewer: {
    reasoningFramework: "Think step by step: (1) read the full current plan text and the ExecutionContractV3, not just selfCheck, (2) for each requirement confirm an actual step requires it and at least one of that step's gates verifies it, (3) for each artifact confirm exactly one producer and a reciprocal gate binding, (4) for each capability confirm an exact tool, path or command, and that it is used by a step, (5) check dependency ordering and cycles, (6) state the single strongest material defect with its exact plan location before any advisory note.",
    commonFailures: ["Accepting selfCheck as proof instead of inspecting the full contract", "Reporting coverage without an actual covering step and gate", "Duplicate or invented finding IDs across the two reviewers", "Vague requiredChange that does not name a concrete plan location"]
  },
  approach_reviewer: {
    reasoningFramework: "Think step by step: (1) read the full current plan text and the ExecutionContractV3, not just selfCheck, (2) for each requirement confirm an actual step requires it and at least one of that step's gates verifies it, (3) for each artifact confirm exactly one producer and a reciprocal gate binding, (4) for each capability confirm an exact tool, path or command, and that it is used by a step, (5) check dependency ordering and cycles, (6) state the single strongest material defect with its exact plan location before any advisory note.",
    commonFailures: ["Accepting selfCheck as proof instead of inspecting the full contract", "Reporting coverage without an actual covering step and gate", "Duplicate or invented finding IDs across the two reviewers", "Vague requiredChange that does not name a concrete plan location"]
  },
  critic: {
    reasoningFramework: "Think step by step: (1) read the full plan and contract, (2) check that every requirement traces to a bounded step and a verifiable gate, (3) check that the artifact table matches the prose goal and scope, (4) identify the largest scope, risk, verification, or acceptance gap, (5) for each gap state the exact plan location and a concrete required change, (6) distinguish material defects that block approval from advisory improvements.",
    commonFailures: ["Treating the plan as complete because it has many steps", "Missing an acceptance gap where a final artifact has no command or human gate", "Confusing a rubric with a command gate", "Reporting only advisory findings when a material defect exists"]
  },
  interviewer: {
    reasoningFramework: "Think step by step: (1) reread the original request and all saved answers, (2) separate what is decided, corrected, constrained, or successful from what is still open, (3) for each open item decide whether it is a user decision, a contradiction, or a factual gap, (4) if it is factual and the research head is stale, propose one targeted research detour with a named next question, (5) if the goal, constraints, and success evidence are explicit and no blocker remains, report ready with a one-sentence goal sentence, (6) never infer readiness from a score, a new ID, a URL, or repeated wording.",
    commonFailures: ["Treating a score increase as readiness", "Asking the user to re-answer a question the saved answer already resolves", "Reporting ready while a material gap, contradiction, or blocker remains", "Inventing a new answer head or research head instead of reusing the saved one", "Closing early with unresolved items still present"]
  },
  executor: {
    reasoningFramework: "Think step by step: (1) confirm the current step ID, its declared inputs, dependencies, capabilities, and gates, (2) perform only the bounded action the step describes using only the declared tool, path, or exact command, (3) verify the output artifact exists at its declared path before reporting, (4) describe the concrete observable change and the exact evidence file that supports it, (5) if a gate fails, choose a materially different approach and bind differsFrom to the prior failed approach ID, (6) never claim a gate passed or a step complete before the host gate record exists.",
    commonFailures: ["Acting on a stale or wrong step ID", "Using a tool, path, or command not declared in the current step's capabilities", "Reporting evidence that does not exist at the declared path", "Repeating the same failed approach under a new ID", "Claiming completion before the host commits the gate result"]
  }
});
export const SOLAR_PRO4_ROLE_PROMPT_SUFFIX = "Return only the requested JSON object. Do not add commentary, hedges, apologies, or alternative plans. If the current provenance is insufficient for a material decision, return the requested object with the honest limitation recorded in limitations and, for reviewers, the appropriate verdict.";

export type ArtifactDescriptor = {
  id: string;
  path: string;
  kind: "final" | "intermediate" | "evidence";
  acceptance: "command" | "human" | "none";
  gates: string[];
};

export type CapabilityContract = {
  id: string;
  kind: "read" | "write" | "command";
  tool: string;
  paths: string[];
  commands: string[];
};

export type RequirementContract = { id: string; description: string; source: string };
export type GateContract = {
  id: string;
  kind: "command" | "rubric";
  check: string;
  pass: string;
  evidence: string[];
};
export type StepContract = {
  id: string;
  title: string;
  feasibility: string;
  inputs: string[];
  outputs: string[];
  actions: string[];
  dependsOn: string[];
  requires: string[];
  gates: string[];
  capabilities: string[];
};
export type ExecutionContractV3 = {
  version: 3;
  domain: "software" | "research";
  requirements: RequirementContract[];
  artifacts: ArtifactDescriptor[];
  capabilities: CapabilityContract[];
  steps: StepContract[];
  gates: GateContract[];
  selfCheck: {
    review: string;
    requirementCoverage: Array<{ requirementId: string; stepIds: string[]; gateIds: string[]; explanation: string }>;
    artifactCoverage: Array<{ artifactId: string; stepId: string; gateIds: string[]; explanation: string }>;
    unresolved: string[];
  };
};

export type PlanningRole = "planner" | "approach_reviewer" | "critic";
export type ProvenanceItem = {
  kind: "requirement" | "answer" | "research" | "plan" | "finding" | "source_excerpt";
  source: string;
  sha256: string;
  selection: { whole: true } | { startLine: number; endLine: number };
  bytes: number;
  content: string;
  limitation?: string;
};
export type RoleContextBundle = { version: 1; items: ProvenanceItem[]; omitted: Array<{ source: string; reason: string }>; totalBytes: number; bundleRevision: string };
export type SolarRoleRequest = {
  workflowId: string;
  contextId: string;
  role: PlanningRole;
  inputRevision: string;
  planRevision?: string;
  repairOf?: string;
  systemPrompt: string;
  prompt: string;
  bundle: RoleContextBundle;
  signal?: AbortSignal;
};
export type SolarRoleReceipt = {
  contextId: string;
  role: PlanningRole;
  provider: "upstage";
  modelId: "solar-pro4";
  thinkingLevel: "max";
  inputRevision: string;
  planRevision?: string;
  outputRevision: string;
  attemptId: string;
  attemptOrdinal: number;
  repair: boolean;
  bundleRevision: string;
  policy: {
    sessionPersistence: "memory";
    tools: readonly [];
    customTools: readonly [];
    resourceDiscovery: { extensions: false; skills: false; promptTemplates: false; themes: false; contextFiles: false };
    compaction: "disabled";
    agentRetries: 0;
    providerRetries: 0;
    providerTimeoutMs: 180000;
    deadlineMs: 180000;
    attemptAccounting: "sdk_session_attempts";
  };
};

export type PlanFinding = {
  id: string;
  severity: "material" | "advisory";
  summary: string;
  requiredChange: string;
  planLocations: string[];
};
export type PlanReview = {
  version: 1;
  role: "approach_reviewer" | "critic";
  planRevision: string;
  domain: "software" | "research";
  verdict: "pass" | "revise" | "blocked";
  assessment: {
    focus: "software_architecture_feasibility" | "research_methodology_evidence_structure" | "whole_plan_scope_risk_verification_acceptance";
    analysis: string;
  };
  requirementCoverage: Array<{ requirementId: string; status: "covered" | "gap"; stepIds: string[]; gateIds: string[]; explanation: string }>;
  findings: PlanFinding[];
  limitations: string[];
};
export type FindingResolution = {
  version: 1;
  findingId: string;
  fromPlanRevision: string;
  toPlanRevision: string;
  status: "resolved" | "blocked";
  changedLocations: string[];
  explanation: string;
};

export type VerificationMode = { kind: "step"; stepId: string } | { kind: "final" };
export type DispatchExpectation = {
  workflowId: string;
  planRevision: string;
  approval: string;
  artifactTableRevision: string;
  mode: VerificationMode;
  gateId?: string;
};
export type DiskPlanSnapshot = { workspaceId: string; path: string; text: string; revision: string };
export type ExecutionOperation = { tool: string; access: "read" | "write" | "command"; path?: string; command?: string };
export type AuthoritySnapshot = { fresh: any; diskPlan: DiskPlanSnapshot };
export type GateAuthorityGuard = (expectation: DispatchExpectation) => AuthoritySnapshot | Promise<AuthoritySnapshot>;

export type EvidenceDescriptor = { artifactId?: string; path: string; hash: string; bytes: number; content?: string };
export type ArtifactManifest = {
  planRevision: string;
  artifactTableRevision: string;
  kinds: Array<"final" | "intermediate" | "evidence">;
  files: Array<{ artifactId: string; path: string; hash: string; bytes: number }>;
};
export type StepApproach = { id: string; description: string; differsFrom?: string };

export function digest(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalValue(child)]));
  return value;
}

function canonicalDigest(value: unknown) {
  return digest(JSON.stringify(canonicalValue(value)));
}

export function structuredRevision(value: unknown) {
  return canonicalDigest(value);
}

export function visibleOutputRevision(value: unknown, label = "visible role output") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Supply ${label}.`);
  if (Buffer.byteLength(value, "utf8") > 256 * 1024) throw new Error(`${label} exceeds its 262144-byte limit.`);
  return digest(value);
}

export function parseVisibleJson(value: unknown, label = "visible role output") {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Supply ${label}.`);
  const trimmed = value.trim();
  const fenced = /^```json\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be one JSON object, optionally wrapped in a single json fence.`);
  }
}

function words(value: unknown, label: string, maximum = 12_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Supply ${label}.`);
  if (Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label} exceeds its ${maximum}-byte limit.`);
  return value.trim();
}

function identifier(value: unknown, label: string) {
  const result = words(value, label, 80);
  if (value !== result) throw new Error(`${label} must not contain surrounding whitespace.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(result)) throw new Error(`Use a short stable identifier for ${label}.`);
  return result;
}

function list(value: unknown, label: string, allowEmpty = false, maximum = 80) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > maximum) throw new Error(`Supply ${label} as ${allowEmpty ? "an array" : "a nonempty array"} of at most ${maximum} items.`);
  const result = value.map(item => words(item, label));
  if (new Set(result).size !== result.length) throw new Error(`Remove duplicate ${label}.`);
  return result;
}

function identifierList(value: unknown, label: string, allowEmpty = false, maximum = 80) {
  return list(value, label, allowEmpty, maximum).map(item => identifier(item, label));
}

function records(value: unknown, label: string, maximum = 80) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) throw new Error(`Supply one to ${maximum} ${label}.`);
  const identifiers = new Set<string>();
  for (const item of value as any[]) {
    if (!item || typeof item !== "object") throw new Error(`Each ${label} must be an object.`);
    const id = identifier(item.id, `${label} ID`);
    if (identifiers.has(id)) throw new Error(`Duplicate ${label} ID: ${id}.`);
    identifiers.add(id);
  }
  return identifiers;
}

function revision(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a full lowercase SHA-256 digest.`);
  return value;
}

function exactObject(value: unknown, keys: string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) throw new Error(`${label} contains unsupported fields: ${extra.join(", ")}.`);
}

export function validateRoleContextBundle(value: unknown): RoleContextBundle {
  if (!value || typeof value !== "object" || (value as any).version !== 1) throw new Error("Role context must use RoleContextBundle version 1.");
  exactObject(value, ["version", "items", "omitted", "totalBytes", "bundleRevision"], "RoleContextBundle");
  const bundle = value as any;
  if (!Array.isArray(bundle.items) || !bundle.items.length || bundle.items.length > 160) throw new Error("Role context needs one to 160 provenance items.");
  const keys = new Set<string>();
  let totalBytes = 0;
  const items: ProvenanceItem[] = bundle.items.map((item: any) => {
    if (!item || !["requirement", "answer", "research", "plan", "finding", "source_excerpt"].includes(item.kind)) throw new Error("Provenance item kind is invalid.");
    exactObject(item, ["kind", "source", "sha256", "selection", "bytes", "content", "limitation"], "ProvenanceItem");
    const source = words(item.source, "the provenance source", 2_000);
    const content = typeof item.content === "string" ? item.content : (() => { throw new Error(`${source}: provenance content must be exact UTF-8 text.`); })();
    const bytes = Buffer.byteLength(content, "utf8");
    if (item.bytes !== bytes) throw new Error(`${source}: provenance byte count does not match its exact content.`);
    if (revision(item.sha256, `${source} provenance digest`) !== digest(content)) throw new Error(`${source}: provenance digest does not match its exact content.`);
    if (item.kind === "source_excerpt" && bytes > PROVENANCE_LIMITS.sourceExcerptBytes) throw new Error(`${source}: optional source excerpt exceeds ${PROVENANCE_LIMITS.sourceExcerptBytes} bytes.`);
    let selection: ProvenanceItem["selection"];
    if (item.selection?.whole === true && Object.keys(item.selection).length === 1) selection = { whole: true };
    else if (Number.isInteger(item.selection?.startLine) && Number.isInteger(item.selection?.endLine) && item.selection.startLine > 0 && item.selection.endLine >= item.selection.startLine && Object.keys(item.selection).length === 2) selection = { startLine: item.selection.startLine, endLine: item.selection.endLine };
    else throw new Error(`${source}: provenance selection must be whole or a valid inclusive line range.`);
    const key = JSON.stringify({ kind: item.kind, source, selection });
    if (keys.has(key)) throw new Error(`${source}: duplicate provenance selection.`);
    keys.add(key);
    totalBytes += bytes;
    return { kind: item.kind, source, sha256: item.sha256, selection, bytes, content, ...(item.limitation === undefined ? {} : { limitation: words(item.limitation, `${source} provenance limitation`, 4_000) }) };
  });
  if (!Array.isArray(bundle.omitted) || bundle.omitted.length > 160) throw new Error("Role context omitted items must be an array of at most 160 reasons.");
  const omitted = bundle.omitted.map((item: any) => {
    exactObject(item, ["source", "reason"], "provenance omission");
    return { source: words(item.source, "the omitted provenance source", 2_000), reason: words(item.reason, "why provenance was omitted", 4_000) };
  });
  if (bundle.totalBytes !== totalBytes) throw new Error("Role context totalBytes must equal the selected UTF-8 content bytes.");
  const bundleRevision = revision(bundle.bundleRevision, "role context bundle revision");
  const expectedRevision = canonicalDigest({ version: 1, items, omitted, totalBytes });
  if (bundleRevision !== expectedRevision) throw new Error("Role context bundle revision does not bind the selected items and omissions.");
  const result = { version: 1 as const, items, omitted, totalBytes, bundleRevision };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > PROVENANCE_LIMITS.bundleBytes) throw new Error(`Serialized role context exceeds ${PROVENANCE_LIMITS.bundleBytes} bytes; mandatory contracts must not be silently truncated.`);
  return result;
}

export function createRoleContextBundle(items: ProvenanceItem[], omitted: Array<{ source: string; reason: string }> = []): RoleContextBundle {
  const totalBytes = items.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0);
  const candidate = { version: 1 as const, items, omitted, totalBytes, bundleRevision: canonicalDigest({ version: 1, items, omitted, totalBytes }) };
  return validateRoleContextBundle(candidate);
}

export function validateSolarRoleRequest(value: unknown, expectedWorkflowId: string): SolarRoleRequest {
  if (!value || typeof value !== "object") throw new Error("Supply a complete SolarRoleRequest.");
  exactObject(value, ["workflowId", "contextId", "role", "inputRevision", "planRevision", "repairOf", "systemPrompt", "prompt", "bundle", "signal"], "SolarRoleRequest");
  const request = value as any;
  const workflowId = identifier(request.workflowId, "role-request workflow ID");
  if (workflowId !== expectedWorkflowId) throw new Error("Role request belongs to a different workflow.");
  const contextId = identifier(request.contextId, "role-request context ID");
  if (!["planner", "approach_reviewer", "critic"].includes(request.role)) throw new Error("Role request has an unknown planning role.");
  const bundle = validateRoleContextBundle(request.bundle);
  const inputRevision = revision(request.inputRevision, "role-request input revision");
  if (inputRevision !== bundle.bundleRevision) throw new Error("Role request inputRevision must bind the exact provenance bundle.");
  const planRevision = request.planRevision === undefined ? undefined : revision(request.planRevision, "role-request plan revision");
  const repairOf = request.repairOf === undefined ? undefined : identifier(request.repairOf, "role-request repaired attempt ID");
  if (request.signal?.aborted) throw new Error("Already-aborted role requests must be rejected before reserving or creating a session.");
  return {
    workflowId,
    contextId,
    role: request.role,
    inputRevision,
    ...(planRevision ? { planRevision } : {}),
    ...(repairOf ? { repairOf } : {}),
    systemPrompt: words(request.systemPrompt, "the isolated role system prompt", 64 * 1024),
    prompt: words(request.prompt, "the isolated role prompt", 64 * 1024),
    bundle,
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

export function canonicalPlanPath(value: unknown, label = "artifact path") {
  const candidate = words(value, label, 2_000);
  if (value !== candidate) throw new Error(`${label} must not contain surrounding whitespace.`);
  if (candidate.includes("\\") || candidate.includes(":")) throw new Error(`${label} must be a canonical workspace-relative path using forward slashes and no drive or ADS syntax.`);
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || candidate.startsWith("//")) throw new Error(`${label} must be workspace-relative.`);
  const segments = candidate.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment) || /[\u0000-\u001f<>"|?*]/.test(segment))) throw new Error(`${label} contains a noncanonical or Windows-unsafe segment.`);
  if ([".solar-workflow", ".gjc", ".git", ".pi"].includes(segments[0].toLocaleLowerCase("en-US"))) throw new Error(`${label} cannot target controller, GJC, repository-control, or Pi-private state.`);
  if (segments.some(segment => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))) throw new Error(`${label} contains a reserved Windows device name.`);
  if (path.posix.normalize(candidate) !== candidate) throw new Error(`${label} must already be normalized.`);
  return candidate;
}

export function artifactTableRevision(artifacts: ArtifactDescriptor[]) {
  if (!Array.isArray(artifacts)) throw new Error("Supply the artifact descriptor table.");
  const canonical = artifacts.map(artifact => ({
    id: identifier(artifact?.id, "artifact ID"),
    path: canonicalPlanPath(artifact?.path),
    kind: artifact?.kind,
    acceptance: artifact?.acceptance,
    gates: [...(artifact?.gates ?? [])].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
  return canonicalDigest(canonical);
}

function contractJson(text: string) {
  const section = text.split(/^## Execution contract\s*$/m)[1]?.split(/^## /m)[0];
  const json = /```json\s*\n([\s\S]*?)\n```/.exec(section ?? "")?.[1];
  if (!json) throw new Error("Add ## Execution contract with one fenced json ExecutionContractV3 object. Prose alone cannot drive reviewed execution.");
  try { return JSON.parse(json); } catch { throw new Error("ExecutionContractV3 must contain valid JSON."); }
}

function exactSet(actual: string[], expected: Iterable<string>) {
  return JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort());
}

export function validateExecutionPlan(text: string): ExecutionContractV3 {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 128 * 1024) throw new Error("Plan artifact must be UTF-8 text of at most 128 KiB.");
  const plan = contractJson(text) as any;
  exactObject(plan, ["version", "domain", "requirements", "artifacts", "capabilities", "steps", "gates", "selfCheck"], "ExecutionContractV3");
  if (plan?.version !== 3) throw new Error("Execution contract must use ExecutionContractV3 (version 3); obsolete plan formats have no execution authority.");
  if (!(plan.domain === "software" || plan.domain === "research")) throw new Error("ExecutionContractV3 domain must be software or research.");
  const requirements = records(plan.requirements, "requirements");
  const artifacts = records(plan.artifacts, "artifacts");
  const capabilities = records(plan.capabilities, "capabilities");
  const steps = records(plan.steps, "steps", 40);
  const gates = records(plan.gates, "gates");

  for (const requirement of plan.requirements) {
    exactObject(requirement, ["id", "description", "source"], `${requirement.id} requirement`);
    words(requirement.description, `${requirement.id} description`);
    words(requirement.source, `${requirement.id} source in the original request, saved answers, or research`);
  }

  const artifactPaths = new Set<string>();
  for (const artifact of plan.artifacts) {
    exactObject(artifact, ["id", "path", "kind", "acceptance", "gates"], `${artifact.id} artifact`);
    const canonical = canonicalPlanPath(artifact.path, `${artifact.id} path`);
    const folded = canonical.toLocaleLowerCase("en-US");
    if (artifactPaths.has(folded)) throw new Error(`${artifact.id}: artifact paths must be unique under Windows case-insensitive comparison.`);
    artifactPaths.add(folded);
    if (!["final", "intermediate", "evidence"].includes(artifact.kind)) throw new Error(`${artifact.id}: artifact kind must be final, intermediate, or evidence.`);
    if (!["command", "human", "none"].includes(artifact.acceptance)) throw new Error(`${artifact.id}: artifact acceptance must be command, human, or none.`);
    identifierList(artifact.gates, `${artifact.id} gate bindings`, artifact.kind !== "final");
    if (artifact.kind === "final" && artifact.acceptance === "none") throw new Error(`${artifact.id}: every final artifact needs command or human acceptance.`);
  }

  const capabilityById = new Map<string, CapabilityContract>();
  for (const capability of plan.capabilities) {
    exactObject(capability, ["id", "kind", "tool", "paths", "commands"], `${capability.id} capability`);
    if (!["read", "write", "command"].includes(capability.kind)) throw new Error(`${capability.id}: capability kind must be read, write, or command.`);
    const tool = words(capability.tool, `${capability.id} exact tool name`, 100);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(tool)) throw new Error(`${capability.id}: tool must be one exact host tool name.`);
    const paths = list(capability.paths, `${capability.id} paths`, capability.kind === "command").map(item => canonicalPlanPath(item, `${capability.id} path`));
    const commands = list(capability.commands, `${capability.id} exact commands`, capability.kind !== "command", 20);
    if (capability.kind !== "command" && commands.length) throw new Error(`${capability.id}: read/write capabilities cannot declare shell commands.`);
    if (capability.kind === "command" && !commands.length) throw new Error(`${capability.id}: command capabilities need at least one exact command.`);
    capabilityById.set(capability.id, { ...capability, kind: capability.kind, tool, paths, commands });
  }

  const gateById = new Map<string, GateContract>();
  for (const gate of plan.gates) {
    exactObject(gate, ["id", "kind", "check", "pass", "evidence"], `${gate.id} gate`);
    if (!(["command", "rubric"] as const).includes(gate.kind)) throw new Error(`${gate.id}: gate kind must be command or rubric.`);
    words(gate.check, `${gate.id} exact ${gate.kind === "command" ? "command" : "qualitative rubric"}`);
    words(gate.pass, `${gate.id} observable passing condition`);
    const evidence = identifierList(gate.evidence, `${gate.id} evidence artifact IDs`);
    if (evidence.some(id => !artifacts.has(id))) throw new Error(`${gate.id}: every evidence reference must name an artifact descriptor.`);
    gateById.set(gate.id, gate);
  }

  const artifactById = new Map<string, ArtifactDescriptor>(plan.artifacts.map((artifact: ArtifactDescriptor) => [artifact.id, artifact]));
  for (const artifact of plan.artifacts) {
    if (artifact.gates.some((id: string) => !gates.has(id))) throw new Error(`${artifact.id}: unknown gate binding.`);
    for (const gateId of artifact.gates) if (!gateById.get(gateId)?.evidence.includes(artifact.id)) throw new Error(`${artifact.id}: gate ${gateId} must list the artifact as evidence too.`);
    for (const gate of plan.gates) if (gate.evidence.includes(artifact.id) && !artifact.gates.includes(gate.id)) throw new Error(`${artifact.id}: descriptor and gate evidence bindings must be reciprocal.`);
    if (artifact.acceptance === "command" && !artifact.gates.some((id: string) => gateById.get(id)?.kind === "command")) throw new Error(`${artifact.id}: command acceptance needs a bound command gate.`);
    if (artifact.acceptance === "human" && !artifact.gates.some((id: string) => gateById.get(id)?.kind === "rubric")) throw new Error(`${artifact.id}: human acceptance needs a bound qualitative rubric.`);
  }

  const preceding = new Set<string>();
  const ancestors = new Map<string, Set<string>>();
  const producers = new Map<string, string>();
  const coveredRequirements = new Set<string>();
  const usedGates = new Set<string>();
  const usedCapabilities = new Set<string>();
  for (const step of plan.steps) {
    exactObject(step, ["id", "title", "feasibility", "inputs", "outputs", "actions", "dependsOn", "requires", "gates", "capabilities"], `${step.id} step`);
    for (const field of ["title", "feasibility"]) words(step[field], `${step.id} ${field}`);
    list(step.actions, `${step.id} actions`);
    const inputs = identifierList(step.inputs, `${step.id} input artifact IDs`, true);
    const outputs = identifierList(step.outputs, `${step.id} output artifact IDs`);
    const dependencies = identifierList(step.dependsOn, `${step.id} dependencies`, true);
    const required = identifierList(step.requires, `${step.id} requirement references`);
    const stepGates = identifierList(step.gates, `${step.id} gate references`);
    const stepCapabilities = identifierList(step.capabilities, `${step.id} capability references`);
    if (dependencies.some(id => !preceding.has(id))) throw new Error(`${step.id}: dependencies must refer to earlier steps, without cycles.`);
    if (inputs.some(id => !artifacts.has(id))) throw new Error(`${step.id}: unknown input artifact reference.`);
    if (outputs.some(id => !artifacts.has(id))) throw new Error(`${step.id}: unknown output artifact reference.`);
    if (required.some(id => !requirements.has(id))) throw new Error(`${step.id}: unknown requirement reference.`);
    if (stepGates.some(id => !gates.has(id))) throw new Error(`${step.id}: unknown gate reference.`);
    if (stepCapabilities.some(id => !capabilities.has(id))) throw new Error(`${step.id}: unknown capability reference.`);

    const inherited = new Set<string>();
    for (const dependency of dependencies) {
      inherited.add(dependency);
      for (const ancestor of ancestors.get(dependency) ?? []) inherited.add(ancestor);
    }
    ancestors.set(step.id, inherited);
    for (const input of inputs) {
      const producer = producers.get(input);
      if (producer && !inherited.has(producer)) throw new Error(`${step.id}: input ${input} is produced by ${producer}; declare a dependency path to it.`);
    }
    for (const output of outputs) {
      if (producers.has(output)) throw new Error(`${output}: artifacts may have only one producing step.`);
      producers.set(output, step.id);
      const descriptorPath = artifactById.get(output)!.path;
      const writable = stepCapabilities.map(id => capabilityById.get(id)!).some(capability => (capability.kind === "write" || capability.kind === "command") && capability.paths.includes(descriptorPath));
      if (!writable) throw new Error(`${step.id}: output ${output} needs an exact write/command capability for ${descriptorPath}.`);
    }
    for (const input of inputs) {
      const descriptorPath = artifactById.get(input)!.path;
      const readable = stepCapabilities.map(id => capabilityById.get(id)!).some(capability => capability.paths.includes(descriptorPath));
      if (!readable) throw new Error(`${step.id}: input ${input} needs an exact declared capability for ${descriptorPath}.`);
    }
    for (const gateId of stepGates) for (const evidenceId of gateById.get(gateId)!.evidence) {
      const descriptor = artifactById.get(evidenceId)!;
      if (descriptor.kind !== "evidence" && !producers.has(evidenceId)) throw new Error(`${step.id}: gate ${gateId} depends on ${evidenceId} before its producing step.`);
    }
    required.forEach(id => coveredRequirements.add(id));
    stepGates.forEach(id => usedGates.add(id));
    stepCapabilities.forEach(id => usedCapabilities.add(id));
    preceding.add(step.id);
  }
  if ([...requirements].some(id => !coveredRequirements.has(id))) throw new Error("Every requirement needs a bounded executable step.");
  if ([...gates].some(id => !usedGates.has(id))) throw new Error("Every command/rubric gate must be assigned to a step.");
  if ([...capabilities].some(id => !usedCapabilities.has(id))) throw new Error("Remove unused capabilities or bind them to the exact step that needs them.");
  for (const artifact of plan.artifacts) if (artifact.kind !== "evidence" && !producers.has(artifact.id)) throw new Error(`${artifact.id}: final/intermediate artifacts need exactly one producing step.`);

  const selfCheck = plan.selfCheck;
  exactObject(selfCheck, ["review", "requirementCoverage", "artifactCoverage", "unresolved"], "plan selfCheck");
  words(selfCheck?.review, "the plan self-check of scope, ordering, feasibility, risk, and acceptance");
  const unresolved = list(selfCheck?.unresolved, "self-check unresolved items", true);
  if (unresolved.length) throw new Error(`Resolve or explicitly return unresolved plan items before review: ${unresolved.join("; ")}`);
  if (!Array.isArray(selfCheck?.requirementCoverage) || selfCheck.requirementCoverage.length !== requirements.size) throw new Error("Self-check requirementCoverage must contain every requirement exactly once.");
  const selfRequirements = new Set<string>();
  for (const coverage of selfCheck.requirementCoverage) {
    exactObject(coverage, ["requirementId", "stepIds", "gateIds", "explanation"], "self-check requirement coverage");
    const requirementId = identifier(coverage?.requirementId, "self-check requirement ID");
    if (!requirements.has(requirementId) || selfRequirements.has(requirementId)) throw new Error("Self-check requirementCoverage has an unknown or duplicate requirement.");
    selfRequirements.add(requirementId);
    const stepIds = identifierList(coverage.stepIds, `${requirementId} self-check steps`);
    const gateIds = identifierList(coverage.gateIds, `${requirementId} self-check gates`);
    if (stepIds.some(id => !steps.has(id)) || gateIds.some(id => !gates.has(id))) throw new Error(`${requirementId}: self-check coverage has an unknown step or gate.`);
    const coveringSteps = stepIds.map(id => plan.steps.find((step: StepContract) => step.id === id)!).filter(step => step.requires.includes(requirementId));
    if (!coveringSteps.length || !gateIds.some(id => coveringSteps.some(step => step.gates.includes(id)))) throw new Error(`${requirementId}: self-check must cite an actual covering step and one of that step's gates.`);
    words(coverage.explanation, `${requirementId} coverage explanation`);
  }
  const producedArtifacts = plan.artifacts.filter((artifact: ArtifactDescriptor) => producers.has(artifact.id));
  if (!Array.isArray(selfCheck?.artifactCoverage) || selfCheck.artifactCoverage.length !== producedArtifacts.length) throw new Error("Self-check artifactCoverage must contain every produced artifact exactly once.");
  const selfArtifacts = new Set<string>();
  for (const coverage of selfCheck.artifactCoverage) {
    exactObject(coverage, ["artifactId", "stepId", "gateIds", "explanation"], "self-check artifact coverage");
    const artifactId = identifier(coverage?.artifactId, "self-check artifact ID");
    if (!producers.has(artifactId) || selfArtifacts.has(artifactId)) throw new Error("Self-check artifactCoverage has an unproduced, unknown, or duplicate artifact.");
    selfArtifacts.add(artifactId);
    const stepId = identifier(coverage.stepId, `${artifactId} producing step`);
    const gateIds = identifierList(coverage.gateIds, `${artifactId} acceptance gates`);
    if (producers.get(artifactId) !== stepId || !exactSet(gateIds, artifactById.get(artifactId)!.gates)) throw new Error(`${artifactId}: self-check must bind the actual producer and exact descriptor gates.`);
    words(coverage.explanation, `${artifactId} coverage explanation`);
  }
  return plan as ExecutionContractV3;
}

export function evidenceFile(cwd: string, filename: string, snapshot = false): EvidenceDescriptor {
  const root = realpathSync(cwd);
  const resolved = realpathSync(path.resolve(root, filename));
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Evidence must be a file inside the workflow workspace.");
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Evidence must be a regular file of at most 16 MiB; declare the actual bounded final/evidence artifact instead of a static progress report.");
  const data = readFileSync(resolved);
  return { path: relative.replaceAll("\\", "/"), hash: createHash("sha256").update(data).digest("hex"), ...(snapshot && data.length <= 128 * 1024 ? { content: data.toString("base64") } : {}), bytes: data.length };
}

export function initializeLoop(workflow: any) {
  if (workflow?.version !== undefined && workflow.version !== 3) throw new Error(`Workflow state version ${String(workflow.version)} is unsupported; preserve artifacts and start a reviewed version 3 workflow.`);
  if (typeof workflow?.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(workflow.id)) throw new Error("Workflow state needs a safe stable ID.");
  const requested = workflow?.limits ?? {};
  const limits = { ...LOOP_LIMITS, cycles: requested.cycles ?? LOOP_LIMITS.cycles, detours: requested.detours ?? LOOP_LIMITS.detours, turns: requested.turns ?? LOOP_LIMITS.turns };
  for (const [key, value] of Object.entries({ cycles: limits.cycles, detours: limits.detours, turns: limits.turns })) if (!Number.isInteger(value) || value < 1) throw new Error(`${key} limit must be a positive integer.`);
  const budgets = { reviewRevisions: 0, roleCalls: 0, roleRepairs: 0, ...(workflow?.budgets ?? {}) };
  for (const [key, value] of Object.entries({ reviewRevisions: budgets.reviewRevisions, roleCalls: budgets.roleCalls, roleRepairs: budgets.roleRepairs })) if (!Number.isInteger(value) || value < 0) throw new Error(`${key} budget usage must be a nonnegative integer.`);
  return {
    ...workflow,
    version: 3,
    cycle: workflow?.cycle ?? 1,
    detours: workflow?.detours ?? [],
    returns: workflow?.returns ?? [],
    turns: workflow?.turns ?? 0,
    limits,
    budgets,
    results: workflow?.results ?? {},
    attempts: workflow?.attempts ?? {},
  };
}

function normalizedEvidence(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\b\d{4}-\d\d-\d\d[t ][0-9:.+-]+z?\b/gi, "<time>").replace(/[a-f0-9]{64}/g, "<digest>").replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>").replace(/\b(?:attempt|request|receipt|run)[-_ ]?(?:id)?\s*[:#=]?\s*[a-z0-9_-]+/gi, "<attempt>").replace(/\b(?:score|confidence)\s*[:=]?\s*-?\d+(?:\.\d+)?%?/gi, "<score>").replace(/\s+/g, " ").trim();
}

export function revisitWorkflow(workflow: any, input: { stage: "research" | "interview" | "plan"; gap: string; evidence: string; gapId?: string; answerHeadId?: string; evidenceDigest?: string }) {
  const current = initializeLoop(workflow);
  const allowed: Record<string, string[]> = { interview: ["research"], plan: ["research", "interview"], execute: ["research", "interview", "plan"] };
  if (current.status !== "active" || !allowed[current.stage]?.includes(input.stage)) throw new Error("Revisit research from interview, research/interview from plan, or research/interview/plan from execution. Finish the current detour before nesting another.");
  if (current.detours.some((item: any) => !item.outcome)) throw new Error("Finish the current detour and record its material outcome before opening another.");
  const gap = words(input.gap, "one consequential gap, not a request to restart everything", 4_000);
  const triggerEvidence = words(input.evidence, "evidence explaining why saved answers/research cannot resolve this gap", 12_000);
  let gapId: string | undefined;
  let answerHeadId: string | undefined;
  let startEvidenceDigest: string | undefined;
  if (input.stage === "research") {
    gapId = identifier(input.gapId, "the active material gap ID");
    answerHeadId = identifier(input.answerHeadId, "the current saved answer-head ID");
    startEvidenceDigest = revision(input.evidenceDigest, "the starting material-evidence digest");
  }
  const materialSignature = canonicalDigest({ target: input.stage, gap: normalizedEvidence(gap), evidence: normalizedEvidence(triggerEvidence), startEvidenceDigest: startEvidenceDigest ?? null });
  const stalled = current.detours.some((item: any) => item.materialSignature === materialSignature && item.checkpoint === (current.checkpoint ?? 0));
  const cycle = current.cycle + (current.stage === "execute" ? 1 : 0);
  if (stalled || current.detours.length >= current.limits.detours || cycle > current.limits.cycles) {
    const kind = stalled ? "stalled" : cycle > current.limits.cycles ? "cycles" : "detours";
    return {
      ...current,
      stage: current.stage === "execute" ? "plan" : current.stage,
      status: "limited",
      cycle,
      gap,
      approval: undefined,
      approvalArtifactTableRevision: undefined,
      finalReview: undefined,
      pendingHandoff: false,
      limitStop: { kind, bound: current.limits[kind] },
      reason: stalled ? "Repeated gap without new material evidence or verified progress. New IDs, hashes, scores, or duplicate prose cannot resume it; provide a changed decision/diagnostic/evidence outcome." : "Workflow cycle/detour limit reached; artifacts, diagnostics, and best observed work remain saved.",
    };
  }
  const returnTo = current.stage === "execute" ? "plan" : current.stage;
  const returns = input.stage === "plan" ? [] : [...current.returns, { stage: returnTo, gap, gapId, answerHeadId }];
  const detour = {
    id: `detour-${digest(`${current.id}:${current.detours.length}:${materialSignature}`).slice(0, 16)}`,
    from: current.stage,
    target: input.stage,
    gap,
    gapId,
    triggerEvidence,
    answerHeadId,
    startEvidenceDigest,
    materialSignature,
    checkpoint: current.checkpoint ?? 0,
  };
  return {
    ...current,
    stage: input.stage,
    status: "active",
    cycle,
    gap,
    returns,
    ...(input.stage === "research" ? { researchPass: (current.researchPass ?? 0) + 1 } : {}),
    approval: undefined,
    approvalArtifactTableRevision: undefined,
    finalReview: undefined,
    finalManifest: undefined,
    acceptanceManifest: undefined,
    detours: [...current.detours, detour],
    pendingHandoff: true,
    reminder: 0,
  };
}

export function resumeLoop(workflow: any) {
  const current = initializeLoop(workflow);
  const stop = current.limitStop;
  if (stop?.kind === "stalled" || stop?.kind === "no_relevant_progress") throw new Error("A no-progress recovery needs materially changed evidence, a new user decision, or a revised plan; IDs-only resume is disabled.");
  if (stop?.kind === "repairs") throw new Error("The fixed repair budget is exhausted; preserve best artifacts and revise the reviewed plan or obtain a user decision.");
  if (stop && current.limits[stop.kind] <= stop.bound) throw new Error(`Raise the exhausted ${stop.kind} limit before resuming.`);
  if (current.turns >= current.limits.turns || current.cycle > current.limits.cycles) throw new Error("Raise exhausted workflow limits before resuming.");
  return { ...current, status: "active", limitStop: undefined, pendingHandoff: true, reminder: 0, reason: undefined };
}

export function completeWorkflowDetour(workflow: any, input: { target: "research" | "interview" | "plan"; outcome: "ready" | "narrowed" | "blocked" | "answered" | "revised"; endEvidenceDigest: string }) {
  const current = initializeLoop(workflow);
  const allowed = { research: ["ready", "narrowed", "blocked"], interview: ["answered", "blocked"], plan: ["revised", "blocked"] };
  const outcomes = input ? allowed[input.target] : undefined;
  if (!outcomes?.includes(input.outcome)) throw new Error("Detour outcome does not match its research/interview/plan target.");
  const index = current.detours.findLastIndex((item: any) => item.target === input.target && !item.outcome);
  if (index < 0) throw new Error(`No open ${input.target} detour accepts an outcome.`);
  const endEvidenceDigest = revision(input.endEvidenceDigest, "detour ending material-evidence digest");
  const detours = [...current.detours];
  detours[index] = { ...detours[index], outcome: input.outcome, endEvidenceDigest };
  return { ...current, detours };
}

export function researchReady(workflow: any, artifact: any, submission: { contract: any; contractRevision: string; materialDigest: string }) {
  const current = initializeLoop(workflow);
  if (current.stage !== "research" || current.status !== "active") throw new Error("No active research boundary accepts this submission.");
  if (submission?.contract?.version !== 2 || !["initial", "detour"].includes(submission.contract.mode) || !["ready", "narrowed", "blocked"].includes(submission.contract.outcome)) throw new Error("Only a validated ResearchContractV2 submission can complete research.");
  if (revision(submission.contractRevision, "research contract revision") !== structuredRevision(submission.contract) || revision(submission.materialDigest, "research material digest") !== submission.materialDigest) throw new Error("Research submission revisions do not bind its validated contract/material state.");
  const expectedRelativePath = `.solar-workflow/${current.id}/research.md`;
  const expectedPath = path.resolve(current.cwd, ...expectedRelativePath.split("/"));
  const actualPath = typeof artifact?.path === "string" ? path.resolve(artifact.path) : "";
  const fold = (value: string) => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  if (artifact?.relativePath !== expectedRelativePath || fold(actualPath) !== fold(expectedPath)) throw new Error("Only the controller-reserved per-workflow research.md artifact can complete research.");
  if (!artifact?.revision || digest(artifact.text) !== artifact.revision) throw new Error("Persist and immediately re-read the controller-owned research artifact before advancing.");
  const detours = [...current.detours];
  const openIndex = detours.findLastIndex((item: any) => item.target === "research" && !item.outcome);
  if ((openIndex >= 0) !== (submission.contract.mode === "detour")) throw new Error("Research submission mode does not match the current initial/detour lineage.");
  if (submission.contract.mode === "detour") {
    if (openIndex < 0) throw new Error("No matching research detour remains open.");
    detours[openIndex] = { ...detours[openIndex], outcome: submission.contract.outcome, endEvidenceDigest: submission.materialDigest };
  }
  const research = { ...artifact, contract: submission.contract, materialDigest: submission.materialDigest };
  const researchHistory = [...(current.researchHistory ?? []), research];
  if (submission.contract.outcome === "blocked") return { ...current, research, researchHistory, detours, status: "paused", reason: `Research is blocked: ${submission.contract.remainingGap}. Evidence and limitations are preserved; choose narrower research, provide evidence, or explicitly close early.`, pendingHandoff: false, reminder: 0 };
  if (!current.autoInterview && submission.contract.mode === "initial") return { ...current, research, researchHistory, detours, status: "research_complete", reason: "ResearchContractV2 was validated and persisted. Research-only authority ends here.", pendingHandoff: false, reminder: 0 };
  const frames = [...current.returns];
  const next = frames.pop()?.stage ?? "interview";
  return { ...current, stage: next, returns: frames, research, researchHistory, detours, pendingHandoff: true, reminder: 0 };
}

export function validateRoleReceipt(value: unknown, expected: { workflowId: string; role: PlanningRole; inputRevision: string; planRevision?: string; outputRevision?: string }): SolarRoleReceipt {
  if (!value || typeof value !== "object") throw new Error("Supply a SolarRoleReceipt for the isolated role attempt.");
  exactObject(value, ["contextId", "role", "provider", "modelId", "thinkingLevel", "inputRevision", "planRevision", "outputRevision", "attemptId", "attemptOrdinal", "repair", "bundleRevision", "policy"], "SolarRoleReceipt");
  const receipt = value as any;
  const contextId = identifier(receipt.contextId, "role context ID");
  const attemptId = identifier(receipt.attemptId, "role attempt ID");
  if (!["planner", "approach_reviewer", "critic"].includes(receipt.role) || receipt.role !== expected.role) throw new Error("Role receipt does not match the requested planning role.");
  if (receipt.provider !== "upstage" || receipt.modelId !== "solar-pro4" || receipt.thinkingLevel !== "max") throw new Error("Role receipt must prove explicit Upstage solar-pro4 with thinkingLevel max; no fallback has authority.");
  const inputRevision = revision(receipt.inputRevision, "role input revision");
  if (inputRevision !== expected.inputRevision) throw new Error("Role receipt is stale for the current input revision.");
  const planRevision = receipt.planRevision === undefined ? undefined : revision(receipt.planRevision, "role plan revision");
  if (expected.planRevision !== undefined && planRevision !== expected.planRevision) throw new Error("Role receipt is stale for the current plan revision.");
  const outputRevision = revision(receipt.outputRevision, "role output revision");
  if (expected.outputRevision !== undefined && outputRevision !== expected.outputRevision) throw new Error("Role output receipt does not bind the submitted artifact/response bytes.");
  if (!Number.isInteger(receipt.attemptOrdinal) || receipt.attemptOrdinal < 1 || typeof receipt.repair !== "boolean") throw new Error("Role receipt needs a positive session-attempt ordinal and explicit repair flag.");
  const bundleRevision = revision(receipt.bundleRevision, "role receipt bundle revision");
  if (bundleRevision !== inputRevision) throw new Error("Role receipt bundle revision must equal the exact request input revision.");
  const policy = receipt.policy;
  exactObject(policy, ["sessionPersistence", "tools", "customTools", "resourceDiscovery", "compaction", "agentRetries", "providerRetries", "providerTimeoutMs", "deadlineMs", "attemptAccounting"], "SolarRoleReceipt policy");
  exactObject(policy.resourceDiscovery, ["extensions", "skills", "promptTemplates", "themes", "contextFiles"], "SolarRoleReceipt resource discovery policy");
  if (!policy || policy.sessionPersistence !== "memory" || !Array.isArray(policy.tools) || policy.tools.length || !Array.isArray(policy.customTools) || policy.customTools.length || policy.resourceDiscovery?.extensions !== false || policy.resourceDiscovery?.skills !== false || policy.resourceDiscovery?.promptTemplates !== false || policy.resourceDiscovery?.themes !== false || policy.resourceDiscovery?.contextFiles !== false || policy.compaction !== "disabled" || policy.agentRetries !== 0 || policy.providerRetries !== 0 || policy.providerTimeoutMs !== ROLE_ATTEMPT_TIMEOUT_MS || policy.deadlineMs !== ROLE_ATTEMPT_TIMEOUT_MS || policy.attemptAccounting !== "sdk_session_attempts") throw new Error("Role receipt must record the verified nonpersistent, tool-free, discovery-disabled, no-retry 180000 ms policy.");
  return { contextId, role: receipt.role, provider: "upstage", modelId: "solar-pro4", thinkingLevel: "max", inputRevision, ...(planRevision ? { planRevision } : {}), outputRevision, attemptId, attemptOrdinal: receipt.attemptOrdinal, repair: receipt.repair, bundleRevision, policy };
}

export function reserveRoleAttempt(workflow: any, attempt: { attemptId: string; contextId: string; role: PlanningRole; inputRevision: string; planRevision?: string; repair: boolean; repairOf?: string; startedAt: number; deadlineAt: number }) {
  const current = initializeLoop(workflow);
  if (current.stage !== "plan" || !["active", "reviewing_plan", "revision_required"].includes(current.status)) throw new Error("Solar planning roles may be reserved only for the current active/reviewing plan stage.");
  const attemptId = identifier(attempt?.attemptId, "role attempt ID");
  const contextId = identifier(attempt?.contextId, "role context ID");
  if (!["planner", "approach_reviewer", "critic"].includes(attempt?.role)) throw new Error("Unknown planning role.");
  revision(attempt.inputRevision, "role-attempt input revision");
  if (attempt.planRevision !== undefined) revision(attempt.planRevision, "role-attempt plan revision");
  if (typeof attempt.repair !== "boolean") throw new Error("Role attempt must declare whether it is a repair.");
  if (attempt.repair) {
    const repairOf = identifier(attempt.repairOf, "the repaired attempt ID");
    const prior = (current.roleAttempts ?? []).find((item: any) => item.attemptId === repairOf);
    if (!prior || prior.status === "pending" || prior.role !== attempt.role) throw new Error("A repair must bind a settled failed/stale attempt for the same role.");
  }
  else if (attempt.repairOf !== undefined) throw new Error("Only a repair attempt may bind repairOf.");
  if (!Number.isInteger(attempt.startedAt) || !Number.isInteger(attempt.deadlineAt) || attempt.deadlineAt - attempt.startedAt !== ROLE_ATTEMPT_TIMEOUT_MS) throw new Error(`Role attempt needs one ${ROLE_ATTEMPT_TIMEOUT_MS} ms creation-plus-prompt deadline.`);
  if ((current.roleAttempts ?? []).some((item: any) => item.attemptId === attemptId || item.contextId === contextId)) throw new Error("Role attempt and context IDs must be unique.");
  if (current.budgets.roleCalls >= current.limits.roleCalls) throw new Error(`Solar role session-attempt budget exhausted (${current.limits.roleCalls}); preserve current plan/reviews and pause before creating another session.`);
  if (attempt.repair && current.budgets.roleRepairs >= current.limits.roleRepairs) throw new Error(`Solar role repair budget exhausted (${current.limits.roleRepairs}); preserve the invalid output and pause before creating another session.`);
  return {
    ...current,
    budgets: { ...current.budgets, roleCalls: current.budgets.roleCalls + 1, roleRepairs: current.budgets.roleRepairs + (attempt.repair ? 1 : 0) },
    roleAttempts: [...(current.roleAttempts ?? []), { ...attempt, attemptId, contextId, workflowId: current.id, attemptOrdinal: current.budgets.roleCalls + 1, status: "pending" }],
  };
}

export function settleRoleAttempt(workflow: any, attemptId: string, status: "succeeded" | "failed" | "timed_out" | "cancelled" | "stale", terminalReason: string) {
  const current = initializeLoop(workflow);
  const found = (current.roleAttempts ?? []).find((item: any) => item.attemptId === attemptId);
  if (!found || found.status !== "pending") throw new Error("Only the current pending SDK session attempt can settle once.");
  const reason = words(terminalReason, "the role attempt terminal reason", 2_000);
  return { ...current, roleAttempts: current.roleAttempts.map((item: any) => item.attemptId === attemptId ? { ...item, status, terminalReason: reason } : item) };
}

function assertReceiptAttempt(workflow: any, receipt: SolarRoleReceipt) {
  const attempt = (workflow.roleAttempts ?? []).find((item: any) => item.attemptId === receipt.attemptId);
  if (!attempt || attempt.status !== "succeeded") throw new Error("Role receipt must bind one successfully settled reserved SDK session attempt.");
  if (attempt.workflowId !== workflow.id || attempt.contextId !== receipt.contextId || attempt.role !== receipt.role || attempt.inputRevision !== receipt.inputRevision || attempt.planRevision !== receipt.planRevision || attempt.repair !== receipt.repair || attempt.attemptOrdinal !== receipt.attemptOrdinal) throw new Error("Role receipt does not match its reserved workflow/context/revision/repair attempt.");
}

export function validatePlanReview(value: unknown, expectation: { role: "approach_reviewer" | "critic"; planRevision: string; contract: ExecutionContractV3 }): PlanReview {
  if (!value || typeof value !== "object") throw new Error("Supply a complete PlanReview.");
  const review = value as any;
  exactObject(review, ["version", "role", "planRevision", "domain", "verdict", "assessment", "requirementCoverage", "findings", "limitations"], "PlanReview");
  if (review.version !== 1 || review.role !== expectation.role) throw new Error("PlanReview version/role does not match the isolated reviewer request.");
  if (revision(review.planRevision, "review plan revision") !== expectation.planRevision) throw new Error("PlanReview is stale for the current plan revision.");
  if (review.domain !== expectation.contract.domain) throw new Error("PlanReview domain does not match the current plan.");
  if (!(["pass", "revise", "blocked"] as const).includes(review.verdict)) throw new Error("PlanReview verdict must be pass, revise, or blocked.");
  const expectedFocus = review.role === "critic" ? "whole_plan_scope_risk_verification_acceptance" : review.domain === "software" ? "software_architecture_feasibility" : "research_methodology_evidence_structure";
  exactObject(review.assessment, ["focus", "analysis"], "PlanReview assessment");
  if (review.assessment?.focus !== expectedFocus) throw new Error(`${review.role} must use the current domain's explicit review focus: ${expectedFocus}.`);
  const assessment = { focus: expectedFocus, analysis: words(review.assessment.analysis, `${review.role} assessment analysis`, 12_000) } as PlanReview["assessment"];
  if (!Array.isArray(review.requirementCoverage) || review.requirementCoverage.length !== expectation.contract.requirements.length) throw new Error("PlanReview must assess every current requirement exactly once.");
  const coverageIds = new Set<string>();
  const requirementIds = new Set(expectation.contract.requirements.map(item => item.id));
  const stepIds = new Set(expectation.contract.steps.map(item => item.id));
  const gateIds = new Set(expectation.contract.gates.map(item => item.id));
  const requirementCoverage = review.requirementCoverage.map((coverage: any) => {
    exactObject(coverage, ["requirementId", "status", "stepIds", "gateIds", "explanation"], "PlanReview requirement coverage");
    const requirementId = identifier(coverage?.requirementId, "review requirement ID");
    if (!requirementIds.has(requirementId) || coverageIds.has(requirementId)) throw new Error("PlanReview has an unknown or duplicate requirement assessment.");
    coverageIds.add(requirementId);
    if (!(["covered", "gap"] as const).includes(coverage.status)) throw new Error(`${requirementId}: review status must be covered or gap.`);
    const coveredSteps = identifierList(coverage.stepIds, `${requirementId} reviewed steps`, coverage.status === "gap");
    const coveredGates = identifierList(coverage.gateIds, `${requirementId} reviewed gates`, coverage.status === "gap");
    if (coveredSteps.some(id => !stepIds.has(id)) || coveredGates.some(id => !gateIds.has(id))) throw new Error(`${requirementId}: review cites an unknown step or gate.`);
    if (coverage.status === "covered") {
      const actual = coveredSteps.map(id => expectation.contract.steps.find(step => step.id === id)!).filter(step => step.requires.includes(requirementId));
      if (!actual.length || !coveredGates.some(id => actual.some(step => step.gates.includes(id)))) throw new Error(`${requirementId}: a covered review assessment must cite an actual covering step and one of its gates.`);
    }
    return { requirementId, status: coverage.status, stepIds: coveredSteps, gateIds: coveredGates, explanation: words(coverage.explanation, `${requirementId} review explanation`, 4_000) };
  });
  if (!Array.isArray(review.findings) || review.findings.length > 80) throw new Error("PlanReview findings must be an array of at most 80 actionable records.");
  const findingIds = new Set<string>();
  const findings = review.findings.map((finding: any) => {
    exactObject(finding, ["id", "severity", "summary", "requiredChange", "planLocations"], "PlanReview finding");
    const id = identifier(finding?.id, "review finding ID");
    if (findingIds.has(id)) throw new Error(`Duplicate review finding ID: ${id}.`);
    findingIds.add(id);
    if (!(["material", "advisory"] as const).includes(finding.severity)) throw new Error(`${id}: finding severity must be material or advisory.`);
    return { id, severity: finding.severity, summary: words(finding.summary, `${id} finding summary`, 4_000), requiredChange: words(finding.requiredChange, `${id} required change`, 4_000), planLocations: list(finding.planLocations, `${id} plan locations`) };
  });
  const limitations = list(review.limitations, "review limitations", true);
  const hasGap = requirementCoverage.some((coverage: any) => coverage.status === "gap");
  const hasMaterial = findings.some((finding: PlanFinding) => finding.severity === "material");
  if (review.verdict === "pass" && (hasGap || hasMaterial)) throw new Error("A passing review cannot retain requirement gaps or material findings.");
  if (review.verdict !== "pass" && !findings.length) throw new Error("A revise/blocked verdict needs at least one actionable finding; a coverage flag alone is not a repair instruction.");
  return { version: 1, role: review.role, planRevision: review.planRevision, domain: review.domain, verdict: review.verdict, assessment, requirementCoverage, findings, limitations };
}

export function validateFindingResolutions(value: unknown, findings: Array<PlanFinding & { role?: string }>, expectation: { fromPlanRevision: string; toPlanRevision: string }): FindingResolution[] {
  if (!Array.isArray(value) || value.length !== findings.length) throw new Error("Map every current review finding to one revision-bound resolution or blocker.");
  const findingIds = new Set(findings.map(finding => finding.id));
  const seen = new Set<string>();
  return value.map((resolutionValue: any) => {
    exactObject(resolutionValue, ["version", "findingId", "fromPlanRevision", "toPlanRevision", "status", "changedLocations", "explanation"], "FindingResolution");
    if (!resolutionValue || resolutionValue.version !== 1) throw new Error("Finding resolutions must use version 1.");
    const findingId = identifier(resolutionValue.findingId, "resolved finding ID");
    if (!findingIds.has(findingId) || seen.has(findingId)) throw new Error("Finding resolution references an unknown or duplicate current finding.");
    seen.add(findingId);
    if (revision(resolutionValue.fromPlanRevision, "resolution source plan revision") !== expectation.fromPlanRevision || revision(resolutionValue.toPlanRevision, "resolution target plan revision") !== expectation.toPlanRevision) throw new Error(`${findingId}: finding resolution is stale for this exact plan revision transition.`);
    if (!(["resolved", "blocked"] as const).includes(resolutionValue.status)) throw new Error(`${findingId}: resolution status must be resolved or blocked.`);
    const changedLocations = list(resolutionValue.changedLocations, `${findingId} changed plan locations`, resolutionValue.status === "blocked");
    return { version: 1, findingId, fromPlanRevision: expectation.fromPlanRevision, toPlanRevision: expectation.toPlanRevision, status: resolutionValue.status, changedLocations, explanation: words(resolutionValue.explanation, `${findingId} resolution explanation`, 4_000) };
  });
}

function reusableResults(current: any, contract: ExecutionContractV3, nextArtifactRevision: string) {
  if (!current.plan?.contract || current.artifactTableRevision !== nextArtifactRevision) return {};
  if (canonicalDigest(current.plan.contract.requirements) !== canonicalDigest(contract.requirements)) return {};
  const results: Record<string, any> = {};
  for (const step of contract.steps) {
    const previous = current.results?.[step.id];
    if (!previous?.passed || step.dependsOn.some(id => !results[id])) continue;
    const oldStep = current.plan.contract.steps.find((item: StepContract) => item.id === step.id);
    if (canonicalDigest(step) !== canonicalDigest(oldStep)) continue;
    const relatedGates = step.gates.map(id => contract.gates.find(gate => gate.id === id));
    const oldGates = step.gates.map(id => current.plan.contract.gates.find((gate: GateContract) => gate.id === id));
    const relatedCapabilities = step.capabilities.map(id => contract.capabilities.find(capability => capability.id === id));
    const oldCapabilities = step.capabilities.map(id => current.plan.contract.capabilities.find((capability: CapabilityContract) => capability.id === id));
    if (canonicalDigest(relatedGates) !== canonicalDigest(oldGates) || canonicalDigest(relatedCapabilities) !== canonicalDigest(oldCapabilities)) continue;
    try {
      if (previous.files.every((file: EvidenceDescriptor) => evidenceFile(current.cwd, file.path).hash === file.hash)) results[step.id] = previous;
    } catch {}
  }
  return results;
}

export function beginPlanRevision(workflow: any, artifact: { path: string; text: string; revision?: string }, options: { plannerReceipt: SolarRoleReceipt; inputRevision: string; visibleOutput: string; resolutions?: FindingResolution[] }) {
  const current = initializeLoop(workflow);
  if (current.stage !== "plan" || !["active", "revision_required"].includes(current.status)) throw new Error("A Planner revision can replace only the current active or revision-required plan stage.");
  const expectedPlanPath = path.resolve(current.cwd, ".solar-workflow", current.id, "plan.md");
  const submittedPlanPath = typeof artifact?.path === "string" ? path.resolve(artifact.path) : "";
  const foldPath = (value: string) => process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  if (foldPath(submittedPlanPath) !== foldPath(expectedPlanPath)) throw new Error("Only the controller-reserved per-workflow plan.md artifact can enter isolated review.");
  if (!/^Status: ready\s*$/m.test(artifact.text)) throw new Error("Controller-owned plan.md must have Status: ready before isolated reviews.");
  const contract = validateExecutionPlan(artifact.text);
  const planRevision = digest(artifact.text);
  if (artifact.revision !== undefined && artifact.revision !== planRevision) throw new Error("Plan artifact revision does not match its exact current bytes.");
  if (current.budgets.reviewRevisions >= current.limits.reviewRevisions) throw new Error(`Plan review-revision budget exhausted (${current.limits.reviewRevisions}); preserve the current plan, findings, resolutions, and best artifacts, then pause for a user decision.`);
  const plannerReceipt = validateRoleReceipt(options?.plannerReceipt, {
    workflowId: current.id,
    role: "planner",
    inputRevision: revision(options?.inputRevision, "planner input bundle revision"),
    ...(current.revision ? { planRevision: current.revision } : {}),
    outputRevision: visibleOutputRevision(options?.visibleOutput, "the exact visible Planner output"),
  });
  assertReceiptAttempt(current, plannerReceipt);
  const previousFindings = current.planning?.reviewFindings ?? [];
  if (previousFindings.length && planRevision === current.revision) throw new Error("Current review findings require a materially changed full plan revision, not a new receipt over identical bytes.");
  const resolutions = previousFindings.length ? validateFindingResolutions(options?.resolutions ?? [], previousFindings, { fromPlanRevision: current.revision, toPlanRevision: planRevision }) : [];
  if (!previousFindings.length && options?.resolutions?.length) throw new Error("No current findings accept a resolution mapping.");
  const tableRevision = artifactTableRevision(contract.artifacts);
  const descriptorChanged = Boolean(current.artifactTableRevision && current.artifactTableRevision !== tableRevision);
  const results = descriptorChanged ? {} : reusableResults(current, contract, tableRevision);
  const blocked = resolutions.some(item => item.status === "blocked");
  const oldPlanning = current.planning ? {
    planRevision: current.revision,
    artifactTableRevision: current.artifactTableRevision,
    revisionState: current.planning.revisionState,
    reviewReceipts: current.planning.reviewReceipts,
    reviews: current.planning.reviews,
    reviewFindings: current.planning.reviewFindings,
    findingResolutions: current.planning.findingResolutions,
  } : undefined;
  const planning = {
    revisionState: blocked ? "blocked" : "awaiting_reviews",
    revisionOrdinal: current.budgets.reviewRevisions + 1,
    reviewReceipts: { planner: plannerReceipt },
    reviews: {},
    reviewFindings: [],
    findingResolutions: resolutions,
    inputRevision: options.inputRevision,
    plannerOutputRevision: plannerReceipt.outputRevision,
    history: [...(current.planning?.history ?? []), ...(oldPlanning ? [oldPlanning] : [])],
    correlationNotice: PLAN_REVIEW_CORRELATION_NOTICE,
  };
  const openPlanDetour = current.detours.findLastIndex((item: any) => item.target === "plan" && !item.outcome);
  const detours = [...current.detours];
  if (openPlanDetour >= 0) detours[openPlanDetour] = { ...detours[openPlanDetour], outcome: blocked ? "blocked" : "revised", endEvidenceDigest: planRevision };
  const priorAuthorityEvidence = current.plan ? {
    reason: descriptorChanged ? "artifact_descriptor_changed" : "plan_revision_changed",
    planRevision: current.revision,
    artifactTableRevision: current.artifactTableRevision,
    results: current.results,
    finalChecks: current.finalChecks,
    finalManifest: current.finalManifest,
    finalReview: current.finalReview,
  } : undefined;
  return {
    ...current,
    stage: "plan",
    status: blocked ? "revision_required" : "reviewing_plan",
    reason: blocked ? "A current review finding remains blocked; it cannot advance to approval or planning-only completion." : undefined,
    plan: { ...artifact, revision: planRevision, contract },
    revision: planRevision,
    artifactTableRevision: tableRevision,
    artifactDescriptorChanged: descriptorChanged,
    planning,
    budgets: { ...current.budgets, reviewRevisions: current.budgets.reviewRevisions + 1 },
    approval: undefined,
    approvalArtifactTableRevision: undefined,
    results,
    finalChecks: undefined,
    finalReview: undefined,
    finalManifest: undefined,
    acceptanceManifest: undefined,
    detours,
    nonAuthoritativeEvidence: [...(current.nonAuthoritativeEvidence ?? []), ...(priorAuthorityEvidence ? [priorAuthorityEvidence] : [])].slice(-12),
    returns: [],
    pendingHandoff: false,
    reminder: 0,
  };
}

export function recordPlanReview(workflow: any, reviewValue: unknown, receiptValue: unknown, inputRevision: string, visibleOutput: string) {
  const current = initializeLoop(workflow);
  if (current.status !== "reviewing_plan" || current.planning?.revisionState !== "awaiting_reviews") throw new Error("No current plan revision is accepting isolated reviews.");
  const role = (reviewValue as any)?.role;
  if (!(role === "approach_reviewer" || role === "critic")) throw new Error("Record only an Approach Reviewer or Critic review here.");
  if (current.planning.reviews[role]) throw new Error(`${role} already reviewed this exact plan revision.`);
  if (canonicalDigest(parseVisibleJson(visibleOutput, `the exact visible ${role} output`)) !== canonicalDigest(reviewValue)) throw new Error(`${role} parsed review does not match its exact visible output.`);
  const review = validatePlanReview(reviewValue, { role, planRevision: current.revision, contract: current.plan.contract });
  const receipt = validateRoleReceipt(receiptValue, { workflowId: current.id, role, inputRevision: revision(inputRevision, "review input bundle revision"), planRevision: current.revision, outputRevision: visibleOutputRevision(visibleOutput, `the exact visible ${role} output`) });
  assertReceiptAttempt(current, receipt);
  const contexts = Object.values(current.planning.reviewReceipts).map((item: any) => item.contextId);
  if (contexts.includes(receipt.contextId)) throw new Error("Planner, Approach Reviewer, and Critic must use distinct fresh context IDs.");
  const reviews = { ...current.planning.reviews, [role]: review };
  const reviewReceipts = { ...current.planning.reviewReceipts, [role]: receipt };
  const taggedFindings = review.findings.map(finding => ({ ...finding, role }));
  if (taggedFindings.some(finding => current.planning.reviewFindings.some((existing: any) => existing.id === finding.id))) throw new Error("Finding IDs must be unique across both current reviewers.");
  const reviewFindings = [...current.planning.reviewFindings, ...taggedFindings];
  const complete = Boolean(reviews.approach_reviewer && reviews.critic);
  let revisionState = current.planning.revisionState;
  let status = current.status;
  let reason = current.reason;
  if (complete) {
    const material = reviewFindings.filter(finding => finding.severity === "material");
    const blocked = Object.values(reviews).some((item: any) => item.verdict === "blocked");
    const revise = Object.values(reviews).some((item: any) => item.verdict === "revise");
    if (blocked || material.length || revise) {
      revisionState = blocked ? "blocked" : "revision_required";
      status = "revision_required";
      reason = `${blocked ? "Blocked" : "Material"} current-plan review findings require a full Planner revision, finding resolutions, and both fresh re-reviews.`;
    } else revisionState = "ready_to_complete";
  }
  return { ...current, status, reason, planning: { ...current.planning, revisionState, reviews, reviewReceipts, reviewFindings } };
}

export function completePlanReview(workflow: any, alignment: { alignment: string; conflicts: string[] }) {
  const current = initializeLoop(workflow);
  if (current.status !== "reviewing_plan" || current.planning?.revisionState !== "ready_to_complete") throw new Error("Both current-revision reviews must pass before the plan can complete review.");
  const explanation = words(alignment?.alignment, "the plan alignment explanation", 8_000);
  if (!Array.isArray(alignment?.conflicts) || alignment.conflicts.some(item => typeof item !== "string" || !item.trim())) throw new Error("Supply the current plan/interview conflicts array; use [] only when none remain.");
  if (alignment.conflicts.length) throw new Error(`Plan/interview conflicts remain: ${alignment.conflicts.join("; ")}.`);
  const planning = { ...current.planning, revisionState: "reviewed", alignment: { alignment: explanation, conflicts: [] }, reviewedAtRevision: current.revision };
  if (!current.autoExecute) return {
    ...current,
    stage: "plan",
    status: "planning_complete",
    planning,
    approval: undefined,
    approvalArtifactTableRevision: undefined,
    pendingHandoff: false,
    reason: "Planning-only completed after current-revision Planner, Approach Reviewer, and Critic review. No execution approval token or execute path exists.",
  };
  return {
    ...current,
    stage: "plan",
    status: "awaiting_gate_review",
    planning,
    approval: undefined,
    approvalArtifactTableRevision: undefined,
    pendingHandoff: false,
    reason: "The reviewed plan is ready for human examination of the exact artifact table and command/rubric gates.",
  };
}

export function approveGateReview(workflow: any, token: string, diskPlan: DiskPlanSnapshot) {
  if (workflow?.status !== "awaiting_gate_review" || !workflow.autoExecute || workflow.planning?.revisionState !== "reviewed") throw new Error("No fully reviewed executable plan is awaiting human gate review.");
  if (token !== workflow.revision.slice(0, 12)) throw new Error("Read /solar-workflow status and approve its exact current reviewed revision token.");
  const contract = validateExecutionPlan(diskPlan.text);
  if (diskPlan.workspaceId !== workflow.workspaceId || diskPlan.path !== workflow.plan.path || digest(diskPlan.text) !== workflow.revision || diskPlan.revision !== workflow.revision) throw new Error("The workspace or plan bytes changed after review. Submit a fresh plan revision and both reviews.");
  if (artifactTableRevision(contract.artifacts) !== workflow.artifactTableRevision) throw new Error("The artifact descriptor table changed after review; checkpoints and approval are stale.");
  const current = initializeLoop(workflow);
  if (current.turns >= current.limits.turns || current.cycle > current.limits.cycles) throw new Error("Raise exhausted workflow limits before starting execution.");
  return { ...current, stage: "execute", status: "active", approval: current.revision, approvalArtifactTableRevision: current.artifactTableRevision, pendingHandoff: true, reminder: 0, reason: undefined };
}

export function executionExpectation(workflow: any, mode: VerificationMode): DispatchExpectation {
  if (!workflow?.approval) throw new Error("No current approval can form an execution expectation.");
  return { workflowId: workflow.id, planRevision: workflow.revision, approval: workflow.approval, artifactTableRevision: workflow.artifactTableRevision, mode };
}

function assertDiskPlanCurrent(fresh: any, diskPlan: DiskPlanSnapshot) {
  if (!diskPlan || typeof diskPlan.text !== "string") throw new Error("Execution authority requires a freshly read disk-plan snapshot.");
  const diskRevision = digest(diskPlan.text);
  if (revision(diskPlan.revision, "disk plan revision") !== diskRevision) throw new Error("Disk-plan receipt does not match the freshly read bytes.");
  if (diskPlan.workspaceId !== fresh.workspaceId || diskPlan.path !== fresh.plan?.path) throw new Error("Fresh disk plan belongs to a different workspace or path.");
  if (diskRevision !== fresh.revision) throw new Error("The approved plan changed on disk; no command, tool, or result commit is authorized.");
  const contract = validateExecutionPlan(diskPlan.text);
  if (fresh.plan?.revision !== fresh.revision || canonicalDigest(fresh.plan?.contract) !== canonicalDigest(contract)) throw new Error("Persisted plan contract/revision does not match the freshly parsed disk plan.");
  if (artifactTableRevision(contract.artifacts) !== fresh.artifactTableRevision) throw new Error("The current artifact descriptor table differs from the reviewed table.");
  return contract;
}

export function assertExecutionAuthority(fresh: any, diskPlan: DiskPlanSnapshot, expectation: DispatchExpectation, operation?: ExecutionOperation, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Execution signal is aborted; no dispatch or result commit is authorized.");
  if (!fresh || fresh.version !== 3 || fresh.status !== "active" || fresh.stage !== "execute") throw new Error("Execution authority requires an active supported execute-stage workflow.");
  if (fresh.planning?.revisionState !== "reviewed" || fresh.planning.reviewedAtRevision && fresh.planning.reviewedAtRevision !== fresh.revision) throw new Error("Execution requires both current-revision reviews and renewed human approval.");
  if (!expectation || expectation.workflowId !== fresh.id || expectation.planRevision !== fresh.revision || expectation.artifactTableRevision !== fresh.artifactTableRevision) throw new Error("Execution expectation is stale for the current workflow, plan, or artifact table.");
  if (!fresh.approval || expectation.approval !== fresh.approval || fresh.approval !== fresh.revision || fresh.approvalArtifactTableRevision !== fresh.artifactTableRevision) throw new Error("Human approval does not bind the current plan and artifact descriptor table.");
  const contract = assertDiskPlanCurrent(fresh, diskPlan);
  const remaining = nextStep(fresh);
  let step: StepContract | undefined;
  if (expectation.mode?.kind === "step") {
    step = remaining;
    if (!step || step.id !== expectation.mode.stepId) throw new Error(`Step authority is limited to the current dependency-ready step: ${step?.id ?? "none"}.`);
    if (expectation.gateId !== undefined && !step.gates.includes(expectation.gateId)) throw new Error(`${expectation.gateId}: gate is not declared for the current step.`);
  } else if (expectation.mode?.kind === "final") {
    if (remaining) throw new Error(`Final verification is unavailable while step ${remaining.id} remains.`);
    if (expectation.gateId !== undefined && !contract.gates.some(gate => gate.id === expectation.gateId)) throw new Error("Final mode permits only an exact approved gate.");
    if (operation) throw new Error("Final mode never authorizes arbitrary model mutation/read/command tools; it only reruns approved gates.");
  } else throw new Error("Execution authority needs an explicit step or final mode.");

  if (operation) {
    const tool = words(operation.tool, "the exact operation tool", 100);
    if (!(["read", "write", "command"] as const).includes(operation.access)) throw new Error("Operation access must be read, write, or command.");
    const capabilities = step!.capabilities.map(id => contract.capabilities.find(capability => capability.id === id)!);
    const operationPath = operation.path === undefined ? undefined : canonicalPlanPath(operation.path, "operation path");
    const command = operation.command === undefined ? undefined : words(operation.command, "the exact operation command");
    if (operation.access === "command" && !command) throw new Error("Command operations require the exact declared command.");
    if (operation.access !== "command" && !operationPath) throw new Error("Read/write operations require the exact declared workspace-relative path.");
    const allowed = capabilities.some(capability => capability.kind === operation.access && capability.tool === tool && (operationPath === undefined || capability.paths.includes(operationPath)) && (command === undefined || capability.commands.includes(command)));
    if (!allowed) throw new Error("The current step does not declare this exact tool/path/command capability; direct-host and later-step bypasses are denied.");
  }
  const gate = expectation.gateId === undefined ? undefined : contract.gates.find(item => item.id === expectation.gateId);
  return { workflow: fresh, contract, step, gate };
}

export function requireApprovedPlan(fresh: any, diskPlan: DiskPlanSnapshot, mode: VerificationMode, operation?: ExecutionOperation, signal?: AbortSignal) {
  return assertExecutionAuthority(fresh, diskPlan, executionExpectation(fresh, mode), operation, signal);
}

async function guardedSnapshot(guard: GateAuthorityGuard, expectation: DispatchExpectation, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Verification interrupted; no completion recorded.");
  const snapshot = await guard(expectation);
  if (!snapshot?.fresh || !snapshot?.diskPlan) throw new Error("Gate guard must return a fresh workflow and freshly read disk plan; no-op guards are invalid.");
  return assertExecutionAuthority(snapshot.fresh, snapshot.diskPlan, expectation, undefined, signal);
}

export async function runGates(options: {
  identifiers: string[];
  exec: (file: string, args: string[], options: { cwd: string; timeout: number; signal?: AbortSignal }) => Promise<any>;
  signal?: AbortSignal;
  expectation: DispatchExpectation;
  guard: GateAuthorityGuard;
}) {
  const { exec, signal, expectation, guard } = options;
  if (expectation?.gateId !== undefined) throw new Error("runGates requires a batch expectation without gateId; the controller binds each exact gate internally.");
  const identifiers = identifierList(options.identifiers, "gate IDs");
  const initial = await guardedSnapshot(guard, expectation, signal);
  const expected = expectation.mode.kind === "step" ? initial.step!.gates : initial.contract.gates.map(gate => gate.id);
  if (!exactSet(identifiers, expected) || identifiers.length !== expected.length) throw new Error(`${expectation.mode.kind === "final" ? "Final verification" : "Step verification"} must run every exact approved gate once.`);
  const results: any[] = [];
  for (const identifier of identifiers) {
    const gateExpectation = { ...expectation, gateId: identifier };
    const before = await guardedSnapshot(guard, gateExpectation, signal);
    const gate = before.gate!;
    await guardedSnapshot(guard, gateExpectation, signal);
    let check = { code: 0, stdout: "Qualitative rubric captured for explicit human review; it is not command proof.", stderr: "" };
    if (gate.kind === "command") {
      try {
        check = await exec(process.platform === "win32" ? "powershell.exe" : "/bin/sh", process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${gate.check}`] : ["-c", gate.check], { cwd: before.workflow.cwd, timeout: 60_000, signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        check = { code: -1, stdout: "", stderr: String(error) };
      }
    }
    await guardedSnapshot(guard, gateExpectation, signal);
    const files: EvidenceDescriptor[] = [];
    const errors: string[] = [];
    for (const artifactId of gate.evidence) {
      const artifact = before.contract.artifacts.find(item => item.id === artifactId)!;
      try { files.push({ artifactId, ...evidenceFile(before.workflow.cwd, artifact.path) }); }
      catch (error) { errors.push(`${artifactId} (${artifact.path}): ${String(error)}`); }
    }
    await guardedSnapshot(guard, gateExpectation, signal);
    results.push({ id: identifier, kind: gate.kind, acceptance: gate.kind === "command" ? "current_command" : "qualitative_human", passed: check.code === 0 && !check.killed && !errors.length, code: check.code, killed: Boolean(check.killed), stdout: String(check.stdout ?? "").slice(-12_000), stderr: String(check.stderr ?? "").slice(-12_000), errors, files });
  }
  for (const result of results) {
    const gateExpectation = { ...expectation, gateId: result.id };
    await guardedSnapshot(guard, gateExpectation, signal);
    for (const file of result.files) {
      try {
        if (evidenceFile(initial.workflow.cwd, file.path).hash !== file.hash) throw new Error("Evidence changed during the gate batch; the earlier result is stale.");
      } catch (error) {
        result.passed = false;
        result.errors.push(`${file.artifactId ?? file.path}: ${String(error)}`);
      }
    }
    await guardedSnapshot(guard, gateExpectation, signal);
  }
  return results;
}

function normalizeApproach(approach: StepApproach): StepApproach {
  if (!approach || typeof approach !== "object") throw new Error("Supply the concrete execution approach used for this attempt.");
  const id = identifier(approach.id, "approach ID");
  const description = words(approach.description, "approach description", 4_000);
  const differsFrom = approach.differsFrom === undefined ? undefined : identifier(approach.differsFrom, "prior approach ID");
  return { id, description, ...(differsFrom ? { differsFrom } : {}) };
}

export function classifyRecoveryProgress(previous: any, current: { files: EvidenceDescriptor[]; gates: any[] }) {
  if (!previous) return { material: true, reasons: ["initial_attempt"] };
  const reasons: string[] = [];
  const previousGates = new Map((previous.gates ?? []).map((gate: any) => [gate.id, gate]));
  for (const gate of current.gates) {
    const before: any = previousGates.get(gate.id);
    if (gate.passed && !before?.passed) reasons.push(`gate_passed:${gate.id}`);
    const beforeDiagnostic = before ? canonicalDigest({ code: before.code, killed: before.killed, stderr: normalizedEvidence(before.stderr ?? ""), stdout: normalizedEvidence(before.stdout ?? ""), errors: (before.errors ?? []).map(normalizedEvidence).sort() }) : undefined;
    const afterDiagnostic = canonicalDigest({ code: gate.code, killed: gate.killed, stderr: normalizedEvidence(gate.stderr ?? ""), stdout: normalizedEvidence(gate.stdout ?? ""), errors: (gate.errors ?? []).map(normalizedEvidence).sort() });
    if (beforeDiagnostic && beforeDiagnostic !== afterDiagnostic) reasons.push(`diagnostic_changed:${gate.id}`);
  }
  const oldFiles = new Map((previous.files ?? []).map((file: EvidenceDescriptor) => [file.path, `${file.hash}:${file.bytes}`]));
  for (const file of current.files) if (oldFiles.get(file.path) !== `${file.hash}:${file.bytes}`) reasons.push(`output_bytes_changed:${file.path}`);
  return { material: reasons.length > 0, reasons: [...new Set(reasons)] };
}

export function validateStepApproach(workflow: any, stepId: string, approachValue: StepApproach) {
  const current = initializeLoop(workflow);
  const step = nextStep(current);
  if (!step || step.id !== stepId) throw new Error(`Report the current dependency-ready step: ${step?.id ?? "final verification"}.`);
  const approach = normalizeApproach(approachValue);
  const previous = [...(current.history ?? [])].reverse().find((entry: any) => entry.step === stepId);
  if (previous && !previous.passed) {
    const repairs = current.repairAttempts?.[stepId] ?? 0;
    if (repairs >= current.limits.repairs) throw new Error(`Step ${stepId} exhausted ${current.limits.repairs} repair approaches. Preserve the best artifacts/diagnostics and revise the plan or obtain a user decision.`);
    if (approach.differsFrom !== previous.approach?.id || normalizedEvidence(approach.description) === normalizedEvidence(previous.approach?.description ?? "")) throw new Error(`Repair ${stepId} with a materially distinct approach and bind differsFrom to ${previous.approach?.id ?? "the prior approach"}; a new ID alone is not a change.`);
  } else if (approach.differsFrom !== undefined) throw new Error("differsFrom is only valid for a targeted retry of a failed approach.");
  return approach;
}

function bestObserved(previous: any, candidate: any) {
  const score = (entry: any) => ({ passed: (entry.gates ?? []).filter((gate: any) => gate.passed).length, files: (entry.files ?? []).filter((file: EvidenceDescriptor) => file.hash && file.bytes >= 0).length, bytes: (entry.files ?? []).reduce((total: number, file: EvidenceDescriptor) => total + (file.bytes ?? 0), 0) });
  if (!previous) return candidate;
  const left = score(previous);
  const right = score(candidate);
  if (right.passed !== left.passed) return right.passed > left.passed ? candidate : previous;
  if (right.files !== left.files) return right.files > left.files ? candidate : previous;
  return right.bytes > left.bytes ? candidate : previous;
}

export function recordStep(workflow: any, report: { stepId: string; summary: string; approach: StepApproach; files: EvidenceDescriptor[]; gates: any[] }, authority: { diskPlan: DiskPlanSnapshot; expectation: DispatchExpectation; signal?: AbortSignal }) {
  const current = initializeLoop(workflow);
  const step = nextStep(current);
  if (!step || step.id !== report?.stepId) throw new Error(`Report the current dependency-ready step: ${step?.id ?? "final verification"}.`);
  const expected = authority?.expectation;
  if (expected?.mode?.kind !== "step" || expected.mode.stepId !== step.id || expected.gateId !== undefined) throw new Error("Checkpoint commit requires the current step's batch execution expectation.");
  assertExecutionAuthority(current, authority.diskPlan, expected, undefined, authority.signal);
  const approach = validateStepApproach(current, step.id, report.approach);
  const summary = words(report.summary, "what changed and how current evidence satisfies the step gates", 12_000);
  if (!Array.isArray(report.files) || !Array.isArray(report.gates)) throw new Error("Supply current artifact descriptors and gate results.");
  const gateIds = report.gates.map(gate => gate.id);
  if (!exactSet(gateIds, step.gates) || gateIds.length !== step.gates.length) throw new Error("Step report must contain every exact current step gate once.");
  for (const result of report.gates) {
    const contractGate = current.plan.contract.gates.find((gate: GateContract) => gate.id === result.id)!;
    if (result.kind !== contractGate.kind || result.acceptance !== (contractGate.kind === "command" ? "current_command" : "qualitative_human")) throw new Error(`${result.id}: step gate result does not preserve the current command-versus-qualitative contract.`);
    if (typeof result.code !== "number" || !Array.isArray(result.errors) || result.passed !== (result.code === 0 && !result.killed && result.errors.length === 0)) throw new Error(`${result.id}: gate pass state must reflect its current exit/capture result.`);
    if (!Array.isArray(result.files)) throw new Error(`${result.id}: gate result files must be an array.`);
    const resultArtifactIds = result.files.map((file: EvidenceDescriptor) => file.artifactId ?? "");
    if (new Set(resultArtifactIds).size !== resultArtifactIds.length || resultArtifactIds.some((artifactId: string) => !contractGate.evidence.includes(artifactId)) || (result.passed && (!exactSet(resultArtifactIds, contractGate.evidence) || result.files.length !== contractGate.evidence.length))) throw new Error(`${result.id}: a passing gate must bind every exact current evidence artifact once; failed gates may retain only the available declared artifacts.`);
    for (const file of result.files) {
      const descriptor = current.plan.contract.artifacts.find((artifact: ArtifactDescriptor) => artifact.id === file.artifactId)!;
      const actual = evidenceFile(current.cwd, descriptor.path);
      if (file.path !== descriptor.path || file.hash !== actual.hash || file.bytes !== actual.bytes) throw new Error(`${result.id}: gate evidence ${descriptor.id} changed before checkpoint commit.`);
    }
  }
  const reportedArtifacts = new Set<string>();
  const files = report.files.map(file => {
    const artifactId = identifier(file.artifactId, "reported artifact ID");
    if (reportedArtifacts.has(artifactId)) throw new Error(`Duplicate reported artifact: ${artifactId}.`);
    reportedArtifacts.add(artifactId);
    const descriptor = current.plan.contract.artifacts.find((artifact: ArtifactDescriptor) => artifact.id === artifactId);
    if (!descriptor || file.path !== descriptor.path) throw new Error(`${artifactId}: reported evidence path must match its current artifact descriptor.`);
    canonicalPlanPath(file.path, "reported evidence path");
    revision(file.hash, `${file.path} evidence hash`);
    if (!Number.isInteger(file.bytes) || file.bytes < 0) throw new Error(`${file.path}: evidence bytes must be a nonnegative integer.`);
    const actual = evidenceFile(current.cwd, descriptor.path);
    if (file.hash !== actual.hash || file.bytes !== actual.bytes) throw new Error(`${artifactId}: reported artifact changed before checkpoint commit.`);
    return { ...file, artifactId };
  });
  const expectedOutputPaths = step.outputs.map(id => current.plan.contract.artifacts.find((artifact: ArtifactDescriptor) => artifact.id === id)!.path);
  const passed = report.gates.every(gate => gate.passed) && expectedOutputPaths.every(filename => files.some(file => file.path === filename));
  const previous = [...(current.history ?? [])].reverse().find((entry: any) => entry.step === step.id);
  const progress = classifyRecoveryProgress(previous, { files, gates: report.gates });
  const repair = Boolean(previous && !previous.passed);
  const repairAttempts = { ...(current.repairAttempts ?? {}), [step.id]: (current.repairAttempts?.[step.id] ?? 0) + (repair ? 1 : 0) };
  const snapshots = { ...(current.snapshots ?? {}) };
  if (passed) for (const artifactId of step.outputs) {
    const filename = current.plan.contract.artifacts.find((artifact: ArtifactDescriptor) => artifact.id === artifactId)!.path;
    const snapshot = { artifactId, ...evidenceFile(current.cwd, filename, true) };
    const used = Object.values(snapshots).reduce((total: number, item: any) => total + (item.content || item.storedContent ? item.bytes : 0), 0) - (snapshots[snapshot.path]?.content || snapshots[snapshot.path]?.storedContent ? snapshots[snapshot.path].bytes : 0);
    if (used + snapshot.bytes > 1024 * 1024) delete snapshot.content;
    snapshots[snapshot.path] = snapshot;
  }
  const result = { step: step.id, summary, approach, passed, files, gates: report.gates, progress };
  const attempts = { ...current.attempts, [step.id]: (current.attempts?.[step.id] ?? 0) + 1 };
  const history = [...(current.history ?? []), { cycle: current.cycle, revision: current.revision, artifactTableRevision: current.artifactTableRevision, ...result }];
  const bestRecovery = { ...(current.bestRecovery ?? {}), [step.id]: bestObserved(current.bestRecovery?.[step.id], result) };
  let next = {
    ...current,
    results: { ...current.results, [step.id]: result },
    attempts,
    repairAttempts,
    history,
    snapshots,
    bestRecovery,
    checkpoint: (current.checkpoint ?? 0) + (passed ? 1 : 0),
    reminder: 0,
    ...(passed ? { best: { ...(current.best ?? {}), [step.id]: { revision: current.revision, artifactTableRevision: current.artifactTableRevision, ...result } } } : {}),
  };
  if (!passed && repair && !progress.material) {
    const best = bestRecovery[step.id];
    next = { ...next, status: "paused", limitStop: { kind: "no_relevant_progress", bound: repairAttempts[step.id] }, pendingHandoff: false, reason: `Step ${step.id} used a distinct approach but produced no new relevant diagnostic, passing gate, or output bytes. Best retained artifacts: ${(best.files ?? []).map((file: EvidenceDescriptor) => `${file.path} (${file.hash.slice(0, 12)})`).join(", ") || "none"}. Revise the plan, supply new evidence, or stop; IDs-only resume is disabled.` };
  } else if (!passed && repairAttempts[step.id] >= current.limits.repairs) {
    const best = bestRecovery[step.id];
    next = { ...next, status: "paused", limitStop: { kind: "repairs", bound: current.limits.repairs }, pendingHandoff: false, reason: `Step ${step.id} exhausted ${current.limits.repairs} materially distinct repairs. Best retained artifacts: ${(best.files ?? []).map((file: EvidenceDescriptor) => `${file.path} (${file.hash.slice(0, 12)})`).join(", ") || "none"}; current failed diagnostics are preserved. Revise the plan or obtain a user decision.` };
  }
  return next;
}

export function nextStep(workflow: any): StepContract | undefined {
  return workflow?.plan?.contract?.steps?.find((step: StepContract) => !workflow.results?.[step.id]?.passed);
}

export function captureArtifactManifest(workflow: any, kinds: Array<"final" | "intermediate" | "evidence">): ArtifactManifest {
  const selectedKinds = [...new Set(kinds)].sort() as Array<"final" | "intermediate" | "evidence">;
  if (!selectedKinds.length || selectedKinds.some(kind => !["final", "intermediate", "evidence"].includes(kind))) throw new Error("Select at least one supported artifact-manifest kind.");
  const files = workflow.plan.contract.artifacts.filter((artifact: ArtifactDescriptor) => selectedKinds.includes(artifact.kind)).sort((left: ArtifactDescriptor, right: ArtifactDescriptor) => left.id.localeCompare(right.id)).map((artifact: ArtifactDescriptor) => ({ artifactId: artifact.id, ...evidenceFile(workflow.cwd, artifact.path) }));
  if (!files.length) throw new Error("The current plan declares no artifacts for the requested manifest.");
  return { planRevision: revision(workflow.revision, "manifest plan revision"), artifactTableRevision: revision(workflow.artifactTableRevision, "manifest artifact-table revision"), kinds: selectedKinds, files };
}

export function captureFinalManifest(workflow: any) {
  return captureArtifactManifest(workflow, ["final"]);
}

export function captureAcceptanceManifest(workflow: any) {
  return captureArtifactManifest(workflow, ["evidence", "final"]);
}

function assertManifest(manifest: ArtifactManifest, workflow: any, kinds: Array<"final" | "intermediate" | "evidence">) {
  if (!manifest || manifest.planRevision !== workflow.revision || manifest.artifactTableRevision !== workflow.artifactTableRevision || !exactSet(manifest.kinds, kinds)) throw new Error("Artifact manifest is stale for the current plan/table or has the wrong artifact kinds.");
  const expected = workflow.plan.contract.artifacts.filter((artifact: ArtifactDescriptor) => kinds.includes(artifact.kind)).map((artifact: ArtifactDescriptor) => artifact.id);
  if (!Array.isArray(manifest.files) || !exactSet(manifest.files.map(file => file.artifactId), expected) || manifest.files.length !== expected.length) throw new Error("Artifact manifest must bind every exact declared artifact once.");
  for (const file of manifest.files) {
    const artifact = workflow.plan.contract.artifacts.find((item: ArtifactDescriptor) => item.id === file.artifactId);
    if (!artifact || file.path !== artifact.path) throw new Error("Artifact manifest path no longer matches its descriptor.");
    revision(file.hash, `${file.artifactId} manifest hash`);
    if (!Number.isInteger(file.bytes) || file.bytes < 0) throw new Error(`${file.artifactId}: manifest bytes must be a nonnegative integer.`);
  }
  return manifest;
}

function sameManifest(left: ArtifactManifest, right: ArtifactManifest) {
  return canonicalDigest(left) === canonicalDigest(right);
}

function finalRegression(workflow: any, gates: any[], reason: string, manifests: any) {
  const evidence = JSON.stringify({ gates: gates.map(gate => ({ id: gate.id, code: gate.code, errors: gate.errors, stderr: String(gate.stderr ?? "").slice(-500) })), before: manifests.before?.files, after: manifests.after?.files }).slice(0, 11_500);
  const result = revisitWorkflow(workflow, { stage: "plan", gap: reason, evidence });
  return { ...result, finalChecks: gates, finalManifestBefore: manifests.before, finalManifest: manifests.after, acceptanceManifest: undefined };
}

export function finishVerification(workflow: any, gates: any[], manifests: { before: ArtifactManifest; after: ArtifactManifest; acceptance: ArtifactManifest }, authority: { diskPlan: DiskPlanSnapshot; expectation: DispatchExpectation; signal?: AbortSignal }) {
  if (nextStep(workflow)) throw new Error("Finish all dependency-ordered steps before final verification.");
  if (authority?.expectation?.mode?.kind !== "final" || authority.expectation.gateId !== undefined) throw new Error("Final result commit requires a fresh final-mode batch expectation.");
  assertExecutionAuthority(workflow, authority.diskPlan, authority.expectation, undefined, authority.signal);
  const expected = workflow.plan.contract.gates.map((gate: GateContract) => gate.id);
  if (!Array.isArray(gates) || !exactSet(gates.map(gate => gate.id), expected) || gates.length !== expected.length) throw new Error("Final verification must rerun every approved gate exactly once.");
  assertManifest(manifests.before, workflow, ["final"]);
  assertManifest(manifests.after, workflow, ["final"]);
  assertManifest(manifests.acceptance, workflow, ["evidence", "final"]);
  const currentFinalManifest = captureFinalManifest(workflow);
  const currentAcceptanceManifest = captureAcceptanceManifest(workflow);
  if (!sameManifest(currentFinalManifest, manifests.after) || !sameManifest(currentAcceptanceManifest, manifests.acceptance)) return finalRegression(workflow, gates, "Declared final/evidence bytes changed before final result commit.", manifests);
  if (!sameManifest(manifests.before, manifests.after)) return finalRegression(workflow, gates, "Declared final artifact bytes changed during final verification; repair/replan and rerun current checks.", manifests);
  const acceptanceFiles = new Map(manifests.acceptance.files.map(file => [file.artifactId, file]));
  if (manifests.after.files.some(file => canonicalDigest(file) !== canonicalDigest(acceptanceFiles.get(file.artifactId)))) return finalRegression(workflow, gates, "Declared final artifact bytes changed between the post-gate and acceptance manifests.", manifests);
  for (const result of gates) {
    const contractGate = workflow.plan.contract.gates.find((gate: GateContract) => gate.id === result.id)!;
    if (result.kind !== contractGate.kind || result.acceptance !== (contractGate.kind === "command" ? "current_command" : "qualitative_human")) throw new Error(`${result.id}: gate result does not preserve the current command-versus-qualitative contract.`);
    if (typeof result.code !== "number" || !Array.isArray(result.errors) || result.passed !== (result.code === 0 && !result.killed && result.errors.length === 0)) throw new Error(`${result.id}: final gate pass state must reflect its current exit/capture result.`);
    if (!Array.isArray(result.files)) throw new Error(`${result.id}: final gate result files must be an array.`);
    const evidenceIds = result.files.map((file: EvidenceDescriptor) => file.artifactId ?? "");
    if (new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some((id: string) => !contractGate.evidence.includes(id)) || (result.passed && (!exactSet(evidenceIds, contractGate.evidence) || evidenceIds.length !== contractGate.evidence.length))) throw new Error(`${result.id}: final gate result does not bind its exact current evidence artifact set.`);
    if (result.files.some((file: EvidenceDescriptor) => {
      try {
        const actual = evidenceFile(workflow.cwd, file.path);
        return actual.hash !== file.hash || actual.bytes !== file.bytes;
      } catch {
        return true;
      }
    })) return finalRegression(workflow, gates, `Gate ${result.id} evidence changed before final result commit.`, manifests);
    if (result.files.some((file: EvidenceDescriptor) => {
      const descriptor = file.artifactId ? workflow.plan.contract.artifacts.find((artifact: ArtifactDescriptor) => artifact.id === file.artifactId) : undefined;
      if (descriptor?.kind === "intermediate") return false;
      const current = file.artifactId ? acceptanceFiles.get(file.artifactId) : undefined;
      return !current || current.path !== file.path || current.hash !== file.hash || current.bytes !== file.bytes;
    })) return finalRegression(workflow, gates, `Gate ${result.id} evidence changed before the acceptance manifest.`, manifests);
  }
  const failed = gates.filter(gate => !gate.passed);
  if (failed.length) return finalRegression(workflow, gates, `Final validation regression: ${failed.map(gate => gate.id).join(", ")}`, manifests);
  const finals: ArtifactDescriptor[] = workflow.plan.contract.artifacts.filter((artifact: ArtifactDescriptor) => artifact.kind === "final");
  const humanReview = workflow.plan.contract.gates.some((gate: GateContract) => gate.kind === "rubric") || finals.some(artifact => artifact.acceptance === "human");
  const autoComplete = !humanReview && finals.every(artifact => artifact.acceptance === "command" && artifact.gates.every(gateId => workflow.plan.contract.gates.find((gate: GateContract) => gate.id === gateId)?.kind === "command"));
  const finalReview = canonicalDigest({ planRevision: workflow.revision, artifactTableRevision: workflow.artifactTableRevision, finalChecks: gates, finalManifest: manifests.after });
  return {
    ...workflow,
    status: autoComplete ? "complete" : "awaiting_final_review",
    finalChecks: gates,
    finalManifestBefore: manifests.before,
    finalManifest: manifests.after,
    acceptanceManifest: manifests.acceptance,
    finalReview,
    reason: autoComplete ? "All declared final bytes remained stable and every command-accepted final passed its current command gates." : "Current command gates passed. A rubric or human-accepted final still requires explicit qualitative acceptance of the exact current final/evidence bytes.",
  };
}

export function acceptFinalReview(workflow: any, token: string, currentManifest: ArtifactManifest, diskPlan: DiskPlanSnapshot) {
  if (workflow?.status !== "awaiting_final_review" || token !== workflow.finalReview?.slice(0, 12)) throw new Error("Read /solar-workflow status and accept its exact current final-review token.");
  assertDiskPlanCurrent(workflow, diskPlan);
  assertManifest(currentManifest, workflow, ["evidence", "final"]);
  const rehashed = captureAcceptanceManifest(workflow);
  if (!sameManifest(rehashed, currentManifest) || !sameManifest(rehashed, workflow.acceptanceManifest)) throw new Error("A declared final/evidence file changed after final checks. Resume execution and revalidate current bytes before human acceptance.");
  return { ...workflow, status: "complete", reason: "Current command checks passed and the user accepted qualitative rubric evidence bound to the exact current final/evidence manifest." };
}

export function renderWorkflowReview(workflow: any) {
  if (!workflow) return "No saved Solar workflow.";
  const lines = [`Solar: ${workflow.stage} · ${workflow.status} · cycle ${workflow.cycle ?? 1}/${workflow.limits?.cycles ?? LOOP_LIMITS.cycles}`, workflow.reason ?? "", `Original intention: ${workflow.originalTask}`];
  lines.push(`Turns: ${workflow.turns ?? 0}/${workflow.limits?.turns ?? LOOP_LIMITS.turns} | detours: ${workflow.detours?.length ?? 0}/${workflow.limits?.detours ?? LOOP_LIMITS.detours} | plan revisions: ${workflow.budgets?.reviewRevisions ?? 0}/${workflow.limits?.reviewRevisions ?? LOOP_LIMITS.reviewRevisions} | role attempts: ${workflow.budgets?.roleCalls ?? 0}/${workflow.limits?.roleCalls ?? LOOP_LIMITS.roleCalls} | role repairs: ${workflow.budgets?.roleRepairs ?? 0}/${workflow.limits?.roleRepairs ?? LOOP_LIMITS.roleRepairs} | next step: ${nextStep(workflow)?.id ?? "none"}`);
  if (workflow.gap) lines.push(`Current gap: ${workflow.gap}`);
  if (workflow.detours?.length) lines.push(`Detours: ${workflow.detours.map((item: any) => `${item.from} -> ${item.target}: ${item.gap} [${item.outcome ?? "open"}]`).join(" | ")}`);
  for (const result of Object.values(workflow.results ?? {}) as any[]) lines.push(`${result.step}: ${result.passed ? "gates passed" : "failed"} | approach ${result.approach?.id ?? "missing"} | ${(result.files ?? []).map((file: EvidenceDescriptor) => file.path).join(", ")}`);
  if (workflow.planning) {
    lines.push(`Planning revision state: ${workflow.planning.revisionState}`, workflow.planning.correlationNotice ?? PLAN_REVIEW_CORRELATION_NOTICE);
    for (const receipt of Object.values(workflow.planning.reviewReceipts ?? {}) as SolarRoleReceipt[]) lines.push(`${receipt.role}: context ${receipt.contextId}, attempt ${receipt.attemptOrdinal}, plan ${receipt.planRevision?.slice(0, 12) ?? "produced"}`);
    for (const finding of workflow.planning.reviewFindings ?? []) lines.push(`${finding.role}/${finding.severity} ${finding.id}: ${finding.summary} → ${finding.requiredChange} [${finding.planLocations.join(", ")}]`);
    for (const resolution of workflow.planning.findingResolutions ?? []) lines.push(`Resolution ${resolution.findingId}: ${resolution.status} → ${resolution.changedLocations.join(", ") || "blocked"} | ${resolution.explanation}`);
  }
  if (workflow.status === "awaiting_gate_review") {
    lines.push(`Plan: ${workflow.plan.path}`, `Plan revision: ${workflow.revision}`, `Artifact table: ${workflow.artifactTableRevision}`, "Review coverage, feasibility, exact capabilities, artifacts, and command/rubric gates before approving:");
    for (const requirement of workflow.plan.contract.requirements) lines.push(`${requirement.id}: ${requirement.description} [source: ${requirement.source}]`);
    for (const artifact of workflow.plan.contract.artifacts) lines.push(`${artifact.id}: ${artifact.path} [${artifact.kind}; ${artifact.acceptance}] → ${artifact.gates.join(", ")}`);
    for (const step of workflow.plan.contract.steps) lines.push(`${step.id}: ${step.title} → ${step.outputs.join(", ")} | requirements ${step.requires.join(", ")} | gates ${step.gates.join(", ")} | capabilities ${step.capabilities.join(", ")}`, `  Actions: ${step.actions.join("; ")} | Feasibility: ${step.feasibility}`);
    for (const gate of workflow.plan.contract.gates) lines.push(`${gate.id} [${gate.kind === "command" ? "current command" : "qualitative rubric"}]: ${gate.check}`, `  Pass: ${gate.pass} | Artifact evidence: ${gate.evidence.join(", ")}`);
    lines.push("Approved commands run with user permissions (PowerShell on Windows), not a sandbox.", `/solar-workflow approve ${workflow.revision.slice(0, 12)}`, "Or /solar-workflow revise <feedback> to correct the current plan/artifact table/gates.");
  }
  if (workflow.status === "planning_complete") lines.push("Reviewed planning-only boundary: no approval token, execute tool, or execution follow-up is authorized.");
  if (workflow.status === "awaiting_final_review") {
    for (const gate of workflow.finalChecks) lines.push(`${gate.id} [${gate.kind === "command" ? "current command" : "qualitative rubric"}]: ${workflow.plan.contract.gates.find((item: GateContract) => item.id === gate.id).pass} | ${gate.files.map((file: EvidenceDescriptor) => `${file.path} (${file.hash.slice(0, 12)})`).join(", ")}`);
    for (const file of workflow.finalManifest.files) lines.push(`Final ${file.artifactId}: ${file.path} (${file.hash.slice(0, 12)}, ${file.bytes} bytes)`);
    lines.push(`/solar-workflow accept ${workflow.finalReview.slice(0, 12)}`, "Acceptance rehashes every declared final/evidence file and the disk plan. Or revise the outcome and rerun current checks.");
  }
  if (workflow.bestRecovery && ["paused", "limited"].includes(workflow.status)) for (const [stepId, best] of Object.entries(workflow.bestRecovery) as any) lines.push(`Best retained ${stepId}: ${(best.files ?? []).map((file: EvidenceDescriptor) => `${file.path} (${file.hash.slice(0, 12)})`).join(", ") || "diagnostics only"}; approach ${best.approach?.description ?? "not recorded"}`);
  lines.push("/solar-workflow status | stop | resume | limits cycles=N detours=N turns=N");
  return lines.filter(Boolean).join("\n");
}
