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
  const directory = await mkdtemp(join(tmpdir(), "devboard-lifecycle-"));
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

function spawnCount(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("spawn ")).length;
}

function prompts(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("prompt "))
    .map((line) => line.slice("prompt ".length));
}

function lifecycleStates(client: TestClient): Record<string, unknown>[] {
  return client.events.filter((message) => message.type === "lifecycleState");
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PENDING_ONE = "# First decision\n\n- Status: Proposed\n\n## Context\n\nFirst.\n\n## Decision\n\n";
const PENDING_TWO = "# Second decision\n\n- Status: Proposed\n\n## Context\n\nSecond.\n\n## Decision\n\n";
const PENDING_THREE = "# Third decision\n\n- Status: Proposed\n\n## Context\n\nThird.\n\n## Decision\n\n";

describe("lifecycle runs", () => {
  test(
    "starts one epic-generation peer and reports the initial state first",
    async () => {
      const { server, logPath, url } = await startServer({
        "0001-done.md": "# Done\n\n- Status: Accepted\n",
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });

        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
        });
        expect(lifecycleStates(client)[0]).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
        });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "Epic generation ended without an open epic or a pending ADR.",
        });
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/epic-next"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses startLifecycle, startRun, and saveGoal while the epic peer runs",
    async () => {
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        { agentArguments: "--delay-ms=800" },
      );
      const client = await connect(url);
      const originalGoal = await readFile(goalFile, "utf8");

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor((message) => message.type === "lifecycleState");

        const spawned = Date.now() + 5000;
        while (spawnCount(logPath) < 1 && Date.now() < spawned) await Bun.sleep(25);
        expect(spawnCount(logPath)).toBe(1);

        client.send({ type: "startLifecycle" });
        client.send({ type: "startRun" });
        client.send({ type: "saveGoal", text: "changed" });

        for (const expected of [
          "A lifecycle run is already active.",
          "A lifecycle run is active.",
          "A lifecycle run is active.",
        ]) {
          await client.waitFor(
            (message) => message.type === "error" && message.message === expected,
          );
        }

        expect(
          client.events
            .filter((message) => message.type === "error")
            .map((message) => message.message),
        ).toEqual([
          "A lifecycle run is already active.",
          "A lifecycle run is active.",
          "A lifecycle run is active.",
        ]);
        expect(spawnCount(logPath)).toBe(1);
        expect(await readFile(goalFile, "utf8")).toBe(originalGoal);

        await client.waitFor(
          (message) =>
            message.type === "error" &&
            message.message === "Epic generation ended without an open epic or a pending ADR.",
        );
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "resolves every pending ADR in file-name order, then returns to epic generation",
    async () => {
      const { server, adrDir, logPath, url } = await startServer(
        {
          "0003-third.md": PENDING_THREE,
          "0001-first.md": PENDING_ONE,
          "0002-second.md": PENDING_TWO,
        },
        { agentArguments: "--questions=0" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "epic",
          pass: 1,
          work: null,
        });

        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "adr",
          pass: 1,
          work: { kind: "adr", id: "0001-first.md" },
        });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "adr",
          pass: 1,
          work: { kind: "adr", id: "0002-second.md" },
        });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "adr",
          pass: 1,
          work: { kind: "adr", id: "0003-third.md" },
        });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "epic",
          pass: 1,
          work: null,
        });

        expect(lifecycleStates(client).map((message) => [message.stage, message.work])).toEqual([
          ["epic", null],
          ["adr", { kind: "adr", id: "0001-first.md" }],
          ["adr", { kind: "adr", id: "0002-second.md" }],
          ["adr", { kind: "adr", id: "0003-third.md" }],
          ["epic", null],
        ]);

        for (const file of ["0001-first.md", "0002-second.md", "0003-third.md"]) {
          expect(await readFile(join(adrDir, file), "utf8")).toContain("- Status: Accepted");
        }

        const deadline = Date.now() + 5000;
        while (spawnCount(logPath) < 5 && Date.now() < deadline) await Bun.sleep(50);

        const recorded = prompts(logPath);
        expect(recorded[0]).toBe("/epic-next");
        expect(recorded.slice(1, 4).map((prompt) => prompt.startsWith("/adr-resolve "))).toEqual([
          true,
          true,
          true,
        ]);
        expect(recorded[1]).toContain("0001-first.md");
        expect(recorded[2]).toContain("0002-second.md");
        expect(recorded[3]).toContain("0003-third.md");
        expect(recorded[4]).toBe("/epic-next");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "reports an existing open epic without spawning a peer",
    async () => {
      const epic: OpenEpic = {
        number: 42,
        title: "An existing epic",
        url: "https://example.test/issues/42",
      };
      const { server, logPath, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        { tracker: async () => epic },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "epic",
          pass: 1,
          work: { kind: "epic", id: "42" },
        });
        expect(lifecycleStates(client)).toHaveLength(1);
        expect(spawnCount(logPath)).toBe(0);

        await Bun.sleep(300);
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "error");
        expect(spawnCount(logPath)).toBe(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "ends the run when the epic peer creates an open epic and starts no further peer",
    async () => {
      let lookups = 0;
      const epic: OpenEpic = {
        number: 7,
        title: "Generated epic",
        url: "https://example.test/issues/7",
      };
      const { server, logPath, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        {
          tracker: async () => {
            lookups += 1;
            return lookups === 1 ? undefined : epic;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "epic",
          work: null,
        });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "epic",
          pass: 1,
          work: { kind: "epic", id: "7" },
        });

        await Bun.sleep(300);
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/epic-next"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "replays the current lifecycle state first to a client that connects during a stage",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-done.md": "# Done\n\n- Status: Accepted\n" },
        { agentArguments: "--delay-ms=1200" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor((message) => message.type === "lifecycleState");

        const late = await connect(url);
        try {
          expect(await late.waitFor(() => true)).toMatchObject({
            type: "lifecycleState",
            stage: "epic",
            pass: 1,
            work: null,
          });
          expect(late.events[0]).toMatchObject({
            type: "lifecycleState",
            stage: "epic",
            pass: 1,
            work: null,
          });
        } finally {
          late.close();
        }

        await client.waitFor((message) => message.type === "error");
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );
});
