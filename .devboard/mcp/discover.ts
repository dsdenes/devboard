import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveWithin, type McpContext } from "./context";

/**
 * Discover staging writes. Each tool addresses the run's directory under
 * `<REPO>/.omp/discover/staging/` and writes exactly the staged artifact the
 * server's publication already reads: the project sheet, one glossary, the
 * significance sidecar, or one Discover skill. Publication decides what the
 * staged bytes mean and reports a malformed document as that agent's error.
 */

export const DISCOVER_SKILL_NAMES = [
  "discover-architecture-boundaries",
  "discover-coding-conventions",
  "discover-glossary",
  "discover-naming-conventions",
  "discover-testing-strategy",
] as const;

const SKILL_NAMES = new Set<string>(DISCOVER_SKILL_NAMES);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function stagingRoot(context: McpContext): string {
  const root = join(context.repoDir, ".omp", "discover", "staging");
  mkdirSync(root, { recursive: true });
  return root;
}

function stagingDirectory(context: McpContext, value: unknown): string {
  return resolveWithin(stagingRoot(context), value, "stagingDir", { mustExist: true }).absolute;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Stages the complete project sheet as `sheet.json`. */
export function stageDiscoverSheet(
  context: McpContext,
  options: { stagingDir?: unknown; sheet?: unknown },
) {
  const directory = stagingDirectory(context, options.stagingDir);
  const sheet = record(options.sheet, "sheet");
  const path = join(directory, "sheet.json");
  writeJson(path, sheet);
  const schemaVersion = sheet.schemaVersion;
  return {
    path,
    schemaVersion: typeof schemaVersion === "number" ? schemaVersion : null,
  };
}

/** Stages one bounded context's UbiLang glossary as its YAML document. */
export function stageDiscoverGlossary(
  context: McpContext,
  options: { stagingDir?: unknown; context?: unknown; yaml?: unknown },
) {
  const directory = stagingDirectory(context, options.stagingDir);
  const boundedContext = options.context;
  if (typeof boundedContext !== "string" || !KEBAB.test(boundedContext)) {
    throw new Error("context must be a kebab-case bounded-context id.");
  }
  if (typeof options.yaml !== "string" || options.yaml.trim().length === 0) {
    throw new Error("yaml must be the non-empty glossary document text.");
  }
  const path = join(directory, "glossary", `${boundedContext}.glossary.yaml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, options.yaml.endsWith("\n") ? options.yaml : `${options.yaml}\n`);
  return { path, context: boundedContext };
}

/** Stages the significance sidecar beside the glossaries. */
export function stageDiscoverSignificance(
  context: McpContext,
  options: { stagingDir?: unknown; significance?: unknown },
) {
  const directory = stagingDirectory(context, options.stagingDir);
  const significance = record(options.significance, "significance");
  const path = join(directory, "glossary", "significance.json");
  writeJson(path, significance);
  const schemaVersion = significance.schemaVersion;
  return {
    path,
    schemaVersion: typeof schemaVersion === "number" ? schemaVersion : null,
  };
}

/**
 * Stages one Discover skill. The tool writes the frontmatter markers the
 * publication requires, so a skill file is always a managed Discover skill;
 * the body it receives is the heading plus imperative bullets.
 */
export function stageDiscoverSkill(
  context: McpContext,
  options: {
    stagingDir?: unknown;
    name?: unknown;
    description?: unknown;
    body?: unknown;
  },
) {
  const directory = stagingDirectory(context, options.stagingDir);
  const name = options.name;
  if (typeof name !== "string" || !SKILL_NAMES.has(name)) {
    throw new Error(`name must be one of ${DISCOVER_SKILL_NAMES.join(", ")}.`);
  }
  if (typeof options.description !== "string" || options.description.trim().length === 0) {
    throw new Error("description must be a non-empty one-line sentence.");
  }
  if (/[\r\n]/.test(options.description)) {
    throw new Error("description must be one line.");
  }
  if (Buffer.byteLength(options.description, "utf8") > 1024) {
    throw new Error("description must be at most 1024 bytes.");
  }
  if (typeof options.body !== "string" || !/^\s*#\s+\S/.test(options.body)) {
    throw new Error("body must start with a level-one heading.");
  }
  const body = options.body.trimEnd();
  const skill = name.slice("discover-".length);
  const text = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(options.description.trim())}`,
    "metadata:",
    '  devboard-managed: "true"',
    '  devboard-family: "discover"',
    `  devboard-skill: ${JSON.stringify(skill)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
  const path = join(directory, "skills", name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, name };
}
