import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { earliestRelease, shippedVersion } from "../lib/github-release";
import { createApp } from "../server/app";
import {
  WatchdogActivity,
  createWatchdogGitHubReader,
  issueLocator,
  type WatchdogFacts,
  type WatchdogReader,
} from "../server/watchdog";
import { CYCLE_HISTORY_LIMIT, readWatchdogCycles } from "../watchdog/history";
import { saveLedger, type Ledger } from "../watchdog/ledger";
import { readWatchdogStatus } from "../watchdog/status";
import { testProviderService } from "../server/fixtures/test-providers";

/**
 * `GET /api/watchdog` and the Issues-mode Watchdog page are read-only: they
 * report the newest cycle, the retained history, and the filed issues, and
 * never an environment value or a fabricated GitHub state. Every fixture
 * lives under `.devboard/.tmp`; nothing here contacts GitHub or spawns an
 * agent.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

const first = {
  category: "server-error",
  line: "Synthetic error: ENOTFOUND the model endpoint",
  firstSeen: "2026-10-24T11:50:00.000Z",
  lastSeen: "2026-10-24T12:00:00.000Z",
  count: 2,
  disposition: "filed:https://github.com/dsdenes/devboard/issues/11",
  url: "https://github.com/dsdenes/devboard/issues/11",
  filedAt: "2026-10-24T10:00:00.000Z",
  instances: [],
};

const second = {
  category: "stall",
  line: "lane-1 implementing",
  firstSeen: "2026-10-24T11:40:00.000Z",
  lastSeen: "2026-10-24T12:00:00.000Z",
  count: 1,
  disposition: "filed:https://github.com/dsdenes/devboard/issues/12",
  url: "https://github.com/dsdenes/devboard/issues/12",
  filedAt: "2026-10-24T11:00:00.000Z",
  instances: [],
};

function ledgerFixture(): Ledger {
  return {
    version: 2,
    findings: {
      "5e2f1e4c": first,
      "9d1c7b3a": second,
      "0a1b2c3d": {
        category: "omp-warn",
        line: "slow response",
        firstSeen: "2026-10-24T11:55:00.000Z",
        lastSeen: "2026-10-24T12:00:00.000Z",
        count: 1,
        disposition: "none",
        instances: [],
      },
    },
    pendingFiling: ["0a1b2c3d"],
  };
}

function latestFixture(): Record<string, unknown> {
  return {
    cycle: "2026-10-24T12:00:00.000Z",
    window: { start: "2026-10-24T11:50:00.000Z", end: "2026-10-24T12:00:00.000Z", minutes: 10 },
    instances: [],
    findings: [{ category: "server-error", fingerprint: "5e2f1e4c" }],
    action: "filed",
    issues: [
      {
        url: first.url,
        category: first.category,
        fingerprint: "5e2f1e4c",
        line: first.line,
      },
    ],
    pending: 0,
    reportPath: "/x/report.json",
    reason: "filed 1 issue(s)",
    malformed: 0,
    unattributed: 0,
  };
}

function report(cycle: string, action: string, findings: number, reason?: string): string {
  return JSON.stringify({
    cycle,
    window: { start: cycle, end: cycle, minutes: 10 },
    instances: [],
    findings: Array.from({ length: findings }, (_unused, index) => ({ fingerprint: `${index}` })),
    action,
    issues: [],
    pending: 0,
    ...(reason === undefined ? {} : { reason }),
    malformed: 0,
    unattributed: 0,
  });
}

async function watchdogDirectory(): Promise<string> {
  const root = await temporaryDirectory("test-watchdog-api");
  const directory = join(root, "watchdog");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "latest.json"), JSON.stringify(latestFixture()));
  saveLedger(directory, ledgerFixture());
  return directory;
}

/** Every file below `directory`, with a content hash, for a byte-identity check. */
async function directoryBytes(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      result[relative(directory, path)] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }
  await walk(directory);
  return result;
}

