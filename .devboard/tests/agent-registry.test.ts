import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_LIFECYCLES,
  AgentRegistryError,
  DEFAULT_AGENT_DESCRIPTORS,
  DISCOVER_AGENTS,
  DISCOVER_AGENT_IDS,
  DISCOVER_RUN_ORDER,
  agentRegistry,
  defineAgentRegistry,
  discoverAgent,
  isDiscoverAgentId,
  projectAgentSnapshot,
  sortAgentIssues,
  type AgentDescriptor,
  type AgentSnapshotInput,
} from "../server/agents/registry";
import { BackgroundAgentBridge } from "../server/agents/bridge";
import type { AgentAdapter, AgentCommandResult } from "../server/agents/types";

const harnessRoot = join(import.meta.dir, "..");
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const directory = await mkdtemp(join(harnessRoot, ".tmp", "agent-registry-"));
  directories.push(directory);
  return directory;
}

function syntheticDescriptor(): AgentDescriptor {
  return {
    ...agentRegistry.require("scout"),
    id: "patrol",
    label: "Patrol",
    description: "A third continuous background agent.",
    scope: "machine",
    tab: { id: "patrol", kind: "patrol", title: "Patrol" },
    detail: { panel: "cycles", testId: "agent-detail" },
    timerGate: undefined,
  };
}

function snapshotInput(descriptor: AgentDescriptor): AgentSnapshotInput {
  return {
    lifecycle: "running",
    enabled: true,
    owned: true,
    attached: true,
    cadence: { minutes: descriptor.cadence.defaultMinutes, lastRunAt: null, nextRunAt: null },
    limits: { ...descriptor.limits.default },
    issues: [
      {
        title: "later",
        category: null,
        filedAt: "2026-01-02T00:00:00.000Z",
        url: "https://example.test/issues/2",
        state: "pending",
        version: null,
      },
      {
        title: "same instant a",
        category: "tests",
        filedAt: "2026-01-01T00:00:00.000Z",
        url: "https://example.test/issues/3",
        state: "unknown",
        version: "v1",
      },
      {
        title: "same instant b",
        category: "tests",
        filedAt: "2026-01-01T00:00:00.000Z",
        url: "https://example.test/issues/1",
        state: "implemented",
        version: "v2",
      },
    ],
    pending: 1,
    sync: { state: "ok", at: "2026-01-02T00:00:00.000Z", error: null },
    detail: { panel: "cycles", cycles: [] },
    notice: null,
    error: null,
    timer: null,
  };
}

function fakeAdapter(
  descriptor: AgentDescriptor,
): AgentAdapter & { starts: number; stops: number; syncs: number } {
  let snapshot = snapshotInput(descriptor);
  return {
    descriptor,
    starts: 0,
    stops: 0,
    syncs: 0,
    begin() {},
    dispose() {},
    snapshot: () => snapshot,
    replay() {},
    requestSync() {
      this.syncs += 1;
    },
    async start(): Promise<AgentCommandResult> {
      this.starts += 1;
      snapshot = { ...snapshot, lifecycle: "running" };
      return { ok: true };
    },
    stop(): AgentCommandResult {
      this.stops += 1;
      snapshot = { ...snapshot, lifecycle: "stopped", enabled: false, attached: false };
      return { ok: true };
    },
    setSettings(): AgentCommandResult {
      return { ok: true };
    },
  };
}

