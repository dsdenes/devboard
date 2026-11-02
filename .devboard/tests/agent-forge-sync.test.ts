import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentRegistry, type AgentSnapshotInput } from "../server/agents/registry";
import type { AgentAdapter } from "../server/agents/types";
import { ScoutBridge } from "../server/scout";
import { DesignBridge } from "../server/design";
import { WatchdogActivity } from "../server/watchdog";
import { McpOptimizerActivity } from "../server/mcp-optimizer";
import type { ForgeIssueFact, ForgeIssueReader } from "../server/agents/forge-reader";
import {
  emptyState as emptyScoutState,
  writeState as writeScoutState,
  type ScoutIssueRow,
} from "../issues/scout/state";
import { statePath as scoutStatePath } from "../issues/scout/paths";
import {
  emptyState as emptyDesignState,
  writeState as writeDesignState,
  type DesignIssueRow,
} from "../issues/design/state";
import { statePath as designStatePath } from "../issues/design/paths";
import { saveLedger as saveWatchdogLedger, type Ledger } from "../watchdog/ledger";
import {
  saveLedger as saveMcpOptimizerLedger,
  emptyLedger as emptyMcpOptimizerLedger,
  type McpOptimizerLedger,
} from "../mcp-optimizer/ledger";
import { mcpOptimizerDirectory } from "../mcp-optimizer/paths";

/**
 * The four filed-issues tables share one forge read. These cases drive the
 * same injected sequence through every adapter: a stopped worker, a persisted
 * pending row, and a forge answer that closes it must render `implemented`
 * without a worker, a Start, or a reload.
 */

const harnessRoot = join(import.meta.dir, "..");
const repositories = ["acme/fixture", "acme/other"];
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; stateDir: string }> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", "agent-forge-"));
  directories.push(root);
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  return { root, stateDir };
}

interface FakeReader extends ForgeIssueReader {
  calls: number;
  /** The answer per repository URL; an absent URL is omitted from the answer. */
  facts: Map<string, ForgeIssueFact>;
  /** One thrown failure per attempt, consumed in order. */
  failures: string[];
  /** A failure every attempt uses until cleared. */
  failAll: string | null;
}

function fakeReader(facts: Record<string, Omit<ForgeIssueFact, "url">> = {}): FakeReader {
  const reader: FakeReader = {
    calls: 0,
    facts: new Map(Object.entries(facts).map(([url, fact]) => [url, { url, ...fact }])),
    failures: [],
    failAll: null,
    async project(urls: string[]): Promise<ForgeIssueFact[]> {
      reader.calls += 1;
      const failure = reader.failAll ?? reader.failures.shift() ?? null;
      if (failure !== null) throw new Error(failure);
      const answer: ForgeIssueFact[] = [];
      for (const url of urls) {
        const fact = reader.facts.get(url);
        if (fact !== undefined) answer.push(fact);
      }
      return answer;
    },
  };
  return reader;
}

interface RowSeed {
  url: string;
  title: string;
  createdAt: string;
  state: "pending" | "implemented";
  number: number;
}

function issue(number: number, overrides: Partial<RowSeed> = {}): RowSeed {
  return {
    number,
    url: `https://github.com/acme/fixture/issues/${number}`,
    title: `Issue ${number}`,
    createdAt: `2026-10-0${number % 9}T00:00:00.000Z`,
    state: "pending",
    ...overrides,
  };
}

function seedScout(root: string, stateDir: string, rows: RowSeed[]): string {
  const state = emptyScoutState({ repo: repositories[0]!, root });
  state.issues = rows.map(
    (row): ScoutIssueRow => ({
      number: row.number,
      title: row.title,
      url: row.url,
      createdAt: row.createdAt,
      state: row.state,
      category: "clarity",
      version: null,
      versionAttemptAt: null,
      versionError: null,
    }),
  );
  state.updatedAt = new Date().toISOString();
  const path = scoutStatePath(stateDir, root);
  writeScoutState(path, state);
  return path;
}

function seedDesign(root: string, stateDir: string, rows: RowSeed[]): string {
  const state = emptyDesignState({ repo: repositories[0]!, root });
  state.issues = rows.map(
    (row): DesignIssueRow => ({
      number: row.number,
      title: row.title,
      url: row.url,
      createdAt: row.createdAt,
      state: row.state,
      category: "tokens",
      version: null,
    }),
  );
  state.updatedAt = new Date().toISOString();
  const path = designStatePath(stateDir, root);
  writeDesignState(path, state);
  return path;
}

