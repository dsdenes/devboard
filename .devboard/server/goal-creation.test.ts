import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import type { EpicLookup, OpenEpic } from "./tracker";

const temporaryDirectories: string[] = [];
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const CREATED_GOAL = "# Created goal\n\nThe agent wrote this.";

interface TestServer {
  server: Server<unknown>;
  adrDir: string;
  root: string;
  goalFile: string;
  logPath: string;
  url: string;
}

interface ServerOptions {
  mode?: "create" | "revision";
  writeStubGoal?: boolean;
  goalText?: string;
  goalFileName?: string;
  agentArguments?: string;
  tracker?: EpicLookup;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "devboard-goal-creation-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startServer(
  files: Record<string, string>,
  options: ServerOptions = {},
): Promise<TestServer> {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const goalFile = join(root, options.goalFileName ?? "GOAL.md");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  if (options.goalText !== undefined) {
    await writeFile(goalFile, options.goalText);
  }
  for (const [file, source] of Object.entries(files)) {
    await writeFile(join(adrDir, file), source);
  }

  const logPath = join(root, "agent.log");
  const mode = options.mode ?? "create";
  const command = [
    `bun ${STUB_AGENT}`,
    mode === "revision" ? "--revise-goal" : "--create-goal",
    options.writeStubGoal === false ? "" : `--goal=${join(root, "GOAL.md")}`,
    `--log=${logPath}`,
    options.agentArguments ?? "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    goalFile,
    agentCommand: command,
    tracker: options.tracker ?? (async () => undefined),
  });

  return { server, adrDir, root, goalFile, logPath, url: `127.0.0.1:${server.port}` };
}

interface TestClient {
  socket: WebSocket;
  events: Record<string, unknown>[];
  send(command: unknown): void;
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(url: string): Promise<TestClient> {
  const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const events: Record<string, unknown>[] = [];
  const buffered: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }[] = [];

  socket.onopen = () => {
    resolve({
      socket,
      events,
      send(command) {
        socket.send(JSON.stringify(command));
      },
      waitFor(predicate) {
        const index = buffered.findIndex(predicate);
        if (index >= 0) {
          const message = buffered.splice(index, 1)[0];
          if (message !== undefined) return Promise.resolve(message);
        }
        const { promise: waiting, resolve: settle } =
          Promise.withResolvers<Record<string, unknown>>();
        waiters.push({ predicate, resolve: settle });
        return waiting;
      },
      close() {
        socket.close();
      },
    });
  };

  socket.onmessage = (event) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    events.push(message);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      if (waiter !== undefined) waiter.resolve(message);
    } else {
      buffered.push(message);
    }
  };

  socket.onerror = () => reject(new Error("websocket failed"));

  return promise;
}

function spawnCount(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("spawn "))
    .length;
}

function prompts(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("prompt "))
    .map((line) => line.slice("prompt ".length));
}

function adrSnapshot(directory: string): [string, string][] {
  return readdirSync(directory)
    .sort()
    .map((file) => [file, readFileSync(join(directory, file), "utf8")]);
}

async function eventually(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  expect(predicate()).toBe(true);
}

function runEvents(client: TestClient): Record<string, unknown>[] {
  return client.events.filter(
    (message) => message.type === "runStarted" || message.type === "runStopped",
  );
}

