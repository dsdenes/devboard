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
import { FlowController, type FlowOptions } from "./flow";
import { defaultGoalPath, readGoal, writeGoal } from "./goal";
import { openJournal, type Journal, type JournalKind } from "./journal";
import { parseRecord, readRecords, type AdrRecord } from "./records";
import {
  appendActivity,
  preserveStateFile,
  readStateFile,
  stateFile,
  STATE_VERSION,
  terminateRecordedChildren,
  trimActivity,
  writeStateFile,
  type RecordedChild,
} from "./state";
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
  /** How long a finished lane keeps its tab before leaving the active list. */
  laneRetentionMs?: number;
  /** Interval at which `main` is checked for a parked or retrying lane. */
  mainPollMs?: number;
  feedback?: FeedbackOptions;
  /** Directory that retains the lifecycle pass between process lifetimes. */
  stateDir?: string;
  /** Injectable journal for tests; defaults to the harness `.tmp/journal`. */
  journal?: Journal;
  /** Replaces the process; `index.ts` re-execs the host's current harness. */
  restart?: () => void;
  versionState?: () => ServerVersion;
  /**
   * Flow Mode's deterministic seams: an injected forge and executor for tests
   * and browser verification, and the watcher timings for focused runs.
   */
  flow?: Pick<FlowOptions, "forge" | "forgeTarget" | "exec" | "watchMs" | "analystTimeoutMs" | "goalTimeoutMs">;
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

/**
 * The dashboard state one server process leaves for its replacement. It holds
 * only what drives the page: the lifecycle, its lanes and epic bookkeeping, the
 * foreground runs with the bytes a skills rollback needs, and an accepted
 * when-idle restart. A lane's retention deadline is absolute so a window that
 * elapsed while the server was down is not replayed.
 */
interface StoredSnapshot {
  exists: boolean;
  files: [string, string][];
}

interface StoredQuestion {
  id: number | string;
  message: string;
  options: AcpQuestionOption[];
}

interface StoredLane {
  id: string;
  kind: LaneKind;
  epic: OpenEpic | null;
  record: { file: string; title: string } | null;
  attempt: number;
  status: LaneStatus;
  activity: string[];
  question: StoredQuestion | null;
  blocked: boolean;
  failure: string | null;
  /** Absolute time at which a closed or failed tab leaves the list. */
  retainUntil: number | null;
}

interface StoredEpicState {
  id: string;
  epic: OpenEpic;
  attempts: number;
  status: EpicState["status"];
  mainAtFailure: string | null;
}

interface StoredRun {
  activity: string[];
  question: StoredQuestion | null;
}

interface StoredManualRun extends StoredRun {
  file: string;
  title: string;
  action: RunAction;
}

interface StoredRevision extends StoredRun {
  /** The original guidance, so a resumed revision asks the same question. */
  request: string | null;
}

interface StoredSkills extends StoredRun {
  snapshot: StoredSnapshot | null;
  unmanagedNames: string[] | null;
}

