import { pendingRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stateFile } from "./state";
import { seedVerificationProvider, verificationProviderUsageEnv } from "../scripts/provider-fixture";

/**
 * A real server process over a fixture repository holds its state across a
 * SIGKILL: the replacement ends the killed peers, re-spawns the same work, and
 * replays what the first process broadcast. The stub agent stands in for
 * `omp acp`, and a stub `gh` supplies the tracker so a lifecycle runs without a
 * network.
 */

const temporaryDirectories: string[] = [];
/**
 * Fixture repositories live in harness scratch, never in the OS temp directory:
 * a server that outlives its fixture still roots its journal under
 * `.devboard/.tmp`, which the watchdog excludes as verification evidence.
 */
const testRoot = join(resolve(import.meta.dir, ".."), ".tmp");
const SERVER = join(import.meta.dir, "index.ts");
const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
/** The credential the spawned dashboard requires, and the test presents. */
const DASHBOARD_TOKEN = "persistence-test-token";
const PENDING_ONE = pendingRecord("0001-first.md", "First decision", "First.", "Choose the first.");
/** The offline release the fixture serves; the stub `gh` never answers a release query. */
const FIXTURE_RELEASE_VERSION = "0.0.0";
const FIXTURE_RELEASE_TARBALL = `devboard-${FIXTURE_RELEASE_VERSION}.tgz`;
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
const FAKE_GH = `#!/usr/bin/env bun
import { readFileSync } from "node:fs";

function out(value: unknown) {
  process.stdout.write(\`\${JSON.stringify(value)}\\n\`);
}

const args = process.argv.slice(2);
const tracker = process.env.FAKE_TRACKER ?? "";

if (args[0] === "label") {
  out([{ name: "epic" }]);
  process.exit(0);
}
if (args[0] === "issue") {
  try {
    out(JSON.parse(readFileSync(tracker, "utf8")));
  } catch {
    out([]);
  }
  process.exit(0);
}
if (args[0] === "auth") {
  if (args[1] === "status") {
    out({ hosts: { "github.com": [{ login: "tester", active: true, state: "success" }] } });
  } else {
    process.stdout.write("fake-token\\n");
  }
  process.exit(0);
}
if (args[0] === "api") {
  if (args.includes("user")) {
    process.stdout.write("tester\\n");
  } else {
    out({ admin: true, maintain: true, push: true, triage: true, pull: true });
  }
  process.exit(0);
}
out({});
`;

