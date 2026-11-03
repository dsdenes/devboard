/**
 * The once-per-UTC-day snapshot rule. The dashboard calls `check()` at server
 * start and on a fixed tick; a day that already has a snapshot is left alone,
 * so a restart, a page open, a reload, and a reconnect on the same day never
 * add a second file. The check belongs to the server's own lifecycle: there is
 * no background worker, detached process, or service behind it.
 */
import { join, resolve } from "node:path";
import {
  buildComplexitySnapshot,
  utcDate,
  type ComplexitySnapshot,
} from "./analyze";
import {
  complexityDirectory,
  complexityFrame,
  readSnapshots,
  writeSnapshot,
  type ComplexityFrame,
} from "./store";

/** The working files the analyzer measures: the running harness package. */
export function runningHarnessRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

/**
 * One process measures one day's tree once. Every dashboard this process
 * builds reuses that measurement instead of rescanning the same bytes, and a
 * new UTC day measures again. The recorded file is still per state directory.
 */
const measuredDays = new Map<string, ComplexitySnapshot>();

function measureHarnessDay(now: Date): ComplexitySnapshot {
  const key = `${runningHarnessRoot()}\u0000${utcDate(now)}`;
  const cached = measuredDays.get(key);
  if (cached !== undefined) return { ...cached, recordedAt: now.toISOString() };
  const snapshot = buildComplexitySnapshot(runningHarnessRoot(), now);
  measuredDays.set(key, snapshot);
  return snapshot;
}

/** One minute is enough for a midnight rollover to land within a minute. */
export const COMPLEXITY_CHECK_INTERVAL_MS = 60_000;

export interface ComplexityOptions {
  stateDir: string;
  repoDir: string;
  /** Injectable clock; defaults to the real one. */
  now?: () => Date;
  /** Injectable measurement; defaults to the running harness's own source. */
  analyze?: (now: Date) => ComplexitySnapshot;
  /** How often the UTC date is re-checked while the server runs. */
  intervalMs?: number;
  /** Called once per newly recorded snapshot, after its file is on disk. */
  onRecorded?: (
    snapshot: ComplexitySnapshot,
    snapshots: readonly ComplexitySnapshot[],
  ) => void;
  /** A failed measurement or write is reported here and retried next tick. */
  reportError?: (message: string) => void;
}

/**
 * The clock the daily rule follows. `DEVBOARD_COMPLEXITY_NOW` pins an instant
 * for a verification run or a fixture host; an unset or unparseable value
 * leaves the real clock in place, so a bad variable never stops a dashboard.
 */
export function complexityClock(
  env: Record<string, string | undefined> = process.env,
): () => Date {
  const raw = env.DEVBOARD_COMPLEXITY_NOW?.trim();
  if (raw === undefined || raw.length === 0) return () => new Date();
  const fixed = new Date(raw);
  if (Number.isNaN(fixed.getTime())) return () => new Date();
  const instant = fixed.getTime();
  return () => new Date(instant);
}

/** Owns the recorded history and the daily check for one dashboard process. */
export class ComplexitySnapshots {
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #analyze: (now: Date) => ComplexitySnapshot;
  readonly #intervalMs: number;
  readonly #onRecorded:
    | ((snapshot: ComplexitySnapshot, snapshots: readonly ComplexitySnapshot[]) => void)
    | undefined;
  readonly #reportError: (message: string) => void;
  #snapshots: ComplexitySnapshot[];
  #timer: Timer | undefined;
  #pending: Promise<ComplexitySnapshot | null> | undefined;
  #started = false;

  constructor(options: ComplexityOptions) {
    this.#directory = complexityDirectory(options.stateDir, options.repoDir);
    this.#now = options.now ?? (() => new Date());
    this.#analyze = options.analyze ?? measureHarnessDay;
    this.#intervalMs = Math.max(1_000, options.intervalMs ?? COMPLEXITY_CHECK_INTERVAL_MS);
    this.#onRecorded = options.onRecorded;
    this.#reportError = options.reportError ?? (() => undefined);
    this.#snapshots = readSnapshots(this.#directory);
  }

  /** The directory every snapshot file lives in. */
  get directory(): string {
    return this.#directory;
  }

  /** Every recorded snapshot, oldest to newest. */
  get snapshots(): readonly ComplexitySnapshot[] {
    return this.#snapshots;
  }

  /** The newest recorded snapshot, or `null` before the first one. */
  latest(): ComplexitySnapshot | null {
    return this.#snapshots[this.#snapshots.length - 1] ?? null;
  }

  /** The page payload: every recorded date plus the newest full snapshot. */
  frame(): ComplexityFrame {
    return complexityFrame(this.#snapshots, this.latest());
  }

  /** Records this UTC day's snapshot and starts the rollover check. */
  begin(): void {
    if (this.#started) return;
    this.#started = true;
    void this.check();
    this.#timer = setInterval(() => void this.check(), this.#intervalMs);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#started = false;
  }

  /**
   * Records a snapshot for the current UTC day when none exists. Overlapping
   * calls share one measurement, so a tick that lands while the first one runs
   * can never write a second file.
   */
  check(): Promise<ComplexitySnapshot | null> {
    if (this.#pending === undefined) {
      this.#pending = this.#checkOnce().finally(() => {
        this.#pending = undefined;
      });
    }
    return this.#pending;
  }

  async #checkOnce(): Promise<ComplexitySnapshot | null> {
    const now = this.#now();
    const date = utcDate(now);
    if (this.#snapshots.some((snapshot) => snapshot.date === date)) return null;
    let snapshot: ComplexitySnapshot;
    try {
      snapshot = this.#analyze(now);
    } catch (error) {
      this.#reportError(
        `complexity: measurement for ${date} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    const stored: ComplexitySnapshot = { ...snapshot, date, recordedAt: now.toISOString() };
    try {
      await writeSnapshot(this.#directory, stored);
    } catch (error) {
      this.#reportError(
        `complexity: writing ${join(date, "snapshot")} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
    this.#snapshots = [...this.#snapshots, stored].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
    this.#onRecorded?.(stored, this.#snapshots);
    return stored;
  }
}
