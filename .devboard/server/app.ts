import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  AcpConnection,
  agentPrompt,
  type AcpActivity,
  type AcpQuestion,
  type AcpQuestionOption,
} from "./acp";
import {
  FeedbackDeliveryError,
  FeedbackRequestError,
  fileFeedbackIssue,
  parseFeedbackSubmission,
} from "./feedback";
import { defaultGoalPath, readGoal, writeGoal } from "./goal";
import { parseRecord, readRecords, type AdrRecord } from "./records";
import {
  findOpenEpics,
  normalizeEpics,
  type EpicLookup,
  type OpenEpic,
} from "./tracker";
import {
  gitRevision,
  runningHarnessDir,
  serverVersion,
  type ServerVersion,
} from "./version";

export interface TrackerSettle {
  /** Total tracker reads per settle, including the first. */
  attempts: number;
  /** Delay before each read after the first. */
  delayMs: number;
}

export interface FeedbackOptions {
  /** Executable plus leading arguments that can create GitHub issues. */
  ghCommand?: string[];
  timeoutMs?: number;
  /** Extra environment for the `gh` child. */
  env?: Record<string, string>;
}

export interface AppOptions {
  adrDir: string;
  staticDir: string;
  hostname: string;
  port: number;
  repoDir?: string;
  goalFile?: string;
  agentCommand?: string;
  tracker?: EpicLookup;
  trackerSettle?: Partial<TrackerSettle>;
  /** Delay before an implementation lane whose epic stayed open runs again. */
  laneBackoffMs?: number;
  /** Interval at which `main` is checked for a parked or retrying lane. */
  mainPollMs?: number;
  feedback?: FeedbackOptions;
  /** Directory that retains the lifecycle pass between process lifetimes. */
  stateDir?: string;
  /** Replaces the process; `index.ts` re-execs the host's current harness. */
  restart?: () => void;
  versionState?: () => ServerVersion;
}

type RunAction = "resolving" | "implementing" | "generating";

interface RunQuestion {
  id: number | string;
  message: string;
  options: AcpQuestionOption[];
}

interface ActiveRun {
  file: string;
  title: string;
  /** What the agent is doing, so the interface never calls an implementation a resolution. */
  action: RunAction;
  agent: AcpConnection | undefined;
  activity: string[];
  question: RunQuestion | null;
}

/**
 * One agent peer in a lifecycle run. Every lane owns exactly one unit of work:
 * an epic generation pass, one open epic, or one ADR record. `id` is unique per
 * attempt so a retried epic keeps its earlier tab beside the new one.
 */
type LaneKind = "generation" | "implementation" | "adr";
type LaneStatus = "running" | "paused" | "closed" | "failed" | "retrying" | "parked";

interface Lane {
  id: string;
  kind: LaneKind;
  epic: OpenEpic | null;
  record: { file: string; title: string } | null;
  attempt: number;
  status: LaneStatus;
  agent: AcpConnection | undefined;
  activity: string[];
  question: RunQuestion | null;
  /** True when the peer reported an explicit hard blocker. */
  blocked: boolean;
  /** The peer's error message, when its turn ended with one. */
  failure: string | null;
}

/** The lifecycle's memory of one open epic across its attempts. */
interface EpicState {
  epic: OpenEpic;
  attempts: number;
  status: "running" | "retrying" | "parked" | "closed";
  timer: Timer | undefined;
  /** The `main` revision when the last lane stopped; a change retries it. */
  mainAtFailure: string | undefined;
}

interface GoalRevision {
  agent: AcpConnection | undefined;
  activity: string[];
  question: RunQuestion | null;
}

interface GoalCreation {
  agent: AcpConnection | undefined;
  activity: string[];
  question: RunQuestion | null;
}

interface SkillSummary {
  name: string;
  description: string;
}

/** Two skills whose directives state opposite policies for the same subject. */
interface SkillContradiction {
  skills: [string, string];
  directives: [string, string];
}

interface SkillFile {
  directory: string;
  name: string;
  description: string;
  managed: boolean;
  directives: { polarity: "positive" | "negative"; text: string; source: string }[];
}

interface SkillsSnapshot {
  exists: boolean;
  files: Map<string, Buffer>;
}

interface SkillsPreparation {
  agent: AcpConnection | undefined;
  activity: string[];
  question: RunQuestion | null;
  snapshot: SkillsSnapshot;
  unmanagedNames: Set<string>;
}

type LifecycleStage = "goal" | "epic" | "adr" | "implementation" | "finished";

interface LifecycleWork {
  kind: "adr" | "epic";
  id: string;
  /** The tracker page for an epic, so the interface can link to it. */
  url?: string;
}

interface LifecycleState {
  stage: LifecycleStage;
  pass: number;
  work: LifecycleWork | null;
  paused: boolean;
}

const EPIC_PROMPT = "/epic-next";
const IMPLEMENT_PROMPT = "/implement-next-epic";

/** Wakes a lane's peer once the lifecycle reaches this turn. */
const EPIC_GENERATION_TITLE = "Epic generation";
/** Marker a peer prints on its own line when it cannot finish its work. */
const BLOCKER_MARKER = "DEVBOARD-BLOCKED:";

/**
 * A forge can take a moment to expose a tracker write made by the peer that
 * just exited. After such a peer the lifecycle re-reads the tracker for this
 * bounded window before trusting an answer that still shows the pre-peer state.
 */
const TRACKER_SETTLE_ATTEMPTS = 7;
const TRACKER_SETTLE_DELAY_MS = 500;
/** Delay before a lane whose epic stayed open runs again. */
const LANE_BACKOFF_MS = 5_000;
/** Interval at which `main` is checked while a retry or a parked epic waits. */
const MAIN_POLL_MS = 2_000;
const GOAL_CREATION_PROMPT = "/goal-outcome";
const SKILLS_PROMPT = "/prepare-skills";
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 1024;
const MANAGED_MARKER = "devboard-managed";
/** Top-level entries an implementation reset keeps, besides the goal file. */
const RESET_KEEP_NAMES = [".devboard", ".omp", "AGENTS.md", ".gitignore", "GOAL.md"] as const;
/** Repository internals a reset preserves without committing them. */
const RESET_INTERNAL_NAMES = new Set([".git", ".worktree"]);
/** Paths a reset never stages, even without a .gitignore. */
const RESET_STAGE_EXCLUSIONS = [
  ".git",
  ".worktree",
  ".devboard/node_modules",
  ".devboard/dist",
];
const RESET_COMMIT_MESSAGE = "chore: reset implementation";
const RESET_PUSH_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  NO_COLOR: "1",
};
/** Largest accepted feedback body, before JSON parsing. */
const MAX_FEEDBACK_BYTES = 64_000;
/** Default wall-clock bound for one issue creation. */
const FEEDBACK_TIMEOUT_MS = 60_000;

/** One directive statement extracted from a skill body for contradiction review. */
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

function goalRevisionPrompt(goalFile: string, request: string | undefined): string {
  const guidance = request?.trim();
  return [
    `Revise the goal in ${goalFile}.`,
    "Ask the developer any questions you need, one at a time.",
    "When the revision is complete, write the complete revised goal text to that file and end the turn.",
    ...(guidance === undefined || guidance.length === 0 ? [] : ["", `Guidance: ${guidance}`]),
  ].join("\n");
}

type ClientMessage =
  | { type: "listRecords" }
  | { type: "getGoal" }
  | { type: "getProject" }
  | { type: "getVersion" }
  | { type: "restartServer" }
  | { type: "saveGoal"; text?: unknown }
  | { type: "startRun"; file?: unknown }
  | { type: "startLifecycle" }
  | { type: "stopLifecycle" }
  | { type: "pauseLifecycle" }
  | { type: "resumeLifecycle" }
  | { type: "reviseGoal"; request?: unknown }
  | { type: "createGoal" }
  | { type: "prepareSkills" }
  | { type: "getSkills" }
  | { type: "resetImplementation" }
  | { type: "answer"; id?: unknown; value?: unknown; lane?: unknown };

function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  switch (value.type) {
    case "listRecords":
      return { type: "listRecords" };
    case "getGoal":
      return { type: "getGoal" };
    case "getProject":
      return { type: "getProject" };
    case "getVersion":
      return { type: "getVersion" };
    case "restartServer":
      return { type: "restartServer" };
    case "saveGoal":
      return { type: "saveGoal", text: "text" in value ? value.text : undefined };
    case "startRun":
      return { type: "startRun", file: "file" in value ? value.file : undefined };
    case "startLifecycle":
      return { type: "startLifecycle" };
    case "stopLifecycle":
      return { type: "stopLifecycle" };
    case "pauseLifecycle":
      return { type: "pauseLifecycle" };
    case "resumeLifecycle":
      return { type: "resumeLifecycle" };
    case "reviseGoal":
      return { type: "reviseGoal", request: "request" in value ? value.request : undefined };
    case "createGoal":
      return { type: "createGoal" };
    case "prepareSkills":
      return { type: "prepareSkills" };
    case "getSkills":
      return { type: "getSkills" };
    case "resetImplementation":
      return { type: "resetImplementation" };
    case "answer":
      return {
        type: "answer",
        id: "id" in value ? value.id : undefined,
        value: "value" in value ? value.value : undefined,
        lane: "lane" in value ? value.lane : undefined,
      };
    default:
      return undefined;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Reads the flat and one-level `metadata:` fields of a SKILL.md frontmatter
 * block. Folded (`>`) and literal (`|`) scalars are joined so a wrapped
 * description keeps its length and text.
 */
function parseFrontmatter(source: string): Map<string, string> | undefined {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close < 0) return undefined;

  const fields = new Map<string, string>();
  let section: string | undefined;
  let blockKey: string | undefined;
  let blockStyle: "folded" | "literal" | undefined;
  let blockLines: string[] = [];

  const flush = () => {
    if (blockKey !== undefined) {
      fields.set(blockKey, blockStyle === "literal" ? blockLines.join("\n") : blockLines.join(" "));
    }
    blockKey = undefined;
    blockStyle = undefined;
    blockLines = [];
  };

  for (let index = 1; index < close; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();

    if (blockKey !== undefined) {
      if (raw.startsWith(" ") || raw.startsWith("\t")) {
        blockLines.push(trimmed);
        continue;
      }
      flush();
    }

    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^([^:]+):\s*(.*)$/.exec(trimmed);
    if (match === null) continue;

    const key = match[1]?.trim() ?? "";
    const value = match[2] ?? "";
    if (/^\s/.test(raw) && section !== undefined) {
      fields.set(`${section}.${key}`, unquote(value));
      continue;
    }

    const marker = value.trim();
    if (marker.length === 0) {
      section = key;
      continue;
    }
    if (marker === ">" || marker === ">-" || marker === "|" || marker === "|-") {
      section = undefined;
      blockKey = key;
      blockStyle = marker.startsWith(">") ? "folded" : "literal";
      continue;
    }

    section = undefined;
    fields.set(key, unquote(value));
  }
  flush();
  return fields;
}

