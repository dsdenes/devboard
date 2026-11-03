import {
  ForgeReadRetry,
  classifyForgeReadFailure,
} from "../../lib/forge-read-retry";
import type { AgentSync } from "./registry";
import type { ForgeIssueFact, ForgeIssueReader, ForgeIssueState } from "./forge-reader";

/**
 * The one periodic forge read behind the four background agents' filed-issues
 * tables. It ages and fails the table state by one rule: the dashboard reads
 * the forge itself, so a closure reaches the table while the agent's worker is
 * stopped; the read runs only while a client is connected; and a transport
 * failure keeps the last rows and read time while a permanent failure or a
 * rate limit surfaces on the first attempt. It never starts a worker, writes
 * worker state, or runs an agent turn.
 */

/** How often a connected dashboard re-reads a table's issue state. */
export const AGENT_FORGE_INTERVAL_MS = 60_000;
/** A success older than this reads as stale until the next scheduled read. */
export const AGENT_FORGE_STALE_MS = 120_000;

export interface AgentForgeStateOptions {
  reader: ForgeIssueReader;
  /** Every filed-issue URL the table lists right now. */
  urls: () => string[];
  /** True while at least one dashboard client is connected. */
  hasClients: () => boolean;
  now?: () => number;
  intervalMs?: number;
  staleAfterMs?: number;
  /** Runs after every settled read, success or failure. */
  onRead?: () => void;
  /** Facts an earlier dashboard persisted, shown until the first read. */
  seed?: Iterable<readonly [string, ForgeIssueFact]>;
  log?: (line: string) => void;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

/** A fact a read or a seed published for a row this forge served. */
export interface ForgeIssueAnswer {
  url: string;
  state: ForgeIssueState;
  version: string | null;
}

export class AgentForgeState {
  private readonly reader: ForgeIssueReader;
  private readonly urls: () => string[];
  private readonly hasClients: () => boolean;
  private readonly now: () => number;
  private readonly intervalMsValue: number;
  private readonly staleAfterMs: number;
  private readonly onRead: (() => void) | undefined;
  private readonly log: (line: string) => void;

  private facts = new Map<string, ForgeIssueAnswer>();
  /** The URLs the last successful read asked for, or null before one. */
  private asked: ReadonlySet<string> | null = null;
  /** The URLs the last successful read answered with a state. */
  private answered: ReadonlySet<string> = new Set();
  /** The URLs the last successful read could not answer for this forge. */
  private unreadableUrls: ReadonlySet<string> = new Set();
  private lastStartedAt: number | null = null;
  private lastSuccess: number | null = null;
  private lastFailure: string | null = null;
  /** When the next automatic retry is due; null means the normal cadence. */
  private nextAttemptAt: number | null = null;
  private readonly retry = new ForgeReadRetry();
  private inFlight: Promise<void> | null = null;
  private timer: Timer | undefined;

  constructor(options: AgentForgeStateOptions) {
    this.reader = options.reader;
    this.urls = options.urls;
    this.hasClients = options.hasClients;
    this.now = options.now ?? (() => Date.now());
    this.intervalMsValue = Math.max(1, options.intervalMs ?? AGENT_FORGE_INTERVAL_MS);
    this.staleAfterMs = Math.max(0, options.staleAfterMs ?? AGENT_FORGE_STALE_MS);
    this.onRead = options.onRead;
    this.log = options.log ?? (() => undefined);
    if (options.seed !== undefined) {
      const unreadable = new Set<string>();
      for (const [url, fact] of options.seed) {
        if (fact.state === "unreadable") {
          unreadable.add(url);
          continue;
        }
        this.facts.set(url, { url, state: fact.state, version: fact.version });
      }
      this.unreadableUrls = unreadable;
    }
  }

