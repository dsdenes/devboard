/**
 * The one background-agent contract. Auto Scout and Watchdog are its first two
 * instances: every shared surface reads this registry, so a third continuous
 * agent needs its engine, its adapter, and one descriptor here — never an edit
 * to the shared page, the sidebar section, or the browser command surface.
 *
 * The module is pure: the client imports it for labels and tab identity, the
 * server imports it for validation and snapshot projection.
 */

export const AGENT_LIFECYCLES = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "failed",
] as const;
export type AgentLifecycle = (typeof AGENT_LIFECYCLES)[number];

export const AGENT_SYNC_STATES = ["ok", "error", "stale"] as const;
export type AgentSyncState = (typeof AGENT_SYNC_STATES)[number];

export const AGENT_ISSUE_STATES = ["pending", "implemented", "unknown"] as const;
export type AgentIssueState = (typeof AGENT_ISSUE_STATES)[number];

export const AGENT_ISSUE_COLUMNS = [
  "title",
  "category",
  "filedAt",
  "state",
  "version",
] as const;

export type AgentScope = "repository" | "machine";

/** An empty cap is unlimited; it is never zero. */
export interface AgentLimits {
  maxPerHour: number | null;
  maxPending: number | null;
}

export interface AgentCadence {
  /** The settings field this agent persists. */
  field: "intervalMinutes";
  defaultMinutes: number;
  minMinutes: number;
  maxMinutes: number;
}

export interface AgentLimitField {
  min: number;
  max: number;
  /** An empty value removes the constraint. */
  nullable: true;
}

export interface AgentIssueRow {
  title: string;
  category: string | null;
  /** The issue's creation time, UTC ISO 8601. */
  filedAt: string;
  url: string;
  state: AgentIssueState;
  version: string | null;
}

export interface AgentCycleWindow {
  start: string | null;
  end: string | null;
}

export interface AgentCycle {
  at: string;
  window: AgentCycleWindow;
  action: string;
  findings: number;
  issues: string[];
  reason?: string;
}

export interface AgentSync {
  state: AgentSyncState;
  /** The last successful forge read, or null before one. */
  at: string | null;
  error: string | null;
}

/** One released documentation change, shared by the page and the server. */
export interface AgentDocumentationEntry {
  at: string;
  version: string;
  url: string;
  summary: string;
  files: string[];
  /** The exact unified diff of the released documents. */
  diff: string;
}

export interface AgentTimerGate {
  unit: string;
  /** The legacy unit's state; `absent` when systemd or the unit is missing. */
  state: "active" | "inactive" | "enabled" | "disabled" | "absent" | "unknown";
  /** True while the legacy timer is active or enabled. */
  blocked: boolean;
  /** Why the last state read or disable failed, or null. */
  error: string | null;
}

export interface AgentActivityDetail {
  panel: "activity";
  scanId: string | null;
  entries: string[];
}

export interface AgentCyclesDetail {
  panel: "cycles";
  cycles: AgentCycle[];
}

/** One verified release, newest first, as the Release Train page lists them. */
export interface AgentReleaseRow {
  /** When the worker verified the release, UTC ISO 8601. */
  at: string;
  version: string;
  /** Non-merge commits the released range carried; null when it is unknown. */
  commits: number | null;
  /** The forge release page, or null when the run recorded none. */
  url: string | null;
}

export type AgentDetail = AgentActivityDetail | AgentCyclesDetail;

/** One live worker process of a background agent family. */
export interface AgentWorker {
  pid: number;
  version: string | null;
  stateDir: string;
  lifecycle: AgentLifecycle;
}

