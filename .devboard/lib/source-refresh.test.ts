import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Instance } from "../watchdog/discovery";
import {
  DEFAULT_SOURCE_REFRESH_INTERVAL_MS,
  MIN_SOURCE_REFRESH_INTERVAL_MS,
  alreadyAppliedSourceRefresh,
  deliverSourceRefresh,
  distDigest,
  parseSourceRefreshRequest,
  readAppliedSourceRefresh,
  readSourceRefreshRequest,
  sourceRefreshIntervalMs,
  sourceRefreshRequestPath,
  writeAppliedSourceRefresh,
  writeSourceRefreshRequest,
  type SourceRefreshRequest,
} from "./source-refresh";

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = join(testRoot, `source-refresh-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  directories.push(directory);
  return directory;
}

async function writeFileAt(root: string, relative: string, text: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
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

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("source refresh request", () => {
  test("accepts a well-formed request and rejects every malformed shape", () => {
    expect(parseSourceRefreshRequest(request())).toEqual(request());
    expect(parseSourceRefreshRequest({ ...request(), schema: 2 })).toBeNull();
    expect(parseSourceRefreshRequest({ ...request(), commit: "nope" })).toBeNull();
    expect(parseSourceRefreshRequest({ ...request(), version: "" })).toBeNull();
    expect(parseSourceRefreshRequest({ ...request(), distDigest: "short" })).toBeNull();
    expect(parseSourceRefreshRequest({ ...request(), requestedAt: "" })).toBeNull();
    expect(parseSourceRefreshRequest("request")).toBeNull();
    expect(parseSourceRefreshRequest(null)).toBeNull();
  });

  test("round-trips a request atomically and reports a missing file as idle", async () => {
    const stateDir = await temporaryDirectory();
    expect(readSourceRefreshRequest(stateDir)).toEqual({ state: "missing" });
    writeSourceRefreshRequest(stateDir, request());
    expect(readSourceRefreshRequest(stateDir).state).toBe("valid");
    expect(JSON.parse(await readFile(sourceRefreshRequestPath(stateDir), "utf8"))).toEqual(
      request(),
    );
  });

  test("reports unreadable documents with a stable key", async () => {
    const stateDir = await temporaryDirectory();
    await writeFileAt(stateDir, "source-refresh/request.json", "{ not json");
    const first = readSourceRefreshRequest(stateDir);
    const second = readSourceRefreshRequest(stateDir);
    expect(first.state).toBe("invalid");
    expect(second.state).toBe("invalid");
    expect(first.state === "invalid" ? first.key : "").toBe(
      second.state === "invalid" ? second.key : "different",
    );
  });

  test("never applies the same published commit twice", () => {
    const stateDirApplied = {
      commit: request().commit,
      version: request().version,
      distDigest: request().distDigest,
      appliedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(alreadyAppliedSourceRefresh(stateDirApplied, request())).toBe(true);
    expect(
      alreadyAppliedSourceRefresh(stateDirApplied, request({ version: "0.9.2" })),
    ).toBe(true);
    expect(
      alreadyAppliedSourceRefresh(
        stateDirApplied,
        request({ commit: "fedcba9876543210fedcba9876543210fedcba98" }),
      ),
    ).toBe(false);
    expect(alreadyAppliedSourceRefresh(null, request())).toBe(false);
  });

  test("records the applied request so a re-delivery is recognized", async () => {
    const stateDir = await temporaryDirectory();
    expect(readAppliedSourceRefresh(stateDir)).toBeNull();
    writeAppliedSourceRefresh(stateDir, request(), "2026-01-02T00:00:00.000Z");
    expect(readAppliedSourceRefresh(stateDir)).toEqual({
      commit: request().commit,
      version: request().version,
      distDigest: request().distDigest,
      appliedAt: "2026-01-02T00:00:00.000Z",
    });
  });
});

describe("distDigest", () => {
  test("is deterministic and changes with any file name, content, or addition", async () => {
    const root = await temporaryDirectory();
    await writeFileAt(root, "index.html", "<html>one</html>\n");
    await writeFileAt(root, "assets/app-1.js", "console.log(1);\n");
    const first = distDigest(root);
    expect(distDigest(root)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    await writeFileAt(root, "assets/app-1.js", "console.log(2);\n");
    const edited = distDigest(root);
    expect(edited).not.toBe(first);

    await writeFileAt(root, "assets/app-2.js", "console.log(2);\n");
    const added = distDigest(root);
    expect(added).not.toBe(edited);

    await rm(join(root, "assets/app-2.js"));
    expect(distDigest(root)).toBe(edited);
  });

  test("refuses a missing bundle directory", async () => {
    const root = await temporaryDirectory();
    expect(() => distDigest(join(root, "missing"))).toThrow("bundle directory is missing");
  });
});

describe("sourceRefreshIntervalMs", () => {
  test("defaults to one minute, honors the environment, and never polls below one second", () => {
    expect(sourceRefreshIntervalMs({})).toBe(DEFAULT_SOURCE_REFRESH_INTERVAL_MS);
    expect(sourceRefreshIntervalMs({ DEVBOARD_SOURCE_REFRESH_INTERVAL_MS: "2500" })).toBe(2500);
    expect(sourceRefreshIntervalMs({ DEVBOARD_SOURCE_REFRESH_INTERVAL_MS: "50" })).toBe(
      MIN_SOURCE_REFRESH_INTERVAL_MS,
    );
    expect(sourceRefreshIntervalMs({ DEVBOARD_SOURCE_REFRESH_INTERVAL_MS: "nope" })).toBe(
      DEFAULT_SOURCE_REFRESH_INTERVAL_MS,
    );
  });
});

function instance(
  repoDir: string,
  harness: string,
  stateDir: string,
  port: number,
): Instance {
  return {
    pid: 1000 + port,
    port,
    repoDir,
    host: "127.0.0.1",
    harness,
    stateDir,
    journal: join(stateDir, "journal", "key.jsonl"),
    instrumented: false,
  };
}

describe("deliverSourceRefresh", () => {
  async function checkout(): Promise<{ repo: string; harness: string; dist: string }> {
    const repo = await temporaryDirectory();
    const harness = join(repo, ".devboard");
    await mkdir(harness, { recursive: true });
    await writeFile(
      join(harness, "package.json"),
      `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" })}\n`,
    );
    const dist = join(harness, "dist");
    await writeFileAt(dist, "index.html", "<html>built</html>\n");
    await writeFileAt(dist, "assets/app-1.js", "console.log(1);\n");
    return { repo, harness, dist };
  }

  test("writes one request per source dashboard of the checkout and none for other harnesses", async () => {
    const { repo, harness, dist } = await checkout();
    const first = join(repo, "state-a");
    const second = join(repo, "state-b");
    const other = await temporaryDirectory();
    const delivery = deliverSourceRefresh({
      repoRoot: repo,
      harnessRoot: harness,
      commit: request().commit,
      version: "0.9.1",
      instances: [
        instance(repo, harness, first, 4101),
        instance(repo, harness, second, 4102),
        instance(repo, join(repo, "node_modules", "@dsdenes", "devboard"), first, 4103),
        instance(other, harness, join(other, "state"), 4104),
      ],
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(delivery.written.map((entry) => entry.port).sort()).toEqual([4101, 4102]);
    expect(delivery.digest).toBe(distDigest(dist));
    for (const stateDir of [first, second]) {
      const read = readSourceRefreshRequest(stateDir);
      expect(read.state).toBe("valid");
      expect(read.state === "valid" ? read.request : undefined).toEqual({
        schema: 1,
        commit: request().commit,
        version: "0.9.1",
        distDigest: distDigest(dist),
        requestedAt: "2026-01-01T00:00:00.000Z",
      });
    }
  });

  test("writes one file when two dashboards share a state directory", async () => {
    const { repo, harness } = await checkout();
    const shared = join(repo, "shared-state");
    const delivery = deliverSourceRefresh({
      repoRoot: repo,
      harnessRoot: harness,
      commit: request().commit,
      version: "0.9.1",
      instances: [
        instance(repo, harness, shared, 4201),
        instance(repo, harness, shared, 4202),
      ],
    });
    expect(delivery.written.map((entry) => entry.port)).toEqual([4201, 4202]);
    expect(readSourceRefreshRequest(shared).state).toBe("valid");
  });

  test("reports an unwritable state directory and still delivers to the rest", async () => {
    const { repo, harness } = await checkout();
    const unwritable = join(repo, "state-file");
    await writeFile(unwritable, "not a directory\n");
    const healthy = join(repo, "state-healthy");
    const delivery = deliverSourceRefresh({
      repoRoot: repo,
      harnessRoot: harness,
      commit: request().commit,
      version: "0.9.1",
      instances: [
        instance(repo, harness, unwritable, 4401),
        instance(repo, harness, healthy, 4402),
      ],
    });

    expect(delivery.failed).toHaveLength(1);
    expect(delivery.failed[0]?.stateDir).toBe(resolve(unwritable));
    expect(delivery.failed[0]?.port).toBe(4401);
    expect(delivery.failed[0]?.pid).toBe(1000 + 4401);
    expect(delivery.failed[0]?.error).toContain(join(unwritable, "source-refresh"));
    expect(delivery.written.map((entry) => entry.port)).toEqual([4402]);
    expect(readSourceRefreshRequest(healthy).state).toBe("valid");
  });

  test("writes nothing for a host that installed a harness package", async () => {
    const repo = await temporaryDirectory();
    const harness = join(repo, ".devboard");
    const installed = join(harness, "node_modules", "@dsdenes", "devboard");
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(harness, "package.json"),
      `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.9.1" })}\n`,
    );
    await writeFileAt(join(harness, "dist"), "index.html", "<html>installed</html>\n");
    const stateDir = join(repo, "state");
    const delivery = deliverSourceRefresh({
      repoRoot: repo,
      harnessRoot: harness,
      commit: request().commit,
      version: "0.9.1",
      instances: [instance(repo, harness, stateDir, 4301)],
    });
    expect(delivery.written).toEqual([]);
    expect(readSourceRefreshRequest(stateDir)).toEqual({ state: "missing" });
  });
});
