export type Mode = "goal" | "issues" | "flow" | "discover" | "devboard";
export type Theme = "dark" | "light";

export interface AdrRecord {
  file: string;
  title: string;
  status: string;
  pending: boolean;
  summary: string;
}

export interface VersionState {
  running: string | null;
  installed: string | null;
  latest: string | null;
  stale: boolean;
  /** A replacement that could not start; the fallback control retries it. */
  replacement?: {
    running: string | null;
    installed: string | null;
    error: string;
  } | null;
}

export type IssuesLifecycle = "stopped" | "idle" | "running" | "pausing" | "paused" | "failed";
export type IssuesRunStatus = "running" | "succeeded" | "failed" | "stopped";

export interface IssuesIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: string[];
}

export interface QueuedIssue extends IssuesIssue {
  handled: boolean;
  /** The run that last handled this issue, or null. */
  runId: string | null;
  /** The run of the agent currently working this issue, or null. */
  agentRunId: string | null;
}

export interface IssuesPollState {
  intervalMs: number;
  lastPollAt: string | null;
  nextPollAt: string | null;
  etag: string | null;
  notModified: boolean;
  rateLimitedUntil: string | null;
  error: string | null;
}

export interface IssuesWorkerRecord {
  pid: number;
  startedAt: string;
  stateDir: string;
  harnessVersion: string | null;
  argv: string[];
}

export interface IssuesRunSummary {
  runId: string;
  status: IssuesRunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  issueNumbers: number[];
  activity: number;
  firstStderrLine: string | null;
}

export interface IssuesRunDetail extends IssuesRunSummary {
  repo: string;
  argv: string[];
  cwd: string;
  issues: IssuesIssue[];
  workerPid: number;
  harnessVersion: string | null;
  activityLines: string[];
}

/** The worker's published snapshot, as the dashboard is allowed to see it. */
export interface IssuesSnapshot {
  present: boolean;
  repo: string | null;
  root: string;
  lifecycle: IssuesLifecycle;
  enabled: boolean;
  paused: boolean;
  attached: boolean;
  worker: IssuesWorkerRecord | null;
  poll: IssuesPollState | null;
  queue: QueuedIssue[];
  runs: IssuesRunSummary[];
  agents: IssuesAgent[];
  cooldowns: Record<string, string>;
  lastError: string | null;
  lastExitCode: number | null;
  finishedAt: string | null;
  notice: string | null;
  updatedAt: string | null;
  /** Every live issues worker, whatever version started it. */
  workers?: Array<{
    pid: number;
    version: string | null;
    stateDir: string;
    lifecycle: IssuesLifecycle;
  }>;
  /**
   * The dashboard's own tracker reads. Optional so a client paired with an
   * older server still validates its snapshot.
   */
  sync?: IssuesSyncState;
}

/** One dashboard-owned tracker read cycle, independent of the worker. */
export interface IssuesSyncState {
  intervalMs: number;
  lastSyncAt: string | null;
  error: string | null;
}

export interface IssuesActivityEntry {
  text: string;
  append: boolean;
}

export interface RunQuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
}

export interface RunQuestion {
  id: number | string;
  message: string;
  options: RunQuestionOption[];
}

/** One running issue's own concurrent peer. */
export interface IssuesAgent {
  runId: string;
  issueNumber: number;
  startedAt: string;
  question: RunQuestion | null;
  acp: { pid: number; argv: string[]; cwd: string } | null;
}

export interface GoalDraftSummary {
  path: string;
  name: string;
  heading: string;
}

export interface GoalDraftDetail extends GoalDraftSummary {
  text: string;
}

export type GoalDraftStatus = "idle" | "running" | "succeeded" | "failed" | "stopped";

export interface GoalDraftRun {
  status: GoalDraftStatus;
  path: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  activity: string[];
  question: RunQuestion | null;
}

export type {
  AgentActivityDetail,
  AgentCadence,
  AgentCycle,
  AgentCycleWindow,
  AgentCyclesDetail,
  AgentDescriptor,
  AgentDetail,
  AgentDocumentationEntry,
  AgentIssueRow,
  AgentIssueState,
  AgentLifecycle,
  AgentLimits,
  AgentScope,
  AgentSnapshot,
  AgentSync,
  AgentSyncState,
  AgentTimerGate,
} from "../../server/agents/registry";

export type { AgentPromptState } from "../../server/agents/prompt";

export interface SkillSummary {
  name: string;
  description: string;
  /** Which preparation owns the skill; an older server sends neither field. */
  family?: "prepare" | "discover";
  state?: "generated" | "edited" | "missing";
  /** The SKILL.md text; absent from an older server. */
  content?: string;
}

/** The issue reporter's overlay phase, shared between the shell and the overlay. */
export type FeedbackPhase = "idle" | "picking" | "composing" | "sending" | "failed";

