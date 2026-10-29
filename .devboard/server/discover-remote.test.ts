import { fixtureRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import {
  cleanupRemoteScratch,
  hostFacts,
  listRetainedProjects,
  remoteCloneName,
  remoteProjectDirectory,
  remoteScratchRoot,
  removeRetainedProject,
  retainRemoteProject,
  type RemoteCloneRequest,
  type RemoteCloneRunner,
} from "./discover";
import { readStateFile, stateFile } from "./state";
import { journalFile } from "./journal";
import { testProviderService } from "./fixtures/test-providers";
import { ConnectionStore } from "../client/lib/connection.svelte";
import { DiscoverStore } from "../client/lib/discover.svelte";

/**
 * Discover's remote target: the source-checkout gate, URL validation, the one
 * `git clone` child per run, retention of the published bytes after a crawl,
 * restore without a clone, switching, removal, and durability. Every child is
 * injected, every fixture lives under the harness `.tmp`, and no test makes a
 * network request.
 */

const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "discover-remote-tests");
const DISCOVER_SKILLS = [
  "discover-testing-strategy",
  "discover-naming-conventions",
  "discover-coding-conventions",
  "discover-architecture-boundaries",
  "discover-glossary",
];
const URL_MAX = 2048;

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
  cleanup.push(() => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A locked fixture is left for the operator.
    }
  });
  return directory;
}