/**
 * The refresh runs in the server's event loop, not in the request: flushing
 * microtasks and asking again is the observable surface, with no fixed delay.
 */
async function waitUntil(read: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await read()) return;
    await Promise.resolve();
  }
  throw new Error("timed out waiting for the watchdog projection");
}

describe("readWatchdogStatus", () => {
  test("reports an empty state before the first cycle", async () => {
    const directory = join(await temporaryDirectory("test-watchdog-api-empty"), "watchdog");
    expect(readWatchdogStatus(directory)).toEqual({
      cycle: null,
      action: "none",
      findings: 0,
      issues: [],
      pending: 0,
      cycles: [],
    });
  });

  test("maps the newest report and every filed issue, newest first", async () => {
    const status = readWatchdogStatus(await watchdogDirectory());
    expect(status.cycle).toBe("2026-10-24T12:00:00.000Z");
    expect(status.action).toBe("filed");
    expect(status.reason).toBe("filed 1 issue(s)");
    expect(status.findings).toBe(1);
    expect(status.pending).toBe(1);
    expect(status.issues).toEqual([
      { url: second.url, category: "stall", line: second.line, filedAt: second.filedAt },
      { url: first.url, category: first.category, line: first.line, filedAt: first.filedAt },
    ]);
    // No run directory exists, so `latest.json` is the single history row.
    expect(status.cycles).toEqual([
      {
        at: "2026-10-24T12:00:00.000Z",
        window: {
          start: "2026-10-24T11:50:00.000Z",
          end: "2026-10-24T12:00:00.000Z",
        },
        action: "filed",
        findings: 1,
        issues: [first.url],
        reason: "filed 1 issue(s)",
      },
    ]);
  });

  test("orders filed issues newest first and breaks a tie by URL", async () => {
    const directory = join(await temporaryDirectory("test-watchdog-api-order"), "watchdog");
    await mkdir(directory, { recursive: true });
    saveLedger(directory, {
      version: 2,
      findings: {
        a: { ...first, filedAt: "2026-10-24T12:00:00.000Z", url: "https://github.com/x/y/issues/2", disposition: "filed:https://github.com/x/y/issues/2" },
        b: { ...first, filedAt: "2026-10-24T12:00:00.000Z", url: "https://github.com/x/y/issues/1", disposition: "filed:https://github.com/x/y/issues/1" },
        c: { ...first, filedAt: "2026-10-24T13:00:00.000Z", url: "https://github.com/x/y/issues/3", disposition: "filed:https://github.com/x/y/issues/3" },
      },
      pendingFiling: [],
    });
    const status = readWatchdogStatus(directory);
    expect(status.issues.map((issue) => issue.url)).toEqual([
      "https://github.com/x/y/issues/3",
      "https://github.com/x/y/issues/1",
      "https://github.com/x/y/issues/2",
    ]);
  });
});

