export type Mode = "goal" | "flow" | "discover";
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
}

export type OrchestratorStatus = "idle" | "running" | "failed";

/** The orchestrator's published summary; `present` is false when no run state exists. */
export type OrchestratorState =
  | { present: false }
  | {
      present: true;
      repo: string;
      status: OrchestratorStatus;
      open: number;
      startedAt: string | null;
      finishedAt: string | null;
      lastExitCode: number | null;
      lastError: string | null;
      nextAttemptAt: string | null;
      updatedAt: string;
    };

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

export interface SkillSummary {
  name: string;
  description: string;
}

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

/** The target Discover reads and writes: this host, or a manual-testing clone. */
export type DiscoverTarget =
  | { kind: "host" }
  | {
      kind: "remote";
      url: string;
      owner: string;
      repo: string;
      /** Repo-root-relative clone directory, never absolute. */
      cloneDir: string;
    };

export interface DiscoverStatePayload {
  active: boolean;
  runId: string | null;
  startedAt: string | null;
  interrupted: boolean;
  stale: boolean;
  warnings: string[];
  busy: string | null;
  error: string | null;
  /** True only when the dashboard serves a harness source checkout. */
  remoteAvailable: boolean;
  target: DiscoverTarget;
  cloning: { url: string } | null;
  manifest: unknown;
  freshness: Freshness | null;
  sheet: Record<string, unknown> | null;
  dependencyRepositories: Record<string, string>;
  glossaries: Glossary[];
  glossaryUsage: GlossaryUsage;
  glossarySignificance: GlossarySignificance;
  decisions: unknown[];
  skills: DiscoverSkill[];
}

export type DiscoverTabId =
  | "overview"
  | "glossary"
  | "testing-strategy"
  | "naming-conventions"
  | "coding-conventions"
  | "architecture-boundaries"
  | "glossary-skill";

export interface DiscoverTab {
  id: DiscoverTabId;
  label: string;
  skill: string | null;
}
