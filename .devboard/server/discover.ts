import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dependencyName, normalizeRepositoryUrl } from "../lib/dependencies.ts";
import {
  type DiscoverAgentDescriptor,
  type DiscoverAgentId,
  discoverAgent,
} from "./agents/registry.ts";

/**
 * Discover Mode's artifact contract: the project sheet, the UbiLang glossaries,
 * the six project-local skills, the contribution sheet, the host fingerprint,
 * canonical ordering, the structural digest, staged validation, and atomic
 * publication.
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
  "discover-contribution",
] as const;

export type DiscoverSkillName = (typeof DISCOVER_SKILLS)[number];

const DISCOVER_SKILLS_BY_NAME: Record<string, true> = Object.fromEntries(
  DISCOVER_SKILLS.map((name) => [name, true] as const),
);

function isDiscoverSkill(name: string): name is DiscoverSkillName {
  return Object.hasOwn(DISCOVER_SKILLS_BY_NAME, name);
}

/** One of the seven independently triggerable Discover agents. */
export interface AgentOwnership {
  descriptor: DiscoverAgentDescriptor;
  /** Artifact roots, relative to the target root, this agent may publish. */
  skills: DiscoverSkillName[];
  sheet: boolean;
  glossary: boolean;
  contribution: boolean;
}

/** Resolves an agent id to the exact artifacts it owns; null for an unknown id. */
export function agentOwnership(id: string): AgentOwnership | null {
  const descriptor = discoverAgent(id);
  if (descriptor === undefined) return null;
  const skills: DiscoverSkillName[] = [];
  if (descriptor.skill !== null && isDiscoverSkill(descriptor.skill)) {
    skills.push(descriptor.skill);
  }
  return {
    descriptor,
    skills,
    sheet: descriptor.skill === null,
    glossary: descriptor.glossary,
    contribution: descriptor.id === "discover-contribution",
  };
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
const STAGED_SIGNIFICANCE = "glossary/significance.json";
const STAGED_SKILL_DIR = "skills";
const STAGED_CONTRIBUTION = "contribution.json";

/** The crawl's own significance sidecar: one score and one reason per staged concept. */
const SIGNIFICANCE_SCHEMA_VERSION = 1;
const SIGNIFICANCE_REASON_MAX = 160;
const SIGNIFICANCE_CONTEXT_KEYS = ["schemaVersion", "contexts"] as const;
const SIGNIFICANCE_ENTRY_KEYS = ["score", "reason"] as const;

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

// -------------------------------------------------------- remote targets

/**
 * Discover's second target: a public GitHub repository cloned under the
 * dashboard's state directory. The scratch root is the only place a remote
 * clone lives; every artifact of a remote run stays inside it.
 */
export const REMOTE_SCRATCH_NAME = "discover-remote";
export const REMOTE_URL_MAX_BYTES = 2048;
export const REMOTE_CLONE_TIMEOUT_MS = 300_000;

export interface RemoteRepository {
  /** The trimmed URL as submitted. */
  url: string;
  owner: string;
  repo: string;
}

export type RemoteUrlParse =
  | { ok: true; repository: RemoteRepository }
  | { ok: false; reason: string };

const REMOTE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/**
 * Accepts exactly `https://github.com/<owner>/<repo>`, with an optional
 * trailing slash and an optional `.git` suffix. Everything else is refused
 * with the one reason the caller reports.
 */
export function parseRemoteUrl(raw: string): RemoteUrlParse {
  const url = raw.trim();
  if (url.length === 0) return { ok: false, reason: "the URL is empty" };
  if (Buffer.byteLength(url, "utf8") > REMOTE_URL_MAX_BYTES) {
    return { ok: false, reason: `the URL is longer than ${REMOTE_URL_MAX_BYTES} bytes` };
  }
  if (!url.startsWith("https://")) {
    return { ok: false, reason: "the URL must start with https://" };
  }
  const rest = url.slice("https://".length);
  if (rest.includes("?") || rest.includes("#")) {
    return { ok: false, reason: "the URL must not carry a query or fragment" };
  }
  const parts = rest.split("/");
  if (parts.length === 4 && parts[3] === "") parts.pop();
  if (parts.length !== 3) {
    return { ok: false, reason: "the URL must name exactly one owner and one repository" };
  }
  const host = parts[0] ?? "";
  const owner = parts[1] ?? "";
  const rawRepo = parts[2] ?? "";
  if (host.includes("@")) {
    return { ok: false, reason: "the URL must not carry user information" };
  }
  if (host.includes(":")) {
    return { ok: false, reason: "the URL must not carry a port" };
  }
  if (host.toLowerCase() !== "github.com") {
    return { ok: false, reason: "the URL must name github.com" };
  }
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (!REMOTE_SEGMENT.test(owner) || !REMOTE_SEGMENT.test(repo)) {
    return {
      ok: false,
      reason:
        "the owner and repository must be 1-100 letters, digits, dots, underscores, or hyphens",
    };
  }
  return { ok: true, repository: { url, owner, repo } };
}

export function remoteScratchRoot(stateDir: string): string {
  return join(resolve(stateDir), REMOTE_SCRATCH_NAME);
}

/**
 * The one clone directory name a repository gets; always lowercase. The `~`
 * separator is outside the accepted URL grammar, so distinct `owner/repo`
 * pairs can never produce the same name (`a/b-c` and `a-b/c` stay apart).
 */
export function remoteCloneName(owner: string, repo: string): string {
  return `${owner}~${repo}`.toLowerCase();
}

/**
 * The retained project's directory. A run's checkout lives beside the retained
 * projects under a dotted `.staging-*` name, so it never displaces them.
 */
export function remoteProjectDirectory(
  scratchRoot: string,
  owner: string,
  repo: string,
): string {
  return join(scratchRoot, remoteCloneName(owner, repo));
}

/** The record naming one retained project; it sits beside the two `.omp` trees. */
export const REMOTE_RECORD_NAME = "project.json";

/** Every transient directory a run creates starts with this prefix. */
export const REMOTE_TRANSIENT_PREFIX = ".staging-";

/**
 * Live claims on transient directories, one `<name>.json` file per claim. A
 * dashboard's startup hygiene never removes a transient another live dashboard
 * still owns; without the claim, a second dashboard sharing `STATE_DIR` would
 * delete the checkout of a crawl that is still running.
 */
const RUN_CLAIM_DIRECTORY = ".runs";

interface RunClaim {
  /** Process that owns the transient directory. */
  pid: number;
  /** ISO time the claim was written, for diagnosis only. */
  claimedAt: string;
}

function claimPath(scratchRoot: string, name: string): string {
  return join(scratchRoot, RUN_CLAIM_DIRECTORY, `${name}.json`);
}

/** True while the claim's owner process still runs; an unreadable claim is dead. */
function claimAlive(scratchRoot: string, name: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(claimPath(scratchRoot, name), "utf8"));
  } catch {
    return false;
  }
  const pid = (raw as Partial<RunClaim> | null)?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only a vanished process means the claim is dead; any other failure is
    // treated as live, so a checkout is never removed on a guess.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Records this process as the owner of one transient directory. Returns false
 * when the claim cannot be written; the caller then refuses to create the
 * transient rather than leave it exposed to another dashboard's cleanup.
 */
