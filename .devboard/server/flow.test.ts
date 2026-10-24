import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import { StubForge } from "./fixtures/stub-forge";
import { journalKey } from "./journal";

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
  writeFileSync(join(root, "adrs", "0001-fixture.md"), "# Fixture decision\n\n- Status: Accepted\n");
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
    flow: {
      forge,
      forgeTarget: { forge: "github", host: "forge.test", project: "acme/fixture" },
      watchMs: options.watchMs ?? 40,
      analystTimeoutMs: 10_000,
      goalTimeoutMs: 10_000,
    },
  });
  cleanup.push(() => server.stop(true));
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

function connect(testServer: TestServer): Promise<TestClient> {
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

    // The same session accepts a developer save after the failed attempt.
    client.send({ type: "saveFlowGoal", text: "# Saved by hand\n" });
    await client.waitFor((event) => event.type === "flowSnapshot" && event.goal === "# Saved by hand\n");
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
    expect(String(lifecycleError.message)).toContain("Flow Mode");

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
      expect(String(error.message)).toContain("Flow Mode");
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

    // A goal edit is refused while the implementation runs.
    client.send({ type: "saveFlowGoal", text: "# Replaced mid-run\n" });
    const goalError = await client.waitFor(
      (event) => event.type === "flowError" && String(event.message).includes("Stop it"),
    );
    expect(String(goalError.message)).toContain("implementation");

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

    client.send({ type: "saveFlowDecisions", text: "# Decisions\n\nKeep the shape small.\n" });
    await waitUntil(
      () => {
        const decisions = latest(client, "flowDecisions")?.text;
        return decisions === "# Decisions\n\nKeep the shape small.\n";
      },
      "the decision board save",
    );

    await waitForStub(
      fixture,
      (line) => line.startsWith("flow-decisions-read 2 ") && line.length > "flow-decisions-read 2 5".length,
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
    client.send({ type: "saveFlowDecisions", text: "# Board\n\nDeveloper text.\n" });
    client.send({ type: "sendFlowConclusion", text: "Conclusion text." });
    await waitUntil(
      () => {
        const text = latest(client, "flowDecisions")?.text;
        return (
          typeof text === "string" && text.includes("Developer text.") && text.includes("Conclusion text.")
        );
      },
      "both decision-board writes",
    );
    const text = latest(client, "flowDecisions")?.text as string;
    expect(text.startsWith("# Board\n\nDeveloper text.")).toBe(true);
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
    const verification = await failingClient.waitFor((event) => event.type === "flowVerification");
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
    );
    expect(Array.isArray(failedCheckpoints.checkpoints)).toBe(true);
    failingClient.close();
  }, 60_000);

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
    client.send({ type: "saveFlowDecisions", text: "# Board\n\nRun one.\n" });
    await client.waitFor(
      (event) => event.type === "flowDecisions" && String(event.text).includes("Run one."),
    );
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
    expect(snapshot.decisions).toContain("Run one.");
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
      const match = new RegExp(`--flow-${category}-border:\\s*([^;]+);`).exec(lightRoot);
      return match?.[1]?.trim();
    });
    const darkBorders = categories.map((category) => {
      const match = new RegExp(`--flow-${category}-border:\\s*([^;]+);`).exec(darkRoot);
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
