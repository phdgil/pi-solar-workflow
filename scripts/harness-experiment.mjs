import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HARNESS_CASES,
  fixtureManifest,
  getHarnessFixture,
  gradeHarnessResult,
  listHarnessFixtures,
  sha256Text,
  validateFixtureGoal,
  validateSyntheticApproval,
} from "./harness-fixtures.mjs";

const REQUIRED_SKILLS = ["solar-research", "solar-interview", "solar-plan", "solar-execute"];
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;
const CONTROL_TOOLS = new Set(["solar_interview_round", "solar_research_ready", "solar_plan_ready", "solar_revisit", "solar_step_done"]);
const MUTATING_TOOLS = new Set(["write", "edit", "bash", "powershell"]);
const PROVIDER = "upstage";
const MODEL = "solar-pro4";
const THINKING = "max";

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function safeError(error) {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
}

function validEntryId(value) {
  return typeof value === "string"
    && value.length > 0
    && /^[^\s\u0000-\u001f\u007f]+$/u.test(value);
}

function validateEntryPageReceipt(value, since = undefined) {
  if (since !== undefined && !validEntryId(since)) throw new Error("RPC get_entries requires a nonempty well-formed cursor.");
  if (!Array.isArray(value?.entries)) throw new Error("RPC get_entries returned a malformed cursor receipt.");
  const identifiers = value.entries.map(entry => entry?.id);
  if (identifiers.some(identifier => !validEntryId(identifier))) throw new Error("RPC get_entries returned an entry with a malformed ID.");
  if (new Set(identifiers).size !== identifiers.length) throw new Error("RPC get_entries returned duplicate entry IDs.");
  if (since !== undefined && identifiers.includes(since)) throw new Error("RPC get_entries repeated its exclusive cursor in the subsequent page.");
  if (value.entries.length === 0) {
    const expectedLeaf = since ?? null;
    if (value.leafId !== expectedLeaf) throw new Error("RPC get_entries returned an invalid leaf for an empty page.");
  } else if (!validEntryId(value.leafId) || value.leafId !== identifiers.at(-1)) {
    throw new Error("RPC get_entries leaf must be the unique final entry ID.");
  }
  return { entries: value.entries, leafId: value.leafId };
}

export function sanitizeDiagnostic(value) {
  return String(value ?? "")
    .replace(/\b(Authorization\s*:\s*Bearer)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*)["']?[^\s,"';}]+/giu, "$1[REDACTED]")
    .replace(/\b(?:sk|tvly)-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]");
}

function optionValue(argv, index, name) {
  const argument = argv[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  if (argument !== name) return undefined;
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
  return { value: argv[index + 1], consumed: 1 };
}

function positiveInteger(value, name, maximum) {
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${name} must be between 1 and ${maximum}.`);
  return parsed;
}

export function parseHarnessArguments(argv) {
  const options = {
    checkout: undefined,
    label: undefined,
    output: undefined,
    caseName: undefined,
    repeat: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    deadlineAt: undefined,
    list: false,
    help: false,
    exactArgs: [...argv],
  };
  const valueOptions = new Map([
    ["--checkout", "checkout"],
    ["--label", "label"],
    ["--output", "output"],
    ["--case", "caseName"],
    ["--repeat", "repeat"],
    ["--timeout-ms", "timeoutMs"],
    ["--deadline-at", "deadlineAt"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") {
      options.list = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    let matched = false;
    for (const [name, field] of valueOptions) {
      const found = optionValue(argv, index, name);
      if (!found) continue;
      if (options[field] !== undefined && !["repeat", "timeoutMs"].includes(field)) throw new Error(`${name} may be supplied only once.`);
      options[field] = found.value;
      index += found.consumed;
      matched = true;
      break;
    }
    if (!matched) throw new Error(`Unknown argument: ${argument}`);
  }
  if (typeof options.repeat === "string") options.repeat = positiveInteger(options.repeat, "--repeat", 100);
  if (typeof options.timeoutMs === "string") options.timeoutMs = positiveInteger(options.timeoutMs, "--timeout-ms", 3_600_000);
  if (options.deadlineAt !== undefined) validateDeadline(options.deadlineAt);
  if (options.list || options.help) return options;
  for (const [field, name] of [["checkout", "--checkout"], ["label", "--label"], ["output", "--output"], ["caseName", "--case"]]) {
    if (typeof options[field] !== "string" || !options[field].trim()) throw new Error(`${name} is required.`);
  }
  options.label = options.label.trim();
  if (options.label.length > 160 || /[\u0000-\u001f\u007f]/u.test(options.label)) throw new Error("--label must be at most 160 characters without control characters.");
  if (!HARNESS_CASES.includes(options.caseName)) throw new Error(`Unknown --case ${options.caseName}. Use --list.`);
  return options;
}

export function harnessUsage() {
  return [
    "Usage:",
    "  node scripts/harness-experiment.mjs --checkout PATH --label STRING --output PATH --case CASE [--repeat N] [--timeout-ms MS] [--deadline-at UTC_ISO]",
    "  node scripts/harness-experiment.mjs --list",
  ].join("\n");
}

function validateDeadline(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("--deadline-at must be an exact UTC ISO timestamp, including milliseconds and Z.");
  }
  return timestamp;
}

export function boundedRunTimeout(timeoutMs, deadlineAt, now = Date.now()) {
  if (deadlineAt === undefined) return timeoutMs;
  // Reserve failure recovery and process shutdown time; never reset the campaign
  // deadline when a repeat starts.
  const remaining = validateDeadline(deadlineAt) - now - 30_000;
  return remaining > 0 ? Math.min(timeoutMs, remaining) : null;
}

export function discoverPiCli(environment = process.env) {
  const configured = environment.PI_CLI_PATH?.trim();
  if (configured) {
    const candidate = path.resolve(configured);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error(`PI_CLI_PATH does not name an installed Pi CLI file: ${candidate}`);
    return realpathSync(candidate);
  }
  const npmCliCandidates = [
    environment.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(candidate => candidate && existsSync(candidate));
  let npmRoot;
  if (npmCliCandidates.length) {
    npmRoot = execFileSync(process.execPath, [npmCliCandidates[0], "root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
  } else if (process.platform !== "win32") {
    npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
  } else {
    throw new Error("Cannot locate npm-cli.js; set PI_CLI_PATH to the installed Pi dist/bundle/cli.js.");
  }
  const candidate = path.join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error(`Installed Pi CLI was not found under npm root: ${candidate}`);
  return realpathSync(candidate);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function walkFiles(root, relativeRoot, result) {
  const absolute = path.join(root, ...relativeRoot.split("/").filter(Boolean));
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Checkout source hashing refuses symbolic links: ${relative}`);
    if (entry.isDirectory()) walkFiles(root, relative, result);
    else if (entry.isFile()) result.push(relative);
  }
}

