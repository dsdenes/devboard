import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Discover Mode's artifact contract: the project sheet, the UbiLang glossaries,
 * the five project-local skills, the host fingerprint, canonical ordering, the
 * structural digest, staged validation, and atomic publication.
 *
 * Everything this module writes lives under `<host>/.omp/discover/` or in a live
 * skill under `<host>/.omp/skills/`. It never writes `GOAL.md`, `adrs/`, host
 * source, or anything outside those two directories.
 */

export const DISCOVER_SCHEMA_VERSION = 1;

export const DISCOVER_SKILLS = [
  "discover-testing-strategy",
  "discover-naming-conventions",
  "discover-coding-conventions",
  "discover-architecture-boundaries",
  "discover-glossary",
] as const;

export type DiscoverSkillName = (typeof DISCOVER_SKILLS)[number];

const DISCOVER_SKILLS_BY_NAME: Record<string, true> = Object.fromEntries(
  DISCOVER_SKILLS.map((name) => [name, true] as const),
);

function isDiscoverSkill(name: string): name is DiscoverSkillName {
  return Object.hasOwn(DISCOVER_SKILLS_BY_NAME, name);
}

export const DISCOVER_SHEET_SECTIONS = [
  "definition",
  "stack",
  "deployment",
  "environments",
  "commands",
  "branching",
  "testing",
  "architecture",
  "ci",
  "runtime",
  "dependencyMap",
  "delivery",
] as const;

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
const CONCEPT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTEXT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CELL_MAX = 160;
const DEFINITION_MAX = 240;
const UNKNOWN_REASON_MAX = 200;
const EVIDENCE_MAX = 32;
const LIST_MAX = 64;

const MANAGED_MARKER = "devboard-managed";
const FAMILY_MARKER = "devboard-family";
const SKILL_MARKER = "devboard-skill";
const DISCOVER_FAMILY = "discover";

const DEPLOYMENT_CLASSES = [
  "package",
  "container",
  "static-site",
  "service",
  "cli",
  "library",
  "plugin",
  "none",
] as const;
const BRANCH_MODELS = ["direct", "pull-request", "git-flow"] as const;
const TEST_LEVELS = ["unit", "integration", "end-to-end", "contract", "other"] as const;
const CONFIDENCES = ["observed", "declared", "inferred", "unknown"] as const;
const CONCEPT_STATUSES = [
  "confirmed",
  "unconfirmed",
  "proposed",
  "deprecated",
  "invalidated",
] as const;
const CONCEPT_ORIGINS = ["owner", "standard", "llm"] as const;
const CONCEPT_KINDS = ["entity", "event", "field", "role", "actor", "value", "rule"] as const;
const LANGUAGES = ["de", "en"] as const;

/** Relative roots the crawl and the fingerprint never read. */
const EXCLUDED_ROOTS = [".devboard", ".worktree", ".omp/discover", ".omp/skills", ".git"];

/** A crawl writes only files below its staging directory; these are the only allowed paths. */
const STAGED_SHEET = "sheet.json";
const STAGED_GLOSSARY_DIR = "glossary";
const STAGED_SKILL_DIR = "skills";

/** Secret shapes that must never reach an artifact. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /:\/\/[^\s/@:]+:[^\s/@:]+@/,
];

const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

export class DiscoverValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoverValidationError";
  }
}

function invalid(path: string, rule: string): never {
  throw new DiscoverValidationError(`${path}: ${rule}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleLine(value: string): boolean {
  return !value.includes("\n") && !value.includes("\r");
}

function hasSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

// ------------------------------------------------------------------ paths

export function discoverRoot(repoDir: string): string {
  return join(repoDir, ".omp", "discover");
}

export function stagingRoot(repoDir: string): string {
  return join(discoverRoot(repoDir), "staging");
}

export function stagingDirectory(repoDir: string, runId: string): string {
  return join(stagingRoot(repoDir), runId);
}

export function liveSkillsRoot(repoDir: string): string {
  return join(repoDir, ".omp", "skills");
}

export function baselinePath(repoDir: string, name: string): string {
  return join(discoverRoot(repoDir), "skills", name, "SKILL.md");
}

export function liveSkillPath(repoDir: string, name: string): string {
  return join(liveSkillsRoot(repoDir), name, "SKILL.md");
}

export function glossaryPath(repoDir: string, context: string): string {
  return join(discoverRoot(repoDir), "glossary", `${context}.glossary.yaml`);
}

/** Host-relative artifact path, always spelled with forward slashes. */
export function artifactRelative(repoDir: string, path: string): string {
  return relative(repoDir, path).split(sep).join("/");
}

export function removeStaging(repoDir: string, runId: string): void {
  rmSync(stagingDirectory(repoDir, runId), { recursive: true, force: true });
  // Staging exists only while a run is active, so an empty staging root goes too.
  try {
    rmSync(stagingRoot(repoDir), { recursive: true, force: true });
  } catch {
    // A concurrent run may have created its own staging directory.
  }
}

// ------------------------------------------------------------ host facts

export interface HostFacts {
  fingerprint: string;
  commit: string;
  dirty: boolean;
}

function gitOutput(repoDir: string, args: string[]): string | undefined {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", repoDir, "-c", "core.quotepath=false", ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", NO_COLOR: "1" },
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString();
  } catch {
    return undefined;
  }
}

function excluded(relativePath: string): boolean {
  return EXCLUDED_ROOTS.some(
    (root) => relativePath === root || relativePath.startsWith(`${root}/`),
  );
}

/** Every file the fingerprint covers: tracked and untracked, never ignored. */
function hostFiles(repoDir: string): string[] {
  const listed = gitOutput(repoDir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (listed !== undefined) {
    return listed
      .split("\u0000")
      .filter((entry) => entry.length > 0 && !excluded(entry) && !ABSOLUTE_PATH_PATTERN.test(entry))
      .sort();
  }
  // A host without git still has a fingerprint: walk the tree, skipping the
  // directories the crawl would not read.
  const files: string[] = [];
  const walk = (directory: string) => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry);
      const relativePath = relative(repoDir, absolute).split(sep).join("/");
      if (excluded(relativePath)) continue;
      if (entry === "node_modules" || entry === ".git") continue;
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(absolute);
      else if (stats.isFile()) files.push(relativePath);
    }
  };
  walk(repoDir);
  return files.sort();
}

function contentHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The host fingerprint: `HEAD`, plus the content of every tracked and untracked
 * non-ignored file outside the excluded directories. Two runs on an unchanged
 * host produce one fingerprint.
 */
export function hostFacts(repoDir: string): HostFacts {
  const digest = createHash("sha256");
  for (const path of hostFiles(repoDir)) {
    digest.update(path);
    digest.update("\u0000");
    try {
      digest.update(contentHash(readFileSync(join(repoDir, path))));
    } catch {
      digest.update("unreadable");
    }
    digest.update("\u0000");
  }
  const commit = (gitOutput(repoDir, ["rev-parse", "--short=7", "HEAD"]) ?? "").trim();
  const status = gitOutput(repoDir, ["status", "--porcelain", "--untracked-files=all"]);
  return {
    fingerprint: digest.digest("hex"),
    commit,
    dirty: status === undefined ? false : dirtyLines(status).length > 0,
  };
}

/**
 * A change outside the excluded directories. The crawl's own staging and the
 * published harness artifacts are not host dirt.
 */
function dirtyLines(status: string): string[] {
  const lines: string[] = [];
  for (const line of status.split("\n")) {
    if (line.trim().length === 0) continue;
    let path = line.slice(3);
    const rename = path.indexOf(" -> ");
    if (rename >= 0) path = path.slice(rename + 4);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (excluded(path)) continue;
    lines.push(line);
  }
  return lines;
}

// -------------------------------------------------------------- strings

function textValue(value: unknown, path: string, max = CELL_MAX): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  const text = value.trim();
  if (text.length === 0) invalid(path, "must not be empty");
  if (!singleLine(text)) invalid(path, "must be a single line");
  if (text.length > max) invalid(path, `must be at most ${max} characters`);
  if (ABSOLUTE_PATH_PATTERN.test(text)) invalid(path, "must not be an absolute path");
  if (text.split("/").some((segment) => segment === "home" || segment === "Users")) {
    invalid(path, "must not carry an absolute host path");
  }
  if (/[A-Za-z]:\\/.test(text)) invalid(path, "must not carry an absolute host path");
  if (hasSecret(text)) invalid(path, "must not carry a secret value");
  return text;
}

