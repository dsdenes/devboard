import { fixtureRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp, projectLabel } from "./app";
import { journalFile, journalKey } from "./journal";
import { acquireLock } from "../issues/lock";
import { testProviderService } from "./fixtures/test-providers";

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
    runningVersion?: string | null;
    /** Installs this checkout's `origin` before the app resolves it. */
    origin?: string;
    issues?: {
      closeIssue?: (request: {
        repoDir: string;
        repository: string;
        number: number;
      }) => Promise<void>;
    };
  } = {},
) {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  await writeFile(join(adrDir, "0001-first.md"), fixtureRecord("0001-first.md", "First"));
  if (options.origin !== undefined) {
    Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
    Bun.spawnSync({ cmd: ["git", "-C", root, "remote", "add", "origin", options.origin] });
  }
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
    providers: testProviderService(join(root, "state")),
    goalFile: options.goalFile,
    agentCommand: options.agentCommand,
    restart: options.restart,
    versionState: options.versionState,
    runningVersion: options.runningVersion,
    ...(options.issues === undefined ? {} : { issues: options.issues }),
  });
  return { server, adrDir, root, url: `127.0.0.1:${server.port}` };
}

function exchange(url: string, command: unknown): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const socket = new WebSocket(`ws://${url}/ws`);

  socket.onopen = () => socket.send(JSON.stringify(command));
  const answer = (command as { type?: unknown }).type === "getIssues";
  socket.onmessage = (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch (error) {
      socket.close();
      reject(error);
      return;
    }
    const type = (message as { type?: unknown }).type;
    // A connection-level worker replay precedes this client's own reply.
    if (
      !answer &&
      (type === "issuesState" ||
        type === "issuesActivity" ||
        type === "scoutState" ||
        type === "scoutActivity")
    ) {
      return;
    }
    socket.close();
    resolve(message);
  };
  socket.onerror = () => reject(new Error("websocket failed"));

  return promise;
}

/**
 * Collects socket frames until `done` accepts them. The guard timer only keeps
 * a broken contract from hanging the suite; the assertion is the predicate.
 */
