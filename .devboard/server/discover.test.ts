import { fixtureRecord } from "./fixtures/adr-source";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app";
import {
  type ArtifactsRead,
  confirmGlossaryTerm,
  declaredCommandAliases,
  DiscoverValidationError,
  overviewPathLink,
  overviewPathLinks,
  readArtifacts,
  rejectGlossaryTerm,
} from "./discover";
import { readStateFile, stateFile } from "./state";
import { testProviderService } from "./fixtures/test-providers";
import type { ProviderService } from "./providers";

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
  "discover-contribution",
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
    `${JSON.stringify({ name: "fixture-host", scripts: { build: "bun run build:src", test: "bun test", "test:unit": "bun test" } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "src", "order.ts"), "export const orderTotal = (total: number): number => total;\n");
  mkdirSync(join(root, "src", "checkout"), { recursive: true });
  writeFileSync(
    join(root, "src", "checkout", "flow.ts"),
    "export { orderTotal } from \"../order\";\n",
  );
  writeFileSync(
    join(root, "test", "order.test.ts"),
    'import { test, expect } from "bun:test";\ntest("order total", () => expect(1).toBe(1));\n',
  );
  writeFileSync(
    join(root, ".github", "workflows", "ci.yml"),
    "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n",
  );
  writeFileSync(join(root, "adrs", "0001-fixture.md"), fixtureRecord("0001-fixture.md", "Fixture decision"));
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

/** The app surface these tests drive: the listener plus the installer hooks. */
interface TestServer {
  server: { stop(closeActiveConnections?: boolean): void; prepareReplacement(): void };
  fixture: Fixture;
  url: string;
}

interface StartOptions {
  fixture?: Fixture;
  stub?: string[];
  stateDir?: string;
  /** Replaces the deterministic provider service, to defer peer preparation. */
  providers?: ProviderService;
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
    providers: options.providers ?? testProviderService(stateDir),
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

async function waitUntil(predicate: () => boolean, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  if (!predicate()) throw new Error(label);
}

interface DiscoverState {
  active: boolean;
  runId: string | null;
  activeAgent: string | null;
  runningAll: boolean;
  allFailed: string | null;
  agents: DiscoverAgentRow[];
  interrupted: boolean;
  stale: boolean;
  warnings: string[];
  busy: string | null;
  error: string | null;
  manifest: Record<string, unknown> | null;
  freshness: Record<string, unknown> | null;
  sheet: Record<string, unknown> | null;
  commandAliases: Array<{ command: string; alias: string }>;
  glossaries: Record<string, unknown>[];
  glossaryUsage: Record<string, Record<string, { count: number; files: number; examples: string[] }>>;
  glossarySignificance: Record<string, Record<string, { score: number; reason: string }>>;
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
  const state = await discoverState(client);
  expect(state.runningAll).toBe(false);
  expect(state.allFailed).toBeNull();
  return state;
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

// A token-shaped secret, never a path segment: `…/task-…` or a worktree name
// that starts `sk-` is not a credential.
const SECRET_PATTERN =
  /(?<![A-Za-z0-9_/-])(?:ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9_/-])/;

// An absolute host path at a value boundary, never a `/home/` directory inside
// a repository-relative path such as `app/home/page.tsx`.
const ABSOLUTE_HOST_PATH_PATTERN =
  /(?:^|[\s"'(=:])\/(?:home|Users)\/|[A-Za-z]:\\\\/;

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
    "runs the seven agents in Run all order and publishes each one's slice",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      const goalBefore = readFileSync(fixture.goalFile);
      const adrBefore = treeBytes(fixture.adrDir);
      try {
        const state = await runDiscover(client);

        // One peer per agent, in the fixed Run all order, each with its own
        // command and its own staging directory.
        expect(spawnCount(fixture.logPath)).toBe(7);
        const sent = prompts(fixture.logPath);
        const commands = ["/discover-sheet", "/discover-glossary",
          "/discover-testing-strategy", "/discover-naming-conventions",
          "/discover-coding-conventions", "/discover-architecture-boundaries",
          "/discover-contribution"];
        expect(sent.map((prompt) => prompt.split(" ")[0])).toEqual(commands);
        const stagingPaths = sent.map((prompt) => prompt.slice(prompt.indexOf(" ") + 1));
        expect(new Set(stagingPaths).size).toBe(7);
        for (const path of stagingPaths) {
          expect(path).toMatch(/\.omp\/discover\/staging\/run-/);
        }
        for (const line of logLines(fixture.logPath)) {
          if (line.startsWith("argv ")) expect(line).toContain("--no-skills");
        }

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
        expect(paths.significance).toBe(".omp/discover/significance.json");

        // The published set exists exactly where the contract puts it.
        const root = fixture.root;
        for (const relative of [
          ".omp/discover/manifest.json",
          ".omp/discover/sheet.json",
          ".omp/discover/decisions.json",
          ".omp/discover/significance.json",
          ".omp/discover/glossary/orders.glossary.yaml",
          ...DISCOVER_SKILLS.map((name) => `.omp/discover/skills/${name}/SKILL.md`),
          ...DISCOVER_SKILLS.map((name) => `.omp/skills/${name}/SKILL.md`),
        ]) {
          expect(existsSync(join(root, relative))).toBe(true);
        }
        expect(existsSync(join(root, ".omp", "discover", "staging"))).toBe(false);

        // The sidecar carries one integer score and one reason per concept.
        const sidecar = JSON.parse(
          readFileSync(join(root, ".omp", "discover", "significance.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(Object.keys(sidecar)).toEqual(["schemaVersion", "contexts"]);
        expect(sidecar.schemaVersion).toBe(1);
        expect(Object.keys(sidecar.contexts as Record<string, unknown>)).toEqual(["orders"]);
        expect(state.glossarySignificance.orders?.["order-total"]).toEqual({
          score: 90,
          reason: "The order total is the domain's central summed value.",
        });
        expect(state.glossarySignificance.orders?.option?.score).toBe(10);

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

        // The testing card carries a happy-path count and a declared level
        // command, and the manifest's own invocations resolve the suite.
        const testing = sheet.testing;
        if (typeof testing !== "object" || testing === null || Array.isArray(testing)) {
          throw new Error("the published sheet has no testing section");
        }
        const testingFields = testing as Record<string, unknown>;
        const levelsLeaf = testingFields.levels;
        if (typeof levelsLeaf !== "object" || levelsLeaf === null || Array.isArray(levelsLeaf)) {
          throw new Error("the published sheet has no testing levels");
        }
        const levelValues = (levelsLeaf as Record<string, unknown>).value;
        if (!Array.isArray(levelValues)) throw new Error("the testing levels carry no records");
        const publishedLevels = levelValues as Array<Record<string, unknown>>;
        expect(publishedLevels).toHaveLength(1);
        expect(publishedLevels[0]?.level).toBe("unit");
        expect(publishedLevels[0]?.happyPath).toBe("1");
        expect(publishedLevels[0]?.command).toBe("npm run test:unit");

        // A quality gate carries the one line describing what it checks.
        const ci = sheet.ci;
        if (typeof ci !== "object" || ci === null || Array.isArray(ci)) {
          throw new Error("the published sheet has no ci section");
        }
        const gatesLeaf = (ci as Record<string, unknown>).qualityGates;
        if (typeof gatesLeaf !== "object" || gatesLeaf === null || Array.isArray(gatesLeaf)) {
          throw new Error("the published sheet has no quality gates");
        }
        expect((gatesLeaf as Record<string, unknown>).value).toEqual([
          { name: "bun test", checks: "Runs the whole fixture test suite in CI." },
        ]);
        expect(state.commandAliases).toEqual([
          { command: "bun run build:src", alias: "npm run build" },
          { command: "bun test", alias: "npm test" },
        ]);

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
          expect(String(concept.status)).toBe("confirmed");
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
          const scored = state.glossarySignificance.orders?.[id];
          expect(scored).toBeDefined();
          expect(Number.isInteger(scored?.score)).toBe(true);
          expect(scored?.score).toBeGreaterThanOrEqual(0);
          expect(scored?.score).toBeLessThanOrEqual(100);
          expect(scored?.reason.length).toBeGreaterThan(0);
          expect(scored?.reason).not.toContain("\n");
        }

        // Usage is measured from the host's documentation and source, and the
        // identifiers that name a concept become its examples.
        const usage = state.glossaryUsage.orders?.["order-total"];
        expect(usage).toBeDefined();
        expect(usage?.count).toBeGreaterThanOrEqual(2);
        expect(usage?.files).toBeGreaterThanOrEqual(2);
        expect(usage?.examples).toContain("orderTotal");

        // Artifacts hold no secret value and no absolute host path.
        for (const [, bytes] of ompBytes(root)) {
          const text = Buffer.from(bytes, "base64").toString("utf8");
          expect(text).not.toMatch(SECRET_PATTERN);
          expect(text).not.toMatch(ABSOLUTE_HOST_PATH_PATTERN);
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
    "publishes a glossary grounded in a repository path whose directory is named home",
    async () => {
      const fixture = createFixture("home-segment");
      mkdirSync(join(fixture.root, "app", "home"), { recursive: true });
      writeFileSync(
        join(fixture.root, "app", "home", "page.tsx"),
        "export default function HomePage() {\n  return null;\n}\n",
      );
      git(fixture.root, ["add", "-A"]);
      git(fixture.root, ["commit", "-m", "chore: add a home page"]);

      const { server, url } = startServer({
        fixture,
        stub: ["--discover", "--discover-glossary-home-path"],
      });
      const client = await connect(url);
      try {
        const state = await runDiscover(client);
        const glossary = state.glossaries[0] as Record<string, unknown>;
        const concepts = glossary.concepts as Array<Record<string, unknown>>;
        expect(concepts.find((concept) => concept.id === "order")?.grounding).toEqual([
          "code:app/home/page.tsx",
        ]);

        // The published artifact carries the path and still holds no absolute
        // host path at a value boundary.
        const published = readFileSync(
          join(fixture.root, ".omp", "discover", "glossary", "orders.glossary.yaml"),
          "utf8",
        );
        expect(published).toContain("code:app/home/page.tsx");
        for (const [, bytes] of ompBytes(fixture.root)) {
          const text = Buffer.from(bytes, "base64").toString("utf8");
          expect(text).not.toMatch(ABSOLUTE_HOST_PATH_PATTERN);
        }
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "publishes routes that begin with a slash",
    async () => {
      const { server, fixture, url } = startServer({
        stub: ["--discover", "--discover-sheet-routes"],
      });
      const client = await connect(url);
      try {
        const state = await runDiscover(client);
        const sheet = state.sheet as Record<string, unknown>;
        const dependencyMap = sheet.dependencyMap as Record<string, unknown>;
        const routes = dependencyMap.routes as Record<string, unknown>;
        expect(routes.value).toEqual(["/", "/api/orders", "GET /api/orders/:id"]);
        expect(
          existsSync(join(fixture.root, ".omp", "discover", "manifest.json")),
        ).toBe(true);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "rejects a value that begins with a stripped absolute host path",
    async () => {
      const { server, fixture, url } = startServer({
        stub: ["--discover", "--discover-sheet-stripped-home"],
      });
      const client = await connect(url);
      try {
        client.send({ type: "discoverProject" });
        await client.waitFor((message) => message.type === "discoverStarted");
        const errored = await client.waitFor((message) => message.type === "discoverError");
        expect(String(errored.message)).toContain("absolute host path");
        expect(existsSync(join(fixture.root, ".omp", "discover", "manifest.json"))).toBe(false);
        await client.waitFor((message) => message.type === "discoverStopped");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "starts one peer per click, stages under .omp/discover/staging, and stops without publishing",
    async () => {
      const { server, fixture, url } = startServer({ stub: ["--discover", "--discover-no-exit", "--delay-ms=60000"] });
      const client = await connect(url);
      try {
        client.send({ type: "discoverAgent", agent: "sheet" });
        const started = await client.waitFor((message) => message.type === "discoverStarted");
        expect(started.runId).toMatch(/^run-/);
        expect(started.agent).toBe("sheet");
        const staging = join(fixture.root, ".omp", "discover", "staging", String(started.runId));
        await waitUntil(() => existsSync(staging), "staging directory exists");
        // The peer writes its spawn and its first prompt in one synchronous
        // block but as two appends: waiting on the spawn alone can read the
        // pair half-written, so wait for the prompt line the assertion needs.
        await waitUntil(
          () => spawnCount(fixture.logPath) === 1 && prompts(fixture.logPath).length === 1,
          "peer announced with its prompt",
        );
        expect(prompts(fixture.logPath)[0]).toBe(`/discover-sheet ${staging}`);

        // A second start is refused with one error and spawns nothing.
        client.send({ type: "discoverAgent", agent: "sheet" });
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
    "stopping Discover during provider selection spawns no peer",
    async () => {
      const fixture = createFixture("discover-stop-early");
      const providers = testProviderService(fixture.stateDir);
      const { server, url } = startServer({ fixture, providers });
      const client = await connect(url);
      const deferred = deferNextSelection(providers);
      try {
        client.send({ type: "discoverProject" });
        await client.waitFor((message) => message.type === "discoverStarted");
        await deferred.entered;
        client.send({ type: "stopDiscover" });
        const stopped = await client.waitFor((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(false);
        deferred.release();
        await deferred.settled;
        await Promise.resolve();
        expect(spawnCount(fixture.logPath)).toBe(0);
        expect(prompts(fixture.logPath)).toHaveLength(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "server stop during Discover provider selection leaves no peer",
    async () => {
      const fixture = createFixture("discover-dispose-early");
      const providers = testProviderService(fixture.stateDir);
      const { server, url } = startServer({ fixture, providers });
      const client = await connect(url);
      const deferred = deferNextSelection(providers);
      try {
        client.send({ type: "discoverProject" });
        await client.waitFor((message) => message.type === "discoverStarted");
        await deferred.entered;
        server.stop(true);
        deferred.release();
        await deferred.settled;
        await Promise.resolve();
        expect(spawnCount(fixture.logPath)).toBe(0);
        expect(prompts(fixture.logPath)).toHaveLength(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
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
        const started = await first.waitFor((message) => message.type === "discoverStarted");
        expect(started.agent).toBe("sheet");
        const firstQuestion = await first.waitFor((message) => message.type === "discoverQuestion");
        expect(firstQuestion.agent).toBe("sheet");

        const replay = await connect(url);
        try {
          await waitUntil(() => replay.events.length >= 4, "replay delivered", 3000);
          const types = replay.events.slice(0, 6).map((message) => String(message.type));
          expect(types[0]).toBe("discoverState");
          expect(types[1]).toBe("discoverStarted");
          expect(types).toContain("discoverActivity");
          expect(types).toContain("discoverQuestion");

          const question = await replay.waitFor((message) => message.type === "discoverQuestion");
          expect(question.agent).toBe("sheet");
          const replayedStart = replay.events.find(
            (message) => message.type === "discoverStarted",
          ) as Record<string, unknown> | undefined;
          expect(replayedStart?.agent).toBe("sheet");
          for (const message of replay.events) {
            if (message.type === "discoverActivity") expect(message.agent).toBe("sheet");
          }
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
      const variants: Array<{ flag: string; agent: string }> = [
        { flag: "--discover-invalid-sheet", agent: "sheet" },
        { flag: "--discover-sheet-absolute", agent: "sheet" },
        { flag: "--discover-sheet-stripped-home", agent: "sheet" },
        { flag: "--discover-sheet-no-evidence", agent: "sheet" },
        { flag: "--discover-sheet-secret", agent: "sheet" },
        { flag: "--discover-sheet-two-sentences", agent: "sheet" },
        { flag: "--discover-sheet-happy-overflow", agent: "sheet" },
        { flag: "--discover-glossary-invalid", agent: "discover-glossary" },
        { flag: "--discover-glossary-grounding", agent: "discover-glossary" },
        { flag: "--discover-missing-artifact", agent: "discover-testing-strategy" },
        { flag: "--discover-extra-artifact", agent: "sheet" },
        { flag: "--discover-write-outside", agent: "sheet" },
        { flag: "--discover-error", agent: "sheet" },
      ];

      for (const variant of variants) {
        const fixture = createFixture(`failure-${variant.flag.replace(/^--/, "")}`);
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

        const failing = startServer({ fixture, stub: ["--discover", variant.flag] });
        const failingClient = await connect(failing.url);
        try {
          failingClient.send({ type: "discoverAgent", agent: variant.agent });
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
        client.send({ type: "discoverAgent", agent: "discover-testing-strategy" });
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
    "preserves a hand-edited skill across a re-crawl and reports missing skills read-only",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      const editedName = "discover-coding-conventions";
      const livePath = join(fixture.root, ".omp", "skills", editedName, "SKILL.md");
      try {
        const original = await runDiscover(client);
        const originalSkill = original.skills.find((entry) => entry.name === editedName);
        expect(originalSkill?.state).toBe("generated");
        const before = readFileSync(livePath, "utf8");
        const edited = before.replace(
          "- Handle recoverable errors at the caller",
          "- Handle recoverable errors at the boundary",
        );
        expect(edited).not.toBe(before);
        writeFileSync(livePath, edited);
      } finally {
        client.close();
        server.stop(true);
      }

      const second = startServer({ fixture });
      const after = await connect(second.url);
      try {
        const state = await runDiscover(after);
        expect(
          readFileSync(join(fixture.root, ".omp", "skills", editedName, "SKILL.md"), "utf8"),
        ).toBe(
          readFileSync(livePath, "utf8"),
        );
        expect(
          readFileSync(livePath, "utf8"),
        ).toContain("Handle recoverable errors at the boundary");
        const skill = state.skills.find((entry) => entry.name === editedName);
        expect(skill?.state).toBe("edited");
        const baseline = readFileSync(
          join(fixture.root, ".omp", "discover", "skills", editedName, "SKILL.md"),
          "utf8",
        );
        expect(skill?.baseline).toBe(baseline);
        expect(skill?.baselineHash).toBe(hashText(baseline));
        expect(skill?.currentHash).toBe(hashText(readFileSync(livePath, "utf8")));
        expect(state.warnings).toEqual([]);

        // A deleted skill is reported missing and no removed command recreates it.
        rmSync(join(fixture.root, ".omp", "skills", "discover-glossary"), { recursive: true });
        const missing = await discoverState(after);
        expect(missing.skills.find((entry) => entry.name === "discover-glossary")?.state).toBe(
          "missing",
        );
        expect(existsSync(join(fixture.root, ".omp", "skills", "discover-glossary"))).toBe(false);

        const liveBefore = readFileSync(livePath, "utf8");
        after.send({ type: "restoreDiscoverSkill", name: "discover-glossary" });
        expect(await after.waitFor((message) => message.type === "error")).toEqual({
          type: "error",
          message: "Invalid WebSocket message.",
        });
        after.send({
          type: "saveDiscoverSkill",
          name: editedName,
          text: `${liveBefore}\n- Removed command.\n`,
          target: { kind: "host" },
        });
        expect(await after.waitFor((message) => message.type === "error")).toEqual({
          type: "error",
          message: "Invalid WebSocket message.",
        });
        expect(readFileSync(livePath, "utf8")).toBe(liveBefore);
        expect(existsSync(join(fixture.root, ".omp", "skills", "discover-glossary"))).toBe(false);
      } finally {
        after.close();
        second.server.stop(true);
      }
    },
    60000,
  );

  test(
    "publishes every crawled term as confirmed without an operator confirm step",
    async () => {
      const { server, url } = startServer();
      const client = await connect(url);
      try {
        const before = await runDiscover(client);
        const initial = before.glossaries[0] as { concepts: Array<Record<string, unknown>> };
        expect(initial.concepts.find((concept) => concept.id === "order")?.status).toBe(
          "confirmed",
        );
        expect(initial.concepts.find((concept) => concept.id === "order-total")?.status).toBe(
          "confirmed",
        );
        expect(before.decisions).toHaveLength(0);

        // Confirmation is a publication rule, not a manual step.
        client.send({ type: "confirmGlossaryTerm", context: "orders", id: "order" });
        const refusal = await client.waitFor((message) => message.type === "discoverError");
        expect(String(refusal.message)).toContain("confirmed");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "records a glossary rejection, persists it, and preserves it on a re-crawl",
    async () => {
      const { server, url } = startServer();
      const client = await connect(url);
      try {
        const before = await runDiscover(client);
        const initial = before.glossaries[0] as { concepts: Array<Record<string, unknown>> };
        expect(initial.concepts.find((concept) => concept.id === "order-total")?.status).toBe(
          "confirmed",
        );

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
        expect(rejected.decisions.length).toBe(1);
        expect(rejected.decisions[0]).toMatchObject({
          context: "orders",
          id: "order-total",
          action: "reject",
        });
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
        expect(rerun.decisions.length).toBe(1);
        expect(rerun.warnings).toEqual([]);
      } finally {
        after.close();
        restarted.server.stop(true);
      }
    },
    60000,
  );

  test(
    "keeps a published set readable and re-crawlable after a grounded file is deleted",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      const conceptsOf = (state: DiscoverState): Array<Record<string, unknown>> => {
        const glossary: Record<string, unknown> | undefined = state.glossaries[0];
        const concepts = glossary?.concepts;
        return Array.isArray(concepts) ? concepts : [];
      };
      try {
        const published = await runDiscover(client);
        expect(
          conceptsOf(published).find((concept) => concept.id === "order")?.grounding,
        ).toEqual(["code:README.md"]);

        // A refactor deletes the first evidence file the published glossary
        // grounds. The published set is crawl evidence, so it stays readable.
        rmSync(join(fixture.root, "README.md"));

        const readable = await discoverState(client);
        expect(readable.error).toBeNull();
        expect(readable.sheet).not.toBeNull();
        expect(readable.glossaries).toHaveLength(1);
        expect(readable.skills).toHaveLength(DISCOVER_SKILLS.length);
        expect(readable.stale).toBe(true);
        expect(
          conceptsOf(readable).find((concept) => concept.id === "order")?.grounding,
        ).toEqual(["code:README.md"]);

        // A human decision still lands while a grounding is stale.
        const rejected = await afterCommand(client, {
          type: "rejectGlossaryTerm",
          context: "orders",
          id: "order",
          reason: "The evidence file is gone; the term needs a new grounding.",
        });
        expect(rejected.error).toBeNull();
        expect(
          conceptsOf(rejected).find((concept) => concept.id === "order")?.status,
        ).toBe("invalidated");

        // The repair crawl reads the same previous set and merges over it.
        client.send({ type: "discoverProject" });
        await client.waitFor((message) => message.type === "discoverStarted");
        const stopped = await client.waitFor((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(true);

        const repaired = await discoverState(client);
        expect(repaired.error).toBeNull();
        const order = conceptsOf(repaired).find((concept) => concept.id === "order");
        expect(order?.status).toBe("invalidated");
        expect(order?.grounding).toEqual(["code:package.json"]);
      } finally {
        client.close();
        server.stop(true);
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
    "refreshes Discover on a host holding a large tracked file without blocking memory",
    async () => {
      const fixture = createFixture("large-host");
      const { server, url } = startServer({ fixture });
      const client = await connect(url);
      try {
        const published = await runDiscover(client);
        expect(published.stale).toBe(false);

        const big = join(fixture.root, "big.bin");
        writeFileSync(big, "");
        truncateSync(big, 1024 * 1024 * 1024);
        git(fixture.root, ["add", "big.bin"]);

        const rssBefore = process.memoryUsage().rss;
        const refreshed = await discoverState(client);
        const grown = process.memoryUsage().rss - rssBefore;
        expect(refreshed.stale).toBe(true);
        // Reading the whole gibibyte would allocate it; the fingerprint streams
        // it in fixed-size chunks instead.
        expect(grown).toBeLessThan(256 * 1024 * 1024);

        // The WebSocket keeps serving commands once the fingerprint is current.
        client.send({ type: "getGoal" });
        const goal = await client.waitFor((message) => message.type === "goal");
        expect(goal.text).toBe(GOAL_TEXT);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    120000,
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
        await client.waitFor(
          (message) => message.type === "lifecycleState" && message.stage === "goal",
        );

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
        writeFileSync(editedPath, edited);

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
        expect(String(second.message)).toMatch(/Run all is active|already active/);
        expect(spawnCount(fixture.logPath)).toBe(spawns);
      } finally {
        active.close();
        running.server.stop(true);
      }
    },
    90000,
  );

  test(
    "cancels an active run on reset",
    async () => {
      const fixture = createFixture("reset-run");
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
      } finally {
        client.close();
        first.server.stop(true);
      }
    },
    90000,
  );

  test(
    "resumes a live run on restart against the same host",
    async () => {
      const fixture = createFixture("restart-resume");
      const seeded = startServer({ fixture });
      const seedClient = await connect(seeded.url);
      try {
        expect((await runDiscover(seedClient)).sheet).not.toBeNull();
      } finally {
        seedClient.close();
        seeded.server.stop(true);
      }

      // A restart while a run is live re-spawns the crawl against the same
      // host, replaces the staging directory, and publishes on completion.
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
        await waitUntil(
          () => spawnCount(fixture.logPath) === 8,
          "the live run's peer before restart",
        );
      } finally {
        before.close();
        live.server.stop(true);
      }
      const spawns = spawnCount(fixture.logPath);

      const replacement = startServer({
        fixture,
        stub: ["--discover", "--discover-delay-ms=500"],
      });
      const after = await connect(replacement.url);
      try {
        const resumed = await after.waitFor((message) => message.type === "discoverStarted");
        expect(String(resumed.runId)).not.toBe(runId);
        const stopped = await after.waitFor((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(true);
        expect(spawnCount(fixture.logPath)).toBe(spawns + 1);
        const restored = await afterCommand(after, { type: "getDiscover" });
        expect(restored.interrupted).toBe(false);
        expect(restored.active).toBe(false);
        expect(restored.sheet).not.toBeNull();
        expect(existsSync(join(fixture.root, ".omp", "discover", "staging", runId))).toBe(false);
        expect(
          existsSync(join(fixture.root, ".omp", "discover", "staging", String(resumed.runId))),
        ).toBe(false);
        const manifest = JSON.parse(
          readFileSync(join(fixture.root, ".omp", "discover", "manifest.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(manifest.runId).toBe(resumed.runId);
        const loaded = readStateFile(stateFile(fixture.stateDir, fixture.root));
        expect(loaded.kind).toBe("loaded");
        if (loaded.kind === "loaded") {
          expect((loaded.value as Record<string, unknown>).discover).toBeNull();
        }
      } finally {
        after.close();
        replacement.server.stop(true);
      }
    },
    90000,
  );

  test(
    "a prepared replacement keeps a live run's staging for its successor, and Stop removes it",
    async () => {
      const stagingPath = (root: string, runId: string): string =>
        join(root, ".omp", "discover", "staging", runId);
      const liveStub = ["--discover", "--discover-no-exit", "--delay-ms=60000"];

      // The automatic update path prepares the same handoff the reload control
      // does, so the shutdown that follows must leave the staging directory to
      // the successor instead of deleting the crawl's work.
      const handingOff = createFixture("handoff-staging");
      const live = startServer({ fixture: handingOff, stub: liveStub });
      const liveClient = await connect(live.url);
      let liveRunId = "";
      let liveStopped = false;
      try {
        liveClient.send({ type: "discoverProject" });
        liveRunId = String(
          (await liveClient.waitFor((message) => message.type === "discoverStarted")).runId,
        );
        await waitUntil(
          () => existsSync(stagingPath(handingOff.root, liveRunId)),
          "the live run's staging directory",
        );
        live.server.prepareReplacement();
        live.server.stop(true);
        liveStopped = true;
        expect(existsSync(stagingPath(handingOff.root, liveRunId))).toBe(true);
      } finally {
        liveClient.close();
        if (!liveStopped) live.server.stop(true);
      }

      // An operator Stop is terminal: the same live run loses its staging.
      const stopping = createFixture("stop-staging");
      const stopped = startServer({ fixture: stopping, stub: liveStub });
      const stopClient = await connect(stopped.url);
      let stopRunId = "";
      let operatorStopped = false;
      try {
        stopClient.send({ type: "discoverProject" });
        stopRunId = String(
          (await stopClient.waitFor((message) => message.type === "discoverStarted")).runId,
        );
        await waitUntil(
          () => existsSync(stagingPath(stopping.root, stopRunId)),
          "the operator run's staging directory",
        );
        stopped.server.stop(true);
        operatorStopped = true;
        expect(existsSync(stagingPath(stopping.root, stopRunId))).toBe(false);
      } finally {
        stopClient.close();
        if (!operatorStopped) stopped.server.stop(true);
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

  test(
    "rejects every invalid significance sidecar and leaves the published set byte-identical",
    async () => {
      const variants = [
        "missing",
        "invalid",
        "array",
        "unknown-context",
        "unknown-concept",
        "extra-concept",
        "extra-key",
        "schema",
        "score",
        "score-object",
        "reason-empty",
        "reason-multiline",
        "reason-absolute",
        "reason-secret",
      ];
      const fixture = createFixture("failure-significance");
      const healthy = startServer({ fixture });
      const client = await connect(healthy.url);
      let before: Map<string, string>;
      try {
        await runDiscover(client);
        before = ompBytes(fixture.root);
        expect(before.has(".omp/discover/significance.json")).toBe(true);
      } finally {
        client.close();
        healthy.server.stop(true);
      }

      for (const variant of variants) {
        const failing = startServer({
          fixture,
          stub: ["--discover", `--discover-significance=${variant}`],
        });
        const failingClient = await connect(failing.url);
        try {
          failingClient.send({ type: "discoverAgent", agent: "discover-glossary" });
          await failingClient.waitFor((message) => message.type === "discoverStarted");
          const errored = await failingClient.waitFor((message) => message.type === "discoverError");
          expect(String(errored.message)).toContain("significance.json");
          const stopped = await failingClient.waitFor((message) => message.type === "discoverStopped");
          expect(stopped.completed).toBe(false);
          expect(
            failingClient.events.filter((message) => message.type === "discoverError").length,
          ).toBe(1);
          expect(ompBytes(fixture.root)).toEqual(before);
          const stagingRoot = join(fixture.root, ".omp", "discover", "staging");
          expect(existsSync(stagingRoot) ? readdirSync(stagingRoot).length : 0).toBe(0);
        } finally {
          failingClient.close();
          failing.server.stop(true);
        }
      }
    },
    120000,
  );

  test(
    "serves a legacy manifest without the sidecar path as unscored",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        await runDiscover(client);
        const manifestPath = join(fixture.root, ".omp", "discover", "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          paths: Record<string, unknown>;
        };
        // A publication written before the sidecar existed carries no path.
        delete manifest.paths.significance;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        rmSync(join(fixture.root, ".omp", "discover", "significance.json"));

        const state = await discoverState(client);
        expect(state.error).toBeNull();
        expect(state.glossarySignificance).toEqual({});
        expect(state.glossaries.length).toBe(1);
        expect((state.glossaries[0]?.concepts as unknown[]).length).toBeGreaterThan(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "rejects a crafted manifest before reading or writing outside .omp/",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        await runDiscover(client);
      } finally {
        client.close();
        server.stop(true);
      }

      const manifestPath = join(fixture.root, ".omp", "discover", "manifest.json");
      const original = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        paths: Record<string, unknown>;
      };
      const sentinelName = `sentinel-${process.pid}-${Math.random().toString(16).slice(2, 8)}.json`;
      const sentinel = join(fixture.root, "..", sentinelName);
      const sentinelBytes = "bytes that must never be overwritten\n";
      writeFileSync(sentinel, sentinelBytes);
      cleanup.push(() => rmSync(sentinel, { force: true }));

      const craft = (mutate: (paths: Record<string, unknown>) => void): void => {
        const manifest = JSON.parse(JSON.stringify(original)) as {
          paths: Record<string, unknown>;
        };
        mutate(manifest.paths);
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      };
      const escape = `../${sentinelName}`;
      const rejects = (read: ArtifactsRead): void => {
        expect(read.artifacts).toBeNull();
        expect(String(read.error)).toContain("manifest.json.paths.");
      };

      // A normal confirm or reject would rewrite decisions.json; the crafted
      // decision path must fail before either touches the sentinel.
      for (const field of ["manifest", "decisions"] as const) {
        craft((paths) => {
          paths[field] = escape;
        });
        expect(() =>
          confirmGlossaryTerm(fixture.root, "orders", "order-total"),
        ).toThrow(DiscoverValidationError);
        expect(() =>
          rejectGlossaryTerm(fixture.root, "orders", "order-total", "crafted"),
        ).toThrow(DiscoverValidationError);
        expect(readFileSync(sentinel, "utf8")).toBe(sentinelBytes);
      }

      // Every read-side path field is checked before any file is opened.
      const escapes: Array<[string, (paths: Record<string, unknown>) => void]> = [
        ["sheet", (paths) => (paths.sheet = escape)],
        ["significance", (paths) => (paths.significance = escape)],
        ["glossaries", (paths) => (paths.glossaries = [escape])],
        ["baselines", (paths) => ((paths.baselines as Record<string, string>)["discover-glossary"] = escape)],
        ["live", (paths) => ((paths.live as Record<string, string>)["discover-glossary"] = escape)],
      ];
      for (const [, mutate] of escapes) {
        craft(mutate);
        rejects(readArtifacts(fixture.root));
        expect(readFileSync(sentinel, "utf8")).toBe(sentinelBytes);
      }

      // Restoring the publication proves the same manifest still loads.
      writeFileSync(manifestPath, `${JSON.stringify(original, null, 2)}\n`);
      const valid = readArtifacts(fixture.root);
      expect(valid.error).toBeNull();
      expect(valid.artifacts?.glossaries).toHaveLength(1);
    },
    60000,
  );

  test(
    "keeps every digest when only the significance scores change",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        const first = await runDiscover(client);
        const firstManifest = first.manifest as Record<string, unknown>;
        const sidecarPath = join(fixture.root, ".omp", "discover", "significance.json");
        const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
          schemaVersion: number;
          contexts: Record<string, Record<string, { score: number; reason: string }>>;
        };
        const orders = sidecar.contexts.orders ?? {};
        orders["order-total"] = { score: 55, reason: "Still significant, scored lower." };
        orders.option = { score: 5, reason: "An incidental framework option token." };
        sidecar.contexts.orders = orders;
        writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

        const second = await discoverState(client);
        const secondManifest = second.manifest as Record<string, unknown>;
        expect(secondManifest.sheetDigest).toBe(firstManifest.sheetDigest);
        expect(secondManifest.glossaryDigests).toEqual(firstManifest.glossaryDigests);
        expect(second.glossarySignificance.orders?.["order-total"]?.score).toBe(55);
        expect(second.glossarySignificance.orders?.option?.score).toBe(5);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "publishes a preserved human decision unscored when the crawl stages no score for it",
    async () => {
      const fixture = createFixture("preserved-unscored");
      const first = startServer({ fixture });
      const firstClient = await connect(first.url);
      try {
        await runDiscover(firstClient);
      } finally {
        firstClient.close();
        first.server.stop(true);
      }

      const dropped = startServer({
        fixture,
        stub: ["--discover", "--discover-glossary-drop"],
      });
      const client = await connect(dropped.url);
      try {
        client.send({ type: "discoverProject" });
        await client.waitFor((message) => message.type === "discoverStarted");
        const stopped = await client.waitFor((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(true);
        const state = await discoverState(client);
        expect(state.error).toBeNull();
        const glossary = state.glossaries[0] as {
          concepts: Array<{ id: string; status: string }>;
        };
        const preserved = glossary.concepts.find((concept) => concept.id === "order-total");
        expect(preserved).toBeDefined();
        expect(preserved?.status).toBe("confirmed");
        expect(state.glossarySignificance.orders?.["order-total"]).toBeUndefined();
        expect(state.glossarySignificance.orders?.order?.score).toBe(80);
      } finally {
        client.close();
        dropped.server.stop(true);
      }
    },
    60000,
  );

  test(
    "accepts a sheet whose levels carry no happy-path count",
    async () => {
      const { server, url } = startServer({
        stub: ["--discover", "--discover-sheet-no-happy-path"],
      });
      const client = await connect(url);
      try {
        const state = await runDiscover(client);
        expect(state.error).toBeNull();
        const testing = state.sheet?.testing;
        if (typeof testing !== "object" || testing === null) {
          throw new Error("the published sheet has no testing section");
        }
        const levelsLeaf = (testing as Record<string, unknown>).levels;
        if (typeof levelsLeaf !== "object" || levelsLeaf === null) {
          throw new Error("the published sheet has no testing levels");
        }
        const values = (levelsLeaf as Record<string, unknown>).value;
        if (!Array.isArray(values)) throw new Error("the testing levels carry no records");
        const publishedLevels = values as Array<Record<string, unknown>>;
        expect(publishedLevels).toHaveLength(1);
        expect(publishedLevels[0]?.happyPath).toBeUndefined();
        expect(publishedLevels[0]?.tests).toBe("1");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );
});

interface DiscoverAgentRow {
  id: string;
  label: string;
  command: string;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  prompt: { agent: string; text: string | null; error: string | null } | null;
}

function agentsOf(state: DiscoverState): DiscoverAgentRow[] {
  return ((state as unknown as { agents?: DiscoverAgentRow[] }).agents ?? []).slice();
}

function agentRow(state: DiscoverState, id: string): DiscoverAgentRow | undefined {
  return agentsOf(state).find((row) => row.id === id);
}

/** Every path one agent owns, relative to the target root. */
function ownedPaths(agent: string): Set<string> {
  if (agent === "sheet") return new Set([".omp/discover/sheet.json"]);
  if (agent === "discover-glossary") {
    return new Set([
      ".omp/discover/glossary/orders.glossary.yaml",
      ".omp/discover/significance.json",
      ".omp/discover/skills/discover-glossary/SKILL.md",
      ".omp/skills/discover-glossary/SKILL.md",
    ]);
  }
  return new Set([
    `.omp/discover/skills/${agent}/SKILL.md`,
    `.omp/skills/${agent}/SKILL.md`,
  ]);
}

const BOOKKEEPING = new Set([".omp/discover/manifest.json", ".omp/discover/decisions.json"]);

/** Byte equality outside the triggered agent's slice and the bookkeeping pair. */
function expectOthersUnchanged(
  before: Map<string, string>,
  after: Map<string, string>,
  agent: string,
): void {
  const owned = ownedPaths(agent);
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of paths) {
    if (owned.has(path) || BOOKKEEPING.has(path)) continue;
    expect(after.get(path)).toBe(before.get(path));
  }
}

async function runAgent(client: TestClient, agent: string): Promise<DiscoverState> {
  client.send({ type: "discoverAgent", agent });
  const started = await client.waitFor(
    (message) => message.type === "discoverStarted" && message.agent === agent,
  );
  expect(String(started.runId)).toMatch(/^run-/);
  const stopped = await client.waitFor(
    (message) => message.type === "discoverStopped" && message.agent === agent,
  );
  expect(stopped.completed).toBe(true);
  return discoverState(client);
}

describe("discovery agents", () => {
  test(
    "each of the seven triggers sends exactly its own prompt and staging directory",
    async () => {
      const agents: Array<{ id: string; command: string }> = [
        { id: "sheet", command: "/discover-sheet" },
        { id: "discover-contribution", command: "/discover-contribution" },
        { id: "discover-testing-strategy", command: "/discover-testing-strategy" },
        { id: "discover-naming-conventions", command: "/discover-naming-conventions" },
        { id: "discover-coding-conventions", command: "/discover-coding-conventions" },
        { id: "discover-architecture-boundaries", command: "/discover-architecture-boundaries" },
        { id: "discover-glossary", command: "/discover-glossary" },
      ];
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        for (const agent of agents) {
          const spawns = spawnCount(fixture.logPath);
          client.send({ type: "discoverAgent", agent: agent.id });
          const started = await client.waitFor(
            (message) => message.type === "discoverStarted" && message.agent === agent.id,
          );
          expect(started.agent).toBe(agent.id);
          const staging = join(
            fixture.root,
            ".omp",
            "discover",
            "staging",
            String(started.runId),
          );
          // The spawn and prompt lines are separate appends: waiting on the
          // spawn count alone can read the prompt half-written, so wait for
          // the prompt line this iteration asserts.
          await waitUntil(
            () =>
              spawnCount(fixture.logPath) === spawns + 1 &&
              prompts(fixture.logPath).length === spawns + 1,
            "one new peer with its prompt",
          );
          expect(prompts(fixture.logPath)[spawns]).toBe(`${agent.command} ${staging}`);
          const stopped = await client.waitFor(
            (message) => message.type === "discoverStopped" && message.agent === agent.id,
          );
          expect(stopped.completed).toBe(true);
          expect(existsSync(staging)).toBe(false);
          const state = await discoverState(client);
          expect(agentRow(state, agent.id)?.state).toBe("succeeded");
          expect(state.activeAgent).toBeNull();
          expect(spawnCount(fixture.logPath)).toBe(spawns + 1);
        }
      } finally {
        client.close();
        server.stop(true);
      }
    },
    90000,
  );

  test(
    "one agent's success publishes only its own slice and leaves the others byte-identical",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        await runDiscover(client);
        for (const agent of [
          "sheet",
          "discover-glossary",
          "discover-testing-strategy",
          "discover-naming-conventions",
          "discover-coding-conventions",
          "discover-architecture-boundaries",
        ]) {
          const before = ompBytes(fixture.root);
          const spawns = spawnCount(fixture.logPath);
          const state = await runAgent(client, agent);
          expect(agentRow(state, agent)?.state).toBe("succeeded");
          expect(spawnCount(fixture.logPath)).toBe(spawns + 1);
          expectOthersUnchanged(before, ompBytes(fixture.root), agent);
        }
      } finally {
        client.close();
        server.stop(true);
      }
    },
    120000,
  );

  test(
    "a host with no published artifacts can publish any one agent's slice",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        const state = await runAgent(client, "discover-testing-strategy");
        expect(state.error).toBeNull();
        expect(state.sheet).toBeNull();
        expect(state.glossaries).toEqual([]);
        expect(state.skills.map((skill) => skill.name)).toEqual([
          "discover-testing-strategy",
        ]);
        expect(existsSync(join(fixture.root, ".omp", "discover", "sheet.json"))).toBe(false);
        const manifest = state.manifest as Record<string, unknown>;
        expect(manifest.sheetDigest).toBeNull();
        expect(
          existsSync(
            join(fixture.root, ".omp", "discover", "skills", "discover-testing-strategy", "SKILL.md"),
          ),
        ).toBe(true);
        expect(
          existsSync(join(fixture.root, ".omp", "skills", "discover-testing-strategy", "SKILL.md")),
        ).toBe(true);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "a failed single trigger publishes nothing and reports one error",
    async () => {
      const fixture = createFixture("agent-failure");
      const healthy = startServer({ fixture });
      const seed = await connect(healthy.url);
      try {
        await runDiscover(seed);
      } finally {
        seed.close();
        healthy.server.stop(true);
      }
      const { server, url } = startServer({
        fixture,
        stub: ["--discover", "--discover-invalid-sheet"],
      });
      const client = await connect(url);
      try {
        const before = ompBytes(fixture.root);
        client.send({ type: "discoverAgent", agent: "sheet" });
        await client.waitFor((message) => message.type === "discoverStarted");
        const errored = await client.waitFor((message) => message.type === "discoverError");
        expect(errored.agent).toBe("sheet");
        const stopped = await client.waitFor((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(false);
        expect(ompBytes(fixture.root)).toEqual(before);
        expect(
          client.events.filter((message) => message.type === "discoverError").length,
        ).toBe(1);
        const state = await discoverState(client);
        expect(agentRow(state, "sheet")?.state).toBe("failed");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    60000,
  );

  test(
    "stopping one agent leaves every published artifact byte-identical",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        await runDiscover(client);
        const before = ompBytes(fixture.root);
        client.send({ type: "discoverAgent", agent: "discover-naming-conventions" });
        await client.waitFor(
          (message) => message.type === "discoverStarted" && message.agent === "discover-naming-conventions",
        );
        client.send({ type: "stopDiscover" });
        const stopped = await client.waitFor((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(false);
        expect(stopped.agent).toBe("discover-naming-conventions");
        expect(ompBytes(fixture.root)).toEqual(before);
        const state = await discoverState(client);
        expect(state.active).toBe(false);
        expect(agentRow(state, "discover-naming-conventions")?.state).toBe("failed");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "a second agent is refused while one runs, and Run all is refused behind it",
    async () => {
      const { server, fixture, url } = startServer({
        stub: ["--discover", "--discover-no-exit", "--delay-ms=60000"],
      });
      const client = await connect(url);
      try {
        client.send({ type: "discoverAgent", agent: "sheet" });
        await client.waitFor((message) => message.type === "discoverStarted");
        const spawns = spawnCount(fixture.logPath);
        client.send({ type: "discoverAgent", agent: "discover-glossary" });
        const refusal = await client.waitFor((message) => message.type === "discoverError");
        expect(String(refusal.message)).toContain("already active");
        expect(spawnCount(fixture.logPath)).toBe(spawns);
        client.send({ type: "discoverProject" });
        const runAllRefusal = await client.waitFor((message) => message.type === "discoverError");
        expect(String(runAllRefusal.message)).toMatch(/active/i);
        expect(spawnCount(fixture.logPath)).toBe(spawns);
        client.send({ type: "stopDiscover" });
        await client.waitFor((message) => message.type === "discoverStopped");
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );

  test(
    "an unknown or non-string agent is refused once, changes nothing, and spawns nothing",
    async () => {
      const { server, fixture, url } = startServer();
      const client = await connect(url);
      try {
        for (const agent of ["ghost", 42, null]) {
          client.send({ type: "discoverAgent", agent });
          const refusal = await client.waitFor((message) => message.type === "discoverError");
          expect(String(refusal.message)).toMatch(/agent/i);
        }
        expect(spawnCount(fixture.logPath)).toBe(0);
        expect(ompBytes(fixture.root)).toEqual(new Map());
        expect(client.events.filter((message) => message.type === "discoverStarted")).toHaveLength(0);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    20000,
  );

  test(
    "Run all publishes each success and halts at the first failure without starting later agents",
    async () => {
      const { server, fixture, url } = startServer({
        stub: ["--discover", "--discover-fail-agent=discover-naming-conventions"],
      });
      const client = await connect(url);
      try {
        client.send({ type: "discoverProject" });
        await client.waitFor((message) => message.type === "discoverStarted");
        const errored = await client.waitFor((message) => message.type === "discoverError");
        expect(errored.agent).toBe("discover-naming-conventions");
        const stopped = await client.waitFor((message) => message.type === "discoverStopped");
        expect(stopped.completed).toBe(false);
        expect(stopped.agent).toBe("discover-naming-conventions");
        expect(
          client.events.filter((message) => message.type === "discoverError").length,
        ).toBe(1);
        const started = client.events
          .filter((message) => message.type === "discoverStarted")
          .map((message) => message.agent);
        expect(started).toEqual([
          "sheet",
          "discover-glossary",
          "discover-testing-strategy",
          "discover-naming-conventions",
        ]);
        expect(prompts(fixture.logPath).map((prompt) => prompt.split(" ")[0])).toEqual([
          "/discover-sheet",
          "/discover-glossary",
          "/discover-testing-strategy",
          "/discover-naming-conventions",
        ]);

        const state = await discoverState(client);
        expect(state.runningAll).toBe(false);
        expect(state.allFailed).toBe("discover-naming-conventions");
        expect(agentRow(state, "sheet")?.state).toBe("succeeded");
        expect(agentRow(state, "discover-glossary")?.state).toBe("succeeded");
        expect(agentRow(state, "discover-testing-strategy")?.state).toBe("succeeded");
        expect(agentRow(state, "discover-naming-conventions")?.state).toBe("failed");
        expect(agentRow(state, "discover-coding-conventions")?.state).toBe("idle");
        expect(agentRow(state, "discover-architecture-boundaries")?.state).toBe("idle");

        // The successful slices stay published and the failed one publishes nothing.
        expect(existsSync(join(fixture.root, ".omp", "discover", "sheet.json"))).toBe(true);
        expect(
          existsSync(join(fixture.root, ".omp", "discover", "glossary", "orders.glossary.yaml")),
        ).toBe(true);
        expect(
          existsSync(
            join(fixture.root, ".omp", "skills", "discover-testing-strategy", "SKILL.md"),
          ),
        ).toBe(true);
        expect(
          existsSync(join(fixture.root, ".omp", "discover", "skills", "discover-naming-conventions")),
        ).toBe(false);
        expect(
          existsSync(
            join(fixture.root, ".omp", "skills", "discover-architecture-boundaries", "SKILL.md"),
          ),
        ).toBe(false);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    60000,
  );

  test(
    "each card carries its own read-only prompt bytes and command",
    async () => {
      const fixture = createFixture("agent-prompts");
      mkdirSync(join(fixture.root, ".devboard", "prompts"), { recursive: true });
      writeFileSync(
        join(fixture.root, ".devboard", "package.json"),
        `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" }, null, 2)}\n`,
      );
      const promptsDir = join(import.meta.dir, "..", "prompts");
      const expected = new Map<string, string>();
      for (const file of [
        "discover-sheet.md",
        "discover-contribution.md",
        "discover-testing-strategy.md",
        "discover-naming-conventions.md",
        "discover-coding-conventions.md",
        "discover-architecture-boundaries.md",
        "discover-glossary.md",
      ]) {
        const text = readFileSync(join(promptsDir, file), "utf8");
        expected.set(`/discover-${file.slice("discover-".length, -".md".length)}`, text);
        writeFileSync(join(fixture.root, ".devboard", "prompts", file), text);
      }
      const { server, url } = startServer({ fixture });
      const client = await connect(url);
      try {
        const state = await discoverState(client);
        const agents = agentsOf(state);
        expect(agents.map((agent) => agent.id)).toEqual([
          "sheet",
          "discover-contribution",
          "discover-testing-strategy",
          "discover-naming-conventions",
          "discover-coding-conventions",
          "discover-architecture-boundaries",
          "discover-glossary",
        ]);
        const texts = new Set<string>();
        for (const agent of agents) {
          expect(agent.prompt === null || "editable" in agent.prompt).toBe(false);
          expect(agent.prompt?.error).toBeNull();
          const command = agent.id === "sheet" ? "/discover-sheet" : `/${agent.id}`;
          expect(agent.prompt?.text).toBe(expected.get(command));
          texts.add(agent.prompt?.text ?? "");
        }
        expect(texts.size).toBe(7);
      } finally {
        client.close();
        server.stop(true);
      }
    },
    30000,
  );
});

