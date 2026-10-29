import type { IssuesIssue } from "../issues/state";
import { originForge } from "../issues/repository";
import { pollOpenIssues, TRACKER_TIMEOUT_MS, type PollResult } from "../issues/tracker";
import { DEADLINE_EXPIRED, withinDeadline } from "../lib/deadline";
import { giteaBaseUrl } from "../lib/forge";

/**
 * The dashboard's own read of the origin tracker. The detached Issues worker
 * owns automation and polls only while it runs; the Open issues view must
 * still drop an issue the operator closed in the forge while that worker is
 * stopped or paused, so this reader runs beside the worker, from the
 * dashboard, on a fixed cadence and with no state of its own.
 */

/** How often a connected dashboard re-reads the origin's open issues. */
export const TRACKER_SYNC_INTERVAL_MS = 30_000;

export interface TrackerReadRequest {
  repository: string;
  etag: string | null;
}

/** One conditional read of the origin's open, non-pull-request issues. */
export type TrackerRead = (request: TrackerReadRequest) => Promise<PollResult>;

/** The sync status the Issues snapshot publishes for the Overview. */
export interface TrackerSyncView {
  intervalMs: number;
  lastSyncAt: string | null;
  error: string | null;
}

export interface TrackerSyncResult {
  /** True only when this read returned the complete open list. */
  fresh: boolean;
  issues: IssuesIssue[] | null;
  error: string | null;
  /** When this read began; a run that started later was not in its answer. */
  startedAt: string | null;
}

export interface TrackerSyncOptions {
  repoDir: string;
  /** The repository the worker published, else the checkout's origin. */
  repository: () => string | null;
  environment?: Record<string, string | undefined>;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => Date;
  /** Test seam: replaces the origin read. */
  read?: TrackerRead;
}

/** The origin read the dashboard uses when no test seam is supplied. */
export function defaultTrackerRead(
  options: Pick<TrackerSyncOptions, "repoDir" | "environment" | "timeoutMs">,
): TrackerRead {
  return (request) => {
    const remote = originForge(options.repoDir, options.environment);
    const baseUrl = giteaBaseUrl(remote, options.environment);
    return pollOpenIssues({
      repository: request.repository,
      etag: request.etag,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(remote === undefined ? {} : { forge: remote.forge }),
      ...(remote?.forge === "gitea" && baseUrl !== undefined ? { baseUrl } : {}),
    });
  };
}

/**
 * One tracker reader shared by the sync timer and connect-time refreshes.
 * Concurrent reads join the one in flight, and a failed read keeps the last
 * complete list visible while its error is published.
 */
export class TrackerSync {
  private readonly read: TrackerRead;
  private readonly repository: () => string | null;
  private readonly now: () => Date;
  private readonly intervalMsValue: number;
  private readonly timeoutMs: number;

  private etag: string | null = null;
  private issues: IssuesIssue[] | null = null;
  private lastSyncAt: string | null = null;
  private freshStart: string | null = null;
  private error: string | null = null;
  private inFlight: Promise<TrackerSyncResult> | undefined;

  constructor(options: TrackerSyncOptions) {
    this.repository = options.repository;
    this.intervalMsValue = Math.max(1, options.intervalMs ?? TRACKER_SYNC_INTERVAL_MS);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? TRACKER_TIMEOUT_MS);
    this.now = options.now ?? (() => new Date());
    this.read = options.read ?? defaultTrackerRead(options);
  }

  get view(): TrackerSyncView {
    return {
      intervalMs: this.intervalMsValue,
      lastSyncAt: this.lastSyncAt,
      error: this.error,
    };
  }

  /** The last complete open list, or null before the first successful read. */
  get openIssues(): IssuesIssue[] | null {
    return this.issues;
  }

  /**
   * When the read behind `openIssues` began. A run that started later was not
   * part of its answer, so the caller may neither hide nor stop it on that
   * read alone.
   */
  get freshStartedAt(): string | null {
    return this.freshStart;
  }

  /** Reads the tracker once; a read already in flight is joined. */
  sync(): Promise<TrackerSyncResult> {
    if (this.inFlight !== undefined) return this.inFlight;
    const task = this.readOnce().finally(() => {
      if (this.inFlight === task) this.inFlight = undefined;
    });
    this.inFlight = task;
    return task;
  }

  private async readOnce(): Promise<TrackerSyncResult> {
    const repository = this.repositoryName();
    if (repository === null) {
      // A checkout without a forge origin has nothing to read; that is not a
      // failure, and publishing it would misreport every origin-less host.
      return { fresh: false, issues: this.issues, error: this.error, startedAt: null };
    }
    const startedAt = this.now().toISOString();
    let result: PollResult | typeof DEADLINE_EXPIRED;
    try {
      result = await withinDeadline(
        Promise.resolve().then(() => this.read({ repository, etag: this.etag })),
        this.timeoutMs,
      );
    } catch (error) {
      return this.failed(error instanceof Error ? error.message : String(error), startedAt);
    }
    if (result === DEADLINE_EXPIRED) {
      return this.failed(`the tracker did not answer within ${this.timeoutMs} ms`, startedAt);
    }
    switch (result.kind) {
      case "issues": {
        this.etag = result.etag;
        this.issues = result.issues;
        this.freshStart = startedAt;
        this.lastSyncAt = this.now().toISOString();
        this.error = null;
        return { fresh: true, issues: this.issues, error: null, startedAt };
      }
      case "not-modified": {
        this.etag = result.etag;
        this.lastSyncAt = this.now().toISOString();
        this.error = null;
        return { fresh: false, issues: this.issues, error: null, startedAt };
      }
      default:
        return this.failed(result.detail, startedAt);
    }
  }

  private repositoryName(): string | null {
    const repository = this.repository();
    return repository === null || repository.trim().length === 0 ? null : repository;
  }

  private failed(detail: string, startedAt: string | null): TrackerSyncResult {
    this.error = detail;
    return { fresh: false, issues: this.issues, error: detail, startedAt };
  }
}