export function claimScratchEntry(scratchRoot: string, name: string): boolean {
  const claim: RunClaim = { pid: process.pid, claimedAt: new Date().toISOString() };
  try {
    mkdirSync(join(scratchRoot, RUN_CLAIM_DIRECTORY), { recursive: true });
    writeFileSync(claimPath(scratchRoot, name), `${JSON.stringify(claim)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Drops one claim and the claim directory once it is empty. */
export function releaseScratchEntry(scratchRoot: string, name: string): void {
  try {
    rmSync(claimPath(scratchRoot, name), { force: true });
    rmdirSync(join(scratchRoot, RUN_CLAIM_DIRECTORY));
  } catch {
    // A claim that cannot be removed is dropped by the next start, and a
    // directory still holding another run's claim stays.
  }
}

/** Removes claims whose owner is gone, then the empty claim directory. */
function pruneScratchClaims(scratchRoot: string): void {
  const directory = join(scratchRoot, RUN_CLAIM_DIRECTORY);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const name = entry.name.slice(0, -".json".length);
    if (claimAlive(scratchRoot, name)) continue;
    try {
      rmSync(join(directory, entry.name), { force: true });
    } catch {
      // A claim that cannot be removed is retried by the next start.
    }
  }
  try {
    rmdirSync(directory);
  } catch {
    // The directory stays only while it still holds a live or stuck claim.
  }
}

/** What a retained project keeps after the run's checkout is gone. */
export interface RetainedRemoteProject {
  url: string;
  owner: string;
  repo: string;
  /** ISO time the discovery that produced the retained bytes completed. */
  completedAt: string;
}

function parseRetainedProject(raw: unknown): RetainedRemoteProject | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const url = record.url;
  const owner = record.owner;
  const repo = record.repo;
  const completedAt = record.completedAt;
  if (typeof url !== "string" || typeof owner !== "string" || typeof repo !== "string") {
    return null;
  }
  if (typeof completedAt !== "string" || !Number.isFinite(Date.parse(completedAt))) return null;
  const parsed = parseRemoteUrl(url);
  if (!parsed.ok) return null;
  if (parsed.repository.owner !== owner || parsed.repository.repo !== repo) return null;
  return { url: parsed.repository.url, owner, repo, completedAt };
}

/** Reads the record a retained project wrote, or null when it is unusable. */
export function readRetainedProject(directory: string): RetainedRemoteProject | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(directory, REMOTE_RECORD_NAME), "utf8"));
  } catch {
    return null;
  }
  return parseRetainedProject(raw);
}

/**
 * A retained project is usable only when its record names the directory and
 * both published trees are on disk. Nothing is repaired or re-crawled here.
 */
export function retainedProjectReady(
  directory: string,
  record: RetainedRemoteProject,
): boolean {
  if (basename(resolve(directory)) !== remoteCloneName(record.owner, record.repo)) return false;
  // The manifest lives under `.omp/discover` for every slice; a live skill tree
  // exists only once a skill agent has published.
  return existsSync(join(directory, ".omp", "discover"));
}

/** Every readable retained project, newest completed discovery first. */
export function listRetainedProjects(scratchRoot: string): RetainedRemoteProject[] {
  let entries;
  try {
    entries = readdirSync(scratchRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects: RetainedRemoteProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const directory = join(scratchRoot, entry.name);
    const record = readRetainedProject(directory);
    if (record === null) continue;
    if (remoteCloneName(record.owner, record.repo) !== entry.name) continue;
    if (!retainedProjectReady(directory, record)) continue;
    projects.push(record);
  }
  projects.sort((left, right) => {
    const newer = Date.parse(right.completedAt) - Date.parse(left.completedAt);
    return newer !== 0 ? newer : left.url.localeCompare(right.url);
  });
  return projects;
}

/**
 * Copies a finished run's published `.omp/discover` and `.omp/skills` bytes out
 * of its checkout and records the completion time. The previous snapshot is
 * restored when the rename fails, so a failed retention never loses bytes.
 */
export function retainRemoteProject(
  scratchRoot: string,
  checkoutDir: string,
  record: RetainedRemoteProject,
  runId: string,
): string | null {
  const published = join(checkoutDir, ".omp");
  const discoverSource = join(published, "discover");
  const skillsSource = join(published, "skills");
  // One agent's slice is a complete publication: the sheet alone has no live
  // skill, and a skill agents' baseline always sits beside its manifest.
  if (!existsSync(discoverSource)) {
    return "the agent published no Discover artifacts to retain";
  }
  const staging = join(scratchRoot, `${REMOTE_TRANSIENT_PREFIX}retain-${runId}`);
  const previous = join(scratchRoot, `${REMOTE_TRANSIENT_PREFIX}previous-${runId}`);
  const stagingName = basename(staging);
  const previousName = basename(previous);
  const destination = remoteProjectDirectory(scratchRoot, record.owner, record.repo);
  claimScratchEntry(scratchRoot, stagingName);
  claimScratchEntry(scratchRoot, previousName);
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(staging, ".omp"), { recursive: true });
    cpSync(discoverSource, join(staging, ".omp", "discover"), { recursive: true });
    if (existsSync(skillsSource)) {
      cpSync(skillsSource, join(staging, ".omp", "skills"), { recursive: true });
    }
    writeFileSync(join(staging, REMOTE_RECORD_NAME), `${JSON.stringify(record, null, 2)}\n`);
    rmSync(previous, { recursive: true, force: true });
    const hadPrevious = existsSync(destination);
    if (hadPrevious) renameSync(destination, previous);
    try {
      renameSync(staging, destination);
    } catch (error) {
      if (hadPrevious) {
        try {
          renameSync(previous, destination);
        } catch {
          // The snapshot stays at the previous name; the caller reports it.
        }
      }
      throw error;
    }
    rmSync(previous, { recursive: true, force: true });
    return null;
  } catch (error) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // A staging directory that cannot be removed is removed by the next start.
    }
    return error instanceof Error ? error.message : String(error);
  } finally {
    releaseScratchEntry(scratchRoot, stagingName);
    releaseScratchEntry(scratchRoot, previousName);
  }
}

/** Deletes one project's retained bytes. Every other project stays untouched. */
export function removeRetainedProject(
  scratchRoot: string,
  record: RetainedRemoteProject,
): string | null {
  try {
    rmSync(remoteProjectDirectory(scratchRoot, record.owner, record.repo), {
      recursive: true,
      force: true,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** True when `path` is a strict descendant of `root`. */
export function isInsideRepository(repoDir: string, path: string): boolean {
  const base = resolve(repoDir);
  const target = resolve(path);
  return target !== base && target.startsWith(`${base}${sep}`);
}

export interface RemoteCloneRequest {
  /** `git clone ... -- <url> .staging-<run-id>`. */
  argv: string[];
  /** The scratch root the child runs in. */
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface RemoteCloneResult {
  code: number;
  stderr: string;
  timedOut: boolean;
}

/** Tests inject a runner through `AppOptions`; production spawns git. */
export type RemoteCloneRunner = (request: RemoteCloneRequest) => Promise<RemoteCloneResult>;

function cloneEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "true";
  env.NO_COLOR = "1";
  return env;
}

export function remoteCloneRequest(
  url: string,
  scratchRoot: string,
  runId: string,
): RemoteCloneRequest {
  return {
    argv: [
      "git",
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--no-tags",
      "--",
      url,
      `.staging-${runId}`,
    ],
    cwd: scratchRoot,
    env: cloneEnvironment(),
    timeoutMs: REMOTE_CLONE_TIMEOUT_MS,
  };
}

/**
 * Startup hygiene: a run's checkout, its clone staging, and its copy staging
 * never survive a restart, and a retained project is never touched. A transient
 * another live dashboard still owns is left alone: two dashboards can share one
 * `STATE_DIR`, and one starting must not delete the other's running checkout.
 */
export function cleanupRemoteScratch(scratchRoot: string): void {
  let entries;
  try {
    entries = readdirSync(scratchRoot, { withFileTypes: true });
  } catch {
    pruneScratchClaims(scratchRoot);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === RUN_CLAIM_DIRECTORY) continue;
    const directory = join(scratchRoot, entry.name);
    const transient = entry.name.startsWith(REMOTE_TRANSIENT_PREFIX);
    let checkout = false;
    try {
      checkout = existsSync(join(directory, ".git"));
    } catch {
      checkout = false;
    }
    if (!transient && !checkout) continue;
    if (transient && claimAlive(scratchRoot, entry.name)) continue;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A directory that cannot be removed is left for the next start.
    }
    releaseScratchEntry(scratchRoot, entry.name);
  }
  pruneScratchClaims(scratchRoot);
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
        stats = lstatSync(absolute);
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
 * How much of one regular file enters the hash at a time. The fingerprint never
 * holds a file in memory, so its largest allocation does not grow with the
 * largest host file.
 */
const FINGERPRINT_CHUNK = 256 * 1024;

/** One stat signature and digest per file; bounded so a huge host cannot grow it without limit. */
const FINGERPRINT_CACHE_MAX = 65536;

interface FileDigest {
  /** `lstat` facts that prove the cached digest is current. */
  signature: string;
  digest: string;
}

interface FingerprintDigest {
  /** The listing signature that produced the aggregate fingerprint. */
  signature: string;
  fingerprint: string;
}

interface HostEntry {
  path: string;
  absolute: string;
  /** `lstat` facts that change whenever the entry or its link target may have. */
  signature: string;
  kind: "file" | "symlink" | "special" | "missing";
  mode: number;
}

const fileDigests = new Map<string, FileDigest>();
const fingerprints = new Map<string, FingerprintDigest>();

/** One host entry's stat facts, taken without following a symlink or opening it. */
function hostEntry(repoDir: string, path: string): HostEntry {
  const absolute = join(repoDir, path);
  try {
    const stats = lstatSync(absolute);
    const signature = [stats.mode, stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino].join(":");
    const kind = stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "special";
    return { path, absolute, signature, kind, mode: stats.mode };
  } catch {
    return { path, absolute, signature: "missing", kind: "missing", mode: 0 };
  }
}

/**
 * The digest of one host entry, read only when its stat signature changed.
 *
 * A symlink contributes its target string and any other non-regular entry a
 * type marker: a FIFO, a device, or a symlink to one is never opened, so it can
 * neither block the read nor stream an unbounded device into the hash.
 */
function entryDigest(entry: HostEntry): string {
  const cached = fileDigests.get(entry.absolute);
  if (cached !== undefined && cached.signature === entry.signature) return cached.digest;
  let digest: string;
  if (entry.kind === "file") {
    try {
      digest = streamedContentHash(entry.absolute);
    } catch {
      digest = "unreadable";
    }
  } else if (entry.kind === "symlink") {
    let target: string;
    try {
      target = readlinkSync(entry.absolute);
    } catch {
      target = "unreadable";
    }
    digest = contentHash(Buffer.from(`symlink\u0000${target}`));
  } else if (entry.kind === "special") {
    digest = contentHash(Buffer.from(`special\u0000${entry.mode}`));
  } else {
    digest = "unreadable";
  }
  if (fileDigests.size >= FINGERPRINT_CACHE_MAX) {
    const oldest = fileDigests.keys().next().value;
    if (oldest !== undefined) fileDigests.delete(oldest);
  }
  fileDigests.set(entry.absolute, { signature: entry.signature, digest });
  return digest;
}

/**
 * A regular file's content digest, read in fixed-size chunks. `O_NONBLOCK`
 * covers the entry being replaced by a FIFO between `lstat` and `open`, so a
 * race can fail the read but never wait on it.
 */
function streamedContentHash(absolute: string): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(FINGERPRINT_CHUNK);
  const handle = openSync(absolute, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return digest.digest("hex");
}

/**
 * The host fingerprint: `HEAD`, plus the content of every tracked and untracked
 * non-ignored file outside the excluded directories. Two runs on an unchanged
 * host produce one fingerprint.
 *
 * The file part is cached: one digest per entry, keyed by its path and stat
 * signature, plus the aggregate fingerprint keyed by the whole listing. A
 * refresh on an unchanged host reads no file content and rehashes nothing; only
 * a listing change or a changed entry's stats invalidate the aggregate.
 */
export function hostFacts(repoDir: string): HostFacts {
  const entries = hostFiles(repoDir).map((path) => hostEntry(repoDir, path));
  const listing = createHash("sha256");
  for (const entry of entries) {
    listing.update(entry.path);
    listing.update("\u0000");
    listing.update(entry.signature);
    listing.update("\u0000");
  }
  const signature = listing.digest("hex");
  const cached = fingerprints.get(repoDir);
  let fingerprint: string;
  if (cached !== undefined && cached.signature === signature) {
    fingerprint = cached.fingerprint;
  } else {
    const digest = createHash("sha256");
    for (const entry of entries) {
      digest.update(entry.path);
      digest.update("\u0000");
      digest.update(entryDigest(entry));
      digest.update("\u0000");
    }
    fingerprint = digest.digest("hex");
    fingerprints.set(repoDir, { signature, fingerprint });
  }
  const commit = (gitOutput(repoDir, ["rev-parse", "--short=7", "HEAD"]) ?? "").trim();
  const status = gitOutput(repoDir, ["status", "--porcelain", "--untracked-files=all"]);
  return {
    fingerprint,
    commit,
    dirty: status === undefined ? false : dirtyLines(status).length > 0,
  };
}

// ------------------------------------------------------- glossary usage

/**
 * How often one glossary concept is used across the crawled host, and the
 * identifiers that name it. Derived from the published glossary and the host
 * files; never written back into an artifact.
 */
export interface ConceptUsage {
  /** Occurrences of the concept's preferred and alternate labels. */
  count: number;
  /** Distinct crawled files carrying at least one occurrence. */
  files: number;
  /** Representative identifiers from the host that name the concept. */
  examples: string[];
}

/** Usage keyed by bounded context, then concept id. */
export type GlossaryUsage = Record<string, Record<string, ConceptUsage>>;

const USAGE_FILE_MAX = 512 * 1024;
const USAGE_EXAMPLES_MAX = 8;
const USAGE_CACHE_MAX = 8;
const USAGE_IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

const usageCache = new Map<string, GlossaryUsage>();

/** Lower-case words of a label, punctuation removed, for matching code names. */
function usageWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}

/** Every spelling a label takes in prose and identifiers. */
function usageVariants(labels: string[]): string[] {
  const variants = new Set<string>();
  for (const label of labels) {
    const words = usageWords(label);
    if (words.length === 0) continue;
    const phrase = words.join(" ");
    if (phrase.length >= 2) variants.add(phrase);
    if (words.length > 1) {
      variants.add(words.join(""));
      variants.add(words.join("_"));
      variants.add(words.join("-"));
    }
  }
  return [...variants].sort((left, right) =>
    left.length === right.length ? left.localeCompare(right) : right.length - left.length,
  );
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

interface UsageFile {
  path: string;
  text: string;
  identifiers: string[];
}

function usageFiles(repoDir: string): UsageFile[] {
  const files: UsageFile[] = [];
  for (const path of hostFiles(repoDir)) {
    const absolute = join(repoDir, path);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size > USAGE_FILE_MAX) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch {
      continue;
    }
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    files.push({ path, text, identifiers: text.match(USAGE_IDENTIFIER) ?? [] });
  }
  return files;
}

function usageKey(repoDir: string, fingerprint: string, glossaries: Glossary[]): string {
  const shape = glossaries.map((glossary) => ({
    context: glossary.boundedContext,
    concepts: glossary.concepts.map((concept) => ({
      id: concept.id,
      labels: [...concept.prefLabels, ...concept.altLabels].map((label) => label.text),
      grounding: concept.grounding,
    })),
  }));
  return createHash("sha256")
    .update(repoDir)
    .update("\u0000")
    .update(fingerprint)
    .update("\u0000")
    .update(JSON.stringify(shape))
    .digest("hex");
}

/**
 * Counts each concept's usage across the host's documentation and source and
 * collects identifiers that name it. The scan reads the same files the
 * fingerprint covers: tracked and untracked non-ignored files, never
 * `.devboard/`, `.worktree/`, `.git/`, dependency caches, or published
 * Discover artifacts. Results are cached per host revision and glossary shape.
 */
export function glossaryUsage(
  repoDir: string,
  glossaries: Glossary[],
  fingerprint: string,
): GlossaryUsage {
  const key = usageKey(repoDir, fingerprint, glossaries);
  const cached = usageCache.get(key);
  if (cached !== undefined) return cached;

  const files = usageFiles(repoDir);
  const usage: GlossaryUsage = {};
  for (const glossary of glossaries) {
    const contexts: Record<string, ConceptUsage> = {};
    for (const concept of glossary.concepts) {
      const labels = [...concept.prefLabels, ...concept.altLabels].map((label) => label.text);
      const variants = usageVariants(labels);
      const wordSets = labels
        .map(usageWords)
        .filter((words) => words.length > 0)
        .map((words) => ({ words, compact: words.join("") }));
      const grounding = new Set(
        concept.grounding
          .filter((entry) => entry.startsWith("code:"))
          .map((entry) => entry.slice("code:".length)),
      );

      let count = 0;
      let occurrencesInFiles = 0;
      const examples = new Map<string, { count: number; grounded: boolean }>();
      for (const entry of files) {
        const text = entry.text.toLowerCase();
        let inFile = 0;
        for (const variant of variants) inFile += countOccurrences(text, variant);
        if (inFile > 0) {
          count += inFile;
          occurrencesInFiles += 1;
        }
        if (wordSets.length === 0) continue;
        const grounded = grounding.has(entry.path);
        for (const name of entry.identifiers) {
          if (name.length < 3 || name.length > 80) continue;
          const lower = name.toLowerCase();
          const matches = wordSets.some(({ words, compact }) =>
            words.length === 1
              ? lower.includes(words[0] ?? "")
              : words.every((word) => lower.includes(word)) || lower.includes(compact),
          );
          if (!matches) continue;
          const previous = examples.get(name);
          examples.set(name, {
            count: (previous?.count ?? 0) + 1,
            grounded: (previous?.grounded ?? false) || grounded,
          });
        }
      }

      for (const entry of concept.grounding) {
        if (!entry.startsWith("model:")) continue;
        const name = entry.slice("model:".length);
        const previous = examples.get(name);
        examples.set(name, { count: previous?.count ?? 0, grounded: true });
      }

      const ranked = [...examples.entries()]
        .sort(([leftName, left], [rightName, right]) =>
          left.grounded === right.grounded
            ? left.count === right.count
              ? leftName.localeCompare(rightName)
              : right.count - left.count
            : left.grounded
              ? -1
              : 1,
        )
        .slice(0, USAGE_EXAMPLES_MAX)
        .map(([name]) => name);

      contexts[concept.id] = {
        count,
        files: occurrencesInFiles,
        examples: ranked,
      };
    }
    usage[glossary.boundedContext] = contexts;
  }

  usageCache.set(key, usage);
  while (usageCache.size > USAGE_CACHE_MAX) {
    const oldest = usageCache.keys().next().value;
    if (oldest === undefined) break;
    usageCache.delete(oldest);
  }
  return usage;
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
  // An absolute host path with its leading slash stripped. The segments may
  // name a directory anywhere else in a legitimate repository-relative path.
  if (/^(?:home|Users)\//.test(text)) invalid(path, "must not carry an absolute host path");
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

const ROUTE_METHOD_PATTERN = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT)\s+/;
// A route path starts with `/`; only its host-home form is a leaked absolute
// path. `/home` alone stays a legitimate route.
const ROUTE_HOST_PATH_PATTERN = /^\/(?:home|Users)\/[^/]+(?:\/|$)/;

/**
 * One HTTP route, optionally prefixed with its method. Unlike a repository
 * path, a route's leading `/` is the fact itself, so it is not an absolute
 * host path; a home-directory absolute path still is.
 */
function routeText(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  const text = value.trim();
  if (text.length === 0) invalid(path, "must not be empty");
  if (!singleLine(text)) invalid(path, "must be a single line");
  if (text.length > CELL_MAX) invalid(path, `must be at most ${CELL_MAX} characters`);
  if (text.includes("://")) invalid(path, "must not be a URL");
  const route = text.replace(ROUTE_METHOD_PATTERN, "");
  if (route.startsWith("~")) invalid(path, "must not carry a home directory");
  if (route.startsWith("//") || route.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(route)) {
    invalid(path, "must not carry an absolute host path");
  }
  if (ROUTE_HOST_PATH_PATTERN.test(route)) invalid(path, "must not carry an absolute host path");
  if (route.split("/").includes("..")) invalid(path, "must stay inside the host");
  if (hasSecret(text)) invalid(path, "must not carry a secret value");
  return text;
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

function leafRoutes(node: unknown, path: string): Leaf {
  const base = leafBase(node, path);
  if (base.confidence === "unknown") return { value: null, ...base };
  const record = node as Record<string, unknown>;
  if (!Array.isArray(record.value)) invalid(`${path}.value`, "must be a list of strings");
  if (record.value.length > LIST_MAX) invalid(`${path}.value`, "has too many entries");
  const values = [
    ...new Set(record.value.map((entry, index) => routeText(entry, `${path}.value[${index}]`))),
  ].sort();
  return { value: values, ...base };
}

/**
 * Required CI checks, each with the line describing what it verifies.
 *
 * Sheets published before a gate carried its check stored gate names only;
 * accept that shape and read it as a gate with no recorded check so a host
 * keeps its Discover artifacts across the upgrade.
 */
function leafQualityGates(node: unknown, path: string): Leaf {
  const base = leafBase(node, path);
  if (base.confidence === "unknown") return { value: null, ...base };
  const record = node as Record<string, unknown>;
  if (!Array.isArray(record.value)) invalid(`${path}.value`, "must be a list");
  if (record.value.length > LIST_MAX) invalid(`${path}.value`, "has too many entries");
  const gates = new Map<string, { name: string; checks: string }>();
  for (const [index, entry] of record.value.entries()) {
    const entryPath = `${path}.value[${index}]`;
    const gate = typeof entry === "string"
      ? { name: textValue(entry, entryPath), checks: "" }
      : recordFields(entry, entryPath, { name: textValue, checks: textValue }) as {
        name: string;
        checks: string;
      };
    if (gates.has(gate.name)) invalid(`${entryPath}.name`, "must be unique");
    gates.set(gate.name, gate);
  }
  return {
    value: [...gates.values()].sort((left, right) => left.name.localeCompare(right.name)),
    ...base,
  };
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
  optional: Record<string, (value: unknown, fieldPath: string) => unknown> = {},
): Record<string, unknown> {
  if (!isRecord(entry)) invalid(path, "must be an object");
  const known = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const key of Object.keys(entry)) {
    if (!known.has(key)) invalid(`${path}.${key}`, "is not a declared field");
  }
  const result: Record<string, unknown> = {};
  for (const [key, validate] of Object.entries(required)) {
    const value = entry[key];
    if (value === undefined) invalid(`${path}.${key}`, "is required");
    result[key] = validate(value, `${path}.${key}`);
  }
  for (const [key, validate] of Object.entries(optional)) {
    const value = entry[key];
    if (value === undefined) continue;
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
  optionalFields: Record<string, (node: unknown, path: string) => Leaf> = {},
): Record<string, Leaf> {
  const section = sheetSection(raw, key, key);
  const known = new Set([...Object.keys(fields), ...Object.keys(optionalFields)]);
  for (const field of Object.keys(section)) {
    if (!known.has(field)) invalid(`${key}.${field}`, "is not a declared field");
  }
  const result: Record<string, Leaf> = {};
  for (const [field, validate] of Object.entries(fields)) {
    if (section[field] === undefined) invalid(`${key}.${field}`, "is required");
    result[field] = validate(section[field], `${key}.${field}`);
  }
  for (const [field, validate] of Object.entries(optionalFields)) {
    if (section[field] === undefined) continue;
    result[field] = validate(section[field], `${key}.${field}`);
  }
  return result;
}

function commandLeaf(entry: unknown, path: string): Leaf {
  return leafText(entry, path);
}

/**
 * Rejects an architecture dependency graph that points anywhere but at the
 * bounded contexts the same sheet records. Edges are directed: `from` depends
 * on `to`.
 */
function validateDependencyEdges(architecture: Record<string, Leaf>): void {
  const dependencies = architecture.dependencies;
  if (dependencies === undefined || dependencies.confidence === "unknown") return;
  const contextLeaf = architecture.contexts;
  if (contextLeaf === undefined) return;
  const contextRecords = Array.isArray(contextLeaf.value)
    ? contextLeaf.value.filter(isRecord)
    : [];
  const names = new Set(contextRecords.map((context) => String(context.name)));
  const edgeRecords = Array.isArray(dependencies.value) ? dependencies.value : [];
  const seen = new Set<string>();
  for (const [index, record] of edgeRecords.entries()) {
    if (!isRecord(record) || typeof record.from !== "string" || typeof record.to !== "string") {
      invalid(`architecture.dependencies.value[${index}]`, "must carry a from and a to context");
    }
    const { from, to } = record;
    if (from === to) {
      invalid(`architecture.dependencies.value[${index}].to`, "must differ from the source context");
    }
    for (const [field, name] of [["from", from], ["to", to]] as const) {
      if (!names.has(name)) {
        invalid(
          `architecture.dependencies.value[${index}].${field}`,
          `must name a bounded context; "${name}" is not one`,
        );
      }
    }
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) {
      invalid(
        `architecture.dependencies.value[${index}]`,
        `repeats the dependency ${from} -> ${to}`,
      );
    }
    seen.add(key);
  }
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

  const architecture = validateSectionRecord(
    raw,
    "architecture",
    {
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
    },
    {
      // Optional so a sheet published before the dependency graph existed
      // still loads; the current prompt records it for every crawl.
      dependencies: (node, path) =>
        leafRecords(
          node,
          path,
          (entry, entryPath) =>
            recordFields(entry, entryPath, {
              from: textValue,
              to: textValue,
            }),
          (entry) => `${String((entry as { from: string }).from)}\u0000${String((entry as { to: string }).to)}`,
        ),
    },
  );
  validateDependencyEdges(architecture);

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
          (entry, entryPath) => {
            const record = recordFields(
              entry,
              entryPath,
              {
                level: (value, fieldPath) => {
                  if (
                    typeof value !== "string" ||
                    !(TEST_LEVELS as readonly string[]).includes(value)
                  ) {
                    invalid(fieldPath, `must be one of ${TEST_LEVELS.join(", ")}`);
                  }
                  return value;
                },
                tests: textValue,
                paths: recordTexts,
                command: textValue,
                fixtures: recordTexts,
              },
              // Optional so a sheet staged by an older prompt still validates;
              // the current prompt records the count for every level.
              { happyPath: textValue },
            );
            const tests = Number.parseInt(String(record.tests), 10);
            const happy = Number.parseInt(String(record.happyPath ?? ""), 10);
            if (Number.isFinite(tests) && Number.isFinite(happy) && happy > tests) {
              invalid(`${entryPath}.happyPath`, "must not exceed the level's test count");
            }
            return record;
          },
          (entry) => String((entry as { level: string }).level),
        ),
      pyramid: leafText,
    }),
    architecture,
    ci: validateSectionRecord(raw, "ci", {
      provider: leafText,
      triggers: leafTexts,
      jobs: leafTexts,
      qualityGates: leafQualityGates,
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
      routes: leafRoutes,
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

/**
 * A recorded command paired with the installed invocation that runs it.
 *
 * The crawl reads programs, so it stages `node --test test/*.test.js` even when
 * the manifest declares `"test": "node --test test/*.test.js"`. The operator
 * reads the manifest's invocation. This derivation keeps the recorded evidence
 * untouched and maps each script body to the command that runs it: `npm test`
 * for the `test` script and `npm run <name>` for every other script.
 */
export function declaredCommandAliases(root: string): Array<{ command: string; alias: string }> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(manifest) || !isRecord(manifest.scripts)) return [];
  const scripts = manifest.scripts;
  const aliases = new Map<string, string>();
  const names = Object.keys(scripts).sort((left, right) => {
    if (left === "test") return -1;
    if (right === "test") return 1;
    return left.localeCompare(right);
  });
  for (const name of names) {
    const body = scripts[name];
    if (typeof body !== "string") continue;
    const command = body.replace(/\s+/g, " ").trim();
    if (command.length === 0 || aliases.has(command)) continue;
    aliases.set(command, name === "test" ? "npm test" : `npm run ${name}`);
  }
  return [...aliases]
    .map(([command, alias]) => ({ command, alias }))
    .sort((left, right) => left.command.localeCompare(right.command));
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
  trustGrounding: boolean,
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
      if (!trustGrounding && !existsSync(absolute)) {
        invalid(`${path}[${index}]`, `names ${target}, which the host does not carry`);
      }
    } else if (text.startsWith("model:")) {
      const name = text.slice("model:".length);
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
        invalid(`${path}[${index}]`, "must name a model element");
      }
      if (!trustGrounding && !modelNameExists(context, name)) {
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

function conceptValue(
  raw: unknown,
  path: string,
  context: { repoDir: string; files: string[] },
  trustGrounding: boolean,
): Concept {
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
  const grounding = groundingList(raw.grounding, `${path}.grounding`, context, trustGrounding);
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
  options: { staged: boolean; trustGrounding?: boolean },
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
    conceptValue(entry, `${source}:concepts[${index}]`, context, options.trustGrounding === true),
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

// ----------------------------------------------------------- significance

/** One crawl-authored significance judgment for a single concept. */
export interface ConceptSignificance {
  score: number;
  reason: string;
}

/** Significance keyed by bounded context, then concept id. */
export type GlossarySignificance = Record<string, Record<string, ConceptSignificance>>;

export function significancePath(repoDir: string): string {
  return join(discoverRoot(repoDir), "significance.json");
}

/**
 * Validates the staged significance sidecar against the staged glossaries.
 * Names must match exactly: a missing or extra context or concept fails, and
 * so does an entry that is not an integer score with one line of evidence.
 */
export function parseSignificance(
  raw: unknown,
  path: string,
  glossaries: Glossary[],
): GlossarySignificance {
  if (!isRecord(raw)) invalid(path, "must be an object");
  for (const key of Object.keys(raw)) {
    if (!(SIGNIFICANCE_CONTEXT_KEYS as readonly string[]).includes(key)) {
      invalid(path, `carries an undeclared key ${key}`);
    }
  }
  if (raw.schemaVersion !== SIGNIFICANCE_SCHEMA_VERSION) {
    invalid(path, `schemaVersion must be ${SIGNIFICANCE_SCHEMA_VERSION}`);
  }
  const contexts = raw.contexts;
  if (!isRecord(contexts)) invalid(`${path}.contexts`, "must be an object");

  const staged = new Map(glossaries.map((glossary) => [glossary.boundedContext, glossary]));
  for (const context of Object.keys(contexts)) {
    if (!staged.has(context)) invalid(`${path}.contexts`, `names the unknown context ${context}`);
  }

  const parsed: GlossarySignificance = {};
  for (const glossary of glossaries) {
    const context = glossary.boundedContext;
    const entries = contexts[context];
    if (!isRecord(entries)) invalid(`${path}.contexts`, `has no entry for ${context}`);
    const ids = new Set(glossary.concepts.map((concept) => concept.id));
    for (const id of Object.keys(entries)) {
      if (!ids.has(id)) {
        invalid(`${path}.contexts.${context}`, `names the unknown concept ${id}`);
      }
    }
    const scored: Record<string, ConceptSignificance> = {};
    for (const id of [...ids].sort()) {
      const entry = entries[id];
      const trail = `${path}.contexts.${context}.${id}`;
      if (!isRecord(entry)) invalid(trail, "must be an object");
      for (const key of Object.keys(entry)) {
        if (!(SIGNIFICANCE_ENTRY_KEYS as readonly string[]).includes(key)) {
          invalid(trail, `carries an undeclared key ${key}`);
        }
      }
      const score = entry.score;
      if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
        invalid(`${trail}.score`, "must be an integer from 0 to 100");
      }
      const reason = entry.reason;
      if (typeof reason !== "string") invalid(`${trail}.reason`, "must be a string");
      const text = reason.trim();
      if (text.length === 0) invalid(`${trail}.reason`, "must not be empty");
      if (!singleLine(text)) invalid(`${trail}.reason`, "must be one line");
      if (text.length > SIGNIFICANCE_REASON_MAX) {
        invalid(`${trail}.reason`, `must be at most ${SIGNIFICANCE_REASON_MAX} characters`);
      }
      if (ABSOLUTE_PATH_PATTERN.test(text)) {
        invalid(`${trail}.reason`, "must not be an absolute path");
      }
      if (hasSecret(text)) invalid(`${trail}.reason`, "must not carry a secret");
      scored[id] = { score, reason: text };
    }
    parsed[context] = scored;
  }
  return parsed;
}

/**
 * Reads a published sidecar, keeping only a score and reason that apply to a
 * published concept. A legacy manifest publishes no significance, and a
 * concept preserved from a human decision is published unscored.
 */
function readSignificance(
  repoDir: string,
  relativePath: string,
  glossaries: Glossary[],
): GlossarySignificance {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(repoDir, relativePath), "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(raw) || raw.schemaVersion !== SIGNIFICANCE_SCHEMA_VERSION) return {};
  const contexts = isRecord(raw.contexts) ? raw.contexts : {};
  const published: GlossarySignificance = {};
  for (const glossary of glossaries) {
    const entries = contexts[glossary.boundedContext];
    if (!isRecord(entries)) continue;
    const scored: Record<string, ConceptSignificance> = {};
    for (const concept of glossary.concepts) {
      const entry = entries[concept.id];
      if (!isRecord(entry)) continue;
      const score = entry.score;
      const reason = entry.reason;
      if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
        continue;
      }
      if (typeof reason !== "string" || reason.trim().length === 0) continue;
      scored[concept.id] = { score, reason: reason.trim() };
    }
    if (Object.keys(scored).length > 0) published[glossary.boundedContext] = scored;
  }
  return published;
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
  const contribution = name === "discover-contribution";
  if (contribution) {
    if (role !== "contribution") {
      invalid(`${path}:metadata.${SKILL_MARKER}`, 'must equal "contribution"');
    }
    const sentences = description.match(/[.!?](?=\s|$)/g) ?? [];
    if (!/[.!?]$/.test(description) || sentences.length !== 1) {
      invalid(`${path}:description`, "must be one sentence");
    }
  }
  if (hasSecret(description) || hasSecret(role) || hasSecret(body)) {
    invalid(path, "must not carry a secret value");
  }
  if (containsAbsoluteHostPath(body)) invalid(path, "must not carry an absolute host path");
  if (body.trim().length === 0) invalid(path, "must carry a body");
  const lines = body.split("\n");
  if (contribution) {
    const first = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
    if (!/^# \S/.test(first)) invalid(path, "body must open with one # heading");
  }
  let bullets = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (contribution && (line.startsWith("> ") || line === ">")) continue;
    if (!/^[-*+]\s+/.test(line.trimStart())) {
      invalid(path, "body prose must be imperative bullets, not paragraphs");
    }
    bullets += 1;
  }
  if (bullets === 0) invalid(path, "must carry at least one imperative bullet");
  if (contribution && body.includes(">") && !/^## Exemplars\s*$/m.test(body)) {
    invalid(path, "quoted exemplars must follow a ## Exemplars heading");
  }
  return { name: name as DiscoverSkillName, text, body };
}

// ---------------------------------------------------------- contribution

/**
 * The Contribution Agent's slice. It stages raw evidence only: the repository
 * workflow and testing facts, and the merged and closed-unmerged pull requests
 * it read from the forge. The server derives every profile section from that
 * evidence, so a style or size statistic can never be computed from a closed
 * pull request and no number reaches the page without a recorded source.
 */

export const CONTRIBUTION_SECTION_IDS = [
  "workflow",
  "testing",
  "pull-request-style",
  "pull-request-size",
  "conventions",
  "review",
  "documentation",
  "hotspots",
  "evidence",
] as const;

export type ContributionSectionId = (typeof CONTRIBUTION_SECTION_IDS)[number];
export type ContributionConfidence = (typeof CONFIDENCES)[number];

export interface ContributionFact {
  key: string;
  label: string;
  value?: unknown;
  evidence: string[];
  confidence: ContributionConfidence;
  reason?: string;
}

export interface ContributionSection {
  id: ContributionSectionId;
  label: string;
  facts: ContributionFact[];
}

export interface ContributionSample {
  number: number;
  title: string;
  body: string;
}

export interface Contribution {
  schemaVersion: number;
  freshness: Freshness;
  sections: ContributionSection[];
  sample: ContributionSample[];
}

const CONTRIBUTION_SECTION_LABELS: Record<ContributionSectionId, string> = {
  workflow: "Workflow",
  testing: "Testing",
  "pull-request-style": "Pull request style",
  "pull-request-size": "Pull request size",
  conventions: "Conventions",
  review: "Review",
  documentation: "Documentation",
  hotspots: "Hotspots",
  evidence: "Evidence",
};

const CONTRIBUTION_FACT_LABELS: Record<ContributionSectionId, Record<string, string>> = {
  workflow: {
    entryPoints: "Contribution entry points",
    steps: "Contribution steps",
    prerequisites: "Prerequisites",
    install: "Install",
    build: "Build",
    lint: "Lint",
    typecheck: "Typecheck",
    run: "Run",
  },
  testing: {
    suite: "Whole suite",
    levels: "Test levels",
  },
  "pull-request-style": {
    titlePatterns: "Title patterns",
    titleWords: "Title words",
    bodyHeadings: "Body section headings",
    bodyWords: "Body words",
    bodyLines: "Body lines",
    bulletRatio: "Bullet lines",
    voice: "Voice and tense",
    vocabulary: "Vocabulary",
    issueLinking: "Issue linking",
    templates: "Templates",
    granularity: "Change granularity",
  },
  "pull-request-size": {
    additions: "Additions",
    deletions: "Deletions",
    filesChanged: "Files changed",
    testFileShare: "Test-file share",
    largest: "Largest accepted pull request",
    testsShare: "Pull requests that change tests",
    documentationShare: "Pull requests that change documentation",
    testsAndDocumentationShare: "Pull requests that change tests and documentation",
  },
  conventions: {
    commitSubject: "Commit subjects",
    commitBody: "Commit bodies",
    branchNaming: "Branch naming",
    mergeMethod: "Merge method",
    issueReferences: "Issue references",
  },
  review: {
    requiredApprovals: "Required approvals",
    requiredChecks: "Required checks",
    labels: "Labels",
    draftUsage: "Draft usage",
    mergeMethod: "Merge method",
  },
  documentation: {
    documentationShare: "Documentation changes",
    changelogShare: "Changelog changes",
    convention: "Documentation convention",
  },
  hotspots: {
    directories: "Directories",
    files: "Files",
    typicalFiles: "Typical file set",
  },
  evidence: {
    forge: "Forge",
    host: "Host",
    sampleSize: "Merged sample size",
    window: "Merge window",
    closedUnmerged: "Closed, unmerged pull requests",
    unknownFacts: "Unknown facts",
  },
};

const WORKFLOW_FACT_KEYS = Object.keys(CONTRIBUTION_FACT_LABELS.workflow);
const TESTING_FACT_KEYS = Object.keys(CONTRIBUTION_FACT_LABELS.testing);
const CONTRIBUTION_STAGED_KEYS = ["schemaVersion", "source", "workflow", "testing"];
const CONTRIBUTION_SOURCE_KEYS = [
  "forge",
  "host",
  "unavailable",
  "window",
  "mergedPullRequests",
  "closedUnmergedPullRequests",
];
const MERGED_PR_KEYS = [
  "number",
  "title",
  "body",
  "mergedAt",
  "additions",
  "deletions",
  "filesChanged",
  "files",
  "testFiles",
  "documentationFiles",
  "labels",
  "draft",
  "approvals",
  "checks",
  "commits",
  "branch",
  "mergeMethod",
  "references",
];
const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
const MERGED_SAMPLE_MAX = 50;
const CONTRIBUTION_BODY_MAX = 20_000;
const CONTRIBUTION_TITLE_MAX = 300;
const CONTRIBUTION_REASON_MAX = 200;

/** A fact before its label is assigned from the fixed section map. */
interface ParsedFact {
  key: string;
  value?: unknown;
  evidence: string[];
  confidence: ContributionConfidence;
  reason?: string;
}

interface MergedPullRequest {
  number: number;
  title: string;
  body: string;
  mergedAt: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  files: string[];
  testFiles: number;
  documentationFiles: number;
  labels: string[];
  draft: boolean;
  approvals: number;
  checks: string[];
  commits: Array<{ subject: string; body: string }>;
  branch: string;
  mergeMethod: (typeof MERGE_METHODS)[number];
  references: number[];
}

export interface ContributionSource {
  forge: "github" | "gitlab" | "gitea" | null;
  host: string | null;
  unavailable: string | null;
  window: { from: string; to: string } | null;
  merged: MergedPullRequest[];
  closedUnmerged: number[];
}

interface StagedContribution {
  source: ContributionSource;
  workflow: ParsedFact[];
  testing: ParsedFact[];
}

function contributionString(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  if (value.length > max) invalid(path, `must be at most ${max} characters`);
  if (hasSecret(value)) invalid(path, "must not carry a secret value");
  if (containsAbsoluteHostPath(value)) invalid(path, "must not carry an absolute host path");
  return value;
}

function containsAbsoluteHostPath(text: string): boolean {
  if (ABSOLUTE_PATH_PATTERN.test(text)) return true;
  if (/(?:^|[\s"'(=:])\/(?:home|Users|etc|var|tmp|opt|usr|root|private)\/[^\s]*/.test(text)) {
    return true;
  }
  if (/[A-Za-z]:[\\/]/.test(text)) return true;
  return /(?:^|[\s"'(=:])\\\\[^\s]+/.test(text);
}

function contributionLine(value: unknown, path: string, max: number): string {
  const text = contributionString(value, path, max);
  if (!singleLine(text)) invalid(path, "must be a single line");
  const trimmed = text.trim();
  if (trimmed.length === 0) invalid(path, "must not be empty");
  return trimmed;
}

/** Evidence is repository-relative, a pull request, a commit, or a git query. */
function contributionEvidence(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, "must be a list of evidence entries");
  if (value.length > EVIDENCE_MAX) invalid(path, `must carry at most ${EVIDENCE_MAX} entries`);
  const entries = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const text = contributionLine(entry, `${path}[${index}]`, CELL_MAX);
    const fixed =
      text === "git log" ||
      text === "git status" ||
      text === "git branch" ||
      text === "git ls-files" ||
      text === "forge records" ||
      /^PR #[1-9][0-9]*$/.test(text) ||
      /^commit [0-9a-f]{7,40}$/.test(text);
    if (!fixed) {
      if (text.includes("://")) invalid(`${path}[${index}]`, "must not be a URL");
      if (text.split("/").includes("..")) invalid(`${path}[${index}]`, "must stay inside the host");
      if (
        text === ".omp" ||
        text === ".git" ||
        text === ".devboard" ||
        text === ".worktree" ||
        /^(?:\.omp|\.git|\.devboard|\.worktree)\//.test(text)
      ) {
        invalid(`${path}[${index}]`, "must not cite an excluded crawl path");
      }
    }
    entries.add(text);
  }
  return [...entries].sort();
}

function contributionRecord(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${path}.${key}`, "is not part of this record");
  }
  return value;
}

function contributionInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid(path, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function contributionStringList(value: unknown, path: string, max = LIST_MAX): string[] {
  if (!Array.isArray(value)) invalid(path, "must be a list");
  if (value.length > max) invalid(path, `must carry at most ${max} entries`);
  const entries = value.map((entry, index) =>
    contributionLine(entry, `${path}[${index}]`, CELL_MAX),
  );
  return [...new Set(entries)].sort();
}

function contributionNumberList(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) invalid(path, "must be a list of numbers");
  const numbers = value.map((entry, index) =>
    contributionInteger(entry, `${path}[${index}]`, 1, 1_000_000_000),
  );
  return [...new Set(numbers)].sort((left, right) => left - right);
}

function contributionTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(path, "must be an ISO timestamp");
  const time = Date.parse(value);
  if (Number.isNaN(time)) invalid(path, "must be an ISO timestamp");
  return new Date(time).toISOString();
}

function contributionBody(value: unknown, path: string): string {
  if (typeof value !== "string") invalid(path, "must be a string");
  const text = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (text.length > CONTRIBUTION_BODY_MAX) {
    invalid(path, `must be at most ${CONTRIBUTION_BODY_MAX} characters`);
  }
  if (hasSecret(text)) invalid(path, "must not carry a secret value");
  if (containsAbsoluteHostPath(text)) invalid(path, "must not carry an absolute host path");
  return text;
}

function contributionFilePath(value: unknown, path: string): string {
  const text = contributionLine(value, path, 512);
  if (
    text === ".omp" ||
    text === ".git" ||
    text === ".devboard" ||
    text === ".worktree" ||
    /^(?:\.omp|\.git|\.devboard|\.worktree)\//.test(text)
  ) {
    invalid(path, "must not cite an excluded crawl path");
  }
  if (text.split("/").includes("..")) invalid(path, "must stay inside the host");
  return text;
}

function parseMergedPullRequest(value: unknown, index: number): MergedPullRequest {
  const path = `source.mergedPullRequests[${index}]`;
  const raw = contributionRecord(value, path, MERGED_PR_KEYS);
  const filesChanged = contributionInteger(raw.filesChanged, `${path}.filesChanged`, 0, 100_000);
  if (!Array.isArray(raw.files)) invalid(`${path}.files`, "must be a list of paths");
  if (raw.files.length !== filesChanged) {
    invalid(`${path}.files`, "must list exactly filesChanged paths");
  }
  const files = [...new Set(
    raw.files.map((entry, fileIndex) =>
      contributionFilePath(entry, `${path}.files[${fileIndex}]`),
    ),
  )].sort();
  if (files.length !== filesChanged) invalid(`${path}.files`, "must not repeat a path");
  const testFiles = contributionInteger(raw.testFiles, `${path}.testFiles`, 0, filesChanged);
  const documentationFiles = contributionInteger(
    raw.documentationFiles,
    `${path}.documentationFiles`,
    0,
    filesChanged,
  );
  if (!Array.isArray(raw.commits)) invalid(`${path}.commits`, "must be a list");
  if (raw.commits.length > LIST_MAX) invalid(`${path}.commits`, "must carry at most 64 commits");
  const commits = raw.commits.map((entry, commitIndex) => {
    const commitPath = `${path}.commits[${commitIndex}]`;
    const record = contributionRecord(entry, commitPath, ["subject", "body"]);
    return {
      subject: contributionLine(record.subject, `${commitPath}.subject`, CONTRIBUTION_TITLE_MAX),
      body: contributionBody(record.body, `${commitPath}.body`),
    };
  });
  const mergeMethod = contributionLine(raw.mergeMethod, `${path}.mergeMethod`, 16);
  if (!(MERGE_METHODS as readonly string[]).includes(mergeMethod)) {
    invalid(`${path}.mergeMethod`, "must be merge, squash, or rebase");
  }
  if (typeof raw.draft !== "boolean") invalid(`${path}.draft`, "must be a boolean");
  return {
    number: contributionInteger(raw.number, `${path}.number`, 1, 1_000_000_000),
    title: contributionLine(raw.title, `${path}.title`, CONTRIBUTION_TITLE_MAX),
    body: contributionBody(raw.body, `${path}.body`),
    mergedAt: contributionTimestamp(raw.mergedAt, `${path}.mergedAt`),
    additions: contributionInteger(raw.additions, `${path}.additions`, 0, 100_000_000),
    deletions: contributionInteger(raw.deletions, `${path}.deletions`, 0, 100_000_000),
    filesChanged,
    files,
    testFiles,
    documentationFiles,
    labels: contributionStringList(raw.labels, `${path}.labels`),
    draft: raw.draft,
    approvals: contributionInteger(raw.approvals, `${path}.approvals`, 0, 1_000),
    checks: contributionStringList(raw.checks, `${path}.checks`),
    commits,
    branch: contributionLine(raw.branch, `${path}.branch`, 200),
    mergeMethod: mergeMethod as MergedPullRequest["mergeMethod"],
    references: contributionNumberList(raw.references, `${path}.references`),
  };
}

function contributionWindow(merged: MergedPullRequest[]): { from: string; to: string } {
  const times = merged.map((pullRequest) => Date.parse(pullRequest.mergedAt)).sort((a, b) => a - b);
  return {
    from: new Date(times[0] as number).toISOString(),
    to: new Date(times[times.length - 1] as number).toISOString(),
  };
}

function parseContributionSource(value: unknown): ContributionSource {
  const raw = contributionRecord(value, "source", CONTRIBUTION_SOURCE_KEYS);
  const forge = raw.forge;
  if (forge !== null && forge !== "github" && forge !== "gitlab" && forge !== "gitea") {
    invalid("source.forge", "must be github, gitlab, gitea, or null");
  }
  const host = raw.host === null ? null : contributionLine(raw.host, "source.host", 200);
  const unavailable =
    raw.unavailable === null
      ? null
      : contributionLine(raw.unavailable, "source.unavailable", CONTRIBUTION_REASON_MAX);
  if (!Array.isArray(raw.mergedPullRequests)) {
    invalid("source.mergedPullRequests", "must be a list");
  }
  if (raw.mergedPullRequests.length > MERGED_SAMPLE_MAX) {
    invalid("source.mergedPullRequests", `must carry at most ${MERGED_SAMPLE_MAX} pull requests`);
  }
  const merged = raw.mergedPullRequests.map(parseMergedPullRequest);
  const numbers = new Set<number>();
  for (const [index, pullRequest] of merged.entries()) {
    if (numbers.has(pullRequest.number)) {
      invalid(`source.mergedPullRequests[${index}].number`, "must be unique");
    }
    numbers.add(pullRequest.number);
  }
  const closedUnmerged = contributionNumberList(
    raw.closedUnmergedPullRequests,
    "source.closedUnmergedPullRequests",
  );
  if (closedUnmerged.some((number) => numbers.has(number))) {
    invalid("source.closedUnmergedPullRequests", "must not repeat a merged pull request");
  }
  let window: ContributionSource["window"] = null;
  if (raw.window !== null) {
    const record = contributionRecord(raw.window, "source.window", ["from", "to"]);
    window = {
      from: contributionTimestamp(record.from, "source.window.from"),
      to: contributionTimestamp(record.to, "source.window.to"),
    };
  }
  if (unavailable !== null) {
    if (merged.length > 0 || closedUnmerged.length > 0) {
      invalid("source.unavailable", "must accompany empty pull-request lists");
    }
    if (window !== null) invalid("source.window", "must be null when the forge was unavailable");
    if (host !== null) invalid("source.host", "must be null when the forge was unavailable");
    if (forge !== null) invalid("source.forge", "must be null when the forge was unavailable");
  }
  if (merged.length > 0) {
    if (forge === null) invalid("source.forge", "must name the forge that supplied the sample");
    if (host === null) invalid("source.host", "must name the host that supplied the sample");
    const computed = contributionWindow(merged);
    if (window === null || window.from !== computed.from || window.to !== computed.to) {
      invalid("source.window", "must span the merged sample's merge times");
    }
  }
  return { forge, host, unavailable, window, merged, closedUnmerged };
}

function validateContributionValue(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "must be a finite number");
    return;
  }
  if (typeof value === "string") {
    contributionString(value, path, CONTRIBUTION_BODY_MAX);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > LIST_MAX) invalid(path, `must carry at most ${LIST_MAX} entries`);
    for (const [index, entry] of value.entries()) {
      validateContributionValue(entry, `${path}[${index}]`);
    }
    return;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 16) invalid(path, "must carry at most 16 keys");
    for (const key of keys) {
      if (!SKILL_NAME_PATTERN.test(key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())) {
        invalid(`${path}.${key}`, "must be a camelCase field name");
      }
      validateContributionValue(value[key], `${path}.${key}`);
    }
    return;
  }
  invalid(path, "must be a JSON value");
}

function parseContributionFact(value: unknown, path: string, key: string): ParsedFact {
  const raw = contributionRecord(value, path, ["key", "value", "evidence", "confidence", "reason"]);
  if (raw.key !== key) invalid(`${path}.key`, `must be ${key}`);
  const confidence = raw.confidence;
  if (typeof confidence !== "string" || !(CONFIDENCES as readonly string[]).includes(confidence)) {
    invalid(`${path}.confidence`, "must be observed, declared, inferred, or unknown");
  }
  const evidence = contributionEvidence(raw.evidence, `${path}.evidence`);
  const declaredConfidence = confidence as ContributionConfidence;
  if (declaredConfidence === "unknown") {
    if (Object.hasOwn(raw, "value")) invalid(`${path}.value`, "must be absent on an unknown fact");
    if (evidence.length > 0) invalid(`${path}.evidence`, "must be empty on an unknown fact");
    const reason = contributionLine(raw.reason, `${path}.reason`, CONTRIBUTION_REASON_MAX);
    return { key, evidence, confidence: declaredConfidence, reason };
  }
  if (!Object.hasOwn(raw, "value")) invalid(`${path}.value`, "must be present on a known fact");
  if (evidence.length === 0) invalid(`${path}.evidence`, "must ground a known fact");
  if (Object.hasOwn(raw, "reason")) invalid(`${path}.reason`, "belongs only to an unknown fact");
  validateContributionValue(raw.value, `${path}.value`);
  return { key, value: raw.value, evidence, confidence: declaredConfidence };
}

function parseContributionFacts(
  value: unknown,
  section: "workflow" | "testing",
  keys: readonly string[],
): ParsedFact[] {
  if (!Array.isArray(value)) invalid(section, "must be a list of facts");
  const byKey = new Map<string, unknown>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) invalid(`${section}[${index}]`, "must be a fact object");
    const key = entry.key;
    if (typeof key !== "string" || !keys.includes(key)) {
      invalid(`${section}[${index}].key`, `must be one of ${keys.join(", ")}`);
    }
    if (byKey.has(key)) invalid(`${section}[${index}].key`, `must appear once for ${key}`);
    byKey.set(key, entry);
  }
  return keys.map((key) => {
    const entry = byKey.get(key);
    if (entry === undefined) invalid(`${section}.${key}`, "must carry this fact");
    return parseContributionFact(entry, `${section}.${key}`, key);
  });
}

function parseStagedContribution(raw: unknown): StagedContribution {
  const record = contributionRecord(raw, "contribution.json", CONTRIBUTION_STAGED_KEYS);
  if (record.schemaVersion !== 1) invalid("contribution.json.schemaVersion", "must equal 1");
  return {
    source: parseContributionSource(record.source),
    workflow: parseContributionFacts(record.workflow, "workflow", WORKFLOW_FACT_KEYS),
    testing: parseContributionFacts(record.testing, "testing", TESTING_FACT_KEYS),
  };
}

// ------------------------------------------------- contribution derivation

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  const average = ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.round(average * 10) / 10;
}

function spread(values: number[]): { median: number; min: number; max: number } {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    median: median(sorted),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function percent(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((word) => word.length > 0);
}

const STOP_WORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "into", "when", "then", "than", "have",
  "has", "had", "was", "were", "are", "but", "not", "its", "our", "their", "they", "them", "you",
  "your", "will", "would", "can", "could", "should", "must", "may", "also", "only", "just", "now",
  "pull", "request", "requests", "branch", "commit", "commits", "code", "file", "files", "test",
  "tests", "change", "changes", "changed", "add", "adds", "added", "update", "updates", "updated",
  "fix", "fixes", "fixed", "use", "uses", "used", "make", "makes", "made", "more", "less", "one",
  "two", "new", "all", "any", "out", "over", "under", "after", "before", "about", "which", "where",
  "there", "here", "been", "being", "does", "did", "doing", "what", "why", "how", "who", "each",
]);

function evidenceOf(merged: MergedPullRequest[]): string[] {
  return merged
    .map((pullRequest) => pullRequest.number)
    .sort((left, right) => left - right)
    .slice(0, EVIDENCE_MAX)
    .map((number) => `PR #${number}`);
}

function fact(
  section: ContributionSectionId,
  key: string,
  value: unknown,
  evidence: string[],
  confidence: ContributionConfidence,
): ContributionFact {
  return {
    key,
    label: CONTRIBUTION_FACT_LABELS[section][key] ?? key,
    value,
    evidence: [...new Set(evidence)].sort(),
    confidence,
  };
}

function unknownFact(
  section: ContributionSectionId,
  key: string,
  reason: string,
): ContributionFact {
  return {
    key,
    label: CONTRIBUTION_FACT_LABELS[section][key] ?? key,
    evidence: [],
    confidence: "unknown",
    reason: reason.slice(0, CONTRIBUTION_REASON_MAX),
  };
}

function parsedFact(section: ContributionSectionId, parsed: ParsedFact): ContributionFact {
  const base = {
    key: parsed.key,
    label: CONTRIBUTION_FACT_LABELS[section][parsed.key] ?? parsed.key,
    evidence: parsed.evidence,
    confidence: parsed.confidence,
  };
  return parsed.confidence === "unknown"
    ? { ...base, reason: parsed.reason ?? "Unknown." }
    : { ...base, value: parsed.value };
}

function styleFacts(merged: MergedPullRequest[]): ContributionFact[] {
  const section = "pull-request-style" as const;
  const evidence = evidenceOf(merged);
  const titles = merged.map((pullRequest) => pullRequest.title);
  const bodies = merged.map((pullRequest) => pullRequest.body);
  const patternCounts = new Map<string, number>();
  for (const title of titles) {
    const match = /^([a-z]+)(?:\(([a-z0-9._/-]+)\))?(!?):\s+/.exec(title);
    const pattern = match === null
      ? "free-form summary"
      : `${match[1]}${match[2] === undefined ? "" : `(${match[2]})`}${match[3] ?? ""}: summary`;
    patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
  }
  const titlePatterns = [...patternCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([pattern, count]) => `${pattern} (${count})`);
  const headingCounts = new Map<string, number>();
  const headingFirst = new Map<string, number>();
  for (const [bodyIndex, body] of bodies.entries()) {
    for (const line of body.split("\n")) {
      const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (match === null) continue;
      const heading = match[1] as string;
      headingCounts.set(heading, (headingCounts.get(heading) ?? 0) + 1);
      if (!headingFirst.has(heading)) headingFirst.set(heading, headingFirst.size + bodyIndex * 0.001);
    }
  }
  const bodyHeadings = [...headingCounts.entries()]
    .sort(
      (left, right) =>
        right[1] - left[1] ||
        (headingFirst.get(left[0]) ?? 0) - (headingFirst.get(right[0]) ?? 0) ||
        left[0].localeCompare(right[0]),
    )
    .slice(0, 10)
    .map(([heading]) => heading);
  const bulletTotal = bodies.reduce((total, body) => {
    const lines = body.split("\n").filter((line) => line.trim().length > 0);
    const bullets = lines.filter((line) => /^\s*[-*+]\s+/.test(line)).length;
    return { total: total.total + lines.length, bullets: total.bullets + bullets };
  }, { total: 0, bullets: 0 });
  const imperative = /^(Add|Allow|Avoid|Build|Bump|Change|Clean|Convert|Create|Document|Drop|Enable|Ensure|Expose|Fix|Handle|Improve|Introduce|Keep|Make|Move|Prefer|Rename|Remove|Replace|Restore|Return|Show|Support|Test|Update|Use|Validate)\b/;
  const past = /^(Added|Allowed|Built|Bumped|Changed|Converted|Created|Documented|Dropped|Enabled|Ensured|Exposed|Fixed|Handled|Improved|Introduced|Kept|Made|Moved|Renamed|Removed|Replaced|Restored|Returned|Showed|Supported|Tested|Updated|Used|Validated)\b/;
  const imperativeTitles = titles.filter((title) => imperative.test(title)).length;
  const pastTitles = titles.filter((title) => past.test(title)).length;
  const firstPersonBodies = bodies.filter((body) => /\b(?:I|we)\b/.test(body)).length;
  const voice: string[] = [];
  if (imperativeTitles > 0 && imperativeTitles >= pastTitles) voice.push("imperative");
  if (pastTitles > imperativeTitles) voice.push("past tense");
  if (firstPersonBodies > 0 && firstPersonBodies * 2 >= merged.length) voice.push("first person");
  voice.sort();
  const wordCounts = new Map<string, number>();
  for (const body of bodies) {
    for (const word of wordsOf(body.toLowerCase()).map((entry) => entry.replace(/[^a-z0-9-]/g, ""))) {
      if (word.length < 4 || STOP_WORDS.has(word)) continue;
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }
  const vocabulary = [...wordCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([word]) => word);
  const closing = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#[0-9]+/i;
  const reference = /#[0-9]+/;
  const checklist = merged.filter((pullRequest) => /- \[[ xX]\]/.test(pullRequest.body)).length;
  const screenshot = merged.filter((pullRequest) =>
    /!\[|screenshot/i.test(pullRequest.body),
  ).length;
  const testPlan = merged.filter((pullRequest) =>
    /^#{1,6}\s+test plan\b/im.test(pullRequest.body),
  ).length;
  const size = spread(merged.map((pullRequest) => pullRequest.filesChanged));
  return [
    fact(section, "titlePatterns", titlePatterns, evidence, "observed"),
    fact(section, "titleWords", spread(titles.map((title) => wordsOf(title).length)), evidence, "observed"),
    fact(section, "bodyHeadings", bodyHeadings, evidence, "observed"),
    fact(section, "bodyWords", spread(bodies.map((body) => wordsOf(body).length)), evidence, "observed"),
    fact(section, "bodyLines", spread(bodies.map((body) => body.split("\n").length)), evidence, "observed"),
    fact(section, "bulletRatio", percent(bulletTotal.bullets, bulletTotal.total), evidence, "observed"),
    fact(section, "voice", voice, evidence, "inferred"),
    fact(section, "vocabulary", vocabulary, evidence, "inferred"),
    fact(
      section,
      "issueLinking",
      {
        referenceShare: percent(
          merged.filter((pullRequest) => reference.test(pullRequest.body)).length,
          merged.length,
        ),
        closingShare: percent(
          merged.filter((pullRequest) => closing.test(pullRequest.body)).length,
          merged.length,
        ),
      },
      evidence,
      "observed",
    ),
    fact(
      section,
      "templates",
      {
        checklistShare: percent(checklist, merged.length),
        screenshotShare: percent(screenshot, merged.length),
        testPlanShare: percent(testPlan, merged.length),
      },
      evidence,
      "observed",
    ),
    fact(
      section,
      "granularity",
      `One accepted change touches a median of ${size.median} files (range ${size.min}-${size.max}).`,
      evidence,
      "inferred",
    ),
  ];
}

function sizeFacts(merged: MergedPullRequest[]): ContributionFact[] {
  const section = "pull-request-size" as const;
  const evidence = evidenceOf(merged);
  const testShares = merged.map((pullRequest) =>
    percent(pullRequest.testFiles, pullRequest.filesChanged),
  );
  const largest = [...merged].sort(
    (left, right) =>
      right.additions + right.deletions - (left.additions + left.deletions) ||
      right.filesChanged - left.filesChanged ||
      right.number - left.number,
  )[0] as MergedPullRequest;
  const withTests = merged.filter((pullRequest) => pullRequest.testFiles > 0).length;
  const withDocs = merged.filter((pullRequest) => pullRequest.documentationFiles > 0).length;
  const withBoth = merged.filter(
    (pullRequest) => pullRequest.testFiles > 0 && pullRequest.documentationFiles > 0,
  ).length;
  return [
    fact(section, "additions", spread(merged.map((pullRequest) => pullRequest.additions)), evidence, "observed"),
    fact(section, "deletions", spread(merged.map((pullRequest) => pullRequest.deletions)), evidence, "observed"),
    fact(section, "filesChanged", spread(merged.map((pullRequest) => pullRequest.filesChanged)), evidence, "observed"),
    fact(section, "testFileShare", spread(testShares), evidence, "observed"),
    fact(
      section,
      "largest",
      {
        number: largest.number,
        additions: largest.additions,
        deletions: largest.deletions,
        filesChanged: largest.filesChanged,
      },
      evidence,
      "observed",
    ),
    fact(section, "testsShare", percent(withTests, merged.length), evidence, "observed"),
    fact(section, "documentationShare", percent(withDocs, merged.length), evidence, "observed"),
    fact(section, "testsAndDocumentationShare", percent(withBoth, merged.length), evidence, "observed"),
  ];
}

function conventionFacts(merged: MergedPullRequest[]): ContributionFact[] {
  const section = "conventions" as const;
  const evidence = evidenceOf(merged);
  const commits = merged.flatMap((pullRequest) => pullRequest.commits);
  const subjects = commits.map((commit) => commit.subject);
  const subjectCounts = new Map<string, number>();
  for (const subject of subjects) {
    const match = /^([a-z]+)(?:\(([a-z0-9._/-]+)\))?(!?):\s+/.exec(subject);
    const pattern = match === null
      ? "free-form subject"
      : `${match[1]}${match[2] === undefined ? "" : `(${match[2]})`}${match[3] ?? ""}: summary`;
    subjectCounts.set(pattern, (subjectCounts.get(pattern) ?? 0) + 1);
  }
  const subjectPattern = [...subjectCounts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0];
  const withBody = commits.filter((commit) => commit.body.length > 0).length;
  const branchPrefixes = new Map<string, number>();
  for (const pullRequest of merged) {
    const prefix = pullRequest.branch.includes("/")
      ? `${pullRequest.branch.split("/")[0]}/`
      : "no-prefix";
    branchPrefixes.set(prefix, (branchPrefixes.get(prefix) ?? 0) + 1);
  }
  const branchNaming = [...branchPrefixes.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([prefix, count]) => `${prefix} (${count})`);
  const mergeMethod = mergeMethodOf(merged);
  const referenced = merged.filter(
    (pullRequest) =>
      pullRequest.references.length > 0 ||
      pullRequest.commits.some((commit) => /#[0-9]+/.test(`${commit.subject} ${commit.body}`)),
  ).length;
  return [
    fact(
      section,
      "commitSubject",
      {
        pattern: subjectPattern?.[0] ?? "free-form subject",
        share: percent(subjectPattern?.[1] ?? 0, subjects.length),
      },
      evidence,
      "observed",
    ),
    fact(
      section,
      "commitBody",
      {
        share: percent(withBody, commits.length),
        medianLines: median(
          commits.filter((commit) => commit.body.length > 0).map(
            (commit) => commit.body.split("\n").length,
          ),
        ),
      },
      evidence,
      "observed",
    ),
    fact(section, "branchNaming", branchNaming, evidence, "observed"),
    fact(section, "mergeMethod", mergeMethod, evidence, "observed"),
    fact(
      section,
      "issueReferences",
      { referenceShare: percent(referenced, merged.length) },
      evidence,
      "observed",
    ),
  ];
}

function mergeMethodOf(merged: MergedPullRequest[]): string {
  const counts = new Map<string, number>();
  for (const pullRequest of merged) {
    counts.set(pullRequest.mergeMethod, (counts.get(pullRequest.mergeMethod) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? "merge"
  );
}

function reviewFacts(merged: MergedPullRequest[]): ContributionFact[] {
  const section = "review" as const;
  const evidence = evidenceOf(merged);
  const checks = [...new Set(merged.flatMap((pullRequest) => pullRequest.checks))].sort();
  const labels = [...new Set(merged.flatMap((pullRequest) => pullRequest.labels))].sort();
  return [
    fact(
      section,
      "requiredApprovals",
      Math.min(...merged.map((pullRequest) => pullRequest.approvals)),
      evidence,
      "observed",
    ),
    fact(section, "requiredChecks", checks, evidence, "observed"),
    fact(section, "labels", labels, evidence, "observed"),
    fact(
      section,
      "draftUsage",
      percent(merged.filter((pullRequest) => pullRequest.draft).length, merged.length),
      evidence,
      "observed",
    ),
    fact(section, "mergeMethod", mergeMethodOf(merged), evidence, "observed"),
  ];
}

function documentationFacts(merged: MergedPullRequest[]): ContributionFact[] {
  const section = "documentation" as const;
  const evidence = evidenceOf(merged);
  const docs = merged.filter((pullRequest) => pullRequest.documentationFiles > 0).length;
  const changelog = merged.filter((pullRequest) =>
    pullRequest.files.some((file) =>
      /(?:^|\/)(?:changelog|changes|release[-_]?notes)(?:\.[A-Za-z0-9]+)?$/i.test(file),
    ),
  ).length;
  const docsShare = percent(docs, merged.length);
  const changelogShare = percent(changelog, merged.length);
  const convention =
    docsShare === 0
      ? "Merged pull requests do not change documentation."
      : changelogShare === 0
        ? "Merged pull requests change documentation in the same pull request, with no changelog file."
        : "Merged pull requests change documentation and the changelog in the same pull request.";
  return [
    fact(section, "documentationShare", docsShare, evidence, "observed"),
    fact(section, "changelogShare", changelogShare, evidence, "observed"),
    fact(section, "convention", convention, evidence, "inferred"),
  ];
}

function hotspotFacts(merged: MergedPullRequest[]): ContributionFact[] {
  const section = "hotspots" as const;
  const evidence = evidenceOf(merged);
  const directoryCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  for (const pullRequest of merged) {
    for (const file of pullRequest.files) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
      const parts = file.split("/");
      const directory = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
      directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
    }
  }
  const top = (counts: Map<string, number>) =>
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([path, count]) => ({ path, count }));
  return [
    fact(section, "directories", top(directoryCounts), evidence, "observed"),
    fact(section, "files", top(fileCounts), evidence, "observed"),
    fact(
      section,
      "typicalFiles",
      spread(merged.map((pullRequest) => pullRequest.filesChanged)),
      evidence,
      "observed",
    ),
  ];
}

/** Every fact that could not be observed, in section and fact order. */
function unknownLedger(sections: ContributionSection[]): string[] {
  return sections.flatMap((section) =>
    section.facts
      .filter((entry) => entry.confidence === "unknown")
      .map((entry) => `${section.id}.${entry.key}: ${entry.reason ?? "unknown"}`),
  );
}

/**
 * Derives the complete contribution document from staged evidence. Every
 * profile section is computed from the merged sample alone; the closed list is
 * counted in `evidence` and never enters another fact.
 */
export function deriveContribution(
  staged: StagedContribution,
  freshness: Freshness,
): Contribution {
  const { source } = staged;
  const merged = source.merged;
  const unavailable = source.unavailable;
  const emptyReason =
    unavailable ??
    (merged.length === 0 ? "No merged pull requests were found for the target." : "");
  const evidence = evidenceOf(merged);
  const sections: ContributionSection[] = [];

  sections.push({
    id: "workflow",
    label: CONTRIBUTION_SECTION_LABELS.workflow,
    facts: staged.workflow.map((entry) => parsedFact("workflow", entry)),
  });
  sections.push({
    id: "testing",
    label: CONTRIBUTION_SECTION_LABELS.testing,
    facts: staged.testing.map((entry) => parsedFact("testing", entry)),
  });

  const profileSections: Array<{
    id: ContributionSectionId;
    keys: string[];
    facts: () => ContributionFact[];
  }> = [
    {
      id: "pull-request-style",
      keys: Object.keys(CONTRIBUTION_FACT_LABELS["pull-request-style"]),
      facts: () => styleFacts(merged),
    },
    {
      id: "pull-request-size",
      keys: Object.keys(CONTRIBUTION_FACT_LABELS["pull-request-size"]),
      facts: () => sizeFacts(merged),
    },
    {
      id: "conventions",
      keys: Object.keys(CONTRIBUTION_FACT_LABELS.conventions),
      facts: () => conventionFacts(merged),
    },
    {
      id: "review",
      keys: Object.keys(CONTRIBUTION_FACT_LABELS.review),
      facts: () => reviewFacts(merged),
    },
    {
      id: "documentation",
      keys: Object.keys(CONTRIBUTION_FACT_LABELS.documentation),
      facts: () => documentationFacts(merged),
    },
    {
      id: "hotspots",
      keys: Object.keys(CONTRIBUTION_FACT_LABELS.hotspots),
      facts: () => hotspotFacts(merged),
    },
  ];
  for (const profile of profileSections) {
    sections.push({
      id: profile.id,
      label: CONTRIBUTION_SECTION_LABELS[profile.id],
      facts:
        merged.length === 0
          ? profile.keys.map((key) => unknownFact(profile.id, key, emptyReason || "No evidence."))
          : profile.facts(),
    });
  }

  const forgeFact =
    unavailable !== null || source.forge === null
      ? unknownFact("evidence", "forge", unavailable ?? "The forge could not be determined.")
      : fact("evidence", "forge", source.forge, ["forge records"], "observed");
  const hostFact =
    unavailable !== null || source.host === null
      ? unknownFact("evidence", "host", unavailable ?? "The forge host could not be determined.")
      : fact("evidence", "host", source.host, ["forge records"], "observed");
  const sampleFact =
    unavailable !== null
      ? unknownFact("evidence", "sampleSize", unavailable)
      : fact("evidence", "sampleSize", merged.length, evidence, "observed");
  const windowFact =
    unavailable !== null || source.window === null
      ? unknownFact(
          "evidence",
          "window",
          unavailable ?? "No merged pull requests were found.",
        )
      : fact("evidence", "window", source.window, evidence, "observed");
  const closedFact =
    unavailable !== null
      ? unknownFact("evidence", "closedUnmerged", unavailable)
      : fact("evidence", "closedUnmerged", source.closedUnmerged.length, ["forge records"], "observed");
  const evidenceSection: ContributionSection = {
    id: "evidence",
    label: CONTRIBUTION_SECTION_LABELS.evidence,
    facts: [forgeFact, hostFact, sampleFact, windowFact, closedFact],
  };
  const ledger = unknownLedger([...sections, evidenceSection]);
  evidenceSection.facts.push(
    fact(
      "evidence",
      "unknownFacts",
      ledger,
      unavailable === null ? ["forge records"] : ["git log"],
      "observed",
    ),
  );
  sections.push(evidenceSection);

  return {
    schemaVersion: 1,
    freshness,
    sections,
    sample: contributionSample(merged),
  };
}

/** The fixed exemplar rule: most recently merged first, then highest number. */
export function contributionSample(merged: MergedPullRequest[]): ContributionSample[] {
  return [...merged]
    .sort(
      (left, right) =>
        Date.parse(right.mergedAt) - Date.parse(left.mergedAt) || right.number - left.number,
    )
    .slice(0, 3)
    .map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
    }));
}

const EXEMPLAR_MARKER = /^> PR #([1-9][0-9]*) — (.+)$/;

interface ContributionExemplar {
  number: number;
  title: string;
  body: string;
}

/** The quoted exemplar blocks at the end of a contribution skill body. */
export function contributionExemplars(body: string): ContributionExemplar[] {
  const exemplars: ContributionExemplar[] = [];
  let current: ContributionExemplar | null = null;
  for (const line of body.split("\n")) {
    const marker = EXEMPLAR_MARKER.exec(line);
    if (marker !== null) {
      if (current !== null) exemplars.push(current);
      current = { number: Number(marker[1]), title: (marker[2] as string).trim(), body: "" };
      continue;
    }
    if (current === null) continue;
    if (line === ">") {
      current.body += "\n";
      continue;
    }
    if (line.startsWith("> ")) {
      current.body += `${line.slice(2)}\n`;
      continue;
    }
    exemplars.push(current);
    current = null;
  }
  if (current !== null) exemplars.push(current);
  return exemplars.map((exemplar) => ({ ...exemplar, body: exemplar.body.replace(/\n$/, "") }));
}

function validateContributionSkill(
  body: string,
  path: string,
  sample: ContributionSample[],
  unavailable: string | null,
): void {
  const exemplars = contributionExemplars(body);
  if (sample.length === 0) {
    if (exemplars.length > 0) {
      invalid(path, "must quote no exemplar when the merged sample is empty");
    }
    if (!/unknown/i.test(body)) {
      invalid(path, "must state that its pull-request-derived rules are unknown");
    }
    if (unavailable !== null && !body.includes(unavailable)) {
      invalid(path, "must state why the merged sample is unavailable");
    }
    return;
  }
  if (exemplars.length !== sample.length) {
    invalid(path, `must quote exactly ${sample.length} merged exemplars`);
  }
  for (const [index, exemplar] of exemplars.entries()) {
    const expected = sample[index] as ContributionSample;
    if (
      exemplar.number !== expected.number ||
      exemplar.title !== expected.title ||
      exemplar.body !== expected.body
    ) {
      invalid(path, `exemplar ${index + 1} must quote PR #${expected.number} verbatim`);
    }
  }
}

/** Reads and validates the one contribution document a run staged. */
export function parseStagedContributionFile(
  text: string,
  path: string,
  freshness: Freshness,
): { contribution: Contribution; source: ContributionSource } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DiscoverValidationError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const staged = parseStagedContribution(raw);
  return { contribution: deriveContribution(staged, freshness), source: staged.source };
}

/** Reads a published contribution document, never failing the other pages. */
export function readContributionArtifact(
  repoDir: string,
  relativePath: string,
): Contribution | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(repoDir, relativePath), "utf8"));
    if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
    const freshness = raw.freshness;
    if (!isRecord(freshness)) return null;
    const header: Freshness = {
      project: textValue(freshness.project, "freshness.project", 200),
      commit: textValue(freshness.commit, "freshness.commit", 64),
      dirty: freshness.dirty === true,
      discoveredAt: textValue(freshness.discoveredAt, "freshness.discoveredAt", 64),
      fingerprint: textValue(freshness.fingerprint, "freshness.fingerprint", 128),
    };
    if (!Array.isArray(raw.sections)) return null;
    if (raw.sections.length !== CONTRIBUTION_SECTION_IDS.length) return null;
    const sections: ContributionSection[] = [];
    for (const [index, entry] of raw.sections.entries()) {
      const id = CONTRIBUTION_SECTION_IDS[index] as ContributionSectionId;
      const section = contributionRecord(entry, `sections[${index}]`, ["id", "label", "facts"]);
      if (section.id !== id) return null;
      if (!Array.isArray(section.facts)) return null;
      const facts = section.facts.map((factEntry, factIndex) => {
        const record = contributionRecord(factEntry, `sections[${index}].facts[${factIndex}]`, [
          "key",
          "label",
          "value",
          "evidence",
          "confidence",
          "reason",
        ]);
        if (typeof record.key !== "string") invalid("fact.key", "must be a string");
        const fields = { ...record };
        delete fields.label;
        return parsedFact(
          id,
          parseContributionFact(fields, `sections[${index}].facts[${factIndex}]`, record.key),
        );
      });
      sections.push({ id, label: CONTRIBUTION_SECTION_LABELS[id], facts });
    }
    if (!Array.isArray(raw.sample)) return null;
    if (raw.sample.length > 3) return null;
    const sample = raw.sample.map((entry, index) => {
      const record = contributionRecord(entry, `sample[${index}]`, ["number", "title", "body"]);
      return {
        number: contributionInteger(record.number, `sample[${index}].number`, 1, 1_000_000_000),
        title: contributionLine(record.title, `sample[${index}].title`, CONTRIBUTION_TITLE_MAX),
        body: contributionBody(record.body, `sample[${index}].body`),
      };
    });
    return { schemaVersion: 1, freshness: header, sections, sample };
  } catch {
    return null;
  }
}

