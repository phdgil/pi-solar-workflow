import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const HARNESS_ROLE_IDS = [
  "researcher",
  "interviewer",
  "planner",
  "approach_reviewer",
  "critic",
  "executor",
] as const;

const REGISTRY_FIELDS = ["version", "model", "agents"] as const;
const MODEL_FIELDS = ["provider", "model", "thinking"] as const;
const AGENT_FIELDS = [
  "id",
  "description",
  "responsibilities",
  "boundaries",
  "input",
  "output",
  "tools",
  "skill",
  "collaboration",
  "recall",
  "errors",
] as const;

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = fileURLToPath(new URL("../harness/agents.json", import.meta.url));
const SKILLS_ROOT = fileURLToPath(new URL("../harness/skills/", import.meta.url));
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export const HARNESS_REGISTRY_MAX_BYTES = 64 * 1024;
export const HARNESS_SKILL_MAX_BYTES = 32 * 1024;
export const HARNESS_PROMPT_MAX_BYTES = 64 * 1024;

export type HarnessRole = (typeof HARNESS_ROLE_IDS)[number];

export type AgentDefinition = {
  id: HarnessRole;
  description: string;
  responsibilities: string[];
  boundaries: string[];
  input: string;
  output: string;
  tools: string;
  skill: string;
  collaboration: string;
  recall: string;
  errors: string;
};

export type HarnessRegistry = {
  version: 1;
  model: {
    provider: "upstage";
    model: "solar-pro4";
    thinking: "max";
  };
  agents: AgentDefinition[];
};

type LoadedSkill = {
  source: string;
  bytes: Buffer;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const expectedSet = new Set(expected);
  const missing = expected.filter(field => !Object.hasOwn(value, field));
  const extra = Object.keys(value).filter(field => !expectedSet.has(field));
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(extra.length > 0 ? [`unexpected ${extra.join(", ")}`] : []),
    ].join("; ");
    throw new Error(`${label} has invalid fields (${details}).`);
  }
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a nonempty string.`);
  return value;
}

function textList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a nonempty string array.`);
  return value.map((item, index) => textValue(item, `${label}[${index}]`));
}

function isHarnessRole(value: unknown): value is HarnessRole {
  return typeof value === "string" && (HARNESS_ROLE_IDS as readonly string[]).includes(value);
}

function expectedSkillPath(role: HarnessRole): string {
  return `harness/skills/${role}/SKILL.md`;
}

function expectedSkillName(role: HarnessRole): string {
  return `solar-${role.replaceAll("_", "-")}-practice`;
}

