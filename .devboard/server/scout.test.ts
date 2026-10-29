import { afterAll, describe, expect, test, vi } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { activityDelta } from "./activity";
import { ScoutBridge } from "./scout";
import { agentRegistry } from "./agents/registry";
import { parseCommand } from "../issues/scout/control";
import { acquireLock } from "../issues/lock";
import { writeActivity } from "../issues/state";
import {
  closingCommitFromComments,
  closingCommitFromTimeline,
  earliestRelease,
  parseJsonLines,
  shippedVersion,
  type ScoutGitHubClient,
  type ScoutRelease,
} from "../issues/scout/github";
import {
  DEFAULT_MAX_PENDING,
  controlDirectory,
  lockPath,
  settingsPath,
  statePath,
} from "../issues/scout/paths";
import { preflightScout, scoutCommandPaths, stateInsideRepository } from "../issues/scout/preflight";
import {
  categoryFromBody,
  normalizeTitle,
  parseScanResult,
  recommendationId,
} from "../issues/scout/recommendation";
import {
  buildRequest,
  createScanDirectory,
  promptFor,
  readDraftGoalHeadings,
  writeRequest,
} from "../issues/scout/scan";
import {
  DEFAULT_LIMITS,
  migrateState,
  parseSettings,
  parseState,
  readSettings,
  readState,
  writeSettings,
  writeState,
  type ScoutLimits,
  type ScoutState,
} from "../issues/scout/state";
import {
  createdDirectories,
  makeRepository,
  recommendation,
  scanDocument,
  sourceFiles,
  temporaryDirectory,
  type DraftRecommendation,
} from "../tests/fixtures/scout-helpers";

const findings = 12;
const requested = 5;