describe("readWatchdogCycles", () => {
  test("reads run directories newest first and skips a malformed report", async () => {
    const directory = join(await temporaryDirectory("test-watchdog-history"), "watchdog");
    const runs = join(directory, "runs");
    await mkdir(join(runs, "2026-10-24T11-00-00-000Z"), { recursive: true });
    await mkdir(join(runs, "2026-10-24T12-00-00-000Z"), { recursive: true });
    await mkdir(join(runs, "2026-10-24T13-00-00-000Z"), { recursive: true });
    await writeFile(
      join(runs, "2026-10-24T11-00-00-000Z", "report.json"),
      report("2026-10-24T11:00:00.000Z", "duplicate", 2),
    );
    await writeFile(
      join(runs, "2026-10-24T12-00-00-000Z", "report.json"),
      report("2026-10-24T12:00:00.000Z", "filed", 1, "filed 1 issue(s)"),
    );
    await writeFile(join(runs, "2026-10-24T13-00-00-000Z", "report.json"), "{not json");

    const cycles = readWatchdogCycles(directory, undefined);
    expect(cycles.map((cycle) => cycle.action)).toEqual(["filed", "duplicate"]);
    expect(cycles[0]).toEqual({
      at: "2026-10-24T12:00:00.000Z",
      window: { start: "2026-10-24T12:00:00.000Z", end: "2026-10-24T12:00:00.000Z" },
      action: "filed",
      findings: 1,
      issues: [],
      reason: "filed 1 issue(s)",
    });
    expect(cycles[1]?.reason).toBeUndefined();
  });

  test("resolves every finding to the GitHub issue it maps to", async () => {
    const directory = join(await temporaryDirectory("test-watchdog-history-issues"), "watchdog");
    const runs = join(directory, "runs");
    await mkdir(join(runs, "2026-10-24T12-00-00-000Z"), { recursive: true });
    await writeFile(
      join(runs, "2026-10-24T12-00-00-000Z", "report.json"),
      JSON.stringify({
        cycle: "2026-10-24T12:00:00.000Z",
        window: { start: "2026-10-24T11:50:00.000Z", end: "2026-10-24T12:00:00.000Z" },
        action: "duplicate",
        findings: [
          { fingerprint: "5e2f1e4c" },
          { fingerprint: "9d1c7b3a" },
          { fingerprint: "5e2f1e4c" },
          { fingerprint: "missing" },
        ],
        issues: [{ url: "https://github.com/x/y/issues/9" }],
        reason: "every finding already has an issue",
      }),
    );
    const cycles = readWatchdogCycles(directory, undefined, (fingerprint) =>
      fingerprint === "5e2f1e4c"
        ? "https://github.com/dsdenes/devboard/issues/11"
        : fingerprint === "9d1c7b3a"
          ? "https://github.com/dsdenes/devboard/issues/12"
          : undefined,
    );
    expect(cycles[0]?.issues).toEqual([
      "https://github.com/dsdenes/devboard/issues/11",
      "https://github.com/dsdenes/devboard/issues/12",
      "https://github.com/x/y/issues/9",
    ]);
  });

  test("caps the history at the newest 100 run directories", async () => {
    const directory = join(await temporaryDirectory("test-watchdog-cap"), "watchdog");
    const runs = join(directory, "runs");
    const base = Date.parse("2026-10-24T00:00:00.000Z");
    for (let index = 0; index < CYCLE_HISTORY_LIMIT + 5; index += 1) {
      const at = new Date(base + index * 60_000).toISOString();
      const name = at.replace(/[:.]/g, "-");
      await mkdir(join(runs, name), { recursive: true });
      await writeFile(join(runs, name, "report.json"), report(at, "none", 0));
    }
    const cycles = readWatchdogCycles(directory, undefined);
    expect(cycles).toHaveLength(CYCLE_HISTORY_LIMIT);
    expect(cycles[0]?.at).toBe(new Date(base + (CYCLE_HISTORY_LIMIT + 4) * 60_000).toISOString());
    expect(cycles[CYCLE_HISTORY_LIMIT - 1]?.at).toBe(
      new Date(base + 5 * 60_000).toISOString(),
    );
  });

  test("falls back to the latest.json cycle only when no run directory exists", async () => {
    const directory = join(await temporaryDirectory("test-watchdog-fallback"), "watchdog");
    await mkdir(directory, { recursive: true });
    const fallback = {
      at: "2026-10-24T12:00:00.000Z",
      window: { start: "2026-10-24T11:50:00.000Z", end: "2026-10-24T12:00:00.000Z" },
      action: "failed",
      findings: 3,
      issues: [],
    };
    expect(readWatchdogCycles(directory, fallback)).toEqual([fallback]);
    expect(readWatchdogCycles(directory, undefined)).toEqual([]);

    await mkdir(join(directory, "runs", "2026-10-24T10-00-00-000Z"), { recursive: true });
    expect(readWatchdogCycles(directory, fallback)).toEqual([]);
  });
});