function collect(
  url: string,
  command: unknown,
  done: (messages: unknown[]) => boolean,
): Promise<unknown[]> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const messages: unknown[] = [];
  const guard = setTimeout(() => {
    socket.close();
    reject(new Error("websocket frames did not arrive"));
  }, 5000);
  socket.onopen = () => socket.send(JSON.stringify(command));
  socket.onmessage = (event) => {
    try {
      messages.push(JSON.parse(String(event.data)));
    } catch (error) {
      clearTimeout(guard);
      socket.close();
      reject(error);
      return;
    }
    if (!done(messages)) return;
    clearTimeout(guard);
    socket.close();
    resolve(messages);
  };
  socket.onerror = () => {
    clearTimeout(guard);
    reject(new Error("websocket failed"));
  };
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

  test("keeps serving after a failed restart", async () => {
    const { server, url } = await startServer({
      restart: () => {
        throw new Error("spawn failed");
      },
    });

    try {
      const messages = await collect(
        url,
        { type: "restartServer" },
        (frames) =>
          frames.some(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              "type" in frame &&
              frame.type === "error",
          ),
      );
      expect(messages.at(-1)).toEqual({
        type: "error",
        message: "Could not restart the server: spawn failed",
      });
      expect(await listRecords(url)).toMatchObject({ type: "records" });
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
        feedbackEnabled: false,
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

      await writeFile(join(adrDir, "0002-added.md"), fixtureRecord("0002-added.md", "Added", "proposed"));
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

/** One issues state document as the worker writes it, scoped to `repoDir`. */
function issuesDocument(repoDir: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    repo: "acme/fixture",
    root: resolve(repoDir),
    lifecycle: "running",
    enabled: true,
    paused: false,
    worker: {
      pid: process.pid,
      startedAt: "2026-10-27T10:00:00.000Z",
      stateDir: "",
      harnessVersion: "0.1.0",
      argv: ["bun", "issues/worker.ts"],
    },
    poll: {
      intervalMs: 2000,
      lastPollAt: "2026-10-27T10:00:00.000Z",
      nextPollAt: "2026-10-27T10:00:02.000Z",
      etag: '"etag"',
      notModified: false,
      rateLimitedUntil: null,
      error: null,
    },
    queue: [
      {
        number: 7,
        title: "First issue",
        url: "https://github.com/acme/fixture/issues/7",
        createdAt: "2026-10-26T00:00:00Z",
        handled: false,
        runId: null,
        agentRunId: "2026-10-27T10-00-01-000Z",
      },
      {
        number: 8,
        title: "Second issue",
        url: "https://github.com/acme/fixture/issues/8",
        createdAt: "2026-10-26T01:00:00Z",
        handled: true,
        runId: "2026-10-27T09-00-00-000Z",
        agentRunId: null,
      },
      {
        number: 9,
        title: "Third issue",
        url: "https://github.com/acme/fixture/issues/9",
        createdAt: "2026-10-26T02:00:00Z",
        handled: false,
        runId: null,
        agentRunId: "2026-10-27T10-00-02-000Z",
      },
    ],
    runs: [
      {
        runId: "2026-10-27T09-00-00-000Z",
        status: "succeeded",
        startedAt: "2026-10-27T09:00:00.000Z",
        finishedAt: "2026-10-27T09:01:00.000Z",
        exitCode: 0,
        issueNumbers: [8],
        activity: 1,
        firstStderrLine: null,
      },
      {
        runId: "2026-10-27T10-00-01-000Z",
        status: "running",
        startedAt: "2026-10-27T10:00:00.000Z",
        finishedAt: null,
        exitCode: null,
        issueNumbers: [7],
        activity: 2,
        firstStderrLine: null,
      },
      {
        runId: "2026-10-27T10-00-02-000Z",
        status: "running",
        startedAt: "2026-10-27T10:00:00.000Z",
        finishedAt: null,
        exitCode: null,
        issueNumbers: [9],
        activity: 1,
        firstStderrLine: null,
      },
    ],
    agents: [
      {
        runId: "2026-10-27T10-00-01-000Z",
        issueNumber: 7,
        startedAt: "2026-10-27T10:00:00.000Z",
        question: null,
        acp: { pid: process.pid, argv: ["omp", "acp"], cwd: resolve(repoDir) },
      },
      {
        runId: "2026-10-27T10-00-02-000Z",
        issueNumber: 9,
        startedAt: "2026-10-27T10:00:00.000Z",
        question: {
          id: 5,
          message: "Which scope?",
          options: [],
        },
        acp: null,
      },
    ],
    cooldowns: { "10": "2026-10-27T10:05:00.000Z" },
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    updatedAt: "2026-10-27T10:00:01.000Z",
    ...overrides,
  };
}

/** Seeds the repo-scoped state and the repo-anchored lock, as a worker would. */
async function seedIssues(root: string, overrides: Record<string, unknown> = {}) {
  const stateDir = join(root, "state");
  const directory = join(stateDir, "issues", journalKey(resolve(root)));
  await mkdir(directory, { recursive: true });
  const document = issuesDocument(root, overrides);
  const worker = document.worker as Record<string, unknown>;
  worker.stateDir = stateDir;
  await writeFile(join(directory, "state.json"), JSON.stringify(document));
  const lock = acquireLock(join(root, ".devboard", ".tmp", "issues", "lock"), {
    repo: resolve(root),
    stateDir,
    harnessVersion: "0.1.0",
    argv: ["bun", "issues/worker.ts"],
  });
  expect(lock.acquired).toBe(true);
  return { stateDir, directory, document, lock };
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

describe("issues protocol", () => {
  test("opens stopped, not an error, when no worker state exists", async () => {
    const { server, root, url } = await startServer();

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.type).toBe("issuesState");
      expect(message.present).toBe(false);
      expect(message.lifecycle).toBe("stopped");
      expect(message.enabled).toBe(false);
      expect(message.attached).toBe(false);
      expect(message.repo).toBeNull();
      expect(serverErrors(join(root, "state"), root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("replays the checkout origin on connect before any worker exists", async () => {
    const { server, url } = await startServer({
      origin: "https://github.com/acme/fixture.git",
    });

    try {
      const frames = await collect(url, { type: "getProject" }, (messages) =>
        messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "scoutState",
        ),
      );
      const issues = frames.find(
        (frame): frame is { repo?: unknown; present?: unknown } =>
          typeof frame === "object" &&
          frame !== null &&
          "type" in frame &&
          frame.type === "issuesState",
      );
      const scout = frames.find(
        (frame): frame is { repo?: unknown; present?: unknown } =>
          typeof frame === "object" &&
          frame !== null &&
          "type" in frame &&
          frame.type === "scoutState",
      );
      expect(issues?.repo).toBe("acme/fixture");
      expect(issues?.present).toBe(false);
      expect(scout?.repo).toBe("acme/fixture");
      expect(scout?.present).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("opens stopped for damaged bytes without a journal error", async () => {
    const { server, root, url } = await startServer();
    const stateDir = join(root, "state");
    const directory = join(stateDir, "issues", journalKey(resolve(root)));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "state.json"), '{"version": 1, "root":');

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.present).toBe(false);
      expect(message.lifecycle).toBe("stopped");
      expect(serverErrors(stateDir, root)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("replays a seeded worker snapshot with every running agent", async () => {
    const { server, root, url } = await startServer();
    await seedIssues(root);

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.type).toBe("issuesState");
      expect(message.present).toBe(true);
      expect(message.attached).toBe(true);
      expect(message.lifecycle).toBe("running");
      expect(message.repo).toBe("acme/fixture");
      expect((message.queue as Array<{ number: number }>).map((entry) => entry.number)).toEqual([
        7, 8, 9,
      ]);
      const agents = message.agents as Array<{ runId: string; issueNumber: number }>;
      expect(agents.map((agent) => agent.issueNumber)).toEqual([7, 9]);
      expect(message.cooldowns).toEqual({ "10": "2026-10-27T10:05:00.000Z" });
      expect(message.activeRun).toBeUndefined();
      expect(message.question).toBeUndefined();
      expect(message.nextAttemptAt).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("replays every running agent's activity on connect", async () => {
    const { server, root, url } = await startServer();
    const { directory } = await seedIssues(root);
    for (const [runId, lines] of [
      ["2026-10-27T10-00-01-000Z", ["agent one", "working one"]],
      ["2026-10-27T10-00-02-000Z", ["agent two"]],
    ] as const) {
      await mkdir(join(directory, "runs", runId), { recursive: true });
      await writeFile(join(directory, "runs", runId, "activity.json"), JSON.stringify(lines));
    }

    try {
      const messages = await collect(url, { type: "getIssues" }, (received) => {
        const replays = received.filter(
          (message) =>
            (message as { type?: string }).type === "issuesActivity" &&
            (message as { replay?: boolean }).replay === true,
        );
        return replays.length >= 2;
      });
      const replays = messages.filter(
        (message) =>
          (message as { type?: string }).type === "issuesActivity" &&
          (message as { replay?: boolean }).replay === true,
      );
      expect(replays).toHaveLength(2);
      const byRun = new Map(
        replays.map((message) => {
          const entry = message as { runId: string; entries: Array<{ text: string }> };
          return [entry.runId, entry.entries.map((item) => item.text)] as const;
        }),
      );
      expect(byRun.get("2026-10-27T10-00-01-000Z")).toEqual(["agent one", "working one"]);
      expect(byRun.get("2026-10-27T10-00-02-000Z")).toEqual(["agent two"]);
    } finally {
      server.stop(true);
    }
  });

  test("answerIssues refuses a missing or unknown run id and routes a valid one", async () => {
    const { server, root, url } = await startServer();
    await seedIssues(root);
    const control = join(root, "state", "issues", journalKey(resolve(root)), "control");

    try {
      const missing = (await exchange(url, {
        type: "answerIssues",
        id: 5,
        value: "answer",
      })) as Record<string, unknown>;
      expect(missing.type).toBe("error");
      expect(String(missing.message)).toContain("run id");

      const unknown = (await exchange(url, {
        type: "answerIssues",
        id: 5,
        value: "answer",
        runId: "2026-10-27T11-00-00-000Z",
      })) as Record<string, unknown>;
      expect(unknown.type).toBe("error");
      expect(String(unknown.message)).toContain("2026-10-27T11-00-00-000Z");

      // A routed answer has no acknowledgement; it reaches the command dir.
      const socket = new WebSocket(`ws://${url}/ws`);
      await new Promise<void>((resolve) => {
        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              type: "answerIssues",
              id: 5,
              value: "the whole goal",
              runId: "2026-10-27T10-00-02-000Z",
            }),
          );
          resolve();
        };
      });

      // The command reaches the control directory; the worker consumes it.
      let command: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100 && command === undefined; attempt += 1) {
        if (existsSync(control)) {
          const name = readdirSync(control).find((entry) => entry.endsWith(".json"));
          if (name !== undefined) {
            command = JSON.parse(readFileSync(join(control, name), "utf8")) as Record<
              string,
              unknown
            >;
            break;
          }
        }
        await Bun.sleep(10);
      }
      socket.close();
      expect(command).toEqual({
        type: "answer",
        id: 5,
        value: "the whole goal",
        runId: "2026-10-27T10-00-02-000Z",
      });
    } finally {
      server.stop(true);
    }
  });

  test("serves a run detail from the repo-scoped history", async () => {
    const { server, root, url } = await startServer();
    const { directory } = await seedIssues(root);
    const runId = "2026-10-27T09-00-00-000Z";
    const runDirectory = join(directory, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "run.json"),
      JSON.stringify({
        version: 1,
        runId,
        repo: "acme/fixture",
        status: "succeeded",
        argv: ["omp", "acp"],
        cwd: resolve(root),
        startedAt: "2026-10-27T09:00:00.000Z",
        finishedAt: "2026-10-27T09:01:00.000Z",
        exitCode: 0,
        issues: [
          {
            number: 8,
            title: "Second issue",
            url: "https://github.com/acme/fixture/issues/8",
            createdAt: "2026-10-26T01:00:00Z",
          },
        ],
        firstStderrLine: null,
        workerPid: process.pid,
        harnessVersion: "0.1.0",
      }),
    );
    await writeFile(join(runDirectory, "activity.json"), JSON.stringify(["handled #8"]));

    try {
      const message = (await exchange(url, { type: "getIssuesRun", runId })) as Record<string, unknown>;
      expect(message.type).toBe("issuesRun");
      expect((message.run as { runId: string }).runId).toBe(runId);
      expect((message.run as { activityLines: string[] }).activityLines).toEqual(["handled #8"]);
      const missing = (await exchange(url, { type: "getIssuesRun", runId: "../../etc/passwd" })) as Record<string, unknown>;
      expect(missing.type).toBe("error");
    } finally {
      server.stop(true);
    }
  });

  test("opens stopped when the state is present but no live lock remains", async () => {
    const { server, root, url } = await startServer();
    await seedIssues(root);
    await rm(join(root, ".devboard", ".tmp", "issues", "lock"), { force: true });

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.present).toBe(true);
      expect(message.attached).toBe(false);
      expect(message.lifecycle).toBe("stopped");
      expect(message.enabled).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("refuses Start when this checkout's worker uses another state directory", async () => {
    const { server, root, url } = await startServer();
    const { stateDir, lock: seeded } = await seedIssues(root);
    // Replace the seeded lock with an equally live one naming another state.
    if (seeded.acquired) seeded.release();
    const held = acquireLock(join(root, ".devboard", ".tmp", "issues", "lock"), {
      repo: resolve(root),
      stateDir: join(root, "other-state"),
      harnessVersion: "0.1.0",
      argv: ["bun", "issues/worker.ts"],
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    try {
      const message = (await exchange(url, { type: "startIssues" })) as Record<string, unknown>;
      expect(message.type).toBe("error");
      expect(String(message.message)).toContain(String(join(root, "other-state")));
      expect(String(message.message)).toContain(String(stateDir));
    } finally {
      server.stop(true);
    }
  });

  test("names both harness versions when the worker loaded another one", async () => {
    const { server, root, url } = await startServer({ runningVersion: "0.2.0" });
    await seedIssues(root);

    try {
      const message = (await exchange(url, { type: "getIssues" })) as Record<string, unknown>;
      expect(message.notice).toBe(
        "Issues worker 0.1.0 is running; this dashboard loaded 0.2.0. " +
          "It is left running; Stop it to launch the current harness on the next Start.",
      );
    } finally {
      server.stop(true);
    }
  });

  test("closes one issue through the bridge with the worker's repository", async () => {
    const calls: Array<{ repoDir: string; repository: string; number: number }> = [];
    const { server, root, url } = await startServer({
      issues: {
        closeIssue: async (request) => {
          calls.push({
            repoDir: request.repoDir,
            repository: request.repository,
            number: request.number,
          });
        },
      },
    });
    await seedIssues(root);

    try {
      const message = (await exchange(url, { type: "closeIssue", number: 8 })) as Record<
        string,
        unknown
      >;
      expect(message).toEqual({ type: "issuesClosed", number: 8, ok: true });
      expect(calls).toEqual([{ repoDir: resolve(root), repository: "acme/fixture", number: 8 }]);
    } finally {
      server.stop(true);
    }
  });

  test("reports a refused closure without a generic error", async () => {
    const { server, root, url } = await startServer({
      issues: {
        closeIssue: async () => {
          throw new Error("Could not close issue #8: HTTP 403: Resource not accessible");
        },
      },
    });
    await seedIssues(root);

    try {
      const message = (await exchange(url, { type: "closeIssue", number: 8 })) as Record<
        string,
        unknown
      >;
      expect(message).toEqual({
        type: "issuesClosed",
        number: 8,
        ok: false,
        message: "Could not close issue #8: HTTP 403: Resource not accessible",
      });
    } finally {
      server.stop(true);
    }
  });

  test("refuses a close request without a number or without an origin", async () => {
    const { server, url } = await startServer();

    try {
      expect(await exchange(url, { type: "closeIssue" })).toEqual({
        type: "error",
        message: "Closing an issue needs its number.",
      });
      expect(await exchange(url, { type: "closeIssue", number: 8 })).toEqual({
        type: "issuesClosed",
        number: 8,
        ok: false,
        message: "This checkout has no GitHub origin.",
      });
    } finally {
      server.stop(true);
    }
  });
});
