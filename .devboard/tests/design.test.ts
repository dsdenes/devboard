import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readAuditInput } from "../issues/design/audit";
import {
  createDesignForge,
  type DesignForgeClient,
  type DesignForgeIssue,
} from "../issues/design/forge";
import { preflightDesign } from "../issues/design/preflight";
import { releaseDocuments, type ReleaseResult, type RunCommand } from "../issues/design/release";
import { callTool } from "../mcp/tools";
import type { McpContext } from "../mcp/context";
import type {
  ForgeIssueDocument,
  ForgeIssueSummary,
  ForgeIssues,
} from "../lib/forge-issues";
import {
  DOCUMENTATION_HISTORY_LIMIT,
  capacityFor,
  emptyState,
  parseState,
  recordDocumentationEntry,
  readState,
  writeSettings,
  writeState,
  type DesignDocumentationEntry,
  type DesignIssueRow,
} from "../issues/design/state";
import { DesignWorker, type DesignWorkerOptions } from "../issues/design/worker";
import {
  DESIGN_LABEL,
  LABEL_COLOR,
  LABEL_DESCRIPTION,
  controlDirectory,
  cyclesDirectory,
  designConfig,
  lockPath,
  settingsPath,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
} from "../issues/design/paths";
import { writeCommand } from "../issues/design/control";
import { versionLockPath } from "../issues/lock";
import { readHarnessVersion } from "../server/version";

const harnessRoot = join(import.meta.dir, "..");
const workerVersion = readHarnessVersion(harnessRoot) ?? "test";
const workerLock = (repo: string): string => versionLockPath(lockPath(repo), workerVersion);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(command: string, args: string[], cwd?: string): string {
  const child = Bun.spawnSync({
    cmd: [command, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (child.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${child.stderr.toString()}`);
  }
  return child.stdout.toString().trim();
}

async function fixture(name: string): Promise<{
  root: string;
  repo: string;
  bare: string;
  config: ReturnType<typeof designConfig>;
  stateDir: string;
}> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", `design-${name}-`));
  roots.push(root);
  const repo = join(root, "repo");
  const bare = join(root, "origin.git");
  await mkdir(join(repo, ".devboard", "client"), { recursive: true });
  await mkdir(join(repo, "design"), { recursive: true });
  await mkdir(join(repo, ".devboard", ".tmp"), { recursive: true });
  await writeFile(
    join(repo, ".devboard", "client", "index.html"),
    '<!doctype html>\n<div id="app"></div>\n',
  );
  await writeFile(
    join(repo, ".devboard", "client", "App.svelte"),
    [
      '<script lang="ts">',
      '  const accent = "#58a6ff";',
      "</script>",
      '<main class="panel">Hello</main>',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "DESIGN.md"),
    [
      "# Interface",
      "",
      "## Colors",
      "",
      "Use tokens for every color. The accent token is `#58a6ff`.",
      "",
      "## Design principles",
      "",
      "- One accent token governs emphasis.",
      "",
      "## UX principles",
      "",
      "- Every state carries a word.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "design", "tokens.json"),
    `${JSON.stringify(
      { color: { accent: { $type: "color", $value: { hex: "#58a6ff" } } } },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(repo, "tracked.txt"), "original\n");
  run("git", ["init", "-q"], repo);
  run("git", ["config", "user.email", "devboard@example.test"], repo);
  run("git", ["config", "user.name", "Devboard Test"], repo);
  run("git", ["add", "-A"], repo);
  run("git", ["commit", "-q", "-m", "fixture"], repo);
  run("git", ["init", "--bare", "-q", bare], root);
  run("git", ["remote", "add", "origin", "https://forge.test/acme/fixture.git"], repo);
  run(
    "git",
    ["config", `url.file://${bare}.insteadOf`, "https://forge.test/acme/fixture.git"],
    repo,
  );
  run("git", ["push", "-q", "origin", "HEAD:main"], repo);
  const stateDir = join(repo, ".devboard", ".tmp", "state");
  await mkdir(stateDir, { recursive: true });
  return { root, repo, bare, config: designConfig({}), stateDir };
}

interface DesignFinding {
  category: string;
  title: string;
  principle: { name: string; passage: string };
  evidence: Array<{ path: string; lines: string; quote: string }>;
  files: string[];
  proposedChange: string;
  acceptanceCriteria: string[];
}

function finding(): DesignFinding {
  return {
    category: "color",
    title: "App.svelte hardcodes the accent instead of using the token",
    principle: {
      name: "Tokenized color",
      passage: "Use tokens for every color. The accent token is `#58a6ff`.",
    },
    evidence: [
      {
        path: ".devboard/client/App.svelte",
        lines: "2",
        quote: 'const accent = "#58a6ff";',
      },
    ],
    files: [".devboard/client/App.svelte"],
    proposedChange: "Read the accent through the documented token.",
    acceptanceCriteria: ["App.svelte contains no hardcoded color literal."],
  };
}

/** The complete Markdown body the design prompt requires for each finding. */
function findingBody(entry: DesignFinding): string {
  return [
    "## Category",
    "",
    entry.category,
    "",
    "## Violated principle or token",
    "",
    `**${entry.principle.name}**`,
    "",
    `> ${entry.principle.passage}`,
    "",
    "## Evidence",
    "",
    ...entry.evidence.map(
      (evidence) => `- \`${evidence.path}:${evidence.lines}\`\n  > ${evidence.quote}`,
    ),
    "",
    "## Files",
    "",
    ...entry.files.map((file) => `- \`${file}\``),
    "",
    "## Proposed change",
    "",
    entry.proposedChange,
    "",
    "## Acceptance criteria",
    "",
    ...entry.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "---",
    "",
    "Filed by Design System. Bring the interface in line with DESIGN.md and design/tokens.json.",
    "",
  ].join("\n");
}

interface FakeDesignForge extends ForgeIssues {
  issues: ForgeIssueDocument[];
  labels: Set<string>;
}

/** The in-memory forge the stub's issue tool and the worker both read. */
function fakeDesignForge(firstNumber = 1): FakeDesignForge {
  const issues: ForgeIssueDocument[] = [];
  const labels = new Set<string>();
  return {
    forge: "github",
    repository: "acme/fixture",
    issues,
    labels,
    async list(state: "open" | "closed" | "all", limit = 200): Promise<ForgeIssueSummary[]> {
      return issues
        .filter((issue) => state === "all" || issue.state === state)
        .slice(0, limit)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: issue.labels,
          url: issue.url,
          createdAt: issue.createdAt,
        }));
    },
    async get(number: number): Promise<ForgeIssueDocument> {
      const issue = issues.find((candidate) => candidate.number === number);
      if (issue === undefined) throw new Error(`no issue ${number}`);
      return { ...issue };
    },
    async ensureLabel(name: string): Promise<void> {
      labels.add(name);
    },
    async create(input: {
      title: string;
      body: string;
      labels?: string[];
    }): Promise<ForgeIssueDocument> {
      const highest = issues.reduce((most, issue) => Math.max(most, issue.number), firstNumber - 1);
      const number = highest + 1;
      const issue: ForgeIssueDocument = {
        number,
        title: input.title,
        body: input.body,
        state: "open",
        labels: input.labels ?? [],
        url: `https://forge.test/acme/fixture/issues/${number}`,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      issues.push(issue);
      return { ...issue };
    },
    async comment(): Promise<void> {},
    async close(number: number): Promise<ForgeIssueDocument> {
      const issue = issues.find((candidate) => candidate.number === number);
      if (issue === undefined) throw new Error(`no issue ${number}`);
      issue.state = "closed";
      return { ...issue };
    },
  };
}

/** The worker's own forge client, backed by the same in-memory store. */
function forgeClient(forge: FakeDesignForge): DesignForgeClient {
  return {
    listIssues: async (): Promise<DesignForgeIssue[]> =>
      forge.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        state: issue.state,
        createdAt: issue.createdAt,
        body: issue.body,
      })),
    listOpenIssueTitles: async (): Promise<string[]> =>
      forge.issues
        .filter((issue) => issue.state === "open")
        .map((issue) => issue.title),
    listReleases: async () => [],
    closingCommit: async () => null,
    resolveCommit: async () => null,
    containingReleaseTags: async () => [],
  };
}

/** The tool context a stub turn uses: its cycle log and the injected forge. */
function designContext(
  repo: string,
  stateDir: string,
  cycleDir: string,
  forge: FakeDesignForge,
): McpContext {
  return {
    repoDir: repo,
    harnessDir: join(repo, ".devboard"),
    stateDir,
    environment: { DEVBOARD_TOOL_LOG: join(cycleDir, "tool-log.jsonl") },
    forgeIssues: forge,
  };
}

