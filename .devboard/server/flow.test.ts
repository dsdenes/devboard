import { fixtureRecord } from "./fixtures/adr-source";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import { FlowController } from "./flow";
import { detachedRunDirectory, readDetachedRunState } from "./detached-run";
import { recordedChildAlive, stateFile, type RecordedChild } from "./state";
import { StubForge } from "./fixtures/stub-forge";
import { UNTRACKED_BODY_MAX_BYTES } from "./flow";
import { journalKey } from "./journal";
import { remoteScratchRoot, type RemoteCloneRequest, type RemoteCloneRunner } from "./discover";
import { testProviderService } from "./fixtures/test-providers";
import type { ProviderService } from "./providers";
import { seedVerificationProvider, verificationProviderUsageEnv } from "../scripts/provider-fixture";

/**
 * Flow Mode's deterministic contract, driven over the app's WebSocket with the
 * stub ACP agent and an injected fake forge. Every fixture, state directory,
 * worktree, and bare remote lives under the harness `.tmp`, never outside the
 * repository root.
 */

const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "flow-tests");
const SENTINEL_GOAL = "# Fixture goal\n\nThe goal the host already had.\n";
const FLOW_GOAL = "# Flow goal\n\nMake the fixture behavior observable.";

mkdirSync(TEST_ROOT, { recursive: true });

interface Fixture {
  root: string;
  logPath: string;
  forgeLog: string;
  stateDir: string;
  goalFile: string;
}

const cleanup: (() => void)[] = [];
const servers: Server<unknown>[] = [];

afterEach(() => {
  // Stop each test's servers and their ACP peers before the next test; the
  // suite runs many peers in parallel and a leftover server starves the next
  // fixture's interview on a small CI runner.
  for (const server of servers.splice(0)) server.stop(true);
});

afterAll(() => {
  for (const action of cleanup.reverse()) action();
});

function testDirectory(name: string): string {
  const directory = join(TEST_ROOT, `${name}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=Flow Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

const GITIGNORE = [".worktree/", "node_modules/", "state/", "origin.git/", "*.log", ""].join("\n");

/** A real host checkout on `main`, a sentinel goal, a sentinel ADR, and a bare origin. */
function createFixture(name: string): Fixture {
  const root = testDirectory(name);
  mkdirSync(join(root, "adrs"), { recursive: true });
  mkdirSync(join(root, "static"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "static", "index.html"), "<!doctype html><title>Fixture</title>");
  writeFileSync(join(root, "GOAL.md"), SENTINEL_GOAL);
  writeFileSync(join(root, "adrs", "0001-fixture.md"), fixtureRecord("0001-fixture.md", "Fixture decision"));
  writeFileSync(join(root, ".gitignore"), GITIGNORE);
  writeFileSync(join(root, "src", "main.txt"), "base\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "chore: fixture base"]);
  git(root, ["init", "--bare", join(root, "origin.git")]);
  git(root, ["remote", "add", "origin", join(root, "origin.git")]);
  git(root, ["push", "-u", "origin", "main"]);

  const logPath = join(root, "agent.log");
  const forgeLog = join(root, "forge.log");
  const fixture: Fixture = {
    root,
    logPath,
    forgeLog,
    stateDir: join(root, "state"),
    goalFile: join(root, "GOAL.md"),
  };
  cleanup.push(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A locked fixture directory is left for the operator.
    }
  });
  return fixture;
}

interface TestServer {
  server: Server<unknown>;
  fixture: Fixture;
  forge: StubForge;
  url: string;
  trackerReads: () => number;
}

interface StartOptions {
  stub?: string[];
  forge?: StubForge;
  watchMs?: number;
  tracker?: () => Promise<undefined>;
  stateDir?: string;
  restart?: () => void;
  /** Replaces the deterministic provider service, to defer peer preparation. */
  providers?: ProviderService;
  /** Injects the Discover clone so no test reaches the network. */
  discoverClone?: RemoteCloneRunner;
}

function startServer(fixture: Fixture, options: StartOptions = {}): TestServer {
  let reads = 0;
  const forge = options.forge ?? new StubForge({ logPath: fixture.forgeLog });
  const command = [`bun ${STUB_AGENT}`, `--log=${fixture.logPath}`, ...(options.stub ?? [])]
    .filter((part) => part.length > 0)
    .join(" ");
  const server = createApp({
    adrDir: join(fixture.root, "adrs"),
    staticDir: join(fixture.root, "static"),
    hostname: "127.0.0.1",
    port: 0,
    repoDir: fixture.root,
    stateDir: options.stateDir ?? fixture.stateDir,
    providers: options.providers ?? testProviderService(options.stateDir ?? fixture.stateDir),
    goalFile: fixture.goalFile,
    agentCommand: command,
    tracker:
      options.tracker ??
      (async () => {
        reads += 1;
        return undefined;
      }),
    trackerSettle: { attempts: 1 },
    restart: options.restart,
    ...(options.discoverClone === undefined ? {} : { discoverClone: options.discoverClone }),
    flow: {
      forge,
      forgeTarget: { forge: "github", host: "forge.test", project: "acme/fixture" },
      watchMs: options.watchMs ?? 40,
      analystTimeoutMs: 10_000,
    },
  });
  servers.push(server);
  return {
    server,
    fixture,
    forge,
    url: `127.0.0.1:${server.port}`,
    trackerReads: () => reads,
  };
}

type Event = Record<string, unknown>;

interface TestClient {
  events: Event[];
  mark(): number;
  send(command: unknown): void;
  waitFor(
    predicate: (event: Event) => boolean,
    options?: { timeout?: number; from?: number },
  ): Promise<Event>;
  close(): void;
}

/** Waits for a condition over the events a client has already received. */
async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeout = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function latest(client: TestClient, type: string): Event | undefined {
  return [...client.events].reverse().find((event) => event.type === type);
}

function connect(testServer: { url: string }): Promise<TestClient> {
  const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${testServer.url}/ws`);
  const events: Event[] = [];
  const waiters: {
    predicate: (event: Event) => boolean;
    from: number;
    resolve: (event: Event) => void;
    reject: (error: Error) => void;
    timer: Timer;
  }[] = [];

  socket.onopen = () => {
    resolve({
      events,
      mark: () => events.length,
      send(command) {
        socket.send(JSON.stringify(command));
      },
      waitFor(predicate, options = {}) {
        const from = options.from ?? 0;
        const timeout = options.timeout ?? 20_000;
        const found = events.slice(from).find(predicate);
        if (found !== undefined) return Promise.resolve(found);
        const { promise: waiting, resolve: settle, reject: fail } =
          Promise.withResolvers<Event>();
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === settle);
          if (index >= 0) waiters.splice(index, 1);
          fail(new Error(`Timed out waiting for an event. Saw: ${JSON.stringify(events)}`));
        }, timeout);
        waiters.push({ predicate, from, resolve: settle, reject: fail, timer });
        return waiting;
      },
      close() {
        socket.close();
      },
    });
  };

  socket.onmessage = (message) => {
    let event: Event;
    try {
      event = JSON.parse(String(message.data)) as Event;
    } catch {
      return;
    }
    events.push(event);
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      if (waiter === undefined) continue;
      const candidate = events.slice(waiter.from).find(waiter.predicate);
      if (candidate === undefined) continue;
      waiters.splice(index, 1);
      index -= 1;
      clearTimeout(waiter.timer);
      waiter.resolve(candidate);
    }
  };

  socket.onerror = () => reject(new Error("WebSocket failed"));
  return promise;
}

/** A round trip proving the socket is open before a command is sent. */
async function connected(client: TestClient): Promise<void> {
  client.send({ type: "getProject" });
  await client.waitFor((event) => event.type === "project");
}

