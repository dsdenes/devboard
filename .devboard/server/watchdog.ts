import { ghCommand } from "../issues/scout/preflight";
import {
  createRepositoryGitHub,
  shippedVersion,
  type GitHubCommandRunner,
  type GitHubRelease,
  type RepositoryGitHub,
} from "../lib/github-release";
import type { WatchdogCycle } from "../watchdog/history";
import { readWatchdogStatus, type WatchdogIssue } from "../watchdog/status";

/**
 * The Issues-mode watchdog page's server half. It reads the watchdog's local
 * facts on every request and overlays a GitHub projection that is refreshed in
 * the background at most once per interval. A request is never held open for
 * `gh`, and a failed read keeps the last known state and version for every
 * issue instead of inventing one.
 */

export type WatchdogIssueState = "pending" | "implemented";
export type WatchdogSyncState = "ok" | "error" | "stale";

export interface WatchdogSync {
  state: WatchdogSyncState;
  /** The last successful GitHub read, or null before one. */
  at: string | null;
  /** Why the last read failed, or null after a success. */
  error: string | null;
}

export interface WatchdogIssueRow extends WatchdogIssue {
  /** `null` until a GitHub read has answered for this issue. */
  state: WatchdogIssueState | null;
  /** The earliest published release that shipped the closing commit. */
  version: string | null;
}

export interface WatchdogSnapshot {
  cycle: string | null;
  action: string;
  reason?: string;
  findings: number;
  issues: WatchdogIssueRow[];
  pending: number;
  cycles: WatchdogCycle[];
  sync: WatchdogSync;
}

export interface WatchdogFacts {
  url: string;
  state: WatchdogIssueState;
  version: string | null;
}

/** Reads every issue's GitHub facts; rejection means the read failed. */
export interface WatchdogReader {
  project(urls: string[]): Promise<WatchdogFacts[]>;
}

/** At most one GitHub projection refresh starts per interval. */
export const WATCHDOG_REFRESH_MS = 60_000;
/** A success older than this, with no later failure, reads as stale. */
export const WATCHDOG_STALE_MS = 120_000;

export interface WatchdogActivityOptions {
  /** `<STATE_DIR>/watchdog`. */
  watchdogDir: string;
  /** The checkout used by the default reader to resolve commits. */
  repoDir?: string;
  /** Test seam; production reads the operator's `gh`. */
  reader?: WatchdogReader;
  /** Test seam for the interval and stale clock. */
  now?: () => number;
  intervalMs?: number;
  staleAfterMs?: number;
}