describe("background agent registry", () => {
  test("ships every declared descriptor with its defaults", () => {
    expect(DEFAULT_AGENT_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual([
      "scout",
      "watchdog",
      "design",
      "coach",
      "api-standards",
      "release-train",
    ]);
    const scout = agentRegistry.require("scout");
    expect(scout.label).toBe("Auto Scout");
    expect(scout.scope).toBe("repository");
    expect(scout.cadence.defaultMinutes).toBe(1);
    expect(scout.limits.default).toEqual({ maxPerHour: 10, maxPending: 5 });
    expect(scout.detail.panel).toBe("activity");
    expect(scout.prompt).toEqual({
      kind: "file",
      file: "scout-recommendations.md",
    });
    const watchdog = agentRegistry.require("watchdog");
    expect(watchdog.label).toBe("Watchdog");
    expect(watchdog.scope).toBe("machine");
    expect(watchdog.cadence.defaultMinutes).toBe(10);
    expect(watchdog.limits.default).toEqual({ maxPerHour: null, maxPending: null });
    expect(watchdog.detail.panel).toBe("cycles");
    expect(watchdog.prompt.kind).toBe("absent");
    const design = agentRegistry.require("design");
    expect(design.label).toBe("Design System");
    expect(design.scope).toBe("repository");
    expect(design.cadence.defaultMinutes).toBe(60);
    expect(design.limits.default).toEqual({ maxPerHour: 10, maxPending: 5 });
    expect(design.detail.panel).toBe("activity");
    expect(design.documentation).toEqual({ testId: "agent-documentation" });
    expect(design.tab).toEqual({ id: "design", kind: "design", title: "Design System" });
    expect(design.prompt).toEqual({
      kind: "file",
      file: "design-system.md",
    });
    const coach = agentRegistry.require("coach");
    expect(coach.label).toBe("Coach");
    expect(coach.scope).toBe("repository");
    expect(coach.cadence.defaultMinutes).toBe(60);
    expect(coach.limits.default).toEqual({ maxPerHour: 10, maxPending: 20 });
    expect(coach.detail.panel).toBe("cycles");
    expect(coach.tab).toEqual({ id: "coach", kind: "coach", title: "Coach" });
    expect(coach.prompt.kind).toBe("template");
    const releaseTrain = agentRegistry.require("release-train");
    expect(releaseTrain.label).toBe("Release Train");
    expect(releaseTrain.scope).toBe("repository");
    expect(releaseTrain.cadence.defaultMinutes).toBe(10);
    expect(releaseTrain.limits.default).toEqual({ maxPerHour: null, maxPending: null });
    expect(releaseTrain.detail.panel).toBe("activity");
    expect(releaseTrain.controls).toEqual({ pause: true, checkNow: true });
    expect(releaseTrain.tab).toEqual({
      id: "release-train",
      kind: "release-train",
      title: "Release Train",
    });
    expect(releaseTrain.prompt).toEqual({ kind: "file", file: "release-train.md" });
    for (const descriptor of DEFAULT_AGENT_DESCRIPTORS) {
      expect(descriptor.lifecycle).toEqual([...AGENT_LIFECYCLES]);
      expect(descriptor.commands.start).toBe("startAgent");
      expect(descriptor.commands.stop).toBe("stopAgent");
    }
  });

  test("refuses duplicate ids and an out-of-vocabulary lifecycle", () => {
    const scout = DEFAULT_AGENT_DESCRIPTORS[0]!;
    expect(() => defineAgentRegistry([scout, scout])).toThrow(AgentRegistryError);
    expect(() =>
      defineAgentRegistry([{ ...scout, lifecycle: ["running"] }]),
    ).toThrow(AgentRegistryError);
    expect(() =>
      defineAgentRegistry([{ ...scout, cadence: { ...scout.cadence, defaultMinutes: 0 } }]),
    ).toThrow(AgentRegistryError);
  });

  test("refuses a prompt that leaves the prompts directory or lacks its words", () => {
    const scout = DEFAULT_AGENT_DESCRIPTORS[0]!;
    for (const prompt of [
      { kind: "file", file: "../escape.md" },
      { kind: "file", file: "no-extension" },
      { kind: "file" },
      { kind: "absent", message: "" },
      { kind: "template", message: " " },
      { kind: "template" },
      { kind: "neither" },
    ]) {
      expect(() => defineAgentRegistry([{ ...scout, prompt }])).toThrow(AgentRegistryError);
    }
  });

  test("a synthetic extra descriptor is accepted by validation and projection", () => {
    const descriptor = syntheticDescriptor();
    const registry = defineAgentRegistry([...DEFAULT_AGENT_DESCRIPTORS, descriptor]);
    expect(registry.ids()).toEqual([
      "scout",
      "watchdog",
      "design",
      "coach",
      "api-standards",
      "release-train",
      "patrol",
    ]);
    const projected = projectAgentSnapshot(descriptor, snapshotInput(descriptor));
    expect(projected.id).toBe("patrol");
    expect(projected.label).toBe("Patrol");
    expect(projected.lifecycle).toBe("running");
  });

  test("projects only the declared documentation history, bounded and in order", () => {
    const design = agentRegistry.require("design");
    const entries = Array.from({ length: 25 }, (_, index) => ({
      at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      version: `0.1.${index}`,
      url: `https://example.test/releases/tag/v0.1.${index}`,
      summary: `Change ${index}`,
      files: ["DESIGN.md"],
      diff: `+change ${index}`,
    }));
    const projected = projectAgentSnapshot(design, {
      ...snapshotInput(design),
      detail: { panel: "activity", scanId: null, entries: [] },
      documentation: entries,
    });
    expect(projected.documentation).toHaveLength(20);
    expect(projected.documentation[0]?.summary).toBe("Change 0");
    expect(projected.documentation[19]?.version).toBe("0.1.19");
    const patrol = projectAgentSnapshot(
      syntheticDescriptor(),
      snapshotInput(syntheticDescriptor()),
    );
    expect(patrol.documentation).toEqual([]);
  });

  test("the shared sort puts filedAt newest first and breaks ties by URL", () => {
    const rows = snapshotInput(agentRegistry.require("scout")).issues;
    expect(sortAgentIssues(rows).map((row) => row.url)).toEqual([
      "https://example.test/issues/2",
      "https://example.test/issues/1",
      "https://example.test/issues/3",
    ]);
  });

  test("a synthetic adapter is listed and controlled through the same bridge", async () => {
    const descriptor = syntheticDescriptor();
    const registry = defineAgentRegistry([...DEFAULT_AGENT_DESCRIPTORS, descriptor]);
    const patrol = fakeAdapter(descriptor);
    const events: Array<Record<string, unknown>> = [];
    const bridge = new BackgroundAgentBridge({
      registry,
      adapters: [patrol],
      broadcast: (event) => events.push(event as Record<string, unknown>),
    });
    const target = { send: (data: string) => events.push(JSON.parse(data)) };
    bridge.replay(target);
    const state = events.find((event) => event.type === "agentsState");
    expect((state?.agents as Array<{ id: string }>).map((agent) => agent.id)).toEqual([
      "scout",
      "watchdog",
      "design",
      "coach",
      "api-standards",
      "release-train",
      "patrol",
    ]);
    await bridge.handle(target, { type: "startAgent", id: "patrol" });
    expect(patrol.starts).toBe(1);
    bridge.dispose();
  });

  test("an opened page refreshes the agent it names, without starting it", async () => {
    const descriptor = syntheticDescriptor();
    const scout = fakeAdapter(descriptor);
    const events: Array<Record<string, unknown>> = [];
    const bridge = new BackgroundAgentBridge({
      registry: defineAgentRegistry([descriptor]),
      adapters: [scout],
      broadcast: () => undefined,
    });
    const target = { send: (data: string) => events.push(JSON.parse(data)) };
    await bridge.handle(target, { type: "refreshAgent", id: "patrol" });
    expect(scout.syncs).toBe(1);
    expect(scout.starts).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["agentState"]);
    bridge.dispose();
  });

  test("an unknown id is refused by name and spawns nothing", async () => {
    const scout = fakeAdapter(agentRegistry.require("scout"));
    const events: Array<Record<string, unknown>> = [];
    const bridge = new BackgroundAgentBridge({
      registry: defineAgentRegistry([scout.descriptor]),
      adapters: [scout],
      broadcast: () => undefined,
    });
    const target = { send: (data: string) => events.push(JSON.parse(data)) };
    await bridge.handle(target, { type: "startAgent", id: "ghost" });
    expect(events).toEqual([
      { type: "error", message: "Unknown background agent: ghost." },
    ]);
    expect(scout.starts).toBe(0);
    bridge.dispose();
  });

  test("ships the seven discovery agents with one prompt file and command each", () => {
    expect(DISCOVER_AGENT_IDS).toEqual([
      "sheet",
      "discover-contribution",
      "discover-testing-strategy",
      "discover-naming-conventions",
      "discover-coding-conventions",
      "discover-architecture-boundaries",
      "discover-glossary",
    ]);
    expect(DISCOVER_AGENTS.map((descriptor) => descriptor.id)).toEqual([...DISCOVER_AGENT_IDS]);
    expect(DISCOVER_AGENTS.map((descriptor) => descriptor.label)).toEqual([
      "Data Sheet",
      "Contribution Agent",
      "Testing Strategy",
      "Naming Conventions",
      "Coding Conventions",
      "Architecture & Boundaries",
      "Glossary Agent",
    ]);
    expect(DISCOVER_RUN_ORDER).toEqual([
      "sheet",
      "discover-glossary",
      "discover-testing-strategy",
      "discover-naming-conventions",
      "discover-coding-conventions",
      "discover-architecture-boundaries",
      "discover-contribution",
    ]);
    const promptFiles = new Set(DISCOVER_AGENTS.map((descriptor) => descriptor.promptFile));
    const commands = new Set(DISCOVER_AGENTS.map((descriptor) => descriptor.command));
    expect(promptFiles.size).toBe(7);
    expect(commands.size).toBe(7);
    for (const descriptor of DISCOVER_AGENTS) {
      expect(descriptor.command).toBe(
        descriptor.id === "sheet" ? "/discover-sheet" : `/${descriptor.id}`,
      );
      expect(descriptor.promptFile).toBe(
        descriptor.id === "sheet" ? "discover-sheet.md" : `${descriptor.id}.md`,
      );
      expect(discoverAgent(descriptor.id)).toBe(descriptor);
      expect(isDiscoverAgentId(descriptor.id)).toBe(true);
    }
    const sheet = discoverAgent("sheet");
    expect(sheet?.skill).toBeNull();
    expect(sheet?.glossary).toBe(false);
    const glossary = discoverAgent("discover-glossary");
    expect(glossary?.skill).toBe("discover-glossary");
    expect(glossary?.glossary).toBe(true);
    const contribution = discoverAgent("discover-contribution");
    expect(contribution?.label).toBe("Contribution Agent");
    expect(contribution?.command).toBe("/discover-contribution");
    expect(contribution?.promptFile).toBe("discover-contribution.md");
    expect(contribution?.skill).toBe("discover-contribution");
    expect(contribution?.glossary).toBe(false);
    expect(isDiscoverAgentId("discover-sheet")).toBe(false);
    expect(isDiscoverAgentId(42)).toBe(false);
    expect(discoverAgent("ghost")).toBeUndefined();
  });

  test("lives only under the harness temporary directory", async () => {
    const root = await temporaryRoot();
    expect(root.startsWith(join(harnessRoot, ".tmp"))).toBe(true);
  });
});