function checkoutSourceReceipt(checkout) {
  const files = [];
  for (const relative of ["runtime", "skills", "harness"]) {
    const absolute = path.join(checkout, relative);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) walkFiles(checkout, relative, files);
  }
  if (existsSync(path.join(checkout, "package.json"))) files.push("package.json");
  const selected = [...new Set(files)]
    .filter(relative => !/\.test\.mjs$/u.test(relative))
    .sort((left, right) => left.localeCompare(right));
  const fileSha256 = {};
  for (const relative of selected) fileSha256[relative] = sha256Buffer(readFileSync(path.join(checkout, ...relative.split("/"))));
  const sourceSha256 = sha256Text(JSON.stringify(Object.entries(fileSha256)));
  return { sourceSha256, fileSha256 };
}

function cliReceipt(cliPath) {
  const packagePath = path.resolve(path.dirname(cliPath), "..", "..", "package.json");
  let version = null;
  try { version = JSON.parse(readFileSync(packagePath, "utf8")).version ?? null; } catch {}
  return { path: cliPath, sha256: sha256Buffer(readFileSync(cliPath)), version };
}

export function experimentProtocolReceipt() {
  const fileSha256 = {};
  for (const name of ["harness-experiment.mjs", "harness-fixtures.mjs"]) {
    fileSha256[name] = sha256Buffer(readFileSync(new URL(name, import.meta.url)));
  }
  return { fileSha256, protocolSha256: sha256Text(JSON.stringify(fileSha256)) };
}

function writeJson(file, value, flag = undefined) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", ...(flag ? { flag } : {}) });
}

function replaceJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeJson(temporary, value, "wx");
  renameSync(temporary, file);
}

