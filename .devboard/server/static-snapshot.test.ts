import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";
import { testProviderService } from "./fixtures/test-providers";
import {
  pruneStaticSnapshots,
  snapshotName,
  snapshotRoot,
  snapshotStaticDir,
} from "./static-snapshot";

const temporaryRoot = join(import.meta.dir, "..", ".tmp");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function bundleIndex(release: string): string {
  return `<!doctype html><title>${release}</title>`;
}

function bundleScript(release: string): string {
  return `console.log(${JSON.stringify(release)});\n`;
}

async function writeBundle(directory: string, release: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.html"), bundleIndex(release));
  await writeFile(join(directory, "app.js"), bundleScript(release));
}

async function startServer(root: string, staticDir: string) {
  return createApp({
    adrDir: join(root, "adrs"),
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    stateDir: join(root, "state"),
    providers: testProviderService(join(root, "state")),
  });
}

function served(server: { port?: number }, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`);
}

describe("static bundle snapshot", () => {
  test("a running server keeps the bytes it started with after the source bundle is replaced", async () => {
    const root = await temporaryDirectory("snapshot-");
    const source = join(root, "dist");
    const stateDir = join(root, "state");
    await mkdir(join(root, "adrs"), { recursive: true });
    await writeBundle(source, "release-one");

    const first = await snapshotStaticDir({ staticDir: source, stateDir, version: "1.0.0" });
    expect(first.dir).toBe(join(snapshotRoot(stateDir), snapshotName(process.pid, "1.0.0")));
    const server = await startServer(root, first.dir);
    try {
      expect(await (await served(server, "/")).text()).toBe(bundleIndex("release-one"));
      expect(await (await served(server, "/app.js")).text()).toBe(bundleScript("release-one"));

      // An update renames the installed tree away and moves a new one in.
      await rm(source, { recursive: true, force: true });
      await writeBundle(source, "release-two");

      expect(await (await served(server, "/")).text()).toBe(bundleIndex("release-one"));
      expect(await (await served(server, "/app.js")).text()).toBe(bundleScript("release-one"));
    } finally {
      server.stop(true);
      await first.remove();
    }
    expect(existsSync(first.dir)).toBe(false);

    // A restart starts from the replaced bundle, so the reload control is still
    // the only path to the new client.
    const second = await snapshotStaticDir({ staticDir: source, stateDir, version: "2.0.0" });
    const restarted = await startServer(root, second.dir);
    try {
      expect(await (await served(restarted, "/")).text()).toBe(bundleIndex("release-two"));
    } finally {
      restarted.stop(true);
      await second.remove();
    }
  });

  test("startup pruning removes dead and own snapshots but keeps a live process's copy", async () => {
    const root = await temporaryDirectory("prune-");
    const stateDir = join(root, "state");
    const rootDir = snapshotRoot(stateDir);
    const live = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const liveDir = join(rootDir, snapshotName(live.pid, "2.0.0"));
      const deadDir = join(rootDir, snapshotName(999_999, "1.0.0"));
      const ownDir = join(rootDir, snapshotName(process.pid, "1.0.0"));
      for (const directory of [liveDir, deadDir, ownDir]) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "index.html"), "<!doctype html><title>stale</title>");
      }

      const removed = await pruneStaticSnapshots(stateDir);

      expect(removed).toContain(snapshotName(999_999, "1.0.0"));
      expect(removed).toContain(snapshotName(process.pid, "1.0.0"));
      expect(removed).not.toContain(snapshotName(live.pid, "2.0.0"));
      expect(existsSync(deadDir)).toBe(false);
      expect(existsSync(ownDir)).toBe(false);
      expect(existsSync(liveDir)).toBe(true);
    } finally {
      live.kill();
      await live.exited;
    }
  });

  test("a bundle that cannot be copied fails the start without leaving a snapshot", async () => {
    const root = await temporaryDirectory("snapshot-missing-");
    const stateDir = join(root, "state");

    await expect(
      snapshotStaticDir({ staticDir: join(root, "absent"), stateDir, version: "1.0.0" }),
    ).rejects.toThrow("Could not snapshot the static bundle");
    expect(await readdir(snapshotRoot(stateDir))).toEqual([]);
  });
});
