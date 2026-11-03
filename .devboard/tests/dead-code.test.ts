import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ENTRY_POINT_SURFACES,
  EntryPointError,
  deadCodePool,
  eligibleFiles,
  pickEntryPoint,
  scoutPool,
  walkRegularFiles,
} from "../lib/entry-point";
import type {
  DeadCodeForgeClient,
  DeadCodeForgeIssue,
  DeadCodeRelease,
} from "../issues/dead-code/forge";
import { writeCommand } from "../issues/dead-code/control";
import { DeadCodeWorker, RESOLUTION_RETRY_MS } from "../issues/dead-code/worker";
import {
  cyclesDirectory,
  DEFAULT_INTERVAL_MINUTES,
  DEAD_CODE_CATEGORIES,
  DEAD_CODE_LABEL,
  requestPath,
  settingsPath,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
} from "../issues/dead-code/paths";
import {
  DEFAULT_SETTINGS,
  capacityFor,
  emptyState,
  parseState,
  readSettings,
  readState,
  writeSettings,
  type DeadCodeIssueRow,
} from "../issues/dead-code/state";
import { agentRegistry } from "../server/agents/registry";
import { MCP_TOOL_NAMES } from "../mcp/catalog";
import { callTool } from "../mcp/tools";
import type { McpContext } from "../mcp/context";
import type { AcpPeer, IssuesPeerOptions } from "../issues/worker";