export interface AgentSnapshot {
  id: string;
  label: string;
  description: string;
  scope: AgentScope;
  lifecycle: AgentLifecycle;
  /** True while the worker is paused by an operator. */
  paused: boolean;
  /** The worker's persisted start intent. */
  enabled: boolean;
  /** True when this dashboard may command the live worker. */
  owned: boolean;
  attached: boolean;
  cadence: {
    minutes: number;
    /** The descriptor's default cadence, kept for callers that compare it. */
    defaultMinutes: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
  };
  limits: AgentLimits;
  issues: AgentIssueRow[];
  /** Released documentation changes, newest first; empty for most agents. */
  documentation: AgentDocumentationEntry[];
  /** Verified releases, newest first; empty for most agents. */
  releases: AgentReleaseRow[];
  /** Findings or fingerprints waiting for a successful filing. */
  pending: number;
  sync: AgentSync;
  detail: AgentDetail;
  notice: string | null;
  error: string | null;
  timer: AgentTimerGate | null;
  /** Every live worker of this family, whatever version started it. */
  workers: AgentWorker[];
}

/** What an adapter publishes; the registry validates and normalizes it. */
export interface AgentSnapshotInput {
  lifecycle: AgentLifecycle;
  /** Optional so an adapter of an older server keeps projecting. */
  paused?: boolean;
  enabled: boolean;
  owned: boolean;
  attached: boolean;
  cadence: {
    minutes: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
  };
  limits: AgentLimits;
  issues: AgentIssueRow[];
  /** Optional so an adapter of an older server keeps projecting. */
  documentation?: AgentDocumentationEntry[];
  /** Optional so an adapter of an older server keeps projecting. */
  releases?: AgentReleaseRow[];
  pending: number;
  sync: AgentSync;
  detail: AgentDetail;
  notice?: string | null;
  error?: string | null;
  timer?: AgentTimerGate | null;
  workers?: AgentWorker[];
}

/** The prompt section's source: one harness prompt file, or a stated absence. */
export type AgentPromptDescriptor =
  | {
      kind: "file";
      /** The file under `.devboard/prompts` that the section reads. */
      file: string;
    }
  | {
      kind: "absent";
      /** Why this agent has no prompt file to show or edit. */
      message: string;
    }
  | {
      kind: "template";
      /** Why this generated prompt is shown read-only, with no editor or chat. */
      message: string;
    };

export interface AgentDescriptor {
  id: string;
  label: string;
  description: string;
  scope: AgentScope;
  /** What the shared prompt section shows for this agent. */
  prompt: AgentPromptDescriptor;
  lifecycle: readonly AgentLifecycle[];
  cadence: AgentCadence;
  limits: {
    maxPerHour: AgentLimitField;
    maxPending: AgentLimitField;
    default: AgentLimits;
  };
  /** The WebSocket commands every background agent answers. */
  commands: {
    start: "startAgent";
    stop: "stopAgent";
    setSettings: "setAgentSettings";
  };
  issues: {
    testId: "agent-issue";
    columns: typeof AGENT_ISSUE_COLUMNS;
  };
  detail: {
    panel: "activity" | "cycles";
    testId: "agent-detail";
  };
  /** Extra shared controls a family answers beyond Start and Stop. */
  controls?: {
    pause?: true;
    checkNow?: true;
  };
  /** A released documentation list rendered above the filed issues table. */
  documentation?: {
    testId: "agent-documentation";
  };
  /** A verified release history that replaces the filed-issues table. */
  releases?: {
    testId: "agent-releases";
  };
  tab: {
    id: string;
    kind: string;
    title: string;
  };
  /** A legacy systemd unit this agent's Start refuses to run beside. */
  timerGate?: {
    unit: string;
  };
}

export class AgentRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRegistryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isNullableLimit(value: unknown): value is number | null {
  return value === null || isIntegerIn(value, 1, 100);
}

export function isValidLimitValue(value: unknown): value is number | null {
  return isNullableLimit(value);
}

export function isAgentLimits(value: unknown): value is AgentLimits {
  return (
    isRecord(value) &&
    isNullableLimit(value.maxPerHour) &&
    isNullableLimit(value.maxPending)
  );
}