// ------------------------------------------------------- staged validation

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

/** One agent's staged slice; every field other than `skills` is agent-specific. */
export interface AgentStaged {
  sheet?: Sheet;
  glossaries?: Glossary[];
  significance?: GlossarySignificance;
  contribution?: Contribution;
  skills: StagedSkill[];
}

/**
 * Validates exactly the slice one agent owns. It never reads another agent's
 * sheet, glossary, baseline, or live skill: a host with no published artifacts
 * can publish any one slice, and an unrelated artifact cannot fail this run.
 */
export function validateAgentStaged(
  repoDir: string,
  stagingDir: string,
  freshness: Freshness,
  agentId: string,
): AgentStaged {
  const ownership = agentOwnership(agentId);
  if (ownership === null) {
    throw new DiscoverValidationError(`unknown Discover agent: ${agentId}`);
  }
  if (!existsSync(stagingDir)) {
    throw new DiscoverValidationError("the agent left no staging directory");
  }
  const ownedSkills = new Set<string>(ownership.skills);
  const files = walkFiles(stagingDir);
  for (const file of files) {
    const parts = file.split("/");
    const allowed =
      (ownership.sheet && file === STAGED_SHEET) ||
      (ownership.contribution && file === STAGED_CONTRIBUTION) ||
      (ownership.glossary &&
        (file === STAGED_SIGNIFICANCE ||
          (parts[0] === STAGED_GLOSSARY_DIR &&
            parts.length === 2 &&
            parts[1] !== undefined &&
            parts[1].endsWith(".glossary.yaml")))) ||
      (parts[0] === STAGED_SKILL_DIR &&
        parts.length === 3 &&
        parts[2] === "SKILL.md" &&
        ownedSkills.has(parts[1] as string));
    if (!allowed) {
      throw new DiscoverValidationError(
        `the agent wrote ${file}, which is not part of the ${ownership.descriptor.id} staged set`,
      );
    }
  }

  const staged: AgentStaged = { skills: [] };
  if (ownership.sheet) {
    if (!files.includes(STAGED_SHEET)) {
      throw new DiscoverValidationError("the agent left no sheet.json");
    }
    let rawSheet: unknown;
    try {
      rawSheet = JSON.parse(readFileSync(join(stagingDir, STAGED_SHEET), "utf8"));
    } catch (error) {
      throw new DiscoverValidationError(
        `sheet.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    staged.sheet = normalizeSheet(rawSheet, freshness);
  }

  if (ownership.glossary) {
    const context = { repoDir, files: hostFiles(repoDir) };
    const glossaryFiles = files.filter(
      (file) => file.startsWith(`${STAGED_GLOSSARY_DIR}/`) && file.endsWith(".glossary.yaml"),
    );
    if (glossaryFiles.length === 0) {
      throw new DiscoverValidationError("the agent left no glossary document");
    }
    const glossaries: Glossary[] = [];
    const contexts = new Set<string>();
    for (const file of glossaryFiles) {
      let text: string;
      try {
        text = readFileSync(join(stagingDir, file), "utf8");
      } catch (error) {
        throw new DiscoverValidationError(
          `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const glossary = parseGlossary(text, file, context, { staged: true });
      if (contexts.has(glossary.boundedContext)) {
        throw new DiscoverValidationError(`two glossaries name ${glossary.boundedContext}`);
      }
      contexts.add(glossary.boundedContext);
      glossaries.push(glossary);
    }
    if (!files.includes(STAGED_SIGNIFICANCE)) {
      throw new DiscoverValidationError(`the agent left no ${STAGED_SIGNIFICANCE}`);
    }
    let rawSignificance: unknown;
    try {
      rawSignificance = JSON.parse(readFileSync(join(stagingDir, STAGED_SIGNIFICANCE), "utf8"));
    } catch (error) {
      throw new DiscoverValidationError(
        `${STAGED_SIGNIFICANCE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    staged.glossaries = glossaries;
    staged.significance = parseSignificance(
      rawSignificance,
      STAGED_SIGNIFICANCE,
      glossaries,
    );
  }

  let contributionSource: ContributionSource | undefined;
  if (ownership.contribution) {
    if (!files.includes(STAGED_CONTRIBUTION)) {
      throw new DiscoverValidationError("the agent left no contribution.json");
    }
    let text: string;
    try {
      text = readFileSync(join(stagingDir, STAGED_CONTRIBUTION), "utf8");
    } catch (error) {
      throw new DiscoverValidationError(
        `could not read ${STAGED_CONTRIBUTION}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = parseStagedContributionFile(text, STAGED_CONTRIBUTION, freshness);
    staged.contribution = parsed.contribution;
    contributionSource = parsed.source;
  }

  for (const name of ownership.skills) {
    const file = `${STAGED_SKILL_DIR}/${name}/SKILL.md`;
    if (!files.includes(file)) {
      throw new DiscoverValidationError(`the agent left no ${name} skill`);
    }
    staged.skills.push(validateSkillText(name, readFileSync(join(stagingDir, file), "utf8"), file));
  }

  const glossarySkill = staged.skills.find((skill) => skill.name === "discover-glossary");
  for (const glossary of staged.glossaries ?? []) {
    const path = `.omp/discover/glossary/${glossary.boundedContext}.glossary.yaml`;
    if (glossarySkill === undefined || !glossarySkill.body.includes(path)) {
      throw new DiscoverValidationError(`discover-glossary does not name ${path}`);
    }
  }

  if (ownership.contribution) {
    const skill = staged.skills.find((entry) => entry.name === "discover-contribution");
    if (skill === undefined || staged.contribution === undefined) {
      throw new DiscoverValidationError("the agent left no discover-contribution skill");
    }
    validateContributionSkill(
      skill.body,
      `${STAGED_SKILL_DIR}/discover-contribution/SKILL.md`,
      staged.contribution.sample,
      contributionSource?.unavailable ?? null,
    );
  }

  return staged;
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
  /** Null when no sheet agent has published; the other agents never write it. */
  sheetDigest: string | null;
  glossaryDigests: Record<string, string>;
  skills: ManifestSkill[];
  paths: {
    manifest: string;
    sheet: string;
    decisions: string;
    glossaries: string[];
    baselines: Record<string, string>;
    live: Record<string, string>;
    /** Absent in a manifest published before the significance sidecar existed. */
    significance?: string;
    /** Absent in a manifest published before the contribution sheet existed. */
    contribution?: string;
  };
}

/**
 * A manifest path is attacker-controlled state read from a cloned host, so it
 * may only name a file below this repository's `.omp/`. The repository root and
 * the `.omp/` root are resolved rather than compared as strings, which rejects
 * absolute paths, `..` segments, and sibling directories such as `.omp-backup`.
 */
function validatedManifestPath(repoDir: string, value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field, "must be a string");
  if (value.length === 0) invalid(field, "must not be empty");
  if (ABSOLUTE_PATH_PATTERN.test(value)) invalid(field, "must be a repository-relative path");
  if (value.split(/[\\/]/).includes("..")) invalid(field, "must not carry a .. segment");
  const root = resolve(repoDir);
  const target = resolve(root, value);
  const inside = relative(resolve(root, ".omp"), target);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    invalid(field, "must stay under .omp/");
  }
  return value;
}

function validatedManifestPathRecord(
  repoDir: string,
  value: unknown,
  field: string,
): Record<string, string> {
  if (!isRecord(value)) invalid(field, "must be an object of repository paths");
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      validatedManifestPath(repoDir, entry, `${field}.${name}`),
    ]),
  );
}

