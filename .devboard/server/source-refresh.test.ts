import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  distDigest,
  writeAppliedSourceRefresh,
  writeSourceRefreshRequest,
  type SourceRefreshRequest,
} from "../lib/source-refresh";
import type { Journal, JournalKind } from "./journal";
import { startSourceRefresher, type SourceRefresher } from "./source-refresh";

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const directories: string[] = [];
const refreshers: SourceRefresher[] = [];

async function fixture(): Promise<{ stateDir: string; distDir: string; digest: string }> {
  await mkdir(testRoot, { recursive: true });
  const root = join(testRoot, `source-refresher-${randomUUID()}`);
  const stateDir = join(root, "state");
  const distDir = join(root, "dist");
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(join(distDir, "index.html"), "<html>built</html>\n");
  await writeFile(join(distDir, "assets", "app.js"), "console.log(1);\n");
  directories.push(root);
  return { stateDir, distDir, digest: distDigest(distDir) };
}

function request(overrides: Partial<SourceRefreshRequest> = {}): SourceRefreshRequest {
  return {
    schema: 1,
    commit: "0123456789abcdef0123456789abcdef01234567",
    version: "0.9.1",
    distDigest: "a".repeat(64),
    requestedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function journal(): Journal & { records: Array<{ kind: JournalKind; text: string }> } {
  const records: Array<{ kind: JournalKind; text: string }> = [];
  return {
    path: "memory",
    records,
    write(kind, text) {
      records.push({ kind, text });
    },
  };
}

function refresher(
  options: Parameters<typeof startSourceRefresher>[0],
): SourceRefresher {
  const started = startSourceRefresher({ startImmediately: false, ...options });
  refreshers.push(started);
  return started;
}

afterAll(async () => {
  for (const started of refreshers) started.stop();
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("source refresher", () => {
  test("does nothing without a request", async () => {
    const { stateDir, distDir } = await fixture();
    const log = journal();
    let replacements = 0;
    const started = refresher({
      stateDir,
      distDir,
      journal: log,
      replace: async () => {
        replacements += 1;
      },
    });
    expect(await started.checkNow()).toBe("idle");
    expect(replacements).toBe(0);
    expect(log.records.filter((record) => record.kind !== "activity")).toEqual([]);
  });

  test("replaces once for a valid request and never again for the same commit", async () => {
    const { stateDir, distDir, digest } = await fixture();
    const log = journal();
    const applied: string[] = [];
    const started = refresher({
      stateDir,
      distDir,
      journal: log,
      replace: async (received) => {
        applied.push(received.commit);
        writeAppliedSourceRefresh(stateDir, received);
      },
    });
    writeSourceRefreshRequest(stateDir, request({ distDigest: digest }));
    expect(await started.checkNow()).toBe("refreshed");
    expect(applied).toEqual([request().commit]);
    // Re-delivering the identical request, or a newer publish of the same
    // revision, must not restart again.
    writeSourceRefreshRequest(stateDir, request({ distDigest: digest, version: "0.9.2" }));
    expect(await started.checkNow()).toBe("idle");
    expect(applied).toEqual([request().commit]);
    expect(log.records.filter((record) => record.kind === "update")).toHaveLength(1);
  });

  test("journals an invalid request once and never replaces", async () => {
    const { stateDir, distDir } = await fixture();
    const log = journal();
    let replacements = 0;
    const started = refresher({
      stateDir,
      distDir,
      journal: log,
      replace: async () => {
        replacements += 1;
      },
    });
    await mkdir(join(stateDir, "source-refresh"), { recursive: true });
    await writeFile(join(stateDir, "source-refresh", "request.json"), "{ broken");
    expect(await started.checkNow()).toBe("invalid");
    expect(await started.checkNow()).toBe("invalid");
    expect(replacements).toBe(0);
    const failures = log.records.filter((record) => record.kind === "update-error");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.text).toContain("source refresh ignored");
  });

  test("journals a digest mismatch once and never replaces", async () => {
    const { stateDir, distDir } = await fixture();
    const log = journal();
    let replacements = 0;
    const started = refresher({
      stateDir,
      distDir,
      journal: log,
      replace: async () => {
        replacements += 1;
      },
    });
    writeSourceRefreshRequest(stateDir, request());
    expect(await started.checkNow()).toBe("digest-mismatch");
    expect(await started.checkNow()).toBe("digest-mismatch");
    expect(replacements).toBe(0);
    const failures = log.records.filter((record) => record.kind === "update-error");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.text).toContain("not the requested");
  });

  test("journals each failed attempt and retries the pending request", async () => {
    const { stateDir, distDir, digest } = await fixture();
    const log = journal();
    let attempts = 0;
    const started = refresher({
      stateDir,
      distDir,
      journal: log,
      replace: async (received) => {
        attempts += 1;
        if (attempts === 1) throw new Error("replacement did not become ready");
        writeAppliedSourceRefresh(stateDir, received);
      },
    });
    writeSourceRefreshRequest(stateDir, request({ distDigest: digest }));
    expect(await started.checkNow()).toBe("failed");
    expect(await started.checkNow()).toBe("refreshed");
    expect(attempts).toBe(2);
    expect(log.records.filter((record) => record.kind === "update-error")).toHaveLength(1);
    expect(log.records.filter((record) => record.kind === "update")).toHaveLength(2);
  });

  test("a newer publish request supersedes a pending failure", async () => {
    const { stateDir, distDir, digest } = await fixture();
    const log = journal();
    const applied: string[] = [];
    const started = refresher({
      stateDir,
      distDir,
      journal: log,
      replace: async (received) => {
        if (received.commit === request().commit) throw new Error("stubbed failure");
        applied.push(received.commit);
        writeAppliedSourceRefresh(stateDir, received);
      },
    });
    writeSourceRefreshRequest(stateDir, request({ distDigest: digest }));
    expect(await started.checkNow()).toBe("failed");
    const newer = "fedcba9876543210fedcba9876543210fedcba98";
    writeSourceRefreshRequest(stateDir, request({ commit: newer, distDigest: digest }));
    expect(await started.checkNow()).toBe("refreshed");
    expect(applied).toEqual([newer]);
  });

  test("schedules the first check immediately and then the fixed interval", async () => {
    const { stateDir, distDir } = await fixture();
    const delays: number[] = [];
    const started = refresher({
      stateDir,
      distDir,
      journal: journal(),
      replace: async () => {},
      intervalMs: 2_500,
      startImmediately: true,
      schedule: (_run, delayMs) => {
        delays.push(delayMs);
        return { cancel: () => {} };
      },
    });
    expect(delays).toEqual([0]);
    started.stop();
  });

  test("a replacement's first check waits one interval", async () => {
    const { stateDir, distDir } = await fixture();
    const delays: number[] = [];
    const started = refresher({
      stateDir,
      distDir,
      journal: journal(),
      replace: async () => {},
      intervalMs: 2_500,
      startImmediately: false,
      schedule: (_run, delayMs) => {
        delays.push(delayMs);
        return { cancel: () => {} };
      },
    });
    expect(delays).toEqual([2_500]);
    started.stop();
  });

  test("uses the default interval and the environment minimum", async () => {
    const { stateDir, distDir } = await fixture();
    const delays: number[] = [];
    const started = refresher({
      stateDir,
      distDir,
      journal: journal(),
      replace: async () => {},
      env: { DEVBOARD_SOURCE_REFRESH_INTERVAL_MS: "10" },
      startImmediately: true,
      schedule: (_run, delayMs) => {
        delays.push(delayMs);
        return { cancel: () => {} };
      },
    });
    expect(started.intervalMs).toBe(1_000);
    expect(delays).toEqual([0]);
    started.stop();

    const another = refresher({
      stateDir,
      distDir,
      journal: journal(),
      replace: async () => {},
      env: {},
      startImmediately: false,
    });
    expect(another.intervalMs).toBe(60_000);
    another.stop();
  });

  test("shares one in-flight check and stops scheduling after stop", async () => {
    const { stateDir, distDir, digest } = await fixture();
    let replacements = 0;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    const started = refresher({
      stateDir,
      distDir,
      journal: journal(),
      replace: async () => {
        replacements += 1;
        await promise;
      },
    });
    writeSourceRefreshRequest(stateDir, request({ distDigest: digest }));
    const first = started.checkNow();
    const second = started.checkNow();
    expect(first).toBe(second);
    release();
    expect(await first).toBe("refreshed");
    expect(replacements).toBe(1);
    started.stop();
    expect(await started.checkNow()).toBe("stopped");
  });
});