function evidenceList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, "must be a list of strings");
  const entries = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const text = textValue(entry, `${path}[${index}]`);
    if (text.includes("://")) invalid(`${path}[${index}]`, "must not be a URL");
    if (text.split("/").includes("..")) invalid(`${path}[${index}]`, "must stay inside the host");
    entries.add(text);
  }
  return [...entries].sort();
}

function oneSentence(value: unknown, path: string): string {
  const text = textValue(value, path, DEFINITION_MAX);
  const terminators = text.match(/[.!?](?=\s|$)/g) ?? [];
  if (terminators.length !== 1 || !/[.!?]$/.test(text)) {
    invalid(path, "must be exactly one sentence");
  }
  return text;
}

interface Leaf {
  value: unknown;
  evidence: string[];
  confidence: (typeof CONFIDENCES)[number];
  reason?: string;
}

function leafBase(node: unknown, path: string): { confidence: Leaf["confidence"]; reason?: string; evidence: string[] } {
  if (!isRecord(node)) invalid(path, "must be a leaf object");
  const declared = node.confidence;
  if (typeof declared !== "string" || !(CONFIDENCES as readonly string[]).includes(declared)) {
    invalid(`${path}.confidence`, "must be observed, declared, inferred, or unknown");
  }
  const confidence = declared as Leaf["confidence"];
  if (confidence === "unknown") {
    if (node.value !== null) invalid(`${path}.value`, "must be null when confidence is unknown");
    if (!Array.isArray(node.evidence) || node.evidence.length !== 0) {
      invalid(`${path}.evidence`, "must be empty when confidence is unknown");
    }
    const declaredReason = node.reason;
    if (typeof declaredReason !== "string") {
      invalid(`${path}.reason`, "must name why the value is unknown");
    }
    const reason = declaredReason.trim();
    if (reason.length === 0) invalid(`${path}.reason`, "must name why the value is unknown");
    if (!singleLine(reason) || reason.length > UNKNOWN_REASON_MAX) {
      invalid(`${path}.reason`, `must be one line of at most ${UNKNOWN_REASON_MAX} characters`);
    }
    if (hasSecret(reason)) invalid(`${path}.reason`, "must not carry a secret value");
    return { confidence: "unknown", reason, evidence: [] };
  }
  if (node.reason !== undefined) invalid(`${path}.reason`, "is only allowed when confidence is unknown");
  const evidence = evidenceList(node.evidence, `${path}.evidence`);
  if (evidence.length === 0) invalid(`${path}.evidence`, "must ground a non-unknown value");
  if (evidence.length > EVIDENCE_MAX) invalid(`${path}.evidence`, "has too many entries");
  return { confidence, evidence };
}

function leafText(node: unknown, path: string, options: { sentence?: boolean } = {}): Leaf {
  const base = leafBase(node, path);
  if (base.confidence === "unknown") return { value: null, ...base };
  const record = node as Record<string, unknown>;
  const value = options.sentence === true
    ? oneSentence(record.value, `${path}.value`)
    : textValue(record.value, `${path}.value`);
  return { value, ...base };
}

function leafTexts(node: unknown, path: string): Leaf {
  const base = leafBase(node, path);
  if (base.confidence === "unknown") return { value: null, ...base };
  const record = node as Record<string, unknown>;
  if (!Array.isArray(record.value)) invalid(`${path}.value`, "must be a list of strings");
  if (record.value.length > LIST_MAX) invalid(`${path}.value`, "has too many entries");
  const values = [
    ...new Set(record.value.map((entry, index) => textValue(entry, `${path}.value[${index}]`))),
  ].sort();
  return { value: values, ...base };
}

function leafEnum<T extends string>(node: unknown, path: string, values: readonly T[]): Leaf {
  const base = leafBase(node, path);
  if (base.confidence === "unknown") return { value: null, ...base };
  const record = node as Record<string, unknown>;
  const value = record.value;
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    invalid(`${path}.value`, `must be one of ${values.join(", ")}`);
  }
  return { value: value as T, ...base };
}

function leafRecords<T>(
  node: unknown,
  path: string,
  validate: (entry: unknown, entryPath: string) => T,
  identity: (entry: T) => string,
): Leaf {
  const base = leafBase(node, path);
  if (base.confidence === "unknown") return { value: null, ...base };
  const record = node as Record<string, unknown>;
  if (!Array.isArray(record.value)) invalid(`${path}.value`, "must be a list");
  if (record.value.length > LIST_MAX) invalid(`${path}.value`, "has too many entries");
  const entries = record.value.map((entry, index) => validate(entry, `${path}.value[${index}]`));
  entries.sort((left, right) => identity(left).localeCompare(identity(right)));
  return { value: entries, ...base };
}

function recordFields(
  entry: unknown,
  path: string,
  required: Record<string, (value: unknown, fieldPath: string) => unknown>,
): Record<string, unknown> {
  if (!isRecord(entry)) invalid(path, "must be an object");
  const known = new Set(Object.keys(required));
  for (const key of Object.keys(entry)) {
    if (!known.has(key)) invalid(`${path}.${key}`, "is not a declared field");
  }
  const result: Record<string, unknown> = {};
  for (const [key, validate] of Object.entries(required)) {
    const value = entry[key];
    if (value === undefined) invalid(`${path}.${key}`, "is required");
    result[key] = validate(value, `${path}.${key}`);
  }
  return result;
}

function recordTexts(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, "must be a list of strings");
  if (value.length > LIST_MAX) invalid(path, "has too many entries");
  return [...new Set(value.map((entry, index) => textValue(entry, `${path}[${index}]`)))].sort();
}

// ---------------------------------------------------------------- sheet

export interface Freshness {
  project: string;
  commit: string;
  dirty: boolean;
  discoveredAt: string;
  fingerprint: string;
}

export interface Sheet {
  schemaVersion: number;
  freshness: Freshness;
  [section: string]: unknown;
}

function sheetSection(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const value = raw[key];
  if (!isRecord(value)) invalid(path, "must be an object");
  return value;
}

function validateSectionRecord(
  raw: Record<string, unknown>,
  key: string,
  fields: Record<string, (node: unknown, path: string) => Leaf>,
): Record<string, Leaf> {
  const section = sheetSection(raw, key, key);
  const known = new Set(Object.keys(fields));
  for (const field of Object.keys(section)) {
    if (!known.has(field)) invalid(`${key}.${field}`, "is not a declared field");
  }
  const result: Record<string, Leaf> = {};
  for (const [field, validate] of Object.entries(fields)) {
    if (section[field] === undefined) invalid(`${key}.${field}`, "is required");
    result[field] = validate(section[field], `${key}.${field}`);
  }
  return result;
}

function commandLeaf(entry: unknown, path: string): Leaf {
  return leafText(entry, path);
}

const COMMAND_NAMES = [
  "install",
  "build",
  "test",
  "lint",
  "typecheck",
  "dev",
  "tryOut",
  "release",
] as const;

/**
 * Canonicalizes the staged sheet into the published shape. Freshness is
 * injected by the server: the crawl cannot know the fingerprint it is
 * publishing against, and the published sheet is the only place it appears.
 */
