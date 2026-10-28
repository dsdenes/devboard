import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import type {
  ScoutActivityEntry,
  ScoutIssueRow,
  ScoutLimits,
  ScoutSnapshot,
  ScoutSync,
} from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSnapshot(value: Record<string, unknown>): boolean {
  return (
    value.type === "scoutState" &&
    typeof value.root === "string" &&
    typeof value.lifecycle === "string" &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.issues) &&
    isObject(value.sync) &&
    isObject(value.limits)
  );
}

function isEntry(value: unknown): value is ScoutActivityEntry {
  return isObject(value) && typeof value.text === "string" && typeof value.append === "boolean";
}

function applyActivity(lines: string[], entries: ScoutActivityEntry[], replay: boolean): string[] {
  const next = replay ? [] : [...lines];
  for (const entry of entries) {
    if (entry.append && next.length > 0) next[next.length - 1] += entry.text;
    else next.push(entry.text);
  }
  return next;
}

const DEFAULT_LIMITS: ScoutLimits = { maxPerHour: 10, maxPending: 5 };
const EMPTY_SYNC: ScoutSync = { state: "stale", at: null, error: null };

/**
 * The Auto Scout page's client state. It never polls and never starts a scan:
 * the dashboard replays the worker's state and activity on connect, then
 * streams both as the worker persists them. Controls only send commands.
 */
export class ScoutStore {
  snapshot = $state<ScoutSnapshot | null>(null);
  activity = $state<string[]>([]);
  /** The scan whose activity is shown, so a stale stream cannot overwrite it. */
  activityScanId = $state<string | null>(null);
  private lastNotice: string | null = null;
  private lastError: string | null = null;

  get lifecycle(): string {
    return this.snapshot?.lifecycle ?? "stopped";
  }

  get repo(): string | null {
    return this.snapshot?.repo ?? null;
  }

  /**
   * The header's origin label. A missing snapshot is not evidence that the
   * checkout has no origin, so only a received snapshot may say so.
   */
  get repoLabel(): string {
    if (this.repo !== null) return this.repo;
    return this.snapshot === null ? "…" : "No GitHub origin";
  }

  get attached(): boolean {
    return this.snapshot?.attached === true;
  }

  get lifecycleActive(): boolean {
    return this.snapshot?.enabled === true || this.attached;
  }

  get issues(): ScoutIssueRow[] {
    return this.snapshot?.issues ?? [];
  }

  /** The sidebar count: open Auto Scout issues. */
  get count(): number {
    return this.issues.filter((issue) => issue.state === "pending").length;
  }

  get limits(): ScoutLimits {
    const limits = this.snapshot?.limits;
    return limits ?? DEFAULT_LIMITS;
  }

  get sync(): ScoutSync {
    return this.snapshot?.sync ?? EMPTY_SYNC;
  }

  get scanning(): boolean {
    return this.snapshot?.scan !== null && this.snapshot?.scan !== undefined;
  }

  get error(): string | null {
    return this.snapshot?.lastError ?? null;
  }

  get canStart(): boolean {
    return connection.open && !this.attached;
  }

  get canStop(): boolean {
    return this.attached;
  }

  start(): void {
    connection.send({ type: "startScout" });
  }

  stop(): void {
    connection.send({ type: "stopScout" });
  }

  saveLimits(maxPerHour: number, maxPending: number): void {
    connection.send({ type: "setScoutLimits", maxPerHour, maxPending });
  }

  handleEvent(message: Record<string, unknown>): void {
    if (isSnapshot(message)) {
      const next = message as unknown as ScoutSnapshot;
      const first = this.snapshot === null;
      const previousScan =
        this.snapshot?.scan?.scanId ?? this.snapshot?.newestScanId ?? null;
      const nextScan = next.scan?.scanId ?? next.newestScanId ?? null;
      this.snapshot = next;
      if (nextScan !== previousScan) {
        this.activity = [];
        this.activityScanId = nextScan;
      }
      // The first snapshot of a page load is replayed state, not news.
      if (next.lastError !== this.lastError) {
        this.lastError = next.lastError;
        if (next.lastError !== null && !first) {
          notifications.push("Auto Scout", "error", next.lastError);
        }
      }
      if (next.notice !== this.lastNotice) {
        this.lastNotice = next.notice;
        if (!first && next.notice !== null && next.notice.startsWith("Filed ")) {
          notifications.push("Auto Scout", "success", next.notice);
        }
      }
      return;
    }
    if (message.type === "scoutActivity" && typeof message.scanId === "string") {
      const current = this.snapshot?.scan?.scanId ?? this.snapshot?.newestScanId ?? null;
      if (message.scanId !== current) return;
      this.activityScanId = message.scanId;
      const entries = Array.isArray(message.entries) ? message.entries.filter(isEntry) : [];
      this.activity = applyActivity(this.activity, entries, message.replay === true);
    }
  }
}

export const scout = new ScoutStore();
