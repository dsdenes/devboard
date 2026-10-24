import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import type { OpenEpic } from "./tracker";

const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
/** Every temporary host lives inside the worktree, never the system temp directory. */
const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "parallel-lifecycle");
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

interface Host {
  root: string;
  adrDir: string;
  staticDir: string;
  goalFile: string;
  trackerFile: string;
  logPath: string;
  remote: string;
}

interface LaneView {
  id: string;
  kind: string;
  epic: { number: number; title: string; url: string } | null;
  record: { file: string; title: string } | null;
  attempt: number;
  status: string;
  activity: string[];
  question: { id: number | string; message: string } | null;
}

interface LaneStateView {
  lanes: LaneView[];
  openEpics: number;
  runningLanes: number;
}

interface TestClient {
  events: Record<string, unknown>[];
  send(command: unknown): void;
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): void;
}

const temporaryDirectories: string[] = [];

function epic(number: number, title = `Fixture epic ${number}`): OpenEpic {
  return { number, title, url: `https://fixture.test/issues/${number}` };
}

async function git(directory: string, args: string[]): Promise<string> {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      directory,
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "user.name=Fixture",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

async function makeHost(open: OpenEpic[] = []): Promise<Host> {
  await mkdir(TEST_ROOT, { recursive: true });
  const root = await mkdtemp(join(TEST_ROOT, "host-"));
  temporaryDirectories.push(root);
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "static");
  const goalFile = join(root, "GOAL.md");
  const trackerFile = join(root, "tracker.json");
  const logPath = join(root, "agent.log");
  // The bare origin sits beside the host so a reset inside the host cannot
  // delete the remote it pushes to.
  const remote = `${root}-remote.git`;
  temporaryDirectories.push(remote);

  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>parallel</title>");
  await writeFile(goalFile, "# Goal\n\nShip the parallel pipeline.\n");
  await writeFile(trackerFile, `${JSON.stringify(open, null, 2)}\n`);
  await mkdir(join(root, ".omp", "skills", "behavior-first-testing"), { recursive: true });
  await writeFile(join(root, ".omp", "skills", "behavior-first-testing", "SKILL.md"), MANAGED_SKILL);

  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.test"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(join(root, "README.md"), "fixture host\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "fixture base"]);
  await git(root, ["init", "--bare", remote]);
  await git(root, ["remote", "add", "origin", remote]);
  await git(root, ["push", "-u", "origin", "main"]);

  return { root, adrDir, staticDir, goalFile, trackerFile, logPath, remote };
}

function readTracker(file: string): OpenEpic[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as OpenEpic[]) : [];
  } catch {
    return [];
  }
}

async function startServer(
  host: Host,
  options: {
    agentArguments?: string;
    laneBackoffMs?: number;
    laneRetentionMs?: number;
    mainPollMs?: number;
  } = {},
): Promise<{ server: Server<unknown>; url: string }> {
  const command = [
    `bun ${STUB_AGENT}`,
    `--log=${host.logPath}`,
    `--fixture-tracker=${host.trackerFile}`,
    "--delay-ms=0",
    options.agentArguments ?? "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  const server = createApp({
    adrDir: host.adrDir,
    staticDir: host.staticDir,
    hostname: "127.0.0.1",
    port: 0,
    repoDir: host.root,
    stateDir: join(host.root, "state"),
    goalFile: host.goalFile,
    agentCommand: command,
    tracker: async () => readTracker(host.trackerFile),
    trackerSettle: { attempts: 1 },
    laneBackoffMs: options.laneBackoffMs,
    laneRetentionMs: options.laneRetentionMs,
    mainPollMs: options.mainPollMs,
  });
  return { server, url: `127.0.0.1:${server.port}` };
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
    const client: TestClient = {
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
    };
    resolve(client);
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

function isLaneView(value: unknown): value is LaneView {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "attempt" in value &&
    typeof value.attempt === "number" &&
    "status" in value &&
    typeof value.status === "string" &&
    "activity" in value &&
    Array.isArray(value.activity) &&
    value.activity.every((line) => typeof line === "string") &&
    "question" in value
  );
}