const harnessRoot = join(import.meta.dir, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function temporaryRoot(name: string): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", `dead-code-${name}-`));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("entry point picker", () => {
  test("ships exactly the three surfaces", () => {
    expect([...ENTRY_POINT_SURFACES]).toEqual(["scout", "design", "dead-code"]);
  });

  test("the same seed and surface return the identical path and line", async () => {
    const root = await temporaryRoot("deterministic");
    write(join(root, "one.ts"), "export const one = 1;\n");
    write(join(root, "two.ts"), "export const two = 2;\n");
    write(join(root, "README.md"), "# Fixture\n");
    const first = pickEntryPoint({ repoDir: root, surface: "scout", seed: "fixed-seed" });
    const second = pickEntryPoint({ repoDir: root, surface: "scout", seed: "fixed-seed" });
    expect(second).toEqual(first);
    expect(existsSync(join(root, first.path))).toBe(true);
    expect(first.line).toBeGreaterThan(0);
    expect(first.surface).toBe("scout");
    expect(first.seed).toBe("fixed-seed");
  });

  test("an omitted seed is returned and replays the same pick", async () => {
    const root = await temporaryRoot("fresh-seed");
    write(join(root, "one.ts"), "export const one = 1;\n");
    write(join(root, "two.ts"), "export const two = 2;\n");
    const fresh = pickEntryPoint({ repoDir: root, surface: "dead-code" });
    expect(fresh.seed.length).toBeGreaterThan(0);
    const replay = pickEntryPoint({
      repoDir: root,
      surface: "dead-code",
      seed: fresh.seed,
    });
    expect(replay.path).toBe(fresh.path);
    expect(replay.line).toBe(fresh.line);
  });

  test("ten fresh seeds reach at least two entry points", async () => {
    const root = await temporaryRoot("freshness");
    write(join(root, "one.ts"), "export const one = 1;\n");
    write(join(root, "two.ts"), "export const two = 2;\n");
    const paths = new Set(
      Array.from({ length: 10 }, () =>
        pickEntryPoint({ repoDir: root, surface: "scout" }).path,
      ),
    );
    expect(paths.size).toBeGreaterThanOrEqual(2);
  });

  test("refuses an unknown surface, an empty pool, and leaves no trace", async () => {
    const root = await temporaryRoot("refusal");
    write(join(root, "one.ts"), "export const one = 1;\n");
    const before = readdirSync(root).sort();
    expect(() => pickEntryPoint({ repoDir: root, surface: "nope", seed: "s" })).toThrow(
      EntryPointError,
    );
    expect(readdirSync(root).sort()).toEqual(before);
    const empty = await temporaryRoot("empty");
    expect(() => pickEntryPoint({ repoDir: empty, surface: "dead-code" })).toThrow(
      EntryPointError,
    );
    expect(() => pickEntryPoint({ repoDir: join(empty, "missing"), surface: "scout" })).toThrow(
      EntryPointError,
    );
  });

  test("the scout pool excludes generated, vendored, temporary, and worktree trees", async () => {
    const root = await temporaryRoot("pools");
    write(join(root, "kept.ts"), "export const kept = 1;\n");
    write(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    write(join(root, "dist", "bundle.js"), "console.log(1);\n");
    write(join(root, ".worktree", "task", "file.ts"), "export const w = 1;\n");
    write(join(root, ".tmp", "file.txt"), "temporary\n");
    write(join(root, ".devboard", ".tmp", "state.json"), "{}\n");
    write(join(root, ".git", "config"), "[core]\n");
    write(join(root, "binary.bin"), "a\u0000b");
    expect(scoutPool(root)).toEqual(["kept.ts"]);
  });

  test("the walk names every directory it cannot read instead of shrinking the pool", async () => {
    const root = await temporaryRoot("unreadable");
    write(join(root, "kept.ts"), "export const kept = 1;\n");
    write(join(root, "zeta", "deep", "three.ts"), "export const three = 3;\n");
    write(join(root, "blocked", "hidden.ts"), "export const hidden = 1;\n");
    expect(walkRegularFiles(root)).toEqual([
      "blocked/hidden.ts",
      "kept.ts",
      "zeta/deep/three.ts",
    ]);

    const failures = new Map([
      [join(root, "blocked"), "EACCES: permission denied"],
      [join(root, "zeta", "deep"), "EIO: i/o error"],
    ]);
    const reader = (directory: string) => {
      const failure = failures.get(directory);
      if (failure !== undefined) throw new Error(failure);
      return readdirSync(directory, { withFileTypes: true });
    };
    let caught: unknown;
    try {
      walkRegularFiles(root, reader);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EntryPointError);
    expect((caught as Error).message).toBe(
      "the repository directories blocked, zeta/deep are not readable: " +
        "blocked: EACCES: permission denied; zeta/deep: EIO: i/o error",
    );

    const oneFailure = (directory: string) => {
      if (directory === join(root, "blocked")) throw new Error("EACCES: permission denied");
      return readdirSync(directory, { withFileTypes: true });
    };
    let single: unknown;
    try {
      walkRegularFiles(root, oneFailure);
    } catch (error) {
      single = error;
    }
    expect(single).toBeInstanceOf(EntryPointError);
    expect((single as Error).message).toBe(
      "the repository directory blocked is not readable: blocked: EACCES: permission denied",
    );
  });

  test("the catalog holds one read-only entry-point tool", async () => {
    expect(MCP_TOOL_NAMES.filter((name) => name.includes("entry"))).toEqual(["entry_point"]);
    const root = await temporaryRoot("read-only");
    write(join(root, "one.ts"), "export const one = 1;\n");
    const log = join(root, "tool-log.jsonl");
    const context: McpContext = {
      repoDir: root,
      harnessDir: harnessRoot,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment: { DEVBOARD_TOOL_LOG: log },
    };
    const picked = await callTool(context, "entry_point", { surface: "scout", seed: "fixed" });
    expect(picked.error).toBeUndefined();
    expect(existsSync(log)).toBe(false);
    const refused = await callTool(context, "entry_point", { surface: "unknown" });
    expect(refused.error).toBeDefined();
    expect(existsSync(log)).toBe(false);
  });

  test("the dead-code pool discovers the extensions the host uses", async () => {
    const root = await temporaryRoot("extensions");
    write(join(root, "one.rb"), "def one\n  1\nend\n");
    write(join(root, "two.rb"), "def two\n  2\nend\n");
    write(join(root, "notes.md"), "# Notes\n");
    expect(deadCodePool(root)).toEqual(["one.rb", "two.rb"]);
    expect(eligibleFiles(root, "dead-code")).toEqual(["one.rb", "two.rb"]);
  });
});

function issueRow(overrides: Partial<DeadCodeIssueRow> = {}): DeadCodeIssueRow {
  return {
    number: 1,
    title: "Remove dead fixture code",
    url: "https://github.com/acme/fixture/issues/1",
    createdAt: new Date().toISOString(),
    state: "pending",
    category: "unreferenced-symbol",
    version: null,
    versionAttemptAt: null,
    versionError: null,
    ...overrides,
  };
}

