import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createRetryingFetch } from "./retry-fetch.ts";
import { prepareInterviewReport, renderCurrentInterview, renderPendingInterview } from "./interview-report.ts";
import { interviewDisplayNote, renderStyledInterview, renderStyledPendingInterview } from "./interview-display.ts";
import {
  confirmInterview,
  finishInterview,
  INTERVIEW_CLOSURE_STATE,
  INTERVIEW_REVIEW_STATE,
  INTERVIEW_STATE,
  interviewConfirmationToken,
  interviewContentHash,
  invokedSkill,
  isInterviewFinishRequest,
  messageText,
  recoverInterview,
  renderInterviewClosure,
  stripSkill,
} from "./interview.ts";
import {
  countPlanSteps,
  matchesWorkflowWorkspace,
  readWorkflowArtifact,
  recoverWorkflow,
  renderResearchArtifact,
  researchValidationContext,
  reservedWorkflowArtifact,
  startWorkflow,
  validateResearchContract,
  WORKFLOW_STATE,
  workflowContract,
  workspaceIdentity,
} from "./workflow.ts";
import {
  acceptFinalReview,
  approveGateReview,
  canonicalPlanPath,
  assertExecutionAuthority,
  beginPlanRevision,
  captureAcceptanceManifest,
  captureFinalManifest,
  completeWorkflowDetour,
  completePlanReview,
  evidenceFile,
  executionExpectation,
  finishVerification,
  initializeLoop,
  nextStep,
  parseVisibleJson,
  recordPlanReview,
  recordStep,
  renderWorkflowReview,
  requireApprovedPlan,
  researchReady,
  resumeLoop,
  revisitWorkflow,
  reserveRoleAttempt,
  runGates,
  settleRoleAttempt,
  SNAPSHOT_STATE,
  structuredRevision,
  validateExecutionPlan,
  validateFindingResolutions,
  validateStepApproach,
  type DispatchExpectation,
  type FindingResolution,
  type PlanningRole,
  type SolarRoleReceipt,
  SOLAR_PRO4_CONTEXT_HINTS,
} from "./loop.ts";
import {
  buildRoleContextBundle,
  createPiSdkSolarRoleSessionFactory,
  createSolarRoleRunner,
  requireSolarMaxModel,
  SOLAR_ROLE_EXCERPT_MAX_BYTES,
  type SolarRoleAttempt,
  type SolarRoleAttemptBoundary,
  type SolarRoleIdentity,
  type SolarRoleResult,
  type SolarRoleRunner,
} from "./roles.ts";
import { createTavilyClient, requireWebAccess, webReceipts, WEB_TOOLS } from "./web-research.ts";
import { createDocumentClient } from "./document-research.ts";

const RATE_STATE = "solar-retry-state-v2";
const ROLE_OUTPUT_STATE = "solar-role-visible-output-v1";
const ROLE_DIAGNOSTIC_STATE = "solar-role-diagnostic-v1";
const DELEGATES = Symbol.for("pi-solar-lite.upstage-delegates-v1");
const INTENT_RUBRIC = "PLANNING-READINESS RUBRIC: Assess clarity of user intention, not completeness of an implementation design. 1.0 means the intended outcome, scope/constraints, and success meaning are explicit enough to plan. Deliberately delegated implementation choices are resolved scope decisions, not unanswered questions. Preserve genuine contradictions and consequential open decisions. Scores are advisory and never authorize closure.";
const CORRELATED_ALIGNMENT = "The host-validated ExecutionContractV3 and both passing current-revision role reviews cover the selected original-request, research, and interview provenance without a declared conflict. This is correlated same-model review evidence, not independent proof.";
const CONTROL_TOOLS = ["solar_interview_round", "solar_research_ready", "solar_plan_ready", "solar_revisit", "solar_step_done", ...WEB_TOOLS];
const CREDENTIAL_MATERIAL = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{20,}|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}|\b(?:sk|tvly)-[A-Za-z0-9_-]{12,}/iu;
const EXECUTION_CONTRACT_V3_SCHEMA = `ExecutionContractV3 exact JSON shape:
{
  "version": 3,
  "domain": "software | research",
  "requirements": [{"id": "stable-id", "description": "observable requirement", "source": "exact provenance reference"}],
  "artifacts": [{"id": "stable-id", "path": "canonical/workspace-relative/path", "kind": "final | intermediate | evidence", "acceptance": "command | human | none", "gates": ["gate-id"]}],
  "capabilities": [{"id": "stable-id", "kind": "read | write | command", "tool": "exact-host-tool-name", "paths": ["canonical/workspace-relative/path"], "commands": ["exact command"]}],
  "steps": [{"id": "stable-id", "title": "bounded outcome", "feasibility": "observed support and assumptions", "inputs": ["artifact-id"], "outputs": ["artifact-id"], "actions": ["concrete action"], "dependsOn": ["earlier-step-id"], "requires": ["requirement-id"], "gates": ["gate-id"], "capabilities": ["capability-id"]}],
  "gates": [{"id": "stable-id", "kind": "command | rubric", "check": "exact non-destructive command or qualitative rubric", "pass": "observable passing condition", "evidence": ["artifact-id"]}],
  "selfCheck": {
    "review": "scope, ordering, feasibility, risk, and acceptance analysis",
    "requirementCoverage": [{"requirementId": "requirement-id", "stepIds": ["step-id"], "gateIds": ["gate-id"], "explanation": "actual coverage"}],
    "artifactCoverage": [{"artifactId": "produced-artifact-id", "stepId": "producer-step-id", "gateIds": ["gate-id"], "explanation": "production and acceptance binding"}],
    "unresolved": []
  }
}`;
const EXECUTION_CONTRACT_V3_RULES = `ExecutionContractV3 exact reference rules:
- Every record ID is unique in its table. Every reference names an existing record of the correct table.
- Artifact paths are unique under Windows case folding, already-normalized workspace-relative forward-slash paths with no drive, ADS, dot/parent segment, private controller root, or reserved device segment.
- Every non-evidence artifact has exactly one producing step. A produced input has a declared dependency path to its producer. Dependencies name earlier steps and are acyclic.
- Every requirement is required by at least one bounded step. Every gate and capability is used by a step. Remove unused/speculative authority.
- Read/write capabilities have one or more exact paths and commands:[]. Command capabilities have one or more exact commands; paths list every declared artifact they may affect.
- Each produced output has an exact write or command capability for its descriptor path. Each input has an exact path capability in that step.
- Artifact.gates and Gate.evidence are reciprocal. Every final has command or human acceptance and at least one gate. Command acceptance binds a command gate; human acceptance binds a rubric gate. Intermediate/evidence artifacts may use acceptance:none.
- Every step has nonempty outputs, actions, requires, gates, capabilities, title, and feasibility; inputs and dependsOn may be [].
- selfCheck.requirementCoverage covers every requirement exactly once with actual covering steps and one of their gates. selfCheck.artifactCoverage covers every produced artifact exactly once with its actual producer and exact descriptor gates. selfCheck.unresolved must be [].`;
const PLAN_REVIEW_SCHEMA = `PlanReview exact JSON shape:
{
  "version": 1,
  "role": "approach_reviewer | critic",
  "planRevision": "exact current 64-character lowercase SHA-256",
  "domain": "software | research",
  "verdict": "pass | revise | blocked",
  "assessment": {"focus": "software_architecture_feasibility | research_methodology_evidence_structure | whole_plan_scope_risk_verification_acceptance", "analysis": "substantive current-plan analysis"},
  "requirementCoverage": [{"requirementId": "requirement-id", "status": "covered | gap", "stepIds": ["step-id"], "gateIds": ["gate-id"], "explanation": "current-plan evidence"}],
  "findings": [{"id": "unique-across-both-reviewers", "severity": "material | advisory", "summary": "specific defect", "requiredChange": "actionable correction", "planLocations": ["exact current plan location"]}],
  "limitations": ["correlated same-model and evidence limitations"]
}`;
const PLAN_REVIEW_RULES = `PlanReview exact reference rules:
- Use the requested role, exact current planRevision/domain, and role/domain focus. Critic focus is whole_plan_scope_risk_verification_acceptance; Approach focus is software_architecture_feasibility or research_methodology_evidence_structure.
- requirementCoverage contains every current requirement exactly once. covered cites at least one actual step requiring that requirement and at least one gate of a cited covering step; gap may use empty stepIds/gateIds.
- Finding IDs are unique within and across both reviews. Each finding is actionable and location-specific. A pass has no requirement gap or material finding. revise/blocked has at least one finding.
- Inspect the full ExecutionContractV3 and prose; selfCheck, hashes, nonempty fields, and model confidence are not proof. Return the complete object, not a patch.`;
const PLANNER_OUTPUT_SCHEMA = `Planner visible response exact JSON shape:
{
  "planMarkdown": "complete Markdown plan containing the exact ExecutionContractV3",
  "resolutions": [{"findingId": "current-finding-id", "status": "resolved | blocked", "changedLocations": ["exact changed plan location"], "explanation": "how the full revision resolves or remains blocked"}]
}
Initial planning uses resolutions:[]. A revision maps every current finding exactly once, uses no unknown/duplicate finding ID, changes full plan bytes, and returns status:blocked only when the named finding cannot be resolved. The host supplies from/to revisions and validates the mapping.`;

