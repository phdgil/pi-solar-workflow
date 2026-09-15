export const EXECUTION_CONTRACT_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$";

export const PLANNER_SECTION_HEADINGS = Object.freeze([
  Object.freeze(["goalAndScope", "Goal and scope"] as const),
  Object.freeze(["stepsAndValidation", "Steps and validation"] as const),
  Object.freeze(["designReview", "Design review"] as const),
  Object.freeze(["riskReviewAndRevisions", "Risk review and revisions"] as const),
  Object.freeze(["acceptanceCriteria", "Acceptance criteria"] as const),
  Object.freeze(["remainingUncertainties", "Remaining uncertainties"] as const),
] as const);

export function countPlanSteps(section: string) {
  let fence: string | undefined;
  let count = 0;
  for (const line of section.split(/\r?\n/)) {
    const boundary = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (boundary) {
      if (!fence) fence = boundary;
      else if (boundary[0] === fence[0] && boundary.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const label = line.replace(/^ {0,3}#{1,6}\s+/, "").replace(/\*\*|__/g, "").trimEnd();
    if (/^ {0,3}(?:(?:Step\s+)?\d+(?:[.)]\s+|\s*[—–:-]\s+)|[-*+]\s+\[[ xX]\]\s+)\S/i.test(label)) count += 1;
  }
  return count;
}

function exactSchemaValues(values: readonly string[], label: string, allowEmpty: boolean) {
  if (!Array.isArray(values) || (!allowEmpty && !values.length)) throw new Error(`Supply ${label}${allowEmpty ? "" : " as a nonempty array"}.`);
  if (values.some(value => typeof value !== "string")) throw new Error(`${label} must contain only strings.`);
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates.`);
  return [...values];
}

export function buildPlannerResponseSchema(capabilityToolNames: readonly string[], findingIds: readonly string[]): Record<string, unknown> {
  const tools = exactSchemaValues(capabilityToolNames, "the current Planner capability tool names", false);
  const findings = exactSchemaValues(findingIds, "the current Planner finding IDs", true);
  const reference = (name: string) => ({ $ref: `#/$defs/${name}` });
  const identifierArray = (minimum = 0, maximum = 80) => ({
    type: "array",
    items: reference("identifier"),
    minItems: minimum,
    maxItems: maximum,
  });
  const textArray = (minimum = 0, maximum = 80) => ({
    type: "array",
    items: reference("text"),
    minItems: minimum,
    maxItems: maximum,
  });

  const resolutionFindingId = findings.length
    ? { type: "string", enum: findings, pattern: EXECUTION_CONTRACT_ID_PATTERN }
    : reference("identifier");

  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "sections", "contract", "resolutions"],
    properties: {
      status: { type: "string", enum: ["ready"] },
      sections: reference("sections"),
      contract: reference("executionContract"),
      resolutions: {
        type: "array",
        items: reference("resolution"),
        minItems: findings.length,
        maxItems: findings.length,
      },
    },
    $defs: {
      identifier: {
        type: "string",
        pattern: EXECUTION_CONTRACT_ID_PATTERN,
      },
      // Host validation rejects blank values; native substring patterns can collapse free-form output.
      text: {
        type: "string",
        minLength: 1,
        maxLength: 12_000,
      },
      path: {
        type: "string",
        minLength: 1,
        maxLength: 2_000,
      },
      sections: {
        type: "object",
        additionalProperties: false,
        required: PLANNER_SECTION_HEADINGS.map(([key]) => key),
        properties: {
          ...Object.fromEntries(PLANNER_SECTION_HEADINGS.map(([key]) => [key, reference("text")])),
          stepsAndValidation: {
            ...reference("text"),
            description: "Use one to 40 numbered step lines, starting with '1. ' even for a single producing step. Each line identifies its contract step, actions, output, and validation.",
          },
        },
      },
      requirement: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "source"],
        properties: {
          id: reference("identifier"),
          description: reference("text"),
          source: reference("text"),
        },
      },
      artifact: {
        type: "object",
        additionalProperties: false,
        required: ["id", "path", "kind", "acceptance", "gates"],
        properties: {
          id: reference("identifier"),
          path: reference("path"),
          kind: { type: "string", enum: ["final", "intermediate", "evidence"] },
          acceptance: { type: "string", enum: ["command", "human", "none"] },
          gates: { ...identifierArray(), description: "Exactly the gate IDs whose evidence includes this artifact, including immutable evidence inputs. Both directions must agree." },
        },
      },
      capability: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "tool", "paths", "commands"],
        properties: {
          id: reference("identifier"),
          kind: { type: "string", enum: ["read", "write", "command"] },
          tool: {
            type: "string",
            enum: tools,
            pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,99}$",
            maxLength: 100,
          },
          paths: {
            type: "array",
            items: reference("path"),
            minItems: 0,
            maxItems: 80,
          },
          commands: textArray(0, 20),
        },
      },
      step: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "feasibility", "inputs", "outputs", "actions", "dependsOn", "requires", "gates", "capabilities"],
        properties: {
          id: reference("identifier"),
          title: reference("text"),
          feasibility: reference("text"),
          inputs: { ...identifierArray(), description: "Existing artifacts[].id values consumed by this step, not paths or requirement IDs." },
          outputs: { ...identifierArray(1), description: "artifacts[].id values genuinely produced by this step, not immutable input evidence." },
          actions: textArray(1),
          dependsOn: { ...identifierArray(), description: "Earlier steps[].id values, not artifact IDs." },
          requires: { ...identifierArray(1), description: "requirements[].id values fulfilled by this step, never artifact IDs or prerequisite paths." },
          gates: { ...identifierArray(1), description: "gates[].id values used to validate this producing step." },
          capabilities: { ...identifierArray(1), description: "capabilities[].id values used by this step, not tool names." },
        },
      },
      gate: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "check", "pass", "evidence"],
        properties: {
          id: reference("identifier"),
          kind: { type: "string", enum: ["command", "rubric"] },
          check: { ...reference("text"), description: "For a command gate, only the complete exact authorized command, with no appended assertions or explanatory prose. For a rubric gate, the qualitative check." },
          pass: { ...reference("text"), description: "The observable passing condition; keep result assertions here, not appended to a command gate's check." },
          evidence: identifierArray(1),
        },
      },
      requirementCoverage: {
        type: "object",
        additionalProperties: false,
        required: ["requirementId", "stepIds", "gateIds", "explanation"],
        properties: {
          requirementId: reference("identifier"),
          stepIds: identifierArray(1),
          gateIds: identifierArray(1),
          explanation: reference("text"),
        },
      },
      artifactCoverage: {
        type: "object",
        additionalProperties: false,
        required: ["artifactId", "stepId", "gateIds", "explanation"],
        properties: {
          artifactId: reference("identifier"),
          stepId: reference("identifier"),
          gateIds: identifierArray(1),
          explanation: reference("text"),
        },
      },
      selfCheck: {
        type: "object",
        additionalProperties: false,
        required: ["review", "requirementCoverage", "artifactCoverage", "unresolved"],
        properties: {
          review: { ...reference("text"), description: "Substantive analysis of scope, ordering, feasibility, risk, and acceptance; not a reviewer name or confidence label." },
          requirementCoverage: {
            type: "array",
            items: reference("requirementCoverage"),
            minItems: 1,
            maxItems: 80,
          },
          artifactCoverage: {
            description: "Exactly one entry per produced artifact, and no entries for immutable input evidence. Each entry names its actual producer and exact descriptor gates.",
            type: "array",
            items: reference("artifactCoverage"),
            minItems: 1,
            maxItems: 80,
          },
          unresolved: {
            type: "array",
            items: reference("text"),
            minItems: 0,
            maxItems: 0,
          },
        },
      },
      executionContract: {
        type: "object",
        additionalProperties: false,
        required: ["version", "domain", "requirements", "artifacts", "capabilities", "steps", "gates", "selfCheck"],
        properties: {
          version: { type: "integer", enum: [3] },
          domain: { type: "string", enum: ["software", "research"] },
          requirements: {
            type: "array",
            items: reference("requirement"),
            minItems: 1,
            maxItems: 80,
          },
          artifacts: {
            type: "array",
            items: reference("artifact"),
            minItems: 1,
            maxItems: 80,
          },
          capabilities: {
            type: "array",
            items: reference("capability"),
            minItems: 1,
            maxItems: 80,
          },
          steps: {
            type: "array",
            items: reference("step"),
            minItems: 1,
            maxItems: 40,
          },
          gates: {
            type: "array",
            items: reference("gate"),
            minItems: 1,
            maxItems: 80,
          },
          selfCheck: reference("selfCheck"),
        },
      },
      resolution: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "status", "changedLocations", "explanation"],
        properties: {
          findingId: resolutionFindingId,
          status: { type: "string", enum: ["resolved", "blocked"] },
          changedLocations: textArray(),
          explanation: {
            type: "string",
            minLength: 1,
            maxLength: 4_000,
          },
        },
      },
    },
  };
}