class FakeForge implements DeadCodeForgeClient {
  readonly issues: DeadCodeForgeIssue[] = [];
  openTitles: string[] = [];
  /** Set by a test that holds the forge read open until it settles. */
  hold: Promise<void> | undefined;
  /** Resolves once the held read has been requested. */
  holding: (() => void) | undefined;

  async listIssues(): Promise<DeadCodeForgeIssue[]> {
    const holding = this.holding;
    this.holding = undefined;
    holding?.();
    if (this.hold !== undefined) await this.hold;
    return [...this.issues];
  }

  async listOpenIssueTitles(): Promise<string[]> {
    return [...this.openTitles];
  }

  async listReleases(): Promise<[]> {
    return [];
  }

  async closingCommit(): Promise<null> {
    return null;
  }

  async resolveCommit(): Promise<null> {
    return null;
  }

  async containingReleaseTags(): Promise<string[]> {
    return [];
  }
}

/** A forge whose one closed issue names a commit that releases may contain. */
class ResolvingForge implements DeadCodeForgeClient {
  readonly issues: DeadCodeForgeIssue[] = [];
  readonly releases: DeadCodeRelease[] = [];
  closingCalls = 0;
  resolveCalls = 0;
  readonly commit = "0123456789abcdef0123456789abcdef01234567";

  async listIssues(): Promise<DeadCodeForgeIssue[]> {
    return [...this.issues];
  }

  async listOpenIssueTitles(): Promise<string[]> {
    return [];
  }

  async listReleases(): Promise<DeadCodeRelease[]> {
    return [...this.releases];
  }

  async closingCommit(): Promise<string> {
    return this.commit;
  }

  async closingCommits(): Promise<string[]> {
    this.closingCalls += 1;
    return [this.commit];
  }

  async resolveCommit(): Promise<string> {
    this.resolveCalls += 1;
    return this.commit;
  }

  async containingReleaseTags(
    _commit: string,
    releases: DeadCodeRelease[],
  ): Promise<string[]> {
    return releases.map((release) => release.tag);
  }
}

function closedIssue(number: number): DeadCodeForgeIssue {
  return {
    number,
    title: "Remove dead fixture code",
    url: `https://github.com/acme/fixture/issues/${number}`,
    state: "closed",
    createdAt: "2026-01-01T00:00:00Z",
    closedAt: "2026-01-01T00:00:00Z",
    body: "## Category\n\nunreferenced-symbol\n\n## Evidence\n\n- `src/a.ts:1-1`\n",
  };
}

function fileIssue(forge: FakeForge, directory: string, title: string): void {
  const number = forge.issues.length + 1;
  const body = "## Category\n\nunreferenced-symbol\n\n## Evidence\n\n- `src/a.ts:1-1`\n";
  forge.issues.push({
    number,
    title,
    url: `https://github.com/acme/fixture/issues/${number}`,
    state: "open",
    createdAt: new Date().toISOString(),
    closedAt: null,
    body,
  });
  writeFileSync(
    join(directory, "tool-log.jsonl"),
    `${JSON.stringify({
      tool: "issue_create",
      ok: true,
      value: { number, title, labels: [DEAD_CODE_LABEL] },
    })}\n`,
  );
}

function peerFor(
  forge: FakeForge,
  onRequest?: (request: Record<string, unknown>, directory: string) => void,
  hold?: Promise<void>,
): (options: IssuesPeerOptions) => AcpPeer {
  return () => ({
    pid: undefined,
    argv: [],
    async run(prompt: string): Promise<unknown> {
      const directory = prompt.slice("/dead-code-removal ".length);
      const request = JSON.parse(readFileSync(requestPath(directory), "utf8")) as Record<
        string,
        unknown
      >;
      onRequest?.(request, directory);
      if (hold !== undefined) await hold;
      if (Number(request.issueRoom) > 0) fileIssue(forge, directory, "Remove dead fixture code");
      return {};
    },
    async prompt(): Promise<unknown> {
      return {};
    },
    answer(): boolean {
      return true;
    },
    close(): void {},
  });
}