/** Validates one descriptor and returns it unchanged when every fact holds. */
export function validateAgentDescriptor(value: unknown): AgentDescriptor {
  if (!isRecord(value)) throw new AgentRegistryError("a descriptor must be an object");
  const descriptor = value as unknown as AgentDescriptor;
  const id = descriptor.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new AgentRegistryError("a descriptor id must be a lowercase identifier");
  }
  if (typeof descriptor.label !== "string" || descriptor.label.trim().length === 0) {
    throw new AgentRegistryError(`${id}: label is required`);
  }
  if (typeof descriptor.description !== "string" || descriptor.description.trim().length === 0) {
    throw new AgentRegistryError(`${id}: description is required`);
  }
  if (descriptor.scope !== "repository" && descriptor.scope !== "machine") {
    throw new AgentRegistryError(`${id}: scope must be repository or machine`);
  }
  const prompt = descriptor.prompt;
  if (
    !isRecord(prompt) ||
    (prompt.kind !== "file" && prompt.kind !== "absent" && prompt.kind !== "template")
  ) {
    throw new AgentRegistryError(`${id}: prompt must name its file, its absence, or a template`);
  }
  if (prompt.kind === "file") {
    if (typeof prompt.file !== "string" || !/^[a-z0-9][a-z0-9-]*\.md$/.test(prompt.file)) {
      throw new AgentRegistryError(
        `${id}: prompt file must be one prompts directory Markdown file`,
      );
    }
  } else if (typeof prompt.message !== "string" || prompt.message.trim().length === 0) {
    throw new AgentRegistryError(`${id}: prompt absence or template needs its message`);
  }
  if (
    !Array.isArray(descriptor.lifecycle) ||
    descriptor.lifecycle.length !== AGENT_LIFECYCLES.length ||
    AGENT_LIFECYCLES.some((state) => !descriptor.lifecycle.includes(state))
  ) {
    throw new AgentRegistryError(`${id}: lifecycle must be the shared vocabulary`);
  }
  const cadence = descriptor.cadence;
  if (
    !isRecord(cadence) ||
    cadence.field !== "intervalMinutes" ||
    !isIntegerIn(cadence.minMinutes, 1, 1440) ||
    !isIntegerIn(cadence.maxMinutes, 1, 1440) ||
    cadence.minMinutes > cadence.maxMinutes ||
    !isIntegerIn(cadence.defaultMinutes, cadence.minMinutes, cadence.maxMinutes)
  ) {
    throw new AgentRegistryError(`${id}: cadence must declare a valid minutes field`);
  }
  const limits = descriptor.limits;
  if (!isRecord(limits) || !isAgentLimits(limits.default)) {
    throw new AgentRegistryError(`${id}: limits must declare nullable defaults`);
  }
  for (const field of ["maxPerHour", "maxPending"] as const) {
    const schema = limits[field];
    if (
      !isRecord(schema) ||
      schema.min !== 1 ||
      schema.max !== 100 ||
      schema.nullable !== true
    ) {
      throw new AgentRegistryError(`${id}: ${field} must be a nullable 1..100 field`);
    }
  }
  const commands = descriptor.commands;
  if (
    !isRecord(commands) ||
    commands.start !== "startAgent" ||
    commands.stop !== "stopAgent" ||
    commands.setSettings !== "setAgentSettings"
  ) {
    throw new AgentRegistryError(`${id}: commands must use the shared agent command surface`);
  }
  if (
    !isRecord(descriptor.issues) ||
    descriptor.issues.testId !== "agent-issue" ||
    !Array.isArray(descriptor.issues.columns) ||
    descriptor.issues.columns.join(",") !== AGENT_ISSUE_COLUMNS.join(",")
  ) {
    throw new AgentRegistryError(`${id}: issues must project the shared table columns`);
  }
  if (
    !isRecord(descriptor.detail) ||
    (descriptor.detail.panel !== "activity" && descriptor.detail.panel !== "cycles") ||
    descriptor.detail.testId !== "agent-detail"
  ) {
    throw new AgentRegistryError(`${id}: detail must declare the shared panel`);
  }
  if (
    descriptor.controls !== undefined &&
    (!isRecord(descriptor.controls) ||
      (descriptor.controls.pause !== undefined && descriptor.controls.pause !== true) ||
      (descriptor.controls.checkNow !== undefined && descriptor.controls.checkNow !== true))
  ) {
    throw new AgentRegistryError(`${id}: controls must be the shared pause and check-now flags`);
  }
  if (
    descriptor.documentation !== undefined &&
    (!isRecord(descriptor.documentation) ||
      descriptor.documentation.testId !== "agent-documentation")
  ) {
    throw new AgentRegistryError(`${id}: documentation must declare the shared panel`);
  }
  if (
    descriptor.releases !== undefined &&
    (!isRecord(descriptor.releases) || descriptor.releases.testId !== "agent-releases")
  ) {
    throw new AgentRegistryError(`${id}: releases must declare the shared panel`);
  }
  if (
    !isRecord(descriptor.tab) ||
    descriptor.tab.id !== id ||
    descriptor.tab.kind !== id ||
    typeof descriptor.tab.title !== "string" ||
    descriptor.tab.title.length === 0
  ) {
    throw new AgentRegistryError(`${id}: tab id and kind must be the agent id`);
  }
  if (descriptor.timerGate !== undefined) {
    if (
      !isRecord(descriptor.timerGate) ||
      typeof descriptor.timerGate.unit !== "string" ||
      descriptor.timerGate.unit.length === 0
    ) {
      throw new AgentRegistryError(`${id}: timerGate must name its unit`);
    }
  }
  return descriptor;
}