function seedWatchdog(root: string, _stateDir: string, rows: RowSeed[]): string {
  const directory = join(root, "watchdog");
  const ledger: Ledger = { version: 2, findings: {}, pendingFiling: [] };
  for (const row of rows) {
    ledger.findings[`fingerprint-${row.number}`] = {
      category: "server-error",
      line: row.title,
      firstSeen: row.createdAt,
      lastSeen: row.createdAt,
      count: 1,
      disposition: `filed:${row.url}`,
      url: row.url,
      filedAt: row.createdAt,
      instances: [],
    };
  }
  saveWatchdogLedger(directory, ledger);
  return join(directory, "state.json");
}

function seedMcpOptimizer(_root: string, stateDir: string, rows: RowSeed[]): string {
  const mcpOptimizerDir = mcpOptimizerDirectory(stateDir);
  const ledger: McpOptimizerLedger = emptyMcpOptimizerLedger();
  for (const row of rows) {
    const family = `family-${row.number}`;
    ledger.families[family] = {
      firstSeen: row.createdAt,
      lastSeen: row.createdAt,
      calls: 1,
      sessions: 1,
      kind: "command",
      lastAction: "filed",
      lastIssueUrl: row.url,
      lastTitle: row.title,
      lastFiledAt: row.createdAt,
    };
  }
  saveMcpOptimizerLedger(mcpOptimizerDir, ledger);
  return join(mcpOptimizerDir, "state.json");
}

interface Harness {
  adapter: AgentAdapter;
  /** The bytes of the adapter's persisted worker state. */
  stateFile: string;
}

function scoutAdapter(
  root: string,
  stateDir: string,
  reader: ForgeIssueReader,
  options: { hasClients: () => boolean; now: () => number; onSpawn?: () => void },
): Harness {
  const adapter = new ScoutBridge({
    descriptor: agentRegistry.require("scout"),
    repoDir: root,
    stateDir,
    agentCommand: "stub",
    agentEnvironment: async () => ({}),
    runningVersion: "0.0.0-test",
    harnessDir: harnessRoot,
    send: () => undefined,
    pollMs: 60_000,
    now: options.now,
    reader,
    hasClients: options.hasClients,
    spawnWorker: () => {
      options.onSpawn?.();
      return undefined;
    },
  });
  return { adapter, stateFile: scoutStatePath(stateDir, root) };
}

function designAdapter(
  root: string,
  stateDir: string,
  reader: ForgeIssueReader,
  options: { hasClients: () => boolean; now: () => number; onSpawn?: () => void },
): Harness {
  const adapter = new DesignBridge({
    descriptor: agentRegistry.require("design"),
    repoDir: root,
    stateDir,
    agentCommand: "stub",
    agentEnvironment: async () => ({}),
    runningVersion: "0.0.0-test",
    harnessDir: harnessRoot,
    send: () => undefined,
    pollMs: 60_000,
    now: options.now,
    reader,
    hasClients: options.hasClients,
    spawnWorker: () => {
      options.onSpawn?.();
      return undefined;
    },
  });
  return { adapter, stateFile: designStatePath(stateDir, root) };
}

function watchdogAdapter(
  root: string,
  stateDir: string,
  reader: ForgeIssueReader,
  options: { hasClients: () => boolean; now: () => number; onSpawn?: () => void },
): Harness {
  const watchdogDir = join(root, "watchdog");
  const adapter = new WatchdogActivity({
    descriptor: agentRegistry.require("watchdog"),
    repoDir: root,
    stateDir,
    harnessDir: harnessRoot,
    watchdogDir,
    send: () => undefined,
    now: options.now,
    reader,
    hasClients: options.hasClients,
    spawnWorker: () => {
      options.onSpawn?.();
      return undefined;
    },
  });
  return { adapter, stateFile: join(watchdogDir, "state.json") };
}

function mcpOptimizerAdapter(
  root: string,
  stateDir: string,
  reader: ForgeIssueReader,
  options: { hasClients: () => boolean; now: () => number; onSpawn?: () => void },
): Harness {
  const adapter = new McpOptimizerActivity({
    descriptor: agentRegistry.require("mcp-optimizer"),
    repoDir: root,
    stateDir,
    harnessDir: harnessRoot,
    send: () => undefined,
    now: options.now,
    reader,
    hasClients: options.hasClients,
    spawnWorker: () => {
      options.onSpawn?.();
      return undefined;
    },
  });
  return { adapter, stateFile: join(mcpOptimizerDirectory(stateDir), "state.json") };
}

const adapters = [
  { name: "Auto Scout", seed: seedScout, build: scoutAdapter },
  { name: "Watchdog", seed: seedWatchdog, build: watchdogAdapter },
  { name: "Design System", seed: seedDesign, build: designAdapter },
  { name: "MCP optimizer", seed: seedMcpOptimizer, build: mcpOptimizerAdapter },
] as const;