async function temporaryDirectory(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "devboard-restart-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function git(directory: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", directory, ...args],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((result.exitCode ?? -1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

interface Fixture {
  root: string;
  adrDir: string;
  staticDir: string;
  goalFile: string;
  stateDir: string;
  logPath: string;
  trackerFile: string;
  binDir: string;
  releaseDir: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await temporaryDirectory();
  const adrDir = join(root, "adrs");
  const staticDir = join(root, "dist");
  const goalFile = join(root, "GOAL.md");
  const stateDir = join(root, "state");
  const logPath = join(root, "agent.log");
  const trackerFile = join(root, "tracker.json");
  const binDir = join(root, "bin");
  const releaseDir = join(root, "releases");
  await mkdir(adrDir, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(releaseDir, { recursive: true });
  const tarball = Buffer.from("fixture release\n");
  await writeFile(join(releaseDir, FIXTURE_RELEASE_TARBALL), tarball);
  await writeFile(
    join(releaseDir, `${FIXTURE_RELEASE_TARBALL}.sha256`),
    `${createHash("sha256").update(tarball).digest("hex")}  ${FIXTURE_RELEASE_TARBALL}\n`,
  );
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>ADR overview</title>");
  await writeFile(goalFile, "# Goal\n\nShip the lifecycle.\n");
  await writeFile(join(adrDir, "0001-first.md"), PENDING_ONE);
  await mkdir(join(root, ".omp", "skills", "behavior-first-testing"), { recursive: true });
  await writeFile(
    join(root, ".omp", "skills", "behavior-first-testing", "SKILL.md"),
    MANAGED_SKILL,
  );
  await writeFile(trackerFile, JSON.stringify([]));
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, FAKE_GH);
  await chmod(ghPath, 0o755);
  await writeFile(join(root, ".gitignore"), "state/\n.tmp/\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Devboard Test"]);
  git(root, ["config", "user.email", "devboard@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  return { root, adrDir, staticDir, goalFile, stateDir, logPath, trackerFile, binDir, releaseDir };
}

interface RunningServer {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  port: number;
  url: string;
  stderr(): string;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port ?? 0;
}

async function startProcess(
  fixture: Fixture,
  port?: number,
  agentArgs: string[] = [],
): Promise<RunningServer> {
  const chosen = port ?? (await freePort());
  seedVerificationProvider(fixture.stateDir);
  const child = Bun.spawn({
    cmd: [process.execPath, SERVER],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(chosen),
      ADRS_DIR: fixture.adrDir,
      REPO_DIR: fixture.root,
      GOAL_FILE: fixture.goalFile,
      STATIC_DIR: fixture.staticDir,
      STATE_DIR: fixture.stateDir,
      DEVBOARD_DASHBOARD_TOKEN: DASHBOARD_TOKEN,
      ...verificationProviderUsageEnv(),
      AGENT_COMMAND: [
        `bun ${STUB_AGENT}`,
        `--log=${fixture.logPath}`,
        `--fixture-tracker=${fixture.trackerFile}`,
        "--delay-ms=3000",
        "--no-close",
        "--question-epic=81",
        "--question-epic=82",
        ...agentArgs,
      ].join(" "),
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      GH_TOKEN: "fake-token",
      FAKE_TRACKER: fixture.trackerFile,
      // The update check reads the offline fixture instead of the stub `gh`.
      DEVBOARD_RELEASE_DIR: fixture.releaseDir,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stderr = "";
  void (async () => {
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }
  })();

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${chosen}/ready`, {
        method: "HEAD",
        headers: { authorization: `Bearer ${DASHBOARD_TOKEN}` },
      });
      if (response.ok || response.status === 404) break;
    } catch {
      // Still binding or still starting.
    }
    if (Date.now() > deadline) throw new Error(`the server did not start: ${stderr}`);
    await Bun.sleep(50);
  }

  return {
    child,
    port: chosen,
    url: `127.0.0.1:${chosen}`,
    stderr: () => stderr,
  };
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
  timeout = 20000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  if (!(await predicate())) throw new Error(message);
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

async function connect(url: string): Promise<TestClient> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { promise, resolve: settle, reject } = Promise.withResolvers<TestClient>();
    const socket = new WebSocket(`ws://${url}/ws`, {
      headers: { authorization: `Bearer ${DASHBOARD_TOKEN}` },
    } as unknown as string[]);
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
          timeout = 20000,
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

    try {
      return await promise;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(50);
    }
  }
}

function storedPath(fixture: Fixture): string {
  return stateFile(fixture.stateDir, resolve(fixture.root));
}

/** The durable state fields, or an empty record before the first write. */
function storedState(fixture: Fixture): Record<string, unknown> {
  try {
    const envelope = JSON.parse(readFileSync(storedPath(fixture), "utf8")) as {
      state?: Record<string, unknown>;
    };
    return envelope.state ?? {};
  } catch {
    return {};
  }
}

/** The newest release version a fresh connection hears, or null before a check succeeds. */
async function reportedLatest(url: string): Promise<string | null> {
  const client = await connect(url);
  try {
    client.send({ type: "getVersion" });
    const state = await client.waitFor((message) => message.type === "versionState");
    return typeof state.latest === "string" ? state.latest : null;
  } finally {
    client.close();
  }
}

async function kill(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  child.kill("SIGKILL");
  await child.exited;
}

describe("restart after SIGKILL", () => {
  test(
    "replays and resumes lifecycle, foreground, and paused work",
    async () => {
      const fixture = await createFixture();
      await writeFile(
        fixture.trackerFile,
        JSON.stringify([{ number: 81, title: "Killed epic", url: "https://example.test/81" }]),
      );

      let server = await startProcess(fixture);
      let client = await connect(server.url);
      let laneId = "";
      let laneActivity: string[] = [];
      let questionId: unknown;
      let lifecycleState: Record<string, unknown>;

      try {
        // The update check resolves the offline fixture instead of journaling a failure.
        await waitUntil(
          async () => (await reportedLatest(server.url)) === FIXTURE_RELEASE_VERSION,
          "the server never reported the fixture release",
        );
        client.send({ type: "startLifecycle" });
        lifecycleState = await client.waitFor(
          (message) =>
            message.type === "lifecycleState" &&
            message.stage === "implementation" &&
            message.work !== null,
        );
        const question = await client.waitFor(
          (message) => message.type === "question" && typeof message.lane === "string",
        );
        laneId = String(question.lane);
        questionId = question.id;
        const snapshot = await client.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { id: string; activity: string[] }[]).some(
              (lane) => lane.id === laneId && lane.activity.length > 0,
            ),
        );
        laneActivity = (
          snapshot.lanes as { id: string; activity: string[] }[]
        ).find((lane) => lane.id === laneId)?.activity ?? [];
        expect(laneActivity).toEqual(["Working on epic 81"]);
        expect(prompts(fixture.logPath)).toEqual(["/implement-next-epic 81"]);
      } finally {
        client.close();
        await kill(server.child);
      }

      const oldPid = spawnPids(fixture.logPath)[0] ?? 0;

      server = await startProcess(fixture, server.port);
      client = await connect(server.url);
      try {
        const replayedLifecycle = await client.waitFor(
          (message) => message.type === "lifecycleState",
        );
        expect(replayedLifecycle).toMatchObject({
          stage: lifecycleState.stage,
          pass: lifecycleState.pass,
          work: lifecycleState.work,
          paused: lifecycleState.paused,
        });
        const replayedLanes = await client.waitFor((message) => message.type === "laneState");
        const lane = (replayedLanes.lanes as {
          id: string;
          kind: string;
          status: string;
          activity: string[];
          question: { id: unknown } | null;
        }[]).find((entry) => entry.id === laneId);
        expect(lane?.kind).toBe("implementation");
        expect(lane?.status).toBe("running");
        // The recorded activity stays an exact prefix of the restored log.
        expect(lane?.activity.slice(0, laneActivity.length)).toEqual(laneActivity);
        expect(lane?.question?.id).toBe(questionId);
        // No epic owns a second implementation lane after the restart.
        expect(
          (replayedLanes.lanes as { kind: string; epic: { number: number } | null }[]).filter(
            (entry) => entry.kind === "implementation" && entry.epic?.number === 81,
          ).length,
        ).toBe(1);

        await waitUntil(
          () => prompts(fixture.logPath).length === 2,
          "the replacement did not re-spawn the killed lane",
        );
        const newPid = spawnPids(fixture.logPath)[1] ?? 0;
        expect(alive(oldPid)).toBe(false);
        expect(alive(newPid)).toBe(true);
        expect(prompts(fixture.logPath).filter((prompt) => prompt === "/implement-next-epic 81")).toEqual([
          "/implement-next-epic 81",
          "/implement-next-epic 81",
        ]);

        // The restored question is refused until the replacement asks again.
        client.send({ type: "answer", lane: laneId, id: questionId, value: "Beta" });
        expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
          message: "The question is no longer pending.",
        });
        const reissued = await client.waitFor(
          (message) => message.type === "question" && message.lane === laneId,
        );
        client.send({ type: "answer", lane: laneId, id: reissued.id, value: "Beta" });
        await waitUntil(
          () => logLines(fixture.logPath).includes("answer Beta"),
          "the replacement question was not answerable",
        );

        // End the lifecycle so a foreground run can take the agent slot.
        client.send({ type: "stopLifecycle" });
        await client.waitFor(
          (message) =>
            message.type === "lifecycleState" && message.stage === "goal" && message.paused === false,
        );
      } finally {
        client.close();
        await kill(server.child);
      }

      // Foreground: a manual ADR run is live with a pending question at death.
      server = await startProcess(fixture, server.port);
      client = await connect(server.url);
      let runActivity = "";
      let runQuestion: unknown;
      try {
        client.send({ type: "startRun" });
        const started = await client.waitFor((message) => message.type === "runStarted");
        expect(started).toMatchObject({ file: "0001-first.md", manual: true });
        const activity = await client.waitFor(
          (message) => message.type === "activity" && typeof message.lane !== "string",
        );
        runActivity = String(activity.text);
        const question = await client.waitFor(
          (message) => message.type === "question" && typeof message.lane !== "string",
        );
        runQuestion = question.id;
      } finally {
        client.close();
        await kill(server.child);
      }

      const runPid = spawnPids(fixture.logPath).at(-1) ?? 0;
      const spawnsBeforeRestart = spawnPids(fixture.logPath).length;
      server = await startProcess(fixture, server.port);
      client = await connect(server.url);
      try {
        const started = await client.waitFor((message) => message.type === "runStarted");
        expect(started).toMatchObject({
          file: "0001-first.md",
          action: "resolving",
          manual: true,
        });
        expect(await client.waitFor((message) => message.type === "activity")).toEqual({
          type: "activity",
          text: runActivity,
        });
        expect(
          await client.waitFor((message) => message.type === "question" && typeof message.lane !== "string"),
        ).toMatchObject({ id: runQuestion });

        await waitUntil(
          () => spawnPids(fixture.logPath).length === spawnsBeforeRestart + 1,
          "the replacement did not re-spawn the manual run",
        );
        expect(alive(runPid)).toBe(false);
        expect(alive(spawnPids(fixture.logPath).at(-1) ?? 0)).toBe(true);

        const reissued = await client.waitFor(
          (message) => message.type === "question" && typeof message.lane !== "string",
        );
        client.send({ type: "answer", id: reissued.id, value: "Alpha" });
        const stopped = await client.waitFor(
          (message) => message.type === "runStopped",
          "the restored manual run did not finish",
          20000,
        );
        expect(stopped).toMatchObject({ file: "0001-first.md", resolved: true });
      } finally {
        client.close();
        await kill(server.child);
      }

      // Paused: a lifecycle run paused at death spawns nothing on restart.
      await writeFile(
        fixture.trackerFile,
        JSON.stringify([
          { number: 81, title: "Killed epic", url: "https://example.test/81" },
          { number: 82, title: "Paused epic", url: "https://example.test/82" },
        ]),
      );
      server = await startProcess(fixture, server.port);
      client = await connect(server.url);
      try {
        client.send({ type: "startLifecycle" });
        await client.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { status: string }[]).filter((lane) => lane.status === "running")
              .length >= 2,
        );
        await waitUntil(
          () =>
            prompts(fixture.logPath).filter((prompt) => prompt === "/implement-next-epic 82")
              .length === 1,
          "the second epic did not start",
        );
        client.send({ type: "pauseLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === true,
        );
        await client.waitFor(
          (message) =>
            message.type === "laneState" &&
            (message.lanes as { status: string }[]).every((lane) => lane.status === "paused"),
        );
      } finally {
        client.close();
        await kill(server.child);
      }

      const pausedPids = spawnPids(fixture.logPath).length;
      const pausedPrompts = (id: string) =>
        prompts(fixture.logPath).filter((prompt) => prompt === `/implement-next-epic ${id}`)
          .length;
      const paused81 = pausedPrompts("81");
      const paused82 = pausedPrompts("82");
      server = await startProcess(fixture, server.port);
      client = await connect(server.url);
      try {
        expect(await client.waitFor((message) => message.type === "lifecycleState")).toMatchObject({
          stage: "implementation",
          paused: true,
        });
        const snapshot = await client.waitFor((message) => message.type === "laneState");
        expect(
          (snapshot.lanes as { status: string; kind: string }[])
            .filter((lane) => lane.kind !== "generation")
            .every((lane) => lane.status === "paused"),
        ).toBe(true);

        // Nothing spawns while the restored run stays paused. The baseline is
        // read once the restored paused state is observable, so a spawn line the
        // killed process flushed after its lanes were paused cannot read as new
        // work of the restored run.
        const restoredPids = spawnPids(fixture.logPath).length;
        await Bun.sleep(700);
        expect(spawnPids(fixture.logPath).length).toBe(restoredPids);
        expect(prompts(fixture.logPath).filter((prompt) => prompt === "/epic-next")).toEqual([]);

        client.send({ type: "resumeLifecycle" });
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.paused === false,
        );
        await waitUntil(
          () => spawnPids(fixture.logPath).length === pausedPids + 2,
          "resume did not re-spawn the interrupted lanes",
        );
        expect(pausedPrompts("81")).toBe(paused81 + 1);
        expect(pausedPrompts("82")).toBe(paused82 + 1);
        expect(alive(spawnPids(fixture.logPath).at(-1) ?? 0)).toBe(true);
      } finally {
        client.close();
        await kill(server.child);
      }
    },
    180000,
  );

  test(
    "a manual sequence that ends with a pending record does not resume on restart",
    async () => {
      const fixture = await createFixture();

      let server = await startProcess(fixture, undefined, ["--no-resolve"]);
      let client = await connect(server.url);
      try {
        client.send({ type: "startRun" });
        expect(await client.waitFor((message) => message.type === "runStarted")).toMatchObject({
          file: "0001-first.md",
          manual: true,
        });
        const question = await client.waitFor(
          (message) => message.type === "question" && typeof message.lane !== "string",
        );
        client.send({ type: "answer", id: question.id, value: "Alpha" });
        expect(
          await client.waitFor(
            (message) => message.type === "runStopped",
            "the manual run did not stop with its record pending",
            20000,
          ),
        ).toMatchObject({ file: "0001-first.md", resolved: false });
        // The sequence ended in memory; the durable state must agree.
        await waitUntil(
          () => {
            const state = storedState(fixture);
            return state.manualSequencing === false && state.manualRun === null;
          },
          "the cleared manual sequence was never persisted",
          5000,
        );
      } finally {
        client.close();
        await kill(server.child);
      }

      const spawnsBeforeRestart = spawnPids(fixture.logPath).length;
      server = await startProcess(fixture, undefined, ["--no-resolve"]);
      client = await connect(server.url);
      try {
        // Nothing resolves the pending record until a client asks for it. The
        // server runs in another process, so a real quiet window is the only
        // way to observe that no peer spawned; fake timers cannot drive it.
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline && spawnPids(fixture.logPath).length === spawnsBeforeRestart) {
          await Bun.sleep(25);
        }
        expect(spawnPids(fixture.logPath).length).toBe(spawnsBeforeRestart);
        expect(client.events.filter((message) => message.type === "runStarted")).toEqual([]);

        client.send({ type: "startRun" });
        expect(
          await client.waitFor((message) => message.type === "runStarted"),
        ).toMatchObject({ file: "0001-first.md", manual: true });
      } finally {
        client.close();
        await kill(server.child);
      }
    },
    60000,
  );

  test(
    "keeps serving with one stderr error when the state directory is read-only",
    async () => {
      const fixture = await createFixture();
      await mkdir(join(fixture.stateDir, "state"), { recursive: true });
      await chmod(join(fixture.stateDir, "state"), 0o500);

      const server = await startProcess(fixture);
      const client = await connect(server.url);
      try {
        client.send({ type: "getProject" });
        await client.waitFor((message) => message.type === "project");
        // A broadcast is what writes the state; a manual run provides one.
        client.send({ type: "startRun" });
        await client.waitFor((message) => message.type === "runStarted");
        await waitUntil(
          () => server.stderr().includes("state: could not write"),
          "the read-only state directory was not reported",
        );
        expect(server.stderr().split("state: could not write").length - 1).toBe(1);
        expect(client.events.filter((message) => message.type === "error")).toEqual([]);
        client.send({ type: "getProject" });
        await client.waitFor((message) => message.type === "project");
      } finally {
        client.close();
        await kill(server.child);
        await chmod(join(fixture.stateDir, "state"), 0o700);
      }
    },
    60000,
  );

  test(
    "reports an unusable state file on stderr and keeps its bytes",
    async () => {
      const fixture = await createFixture();
      await mkdir(join(fixture.stateDir, "state"), { recursive: true });
      const corrupt = "{ not json";
      await writeFile(storedPath(fixture), corrupt);

      const server = await startProcess(fixture);
      const client = await connect(server.url);
      try {
        const error = await client.waitFor((message) => message.type === "error");
        expect(String(error.message)).toContain("could not be restored");
        expect(client.events.filter((message) => message.type === "error").length).toBe(1);
        await waitUntil(
          () => server.stderr().includes("could not be restored"),
          "the replacement did not report the unusable state on stderr",
        );
        const preserved = readdirSync(join(fixture.stateDir, "state")).filter((name) =>
          name.includes(".damaged-"),
        );
        expect(preserved.length).toBe(1);
        expect(
          readFileSync(join(fixture.stateDir, "state", String(preserved[0])), "utf8"),
        ).toBe(corrupt);
      } finally {
        client.close();
        await kill(server.child);
      }
    },
    60000,
  );
});