/** Turns a directive into the subject two skills must agree on to conflict. */
function normalizeDirective(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[.!?;:,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^to\s+use\s+/, "")
    .replace(/^to\s+/, "")
    .replace(/^use\s+/, "");
}

function extractDirectives(source: string): SkillFile["directives"] {
  const lines = source.split(/\r?\n/);
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close >= 0) start = close + 1;
  }

  const directives: SkillFile["directives"] = [];
  let fenced = false;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const text = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^(?:[-*+]|\d+[.)])\s+/, "");
    if (text.length === 0) continue;

    const match = DIRECTIVE_PATTERN.exec(text);
    if (match === null) continue;
    const marker = (match[1] ?? "").toLowerCase();
    const subject = normalizeDirective(match[2] ?? "");
    if (subject.length === 0) continue;
    directives.push({
      polarity: NEGATIVE_DIRECTIVES[marker] === true ? "negative" : "positive",
      text: subject,
      source: text,
    });
  }
  return directives;
}

async function readSkillAt(root: string, directory: string): Promise<SkillFile | undefined> {
  let source: string;
  try {
    source = await readFile(join(root, directory, "SKILL.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const fields = parseFrontmatter(source) ?? new Map<string, string>();
  const description = fields.get("description") ?? "";
  return {
    directory,
    name: fields.get("name") ?? "",
    description,
    managed: fields.get(`metadata.${MANAGED_MARKER}`) === "true",
    directives: extractDirectives(source),
  };
}

function findContradictions(skills: SkillFile[]): SkillContradiction[] {
  const all = skills.flatMap((skill) =>
    skill.directives.map((directive) => ({ ...directive, skill })),
  );
  const seen = new Set<string>();
  const contradictions: SkillContradiction[] = [];

  for (const left of all) {
    for (const right of all) {
      if (left.skill.directory === right.skill.directory) continue;
      if (left.polarity === right.polarity) continue;
      if (left.text !== right.text) continue;

      const [firstSkill, secondSkill] =
        left.skill.directory <= right.skill.directory
          ? [left.skill.directory, right.skill.directory]
          : [right.skill.directory, left.skill.directory];
      const key = `${firstSkill}\u0000${secondSkill}\u0000${left.text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const first = left.skill.directory === firstSkill ? left : right;
      const second = first === left ? right : left;
      contradictions.push({
        skills: [firstSkill, secondSkill],
        directives: [first.source, second.source],
      });
    }
  }

  return contradictions;
}

async function snapshotDirectory(root: string): Promise<SkillsSnapshot> {
  const files = new Map<string, Buffer>();
  try {
    const details = await stat(root);
    if (!details.isDirectory()) return { exists: false, files };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, files };
    throw error;
  }

  const walk = async (relative: string) => {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const next = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next);
      } else if (entry.isFile()) {
        files.set(next, await readFile(join(root, next)));
      }
    }
  };
  await walk("");
  return { exists: true, files };
}

async function restoreDirectory(root: string, snapshot: SkillsSnapshot): Promise<void> {
  await rm(root, { recursive: true, force: true });
  if (!snapshot.exists) return;
  for (const [relative, bytes] of snapshot.files) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}

/** The server stop handler is synchronous, so it restores without awaiting. */
function restoreDirectorySync(root: string, snapshot: SkillsSnapshot): void {
  rmSync(root, { recursive: true, force: true });
  if (!snapshot.exists) return;
  for (const [relative, bytes] of snapshot.files) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

async function managedSkillNames(root: string, snapshot: SkillsSnapshot): Promise<Set<string>> {
  const names = new Set<string>();
  for (const relative of snapshot.files.keys()) {
    const [directory, ...rest] = relative.split("/");
    if (directory === undefined || rest.length !== 1 || rest[0] !== "SKILL.md") continue;
    const skill = await readSkillAt(root, directory);
    if (skill?.managed === true) names.add(directory);
  }
  return names;
}

interface SkillsInspection {
  skills: SkillSummary[];
  managed: Map<string, SkillFile>;
  unmanaged: Map<string, SkillFile>;
  errors: string[];
  contradictions: SkillContradiction[];
}

async function inspectSkills(root: string): Promise<SkillsInspection> {
  const managed = new Map<string, SkillFile>();
  const unmanaged = new Map<string, SkillFile>();

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { skills: [], managed, unmanaged, errors: [], contradictions: [] };
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await readSkillAt(root, entry.name);
    if (skill === undefined) continue;
    if (skill.managed) {
      managed.set(entry.name, skill);
    } else {
      unmanaged.set(entry.name, skill);
    }
  }

  const errors: string[] = [];
  for (const [directory, skill] of managed) {
    const label = `"${directory}"`;
    if (skill.name !== directory) {
      errors.push(`skill ${label} has frontmatter name "${skill.name}", not the directory name.`);
    } else if (!SKILL_NAME_PATTERN.test(skill.name) || skill.name.length > SKILL_NAME_MAX) {
      errors.push(
        `skill ${label} has an invalid name: use 1-${SKILL_NAME_MAX} lowercase letters, digits, or single hyphens.`,
      );
    }
    if (skill.description.trim().length === 0) {
      errors.push(`skill ${label} has an empty description.`);
    } else if (skill.description.length > SKILL_DESCRIPTION_MAX) {
      errors.push(
        `skill ${label} has a description longer than ${SKILL_DESCRIPTION_MAX} characters.`,
      );
    }
  }

  const skills = [...managed.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({ name: skill.name, description: skill.description }));
  const contradictions = findContradictions([...managed.values(), ...unmanaged.values()]);
  return { skills, managed, unmanaged, errors, contradictions };
}

function describeContradictions(
  contradictions: SkillContradiction[],
  managed: Map<string, SkillFile>,
): string {
  return contradictions
    .map((contradiction) => {
      const [first, second] = contradiction.skills;
      const unmanaged = [first, second].filter((name) => !managed.has(name));
      const owner =
        unmanaged.length === 0
          ? "two managed skills"
          : `unmanaged skill ${unmanaged.map((name) => `"${name}"`).join(" and ")}`;
      return `Contradiction between "${first}" and "${second}" (${owner}): "${contradiction.directives[0]}" vs "${contradiction.directives[1]}".`;
    })
    .join(" ");
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  repoDir: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<GitResult> {
  try {
    const child = Bun.spawn({
      cmd: ["git", "-C", repoDir, ...args],
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The exact top-level names a reset keeps, plus a differently named goal file. */
function resetKeepSet(repoDir: string, goalFile: string): Set<string> {
  const names = new Set<string>(RESET_KEEP_NAMES);
  const goal = resolve(goalFile);
  if (dirname(goal) === resolve(repoDir) && basename(goal) !== "GOAL.md") {
    names.add(basename(goal));
  }
  return names;
}

/**
 * Names the project in the page heading. A project inside the user's home
 * directory is shown by its path relative to it, so the heading identifies
 * which checkout this interface serves; anything else keeps its absolute
 * path so two projects sharing a directory name stay distinct.
 */
export function projectLabel(repoDir: string, home: string = homedir()): string {
  const root = resolve(repoDir);
  const relativePath = relative(resolve(home), root);
  if (relativePath.length === 0) return root;
  const [first] = relativePath.split(sep);
  if (first === ".." || isAbsolute(relativePath)) return root;
  return relativePath;
}

export function createApp(options: AppOptions) {
  const staticRoot = resolve(options.staticDir);
  const adrDir = resolve(options.adrDir);
  const repoDir = options.repoDir ?? dirname(adrDir);
  const project = projectLabel(repoDir);
  const goalFile = options.goalFile ?? defaultGoalPath(repoDir);
  // The creation skill always writes the repository's goal document, while
  // getGoal and saveGoal keep using the configured goal file.
  const creationGoalFile = defaultGoalPath(repoDir);
  const skillsDir = join(repoDir, ".omp", "skills");
  const agentCommand = options.agentCommand ?? process.env.AGENT_COMMAND ?? "omp acp";
  const tracker = options.tracker ?? findOpenEpics;
  const trackerSettle: TrackerSettle = {
    attempts: Math.max(1, options.trackerSettle?.attempts ?? TRACKER_SETTLE_ATTEMPTS),
    delayMs: Math.max(0, options.trackerSettle?.delayMs ?? TRACKER_SETTLE_DELAY_MS),
  };
  const laneBackoffMs = Math.max(0, options.laneBackoffMs ?? LANE_BACKOFF_MS);
  const mainPollMs = Math.max(10, options.mainPollMs ?? MAIN_POLL_MS);
  const feedbackCommand = options.feedback?.ghCommand ?? ["gh"];
  const feedbackTimeoutMs = Math.max(1, options.feedback?.timeoutMs ?? FEEDBACK_TIMEOUT_MS);
  const feedbackEnv = options.feedback?.env;
  // The pass belongs to this checkout, not to the harness installation: hosts
  // share one harness through a symlink, so the repository path keys the file.
  const stateDir = resolve(options.stateDir ?? join(import.meta.dir, "..", ".tmp"));
  const passStateFile = join(
    stateDir,
    `lifecycle-pass-${createHash("sha256").update(repoDir).digest("hex").slice(0, 24)}`,
  );
  const runningRevision = gitRevision(runningHarnessDir());
  const readVersion = options.versionState ?? (() => serverVersion(repoDir, runningRevision));

  function readPersistedPass(): number {
    try {
      const pass = Number.parseInt(readFileSync(passStateFile, "utf8").trim(), 10);
      return Number.isInteger(pass) && pass > 0 ? pass : 1;
    } catch {
      return 1;
    }
  }

  let persistedPass = readPersistedPass();
  function persistPass() {
    if (lifecycle.pass === persistedPass) return;
    persistedPass = lifecycle.pass;
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(passStateFile, `${lifecycle.pass}\n`);
    } catch {
      // A read-only state directory must not stop the lifecycle; the next
      // process then starts from the last pass it could record.
    }
  }

  const clients = new Set<ServerWebSocket<unknown>>();
  let sequencing = false;
  /**
   * A manual ADR sequence started from the interface. When the lifecycle is
   * paused, its lanes stay suspended and keep their tabs while this sequence
   * resolves records; the lifecycle never advances until it is resumed.
   */
  let manualRun: ActiveRun | undefined;
  let manualSequencing = false;
  /** Invalidates an in-flight manual start when a reset takes over. */
  let manualStartRequest = 0;
  let goalRevision: GoalRevision | undefined;
  let goalCreation: GoalCreation | undefined;
  let goalCreationRequest = 0;
  let skillsPreparation: SkillsPreparation | undefined;
  let skillsPreparationPending = false;
  /** Invalidates an in-flight preparation when a reset takes over. */
  let skillsPreparationRequest = 0;
  /** Resolves when the in-flight preparation has unwound and cleaned up. */
  let skillsPreparationSettled: Promise<void> | undefined;
  let lifecycle: LifecycleState = {
    stage: "goal",
    pass: persistedPass,
    work: null,
    paused: false,
  };
  let lastLifecycle: LifecycleState | undefined;
  let lifecycleRunning = false;
  /** True while a manual ADR start has taken the slot from a running lifecycle. */
  let lifecyclePausedForManualRun = false;
  /** Resolves when a stopped lifecycle loop has finished unwinding. */
  let lifecycleUnwinding: Promise<void> | undefined;
  let settleLifecycleUnwinding: (() => void) | undefined;
  let restarting = false;
  /** Invalidates an in-flight lifecycle start when a reset takes over. */
  let lifecycleStartRequest = 0;
  let implementationReset: { commit?: string } | undefined;
  const resumeWaiters: (() => void)[] = [];

  // A lifecycle run owns these. Every lane keeps its tab for the whole run;
  // stopped lanes stay in `lanes` beside the attempt that replaces them.
  let lanes: Lane[] = [];
  const liveLanes = new Set<Lane>();
  const epicStates = new Map<string, EpicState>();
  const parkedEpics = new Set<string>();
  let knownEpics = new Map<string, OpenEpic>();
  let laneSequence = 0;
  let generationActive = false;
  let generationQueued = false;
  /** True once a generation pass has run since the last work or refill trigger. */
  let generationAttempted = false;
  const lifecycleWaiters: (() => void)[] = [];
  let mainTimer: Timer | undefined;
  let mainPolling = false;

  function send(ws: { send(data: string): unknown }, event: unknown) {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // The socket closed between accepting the message and sending the reply.
    }
  }

  function broadcast(event: unknown) {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {
        // A closing client must not interrupt delivery to the others.
      }
    }
  }

  function sendVersion(ws: { send(data: string): unknown }) {
    send(ws, { type: "versionState", ...readVersion() });
  }

  /**
   * Hands the process to its launcher. The event leaves first so a browser
   * stops reconnecting and waits for the replacement instead.
   */
  function restartServer(ws: { send(data: string): unknown }) {
    if (options.restart === undefined) {
      send(ws, { type: "error", message: "Restarting the server is not available." });
      return;
    }
    if (restarting) {
      send(ws, { type: "error", message: "A server restart is already in progress." });
      return;
    }
    restarting = true;
    broadcast({ type: "serverRestarting" });
    try {
      options.restart();
    } catch (error) {
      restarting = false;
      send(ws, {
        type: "error",
        message: `Could not restart the server: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  /**
   * Streamed deltas extend the last activity line; a new message, tool call, or
   * plan starts one. The store keeps whole lines so a reconnect replays them as
   * they were shown.
   */
  function recordActivity(store: string[], activity: AcpActivity) {
    if (activity.append && store.length > 0) {
      store[store.length - 1] += activity.text;
      broadcast({ type: "activity", text: activity.text, append: true });
      return;
    }
    store.push(activity.text);
    broadcast({ type: "activity", text: activity.text });
  }

  /**
   * Records one lane's streamed output. Every event names its lane, so two
   * peers streaming at once never share a line; a line beginning with the
   * blocker marker parks the lane when its turn ends.
   */
  function recordLaneActivity(lane: Lane, activity: AcpActivity) {
    if (!liveLanes.has(lane)) return;
    if (activity.append && lane.activity.length > 0) {
      lane.activity[lane.activity.length - 1] += activity.text;
      broadcast({ type: "activity", lane: lane.id, text: activity.text, append: true });
    } else {
      lane.activity.push(activity.text);
      broadcast({ type: "activity", lane: lane.id, text: activity.text });
    }
    if (lane.activity.some((line) => line.startsWith(BLOCKER_MARKER))) lane.blocked = true;
  }

  function sendRunConversation(
    target: { send(data: string): unknown },
    run: ActiveRun,
    manual = false,
  ) {
    send(target, {
      type: "runStarted",
      file: run.file,
      title: run.title,
      action: run.action,
      ...(manual ? { manual: true } : {}),
    });
    for (const text of run.activity) send(target, { type: "activity", text });
    if (run.question !== null) {
      send(target, {
        type: "question",
        id: run.question.id,
        message: run.question.message,
        options: run.question.options,
      });
    }
  }

  function isLiveRun(run: ActiveRun): boolean {
    return manualRun === run;
  }

  /** Ends a manual sequence and closes its peer without touching the lifecycle. */
  function abortManualRun(): boolean {
    let stopped = manualSequencing;
    manualSequencing = false;
    const run = manualRun;
    if (run === undefined) return stopped;
    manualRun = undefined;
    run.question = null;
    run.agent?.close();
    broadcast({
      type: "runStopped",
      file: run.file,
      title: run.title,
      resolved: false,
      status: "",
    });
    return true;
  }

  async function readRecord(file: string): Promise<AdrRecord | undefined> {
    try {
      return parseRecord(file, await readFile(join(adrDir, file), "utf8"));
    } catch {
      return undefined;
    }
  }

  async function getGoal(ws: { send(data: string): unknown }) {
    try {
      send(ws, { type: "goal", text: await readGoal(goalFile) });
    } catch (error) {
      // An absent goal document is an unset goal, so the section offers the
      // creation control instead of an error.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        send(ws, { type: "goal", text: "" });
        return;
      }
      send(ws, {
        type: "error",
        message: `Could not read the goal: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function saveGoal(ws: { send(data: string): unknown }, text: unknown) {
    if (skillsPreparation !== undefined || skillsPreparationPending) {
      send(ws, { type: "error", message: "A skills preparation is active." });
      return;
    }

    if (lifecycleRunning && !lifecycle.paused) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    if (typeof text !== "string") {
      send(ws, { type: "error", message: "saveGoal needs the goal text." });
      return;
    }

    try {
      await writeGoal(goalFile, text);
      send(ws, { type: "goal", text });
    } catch (error) {
      send(ws, {
        type: "error",
        message: `Could not save the goal: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function stopGoalRevision(revision: GoalRevision, succeeded: boolean) {
    if (goalRevision !== revision) return;
    goalRevision = undefined;
    revision.question = null;
    revision.agent?.close();

    if (!succeeded) {
      broadcast({ type: "goalRevisionStopped", completed: false });
      return;
    }

    try {
      const text = await readGoal(goalFile);
      broadcast({ type: "goalRevisionStopped", completed: true, text });
    } catch (error) {
      broadcast({
        type: "error",
        message: `Could not read the revised goal: ${error instanceof Error ? error.message : String(error)}`,
      });
      broadcast({ type: "goalRevisionStopped", completed: false });
    }
  }

  async function stopGoalCreation(creation: GoalCreation, succeeded: boolean) {
    if (goalCreation !== creation) return;
    goalCreation = undefined;
    creation.question = null;
    creation.agent?.close();

    if (!succeeded) {
      broadcast({ type: "goalCreationStopped", completed: false });
      return;
    }

    let text: string;
    try {
      text = await readFile(creationGoalFile, "utf8");
    } catch (error) {
      broadcast({
        type: "error",
        message: `Could not read the created goal: ${error instanceof Error ? error.message : String(error)}`,
      });
      broadcast({ type: "goalCreationStopped", completed: false });
      return;
    }

    if (text.trim().length === 0) {
      broadcast({
        type: "error",
        message: "The goal creation ended without a non-empty goal.",
      });
      broadcast({ type: "goalCreationStopped", completed: false });
      return;
    }

    broadcast({ type: "goalCreationStopped", completed: true, text });
  }

  async function sendSkillsState(target: { send(data: string): unknown }) {
    try {
      const inspection = await inspectSkills(skillsDir);
      send(target, {
        type: "skillsState",
        skills: inspection.skills,
        contradictions: inspection.contradictions,
      });
    } catch (error) {
      send(target, {
        type: "error",
        message: `Could not read the installed skills: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Ends one preparation. A failure restores the pre-run skills directory
   * byte for byte, so managed skills keep their previous contents and no
   * generated skill survives.
   */
  async function stopSkillsPreparation(preparation: SkillsPreparation, succeeded: boolean) {
    if (skillsPreparation !== preparation) return;
    skillsPreparation = undefined;
    preparation.question = null;
    preparation.agent?.close();

    if (!succeeded) {
      try {
        await restoreDirectory(skillsDir, preparation.snapshot);
      } catch (error) {
        broadcast({
          type: "error",
          message: `Could not restore the previous skills: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      broadcast({ type: "skillsPreparationStopped", completed: false });
    }
  }

  async function finishSkillsPreparation(preparation: SkillsPreparation) {
    if (skillsPreparation !== preparation) return;

    let inspection: SkillsInspection;
    let current: SkillsSnapshot;
    try {
      inspection = await inspectSkills(skillsDir);
      current = await snapshotDirectory(skillsDir);
    } catch (error) {
      if (skillsPreparation !== preparation) return;
      broadcast({
        type: "error",
        message: `Could not read the prepared skills: ${error instanceof Error ? error.message : String(error)}`,
      });
      await stopSkillsPreparation(preparation, false);
      return;
    }
    // A reset cancels the preparation while the result is being read; the
    // reset owns the skills directory from that point.
    if (skillsPreparation !== preparation) return;

    const errors = [...inspection.errors];
    if (inspection.managed.size === 0) {
      errors.push("no managed skill was prepared.");
    }

    // Unmanaged skills are outside this feature's write scope. Any byte
    // change or deletion of one fails the run before success is reported.
    const changed = new Set<string>();
    for (const relative of preparation.snapshot.files.keys()) {
      const directory = relative.split("/")[0];
      if (directory === undefined || !preparation.unmanagedNames.has(directory)) continue;
      const before = preparation.snapshot.files.get(relative);
      const after = current.files.get(relative);
      if (before === undefined || after === undefined || !before.equals(after)) {
        changed.add(directory);
      }
    }
    for (const name of [...changed].sort()) {
      errors.push(`unmanaged skill "${name}" must not be changed by skills preparation.`);
    }
    for (const name of [...inspection.managed.keys()].sort()) {
      if (preparation.unmanagedNames.has(name)) {
        errors.push(`managed skill "${name}" collides with an unmanaged skill of the same name.`);
      }
    }

    const contradictions = inspection.contradictions;
    if (errors.length > 0) {
      broadcast({ type: "error", message: `Skills preparation failed: ${errors.join(" ")}` });
      await stopSkillsPreparation(preparation, false);
      return;
    }
    if (contradictions.length > 0) {
      broadcast({
        type: "error",
        message: `Skills preparation failed: ${describeContradictions(contradictions, inspection.managed)}`,
      });
      await stopSkillsPreparation(preparation, false);
      return;
    }

    skillsPreparation = undefined;
    preparation.question = null;
    preparation.agent?.close();
    broadcast({
      type: "skillsPreparationStopped",
      completed: true,
      skills: inspection.skills,
      contradictions: [],
    });
  }

  async function startSkillsPreparation(ws: { send(data: string): unknown }) {
    if (skillsPreparation !== undefined || skillsPreparationPending) {
      send(ws, { type: "error", message: "A skills preparation is already active." });
      return;
    }

    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
      return;
    }

    if (lifecycleRunning) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    if (manualRun !== undefined || sequencing || manualSequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    // Claim the start before the first await so two commands cannot both
    // snapshot, spawn a peer, and race to own the same preparation. A reset
    // advances the request to cancel whatever point this preparation reached.
    const request = ++skillsPreparationRequest;
    const settled = Promise.withResolvers<void>();
    skillsPreparationSettled = settled.promise;
    const cancelled = () => request !== skillsPreparationRequest;

    try {
      skillsPreparationPending = true;

      let goalText: string;
      try {
        goalText = await readGoal(goalFile);
      } catch (error) {
        if (cancelled()) return;
        skillsPreparationPending = false;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          send(ws, {
            type: "error",
            message: "The goal is not set. Save a non-empty goal before preparing skills.",
          });
          return;
        }
        send(ws, {
          type: "error",
          message: `Could not read the goal: ${error instanceof Error ? error.message : String(error)}`,
        });
        send(ws, { type: "skillsPreparationStopped", completed: false });
        return;
      }
      if (cancelled()) return;
      if (goalText.trim().length === 0) {
        skillsPreparationPending = false;
        send(ws, {
          type: "error",
          message: "The goal is not set. Save a non-empty goal before preparing skills.",
        });
        return;
      }

      let snapshot: SkillsSnapshot;
      let managedNames: Set<string>;
      let unmanagedNames: Set<string>;
      try {
        snapshot = await snapshotDirectory(skillsDir);
        managedNames = await managedSkillNames(skillsDir, snapshot);
        unmanagedNames = new Set((await inspectSkills(skillsDir)).unmanaged.keys());
      } catch (error) {
        if (cancelled()) return;
        skillsPreparationPending = false;
        send(ws, {
          type: "error",
          message: `Could not read the installed skills: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (cancelled()) return;

      try {
        // The feature owns every managed skill: a run replaces the whole set
        // rather than merging with what an earlier run left behind.
        for (const name of managedNames) {
          await rm(join(skillsDir, name), { recursive: true, force: true });
          if (cancelled()) {
            await restoreDirectory(skillsDir, snapshot);
            return;
          }
        }
      } catch (error) {
        if (cancelled()) {
          await restoreDirectory(skillsDir, snapshot);
          return;
        }
        skillsPreparationPending = false;
        await restoreDirectory(skillsDir, snapshot);
        send(ws, {
          type: "error",
          message: `Could not replace the managed skills: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (cancelled()) {
        await restoreDirectory(skillsDir, snapshot);
        return;
      }
      skillsPreparationPending = false;

      const preparation: SkillsPreparation = {
        agent: undefined,
        activity: [],
        question: null,
        snapshot,
        unmanagedNames,
      };
      skillsPreparation = preparation;
      broadcast({ type: "skillsPreparationStarted" });

      try {
        const agent = new AcpConnection({
          command: agentCommand,
          cwd: repoDir,
          onActivity(activity) {
            if (skillsPreparation !== preparation) return;
            recordActivity(preparation.activity, activity);
          },
          onQuestion(question: AcpQuestion) {
            if (skillsPreparation !== preparation) return;
            preparation.question = {
              id: question.id,
              message: question.message,
              options: question.options,
            };
            broadcast({
              type: "question",
              id: question.id,
              message: question.message,
              options: question.options,
            });
          },
          onStderr(text) {
            process.stderr.write(text);
          },
        });
        preparation.agent = agent;

        await agent.run(SKILLS_PROMPT);
        if (skillsPreparation !== preparation) return;
        await finishSkillsPreparation(preparation);
      } catch (error) {
        if (skillsPreparation !== preparation) return;
        broadcast({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        await stopSkillsPreparation(preparation, false);
      }
    } finally {
      settled.resolve();
      if (skillsPreparationSettled === settled.promise) skillsPreparationSettled = undefined;
    }
  }

  /** Cancels an in-flight creation; the peer's later completion is ignored. */
  function abortGoalCreation() {
    const creation = goalCreation;
    if (creation === undefined) return;
    goalCreation = undefined;
    creation.question = null;
    creation.agent?.close();
    broadcast({ type: "goalCreationStopped", completed: false });
  }

  /** Cancels an in-flight revision; the peer's later completion is ignored. */
  function abortGoalRevision() {
    const revision = goalRevision;
    if (revision === undefined) return;
    goalRevision = undefined;
    revision.question = null;
    revision.agent?.close();
    broadcast({ type: "goalRevisionStopped", completed: false });
  }

  /**
   * Stops the run or lifecycle the creation would contend with. A paused
   * lifecycle keeps its suspended peer, which creation already coexists with;
   * a manual ADR run started while it is paused is stopped.
   */
  function abortActiveRun(): boolean {
    // Invalidate a manual start still validating records before creation takes
    // the checkout over.
    manualStartRequest += 1;
    let stopped = abortManualRun();

    if (lifecycleRunning && lifecycle.paused) {
      lifecyclePausedForManualRun = false;
      return stopped;
    }

    if (lifecycleRunning) {
      lifecyclePausedForManualRun = false;
      lifecycleRunning = false;
      lifecycle = { stage: "goal", pass: lifecycle.pass, work: null, paused: false };
      clearLaneState();
      publishLifecycle();
      for (const resolve of resumeWaiters.splice(0)) resolve();
      stopped = true;
    }

    if (sequencing) {
      sequencing = false;
      stopped = true;
    }

    return stopped;
  }

  async function startGoalCreation(ws: { send(data: string): unknown }) {
    if (skillsPreparation !== undefined || skillsPreparationPending) {
      send(ws, { type: "error", message: "A skills preparation is active." });
      return;
    }

    const request = ++goalCreationRequest;

    try {
      await readFile(creationGoalFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (request === goalCreationRequest) {
          send(ws, {
            type: "error",
            message: `Could not read the goal: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
    }

    // A newer request issued during the read owns the creation.
    if (request !== goalCreationRequest) return;

    // A creation request always wins: it replaces an existing goal and any
    // creation, revision, or run that would contend with the new peer.
    abortGoalCreation();
    abortGoalRevision();
    const stoppedRun = abortActiveRun();

    if (stoppedRun) {
      try {
        broadcast({ type: "records", ...(await readRecords(adrDir)) });
      } catch {
        // The run is already stopped; a record read failure does not block creation.
      }
      if (request !== goalCreationRequest) return;
    }

    const creation: GoalCreation = { agent: undefined, activity: [], question: null };
    goalCreation = creation;
    broadcast({ type: "goalCreationStarted" });

    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(activity) {
          if (goalCreation !== creation) return;
          recordActivity(creation.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          if (goalCreation !== creation) return;
          creation.question = {
            id: question.id,
            message: question.message,
            options: question.options,
          };
          broadcast({
            type: "question",
            id: question.id,
            message: question.message,
            options: question.options,
          });
        },
        onStderr(text) {
          process.stderr.write(text);
        },
      });
      creation.agent = agent;

      await agent.run(GOAL_CREATION_PROMPT);
      if (goalCreation !== creation) return;
      await stopGoalCreation(creation, true);
    } catch (error) {
      if (goalCreation !== creation) return;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      await stopGoalCreation(creation, false);
    }
  }

  async function startGoalRevision(ws: { send(data: string): unknown }, request: unknown) {
    if (skillsPreparation !== undefined || skillsPreparationPending) {
      send(ws, { type: "error", message: "A skills preparation is active." });
      return;
    }

    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (lifecycleRunning && !lifecycle.paused) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is already active." });
      return;
    }

    // A paused lifecycle keeps its lanes suspended; only a manual run or
    // sequence that the revision would contend with refuses the start.
    if (manualRun !== undefined || manualSequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    if (!(lifecycleRunning && lifecycle.paused) && sequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    if (request !== undefined && typeof request !== "string") {
      send(ws, { type: "error", message: "reviseGoal needs the guidance text." });
      return;
    }

    const revision: GoalRevision = { agent: undefined, activity: [], question: null };
    goalRevision = revision;
    broadcast({ type: "goalRevisionStarted" });

    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(activity) {
          if (goalRevision !== revision) return;
          recordActivity(revision.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          if (goalRevision !== revision) return;
          revision.question = {
            id: question.id,
            message: question.message,
            options: question.options,
          };
          broadcast({
            type: "question",
            id: question.id,
            message: question.message,
            options: question.options,
          });
        },
        onStderr(text) {
          process.stderr.write(text);
        },
      });
      revision.agent = agent;

      await agent.run(
        goalRevisionPrompt(goalFile, typeof request === "string" ? request : undefined),
      );
      if (goalRevision !== revision) return;
      await stopGoalRevision(revision, true);
    } catch (error) {
      if (goalRevision !== revision) return;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      await stopGoalRevision(revision, false);
    }
  }

  async function runAgent(run: ActiveRun, prompt = agentPrompt(adrDir, run.file)): Promise<boolean> {
    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(activity) {
          if (!isLiveRun(run)) return;
          recordActivity(run.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          if (!isLiveRun(run)) return;
          run.question = {
            id: question.id,
            message: question.message,
            options: question.options,
          };
          broadcast({
            type: "question",
            id: question.id,
            message: question.message,
            options: question.options,
          });
        },
        onStderr(text) {
          process.stderr.write(text);
        },
      });
      run.agent = agent;

      await agent.run(prompt);
      const record = await readRecord(run.file);
      return await stopRun(run, record !== undefined && !record.pending, record?.status ?? "");
    } catch (error) {
      if (!isLiveRun(run)) return false;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      const record = await readRecord(run.file);
      return await stopRun(run, record !== undefined && !record.pending, record?.status ?? "");
    }
  }

  async function stopRun(run: ActiveRun, resolved: boolean, status: string): Promise<boolean> {
    if (manualRun !== run) return false;
    manualRun = undefined;
    run.question = null;
    run.agent?.close();

    broadcast({
      type: "runStopped",
      file: run.file,
      title: run.title,
      resolved,
      status,
    });

    try {
      const list = await readRecords(adrDir);
      broadcast({ type: "records", ...list });
    } catch (error) {
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    return resolved;
  }

  async function startRun(ws: { send(data: string): unknown }, file: unknown) {
    if (skillsPreparation !== undefined || skillsPreparationPending) {
      send(ws, { type: "error", message: "A skills preparation is active." });
      return;
    }

    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
      return;
    }

    if (manualRun !== undefined || manualSequencing || sequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    const request = ++manualStartRequest;
    let selected = typeof file === "string" ? file : undefined;

    // A manual start takes the single agent slot from an advancing lifecycle.
    // Validate the record first so a start that cannot run leaves the
    // lifecycle advancing, then pause it so its stage and conversation stay
    // resumable while this peer works.
    if (lifecycleRunning && !lifecycle.paused) {
      let record: AdrRecord | undefined;
      try {
        const list = await readRecords(adrDir);
        record =
          selected === undefined
            ? list.records.find((candidate) => candidate.file === list.next)
            : list.records.find(
                (candidate) => candidate.file === selected && candidate.pending,
              );
      } catch (error) {
        send(ws, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (request !== manualStartRequest) return;

      if (record === undefined) {
        send(ws, {
          type: "error",
          message:
            selected === undefined ? "No pending ADRs to start." : "That ADR is not pending.",
        });
        return;
      }

      if (
        lifecycle.stage === "adr" &&
        lifecycle.work?.kind === "adr" &&
        lifecycle.work.id === record.file
      ) {
        send(ws, { type: "error", message: "The lifecycle is already resolving that ADR." });
        return;
      }

      pauseLifecycle(ws);
      lifecyclePausedForManualRun = true;
    }

    manualSequencing = true;
    let first = true;

    try {
      while (manualSequencing) {
        const list = await readRecords(adrDir);
        let record: AdrRecord | undefined;

        if (selected !== undefined) {
          record = list.records.find(
            (candidate) => candidate.file === selected && candidate.pending,
          );
          selected = undefined;
          if (record === undefined) {
            send(ws, { type: "error", message: "That ADR is not pending." });
            return;
          }
        } else {
          record = list.records.find((candidate) => candidate.file === list.next);
          if (record === undefined) {
            if (first) send(ws, { type: "error", message: "No pending ADRs to start." });
            return;
          }
        }

        first = false;
        // A creation request clears the sequence; never start another record.
        if (!manualSequencing) return;

        // The suspended lifecycle peer keeps its record; a manual peer must
        // not write the same file behind it.
        if (
          lifecycleRunning &&
          lifecycle.paused &&
          lifecycle.stage === "adr" &&
          lifecycle.work?.kind === "adr" &&
          lifecycle.work.id === record.file
        ) {
          send(ws, { type: "error", message: "The lifecycle is already resolving that ADR." });
          return;
        }

        const run: ActiveRun = {
          file: record.file,
          title: record.title,
          action: "resolving",
          agent: undefined,
          activity: [],
          question: null,
        };
        manualRun = run;
        broadcast({
          type: "runStarted",
          file: run.file,
          title: run.title,
          action: run.action,
          manual: true,
        });

        const resolved = await runAgent(run);
        if (!resolved) return;
      }
    } catch (error) {
      send(ws, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // A creation or reset clears the sequence to take the checkout over.
      const interrupted = !manualSequencing;
      manualSequencing = false;
      if (interrupted) {
        lifecyclePausedForManualRun = false;
      } else if (lifecyclePausedForManualRun) {
        // The interface controls the lifecycle with one start/stop button, so
        // the suspension this manual sequence needed ends with the sequence
        // instead of waiting for a resume the interface no longer offers.
        lifecyclePausedForManualRun = false;
        if (lifecycleRunning && lifecycle.paused) resumeLifecycle(ws);
      }
    }
  }

  /** Broadcasts the current state, retains it for later clients, and records the pass. */
  function publishLifecycle(force = false) {
    persistPass();
    if (
      !force &&
      lastLifecycle !== undefined &&
      lastLifecycle.stage === lifecycle.stage &&
      lastLifecycle.pass === lifecycle.pass &&
      lastLifecycle.paused === lifecycle.paused &&
      lastLifecycle.work?.kind === lifecycle.work?.kind &&
      lastLifecycle.work?.id === lifecycle.work?.id &&
      lastLifecycle.work?.url === lifecycle.work?.url
    ) {
      return;
    }
    lastLifecycle = lifecycle;
    broadcast({ type: "lifecycleState", ...lifecycle });
  }

  function setLifecycle(stage: LifecycleStage, work: LifecycleWork | null) {
    lifecycle = { stage, pass: lifecycle.pass, work, paused: lifecycle.paused };
    publishLifecycle();
  }

  /** Holds the lifecycle loop at the current stage until an explicit resume. */
  async function holdWhilePaused() {
    while (lifecycleRunning && lifecycle.paused) {
      const { promise, resolve } = Promise.withResolvers<void>();
      resumeWaiters.push(resolve);
      await promise;
    }
  }

  /** Wakes the scheduler after a lane, retry, or refill changes the state. */
  function wakeLifecycle() {
    for (const resolve of lifecycleWaiters.splice(0)) resolve();
  }

  /**
   * Waits for a lane event, a retry timer, or a short tick. The tick is a
   * safety net: every other wake has an owner, so a lost wake cannot hang the
   * run while a peer needs attention.
   */
  async function waitForLifecycleChange(): Promise<void> {
    if (!lifecycleRunning) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    lifecycleWaiters.push(resolve);
    const timer = setTimeout(resolve, 250);
    await promise;
    clearTimeout(timer);
    const index = lifecycleWaiters.indexOf(resolve);
    if (index >= 0) lifecycleWaiters.splice(index, 1);
  }

  function laneTitle(lane: Lane): string {
    if (lane.kind === "generation") return EPIC_GENERATION_TITLE;
    if (lane.kind === "adr") return lane.record?.title ?? "";
    return lane.epic?.title ?? "";
  }

  function laneAction(lane: Lane): RunAction {
    if (lane.kind === "generation") return "generating";
    if (lane.kind === "adr") return "resolving";
    return "implementing";
  }

  function laneSnapshot() {
    const runningLanes = lanes.filter(
      (lane) => lane.kind === "implementation" && lane.status === "running",
    ).length;
    return {
      type: "laneState",
      lanes: lanes.map((lane) => ({
        id: lane.id,
        kind: lane.kind,
        epic: lane.epic,
        record: lane.record,
        attempt: lane.attempt,
        status: lane.status,
        activity: [...lane.activity],
        question: lane.question,
      })),
      openEpics: knownEpics.size,
      runningLanes,
    };
  }

  function publishLanes() {
    broadcast(laneSnapshot());
  }

  function publishLaneSnapshot(target: { send(data: string): unknown }) {
    send(target, laneSnapshot());
  }

  function applyEpicList(list: OpenEpic[]) {
    knownEpics = new Map(list.map((epic) => [String(epic.number), epic]));
    publishLanes();
  }

  async function readEpicList(): Promise<OpenEpic[]> {
    return normalizeEpics(await tracker(repoDir));
  }

  /**
   * Re-reads the tracker while its answer could still be the pre-peer state.
   * `stale` names an answer that a tracker write has not replaced yet. Pause
   * holds the loop before the next read, and a stopped run returns without
   * another read.
   */
  async function settleEpicList(stale: (list: OpenEpic[]) => boolean): Promise<OpenEpic[]> {
    let list = await readEpicList();
    for (let attempt = 1; attempt < trackerSettle.attempts && stale(list); attempt += 1) {
      await Bun.sleep(trackerSettle.delayMs);
      await holdWhilePaused();
      if (!lifecycleRunning) return list;
      list = await readEpicList();
    }
    return list;
  }

  function hasRetryingEpic(): boolean {
    return [...epicStates.values()].some((state) => state.status === "retrying");
  }

  function liveImplementationFor(id: string): boolean {
    return [...liveLanes].some(
      (lane) => lane.kind === "implementation" && String(lane.epic?.number) === id,
    );
  }

  function clearRetry(state: EpicState) {
    if (state.timer === undefined) return;
    clearTimeout(state.timer);
    state.timer = undefined;
  }

  /** Reports the stage implied by the live lanes, without duplicating a state. */
  function publishStage() {
    if (!lifecycleRunning) return;
    const implementations = [...liveLanes].filter((lane) => lane.kind === "implementation");
    const adr = [...liveLanes].find((lane) => lane.kind === "adr");
    const generating = [...liveLanes].some((lane) => lane.kind === "generation");

    if (implementations.length > 0) {
      const epic = implementations.length === 1 ? implementations[0]?.epic : null;
      setLifecycle(
        "implementation",
        epic == null
          ? null
          : {
              kind: "epic",
              id: String(epic.number),
              ...(epic.url.length === 0 ? {} : { url: epic.url }),
            },
      );
      return;
    }
    if (adr !== undefined) {
      setLifecycle("adr", { kind: "adr", id: adr.record?.file ?? "" });
      return;
    }
    if (
      [...epicStates.values()].some(
        (state) =>
          state.status === "running" || state.status === "retrying" || state.status === "parked",
      )
    ) {
      setLifecycle("implementation", null);
      return;
    }
    if (generating) setLifecycle("epic", null);
  }

  /** Runs one lane's peer and records its question and activity. */
  async function runLanePeer(lane: Lane, prompt: string): Promise<void> {
    broadcast({
      type: "runStarted",
      lane: lane.id,
      kind: lane.kind,
      attempt: lane.attempt,
      file: lane.record?.file ?? "",
      title: laneTitle(lane),
      action: laneAction(lane),
    });
    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(activity) {
          recordLaneActivity(lane, activity);
        },
        onQuestion(question: AcpQuestion) {
          if (!liveLanes.has(lane)) return;
          lane.question = {
            id: question.id,
            message: question.message,
            options: question.options,
          };
          broadcast({
            type: "question",
            lane: lane.id,
            id: question.id,
            message: question.message,
            options: question.options,
          });
          publishLanes();
        },
        onStderr(text) {
          process.stderr.write(text);
        },
      });
      lane.agent = agent;
      if (lifecycle.paused) agent.pause();
      await agent.run(prompt);
    } catch (error) {
      if (liveLanes.has(lane)) {
        lane.failure = error instanceof Error ? error.message : String(error);
        broadcast({ type: "error", lane: lane.id, message: lane.failure });
      }
    } finally {
      lane.agent = undefined;
      lane.question = null;
      liveLanes.delete(lane);
    }
  }

  function broadcastLaneStopped(lane: Lane, resolved: boolean, status: string) {
    broadcast({
      type: "runStopped",
      lane: lane.id,
      file: lane.record?.file ?? "",
      title: laneTitle(lane),
      resolved,
      status,
    });
  }

  /** Starts exactly one implementation lane for the epic, no matter how often it is asked. */
  function startImplementationLane(id: string, attempt: number) {
    if (lifecycle.paused) return;
    const epic = knownEpics.get(id);
    if (epic === undefined || liveImplementationFor(id)) return;

    const state = epicStates.get(id);
    if (state !== undefined) {
      clearRetry(state);
      state.epic = epic;
      state.attempts = attempt;
      state.status = "running";
      state.mainAtFailure = undefined;
    } else {
      epicStates.set(id, {
        epic,
        attempts: attempt,
        status: "running",
        timer: undefined,
        mainAtFailure: undefined,
      });
    }
    parkedEpics.delete(id);
    generationAttempted = false;

    const lane: Lane = {
      id: `lane-${++laneSequence}`,
      kind: "implementation",
      epic,
      record: null,
      attempt,
      status: "running",
      agent: undefined,
      activity: [],
      question: null,
      blocked: false,
      failure: null,
    };
    lanes.push(lane);
    liveLanes.add(lane);
    publishLanes();
    publishStage();

    void (async () => {
      await runLanePeer(lane, `${IMPLEMENT_PROMPT} ${id}`);
      if (!lifecycleRunning) return;

      let list: OpenEpic[];
      try {
        list = await settleEpicList((candidate) =>
          candidate.some((entry) => String(entry.number) === id),
        );
        await holdWhilePaused();
        if (!lifecycleRunning) return;
        applyEpicList(list);
      } catch (error) {
        if (!lifecycleRunning) return;
        broadcast({
          type: "error",
          lane: lane.id,
          message: error instanceof Error ? error.message : String(error),
        });
        list = [...knownEpics.values()];
      }

      if (!lifecycleRunning) return;
      const stillOpen = knownEpics.has(id);
      const current = epicStates.get(id);

      if (!stillOpen) {
        lane.status = "closed";
        if (current !== undefined) {
          clearRetry(current);
        }
        epicStates.delete(id);
        parkedEpics.delete(id);
        broadcastLaneStopped(lane, true, "closed");
        const others = [...liveLanes].some((entry) => entry.kind === "implementation");
        if (others) {
          publishStage();
        } else {
          lifecycle = {
            stage: "epic",
            pass: lifecycle.pass + 1,
            work: null,
            paused: lifecycle.paused,
          };
          publishLifecycle();
        }
        publishLanes();
        requestGeneration();
        return;
      }

      if (current !== undefined) current.epic = knownEpics.get(id) ?? current.epic;
      const stoppedMain = await readMainRevision();
      if (current !== undefined && stoppedMain !== undefined) {
        current.mainAtFailure = stoppedMain;
      }
      if (lane.blocked) {
        lane.status = "parked";
        if (current !== undefined) current.status = "parked";
        parkedEpics.add(id);
        broadcastLaneStopped(lane, false, "parked");
      } else {
        lane.status = "retrying";
        if (current !== undefined) current.status = "retrying";
        broadcast({
          type: "error",
          lane: lane.id,
          message: `Implementation ended but epic #${id} is still open.`,
        });
        broadcastLaneStopped(lane, false, "retrying");
        scheduleRetry(id);
      }
      publishLanes();
      publishStage();
      wakeLifecycle();
    })();
  }

  function scheduleRetry(id: string) {
    const state = epicStates.get(id);
    if (state === undefined || state.timer !== undefined) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void retryEpic(id);
    }, laneBackoffMs);
  }

  async function retryEpic(id: string) {
    await holdWhilePaused();
    if (!lifecycleRunning) return;
    const state = epicStates.get(id);
    if (state === undefined || state.status !== "retrying") return;
    if (liveImplementationFor(id)) return;
    startImplementationLane(id, state.attempts + 1);
  }

  /** Starts a lane for every open epic that does not already own one. */
  function reconcileLanes() {
    for (const [id] of knownEpics) {
      const state = epicStates.get(id);
      if (state === undefined || state.status === "closed") {
        startImplementationLane(id, (state?.attempts ?? 0) + 1);
      }
    }
    for (const [id, state] of [...epicStates]) {
      if (knownEpics.has(id) || liveImplementationFor(id)) continue;
      clearRetry(state);
      epicStates.delete(id);
      parkedEpics.delete(id);
    }
    publishStage();
  }

  /** Runs one epic-generation peer and applies the epics it filed. */
  async function runGenerationPass() {
    if (!lifecycleRunning) return;
    generationAttempted = true;
    const before = new Set(knownEpics.keys());
    const lane: Lane = {
      id: `lane-${++laneSequence}`,
      kind: "generation",
      epic: null,
      record: null,
      attempt: 1,
      status: "running",
      agent: undefined,
      activity: [],
      question: null,
      blocked: false,
      failure: null,
    };
    lanes.push(lane);
    liveLanes.add(lane);
    publishLanes();
    publishStage();

    await runLanePeer(lane, EPIC_PROMPT);
    lane.status = lane.failure === null ? "closed" : "failed";
    broadcastLaneStopped(lane, lane.status === "closed", lane.status);
    publishLanes();
    if (!lifecycleRunning) return;

    try {
      const list = await settleEpicList(
        (candidate) => !candidate.some((entry) => !before.has(String(entry.number))),
      );
      applyEpicList(list);
    } catch (error) {
      broadcast({
        type: "error",
        lane: lane.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Runs one ADR resolution lane and republishes the record list. */
  async function runAdrLane(record: AdrRecord) {
    if (!lifecycleRunning) return;
    const lane: Lane = {
      id: `lane-${++laneSequence}`,
      kind: "adr",
      epic: null,
      record: { file: record.file, title: record.title },
      attempt: 1,
      status: "running",
      agent: undefined,
      activity: [],
      question: null,
      blocked: false,
      failure: null,
    };
    lanes.push(lane);
    liveLanes.add(lane);
    setLifecycle("adr", { kind: "adr", id: record.file });
    publishLanes();

    await runLanePeer(lane, agentPrompt(adrDir, record.file));
    lane.status = lane.failure === null ? "closed" : "failed";
    const current = await readRecord(record.file);
    broadcastLaneStopped(
      lane,
      current !== undefined && !current.pending,
      current?.status ?? "",
    );
    publishLanes();

    try {
      broadcast({ type: "records", ...(await readRecords(adrDir)) });
    } catch (error) {
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Starts the refill scheduler without waiting for the idle lanes. */
  function requestGeneration() {
    generationQueued = true;
    generationAttempted = false;
    wakeLifecycle();
    void drainGenerations();
  }

  /**
   * Runs the queued generation passes one at a time. A request that arrives
   * while a pass is active leaves one follow-up pass queued, never a second
   * concurrent generation peer.
   */
  async function drainGenerations() {
    if (generationActive || !lifecycleRunning) return;
    generationActive = true;
    try {
      while (generationQueued && lifecycleRunning) {
        generationQueued = false;
        await holdWhilePaused();
        if (!lifecycleRunning) return;
        await runGenerationPass();
        reconcileLanes();
        wakeLifecycle();
      }
    } finally {
      generationActive = false;
      wakeLifecycle();
    }
  }

  function stopMainWatcher() {
    if (mainTimer !== undefined) {
      clearInterval(mainTimer);
      mainTimer = undefined;
    }
    mainPolling = false;
  }

  /**
   * Runs a lane again as soon as `main` changes, which is what makes a parked
   * or retrying epic responsive without a fixed attempt cap.
   */
  async function readMainRevision(): Promise<string | undefined> {
    const result = await runGit(repoDir, ["rev-parse", "--verify", "main"]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async function checkMainAdvance() {
    if (!lifecycleRunning || mainPolling) return;
    if (
      ![...epicStates.values()].some(
        (state) => state.status === "retrying" || state.status === "parked",
      )
    ) {
      return;
    }
    mainPolling = true;
    try {
      const value = await readMainRevision();
      if (value === undefined) return;

      await holdWhilePaused();
      if (!lifecycleRunning) return;
      for (const [id, state] of [...epicStates]) {
        if (state.status !== "retrying" && state.status !== "parked") continue;
        if (!knownEpics.has(id) || liveImplementationFor(id)) continue;
        // The lane recorded where main pointed when it stopped; any later
        // revision means the repository changed and the lane runs again.
        if (state.mainAtFailure === undefined) {
          state.mainAtFailure = value;
          continue;
        }
        if (state.mainAtFailure === value) continue;
        clearRetry(state);
        parkedEpics.delete(id);
        startImplementationLane(id, state.attempts + 1);
      }
      wakeLifecycle();
    } finally {
      mainPolling = false;
    }
  }

  function startMainWatcher() {
    stopMainWatcher();
    mainTimer = setInterval(() => {
      void checkMainAdvance();
    }, mainPollMs);
  }

  /** Closes every lane and timer this run owns; reports whether one was live. */
  function stopAllLanes(): boolean {
    stopMainWatcher();
    generationQueued = false;
    for (const state of epicStates.values()) clearRetry(state);
    const live = liveLanes.size > 0;
    for (const lane of [...liveLanes]) {
      lane.agent?.close();
      lane.agent = undefined;
      lane.question = null;
      if (lane.status === "running" || lane.status === "paused") lane.status = "failed";
    }
    liveLanes.clear();
    wakeLifecycle();
    return live;
  }

  function clearLaneState() {
    stopAllLanes();
    lanes = [];
    epicStates.clear();
    parkedEpics.clear();
    knownEpics.clear();
    generationActive = false;
    generationQueued = false;
    generationAttempted = false;
    laneSequence = 0;
    publishLanes();
  }

  function pauseLifecycle(ws: { send(data: string): unknown }) {
    if (!lifecycleRunning) {
      send(ws, { type: "error", message: "No lifecycle run is active." });
      return;
    }

    if (lifecycle.paused) {
      send(ws, { type: "error", message: "The lifecycle run is already paused." });
      return;
    }

    for (const lane of liveLanes) {
      if (lane.status !== "running") continue;
      lane.agent?.pause();
      lane.status = "paused";
    }
    lifecycle = { ...lifecycle, paused: true };
    publishLifecycle();
    publishLanes();
    wakeLifecycle();
  }

  function resumeLifecycle(ws: { send(data: string): unknown }) {
    if (skillsPreparation !== undefined || skillsPreparationPending) {
      send(ws, { type: "error", message: "A skills preparation is active." });
      return;
    }

    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (!lifecycleRunning) {
      send(ws, { type: "error", message: "No lifecycle run is active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
      return;
    }

    if (manualRun !== undefined || manualSequencing) {
      send(ws, { type: "error", message: "A manual ADR run is active." });
      return;
    }

    if (!lifecycle.paused) {
      send(ws, { type: "error", message: "The lifecycle run is not paused." });
      return;
    }

    lifecycle = { ...lifecycle, paused: false };
    publishLifecycle();
    for (const lane of liveLanes) {
      if (lane.status !== "paused") continue;
      lane.agent?.resume();
      lane.status = "running";
    }
    publishLanes();
    for (const resolve of resumeWaiters.splice(0)) resolve();
    wakeLifecycle();
  }

  /**
   * Ends the lifecycle for real: the loop leaves at its next check, every
   * lane peer it holds is closed, and the interface returns to the idle goal
   * stage. Unlike a pause, nothing of the run stays suspended behind the
   * button.
   */
  function stopLifecycle(ws: { send(data: string): unknown }) {
    if (!lifecycleRunning) {
      send(ws, { type: "error", message: "No lifecycle run is active." });
      return;
    }

    lifecyclePausedForManualRun = false;
    lifecycleRunning = false;
    if (stopAllLanes()) publishLanes();
    lifecycle = { stage: "goal", pass: lifecycle.pass, work: null, paused: false };
    publishLifecycle(true);
    for (const resolve of resumeWaiters.splice(0)) resolve();
    wakeLifecycle();
  }

  /** Returns true only when the run produced no epic and no pending ADR. */
  async function runLifecycle(): Promise<boolean> {
    let previousPending: string | undefined;

    while (lifecycleRunning) {
      await holdWhilePaused();
      if (!lifecycleRunning) return false;

      if (liveLanes.size > 0 || generationActive || generationQueued) {
        await waitForLifecycleChange();
        continue;
      }
      if (hasRetryingEpic()) {
        await waitForLifecycleChange();
        continue;
      }

      reconcileLanes();
      if (liveLanes.size > 0) continue;
      if (hasRetryingEpic()) continue;

      if (parkedEpics.size > 0) {
        if (!generationAttempted) {
          await runGenerationPass();
          reconcileLanes();
          if (liveLanes.size > 0 || hasRetryingEpic()) continue;
        }
        if (parkedEpics.size > 0) {
          const names = [...parkedEpics]
            .sort((left, right) => Number(left) - Number(right))
            .map((id) => `#${id}`)
            .join(", ");
          broadcast({
            type: "error",
            message: `Lifecycle stopped with parked epics: ${names}.`,
          });
          return false;
        }
      }

      if (knownEpics.size === 0 && !generationAttempted) {
        await runGenerationPass();
        reconcileLanes();
        if (liveLanes.size > 0 || hasRetryingEpic()) continue;
        if (knownEpics.size > 0) continue;
      }

      if (knownEpics.size > 0) {
        // An open epic is waiting on its retry timer or on the parked policy;
        // the timer and the main watcher wake this loop again.
        await waitForLifecycleChange();
        continue;
      }

      const list = await readRecords(adrDir);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;
      const pending = list.records.filter((record) => record.pending).map((record) => record.file);

      if (pending.length === 0) {
        setLifecycle("finished", null);
        return true;
      }

      const signature = pending.join("\n");
      if (signature === previousPending) {
        broadcast({
          type: "error",
          message: "Epic generation left the same ADRs pending without opening an epic.",
        });
        return false;
      }
      previousPending = signature;

      for (const file of pending) {
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
        const record = await readRecord(file);
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
        if (record === undefined || !record.pending) continue;
        await runAdrLane(record);
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
      }

      // A generation pass decides whether the resolved records revealed work.
      setLifecycle("epic", null);
      generationAttempted = false;
    }

    return false;
  }

  async function startLifecycle(ws: { send(data: string): unknown }) {
    // A stopped run leaves the loop at its next check, but its own finale may
    // still be in flight. Wait for it so the two runs cannot both publish.
    if (!lifecycleRunning && lifecycleUnwinding !== undefined) await lifecycleUnwinding;

    if (skillsPreparation !== undefined || skillsPreparationPending) {
      send(ws, { type: "error", message: "A skills preparation is active." });
      return;
    }

    if (goalCreation !== undefined) {
      send(ws, { type: "error", message: "A goal creation is active." });
      return;
    }

    if (lifecycleRunning) {
      send(ws, { type: "error", message: "A lifecycle run is already active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
      return;
    }

    if (manualRun !== undefined || sequencing || manualSequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    // A reset advances the request and takes over before this start reaches
    // the loop, so no peer spawns after the reset accepted.
    const request = ++lifecycleStartRequest;

    let goalSettled = false;
    try {
      goalSettled = (await readGoal(goalFile)).trim().length > 0;
    } catch {
      // A missing or unreadable goal document is not settled.
    }
    if (request !== lifecycleStartRequest) return;
    if (!goalSettled) {
      send(ws, {
        type: "error",
        message: "The goal is not set. Save a non-empty goal before starting the lifecycle.",
      });
      return;
    }

    let preparedSkills = 0;
    try {
      preparedSkills = (await inspectSkills(skillsDir)).managed.size;
    } catch (error) {
      if (request !== lifecycleStartRequest) return;
      send(ws, {
        type: "error",
        message: `Could not read the installed skills: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }
    if (request !== lifecycleStartRequest) return;
    if (preparedSkills === 0) {
      send(ws, {
        type: "error",
        message: "No skills are prepared. Prepare skills before starting the lifecycle.",
      });
      return;
    }

    const unwinding = Promise.withResolvers<void>();
    lifecycleUnwinding = unwinding.promise;
    settleLifecycleUnwinding = unwinding.resolve;
    clearLaneState();
    lifecycleRunning = true;
    startMainWatcher();
    // Report the run as active before the first tracker lookup: clients need the
    // stage to disable their start controls and offer pause while the lookup runs.
    lifecycle = { stage: "epic", pass: lifecycle.pass, work: null, paused: false };
    publishLifecycle(true);
    let finished = false;
    try {
      applyEpicList(await readEpicList());
      await holdWhilePaused();
      if (!lifecycleRunning) return;
      reconcileLanes();
      finished = await runLifecycle();
    } catch (error) {
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const wasPaused = lifecycle.paused;
      lifecycleRunning = false;
      lifecyclePausedForManualRun = false;
      if (stopAllLanes()) publishLanes();
      lifecycle = { ...lifecycle, paused: false };
      for (const resolve of resumeWaiters.splice(0)) resolve();
      if (finished) {
        if (wasPaused) publishLifecycle();
      } else {
        // An aborted run leaves no work behind: report the idle goal stage,
        // retain the pass already reached, and make the run available again.
        lifecycle = { stage: "goal", pass: lifecycle.pass, work: null, paused: false };
        publishLifecycle();
      }
      wakeLifecycle();
      settleLifecycleUnwinding?.();
      settleLifecycleUnwinding = undefined;
      lifecycleUnwinding = undefined;
    }
  }

  function answerQuestion(
    ws: { send(data: string): unknown },
    id: unknown,
    value: unknown,
    laneId: unknown,
  ) {
    const active = goalCreation ?? goalRevision ?? skillsPreparation ?? manualRun;
    const lane =
      typeof laneId === "string" ? lanes.find((candidate) => candidate.id === laneId) : undefined;
    if (active === undefined && lane === undefined && liveLanes.size === 0) {
      send(ws, { type: "error", message: "No run is active." });
      return;
    }

    if (
      id === undefined ||
      (typeof id !== "string" && typeof id !== "number") ||
      typeof value !== "string" ||
      value.trim().length === 0
    ) {
      send(ws, {
        type: "error",
        message: "An answer needs the question id and a non-empty value.",
      });
      return;
    }

    const laneAnswer = (target: Lane | undefined): boolean => {
      if (target === undefined) return false;
      if (target.question === null || String(target.question.id) !== String(id)) return false;
      if (target.agent === undefined || !target.agent.answer(target.question.id, value)) {
        send(ws, { type: "error", message: "The question is no longer pending." });
        return true;
      }
      target.question = null;
      publishLanes();
      return true;
    };

    if (lane !== undefined) {
      if (laneAnswer(lane)) return;
      send(ws, { type: "error", message: "No pending question with that id." });
      return;
    }

    if (active !== undefined && active.question !== null && String(active.question.id) === String(id)) {
      if (active.agent === undefined || !active.agent.answer(active.question.id, value)) {
        send(ws, { type: "error", message: "The question is no longer pending." });
        return;
      }
      active.question = null;
      return;
    }

    const matching = [...liveLanes].find(
      (candidate) =>
        candidate.question !== null && String(candidate.question.id) === String(id),
    );
    if (laneAnswer(matching)) return;

    send(ws, { type: "error", message: "No pending question with that id." });
  }

  function gitDetail(result: GitResult): string {
    const detail = result.stderr.trim() || result.stdout.trim();
    return detail.length === 0 ? `git exited with code ${result.code}` : detail;
  }

  /**
   * Stops every operation that can still touch the checkout, so the reset
   * owns the working tree. In-flight starts are invalidated through their
   * request counters; an in-flight skills preparation settles before the
   * caller deletes anything.
   */
  function stopActiveWorkForReset() {
    goalCreationRequest += 1;
    abortGoalCreation();
    abortGoalRevision();
    manualStartRequest += 1;
    abortManualRun();

    lifecycleStartRequest += 1;
    lifecyclePausedForManualRun = false;
    if (lifecycleRunning) {
      lifecycleRunning = false;
      lifecycle = { stage: "goal", pass: lifecycle.pass, work: null, paused: false };
      clearLaneState();
      publishLifecycle();
      for (const resolve of resumeWaiters.splice(0)) resolve();
    } else if (lanes.length > 0) {
      clearLaneState();
    }

    sequencing = false;

    skillsPreparationRequest += 1;
    skillsPreparationPending = false;
    const preparation = skillsPreparation;
    if (preparation !== undefined) {
      skillsPreparation = undefined;
      preparation.question = null;
      preparation.agent?.close();
      try {
        restoreDirectorySync(skillsDir, preparation.snapshot);
      } catch (error) {
        broadcast({
          type: "error",
          message: `Could not restore the previous skills: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      broadcast({ type: "skillsPreparationStopped", completed: false });
    }
  }

  /** Ends a reset unsuccessfully, leaving whatever it already changed in place. */
  function failImplementationReset(message: string, commit?: string) {
    implementationReset = undefined;
    broadcast({ type: "error", message });
    broadcast({
      type: "implementationResetStopped",
      completed: false,
      ...(commit === undefined ? {} : { commit }),
    });
  }

  /**
   * Deletes the implementation and publishes it. The server owns the whole
   * operation, so a browser disconnect neither interrupts nor cancels it.
   */
  async function performImplementationReset() {
    try {
      const top = await runGit(repoDir, ["rev-parse", "--show-toplevel"]);
      if (top.code !== 0 || resolve(top.stdout.trim()) !== resolve(repoDir)) {
        failImplementationReset(
          `Reset refused: REPO_DIR is not the repository top level. ${gitDetail(top)}`,
        );
        return;
      }

      const head = await runGit(repoDir, ["rev-parse", "--verify", "HEAD"]);
      if (head.code !== 0) {
        failImplementationReset(`Reset refused: HEAD does not name a commit. ${gitDetail(head)}`);
        return;
      }

      const branch = await runGit(repoDir, ["symbolic-ref", "--short", "HEAD"]);
      if (branch.code !== 0 || branch.stdout.trim() !== "main") {
        failImplementationReset(
          `Reset refused: the repository is not on main. ${gitDetail(branch)}`,
        );
        return;
      }

      const origin = await runGit(repoDir, ["remote", "get-url", "origin"]);
      if (origin.code !== 0) {
        failImplementationReset(
          `Reset refused: the repository has no origin remote. ${gitDetail(origin)}`,
        );
        return;
      }

      // The checkout is confirmed resettable: take it over before deleting so
      // an active peer cannot race the deletion, staging, or commit.
      stopActiveWorkForReset();
      const settling = skillsPreparationSettled;
      if (settling !== undefined) await settling;

      const keep = resetKeepSet(repoDir, goalFile);
      for (const entry of await readdir(repoDir, { withFileTypes: true })) {
        if (keep.has(entry.name) || RESET_INTERNAL_NAMES.has(entry.name)) continue;
        const target = join(repoDir, entry.name);
        // A symlink is removed as a link; its target, inside or outside the
        // repository, is never followed.
        if (entry.isSymbolicLink()) await unlink(target);
        else await rm(target, { recursive: true, force: true });
      }

      const staged = await runGit(repoDir, ["add", "-A"]);
      if (staged.code !== 0) {
        failImplementationReset(`Could not stage the reset: ${gitDetail(staged)}`);
        return;
      }
      // git add -A honours .gitignore, but an absent .gitignore would stage the
      // internal trees, and an earlier commit may already track them. Remove
      // them from the index; the working tree is untouched.
      const excluded = await runGit(repoDir, [
        "rm",
        "-r",
        "--cached",
        "--ignore-unmatch",
        "-q",
        "--",
        ...RESET_STAGE_EXCLUSIONS.filter((name) => name !== ".git"),
      ]);
      if (excluded.code !== 0) {
        failImplementationReset(`Could not stage the reset: ${gitDetail(excluded)}`);
        return;
      }

      // With no staged change the current HEAD already describes the reset,
      // so the operation stays idempotent.
      const changed = await runGit(repoDir, ["diff", "--cached", "--quiet"]);
      if (changed.code !== 0) {
        const committed = await runGit(repoDir, [
          "commit",
          "--no-verify",
          "-m",
          RESET_COMMIT_MESSAGE,
        ]);
        if (committed.code !== 0) {
          failImplementationReset(`Could not commit the reset: ${gitDetail(committed)}`);
          return;
        }
      }

      const committedHead = await runGit(repoDir, ["rev-parse", "HEAD"]);
      if (committedHead.code !== 0) {
        failImplementationReset(
          `Could not read the reset commit: ${gitDetail(committedHead)}`,
        );
        return;
      }
      const commit = committedHead.stdout.trim();

      const pushed = await runGit(repoDir, ["push", "origin", "main"], RESET_PUSH_ENV);
      if (pushed.code !== 0) {
        failImplementationReset(
          `Could not push the reset commit: ${gitDetail(pushed)}`,
          commit,
        );
        return;
      }

      let text = "";
      try {
        text = await readFile(goalFile, "utf8");
      } catch {
        // An absent goal document stays absent and is reported as empty.
      }

      implementationReset = undefined;
      lifecycle = { stage: "goal", pass: 1, work: null, paused: false };
      lastLifecycle = lifecycle;
      broadcast({ type: "implementationResetStopped", completed: true, commit });
      broadcast({ type: "lifecycleState", ...lifecycle });
      broadcast({ type: "records", records: [], next: null });
      broadcast({ type: "goal", text });
    } catch (error) {
      if (implementationReset === undefined) return;
      failImplementationReset(
        `Reset failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function startImplementationReset(ws: { send(data: string): unknown }) {
    if (implementationReset !== undefined) {
      send(ws, { type: "error", message: "An implementation reset is active." });
      return;
    }

    // Reset is available in every state: once the git preconditions pass it
    // stops any active run, lifecycle, creation, revision, or preparation.
    implementationReset = {};
    broadcast({ type: "implementationResetStarted" });
    void performImplementationReset();
  }

  /**
   * Files one browser report as a GitHub issue. The request is bounded before
   * parsing, and a cross-origin browser request is refused: this endpoint has
   * the side effect of creating issues, so another page must not reach it.
   */
  async function handleFeedbackRequest(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    const origin = request.headers.get("origin");
    if (origin !== null) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost !== url.host) {
        return Response.json({ error: "Cross-origin feedback is refused." }, { status: 403 });
      }
    }

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_FEEDBACK_BYTES) {
      return Response.json(
        { error: `The report is larger than ${MAX_FEEDBACK_BYTES} bytes.` },
        { status: 413 },
      );
    }

    let raw: string;
    try {
      raw = await request.text();
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "The report could not be read." },
        { status: 400 },
      );
    }
    if (raw.length > MAX_FEEDBACK_BYTES) {
      return Response.json(
        { error: `The report is larger than ${MAX_FEEDBACK_BYTES} bytes.` },
        { status: 413 },
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return Response.json({ error: "The report is not valid JSON." }, { status: 400 });
    }

    try {
      const submission = parseFeedbackSubmission(value);
      const filed = await fileFeedbackIssue(submission, {
        command: feedbackCommand,
        repoDir,
        timeoutMs: feedbackTimeoutMs,
        env: feedbackEnv,
      });
      return Response.json(filed, { status: 201 });
    } catch (error) {
      if (error instanceof FeedbackRequestError || error instanceof FeedbackDeliveryError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,

    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === "/api/feedback") {
        return handleFeedbackRequest(request, url);
      }

      if (url.pathname === "/ws") {
        if (server.upgrade(request)) return;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = resolve(staticRoot, relative);
      if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) {
        return new Response("Not Found", { status: 404 });
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return new Response("Not Found", { status: 404 });
      }

      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }

      return new Response(request.method === "HEAD" ? null : file, {
        headers: { "Content-Type": file.type },
      });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        if (implementationReset !== undefined) {
          send(ws, { type: "implementationResetStarted" });
        }
        // A retained pass must reach every client, including the first one
        // after a restart; a fresh pass 1 needs no event because that is the
        // state a client starts from.
        const replayed = lifecycleRunning
          ? lifecycle
          : (lastLifecycle ?? (lifecycle.pass > 1 ? lifecycle : undefined));
        if (replayed !== undefined) send(ws, { type: "lifecycleState", ...replayed });
        if (manualRun !== undefined) sendRunConversation(ws, manualRun, true);
        if (lanes.length > 0 || lifecycleRunning || lastLifecycle !== undefined) {
          publishLaneSnapshot(ws);
        }

        const creation = goalCreation;
        if (creation !== undefined) {
          send(ws, { type: "goalCreationStarted" });
          for (const text of creation.activity) send(ws, { type: "activity", text });
          if (creation.question !== null) {
            send(ws, {
              type: "question",
              id: creation.question.id,
              message: creation.question.message,
              options: creation.question.options,
            });
          }
        }

        const revision = goalRevision;
        if (revision !== undefined) {
          send(ws, { type: "goalRevisionStarted" });
          for (const text of revision.activity) send(ws, { type: "activity", text });
          if (revision.question !== null) {
            send(ws, {
              type: "question",
              id: revision.question.id,
              message: revision.question.message,
              options: revision.question.options,
            });
          }
        }

        const skills = skillsPreparation;
        if (skills !== undefined) {
          send(ws, { type: "skillsPreparationStarted" });
          for (const text of skills.activity) send(ws, { type: "activity", text });
          if (skills.question !== null) {
            send(ws, {
              type: "question",
              id: skills.question.id,
              message: skills.question.message,
              options: skills.question.options,
            });
          }
        }
      },

      close(ws) {
        clients.delete(ws);
      },

      async message(ws, message) {
        let command: ClientMessage | undefined;
        try {
          command = parseClientMessage(JSON.parse(String(message)));
        } catch {
          command = undefined;
        }
        if (command === undefined) {
          send(ws, { type: "error", message: "Invalid WebSocket message." });
          return;
        }

        // A reset owns the checkout while it runs: only the read-only
        // commands may answer, and a second reset is refused like any other.
        const readOnly =
          command.type === "listRecords" ||
          command.type === "getGoal" ||
          command.type === "getProject" ||
          command.type === "getVersion" ||
          command.type === "getSkills";
        if (implementationReset !== undefined && !readOnly) {
          send(ws, { type: "error", message: "An implementation reset is active." });
          return;
        }

        try {
          if (command.type === "listRecords") {
            const list = await readRecords(adrDir);
            send(ws, { type: "records", ...list });
          } else if (command.type === "getGoal") {
            await getGoal(ws);
          } else if (command.type === "getProject") {
            send(ws, { type: "project", path: project });
          } else if (command.type === "getVersion") {
            sendVersion(ws);
          } else if (command.type === "restartServer") {
            restartServer(ws);
          } else if (command.type === "saveGoal") {
            await saveGoal(ws, command.text);
          } else if (command.type === "startRun") {
            await startRun(ws, command.file);
          } else if (command.type === "startLifecycle") {
            await startLifecycle(ws);
          } else if (command.type === "stopLifecycle") {
            stopLifecycle(ws);
          } else if (command.type === "pauseLifecycle") {
            pauseLifecycle(ws);
          } else if (command.type === "resumeLifecycle") {
            resumeLifecycle(ws);
          } else if (command.type === "reviseGoal") {
            await startGoalRevision(ws, command.request);
          } else if (command.type === "createGoal") {
            await startGoalCreation(ws);
          } else if (command.type === "prepareSkills") {
            await startSkillsPreparation(ws);
          } else if (command.type === "getSkills") {
            await sendSkillsState(ws);
          } else if (command.type === "resetImplementation") {
            startImplementationReset(ws);
          } else if (command.type === "answer") {
            answerQuestion(ws, command.id, command.value, command.lane);
          }
        } catch (error) {
          send(ws, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  });

  const stop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    sequencing = false;
    manualSequencing = false;
    lifecyclePausedForManualRun = false;
    lifecycleRunning = false;
    stopAllLanes();
    manualRun?.agent?.close();
    manualRun = undefined;
    goalRevision?.agent?.close();
    goalRevision = undefined;
    goalCreation?.agent?.close();
    goalCreation = undefined;
    if (skillsPreparation !== undefined) {
      skillsPreparation.agent?.close();
      restoreDirectorySync(skillsDir, skillsPreparation.snapshot);
      skillsPreparation = undefined;
    }
    skillsPreparationPending = false;
    return stop(closeActiveConnections);
  };

  return server;
}
