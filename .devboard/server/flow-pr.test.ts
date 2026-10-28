import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import type { Exec } from "../lib/forge-auth.ts";
import { createApp } from "./app";
import { CommandFlowForge, type FlowPrAdapter, type ForgeTarget } from "./forge-pr";
import { fakeGiteaPull } from "./fixtures/fake-gitea-pull";
import { StubForge } from "./fixtures/stub-forge";
import { journalKey } from "./journal";
import { testProviderService } from "./fixtures/test-providers";

/**
 * Flow's PR/MR lifecycle: command shapes against a recording executor, and the
 * draft → live → merged flow against the injected fake forge and a real local
 * bare origin. No test contacts a real forge or pushes to the real origin.
 */

const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "flow-pr-tests");
const FLOW_GOAL = "# Flow goal\n\nMake the fixture behavior observable.";
const TARGET: ForgeTarget = { forge: "github", host: "github.com", project: "acme/project" };
const GITLAB: ForgeTarget = { forge: "gitlab", host: "gitlab.example.test", project: "group/project" };
const GITEA: ForgeTarget = {
  forge: "gitea",
  host: "localhost",
  project: "acme/fixture",
  baseUrl: "http://gitea.test",
};

mkdirSync(TEST_ROOT, { recursive: true });
const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const action of cleanup.reverse()) action();
});