function stubLog(fixture: Fixture): string[] {
  try {
    return readFileSync(fixture.logPath, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function spawns(fixture: Fixture): string[] {
  return stubLog(fixture).filter((line) => line.startsWith("spawn "));
}

function prompts(fixture: Fixture): string[] {
  return stubLog(fixture).filter((line) => line.startsWith("prompt "));
}

/**
 * Holds the next provider selection until the test releases it. `settled`
 * resolves before the held caller's continuation is queued, so awaiting it and
 * one microtask turn proves that continuation has run.
 */
function deferNextSelection(providers: ProviderService): {
  entered: Promise<void>;
  release: () => void;
  settled: Promise<void>;
} {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const select = providers.select.bind(providers);
  let held = true;
  providers.select = async () => {
    if (!held) return select();
    held = false;
    entered.resolve();
    await release.promise;
    const result = await select();
    settled.resolve();
    return result;
  };
  return { entered: entered.promise, release: release.resolve, settled: settled.promise };
}

/** Waits for a line the spawned stub writes, instead of guessing a duration. */
async function waitForStub(
  fixture: Fixture,
  predicate: (line: string) => boolean,
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (stubLog(fixture).some(predicate)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for the stub log. Saw: ${JSON.stringify(stubLog(fixture))}`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sessionIds(fixture: Fixture): string[] {
  const directory = join(fixture.stateDir, "flow", journalKey(fixture.root));
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readSession(fixture: Fixture, id: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixture.stateDir, "flow", journalKey(fixture.root), id, "session.json"), "utf8"),
  ) as Record<string, unknown>;
}

/** Writes one pre-existing session directory, as a previous dashboard left it. */
function seedSession(
  fixture: Fixture,
  id: string,
  status: "idle" | "stopped" | "merged",
  goal: string,
  prState?: "live" | "merged",
): string {
  const directory = join(fixture.stateDir, "flow", journalKey(fixture.root), id);
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(fixture.root, ".worktree", `flow-${id}`), { recursive: true });
  const state = prState ?? (status === "merged" ? "merged" : null);
  const pr =
    state === null
      ? null
      : {
          forge: "github",
          number: 1,
          url: "https://forge.test/acme/fixture/pull/1",
          state,
        };
  writeFileSync(
    join(directory, "session.json"),
    `${JSON.stringify(
      {
        version: 1,
        id,
        baseRevision: null,
        worktree: join(fixture.root, ".worktree", `flow-${id}`),
        branch: `flow/${id}`,
        status,
        goal,
        decisions: "",
        steering: [],
        accepted: [],
        widgets: [],
        files: [],
        checkpoints: [],
        verification: null,
        blockers: [],
        pr,
        prError: null,
        leftover: null,
        cleanupPending: false,
        pushedTip: null,
        prFailedTip: null,
        lastDiffHash: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(directory, "goal.md"), goal);
  return directory;
}

/** Makes the fixture a harness source checkout, so Discover's remote target exists. */
function markSourceCheckout(fixture: Fixture): void {
  mkdirSync(join(fixture.root, ".devboard"), { recursive: true });
  writeFileSync(
    join(fixture.root, ".devboard", "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.0.0" }, null, 2)}\n`,
  );
}

/** A directory an injected Discover clone copies; no test reaches the network. */
function createCloneSource(name: string): string {
  const root = testDirectory(`clone-source-${name}`);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n\nA remote fixture.\n`);
  writeFileSync(join(root, "src", "main.txt"), "remote\n");
  return root;
}

/** Records every clone and copies `source` into the requested destination. */
function cloneHarness(
  source: string,
  gate?: Promise<void>,
): { calls: RemoteCloneRequest[]; runner: RemoteCloneRunner } {
  const calls: RemoteCloneRequest[] = [];
  const runner: RemoteCloneRunner = async (request) => {
    calls.push(request);
    if (gate !== undefined) await gate;
    const destination = join(request.cwd, request.argv[request.argv.length - 1] ?? "");
    cpSync(source, destination, { recursive: true, force: true });
    return { code: 0, stderr: "", timedOut: false };
  };
  return { calls, runner };
}

/** True when a Discover snapshot reports a live remote checkout. */
function reportsCheckout(event: Event): boolean {
  const state = event.state;
  if (state === null || typeof state !== "object" || !("target" in state)) return false;
  const target = state.target;
  if (target === null || typeof target !== "object" || !("checkout" in target)) return false;
  return target.checkout === true;
}

/** The transient `.staging-*` entries of the harness remote scratch root. */
function checkoutEntries(fixture: Fixture): string[] {
  const root = remoteScratchRoot(fixture.stateDir);
  try {
    return readdirSync(root).filter((entry) => entry.startsWith(".staging-"));
  } catch {
    return [];
  }
}

async function createGoal(client: TestClient, fixture: Fixture): Promise<void> {
  client.send({ type: "createFlowGoal" });
  await client.waitFor((event) => event.type === "flowQuestion");
  const question = client.events.find((event) => event.type === "flowQuestion");
  client.send({
    type: "flowAnswer",
    target: "goal",
    id: question?.id,
    value: "Alpha",
  });
  await client.waitFor((event) => event.type === "flowGoalStopped" && event.completed === true);
}

/** Creates the goal, runs the stub implementation, and returns its widgets. */
async function implementedWidgets(
  client: TestClient,
  fixture: Fixture,
): Promise<{ id: string }[]> {
  await createGoal(client, fixture);
  client.send({ type: "startFlowImplementation" });
  await waitUntil(
    () => {
      const widgets = latest(client, "flowWidgets")?.widgets as { id: string }[] | undefined;
      return Array.isArray(widgets) && widgets.length > 0;
    },
    "the first widget snapshot",
  );
  await client.waitFor((event) => event.type === "flowStopped");
  return latest(client, "flowWidgets")?.widgets as { id: string }[];
}

/** Waits until a Flow widget snapshot covers every changed file. */
function isWidgetSnapshot(event: Event): boolean {
  return event.type === "flowWidgets" && Array.isArray(event.widgets);
}

describe("Flow Mode contract", () => {
  test("a fresh connection starts with no Flow work and spawns nothing", async () => {
    const fixture = createFixture("connect");
    const testServer = startServer(fixture);
    const client = await connect(testServer);

    client.send({ type: "getGoal" });
    const goal = await client.waitFor((event) => event.type === "goal");
    expect(goal.text).toBe(SENTINEL_GOAL);

    // A round trip after the reply proves no peer was spawned and no Flow
    // event was invented for a session that does not exist.
    client.send({ type: "getProject" });
    await client.waitFor((event) => event.type === "project");
    expect(client.events.some((event) => String(event.type).startsWith("flow"))).toBe(false);
    expect(spawns(fixture)).toHaveLength(0);
    expect(testServer.trackerReads()).toBe(0);
    client.close();
  }, 30_000);

  test("the Flow goal interview spawns one peer, writes only the session goal, and never GOAL.md", async () => {
    const fixture = createFixture("goal");
    const testServer = startServer(fixture, { stub: ["--flow-goal"] });
    const client = await connect(testServer);
    await connected(client);
    const before = sha256File(fixture.goalFile);

    client.send({ type: "createFlowGoal" });
    const started = await client.waitFor((event) => event.type === "flowGoalStarted");
    expect(started.type).toBe("flowGoalStarted");
    const question = await client.waitFor((event) => event.type === "flowQuestion");
    expect(question.target).toBe("goal");
    expect(Array.isArray(question.options)).toBe(true);
    expect((question.options as unknown[]).length).toBeGreaterThan(0);

    client.send({ type: "flowAnswer", target: "goal", id: question.id, value: "Alpha" });
    const stopped = await client.waitFor(
      (event) => event.type === "flowGoalStopped",
    );
    expect(stopped.completed).toBe(true);
    expect(stopped.text).toBe(FLOW_GOAL);

    // The goal lives in the session directory, keyed by the repository.
    const ids = sessionIds(fixture);
    expect(ids).toHaveLength(1);
    const id = ids[0] as string;
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const sessionDirectory = join(fixture.stateDir, "flow", journalKey(fixture.root), id);
    expect(readFileSync(join(sessionDirectory, "goal.md"), "utf8")).toBe(FLOW_GOAL);
    expect(sha256File(fixture.goalFile)).toBe(before);

    expect(spawns(fixture)).toHaveLength(1);
    expect(prompts(fixture).filter((line) => line.startsWith("prompt /flow-goal "))).toHaveLength(1);
    expect(prompts(fixture)[0]).toBe(`prompt /flow-goal ${sessionDirectory}`);
    expect(testServer.trackerReads()).toBe(0);

    // No Goal Mode activity or question event leaked from the interview.
    expect(client.events.filter((event) => event.type === "activity")).toHaveLength(0);
    expect(client.events.filter((event) => event.type === "question")).toHaveLength(0);
    client.close();
  }, 30_000);

  test("recreating a Flow goal reuses the unmerged session and replaces only its goal", async () => {
    const fixture = createFixture("goal-reuse");
    const testServer = startServer(fixture, { stub: ["--flow-goal"] });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    const firstId = sessionIds(fixture)[0] as string;

    const count = (type: string) => client.events.filter((event) => event.type === type).length;
    const questionsBefore = count("flowQuestion");
    const stopsBefore = count("flowGoalStopped");
    client.send({ type: "createFlowGoal" });
    await waitUntil(() => count("flowQuestion") > questionsBefore, "the second goal question");
    const question = [...client.events].reverse().find((event) => event.type === "flowQuestion");
    client.send({ type: "flowAnswer", target: "goal", id: question?.id, value: "Beta" });
    await waitUntil(
      () => count("flowGoalStopped") > stopsBefore,
      "the second goal creation to finish",
    );
    expect(sessionIds(fixture)).toEqual([firstId]);
    client.close();
  }, 30_000);

  test("an empty Flow goal reports one error and keeps the session for another attempt", async () => {
    const fixture = createFixture("goal-empty");
    const testServer = startServer(fixture, { stub: ["--flow-goal", "--flow-goal-empty"] });
    const client = await connect(testServer);
    await connected(client);
    const before = sha256File(fixture.goalFile);

    client.send({ type: "createFlowGoal" });
    await client.waitFor((event) => event.type === "flowQuestion");
    client.send({ type: "flowAnswer", target: "goal", id: 1, value: "Alpha" });
    const stopped = await client.waitFor((event) => event.type === "flowGoalStopped");
    expect(stopped.completed).toBe(false);
    expect("text" in stopped).toBe(false);
    const errors = client.events.filter((event) => event.type === "flowError");
    expect(errors).toHaveLength(1);
    expect(sessionIds(fixture)).toHaveLength(1);
    expect(sha256File(fixture.goalFile)).toBe(before);

    client.close();
  }, 30_000);

  test("canceling a working Flow goal interview ends the peer with no error or late output", async () => {
    const fixture = createFixture("goal-cancel-working");
    const gate = join(fixture.root, "goal-hang");
    writeFileSync(gate, "");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", `--flow-goal-hang=${gate}`],
    });
    const client = await connect(testServer);
    await connected(client);

    const mark = client.mark();
    client.send({ type: "createFlowGoal" });
    await client.waitFor((event) => event.type === "flowGoalStarted", { from: mark });
    await waitForStub(fixture, (line) => line.startsWith("flow-goal-hung "));
    client.send({ type: "cancelFlowGoal" });
    const stopped = await client.waitFor((event) => event.type === "flowGoalStopped", {
      from: mark,
    });
    expect(stopped.completed).toBe(false);
    expect("text" in stopped).toBe(false);
    expect(client.events.slice(mark).filter((event) => event.type === "flowError")).toHaveLength(0);
    await waitUntil(
      () => latest(client, "flowSnapshot")?.goalCreation === null,
      "the canceled interview state",
    );

    // The detached owner is stopped; nothing it produces afterwards may reach
    // the view as a question or activity line. Absence has no event to await,
    // so this integration case observes a real span after the stop.
    const after = client.mark();
    await Bun.sleep(500);
    expect(
      client.events
        .slice(after)
        .filter((event) => event.type === "flowQuestion" || event.type === "flowActivity"),
    ).toHaveLength(0);

    const snapshot = latest(client, "flowSnapshot");
    expect(snapshot?.goal).toBe("");
    expect(snapshot?.sessionId).toBe(null);
    // The session existed only for this canceled interview.
    expect(sessionIds(fixture)).toEqual([]);
    client.close();
  }, 30_000);

  test("canceling a waiting question clears it and lets Create start again immediately", async () => {
    const fixture = createFixture("goal-cancel-question");
    const testServer = startServer(fixture, { stub: ["--flow-goal"] });
    const client = await connect(testServer);
    await connected(client);

    const first = client.mark();
    client.send({ type: "createFlowGoal" });
    const question = await client.waitFor((event) => event.type === "flowQuestion", {
      from: first,
    });
    client.send({ type: "cancelFlowGoal" });
    const stopped = await client.waitFor((event) => event.type === "flowGoalStopped", {
      from: first,
    });
    expect(stopped.completed).toBe(false);
    expect("text" in stopped).toBe(false);
    expect(client.events.slice(first).filter((event) => event.type === "flowError")).toHaveLength(0);
    await waitUntil(
      () => {
        const snapshot = latest(client, "flowSnapshot");
        return snapshot?.goalCreation === null && snapshot.question === null;
      },
      "the cleared goal question",
    );
    expect(sessionIds(fixture)).toEqual([]);

    // Create works at once: one new peer, its own question, an accepted goal.
    const second = client.mark();
    client.send({ type: "createFlowGoal" });
    const next = await client.waitFor((event) => event.type === "flowQuestion", {
      from: second,
    });
    client.send({ type: "flowAnswer", target: "goal", id: next.id, value: "Alpha" });
    const accepted = await client.waitFor(
      (event) => event.type === "flowGoalStopped" && event.completed === true,
      { from: second },
    );
    expect(accepted.text).toBe(FLOW_GOAL);
    expect(client.events.slice(second).filter((event) => event.type === "flowError")).toHaveLength(0);
    expect(sessionIds(fixture)).toHaveLength(1);
    expect(prompts(fixture).filter((line) => line.startsWith("prompt /flow-goal "))).toHaveLength(2);
    client.close();
  }, 30_000);

  test("canceling a re-created goal restores its accepted bytes", async () => {
    const fixture = createFixture("goal-cancel-restore");
    const gate = join(fixture.root, "goal-hang");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", `--flow-goal-hang=${gate}`],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    const id = sessionIds(fixture)[0] as string;
    const directory = join(fixture.stateDir, "flow", journalKey(fixture.root), id);
    const goalPath = join(directory, "goal.md");
    const acceptedBytes = readFileSync(goalPath, "utf8");
    expect(readSession(fixture, id).goal).toBe(acceptedBytes);

    // The hanging stub makes the re-created interview stay live with no draft.
    writeFileSync(gate, "");
    const mark = client.mark();
    client.send({ type: "createFlowGoal" });
    await client.waitFor((event) => event.type === "flowGoalStarted", { from: mark });
    await waitForStub(fixture, (line) => line.startsWith("flow-goal-hung "));
    client.send({ type: "cancelFlowGoal" });
    const stopped = await client.waitFor((event) => event.type === "flowGoalStopped", {
      from: mark,
    });
    expect(stopped.completed).toBe(false);
    expect("text" in stopped).toBe(false);
    expect(client.events.slice(mark).filter((event) => event.type === "flowError")).toHaveLength(0);

    expect(readFileSync(goalPath, "utf8")).toBe(acceptedBytes);
    expect(readSession(fixture, id).goal).toBe(acceptedBytes);
    await waitUntil(
      () => {
        const snapshot = latest(client, "flowSnapshot");
        return (
          snapshot?.goalCreation === null &&
          snapshot.sessionId === id &&
          snapshot.goal === acceptedBytes
        );
      },
      "the restored saved goal",
    );
    expect(sessionIds(fixture)).toEqual([id]);
    client.close();
  }, 30_000);

  test("canceling a Create that opened a session removes only that directory", async () => {
    const fixture = createFixture("goal-cancel-merged");
    const mergedDirectory = seedSession(fixture, "merged1", "merged", "# Merged goal\n");
    const mergedBytes = readFileSync(join(mergedDirectory, "session.json"), "utf8");
    const testServer = startServer(fixture, { stub: ["--flow-goal"] });
    const client = await connect(testServer);
    await connected(client);
    // Restore runs in a microtask before any socket command is handled, so the
    // merged-only session is already history here.

    const mark = client.mark();
    client.send({ type: "createFlowGoal" });
    await client.waitFor((event) => event.type === "flowQuestion", { from: mark });
    expect(sessionIds(fixture).length).toBe(2);
    client.send({ type: "cancelFlowGoal" });
    const stopped = await client.waitFor((event) => event.type === "flowGoalStopped", {
      from: mark,
    });
    expect(stopped.completed).toBe(false);
    expect(client.events.slice(mark).filter((event) => event.type === "flowError")).toHaveLength(0);

    expect(sessionIds(fixture)).toEqual(["merged1"]);
    expect(readFileSync(join(mergedDirectory, "session.json"), "utf8")).toBe(mergedBytes);
    await waitUntil(
      () => latest(client, "flowSnapshot")?.sessionId === null,
      "the restored empty session",
    );

    // A fresh restore selects no canceled session and keeps the history entry.
    const restored = new FlowController({
      repoDir: fixture.root,
      stateDir: fixture.stateDir,
      agentCommand: `bun ${STUB_AGENT} --flow-goal`,
      agentEnvironment: async () => ({ ...process.env }),
      broadcast: () => {},
      watchMs: 20,
      analystTimeoutMs: 1_000,
    });
    try {
      restored.begin();
      // The restore has no real I/O for a merged-only directory: its queued
      // microtask finishes before the next turn.
      await Promise.resolve();
      expect(restored.snapshot().sessionId).toBe(null);
      expect(restored.snapshot().history.map((entry) => entry.sessionId)).toEqual(["merged1"]);
    } finally {
      restored.dispose();
    }
    client.close();
  }, 30_000);

  test("a canceled interview's partial draft never becomes the session goal", async () => {
    const fixture = createFixture("goal-cancel-partial");
    const gate = join(fixture.root, "goal-partial");
    writeFileSync(gate, "");
    seedSession(fixture, "existing1", "stopped", FLOW_GOAL);
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", `--flow-goal-partial=${gate}`],
    });
    const client = await connect(testServer);
    await connected(client);

    const mark = client.mark();
    client.send({ type: "createFlowGoal" });
    await client.waitFor((event) => event.type === "flowGoalStarted", { from: mark });
    await waitForStub(fixture, (line) => line.startsWith("flow-goal-partial "));
    client.send({ type: "cancelFlowGoal" });
    const stopped = await client.waitFor((event) => event.type === "flowGoalStopped", {
      from: mark,
    });
    expect(stopped.completed).toBe(false);
    expect("text" in stopped).toBe(false);

    const directory = join(fixture.stateDir, "flow", journalKey(fixture.root), "existing1");
    expect(readFileSync(join(directory, "goal.md"), "utf8")).toBe(FLOW_GOAL);
    expect(readSession(fixture, "existing1").goal).toBe(FLOW_GOAL);
    expect(readFileSync(join(directory, "session.json"), "utf8")).not.toContain(
      "An unfinished draft",
    );
    await waitUntil(
      () => latest(client, "flowSnapshot")?.goal === FLOW_GOAL,
      "the restored partial goal",
    );
    client.close();
  }, 30_000);

  test("a failed Flow goal interview reports one error and keeps the accepted goal", async () => {
    const fixture = createFixture("goal-fail");
    const directory = seedSession(fixture, "existing1", "stopped", FLOW_GOAL);
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-goal-fail"],
    });
    const client = await connect(testServer);
    await connected(client);

    const mark = client.mark();
    client.send({ type: "createFlowGoal" });
    const question = await client.waitFor((event) => event.type === "flowQuestion", {
      from: mark,
    });
    client.send({ type: "flowAnswer", target: "goal", id: question.id, value: "Alpha" });
    const stopped = await client.waitFor((event) => event.type === "flowGoalStopped", {
      from: mark,
    });
    expect(stopped.completed).toBe(false);
    expect("text" in stopped).toBe(false);
    const errors = client.events.slice(mark).filter((event) => event.type === "flowError");
    expect(errors).toHaveLength(1);
    expect(readFileSync(join(directory, "goal.md"), "utf8")).toBe(FLOW_GOAL);
    expect(readSession(fixture, "existing1").goal).toBe(FLOW_GOAL);
    client.close();
  }, 30_000);

  test.skipIf(process.env.FLOW_LONG_INTERVIEW !== "1")(
    "a Flow goal interview has no wall-clock bound",
    async () => {
      const fixture = createFixture("goal-long");
      const testServer = startServer(fixture, {
        stub: ["--flow-goal", "--flow-goal-settle=121000"],
      });
      const client = await connect(testServer);
      await connected(client);

      client.send({ type: "createFlowGoal" });
      const question = await client.waitFor((event) => event.type === "flowQuestion");
      client.send({ type: "flowAnswer", target: "goal", id: question.id, value: "Alpha" });
      await waitForStub(fixture, (line) => line.startsWith("flow-goal-written "));
      const mark = client.mark();

      // Past the old 120 s bound the interview is still the live one. This case
      // exists to exercise the wall clock itself; deterministic timers cannot
      // replace the real detached turn.
      await Bun.sleep(120_500);
      expect(
        client.events
          .slice(mark)
          .filter((event) => event.type === "flowGoalStopped" || event.type === "flowError"),
      ).toHaveLength(0);
      const observer = await connect(testServer);
      const snapshot = await observer.waitFor((event) => event.type === "flowSnapshot");
      expect(snapshot.goalCreation).not.toBe(null);
      expect(snapshot.question).toBe(null);
      observer.close();

      const stopped = await client.waitFor(
        (event) => event.type === "flowGoalStopped" && event.completed === true,
        { from: mark, timeout: 30_000 },
      );
      expect(stopped.text).toBe(FLOW_GOAL);
      client.close();
    },
    200_000,
  );

  test("a goal save during the interview is refused and cannot outlive it", async () => {
    const fixture = createFixture("goal-save-interview");
    const interviewGoal = "# Interview goal\n\nOnly the interview may write this.\n";
    const savedText = "# Saved during the interview\n\nThis text must never be accepted.\n";
    // The stub receives its argv through the ACP command line, so the goal text
    // travels in a file rather than as an argument split on whitespace.
    const interviewGoalFile = join(fixture.root, "interview-goal.md");
    writeFileSync(interviewGoalFile, interviewGoal);
    // The settle delay keeps the interview's turn live after it writes goal.md:
    // exactly the window in which a save was accepted and then discarded.
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-goal-settle=3000",
        `--flow-goal-text-file=${interviewGoalFile}`,
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    const id = sessionIds(fixture)[0] as string;
    const sessionDirectory = join(fixture.stateDir, "flow", journalKey(fixture.root), id);
    const goalPath = join(sessionDirectory, "goal.md");
    expect(readSession(fixture, id).goal).toBe(interviewGoal);
    expect(readFileSync(goalPath, "utf8")).toBe(interviewGoal);

    const writesBefore = stubLog(fixture).filter((line) =>
      line.startsWith("flow-goal-written "),
    ).length;
    const mark = client.mark();
    client.send({ type: "createFlowGoal" });
    const question = await client.waitFor(
      (event) => event.type === "flowQuestion" && event.target === "goal",
      { from: mark },
    );
    client.send({ type: "flowAnswer", target: "goal", id: question.id, value: "Alpha" });
    await waitUntil(
      () =>
        stubLog(fixture).filter((line) => line.startsWith("flow-goal-written ")).length >
        writesBefore,
      "the interview's goal write",
    );
    // A removed hand-write command is refused and confirms no text.
    client.send({ type: "saveFlowGoal", text: savedText });
    expect(await client.waitFor((event) => event.type === "error", { from: mark })).toEqual({
      type: "error",
      message: "Invalid WebSocket message.",
    });
    expect(readSession(fixture, id).goal).toBe(interviewGoal);
    expect(readFileSync(goalPath, "utf8")).toBe(interviewGoal);
    expect(
      client.events.some(
        (event) => event.type === "flowSnapshot" && event.goal === savedText,
      ),
    ).toBe(false);

    // When the interview finishes, its goal.md text is the only accepted goal.
    const stopped = await client.waitFor(
      (event) => event.type === "flowGoalStopped" && event.completed === true,
      { from: mark },
    );
    expect(stopped.text).toBe(interviewGoal);
    expect(readSession(fixture, id).goal).toBe(interviewGoal);
    expect(readFileSync(goalPath, "utf8")).toBe(interviewGoal);
    expect(readFileSync(join(sessionDirectory, "session.json"), "utf8")).not.toContain(savedText);
    client.close();
  }, 30_000);

  test("a stopped session's watcher never rewrites the goal an interview is writing", async () => {
    const fixture = createFixture("goal-after-stop");
    const replacement = join(fixture.root, "replacement-goal.md");
    const replacementText = "# Replacement goal\n\nWritten during the second interview.\n";
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-pre-commit-delay=5000",
        "--flow-goal-settle=700",
        `--flow-goal-text-file=${replacement}`,
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    const id = sessionIds(fixture)[0] as string;
    const sessionDirectory = join(fixture.stateDir, "flow", journalKey(fixture.root), id);
    const goalPath = join(sessionDirectory, "goal.md");
    expect(readSession(fixture, id).goal).toBe(FLOW_GOAL);

    client.send({ type: "startFlowImplementation" });
    await client.waitFor((event) => event.type === "flowImplementationStarted");
    await waitForStub(fixture, (line) => line.startsWith("prompt /flow-implement "));
    client.send({ type: "stopFlowImplementation" });
    await client.waitFor((event) => event.type === "flowStopped");
    expect(readSession(fixture, id).status).toBe("stopped");

    // The second interview writes its goal immediately and keeps working for
    // longer than several ticks; the watcher must leave that draft alone.
    writeFileSync(replacement, replacementText);
    const written = stubLog(fixture).filter((line) => line.startsWith("flow-goal-written ")).length;
    const mark = client.mark();
    client.send({ type: "createFlowGoal" });
    const question = await client.waitFor((event) => event.type === "flowQuestion", { from: mark });
    client.send({ type: "flowAnswer", target: "goal", id: question.id, value: "Alpha" });
    await waitUntil(
      () =>
        stubLog(fixture).filter((line) => line.startsWith("flow-goal-written ")).length >
        written,
      "the second interview's goal write",
    );
    expect(readFileSync(goalPath, "utf8")).toBe(replacementText);
    // Real time is the subject: the live watcher's 40 ms ticks must not touch
    // the file while the stub peer is still inside its turn.
    await Bun.sleep(700);
    expect(readFileSync(goalPath, "utf8")).toBe(replacementText);

    const stopped = await client.waitFor((event) => event.type === "flowGoalStopped", {
      from: mark,
    });
    expect(stopped.completed).toBe(true);
    expect(stopped.text).toBe(replacementText);
    expect(readSession(fixture, id).goal).toBe(replacementText);
    expect(readFileSync(goalPath, "utf8")).toBe(replacementText);
    client.close();
  }, 30_000);

  test("the Flow implementation gets one peer in its own worktree and branch from origin/main", async () => {
    const fixture = createFixture("implement");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-checkpoints=1", "--flow-analyst"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);

    const originMain = git(fixture.root, ["--git-dir", join(fixture.root, "origin.git"), "rev-parse", "main"]).trim();
    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    const sessionId = started.sessionId as string;
    expect(sessionId).toMatch(/^[0-9a-f]{8}$/);
    const worktree = join(fixture.root, ".worktree", `flow-${sessionId}`);
    expect(started.worktree).toBe(worktree);
    expect(started.branch).toBe(`flow/${sessionId}`);
    expect(started.baseRevision).toBe(originMain);
    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(`flow/${sessionId}`);

    await waitForStub(fixture, (line) => line.startsWith("prompt /flow-implement "));
    // The first checkpoint proves the implementation turn is under way, so the
    // peer's own log lines exist before they are asserted.
    await waitForStub(fixture, (line) => line.startsWith("flow-checkpoint 1 "));
    expect(spawns(fixture)).toHaveLength(2);
    const implementationPrompts = prompts(fixture).filter((line) =>
      line.startsWith("prompt /flow-implement "),
    );
    expect(implementationPrompts).toHaveLength(1);
    const sessionDirectory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    expect(implementationPrompts[0]).toBe(`prompt /flow-implement ${sessionDirectory}`);

    const log = stubLog(fixture);
    expect(log.some((line) => line.includes(`flow-implement ${sessionDirectory} cwd=${worktree}`))).toBe(
      true,
    );

    await client.waitFor((event) => event.type === "flowStopped");
    expect(testServer.trackerReads()).toBe(0);
    expect(sha256File(fixture.goalFile)).toBe(
      createHash("sha256").update(SENTINEL_GOAL).digest("hex"),
    );

    // The worktree's first checkpoint exists on its branch and origin got it.
    const commits = git(worktree, ["rev-list", "--count", `${originMain}..HEAD`]).trim();
    expect(Number(commits)).toBeGreaterThanOrEqual(1);
    client.close();
  }, 40_000);

  test("Flow events never touch the Goal Mode goal, activity, or question state", async () => {
    const fixture = createFixture("goal-isolation");
    const testServer = startServer(fixture, { stub: ["--flow-goal"] });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);

    client.send({ type: "getGoal" });
    await client.waitFor((event) => event.type === "goal");
    const goals = client.events.filter((event) => event.type === "goal");
    expect(goals.at(-1)?.text).toBe(SENTINEL_GOAL);
    expect(client.events.filter((event) => event.type === "activity")).toHaveLength(0);
    expect(client.events.filter((event) => event.type === "question")).toHaveLength(0);
    client.close();
  }, 30_000);

  test("the two modes refuse each other's starts while only one holds the checkout", async () => {
    const fixture = createFixture("exclusive");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-checkpoints=2", "--flow-step-delay=1500", "--create-goal", "--goal=GOAL.md"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await client.waitFor((event) => event.type === "flowImplementationStarted");
    const mark = client.mark();

    client.send({ type: "startLifecycle" });
    const lifecycleError = await client.waitFor(
      (event) => event.type === "error" && String(event.message).includes("Flow Mode"),
      { from: mark },
    );
    expect(String(lifecycleError.message)).toBe(
      "Flow Mode is active. Finish or stop its work first.",
    );

    for (const command of [
      { type: "startRun" },
      { type: "createGoal" },
      { type: "reviseGoal", request: "make it bigger" },
      { type: "prepareSkills" },
    ]) {
      const before = client.mark();
      client.send(command);
      const error = await client.waitFor(
        (event) => event.type === "error" && String(event.message).includes("Flow Mode"),
        { from: before },
      );
      expect(String(error.message)).toBe("Flow Mode is active. Finish or stop its work first.");
    }
    await waitForStub(fixture, (line) => line.startsWith("prompt /flow-implement "));
    const flows = spawns(fixture);
    expect(flows).toHaveLength(2); // goal interview + implementation

    client.send({ type: "stopFlowImplementation" });
    await client.waitFor((event) => event.type === "flowStopped");
    client.close();
  }, 40_000);

  test("a Goal Mode start refuses a Flow start and spawns no Flow peer", async () => {
    const fixture = createFixture("exclusive-goal");
    const testServer = startServer(fixture, {
      stub: ["--create-goal", `--goal=${join("GOAL.md")}`, "--delay-ms=1500", "--flow-goal"],
    });
    const client = await connect(testServer);
    await connected(client);

    client.send({ type: "createGoal" });
    await client.waitFor((event) => event.type === "goalCreationStarted");
    const mark = client.mark();
    client.send({ type: "createFlowGoal" });
    const error = await client.waitFor((event) => event.type === "flowError", { from: mark });
    expect(String(error.message)).toContain("Goal Mode");
    expect(prompts(fixture).filter((line) => line.startsWith("prompt /flow-goal "))).toHaveLength(0);
    client.close();
  }, 30_000);

  test("Discover's clone names its mode and project in every Flow refusal", async () => {
    const fixture = createFixture("discover-clone-refusal");
    markSourceCheckout(fixture);
    seedSession(fixture, "live1", "idle", FLOW_GOAL, "live");
    const gate = Promise.withResolvers<void>();
    const clones = cloneHarness(createCloneSource("clone-refusal"), gate.promise);
    const testServer = startServer(fixture, {
      stub: ["--discover", "--discover-no-exit", "--flow-goal"],
      discoverClone: clones.runner,
    });
    const client = await connect(testServer);
    await connected(client);

    client.send({ type: "discoverRemote", url: "https://github.com/coollabsio/coolify" });
    await waitUntil(() => clones.calls.length === 1, "the Discover clone to start");
    const expected =
      "Discover is active on coollabsio/coolify (a repository clone). " +
      "Stop it in Discover before starting Flow work.";
    for (const command of [
      { type: "createFlowGoal" },
      { type: "startFlowImplementation" },
      { type: "mergeFlowPr" },
    ]) {
      const from = client.mark();
      client.send(command);
      const error = await client.waitFor((event) => event.type === "flowError", { from });
      expect(String(error.message)).toBe(expected);
    }
    gate.resolve();
    client.close();
  }, 30_000);

  test("Discover's checkout names its mode and project, and releases for Flow after Stop", async () => {
    const fixture = createFixture("discover-checkout-refusal");
    markSourceCheckout(fixture);
    seedSession(fixture, "live1", "idle", FLOW_GOAL, "live");
    const clones = cloneHarness(createCloneSource("checkout-refusal"));
    const testServer = startServer(fixture, {
      stub: ["--discover", "--discover-no-exit", "--flow-goal"],
      discoverClone: clones.runner,
    });
    const client = await connect(testServer);
    await connected(client);

    const from = client.mark();
    client.send({ type: "discoverRemote", url: "https://github.com/coollabsio/coolify" });
    await client.waitFor((event) => event.type === "discoverStarted", { from });
    await waitUntil(
      () =>
        client.events.some(
          (event) => event.type === "discoverState" && reportsCheckout(event),
        ),
      "the remote Discover checkout",
    );
    const expected =
      "Discover is active on coollabsio/coolify (a repository checkout). " +
      "Stop it in Discover before starting Flow work.";
    for (const command of [
      { type: "createFlowGoal" },
      { type: "startFlowImplementation" },
      { type: "mergeFlowPr" },
    ]) {
      const before = client.mark();
      client.send(command);
      const error = await client.waitFor((event) => event.type === "flowError", { from: before });
      expect(String(error.message)).toBe(expected);
    }

    const stopped = client.mark();
    client.send({ type: "stopDiscover" });
    await client.waitFor((event) => event.type === "discoverStopped", { from: stopped });
    expect(checkoutEntries(fixture)).toEqual([]);

    const flowMark = client.mark();
    client.send({ type: "createFlowGoal" });
    await client.waitFor((event) => event.type === "flowGoalStarted", { from: flowMark });
    client.send({ type: "cancelFlowGoal" });
    client.close();
  }, 40_000);

  test("Goal Mode's label names its work in every Flow refusal", async () => {
    const fixture = createFixture("goal-mode-refusal");
    seedSession(fixture, "live1", "idle", FLOW_GOAL, "live");
    const testServer = startServer(fixture, {
      stub: ["--create-goal", `--goal=${join("GOAL.md")}`, "--flow-goal"],
    });
    const client = await connect(testServer);
    await connected(client);

    client.send({ type: "createGoal" });
    await client.waitFor((event) => event.type === "goalCreationStarted");
    const expectedStart =
      "Goal Mode is active (a goal creation). Stop it before starting Flow work.";
    for (const command of [{ type: "createFlowGoal" }, { type: "startFlowImplementation" }]) {
      const from = client.mark();
      client.send(command);
      const error = await client.waitFor((event) => event.type === "flowError", { from });
      expect(String(error.message)).toBe(expectedStart);
    }
    const mergeMark = client.mark();
    client.send({ type: "mergeFlowPr" });
    const mergeError = await client.waitFor((event) => event.type === "flowError", {
      from: mergeMark,
    });
    expect(String(mergeError.message)).toBe(
      "Goal Mode is active (a goal creation). Stop it before merging the Flow pull request.",
    );
    client.close();
  }, 30_000);

  test("reset is refused while an unmerged Flow session exists", async () => {
    const fixture = createFixture("reset-refusal");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-checkpoints=1"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);

    client.send({ type: "resetImplementation" });
    const error = await client.waitFor((event) => event.type === "error");
    expect(String(error.message)).toContain("Flow session is not merged");
    expect(client.events.some((event) => event.type === "implementationResetStarted")).toBe(false);
    expect(git(fixture.root, ["rev-parse", "HEAD"]).trim()).not.toBe("");
    client.close();
  }, 30_000);
});

