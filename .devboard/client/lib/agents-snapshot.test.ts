import { expect, test } from "bun:test";
import { AgentsStore } from "./agents.svelte";

/** One wire frame of the shared shape, with the fields a case overrides. */
function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "scout",
    label: "Auto Scout",
    description: "",
    scope: "repository",
    lifecycle: "running",
    paused: false,
    enabled: true,
    owned: true,
    attached: true,
    cadence: { minutes: 5, defaultMinutes: 1, lastRunAt: null, nextRunAt: null },
    limits: { maxPerHour: null, maxPending: null },
    issues: [],
    documentation: [],
    releases: [],
    pending: 0,
    sync: { state: "ok", at: null, error: null },
    detail: { panel: "activity", scanId: null, entries: [] },
    notice: null,
    error: null,
    timer: null,
    workers: [],
    ...overrides,
  };
}

test("a frame without workers is stored with no live workers", () => {
  const agents = new AgentsStore();
  const withoutWorkers = frame();
  delete withoutWorkers.workers;
  agents.handleEvent({ type: "agentState", agent: withoutWorkers });
  expect(agents.snapshot("scout")?.workers).toEqual([]);
});

test("a frame whose issue row has no url is dropped and the stored snapshot stands", () => {
  const agents = new AgentsStore();
  agents.handleEvent({ type: "agentState", agent: frame() });
  const before = agents.snapshot("scout");
  agents.handleEvent({
    type: "agentState",
    agent: frame({
      issues: [
        {
          title: "A finding",
          category: null,
          filedAt: "2026-11-03T10:15:00.000Z",
          state: "pending",
          version: null,
        },
      ],
    }),
  });
  expect(agents.snapshot("scout")).toBe(before);
  expect(agents.count("scout")).toBe(0);
});

test("a cycle row without a window is dropped instead of rendered", () => {
  const agents = new AgentsStore();
  agents.handleEvent({
    type: "agentState",
    agent: frame({
      id: "watchdog",
      label: "Watchdog",
      scope: "machine",
      detail: {
        panel: "cycles",
        cycles: [{ at: "2026-11-03T10:15:00.000Z", action: "none", findings: 0, issues: [] }],
      },
    }),
  });
  expect(agents.snapshot("watchdog")).toBeNull();
});
