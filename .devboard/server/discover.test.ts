import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "./app";

/**
 * Discover Mode's deterministic contract. It drives the app over its WebSocket
 * with the stub ACP peer and a real git fixture host under the harness `.tmp`,
 * never outside the repository root.
 */

const STUB_AGENT = join(import.meta.dir, "fixtures", "stub-agent.ts");
const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "discover-tests");
const GOAL_TEXT = "# Fixture goal\n\nKeep the fixture buildable.\n";
const DISCOVER_SKILLS = [
  "discover-testing-strategy",
  "discover-naming-conventions",
  "discover-coding-conventions",
  "discover-architecture-boundaries",
  "discover-glossary",
];

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

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=Discover Fixture",
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

const GITIGNORE = [
  ".worktree/",
  "node_modules/",
  "state/",
  "origin.git/",
  "*.log",
  ".env",
  "",
].join("\n");

interface Fixture {
  root: string;
  goalFile: string;
  adrDir: string;
  stateDir: string;
  logPath: string;
}

function createFixture(name: string, options: { goal?: boolean; dirty?: boolean } = {}): Fixture {
  const root = testDirectory(name);
  mkdirSync(join(root, "adrs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Fixture\n\nA small fixture host for Discover.\n");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-host", scripts: { build: "bun run build:src", test: "bun test" } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "src", "order.ts"), "export const orderTotal = (total: number): number => total;\n");
  writeFileSync(
    join(root, "test", "order.test.ts"),
    'import { test, expect } from "bun:test";\ntest("order total", () => expect(1).toBe(1));\n',
  );
  writeFileSync(
    join(root, ".github", "workflows", "ci.yml"),
    "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n",
  );
  writeFileSync(join(root, "adrs", "0001-fixture.md"), "# Fixture decision\n\n- Status: Accepted\n");
  if (options.goal !== false) writeFileSync(join(root, "GOAL.md"), GOAL_TEXT);
  writeFileSync(join(root, ".gitignore"), GITIGNORE);
  git(root, ["init", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "chore: fixture base"]);
  git(root, ["init", "--bare", join(root, "origin.git")]);
  git(root, ["remote", "add", "origin", join(root, "origin.git")]);
  git(root, ["push", "-u", "origin", "main"]);
  if (options.dirty === true) writeFileSync(join(root, "src", "dirty.ts"), "export const dirty = true;\n");

  return {
    root,
    goalFile: join(root, "GOAL.md"),
    adrDir: join(root, "adrs"),
    stateDir: join(root, "state"),
    logPath: join(root, "agent.log"),
  };
}

interface TestServer {
  server: Server<unknown>;
  fixture: Fixture;
  url: string;
}

interface StartOptions {
  fixture?: Fixture;
  stub?: string[];
  stateDir?: string;
}

function startServer(options: StartOptions = {}): TestServer {
  const fixture = options.fixture ?? createFixture("discover");
  const stateDir = options.stateDir ?? fixture.stateDir;
  const command = [`bun ${STUB_AGENT}`, `--log=${fixture.logPath}`, ...(options.stub ?? ["--discover"])];
  const server = createApp({
    adrDir: fixture.adrDir,
    staticDir: join(fixture.root, "static"),
    hostname: "127.0.0.1",
    port: 0,
    repoDir: fixture.root,
    stateDir,
    goalFile: fixture.goalFile,
    agentCommand: command.join(" "),
    tracker: async () => undefined,
    trackerSettle: { attempts: 1 },
  });
  const url = `127.0.0.1:${server.port}`;
  fixturesByUrl.set(url, fixture);
  return { server, fixture, url };
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
    reject: (error: Error) => void;
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
        const { promise: waiting, resolve: settle } = Promise.withResolvers<Record<string, unknown>>();
        waiters.push({ predicate, resolve: settle, reject: () => {} });
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

async function waitUntil(predicate: () => boolean, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  if (!predicate()) throw new Error(label);
}

interface DiscoverState {
  active: boolean;
  runId: string | null;
  interrupted: boolean;
  stale: boolean;
  warnings: string[];
  busy: string | null;
  error: string | null;
  manifest: Record<string, unknown> | null;
  freshness: Record<string, unknown> | null;
  sheet: Record<string, unknown> | null;
  glossaries: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  skills: Record<string, unknown>[];
}

function stateOf(message: Record<string, unknown>): DiscoverState {
  return message.state as DiscoverState;
}

const discoverStates = (client: TestClient) =>
  client.events.filter((message) => message.type === "discoverState");

/** Sends one command and resolves with the first discoverState it produced. */
async function afterCommand(
  client: TestClient,
  command: unknown,
): Promise<DiscoverState> {
  const before = discoverStates(client).length;
  client.send(command);
  await waitUntil(
    () => discoverStates(client).length > before,
    "discoverState after command",
  );
  return stateOf(discoverStates(client)[discoverStates(client).length - 1] as Record<string, unknown>);
}

async function discoverState(client: TestClient): Promise<DiscoverState> {
  return afterCommand(client, { type: "getDiscover" });
}

async function runDiscover(client: TestClient): Promise<DiscoverState> {
  client.send({ type: "discoverProject" });
  await client.waitFor((message) => message.type === "discoverStarted");
  const stopped = await client.waitFor((message) => message.type === "discoverStopped");
  expect(stopped.completed).toBe(true);
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
    ...[...treeBytes(join(root, ".omp", "discover"))].map(([path, bytes]) => [
      `.omp/discover/${path}`,
      bytes,
    ] as const),
    ...[...treeBytes(join(root, ".omp", "skills"))].map(([path, bytes]) => [
      `.omp/skills/${path}`,
      bytes,
    ] as const),
  ]);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const SECRET_PATTERN = /(?:ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})/;