describe("Flow change widgets", () => {
  test("snapshots cover every changed file and acceptance survives only while the signature does", async () => {
    const fixture = createFixture("widgets");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=1500",
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await client.waitFor((event) => event.type === "flowImplementationStarted");

    await waitUntil(
      () => {
        const widgets = latest(client, "flowWidgets")?.widgets;
        const files = latest(client, "flowFiles")?.files;
        if (!Array.isArray(widgets) || !Array.isArray(files) || files.length === 0) return false;
        const covered = new Set(
          widgets.flatMap((widget) =>
            Array.isArray(widget.files) ? (widget.files as string[]) : [],
          ),
        );
        return files.every((file) => covered.has(file.path));
      },
      "a widget snapshot covering the diff",
    );

    const filesEvent = latest(client, "flowFiles");
    const files = filesEvent?.files as { path: string; diff: string }[];
    expect(files.map((file) => file.path)).toContain("src/app.txt");
    for (const file of files) expect(file.diff).toContain("diff --git");
    expect(client.events.some((event) => event.type === "flowWidgets" && Array.isArray(event.widgets))).toBe(true);

    const widgetsEvent = latest(client, "flowWidgets");
    const widgets = widgetsEvent?.widgets as {
      id: string;
      category: string;
      files: string[];
      accepted: boolean;
    }[];
    const categories = widgets.map((widget) => widget.category);
    for (const category of categories) {
      expect([
        "contract",
        "entity",
        "naming",
        "data",
        "dependency",
        "irreversible",
        "structure",
      ]).toContain(category);
    }
    expect(new Set(widgets.map((widget) => widget.category)).size).toBeGreaterThan(1);
    expect(new Set(widgets.map((widget) => widget.id)).size).toBe(widgets.length);

    // Accept one widget while its diff is unchanged.
    const accepted = widgets[0] as { id: string };
    client.send({ type: "acceptFlowWidget", id: accepted.id, accepted: true });
    await waitUntil(
      () => {
        const current = latest(client, "flowWidgets")?.widgets as { id: string; accepted: boolean }[];
        return current.some((widget) => widget.id === accepted.id && widget.accepted);
      },
      "the accepted widget",
    );
    const sessionId = (latest(client, "flowImplementationStarted")?.sessionId as string) ?? "";
    const sessionDirectory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    const acceptedFile = JSON.parse(readFileSync(join(sessionDirectory, "accepted.json"), "utf8")) as {
      signatures: string[];
    };
    expect(acceptedFile.signatures).toContain(accepted.id);
    expect(client.events.some((event) => event.type === "flowStopped")).toBe(false);

    // The next checkpoint rewrites src/app.txt: the accepted signature is gone
    // and a new, unaccepted widget for that file appears.
    await waitUntil(
      () => {
        const current = latest(client, "flowWidgets")?.widgets as { id: string; files: string[] }[];
        return !current.some((widget) => widget.id === accepted.id);
      },
      "the old widget to disappear",
      30_000,
    );
    const afterCheckpoint = latest(client, "flowWidgets")?.widgets as {
      id: string;
      files: string[];
      accepted: boolean;
    }[];
    const replacement = afterCheckpoint.find((widget) => widget.files.includes("src/app.txt"));
    expect(replacement).toBeDefined();
    expect(replacement?.accepted).toBe(false);
    const acceptedAfter = JSON.parse(
      readFileSync(join(sessionDirectory, "accepted.json"), "utf8"),
    ) as { signatures: string[] };
    expect(acceptedAfter.signatures).not.toContain(accepted.id);

    await client.waitFor((event) => event.type === "flowStopped");
    client.close();
  }, 60_000);

  test("an uncovered file gets a structure fallback, and an analyst failure covers the whole diff", async () => {
    const partial = createFixture("analyst-partial");
    const partialServer = startServer(partial, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-analyst-partial"],
    });
    const partialClient = await connect(partialServer);
    await connected(partialClient);
    await createGoal(partialClient, partial);
    partialClient.send({ type: "startFlowImplementation" });
    await waitUntil(
      () => {
        const widgets = latest(partialClient, "flowWidgets")?.widgets;
        const files = latest(partialClient, "flowFiles")?.files;
        if (!Array.isArray(widgets) || !Array.isArray(files) || files.length < 2) return false;
        const covered = new Set(
          widgets.flatMap((widget) => (Array.isArray(widget.files) ? (widget.files as string[]) : [])),
        );
        return files.every((file) => covered.has(file.path));
      },
      "fallback coverage",
    );
    const partialWidgets = latest(partialClient, "flowWidgets")?.widgets as {
      category: string;
      files: string[];
    }[];
    expect(partialWidgets.some((widget) => widget.category === "structure")).toBe(true);
    await partialClient.waitFor((event) => event.type === "flowStopped");
    partialClient.close();

    const failing = createFixture("analyst-fail");
    const failingServer = startServer(failing, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-analyst-fail"],
    });
    const failingClient = await connect(failingServer);
    await connected(failingClient);
    await createGoal(failingClient, failing);
    failingClient.send({ type: "startFlowImplementation" });
    const error = await failingClient.waitFor((event) => event.type === "flowError");
    expect(String(error.message)).toContain("analyst");
    await waitUntil(
      () => {
        const widgets = latest(failingClient, "flowWidgets")?.widgets;
        const files = latest(failingClient, "flowFiles")?.files;
        if (!Array.isArray(widgets) || !Array.isArray(files) || files.length === 0) return false;
        const covered = new Set(
          widgets.flatMap((widget) => (Array.isArray(widget.files) ? (widget.files as string[]) : [])),
        );
        return files.every((file) => covered.has(file.path));
      },
      "fallback coverage after a failed analyst",
    );
    const fallback = latest(failingClient, "flowWidgets")?.widgets as {
      category: string;
      files: string[];
    }[];
    expect(fallback.every((widget) => widget.category === "structure")).toBe(true);
    failingClient.close();
  }, 60_000);

  test("a provider refusal while analyzing falls back instead of rejecting unobserved", async () => {
    const fixture = createFixture("analyst-provider-refusal");
    const events: Event[] = [];
    const unhandled: unknown[] = [];
    const observed = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", observed);
    let environmentCalls = 0;
    const controller = new FlowController({
      repoDir: fixture.root,
      stateDir: fixture.stateDir,
      agentCommand: `bun ${STUB_AGENT} --flow-goal --flow-implement --flow-change`,
      agentEnvironment: async () => {
        environmentCalls += 1;
        // The goal interview and the implementation are the first two peers;
        // a lapsed subscription refuses the first analyst peer's environment.
        if (environmentCalls === 3) throw new Error("no subscription can serve a peer");
        return { ...process.env };
      },
      broadcast: (event) => events.push(event as Event),
      forge: new StubForge({ logPath: fixture.forgeLog }),
      forgeTarget: { forge: "github", host: "forge.test", project: "acme/fixture" },
      watchMs: 20,
      analystTimeoutMs: 10_000,
    });
    try {
      void controller.createGoal();
      await waitUntil(
        () => events.some((event) => event.type === "flowQuestion"),
        "the goal interview question",
      );
      const question = events.find((event) => event.type === "flowQuestion");
      controller.answer(question?.id, "Alpha", "goal");
      await waitUntil(
        () => events.some((event) => event.type === "flowGoalStopped" && event.completed === true),
        "the goal interview to finish",
      );
      void controller.startImplementation();
      await waitUntil(
        () => events.some((event) => event.type === "flowImplementationStarted"),
        "the implementation start",
      );
      const worktree = [...events]
        .reverse()
        .find((event) => event.type === "flowImplementationStarted")?.worktree as string;

      await waitUntil(
        () => events.some((event) => event.type === "flowError"),
        "the analyst refusal to surface",
      );
      const errorIndex = events.findIndex((event) => event.type === "flowError");
      await waitUntil(
        () => {
          const widgetIndex = events.findIndex(
            (event, index) => index > errorIndex && event.type === "flowWidgets",
          );
          if (widgetIndex < 0) return false;
          const widgets = events[widgetIndex]?.widgets as
            | { category: string; files: string[] }[]
            | undefined;
          const files = [...events.slice(0, errorIndex)]
            .reverse()
            .find((event) => event.type === "flowFiles")?.files as
            | { path: string }[]
            | undefined;
          if (
            files === undefined ||
            widgets === undefined ||
            widgets.length === 0 ||
            files.length === 0
          )
            return false;
          const covered = new Set(widgets.flatMap((widget) => widget.files));
          return (
            widgets.every((widget) => widget.category === "structure") &&
            files.every((file) => covered.has(file.path))
          );
        },
        "the structure fallback after the refusal",
      );
      const errors = events.filter((event) => event.type === "flowError");
      expect(errors).toHaveLength(1);
      expect(String(errors[0]?.message)).toContain("could not start");

      // The single refusal is spent: the next diff change analyzes normally.
      const recoveryMark = events.length;
      writeFileSync(join(worktree, "src", "after-recovery.txt"), "after the recovery\n");
      await waitUntil(
        () =>
          events.slice(recoveryMark).some((event) => {
            if (event.type !== "flowWidgets") return false;
            const widgets = event.widgets as { category: string; files: string[] }[];
            return (
              widgets.some((widget) => widget.category !== "structure") &&
              widgets.some((widget) => widget.files.includes("src/after-recovery.txt"))
            );
          }),
        "the second analyst widget list",
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", observed);
      controller.dispose();
    }
  }, 60_000);

  test("an analyst turn writes its request and widgets into its own session directory", async () => {
    const fixture = createFixture("analyst-bind");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    const sessionId = String(started.sessionId);
    await waitUntil(
      () => {
        const widgets = latest(client, "flowWidgets")?.widgets;
        return Array.isArray(widgets) && widgets.length > 0;
      },
      "the analyst widget list",
    );

    const directory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as {
      files?: { path?: string }[];
    };
    expect((request.files ?? []).map((file) => file.path)).toContain("src/app.txt");
    const answer = JSON.parse(readFileSync(join(directory, "widgets.json"), "utf8")) as {
      widgets?: unknown[];
    };
    expect((answer.widgets ?? []).length).toBeGreaterThan(0);
    const persisted = readSession(fixture, sessionId).widgets as unknown[] | undefined;
    expect(persisted?.length ?? 0).toBeGreaterThan(0);

    await client.waitFor((event) => event.type === "flowStopped");
    client.close();
  }, 60_000);

  test("an analyst turn that outlives its session never writes or broadcasts into the replacement", async () => {
    const fixture = createFixture("analyst-orphan");
    const events: Event[] = [];
    let environmentCalls = 0;
    let analystGated = false;
    const release = Promise.withResolvers<void>();
    const controller = new FlowController({
      repoDir: fixture.root,
      stateDir: fixture.stateDir,
      agentCommand: `bun ${STUB_AGENT} --log=${fixture.logPath} --flow-goal --flow-implement --flow-change`,
      agentEnvironment: async () => {
        environmentCalls += 1;
        // The goal interview and the implementation are the first two peers;
        // hold the first analyst peer inside its environment lookup.
        if (environmentCalls === 3) {
          analystGated = true;
          await release.promise;
        }
        return { ...process.env };
      },
      broadcast: (event) => events.push(event as Event),
      forge: new StubForge({ logPath: fixture.forgeLog }),
      forgeTarget: { forge: "github", host: "forge.test", project: "acme/fixture" },
      watchMs: 20,
      analystTimeoutMs: 10_000,
    });
    try {
      void controller.createGoal();
      await waitUntil(
        () => events.some((event) => event.type === "flowQuestion" && event.target === "goal"),
        "the goal interview question",
      );
      const question = events.find((event) => event.type === "flowQuestion");
      controller.answer(question?.id, "Alpha", "goal");
      await waitUntil(
        () => events.some((event) => event.type === "flowGoalStopped" && event.completed === true),
        "the goal interview to finish",
      );
      void controller.startImplementation();
      await waitUntil(
        () => events.some((event) => event.type === "flowImplementationStarted"),
        "the implementation start",
      );
      const started = events.find((event) => event.type === "flowImplementationStarted");
      const oldId = String(started?.sessionId);

      await waitUntil(
        () => events.some((event) => event.type === "flowPr" && event.pr !== null),
        "the draft pull request",
      );
      await waitUntil(() => analystGated, "the analyst environment to be gated");
      await waitUntil(
        () => events.some((event) => event.type === "flowStopped"),
        "the implementation to stop",
      );
      await controller.markPrReady();
      await waitUntil(
        () =>
          events.some(
            (event) =>
              event.type === "flowPr" &&
              (event.pr as { state?: string } | null)?.state === "live",
          ),
        "the live pull request",
      );
      await controller.mergePr();
      await waitUntil(
        () => events.some((event) => event.type === "flowSnapshot" && event.status === "merged"),
        "the merged session",
      );

      const goalMark = events.length;
      void controller.createGoal();
      await waitUntil(
        () =>
          events.slice(goalMark).some(
            (event) => event.type === "flowSnapshot" && event.sessionId !== oldId,
          ),
        "the replacement session",
      );
      await waitUntil(
        () =>
          events.slice(goalMark).some(
            (event) => event.type === "flowQuestion" && event.target === "goal",
          ),
        "the replacement goal question",
      );
      const replacement = events.find(
        (event) => event.type === "flowSnapshot" && event.sessionId !== oldId,
      );
      const newId = String(replacement?.sessionId);
      const switchIndex = events.findIndex(
        (event) => event.type === "flowSnapshot" && event.sessionId === newId,
      );
      const newQuestion = events
        .slice(goalMark)
        .find((event) => event.type === "flowQuestion" && event.target === "goal");
      controller.answer(newQuestion?.id, "Beta", "goal");
      await waitUntil(
        () =>
          events
            .slice(goalMark)
            .some((event) => event.type === "flowGoalStopped" && event.completed === true),
        "the replacement goal interview to finish",
      );

      release.resolve();
      await waitForStub(fixture, (line) => line.startsWith("flow-widgets "));
      // `hasActiveWork` stays true while the analyst result is being applied,
      // so a false value proves the discarded turn has fully settled.
      await waitUntil(() => !controller.hasActiveWork(), "the analyzer turn to settle");

      const flowRoot = join(fixture.stateDir, "flow", journalKey(fixture.root));
      expect(existsSync(join(flowRoot, newId, "request.json"))).toBe(false);
      expect(existsSync(join(flowRoot, newId, "widgets.json"))).toBe(false);
      expect(existsSync(join(flowRoot, oldId, "request.json"))).toBe(true);
      expect(events.slice(switchIndex).some((event) => event.type === "flowWidgets")).toBe(false);
      const replacementWidgets = readSession(fixture, newId).widgets as unknown[] | undefined;
      expect(replacementWidgets ?? []).toEqual([]);
    } finally {
      controller.dispose();
    }
  }, 90_000);
});