/** The UI issue action an armed selection mode files. */
export type FeedbackAction = "report" | "remove" | "redesign";

export interface SkillContradiction {
  skills: [string, string];
  directives: [string, string];
}

export type RunAction = "resolving" | "implementing" | "generating";
export type LifecycleStage = "goal" | "epic" | "adr" | "implementation" | "finished";

export interface LifecycleWork {
  kind: "adr" | "epic";
  id: string;
  url?: string;
}

export interface LifecycleState {
  stage: LifecycleStage;
  pass: number;
  work: LifecycleWork | null;
  paused: boolean;
}

export type LaneKind = "generation" | "implementation" | "adr";
export type LaneStatus = "running" | "paused" | "closed" | "failed" | "retrying" | "parked";

export interface LaneEpic {
  number: number;
  title: string;
  url: string;
}

export interface Lane {
  id: string;
  kind: LaneKind;
  epic: LaneEpic | null;
  record: { file: string; title: string } | null;
  attempt: number;
  status: LaneStatus;
  activity: string[];
  question: RunQuestion | null;
}

export type FlowStatus = "none" | "idle" | "running" | "stopped" | "merged";
export type FlowCategory =
  | "contract"
  | "entity"
  | "naming"
  | "data"
  | "dependency"
  | "irreversible"
  | "structure";
export type AnswerTarget = "goal" | "implementation" | "conversation";

export interface FlowFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  diff: string;
  /** Why an untracked file's body was omitted; absent when `diff` holds it. */
  omitted?: "binary" | "large" | "unreadable";
}

export interface FlowWidget {
  id: string;
  category: FlowCategory;
  concept: string;
  summary: string;
  rationale: string;
  files: string[];
  accepted: boolean;
}

export interface FlowSteeringNote {
  id: string;
  timestamp: string;
  source: string;
  text: string;
  status: "new" | "read";
}

export interface FlowCheckpoint {
  id: string;
  timestamp: string;
  summary: string;
  files: number;
  commit: string;
  verification: "passed" | "failed" | "not-run";
}

export interface FlowVerification {
  command: string;
  status: "passed" | "failed" | "not-run";
  timestamp: string;
  output: string;
}

export interface FlowBlocker {
  id: string;
  timestamp: string;
  text: string;
  dismissed: boolean;
}

export interface FlowPr {
  forge: "github" | "gitlab";
  number: number;
  url: string;
  state: "none" | "draft" | "live" | "merged" | "closed" | "error";
}

export interface FlowConversationMessage {
  role: "developer" | "agent";
  text: string;
}

export interface FlowConversation {
  widgetId: string;
  messages: FlowConversationMessage[];
  activity: string[];
  question: RunQuestion | null;
}

export interface FlowGoalCreation {
  activity: string[];
  question: RunQuestion | null;
}

export interface FlowHistoryEntry {
  sessionId: string;
  goal: string;
  pr: FlowPr | null;
}

export interface FlowSnapshot {
  sessionId: string | null;
  status: FlowStatus;
  goal: string;
  decisions: string;
  worktree: string | null;
  branch: string | null;
  baseRevision: string | null;
  files: FlowFile[];
  widgets: FlowWidget[];
  steering: FlowSteeringNote[];
  checkpoints: FlowCheckpoint[];
  verification: FlowVerification | null;
  blockers: FlowBlocker[];
  pr: FlowPr | null;
  prError: string | null;
  leftover: string | null;
  question: RunQuestion | null;
  goalCreation: FlowGoalCreation | null;
  conversation: FlowConversation | null;
  activity: string[];
  notice: string | null;
  history: FlowHistoryEntry[];
}

export type Confidence = "observed" | "declared" | "inferred" | "unknown";

export interface Leaf {
  value: unknown;
  evidence: string[];
  confidence: Confidence;
  reason?: string;
}

export interface Labelled {
  language: string;
  text: string;
}

export interface Concept {
  id: string;
  prefLabels: Labelled[];
  altLabels?: Labelled[];
  definitions?: Labelled[];
  status: string;
  origin: string;
  kind: string;
  grounding?: unknown[];
}

export interface Glossary {
  boundedContext: string;
  titles: Labelled[];
  concepts: Concept[];
}

/** How often one concept is used across the host's documentation and source. */
export interface ConceptUsage {
  count: number;
  files: number;
  examples: string[];
}

/** Usage keyed by bounded context, then concept id. */
export type GlossaryUsage = Record<string, Record<string, ConceptUsage>>;

/** The crawl's own judgment of how much a concept matters to the project. */
export interface ConceptSignificance {
  score: number;
  reason: string;
}

/** Significance keyed by bounded context, then concept id. */
export type GlossarySignificance = Record<string, Record<string, ConceptSignificance>>;

export interface DiscoverSkill {
  name: string;
  state: "generated" | "edited" | "missing";
  baseline: string | null;
  live: string | null;
}