function leaves(node: unknown, trail: string, out: Array<{ path: string; leaf: Record<string, unknown> }>) {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (const entry of node) leaves(entry, trail, out);
    return;
  }
  const record = node as Record<string, unknown>;
  if ("confidence" in record && "evidence" in record) {
    out.push({ path: trail, leaf: record });
    return;
  }
  for (const [key, value] of Object.entries(record)) leaves(value, `${trail}.${key}`, out);
}

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, out);
  else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) stringsIn(entry, out);
  }
  return out;
}

describe("discover mode", () => {
  test(
    "connects idle, reports an empty state, and never starts a run by itself",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        const initial = await discoverState(client);
        expect(initial).toMatchObject({
          active: false,
          runId: null,
          sheet: null,
          manifest: null,
          glossaries: [],
          skills: [],
          interrupted: false,
          busy: null,
        });
        await Bun.sleep(200);
        expect(spawnCount(fixture.logPath)).toBe(0);
        expect(client.events.some((message) => message.type === "discoverStarted")).toBe(false);
        expect(client.events.some((message) => message.type === "activity")).toBe(false);
        expect(client.events.some((message) => message.type === "question")).toBe(false);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    15000,
  );

  test(
    "publishes one peer's staged sheet, glossaries, and five skills atomically",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      const goalBefore = readFileSync(fixture.goalFile);
      const adrBefore = treeBytes(fixture.adrDir);
      try {
        const state = await runDiscover(client);

        expect(spawnCount(fixture.logPath)).toBe(1);
        const prompt = prompts(fixture.logPath)[0] ?? "";
        expect(prompt).toMatch(/^\/discover .*\.omp\/discover\/staging\/run-/);
        expect(prompt).not.toContain(".omp/discover/staging/run- \n");

        const manifest = state.manifest as Record<string, unknown>;
        expect(manifest).not.toBeNull();
        expect(manifest.schemaVersion).toBe(1);
        expect(typeof manifest.fingerprint).toBe("string");
        expect(String(manifest.runId)).toMatch(/^run-/);
        expect(typeof manifest.sheetDigest).toBe("string");
        const digests = manifest.glossaryDigests as Record<string, string>;
        expect(Object.keys(digests)).toEqual(["orders"]);
        const skills = manifest.skills as Array<Record<string, unknown>>;
        expect(skills.map((skill) => skill.name)).toEqual(DISCOVER_SKILLS);
        for (const skill of skills) {
          expect(skill.state).toBe("generated");
          expect(skill.baselineHash).toBe(skill.currentHash);
        }
        const paths = manifest.paths as Record<string, unknown>;
        for (const value of stringsIn(paths)) {
          expect(value.startsWith("/")).toBe(false);
          expect(value).not.toMatch(/[A-Za-z]:\\/);
        }

        // The published set exists exactly where the contract puts it.
        const root = fixture.root;
        for (const relative of [
          ".omp/discover/manifest.json",
          ".omp/discover/sheet.json",
          ".omp/discover/decisions.json",
          ".omp/discover/glossary/orders.glossary.yaml",
          ...DISCOVER_SKILLS.map((name) => `.omp/discover/skills/${name}/SKILL.md`),
          ...DISCOVER_SKILLS.map((name) => `.omp/skills/${name}/SKILL.md`),
        ]) {
          expect(existsSync(join(root, relative))).toBe(true);
        }
        expect(existsSync(join(root, ".omp", "discover", "staging"))).toBe(false);

        // The sheet is data, not prose, and every non-unknown leaf is grounded.
        const sheet = state.sheet as Record<string, unknown>;
        expect(Object.keys(sheet)).toEqual([
          "schemaVersion",
          "freshness",
          "definition",
          "stack",
          "deployment",
          "environments",
          "commands",
          "branching",
          "testing",
          "architecture",
          "ci",
          "runtime",
          "dependencyMap",
          "delivery",
        ]);
        const freshness = sheet.freshness as Record<string, unknown>;
        expect(String(freshness.commit).length).toBe(7);
        expect(freshness.dirty).toBe(false);
        expect(freshness.fingerprint).toBe(manifest.fingerprint);
        const definition = sheet.definition as Record<string, unknown>;
        const definitionText = String(definition.value);
        expect(definitionText.endsWith(".")).toBe(true);
        expect(definitionText.match(/[.!?](\s|$)/g)?.length).toBe(1);
        expect(definitionText.length).toBeLessThanOrEqual(240);

        const allLeaves: Array<{ path: string; leaf: Record<string, unknown> }> = [];
        leaves(sheet, "sheet", allLeaves);
        expect(allLeaves.length).toBeGreaterThan(20);
        for (const { path, leaf } of allLeaves) {
          expect(["observed", "declared", "inferred", "unknown"]).toContain(String(leaf.confidence));
          const evidence = leaf.evidence as string[];
          if (leaf.confidence === "unknown") {
            expect(evidence).toEqual([]);
            expect(String(leaf.reason).trim().length).toBeGreaterThan(0);
            expect(leaf.value).toBeNull();
          } else {
            expect(evidence.length).toBeGreaterThan(0);
            expect(evidence).toEqual([...new Set(evidence)].sort());
            for (const entry of evidence) {
              expect(entry.startsWith("/")).toBe(false);
              expect(entry.split("/")).not.toContain("..");
            }
          }
          for (const value of stringsIn(leaf.value)) {
            expect(value.includes("\n")).toBe(false);
            expect(value.length).toBeLessThanOrEqual(160);
            expect(value.startsWith("/")).toBe(false);
            expect(value).not.toMatch(SECRET_PATTERN);
          }
          expect(path.length).toBeGreaterThan(0);
        }

        // The glossary is a complete UbiLang document.
        expect(state.glossaries.length).toBe(1);
        const glossary = state.glossaries[0] as Record<string, unknown>;
        expect(glossary.boundedContext).toBe("orders");
        const concepts = glossary.concepts as Array<Record<string, unknown>>;
        expect(concepts.length).toBeGreaterThanOrEqual(1);
        const ids = new Set<string>();
        for (const concept of concepts) {
          const id = String(concept.id);
          expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
          expect(ids.has(id)).toBe(false);
          ids.add(id);
          expect(["unconfirmed", "proposed"]).toContain(String(concept.status));
          expect(["owner", "standard", "llm"]).toContain(String(concept.origin));
          expect(["entity", "event", "field", "role", "actor", "value", "rule"]).toContain(
            String(concept.kind),
          );
          const definitions = concept.definitions as Array<Record<string, unknown>>;
          expect(definitions.some((entry) => entry.language === "en")).toBe(true);
          const grounding = concept.grounding as string[];
          expect(grounding.length).toBeGreaterThan(0);
          for (const entry of grounding) expect(entry).toMatch(/^(code|model):/);
          const prefLabels = concept.prefLabels as Array<Record<string, unknown>>;
          for (const label of prefLabels) expect(["en", "de"]).toContain(String(label.language));
        }

        // Artifacts hold no secret value and no absolute host path.
        for (const [, bytes] of ompBytes(root)) {
          const text = Buffer.from(bytes, "base64").toString("utf8");
          expect(text).not.toMatch(SECRET_PATTERN);
          expect(text).not.toMatch(/\/home\/|\/Users\/|[A-Za-z]:\\\\/);
        }

        expect(readFileSync(fixture.goalFile)).toEqual(goalBefore);
        expect(treeBytes(fixture.adrDir)).toEqual(adrBefore);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "starts one peer per click, stages under .omp/discover/staging, and stops without publishing",
    async () => {
      const { server, fixture, url } = startServer({ stub: ["--discover", "--discover-no-exit", "--delay-ms=60000"] });
      const client = await connect(url);
      try {
        client.send({ type: "discoverProject" });
        const started = await client.waitFor((message) => message.type === "discoverStarted");
        expect(started.runId).toMatch(/^run-/);
        await waitUntil(
          () => existsSync(join(fixture.root, ".omp", "discover", "staging", String(started.runId))),
          "staging directory exists",
        );
        await waitUntil(() => spawnCount(fixture.logPath) === 1, "peer announced");
        const prompt = prompts(fixture.logPath)[0] ?? "";
        expect(prompt).toBe(
          `/discover ${join(fixture.root, ".omp", "discover", "staging", String(started.runId))}`,
        );

        // A second start is refused with one error and spawns nothing.
        client.send({ type: "discoverProject" });
        const refusal = await client.waitFor((message) => message.type === "discoverError");
        expect(String(refusal.message)).toContain("already active");
        expect(spawnCount(fixture.logPath)).toBe(1);

        client.send({ type: "stopDiscover" });
        const stopped = await client.waitFor((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(false);
        await waitUntil(
          () => !existsSync(join(fixture.root, ".omp", "discover", "staging", String(started.runId))),
          "staging removed on stop",
        );
        const state = await discoverState(client);
        expect(state.active).toBe(false);
        expect(state.sheet).toBeNull();
        expect(spawnCount(fixture.logPath)).toBe(1);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "replays state, activity, and a pending question to a reconnecting client, and answers once",
    async () => {
      const { server, url } = startServer({
        stub: ["--discover", "--discover-question", "--discover-no-exit", "--delay-ms=60000"],
      });
      const first = await connect(url);
      const second = await connect(url);
      try {
        first.send({ type: "discoverProject" });
        await first.waitFor((message) => message.type === "discoverStarted");
        await first.waitFor((message) => message.type === "discoverQuestion");

        const replay = await connect(url);
        try {
          await waitUntil(() => replay.events.length >= 4, "replay delivered", 3000);
          const types = replay.events.slice(0, 6).map((message) => String(message.type));
          expect(types[0]).toBe("discoverState");
          expect(types[1]).toBe("discoverStarted");
          expect(types).toContain("discoverActivity");
          expect(types).toContain("discoverQuestion");

          const question = await replay.waitFor((message) => message.type === "discoverQuestion");
          replay.send({ type: "answerDiscover", id: question.id, value: "Alpha" });
          await first.waitFor(
            (message) =>
              message.type === "discoverActivity" &&
              String(message.text).includes("Answer received: Alpha"),
          );

          replay.send({ type: "answerDiscover", id: question.id, value: "Alpha" });
          const stale = await replay.waitFor((message) => message.type === "discoverError");
          expect(String(stale.message)).toMatch(/pending/);
          replay.send({ type: "answerDiscover", id: question.id, value: "  " });
          const empty = await replay.waitFor((message) => message.type === "discoverError");
          expect(String(empty.message)).toMatch(/non-empty/);

          // Discover events never borrow Goal Mode's channels.
          for (const client of [first, second, replay]) {
            expect(client.events.some((message) => message.type === "activity")).toBe(false);
            expect(client.events.some((message) => message.type === "question")).toBe(false);
            expect(client.events.some((message) => message.type === "error")).toBe(false);
            expect(client.events.some((message) => message.type === "runStarted")).toBe(false);
          }
        } finally {
          replay.close();
        }
      } finally {
        first.close();
        second.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "fails atomically for every invalid staged set and leaves the published artifacts byte-identical",
    async () => {
      const variants = [
        "--discover-invalid-sheet",
        "--discover-sheet-absolute",
        "--discover-sheet-no-evidence",
        "--discover-sheet-secret",
        "--discover-sheet-two-sentences",
        "--discover-glossary-invalid",
        "--discover-glossary-grounding",
        "--discover-missing-artifact",
        "--discover-extra-artifact",
        "--discover-write-outside",
        "--discover-error",
      ];

      for (const variant of variants) {
        const fixture = createFixture(`failure-${variant.replace(/^--/, "")}`);
        const healthy = startServer({ fixture });
        const client = await connect(healthy.url);
        let before: Map<string, string>;
        try {
          await runDiscover(client);
          before = ompBytes(fixture.root);
          expect(before.size).toBeGreaterThan(0);
        } finally {
          client.close();
          healthy.server.stop(true);
        }

        const failing = startServer({ fixture, stub: ["--discover", variant] });
        const failingClient = await connect(failing.url);
        try {
          failingClient.send({ type: "discoverProject" });
          await failingClient.waitFor((message) => message.type === "discoverStarted");
          const errored = await failingClient.waitFor((message) => message.type === "discoverError");
          expect(String(errored.message).trim().length).toBeGreaterThan(0);
          const stopped = await failingClient.waitFor((message) => message.type === "discoverStopped");
          expect(stopped.completed).toBe(false);

          expect(ompBytes(fixture.root)).toEqual(before);
          const stagingRoot = join(fixture.root, ".omp", "discover", "staging");
          expect(existsSync(stagingRoot) ? readdirSync(stagingRoot).length : 0).toBe(0);
          expect(failingClient.events.filter((message) => message.type === "discoverError").length).toBe(1);
        } finally {
          failingClient.close();
          failing.server.stop(true);
        }
      }
    },
    120000,
  );

  test(
    "refuses a generate name that collides with another family and publishes nothing",
    async () => {
      const fixture = createFixture("collision");
      mkdirSync(join(fixture.root, ".omp", "skills", "discover-testing-strategy"), { recursive: true });
      writeFileSync(
        join(fixture.root, ".omp", "skills", "discover-testing-strategy", "SKILL.md"),
        [
          "---",
          "name: discover-testing-strategy",
          "description: A prepare-family skill that owns this name.",
          "metadata:",
          '  devboard-managed: "true"',
          '  devboard-family: "prepare"',
          "---",
          "",
          "- Always keep the prepare policy.",
          "",
        ].join("\n"),
      );
      const { server, url } = startServer({ fixture });
      const client = await connect(url);
      try {
        client.send({ type: "discoverProject" });
        await client.waitFor((message) => message.type === "discoverStarted");
        const errored = await client.waitFor((message) => message.type === "discoverError");
        expect(String(errored.message)).toContain("discover-testing-strategy");
        await client.waitFor((message) => message.type === "discoverStopped");
        expect(existsSync(join(fixture.root, ".omp", "discover", "manifest.json"))).toBe(false);
        expect(readFileSync(join(fixture.root, ".omp", "skills", "discover-testing-strategy", "SKILL.md"), "utf8")).toContain(
          "prepare-family",
        );
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "preserves edited skills across a re-crawl, refuses invalid saves, and restores missing skills",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        await runDiscover(client);
        const editedName = "discover-coding-conventions";
        const livePath = join(fixture.root, ".omp", "skills", editedName, "SKILL.md");
        const original = readFileSync(livePath, "utf8");
        const edited = original.replace(
          "- Handle recoverable errors at the caller",
          "- Handle recoverable errors at the boundary",
        );
        expect(edited).not.toBe(original);

        const saved = await afterCommand(client, {
          type: "saveDiscoverSkill",
          name: editedName,
          text: edited,
        });
        expect(saved.skills.find((skill) => skill.name === editedName)?.state).toBe("edited");
        expect(readFileSync(livePath, "utf8")).toBe(edited);

        // A save that drops the family marker is refused and changes nothing.
        client.send({
          type: "saveDiscoverSkill",
          name: editedName,
          text: edited.replace('  devboard-family: "discover"\n', ""),
        });
        const refused = await client.waitFor((message) => message.type === "discoverError");
        expect(String(refused.message)).toContain("devboard-family");
        expect(readFileSync(livePath, "utf8")).toBe(edited);

        client.send({ type: "saveDiscoverSkill", name: "prepare-only", text: edited });
        const unknown = await client.waitFor((message) => message.type === "discoverError");
        expect(String(unknown.message)).toContain("not one of the five");
      } finally {
        client.close();
        server.stop(true);
      }

      const second = startServer({ fixture });
      const after = await connect(second.url);
      try {
        const beforeReRun = readFileSync(
          join(fixture.root, ".omp", "skills", "discover-coding-conventions", "SKILL.md"),
          "utf8",
        );
        const state = await runDiscover(after);
        expect(beforeReRun).toContain("Handle recoverable errors at the boundary");
        expect(
          readFileSync(
            join(fixture.root, ".omp", "skills", "discover-coding-conventions", "SKILL.md"),
            "utf8",
          ),
        ).toBe(beforeReRun);
        const skill = state.skills.find((entry) => entry.name === "discover-coding-conventions");
        expect(skill?.state).toBe("edited");
        const baseline = readFileSync(
          join(fixture.root, ".omp", "discover", "skills", "discover-coding-conventions", "SKILL.md"),
          "utf8",
        );
        expect(skill?.baseline).toBe(baseline);
        expect(skill?.baselineHash).toBe(hashText(baseline));
        expect(skill?.currentHash).toBe(hashText(beforeReRun));
        expect(state.warnings).toEqual([]);

        // A deleted skill is not recreated; Restore copies the baseline.
        rmSync(join(fixture.root, ".omp", "skills", "discover-glossary"), { recursive: true });
        const missing = await discoverState(after);
        const glossarySkill = missing.skills.find((entry) => entry.name === "discover-glossary");
        expect(glossarySkill?.state).toBe("missing");
        expect(existsSync(join(fixture.root, ".omp", "skills", "discover-glossary"))).toBe(false);

        const restored = await afterCommand(after, {
          type: "resetDiscoverSkill",
          name: "discover-glossary",
        });
        expect(restored.skills.find((entry) => entry.name === "discover-glossary")?.state).toBe(
          "generated",
        );
        expect(
          readFileSync(join(fixture.root, ".omp", "skills", "discover-glossary", "SKILL.md"), "utf8"),
        ).toBe(
          readFileSync(
            join(fixture.root, ".omp", "discover", "skills", "discover-glossary", "SKILL.md"),
            "utf8",
          ),
        );

        // Reset returns an edited skill to its generated baseline.
        const rederived = await afterCommand(after, {
          type: "rederiveDiscoverSkill",
          name: "discover-coding-conventions",
        });
        expect(
          rederived.skills.find((entry) => entry.name === "discover-coding-conventions")?.state,
        ).toBe("generated");
      } finally {
        after.close();
        second.server.stop(true);
      }
    },
    60000,
  );

  test(
    "records glossary confirm and reject decisions, persists them, and preserves them on a re-crawl",
    async () => {
      const { server, url } = startServer();
      const client = await connect(url);
      try {
        await runDiscover(client);
        const confirmed = await afterCommand(client, {
          type: "confirmGlossaryTerm",
          context: "orders",
          id: "order-total",
        });
        const glossary = confirmed.glossaries[0] as {
          concepts: Array<Record<string, unknown>>;
        };
        expect(glossary.concepts.find((concept) => concept.id === "order-total")?.status).toBe(
          "confirmed",
        );
        expect(confirmed.decisions.length).toBe(1);
        expect(confirmed.decisions[0]).toMatchObject({ context: "orders", id: "order-total", action: "confirm" });

        client.send({ type: "confirmGlossaryTerm", context: "orders", id: "order-total" });
        const twice = await client.waitFor((message) => message.type === "discoverError");
        expect(String(twice.message)).toContain("confirmed");

        client.send({ type: "rejectGlossaryTerm", context: "orders", id: "order-total", reason: "  " });
        const noReason = await client.waitFor((message) => message.type === "discoverError");
        expect(String(noReason.message)).toMatch(/non-empty reason/);

        const rejected = await afterCommand(client, {
          type: "rejectGlossaryTerm",
          context: "orders",
          id: "order-total",
          reason: "It names a field; the domain uses the aggregate total.",
        });
        const rejectedGlossary = rejected.glossaries[0] as {
          concepts: Array<Record<string, unknown>>;
        };
        expect(
          rejectedGlossary.concepts.find((concept) => concept.id === "order-total")?.status,
        ).toBe("invalidated");
        expect(rejected.decisions.length).toBe(2);
      } finally {
        client.close();
        server.stop(true);
      }

      // A reconnect and a server restart both read the decision from disk.
      const restarted = startServer({ fixture: fixtureFor(url) });
      const after = await connect(restarted.url);
      try {
        const state = await discoverState(after);
        const glossary = state.glossaries[0] as { concepts: Array<Record<string, unknown>> };
        expect(glossary.concepts.find((concept) => concept.id === "order-total")?.status).toBe(
          "invalidated",
        );

        // A later run preserves the human decision and the concept.
        const rerun = await runDiscover(after);
        const merged = rerun.glossaries[0] as { concepts: Array<Record<string, unknown>> };
        const preserved = merged.concepts.find((concept) => concept.id === "order-total");
        expect(preserved?.status).toBe("invalidated");
        expect(preserved?.prefLabels).toEqual([{ language: "en", text: "Order Total" }]);
        expect(rerun.decisions.length).toBe(2);
        expect(rerun.warnings).toEqual([]);
      } finally {
        after.close();
        restarted.server.stop(true);
      }
    },
    60000,
  );

  test(
    "fingerprints the host, reports stale only on a readable change, and produces one structural digest",
    async () => {
      const fixture = createFixture("determinism");
      const first = startServer({ fixture, stub: ["--discover", "--discover-prose=First crawl definition."] });
      const client = await connect(first.url);
      let firstState: DiscoverState;
      try {
        firstState = await runDiscover(client);
        expect(firstState.stale).toBe(false);
      } finally {
        client.close();
        first.server.stop(true);
      }

      const second = startServer({
        fixture,
        stub: ["--discover", "--discover-prose=A different second crawl sentence."],
      });
      const secondClient = await connect(second.url);
      try {
        const secondState = await runDiscover(secondClient);
        const firstManifest = firstState.manifest as Record<string, unknown>;
        const secondManifest = secondState.manifest as Record<string, unknown>;
        expect(secondManifest.sheetDigest).toBe(firstManifest.sheetDigest);
        expect(secondManifest.glossaryDigests).toEqual(firstManifest.glossaryDigests);
        const firstDefinition = (firstState.sheet as Record<string, unknown>).definition as Record<string, unknown>;
        const secondDefinition = (secondState.sheet as Record<string, unknown>).definition as Record<string, unknown>;
        expect(secondDefinition.value).not.toBe(firstDefinition.value);

        writeFileSync(join(fixture.root, "src", "order.ts"), "export const orderTotal = (total: number): number => total + 1;\n");
        client.send({ type: "getDiscover" });
        const after = await discoverState(secondClient);
        expect(after.stale).toBe(true);
      } finally {
        secondClient.close();
        second.server.stop(true);
      }
    },
    60000,
  );

  test(
    "expands the lifecycle prerequisite, scopes preparation to its family, and refuses other work while running",
    async () => {
      const fixture = createFixture("lifecycle");
      const { server, url } = startServer({ fixture });
      const client = await connect(url);
      try {
        await runDiscover(client);

        // Only Discover skills exist, and the lifecycle gate accepts them.
        client.send({ type: "getSkills" });
        const skillsState = await client.waitFor((message) => message.type === "skillsState");
        const summaries = (skillsState.skills as Array<Record<string, unknown>>).filter((skill) =>
          String(skill.name).startsWith("discover-"),
        );
        expect(summaries.map((skill) => skill.name).sort()).toEqual([...DISCOVER_SKILLS].sort());
        for (const summary of summaries) {
          expect(summary.family).toBe("discover");
          expect(summary.state).toBe("generated");
        }

        client.send({ type: "startLifecycle" });
        const rejected = client.events.find(
          (message) =>
            message.type === "error" && String(message.message).includes("No skills are prepared"),
        );
        expect(rejected).toBeUndefined();
        await client.waitFor((message) => message.type === "lifecycleState");
        client.send({ type: "stopLifecycle" });

      } finally {
        client.close();
        server.stop(true);
      }

      // Preparation replaces only its own family and ignores Discover
      // directives that would contradict its project-agnostic policy.
      const preparing = startServer({ fixture, stub: ["--discover", "--prepare-skills"] });
      const prepareClient = await connect(preparing.url);
      try {
        const discoverBefore = ompBytes(fixture.root);
        const editedPath = join(fixture.root, ".omp", "skills", "discover-naming-conventions", "SKILL.md");
        const edited = readFileSync(editedPath, "utf8").replace(
          "- Keep file names kebab-case",
          "- Never declare dependencies in one direction.\n- Keep file names kebab-case",
        );
        await afterCommand(prepareClient, {
          type: "saveDiscoverSkill",
          name: "discover-naming-conventions",
          text: edited,
        });

        prepareClient.send({ type: "prepareSkills" });
        const prepared = await prepareClient.waitFor(
          (message) => message.type === "skillsPreparationStopped",
        );
        expect(prepared.completed).toBe(true);
        expect(readFileSync(editedPath, "utf8")).toContain("Never declare dependencies in one direction.");
        for (const [path, bytes] of discoverBefore) {
          if (!path.includes(".omp/skills/discover-")) continue;
          const live = readFileSync(join(fixture.root, path), "utf8");
          if (path.endsWith("discover-naming-conventions/SKILL.md")) {
            expect(live).toContain("Never declare dependencies in one direction.");
          } else {
            expect(live).toBe(Buffer.from(bytes, "base64").toString("utf8"));
          }
        }
        prepareClient.send({ type: "getSkills" });
        const mixed = await prepareClient.waitFor((message) => message.type === "skillsState");
        const families = new Set(
          (mixed.skills as Array<Record<string, unknown>>).map((skill) => String(skill.family)),
        );
        expect(families).toContain("prepare");
        expect(families).toContain("discover");
      } finally {
        prepareClient.close();
        preparing.server.stop(true);
      }

      // While a Discover run is live, every other start is refused.
      const running = startServer({
        fixture,
        stub: ["--discover", "--discover-no-exit", "--delay-ms=60000"],
      });
      const active = await connect(running.url);
      try {
        active.send({ type: "discoverProject" });
        await active.waitFor((message) => message.type === "discoverStarted");
        const spawns = spawnCount(fixture.logPath);
        const commands = [
          { type: "startRun", file: "0001-fixture.md" },
          { type: "startLifecycle" },
          { type: "saveGoal", text: "# changed\n" },
          { type: "prepareSkills" },
          { type: "createGoal" },
          { type: "reviseGoal", request: "tighten" },
          { type: "startFlowImplementation" },
          { type: "createFlowGoal" },
        ];
        for (const command of commands) {
          active.send(command);
          const refusal = await active.waitFor(
            (message) => message.type === "error" || message.type === "flowError",
          );
          expect(String(refusal.message)).toMatch(/Discover run/i);
        }
        expect(spawnCount(fixture.logPath)).toBe(spawns);
        active.send({ type: "discoverProject" });
        const second = await active.waitFor((message) => message.type === "discoverError");
        expect(String(second.message)).toContain("already active");
        expect(spawnCount(fixture.logPath)).toBe(spawns);
      } finally {
        active.close();
        running.server.stop(true);
      }
    },
    90000,
  );

  test(
    "cancels an active run on reset and interrupts one on restart without auto-resuming",
    async () => {
      const fixture = createFixture("reset-restart");
      const first = startServer({ fixture });
      const client = await connect(first.url);
      try {
        const state = await runDiscover(client);
        const published = ompBytes(fixture.root);
        expect(state.sheet).not.toBeNull();

        const running = startServer({
          fixture,
          stub: ["--discover", "--discover-no-exit", "--delay-ms=60000"],
        });
        const active = await connect(running.url);
        try {
          active.send({ type: "discoverProject" });
          const started = await active.waitFor((message) => message.type === "discoverStarted");
          active.send({ type: "resetImplementation" });
          const stopped = await active.waitFor((message) => message.type === "discoverStopped");
          expect(stopped.completed).toBe(false);
          await active.waitFor((message) => message.type === "implementationResetStopped");
          expect(existsSync(join(fixture.root, ".omp", "discover", "staging", String(started.runId)))).toBe(false);
          expect(ompBytes(fixture.root)).toEqual(published);
        } finally {
          active.close();
          running.server.stop(true);
        }

        // A restart while a run is live interrupts it: no resume, staging gone,
        // artifacts intact.
        const live = startServer({
          fixture,
          stub: ["--discover", "--discover-no-exit", "--delay-ms=60000"],
        });
        const before = await connect(live.url);
        let runId = "";
        try {
          before.send({ type: "discoverProject" });
          runId = String((await before.waitFor((message) => message.type === "discoverStarted")).runId);
          await waitUntil(
            () => existsSync(join(fixture.root, ".omp", "discover", "staging", runId)),
            "staging exists before restart",
          );
        } finally {
          before.close();
          live.server.stop(true);
        }
        const spawns = spawnCount(fixture.logPath);

        const replacement = startServer({
          fixture,
          stub: ["--discover", "--discover-no-exit", "--delay-ms=60000"],
        });
        const after = await connect(replacement.url);
        try {
          const interruption = await after.waitFor((message) => message.type === "discoverError");
          expect(String(interruption.message)).toContain("interrupted");
          const restored = await afterCommand(after, { type: "getDiscover" });
          expect(restored.interrupted).toBe(true);
          expect(restored.active).toBe(false);
          await Bun.sleep(200);
          expect(spawnCount(fixture.logPath)).toBe(spawns);
          expect(existsSync(join(fixture.root, ".omp", "discover", "staging", runId))).toBe(false);
          expect(ompBytes(fixture.root)).toEqual(published);
        } finally {
          after.close();
          replacement.server.stop(true);
        }
      } finally {
        client.close();
        first.server.stop(true);
      }
    },
    90000,
  );

  test(
    "runs on a host without GOAL.md and with a dirty working tree",
    async () => {
      const fixture = createFixture("no-goal", { goal: false, dirty: true });
      const { server, url } = startServer({ fixture });
      const client = await connect(url);
      try {
        const state = await runDiscover(client);
        expect(state.sheet).not.toBeNull();
        expect((state.freshness as Record<string, unknown>).dirty).toBe(true);
        expect(existsSync(fixture.goalFile)).toBe(false);
        expect(existsSync(join(fixture.root, ".omp", "discover", "manifest.json"))).toBe(true);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );
});

/** The fixture a server started from `url` serves, for a restart in one test. */
const fixturesByUrl = new Map<string, Fixture>();

function fixtureFor(url: string): Fixture {
  const fixture = fixturesByUrl.get(url);
  if (fixture === undefined) throw new Error(`no fixture serves ${url}`);
  return fixture;
}