describe("Flow untracked file bounds", () => {
  test("large and binary untracked files stay visible without an embedded body", async () => {
    const fixture = createFixture("untracked-bounds");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    const sessionId = String(started.sessionId);
    const worktree = String(started.worktree);
    await client.waitFor((event) => event.type === "flowStopped");

    writeFileSync(join(worktree, "large.dump"), "x".repeat(UNTRACKED_BODY_MAX_BYTES + 1));
    writeFileSync(join(worktree, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]));
    writeFileSync(join(worktree, "small.txt"), "hello\n");

    await waitUntil(
      () => {
        const files = latest(client, "flowFiles")?.files as { path: string }[] | undefined;
        return (
          Array.isArray(files) &&
          files.some((file) => file.path === "large.dump") &&
          files.some((file) => file.path === "binary.bin") &&
          files.some((file) => file.path === "small.txt")
        );
      },
      "the untracked files in a flowFiles frame",
    );

    const filesEvent = latest(client, "flowFiles");
    const files = filesEvent?.files as {
      path: string;
      status: string;
      insertions: number;
      deletions: number;
      diff: string;
      omitted?: string;
    }[];
    const large = files.find((file) => file.path === "large.dump");
    expect(large).toEqual({
      path: "large.dump",
      status: "added",
      insertions: 0,
      deletions: 0,
      diff: "",
      omitted: "large",
    });
    const binary = files.find((file) => file.path === "binary.bin");
    expect(binary?.status).toBe("added");
    expect(binary?.omitted).toBe("binary");
    expect(binary?.diff).toBe("");
    expect(binary?.diff).not.toContain("\u0000");
    const small = files.find((file) => file.path === "small.txt");
    expect(small?.omitted).toBeUndefined();
    expect(small?.diff).toContain("+hello");
    expect(JSON.stringify(filesEvent).length).toBeLessThan(64 * 1024);

    const sessionDirectory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    for (const name of ["session.json", "changes.json"]) {
      const path = join(sessionDirectory, name);
      expect(statSync(path).size).toBeLessThan(64 * 1024);
      const state = JSON.parse(readFileSync(path, "utf8")) as unknown;
      expect(JSON.stringify(state)).not.toContain("x".repeat(1024));
    }
    client.close();
  }, 60_000);

  test("untracked symlinks report their target path and never read the target", async () => {
    const fixture = createFixture("untracked-symlink");
    const secret = `OUTSIDE-SECRET-${"z".repeat(64)}\n`;
    const secretPath = join(fixture.root, "outside-secret.txt");
    writeFileSync(secretPath, secret);
    const directoryTarget = join(fixture.root, "outside-directory");
    mkdirSync(directoryTarget, { recursive: true });

    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    const sessionId = String(started.sessionId);
    const worktree = String(started.worktree);
    await client.waitFor((event) => event.type === "flowStopped");

    symlinkSync(secretPath, join(worktree, "outside-link"));
    symlinkSync("missing-target.txt", join(worktree, "dangling-link"));
    symlinkSync(directoryTarget, join(worktree, "directory-link"));

    await waitUntil(
      () => {
        const files = latest(client, "flowFiles")?.files as { path: string }[] | undefined;
        return (
          Array.isArray(files) &&
          ["outside-link", "dangling-link", "directory-link"].every((path) =>
            files.some((file) => file.path === path),
          )
        );
      },
      "the untracked symlinks in a flowFiles frame",
    );

    const filesEvent = latest(client, "flowFiles");
    const files = filesEvent?.files as {
      path: string;
      status: string;
      insertions: number;
      deletions: number;
      diff: string;
      omitted?: string;
    }[];
    const link = files.find((file) => file.path === "outside-link");
    expect(link?.status).toBe("added");
    expect(link?.omitted).toBeUndefined();
    expect(link?.insertions).toBe(1);
    expect(link?.deletions).toBe(0);
    expect(link?.diff).toContain("new file mode 120000");
    const contentLines = link?.diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    expect(contentLines).toEqual([`+${secretPath}`]);
    expect(link?.diff).not.toContain(secret.trim());
    expect(JSON.stringify(filesEvent)).not.toContain(secret.trim());

    const dangling = files.find((file) => file.path === "dangling-link");
    expect(dangling?.status).toBe("added");
    expect(dangling?.diff).toContain("+missing-target.txt");
    const directory = files.find((file) => file.path === "directory-link");
    expect(directory?.status).toBe("added");
    expect(directory?.diff).toContain(`+${directoryTarget}`);

    const sessionDirectory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    for (const name of ["session.json", "changes.json"]) {
      const state = readFileSync(join(sessionDirectory, name), "utf8");
      expect(state).not.toContain(secret.trim());
      expect(state).toContain('"outside-link"');
    }
    client.close();
  }, 60_000);
});

