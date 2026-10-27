import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createApp } from "../server/app";
import { saveLedger, type Ledger } from "../watchdog/ledger";
import { readWatchdogStatus } from "../watchdog/status";

/**
 * `GET /api/watchdog` is read-only: it reports the newest cycle and the filed
 * issues and never an environment value. Fixtures live under `.devboard/.tmp`.
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

async function watchdogDirectory(): Promise<string> {
  const root = await temporaryDirectory("test-watchdog-api");
  const directory = join(root, "watchdog");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "latest.json"), JSON.stringify(latestFixture()));
  saveLedger(directory, ledgerFixture());
  return directory;
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
  });
});

describe("GET /api/watchdog", () => {
  test("returns the cycle, issues, and counts without any environment value", async () => {
    const directory = await watchdogDirectory();
    const root = resolve(directory, "..");
    const stateDir = join(root, "state");
    await mkdir(join(stateDir, "watchdog"), { recursive: true });
    await writeFile(
      join(stateDir, "watchdog", "latest.json"),
      JSON.stringify(latestFixture()),
    );
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
        "findings",
        "issues",
        "pending",
        "reason",
      ]);
      expect(body.cycle).toBe("2026-10-24T12:00:00.000Z");
      expect(body.action).toBe("filed");
      expect(body.findings).toBe(1);
      expect(body.pending).toBe(1);
      expect(body.issues).toEqual([
        { url: second.url, category: "stall", line: second.line, filedAt: second.filedAt },
        { url: first.url, category: first.category, line: first.line, filedAt: first.filedAt },
      ]);
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