function testDirectory(name: string): string {
  const directory = join(
    TEST_ROOT,
    `${name}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
  );
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
      ...args,
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.toString();
}

interface Recorded {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
}

type Responder = (command: string, args: string[]) => { stdout: string; stderr: string; code: number } | undefined;

/** An executor that records every invocation and can answer chosen commands. */
function recordingExecutor(
  responder: Responder = () => undefined,
  fallback?: Exec,
): {
  exec: Exec;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const answer = responder(command, args);
    if (answer !== undefined) return answer;
    if (fallback !== undefined) return await fallback(command, args, options);
    try {
      const child = Bun.spawn({
        cmd: [command, ...args],
        cwd: options.cwd,
        env: options.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    } catch (error) {
      return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1 };
    }
  };
  return { exec, calls };
}

const AUTH = {
  forge: "github" as const,
  host: "github.com",
  project: "acme/project",
  login: "fixture",
  token: "fixture-secret-token",
  source: "test",
  active: true,
  permission: "push" as const,
  canWrite: true,
};

function forge(responder: Responder) {
  const { exec, calls } = recordingExecutor(responder);
  const adapter = new CommandFlowForge(exec, {}, async () => AUTH);
  return { adapter, calls, exec };
}

const PR_INPUT = {
  cwd: TEST_ROOT,
  target: TARGET,
  head: "flow/abc12345",
  base: "main",
  title: "Flow goal",
  body: "## Goal\n\nGoal text\n\n## Decisions\n\nBoard",
};

function argsOf(calls: Recorded[], command: string): string[][] {
  return calls.filter((call) => call.command === command).map((call) => call.args);
}

describe("Flow forge command shapes", () => {
  test("GitHub creates a draft, updates, readies, views, and merges with a merge commit", async () => {
    const { adapter, calls } = forge((command, args) => {
      if (command !== "gh") return undefined;
      if (args[0] === "pr" && args[1] === "create") {
        return { stdout: "https://github.com/acme/project/pull/12\n", stderr: "", code: 0 };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 12,
            url: "https://github.com/acme/project/pull/12",
            state: "OPEN",
            isDraft: true,
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const created = await adapter.createDraft(PR_INPUT);
    expect(created).toEqual({
      number: 12,
      url: "https://github.com/acme/project/pull/12",
      state: "open",
      draft: true,
    });
    expect(argsOf(calls, "gh")[0]).toEqual([
      "pr",
      "create",
      "--draft",
      "--base",
      "main",
      "--head",
      "flow/abc12345",
      "--title",
      "Flow goal",
      "--body",
      PR_INPUT.body,
    ]);

    await adapter.update({ ...PR_INPUT, number: 12 });
    expect(argsOf(calls, "gh")[1]).toEqual([
      "pr",
      "edit",
      "12",
      "--title",
      "Flow goal",
      "--body",
      PR_INPUT.body,
    ]);

    await adapter.markReady(TEST_ROOT, TARGET, 12);
    expect(argsOf(calls, "gh")[2]).toEqual(["pr", "ready", "12"]);

    const state = await adapter.view(TEST_ROOT, TARGET, 12);
    expect(state.draft).toBe(true);
    expect(state.state).toBe("open");

    await adapter.merge(TEST_ROOT, TARGET, 12);
    const mergeArgs = argsOf(calls, "gh")[4];
    expect(mergeArgs).toEqual(["pr", "merge", "12", "--merge"]);
    for (const args of argsOf(calls, "gh")) {
      expect(args).not.toContain("--squash");
      expect(args).not.toContain("--rebase");
      expect(args).not.toContain("--admin");
      expect(args.join(" ")).not.toContain(AUTH.token);
    }
    for (const call of calls) expect(call.args.join(" ")).not.toContain(AUTH.token);
    const authenticated = calls.find((call) => call.command === "gh");
    expect(authenticated?.env?.GH_TOKEN).toBe(AUTH.token);
  });

  test("GitLab creates a draft MR, readies, and merges with a merge commit", async () => {
    const { adapter, calls } = forge((command, args) => {
      if (command !== "glab") return undefined;
      if (args[0] === "mr" && args[1] === "create") {
        return {
          stdout: "https://gitlab.example.test/group/project/-/merge_requests/9\n",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "mr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            iid: 9,
            web_url: "https://gitlab.example.test/group/project/-/merge_requests/9",
            state: "opened",
            draft: true,
          }),
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const created = await adapter.createDraft({ ...PR_INPUT, target: GITLAB });
    expect(created.number).toBe(9);
    expect(created.url).toContain("merge_requests/9");
    expect(created.draft).toBe(true);
    expect(argsOf(calls, "glab")[0]).toEqual([
      "mr",
      "create",
      "--draft",
      "--source-branch",
      "flow/abc12345",
      "--target-branch",
      "main",
      "--title",
      "Flow goal",
      "--description",
      PR_INPUT.body,
      "--yes",
    ]);

    await adapter.update({ ...PR_INPUT, target: GITLAB, number: 9 });
    expect(argsOf(calls, "glab")[1]).toEqual([
      "mr",
      "update",
      "9",
      "--title",
      "Flow goal",
      "--description",
      PR_INPUT.body,
    ]);

    await adapter.markReady(TEST_ROOT, GITLAB, 9);
    expect(argsOf(calls, "glab")[2]).toEqual(["mr", "update", "9", "--ready"]);

    const state = await adapter.view(TEST_ROOT, GITLAB, 9);
    expect(state).toMatchObject({ state: "open", draft: true, number: 9 });

    await adapter.merge(TEST_ROOT, GITLAB, 9);
    expect(argsOf(calls, "glab")[4]).toEqual(["mr", "merge", "9", "--merge", "--yes"]);
  });

  test("a missing write-capable account and a missing URL fail without inventing a PR", async () => {
    const { exec, calls } = recordingExecutor();
    const denied = new CommandFlowForge(exec, {}, async () => ({ error: "no write access" }));
    await expect(denied.createDraft(PR_INPUT)).rejects.toThrow("no write access");

    const silentExec = recordingExecutor(() => ({ stdout: "", stderr: "", code: 0 })).exec;
    const silent = new CommandFlowForge(silentExec, {}, async () => AUTH);
    await expect(silent.createDraft(PR_INPUT)).rejects.toThrow("no URL");
    expect(calls.some((call) => call.command === "gh" && call.args.includes("issue"))).toBe(false);
  });

  test("the remote branch deletion is a plain git push --delete", async () => {
    const { adapter, calls } = forge(() => ({ stdout: "", stderr: "", code: 0 }));
    await adapter.deleteRemoteBranch(TEST_ROOT, "flow/abc12345");
    expect(calls[0]?.command).toBe("git");
    expect(calls[0]?.args).toEqual(["push", "origin", "--delete", "flow/abc12345"]);
  });
});

interface Fixture {
  root: string;
  logPath: string;
  stateDir: string;
  goalFile: string;
}

function createFixture(name: string): Fixture {
  const root = testDirectory(name);
  mkdirSync(join(root, "adrs"), { recursive: true });
  mkdirSync(join(root, "static"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "static", "index.html"), "<!doctype html><title>Fixture</title>");
  writeFileSync(join(root, "GOAL.md"), "# Host goal\n\nKeep me.\n");
  writeFileSync(join(root, "adrs", "0001-fixture.md"), "# Fixture decision\n");
  writeFileSync(
    join(root, ".gitignore"),
    [".worktree/", "node_modules/", "state/", "origin.git/", "*.log", ""].join("\n"),
  );
  writeFileSync(join(root, "src", "main.txt"), "base\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "chore: fixture base"]);
  git(root, ["init", "--bare", join(root, "origin.git")]);
  // A bare repository's HEAD defaults to the machine's init.defaultBranch; the
  // fixture's clones must see main even where that default is master.
  git(join(root, "origin.git"), ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["remote", "add", "origin", join(root, "origin.git")]);
  git(root, ["push", "-u", "origin", "main"]);
  const fixture = {
    root,
    logPath: join(root, "agent.log"),
    stateDir: join(root, "state"),
    goalFile: join(root, "GOAL.md"),
  };
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return fixture;
}

interface TestServer {
  server: Server<unknown>;
  fixture: Fixture;
  forge: FlowPrAdapter;
  url: string;
  calls: Recorded[];
}

interface StartOptions {
  stub?: string[];
  forge?: FlowPrAdapter;
  exec?: Exec;
  /** `null` leaves the real origin classification in place. */
  forgeTarget?: ForgeTarget | null;
  watchMs?: number;
}

function startServer(fixture: Fixture, options: StartOptions = {}): TestServer {
  const forgeStub = options.forge ?? new StubForge({ logPath: join(fixture.root, "forge.log") });
  const recorder = recordingExecutor(() => undefined, options.exec);
  const calls = recorder.calls;
  const command = [`bun ${STUB_AGENT}`, `--log=${fixture.logPath}`, ...(options.stub ?? [])].join(" ");
  const server = createApp({
    adrDir: join(fixture.root, "adrs"),
    staticDir: join(fixture.root, "static"),
    hostname: "127.0.0.1",
    port: 0,
    repoDir: fixture.root,
    stateDir: fixture.stateDir,
    providers: testProviderService(fixture.stateDir),
    goalFile: fixture.goalFile,
    agentCommand: command,
    tracker: async () => undefined,
    trackerSettle: { attempts: 1 },
    flow: {
      forge: forgeStub,
      ...(options.forgeTarget === null
        ? {}
        : { forgeTarget: options.forgeTarget ?? TARGET }),
      exec: recorder.exec,
      watchMs: options.watchMs ?? 40,
      analystTimeoutMs: 10_000,
      goalTimeoutMs: 10_000,
    },
  });
  cleanup.push(() => server.stop(true));
  return {
    server,
    fixture,
    forge: forgeStub,
    url: `127.0.0.1:${server.port}`,
    calls,
  };
}

type Event = Record<string, unknown>;

interface TestClient {
  events: Event[];
  send(command: unknown): void;
  waitFor(predicate: (event: Event) => boolean, timeout?: number): Promise<Event>;
  close(): void;
}

function connect(testServer: TestServer): Promise<TestClient> {
  const { promise, resolve, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${testServer.url}/ws`);
  const events: Event[] = [];
  const waiters: {
    predicate: (event: Event) => boolean;
    resolve: (event: Event) => void;
    reject: (error: Error) => void;
    timer: Timer;
  }[] = [];

  socket.onopen = () => {
    resolve({
      events,
      send(command) {
        socket.send(JSON.stringify(command));
      },
      waitFor(predicate, timeout = 20_000) {
        const found = events.find(predicate);
        if (found !== undefined) return Promise.resolve(found);
        const { promise: waiting, resolve: settle, reject: fail } =
          Promise.withResolvers<Event>();
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === settle);
          if (index >= 0) waiters.splice(index, 1);
          fail(new Error(`Timed out. Saw: ${JSON.stringify(events)}`));
        }, timeout);
        waiters.push({ predicate, resolve: settle, reject: fail, timer });
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
      const candidate = events.find(waiter.predicate);
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

async function waitUntil(predicate: () => boolean, description: string, timeout = 20_000) {
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

/** The pull request's state on a `flowPr` event, without trusting its shape. */
function pullRequestState(event: Event): string | undefined {
  const pr = event.pr;
  if (typeof pr !== "object" || pr === null || !("state" in pr)) return undefined;
  return typeof pr.state === "string" ? pr.state : undefined;
}

async function waitForStub(fixture: Fixture, predicate: (line: string) => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  const read = () => {
    try {
      return readFileSync(fixture.logPath, "utf8").split("\n");
    } catch {
      return [];
    }
  };
  while (Date.now() < deadline) {
    if (read().some(predicate)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for the stub log: ${JSON.stringify(read())}`);
}

function spawnCount(fixture: Fixture): number {
  try {
    return readFileSync(fixture.logPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("spawn ")).length;
  } catch {
    return 0;
  }
}

async function createGoal(client: TestClient): Promise<void> {
  client.send({ type: "createFlowGoal" });
  const question = await client.waitFor((event) => event.type === "flowQuestion");
  client.send({ type: "flowAnswer", target: "goal", id: question.id, value: "Alpha" });
  await client.waitFor((event) => event.type === "flowGoalStopped" && event.completed === true);
}

function sessionOf(fixture: Fixture): { id: string; worktree: string; branch: string } {
  const directory = join(fixture.stateDir, "flow", journalKey(fixture.root));
  const id = readdirSyncSafe(directory)[0] as string;
  const session = JSON.parse(readFileSync(join(directory, id, "session.json"), "utf8")) as {
    worktree: string;
    branch: string;
  };
  return { id, worktree: session.worktree, branch: session.branch };
}

function readdirSyncSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/** One session's persisted machine state, or undefined while it is absent. */
function storedSession(fixture: Fixture, id: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(
      readFileSync(join(fixture.stateDir, "flow", journalKey(fixture.root), id, "session.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** A stored session's pull-request state, without trusting the blob's shape. */
function prState(stored: Record<string, unknown> | undefined): unknown {
  const pr = stored?.pr;
  if (typeof pr !== "object" || pr === null || !("state" in pr)) return undefined;
  return pr.state;
}

/** The session ids of a snapshot's history, without trusting its shape. */
function historyIds(snapshot: Event): unknown[] {
  const history = snapshot.history;
  if (!Array.isArray(history)) return [];
  return history.map((entry) =>
    typeof entry === "object" && entry !== null && "sessionId" in entry ? entry.sessionId : undefined,
  );
}

async function startFlow(
  client: TestClient,
  fixture: Fixture,
): Promise<{ id: string; worktree: string; branch: string }> {
  client.send({ type: "startFlowImplementation" });
  await client.waitFor((event) => event.type === "flowImplementationStarted");
  return sessionOf(fixture);
}

/** Ends the implementation whether it is still running or already finished. */
async function stopFlow(client: TestClient): Promise<void> {
  client.send({ type: "stopFlowImplementation" });
  await client.waitFor(
    (event) =>
      event.type === "flowStopped" ||
      (event.type === "flowError" && String(event.message).includes("not running")),
  );
}

describe("Flow pull-request lifecycle", () => {
  test("no PR exists before the first checkpoint; the first one is a draft against main", async () => {
    const fixture = createFixture("pr-draft");
    const forgeStub = new StubForge();
    const server = startServer(fixture, {
      forge: forgeStub,
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-pre-commit-delay=1200",
      ],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    client.send({ type: "saveFlowDecisions", text: "# Board\n\nKeep it small.\n" });
    await client.waitFor((event) => event.type === "flowDecisions");
    const session = await startFlow(client, fixture);

    expect(forgeStub.calls).toHaveLength(0);
    expect(forgeStub.pullRequest).toBeUndefined();
    client.send({ type: "getProject" });
    await client.waitFor((event) => event.type === "project");

    const pr = await client.waitFor((event) => event.type === "flowPr" && event.pr !== null);
    const pull = pr.pr as { state: string; number: number; url: string; forge: string };
    expect(pull.state).toBe("draft");
    expect(pull.number).toBe(7);
    expect(pull.forge).toBe("github");
    expect(pull.url).toContain("/pull/7");

    const create = forgeStub.calls.find((call) => call.op === "createDraft");
    expect(create).toBeDefined();
    const input = create?.input as { head: string; base: string; title: string; body: string };
    expect(input.head).toBe(session.branch);
    expect(input.base).toBe("main");
    expect(input.title).toBe("Flow goal");
    expect(input.body).toContain(FLOW_GOAL);
    expect(input.body).toContain("Keep it small.");
    expect(git(fixture.root, ["--git-dir", join(fixture.root, "origin.git"), "rev-parse", session.branch]).trim()).toMatch(/^[0-9a-f]{40}$/);

    const pushes = server.calls.filter((call) => call.command === "git" && call.args.includes("push"));
    for (const push of pushes) {
      expect(push.args).not.toContain("--force");
      expect(push.args).not.toContain("-f");
    }
    expect(forgeStub.calls.some((call) => /issue|epic|label|search/.test(JSON.stringify(call)))).toBe(false);
    await stopFlow(client);
    client.close();
  }, 60_000);

  test("every later checkpoint pushes without force and updates the PR", async () => {
    const fixture = createFixture("pr-updates");
    const forgeStub = new StubForge();
    const server = startServer(fixture, {
      forge: forgeStub,
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        `--flow-wait-file=${join(fixture.stateDir, "proceed")}`,
      ],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    const session = await startFlow(client, fixture);
    await client.waitFor((event) => event.type === "flowPr" && (event.pr as { state: string }).state === "draft");
    // The stub holds its second checkpoint until the first draft PR exists, so
    // the update is deterministic rather than dependent on watcher timing.
    mkdirSync(fixture.stateDir, { recursive: true });
    writeFileSync(join(fixture.stateDir, "proceed"), "second checkpoint\n");
    await waitUntil(
      () => forgeStub.calls.some((call) => call.op === "update"),
      "the PR body update",
      40_000,
    );

    const pushes = server.calls.filter(
      (call) => call.command === "git" && call.args.includes("push") && call.args.includes(session.branch),
    );
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    for (const push of pushes) {
      expect(push.args).not.toContain("--force");
      expect(push.args).not.toContain("-f");
    }
    expect(forgeStub.calls.filter((call) => call.op === "createDraft")).toHaveLength(1);
    expect(forgeStub.calls.filter((call) => call.op === "update").length).toBeGreaterThanOrEqual(1);
    await stopFlow(client);
    client.close();
  }, 60_000);

  test("a checkpoint after Ready keeps the Gitea pull request live so it merges", async () => {
    const fixture = createFixture("pr-ready-checkpoint-gitea");
    const fake = fakeGiteaPull();
    const giteaForge = new CommandFlowForge(
      async () => ({ code: 1, stdout: "", stderr: "" }),
      {},
      async () => ({
        forge: "gitea",
        host: "localhost",
        project: "acme/fixture",
        login: "fixture",
        token: "fixture-secret-token",
        source: "test",
        baseUrl: "http://gitea.test",
        active: true,
        permission: "push",
        canWrite: true,
      }),
      fake.fetch,
    );
    const server = startServer(fixture, {
      forge: giteaForge,
      forgeTarget: GITEA,
      stub: ["--flow-goal", "--flow-implement", "--flow-change", "--flow-checkpoints=1"],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    const session = await startFlow(client, fixture);
    await client.waitFor(
      (event) => event.type === "flowPr" && pullRequestState(event) === "draft",
    );
    await client.waitFor((event) => event.type === "flowStopped");

    client.send({ type: "markFlowPrReady" });
    await client.waitFor(
      (event) => event.type === "flowPr" && pullRequestState(event) === "live",
    );
    expect(fake.title()).not.toContain("WIP:");

    // A checkpoint after Ready is an ordinary commit: the watcher pushes it and
    // updates the live request, which must stay live.
    writeFileSync(join(session.worktree, "src", "later.txt"), "later checkpoint\n");
    git(session.worktree, ["add", "-A"]);
    git(session.worktree, ["commit", "-m", "checkpoint after ready"]);
    await waitUntil(
      () => fake.calls.filter((call) => call.method === "PATCH").length >= 2,
      "the post-Ready pull request update",
      40_000,
    );
    expect(fake.title()).not.toContain("WIP:");

    client.send({ type: "mergeFlowPr" });
    await client.waitFor(
      (event) => event.type === "flowPr" && pullRequestState(event) === "merged",
    );
    expect(
      client.events.some(
        (event) =>
          event.type === "flowError" && String(event.message).includes("not an open, live"),
      ),
    ).toBe(false);
    expect(fake.merged()).toBe(true);
    client.close();
  }, 90_000);

  test("Ready refuses a running or dirty session and accepts a stopped, clean draft", async () => {
    const fixture = createFixture("pr-ready");
    const forgeStub = new StubForge();
    const server = startServer(fixture, {
      forge: forgeStub,
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=8000",
      ],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    const session = await startFlow(client, fixture);
    await client.waitFor((event) => event.type === "flowPr" && event.pr !== null);

    client.send({ type: "markFlowPrReady" });
    const running = await client.waitFor((event) => event.type === "flowError");
    expect(String(running.message)).toContain("Stop the Flow implementation");
    await stopFlow(client);

    writeFileSync(join(session.worktree, "dirty.txt"), "uncommitted\n");
    client.send({ type: "markFlowPrReady" });
    const dirty = await client.waitFor(
      (event) => event.type === "flowError" && String(event.message).includes("Commit or discard"),
    );
    expect(String(dirty.message)).toContain("Commit");
    rmSync(join(session.worktree, "dirty.txt"));

    await waitUntil(() => true, "noop");
    client.send({ type: "markFlowPrReady" });
    const live = await client.waitFor(
      (event) => event.type === "flowPr" && (event.pr as { state: string }).state === "live",
    );
    expect((live.pr as { state: string }).state).toBe("live");
    expect(forgeStub.calls.some((call) => call.op === "markReady")).toBe(true);
    client.close();
  }, 60_000);

  test("Merge refuses a draft, a running session, a dirty worktree, and a forge failure", async () => {
    const fixture = createFixture("pr-merge-refusals");
    const forgeStub = new StubForge({ failMerge: "checks are pending" });
    const server = startServer(fixture, {
      forge: forgeStub,
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=8000",
      ],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    const session = await startFlow(client, fixture);
    await client.waitFor((event) => event.type === "flowPr" && event.pr !== null);

    client.send({ type: "mergeFlowPr" });
    const running = await client.waitFor((event) => event.type === "flowError");
    expect(String(running.message)).toContain("Stop the Flow implementation");
    await stopFlow(client);

    client.send({ type: "mergeFlowPr" });
    const draft = await client.waitFor(
      (event) => event.type === "flowError" && String(event.message).includes("Only a live"),
    );
    expect(String(draft.message)).toContain("live");

    client.send({ type: "markFlowPrReady" });
    await client.waitFor((event) => event.type === "flowPr" && (event.pr as { state: string }).state === "live");
    writeFileSync(join(session.worktree, "dirty.txt"), "uncommitted\n");
    client.send({ type: "mergeFlowPr" });
    const dirty = await client.waitFor(
      (event) => event.type === "flowError" && String(event.message).includes("Commit or discard"),
    );
    expect(String(dirty.message)).toContain("Commit");
    rmSync(join(session.worktree, "dirty.txt"));

    client.send({ type: "mergeFlowPr" });
    const failed = await client.waitFor(
      (event) => event.type === "flowError" && String(event.message).includes("checks are pending"),
    );
    expect(String(failed.message)).toContain("checks are pending");
    expect(existsSync(session.worktree)).toBe(true);
    expect((latest(client, "flowPr")?.pr as { state: string }).state).toBe("live");
    client.close();
  }, 60_000);

  test("a merge commit merges, fast-forwards main, removes the worktree, and deletes both branches", async () => {
    const fixture = createFixture("pr-merge");
    const forgeStub = new StubForge();
    const server = startServer(fixture, {
      forge: forgeStub,
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=8000",
      ],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    const session = await startFlow(client, fixture);
    await client.waitFor((event) => event.type === "flowPr" && event.pr !== null);
    await stopFlow(client);
    client.send({ type: "markFlowPrReady" });
    await client.waitFor((event) => event.type === "flowPr" && (event.pr as { state: string }).state === "live");

    // The forge merges the PR: reproduce the merge commit on the bare origin.
    const clone = join(fixture.root, ".worktree", "merge-clone");
    git(fixture.root, ["clone", join(fixture.root, "origin.git"), clone]);
    git(clone, [
      "-c",
      "user.name=Forge",
      "-c",
      "user.email=forge@example.test",
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--no-ff",
      `origin/${session.branch}`,
      "-m",
      `Merge pull request #7 from ${session.branch}`,
    ]);
    git(clone, ["push", "origin", "main"]);
    const hostBefore = git(fixture.root, ["rev-parse", "main"]).trim();
    const originMain = git(clone, ["rev-parse", "main"]).trim();
    expect(hostBefore).not.toBe(originMain);

    client.send({ type: "mergeFlowPr" });
    await client.waitFor((event) => event.type === "flowPr" && (event.pr as { state: string }).state === "merged");
    await client.waitFor((event) => event.type === "flowSnapshot" && event.status === "merged");

    expect(forgeStub.calls.find((call) => call.op === "merge")?.input).toMatchObject({ method: "merge" });
    expect(forgeStub.calls.some((call) => call.op === "deleteRemoteBranch" && call.branch === session.branch)).toBe(true);
    expect(existsSync(session.worktree)).toBe(false);
    expect(git(fixture.root, ["rev-parse", "main"]).trim()).toBe(originMain);
    expect(git(fixture.root, ["status", "--porcelain"]).trim()).toBe("");
    const localBranch = Bun.spawnSync({
      cmd: ["git", "-C", fixture.root, "rev-parse", "--verify", `refs/heads/${session.branch}`],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(localBranch.exitCode).not.toBe(0);

    const merged = latest(client, "flowSnapshot");
    expect(merged?.leftover).toBeNull();
    client.send({ type: "startFlowImplementation" });
    const refused = await client.waitFor(
      (event) => event.type === "flowError" && String(event.message).includes("merged"),
    );
    expect(String(refused.message)).toContain("merged");
    client.send({ type: "markFlowPrReady" });
    await client.waitFor(
      (event) => event.type === "flowError" && String(event.message).includes("Only a draft"),
    );

    // The merged session keeps its files, and a new goal starts a new session.
    const oldDirectory = sessionOf(fixture);
    const count = (type: string) => client.events.filter((event) => event.type === type).length;
    const questionsBefore = count("flowQuestion");
    client.send({ type: "createFlowGoal" });
    await waitUntil(() => count("flowQuestion") > questionsBefore, "the new goal question");
    const question = [...client.events].reverse().find((event) => event.type === "flowQuestion");
    client.send({ type: "flowAnswer", target: "goal", id: question?.id, value: "Alpha" });
    await waitUntil(
      () =>
        client.events.some(
          (event) => event.type === "flowSnapshot" && event.sessionId !== oldDirectory.id,
        ),
      "a new session after the merge",
    );
    expect(existsSync(join(fixture.stateDir, "flow", journalKey(fixture.root), oldDirectory.id, "goal.md"))).toBe(true);
    client.close();
  }, 90_000);

  test("cleanup failure keeps the merged PR, the worktree, and its branch and reports both", async () => {
    const fixture = createFixture("pr-cleanup-failure");
    const forgeStub = new StubForge();
    const recorder = recordingExecutor();
    const failing: Exec = async (command, args, options) => {
      if (command === "git" && args.includes("worktree") && args.includes("remove")) {
        recorder.calls.push({ command, args, env: options.env });
        return { stdout: "", stderr: "fatal: worktree is locked", code: 128 };
      }
      return recorder.exec(command, args, options);
    };
    const server = startServer(fixture, {
      forge: forgeStub,
      exec: failing,
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=8000",
      ],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    const session = await startFlow(client, fixture);
    await client.waitFor((event) => event.type === "flowPr" && event.pr !== null);
    await stopFlow(client);
    client.send({ type: "markFlowPrReady" });
    await client.waitFor((event) => event.type === "flowPr" && (event.pr as { state: string }).state === "live");

    client.send({ type: "mergeFlowPr" });
    const merged = await client.waitFor((event) => event.type === "flowSnapshot" && event.status === "merged");
    expect(String(merged.leftover)).toContain(session.worktree);
    expect(String(merged.leftover)).toContain(session.branch);
    expect(existsSync(session.worktree)).toBe(true);
    expect((merged.pr as { state: string }).state).toBe("merged");
    client.close();
  }, 90_000);

  test("restore archives a merged request stored beside a stopped status", async () => {
    const fixture = createFixture("pr-restore-merged");
    const flowRoot = join(fixture.stateDir, "flow", journalKey(fixture.root));
    const mergedId = "aaaa1111";
    const currentId = "bbbb2222";
    const pr = {
      forge: "github",
      number: 7,
      url: "https://forge.test/acme/fixture/pull/7",
      state: "merged",
    };
    const base = git(fixture.root, ["rev-parse", "main"]).trim();
    const seed = (id: string, status: string, createdAt: string, mergedPr: unknown) => {
      mkdirSync(join(flowRoot, id), { recursive: true });
      writeFileSync(
        join(flowRoot, id, "session.json"),
        `${JSON.stringify({
          version: 1,
          id,
          baseRevision: base,
          worktree: join(fixture.root, ".worktree", `flow-${id}`),
          branch: `flow/${id}`,
          status,
          goal: `# Flow goal\n\n${id}`,
          decisions: "",
          steering: [],
          accepted: [],
          widgets: [],
          files: [],
          checkpoints: [],
          verification: null,
          blockers: [],
          pr: mergedPr,
          prError: null,
          leftover: null,
          question: null,
          pushedTip: null,
          prFailedTip: null,
          lastDiffHash: null,
          createdAt,
          updatedAt: createdAt,
        })}\n`,
      );
    };
    // The older revision's window: the merged request is on disk while the
    // status still says stopped. A current idle session keeps the snapshot.
    seed(mergedId, "stopped", "2026-01-01T00:00:00.000Z", pr);
    seed(currentId, "idle", "2026-02-01T00:00:00.000Z", null);

    const server = startServer(fixture);
    const client = await connect(server);
    await connected(client);
    const snapshot = await client.waitFor((event) => event.type === "flowSnapshot");
    expect(snapshot.sessionId).toBe(currentId);
    expect(historyIds(snapshot)).toEqual([mergedId]);

    const stored = storedSession(fixture, mergedId);
    expect(stored?.status).toBe("merged");
    expect(prState(stored)).toBe("merged");
    expect(stored?.cleanupPending).toBe(false);
    expect(stored?.leftover).toBeNull();

    client.send({ type: "startFlowImplementation" });
    const started = await client.waitFor(
      (event) => event.type === "flowImplementationStarted" || event.type === "flowError",
    );
    // The restored merged session is archived, so Start can only affect the
    // current idle session, never the one whose request is already merged.
    expect(storedSession(fixture, mergedId)?.status).toBe("merged");
    if (started.type === "flowError") {
      expect(String(started.message)).not.toContain("merged");
    }
    client.close();
  }, 60_000);

  test("a stop between the merge write and cleanup restores merged and finishes the cleanup", async () => {
    const fixture = createFixture("pr-merge-restart");
    const forgeStub = new StubForge();
    let blockCleanup = false;
    const reached = Promise.withResolvers<void>();
    const recorder = recordingExecutor();
    const blocking: Exec = async (command, args, options) => {
      if (
        blockCleanup &&
        command === "git" &&
        args.length === 2 &&
        args[0] === "fetch" &&
        args[1] === "origin"
      ) {
        reached.resolve();
        return await new Promise(() => {});
      }
      return recorder.exec(command, args, options);
    };
    const server = startServer(fixture, {
      forge: forgeStub,
      exec: blocking,
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=8000",
      ],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    const session = await startFlow(client, fixture);
    await client.waitFor((event) => event.type === "flowPr" && event.pr !== null);
    await stopFlow(client);
    client.send({ type: "markFlowPrReady" });
    await client.waitFor((event) => event.type === "flowPr" && (event.pr as { state: string }).state === "live");

    const clone = join(fixture.root, ".worktree", "restart-clone");
    git(fixture.root, ["clone", join(fixture.root, "origin.git"), clone]);
    git(clone, [
      "-c",
      "user.name=Forge",
      "-c",
      "user.email=forge@example.test",
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--no-ff",
      `origin/${session.branch}`,
      "-m",
      `Merge pull request #7 from ${session.branch}`,
    ]);
    git(clone, ["push", "origin", "main"]);

    blockCleanup = true;
    client.send({ type: "mergeFlowPr" });
    await reached.promise;
    // The merge's terminal write is complete and cleanup has not started:
    // the state on disk already pairs the merged request with a merged status.
    await waitUntil(() => {
      const stored = storedSession(fixture, session.id);
      return (
        stored?.status === "merged" &&
        prState(stored) === "merged" &&
        stored.cleanupPending === true
      );
    }, "the terminal merge write");
    const interrupted = storedSession(fixture, session.id);
    expect(prState(interrupted)).toBe("merged");
    expect(interrupted?.status).toBe("merged");
    expect(existsSync(session.worktree)).toBe(true);

    client.close();
    server.server.stop(true);

    startServer(fixture, { forge: new StubForge() });
    await waitUntil(() => {
      const stored = storedSession(fixture, session.id);
      return stored?.cleanupPending === false && stored.status === "merged";
    }, "restore to finish the merge cleanup");

    const restored = storedSession(fixture, session.id);
    expect(restored?.status).toBe("merged");
    expect(prState(restored)).toBe("merged");
    expect(restored?.leftover).toBeNull();
    expect(existsSync(session.worktree)).toBe(false);
    const flowRoot = join(fixture.stateDir, "flow", journalKey(fixture.root));
    for (const id of readdirSync(flowRoot)) {
      const stored = storedSession(fixture, id);
      if (prState(stored) === "merged") {
        expect(stored?.status).toBe("merged");
      }
    }
  }, 90_000);

  test("a rejected push produces one error, no PR, and a retry that succeeds", async () => {
    const fixture = createFixture("pr-retry");
    const forgeStub = new StubForge();
    let rejectPush = true;
    const recorder = recordingExecutor();
    const flaky: Exec = async (command, args, options) => {
      if (command === "git" && args.includes("push") && rejectPush) {
        recorder.calls.push({ command, args, env: options.env });
        return { stdout: "", stderr: "! [rejected] non-fast-forward", code: 1 };
      }
      return recorder.exec(command, args, options);
    };
    const server = startServer(fixture, {
      forge: forgeStub,
      exec: flaky,
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    await startFlow(client, fixture);
    const error = await client.waitFor((event) => event.type === "flowError");
    expect(String(error.message)).toContain("rejected");
    expect(forgeStub.pullRequest).toBeUndefined();
    const snapshot = await client.waitFor(
      (event) => event.type === "flowSnapshot" && String(event.prError).includes("rejected"),
    );
    expect(String(snapshot.prError)).toContain("rejected");
    expect(existsSync((latest(client, "flowImplementationStarted")?.worktree as string))).toBe(true);

    rejectPush = false;
    client.send({ type: "retryFlowPr" });
    const pr = await client.waitFor((event) => event.type === "flowPr" && event.pr !== null);
    expect((pr.pr as { state: string }).state).toBe("draft");
    expect(forgeStub.calls.filter((call) => call.op === "createDraft")).toHaveLength(1);
    for (const call of server.calls) {
      const text = `${call.command} ${call.args.join(" ")}`;
      expect(text).not.toContain(" issue ");
      expect(text).not.toContain("label list");
      expect(text).not.toContain("search issues");
      expect(text).not.toContain("epic");
    }
    await stopFlow(client);
    client.close();
  }, 60_000);

  test("a forge failure keeps the session, invents no PR, and a retry creates the draft", async () => {
    const fixture = createFixture("pr-forge-failure");
    const forgeStub = new StubForge({ failCreate: "forge unavailable" });
    const server = startServer(fixture, {
      forge: forgeStub,
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    const session = await startFlow(client, fixture);
    const error = await client.waitFor((event) => event.type === "flowError");
    expect(String(error.message)).toContain("forge unavailable");
    expect(forgeStub.pullRequest).toBeUndefined();
    expect(existsSync(session.worktree)).toBe(true);

    forgeStub.clearFailures();
    client.send({ type: "retryFlowPr" });
    const pr = await client.waitFor((event) => event.type === "flowPr" && event.pr !== null);
    expect((pr.pr as { state: string }).state).toBe("draft");
    await stopFlow(client);
    client.close();
  }, 60_000);

  test("an origin that is not GitHub or GitLab produces an error and no PR", async () => {
    const fixture = createFixture("pr-unsupported");
    const forgeStub = new StubForge();
    const origin = join(fixture.root, "origin.git");
    git(fixture.root, ["remote", "set-url", "origin", origin]);
    const server = startServer(fixture, {
      forge: forgeStub,
      forgeTarget: null,
      stub: ["--flow-goal", "--flow-implement", "--flow-change"],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    await startFlow(client, fixture);
    const error = await client.waitFor((event) => event.type === "flowError");
    expect(String(error.message)).toContain("does not name a supported repository");
    expect(forgeStub.calls).toHaveLength(0);
    await stopFlow(client);
    client.close();
  }, 60_000);

  test("no Flow operation ever spawns a goal or implementation peer twice", async () => {
    const fixture = createFixture("pr-spawns");
    const forgeStub = new StubForge();
    const server = startServer(fixture, {
      forge: forgeStub,
      stub: [
        "--flow-goal",
        "--flow-implement",
        "--flow-change",
        "--flow-checkpoints=2",
        "--flow-step-delay=8000",
      ],
    });
    const client = await connect(server);
    await connected(client);
    await createGoal(client);
    await startFlow(client, fixture);
    await waitForStub(fixture, (line) => line.startsWith("prompt /flow-implement "));
    client.send({ type: "startFlowImplementation" });
    const error = await client.waitFor((event) => event.type === "flowError");
    expect(String(error.message)).toContain("already running");
    expect(spawnCount(fixture)).toBe(2);
    await stopFlow(client);
    client.close();
  }, 60_000);
});
