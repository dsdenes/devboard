import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp, projectLabel } from "./app";
import { journalFile } from "./journal";

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
  options: {
    goalText?: string;
    goalFile?: string;
    agentCommand?: string;
    restart?: () => void;
    versionState?: () => {
      running: string | null;
      installed: string | null;
      latest: string | null;
      stale: boolean;
    };
  } = {},
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
    stateDir: join(root, "state"),
    goalFile: options.goalFile,
    agentCommand: options.agentCommand,
    restart: options.restart,
    versionState: options.versionState,
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

describe("projectLabel", () => {
  test("names a project inside the home directory by its relative path", () => {
    const home = join(homedir(), "projects");

    expect(projectLabel(join(home, "devboard"), home)).toBe("devboard");
    expect(projectLabel(join(home, "nested", "dashboard"), home)).toBe(
      join("nested", "dashboard"),
    );
  });

  test("keeps the absolute path for a project outside the home directory", () => {
    const home = join(homedir(), "projects");
    const outside = resolve(home, "..", "elsewhere");

    expect(projectLabel(outside, home)).toBe(outside);
  });

  test("keeps the absolute path for the home directory itself", () => {
    const home = join(homedir(), "projects");

    expect(projectLabel(home, home)).toBe(home);
  });
});

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
            summary: "",
          },
        ],
        next: null,
      });
    } finally {
      server.stop(true);
    }
  });

  test("restarts once on request and refuses a concurrent restart", async () => {
    let restarts = 0;
    const { server, url } = await startServer({ restart: () => (restarts += 1) });

    try {
      expect(await exchange(url, { type: "restartServer" })).toEqual({
        type: "serverRestarting",
      });
      expect(restarts).toBe(1);
      expect(await exchange(url, { type: "restartServer" })).toEqual({
        type: "error",
        message: "A server restart is already in progress.",
      });
      expect(restarts).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("reports that restarting is unavailable without a launcher", async () => {
    const { server, url } = await startServer();

    try {
      expect(await exchange(url, { type: "restartServer" })).toEqual({
        type: "error",
        message: "Restarting the server is not available.",
      });
    } finally {
      server.stop(true);
    }
  });

  test("answers getVersion from the supplied probe", async () => {
    const { server, url } = await startServer({
      versionState: () => ({ running: "old", installed: "new", latest: "new", stale: true }),
    });

    try {
      expect(await exchange(url, { type: "getVersion" })).toEqual({
        type: "versionState",
        running: "old",
        installed: "new",
        latest: "new",
        stale: true,
      });
    } finally {
      server.stop(true);
    }
  });

  test("answers getProject with the project directory label", async () => {
    const { server, root, url } = await startServer();

    try {
      expect(await exchange(url, { type: "getProject" })).toEqual({
        type: "project",
        path: projectLabel(root),
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

/** One state document as the orchestrator writes it, with the root it serves. */
function orchestratorDocument(root: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    root,
    repo: "acme/fixture",
    status: "running",
    startedAt: "2026-10-27T10:00:00.000Z",
    finishedAt: null,
    open: 2,
    issues: [
      {
        number: 7,
        title: "First issue",
        url: "https://example.test/issues/7",
        createdAt: "2026-10-26T00:00:00Z",
      },
      {
        number: 8,
        title: "Second issue",
        url: "https://example.test/issues/8",
        createdAt: "2026-10-26T01:00:00Z",
      },
    ],
    lastExitCode: null,
    lastError: null,
    nextAttemptAt: null,
    updatedAt: "2026-10-27T10:00:01.000Z",
    ...overrides,
  };
}

function serverErrors(stateDir: string, root: string): string[] {
  const path = journalFile(stateDir, resolve(root));
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { kind?: string; text?: string })
    .filter((record) => record.kind === "server-error")
    .map((record) => record.text ?? "");
}

describe("getOrchestrator", () => {
  test("reports absence, not an error, when the state file is missing", async () => {
    const { server, root, url } = await startServer();

    try {
      expect(await exchange(url, { type: "getOrchestrator" })).toEqual({
        type: "orchestratorState",
        present: false,
      });
      expect(serverErrors(join(root, "state"), root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("reports absence for damaged bytes without a journal error", async () => {
    const { server, root, url } = await startServer();
    const stateDir = join(root, "state");
    await mkdir(join(stateDir, "orchestrator"), { recursive: true });
    await writeFile(join(stateDir, "orchestrator", "state.json"), '{"version": 1, "root":');

    try {
      expect(await exchange(url, { type: "getOrchestrator" })).toEqual({
        type: "orchestratorState",
        present: false,
      });
      expect(serverErrors(stateDir, root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("reports absence for an unsupported version", async () => {
    const { server, root, url } = await startServer();
    const stateDir = join(root, "state");
    await mkdir(join(stateDir, "orchestrator"), { recursive: true });
    await writeFile(
      join(stateDir, "orchestrator", "state.json"),
      JSON.stringify(orchestratorDocument(root, { version: 2 })),
    );

    try {
      expect(await exchange(url, { type: "getOrchestrator" })).toEqual({
        type: "orchestratorState",
        present: false,
      });
    } finally {
      server.stop(true);
    }
  });

  test("reports absence for a state file from another checkout", async () => {
    const { server, root, url } = await startServer();
    const stateDir = join(root, "state");
    await mkdir(join(stateDir, "orchestrator"), { recursive: true });
    await writeFile(
      join(stateDir, "orchestrator", "state.json"),
      JSON.stringify(orchestratorDocument(join(root, "elsewhere"))),
    );

    try {
      expect(await exchange(url, { type: "getOrchestrator" })).toEqual({
        type: "orchestratorState",
        present: false,
      });
    } finally {
      server.stop(true);
    }
  });

  test("reports the summary and never the issue list for a matching file", async () => {
    const { server, root, url } = await startServer();
    const stateDir = join(root, "state");
    await mkdir(join(stateDir, "orchestrator"), { recursive: true });
    await writeFile(
      join(stateDir, "orchestrator", "state.json"),
      JSON.stringify(orchestratorDocument(resolve(root))),
    );

    try {
      const message = await exchange(url, { type: "getOrchestrator" });

      expect(message).toEqual({
        type: "orchestratorState",
        present: true,
        repo: "acme/fixture",
        status: "running",
        open: 2,
        startedAt: "2026-10-27T10:00:00.000Z",
        finishedAt: null,
        lastExitCode: null,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: "2026-10-27T10:00:01.000Z",
      });
      expect(message).not.toHaveProperty("issues");
    } finally {
      server.stop(true);
    }
  });
});