function materializeFixture(workspace, fixture) {
  mkdirSync(workspace, { recursive: false });
  for (const [relative, content] of Object.entries(fixture.files)) {
    if (relative.includes("\\") || relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Unsafe fixture path: ${relative}`);
    const target = path.join(workspace, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
  }
}

function snapshotWorkspace(workspace) {
  const snapshot = {};
  function visit(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        snapshot[relative] = { type: "symlink", bytes: metadata.size, sha256: null };
      } else if (metadata.isDirectory()) {
        visit(absolute, relative);
      } else if (metadata.isFile()) {
        const bytes = readFileSync(absolute);
        snapshot[relative] = { type: "file", bytes: bytes.length, sha256: sha256Buffer(bytes) };
      } else {
        snapshot[relative] = { type: "other", bytes: metadata.size, sha256: null };
      }
    }
  }
  visit(workspace);
  return snapshot;
}

function containedFile(workspace, candidate) {
  const root = normalizedPath(workspace);
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(workspace, candidate);
  const normalized = normalizedPath(resolved);
  if (normalized !== root && !normalized.startsWith(`${root}${path.sep}`)) throw new Error(`Path leaves fixture workspace: ${candidate}`);
  return resolved;
}

function readOutputContents(workspace, fixture) {
  const result = {};
  for (const relative of fixture.outputPaths) {
    const target = containedFile(workspace, relative);
    if (existsSync(target) && lstatSync(target).isFile()) result[relative] = readFileSync(target, "utf8");
  }
  return result;
}

function trimDiagnostic(value) {
  const text = sanitizeDiagnostic(value);
  if (Buffer.byteLength(text, "utf8") <= MAX_DIAGNOSTIC_BYTES) return text;
  const half = Math.floor(MAX_DIAGNOSTIC_BYTES / 2);
  return `${Buffer.from(text).subarray(0, half).toString("utf8")}\n[diagnostic truncated]\n${Buffer.from(text).subarray(-half).toString("utf8")}`;
}

export class RpcClient {
  protocolError = null;

  constructor(options) {
    this.events = [];
    this.pending = new Map();
    this.sequence = 0;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.stderrTruncated = false;
    this.closing = false;
    this.stdoutFd = openSync(options.stdoutPath, "wx");
    this.eventsFd = openSync(options.eventsPath, "wx");
    this.child = spawn(process.execPath, [options.cliPath, ...options.arguments], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.processClosed = new Promise(resolve => this.child.once("close", (code, signal) => {
      this.processIsClosed = true;
      resolve({ code, signal });
    }));
    this.child.stdout.setEncoding("utf8").on("data", chunk => this.consumeStdout(chunk));
    this.child.stderr.setEncoding("utf8").on("data", chunk => {
      if (Buffer.byteLength(this.stderr, "utf8") < MAX_DIAGNOSTIC_BYTES * 2) this.stderr += chunk;
      else this.stderrTruncated = true;
    });
    this.child.once("error", error => this.failPending(error));
    this.child.once("exit", (code, signal) => {
      if (!this.closing && (code !== 0 || signal)) this.failPending(new Error(`Pi RPC exited with ${code ?? signal}. ${this.diagnostic()}`));
      else if (!this.closing && this.pending.size) this.failPending(new Error(`Pi RPC exited before pending commands completed. ${this.diagnostic()}`));
    });
  }

  consumeStdout(chunk) {
    writeSync(this.stdoutFd, chunk, undefined, "utf8");
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.consumeLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  consumeLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch {
      this.protocolError ??= new Error("Pi RPC emitted non-JSON stdout; inspect the retained pi-rpc-stdout.jsonl.");
      this.failPending(this.protocolError);
      return;
    }
    if (message.type !== "response") {
      this.events.push(message);
      writeSync(this.eventsFd, `${line}\n`, undefined, "utf8");
    }
    if (message.type === "response" && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      pending.response = message;
      this.settlePending(message.id);
    }
  }

  settlePending(id) {
    const pending = this.pending.get(id);
    if (!pending?.writeCompleted || !pending.response) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.response.success) pending.resolve(pending.response);
    else pending.reject(new Error(`RPC ${pending.response.command ?? pending.command} failed: ${sanitizeDiagnostic(pending.response.error ?? "unknown error")}. ${this.diagnostic()}`));
  }

  diagnostic() {
    const value = trimDiagnostic(this.stderr);
    return value ? `Pi stderr: ${value}` : "Pi stderr was empty.";
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(type, fields, deadline, maximumWaitMs = undefined, onDispatched = undefined) {
    if (this.protocolError) return Promise.reject(this.protocolError);
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.reject(new Error(`Pi RPC is not running. ${this.diagnostic()}`));
    const remaining = Math.max(0, deadline - Date.now());
    const wait = Math.min(remaining, maximumWaitMs ?? remaining);
    if (wait < 1) return Promise.reject(new Error(`RPC ${type} exceeded the run deadline.`));
    const id = `harness-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${type} timed out. ${this.diagnostic()}`));
      }, wait);
      this.pending.set(id, { resolve, reject, timer, command: type, response: null, writeCompleted: false });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, type, ...(fields ?? {}) })}\n`, error => {
          if (!error) {
            const pending = this.pending.get(id);
            if (!pending) return;
            try {
              onDispatched?.({ id, type });
            } catch (dispatchError) {
              clearTimeout(timer);
              this.pending.delete(id);
              reject(dispatchError);
              return;
            }
            pending.writeCompleted = true;
            this.settlePending(id);
            return;
          }
          if (!this.pending.has(id)) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async waitForSettled(since, deadline) {
    let idleSince;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) throw new Error(`Pi RPC exited before settling. ${this.diagnostic()}`);
      const response = await this.request("get_state", {}, deadline, 5_000);
      const state = response.data;
      const busy = Boolean(state?.isStreaming || state?.isCompacting || state?.isRetrying || state?.pendingMessageCount);
      const settled = this.events.slice(since).some(event => event.type === "agent_settled");
      if (!busy) {
        idleSince ??= Date.now();
        if (settled || Date.now() - idleSince >= 1_000) return state;
      } else {
        idleSince = undefined;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Pi RPC did not settle before the run deadline. ${this.diagnostic()}`);
  }

  async prompt(message, deadline, options = {}) {
    const since = this.events.length;
    await this.request("prompt", { message }, deadline, undefined, options.onDispatched);
    return this.waitForSettled(since, deadline);
  }

  async entryPage(deadline, maximumWaitMs = undefined, since = undefined) {
    const data = (await this.request("get_entries", since === undefined ? {} : { since }, deadline, maximumWaitMs)).data;
    return validateEntryPageReceipt(data, since);
  }

  async entries(deadline, maximumWaitMs = undefined) {
    return (await this.entryPage(deadline, maximumWaitMs)).entries;
  }

  async close(options = {}) {
    if (options.abort && this.child.exitCode === null && this.child.signalCode === null) {
      try { await this.request("abort", {}, Date.now() + 2_000, 2_000); } catch {}
    }
    this.closing = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end();
      await Promise.race([this.processClosed, new Promise(resolve => setTimeout(resolve, 3_000))]);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await Promise.race([this.processClosed, new Promise(resolve => setTimeout(resolve, 2_000))]);
      }
    } else {
      await Promise.race([this.processClosed, new Promise(resolve => setTimeout(resolve, 1_000))]);
    }
    this.finishProtocol();
    if (!this.processIsClosed) {
      this.child.stdout.removeAllListeners("data");
      this.child.stderr.removeAllListeners("data");
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
    this.failPending(new Error("Pi RPC closed."));
    closeSync(this.stdoutFd);
    closeSync(this.eventsFd);
    return { exitCode: this.child.exitCode, signal: this.child.signalCode };
  }

  finishProtocol() {
    if (this.stdoutBuffer.trim()) this.protocolError ??= new Error("Pi RPC ended with an incomplete stdout record; raw bytes are retained.");
    this.stdoutBuffer = "";
  }
}

function latestCustom(entries, customType) {
  return [...(entries ?? [])].reverse().find(entry => entry?.type === "custom" && entry.customType === customType)?.data;
}

function readyInterview(entries) {
  const state = latestCustom(entries, "solar-interview-state-v2");
  return state?.proposal?.readiness?.status === "ready"
    && state.proposal.readiness.materialGaps?.length === 0
    && state.proposal.readiness.contradictions?.length === 0
    && /^[a-f0-9]{12}$/u.test(state.goalToken ?? "")
    ? state
    : undefined;
}

async function recover(client, runtime, deadline) {
  const entries = await client.entries(deadline);
  return { entries, workflow: runtime.recoverWorkflow(entries) };
}

function readAndValidatePlan(workspace, workflow, runtime) {
  if (!workflow?.plan?.path) throw new Error("No controller-owned plan was persisted.");
  const planPath = containedFile(workspace, workflow.plan.path);
  const planText = readFileSync(planPath, "utf8");
  const contract = runtime.validateExecutionPlan(planText);
  return { planPath, planText, contract };
}

function eligibilityReceipt(validation) {
  return {
    safe: validation.safe === true,
    eligible: validation.approved === true,
    decision: validation.approved === true ? "eligible_synthetic_fixture" : "ineligible_synthetic_fixture",
    policyDecision: validation.decision,
    caseName: validation.caseName,
    evaluatorCommand: validation.evaluatorCommand,
    violations: [...(validation.violations ?? [])],
  };
}

function unconfirmedApproval(eligibility, request = null, violations = []) {
  return {
    safe: eligibility?.safe === true,
    eligible: eligibility?.eligible === true,
    approved: false,
    decision: request ? "host_approval_unconfirmed" : "host_approval_not_requested",
    eligibilityDecision: eligibility?.decision ?? null,
    caseName: eligibility?.caseName ?? null,
    evaluatorCommand: eligibility?.evaluatorCommand ?? null,
    request,
    grant: null,
    violations: [...violations],
  };
}

function approvalGrantMismatches(request, workflow) {
  const mismatches = [];
  if (!workflow || workflow.id !== request.workflowId) mismatches.push("workflow_identity_mismatch");
  if (workflow?.stage !== "execute") mismatches.push("execute_stage_not_granted");
  if (workflow?.status !== "active") mismatches.push("active_execution_not_granted");
  if (workflow?.revision !== request.planRevision || workflow?.plan?.revision !== request.planRevision) mismatches.push("plan_revision_not_granted");
  if (workflow?.artifactTableRevision !== request.artifactTableRevision) mismatches.push("artifact_table_revision_not_current");
  if (workflow?.approval !== request.planRevision) mismatches.push("plan_approval_not_granted");
  if (workflow?.approvalArtifactTableRevision !== request.artifactTableRevision) mismatches.push("artifact_table_approval_not_granted");
  return mismatches;
}

function approvalGrantEntry(entry, request) {
  if (entry?.type !== "custom"
    || entry.customType !== "solar-workflow-state-v1"
    || typeof entry.id !== "string"
    || !entry.id
    || entry.id === request.entryWatermark
    || entry.data?.version !== 3
    || approvalGrantMismatches(request, entry.data).length) return null;
  return {
    entryId: entry.id,
    workflowId: entry.data.id,
    planRevision: entry.data.approval,
    artifactTableRevision: entry.data.approvalArtifactTableRevision,
    stage: entry.data.stage,
    status: entry.data.status,
  };
}

export function reconcileHostApproval(flow, evidence) {
  const request = flow?.approvalRequest;
  if (!request || flow.approval?.approved === true) return flow?.approval ?? null;
  if (request.dispatched !== true
    || typeof request.rpcRequestId !== "string"
    || !/^harness-[A-Za-z0-9_-]+$/u.test(request.rpcRequestId)
    || typeof request.workflowId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(request.workflowId)
    || !/^[a-f0-9]{64}$/u.test(request.planRevision ?? "")
    || !/^[a-f0-9]{64}$/u.test(request.artifactTableRevision ?? "")
    || typeof request.entryWatermark !== "string"
    || !request.entryWatermark
    || !Number.isInteger(request.eventIndex)
    || request.eventIndex < 0
    || request.command !== `/solar-workflow approve ${request.planRevision.slice(0, 12)}`) {
    flow.approval = unconfirmedApproval(flow.approvalEligibility, request, ["approval_request_not_dispatched"]);
    flow.approvalBoundaryEventIndex = null;
    return flow.approval;
  }
  let page;
  try {
    if (!evidence || evidence.since !== request.entryWatermark) throw new Error("Approval evidence does not start at the dispatched request's entry watermark.");
    page = validateEntryPageReceipt(evidence, request.entryWatermark);
  } catch (error) {
    flow.approval = unconfirmedApproval(flow.approvalEligibility, request, [`request_bounded_grant_evidence_unavailable:${safeError(error)}`]);
    flow.approvalBoundaryEventIndex = null;
    return flow.approval;
  }
  const grant = page.entries.map(entry => approvalGrantEntry(entry, request)).find(Boolean);
  if (!grant) {
    flow.approval = unconfirmedApproval(flow.approvalEligibility, request, ["matching_host_approval_not_observed"]);
    flow.approvalBoundaryEventIndex = null;
    return flow.approval;
  }
  grant.observedLeafId = page.leafId;
  flow.approval = {
    safe: flow.approvalEligibility?.safe === true,
    eligible: flow.approvalEligibility?.eligible === true,
    approved: flow.approvalEligibility?.eligible === true,
    decision: flow.approvalEligibility?.eligible === true ? "approved_current_host_grant" : "ineligible_host_grant",
    eligibilityDecision: flow.approvalEligibility?.decision ?? null,
    caseName: flow.approvalEligibility?.caseName ?? null,
    evaluatorCommand: flow.approvalEligibility?.evaluatorCommand ?? null,
    request,
    grant,
    violations: flow.approvalEligibility?.eligible === true ? [] : ["policy_ineligible_despite_host_grant"],
  };
  flow.approvalBoundaryEventIndex = flow.approval.approved ? request.eventIndex : null;
  return flow.approval;
}

async function recoverHostApproval(client, flow, deadline, maximumWaitMs = undefined) {
  const request = flow?.approvalRequest;
  if (!request?.dispatched || typeof request.entryWatermark !== "string") return reconcileHostApproval(flow, null);
  try {
    const page = validateEntryPageReceipt(await client.entryPage(deadline, maximumWaitMs, request.entryWatermark), request.entryWatermark);
    return reconcileHostApproval(flow, { since: request.entryWatermark, entries: page.entries, leafId: page.leafId });
  } catch (error) {
    const diagnostic = `request_bounded_grant_evidence_unavailable:${safeError(error)}`;
    flow.approval = unconfirmedApproval(flow.approvalEligibility, request, [diagnostic]);
    flow.approvalBoundaryEventIndex = null;
    return flow.approval;
  }
}

export async function runFixtureFlow(fixture, client, runtime, workspace, deadline, flow) {
  const prompts = flow.prompts;
  const send = async (message, options = undefined) => {
    prompts.push(message);
    await client.prompt(message, deadline, options);
    return recover(client, runtime, deadline);
  };
  let current = await send(fixture.initialPrompt);

  if (fixture.kind === "research" || fixture.kind === "plan") return { ...flow, ...current };

  if (fixture.kind === "interview") {
    current = await send(fixture.answers[0]);
    current = await send(fixture.answers[1]);
    if (!readyInterview(current.entries)) current = await send(fixture.answers[2]);
    if (!readyInterview(current.entries)) flow.blockedReason = "predefined_interview_answers_exhausted";
    return { ...flow, ...current };
  }

  if (fixture.kind !== "execute") throw new Error(`Unsupported fixture kind: ${fixture.kind}`);
  if (!new Set(["execute-summary", "execute-inventory-heldout", "execute-module-alias-heldout", "execute-access-matrix-heldout"]).has(fixture.name)) throw new Error("Programmatic confirmation is forbidden outside the explicit synthetic execute allowlist.");
  let interview = readyInterview(current.entries);
  for (const answer of fixture.answers) {
    if (interview) break;
    current = await send(answer);
    interview = readyInterview(current.entries);
  }
  if (!interview) {
    flow.blockedReason = "predefined_interview_answers_exhausted";
    return { ...flow, ...current };
  }
  flow.confirmation = validateFixtureGoal(fixture.name, interview.proposal.readiness.goalSentence);
  if (!flow.confirmation.accepted) {
    flow.blockedReason = "goal_semantics_not_fixture_exact";
    return { ...flow, ...current };
  }

  current = await send(`/solar-interview confirm ${interview.goalToken}`);
  let plan;
  try {
    plan = readAndValidatePlan(workspace, current.workflow, runtime);
    flow.planContract = plan.contract;
  } catch (error) {
    flow.approvalEligibility = eligibilityReceipt({ safe: false, approved: false, decision: "unsafe_not_approved", caseName: fixture.name, evaluatorCommand: fixture.evaluatorCommand, violations: [`checkout_plan_validation_failed:${safeError(error)}`] });
    flow.approval = unconfirmedApproval(flow.approvalEligibility, null, [...flow.approvalEligibility.violations]);
    flow.unsafe = Boolean(current.workflow?.plan);
    if (!current.workflow?.plan) flow.blockedReason = "reviewed_plan_not_available";
    return { ...flow, ...current };
  }

  flow.approvalEligibility = eligibilityReceipt(validateSyntheticApproval(plan.contract, fixture.name));
  flow.approval = unconfirmedApproval(flow.approvalEligibility);
  if (!flow.approvalEligibility.eligible) {
    flow.unsafe = true;
    return { ...flow, ...current };
  }
  if (current.workflow?.status !== "awaiting_gate_review"
    || current.workflow?.planning?.revisionState !== "reviewed"
    || !current.workflow?.autoExecute
    || typeof current.workflow?.id !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(current.workflow.id)
    || !/^[a-f0-9]{64}$/u.test(current.workflow?.revision ?? "")
    || sha256Text(plan.planText) !== current.workflow.revision
    || current.workflow?.plan?.revision !== current.workflow.revision
    || !/^[a-f0-9]{64}$/u.test(current.workflow?.artifactTableRevision ?? "")
    || current.workflow?.approval !== undefined
    || current.workflow?.approvalArtifactTableRevision !== undefined) {
    flow.approval = unconfirmedApproval(flow.approvalEligibility, null, ["workflow_not_ready_for_host_approval"]);
    flow.blockedReason = "reviewed_plan_not_awaiting_approval";
    return { ...flow, ...current };
  }

  let entryWatermark;
  try {
    const beforeDispatch = validateEntryPageReceipt(await client.entryPage(deadline, undefined), undefined);
    entryWatermark = beforeDispatch.leafId;
    if (typeof entryWatermark !== "string"
      || !entryWatermark
      || beforeDispatch.entries.at(-1)?.id !== entryWatermark) throw new Error("No current session-entry cursor is available.");
  } catch (error) {
    flow.approval = unconfirmedApproval(flow.approvalEligibility, null, [`approval_request_not_dispatched:${safeError(error)}`]);
    flow.blockedReason = "host_approval_evidence_unavailable";
    return { ...flow, ...current };
  }
  const command = `/solar-workflow approve ${current.workflow.revision.slice(0, 12)}`;
  flow.approvalRequest = {
    workflowId: current.workflow.id,
    planRevision: current.workflow.revision,
    artifactTableRevision: current.workflow.artifactTableRevision,
    entryWatermark,
    eventIndex: client.events.length,
    command,
    dispatched: false,
    rpcRequestId: null,
  };
  flow.approval = unconfirmedApproval(flow.approvalEligibility, flow.approvalRequest, ["matching_host_approval_not_observed"]);
  try {
    current = await send(command, {
      onDispatched: dispatch => {
        flow.approvalRequest.dispatched = true;
        flow.approvalRequest.rpcRequestId = dispatch?.id;
      },
    });
  } catch (error) {
    await recoverHostApproval(client, flow, Date.now() + 3_000, 3_000);
    throw error;
  }
  await recoverHostApproval(client, flow, deadline);
  if (!flow.approval.approved) {
    flow.blockedReason = "host_approval_not_confirmed";
    return { ...flow, ...current };
  }
  if (current.workflow?.status === "awaiting_final_review") flow.blockedReason = "human_or_rubric_final_requires_real_user_review";
  else if (["paused", "limited", "revision_required"].includes(current.workflow?.status)) flow.blockedReason = current.workflow.status;
  return { ...flow, ...current };
}

function commandPath(command) {
  if (typeof command?.sourceInfo?.path !== "string" || !existsSync(command.sourceInfo.path)) return null;
  try { return realpathSync(command.sourceInfo.path); } catch { return null; }
}

async function preflight(client, checkout, skillPaths, deadline) {
  const state = (await client.request("get_state", {}, deadline, 10_000)).data;
  const commands = (await client.request("get_commands", {}, deadline, 10_000)).data.commands ?? [];
  const expected = REQUIRED_SKILLS.map((name, index) => {
    const matches = commands.filter(command => command.name === `skill:${name}` && command.source === "skill");
    const selected = matches.length === 1 ? matches[0] : null;
    const selectedPath = commandPath(selected);
    const provenance = selected?.sourceInfo ? {
      source: selected.sourceInfo.source ?? null,
      scope: selected.sourceInfo.scope ?? null,
      origin: selected.sourceInfo.origin ?? null,
      baseDir: selected.sourceInfo.baseDir ?? null,
    } : null;
    const exactProvenance = provenance?.source === "local"
      && provenance.scope === "temporary"
      && provenance.origin === "top-level"
      && typeof provenance.baseDir === "string"
      && samePath(provenance.baseDir, path.dirname(skillPaths[index]));
    return {
      name,
      expectedPath: skillPaths[index],
      matches: matches.length,
      selectedPath,
      provenance,
      exactPath: Boolean(selectedPath && samePath(selectedPath, skillPaths[index])),
      exactProvenance,
    };
  });
  const skillCommands = commands.filter(command => command.source === "skill");
  const modelPassed = state?.model?.provider === PROVIDER && state?.model?.id === MODEL && state?.thinkingLevel === THINKING;
  const skillsPassed = expected.every(item => item.matches === 1 && item.exactPath && item.exactProvenance) && skillCommands.length === REQUIRED_SKILLS.length;
  const extensionCommands = ["solar-workflow", "solar-interview"].map(name => commands.some(command => command.name === name && command.source === "extension"));
  const extensionPassed = extensionCommands.every(Boolean);
  const result = {
    passed: modelPassed && skillsPassed && extensionPassed,
    checkout,
    model: state?.model ? { provider: state.model.provider, id: state.model.id, api: state.model.api ?? null } : null,
    thinkingLevel: state?.thinkingLevel ?? null,
    expectedSkills: expected,
    discoveredSkillCount: skillCommands.length,
    noSkillsIsolationVerified: skillsPassed,
    extensionCommandsPresent: extensionPassed,
  };
  if (!result.passed) throw Object.assign(new Error("Pi preflight did not verify the exact Solar model, thinking level, explicit checkout skills, and extension commands."), { preflight: result, commands });
  return { result, commands, state };
}

function observedPath(workspace, candidate) {
  if (typeof candidate !== "string" || !candidate) return null;
  try {
    const absolute = path.resolve(workspace, candidate);
    const root = normalizedPath(workspace);
    const normalized = normalizedPath(absolute);
    if (normalized !== root && !normalized.startsWith(`${root}${path.sep}`)) return null;
    return path.relative(workspace, absolute).split(path.sep).join("/");
  } catch {
    return null;
  }
}

export function auditObservedOperations(events, options) {
  const fixture = typeof options.fixture === "string" ? getHarnessFixture(options.fixture) : structuredClone(options.fixture);
  const allowedReads = new Set([...fixture.allowedReadPaths, ...fixture.outputPaths]);
  const outputs = new Set(fixture.outputPaths);
  const approvalEventIndex = Number.isInteger(options.approvalEventIndex) && options.approvalEventIndex >= 0
    ? options.approvalEventIndex
    : null;
  const unauthorized = [];
  const preApprovalMutations = [];
  const operations = [];
  for (let index = 0; index < (events ?? []).length; index += 1) {
    const event = events[index];
    if (event?.type !== "tool_execution_start") continue;
    const tool = event.toolName;
    const beforeApproval = approvalEventIndex === null || index < approvalEventIndex;
    const relative = observedPath(options.workspace, event.args?.path);
    const command = typeof event.args?.command === "string" ? event.args.command : null;
    let authorized = false;
    let reason = "tool_not_in_fixture_policy";
    if (CONTROL_TOOLS.has(tool)) {
      authorized = true;
      reason = "controller_contract_tool";
    } else if (tool === "read") {
      authorized = relative !== null && allowedReads.has(relative);
      reason = authorized ? "fixture_local_read" : "read_outside_fixture";
    } else if (["write", "edit"].includes(tool)) {
      authorized = !beforeApproval && relative !== null && outputs.has(relative);
      reason = authorized ? "approved_fixture_output_write" : beforeApproval ? "mutation_before_approval" : "write_outside_fixture_output";
    } else if (["bash", "powershell"].includes(tool)) {
      authorized = !beforeApproval && command === fixture.evaluatorCommand;
      reason = authorized ? "exact_approved_evaluator" : beforeApproval ? "command_before_approval" : "command_not_exact_evaluator";
    }
    const operation = { eventIndex: index, tool, phase: beforeApproval ? "before_approval" : "after_approval", path: relative, command, authorized, reason };
    operations.push(operation);
    if (MUTATING_TOOLS.has(tool) && beforeApproval) preApprovalMutations.push(operation);
    if (!authorized) unauthorized.push(operation);
  }
  return { approvalEventIndex, operations, unauthorized, preApprovalMutations };
}

function assistantEntryMessages(entries) {
  return (entries ?? []).filter(entry => entry?.type === "message" && entry.message?.role === "assistant").map(entry => entry.message);
}

function addUsage(total, usage) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    if (typeof usage?.[key] === "number" && Number.isFinite(usage[key])) total[key] = (total[key] ?? 0) + usage[key];
  }
  return total;
}

function collectReceiptObjects(value, receipts, seen) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) collectReceiptObjects(child, receipts, seen);
    return;
  }
  if (typeof value.attemptId === "string" && typeof value.contextId === "string" && ["planner", "approach_reviewer", "critic"].includes(value.role) && value.provider === PROVIDER && value.modelId === MODEL && typeof value.outputRevision === "string") {
    if (!seen.has(value.attemptId)) {
      seen.add(value.attemptId);
      receipts.push({ attemptId: value.attemptId, contextId: value.contextId, role: value.role, attemptOrdinal: value.attemptOrdinal, repair: value.repair, inputRevision: value.inputRevision, planRevision: value.planRevision ?? null, outputRevision: value.outputRevision });
    }
    return;
  }
  for (const child of Object.values(value)) collectReceiptObjects(child, receipts, seen);
}

export function summarizeObservedMetrics(entries, workflow, sessionStats, events = []) {
  const assistants = assistantEntryMessages(entries);
  const usage = { input: null, output: null, cacheRead: null, cacheWrite: null, totalTokens: null };
  for (const message of assistants) addUsage(usage, message.usage);
  const receipts = [];
  const seen = new Set();
  for (const entry of entries ?? []) if (entry?.type === "custom") collectReceiptObjects(entry.data, receipts, seen);
  const roleAttempts = Array.isArray(workflow?.roleAttempts) ? workflow.roleAttempts.map(attempt => ({
    attemptId: attempt.attemptId,
    contextId: attempt.contextId,
    role: attempt.role,
    attemptOrdinal: attempt.attemptOrdinal,
    repair: attempt.repair,
    status: attempt.status,
    terminalReason: attempt.terminalReason ?? null,
  })) : [];
  return {
    mainSessionAgentStartsObserved: events.filter(event => event?.type === "agent_start").length,
    mainSessionAssistantCallsObserved: assistants.length,
    mainSessionAssistantUsageObserved: usage,
    sessionStatsObserved: sessionStats ?? null,
    roleSessionAttemptsObserved: roleAttempts,
    roleReceiptsObserved: receipts,
    roleSessionTokensObserved: null,
    accountingNote: "Main assistant messages and their persisted usage are counted separately from controller-recorded isolated role attempts/receipts. Role-session token usage is null because the controller does not expose provider usage for those in-memory sessions; no estimate is substituted.",
  };
}

export function detectProviderFailures(entries, events, workflow, diagnostic = "") {
  const failures = [];
  const seen = new Set();
  const add = failure => {
    const safe = { ...failure, message: sanitizeDiagnostic(failure.message ?? "") };
    const key = JSON.stringify(safe);
    if (!seen.has(key)) {
      seen.add(key);
      failures.push(safe);
    }
  };
  for (const message of assistantEntryMessages(entries)) {
    if (message.stopReason === "error" || message.errorMessage) add({ source: "assistant_entry", provider: message.provider ?? null, model: message.model ?? null, stopReason: message.stopReason ?? null, message: message.errorMessage ?? "Assistant stopped with an error." });
  }
  for (const event of events ?? []) {
    const message = event?.type === "message_end" && event.message?.role === "assistant" ? event.message : null;
    if (message && (message.stopReason === "error" || message.errorMessage)) add({ source: "message_end", provider: message.provider ?? null, model: message.model ?? null, stopReason: message.stopReason ?? null, message: message.errorMessage ?? "Assistant stopped with an error." });
    if (event?.type === "auto_retry_end" && event.success === false) add({ source: "auto_retry", provider: PROVIDER, model: MODEL, stopReason: "retry_failed", message: event.error ?? "Provider retry ended without success." });
  }
  for (const attempt of workflow?.roleAttempts ?? []) {
    if (["timed_out", "cancelled"].includes(attempt.status) || ["deadline", "session_creation_failed", "prompt_failed"].includes(attempt.terminalReason)) add({ source: "role_attempt", provider: PROVIDER, model: MODEL, stopReason: attempt.status, message: `Role ${attempt.role} attempt ${attempt.attemptOrdinal} ended as ${attempt.status}: ${attempt.terminalReason ?? "unspecified"}.` });
  }
  const safeDiagnostic = sanitizeDiagnostic(diagnostic);
  if (/\b(?:HTTP\s*)?(?:401|403|408|429|5[0-9]{2})\b|\brate[ -]?limit(?:ed|ing)?\b|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH)\b|\bfetch failed\b|\bprovider request\b[^.\n]*\bfailed\b|\bAPI request\b[^.\n]*\bfailed\b|\bAPI key\b[^.\n]*(?:missing|not found|unavailable)\b/iu.test(safeDiagnostic)) {
    add({ source: "process_diagnostic", provider: PROVIDER, model: MODEL, stopReason: "request_failed", message: safeDiagnostic.slice(-2_000) });
  }
  return failures;
}

function piArguments(checkout, sessionDir, skillPaths, sessionName) {
  return [
    "--mode", "rpc",
    "--provider", PROVIDER,
    "--model", MODEL,
    "--thinking", THINKING,
    "--offline",
    "--no-extensions",
    "-e", path.join(checkout, "runtime", "extension.ts"),
    "--no-skills",
    ...skillPaths.flatMap(skillPath => ["--skill", skillPath]),
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--session-dir", sessionDir,
    "--name", sessionName,
  ];
}

async function loadCheckoutRuntime(checkout) {
  const modulePath = path.join(checkout, "runtime", "workflow.ts");
  if (!existsSync(modulePath)) throw new Error(`Checkout runtime/workflow.ts is missing: ${modulePath}`);
  const runtime = await import(pathToFileURL(modulePath).href);
  if (typeof runtime.recoverWorkflow !== "function") throw new Error("Chosen checkout does not export recoverWorkflow.");
  const loopPath = path.join(checkout, "runtime", "loop.ts");
  const loop = await import(pathToFileURL(loopPath).href);
  if (typeof loop.validateExecutionPlan !== "function") throw new Error("Chosen checkout does not export validateExecutionPlan.");
  return { recoverWorkflow: runtime.recoverWorkflow, validateExecutionPlan: loop.validateExecutionPlan };
}

export function runStatus(grade, flow, runError, providerFailures, workflow) {
  if (flow?.unsafe) return { status: "failed", reason: "unsafe_not_approved" };
  if (flow?.preflightInvalid) return { status: "failed", reason: "invalid_installation_resources" };
  if (runError) return { status: "failed", reason: "runner_or_controller_error" };
  if (providerFailures.length && providerFailures.every(failure =>
    failure.source === "role_attempt" && ["timed_out", "cancelled"].includes(failure.stopReason))) {
    return { status: "failed", reason: "role_session_interrupted" };
  }
  if (providerFailures.length) return { status: "failed", reason: "provider_failure" };
  if (flow?.blockedReason) return { status: "blocked", reason: flow.blockedReason };
  if (grade.passed) return { status: "completed", reason: "all_case_assertions_passed" };
  if (["awaiting_final_review", "paused", "limited", "revision_required"].includes(workflow?.status)) return { status: "blocked", reason: workflow.status };
  return { status: "failed", reason: "quality_assertion_failed" };
}

async function collectAfterFailure(client) {
  try { await client.request("abort", {}, Date.now() + 2_000, 2_000); } catch {}
}

async function runOne(configuration) {
  const fixture = getHarnessFixture(configuration.caseName);
  const runName = `run-${String(configuration.ordinal).padStart(3, "0")}`;
  const runDir = path.join(configuration.output, runName);
  const workspace = path.join(runDir, "workspace");
  const sessionDir = path.join(runDir, "session");
  mkdirSync(runDir, { recursive: false });
  mkdirSync(sessionDir, { recursive: false });
  materializeFixture(workspace, fixture);
  const beforeFiles = snapshotWorkspace(workspace);
  writeJson(path.join(runDir, "fixture-manifest.json"), fixtureManifest(fixture.name), "wx");

  const skillPaths = REQUIRED_SKILLS.map(name => realpathSync(path.join(configuration.checkout, "skills", name, "SKILL.md")));
  const sessionName = `solar-harness-${fixture.name}-${String(configuration.ordinal).padStart(3, "0")}-${randomUUID()}`;
  const arguments_ = piArguments(configuration.checkout, sessionDir, skillPaths, sessionName);
  const exactInvocation = { executable: process.execPath, arguments: [configuration.cliPath, ...arguments_], cwd: workspace };
  writeJson(path.join(runDir, "pi-invocation.json"), exactInvocation, "wx");

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const deadline = started + configuration.timeoutMs;
  let client;
  let preflightResult = { passed: false, reason: "preflight_not_completed" };
  let commands = [];
  let entries = [];
  let workflow;
  let sessionStats = null;
  let finalState = null;
  let flow = { prompts: [], confirmation: null, approvalEligibility: null, approval: null, approvalRequest: null, approvalBoundaryEventIndex: null, blockedReason: null, unsafe: false, planContract: null };
  let runError;
  let exit = { exitCode: null, signal: null };

  try {
    client = new RpcClient({
      cliPath: configuration.cliPath,
      arguments: arguments_,
      cwd: workspace,
      stdoutPath: path.join(runDir, "pi-rpc-stdout.jsonl"),
      eventsPath: path.join(runDir, "pi-events.jsonl"),
    });
    const checked = await preflight(client, configuration.checkout, skillPaths, deadline);
    preflightResult = checked.result;
    commands = checked.commands;
    writeJson(path.join(runDir, "commands.json"), commands, "wx");
    flow = await runFixtureFlow(fixture, client, configuration.runtime, workspace, deadline, flow);
    entries = flow.entries ?? [];
    workflow = flow.workflow;
    sessionStats = (await client.request("get_session_stats", {}, deadline, 10_000)).data;
    finalState = (await client.request("get_state", {}, deadline, 10_000)).data;
    entries = await client.entries(deadline, 10_000);
    workflow = configuration.runtime.recoverWorkflow(entries);
  } catch (error) {
    runError = error;
    if (error?.preflight) {
      preflightResult = error.preflight;
      flow.preflightInvalid = true;
    }
    if (error?.commands) commands = error.commands;
    if (client) {
      if (flow.approvalRequest && !flow.approval?.approved) await recoverHostApproval(client, flow, Date.now() + 3_000, 3_000);
      await collectAfterFailure(client);
      try { entries = await client.entries(Date.now() + 3_000, 3_000); } catch {}
      try { workflow = configuration.runtime.recoverWorkflow(entries); } catch {}
      try { sessionStats = (await client.request("get_session_stats", {}, Date.now() + 3_000, 3_000)).data; } catch {}
      try { finalState = (await client.request("get_state", {}, Date.now() + 3_000, 3_000)).data; } catch {}
    }
  } finally {
    if (client) {
      try { exit = await client.close({ abort: Boolean(runError) }); }
      catch (error) { if (!runError) runError = error; }
      if (client.protocolError && !runError) runError = client.protocolError;
    }
  }

  if (!existsSync(path.join(runDir, "commands.json"))) writeJson(path.join(runDir, "commands.json"), commands, "wx");
  writeJson(path.join(runDir, "session-entries.json"), entries, "wx");
  if (client) writeFileSync(path.join(runDir, "pi-stderr.log"), `${trimDiagnostic(client.stderr)}${client.stderrTruncated ? "\n[stderr capture truncated]\n" : ""}`, { encoding: "utf8", flag: "wx" });
  else writeFileSync(path.join(runDir, "pi-stderr.log"), "Pi process was not spawned.\n", { encoding: "utf8", flag: "wx" });

  if (!flow.planContract && workflow?.plan?.path) {
    try { flow.planContract = readAndValidatePlan(workspace, workflow, configuration.runtime).contract; }
    catch (error) {
      if (!runError) runError = error;
    }
  }

  const afterFiles = snapshotWorkspace(workspace);
  const outputContents = readOutputContents(workspace, fixture);
  const events = client?.events ?? [];
  const providerFailures = detectProviderFailures(entries, events, workflow, `${runError ? safeError(runError) : ""}\n${client?.stderr ?? ""}`);
  const operationAudit = auditObservedOperations(events, { fixture, workspace, approvalEventIndex: flow.approvalBoundaryEventIndex });
  const metrics = summarizeObservedMetrics(entries, workflow, sessionStats, events);
  const observation = {
    preflight: preflightResult,
    providerFailures,
    events,
    entries,
    workflow,
    beforeFiles,
    afterFiles,
    outputContents,
    operationAudit,
    planContract: flow.planContract,
    approvalEligibility: flow.approvalEligibility,
    approval: flow.approval,
    confirmation: flow.confirmation,
    process: exit,
  };
  const grade = gradeHarnessResult(fixture.name, observation);
  const classification = runStatus(grade, flow, runError, providerFailures, workflow);
  const finishedAt = new Date().toISOString();
  const result = {
    schemaVersion: 1,
    status: classification.status,
    reason: classification.reason,
    label: configuration.label,
    case: fixture.name,
    heldOut: fixture.heldOut,
    repeatOrdinal: configuration.ordinal,
    startedAt,
    finishedAt,
    elapsedMs: Date.now() - started,
    timeoutMs: configuration.timeoutMs,
    checkout: configuration.checkoutReceipt,
    protocol: configuration.protocolReceipt,
    cli: configuration.cliReceipt,
    exactRunnerArgs: configuration.exactRunnerArgs,
    exactPiInvocation: exactInvocation,
    fixture: fixtureManifest(fixture.name),
    preflight: preflightResult,
    confirmation: flow.confirmation,
    approvalEligibility: flow.approvalEligibility,
    approval: flow.approval,
    blockedReason: flow.blockedReason,
    providerFailures,
    workflow: workflow ? {
      id: workflow.id ?? null,
      version: workflow.version ?? null,
      stage: workflow.stage ?? null,
      status: workflow.status ?? null,
      revision: workflow.revision ?? null,
      reason: workflow.reason ?? null,
    } : null,
    finalRpcState: finalState ? {
      model: finalState.model ? { provider: finalState.model.provider, id: finalState.model.id, api: finalState.model.api ?? null } : null,
      thinkingLevel: finalState.thinkingLevel ?? null,
      isStreaming: Boolean(finalState.isStreaming),
      isCompacting: Boolean(finalState.isCompacting),
      isRetrying: Boolean(finalState.isRetrying),
      pendingMessageCount: finalState.pendingMessageCount ?? null,
    } : null,
    metrics,
    assertions: grade.assertions,
    operationAudit,
    process: exit,
    error: runError ? safeError(runError) : null,
    protocolError: client?.protocolError ? safeError(client.protocolError) : null,
    artifacts: {
      runDirectory: runDir,
      workspace,
      events: path.join(runDir, "pi-events.jsonl"),
      rpcStdout: path.join(runDir, "pi-rpc-stdout.jsonl"),
      sessionEntries: path.join(runDir, "session-entries.json"),
      sessionDirectory: sessionDir,
      stderr: path.join(runDir, "pi-stderr.log"),
    },
  };
  writeJson(path.join(runDir, "metrics.json"), metrics, "wx");
  writeJson(path.join(runDir, "workspace-before.json"), beforeFiles, "wx");
  writeJson(path.join(runDir, "workspace-after.json"), afterFiles, "wx");
  writeJson(path.join(runDir, "result.json"), result, "wx");
  return result;
}

export async function runHarnessExperiment(options) {
  const checkout = realpathSync(path.resolve(options.checkout));
  if (!statSync(checkout).isDirectory()) throw new Error(`--checkout is not a directory: ${checkout}`);
  for (const required of ["runtime/extension.ts", "runtime/workflow.ts", "runtime/loop.ts", ...REQUIRED_SKILLS.map(name => `skills/${name}/SKILL.md`)]) {
    const target = path.join(checkout, ...required.split("/"));
    if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`Checkout is missing required file: ${required}`);
  }
  const runtime = await loadCheckoutRuntime(checkout);
  const cliPath = discoverPiCli();
  const checkoutReceipt = { path: checkout, ...checkoutSourceReceipt(checkout) };
  const installedCliReceipt = cliReceipt(cliPath);
  const protocolReceipt = experimentProtocolReceipt();
  const output = path.resolve(options.output);
  mkdirSync(output, { recursive: true });
  const manifestPath = path.join(output, "experiment.json");
  if (existsSync(manifestPath)) throw new Error(`Output already contains experiment.json; choose a fresh --output directory: ${output}`);
  const manifest = {
    schemaVersion: 1,
    status: "running",
    label: options.label,
    case: options.caseName,
    repeat: options.repeat,
    timeoutMs: options.timeoutMs,
    deadlineAt: options.deadlineAt ?? null,
    exactRunnerArgs: options.exactArgs,
    checkout: checkoutReceipt,
    protocol: protocolReceipt,
    cli: installedCliReceipt,
    createdAt: new Date().toISOString(),
    runs: [],
  };
  writeJson(manifestPath, manifest, "wx");
  for (let ordinal = 1; ordinal <= options.repeat; ordinal += 1) {
    const timeoutMs = boundedRunTimeout(options.timeoutMs, options.deadlineAt);
    if (timeoutMs === null) {
      manifest.status = "blocked";
      manifest.reason = "campaign_deadline_exhausted";
      manifest.finishedAt = new Date().toISOString();
      replaceJson(manifestPath, manifest);
      return manifest;
    }
    if (experimentProtocolReceipt().protocolSha256 !== protocolReceipt.protocolSha256) throw new Error("Experiment driver/grader changed during this invocation; start a fresh protocol run.");
    const result = await runOne({
      ordinal,
      caseName: options.caseName,
      label: options.label,
      output,
      timeoutMs,
      exactRunnerArgs: options.exactArgs,
      checkout,
      checkoutReceipt,
      protocolReceipt,
      cliPath,
      cliReceipt: installedCliReceipt,
      runtime,
    });
    manifest.runs.push({ ordinal, status: result.status, reason: result.reason, result: path.join(output, `run-${String(ordinal).padStart(3, "0")}`, "result.json") });
    replaceJson(manifestPath, manifest);
  }
  manifest.status = manifest.runs.every(run => run.status === "completed") ? "completed" : manifest.runs.some(run => run.status === "failed") ? "failed" : "blocked";
  manifest.finishedAt = new Date().toISOString();
  replaceJson(manifestPath, manifest);
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseHarnessArguments(argv);
  if (options.help) {
    process.stdout.write(`${harnessUsage()}\n`);
    return { status: "listed" };
  }
  if (options.list) {
    const listed = { cases: listHarnessFixtures() };
    process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
    return { status: "listed", ...listed };
  }
  const result = await runHarnessExperiment(options);
  process.stdout.write(`${JSON.stringify({ status: result.status, label: result.label, case: result.case, runs: result.runs }, null, 2)}\n`);
  if (result.status !== "completed") process.exitCode = 1;
  return result;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invoked && samePath(invoked, fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`${safeError(error)}\n${harnessUsage()}\n`);
    process.exitCode = 1;
  });
}