afterAll(async () => {
  await Promise.all(
    createdDirectories().map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function repository(): Promise<string> {
  const root = await makeRepository({ files: sourceFiles(findings), origin: "acme/fixture" });
  const home = await temporaryDirectory("scout-home");
  await mkdir(join(home, ".omp", "commands"), { recursive: true });
  await writeFile(
    join(home, ".omp", "commands", "scout-recommendations.md"),
    "# scout recommendations\n",
  );
  return root;
}

function items(count: number): DraftRecommendation[] {
  return Array.from({ length: count }, (_value, index) => recommendation(index + 1));
}

describe("recommendation identity", () => {
  test("the same finding keeps its id and a different category does not", () => {
    const id = recommendationId("clarity", ["src/b.ts", "src/a.ts"], "  A  Title ");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(recommendationId("clarity", ["src/a.ts", "src/b.ts"], "a title")).toBe(id);
    expect(recommendationId("structure", ["src/a.ts", "src/b.ts"], "a title")).not.toBe(id);
    expect(normalizeTitle("  A  Title ")).toBe("a title");
  });

  test("the category is read from an issue body, or null when absent", () => {
    expect(categoryFromBody("## Category\n\nrobustness\n\n## Summary\n\nx")).toBe("robustness");
    expect(categoryFromBody("## Summary\n\nx")).toBeNull();
    expect(categoryFromBody("## Category\n\n\n## Summary\n\nx")).toBeNull();
    expect(categoryFromBody("## category\n\nnaming")).toBe("naming");
  });
});

describe("scan result validation", () => {
  test("accepts at most the requested count and derives ids and scores", async () => {
    const root = await repository();
    const result = parseScanResult(scanDocument(items(3)), { requested, repoDir: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(3);
    expect(result.items[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(result.items[0]?.significance).toBe(5);
    expect(result.items[0]?.significanceReason).toContain("third nested branch");
    expect(result.shortfall).toBeNull();
  });

  test("refuses more recommendations than requested", async () => {
    const root = await repository();
    const result = parseScanResult(scanDocument(items(6)), { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("6 recommendations");
    expect(result.error).toContain(`${requested} requested`);
  });

  test("a missing significance score fails the whole answer", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    delete (document.recommendations as Record<string, unknown>[])[0]!.significance;
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("significance score from 1 to 5");
  });

  test("an out-of-range significance score fails the whole answer", async () => {
    const root = await repository();
    for (const value of [0, 6, 1.5, "4"]) {
      const document = scanDocument([recommendation(1)]);
      (document.recommendations as Record<string, unknown>[])[0]!.significance = value;
      const result = parseScanResult(document, { requested, repoDir: root });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("significance score");
    }
  });

  test("a missing significance reason fails the whole answer", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    delete (document.recommendations as Record<string, unknown>[])[0]!.significanceReason;
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("significance reason");
  });

  test("a malformed item names itself", async () => {
    const root = await repository();
    const document = scanDocument(items(2));
    const first = (document.recommendations as Record<string, unknown>[])[0]!;
    delete first.category;
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('item 1 ("Simplify module 1 control flow")');
    expect(result.error).toContain("category");
  });

  test("a title that spans more than one line is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.title = "One line\nand another";
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("more than one line");
  });

  test("a path that escapes the repository is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.evidence = [
      { path: "../outside.ts", lines: "1" },
    ];
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("escapes the repository");
  });

  test("a path under node_modules is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.evidence = [
      { path: "node_modules/pkg/index.js", lines: "1" },
    ];
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("excluded tree");
  });

  test("a duplicate id inside one result is refused", async () => {
    const root = await repository();
    const first = recommendation(1);
    const document = scanDocument([first, { ...first }]);
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("repeats the id of item 1");
    expect(result.error).toContain(recommendationId("clarity", ["src/module-1.ts"], first.title));
  });

  test("an out-of-range line span is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.evidence = [
      { path: "src/module-1.ts", lines: "18-999" },
    ];
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("outside the file's 20 line(s)");
  });

  test("a file list entry the evidence does not cite is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.files = ["src/module-2.ts"];
    const result = parseScanResult(document, { requested, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("which its evidence does not cite");
  });

  test("a non-empty shortfall is preserved and an empty one is dropped", async () => {
    const root = await repository();
    const withReason = parseScanResult(scanDocument(items(1), "Only one real gap."), {
      requested,
      repoDir: root,
    });
    expect(withReason.ok && withReason.shortfall).toBe("Only one real gap.");
    const empty = parseScanResult(scanDocument(items(1), "   "), {
      requested,
      repoDir: root,
    });
    expect(empty.ok && empty.shortfall).toBeNull();
  });
});

describe("scan request", () => {
  test("carries the requested batch, excluded roots, known titles, and headings", async () => {
    const root = await repository();
    await mkdir(join(root, ".devboard", "goal-proposals"), { recursive: true });
    await writeFile(
      join(root, ".devboard", "goal-proposals", "one.md"),
      "# Proposed goal: Merge the two trackers\n\n> draft\n",
    );
    const scan = createScanDirectory(root, new Date("2026-10-27T10:00:00Z"));
    const request = buildRequest({
      scan,
      repository: "acme/fixture",
      repoDir: root,
      requested: 3,
      knownTitles: ["open issue", "existing scout issue"],
      draftGoalHeadings: readDraftGoalHeadings(root),
    });
    expect(request.requested).toBe(3);
    expect(request.significanceThreshold).toBe(4);
    expect(request.repository).toBe("acme/fixture");
    expect(request.repositoryPath).toBe(root);
    expect(request.excludedRoots).toContain("node_modules");
    expect(request.categories).toContain("correctness");
    expect(request.knownTitles).toEqual(["open issue", "existing scout issue"]);
    expect(request.draftGoalHeadings).toEqual(["Proposed goal: Merge the two trackers"]);
    writeRequest(scan.directory, request);
    const written = JSON.parse(readFileSync(join(scan.directory, "request.json"), "utf8"));
    expect(written.version).toBe(2);
    expect(written.requested).toBe(3);
    expect(promptFor(scan.directory)).toBe(`/scout-recommendations ${scan.directory}`);
  });
});

function release(tag: string, publishedAt: string): ScoutRelease {
  return { tag, publishedAt };
}

function fakeGitHub(overrides: Partial<ScoutGitHubClient> = {}): ScoutGitHubClient {
  return {
    listIssues: async () => [],
    listOpenIssueTitles: async () => [],
    listReleases: async () => [],
    closingCommit: async () => null,
    resolveCommit: async () => null,
    containingReleaseTags: async () => [],
    ...overrides,
  };
}

describe("shipped version", () => {
  test("the earliest published release wins, with the tag name breaking a tie", () => {
    const releases = [
      release("v2.0.0", "2026-03-01T00:00:00Z"),
      release("v1.5.0", "2026-02-01T00:00:00Z"),
      release("v1.4.0", "2026-02-01T00:00:00Z"),
      release("v1.3.0", "2026-01-01T00:00:00Z"),
    ];
    expect(earliestRelease(releases, ["v2.0.0", "v1.5.0", "v1.4.0"])).toBe("v1.4.0");
    expect(earliestRelease(releases, [])).toBeNull();
  });

  test("the timeline's newest closing commit wins", () => {
    expect(
      closingCommitFromTimeline([
        { event: "labeled" },
        { event: "closed", commit_id: "aaaaaaa" },
        { event: "reopened" },
        { event: "closed", commit_id: "bbbbbbb" },
      ]),
    ).toBe("bbbbbbb");
    expect(closingCommitFromTimeline([{ event: "closed", commit_id: null }])).toBeNull();
  });

  test("the newest comment with a SHA yields its last SHA", () => {
    expect(
      closingCommitFromComments([
        "Fixed in deadbeefcafe",
        "still discussing",
        "Merged as 1234567 and follow-up abcdef123456",
      ]),
    ).toBe("abcdef123456");
    expect(closingCommitFromComments(["no sha here"])).toBeNull();
  });

  test("a closed issue resolves its commit and earliest containing release", async () => {
    const client = fakeGitHub({
      closingCommit: async () => "abc1234",
      resolveCommit: async () => "a".repeat(40),
      containingReleaseTags: async () => ["v1.0.0", "v1.1.0"],
    });
    const version = await shippedVersion(
      {
        number: 4,
        title: "t",
        url: "u",
        state: "closed",
        createdAt: "2026-01-01T00:00:00Z",
        body: "## Category\n\nclarity\n",
      },
      client,
      [release("v1.1.0", "2026-02-01T00:00:00Z"), release("v1.0.0", "2026-01-01T00:00:00Z")],
    );
    expect(version).toBe("v1.0.0");
  });

  test("a blank version is the answer when nothing resolves", async () => {
    const issue = {
      number: 4,
      title: "t",
      url: "u",
      state: "closed" as const,
      createdAt: "2026-01-01T00:00:00Z",
      body: "",
    };
    expect(await shippedVersion(issue, fakeGitHub(), [])).toBeNull();
    expect(
      await shippedVersion(
        issue,
        fakeGitHub({
          closingCommit: async () => "abc1234",
          resolveCommit: async () => "a".repeat(40),
          containingReleaseTags: async () => [],
        }),
        [release("v1.0.0", "2026-01-01T00:00:00Z")],
      ),
    ).toBeNull();
  });

  test("an open issue never has a shipped version", async () => {
    const version = await shippedVersion(
      {
        number: 1,
        title: "t",
        url: "u",
        state: "open",
        createdAt: "2026-01-01T00:00:00Z",
        body: "",
      },
      fakeGitHub({ closingCommit: async () => "abc1234" }),
      [release("v1.0.0", "2026-01-01T00:00:00Z")],
    );
    expect(version).toBeNull();
  });

  test("gh NDJSON output is parsed line by line", () => {
    expect(parseJsonLines('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(parseJsonLines("not json")).toEqual([]);
  });
});

describe("state and settings", () => {
  test("limits round-trip and an invalid document is refused", async () => {
    const root = await repository();
    const path = settingsPath(join(root, ".devboard", ".tmp", "state"), root);
    const limits: ScoutLimits = { maxPerHour: 4, maxPending: 2 };
    writeSettings(path, { ...limits, intervalMinutes: 1 });
    expect(readSettings(path)).toEqual({ ...limits, intervalMinutes: 1 });
    expect(parseSettings('{"maxPerHour":0,"maxPending":2}')).toBeUndefined();
    expect(parseSettings('{"maxPerHour":2.5,"maxPending":2}')).toBeUndefined();
    expect(parseSettings("not json")).toBeUndefined();
  });

  test("a version-1 board migrates, discarding every staged recommendation", async () => {
    const root = await repository();
    const staged = items(3).map((item, index) => ({
      ...item,
      id: `id${index}`,
      stagedAt: "2026-01-01T00:00:00Z",
    }));
    const legacy = {
      version: 1,
      repo: "acme/fixture",
      root,
      lifecycle: "idle",
      enabled: true,
      worker: {
        pid: 1,
        startedAt: "2026-01-01T00:00:00Z",
        stateDir: join(root, ".devboard", ".tmp", "state"),
        harnessVersion: null,
        argv: [],
      },
      staged,
      scan: { scanId: "scan-1", startedAt: "2026-01-01T00:00:00Z", requested: 9 },
      newestScanId: "scan-1",
      shortfall: null,
      nextAttemptAt: null,
      lastError: null,
      notice: null,
      decisions: [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const migrated = migrateState(JSON.stringify(legacy));
    expect(migrated).toBeDefined();
    if (migrated === undefined) return;
    expect(migrated.version).toBe(2);
    expect(migrated.issues).toEqual([]);
    expect(migrated.limits).toEqual(DEFAULT_LIMITS);
    expect(migrated.limits.maxPending).toBe(DEFAULT_MAX_PENDING);
    expect(migrated.scan).toEqual(legacy.scan);
    expect(migrated.newestScanId).toBe("scan-1");
    expect(migrated.notice).toContain("Discarded 3 staged recommendations");
    expect(migrated.notice).toContain("nothing was filed");
    expect(migrated.worker?.pid).toBe(1);
    expect(parseState(JSON.stringify(migrated))).toEqual(migrated);
  });

  test("a version-1 file with nothing staged migrates without a discard notice", async () => {
    const root = await repository();
    const legacy = {
      version: 1,
      repo: "acme/fixture",
      root,
      lifecycle: "idle",
      enabled: true,
      worker: null,
      staged: [],
      scan: null,
      newestScanId: null,
      shortfall: null,
      nextAttemptAt: null,
      lastError: null,
      notice: null,
      decisions: [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const migrated = migrateState(JSON.stringify(legacy));
    expect(migrated?.notice).toBeNull();
    expect(migrated?.issues).toEqual([]);
  });

  test("a version-2 state round-trips through the published file", async () => {
    const root = await repository();
    const stateDir = join(root, ".devboard", ".tmp", "state");
    const path = statePath(stateDir, root);
    const state = migrateState(
      JSON.stringify({
        version: 1,
        repo: "acme/fixture",
        root,
        lifecycle: "idle",
        enabled: true,
        worker: null,
        staged: [],
        scan: null,
        newestScanId: null,
        shortfall: null,
        nextAttemptAt: null,
        lastError: null,
        notice: null,
        decisions: [],
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    expect(state).toBeDefined();
    if (state === undefined) return;
    writeState(path, state);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
  });
});

describe("bridge", () => {
  test("a poll that extends the last line and adds a line delivers both", async () => {
    const root = await repository();
    const stateDir = join(root, ".devboard", ".tmp", "state");
    const scan = createScanDirectory(root, new Date("2026-01-01T00:00:00Z"));
    const state: ScoutState = {
      version: 2,
      repo: "acme/fixture",
      root,
      lifecycle: "idle",
      enabled: true,
      worker: null,
      limits: { ...DEFAULT_LIMITS },
      intervalMinutes: 1,
      lastScanStartedAt: null,
      issues: [],
      openTitles: [],
      releaseSignature: null,
      sync: { state: "stale", at: null, error: null },
      scan: null,
      newestScanId: scan.scanId,
      nextAttemptAt: null,
      lastError: null,
      notice: null,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    writeState(statePath(stateDir, root), state);
    writeActivity(scan.directory, ["a"]);
    const events: unknown[] = [];
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: (event) => events.push(event),
      pollMs: 60_000,
      spawnWorker: () => undefined,
    });
    try {
      bridge.refresh();
      writeActivity(scan.directory, ["ab", "c"]);
      bridge.refresh();
      const activity = events.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "agentActivity",
      );
      expect(activity).toEqual([
        {
          type: "agentActivity",
          id: "scout",
          scanId: scan.scanId,
          replay: true,
          entries: [{ text: "a", append: false }],
        },
        {
          type: "agentActivity",
          id: "scout",
          scanId: scan.scanId,
          entries: [
            { text: "b", append: true },
            { text: "c", append: false },
          ],
        },
      ]);
      bridge.refresh();
      expect(
        events.filter(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "agentActivity",
        ),
      ).toHaveLength(2);
    } finally {
      bridge.dispose();
    }
  });

  test("limits persist without a worker and the snapshot reports them", async () => {
    const root = await repository();
    const stateDir = join(root, ".devboard", ".tmp", "state");
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
    });
    expect(bridge.setSettings(1, 20, 3)).toEqual({ ok: true });
    expect(readSettings(settingsPath(stateDir, root))).toEqual({
      maxPerHour: 20,
      maxPending: 3,
      intervalMinutes: 1,
    });
    expect(bridge.snapshot().limits).toEqual({ maxPerHour: 20, maxPending: 3 });
    expect(bridge.snapshot().issues).toEqual([]);
    expect(bridge.snapshot().sync.state).toBe("stale");
    for (const [perHour, pending] of [
      [0, 3],
      [20, 0],
      [101, 3],
      [20, 101],
      [2.5, 3],
    ]) {
      const refused = bridge.setSettings(1, perHour, pending);
      expect(refused.ok).toBe(false);
    }
    expect(bridge.setSettings(0, 20, 3).ok).toBe(false);
    expect(readSettings(settingsPath(stateDir, root))).toEqual({
      maxPerHour: 20,
      maxPending: 3,
      intervalMinutes: 1,
    });
    bridge.dispose();
  });

  test("a live worker with a legacy state reports its lifecycle and can be stopped", async () => {
    const root = await repository();
    const stateDir = join(root, ".devboard", ".tmp", "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    try {
      const legacy = {
        version: 1,
        repo: "acme/fixture",
        root,
        lifecycle: "idle",
        enabled: true,
        worker: {
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00Z",
          stateDir,
          harnessVersion: "0.1.0",
          argv: [],
        },
        staged: items(3).map((item, index) => ({
          ...item,
          id: `id${index}`,
          stagedAt: "2026-01-01T00:00:00Z",
        })),
        scan: null,
        newestScanId: null,
        shortfall: null,
        nextAttemptAt: null,
        lastError: null,
        notice: null,
        decisions: [],
        updatedAt: "2026-01-01T00:00:00Z",
      };
      mkdirSync(dirname(statePath(stateDir, root)), { recursive: true });
      writeFileSync(statePath(stateDir, root), JSON.stringify(legacy));
      const bridge = new ScoutBridge({
        descriptor: agentRegistry.require("scout"),
        repoDir: root,
        stateDir,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
        runningVersion: "0.1.0",
        harnessDir: join(import.meta.dir, ".."),
        send: () => undefined,
        pollMs: 60_000,
        spawnWorker: () => undefined,
      });
      const snapshot = bridge.snapshot();
      expect(snapshot.attached).toBe(true);
      expect(bridge.present).toBe(true);
      expect(snapshot.lifecycle).toBe("running");
      expect(snapshot.enabled).toBe(true);
      expect(readState(statePath(stateDir, root))?.worker?.pid).toBe(process.pid);
      expect(snapshot.notice).toContain("Discarded 3 staged recommendations");
      expect(bridge.stop()).toEqual({ ok: true });
      const files = readdirSync(controlDirectory(stateDir, root));
      expect(files).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(controlDirectory(stateDir, root), files[0]!), "utf8")),
      ).toEqual({ type: "stop" });
      bridge.dispose();
    } finally {
      lock.release();
    }
  });

  test("a live worker without readable state can still be stopped", async () => {
    const root = await repository();
    const stateDir = join(root, ".devboard", ".tmp", "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    try {
      const bridge = new ScoutBridge({
        descriptor: agentRegistry.require("scout"),
        repoDir: root,
        stateDir,
        agentCommand: "stub",
        agentEnvironment: async () => ({}),
        runningVersion: "0.1.0",
        harnessDir: join(import.meta.dir, ".."),
        send: () => undefined,
        pollMs: 60_000,
        spawnWorker: () => undefined,
      });
      const snapshot = bridge.snapshot();
      expect(snapshot.attached).toBe(true);
      expect(bridge.present).toBe(true);
      expect(bridge.stop()).toEqual({ ok: true });
      expect(readdirSync(controlDirectory(stateDir, root))).toHaveLength(1);
      bridge.dispose();
    } finally {
      lock.release();
    }
  });

  test("Start after Stop waits for the stopping worker and spawns", async () => {
    const root = await temporaryDirectory("scout-bridge-stop-start");
    const stateDir = join(root, "state");
    const script = join(root, "fixture", "scout", "worker.ts");
    await mkdir(dirname(script), { recursive: true });
    await writeFile(
      script,
      "process.on('SIGTERM', () => undefined);\n" +
        "console.log('ready');\nsetInterval(() => undefined, 1000);\n",
    );
    const worker = Bun.spawn({
      cmd: [process.execPath, script, root],
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const reader = worker.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    await mkdir(dirname(lockPath(root)), { recursive: true });
    await writeFile(
      lockPath(root),
      JSON.stringify({
        pid: worker.pid,
        startedAt: new Date().toISOString(),
        repo: root,
        stateDir,
        harnessVersion: null,
        argv: [script, root],
      }),
    );
    const spawned: string[][] = [];
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    vi.useFakeTimers();
    try {
      expect(bridge.stop()).toEqual({ ok: true });
      // The proof signals the worker, which ignores SIGTERM; the stop is still
      // pending through the grace, so Start must wait rather than attach.
      vi.advanceTimersByTime(3000);
      const starting = bridge.start();
      expect(spawned).toHaveLength(0);
      vi.advanceTimersByTime(2000);
      await worker.exited;
      vi.advanceTimersByTime(50);
      expect(await starting).toEqual({ ok: true });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.join(" ")).toContain(join("scout", "worker.ts"));
    } finally {
      vi.useRealTimers();
      bridge.dispose();
      worker.kill("SIGKILL");
      await worker.exited;
      await rm(lockPath(root), { force: true });
    }
  }, 20_000);

  test("Start refuses while the stopping worker outlives the proof deadline", async () => {
    const root = await temporaryDirectory("scout-bridge-still-stopping");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    const spawned: string[][] = [];
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => ({ ok: true, repository: "acme/fixture" }),
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    vi.useFakeTimers();
    try {
      expect(bridge.stop()).toEqual({ ok: true });
      const starting = bridge.start();
      vi.advanceTimersByTime(5000);
      const result = await starting;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain(`pid ${process.pid}`);
      expect(spawned).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      bridge.dispose();
      lock.release();
    }
  });

  test("Start attaches to a live worker when no stop is pending", async () => {
    const root = await temporaryDirectory("scout-bridge-attach");
    const stateDir = join(root, "state");
    const lock = acquireLock(lockPath(root), {
      repo: root,
      stateDir,
      harnessVersion: null,
      argv: [],
    });
    expect(lock.acquired).toBe(true);
    if (!lock.acquired) return;
    const spawned: string[][] = [];
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      expect(await bridge.start()).toEqual({ ok: true });
      expect(spawned).toHaveLength(0);
    } finally {
      bridge.dispose();
      lock.release();
    }
  });

  test("concurrent Starts share one spawn", async () => {
    const root = await temporaryDirectory("scout-bridge-concurrent");
    const stateDir = join(root, "state");
    const gate = Promise.withResolvers<void>();
    const spawned: string[][] = [];
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflight: async () => {
        await gate.promise;
        return { ok: true, repository: "acme/fixture" };
      },
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      const first = bridge.start();
      const second = bridge.start();
      gate.resolve();
      expect(await Promise.all([first, second])).toEqual([
        { ok: true },
        { ok: true },
      ]);
      expect(spawned).toHaveLength(1);
    } finally {
      bridge.dispose();
    }
  });

  test("a stalled start preflight fails at the deadline and the next Start retries", async () => {
    const root = await temporaryDirectory("scout-bridge-preflight-deadline");
    const stateDir = join(root, "state");
    let calls = 0;
    const spawned: string[][] = [];
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: root,
      stateDir,
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      preflightTimeoutMs: 20,
      preflight: async () => {
        calls += 1;
        if (calls === 1) await new Promise<never>(() => undefined);
        return { ok: true, repository: "acme/fixture" };
      },
      spawnWorker: (argv) => {
        spawned.push(argv);
        return 4242;
      },
    });
    try {
      const started = Date.now();
      const first = await bridge.start();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.message).toContain("did not finish within 20 ms");
      expect(calls).toBe(1);
      expect(spawned).toHaveLength(0);

      // The timed-out task cleared its memo: this Start runs the preflight
      // again and spawns the worker the runner now accepts.
      expect(await bridge.start()).toEqual({ ok: true });
      expect(calls).toBe(2);
      expect(spawned).toHaveLength(1);
    } finally {
      bridge.dispose();
    }
  });

  test("the bridge exposes no decision path", () => {
    const bridge = new ScoutBridge({
      descriptor: agentRegistry.require("scout"),
      repoDir: process.cwd(),
      stateDir: join(process.cwd(), ".tmp"),
      agentCommand: "stub",
      agentEnvironment: async () => ({}),
      runningVersion: "0.1.0",
      harnessDir: join(import.meta.dir, ".."),
      send: () => undefined,
      pollMs: 60_000,
      spawnWorker: () => undefined,
    });
    expect("decide" in bridge).toBe(false);
    expect("approve" in bridge).toBe(false);
    bridge.dispose();
  });
});

