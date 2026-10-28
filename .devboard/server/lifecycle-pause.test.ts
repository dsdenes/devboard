import { fixtureRecord, frontmatterStatus, pendingRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const QUESTION_OPTIONS = [
  { label: "Alpha", description: "Alpha leads to the first outcome.", recommended: true },
  { label: "Beta", description: "Beta leads to the second outcome.", recommended: false },
];

interface TestServer {
  server: Server<unknown>;
  root: string;
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
  options: {
    agentArguments?: string;
    tracker?: EpicLookup;
    reviseGoal?: boolean;
    root?: string;
  } = {},
): Promise<TestServer> {
  const root = options.root ?? (await temporaryDirectory());
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const goalFile = join(root, "GOAL.md");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  await writeFile(goalFile, "# Goal\n\nShip the lifecycle.\n");
  await mkdir(join(root, ".omp", "skills", "behavior-first-testing"), { recursive: true });
  await writeFile(
    join(root, ".omp", "skills", "behavior-first-testing", "SKILL.md"),
    MANAGED_SKILL,
  );
  for (const [file, source] of Object.entries(files)) {
    await writeFile(join(adrDir, file), source);
  }

  const logPath = join(root, "agent.log");
  const command = [
    `bun ${STUB_AGENT}`,
    `--log=${logPath}`,
    options.reviseGoal === true ? `--revise-goal --goal=${goalFile}` : "",
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
    stateDir: join(root, "state"),
    providers: testProviderService(join(root, "state")),
    goalFile,
    agentCommand: command,
    tracker: options.tracker ?? (async () => undefined),
    trackerSettle: { attempts: 1 },
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

/**
 * A paused lifecycle answers `resumeLifecycle` with a state event. The server
 * can be busy with other work, so a loaded CI runner needs more than the
 * default wait before calling the resume lost.
 */
const resumeDeadlineMs = 20_000;

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeout = 5000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
  if (!predicate()) throw new Error(message);
}

function indexAfter(
  events: Record<string, unknown>[],
  start: number,
  predicate: (message: Record<string, unknown>) => boolean,
): number {
  const offset = events.slice(start).findIndex(predicate);
  return offset < 0 ? -1 : start + offset;
}

async function waitForIndex(
  client: TestClient,
  start: number,
  predicate: (message: Record<string, unknown>) => boolean,
  message: string,
  timeout = 5000,
): Promise<number> {
  let index = -1;
  await waitUntil(() => (index = indexAfter(client.events, start, predicate)) >= 0, message, timeout);
  return index;
}

async function waitForAt(
  client: TestClient,
  start: number,
  predicate: (message: Record<string, unknown>) => boolean,
  message: string,
  timeout = 5000,
): Promise<Record<string, unknown>> {
  const index = await waitForIndex(client, start, predicate, message, timeout);
  return client.events[index] as Record<string, unknown>;
}

const PENDING_ONE = pendingRecord("0001-first.md", "First decision", "First.", "Choose the first.");
const PENDING_TWO = pendingRecord("0002-second.md", "Second decision", "Second.", "Choose the second.");

/** Covers the revision start/stop and replay, then resumes the suspended peer. */
async function exercisePausedRevision(request: string | undefined) {
  const epic: OpenEpic = {
    number: 21,
    title: "Revision while paused",
    url: "https://example.test/issues/21",
  };
  let lookups = 0;
  const { server, goalFile, logPath, url } = await startServer(
    {},
    {
      agentArguments: "--delay-ms=1000 --questions=1",
      reviseGoal: true,
      tracker: async () => {
        lookups += 1;
        return lookups === 1 ? epic : undefined;
      },
    },
  );
  const client = await connect(url);

  try {
    client.send({ type: "startLifecycle" });
    expect(
      await client.waitFor((message) => message.type === "lifecycleState"),
    ).toEqual({
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
      work: { kind: "epic", id: "21", url: "https://example.test/issues/21" },
      paused: false,
    });
    await waitUntil(() => spawnCount(logPath) === 1, "the lifecycle peer did not spawn");
    expect(prompts(logPath)).toEqual(["/implement-next-epic 21"]);

    client.send({ type: "pauseLifecycle" });
    await client.waitFor(
      (message) => message.type === "lifecycleState" && message.paused === true,
    );
    const pauseIndex = client.events.length;
    const lifecycleActivity = client.events
      .filter((message) => message.type === "activity" && message.lane !== undefined)
      .map((message) => message.text);
    expect(lifecycleActivity).toEqual(["Working on epic 21"]);

    client.send(
      request === undefined
        ? { type: "reviseGoal" }
        : { type: "reviseGoal", request },
    );
    const startedIndex = await waitForIndex(
      client,
      pauseIndex,
      (message) => message.type === "goalRevisionStarted",
      "the revision did not start while paused",
    );
    await waitForIndex(
      client,
      startedIndex,
      (message) => message.type === "activity" && message.text === "Revising the goal",
      "the revision activity was not relayed",
    );
    const revisionQuestion = await waitForAt(
      client,
      startedIndex,
      (message) => message.type === "question",
      "the revision question was not relayed",
    );
    expect(revisionQuestion).toMatchObject({
      id: 1,
      message: "Choose an answer",
      options: QUESTION_OPTIONS,
    });

    expect(spawnCount(logPath)).toBe(2);
    expect(prompts(logPath)[1]?.startsWith("Revise the goal in ")).toBe(true);
    const agentLog = logLines(logPath).join("\n");
    if (request === undefined) {
      expect(agentLog).not.toContain("Guidance:");
    } else {
      expect(agentLog).toContain(`Guidance: ${request}`);
    }

    const resumeAttempt = client.events.length;
    client.send({ type: "resumeLifecycle" });
    expect(
      await waitForAt(
        client,
        resumeAttempt,
        (message) => message.type === "error",
        "resuming during the revision was not refused",
      ),
    ).toEqual({ type: "error", message: "A goal revision is active." });

    client.send({ type: "answer", id: revisionQuestion.id, value: "Alpha" });
    const stopped = await client.waitFor(
      (message) => message.type === "goalRevisionStopped",
    );
    expect(stopped).toEqual({
      type: "goalRevisionStopped",
      completed: true,
      text: "# Revised goal\n\nThe agent rewrote this.",
    });
    const stoppedIndex = client.events.lastIndexOf(stopped);
    expect(await readFile(goalFile, "utf8")).toBe(String(stopped.text));

    expect(
      client.events
        .slice(pauseIndex, stoppedIndex)
        .filter((message) => message.type === "lifecycleState" && message.paused === false),
    ).toEqual([]);
    expect(spawnCount(logPath)).toBe(2);
    expect(logLines(logPath).filter((line) => line.startsWith("revised "))).toHaveLength(1);

    expect(client.events.slice(stoppedIndex + 1).filter(
      (message) => message.type === "runStarted",
    )).toEqual([]);
    const pausedSnapshot = [...client.events]
      .reverse()
      .find((message) => message.type === "laneState");
    expect(pausedSnapshot).toMatchObject({
      lanes: [
        {
          kind: "implementation",
          status: "paused",
          activity: ["Working on epic 21"],
        },
      ],
    });

    const resumeIndex = client.events.length;
    client.send({ type: "resumeLifecycle" });
    expect(
      await waitForAt(
        client,
        resumeIndex,
        (message) => message.type === "lifecycleState" && message.paused === false,
        "the paused lifecycle did not resume",
        resumeDeadlineMs,
      ),
    ).toEqual({
      type: "lifecycleState",
      stage: "implementation",
      pass: 1,
      work: { kind: "epic", id: "21", url: "https://example.test/issues/21" },
      paused: false,
    });

    const resumedQuestion = await waitForAt(
      client,
      resumeIndex,
      (message) => message.type === "question",
      "the original lifecycle peer did not continue",
      10000,
    );
    expect(resumedQuestion).toMatchObject({
      id: 1,
      message: "Choose an answer",
      options: QUESTION_OPTIONS,
    });
    client.send({ type: "answer", id: resumedQuestion.id, value: "Beta" });

    expect(
      await waitForAt(
        client,
        resumeIndex,
        (message) =>
          message.type === "lifecycleState" && message.stage === "epic" && message.pass === 2,
        "the lifecycle did not advance after the resumed stage",
        10000,
      ),
    ).toEqual({
      type: "lifecycleState",
      stage: "epic",
      pass: 2,
      work: null,
      paused: false,
    });
    expect(
      prompts(logPath).filter((prompt) => prompt === "/implement-next-epic 21"),
    ).toHaveLength(1);
    expect(logLines(logPath).filter((line) => line.startsWith("revised "))).toHaveLength(1);
    expect(logLines(logPath).filter((line) => line === "answer Beta")).toHaveLength(1);
  } finally {
    client.close();
    server.stop(true);
  }
}

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
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
        {
          agentArguments: "--delay-ms=6000",
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
        ).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "5", url: "https://example.test/issues/5" },
          paused: false,
        });

        const spawned = Date.now() + 5000;
        while (spawnCount(logPath) < 1 && Date.now() < spawned) await Bun.sleep(25);
        while (prompts(logPath).length < 1 && Date.now() < spawned) await Bun.sleep(25);
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/implement-next-epic 5"]);

        client.send({ type: "pauseLifecycle" });
        const paused = await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        expect(paused).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "5", url: "https://example.test/issues/5" },
          paused: true,
        });

        const activityAtPause = client.events.filter((message) => message.type === "activity").length;
        const statesAtPause = lifecycleStates(client).length;

        await Bun.sleep(2200);
        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/implement-next-epic 5"]);
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
          work: { kind: "epic", id: "5", url: "https://example.test/issues/5" },
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
        expect(prompts(logPath)).toEqual(["/implement-next-epic 5", "/epic-next"]);
        expect(
          prompts(logPath).filter((prompt) => prompt === "/implement-next-epic 5"),
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
          () => frontmatterStatus(readFileSync(join(adrDir, "0001-first.md"), "utf8")) === "accepted",
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
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
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
          work: { kind: "epic", id: "8", url: "https://example.test/issues/8" },
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
          work: { kind: "epic", id: "8", url: "https://example.test/issues/8" },
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
          lifecycleStates(client).filter((message) => message.stage === "epic" && message.pass === 2),
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
    "pauses the initial tracker lookup and resumes into its result",
    async () => {
      const lookup = Promise.withResolvers<void>();
      let lookups = 0;
      const epic: OpenEpic = {
        number: 15,
        title: "Lookup epic",
        url: "https://example.test/issues/15",
      };
      const { server, logPath, url } = await startServer(
        {},
        {
          tracker: async () => {
            lookups += 1;
            if (lookups === 1) {
              await lookup.promise;
              return epic;
            }
            return undefined;
          },
        },
      );
      const client = await connect(url);

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

        client.send({ type: "pauseLifecycle" });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.paused === true,
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "epic",
          pass: 1,
          work: null,
          paused: true,
        });

        await Bun.sleep(200);
        expect(spawnCount(logPath)).toBe(0);

        lookup.resolve();
        await Bun.sleep(400);
        expect(spawnCount(logPath)).toBe(0);
        expect(lifecycleStates(client)).toEqual([
          initial,
          {
            type: "lifecycleState",
            stage: "epic",
            pass: 1,
            work: null,
            paused: true,
          },
        ]);
        expect(client.events.filter((message) => message.type === "runStarted")).toEqual([]);

        client.send({ type: "resumeLifecycle" });
        expect(
          await client.waitFor(
            (message) =>
              message.type === "lifecycleState" && message.stage === "implementation",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "15", url: "https://example.test/issues/15" },
          paused: false,
        });

        await waitUntil(
          () => prompts(logPath).includes("/implement-next-epic 15"),
          "the lifecycle peer did not spawn",
        );
        expect(prompts(logPath)[0]).toBe("/implement-next-epic 15");
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
            type: "laneState",
            lanes: [
              { kind: "generation", status: "closed" },
              {
                kind: "adr",
                record: { file: "0001-first.md", title: "First decision" },
                status: "paused",
                activity: ["Inspecting 0001-first.md"],
                question: {
                  id: 1,
                  message: "Choose an answer",
                  options: QUESTION_OPTIONS,
                },
              },
            ],
            openEpics: 0,
            runningLanes: 0,
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
    "allows goal saving while paused and starts no run without pending ADRs",
    async () => {
      const epic: OpenEpic = {
        number: 4,
        title: "Goal while paused",
        url: "https://example.test/issues/4",
      };
      const { server, goalFile, logPath, url } = await startServer(
        { "0001-done.md": fixtureRecord("0001-done.md", "Done") },
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

        for (const expected of [
          "A lifecycle run is already active.",
          "No pending ADRs to start.",
        ]) {
          expect(
            await client.waitFor(
              (message) => message.type === "error" && message.message === expected,
            ),
          ).toEqual({ type: "error", message: expected });
        }

        expect(spawnCount(logPath)).toBe(1);
        expect(prompts(logPath)).toEqual(["/implement-next-epic 4"]);
        expect(
          lifecycleStates(client).filter((message) => message.paused === false),
        ).toEqual([
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
            work: { kind: "epic", id: "4", url: "https://example.test/issues/4" },
            paused: false,
          },
        ]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "resolves pending ADRs while paused and restores the lifecycle conversation",
    async () => {
      const epic: OpenEpic = {
        number: 31,
        title: "Manual while paused",
        url: "https://example.test/issues/31",
      };
      let lookups = 0;
      const { server, adrDir, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
        {
          agentArguments: "--delay-ms=900 --questions=0",
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
        await waitUntil(() => spawnCount(logPath) === 1, "the lifecycle peer did not spawn");

        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        const pausedIndex = client.events.length;

        client.send({ type: "startRun", file: "0001-first.md" });
        expect(
          await waitForAt(
            client,
            pausedIndex,
            (message) => message.type === "runStarted" && message.file === "0001-first.md",
            "the manual run did not start while paused",
          ),
        ).toEqual({
          type: "runStarted",
          file: "0001-first.md",
          title: "First decision",
          action: "resolving",
          manual: true,
        });

        const resumeIndex = client.events.length;
        client.send({ type: "resumeLifecycle" });
        expect(
          await waitForAt(
            client,
            resumeIndex,
            (message) => message.type === "error",
            "resuming during the manual run was not refused",
          ),
        ).toEqual({ type: "error", message: "A manual ADR run is active." });

        await waitForAt(
          client,
          pausedIndex,
          (message) =>
            message.type === "runStopped" &&
            message.file === "0001-first.md" &&
            message.resolved === true,
          "the first manual record did not resolve",
          10000,
        );
        await waitForAt(
          client,
          pausedIndex,
          (message) => message.type === "runStarted" && message.file === "0002-second.md",
          "the manual sequence did not continue",
          10000,
        );
        await waitForAt(
          client,
          pausedIndex,
          (message) =>
            message.type === "runStopped" &&
            message.file === "0002-second.md" &&
            message.resolved === true,
          "the second manual record did not resolve",
          10000,
        );

        expect(frontmatterStatus(await readFile(join(adrDir, "0001-first.md"), "utf8"))).toBe("accepted");
        expect(frontmatterStatus(await readFile(join(adrDir, "0002-second.md"), "utf8"))).toBe("accepted");
        expect(
          await client.waitFor((message) => message.type === "records" && message.next === null),
        ).toMatchObject({ next: null });

        const pausedSnapshot = [...client.events]
          .reverse()
          .find((message) => message.type === "laneState");
        expect(pausedSnapshot).toMatchObject({
          lanes: [
            {
              kind: "implementation",
              status: "paused",
              epic: { number: 31, title: "Manual while paused" },
            },
          ],
        });
        expect(
          client.events
            .slice(pausedIndex)
            .filter((message) => message.type === "lifecycleState" && message.paused === false),
        ).toEqual([]);
        expect(
          client.events
            .slice(pausedIndex)
            .filter(
              (message) =>
                message.type === "runStarted" &&
                message.lane === undefined &&
                message.manual !== true,
            ),
        ).toEqual([]);
        expect(spawnCount(logPath)).toBe(3);
        expect(prompts(logPath)[0]).toBe("/implement-next-epic 31");
        expect(prompts(logPath)[1]?.startsWith("/adr-resolve ")).toBe(true);
        expect(prompts(logPath)[2]?.startsWith("/adr-resolve ")).toBe(true);
        const resumedIndex = client.events.length;
        client.send({ type: "resumeLifecycle" });
        expect(
          await waitForAt(
            client,
            resumedIndex,
            (message) => message.type === "lifecycleState" && message.paused === false,
            "the paused lifecycle did not resume",
            resumeDeadlineMs,
          ),
        ).toMatchObject({
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "31", url: "https://example.test/issues/31" },
        });
        expect(
          await waitForAt(
            client,
            resumedIndex,
            (message) =>
              message.type === "lifecycleState" && message.stage === "epic" && message.pass === 2,
            "the resumed peer did not advance the lifecycle",
            15000,
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
    30000,
  );

  test(
    "resumes the lifecycle after a manual ADR run that interrupted it",
    async () => {
      const epic: OpenEpic = {
        number: 32,
        title: "Paused while advancing",
        url: "https://example.test/issues/32",
      };
      let lookups = 0;
      const { server, adrDir, logPath, url } = await startServer(
        { "0001-first.md": PENDING_ONE },
        {
          agentArguments: "--delay-ms=1500 --questions=0",
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
        await waitUntil(() => spawnCount(logPath) === 1, "the lifecycle peer did not spawn");

        const beforeStart = client.events.length;
        client.send({ type: "startRun", file: "0001-first.md" });
        const paused = await waitForAt(
          client,
          beforeStart,
          (message) => message.type === "lifecycleState" && message.paused === true,
          "the advancing lifecycle was not paused",
        );
        expect(paused).toMatchObject({
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "32", url: "https://example.test/issues/32" },
        });

        const pausedIndex = client.events.indexOf(paused);
        expect(
          await waitForAt(
            client,
            pausedIndex,
            (message) => message.type === "runStarted" && message.file === "0001-first.md",
            "the manual run did not start after the pause",
          ),
        ).toMatchObject({ manual: true });
        await waitForAt(
          client,
          pausedIndex,
          (message) =>
            message.type === "runStopped" &&
            message.file === "0001-first.md" &&
            message.resolved === true,
          "the manual record did not resolve",
          10000,
        );

        expect(frontmatterStatus(await readFile(join(adrDir, "0001-first.md"), "utf8"))).toBe("accepted");
        expect(spawnCount(logPath)).toBeGreaterThanOrEqual(2);
        expect(prompts(logPath)[0]).toBe("/implement-next-epic 32");
        expect(prompts(logPath)[1]?.startsWith("/adr-resolve ")).toBe(true);
        expect(
          client.events
            .slice(pausedIndex)
            .filter(
              (message) =>
                message.type === "runStarted" &&
                message.lane === undefined &&
                message.manual !== true,
            ),
        ).toEqual([]);
        expect(
          client.events.some(
            (message) =>
              message.type === "laneState" &&
              Array.isArray(message.lanes) &&
              message.lanes.some(
                (lane) =>
                  typeof lane === "object" &&
                  lane !== null &&
                  "kind" in lane &&
                  lane.kind === "implementation" &&
                  "status" in lane &&
                  lane.status === "paused",
              ),
          ),
        ).toBe(true);

        expect(
          await waitForAt(
            client,
            pausedIndex,
            (message) =>
              message.type === "lifecycleState" &&
              message.paused === false &&
              message.stage === "implementation",
            "the manual sequence did not resume the lifecycle",
            10000,
          ),
        ).toMatchObject({
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "32", url: "https://example.test/issues/32" },
        });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "refuses a manual start for the record the lifecycle is resolving",
    async () => {
      const { server, url } = await startServer(
        { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
        { agentArguments: "--delay-ms=2000 --questions=0" },
      );
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "adr",
        );
        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );

        const beforeStart = client.events.length;
        client.send({ type: "startRun", file: "0001-first.md" });
        expect(
          await waitForAt(
            client,
            beforeStart,
            (message) => message.type === "error",
            "the manual start was not refused",
          ),
        ).toEqual({ type: "error", message: "The lifecycle is already resolving that ADR." });
        expect(
          client.events.filter(
            (message) => message.type === "runStarted" && message.manual === true,
          ),
        ).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "stops a paused lifecycle for good instead of leaving it suspended",
    async () => {
      const epic: OpenEpic = {
        number: 41,
        title: "Stopped while paused",
        url: "https://example.test/issues/41",
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
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await waitUntil(() => spawnCount(logPath) === 1, "the lifecycle peer did not spawn");
        await waitUntil(() => prompts(logPath).length >= 1, "the epic peer did not prompt");

        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );

        const stopIndex = client.events.length;
        client.send({ type: "stopLifecycle" });
        expect(
          await waitForAt(
            client,
            stopIndex,
            (message) => message.type === "lifecycleState" && message.stage === "goal",
            "the paused lifecycle did not stop",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(
          await waitForAt(
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
            "the suspended lane was not closed",
          ),
        ).toBeDefined();

        const afterStop = client.events.length;
        client.send({ type: "resumeLifecycle" });
        expect(
          await waitForAt(
            client,
            afterStop,
            (message) => message.type === "error",
            "resuming a stopped lifecycle was not refused",
          ),
        ).toEqual({ type: "error", message: "No lifecycle run is active." });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
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
      const failed = await startServer(
        {},
        { agentArguments: "--blocker-epic=12", tracker: async () => epic },
      );
      const failedClient = await connect(failed.url);
      try {
        failedClient.send({ type: "startLifecycle" });
        await failedClient.waitFor(
          (message) =>
            message.type === "error" &&
            message.message === "Lifecycle stopped with parked epics: #12.",
        );
        await failedClient.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "goal",
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
          agentArguments: "--delay-ms=6000",
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
          (message) =>
            message.type === "lifecycleState" &&
            message.paused === false &&
            message.stage === "implementation",
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

  test(
    "revises the goal with guidance while paused and resumes the interrupted peer",
    async () => {
      await exercisePausedRevision("Tighten the goal");
    },
    40000,
  );

  test(
    "revises the goal without guidance while paused and resumes the interrupted peer",
    async () => {
      await exercisePausedRevision(undefined);
    },
    40000,
  );

  test(
    "replays the pending lifecycle question to every client after a paused revision",
    async () => {
      const epic: OpenEpic = {
        number: 31,
        title: "Question across a revision",
        url: "https://example.test/issues/31",
      };
      let lookups = 0;
      const { server, logPath, url } = await startServer(
        {},
        {
          reviseGoal: true,
          agentArguments: "--questions=1",
          tracker: async () => {
            lookups += 1;
            return lookups === 1 ? epic : undefined;
          },
        },
      );
      const client = await connect(url);
      const late = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        const lifecycleQuestion = await client.waitFor(
          (message) => message.type === "question",
        );
        expect(lifecycleQuestion).toMatchObject({
          id: 1,
          message: "Choose an answer",
          options: QUESTION_OPTIONS,
        });
        const lifecycleActivity = client.events
          .filter((message) => message.type === "activity")
          .map((message) => message.text);
        expect(lifecycleActivity).toEqual(["Working on epic 31"]);

        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        await waitUntil(
          () => late.events.some((message) => message.type === "question"),
          "the late client did not receive the paused conversation",
        );

        const pauseIndex = client.events.length;
        client.send({ type: "reviseGoal", request: "Clarify the goal" });
        const started = await waitForIndex(
          client,
          pauseIndex,
          (message) => message.type === "goalRevisionStarted",
          "the revision did not start",
        );
        const startedLate = await waitForIndex(
          late,
          0,
          (message) => message.type === "goalRevisionStarted",
          "the late client did not see the revision start",
        );
        const revisionQuestion = await waitForAt(
          client,
          started,
          (message) => message.type === "question",
          "the revision question was not relayed",
        );
        await waitForAt(
          late,
          startedLate,
          (message) => message.type === "question",
          "the late client did not see the revision question",
        );

        client.send({ type: "answer", id: revisionQuestion.id, value: "Alpha" });
        const stopped = await waitForIndex(
          client,
          started,
          (message) => message.type === "goalRevisionStopped",
          "the revision did not stop",
        );
        const stoppedLate = await waitForIndex(
          late,
          startedLate,
          (message) => message.type === "goalRevisionStopped",
          "the late client did not see the revision stop",
        );

        for (const target of [client, late]) {
          expect(
            [...target.events].reverse().find((message) => message.type === "laneState"),
          ).toMatchObject({
            lanes: [
              {
                kind: "implementation",
                status: "paused",
                activity: ["Working on epic 31"],
                question: {
                  id: lifecycleQuestion.id,
                  message: lifecycleQuestion.message,
                  options: lifecycleQuestion.options,
                },
              },
            ],
          });
        }
        expect(
          client.events
            .slice(stopped + 1)
            .filter((message) => message.type === "runStarted" && message.lane === undefined),
        ).toEqual([]);
        expect(
          late.events
            .slice(stoppedLate + 1)
            .filter((message) => message.type === "runStarted" && message.lane === undefined),
        ).toEqual([]);

        client.send({ type: "answer", id: lifecycleQuestion.id, value: "Beta" });

        const resumeIndex = client.events.length;
        client.send({ type: "resumeLifecycle" });
        expect(
          await waitForAt(
            client,
            resumeIndex,
            (message) => message.type === "lifecycleState" && message.paused === false,
            "the lifecycle did not resume after the revision",
          ),
        ).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "31", url: "https://example.test/issues/31" },
          paused: false,
        });

        await waitUntil(
          () => logLines(logPath).filter((line) => line === "answer Beta").length === 1,
          "the replayed question did not reach the suspended peer",
          10000,
        );
        expect(client.events.filter((message) => message.type === "error")).toEqual([]);
        expect(
          await waitForAt(
            client,
            resumeIndex,
            (message) =>
              message.type === "lifecycleState" &&
              message.stage === "epic" &&
              message.pass === 2,
            "the lifecycle did not advance after the resumed stage",
            10000,
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
        late.close();
        server.stop(true);
      }
    },
    40000,
  );

  test(
    "retains the lifecycle pass across a server restart",
    async () => {
      const epic: OpenEpic = {
        number: 77,
        title: "Restart the pass",
        url: "https://example.test/issues/77",
      };
      let lookups = 0;
      const first = await startServer(
        {},
        {
          agentArguments: "--delay-ms=100 --questions=0",
          tracker: async () => {
            lookups += 1;
            return lookups === 1 ? epic : undefined;
          },
        },
      );
      const client = await connect(first.url);

      try {
        client.send({ type: "startLifecycle" });
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.pass === 2,
          ),
        ).toMatchObject({ stage: "epic", pass: 2 });
      } finally {
        client.close();
        first.server.stop(true);
      }

      const second = await startServer({}, { root: first.root, tracker: async () => undefined });
      const resumed = await connect(second.url);

      try {
        expect(await resumed.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 2,
          work: null,
          paused: false,
        });
      } finally {
        resumed.close();
        second.server.stop(true);
      }
    },
    30000,
  );
});
