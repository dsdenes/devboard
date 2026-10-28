import { fixtureRecord, frontmatterStatus, pendingRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import type { EpicLookup, OpenEpic } from "./tracker";
import { testProviderService } from "./fixtures/test-providers";

const temporaryDirectories: string[] = [];
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const MANAGED_SKILL = [
  "---",
  "name: behavior-first-testing",
  "description: Choose tests by observable behavior.",
  "metadata:",
  '  devboard-managed: "true"',
  "---",
  "",
  "# Behavior-first testing",
  "",
  "- Prefer observable behavior over implementation details.",
  "",
].join("\n");
const UNMANAGED_SKILL = [
  "---",
  "name: house-style",
  "description: Follow the house style.",
  "---",
  "",
  "# House style",
  "",
  "- Prefer short functions.",
  "",
].join("\n");

interface TestServer {
  server: Server<unknown>;
  root: string;
  adrDir: string;
  goalFile: string;
  logPath: string;
  url: string;
}

async function temporaryDirectory() {
  const parent = join(import.meta.dir, "..", ".tmp", "lifecycle");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "host-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startServer(
  files: Record<string, string>,
  options: {
    agentArguments?: string;
    tracker?: EpicLookup;
    goalText?: string | null;
    trackerSettle?: { attempts: number; delayMs: number };
    trackerTimeoutMs?: number;
    laneBackoffMs?: number;
    mainPollMs?: number;
    installedSkills?: "managed" | "unmanaged" | "none";
  } = {},
): Promise<TestServer> {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const goalFile = join(root, "GOAL.md");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  if (options.goalText === undefined) {
    await writeFile(goalFile, "# Goal\n\nShip the lifecycle.\n");
  } else if (options.goalText !== null) {
    await writeFile(goalFile, options.goalText);
  }
  const installedSkills = options.installedSkills ?? "managed";
  if (installedSkills !== "none") {
    const name = installedSkills === "managed" ? "behavior-first-testing" : "house-style";
    const source = installedSkills === "managed" ? MANAGED_SKILL : UNMANAGED_SKILL;
    await mkdir(join(root, ".omp", "skills", name), { recursive: true });
    await writeFile(join(root, ".omp", "skills", name, "SKILL.md"), source);
  }
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
    stateDir: join(root, "state"),
    providers: testProviderService(join(root, "state")),
    goalFile,
    agentCommand: `bun ${STUB_AGENT} --log=${logPath} ${options.agentArguments ?? ""}`.trim(),
    tracker: options.tracker ?? (async () => undefined),
    trackerSettle: options.trackerSettle ?? { attempts: 1 },
    trackerTimeoutMs: options.trackerTimeoutMs,
    laneBackoffMs: options.laneBackoffMs,
    mainPollMs: options.mainPollMs,
  });

  return { server, root, adrDir, goalFile, logPath, url: `127.0.0.1:${server.port}` };
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

function exitedPids(logPath: string): number[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("exit "))
    .map((line) => Number(line.slice("exit ".length)));
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

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  if (!predicate()) throw new Error(message);
}

async function waitForAt(
  client: TestClient,
  start: number,
  predicate: (message: Record<string, unknown>) => boolean,
  message: string,
  timeout = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const index = client.events.slice(start).findIndex(predicate);
    if (index >= 0) return client.events[start + index] as Record<string, unknown>;
    await Bun.sleep(25);
  }
  throw new Error(message);
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PENDING_ONE = pendingRecord("0001-first.md", "First decision", "First.", "Choose the first.");
const PENDING_TWO = pendingRecord("0002-second.md", "Second decision", "Second.", "Choose the second.");
const PENDING_THREE = pendingRecord("0003-third.md", "Third decision", "Third.", "Choose the third.");