describe("declared command aliases", () => {
  test("maps a script body to the command that runs it", () => {
    const root = testDirectory("aliases");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({
        scripts: {
          test: "bun test",
          "test:unit": "bun test",
          build: "tsc -p .",
          lint: "eslint .",
        },
      })}\n`,
    );
    expect(declaredCommandAliases(root)).toEqual([
      { command: "bun test", alias: "npm test" },
      { command: "eslint .", alias: "npm run lint" },
      { command: "tsc -p .", alias: "npm run build" },
    ]);
  });

  test("ignores a missing, malformed, or scriptless manifest", () => {
    const root = testDirectory("aliases-missing");
    expect(declaredCommandAliases(root)).toEqual([]);
    writeFileSync(join(root, "package.json"), "{not json\n");
    expect(declaredCommandAliases(root)).toEqual([]);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ scripts: [] })}\n`);
    expect(declaredCommandAliases(root)).toEqual([]);
  });
});

describe("Overview path links", () => {
  /** A checkout with one entry point, one manifest, and a name that needs escaping. */
  function overviewCheckout(name: string): string {
    const root = testDirectory(name);
    mkdirSync(join(root, "src", "checkout"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "src", "checkout", "flow.ts"), "export {};\n");
    writeFileSync(join(root, "src", "a b#c?.ts"), "export {};\n");
    return root;
  }

  function pathOf(href: string): string {
    return decodeURIComponent(href.slice("vscode://file/".length));
  }

  function leaf(value: unknown): Record<string, unknown> {
    return { value, evidence: ["."], confidence: "observed" };
  }

  test("hands an existing file and an existing directory to VS Code", () => {
    const root = overviewCheckout("links-existing");
    const file = overviewPathLink(root, "src/checkout/flow.ts");
    expect(file?.startsWith("vscode://file/")).toBe(true);
    expect(pathOf(file ?? "")).toBe(join(root, "src", "checkout", "flow.ts"));
    const directory = overviewPathLink(root, "src");
    expect(pathOf(directory ?? "")).toBe(join(root, "src"));
    const manifest = overviewPathLink(root, " package.json ");
    expect(pathOf(manifest ?? "")).toBe(join(root, "package.json"));
  });

  test("escapes a name so the URL decodes to the exact absolute path", () => {
    const root = overviewCheckout("links-escaped");
    const href = overviewPathLink(root, "src/a b#c?.ts");
    expect(href).not.toBeNull();
    expect(href?.includes(" ")).toBe(false);
    expect(href?.includes("#")).toBe(false);
    expect(pathOf(href ?? "")).toBe(join(root, "src", "a b#c?.ts"));
  });

  test("refuses a missing path, an absolute path, and a parent segment", () => {
    const root = overviewCheckout("links-refused");
    expect(overviewPathLink(root, "src/shared")).toBeNull();
    expect(overviewPathLink(root, "/etc/passwd")).toBeNull();
    expect(overviewPathLink(root, "../outside.ts")).toBeNull();
    expect(overviewPathLink(root, "src/../../escape.ts")).toBeNull();
  });

  test("refuses a path that resolves outside the checkout even when it exists", () => {
    const root = overviewCheckout("links-symlink");
    const outside = join(root, "..", `outside-${process.pid}.ts`);
    writeFileSync(outside, "export {};\n");
    try {
      symlinkSync(outside, join(root, "linked.ts"));
      expect(overviewPathLink(root, "linked.ts")).toBeNull();
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("links nothing on a retained remote target", () => {
    const root = overviewCheckout("links-remote");
    const sheet = { architecture: { contexts: leaf([{ entryPoints: ["src"] }]) } };
    expect(overviewPathLink(root, "src", { host: false })).toBeNull();
    expect(overviewPathLinks(root, sheet, { host: false })).toEqual({});
  });

  test("collects the entry points, manifests, and kernels the Overview renders", () => {
    const root = overviewCheckout("links-sheet");
    const sheet = {
      architecture: {
        contexts: leaf([
          { name: "Checkout", entryPoints: ["src/checkout/flow.ts", "src"] },
          { name: "Orders", entryPoints: ["src/shared"] },
        ]),
        sharedKernels: leaf(["src/checkout", "none detected"]),
      },
      runtime: { manifests: leaf(["package.json", "missing.json"]) },
    };
    const links = overviewPathLinks(root, sheet);
    expect(Object.keys(links).sort()).toEqual([
      "package.json",
      "src",
      "src/checkout",
      "src/checkout/flow.ts",
    ]);
    expect(pathOf(links["package.json"] ?? "")).toBe(join(root, "package.json"));
    expect(pathOf(links["src"] ?? "")).toBe(join(root, "src"));
    expect(pathOf(links["src/checkout"] ?? "")).toBe(join(root, "src", "checkout"));
    expect(pathOf(links["src/checkout/flow.ts"] ?? "")).toBe(
      join(root, "src", "checkout", "flow.ts"),
    );
    expect(links["src/shared"]).toBeUndefined();
    expect(links["missing.json"]).toBeUndefined();
    expect(overviewPathLinks(root, null)).toEqual({});
  });
});

/** The fixture a server started from `url` serves, for a restart in one test. */
const fixturesByUrl = new Map<string, Fixture>();

function fixtureFor(url: string): Fixture {
  const fixture = fixturesByUrl.get(url);
  if (fixture === undefined) throw new Error(`no fixture serves ${url}`);
  return fixture;
}