export function normalizeSheet(raw: unknown, freshness: Freshness): Sheet {
  if (!isRecord(raw)) invalid("sheet", "must be an object");
  const known = new Set([
    "schemaVersion",
    ...DISCOVER_SHEET_SECTIONS,
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) invalid(key, "is not a declared field");
  }
  if (raw.schemaVersion !== DISCOVER_SCHEMA_VERSION) {
    invalid("schemaVersion", `must be ${DISCOVER_SCHEMA_VERSION}`);
  }
  for (const section of DISCOVER_SHEET_SECTIONS) {
    if (raw[section] === undefined) invalid(section, "is required");
  }

  const sheet: Sheet = {
    schemaVersion: DISCOVER_SCHEMA_VERSION,
    freshness: {
      project: freshness.project,
      commit: freshness.commit,
      dirty: freshness.dirty,
      discoveredAt: freshness.discoveredAt,
      fingerprint: freshness.fingerprint,
    },
    definition: leafText(raw.definition, "definition", { sentence: true }),
    stack: leafTexts(raw.stack, "stack"),
    deployment: validateSectionRecord(raw, "deployment", {
      class: (node, path) => leafEnum(node, path, DEPLOYMENT_CLASSES),
      artifact: leafText,
      target: leafText,
      pipelineSources: leafTexts,
    }),
    environments: leafRecords(
      raw.environments,
      "environments",
      (entry, path) =>
        recordFields(entry, path, {
          name: textValue,
          purpose: textValue,
        }),
      (entry) => String((entry as { name: string }).name),
    ),
    commands: validateSectionRecord(raw, "commands", Object.fromEntries(
      COMMAND_NAMES.map((name) => [name, commandLeaf] as const),
    )),
    branching: validateSectionRecord(raw, "branching", {
      defaultBranch: leafText,
      mergeMethod: leafText,
      releaseBranches: leafTexts,
      model: (node, path) => leafEnum(node, path, BRANCH_MODELS),
    }),
    testing: validateSectionRecord(raw, "testing", {
      levels: (node, path) =>
        leafRecords(
          node,
          path,
          (entry, entryPath) =>
            recordFields(entry, entryPath, {
              level: (value, fieldPath) => {
                if (typeof value !== "string" || !(TEST_LEVELS as readonly string[]).includes(value)) {
                  invalid(fieldPath, `must be one of ${TEST_LEVELS.join(", ")}`);
                }
                return value;
              },
              tests: textValue,
              paths: recordTexts,
              command: textValue,
              fixtures: recordTexts,
            }),
          (entry) => String((entry as { level: string }).level),
        ),
      pyramid: leafText,
    }),
    architecture: validateSectionRecord(raw, "architecture", {
      contexts: (node, path) =>
        leafRecords(
          node,
          path,
          (entry, entryPath) =>
            recordFields(entry, entryPath, {
              name: textValue,
              path: textValue,
              responsibility: textValue,
              entryPoints: recordTexts,
            }),
          (entry) => String((entry as { name: string }).name),
        ),
      dependencyDirection: leafText,
      externalBoundaries: leafTexts,
      sharedKernels: leafTexts,
    }),
    ci: validateSectionRecord(raw, "ci", {
      provider: leafText,
      triggers: leafTexts,
      jobs: leafTexts,
      qualityGates: leafTexts,
      artifacts: leafTexts,
    }),
    runtime: validateSectionRecord(raw, "runtime", {
      languages: leafTexts,
      runtimes: leafTexts,
      packageManagers: leafTexts,
      versions: leafTexts,
      manifests: leafTexts,
    }),
    dependencyMap: validateSectionRecord(raw, "dependencyMap", {
      binaries: leafTexts,
      packages: leafTexts,
      routes: leafTexts,
      jobs: leafTexts,
      externalServices: leafTexts,
      dataStores: leafTexts,
      keyDependencies: leafTexts,
    }),
    delivery: validateSectionRecord(raw, "delivery", {
      artifactTarget: leafText,
      releaseChannels: leafTexts,
      versionScheme: leafText,
      migrationPolicy: leafText,
    }),
  };
  return sheet;
}

function canonicalLeaf(leaf: Leaf, prose: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {
    value: prose && leaf.value !== null ? "" : leaf.value,
    evidence: leaf.evidence,
    confidence: leaf.confidence,
  };
  if (leaf.confidence === "unknown") result.reason = "";
  return result;
}

function canonicalSectionValue(value: unknown, proseKeys: Set<string>, key: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      isRecord(entry)
        ? Object.fromEntries(
            Object.entries(entry).map(([field, fieldValue]) => [
              field,
              proseKeys.has(`${key}.${field}`) ? "" : fieldValue,
            ]),
          )
        : entry,
    );
  }
  return value;
}

/** The sheet with volatile fields, bounded prose, and unknown reasons removed. */
export function sheetStructuralSkeleton(sheet: Sheet): Record<string, unknown> {
  const proseKeys = new Set<string>();
  const skeleton: Record<string, unknown> = {
    schemaVersion: sheet.schemaVersion,
    freshness: {
      project: sheet.freshness.project,
      commit: sheet.freshness.commit,
      dirty: sheet.freshness.dirty,
    },
  };
  for (const section of DISCOVER_SHEET_SECTIONS) {
    const value = sheet[section] as unknown;
    const prose = section === "definition";
    if (isRecord(value) && "confidence" in value) {
      skeleton[section] = canonicalLeaf(value as unknown as Leaf, prose);
      continue;
    }
    if (!isRecord(value)) {
      skeleton[section] = value;
      continue;
    }
    const sectionOut: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const fieldPath = `${section}.${key}`;
      if (isRecord(field) && "confidence" in field) {
        sectionOut[key] = canonicalLeaf(field as unknown as Leaf, false);
      } else {
        sectionOut[key] = canonicalSectionValue(field, proseKeys, fieldPath);
      }
    }
    skeleton[section] = sectionOut;
  }
  return skeleton;
}

export function sheetDigest(sheet: Sheet): string {
  return createHash("sha256")
    .update(JSON.stringify(sheetStructuralSkeleton(sheet)))
    .digest("hex");
}

// -------------------------------------------------------------- glossary

export interface Label {
  language: "en" | "de";
  text: string;
}

export interface HiddenLabel extends Label {
  reason: string;
  rejectedOn: string;
}

export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];
export type ConceptOrigin = (typeof CONCEPT_ORIGINS)[number];
export type ConceptKind = (typeof CONCEPT_KINDS)[number];

export interface Concept {
  id: string;
  prefLabels: Label[];
  altLabels: Label[];
  hiddenLabels: HiddenLabel[];
  definitions: Label[];
  scopeNote: string | null;
  example: string | null;
  historyNote: string | null;
  status: ConceptStatus;
  origin: ConceptOrigin;
  standardRef: string | null;
  kind: ConceptKind;
  grounding: string[];
  broader: string | null;
  related: string[];
}

export interface Glossary {
  boundedContext: string;
  titles: Label[];
  concepts: Concept[];
}

const CONCEPT_FIELDS = [
  "id",
  "prefLabels",
  "altLabels",
  "hiddenLabels",
  "definitions",
  "scopeNote",
  "example",
  "historyNote",
  "status",
  "origin",
  "standardRef",
  "kind",
  "grounding",
  "broader",
  "related",
] as const;

const REQUIRED_CONCEPT_FIELDS: Record<string, true> = {
  id: true,
  prefLabels: true,
  altLabels: true,
  hiddenLabels: true,
  definitions: true,
  status: true,
  origin: true,
  kind: true,
  grounding: true,
  related: true,
};

function languageValue(value: unknown, path: string): "en" | "de" {
  if (typeof value !== "string" || !(LANGUAGES as readonly string[]).includes(value)) {
    invalid(path, "must be en or de");
  }
  return value as "en" | "de";
}

function labelValue(value: unknown, path: string): Label {
  const label = recordFields(value, path, {
    language: languageValue,
    text: (entry, fieldPath) => textValue(entry, fieldPath),
  });
  return { language: label.language as "en" | "de", text: label.text as string };
}

function labelList(value: unknown, path: string): Label[] {
  if (!Array.isArray(value)) invalid(path, "must be a list of labels");
  const labels = value.map((entry, index) => labelValue(entry, `${path}[${index}]`));
  labels.sort((left, right) =>
    left.language === right.language
      ? left.text.localeCompare(right.text)
      : left.language.localeCompare(right.language),
  );
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.language)) invalid(path, "carries two labels in one language");
    seen.add(label.language);
  }
  return labels;
}

function hiddenLabelList(value: unknown, path: string): HiddenLabel[] {
  if (!Array.isArray(value)) invalid(path, "must be a list of hidden labels");
  const labels = value.map((entry, index) => {
    const hidden = recordFields(entry, `${path}[${index}]`, {
      language: languageValue,
      text: (item, fieldPath) => textValue(item, fieldPath),
      reason: (item, fieldPath) => {
        const reason = textValue(item, fieldPath, 400);
        return reason;
      },
      rejectedOn: (item, fieldPath) => {
        if (typeof item !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(item)) {
          invalid(fieldPath, "must be a YYYY-MM-DD date");
        }
        return item;
      },
    });
    return {
      language: hidden.language as "en" | "de",
      text: hidden.text as string,
      reason: hidden.reason as string,
      rejectedOn: hidden.rejectedOn as string,
    };
  });
  labels.sort((left, right) => `${left.language}:${left.text}`.localeCompare(`${right.language}:${right.text}`));
  return labels;
}

function groundingList(
  value: unknown,
  path: string,
  context: { repoDir: string; files: string[] },
): string[] {
  if (!Array.isArray(value)) invalid(path, "must be a list of grounding entries");
  const entries = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const text = textValue(entry, `${path}[${index}]`, 300);
    if (text.startsWith("code:")) {
      const target = text.slice("code:".length);
      if (ABSOLUTE_PATH_PATTERN.test(target) || target.split("/").includes("..")) {
        invalid(`${path}[${index}]`, "must name a repository-relative path");
      }
      const absolute = join(context.repoDir, target);
      if (!existsSync(absolute)) {
        invalid(`${path}[${index}]`, `names ${target}, which the host does not carry`);
      }
    } else if (text.startsWith("model:")) {
      const name = text.slice("model:".length);
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
        invalid(`${path}[${index}]`, "must name a model element");
      }
      if (!modelNameExists(context, name)) {
        invalid(`${path}[${index}]`, `names ${name}, which the host does not carry`);
      }
    } else {
      invalid(`${path}[${index}]`, "must start with code: or model:");
    }
    entries.add(text);
  }
  return [...entries].sort();
}