describe("command surface", () => {
  test("Stop and settings parse; approve, draft, and reject do not", () => {
    expect(parseCommand('{"type":"stop"}')).toEqual({ type: "stop" });
    expect(
      parseCommand(
        '{"type":"settings","intervalMinutes":5,"maxPerHour":3,"maxPending":2}',
      ),
    ).toEqual({
      type: "settings",
      intervalMinutes: 5,
      maxPerHour: 3,
      maxPending: 2,
    });
    expect(
      parseCommand('{"type":"settings","intervalMinutes":5,"maxPerHour":0,"maxPending":2}'),
    ).toBeUndefined();
    expect(
      parseCommand('{"type":"settings","intervalMinutes":0,"maxPerHour":3,"maxPending":2}'),
    ).toBeUndefined();
    expect(parseCommand('{"type":"approve","id":"abc"}')).toBeUndefined();
    expect(parseCommand('{"type":"draft","id":"abc"}')).toBeUndefined();
    expect(parseCommand('{"type":"reject","id":"abc"}')).toBeUndefined();
  });
});

describe("preflight", () => {
  /**
   * A PATH that always carries the two tools preflight looks up, so the test
   * exercises the fact it names rather than the host's installed binaries.
   */
  async function pathWithTools(): Promise<string> {
    const bin = await temporaryDirectory("scout-bin");
    await writeFile(join(bin, "omp"), "");
    await writeFile(join(bin, "gh"), "");
    return bin;
  }

  test("a state directory outside the repository is refused by name", async () => {
    const root = await repository();
    const outside = await temporaryDirectory("scout-state");
    expect(stateInsideRepository(root, outside)).toBe(false);
    const result = await preflightScout({
      repoDir: root,
      stateDir: outside,
      environment: { PATH: await pathWithTools(), HOME: outside },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("STATE_DIR");
    expect(result.message).toContain("is not inside REPO_DIR");
  });

  test("a missing scan command is named with the paths it looked in", async () => {
    const root = await repository();
    const home = await temporaryDirectory("scout-home");
    const environment = { PATH: await pathWithTools(), HOME: home };
    const result = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("/scout-recommendations command is not installed");
    expect(result.message).toContain(scoutCommandPaths(root, environment)[0]!);
  });

  test("a checkout with no GitHub origin is refused", async () => {
    const root = await makeRepository({ files: sourceFiles(1), origin: null });
    const result = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment: { PATH: await pathWithTools(), HOME: root },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("origin does not name a supported repository");
  });

  test("a write permission is required, and a granted one passes", async () => {
    const root = await repository();
    const home = await temporaryDirectory("scout-home");
    await mkdir(join(home, ".omp", "commands"), { recursive: true });
    await writeFile(join(home, ".omp", "commands", "scout-recommendations.md"), "# command\n");
    const environment = { PATH: await pathWithTools(), HOME: home };
    const deny = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment,
      run: async () => ({ code: 0, stdout: "false", stderr: "" }),
    });
    expect(deny.ok).toBe(false);
    if (!deny.ok) expect(deny.message).toContain("did not return true");
    const allow = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment,
      run: async () => ({ code: 0, stdout: "true", stderr: "" }),
    });
    expect(allow).toEqual({ ok: true, repository: "acme/fixture" });
  });

  test("a permission probe that never settles fails at the preflight deadline", async () => {
    const root = await makeRepository({ files: sourceFiles(1), origin: "acme/fixture" });
    const home = await temporaryDirectory("scout-home");
    await mkdir(join(home, ".omp", "commands"), { recursive: true });
    await writeFile(join(home, ".omp", "commands", "scout-recommendations.md"), "# command\n");
    const bin = await pathWithTools();

    const started = Date.now();
    const result = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment: { PATH: bin, HOME: home },
      timeoutMs: 20,
      run: () => new Promise<never>(() => undefined),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("did not finish within 20 ms");
  });
});