function fakeReader(facts: Map<string, WatchdogFacts>): WatchdogReader & { calls: number } {
  const reader = {
    calls: 0,
    async project(urls: string[]): Promise<WatchdogFacts[]> {
      reader.calls += 1;
      return urls.map((url) => {
        const fact = facts.get(url);
        if (fact === undefined) throw new Error(`no fixture for ${url}`);
        return fact;
      });
    },
  };
  return reader;
}

describe("WatchdogActivity", () => {
  test("answers from the last read, refreshes at most once per interval, and maps states", async () => {
    const directory = await watchdogDirectory();
    const facts = new Map<string, WatchdogFacts>([
      [first.url, { url: first.url, state: "pending", version: null }],
      [second.url, { url: second.url, state: "implemented", version: "v1.4.0" }],
    ]);
    const reader = fakeReader(facts);
    let clock = 1_000_000;
    const activity = new WatchdogActivity({
      watchdogDir: directory,
      reader,
      now: () => clock,
      intervalMs: 60_000,
      staleAfterMs: 120_000,
    });

    const initial = activity.view();
    expect(initial.sync.state).toBe("stale");
    expect(initial.issues.map((issue) => issue.state)).toEqual([null, null]);
    await activity.settled();

    const projected = activity.view();
    expect(projected.sync.state).toBe("ok");
    expect(projected.sync.at).toBe(new Date(clock).toISOString());
    expect(projected.sync.error).toBeNull();
    expect(projected.issues).toEqual([
      {
        url: second.url,
        category: second.category,
        line: second.line,
        filedAt: second.filedAt,
        state: "implemented",
        version: "v1.4.0",
      },
      {
        url: first.url,
        category: first.category,
        line: first.line,
        filedAt: first.filedAt,
        state: "pending",
        version: null,
      },
    ]);
    expect(reader.calls).toBe(1);

    clock += 30_000;
    activity.view();
    activity.view();
    await activity.settled();
    expect(reader.calls).toBe(1);

    clock += 30_000;
    activity.view();
    await activity.settled();
    expect(reader.calls).toBe(2);
  });

  test("keeps the last known rows and reports error when a read fails", async () => {
    const directory = await watchdogDirectory();
    let fail = false;
    let clock = 5_000_000;
    const url = first.url;
    const reader: WatchdogReader = {
      async project(): Promise<WatchdogFacts[]> {
        if (fail) throw new Error("gh: authentication failed");
        return [
          { url: first.url, state: "implemented", version: "v2.0.0" },
          { url: second.url, state: "pending", version: null },
        ];
      },
    };
    const activity = new WatchdogActivity({
      watchdogDir: directory,
      reader,
      now: () => clock,
      intervalMs: 60_000,
      staleAfterMs: 120_000,
    });
    activity.view();
    await activity.settled();
    const successAt = clock;
    expect(activity.view().sync.state).toBe("ok");

    fail = true;
    clock += 60_000;
    activity.view();
    await activity.settled();
    const failed = activity.view();
    expect(failed.sync).toEqual({
      state: "error",
      at: new Date(successAt).toISOString(),
      error: "gh: authentication failed",
    });
    expect(failed.issues.find((issue) => issue.url === url)).toMatchObject({
      state: "implemented",
      version: "v2.0.0",
    });
    expect(failed.issues).toHaveLength(2);
    expect(failed.cycle).toBe("2026-10-24T12:00:00.000Z");
    expect(failed.pending).toBe(1);

    fail = false;
    clock += 60_000;
    activity.view();
    await activity.settled();
    const recovered = activity.view();
    expect(recovered.sync.state).toBe("ok");
    expect(recovered.sync.error).toBeNull();
  });

  test("reports stale when the last success is older than two minutes", async () => {
    const directory = await watchdogDirectory();
    let clock = 9_000_000;
    const activity = new WatchdogActivity({
      watchdogDir: directory,
      reader: fakeReader(
        new Map<string, WatchdogFacts>([
          [first.url, { url: first.url, state: "pending", version: null }],
          [second.url, { url: second.url, state: "pending", version: null }],
        ]),
      ),
      now: () => clock,
      intervalMs: 60_000,
      staleAfterMs: 120_000,
    });
    activity.view();
    await activity.settled();
    expect(activity.view().sync.state).toBe("ok");

    clock += 121_000;
    const stale = activity.view();
    expect(stale.sync.state).toBe("stale");
    expect(stale.sync.at).toBe(new Date(9_000_000).toISOString());
    expect(stale.sync.error).toBeNull();
    // The scheduled read answers the next request, not this one.
    expect(stale.issues[0]?.state).toBe("pending");
    await activity.settled();
    expect(activity.view().sync.state).toBe("ok");
  });

  test("serves a request without waiting for the reader", async () => {
    const directory = await watchdogDirectory();
    const root = resolve(directory, "..");
    await mkdir(join(root, "adrs"), { recursive: true });
    await mkdir(join(root, "static"), { recursive: true });
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const reader: WatchdogReader = {
      async project(): Promise<WatchdogFacts[]> {
        calls += 1;
        await gate.promise;
        return [
          { url: first.url, state: "pending", version: null },
          { url: second.url, state: "implemented", version: "v3.0.0" },
        ];
      },
    };
    // The gate stays unresolved, so a response proves the request did not wait.
    const server = createApp({
      adrDir: join(root, "adrs"),
      staticDir: join(root, "static"),
      hostname: "127.0.0.1",
      port: 0,
      repoDir: root,
      stateDir: root,
      providers: testProviderService(root),
      watchdog: { reader },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/watchdog`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect((body.sync as Record<string, unknown>).state).toBe("stale");
      expect(body.issues).toEqual([
        expect.objectContaining({ url: second.url, state: null, version: null }),
        expect.objectContaining({ url: first.url, state: null, version: null }),
      ]);

      gate.resolve();
      await waitUntil(async () => {
        const reply = await fetch(`http://127.0.0.1:${server.port}/api/watchdog`);
        const value = (await reply.json()) as Record<string, unknown>;
        return (value.sync as Record<string, unknown>).state === "ok";
      });
      expect(calls).toBe(1);
      const reply = await fetch(`http://127.0.0.1:${server.port}/api/watchdog`);
      const projected = (await reply.json()) as Record<string, unknown>;
      expect(
        (projected.issues as Array<Record<string, unknown>>).map((issue) => [
          issue.url,
          issue.state,
          issue.version,
        ]),
      ).toEqual([
        [second.url, "implemented", "v3.0.0"],
        [first.url, "pending", null],
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("leaves the watchdog state directory byte-identical", async () => {
    const directory = await watchdogDirectory();
    await mkdir(join(directory, "runs", "2026-10-24T12-00-00-000Z"), { recursive: true });
    await writeFile(
      join(directory, "runs", "2026-10-24T12-00-00-000Z", "report.json"),
      report("2026-10-24T12:00:00.000Z", "filed", 1),
    );
    const root = resolve(directory, "..");
    await mkdir(join(root, "adrs"), { recursive: true });
    await mkdir(join(root, "static"), { recursive: true });
    const before = await directoryBytes(directory);
    const server = createApp({
      adrDir: join(root, "adrs"),
      staticDir: join(root, "static"),
      hostname: "127.0.0.1",
      port: 0,
      repoDir: root,
      stateDir: root,
      providers: testProviderService(root),
      watchdog: {
        reader: fakeReader(
          new Map<string, WatchdogFacts>([
            [first.url, { url: first.url, state: "pending", version: null }],
            [second.url, { url: second.url, state: "implemented", version: "v1.0.0" }],
          ]),
        ),
      },
    });
    try {
      readWatchdogStatus(directory);
      for (let index = 0; index < 3; index += 1) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/watchdog`);
        await response.json();
      }
    } finally {
      server.stop(true);
    }
    expect(await directoryBytes(directory)).toEqual(before);
  });
});

describe("GET /api/watchdog", () => {
  test("returns the newest cycle, history, issues, and sync without any environment value", async () => {
    const directory = await watchdogDirectory();
    const root = resolve(directory, "..");
    const stateDir = join(root, "state");
    await mkdir(join(stateDir, "watchdog"), { recursive: true });
    await writeFile(join(stateDir, "watchdog", "latest.json"), JSON.stringify(latestFixture()));
    saveLedger(join(stateDir, "watchdog"), ledgerFixture());
    const staticDir = join(root, "static");
    await mkdir(staticDir, { recursive: true });
    await mkdir(join(root, "adrs"), { recursive: true });

    const canary = "watchdog-canary-9f4c2b";
    process.env.DEVBOARD_WATCHDOG_CANARY = canary;
    const server = createApp({
      adrDir: join(root, "adrs"),
      staticDir,
      hostname: "127.0.0.1",
      port: 0,
      repoDir: root,
      stateDir,
      providers: testProviderService(stateDir),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/watchdog`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const text = await response.text();
      expect(text.includes(canary)).toBe(false);
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "action",
        "cycle",
        "cycles",
        "findings",
        "issues",
        "pending",
        "reason",
        "sync",
      ]);
      expect(body.cycle).toBe("2026-10-24T12:00:00.000Z");
      expect(body.action).toBe("filed");
      expect(body.findings).toBe(1);
      expect(body.pending).toBe(1);
      expect(body.cycles).toEqual([
        {
          at: "2026-10-24T12:00:00.000Z",
          window: { start: "2026-10-24T11:50:00.000Z", end: "2026-10-24T12:00:00.000Z" },
          action: "filed",
          findings: 1,
          issues: [first.url],
          reason: "filed 1 issue(s)",
        },
      ]);
      expect(body.issues).toEqual([
        { url: second.url, category: second.category, line: second.line, filedAt: second.filedAt, state: null, version: null },
        { url: first.url, category: first.category, line: first.line, filedAt: first.filedAt, state: null, version: null },
      ]);
      expect(body.sync).toEqual({ state: "stale", at: null, error: null });
    } finally {
      server.stop(true);
      delete process.env.DEVBOARD_WATCHDOG_CANARY;
    }
  });

  test("refuses a non-GET method", async () => {
    const root = await temporaryDirectory("test-watchdog-api-method");
    const staticDir = join(root, "static");
    await mkdir(staticDir, { recursive: true });
    await mkdir(join(root, "adrs"), { recursive: true });
    const server = createApp({
      adrDir: join(root, "adrs"),
      staticDir,
      hostname: "127.0.0.1",
      port: 0,
      repoDir: root,
      stateDir: join(root, "state"),
      providers: testProviderService(join(root, "state")),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/watchdog`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(405);
    } finally {
      server.stop(true);
    }
  });
});

type RunnerReply = { code: number; stdout: string; stderr: string };

function ghStub(replies: (argv: string[]) => RunnerReply | undefined) {
  const calls: string[] = [];
  return {
    calls,
    async run(argv: string[]): Promise<RunnerReply> {
      calls.push(argv.join(" "));
      const reply = replies(argv);
      if (reply !== undefined) return reply;
      return { code: 1, stdout: "", stderr: `unexpected gh call: ${argv.join(" ")}` };
    },
  };
}

const fullSha = "0123456789abcdef0123456789abcdef01234567";

describe("createWatchdogGitHubReader", () => {
  test("maps open to pending and closed to implemented from each URL's repository", async () => {
    const root = await temporaryDirectory("test-watchdog-reader");
    const stub = ghStub((argv) => {
      const text = argv.join(" ");
      if (text.includes("/issues/1 ") || text.endsWith("/issues/1")) {
        return { code: 0, stdout: "open\n", stderr: "" };
      }
      if (text.includes("/issues/2 ") || text.endsWith("/issues/2")) {
        return { code: 0, stdout: "closed\n", stderr: "" };
      }
      if (text.includes("releases")) return { code: 0, stdout: "", stderr: "" };
      if (text.includes("/timeline")) return { code: 0, stdout: "", stderr: "" };
      if (text.includes("/comments")) return { code: 0, stdout: "", stderr: "" };
      return undefined;
    });
    const reader = createWatchdogGitHubReader({ repoDir: root, run: stub.run });
    const facts = await reader.project([
      "https://github.com/example/widget/issues/1",
      "https://github.com/dsdenes/devboard/issues/2",
    ]);
    expect(facts).toEqual([
      { url: "https://github.com/example/widget/issues/1", state: "pending", version: null },
      { url: "https://github.com/dsdenes/devboard/issues/2", state: "implemented", version: null },
    ]);
    expect(stub.calls.some((call) => call.includes("repos/example/widget/issues/1"))).toBe(true);
    expect(stub.calls.some((call) => call.includes("repos/dsdenes/devboard/issues/2"))).toBe(true);
    expect(stub.calls.some((call) => call.includes("repos/dsdenes/devboard/releases"))).toBe(true);
  });

  test("resolves the timeline's closing commit to the earliest published release", async () => {
    const root = await temporaryDirectory("test-watchdog-version");
    const stub = ghStub((argv) => {
      const text = argv.join(" ");
      if (text.includes("/issues/7 ") || text.endsWith("/issues/7")) {
        return { code: 0, stdout: "closed\n", stderr: "" };
      }
      if (text.includes("/timeline")) {
        return { code: 0, stdout: "abc1234\n", stderr: "" };
      }
      if (text.includes("/commits/abc1234")) {
        return { code: 0, stdout: `${fullSha}\n`, stderr: "" };
      }
      if (text.includes("/releases")) {
        return {
          code: 0,
          stdout:
            '{"tag":"v2.0.0","publishedAt":"2026-10-02T00:00:00Z","draft":false}\n' +
            '{"tag":"v1.0.0","publishedAt":"2026-10-01T00:00:00Z","draft":false}\n' +
            '{"tag":"v0.9.0","publishedAt":"2026-09-01T00:00:00Z","draft":false}\n',
          stderr: "",
        };
      }
      if (text.includes(`/compare/${fullSha}...v1.0.0`)) {
        return { code: 0, stdout: "ahead\n", stderr: "" };
      }
      if (text.includes("/compare/")) return { code: 0, stdout: "behind\n", stderr: "" };
      return undefined;
    });
    const reader = createWatchdogGitHubReader({ repoDir: root, run: stub.run });
    const facts = await reader.project(["https://github.com/dsdenes/devboard/issues/7"]);
    expect(facts).toEqual([
      {
        url: "https://github.com/dsdenes/devboard/issues/7",
        state: "implemented",
        version: "v1.0.0",
      },
    ]);
  });

  test("falls back to the newest comment's last SHA and breaks a release tie by tag", async () => {
    const root = await temporaryDirectory("test-watchdog-comment");
    const short = "fedcba9";
    const stub = ghStub((argv) => {
      const text = argv.join(" ");
      if (text.includes("/issues/8 ") || text.endsWith("/issues/8")) {
        return { code: 0, stdout: "closed\n", stderr: "" };
      }
      if (text.includes("/timeline")) return { code: 0, stdout: "", stderr: "" };
      if (text.includes("/comments")) {
        return {
          code: 0,
          stdout:
            '{"body":"first shipped in aaaaaaa"}\n' +
            `{"body":"landed as ${short}"}\n` +
            '{"body":"thanks"}\n',
          stderr: "",
        };
      }
      if (text.includes(`/commits/${short}`)) {
        return { code: 0, stdout: `${fullSha}\n`, stderr: "" };
      }
      if (text.includes("/releases")) {
        return {
          code: 0,
          stdout:
            '{"tag":"v1.0.1","publishedAt":"2026-10-01T00:00:00Z","draft":false}\n' +
            '{"tag":"v1.0.0","publishedAt":"2026-10-01T00:00:00Z","draft":false}\n',
          stderr: "",
        };
      }
      if (text.includes("/compare/")) return { code: 0, stdout: "ahead\n", stderr: "" };
      return undefined;
    });
    const reader = createWatchdogGitHubReader({ repoDir: root, run: stub.run });
    const facts = await reader.project(["https://github.com/dsdenes/devboard/issues/8"]);
    expect(facts[0]?.version).toBe("v1.0.0");
  });

  test("rejects the read when gh fails, and leaves an unknown state unresolved", async () => {
    const root = await temporaryDirectory("test-watchdog-reader-failure");
    const failing = ghStub(() => ({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials\nmore" }));
    const reader = createWatchdogGitHubReader({ repoDir: root, run: failing.run });
    await expect(reader.project(["https://github.com/dsdenes/devboard/issues/9"])).rejects.toThrow(
      "HTTP 401: Bad credentials",
    );

    const unknown = ghStub((argv) => {
      if (argv.join(" ").includes("/issues/9")) {
        return { code: 0, stdout: "merged\n", stderr: "" };
      }
      return undefined;
    });
    const unknownReader = createWatchdogGitHubReader({ repoDir: root, run: unknown.run });
    await expect(
      unknownReader.project(["https://github.com/dsdenes/devboard/issues/9"]),
    ).rejects.toThrow("unknown issue state");
  });

  test("rejects a URL that is not a GitHub issue", async () => {
    const root = await temporaryDirectory("test-watchdog-reader-url");
    const stub = ghStub(() => undefined);
    const reader = createWatchdogGitHubReader({ repoDir: root, run: stub.run });
    await expect(reader.project(["https://example.test/not-an-issue"])).rejects.toThrow(
      "not a GitHub issue URL",
    );
  });
});

describe("issueLocator", () => {
  test("reads the repository and number from a GitHub issue URL", () => {
    expect(issueLocator("https://github.com/owner/name/issues/42")).toEqual({
      repository: "owner/name",
      number: 42,
    });
    expect(issueLocator("https://github.com/owner/name/issues/42/")).toEqual({
      repository: "owner/name",
      number: 42,
    });
    expect(issueLocator("https://gitlab.com/owner/name/issues/42")).toBeNull();
    expect(issueLocator("https://github.com/owner/name/pull/42")).toBeNull();
    expect(issueLocator("not a url")).toBeNull();
  });
});

describe("earliestRelease", () => {
  test("orders by publication time and breaks a tie by tag name", () => {
    const releases = [
      { tag: "v2.0.0", publishedAt: "2026-10-02T00:00:00Z" },
      { tag: "v1.5.0", publishedAt: "2026-10-01T00:00:00Z" },
      { tag: "v1.4.0", publishedAt: "2026-10-01T00:00:00Z" },
    ];
    expect(earliestRelease(releases, ["v2.0.0", "v1.5.0", "v1.4.0"])).toBe("v1.4.0");
    expect(earliestRelease(releases, [])).toBeNull();
  });

  test("shippedVersion is null for an open issue and for an unresolvable commit", async () => {
    const client = {
      calls: 0,
      async closingCommit() {
        client.calls += 1;
        return "abc1234";
      },
      async resolveCommit() {
        return null;
      },
      async containingReleaseTags() {
        return ["v1.0.0"];
      },
    };
    expect(
      await shippedVersion({ number: 1, state: "open" }, client, [
        { tag: "v1.0.0", publishedAt: "2026-10-01T00:00:00Z" },
      ]),
    ).toBeNull();
    expect(client.calls).toBe(0);
    expect(
      await shippedVersion({ number: 1, state: "closed" }, client, [
        { tag: "v1.0.0", publishedAt: "2026-10-01T00:00:00Z" },
      ]),
    ).toBeNull();
    expect(client.calls).toBe(1);
  });
});