function errors(client: TestClient): Record<string, unknown>[] {
  return client.events.filter((message) => message.type === "error");
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PENDING_ONE = "# First decision\n\n- Status: Proposed\n\n## Context\n\nFirst.\n\n## Decision\n\n";
const PENDING_TWO = "# Second decision\n\n- Status: Proposed\n\n## Context\n\nSecond.\n\n## Decision\n\n";

describe("guided goal creation", () => {
  test(
    "starts /goal-outcome, relays activity and one question, and reports the written bytes",
    async () => {
      const { server, adrDir, goalFile, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { agentArguments: "--delay-ms=200" },
      );
      const client = await connect(url);
      const adrsBefore = adrSnapshot(adrDir);

      try {
        client.send({ type: "createGoal" });
        expect(await client.waitFor((message) => message.type === "goalCreationStarted")).toEqual({
          type: "goalCreationStarted",
        });
        expect(
          await client.waitFor(
            (message) => message.type === "activity" && message.text === "Creating the goal",
          ),
        ).toEqual({ type: "activity", text: "Creating the goal" });

        const question = await client.waitFor((message) => message.type === "question");
        expect(question).toMatchObject({
          message: "Choose an answer",
          choices: ["Alpha", "Beta"],
        });
        expect(prompts(logPath)).toEqual(["/goal-outcome"]);
        expect(spawnCount(logPath)).toBe(1);

        client.send({ type: "answer", id: question.id, value: "Alpha" });
        client.send({ type: "answer", id: question.id, value: "Beta" });
        const stopped = await client.waitFor((message) => message.type === "goalCreationStopped");
        expect(stopped).toEqual({
          type: "goalCreationStopped",
          completed: true,
          text: CREATED_GOAL,
        });
        expect(stopped.text).toBe(await readFile(goalFile, "utf8"));
        expect(
          client.events
            .filter((message) => message.type === "activity")
            .map((message) => message.text),
        ).toEqual(["Creating the goal", "Answer received: Alpha", "Created the goal"]);

        client.send({ type: "getGoal" });
        expect(await client.waitFor((message) => message.type === "goal")).toEqual({
          type: "goal",
          text: CREATED_GOAL,
        });

        expect(errors(client)).toHaveLength(1);
        expect(String(errors(client)[0]?.message)).toMatch(/question|run/);
        expect(
          readFileSync(logPath, "utf8")
            .split("\n")
            .filter((line) => line.startsWith("answer ")),
        ).toEqual(["answer Alpha"]);
        expect(runEvents(client)).toEqual([]);
        expect(adrSnapshot(adrDir)).toEqual(adrsBefore);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "does not spawn a peer when a client connects without asking for creation",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { goalText: "" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "listRecords" });
        client.send({ type: "getGoal" });
        expect(await client.waitFor((message) => message.type === "goal")).toEqual({
          type: "goal",
          text: "",
        });

        expect(spawnCount(logPath)).toBe(0);
        expect(
          client.events.filter(
            (message) =>
              message.type === "goalCreationStarted" || message.type === "goalCreationStopped",
          ),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses creation while the goal document is non-empty without spawning a peer",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { goalText: "# Existing goal\n" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "createGoal" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "The goal is already set.",
        });
        expect(spawnCount(logPath)).toBe(0);
        expect(
          client.events.filter((message) => message.type === "goalCreationStarted"),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses creation when the goal document exists but cannot be read",
    async () => {
      const { server, root, logPath, url } = await startServer({
        "0001-first.md": PENDING_ONE,
      });
      await mkdir(join(root, "GOAL.md"));
      const client = await connect(url);

      try {
        client.send({ type: "createGoal" });
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toContain("Could not read the goal");
        expect(spawnCount(logPath)).toBe(0);
        expect(
          client.events.filter((message) => message.type === "goalCreationStarted"),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses creation while a lifecycle run is advancing without spawning a second peer",
    async () => {
      const epic: OpenEpic = {
        number: 42,
        title: "Active epic",
        url: "https://example.test/issues/42",
      };
      const { server, logPath, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        {
          agentArguments: "--delay-ms=1200",
          goalText: "# Active goal\n",
          tracker: async () => epic,
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await client.waitFor((message) => message.type === "runStarted");
        await eventually(() => spawnCount(logPath) === 1);

        client.send({ type: "createGoal" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A lifecycle run is active.",
        });

        expect(spawnCount(logPath)).toBe(1);
        expect(
          client.events.filter((message) => message.type === "goalCreationStarted"),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses creation while an ADR run is active without spawning a second peer",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
        { agentArguments: "--delay-ms=1200 --questions=0" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        await client.waitFor(
          (message) => message.type === "runStarted" && message.file === "0001-first.md",
        );
        await eventually(() => spawnCount(logPath) === 1);

        client.send({ type: "createGoal" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A run is already active.",
        });

        expect(spawnCount(logPath)).toBe(1);
        expect(
          client.events.filter((message) => message.type === "goalCreationStarted"),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses creation between records of one ADR sequence without spawning a second peer",
    async () => {
      const { server, logPath, url } = await startServer(
        {
          "0001-first.md": PENDING_ONE,
          "0002-second.md": PENDING_TWO,
        },
        { agentArguments: "--questions=0" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "runStopped")).toMatchObject({
          file: "0001-first.md",
          resolved: true,
        });

        client.send({ type: "createGoal" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A run is already active.",
        });

        await client.waitFor(
          (message) => message.type === "runStopped" && message.file === "0002-second.md",
        );
        expect(
          client.events.filter((message) => message.type === "goalCreationStarted"),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses creation while a goal revision is active without spawning a second peer",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { mode: "revision", agentArguments: "--delay-ms=1200" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "reviseGoal" });
        await client.waitFor((message) => message.type === "goalRevisionStarted");
        await eventually(() => spawnCount(logPath) === 1);

        client.send({ type: "createGoal" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A goal revision is active.",
        });

        expect(spawnCount(logPath)).toBe(1);
        expect(
          client.events.filter((message) => message.type === "goalCreationStarted"),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses startRun, startLifecycle, resumeLifecycle, reviseGoal, and a second creation while creating",
    async () => {
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { agentArguments: "--delay-ms=600" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "createGoal" });
        await client.waitFor((message) => message.type === "goalCreationStarted");
        const question = await client.waitFor((message) => message.type === "question");

        client.send({ type: "startRun" });
        client.send({ type: "startLifecycle" });
        client.send({ type: "resumeLifecycle" });
        client.send({ type: "reviseGoal" });
        client.send({ type: "createGoal" });

        for (const expected of [
          "A goal creation is active.",
          "A goal creation is active.",
          "A goal creation is active.",
          "A goal creation is active.",
          "A goal creation is already active.",
        ]) {
          await client.waitFor(
            (message) => message.type === "error" && message.message === expected,
          );
        }

        expect(spawnCount(logPath)).toBe(1);
        expect(runEvents(client)).toEqual([]);
        expect(
          client.events.filter((message) => message.type === "lifecycleState"),
        ).toEqual([]);

        client.send({ type: "answer", id: question.id, value: "Alpha" });
        expect(await client.waitFor((message) => message.type === "goalCreationStopped")).toEqual({
          type: "goalCreationStopped",
          completed: true,
          text: CREATED_GOAL,
        });
        expect(await readFile(goalFile, "utf8")).toBe(CREATED_GOAL);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "replays the creation start, activity so far, and pending question to a late client",
    async () => {
      const { server, goalFile, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { agentArguments: "--delay-ms=600" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "createGoal" });
        await client.waitFor((message) => message.type === "goalCreationStarted");
        await client.waitFor(
          (message) => message.type === "activity" && message.text === "Creating the goal",
        );
        await client.waitFor((message) => message.type === "question");

        const late = await connect(url);
        try {
          await eventually(() => late.events.length >= 3);
          expect(late.events[0]).toEqual({ type: "goalCreationStarted" });
          expect(late.events[1]).toEqual({ type: "activity", text: "Creating the goal" });
          expect(late.events[2]).toMatchObject({
            type: "question",
            message: "Choose an answer",
            choices: ["Alpha", "Beta"],
          });

          const question = late.events[2];
          late.send({ type: "answer", id: question.id, value: "Alpha" });
          expect(await client.waitFor((message) => message.type === "goalCreationStopped")).toEqual({
            type: "goalCreationStopped",
            completed: true,
            text: CREATED_GOAL,
          });
          expect(await readFile(goalFile, "utf8")).toBe(CREATED_GOAL);
        } finally {
          late.close();
        }
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "reports an incomplete creation when the peer leaves no readable goal",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { writeStubGoal: false },
      );
      const client = await connect(url);

      try {
        client.send({ type: "createGoal" });
        await client.waitFor((message) => message.type === "goalCreationStarted");
        const question = await client.waitFor((message) => message.type === "question");
        client.send({ type: "answer", id: question.id, value: "Alpha" });

        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toContain("Could not read the created goal");
        const stopped = await client.waitFor((message) => message.type === "goalCreationStopped");
        expect(stopped).toEqual({ type: "goalCreationStopped", completed: false });
        expect("text" in stopped).toBe(false);

        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "runStarted")).toMatchObject({
          file: "0001-first.md",
        });
        await eventually(() => spawnCount(logPath) === 2);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "accepts creation while the lifecycle is paused and replays the suspended conversation",
    async () => {
      const epic: OpenEpic = {
        number: 42,
        title: "Active epic",
        url: "https://example.test/issues/42",
      };
      const { server, goalFile, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        {
          agentArguments: "--questions=1",
          goalText: "# Active goal\n",
          tracker: async () => epic,
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await client.waitFor((message) => message.type === "question");
        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );

        client.send({ type: "saveGoal", text: "" });
        await client.waitFor((message) => message.type === "goal" && message.text === "");

        client.send({ type: "createGoal" });
        expect(await client.waitFor((message) => message.type === "goalCreationStarted")).toEqual({
          type: "goalCreationStarted",
        });
        const creationQuestion = await client.waitFor(
          (message) => message.type === "question" && message.message === "Choose an answer",
        );
        client.send({ type: "answer", id: creationQuestion.id, value: "Alpha" });

        const stopped = await client.waitFor((message) => message.type === "goalCreationStopped");
        expect(stopped).toEqual({
          type: "goalCreationStopped",
          completed: true,
          text: CREATED_GOAL,
        });
        expect(await readFile(goalFile, "utf8")).toBe(CREATED_GOAL);

        const after = client.events.slice(client.events.indexOf(stopped) + 1);
        expect(after[0]).toMatchObject({
          type: "runStarted",
          file: "",
          title: "Active epic",
        });
        expect(
          after.filter((message) => message.type === "activity").map((message) => message.text),
        ).toContain("Working on /implement-next-epic");
        expect(after.filter((message) => message.type === "question").length).toBeGreaterThan(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "writes <repoDir>/GOAL.md while getGoal and saveGoal keep using the configured GOAL_FILE",
    async () => {
      const { server, root, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { goalFileName: "custom.md" },
      );
      const customGoal = join(root, "custom.md");
      await writeFile(customGoal, "# Configured goal\n");
      const client = await connect(url);

      try {
        client.send({ type: "getGoal" });
        expect(await client.waitFor((message) => message.type === "goal")).toEqual({
          type: "goal",
          text: "# Configured goal\n",
        });

        client.send({ type: "createGoal" });
        await client.waitFor((message) => message.type === "goalCreationStarted");
        const question = await client.waitFor((message) => message.type === "question");
        client.send({ type: "answer", id: question.id, value: "Alpha" });

        expect(await client.waitFor((message) => message.type === "goalCreationStopped")).toEqual({
          type: "goalCreationStopped",
          completed: true,
          text: CREATED_GOAL,
        });
        expect(await readFile(join(root, "GOAL.md"), "utf8")).toBe(CREATED_GOAL);
        expect(await readFile(customGoal, "utf8")).toBe("# Configured goal\n");

        client.send({ type: "getGoal" });
        expect(await client.waitFor((message) => message.type === "goal")).toEqual({
          type: "goal",
          text: "# Configured goal\n",
        });
        expect(prompts(logPath)).toEqual(["/goal-outcome"]);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );
});