interface StoredState {
  lifecycle: LifecycleState;
  lastLifecycle: LifecycleState | null;
  lifecycleRunning: boolean;
  lifecyclePausedForManualRun: boolean;
  laneSequence: number;
  lanes: StoredLane[];
  epicStates: StoredEpicState[];
  parkedEpics: string[];
  knownEpics: OpenEpic[];
  generationQueued: boolean;
  generationAttempted: boolean;
  manualSequencing: boolean;
  manualRun: StoredManualRun | null;
  goalCreation: StoredRun | null;
  goalRevision: StoredRevision | null;
  skillsPreparation: StoredSkills | null;
  skillsPreparationPending: StoredSkills | null;
  resetActive: boolean;
  restartWhenIdle: boolean;
  children: RecordedChild[];
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
/** How long a closed or failed lane stays in the active lane list. */
const LANE_RETENTION_MS = 30_000;
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
  | { type: "restartServer"; whenIdle?: unknown }
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
  | { type: "createFlowGoal" }
  | { type: "startFlowImplementation" }
  | { type: "stopFlowImplementation" }
  | { type: "saveFlowGoal"; text?: unknown }
  | { type: "retryFlowPr" }
  | { type: "markFlowPrReady" }
  | { type: "mergeFlowPr" }
  | { type: "sendFlowSteering"; text?: unknown }
  | { type: "saveFlowDecisions"; text?: unknown }
  | { type: "acceptFlowWidget"; id?: unknown; accepted?: unknown }
  | { type: "refuseFlowWidget"; id?: unknown; reason?: unknown }
  | { type: "openFlowWidget"; id?: unknown }
  | { type: "closeFlowWidget" }
  | { type: "sendFlowConversation"; text?: unknown }
  | { type: "sendFlowConclusion"; text?: unknown }
  | { type: "dismissFlowBlocker"; id?: unknown }
  | { type: "flowAnswer"; id?: unknown; value?: unknown; target?: unknown }
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
      return {
        type: "restartServer",
        whenIdle: "whenIdle" in value ? value.whenIdle : undefined,
      };
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
    case "createFlowGoal":
      return { type: "createFlowGoal" };
    case "startFlowImplementation":
      return { type: "startFlowImplementation" };
    case "stopFlowImplementation":
      return { type: "stopFlowImplementation" };
    case "saveFlowGoal":
      return { type: "saveFlowGoal", text: "text" in value ? value.text : undefined };
    case "retryFlowPr":
      return { type: "retryFlowPr" };
    case "markFlowPrReady":
      return { type: "markFlowPrReady" };
    case "mergeFlowPr":
      return { type: "mergeFlowPr" };
    case "sendFlowSteering":
      return { type: "sendFlowSteering", text: "text" in value ? value.text : undefined };
    case "saveFlowDecisions":
      return { type: "saveFlowDecisions", text: "text" in value ? value.text : undefined };
    case "acceptFlowWidget":
      return {
        type: "acceptFlowWidget",
        id: "id" in value ? value.id : undefined,
        accepted: "accepted" in value ? value.accepted : undefined,
      };
    case "refuseFlowWidget":
      return {
        type: "refuseFlowWidget",
        id: "id" in value ? value.id : undefined,
        reason: "reason" in value ? value.reason : undefined,
      };
    case "openFlowWidget":
      return { type: "openFlowWidget", id: "id" in value ? value.id : undefined };
    case "closeFlowWidget":
      return { type: "closeFlowWidget" };
    case "sendFlowConversation":
      return { type: "sendFlowConversation", text: "text" in value ? value.text : undefined };
    case "sendFlowConclusion":
      return { type: "sendFlowConclusion", text: "text" in value ? value.text : undefined };
    case "dismissFlowBlocker":
      return { type: "dismissFlowBlocker", id: "id" in value ? value.id : undefined };
    case "flowAnswer":
      return {
        type: "flowAnswer",
        id: "id" in value ? value.id : undefined,
        value: "value" in value ? value.value : undefined,
        target: "target" in value ? value.target : undefined,
      };
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function compact<T>(values: (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

function parseStoredLifecycle(value: unknown): LifecycleState | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const stage = record.stage;
  if (
    stage !== "goal" &&
    stage !== "epic" &&
    stage !== "adr" &&
    stage !== "implementation" &&
    stage !== "finished"
  ) {
    return undefined;
  }
  const pass = record.pass;
  if (typeof pass !== "number" || !Number.isInteger(pass) || pass < 1) return undefined;

  let work: LifecycleWork | null = null;
  const storedWork = asObject(record.work);
  if (storedWork !== undefined) {
    const kind = storedWork.kind;
    const id = storedWork.id;
    if ((kind === "adr" || kind === "epic") && typeof id === "string") {
      work = { kind, id, ...(typeof storedWork.url === "string" ? { url: storedWork.url } : {}) };
    }
  }

  return { stage, pass, work, paused: record.paused === true };
}

function parseOpenEpic(value: unknown): OpenEpic | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const number = record.number;
  const title = record.title;
  const url = record.url;
  if (typeof number !== "number" || !Number.isInteger(number)) return undefined;
  if (typeof title !== "string" || typeof url !== "string") return undefined;
  return { number, title, url };
}

function parseStoredQuestion(value: unknown): StoredQuestion | null {
  const record = asObject(value);
  if (record === undefined) return null;
  const id = record.id;
  const message = record.message;
  if (typeof message !== "string") return null;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const options = Array.isArray(record.options)
    ? record.options.filter(
        (option): option is AcpQuestionOption =>
          typeof option === "object" && option !== null && "label" in option,
      )
    : [];
  return { id, message, options };
}

function parseStoredActivity(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines = value.filter((line): line is string => typeof line === "string");
  trimActivity(lines);
  return lines;
}

function parseStoredSnapshot(value: unknown): StoredSnapshot | null {
  const record = asObject(value);
  if (record === undefined) return null;
  const files: [string, string][] = [];
  if (Array.isArray(record.files)) {
    for (const entry of record.files) {
      if (!Array.isArray(entry)) continue;
      const [relative, content] = entry;
      if (typeof relative !== "string" || typeof content !== "string") continue;
      files.push([relative, content]);
    }
  }
  return { exists: record.exists === true, files };
}

function parseStoredLane(value: unknown): StoredLane | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const id = record.id;
  const kind = record.kind;
  const status = record.status;
  const attempt = record.attempt;
  if (typeof id !== "string" || typeof attempt !== "number") return undefined;
  if (kind !== "generation" && kind !== "implementation" && kind !== "adr") return undefined;
  if (
    status !== "running" &&
    status !== "paused" &&
    status !== "closed" &&
    status !== "failed" &&
    status !== "retrying" &&
    status !== "parked"
  ) {
    return undefined;
  }
  const activity = parseStoredActivity(record.activity);
  if (activity === undefined) return undefined;

  let record_: { file: string; title: string } | null = null;
  const storedRecord = asObject(record.record);
  if (storedRecord !== undefined) {
    const file = storedRecord.file;
    const title = storedRecord.title;
    if (typeof file === "string" && typeof title === "string") {
      record_ = { file, title };
    }
  }

  const retainUntil = record.retainUntil;
  return {
    id,
    kind,
    epic: parseOpenEpic(record.epic) ?? null,
    record: record_,
    attempt,
    status,
    activity,
    question: parseStoredQuestion(record.question),
    blocked: record.blocked === true,
    failure: typeof record.failure === "string" ? record.failure : null,
    retainUntil: typeof retainUntil === "number" && Number.isFinite(retainUntil) ? retainUntil : null,
  };
}

function parseStoredEpicState(value: unknown): StoredEpicState | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const id = record.id;
  const epic = parseOpenEpic(record.epic);
  const attempts = record.attempts;
  const status = record.status;
  if (typeof id !== "string" || epic === undefined) return undefined;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) return undefined;
  if (status !== "running" && status !== "retrying" && status !== "parked" && status !== "closed") {
    return undefined;
  }
  return {
    id,
    epic,
    attempts,
    status,
    mainAtFailure: typeof record.mainAtFailure === "string" ? record.mainAtFailure : null,
  };
}

function parseStoredRun(value: unknown): StoredRun | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const activity = parseStoredActivity(record.activity);
  if (activity === undefined) return undefined;
  return { activity, question: parseStoredQuestion(record.question) };
}

function parseStoredManualRun(value: unknown): StoredManualRun | undefined {
  const run = parseStoredRun(value);
  const record = asObject(value);
  if (run === undefined || record === undefined) return undefined;
  const file = record.file;
  const title = record.title;
  const action = record.action;
  if (typeof file !== "string" || typeof title !== "string") return undefined;
  if (action !== "resolving" && action !== "implementing" && action !== "generating") {
    return undefined;
  }
  return { ...run, file, title, action };
}

function parseStoredRevision(value: unknown): StoredRevision | undefined {
  const run = parseStoredRun(value);
  const record = asObject(value);
  if (run === undefined || record === undefined) return undefined;
  return {
    ...run,
    request: typeof record.request === "string" ? record.request : null,
  };
}

function parseStoredSkills(value: unknown): StoredSkills | undefined {
  const run = parseStoredRun(value);
  const record = asObject(value);
  if (run === undefined || record === undefined) return undefined;
  const names = Array.isArray(record.unmanagedNames)
    ? record.unmanagedNames.filter((name): name is string => typeof name === "string")
    : null;
  return {
    ...run,
    snapshot: parseStoredSnapshot(record.snapshot),
    unmanagedNames: names,
  };
}