const modelCache = new Map<string, Map<string, boolean>>();

/** True when the name appears as a whole word in one crawled host file. */
function modelNameExists(context: { repoDir: string; files: string[] }, name: string): boolean {
  const key = `${context.repoDir}\u0000${context.files.length}`;
  let cache = modelCache.get(key);
  if (cache === undefined) {
    cache = new Map();
    modelCache.set(key, cache);
  }
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`);
  let found = false;
  let budget = 4096;
  for (const path of context.files) {
    if (budget-- <= 0) break;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(context.repoDir, path));
    } catch {
      continue;
    }
    if (bytes.length > 512 * 1024) continue;
    if (bytes.includes(0)) continue;
    if (pattern.test(bytes.toString("utf8"))) {
      found = true;
      break;
    }
  }
  cache.set(name, found);
  return found;
}

function conceptValue(raw: unknown, path: string, context: { repoDir: string; files: string[] }): Concept {
  if (!isRecord(raw)) invalid(path, "must be an object");
  const known = new Set<string>(CONCEPT_FIELDS);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) invalid(`${path}.${key}`, "is not a UbiLang concept field");
  }
  for (const required of Object.keys(REQUIRED_CONCEPT_FIELDS)) {
    if (raw[required] === undefined) invalid(`${path}.${required}`, "is required");
  }
  const id = textValue(raw.id, `${path}.id`, 120);
  if (!CONCEPT_ID_PATTERN.test(id)) invalid(`${path}.id`, "must be kebab-case");
  const prefLabels = labelList(raw.prefLabels, `${path}.prefLabels`);
  if (prefLabels.length === 0) invalid(`${path}.prefLabels`, "must carry a preferred label");
  if (!prefLabels.some((label) => label.language === "en")) {
    invalid(`${path}.prefLabels`, "must carry an English preferred label");
  }
  const altLabels = labelList(raw.altLabels, `${path}.altLabels`);
  const hiddenLabels = hiddenLabelList(raw.hiddenLabels, `${path}.hiddenLabels`);
  const definitions = Array.isArray(raw.definitions)
    ? raw.definitions.map((entry, index) => labelValue(entry, `${path}.definitions[${index}]`))
    : invalid(`${path}.definitions`, "must be a list of labels");
  if (definitions.length === 0) invalid(`${path}.definitions`, "must carry a definition");
  if (!definitions.some((label) => label.language === "en")) {
    invalid(`${path}.definitions`, "must carry an English definition");
  }
  definitions.sort((left, right) => left.language.localeCompare(right.language));

  const optionalText = (key: string): string | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    return textValue(value, `${path}.${key}`, 500);
  };

  const status = raw.status;
  if (typeof status !== "string" || !(CONCEPT_STATUSES as readonly string[]).includes(status)) {
    invalid(`${path}.status`, `must be one of ${CONCEPT_STATUSES.join(", ")}`);
  }
  const origin = raw.origin;
  if (typeof origin !== "string" || !(CONCEPT_ORIGINS as readonly string[]).includes(origin)) {
    invalid(`${path}.origin`, `must be one of ${CONCEPT_ORIGINS.join(", ")}`);
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !(CONCEPT_KINDS as readonly string[]).includes(kind)) {
    invalid(`${path}.kind`, `must be one of ${CONCEPT_KINDS.join(", ")}`);
  }
  const standardRef = optionalText("standardRef");
  if (origin === "standard" && standardRef === null) {
    invalid(`${path}.standardRef`, "is required when origin is standard");
  }
  const grounding = groundingList(raw.grounding, `${path}.grounding`, context);
  if (grounding.length === 0) invalid(`${path}.grounding`, "must ground the concept");

  const broaderRaw = raw.broader;
  let broader: string | null = null;
  if (broaderRaw !== undefined && broaderRaw !== null) {
    broader = textValue(broaderRaw, `${path}.broader`, 120);
  }
  const related = Array.isArray(raw.related)
    ? [...new Set(raw.related.map((entry, index) => textValue(entry, `${path}.related[${index}]`, 120)))].sort()
    : invalid(`${path}.related`, "must be a list of concept ids");

  return {
    id,
    prefLabels,
    altLabels,
    hiddenLabels,
    definitions,
    scopeNote: optionalText("scopeNote"),
    example: optionalText("example"),
    historyNote: optionalText("historyNote"),
    status: status as ConceptStatus,
    origin: origin as ConceptOrigin,
    standardRef,
    kind: kind as ConceptKind,
    grounding,
    broader,
    related,
  };
}

export function parseGlossary(
  text: string,
  source: string,
  context: { repoDir: string; files: string[] },
  options: { staged: boolean },
): Glossary {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    invalid(source, `is not parseable YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) invalid(source, "must be one YAML document object");
  const known = new Set(["boundedContext", "titles", "concepts"]);
  for (const key of Object.keys(parsed)) {
    if (!known.has(key)) invalid(`${source}:${key}`, "is not a UbiLang glossary field");
  }
  if (parsed.boundedContext === undefined) invalid(`${source}:boundedContext`, "is required");
  const boundedContext = textValue(parsed.boundedContext, `${source}:boundedContext`, 120);
  if (!CONTEXT_PATTERN.test(boundedContext)) {
    invalid(`${source}:boundedContext`, "must be kebab-case");
  }
  if (basename(source) !== `${boundedContext}.glossary.yaml`) {
    invalid(`${source}:boundedContext`, `must match the file name ${boundedContext}.glossary.yaml`);
  }
  const titles = Array.isArray(parsed.titles)
    ? parsed.titles.map((entry, index) => labelValue(entry, `${source}:titles[${index}]`))
    : invalid(`${source}:titles`, "must be a list of labels");
  const rawConcepts = parsed.concepts;
  if (!Array.isArray(rawConcepts)) invalid(`${source}:concepts`, "must be a list");
  if (rawConcepts.length === 0) invalid(`${source}:concepts`, "must carry at least one concept");
  const concepts = rawConcepts.map((entry, index) =>
    conceptValue(entry, `${source}:concepts[${index}]`, context),
  );
  const ids = new Set<string>();
  for (const concept of concepts) {
    if (ids.has(concept.id)) invalid(`${source}:concepts`, `carries duplicate id ${concept.id}`);
    ids.add(concept.id);
    if (options.staged) {
      if (concept.status === "confirmed" || concept.status === "deprecated" || concept.status === "invalidated") {
        invalid(`${source}:concepts`, `writes human status ${concept.status} for ${concept.id}`);
      }
      if (concept.status === "unconfirmed" && concept.origin === "llm") {
        invalid(`${source}:concepts`, `cannot mark the llm coinage ${concept.id} unconfirmed`);
      }
      if (concept.status === "proposed" && concept.origin !== "llm") {
        invalid(`${source}:concepts`, `cannot propose ${concept.id} with origin ${concept.origin}`);
      }
    }
  }
  for (const concept of concepts) {
    if (concept.broader !== null && !ids.has(concept.broader)) {
      invalid(`${source}:concepts.${concept.id}.broader`, `names unknown concept ${concept.broader}`);
    }
    for (const related of concept.related) {
      if (!ids.has(related)) {
        invalid(`${source}:concepts.${concept.id}.related`, `names unknown concept ${related}`);
      }
    }
  }
  concepts.sort((left, right) => left.id.localeCompare(right.id));
  return { boundedContext, titles, concepts };
}