/** Parse and fully validate the package registry schema without reading any skill files. */
export function parseHarnessRegistry(source: string): HarnessRegistry {
  if (typeof source !== "string" || source.trim().length === 0) throw new Error("Harness registry source must be nonempty JSON text.");
  if (Buffer.byteLength(source, "utf8") > HARNESS_REGISTRY_MAX_BYTES) {
    throw new Error(`Harness registry exceeds its ${HARNESS_REGISTRY_MAX_BYTES}-byte limit.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Harness registry is not valid JSON: ${message}`);
  }

  const registry = objectValue(parsed, "Harness registry");
  exactFields(registry, REGISTRY_FIELDS, "Harness registry");
  if (registry.version !== 1) throw new Error("Harness registry version must be exactly 1.");

  const model = objectValue(registry.model, "Harness registry model policy");
  exactFields(model, MODEL_FIELDS, "Harness registry model policy");
  if (model.provider !== "upstage" || model.model !== "solar-pro4" || model.thinking !== "max") {
    throw new Error("Harness registry model policy must be exactly upstage/solar-pro4 with max thinking.");
  }

  if (!Array.isArray(registry.agents)) throw new Error("Harness registry agents must be an array.");
  if (registry.agents.length !== HARNESS_ROLE_IDS.length) {
    throw new Error(`Harness registry must define exactly ${HARNESS_ROLE_IDS.length} agents and no model orchestrator.`);
  }

  const seen = new Set<HarnessRole>();
  const agents = registry.agents.map((candidate, index): AgentDefinition => {
    const agent = objectValue(candidate, `Harness registry agent[${index}]`);
    exactFields(agent, AGENT_FIELDS, `Harness registry agent[${index}]`);

    const rawId = textValue(agent.id, `Harness registry agent[${index}].id`);
    if (!isHarnessRole(rawId)) throw new Error(`Unknown harness role in registry: ${rawId}.`);
    if (seen.has(rawId)) throw new Error(`Duplicate harness role in registry: ${rawId}.`);
    seen.add(rawId);

    const skill = textValue(agent.skill, `Harness role ${rawId}.skill`);
    const expected = expectedSkillPath(rawId);
    if (skill !== expected) {
      throw new Error(`Harness role ${rawId}.skill must be the exact package-local path ${expected}; alternate or escaping paths are forbidden.`);
    }

    return {
      id: rawId,
      description: textValue(agent.description, `Harness role ${rawId}.description`),
      responsibilities: textList(agent.responsibilities, `Harness role ${rawId}.responsibilities`),
      boundaries: textList(agent.boundaries, `Harness role ${rawId}.boundaries`),
      input: textValue(agent.input, `Harness role ${rawId}.input`),
      output: textValue(agent.output, `Harness role ${rawId}.output`),
      tools: textValue(agent.tools, `Harness role ${rawId}.tools`),
      skill,
      collaboration: textValue(agent.collaboration, `Harness role ${rawId}.collaboration`),
      recall: textValue(agent.recall, `Harness role ${rawId}.recall`),
      errors: textValue(agent.errors, `Harness role ${rawId}.errors`),
    };
  });

  const missing = HARNESS_ROLE_IDS.filter(role => !seen.has(role));
  if (missing.length > 0) throw new Error(`Harness registry is missing required roles: ${missing.join(", ")}.`);

  return {
    version: 1,
    model: { provider: "upstage", model: "solar-pro4", thinking: "max" },
    agents,
  };
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function existingRealPath(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is missing or unreadable: ${message}`);
  }
}

function readBytes(path: string, label: string, maxBytes: number): Buffer {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is missing or unreadable: ${message}`);
  }
  if (size > maxBytes) throw new Error(`${label} exceeds its ${maxBytes}-byte limit.`);

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is missing or unreadable: ${message}`);
  }
  if (bytes.byteLength > maxBytes) throw new Error(`${label} exceeds its ${maxBytes}-byte limit.`);
  return bytes;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`${label} must contain valid UTF-8 text.`);
  }
}

function frontmatterString(raw: string, label: string): string {
  const value = raw.trim();
  if (value.startsWith("\"")) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string" || parsed.trim().length === 0) throw new Error();
      return parsed;
    } catch {
      throw new Error(`${label} must be a nonempty JSON double-quoted string or safe YAML plain text.`);
    }
  }

  if (
    value.length === 0
    || !/^\p{L}/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /:(?:[ \t]|$)/u.test(value)
    || /(?:^|[ \t])#/u.test(value)
    || /[\[\]{}]/u.test(value)
    || /^(?:null|true|false|yes|no|on|off|~|[-+]?(?:\.inf|\.nan))$/iu.test(value)
  ) {
    throw new Error(`${label} must be a nonempty JSON double-quoted string or safe YAML plain text without mapping, comment, collection, tag, anchor, or alias syntax.`);
  }
  return value;
}

function frontmatterField(lines: string[], field: "name" | "description", label: string): string {
  const prefix = `${field}:`;
  const matches = lines.filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim());
  if (matches.length !== 1) throw new Error(`${label} frontmatter must contain exactly one nonempty ${field}.`);
  return frontmatterString(matches[0], `${label} frontmatter ${field}`);
}

function parseSkillDocument(source: string, role: HarnessRole, label: string): { body: string } {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw new Error(`${label} must start with YAML frontmatter.`);
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing < 0) throw new Error(`${label} has unterminated YAML frontmatter.`);

  const frontmatter = lines.slice(1, closing);
  const name = frontmatterField(frontmatter, "name", label);
  const description = frontmatterField(frontmatter, "description", label);
  if (frontmatter.length !== 2 || frontmatter.some(line => !/^(?:name|description):/.test(line))) {
    throw new Error(`${label} frontmatter must contain only one-line name and description fields.`);
  }
  const expectedName = expectedSkillName(role);
  if (name !== expectedName) throw new Error(`${label} frontmatter name must be exactly ${expectedName}.`);
  if (description.trim().length === 0) throw new Error(`${label} frontmatter description must be nonempty.`);

  const body = lines.slice(closing + 1).join("\n").trim();
  if (body.length === 0) throw new Error(`${label} must contain a nonempty procedural body.`);
  return { body };
}

function loadRegistry(): { registry: HarnessRegistry; packageRoot: string; skillsRoot: string } {
  const packageRoot = existingRealPath(PACKAGE_ROOT, "Harness package root");
  const registryPath = existingRealPath(REGISTRY_PATH, "Harness registry");
  if (!isInside(packageRoot, registryPath)) throw new Error("Harness registry path escapes the package root.");

  const registryBytes = readBytes(registryPath, "Harness registry", HARNESS_REGISTRY_MAX_BYTES);
  const registry = parseHarnessRegistry(decodeUtf8(registryBytes, "Harness registry"));
  const skillsRoot = existingRealPath(SKILLS_ROOT, "Harness skills directory");
  if (!isInside(packageRoot, skillsRoot)) throw new Error("Harness skills directory escapes the package root.");
  return { registry, packageRoot, skillsRoot };
}

function loadSkill(definition: AgentDefinition, packageRoot: string, skillsRoot: string): LoadedSkill {
  const lexicalPath = resolve(PACKAGE_ROOT, ...definition.skill.split("/"));
  if (!isInside(SKILLS_ROOT, lexicalPath)) throw new Error(`Harness role ${definition.id} skill path escapes the package skills directory.`);

  const realPath = existingRealPath(lexicalPath, `Harness role ${definition.id} skill`);
  if (!isInside(packageRoot, realPath) || !isInside(skillsRoot, realPath)) {
    throw new Error(`Harness role ${definition.id} skill path escapes the package skills directory.`);
  }

  const bytes = readBytes(realPath, `Harness role ${definition.id} skill`, HARNESS_SKILL_MAX_BYTES);
  const source = decodeUtf8(bytes, `Harness role ${definition.id} skill`);
  parseSkillDocument(source, definition.id, `Harness role ${definition.id} skill`);
  return { source, bytes };
}

export function loadHarnessRole(role: HarnessRole): { definition: AgentDefinition; skill: string; revision: string } {
  if (!isHarnessRole(role)) throw new Error(`Unknown harness role: ${String(role)}.`);

  const { registry, packageRoot, skillsRoot } = loadRegistry();
  const loadedSkills = new Map<HarnessRole, LoadedSkill>();
  for (const definition of registry.agents) {
    loadedSkills.set(definition.id, loadSkill(definition, packageRoot, skillsRoot));
  }

  const definition = registry.agents.find(agent => agent.id === role);
  const loadedSkill = loadedSkills.get(role);
  if (!definition || !loadedSkill) throw new Error(`Harness role ${role} is not completely defined.`);

  const revision = createHash("sha256")
    .update(JSON.stringify(definition), "utf8")
    .update("\0", "utf8")
    .update(loadedSkill.bytes)
    .digest("hex");
  return { definition, skill: loadedSkill.source, revision };
}

function bullets(items: string[]): string {
  return items.map(item => `- ${item}`).join("\n");
}

export function renderHarnessRolePrompt(role: HarnessRole): string {
  const { definition, skill, revision } = loadHarnessRole(role);
  const { body } = parseSkillDocument(skill, role, `Harness role ${role} skill`);
  const prompt = [
    "# Package-defined Solar harness role",
    `You are the \`${definition.id}\` role. ${definition.description}`,
    `Role revision: ${revision}`,
    "Model policy: upstage/solar-pro4 with max thinking. The deterministic host owns routing, state, budgets, validation, persistence, and approval.",
    `## Responsibilities\n${bullets(definition.responsibilities)}`,
    `## Boundaries\n${bullets(definition.boundaries)}`,
    `## Input\n${definition.input}`,
    `## Output\n${definition.output}`,
    `## Tool policy\n${definition.tools}`,
    `## Cooperation and handoff\n${definition.collaboration}`,
    `## Recall and stale-state policy\n${definition.recall}`,
    `## Error handling\n${definition.errors}`,
    `## Procedural skill\n${body}`,
  ].join("\n\n");
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > HARNESS_PROMPT_MAX_BYTES) {
    throw new Error(`Harness role ${role} composed prompt exceeds its ${HARNESS_PROMPT_MAX_BYTES}-byte limit.`);
  }
  return prompt;
}