/**
 * Reads one stored state. Anything structurally unusable rejects the whole
 * state, so the caller preserves the bytes and starts from the initial state
 * instead of serving a half-restored page.
 */
function parseStoredState(value: unknown): StoredState | undefined {
  const record = asObject(value);
  if (record === undefined) return undefined;
  const lifecycle = parseStoredLifecycle(record.lifecycle);
  const lastLifecycle = parseStoredLifecycle(record.lastLifecycle);
  if (lifecycle === undefined) return undefined;
  if (!Array.isArray(record.lanes) || !Array.isArray(record.epicStates)) return undefined;

  const epicStates = compact(record.epicStates.map(parseStoredEpicState));
  const lanes = compact(record.lanes.map(parseStoredLane));
  const parkedEpics = Array.isArray(record.parkedEpics)
    ? record.parkedEpics.filter((id): id is string => typeof id === "string")
    : [];
  const knownEpics = Array.isArray(record.knownEpics)
    ? compact(record.knownEpics.map(parseOpenEpic))
    : [];
  const children = Array.isArray(record.children)
    ? compact(
        record.children.map((child): RecordedChild | undefined => {
          const stored = asObject(child);
          if (stored === undefined) return undefined;
          const pid = stored.pid;
          const cwd = stored.cwd;
          const argv = stored.argv;
          if (typeof pid !== "number" || !Number.isInteger(pid)) return undefined;
          if (typeof cwd !== "string" || !Array.isArray(argv)) return undefined;
          const parts = argv.filter((part): part is string => typeof part === "string");
          if (parts.length === 0) return undefined;
          return { pid, argv: parts, cwd };
        }),
      )
    : [];

  const laneSequence =
    typeof record.laneSequence === "number" && Number.isInteger(record.laneSequence)
      ? record.laneSequence
      : 0;

  return {
    lifecycle,
    lastLifecycle: lastLifecycle ?? null,
    lifecycleRunning: record.lifecycleRunning === true,
    lifecyclePausedForManualRun: record.lifecyclePausedForManualRun === true,
    laneSequence,
    lanes,
    epicStates,
    parkedEpics,
    knownEpics,
    generationQueued: record.generationQueued === true,
    generationAttempted: record.generationAttempted === true,
    manualSequencing: record.manualSequencing === true,
    manualRun: parseStoredManualRun(record.manualRun) ?? null,
    goalCreation: parseStoredRun(record.goalCreation) ?? null,
    goalRevision: parseStoredRevision(record.goalRevision) ?? null,
    skillsPreparation: parseStoredSkills(record.skillsPreparation) ?? null,
    skillsPreparationPending: parseStoredSkills(record.skillsPreparationPending) ?? null,
    resetActive: record.resetActive === true,
    restartWhenIdle: record.restartWhenIdle === true,
    children,
  };
}

function captureSnapshot(snapshot: SkillsSnapshot): StoredSnapshot {
  return {
    exists: snapshot.exists,
    files: [...snapshot.files].map(([relative, bytes]) => [relative, bytes.toString("base64")]),
  };
}

function restoreSnapshot(stored: StoredSnapshot): SkillsSnapshot {
  return {
    exists: stored.exists,
    files: new Map(stored.files.map(([relative, content]) => [relative, Buffer.from(content, "base64")])),
  };
}

