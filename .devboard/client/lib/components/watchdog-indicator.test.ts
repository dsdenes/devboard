import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { AgentSnapshot } from "../../../lib/agent-registry.ts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component and
// the store load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: WatchdogIndicator } = await import("./watchdog-indicator.svelte");
const { agents } = await import("../agents.svelte");

beforeEach(() => {
  agents.snapshots = {};
});

afterEach(() => {
  cleanup();
  agents.snapshots = {};
});

/** One Watchdog snapshot whose newest cycle carries the named action. */
function snapshot(action: string): AgentSnapshot {
  return {
    id: "watchdog",
    label: "Watchdog",
    description: "",
    scope: "machine",
    lifecycle: "running",
    paused: false,
    enabled: true,
    owned: true,
    attached: true,
    cadence: { minutes: 30, defaultMinutes: 30, lastRunAt: null, nextRunAt: null },
    limits: { maxPerHour: null, maxPending: null },
    issues: [],
    documentation: [],
    releases: [],
    pending: 0,
    sync: { state: "ok", at: null, error: null },
    detail: {
      panel: "cycles",
      cycles: [
        {
          at: "2026-11-11T04:00:00.000Z",
          window: { start: "2026-11-11T03:30:00.000Z", end: "2026-11-11T04:00:00.000Z" },
          action,
          findings: 0,
          issues: [],
        },
      ],
    },
    notice: null,
    error: null,
    timer: null,
    workers: [],
  };
}

/** The shared status dot the indicator renders for the mounted store. */
function dotState(): string | null {
  const view = render(WatchdogIndicator);
  const trigger = view.getByTestId("status-watchdog");
  return trigger.querySelector(".status-dot")?.getAttribute("data-state") ?? null;
}

test("an idle cycle paints the healthy dot instead of a warning", () => {
  agents.snapshots = { watchdog: snapshot("none") };
  expect(dotState()).toBe("open");
});

test("capped, deferred, and skipped cycles leave findings pending and warn", () => {
  for (const action of ["capped", "deferred", "skipped"]) {
    agents.snapshots = {};
    cleanup();
    agents.snapshots = { watchdog: snapshot(action) };
    expect({ action, dot: dotState() }).toEqual({ action, dot: "connecting" });
  }
});

test("a failed cycle stays red", () => {
  agents.snapshots = { watchdog: snapshot("failed") };
  expect(dotState()).toBe("closed");
});

test("filed, commented, and duplicate cycles paint healthy green", () => {
  for (const action of ["filed", "commented", "duplicate"]) {
    agents.snapshots = {};
    cleanup();
    agents.snapshots = { watchdog: snapshot(action) };
    expect({ action, dot: dotState() }).toEqual({ action, dot: "open" });
  }
});

test("an unrecognized action never claims health", () => {
  agents.snapshots = { watchdog: snapshot("something-new") };
  expect(dotState()).toBe("connecting");
});

test("a Watchdog with no snapshot yet stays connecting", () => {
  expect(dotState()).toBe("connecting");
});
