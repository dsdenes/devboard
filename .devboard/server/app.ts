import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  isSessionBusy,
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
import { findOpenEpic, type EpicLookup, type OpenEpic } from "./tracker";

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
  feedback?: FeedbackOptions;
}

interface RunQuestion {
  id: number | string;
  message: string;
  options: AcpQuestionOption[];
}

interface ActiveRun {
  file: string;
  title: string;
  agent: AcpConnection | undefined;
  activity: string[];
  question: RunQuestion | null;
}

/**
 * Asks a peer to keep going after a turn that ended before the work did. `open`
 * reports whether the run's tracker condition is still unmet.
 */
interface Continuation {
  id: string;
  open: () => Promise<boolean>;
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
}

interface LifecycleState {
  stage: LifecycleStage;
  pass: number;
  work: LifecycleWork | null;
  paused: boolean;
}

const EPIC_PROMPT = "/epic-next";
const IMPLEMENT_PROMPT = "/implement-next-epic";

/** Wakes a peer whose turn ended while the epic is still open. */
function continuationPrompt(id: string): string {
  return [
    `The implementation turn ended before the run was complete: epic #${id} is still open.`,
    "Continue from where the turn stopped.",
    "Do not end a turn while a background job you started is still running:",
    "if the wait tool returns a still-running snapshot, call wait again.",
    "Finish the merge and close the epic before ending the turn, or report the exact blocker once.",
  ].join(" ");
}

/**
 * A forge can take a moment to expose a tracker write made by the peer that
 * just exited. After such a peer the lifecycle re-reads the tracker for this
 * bounded window before trusting an answer that still shows the pre-peer state.
 */
const TRACKER_SETTLE_ATTEMPTS = 7;
const TRACKER_SETTLE_DELAY_MS = 500;
/**
 * Turns the implementation peer may be asked for after a yield that leaves the
 * epic open. The peer keeps its session and its background work alive across
 * turns; this bound only stops a runaway peer from looping forever.
 */
const IMPLEMENT_CONTINUATIONS = 8;
/** Delay before retrying a continuation while the peer is still in its own turn. */
const CONTINUATION_RETRY_MS = 1_000;
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
  | { type: "saveGoal"; text?: unknown }
  | { type: "startRun"; file?: unknown }
  | { type: "startLifecycle" }
  | { type: "pauseLifecycle" }
  | { type: "resumeLifecycle" }
  | { type: "reviseGoal"; request?: unknown }
  | { type: "createGoal" }
  | { type: "prepareSkills" }
  | { type: "getSkills" }
  | { type: "resetImplementation" }
  | { type: "answer"; id?: unknown; value?: unknown };

