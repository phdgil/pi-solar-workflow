import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const skills = ["solar-research", "solar-interview", "solar-plan", "solar-execute"];

test("only the four reviewed skills are discoverable", () => {
  const loaded = readdirSync(path.join(root, "skills"))
    .filter(name => existsSync(path.join(root, "skills", name, "SKILL.md")));
  assert.deepEqual(loaded.sort(), [...skills].sort());
});

test("relative runtime imports are explicitly shipped", () => {
  const shipped = new Set([...manifest.files, "package.json"]);
  for (const filename of manifest.files.filter(name => name.startsWith("runtime/") && name.endsWith(".ts"))) {
    assert.ok(existsSync(path.join(root, filename)), `${filename} is missing`);
    const source = readFileSync(path.join(root, filename), "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\()(["'])(\.[^"']+)\1/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(filename), match[2]));
      assert.ok(shipped.has(dependency), `${filename} imports unshipped ${dependency}`);
    }
  }
});

test("all private role definitions and skills are shipped but not publicly discovered", () => {
  const filename = "harness/agents.json";
  assert.ok(manifest.files.includes(filename));
  const registry = JSON.parse(readFileSync(path.join(root, filename), "utf8"));
  assert.equal(registry.agents.length, 6);
  for (const agent of registry.agents) {
    assert.ok(manifest.files.includes(agent.skill), `Unshipped dedicated skill: ${agent.skill}`);
    assert.ok(existsSync(path.join(root, agent.skill)), `Missing dedicated skill: ${agent.skill}`);
    assert.ok(!agent.skill.startsWith("skills/"), "Internal skills must not compete with public stage dispatch");
  }
  assert.ok(manifest.files.includes("runtime/harness.ts"));
});

test("release manifest loads four skills and exactly the shipped runtime", () => {
  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.name, "pi-solar-workflow");
  assert.ok(!manifest.files.some(entry => entry.includes("skills/lite-")));
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.pi, { extensions: ["./runtime/extension.ts"], skills: ["./skills"] });
  for (const name of skills) {
    const text = readFileSync(path.join(root, "skills", name, "SKILL.md"), "utf8");
    assert.ok(text.startsWith(`---\nname: ${name}\n`));
    assert.match(text, /description: /);
    const description = /^description: (.+)$/m.exec(text)?.[1];
    assert.equal(typeof JSON.parse(description), "string", "Quote descriptions as JSON-compatible YAML scalars so embedded colons cannot disable skill discovery");
  }
  assert.ok(existsSync(path.join(root, manifest.pi.extensions[0])));
});

test("host peers are not bundled and no install lifecycle runs", () => {
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.bundledDependencies, undefined);
  for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(manifest.peerDependencies[name], "*");
    assert.equal(manifest.peerDependenciesMeta[name].optional, true);
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(manifest.scripts[hook], undefined);
  assert.ok(!manifest.files.some(entry => /upstream|controller|runs|\.pi|live_test|auth/i.test(entry)));
  assert.ok(manifest.files.every(entry => !entry.endsWith("/") && !entry.includes("*")), "Publication requires exact files, not recursive directory globs");
});

test("the shared Solar example contains no credential and preserves max mapping", () => {
  const example = JSON.parse(readFileSync(path.join(root, "examples/models.upstage.json"), "utf8"));
  const provider = example.providers.upstage;
  assert.equal(provider.apiKey, undefined);
  assert.equal(provider.baseUrl, "https://api.upstage.ai/v1");
  assert.equal(provider.compat.supportsReasoningEffort, true);
  assert.equal(provider.models[0].id, "solar-pro4");
  assert.equal(provider.models[0].thinkingLevelMap.max, "max");
});

test("public documentation links resolve and does not include local private paths", () => {
  for (const name of ["README.md", "THIRD_PARTY_NOTICES.md", "docs/INSTALL.md", "docs/WORKFLOW.md", "docs/REFERENCES.md", "docs/VALIDATION.md"]) {
    const filename = path.join(root, name);
    const text = readFileSync(filename, "utf8");
    assert.doesNotMatch(text, /C:\\Users\\user\\|OneDrive -|\.jsonl/);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const destination = match[1].split("#")[0];
      if (!destination || /^[a-z]+:/i.test(destination)) continue;
      assert.ok(existsSync(path.resolve(path.dirname(filename), destination)), `${name}: broken link ${destination}`);
    }
  }
});