function validatedManifestPaths(
  repoDir: string,
  value: unknown,
  field: string,
): Manifest["paths"] {
  if (!isRecord(value)) invalid(field, "must be an object");
  const validated: Manifest["paths"] = {
    manifest: validatedManifestPath(repoDir, value.manifest, `${field}.manifest`),
    sheet: validatedManifestPath(repoDir, value.sheet, `${field}.sheet`),
    decisions: validatedManifestPath(repoDir, value.decisions, `${field}.decisions`),
    glossaries: Array.isArray(value.glossaries)
      ? value.glossaries.map((entry, index) =>
          validatedManifestPath(repoDir, entry, `${field}.glossaries[${index}]`),
        )
      : invalid(`${field}.glossaries`, "must be a list of repository paths"),
    baselines: validatedManifestPathRecord(repoDir, value.baselines, `${field}.baselines`),
    live: validatedManifestPathRecord(repoDir, value.live, `${field}.live`),
  };
  if (value.significance !== undefined) {
    validated.significance = validatedManifestPath(
      repoDir,
      value.significance,
      `${field}.significance`,
    );
  }
  if (value.contribution !== undefined) {
    validated.contribution = validatedManifestPath(
      repoDir,
      value.contribution,
      `${field}.contribution`,
    );
  }
  return validated;
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
  if (!isRecord(parsed) || parsed.schemaVersion !== DISCOVER_SCHEMA_VERSION) {
    throw new DiscoverValidationError("manifest.json has an unsupported version");
  }
  return {
    ...(parsed as unknown as Manifest),
    paths: validatedManifestPaths(repoDir, parsed.paths, "manifest.json.paths"),
  };
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
  sheet: Sheet | null;
  glossaries: Glossary[];
  significance: GlossarySignificance;
  decisions: Decision[];
  /** Null when the host published before this artifact existed or it is unreadable. */
  contribution: Contribution | null;
}

