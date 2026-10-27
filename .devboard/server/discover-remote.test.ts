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
import { join, relative, resolve, sep } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";
import {
  hostFacts,
  remoteScratchRoot,
  type RemoteCloneRequest,
  type RemoteCloneRunner,
} from "./discover";
import { readStateFile, stateFile } from "./state";

/**
 * Discover's remote target: the source-checkout gate, URL validation, the one
 * `git clone` child, target switching, run parity, durability, restart, and
 * clear. Every child is injected, every fixture lives under the harness
 * `.tmp`, and no test makes a network request.
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
      `${JSON.stringify({ name: "@dsdenes/devboard-harness", version: "0.0.0" }, null, 2)}\n`,
    );
    if (gate === "installed") {
      const installed = join(root, ".devboard", "node_modules", "@dsdenes", "devboard-harness");
      mkdirSync(installed, { recursive: true });
      writeFileSync(
        join(installed, "package.json"),
        `${JSON.stringify({ name: "@dsdenes/devboard-harness", version: "9.9.9" }, null, 2)}\n`,
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

function cloneDirectory(fixture: Fixture, owner: string, repo: string): string {
  return join(remoteScratchRoot(fixture.stateDir), `${owner}-${repo}`.toLowerCase());
}

function cloneRelative(fixture: Fixture, owner: string, repo: string): string {
  return relative(resolve(fixture.root), resolve(cloneDirectory(fixture, owner, repo)))
    .split(sep)
    .join("/");
}

function persistedState(fixture: Fixture, stateDir = fixture.stateDir): Record<string, unknown> {
  const loaded = readStateFile(stateFile(stateDir, resolve(fixture.root)));
  if (loaded.kind !== "loaded") throw new Error(`state file is ${loaded.kind}`);
  return loaded.value as Record<string, unknown>;
}

function hostStatus(fixture: Fixture): string {
  return gitRun(fixture.root, ["status", "--porcelain", "--untracked-files=all"]).stdout;
}

describe("discover remote target", () => {
  test(
    "exposes remote cloning only for a harness source checkout",
    async () => {
      const cases: Array<{ gate: Gate; available: boolean }> = [
        { gate: "source", available: true },
        { gate: "installed", available: false },
        { gate: "none", available: false },
      ];
      for (const entry of cases) {
        const fixture = createFixture(`gate-${entry.gate}`, entry.gate);
        const clones = cloneHarness({ source: createSourceRepository(`gate-source-${entry.gate}`) });
        const { server, url } = startServer({ fixture, clone: clones });
        const client = await connect(url);
        try {
          if (entry.available) {
            const replayed = stateOf(
              await client.take((message) => message.type === "discoverState"),
            );
            expect(replayed.remoteAvailable).toBe(true);
          }
          const initial = await discoverState(client);
          expect(initial.remoteAvailable).toBe(entry.available);
          expect(initial.repository).toBeNull();
          expect(initial.target).toEqual({ kind: "host" });
          expect(initial.cloning).toBeNull();

          if (entry.available) {
            const state = await runRemote(client, "https://github.com/octocat/Hello-World");
            expect(state.target).toMatchObject({ kind: "remote", owner: "octocat" });
            expect(state.repository).toBe("octocat/Hello-World");
            expect(clones.calls.length).toBe(1);
            continue;
          }

          const refused = client.waitNext((message) => message.type === "discoverError");
          client.send({ type: "discoverRemote", url: "https://github.com/octocat/Hello-World" });
          expect(String((await refused).message)).toContain("source checkout");
          expect(clones.calls.length).toBe(0);
          expect(scratchEntries(fixture)).toEqual([]);
          expect((await discoverState(client)).target).toEqual({ kind: "host" });

          const cleared = client.waitNext((message) => message.type === "discoverError");
          client.send({ type: "clearDiscoverRemote" });
          expect(String((await cleared).message)).toContain("source checkout");
          expect(clones.calls.length).toBe(0);
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
            cloneDir: cloneRelative(fixture, "octocat", "hello-world"),
          });
          const cleared = client.waitNext(
            (message) => message.type === "discoverState" && stateTargetKind(message, "host"),
          );
          client.send({ type: "clearDiscoverRemote" });
          await cleared;
        }
        const acceptedCount = clones.calls.length;
        expect(acceptedCount).toBe(4);

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
        expect(scratchEntries(fixture)).toEqual([]);
        expect((await discoverState(client)).target).toEqual({ kind: "host" });
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
        const refused = client.waitNext((message) => message.type === "discoverError");
        client.send({ type: "discoverRemote", url: "https://github.com/octocat/Hello-World" });
        const message = String((await refused).message);
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
        for (const command of [{ type: "discoverRemote" }, { type: "discoverRemote", url: 5 }]) {
          const reply = client.waitNext((message) => message.type === "error");
          client.send(command);
          expect(String((await reply).message)).toBe("Invalid WebSocket message.");
        }
        expect(clones.calls.length).toBe(0);
        expect((await discoverState(client)).target).toEqual({ kind: "host" });
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "runs exactly one bounded git clone and crawls the clone",
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

        const clone = cloneDirectory(fixture, "octocat", "hello-world");
        expect(existsSync(join(clone, ".git"))).toBe(true);
        expect(scratchEntries(fixture)).toEqual(["octocat-hello-world"]);
        expect(git(clone, ["rev-parse", "--show-toplevel"]).trim()).toBe(clone);
        expect(git(clone, ["rev-parse", "--short=7", "HEAD"]).trim().length).toBe(7);

        expect(state.target).toEqual({
          kind: "remote",
          url: "https://github.com/Octocat/Hello-World.git",
          owner: "Octocat",
          repo: "Hello-World",
          cloneDir: cloneRelative(fixture, "octocat", "hello-world"),
        });
        expect(state.cloning).toBeNull();
        expect(String((state.target as Record<string, unknown>).cloneDir).startsWith("/")).toBe(
          false,
        );

        expect(spawnCount(fixture.logPath)).toBe(1);
        const prompt = prompts(fixture.logPath)[0] ?? "";
        expect(prompt.startsWith(`/discover ${join(clone, ".omp", "discover", "staging")}`)).toBe(
          true,
        );
        expect(prompt).toMatch(/\/\.omp\/discover\/staging\/run-[a-z0-9-]+$/);
        expect(existsSync(join(clone, ".omp", "discover", "staging"))).toBe(false);
        expect(existsSync(join(clone, ".omp", "discover", "manifest.json"))).toBe(true);
        for (const name of DISCOVER_SKILLS) {
          expect(existsSync(join(clone, ".omp", "skills", name, "SKILL.md"))).toBe(true);
        }
        expect(state.sheet).not.toBeNull();
        expect(state.glossaries.length).toBe(1);
        expect(state.skills.map((skill) => skill.name)).toEqual([...DISCOVER_SKILLS]);

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
    "keeps the previous target when the clone exits, times out, or leaves nothing",
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
    "refuses a second clone, a clear, and a project start while cloning",
    async () => {
      const fixture = createFixture("cloning");
      const gate = Promise.withResolvers<void>();
      const clones = cloneHarness({
        source: createSourceRepository("cloning-source"),
        gate: { promise: gate.promise, release: () => gate.resolve() },
      });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      try {
        const cloning = client.waitNext(isCloningState);
        const refusals = [
          client.waitNext((message) => message.type === "discoverError"),
          client.waitNext((message) => message.type === "discoverError"),
          client.waitNext((message) => message.type === "discoverError"),
        ];
        const stopped = client.waitNext((message) => message.type === "discoverStopped");
        client.send({ type: "discoverRemote", url: "https://github.com/octocat/Hello-World" });
        await cloning;
        client.send({ type: "discoverRemote", url: "https://github.com/octocat/Other" });
        client.send({ type: "clearDiscoverRemote" });
        client.send({ type: "discoverProject" });
        await Promise.all(refusals);
        expect(clones.calls.length).toBe(1);
        expect(spawnCount(fixture.logPath)).toBe(0);

        gate.resolve();
        expect((await stopped).completed).toBe(true);
        expect(spawnCount(fixture.logPath)).toBe(1);
        expect(scratchEntries(fixture)).toEqual(["octocat-hello-world"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30_000,
  );

  test(
    "switches targets and removes the previous clone after the rename",
    async () => {
      const fixture = createFixture("switch");
      const clones = cloneHarness({ source: createSourceRepository("switch-source-one") });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
        expect(scratchEntries(fixture)).toEqual(["octocat-hello-world"]);

        clones.behavior.source = createSourceRepository("switch-source-two");
        const state = await runRemote(client, "https://github.com/octocat/Other");
        expect(state.target).toMatchObject({ owner: "octocat", repo: "Other" });
        expect(scratchEntries(fixture)).toEqual(["octocat-other"]);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    60_000,
  );

  test(
    "crawls, edits, and stops against the clone without touching the host",
    async () => {
      const fixture = createFixture("parity");
      const clones = cloneHarness({ source: createSourceRepository("parity-source") });
      const { server, url } = startServer({
        fixture,
        clone: clones,
        stub: ["--discover", "--discover-question"],
      });
      const client = await connect(url);
      const hostOmpBefore = ompBytes(fixture.root);
      const fingerprintBefore = hostFacts(fixture.root).fingerprint;
      const statusBefore = hostStatus(fixture);
      const clone = cloneDirectory(fixture, "octocat", "hello-world");
      try {
        const cloning = client.waitNext(isCloningState);
        const started = client.waitNext((message) => message.type === "discoverStarted");
        const question = client.waitNext((message) => message.type === "discoverQuestion");
        client.send({ type: "discoverRemote", url: "https://github.com/octocat/Hello-World" });
        await cloning;
        await started;
        const asked = await question;
        const answered = client.waitNext(
          (message) => message.type === "discoverActivity" && message.append !== true,
        );
        client.send({ type: "answerDiscover", id: asked.id, value: "Alpha" });
        await answered;
        const stopped = client.waitNext((message) => message.type === "discoverStopped");
        expect((await stopped).completed).toBe(true);
        const state = await discoverState(client);

        // A skill save lands in the clone and updates its manifest.
        const skill = state.skills.find((entry) => entry.name === "discover-testing-strategy");
        expect(skill).toBeDefined();
        const live = String(skill?.live ?? skill?.baseline ?? "");
        const editedText = `${live}\n- Remote edit.\n`;
        const saved = await discoverStateAndMutation(client, {
          type: "saveDiscoverSkill",
          name: "discover-testing-strategy",
          text: editedText,
        });
        expect(
          readFileSync(join(clone, ".omp", "skills", "discover-testing-strategy", "SKILL.md"), "utf8"),
        ).toBe(editedText);
        expect(
          saved.skills.find((entry) => entry.name === "discover-testing-strategy")?.state,
        ).toBe("edited");
        expect(
          String(
            (saved.manifest as Record<string, unknown>).fingerprint ?? "",
          ).length,
        ).toBe(64);

        // A glossary decision lands in the clone's decisions.json.
        const glossary = saved.glossaries[0] as Record<string, unknown>;
        const concept = (glossary.concepts as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
        const decided = await discoverStateAndMutation(client, {
          type: "rejectGlossaryTerm",
          context: glossary.boundedContext,
          id: concept.id,
          reason: "The remote fixture rejected this term.",
        });
        const decisions = JSON.parse(
          readFileSync(join(clone, ".omp", "discover", "decisions.json"), "utf8"),
        ) as Array<Record<string, unknown>>;
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({
          context: glossary.boundedContext,
          id: concept.id,
          action: "reject",
          reason: "The remote fixture rejected this term.",
        });
        expect(decided.decisions).toHaveLength(1);

        const cloneOmpAfterEdits = ompBytes(clone);

        // A stopped run removes only the clone's staging.
        const startedAgain = client.waitNext((message) => message.type === "discoverStarted");
        const questionAgain = client.waitNext((message) => message.type === "discoverQuestion");
        client.send({ type: "discoverProject" });
        await startedAgain;
        await questionAgain;
        const stoppedRun = client.waitNext((message) => message.type === "discoverStopped");
        client.send({ type: "stopDiscover" });
        expect((await stoppedRun).completed).toBe(false);
        expect(existsSync(join(clone, ".omp", "discover", "staging"))).toBe(false);
        expect(ompBytes(clone)).toEqual(cloneOmpAfterEdits);

        // Every remote write stayed inside the clone.
        expect(ompBytes(fixture.root)).toEqual(hostOmpBefore);
        expect(hostFacts(fixture.root).fingerprint).toBe(fingerprintBefore);
        expect(hostStatus(fixture)).toBe(statusBefore);
        expect(existsSync(join(fixture.root, ".omp", "discover"))).toBe(false);
        expect(existsSync(join(fixture.root, ".omp", "skills"))).toBe(false);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    90_000,
  );

  test(
    "clears a remote target back to this checkout's artifacts",
    async () => {
      const fixture = createFixture("clear");
      const clones = cloneHarness({ source: createSourceRepository("clear-source") });
      const { server, url } = startServer({ fixture, clone: clones });
      const client = await connect(url);
      try {
        const hostState = await runProject(client);
        const statusBefore = hostStatus(fixture);
        const hostOmp = ompBytes(fixture.root);
        const hostFingerprint = String(
          (hostState.manifest as Record<string, unknown>).fingerprint ?? "",
        );
        expect(hostFingerprint.length).toBe(64);

        const remoteState = await runRemote(client, "https://github.com/octocat/Hello-World");
        expect(remoteState.target).toMatchObject({ kind: "remote" });
        expect(ompBytes(fixture.root)).toEqual(hostOmp);
        expect(scratchEntries(fixture)).toEqual(["octocat-hello-world"]);

        const cleared = client.waitNext(
          (message) => message.type === "discoverState" && stateTargetKind(message, "host"),
        );
        client.send({ type: "clearDiscoverRemote" });
        const afterClear = stateOf(await cleared);
        expect(afterClear.target).toEqual({ kind: "host" });
        expect(scratchEntries(fixture)).toEqual([]);
        expect(existsSync(cloneDirectory(fixture, "octocat", "hello-world"))).toBe(false);
        expect(
          String((afterClear.manifest as Record<string, unknown>).fingerprint ?? ""),
        ).toBe(hostFingerprint);
        expect(ompBytes(fixture.root)).toEqual(hostOmp);
        expect(hostStatus(fixture)).toBe(statusBefore);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    60_000,
  );

  test(
    "stores only the URL and names and restores the clone without a re-crawl",
    async () => {
      const fixture = createFixture("durable");
      const clones = cloneHarness({ source: createSourceRepository("durable-source") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
      } finally {
        client.close();
        first.server.stop(true);
      }

      const stored = persistedState(fixture);
      expect(stored.discoverTarget).toEqual({
        url: "https://github.com/octocat/Hello-World",
        owner: "octocat",
        repo: "Hello-World",
      });
      const stateText = readFileSync(stateFile(fixture.stateDir, resolve(fixture.root)), "utf8");
      expect(stateText).not.toContain(remoteScratchRoot(fixture.stateDir));
      expect(stateText).not.toContain(fixture.root);

      const clone = cloneDirectory(fixture, "octocat", "hello-world");
      const cloneOmp = ompBytes(clone);
      const publishedAt = String(
        (
          JSON.parse(readFileSync(join(clone, ".omp", "discover", "manifest.json"), "utf8")) as Record<
            string,
            unknown
          >
        ).publishedAt,
      );
      const spawnsBefore = spawnCount(fixture.logPath);

      const second = startServer({ fixture, clone: cloneHarness() });
      const restoredClient = await connect(second.url);
      try {
        const replay = restoredClient.take((message) => message.type === "discoverState");
        const state = stateOf(await replay);
        expect(state.target).toMatchObject({ kind: "remote", owner: "octocat" });
        expect(state.cloning).toBeNull();
        expect(state.sheet).not.toBeNull();
        expect(restoredClient.events.some((message) => message.type === "discoverError")).toBe(false);
        expect(spawnCount(fixture.logPath)).toBe(spawnsBefore);
        expect(ompBytes(clone)).toEqual(cloneOmp);
        expect(
          (
            JSON.parse(readFileSync(join(clone, ".omp", "discover", "manifest.json"), "utf8")) as Record<
              string,
              unknown
            >
          ).publishedAt,
        ).toBe(publishedAt);
      } finally {
        restoredClient.close();
        second.server.stop(true);
      }
    },
    60_000,
  );

  test(
    "removes leftover staging and foreign clones at startup",
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
      mkdirSync(join(scratch, ".staging-leftover"), { recursive: true });
      mkdirSync(join(scratch, "foreign-repo"), { recursive: true });

      const second = startServer({ fixture, clone: cloneHarness() });
      try {
        expect(scratchEntries(fixture)).toEqual(["octocat-hello-world"]);
        expect(existsSync(join(scratch, ".staging-leftover"))).toBe(false);
        expect(existsSync(join(scratch, "foreign-repo"))).toBe(false);
      } finally {
        second.server.stop(true);
      }
    },
    60_000,
  );

  test(
    "falls back to the host target and reports a missing clone once",
    async () => {
      const fixture = createFixture("missing");
      const clones = cloneHarness({ source: createSourceRepository("missing-source") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
      } finally {
        client.close();
        first.server.stop(true);
      }
      rmSync(join(cloneDirectory(fixture, "octocat", "hello-world"), ".git"), {
        recursive: true,
        force: true,
      });

      const second = startServer({ fixture, clone: cloneHarness() });
      const restored = await connect(second.url);
      try {
        const notice = restored.take((message) => message.type === "discoverError");
        const message = String((await notice).message);
        expect(message).toContain("missing");
        expect(message).toContain("https://github.com/octocat/Hello-World");
        const state = await discoverState(restored);
        expect(state.target).toEqual({ kind: "host" });
        expect(state.sheet).toBeNull();
        expect(
          restored.events.filter((event) => event.type === "discoverError"),
        ).toHaveLength(1);
      } finally {
        restored.close();
        second.server.stop(true);
      }
    },
    60_000,
  );

  test(
    "a failed remote crawl keeps the clone's published artifacts and target",
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
      const clone = cloneDirectory(fixture, "octocat", "hello-world");
      const published = ompBytes(clone);

      const second = startServer({
        fixture,
        clone: cloneHarness(),
        stub: ["--discover", "--discover-invalid-sheet"],
      });
      const restored = await connect(second.url);
      try {
        const replay = restored.take((message) => message.type === "discoverState");
        expect(stateOf(await replay).target).toMatchObject({ kind: "remote" });
        const started = restored.waitNext((message) => message.type === "discoverStarted");
        const failed = restored.waitNext((message) => message.type === "discoverError");
        const stopped = restored.waitNext((message) => message.type === "discoverStopped");
        restored.send({ type: "discoverProject" });
        await started;
        expect(String((await failed).message)).toContain("Discover failed");
        expect((await stopped).completed).toBe(false);
        expect(ompBytes(clone)).toEqual(published);
        expect(existsSync(join(clone, ".omp", "discover", "staging"))).toBe(false);
        expect((await discoverState(restored)).target).toMatchObject({ kind: "remote" });
      } finally {
        restored.close();
        second.server.stop(true);
      }
    },
    90_000,
  );

  test(
    "interrupts a remote crawl on restart and never resumes its staging",
    async () => {
      const fixture = createFixture("interrupted");
      const clones = cloneHarness({ source: createSourceRepository("interrupted-source") });
      const first = startServer({ fixture, clone: clones });
      const client = await connect(first.url);
      try {
        await runRemote(client, "https://github.com/octocat/Hello-World");
      } finally {
        client.close();
        first.server.stop(true);
      }
      const clone = cloneDirectory(fixture, "octocat", "hello-world");
      const published = ompBytes(clone);

      const running = startServer({ fixture, clone: cloneHarness(), stub: ["--discover", "--discover-no-exit"] });
      const runningClient = await connect(running.url);
      try {
        const started = runningClient.waitNext((message) => message.type === "discoverStarted");
        runningClient.send({ type: "discoverProject" });
        await started;
        expect(persistedState(fixture).discover).not.toBeNull();
        expect(existsSync(join(clone, ".omp", "discover", "staging"))).toBe(true);
      } finally {
        runningClient.close();
        running.server.stop(true);
      }

      const spawnsBefore = spawnCount(fixture.logPath);
      const replacement = startServer({ fixture, clone: cloneHarness() });
      const restored = await connect(replacement.url);
      try {
        const notice = restored.take((message) => message.type === "discoverError");
        expect(String((await notice).message)).toContain("interrupted");
        const state = await discoverState(restored);
        expect(state.interrupted).toBe(true);
        expect(state.active).toBe(false);
        expect(state.target).toMatchObject({ kind: "remote" });
        expect(state.sheet).not.toBeNull();
        expect(ompBytes(clone)).toEqual(published);
        expect(
          readdirSync(join(clone, ".omp", "discover"), { withFileTypes: true })
            .filter((entry) => entry.name === "staging")
            .map((entry) => entry.name),
        ).toEqual([]);
        expect(spawnCount(fixture.logPath)).toBe(spawnsBefore);
        expect(persistedState(fixture).discover).toBeNull();
      } finally {
        restored.close();
        replacement.server.stop(true);
      }
    },
    120_000,
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