export interface AgentRegistry {
  readonly descriptors: readonly AgentDescriptor[];
  get(id: string): AgentDescriptor | undefined;
  require(id: string): AgentDescriptor;
  ids(): string[];
}

/** Builds the registry, refusing duplicate ids and any invalid descriptor. */
export function defineAgentRegistry(values: readonly unknown[]): AgentRegistry {
  if (!Array.isArray(values) || values.length === 0) {
    throw new AgentRegistryError("the registry needs at least one descriptor");
  }
  const descriptors = values.map(validateAgentDescriptor);
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) {
      throw new AgentRegistryError(`duplicate background agent id: ${descriptor.id}`);
    }
    seen.add(descriptor.id);
  }
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return Object.freeze({
    descriptors: Object.freeze(descriptors),
    get(id: string): AgentDescriptor | undefined {
      return byId.get(id);
    },
    require(id: string): AgentDescriptor {
      const descriptor = byId.get(id);
      if (descriptor === undefined) {
        throw new AgentRegistryError(`unknown background agent: ${id}`);
      }
      return descriptor;
    },
    ids(): string[] {
      return descriptors.map((descriptor) => descriptor.id);
    },
  });
}

function normalizeLifecycle(descriptor: AgentDescriptor, value: unknown): AgentLifecycle {
  if (typeof value !== "string" || !descriptor.lifecycle.includes(value as AgentLifecycle)) {
    throw new AgentRegistryError(
      `${descriptor.id}: lifecycle ${String(value)} is outside the shared vocabulary`,
    );
  }
  return value as AgentLifecycle;
}

function normalizeMinutes(descriptor: AgentDescriptor, value: unknown): number {
  if (!isIntegerIn(value, descriptor.cadence.minMinutes, descriptor.cadence.maxMinutes)) {
    throw new AgentRegistryError(`${descriptor.id}: cadence is outside its bounds`);
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeIssue(row: AgentIssueRow): AgentIssueRow {
  return {
    title: row.title,
    category: typeof row.category === "string" && row.category.length > 0 ? row.category : null,
    filedAt: row.filedAt,
    url: row.url,
    state: AGENT_ISSUE_STATES.includes(row.state) ? row.state : "unknown",
    version: typeof row.version === "string" && row.version.length > 0 ? row.version : null,
  };
}

function normalizeDocumentation(value: unknown): AgentDocumentationEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is AgentDocumentationEntry =>
        isRecord(entry) &&
        typeof entry.at === "string" &&
        typeof entry.version === "string" &&
        typeof entry.url === "string" &&
        typeof entry.summary === "string" &&
        Array.isArray(entry.files) &&
        entry.files.every((file) => typeof file === "string") &&
        typeof entry.diff === "string",
    )
    .slice(0, 20);
}