function laneState(message: Record<string, unknown>): LaneStateView | undefined {
  if (message.type !== "laneState") return undefined;
  if (!Array.isArray(message.lanes) || !message.lanes.every(isLaneView)) return undefined;
  if (typeof message.openEpics !== "number" || typeof message.runningLanes !== "number") {
    return undefined;
  }
  return {
    lanes: message.lanes,
    openEpics: message.openEpics,
    runningLanes: message.runningLanes,
  };
}

async function waitForLanes(
  client: TestClient,
  predicate: (state: LaneStateView) => boolean,
  timeoutMs = 10_000,
): Promise<LaneStateView> {
  const existing = [...client.events]
    .reverse()
    .map((message) => laneState(message))
    .find((state) => state !== undefined && predicate(state));
  if (existing !== undefined) return existing;

  const { promise, resolve, reject } = Promise.withResolvers<LaneStateView>();
  const timer = setTimeout(() => reject(new Error("timed out waiting for lane state")), timeoutMs);
  void client.waitFor((message) => {
    const state = laneState(message);
    if (state === undefined || !predicate(state)) return false;
    clearTimeout(timer);
    resolve(state);
    return true;
  });
  return promise;
}

function prompts(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("prompt "))
    .map((line) => line.slice("prompt ".length));
}

function spawnCount(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("spawn ")).length;
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error(message);
}