/** Deterministic YAML rendering of one canonical glossary document. */
export function renderGlossary(glossary: Glossary): string {
  const scalar = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const lines: string[] = [];
  lines.push(`boundedContext: ${scalar(glossary.boundedContext)}`);
  lines.push("titles:");
  if (glossary.titles.length === 0) lines[lines.length - 1] = "titles: []";
  for (const title of glossary.titles) {
    lines.push(`  - language: ${scalar(title.language)}`);
    lines.push(`    text: ${scalar(title.text)}`);
  }
  lines.push("concepts:");
  for (const concept of glossary.concepts) {
    lines.push(`  - id: ${scalar(concept.id)}`);
    const labels = (key: string, values: Label[]) => {
      if (values.length === 0) {
        lines.push(`    ${key}: []`);
        return;
      }
      lines.push(`    ${key}:`);
      for (const label of values) {
        lines.push(`      - language: ${scalar(label.language)}`);
        lines.push(`        text: ${scalar(label.text)}`);
      }
    };
    labels("prefLabels", concept.prefLabels);
    labels("altLabels", concept.altLabels);
    if (concept.hiddenLabels.length === 0) {
      lines.push("    hiddenLabels: []");
    } else {
      lines.push("    hiddenLabels:");
      for (const hidden of concept.hiddenLabels) {
        lines.push(`      - language: ${scalar(hidden.language)}`);
        lines.push(`        text: ${scalar(hidden.text)}`);
        lines.push(`        reason: ${scalar(hidden.reason)}`);
        lines.push(`        rejectedOn: ${scalar(hidden.rejectedOn)}`);
      }
    }
    labels("definitions", concept.definitions);
    lines.push(`    scopeNote: ${concept.scopeNote === null ? "null" : scalar(concept.scopeNote)}`);
    lines.push(`    example: ${concept.example === null ? "null" : scalar(concept.example)}`);
    lines.push(`    historyNote: ${concept.historyNote === null ? "null" : scalar(concept.historyNote)}`);
    lines.push(`    status: ${scalar(concept.status)}`);
    lines.push(`    origin: ${scalar(concept.origin)}`);
    lines.push(`    standardRef: ${concept.standardRef === null ? "null" : scalar(concept.standardRef)}`);
    lines.push(`    kind: ${scalar(concept.kind)}`);
    if (concept.grounding.length === 0) {
      lines.push("    grounding: []");
    } else {
      lines.push("    grounding:");
      for (const entry of concept.grounding) lines.push(`      - ${scalar(entry)}`);
    }
    lines.push(`    broader: ${concept.broader === null ? "null" : scalar(concept.broader)}`);
    if (concept.related.length === 0) {
      lines.push("    related: []");
    } else {
      lines.push("    related:");
      for (const entry of concept.related) lines.push(`      - ${scalar(entry)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The glossary with bounded prose blanked, used for the structural digest. */
function glossarySkeleton(glossary: Glossary): Record<string, unknown> {
  return {
    boundedContext: glossary.boundedContext,
    titles: glossary.titles.map((title) => ({ language: title.language, text: "" })),
    concepts: glossary.concepts.map((concept) => ({
      ...concept,
      prefLabels: concept.prefLabels,
      altLabels: concept.altLabels,
      hiddenLabels: concept.hiddenLabels,
      definitions: concept.definitions.map((definition) => ({
        language: definition.language,
        text: "",
      })),
      scopeNote: null,
      historyNote: null,
    })),
  };
}

export function glossaryDigest(glossary: Glossary): string {
  return createHash("sha256")
    .update(JSON.stringify(glossarySkeleton(glossary)))
    .digest("hex");
}

// ---------------------------------------------------------------- skills

interface SkillFrontmatter {
  fields: Map<string, string>;
  body: string;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseSkill(source: string, path: string): SkillFrontmatter {
  if (!source.startsWith("---\n")) invalid(path, "must start with YAML frontmatter");
  const end = source.indexOf("\n---", 4);
  if (end < 0) invalid(path, "must close its frontmatter");
  const frontmatter = source.slice(4, end);
  const body = source.slice(end + 4).replace(/^\r?\n/, "");
  const fields = new Map<string, string>();
  let section = "";
  for (const rawLine of frontmatter.split("\n")) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) continue;
    const indented = rawLine.startsWith(" ") || rawLine.startsWith("\t");
    const match = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(rawLine);
    if (match === null) invalid(path, `cannot read frontmatter line ${rawLine.trim()}`);
    const key = match[1] as string;
    const value = (match[2] as string).trim();
    if (!indented && value.length === 0) {
      section = key;
      continue;
    }
    const name = indented && section.length > 0 ? `${section}.${key}` : key;
    fields.set(name, unquote(value));
  }
  return { fields, body };
}

function directiveText(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, "").trim();
}

const DIRECTIVE_PATTERN =
  /^(always|never|must not|must|should not|should|do not|don't|avoid|prefer|use)\s+(.+)$/i;
const NEGATIVE_DIRECTIVES: Record<string, true> = {
  never: true,
  "must not": true,
  "should not": true,
  "do not": true,
  "don't": true,
  avoid: true,
};

interface Directive {
  polarity: "positive" | "negative";
  subject: string;
  text: string;
}

function directivesOf(body: string): Directive[] {
  const directives: Directive[] = [];
  for (const line of body.split("\n")) {
    const match = DIRECTIVE_PATTERN.exec(directiveText(line));
    if (match === null) continue;
    const keyword = (match[1] as string).toLowerCase();
    const subject = (match[2] as string)
      .toLowerCase()
      .replace(/[`*_]/g, "")
      .replace(/[.:;]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (subject.length === 0) continue;
    directives.push({
      polarity: NEGATIVE_DIRECTIVES[keyword] === true ? "negative" : "positive",
      subject,
      text: directiveText(line),
    });
  }
  return directives;
}

/** Opposite policies about the same subject, across two skill bodies. */
export function skillContradictions(
  skills: Array<{ name: string; body: string }>,
): Array<{ skills: [string, string]; subject: string; directives: [string, string] }> {
  const contradictions: Array<{
    skills: [string, string];
    subject: string;
    directives: [string, string];
  }> = [];
  const seen = new Set<string>();
  for (let left = 0; left < skills.length; left += 1) {
    for (let right = left + 1; right < skills.length; right += 1) {
      const a = skills[left] as { name: string; body: string };
      const b = skills[right] as { name: string; body: string };
      for (const first of directivesOf(a.body)) {
        for (const second of directivesOf(b.body)) {
          if (first.polarity === second.polarity) continue;
          if (first.subject !== second.subject) continue;
          const key = `${a.name}\u0000${b.name}\u0000${first.subject}`;
          if (seen.has(key)) continue;
          seen.add(key);
          contradictions.push({
            skills: [a.name, b.name],
            subject: first.subject,
            directives: [first.text, second.text],
          });
        }
      }
    }
  }
  return contradictions;
}

export interface StagedSkill {
  name: DiscoverSkillName;
  text: string;
  body: string;
}

function validateSkillText(name: string, text: string, path: string): StagedSkill {
  const { fields, body } = parseSkill(text, path);
  const declared = fields.get("name") ?? "";
  if (declared !== name) invalid(`${path}:name`, `must equal the directory name ${name}`);
  if (!SKILL_NAME_PATTERN.test(declared)) invalid(`${path}:name`, "must be kebab-case");
  if (declared.length > SKILL_NAME_MAX) invalid(`${path}:name`, `must be at most ${SKILL_NAME_MAX} characters`);
  const description = fields.get("description") ?? "";
  if (description.trim().length === 0) invalid(`${path}:description`, "must not be empty");
  if (description.length > SKILL_DESCRIPTION_MAX) {
    invalid(`${path}:description`, `must be at most ${SKILL_DESCRIPTION_MAX} characters`);
  }
  if (fields.get(`metadata.${MANAGED_MARKER}`) !== "true") {
    invalid(`${path}:metadata.${MANAGED_MARKER}`, 'must be "true"');
  }
  if (fields.get(`metadata.${FAMILY_MARKER}`) !== DISCOVER_FAMILY) {
    invalid(`${path}:metadata.${FAMILY_MARKER}`, 'must be "discover"');
  }
  const role = fields.get(`metadata.${SKILL_MARKER}`) ?? "";
  if (role.trim().length === 0) invalid(`${path}:metadata.${SKILL_MARKER}`, "must name the skill's role");
  if (hasSecret(description) || hasSecret(role) || hasSecret(body)) {
    invalid(path, "must not carry a secret value");
  }
  if (body.trim().length === 0) invalid(path, "must carry a body");
  const lines = body.split("\n");
  let bullets = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (!/^[-*+]\s+/.test(line.trimStart())) {
      invalid(path, "body prose must be imperative bullets, not paragraphs");
    }
    bullets += 1;
  }
  if (bullets === 0) invalid(path, "must carry at least one imperative bullet");
  return { name: name as DiscoverSkillName, text, body };
}

// ------------------------------------------------------- staged validation

export interface StagedArtifacts {
  sheet: Sheet;
  glossaries: Glossary[];
  skills: StagedSkill[];
}

function walkFiles(root: string, prefix = ""): string[] {
  const entries = readdirSync(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const next = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walkFiles(root, next));
    else files.push(next);
  }
  return files.sort();
}