/** The release history a page lists, newest first and bounded. */
function normalizeReleases(value: unknown): AgentReleaseRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AgentReleaseRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.at !== "string" || typeof entry.version !== "string") {
      continue;
    }
    if (!(entry.url === null || typeof entry.url === "string")) continue;
    if (!(entry.commits === null || isIntegerIn(entry.commits, 0, Number.MAX_SAFE_INTEGER))) {
      continue;
    }
    rows.push({
      at: entry.at,
      version: entry.version,
      url: entry.url,
      commits: entry.commits as number | null,
    });
  }
  return rows.slice(0, 20);
}

/** The one sort every agent's filed-issue table uses. */
export function sortAgentIssues(rows: readonly AgentIssueRow[]): AgentIssueRow[] {
  const instant = (value: string): number => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...rows].sort((left, right) => {
    const leftAt = instant(left.filedAt);
    const rightAt = instant(right.filedAt);
    if (leftAt !== rightAt) return rightAt - leftAt;
    return left.url.localeCompare(right.url);
  });
}

/**
 * Validates one adapter snapshot and adds the descriptor's identity. The shared
 * bridge calls this for every agent, so a third descriptor is accepted exactly
 * like the first two.
 */
export function projectAgentSnapshot(
  descriptor: AgentDescriptor,
  input: AgentSnapshotInput,
): AgentSnapshot {
  if (!isRecord(input)) throw new AgentRegistryError(`${descriptor.id}: snapshot is not an object`);
  if (!isAgentLimits(input.limits)) {
    throw new AgentRegistryError(`${descriptor.id}: limits must be empty or 1..100`);
  }
  if (!Array.isArray(input.issues)) {
    throw new AgentRegistryError(`${descriptor.id}: issues must be an array`);
  }
  const sync = input.sync;
  if (
    !isRecord(sync) ||
    !AGENT_SYNC_STATES.includes(sync.state as AgentSyncState) ||
    !(sync.at === null || typeof sync.at === "string") ||
    !(sync.error === null || typeof sync.error === "string")
  ) {
    throw new AgentRegistryError(`${descriptor.id}: sync is outside the shared shape`);
  }
  const detail = input.detail;
  if (!isRecord(detail) || detail.panel !== descriptor.detail.panel) {
    throw new AgentRegistryError(`${descriptor.id}: detail panel does not match the descriptor`);
  }
  if (detail.panel === "activity" && !Array.isArray(detail.entries)) {
    throw new AgentRegistryError(`${descriptor.id}: activity detail needs entries`);
  }
  if (detail.panel === "cycles" && !Array.isArray(detail.cycles)) {
    throw new AgentRegistryError(`${descriptor.id}: cycle detail needs cycles`);
  }
  return {
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description,
    scope: descriptor.scope,
    lifecycle: normalizeLifecycle(descriptor, input.lifecycle),
    paused: input.paused === true,
    enabled: input.enabled === true,
    owned: input.owned === true,
    attached: input.attached === true,
    cadence: {
      minutes: normalizeMinutes(descriptor, input.cadence?.minutes),
      defaultMinutes: descriptor.cadence.defaultMinutes,
      lastRunAt: nullableTimestamp(input.cadence?.lastRunAt),
      nextRunAt: nullableTimestamp(input.cadence?.nextRunAt),
    },
    limits: {
      maxPerHour: input.limits.maxPerHour,
      maxPending: input.limits.maxPending,
    },
    issues: sortAgentIssues(input.issues.map(normalizeIssue)),
    documentation: normalizeDocumentation(input.documentation),
    pending:
      typeof input.pending === "number" && Number.isInteger(input.pending) && input.pending >= 0
        ? input.pending
        : 0,
    sync: { state: sync.state, at: sync.at, error: sync.error },
    detail: detail as AgentDetail,
    releases: normalizeReleases(input.releases),
    notice: nullableTimestamp(input.notice),
    error: nullableTimestamp(input.error),
    timer:
      input.timer === undefined || input.timer === null
        ? null
        : {
            unit: input.timer.unit,
            state: input.timer.state,
            blocked: input.timer.blocked === true,
            error: nullableTimestamp(input.timer.error),
          },
    workers: normalizeWorkers(descriptor, input.workers),
  };
}