/** One issue URL, split into the repository it belongs to and its number. */
export function issueLocator(url: string): { repository: string; number: number } | null {
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([0-9]+)(?:[/?#].*)?$/.exec(
      url.trim(),
    );
  if (match === null) return null;
  const number = Number(match[3]);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repository: `${match[1]}/${match[2]}`, number };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

export interface WatchdogGitHubReaderOptions {
  /** The checkout that resolves commits and release containment locally. */
  repoDir: string;
  environment?: Record<string, string | undefined>;
  /** Injectable forge command; defaults to the operator's `gh`. */
  run?: GitHubCommandRunner;
}

/**
 * The live reader. Each issue's repository is taken from its own URL, so the
 * page stays correct when the ledger names issues outside the host origin.
 */
export function createWatchdogGitHubReader(
  options: WatchdogGitHubReaderOptions,
): WatchdogReader {
  const run = options.run ?? ((argv, environment) => ghCommand(argv, environment));
  const clients = new Map<string, RepositoryGitHub>();

  function client(repository: string): RepositoryGitHub {
    const existing = clients.get(repository);
    if (existing !== undefined) return existing;
    const created = createRepositoryGitHub({
      repository,
      repoDir: options.repoDir,
      run,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    clients.set(repository, created);
    return created;
  }

  return {
    async project(urls: string[]): Promise<WatchdogFacts[]> {
      const releases = new Map<string, GitHubRelease[]>();
      const facts: WatchdogFacts[] = [];
      for (const url of urls) {
        const locator = issueLocator(url);
        if (locator === null) {
          throw new Error(`not a GitHub issue URL: ${url}`);
        }
        const github = client(locator.repository);
        const state = await github.issueState(locator.number);
        if (state === "open") {
          facts.push({ url, state: "pending", version: null });
          continue;
        }
        let published = releases.get(locator.repository);
        if (published === undefined) {
          published = await github.listReleases();
          releases.set(locator.repository, published);
        }
        const version = await shippedVersion(
          { number: locator.number, state: "closed" },
          github,
          published,
        );
        facts.push({ url, state: "implemented", version });
      }
      return facts;
    },
  };
}

/**
 * The page's projection. `view()` answers immediately from the last read and
 * schedules a refresh when one is due; `settled()` lets a test await that
 * refresh without the endpoint ever waiting for it.
 */
export class WatchdogActivity {
  private readonly watchdogDir: string;
  private readonly reader: WatchdogReader;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly facts = new Map<string, { state: WatchdogIssueState; version: string | null }>();
  private lastStarted: number | null = null;
  private lastSuccess: number | null = null;
  private lastFailure: string | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: WatchdogActivityOptions) {
    this.watchdogDir = options.watchdogDir;
    this.reader =
      options.reader ??
      createWatchdogGitHubReader({ repoDir: options.repoDir ?? process.cwd() });
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = Math.max(1, options.intervalMs ?? WATCHDOG_REFRESH_MS);
    this.staleAfterMs = Math.max(0, options.staleAfterMs ?? WATCHDOG_STALE_MS);
  }

  /** The current projection; also the only trigger for a refresh. */
  view(): WatchdogSnapshot {
    this.schedule();
    return this.build();
  }

  /** Awaits the refresh a `view()` scheduled, if any. */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private schedule(): void {
    if (this.inFlight !== null) return;
    const now = this.now();
    if (this.lastStarted !== null && now - this.lastStarted < this.intervalMs) return;
    this.lastStarted = now;
    this.inFlight = this.refresh().finally(() => {
      this.inFlight = null;
    });
  }

  private async refresh(): Promise<void> {
    try {
      const urls = readWatchdogStatus(this.watchdogDir).issues.map((issue) => issue.url);
      const facts = urls.length === 0 ? [] : await this.reader.project(urls);
      const next = new Map<string, { state: WatchdogIssueState; version: string | null }>();
      for (const fact of facts) {
        const previous = this.facts.get(fact.url);
        const version =
          fact.state === "implemented"
            ? fact.version ?? (previous?.state === "implemented" ? previous.version : null)
            : null;
        next.set(fact.url, { state: fact.state, version });
      }
      this.facts.clear();
      for (const [url, value] of next) this.facts.set(url, value);
      this.lastSuccess = this.now();
      this.lastFailure = null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.lastFailure = firstLine(reason);
    }
  }

  private sync(): WatchdogSync {
    const now = this.now();
    const at = this.lastSuccess === null ? null : new Date(this.lastSuccess).toISOString();
    if (this.lastFailure !== null) {
      return { state: "error", at, error: this.lastFailure };
    }
    if (this.lastSuccess === null) return { state: "stale", at: null, error: null };
    if (now - this.lastSuccess > this.staleAfterMs) {
      return { state: "stale", at, error: null };
    }
    return { state: "ok", at, error: null };
  }

  private build(): WatchdogSnapshot {
    const status = readWatchdogStatus(this.watchdogDir);
    const issues: WatchdogIssueRow[] = status.issues.map((issue) => {
      const known = this.facts.get(issue.url);
      return {
        ...issue,
        state: known?.state ?? null,
        version: known?.state === "implemented" ? known.version : null,
      };
    });
    return {
      cycle: status.cycle,
      action: status.action,
      ...(status.reason === undefined ? {} : { reason: status.reason }),
      findings: status.findings,
      issues,
      pending: status.pending,
      cycles: status.cycles,
      sync: this.sync(),
    };
  }
}
