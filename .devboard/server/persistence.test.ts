import { pendingRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import { agentPrompt } from "./acp";
import { createApp } from "./app";
import {
  ACTIVITY_MAX_BYTES,
  ACTIVITY_MAX_ENTRIES,
  ACTIVITY_TRIMMED_MARKER,
  STATE_MAX_BYTES,
  appendActivity,
  readStateFile,
  stateFile,
  trimActivity,
  writeStateFile,
} from "./state";
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
const PENDING_ONE = pendingRecord("0001-first.md", "First decision", "First.", "Choose the first.");
const PENDING_TWO = pendingRecord("0002-second.md", "Second decision", "Second.", "Choose the second.");

async function temporaryDirectory(): Promise<string> {
  // Inside the checkout, never the system temporary directory: the suite keeps
  // every fixture under the repository root.
  const base = join(import.meta.dir, "..", ".tmp", "persistence-tests");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
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
  adrDir: string;
  staticDir: string;
  goalFile: string;
  stateDir: string;
  logPath: string;
}

interface FixtureOptions {
  adrs?: Record<string, string>;
  goal?: string | null;
  git?: boolean;
  skill?: boolean;
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const goalFile = join(root, "GOAL.md");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  if (options.goal !== null) {
    await writeFile(goalFile, options.goal ?? "# Goal\n\nShip the lifecycle.\n");
  }
  for (const [file, source] of Object.entries(options.adrs ?? {})) {
    await writeFile(join(adrDir, file), source);
  }
  if (options.skill !== false) {
    await mkdir(join(root, ".omp", "skills", "behavior-first-testing"), { recursive: true });
    await writeFile(
      join(root, ".omp", "skills", "behavior-first-testing", "SKILL.md"),
      MANAGED_SKILL,
    );
  }
  if (options.git === true) {
    await writeFile(join(root, ".gitignore"), "state/\n");
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "Devboard Test"]);
    git(root, ["config", "user.email", "devboard@example.invalid"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "initial"]);
  }
  return {
    root,
    adrDir,
    staticDir,
    goalFile,
    stateDir: join(root, "state"),
    logPath: join(root, "agent.log"),
  };
}