function gitRun(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=Discover Remote Fixture",
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
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(cwd: string, args: string[]): string {
  const result = gitRun(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

const GITIGNORE = [".devboard/.tmp/", "node_modules/", "state/", "*.log", ""].join("\n");

function writeRepository(root: string, name: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n\nA fixture host for Discover.\n`);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name, scripts: { build: "bun run build:src", test: "bun test" } }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "src", "order.ts"),
    "export const orderTotal = (total: number): number => total;\n",
  );
  writeFileSync(
    join(root, "test", "order.test.ts"),
    'import { test, expect } from "bun:test";\ntest("order total", () => expect(1).toBe(1));\n',
  );
  writeFileSync(
    join(root, ".github", "workflows", "ci.yml"),
    "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n",
  );
  writeFileSync(join(root, ".gitignore"), GITIGNORE);
}

function commitRepository(root: string, message: string): void {
  git(root, ["init", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", message]);
}

type Gate = "source" | "installed" | "none";

interface Fixture {
  root: string;
  goalFile: string;
  adrDir: string;
  stateDir: string;
  logPath: string;
  gate: Gate;
}

function createFixture(name: string, gate: Gate = "source"): Fixture {
  const root = testDirectory(name);
  mkdirSync(join(root, "adrs"), { recursive: true });
  writeRepository(root, `fixture-${name}`);
  writeFileSync(join(root, "GOAL.md"), "# Fixture goal\n\nKeep the fixture buildable.\n");
  writeFileSync(join(root, "adrs", "0001-fixture.md"), fixtureRecord("0001-fixture.md", "Fixture decision"));
  if (gate !== "none") {
    mkdirSync(join(root, ".devboard"), { recursive: true });
    writeFileSync(
      join(root, ".devboard", "package.json"),
      `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.0.0" }, null, 2)}\n`,
    );
    if (gate === "installed") {
      const installed = join(root, ".devboard", "node_modules", "@dsdenes", "devboard");
      mkdirSync(installed, { recursive: true });
      writeFileSync(
        join(installed, "package.json"),
        `${JSON.stringify({ name: "@dsdenes/devboard", version: "9.9.9" }, null, 2)}\n`,
      );
    }
  }
  commitRepository(root, "chore: fixture base");
  const stateDir = gate === "none" ? join(root, "state") : join(root, ".devboard", ".tmp", "state");
  return {
    root,
    goalFile: join(root, "GOAL.md"),
    adrDir: join(root, "adrs"),
    stateDir,
    logPath: join(root, "agent.log"),
    gate,
  };
}

/** A repository a test clone copies; it is never the dashboard's host. */
function createSourceRepository(name: string): string {
  const root = testDirectory(name);
  writeRepository(root, `remote-${name}`);
  writeFileSync(join(root, "src", "catalog.ts"), "export const catalogSize = 3;\n");
  commitRepository(root, "chore: remote source");
  return root;
}

interface CloneBehavior {
  source?: string;
  fail?: { code: number; stderr: string; timedOut: boolean };
  /** Return success without creating the destination. */
  empty?: boolean;
  /** Blocks the clone until released. */
  gate?: { promise: Promise<void>; release: () => void };
}

interface CloneHarness {
  calls: RemoteCloneRequest[];
  runner: RemoteCloneRunner;
  behavior: CloneBehavior;
}

function cloneHarness(behavior: CloneBehavior = {}): CloneHarness {
  const calls: RemoteCloneRequest[] = [];
  const runner: RemoteCloneRunner = async (request) => {
    calls.push(request);
    if (behavior.gate !== undefined) await behavior.gate.promise;
    if (behavior.fail !== undefined) return behavior.fail;
    if (behavior.empty === true) return { code: 0, stderr: "", timedOut: false };
    const source = behavior.source;
    if (source === undefined) throw new Error("clone fixture has no source");
    const destination = join(request.cwd, request.argv[request.argv.length - 1] ?? "");
    cpSync(source, destination, { recursive: true, force: true });
    return { code: 0, stderr: "", timedOut: false };
  };
  return { calls, runner, behavior };
}

interface TestServer {
  server: Server<unknown>;
  fixture: Fixture;
  url: string;
  clones: CloneHarness;
}

interface StartOptions {
  fixture?: Fixture;
  stateDir?: string;
  stub?: string[];
  clone?: CloneHarness;
}

function startServer(options: StartOptions = {}): TestServer {
  const fixture = options.fixture ?? createFixture("discover-remote");
  const stateDir = options.stateDir ?? fixture.stateDir;
  const clones = options.clone ?? cloneHarness();
  const command = `bun ${STUB_AGENT} --log=${fixture.logPath} ${(options.stub ?? ["--discover"]).join(" ")}`;
  const server = createApp({
    adrDir: fixture.adrDir,
    staticDir: join(fixture.root, "static"),
    hostname: "127.0.0.1",
    port: 0,
    repoDir: fixture.root,
    stateDir,
    providers: testProviderService(stateDir),
    goalFile: fixture.goalFile,
    agentCommand: command,
    tracker: async () => undefined,
    trackerSettle: { attempts: 1 },
    discoverClone: clones.runner,
  });
  return { server, fixture, url: `127.0.0.1:${server.port}`, clones };
}

interface TestClient {
  socket: WebSocket;
  events: Record<string, unknown>[];
  send(command: unknown): void;
  /** Resolves with the next matching message, ignoring anything buffered. */
  waitNext(
    predicate: (message: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
  /** Resolves with an unconsumed matching message already seen, else the next one. */
  take(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  close(): void;
}

function connect(url: string): Promise<TestClient> {
  const { promise, resolve: settle, reject } = Promise.withResolvers<TestClient>();
  const socket = new WebSocket(`ws://${url}/ws`);
  const events: Record<string, unknown>[] = [];
  const consumed = new Set<Record<string, unknown>>();
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
      waitNext(predicate) {
        const { promise: waiting, resolve: next } = Promise.withResolvers<Record<string, unknown>>();
        waiters.push({ predicate, resolve: next });
        return waiting;
      },
      take(predicate) {
        const seen = events.findIndex(
          (message) => !consumed.has(message) && predicate(message),
        );
        if (seen >= 0) {
          const message = events[seen] as Record<string, unknown>;
          consumed.add(message);
          return Promise.resolve(message);
        }
        const { promise: waiting, resolve: next } = Promise.withResolvers<Record<string, unknown>>();
        waiters.push({ predicate, resolve: next });
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
      if (waiter !== undefined) {
        consumed.add(message);
        waiter.resolve(message);
      }
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

function isCloningState(message: Record<string, unknown>): boolean {
  const state = message.state;
  return (
    message.type === "discoverState" &&
    typeof state === "object" &&
    state !== null &&
    "cloning" in state &&
    state.cloning !== null
  );
}

function stateTargetKind(message: Record<string, unknown>, kind: string): boolean {
  const state = message.state;
  if (typeof state !== "object" || state === null) return false;
  const target = "target" in state ? state.target : undefined;
  return (
    typeof target === "object" &&
    target !== null &&
    "kind" in target &&
    target.kind === kind
  );
}

interface DiscoverState {
  active: boolean;
  runId: string | null;
  interrupted: boolean;
  stale: boolean;
  warnings: string[];
  busy: string | null;
  error: string | null;
  remoteAvailable: boolean;
  retained: Array<{ url: string; owner: string; repo: string; completedAt: string }>;
  repository: string | null;
  target: Record<string, unknown>;
  cloning: Record<string, unknown> | null;
  manifest: Record<string, unknown> | null;
  freshness: Record<string, unknown> | null;
  sheet: Record<string, unknown> | null;
  glossaries: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
}

function stateOf(message: Record<string, unknown>): DiscoverState {
  return message.state as DiscoverState;
}

async function discoverState(client: TestClient): Promise<DiscoverState> {
  const reply = client.waitNext((message) => message.type === "discoverState");
  client.send({ type: "getDiscover" });
  return stateOf(await reply);
}

async function runRemote(client: TestClient, url: string): Promise<DiscoverState> {
  const cloning = client.waitNext(isCloningState);
  const started = client.waitNext((message) => message.type === "discoverStarted");
  const stopped = client.waitNext((message) => message.type === "discoverStopped");
  client.send({ type: "discoverRemote", url });
  const cloningState = stateOf(await cloning);
  expect((cloningState.cloning as Record<string, unknown>).url).toBe(url.trim());
  expect(cloningState.repository).not.toBeNull();
  expect(cloningState.target).toMatchObject({ kind: "remote" });
  await started;
  expect((await stopped).completed).toBe(true);
  return discoverState(client);
}

async function runProject(client: TestClient): Promise<DiscoverState> {
  const started = client.waitNext((message) => message.type === "discoverStarted");
  const stopped = client.waitNext((message) => message.type === "discoverStopped");
  client.send({ type: "discoverProject" });
  await started;
  expect((await stopped).completed).toBe(true);
  return discoverState(client);
}

async function switchRemote(client: TestClient, url: string): Promise<DiscoverState> {
  const reply = client.waitNext((message) => message.type === "discoverState");
  client.send({ type: "switchDiscoverRemote", url });
  return stateOf(await reply);
}

async function removeRemote(client: TestClient, url: string): Promise<DiscoverState> {
  const reply = client.waitNext((message) => message.type === "discoverState");
  client.send({ type: "removeDiscoverRemote", url });
  return stateOf(await reply);
}

async function clearRemote(client: TestClient): Promise<DiscoverState> {
  const reply = client.waitNext((message) => message.type === "discoverState");
  client.send({ type: "clearDiscoverRemote" });
  return stateOf(await reply);
}

async function refusal(client: TestClient, command: unknown): Promise<string> {
  const reply = client.waitNext((message) => message.type === "discoverError");
  client.send(command);
  return String((await reply).message);
}

/** File bytes of one tree, keyed by relative path, for byte-for-byte checks. */
function treeBytes(root: string): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(root)) return files;
  const walk = (prefix: string) => {
    const directory = prefix.length === 0 ? root : join(root, prefix);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.set(next, readFileSync(join(root, next)).toString("base64"));
    }
  };
  walk("");
  return files;
}

function ompBytes(root: string): Map<string, string> {
  return new Map([
    ...[...treeBytes(join(root, ".omp", "discover"))].map(
      ([path, bytes]) => [`.omp/discover/${path}`, bytes] as const,
    ),
    ...[...treeBytes(join(root, ".omp", "skills"))].map(
      ([path, bytes]) => [`.omp/skills/${path}`, bytes] as const,
    ),
  ]);
}

function scratchEntries(fixture: Fixture, stateDir = fixture.stateDir): string[] {
  const root = remoteScratchRoot(stateDir);
  if (!existsSync(root)) return [];
  return readdirSync(root).sort();
}

function retainedDirectory(fixture: Fixture, owner: string, repo: string): string {
  return remoteProjectDirectory(remoteScratchRoot(fixture.stateDir), owner, repo);
}

function retainedRecord(
  fixture: Fixture,
  owner: string,
  repo: string,
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(retainedDirectory(fixture, owner, repo), "project.json"), "utf8"),
  ) as Record<string, unknown>;
}

/** Seeds a retained project without a checkout, for gate and restore fixtures. */
function seedRetainedProject(
  stateDir: string,
  owner: string,
  repo: string,
  url: string,
  completedAt: string,
  marker: string,
): string {
  const directory = remoteProjectDirectory(remoteScratchRoot(stateDir), owner, repo);
  mkdirSync(join(directory, ".omp", "discover"), { recursive: true });
  mkdirSync(join(directory, ".omp", "skills"), { recursive: true });
  writeFileSync(join(directory, ".omp", "discover", "marker.txt"), marker);
  writeFileSync(join(directory, ".omp", "skills", "marker.txt"), marker);
  writeFileSync(
    join(directory, "project.json"),
    `${JSON.stringify({ url, owner, repo, completedAt }, null, 2)}\n`,
  );
  return directory;
}

function expectNoCheckout(fixture: Fixture, stateDir = fixture.stateDir): void {
  const root = remoteScratchRoot(stateDir);
  for (const entry of scratchEntries(fixture, stateDir)) {
    expect(entry.startsWith(".staging-")).toBe(false);
    expect(existsSync(join(root, entry, ".git"))).toBe(false);
  }
}

function persistedState(fixture: Fixture, stateDir = fixture.stateDir): Record<string, unknown> {
  const loaded = readStateFile(stateFile(stateDir, resolve(fixture.root)));
  if (loaded.kind !== "loaded") throw new Error(`state file is ${loaded.kind}`);
  return loaded.value as Record<string, unknown>;
}

function hostStatus(fixture: Fixture): string {
  return gitRun(fixture.root, ["status", "--porcelain", "--untracked-files=all"]).stdout;
}

function journalText(fixture: Fixture): string {
  const path = journalFile(fixture.stateDir, resolve(fixture.root));
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("discover remote target", () => {
  test(
    "exposes remote targets and retained projects only for a harness source checkout",
    async () => {
      const cases: Array<{ gate: Gate; available: boolean }> = [
        { gate: "source", available: true },
        { gate: "installed", available: false },
        { gate: "none", available: false },
      ];
      for (const entry of cases) {
        const fixture = createFixture(`gate-${entry.gate}`, entry.gate);
        mkdirSync(fixture.stateDir, { recursive: true });
        const seeded = seedRetainedProject(
          fixture.stateDir,
          "octocat",
          "Hello-World",
          "https://github.com/octocat/Hello-World",
          "2026-01-01T00:00:00.000Z",
          `gate-${entry.gate}`,
        );
        const seededBefore = treeBytes(seeded);
        const clones = cloneHarness({ source: createSourceRepository(`gate-source-${entry.gate}`) });
        const { server, url } = startServer({ fixture, clone: clones });
        const client = await connect(url);
        try {
          const initial = await discoverState(client);
          expect(initial.remoteAvailable).toBe(entry.available);
          expect(initial.cloning).toBeNull();

          if (entry.available) {
            expect(initial.retained.map((project) => project.url)).toEqual([
              "https://github.com/octocat/Hello-World",
            ]);
            const state = await runRemote(client, "https://github.com/octocat/Hello-World");
            expect(state.target).toMatchObject({
              kind: "remote",
              owner: "octocat",
              repo: "Hello-World",
              checkout: false,
            });
            expect(state.repository).toBe("octocat/Hello-World");
            expect(clones.calls.length).toBe(1);
            continue;
          }

          expect(initial.repository).toBeNull();
          expect(initial.target).toEqual({ kind: "host" });
          expect(initial.retained).toEqual([]);
          for (const command of [
            { type: "discoverRemote", url: "https://github.com/octocat/Hello-World" },
            { type: "switchDiscoverRemote", url: "https://github.com/octocat/Hello-World" },
            { type: "removeDiscoverRemote", url: "https://github.com/octocat/Hello-World" },
            { type: "clearDiscoverRemote" },
          ]) {
            const message = await refusal(client, command);
            expect(message).toContain("source checkout");
          }
          expect(clones.calls.length).toBe(0);
          expect(treeBytes(seeded)).toEqual(seededBefore);
          expect((await discoverState(client)).target).toEqual({ kind: "host" });
          expect((await discoverState(client)).retained).toEqual([]);
        } finally {
          client.close();
          server.stop(true);
        }
      }
    },
    90_000,
  );

  test(
    "accepts the one URL shape and refuses every other shape without spawning",
    async () => {
      const fixture = createFixture("urls");
      const clones = cloneHarness({ source: createSourceRepository("urls-source") });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      try {
        for (const accepted of [
          "https://github.com/Octocat/Hello-World",
          "https://github.com/Octocat/Hello-World/",
          "https://github.com/Octocat/Hello-World.git",
          "  https://github.com/Octocat/Hello-World  ",
        ]) {
          const state = await runRemote(client, accepted);
          expect(state.target).toEqual({
            kind: "remote",
            url: accepted.trim(),
            owner: "Octocat",
            repo: "Hello-World",
            checkout: false,
          });
        }
        const acceptedCount = clones.calls.length;
        expect(acceptedCount).toBe(4);
        // Every accepted spelling names the same lowercased owner/repo.
        expect(scratchEntries(fixture)).toEqual(["octocat~hello-world"]);
        expect(retainedRecord(fixture, "octocat", "hello-world").url).toBe(
          "https://github.com/Octocat/Hello-World",
        );

        const rejected = [
          "",
          "   ",
          "http://github.com/octocat/Hello-World",
          "git@github.com:octocat/Hello-World.git",
          "ssh://github.com/octocat/Hello-World",
          "https://gitlab.com/octocat/Hello-World",
          "https://github.com:443/octocat/Hello-World",
          "https://user@github.com/octocat/Hello-World",
          "https://github.com/octocat/Hello-World?ref=main",
          "https://github.com/octocat/Hello-World#readme",
          "https://github.com//Hello-World",
          "https://github.com/octocat",
          "https://github.com/octocat/Hello-World/extra",
          "https://github.com/octocat/..",
          "https://github.com/../Hello-World",
          "/home/octocat/Hello-World",
          "C:\\octocat\\Hello-World",
          `https://github.com/octocat/${"r".repeat(URL_MAX)}`,
        ];
        for (const value of rejected) {
          const refused = client.waitNext((message) => message.type === "discoverError");
          client.send({ type: "discoverRemote", url: value });
          expect(String((await refused).message)).toContain("Could not clone");
        }
        expect(clones.calls.length).toBe(acceptedCount);
        expect(scratchEntries(fixture)).toEqual(["octocat~hello-world"]);
        expect((await discoverState(client)).target).toMatchObject({ kind: "remote" });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    90_000,
  );

  test(
    "refuses a scratch root outside the repository",
    async () => {
      const fixture = createFixture("containment");
      const outside = testDirectory("containment-state");
      const clones = cloneHarness({ source: createSourceRepository("containment-source") });
      const { server, url } = startServer({ fixture, stateDir: outside, clone: clones });
      const client = await connect(url);
      try {
        const message = await refusal(client, {
          type: "discoverRemote",
          url: "https://github.com/octocat/Hello-World",
        });
        expect(message).toContain("STATE_DIR");
        expect(message).toContain("inside the repository");
        expect(clones.calls.length).toBe(0);
        expect(existsSync(remoteScratchRoot(outside))).toBe(false);
        expect((await discoverState(client)).target).toEqual({ kind: "host" });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "treats a malformed remote payload like an unknown command",
    async () => {
      const fixture = createFixture("malformed");
      const clones = cloneHarness({ source: createSourceRepository("malformed-source") });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      try {
        const commands = [
          { type: "discoverRemote" },
          { type: "discoverRemote", url: 5 },
          { type: "switchDiscoverRemote" },
          { type: "switchDiscoverRemote", url: null },
          { type: "removeDiscoverRemote" },
          { type: "removeDiscoverRemote", url: [] },
          { type: "switchDiscoverRemoteUnknown" },
        ];
        for (const command of commands) {
          const reply = client.waitNext((message) => message.type === "error");
          client.send(command);
          expect(String((await reply).message)).toBe("Invalid WebSocket message.");
        }
        expect(clones.calls.length).toBe(0);
        expect((await discoverState(client)).target).toEqual({ kind: "host" });
        expect((await discoverState(client)).retained).toEqual([]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "runs exactly one bounded git clone, crawls once, and retains the published bytes",
    async () => {
      const fixture = createFixture("clone");
      const source = createSourceRepository("clone-source");
      const clones = cloneHarness({ source });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      const hostOmpBefore = ompBytes(fixture.root);
      const fingerprintBefore = hostFacts(fixture.root).fingerprint;
      const statusBefore = hostStatus(fixture);
      try {
        const state = await runRemote(client, "https://github.com/Octocat/Hello-World.git");

        expect(clones.calls.length).toBe(1);
        const request = clones.calls[0] as RemoteCloneRequest;
        expect(request.argv.slice(0, 7)).toEqual([
          "git",
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--no-tags",
          "--",
        ]);
        expect(request.argv[7]).toBe("https://github.com/Octocat/Hello-World.git");
        expect(request.argv[8]).toMatch(/^\.staging-run-/);
        expect(request.cwd).toBe(remoteScratchRoot(fixture.stateDir));
        expect(request.timeoutMs).toBe(300_000);
        expect(request.env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(request.env.GIT_ASKPASS).toBe("true");
        expect(request.env.NO_COLOR).toBe("1");

        // The checkout is gone; only the retained project remains.
        expect(scratchEntries(fixture)).toEqual(["octocat~hello-world"]);
        expectNoCheckout(fixture);
        const retained = retainedDirectory(fixture, "octocat", "hello-world");
        expect(existsSync(join(retained, ".git"))).toBe(false);
        expect(existsSync(join(retained, ".omp", "discover", "manifest.json"))).toBe(true);
        expect(existsSync(join(retained, ".omp", "discover", "staging"))).toBe(false);
        for (const name of DISCOVER_SKILLS) {
          expect(existsSync(join(retained, ".omp", "skills", name, "SKILL.md"))).toBe(true);
        }
        expect(retainedRecord(fixture, "octocat", "hello-world")).toEqual({
          url: "https://github.com/Octocat/Hello-World.git",
          owner: "Octocat",
          repo: "Hello-World",
          completedAt: expect.any(String),
        });

        expect(state.target).toEqual({
          kind: "remote",
          url: "https://github.com/Octocat/Hello-World.git",
          owner: "Octocat",
          repo: "Hello-World",
          checkout: false,
        });
        expect(state.cloning).toBeNull();
        expect(state.retained.map((project) => project.url)).toEqual([
          "https://github.com/Octocat/Hello-World.git",
        ]);
        expect(state.sheet).not.toBeNull();
        expect(state.glossaries.length).toBe(1);
        expect(state.skills.map((skill) => skill.name)).toEqual([...DISCOVER_SKILLS]);

        expect(spawnCount(fixture.logPath)).toBe(1);
        const prompt = prompts(fixture.logPath)[0] ?? "";
        expect(prompt).toMatch(/^\/discover \/.*\/\.staging-run-[a-z0-9-]+\/\.omp\/discover\/staging\/run-[a-z0-9-]+$/);
        expect(
          logLines(fixture.logPath).find((line) => line.startsWith("argv ")) ?? "",
        ).toContain("--no-skills");
        expect(existsSync(join(retained, ".omp", "discover", "staging"))).toBe(false);

        // The dashboard's own host is untouched.
        expect(ompBytes(fixture.root)).toEqual(hostOmpBefore);
        expect(hostFacts(fixture.root).fingerprint).toBe(fingerprintBefore);
        expect(hostStatus(fixture)).toBe(statusBefore);
        expect(existsSync(join(fixture.root, ".omp", "discover"))).toBe(false);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    60_000,
  );

  test(
    "keeps the active target when the clone exits, times out, or leaves nothing",
    async () => {
      const cases: Array<{ name: string; behavior: CloneBehavior; expected: string }> = [
        {
          name: "exit",
          behavior: { fail: { code: 128, stderr: "fatal: repository not found", timedOut: false } },
          expected: "status 128",
        },
        {
          name: "timeout",
          behavior: { fail: { code: -1, stderr: "", timedOut: true } },
          expected: "timed out",
        },
        { name: "empty", behavior: { empty: true }, expected: "readable directory" },
      ];
      for (const entry of cases) {
        const fixture = createFixture(`clone-${entry.name}`);
        const clones = cloneHarness(entry.behavior);
        const { server, url } = startServer({ fixture, clone: clones });
        const client = await connect(url);
        try {
          const cloning = client.waitNext(isCloningState);
          const failed = client.waitNext((message) => message.type === "discoverError");
          const cleared = client.waitNext(
            (message) =>
              message.type === "discoverState" &&
              typeof message.state === "object" &&
              message.state !== null &&
              "cloning" in message.state &&
              message.state.cloning === null,
          );
          client.send({ type: "discoverRemote", url: "https://github.com/octocat/Hello-World" });
          await cloning;
          expect(String((await failed).message)).toContain(entry.expected);
          await cleared;
          expect((await discoverState(client)).target).toEqual({ kind: "host" });
          expect((await discoverState(client)).retained).toEqual([]);
          expect(scratchEntries(fixture)).toEqual([]);
          expect(spawnCount(fixture.logPath)).toBe(0);
        } finally {
          client.close();
          server.stop(true);
        }
      }
    },
    60_000,
  );

  test(
    "refuses a second clone, a clear, a start, a switch, and a remove while cloning",
    async () => {
      const fixture = createFixture("cloning");
      const clones = cloneHarness({ source: createSourceRepository("cloning-source") });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      const gate = Promise.withResolvers<void>();
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
        const retainedBefore = treeBytes(retainedDirectory(fixture, "octocat", "hello-world"));

        clones.behavior.source = createSourceRepository("cloning-source-two");
        clones.behavior.gate = { promise: gate.promise, release: () => gate.resolve() };
        const cloning = client.waitNext(isCloningState);
        const stopped = client.waitNext((message) => message.type === "discoverStopped");
        client.send({ type: "discoverRemote", url: "https://github.com/octocat/Other" });
        const cloningState = stateOf(await cloning);
        expect(cloningState.repository).toBe("octocat/Other");
        expect(cloningState.target).toEqual({
          kind: "remote",
          url: "https://github.com/octocat/Other",
          owner: "octocat",
          repo: "Other",
          checkout: false,
        });
        expect(cloningState.sheet).toBeNull();

        const refusals = [
          client.waitNext((message) => message.type === "discoverError"),
          client.waitNext((message) => message.type === "discoverError"),
          client.waitNext((message) => message.type === "discoverError"),
          client.waitNext((message) => message.type === "discoverError"),
          client.waitNext((message) => message.type === "discoverError"),
        ];
        client.send({ type: "discoverRemote", url: "https://github.com/octocat/Third" });
        client.send({ type: "clearDiscoverRemote" });
        client.send({ type: "discoverProject" });
        client.send({
          type: "switchDiscoverRemote",
          url: "https://github.com/octocat/Hello-World",
        });
        client.send({
          type: "removeDiscoverRemote",
          url: "https://github.com/octocat/Hello-World",
        });
        await Promise.all(refusals);
        expect(clones.calls.length).toBe(2);
        expect(spawnCount(fixture.logPath)).toBe(1);
        expect(treeBytes(retainedDirectory(fixture, "octocat", "hello-world"))).toEqual(
          retainedBefore,
        );
        expect((await discoverState(client)).target).toMatchObject({
          kind: "remote",
          repo: "Other",
        });

        gate.resolve();
        expect((await stopped).completed).toBe(true);
        expect(spawnCount(fixture.logPath)).toBe(2);
        expect((await discoverState(client)).retained).toHaveLength(2);
        expectNoCheckout(fixture);
      } finally {
        gate.resolve();
        client.close();
        server.stop(true);
      }
    },
    90_000,
  );

  test(
    "switches between retained projects with zero clone invocations and survives a restart",
    async () => {
      const fixture = createFixture("switch");
      const clones = cloneHarness({ source: createSourceRepository("switch-source-one") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      const hostOmp = ompBytes(fixture.root);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
        clones.behavior.source = createSourceRepository("switch-source-two");
        const second = await runRemote(client, "https://github.com/octocat/Second");
        expect(second.retained.map((project) => project.url)).toEqual([
          "https://github.com/octocat/Second",
          "https://github.com/octocat/Hello-World",
        ]);
        expect(second.target).toMatchObject({ repo: "Second" });

        const callsBefore = clones.calls.length;
        const spawnsBefore = spawnCount(fixture.logPath);
        const secondBytes = treeBytes(retainedDirectory(fixture, "octocat", "second"));
        const switched = await switchRemote(client, "https://github.com/octocat/Hello-World");
        expect(switched.target).toEqual({
          kind: "remote",
          url: "https://github.com/octocat/Hello-World",
          owner: "octocat",
          repo: "Hello-World",
          checkout: false,
        });
        expect(switched.repository).toBe("octocat/Hello-World");
        expect(switched.sheet).not.toBeNull();
        expect(switched.retained.map((project) => project.url)).toEqual([
          "https://github.com/octocat/Second",
          "https://github.com/octocat/Hello-World",
        ]);
        expect(clones.calls.length).toBe(callsBefore);
        expect(spawnCount(fixture.logPath)).toBe(spawnsBefore);
        expect(treeBytes(retainedDirectory(fixture, "octocat", "second"))).toEqual(secondBytes);
        expect(ompBytes(fixture.root)).toEqual(hostOmp);
      } finally {
        client.close();
        first.server.stop(true);
      }

      // The chosen project is the active target of a replacement with no clone.
      const guest = cloneHarness();
      const replacement = startServer({ fixture, clone: guest });
      const restored = await connect(replacement.url);
      try {
        const replay = stateOf(await restored.take((message) => message.type === "discoverState"));
        expect(replay.target).toMatchObject({
          kind: "remote",
          repo: "Hello-World",
          checkout: false,
        });
        expect(replay.retained.map((project) => project.url)).toEqual([
          "https://github.com/octocat/Second",
          "https://github.com/octocat/Hello-World",
        ]);
        expect(replay.sheet).not.toBeNull();
        expect(restored.events.some((message) => message.type === "discoverError")).toBe(false);
        expect(guest.calls.length).toBe(0);
        expect(spawnCount(fixture.logPath)).toBe(2);
        expectNoCheckout(fixture);
      } finally {
        restored.close();
        replacement.server.stop(true);
      }
    },
    90_000,
  );

  test(
    "holds one entry per lowercased owner/repo, newest first, with the latest URL and time",
    async () => {
      const fixture = createFixture("dedupe");
      const clones = cloneHarness({ source: createSourceRepository("dedupe-source") });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      try {
        const first = await runRemote(client, "https://github.com/Octocat/Hello-World");
        const firstRecord = retainedRecord(fixture, "octocat", "hello-world");
        const firstBytes = treeBytes(retainedDirectory(fixture, "octocat", "hello-world"));
        const second = await runRemote(client, "https://github.com/octocat/hello-world/");
        const secondRecord = retainedRecord(fixture, "octocat", "hello-world");
        expect(scratchEntries(fixture)).toEqual(["octocat~hello-world"]);
        expect(second.retained).toHaveLength(1);
        expect(secondRecord.url).toBe("https://github.com/octocat/hello-world/");
        expect(Date.parse(String(secondRecord.completedAt))).toBeGreaterThanOrEqual(
          Date.parse(String(firstRecord.completedAt)),
        );
        expect(second.retained[0]?.completedAt).toBe(String(secondRecord.completedAt));

        const third = await runRemote(client, "https://github.com/OCTOCAT/HELLO-WORLD.git");
        expect(third.retained).toHaveLength(1);
        expect(third.retained[0]?.url).toBe("https://github.com/OCTOCAT/HELLO-WORLD.git");
        expect(treeBytes(retainedDirectory(fixture, "octocat", "hello-world")).size).toBe(
          firstBytes.size,
        );
        expect(scratchEntries(fixture)).toEqual(["octocat~hello-world"]);

        clones.behavior.source = createSourceRepository("dedupe-source-other");
        const fourth = await runRemote(client, "https://github.com/octocat/Other");
        expect(fourth.retained.map((project) => project.url)).toEqual([
          "https://github.com/octocat/Other",
          "https://github.com/OCTOCAT/HELLO-WORLD.git",
        ]);
        expect(first.retained).toHaveLength(1);
        const fifth = await runRemote(client, "https://github.com/Octocat/Hello-World");
        expect(fifth.retained.map((project) => project.url)).toEqual([
          "https://github.com/Octocat/Hello-World",
          "https://github.com/octocat/Other",
        ]);
        expect(scratchEntries(fixture)).toHaveLength(2);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    90_000,
  );

  test(
    "re-discovers a retained target with one clone and one crawl, replacing its snapshot",
    async () => {
      const fixture = createFixture("rediscover");
      const clones = cloneHarness({ source: createSourceRepository("rediscover-source") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
      } finally {
        client.close();
        first.server.stop(true);
      }
      const recordBefore = retainedRecord(fixture, "octocat", "hello-world");
      expect(spawnCount(fixture.logPath)).toBe(1);

      const next = cloneHarness({ source: createSourceRepository("rediscover-source-two") });
      const second = startServer({ fixture, clone: next });
      const restored = await connect(second.url);
      try {
        const replay = stateOf(await restored.take((message) => message.type === "discoverState"));
        expect(replay.target).toMatchObject({ kind: "remote", checkout: false });
        const state = await runProject(restored);
        expect(next.calls.length).toBe(1);
        expect(spawnCount(fixture.logPath)).toBe(2);
        expect(state.target).toMatchObject({ kind: "remote", checkout: false });
        expect(state.sheet).not.toBeNull();
        const recordAfter = retainedRecord(fixture, "octocat", "hello-world");
        expect(Date.parse(String(recordAfter.completedAt))).toBeGreaterThanOrEqual(
          Date.parse(String(recordBefore.completedAt)),
        );
        expect(scratchEntries(fixture)).toEqual(["octocat~hello-world"]);
        expectNoCheckout(fixture);
        expect(ompBytes(fixture.root).size).toBe(0);
      } finally {
        restored.close();
        second.server.stop(true);
      }
    },
    90_000,
  );

  test(
    "a failed crawl and a failed clone leave the retained bytes and entry unchanged",
    async () => {
      const fixture = createFixture("failed-crawl");
      const clones = cloneHarness({ source: createSourceRepository("failed-crawl-source") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
      } finally {
        client.close();
        first.server.stop(true);
      }
      const retained = retainedDirectory(fixture, "octocat", "hello-world");
      const published = treeBytes(retained);
      const recordBefore = retainedRecord(fixture, "octocat", "hello-world");

      const invalid = startServer({
        fixture,
        clone: cloneHarness({ source: createSourceRepository("failed-crawl-source-two") }),
        stub: ["--discover", "--discover-invalid-sheet"],
      });
      const failedClient = await connect(invalid.url);
      try {
        failedClient.take((message) => message.type === "discoverState");
        const started = failedClient.waitNext((message) => message.type === "discoverStarted");
        const failed = failedClient.waitNext((message) => message.type === "discoverError");
        const stopped = failedClient.waitNext((message) => message.type === "discoverStopped");
        failedClient.send({ type: "discoverProject" });
        await started;
        expect(String((await failed).message)).toContain("Discover failed");
        expect((await stopped).completed).toBe(false);
        expect(failedClient.events.filter((event) => event.type === "discoverError")).toHaveLength(1);
        expect(treeBytes(retained)).toEqual(published);
        expect(retainedRecord(fixture, "octocat", "hello-world")).toEqual(recordBefore);
        expect((await discoverState(failedClient)).target).toMatchObject({ kind: "remote" });
        expectNoCheckout(fixture);
      } finally {
        failedClient.close();
        invalid.server.stop(true);
      }

      const failingClone = cloneHarness({
        fail: { code: 128, stderr: "fatal: repository not found", timedOut: false },
      });
      const unclonable = startServer({ fixture, clone: failingClone });
      const cloneClient = await connect(unclonable.url);
      try {
        cloneClient.take((message) => message.type === "discoverState");
        const message = await refusal(cloneClient, { type: "discoverProject" });
        expect(message).toContain("status 128");
        expect(failingClone.calls.length).toBe(1);
        expect(treeBytes(retained)).toEqual(published);
        expect(retainedRecord(fixture, "octocat", "hello-world")).toEqual(recordBefore);
        expect((await discoverState(cloneClient)).retained).toHaveLength(1);
        expectNoCheckout(fixture);
      } finally {
        cloneClient.close();
        unclonable.server.stop(true);
      }
    },
    120_000,
  );

  test(
    "retains bytes while clearing, and removes exactly one project",
    async () => {
      const fixture = createFixture("remove");
      const clones = cloneHarness({ source: createSourceRepository("remove-source-one") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      const hostOmp = ompBytes(fixture.root);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
        clones.behavior.source = createSourceRepository("remove-source-two");
        await runRemote(client, "https://github.com/octocat/Second");
        const helloBytes = treeBytes(retainedDirectory(fixture, "octocat", "hello-world"));
        const secondBytes = treeBytes(retainedDirectory(fixture, "octocat", "second"));
        const callsBefore = clones.calls.length;

        const cleared = await clearRemote(client);
        expect(cleared.target).toEqual({ kind: "host" });
        expect(cleared.retained).toHaveLength(2);
        expect(existsSync(retainedDirectory(fixture, "octocat", "hello-world"))).toBe(true);
        expect(existsSync(retainedDirectory(fixture, "octocat", "second"))).toBe(true);
        expect(clones.calls.length).toBe(callsBefore);
        expect(ompBytes(fixture.root)).toEqual(hostOmp);

        // Clear again with no remote target is refused and changes nothing.
        const emptyClear = await refusal(client, { type: "clearDiscoverRemote" });
        expect(emptyClear).toContain("No remote Discover target");
        expect((await discoverState(client)).retained).toHaveLength(2);

        // Removing the inactive project leaves the active one untouched.
        const switched = await switchRemote(client, "https://github.com/octocat/Second");
        expect(switched.target).toMatchObject({ repo: "Second" });
        const afterRemove = await removeRemote(client, "https://github.com/octocat/Hello-World");
        expect(afterRemove.target).toMatchObject({ repo: "Second" });
        expect(afterRemove.retained.map((project) => project.url)).toEqual([
          "https://github.com/octocat/Second",
        ]);
        expect(existsSync(retainedDirectory(fixture, "octocat", "hello-world"))).toBe(false);
        expect(treeBytes(retainedDirectory(fixture, "octocat", "second"))).toEqual(secondBytes);
        expect(helloBytes.size).toBeGreaterThan(0);

        // An unknown URL is refused and changes nothing.
        const unknown = await refusal(client, {
          type: "removeDiscoverRemote",
          url: "https://github.com/octocat/Unknown",
        });
        expect(unknown).toContain("No retained Discover project");
        expect(scratchEntries(fixture)).toEqual(["octocat~second"]);
      } finally {
        client.close();
        first.server.stop(true);
      }

      // The removal persists through a restart.
      const second = startServer({ fixture, clone: cloneHarness() });
      const restored = await connect(second.url);
      try {
        const state = stateOf(await restored.take((message) => message.type === "discoverState"));
        expect(state.target).toMatchObject({ kind: "remote", repo: "Second" });
        expect(state.retained.map((project) => project.url)).toEqual([
          "https://github.com/octocat/Second",
        ]);
        expect(restored.events.some((message) => message.type === "discoverError")).toBe(false);
        // Removing the active project returns to the host target.
        const removed = await removeRemote(restored, "https://github.com/octocat/Second");
        expect(removed.target).toEqual({ kind: "host" });
        expect(removed.retained).toEqual([]);
        expect(scratchEntries(fixture)).toEqual([]);
      } finally {
        restored.close();
        second.server.stop(true);
      }
    },
    120_000,
  );

  test(
    "refuses switch, remove, and clear during a run without changing anything",
    async () => {
      const fixture = createFixture("run-refusal");
      const clones = cloneHarness({ source: createSourceRepository("run-refusal-source") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
        clones.behavior.source = createSourceRepository("run-refusal-source-two");
        await runRemote(client, "https://github.com/octocat/Second");
      } finally {
        client.close();
        first.server.stop(true);
      }
      const retainedBefore = treeBytes(retainedDirectory(fixture, "octocat", "second"));
      const helloBefore = treeBytes(retainedDirectory(fixture, "octocat", "hello-world"));

      const running = startServer({
        fixture,
        clone: cloneHarness({ source: createSourceRepository("run-refusal-source-three") }),
        stub: ["--discover", "--discover-no-exit"],
      });
      const runningClient = await connect(running.url);
      try {
        runningClient.take((message) => message.type === "discoverState");
        const started = runningClient.waitNext((message) => message.type === "discoverStarted");
        runningClient.send({ type: "discoverProject" });
        await started;
        const during = await discoverState(runningClient);
        expect(during.active).toBe(true);
        expect(during.target).toMatchObject({ kind: "remote", checkout: true });

        for (const command of [
          { type: "switchDiscoverRemote", url: "https://github.com/octocat/Hello-World" },
          { type: "removeDiscoverRemote", url: "https://github.com/octocat/Hello-World" },
          { type: "clearDiscoverRemote" },
        ]) {
          const message = await refusal(runningClient, command);
          expect(message).toContain("Discover run is active");
        }
        expect((await discoverState(runningClient)).target).toMatchObject({
          kind: "remote",
          repo: "Second",
        });
        expect(treeBytes(retainedDirectory(fixture, "octocat", "second"))).toEqual(retainedBefore);
        expect(treeBytes(retainedDirectory(fixture, "octocat", "hello-world"))).toEqual(helloBefore);

        const stopped = runningClient.waitNext((message) => message.type === "discoverStopped");
        runningClient.send({ type: "stopDiscover" });
        expect((await stopped).completed).toBe(false);
        expect((await discoverState(runningClient)).target).toMatchObject({ checkout: false });
        expectNoCheckout(fixture);
      } finally {
        runningClient.close();
        running.server.stop(true);
      }
    },
    120_000,
  );

  test(
    "falls back to the host when the active retained directory is missing and keeps the rest",
    async () => {
      const fixture = createFixture("missing");
      const clones = cloneHarness({ source: createSourceRepository("missing-source-one") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
        clones.behavior.source = createSourceRepository("missing-source-two");
        await runRemote(client, "https://github.com/octocat/Second");
      } finally {
        client.close();
        first.server.stop(true);
      }
      const helloBefore = treeBytes(retainedDirectory(fixture, "octocat", "hello-world"));
      rmSync(retainedDirectory(fixture, "octocat", "second"), { recursive: true, force: true });

      const guest = cloneHarness();
      const second = startServer({ fixture, clone: guest });
      const restored = await connect(second.url);
      try {
        const notice = restored.take((message) => message.type === "discoverError");
        const message = String((await notice).message);
        expect(message).toContain("missing");
        expect(message).toContain("https://github.com/octocat/Second");
        const state = await discoverState(restored);
        expect(state.target).toEqual({ kind: "host" });
        expect(state.retained.map((project) => project.url)).toEqual([
          "https://github.com/octocat/Hello-World",
        ]);
        expect(restored.events.filter((event) => event.type === "discoverError")).toHaveLength(1);
        expect(guest.calls.length).toBe(0);
        expect(existsSync(retainedDirectory(fixture, "octocat", "second"))).toBe(false);
        expect(treeBytes(retainedDirectory(fixture, "octocat", "hello-world"))).toEqual(helloBefore);
      } finally {
        restored.close();
        second.server.stop(true);
      }

      expect(persistedState(fixture).discoverTarget).toBeNull();
      expect(journalText(fixture)).toContain("discover-remote-missing");
      const third = startServer({ fixture, clone: cloneHarness() });
      const again = await connect(third.url);
      try {
        const state = await discoverState(again);
        expect(state.target).toEqual({ kind: "host" });
        expect(again.events.filter((event) => event.type === "discoverError")).toHaveLength(0);
        expect(state.retained).toHaveLength(1);
      } finally {
        again.close();
        third.server.stop(true);
      }
    },
    120_000,
  );

  test(
    "removes leftover staging and old checkouts at startup, keeping retained projects",
    async () => {
      const fixture = createFixture("hygiene");
      const clones = cloneHarness({ source: createSourceRepository("hygiene-source") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
      } finally {
        client.close();
        first.server.stop(true);
      }

      const scratch = remoteScratchRoot(fixture.stateDir);
      const retained = treeBytes(join(scratch, "octocat~hello-world"));
      mkdirSync(join(scratch, ".staging-leftover"), { recursive: true });
      mkdirSync(join(scratch, ".staging-retain-leftover"), { recursive: true });
      mkdirSync(join(scratch, "octocat-old", ".git"), { recursive: true });

      const second = startServer({ fixture, clone: cloneHarness() });
      const restored = await connect(second.url);
      try {
        expect(scratchEntries(fixture)).toEqual(["octocat~hello-world"]);
        expect(existsSync(join(scratch, ".staging-leftover"))).toBe(false);
        expect(existsSync(join(scratch, ".staging-retain-leftover"))).toBe(false);
        expect(existsSync(join(scratch, "octocat-old"))).toBe(false);
        expect(treeBytes(join(scratch, "octocat~hello-world"))).toEqual(retained);
        const state = stateOf(await restored.take((message) => message.type === "discoverState"));
        expect(state.target).toMatchObject({ kind: "remote", repo: "Hello-World" });
      } finally {
        restored.close();
        second.server.stop(true);
      }
    },
    60_000,
  );

  test(
    "startup hygiene never removes a transient another live dashboard owns",
    async () => {
      const fixture = createFixture("hygiene-owner");
      const scratch = remoteScratchRoot(fixture.stateDir);
      const owned = join(scratch, ".staging-run-live");
      const stale = join(scratch, ".staging-run-dead");
      mkdirSync(join(owned, ".git"), { recursive: true });
      mkdirSync(join(stale, ".git"), { recursive: true });
      const claims = join(scratch, ".runs");
      mkdirSync(claims, { recursive: true });

      // The claim file is the persisted contract between dashboard instances:
      // a live owner keeps its checkout, a dead one is swept.
      const live = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
      const dead = Bun.spawn({ cmd: ["true"], stdout: "ignore", stderr: "ignore" });
      const deadPid = dead.pid;
      await dead.exited;
      writeFileSync(
        join(claims, ".staging-run-live.json"),
        `${JSON.stringify({ pid: live.pid, claimedAt: new Date().toISOString() })}\n`,
      );
      writeFileSync(
        join(claims, ".staging-run-dead.json"),
        `${JSON.stringify({ pid: deadPid, claimedAt: new Date().toISOString() })}\n`,
      );

      try {
        cleanupRemoteScratch(scratch);
        expect(existsSync(owned)).toBe(true);
        expect(existsSync(join(claims, ".staging-run-live.json"))).toBe(true);
        expect(existsSync(stale)).toBe(false);
        expect(existsSync(join(claims, ".staging-run-dead.json"))).toBe(false);
      } finally {
        live.kill();
        await live.exited;
      }

      cleanupRemoteScratch(scratch);
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(claims)).toBe(false);
    },
    30_000,
  );

  test(
    "a second dashboard starting on the same state directory keeps a running crawl",
    async () => {
      const fixture = createFixture("shared-state");
      const first = startServer({
        fixture,
        clone: cloneHarness({ source: createSourceRepository("shared-state-source") }),
        stub: ["--discover", "--discover-no-exit"],
      });
      const client = await connect(first.url);
      const scratch = remoteScratchRoot(fixture.stateDir);
      try {
        const started = client.waitNext((message) => message.type === "discoverStarted");
        client.send({ type: "discoverRemote", url: "https://github.com/octocat/Hello-World" });
        await started;
        const checkoutName = scratchEntries(fixture).find((entry) =>
          entry.startsWith(".staging-"),
        );
        expect(checkoutName).toBeDefined();
        const checkout = join(scratch, checkoutName as string);
        expect(existsSync(join(checkout, ".git"))).toBe(true);

        const second = startServer({ fixture, clone: cloneHarness() });
        const other = await connect(second.url);
        try {
          expect(existsSync(checkout)).toBe(true);
          expect(existsSync(join(checkout, ".git"))).toBe(true);
          expect(existsSync(join(scratch, ".runs", `${checkoutName as string}.json`))).toBe(true);
        } finally {
          other.close();
          second.server.stop(true);
        }
      } finally {
        client.close();
        first.server.stop(true);
      }

      // The dashboard that owned the run removes its checkout and its claim.
      expect(
        scratchEntries(fixture).filter((entry) => entry.startsWith(".staging-")),
      ).toEqual([]);
      expect(existsSync(join(scratch, ".runs"))).toBe(false);
    },
    60_000,
  );

  test(
    "resumes a remote crawl on restart, re-cloning its own project and replacing the snapshot",
    async () => {
      const fixture = createFixture("interrupted");
      const source = createSourceRepository("interrupted-source");
      const clones = cloneHarness({ source });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
      } finally {
        client.close();
        first.server.stop(true);
      }
      const retained = retainedDirectory(fixture, "octocat", "hello-world");
      const before = treeBytes(retained);

      const running = startServer({
        fixture,
        clone: cloneHarness({ source: createSourceRepository("interrupted-source-two") }),
        stub: ["--discover", "--discover-no-exit"],
      });
      const runningClient = await connect(running.url);
      try {
        const started = runningClient.waitNext((message) => message.type === "discoverStarted");
        runningClient.send({ type: "discoverProject" });
        await started;
        expect(persistedState(fixture).discover).not.toBeNull();
        expect(
          scratchEntries(fixture).some((entry) => entry.startsWith(".staging-")),
        ).toBe(true);
      } finally {
        runningClient.close();
        running.server.stop(true);
      }

      const spawnsBefore = spawnCount(fixture.logPath);
      const resumedClones = cloneHarness({ source });
      const replacement = startServer({
        fixture,
        clone: resumedClones,
        stub: ["--discover", "--discover-delay-ms=500"],
      });
      const restored = await connect(replacement.url);
      try {
        // A resumed remote run re-clones the project the stored run named, not
        // the target that happens to be displayed.
        const resumed = await restored.take((message) => message.type === "discoverStarted");
        const stopped = await restored.take((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(true);
        const state = await discoverState(restored);
        expect(state.interrupted).toBe(false);
        expect(state.active).toBe(false);
        expect(state.target).toMatchObject({ kind: "remote", checkout: false });
        expect(state.sheet).not.toBeNull();
        expect(resumedClones.calls).toHaveLength(1);
        expect(resumedClones.calls[0]?.argv).toContain("https://github.com/octocat/Hello-World");
        const manifest = JSON.parse(
          readFileSync(join(retained, ".omp", "discover", "manifest.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(manifest.runId).toBe(resumed.runId);
        expect(treeBytes(retained)).not.toEqual(before);
        expect(scratchEntries(fixture)).toEqual(["octocat~hello-world"]);
        expectNoCheckout(fixture);
        expect(spawnCount(fixture.logPath)).toBe(spawnsBefore + 1);
        expect(persistedState(fixture).discover).toBeNull();
      } finally {
        restored.close();
        replacement.server.stop(true);
      }
    },
    120_000,
  );

  test(
    "saves skills and glossary decisions into the retained copy without a clone",
    async () => {
      const fixture = createFixture("retained-edits");
      const clones = cloneHarness({ source: createSourceRepository("retained-edits-source") });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      const hostOmp = ompBytes(fixture.root);
      try {
        const state = await runRemote(client, "https://github.com/octocat/Hello-World");
        const retained = retainedDirectory(fixture, "octocat", "hello-world");
        const skill = state.skills.find((entry) => entry.name === "discover-testing-strategy");
        expect(skill).toBeDefined();
        const live = String(skill?.live ?? skill?.baseline ?? "");
        const edited = await discoverStateAndMutation(client, {
          type: "saveDiscoverSkill",
          name: "discover-testing-strategy",
          text: `${live}\n- Retained edit.\n`,
          target: { kind: "remote", owner: "octocat", repo: "Hello-World" },
        });
        expect(
          readFileSync(join(retained, ".omp", "skills", "discover-testing-strategy", "SKILL.md"), "utf8"),
        ).toBe(`${live}\n- Retained edit.\n`);
        expect(edited.skills.find((entry) => entry.name === "discover-testing-strategy")?.state).toBe(
          "edited",
        );
        expectNoCheckout(fixture);

        const glossary = edited.glossaries[0] as Record<string, unknown>;
        const concept = (glossary.concepts as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
        await discoverStateAndMutation(client, {
          type: "rejectGlossaryTerm",
          context: glossary.boundedContext,
          id: concept.id,
          reason: "The retained fixture rejected this term.",
        });
        const decisions = JSON.parse(
          readFileSync(join(retained, ".omp", "discover", "decisions.json"), "utf8"),
        ) as Array<Record<string, unknown>>;
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({ action: "reject" });
        expect(ompBytes(fixture.root)).toEqual(hostOmp);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    90_000,
  );

  test(
    "retains distinct owner/repo pairs whose hyphenated names collide",
    () => {
      const scratch = testDirectory("identity-collision");
      const firstCheckout = testDirectory("identity-collision-first");
      const secondCheckout = testDirectory("identity-collision-second");
      const publish = (checkout: string, marker: string) => {
        mkdirSync(join(checkout, ".omp", "discover"), { recursive: true });
        mkdirSync(join(checkout, ".omp", "skills"), { recursive: true });
        writeFileSync(join(checkout, ".omp", "discover", "marker.txt"), marker);
        writeFileSync(join(checkout, ".omp", "skills", "marker.txt"), marker);
      };
      publish(firstCheckout, "first");
      publish(secondCheckout, "second");

      const firstRecord = {
        url: "https://github.com/a/b-c",
        owner: "a",
        repo: "b-c",
        completedAt: "2026-01-01T00:00:00.000Z",
      };
      const secondRecord = {
        url: "https://github.com/a-b/c",
        owner: "a-b",
        repo: "c",
        completedAt: "2026-01-02T00:00:00.000Z",
      };
      const firstDirectory = remoteProjectDirectory(scratch, "a", "b-c");
      const secondDirectory = remoteProjectDirectory(scratch, "a-b", "c");
      expect(firstDirectory).not.toBe(secondDirectory);
      expect(remoteCloneName("a", "b-c")).not.toBe(remoteCloneName("a-b", "c"));

      expect(retainRemoteProject(scratch, firstCheckout, firstRecord, "collision-first")).toBeNull();
      expect(retainRemoteProject(scratch, secondCheckout, secondRecord, "collision-second")).toBeNull();
      expect(listRetainedProjects(scratch).map((project) => project.url)).toEqual([
        secondRecord.url,
        firstRecord.url,
      ]);
      expect(readFileSync(join(firstDirectory, ".omp", "discover", "marker.txt"), "utf8")).toBe(
        "first",
      );
      expect(readFileSync(join(firstDirectory, ".omp", "skills", "marker.txt"), "utf8")).toBe(
        "first",
      );
      expect(readFileSync(join(secondDirectory, ".omp", "discover", "marker.txt"), "utf8")).toBe(
        "second",
      );
      expect(readFileSync(join(secondDirectory, ".omp", "skills", "marker.txt"), "utf8")).toBe(
        "second",
      );

      expect(removeRetainedProject(scratch, firstRecord)).toBeNull();
      expect(existsSync(firstDirectory)).toBe(false);
      expect(listRetainedProjects(scratch).map((project) => project.url)).toEqual([
        secondRecord.url,
      ]);
      expect(readFileSync(join(secondDirectory, ".omp", "discover", "marker.txt"), "utf8")).toBe(
        "second",
      );
      expect(readFileSync(join(secondDirectory, ".omp", "skills", "marker.txt"), "utf8")).toBe(
        "second",
      );
    },
    30_000,
  );
});

/** Sends one mutation and resolves with the first snapshot it broadcasts. */
async function discoverStateAndMutation(
  client: TestClient,
  command: unknown,
): Promise<DiscoverState> {
  const reply = client.waitNext((message) => message.type === "discoverState");
  client.send(command);
  return stateOf(await reply);
}

/** The Discover store normally runs in a browser tab; these globals stand in. */
function installDiscoverClientGlobals(host: string): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const previous = { window: target.window, location: target.location };
  target.window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
  target.location = { protocol: "http:", host };
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
  };
}

async function waitFor(predicate: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test(
  "a target switch never writes one retained project's draft into another",
  async () => {
    const fixture = createFixture("draft-scope");
    const clones = cloneHarness({ source: createSourceRepository("draft-scope-first") });
    const { server, url } = startServer({ fixture, clone: clones });
    const client = await connect(url);
    const firstUrl = "https://github.com/octocat/Alpha";
    const secondUrl = "https://github.com/octocat/Beta";
    const skillName = "discover-testing-strategy";
    const sockets = new ConnectionStore();
    const store = new DiscoverStore(sockets);
    const frames: Record<string, unknown>[] = [];
    let restoreGlobals: (() => void) | null = null;
    try {
      // Two retained projects, crawled in order, share the same five skills.
      await runRemote(client, firstUrl);
      clones.behavior.source = createSourceRepository("draft-scope-second");
      await runRemote(client, secondUrl);

      const alphaPath = join(
        retainedDirectory(fixture, "octocat", "alpha"),
        ".omp",
        "skills",
        skillName,
        "SKILL.md",
      );
      const betaPath = join(
        retainedDirectory(fixture, "octocat", "beta"),
        ".omp",
        "skills",
        skillName,
        "SKILL.md",
      );
      const alphaBefore = readFileSync(alphaPath);

      restoreGlobals = installDiscoverClientGlobals(url);
      sockets.onMessage((message) => {
        frames.push(message as Record<string, unknown>);
        store.handleEvent(message as Record<string, unknown>);
      });
      sockets.connect();
      await waitFor(() => sockets.open, "the Discover store connection");
      sockets.send({ type: "getDiscover" });
      await waitFor(
        () => store.target.kind === "remote" && store.target.repo === "Beta",
        "the Beta snapshot",
      );

      store.switchRemote(firstUrl);
      await waitFor(
        () => store.target.kind === "remote" && store.target.repo === "Alpha",
        "the Alpha snapshot",
      );
      const liveAlpha = store.skill(skillName)?.live ?? "";
      expect(liveAlpha.length).toBeGreaterThan(0);
      store.updateDraft(skillName, `${liveAlpha}\n- Edited against Alpha.\n`);
      expect(store.skillDirty(skillName)).toBe(true);

      store.switchRemote(secondUrl);
      await waitFor(
        () => store.target.kind === "remote" && store.target.repo === "Beta",
        "the Beta snapshot after the switch",
      );
      const liveBeta = store.skill(skillName)?.live ?? "";
      expect(liveBeta.length).toBeGreaterThan(0);
      expect(store.skillDraft(skillName)).toBe(liveBeta);
      expect(store.skillDirty(skillName)).toBe(false);

      const mark = frames.length;
      store.saveSkill(skillName);
      await waitFor(
        () =>
          frames
            .slice(mark)
            .some(
              (message) =>
                message.type === "discoverState" || message.type === "discoverError",
            ),
        "the save round trip",
      );
      expect(frames.slice(mark).filter((message) => message.type === "discoverError")).toEqual(
        [],
      );
      expect(readFileSync(alphaPath).equals(alphaBefore)).toBe(true);
      expect(readFileSync(betaPath, "utf8")).toBe(liveBeta);

      // A client still holding Alpha's draft may not write it into Beta.
      const refusalReply = client.waitNext((message) => message.type === "discoverError");
      client.send({
        type: "saveDiscoverSkill",
        name: skillName,
        text: `${liveAlpha}\n- Edited against Alpha.\n`,
        target: { kind: "remote", owner: "octocat", repo: "Alpha" },
      });
      expect(String((await refusalReply).message)).toContain("different Discover target");
      expect(readFileSync(alphaPath).equals(alphaBefore)).toBe(true);
      expect(readFileSync(betaPath, "utf8")).toBe(liveBeta);
    } finally {
      sockets.dispose();
      restoreGlobals?.();
      client.close();
      server.stop(true);
    }
  },
  120_000,
);