function captureQuestion(question: RunQuestion | null): StoredQuestion | null {
  return question === null
    ? null
    : { id: question.id, message: question.message, options: question.options };
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
  const laneRetentionMs = Math.max(0, options.laneRetentionMs ?? LANE_RETENTION_MS);
  const mainPollMs = Math.max(10, options.mainPollMs ?? MAIN_POLL_MS);
  const feedbackCommand = options.feedback?.ghCommand ?? ["gh"];
  const feedbackTimeoutMs = Math.max(1, options.feedback?.timeoutMs ?? FEEDBACK_TIMEOUT_MS);
  const feedbackEnv = options.feedback?.env;
  // The state belongs to this checkout, not to the harness installation: hosts
  // share one harness through a symlink, so the repository path keys the file.
  const stateDir = resolve(options.stateDir ?? join(import.meta.dir, "..", ".tmp"));
  // The journal records what happened for the watchdog. It is never part of a
  // run's behavior: a failed write only adds a line to stderr.
  const journal =
    options.journal ?? openJournal({ stateDir, repoDir, port: options.port });
  const statePath = stateFile(stateDir, resolve(repoDir));
  const loadedState = readStateFile(statePath);
  const runningRevision = gitRevision(runningHarnessDir());
  const readVersion = options.versionState ?? (() => serverVersion(repoDir, runningRevision));

  /**
   * Flow Mode's controller. It owns its own session files under `stateDir` and
   * never touches Goal Mode's state: it only reports its active work so the
   * two modes cannot both hold the checkout.
   */
  const flow = new FlowController({
    repoDir,
    stateDir,
    agentCommand,
    journal,
    goalWorkActive: activeGoalWork,
    broadcast: (event) => broadcast(event),
    ...(options.flow ?? {}),
  });

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
    pass: 1,
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
  /** A refresh waits for active work before it replaces this process. */
  let restartWhenIdle = false;
  let restartWhenIdleTimer: Timer | undefined;
  /** Invalidates an in-flight lifecycle start when a reset takes over. */
  let lifecycleStartRequest = 0;
  let implementationReset: { commit?: string } | undefined;
  const resumeWaiters: (() => void)[] = [];

  // A lifecycle run owns these. Every lane keeps its tab for the whole run;
  // a lane that finished keeps it for `laneRetentionMs` so the outcome stays
  // readable, then leaves the active list.
  let lanes: Lane[] = [];
  const laneRetentionTimers = new Map<Lane, { timer: Timer; until: number }>();
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

  /** Events a restored process owes the first client before its own replies. */
  const startupNotices: unknown[] = [];
  /** A paused lifecycle that must spawn no peer until `resumeLifecycle`. */
  let restoredPausedLifecycle = false;
  /** The guidance of a restored goal revision, replayed in its new prompt. */
  let goalRevisionRequest: string | undefined;
  /** The pre-run skills bytes a restored pending preparation still owes. */
  let restoredPendingSkills:
    | { snapshot: SkillsSnapshot | null; unmanagedNames: Set<string> }
    | undefined;
  /** The snapshot a pending preparation took before it replaced the skills. */
  let pendingSkills: { snapshot: SkillsSnapshot; unmanagedNames: Set<string> } | undefined;
  let lastSavedState: string | undefined;
  let persistFailureReported = false;
  /** A target for work the restore starts before any client is attached. */
  const restoreTarget = {
    send(data: string) {
      try {
        broadcast(JSON.parse(data) as unknown);
      } catch {
        // A malformed event is not worth failing the restore over.
      }
    },
  };

  function send(ws: { send(data: string): unknown }, event: unknown) {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // The socket closed between accepting the message and sending the reply.
    }
  }

  /**
   * Every event a client can observe leaves after the state that produced it
   * is on disk. A SIGKILL after delivery therefore loses nothing the client
   * already saw, and a replacement replays at least that state.
   */
  function broadcast(event: unknown) {
    persistState();
    const payload = JSON.stringify(event);
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {
        // A closing client must not interrupt delivery to the others.
      }
    }
  }

  /** The pids and commands a replacement needs to end this process's peers. */
  function captureChildren(): RecordedChild[] {
    const children: RecordedChild[] = [];
    const remember = (agent: AcpConnection | undefined) => {
      const pid = agent?.pid;
      if (agent === undefined || pid === undefined) return;
      children.push({ pid, argv: agent.argv, cwd: repoDir });
    };
    remember(manualRun?.agent);
    remember(goalCreation?.agent);
    remember(goalRevision?.agent);
    remember(skillsPreparation?.agent);
    for (const lane of liveLanes) remember(lane.agent);
    return children;
  }

  function captureState(): StoredState {
    return {
      lifecycle,
      lastLifecycle: lastLifecycle ?? null,
      lifecycleRunning,
      lifecyclePausedForManualRun,
      laneSequence,
      lanes: lanes.map((lane) => ({
        id: lane.id,
        kind: lane.kind,
        epic: lane.epic,
        record: lane.record,
        attempt: lane.attempt,
        status: lane.status,
        activity: [...lane.activity],
        question: captureQuestion(lane.question),
        blocked: lane.blocked,
        failure: lane.failure,
        retainUntil: laneRetentionTimers.get(lane)?.until ?? null,
      })),
      epicStates: [...epicStates].map(([id, state]) => ({
        id,
        epic: state.epic,
        attempts: state.attempts,
        status: state.status,
        mainAtFailure: state.mainAtFailure ?? null,
      })),
      parkedEpics: [...parkedEpics],
      knownEpics: [...knownEpics.values()],
      generationQueued,
      generationAttempted,
      manualSequencing,
      manualRun:
        manualRun === undefined
          ? null
          : {
              file: manualRun.file,
              title: manualRun.title,
              action: manualRun.action,
              activity: [...manualRun.activity],
              question: captureQuestion(manualRun.question),
            },
      goalCreation:
        goalCreation === undefined
          ? null
          : {
              activity: [...goalCreation.activity],
              question: captureQuestion(goalCreation.question),
            },
      goalRevision:
        goalRevision === undefined
          ? null
          : {
              activity: [...goalRevision.activity],
              question: captureQuestion(goalRevision.question),
              request: goalRevisionRequest ?? null,
            },
      skillsPreparation:
        skillsPreparation === undefined
          ? null
          : {
              activity: [...skillsPreparation.activity],
              question: captureQuestion(skillsPreparation.question),
              snapshot: captureSnapshot(skillsPreparation.snapshot),
              unmanagedNames: [...skillsPreparation.unmanagedNames],
            },
      skillsPreparationPending:
        skillsPreparationPending && pendingSkills !== undefined
          ? {
              activity: [],
              question: null,
              snapshot: captureSnapshot(pendingSkills.snapshot),
              unmanagedNames: [...pendingSkills.unmanagedNames],
            }
          : null,
      resetActive: implementationReset !== undefined,
      restartWhenIdle,
      children: captureChildren(),
    };
  }

  function reportPersistFailure(error: unknown): void {
    if (persistFailureReported) return;
    persistFailureReported = true;
    const detail = error instanceof Error ? error.message : String(error);
    const message = `state: could not write ${statePath}: ${detail}`;
    journal.write("server-error", message);
    process.stderr.write(`${message}\n`);
  }

  function persistState(): void {
    let text: string;
    try {
      text = JSON.stringify({ version: STATE_VERSION, state: captureState() });
    } catch (error) {
      reportPersistFailure(error);
      return;
    }
    if (text === lastSavedState) return;
    try {
      writeStateFile(statePath, text);
      lastSavedState = text;
    } catch (error) {
      reportPersistFailure(error);
    }
  }

  /** Applies a stored state to memory. A peer always spawns after this. */
  function applyRestoredState(stored: StoredState): void {
    lifecycle = stored.lifecycle;
    lastLifecycle = stored.lastLifecycle ?? undefined;
    generationQueued = stored.generationQueued;
    generationAttempted = stored.generationAttempted;
    manualSequencing = stored.manualSequencing;
    lifecyclePausedForManualRun = stored.lifecyclePausedForManualRun;
    restartWhenIdle = stored.restartWhenIdle;
    parkedEpics.clear();
    for (const id of stored.parkedEpics) parkedEpics.add(id);
    knownEpics = new Map(stored.knownEpics.map((epic) => [String(epic.number), epic]));

    let sequence = stored.laneSequence;
    for (const entry of stored.lanes) {
      const match = /^lane-(\d+)$/.exec(entry.id);
      if (match !== null) sequence = Math.max(sequence, Number(match[1]));
    }
    laneSequence = sequence;

    const now = Date.now();
    lanes = [];
    for (const entry of stored.lanes) {
      // A closed or failed tab whose window elapsed while the server was down
      // is not replayed.
      const retained = entry.status === "closed" || entry.status === "failed";
      if (retained && (entry.retainUntil === null || entry.retainUntil <= now)) continue;
      const lane: Lane = {
        id: entry.id,
        kind: entry.kind,
        epic: entry.epic,
        record: entry.record,
        attempt: entry.attempt,
        status: entry.status,
        agent: undefined,
        activity: entry.activity,
        question: entry.question,
        blocked: entry.blocked,
        failure: entry.failure,
      };
      lanes.push(lane);
      if (lane.status === "running" || lane.status === "paused") liveLanes.add(lane);
      if (retained && entry.retainUntil !== null) scheduleLaneRemoval(lane, entry.retainUntil);
    }

    for (const entry of stored.epicStates) {
      epicStates.set(entry.id, {
        epic: entry.epic,
        attempts: entry.attempts,
        status: entry.status,
        timer: undefined,
        mainAtFailure: entry.mainAtFailure ?? undefined,
      });
    }

    if (stored.manualRun !== null) {
      manualRun = {
        file: stored.manualRun.file,
        title: stored.manualRun.title,
        action: stored.manualRun.action,
        agent: undefined,
        activity: stored.manualRun.activity,
        question: stored.manualRun.question,
      };
    }
    if (stored.goalCreation !== null) {
      goalCreation = {
        agent: undefined,
        activity: stored.goalCreation.activity,
        question: stored.goalCreation.question,
      };
    }
    if (stored.goalRevision !== null) {
      goalRevision = {
        agent: undefined,
        activity: stored.goalRevision.activity,
        question: stored.goalRevision.question,
      };
      goalRevisionRequest = stored.goalRevision.request ?? undefined;
    }
    if (stored.skillsPreparation !== null) {
      skillsPreparation = {
        agent: undefined,
        activity: stored.skillsPreparation.activity,
        question: stored.skillsPreparation.question,
        snapshot: stored.skillsPreparation.snapshot
          ? restoreSnapshot(stored.skillsPreparation.snapshot)
          : { exists: false, files: new Map() },
        unmanagedNames: new Set(stored.skillsPreparation.unmanagedNames ?? []),
      };
    }
    if (stored.skillsPreparationPending !== null) {
      skillsPreparationPending = true;
      restoredPendingSkills = {
        snapshot: stored.skillsPreparationPending.snapshot
          ? restoreSnapshot(stored.skillsPreparationPending.snapshot)
          : null,
        unmanagedNames: new Set(stored.skillsPreparationPending.unmanagedNames ?? []),
      };
    }

    if (stored.resetActive) {
      // A reset owns the checkout until it reports. Re-running it would repeat
      // deletions and git operations; it is surfaced as failed instead.
      lanes = [];
      liveLanes.clear();
      epicStates.clear();
      parkedEpics.clear();
      knownEpics.clear();
      manualRun = undefined;
      manualSequencing = false;
      goalCreation = undefined;
      goalRevision = undefined;
      goalRevisionRequest = undefined;
      skillsPreparation = undefined;
      skillsPreparationPending = false;
      pendingSkills = undefined;
      restoredPendingSkills = undefined;
      lifecycle = { stage: "goal", pass: stored.lifecycle.pass, work: null, paused: false };
      lastLifecycle = lifecycle;
      startupNotices.push({
        type: "error",
        message:
          "The implementation reset was interrupted when the server stopped, so it was not resumed.",
      });
      startupNotices.push({ type: "implementationResetStopped", completed: false });
      return;
    }

    if (stored.lifecycleRunning) {
      lifecycleRunning = true;
      restoredPausedLifecycle = stored.lifecycle.paused;
      for (const [id, state] of epicStates) {
        if (state.status === "retrying") scheduleRetry(id);
      }
    }
  }

  if (loadedState.kind === "damaged") {
    const message = `The saved dashboard state could not be restored: ${loadedState.reason}. Starting from an empty dashboard.`;
    process.stderr.write(`${message}\n`);
    startupNotices.push({ type: "error", message });
  } else if (loadedState.kind === "loaded") {
    const stored = parseStoredState(loadedState.value);
    if (stored === undefined) {
      preserveStateFile(statePath);
      const message =
        "The saved dashboard state could not be restored: its contents are not a dashboard state. Starting from an empty dashboard.";
      process.stderr.write(`${message}\n`);
      startupNotices.push({ type: "error", message });
    } else {
      applyRestoredState(stored);
      // Ends the killed process's peers and continues its work once the
      // listener is bound; a restore failure is reported, never thrown.
      void resumeRestoredWork(stored.children).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        journal.write("server-error", `state: could not resume: ${detail}`);
        process.stderr.write(`state: could not resume: ${detail}\n`);
      });
    }
  }

  function sendVersion(ws: { send(data: string): unknown }) {
    send(ws, { type: "versionState", ...readVersion() });
  }

  /** True while any run, lifecycle lane, creation, revision, reset, or Flow work is live. */
  function workActive(): boolean {
    return (
      implementationReset !== undefined ||
      lifecycleRunning ||
      liveLanes.size > 0 ||
      sequencing ||
      manualRun !== undefined ||
      manualSequencing ||
      goalCreation !== undefined ||
      goalRevision !== undefined ||
      skillsPreparation !== undefined ||
      skillsPreparationPending ||
      generationActive ||
      generationQueued ||
      flow.hasActiveWork()
    );
  }

  /** Names the Goal Mode work Flow Mode would contend with, if any. */
  function activeGoalWork(): string | undefined {
    if (implementationReset !== undefined) return "an implementation reset";
    if (goalCreation !== undefined) return "a goal creation";
    if (goalRevision !== undefined) return "a goal revision";
    if (skillsPreparation !== undefined || skillsPreparationPending) return "skills preparation";
    if (lifecycleRunning) return "the lifecycle";
    if (manualRun !== undefined || manualSequencing || sequencing) return "a manual ADR run";
    return undefined;
  }

  /**
   * Only one mode may hold the checkout. A Goal Mode start while Flow work is
   * live is refused with a single error and spawns no peer; view switching and
   * read-only commands stay available.
   */
  function refuseFlowActive(ws: { send(data: string): unknown }): boolean {
    if (!flow.hasActiveWork()) return false;
    send(ws, { type: "error", message: "Flow Mode is active. Finish or stop its work first." });
    return true;
  }

  /**
   * Replaces this process through its launcher. The event leaves first so a
   * browser stops reconnecting and waits for the replacement instead. Returns
   * the failure detail, or undefined once the launcher owns the process.
   */
  function beginRestart(): string | undefined {
    restarting = true;
    restartWhenIdle = false;
    if (restartWhenIdleTimer !== undefined) {
      clearInterval(restartWhenIdleTimer);
      restartWhenIdleTimer = undefined;
    }
    broadcast({ type: "serverRestarting" });
    try {
      options.restart?.();
      return undefined;
    } catch (error) {
      restarting = false;
      return `Could not restart the server: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  /**
   * A refresh requested while a peer or run is live stays pending and takes
   * effect as soon as the dashboard has no work left to lose.
   */
  function holdRestartUntilIdle() {
    restartWhenIdle = true;
    if (restartWhenIdleTimer !== undefined) return;
    restartWhenIdleTimer = setInterval(() => {
      if (!restartWhenIdle || restarting || workActive()) return;
      const failure = beginRestart();
      if (failure !== undefined) {
        restartWhenIdle = false;
        if (restartWhenIdleTimer !== undefined) {
          clearInterval(restartWhenIdleTimer);
          restartWhenIdleTimer = undefined;
        }
        broadcast({ type: "error", message: failure });
      }
    }, 500);
  }

  function restartServer(ws: { send(data: string): unknown }, whenIdle = false) {
    if (options.restart === undefined) {
      send(ws, { type: "error", message: "Restarting the server is not available." });
      return;
    }
    if (restarting) {
      send(ws, { type: "error", message: "A server restart is already in progress." });
      return;
    }
    if (whenIdle && workActive()) {
      holdRestartUntilIdle();
      broadcast({ type: "upgradePending" });
      return;
    }
    const failure = beginRestart();
    if (failure !== undefined) send(ws, { type: "error", message: failure });
  }

  /**
   * Streamed deltas extend the last activity line; a new message, tool call, or
   * plan starts one. The store keeps whole lines so a reconnect replays them as
   * they were shown.
   */
  function recordActivity(store: string[], activity: AcpActivity) {
    journal.write("activity", activity.text);
    const append = activity.append && store.length > 0;
    appendActivity(store, activity.text, append);
    broadcast(
      append
        ? { type: "activity", text: activity.text, append: true }
        : { type: "activity", text: activity.text },
    );
  }

  /**
   * Records one lane's streamed output. Every event names its lane, so two
   * peers streaming at once never share a line; a line beginning with the
   * blocker marker parks the lane when its turn ends.
   */
  function recordLaneActivity(lane: Lane, activity: AcpActivity) {
    if (!liveLanes.has(lane)) return;
    journal.write("activity", activity.text);
    const append = activity.append && lane.activity.length > 0;
    appendActivity(lane.activity, activity.text, append);
    broadcast(
      append
        ? { type: "activity", lane: lane.id, text: activity.text, append: true }
        : { type: "activity", lane: lane.id, text: activity.text },
    );
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

  async function startSkillsPreparation(
    ws: { send(data: string): unknown },
    restored?: { snapshot: SkillsSnapshot; unmanagedNames: Set<string> },
  ) {
    if (refuseFlowActive(ws)) return;

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
        if (restored === undefined) {
          snapshot = await snapshotDirectory(skillsDir);
          unmanagedNames = new Set((await inspectSkills(skillsDir)).unmanaged.keys());
        } else {
          // The interrupted run may have deleted managed skills already; its
          // exact pre-run bytes go back before the run replaces them again.
          snapshot = restored.snapshot;
          unmanagedNames = restored.unmanagedNames;
          await restoreDirectory(skillsDir, snapshot);
        }
        managedNames = await managedSkillNames(skillsDir, snapshot);
      } catch (error) {
        if (cancelled()) return;
        skillsPreparationPending = false;
        pendingSkills = undefined;
        send(ws, {
          type: "error",
          message: `Could not read the installed skills: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (cancelled()) return;
      // Record the rollback bytes before anything is deleted, so a kill during
      // the replacement still restores the pre-run skills on the next start.
      pendingSkills = { snapshot, unmanagedNames };
      persistState();

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
        pendingSkills = undefined;
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
      pendingSkills = undefined;
      broadcast({ type: "skillsPreparationStarted" });

      await spawnSkillsPreparation(preparation);
    } finally {
      settled.resolve();
      if (skillsPreparationSettled === settled.promise) skillsPreparationSettled = undefined;
    }
  }

  /** Runs a preparation peer to its outcome; also resumes a restored one. */
  async function spawnSkillsPreparation(preparation: SkillsPreparation) {
    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(activity) {
          if (skillsPreparation !== preparation) return;
          recordActivity(preparation.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message);
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
          journal.write("acp-stderr", text);
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
    if (refuseFlowActive(ws)) return;

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

    await spawnGoalCreation(creation);
  }

  /** Runs a creation peer to its outcome; also resumes a restored one. */
  async function spawnGoalCreation(creation: GoalCreation) {
    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(activity) {
          if (goalCreation !== creation) return;
          recordActivity(creation.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message);
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
          journal.write("acp-stderr", text);
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
    if (refuseFlowActive(ws)) return;

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

    goalRevisionRequest = typeof request === "string" ? request : undefined;
    const revision: GoalRevision = { agent: undefined, activity: [], question: null };
    goalRevision = revision;
    broadcast({ type: "goalRevisionStarted" });

    await spawnGoalRevision(revision);
  }

  /** Runs a revision peer to its outcome; also resumes a restored one. */
  async function spawnGoalRevision(revision: GoalRevision) {
    try {
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        onActivity(activity) {
          if (goalRevision !== revision) return;
          recordActivity(revision.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message);
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
          journal.write("acp-stderr", text);
          process.stderr.write(text);
        },
      });
      revision.agent = agent;

      await agent.run(goalRevisionPrompt(goalFile, goalRevisionRequest));
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
          journal.write("question", question.message);
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
          journal.write("acp-stderr", text);
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
      journal.write(
        "server-error",
        error instanceof Error ? error.message : String(error),
      );
      const record = await readRecord(run.file);
      return await stopRun(run, record !== undefined && !record.pending, record?.status ?? "");
    }
  }

  async function stopRun(run: ActiveRun, resolved: boolean, status: string): Promise<boolean> {
    if (manualRun !== run) return false;
    manualRun = undefined;
    run.question = null;
    run.agent?.close();
    const outcome = status.length > 0 ? status : resolved ? "resolved" : "stopped";
    journal.write("run-stop", `${run.file}: ${outcome}`);

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
    if (refuseFlowActive(ws)) return;

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

    await runManualSequence(ws, selected, undefined);
  }

  /**
   * Resolves pending records one at a time. A restored run continues from its
   * own record, and a record that was resolved before the interruption is
   * skipped so the sequence advances to the next pending one.
   */
  async function runManualSequence(
    target: { send(data: string): unknown },
    initial: string | undefined,
    resume: ActiveRun | undefined,
    quietEmpty = false,
  ) {
    let selected = initial;
    let first = resume === undefined;
    manualSequencing = true;

    try {
      if (resume !== undefined) {
        manualRun = resume;
        journal.write("run-start", `${resume.file}: ${resume.title}`);
        broadcast({
          type: "runStarted",
          file: resume.file,
          title: resume.title,
          action: resume.action,
          manual: true,
        });
        const resolved = await runAgent(resume);
        if (!resolved) return;
      }

      while (manualSequencing) {
        const list = await readRecords(adrDir);
        let record: AdrRecord | undefined;

        if (selected !== undefined) {
          record = list.records.find(
            (candidate) => candidate.file === selected && candidate.pending,
          );
          selected = undefined;
          if (record === undefined) {
            send(target, { type: "error", message: "That ADR is not pending." });
            return;
          }
        } else {
          record = list.records.find((candidate) => candidate.file === list.next);
          if (record === undefined) {
            if (first && !quietEmpty) {
              send(target, { type: "error", message: "No pending ADRs to start." });
            }
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
          send(target, { type: "error", message: "The lifecycle is already resolving that ADR." });
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
        journal.write("run-start", `${run.file}: ${run.title}`);
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
      send(target, {
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
        if (lifecycleRunning && lifecycle.paused) resumeLifecycle(target);
      }
    }
  }

  /** Broadcasts the current state and retains it for later clients. */
  function publishLifecycle(force = false) {
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
    journal.write("lifecycle", `${stage}${work === null ? "" : ` ${work.kind}`}`);
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

  /** Drops a finished lane once its retention window elapses. */
  function scheduleLaneRemoval(lane: Lane, until = Date.now() + laneRetentionMs) {
    if (lane.status !== "closed" && lane.status !== "failed") return;
    if (laneRetentionTimers.has(lane)) return;
    const timer = setTimeout(() => {
      laneRetentionTimers.delete(lane);
      const index = lanes.indexOf(lane);
      if (index < 0) return;
      lanes.splice(index, 1);
      publishLanes();
    }, Math.max(0, until - Date.now()));
    laneRetentionTimers.set(lane, { timer, until });
  }

  function clearLaneRetention() {
    for (const { timer } of laneRetentionTimers.values()) clearTimeout(timer);
    laneRetentionTimers.clear();
  }

  function publishLanes() {
    // A lane that has just finished keeps its tab briefly for the operator,
    // then leaves the active list instead of accumulating for the whole run.
    for (const lane of lanes) scheduleLaneRemoval(lane);
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
    journal.write("lane-start", `${lane.id} ${lane.kind} ${laneTitle(lane)}`);
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
          journal.write("question", question.message);
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
          journal.write("acp-stderr", text);
          process.stderr.write(text);
        },
      });
      lane.agent = agent;
      if (lifecycle.paused) agent.pause();
      await agent.run(prompt);
    } catch (error) {
      if (liveLanes.has(lane)) {
        lane.failure = error instanceof Error ? error.message : String(error);
        journal.write("server-error", lane.failure);
        broadcast({ type: "error", lane: lane.id, message: lane.failure });
      }
    } finally {
      lane.agent = undefined;
      lane.question = null;
      liveLanes.delete(lane);
    }
  }

  function broadcastLaneStopped(lane: Lane, resolved: boolean, status: string) {
    journal.write("lane-stop", `${lane.id} ${status.length > 0 ? status : "stopped"}`);
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

    void continueImplementationLane(lane, id);
  }

  /** Runs an implementation lane to its outcome; also resumes a restored one. */
  async function continueImplementationLane(lane: Lane, id: string) {
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

    await continueGenerationLane(lane, before);
  }

  /** Finishes a generation lane; also resumes a restored one. */
  async function continueGenerationLane(lane: Lane, before = new Set(knownEpics.keys())) {
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

    await continueAdrLane(lane);
  }

  /** Finishes an ADR lane; also resumes a restored one. */
  async function continueAdrLane(lane: Lane) {
    const file = lane.record?.file ?? "";
    await runLanePeer(lane, agentPrompt(adrDir, file));
    lane.status = lane.failure === null ? "closed" : "failed";
    const current = await readRecord(file);
    broadcastLaneStopped(lane, current !== undefined && !current.pending, current?.status ?? "");
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
    clearLaneRetention();
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

    if (restoredPausedLifecycle) {
      // A restored paused run has no peer and no loop yet; the resume starts
      // both from the restored lanes.
      restoredPausedLifecycle = false;
      void continueRestoredLifecycle();
    }
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
    journal.write("lifecycle", "stop");
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
    if (refuseFlowActive(ws)) return;

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
    journal.write("lifecycle", "start");
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
      finalizeLifecycleRun(finished, lifecycle.paused);
    }
  }

  /**
   * Ends a lifecycle loop for this process: every lane peer it holds is closed
   * and the interface returns to a stable stage. A finished run keeps its
   * `finished` stage; an aborted one replays the idle goal stage and its pass.
   */
  function finalizeLifecycleRun(finished: boolean, wasPaused: boolean) {
    lifecycleRunning = false;
    lifecyclePausedForManualRun = false;
    if (stopAllLanes()) publishLanes();
    lifecycle = { ...lifecycle, paused: false };
    for (const resolve of resumeWaiters.splice(0)) resolve();
    if (finished) {
      if (wasPaused) publishLifecycle();
    } else {
      lifecycle = { stage: "goal", pass: lifecycle.pass, work: null, paused: false };
      publishLifecycle();
    }
    wakeLifecycle();
    settleLifecycleUnwinding?.();
    settleLifecycleUnwinding = undefined;
    lifecycleUnwinding = undefined;
  }

  /**
   * Takes over a lifecycle that was advancing when the process died: its
   * incomplete lanes are re-spawned with their original prompts and the
   * scheduler continues from the restored stage.
   */
  async function continueRestoredLifecycle() {
    const unwinding = Promise.withResolvers<void>();
    lifecycleUnwinding = unwinding.promise;
    settleLifecycleUnwinding = unwinding.resolve;
    startMainWatcher();
    let finished = false;
    try {
      spawnRestoredLanes();
      applyEpicList(await readEpicList());
      reconcileLanes();
      if (generationQueued) void drainGenerations();
      finished = await runLifecycle();
    } catch (error) {
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      finalizeLifecycleRun(finished, false);
    }
  }

  /** Re-spawns every restored lane that has no peer yet. */
  function spawnRestoredLanes() {
    for (const lane of [...lanes]) {
      if (!liveLanes.has(lane) || lane.status !== "running" || lane.agent !== undefined) continue;
      if (lane.kind === "generation") {
        generationActive = true;
        void (async () => {
          try {
            await continueGenerationLane(lane);
          } finally {
            generationActive = false;
          }
          reconcileLanes();
          wakeLifecycle();
          if (generationQueued) void drainGenerations();
        })();
      } else if (lane.kind === "adr" && lane.record !== null) {
        void continueAdrLane(lane);
      } else if (lane.kind === "implementation" && lane.epic !== null) {
        void continueImplementationLane(lane, String(lane.epic.number));
      }
    }
  }

  /**
   * Resumes a restored manual sequence from its own record, skipping a record
   * the interrupted peer already resolved.
   */
  async function resumeRestoredManualSequence() {
    const run = manualRun;
    if (run === undefined) {
      if (!manualSequencing) return;
      manualSequencing = false;
      await runManualSequence(restoreTarget, undefined, undefined, true);
      return;
    }

    const record = await readRecord(run.file);
    if (record !== undefined && record.pending) {
      await runManualSequence(restoreTarget, undefined, run, true);
      return;
    }

    manualRun = undefined;
    persistState();
    await runManualSequence(restoreTarget, undefined, undefined, true);
  }

  /** Starts a restored foreground run; the lifecycle never owns one of these. */
  function spawnRestoredForeground() {
    if (manualRun !== undefined || manualSequencing) {
      void resumeRestoredManualSequence();
      return;
    }
    if (goalCreation !== undefined) {
      void spawnGoalCreation(goalCreation);
      return;
    }
    if (goalRevision !== undefined) {
      void spawnGoalRevision(goalRevision);
      return;
    }
    if (skillsPreparation !== undefined) {
      void spawnSkillsPreparation(skillsPreparation);
    }
  }

  /**
   * A restored process ends the peers its predecessor left and continues its
   * work. A paused run spawns nothing until `resumeLifecycle`.
   */
  async function resumeRestoredWork(children: RecordedChild[]): Promise<void> {
    await terminateRecordedChildren(children);

    if (restartWhenIdle) {
      if (options.restart === undefined) {
        restartWhenIdle = false;
        persistState();
        startupNotices.push({
          type: "error",
          message: "Restarting the server is not available.",
        });
      } else {
        // The request survives this process; the fleet's idle wait resumes it.
        holdRestartUntilIdle();
      }
    }

    if (skillsPreparationPending) {
      const pending = restoredPendingSkills;
      restoredPendingSkills = undefined;
      skillsPreparationPending = false;
      if (pending === undefined || pending.snapshot === null) {
        await startSkillsPreparation(restoreTarget);
      } else {
        await startSkillsPreparation(restoreTarget, {
          snapshot: pending.snapshot,
          unmanagedNames: pending.unmanagedNames,
        });
      }
      return;
    }

    spawnRestoredForeground();

    if (!lifecycleRunning || restoredPausedLifecycle) return;
    await continueRestoredLifecycle();
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
    if (pendingSkills !== undefined) {
      // The interrupted preparation may have deleted managed skills already.
      try {
        restoreDirectorySync(skillsDir, pendingSkills.snapshot);
      } catch {
        // The reset reports its own failures; the skills snapshot is best effort.
      }
      pendingSkills = undefined;
    }
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

    // Resetting the host would discard reviewed Flow work and leave its pull
    // request open, so an unmerged Flow session refuses the reset.
    if (flow.hasUnmergedSession()) {
      send(ws, {
        type: "error",
        message:
          "A Flow session is not merged. Merge it before resetting the implementation.",
      });
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
        // An unusable state file and an interrupted reset are reported once,
        // to the first client, before any restored state.
        while (startupNotices.length > 0) {
          const notice = startupNotices.shift();
          if (notice !== undefined) send(ws, notice);
        }
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

        // Flow's own state follows Goal Mode's, so the two modes replay
        // independently; it still precedes every reply to the client's commands.
        flow.replay(ws);
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
            restartServer(ws, command.whenIdle === true);
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
          } else if (command.type === "createFlowGoal") {
            await flow.createGoal();
          } else if (command.type === "startFlowImplementation") {
            await flow.startImplementation();
          } else if (command.type === "stopFlowImplementation") {
            flow.stopImplementation();
          } else if (command.type === "saveFlowGoal") {
            flow.saveGoal(command.text);
          } else if (command.type === "retryFlowPr") {
            await flow.retryPr();
          } else if (command.type === "markFlowPrReady") {
            await flow.markPrReady();
          } else if (command.type === "mergeFlowPr") {
            await flow.mergePr();
          } else if (command.type === "sendFlowSteering") {
            flow.sendSteering(command.text);
          } else if (command.type === "saveFlowDecisions") {
            flow.saveDecisions(command.text);
          } else if (command.type === "acceptFlowWidget") {
            flow.acceptWidget(command.id, command.accepted);
          } else if (command.type === "refuseFlowWidget") {
            flow.refuseWidget(command.id, command.reason);
          } else if (command.type === "openFlowWidget") {
            flow.openConversation(command.id);
          } else if (command.type === "closeFlowWidget") {
            flow.closeConversation();
          } else if (command.type === "sendFlowConversation") {
            flow.sendConversationMessage(command.text);
          } else if (command.type === "sendFlowConclusion") {
            await flow.sendConversationConclusion(command.text);
          } else if (command.type === "dismissFlowBlocker") {
            flow.dismissBlocker(command.id);
          } else if (command.type === "flowAnswer") {
            flow.answer(command.id, command.value, command.target);
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
    flow.dispose();
    if (restartWhenIdleTimer !== undefined) {
      clearInterval(restartWhenIdleTimer);
      restartWhenIdleTimer = undefined;
    }
    restartWhenIdle = false;
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
    if (pendingSkills !== undefined) {
      restoreDirectorySync(skillsDir, pendingSkills.snapshot);
      pendingSkills = undefined;
    }
    return stop(closeActiveConnections);
  };

  return server;
}