/**
 * A published glossary is immutable crawl evidence: the crawl proved its
 * grounding against the host at publish time. A later refactor must not make
 * the published set unreadable, or a re-crawl could never read and repair it.
 * Live-host grounding checks belong to staged glossaries only.
 */
function readPublished(repoDir: string): PublishedRead | undefined {
  const manifest = readManifest(repoDir);
  if (manifest === undefined) return undefined;
  const context = { repoDir, files: hostFiles(repoDir) };
  let sheet: Sheet | null = null;
  if (manifest.sheetDigest !== null && manifest.sheetDigest !== undefined) {
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
    sheet = normalizeSheet(
      Object.fromEntries(Object.entries(rawSheet).filter(([key]) => key !== "freshness")),
      {
        project: textValue(freshness.project, "freshness.project", 200),
        commit: textValue(freshness.commit, "freshness.commit", 64),
        dirty: freshness.dirty === true,
        discoveredAt: textValue(freshness.discoveredAt, "freshness.discoveredAt", 64),
        fingerprint: textValue(freshness.fingerprint, "freshness.fingerprint", 128),
      },
    );
  }
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
    glossaries.push(
      parseGlossary(text, relativePath, context, { staged: false, trustGrounding: true }),
    );
  }
  const significance =
    manifest.paths.significance === undefined
      ? {}
      : readSignificance(repoDir, manifest.paths.significance, glossaries);
  const decisions = readDecisions(repoDir);
  // One unreadable or pre-change contribution artifact never hides the other
  // published pages; only the Contribution page falls back to its empty state.
  const contribution =
    manifest.paths.contribution === undefined
      ? null
      : readContributionArtifact(repoDir, manifest.paths.contribution);
  return { manifest, sheet, glossaries, significance, decisions, contribution };
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
  /** The run's staging directory; publication parses it. */
  stagingDir: string;
  project: string;
  agent: DiscoverAgentId;
}