async function fileFinding(
  repo: string,
  stateDir: string,
  cycleDir: string,
  forge: FakeDesignForge,
  entry: DesignFinding = finding(),
): Promise<void> {
  const result = await callTool(designContext(repo, stateDir, cycleDir, forge), "issue_create", {
    title: entry.title,
    body: findingBody(entry),
    labels: [DESIGN_LABEL],
  });
  if (result.error !== undefined) throw new Error(result.error);
}

const RELEASE_SUMMARY = "Document the accent standard";
const RELEASE_RATIONALE =
  "Two interface surfaces share the same token, so the documented standard prevents drift.";

async function requestRelease(
  repo: string,
  stateDir: string,
  cycleDir: string,
  forge: FakeDesignForge,
): Promise<void> {
  const result = await callTool(
    designContext(repo, stateDir, cycleDir, forge),
    "design_release_request",
    {
      cycleDir,
      summary: RELEASE_SUMMARY,
      rationale: RELEASE_RATIONALE,
    },
  );
  if (result.error !== undefined) throw new Error(result.error);
}

describe("design audit input", () => {
  test("reads the interface sources and both documents", async () => {
    const { repo, config } = await fixture("input");
    const input = readAuditInput(repo, config);
    expect(input.sources.map((file) => file.path)).toContain(".devboard/client/App.svelte");
    expect(input.sources.map((file) => file.path)).toContain(".devboard/client/index.html");
    expect(input.documents.map((document) => document.path)).toEqual([
      "DESIGN.md",
      "design/tokens.json",
    ]);
  });

  test("refuses a missing source checkout or document", async () => {
    const { repo, config } = await fixture("missing");
    rmSync(join(repo, ".devboard", "client"), { recursive: true, force: true });
    expect(() => readAuditInput(repo, config)).toThrow(/installed npm prefix/);
    const other = await fixture("missing-doc");
    rmSync(join(other.repo, "DESIGN.md"));
    expect(() => readAuditInput(other.repo, other.config)).toThrow(/DESIGN.md/);
  });

  test("files a full finding through the issue tool with the design label", async () => {
    const { repo, stateDir } = await fixture("file");
    const forge = fakeDesignForge(7);
    const cycleDir = join(repo, ".devboard", ".tmp", "design", "cycles", "cycle-file");
    await mkdir(cycleDir, { recursive: true });

    await fileFinding(repo, stateDir, cycleDir, forge);

    expect(forge.issues).toHaveLength(1);
    expect(forge.labels.has(DESIGN_LABEL)).toBe(true);
    const [issue] = forge.issues;
    expect(issue?.number).toBe(7);
    expect(issue?.labels).toEqual([DESIGN_LABEL]);
    expect(issue?.title).toBe(finding().title);
    expect(issue?.body).toContain("## Category\n\ncolor");
    expect(issue?.body).toContain("Use tokens for every color");
    expect(issue?.body).toContain("`.devboard/client/App.svelte:2`");
    expect(issue?.body).toContain('> const accent = "#58a6ff";');
    expect(issue?.body).toContain("- `.devboard/client/App.svelte`");
    expect(issue?.body).toContain("## Proposed change");
    expect(issue?.body).toContain("- App.svelte contains no hardcoded color literal.");

    const log = readFileSync(join(cycleDir, "tool-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { tool: string; ok: boolean });
    expect(log).toEqual([{ tool: "issue_create", at: expect.any(String), ok: true, value: expect.any(Object) }]);
  });

  test("a refused tool call records its error and files nothing", async () => {
    const { repo, stateDir } = await fixture("tool-error");
    const forge = fakeDesignForge();
    const cycleDir = join(repo, ".devboard", ".tmp", "design", "cycles", "cycle-error");
    await mkdir(cycleDir, { recursive: true });

    const result = await callTool(designContext(repo, stateDir, cycleDir, forge), "issue_create", {
      title: "",
      body: findingBody(finding()),
      labels: [DESIGN_LABEL],
    });

    expect(result.error).toContain("one-line issue title is required");
    expect(forge.issues).toEqual([]);
    const records = readFileSync(join(cycleDir, "tool-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { tool: string; ok: boolean; error?: string });
    expect(records).toHaveLength(1);
    expect(records[0]?.tool).toBe("issue_create");
    expect(records[0]?.ok).toBe(false);
    expect(records[0]?.error).toContain("one-line issue title is required");
  });

  test("records a release request beside the cycle's draft documents", async () => {
    const { repo, stateDir } = await fixture("release-request");
    const forge = fakeDesignForge();
    const cycleDir = join(repo, ".devboard", ".tmp", "design", "cycles", "cycle-release");
    await mkdir(join(cycleDir, "draft", "design"), { recursive: true });

    await requestRelease(repo, stateDir, cycleDir, forge);

    const request = JSON.parse(readFileSync(join(cycleDir, "release-request.json"), "utf8")) as {
      version: number;
      summary: string;
      rationale: string;
    };
    expect(request.version).toBe(1);
    expect(request.summary).toBe(RELEASE_SUMMARY);
    expect(request.rationale).toBe(RELEASE_RATIONALE);
    expect(existsSync(join(cycleDir, "audit.json"))).toBe(false);
  });
});

describe("design capacity", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  function row(
    number: number,
    createdAt: string,
    state: "pending" | "implemented",
  ): DesignIssueRow {
    return {
      number,
      title: `issue ${number}`,
      url: `https://forge.test/acme/fixture/issues/${number}`,
      createdAt,
      state,
      category: "color",
      version: null,
    };
  }

  test("counts every design issue in the rolling hour in any state", () => {
    const issues = [
      row(1, "2026-01-01T11:30:00.000Z", "implemented"),
      row(2, "2026-01-01T11:45:00.000Z", "pending"),
      row(3, "2026-01-01T09:00:00.000Z", "implemented"),
    ];
    const capacity = capacityFor(
      issues,
      { maxPerHour: 3, maxPending: 5 },
      now,
    );
    expect(capacity.windowCount).toBe(2);
    expect(capacity.hourlyRoom).toBe(1);
    expect(capacity.batch).toBe(1);
  });

  test("the smaller room wins and zero room is zero", () => {
    const issues = [
      row(1, "2026-01-01T11:30:00.000Z", "pending"),
      row(2, "2026-01-01T11:40:00.000Z", "pending"),
    ];
    expect(capacityFor(issues, { maxPerHour: 10, maxPending: 2 }, now).batch).toBe(0);
    expect(capacityFor(issues, { maxPerHour: 2, maxPending: 10 }, now).batch).toBe(0);
    expect(capacityFor(issues, { maxPerHour: null, maxPending: null }, now).batch).toBe(100);
  });
});

function documentationEntry(index: number): DesignDocumentationEntry {
  return {
    at: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    version: `0.1.${index}`,
    url: `https://forge.test/releases/tag/v0.1.${index}`,
    summary: `Change ${index}`,
    files: ["DESIGN.md", "design/tokens.json"],
    diff: `+change ${index}`,
  };
}

describe("design documentation history", () => {
  test("a state file without the history loads with an empty history", () => {
    const state = emptyState({ repo: "acme/fixture", root: "/repo" });
    expect(state.documentation).toEqual([]);
    const legacy = { ...state } as Record<string, unknown>;
    delete legacy.documentation;
    const parsed = parseState(JSON.stringify(legacy));
    expect(parsed?.documentation).toEqual([]);
  });

  test("parses a stored history in its stored order", () => {
    const state = emptyState({ repo: "acme/fixture", root: "/repo" });
    state.documentation = [documentationEntry(2), documentationEntry(1)];
    const parsed = parseState(JSON.stringify(state));
    expect(parsed?.documentation).toEqual(state.documentation);
  });

  test("a malformed history is refused instead of half-loaded", () => {
    const state = emptyState({ repo: "acme/fixture", root: "/repo" });
    const broken = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    broken.documentation = [{ version: "0.1.3" }];
    expect(parseState(JSON.stringify(broken))).toBeUndefined();
  });

  test("records the newest entry first and bounds the stored history", () => {
    let history: DesignDocumentationEntry[] = [];
    for (let index = 1; index <= DOCUMENTATION_HISTORY_LIMIT + 4; index += 1) {
      history = recordDocumentationEntry(history, documentationEntry(index));
    }
    expect(history).toHaveLength(DOCUMENTATION_HISTORY_LIMIT);
    expect(history[0]?.version).toBe(`0.1.${DOCUMENTATION_HISTORY_LIMIT + 4}`);
    expect(history.at(-1)?.version).toBe("0.1.5");
    expect(new Set(history.map((entry) => entry.version)).size).toBe(
      DOCUMENTATION_HISTORY_LIMIT,
    );
  });

  test("the design prompt names the isolated worktree release path", () => {
    const prompt = readFileSync(join(harnessRoot, "prompts", "design-system.md"), "utf8");
    for (const concept of [
      "worktree",
      "origin/main",
      "bun run publish",
      "main checkout",
      "without force",
      "release workflow",
      ".worktree/",
      "issue_create",
      "design_release_request",
      "draft",
    ]) {
      expect(prompt).toContain(concept);
    }
    expect(prompt).toContain("never run git");
  });
});

interface FakePeer {
  peer: {
    pid: number | undefined;
    argv: string[];
    run: (prompt: string) => Promise<unknown>;
    prompt: (prompt: string) => Promise<unknown>;
    answer: () => boolean;
    close: () => void;
  };
}

function fakePeer(
  write: (directory: string) => void | Promise<void>,
  counter: { connects: number },
): FakePeer {
  return {
    peer: {
      pid: undefined,
      argv: [],
      async run(prompt: string) {
        counter.connects += 1;
        await write(prompt.slice("/design-system-audit ".length));
        return {};
      },
      async prompt() {
        return {};
      },
      answer: () => true,
      close: () => undefined,
    },
  };
}

function quietForge(): NonNullable<DesignWorkerOptions["github"]> {
  return {
    listIssues: async () => [],
    listReleases: async () => [],
    listOpenIssueTitles: async () => [],
    closingCommit: async () => null,
    resolveCommit: async () => null,
    containingReleaseTags: async () => [],
  };
}

function versionedWorker(
  repo: string,
  stateDir: string,
  version: string,
  connect: NonNullable<DesignWorkerOptions["connect"]>,
): DesignWorker {
  return new DesignWorker({
    repoDir: repo,
    stateDir,
    harnessVersion: version,
    cadenceMs: 60 * 60_000,
    syncMs: 10_000,
    manualCycles: true,
    github: quietForge(),
    fileIssue: async () => ({ number: 1, url: "https://forge.test/acme/fixture/issues/1" }),
    release: async () => ({
      ok: true,
      version: "0.1.9",
      url: "u",
      sha: "a",
      branch: "b",
      files: [],
      diff: "",
    }),
    connect,
  });
}

interface DesignForgeHarness {
  client: DesignForgeClient;
  issues: DesignForgeIssue[];
  /** One queued issue-read failure per attempt, consumed in order. */
  failures: string[];
  /** A failure every read uses until cleared. */
  failAll: string | null;
  reads: number;
}

function designForge(): DesignForgeHarness {
  const harness: DesignForgeHarness = {
    issues: [],
    failures: [],
    failAll: null,
    reads: 0,
    client: undefined as unknown as DesignForgeClient,
  };
  harness.client = {
    async listIssues() {
      harness.reads += 1;
      const message = harness.failures.shift() ?? harness.failAll;
      if (message !== null) throw new Error(message);
      return harness.issues.map((issue) => ({ ...issue }));
    },
    async listOpenIssueTitles() {
      if (harness.failAll !== null) throw new Error(harness.failAll);
      return harness.issues.filter((issue) => issue.state === "open").map((issue) => issue.title);
    },
    async listReleases() {
      if (harness.failAll !== null) throw new Error(harness.failAll);
      return [];
    },
    async closingCommit() {
      return null;
    },
    async resolveCommit() {
      return null;
    },
    async containingReleaseTags() {
      return [];
    },
  };
  return harness;
}

function forgeIssue(number: number, state: "open" | "closed" = "open"): DesignForgeIssue {
  return {
    number,
    title: `Forge issue ${number}`,
    url: `https://forge.test/acme/fixture/issues/${number}`,
    state,
    createdAt: "2026-01-10T10:00:00.000Z",
    body: "",
  };
}

/** A worker whose periodic read has a deterministic ticker and clock. */
function retryWorker(options: {
  repo: string;
  stateDir: string;
  github: DesignForgeClient;
  clock: { now: Date };
  manualCycles?: boolean;
  connects?: { connects: number };
}): DesignWorker {
  return new DesignWorker({
    repoDir: options.repo,
    stateDir: options.stateDir,
    cadenceMs: 0,
    syncMs: 60_000,
    tickMs: 10 * 60_000,
    manualCycles: options.manualCycles ?? true,
    now: () => new Date(options.clock.now),
    github: options.github,
    fileIssue: async () => ({ number: 1, url: "https://forge.test/issues/1" }),
    release: async () => ({
      ok: true,
      version: "0.1.9",
      url: "u",
      sha: "a",
      branch: "b",
      files: [],
      diff: "",
    }),
    connect: () =>
      fakePeer((directory) => {
        writeFileSync(
          join(directory, "audit.json"),
          JSON.stringify({ findings: [], documentation: { decision: "none" } }),
        );
      }, options.connects ?? { connects: 0 }).peer as never,
  });
}

describe("design worker", () => {
  test("files a valid finding, records activity, and skips the release on no decision", async () => {
    const { repo, stateDir } = await fixture("worker");
    const forge = fakeDesignForge(7);
    const counter = { connects: 0 };
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "https://forge.test/released", sha: "a", branch: "b", files: [], diff: "" };
      },
      connect: () =>
        fakePeer((directory) => fileFinding(repo, stateDir, directory, forge), counter).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(forge.issues.map((entry) => entry.title)).toEqual([finding().title]);
    expect(forge.issues[0]?.labels).toEqual([DESIGN_LABEL]);
    expect(released).toBe(0);
    expect(worker.currentState.issues[0]?.number).toBe(7);
    expect(worker.currentState.issues[0]?.category).toBe("color");
    expect(worker.currentState.release).toBeNull();
    expect(worker.currentState.documentation).toEqual([]);
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("filed #7");
    expect(readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "tool-log.jsonl"),
      "utf8",
    )).toContain('"tool":"issue_create"');
    expect(existsSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "audit.json"),
    )).toBe(false);
    await worker.stop();
  });

  test("a successful release records its summary, files, version, URL, time, and diff", async () => {
    const { repo, stateDir } = await fixture("history");
    const forge = fakeDesignForge();
    const at = new Date("2026-03-04T05:06:07.000Z");
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      now: () => at,
      github: forgeClient(forge),
      release: async () => ({
        ok: true,
        version: "0.1.42",
        url: "https://forge.test/acme/fixture/releases/tag/v0.1.42",
        sha: "abc",
        branch: "design/cycle-1",
        files: ["DESIGN.md", "design/tokens.json"],
        diff: "--- a/DESIGN.md\n+++ b/DESIGN.md\n@@ -1 +1 @@\n-old\n+new\n",
      }),
      connect: () =>
        fakePeer(async (directory) => {
          writeFileSync(
            join(directory, "draft", "DESIGN.md"),
            `${readFileSync(join(directory, "draft", "DESIGN.md"), "utf8")}\n- One accent token.\n`,
          );
          await requestRelease(repo, stateDir, directory, forge);
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(worker.currentState.documentation).toHaveLength(1);
    expect(worker.currentState.documentation[0]).toEqual({
      at: at.toISOString(),
      version: "0.1.42",
      url: "https://forge.test/acme/fixture/releases/tag/v0.1.42",
      summary: "Document the accent standard",
      files: ["DESIGN.md", "design/tokens.json"],
      diff: "--- a/DESIGN.md\n+++ b/DESIGN.md\n@@ -1 +1 @@\n-old\n+new\n",
    });
    await worker.stop();
    const persisted = JSON.parse(
      readFileSync(versionedStatePath(stateDir, repo, workerVersion), "utf8"),
    ) as { documentation?: unknown[] };
    expect(persisted.documentation).toHaveLength(1);
  });

  test("a single flight never starts a second cycle", async () => {
    const { repo, stateDir } = await fixture("single-flight");
    const forge = fakeDesignForge();
    const counter = { connects: 0 };
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" }),
      connect: () => fakePeer(() => undefined, counter).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await Promise.all([worker.beginCycle(), worker.beginCycle()]);
    await worker.waitForCycle();
    expect(counter.connects).toBe(1);
    await worker.stop();
  });

  test("a slow audit keeps a successful forge read fresh and still files its findings", async () => {
    const { repo, stateDir } = await fixture("slow-audit");
    const forge = fakeDesignForge(7);
    let now = new Date("2026-03-01T12:00:00.000Z");
    const audit = Promise.withResolvers<void>();
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      now: () => now,
      github: forgeClient(forge),
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" }),
      connect: () => ({
        pid: undefined,
        argv: [],
        async run(prompt: string) {
          await audit.promise;
          const directory = prompt.slice("/design-system-audit ".length);
          await fileFinding(repo, stateDir, directory, forge);
          return {};
        },
        async prompt() {
          return {};
        },
        answer: () => true,
        close: () => undefined,
      }) as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    now = new Date(now.getTime() + 25_000);
    await worker.tickNow();
    expect(worker.currentState.sync.state).toBe("ok");
    audit.resolve();
    await worker.waitForCycle();
    expect(forge.issues.map((entry) => entry.title)).toEqual([finding().title]);
    expect(worker.currentState.issues.map((entry) => entry.number)).toEqual([7]);
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("filed #7");
    expect(activity).not.toContain("failed:");
    await worker.stop();
  });

  test("a failed forge read still files through the tool and records the read failure", async () => {
    const { repo, stateDir } = await fixture("read-failure");
    const forge = fakeDesignForge();
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => {
          throw new Error("gh: HTTP 401: Bad credentials");
        },
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" }),
      connect: () =>
        fakePeer((directory) => fileFinding(repo, stateDir, directory, forge), { connects: 0 })
          .peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    expect(worker.currentState.sync.error).not.toBeNull();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(forge.issues.map((entry) => entry.title)).toEqual([finding().title]);
    expect(worker.currentState.issues).toEqual([]);
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("filed #1");
    expect(activity).toContain("could not re-read the forge");
    await worker.stop();
  });

  test("a refused issue tool call records the tool error", async () => {
    const { repo, stateDir } = await fixture("bad-audit");
    const forge = fakeDesignForge();
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" }),
      connect: () =>
        fakePeer(async (directory) => {
          const result = await callTool(
            designContext(repo, stateDir, directory, forge),
            "issue_create",
            { title: "", body: findingBody(finding()), labels: [DESIGN_LABEL] },
          );
          if (result.error === undefined) throw new Error("the tool accepted an empty title");
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(forge.issues).toEqual([]);
    expect(worker.currentState.issues).toEqual([]);
    expect(worker.currentState.lastError).toContain("one-line issue title is required");
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("failed: A one-line issue title is required.");
    expect(existsSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "audit.json"),
    )).toBe(false);
    await worker.stop();
  });

  test("ignores an audit answer file left in the cycle directory", async () => {
    const { repo, stateDir } = await fixture("ignored-audit");
    const forge = fakeDesignForge();
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" }),
      connect: () =>
        fakePeer((directory) => {
          writeFileSync(join(directory, "audit.json"), "{ not json");
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(worker.currentState.issues).toEqual([]);
    expect(worker.currentState.lastError).toBeNull();
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).not.toContain("JSON");
    expect(activity).not.toContain("filed #");
    await worker.stop();
  });

  test("a draft change without a release request is not released", async () => {
    const { repo, stateDir } = await fixture("bless-drift");
    const forge = fakeDesignForge();
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" };
      },
      connect: () =>
        fakePeer((directory) => {
          const draft = join(directory, "draft", "DESIGN.md");
          writeFileSync(draft, "legalized drift\n");
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(released).toBe(0);
    expect(worker.currentState.documentation).toEqual([]);
    expect(worker.currentState.release).toBeNull();
    expect(readFileSync(join(repo, "DESIGN.md"), "utf8")).toContain("Use tokens for every color");
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("ignored a document change without a release request");
    await worker.stop();
  });

  test("a rejecting release settles the cycle, records the failure, and a later cycle runs", async () => {
    const { repo, stateDir } = await fixture("release-throws");
    const forge = fakeDesignForge();
    const counter = { connects: 0 };
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => {
        released += 1;
        throw new Error("boom");
      },
      connect: () =>
        fakePeer(async (directory) => {
          writeFileSync(
            join(directory, "draft", "DESIGN.md"),
            `${readFileSync(join(directory, "draft", "DESIGN.md"), "utf8")}\n- One accent token.\n`,
          );
          await requestRelease(repo, stateDir, directory, forge);
        }, counter).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(released).toBe(1);
    expect(worker.cyclingNow).toBe(false);
    expect(worker.currentState.lifecycle).toBe("idle");
    expect(worker.currentState.lastError).toContain("boom");
    expect(worker.currentState.documentation).toEqual([]);

    await worker.beginCycle();
    await worker.waitForCycle();
    expect(counter.connects).toBe(2);
    await worker.stop();
  });

  test("a stop during the release waits for it before reporting stopped", async () => {
    const { repo, stateDir } = await fixture("stop-releasing");
    const forge = fakeDesignForge();
    const gate = Promise.withResolvers<ReleaseResult>();
    const releaseStarted = Promise.withResolvers<void>();
    const observed = { stoppedCalls: 0, lockAtStop: true, lifecycleAtStop: "" };
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => {
        releaseStarted.resolve();
        return gate.promise;
      },
      connect: () =>
        fakePeer(async (directory) => {
          writeFileSync(
            join(directory, "draft", "DESIGN.md"),
            `${readFileSync(join(directory, "draft", "DESIGN.md"), "utf8")}\n- One accent token.\n`,
          );
          await requestRelease(repo, stateDir, directory, forge);
        }, { connects: 0 }).peer as never,
      onStopped: () => {
        observed.stoppedCalls += 1;
        observed.lockAtStop = existsSync(workerLock(repo));
        observed.lifecycleAtStop = worker.currentState.lifecycle;
      },
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await releaseStarted.promise;
    expect(worker.currentState.lifecycle).toBe("releasing");

    const stopping = worker.stop();
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(observed.stoppedCalls).toBe(0);
    expect(worker.currentState.lifecycle).toBe("releasing");
    expect(existsSync(workerLock(repo))).toBe(true);

    gate.resolve({
      ok: true,
      version: "0.1.10",
      url: "https://forge.test/released",
      sha: "a",
      branch: "b",
      files: [],
      diff: "",
    });
    await stopping;
    expect(observed.stoppedCalls).toBe(1);
    expect(observed.lifecycleAtStop).toBe("stopped");
    expect(observed.lockAtStop).toBe(false);
    expect(worker.currentState.lifecycle).toBe("stopped");
    expect(worker.currentState.release?.version).toBe("0.1.10");
    expect(existsSync(workerLock(repo))).toBe(false);

    await worker.stop();
    expect(observed.stoppedCalls).toBe(1);
  });

  test("a missing draft document fails the cycle instead of rejecting it", async () => {
    const { repo, stateDir } = await fixture("missing-draft");
    const forge = fakeDesignForge();
    const counter = { connects: 0 };
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" };
      },
      connect: () =>
        fakePeer(async (directory) => {
          writeFileSync(
            join(directory, "draft", "DESIGN.md"),
            `${readFileSync(join(directory, "draft", "DESIGN.md"), "utf8")}\n- One accent token.\n`,
          );
          rmSync(join(directory, "draft", "design", "tokens.json"));
          await requestRelease(repo, stateDir, directory, forge);
        }, counter).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(released).toBe(0);
    expect(worker.cyclingNow).toBe(false);
    expect(worker.currentState.lifecycle).toBe("idle");
    expect(worker.currentState.lastError).toContain("design/tokens.json");
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("release failed");
    expect(activity).toContain("design/tokens.json");

    await worker.beginCycle();
    await worker.waitForCycle();
    expect(counter.connects).toBe(2);
    await worker.stop();
  });

  test("a draft missing a principle section is refused without a cycle error", async () => {
    const { repo, stateDir } = await fixture("missing-principles");
    const design = readFileSync(join(repo, "DESIGN.md"), "utf8");
    writeFileSync(
      join(repo, "DESIGN.md"),
      design
        .replace("## Design principles", "## Styling")
        .replace("## UX principles", "## Interactions"),
    );
    let released = 0;
    const forge = fakeDesignForge();
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" };
      },
      connect: () =>
        fakePeer(async (directory) => {
          writeFileSync(
            join(directory, "draft", "DESIGN.md"),
            `${readFileSync(join(directory, "draft", "DESIGN.md"), "utf8")}\n- One accent token.\n`,
          );
          await requestRelease(repo, stateDir, directory, forge);
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(released).toBe(0);
    expect(worker.currentState.documentation).toEqual([]);
    expect(worker.currentState.lifecycle).toBe("idle");
    expect(worker.currentState.lastError).toBeNull();
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("documentation rejected");
    expect(activity).toContain("lacks ## Design principles and ## UX principles");
    expect(activity).not.toContain("release failed");
    await worker.stop();
  });

  test("a draft token document that is not an object is refused without a cycle error", async () => {
    const { repo, stateDir } = await fixture("invalid-tokens");
    const forge = fakeDesignForge();
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" };
      },
      connect: () =>
        fakePeer(async (directory) => {
          writeFileSync(
            join(directory, "draft", "DESIGN.md"),
            `${readFileSync(join(directory, "draft", "DESIGN.md"), "utf8")}\n- One accent token.\n`,
          );
          writeFileSync(join(directory, "draft", "design", "tokens.json"), "[]\n");
          await requestRelease(repo, stateDir, directory, forge);
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(released).toBe(0);
    expect(worker.currentState.documentation).toEqual([]);
    expect(worker.currentState.release).toBeNull();
    expect(worker.currentState.lifecycle).toBe("idle");
    expect(worker.currentState.lastError).toBeNull();
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("documentation rejected");
    expect(activity).toContain("design/tokens.json is not a JSON object");
    expect(activity).not.toContain("release failed");
    await worker.stop();
  });

  test("a release request without a draft change leaves the release state unchanged", async () => {
    const { repo, stateDir } = await fixture("no-draft-change");
    const forge = fakeDesignForge();
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" };
      },
      connect: () =>
        fakePeer((directory) => requestRelease(repo, stateDir, directory, forge), {
          connects: 0,
        }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(released).toBe(0);
    expect(worker.currentState.documentation).toEqual([]);
    expect(worker.currentState.release).toBeNull();
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("the release request produced no changed document");
    await worker.stop();
  });

  test("a zero room files nothing and records the empty room", async () => {
    const { repo, stateDir } = await fixture("zero-room");
    const forge = fakeDesignForge();
    await forge.create({ title: "existing open design issue", body: "", labels: [DESIGN_LABEL] });
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: forgeClient(forge),
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b", files: [], diff: "" }),
      connect: () =>
        fakePeer(async (directory) => {
          const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as {
            issueRoom: number;
          };
          if (request.issueRoom > 0) await fileFinding(repo, stateDir, directory, forge);
        }, { connects: 0 }).peer as never,
    });
    writeSettings(settingsPath(stateDir, repo), {
      maxPerHour: 1,
      maxPending: 1,
      intervalMinutes: 60,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(forge.issues.map((entry) => entry.title)).toEqual(["existing open design issue"]);
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("room 0");
    expect(activity).not.toContain("filed #");
    expect(existsSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "tool-log.jsonl"),
    )).toBe(false);
    await worker.stop();
  });
});

describe("design version handover", () => {
  test("claims one cycle across versions and gives the next to the newer worker", async () => {
    const { repo, stateDir } = await fixture("claim");
    const gate = Promise.withResolvers<void>();
    const olderConnects = { connects: 0 };
    const older = versionedWorker(repo, stateDir, "0.1.0", (options) => {
      return {
        pid: undefined,
        argv: [],
        async run() {
          olderConnects.connects += 1;
          await gate.promise;
          writeFileSync(
            join(options.cwd, "audit.json"),
            JSON.stringify({ findings: [], documentation: { decision: "none" } }),
          );
          return {};
        },
        async prompt() {
          return {};
        },
        answer: () => true,
        close: () => undefined,
      } as never;
    });
    const newerCounter = { connects: 0 };
    const newer = versionedWorker(repo, stateDir, "0.2.0", () =>
      fakePeer((directory) => {
        writeFileSync(
          join(directory, "audit.json"),
          JSON.stringify({ findings: [], documentation: { decision: "none" } }),
        );
      }, newerCounter).peer as never,
    );
    expect(older.start("acme/fixture")).toBe(true);
    expect(newer.start("acme/fixture")).toBe(true);

    await older.beginCycle();
    await newer.beginCycle();
    expect(older.cyclingNow).toBe(true);
    expect(newer.cyclingNow).toBe(false);
    const first = readdirSync(cyclesDirectory(repo));
    expect(first).toHaveLength(1);

    gate.resolve();
    await older.waitForCycle();
    await newer.beginCycle();
    expect(newer.cyclingNow).toBe(true);
    await newer.waitForCycle();
    const cycles = readdirSync(cyclesDirectory(repo));
    expect(cycles).toHaveLength(2);
    expect(new Set(cycles).size).toBe(2);
    expect(olderConnects.connects).toBe(1);
    expect(newerCounter.connects).toBe(1);

    await older.stop();
    await newer.stop();
  }, 20_000);

  test("drains after the in-flight cycle, then exits and releases its versioned lock", async () => {
    const { repo, stateDir } = await fixture("drain");
    const version = "0.2.0";
    const gate = Promise.withResolvers<void>();
    const worker = versionedWorker(repo, stateDir, version, (options) => {
      return {
        pid: undefined,
        argv: [],
        async run() {
          await gate.promise;
          writeFileSync(
            join(options.cwd, "audit.json"),
            JSON.stringify({ findings: [], documentation: { decision: "none" } }),
          );
          return {};
        },
        async prompt() {
          return {};
        },
        answer: () => true,
        close: () => undefined,
      } as never;
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    expect(worker.currentState.lifecycle).toBe("auditing");

    writeCommand(versionedControlDirectory(stateDir, repo, version), { type: "drain" });
    await worker.tickNow();
    expect(worker.currentState.draining).toBe(true);
    expect(worker.currentState.notice).toContain("Draining");
    expect(worker.cyclingNow).toBe(true);
    expect(existsSync(versionLockPath(lockPath(repo), version))).toBe(true);

    gate.resolve();
    await worker.waitForCycle();
    await worker.tickNow();
    expect(worker.currentState.lifecycle).toBe("stopped");
    expect(worker.currentState.enabled).toBe(false);
    expect(worker.currentState.notice).toContain("Drained");
    expect(existsSync(versionLockPath(lockPath(repo), version))).toBe(false);
    const persisted = readState(versionedStatePath(stateDir, repo, version));
    expect(persisted?.lifecycle).toBe("stopped");
    expect(persisted?.newestCycleId).toBe(worker.currentState.newestCycleId);
    expect(persisted?.documentation).toEqual([]);
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", persisted!.newestCycleId!, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("cycle ");
  }, 20_000);

  test("leaves a live legacy worker's control directory to that worker", async () => {
    const { repo, stateDir } = await fixture("legacy-live");
    const sleeper = Bun.spawn({
      cmd: [process.execPath, "-e", "setInterval(() => undefined, 1000);"],
      cwd: repo,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    try {
      mkdirSync(join(repo, ".devboard", ".tmp", "design"), { recursive: true });
      writeFileSync(
        lockPath(repo),
        JSON.stringify({
          pid: sleeper.pid,
          startedAt: new Date().toISOString(),
          repo,
          stateDir,
          harnessVersion: null,
          argv: ["legacy"],
        }),
      );
      writeCommand(controlDirectory(stateDir, repo), { type: "cadence", intervalMinutes: 90 });
      const worker = versionedWorker(repo, stateDir, "0.2.0", () =>
        fakePeer((directory) => {
          writeFileSync(
            join(directory, "audit.json"),
            JSON.stringify({ findings: [], documentation: { decision: "none" } }),
          );
        }, { connects: 0 }).peer as never,
      );
      expect(worker.start("acme/fixture")).toBe(true);
      await worker.tickNow();
      expect(worker.currentState.intervalMinutes).toBe(60);
      expect(readdirSync(controlDirectory(stateDir, repo))).toHaveLength(1);
      await worker.stop();

      sleeper.kill("SIGKILL");
      await sleeper.exited;
      const successor = versionedWorker(repo, stateDir, "0.2.0", () =>
        fakePeer((directory) => {
          writeFileSync(
            join(directory, "audit.json"),
            JSON.stringify({ findings: [], documentation: { decision: "none" } }),
          );
        }, { connects: 0 }).peer as never,
      );
      expect(successor.start("acme/fixture")).toBe(true);
      await successor.tickNow();
      expect(successor.currentState.intervalMinutes).toBe(90);
      await successor.stop();
    } finally {
      sleeper.kill("SIGKILL");
      await sleeper.exited;
    }
  }, 20_000);

  test("adopts the legacy state and consumes the legacy control directory", async () => {
    const { repo, stateDir } = await fixture("legacy-state");
    const version = "0.2.0";
    const legacy = {
      ...emptyState({
        repo: "acme/fixture",
        root: repo,
        lifecycle: "idle" as const,
        now: new Date("2026-02-01T00:00:00.000Z"),
      }),
      enabled: true,
      lastCycleStartedAt: "2026-01-01T00:00:00.000Z",
      newestCycleId: "20260101-000000-000001-0001",
      documentation: [documentationEntry(1)],
    };
    writeState(statePath(stateDir, repo), legacy);
    writeCommand(controlDirectory(stateDir, repo), { type: "cadence", intervalMinutes: 90 });

    const worker = versionedWorker(repo, stateDir, version, () =>
      fakePeer((directory) => {
        writeFileSync(
          join(directory, "audit.json"),
          JSON.stringify({ findings: [], documentation: { decision: "none" } }),
        );
      }, { connects: 0 }).peer as never,
    );
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.tickNow();
    expect(worker.currentState.intervalMinutes).toBe(90);
    expect(worker.currentState.lastCycleStartedAt).toBe(legacy.lastCycleStartedAt);
    expect(worker.currentState.newestCycleId).toBe(legacy.newestCycleId);
    expect(worker.currentState.documentation).toEqual([documentationEntry(1)]);
    expect(existsSync(versionedStatePath(stateDir, repo, version))).toBe(true);
    await worker.stop();
  }, 20_000);
});

describe("design preflight", () => {
  function giteaFetch(input: RequestInfo | URL): Response {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/repos/acme/fixture")) {
      return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
    }
    if (path.endsWith("/labels")) {
      return new Response(JSON.stringify([{ id: 1, name: "design" }]), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  }

  const environment = {
    PATH: process.env.PATH,
    DEVBOARD_GITEA_URL: "https://forge.test",
    GITEA_TOKEN: "token",
    HOME: process.env.HOME,
  };

  test("accepts a canonical source checkout with the documents, origin, label, and tools", async () => {
    const { repo, stateDir, config } = await fixture("preflight");
    const result = await preflightDesign({
      repoDir: repo,
      stateDir,
      config,
      environment,
      giteaFetch: giteaFetch as never,
      origin: { forge: "gitea", host: "forge.test", project: "acme/fixture" },
    });
    expect(result).toEqual({ ok: true, repository: "acme/fixture" });
  });

  test("names each missing fact and refuses before a worker exists", async () => {
    const { repo, stateDir, config } = await fixture("preflight-missing");
    const missingClient = await preflightDesign({
      repoDir: repo,
      stateDir,
      config: { ...config, sourceDir: ".devboard/not-client" },
      environment,
      giteaFetch: giteaFetch as never,
      origin: { forge: "gitea", host: "forge.test", project: "acme/fixture" },
    });
    expect(missingClient.ok).toBe(false);
    if (!missingClient.ok) expect(missingClient.message).toContain(".devboard/not-client");

    const missingDoc = await preflightDesign({
      repoDir: repo,
      stateDir,
      config: { ...config, designDocument: "MISSING.md" },
      environment,
      giteaFetch: giteaFetch as never,
      origin: { forge: "gitea", host: "forge.test", project: "acme/fixture" },
    });
    expect(missingDoc.ok).toBe(false);
    if (!missingDoc.ok) expect(missingDoc.message).toContain("MISSING.md");

    const noWrite = await preflightDesign({
      repoDir: repo,
      stateDir,
      config,
      environment,
      giteaFetch: ((input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/repos/acme/fixture")) {
          return new Response(JSON.stringify({ permissions: { push: false } }), { status: 200 });
        }
        return new Response(JSON.stringify([{ id: 1, name: "design" }]), { status: 200 });
      }) as never,
      origin: { forge: "gitea", host: "forge.test", project: "acme/fixture" },
    });
    expect(noWrite.ok).toBe(false);
    if (!noWrite.ok) expect(noWrite.message).toContain("cannot write");

    const noTools = await preflightDesign({
      repoDir: repo,
      stateDir,
      config,
      environment: { ...environment, PATH: "" },
      giteaFetch: giteaFetch as never,
      origin: { forge: "gitea", host: "forge.test", project: "acme/fixture" },
    });
    expect(noTools.ok).toBe(false);
    if (!noTools.ok) expect(noTools.message).toContain("git is not on PATH");
  });

  test("creates the missing design label instead of refusing Start", async () => {
    const { repo, stateDir, config } = await fixture("preflight-create-label");
    const writes: Array<{ method: string; body: unknown }> = [];
    const result = await preflightDesign({
      repoDir: repo,
      stateDir,
      config,
      environment,
      giteaFetch: (async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        const method = init?.method ?? "GET";
        if (path.endsWith("/repos/acme/fixture")) {
          return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
        }
        if (path.endsWith("/labels") && method === "POST") {
          writes.push({ method, body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ id: 2, name: DESIGN_LABEL }), { status: 201 });
        }
        if (path.endsWith("/labels")) {
          return new Response(JSON.stringify([{ id: 1, name: "scout" }]), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }) as never,
      origin: { forge: "gitea", host: "forge.test", project: "acme/fixture" },
    });
    expect(result).toEqual({ ok: true, repository: "acme/fixture" });
    expect(writes).toEqual([
      {
        method: "POST",
        body: { name: DESIGN_LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION },
      },
    ]);
  });

  test("refuses Start when the missing design label cannot be created", async () => {
    const { repo, stateDir, config } = await fixture("preflight-label-failure");
    const result = await preflightDesign({
      repoDir: repo,
      stateDir,
      config,
      environment,
      giteaFetch: (async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        const method = init?.method ?? "GET";
        if (path.endsWith("/repos/acme/fixture")) {
          return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
        }
        if (path.endsWith("/labels") && method === "POST") {
          return new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
        }
        if (path.endsWith("/labels")) {
          return new Response(JSON.stringify([{ id: 1, name: "scout" }]), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }) as never,
      origin: { forge: "gitea", host: "forge.test", project: "acme/fixture" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("could not be created");
  });
});

interface ReleaseFixture {
  repo: string;
  bare: string;
  config: ReturnType<typeof designConfig>;
}

async function releaseFixture(name: string): Promise<ReleaseFixture> {
  const { repo, bare, config } = await fixture(name);
  return { repo, bare, config };
}

function documents(config: ReturnType<typeof designConfig>): Array<{ path: string; text: string }> {
  return [
    { path: config.designDocument, text: "" },
    { path: config.tokenDocument, text: "" },
  ];
}

function readDocuments(repo: string, config: ReturnType<typeof designConfig>) {
  return documents(config).map((document) => ({
    path: document.path,
    text: readFileSync(join(repo, document.path), "utf8"),
  }));
}

/** Wrap the real runner so a test can advance origin at a chosen step. */
function hookRun(
  repo: string,
  bare: string,
  hook: (argv: string[]) => void,
): RunCommand {
  return async (argv, options) => {
    hook(argv);
    const child = Bun.spawnSync({
      cmd: argv,
      cwd: options.cwd,
      env: options.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: child.exitCode ?? 1,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  };
}

function advanceOrigin(bare: string, worktree: string, fileName: string, text: string): void {
  writeFileSync(join(worktree, fileName), text);
  run("git", ["add", fileName], worktree);
  run("git", ["commit", "-q", "-m", "concurrent"], worktree);
  run("git", ["push", "-q", "origin", "HEAD:main"], worktree);
}

describe("design release planner", () => {
  test("creates a cycle worktree, commits only the documents, pushes, publishes once, and cleans up", async () => {
    const { repo, bare, config } = await releaseFixture("release");
    const current = readDocuments(repo, config);
    const next = current.map((document) => ({
      ...document,
      text:
        document.path === config.designDocument
          ? `${document.text}\n## Design principles\n\n- Accent is one token.\n\n## UX principles\n\n- Every state carries a word.\n`
          : `${document.text}\n`,
    }));
    const published: Array<{ version: string; sha: string }> = [];
    const result = await releaseDocuments({
      repoDir: repo,
      harnessDir: join(repo, ".devboard"),
      cycleId: "cycle-1",
      summary: "Document the accent standard",
      config,
      documents: next,
      environment: { PATH: process.env.PATH },
      activity: () => undefined,
      now: () => new Date(),
      waitForWorkflow: async () => ({ ok: true }),
      publish: async (options) => {
        published.push({ version: options.version, sha: options.sha });
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe("1.0.0");
    expect(published).toHaveLength(1);
    expect(published[0]?.version).toBe("1.0.0");
    const bareHead = run("git", ["--git-dir", bare, "rev-parse", "main"]);
    expect(bareHead).toBe(result.sha);
    const bareFiles = run("git", ["--git-dir", bare, "show", "--name-only", "--format=", "main"]);
    expect(bareFiles.split("\n").sort()).toEqual(["DESIGN.md", "design/tokens.json"].sort());
    expect(result.files).toEqual(["DESIGN.md", "design/tokens.json"]);
    expect(result.diff).toContain("--- a/DESIGN.md");
    expect(result.diff).toContain("+++ b/DESIGN.md");
    expect(result.diff).toContain("+## Design principles");
    expect(result.diff).toContain("+- Accent is one token.");
    expect(result.diff).toContain("--- a/design/tokens.json");
    expect(existsSync(join(repo, ".worktree", "design-cycle-1"))).toBe(false);
    expect(run("git", ["branch", "--list", "design/cycle-1"], repo)).toBe("");
  });

  test("a rejected push is integrated, rechecked, and pushed again", async () => {
    const { repo, bare, config } = await releaseFixture("reject");
    const current = readDocuments(repo, config);
    const next = current.map((document) => ({
      ...document,
      text:
        document.path === config.designDocument
          ? `${document.text}\n## Design principles\n\n- Accent is one token.\n\n## UX principles\n\n- Every state carries a word.\n`
          : document.text,
    }));
    let advanced = false;
    const worktree = join(repo, ".worktree");
    const result = await releaseDocuments({
      repoDir: repo,
      harnessDir: join(repo, ".devboard"),
      cycleId: "cycle-2",
      summary: "Document the accent standard",
      config,
      documents: next,
      environment: { PATH: process.env.PATH },
      activity: () => undefined,
      now: () => new Date(),
      run: hookRun(repo, bare, (argv) => {
        if (advanced) return;
        if (argv.includes("--name-only") && argv.includes("origin/main...HEAD")) {
          advanced = true;
          const temporary = join(worktree, "concurrent");
          run("git", ["worktree", "add", "-q", "--detach", temporary, "main"], repo);
          advanceOrigin(bare, temporary, config.designDocument, "concurrent main\n");
          run("git", ["worktree", "remove", "--force", temporary], repo);
        }
      }),
      waitForWorkflow: async () => ({ ok: true }),
      publish: async () => ({ ok: true }),
    });
    expect(result.ok ? "" : result.detail).toBe("");
    if (!result.ok) return;
    expect(run("git", ["--git-dir", bare, "rev-parse", "main"])).toBe(result.sha);
  });

  test("a conflicting main is resolved and the accepted standard survives", async () => {
    const { repo, bare, config } = await releaseFixture("conflict");
    const current = readDocuments(repo, config);
    const next = current.map((document) => ({
      ...document,
      text:
        document.path === config.designDocument
          ? `${document.text}\n## Design principles\n\n- Cycle accent.\n\n## UX principles\n\n- Cycle words.\n`
          : document.text,
    }));
    let advanced = false;
    const result = await releaseDocuments({
      repoDir: repo,
      harnessDir: join(repo, ".devboard"),
      cycleId: "cycle-3",
      summary: "Document the cycle accent",
      config,
      documents: next,
      environment: { PATH: process.env.PATH },
      activity: () => undefined,
      now: () => new Date(),
      run: hookRun(repo, bare, (argv) => {
        if (advanced) return;
        if (argv.includes("commit") && argv.some((value) => value.startsWith("docs(design):"))) {
          advanced = true;
          const temporary = join(repo, ".worktree", "concurrent");
          run("git", ["worktree", "add", "-q", "--detach", temporary, "main"], repo);
          advanceOrigin(
            bare,
            temporary,
            config.designDocument,
            `${readFileSync(join(temporary, config.designDocument), "utf8")}conflict main\n`,
          );
          run("git", ["worktree", "remove", "--force", temporary], repo);
        }
      }),
      waitForWorkflow: async () => ({ ok: true }),
      publish: async () => ({ ok: true }),
    });
    expect(result.ok ? "" : result.detail).toBe("");
    if (!result.ok) return;
    const prose = run("git", ["--git-dir", bare, "show", "main:DESIGN.md"]);
    expect(prose).toContain("Cycle accent");
  });

  test("a failed workflow keeps the pushed commit and reports the failing step", async () => {
    const { repo, bare, config } = await releaseFixture("workflow-failure");
    const current = readDocuments(repo, config);
    const next = current.map((document) => ({
      ...document,
      text:
        document.path === config.designDocument
          ? `${document.text}\n## Design principles\n\n- One.\n\n## UX principles\n\n- Two.\n`
          : document.text,
    }));
    let published = 0;
    const result = await releaseDocuments({
      repoDir: repo,
      harnessDir: join(repo, ".devboard"),
      cycleId: "cycle-4",
      summary: "Document a standard",
      config,
      documents: next,
      environment: { PATH: process.env.PATH },
      activity: () => undefined,
      now: () => new Date(),
      waitForWorkflow: async () => ({ ok: false, detail: "the release workflow concluded failure" }),
      publish: async () => {
        published += 1;
        return { ok: true };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("concluded failure");
    expect(published).toBe(0);
    expect(run("git", ["--git-dir", bare, "log", "-1", "--format=%s", "main"])).toContain("docs(design):");
  });

  test("a failed publish keeps the pushed commit and reports it", async () => {
    const { repo, bare, config } = await releaseFixture("publish-failure");
    const current = readDocuments(repo, config);
    const next = current.map((document) => ({
      ...document,
      text:
        document.path === config.designDocument
          ? `${document.text}\n## Design principles\n\n- One.\n\n## UX principles\n\n- Two.\n`
          : document.text,
    }));
    const result = await releaseDocuments({
      repoDir: repo,
      harnessDir: join(repo, ".devboard"),
      cycleId: "cycle-5",
      summary: "Document a standard",
      config,
      documents: next,
      environment: { PATH: process.env.PATH },
      activity: () => undefined,
      now: () => new Date(),
      waitForWorkflow: async () => ({ ok: true }),
      publish: async () => ({ ok: false, detail: "bun run publish exited 1" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("bun run publish exited 1");
    expect(run("git", ["--git-dir", bare, "log", "-1", "--format=%s", "main"])).toContain("docs(design):");
  });

  test("a dirty integration checkout names its blocking paths and discards nothing", async () => {
    const { repo, bare, config } = await releaseFixture("dirty");
    const current = readDocuments(repo, config);
    const next = current.map((document) => ({
      ...document,
      text:
        document.path === config.designDocument
          ? `${document.text}\n## Design principles\n\n- One.\n\n## UX principles\n\n- Two.\n`
          : document.text,
    }));
    let advanced = false;
    const result = await releaseDocuments({
      repoDir: repo,
      harnessDir: join(repo, ".devboard"),
      cycleId: "cycle-6",
      summary: "Document a standard",
      config,
      documents: next,
      environment: { PATH: process.env.PATH },
      activity: () => undefined,
      now: () => new Date(),
      run: hookRun(repo, bare, (argv) => {
        if (advanced) return;
        if (argv.includes("push") && argv.includes("HEAD:main")) {
          advanced = true;
          // The integration checkout keeps an uncommitted edit to DESIGN.md
          // while origin/main advances with the same path.
          writeFileSync(join(repo, config.designDocument), "local uncommitted\n");
        }
      }),
      waitForWorkflow: async () => ({ ok: true }),
      publish: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("DESIGN.md");
    expect(readFileSync(join(repo, config.designDocument), "utf8")).toBe("local uncommitted\n");
  });

  test("a worktree that cannot be created fails the documentation step and leaves nothing behind", async () => {
    const { repo, bare, config } = await releaseFixture("worktree-failure");
    const next = readDocuments(repo, config);
    const directory = join(repo, ".worktree", "design-cycle-7");
    const real = hookRun(repo, bare, () => undefined);
    const result = await releaseDocuments({
      repoDir: repo,
      harnessDir: join(repo, ".devboard"),
      cycleId: "cycle-7",
      summary: "Document a standard",
      config,
      documents: next,
      environment: { PATH: process.env.PATH },
      activity: () => undefined,
      now: () => new Date(),
      run: async (argv, options) => {
        if (argv.includes("worktree") && argv.includes("add")) {
          mkdirSync(directory, { recursive: true });
          return { code: 128, stdout: "", stderr: "fatal: could not create work tree dir" };
        }
        return real(argv, options);
      },
      waitForWorkflow: async () => ({ ok: true }),
      publish: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("documentation");
      expect(result.detail).toContain("could not create the cycle worktree");
    }
    expect(existsSync(directory)).toBe(false);
  });
});

describe("design forge releases", () => {
  test("lists every release when the server caps one response at 50", async () => {
    const calls: string[] = [];
    const giteaFetch = async (input: string): Promise<Response> => {
      const url = new URL(input);
      calls.push(`${url.pathname}${url.search}`);
      const page = Number(url.searchParams.get("page") ?? "1");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      if (page === 1) {
        return Response.json(
          Array.from({ length: limit }, (_, index) => ({
            tag_name: `v0.2.${index}`,
            published_at: "2026-10-20T00:00:00Z",
          })),
        );
      }
      if (page === 2) {
        return Response.json(
          Array.from({ length: 10 }, (_, index) => ({
            tag_name: `v0.1.${index}`,
            published_at: "2026-09-01T00:00:00Z",
          })),
        );
      }
      return Response.json([]);
    };
    const client = createDesignForge({
      forge: "gitea",
      repository: "acme/fixture",
      repoDir: harnessRoot,
      baseUrl: "http://gitea.test",
      environment: {},
      giteaFetch,
    });

    const releases = await client.listReleases();

    expect(releases).toHaveLength(60);
    expect(releases.map((release) => release.tag)).toEqual([
      ...Array.from({ length: 50 }, (_, index) => `v0.2.${index}`),
      ...Array.from({ length: 10 }, (_, index) => `v0.1.${index}`),
    ]);
    expect(releases.at(-1)).toEqual({
      tag: "v0.1.9",
      publishedAt: "2026-09-01T00:00:00Z",
    });
    expect(
      calls.map((call) => new URL(call, "http://gitea.test").searchParams.get("page")),
    ).toEqual(["1", "2", "3"]);
    expect(calls.every((call) => call.includes("limit=50"))).toBe(true);
  });
});

describe("design periodic read retries", () => {
  test("a transient forge read failure is retried without a sync error and keeps the rows", async () => {
    const { repo, stateDir } = await fixture("read-retry");
    const harness = designForge();
    harness.issues.push(forgeIssue(1));
    const clock = { now: new Date("2026-01-10T12:00:00.000Z") };
    const worker = retryWorker({ repo, stateDir, github: harness.client, clock });
    expect(worker.start("acme/fixture")).toBe(true);
    try {
      await worker.refresh();
      const previousAt = worker.currentState.sync.at!;
      expect(worker.currentState.issues.map((row) => row.number)).toEqual([1]);
      const reads = harness.reads;
      harness.failures.push("gh: HTTP 503: Service Unavailable");
      await worker.refresh();
      const retrying = worker.currentState;
      expect(retrying.sync).toEqual({ state: "stale", at: previousAt, error: null });
      expect(retrying.issues.map((row) => row.number)).toEqual([1]);
      expect(retrying.lastError).toBeNull();

      clock.now = new Date(Date.parse(previousAt) + 999);
      await worker.tickNow();
      expect(harness.reads).toBe(reads + 1);

      harness.issues.push(forgeIssue(2));
      clock.now = new Date(Date.parse(previousAt) + 1_000);
      await worker.tickNow();
      expect(harness.reads).toBe(reads + 2);
      expect(worker.currentState.sync.state).toBe("ok");
      expect(worker.currentState.sync.error).toBeNull();
      expect(worker.currentState.issues.map((row) => row.number)).toEqual([2, 1]);
    } finally {
      await worker.stop();
    }
  });

  test("a transient read gets four retries and only the fifth failure is an error", async () => {
    const { repo, stateDir } = await fixture("read-schedule");
    const harness = designForge();
    harness.issues.push(forgeIssue(1));
    const clock = { now: new Date("2026-01-10T12:00:00.000Z") };
    const worker = retryWorker({ repo, stateDir, github: harness.client, clock });
    expect(worker.start("acme/fixture")).toBe(true);
    try {
      await worker.refresh();
      const previousAt = worker.currentState.sync.at!;
      const reads = harness.reads;
      harness.failAll = "gh: HTTP 503: Service Unavailable";
      await worker.refresh();
      expect(worker.currentState.sync).toEqual({
        state: "stale",
        at: previousAt,
        error: null,
      });

      let now = Date.parse(previousAt);
      let attempts = reads + 1;
      for (const delay of [1_000, 2_000, 4_000, 8_000]) {
        clock.now = new Date(now + delay - 1);
        await worker.tickNow();
        expect(harness.reads).toBe(attempts);
        expect(worker.currentState.sync.state).toBe("stale");
        expect(worker.currentState.sync.error).toBeNull();

        clock.now = new Date(now + delay);
        await worker.tickNow();
        now += delay;
        attempts += 1;
        expect(harness.reads).toBe(attempts);
        if (delay !== 8_000) {
          expect(worker.currentState.sync).toEqual({
            state: "stale",
            at: previousAt,
            error: null,
          });
        }
      }
      expect(attempts).toBe(reads + 5);
      expect(worker.currentState.sync.state).toBe("error");
      expect(worker.currentState.sync.error).toContain("Service Unavailable");
      expect(worker.currentState.lastError).toContain("Service Unavailable");
      expect(worker.currentState.issues.map((row) => row.number)).toEqual([1]);

      clock.now = new Date(now + 1_000);
      await worker.tickNow();
      expect(harness.reads).toBe(attempts);
      expect(worker.currentState.sync.state).toBe("error");
      clock.now = new Date(now + 60_000);
      await worker.tickNow();
      expect(harness.reads).toBe(attempts + 1);
      expect(worker.currentState.sync.state).toBe("error");
    } finally {
      await worker.stop();
    }
  });

  test("a success during the retry schedule clears everything", async () => {
    const { repo, stateDir } = await fixture("read-retry-success");
    const harness = designForge();
    harness.issues.push(forgeIssue(1));
    harness.failures.push("gh: HTTP 502: Bad Gateway", "gh: HTTP 502: Bad Gateway");
    const clock = { now: new Date("2026-01-10T12:00:00.000Z") };
    const worker = retryWorker({ repo, stateDir, github: harness.client, clock });
    expect(worker.start("acme/fixture")).toBe(true);
    try {
      const start = clock.now.getTime();
      await worker.tickNow();
      expect(harness.reads).toBe(1);
      expect(worker.currentState.sync.state).toBe("stale");
      expect(worker.currentState.sync.error).toBeNull();
      clock.now = new Date(start + 1_000);
      await worker.tickNow();
      expect(harness.reads).toBe(2);
      expect(worker.currentState.sync.state).toBe("stale");
      expect(worker.currentState.sync.error).toBeNull();
      clock.now = new Date(start + 3_000);
      await worker.tickNow();
      expect(harness.reads).toBe(3);
      expect(worker.currentState.sync.state).toBe("ok");
      expect(worker.currentState.sync.error).toBeNull();
      expect(worker.currentState.issues.map((row) => row.number)).toEqual([1]);
    } finally {
      await worker.stop();
    }
  });

  for (const [label, message] of [
    ["credentials", "gh: HTTP 401: Bad credentials"],
    ["a missing repository", "gh: HTTP 404: Not Found"],
    ["a malformed answer", "gh issue list did not print a JSON array"],
    ["missing configuration", "the design agent needs DEVBOARD_GITEA_URL for a Gitea origin"],
  ] as const) {
    test(`a permanent read failure (${label}) is attempted once and surfaces at once`, async () => {
      const { repo, stateDir } = await fixture(`read-permanent-${label.replaceAll(" ", "-")}`);
      const harness = designForge();
      harness.issues.push(forgeIssue(1));
      const clock = { now: new Date("2026-01-10T12:00:00.000Z") };
      const worker = retryWorker({ repo, stateDir, github: harness.client, clock });
      expect(worker.start("acme/fixture")).toBe(true);
      try {
        await worker.refresh();
        const previousAt = worker.currentState.sync.at!;
        const reads = harness.reads;
        harness.failAll = message;
        await worker.refresh();
        expect(worker.currentState.sync).toEqual({
          state: "error",
          at: previousAt,
          error: message,
        });
        expect(worker.currentState.lastError).toBe(message);
        expect(harness.reads).toBe(reads + 1);
        clock.now = new Date(Date.parse(previousAt) + 1_000);
        await worker.tickNow();
        expect(harness.reads).toBe(reads + 1);
      } finally {
        await worker.stop();
      }
    });
  }

  test("a rate-limited read surfaces once, raises no error, and waits a cadence", async () => {
    const { repo, stateDir } = await fixture("read-rate-limited");
    const harness = designForge();
    harness.issues.push(forgeIssue(1));
    harness.failAll = "You have exceeded a secondary rate limit.";
    const clock = { now: new Date("2026-01-10T12:00:00.000Z") };
    const worker = retryWorker({ repo, stateDir, github: harness.client, clock });
    expect(worker.start("acme/fixture")).toBe(true);
    try {
      const start = clock.now.getTime();
      await worker.tickNow();
      expect(worker.currentState.sync.state).toBe("error");
      expect(worker.currentState.sync.error).toContain("secondary rate limit");
      expect(worker.currentState.lastError).toBeNull();
      expect(harness.reads).toBe(1);

      clock.now = new Date(start + 1_000);
      await worker.tickNow();
      expect(harness.reads).toBe(1);
      expect(worker.currentState.sync.state).toBe("error");

      harness.failAll = null;
      clock.now = new Date(start + 60_000);
      await worker.tickNow();
      expect(harness.reads).toBe(2);
      expect(worker.currentState.sync.state).toBe("ok");
    } finally {
      await worker.stop();
    }
  });

  test("a stale read starts no cycle and the first success resumes one", async () => {
    const { repo, stateDir } = await fixture("read-cycle-gate");
    const harness = designForge();
    harness.issues.push(forgeIssue(1));
    harness.failAll = "gh: HTTP 503: Service Unavailable";
    const clock = { now: new Date("2026-01-10T12:00:00.000Z") };
    const connects = { connects: 0 };
    const worker = retryWorker({
      repo,
      stateDir,
      github: harness.client,
      clock,
      manualCycles: false,
      connects,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    try {
      const start = clock.now.getTime();
      await worker.tickNow();
      expect(worker.currentState.sync.state).toBe("stale");
      expect(worker.currentState.sync.error).toBeNull();
      expect(connects.connects).toBe(0);
      expect(worker.currentState.newestCycleId).toBeNull();

      harness.failAll = null;
      clock.now = new Date(start + 1_000);
      await worker.tickNow();
      expect(worker.currentState.sync.state).toBe("ok");
      expect(connects.connects).toBe(1);
    } finally {
      await worker.stop();
    }
  });
});