export interface Freshness {
  project: string;
  commit: string;
  dirty: boolean;
  discoveredAt: string;
}

/** One fact the Contribution page renders as a value or an explicit empty state. */
export interface ContributionFact {
  key: string;
  label: string;
  value?: unknown;
  evidence: string[];
  confidence: "observed" | "declared" | "inferred" | "unknown";
  reason?: string;
}

export interface ContributionSection {
  id: string;
  label: string;
  facts: ContributionFact[];
}

export interface ContributionSample {
  number: number;
  title: string;
  body: string;
}

/** The published contribution sheet: nine ordered sections and its sample. */
export interface Contribution {
  schemaVersion: number;
  freshness: Freshness;
  sections: ContributionSection[];
  sample: ContributionSample[];
}

/** One remote project whose published bytes the dashboard retains. */
export interface RetainedRemoteProject {
  url: string;
  owner: string;
  repo: string;
  /** ISO time the discovery that produced the retained bytes completed. */
  completedAt: string;
}

/** The target Discover reads and writes: this host, or a retained remote project. */
export type DiscoverTarget =
  | { kind: "host" }
  | {
      kind: "remote";
      url: string;
      owner: string;
      repo: string;
      /** True while the active project's transient clone exists for a run. */
      checkout: boolean;
    };

/** One discovery card's prompt, as the server read it. */
export interface DiscoverAgentPrompt {
  agent: string;
  text: string | null;
  error: string | null;
}

/** One discovery card's run state and its own prompt file. */
export interface DiscoverAgentState {
  id: string;
  label: string;
  command: string;
  state: "idle" | "running" | "succeeded" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  prompt: DiscoverAgentPrompt | null;
}

export interface DiscoverStatePayload {
  active: boolean;
  runId: string | null;
  startedAt: string | null;
  /** The agent the active run belongs to, or null when nothing runs. */
  activeAgent: string | null;
  /** True while the seven agents run as one Run all sequence. */
  runningAll: boolean;
  /** The seven discovery cards in sidebar order. */
  agents: DiscoverAgentState[];
  interrupted: boolean;
  stale: boolean;
  warnings: string[];
  busy: string | null;
  error: string | null;
  /** True only when the dashboard serves a harness source checkout. */
  remoteAvailable: boolean;
  /** Retained remote projects, newest completed discovery first. */
  retained: RetainedRemoteProject[];
  /** `owner/name` of the repository being read, or null outside a GitHub remote. */
  repository: string | null;
  target: DiscoverTarget;
  cloning: { url: string } | null;
  manifest: unknown;
  freshness: Freshness | null;
  sheet: Record<string, unknown> | null;
  /** The manifest's invocations for the commands the sheet recorded. */
  commandAliases?: Array<{ command: string; alias: string }>;
  dependencyRepositories: Record<string, string>;
  /** Null until the contribution agent publishes, or when its file is unreadable. */
  contribution: Contribution | null;
  glossaries: Glossary[];
  glossaryUsage: GlossaryUsage;
  glossarySignificance: GlossarySignificance;
  decisions: unknown[];
  skills: DiscoverSkill[];
}

export type DiscoverTabId =
  | "overview"
  | "glossary"
  | "contribution"
  | "testing-strategy"
  | "naming-conventions"
  | "coding-conventions"
  | "architecture-boundaries"
  | "glossary-skill"
  | "contribution-skill";

export interface DiscoverTab {
  id: DiscoverTabId;
  label: string;
  skill: string | null;
}

/** One visible turn of the element-scoped Ask conversation. */
export interface AskTurn {
  role: "developer" | "agent";
  text: string;
}

/** The captured element an Ask question travels with. */
export interface AskContext {
  route: string;
  url: string;
  selector: string;
  viewport: string;
  captured_at: string;
  visible_text: string;
  dom_excerpt: string;
}

/** The two providers the harness can authenticate. */
export type ProviderId = "opencode-go" | "openrouter";
export type ProviderKeyStatus = "ok" | "near-limit" | "exhausted" | "invalid" | "unknown";

export interface ProviderWindow {
  key: string;
  label: string;
  percentUsed: number | null;
  remainingFraction: number;
  resetsAt: string | null;
}

export interface ProviderSubscription {
  id: string;
  provider: ProviderId;
  providerName: string;
  label: string;
  enabled: boolean;
  maskedKey: string;
  status: ProviderKeyStatus;
  windows: ProviderWindow[];
  remainingFraction: number | null;
  lastCheckedAt: string | null;
  error: string | null;
}

export interface ProviderSelection {
  provider: ProviderId;
  providerName: string;
  label: string;
  model: string;
  remainingFraction: number | null;
}

export interface ProvidersState {
  subscriptions: ProviderSubscription[];
  selection: ProviderSelection | null;
  refusal: string | null;
  rule: string;
}