describe("lifecycle runs", () => {
  test(
    "stops a running lifecycle and closes its in-flight lanes",
    async () => {
      const epic: OpenEpic = {
        number: 55,
        title: "Stoppable",
        url: "https://example.test/issues/55",
      };
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          agentArguments: "--delay-ms=5000",
          tracker: async () => epic,
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "implementation",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "55", url: "https://example.test/issues/55" },
          paused: false,
        });
        expect(await client.waitFor((message) => message.type === "runStarted")).toMatchObject({
          kind: "implementation",
          file: "",
          title: "Stoppable",
          action: "implementing",
        });
        await waitUntil(() => spawnCount(logPath) === 1, "the lifecycle peer did not spawn");
        await waitUntil(() => prompts(logPath).length === 1, "the epic peer did not prompt");

        const stopIndex = client.events.length;
        client.send({ type: "stopLifecycle" });
        expect(
          await waitForAt(
            client,
            stopIndex,
            (message) => message.type === "lifecycleState",
            "the stopped lifecycle did not report an idle state",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 1,
          work: null,
          paused: false,
        });
        const laneSnapshot = await waitForAt(
          client,
          stopIndex,
          (message) =>
            message.type === "laneState" &&
            message.runningLanes === 0 &&
            Array.isArray(message.lanes) &&
            message.lanes.some(
              (lane) =>
                typeof lane === "object" &&
                lane !== null &&
                "status" in lane &&
                lane.status === "failed",
            ),
          "the stopped lanes were not reported",
        );
        expect(laneSnapshot.openEpics).toBe(1);

        const idleIndex = client.events.length;
        client.send({ type: "stopLifecycle" });
        expect(
          await waitForAt(
            client,
            idleIndex,
            (message) => message.type === "error",
            "a second stop was not refused",
          ),
        ).toEqual({ type: "error", message: "No lifecycle run is active." });

        // The interface controls the lifecycle with one button, so a stopped
        // run must be startable again without waiting for the old loop.
        client.send({ type: "startLifecycle" });
        expect(
          await waitForAt(
            client,
            idleIndex,
            (message) => message.type === "lifecycleState" && message.stage === "implementation",
            "the lifecycle did not start again after a stop",
          ),
        ).toMatchObject({ stage: "implementation", pass: 1 });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "starts one epic-generation peer and reports the initial state first",
    async () => {
      const { server, logPath, url } = await startServer({
        "0001-done.md": fixtureRecord("0001-done.md", "Done"),
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });

        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(lifecycleStates(client)[0]).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(lifecycleStates(client)).toEqual([
          { type: "lifecycleState", stage: "epic", pass: 1, work: null, paused: false },
          { type: "lifecycleState", stage: "finished", pass: 1, work: null, paused: false },
        ]);
        expect(client.events.filter((message) => message.type === "error")).toEqual([]);
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
    "closes a finished lane's peer without a stop",
    async () => {
      const { server, logPath, url } = await startServer({
        "0001-done.md": fixtureRecord("0001-done.md", "Done"),
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        await waitUntil(
          () => exitedPids(logPath).length === 1,
          "the finished lane's peer was not closed",
        );

        const spawnLine = readFileSync(logPath, "utf8")
          .split("\n")
          .find((line) => line.startsWith("spawn "));
        expect(spawnLine).toBeDefined();
        expect(exitedPids(logPath)).toEqual([Number(spawnLine?.slice("spawn ".length))]);
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
    "reports the running stage before the tracker lookup returns",
    async () => {
      const lookup = Promise.withResolvers<void>();
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        {},
        {
          tracker: async () => {
            lookups += 1;
            if (lookups === 1) await lookup.promise;
            return undefined;
          },
        },
      );
      const client = await connect(url);
      const other = await connect(url);

      try {
        const initial = {
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        };
        client.send({ type: "startLifecycle" });

        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual(
          initial,
        );
        expect(await other.waitFor((message) => message.type === "lifecycleState")).toEqual(
          initial,
        );
        expect(spawnCount(logPath)).toBe(0);
        expect(client.events.filter((message) => message.type === "runStarted")).toEqual([]);

        const late = await connect(url);
        try {
          expect(await late.waitFor((message) => message.type === "lifecycleState")).toEqual(
            initial,
          );
          expect(late.events[0]).toEqual(initial);
        } finally {
          late.close();
        }

        lookup.resolve();
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "finished",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(lifecycleStates(client)).toEqual([
          initial,
          { type: "lifecycleState", stage: "finished", pass: 1, work: null, paused: false },
        ]);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        other.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "fails a start whose tracker read exceeds its deadline and accepts the next one",
    async () => {
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        {},
        {
          trackerTimeoutMs: 200,
          tracker: async () => {
            lookups += 1;
            if (lookups === 1) await new Promise<never>(() => {});
            return undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });

        const error = await client.waitFor((message) => message.type === "error");
        expect(error.message).toContain("did not answer within 200 ms");
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "goal",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 1,
          work: null,
          paused: false,
        });

        // The timed-out start unwound: the next Start reaches the loop and finishes.
        client.send({ type: "startLifecycle" });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "finished",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(lookups).toBeGreaterThan(1);
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "ignores a tracker answer that arrives after the run stopped and starts cleanly again",
    async () => {
      const answer = Promise.withResolvers<OpenEpic[]>();
      const epic: OpenEpic = {
        number: 77,
        title: "Late answer",
        url: "https://example.test/issues/77",
      };
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        {},
        {
          tracker: async () => {
            lookups += 1;
            if (lookups === 1) return await answer.promise;
            return undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "epic",
        );
        client.send({ type: "stopLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "goal",
        );
        const stoppedAt = client.events.length;

        answer.resolve([epic]);
        await Bun.sleep(250);

        expect(
          client.events
            .slice(stoppedAt)
            .filter((message) => message.type === "laneState" && message.openEpics !== 0),
        ).toEqual([]);
        expect(
          client.events
            .slice(stoppedAt)
            .filter((message) => message.type === "lifecycleState" && message.stage !== "goal"),
        ).toEqual([]);

        // No unwinding promise remains pending: the next Start runs to the end.
        client.send({ type: "startLifecycle" });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "finished",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "finishes when epic generation yields no epic and no pending ADR",
    async () => {
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        {},
        {
          tracker: async () => {
            lookups += 1;
            return undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        const finished = await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(finished).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });

        const lookupsAtFinish = lookups;
        await Bun.sleep(500);
        const index = client.events.indexOf(finished);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(client.events.slice(index + 1)).toEqual([]);
        expect(
          client.events.filter(
            (message) => message.type === "lifecycleState" && message.stage === "finished",
          ),
        ).toHaveLength(1);
        expect(
          client.events.filter((message) => message.type === "error"),
        ).toEqual([]);
        expect(lookups).toBe(lookupsAtFinish);
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/epic-next"]);

        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(
          client.events.filter((message) => message.type === "error"),
        ).toEqual([]);
        expect(lookups).toBe(lookupsAtFinish * 2);
        expect(spawnCount(logPath)).toBe(2);
        expect(prompts(logPath)).toEqual(["/epic-next", "/epic-next"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses startLifecycle, an empty startRun, and saveGoal while the epic peer runs",
    async () => {
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
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
          "No pending ADRs to start.",
          "A lifecycle run is active.",
        ]) {
          await client.waitFor(
            (message) => message.type === "error" && message.message === expected,
          );
        }

        expect(
          client.events
            .filter((message) => message.type === "error")
            .map((message) => message.message)
            .sort(),
        ).toEqual(
          [
            "A lifecycle run is already active.",
            "No pending ADRs to start.",
            "A lifecycle run is active.",
          ].sort(),
        );
        expect(spawnCount(logPath)).toBe(1);
        expect(await readFile(goalFile, "utf8")).toBe(originalGoal);

        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
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
          expect(frontmatterStatus(await readFile(join(adrDir, file), "utf8"))).toBe("accepted");
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
    "implements an existing open epic before generating another",
    async () => {
      const epic: OpenEpic = {
        number: 42,
        title: "An existing epic",
        url: "https://example.test/issues/42",
      };
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          agentArguments: "--delay-ms=1200",
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
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(spawnCount(logPath)).toBe(0);
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "implementation",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "42", url: "https://example.test/issues/42" },
          paused: false,
        });
        expect(await client.waitFor((message) => message.type === "runStarted")).toMatchObject({
          file: "",
          title: "An existing epic",
          action: "implementing",
        });

        const spawned = Date.now() + 5000;
        while (prompts(logPath).length < 1 && Date.now() < spawned) await Bun.sleep(25);
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/implement-next-epic 42"]);
        expect(lifecycleStates(client)).toEqual([
          {
            type: "lifecycleState",
            stage: "epic",
            pass: 1,
            work: null,
            paused: false,
          },
          {
            type: "lifecycleState",
            stage: "implementation",
            pass: 1,
            work: { kind: "epic", id: "42", url: "https://example.test/issues/42" },
            paused: false,
          },
        ]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "returns to epic generation on the next pass after implementation",
    async () => {
      const epic: OpenEpic = {
        number: 7,
        title: "Existing epic",
        url: "https://example.test/issues/7",
      };
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
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
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "implementation",
          ),
        ).toMatchObject({
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "7", url: "https://example.test/issues/7" },
        });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 2,
          work: null,
          paused: false,
        });
        expect(
          await client.waitFor(
            (message) => message.type === "runStarted" && message.title === "Epic generation",
          ),
        ).toMatchObject({ file: "", title: "Epic generation", action: "generating" });

        const started = Date.now() + 5000;
        while (prompts(logPath).length < 2 && Date.now() < started) await Bun.sleep(25);
        expect(spawnCount(logPath)).toBe(2);
        expect(prompts(logPath)).toEqual(["/implement-next-epic 7", "/epic-next"]);
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 2,
          work: null,
          paused: false,
        });
        expect(lifecycleStates(client)).toEqual([
          { type: "lifecycleState", stage: "epic", pass: 1, work: null, paused: false },
          {
            type: "lifecycleState",
            stage: "implementation",
            pass: 1,
            work: { kind: "epic", id: "7", url: "https://example.test/issues/7" },
            paused: false,
          },
          { type: "lifecycleState", stage: "epic", pass: 2, work: null, paused: false },
          { type: "lifecycleState", stage: "finished", pass: 2, work: null, paused: false },
        ]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "waits for a just-created epic the tracker reports only after a delay",
    async () => {
      const epic: OpenEpic = {
        number: 31,
        title: "Just created",
        url: "https://example.test/issues/31",
      };
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          trackerSettle: { attempts: 4, delayMs: 10 },
          tracker: async () => {
            lookups += 1;
            return lookups === 3 || lookups === 4 ? epic : undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "implementation",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "31", url: "https://example.test/issues/31" },
          paused: false,
        });
        expect(
          await client.waitFor(
            (message) => message.type === "runStarted" && message.title === "Just created",
          ),
        ).toMatchObject({ file: "", title: "Just created", action: "implementing" });

        const started = Date.now() + 5000;
        while (prompts(logPath).length < 2 && Date.now() < started) await Bun.sleep(25);
        const lines = prompts(logPath);
        expect(lines[0]).toBe("/epic-next");
        expect(lines[1]).toBe("/implement-next-epic 31");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "waits out a just-closed epic instead of aborting the pass",
    async () => {
      const epic: OpenEpic = {
        number: 32,
        title: "Just closed",
        url: "https://example.test/issues/32",
      };
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          trackerSettle: { attempts: 4, delayMs: 10 },
          tracker: async () => {
            lookups += 1;
            return lookups <= 2 ? epic : undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
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
        expect(
          client.events.filter(
            (message) =>
              message.type === "error" &&
              message.message === "Implementation ended but epic #32 is still open.",
          ),
        ).toEqual([]);

        const started = Date.now() + 5000;
        while (prompts(logPath).length < 2 && Date.now() < started) await Bun.sleep(25);
        expect(prompts(logPath)).toEqual(["/implement-next-epic 32", "/epic-next"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "gives up waiting for a lagging tracker and finishes",
    async () => {
      let lookups = 0;
      const { server, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          trackerSettle: { attempts: 3, delayMs: 10 },
          tracker: async () => {
            lookups += 1;
            return undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(lookups).toBe(4);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses starts and goal saving during implementation",
    async () => {
      const epic: OpenEpic = {
        number: 9,
        title: "Open epic",
        url: "https://example.test/issues/9",
      };
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          agentArguments: "--delay-ms=1200",
          trackerSettle: { attempts: 1, delayMs: 0 },
          tracker: async () => epic,
          laneBackoffMs: 60_000,
          mainPollMs: 60_000,
        },
      );
      const client = await connect(url);
      const originalGoal = await readFile(goalFile, "utf8");

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );

        const spawned = Date.now() + 5000;
        while (spawnCount(logPath) < 1 && Date.now() < spawned) await Bun.sleep(25);
        expect(spawnCount(logPath)).toBe(1);

        client.send({ type: "startLifecycle" });
        client.send({ type: "startRun" });
        client.send({ type: "saveGoal", text: "changed" });

        for (const expected of [
          "A lifecycle run is already active.",
          "No pending ADRs to start.",
          "A lifecycle run is active.",
        ]) {
          await client.waitFor(
            (message) => message.type === "error" && message.message === expected,
          );
        }

        expect(
          client.events
            .filter((message) => message.type === "error")
            .map((message) => message.message)
            .sort(),
        ).toEqual(
          [
            "A lifecycle run is already active.",
            "No pending ADRs to start.",
            "A lifecycle run is active.",
          ].sort(),
        );
        expect(spawnCount(logPath)).toBe(1);
        expect(await readFile(goalFile, "utf8")).toBe(originalGoal);

        await client.waitFor(
          (message) =>
            message.type === "error" &&
            message.message === "Implementation ended but epic #9 is still open.",
        );
        expect(spawnCount(logPath)).toBe(1);
        const lines = prompts(logPath);
        expect(lines[0]).toBe("/implement-next-epic 9");
        expect(lines.length).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "replays implementation state and activity to a reconnecting client",
    async () => {
      const epic: OpenEpic = {
        number: 5,
        title: "Replay the epic",
        url: "https://example.test/issues/5",
      };
      let lookups = 0;
      const { server, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
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
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await client.waitFor(
          (message) => message.type === "activity" && message.text === "Working on epic 5",
        );

        const late = await connect(url);
        try {
          const received = Date.now() + 5000;
          while (late.events.length < 2 && Date.now() < received) await Bun.sleep(25);
          expect(late.events[0]).toEqual({
            type: "lifecycleState",
            stage: "implementation",
            pass: 1,
            work: { kind: "epic", id: "5", url: "https://example.test/issues/5" },
            paused: false,
          });
          const snapshot = late.events.find((message) => message.type === "laneState");
          expect(snapshot).toMatchObject({
            openEpics: 1,
            runningLanes: 1,
            lanes: [
              {
                kind: "implementation",
                status: "running",
                epic: { number: 5, title: "Replay the epic" },
                activity: ["Working on epic 5"],
              },
            ],
          });
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
    "marks a lane retrying without stopping the run when its epic stays open",
    async () => {
      const epic: OpenEpic = {
        number: 11,
        title: "Still open",
        url: "https://example.test/issues/11",
      };
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          trackerSettle: { attempts: 1, delayMs: 0 },
          tracker: async () => epic,
          laneBackoffMs: 60_000,
          mainPollMs: 60_000,
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "Implementation ended but epic #11 is still open.",
        });
        expect(
          await client.waitFor(
            (message) =>
              message.type === "laneState" &&
              Array.isArray(message.lanes) &&
              message.lanes.some(
                (lane) =>
                  typeof lane === "object" &&
                  lane !== null &&
                  "status" in lane &&
                  lane.status === "retrying",
              ),
          ),
        ).toMatchObject({ openEpics: 1, runningLanes: 0 });

        expect(spawnCount(logPath)).toBe(1);
        const lines = prompts(logPath);
        expect(lines).toEqual(["/implement-next-epic 11"]);
        expect(
          lifecycleStates(client).every((message) => message.stage !== "goal"),
        ).toBe(true);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "retries an epic that stayed open in a new lane and finishes when it closes",
    async () => {
      const epic: OpenEpic = {
        number: 33,
        title: "Still open after a yield",
        url: "https://example.test/issues/33",
      };
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          trackerSettle: { attempts: 1, delayMs: 0 },
          tracker: async () => {
            lookups += 1;
            return lookups < 3 ? epic : undefined;
          },
          laneBackoffMs: 20,
          mainPollMs: 60_000,
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );

        const lines = prompts(logPath);
        expect(lines.slice(0, 2)).toEqual([
          "/implement-next-epic 33",
          "/implement-next-epic 33",
        ]);
        expect(lines[2]).toBe("/epic-next");
        const laneSnapshots = client.events.filter(
          (message) => message.type === "laneState" && Array.isArray(message.lanes),
        );
        const attempts = laneSnapshots.flatMap((message) =>
          Array.isArray(message.lanes)
            ? message.lanes
                .filter(
                  (lane): lane is Record<string, unknown> =>
                    typeof lane === "object" && lane !== null && "attempt" in lane,
                )
                .map((lane) => lane.attempt)
            : [],
        );
        expect(attempts).toContain(2);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "retries a lane after the backoff without a second concurrent lane",
    async () => {
      const epic: OpenEpic = {
        number: 34,
        title: "Retry peer",
        url: "https://example.test/issues/34",
      };
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          trackerSettle: { attempts: 1, delayMs: 0 },
          tracker: async () => {
            lookups += 1;
            return lookups < 3 ? epic : undefined;
          },
          laneBackoffMs: 20,
          mainPollMs: 60_000,
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );

        const lines = prompts(logPath);
        expect(lines).toEqual([
          "/implement-next-epic 34",
          "/implement-next-epic 34",
          "/epic-next",
        ]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "returns an aborted run to an editable idle goal state for reconnecting clients",
    async () => {
      const epic: OpenEpic = {
        number: 21,
        title: "Aborted epic",
        url: "https://example.test/issues/21",
      };
      let epicOpen = true;
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          agentArguments: "--blocker-epic=21",
          trackerSettle: { attempts: 1, delayMs: 0 },
          tracker: async () => (epicOpen ? epic : undefined),
        },
      );
      const client = await connect(url);
      const idle = {
        type: "lifecycleState",
        stage: "goal",
        pass: 1,
        work: null,
        paused: false,
      };

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await client.waitFor(
          (message) =>
            message.type === "error" &&
            message.message === "Lifecycle stopped with parked epics: #21.",
        );
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "goal",
        );

        const late = await connect(url);
        try {
          expect(await late.waitFor(() => true)).toEqual(idle);
          expect(late.events[0]).toEqual(idle);
          expect(lifecycleStates(late)).toEqual([idle]);
        } finally {
          late.close();
        }

        const revised = "# Goal\n\nRevised after the abort.\n";
        client.send({ type: "saveGoal", text: revised });
        expect(await client.waitFor((message) => message.type === "goal")).toEqual({
          type: "goal",
          text: revised,
        });
        expect(await readFile(goalFile, "utf8")).toBe(revised);

        epicOpen = false;
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(
          client.events.filter(
            (message) =>
              message.type === "error" &&
              message.message === "A lifecycle run is already active.",
          ),
        ).toEqual([]);
        const lines = prompts(logPath);
        expect(lines[0]).toBe("/implement-next-epic 21");
        expect(lines.at(-1)).toBe("/epic-next");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "returns to the idle goal state when epic generation leaves the same ADRs pending",
    async () => {
      const { server, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        { agentArguments: "--no-resolve --questions=0" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "epic",
        );
        await client.waitFor(
          (message) =>
            message.type === "error" &&
            message.message ===
              "Epic generation left the same ADRs pending without opening an epic.",
        );
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "goal",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 1,
          work: null,
          paused: false,
        });

        await Bun.sleep(300);
        expect(spawnCount(logPath)).toBe(3);
        expect(prompts(logPath)).toEqual([
          "/epic-next",
          expect.stringContaining("/adr-resolve"),
          "/epic-next",
        ]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "returns to the idle goal state when a tracker query throws",
    async () => {
      const { server, logPath, url } = await startServer(
        {},
        {
          tracker: async () => {
            throw new Error("tracker unavailable");
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "error")).toEqual({
          type: "error",
          message: "tracker unavailable",
        });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "goal",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 1,
          work: null,
          paused: false,
        });

        await Bun.sleep(300);
        expect(spawnCount(logPath)).toBe(0);
        expect(lifecycleStates(client)).toEqual([
          { type: "lifecycleState", stage: "epic", pass: 1, work: null, paused: false },
          {
            type: "lifecycleState",
            stage: "goal",
            pass: 1,
            work: null,
            paused: false,
          },
        ]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "implements the epic the generation peer creates and retries when it stays open",
    async () => {
      let lookups = 0;
      const epic: OpenEpic = {
        number: 7,
        title: "Generated epic",
        url: "https://example.test/issues/7",
      };
      const { server, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          trackerSettle: { attempts: 1, delayMs: 0 },
          tracker: async () => {
            lookups += 1;
            return lookups === 1 ? undefined : epic;
          },
          laneBackoffMs: 60_000,
          mainPollMs: 60_000,
        },
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
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "7", url: "https://example.test/issues/7" },
        });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "Implementation ended but epic #7 is still open.",
        });

        const started = Date.now() + 5000;
        while (spawnCount(logPath) < 2 && Date.now() < started) await Bun.sleep(25);
        expect(spawnCount(logPath)).toBe(2);
        const lines = prompts(logPath);
        expect(lines[0]).toBe("/epic-next");
        expect(lines[1]).toBe("/implement-next-epic 7");
        expect(lines).toHaveLength(2);
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
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
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

        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
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
    "replays the finished state first to a client that connects after the run ends",
    async () => {
      const { server, url } = await startServer({});
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const finished = await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(finished).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });

        const late = await connect(url);
        try {
          late.send({ type: "listRecords" });
          late.send({ type: "getGoal" });
          await late.waitFor((message) => message.type === "records");
          await late.waitFor((message) => message.type === "goal");

          expect(late.events[0]).toEqual({
            type: "lifecycleState",
            stage: "finished",
            pass: 1,
            work: null,
            paused: false,
          });
          expect(lifecycleStates(late)).toHaveLength(1);
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
    "sends no lifecycle state to a client when no lifecycle run has ever started",
    async () => {
      const { server, url } = await startServer({});
      const client = await connect(url);

      try {
        client.send({ type: "listRecords" });
        client.send({ type: "getGoal" });
        await client.waitFor((message) => message.type === "records");
        await client.waitFor((message) => message.type === "goal");

        await Bun.sleep(200);
        expect(lifecycleStates(client)).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "replays the new run's stage, not the finished one, to a client that connects later",
    async () => {
      const { server, url } = await startServer({}, { agentArguments: "--delay-ms=1200" });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );

        const reported = lifecycleStates(client).length;
        client.send({ type: "startLifecycle" });
        for (let attempt = 0; lifecycleStates(client).length === reported; attempt += 1) {
          if (attempt > 500) throw new Error("The second lifecycle run reported no state.");
          await Bun.sleep(10);
        }
        expect(lifecycleStates(client)[reported]).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });

        const late = await connect(url);
        try {
          expect(await late.waitFor(() => true)).toEqual({
            type: "lifecycleState",
            stage: "epic",
            pass: 1,
            work: null,
            paused: false,
          });
          expect(late.events[0]).not.toMatchObject({ stage: "finished" });
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
});

describe("lifecycle goal precondition", () => {
  test(
    "refuses startLifecycle when the goal document is absent",
    async () => {
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        {},
        {
          goalText: null,
          tracker: async () => {
            lookups += 1;
            return undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toMatch(/goal/i);

        await Bun.sleep(300);
        expect(client.events.filter((message) => message.type === "error")).toHaveLength(1);
        expect(lifecycleStates(client)).toEqual([]);
        expect(spawnCount(logPath)).toBe(0);
        expect(lookups).toBe(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses startLifecycle when the goal document is only whitespace",
    async () => {
      const { server, logPath, url } = await startServer({}, { goalText: " \n\t\n" });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toMatch(/goal/i);

        await Bun.sleep(300);
        expect(client.events.filter((message) => message.type === "error")).toHaveLength(1);
        expect(lifecycleStates(client)).toEqual([]);
        expect(spawnCount(logPath)).toBe(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses a start after a blank goal is saved and accepts a non-blank replacement",
    async () => {
      const { server, logPath, url } = await startServer({});
      const client = await connect(url);

      try {
        client.send({ type: "saveGoal", text: "" });
        await client.waitFor((message) => message.type === "goal" && message.text === "");

        client.send({ type: "startLifecycle" });
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toMatch(/goal/i);
        await Bun.sleep(300);
        expect(lifecycleStates(client)).toEqual([]);
        expect(spawnCount(logPath)).toBe(0);

        client.send({ type: "saveGoal", text: "# Goal\n\nShip the interface.\n" });
        await client.waitFor(
          (message) =>
            message.type === "goal" && String(message.text).includes("Ship the interface."),
        );
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(spawnCount(logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );
});

describe("lifecycle skills precondition", () => {
  test(
    "refuses startLifecycle when no skills are installed",
    async () => {
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        {},
        {
          installedSkills: "none",
          tracker: async () => {
            lookups += 1;
            return undefined;
          },
        },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toMatch(/skills/i);

        await Bun.sleep(300);
        expect(client.events.filter((message) => message.type === "error")).toHaveLength(1);
        expect(lifecycleStates(client)).toEqual([]);
        expect(spawnCount(logPath)).toBe(0);
        expect(lookups).toBe(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "refuses startLifecycle when only an unmanaged skill is installed",
    async () => {
      const { server, logPath, url } = await startServer(
        {},
        { installedSkills: "unmanaged" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toMatch(/skills/i);

        await Bun.sleep(300);
        expect(client.events.filter((message) => message.type === "error")).toHaveLength(1);
        expect(lifecycleStates(client)).toEqual([]);
        expect(spawnCount(logPath)).toBe(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "accepts startLifecycle once a managed skill is installed",
    async () => {
      const { server, root, logPath, url } = await startServer(
        {},
        { installedSkills: "none" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toMatch(/skills/i);
        expect(spawnCount(logPath)).toBe(0);

        await mkdir(join(root, ".omp", "skills", "behavior-first-testing"), {
          recursive: true,
        });
        await writeFile(
          join(root, ".omp", "skills", "behavior-first-testing", "SKILL.md"),
          MANAGED_SKILL,
        );

        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: false,
        });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/epic-next"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );
});