/** Normalizes the live-worker list every adapter may publish. */
export function normalizeWorkers(
  descriptor: AgentDescriptor,
  value: unknown,
): AgentWorker[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AgentRegistryError(`${descriptor.id}: workers must be an array`);
  }
  return value.map((entry) => {
    if (!isRecord(entry) || !isIntegerIn(entry.pid, 1, Number.MAX_SAFE_INTEGER)) {
      throw new AgentRegistryError(`${descriptor.id}: a worker needs a pid`);
    }
    if (!(entry.version === null || typeof entry.version === "string")) {
      throw new AgentRegistryError(`${descriptor.id}: a worker version must be a string or null`);
    }
    if (typeof entry.stateDir !== "string") {
      throw new AgentRegistryError(`${descriptor.id}: a worker needs its state directory`);
    }
    const lifecycle = normalizeLifecycle(descriptor, entry.lifecycle);
    return { pid: entry.pid, version: entry.version, stateDir: entry.stateDir, lifecycle };
  });
}

const SHARED_COMMANDS = {
  start: "startAgent",
  stop: "stopAgent",
  setSettings: "setAgentSettings",
} as const;

const SHARED_ISSUES = {
  testId: "agent-issue",
  columns: AGENT_ISSUE_COLUMNS,
} as const;

