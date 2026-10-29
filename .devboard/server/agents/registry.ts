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

export type AgentDetail = AgentActivityDetail | AgentCyclesDetail;

export interface AgentSnapshot {
  id: string;
  label: string;
  description: string;
  scope: AgentScope;
  lifecycle: AgentLifecycle;
  /** The worker's persisted start intent. */
  enabled: boolean;
  /** True when this dashboard may command the live worker. */
  owned: boolean;
  attached: boolean;
  cadence: {
    minutes: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
  };
  limits: AgentLimits;
  issues: AgentIssueRow[];
  /** Findings or fingerprints waiting for a successful filing. */
  pending: number;
  sync: AgentSync;
  detail: AgentDetail;
  notice: string | null;
  error: string | null;
  timer: AgentTimerGate | null;
}

/** What an adapter publishes; the registry validates and normalizes it. */
export interface AgentSnapshotInput {
  lifecycle: AgentLifecycle;
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
  pending: number;
  sync: AgentSync;
  detail: AgentDetail;
  notice?: string | null;
  error?: string | null;
  timer?: AgentTimerGate | null;
}

export interface AgentDescriptor {
  id: string;
  label: string;
  description: string;
  scope: AgentScope;
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
    enabled: input.enabled === true,
    owned: input.owned === true,
    attached: input.attached === true,
    cadence: {
      minutes: normalizeMinutes(descriptor, input.cadence?.minutes),
      lastRunAt: nullableTimestamp(input.cadence?.lastRunAt),
      nextRunAt: nullableTimestamp(input.cadence?.nextRunAt),
    },
    limits: {
      maxPerHour: input.limits.maxPerHour,
      maxPending: input.limits.maxPending,
    },
    issues: sortAgentIssues(input.issues.map(normalizeIssue)),
    pending:
      typeof input.pending === "number" && Number.isInteger(input.pending) && input.pending >= 0
        ? input.pending
        : 0,
    sync: { state: sync.state, at: sync.at, error: sync.error },
    detail: detail as AgentDetail,
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
  };
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
    tab: { id: "design", kind: "design", title: "Design System" },
  }),
  validateAgentDescriptor({
    id: "coach",
    label: "Coach",
    description:
      "Reviews repeated agent mistakes and manual work and files one improvement issue per pattern.",
    scope: "repository",
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
      default: { maxPerHour: null, maxPending: null },
    },
    commands: SHARED_COMMANDS,
    issues: SHARED_ISSUES,
    detail: { panel: "cycles", testId: "agent-detail" },
    tab: { id: "coach", kind: "coach", title: "Coach" },
  }),
]);

export const agentRegistry: AgentRegistry = defineAgentRegistry(DEFAULT_AGENT_DESCRIPTORS);
