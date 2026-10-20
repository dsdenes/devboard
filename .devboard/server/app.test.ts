import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";

const temporaryDirectories: string[] = [];
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "devboard-app-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function startServer(
  options: { goalText?: string; goalFile?: string; agentCommand?: string } = {},
) {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  await writeFile(join(adrDir, "0001-first.md"), "# First\n\n- Status: Accepted\n");
  if (options.goalText !== undefined) {
    await writeFile(options.goalFile ?? join(root, "GOAL.md"), options.goalText);
  }

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    goalFile: options.goalFile,
    agentCommand: options.agentCommand,
  });
  return { server, adrDir, root, url: `127.0.0.1:${server.port}` };
}

function exchange(url: string, command: unknown): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const socket = new WebSocket(`ws://${url}/ws`);

  socket.onopen = () => socket.send(JSON.stringify(command));
  socket.onmessage = (event) => {
    socket.close();
    try {
      resolve(JSON.parse(String(event.data)));
    } catch (error) {
      reject(error);
    }
  };
  socket.onerror = () => reject(new Error("websocket failed"));

  return promise;
}

function listRecords(url: string): Promise<unknown> {
  return exchange(url, { type: "listRecords" });
}

describe("createApp", () => {
  test("serves the built client at the root", async () => {
    const { server, url } = await startServer();

    try {
      const response = await fetch(`http://${url}/`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("<title>ADR overview</title>");
    } finally {
      server.stop(true);
    }
  });

  test("answers listRecords over the WebSocket", async () => {
    const { server, url } = await startServer();

    try {
      const message = await listRecords(url);

      expect(message).toEqual({
        type: "records",
        records: [
          {
            file: "0001-first.md",
            title: "First",
            status: "Accepted",
            pending: false,
          },
        ],
        next: null,
      });
    } finally {
      server.stop(true);
    }
  });

  test("re-reads the record directory for every command", async () => {
    const { server, adrDir, url } = await startServer();

    try {
      expect(await listRecords(url)).toMatchObject({ next: null });

      await writeFile(join(adrDir, "0002-added.md"), "# Added\n\n- Status: Proposed\n");
      expect(await listRecords(url)).toMatchObject({ next: "0002-added.md" });

      await rm(join(adrDir, "0002-added.md"));
      expect(await listRecords(url)).toMatchObject({ next: null });
    } finally {
      server.stop(true);
    }
  });

  test("answers getGoal with the complete goal file contents", async () => {
    const goalText = "Original goal\nsecond line\n";
    const { server, url } = await startServer({ goalText });

    try {
      expect(await exchange(url, { type: "getGoal" })).toEqual({ type: "goal", text: goalText });
    } finally {
      server.stop(true);
    }
  });

  test("writes the submitted goal text verbatim and reads it back", async () => {
    const goalFile = join(await temporaryDirectory(), "GOAL.md");
    const { server, url } = await startServer({ goalFile, goalText: "Original\n" });
    const edited = "  Edited goal\n\nthird line";

    try {
      expect(await exchange(url, { type: "saveGoal", text: edited })).toEqual({
        type: "goal",
        text: edited,
      });
      expect(await readFile(goalFile, "utf8")).toBe(edited);
      expect(await exchange(url, { type: "getGoal" })).toEqual({ type: "goal", text: edited });
    } finally {
      server.stop(true);
    }
  });

  test("reports a failed goal write and leaves the goal untouched", async () => {
    const goalFile = join(await temporaryDirectory(), "goal-directory");
    await mkdir(goalFile);
    const { server, url } = await startServer({ goalFile });

    try {
      const message = await exchange(url, { type: "saveGoal", text: "Edited goal" });

      expect(message).toEqual({ type: "error", message: expect.any(String) });
      expect((await stat(goalFile)).isDirectory()).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("does not start an agent while loading or saving the goal", async () => {
    const logPath = join(await temporaryDirectory(), "agent.log");
    const { server, url } = await startServer({
      goalText: "Goal\n",
      agentCommand: `bun ${STUB_AGENT} --log=${logPath}`,
    });

    try {
      await exchange(url, { type: "getGoal" });
      await exchange(url, { type: "saveGoal", text: "Edited goal" });

      expect(existsSync(logPath)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
