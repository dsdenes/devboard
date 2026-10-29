import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
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
import { WatchdogActivity, type WatchdogActivityOptions } from "./watchdog";
import { BackgroundAgentBridge, type AgentCommand } from "./agents/bridge";
import { AgentPromptController, DiscoverPromptController } from "./agents/prompt";
import {
  agentRegistry,
  DISCOVER_AGENTS,
  DISCOVER_RUN_ORDER,
  discoverAgent,
  isDiscoverAgentId,
  type DiscoverAgentId,
} from "./agents/registry";
import {
  AcpConnection,
  agentPrompt,
  type AcpActivity,
  type AcpQuestion,
  type AcpQuestionOption,
} from "./acp";
import { AskController } from "./ask";
import {
  FeedbackDeliveryError,
  FeedbackRequestError,
  fileFeedbackIssue,
  parseFeedbackSubmission,
} from "./feedback";
import { FlowController, type FlowOptions } from "./flow";
import { parseGoalProposalSubmission, writeGoalProposal } from "./goal-proposal";
import { suggestGoalSlug } from "./goal-slug";
import {
  GoalDraftError,
  GoalDraftManager,
  listGoalDrafts,
  readGoalDraft,
} from "./goal-drafts";
import { defaultGoalPath, readGoal, writeGoal } from "./goal";
import { originRepository } from "../issues/repository";
import { IssuesBridge, type IssuesBridgeOptions } from "./issues";
import { TRACKER_SYNC_INTERVAL_MS } from "./issue-sync";
import { ScoutBridge, type ScoutBridgeOptions } from "./scout";
import { DesignBridge, type DesignBridgeOptions } from "./design";
import { CoachActivity, type CoachActivityOptions } from "./coach";
import { openJournal, type Journal, type JournalKind } from "./journal";
import { toolListPayload } from "../mcp/catalog";
import {
  DISCOVER_SKILLS,
  artifactsStale,
  confirmGlossaryTerm,
  declaredCommandAliases,
  dependencyRepositories,
  hostFacts,
  isInsideRepository,
  liveWarnings,
  parseRemoteUrl,
  claimScratchEntry,
  cleanupRemoteScratch,
  listRetainedProjects,
  publishAgentStaged,
  readArtifacts,
  readRetainedProject,
  rejectGlossaryTerm,
  remoteCloneName,
  remoteCloneRequest,
  remoteProjectDirectory,
  remoteScratchRoot,
  releaseScratchEntry,
  removeRetainedProject,
  removeStaging,
  restoreLiveSkill,
  retainRemoteProject,
  retainedProjectReady,
  saveLiveSkill,
  stagingDirectory,
  validateAgentStaged,
  type AgentStaged,
  type DiscoverArtifacts,
  type RemoteCloneRequest,
  type RemoteCloneResult,
  type RemoteCloneRunner,
  type RemoteRepository,
  type RetainedRemoteProject,
} from "./discover";
import { readRecords, type AdrRecord } from "./records";
import { ProviderService, ProviderUnavailableError, USAGE_TTL_MS } from "./providers";
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
  TrackerAbortedError,
  TrackerTimeoutError,
  TRACKER_READ_TIMEOUT_MS,
  type EpicLookup,
  type OpenEpic,
} from "./tracker";
import {
  isHarnessSourceCheckout,
  readHarnessVersion,
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
  /** Gitea HTTP origin; reporting is disabled when absent. */
  baseUrl?: string;
  /** `owner/name` repository that receives reported issues. */
  repo?: string;
  token?: string;
  timeoutMs?: number;
  /** Test seam; production uses the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AppOptions {
  adrDir: string;
  staticDir: string;
  hostname: string;
  /** Extra hostnames the listener answers to, e.g. a reverse proxy name. */
  allowedHosts?: readonly string[];
  port: number;
  repoDir?: string;
  goalFile?: string;
  agentCommand?: string;
  tracker?: EpicLookup;
  trackerSettle?: Partial<TrackerSettle>;
  /** Wall-clock bound for one tracker read; defaults to 30 seconds. */
  trackerTimeoutMs?: number;
  /** Wall-clock bound for one git invocation of the reset; defaults to 60 seconds. */
  gitTimeoutMs?: number;
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
  /** The harness package version this process loaded; captured at startup. */
  runningVersion?: string | null;
  /** The newest release the update check has seen, if it has seen one. */
  latestVersion?: () => string | null;
  /**
   * Flow Mode's deterministic seams: an injected forge and executor for tests
   * and browser verification, and the watcher timings for focused runs.
   */
  flow?: Pick<FlowOptions, "forge" | "forgeTarget" | "exec" | "watchMs" | "analystTimeoutMs" | "goalTimeoutMs">;
  /**
   * Discover's remote-clone seam: tests replace the `git clone` child, the
   * default runner spawns it with the bounded environment and timeout.
   */
  discoverClone?: RemoteCloneRunner;
  /** Test seam for the clone bound; defaults to the request's timeout. */
  discoverCloneTimeoutMs?: number;
  /** Issues mode's test seams; production uses the detached worker itself. */
  issues?: Pick<
    IssuesBridgeOptions,
    "pollMs" | "preflightTimeoutMs" | "preflight" | "spawnWorker" | "closeIssue" | "syncMs" | "syncRead"
  >;
  /** Auto Scout's test seams; production uses the detached worker itself. */
  scout?: Pick<
    ScoutBridgeOptions,
    "pollMs" | "preflightTimeoutMs" | "preflight" | "spawnWorker"
  >;
  /** Design System's test seams; production uses the detached worker itself. */
  design?: Pick<DesignBridgeOptions, "pollMs" | "preflight" | "spawnWorker">;
  /** Coach's test seams; production reads its worker's state and ledger. */
  coach?: Pick<
    CoachActivityOptions,
    "reader" | "now" | "intervalMs" | "staleAfterMs" | "preflight" | "spawnWorker"
  >;
  /** Watchdog's test seams; production reads `gh` in the background. */
  watchdog?: Pick<
    WatchdogActivityOptions,
    "reader" | "now" | "intervalMs" | "staleAfterMs" | "preflight" | "spawnWorker" | "systemctl"
  >;
  /** Names one proposed-goal draft; production asks the configured ACP agent. */
  goalSlug?: (report: string) => Promise<string>;
  /** The credential store and selection; defaults to the state directory's. */
  providers?: ProviderService;
  /**
   * How often a connected dashboard refreshes provider usage; the usage TTL
   * by default, and at least 10ms.
   */
  providersRefreshMs?: number;
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

type SkillFamily = "prepare" | "discover";
type SkillState = "generated" | "edited" | "missing";

interface SkillSummary {
  name: string;
  description: string;
  family: SkillFamily;
  state: SkillState;
  /** The SKILL.md text, empty for a skill the manifest names but the host lacks. */
  content: string;
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
  family: SkillFamily;
  directives: { polarity: "positive" | "negative"; text: string; source: string }[];
  /** The whole SKILL.md, so the interface can open a skill without a second read. */
  content: string;
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

/** A Discover run a replacement re-spawns against the same target. */
interface StoredDiscover {
  runId: string;
  stagingDir: string;
  startedAt: string;
  /** The one agent the replacement re-spawns. */
  agent: string;
  activity: string[];
  question: StoredQuestion | null;
  /** The remote project the run crawls; `null` for this checkout's host. */
  remote: StoredDiscoverTarget | null;
}

/**
 * The active remote target, stored without a path: the clone directory is
 * derived from the state directory, so a moved state never points at a stale
 * absolute path.
 */
interface StoredDiscoverTarget {
  url: string;
  owner: string;
  repo: string;
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
  discover: StoredDiscover | null;
  discoverInterrupted: boolean;
  discoverTarget: StoredDiscoverTarget | null;
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
/** The name of the pattern a reset appends for an in-repo state directory. */
const RESET_STATE_EXCLUDE_COMMENT = "# Devboard state directory";
const RESET_COMMIT_MESSAGE = "chore: reset implementation";
const RESET_PUSH_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  NO_COLOR: "1",
};
/** Wall-clock bound for one git invocation the dashboard spawns. */
const GIT_TIMEOUT_MS = 60_000;
/** Largest accepted feedback body, before JSON parsing. */
const MAX_FEEDBACK_BYTES = 64_000;
/** Default wall-clock bound for one issue creation. */
const FEEDBACK_TIMEOUT_MS = 60_000;

/**
 * Running dashboards register their stop handler here so a termination signal
 * releases every child peer instead of leaving the agents orphaned.
 */
const shutdownHooks = new Set<() => void>();
let shutdownBound = false;

function bindShutdown(hook: () => void): void {
  shutdownHooks.add(hook);
  if (shutdownBound) return;
  shutdownBound = true;
  const halt = (): void => {
    for (const stop of [...shutdownHooks]) {
      try {
        stop();
      } catch {
        // A failed cleanup must not keep the dashboard alive.
      }
    }
    process.exit(0);
  };
  process.once("SIGTERM", halt);
  process.once("SIGINT", halt);
}

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

/** The Discover target a client's skill edit was authored against. */
type SkillSaveTarget =
  | { kind: "host" }
  | { kind: "remote"; owner: string; repo: string };

/** Reads a save frame's target descriptor; a malformed or absent one is null. */
function parseSkillSaveTarget(value: unknown): SkillSaveTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "host") return { kind: "host" };
  if (record.kind !== "remote") return null;
  const owner = record.owner;
  const repo = record.repo;
  if (typeof owner !== "string" || owner.length === 0) return null;
  if (typeof repo !== "string" || repo.length === 0) return null;
  return { kind: "remote", owner, repo };
}

/** Remote identities compare by owner/repo, the same way retention names them. */
function sameSkillSaveTarget(left: SkillSaveTarget, right: SkillSaveTarget): boolean {
  if (left.kind === "host" && right.kind === "host") return true;
  if (left.kind === "remote" && right.kind === "remote") {
    return remoteCloneName(left.owner, left.repo) === remoteCloneName(right.owner, right.repo);
  }
  return false;
}

type ClientMessage =
  | { type: "listRecords" }
  | { type: "getGoal" }
  | { type: "getProject" }
  | { type: "getVersion" }
  | { type: "getMcpTools" }
  | { type: "getIssues" }
  | { type: "getIssuesRun"; runId?: unknown }
  | { type: "startIssues" }
  | { type: "pauseIssues" }
  | { type: "resumeIssues" }
  | { type: "stopIssues" }
  | { type: "checkIssues" }
  | { type: "answerIssues"; id?: unknown; value?: unknown; runId?: unknown }
  | { type: "closeIssue"; number?: unknown }
  | { type: "getGoalDrafts" }
  | { type: "getGoalDraft"; path?: unknown }
  | { type: "startGoalDraft"; path?: unknown }
  | { type: "stopGoalDraft"; path?: unknown }
  | { type: "answerGoalDraft"; path?: unknown; id?: unknown; value?: unknown }
  | { type: "getAgents" }
  | { type: "getAgent"; id?: unknown }
  | { type: "startAgent"; id?: unknown }
  | { type: "stopAgent"; id?: unknown }
  | {
      type: "setAgentSettings";
      id?: unknown;
      minutes?: unknown;
      maxPerHour?: unknown;
      maxPending?: unknown;
    }
  | { type: "disableAgentTimer"; id?: unknown }
  | { type: "getAgentPrompt"; id?: unknown }
  | { type: "saveAgentPrompt"; id?: unknown; text?: unknown }
  | { type: "sendAgentPromptChat"; id?: unknown; message?: unknown; text?: unknown }
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
  | { type: "deleteSkill"; name?: unknown }
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
  | { type: "answer"; id?: unknown; value?: unknown; lane?: unknown }
  | { type: "discoverProject" }
  | { type: "discoverAgent"; agent?: unknown }
  | { type: "saveDiscoverPrompt"; agent?: unknown; text?: unknown }
  | { type: "chatDiscoverPrompt"; agent?: unknown; message?: unknown; text?: unknown }
  | { type: "discoverRemote"; url?: unknown }
  | { type: "switchDiscoverRemote"; url?: unknown }
  | { type: "removeDiscoverRemote"; url?: unknown }
  | { type: "clearDiscoverRemote" }
  | { type: "stopDiscover" }
  | { type: "answerDiscover"; id?: unknown; value?: unknown }
  | { type: "getDiscover" }
  | { type: "saveDiscoverSkill"; name?: unknown; text?: unknown; target?: unknown }
  | { type: "restoreDiscoverSkill"; name?: unknown }
  | { type: "confirmGlossaryTerm"; context?: unknown; id?: unknown }
  | { type: "rejectGlossaryTerm"; context?: unknown; id?: unknown; reason?: unknown }
  | { type: "ask"; conversationId?: unknown; question?: unknown; context?: unknown }
  | { type: "closeAsk"; conversationId?: unknown }
  | { type: "getProviders" }
  | { type: "saveProvider"; id?: unknown; provider?: unknown; label?: unknown; key?: unknown }
  | { type: "deleteProvider"; id?: unknown }
  | { type: "setProviderEnabled"; id?: unknown; enabled?: unknown }
  | { type: "refreshProviders" };