function git(directory: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", directory, ...args],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
  if (output.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${output.stderr || output.stdout}`);
  }
  return output;
}

interface HostOptions {
  agentArguments?: string;
  tracker?: EpicLookup;
  stateDir?: string;
  laneBackoffMs?: number;
  mainPollMs?: number;
  laneRetentionMs?: number;
  restart?: () => void;
}

function startHost(fixture: Fixture, options: HostOptions = {}): Server<unknown> {
  return createApp({
    adrDir: fixture.adrDir,
    staticDir: fixture.staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: fixture.root,
    stateDir: options.stateDir ?? fixture.stateDir,
    providers: testProviderService(options.stateDir ?? fixture.stateDir),
    goalFile: fixture.goalFile,
    agentCommand: `bun ${STUB_AGENT} --log=${fixture.logPath} ${options.agentArguments ?? ""}`.trim(),
    tracker: options.tracker ?? (async () => undefined),
    trackerSettle: { attempts: 1 },
    laneBackoffMs: options.laneBackoffMs,
    mainPollMs: options.mainPollMs,
    laneRetentionMs: options.laneRetentionMs,
    ...(options.restart === undefined ? {} : { restart: options.restart }),
  });
}

interface TestClient {
  socket: WebSocket;
  events: Record<string, unknown>[];
  send(command: unknown): void;
  waitFor(
    predicate: (message: Record<string, unknown>) => boolean,
    message?: string,
    timeout?: number,
  ): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(url: string): Promise<TestClient> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const events: Record<string, unknown>[] = [];
  const buffered: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }[] = [];

  socket.onopen = () => {
    settle({
      socket,
      events,
      send(command) {
        socket.send(JSON.stringify(command));
      },
      waitFor(
        predicate,
        message = `the expected event did not arrive; saw ${events
          .slice(-6)
          .map((event) => String(event.type))
          .join(",")}`,
        timeout = 10000,
      ) {
        const index = buffered.findIndex(predicate);
        if (index >= 0) {
          const found = buffered.splice(index, 1)[0];
          if (found !== undefined) return Promise.resolve(found);
        }
        {
          const { promise: waiting, resolve: ready } =
            Promise.withResolvers<Record<string, unknown>>();
          const entry = { predicate, resolve: ready };
          waiters.push(entry);
          setTimeout(() => {
            const at = waiters.indexOf(entry);
            if (at >= 0) {
              waiters.splice(at, 1);
              ready(Promise.reject(new Error(message)) as never);
            }
          }, timeout);
          return waiting;
        }
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
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function prompts(logPath: string): string[] {
  return logLines(logPath)
    .filter((line) => line.startsWith("prompt "))
    .map((line) => line.slice("prompt ".length));
}

function spawnPids(logPath: string): number[] {
  return logLines(logPath)
    .filter((line) => line.startsWith("spawn "))
    .map((line) => Number(line.slice("spawn ".length)));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeout = 10000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  if (!(await predicate())) throw new Error(message);
}

function storedPath(fixture: Fixture): string {
  return stateFile(fixture.stateDir, resolve(fixture.root));
}

function readStored(fixture: Fixture): Record<string, unknown> {
  const load = readStateFile(storedPath(fixture));
  if (load.kind !== "loaded") throw new Error(`the state file is ${load.kind}`);
  return load.value as Record<string, unknown>;
}

function storedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const lifecycle = { stage: "goal", pass: 1, work: null, paused: false };
  return {
    lifecycle,
    lastLifecycle: lifecycle,
    lifecycleRunning: false,
    lifecyclePausedForManualRun: false,
    laneSequence: 0,
    lanes: [],
    epicStates: [],
    parkedEpics: [],
    knownEpics: [],
    generationQueued: false,
    generationAttempted: false,
    manualSequencing: false,
    manualRun: null,
    goalCreation: null,
    goalRevision: null,
    skillsPreparation: null,
    skillsPreparationPending: null,
    resetActive: false,
    restartWhenIdle: false,
    children: [],
    ...overrides,
  };
}

function writeStored(fixture: Fixture, overrides: Record<string, unknown> = {}): void {
  writeStateFile(
    storedPath(fixture),
    `${JSON.stringify({ version: 1, state: storedState(overrides) })}\n`,
  );
}

function laneEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lane-1",
    kind: "implementation",
    epic: { number: 77, title: "Restored", url: "https://fixture.test/issues/77" },
    record: null,
    attempt: 1,
    status: "running",
    activity: ["Working on epic 77"],
    question: null,
    blocked: false,
    failure: null,
    retainUntil: null,
    ...overrides,
  };
}

describe("state location", () => {
  test("keys the state file by a 24-hex prefix of the resolved repository", () => {
    const first = stateFile("/state", "/repo/one");
    const second = stateFile("/state", "/repo/two");
    expect(first).toMatch(/^\/state\/state\/[0-9a-f]{24}\.json$/);
    expect(second).toMatch(/^\/state\/state\/[0-9a-f]{24}\.json$/);
    expect(first).not.toBe(second);
    expect(stateFile("/state", "/repo/one")).toBe(first);
  });

  test(
    "keeps two repositories sharing one state directory apart",
    async () => {
      const shared = await temporaryDirectory();
      const first = await createFixture({ git: true });
      const second = await createFixture({ git: true });
      const epic: OpenEpic = {
        number: 11,
        title: "Only the first",
        url: "https://fixture.test/issues/11",
      };
      const firstHost = startHost(first, {
        stateDir: shared,
        agentArguments: "--delay-ms=5000",
        tracker: async () => epic,
      });
      const firstClient = await connect(`127.0.0.1:${firstHost.port}`);
      const secondHost = startHost(second, {
        stateDir: shared,
        agentArguments: "--no-close",
      });
      const secondClient = await connect(`127.0.0.1:${secondHost.port}`);

      try {
        firstClient.send({ type: "startLifecycle" });
        await firstClient.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await waitUntil(
          () => existsSync(stateFile(shared, resolve(first.root))),
          "the first repository's state was not written",
        );
        expect(existsSync(stateFile(shared, resolve(second.root)))).toBe(false);

        secondClient.send({ type: "listRecords" });
        await secondClient.waitFor((message) => message.type === "records");
        expect(secondClient.events.filter((message) => message.type === "lifecycleState")).toEqual(
          [],
        );
        expect(secondClient.events.filter((message) => message.type === "laneState")).toEqual([]);

        const stored = readStateFile(stateFile(shared, resolve(first.root)));
        expect(stored.kind).toBe("loaded");
        const state = (stored as { value: Record<string, unknown> }).value;
        expect(state.lifecycleRunning).toBe(true);
        expect(state.knownEpics).toEqual([epic]);
      } finally {
        firstClient.close();
        secondClient.close();
        firstHost.stop(true);
        secondHost.stop(true);
      }
    },
    30000,
  );
});

describe("durable writes", () => {
  test(
    "writes the state before the event that announces it is broadcast",
    async () => {
      const fixture = await createFixture({ git: true });
      let lookups = 0;
      const host = startHost(fixture, {
        tracker: async () => {
          lookups += 1;
          return lookups === 1
            ? { number: 21, title: "Announced", url: "https://fixture.test/issues/21" }
            : undefined;
        },
      });
      const client = await connect(`127.0.0.1:${host.port}`);

      try {
        client.send({ type: "startLifecycle" });
        const announced = await client.waitFor(
          (message) => message.type === "lifecycleState" && message.pass === 2,
        );
        // The event has travelled to the client; the state behind it is already
        // on disk.
        const state = readStored(fixture);
        expect(state.lifecycle).toMatchObject({
          stage: announced.stage,
          pass: announced.pass,
          work: announced.work,
          paused: announced.paused,
        });
      } finally {
        client.close();
        host.stop(true);
      }
    },
    30000,
  );

  test("replaces the state file atomically and keeps the last complete state", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "state", "abc.json");
    writeStateFile(path, '{"version":1,"state":{"lifecycle":{"stage":"goal"}}}\n');
    expect(readStateFile(path).kind).toBe("loaded");
    expect(readdirSync(join(directory, "state"))).toEqual(["abc.json"]);

    // A destination whose parent cannot be a directory fails before the
    // rename, so the previous complete state stays readable.
    const blocked = join(directory, "blocked");
    writeFileSync(blocked, "not a directory");
    const target = join(blocked, "state", "abc.json");
    expect(() => writeStateFile(target, "second")).toThrow();
    writeStateFile(path, '{"version":1,"state":{"lifecycle":{"stage":"epic"}}}\n');
    const load = readStateFile(path);
    expect(load.kind).toBe("loaded");
    expect((load as { value: { lifecycle: { stage: string } } }).value.lifecycle.stage).toBe("epic");
  });

  test(
    "keeps the state file parseable across SIGKILLs during writes",
    async () => {
      const directory = await temporaryDirectory();
      const statePath = join(directory, "state", "key.json");
      const script = join(directory, "writer.ts");
      await writeFile(
        script,
        [
          `import { writeStateFile } from ${JSON.stringify(join(import.meta.dir, "state.ts"))};`,
          `const path = ${JSON.stringify(statePath)};`,
          'const activity = Array.from({ length: 400 }, (_, index) =>',
          '  `line ${index} `.repeat(40),',
          ');',
          'const payload = JSON.stringify({',
          '  version: 1,',
          '  state: {',
          '    lifecycle: { stage: "epic", pass: 2, work: null, paused: false },',
          '    activity,',
          '  },',
          '});',
          "for (;;) writeStateFile(path, payload);",
        ].join("\n"),
      );

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const child = Bun.spawn({
          cmd: [process.execPath, script],
          stdout: "ignore",
          stderr: "ignore",
        });
        // The completed first write is the signal that the child is inside its
        // loop: a fixed sleep measures process startup on a loaded host instead
        // and kills the child before it has written anything. Every window after
        // it still lands between two writes.
        await waitUntil(
          () => readStateFile(statePath).kind === "loaded",
          "the writer never completed its first write",
        );
        await Bun.sleep(15 + attempt * 10);
        child.kill("SIGKILL");
        await child.exited;
        const load = readStateFile(statePath);
        expect(load.kind).toBe("loaded");
        if (load.kind === "loaded") {
          expect((load.value as { lifecycle: { pass: number } }).lifecycle.pass).toBe(2);
        }
      }
      // A killed writer leaves a temporary file behind at most; the next write
      // still replaces the state atomically.
      writeStateFile(
        statePath,
        '{"version":1,"state":{"lifecycle":{"stage":"goal","pass":1,"work":null,"paused":false}}}\n',
      );
      expect(readStateFile(statePath).kind).toBe("loaded");
    },
    30000,
  );
});

describe("unusable state", () => {
  const cases: { label: string; write: (path: string) => void; reason: string }[] = [
    {
      label: "truncated JSON",
      write: (path) => writeFileSync(path, '{"version":1,"state":{"lifecycle":'),
      reason: "not valid JSON",
    },
    {
      label: "unsupported version",
      write: (path) => writeFileSync(path, '{"version":9,"state":{}}'),
      reason: "unsupported version 9",
    },
    {
      label: "the wrong shape",
      write: (path) => writeFileSync(path, '{"version":1,"state":{"lifecycle":null}}'),
      reason: "not a dashboard state",
    },
  ];

  for (const entry of cases) {
    test(
      `starts from the initial state after ${entry.label}`,
      async () => {
        const fixture = await createFixture({ git: true });
        const path = storedPath(fixture);
        await mkdir(join(fixture.stateDir, "state"), { recursive: true });
        entry.write(path);
        const before = readFileSync(path, "utf8");

        const host = startHost(fixture);
        const client = await connect(`127.0.0.1:${host.port}`);
        try {
          const error = await client.waitFor((message) => message.type === "error");
          expect(String(error.message)).toContain(entry.reason);
          expect(
            client.events.filter((message) => message.type === "error").length,
          ).toBe(1);
          client.send({ type: "getProject" });
          await client.waitFor((message) => message.type === "project");
          expect(client.events.filter((message) => message.type === "error").length).toBe(1);

          const preserved = readdirSync(join(fixture.stateDir, "state")).filter((name) =>
            name.includes(".damaged-"),
          );
          expect(preserved.length).toBe(1);
          expect(readFileSync(join(fixture.stateDir, "state", String(preserved[0])), "utf8")).toBe(
            before,
          );
        } finally {
          client.close();
          host.stop(true);
        }
      },
      20000,
    );
  }
});

describe("bounded activity", () => {
  test("keeps the newest entries behind one marker when a store exceeds its bounds", () => {
    const lines = Array.from({ length: ACTIVITY_MAX_ENTRIES + 25 }, (_, index) => `line ${index}`);
    trimActivity(lines);
    expect(lines.length).toBe(ACTIVITY_MAX_ENTRIES);
    expect(lines[0]).toBe(ACTIVITY_TRIMMED_MARKER);
    expect(lines[lines.length - 1]).toBe(`line ${ACTIVITY_MAX_ENTRIES + 24}`);
    expect(lines[1]).toBe("line 26");

    const oversized = ["x".repeat(ACTIVITY_MAX_BYTES + 1)];
    trimActivity(oversized);
    expect(oversized[0]).toBe(ACTIVITY_TRIMMED_MARKER);
    expect(oversized.length).toBe(2);
    expect(oversized[1]?.length).toBe(ACTIVITY_MAX_BYTES + 1);

    const appended: string[] = [];
    appendActivity(appended, "first", false);
    appendActivity(appended, " and more", true);
    expect(appended).toEqual(["first and more"]);
  });

  test(
    "keeps a fully populated state under the serialized bound",
    async () => {
      const fixture = await createFixture({ git: true });
      const entry = "a".repeat(Math.floor(ACTIVITY_MAX_BYTES / (ACTIVITY_MAX_ENTRIES - 2)));
      const activity = [ACTIVITY_TRIMMED_MARKER];
      for (let index = 0; index < ACTIVITY_MAX_ENTRIES - 1; index += 1) activity.push(entry);

      const epics = Array.from({ length: 20 }, (_, index) => ({
        number: index + 1,
        title: `Epic ${index + 1}`,
        url: "",
      }));
      writeStored(fixture, {
        lifecycle: { stage: "implementation", pass: 3, work: null, paused: false },
        lastLifecycle: { stage: "implementation", pass: 3, work: null, paused: false },
        lifecycleRunning: true,
        laneSequence: 20,
        lanes: epics.map((epic) =>
          laneEntry({
            id: `lane-${epic.number}`,
            epic,
            activity: [...activity],
            status: "running",
          }),
        ),
        knownEpics: epics,
        epicStates: epics.map((epic) => ({
          id: String(epic.number),
          epic,
          attempts: 1,
          status: "running",
          mainAtFailure: null,
        })),
      });
      expect((await stat(storedPath(fixture))).size).toBeLessThan(STATE_MAX_BYTES);

      // Restoring 20 concurrent lanes must keep the state inside the same
      // bound as those lanes append to it.
      const host = startHost(fixture, { agentArguments: "--delay-ms=5000" });
      try {
        await waitUntil(
          () => spawnPids(fixture.logPath).length === 20,
          "not every restored lane was re-spawned",
          60000,
        );
        const bytes = (await stat(storedPath(fixture))).size;
        expect(bytes).toBeLessThan(STATE_MAX_BYTES);
        const restored = readStored(fixture).lanes as { activity: string[] }[];
        expect(restored.length).toBe(20);
        for (const lane of restored) {
          expect(lane.activity.length).toBeLessThanOrEqual(ACTIVITY_MAX_ENTRIES);
          expect(lane.activity[0]).toBe(ACTIVITY_TRIMMED_MARKER);
          const total = lane.activity.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
          expect(total).toBeLessThanOrEqual(ACTIVITY_MAX_BYTES);
        }
      } finally {
        host.stop(true);
      }
    },
    90000,
  );
});

describe("lifecycle restore", () => {
  test(
    "restores a running lifecycle, its lanes, activity, and question",
    async () => {
      const fixture = await createFixture({ git: true });
      const epic: OpenEpic = {
        number: 41,
        title: "Restored lane",
        url: "https://fixture.test/issues/41",
      };
      const first = startHost(fixture, {
        agentArguments: "--delay-ms=300 --questions=1 --no-close",
        tracker: async () => epic,
        laneBackoffMs: 60_000,
      });
      const client = await connect(`127.0.0.1:${first.port}`);

      let laneId = "";
      let questionId: unknown;
      try {
        client.send({ type: "startLifecycle" });
        const question = await client.waitFor(
          (message) => message.type === "question" && typeof message.lane === "string",
        );
        laneId = String(question.lane);
        questionId = question.id;
        const snapshot = await client.waitFor(
          (message) =>
            message.type === "laneState" &&
            Array.isArray(message.lanes) &&
            (message.lanes as { id: string; question: unknown }[]).some(
              (lane) => lane.id === laneId && lane.question !== null,
            ),
        );
        const recorded = (snapshot.lanes as { id: string; activity: string[] }[]).find(
          (lane) => lane.id === laneId,
        );
        expect(recorded?.activity).toEqual(["Working on epic 41"]);
        expect(readStored(fixture).lifecycleRunning).toBe(true);
        expect(prompts(fixture.logPath)).toEqual(["/implement-next-epic 41"]);
        client.close();
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, {
        agentArguments: "--delay-ms=5000 --questions=1 --no-close",
        tracker: async () => epic,
        laneBackoffMs: 60_000,
      });
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        expect(await resumed.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "41", url: "https://fixture.test/issues/41" },
          paused: false,
        });
        const snapshot = await resumed.waitFor((message) => message.type === "laneState");
        const lanes = snapshot.lanes as {
          id: string;
          kind: string;
          attempt: number;
          status: string;
          activity: string[];
          question: { id: unknown } | null;
        }[];
        expect(lanes.length).toBe(1);
        expect(lanes[0]?.id).toBe(laneId);
        expect(lanes[0]?.kind).toBe("implementation");
        expect(lanes[0]?.attempt).toBe(1);
        expect(lanes[0]?.status).toBe("running");
        expect(lanes[0]?.activity).toEqual(["Working on epic 41"]);
        expect(lanes[0]?.question?.id).toBe(questionId);
        expect(snapshot.openEpics).toBe(1);

        await waitUntil(
          () => prompts(fixture.logPath).length === 2,
          "the replacement did not re-spawn the restored lane",
        );
        expect(prompts(fixture.logPath)).toEqual([
          "/implement-next-epic 41",
          "/implement-next-epic 41",
        ]);
        const pids = spawnPids(fixture.logPath);
        expect(pids.length).toBe(2);
        expect(alive(pids[0] ?? 0)).toBe(false);
        expect(alive(pids[1] ?? 0)).toBe(true);

        // The restored question is refused until the replacement re-issues one.
        expect(lanes[0]?.question).not.toBeNull();
        resumed.send({ type: "answer", lane: laneId, id: questionId, value: "Beta" });
        const refusal = await resumed.waitFor((message) => message.type === "error");
        expect(refusal.message).toBe("The question is no longer pending.");

        const reissued = await resumed.waitFor(
          (message) => message.type === "question" && message.lane === laneId,
        );
        resumed.send({ type: "answer", lane: laneId, id: reissued.id, value: "Beta" });
        await waitUntil(
          () => logLines(fixture.logPath).includes("answer Beta"),
          "the replacement question was not answerable",
        );
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    40000,
  );

  test(
    "restores a paused lifecycle without spawning and resumes on resumeLifecycle",
    async () => {
      const fixture = await createFixture({ git: true });
      const epic: OpenEpic = {
        number: 52,
        title: "Paused lane",
        url: "https://fixture.test/issues/52",
      };
      const first = startHost(fixture, {
        agentArguments: "--delay-ms=5000 --no-close",
        tracker: async () => epic,
      });
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        await client.waitFor(
          (message) => message.type === "activity" && message.text === "Working on epic 52",
        );
        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        await waitUntil(
          () =>
            (client.events.filter((message) => message.type === "laneState").at(-1) as
              | { lanes: { status: string }[] }
              | undefined)?.lanes[0]?.status === "paused",
          "the lane did not report paused",
        );
        expect(prompts(fixture.logPath)).toEqual(["/implement-next-epic 52"]);
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, {
        agentArguments: "--delay-ms=5000 --no-close",
        tracker: async () => epic,
      });
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        expect(await resumed.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "implementation",
          pass: 1,
          work: { kind: "epic", id: "52", url: "https://fixture.test/issues/52" },
          paused: true,
        });
        const snapshot = await resumed.waitFor((message) => message.type === "laneState");
        expect((snapshot.lanes as { status: string }[])[0]?.status).toBe("paused");

        // No stage transition, tracker read, retry, generation pass, or peer
        // happens while the restored run stays paused.
        await Bun.sleep(400);
        expect(prompts(fixture.logPath)).toEqual(["/implement-next-epic 52"]);
        expect(spawnPids(fixture.logPath).length).toBe(1);
        expect(resumed.events.filter((message) => message.type === "runStarted")).toEqual([]);

        resumed.send({ type: "resumeLifecycle" });
        const resumedState = await resumed.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === false,
        );
        expect(resumedState.stage).toBe("implementation");
        await waitUntil(
          () => prompts(fixture.logPath).length === 2,
          "resume did not re-spawn the interrupted lane",
        );
        expect(prompts(fixture.logPath)).toEqual([
          "/implement-next-epic 52",
          "/implement-next-epic 52",
        ]);
        const laneSnapshot = await resumed.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { status: string }[])[0]?.status === "running",
        );
        expect(laneSnapshot.lanes as unknown).toBeDefined();
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    40000,
  );

  test(
    "replays a finished lifecycle with its final pass and retained lanes",
    async () => {
      const fixture = await createFixture({ git: true, adrs: {} });
      const env = { agentArguments: "--delay-ms=50" };
      const first = startHost(fixture, env);
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
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
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, env);
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        resumed.send({ type: "getProject" });
        await resumed.waitFor((message) => message.type === "project");
        const stateIndex = resumed.events.findIndex(
          (message) => message.type === "lifecycleState",
        );
        const replyIndex = resumed.events.findIndex((message) => message.type === "project");
        expect(stateIndex).toBeGreaterThanOrEqual(0);
        expect(stateIndex).toBeLessThan(replyIndex);
        expect(resumed.events[stateIndex]).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 1,
          work: null,
          paused: false,
        });
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    30000,
  );

  test(
    "replays the idle goal stage with the reached pass after stopLifecycle",
    async () => {
      const fixture = await createFixture({ git: true });
      const epic: OpenEpic = {
        number: 61,
        title: "Idle pass",
        url: "https://fixture.test/issues/61",
      };
      let lookups = 0;
      const first = startHost(fixture, {
        tracker: async () => {
          lookups += 1;
          return lookups === 1 ? epic : undefined;
        },
      });
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.pass === 2,
        );
        client.send({ type: "stopLifecycle" });
        await client.waitFor(
          (message) =>
            message.type === "lifecycleState" && message.stage === "goal" && message.pass === 2,
        );
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture);
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        expect(await resumed.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 2,
          work: null,
          paused: false,
        });
        const snapshot = await resumed.waitFor((message) => message.type === "laneState");
        // The retained tabs are part of the restored state; the run itself is idle.
        const statuses = (snapshot.lanes as { status: string }[]).map((lane) => lane.status);
        expect(statuses.length).toBeGreaterThan(0);
        // A lane still live when the lifecycle stopped keeps its failed tab;
        // a finished one is closed. Both are retained and idle.
        expect(statuses.every((status) => status === "closed" || status === "failed")).toBe(true);
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    30000,
  );
});

describe("lifecycle replay boundaries", () => {
  test(
    "sends no lifecycleState for a repository whose lifecycle never ran",
    async () => {
      const fixture = await createFixture({
        skill: false,
        adrs: { "0001-first.md": PENDING_ONE },
      });
      const args = "--delay-ms=20 --questions=0";
      const first = startHost(fixture, { agentArguments: args });
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStopped");
        expect(client.events.filter((message) => message.type === "lifecycleState")).toEqual([]);
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, { agentArguments: args });
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        resumed.send({ type: "getProject" });
        await resumed.waitFor((message) => message.type === "project");
        expect(resumed.events.filter((message) => message.type === "lifecycleState")).toEqual([]);
        expect(readStored(fixture).lastLifecycle).toBeNull();
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    20000,
  );

  test(
    "replays the idle goal state of an aborted run",
    async () => {
      const fixture = await createFixture({ git: true });
      const first = startHost(fixture, {
        tracker: async () => {
          throw new Error("tracker unavailable");
        },
      });
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "startLifecycle" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "tracker unavailable",
        });
        expect(
          await client.waitFor(
            (message) =>
              message.type === "lifecycleState" && message.stage === "goal" && message.pass === 1,
          ),
        ).toMatchObject({ stage: "goal", pass: 1, work: null, paused: false });
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture);
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        expect(await resumed.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 1,
          work: null,
          paused: false,
        });
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    20000,
  );
});

describe("epic bookkeeping and generation", () => {
  test(
    "restores a retrying epic and retries it after the backoff",
    async () => {
      const fixture = await createFixture({ git: true });
      const epic: OpenEpic = {
        number: 71,
        title: "Retrying epic",
        url: "https://fixture.test/issues/71",
      };
      const run = () =>
        startHost(fixture, {
          agentArguments: "--delay-ms=20",
          tracker: async () => epic,
          laneBackoffMs: 100,
          mainPollMs: 100,
        });
      const first = run();
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "startLifecycle" });
        const snapshot = await client.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { status: string }[])[0]?.status === "retrying",
        );
        expect((snapshot.lanes as { activity: string[] }[])[0]?.activity).toEqual([
          "Working on epic 71",
        ]);
        const state = readStored(fixture);
        const stored = state.epicStates as { status: string; attempts: number }[];
        expect(stored[0]?.status).toBe("retrying");
        expect(stored[0]?.attempts).toBe(1);
      } finally {
        client.close();
        first.stop(true);
      }

      const second = run();
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        const snapshot = await resumed.waitFor((message) => message.type === "laneState");
        expect((snapshot.lanes as { status: string }[])[0]?.status).toBe("retrying");
        await waitUntil(
          () => prompts(fixture.logPath).length === 2,
          "the restored retrying epic did not run again",
        );
        expect(prompts(fixture.logPath)).toEqual([
          "/implement-next-epic 71",
          "/implement-next-epic 71",
        ]);
        const retried = await resumed.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { attempt: number; status: string }[]).some(
              (lane) => lane.attempt === 2,
            ),
        );
        expect(retried.lanes as unknown).toBeDefined();
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    40000,
  );

  test(
    "restores a parked epic and waits for main to advance",
    async () => {
      const fixture = await createFixture({ git: true });
      const parked: OpenEpic = {
        number: 81,
        title: "Parked epic",
        url: "https://fixture.test/issues/81",
      };
      const running: OpenEpic = {
        number: 82,
        title: "Running epic",
        url: "https://fixture.test/issues/82",
      };
      const run = () =>
        startHost(fixture, {
          // Epic 81 parks; epic 82 keeps the run alive past the kill.
          agentArguments: "--blocker-epic=81 --lane-delay=82:6000 --no-close",
          tracker: async () => [parked, running],
          laneBackoffMs: 100,
          mainPollMs: 100,
        });
      const first = run();
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { status: string }[]).some((lane) => lane.status === "parked"),
        );
        await client.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { status: string }[]).some((lane) => lane.status === "running"),
        );
        const state = readStored(fixture);
        expect(state.parkedEpics).toEqual(["81"]);
        expect(state.lifecycleRunning).toBe(true);
        const parkedState = (state.epicStates as {
          id: string;
          status: string;
          mainAtFailure: string | null;
        }[]).find((entry) => entry.id === "81");
        expect(parkedState?.status).toBe("parked");
        expect(parkedState?.mainAtFailure).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        client.close();
        first.stop(true);
      }

      const second = run();
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        const snapshot = await resumed.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { status: string }[]).length >= 2,
        );
        const statuses = (snapshot.lanes as { status: string }[]).map((lane) => lane.status);
        expect(statuses).toContain("parked");
        // While main stays where it was, the parked epic starts no peer again.
        const parkedPrompts = () =>
          prompts(fixture.logPath).filter((prompt) => prompt === "/implement-next-epic 81").length;
        await Bun.sleep(500);
        expect(parkedPrompts()).toBe(1);

        await writeFile(join(fixture.root, "advance.txt"), "advance\n");
        git(fixture.root, ["add", "advance.txt"]);
        git(fixture.root, ["commit", "-q", "-m", "advance main"]);
        await waitUntil(
          () => parkedPrompts() === 2,
          "the parked epic did not run after main advanced",
        );
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    40000,
  );

  test(
    "resumes an in-flight generation lane with its recorded activity",
    async () => {
      const fixture = await createFixture({ git: true });
      const first = startHost(fixture, { agentArguments: "--delay-ms=2000" });
      const client = await connect(`127.0.0.1:${first.port}`);
      let laneId = "";
      try {
        client.send({ type: "startLifecycle" });
        const snapshot = await client.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { kind: string }[])[0]?.kind === "generation",
        );
        const lane = (snapshot.lanes as { id: string; kind: string; status: string }[])[0];
        expect(lane?.kind).toBe("generation");
        expect(lane?.status).toBe("running");
        laneId = String(lane?.id);
        await client.waitFor(
          (message) => message.type === "activity" && message.text === "Choosing the next epics",
        );
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, { agentArguments: "--delay-ms=100 --questions=0" });
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        const snapshot = await resumed.waitFor((message) => message.type === "laneState");
        const lane = (snapshot.lanes as { id: string; kind: string; activity: string[] }[])[0];
        expect(lane?.id).toBe(laneId);
        expect(lane?.kind).toBe("generation");
        expect(lane?.activity.slice(0, 1)).toEqual(["Choosing the next epics"]);
        await waitUntil(
          () => prompts(fixture.logPath).filter((prompt) => prompt === "/epic-next").length === 2,
          "the restored generation lane did not re-spawn",
        );
        expect(
          await resumed.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "finished",
          ),
        ).toMatchObject({ stage: "finished" });
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    40000,
  );

  test(
    "runs a queued generation exactly once after the restored pass",
    async () => {
      const fixture = await createFixture({ git: true });
      writeStored(fixture, {
        lifecycle: { stage: "epic", pass: 1, work: null, paused: false },
        lastLifecycle: { stage: "epic", pass: 1, work: null, paused: false },
        lifecycleRunning: true,
        generationQueued: true,
        generationAttempted: true,
        laneSequence: 1,
        lanes: [
          laneEntry({
            id: "lane-1",
            kind: "generation",
            epic: null,
            activity: ["Choosing the next epics"],
          }),
        ],
      });

      const host = startHost(fixture, { agentArguments: "--delay-ms=20" });
      const client = await connect(`127.0.0.1:${host.port}`);
      try {
        expect(
          await client.waitFor(
            (message) => message.type === "lifecycleState" && message.stage === "finished",
          ),
        ).toMatchObject({ stage: "finished" });
        await Bun.sleep(300);
        expect(prompts(fixture.logPath)).toEqual(["/epic-next", "/epic-next"]);
        // The queued pass is a new lane above the restored sequence.
        const ids = new Set<string>();
        for (const event of client.events) {
          if (event.type !== "laneState") continue;
          for (const lane of event.lanes as { id: string }[]) ids.add(lane.id);
        }
        expect([...ids].sort()).toEqual(["lane-1", "lane-2"]);
      } finally {
        client.close();
        host.stop(true);
      }
    },
    30000,
  );

  test(
    "honors restored lane retention and drops an expired tab",
    async () => {
      const fixture = await createFixture({ git: true });
      writeStored(fixture, {
        lifecycle: { stage: "finished", pass: 4, work: null, paused: false },
        lastLifecycle: { stage: "finished", pass: 4, work: null, paused: false },
        lanes: [
          laneEntry({
            status: "closed",
            activity: ["Finished"],
            retainUntil: Date.now() + 1500,
          }),
        ],
      });
      const host = startHost(fixture);
      const client = await connect(`127.0.0.1:${host.port}`);
      try {
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 4,
          work: null,
          paused: false,
        });
        const snapshot = await client.waitFor((message) => message.type === "laneState");
        expect((snapshot.lanes as { id: string }[])[0]?.id).toBe("lane-1");
        const emptied = await client.waitFor(
          (message) => message.type === "laneState" && (message.lanes as unknown[]).length === 0,
        );
        expect(emptied.lanes).toEqual([]);
      } finally {
        client.close();
        host.stop(true);
      }

      const expiring = await createFixture({ git: true });
      writeStored(expiring, {
        lifecycle: { stage: "finished", pass: 2, work: null, paused: false },
        lastLifecycle: { stage: "finished", pass: 2, work: null, paused: false },
        lanes: [
          laneEntry({
            status: "closed",
            activity: ["Finished earlier"],
            retainUntil: Date.now() - 1000,
          }),
        ],
      });
      const third = startHost(expiring);
      const late = await connect(`127.0.0.1:${third.port}`);
      try {
        expect(await late.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "finished",
          pass: 2,
          work: null,
          paused: false,
        });
        const snapshot = await late.waitFor((message) => message.type === "laneState");
        expect(snapshot.lanes).toEqual([]);
      } finally {
        late.close();
        third.stop(true);
      }
    },
    30000,
  );
});

describe("ADR lane restore", () => {
  test(
    "re-spawns a restored ADR lane with the same record prompt",
    async () => {
      const fixture = await createFixture({ git: true, adrs: { "0001-first.md": PENDING_ONE } });
      const lifecycle = {
        stage: "adr",
        pass: 1,
        work: { kind: "adr", id: "0001-first.md" },
        paused: false,
      };
      writeStored(fixture, {
        lifecycle,
        lastLifecycle: lifecycle,
        lifecycleRunning: true,
        laneSequence: 1,
        lanes: [
          laneEntry({
            kind: "adr",
            epic: null,
            record: { file: "0001-first.md", title: "First decision" },
            activity: ["Working on /adr-resolve"],
          }),
        ],
      });

      const host = startHost(fixture, { agentArguments: "--delay-ms=3000 --questions=0" });
      const client = await connect(`127.0.0.1:${host.port}`);
      try {
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          ...lifecycle,
        });
        const snapshot = await client.waitFor((message) => message.type === "laneState");
        const lane = (snapshot.lanes as {
          kind: string;
          record: { file: string };
          status: string;
          activity: string[];
        }[])[0];
        expect(lane?.kind).toBe("adr");
        expect(lane?.record.file).toBe("0001-first.md");
        expect(lane?.status).toBe("running");
        expect(lane?.activity).toEqual(["Working on /adr-resolve"]);

        await waitUntil(
          () => prompts(fixture.logPath).length === 1,
          "the restored ADR lane did not re-spawn",
        );
        expect(prompts(fixture.logPath)).toEqual([
          agentPrompt(fixture.adrDir, "0001-first.md").split("\n")[0] ?? "",
        ]);
      } finally {
        client.close();
        host.stop(true);
      }
    },
    30000,
  );
});

describe("foreground restore", () => {
  test(
    "continues a restored manual ADR sequence from its own record",
    async () => {
      const fixture = await createFixture({
        skill: false,
        adrs: { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
      });
      const first = startHost(fixture, { agentArguments: "--delay-ms=3000 --questions=0" });
      const client = await connect(`127.0.0.1:${first.port}`);
      let recorded = "";
      try {
        client.send({ type: "startRun" });
        const started = await client.waitFor((message) => message.type === "runStarted");
        expect(started).toMatchObject({ file: "0001-first.md", manual: true });
        const activity = await client.waitFor(
          (message) => message.type === "activity" && typeof message.lane !== "string",
        );
        recorded = String(activity.text);
        expect(recorded).toBe("Inspecting 0001-first.md");
        expect(readStored(fixture).manualRun).toMatchObject({ file: "0001-first.md" });
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, { agentArguments: "--delay-ms=100 --questions=0" });
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        const started = await resumed.waitFor((message) => message.type === "runStarted");
        expect(started).toMatchObject({
          file: "0001-first.md",
          title: "First decision",
          action: "resolving",
          manual: true,
        });
        const replay = await resumed.waitFor((message) => message.type === "activity");
        expect(replay).toEqual({ type: "activity", text: recorded });
        const next = await resumed.waitFor(
          (message) => message.type === "runStarted" && message.file === "0002-second.md",
        );
        expect(next.manual).toBe(true);
        await waitUntil(
          () =>
            logLines(fixture.logPath).filter((line) => line.startsWith("resolved ")).length >= 2,
          "the restored sequence did not continue",
        );
        expect(
          prompts(fixture.logPath).filter((prompt) => prompt.startsWith("/adr-resolve")).length,
        ).toBe(3);
        expect(resumed.events.filter((message) => message.type === "error")).toEqual([]);
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    40000,
  );

  test(
    "restores goal creation with its original prompt and activity",
    async () => {
      const fixture = await createFixture({ goal: null, skill: false });
      const args = (delay: number) =>
        `--create-goal --goal=${fixture.goalFile} --delay-ms=${delay}`;
      const first = startHost(fixture, { agentArguments: args(3000) });
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "createGoal" });
        await client.waitFor((message) => message.type === "goalCreationStarted");
        const activity = await client.waitFor((message) => message.type === "activity");
        expect(activity.text).toBe("Creating the goal");
        expect(readStored(fixture).goalCreation).not.toBeNull();
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, { agentArguments: args(2000) });
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        const started = await resumed.waitFor((message) => message.type === "goalCreationStarted");
        expect(started).toBeDefined();
        expect(await resumed.waitFor((message) => message.type === "activity")).toEqual({
          type: "activity",
          text: "Creating the goal",
        });
        // The replacement peer asks its own question; the restored prefix is
        // kept and the new line appends.
        const question = await resumed.waitFor((message) => message.type === "question");
        resumed.send({ type: "answer", id: question.id, value: "Alpha" });
        const stopped = await resumed.waitFor(
          (message) => message.type === "goalCreationStopped",
          "the restored creation did not finish",
          20000,
        );
        expect(stopped).toMatchObject({ completed: true });
        expect(String(stopped.text)).toContain("# Created goal");
        expect(prompts(fixture.logPath).filter((prompt) => prompt === "/goal-outcome").length).toBe(
          2,
        );
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    30000,
  );

  test(
    "restores goal revision with the same guidance",
    async () => {
      const fixture = await createFixture({ skill: false });
      const args = (delay: number) =>
        `--revise-goal --goal=${fixture.goalFile} --delay-ms=${delay}`;
      const first = startHost(fixture, { agentArguments: args(3000) });
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "reviseGoal", request: "Tighten the outcome" });
        await client.waitFor((message) => message.type === "goalRevisionStarted");
        await client.waitFor((message) => message.type === "activity");
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, { agentArguments: args(2000) });
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        await resumed.waitFor((message) => message.type === "goalRevisionStarted");
        expect(await resumed.waitFor((message) => message.type === "activity")).toEqual({
          type: "activity",
          text: "Revising the goal",
        });
        const question = await resumed.waitFor((message) => message.type === "question");
        resumed.send({ type: "answer", id: question.id, value: "Alpha" });
        expect(
          await resumed.waitFor(
            (message) => message.type === "goalRevisionStopped",
            "the restored revision did not finish",
            20000,
          ),
        ).toMatchObject({ completed: true });
        const requests = logLines(fixture.logPath)
          .filter((line) => line.startsWith("request "))
          .map((line) => line.slice("request ".length));
        expect(requests.length).toBe(2);
        expect(requests[0]).toBe(requests[1]);
        const raw = readFileSync(fixture.logPath, "utf8");
        expect(raw.split("Guidance: Tighten the outcome").length - 1).toBe(2);
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    30000,
  );

  test(
    "restores skills preparation and rolls back to the pre-run bytes on failure",
    async () => {
      const fixture = await createFixture({ skill: false });
      await mkdir(join(fixture.root, ".omp", "skills", "behavior-first-testing"), {
        recursive: true,
      });
      await writeFile(
        join(fixture.root, ".omp", "skills", "behavior-first-testing", "SKILL.md"),
        MANAGED_SKILL,
      );
      const args = (delay: number) =>
        `--prepare-skills --prepare-skills-error --delay-ms=${delay}`;
      const first = startHost(fixture, { agentArguments: args(3000) });
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "prepareSkills" });
        await client.waitFor((message) => message.type === "skillsPreparationStarted");
        await client.waitFor(
          (message) =>
            message.type === "activity" &&
            message.text ===
              "Researching public standards, architecture patterns, and testing practice",
        );
        const state = readStored(fixture);
        const pending = state.skillsPreparation as { snapshot: { files: [string, string][] } };
        expect(pending.snapshot.files.length).toBe(1);
      } finally {
        client.close();
        first.stop(true);
      }

      const second = startHost(fixture, { agentArguments: args(2000) });
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        await resumed.waitFor((message) => message.type === "skillsPreparationStarted");
        expect(await resumed.waitFor((message) => message.type === "activity")).toEqual({
          type: "activity",
          text: "Researching public standards, architecture patterns, and testing practice",
        });
        expect(
          await resumed.waitFor((message) => message.type === "skillsPreparationStopped"),
        ).toMatchObject({ completed: false });
        expect(
          await readFile(
            join(fixture.root, ".omp", "skills", "behavior-first-testing", "SKILL.md"),
            "utf8",
          ),
        ).toBe(MANAGED_SKILL);
        expect(prompts(fixture.logPath).filter((prompt) => prompt === "/prepare-skills").length).toBe(
          2,
        );
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    30000,
  );

  test(
    "restores a pending skills preparation from its stored snapshot",
    async () => {
      const fixture = await createFixture({ skill: false });
      const houseStyle = [
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
      const files: [string, string][] = [
        ["house-style/SKILL.md", Buffer.from(houseStyle).toString("base64")],
        ["behavior-first-testing/SKILL.md", Buffer.from(MANAGED_SKILL).toString("base64")],
      ];
      writeStored(fixture, {
        skillsPreparationPending: {
          activity: [],
          question: null,
          snapshot: { exists: true, files },
          unmanagedNames: ["house-style"],
        },
      });
      // The killed process had already replaced the managed set.
      await mkdir(join(fixture.root, ".omp", "skills"), { recursive: true });

      const host = startHost(fixture, { agentArguments: "--prepare-skills --delay-ms=100" });
      const client = await connect(`127.0.0.1:${host.port}`);
      try {
        await client.waitFor((message) => message.type === "skillsPreparationStarted");
        const stopped = await client.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(stopped).toMatchObject({ completed: true });
        // The unmanaged skill was restored before the resumed run checked it.
        expect(await readFile(join(fixture.root, ".omp", "skills", "house-style", "SKILL.md"), "utf8")).toBe(
          houseStyle,
        );
        expect(prompts(fixture.logPath)).toEqual(["/prepare-skills"]);
      } finally {
        client.close();
        host.stop(true);
      }
    },
    30000,
  );
});

describe("reset and restart", () => {
  test(
    "never re-runs an interrupted reset and reports it as failed",
    async () => {
      const fixture = await createFixture({ git: true, adrs: { "0001-first.md": PENDING_ONE } });
      const head = git(fixture.root, ["rev-parse", "HEAD"]).stdout;
      writeStored(fixture, {
        lifecycle: { stage: "implementation", pass: 2, work: null, paused: false },
        lastLifecycle: { stage: "implementation", pass: 2, work: null, paused: false },
        lifecycleRunning: true,
        laneSequence: 1,
        lanes: [laneEntry({})],
        knownEpics: [laneEntry().epic],
        epicStates: [
          {
            id: "77",
            epic: laneEntry().epic,
            attempts: 1,
            status: "running",
            mainAtFailure: null,
          },
        ],
        resetActive: true,
      });

      const host = startHost(fixture, { agentArguments: "--delay-ms=100" });
      const client = await connect(`127.0.0.1:${host.port}`);
      try {
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toContain("implementation reset was interrupted");
        const stopped = await client.waitFor(
          (message) => message.type === "implementationResetStopped",
        );
        expect(stopped).toMatchObject({ completed: false });
        expect(client.events.filter((message) => message.type === "error").length).toBe(1);
        expect(client.events.filter((message) => message.type === "runStarted")).toEqual([]);
        expect(existsSync(fixture.logPath)).toBe(false);
        expect(git(fixture.root, ["rev-parse", "HEAD"]).stdout).toBe(head);
        expect(git(fixture.root, ["status", "--porcelain"]).stdout).toBe("");
        expect(existsSync(join(fixture.adrDir, "0001-first.md"))).toBe(true);
      } finally {
        client.close();
        host.stop(true);
      }
    },
    30000,
  );

  test(
    "restores neither the old lanes nor the old pass after a successful reset",
    async () => {
      const fixture = await createFixture({ git: true, adrs: { "0001-first.md": PENDING_ONE } });
      const remote = join(dirname(fixture.root), `${basename(fixture.root)}-origin.git`);
      Bun.spawnSync({ cmd: ["git", "init", "-q", "--bare", remote] });
      git(fixture.root, ["remote", "add", "origin", remote]);
      git(fixture.root, ["push", "-q", "origin", "main"]);

      writeStored(fixture, {
        lifecycle: { stage: "epic", pass: 3, work: null, paused: false },
        lastLifecycle: { stage: "finished", pass: 3, work: null, paused: false },
        laneSequence: 1,
        lanes: [laneEntry({ status: "closed", retainUntil: Date.now() + 60_000 })],
      });

      const host = startHost(fixture);
      const client = await connect(`127.0.0.1:${host.port}`);
      try {
        client.send({ type: "resetImplementation" });
        const stopped = await client.waitFor(
          (message) => message.type === "implementationResetStopped",
          "the reset did not finish",
          20000,
        );
        expect(stopped.completed).toBe(true);
        const state = readStored(fixture);
        expect(state.lifecycle).toEqual({ stage: "goal", pass: 1, work: null, paused: false });
        expect(state.lanes).toEqual([]);
      } finally {
        client.close();
        host.stop(true);
      }

      const second = startHost(fixture);
      const resumed = await connect(`127.0.0.1:${second.port}`);
      try {
        expect(await resumed.waitFor((message) => message.type === "lifecycleState")).toEqual({
          type: "lifecycleState",
          stage: "goal",
          pass: 1,
          work: null,
          paused: false,
        });
        const snapshot = await resumed.waitFor((message) => message.type === "laneState");
        expect(snapshot.lanes).toEqual([]);
      } finally {
        resumed.close();
        second.stop(true);
      }
    },
    40000,
  );

  test(
    "honors a restored when-idle restart exactly once",
    async () => {
      const fixture = await createFixture({
        skill: false,
        adrs: { "0001-first.md": PENDING_ONE, "0002-second.md": PENDING_TWO },
      });
      const first = startHost(fixture, {
        agentArguments: "--delay-ms=200 --questions=0",
        restart: () => {},
      });
      const client = await connect(`127.0.0.1:${first.port}`);
      try {
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        client.send({ type: "restartServer", whenIdle: true });
        await client.waitFor((message) => message.type === "upgradePending");
        expect(readStored(fixture).restartWhenIdle).toBe(true);
      } finally {
        client.close();
        first.stop(true);
      }

      let calls = 0;
      let flagAtRestart: unknown = "unset";
      const second = startHost(fixture, {
        agentArguments: "--delay-ms=100 --questions=0",
        restart: () => {
          calls += 1;
          const raw = readFileSync(storedPath(fixture), "utf8");
          flagAtRestart = (JSON.parse(raw) as { state: { restartWhenIdle: boolean } }).state
            .restartWhenIdle;
        },
      });
      try {
        await waitUntil(() => calls === 1, "the restored when-idle restart was not honored", 20000);
        expect(calls).toBe(1);
        expect(flagAtRestart).toBe(false);
        expect(readStored(fixture).restartWhenIdle).toBe(false);
      } finally {
        second.stop(true);
      }

      let laterCalls = 0;
      const third = startHost(fixture, {
        agentArguments: "--delay-ms=100 --questions=0",
        restart: () => {
          laterCalls += 1;
        },
      });
      const idle = await connect(`127.0.0.1:${third.port}`);
      try {
        await Bun.sleep(800);
        expect(laterCalls).toBe(0);
        expect(idle.events.filter((message) => message.type === "serverRestarting")).toEqual([]);
      } finally {
        idle.close();
        third.stop(true);
      }
    },
    40000,
  );

  test(
    "reports the unavailable restart for a restored pending flag and clears it",
    async () => {
      const fixture = await createFixture({ skill: false });
      writeStored(fixture, { restartWhenIdle: true });
      const host = startHost(fixture);
      const client = await connect(`127.0.0.1:${host.port}`);
      try {
        expect(await client.waitFor((message) => message.type === "error")).toEqual({
          type: "error",
          message: "Restarting the server is not available.",
        });
        await waitUntil(
          () => readStored(fixture).restartWhenIdle === false,
          "the pending restart flag was not cleared",
        );
      } finally {
        client.close();
        host.stop(true);
      }
    },
    20000,
  );
});

describe("state write failures", () => {
  test(
    "keeps serving from memory with one journal error when the state directory is read-only",
    async () => {
      const fixture = await createFixture({ git: true });
      await mkdir(join(fixture.stateDir, "state"), { recursive: true });
      await Bun.write(join(fixture.stateDir, "state", ".keep"), "");
      await chmod(join(fixture.stateDir, "state"), 0o500);

      const epic: OpenEpic = {
        number: 91,
        title: "Read only",
        url: "https://fixture.test/issues/91",
      };
      const host = startHost(fixture, {
        agentArguments: "--delay-ms=5000 --no-close",
        tracker: async () => epic,
      });
      const client = await connect(`127.0.0.1:${host.port}`);
      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "implementation",
        );
        client.send({ type: "stopLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "goal",
        );
        client.send({ type: "getProject" });
        expect(await client.waitFor((message) => message.type === "project")).toBeDefined();

        const journalDir = join(fixture.stateDir, "journal");
        const records = readdirSync(journalDir)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => readFileSync(join(journalDir, name), "utf8"))
          .join("");
        const failures = records
          .split("\n")
          .filter((line) => line.includes("state: could not write"));
        expect(failures.length).toBe(1);
        expect(client.events.filter((message) => message.type === "error")).toEqual([]);
      } finally {
        client.close();
        host.stop(true);
        await chmod(join(fixture.stateDir, "state"), 0o700);
      }
    },
    30000,
  );
});