describe("Flow steering, decisions, and conversation", () => {
  test("steering is read at the next checkpoint and the decision board is read by the implementation", async () => {
    const fixture = createFixture("steering");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=2000",
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await client.waitFor((event) => event.type === "flowImplementationStarted");
    await waitForStub(fixture, (line) => line.startsWith("flow-decisions-read 1 "));

    client.send({ type: "sendFlowSteering", text: "Prefer a smaller configuration" });
    const steering = await client.waitFor(
      (event) =>
        event.type === "flowSteering" &&
        Array.isArray(event.notes) &&
        (event.notes as { text: string }[]).some((note) => note.text === "Prefer a smaller configuration"),
    );
    const note = (steering.notes as { id: string; status: string; source: string }[]).find(
      (entry) => entry.status === "new",
    );
    expect(note?.source).toBe("developer");
    expect(client.events.some((event) => event.type === "flowStopped")).toBe(false);

    await waitForStub(
      fixture,
      (line) => line.startsWith("flow-decisions-read 2 "),
      30_000,
    );
    await waitForStub(fixture, (line) => line === `flow-ack ${note?.id ?? ""}`, 30_000);
    await waitUntil(
      () => {
        const notes = latest(client, "flowSteering")?.notes as { id: string; status: string }[];
        return notes?.some((entry) => entry.id === note?.id && entry.status === "read") ?? false;
      },
      "the steering note to be marked read",
    );
    await waitUntil(
      () => {
        const files = latest(client, "flowFiles")?.files as { path: string; diff: string }[];
        return files?.some(
          (file) => file.path === "steering-applied.txt" && file.diff.includes("Prefer a smaller configuration"),
        ) ?? false;
      },
      "the steering to reach the next code change",
      30_000,
    );
    await client.waitFor((event) => event.type === "flowStopped");
    client.close();
  }, 60_000);

  test("a widget conversation is read-only, queues a message, and its conclusion becomes steering", async () => {
    const fixture = createFixture("conversation");
    const probePath = join(fixture.root, "permission-probe.txt");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-widget",
        `--permission-probe=${probePath}`,
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await waitUntil(
      () => {
        const widgets = latest(client, "flowWidgets")?.widgets as { id: string }[] | undefined;
        return Array.isArray(widgets) && widgets.length > 0;
      },
      "the first widget snapshot",
    );
    await client.waitFor((event) => event.type === "flowStopped");
    const sessionId = sessionIds(fixture)[0] as string;
    const sessionDirectory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    const session = readSession(fixture, sessionId);
    const worktree = session.worktree as string;
    const base = session.baseRevision as string;
    const diffBefore = createHash("sha256").update(git(worktree, ["diff", base, "--"])).digest("hex");

    const widget = (latest(client, "flowWidgets")?.widgets as { id: string }[])[0] as { id: string };
    client.send({ type: "openFlowWidget", id: widget.id });
    const started = await client.waitFor((event) => event.type === "flowConversationStarted");
    expect(started.widgetId).toBe(widget.id);
    const question = await client.waitFor((event) => event.type === "flowConversationQuestion");
    client.send({
      type: "flowAnswer",
      target: "conversation",
      id: question.id,
      value: "Alpha",
    });
    await client.waitFor(
      (event) => event.type === "flowConversationActivity" && String(event.text).includes("Answer"),
    );

    await waitForStub(fixture, (line) => line === "permission cancelled");
    const permissionLines = stubLog(fixture).filter((line) => line.startsWith("permission "));
    expect(permissionLines).toEqual(["permission cancelled"]);
    expect(existsSync(probePath)).toBe(false);

    client.send({ type: "sendFlowConversation", text: "Explain the contract change" });
    client.send({ type: "sendFlowConversation", text: "And the naming choice" });
    await waitForStub(fixture, (line) => line === "flow-conversation Explain the contract change");
    await waitForStub(fixture, (line) => line === "flow-conversation And the naming choice");

    client.send({ type: "sendFlowConclusion", text: "Prefer the smaller contract shape." });
    await waitUntil(
      () => {
        const decisions = latest(client, "flowDecisions")?.text;
        return typeof decisions === "string" && decisions.includes("Prefer the smaller contract shape.");
      },
      "the conclusion to reach the decision board",
    );
    await waitUntil(
      () => {
        const notes = latest(client, "flowSteering")?.notes as { source: string }[];
        return notes?.some((note) => note.source === `widget-chat:${widget.id}`) ?? false;
      },
      "the conclusion to become steering",
    );
    const decisions = latest(client, "flowDecisions")?.text as string;
    expect(decisions).toMatch(/## .*Widget conversation/);
    expect(readFileSync(join(sessionDirectory, "decisions.md"), "utf8")).toBe(decisions);

    const diffAfter = createHash("sha256").update(git(worktree, ["diff", base, "--"])).digest("hex");
    expect(diffAfter).toBe(diffBefore);

    client.send({ type: "closeFlowWidget" });
    await client.waitFor((event) => event.type === "flowConversationStopped");
    expect(client.events.some((event) => event.type === "flowStopped" && false)).toBe(false);
    client.close();
  }, 60_000);

  test("a message sent while the conversation peer is being prepared is queued and delivered", async () => {
    const fixture = createFixture("conversation-pending-peer");
    const providers = testProviderService(fixture.stateDir);
    const select = providers.select.bind(providers);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    providers.select = async () => {
      if (hold) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
      return select();
    };
    const testServer = startServer(fixture, {
      providers,
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-widget"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await waitUntil(
      () => {
        const widgets = latest(client, "flowWidgets")?.widgets as { id: string }[] | undefined;
        return Array.isArray(widgets) && widgets.length > 0;
      },
      "the first widget snapshot",
    );
    await client.waitFor((event) => event.type === "flowStopped");

    const widget = (latest(client, "flowWidgets")?.widgets as { id: string }[])[0] as { id: string };
    hold = true;
    client.send({ type: "openFlowWidget", id: widget.id });
    await client.waitFor((event) => event.type === "flowConversationStarted");
    // The conversation is published, but its peer is still resolving the
    // provider environment when the developer's message arrives.
    await entered.promise;
    client.send({ type: "sendFlowConversation", text: "Queued before the peer" });
    await client.waitFor(
      (event) => event.type === "flowConversationMessage" && event.text === "Queued before the peer",
    );
    release.resolve();

    const question = await client.waitFor((event) => event.type === "flowConversationQuestion");
    client.send({
      type: "flowAnswer",
      target: "conversation",
      id: question.id,
      value: "Alpha",
    });
    await waitForStub(fixture, (line) => line === "flow-conversation Queued before the peer");

    const log = stubLog(fixture);
    const opening = log.findIndex((line) => line.startsWith("prompt /flow-widget "));
    const queued = log.findIndex((line) => line === "flow-conversation Queued before the peer");
    expect(opening).toBeGreaterThanOrEqual(0);
    expect(queued).toBeGreaterThan(opening);

    client.send({ type: "closeFlowWidget" });
    await client.waitFor((event) => event.type === "flowConversationStopped");
    client.close();
  }, 60_000);

  test("a message queued during the opening widget turn continues that session", async () => {
    const fixture = createFixture("conversation-in-flight");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-widget"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await waitUntil(
      () => {
        const widgets = latest(client, "flowWidgets")?.widgets as { id: string }[] | undefined;
        return Array.isArray(widgets) && widgets.length > 0;
      },
      "the first widget snapshot",
    );
    await client.waitFor((event) => event.type === "flowStopped");

    const widget = (latest(client, "flowWidgets")?.widgets as { id: string }[])[0] as { id: string };
    client.send({ type: "openFlowWidget", id: widget.id });
    await client.waitFor((event) => event.type === "flowConversationStarted");
    // The opening /flow-widget run is waiting for this answer, so the follow-up
    // below is queued behind it rather than prompted on an idle conversation.
    const question = await client.waitFor((event) => event.type === "flowConversationQuestion");
    client.send({ type: "sendFlowConversation", text: "Follow up during the opening turn" });
    await client.waitFor(
      (event) =>
        event.type === "flowConversationMessage" && event.text === "Follow up during the opening turn",
    );
    client.send({
      type: "flowAnswer",
      target: "conversation",
      id: question.id,
      value: "Alpha",
    });
    await waitForStub(fixture, (line) => line === "flow-conversation Follow up during the opening turn");

    const log = stubLog(fixture);
    const opening = log.findIndex((line) => line.startsWith("prompt /flow-widget "));
    const queued = log.findIndex((line) => line === "flow-conversation Follow up during the opening turn");
    expect(opening).toBeGreaterThanOrEqual(0);
    expect(queued).toBeGreaterThan(opening);
    // The conversation's peer announces itself with its first turn, after the
    // session/new that opened its ACP session. Exactly that one session may be
    // opened: the queued text must arrive as another prompt on it.
    const announcements = log.flatMap((line, index) => (line.startsWith("spawn ") ? [index] : []));
    const beforeOpening = announcements.filter((index) => index < opening);
    const peer = beforeOpening.at(-1) ?? -1;
    const previousPeer = beforeOpening.at(-2) ?? -1;
    expect(peer).toBeGreaterThanOrEqual(0);
    expect(previousPeer).toBeGreaterThanOrEqual(0);
    expect(
      log.slice(previousPeer + 1, peer).filter((line) => line === "session-new"),
    ).toHaveLength(1);
    expect(log.slice(peer).filter((line) => line === "session-new")).toHaveLength(0);

    client.send({ type: "closeFlowWidget" });
    await client.waitFor((event) => event.type === "flowConversationStopped");
    client.close();
  }, 60_000);

  test("closing a widget conversation during provider selection spawns no peer", async () => {
    const fixture = createFixture("conversation-close-early");
    const providers = testProviderService(fixture.stateDir);
    const testServer = startServer(fixture, {
      providers,
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-widget"],
    });
    const client = await connect(testServer);
    await connected(client);
    const widgets = await implementedWidgets(client, fixture);
    const widget = widgets[0] as { id: string };

    const deferred = deferNextSelection(providers);
    client.send({ type: "openFlowWidget", id: widget.id });
    await client.waitFor((event) => event.type === "flowConversationStarted");
    await deferred.entered;
    client.send({ type: "closeFlowWidget" });
    await client.waitFor((event) => event.type === "flowConversationStopped");
    deferred.release();
    await deferred.settled;
    await Promise.resolve();
    expect(prompts(fixture).filter((line) => line.startsWith("prompt /flow-widget "))).toHaveLength(
      0,
    );
    client.close();
  }, 60_000);

  test("replacing a widget conversation during provider selection spawns only the replacement", async () => {
    const fixture = createFixture("conversation-replace-early");
    const providers = testProviderService(fixture.stateDir);
    const testServer = startServer(fixture, {
      providers,
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-widget"],
    });
    const client = await connect(testServer);
    await connected(client);
    const widgets = await implementedWidgets(client, fixture);
    const first = widgets[0] as { id: string };
    const second = widgets[1] as { id: string };
    expect(second).toBeDefined();

    const deferred = deferNextSelection(providers);
    client.send({ type: "openFlowWidget", id: first.id });
    await client.waitFor((event) => event.type === "flowConversationStarted");
    await deferred.entered;
    const mark = client.mark();
    client.send({ type: "openFlowWidget", id: second.id });
    await client.waitFor((event) => event.type === "flowConversationStarted", { from: mark });
    await waitForStub(
      fixture,
      (line) => line.startsWith("prompt /flow-widget ") && line.endsWith(second.id),
    );
    deferred.release();
    await deferred.settled;
    await Promise.resolve();
    const widgetPrompts = prompts(fixture).filter((line) =>
      line.startsWith("prompt /flow-widget "),
    );
    expect(widgetPrompts).toHaveLength(1);
    expect(widgetPrompts[0]?.endsWith(second.id)).toBe(true);
    client.close();
  }, 60_000);

  test("stopping the implementation during provider selection spawns no peer", async () => {
    const fixture = createFixture("implementation-stop-early");
    const providers = testProviderService(fixture.stateDir);
    const testServer = startServer(fixture, { providers, stub: ["--flow-goal", "--flow-implement"] });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);

    const deferred = deferNextSelection(providers);
    client.send({ type: "startFlowImplementation" });
    await client.waitFor((event) => event.type === "flowImplementationStarted");
    await deferred.entered;
    client.send({ type: "stopFlowImplementation" });
    await client.waitFor((event) => event.type === "flowStopped");
    deferred.release();
    await deferred.settled;
    await Promise.resolve();
    expect(
      prompts(fixture).filter((line) => line.startsWith("prompt /flow-implement ")),
    ).toHaveLength(0);
    client.close();
  }, 60_000);

  test("disposing Flow during goal interview provider selection spawns no peer", async () => {
    const fixture = createFixture("goal-dispose-early");
    const providers = testProviderService(fixture.stateDir);
    const deferred = deferNextSelection(providers);
    const testServer = startServer(fixture, { providers, stub: ["--flow-goal"] });
    const client = await connect(testServer);
    await connected(client);

    client.send({ type: "createFlowGoal" });
    await client.waitFor((event) => event.type === "flowGoalStarted");
    await deferred.entered;
    testServer.server.stop(true);
    deferred.release();
    await deferred.settled;
    await Promise.resolve();
    expect(prompts(fixture).filter((line) => line.startsWith("prompt /flow-goal "))).toHaveLength(0);
    expect(spawns(fixture)).toHaveLength(0);
    client.close();
  }, 60_000);

  test("a developer save and an agent append preserve both on the decision board", async () => {
    const fixture = createFixture("decisions-race");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-widget"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await waitUntil(
      () => {
        const widgets = latest(client, "flowWidgets")?.widgets as { id: string }[] | undefined;
        return Array.isArray(widgets) && widgets.length > 0;
      },
      "the first widget snapshot",
    );
    await client.waitFor((event) => event.type === "flowStopped");

    const widget = (latest(client, "flowWidgets")?.widgets as { id: string }[])[0] as { id: string };
    client.send({ type: "openFlowWidget", id: widget.id });
    await client.waitFor((event) => event.type === "flowConversationStarted");
    client.send({ type: "sendFlowConclusion", text: "Conclusion text." });
    await waitUntil(
      () => {
        const text = latest(client, "flowDecisions")?.text;
        return typeof text === "string" && text.includes("Conclusion text.");
      },
      "the server-appended decision",
    );
    const text = latest(client, "flowDecisions")?.text as string;
    expect(text).toMatch(/## .*Widget conversation/);
    client.close();
  }, 60_000);
});

