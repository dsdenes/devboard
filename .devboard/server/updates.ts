import {
  installRelease,
  installedHarnessVersion,
  isNewerVersion,
  isReleaseUnreachable,
  latestRelease,
  releaseSource,
  ReleaseFeedError,
  type ReleaseInfo,
  type ReleaseSource,
} from "../lib/release";
import type { Journal } from "./journal";

/**
 * Automatic harness updates. The server checks the private release feed at
 * startup and then on an interval, installs a newer tarball into the host
 * prefix while it keeps serving, and leaves the restart to the operator's
 * reload control. A failure is journaled and retried with exponential backoff;
 * the running package is never replaced by a failed or partial install.
 */

export const DEFAULT_UPDATE_INTERVAL_MS = 60_000;
/** A repeated failure backs off to this ceiling, not past it. */
export const DEFAULT_MAX_BACKOFF_MS = 60 * 60_000;

export type UpdateOutcome = "current" | "installed" | "not-installed" | "failed" | "stopped";

export interface UpdateOptions {
  repoDir: string;
  /** The host's npm prefix: `<host>/.devboard`. */
  prefixDir: string;
  stateDir: string;
  /** Version this process started with. */
  currentVersion: string | null;
  journal: Journal;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  maxBackoffMs?: number;
  /** Injectable feed for tests and fixtures; defaults to the environment's. */
  source?: ReleaseSource;
  fetchRelease?: () => Promise<ReleaseInfo>;
  install?: (release: ReleaseInfo) => Promise<string>;
  onLatest?: (version: string) => void;
  onInstalled?: (version: string) => void;
  /** Test seam; production checks as soon as the event loop turns. */
  startImmediately?: boolean;
  /** Injectable scheduler; production uses an unref'd timeout. */
  schedule?: (run: () => Promise<unknown> | void, delayMs: number) => { cancel: () => void };
}

export interface Updater {
  /** The newest release a check has seen, or null before the first check. */
  latest(): string | null;
  /** Runs one check now; concurrent calls share the in-flight check. */
  checkNow(): Promise<UpdateOutcome>;
  /** Stops the next scheduled check; an in-flight check finishes. */
  stop(): void;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The next check delay: the base interval until a failure backs it off. */
export function updateRetryDelay(failures: number, intervalMs: number, maxBackoffMs: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** Math.min(failures, 16), maxBackoffMs);
}

export function startUpdater(options: UpdateOptions): Updater {
  const env = options.env ?? process.env;
  const intervalMs =
    options.intervalMs ?? positiveNumber(env.DEVBOARD_UPDATE_INTERVAL_MS, DEFAULT_UPDATE_INTERVAL_MS);
  const maxBackoffMs =
    options.maxBackoffMs ??
    positiveNumber(env.DEVBOARD_UPDATE_BACKOFF_MAX_MS, DEFAULT_MAX_BACKOFF_MS);
  const source = options.source ?? releaseSource(env);
  const fetchRelease = options.fetchRelease ?? (() => latestRelease(source));
  const install =
    options.install ??
    ((release: ReleaseInfo) =>
      installRelease({
        source,
        release,
        prefix: options.prefixDir,
        stateDir: options.stateDir,
        env,
      }));

  let latestVersion: string | null = null;
  let failures = 0;
  let timer: { cancel: () => void } | undefined;
  let stopped = false;
  let inFlight: Promise<UpdateOutcome> | undefined;
  const scheduleTimer =
    options.schedule ??
    ((run: () => Promise<unknown> | void, delayMs: number) => {
      const handle = setTimeout(() => void run(), delayMs);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    });

  function schedule(delayMs: number) {
    if (stopped) return;
    timer = scheduleTimer(() => {
      timer = undefined;
      return checkNow();
    }, delayMs);
  }

  function nextDelay(): number {
    return updateRetryDelay(failures, intervalMs, maxBackoffMs);
  }

  async function runCheck(): Promise<UpdateOutcome> {
    let release: ReleaseInfo;
    try {
      release = await fetchRelease();
    } catch (error) {
      failures += 1;
      const detail = detailOf(error);
      if (isReleaseUnreachable(error) || error instanceof ReleaseFeedError) {
        // An offline host, a missing release client, or a feed that answers
        // with something other than a release description is not a harness
        // defect: the check backs off like any other failure, but the record
        // is context, never a watchdog finding.
        options.journal.write("activity", `release check skipped: ${detail}`);
      } else {
        options.journal.write("update-error", `release check failed: ${detail}`);
      }
      return "failed";
    }
    latestVersion = release.version;
    options.onLatest?.(release.version);

    try {
      const installed = await installedHarnessVersion(options.prefixDir);
      // The canonical source checkout has no npm prefix; never install into it.
      if (installed === null) return "not-installed";
      if (!isNewerVersion(release.version, installed)) {
        failures = 0;
        return "current";
      }
      const installedVersion = await install(release);
      failures = 0;
      options.journal.write(
        "update",
        `installed ${installedVersion} (was ${installed}); a restart loads it`,
      );
      options.onInstalled?.(installedVersion);
      return "installed";
    } catch (error) {
      failures += 1;
      options.journal.write(
        "update-error",
        `could not install ${release.version}: ${detailOf(error)}`,
      );
      return "failed";
    }
  }

  function checkNow(): Promise<UpdateOutcome> {
    if (stopped) return Promise.resolve("stopped");
    if (inFlight !== undefined) return inFlight;
    inFlight = runCheck()
      .catch((error: unknown) => {
        failures += 1;
        options.journal.write("update-error", `update check crashed: ${detailOf(error)}`);
        return "failed" as const;
      })
      .finally(() => {
        inFlight = undefined;
        schedule(nextDelay());
      });
    return inFlight;
  }

  // The first check runs as soon as the event loop turns, so the server binds
  // its port first and an idle process still checks immediately.
  if (options.startImmediately ?? true) schedule(0);

  return {
    latest: () => latestVersion,
    checkNow,
    stop: () => {
      stopped = true;
      timer?.cancel();
      timer = undefined;
    },
  };
}