export const DEFAULT_AGENT_DESCRIPTORS: readonly AgentDescriptor[] = Object.freeze([
  validateAgentDescriptor({
    id: "scout",
    label: "Auto Scout",
    description: "Scans the repository and files significant findings as issues.",
    scope: "repository",
    prompt: {
      kind: "file",
      file: "scout-recommendations.md",
    },
    lifecycle: AGENT_LIFECYCLES,
    cadence: {
      field: "intervalMinutes",
      defaultMinutes: 1,
      minMinutes: 1,
      maxMinutes: 1440,
    },
    limits: {
      maxPerHour: { min: 1, max: 100, nullable: true },
      maxPending: { min: 1, max: 100, nullable: true },
      default: { maxPerHour: 10, maxPending: 5 },
    },
    commands: SHARED_COMMANDS,
    issues: SHARED_ISSUES,
    detail: { panel: "activity", testId: "agent-detail" },
    tab: { id: "scout", kind: "scout", title: "Auto Scout" },
  }),
  validateAgentDescriptor({
    id: "watchdog",
    label: "Watchdog",
    description: "Watches dashboard evidence and files significant machine findings as issues.",
    scope: "machine",
    prompt: {
      kind: "absent",
      message: "Watchdog runs no agent, so it has no prompt to show or edit.",
    },
    lifecycle: AGENT_LIFECYCLES,
    cadence: {
      field: "intervalMinutes",
      defaultMinutes: 10,
      minMinutes: 1,
      maxMinutes: 1440,
    },
    limits: {
      maxPerHour: { min: 1, max: 100, nullable: true },
      maxPending: { min: 1, max: 100, nullable: true },
      default: { maxPerHour: null, maxPending: null },
    },
    commands: SHARED_COMMANDS,
    issues: SHARED_ISSUES,
    detail: { panel: "cycles", testId: "agent-detail" },
    tab: { id: "watchdog", kind: "watchdog", title: "Watchdog" },
    timerGate: { unit: "devboard-watchdog.timer" },
  }),
  validateAgentDescriptor({
    id: "design",
    label: "Design System",
    description:
      "Audits the interface against its documented design system and files capped issues for " +
      "every divergence.",
    scope: "repository",
    prompt: {
      kind: "file",
      file: "design-system.md",
    },
    lifecycle: AGENT_LIFECYCLES,
    cadence: {
      field: "intervalMinutes",
      defaultMinutes: 60,
      minMinutes: 1,
      maxMinutes: 1440,
    },
    limits: {
      maxPerHour: { min: 1, max: 100, nullable: true },
      maxPending: { min: 1, max: 100, nullable: true },
      default: { maxPerHour: 10, maxPending: 5 },
    },
    commands: SHARED_COMMANDS,
    issues: SHARED_ISSUES,
    detail: { panel: "activity", testId: "agent-detail" },
    documentation: { testId: "agent-documentation" },
    tab: { id: "design", kind: "design", title: "Design System" },
  }),
  validateAgentDescriptor({
    id: "dead-code",
    label: "Dead Code",
    description:
      "Proves dead code from a seeded entry point and files capped removal issues for every " +
      "finding.",
    scope: "repository",
    prompt: {
      kind: "file",
      file: "dead-code-removal.md",
    },
    lifecycle: AGENT_LIFECYCLES,
    cadence: {
      field: "intervalMinutes",
      defaultMinutes: 60,
      minMinutes: 1,
      maxMinutes: 1440,
    },
    limits: {
      maxPerHour: { min: 1, max: 100, nullable: true },
      maxPending: { min: 1, max: 100, nullable: true },
      default: { maxPerHour: 10, maxPending: 5 },
    },
    commands: SHARED_COMMANDS,
    issues: SHARED_ISSUES,
    detail: { panel: "activity", testId: "agent-detail" },
    tab: { id: "dead-code", kind: "dead-code", title: "Dead Code" },
  }),
  validateAgentDescriptor({
    id: "coach",
    label: "Coach",
    description:
      "Reviews repeated agent mistakes and manual work and files one improvement issue per pattern.",
    scope: "repository",
    prompt: {
      kind: "template",
      message:
        "Coach synthesizes its prompt from each cycle's evidence, so this generated template " +
        "is read-only.",
    },
    lifecycle: AGENT_LIFECYCLES,
    cadence: {
      field: "intervalMinutes",
      defaultMinutes: 60,
      minMinutes: 1,
      maxMinutes: 1440,
    },
    limits: {
      maxPerHour: { min: 1, max: 100, nullable: true },
      maxPending: { min: 1, max: 100, nullable: true },
      default: { maxPerHour: 10, maxPending: 20 },
    },
    commands: SHARED_COMMANDS,
    issues: SHARED_ISSUES,
    detail: { panel: "cycles", testId: "agent-detail" },
    tab: { id: "coach", kind: "coach", title: "Coach" },
  }),
  validateAgentDescriptor({
    id: "api-standards",
    label: "API Standards",
    description:
      "Audits the dashboard HTTP API against the project REST skill and files capped " +
      "conformance issues for every MUST or SHOULD violation.",
    scope: "repository",
    prompt: {
      kind: "file",
      file: "api-standards.md",
    },
    lifecycle: AGENT_LIFECYCLES,
    cadence: {
      field: "intervalMinutes",
      defaultMinutes: 60,
      minMinutes: 1,
      maxMinutes: 1440,
    },
    limits: {
      maxPerHour: { min: 1, max: 100, nullable: true },
      maxPending: { min: 1, max: 100, nullable: true },
      default: { maxPerHour: 10, maxPending: 5 },
    },
    commands: SHARED_COMMANDS,
    issues: SHARED_ISSUES,
    detail: { panel: "activity", testId: "agent-detail" },
    tab: { id: "api-standards", kind: "api-standards", title: "API Standards" },
  }),
  validateAgentDescriptor({
    id: "release-train",
    label: "Release Train",
    description:
      "Releases every unreleased commit on main on its scheduled cadence, one version per " +
      "collected range.",
    scope: "repository",
    prompt: {
      kind: "file",
      file: "release-train.md",
    },
    lifecycle: AGENT_LIFECYCLES,
    cadence: {
      field: "intervalMinutes",
      defaultMinutes: 10,
      minMinutes: 1,
      maxMinutes: 1440,
    },
    limits: {
      maxPerHour: { min: 1, max: 100, nullable: true },
      maxPending: { min: 1, max: 100, nullable: true },
      default: { maxPerHour: null, maxPending: null },
    },
    commands: SHARED_COMMANDS,
    issues: SHARED_ISSUES,
    detail: { panel: "activity", testId: "agent-detail" },
    releases: { testId: "agent-releases" },
    controls: { pause: true, checkNow: true },
    tab: { id: "release-train", kind: "release-train", title: "Release Train" },
  }),
]);

