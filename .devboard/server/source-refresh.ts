import type { Journal } from "./journal";
import {
  alreadyAppliedSourceRefresh,
  distDigest,
  readAppliedSourceRefresh,
  readSourceRefreshRequest,
  sourceRefreshIntervalMs,
  type SourceRefreshRequest,
} from "../lib/source-refresh";

/**
 * Watches one dashboard's state directory for a publish-written source
 * refresh request. A valid request whose bundle digest matches the built tree
 * replaces the process through the ordinary replacement handoff. An invalid
 * request, a digest mismatch, or a replacement that cannot start leaves the
 * old process serving and is journaled once per attempt; a valid request stays
 * pending and is retried on the fixed interval until it succeeds or a newer
 * publish supersedes it.
 */

export type SourceRefreshOutcome =
  | "idle"
  | "invalid"
  | "digest-mismatch"
  | "refreshed"
  | "failed"
  | "stopped";

export interface SourceRefresherOptions {
  stateDir: string;
  /** The tree a request's digest must match: this checkout's built bundle. */
  distDir: string;
  journal: Journal;
  /**
   * Replaces this process. It must throw when the replacement could not be
   * started or did not become ready; a successful call never returns in
   * production, because the process exits.
   */
  replace: (request: SourceRefreshRequest) => Promise<void>;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam; production checks as soon as the event loop turns. */
  startImmediately?: boolean;
  /** Injectable scheduler; production uses an unref'd timeout. */
  schedule?: (run: () => Promise<unknown> | void, delayMs: number) => { cancel: () => void };
  /** Injectable digest; production hashes the built tree. */
  digest?: (directory: string) => string;
}

export interface SourceRefresher {
  checkNow(): Promise<SourceRefreshOutcome>;
  stop(): void;
  /** The fixed retry interval this refresher uses. */
  intervalMs: number;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startSourceRefresher(options: SourceRefresherOptions): SourceRefresher {
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? sourceRefreshIntervalMs(env);
  const digest = options.digest ?? distDigest;
  let timer: { cancel: () => void } | undefined;
  let stopped = false;
  let inFlight: Promise<SourceRefreshOutcome> | undefined;
  // One journal record per distinct malformed or mismatched request, so a
  // static bad file never fills the journal once per interval.
  const reported = new Set<string>();
  const reportOnce = (key: string, text: string): void => {
    if (reported.has(key)) return;
    reported.add(key);
    options.journal.write("update-error", text);
  };
  options.journal.write(
    "activity",
    `source refresh watching ${options.distDir} every ${intervalMs} ms`,
  );
  const scheduleTimer =
    options.schedule ??
    ((run: () => Promise<unknown> | void, delayMs: number) => {
      const handle = setTimeout(() => void run(), delayMs);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    });

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = scheduleTimer(() => {
      timer = undefined;
      return checkNow();
    }, delayMs);
  }

  async function runCheck(): Promise<SourceRefreshOutcome> {
    const read = readSourceRefreshRequest(options.stateDir);
    if (read.state === "missing") return "idle";
    if (read.state === "invalid") {
      reportOnce(read.key, `source refresh ignored: ${read.error}`);
      return "invalid";
    }
    const request = read.request;
    if (alreadyAppliedSourceRefresh(readAppliedSourceRefresh(options.stateDir), request)) {
      return "idle";
    }
    let current: string;
    try {
      current = digest(options.distDir);
    } catch (error) {
      reportOnce(
        `digest-unreadable:${request.commit}`,
        `source refresh ignored: could not read ${options.distDir}: ${detailOf(error)}`,
      );
      return "failed";
    }
    if (current !== request.distDigest) {
      reportOnce(
        `digest-mismatch:${read.key}:${current}`,
        `source refresh ignored: ${options.distDir} digests ${current}, ` +
          `not the requested ${request.distDigest}`,
      );
      return "digest-mismatch";
    }
    options.journal.write(
      "update",
      `source refresh requested: replacing with ${request.version} (${request.commit.slice(0, 7)})`,
    );
    try {
      await options.replace(request);
      return "refreshed";
    } catch (error) {
      options.journal.write("update-error", `source refresh failed: ${detailOf(error)}`);
      return "failed";
    }
  }

  function checkNow(): Promise<SourceRefreshOutcome> {
    if (stopped) return Promise.resolve("stopped");
    if (inFlight !== undefined) return inFlight;
    inFlight = runCheck()
      .catch((error: unknown) => {
        options.journal.write("update-error", `source refresh crashed: ${detailOf(error)}`);
        return "failed" as const;
      })
      .finally(() => {
        inFlight = undefined;
        // A fixed interval, never a spin: each attempt waits the same delay.
        schedule(intervalMs);
      });
    return inFlight;
  }

  // The first check runs as soon as the event loop turns, so a request that
  // arrived while the dashboard was down is applied without operator action.
  // A replacement waits one interval instead, so the process it replaced has
  // recorded the applied commit first.
  schedule(options.startImmediately ?? true ? 0 : intervalMs);

  return {
    checkNow,
    intervalMs,
    stop: () => {
      stopped = true;
      timer?.cancel();
      timer = undefined;
    },
  };
}