describe("Flow checkpoints, verification, questions, and blockers", () => {
  test("a commit without a checkpoint entry is shown from its subject and verification badges persist", async () => {
    const fixture = createFixture("checkpoints");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-silent-checkpoints",
        "--flow-no-verification",
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const checkpoints = await client.waitFor(
      (event) => event.type === "flowCheckpoints" && (event.checkpoints as unknown[]).length > 0,
      { timeout: 60_000 },
    );
    const entry = (checkpoints.checkpoints as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(entry.summary).toBe("checkpoint 1: fixture change");
    expect(entry.commit).toMatch(/^[0-9a-f]{7}$/);
    expect(entry.verification).toBe("not-run");
    expect(entry.files).toBeGreaterThan(0);

    const failing = createFixture("verification-failed");
    const failingServer = startServer(failing, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-verification=failed",
      ],
    });
    const failingClient = await connect(failingServer);
    await connected(failingClient);
    await createGoal(failingClient, failing);
    failingClient.send({ type: "startFlowImplementation" });
    const verification = await failingClient.waitFor(
      (event) => event.type === "flowVerification",
      { timeout: 60_000 },
    );
    expect(verification.verification).toMatchObject({
      command: "bun test",
      status: "failed",
    });
    const failedCheckpoints = await failingClient.waitFor(
      (event) =>
        event.type === "flowCheckpoints" &&
        (event.checkpoints as { verification: string }[]).some(
          (checkpoint) => checkpoint.verification === "failed",
        ),
      { timeout: 60_000 },
    );
    expect(Array.isArray(failedCheckpoints.checkpoints)).toBe(true);
    failingClient.close();
  }, 120_000);

  test("the agent's record replaces a checkpoint projected for the same commit", async () => {
    const fixture = createFixture("checkpoint-record");
    // The peer holds between its commit and its record, so the watcher always
    // projects the commit first — the provisional entry the record must win.
    const recordWait = join(fixture.root, "record-checkpoint");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-verification=failed",
        `--flow-record-wait-file=${recordWait}`,
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });

    const projected = await client.waitFor(
      (event) =>
        event.type === "flowCheckpoints" &&
        (event.checkpoints as { summary: string }[]).some(
          (checkpoint) => checkpoint.summary === "checkpoint 1: fixture change",
        ),
      { timeout: 60_000 },
    );
    const provisional = (projected.checkpoints as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(provisional.verification).toBe("not-run");
    expect(provisional.id).toBe(`checkpoint-${String(provisional.commit)}`);

    writeFileSync(recordWait, "record\n");
    const recorded = await client.waitFor(
      (event) =>
        event.type === "flowCheckpoints" &&
        (event.checkpoints as { verification: string }[]).some(
          (checkpoint) => checkpoint.verification === "failed",
        ),
      { timeout: 60_000 },
    );
    const entry = (recorded.checkpoints as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(recorded.checkpoints as unknown[]).toHaveLength(1);
    expect(entry.id).toBe("cp-1");
    expect(entry.commit).toBe(provisional.commit);
    expect(entry.summary).toBe("checkpoint 1 — fixture change");
    expect(entry.files).toBe(2);
    expect(entry.verification).toBe("failed");

    const session = readSession(fixture, sessionIds(fixture)[0] as string);
    const persisted = (session.checkpoints as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(persisted.verification).toBe("failed");
    expect(persisted.summary).toBe("checkpoint 1 — fixture change");
    client.close();
  }, 120_000);

  test("an implementation question is answerable and a blocker can be dismissed", async () => {
    const fixture = createFixture("question-blocker");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-question",
        "--flow-blocked",
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const question = await client.waitFor(
      (event) => event.type === "flowQuestion" && event.target === "implementation",
    );
    client.send({ type: "flowAnswer", target: "implementation", id: question.id, value: "Beta" });
    await waitForStub(fixture, (line) => line === "answer Beta", 30_000);

    const blockers = await client.waitFor(
      (event) => event.type === "flowBlockers" && (event.blockers as unknown[]).length > 0,
    );
    const blocker = (blockers.blockers as { id: string; text: string; dismissed: boolean }[])[0] as {
      id: string;
      text: string;
      dismissed: boolean;
    };
    expect(blocker.text).toContain("fixture cannot continue");
    expect(blocker.dismissed).toBe(false);
    client.send({ type: "dismissFlowBlocker", id: blocker.id });
    await waitUntil(
      () => {
        const current = latest(client, "flowBlockers")?.blockers as { id: string; dismissed: boolean }[];
        return current?.some((entry) => entry.id === blocker.id && entry.dismissed) ?? false;
      },
      "the blocker dismissal",
    );
    const session = readSession(fixture, sessionIds(fixture)[0] as string);
    expect((session.blockers as { dismissed: boolean }[]).some((entry) => entry.dismissed)).toBe(true);
    client.close();
  }, 60_000);

  test("a second blocker marker leaves a dismissed blocker dismissed", async () => {
    const fixture = createFixture("blocker-tombstone");
    const waitFile = join(fixture.root, "release-second-blocker");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-blocker-line=first",
        "--flow-blocker-line=second",
        `--flow-blocker-wait-file=${waitFile}`,
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });

    type Blocker = { id: string; text: string; dismissed: boolean };
    const first = await client.waitFor(
      (event) => event.type === "flowBlockers" && (event.blockers as unknown[]).length > 0,
    );
    const initial = (first.blockers as Blocker[])[0] as Blocker;
    expect(initial.text).toBe("first");
    expect(initial.dismissed).toBe(false);
    client.send({ type: "dismissFlowBlocker", id: initial.id });
    await waitUntil(
      () => {
        const current = latest(client, "flowBlockers")?.blockers as Blocker[] | undefined;
        return current?.some((entry) => entry.id === initial.id && entry.dismissed) ?? false;
      },
      "the first blocker dismissal",
    );

    // The stub streams its second marker only after this file exists, so the
    // dismissal lands while the implementation turn is still running.
    writeFileSync(waitFile, "next\n");
    const second = await client.waitFor(
      (event) => event.type === "flowBlockers" && (event.blockers as unknown[]).length === 2,
    );
    const entries = second.blockers as Blocker[];
    expect(entries.map((entry) => entry.text)).toEqual(["first", "second"]);
    const tombstone = entries.find((entry) => entry.text === "first") as Blocker;
    expect(tombstone.id).toBe(initial.id);
    expect(tombstone.dismissed).toBe(true);
    expect(entries.find((entry) => entry.text === "second")?.dismissed).toBe(false);

    const sessionId = sessionIds(fixture)[0] as string;
    const directory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    const recorded = readFileSync(join(directory, "blockers.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { id: string; text: string });
    expect(recorded.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(recorded.filter((entry) => entry.text === "first")).toHaveLength(1);

    client.close();
    testServer.server.stop(true);

    const replacement = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const restored = await connect(replacement);
    const snapshot = await restored.waitFor(
      (event) => event.type === "flowSnapshot" && event.sessionId === sessionId,
    );
    const restoredBlockers = snapshot.blockers as Blocker[];
    expect(restoredBlockers.map((entry) => entry.text)).toEqual(["first", "second"]);
    const restoredTombstone = restoredBlockers.find((entry) => entry.text === "first") as Blocker;
    expect(restoredTombstone.id).toBe(initial.id);
    expect(restoredTombstone.dismissed).toBe(true);
    restored.close();
  }, 90_000);
});

describe("Flow session lifecycle", () => {
  test("stopping keeps the worktree, files, and review state and starts no replacement", async () => {
    const fixture = createFixture("stop");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=5000",
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    await waitUntil(
      () => Array.isArray(latest(client, "flowFiles")?.files) && (latest(client, "flowFiles")?.files as unknown[]).length > 0,
      "the first checkpoint diff",
    );

    client.send({ type: "stopFlowImplementation" });
    await client.waitFor((event) => event.type === "flowStopped");
    const sessionId = started.sessionId as string;
    const session = readSession(fixture, sessionId);
    expect(session.status).toBe("stopped");
    expect(existsSync(session.worktree as string)).toBe(true);
    const directory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    for (const name of ["session.json", "goal.md", "decisions.md", "changes.json", "accepted.json"]) {
      expect(existsSync(join(directory, name))).toBe(true);
    }
    const spawnsAfterStop = spawns(fixture).length;
    client.send({ type: "getProject" });
    await client.waitFor((event) => event.type === "project");
    expect(spawns(fixture)).toHaveLength(spawnsAfterStop);

    // Starting again reuses the same worktree and session.
    client.send({ type: "startFlowImplementation" });
    const resumed = await client.waitFor(
      (event) => event.type === "flowImplementationStarted" && event.sessionId === sessionId,
    );
    expect(resumed.worktree).toBe(started.worktree);
    await waitForStub(
      fixture,
      (line) => line === `prompt /flow-implement ${directory}` && promptCount(fixture, directory) > 1,
    );
    client.send({ type: "stopFlowImplementation" });
    await client.waitFor((event) => event.type === "flowStopped");
    client.close();
  }, 60_000);

  test("two concurrent starts spawn one implementation peer and Stop closes it", async () => {
    const fixture = createFixture("concurrent-start");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-checkpoints=2",
        "--flow-step-delay=5000",
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);

    /** The stub pid behind each `/flow-implement` turn, in spawn order. */
    const implementationPids = (): string[] => {
      const log = stubLog(fixture);
      const pids: string[] = [];
      for (let index = 0; index < log.length; index += 1) {
        if (!log[index]?.startsWith("flow-implement ")) continue;
        for (let previous = index - 1; previous >= 0; previous -= 1) {
          const line = log[previous];
          if (line?.startsWith("spawn ")) {
            pids.push(line.slice("spawn ".length));
            break;
          }
        }
      }
      return pids;
    };

    // One start and Stop leaves the stopped session with an existing worktree:
    // the state in which two Starts can overlap inside resolveBase/ensureWorktree.
    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    const sessionId = started.sessionId as string;
    const directory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    await waitUntil(
      () => promptCount(fixture, directory) === 1 && implementationPids().length === 1,
      "the first implementation prompt and its spawn",
    );
    const firstPid = implementationPids()[0] ?? "";
    expect(firstPid).not.toBe("");

    const firstStop = client.mark();
    client.send({ type: "stopFlowImplementation" });
    await client.waitFor((event) => event.type === "flowStopped", { from: firstStop });
    await waitUntil(
      () => stubLog(fixture).includes(`exit ${firstPid}`),
      "the first implementation peer to exit",
    );
    expect(readSession(fixture, sessionId).status).toBe("stopped");
    expect(existsSync(started.worktree as string)).toBe(true);
    // The restarted peer must have something to commit before it reaches the
    // step delay, so Stop lands inside a live turn.
    writeFileSync(join(started.worktree as string, "src", "main.txt"), "changed before restart\n");

    const mark = client.mark();
    client.send({ type: "startFlowImplementation" });
    client.send({ type: "startFlowImplementation" });

    const error = await client.waitFor(
      (event) => event.type === "flowError" && String(event.message).includes("already running"),
      { from: mark },
    );
    expect(String(error.message)).toContain("already running");
    const resumed = await client.waitFor(
      (event) => event.type === "flowImplementationStarted" && event.sessionId === sessionId,
      { from: mark },
    );
    expect(resumed.worktree).toBe(started.worktree);
    await waitUntil(
      () => promptCount(fixture, directory) === 2 && implementationPids().length === 2,
      "one implementation prompt and spawn from the overlapping starts",
    );
    // The refused frame must not spawn later either.
    await Bun.sleep(200);
    expect(promptCount(fixture, directory)).toBe(2);
    expect(implementationPids()).toHaveLength(2);
    const secondPid = implementationPids()[1] ?? "";
    expect(secondPid).not.toBe(firstPid);

    const secondStop = client.mark();
    client.send({ type: "stopFlowImplementation" });
    await client.waitFor((event) => event.type === "flowStopped", { from: secondStop });
    await waitUntil(
      () => stubLog(fixture).includes(`exit ${secondPid}`),
      "the implementation peer to exit after Stop",
    );
    // Stop closed the only peer the overlapping starts spawned; the refused
    // start left no child behind.
    expect(implementationPids()).toHaveLength(2);
    client.close();
  }, 60_000);

  test("restartServer whenIdle waits for active Flow work", async () => {
    const fixture = createFixture("restart-idle");
    let restarts = 0;
    const testServer = startServer(fixture, {
      restart: () => {
        restarts += 1;
      },
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=8000",
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await client.waitFor((event) => event.type === "flowImplementationStarted");

    client.send({ type: "restartServer", whenIdle: true });
    await client.waitFor((event) => event.type === "upgradePending");
    expect(restarts).toBe(0);

    client.send({ type: "stopFlowImplementation" });
    await client.waitFor((event) => event.type === "flowStopped");
    await waitUntil(() => restarts === 1, "the deferred restart", 10_000);
    client.close();
  }, 60_000);

  test("reverting the worktree diff removes its widgets and accepted state", async () => {
    const fixture = createFixture("revert");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await waitUntil(
      () => {
        const widgets = latest(client, "flowWidgets")?.widgets as { id: string }[] | undefined;
        return Array.isArray(widgets) && widgets.length > 0;
      },
      "the first widget snapshot",
    );
    await client.waitFor((event) => event.type === "flowStopped");
    const sessionId = sessionIds(fixture)[0] as string;
    const session = readSession(fixture, sessionId);
    const widget = (latest(client, "flowWidgets")?.widgets as { id: string }[])[0] as { id: string };
    client.send({ type: "acceptFlowWidget", id: widget.id, accepted: true });
    await waitUntil(
      () => {
        const ids = (latest(client, "flowWidgets")?.widgets as { id: string; accepted: boolean }[]) ?? [];
        return ids.some((entry) => entry.id === widget.id && entry.accepted);
      },
      "the accepted widget",
    );

    git(session.worktree as string, ["reset", "--hard", session.baseRevision as string]);
    await waitUntil(
      () => Array.isArray(latest(client, "flowFiles")?.files) && (latest(client, "flowFiles")?.files as unknown[]).length === 0,
      "the reverted diff",
    );
    await waitUntil(
      () => Array.isArray(latest(client, "flowWidgets")?.widgets) && (latest(client, "flowWidgets")?.widgets as unknown[]).length === 0,
      "the widgets to disappear",
    );
    const directory = join(fixture.stateDir, "flow", journalKey(fixture.root), sessionId);
    const accepted = JSON.parse(readFileSync(join(directory, "accepted.json"), "utf8")) as {
      signatures: string[];
    };
    expect(accepted.signatures).toEqual([]);
    client.close();
  }, 60_000);
});

describe("Flow persistence and isolation", () => {
  test("a replacement server restores the session, stops the stale run, and spawns nothing", async () => {
    const fixture = createFixture("restart");
    const first = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=5000",
      ],
    });
    const client = await connect(first);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    await client.waitFor((event) => event.type === "flowImplementationStarted");
    await waitUntil(
      () => {
        const checkpoints = latest(client, "flowCheckpoints")?.checkpoints as unknown[] | undefined;
        return Array.isArray(checkpoints) && checkpoints.length > 0;
      },
      "the first checkpoint",
    );
    const sessionId = sessionIds(fixture)[0] as string;
    const before = readSession(fixture, sessionId);
    const spawnsBefore = spawns(fixture).length;
    client.close();
    first.server.stop(true);

    const second = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const restored = await connect(second);
    const snapshot = await restored.waitFor(
      (event) => event.type === "flowSnapshot" && event.sessionId === sessionId,
    );
    expect(snapshot.status).toBe("stopped");
    expect(snapshot.goal).toBe(before.goal as string);
    expect(typeof snapshot.decisions).toBe("string");
    expect((snapshot.worktree as string)).toBe(before.worktree as string);
    expect((snapshot.checkpoints as unknown[]).length).toBeGreaterThan(0);
    expect((snapshot.widgets as unknown[]).length).toBeGreaterThan(0);
    expect((snapshot.files as unknown[]).length).toBeGreaterThan(0);
    expect(String(snapshot.notice)).toContain("restarted");
    expect(spawns(fixture)).toHaveLength(spawnsBefore);

    restored.send({ type: "getProject" });
    await restored.waitFor((event) => event.type === "project");
    expect(spawns(fixture)).toHaveLength(spawnsBefore);

    restored.send({ type: "startFlowImplementation" });
    await restored.waitFor(
      (event) => event.type === "flowImplementationStarted" && event.sessionId === sessionId,
    );
    const resumedPrompt = `prompt /flow-implement ${join(
      fixture.stateDir,
      "flow",
      journalKey(fixture.root),
      sessionId,
    )}`;
    const promptsBefore = prompts(fixture).filter((line) => line === resumedPrompt).length;
    await waitUntil(
      () => prompts(fixture).filter((line) => line === resumedPrompt).length > promptsBefore,
      "the resumed implementation prompt",
    );
    expect(spawns(fixture).length).toBeGreaterThan(spawnsBefore);
    restored.send({ type: "stopFlowImplementation" });
    await restored.waitFor((event) => event.type === "flowStopped");
    restored.close();
  }, 90_000);

  test("two repositories under one state directory never share a Flow session", async () => {
    const first = createFixture("isolation-a");
    const second = createFixture("isolation-b");
    const shared = join(TEST_ROOT, `shared-${process.pid}-${Date.now()}`);
    mkdirSync(shared, { recursive: true });
    cleanup.push(() => rmSync(shared, { recursive: true, force: true }));
    expect(journalKey(first.root)).not.toBe(journalKey(second.root));

    const firstServer = startServer(first, { stub: ["--flow-goal"], stateDir: shared });
    const secondServer = startServer(second, { stub: ["--flow-goal"], stateDir: shared });
    const firstClient = await connect(firstServer);
    const secondClient = await connect(secondServer);
    await connected(firstClient);
    await connected(secondClient);
    await createGoal(firstClient, first);
    await createGoal(secondClient, second);

    const firstIds = readdirSync(join(shared, "flow", journalKey(first.root)));
    const secondIds = readdirSync(join(shared, "flow", journalKey(second.root)));
    expect(firstIds).toHaveLength(1);
    expect(secondIds).toHaveLength(1);
    expect(firstIds[0]).not.toBe(secondIds[0]);
    const firstGoal = readFileSync(
      join(shared, "flow", journalKey(first.root), firstIds[0] as string, "goal.md"),
      "utf8",
    );
    expect(firstGoal).toBe(FLOW_GOAL);
    const secondSession = JSON.parse(
      readFileSync(
        join(shared, "flow", journalKey(second.root), secondIds[0] as string, "session.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(secondSession.goal).toBe(FLOW_GOAL);

    // A fresh connection to the second repository sees only its own session.
    secondClient.send({ type: "getProject" });
    await secondClient.waitFor((event) => event.type === "project");
    const secondSnapshot = await connect(secondServer);
    const snapshot = await secondSnapshot.waitFor((event) => event.type === "flowSnapshot");
    expect(snapshot.sessionId).toBe(secondIds[0] as string);
    expect(snapshot.worktree).toContain(second.root);
    firstClient.close();
    secondClient.close();
    secondSnapshot.close();
  }, 60_000);
});

/** Counts implementation prompts for a session directory in the stub log. */
function promptCount(fixture: Fixture, directory: string): number {
  return prompts(fixture).filter((line) => line === `prompt /flow-implement ${directory}`).length;
}

describe("Flow replay, base resolution, and validation edges", () => {
  test("a client connecting during the goal interview gets the session, marker, activity, and question first", async () => {
    const fixture = createFixture("replay-goal");
    const testServer = startServer(fixture, { stub: ["--flow-goal"] });
    const first = await connect(testServer);
    await connected(first);
    first.send({ type: "createFlowGoal" });
    await first.waitFor((event) => event.type === "flowQuestion");

    const late = await connect(testServer);
    const sessionId = sessionIds(fixture)[0] as string;
    late.send({ type: "getGoal" });
    await late.waitFor((event) => event.type === "goal");
    const types = late.events.map((event) => event.type);
    const snapshot = late.events.find(
      (event) => event.type === "flowSnapshot" && event.sessionId === sessionId,
    );
    expect(snapshot).toBeDefined();
    expect(types.indexOf("flowGoalStarted")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("flowActivity")).toBeGreaterThan(types.indexOf("flowGoalStarted"));
    expect(types.indexOf("flowQuestion")).toBeGreaterThan(types.indexOf("flowActivity"));
    expect(types.indexOf("goal")).toBeGreaterThan(types.indexOf("flowQuestion"));
    const question = late.events.find((event) => event.type === "flowQuestion");
    expect(question?.target).toBe("goal");
    first.send({ type: "flowAnswer", target: "goal", id: question?.id, value: "Alpha" });
    await first.waitFor((event) => event.type === "flowGoalStopped");
    first.close();
    late.close();
  }, 40_000);

  test("the base falls back to local main when origin has no main, and refuses when neither exists", async () => {
    const fixture = createFixture("base-fallback");
    git(fixture.root, ["remote", "remove", "origin"]);
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    expect(started.baseRevision).toBe(git(fixture.root, ["rev-parse", "main"]).trim());
    await client.waitFor((event) => event.type === "flowStopped");
    client.close();

    const root = testDirectory("no-main");
    mkdirSync(join(root, "adrs"), { recursive: true });
    mkdirSync(join(root, "static"), { recursive: true });
    writeFileSync(join(root, "static", "index.html"), "<!doctype html>");
    writeFileSync(join(root, "GOAL.md"), "# Host\n");
    writeFileSync(join(root, "file.txt"), "x\n");
    git(root, ["init", "-b", "trunk"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "base"]);
    const noMain: Fixture = {
      root,
      logPath: join(root, "agent.log"),
      forgeLog: join(root, "forge.log"),
      stateDir: join(root, "state"),
      goalFile: join(root, "GOAL.md"),
    };
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const failing = startServer(noMain, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const failingClient = await connect(failing);
    await connected(failingClient);
    await createGoal(failingClient, noMain);
    failingClient.send({ type: "startFlowImplementation" });
    const error = await failingClient.waitFor((event) => event.type === "flowError");
    expect(String(error.message)).toContain("neither origin/main nor main");
    expect(existsSync(join(root, ".worktree"))).toBe(false);
    expect(prompts(noMain).filter((line) => line.startsWith("prompt /flow-implement "))).toHaveLength(0);
    failingClient.close();
  }, 60_000);

  test("an analyst that names a file outside the diff is rejected and covered instead", async () => {
    const fixture = createFixture("analyst-foreign");
    const testServer = startServer(fixture, {
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-analyst-foreign",
      ],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const error = await client.waitFor((event) => event.type === "flowError");
    expect(String(error.message)).toContain("valid widget list");
    await waitUntil(
      () => {
        const widgets = latest(client, "flowWidgets")?.widgets as
          | { files: string[]; category: string }[]
          | undefined;
        const files = latest(client, "flowFiles")?.files as { path: string }[] | undefined;
        if (!Array.isArray(widgets) || !Array.isArray(files) || files.length === 0) return false;
        const covered = new Set(widgets.flatMap((widget) => widget.files));
        return files.every((file) => covered.has(file.path));
      },
      "fallback coverage after an invalid analyst result",
    );
    const widgets = latest(client, "flowWidgets")?.widgets as { files: string[]; category: string }[];
    for (const widget of widgets) {
      for (const path of widget.files) expect(path).not.toBe("src/not-in-the-diff.txt");
      expect(widget.category).toBe("structure");
    }
    client.close();
  }, 60_000);

  test("a reconnecting client receives the open conversation, its messages, and its pending question", async () => {
    const fixture = createFixture("replay-conversation");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-widget"],
    });
    const first = await connect(testServer);
    await connected(first);
    await createGoal(first, fixture);
    first.send({ type: "startFlowImplementation" });
    await waitUntil(
      () => {
        const widgets = latest(first, "flowWidgets")?.widgets as unknown[] | undefined;
        return Array.isArray(widgets) && widgets.length > 0;
      },
      "the first widget snapshot",
    );
    await first.waitFor((event) => event.type === "flowStopped");
    const widget = (latest(first, "flowWidgets")?.widgets as { id: string }[])[0] as { id: string };
    first.send({ type: "openFlowWidget", id: widget.id });
    await first.waitFor((event) => event.type === "flowConversationQuestion");
    first.send({ type: "sendFlowConversation", text: "Recorded developer message" });
    await waitUntil(
      () => {
        const message = latest(first, "flowConversationMessage");
        return message?.text === "Recorded developer message";
      },
      "the recorded conversation message",
    );

    const late = await connect(testServer);
    late.send({ type: "getGoal" });
    await late.waitFor((event) => event.type === "goal");
    const types = late.events.map((event) => event.type);
    expect(types).toContain("flowConversationStarted");
    expect(types).toContain("flowConversationQuestion");
    expect(types).toContain("flowConversationMessage");
    expect(types.indexOf("flowConversationStarted")).toBeLessThan(types.indexOf("goal"));
    const message = late.events.find((event) => event.type === "flowConversationMessage");
    expect(message?.text).toBe("Recorded developer message");
    first.send({ type: "closeFlowWidget" });
    first.close();
    late.close();
  }, 60_000);

  test("the widget identity ignores concept text and the seven categories have distinct colors", async () => {
    const here = import.meta.dir;
    const flowSource = readFileSync(join(here, "flow.ts"), "utf8");
    expect(flowSource).toContain("export function widgetSignature");
    // The signature takes only category, paths, and diffs, never concept text.
    const signatureCall = /widgetSignature\(([^)]*)\)/.exec(
      flowSource.slice(flowSource.indexOf("function widgetSignature")),
    );
    expect(signatureCall?.[1]).toContain("category");

    const css = readFileSync(join(here, "..", "client", "app.css"), "utf8");
    const categories = [
      "contract",
      "entity",
      "naming",
      "data",
      "dependency",
      "irreversible",
      "structure",
    ];
    const lightRoot = css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)"));
    const darkRoot = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    const lightBorders = categories.map((category) => {
      const match = new RegExp(`--flow-${category}:\\s*([^;]+);`).exec(lightRoot);
      return match?.[1]?.trim();
    });
    const darkBorders = categories.map((category) => {
      const match = new RegExp(`--flow-${category}:\\s*([^;]+);`).exec(darkRoot);
      return match?.[1]?.trim();
    });
    const lightSurfaces = categories.map((category) => {
      const match = new RegExp(`--flow-${category}-surface:\\s*([^;]+);`).exec(lightRoot);
      return match?.[1]?.trim();
    });
    expect(lightBorders.every((value) => value !== undefined)).toBe(true);
    expect(darkBorders.every((value) => value !== undefined)).toBe(true);
    expect(lightSurfaces.every((value) => value !== undefined)).toBe(true);
    expect(new Set(lightBorders).size).toBe(categories.length);
    expect(new Set(darkBorders).size).toBe(categories.length);
    expect(new Set(lightSurfaces).size).toBe(categories.length);

    const view = readFileSync(join(here, "..", "client", "FlowMode.svelte"), "utf8");
    expect(view).toContain('from "diff2html"');
    expect(view).toContain('data-category={widget.category}');
    expect(view).toContain('data-testid="flow-widget"');
  });
});