describe("dead-code descriptor", () => {
  test("declares the label, categories, cadence, and defaults", () => {
    const descriptor = agentRegistry.require("dead-code");
    expect(descriptor.label).toBe("Dead Code");
    expect(descriptor.scope).toBe("repository");
    expect(descriptor.cadence.defaultMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(descriptor.limits.default).toEqual({ maxPerHour: 10, maxPending: 5 });
    expect(DEAD_CODE_LABEL).toBe("dead-code");
    expect([...DEAD_CODE_CATEGORIES]).toEqual([
      "unreferenced-file",
      "unreferenced-symbol",
      "unreachable-branch",
      "unused-dependency",
      "unmatched-selector",
    ]);
    expect(descriptor.prompt).toEqual({ kind: "file", file: "dead-code-removal.md" });
  });

  test("the capacity is the smaller room, capped at 100", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const rows = Array.from({ length: 4 }, (_value, index) =>
      issueRow({ number: index + 1, createdAt: "2026-01-01T11:30:00Z" }),
    );
    expect(
      capacityFor(rows, { maxPerHour: 10, maxPending: 5 }, now).batch,
    ).toBe(1);
    expect(
      capacityFor([], { maxPerHour: null, maxPending: null }, now).batch,
    ).toBe(100);
    expect(capacityFor([], { maxPerHour: 1, maxPending: 1 }, now).batch).toBe(1);
  });

  test("state parsing refuses a foreign version and keeps the defaults", () => {
    const state = emptyState({ repo: "acme/fixture", root: "/fixture" });
    expect(parseState(JSON.stringify(state))?.limits).toEqual({ maxPerHour: 10, maxPending: 5 });
    expect(
      parseState(JSON.stringify({ ...state, version: 99 })),
    ).toBeUndefined();
  });
});

describe("dead-code shipped version", () => {
  async function resolvingWorker(name: string) {
    const root = await temporaryRoot(name);
    const repo = join(root, "repo");
    write(join(repo, "src", "a.ts"), "export const dead = 1;\n");
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new ResolvingForge();
    forge.issues.push(closedIssue(1));
    const clock = { now: new Date("2026-01-01T00:00:00Z") };
    const worker = new DeadCodeWorker({
      repoDir: repo,
      stateDir,
      manualCycles: true,
      syncMs: 60_000,
      cadenceMs: 60 * 60_000,
      // The ticker never fires: each test drives the sync it asserts.
      tickMs: 60 * 60_000,
      now: () => clock.now,
      harnessVersion: "test",
      github: forge,
      connect: peerFor(new FakeForge()),
    });
    expect(worker.start("acme/fixture")).toBe(true);
    return { worker, forge, clock, stateDir, repo };
  }

  test("an unchanged release list resolves the closed issue only once", async () => {
    const { worker, forge, stateDir, repo } = await resolvingWorker("version-once");
    await worker.refresh();
    const first = worker.currentState.issues[0]!;
    expect(first.state).toBe("implemented");
    expect(first.version).toBeNull();
    expect(first.versionError).toBe(`no published release contains ${forge.commit}`);
    expect(first.versionAttemptAt).toBe("2026-01-01T00:00:00.000Z");
    expect(forge.closingCalls).toBe(1);

    await worker.refresh();
    expect(forge.closingCalls).toBe(1);
    expect(forge.resolveCalls).toBe(1);
    expect(worker.currentState.issues[0]).toEqual(first);

    const persisted = readState(versionedStatePath(stateDir, repo, "test"));
    expect(persisted?.issues[0]?.version).toBeNull();
    expect(persisted?.issues[0]?.versionError).toBe(
      `no published release contains ${forge.commit}`,
    );
    await worker.stop();
  });

  test("a release the failed attempt did not see fills the row and clears the reason", async () => {
    const { worker, forge } = await resolvingWorker("version-release");
    await worker.refresh();
    expect(worker.currentState.issues[0]?.version).toBeNull();

    forge.releases.push({ tag: "v0.1.0", publishedAt: "2026-01-01T00:00:30Z" });
    await worker.refresh();

    const row = worker.currentState.issues[0]!;
    expect(row.version).toBe("v0.1.0");
    expect(row.versionError).toBeNull();
    expect(forge.closingCalls).toBe(2);
    await worker.stop();
  });

  test("an unchanged release list retries only after the bounded backoff", async () => {
    const { worker, forge, clock } = await resolvingWorker("version-backoff");
    await worker.refresh();
    const started = Date.parse("2026-01-01T00:00:00Z");

    clock.now = new Date(started + RESOLUTION_RETRY_MS - 1);
    await worker.refresh();
    expect(forge.closingCalls).toBe(1);

    clock.now = new Date(started + RESOLUTION_RETRY_MS);
    await worker.refresh();
    expect(forge.closingCalls).toBe(2);
    await worker.stop();
  });
});

