import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import type { EpicLookup, OpenEpic } from "./tracker";

const temporaryDirectories: string[] = [];
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");

interface TestServer {
  server: Server<unknown>;
  adrDir: string;
  goalFile: string;
  logPath: string;
  url: string;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "devboard-lifecycle-pause-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startServer(
  files: Record<string, string>,
  options: { agentArguments?: string; tracker?: EpicLookup } = {},
): Promise<TestServer> {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const goalFile = join(root, "GOAL.md");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  await writeFile(goalFile, "# Goal\n\nShip the lifecycle.\n");
  for (const [file, source] of Object.entries(files)) {
    await writeFile(join(adrDir, file), source);
  }

  const logPath = join(root, "agent.log");
  const server = createApp({
    adrDir,
    staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: root,
    goalFile,
    agentCommand: `bun ${STUB_AGENT} --log=${logPath} ${options.agentArguments ?? ""}`.trim(),
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

function logLines(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
}

function spawnCount(logPath: string): number {
  return logLines(logPath).filter((line) => line.startsWith("spawn ")).length;
}

function prompts(logPath: string): string[] {
  return logLines(logPath)
    .filter((line) => line.startsWith("prompt "))
    .map((line) => line.slice("prompt ".length));
}

function lifecycleStates(client: TestClient): Record<string, unknown>[] {
  return client.events.filter((message) => message.type === "lifecycleState");
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  if (!predicate()) throw new Error(message);
}

const PENDING_ONE = "# First decision\n\n- Status: Proposed\n\n## Context\n\nFirst.\n\n## Decision\n\n";

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("lifecycle pause and resume", () => {
  test(
    "pauses during implementation and resumes the same peer",
    async () => {
      let lookups = 0;
      const epic: OpenEpic = {
        number: 5,
        title: "Pause the epic",
        url: "https://example.test/issues/5",
      };
      const { server, logPath, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        {
          agentArguments: "--delay-ms=1500",
          tracker: async () => {
            lookups += 1;
            return lookups === 1 ? epic : undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "5" },
          paused: false,
        });

        const spawned = Date.now() + 5000;
        while (spawnCount(logPath) < 1 && Date.now() < spawned) await Bun.sleep(25);
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/implement-next-epic"]);

        client.send({ type: "pauseLifecycle" });
        const paused = await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        expect(paused).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "5" },
          paused: true,
        });

        const activityAtPause = client.events.filter((message) => message.type === "activity").length;
        const statesAtPause = lifecycleStates(client).length;

        await Bun.sleep(2200);
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/implement-next-epic"]);
        expect(lifecycleStates(client)).toHaveLength(statesAtPause);
        expect(client.events.filter((message) => message.type === "activity")).toHaveLength(
          activityAtPause,
        );
        expect(client.events.filter((message) => message.type === "runStopped")).toEqual([]);

        client.send({ type: "resumeLifecycle" });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.paused === false,
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "5" },
          paused: false,
        });

        expect(
          await client.waitFor(
            (message) =>
              message.type === "lifecycleState" &&
              message.stage === "epic" &&
              message.pass === 2,
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 2,
          work: null,
          paused: false,
        });

        await waitUntil(
          () => spawnCount(logPath) === 2,
          "the lifecycle did not start the next stage",
        );
        expect(prompts(logPath)).toEqual(["/implement-next-epic", "/epic-next"]);
        expect(
          prompts(logPath).filter((prompt) => prompt === "/implement-next-epic"),
        ).toHaveLength(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "pauses with a pending interview question and carries its answer to the same peer",
    async () => {
      const { server, adrDir, logPath, url } = await startServer({
        "0001-first.md": PENDING_ONE,
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(
          await client.waitFor(
            (message) =>
              message.type === "lifecycleState" &&
              message.stage === "adr" &&
              message.work !== null,
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "adr",
          pass: 1,
          work: { kind: "adr", id: "0001-first.md" },
          paused: false,
        });
        const question = await client.waitFor((message) => message.type === "question");
        expect(question).toMatchObject({ id: 1, message: "Choose an answer" });

        client.send({ type: "pauseLifecycle" });
        const paused = await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        expect(paused).toEqual({
          type: "lifecycleState",
          stage: "adr",
          pass: 1,
          work: { kind: "adr", id: "0001-first.md" },
          paused: true,
        });

        const promptsAtPause = prompts(logPath);
        const spawnsAtPause = spawnCount(logPath);
        expect(promptsAtPause).toHaveLength(2);
        expect(promptsAtPause[1]?.startsWith("/adr-resolve ")).toBe(true);
        expect(spawnsAtPause).toBe(2);

        client.send({ type: "answer", id: 1, value: "Alpha" });
        await Bun.sleep(500);
        expect(client.events.filter((message) => message.type === "error")).toEqual([]);
        expect(logLines(logPath).filter((line) => line.startsWith("answer "))).toEqual([]);
        expect(prompts(logPath)).toEqual(promptsAtPause);
        expect(spawnCount(logPath)).toBe(spawnsAtPause);

        client.send({ type: "resumeLifecycle" });
        expect(
          await client.waitFor(
            (message) =>
              message.type === "lifecycleState" &&
              message.stage === "adr" &&
              message.paused === false,
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "adr",
          pass: 1,
          work: { kind: "adr", id: "0001-first.md" },
          paused: false,
        });

        await waitUntil(
          () => logLines(logPath).includes("answer Alpha"),
          "the suspended peer did not receive the answer",
        );
        await waitUntil(
          () =>
            readFileSync(join(adrDir, "0001-first.md"), "utf8").includes("- Status: Accepted"),
          "the suspended peer did not finish the ADR",
        );

        expect(await client.waitFor((message) => message.type === "lifecycleState" &&
          message.stage === "finished")).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(spawnCount(logPath)).toBe(3);
        expect(prompts(logPath)[2]).toBe("/epic-next");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "pauses between stages before the next tracker query result is used",
    async () => {
      const epic: OpenEpic = {
        number: 8,
        title: "Between stages",
        url: "https://example.test/issues/8",
      };
      const secondQuery = Promise.withResolvers<void>();
      const releaseSecondQuery = Promise.withResolvers<void>();
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        {
          tracker: async () => {
            lookups += 1;
            if (lookups === 1) return epic;
            if (lookups === 2) {
              secondQuery.resolve();
              await releaseSecondQuery.promise;
              return undefined;
            }
            return undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "8" },
          paused: false,
        });

        await secondQuery.promise;
        client.send({ type: "pauseLifecycle" });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.paused === true,
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "8" },
          paused: true,
        });

        await Bun.sleep(600);
        expect(
          lifecycleStates(client).filter((message) => message.paused === true),
        ).toHaveLength(1);
        expect(spawnCount(logPath)).toBe(1);

        releaseSecondQuery.resolve();
        // Integration timing: the tracker result is available, but the paused
        // gate must hold the stage transition until the explicit resume.
        await Bun.sleep(300);
        expect(
          lifecycleStates(client).filter((message) => message.stage === "epic"),
        ).toEqual([]);

        client.send({ type: "resumeLifecycle" });
        expect(
          await client.waitFor(
            (message) =>
              message.type === "lifecycleState" &&
              message.stage === "epic" &&
              message.pass === 2,
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 2,
          work: null,
          paused: false,
        });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "replays paused state and pending question to a client that connects while paused",
    async () => {
      const { server, logPath, url } = await startServer({
        "0001-first.md": PENDING_ONE,
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) =>
            message.type === "lifecycleState" &&
            message.stage === "adr" &&
            message.work !== null,
        );
        await client.waitFor((message) => message.type === "question");

        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );

        const late = await connect(url);
        try {
          expect(await late.waitFor(() => true)).toEqual({
            type: "lifecycleState",
            stage: "adr",
            pass: 1,
            work: { kind: "adr", id: "0001-first.md" },
            paused: true,
          });
          expect(await late.waitFor(() => true)).toMatchObject({
            type: "runStarted",
            file: "0001-first.md",
            title: "First decision",
          });
          expect(await late.waitFor(() => true)).toMatchObject({
            type: "activity",
            text: "Inspecting 0001-first.md",
          });
          expect(await late.waitFor(() => true)).toMatchObject({
            type: "question",
            id: 1,
            message: "Choose an answer",
            choices: ["Alpha", "Beta"],
          });
        } finally {
          late.close();
        }

        await Bun.sleep(500);
        expect(spawnCount(logPath)).toBe(2);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "allows goal saving while paused and refuses other starts",
    async () => {
      const epic: OpenEpic = {
        number: 4,
        title: "Goal while paused",
        url: "https://example.test/issues/4",
      };
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        { agentArguments: "--delay-ms=1500", tracker: async () => epic },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        const spawned = Date.now() + 5000;
        while (spawnCount(logPath) < 1 && Date.now() < spawned) await Bun.sleep(25);

        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );

        client.send({ type: "saveGoal", text: "# Paused goal\n\nEdited while paused.\n" });
        expect(
          await client.waitFor(
            (message) => message.type === "goal" && message.text ===
              "# Paused goal\n\nEdited while paused.\n",
          ),
        ).toEqual({ type: "goal", text: "# Paused goal\n\nEdited while paused.\n" });
        expect(await readFile(goalFile, "utf8")).toBe("# Paused goal\n\nEdited while paused.\n");

        client.send({ type: "getGoal" });
        expect(
          await client.waitFor(
            (message) => message.type === "goal" && message.text ===
              "# Paused goal\n\nEdited while paused.\n",
          ),
        ).toEqual({ type: "goal", text: "# Paused goal\n\nEdited while paused.\n" });

        client.send({ type: "startLifecycle" });
        client.send({ type: "startRun" });
        client.send({ type: "reviseGoal", request: "Try again" });

        for (const expected of [
          "A lifecycle run is already active.",
          "A lifecycle run is active.",
          "A lifecycle run is active.",
        ]) {
          expect(
            await client.waitFor(
              (message) => message.type === "error" && message.message === expected,
            ),
          ).toEqual({ type: "error", message: expected });
        }

        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/implement-next-epic"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "refuses invalid pause and resume without changing state",
    async () => {
      const idle = await startServer({});
      const idleClient = await connect(idle.url);
      try {
        idleClient.send({ type: "pauseLifecycle" });
        idleClient.send({ type: "resumeLifecycle" });
        expect(
          await idleClient.waitFor(
            (message) =>
              message.type === "error" && message.message === "No lifecycle run is active.",
          ),
        ).toEqual({ type: "error", message: "No lifecycle run is active." });
        expect(
          await idleClient.waitFor(
            (message) =>
              message.type === "error" && message.message === "No lifecycle run is active.",
          ),
        ).toEqual({ type: "error", message: "No lifecycle run is active." });
        expect(lifecycleStates(idleClient)).toEqual([]);
      } finally {
        idleClient.close();
        idle.server.stop(true);
      }

      const finished = await startServer({});
      const finishedClient = await connect(finished.url);
      try {
        finishedClient.send({ type: "startLifecycle" });
        await finishedClient.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        const before = lifecycleStates(finishedClient).length;

        finishedClient.send({ type: "pauseLifecycle" });
        finishedClient.send({ type: "resumeLifecycle" });
        expect(
          await finishedClient.waitFor(
            (message) =>
              message.type === "error" && message.message === "No lifecycle run is active.",
          ),
        ).toEqual({ type: "error", message: "No lifecycle run is active." });
        expect(
          await finishedClient.waitFor(
            (message) =>
              message.type === "error" && message.message === "No lifecycle run is active.",
          ),
        ).toEqual({ type: "error", message: "No lifecycle run is active." });
        expect(lifecycleStates(finishedClient)).toHaveLength(before);
      } finally {
        finishedClient.close();
        finished.server.stop(true);
      }

      const epic: OpenEpic = {
        number: 12,
        title: "Still open",
        url: "https://example.test/issues/12",
      };
      const failed = await startServer({}, { tracker: async () => epic });
      const failedClient = await connect(failed.url);
      try {
        failedClient.send({ type: "startLifecycle" });
        await failedClient.waitFor(
          (message) =>
            message.type === "error" &&
            message.message === "Implementation ended but epic #12 is still open.",
        );
        const before = lifecycleStates(failedClient).length;

        failedClient.send({ type: "pauseLifecycle" });
        failedClient.send({ type: "resumeLifecycle" });
        expect(
          await failedClient.waitFor(
            (message) =>
              message.type === "error" && message.message === "No lifecycle run is active.",
          ),
        ).toEqual({ type: "error", message: "No lifecycle run is active." });
        expect(
          await failedClient.waitFor(
            (message) =>
              message.type === "error" && message.message === "No lifecycle run is active.",
          ),
        ).toEqual({ type: "error", message: "No lifecycle run is active." });
        expect(lifecycleStates(failedClient)).toHaveLength(before);
      } finally {
        failedClient.close();
        failed.server.stop(true);
      }

      const activeEpic: OpenEpic = {
        number: 13,
        title: "Paused once",
        url: "https://example.test/issues/13",
      };
      let lookups = 0;
      const active = await startServer(
        {},
        {
          agentArguments: "--delay-ms=1500",
          tracker: async () => {
            lookups += 1;
            return lookups === 1 ? activeEpic : undefined;
          },
        },
      );
      const activeClient = await connect(active.url);
      try {
        activeClient.send({ type: "startLifecycle" });
        await activeClient.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        activeClient.send({ type: "pauseLifecycle" });
        await activeClient.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        const statesPaused = lifecycleStates(activeClient).length;

        activeClient.send({ type: "pauseLifecycle" });
        expect(
          await activeClient.waitFor(
            (message) =>
              message.type === "error" &&
              message.message === "The lifecycle run is already paused.",
          ),
        ).toEqual({ type: "error", message: "The lifecycle run is already paused." });
        expect(lifecycleStates(activeClient)).toHaveLength(statesPaused);

        activeClient.send({ type: "resumeLifecycle" });
        await activeClient.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === false,
        );
        const statesResumed = lifecycleStates(activeClient).length;

        activeClient.send({ type: "resumeLifecycle" });
        expect(
          await activeClient.waitFor(
            (message) =>
              message.type === "error" &&
              message.message === "The lifecycle run is not paused.",
          ),
        ).toEqual({ type: "error", message: "The lifecycle run is not paused." });
        expect(lifecycleStates(activeClient)).toHaveLength(statesResumed);
      } finally {
        activeClient.close();
        active.server.stop(true);
      }
    },
    40000,
  );
});
