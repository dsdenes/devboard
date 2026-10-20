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
const REVISED_GOAL = "# Revised goal\n\nThe agent rewrote this.";

interface TestServer {
  server: Server<unknown>;
  adrDir: string;
  goalFile: string;
  logPath: string;
  url: string;
}

interface ServerOptions {
  revision?: { writeGoal: boolean };
  agentArguments?: string;
  goalText?: string;
  tracker?: EpicLookup;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "devboard-goal-revision-"));
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
  const goalFile = join(root, "GOAL.md");
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
  const command = [
    `bun ${STUB_AGENT}`,
    `--log=${logPath}`,
    options.revision === undefined ? "" : "--revise-goal",
    options.revision?.writeGoal === true ? `--goal=${goalFile}` : "",
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

  return { server, adrDir, goalFile, logPath, url: `127.0.0.1:${server.port}` };
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

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PENDING_ONE = "# First decision\n\n- Status: Proposed\n\n## Context\n\nFirst.\n\n## Decision\n\n";
const PENDING_TWO = "# Second decision\n\n- Status: Proposed\n\n## Context\n\nSecond.\n\n## Decision\n\n";

describe("guided goal revision", () => {
  test(
    "revises the goal with guidance, relays activity and one question, and reports the written bytes",
    async () => {
      const originalGoal = "# Original goal\n";
      const { server, adrDir, goalFile, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { revision: { writeGoal: true }, goalText: originalGoal },
      );
      const client = await connect(url);
      const adrsBefore = adrSnapshot(adrDir);

      try {
        client.send({ type: "reviseGoal", request: "Tighten the goal" });
        expect(await client.waitFor((message) => message.type === "goalRevisionStarted")).toEqual({
          type: "goalRevisionStarted",
        });
        expect(
          await client.waitFor(
            (message) => message.type === "activity" && message.text === "Revising the goal",
          ),
        ).toEqual({ type: "activity", text: "Revising the goal" });

        const question = await client.waitFor((message) => message.type === "question");
        expect(question).toMatchObject({
          message: "Choose an answer",
          choices: ["Alpha", "Beta"],
        });
        expect(prompts(logPath)).toHaveLength(1);
        expect(readFileSync(logPath, "utf8")).toContain("Guidance: Tighten the goal");

        client.send({ type: "answer", id: question.id, value: "Alpha" });
        const stopped = await client.waitFor((message) => message.type === "goalRevisionStopped");
        expect(stopped).toEqual({
          type: "goalRevisionStopped",
          completed: true,
          text: REVISED_GOAL,
        });
        expect(await readFile(goalFile, "utf8")).toBe(REVISED_GOAL);
        expect(stopped.text).toBe(await readFile(goalFile, "utf8"));
        expect(
          client.events
            .filter((message) => message.type === "activity")
            .map((message) => message.text),
        ).toEqual(["Revising the goal", "Answer received: Alpha", "Revised the goal"]);

        expect(adrSnapshot(adrDir)).toEqual(adrsBefore);
        expect(runEvents(client)).toEqual([]);
        expect(
          client.events.filter((message) => message.type === "error"),
        ).toEqual([]);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "starts the same flow without a request",
    async () => {
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { revision: { writeGoal: true }, goalText: "# Original goal\n" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "reviseGoal" });
        expect(await client.waitFor((message) => message.type === "goalRevisionStarted")).toEqual({
          type: "goalRevisionStarted",
        });
        const question = await client.waitFor((message) => message.type === "question");
        expect(question).toMatchObject({
          message: "Choose an answer",
          choices: ["Alpha", "Beta"],
        });
        expect(prompts(logPath)[0]).not.toContain("Guidance:");
        expect(readFileSync(logPath, "utf8")).not.toContain("Guidance:");

        client.send({ type: "answer", id: question.id, value: "Beta" });
        expect(await client.waitFor((message) => message.type === "goalRevisionStopped")).toEqual({
          type: "goalRevisionStopped",
          completed: true,
          text: REVISED_GOAL,
        });
        expect(await readFile(goalFile, "utf8")).toBe(REVISED_GOAL);
        expect(runEvents(client)).toEqual([]);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses a revision while a lifecycle run is active without spawning a peer",
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
          goalText: "# Active goal\n\nImplement the active epic.\n",
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

        client.send({ type: "reviseGoal", request: "Tighten the goal" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A lifecycle run is active.",
        });

        await Bun.sleep(200);
        expect(spawnCount(logPath)).toBe(1);
        expect(
          client.events.filter((message) => message.type === "goalRevisionStarted"),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses a revision while an ADR run is active without spawning a peer",
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

        client.send({ type: "reviseGoal" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A run is already active.",
        });

        await Bun.sleep(200);
        expect(spawnCount(logPath)).toBe(1);
        expect(
          client.events.filter((message) => message.type === "goalRevisionStarted"),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses a revision between records of one ADR sequence without spawning a peer",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
        { agentArguments: "--questions=0" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startRun" });
        await client.waitFor(
          (message) => message.type === "runStarted" && message.file === "0001-first.md",
        );
        expect(await client.waitFor((message) => message.type === "runStopped")).toMatchObject({
          file: "0001-first.md",
          resolved: true,
        });

        client.send({ type: "reviseGoal" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "A run is already active.",
        });

        expect(
          await client.waitFor((message) => message.type === "records" && message.next === null),
        ).toMatchObject({ next: null });
        expect(spawnCount(logPath)).toBe(2);
        expect(
          client.events.filter((message) => message.type === "goalRevisionStarted"),
        ).toEqual([]);
        expect(
          client.events.filter(
            (message) => message.type === "runStarted" && message.file === "0002-second.md",
          ),
        ).toHaveLength(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses startRun, startLifecycle, and a second revision while a revision is active",
    async () => {
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        {
          revision: { writeGoal: true },
          goalText: "# Original goal\n",
          agentArguments: "--delay-ms=600",
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "reviseGoal", request: "Tighten the goal" });
        await client.waitFor((message) => message.type === "goalRevisionStarted");
        const question = await client.waitFor((message) => message.type === "question");
        await eventually(() => spawnCount(logPath) === 1);

        client.send({ type: "startRun" });
        client.send({ type: "startLifecycle" });
        client.send({ type: "reviseGoal" });

        for (const expected of [
          "A goal revision is active.",
          "A goal revision is active.",
          "A goal revision is already active.",
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
        expect(await client.waitFor((message) => message.type === "goalRevisionStopped")).toEqual({
          type: "goalRevisionStopped",
          completed: true,
          text: REVISED_GOAL,
        });
        expect(await readFile(goalFile, "utf8")).toBe(REVISED_GOAL);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "replays the revision start, activity so far, and pending question to a late client",
    async () => {
      const { server, goalFile, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        {
          revision: { writeGoal: true },
          goalText: "# Original goal\n",
          agentArguments: "--delay-ms=600",
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "reviseGoal", request: "Tighten the goal" });
        await client.waitFor((message) => message.type === "goalRevisionStarted");
        await client.waitFor(
          (message) => message.type === "activity" && message.text === "Revising the goal",
        );
        await client.waitFor((message) => message.type === "question");

        const late = await connect(url);
        try {
          await eventually(() => late.events.length >= 3);
          expect(late.events[0]).toEqual({ type: "goalRevisionStarted" });
          expect(late.events[1]).toEqual({ type: "activity", text: "Revising the goal" });
          expect(late.events[2]).toMatchObject({
            type: "question",
            message: "Choose an answer",
            choices: ["Alpha", "Beta"],
          });

          const question = late.events[2];
          late.send({ type: "answer", id: question.id, value: "Alpha" });
          expect(await client.waitFor((message) => message.type === "goalRevisionStopped")).toEqual({
            type: "goalRevisionStopped",
            completed: true,
            text: REVISED_GOAL,
          });
          expect(await readFile(goalFile, "utf8")).toBe(REVISED_GOAL);
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
    "reports an incomplete revision when the peer leaves no readable goal and still starts a later run",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { revision: { writeGoal: false } },
      );
      const client = await connect(url);

      try {
        client.send({ type: "reviseGoal", request: "Tighten the goal" });
        await client.waitFor((message) => message.type === "goalRevisionStarted");
        const question = await client.waitFor((message) => message.type === "question");
        client.send({ type: "answer", id: question.id, value: "Alpha" });

        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toContain("Could not read the revised goal");
        const stopped = await client.waitFor((message) => message.type === "goalRevisionStopped");
        expect(stopped).toEqual({ type: "goalRevisionStopped", completed: false });
        expect("text" in stopped).toBe(false);

        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "runStarted")).toMatchObject({
          file: "0001-first.md",
        });
        const runQuestion = await client.waitFor((message) => message.type === "question");
        client.send({ type: "answer", id: runQuestion.id, value: "Alpha" });
        expect(await client.waitFor((message) => message.type === "runStopped")).toMatchObject({
          file: "0001-first.md",
        });
        expect(spawnCount(logPath)).toBe(2);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );
});