function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  switch (value.type) {
    case "listRecords":
      return { type: "listRecords" };
    case "getGoal":
      return { type: "getGoal" };
    case "getProject":
      return { type: "getProject" };
    case "saveGoal":
      return { type: "saveGoal", text: "text" in value ? value.text : undefined };
    case "startRun":
      return { type: "startRun", file: "file" in value ? value.file : undefined };
    case "startLifecycle":
      return { type: "startLifecycle" };
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
  const tracker = options.tracker ?? findOpenEpic;
  const trackerSettle: TrackerSettle = {
    attempts: Math.max(1, options.trackerSettle?.attempts ?? TRACKER_SETTLE_ATTEMPTS),
    delayMs: Math.max(0, options.trackerSettle?.delayMs ?? TRACKER_SETTLE_DELAY_MS),
  };
  const feedbackCommand = options.feedback?.ghCommand ?? ["gh"];
  const feedbackTimeoutMs = Math.max(1, options.feedback?.timeoutMs ?? FEEDBACK_TIMEOUT_MS);
  const feedbackEnv = options.feedback?.env;

  const clients = new Set<ServerWebSocket<unknown>>();
  let activeRun: ActiveRun | undefined;
  let sequencing = false;
  let goalRevision: GoalRevision | undefined;
  let goalCreation: GoalCreation | undefined;
  let goalCreationRequest = 0;
  let skillsPreparation: SkillsPreparation | undefined;
  let skillsPreparationPending = false;
  /** Invalidates an in-flight preparation when a reset takes over. */
  let skillsPreparationRequest = 0;
  /** Resolves when the in-flight preparation has unwound and cleaned up. */
  let skillsPreparationSettled: Promise<void> | undefined;
  let lifecycle: LifecycleState = { stage: "goal", pass: 1, work: null, paused: false };
  let lastLifecycle: LifecycleState | undefined;
  let lifecycleRunning = false;
  /** Invalidates an in-flight lifecycle start when a reset takes over. */
  let lifecycleStartRequest = 0;
  let implementationReset: { commit?: string } | undefined;
  const resumeWaiters: (() => void)[] = [];

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

  function sendRunConversation(target: { send(data: string): unknown }, run: ActiveRun) {
    send(target, { type: "runStarted", file: run.file, title: run.title });
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

  /** Restores the suspended lifecycle conversation after a revision ends. */
  function broadcastRunConversation() {
    if (activeRun === undefined) return;
    for (const client of clients) sendRunConversation(client, activeRun);
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
      // An absent goal document is an unset goal, so the section reports
      // `Goal not set` and offers the creation control instead of an error.
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
      broadcastRunConversation();
      return;
    }

    try {
      const text = await readGoal(goalFile);
      broadcast({ type: "goalRevisionStopped", completed: true, text });
      broadcastRunConversation();
    } catch (error) {
      broadcast({
        type: "error",
        message: `Could not read the revised goal: ${error instanceof Error ? error.message : String(error)}`,
      });
      broadcast({ type: "goalRevisionStopped", completed: false });
      broadcastRunConversation();
    }
  }

  async function stopGoalCreation(creation: GoalCreation, succeeded: boolean) {
    if (goalCreation !== creation) return;
    goalCreation = undefined;
    creation.question = null;
    creation.agent?.close();

    if (!succeeded) {
      broadcast({ type: "goalCreationStopped", completed: false });
      broadcastRunConversation();
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
      broadcastRunConversation();
      return;
    }

    if (text.trim().length === 0) {
      broadcast({
        type: "error",
        message: "The goal creation ended without a non-empty goal.",
      });
      broadcast({ type: "goalCreationStopped", completed: false });
      broadcastRunConversation();
      return;
    }

    broadcast({ type: "goalCreationStopped", completed: true, text });
    broadcastRunConversation();
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

    if (activeRun !== undefined || sequencing) {
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
   * lifecycle keeps its suspended peer, which creation already coexists with.
   */
  function abortActiveRun(): boolean {
    if (lifecycleRunning && lifecycle.paused) return false;

    let stopped = false;
    if (lifecycleRunning) {
      lifecycleRunning = false;
      lifecycle = { stage: "goal", pass: lifecycle.pass, work: null, paused: false };
      publishLifecycle();
      for (const resolve of resumeWaiters.splice(0)) resolve();
      stopped = true;
    }

    if (sequencing) {
      sequencing = false;
      stopped = true;
    }

    const run = activeRun;
    if (run !== undefined) {
      activeRun = undefined;
      run.question = null;
      run.agent?.close();
      broadcast({
        type: "runStopped",
        file: run.file,
        title: run.title,
        resolved: false,
        status: "",
      });
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

    // A paused lifecycle keeps its suspended peer in activeRun; only a run that
    // the revision would contend with refuses the start.
    if (!(lifecycleRunning && lifecycle.paused) && (activeRun !== undefined || sequencing)) {
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

  /**
   * Sends a continuation while the peer is still finishing its own turn. The
   * peer rejects a prompt during a live turn, so a rejection means its
   * background work is running and the session is still worth keeping.
   */
  async function continueWhenIdle(agent: AcpConnection, text: string): Promise<void> {
    for (;;) {
      try {
        await agent.prompt(text);
        return;
      } catch (error) {
        if (!isSessionBusy(error)) throw error;
        await holdWhilePaused();
        if (!lifecycleRunning) return;
        await Bun.sleep(CONTINUATION_RETRY_MS);
      }
    }
  }

  async function runAgent(
    run: ActiveRun,
    prompt = agentPrompt(adrDir, run.file),
    continuation?: Continuation,
  ): Promise<boolean> {
    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(activity) {
          if (activeRun !== run) return;
          recordActivity(run.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          if (activeRun !== run) return;
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
      if (continuation !== undefined) {
        for (let attempt = 0; attempt < IMPLEMENT_CONTINUATIONS; attempt += 1) {
          if (!(await continuation.open())) break;
          if (!lifecycleRunning) break;
          await holdWhilePaused();
          await continueWhenIdle(agent, continuationPrompt(continuation.id));
        }
      }
      const record = await readRecord(run.file);
      return await stopRun(run, record !== undefined && !record.pending, record?.status ?? "");
    } catch (error) {
      if (activeRun !== run) return false;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      const record = await readRecord(run.file);
      return await stopRun(run, record !== undefined && !record.pending, record?.status ?? "");
    }
  }

  async function stopRun(run: ActiveRun, resolved: boolean, status: string): Promise<boolean> {
    if (activeRun !== run) return false;
    activeRun = undefined;
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

    if (lifecycleRunning) {
      send(ws, { type: "error", message: "A lifecycle run is active." });
      return;
    }

    if (goalRevision !== undefined) {
      send(ws, { type: "error", message: "A goal revision is active." });
      return;
    }

    if (activeRun !== undefined || sequencing) {
      send(ws, { type: "error", message: "A run is already active." });
      return;
    }

    sequencing = true;
    let selected = typeof file === "string" ? file : undefined;
    let first = true;

    try {
      while (sequencing) {
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
        if (!sequencing) return;
        const run: ActiveRun = {
          file: record.file,
          title: record.title,
          agent: undefined,
          activity: [],
          question: null,
        };
        activeRun = run;
        broadcast({ type: "runStarted", file: run.file, title: run.title });

        const resolved = await runAgent(run);
        if (!resolved) return;
      }
    } catch (error) {
      send(ws, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      sequencing = false;
    }
  }

  /** Broadcasts the current state and retains it for clients that connect later. */
  function publishLifecycle() {
    lastLifecycle = lifecycle;
    broadcast({ type: "lifecycleState", ...lifecycle });
  }

  function setLifecycle(stage: LifecycleStage, work: LifecycleWork | null) {
    lifecycle = { stage, pass: lifecycle.pass, work, paused: false };
    publishLifecycle();
  }

  /** Holds the lifecycle loop at the current stage until an explicit resume. */
  async function holdWhilePaused() {
    while (lifecycleRunning && lifecycle.paused) {
      await new Promise<void>((resolve) => resumeWaiters.push(resolve));
    }
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

    activeRun?.agent?.pause();
    lifecycle = { ...lifecycle, paused: true };
    publishLifecycle();
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

    if (!lifecycle.paused) {
      send(ws, { type: "error", message: "The lifecycle run is not paused." });
      return;
    }

    lifecycle = { ...lifecycle, paused: false };
    publishLifecycle();
    activeRun?.agent?.resume();
    for (const resolve of resumeWaiters.splice(0)) resolve();
  }

  async function runLifecycleStage(
    file: string,
    title: string,
    prompt: string,
    continuation?: Continuation,
  ) {
    const run: ActiveRun = {
      file,
      title,
      agent: undefined,
      activity: [],
      question: null,
    };
    activeRun = run;
    broadcast({ type: "runStarted", file: run.file, title: run.title });
    await runAgent(run, prompt, continuation);
  }

  /**
   * Re-reads the tracker while its answer could still be the pre-peer state.
   * The peer that just exited may have opened an epic or closed the one it
   * implemented, and the forge's read path can expose that write a moment
   * later. `stale` names the answer that write would replace. Pause holds the
   * loop before the next read, and a stopped run returns without another read.
   */
  async function settleTracker(
    stale: (epic: OpenEpic | undefined) => boolean,
  ): Promise<OpenEpic | undefined> {
    let epic = await tracker(repoDir);
    for (let attempt = 1; attempt < trackerSettle.attempts && stale(epic); attempt += 1) {
      await Bun.sleep(trackerSettle.delayMs);
      await holdWhilePaused();
      if (!lifecycleRunning) return epic;
      epic = await tracker(repoDir);
    }
    return epic;
  }

  /** Returns true only when the pass produced no epic and no pending ADR. */
  async function runLifecycle(): Promise<boolean> {
    let previousPending: string | undefined;

    while (lifecycleRunning) {
      await holdWhilePaused();
      if (!lifecycleRunning) return false;

      const existing = await tracker(repoDir);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;
      if (existing !== undefined) {
        const id = String(existing.number);
        setLifecycle("implementation", { kind: "epic", id });
        await runLifecycleStage("", existing.title, IMPLEMENT_PROMPT, {
          id,
          open: async () => {
            const remaining = await settleTracker(
              (epic) => epic !== undefined && String(epic.number) === id,
            );
            return remaining !== undefined && String(remaining.number) === id;
          },
        });
        await holdWhilePaused();
        if (!lifecycleRunning) return false;

        const remaining = await settleTracker(
          (epic) => epic !== undefined && String(epic.number) === id,
        );
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
        if (remaining !== undefined && String(remaining.number) === id) {
          broadcast({
            type: "error",
            message: `Implementation ended but epic #${id} is still open.`,
          });
          return false;
        }

        lifecycle = { stage: "epic", pass: lifecycle.pass + 1, work: null, paused: false };
        publishLifecycle();
        continue;
      }

      if (lifecycle.stage !== "epic" || lifecycle.work !== null) {
        setLifecycle("epic", null);
      }
      await runLifecycleStage("", "Epic generation", EPIC_PROMPT);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;

      const created = await settleTracker((epic) => epic === undefined);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;
      if (created !== undefined) continue;

      const list = await readRecords(adrDir);
      await holdWhilePaused();
      if (!lifecycleRunning) return false;
      const pending = list.records.filter((record) => record.pending).map((record) => record.file);

      if (pending.length === 0) {
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
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

        setLifecycle("adr", { kind: "adr", id: record.file });
        await runLifecycleStage(record.file, record.title, agentPrompt(adrDir, record.file));
        await holdWhilePaused();
        if (!lifecycleRunning) return false;
      }
    }

    return false;
  }

  async function startLifecycle(ws: { send(data: string): unknown }) {
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

    if (activeRun !== undefined || sequencing) {
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

    lifecycleRunning = true;
    // Report the run as active before the first tracker lookup: clients need the
    // stage to disable their start controls and offer pause while the lookup runs.
    lifecycle = { stage: "epic", pass: lifecycle.pass, work: null, paused: false };
    publishLifecycle();
    let finished = false;
    try {
      finished = await runLifecycle();
    } catch (error) {
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const wasPaused = lifecycle.paused;
      lifecycleRunning = false;
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
    }
  }

  function answerQuestion(
    ws: { send(data: string): unknown },
    id: unknown,
    value: unknown,
  ) {
    const active = goalCreation ?? goalRevision ?? skillsPreparation ?? activeRun;
    if (active === undefined) {
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

    if (active.question === null || String(active.question.id) !== String(id)) {
      send(ws, { type: "error", message: "No pending question with that id." });
      return;
    }

    if (active.agent === undefined || !active.agent.answer(active.question.id, value)) {
      send(ws, { type: "error", message: "The question is no longer pending." });
      return;
    }

    active.question = null;
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

    lifecycleStartRequest += 1;
    if (lifecycleRunning) {
      lifecycleRunning = false;
      lifecycle = { stage: "goal", pass: lifecycle.pass, work: null, paused: false };
      publishLifecycle();
      for (const resolve of resumeWaiters.splice(0)) resolve();
    }

    sequencing = false;
    const run = activeRun;
    if (run !== undefined) {
      activeRun = undefined;
      run.question = null;
      run.agent?.close();
      broadcast({
        type: "runStopped",
        file: run.file,
        title: run.title,
        resolved: false,
        status: "",
      });
    }

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
        const replayed = lifecycleRunning ? lifecycle : lastLifecycle;
        if (replayed !== undefined) send(ws, { type: "lifecycleState", ...replayed });
        if (activeRun !== undefined) sendRunConversation(ws, activeRun);

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
          } else if (command.type === "saveGoal") {
            await saveGoal(ws, command.text);
          } else if (command.type === "startRun") {
            await startRun(ws, command.file);
          } else if (command.type === "startLifecycle") {
            await startLifecycle(ws);
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
            answerQuestion(ws, command.id, command.value);
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
    lifecycleRunning = false;
    activeRun?.agent?.close();
    activeRun = undefined;
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
