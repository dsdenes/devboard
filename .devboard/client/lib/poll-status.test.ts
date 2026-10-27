import { describe, expect, test } from "bun:test";
import type { IssuesSnapshot } from "./types";
import { pollAge, pollInterval, pollStatus } from "./poll-status";

const AT = Date.parse("2026-10-27T14:03:24.000Z");

function snapshot(overrides: Partial<IssuesSnapshot> = {}): IssuesSnapshot {
  return {
    present: true,
    repo: "fixture/host",
    root: "/fixture",
    lifecycle: "running",
    enabled: true,
    paused: false,
    attached: true,
    worker: null,
    poll: {
      intervalMs: 2_000,
      lastPollAt: "2026-10-27T14:03:22.854Z",
      nextPollAt: "2026-10-27T14:03:24.854Z",
      etag: '"etag"',
      notModified: false,
      rateLimitedUntil: null,
      error: null,
    },
    queue: [],
    runs: [],
    agents: [],
    cooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("poll interval", () => {
  test("keeps sub-second cadences in milliseconds and whole seconds unrounded", () => {
    expect(pollInterval(250)).toBe("250ms");
    expect(pollInterval(2_000)).toBe("2s");
    expect(pollInterval(60_000)).toBe("60s");
  });

  test("rounds a fractional cadence to one decimal", () => {
    expect(pollInterval(1_500)).toBe("1.5s");
    expect(pollInterval(1_333)).toBe("1.3s");
  });

  test("does not invent a cadence for an invalid interval", () => {
    expect(pollInterval(0)).toBe("unknown");
    expect(pollInterval(Number.NaN)).toBe("unknown");
  });
});

describe("poll age", () => {
  test("reads seconds, minutes, hours, and days at polling resolution", () => {
    expect(pollAge("2026-10-27T14:03:23.500Z", AT)).toBe("just now");
    expect(pollAge("2026-10-27T14:03:22.854Z", AT)).toBe("1s ago");
    expect(pollAge("2026-10-27T13:58:24.000Z", AT)).toBe("5m ago");
    expect(pollAge("2026-10-27T11:03:24.000Z", AT)).toBe("3h ago");
    expect(pollAge("2026-10-24T14:03:24.000Z", AT)).toBe("3d ago");
  });

  test("clamps a future timestamp and names an unreadable one", () => {
    expect(pollAge("2026-10-27T14:04:00.000Z", AT)).toBe("just now");
    expect(pollAge("not a date", AT)).toBe("at an unknown time");
  });
});

describe("poll status", () => {
  test("states the cadence and the last check while polling", () => {
    const status = pollStatus(snapshot(), AT);
    expect(status).toEqual({
      tone: "active",
      text: "Every 2s · checked 1s ago",
      title:
        "Poll interval 2s · last check 2026-10-27T14:03:22.854Z · next check 2026-10-27T14:03:24.854Z",
    });
  });

  test("reads a stopped or paused worker as not polling", () => {
    expect(pollStatus(null, AT)).toMatchObject({ tone: "idle", text: "Not polling" });
    expect(pollStatus(snapshot({ lifecycle: "stopped", enabled: false }), AT)).toMatchObject({
      tone: "idle",
      text: "Not polling",
    });
    expect(pollStatus(snapshot({ lifecycle: "paused", paused: true }), AT)).toMatchObject({
      tone: "idle",
      text: "Polling paused",
    });
    expect(pollStatus(snapshot({ lifecycle: "pausing" }), AT)).toMatchObject({ text: "Polling paused" });
  });

  test("names a failing poll without losing the last check", () => {
    const poll = snapshot().poll;
    if (poll === null) throw new Error("fixture poll missing");
    const status = pollStatus(snapshot({ poll: { ...poll, error: "HTTP 502" } }), AT);
    expect(status).toMatchObject({ tone: "failed", text: "Poll failing · checked 1s ago" });
  });

  test("names a rate limit only while it is still in effect", () => {
    const poll = snapshot().poll;
    if (poll === null) throw new Error("fixture poll missing");
    const limited = pollStatus(
      snapshot({ poll: { ...poll, error: "slow down", rateLimitedUntil: "2026-10-27T14:04:00.000Z" } }),
      AT,
    );
    expect(limited).toMatchObject({ tone: "limited", text: "Rate limited · checked 1s ago" });

    const expired = pollStatus(
      snapshot({ poll: { ...poll, error: "slow down", rateLimitedUntil: "2026-10-27T14:03:00.000Z" } }),
      AT,
    );
    expect(expired).toMatchObject({ tone: "failed", text: "Poll failing · checked 1s ago" });
  });

  test("names an overdue check instead of claiming a live loop", () => {
    const poll = snapshot().poll;
    if (poll === null) throw new Error("fixture poll missing");
    expect(
      pollStatus(snapshot({ poll: { ...poll, lastPollAt: "2026-10-27T09:03:24.000Z" } }), AT),
    ).toMatchObject({ tone: "stale", text: "Check overdue · checked 5h ago" });
  });

  test("states the first check before one has finished", () => {
    const poll = snapshot().poll;
    if (poll === null) throw new Error("fixture poll missing");
    expect(pollStatus(snapshot({ poll: { ...poll, lastPollAt: null } }), AT)).toMatchObject({
      text: "Every 2s · no check yet",
    });
  });

  test("states a worker that has not published a poll yet", () => {
    expect(pollStatus(snapshot({ poll: null }), AT)).toMatchObject({
      tone: "idle",
      text: "Starting up",
    });
  });
});