type AdapterFactory = (
  root: string,
  stateDir: string,
  reader: ForgeIssueReader,
  options: { hasClients: () => boolean; now: () => number; onSpawn?: () => void },
) => Harness;

async function firstState(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

interface SettlingAdapter {
  settled(): Promise<void>;
}

function isSettling(adapter: AgentAdapter): adapter is AgentAdapter & SettlingAdapter {
  return "settled" in adapter && typeof adapter.settled === "function";
}

async function readOnce(adapter: AgentAdapter): Promise<AgentSnapshotInput> {
  const snapshot = adapter.snapshot();
  if (isSettling(adapter)) await adapter.settled();
  return snapshot;
}

function issueStates(snapshot: AgentSnapshotInput): Array<string | null> {
  return snapshot.issues.map((row) => row.state);
}

function firstRow(snapshot: AgentSnapshotInput, url: string) {
  return snapshot.issues.find((row) => row.url === url);
}

describe("all four filed-issues tables share one forge read", () => {
  for (const entry of adapters) {
    const build = entry.build as AdapterFactory;

    test(`${entry.name}: a closed read turns a stopped worker's pending row into implemented`, async () => {
      const { root, stateDir } = await workspace();
      const row = issue(1);
      const stateFile = entry.seed(root, stateDir, [row]);
      const before = await firstState(stateFile);
      let spawns = 0;
      const clock = { now: 1_000_000 };
      const reader = fakeReader({
        [row.url]: { state: "implemented", version: "v1.2.0" },
      });
      const { adapter } = build(root, stateDir, reader, {
        hasClients: () => true,
        now: () => clock.now,
        onSpawn: () => {
          spawns += 1;
        },
      });
      await readOnce(adapter);
      const snapshot = adapter.snapshot();
      expect(snapshot.lifecycle).toBe("stopped");
      expect(snapshot.issues).toHaveLength(1);
      expect(firstRow(snapshot, row.url)).toMatchObject({
        url: row.url,
        state: "implemented",
        version: "v1.2.0",
      });
      expect(snapshot.sync.state).toBe("ok");
      expect(snapshot.sync.at).toBe(new Date(clock.now).toISOString());
      expect(spawns).toBe(0);
      expect(await firstState(stateFile)).toBe(before);
      adapter.dispose();
    });

    test(`${entry.name}: a closure reaches an already served table on the next 60-second read`, async () => {
      const { root, stateDir } = await workspace();
      const row = issue(2, { url: `https://github.com/acme/fixture/issues/2` });
      entry.seed(root, stateDir, [row]);
      const clock = { now: 2_000_000 };
      const reader = fakeReader({ [row.url]: { state: "pending", version: null } });
      const { adapter } = build(root, stateDir, reader, {
        hasClients: () => true,
        now: () => clock.now,
      });
      await readOnce(adapter);
      expect(issueStates(adapter.snapshot())).toEqual(["pending"]);

      reader.facts.set(row.url, { url: row.url, state: "implemented", version: null });
      clock.now += 59_000;
      adapter.snapshot();
      expect(reader.calls).toBe(1);
      expect(issueStates(adapter.snapshot())).toEqual(["pending"]);

      clock.now += 1_000;
      await readOnce(adapter);
      expect(reader.calls).toBe(2);
      const closed = adapter.snapshot();
      expect(issueStates(closed)).toEqual(["implemented"]);
      expect(closed.sync.at).toBe(new Date(clock.now).toISOString());
      adapter.dispose();
    });

    test(
      `${entry.name}: a closed issue with no resolved release stays implemented with no version`,
      async () => {
        const { root, stateDir } = await workspace();
        const row = issue(3);
        entry.seed(root, stateDir, [row]);
        const reader = fakeReader({ [row.url]: { state: "implemented", version: null } });
        const { adapter } = build(root, stateDir, reader, {
          hasClients: () => true,
          now: () => 3_000_000,
        });
        await readOnce(adapter);
        const snapshot = adapter.snapshot();
        expect(firstRow(snapshot, row.url)).toMatchObject({
          state: "implemented",
          version: null,
        });
        adapter.dispose();
      },
    );

    test(`${entry.name}: a successful read that omits an issue removes its row and its count`, async () => {
      const { root, stateDir } = await workspace();
      const kept = issue(4);
      const dropped = issue(5);
      entry.seed(root, stateDir, [kept, dropped]);
      const reader = fakeReader({ [kept.url]: { state: "pending", version: null } });
      const { adapter } = build(root, stateDir, reader, {
        hasClients: () => true,
        now: () => 4_000_000,
      });
      await readOnce(adapter);
      const snapshot = adapter.snapshot();
      expect(snapshot.issues.map((row) => row.url)).toEqual([kept.url]);
      expect(snapshot.issues).toHaveLength(1);
      expect(snapshot.pending === 0 || snapshot.pending === 1).toBe(true);
      adapter.dispose();
    });

    test(`${entry.name}: no client makes no read, and a stale page open starts exactly one`, async () => {
      const { root, stateDir } = await workspace();
      const row = issue(6);
      entry.seed(root, stateDir, [row]);
      let clients = false;
      const clock = { now: 5_000_000 };
      const reader = fakeReader({ [row.url]: { state: "pending", version: null } });
      const { adapter } = build(root, stateDir, reader, {
        hasClients: () => clients,
        now: () => clock.now,
      });
      for (let index = 0; index < 5; index += 1) {
        adapter.snapshot();
        clock.now += 60_000;
      }
      expect(reader.calls).toBe(0);

      clients = true;
      adapter.requestSync();
      await readOnce(adapter);
      expect(reader.calls).toBe(1);

      clock.now += 30_000;
      adapter.snapshot();
      adapter.requestSync();
      expect(reader.calls).toBe(1);

      clock.now += 30_000;
      await readOnce(adapter);
      expect(reader.calls).toBe(2);
      adapter.dispose();
    });

    test(
      `${entry.name}: a transient failure keeps rows and time; a permanent one surfaces at once`,
      async () => {
        const { root, stateDir } = await workspace();
        const row = issue(7);
        entry.seed(root, stateDir, [row]);
        const clock = { now: 6_000_000 };
        const reader = fakeReader({ [row.url]: { state: "pending", version: null } });
        const { adapter } = build(root, stateDir, reader, {
          hasClients: () => true,
          now: () => clock.now,
        });
        await readOnce(adapter);
        const successAt = clock.now;
        const rows = adapter.snapshot().issues;

        reader.failures.push("gh: HTTP 503: Service Unavailable");
        clock.now += 60_000;
        await readOnce(adapter);
        const retrying = adapter.snapshot();
        expect(retrying.sync).toEqual({
          state: "stale",
          at: new Date(successAt).toISOString(),
          error: null,
        });
        expect(retrying.issues).toEqual(rows);

        reader.failAll = "gh: HTTP 401: Bad credentials";
        clock.now += 60_000;
        await readOnce(adapter);
        const failed = adapter.snapshot();
        expect(failed.sync.state).toBe("error");
        expect(failed.sync.error).toContain("Bad credentials");
        expect(failed.issues).toEqual(rows);
        expect(failed.error).toBeNull();
        adapter.dispose();
      },
    );
  }

  test("all four publish the same sync state and rows for one injected read sequence", async () => {
    const sequence = [
      { kind: "success", facts: { state: "pending", version: null } },
      { kind: "failure", message: "gh: HTTP 502: Bad Gateway" },
      { kind: "success", facts: { state: "implemented", version: "v2.0.0" } },
      { kind: "failure", message: "You have exceeded a secondary rate limit." },
    ] as const;
    const observed: Array<{
      name: string;
      states: Array<{ state: string; error: string | null }>;
      rows: string[][];
    }> = [];
    for (const entry of adapters) {
      const build = entry.build as AdapterFactory;
      const { root, stateDir } = await workspace();
      const row = issue(8);
      entry.seed(root, stateDir, [row]);
      const clock = { now: 7_000_000 };
      const reader = fakeReader({ [row.url]: { state: "pending", version: null } });
      const { adapter } = build(root, stateDir, reader, {
        hasClients: () => true,
        now: () => clock.now,
      });
      const states: Array<{ state: string; error: string | null }> = [];
      const rows: string[][] = [];
      for (const step of sequence) {
        if (step.kind === "failure") {
          reader.failAll = step.message;
        } else {
          reader.failAll = null;
          reader.facts.set(row.url, { url: row.url, ...step.facts });
        }
        clock.now += 60_000;
        await readOnce(adapter);
        const snapshot = adapter.snapshot();
        states.push({ state: snapshot.sync.state, error: snapshot.sync.error });
        rows.push(snapshot.issues.map((issueRow) => issueRow.state));
      }
      observed.push({ name: entry.name, states, rows });
      adapter.dispose();
    }
    for (const entry of observed.slice(1)) {
      expect(entry.states).toEqual(observed[0]!.states);
      expect(entry.rows).toEqual(observed[0]!.rows);
    }
    expect(observed[0]!.states).toEqual([
      { state: "ok", error: null },
      { state: "stale", error: null },
      { state: "ok", error: null },
      { state: "error", error: expect.stringContaining("rate limit") },
    ]);
    expect(observed[0]!.rows).toEqual([["pending"], ["pending"], ["implemented"], ["implemented"]]);
  });
});