export function validateStaged(
  repoDir: string,
  stagingDir: string,
  freshness: Freshness,
): StagedArtifacts {
  if (!existsSync(stagingDir)) {
    throw new DiscoverValidationError("the crawl left no staging directory");
  }
  const files = walkFiles(stagingDir);
  const skillDirs = new Set(
    files
      .filter((file) => file.startsWith(`${STAGED_SKILL_DIR}/`))
      .map((file) => file.split("/")[1] as string),
  );
  for (const file of files) {
    const parts = file.split("/");
    const allowed =
      file === STAGED_SHEET ||
      (parts[0] === STAGED_GLOSSARY_DIR &&
        parts.length === 2 &&
        parts[1] !== undefined &&
        parts[1].endsWith(".glossary.yaml")) ||
      (parts[0] === STAGED_SKILL_DIR &&
        parts.length === 3 &&
        parts[2] === "SKILL.md" &&
        skillDirs.has(parts[1] as string));
    if (!allowed) {
      throw new DiscoverValidationError(
        `the crawl wrote ${file}, which is not part of the staged Discover set`,
      );
    }
  }
  if (!files.includes(STAGED_SHEET)) {
    throw new DiscoverValidationError("the crawl left no sheet.json");
  }

  let rawSheet: unknown;
  try {
    rawSheet = JSON.parse(readFileSync(join(stagingDir, STAGED_SHEET), "utf8"));
  } catch (error) {
    throw new DiscoverValidationError(
      `sheet.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sheet = normalizeSheet(rawSheet, freshness);

  const context = { repoDir, files: hostFiles(repoDir) };
  const glossaryFiles = files.filter((file) => file.startsWith(`${STAGED_GLOSSARY_DIR}/`));
  if (glossaryFiles.length === 0) {
    throw new DiscoverValidationError("the crawl left no glossary document");
  }
  const glossaries: Glossary[] = [];
  const contexts = new Set<string>();
  for (const file of glossaryFiles) {
    let text: string;
    try {
      text = readFileSync(join(stagingDir, file), "utf8");
    } catch (error) {
      throw new DiscoverValidationError(`could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const glossary = parseGlossary(text, file, context, { staged: true });
    if (contexts.has(glossary.boundedContext)) {
      throw new DiscoverValidationError(`two glossaries name ${glossary.boundedContext}`);
    }
    contexts.add(glossary.boundedContext);
    glossaries.push(glossary);
  }

  const skills: StagedSkill[] = [];
  for (const name of DISCOVER_SKILLS) {
    const file = `${STAGED_SKILL_DIR}/${name}/SKILL.md`;
    if (!files.includes(file)) {
      throw new DiscoverValidationError(`the crawl left no ${name} skill`);
    }
    skills.push(validateSkillText(name, readFileSync(join(stagingDir, file), "utf8"), file));
  }
  for (const directory of skillDirs) {
    if (!isDiscoverSkill(directory)) {
      throw new DiscoverValidationError(`the crawl wrote an undeclared skill ${directory}`);
    }
  }

  const contradictions = skillContradictions(
    skills.map((skill) => ({ name: skill.name, body: skill.body })),
  );
  if (contradictions.length > 0) {
    const [first] = contradictions;
    throw new DiscoverValidationError(
      `the generated skills contradict each other: ${first?.skills[0]} and ${first?.skills[1]} disagree about ${first?.subject}`,
    );
  }

  const glossarySkill = skills.find((skill) => skill.name === "discover-glossary");
  for (const glossary of glossaries) {
    const path = `.omp/discover/glossary/${glossary.boundedContext}.glossary.yaml`;
    if (glossarySkill === undefined || !glossarySkill.body.includes(path)) {
      throw new DiscoverValidationError(`discover-glossary does not name ${path}`);
    }
  }

  return { sheet, glossaries, skills };
}

// ------------------------------------------------------------- decisions

export type DecisionAction = "confirm" | "reject";

export interface Decision {
  context: string;
  id: string;
  action: DecisionAction;
  reason: string | null;
  date: string;
}

function readDecisions(repoDir: string): Decision[] {
  const path = join(discoverRoot(repoDir), "decisions.json");
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DiscoverValidationError(
      `decisions.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new DiscoverValidationError("decisions.json is not a list");
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) invalid(`decisions[${index}]`, "must be an object");
    const action = entry.action;
    if (action !== "confirm" && action !== "reject") {
      invalid(`decisions[${index}].action`, "must be confirm or reject");
    }
    const reason = entry.reason;
    if (reason !== null && typeof reason !== "string") {
      invalid(`decisions[${index}].reason`, "must be a string or null");
    }
    const date = entry.date;
    if (typeof date !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
      invalid(`decisions[${index}].date`, "must be a YYYY-MM-DD date");
    }
    return {
      context: textValue(entry.context, `decisions[${index}].context`, 120),
      id: textValue(entry.id, `decisions[${index}].id`, 120),
      action,
      reason: reason as string | null,
      date,
    };
  });
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// ------------------------------------------------------------- manifest

export interface ManifestSkill {
  name: DiscoverSkillName;
  baselineHash: string;
  currentHash: string | null;
  state: "generated" | "edited" | "missing";
}

export interface Manifest {
  schemaVersion: number;
  fingerprint: string;
  publishedAt: string;
  runId: string;
  sheetDigest: string;
  glossaryDigests: Record<string, string>;
  skills: ManifestSkill[];
  paths: {
    manifest: string;
    sheet: string;
    decisions: string;
    glossaries: string[];
    baselines: Record<string, string>;
    live: Record<string, string>;
  };
}

function isManifest(value: unknown): value is Manifest {
  return isRecord(value) && value.schemaVersion === DISCOVER_SCHEMA_VERSION;
}

function readManifest(repoDir: string): Manifest | undefined {
  const path = join(discoverRoot(repoDir), "manifest.json");
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DiscoverValidationError(
      `manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isManifest(parsed)) throw new DiscoverValidationError("manifest.json has an unsupported version");
  return parsed;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ------------------------------------------------------------ publishing

interface FileWrite {
  path: string;
  content: string;
}

interface FileSnapshot {
  path: string;
  bytes: Buffer | undefined;
}

/** Writes every file or leaves all affected bytes exactly as they were. */
function writeTransaction(writes: FileWrite[], deletions: string[]): void {
  const snapshots: FileSnapshot[] = [];
  const paths = [...new Set([...writes.map((write) => write.path), ...deletions])];
  for (const path of paths) {
    snapshots.push({ path, bytes: existsSync(path) ? readFileSync(path) : undefined });
  }
  try {
    for (const write of writes) {
      mkdirSync(dirname(write.path), { recursive: true });
      const temporary = `${write.path}.${process.pid}.tmp`;
      writeFileSync(temporary, write.content);
      renameSync(temporary, write.path);
    }
    for (const path of deletions) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  } catch (error) {
    for (const snapshot of snapshots) {
      try {
        if (snapshot.bytes === undefined) {
          if (existsSync(snapshot.path)) unlinkSync(snapshot.path);
        } else {
          writeFileSync(snapshot.path, snapshot.bytes);
        }
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    throw error;
  }
}

interface PublishedRead {
  manifest: Manifest;
  sheet: Sheet;
  glossaries: Glossary[];
  decisions: Decision[];
}

function readPublished(repoDir: string): PublishedRead | undefined {
  const manifest = readManifest(repoDir);
  if (manifest === undefined) return undefined;
  const context = { repoDir, files: hostFiles(repoDir) };
  const sheetPath = join(repoDir, manifest.paths.sheet);
  let rawSheet: unknown;
  try {
    rawSheet = JSON.parse(readFileSync(sheetPath, "utf8"));
  } catch (error) {
    throw new DiscoverValidationError(
      `sheet.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(rawSheet)) throw new DiscoverValidationError("sheet.json is not an object");
  const freshness = rawSheet.freshness;
  if (!isRecord(freshness)) throw new DiscoverValidationError("sheet.json has no freshness header");
  const sheet = normalizeSheet(
    Object.fromEntries(Object.entries(rawSheet).filter(([key]) => key !== "freshness")),
    {
      project: textValue(freshness.project, "freshness.project", 200),
      commit: textValue(freshness.commit, "freshness.commit", 64),
      dirty: freshness.dirty === true,
      discoveredAt: textValue(freshness.discoveredAt, "freshness.discoveredAt", 64),
      fingerprint: textValue(freshness.fingerprint, "freshness.fingerprint", 128),
    },
  );
  const glossaries: Glossary[] = [];
  for (const relativePath of manifest.paths.glossaries) {
    const file = join(repoDir, relativePath);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new DiscoverValidationError(
        `${relativePath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    glossaries.push(parseGlossary(text, relativePath, context, { staged: false }));
  }
  const decisions = readDecisions(repoDir);
  return { manifest, sheet, glossaries, decisions };
}

/** A live skill that is not this run's to replace. */
function collisionAt(repoDir: string, name: string): string | undefined {
  const path = liveSkillPath(repoDir, name);
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return `${name} is unreadable, so Discover will not replace it`;
  }
  let fields: Map<string, string>;
  try {
    fields = parseSkill(text, name).fields;
  } catch {
    return `${name} is an unmanaged skill, so Discover will not replace it`;
  }
  if (fields.get(`metadata.${MANAGED_MARKER}`) !== "true") {
    return `${name} is an unmanaged skill, so Discover will not replace it`;
  }
  const family = fields.get(`metadata.${FAMILY_MARKER}`) ?? "prepare";
  if (family !== DISCOVER_FAMILY) {
    return `${name} belongs to the ${family} family, so Discover will not replace it`;
  }
  return undefined;
}

function mergeGlossary(existing: Glossary | undefined, staged: Glossary): Glossary {
  if (existing === undefined) return staged;
  const stagedById = new Map(staged.concepts.map((concept) => [concept.id, concept]));
  const preserved: Concept[] = staged.concepts.map((concept) => {
    const previous = existing.concepts.find((candidate) => candidate.id === concept.id);
    if (previous === undefined) return concept;
    if (previous.status !== "confirmed" && previous.status !== "invalidated") return concept;
    // A human decision is never overwritten; only grounding follows the code.
    return { ...previous, grounding: concept.grounding };
  });
  const seen = new Set(preserved.map((concept) => concept.id));
  for (const previous of existing.concepts) {
    if (previous.status !== "confirmed" && previous.status !== "invalidated") continue;
    if (seen.has(previous.id)) continue;
    preserved.push(previous);
    seen.add(previous.id);
  }
  preserved.sort((left, right) => left.id.localeCompare(right.id));
  return { boundedContext: staged.boundedContext, titles: staged.titles, concepts: preserved };
}

export interface PublishInput {
  repoDir: string;
  runId: string;
  facts: HostFacts;
  staged: StagedArtifacts;
  project: string;
}

export interface PublishResult {
  manifest: Manifest;
  sheet: Sheet;
  glossaries: Glossary[];
  decisions: Decision[];
  warnings: string[];
}

export function publishStaged(input: PublishInput): PublishResult {
  const { repoDir, runId, facts, staged, project } = input;

  for (const name of DISCOVER_SKILLS) {
    const collision = collisionAt(repoDir, name);
    if (collision !== undefined) throw new DiscoverValidationError(collision);
  }

  const previous = readPublished(repoDir);
  const previousByName = new Map(staged.glossaries.map((glossary) => [glossary.boundedContext, glossary]));
  const merged: Glossary[] = staged.glossaries.map((glossary) =>
    mergeGlossary(
      previous?.glossaries.find(
        (candidate) => candidate.boundedContext === glossary.boundedContext,
      ),
      glossary,
    ),
  );
  for (const previousGlossary of previous?.glossaries ?? []) {
    if (previousByName.has(previousGlossary.boundedContext)) continue;
    // A bounded context the crawl no longer sees keeps its human decisions.
    if (previousGlossary.concepts.some(
      (concept) => concept.status === "confirmed" || concept.status === "invalidated",
    )) {
      merged.push(previousGlossary);
    }
  }
  merged.sort((left, right) => left.boundedContext.localeCompare(right.boundedContext));

  // Discovery does not ask the operator to confirm terms one by one: every
  // newly crawled term is published as confirmed. An invalidated term stays
  // invalidated because it records a human decision.
  for (const glossary of merged) {
    for (const concept of glossary.concepts) {
      if (concept.status === "proposed" || concept.status === "unconfirmed") {
        concept.status = "confirmed";
      }
    }
  }

  const freshness: Freshness = {
    project,
    commit: facts.commit,
    dirty: facts.dirty,
    discoveredAt: new Date().toISOString(),
    fingerprint: facts.fingerprint,
  };
  const sheet = normalizeSheet(
    Object.fromEntries(
      Object.entries(staged.sheet as unknown as Record<string, unknown>).filter(
        ([key]) => key !== "freshness",
      ),
    ),
    freshness,
  );

  const previousBaselines = new Map<string, string>(
    (previous?.manifest.skills ?? []).map((skill) => [skill.name, skill.baselineHash]),
  );
  const skillEntries: ManifestSkill[] = [];
  const skillWrites: FileWrite[] = [];
  const previousBaselineText = new Map<string, string>();
  for (const skill of DISCOVER_SKILLS) {
    const stagedSkill = staged.skills.find((entry) => entry.name === skill);
    if (stagedSkill === undefined) throw new DiscoverValidationError(`the crawl left no ${skill}`);
    const baseline = `${stagedSkill.text}`;
    const baselineHash = hashText(baseline);
    const livePath = liveSkillPath(repoDir, skill);
    const previousBaselineHash = previousBaselines.get(skill);
    const previousBaselinePath = baselinePath(repoDir, skill);
    if (existsSync(previousBaselinePath)) {
      previousBaselineText.set(skill, readFileSync(previousBaselinePath, "utf8"));
    }
    let state: ManifestSkill["state"];
    let currentHash: string | null;
    if (!existsSync(livePath)) {
      if (previous?.manifest === undefined) {
        // The first publication installs every live skill.
        state = "generated";
        currentHash = hashText(baseline);
        skillWrites.push({ path: livePath, content: baseline });
      } else {
        // A skill the developer deleted is not recreated; Restore copies the
        // current baseline.
        state = "missing";
        currentHash = null;
      }
    } else {
      const liveText = readFileSync(livePath, "utf8");
      currentHash = hashText(liveText);
      if (previousBaselineHash !== undefined && currentHash !== previousBaselineHash) {
        state = "edited";
      } else if (previousBaselineHash === undefined && currentHash !== baselineHash) {
        state = "edited";
      } else {
        state = "generated";
        currentHash = baselineHash;
        skillWrites.push({ path: livePath, content: baseline });
      }
    }
    skillEntries.push({ name: skill, baselineHash, currentHash, state });
    skillWrites.push({ path: previousBaselinePath, content: baseline });
  }

  const warnings: string[] = [];
  const liveBodies = skillEntries
    .filter((entry) => entry.state === "edited")
    .map((entry) => ({
      name: entry.name,
      body: readFileSync(liveSkillPath(repoDir, entry.name), "utf8"),
    }));
  for (const contradiction of skillContradictions(liveBodies)) {
    warnings.push(
      `${contradiction.skills[0]} and ${contradiction.skills[1]} disagree about ${contradiction.subject}`,
    );
  }

  const manifest: Manifest = {
    schemaVersion: DISCOVER_SCHEMA_VERSION,
    fingerprint: facts.fingerprint,
    publishedAt: new Date().toISOString(),
    runId,
    sheetDigest: sheetDigest(sheet),
    glossaryDigests: Object.fromEntries(
      merged.map((glossary) => [glossary.boundedContext, glossaryDigest(glossary)]),
    ),
    skills: skillEntries,
    paths: {
      manifest: ".omp/discover/manifest.json",
      sheet: ".omp/discover/sheet.json",
      decisions: ".omp/discover/decisions.json",
      glossaries: merged.map(
        (glossary) => `.omp/discover/glossary/${glossary.boundedContext}.glossary.yaml`,
      ),
      baselines: Object.fromEntries(
        DISCOVER_SKILLS.map((name) => [name, `.omp/discover/skills/${name}/SKILL.md`]),
      ),
      live: Object.fromEntries(DISCOVER_SKILLS.map((name) => [name, `.omp/skills/${name}/SKILL.md`])),
    },
  };

  const decisions = previous?.decisions ?? [];
  const writes: FileWrite[] = [
    { path: join(repoDir, manifest.paths.sheet), content: renderJson(sheet) },
    { path: join(repoDir, manifest.paths.manifest), content: renderJson(manifest) },
    { path: join(repoDir, manifest.paths.decisions), content: renderJson(decisions) },
    ...merged.map((glossary) => ({
      path: glossaryPath(repoDir, glossary.boundedContext),
      content: renderGlossary(glossary),
    })),
    ...skillWrites,
  ];
  const desiredGlossaries = new Set(merged.map((glossary) => glossaryPath(repoDir, glossary.boundedContext)));
  const deletions: string[] = [];
  const glossaryRoot = join(discoverRoot(repoDir), "glossary");
  if (existsSync(glossaryRoot)) {
    for (const entry of readdirSync(glossaryRoot)) {
      const absolute = join(glossaryRoot, entry);
      if (!desiredGlossaries.has(absolute) && statSync(absolute).isFile()) deletions.push(absolute);
    }
  }
  writeTransaction(writes, deletions);

  return { manifest, sheet, glossaries: merged, decisions, warnings };
}

// ---------------------------------------------------------- published view

export interface SkillView {
  name: DiscoverSkillName;
  description: string;
  state: "generated" | "edited" | "missing";
  baseline: string | null;
  live: string | null;
  baselineHash: string | null;
  currentHash: string | null;
}

export interface DiscoverArtifacts {
  manifest: Manifest;
  sheet: Sheet;
  glossaries: Glossary[];
  decisions: Decision[];
  skills: SkillView[];
}

export interface ArtifactsRead {
  artifacts: DiscoverArtifacts | null;
  error: string | null;
}

function readSkillView(repoDir: string, manifest: Manifest, name: DiscoverSkillName): SkillView {
  const entry = manifest.skills.find((skill) => skill.name === name);
  const baselineFile = baselinePath(repoDir, name);
  const liveFile = liveSkillPath(repoDir, name);
  const baseline = existsSync(baselineFile) ? readFileSync(baselineFile, "utf8") : null;
  const live = existsSync(liveFile) ? readFileSync(liveFile, "utf8") : null;
  const baselineHash = baseline === null ? null : hashText(baseline);
  const currentHash = live === null ? null : hashText(live);
  let description = "";
  try {
    description = parseSkill(live ?? baseline ?? "", name).fields.get("description") ?? "";
  } catch {
    description = "";
  }
  let state: SkillView["state"];
  if (live === null) state = "missing";
  else if (baselineHash !== null && currentHash === baselineHash) state = "generated";
  else if (entry !== undefined && entry.baselineHash === currentHash) state = "generated";
  else state = "edited";
  return { name, description, state, baseline, live, baselineHash, currentHash };
}

/** Reads the published artifacts from disk; never writes or repairs them. */
export function readArtifacts(repoDir: string): ArtifactsRead {
  try {
    const published = readPublished(repoDir);
    if (published === undefined) return { artifacts: null, error: null };
    const skills = DISCOVER_SKILLS.map((name) =>
      readSkillView(repoDir, published.manifest, name),
    );
    return {
      artifacts: {
        manifest: published.manifest,
        sheet: published.sheet,
        glossaries: published.glossaries,
        decisions: published.decisions,
        skills,
      },
      error: null,
    };
  } catch (error) {
    return {
      artifacts: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Non-blocking contradictions among the live skills a developer edited. */
export function liveWarnings(repoDir: string, artifacts: DiscoverArtifacts): string[] {
  const edited = artifacts.skills.filter((skill) => skill.state === "edited" && skill.live !== null);
  if (edited.length === 0) return [];
  return skillContradictions(
    edited.map((skill) => ({ name: skill.name, body: skill.live ?? "" })),
  ).map(
    (contradiction) =>
      `${contradiction.skills[0]} and ${contradiction.skills[1]} disagree about ${contradiction.subject}`,
  );
}

export function artifactsStale(repoDir: string, artifacts: DiscoverArtifacts | null): boolean {
  if (artifacts === null) return false;
  try {
    return hostFacts(repoDir).fingerprint !== artifacts.manifest.fingerprint;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ skill edits

export interface SkillMutation {
  artifacts: DiscoverArtifacts;
  error: string | null;
}

export function saveLiveSkill(repoDir: string, name: string, text: string): string | null {
  if (!isDiscoverSkill(name)) {
    return `${name} is not one of the five Discover skills`;
  }
  const manifest = readManifest(repoDir);
  if (manifest === undefined) return "no Discover artifacts are published";
  const livePath = liveSkillPath(repoDir, name);
  if (!existsSync(livePath)) return `${name} is missing`;
  let staged: StagedSkill;
  try {
    staged = validateSkillText(name, text, `${name}/SKILL.md`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const currentHash = hashText(text);
  const baselineHash = manifest.skills.find((skill) => skill.name === name)?.baselineHash ?? currentHash;
  const state: ManifestSkill["state"] = currentHash === baselineHash ? "generated" : "edited";
  const next: Manifest = {
    ...manifest,
    skills: manifest.skills.map((skill) =>
      skill.name === name ? { ...skill, currentHash, state } : skill,
    ),
  };
  writeTransaction(
    [
      { path: livePath, content: staged.text },
      { path: join(repoDir, manifest.paths.manifest), content: renderJson(next) },
    ],
    [],
  );
  return null;
}

export function restoreLiveSkill(repoDir: string, name: string): string | null {
  if (!isDiscoverSkill(name)) {
    return `${name} is not one of the five Discover skills`;
  }
  const manifest = readManifest(repoDir);
  if (manifest === undefined) return "no Discover artifacts are published";
  const baselineFile = baselinePath(repoDir, name);
  if (!existsSync(baselineFile)) return `no generated baseline exists for ${name}`;
  const liveFile = liveSkillPath(repoDir, name);
  const baselineHash = hashText(readFileSync(baselineFile, "utf8"));
  const next: Manifest = {
    ...manifest,
    skills: manifest.skills.map((skill) =>
      skill.name === name ? { ...skill, currentHash: baselineHash, state: "generated" } : skill,
    ),
  };
  writeTransaction(
    [
      { path: liveFile, content: readFileSync(baselineFile, "utf8") },
      { path: join(repoDir, manifest.paths.manifest), content: renderJson(next) },
    ],
    [],
  );
  return null;
}

// --------------------------------------------------------- glossary edits

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readGlossaryFile(repoDir: string, context: string): Glossary {
  if (!CONTEXT_PATTERN.test(context)) invalid("context", "must be a bounded context name");
  const file = glossaryPath(repoDir, context);
  if (!existsSync(file)) invalid("context", `has no glossary at ${context}.glossary.yaml`);
  const parsed = readFileSync(file, "utf8");
  return parseGlossary(parsed, `${context}.glossary.yaml`, {
    repoDir,
    files: hostFiles(repoDir),
  }, { staged: false });
}

function updateTerm(
  repoDir: string,
  context: string,
  id: string,
  update: (concept: Concept) => string | null,
  decision: Omit<Decision, "context" | "id" | "date">,
): string | null {
  const manifest = readManifest(repoDir);
  if (manifest === undefined) return "no Discover artifacts are published";
  let glossary: Glossary;
  try {
    glossary = readGlossaryFile(repoDir, context);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const concept = glossary.concepts.find((entry) => entry.id === id);
  if (concept === undefined) return `${id} is not a term of ${context}`;
  const refusal = update(concept);
  if (refusal !== null) return refusal;
  const decisions = readDecisions(repoDir);
  const nextDecision: Decision = { context, id, ...decision, date: today() };
  const nextManifest: Manifest = {
    ...manifest,
    glossaryDigests: {
      ...manifest.glossaryDigests,
      [context]: glossaryDigest(glossary),
    },
  };
  writeTransaction(
    [
      { path: glossaryPath(repoDir, context), content: renderGlossary(glossary) },
      { path: join(repoDir, manifest.paths.decisions), content: renderJson([...decisions, nextDecision]) },
      { path: join(repoDir, manifest.paths.manifest), content: renderJson(nextManifest) },
    ],
    [],
  );
  return null;
}

export function confirmGlossaryTerm(repoDir: string, context: string, id: string): string | null {
  return updateTerm(
    repoDir,
    context,
    id,
    (concept) => {
      if (concept.status !== "proposed" && concept.status !== "unconfirmed") {
        return `${id} is ${concept.status}, not confirmable`;
      }
      concept.status = "confirmed";
      return null;
    },
    { action: "confirm", reason: null },
  );
}

export function rejectGlossaryTerm(
  repoDir: string,
  context: string,
  id: string,
  reason: string,
): string | null {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length === 0) return "a rejection requires a non-empty reason";
  return updateTerm(
    repoDir,
    context,
    id,
    (concept) => {
      if (
        concept.status !== "proposed" &&
        concept.status !== "unconfirmed" &&
        concept.status !== "confirmed"
      ) {
        return `${id} is ${concept.status}, so it cannot be rejected`;
      }
      concept.status = "invalidated";
      return null;
    },
    { action: "reject", reason: trimmed },
  );
}
