import { expect, test } from "bun:test";
import {
  agentRegistry,
  projectAgentSnapshot,
  type AgentSnapshotInput,
} from "../../lib/agent-registry.ts";
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

test("a worker keeps the start its lock reported and stores null without one", () => {
  const agents = new AgentsStore();
  agents.handleEvent({
    type: "agentState",
    agent: frame({
      workers: [
        {
          pid: 41,
          version: "1.48.1",
          stateDir: "/fixture/state",
          lifecycle: "running",
          startedAt: "2026-11-10T08:00:00.000Z",
        },
        { pid: 42, version: null, stateDir: "/fixture/old", lifecycle: "running" },
      ],
    }),
  });
  expect(agents.snapshot("scout")?.workers).toEqual([
    {
      pid: 41,
      version: "1.48.1",
      stateDir: "/fixture/state",
      lifecycle: "running",
      startedAt: "2026-11-10T08:00:00.000Z",
    },
    { pid: 42, version: null, stateDir: "/fixture/old", lifecycle: "running", startedAt: null },
  ]);
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
          createdAt: "2026-11-03T10:15:00.000Z",
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

test("a frame without availability reads enabled, as an older server's did", () => {
  const snapshot = projectAgentSnapshot(
    agentRegistry.require("scout"),
    frame() as unknown as AgentSnapshotInput,
  );
  expect(snapshot.availability).toEqual({ state: "enabled", reason: null });
});

test("a disabled availability without a reason is refused", () => {
  const descriptor = agentRegistry.require("release-train");
  const input = frame({
    id: "release-train",
    label: "Release Train",
    availability: { state: "disabled", reason: null },
  }) as unknown as AgentSnapshotInput;
  expect(() => projectAgentSnapshot(descriptor, input)).toThrow(
    "a disabled agent must state its reason",
  );
  const blank = frame({
    id: "release-train",
    label: "Release Train",
    availability: { state: "disabled", reason: "   " },
  }) as unknown as AgentSnapshotInput;
  expect(() => projectAgentSnapshot(descriptor, blank)).toThrow(
    "a disabled agent must state its reason",
  );
});

test("a push-triggered family projects a null cadence whatever the frame sends", () => {
  const descriptor = agentRegistry.require("deploy-on-main");
  expect(descriptor.cadence).toBeUndefined();
  const snapshot = projectAgentSnapshot(
    descriptor,
    frame({
      id: "deploy-on-main",
      label: "Deploy on main",
      cadence: { minutes: 5, lastRunAt: null, nextRunAt: null },
    }) as unknown as AgentSnapshotInput,
  );
  expect(snapshot.cadence).toBeNull();
  expect(snapshot.availability).toEqual({ state: "enabled", reason: null });
});

test("a frame without deploys reads as an empty history", () => {
  const agents = new AgentsStore();
  agents.handleEvent({ type: "agentState", agent: frame() });
  expect(agents.snapshot("scout")?.deploys).toEqual([]);
});

test("the deploy history projects newest first and drives the sidebar count", () => {
  const agents = new AgentsStore();
  agents.handleEvent({
    type: "agentState",
    agent: frame({
      id: "deploy-on-main",
      label: "Deploy on main",
      cadence: null,
      issues: [
        {
          title: "a filed deploy failure",
          category: "deploy",
          createdAt: "2026-11-03T10:15:00.000Z",
          url: "https://example.test/issues/1",
          state: "pending",
          version: null,
        },
      ],
      deploys: [
        {
          id: "run-2",
          commit: "bbbbbbb",
          startedAt: "2026-11-04T10:00:00.000Z",
          endedAt: "2026-11-04T10:05:00.000Z",
          state: "failed",
          commits: 2,
        },
        {
          id: "run-1",
          commit: "aaaaaaa",
          startedAt: "2026-11-03T09:00:00.000Z",
          endedAt: "2026-11-03T09:05:00.000Z",
          state: "succeeded",
          commits: 0,
        },
      ],
    }),
  });
  expect(agents.snapshot("deploy-on-main")?.deploys?.map((row) => row.id)).toEqual([
    "run-2",
    "run-1",
  ]);
  expect(agents.count("deploy-on-main")).toBe(2);
  expect(agents.count("scout")).toBe(0);
});