  /** Starts the cadence; it reads only while a client is connected. */
  begin(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(
      () => this.schedule(),
      Math.max(50, Math.min(this.intervalMsValue, 1_000)),
    );
    this.timer.unref?.();
    this.schedule();
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Resolves after the read in flight, if any, has settled. */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  /**
   * A view opened this table, or the bridge polled it: read now when the
   * cadence allows. Repeated requests inside one interval start nothing.
   */
  requestSync(): void {
    this.schedule();
  }

  /**
   * The fact the last successful read published for one row. Before a read,
   * only a seeded fact answers; a row this forge could not read never does.
   */
  fact(url: string): ForgeIssueAnswer | undefined {
    return this.facts.get(url);
  }

  /**
   * Whether the last successful read could not answer for this row's forge.
   * The row stays listed, and it claims no state.
   */
  unreadable(url: string): boolean {
    return this.unreadableUrls.has(url);
  }

  /**
   * Whether the table may still list this row. A row filed after the read
   * began has no answer and stays; a row this forge cannot serve stays; a
   * row the successful read omitted is gone.
   */
  reported(url: string): boolean {
    if (this.asked === null) return true;
    return !this.asked.has(url) || this.answered.has(url) || this.unreadableUrls.has(url);
  }

  /** Every fact the last successful read (or the seed) published. */
  entries(): IterableIterator<[string, ForgeIssueAnswer]> {
    return this.facts.entries();
  }

  /**
   * Every row a persisted projection lists: the answered facts and the
   * unreadable ones, which a filing cap counts as open.
   */
  rows(): IterableIterator<[string, ForgeIssueFact]> {
    const rows: Array<[string, ForgeIssueFact]> = [...this.facts];
    for (const url of this.unreadableUrls) {
      rows.push([url, { url, state: "unreadable", version: null }]);
    }
    return rows[Symbol.iterator]();
  }

  get sync(): AgentSync {
    const at = this.lastSuccess === null ? null : new Date(this.lastSuccess).toISOString();
    if (this.lastFailure !== null) return { state: "error", at, error: this.lastFailure };
    if (this.retry.failures > 0) return { state: "stale", at, error: null };
    if (this.lastSuccess === null) return { state: "stale", at: null, error: null };
    if (this.now() - this.lastSuccess > this.staleAfterMs) {
      return { state: "stale", at, error: null };
    }
    return { state: "ok", at, error: null };
  }

  private schedule(): void {
    if (this.inFlight !== null) return;
    if (!this.hasClients()) return;
    const now = this.now();
    if (this.lastStartedAt !== null) {
      const due = this.nextAttemptAt ?? this.lastStartedAt + this.intervalMsValue;
      if (now < due) return;
    }
    this.lastStartedAt = now;
    this.nextAttemptAt = null;
    const task = this.read().finally(() => {
      if (this.inFlight === task) this.inFlight = null;
    });
    this.inFlight = task;
  }

  private async read(): Promise<void> {
    // A unique list: two rows naming one issue are one read.
    const urls = [...new Set(this.urls())];
    let facts: ForgeIssueFact[];
    try {
      facts = urls.length === 0 ? [] : await this.reader.project(urls);
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error));
      return;
    }
    const next = new Map<string, ForgeIssueAnswer>();
    const unreadable = new Set<string>();
    for (const fact of facts) {
      if (fact.state === "unreadable") {
        unreadable.add(fact.url);
        continue;
      }
      next.set(fact.url, {
        url: fact.url,
        state: fact.state,
        version: fact.state === "implemented" ? fact.version : null,
      });
    }
    this.facts = next;
    this.asked = new Set(urls);
    this.answered = new Set(next.keys());
    this.unreadableUrls = unreadable;
    this.lastSuccess = this.now();
    this.lastFailure = null;
    this.nextAttemptAt = null;
    this.retry.succeed();
    this.settledRead();
  }

  private failed(detail: string): void {
    const reason = firstLine(detail);
    const kind = classifyForgeReadFailure(detail);
    const delay = this.retry.record(kind);
    if (kind === "transient" && delay !== null) {
      // The retry window is not an alert: the last rows and read time stay.
      this.lastFailure = null;
      this.nextAttemptAt = this.now() + delay;
    } else {
      this.lastFailure = reason;
      this.nextAttemptAt = null;
    }
    this.settledRead();
  }

  private settledRead(): void {
    try {
      this.onRead?.();
    } catch (error) {
      this.log(
        `could not publish the agent forge projection: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
