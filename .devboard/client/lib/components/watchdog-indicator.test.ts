import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "bun:test";
import type { AgentIssueRow, AgentSnapshot } from "../../../lib/agent-registry.ts";
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
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
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
function snapshot(action: string, overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
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
    availability: { state: "enabled", reason: null },
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
    peers: 0,
    ...overrides,
  };
}

/** One filed issue row, named by its index in the filed order. */
function filed(index: number): AgentIssueRow {
  return {
    title: `filed issue ${index}`,
    category: null,
    createdAt: "2026-11-11T03:45:00.000Z",
    url: `http://localhost:3001/dsdenes/devboard/issues/${1000 + index}`,
    state: "pending",
    version: null,
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

test("a stopped family with no cycles warns instead of painting green", () => {
  agents.snapshots = {
    watchdog: snapshot("none", {
      lifecycle: "stopped",
      enabled: false,
      detail: { panel: "cycles", cycles: [] },
    }),
  };
  expect(dotState()).toBe("connecting");
});

test("a starting, stopping, disabled, or paused family never paints green", () => {
  for (const overrides of [
    { lifecycle: "starting" as const },
    { lifecycle: "stopping" as const },
    { enabled: false },
    { paused: true },
  ]) {
    cleanup();
    agents.snapshots = {};
    agents.snapshots = { watchdog: snapshot("none", overrides) };
    expect({ overrides, dot: dotState() }).toEqual({ overrides, dot: "connecting" });
  }
});

test("a pending filing queue warns even when the cycle itself was healthy", () => {
  for (const action of ["none", "filed"]) {
    cleanup();
    agents.snapshots = {};
    agents.snapshots = { watchdog: snapshot(action, { pending: 2 }) };
    expect({ action, dot: dotState() }).toEqual({ action, dot: "connecting" });
  }
});

test("an unread or failed tracker table warns", () => {
  for (const sync of [
    { state: "stale" as const, at: null, error: null },
    { state: "error" as const, at: null, error: "bad credentials" },
  ]) {
    cleanup();
    agents.snapshots = {};
    agents.snapshots = { watchdog: snapshot("none", { sync }) };
    expect({ state: sync.state, dot: dotState() }).toEqual({
      state: sync.state,
      dot: "connecting",
    });
  }
});

test("a failed family or a reported error stays red", () => {
  for (const overrides of [
    { lifecycle: "failed" as const },
    { error: "the Watchdog worker did not publish its state" },
  ]) {
    cleanup();
    agents.snapshots = {};
    agents.snapshots = { watchdog: snapshot("none", overrides) };
    expect({ overrides, dot: dotState() }).toEqual({ overrides, dot: "closed" });
  }
});

test("a Watchdog with no snapshot yet stays connecting", () => {
  expect(dotState()).toBe("connecting");
});

test("the age advances with the page clock without a new snapshot", async () => {
  const at = Date.parse("2026-11-11T04:00:00.000Z");
  jest.useFakeTimers();
  jest.setSystemTime(at + 2 * 60_000);
  try {
    agents.snapshots = { watchdog: snapshot("filed") };
    const trigger = render(WatchdogIndicator).getByTestId("status-watchdog");
    const value = () =>
      trigger.querySelector(".status-metric__value")?.textContent?.trim() ?? "";
    await Promise.resolve();
    expect(value()).toBe("filed · 2m ago");

    // No frame reaches the store; only the indicator's own clock ticks on.
    jest.advanceTimersByTime(60 * 60_000);
    await Promise.resolve();
    expect(value()).toBe("filed · 1h ago");
  } finally {
    jest.useRealTimers();
  }
});

/** Mount the indicator with the given filed issues and open its popover. */
async function openPopover(count: number) {
  const snap = snapshot("filed");
  snap.issues = Array.from({ length: count }, (_, index) => filed(index + 1));
  agents.snapshots = { watchdog: snap };
  const view = render(WatchdogIndicator);
  await fireEvent.click(view.getByTestId("status-watchdog"));
  return view.getByTestId("watchdog-popover");
}

test("the popover lists every filed issue, not only the newest ten", async () => {
  const popover = await openPopover(12);
  const titles = Array.from(
    popover.querySelectorAll(".watchdog-issues a"),
    (link) => link.textContent?.trim(),
  );
  expect(titles).toEqual(Array.from({ length: 12 }, (_, index) => `filed issue ${index + 1}`));
});

test("a Watchdog with nothing filed says so", async () => {
  const popover = await openPopover(0);
  expect(popover.textContent).toContain("No issues filed.");
  expect(popover.querySelectorAll(".watchdog-issues a")).toHaveLength(0);
});

test("a hundred filed issues stay inside the popover's own scroll bound", async () => {
  const popover = await openPopover(100);
  expect(popover.querySelectorAll(".watchdog-issues a")).toHaveLength(100);
  // The popover, not the status strip, is the one scroller: its own rule bounds
  // the height, so the strip never grows with the list.
  const style = getComputedStyle(popover);
  expect(parseFloat(style.maxHeight)).toBe(window.innerHeight / 2);
  expect(style.overflow).toBe("auto");
});
