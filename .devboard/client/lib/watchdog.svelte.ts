import type { WatchdogSnapshot, WatchdogSync } from "./types";

/**
 * The Watchdog page's client state. It reads only `GET /api/watchdog`: the
 * server owns every GitHub call, so the browser never touches `gh`, a token,
 * or a command that files, comments, closes, or starts anything.
 */

const POLL_MS = 15_000;
const EMPTY_SYNC: WatchdogSync = { state: "stale", at: null, error: null };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A reply is trusted only when it carries the page's shapes. */
function isSnapshot(value: unknown): value is WatchdogSnapshot {
  if (!isObject(value)) return false;
  return (
    (value.cycle === null || typeof value.cycle === "string") &&
    typeof value.action === "string" &&
    typeof value.findings === "number" &&
    typeof value.pending === "number" &&
    Array.isArray(value.issues) &&
    Array.isArray(value.cycles) &&
    isObject(value.sync)
  );
}

export class WatchdogStore {
  snapshot = $state<WatchdogSnapshot | null>(null);
  /** A failed read of the dashboard endpoint itself; GitHub failures ride in `sync`. */
  error = $state<string | null>(null);
  private timer: number | undefined;

  get sync(): WatchdogSync {
    return this.snapshot?.sync ?? EMPTY_SYNC;
  }

  /** Begins polling; a second call is a no-op. */
  start(): void {
    if (this.timer !== undefined) return;
    void this.refresh();
    this.timer = window.setInterval(() => {
      void this.refresh();
    }, POLL_MS);
  }

  stop(): void {
    if (this.timer === undefined) return;
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    try {
      const response = await fetch("/api/watchdog", { cache: "no-store" });
      if (!response.ok) throw new Error(`/api/watchdog returned ${response.status}`);
      const body: unknown = await response.json();
      if (!isSnapshot(body)) throw new Error("/api/watchdog returned an unknown shape");
      this.snapshot = body;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
}

export const watchdog = new WatchdogStore();