function implementationEpics(state: LaneStateView): number[] {
  return state.lanes
    .filter((lane) => lane.kind === "implementation" && lane.epic !== null)
    .map((lane) => lane.epic?.number ?? 0);
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parallel lifecycle", () => {
  test(
    "stops every running lane at once and returns to the idle stage",
    async () => {
      const host = await makeHost([epic(1), epic(2), epic(3)]);
      const { server, url } = await startServer(host, {
        agentArguments: "--lane-delay-ms=5000",
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await waitForLanes(
          client,
          (state) =>
            state.lanes.filter(
              (lane) => lane.kind === "implementation" && lane.status === "running",
            ).length === 3,
        );

        client.send({ type: "stopLifecycle" });
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

        const stopped = await waitForLanes(
          client,
          (state) =>
            state.runningLanes === 0 &&
            state.lanes
              .filter((lane) => lane.kind === "implementation")
              .every((lane) => lane.status === "failed"),
        );
        expect(stopped.lanes.filter((lane) => lane.kind === "implementation")).toHaveLength(3);
        expect(stopped.openEpics).toBe(3);

        client.send({ type: "stopLifecycle" });
        expect(await client.waitFor((message) => message.type === "error")).toEqual({
          type: "error",
          message: "No lifecycle run is active.",
        });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "runs one overlapping implementation lane per open epic with no lane cap",
    async () => {
      const ids = [1, 2, 3, 4, 5];
      const host = await makeHost(ids.map((id) => epic(id)));
      const delays = ids.map((id) => `--lane-delay=${id}:900`).join(" ");
      const { server, url } = await startServer(host, { agentArguments: delays });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const running = await waitForLanes(
          client,
          (state) =>
            state.lanes.filter(
              (lane) => lane.kind === "implementation" && lane.status === "running",
            ).length === 5,
        );
        expect(running.openEpics).toBe(5);
        expect(running.runningLanes).toBe(5);
        expect(implementationEpics(running).sort((left, right) => left - right)).toEqual(ids);

        await waitUntil(
          () => prompts(host.logPath).filter((line) => line.startsWith("/implement-next-epic")).length === 5,
          "not every epic received an implementation peer",
        );
        const assigned = prompts(host.logPath)
          .filter((line) => line.startsWith("/implement-next-epic"))
          .map((line) => Number(line.split(" ")[1]));
        expect(assigned.sort((left, right) => left - right)).toEqual(ids);
        expect(new Set(running.lanes.map((lane) => lane.id)).size).toBe(5);

        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        const finished = [...client.events]
          .reverse()
          .map((message) => laneState(message))
          .find((state) => state !== undefined);
        expect(finished?.lanes.filter((lane) => lane.kind === "implementation")).toHaveLength(5);
        expect(finished?.lanes.every((lane) => lane.status === "closed")).toBe(true);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "generation files several epics and each one starts its own lane immediately",
    async () => {
      const host = await makeHost([]);
      const { server, url } = await startServer(host, {
        agentArguments:
          "--generate-epic=11:Alpha --generate-epic=12:Beta --generate-epic=13:Gamma " +
          "--lane-delay=11:900 --lane-delay=12:900 --lane-delay=13:900",
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const running = await waitForLanes(
          client,
          (state) =>
            state.openEpics === 3 &&
            state.lanes.filter(
              (lane) => lane.kind === "implementation" && lane.status === "running",
            ).length === 3,
        );
        expect(running.runningLanes).toBe(3);
        expect(implementationEpics(running).sort((left, right) => left - right)).toEqual([
          11, 12, 13,
        ]);
        expect(
          running.lanes.filter((lane) => lane.kind === "generation").length,
        ).toBe(1);
        expect(
          prompts(host.logPath).filter((line) => line === "/epic-next"),
        ).toHaveLength(1);

        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "refills a new lane on close while other lanes keep implementing",
    async () => {
      const host = await makeHost([epic(21, "Long lane"), epic(22, "Short lane"), epic(23, "Shorter lane")]);
      const { server, url } = await startServer(host, {
        agentArguments:
          "--generate-epic=24:Filed by generation --generation-budget=1 " +
          "--lane-delay=21:2500 --lane-delay=22:200 --lane-delay=23:350 --lane-delay=24:2500",
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const refilled = await waitForLanes(client, (state) => {
          const running = state.lanes.filter(
            (lane) => lane.kind === "implementation" && lane.status === "running",
          );
          return (
            running.some((lane) => lane.epic?.number === 21) &&
            running.some((lane) => lane.epic?.number === 24)
          );
        });
        expect(refilled.lanes.some((lane) => lane.kind === "generation")).toBe(true);
        const longLane = refilled.lanes.find(
          (lane) => lane.kind === "implementation" && lane.epic?.number === 21,
        );
        expect(longLane?.status).toBe("running");
        await waitForLanes(
          client,
          (state) =>
            state.openEpics === 2 &&
            state.lanes.some(
              (lane) =>
                lane.kind === "implementation" &&
                lane.epic?.number === 21 &&
                lane.status === "running",
            ),
        );

        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(
          prompts(host.logPath).filter((line) => line === "/implement-next-epic 24"),
        ).toHaveLength(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "coalesces refill triggers that arrive during an active generation run",
    async () => {
      const host = await makeHost([epic(31, "Long"), epic(32, "Early"), epic(33, "Later")]);
      const { server, url } = await startServer(host, {
        agentArguments:
          "--delay-ms=400 --lane-delay=31:2600 --lane-delay=32:150 --lane-delay=33:250",
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await waitUntil(
          () => prompts(host.logPath).filter((line) => line === "/epic-next").length === 2,
          "the two coalesced generation runs did not start",
          5000,
        );
        const running = [...client.events]
          .reverse()
          .map((message) => laneState(message))
          .find(
            (state) =>
              state !== undefined &&
              state.lanes.some(
                (lane) =>
                  lane.kind === "implementation" &&
                  lane.epic?.number === 31 &&
                  lane.status === "running",
              ),
          );
        expect(running).toBeDefined();
        expect(
          prompts(host.logPath).filter((line) => line === "/epic-next").length,
        ).toBe(2);
        expect(spawnCount(host.logPath)).toBe(5);

        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(
          prompts(host.logPath).filter((line) => line === "/epic-next").length,
        ).toBe(3);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "retries an epic that stays open after the backoff without a concurrent duplicate",
    async () => {
      const host = await makeHost([epic(41, "Keeps failing")]);
      const { server, url } = await startServer(host, {
        agentArguments: "--no-close --lane-delay=41:40",
        laneBackoffMs: 500,
        mainPollMs: 60_000,
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const retried = await waitForLanes(client, (state) => {
          const lanes = state.lanes.filter(
            (lane) => lane.kind === "implementation" && lane.epic?.number === 41,
          );
          return (
            lanes.length === 2 &&
            lanes.some((lane) => lane.attempt === 1 && lane.status === "retrying") &&
            lanes.some((lane) => lane.attempt === 2 && lane.status === "running")
          );
        });
        expect(retried.runningLanes).toBe(1);
        expect(
          retried.lanes.filter(
            (lane) => lane.kind === "implementation" && lane.status === "running",
          ),
        ).toHaveLength(1);
        await waitUntil(
          () =>
            prompts(host.logPath).filter((line) => line === "/implement-next-epic 41").length === 2,
          "the retried lane did not spawn",
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "retries a retrying epic immediately when main advances",
    async () => {
      const host = await makeHost([epic(51, "Waits for main")]);
      const { server, url } = await startServer(host, {
        agentArguments: "--no-close --lane-delay=51:40",
        laneBackoffMs: 60_000,
        mainPollMs: 25,
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await waitForLanes(client, (state) =>
          state.lanes.some(
            (lane) =>
              lane.kind === "implementation" &&
              lane.epic?.number === 51 &&
              lane.status === "retrying",
          ),
        );
        await git(host.root, ["commit", "--allow-empty", "-m", "advance main"]);

        await waitForLanes(client, (state) =>
          state.lanes.some(
            (lane) =>
              lane.kind === "implementation" &&
              lane.epic?.number === 51 &&
              lane.attempt === 2,
          ),
        );
        await waitUntil(
          () =>
            prompts(host.logPath).filter((line) => line === "/implement-next-epic 51").length === 2,
          "the retried lane did not spawn",
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "parks a blocked lane without delaying others, retries it on main, then stops with an error",
    async () => {
      const host = await makeHost([epic(61, "Blocked"), epic(62, "Healthy")]);
      const { server, url } = await startServer(host, {
        agentArguments:
          "--blocker-epic=61 --lane-delay=61:40 --lane-delay=62:1500",
        mainPollMs: 25,
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const isolated = await waitForLanes(client, (state) => {
          const blocked = state.lanes.find(
            (lane) => lane.kind === "implementation" && lane.epic?.number === 61,
          );
          const healthy = state.lanes.find(
            (lane) => lane.kind === "implementation" && lane.epic?.number === 62,
          );
          return blocked?.status === "parked" && healthy?.status === "running";
        });
        expect(isolated.lanes.every((lane) => lane.epic?.number !== 61 || lane.status !== "running")).toBe(true);
        expect(
          client.events.filter(
            (message) => message.type === "error" && String(message.message).includes("parked"),
          ),
        ).toEqual([]);

        await git(host.root, ["commit", "--allow-empty", "-m", "advance for parked lane"]);
        await waitForLanes(client, (state) =>
          state.lanes.some(
            (lane) =>
              lane.kind === "implementation" &&
              lane.epic?.number === 61 &&
              lane.attempt === 2,
          ),
        );

        const error = await client.waitFor(
          (message) =>
            message.type === "error" &&
            message.message === "Lifecycle stopped with parked epics: #61.",
        );
        expect(error.message).toBe("Lifecycle stopped with parked epics: #61.");
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "goal",
        );
        expect(readTracker(host.trackerFile).map((entry) => entry.number)).toEqual([61]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "replays counts, tabs, activity, and pending questions to a reconnecting client",
    async () => {
      const host = await makeHost([epic(71, "Asking"), epic(72, "Quiet")]);
      const { server, url } = await startServer(host, {
        agentArguments:
          "--question-epic=71 --lane-delay=71:1200 --lane-delay=72:1800",
        mainPollMs: 60_000,
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        const questionEvent = await client.waitFor(
          (message) => message.type === "question" && typeof message.lane === "string",
        );
        const late = await connect(url);
        try {
          const state = await waitForLanes(late, (candidate) => candidate.runningLanes === 2);
          expect(state.openEpics).toBe(2);
          expect(implementationEpics(state).sort((left, right) => left - right)).toEqual([
            71, 72,
          ]);
          const asking = state.lanes.find((lane) => lane.epic?.number === 71);
          const quiet = state.lanes.find((lane) => lane.epic?.number === 72);
          expect(asking?.activity).toEqual(["Working on epic 71"]);
          expect(quiet?.activity).toEqual(["Working on epic 72"]);
          expect(asking?.question).toMatchObject({ id: questionEvent.id });
          expect(quiet?.question).toBeNull();
          expect(
            late.events.filter(
              (message) => message.type === "activity" && typeof message.lane !== "string",
            ),
          ).toEqual([]);
          expect(asking?.id).toBe(String(questionEvent.lane));

          client.send({
            type: "answer",
            lane: asking?.id,
            id: asking?.question?.id,
            value: "Beta",
          });
          await waitUntil(
            () =>
              readFileSync(host.logPath, "utf8")
                .split("\n")
                .includes("answer Beta"),
            "the answer did not reach its lane",
          );
          const after = await waitForLanes(late, (candidate) => {
            const lane = candidate.lanes.find((entry) => entry.id === asking?.id);
            return lane?.question === null;
          });
          const stillQuiet = after.lanes.find((lane) => lane.epic?.number === 72);
          expect(stillQuiet?.activity).toEqual(["Working on epic 72"]);
          expect(stillQuiet?.question).toBeNull();
        } finally {
          late.close();
        }
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "pauses every lane and resumes all of them",
    async () => {
      const host = await makeHost([epic(81, "Pause one"), epic(82, "Pause two")]);
      const { server, url } = await startServer(host, {
        agentArguments: "--lane-delay=81:1500 --lane-delay=82:1500",
        mainPollMs: 60_000,
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await waitForLanes(client, (state) => state.runningLanes === 2);

        client.send({ type: "pauseLifecycle" });
        const paused = await waitForLanes(
          client,
          (state) =>
            state.runningLanes === 0 &&
            state.lanes.filter(
              (lane) => lane.kind === "implementation" && lane.status === "paused",
            ).length === 2,
        );
        expect(paused.lanes.filter((lane) => lane.kind === "implementation")).toHaveLength(2);
        const spawnsAtPause = spawnCount(host.logPath);
        await Bun.sleep(400);
        expect(spawnCount(host.logPath)).toBe(spawnsAtPause);

        client.send({ type: "resumeLifecycle" });
        await waitForLanes(
          client,
          (state) =>
            state.runningLanes === 2 &&
            state.lanes
              .filter((lane) => lane.kind === "implementation")
              .every((lane) => lane.status === "running"),
        );
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "reset stops every lane before the existing reset contract runs",
    async () => {
      const host = await makeHost([epic(91, "Reset one"), epic(92, "Reset two")]);
      const { server, url } = await startServer(host, {
        agentArguments: "--lane-delay=91:3000 --lane-delay=92:3000",
        mainPollMs: 60_000,
      });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await waitForLanes(client, (state) => state.runningLanes === 2);

        client.send({ type: "resetImplementation" });
        const emptied = await waitForLanes(client, (state) => state.lanes.length === 0);
        expect(emptied.runningLanes).toBe(0);
        const stopped = await client.waitFor(
          (message) => message.type === "implementationResetStopped",
        );
        expect(stopped).toMatchObject({ completed: true });
        expect(readdirSync(host.root).filter((name) => name === "adrs")).toEqual([]);
        // The reset's own outcome is durable: pass 1, idle goal, no lanes.
        // The server recreates its state directory to record exactly that.
        const files = readdirSync(join(host.root, "state", "state"));
        expect(files.length).toBe(1);
        const stored = JSON.parse(
          readFileSync(join(host.root, "state", "state", String(files[0])), "utf8"),
        ) as { state: { lifecycle: unknown; lanes: unknown[] } };
        expect(stored.state.lifecycle).toEqual({
          stage: "goal",
          pass: 1,
          work: null,
          paused: false,
        });
        expect(stored.state.lanes).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "finishes when no epic, ADR, or parked lane remains",
    async () => {
      const host = await makeHost([]);
      const { server, url } = await startServer(host);
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        expect(prompts(host.logPath)).toEqual(["/epic-next"]);
        const state = [...client.events]
          .reverse()
          .map((message) => laneState(message))
          .find((candidate) => candidate !== undefined);
        expect(state?.openEpics).toBe(0);
        expect(state?.runningLanes).toBe(0);
        expect(state?.lanes.map((lane) => lane.status)).toEqual(["closed"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "drops a closed lane from the active list after its retention window",
    async () => {
      const host = await makeHost([]);
      const { server, url } = await startServer(host, { laneRetentionMs: 100 });
      const client = await connect(url);

      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "finished",
        );
        const closed = [...client.events]
          .reverse()
          .map((message) => laneState(message))
          .find((state) => state?.lanes.some((lane) => lane.status === "closed"));
        const laneId = closed?.lanes.find((lane) => lane.status === "closed")?.id;
        expect(laneId).toBeDefined();

        await waitUntil(
          () => {
            const states = client.events
              .map((message) => laneState(message))
              .filter((state) => state !== undefined);
            const latest = states[states.length - 1];
            return latest !== undefined && !latest.lanes.some((lane) => lane.id === laneId);
          },
          "the closed lane was not removed after its retention window",
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );
});

describe("tracker reads every open epic", () => {
  async function trackerHost(
    remote: string,
    cli: "gh" | "glab",
    rows: unknown[],
  ): Promise<{ root: string; bin: string }> {
    await mkdir(TEST_ROOT, { recursive: true });
    const root = await mkdtemp(join(TEST_ROOT, "tracker-"));
    temporaryDirectories.push(root);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["remote", "add", "origin", remote]);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const output = JSON.stringify(rows);
    const script =
      cli === "gh"
        ? `#!/bin/sh
case "$*" in
  "auth status --hostname github.com --json hosts") echo '{"hosts":{"github.com":[{"login":"reviewer","active":true,"state":"success"}]}}' ;;
  "auth token --hostname github.com --user reviewer") echo "gho_test" ;;
  "api --hostname github.com repos/owner/repo --jq .permissions") echo '{"admin":false,"maintain":false,"push":true,"triage":true,"pull":true}' ;;
  "label list --search epic --limit 100 --json name") echo '[{"name":"epic"}]' ;;
  "issue list --label epic --state open --json number,title,url --limit 100") echo '${output}' ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`
        : `#!/bin/sh
case "$*" in
  "auth status --hostname gitlab.com --show-token") echo "  ✓ Token: glpat-test" ;;
  "api --hostname gitlab.com user") echo '{"username":"reviewer"}' ;;
  "api --hostname gitlab.com projects/group%2Fproject") echo '{"visibility":"private","permissions":{"project_access":{"access_level":40}}}' ;;
  "label list --output json") echo '[{"name":"epic"}]' ;;
  "issue list --label epic --output json") echo '${output}' ;;
  *) echo "unexpected glab $*" >&2; exit 1 ;;
esac
`;
    await writeFile(join(bin, cli), script);
    await chmod(join(bin, cli), 0o755);
    return { root, bin };
  }

  async function readThroughCli(root: string, bin: string): Promise<OpenEpic[]> {
    const script = join(root, "read-epics.ts");
    const trackerModule = join(import.meta.dir, "tracker.ts");
    await writeFile(
      script,
      `import { findOpenEpics } from ${JSON.stringify(trackerModule)};\n` +
        `process.stdout.write(JSON.stringify(await findOpenEpics(process.argv[2])));\n`,
    );
    const result = Bun.spawnSync({
      cmd: [process.execPath, script, root],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`tracker read failed: ${result.stderr.toString()}`);
    }
    return JSON.parse(result.stdout.toString()) as OpenEpic[];
  }

  test("reads five open GitHub epics with the existing query shape", async () => {
    const rows = [1, 2, 3, 4, 5].map((number) => ({
      number,
      title: `GitHub epic ${number}`,
      url: `https://github.com/owner/repo/issues/${number}`,
    }));
    const { root, bin } = await trackerHost(
      "https://github.com/owner/repo.git",
      "gh",
      rows,
    );

    const epics: OpenEpic[] = await readThroughCli(root, bin);
    expect(epics).toHaveLength(5);
    expect(epics.map((entry) => entry.number)).toEqual([1, 2, 3, 4, 5]);
    expect(epics[4]?.url).toBe("https://github.com/owner/repo/issues/5");
  });

  test("reads five open GitLab epics with the existing query shape", async () => {
    const rows = [11, 12, 13, 14, 15].map((number) => ({
      iid: number,
      title: `GitLab epic ${number}`,
      web_url: `https://gitlab.com/group/project/-/issues/${number}`,
    }));
    const { root, bin } = await trackerHost(
      "https://gitlab.com/group/project.git",
      "glab",
      rows,
    );

    const epics: OpenEpic[] = await readThroughCli(root, bin);
    expect(epics).toHaveLength(5);
    expect(epics.map((entry) => entry.number)).toEqual([11, 12, 13, 14, 15]);
  });
});