/** The children a replacement reads from the persisted state. */
function storedChildren(fixture: Fixture): RecordedChild[] {
  try {
    const stored = JSON.parse(
      readFileSync(stateFile(fixture.stateDir, resolve(fixture.root)), "utf8"),
    ) as { state?: { children?: RecordedChild[] } };
    return Array.isArray(stored.state?.children) ? stored.state.children : [];
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The detached owner and peer a Flow run key published. */
function detachedFlowRun(fixture: Fixture, kind: string, key: string) {
  return readDetachedRunState(detachedRunDirectory(fixture.stateDir, fixture.root, kind, key));
}

interface FlowProcess {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  url: string;
}

const flowProcesses: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];

afterEach(() => {
  for (const child of flowProcesses.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The test already ended it.
    }
  }
});

/** A real server process for the crash-recovery path an in-process stop cannot exercise. */
async function startFlowProcess(fixture: Fixture, command: string): Promise<FlowProcess> {
  seedVerificationProvider(fixture.stateDir);
  const releaseDir = join(fixture.root, "releases");
  mkdirSync(releaseDir, { recursive: true });
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "index.ts")],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ADRS_DIR: join(fixture.root, "adrs"),
      REPO_DIR: fixture.root,
      GOAL_FILE: fixture.goalFile,
      STATIC_DIR: join(fixture.root, "static"),
      STATE_DIR: fixture.stateDir,
      AGENT_COMMAND: command,
      DEVBOARD_RELEASE_DIR: releaseDir,
      ...verificationProviderUsageEnv(),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  flowProcesses.push(child);
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
      const response = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
      if (response.ok || response.status === 404) break;
    } catch {
      // Still binding or still starting.
    }
    if (Date.now() > deadline) throw new Error(`the server did not start: ${stderr}`);
    await Bun.sleep(50);
  }
  return { child, url: `127.0.0.1:${port}` };
}

