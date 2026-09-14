import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  HARNESS_PROMPT_MAX_BYTES,
  HARNESS_REGISTRY_MAX_BYTES,
  HARNESS_SKILL_MAX_BYTES,
  loadHarnessRole,
  parseHarnessRegistry,
  renderHarnessRolePrompt,
} from "./harness.ts";

const ROLES = [
  "researcher",
  "interviewer",
  "planner",
  "approach_reviewer",
  "critic",
  "executor",
];
const MAIN_SESSION_ROLES = new Set(["researcher", "interviewer", "executor"]);
const REGISTRY_URL = new URL("../harness/agents.json", import.meta.url);
const HARNESS_SOURCE_URL = new URL("./harness.ts", import.meta.url);

function rawRegistry() {
  return JSON.parse(readFileSync(REGISTRY_URL, "utf8"));
}

function skillName(role) {
  return `solar-${role.replaceAll("_", "-")}-practice`;
}

function skillBody(source) {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  assert.notEqual(closing, -1);
  return lines.slice(closing + 1).join("\n").trim();
}

async function packageFixture(options = {}) {
  const base = realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(base, "solar-harness-unit-"));
  const runtime = path.join(root, "runtime");
  const harness = path.join(root, "harness");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(path.join(harness, "skills"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n', "utf8");
  writeFileSync(path.join(runtime, "harness.ts"), readFileSync(HARNESS_SOURCE_URL));

  const registry = rawRegistry();
  options.mutateRegistry?.(registry);
  if (!options.omitRegistry) writeFileSync(path.join(harness, "agents.json"), `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  for (const role of ROLES) {
    if (options.omitSkill === role) continue;
    const directory = path.join(harness, "skills", role);
    mkdirSync(directory, { recursive: true });
    const defaultSource = `---\nname: ${skillName(role)}\ndescription: Fixture procedure for ${role}.\n---\n\n# ${role}\n\nFollow the fixture procedure for ${role}.\n`;
    const source = options.skillSource?.(role, defaultSource) ?? defaultSource;
    writeFileSync(path.join(directory, "SKILL.md"), source, "utf8");
  }

  const imported = await import(pathToFileURL(path.join(runtime, "harness.ts")).href);
  return {
    root,
    imported,
    registryPath: path.join(harness, "agents.json"),
    skillPath(role) {
      return path.join(harness, "skills", role, "SKILL.md");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the package registry defines exactly the six explicit roles with the common Solar policy", () => {
  const registry = parseHarnessRegistry(readFileSync(REGISTRY_URL, "utf8"));
  assert.equal(registry.version, 1);
  assert.deepEqual(registry.model, { provider: "upstage", model: "solar-pro4", thinking: "max" });
  assert.deepEqual(registry.agents.map(agent => agent.id), ROLES);
  assert.equal(registry.agents.some(agent => /orchestrator/i.test(agent.id)), false);

  for (const definition of registry.agents) {
    assert.equal(definition.skill, `harness/skills/${definition.id}/SKILL.md`);
    assert.ok(definition.description.trim());
    assert.ok(definition.responsibilities.length > 0);
    assert.ok(definition.boundaries.length > 0);
    for (const field of ["input", "output", "tools", "collaboration", "recall", "errors"]) assert.ok(definition[field].trim(), `${definition.id}.${field}`);
  }
});

test("role loading is module-relative and the revision binds the definition and exact skill bytes", () => {
  const originalCwd = process.cwd();
  const otherCwd = mkdtempSync(path.join(realpathSync(os.tmpdir()), "solar-harness-cwd-"));
  process.chdir(otherCwd);
  try {
    for (const role of ROLES) {
      const loaded = loadHarnessRole(role);
      assert.equal(loaded.definition.id, role);
      assert.match(loaded.skill, new RegExp(`^---\\r?\\nname: ${skillName(role)}\\r?$`, "m"));
      assert.match(loaded.revision, /^[a-f0-9]{64}$/);

      const skillBytes = readFileSync(new URL(`../${loaded.definition.skill}`, import.meta.url));
      const expected = createHash("sha256")
        .update(JSON.stringify(loaded.definition), "utf8")
        .update("\0", "utf8")
        .update(skillBytes)
        .digest("hex");
      assert.equal(loaded.revision, expected);
    }
  } finally {
    process.chdir(originalCwd);
    rmSync(otherCwd, { recursive: true, force: true });
  }
});

test("rendered real prompts include role authority, I/O, cooperation, and the complete procedural body", () => {
  for (const role of ROLES) {
    const loaded = loadHarnessRole(role);
    const prompt = renderHarnessRolePrompt(role);
    assert.ok(prompt.includes(`You are the \`${role}\` role.`));
    assert.ok(prompt.includes(`Role revision: ${loaded.revision}`));
    assert.ok(prompt.includes(loaded.definition.responsibilities[0]));
    assert.ok(prompt.includes(loaded.definition.boundaries[0]));
    assert.ok(prompt.includes(`## Input\n${loaded.definition.input}`));
    assert.ok(prompt.includes(`## Output\n${loaded.definition.output}`));
    assert.ok(prompt.includes(`## Tool policy\n${loaded.definition.tools}`));
    assert.ok(prompt.includes(`## Cooperation and handoff\n${loaded.definition.collaboration}`));
    assert.ok(prompt.endsWith(skillBody(loaded.skill)));
    if (MAIN_SESSION_ROLES.has(role)) assert.match(prompt, /main session/i);
    else assert.match(prompt, /fresh in-memory .*session/i);
  }
});

test("registry parsing rejects malformed, incomplete, duplicate, escaping, and non-six-role definitions", () => {
  assert.throws(() => parseHarnessRegistry("{"), /not valid JSON/i);
  assert.throws(() => parseHarnessRegistry(""), /nonempty JSON/i);

  const cases = [
    {
      label: "version",
      mutate(registry) { registry.version = 2; },
      pattern: /version must be exactly 1/i,
    },
    {
      label: "model",
      mutate(registry) { registry.model.thinking = "high"; },
      pattern: /upstage\/solar-pro4 with max/i,
    },
    {
      label: "duplicate",
      mutate(registry) { registry.agents[5] = structuredClone(registry.agents[0]); },
      pattern: /duplicate harness role/i,
    },
    {
      label: "missing field",
      mutate(registry) { delete registry.agents[0].errors; },
      pattern: /missing errors/i,
    },
    {
      label: "empty list",
      mutate(registry) { registry.agents[0].responsibilities = []; },
      pattern: /nonempty string array/i,
    },
    {
      label: "path escape",
      mutate(registry) { registry.agents[0].skill = "../outside/SKILL.md"; },
      pattern: /package-local path|escaping paths/i,
    },
    {
      label: "unknown role",
      mutate(registry) { registry.agents[0].id = "router"; },
      pattern: /unknown harness role/i,
    },
    {
      label: "extra orchestrator",
      mutate(registry) { registry.agents.push({ ...structuredClone(registry.agents[0]), id: "orchestrator" }); },
      pattern: /exactly 6 agents and no model orchestrator/i,
    },
  ];

  for (const fixture of cases) {
    const registry = rawRegistry();
    fixture.mutate(registry);
    assert.throws(() => parseHarnessRegistry(JSON.stringify(registry)), fixture.pattern, fixture.label);
  }
});

test("runtime role input rejects IDs outside the explicit registry", () => {
  assert.throws(() => loadHarnessRole("orchestrator"), /unknown harness role/i);
  assert.throws(() => renderHarnessRolePrompt("approach-reviewer"), /unknown harness role/i);
});

test("package validation fails closed when the registry or any dedicated skill is missing", async () => {
  const noRegistry = await packageFixture({ omitRegistry: true });
  try {
    assert.throws(() => noRegistry.imported.loadHarnessRole("planner"), /registry is missing or unreadable/i);
  } finally {
    noRegistry.cleanup();
  }

  const noCritic = await packageFixture({ omitSkill: "critic" });
  try {
    assert.throws(() => noCritic.imported.loadHarnessRole("researcher"), /critic skill is missing or unreadable/i);
  } finally {
    noCritic.cleanup();
  }
});

test("skill validation requires the role-derived frontmatter name, description, and procedure", async () => {
  const cases = [
    {
      label: "underscore name",
      source(role, original) {
        return role === "approach_reviewer" ? original.replace("solar-approach-reviewer-practice", "solar-approach_reviewer-practice") : original;
      },
      pattern: /name must be exactly solar-approach-reviewer-practice/i,
    },
    {
      label: "empty description",
      source(role, original) {
        return role === "critic" ? original.replace("description: Fixture procedure for critic.", 'description: ""') : original;
      },
      pattern: /description.*nonempty/i,
    },
    {
      label: "multiline description",
      source(role, original) {
        return role === "planner" ? original.replace("description: Fixture procedure for planner.", "description: >\n  Fixture procedure for planner.") : original;
      },
      pattern: /description.*safe YAML plain text/i,
    },
    {
      label: "mapping separator in plain description",
      source(role, original) {
        return role === "researcher" ? original.replace("description: Fixture procedure for researcher.", "description: Research: focused sources") : original;
      },
      pattern: /description.*without mapping/i,
    },
    {
      label: "inline comment in plain description",
      source(role, original) {
        return role === "interviewer" ? original.replace("description: Fixture procedure for interviewer.", "description: Research sources # narrowed") : original;
      },
      pattern: /description.*without mapping, comment/i,
    },
    {
      label: "collection description",
      source(role, original) {
        return role === "critic" ? original.replace("description: Fixture procedure for critic.", "description: [Research, focused sources]") : original;
      },
      pattern: /description.*without mapping, comment, collection/i,
    },
    {
      label: "tagged description",
      source(role, original) {
        return role === "executor" ? original.replace("description: Fixture procedure for executor.", "description: !research focused sources") : original;
      },
      pattern: /description.*tag/i,
    },
    {
      label: "unsupported frontmatter syntax",
      source(role, original) {
        return role === "planner" ? original.replace("description: Fixture procedure for planner.", "description: Fixture procedure for planner.\noptions: [") : original;
      },
      pattern: /only one-line name and description fields/i,
    },
    {
      label: "empty procedure",
      source(role, original) {
        return role === "executor" ? original.slice(0, original.indexOf("# executor")) : original;
      },
      pattern: /nonempty procedural body/i,
    },
  ];

  for (const fixtureCase of cases) {
    const fixture = await packageFixture({ skillSource: fixtureCase.source });
    try {
      assert.throws(() => fixture.imported.loadHarnessRole("planner"), fixtureCase.pattern, fixtureCase.label);
    } finally {
      fixture.cleanup();
    }
  }

  const quoted = await packageFixture({
    skillSource(role, original) {
      return role === "researcher"
        ? original.replace("description: Fixture procedure for researcher.", 'description: "Research: focused sources # retained as text"')
        : original;
    },
  });
  try {
    assert.doesNotThrow(() => quoted.imported.loadHarnessRole("researcher"));
  } finally {
    quoted.cleanup();
  }
});

test("oversized registries, skills, and composed prompts fail before a prompt can be returned", async () => {
  assert.throws(
    () => parseHarnessRegistry(`{"padding":"${"x".repeat(HARNESS_REGISTRY_MAX_BYTES)}"}`),
    new RegExp(`${HARNESS_REGISTRY_MAX_BYTES}-byte limit`, "i"),
  );

  const oversizedRegistry = await packageFixture();
  try {
    writeFileSync(oversizedRegistry.registryPath, Buffer.alloc(HARNESS_REGISTRY_MAX_BYTES + 1, 0x20));
    assert.throws(
      () => oversizedRegistry.imported.renderHarnessRolePrompt("planner"),
      new RegExp(`${HARNESS_REGISTRY_MAX_BYTES}-byte limit`, "i"),
    );
  } finally {
    oversizedRegistry.cleanup();
  }

  const oversizedSkill = await packageFixture();
  try {
    const header = `---\nname: ${skillName("researcher")}\ndescription: Oversized fixture skill.\n---\n\n# Procedure\n\n`;
    writeFileSync(
      oversizedSkill.skillPath("researcher"),
      `${header}${"x".repeat(HARNESS_SKILL_MAX_BYTES)}`,
      "utf8",
    );
    assert.throws(
      () => oversizedSkill.imported.renderHarnessRolePrompt("researcher"),
      new RegExp(`${HARNESS_SKILL_MAX_BYTES}-byte limit`, "i"),
    );
  } finally {
    oversizedSkill.cleanup();
  }

  const oversizedPrompt = await packageFixture({
    mutateRegistry(registry) {
      registry.agents[0].description = "D".repeat(45 * 1024);
    },
    skillSource(role, original) {
      if (role !== "researcher") return original;
      return `---\nname: ${skillName(role)}\ndescription: Large but individually valid fixture skill.\n---\n\n# Procedure\n\n${"s".repeat(20 * 1024)}\n`;
    },
  });
  try {
    assert.ok(readFileSync(oversizedPrompt.registryPath).byteLength <= HARNESS_REGISTRY_MAX_BYTES);
    assert.ok(readFileSync(oversizedPrompt.skillPath("researcher")).byteLength <= HARNESS_SKILL_MAX_BYTES);
    assert.doesNotThrow(() => oversizedPrompt.imported.loadHarnessRole("researcher"));
    assert.throws(
      () => oversizedPrompt.imported.renderHarnessRolePrompt("researcher"),
      new RegExp(`${HARNESS_PROMPT_MAX_BYTES}-byte limit`, "i"),
    );
  } finally {
    oversizedPrompt.cleanup();
  }
});

test("role and skill edits are observed immediately without a prompt cache", async () => {
  const fixture = await packageFixture();
  try {
    const first = fixture.imported.loadHarnessRole("researcher");
    writeFileSync(fixture.skillPath("researcher"), `${first.skill.trimEnd()}\n\nUse newly edited fixture evidence.\n`, "utf8");
    const second = fixture.imported.loadHarnessRole("researcher");
    assert.notEqual(second.revision, first.revision);
    assert.match(second.skill, /newly edited fixture evidence/);

    const registry = JSON.parse(readFileSync(fixture.registryPath, "utf8"));
    registry.agents[0].description = "Newly edited fixture role definition.";
    writeFileSync(fixture.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    const third = fixture.imported.loadHarnessRole("researcher");
    assert.notEqual(third.revision, second.revision);
    const prompt = fixture.imported.renderHarnessRolePrompt("researcher");
    assert.match(prompt, /newly edited fixture role definition/i);
    assert.match(prompt, /newly edited fixture evidence/i);
  } finally {
    fixture.cleanup();
  }
});