export const agentRegistry: AgentRegistry = defineAgentRegistry(DEFAULT_AGENT_DESCRIPTORS);

// ------------------------------------------------------------ discover agents

/**
 * The seven independently triggerable Discover agents. Unlike a background
 * agent, each one is a one-shot ACP turn: it owns exactly one prompt file, one
 * slash command, and one slice of the published Discover artifacts. The client
 * imports this table for labels and order; the server imports it for validation
 * and ownership.
 */

export const DISCOVER_AGENT_IDS = [
  "sheet",
  "discover-contribution",
  "discover-testing-strategy",
  "discover-naming-conventions",
  "discover-coding-conventions",
  "discover-architecture-boundaries",
  "discover-glossary",
] as const;

export type DiscoverAgentId = (typeof DISCOVER_AGENT_IDS)[number];

export interface DiscoverAgentDescriptor {
  id: DiscoverAgentId;
  label: string;
  /** The slash command the peer receives, followed by its staging directory. */
  command: string;
  /** The one file under `.devboard/prompts` this agent reads. */
  promptFile: string;
  /** The one Discover skill this agent owns; null for the project sheet. */
  skill: string | null;
  /** True when the agent also owns the glossary artifacts and sidecars. */
  glossary: boolean;
}

/** Sidebar order, matching the acceptance list. */
export const DISCOVER_AGENTS: readonly DiscoverAgentDescriptor[] = Object.freeze([
  {
    id: "sheet",
    label: "Data Sheet",
    command: "/discover-sheet",
    promptFile: "discover-sheet.md",
    skill: null,
    glossary: false,
  },
  {
    id: "discover-contribution",
    label: "Contribution Agent",
    command: "/discover-contribution",
    promptFile: "discover-contribution.md",
    skill: "discover-contribution",
    glossary: false,
  },
  {
    id: "discover-testing-strategy",
    label: "Testing Strategy",
    command: "/discover-testing-strategy",
    promptFile: "discover-testing-strategy.md",
    skill: "discover-testing-strategy",
    glossary: false,
  },
  {
    id: "discover-naming-conventions",
    label: "Naming Conventions",
    command: "/discover-naming-conventions",
    promptFile: "discover-naming-conventions.md",
    skill: "discover-naming-conventions",
    glossary: false,
  },
  {
    id: "discover-coding-conventions",
    label: "Coding Conventions",
    command: "/discover-coding-conventions",
    promptFile: "discover-coding-conventions.md",
    skill: "discover-coding-conventions",
    glossary: false,
  },
  {
    id: "discover-architecture-boundaries",
    label: "Architecture & Boundaries",
    command: "/discover-architecture-boundaries",
    promptFile: "discover-architecture-boundaries.md",
    skill: "discover-architecture-boundaries",
    glossary: false,
  },
  {
    id: "discover-glossary",
    label: "Glossary Agent",
    command: "/discover-glossary",
    promptFile: "discover-glossary.md",
    skill: "discover-glossary",
    glossary: true,
  },
]);

/** The fixed Run all order: the sheet and glossary ground the skills that follow. */
export const DISCOVER_RUN_ORDER: readonly DiscoverAgentId[] = Object.freeze([
  "sheet",
  "discover-glossary",
  "discover-testing-strategy",
  "discover-naming-conventions",
  "discover-coding-conventions",
  "discover-architecture-boundaries",
  "discover-contribution",
]);

const DISCOVER_AGENTS_BY_ID = new Map<string, DiscoverAgentDescriptor>(
  DISCOVER_AGENTS.map((descriptor) => [descriptor.id, descriptor] as const),
);

/** True for one of the seven ids; never for another string. */
export function isDiscoverAgentId(value: unknown): value is DiscoverAgentId {
  return typeof value === "string" && DISCOVER_AGENTS_BY_ID.has(value);
}

export function discoverAgent(id: string): DiscoverAgentDescriptor | undefined {
  return DISCOVER_AGENTS_BY_ID.get(id);
}
