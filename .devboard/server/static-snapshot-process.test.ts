import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotRoot } from "./static-snapshot";

/**
 * A real dashboard process over a fixture bundle: replacing the bundle while
 * it serves must not change what it answers, and a restart must pick the
 * replacement up.
 */

const SERVER = join(import.meta.dir, "index.ts");
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

interface Fixture {
  root: string;
  staticDir: string;
  stateDir: string;
  releases: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectory("snapshot-process-");
  const staticDir = join(root, "dist");
  const stateDir = join(root, "state");
  const releases = join(root, "releases");
  await mkdir(join(root, "adrs"), { recursive: true });
  await mkdir(releases, { recursive: true });
  await writeFile(join(root, "GOAL.md"), "# Goal\n\nServe the started release.\n");
  await writeBundle(staticDir, "release-one");
  return { root, staticDir, stateDir, releases };
}

async function writeBundle(directory: string, release: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "index.html"), `<!doctype html><title>${release}</title>`);
  await writeFile(join(directory, "app.js"), `console.log(${JSON.stringify(release)});\n`);
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port ?? 0;
}

interface RunningServer {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  url: string;
}

async function startProcess(fixture: Fixture): Promise<RunningServer> {
  const port = await freePort();
  const child = Bun.spawn({
    cmd: [process.execPath, SERVER],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ADRS_DIR: join(fixture.root, "adrs"),
      REPO_DIR: fixture.root,
      GOAL_FILE: join(fixture.root, "GOAL.md"),
      STATIC_DIR: fixture.staticDir,
      STATE_DIR: fixture.stateDir,
      DEVBOARD_RELEASE_DIR: fixture.releases,
      DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void drain(child.stdout);
  void drain(child.stderr);

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${url}/`);
      if (response.ok) {
        await response.text();
        return { child, url };
      }
    } catch {
      // The listener is not bound yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("the fixture dashboard did not answer");
    }
    // The dashboard is another process with no ready signal to await; poll its
    // listener instead of guessing a startup duration.
    await Bun.sleep(50);
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

async function stopProcess(server: RunningServer): Promise<void> {
  server.child.kill("SIGTERM");
  await server.child.exited;
}

async function body(server: RunningServer, path: string): Promise<string> {
  return (await fetch(`${server.url}${path}`)).text();
}

test("a running dashboard serves its started bundle until the process restarts", async () => {
  const fixture = await createFixture();
  const first = await startProcess(fixture);
  try {
    expect(await body(first, "/")).toBe("<!doctype html><title>release-one</title>");
    expect(await body(first, "/app.js")).toBe('console.log("release-one");\n');
    const serving = await readdir(snapshotRoot(fixture.stateDir));
    expect(serving.some((entry) => entry.startsWith(`${first.child.pid}-`))).toBe(true);

    // The installed tree is renamed away and the replacement moved in.
    await rm(fixture.staticDir, { recursive: true, force: true });
    await writeBundle(fixture.staticDir, "release-two");

    expect(await body(first, "/")).toBe("<!doctype html><title>release-one</title>");
    expect(await body(first, "/app.js")).toBe('console.log("release-one");\n');
  } finally {
    await stopProcess(first);
  }

  expect(existsSync(snapshotRoot(fixture.stateDir))).toBe(true);
  expect(await readdir(snapshotRoot(fixture.stateDir))).toEqual([]);

  const second = await startProcess(fixture);
  try {
    expect(await body(second, "/")).toBe("<!doctype html><title>release-two</title>");
    expect(await body(second, "/app.js")).toBe('console.log("release-two");\n');
  } finally {
    await stopProcess(second);
  }
  expect(await readdir(snapshotRoot(fixture.stateDir))).toEqual([]);
});
