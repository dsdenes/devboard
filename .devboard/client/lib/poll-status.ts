import type { IssuesSnapshot, IssuesSyncState } from "./types";

/**
 * The visual state of the Automation panel's poll line. The word in the text
 * always carries the meaning; `tone` only colors the dot.
 */
export type PollTone = "active" | "stale" | "limited" | "failed" | "idle";

export interface PollStatus {
  tone: PollTone;
  text: string;
  title: string;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Poll cadence as a short duration: `500ms`, `2s`, `1.5s`, `60s`. */
export function pollInterval(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return "unknown";
  if (intervalMs < SECOND) return `${Math.round(intervalMs)}ms`;
  const seconds = intervalMs / SECOND;
  return `${Number.isInteger(seconds) ? seconds : Math.round(seconds * 10) / 10}s`;
}

/**
 * How long ago a poll finished, at the resolution polling actually needs:
 * seconds below a minute, then minutes, hours, and days. A timestamp in the
 * future (clock skew) reads `just now` rather than a negative duration.
 */
export function pollAge(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "at an unknown time";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < SECOND) return "just now";
  if (elapsed < MINUTE) return `${Math.floor(elapsed / SECOND)}s ago`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  return `${Math.floor(elapsed / DAY)}d ago`;
}

/**
 * The line a stopped worker leaves behind: the Open issues list is still
 * refreshed by the dashboard's own tracker sync, so "Not polling" would be
 * false whenever that sync has run.
 */
function syncStatus(sync: IssuesSyncState | undefined, now: number): PollStatus | null {
  if (sync === undefined) return null;
  const interval = pollInterval(sync.intervalMs);
  const checked = sync.lastSyncAt === null ? "no check yet" : `checked ${pollAge(sync.lastSyncAt, now)}`;
  const title = [
    `Tracker sync every ${interval}`,
    `last check ${sync.lastSyncAt ?? "never"}`,
    sync.error ?? "no error",
  ].join(" · ");
  if (sync.error !== null) {
    return { tone: "failed", text: `Tracker sync failing · ${checked}`, title };
  }
  if (sync.lastSyncAt === null) {
    return { tone: "idle", text: "Tracker sync starting", title };
  }
  return { tone: "active", text: `Tracker every ${interval} · ${checked}`, title };
}

/**
 * The Automation panel subtitle. It states whether the worker is polling, how
 * often, and when it last checked; the exact timestamps stay in the tooltip so
 * a precise time is one hover away without cluttering the header.
 */
export function pollStatus(snapshot: IssuesSnapshot | null, now: number): PollStatus {
  const poll = snapshot?.poll ?? null;
  const interval = poll === null ? "unknown" : pollInterval(poll.intervalMs);
  const last = poll?.lastPollAt ?? null;
  const next = poll?.nextPollAt ?? null;
  const title = [
    `Poll interval ${interval}`,
    `last check ${last ?? "never"}`,
    `next check ${next ?? "not scheduled"}`,
  ].join(" · ");

  if (snapshot === null || !snapshot.present || !snapshot.enabled || snapshot.lifecycle === "stopped") {
    const synced = syncStatus(snapshot?.sync, now);
    if (synced !== null) return synced;
    return { tone: "idle", text: "Not polling", title: "The issues worker is stopped." };
  }

  if (snapshot.paused || snapshot.lifecycle === "paused" || snapshot.lifecycle === "pausing") {
    return { tone: "idle", text: "Polling paused", title };
  }

  if (poll === null) {
    return { tone: "idle", text: "Starting up", title: "The issues worker has not reported a poll yet." };
  }

  const checked = last === null ? "no check yet" : `checked ${pollAge(last, now)}`;
  const limited = poll.rateLimitedUntil !== null && Date.parse(poll.rateLimitedUntil) > now;

  if (limited) {
    return { tone: "limited", text: `Rate limited · ${checked}`, title };
  }
  if (poll.error !== null) {
    return { tone: "failed", text: `Poll failing · ${checked}`, title };
  }
  const lastAt = last === null ? null : Date.parse(last);
  const overdue =
    lastAt !== null && !Number.isNaN(lastAt) && now - lastAt > Math.max(3 * poll.intervalMs, 10 * SECOND);
  if (overdue) {
    return { tone: "stale", text: `Check overdue · ${checked}`, title };
  }
  return { tone: "active", text: `Every ${interval} · ${checked}`, title };
}
