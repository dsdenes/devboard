import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import {
  checksumName,
  installRelease,
  ReleaseFeedError,
  ReleaseNotServedError,
  tarballName,
  type ReleaseInfo,
} from "../lib/release";
import type { Journal, JournalKind } from "./journal";
import {
  DEFAULT_UPDATE_INTERVAL_MS,
  DEFAULT_MAX_BACKOFF_MS,
  startUpdater,
  updateRetryDelay,
} from "./updates";

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = join(testRoot, `updates-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

async function installedPrefix(version: string): Promise<string> {
  const prefix = await temporaryDirectory();
  const directory = join(prefix, "node_modules", "@dsdenes", "devboard");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ version })}\n`);
  return prefix;
}

/** A release tarball and its checksum, named as the release assets expect. */
async function releaseArtifacts(
  version: string,
): Promise<{ tarball: string; checksum: string }> {
  const root = await temporaryDirectory();
  const packageDirectory = join(root, "package");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version })}\n`,
  );
  const tarball = join(root, tarballName(version));
  const packed = Bun.spawnSync({
    cmd: ["tar", "-czf", tarball, "-C", root, "package"],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode).toBe(0);
  const checksum = join(root, checksumName(version));
  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await writeFile(checksum, `${digest}  ${tarballName(version)}\n`);
  return { tarball, checksum };
}

function journalRecorder(): { journal: Journal; records: Array<[JournalKind, string]> } {
  const records: Array<[JournalKind, string]> = [];
  return {
    records,
    journal: { path: "test", write: (kind, text) => records.push([kind, text]) },
  };
}

function release(version: string): ReleaseInfo {
  return { version, tag: `v${version}`, assets: [] };
}

function manualSchedule() {
  const delays: number[] = [];
  const callbacks: Array<() => Promise<unknown> | void> = [];
  const cancelled: number[] = [];
  return {
    delays,
    cancelled,
    schedule: (run: () => Promise<unknown> | void, delayMs: number) => {
      const index = delays.length;
      delays.push(delayMs);
      callbacks.push(run);
      return {
        cancel: () => {
          cancelled.push(index);
        },
      };
    },
    async fire(index: number) {
      await callbacks[index]?.();
    },
  };
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("updateRetryDelay", () => {
  test("uses the base interval until a failure and then backs off", () => {
    expect(updateRetryDelay(0, 1000, 60_000)).toBe(1000);
    expect(updateRetryDelay(1, 1000, 60_000)).toBe(2000);
    expect(updateRetryDelay(2, 1000, 60_000)).toBe(4000);
    expect(updateRetryDelay(20, 1000, 60_000)).toBe(60_000);
  });

  test("defaults match the documented polling contract", () => {
    expect(DEFAULT_UPDATE_INTERVAL_MS).toBe(60_000);
    expect(DEFAULT_MAX_BACKOFF_MS).toBe(60 * 60_000);
  });
});

describe("startUpdater", () => {
  test("checks immediately, records an install, and reports the latest release", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal, records } = journalRecorder();
    const updates: string[] = [];
    let checks = 0;
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 60_000,
      startImmediately: false,
      fetchRelease: async () => {
        checks += 1;
        return release("0.1.1");
      },
      install: async (info) => {
        updates.push(info.version);
        return info.version;
      },
      onInstalled: (version) => updates.push(`callback:${version}`),
    });
    try {
      await updater.checkNow();
      expect(checks).toBe(1);
      expect(updater.latest()).toBe("0.1.1");
      expect(updates).toEqual(["0.1.1", "callback:0.1.1"]);
      expect(records).toEqual([["update", "installed 0.1.1 (was 0.1.0); a restart loads it"]]);
    } finally {
      updater.stop();
    }
  });

  test("records the fallback install version, never a filesystem path", async () => {
    const prefix = await installedPrefix("0.1.0");
    const stateDir = await temporaryDirectory();
    const artifacts = await releaseArtifacts("0.1.42");
    const tarballBytes = await readFile(artifacts.tarball);
    const checksumBytes = await readFile(artifacts.checksum);
    const realNpm = Bun.which("npm");
    if (realNpm === null) throw new Error("npm is not on PATH");
    const npm = join(stateDir, "outage-npm");
    await writeFile(
      npm,
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    @dsdenes/devboard@*) echo "simulated npm outage" >&2; exit 1 ;;
  esac
done
exec '${realNpm}' "$@"
`,
    );
    await chmod(npm, 0o755);
    const tarball = tarballName("0.1.42");
    const checksum = checksumName("0.1.42");
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/repos/acme/fixture/releases/tags/v0.1.42") {
          return Response.json({
            tag_name: "v0.1.42",
            assets: [
              { name: tarball, id: 11 },
              { name: checksum, id: 12 },
            ],
          });
        }
        const assets = "/api/v1/repos/acme/fixture/releases/assets";
        if (url.pathname === `${assets}/11`) {
          return new Response(tarballBytes, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        if (url.pathname === `${assets}/12`) return new Response(checksumBytes);
        return new Response("not found", { status: 404 });
      },
    });
    const { journal, records } = journalRecorder();
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir,
      currentVersion: "0.1.0",
      journal,
      startImmediately: false,
      source: {
        kind: "npm",
        env: { ...process.env, DEVBOARD_NPM: npm },
        fallback: {
          kind: "gitea",
          baseUrl: `http://127.0.0.1:${server.port}`,
          repo: "acme/fixture",
        },
      },
      fetchRelease: async () => release("0.1.42"),
    });
    try {
      expect(await updater.checkNow()).toBe("installed");
    } finally {
      updater.stop();
      server.stop(true);
    }
    expect(records).toEqual([
      ["update", "installed 0.1.42 (was 0.1.0); a restart loads it"],
    ]);
    const record = records[0]?.[1] ?? "";
    expect(record).not.toContain(prefix);
    expect(record).not.toContain(stateDir);
    expect(record).not.toContain("/");
    const manifest: unknown = JSON.parse(await readFile(join(prefix, "package.json"), "utf8"));
    if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) {
      throw new Error("prefix package.json has no dependencies");
    }
    expect(manifest.dependencies).toEqual({ "@dsdenes/devboard": "0.1.42" });
  }, 60_000);

  test("does not install into a prefix without the package", async () => {
    const prefix = await temporaryDirectory();
    const { journal } = journalRecorder();
    let installs = 0;
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: null,
      journal,
      startImmediately: false,
      fetchRelease: async () => release("0.1.4"),
      install: async () => {
        installs += 1;
        return "0.1.4";
      },
    });
    try {
      expect(await updater.checkNow()).toBe("not-installed");
      expect(installs).toBe(0);
      expect(updater.latest()).toBe("0.1.4");
    } finally {
      updater.stop();
    }
  });

  test("journals a failure and keeps the previous version", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal, records } = journalRecorder();
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 60_000,
      startImmediately: false,
      fetchRelease: async () => release("0.1.2"),
      install: async () => {
        throw new Error("checksum mismatch");
      },
    });
    try {
      expect(await updater.checkNow()).toBe("failed");
      expect(records).toEqual([
        ["update-error", "could not install 0.1.2: checksum mismatch"],
      ]);
    } finally {
      updater.stop();
    }
  });

  test("journals a registry artifact that has not propagated as context", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal, records } = journalRecorder();
    const manual = manualSchedule();
    const tarball =
      "https://registry.npmjs.org/@dsdenes/devboard/-/devboard-0.1.2.tgz";
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 1000,
      schedule: manual.schedule,
      fetchRelease: async () => release("0.1.2"),
      install: async () => {
        throw new ReleaseNotServedError(
          `npm does not serve the advertised @dsdenes/devboard@0.1.2 artifact yet: ${tarball}`,
        );
      },
    });
    await manual.fire(0);
    expect(records).toEqual([
      [
        "activity",
        `release install skipped: npm does not serve the advertised @dsdenes/devboard@0.1.2 artifact yet: ${tarball}`,
      ],
    ]);
    // A not-yet-served artifact backs off like any other failed check.
    expect(manual.delays).toEqual([0, 2000]);
    updater.stop();
  });

  test("journals a stalled download as an update-error and reschedules the check", async () => {
    const prefix = await installedPrefix("0.1.0");
    const stateDir = await temporaryDirectory();
    const sockets = new Set<Socket>();
    const stall = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((settle) => stall.listen(0, "127.0.0.1", () => settle()));
    const baseUrl = `http://127.0.0.1:${(stall.address() as AddressInfo).port}`;
    const { journal, records } = journalRecorder();
    const manual = manualSchedule();
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 1000,
      schedule: manual.schedule,
      fetchRelease: async () => ({
        version: "0.1.2",
        tag: "v0.1.2",
        assets: [
          {
            name: tarballName("0.1.2"),
            id: 11,
            browser_download_url: `${baseUrl}/stall/${tarballName("0.1.2")}`,
          },
          {
            name: checksumName("0.1.2"),
            id: 12,
            browser_download_url: `${baseUrl}/stall/${checksumName("0.1.2")}`,
          },
        ],
      }),
      install: (info) =>
        installRelease({
          source: { kind: "gitea", baseUrl, repo: "acme/fixture" },
          release: info,
          prefix,
          stateDir,
          downloadTimeoutMs: 500,
        }),
    });
    try {
      await manual.fire(0);
      expect(records).toEqual([
        [
          "update-error",
          "could not install 0.1.2: release asset download timed out after 500 ms: " +
            "devboard-0.1.2.tgz",
        ],
      ]);
      // The failed check schedules its own backoff retry, so a stalled
      // download never turns the update loop off.
      expect(manual.delays).toEqual([0, 2000]);
    } finally {
      updater.stop();
      for (const socket of sockets) socket.destroy();
      stall.close();
    }
  }, 20_000);

  test("journals an unreachable feed as context, never an update-error", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal, records } = journalRecorder();
    const manual = manualSchedule();
    const offline =
      'gh api releases/latest failed: Get "https://api.github.com/repos/dsdenes/devboard/releases/latest": ' +
      "dial tcp 140.82.121.5:443: connect: network is unreachable";
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 1000,
      schedule: manual.schedule,
      fetchRelease: async () => {
        throw new Error(offline);
      },
      install: async (info) => info.version,
    });
    await manual.fire(0);
    expect(records).toEqual([["activity", `release check skipped: ${offline}`]]);
    // The offline check still backs off instead of polling at the base interval.
    expect(manual.delays).toEqual([0, 2000]);
    updater.stop();
  });

  test("journals a rate-limited feed as context, never an update-error", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal, records } = journalRecorder();
    const manual = manualSchedule();
    const limited =
      "gh api releases/latest failed: gh: API rate limit exceeded for user ID 123850. " +
      "If you reach out to GitHub Support for help, please include the request ID " +
      "C078:C6E1C:11323A2:18BF786:6AE201F6.";
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 1000,
      schedule: manual.schedule,
      fetchRelease: async () => {
        throw new Error(limited);
      },
      install: async (info) => info.version,
    });
    await manual.fire(0);
    expect(records).toEqual([["activity", `release check skipped: ${limited}`]]);
    // The rate-limited check still backs off instead of polling at the base interval.
    expect(manual.delays).toEqual([0, 2000]);
    updater.stop();
  });

  test("journals a missing release client as context, never an update-error", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal, records } = journalRecorder();
    const manual = manualSchedule();
    const missing = Object.assign(
      new Error("ENOENT: no such file or directory, posix_spawn 'gh'"),
      { code: "ENOENT" },
    );
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 1000,
      schedule: manual.schedule,
      fetchRelease: async () => {
        throw missing;
      },
      install: async (info) => info.version,
    });
    await manual.fire(0);
    expect(records).toEqual([["activity", `release check skipped: ${missing.message}`]]);
    // The skipped check still backs off instead of polling at the base interval.
    expect(manual.delays).toEqual([0, 2000]);
    updater.stop();
  });

  test("journals an unreadable release description as context, never an update-error", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal, records } = journalRecorder();
    const manual = manualSchedule();
    const unreadable = new ReleaseFeedError(
      "gh returned an unreadable release description: unexpected gh arguments: api releases/latest",
    );
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 1000,
      schedule: manual.schedule,
      fetchRelease: async () => {
        throw unreadable;
      },
      install: async (info) => info.version,
    });
    await manual.fire(0);
    expect(records).toEqual([["activity", `release check skipped: ${unreadable.message}`]]);
    // The skipped check still backs off instead of polling at the base interval.
    expect(manual.delays).toEqual([0, 2000]);
    updater.stop();
  });

  test("journals a feed error that is not connectivity as an update-error", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal, records } = journalRecorder();
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      startImmediately: false,
      fetchRelease: async () => {
        throw new Error("gh api releases/latest failed: HTTP 401: Bad credentials");
      },
      install: async (info) => info.version,
    });
    try {
      expect(await updater.checkNow()).toBe("failed");
      expect(records).toEqual([
        [
          "update-error",
          "release check failed: gh api releases/latest failed: HTTP 401: Bad credentials",
        ],
      ]);
    } finally {
      updater.stop();
    }
  });

  test("single-flights concurrent checks", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal } = journalRecorder();
    let calls = 0;
    const gate = Promise.withResolvers<ReleaseInfo>();
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      startImmediately: false,
      fetchRelease: async () => {
        calls += 1;
        return gate.promise;
      },
      install: async (info) => info.version,
    });
    try {
      const first = updater.checkNow();
      const second = updater.checkNow();
      gate.resolve(release("0.1.5"));
      expect(await second).toBe("installed");
      expect(await first).toBe("installed");
      expect(calls).toBe(1);
    } finally {
      updater.stop();
    }
  });

  test("checks at the startup turn and then on the overridden interval", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal } = journalRecorder();
    const manual = manualSchedule();
    let calls = 0;
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 1000,
      schedule: manual.schedule,
      fetchRelease: async () => {
        calls += 1;
        return release("0.1.0");
      },
      install: async (info) => info.version,
    });
    await manual.fire(0);
    expect(calls).toBe(1);
    expect(manual.delays).toEqual([0, 1000]);
    await manual.fire(1);
    expect(calls).toBe(2);
    expect(manual.delays).toEqual([0, 1000, 1000]);
    updater.stop();
    expect(manual.cancelled).toEqual([2]);
  });

  test("backs off after a failure instead of retrying at the base interval", async () => {
    const prefix = await installedPrefix("0.1.0");
    const { journal } = journalRecorder();
    const manual = manualSchedule();
    let calls = 0;
    const updater = startUpdater({
      repoDir: prefix,
      prefixDir: prefix,
      stateDir: prefix,
      currentVersion: "0.1.0",
      journal,
      intervalMs: 1000,
      schedule: manual.schedule,
      fetchRelease: async () => {
        calls += 1;
        throw new Error("gh is not authenticated");
      },
      install: async (info) => info.version,
    });
    await manual.fire(0);
    expect(calls).toBe(1);
    expect(manual.delays).toEqual([0, 2000]);
    await manual.fire(1);
    expect(calls).toBe(2);
    expect(manual.delays).toEqual([0, 2000, 4000]);
    updater.stop();
  });
});