describe("dead-code worker", () => {
  test("one cycle runs from a seeded entry point and records one filed issue", async () => {
    const root = await temporaryRoot("cycle");
    const repo = join(root, "repo");
    write(join(repo, "src", "a.ts"), "export const dead = 1;\nexport const live = 2;\n");
    write(join(repo, "GOAL.md"), "# Goal\n");
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    let seen: Record<string, unknown> | undefined;
    const clock = { now: new Date("2026-01-01T12:00:00Z") };
    const worker = new DeadCodeWorker({
      repoDir: repo,
      stateDir,
      manualCycles: true,
      syncMs: 60_000,
      cadenceMs: 60 * 60_000,
      now: () => clock.now,
      harnessVersion: "test",
      github: forge,
      connect: peerFor(forge, (request) => {
        seen = request;
      }),
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();

    const state = worker.currentState;
    expect(state.issues.map((issue) => issue.number)).toEqual([1]);
    expect(state.lifecycle).toBe("idle");
    expect(state.issues[0]?.category).toBe("unreferenced-symbol");
    expect(seen?.surface).toBe("dead-code");
    expect(typeof seen?.seed).toBe("string");
    expect(seen?.issueRoom).toBe(5);
    const entryPoint = seen?.entryPoint as { path: string; line: number };
    expect(existsSync(join(repo, entryPoint.path))).toBe(true);
    const replay = pickEntryPoint({
      repoDir: repo,
      surface: "dead-code",
      seed: seen?.seed as string,
    });
    expect(replay.path).toBe(entryPoint.path);
    expect(replay.line).toBe(entryPoint.line);

    const cycleIds = readdirSync(cyclesDirectory(repo)).sort();
    expect(cycleIds.length).toBe(1);
    const cycleDir = join(cyclesDirectory(repo), cycleIds[0]!);
    const activity = readFileSync(join(cycleDir, "activity.json"), "utf8");
    expect(activity).toContain(entryPoint.path);
    expect(activity).toContain(seen?.seed as string);
    expect(activity).toContain("filed #1");

    const persisted = readSettings(settingsPath(stateDir, repo));
    expect(persisted).toBeUndefined();
    expect(readState(statePath(stateDir, repo))).toBeUndefined();
    await worker.stop();
    expect(worker.currentState.lifecycle).toBe("stopped");
    expect(worker.currentState.issues.map((issue) => issue.number)).toEqual([1]);
  });

  test("the cadence blocks a second cycle and a zero room files nothing", async () => {
    const root = await temporaryRoot("cadence");
    const repo = join(root, "repo");
    write(join(repo, "src", "a.ts"), "export const dead = 1;\n");
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    let rooms: number[] = [];
    const clock = { now: new Date("2026-01-01T12:00:00Z") };
    const worker = new DeadCodeWorker({
      repoDir: repo,
      stateDir,
      manualCycles: true,
      syncMs: 60_000,
      cadenceMs: 60 * 60_000,
      now: () => clock.now,
      harnessVersion: "test",
      github: forge,
      connect: peerFor(forge, (request) => {
        rooms.push(Number(request.issueRoom));
      }),
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(readdirSync(cyclesDirectory(repo)).length).toBe(1);

    clock.now = new Date("2026-01-01T12:30:00Z");
    await worker.tickNow();
    expect(readdirSync(cyclesDirectory(repo)).length).toBe(1);

    await worker.stop();
    expect(rooms).toEqual([5]);
  });

  test("a cycle with no filing room records the skip", async () => {
    const root = await temporaryRoot("zero-room");
    const repo = join(root, "repo");
    write(join(repo, "src", "a.ts"), "export const dead = 1;\n");
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    for (let index = 1; index <= 5; index += 1) {
      forge.issues.push({
        number: index,
        title: `Open dead-code finding ${index}`,
        url: `https://github.com/acme/fixture/issues/${index}`,
        state: "open",
        createdAt: new Date().toISOString(),
        closedAt: null,
        body: "## Category\n\nunreferenced-symbol\n",
      });
    }
    const worker = new DeadCodeWorker({
      repoDir: repo,
      stateDir,
      manualCycles: true,
      syncMs: 60_000,
      cadenceMs: 60 * 60_000,
      now: () => new Date("2026-01-01T12:00:00Z"),
      harnessVersion: "test",
      github: forge,
      connect: peerFor(forge),
    });
    expect(worker.start("acme/fixture")).toBe(true);
    writeSettings(settingsPath(stateDir, repo), {
      maxPerHour: 10,
      maxPending: 5,
      intervalMinutes: 60,
    });
    await worker.refresh();
    expect(worker.currentState.issues.length).toBe(5);
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(forge.issues.length).toBe(5);
    const cycleIds = readdirSync(cyclesDirectory(repo)).sort();
    const activity = readFileSync(
      join(cyclesDirectory(repo), cycleIds[0]!, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("no filing room");
    expect(worker.currentState.issues.length).toBe(5);
    await worker.stop();
  });

  test("a drain consumed during a forge read starts no cycle when the tick resumes", async () => {
    const root = await temporaryRoot("drain-race");
    const repo = join(root, "repo");
    write(join(repo, "src", "a.ts"), "export const dead = 1;\n");
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    const hold = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    forge.hold = hold.promise;
    forge.holding = reading.resolve;
    const worker = new DeadCodeWorker({
      repoDir: repo,
      stateDir,
      syncMs: 60_000,
      cadenceMs: 60 * 60_000,
      now: () => new Date("2026-01-01T12:00:00Z"),
      harnessVersion: "test",
      github: forge,
      connect: peerFor(forge),
    });
    expect(worker.start("acme/fixture")).toBe(true);
    const readingTick = worker.tickNow();
    await reading.promise;

    const control = versionedControlDirectory(stateDir, repo, "test");
    writeCommand(control, { type: "drain" });
    // The tick that consumes the drain stays inside `consumeCommands` past the
    // settlement of the read, so the tick resuming from that read runs its own
    // body while `draining` is already true and before the consumer reaches its
    // own drain branch. That is the interleaving the resumed tick must honour.
    for (let index = 0; index < 32; index += 1) {
      writeCommand(control, {
        type: "settings",
        intervalMinutes: 60,
        maxPerHour: 10,
        maxPending: 5,
      });
    }
    const drainingTick = worker.tickNow();
    hold.resolve();
    await Promise.all([readingTick, drainingTick]);

    expect(worker.cyclingNow).toBe(false);
    expect(worker.currentState.lastCycleStartedAt).toBeNull();
    const cycles = existsSync(cyclesDirectory(repo)) ? readdirSync(cyclesDirectory(repo)) : [];
    expect(cycles).toEqual([]);
    expect(worker.currentState.lifecycle).toBe("stopped");
  });

  test("a drain during an in-flight cycle exits once that cycle ends", async () => {
    const root = await temporaryRoot("drain-in-flight");
    const repo = join(root, "repo");
    write(join(repo, "src", "a.ts"), "export const dead = 1;\n");
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    const release = Promise.withResolvers<void>();
    const worker = new DeadCodeWorker({
      repoDir: repo,
      stateDir,
      syncMs: 60_000,
      cadenceMs: 60 * 60_000,
      now: () => new Date("2026-01-01T12:00:00Z"),
      harnessVersion: "test",
      github: forge,
      connect: peerFor(forge, undefined, release.promise),
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.tickNow();
    expect(worker.cyclingNow).toBe(true);

    writeCommand(versionedControlDirectory(stateDir, repo, "test"), { type: "drain" });
    await worker.tickNow();
    expect(worker.currentState.draining).toBe(true);
    expect(worker.cyclingNow).toBe(true);

    release.resolve();
    await worker.waitForCycle();
    expect(worker.currentState.lifecycle).toBe("stopped");
    expect(readdirSync(cyclesDirectory(repo)).length).toBe(1);
  });

  test("a tick with no drain still starts a cycle", async () => {
    const root = await temporaryRoot("no-drain");
    const repo = join(root, "repo");
    write(join(repo, "src", "a.ts"), "export const dead = 1;\n");
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    const worker = new DeadCodeWorker({
      repoDir: repo,
      stateDir,
      syncMs: 60_000,
      cadenceMs: 60 * 60_000,
      now: () => new Date("2026-01-01T12:00:00Z"),
      harnessVersion: "test",
      github: forge,
      connect: peerFor(forge),
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.tickNow();
    await worker.waitForCycle();
    expect(readdirSync(cyclesDirectory(repo)).length).toBe(1);
    await worker.stop();
  });
});