const dimensionSchema = Type.Object({
  score: Type.Number({ minimum: 0, maximum: 1 }),
  evidence: Type.Array(Type.String()),
  gap: Type.String(),
});
const materialStateSchema = Type.Object({
  topics: Type.Array(Type.Object({
    topicId: Type.String(),
    kind: Type.Union([Type.Literal("decision"), Type.Literal("correction"), Type.Literal("constraint"), Type.Literal("success")]),
    normalizedValue: Type.String(),
    sourceContentHashes: Type.Array(Type.String()),
  })),
  gaps: Type.Array(Type.Object({
    gapId: Type.String(),
    status: Type.Union([Type.Literal("open"), Type.Literal("narrowed"), Type.Literal("resolved")]),
    normalizedSummary: Type.String(),
  })),
  claims: Type.Array(Type.Object({
    gapId: Type.String(),
    normalizedClaim: Type.String(),
    sourceContentHashes: Type.Array(Type.String()),
  })),
});
const readinessSchema = Type.Object({
  status: Type.Union([Type.Literal("not_ready"), Type.Literal("ready")]),
  goalSentence: Type.Optional(Type.String()),
  materialGaps: Type.Array(Type.Object({
    id: Type.String(),
    issue: Type.String(),
    evidenceIds: Type.Array(Type.String()),
    researchable: Type.Boolean(),
  })),
  contradictions: Type.Array(Type.Object({
    id: Type.String(),
    issue: Type.String(),
    evidenceIds: Type.Array(Type.String()),
  })),
});
const researchContractSchema = Type.Object({
  version: Type.Literal(2),
  mode: Type.Union([Type.Literal("initial"), Type.Literal("detour")]),
  gapId: Type.Optional(Type.String()),
  answerHeadId: Type.Optional(Type.String()),
  outcome: Type.Union([Type.Literal("ready"), Type.Literal("narrowed"), Type.Literal("blocked")]),
  claims: Type.Array(Type.Object({
    id: Type.String(),
    kind: Type.Union([Type.Literal("evidence"), Type.Literal("inference"), Type.Literal("uncertainty"), Type.Literal("user_decision")]),
    text: Type.String(),
    sourceIds: Type.Array(Type.String()),
  })),
  sources: Type.Array(Type.Object({
    id: Type.String(),
    url: Type.String(),
    title: Type.String(),
    receiptIds: Type.Array(Type.String()),
    limitation: Type.String(),
  })),
  learnedClaimIds: Type.Array(Type.String()),
  remainingGap: Type.String(),
  nextQuestion: Type.Optional(Type.Object({ text: Type.String(), addressesGapId: Type.String(), rationale: Type.String() })),
});

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function hashBytes(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function foldedPath(value: string) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function assertInside(root: string, candidate: string, label: string) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escaped the workflow workspace.`);
}

function reservedLocation(cwd: string, workflowId: string, kind: "research" | "plan", createDirectory = false) {
  const reserved = reservedWorkflowArtifact(cwd, workflowId, kind);
  const root = realpathSync(cwd);
  const directory = path.dirname(reserved.path);
  if (createDirectory) mkdirSync(directory, { recursive: true });
  if (existsSync(directory)) {
    const realDirectory = realpathSync(directory);
    assertInside(root, realDirectory, "The controller-owned artifact directory");
    if (foldedPath(realDirectory) !== foldedPath(directory)) throw new Error("The controller-owned artifact directory cannot be a symlink or junction.");
  }
  return { ...reserved, root, directory };
}

function readReserved(cwd: string, workflowId: string, kind: "research" | "plan") {
  const location = reservedLocation(cwd, workflowId, kind);
  if (!existsSync(location.path)) return { ...location, text: null as string | null, revision: null as string | null };
  const stat = lstatSync(location.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error(`The reserved ${kind}.md path is not a controller-owned regular file of at most 128 KiB.`);
  const bytes = readFileSync(location.path);
  return { ...location, text: bytes.toString("utf8"), revision: hashBytes(bytes) };
}

function atomicReplaceReserved(cwd: string, workflowId: string, kind: "research" | "plan", expectedRevision: string | null, text: string) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 128 * 1024) throw new Error(`Rendered ${kind}.md must be UTF-8 text of at most 128 KiB.`);
  const location = reservedLocation(cwd, workflowId, kind, true);
  const before = readReserved(cwd, workflowId, kind);
  if (before.revision !== expectedRevision) {
    if (expectedRevision === null && before.revision !== null) throw new Error(`The reserved ${kind}.md path contains an unowned file; no overwrite is authorized.`);
    throw new Error(`The reserved ${kind}.md revision changed before persistence; no stale overwrite was attempted.`);
  }
  const temporary = path.join(location.directory, `.${kind}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const staged = readFileSync(temporary);
    if (hashBytes(staged) !== hashBytes(text)) throw new Error(`The staged ${kind}.md bytes do not match the rendered artifact.`);
    const immediate = readReserved(cwd, workflowId, kind);
    if (immediate.revision !== expectedRevision) throw new Error(`The reserved ${kind}.md revision changed during persistence; no stale overwrite was attempted.`);
    renameSync(temporary, location.path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
  const persisted = readReserved(cwd, workflowId, kind);
  const revision = hashBytes(text);
  if (persisted.revision !== revision || persisted.text !== text) throw new Error(`The persisted ${kind}.md failed its immediate byte/revision recheck.`);
  return {
    path: location.path,
    relativePath: location.relativePath,
    text,
    revision,
    workspaceId: workspaceIdentity(cwd),
  };
}

function validatePlanMarkdown(text: string) {
  if (!/^Status: ready\s*$/m.test(text)) throw new Error("Planner output must contain Status: ready.");
  for (const heading of ["Goal and scope", "Steps and validation", "Design review", "Risk review and revisions", "Acceptance criteria", "Remaining uncertainties", "Execution contract"]) {
    const section = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(text);
    if (!section?.[1].trim()) throw new Error(`Planner output needs a nonempty ${heading} section.`);
  }
  const stepsSection = text.split(/^## Steps and validation\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const count = countPlanSteps(stepsSection);
  if (!count || count > 40) throw new Error(`Planner output needs one to 40 visibly bounded steps; found ${count}.`);
  validateExecutionPlan(text);
  return text;
}

function parsePlannerOutput(output: string, workflow: any) {
  const payload: any = parseVisibleJson(output, "the exact visible Planner output");
  const extra = Object.keys(payload).filter(key => !["planMarkdown", "resolutions"].includes(key));
  if (extra.length) throw new Error(`Planner output contains unsupported fields: ${extra.join(", ")}.`);
  const planMarkdown = validatePlanMarkdown(payload.planMarkdown);
  if (!Array.isArray(payload.resolutions)) throw new Error("Planner output must include a resolutions array, including [] for an initial plan.");
  const findings = workflow.planning?.reviewFindings ?? [];
  if (!findings.length && payload.resolutions.length) throw new Error("An initial Planner output cannot invent finding resolutions.");
  const toPlanRevision = hashBytes(planMarkdown);
  if (findings.length && toPlanRevision === workflow.revision) throw new Error("Current review findings require a materially changed full plan, not a new receipt over identical bytes.");
  if (workflow.plan && workflow.gap && toPlanRevision === workflow.revision) throw new Error("The current revision/recovery gap requires changed plan bytes, not a new receipt over the identical plan.");
  const resolutions: FindingResolution[] = payload.resolutions.map((item: any) => {
    if (!item || typeof item !== "object") throw new Error("Each Planner finding resolution must be an object.");
    const unsupported = Object.keys(item).filter(key => !["findingId", "status", "changedLocations", "explanation"].includes(key));
    if (unsupported.length) throw new Error(`Planner finding resolution contains unsupported fields: ${unsupported.join(", ")}.`);
    return {
      version: 1,
      findingId: item.findingId,
      fromPlanRevision: workflow.revision,
      toPlanRevision,
      status: item.status,
      changedLocations: item.changedLocations,
      explanation: item.explanation,
    };
  });
  if (findings.length) validateFindingResolutions(resolutions, findings, { fromPlanRevision: workflow.revision, toPlanRevision });
  return { planMarkdown, resolutions };
}

function stateSource(kind: "requirement" | "answer" | "research" | "plan" | "finding", source: string, value: unknown, limitation?: string) {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  if (CREDENTIAL_MATERIAL.test(content)) throw new Error(`${source}: mandatory provenance appears credential-bearing. Remove the secret from workflow input before dispatch; it will not be redacted or sent to a child role.`);
  return { kind, source, sourceType: "state" as const, selection: { whole: true as const }, content, ...(limitation ? { limitation } : {}) };
}

function explicitSourceExcerpts(workflow: any) {
  const input = [
    workflow.originalTask,
    ...(workflow.interview?.answers ?? []).map((answer: any) => answer.text),
    ...(workflow.feedback ?? []),
  ].filter((value): value is string => typeof value === "string").join("\n");
  const candidates = new Set<string>();
  const extensionPath = /(?:^|[\s("'`])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:c|cc|cpp|css|csv|go|h|hpp|html|java|js|json|jsx|md|mjs|py|rb|rs|sql|toml|ts|tsx|txt|xml|yaml|yml))(?=$|[\s)"'`,:;.!?])/gimu;
  for (const match of input.matchAll(extensionPath)) candidates.add(match[1]);
  for (const match of input.matchAll(/`([^`\r\n]+)`/gu)) if (!/\s/u.test(match[1])) candidates.add(match[1]);

  const optionalExcerpts: any[] = [];
  const omitted: Array<{ source: string; reason: string }> = [];
  const deniedPaths: string[] = [];
  const seen = new Set<string>();
  let inspected = 0;
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const explicitlyDenied = new RegExp(
      `(?:do\\s+not|don['’]?t|never|must\\s+not|not\\s+to|without|exclude|omit|ignore|forbid)\\s+(?:(?:read|open|inspect|access|use|include|send|share)\\s+)?(?:the\\s+)?[^\\r\\n.;!?]{0,40}${escaped}|${escaped}[^\\r\\n.;!?]{0,40}(?:must\\s+not|should\\s+not|is\\s+private|is\\s+secret|is\\s+denied|is\\s+forbidden)`,
      "iu",
    ).test(input);
    const rawSegments = candidate.toLocaleLowerCase("en-US").split("/");
    const rawPrivate = [".gjc", ".git", ".pi", ".solar-workflow"].includes(rawSegments[0])
      || rawSegments.slice(0, -1).some(segment => ["private", ".private", "secret", "secrets", "credential", "credentials", "session", "sessions"].includes(segment));
    let canonical: string;
    try {
      canonical = canonicalPlanPath(candidate, "explicit provenance path");
    } catch {
      if (explicitlyDenied || rawPrivate) {
        deniedPaths.push(candidate);
        omitted.push({ source: `excluded-workspace-source-${deniedPaths.length}`, reason: "A task-named denied/private source was rejected before any filesystem access or disclosure." });
      }
      continue;
    }
    const folded = canonical.toLocaleLowerCase("en-US");
    if (seen.has(folded)) continue;
    seen.add(folded);
    const segments = folded.split("/");
    const filename = segments.at(-1)!;
    const privateTree = segments.slice(0, -1).some(segment => ["private", ".private", "secret", "secrets", "credential", "credentials", "session", "sessions"].includes(segment))
      || filename.endsWith(".jsonl")
      || /^session(?:[-_.]|$)/iu.test(filename);
    const policyDenied = [".gjc", ".git", ".pi", ".solar-workflow"].includes(segments[0])
      || filename === ".env"
      || filename.startsWith(".env.")
      || [".npmrc", ".netrc", "auth.json", "credentials.json"].includes(filename)
      || filename.endsWith(".pem")
      || filename.endsWith(".key");
    if (explicitlyDenied || privateTree || policyDenied) {
      deniedPaths.push(candidate, canonical);
      omitted.push({
        source: `excluded-workspace-source-${deniedPaths.length / 2}`,
        reason: explicitlyDenied
          ? "A task-named workspace source was explicitly denied and was not opened or disclosed."
          : "A task-named source matched the controller/private/session/credential exclusion policy and was not opened or disclosed.",
      });
      continue;
    }
    if (optionalExcerpts.length >= 20) {
      omitted.push({ source: canonical, reason: "explicit source omitted after the 20-file host selection bound" });
      continue;
    }
    if (inspected >= 80) {
      omitted.push({ source: canonical, reason: "explicit source omitted after the 80-file filesystem-inspection bound" });
      continue;
    }
    inspected += 1;
    const lexical = path.resolve(workflow.cwd, ...canonical.split("/"));
    if (!existsSync(lexical)) {
      omitted.push({ source: canonical, reason: "explicit workspace source does not currently exist" });
      continue;
    }
    try {
      const stat = lstatSync(lexical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
        omitted.push({ source: canonical, reason: "explicit source is not a regular non-symlink file of at most 1 MiB" });
        continue;
      }
      const root = realpathSync(workflow.cwd);
      const real = realpathSync(lexical);
      assertInside(root, real, "Explicit provenance source");
      if (foldedPath(real) !== foldedPath(lexical)) {
        omitted.push({ source: canonical, reason: "explicit source resolves through a symlink or junction" });
        continue;
      }
      const bytes = readFileSync(real);
      const decoded = bytes.toString("utf8");
      if (!decoded || !Buffer.from(decoded, "utf8").equals(bytes) || decoded.includes("\u0000") || CREDENTIAL_MATERIAL.test(decoded)) {
        omitted.push({ source: canonical, reason: "explicit source is not bounded plain UTF-8 text" });
        continue;
      }
      if (bytes.length <= SOLAR_ROLE_EXCERPT_MAX_BYTES) {
        optionalExcerpts.push({ kind: "source_excerpt", source: canonical, sourceType: "workspace", selection: { whole: true }, content: decoded, expectedSha256: hashBytes(decoded) });
        continue;
      }
      let content = "";
      let endLine = 0;
      for (const line of decoded.split(/(?<=\n)/u)) {
        if (!line || Buffer.byteLength(content + line, "utf8") > SOLAR_ROLE_EXCERPT_MAX_BYTES) break;
        content += line;
        endLine += 1;
      }
      if (!content || endLine < 1) {
        omitted.push({ source: canonical, reason: `no complete leading line fits the ${SOLAR_ROLE_EXCERPT_MAX_BYTES}-byte excerpt bound` });
        continue;
      }
      optionalExcerpts.push({
        kind: "source_excerpt",
        source: canonical,
        sourceType: "workspace",
        selection: { startLine: 1, endLine },
        content,
        expectedSha256: hashBytes(content),
        limitation: `Host-selected leading excerpt only; the file is ${bytes.length} bytes and content after line ${endLine} is omitted.`,
      });
    } catch (error) {
      omitted.push({ source: canonical, reason: `explicit source could not be selected safely: ${errorText(error).slice(0, 200)}` });
    }
  }
  return { optionalExcerpts, omitted, deniedPaths: [...new Set(deniedPaths)] };
}

function sanitizedProvenance<T>(value: T, deniedPaths: string[], cwd: string): T {
  if (typeof value === "string") {
    let result = value;
    for (const denied of [...deniedPaths].sort((left, right) => right.length - left.length)) {
      const pattern = new RegExp(denied.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      result = result.replace(pattern, "[explicitly denied workspace source]");
    }
    for (const root of [path.resolve(cwd), path.resolve(cwd).replaceAll("\\", "/")]) {
      const pattern = new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      result = result.replace(pattern, "[workspace]");
    }
    return result as T;
  }
  if (Array.isArray(value)) return value.map(item => sanitizedProvenance(item, deniedPaths, cwd)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizedProvenance(child, deniedPaths, cwd)])) as T;
  }
  return value;
}

function minimizedResearchProvenance(research: any) {
  if (!research) return undefined;
  return {
    version: 2,
    relativePath: research.relativePath,
    revision: research.revision,
    materialDigest: research.materialDigest,
    contract: research.contract,
  };
}

function planningBundle(workflow: any, role: PlanningRole) {
  const selected = explicitSourceExcerpts(workflow);
  const safe = <T>(value: T) => sanitizedProvenance(value, selected.deniedPaths, workflow.cwd);
  const mandatory: any[] = [stateSource("requirement", `workflow:${workflow.id}:original-request`, safe(workflow.originalTask))];
  const interview = workflow.interview;
  for (const answer of interview?.answers ?? []) mandatory.push(stateSource("answer", `interview:${interview.anchorId ?? workflow.interviewAnchor}:answer:${answer.id}`, safe({ id: answer.id, text: answer.text, ...(answer.question ? { question: answer.question } : {}) })));
  if (workflow.research) mandatory.push(stateSource("research", `workflow:${workflow.id}:research:${workflow.research.revision}`, safe(minimizedResearchProvenance(workflow.research))));
  if (interview) mandatory.push(stateSource("requirement", `workflow:${workflow.id}:interview-handoff`, {
    mode: interview.mode,
    confirmedGoal: safe(interview.confirmedGoal),
    unconfirmedGoal: safe(interview.unconfirmedGoal),
    unresolved: safe(interview.unresolved),
    blockers: safe(interview.blockers),
    contradictions: safe(interview.contradictions),
    deferred: safe(interview.deferred),
    planningOnly: interview.planningOnly,
  }));
  if (workflow.gap) mandatory.push(stateSource("requirement", `workflow:${workflow.id}:current-gap`, {
    gap: safe(workflow.gap),
    detour: safe([...(workflow.detours ?? [])].reverse().find((item: any) => !item.outcome || item.target === "plan")),
  }));
  for (const [index, feedback] of (workflow.feedback ?? []).entries()) mandatory.push(stateSource("requirement", `workflow:${workflow.id}:feedback:${index + 1}`, safe(feedback)));
  if (workflow.finalChecks?.length) mandatory.push(stateSource("finding", `workflow:${workflow.id}:final-checks`, safe(workflow.finalChecks)));
  if (Object.keys(workflow.bestRecovery ?? {}).length) mandatory.push(stateSource("finding", `workflow:${workflow.id}:best-recovery`, safe(workflow.bestRecovery)));
  if (workflow.plan?.text) mandatory.push(stateSource("plan", `workflow:${workflow.id}:plan:${workflow.revision}`, workflow.plan.text));
  if (role === "planner") for (const finding of workflow.planning?.reviewFindings ?? []) mandatory.push(stateSource("finding", `workflow:${workflow.id}:finding:${finding.role}:${finding.id}`, finding));
  return buildRoleContextBundle({
    mandatory,
    optionalExcerpts: selected.optionalExcerpts,
    omitted: [
      ...selected.omitted,
      { source: "unselected-workspace-content", reason: "Only paths explicitly named by the task/answers/feedback were eligible; credentials, private state, unrelated sessions, GJC, and repository-control files remain excluded." },
    ],
    exclusions: [
      { source: ".gjc", sourceType: "workspace", match: "tree", reason: "GJC state is outside this workflow." },
      { source: ".git", sourceType: "workspace", match: "tree", reason: "Repository-control state is unrelated provenance." },
      { source: ".pi", sourceType: "workspace", match: "tree", reason: "Pi-private state is never role provenance." },
    ],
  });
}

function plannerSystemPrompt() {
  return "You are the isolated Solar Planner running on Solar Pro4 Max. Use only the host-selected provenance. Think step by step through the reasoning framework below. Produce a complete actionable plan, never product work or a review verdict. Return one visible JSON object and no other text.";
}

function plannerPrompt(workflow: any) {
  const findings = workflow.planning?.reviewFindings ?? [];
  const hints = SOLAR_PRO4_CONTEXT_HINTS?.planner;
  return [
    PLANNER_OUTPUT_SCHEMA,
    "planMarkdown must be a complete Markdown document with # Plan, Status: ready, and nonempty ## Goal and scope, ## Steps and validation, ## Design review, ## Risk review and revisions, ## Acceptance criteria, ## Remaining uncertainties, and ## Execution contract sections.",
    "The Execution contract section must contain exactly one fenced JSON ExecutionContractV3 object. Do not use the schema's descriptive placeholder values in the actual plan.",
    EXECUTION_CONTRACT_V3_SCHEMA,
    EXECUTION_CONTRACT_V3_RULES,
    findings.length
      ? `Material/current findings require a materially changed full plan. resolutions must contain exactly one object per finding with keys findingId, status (resolved or blocked), changedLocations, and explanation. Current findings: ${JSON.stringify(findings)}`
      : "This is an initial plan. resolutions must be [].",
    "Return JSON only. Encode the Markdown as the planMarkdown JSON string. The host computes revision identifiers and owns plan.md persistence.",
    "",
    "<solar-pro4-reasoning>",
    hints?.reasoningFramework ? `Reasoning framework: ${hints.reasoningFramework}` : "",
    hints?.commonFailures ? `Avoid these common failures: ${hints.commonFailures.map(f => `- ${f}`).join("\n")}` : "",
    "</solar-pro4-reasoning>",
  ].filter(Boolean).join("\n");
}

function reviewerSystemPrompt(role: "approach_reviewer" | "critic") {
  const hints = SOLAR_PRO4_CONTEXT_HINTS?.[role];
  return role === "approach_reviewer"
    ? `You are the isolated Solar Approach Reviewer running on Solar Pro4 Max. Independently inspect the full current plan using only host-selected provenance. Think step by step through the reasoning framework. Return one visible PlanReview JSON object and no other text.`
    : `You are the isolated Solar Critic running on Solar Pro4 Max. Independently inspect whole-plan scope, risk, verification, and acceptance using only host-selected provenance. Think step by step through the reasoning framework. Return one visible PlanReview JSON object and no other text.`;
}

function reviewerPrompt(workflow: any, role: "approach_reviewer" | "critic") {
  const focus = role === "critic"
    ? "whole_plan_scope_risk_verification_acceptance"
    : workflow.plan.contract.domain === "software"
      ? "software_architecture_feasibility"
      : "research_methodology_evidence_structure";
  const hints = SOLAR_PRO4_CONTEXT_HINTS?.[role];
  return [
    PLAN_REVIEW_SCHEMA,
    PLAN_REVIEW_RULES,
    "The current plan being reviewed uses the following exact contract and reference rules:",
    EXECUTION_CONTRACT_V3_SCHEMA,
    EXECUTION_CONTRACT_V3_RULES,
    `Use version 1, role ${JSON.stringify(role)}, exact planRevision ${JSON.stringify(workflow.revision)}, domain ${JSON.stringify(workflow.plan.contract.domain)}, and assessment.focus ${JSON.stringify(focus)}.`,
    "Inspect the full plan rather than accepting its selfCheck. State the correlated same-model limitation. Return JSON only; no fence or commentary is required.",
    "",
    "<solar-pro4-reasoning>",
    hints?.reasoningFramework ? `Reasoning framework: ${hints.reasoningFramework}` : "",
    hints?.commonFailures ? `Avoid these common failures: ${hints.commonFailures.map(f => `- ${f}`).join("\n")}` : "",
    "</solar-pro4-reasoning>",
  ].filter(Boolean).join("\n");
}

export function installLiteRuntime(pi: ExtensionAPI, options: any = {}) {
  let context: any;
  let interview: any;
  let interviewPause: any;
  let unsupportedInterview: any;
  let closure: any;
  let workflow: any;
  let active = false;
  let anchorId: string | undefined;
  let answers: any[] = [];
  let korean = false;
  let rateFetch: any;
  let currentAnswerId: string | undefined;
  let settledReport = false;
  let reviewing = false;
  let repairs = 0;
  let toolCalls = 0;
  let closed = false;
  let modelReady = false;
  let originalTools: string[] | undefined;
  let originalToolsWorkflowId: string | undefined;
  let pendingNote: string | undefined;
  let pendingPhase: "processing" | "retrying" | "stopped" = "processing";
  let checkpointing = false;
  let webBusy = false;
  let planningRunner: SolarRoleRunner | undefined;
  const authorizedCalls = new Map<string,
    | { kind: "execution"; status: "pending" | "invalidated" | "consumed"; expectation: DispatchExpectation; operation: any; reason?: string }
    | { kind: "other"; status: "pending" | "consumed" }
  >();
  const tavily = createTavilyClient(options.web);
  const documents = createDocumentClient(options.documents);

  function branch(ctx = context) {
    return ctx?.sessionManager?.getBranch?.() ?? [];
  }

  function safeNotify(ctx: any, message: string, level: "info" | "error" = "error") {
    try {
      ctx?.ui?.notify?.(message, level);
    } catch {
      // UI failures must not turn a handled authority refusal into inference.
    }
  }

  function invalidateExecutionCalls(reason: string) {
    for (const [toolCallId, entry] of authorizedCalls) {
      if (entry.kind === "execution" && entry.status === "pending") authorizedCalls.set(toolCallId, { ...entry, status: "invalidated", reason });
    }
  }

  function rememberOtherCall(toolCallId: string) {
    authorizedCalls.set(toolCallId, { kind: "other", status: "pending" });
  }

  function staleToolResult(message: string) {
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
      details: { staleExecutionResult: true },
    };
  }

  function isDeclaredExecutionTool(current: any, toolName: string) {
    return !CONTROL_TOOLS.includes(toolName)
      && Boolean(current?.plan?.contract?.capabilities?.some((capability: any) => capability.tool === toolName));
  }

  function currentWorkflow(ctx = context) {
    return recoverWorkflow(branch(ctx));
  }

  function researchHead(current = workflow) {
    return current?.research?.revision ?? null;
  }

  function currentResearchHashes(current = workflow) {
    const hashes = new Set<string>();
    const receiptIds = new Set(current?.research?.contract?.sources?.flatMap((source: any) => source.receiptIds) ?? []);
    for (const receipt of current?.webEvidence ?? []) {
      if (receipt.status !== "ok" || !receiptIds.has(receipt.id)) continue;
      for (const result of receipt.results ?? []) if (typeof result.content === "string" && result.content) hashes.add(interviewContentHash(result.content));
    }
    return [...hashes];
  }

  function currentArtifactRefs(current = workflow) {
    return current?.research?.relativePath ? [current.research.relativePath] : [];
  }

  function solarProblem(ctx: any) {
    try {
      const configured: any = requireSolarMaxModel(ctx.modelRegistry);
      const selected = ctx.model;
      const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
      if (configured.provider !== "upstage" || configured.id !== "solar-pro4") return "Solar workflows require registry-confirmed upstage/solar-pro4.";
      if (selected?.provider !== "upstage" || selected?.id !== "solar-pro4") return "Solar workflows require the current model upstage/solar-pro4. No automatic model switch was made.";
      if (thinking !== "max") return "Solar workflows require the current thinking level max. No automatic thinking-level change was made.";
      return undefined;
    } catch (error) {
      return errorText(error);
    }
  }

  function refreshModelReady(ctx: any) {
    modelReady = !solarProblem(ctx);
    return modelReady;
  }

  function requireSolarHost(ctx: any) {
    const problem = solarProblem(ctx);
    modelReady = !problem;
    if (problem) throw new Error(problem);
    return requireSolarMaxModel(ctx.modelRegistry);
  }

  function refreshAnswers(ctx: any) {
    const recovered = recoverInterview(branch(ctx), { researchHead: researchHead(currentWorkflow(ctx)) });
    if (recovered.anchorId !== anchorId) interview = recovered.state;
    else if (recovered.state) interview = recovered.state;
    interviewPause = recovered.pause;
    unsupportedInterview = recovered.unsupportedState;
    closure = recovered.closure;
    answers = recovered.answers;
    anchorId = recovered.anchorId;
    if (workflow?.stage === "interview" && anchorId && workflow.interviewAnchor !== anchorId) saveWorkflow({ ...workflow, interviewAnchor: anchorId });
    korean = /[가-힣]/.test(answers.map(answer => answer.text).join("\n"));
    const latest = answers.at(-1)?.id;
    if (latest && latest !== currentAnswerId) {
      currentAnswerId = latest;
      repairs = 0;
      toolCalls = 0;
      settledReport = false;
      reviewing = recovered.reviewing;
      pendingNote = undefined;
      pendingPhase = "processing";
    }
  }

  function restore(ctx: any) {
    context = ctx;
    const entries = branch(ctx);
    workflow = recoverWorkflow(entries);
    if (workflow && !matchesWorkflowWorkspace(workflow, ctx.cwd)) workflow = { ...workflow, status: "workspace_mismatch" };
    const recovered = recoverInterview(entries, { researchHead: researchHead(workflow) });
    interview = recovered.state;
    interviewPause = recovered.pause;
    unsupportedInterview = recovered.unsupportedState;
    closure = recovered.closure;
    reviewing = recovered.reviewing;
    active = recovered.active && (!workflow || (workflow.stage === "interview" && workflow.status === "active"));
    anchorId = recovered.anchorId;
    answers = recovered.answers;
    korean = /[가-힣]/.test(answers.map(answer => answer.text).join("\n"));
    const toolEntry = [...entries].reverse().find(entry => entry.type === "custom"
      && (entry.customType === "solar-runtime-tools-v2" || entry.customType === "solar-interview-tools-v1")
      && (entry.data?.workflowId === undefined || entry.data.workflowId === workflow?.id));
    if (toolEntry?.data?.tools) {
      originalTools = toolEntry.data.tools;
      originalToolsWorkflowId = toolEntry.data.workflowId ?? workflow?.id;
    }
    settledReport = !reviewing && Boolean(answers.length && interview?.answerHead === answers.at(-1)?.id && interview?.researchHead === researchHead(workflow));
    if (settledReport) pendingNote = undefined;
    if (!settledReport && ctx.isIdle()) pendingPhase = "stopped";
    refreshModelReady(ctx);
    restoreTools();
    showInterview();
    showWorkflow();
  }

  function reportText(state: any, useKorean = korean) {
    return [renderCurrentInterview(state, useKorean), interviewDisplayNote(state, useKorean)].filter(Boolean).join("\n");
  }

  function progressText() {
    if (interviewPause) return interviewPause.reason;
    if (closure && workflow && ["plan", "execute"].includes(workflow.stage)) return `Solar: ${workflow.stage}. Interview closure and saved evidence are preserved; execution still requires reviewed-plan approval.`;
    if (closure) return renderInterviewClosure(closure, korean);
    const pending = active && (reviewing || pendingNote || !interview || interview.answerHead !== answers.at(-1)?.id || interview.researchHead !== researchHead(workflow));
    return pending ? renderPendingInterview(interview, korean, pendingNote, pendingPhase) : reportText(interview);
  }

  function showInterview(note?: string, phase = pendingPhase) {
    if (!context) return;
    if (interview?.status === "paused" && workflow?.stage === "interview") {
      context.ui.setWidget("solar-interview", renderCurrentInterview(interview, korean).split("\n"));
      return;
    }
    if (interviewPause && (!workflow || workflow.stage === "interview")) {
      context.ui.setWidget("solar-interview", [interviewPause.reason, ...interviewPause.choices.map((choice: any) => `${choice.id}: ${choice.label}`)]);
      return;
    }
    if (workflow && (workflow.stage !== "interview" || workflow.status !== "active")) {
      context.ui.setWidget("solar-interview", undefined);
      return;
    }
    if (closure) {
      context.ui.setWidget("solar-interview", workflow && ["plan", "execute"].includes(workflow.stage) ? undefined : renderInterviewClosure(closure, korean).split("\n"));
      return;
    }
    if (!active && !interview) {
      context.ui.setWidget("solar-interview", undefined);
      return;
    }
    if (note) pendingNote = note;
    pendingPhase = phase;
    const pending = active && (reviewing || pendingNote || !interview || interview.answerHead !== answers.at(-1)?.id || interview.researchHead !== researchHead(workflow));
    const state = interview;
    const useKorean = korean;
    const displayNote = pendingNote;
    context.ui.setWidget("solar-interview", (_tui: any, theme: any) => new Text(
      pending ? renderStyledPendingInterview(state, useKorean, theme, displayNote, phase) : renderStyledInterview(state, useKorean, theme),
      0, 0,
    ));
  }

  function saveInterview(next: any) {
    interview = next;
    pendingNote = undefined;
    pi.appendEntry(INTERVIEW_STATE, next);
    if (workflow?.stage === "interview") {
      const interviewRecord = {
        version: 2,
        anchorId,
        answerHead: next.answerHead,
        researchHead: next.researchHead,
        answers,
        assessment: next,
        assessmentCurrent: next.answerHead === answers.at(-1)?.id && next.researchHead === researchHead(workflow),
        materialState: next.materialState,
        readiness: next.proposal.readiness,
        strategy: next.strategy,
      };
      saveWorkflow({
        ...workflow,
        interviewAnchor: anchorId,
        interview: interviewRecord,
        ...(next.status === "paused" ? { status: "paused", reason: next.recovery?.blocker ?? "Interview paused at a material-information boundary.", pendingHandoff: false } : {}),
      });
    }
    showInterview();
  }

  function saveWorkflow(next: any) {
    workflow = next;
    const snapshots = Object.fromEntries(Object.entries(next.snapshots ?? {}).map(([filename, snapshot]: [string, any]) => {
      const { content, ...metadata } = snapshot;
      if (content !== undefined) {
        const exists = branch().some(entry => entry.type === "custom" && entry.customType === SNAPSHOT_STATE && entry.data?.workflowId === next.id && entry.data?.path === filename && entry.data?.hash === snapshot.hash);
        if (!exists) pi.appendEntry(SNAPSHOT_STATE, { workflowId: next.id, ...snapshot });
      }
      return [filename, { ...metadata, storedContent: content !== undefined }];
    }));
    pi.appendEntry(WORKFLOW_STATE, next.snapshots ? { ...next, snapshots } : next);
    context?.ui.setStatus("solar-workflow", `Solar: ${next.stage} · ${next.status}`);
    showInterview();
    showWorkflow();
  }

  function showWorkflow() {
    const waiting = ["awaiting_gate_review", "awaiting_final_review", "paused", "limited", "revision_required"].includes(workflow?.status);
    context?.ui.setWidget("solar-workflow", waiting ? [
      `Solar: ${workflow.stage} · ${workflow.status}`,
      workflow.reason ?? "Inspect current evidence and choose the explicit next boundary.",
      workflow.plan ? `Plan: ${workflow.plan.relativePath ?? workflow.plan.path}` : "Controller-owned artifacts and checkpoints are preserved.",
      workflow.status === "awaiting_gate_review" ? `/solar-workflow status → /solar-workflow approve ${workflow.revision.slice(0, 12)}` : workflow.status === "awaiting_final_review" ? `/solar-workflow status → /solar-workflow accept ${workflow.finalReview.slice(0, 12)}` : "/solar-workflow status | resume | stop",
      "Change the plan/outcome: /solar-workflow revise <feedback>",
    ] : undefined);
  }

  function workflowError(error: unknown) {
    return { content: [{ type: "text" as const, text: errorText(error) }], details: { workflowValidationError: true }, terminate: true };
  }

  function stageTools(current = workflow) {
    if (!current || current.status !== "active") return undefined;
    if (current.stage === "research") return ["read", "solar_research_ready", ...(current.returns?.length ? ["solar_revisit"] : []), ...(current.webPolicy === "local-only" ? [] : WEB_TOOLS)];
    if (current.stage === "interview") return ["read", "solar_interview_round", "solar_revisit"];
    if (current.stage === "plan") return ["read", "solar_plan_ready", "solar_revisit"];
    if (current.stage === "execute") {
      const step = nextStep(current);
      const declared = step?.capabilities?.flatMap((id: string) => current.plan.contract.capabilities.filter((capability: any) => capability.id === id).map((capability: any) => capability.tool)) ?? [];
      const available = new Set(pi.getAllTools?.().map((tool: any) => tool.name) ?? pi.getActiveTools());
      return [...new Set([...declared.filter((name: string) => available.has(name)), "solar_step_done", "solar_revisit"])];
    }
    return [];
  }

  function restoreTools() {
    const current = workflow;
    const filterBase = (names: string[]) => names.filter(name => !CONTROL_TOOLS.includes(name) && !/^lite_(?:interview_round|research_ready|plan_ready|revisit|step_done|web_search|web_read|document_read)$/.test(name));
    if (current?.id && originalToolsWorkflowId !== current.id) {
      originalTools = filterBase(pi.getActiveTools());
      originalToolsWorkflowId = current.id;
      pi.appendEntry("solar-runtime-tools-v2", { workflowId: current.id, tools: originalTools });
    }
    const base = filterBase(originalTools ?? pi.getActiveTools());
    originalTools ??= base;
    const constrained = stageTools(current);
    if (constrained) pi.setActiveTools(constrained);
    else if (["awaiting_gate_review", "awaiting_final_review", "paused", "limited", "revision_required", "workspace_mismatch"].includes(current?.status)) pi.setActiveTools(["read"]);
    else pi.setActiveTools(base);
  }

  function launchStage(stage: "research" | "interview" | "plan" | "execute", instruction: string) {
    requireSolarHost(context);
    active = stage === "interview";
    if (active) {
      const recovered = recoverInterview(branch(), { researchHead: researchHead(workflow) });
      const resuming = Boolean(workflow?.interviewAnchor && workflow.interviewAnchor === recovered.anchorId && recovered.answers.length);
      instruction = resuming ? `resume ${instruction.replace(/^resume\s+/, "")}` : `Original user request: ${workflow?.originalTask ?? instruction}\n${instruction}`;
      if (resuming) {
        answers = recovered.answers;
        interview = recovered.state;
        anchorId = recovered.anchorId;
        // A changed research head is new evidence, not a same-head report repair.
        // assessInterview records it as research_return when reassess remains false.
        reviewing = false;
      }
      settledReport = false;
      currentAnswerId = undefined;
      closure = undefined;
    }
    restoreTools();
    pi.sendUserMessage(`/skill:solar-${stage} ${instruction}`, { deliverAs: "followUp", expandPromptTemplates: true });
  }

  function diskPlanSnapshot(ctx: any, current: any) {
    if (!current?.plan?.path) throw new Error("No controller-owned plan is available.");
    const artifact = readWorkflowArtifact(ctx.cwd, current.plan.path, "plan");
    return { workspaceId: artifact.workspaceId, path: artifact.path, text: artifact.text, revision: artifact.revision };
  }

  function authorityGuard(ctx: any) {
    return async (expectation: DispatchExpectation) => {
      if (!modelReady || solarProblem(ctx)) throw new Error("Solar model/thinking identity changed; no execution dispatch or commit is authorized.");
      const fresh = currentWorkflow(ctx);
      if (!fresh || !matchesWorkflowWorkspace(fresh, ctx.cwd)) throw new Error("The workflow or workspace identity changed during verification.");
      return { fresh, diskPlan: diskPlanSnapshot(ctx, fresh) };
    };
  }

  function operationForTool(event: any, current: any, step: any) {
    if (["bash", "powershell"].includes(event.toolName)) return { tool: event.toolName, access: "command", command: event.input?.command };
    if (["write", "edit"].includes(event.toolName)) return { tool: event.toolName, access: "write", path: event.input?.path };
    if (["read", "grep", "find", "ls"].includes(event.toolName)) return { tool: event.toolName, access: "read", path: event.input?.path };
    const capabilities = step?.capabilities
      ?.map((id: string) => current.plan.contract.capabilities.find((capability: any) => capability.id === id))
      .filter((capability: any) => capability?.tool === event.toolName) ?? [];
    const kinds = [...new Set(capabilities.map((capability: any) => capability.kind))];
    if (kinds.length !== 1) return undefined;
    const access = kinds[0] as "read" | "write" | "command";
    return access === "command"
      ? { tool: event.toolName, access, command: event.input?.command }
      : { tool: event.toolName, access, path: event.input?.path };
  }

  function researchSubmissionIdentity(current: any) {
    const disk = readReserved(current.cwd, current.id, "research");
    const validation = researchValidationContext(current, disk.revision);
    return {
      expectedArtifactRevision: validation.currentArtifactRevision,
      diskArtifactRevision: validation.diskArtifactRevision,
      mode: validation.mode,
      gapId: validation.gapId,
      answerHeadId: validation.answerHeadId,
      startEvidenceDigest: validation.startEvidenceDigest,
    };
  }

  function assertPublicResearchEvidence(current: any, submission: any) {
    if (current.webPolicy === "local-only" || submission.contract.outcome === "blocked") return;
    const receipts = webReceipts(current).filter(item => item.status === "ok");
    const hasSearch = receipts.some(item => item.kind === "search");
    const evidenceClaims = submission.contract.claims.filter((claim: any) => claim.kind === "evidence" && claim.sourceIds.length);
    if (!hasSearch || !evidenceClaims.length) {
      throw new Error("A ready/narrowed public research pass requires a successful current-pass search and at least one evidence claim backed by a current read/document receipt. Submit a truthful blocked outcome when evidence is unavailable.");
    }
  }

  function additionalWorkflowContext(current = workflow) {
    if (!current || current.status !== "active") return "";
    if (current.stage === "research") {
      try {
        return `\nSOLAR RESEARCH SUBMISSION IDENTITY (host-owned, use exact values): ${JSON.stringify(researchSubmissionIdentity(current))}`;
      } catch (error) {
        return `\nSOLAR RESEARCH SUBMISSION BLOCKER: ${errorText(error)}`;
      }
    }
    return "";
  }

  async function finishSavedInterview(ctx: any, request: string, advance = true, planOnly = false) {
    if (closure) return;
    if (!answers.length || !anchorId) throw new Error("No saved interview answer is available for closure.");
    if (advance && workflow && !matchesWorkflowWorkspace(workflow, ctx.cwd)) throw new Error("Resume this workflow in its original workspace before starting planning.");
    if (advance) requireSolarHost(ctx);
    const token = interviewConfirmationToken(request);
    if (token) {
      closure = confirmInterview(interview, answers, anchorId, token, {
        researchHead: researchHead(workflow),
        reviewPending: reviewing,
        request,
        planOnly: planOnly || !workflow?.autoExecute,
      });
    } else {
      closure = finishInterview(interview ?? unsupportedInterview, answers, anchorId, request, reviewing, {
        researchHead: researchHead(workflow),
        planOnly: planOnly || !workflow?.autoExecute,
        artifactRefs: currentArtifactRefs(workflow),
      });
    }
    active = false;
    reviewing = false;
    settledReport = true;
    pendingNote = undefined;
    pi.appendEntry(INTERVIEW_CLOSURE_STATE, closure);
    if (!ctx.isIdle()) ctx.abort();
    if (ctx.waitForIdle) await ctx.waitForIdle();
    restoreTools();
    showInterview();
    pi.sendMessage({ customType: "solar-interview-handoff-v2", content: `The user ${closure.mode === "normal" ? "confirmed the exact current goal" : "explicitly ended early"}. Preserve the V2 answer/research heads, material state, readiness, unresolved/deferred items, and planning-only boundary. This grants no execution authority.\n${JSON.stringify(closure)}`, display: false });
    if (advance) {
      let current = workflow ?? startWorkflow("interview", answers[0].text, ctx.cwd);
      if (current.detours?.some((item: any) => item.target === "interview" && !item.outcome)) {
        const outcome = closure.mode === "normal" ? "answered" : "blocked";
        const endEvidenceDigest = structuredRevision({
          mode: closure.mode,
          anchorId: closure.anchorId,
          answerHead: closure.answerHead,
          researchHead: closure.researchHead,
          confirmedGoal: closure.confirmedGoal ?? null,
          unresolved: closure.unresolved,
          blockers: closure.blockers,
          contradictions: closure.contradictions,
          deferred: closure.deferred,
        });
        current = completeWorkflowDetour(current, { target: "interview", outcome, endEvidenceDigest });
      }
      saveWorkflow({
        ...current,
        stage: "plan",
        status: "active",
        returns: [],
        interview: closure,
        interviewAnchor: anchorId,
        approval: undefined,
        approvalArtifactTableRevision: undefined,
        pendingHandoff: true,
        autoExecute: !closure.planningOnly && current.autoExecute,
        reminder: 0,
      });
      if (workflow.turns >= workflow.limits.turns || workflow.cycle > workflow.limits.cycles) {
        const kind = workflow.turns >= workflow.limits.turns ? "turns" : "cycles";
        saveWorkflow({ ...workflow, status: "limited", limitStop: { kind, bound: workflow.limits[kind] }, pendingHandoff: false, reason: "Interview closure is saved. Raise exhausted workflow limits before host-owned planning." });
        restoreTools();
        return;
      }
      launchStage("plan", "Trigger host-owned Planner, Approach Reviewer, and Critic sessions with solar_plan_ready({}). Do not write plan.md or invent review receipts.");
    } else if (workflow) {
      saveWorkflow({ ...workflow, status: "stopped", pendingHandoff: false, reason: "Stopped by user with saved interview history; no planning or execution was started." });
      restoreTools();
    }
  }

  function roleBoundary(ctx: any, expectedWorkflowId: string): SolarRoleAttemptBoundary {
    function freshFor(identity?: SolarRoleIdentity) {
      if (closed || !modelReady || solarProblem(ctx)) throw new Error("Solar role boundary is no longer current after stop, shutdown, or model drift.");
      const fresh = currentWorkflow(ctx);
      if (!fresh || fresh.id !== expectedWorkflowId || fresh.stage !== "plan" || !["active", "reviewing_plan", "revision_required"].includes(fresh.status) || !matchesWorkflowWorkspace(fresh, ctx.cwd)) {
        throw new Error("Solar role boundary is stale for the current workflow/workspace/status.");
      }
      if (fresh.plan) {
        const disk = readReserved(ctx.cwd, fresh.id, "plan");
        if (disk.revision !== fresh.revision) throw new Error("The controller-owned plan bytes changed during a role attempt.");
      }
      if (identity) {
        const attempt = (fresh.roleAttempts ?? []).find((item: any) => item.attemptId === identity.attemptId);
        if (!attempt || attempt.status !== "pending" || attempt.contextId !== identity.contextId || attempt.role !== identity.role || attempt.inputRevision !== identity.inputRevision || attempt.planRevision !== identity.planRevision) throw new Error("Solar role attempt identity is stale.");
      }
      return fresh;
    }
    return {
      reserveAttempt(input) {
        const fresh = freshFor();
        const currentPlanRevision = fresh.revision;
        if (input.workflowId !== expectedWorkflowId || input.planRevision !== currentPlanRevision) throw new Error("Solar role reservation does not bind the current plan revision.");
        const next = reserveRoleAttempt(fresh, input);
        saveWorkflow(next);
        return { attemptOrdinal: next.budgets.roleCalls };
      },
      current(identity) {
        try { freshFor(identity); return true; }
        catch { return false; }
      },
      recordAttempt(attempt: SolarRoleAttempt) {
        const fresh = currentWorkflow(ctx);
        const pending = fresh?.id === expectedWorkflowId && (fresh.roleAttempts ?? []).find((item: any) => item.attemptId === attempt.attemptId && item.status === "pending");
        if (!pending) return;
        const status = attempt.status === "timed_out" ? "timed_out" : attempt.status === "cancelled" ? "cancelled" : attempt.status === "stale" ? "stale" : "failed";
        saveWorkflow(settleRoleAttempt(fresh, attempt.attemptId, status, attempt.terminalReason ?? "Role attempt ended without a current visible output commit."));
      },
      commit(result: SolarRoleResult) {
        const fresh = freshFor(result.attempt);
        let next = settleRoleAttempt(fresh, result.attempt.attemptId, "succeeded", "Exact visible Solar role output committed while workflow identity was current.");
        const committed = {
          attemptId: result.receipt.attemptId,
          contextId: result.receipt.contextId,
          role: result.receipt.role,
          inputRevision: result.receipt.inputRevision,
          planRevision: result.receipt.planRevision,
          outputRevision: result.receipt.outputRevision,
          receipt: result.receipt,
          outputBytes: Buffer.byteLength(result.output, "utf8"),
          outputEntryType: ROLE_OUTPUT_STATE,
        };
        next = { ...next, roleCommits: [...(next.roleCommits ?? []), committed].slice(-next.limits.roleCalls) };
        pi.appendEntry(ROLE_OUTPUT_STATE, { workflowId: next.id, ...committed, output: result.output });
        saveWorkflow(next);
      },
    };
  }

  async function runParsedRole<T>(runner: SolarRoleRunner, ctx: any, current: any, role: PlanningRole, bundle: any, systemPrompt: string, prompt: string, parse: (output: string, fresh: any) => T, signal?: AbortSignal): Promise<{ parsed: T; result: SolarRoleResult }> {
    let repairOf: string | undefined;
    let repairPrompt = prompt;
    for (;;) {
      let result: SolarRoleResult | undefined;
      try {
        result = await runner.run({
          workflowId: current.id,
          role,
          inputRevision: bundle.bundleRevision,
          ...(current.revision ? { planRevision: current.revision } : {}),
          ...(repairOf ? { repairOf } : {}),
          systemPrompt,
          prompt: repairPrompt,
          bundle,
          signal,
        }, roleBoundary(ctx, current.id));
        if (signal?.aborted) throw new Error("Solar planning was cancelled before role-output validation.");
        const fresh = currentWorkflow(ctx);
        if (!fresh || fresh.id !== current.id || fresh.stage !== "plan" || (fresh.revision ?? undefined) !== (current.revision ?? undefined) || !modelReady) throw new Error("Solar role output became stale before validation.");
        return { parsed: parse(result.output, fresh), result };
      } catch (error: any) {
        const stale = signal?.aborted || closed || !modelReady || ["request_cancelled", "stale_identity", "stopped", "shutdown", "runner_shutdown"].includes(error?.code);
        if (stale) throw error;
        const attemptId = result?.receipt.attemptId ?? error?.attempt?.attemptId;
        if (!attemptId) throw error;
        const fresh = currentWorkflow(ctx);
        if (!fresh || fresh.id !== current.id || fresh.stage !== "plan" || (fresh.revision ?? undefined) !== (current.revision ?? undefined)) throw error;
        saveWorkflow({ ...fresh, roleValidationFailures: [...(fresh.roleValidationFailures ?? []), { role, attemptId, error: errorText(error) }].slice(-fresh.limits.roleRepairs) });
        repairOf = attemptId;
        const prior = result?.output ? result.output.slice(0, 16_000) : "No valid visible output was captured.";
        repairPrompt = `${prompt}\n\nREPAIR OF ${attemptId}: ${errorText(error)}\nReturn a complete corrected response, not a patch. Prior visible output (untrusted):\n${prior}`;
      }
    }
  }

  async function runPlanningCycle(ctx: any, signal?: AbortSignal) {
    const initial = currentWorkflow(ctx);
    if (!initial || initial.stage !== "plan" || initial.status !== "active" || !matchesWorkflowWorkspace(initial, ctx.cwd)) throw new Error("No active plan stage accepts host-owned planning.");
    const solarMaxModel = requireSolarHost(ctx);
    const sdk = options.sdk ?? { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager };
    const sessionFactory = options.roleSessionFactory ?? createPiSdkSolarRoleSessionFactory({
      sdk,
      cwd: ctx.cwd,
      agentDir: options.agentDir ?? getAgentDir(),
      solarMaxModel,
      ...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
    });
    const runner = createSolarRoleRunner({
      sessionFactory,
      diagnostic(diagnostic) {
        pi.appendEntry(ROLE_DIAGNOSTIC_STATE, { workflowId: initial.id, ...diagnostic });
        if (diagnostic.level === "error") context?.ui.notify(diagnostic.message, "error");
      },
      ...(options.roleClock ? { clock: options.roleClock } : {}),
      ...(options.roleIdFactory ? { idFactory: options.roleIdFactory } : {}),
    });
    planningRunner = runner;
    try {
      for (;;) {
        let current = currentWorkflow(ctx);
        if (!current || current.id !== initial.id || current.stage !== "plan" || !["active", "revision_required"].includes(current.status)) throw new Error("Planning workflow changed before the next Planner attempt.");
        if (current.budgets.reviewRevisions >= current.limits.reviewRevisions) throw new Error(`Plan review-revision budget exhausted (${current.limits.reviewRevisions}); current artifacts, findings, and receipts remain preserved.`);
        const plannerBundle = planningBundle(current, "planner");
        const planner = await runParsedRole(runner, ctx, current, "planner", plannerBundle, plannerSystemPrompt(), plannerPrompt(current), parsePlannerOutput, signal);
        current = currentWorkflow(ctx);
        const expectedPlanRevision = current.plan?.revision ?? null;
        const persisted = atomicReplaceReserved(ctx.cwd, current.id, "plan", expectedPlanRevision, planner.parsed.planMarkdown);
        current = currentWorkflow(ctx);
        if (!current || current.id !== initial.id || current.stage !== "plan" || !["active", "revision_required"].includes(current.status) || (current.plan?.revision ?? null) !== expectedPlanRevision) throw new Error("Planning workflow changed before the current plan artifact commit.");
        saveWorkflow(beginPlanRevision(current, persisted, {
          plannerReceipt: planner.result.receipt as SolarRoleReceipt,
          inputRevision: plannerBundle.bundleRevision,
          visibleOutput: planner.result.output,
          resolutions: planner.parsed.resolutions,
        }));
        current = currentWorkflow(ctx);
        if (current.planning?.revisionState === "blocked") throw new Error(current.reason ?? "A finding resolution remains blocked.");

        for (const role of ["approach_reviewer", "critic"] as const) {
          current = currentWorkflow(ctx);
          if (!current || current.id !== initial.id || current.status !== "reviewing_plan" || current.planning?.revisionState !== "awaiting_reviews") throw new Error("Plan review state changed before both current-revision reviews completed.");
          const bundle = planningBundle(current, role);
          const reviewed = await runParsedRole(runner, ctx, current, role, bundle, reviewerSystemPrompt(role), reviewerPrompt(current, role), output => parseVisibleJson(output, `the exact visible ${role} output`), signal);
          current = currentWorkflow(ctx);
          if (!current || current.revision !== reviewed.result.receipt.planRevision) throw new Error(`${role} output became stale before review commit.`);
          saveWorkflow(recordPlanReview(current, reviewed.parsed, reviewed.result.receipt, bundle.bundleRevision, reviewed.result.output));
        }

        current = currentWorkflow(ctx);
        if (current.status === "revision_required") continue;
        if (current.status !== "reviewing_plan" || current.planning?.revisionState !== "ready_to_complete") throw new Error("Current plan reviews did not reach a valid completion boundary.");
        saveWorkflow(completePlanReview(current, { alignment: CORRELATED_ALIGNMENT, conflicts: [] }));
        restoreTools();
        return workflow;
      }
    } finally {
      if (planningRunner === runner) planningRunner = undefined;
      runner.shutdown();
    }
  }

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return;
    const stage = invokedSkill(event.text);
    let persisted: any;
    try {
      persisted = currentWorkflow(ctx);
    } catch (error) {
      const hasWorkflowState = branch(ctx).some((entry: any) => entry.type === "custom" && entry.customType === WORKFLOW_STATE);
      if (stage || hasWorkflowState) {
        safeNotify(ctx, `Solar host state is unreadable; inference was refused: ${errorText(error)}`);
        return { action: "handled" };
      }
      return;
    }
    const commandInput = /^\/solar-(?:workflow|interview|rate|web)\b/u.test(event.text.trim());
    if (stage === "execute") {
      safeNotify(ctx, "Execution cannot be started directly. Approve the exact fully reviewed plan revision through /solar-workflow approve.");
      return { action: "handled" };
    }
    const modelIssue = solarProblem(ctx);
    if ((stage || (persisted?.status === "active" && !commandInput)) && modelIssue) {
      safeNotify(ctx, modelIssue);
      return { action: "handled" };
    }
    try {
      restore(ctx);
    } catch (error) {
      if (stage || persisted?.status === "active") {
        safeNotify(ctx, `Solar host state could not be restored safely before inference: ${errorText(error)}`);
        return { action: "handled" };
      }
      return;
    }
    if (stage && workflow?.status === "active" && stage !== workflow.stage) {
      const boundary = workflow.stage === "interview"
        ? "Confirm the exact current goal token or explicitly use /solar-interview finish."
        : workflow.stage === "research"
          ? "Submit and persist a valid ResearchContractV2 or stop the workflow explicitly."
          : "Finish, revise, or stop the current reviewed workflow explicitly.";
      safeNotify(ctx, `A new ${stage} stage cannot bypass the active ${workflow.stage} boundary. ${boundary}`);
      return { action: "handled" };
    }
    const confirmation = interviewConfirmationToken(event.text);
    if (!confirmation && !isInterviewFinishRequest(event.text)) return;
    if (workflow && workflow.stage !== "interview") return;
    if ((!active && !interviewPause && !interview) || !answers.length) return;
    try {
      await finishSavedInterview(ctx, event.text, true, /(?:--)?plan-only|계획만/u.test(event.text));
    } catch (error) {
      safeNotify(ctx, errorText(error));
    }
    return { action: "handled" };
  });

  pi.on("session_start", (_event, ctx) => {
    closed = false;
    restore(ctx);
    if (interviewPause && workflow?.stage === "interview" && workflow.status === "active") {
      saveWorkflow({ ...workflow, status: "paused", pendingHandoff: false, approval: undefined, approvalArtifactTableRevision: undefined, reason: interviewPause.reason });
      active = false;
      restoreTools();
    } else if (workflow?.status === "active" && workflow.stage !== "interview") {
      saveWorkflow({ ...workflow, status: "paused", reason: "Reloaded or resumed an unfinished stage. Checkpoints and controller artifacts are saved; use /solar-workflow resume to continue.", pendingHandoff: false });
      restoreTools();
    }
    const delegates: WeakMap<object, any> = (globalThis as any)[DELEGATES] ??= new WeakMap();
    const native: any = delegates.get(ctx.modelRegistry) ?? ctx.modelRegistry.getProvider("upstage");
    if (!native?.streamSimple) return;
    delegates.set(ctx.modelRegistry, native);
    let baseFetch: any;
    pi.registerProvider("upstage", {
      api: "openai-completions",
      streamSimple(model, messages, streamOptions) {
        if (model.id !== "solar-pro4") return native.streamSimple(model, messages, streamOptions);
        const suppliedFetch = streamOptions?.fetch ?? globalThis.fetch;
        if (!rateFetch || baseFetch !== suppliedFetch) {
          baseFetch = suppliedFetch;
          rateFetch = createRetryingFetch(suppliedFetch, {
            ...options.rate,
            onState(state: any) {
              if (!closed) pi.appendEntry(RATE_STATE, state);
            },
            onWait({ delayMs, reason }: any) {
              context?.ui.setStatus("solar-rate", `Solar waiting ${Math.ceil(delayMs / 1000)}s: ${reason} (Esc cancels)`);
            },
          });
        }
        return native.streamSimple(model, messages, { ...streamOptions, fetch: rateFetch, maxRetries: 0 });
      },
    });
  });

  pi.on("session_shutdown", () => {
    closed = true;
    modelReady = false;
    planningRunner?.shutdown();
    invalidateExecutionCalls("Session shutdown invalidated this execution tool call.");
    context?.ui.setWidget("solar-interview", undefined);
    context?.ui.setWidget("solar-workflow", undefined);
    context?.ui.setStatus("solar-rate", undefined);
    context?.ui.setStatus("solar-workflow", undefined);
  });

  function stopForModelDrift(ctx: any, reason: string) {
    modelReady = false;
    planningRunner?.stop();
    invalidateExecutionCalls(reason);
    const fresh = currentWorkflow(ctx);
    if (fresh?.status === "active") saveWorkflow({ ...fresh, status: "paused", pendingHandoff: false, reason });
    active = false;
    ctx.abort();
    restoreTools();
  }

  pi.on("model_select", (event, ctx) => {
    const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
    if (event.model?.provider === "upstage" && event.model?.id === "solar-pro4" && thinking === "max") {
      refreshModelReady(ctx);
      return;
    }
    if (currentWorkflow(ctx)?.status === "active") stopForModelDrift(ctx, "The selected model changed during a Solar workflow. Late model/tool/role output is non-authoritative; switch back explicitly and resume.");
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (event.level === "max" && ctx.model?.provider === "upstage" && ctx.model?.id === "solar-pro4") {
      refreshModelReady(ctx);
      return;
    }
    if (currentWorkflow(ctx)?.status === "active") stopForModelDrift(ctx, "The thinking level changed during a Solar workflow. Late output is non-authoritative; restore max explicitly and resume.");
  });

  pi.registerCommand("solar-rate", {
    description: "Show Solar 429 retry status (no local token or request cap)",
    handler: async (_arguments, ctx) => {
      ctx.ui.notify(JSON.stringify(rateFetch?.snapshot?.() ?? { mode: "retry-only", status: "No Solar request observed yet" }), "info");
    },
  });

  pi.registerCommand("solar-web", {
    description: "Show Tavily/Unstructured availability and research request counts without exposing keys",
    handler: async (_argument, ctx) => {
      restore(ctx);
      const receipts = workflow ? webReceipts(workflow) : [];
      ctx.ui.notify(`Tavily: ${tavily.configured() ? "TAVILY_API_KEY available" : "TAVILY_API_KEY missing from this pi process"}. Policy: ${workflow?.webPolicy ?? "tavily"}. This pass: ${receipts.filter(item => item.kind === "search").length}/3 searches, ${receipts.filter(item => item.kind === "read").length}/3 page-read requests. Web access sends public query terms and source URLs to Tavily; never submit private context.`, "info");
      ctx.ui.notify(`Unstructured: ${documents.configured() ? "UNSTRUCTURED_API_KEY available" : "UNSTRUCTURED_API_KEY missing from this pi process"}. This pass: ${receipts.filter(item => item.kind === "document").length}/2 document uploads. Public retrieved documents only; no private/local file uploads.`, "info");
    },
  });

  for (const kind of ["search", "read", "document"] as const) {
    pi.registerTool({
      name: kind === "document" ? "solar_document_read" : `solar_web_${kind}`,
      label: kind === "document" ? "Unstructured Document Read" : kind === "search" ? "Tavily Web Search" : "Read Tavily Sources",
      description: kind === "document" ? "Retrieve one public PDF/Office URL from this pass's search results through Unstructured. Local/private files are forbidden." : kind === "search" ? "Search public sources for the current research gap without transmitting private context." : "Read one to three URLs returned by this pass's search.",
      parameters: kind === "document" ? Type.Object({ url: Type.String(), strategy: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("hi_res"), Type.Literal("auto")])) }) : kind === "search" ? Type.Object({ query: Type.String({ minLength: 3, maxLength: 400 }), domains: Type.Optional(Type.Array(Type.String(), { maxItems: 5 })) }) : Type.Object({ urls: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }) }),
      async execute(id, params, signal, _update, ctx) {
        if (webBusy) return { content: [{ type: "text", text: "Finish the current web request before starting another." }], details: { webValidationError: true } };
        webBusy = true;
        let current: any;
        let reserved = false;
        try {
          context = ctx;
          requireSolarHost(ctx);
          current = currentWorkflow(ctx);
          if (!current || !matchesWorkflowWorkspace(current, ctx.cwd)) throw new Error("No research workflow in this workspace.");
          requireWebAccess(current, kind, params);
          const pending = { id, kind, pass: current.researchPass ?? 1, status: "pending" };
          saveWorkflow({ ...current, webEvidence: [...(current.webEvidence ?? []), pending] });
          reserved = true;
          const result = await (kind === "document" ? documents : tavily).request(kind, params, signal);
          const fresh = currentWorkflow(ctx);
          if (signal?.aborted || !modelReady || fresh?.id !== current.id || fresh.status !== "active" || fresh.stage !== "research" || fresh.researchPass !== current.researchPass) throw new Error("Research changed, stopped, or changed model during the web request; no successful receipt was recorded.");
          saveWorkflow({ ...fresh, webEvidence: fresh.webEvidence.map((item: any) => item.id === id ? { ...pending, ...result, status: "ok" } : item) });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: { webEvidence: true, results: result.results.length } };
        } catch (error: any) {
          const fresh = currentWorkflow(ctx);
          if (fresh?.id === current?.id && fresh?.status === "active" && fresh.stage === "research") {
            const pause = error.status !== undefined || /cooldown|has used its/.test(error.message);
            saveWorkflow({ ...fresh, ...(reserved ? { webEvidence: fresh.webEvidence.map((item: any) => item.id === id ? { ...item, status: "error", error: errorText(error) } : item) } : {}), ...(pause ? { status: "paused", reason: errorText(error), pendingHandoff: false } : {}), ...(error.retryAfterMs !== undefined ? { webRetryAt: Date.now() + error.retryAfterMs } : {}) });
            if (pause) restoreTools();
          }
          return { content: [{ type: "text", text: errorText(error) || "Web research failed without verified evidence." }], details: { webValidationError: true }, terminate: currentWorkflow(ctx)?.status === "paused" };
        } finally {
          webBusy = false;
        }
      },
    });
  }

  pi.registerCommand("solar-workflow", {
    description: "Inspect, approve, revise, stop, resume, or accept exact current Solar workflow evidence",
    handler: async (argument, ctx) => {
      restore(ctx);
      const [command = "status", ...parts] = argument.trim().split(/\s+/);
      const detail = parts.join(" ");
      try {
        if (!workflow) throw new Error("Start /skill:solar-research, solar-interview, or solar-plan first.");
        if (!matchesWorkflowWorkspace(workflow, ctx.cwd)) throw new Error("Resume in the workflow's original workspace.");
        if (command !== "stop" && command !== "status" && (!ctx.isIdle() || ctx.hasPendingMessages())) throw new Error("Wait for the current turn to settle before changing workflow controls.");
        if (command === "stop") {
          planningRunner?.stop();
          invalidateExecutionCalls("User stop invalidated this execution tool call.");
          saveWorkflow({ ...workflow, status: "stopped", pendingHandoff: false, reason: "Stopped by user; checkpoints and controller-owned artifacts are preserved. Late asynchronous work cannot commit." });
          active = false;
          ctx.abort();
          if (ctx.waitForIdle) await ctx.waitForIdle();
        } else if (command === "approve") {
          requireSolarHost(ctx);
          const disk = diskPlanSnapshot(ctx, workflow);
          saveWorkflow(approveGateReview(workflow, detail, disk));
          launchStage("execute", "Execute only the current dependency-ready approved step and call solar_step_done with its V3 stepId, approach, and declared evidence paths.");
        } else if (command === "accept") {
          const fresh = currentWorkflow(ctx);
          const disk = diskPlanSnapshot(ctx, fresh);
          const manifest = captureAcceptanceManifest(fresh);
          saveWorkflow(acceptFinalReview(fresh, detail, manifest, disk));
        } else if (command === "revise") {
          if (!detail) throw new Error("Supply what should change in the plan, gates, artifact descriptors, or outcome.");
          requireSolarHost(ctx);
          const current = initializeLoop(workflow);
          const afterExecution = current.stage === "execute" || current.status === "complete" || current.status === "awaiting_final_review";
          const priorPlanning = current.planning;
          const retainFindings = priorPlanning?.revisionState === "revision_required" || priorPlanning?.revisionState === "blocked";
          saveWorkflow({
            ...current,
            stage: "plan",
            status: "active",
            gap: detail,
            feedback: [...(current.feedback ?? []), detail],
            cycle: current.cycle + (afterExecution ? 1 : 0),
            approval: undefined,
            approvalArtifactTableRevision: undefined,
            finalReview: undefined,
            finalManifest: undefined,
            acceptanceManifest: undefined,
            limitStop: undefined,
            pendingHandoff: true,
            reminder: 0,
            planning: priorPlanning ? { ...priorPlanning, revisionState: retainFindings ? priorPlanning.revisionState : "authoring", ...(retainFindings ? {} : { reviewFindings: [], reviews: {}, reviewReceipts: {}, findingResolutions: [] }) } : undefined,
          });
          if (workflow.cycle > workflow.limits.cycles || workflow.turns >= workflow.limits.turns) {
            const kind = workflow.cycle > workflow.limits.cycles ? "cycles" : "turns";
            saveWorkflow({ ...workflow, status: "limited", limitStop: { kind, bound: workflow.limits[kind] }, reason: "Workflow limit reached. Feedback is saved; raise limits explicitly before resuming.", pendingHandoff: false });
          } else launchStage("plan", "Trigger a complete new Planner revision and both fresh reviews with solar_plan_ready({}). Preserve current findings and verified non-authoritative evidence.");
        } else if (command === "limits") {
          const limits = { ...initializeLoop(workflow).limits };
          if (!parts.length) throw new Error("Use limits cycles=N detours=N turns=N. Defaults: 3, 8, 120.");
          for (const part of parts) {
            const match = /^(cycles|detours|turns)=(\d+)$/.exec(part);
            if (!match || Number(match[2]) < 1 || Number(match[2]) > 1000) throw new Error("Limits must be cycles=N detours=N turns=N, with integers 1..1000.");
            limits[match[1]] = Number(match[2]);
          }
          saveWorkflow({ ...workflow, limits });
        } else if (command === "resume") {
          if (!["paused", "limited", "stopped", "awaiting_final_review"].includes(workflow.status)) throw new Error("Only a paused/stopped/limited run or final review can resume. Gate review requires approve.");
          requireSolarHost(ctx);
          const current = resumeLoop(workflow);
          if (current.stage === "execute") {
            const mode = nextStep(current) ? { kind: "step" as const, stepId: nextStep(current)!.id } : { kind: "final" as const };
            requireApprovedPlan({ ...current, status: "active" }, diskPlanSnapshot(ctx, current), mode);
          }
          saveWorkflow(current);
          launchStage(current.stage, `${current.stage === "interview" ? "resume " : ""}Resume saved V2/V3 state and original intent. Do not repeat answered questions, role reviews, or successful work. Report only through the current stage contract.`);
        } else if (command !== "status" && command !== "") throw new Error("Use status, approve <revision>, revise <feedback>, accept <revision>, stop, resume, or limits.");
        restoreTools();
        ctx.ui.notify(renderWorkflowReview(workflow), "info");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerCommand("solar-interview", {
    description: "Confirm a current goal token, finish early, or control a saved V2 interview",
    handler: async (argument, ctx) => {
      restore(ctx);
      const command = argument.trim() || "status";
      try {
        if ((workflow?.status === "limited" || workflow?.turns >= workflow?.limits?.turns) && ["resume", "continue", "review", "retry"].includes(command)) throw new Error("Workflow limit reached. Raise limits or provide materially changed evidence for the named gap.");
        if (command === "finish" || command === "finish plan-only" || /^confirm\s+[a-f0-9]{12}$/u.test(command)) {
          if (workflow && workflow.stage !== "interview") throw new Error("No current interview stage accepts a closure action.");
          await finishSavedInterview(ctx, `/solar-interview ${command}`, true, command === "finish plan-only");
        } else if (command === "confirm" || command.startsWith("confirm ")) {
          throw new Error("Normal closure requires /solar-interview confirm <exact current 12-character goal token>.");
        } else if (command === "stop") {
          planningRunner?.stop();
          active = false;
          if (workflow) saveWorkflow({ ...workflow, status: "stopped", pendingHandoff: false, reason: "Interview stopped without closure. Saved answers and assessment remain available; no planning or execution started." });
          ctx.abort();
          if (ctx.waitForIdle) await ctx.waitForIdle();
          restoreTools();
        } else if (command === "pause" && interview) {
          saveInterview({ ...interview, status: "paused" });
          active = false;
          if (workflow) saveWorkflow({ ...workflow, status: "paused", pendingHandoff: false, reason: "Interview paused by user with V2 evidence and recovery state preserved." });
          restoreTools();
        } else if (command === "resume" && interview) {
          requireSolarHost(ctx);
          closure = undefined;
          saveInterview({ ...interview, status: interview.proposal.readiness.status === "ready" ? "awaiting_goal_confirmation" : interview.proposal.question ? "interviewing" : "awaiting_choice" });
          active = true;
          if (workflow && matchesWorkflowWorkspace(workflow, ctx.cwd)) saveWorkflow({ ...workflow, stage: "interview", status: "active", reason: undefined });
          restoreTools();
        } else if (command === "review" || command === "continue") {
          requireSolarHost(ctx);
          if (command === "continue" && interview) {
            closure = undefined;
            saveInterview({ ...interview, status: interview.proposal.question ? "interviewing" : "awaiting_choice" });
            active = true;
            if (workflow && matchesWorkflowWorkspace(workflow, ctx.cwd)) saveWorkflow({ ...workflow, stage: "interview", status: "active", reason: undefined });
            restoreTools();
          }
          if (!active || !interview || !answers.length || interview.answerHead !== answers.at(-1)?.id || interview.researchHead !== researchHead(workflow)) throw new Error("Review requires an active V2 interview with a current assessed answer/research head. Use retry for an unassessed head.");
          if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current response to finish before reviewing.");
          reviewing = true;
          pi.appendEntry(INTERVIEW_REVIEW_STATE, { anchorId, answerHead: interview.answerHead, status: "pending" });
          settledReport = false;
          currentAnswerId = answers.at(-1).id;
          repairs = 0;
          toolCalls = 0;
          showInterview(korean ? "저장된 답변과 현재 연구 헤드로 준비도를 재검토합니다." : "Reviewing saved answers and the current research head without claiming new material progress.", "retrying");
          pi.sendMessage({ customType: "solar-interview-review-v2", content: "Reassess the current saved answer/research heads. Preserve MaterialState and readiness truthfully; a review is not new progress. Call solar_interview_round once with the complete V2 payload.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
        } else if (command === "retry") {
          requireSolarHost(ctx);
          if (!active || !answers.length) throw new Error("No active saved interview answer to retry.");
          if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for the current response to finish before retrying.");
          if (!settledReport) {
            repairs = 0;
            toolCalls = 0;
            showInterview(korean ? "저장된 답변과 연구 헤드로 V2 보고서를 다시 작성합니다." : "Retrying the V2 report using the saved answer and research heads.", "retrying");
            pi.sendMessage({ customType: "solar-interview-repair-v2", content: "Retry the complete V2 assessment against the same saved evidence. Do not invent material progress, readiness, or a token.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
          }
        } else if (command !== "status") {
          throw new Error("Use /solar-interview confirm <token>, finish, finish plan-only, stop, continue, status, pause, resume, retry, or review.");
        }
        ctx.ui.notify(progressText(), "info");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "solar_research_ready",
    label: "Validate and Persist ResearchContractV2",
    description: "Submit typed current-pass research plus the exact expected controller artifact revision. The host validates lineage/receipts before atomically writing its reserved research.md and returning or stopping.",
    parameters: Type.Object({
      contract: researchContractSchema,
      expectedArtifactRevision: Type.Union([Type.String(), Type.Null()]),
    }),
    async execute(_id, params, signal, _update, ctx) {
      try {
        requireSolarHost(ctx);
        const current = currentWorkflow(ctx);
        if (!current || current.status !== "active" || current.stage !== "research" || !matchesWorkflowWorkspace(current, ctx.cwd)) throw new Error("No active research stage in this workspace accepts a submission.");
        if (signal?.aborted) throw new Error("Research submission was cancelled before validation.");
        const disk = readReserved(ctx.cwd, current.id, "research");
        const validation = validateResearchContract(params, researchValidationContext(current, disk.revision));
        assertPublicResearchEvidence(current, validation);
        const rendered = renderResearchArtifact(current.originalTask, validation);
        const fresh = currentWorkflow(ctx);
        if (signal?.aborted || !modelReady || fresh?.id !== current.id || fresh.status !== "active" || fresh.stage !== "research" || fresh.researchPass !== current.researchPass) throw new Error("Research changed, stopped, or changed model before persistence; no artifact was written.");
        const artifact = atomicReplaceReserved(ctx.cwd, current.id, "research", validation.expectedArtifactRevision, rendered);
        const afterWrite = currentWorkflow(ctx);
        if (signal?.aborted || !modelReady || afterWrite?.id !== current.id || afterWrite.status !== "active" || afterWrite.stage !== "research" || afterWrite.researchPass !== current.researchPass) throw new Error("Research changed during persistence; the new controller artifact remains non-authoritative and no handoff was committed.");
        saveWorkflow(researchReady(afterWrite, artifact, validation));
        restoreTools();
        if (workflow.status === "active") launchStage(workflow.stage, `${workflow.stage === "interview" ? "resume " : ""}Use the exact host-owned research artifact ${JSON.stringify(artifact.relativePath)} and preserve the original request, V2 answer head, material gap, and return route. Research is evidence, not a new user answer.`);
        return { content: [{ type: "text", text: workflow.status === "research_complete" ? `ResearchContractV2 validated and persisted at ${artifact.relativePath}. Research-only boundary complete; no interview started.` : workflow.status === "paused" ? renderWorkflowReview(workflow) : `ResearchContractV2 validated and persisted at ${artifact.relativePath}. Returning to solar-${workflow.stage}.` }], details: { stage: workflow.stage, status: workflow.status, path: artifact.relativePath, revision: artifact.revision }, terminate: true };
      } catch (error) {
        return workflowError(error);
      }
    },
  });

  pi.registerTool({
    name: "solar_plan_ready",
    label: "Run Host-Owned Solar Planning Reviews",
    description: "Trigger fresh tool-free Planner, Approach Reviewer, and Critic sessions. The host owns plan.md, revisions, findings, and review receipts. Supply no caller-authored plan or review.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      if (planningRunner) return workflowError("A host-owned planning/review cycle is already running.");
      try {
        const result = await runPlanningCycle(ctx, signal);
        return { content: [{ type: "text", text: renderWorkflowReview(result) }], details: { stage: result.stage, status: result.status, revision: result.revision, artifactTableRevision: result.artifactTableRevision }, terminate: true };
      } catch (error) {
        const fresh = currentWorkflow(ctx);
        if (fresh?.stage === "plan" && ["active", "reviewing_plan", "revision_required"].includes(fresh.status)) saveWorkflow({ ...fresh, status: "paused", pendingHandoff: false, reason: `Host-owned planning/review stopped without authority: ${errorText(error)}` });
        restoreTools();
        return workflowError(error);
      }
    },
  });

  pi.registerTool({
    name: "solar_revisit",
    label: "Targeted Research / Clarification / Replanning",
    description: "Return to one material research, interview, or planning gap while preserving V2/V3 lineage and best evidence.",
    parameters: Type.Object({ stage: Type.Union([Type.Literal("research"), Type.Literal("interview"), Type.Literal("plan")]), gap: Type.String(), evidence: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      try {
        requireSolarHost(ctx);
        const current = currentWorkflow(ctx);
        if (!current || !matchesWorkflowWorkspace(current, ctx.cwd)) throw new Error("No active workflow in this workspace.");
        if (signal?.aborted) throw new Error("Targeted revisit was cancelled.");
        const input: any = { ...params };
        if (params.stage === "research") {
          const savedAssessment = current.interview?.assessment ?? interview;
          const answerHeadId = current.interview?.answerHead ?? savedAssessment?.answerHead ?? current.interview?.answers?.at(-1)?.id;
          if (!answerHeadId) throw new Error("A research detour needs the exact retained V2 answer head; no synthetic answer lineage is permitted.");
          const activeInterviewGap = current.stage === "interview"
            ? savedAssessment?.currentGapId ?? savedAssessment?.proposal?.readiness?.materialGaps?.[0]?.id
            : undefined;
          const gapId = activeInterviewGap ?? `gap-${structuredRevision({
            workflowId: current.id,
            sourceStage: current.stage,
            answerHeadId,
            gap: params.gap.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"),
          }).slice(0, 16)}`;
          input.gapId = gapId;
          input.answerHeadId = answerHeadId;
          input.evidenceDigest = current.research?.materialDigest ?? structuredRevision({
            answerHeadId,
            researchHead: current.interview?.researchHead ?? savedAssessment?.researchHead ?? null,
            materialState: savedAssessment?.materialState ?? null,
          });
        }
        const next = revisitWorkflow(current, input);
        saveWorkflow(next);
        active = false;
        restoreTools();
        if (next.status === "active") launchStage(next.stage, `${next.stage === "interview" && answers.length ? "resume " : ""}Targeted gap: ${params.gap}. Evidence: ${params.evidence}. Preserve original intention, saved answers/deferrals, exact gap/answer heads, and prior artifacts. Return only after a material outcome or truthful blocker.`);
        return { content: [{ type: "text", text: next.status === "active" ? `Starting solar-${next.stage} for the saved material gap.` : renderWorkflowReview(next) }], details: { stage: next.stage, status: next.status }, terminate: true };
      } catch (error) {
        return workflowError(error);
      }
    },
  });

  pi.registerTool({
    name: "solar_step_done",
    label: "Verify Current V3 Step or Final Boundary",
    description: "Report the exact current stepId, concrete approach, and declared evidence paths. The host runs guarded gates and descriptor/manifests checks.",
    parameters: Type.Object({
      stepId: Type.String(),
      summary: Type.String(),
      approach: Type.Object({ id: Type.String(), description: Type.String(), differsFrom: Type.Optional(Type.String()) }),
      evidence: Type.Array(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (checkpointing) return workflowError("A checkpoint is already running; do not call step tools in parallel.");
      checkpointing = true;
      try {
        requireSolarHost(ctx);
        let current = currentWorkflow(ctx);
        if (!current || !matchesWorkflowWorkspace(current, ctx.cwd)) throw new Error("No approved workflow in this workspace.");
        const pending = nextStep(current);
        if (pending) {
          if (params.stepId !== pending.id) throw new Error(`Work on ${pending.id} before later steps or final verification.`);
          validateStepApproach(current, pending.id, params.approach);
          const expectation = executionExpectation(current, { kind: "step", stepId: pending.id });
          const guard = authorityGuard(ctx);
          const initial = await guard(expectation);
          assertExecutionAuthority(initial.fresh, initial.diskPlan, expectation, undefined, signal);
          const checks = await runGates({ identifiers: pending.gates, exec: pi.exec.bind(pi), signal, expectation, guard });
          const commit = await guard(expectation);
          const artifactInputs = [...new Set([...pending.outputs, ...params.evidence])];
          const byId = new Map(commit.fresh.plan.contract.artifacts.map((artifact: any) => [artifact.id, artifact]));
          const byPath = new Map(commit.fresh.plan.contract.artifacts.map((artifact: any) => [artifact.path, artifact]));
          const files = artifactInputs.flatMap(value => {
            const descriptor: any = byId.get(value) ?? byPath.get(value);
            if (!descriptor) throw new Error(`${value}: evidence must name a current artifact ID or its exact canonical descriptor path.`);
            try {
              return [{ artifactId: descriptor.id, ...evidenceFile(ctx.cwd, descriptor.path) }];
            } catch {
              return [];
            }
          }).filter((file, index, all) => all.findIndex(candidate => candidate.artifactId === file.artifactId) === index);
          saveWorkflow(recordStep(commit.fresh, { stepId: pending.id, summary: params.summary, approach: params.approach, files, gates: checks }, { diskPlan: commit.diskPlan, expectation, signal }));
          restoreTools();
          if (!workflow.results[pending.id].passed) {
            if (workflow.status === "active") launchStage("execute", `Repair only ${pending.id} with a materially distinct approach bound through differsFrom. Preserve the best current files and diagnostics; do not repeat an unchanged attempt.`);
            return { content: [{ type: "text", text: renderWorkflowReview(workflow) }], details: { checks, status: workflow.status }, terminate: true };
          }
          if (nextStep(workflow)) {
            saveWorkflow({ ...workflow, pendingHandoff: true });
            launchStage("execute", "The current step passed its exact gates. Continue only with the next dependency-ready V3 step and its declared capabilities.");
            return { content: [{ type: "text", text: renderWorkflowReview(workflow) }], details: { checks, status: workflow.status }, terminate: true };
          }
          return { content: [{ type: "text", text: "All dependency-ordered steps are checkpointed. Call solar_step_done with stepId: final to run the separately guarded pre/post final verification batch." }], details: { checks, status: workflow.status }, terminate: true };
        }

        if (params.stepId !== "final") throw new Error("All steps are checkpointed; use stepId: final for fresh manifest-bound verification.");
        const expectation = executionExpectation(current, { kind: "final" });
        const guard = authorityGuard(ctx);
        const beforeAuthority = await guard(expectation);
        assertExecutionAuthority(beforeAuthority.fresh, beforeAuthority.diskPlan, expectation, undefined, signal);
        const finals = beforeAuthority.fresh.plan.contract.artifacts.filter((artifact: any) => artifact.kind === "final");
        const submittedFinals = params.evidence.map((value: string) => finals.find((artifact: any) => artifact.id === value || artifact.path === value)?.id);
        if (submittedFinals.some((value: string | undefined) => !value) || new Set(submittedFinals).size !== finals.length || submittedFinals.length !== finals.length) {
          throw new Error("Final verification evidence must name every exact current final artifact once, by descriptor ID or canonical path.");
        }
        const before = captureFinalManifest(beforeAuthority.fresh);
        const identifiers = beforeAuthority.fresh.plan.contract.gates.map((gate: any) => gate.id);
        const checks = await runGates({ identifiers, exec: pi.exec.bind(pi), signal, expectation, guard });
        const afterAuthority = await guard(expectation);
        const after = captureFinalManifest(afterAuthority.fresh);
        const acceptance = captureAcceptanceManifest(afterAuthority.fresh);
        saveWorkflow(finishVerification(afterAuthority.fresh, checks, { before, after, acceptance }, { diskPlan: afterAuthority.diskPlan, expectation, signal }));
        restoreTools();
        if (workflow.status === "active" && workflow.stage === "plan") launchStage("plan", "Final bytes or gates regressed. Trigger a complete revised plan plus both fresh reviews; preserve best non-authoritative evidence.");
        return { content: [{ type: "text", text: renderWorkflowReview(workflow) }], details: { status: workflow.status, checkpoint: workflow.checkpoint }, terminate: true };
      } catch (error) {
        return workflowError(error);
      } finally {
        checkpointing = false;
      }
    },
  });

  pi.registerTool({
    name: "solar_interview_round",
    label: "Interview V2 Material Progress and Readiness",
    description: "Report a complete evidence-linked InterviewRoundV2. Scores are advisory; current readiness proposes a token but never closes by itself.",
    parameters: Type.Object({
      goal: dimensionSchema,
      constraints: dimensionSchema,
      success: dimensionSchema,
      context: Type.Optional(dimensionSchema),
      blockers: Type.Array(Type.String()),
      deferred: Type.Optional(Type.Array(Type.Object({ topic: Type.String(), evidence: Type.Array(Type.String()), reason: Type.String() }))),
      intent: Type.String(),
      changeReason: Type.String(),
      question: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      strategy: Type.Union([Type.Literal("question"), Type.Literal("reframe"), Type.Literal("research"), Type.Literal("ready"), Type.Literal("blocked")]),
      currentGapId: Type.Optional(Type.String()),
      materialState: materialStateSchema,
      readiness: readinessSchema,
    }),
    async execute(_id, proposal, signal, _update, ctx) {
      context = ctx;
      if (!active) return { content: [{ type: "text", text: "No active supported Solar interview." }], details: { interviewValidationError: true }, terminate: true };
      try {
        requireSolarHost(ctx);
        if (signal?.aborted) throw new Error("Interview assessment was cancelled.");
        const current = currentWorkflow(ctx);
        const fresh = recoverInterview(branch(ctx), { researchHead: researchHead(current) });
        if (fresh.pause) throw new Error(fresh.pause.reason);
        if (fresh.answers.length) answers = fresh.answers;
        const next = prepareInterviewReport(proposal as any, interview, answers, anchorId!, {
          reassess: reviewing,
          researchHead: researchHead(current),
          researchContentHashes: currentResearchHashes(current),
          artifactRefs: currentArtifactRefs(current),
        });
        reviewing = false;
        saveInterview(next);
        settledReport = true;
        if (next.status === "paused") {
          active = false;
          restoreTools();
        }
        return { content: [{ type: "text", text: reportText(next) }], details: { state: next, korean }, terminate: true };
      } catch (error) {
        showInterview(korean ? "동일한 저장 증거로 V2 보고서 형식을 수정 중입니다." : "Correcting the V2 report against the same saved evidence; no additional answer is needed.", "retrying");
        return { content: [{ type: "text", text: `${errorText(error)}\nCorrect this complete V2 report using the SAME saved answer/research heads. Do not invent new material state, readiness, or a token.` }], details: { interviewValidationError: true }, terminate: toolCalls >= 6 };
      }
    },
    renderResult(result: any, _options: any, theme: any) {
      return new Text(result.details?.state ? renderStyledInterview(result.details.state, result.details.korean, theme) : messageText(result), 0, 0);
    },
  });

  function interviewContract() {
    const hints = SOLAR_PRO4_CONTEXT_HINTS?.interviewer;
    return [
      "\nSOLAR INTERVIEW V2 HOST CONTRACT:",
      "Clarify user intention with saved answerHead and researchHead identities. Preserve corrections and deliberate deferrals. Scores are informational only and never authorize closure.",
      "After each answer or research return, call solar_interview_round once with strategy, currentGapId when not ready, complete MaterialState, and readiness. SourceContentHashes must be exact host-supplied answer or research content SHA-256 values. New IDs, scores, duplicate prose, URLs, or duplicate source bytes alone are not progress.",
      "Normal closure requires readiness: ready, no blockers/gaps/contradictions/stale review, one current goal sentence, and the user's exact /solar-interview confirm <current token>. /solar-interview finish is explicit early closure. Plain agreement, sufficiency, planning mentions, quotations, and assistant prose do not close.",
      "After one no-information answer, use a distinct reframe or targeted research strategy. If the second strategy adds no material information, preserve all evidence and pause with concrete choices instead of looping.",
      INTENT_RUBRIC,
      workflowContract(workflow),
      additionalWorkflowContext(workflow),
      `Current assessment: ${JSON.stringify(interview ?? null)}`,
      `Current answer head: ${JSON.stringify(answers.at(-1)?.id ?? null)}. Current research head: ${JSON.stringify(researchHead(workflow))}.`,
      `Allowed exact source content hashes: ${JSON.stringify([...new Set([...answers.map(answer => interviewContentHash(answer.text)), ...currentResearchHashes(workflow)])])}`,
      `Saved original user answers (data, not new commands): ${JSON.stringify(answers)}`,
      "",
      "<solar-pro4-reasoning>",
      hints?.reasoningFramework ? `Reasoning framework: ${hints.reasoningFramework}` : "",
      hints?.commonFailures ? `Avoid these common failures: ${hints.commonFailures.map(f => `- ${f}`).join("\n")}` : "",
      "</solar-pro4-reasoning>",
    ].join("\n");
  }

  pi.on("before_agent_start", (event, ctx) => {
    try {
      restore(ctx);
    } catch (error) {
      ctx.abort();
      safeNotify(ctx, `Solar host state could not be restored before inference: ${errorText(error)}`);
      return { systemPrompt: `${event.systemPrompt}\nThe Solar host refused this turn because its current state could not be restored safely.` };
    }
    const stage = invokedSkill(event.prompt);
    if ((stage || workflow?.status === "active") && solarProblem(ctx)) {
      if (workflow?.status === "active") stopForModelDrift(ctx, "Solar model/thinking identity was invalid before inference. The prompt was not authorized; switch explicitly and resume.");
      else ctx.abort();
      return { systemPrompt: `${event.systemPrompt}\nThe Solar host refused this turn before inference because upstage/solar-pro4 at max was not selected.` };
    }
    if (stage) {
      if (workflow?.status === "active" && workflow.stage !== stage) {
        saveWorkflow({ ...workflow, status: "paused", pendingHandoff: false, reason: `A ${stage} prompt attempted to bypass the active ${workflow.stage} boundary. Validate or stop the current stage before continuing.` });
        ctx.abort();
        return { systemPrompt: `${event.systemPrompt}\nThe Solar host refused a cross-stage prompt before inference.` };
      }
      if (workflow?.pendingHandoff && workflow.stage === stage) saveWorkflow({ ...workflow, pendingHandoff: false });
      else if (stage === "execute") {
        if (!workflow?.approval || workflow.status !== "active" || workflow.stage !== "execute") {
          saveWorkflow({ ...(workflow ?? startWorkflow("plan", stripSkill(event.prompt), ctx.cwd)), status: "paused", pendingHandoff: false, reason: "Execution cannot bypass current V3 plan review and exact human approval." });
          ctx.abort();
          return { systemPrompt: `${event.systemPrompt}\nDirect Solar execution is not authorized.` };
        }
      } else if (!(stage === "interview" && workflow?.stage === stage && /\b(?:resume|continue)\b|이어|계속/i.test(stripSkill(event.prompt)))) {
        saveWorkflow(startWorkflow(stage, stripSkill(event.prompt), ctx.cwd));
      }
      active = stage === "interview";
    }
    restoreTools();
    if (!active) return;
    showInterview(korean ? "현재 답변/연구 헤드를 V2로 평가 중입니다." : "Assessing the current answer/research heads with the V2 contract.", "processing");
    return { systemPrompt: `${event.systemPrompt}\nUse the current Solar Interview V2 host context. Only exact current readiness plus user token confirmation is normal closure; explicit finish is early closure.` };
  });

  pi.on("context", (event, ctx) => {
    if (workflow?.pendingHandoff) saveWorkflow({ ...workflow, pendingHandoff: false });
    if (active) refreshAnswers(ctx);
    let messages = [...event.messages];
    if (active && answers.length) {
      const latest = answers.at(-1).text;
      const start = messages.findLastIndex(message => message.role === "user" && stripSkill(messageText(message)) === latest);
      if (start >= 0) {
        messages = messages.slice(start);
        messages[0] = { ...messages[0], content: [{ type: "text", text: latest }] } as any;
      }
    }
    const hostContext = active ? interviewContract() : [workflowContract(workflow), additionalWorkflowContext(workflow)].filter(Boolean).join("\n");
    if (hostContext) {
      const index = messages.findLastIndex(message => message.role === "user");
      if (index >= 0) {
        const message: any = messages[index];
        const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
        messages[index] = { ...message, content: [...content, { type: "text", text: hostContext }] };
      } else messages.push({ role: "user", content: [{ type: "text", text: hostContext }], timestamp: Date.now() } as any);
    }
    return { messages };
  });

  pi.on("before_provider_request", event => {
    try {
      const payload: any = event.payload;
      if (workflow?.status === "active" && (!modelReady || payload?.model !== "solar-pro4" || payload?.reasoning_effort !== "max")) {
        modelReady = false;
        planningRunner?.stop();
        invalidateExecutionCalls("Provider request identity drift invalidated this execution tool call.");
        context?.abort();
        return;
      }
      if (!active || !Array.isArray(payload?.messages) || payload.model !== "solar-pro4" || !payload.tools?.some((tool: any) => tool.function?.name === "solar_interview_round")) return;
      return { ...payload, tool_choice: repairs > 0 ? { type: "function", function: { name: "solar_interview_round" } } : "required" };
    } catch {
      return;
    }
  });

  pi.on("tool_call", (event: any, ctx) => {
    if (authorizedCalls.has(event.toolCallId)) return { block: true, reason: "Duplicate tool-call ID rejected before it could overwrite an existing authorization or tombstone.", terminate: true };
    const last: any = [...branch(ctx)].reverse().find(entry => entry.message?.role === "assistant")?.message;
    const calls = Array.isArray(last?.content) ? last.content.filter((block: any) => block.type === "toolCall") : [];
    if (calls.length > 1 && calls.some((call: any) => CONTROL_TOOLS.includes(call.name))) return { block: true, reason: "Call one workflow control/report/web tool at a time. Finish writes/checks before handing off or checkpointing.", terminate: true };
    const fresh = currentWorkflow(ctx);
    if (!fresh) {
      rememberOtherCall(event.toolCallId);
      return;
    }
    if (["awaiting_gate_review", "awaiting_final_review", "paused", "limited", "revision_required", "workspace_mismatch"].includes(fresh.status) && event.toolName !== "read") return { block: true, reason: "Workflow is waiting for an explicit human/recovery boundary. Only read is available.", terminate: true };
    if (fresh.status !== "active") {
      rememberOtherCall(event.toolCallId);
      return;
    }
    if (!modelReady || solarProblem(ctx)) return { block: true, reason: "Solar model/thinking identity changed; this tool dispatch is not authorized.", terminate: true };

    const allowed = stageTools(fresh) ?? [];
    if (!allowed.includes(event.toolName)) return { block: true, reason: `Tool ${event.toolName} is default-denied in the active ${fresh.stage} stage.`, terminate: true };
    if (fresh.stage === "execute" && !["solar_step_done", "solar_revisit"].includes(event.toolName)) {
      try {
        const step = nextStep(fresh);
        if (!step) throw new Error("No mutation/read tool is authorized after all steps; request final verification only.");
        const operation = operationForTool(event, fresh, step);
        if (!operation) throw new Error("The execution tool cannot be mapped unambiguously to one declared read/write/command operation.");
        const expectation = executionExpectation(fresh, { kind: "step", stepId: step.id });
        assertExecutionAuthority(fresh, diskPlanSnapshot(ctx, fresh), expectation, operation, ctx.signal);
        authorizedCalls.set(event.toolCallId, { kind: "execution", status: "pending", expectation, operation });
      } catch (error) {
        return { block: true, reason: errorText(error), terminate: true };
      }
    } else rememberOtherCall(event.toolCallId);
    if (fresh.stage === "interview") {
      toolCalls += 1;
      if (toolCalls > 6) {
        authorizedCalls.delete(event.toolCallId);
        return { block: true, reason: "Interview tool budget reached; pause for a user decision instead of looping.", terminate: true };
      }
    }
  });

  pi.on("tool_result", (event: any, ctx) => {
    const authorization = authorizedCalls.get(event.toolCallId);
    if (authorization?.kind === "execution") {
      if (authorization.status !== "pending") return staleToolResult(authorization.reason ?? "Duplicate or invalidated execution tool result is non-authoritative.");
      try {
        const fresh = currentWorkflow(ctx);
        if (!modelReady || solarProblem(ctx)) throw new Error("Solar model/thinking identity changed while the tool ran; its result is non-authoritative.");
        assertExecutionAuthority(fresh, diskPlanSnapshot(ctx, fresh), authorization.expectation, authorization.operation, ctx.signal);
        authorizedCalls.set(event.toolCallId, { ...authorization, status: "consumed" });
      } catch (error) {
        authorizedCalls.set(event.toolCallId, { ...authorization, status: "invalidated", reason: errorText(error) });
        return staleToolResult(errorText(error));
      }
    } else if (authorization?.kind === "other") {
      if (authorization.status === "consumed") return staleToolResult("Duplicate tool result ID is non-authoritative.");
      authorizedCalls.set(event.toolCallId, { ...authorization, status: "consumed" });
    } else {
      let fresh: any;
      try { fresh = currentWorkflow(ctx); } catch {}
      if (isDeclaredExecutionTool(fresh, event.toolName)) return staleToolResult("Unknown execution tool result ID has no matching host authorization.");
    }
    if (event.toolName === "solar_interview_round" && event.details?.interviewValidationError) return { isError: true };
    if (event.details?.workflowValidationError || event.details?.webValidationError) return { isError: true };
  });

  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") context?.ui.setStatus("solar-rate", undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    const fresh = currentWorkflow(ctx);
    if (fresh?.status !== "active") return;
    const current = initializeLoop(fresh);
    saveWorkflow({ ...current, turns: current.turns + 1 });
    if (workflow.turns >= workflow.limits.turns) {
      planningRunner?.stop();
      saveWorkflow({ ...workflow, status: "limited", limitStop: { kind: "turns", bound: workflow.limits.turns }, reason: "Model-turn limit reached; checkpoints and role receipts are saved. Raise limits explicitly to continue.", pendingHandoff: false });
      active = false;
      restoreTools();
      ctx.abort();
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    workflow = currentWorkflow(ctx);
    if (workflow?.status === "active" && ["research", "plan"].includes(workflow.stage) && !ctx.hasPendingMessages() && !planningRunner) {
      const last: any = [...branch(ctx)].reverse().find(entry => entry.message?.role === "assistant")?.message;
      if (["error", "aborted", "length"].includes(last?.stopReason) || ctx.signal?.aborted || (workflow.reminder ?? 0) >= 1) {
        saveWorkflow({ ...workflow, status: "paused", pendingHandoff: false, reason: `${workflow.stage === "research" ? "ResearchContractV2" : "The host-owned V3 plan/review cycle"} did not reach a valid boundary. Saved evidence and diagnostics remain available; no research-only/planning-only completion was inferred.` });
      } else {
        saveWorkflow({ ...workflow, reminder: (workflow.reminder ?? 0) + 1 });
        pi.sendMessage({ customType: "solar-handoff-reminder-v3", content: workflow.stage === "research" ? "Submit a complete ResearchReadyInput through solar_research_ready. The host must validate and persist its reserved research.md even at a research-only boundary. Correct only the reported lineage/receipt defect; never write the artifact generically." : "Call solar_plan_ready({}) to trigger the host-owned Planner, Approach Reviewer, Critic, revision, and both-re-review cycle. Do not write plan.md or fabricate reviews.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
      }
      restoreTools();
    }
    if (workflow?.status === "active" && workflow.stage === "execute" && !ctx.hasPendingMessages()) {
      const last: any = [...branch(ctx)].reverse().find(entry => entry.message?.role === "assistant")?.message;
      if (["error", "aborted", "length"].includes(last?.stopReason) || ctx.signal?.aborted || (workflow.reminder ?? 0) >= 1) {
        saveWorkflow({ ...workflow, status: "paused", pendingHandoff: false, reason: "Execution ended without a current authority-checked checkpoint. Inspect the tool/gate error before resuming; no completion was inferred." });
        restoreTools();
      } else {
        saveWorkflow({ ...workflow, reminder: (workflow.reminder ?? 0) + 1 });
        pi.sendMessage({ customType: "solar-checkpoint-reminder-v3", content: "Use solar_step_done with the exact current stepId, concrete approach, and declared evidence paths, or solar_revisit for one consequential gap. Model prose is never a checkpoint or completion.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
      }
    }
    if (!active || settledReport || closed || ctx.hasPendingMessages()) return;
    const lastAssistant: any = [...branch(ctx)].reverse().find(entry => entry.type === "message" && entry.message?.role === "assistant")?.message;
    if (["error", "aborted", "length"].includes(lastAssistant?.stopReason) || ctx.signal?.aborted || toolCalls >= 6 || repairs >= 1) {
      showInterview(korean ? "자동 수정이 중단되었습니다. 저장된 V2 증거는 유지됩니다." : "Automatic correction stopped. Saved V2 evidence remains; retry or explicitly choose a closure/recovery action.", "stopped");
      return;
    }
    repairs += 1;
    pi.sendMessage({ customType: "solar-interview-repair-v2", content: "The preceding reply did not commit a complete InterviewRoundV2 for the current answer/research heads. Call solar_interview_round now using only exact saved evidence; do not ask for another answer first.", display: false }, { triggerTurn: true, deliverAs: "followUp" });
  });
}

export default function liteRuntime(pi: ExtensionAPI) {
  installLiteRuntime(pi);
}

export { installLiteRuntime as installSolarRuntime };