describe("activity delta", () => {
  test("appends growth, continues a streamed chunk, and replays a trim", () => {
    expect(activityDelta([], ["a"])).toEqual({
      replay: true,
      entries: [{ text: "a", append: false }],
    });
    expect(activityDelta(["a"], ["a", "b"])).toEqual({
      replay: false,
      entries: [{ text: "b", append: false }],
    });
    expect(activityDelta(["x", "ab"], ["x", "abcd"])).toEqual({
      replay: false,
      entries: [{ text: "cd", append: true }],
    });
    expect(activityDelta(["a", "b"], ["b"])).toEqual({
      replay: true,
      entries: [{ text: "b", append: false }],
    });
    expect(activityDelta(["a"], ["a"])).toEqual({ replay: false, entries: [] });
  });

  test("an extended last line and a new line in one poll are both emitted", () => {
    expect(activityDelta(["a"], ["ab", "c"])).toEqual({
      replay: false,
      entries: [
        { text: "b", append: true },
        { text: "c", append: false },
      ],
    });
    expect(activityDelta(["x", "a"], ["x", "abcd", "c", "d"])).toEqual({
      replay: false,
      entries: [
        { text: "bcd", append: true },
        { text: "c", append: false },
        { text: "d", append: false },
      ],
    });
  });
});