export interface PublishResult {
  manifest: Manifest;
  warnings: string[];
}

/** Reads only the glossaries a previous glossary agent published. */
function readPublishedGlossaries(repoDir: string, manifest: Manifest | undefined): Glossary[] {
  if (manifest === undefined) return [];
  const context = { repoDir, files: hostFiles(repoDir) };
  const glossaries: Glossary[] = [];
  for (const relativePath of manifest.paths.glossaries ?? []) {
    let text: string;
    try {
      text = readFileSync(join(repoDir, relativePath), "utf8");
    } catch (error) {
      throw new DiscoverValidationError(
        `${relativePath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    glossaries.push(
      parseGlossary(text, relativePath, context, { staged: false, trustGrounding: true }),
    );
  }
  return glossaries;
}

interface SkillPublication {
  entry: ManifestSkill;
  writes: FileWrite[];
}

/**
 * One owned skill's baseline and live file. A developer's edited live skill is
 * preserved byte for byte, an unedited one is replaced by the new baseline, and
 * a deleted one is not recreated.
 */
function publishSkill(
  repoDir: string,
  stagedSkill: StagedSkill,
  previous: ManifestSkill | undefined,
): SkillPublication {
  const name = stagedSkill.name;
  const baseline = stagedSkill.text;
  const baselineHash = hashText(baseline);
  const livePath = liveSkillPath(repoDir, name);
  const writes: FileWrite[] = [{ path: baselinePath(repoDir, name), content: baseline }];
  let state: ManifestSkill["state"];
  let currentHash: string | null;
  if (!existsSync(livePath)) {
    if (previous === undefined) {
      // The first publication of this skill installs its live file.
      state = "generated";
      currentHash = baselineHash;
      writes.push({ path: livePath, content: baseline });
    } else {
      state = "missing";
      currentHash = null;
    }
  } else {
    const liveText = readFileSync(livePath, "utf8");
    currentHash = hashText(liveText);
    if (previous !== undefined && currentHash !== previous.baselineHash) {
      state = "edited";
    } else if (previous === undefined && currentHash !== baselineHash) {
      state = "edited";
    } else {
      state = "generated";
      currentHash = baselineHash;
      writes.push({ path: livePath, content: baseline });
    }
  }
  return { entry: { name, baselineHash, currentHash, state }, writes };
}

/**
 * Validates and publishes exactly one agent's slice. It reads and writes only
 * what that agent owns plus the manifest and decisions bookkeeping, so every
 * artifact owned by another agent keeps its bytes through this publication.
 */
export function publishAgentStaged(input: PublishInput): PublishResult {
  const { repoDir, runId, facts, stagingDir, project, agent } = input;
  const ownership = agentOwnership(agent);
  if (ownership === null) throw new DiscoverValidationError(`unknown Discover agent: ${agent}`);
  // Publication parses whatever the staging tools wrote and reports a
  // malformed document as this agent's error. There is no separate post-write
  // validation phase and no re-ask.
  const staged = validateAgentStaged(
    repoDir,
    stagingDir,
    {
      project,
      commit: facts.commit,
      dirty: facts.dirty,
      discoveredAt: new Date().toISOString(),
      fingerprint: facts.fingerprint,
    },
    agent,
  );

  for (const name of ownership.skills) {
    const collision = collisionAt(repoDir, name);
    if (collision !== undefined) throw new DiscoverValidationError(collision);
  }

  const previousManifest = readManifest(repoDir);
  // A legacy manifest is reused for the slices a publication does not own, so
  // its paths are revalidated here instead of being trusted from disk.
  const previousPaths =
    previousManifest === undefined
      ? undefined
      : validatedManifestPaths(repoDir, previousManifest.paths, "manifest.json.paths");
  const previousSkills = new Map<string, ManifestSkill>(
    (previousManifest?.skills ?? []).map((skill) => [skill.name, skill] as const),
  );
  const skillEntries = new Map<string, ManifestSkill>(previousSkills);
  const writes: FileWrite[] = [];
  const deletions: string[] = [];

  let mergedGlossaries: Glossary[] | null = null;
  if (ownership.glossary) {
    const previousGlossaries = readPublishedGlossaries(repoDir, previousManifest);
    const previousByName = new Map(
      (staged.glossaries ?? []).map((glossary) => [glossary.boundedContext, glossary]),
    );
    mergedGlossaries = (staged.glossaries ?? []).map((glossary) =>
      mergeGlossary(
        previousGlossaries.find(
          (candidate) => candidate.boundedContext === glossary.boundedContext,
        ),
        glossary,
      ),
    );
    for (const previousGlossary of previousGlossaries) {
      if (previousByName.has(previousGlossary.boundedContext)) continue;
      // A bounded context the crawl no longer sees keeps its human decisions.
      if (
        previousGlossary.concepts.some(
          (concept) => concept.status === "confirmed" || concept.status === "invalidated",
        )
      ) {
        mergedGlossaries.push(previousGlossary);
      }
    }
    mergedGlossaries.sort((left, right) =>
      left.boundedContext.localeCompare(right.boundedContext),
    );
    // Discovery does not ask the operator to confirm terms one by one: every
    // newly crawled term is published as confirmed. An invalidated term stays
    // invalidated because it records a human decision.
    for (const glossary of mergedGlossaries) {
      for (const concept of glossary.concepts) {
        if (concept.status === "proposed" || concept.status === "unconfirmed") {
          concept.status = "confirmed";
        }
      }
    }
    writes.push({
      path: significancePath(repoDir),
      content: renderJson({
        schemaVersion: SIGNIFICANCE_SCHEMA_VERSION,
        contexts: staged.significance ?? {},
      }),
    });
    for (const glossary of mergedGlossaries) {
      writes.push({
        path: glossaryPath(repoDir, glossary.boundedContext),
        content: renderGlossary(glossary),
      });
    }
    const desiredGlossaries = new Set(
      mergedGlossaries.map((glossary) => glossaryPath(repoDir, glossary.boundedContext)),
    );
    const glossaryRoot = join(discoverRoot(repoDir), "glossary");
    if (existsSync(glossaryRoot)) {
      for (const entry of readdirSync(glossaryRoot)) {
        const absolute = join(glossaryRoot, entry);
        if (!desiredGlossaries.has(absolute) && statSync(absolute).isFile()) {
          deletions.push(absolute);
        }
      }
    }
  }

  for (const stagedSkill of staged.skills) {
    const publication = publishSkill(
      repoDir,
      stagedSkill,
      previousSkills.get(stagedSkill.name),
    );
    skillEntries.set(stagedSkill.name, publication.entry);
    writes.push(...publication.writes);
  }

  let sheetValue: Sheet | null = null;
  let sheetDigestValue: string | null = previousManifest?.sheetDigest ?? null;
  if (ownership.sheet) {
    if (staged.sheet === undefined) {
      throw new DiscoverValidationError("the agent left no sheet.json");
    }
    const freshness: Freshness = {
      project,
      commit: facts.commit,
      dirty: facts.dirty,
      discoveredAt: new Date().toISOString(),
      fingerprint: facts.fingerprint,
    };
    sheetValue = normalizeSheet(
      Object.fromEntries(
        Object.entries(staged.sheet as unknown as Record<string, unknown>).filter(
          ([key]) => key !== "freshness",
        ),
      ),
      freshness,
    );
    sheetDigestValue = sheetDigest(sheetValue);
    writes.push({ path: join(repoDir, ".omp/discover/sheet.json"), content: renderJson(sheetValue) });
  }

  if (ownership.contribution) {
    if (staged.contribution === undefined) {
      throw new DiscoverValidationError("the agent left no contribution.json");
    }
    const contribution: Contribution = {
      ...staged.contribution,
      freshness: {
        project,
        commit: facts.commit,
        dirty: facts.dirty,
        discoveredAt: new Date().toISOString(),
        fingerprint: facts.fingerprint,
      },
    };
    writes.push({
      path: join(repoDir, ".omp/discover/contribution.json"),
      content: renderJson(contribution),
    });
  }

  const orderedSkills = DISCOVER_SKILLS.flatMap((name) => {
    const entry = skillEntries.get(name);
    return entry === undefined ? [] : [entry];
  });
  const glossaryDigests =
    mergedGlossaries === null
      ? (previousManifest?.glossaryDigests ?? {})
      : Object.fromEntries(
          mergedGlossaries.map((glossary) => [
            glossary.boundedContext,
            glossaryDigest(glossary),
          ]),
        );
  const manifest: Manifest = {
    schemaVersion: DISCOVER_SCHEMA_VERSION,
    fingerprint: facts.fingerprint,
    publishedAt: new Date().toISOString(),
    runId,
    sheetDigest: sheetDigestValue,
    glossaryDigests,
    skills: orderedSkills,
    paths: {
      manifest: ".omp/discover/manifest.json",
      sheet: ".omp/discover/sheet.json",
      decisions: ".omp/discover/decisions.json",
      glossaries:
        mergedGlossaries === null
          ? (previousPaths?.glossaries ?? [])
          : mergedGlossaries.map(
              (glossary) => `.omp/discover/glossary/${glossary.boundedContext}.glossary.yaml`,
            ),
      baselines: Object.fromEntries(
        orderedSkills.map((entry) => [entry.name, `.omp/discover/skills/${entry.name}/SKILL.md`]),
      ),
      live: Object.fromEntries(
        orderedSkills.map((entry) => [entry.name, `.omp/skills/${entry.name}/SKILL.md`]),
      ),
      significance:
        ownership.glossary || previousPaths === undefined
          ? ".omp/discover/significance.json"
          : previousPaths.significance,
      contribution: ownership.contribution
        ? ".omp/discover/contribution.json"
        : previousPaths?.contribution,
    },
  };
  if (!ownership.glossary && previousManifest === undefined) {
    // A skill-only first publication carries no sidecar path at all.
    delete manifest.paths.significance;
  }
  if (!ownership.contribution && previousPaths?.contribution === undefined) {
    // A pre-contribution host keeps its manifest free of the new path.
    delete manifest.paths.contribution;
  }

  const decisions = readDecisions(repoDir);
  writes.push({ path: join(repoDir, manifest.paths.manifest), content: renderJson(manifest) });
  writes.push({ path: join(repoDir, manifest.paths.decisions), content: renderJson(decisions) });
  writeTransaction(writes, deletions);

  const warnings: string[] = [];
  const liveBodies: Array<{ name: string; body: string }> = [];
  for (const entry of orderedSkills) {
    if (entry.state !== "edited") continue;
    try {
      liveBodies.push({
        name: entry.name,
        body: readFileSync(liveSkillPath(repoDir, entry.name), "utf8"),
      });
    } catch {
      // A live skill that cannot be read is reported by the editor, not here.
    }
  }
  for (const contradiction of skillContradictions(liveBodies)) {
    warnings.push(
      `${contradiction.skills[0]} and ${contradiction.skills[1]} disagree about ${contradiction.subject}`,
    );
  }

  return { manifest, warnings };
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
  /** Null until the sheet agent publishes; every other page tolerates that. */
  sheet: Sheet | null;
  glossaries: Glossary[];
  usage: GlossaryUsage;
  significance: GlossarySignificance;
  decisions: Decision[];
  skills: SkillView[];
  /** Null until the contribution agent publishes, or when its file is unreadable. */
  contribution: Contribution | null;
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

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * The browsable repository an installed package declares in its manifest, or
 * null when the package is absent, its name is not a package name, or it names
 * no web repository. Installed manifests are the only source: a URL is never
 * guessed from a package name.
 */
export function packageRepository(repoDir: string, name: string): string | null {
  if (!PACKAGE_NAME.test(name) || name.includes("..")) return null;
  const manifestPath = join(repoDir, "node_modules", ...name.split("/"), "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(manifest)) return null;
  const repository = manifest.repository;
  let raw: string | undefined;
  let directory: string | undefined;
  if (typeof repository === "string") {
    raw = repository;
  } else if (isRecord(repository)) {
    if (typeof repository.url === "string") raw = repository.url;
    if (typeof repository.directory === "string") directory = repository.directory;
  }
  if (raw === undefined) return null;
  return normalizeRepositoryUrl(raw, directory);
}

function dependencyCandidates(node: unknown, names: Set<string>): void {
  if (typeof node === "string") {
    const name = dependencyName(node);
    if (name.length > 0) names.add(name);
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) dependencyCandidates(entry, names);
    return;
  }
  if (!isRecord(node)) return;
  if ("confidence" in node && "evidence" in node) {
    dependencyCandidates(node.value, names);
    return;
  }
  for (const value of Object.values(node)) dependencyCandidates(value, names);
}

/**
 * Repository links for every installed package the sheet's stack names, keyed
 * by the name each entry starts with. The stack is the one place the page
 * renders library chips; no other section is linked by name.
 */
export function dependencyRepositories(
  repoDir: string,
  sheet: Sheet | Record<string, unknown> | null,
): Record<string, string> {
  if (sheet === null) return {};
  const names = new Set<string>();
  dependencyCandidates(sheet.stack, names);
  const links: Record<string, string> = {};
  for (const name of [...names].sort()) {
    const url =
      packageRepository(repoDir, name) ?? packageRepository(repoDir, name.toLowerCase());
    if (url !== null) links[name] = url;
  }
  return links;
}

/** The scheme every Overview file reference hands off to the local editor. */
export const VSCODE_FILE_SCHEME = "vscode://file/";

/** A value that names a location of its own: absolute, or a drive path. */
const ABSOLUTE_REFERENCE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/**
 * The VS Code handoff for one repository-relative reference the Overview
 * renders, or null when the page keeps it plain text. A reference that is
 * absolute or carries a `..` segment is refused before it is resolved, and a
 * path that resolves outside the checkout — including through a symlink — is
 * refused even when a file exists there. `host: false` is a retained remote
 * project: its published bytes name no live tree, so nothing links.
 *
 * Every segment is encoded on its own, so a name carrying a space, `#`, `?`, or
 * `%` yields a URL that decodes back to the exact absolute path.
 */
export function overviewPathLink(
  root: string,
  reference: unknown,
  options: { host?: boolean } = {},
): string | null {
  if (options.host === false) return null;
  const value = typeof reference === "string" ? reference.trim() : "";
  if (value.length === 0 || ABSOLUTE_REFERENCE.test(value)) return null;
  if (value.split(/[\\/]/).includes("..")) return null;
  const checkout = resolve(root);
  const absolute = resolve(checkout, value);
  if (absolute !== checkout && !absolute.startsWith(`${checkout}${sep}`)) return null;
  let realCheckout: string;
  let real: string;
  try {
    realCheckout = realpathSync(checkout);
    real = realpathSync(absolute);
  } catch {
    // A reference that names no existing file or directory stays text.
    return null;
  }
  if (real !== realCheckout && !real.startsWith(`${realCheckout}${sep}`)) return null;
  return `${VSCODE_FILE_SCHEME}${absolute.split("/").map(encodeURIComponent).join("/")}`;
}

/** Every reference the Overview renders as a path: entry points, manifests, kernels. */
function overviewReferences(sheet: Record<string, unknown>): string[] {
  const architecture = isRecord(sheet.architecture) ? sheet.architecture : {};
  const runtime = isRecord(sheet.runtime) ? sheet.runtime : {};
  const contexts =
    isRecord(architecture.contexts) && Array.isArray(architecture.contexts.value)
      ? architecture.contexts.value
      : [];
  const kernels =
    isRecord(architecture.sharedKernels) && Array.isArray(architecture.sharedKernels.value)
      ? architecture.sharedKernels.value
      : [];
  const manifests =
    isRecord(runtime.manifests) && Array.isArray(runtime.manifests.value)
      ? runtime.manifests.value
      : [];
  const references: string[] = [];
  for (const context of contexts) {
    if (!isRecord(context) || !Array.isArray(context.entryPoints)) continue;
    for (const entry of context.entryPoints) {
      if (typeof entry === "string") references.push(entry.trim());
    }
  }
  for (const value of [...kernels, ...manifests]) {
    if (typeof value === "string") references.push(value.trim());
  }
  return references.filter((reference) => reference.length > 0);
}

/**
 * The handoff for every path reference the Overview renders, keyed by the text
 * the page shows. A reference the rule refuses has no entry, so the page draws
 * its existing plain chip and the payload carries no link for it.
 */
export function overviewPathLinks(
  root: string,
  sheet: Sheet | Record<string, unknown> | null,
  options: { host?: boolean } = {},
): Record<string, string> {
  if (sheet === null || options.host === false) return {};
  const links: Record<string, string> = {};
  for (const reference of [...new Set(overviewReferences(sheet))].sort()) {
    const href = overviewPathLink(root, reference, options);
    if (href !== null) links[reference] = href;
  }
  return links;
}

/**
 * Reads the published artifacts from disk; never writes or repairs them.
 * Published grounding is crawl evidence, so a source file deleted after the
 * crawl leaves the artifacts readable instead of hiding the whole set.
 */
export function readArtifacts(repoDir: string): ArtifactsRead {
  try {
    const published = readPublished(repoDir);
    if (published === undefined) return { artifacts: null, error: null };
    const skills = DISCOVER_SKILLS.filter((name) =>
      published.manifest.skills.some((skill) => skill.name === name),
    ).map((name) => readSkillView(repoDir, published.manifest, name));
    return {
      artifacts: {
        manifest: published.manifest,
        sheet: published.sheet,
        glossaries: published.glossaries,
        usage: glossaryUsage(repoDir, published.glossaries, published.manifest.fingerprint),
        significance: published.significance,
        decisions: published.decisions,
        skills,
        contribution: published.contribution,
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

// --------------------------------------------------------- glossary edits

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** An edit reads the published glossary, so its grounding is crawl evidence. */
function readGlossaryFile(repoDir: string, context: string): Glossary {
  if (!CONTEXT_PATTERN.test(context)) invalid("context", "must be a bounded context name");
  const file = glossaryPath(repoDir, context);
  if (!existsSync(file)) invalid("context", `has no glossary at ${context}.glossary.yaml`);
  const parsed = readFileSync(file, "utf8");
  return parseGlossary(
    parsed,
    `${context}.glossary.yaml`,
    { repoDir, files: hostFiles(repoDir) },
    { staged: false, trustGrounding: true },
  );
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

export function confirmGlossaryTerm(
  repoDir: string,
  context: string,
  id: string,
): string | null {
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
