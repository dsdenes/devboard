import { connection } from "./connection.svelte";
import { notifications } from "./notifications.svelte";
import type {
  ScoutActivityEntry,
  ScoutRecommendation,
  ScoutSnapshot,
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
    Array.isArray(value.staged) &&
    Array.isArray(value.decisions)
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

const PENDING_TIMEOUT_MS = 10_000;

/**
 * The Auto Scout page's client state. It never polls and never starts a scan:
 * the dashboard replays the worker's board and activity on connect, then
 * streams both as the worker persists them. Controls only send commands.
 */
export class ScoutStore {
  snapshot = $state<ScoutSnapshot | null>(null);
  activity = $state<string[]>([]);
  /** The scan whose activity is shown, so a stale stream cannot overwrite it. */
  activityScanId = $state<string | null>(null);
  /** Staged ids with a decision in flight; their controls stay disabled. */
  pending = $state<string[]>([]);
  private pendingTimers = new Map<string, number>();
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

  get count(): number {
    return this.staged.length;
  }

  get staged(): ScoutRecommendation[] {
    return this.snapshot?.staged ?? [];
  }

  get scanning(): boolean {
    return this.snapshot?.scan !== null && this.snapshot?.scan !== undefined;
  }

  get shortfall(): string | null {
    if (this.count >= 9) return null;
    const reason = this.snapshot?.shortfall?.reason;
    return reason === undefined
      ? `${this.count} of 9 slots filled`
      : `${this.count} of 9 slots filled — ${reason}`;
  }

  get notice(): string | null {
    return this.snapshot?.notice ?? null;
  }

  get error(): string | null {
    return this.snapshot?.lastError ?? null;
  }

  get nextAttemptAt(): string | null {
    return this.snapshot?.nextAttemptAt ?? null;
  }

  get decisions(): ScoutSnapshot["decisions"] {
    return this.snapshot?.decisions ?? [];
  }

  get canStart(): boolean {
    return connection.open && !this.attached;
  }

  get canStop(): boolean {
    return this.attached;
  }

  inFlight(id: string): boolean {
    return this.pending.includes(id);
  }

  start(): void {
    connection.send({ type: "startScout" });
  }

  stop(): void {
    connection.send({ type: "stopScout" });
  }

  scanNow(): void {
    connection.send({ type: "scanScout" });
  }

  approve(id: string): void {
    this.decide("approveScout", id);
  }

  draftGoal(id: string): void {
    this.decide("draftScoutGoal", id);
  }

  reject(id: string): void {
    this.decide("rejectScout", id);
  }

  private decide(type: string, id: string): void {
    if (this.inFlight(id) || !this.staged.some((item) => item.id === id)) return;
    this.pending = [...this.pending, id];
    const timer = window.setTimeout(() => this.settle(id), PENDING_TIMEOUT_MS);
    this.pendingTimers.set(id, timer);
    connection.send({ type, id });
  }

  private settle(id: string): void {
    const timer = this.pendingTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    this.pendingTimers.delete(id);
    this.pending = this.pending.filter((entry) => entry !== id);
  }

  private settleAll(): void {
    for (const id of [...this.pending]) this.settle(id);
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
      // A decision that left the board is settled; a failure clears the error.
      const staged = new Set(next.staged.map((item) => item.id));
      for (const id of [...this.pending]) {
        if (!staged.has(id)) this.settle(id);
      }
      // The first snapshot of a page load is replayed state, not news.
      if (next.lastError !== this.lastError) {
        this.lastError = next.lastError;
        if (next.lastError !== null) {
          this.settleAll();
          if (!first) notifications.push("error", next.lastError);
        }
      }
      if (next.notice !== this.lastNotice) {
        this.lastNotice = next.notice;
        if (
          !first &&
          next.notice !== null &&
          (next.notice.startsWith("Filed ") || next.notice.startsWith("Drafted "))
        ) {
          notifications.push("success", next.notice);
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