function isAgentCommand(
  command: ClientMessage,
): command is Extract<ClientMessage, { type: AgentCommand["type"] }> {
  return (
    command.type === "getAgents" ||
    command.type === "getAgent" ||
    command.type === "startAgent" ||
    command.type === "stopAgent" ||
    command.type === "setAgentSettings" ||
    command.type === "disableAgentTimer"
  );
}

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
    case "getMcpTools":
      return { type: "getMcpTools" };
    case "getIssues":
      return { type: "getIssues" };
    case "getIssuesRun":
      return { type: "getIssuesRun", runId: "runId" in value ? value.runId : undefined };
    case "startIssues":
      return { type: "startIssues" };
    case "pauseIssues":
      return { type: "pauseIssues" };
    case "resumeIssues":
      return { type: "resumeIssues" };
    case "stopIssues":
      return { type: "stopIssues" };
    case "checkIssues":
      return { type: "checkIssues" };
    case "answerIssues":
      return {
        type: "answerIssues",
        id: "id" in value ? value.id : undefined,
        value: "value" in value ? value.value : undefined,
        runId: "runId" in value ? value.runId : undefined,
      };
    case "closeIssue":
      return { type: "closeIssue", number: "number" in value ? value.number : undefined };
    case "getGoalDrafts":
      return { type: "getGoalDrafts" };
    case "getGoalDraft":
      return { type: "getGoalDraft", path: "path" in value ? value.path : undefined };
    case "startGoalDraft":
      return { type: "startGoalDraft", path: "path" in value ? value.path : undefined };
    case "stopGoalDraft":
      return { type: "stopGoalDraft", path: "path" in value ? value.path : undefined };
    case "answerGoalDraft":
      return {
        type: "answerGoalDraft",
        path: "path" in value ? value.path : undefined,
        id: "id" in value ? value.id : undefined,
        value: "value" in value ? value.value : undefined,
      };
    case "getAgents":
      return { type: "getAgents" };
    case "getAgent":
      return { type: "getAgent", id: "id" in value ? value.id : undefined };
    case "startAgent":
      return { type: "startAgent", id: "id" in value ? value.id : undefined };
    case "stopAgent":
      return { type: "stopAgent", id: "id" in value ? value.id : undefined };
    case "setAgentSettings":
      return {
        type: "setAgentSettings",
        id: "id" in value ? value.id : undefined,
        minutes: "minutes" in value ? value.minutes : undefined,
        maxPerHour: "maxPerHour" in value ? value.maxPerHour : undefined,
        maxPending: "maxPending" in value ? value.maxPending : undefined,
      };
    case "disableAgentTimer":
      return { type: "disableAgentTimer", id: "id" in value ? value.id : undefined };
    case "getAgentPrompt":
      return { type: "getAgentPrompt", id: "id" in value ? value.id : undefined };
    case "saveAgentPrompt":
      return {
        type: "saveAgentPrompt",
        id: "id" in value ? value.id : undefined,
        text: "text" in value ? value.text : undefined,
      };
    case "sendAgentPromptChat":
      return {
        type: "sendAgentPromptChat",
        id: "id" in value ? value.id : undefined,
        message: "message" in value ? value.message : undefined,
        text: "text" in value ? value.text : undefined,
      };
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
    case "deleteSkill":
      return { type: "deleteSkill", name: "name" in value ? value.name : undefined };
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
    case "discoverProject":
      return { type: "discoverProject" };
    case "discoverAgent":
      return { type: "discoverAgent", agent: "agent" in value ? value.agent : undefined };
    case "saveDiscoverPrompt":
      return {
        type: "saveDiscoverPrompt",
        agent: "agent" in value ? value.agent : undefined,
        text: "text" in value ? value.text : undefined,
      };
    case "chatDiscoverPrompt":
      return {
        type: "chatDiscoverPrompt",
        agent: "agent" in value ? value.agent : undefined,
        message: "message" in value ? value.message : undefined,
        text: "text" in value ? value.text : undefined,
      };
    case "discoverRemote":
      // A missing or non-string URL is a malformed payload, never a command.
      return "url" in value && typeof value.url === "string"
        ? { type: "discoverRemote", url: value.url }
        : undefined;
    case "switchDiscoverRemote":
      return "url" in value && typeof value.url === "string"
        ? { type: "switchDiscoverRemote", url: value.url }
        : undefined;
    case "removeDiscoverRemote":
      return "url" in value && typeof value.url === "string"
        ? { type: "removeDiscoverRemote", url: value.url }
        : undefined;
    case "clearDiscoverRemote":
      return { type: "clearDiscoverRemote" };
    case "stopDiscover":
      return { type: "stopDiscover" };
    case "answerDiscover":
      return {
        type: "answerDiscover",
        id: "id" in value ? value.id : undefined,
        value: "value" in value ? value.value : undefined,
      };
    case "getDiscover":
      return { type: "getDiscover" };
    case "saveDiscoverSkill":
      return {
        type: "saveDiscoverSkill",
        name: "name" in value ? value.name : undefined,
        text: "text" in value ? value.text : undefined,
        target: "target" in value ? value.target : undefined,
      };
    case "restoreDiscoverSkill":
      return { type: "restoreDiscoverSkill", name: "name" in value ? value.name : undefined };
    case "confirmGlossaryTerm":
      return {
        type: "confirmGlossaryTerm",
        context: "context" in value ? value.context : undefined,
        id: "id" in value ? value.id : undefined,
      };
    case "rejectGlossaryTerm":
      return {
        type: "rejectGlossaryTerm",
        context: "context" in value ? value.context : undefined,
        id: "id" in value ? value.id : undefined,
        reason: "reason" in value ? value.reason : undefined,
      };
    case "ask":
      return {
        type: "ask",
        conversationId: "conversationId" in value ? value.conversationId : undefined,
        question: "question" in value ? value.question : undefined,
        context: "context" in value ? value.context : undefined,
      };
    case "closeAsk":
      return {
        type: "closeAsk",
        conversationId: "conversationId" in value ? value.conversationId : undefined,
      };
    case "getProviders":
      return { type: "getProviders" };
    case "saveProvider":
      return {
        type: "saveProvider",
        id: "id" in value ? value.id : undefined,
        provider: "provider" in value ? value.provider : undefined,
        label: "label" in value ? value.label : undefined,
        key: "key" in value ? value.key : undefined,
      };
    case "deleteProvider":
      return { type: "deleteProvider", id: "id" in value ? value.id : undefined };
    case "setProviderEnabled":
      return {
        type: "setProviderEnabled",
        id: "id" in value ? value.id : undefined,
        enabled: "enabled" in value ? value.enabled : undefined,
      };
    case "refreshProviders":
      return { type: "refreshProviders" };
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
  const familyField = fields.get("metadata.devboard-family");
  return {
    directory,
    name: fields.get("name") ?? "",
    description,
    managed: fields.get(`metadata.${MANAGED_MARKER}`) === "true",
    // A managed skill without a family belongs to the prepare family, so
    // skills written before the family marker keep working.
    family: familyField === "discover" ? "discover" : "prepare",
    directives: extractDirectives(source),
    content: source,
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
    if (skill?.managed === true && skill.family === "prepare") names.add(directory);
  }
  return names;
}

interface SkillsInspection {
  skills: SkillSummary[];
  managed: Map<string, SkillFile>;
  prepare: Map<string, SkillFile>;
  discover: Map<string, SkillFile>;
  unmanaged: Map<string, SkillFile>;
  errors: string[];
  contradictions: SkillContradiction[];
}