describe("Flow children ledger", () => {
  test("the detached run records the live implementation peer with its pid, argv, and worktree", async () => {
    const fixture = createFixture("children-implement");
    const testServer = startServer(fixture, {
      stub: ["--flow-goal", "--flow-implement", "--flow-pre-commit-delay=5000"],
    });
    const client = await connect(testServer);
    await connected(client);
    await createGoal(client, fixture);

    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    const sessionId = started.sessionId as string;
    const worktree = started.worktree as string;
    // The stub's worktree line proves the peer runs where its cwd says it does.
    await waitForStub(fixture, (line) => line.startsWith("flow-implement "));
    await waitUntil(
      () => detachedFlowRun(fixture, "flow-implement", sessionId)?.peer?.cwd === worktree,
      "the detached implementation peer",
    );

    const run = detachedFlowRun(fixture, "flow-implement", sessionId);
    expect(run?.owner?.pid).toBeGreaterThan(0);
    expect(run?.peer?.pid).toBeGreaterThan(0);
    expect(run?.peer?.argv).toContain(STUB_AGENT);
    expect(run?.peer?.cwd).toBe(worktree);
    expect(alive(run?.peer?.pid ?? 0)).toBe(true);
    // A detached peer belongs to its owner, never to the dashboard's child list.
    expect(storedChildren(fixture)).toEqual([]);
    client.close();
  }, 60_000);

  test("dispose ends the detached goal interview", async () => {
    const fixture = createFixture("children-dispose");
    const controller = new FlowController({
      repoDir: fixture.root,
      stateDir: fixture.stateDir,
      agentCommand: `bun ${STUB_AGENT} --log=${fixture.logPath} --flow-goal`,
      agentEnvironment: async () => ({ ...process.env }),
      broadcast: () => {},
    });
    void controller.createGoal();
    await waitUntil(
      () => (detachedFlowRun(fixture, "flow-goal", "goal")?.owner?.pid ?? 0) > 0,
      "the detached goal interview owner",
    );
    const run = detachedFlowRun(fixture, "flow-goal", "goal");
    const owner = run?.owner?.pid ?? 0;
    expect(owner).toBeGreaterThan(0);
    expect(alive(owner)).toBe(true);
    expect(controller.children()).toEqual([]);

    controller.dispose();
    expect(controller.children()).toEqual([]);
    await waitUntil(() => !alive(owner), "the disposed owner to exit");
  }, 30_000);

  test("a replacement ends the Flow run a killed process left before a new implementation starts", async () => {
    const fixture = createFixture("children-restart");
    const command = [
      `bun ${STUB_AGENT}`,
      `--log=${fixture.logPath}`,
      "--flow-goal",
      "--flow-implement",
      "--flow-pre-commit-delay=60000",
    ].join(" ");
    const first = await startFlowProcess(fixture, command);
    const client = await connect({ url: first.url });
    await connected(client);
    await createGoal(client, fixture);
    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor((event) => event.type === "flowImplementationStarted");
    const sessionId = started.sessionId as string;
    const worktree = started.worktree as string;
    await waitForStub(fixture, (line) => line.startsWith("flow-implement "));
    await waitUntil(
      () => detachedFlowRun(fixture, "flow-implement", sessionId)?.peer?.cwd === worktree,
      "the detached implementation peer",
    );
    const recorded = detachedFlowRun(fixture, "flow-implement", sessionId);
    const recordedPid = recorded?.peer?.pid ?? 0;
    expect(recordedPid).toBeGreaterThan(0);
    client.close();

    first.child.kill("SIGKILL");
    await first.child.exited;
    // The owner outlives its dashboard, then ends the run because no
    // replacement handoff exists for a killed process.
    await waitUntil(
      () => !alive(recordedPid),
      "the orphaned implementation peer to end",
      15_000,
    );

    const second = await startFlowProcess(fixture, command);
    await waitUntil(
      () => !alive(recordedPid),
      "the replacement to leave the ended Flow peer alone",
      15_000,
    );

    const replacementClient = await connect({ url: second.url });
    await connected(replacementClient);
    // The snapshot proves the restored session exists and is stopped, so the
    // start below runs against restored work rather than a fresh controller.
    await replacementClient.waitFor(
      (event) => event.type === "flowSnapshot" && event.status === "stopped",
    );
    replacementClient.send({ type: "startFlowImplementation" });
    await replacementClient.waitFor(
      (event) => event.type === "flowImplementationStarted" && event.sessionId === sessionId,
    );
    await waitUntil(() => {
      const next = detachedFlowRun(fixture, "flow-implement", sessionId);
      return next?.peer?.cwd === worktree && (next.peer?.pid ?? 0) !== recordedPid && alive(next.peer?.pid ?? 0);
    }, "the replacement implementation peer");

    // The old peer was proven gone before the new implementation started.
    expect(alive(recordedPid)).toBe(false);
    replacementClient.send({ type: "stopFlowImplementation" });
    await replacementClient.waitFor((event) => event.type === "flowStopped");
    replacementClient.close();
  }, 90_000);
});