async function inspectSkills(root: string): Promise<SkillsInspection> {
  const managed = new Map<string, SkillFile>();
  const prepare = new Map<string, SkillFile>();
  const discover = new Map<string, SkillFile>();
  const unmanaged = new Map<string, SkillFile>();

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await readSkillAt(root, entry.name);
    if (skill === undefined) continue;
    if (skill.managed) {
      managed.set(entry.name, skill);
      if (skill.family === "discover") discover.set(entry.name, skill);
      else prepare.set(entry.name, skill);
    } else {
      unmanaged.set(entry.name, skill);
    }
  }

  // Discover's published manifest names the five skills even when the
  // developer deleted one; a missing skill is listed instead of vanishing.
  const published = readArtifacts(dirname(dirname(root)));
  const discoverStates = new Map<string, SkillSummary>();
  if (published.artifacts !== null) {
    for (const skill of published.artifacts.skills) {
      discoverStates.set(skill.name, {
        name: skill.name,
        description: skill.description,
        family: "discover",
        state: skill.state,
        content: "",
      });
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

  const summaries: SkillSummary[] = [...managed.values()].map((skill) => {
    const view = discoverStates.get(skill.directory);
    const live = skill.family === "discover" ? view?.state ?? "generated" : "generated";
    return {
      name: skill.name,
      description: skill.description,
      family: skill.family,
      state: live,
      content: skill.content,
    };
  });
  for (const [name, view] of discoverStates) {
    if (managed.has(name)) continue;
    if (view.state !== "missing") continue;
    summaries.push(view);
  }
  summaries.sort((left, right) => left.name.localeCompare(right.name));

  // Preparation's contradiction review covers its own family plus hand-authored
  // skills only: a project-specific Discover directive cannot fail it.
  const contradictions = findContradictions([...prepare.values(), ...unmanaged.values()]);
  return { skills: summaries, managed, prepare, discover, unmanaged, errors, contradictions };
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

/**
 * One bounded `git` invocation. The child never reads stdin and is killed when
 * it outlives its bound, so a stalled `git push` fails the caller with a
 * timeout result instead of pinning it for the life of the process. The bound
 * covers the output reads too: a grandchild inheriting the pipes can otherwise
 * keep them open after the child itself is gone.
 */
async function runGit(
  repoDir: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  const controller = new AbortController();
  let killChild: (() => void) | undefined;

  const invocation = (async (): Promise<GitResult> => {
    const spawned = Bun.spawn({
      cmd: ["git", "-C", repoDir, ...args],
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    killChild = () => {
      try {
        spawned.kill("SIGKILL");
      } catch {
        // The child is already gone; the timeout result still stands.
      }
    };
    const [stdout, stderr] = await Promise.all([
      new Response(spawned.stdout).text(),
      new Response(spawned.stderr).text(),
    ]);
    return { code: await spawned.exited, stdout, stderr };
  })().catch((error: unknown): GitResult => ({
    code: -1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));

  const timeout = Promise.withResolvers<GitResult>();
  const timer = setTimeout(() => {
    // The abort kills the child; SIGKILL covers one that ignores it.
    controller.abort();
    killChild?.();
    timeout.resolve({
      code: -1,
      stdout: "",
      stderr: `git ${args[0] ?? ""} timed out after ${timeoutMs}ms`,
    });
  }, timeoutMs);

  try {
    return await Promise.race([invocation, timeout.promise]);
  } finally {
    clearTimeout(timer);
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
 * The state directory relative to the repository root: `""` when it is the
 * root itself, `undefined` when it lies outside, and a path inside otherwise.
 * A reset never deletes its own state, so the root is refused and an inside
 * path is preserved.
 */
function resetStatePath(repoDir: string, stateDir: string): string | undefined {
  const path = relative(resolve(repoDir), resolve(stateDir));
  if (path === "") return "";
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path;
}

/** Removes one reset target, unlinking a symlink instead of following it. */
async function removeResetTarget(path: string, entry: Dirent): Promise<void> {
  if (entry.isSymbolicLink()) await unlink(path);
  else await rm(path, { recursive: true, force: true });
}

/**
 * Clears one top-level entry while preserving the chain down to a nested
 * state directory: every sibling at each level is deleted, and the state
 * directory itself stays untouched.
 */
async function clearExceptResetState(target: string, keep: string[]): Promise<void> {
  const [next, ...rest] = keep;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === next) {
      // A symlinked ancestor is preserved as a link; its target is never
      // entered, and the state directory lives wherever the link points.
      if (rest.length > 0 && !entry.isSymbolicLink()) {
        await clearExceptResetState(join(target, entry.name), rest);
      }
      continue;
    }
    await removeResetTarget(join(target, entry.name), entry);
  }
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

function parseStoredDiscover(value: unknown): StoredDiscover | null {
  const record = asObject(value);
  if (record === undefined) return null;
  const runId = record.runId;
  const stagingDir = record.stagingDir;
  const startedAt = record.startedAt;
  const activity = parseStoredActivity(record.activity);
  const agent = record.agent;
  if (typeof runId !== "string" || typeof stagingDir !== "string") return null;
  if (typeof startedAt !== "string" || activity === undefined) return null;
  // A run recorded before the split has no agent to re-spawn; the interruption
  // stays recorded and nothing is published.
  if (!isDiscoverAgentId(agent)) return null;
  // An absent field is an older host run, except that a run staged under the
  // remote scratch root is a remote run this version cannot name. Never resume
  // that one as a host crawl.
  let remote: StoredDiscoverTarget | null = null;
  if (record.remote !== undefined && record.remote !== null) {
    remote = parseStoredDiscoverTarget(record.remote);
    if (remote === null) return null;
  } else if (stagingDir.includes(`${sep}discover-remote${sep}`)) {
    return null;
  }
  return {
    runId,
    stagingDir,
    startedAt,
    agent,
    activity,
    question: parseStoredQuestion(record.question),
    remote,
  };
}

/** A stored target is usable only when its URL and its derived names agree. */
function parseStoredDiscoverTarget(value: unknown): StoredDiscoverTarget | null {
  const record = asObject(value);
  if (record === undefined) return null;
  const url = record.url;
  const owner = record.owner;
  const repo = record.repo;
  if (typeof url !== "string" || typeof owner !== "string" || typeof repo !== "string") return null;
  const parsed = parseRemoteUrl(url);
  if (!parsed.ok) return null;
  if (parsed.repository.owner !== owner || parsed.repository.repo !== repo) return null;
  return { url: parsed.repository.url, owner, repo };
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
    discover: parseStoredDiscover(record.discover),
    discoverInterrupted: record.discoverInterrupted === true,
    discoverTarget: parseStoredDiscoverTarget(record.discoverTarget),
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

/**
 * The production `git clone` child. It never prompts, never colors its output,
 * and is bounded by the request's timeout; an unreadable spawn is a failure
 * like any non-zero exit. The bound covers the output read too: a remote
 * helper that inherits the stderr pipe keeps it open after the clone child is
 * gone, so the read never reaches EOF and only the timer can settle the call.
 * The child owns its process group, so the timeout reaps that helper as well
 * instead of leaving it behind.
 */
async function spawnClone(request: RemoteCloneRequest): Promise<RemoteCloneResult> {
  const controller = new AbortController();
  let killChild: (() => void) | undefined;

  const invocation = (async (): Promise<RemoteCloneResult> => {
    const child = Bun.spawn({
      cmd: request.argv,
      cwd: request.cwd,
      env: request.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      signal: controller.signal,
      detached: true,
    });
    killChild = () => {
      try {
        // The child leads its own session, so its helpers share the group.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone, or the platform has no process groups.
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // The child is already gone; the timeout result still stands.
      }
    };
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stderr, timedOut: false };
  })().catch((error: unknown): RemoteCloneResult => ({
    code: -1,
    stderr: error instanceof Error ? error.message : String(error),
    timedOut: false,
  }));

  const timeout = Promise.withResolvers<RemoteCloneResult>();
  const timer = setTimeout(() => {
    controller.abort();
    killChild?.();
    timeout.resolve({ code: -1, stderr: "", timedOut: true });
  }, request.timeoutMs);

  try {
    return await Promise.race([invocation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** Names a loopback listener answers to besides its configured address. */
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"] as const;

/** Bind addresses that name no host a browser can put in a URL. */
const WILDCARD_HOSTNAMES: Record<string, true> = {
  "0.0.0.0": true,
  "[::]": true,
};

/**
 * A hostname in the form Bun puts in `URL.hostname`, or null when the value
 * is not a host at all. Ports are dropped: the listener already chose its
 * port, and a port never distinguishes one of its own names.
 */
function canonicalHostname(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(`http://${trimmed}`).hostname.toLowerCase();
  } catch {
    // A configured IPv6 address may be bare, while a Host header is bracketed.
    if (!trimmed.includes(":") || trimmed.startsWith("[")) return null;
    try {
      return new URL(`http://[${trimmed}]`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}

/**
 * The hostnames this listener serves. The configured bind address is one;
 * loopback aliases cover the default and a container's published port. A
 * wildcard bind names no host, so it serves only the loopback aliases and the
 * explicit allowlist.
 */
function allowedRequestHostnames(
  hostname: string,
  configured: readonly string[] = [],
): ReadonlySet<string> {
  const allowed = new Set<string>(LOOPBACK_HOSTNAMES);
  const bound = canonicalHostname(hostname);
  if (bound !== null && WILDCARD_HOSTNAMES[bound] !== true) allowed.add(bound);
  for (const value of configured) {
    const extra = canonicalHostname(value);
    if (extra !== null && WILDCARD_HOSTNAMES[extra] !== true) allowed.add(extra);
  }
  return allowed;
}

/** Why a browser request must be refused, or null when it may proceed. */
type RequestRefusal = "host" | "origin" | null;

/**
 * The host and origin guards shared by the mutating endpoints and the socket.
 *
 * `url.host` is built from the request's Host header, which a rebinding page
 * controls, so the listener's own names decide which hosts it serves. Only
 * then does the Origin comparison add the same-origin check; a client without
 * an Origin header is not a page and is accepted.
 */
function requestRefusal(
  request: Request,
  url: URL,
  allowedHostnames: ReadonlySet<string>,
): RequestRefusal {
  const host = request.headers.get("host");
  const hostname = host === null ? null : canonicalHostname(host);
  if (hostname === null || !allowedHostnames.has(hostname)) return "host";

  const origin = request.headers.get("origin");
  if (origin === null) return null;
  try {
    return new URL(origin).host === url.host ? null : "origin";
  } catch {
    return "origin";
  }
}

/**
 * The method, host, origin, size, and JSON guards shared by the mutating
 * browser endpoints. A request for another host, or a cross-origin page, must
 * never reach a handler with a side effect; the body is bounded before it is
 * parsed.
 */
async function readMutationBody(
  request: Request,
  url: URL,
  allowedHostnames: ReadonlySet<string>,
): Promise<{ value: unknown } | { response: Response }> {
  if (request.method !== "POST") {
    return {
      response: new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } }),
    };
  }

  const refusal = requestRefusal(request, url, allowedHostnames);
  if (refusal !== null) {
    return {
      response: Response.json(
        {
          error:
            refusal === "host"
              ? "The request host is not served by this dashboard."
              : "Cross-origin feedback is refused.",
        },
        { status: 403 },
      ),
    };
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FEEDBACK_BYTES) {
    return {
      response: Response.json(
        { error: `The report is larger than ${MAX_FEEDBACK_BYTES} bytes.` },
        { status: 413 },
      ),
    };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch (error) {
    return {
      response: Response.json(
        { error: error instanceof Error ? error.message : "The report could not be read." },
        { status: 400 },
      ),
    };
  }
  if (raw.length > MAX_FEEDBACK_BYTES) {
    return {
      response: Response.json(
        { error: `The report is larger than ${MAX_FEEDBACK_BYTES} bytes.` },
        { status: 413 },
      ),
    };
  }

  try {
    return { value: JSON.parse(raw) };
  } catch {
    return {
      response: Response.json({ error: "The report is not valid JSON." }, { status: 400 }),
    };
  }
}

export function createApp(options: AppOptions) {
  const staticRoot = resolve(options.staticDir);
  const allowedHostnames = allowedRequestHostnames(options.hostname, options.allowedHosts);
  const adrDir = resolve(options.adrDir);
  const repoDir = options.repoDir ?? dirname(adrDir);
  const project = projectLabel(repoDir);
  // The checkout's origin cannot change while this process lives.
  const hostRepository = originRepository(repoDir) ?? null;
  const goalFile = options.goalFile ?? defaultGoalPath(repoDir);
  // The creation skill always writes the repository's goal document, while
  // getGoal and saveGoal keep using the configured goal file.
  const creationGoalFile = defaultGoalPath(repoDir);
  const skillsDir = join(repoDir, ".omp", "skills");
  const agentCommand = options.agentCommand ?? process.env.AGENT_COMMAND ?? "omp acp";
  // A draft name is chosen by an LLM; any failure falls back to the
  // deterministic slug inside `writeGoalProposal`.
  const goalSlug =
    options.goalSlug ??
    (async (report: string) =>
      suggestGoalSlug(report, {
        command: agentCommand,
        cwd: repoDir,
        env: await peerEnvironment(),
      }));
  // Every Ask peer runs in the host repository, whatever the request came from.
  const ask = new AskController({
    command: agentCommand,
    cwd: repoDir,
    environment: peerEnvironment,
  });
  const tracker = options.tracker ?? findOpenEpics;
  const trackerSettle: TrackerSettle = {
    attempts: Math.max(1, options.trackerSettle?.attempts ?? TRACKER_SETTLE_ATTEMPTS),
    delayMs: Math.max(0, options.trackerSettle?.delayMs ?? TRACKER_SETTLE_DELAY_MS),
  };
  const trackerTimeoutMs = Math.max(
    1,
    options.trackerTimeoutMs ?? TRACKER_READ_TIMEOUT_MS,
  );
  const gitTimeoutMs = Math.max(1, options.gitTimeoutMs ?? GIT_TIMEOUT_MS);
  /** Every git call this dashboard makes shares the one configured bound. */
  const runRepoGit = (args: string[], env: Record<string, string> = {}) =>
    runGit(repoDir, args, env, gitTimeoutMs);
  const laneBackoffMs = Math.max(0, options.laneBackoffMs ?? LANE_BACKOFF_MS);
  const laneRetentionMs = Math.max(0, options.laneRetentionMs ?? LANE_RETENTION_MS);
  const mainPollMs = Math.max(10, options.mainPollMs ?? MAIN_POLL_MS);
  const providersRefreshMs = Math.max(10, options.providersRefreshMs ?? USAGE_TTL_MS);
  const feedbackBaseUrl = options.feedback?.baseUrl ?? "";
  const feedbackEnabled = feedbackBaseUrl.length > 0;
  const feedbackRepo = options.feedback?.repo ?? "dsdenes/devboard";
  const feedbackTimeoutMs = Math.max(1, options.feedback?.timeoutMs ?? FEEDBACK_TIMEOUT_MS);
  const feedbackFetch = options.feedback?.fetchImpl;
  // The state belongs to this checkout, not to the harness installation: hosts
  // share one harness through a symlink, so the repository path keys the file.
  const stateDir = resolve(options.stateDir ?? join(import.meta.dir, "..", ".tmp"));
  // The operator's provider credentials and the per-peer selection. OMP's own
  // login state is never consulted for these two providers.
  const providers =
    options.providers ??
    new ProviderService({
      stateDir,
      log: (line) => process.stderr.write(`${line}\n`),
    });
  /**
   * The environment one ACP peer receives. It throws before a process is
   * spawned when no subscription can serve the peer.
   */
  async function peerEnvironment(): Promise<Record<string, string | undefined>> {
    return (await providers.select()).env;
  }
  // The journal records what happened for the watchdog. It is never part of a
  // run's behavior: a failed write only adds a line to stderr.
  const journal =
    options.journal ?? openJournal({ stateDir, repoDir, port: options.port });
  const statePath = stateFile(stateDir, resolve(repoDir));
  const loadedState = readStateFile(statePath);
  const runningVersion = options.runningVersion ?? readHarnessVersion(runningHarnessDir());
  const readVersion =
    options.versionState ??
    (() => serverVersion(repoDir, runningVersion, options.latestVersion?.() ?? null));

  /**
   * Discover Mode's run state. The crawl is server-owned: a browser
   * disconnect, a view switch, or a stopped run never resumes it, and a
   * replacement process interrupts it instead.
   */
  interface DiscoverRun {
    runId: string;
    stagingDir: string;
    /** The target root the agent was started against: host, or a run's checkout. */
    cwd: string;
    startedAt: string;
    /** The one Discover agent this peer runs. */
    id: DiscoverAgentId;
    /** `all` while the run belongs to a Run all sequence. */
    mode: "single" | "all";
    peer: AcpConnection | undefined;
    activity: string[];
    question: RunQuestion | null;
    /** The remote project this run re-discovers, when the target is remote. */
    remote?: RemoteRepository;
  }
  /** One card's last reported run state. */
  interface DiscoverAgentStatus {
    state: "idle" | "running" | "succeeded" | "failed";
    startedAt: string | null;
    endedAt: string | null;
    error: string | null;
  }
  let discoverRun: DiscoverRun | undefined;
  let discoverInterrupted = false;
  /** Invalidates an in-flight start when a reset or stop takes over. */
  let discoverRequest = 0;
  let discoverArtifacts: DiscoverArtifacts | null = null;
  let discoverReadError: string | null = null;
  let discoverWarnings: string[] = [];
  let discoverStale = false;
  let restoredDiscover: StoredDiscover | undefined;
  /** A reset owned the checkout at death; its work is never resumed. */
  let restoredResetActive = false;
  let lastDiscoverBusy: string | null = null;
  /** One status per card; a new single trigger leaves the others as they were. */
  const discoverAgentStates = new Map<string, DiscoverAgentStatus>();
  for (const descriptor of DISCOVER_AGENTS) {
    discoverAgentStates.set(descriptor.id, {
      state: "idle",
      startedAt: null,
      endedAt: null,
      error: null,
    });
  }
  /** True while a Run all sequence owns the checkout. */
  let discoverAllActive = false;

  function discoverStatus(id: string): DiscoverAgentStatus {
    return (
      discoverAgentStates.get(id) ?? {
        state: "idle",
        startedAt: null,
        endedAt: null,
        error: null,
      }
    );
  }

  function setDiscoverStatus(id: string, status: DiscoverAgentStatus): void {
    discoverAgentStates.set(id, status);
  }

  function resetDiscoverStatuses(): void {
    for (const descriptor of DISCOVER_AGENTS) {
      setDiscoverStatus(descriptor.id, {
        state: "idle",
        startedAt: null,
        endedAt: null,
        error: null,
      });
    }
  }

  /**
   * The remote target is a source-checkout-only manual-testing aid: the
   * dashboard keeps a public GitHub project's published artifacts under its own
   * state directory and crawls a fresh checkout of it on demand. Installed hosts
   * never see it, and never read or write the retained root.
   */
  const remoteAvailable = isHarnessSourceCheckout(repoDir);
  const remoteRoot = remoteScratchRoot(stateDir);
  const cloneRunner = options.discoverClone ?? spawnClone;
  let remoteTarget: RemoteRepository | undefined;
  /** The run's checkout: a clone that never outlives the run that made it. */
  let remoteCheckout: { runId: string; dir: string; target: RemoteRepository } | null = null;
  let discoverCloning: { url: string; target: RemoteRepository } | null = null;

  /** True when both sides are absent or name the same lowercased owner/repo. */
  function sameRemoteTarget(
    a: RemoteRepository | undefined,
    b: RemoteRepository | undefined,
  ): boolean {
    if (a === undefined || b === undefined) return a === b;
    return remoteCloneName(a.owner, a.repo) === remoteCloneName(b.owner, b.repo);
  }

  /** Every Discover read and write goes through the active target. */
  function targetRoot(): string {
    if (remoteTarget === undefined) return repoDir;
    return remoteProjectDirectory(remoteRoot, remoteTarget.owner, remoteTarget.repo);
  }

  function clearRemoteCheckout(): void {
    const checkout = remoteCheckout;
    remoteCheckout = null;
    if (checkout === null) return;
    try {
      rmSync(checkout.dir, { recursive: true, force: true });
    } catch {
      // The next start removes a checkout that cannot be removed.
    }
    releaseScratchEntry(remoteRoot, basename(checkout.dir));
  }

  /**
   * Flow Mode's controller. It owns its own session files under `stateDir` and
   * never touches Goal Mode's state: it only reports its active work so the
   * two modes cannot both hold the checkout.
   */
  const flow = new FlowController({
    repoDir,
    stateDir,
    agentCommand,
    agentEnvironment: peerEnvironment,
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
  /** Tracker reads the lifecycle owns; a stop or reset aborts every one. */
  const trackerReads = new Set<AbortController>();
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
  let providerRefreshTimer: Timer | undefined;

  /** Events a restored process owes the first client before its own replies. */
  const startupNotices: unknown[] = [];
  /** A stored remote target whose clone is gone; reported to the next client. */
  let discoverTargetNotice: string | null = null;
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
  function sendAll(event: unknown, except?: { send(data: string): unknown }) {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client === except) continue;
      try {
        client.send(payload);
      } catch {
        // A closing client must not interrupt delivery to the others.
      }
    }
  }

  function broadcast(event: unknown) {
    persistState();
    sendAll(event);
    // The Discover start control's disabled state follows the work the other
    // modes hold, so a transition is pushed once per change.
    syncDiscoverBusy();
  }

  /** Re-reads stale usage and pushes the masked provider state to everyone. */
  async function publishProviders(force = false): Promise<void> {
    await providers.refresh(force);
    broadcast({ type: "providersState", ...providers.view() });
  }

  /**
   * Usage is otherwise fetched only when someone asks, so an open dashboard
   * would show a stale quota forever. While at least one client is connected,
   * force one refresh per interval and push the masked state; an idle server
   * makes no provider call, and a new client's `getProviders` refreshes first.
   */
  function startProviderRefresh() {
    if (providerRefreshTimer !== undefined) return;
    providerRefreshTimer = setInterval(() => {
      if (clients.size === 0) return;
      void publishProviders(true).catch((error) => {
        process.stderr.write(
          `providers: periodic refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
    }, providersRefreshMs);
    providerRefreshTimer.unref?.();
  }
  startProviderRefresh();

  /**
   * The Open issues view refreshes from the forge on its own cadence, so a
   * closure made in the browser reaches the board even while Issues
   * automation is stopped. Thirty seconds by default; the environment can
   * override it for a busy forge.
   */
  const issuesSyncEnv = Number(process.env.DEVBOARD_ISSUES_SYNC_INTERVAL_MS);
  const issuesSyncMs =
    options.issues?.syncMs ??
    (Number.isFinite(issuesSyncEnv) && issuesSyncEnv > 0
      ? Math.max(1_000, issuesSyncEnv)
      : TRACKER_SYNC_INTERVAL_MS);

  /**
   * Issues mode reads and commands the detached worker for this checkout. The
   * bridge never owns the worker: starting one is detached, stopping this
   * server leaves it alive, and a replacement attaches to the same state.
   */
  const issues = new IssuesBridge({
    repoDir,
    stateDir,
    agentCommand,
    agentEnvironment: peerEnvironment,
    runningVersion,
    harnessDir: runningHarnessDir(),
    send: (event, except) => sendAll(event, except),
    log: (line) => process.stderr.write(`${line}\n`),
    hasClients: () => clients.size > 0,
    syncMs: issuesSyncMs,
    ...(options.issues?.pollMs === undefined ? {} : { pollMs: options.issues.pollMs }),
    ...(options.issues?.syncRead === undefined ? {} : { syncRead: options.issues.syncRead }),
    ...(options.issues?.preflightTimeoutMs === undefined
      ? {}
      : { preflightTimeoutMs: options.issues.preflightTimeoutMs }),
    ...(options.issues?.preflight === undefined ? {} : { preflight: options.issues.preflight }),
    ...(options.issues?.spawnWorker === undefined ? {} : { spawnWorker: options.issues.spawnWorker }),
    ...(options.issues?.closeIssue === undefined ? {} : { closeIssue: options.issues.closeIssue }),
  });
  issues.begin();

  /**
   * The Drafts view's elaboration peers. A detached owner process holds each
   * agent and persists its run under the state directory, so the reload
   * control's replacement attaches to the same peers; any other server exit
   * ends them and leaves the interrupted failures behind.
   */
  const goalDrafts = new GoalDraftManager({
    repoDir,
    stateDir,
    command: agentCommand,
    environment: peerEnvironment,
    send: (event) => sendAll(event),
    log: (line) => process.stderr.write(`${line}\n`),
  });

  /**
   * Auto Scout reads and commands the detached scout worker for this
   * checkout. It owns no scan loop: starting one is detached, stopping this
   * server leaves it alive, and a replacement attaches to the same board.
   */
  const scoutDescriptor = agentRegistry.require("scout");
  const watchdogDescriptor = agentRegistry.require("watchdog");
  const designDescriptor = agentRegistry.require("design");
  const coachDescriptor = agentRegistry.require("coach");
  const scout = new ScoutBridge({
    descriptor: scoutDescriptor,
    repoDir,
    stateDir,
    agentCommand,
    agentEnvironment: peerEnvironment,
    runningVersion,
    harnessDir: runningHarnessDir(),
    send: (event, except) => sendAll(event, except),
    log: (line) => process.stderr.write(`${line}\n`),
    ...(options.scout?.pollMs === undefined ? {} : { pollMs: options.scout.pollMs }),
    ...(options.scout?.preflightTimeoutMs === undefined
      ? {}
      : { preflightTimeoutMs: options.scout.preflightTimeoutMs }),
    ...(options.scout?.preflight === undefined ? {} : { preflight: options.scout.preflight }),
    ...(options.scout?.spawnWorker === undefined ? {} : { spawnWorker: options.scout.spawnWorker }),
  });

  /**
   * Watchdog reads the root-anchored worker, ledger, and run history, overlays
   * the forge projection, and starts or stops the detached worker. Every
   * dashboard on the root reads the same machine state.
   */
  const watchdog = new WatchdogActivity({
    descriptor: watchdogDescriptor,
    repoDir,
    stateDir,
    harnessDir: runningHarnessDir(),
    send: (event, except) => sendAll(event, except),
    log: (line) => process.stderr.write(`${line}\n`),
    ...(options.watchdog?.reader === undefined ? {} : { reader: options.watchdog.reader }),
    ...(options.watchdog?.now === undefined ? {} : { now: options.watchdog.now }),
    ...(options.watchdog?.intervalMs === undefined
      ? {}
      : { intervalMs: options.watchdog.intervalMs }),
    ...(options.watchdog?.staleAfterMs === undefined
      ? {}
      : { staleAfterMs: options.watchdog.staleAfterMs }),
    ...(options.watchdog?.preflight === undefined ? {} : { preflight: options.watchdog.preflight }),
    ...(options.watchdog?.spawnWorker === undefined
      ? {}
      : { spawnWorker: options.watchdog.spawnWorker }),
    ...(options.watchdog?.systemctl === undefined
      ? {}
      : { systemctl: options.watchdog.systemctl }),
  });

  /**
   * Design System audits the interface source and the two design documents,
   * files `design` issues, and releases accepted documentation to main. It
   * also runs as a detached worker so it outlives this server.
   */
  const design = new DesignBridge({
    descriptor: designDescriptor,
    repoDir,
    stateDir,
    agentCommand,
    agentEnvironment: peerEnvironment,
    runningVersion,
    harnessDir: runningHarnessDir(),
    send: (event, except) => sendAll(event, except),
    log: (line) => process.stderr.write(`${line}\n`),
    ...(options.design?.pollMs === undefined ? {} : { pollMs: options.design.pollMs }),
    ...(options.design?.preflight === undefined ? {} : { preflight: options.design.preflight }),
    ...(options.design?.spawnWorker === undefined
      ? {}
      : { spawnWorker: options.design.spawnWorker }),
  });

  /**
   * Coach reads the ACP transcripts and journal records already on disk,
   * overlays the forge projection its caps count, and commands its detached
   * worker. Opening the page never starts a cycle.
   */
  const coach = new CoachActivity({
    descriptor: coachDescriptor,
    repoDir,
    stateDir,
    harnessDir: runningHarnessDir(),
    send: (event, except) => sendAll(event, except),
    environment: process.env,
    log: (line) => process.stderr.write(`${line}\n`),
    ...(options.coach?.reader === undefined ? {} : { reader: options.coach.reader }),
    ...(options.coach?.now === undefined ? {} : { now: options.coach.now }),
    ...(options.coach?.intervalMs === undefined
      ? {}
      : { intervalMs: options.coach.intervalMs }),
    ...(options.coach?.staleAfterMs === undefined
      ? {}
      : { staleAfterMs: options.coach.staleAfterMs }),
    ...(options.coach?.preflight === undefined ? {} : { preflight: options.coach.preflight }),
    ...(options.coach?.spawnWorker === undefined
      ? {}
      : { spawnWorker: options.coach.spawnWorker }),
  });

  /** The shared control plane every background agent answers through. */
  const agents = new BackgroundAgentBridge({
    registry: agentRegistry,
    adapters: [scout, watchdog, design, coach],
    broadcast: (event) => sendAll(event),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  agents.begin();

  /**
   * The prompt half of each agent page. It reads the effective prompt file;
   * Save writes that one file only from a harness source checkout, and chat
   * proposes text without writing.
   */
  const prompts = new AgentPromptController({
    registry: agentRegistry,
    repoDir,
    agentCommand,
    agentEnvironment: peerEnvironment,
    harnessDir: runningHarnessDir(),
    send: (event, except) => sendAll(event, except),
    log: (line) => process.stderr.write(`${line}\n`),
  });

  /**
   * The prompt half of each Discover card. Each of the six reads, saves, and
   * chats about its own prompt file; an installed host shows the bytes
   * read-only, and every prompt write and chat is refused there.
   */
  const discoverPrompts = new DiscoverPromptController({
    repoDir,
    agentCommand,
    agentEnvironment: peerEnvironment,
    harnessDir: runningHarnessDir(),
    send: (event, except) => sendAll(event, except),
    log: (line) => process.stderr.write(`${line}\n`),
  });

  /** The pids and commands a replacement needs to end this process's peers. */
  function captureChildren(): RecordedChild[] {
    const children: RecordedChild[] = [];
    const remember = (agent: AcpConnection | undefined, cwd = repoDir) => {
      const pid = agent?.pid;
      if (agent === undefined || pid === undefined) return;
      children.push({ pid, argv: agent.argv, cwd });
    };
    remember(manualRun?.agent);
    remember(goalCreation?.agent);
    remember(goalRevision?.agent);
    remember(skillsPreparation?.agent);
    remember(discoverRun?.peer, discoverRun?.cwd);
    for (const lane of liveLanes) remember(lane.agent);
    // Flow's own peers — implementation, goal interview, analyst, and widget
    // conversation — are recorded by their controller with their real cwds.
    children.push(...flow.children());
    // Running elaborations belong to their detached owners, not to this
    // process: a replacement must adopt them, never end them as orphans.
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
      discover:
        discoverRun === undefined
          ? null
          : {
              runId: discoverRun.runId,
              stagingDir: discoverRun.stagingDir,
              startedAt: discoverRun.startedAt,
              agent: discoverRun.id,
              activity: [...discoverRun.activity],
              question: captureQuestion(discoverRun.question),
              remote:
                discoverRun.remote === undefined
                  ? null
                  : {
                      url: discoverRun.remote.url,
                      owner: discoverRun.remote.owner,
                      repo: discoverRun.remote.repo,
                    },
            },
      discoverInterrupted,
      discoverTarget:
        remoteTarget === undefined
          ? null
          : {
              url: remoteTarget.url,
              owner: remoteTarget.owner,
              repo: remoteTarget.repo,
            },
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

  /**
   * Drops a stored Discover target whose retained project is missing, rewriting
   * only that field. A full `persistState` here would also replace the recorded
   * interrupted run before the replacement has read and reported it.
   */
  function dropStoredDiscoverTarget(): void {
    const loaded = readStateFile(statePath);
    if (loaded.kind !== "loaded") return;
    const value = loaded.value as Record<string, unknown>;
    if (value.discoverTarget === null || value.discoverTarget === undefined) return;
    value.discoverTarget = null;
    const text = JSON.stringify({ version: STATE_VERSION, state: value });
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
    discoverInterrupted = stored.discoverInterrupted;
    // A retained project is the durable record; a run's checkout never survives.
    // An installed host has no remote target, whatever an older state recorded,
    // and never reads or writes the retained root.
    const storedTarget = remoteAvailable ? stored.discoverTarget : null;
    if (remoteAvailable) cleanupRemoteScratch(remoteRoot);
    if (storedTarget !== null) {
      const directory = remoteProjectDirectory(remoteRoot, storedTarget.owner, storedTarget.repo);
      const record = readRetainedProject(directory);
      if (record !== null && retainedProjectReady(directory, record)) {
        remoteTarget = storedTarget;
      } else {
        discoverTargetNotice = `The retained Discover project for ${storedTarget.url} is missing, so the host target is active.`;
        dropStoredDiscoverTarget();
      }
    }
    if (stored.discover !== null) {
      // The replacement re-spawns the crawl once its predecessor's children
      // are ended. Until that run starts, the page still reports it interrupted
      // so a run that cannot be restarted keeps its evidence.
      restoredDiscover = stored.discover;
      discoverInterrupted = true;
    }
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
      restoredResetActive = true;
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
    if (remoteAvailable) cleanupRemoteScratch(remoteRoot);
    const message = `The saved dashboard state could not be restored: ${loadedState.reason}. Starting from an empty dashboard.`;
    process.stderr.write(`${message}\n`);
    startupNotices.push({ type: "error", message });
  } else if (loadedState.kind === "loaded") {
    const stored = parseStoredState(loadedState.value);
    if (stored === undefined) {
      if (remoteAvailable) cleanupRemoteScratch(remoteRoot);
      preserveStateFile(statePath);
      const message =
        "The saved dashboard state could not be restored: its contents are not a dashboard state. Starting from an empty dashboard.";
      process.stderr.write(`${message}\n`);
      startupNotices.push({ type: "error", message });
    } else {
      applyRestoredState(stored);
      if (discoverTargetNotice !== null) {
        const message = discoverTargetNotice;
        discoverTargetNotice = null;
        // The fallback is handled: the durable target is gone and the notice is
        // sent once. It is not a server failure the watchdog should file.
        journal.write("lifecycle", "discover-remote-missing");
        startupNotices.push({ type: "discoverError", message });
      }
      // Ends the killed process's peers and continues its work once the
      // listener is bound; a restore failure is reported, never thrown.
      void resumeRestoredWork(stored.children).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        journal.write("server-error", `state: could not resume: ${detail}`);
        process.stderr.write(`state: could not resume: ${detail}\n`);
      });
    }
  } else if (remoteAvailable) {
    cleanupRemoteScratch(remoteRoot);
  }

  function sendVersion(ws: { send(data: string): unknown }) {
    send(ws, { type: "versionState", ...readVersion(), feedbackEnabled });
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
      flow.hasActiveWork() ||
      discoverRun !== undefined ||
      discoverCloning !== null ||
      remoteCheckout !== null
    );
  }

  /** Names the work that keeps another mode out, Discover excluded. */
  function goalWorkLabel(): string | undefined {
    if (implementationReset !== undefined) return "an implementation reset";
    if (goalCreation !== undefined) return "a goal creation";
    if (goalRevision !== undefined) return "a goal revision";
    if (skillsPreparation !== undefined || skillsPreparationPending) return "skills preparation";
    if (lifecycleRunning) return "the lifecycle";
    if (manualRun !== undefined || manualSequencing || sequencing) return "a manual ADR run";
    return undefined;
  }

  /** Names the Goal Mode work Flow Mode would contend with, if any. */
  function activeGoalWork(): string | undefined {
    if (discoverCloning !== null) return "a repository clone";
    if (remoteCheckout !== null) return "a repository checkout";
    return goalWorkLabel() ?? (discoverRun === undefined ? undefined : "a Discover run");
  }

  /** What blocks a Discover start, as a sentence the control shows verbatim. */
  function discoverBusyReason(): string | null {
    const label = goalWorkLabel();
    if (label !== undefined) return `${label.charAt(0).toUpperCase()}${label.slice(1)} is active.`;
    if (flow.hasActiveWork()) return "Flow Mode is active.";
    return null;
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

  function refreshDiscoverSnapshot(): void {
    const root = targetRoot();
    const read = readArtifacts(root);
    discoverArtifacts = read.artifacts;
    discoverReadError = read.error;
    if (read.artifacts === null) {
      discoverWarnings = [];
      discoverStale = false;
      return;
    }
    try {
      discoverWarnings = liveWarnings(root, read.artifacts);
    } catch {
      discoverWarnings = [];
    }
    // A retained remote project is a snapshot, not a checkout: there is no
    // tree of its own to compare against, so it is never reported stale.
    discoverStale = remoteTarget === undefined ? artifactsStale(root, read.artifacts) : false;
  }

  function discoverStatePayload(): Record<string, unknown> {
    // A clone or crawl of another remote project is the repository the page is
    // working on; until it publishes, the active target's artifacts are hidden.
    const inFlightRemote = discoverCloning?.target ?? remoteCheckout?.target;
    const showingInFlight =
      inFlightRemote !== undefined && !sameRemoteTarget(inFlightRemote, remoteTarget);
    const shownRemote = showingInFlight ? inFlightRemote : remoteTarget;
    const artifacts = showingInFlight ? null : discoverArtifacts;
    const root = targetRoot();
    return {
      active: discoverRun !== undefined,
      runId: discoverRun?.runId ?? null,
      startedAt: discoverRun?.startedAt ?? null,
      activeAgent: discoverRun?.id ?? null,
      runningAll: discoverAllActive,
      agents: DISCOVER_AGENTS.map((descriptor) => {
        const status = discoverStatus(descriptor.id);
        return {
          id: descriptor.id,
          label: descriptor.label,
          command: descriptor.command,
          state: status.state,
          startedAt: status.startedAt,
          endedAt: status.endedAt,
          error: status.error,
          prompt: discoverPrompts.snapshot(descriptor.id),
        };
      }),
      interrupted: discoverInterrupted,
      stale: showingInFlight ? false : discoverStale,
      warnings: showingInFlight ? [] : discoverWarnings,
      busy: discoverBusyReason(),
      error: showingInFlight ? null : discoverReadError,
      remoteAvailable,
      retained: remoteAvailable ? listRetainedProjects(remoteRoot) : [],
      repository:
        shownRemote === undefined ? hostRepository : `${shownRemote.owner}/${shownRemote.repo}`,
      target:
        shownRemote === undefined
          ? { kind: "host" }
          : {
              kind: "remote",
              url: shownRemote.url,
              owner: shownRemote.owner,
              repo: shownRemote.repo,
              checkout:
                remoteCheckout !== null && sameRemoteTarget(remoteCheckout.target, shownRemote),
            },
      cloning: discoverCloning === null ? null : { url: discoverCloning.url },
      manifest: artifacts?.manifest ?? null,
      freshness: artifacts?.sheet?.freshness ?? null,
      sheet: artifacts?.sheet ?? null,
      // The manifest's own invocations for the commands the sheet recorded, so
      // the interface shows `npm test` rather than the program it expands to.
      commandAliases: artifacts === null ? [] : declaredCommandAliases(root),
      dependencyRepositories:
        artifacts === null || artifacts.sheet === null
          ? {}
          : dependencyRepositories(root, artifacts.sheet),
      glossaries: artifacts?.glossaries ?? [],
      glossaryUsage: artifacts?.usage ?? {},
      glossarySignificance: artifacts?.significance ?? {},
      decisions: artifacts?.decisions ?? [],
      skills: artifacts?.skills ?? [],
    };
  }

  function sendDiscoverState(target: { send(data: string): unknown }) {
    send(target, { type: "discoverState", state: discoverStatePayload() });
  }

  /**
   * Pushes the whole Discover snapshot. It is derived from the published
   * artifacts and the run in memory, so it never adds anything to the durable
   * state beyond the run itself.
   */
  function broadcastDiscoverState() {
    persistState();
    sendAll({ type: "discoverState", state: discoverStatePayload() });
  }

  /** Pushes the start control's disabled reason once per change. */
  function syncDiscoverBusy() {
    const reason = discoverBusyReason();
    if (reason === lastDiscoverBusy) return;
    lastDiscoverBusy = reason;
    sendAll({ type: "discoverState", state: discoverStatePayload() });
  }

  function discoverFailure(ws: { send(data: string): unknown }, message: string) {
    send(ws, { type: "discoverError", message });
  }

  /** Ends a run without publishing: staging goes, the last artifacts stay. */
  function failDiscover(run: DiscoverRun, message: string) {
    if (discoverRun !== run) return;
    discoverRun = undefined;
    discoverAllActive = false;
    run.question = null;
    run.peer?.close();
    try {
      removeStaging(run.cwd, run.runId);
    } catch {
      // A staging directory that cannot be removed is reported by the next run.
    }
    setDiscoverStatus(run.id, {
      state: "failed",
      startedAt: discoverStatus(run.id).startedAt ?? run.startedAt,
      endedAt: new Date().toISOString(),
      error: message,
    });
    // A failed remote run leaves no checkout and no partial snapshot: the
    // retained project and the active target are exactly what they were.
    clearRemoteCheckout();
    refreshDiscoverSnapshot();
    broadcast({ type: "discoverError", message, agent: run.id });
    broadcastDiscoverState();
    broadcast({ type: "discoverStopped", completed: false, agent: run.id, mode: run.mode });
  }

  /** True while a Discover run or clone is the active work; used by the refusal text. */
  function refuseGoalWhileDiscovering(ws: { send(data: string): unknown }): boolean {
    if (discoverCloning !== null) {
      send(ws, {
        type: "error",
        message: "A repository clone is active. Wait for it before starting other work.",
      });
      return true;
    }
    if (discoverRun === undefined) return false;
    send(ws, {
      type: "error",
      message: "A Discover run is active. Finish or stop it before starting other work.",
    });
    return true;
  }

  /**
   * Clones one remote project into a transient checkout. The checkout is the
   * crawl root; the retained snapshot is only replaced once the crawl publishes.
   */
  async function cloneRemoteProject(
    ws: { send(data: string): unknown },
    target: RemoteRepository,
  ): Promise<boolean> {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const staging = join(remoteRoot, `.staging-${runId}`);
    try {
      mkdirSync(remoteRoot, { recursive: true });
      // The claim must exist before the clone does: another dashboard starting
      // on the same state directory must never sweep a live checkout.
      if (!claimScratchEntry(remoteRoot, basename(staging))) {
        throw new Error(`the scratch root is not writable: ${remoteRoot}`);
      }
    } catch (error) {
      discoverFailure(
        ws,
        `Could not prepare the Discover scratch root: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }

    // The clone state leaves before the child spawns, so every client sees it.
    discoverCloning = { url: target.url, target };
    journal.write("lifecycle", "discover-remote-clone");
    broadcastDiscoverState();

    const request = remoteCloneRequest(target.url, remoteRoot, runId);
    const cloneTimeoutMs = Math.max(1, options.discoverCloneTimeoutMs ?? request.timeoutMs);
    const requestTimeoutSeconds = Math.round(cloneTimeoutMs / 1000);
    let result: RemoteCloneResult;
    try {
      result = await cloneRunner({ ...request, timeoutMs: cloneTimeoutMs });
    } catch (error) {
      result = {
        code: -1,
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
    }

    const cloneFailed = (message: string): false => {
      discoverCloning = null;
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // The next start removes a staging directory that cannot be removed.
      }
      releaseScratchEntry(remoteRoot, basename(staging));
      discoverFailure(ws, message);
      broadcastDiscoverState();
      return false;
    };

    if (result.timedOut) {
      return cloneFailed(`The repository clone timed out after ${requestTimeoutSeconds} seconds.`);
    }
    if (result.code !== 0) {
      return cloneFailed(`The repository clone failed: git exited with status ${result.code}.`);
    }
    let readable = false;
    try {
      readable = statSync(staging).isDirectory();
    } catch {
      readable = false;
    }
    if (!readable) {
      return cloneFailed("The repository clone produced no readable directory.");
    }

    // The checkout starts from the retained snapshot. Otherwise one agent's
    // publication would replace the whole snapshot and drop every other slice.
    const retained = remoteProjectDirectory(remoteRoot, target.owner, target.repo);
    try {
      for (const tree of ["discover", "skills"]) {
        const from = join(retained, ".omp", tree);
        if (!existsSync(from)) continue;
        mkdirSync(join(staging, ".omp"), { recursive: true });
        cpSync(from, join(staging, ".omp", tree), { recursive: true });
      }
    } catch (error) {
      return cloneFailed(
        `The retained Discover artifacts could not be copied into the checkout: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    discoverCloning = null;
    remoteCheckout = { runId, dir: staging, target };
    broadcastDiscoverState();
    return true;
  }

  /** True while one agent or a Run all sequence holds the Discover gate. */
  function discoverActive(): boolean {
    return discoverRun !== undefined || discoverAllActive;
  }

  /** The root and project name one command runs against, cloning first if needed. */
  async function discoverRoot(ws: { send(data: string): unknown }): Promise<{
    root: string;
    remote: RemoteRepository | undefined;
    project: string;
  } | null> {
    // A retained remote project has no checkout: the command recreates one.
    if (remoteTarget !== undefined && remoteCheckout === null) {
      if (!(await cloneRemoteProject(ws, remoteTarget))) return null;
    }
    const checkout = remoteCheckout;
    const remote = checkout?.target;
    const root = checkout === null ? repoDir : checkout.dir;
    return {
      root,
      remote,
      project: remote === undefined ? project : `${remote.owner}/${remote.repo}`,
    };
  }

  /** Refuses a start that would run beside a live agent or Run all. */
  function discoverStartRefusal(
    ws: { send(data: string): unknown },
  ): boolean {
    if (discoverCloning !== null) {
      discoverFailure(ws, "A repository clone is active. Wait for it to finish.");
      return true;
    }
    if (discoverAllActive) {
      discoverFailure(ws, "Run all is active. Wait for it to finish or stop it.");
      return true;
    }
    if (discoverRun !== undefined) {
      discoverFailure(ws, "A Discover run is already active.");
      return true;
    }
    const busy = discoverBusyReason();
    if (busy !== null) {
      discoverFailure(ws, `A Discover run cannot start: ${busy}`);
      return true;
    }
    return false;
  }

  /**
   * Runs exactly one agent against one root: one peer, one staging directory,
   * one validated slice, one publication. Resolves true only when the slice
   * was published; a failure or a stop reports itself and resolves false.
   */
  async function runDiscoverAgent(
    ws: { send(data: string): unknown },
    id: DiscoverAgentId,
    mode: "single" | "all",
    target: { root: string; remote: RemoteRepository | undefined; project: string },
    resumed?: StoredDiscover,
  ): Promise<boolean> {
    const descriptor = discoverAgent(id);
    if (descriptor === undefined) {
      discoverFailure(ws, `Unknown Discover agent: ${id}.`);
      return false;
    }
    const { root, remote, project: projectName } = target;
    let factsBefore;
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const stagingDir = stagingDirectory(root, runId);
    try {
      factsBefore = hostFacts(root);
      mkdirSync(stagingDir, { recursive: true });
    } catch (error) {
      discoverFailure(
        ws,
        `Could not prepare the ${descriptor.label} staging directory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }

    const request = ++discoverRequest;
    const startedAt = resumed?.startedAt ?? new Date().toISOString();
    const run: DiscoverRun = {
      runId,
      stagingDir,
      cwd: root,
      startedAt,
      id,
      mode,
      peer: undefined,
      // A resumed run keeps the activity its successor already saw; only the
      // peer and its staging are new.
      activity: resumed === undefined ? [] : [...resumed.activity],
      question: null,
      ...(remote === undefined ? {} : { remote }),
    };
    setDiscoverStatus(id, {
      state: "running",
      startedAt,
      endedAt: null,
      error: null,
    });
    discoverRun = run;
    discoverInterrupted = false;
    journal.write("lifecycle", "discover-start");
    broadcast({ type: "discoverStarted", runId, startedAt, agent: id, mode });
    broadcastDiscoverState();

    let peer: AcpConnection;
    try {
      const env = await peerEnvironment();
      // A stop or disposal during provider selection clears the run. The turn
      // must not start after the operator ended it.
      if (discoverRun !== run || request !== discoverRequest) return false;
      // The crawl root may be a remote clone. OMP would load its `.omp/skills`
      // and compress the descriptions in the background; a foreign skill logs
      // a warning the watchdog files. The agent contract already excludes every
      // `.omp` path, so the peer runs without skill discovery or loading.
      peer = new AcpConnection({
        command: `${agentCommand} --no-skills`,
        cwd: root,
        env,
        onActivity(activity: AcpActivity) {
          if (discoverRun !== run) return;
          journal.write("activity", activity.text);
          const append = activity.append && run.activity.length > 0;
          appendActivity(run.activity, activity.text, append);
          broadcast(
            append
              ? { type: "discoverActivity", agent: id, text: activity.text, append: true }
              : { type: "discoverActivity", agent: id, text: activity.text },
          );
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message, "discover");
          if (discoverRun !== run) return;
          run.question = {
            id: question.id,
            message: question.message,
            options: question.options,
          };
          broadcast({
            type: "discoverQuestion",
            agent: id,
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
    } catch (error) {
      failDiscover(
        run,
        `Could not start the ${descriptor.label} agent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (discoverRun !== run || request !== discoverRequest) {
      peer.close();
      return false;
    }
    run.peer = peer;

    try {
      await peer.run(`${descriptor.command} ${stagingDir}`);
    } catch (error) {
      failDiscover(
        run,
        `The ${descriptor.label} run failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    if (discoverRun !== run || request !== discoverRequest) return false;

    try {
      let present = true;
      try {
        present = statSync(root).isDirectory();
      } catch {
        present = false;
      }
      if (!present) {
        throw new Error(
          remote === undefined
            ? "the host directory disappeared during the run"
            : "the run's checkout was removed during the run",
        );
      }
      const facts = hostFacts(root);
      if (facts.fingerprint !== factsBefore.fingerprint) {
        throw new Error("the agent changed host files outside its staging directory");
      }
      const staged: AgentStaged = validateAgentStaged(root, stagingDir, {
        project: projectName,
        commit: facts.commit,
        dirty: facts.dirty,
        discoveredAt: new Date().toISOString(),
        fingerprint: facts.fingerprint,
      }, id);
      publishAgentStaged({ repoDir: root, runId, facts, staged, project: projectName, agent: id });
    } catch (error) {
      failDiscover(
        run,
        `${descriptor.label} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }

    try {
      removeStaging(root, runId);
    } catch {
      // The run's staging is best-effort; the published slice is already valid.
    }
    discoverRun = undefined;
    run.question = null;
    run.peer?.close();
    setDiscoverStatus(id, {
      state: "succeeded",
      startedAt,
      endedAt: new Date().toISOString(),
      error: null,
    });
    refreshDiscoverSnapshot();
    broadcastDiscoverState();
    return true;
  }

  /**
   * Ends a successful command: retains a remote snapshot, releases the
   * checkout, and reports the one completion frame its trigger answers.
   */
  function finishDiscoverCommand(
    target: { root: string; remote: RemoteRepository | undefined },
    mode: "single" | "all",
    agent: DiscoverAgentId,
  ): void {
    const { root, remote } = target;
    if (remote !== undefined) {
      const retained = retainRemoteProject(
        remoteRoot,
        root,
        {
          url: remote.url,
          owner: remote.owner,
          repo: remote.repo,
          completedAt: new Date().toISOString(),
        },
        remoteCheckout?.runId ?? `${Date.now()}`,
      );
      if (retained !== null) {
        discoverAllActive = false;
        setDiscoverStatus(agent, {
          state: "failed",
          startedAt: discoverStatus(agent).startedAt,
          endedAt: new Date().toISOString(),
          error: `Discover failed: ${retained}`,
        });
        clearRemoteCheckout();
        refreshDiscoverSnapshot();
        broadcast({ type: "discoverError", message: `Discover failed: ${retained}`, agent });
        broadcastDiscoverState();
        broadcast({ type: "discoverStopped", completed: false, agent, mode });
        return;
      }
      remoteTarget = remote;
    }
    clearRemoteCheckout();
    discoverInterrupted = false;
    discoverAllActive = false;
    refreshDiscoverSnapshot();
    broadcastDiscoverState();
    broadcast({ type: "discoverStopped", completed: true, agent, mode });
  }

  /** Starts one agent from its card. */
  async function startDiscoverAgentCommand(
    ws: { send(data: string): unknown },
    agent: unknown,
  ): Promise<void> {
    if (!isDiscoverAgentId(agent)) {
      discoverFailure(
        ws,
        typeof agent === "string"
          ? `Unknown Discover agent: ${agent}.`
          : "A Discover start needs an agent id.",
      );
      return;
    }
    if (discoverStartRefusal(ws)) return;
    const target = await discoverRoot(ws);
    if (target === null) return;
    const published = await runDiscoverAgent(ws, agent, "single", target);
    if (!published) return;
    finishDiscoverCommand(target, "single", agent);
  }

  /** Runs the six agents in the fixed order, publishing each slice as it lands. */
  async function startDiscoverAll(ws: { send(data: string): unknown }): Promise<void> {
    if (discoverStartRefusal(ws)) return;
    const target = await discoverRoot(ws);
    if (target === null) return;
    resetDiscoverStatuses();
    discoverAllActive = true;
    broadcastDiscoverState();
    let last: DiscoverAgentId = DISCOVER_RUN_ORDER[0] as DiscoverAgentId;
    for (const id of DISCOVER_RUN_ORDER) {
      last = id;
      const published = await runDiscoverAgent(ws, id, "all", target);
      if (!published) return;
    }
    finishDiscoverCommand(target, "all", last);
  }

  /** Re-spawns the one agent whose process died, against its stored target. */
  async function resumeDiscoverRun(stored: StoredDiscover): Promise<void> {
    if (!isDiscoverAgentId(stored.agent)) return;
    try {
      if (stored.remote === null) {
        if (discoverStartRefusal(restoreTarget)) return;
        const target = await discoverRoot(restoreTarget);
        if (target === null) return;
        const published = await runDiscoverAgent(
          restoreTarget,
          stored.agent,
          "single",
          target,
          stored,
        );
        if (published) finishDiscoverCommand(target, "single", stored.agent);
        return;
      }
      if (!remoteAvailable) {
        // An installed host cannot re-clone. The interruption remains recorded.
        discoverFailure(
          restoreTarget,
          `The Discover run started at ${stored.startedAt} was interrupted when the server restarted, and a remote run cannot be resumed in this installation.`,
        );
        refreshDiscoverSnapshot();
        broadcastDiscoverState();
        return;
      }
      await startDiscoverRemote(restoreTarget, stored.remote.url, stored);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      discoverFailure(restoreTarget, `The Discover run could not be resumed: ${detail}`);
      refreshDiscoverSnapshot();
      broadcastDiscoverState();
    }
  }

  /** Refuses a remote command in an installed host; the control never renders there. */
  function remoteUnavailable(ws: { send(data: string): unknown }): boolean {
    if (remoteAvailable) return false;
    discoverFailure(
      ws,
      "Discover from a repository URL is available only when the dashboard serves a harness source checkout.",
    );
    return true;
  }

  /**
   * Clones a public repository, crawls the clone once, and retains the result.
   * The previous target and its retained artifacts stay untouched when the
   * clone or the crawl fails.
   */
  async function startDiscoverRemote(
    ws: { send(data: string): unknown },
    url: string,
    resumed?: StoredDiscover,
  ) {
    if (remoteUnavailable(ws)) return;
    if (discoverCloning !== null) {
      discoverFailure(ws, "A repository clone is already active.");
      return;
    }
    if (discoverActive()) {
      discoverFailure(ws, "A Discover run is already active.");
      return;
    }
    const busy = discoverBusyReason();
    if (busy !== null) {
      discoverFailure(ws, `A repository clone cannot start: ${busy}`);
      return;
    }
    if (!isInsideRepository(repoDir, remoteRoot)) {
      discoverFailure(
        ws,
        "The Discover scratch root is outside the repository. STATE_DIR must name a directory inside the repository.",
      );
      return;
    }
    const parsed = parseRemoteUrl(url);
    if (!parsed.ok) {
      discoverFailure(ws, `Could not clone the repository: ${parsed.reason}.`);
      return;
    }
    if (!(await cloneRemoteProject(ws, parsed.repository))) return;
    if (resumed !== undefined) {
      if (!isDiscoverAgentId(resumed.agent)) return;
      const target = await discoverRoot(ws);
      if (target === null) return;
      const published = await runDiscoverAgent(
        ws,
        resumed.agent,
        "single",
        target,
        resumed,
      );
      if (published) finishDiscoverCommand(target, "single", resumed.agent);
      return;
    }
    // A repository URL discovers the whole project: Run all, once.
    await startDiscoverAll(ws);
  }

  /** The retained project a submitted URL names, by lowercased owner/repo. */
  function retainedProjectFor(url: string): RetainedRemoteProject | null {
    const parsed = parseRemoteUrl(url);
    if (!parsed.ok) return null;
    const name = remoteCloneName(parsed.repository.owner, parsed.repository.repo);
    return (
      listRetainedProjects(remoteRoot).find(
        (project) => remoteCloneName(project.owner, project.repo) === name,
      ) ?? null
    );
  }

  /** Refuses a target change while a clone or run holds the checkout. */
  function remoteChangeRefusal(
    ws: { send(data: string): unknown },
    action: string,
  ): boolean {
    if (discoverCloning !== null) {
      discoverFailure(ws, "A repository clone is active. Wait for it to finish.");
      return true;
    }
    if (discoverActive()) {
      discoverFailure(ws, `A Discover run is active. Stop it before ${action}.`);
      return true;
    }
    const busy = discoverBusyReason();
    if (busy !== null) {
      discoverFailure(ws, `The remote target cannot be changed: ${busy}`);
      return true;
    }
    return false;
  }

  /** Switches to a retained project without cloning, crawling, or networking. */
  function switchDiscoverRemote(ws: { send(data: string): unknown }, url: string) {
    if (remoteUnavailable(ws)) return;
    if (remoteChangeRefusal(ws, "switching projects")) return;
    const retained = retainedProjectFor(url);
    if (retained === null) {
      discoverFailure(ws, `No retained Discover project matches ${url.trim()}.`);
      return;
    }
    remoteTarget = { url: retained.url, owner: retained.owner, repo: retained.repo };
    journal.write("lifecycle", "discover-remote-switch");
    refreshDiscoverSnapshot();
    broadcastDiscoverState();
  }

  /** Deletes exactly one retained project, returning to the host when it was active. */
  function removeDiscoverRemote(ws: { send(data: string): unknown }, url: string) {
    if (remoteUnavailable(ws)) return;
    if (remoteChangeRefusal(ws, "removing a project")) return;
    const retained = retainedProjectFor(url);
    if (retained === null) {
      discoverFailure(ws, `No retained Discover project matches ${url.trim()}.`);
      return;
    }
    const removed = removeRetainedProject(remoteRoot, retained);
    if (removed !== null) {
      discoverFailure(ws, `The retained Discover project could not be removed: ${removed}`);
      return;
    }
    if (
      remoteTarget !== undefined &&
      remoteCloneName(remoteTarget.owner, remoteTarget.repo) ===
        remoteCloneName(retained.owner, retained.repo)
    ) {
      remoteTarget = undefined;
    }
    journal.write("lifecycle", "discover-remote-remove");
    refreshDiscoverSnapshot();
    broadcastDiscoverState();
  }

  /** Returns the Overview to this checkout's own published artifacts. */
  function clearDiscoverRemote(ws: { send(data: string): unknown }) {
    if (remoteUnavailable(ws)) return;
    if (discoverCloning !== null) {
      discoverFailure(ws, "A repository clone is active. Wait for it to finish.");
      return;
    }
    if (discoverActive()) {
      discoverFailure(ws, "A Discover run is active. Stop it before clearing the remote target.");
      return;
    }
    const busy = discoverBusyReason();
    if (busy !== null) {
      discoverFailure(ws, `The remote target cannot be cleared: ${busy}`);
      return;
    }
    if (remoteTarget === undefined) {
      discoverFailure(ws, "No remote Discover target is active.");
      return;
    }
    // Clearing changes the target only: every retained project keeps its bytes.
    remoteTarget = undefined;
    journal.write("lifecycle", "discover-remote-clear");
    refreshDiscoverSnapshot();
    broadcastDiscoverState();
  }

  function stopDiscover(ws: { send(data: string): unknown }) {
    const run = discoverRun;
    if (run === undefined && !discoverAllActive) {
      discoverFailure(ws, "No Discover run is active.");
      return;
    }
    discoverRequest += 1;
    discoverRun = undefined;
    discoverAllActive = false;
    if (run !== undefined) {
      run.question = null;
      run.peer?.close();
      try {
        removeStaging(run.cwd, run.runId);
      } catch {
        // The staging directory may already be gone.
      }
      setDiscoverStatus(run.id, {
        state: "failed",
        startedAt: discoverStatus(run.id).startedAt ?? run.startedAt,
        endedAt: new Date().toISOString(),
        error: "Stopped by the operator.",
      });
    }
    clearRemoteCheckout();
    refreshDiscoverSnapshot();
    broadcast({
      type: "discoverStopped",
      completed: false,
      agent: run?.id ?? null,
      mode: run?.mode ?? "all",
    });
    broadcastDiscoverState();
  }

  function answerDiscoverQuestion(
    ws: { send(data: string): unknown },
    id: unknown,
    value: unknown,
  ) {
    const run = discoverRun;
    if (run === undefined) {
      discoverFailure(ws, "No Discover run is active.");
      return;
    }
    if (
      id === undefined ||
      (typeof id !== "string" && typeof id !== "number") ||
      typeof value !== "string" ||
      value.trim().length === 0
    ) {
      discoverFailure(ws, "An answer needs the question id and a non-empty value.");
      return;
    }
    if (run.question === null || String(run.question.id) !== String(id)) {
      discoverFailure(ws, "No pending Discover question with that id.");
      return;
    }
    if (run.peer === undefined || !run.peer.answer(run.question.id, value)) {
      discoverFailure(ws, "The Discover question is no longer pending.");
      return;
    }
    run.question = null;
  }

  function discoverTermRequest(context: unknown, id: unknown): { context: string; id: string } | null {
    if (typeof context !== "string" || context.length === 0) return null;
    if (typeof id !== "string" || id.length === 0) return null;
    return { context, id };
  }

  function afterDiscoverMutation(
    ws: { send(data: string): unknown },
    error: string | null,
  ) {
    if (error !== null) {
      discoverFailure(ws, error);
      return;
    }
    refreshDiscoverSnapshot();
    broadcastDiscoverState();
  }

  /**
   * A skill edit belongs to the target it was written against. Every project
   * shares the five fixed skill names, so a stale client must not have its text
   * applied through `targetRoot()` after the active target changed.
   */
  function activeSkillSaveTarget(): SkillSaveTarget {
    if (remoteTarget === undefined) return { kind: "host" };
    return { kind: "remote", owner: remoteTarget.owner, repo: remoteTarget.repo };
  }

  function saveDiscoverSkillCommand(
    ws: { send(data: string): unknown },
    name: unknown,
    text: unknown,
    target: unknown,
  ) {
    if (typeof name !== "string" || typeof text !== "string") {
      discoverFailure(ws, "Saving a Discover skill needs its name and text.");
      return;
    }
    const editedFor = parseSkillSaveTarget(target);
    if (editedFor === null) {
      discoverFailure(ws, "Saving a Discover skill needs the target it was edited for.");
      return;
    }
    if (!sameSkillSaveTarget(editedFor, activeSkillSaveTarget())) {
      discoverFailure(
        ws,
        "The skill was edited for a different Discover target, so it was not saved. " +
          "Switch back to that project and save again.",
      );
      return;
    }
    afterDiscoverMutation(ws, saveLiveSkill(targetRoot(), name, text));
  }

  function restoreDiscoverSkillCommand(ws: { send(data: string): unknown }, name: unknown) {
    if (typeof name !== "string") {
      discoverFailure(ws, "Restoring a Discover skill needs its name.");
      return;
    }
    afterDiscoverMutation(ws, restoreLiveSkill(targetRoot(), name));
  }

  /**
   * Replays the Discover state a client needs before its own command replies.
   * A host with nothing published, no run, and no recorded interruption has
   * nothing to replay, except that a harness source checkout must learn the
   * remote manual-testing gate before its empty Overview can offer it.
   */
  function replayDiscover(ws: { send(data: string): unknown }) {
    refreshDiscoverSnapshot();
    const replayable =
      discoverArtifacts !== null ||
      discoverRun !== undefined ||
      discoverInterrupted ||
      discoverReadError !== null ||
      remoteAvailable;
    if (!replayable) return;
    send(ws, { type: "discoverState", state: discoverStatePayload() });
    if (discoverReadError !== null) {
      send(ws, { type: "discoverError", message: discoverReadError });
    }
    const run = discoverRun;
    if (run === undefined) return;
    send(ws, {
      type: "discoverStarted",
      runId: run.runId,
      startedAt: run.startedAt,
      agent: run.id,
      mode: run.mode,
    });
    for (const text of run.activity) {
      send(ws, { type: "discoverActivity", agent: run.id, text });
    }
    if (run.question !== null) {
      send(ws, {
        type: "discoverQuestion",
        agent: run.id,
        id: run.question.id,
        message: run.question.message,
        options: run.question.options,
      });
    }
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
    // Running elaborations belong to the replacement, not to this process.
    goalDrafts.handoff();
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
      return (await readRecords(adrDir)).records.find((record) => record.file === file);
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
    if (refuseGoalWhileDiscovering(ws)) return;

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
      // Every client holds the same baseline, so the confirmation reaches all
      // of them; the saver's own socket is included in the broadcast.
      broadcast({ type: "goal", text });
    } catch (error) {
      send(ws, {
        type: "error",
        message: `Could not save the goal: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Reads the goal a peer is about to replace. An absent document snapshots as
   * `null`; any other read failure surfaces rather than masquerading as a
   * missing goal.
   */
  async function readGoalSnapshot(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function stopGoalRevision(
    revision: GoalRevision,
    succeeded: boolean,
    before: string | null,
  ) {
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
      // A peer that halts resolves its turn without writing, so an unchanged
      // document is the old goal, not this revision's outcome.
      if (text === before) {
        broadcast({
          type: "error",
          message: "The goal revision ended without changing the goal.",
        });
        broadcast({ type: "goalRevisionStopped", completed: false });
        return;
      }
      broadcast({ type: "goalRevisionStopped", completed: true, text });
    } catch (error) {
      broadcast({
        type: "error",
        message: `Could not read the revised goal: ${error instanceof Error ? error.message : String(error)}`,
      });
      broadcast({ type: "goalRevisionStopped", completed: false });
    }
  }

  async function stopGoalCreation(
    creation: GoalCreation,
    succeeded: boolean,
    before: string | null,
  ) {
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

    // A peer that halts resolves its turn without writing, leaving the previous
    // document in place; that text is not the goal this creation produced.
    // An empty or whitespace-only document fails first: it is never a goal.
    if (text.trim().length === 0) {
      broadcast({
        type: "error",
        message: "The goal creation ended without a non-empty goal.",
      });
      broadcast({ type: "goalCreationStopped", completed: false });
      return;
    }

    if (text === before) {
      broadcast({
        type: "error",
        message: "The goal creation ended without writing a new goal.",
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

  async function broadcastSkillsState(): Promise<void> {
    try {
      const inspection = await inspectSkills(skillsDir);
      broadcast({
        type: "skillsState",
        skills: inspection.skills,
        contradictions: inspection.contradictions,
      });
    } catch (error) {
      broadcast({
        type: "error",
        message: `Could not read the installed skills: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Deletes one prepared skill by name. Only the prepare family is removable:
   * Discover owns its own generated skills through its save/restore controls,
   * and a hand-authored skill is never touched. The name is matched against the
   * inspected directories, so a caller cannot name a path.
   */
  async function deleteSkill(target: { send(data: string): unknown }, name: unknown): Promise<void> {
    if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name) || name.length > SKILL_NAME_MAX) {
      send(target, { type: "error", message: "Choose a prepared skill to delete." });
      return;
    }
    const work = goalWorkLabel();
    if (work !== undefined) {
      send(target, { type: "error", message: `Cannot delete a skill while ${work} is active.` });
      return;
    }
    if (flow.hasActiveWork()) {
      send(target, { type: "error", message: "Cannot delete a skill while Flow Mode is active." });
      return;
    }

    let inspection: SkillsInspection;
    try {
      inspection = await inspectSkills(skillsDir);
    } catch (error) {
      send(target, {
        type: "error",
        message: `Could not read the installed skills: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const skill = inspection.managed.get(name);
    if (skill === undefined || skill.family !== "prepare") {
      send(target, { type: "error", message: `No prepared skill named "${name}" is installed.` });
      return;
    }

    try {
      await rm(join(skillsDir, name), { recursive: true, force: true });
    } catch (error) {
      send(target, {
        type: "error",
        message: `Could not delete "${name}": ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    await broadcastSkillsState();
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
    if (inspection.prepare.size === 0) {
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
    for (const name of [...inspection.prepare.keys()].sort()) {
      if (preparation.unmanagedNames.has(name)) {
        errors.push(`managed skill "${name}" collides with a skill of another family or owner.`);
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
    if (refuseGoalWhileDiscovering(ws)) return;

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
          const installed = await inspectSkills(skillsDir);
          // Preparing owns the prepare family only: unmanaged skills and the
          // Discover family stay untouched and are checked byte for byte.
          unmanagedNames = new Set([...installed.unmanaged.keys(), ...installed.discover.keys()]);
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
      const env = await peerEnvironment();
      // A reset or disposal during provider selection clears the preparation;
      // constructing a peer now would leave it unowned.
      if (skillsPreparation !== preparation) return;
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        env,
        onActivity(activity) {
          if (skillsPreparation !== preparation) return;
          recordActivity(preparation.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message, "skills");
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
      if (skillsPreparation !== preparation) {
        agent.close();
        return;
      }
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
    if (refuseGoalWhileDiscovering(ws)) return;

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
    let before: string | null;
    try {
      // Captured before the peer starts so a halt that leaves the document
      // untouched is not mistaken for the outcome.
      before = await readGoalSnapshot(creationGoalFile);
    } catch (error) {
      if (goalCreation !== creation) return;
      broadcast({
        type: "error",
        message: `Could not read the goal: ${error instanceof Error ? error.message : String(error)}`,
      });
      await stopGoalCreation(creation, false, null);
      return;
    }

    try {
      const env = await peerEnvironment();
      // A newer creation or a disposal during provider selection clears the
      // owner; no peer may be constructed for it.
      if (goalCreation !== creation) return;
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        env,
        onActivity(activity) {
          if (goalCreation !== creation) return;
          recordActivity(creation.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message, "goal-creation");
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
      if (goalCreation !== creation) {
        agent.close();
        return;
      }
      creation.agent = agent;

      await agent.run(GOAL_CREATION_PROMPT);
      if (goalCreation !== creation) return;
      await stopGoalCreation(creation, true, before);
    } catch (error) {
      if (goalCreation !== creation) return;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      await stopGoalCreation(creation, false, before);
    }
  }

  async function startGoalRevision(ws: { send(data: string): unknown }, request: unknown) {
    if (refuseFlowActive(ws)) return;
    if (refuseGoalWhileDiscovering(ws)) return;

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
    let before: string | null;
    try {
      // Captured before the peer starts so a halt that leaves the document
      // untouched is not mistaken for the outcome.
      before = await readGoalSnapshot(goalFile);
    } catch (error) {
      if (goalRevision !== revision) return;
      broadcast({
        type: "error",
        message: `Could not read the goal: ${error instanceof Error ? error.message : String(error)}`,
      });
      await stopGoalRevision(revision, false, null);
      return;
    }

    try {
      const env = await peerEnvironment();
      // A newer revision or a disposal during provider selection clears the
      // owner; no peer may be constructed for it.
      if (goalRevision !== revision) return;
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        env,
        onActivity(activity) {
          if (goalRevision !== revision) return;
          recordActivity(revision.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message, "goal-revision");
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
      if (goalRevision !== revision) {
        agent.close();
        return;
      }
      revision.agent = agent;

      await agent.run(goalRevisionPrompt(goalFile, goalRevisionRequest));
      if (goalRevision !== revision) return;
      await stopGoalRevision(revision, true, before);
    } catch (error) {
      if (goalRevision !== revision) return;
      broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      await stopGoalRevision(revision, false, before);
    }
  }

  async function runAgent(run: ActiveRun, prompt = agentPrompt(adrDir, run.file)): Promise<boolean> {
    try {
      const env = await peerEnvironment();
      // A stop or reset during provider selection ends the manual run; no peer
      // may run its prompt for an owner that is gone.
      if (!isLiveRun(run)) return false;
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        env,
        onActivity(activity) {
          if (!isLiveRun(run)) return;
          recordActivity(run.activity, activity);
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message, `run:${run.file}`);
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
      if (!isLiveRun(run)) {
        agent.close();
        return false;
      }
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
    if (refuseGoalWhileDiscovering(ws)) return;

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
      // The sequence's last broadcast happened while it still owned the run, so
      // the durable state claims an active sequence with no run. Persist the
      // cleared flags; otherwise a restart resumes work nobody asked for.
      persistState();
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

  /** Rejects with the controller's reason as soon as a tracker read is aborted. */
  function whenTrackerAborted(signal: AbortSignal): Promise<never> {
    const aborted = Promise.withResolvers<never>();
    const reject = () =>
      aborted.reject(
        signal.reason instanceof Error ? signal.reason : new TrackerAbortedError(),
      );
    if (signal.aborted) reject();
    else signal.addEventListener("abort", reject, { once: true });
    return aborted.promise;
  }

  /** Aborts every in-flight tracker read; the lifecycle then unwinds at once. */
  function abortTrackerReads() {
    for (const controller of trackerReads) controller.abort(new TrackerAbortedError());
    trackerReads.clear();
  }

  /**
   * Reads the tracker under a deadline the lifecycle owns. Stop and reset abort
   * the read, so a stalled child cannot keep the run from unwinding.
   */
  async function readEpicList(): Promise<OpenEpic[]> {
    const controller = new AbortController();
    trackerReads.add(controller);
    const timer = setTimeout(
      () => controller.abort(new TrackerTimeoutError(trackerTimeoutMs)),
      trackerTimeoutMs,
    );
    try {
      return normalizeEpics(
        await Promise.race([
          tracker(repoDir, { signal: controller.signal, timeoutMs: trackerTimeoutMs }),
          whenTrackerAborted(controller.signal),
        ]),
      );
    } finally {
      clearTimeout(timer);
      trackerReads.delete(controller);
    }
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
      const env = await peerEnvironment();
      // A stop or disposal during provider selection clears the lane; the
      // prompt must not run for a lane nothing can close.
      if (!liveLanes.has(lane)) return;
      const agent = new AcpConnection({
        command: agentCommand,
        cwd: repoDir,
        env,
        onActivity(activity) {
          recordLaneActivity(lane, activity);
        },
        onQuestion(question: AcpQuestion) {
          journal.write("question", question.message, `lane:${lane.id}`);
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
      if (!liveLanes.has(lane)) {
        agent.close();
        return;
      }
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
      // The lane has left liveLanes by the time this returns, so a finished
      // peer would otherwise outlive the lane with no reference left to close it.
      lane.agent?.close();
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
      if (!lifecycleRunning) return;
      applyEpicList(list);
    } catch (error) {
      if (!lifecycleRunning) return;
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
    const result = await runRepoGit(["rev-parse", "--verify", "main"]);
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
    if (refuseGoalWhileDiscovering(ws)) return;

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
    // The start may still be waiting on a stalled tracker; aborting the read
    // lets it unwind now instead of blocking the next Start forever.
    abortTrackerReads();
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
    if (refuseGoalWhileDiscovering(ws)) return;

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
      const installed = await inspectSkills(skillsDir);
      preparedSkills = installed.prepare.size + installed.discover.size;
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
      const list = await readEpicList();
      // A stopped or reset run owns no lanes: its late tracker answer is stale.
      if (!lifecycleRunning || request !== lifecycleStartRequest) return;
      applyEpicList(list);
      await holdWhilePaused();
      if (!lifecycleRunning) return;
      reconcileLanes();
      finished = await runLifecycle();
    } catch (error) {
      if (lifecycleRunning && request === lifecycleStartRequest) {
        broadcast({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
      const list = await readEpicList();
      if (!lifecycleRunning) return;
      applyEpicList(list);
      reconcileLanes();
      if (generationQueued) void drainGenerations();
      finished = await runLifecycle();
    } catch (error) {
      if (lifecycleRunning) {
        broadcast({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
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

    if (restoredDiscover !== undefined) {
      const interrupted = restoredDiscover;
      restoredDiscover = undefined;
      try {
        rmSync(interrupted.stagingDir, { recursive: true, force: true });
        // A resumed run uses a fresh staging root of its own.
        rmSync(dirname(interrupted.stagingDir), { recursive: true, force: true });
      } catch {
        // The staging directory may already be gone.
      }
      if (restoredResetActive) {
        // The reset owns the checkout and its interruption is reported once.
        // No crawl may take it over.
        discoverInterrupted = true;
        refreshDiscoverSnapshot();
        startupNotices.push({
          type: "discoverError",
          message: `The Discover run started at ${interrupted.startedAt} was interrupted when the server restarted, and the implementation reset was not resumed.`,
        });
        persistState();
      } else {
        journal.write("lifecycle", "discover-resume");
        void resumeDiscoverRun(interrupted);
      }
    }

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
    discoverRequest += 1;
    const discovering = discoverRun;
    discoverAllActive = false;
    if (discovering !== undefined) {
      discoverRun = undefined;
      discovering.question = null;
      discovering.peer?.close();
      try {
        removeStaging(discovering.cwd, discovering.runId);
      } catch {
        // Reset preserves `.omp`, so a leftover staging directory is harmless.
      }
      setDiscoverStatus(discovering.id, {
        state: "failed",
        startedAt: discoverStatus(discovering.id).startedAt ?? discovering.startedAt,
        endedAt: new Date().toISOString(),
        error: "Stopped by the implementation reset.",
      });
      clearRemoteCheckout();
      broadcast({
        type: "discoverStopped",
        completed: false,
        agent: discovering.id,
        mode: discovering.mode,
      });
    }

    goalCreationRequest += 1;
    abortGoalCreation();
    abortGoalRevision();
    manualStartRequest += 1;
    abortManualRun();

    lifecycleStartRequest += 1;
    lifecyclePausedForManualRun = false;
    abortTrackerReads();
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

  /**
   * Marks an in-repo state directory ignored in this checkout, so the reset
   * stages none of it and leaves `git status` clean while every byte stays.
   * The exclude file is git metadata; the worktree is never touched.
   */
  async function excludeResetState(statePath: string) {
    const gitPath = await runRepoGit(["rev-parse", "--git-path", "info/exclude"]);
    if (gitPath.code !== 0) {
      throw new Error(`could not locate the git exclude file: ${gitDetail(gitPath)}`);
    }
    const file = resolve(repoDir, gitPath.stdout.trim());
    await mkdir(dirname(file), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const pattern = `/${statePath.split(sep).join("/")}/`;
    const lines = existing.split(/\r?\n/);
    if (lines.includes(pattern)) return;
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    const comment = lines.includes(RESET_STATE_EXCLUDE_COMMENT)
      ? ""
      : `${RESET_STATE_EXCLUDE_COMMENT}\n`;
    await writeFile(file, `${existing}${separator}${comment}${pattern}\n`);
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
      const top = await runRepoGit(["rev-parse", "--show-toplevel"]);
      if (top.code !== 0 || resolve(top.stdout.trim()) !== resolve(repoDir)) {
        failImplementationReset(
          `Reset refused: REPO_DIR is not the repository top level. ${gitDetail(top)}`,
        );
        return;
      }

      const head = await runRepoGit(["rev-parse", "--verify", "HEAD"]);
      if (head.code !== 0) {
        failImplementationReset(`Reset refused: HEAD does not name a commit. ${gitDetail(head)}`);
        return;
      }

      const branch = await runRepoGit(["symbolic-ref", "--short", "HEAD"]);
      if (branch.code !== 0 || branch.stdout.trim() !== "main") {
        failImplementationReset(
          `Reset refused: the repository is not on main. ${gitDetail(branch)}`,
        );
        return;
      }

      const origin = await runRepoGit(["remote", "get-url", "origin"]);
      if (origin.code !== 0) {
        failImplementationReset(
          `Reset refused: the repository has no origin remote. ${gitDetail(origin)}`,
        );
        return;
      }

      // The dashboard's own state is not implementation. An in-repo state
      // directory survives byte-identical and is ignored locally so the reset
      // never stages it; the repository root as STATE_DIR is refused because
      // keeping it would keep the entire checkout.
      const statePath = resetStatePath(repoDir, stateDir);
      if (statePath === "") {
        failImplementationReset(
          "Reset refused: STATE_DIR is the repository root, which the reset would delete.",
        );
        return;
      }
      if (statePath !== undefined) await excludeResetState(statePath);

      // The checkout is confirmed resettable: take it over before deleting so
      // an active peer cannot race the deletion, staging, or commit.
      stopActiveWorkForReset();
      const settling = skillsPreparationSettled;
      if (settling !== undefined) await settling;

      const keep = resetKeepSet(repoDir, goalFile);
      for (const entry of await readdir(repoDir, { withFileTypes: true })) {
        if (keep.has(entry.name) || RESET_INTERNAL_NAMES.has(entry.name)) continue;
        const target = join(repoDir, entry.name);
        if (statePath !== undefined) {
          if (statePath === entry.name) continue;
          const prefix = `${entry.name}${sep}`;
          if (statePath.startsWith(prefix)) {
            await clearExceptResetState(target, statePath.slice(prefix.length).split(sep));
            continue;
          }
        }
        // A symlink is removed as a link; its target, inside or outside the
        // repository, is never followed.
        await removeResetTarget(target, entry);
      }

      const staged = await runRepoGit(["add", "-A"]);
      if (staged.code !== 0) {
        failImplementationReset(`Could not stage the reset: ${gitDetail(staged)}`);
        return;
      }
      // git add -A honours .gitignore, but an absent .gitignore would stage the
      // internal trees, and an earlier commit may already track them, including
      // the state directory. Remove them from the index; the working tree is
      // untouched.
      const excluded = await runRepoGit([
        "rm",
        "-r",
        "--cached",
        "--ignore-unmatch",
        "-q",
        "--",
        ...RESET_STAGE_EXCLUSIONS.filter((name) => name !== ".git"),
        ...(statePath === undefined ? [] : [statePath]),
      ]);
      if (excluded.code !== 0) {
        failImplementationReset(`Could not stage the reset: ${gitDetail(excluded)}`);
        return;
      }

      // With no staged change the current HEAD already describes the reset,
      // so the operation stays idempotent.
      const changed = await runRepoGit(["diff", "--cached", "--quiet"]);
      if (changed.code !== 0) {
        const committed = await runRepoGit([
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

      const committedHead = await runRepoGit(["rev-parse", "HEAD"]);
      if (committedHead.code !== 0) {
        failImplementationReset(
          `Could not read the reset commit: ${gitDetail(committedHead)}`,
        );
        return;
      }
      const commit = committedHead.stdout.trim();

      const pushed = await runRepoGit(["push", "origin", "main"], RESET_PUSH_ENV);
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
   * Files one browser report as a Gitea issue. The request is bounded before
   * parsing, and a cross-origin browser request is refused: this endpoint has
   * the side effect of creating issues, so another page must not reach it.
   * Without DEVBOARD_GITEA_URL the endpoint refuses before parsing and makes
   * no request.
   */
  async function handleFeedbackRequest(request: Request, url: URL): Promise<Response> {
    if (!feedbackEnabled) {
      return Response.json(
        {
          error:
            "Harness reporting is disabled. Set DEVBOARD_GITEA_URL and GITEA_TOKEN to file issues.",
        },
        { status: 503 },
      );
    }
    const guarded = await readMutationBody(request, url, allowedHostnames);
    if ("response" in guarded) return guarded.response;

    try {
      const submission = parseFeedbackSubmission(guarded.value);
      const filed = await fileFeedbackIssue(submission, {
        baseUrl: feedbackBaseUrl,
        repo: feedbackRepo,
        ...(options.feedback?.token === undefined || options.feedback.token.length === 0
          ? {}
          : { token: options.feedback.token }),
        timeoutMs: feedbackTimeoutMs,
        ...(feedbackFetch === undefined ? {} : { fetchImpl: feedbackFetch }),
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

  /**
   * Writes one proposed-goal draft. It never reaches `gh`, a tracker, an Ask
   * peer, or the goal document: the request only creates one Markdown file
   * under `.devboard/goal-proposals/`.
   */
  async function handleGoalProposalRequest(request: Request, url: URL): Promise<Response> {
    const guarded = await readMutationBody(request, url, allowedHostnames);
    if ("response" in guarded) return guarded.response;

    try {
      const submission = parseGoalProposalSubmission(guarded.value);
      const proposal = await writeGoalProposal(submission, { repoDir, slugger: goalSlug });
      goalDrafts.publishDrafts();
      return Response.json(proposal, { status: 201 });
    } catch (error) {
      if (error instanceof FeedbackRequestError) {
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

      if (url.pathname === "/api/goal-proposals") {
        return handleGoalProposalRequest(request, url);
      }

      if (url.pathname === "/ws") {
        const refusal = requestRefusal(request, url, allowedHostnames);
        if (refusal !== null) {
          return new Response(
            refusal === "host"
              ? "The request host is not served by this dashboard."
              : "Cross-origin WebSocket upgrades are refused.",
            { status: 403 },
          );
        }
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

        // Discover replays its published artifacts, then the run a reconnect
        // landed in, before any reply to this client's own commands. Each
        // card's prompt follows even when nothing is published, so an installed
        // host shows its read-only prompts on first load.
        replayDiscover(ws);
        discoverPrompts.replay(ws);
        // A client needs the checkout's origin and stopped state on connect,
        // whether or not a worker has ever published for it.
        issues.replay(ws);
        // A fresh view reads the tracker immediately; the sync timer alone
        // would leave the first thirty seconds showing a stopped worker's list.
        void issues.syncNow();
        agents.replay(ws);
        prompts.replay(ws);
      },

      close(ws) {
        clients.delete(ws);
        ask.disconnect(ws);
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
          command.type === "getMcpTools" ||
          command.type === "getIssues" ||
          command.type === "getIssuesRun" ||
          command.type === "getGoalDrafts" ||
          command.type === "getGoalDraft" ||
          command.type === "getAgents" ||
          command.type === "getAgent" ||
          command.type === "getAgentPrompt" ||
          command.type === "getSkills" ||
          command.type === "getDiscover" ||
          command.type === "getProviders";
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
          } else if (command.type === "getMcpTools") {
            const catalog = toolListPayload();
            send(ws, { type: "mcpTools", tools: catalog.tools });
          } else if (command.type === "getIssues") {
            issues.replay(ws);
          } else if (command.type === "getIssuesRun") {
            const detail = issues.run(command.runId);
            if (detail === undefined) {
              send(ws, { type: "error", message: "No such issues run." });
            } else {
              send(ws, { type: "issuesRun", run: detail });
            }
          } else if (
            command.type === "startIssues" ||
            command.type === "pauseIssues" ||
            command.type === "resumeIssues" ||
            command.type === "stopIssues" ||
            command.type === "checkIssues"
          ) {
            if (command.type === "startIssues") {
              const started = await issues.start();
              if (!started.ok) {
                send(ws, { type: "error", message: started.message });
              } else {
                issues.replay(ws);
              }
            } else {
              const type =
                command.type === "pauseIssues"
                  ? "pause"
                  : command.type === "resumeIssues"
                    ? "resume"
                    : command.type === "stopIssues"
                      ? "stop"
                      : "check";
              const result = issues.command({ type });
              if (!result.ok) send(ws, { type: "error", message: result.message });
            }
          } else if (command.type === "answerIssues") {
            if (
              (typeof command.id !== "string" && typeof command.id !== "number") ||
              typeof command.value !== "string"
            ) {
              send(ws, { type: "error", message: "An answer needs its question id and value." });
            } else if (typeof command.runId !== "string" || command.runId.length === 0) {
              send(ws, { type: "error", message: "An answer needs its run id." });
            } else {
              const result = issues.command({
                type: "answer",
                id: command.id,
                value: command.value,
                runId: command.runId,
              });
              if (!result.ok) send(ws, { type: "error", message: result.message });
            }
          } else if (command.type === "closeIssue") {
            if (typeof command.number !== "number") {
              send(ws, { type: "error", message: "Closing an issue needs its number." });
            } else {
              const result = await issues.closeIssue(command.number);
              if (result.ok) {
                send(ws, { type: "issuesClosed", number: command.number, ok: true });
                issues.refresh();
              } else {
                send(ws, {
                  type: "issuesClosed",
                  number: command.number,
                  ok: false,
                  message: result.message,
                });
              }
            }
          } else if (command.type === "getGoalDrafts") {
            send(ws, {
              type: "issuesDrafts",
              drafts: listGoalDrafts(repoDir),
              runs: goalDrafts.snapshot(),
            });
          } else if (command.type === "getGoalDraft") {
            try {
              send(ws, { type: "issuesDraftDetail", draft: readGoalDraft(repoDir, command.path) });
            } catch (error) {
              send(ws, {
                type: "issuesDraftError",
                path: typeof command.path === "string" ? command.path : undefined,
                message: error instanceof GoalDraftError ? error.message : String(error),
              });
            }
          } else if (command.type === "startGoalDraft") {
            const started = await goalDrafts.start(command.path);
            if (!started.ok) {
              // A stop during startup already published `stopped` and the
              // draft list; reporting an error would contradict the operator
              // and leave the Drafts view showing a failed start.
              if (started.stopped !== true) {
                send(ws, {
                  type: "issuesDraftError",
                  path: typeof command.path === "string" ? command.path : undefined,
                  message: started.message,
                });
              }
            } else {
              send(ws, { type: "issuesDraftState", draft: goalDrafts.snapshot(started.path) });
              goalDrafts.publishDrafts();
            }
          } else if (command.type === "stopGoalDraft") {
            if (typeof command.path !== "string") {
              send(ws, { type: "issuesDraftError", message: "Stopping an elaboration needs its draft path." });
            } else if (!goalDrafts.stop(command.path)) {
              send(ws, {
                type: "issuesDraftError",
                path: command.path,
                message: "That draft is not being elaborated.",
              });
            }
          } else if (command.type === "answerGoalDraft") {
            if (
              typeof command.path !== "string" ||
              (typeof command.id !== "string" && typeof command.id !== "number") ||
              typeof command.value !== "string"
            ) {
              send(ws, {
                type: "issuesDraftError",
                path: typeof command.path === "string" ? command.path : undefined,
                message: "An answer needs its draft path, question id, and value.",
              });
            } else if (!goalDrafts.answer(command.path, command.id, command.value)) {
              send(ws, {
                type: "issuesDraftError",
                path: command.path,
                message: "That question is no longer waiting for an answer.",
              });
            }
          } else if (command.type === "getAgentPrompt") {
            if (typeof command.id !== "string" || command.id.length === 0) {
              send(ws, { type: "error", message: "An agent prompt needs its agent id." });
            } else {
              prompts.replayOne(ws, command.id);
            }
          } else if (command.type === "saveAgentPrompt") {
            prompts.save(ws, typeof command.id === "string" ? command.id : "", command.text);
          } else if (command.type === "sendAgentPromptChat") {
            await prompts.chat(
              ws,
              typeof command.id === "string" ? command.id : "",
              command.message,
              command.text,
            );
          } else if (isAgentCommand(command)) {
            await agents.handle(ws, command);
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
          } else if (command.type === "deleteSkill") {
            await deleteSkill(ws, command.name);
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
            await flow.openConversation(command.id);
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
          } else if (command.type === "getDiscover") {
            refreshDiscoverSnapshot();
            sendDiscoverState(ws);
          } else if (command.type === "discoverProject") {
            await startDiscoverAll(ws);
          } else if (command.type === "discoverAgent") {
            await startDiscoverAgentCommand(ws, command.agent);
          } else if (command.type === "saveDiscoverPrompt") {
            if (!isDiscoverAgentId(command.agent)) {
              send(ws, {
                type: "discoverPromptError",
                agent: typeof command.agent === "string" ? command.agent : "",
                message: "Unknown Discover agent.",
              });
            } else {
              discoverPrompts.save(ws, command.agent, command.text);
            }
          } else if (command.type === "chatDiscoverPrompt") {
            await discoverPrompts.chat(
              ws,
              typeof command.agent === "string" ? command.agent : "",
              command.message,
              command.text,
            );
          } else if (command.type === "discoverRemote") {
            if (typeof command.url === "string") await startDiscoverRemote(ws, command.url);
          } else if (command.type === "switchDiscoverRemote") {
            if (typeof command.url === "string") switchDiscoverRemote(ws, command.url);
          } else if (command.type === "removeDiscoverRemote") {
            if (typeof command.url === "string") removeDiscoverRemote(ws, command.url);
          } else if (command.type === "clearDiscoverRemote") {
            clearDiscoverRemote(ws);
          } else if (command.type === "stopDiscover") {
            stopDiscover(ws);
          } else if (command.type === "answerDiscover") {
            answerDiscoverQuestion(ws, command.id, command.value);
          } else if (command.type === "saveDiscoverSkill") {
            saveDiscoverSkillCommand(ws, command.name, command.text, command.target);
          } else if (command.type === "restoreDiscoverSkill") {
            restoreDiscoverSkillCommand(ws, command.name);
          } else if (command.type === "confirmGlossaryTerm") {
            const term = discoverTermRequest(command.context, command.id);
            if (term === null) {
              discoverFailure(ws, "Confirming a term needs its bounded context and id.");
            } else {
              afterDiscoverMutation(
                ws,
                confirmGlossaryTerm(targetRoot(), term.context, term.id),
              );
            }
          } else if (command.type === "rejectGlossaryTerm") {
            const term = discoverTermRequest(command.context, command.id);
            if (term === null || typeof command.reason !== "string") {
              discoverFailure(ws, "Rejecting a term needs its bounded context, id, and reason.");
            } else {
              afterDiscoverMutation(
                ws,
                rejectGlossaryTerm(
                  targetRoot(),
                  term.context,
                  term.id,
                  command.reason,
                ),
              );
            }
          } else if (command.type === "ask") {
            await ask.ask(ws, command);
          } else if (command.type === "closeAsk") {
            ask.close(ws, command.conversationId);
          } else if (command.type === "getProviders") {
            await providers.refresh(false);
            send(ws, { type: "providersState", ...providers.view() });
          } else if (command.type === "refreshProviders") {
            await publishProviders(true);
          } else if (command.type === "saveProvider") {
            const saved = await providers.save({
              id: typeof command.id === "string" ? command.id : undefined,
              provider: command.provider,
              label: command.label,
              key: command.key,
            });
            if (!saved.ok) {
              send(ws, { type: "providerError", message: saved.message });
            } else {
              await publishProviders(false);
            }
          } else if (command.type === "deleteProvider") {
            if (typeof command.id !== "string") {
              send(ws, { type: "providerError", message: "A delete needs the subscription id." });
            } else {
              const removed = providers.remove(command.id);
              if (!removed.ok) send(ws, { type: "providerError", message: removed.message });
              else await publishProviders(false);
            }
          } else if (command.type === "setProviderEnabled") {
            if (typeof command.id !== "string" || typeof command.enabled !== "boolean") {
              send(ws, {
                type: "providerError",
                message: "Enabling a subscription needs its id and a boolean.",
              });
            } else {
              const changed = providers.setEnabled(command.id, command.enabled);
              if (!changed.ok) send(ws, { type: "providerError", message: changed.message });
              else await publishProviders(false);
            }
          }
        } catch (error) {
          if (error instanceof ProviderUnavailableError) {
            send(ws, { type: "providersState", ...providers.view() });
          }
          send(ws, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
  });

  const stop = server.stop.bind(server);
  const shutdown = (): void => {
    server.stop(true);
  };
  bindShutdown(shutdown);
  server.stop = (closeActiveConnections?: boolean) => {
    shutdownHooks.delete(shutdown);
    ask.dispose();
    flow.dispose();
    issues.dispose();
    goalDrafts.dispose(restarting);
    agents.dispose();
    prompts.dispose();
    discoverPrompts.dispose();
    scout.dispose();
    if (restartWhenIdleTimer !== undefined) {
      clearInterval(restartWhenIdleTimer);
      restartWhenIdleTimer = undefined;
    }
    if (providerRefreshTimer !== undefined) {
      clearInterval(providerRefreshTimer);
      providerRefreshTimer = undefined;
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
    const discovering = discoverRun;
    discoverRun = undefined;
    discoverAllActive = false;
    discovering?.peer?.close();
    if (discovering !== undefined) {
      try {
        rmSync(discovering.stagingDir, { recursive: true, force: true });
      } catch {
        // A staging directory left behind is removed by the replacement.
      }
    }
    // A stopped dashboard never leaves its checkout for the next start.
    clearRemoteCheckout();
    return stop(closeActiveConnections);
  };

  return server;
}
