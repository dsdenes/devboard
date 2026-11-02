import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAuditInput, routeInventory } from "../issues/api-standards/audit";
import {
  createApiStandardsForge,
  type ApiStandardsForgeClient,
  type ApiStandardsForgeIssue,
} from "../issues/api-standards/forge";
import {
  apiStandardsConfig,
  cycleDirectory,
  cyclesDirectory,
  lockPath,
  settingsPath,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
  workDirectory,
} from "../issues/api-standards/paths";
import { writeCommand } from "../issues/api-standards/control";
import {
  parseRules,
  readRestSkill,
  ApiStandardsInputError,
} from "../issues/api-standards/rules";
import { validateFinding, type Finding } from "../issues/api-standards/scan";
import {
  capacityFor,
  emptyState,
  readState,
  writeSettings,
  writeState,
  type ApiStandardsIssueRow,
} from "../issues/api-standards/state";
import {
  ApiStandardsWorker,
  normalizeTitle,
  type ApiStandardsWorkerOptions,
} from "../issues/api-standards/worker";
import { ApiStandardsBridge } from "../server/api-standards";
import { preflightApiStandards } from "../issues/api-standards/preflight";
import {
  DEFAULT_AGENT_DESCRIPTORS,
  agentRegistry,
  projectAgentSnapshot,
  type AgentDescriptor,
} from "../server/agents/registry";
import { readHarnessVersion } from "../server/version";
import { callTool } from "../mcp/tools";
import { backgroundAgentsList } from "../mcp/agents";
import type { McpContext } from "../mcp/context";
import type { ForgeIssueDocument, ForgeIssueSummary, ForgeIssues } from "../lib/forge-issues";
import { readActivity } from "../issues/state";

const harnessRoot = join(import.meta.dir, "..");
const workerVersion = readHarnessVersion(harnessRoot) ?? "test";
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

const SKILL = [
  "# RESTful API Implementation",
  "",
  "Audit the HTTP API against this skill's rule table.",
  "",
].join("\n");

const RULES = [
  "# Zalando RESTful API Guidelines — REST rule set",
  "",
  "## URLs",
  "",
  "| Rule | Level | Directive |",
  "| --- | --- | --- |",
  "| 134 | MUST | Use plural resource names for collections. |",
  "| 129 | SHOULD | Write path segments in lower-case kebab-case. |",
  "",
  "## HTTP requests",
  "",
  "| Rule | Level | Directive |",
  "| --- | --- | --- |",
  "| 148 | MUST | Use HTTP methods according to RFC 9110. |",
  "| 149 | MUST | Preserve the safety and idempotency of each method. |",
  "| 100 | MAY | Offer an optional OpenAPI document. |",
  "",
].join("\n");

const SERVER_SOURCE = [
  "export function handle(request: Request, url: URL): Response {",
  '  if (url.pathname === "/api/feedback") {',
  '    if (request.method === "POST") return Response.json({ ok: true }, { status: 202 });',
  '    return new Response("Method Not Allowed", { status: 405 });',
  "  }",
  '  if (url.pathname === "/api/ready") {',
  "    return Response.json({ pid: 1 });",
  "  }",
  '  if (url.pathname === "/api/goal-proposals") {',
  '    if (request.method === "POST") return Response.json({ slug: "one" }, { status: 201 });',
  '    return new Response("Method Not Allowed", { status: 405 });',
  "  }",
  '  if (url.pathname === "/ws") {',
  '    if (request.method === "GET") return new Response(null, { status: 426 });',
  '    return new Response("Bad Request", { status: 400 });',
  "  }",
  '  return new Response(Bun.file("dist/index.html"));',
  "}",
  "",
].join("\n");

async function fixture(name: string): Promise<{
  root: string;
  repo: string;
  bare: string;
  stateDir: string;
}> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", `api-standards-${name}-`));
  roots.push(root);
  const repo = join(root, "repo");
  const bare = join(root, "origin.git");
  await mkdir(join(repo, ".devboard", "server"), { recursive: true });
  await mkdir(join(repo, ".devboard", "prompts"), { recursive: true });
  await mkdir(join(repo, ".devboard", ".tmp"), { recursive: true });
  await mkdir(join(repo, ".omp", "skills", "restful-api-implementation", "references"), {
    recursive: true,
  });
  await writeFile(join(repo, ".devboard", "server", "app.ts"), SERVER_SOURCE);
  await writeFile(join(repo, ".devboard", "server", "app.test.ts"), "export {};\n");
  await writeFile(join(repo, ".devboard", ".gitignore"), ".tmp/\n");
  await writeFile(
    join(repo, ".omp", "skills", "restful-api-implementation", "SKILL.md"),
    SKILL,
  );
  await writeFile(
    join(repo, ".omp", "skills", "restful-api-implementation", "references", "zalando-rest-rules.md"),
    RULES,
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
  return { root, repo, bare, stateDir };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "POST /api/ready ignores the method",
    ruleId: "148",
    level: "MUST",
    chapter: "HTTP requests",
    directive: "Use HTTP methods according to RFC 9110.",
    endpoints: [{ method: "POST", path: "/api/ready" }],
    evidence: [
      {
        path: ".devboard/server/app.ts",
        lines: "6-7",
        quote: 'if (url.pathname === "/api/ready") {\n    return Response.json({ pid: 1 });',
      },
    ],
    proposedChange: "Answer a non-GET request to /api/ready with 405 and an Allow header.",
    acceptanceCriteria: [
      "POST /api/ready answers 405.",
      "/api/ready answers GET with the pid document.",
    ],
    ...overrides,
  };
}

function findingBody(entry: Finding): string {
  return [
    "## Chapter",
    "",
    entry.chapter,
    "",
    "## Rule",
    "",
    `**${entry.ruleId} — ${entry.level}**`,
    "",
    "## Directive",
    "",
    `> ${entry.directive}`,
    "",
    "## Skill",
    "",
    "`.omp/skills/restful-api-implementation/SKILL.md`",
    "",
    "## Evidence",
    "",
    ...entry.evidence.map(
      (evidence) => `- \`${evidence.path}:${evidence.lines}\`\n  > ${evidence.quote}`,
    ),
    "",
    "## Endpoints",
    "",
    ...entry.endpoints.map((endpoint) => `- \`${endpoint.method} ${endpoint.path}\``),
    "",
    "## Proposed change",
    "",
    entry.proposedChange,
    "",
    "## Acceptance criteria",
    "",
    ...entry.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
  ].join("\n");
}

interface FakeApiForge extends ForgeIssues {
  issues: ForgeIssueDocument[];
  labels: Set<string>;
}

function fakeForge(firstNumber = 1): FakeApiForge {
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

interface ForgeHarness {
  client: ApiStandardsForgeClient;
  issues: ApiStandardsForgeIssue[];
  failAll: string | null;
}

function forgeHarness(): ForgeHarness {
  const harness: ForgeHarness = {
    issues: [],
    failAll: null,
    client: undefined as unknown as ApiStandardsForgeClient,
  };
  harness.client = {
    async listIssues() {
      if (harness.failAll !== null) throw new Error(harness.failAll);
      return harness.issues.map((issue) => ({ ...issue }));
    },
    async listOpenIssueTitles() {
      if (harness.failAll !== null) throw new Error(harness.failAll);
      return harness.issues.filter((issue) => issue.state === "open").map((issue) => issue.title);
    },
  };
  return harness;
}

function toolContext(
  repo: string,
  stateDir: string,
  cycleDir: string,
  forge: FakeApiForge,
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
  forge: FakeApiForge,
  entry: Finding = finding(),
): Promise<void> {
  const result = await callTool(toolContext(repo, stateDir, cycleDir, forge), "issue_create", {
    title: entry.title,
    body: findingBody(entry),
    labels: ["api-standards"],
  });
  if (result.error !== undefined) throw new Error(result.error);
}

interface PeerCounter {
  connects: number;
}

function fakePeer(
  write: (directory: string) => void | Promise<void>,
  counter: PeerCounter,
): NonNullable<ApiStandardsWorkerOptions["connect"]> {
  return () =>
    ({
      pid: undefined,
      argv: [],
      async run(prompt: string) {
        counter.connects += 1;
        await write(prompt.slice("/api-standards-audit ".length));
        return {};
      },
      async prompt() {
        return {};
      },
      answer: () => true,
      close: () => undefined,
    }) as never;
}

function decisions(
  cycleDir: string,
  entries: Array<Finding & { decision: "filed" | "skipped"; reason?: string }>,
): void {
  writeFileSync(
    join(cycleDir, "findings.json"),
    `${JSON.stringify({ version: 1, findings: entries }, null, 2)}\n`,
  );
}

describe("api-standards registry", () => {
  test("the fifth audit descriptor sits between Coach and the Release Train", () => {
    expect(DEFAULT_AGENT_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual([
      "scout",
      "watchdog",
      "design",
      "coach",
      "api-standards",
      "release-train",
    ]);
    const descriptor = agentRegistry.require("api-standards");
    expect(descriptor.label).toBe("API Standards");
    expect(descriptor.description).toContain("REST");
    expect(descriptor.scope).toBe("repository");
    expect(descriptor.prompt).toEqual({ kind: "file", file: "api-standards.md" });
    expect(descriptor.cadence).toEqual({
      field: "intervalMinutes",
      defaultMinutes: 60,
      minMinutes: 1,
      maxMinutes: 1440,
    });
    expect(descriptor.limits.default).toEqual({ maxPerHour: 10, maxPending: 5 });
    expect(descriptor.detail).toEqual({ panel: "activity", testId: "agent-detail" });
    expect(descriptor.tab).toEqual({
      id: "api-standards",
      kind: "api-standards",
      title: "API Standards",
    });
    expect(descriptor.timerGate).toBeUndefined();
    expect(descriptor.documentation).toBeUndefined();
    expect(descriptor.issues.testId).toBe("agent-issue");
    expect(descriptor.commands.start).toBe("startAgent");
  });

  test("a synthetic extra descriptor validates and projects", () => {
    const synthetic: AgentDescriptor = {
      ...agentRegistry.require("api-standards"),
      id: "linter",
      label: "Linter",
      description: "A sixth continuous background agent.",
      tab: { id: "linter", kind: "linter", title: "Linter" },
    };
    const snapshot = projectAgentSnapshot(synthetic, {
      lifecycle: "stopped",
      enabled: false,
      owned: false,
      attached: false,
      cadence: { minutes: 60, lastRunAt: null, nextRunAt: null },
      limits: { maxPerHour: 10, maxPending: 5 },
      issues: [],
      pending: 0,
      sync: { state: "stale", at: null, error: null },
      detail: { panel: "activity", scanId: null, entries: [] },
      notice: null,
      error: null,
      timer: null,
    });
    expect(snapshot.id).toBe("linter");
    expect(synthetic.tab.kind).toBe("linter");
    expect(snapshot.label).toBe("Linter");
  });

  test("the prompt file the descriptor names is the shipped prompt", () => {
    const prompt = readFileSync(join(harnessRoot, "prompts", "api-standards.md"), "utf8");
    for (const concept of [
      "api-standards",
      "issue_create",
      "findings.json",
      ".omp/skills/restful-api-implementation/SKILL.md",
      "zalando-rest-rules.md",
      "MUST",
      "SHOULD",
      "MAY",
      "duplicate",
      "issueRoom",
      "never edit the checkout",
      "no network request",
    ]) {
      expect(prompt).toContain(concept);
    }
  });
});

describe("REST skill", () => {
  test("reads both files and every row's id, level, chapter, and directive", async () => {
    const { repo } = await fixture("rules");
    const skill = readRestSkill(repo, apiStandardsConfig());
    expect(skill.skillPath).toBe(".omp/skills/restful-api-implementation/SKILL.md");
    expect(skill.rulesPath).toBe(
      ".omp/skills/restful-api-implementation/references/zalando-rest-rules.md",
    );
    expect(skill.chapters).toEqual(["URLs", "HTTP requests"]);
    expect(skill.rules).toEqual([
      {
        id: "134",
        level: "MUST",
        chapter: "URLs",
        directive: "Use plural resource names for collections.",
      },
      {
        id: "129",
        level: "SHOULD",
        chapter: "URLs",
        directive: "Write path segments in lower-case kebab-case.",
      },
      {
        id: "148",
        level: "MUST",
        chapter: "HTTP requests",
        directive: "Use HTTP methods according to RFC 9110.",
      },
      {
        id: "149",
        level: "MUST",
        chapter: "HTTP requests",
        directive: "Preserve the safety and idempotency of each method.",
      },
      {
        id: "100",
        level: "MAY",
        chapter: "HTTP requests",
        directive: "Offer an optional OpenAPI document.",
      },
    ]);
  });

  test("a header-only table is an input error, not an empty rule set", () => {
    expect(() => parseRules("## URLs\n\n| Rule | Level | Directive |\n| --- | --- | --- |\n", "x"))
      .toThrow(ApiStandardsInputError);
    expect(() => parseRules("## URLs\n\n| 134 | MUST | Plural names. |\n", "x")).not.toThrow();
  });

  test("a missing skill file or reference names the absent path", async () => {
    const { repo } = await fixture("missing-skill");
    rmSync(join(repo, ".omp", "skills", "restful-api-implementation", "SKILL.md"));
    expect(() => readRestSkill(repo, apiStandardsConfig())).toThrow(/SKILL\.md is not readable/);
    const other = await fixture("missing-rules");
    rmSync(
      join(other.repo, ".omp", "skills", "restful-api-implementation", "references", "zalando-rest-rules.md"),
    );
    expect(() => readRestSkill(other.repo, apiStandardsConfig())).toThrow(
      /zalando-rest-rules\.md is not readable/,
    );
  });
});

describe("api-standards surface", () => {
  test("inventories every route the server source answers", async () => {
    const { repo } = await fixture("routes");
    const input = readAuditInput(repo, apiStandardsConfig());
    expect(input.sources.map((file) => file.path)).toContain(".devboard/server/app.ts");
    expect(input.sources.map((file) => file.path)).not.toContain(
      ".devboard/server/app.test.ts",
    );
    expect(input.routes).toEqual([
      { path: "*", methods: ["GET", "HEAD"], kind: "static-fallback", source: ".devboard/server/app.ts", line: 1 },
      { path: "/api/feedback", methods: ["POST"], kind: "endpoint", source: ".devboard/server/app.ts", line: 2 },
      {
        path: "/api/goal-proposals",
        methods: ["POST"],
        kind: "endpoint",
        source: ".devboard/server/app.ts",
        line: 9,
      },
      { path: "/api/ready", methods: [], kind: "endpoint", source: ".devboard/server/app.ts", line: 6 },
      { path: "/ws", methods: ["GET"], kind: "upgrade", source: ".devboard/server/app.ts", line: 13 },
    ]);
    expect(input.skill.rules).toHaveLength(5);
  });

  test("a route added to the source directory appears with no engine change", async () => {
    const { repo } = await fixture("added-route");
    const before = readAuditInput(repo, apiStandardsConfig()).routes.length;
    writeFileSync(
      join(repo, ".devboard", "server", "health.ts"),
      [
        "export function health(request: Request, url: URL): Response | undefined {",
        '  if (url.pathname === "/api/health") {',
        '    if (request.method === "GET") return Response.json({ ok: true });',
        "    return new Response(null, { status: 405 });",
        "  }",
        "  return undefined;",
        "}",
        "",
      ].join("\n"),
    );
    const input = readAuditInput(repo, apiStandardsConfig());
    expect(input.routes.length).toBe(before + 1);
    expect(input.routes.some((route) => route.path === "/api/health")).toBe(true);
    expect(input.sources.map((file) => file.path)).toContain(".devboard/server/health.ts");
  });

  test("a missing or installed-prefix API source directory is refused", async () => {
    const { repo } = await fixture("installed-prefix");
    rmSync(join(repo, ".devboard", "server"), { recursive: true, force: true });
    mkdirSync(join(repo, ".devboard", "node_modules", "@dsdenes", "devboard"), { recursive: true });
    expect(() => readAuditInput(repo, apiStandardsConfig())).toThrow(/installed npm prefix/);
  });

  test("an empty source directory refuses instead of auditing nothing", async () => {
    const { repo } = await fixture("empty-source");
    rmSync(join(repo, ".devboard", "server", "app.ts"));
    rmSync(join(repo, ".devboard", "server", "app.test.ts"));
    expect(() => readAuditInput(repo, apiStandardsConfig())).toThrow(/empty surface/);
  });

  test("the route inventory ignores comments and unrelated strings", () => {
    const routes = routeInventory([
      {
        path: "x.ts",
        lines: 3,
        text: [
          '// url.pathname === "/api/commented"',
          'const other = "/api/not-a-route";',
          'if (url.pathname === "/api/real") return Response.json({});',
        ].join("\n"),
      },
    ]);
    expect(routes.map((route) => route.path)).toEqual(["/api/real"]);
  });
});

describe("api-standards admissibility", () => {
  const skill = parseRules(RULES, "rules.md");
  const sources = new Map([[".devboard/server/app.ts", SERVER_SOURCE]]);
  const context = { rules: skill.rules, sources };

  test("a MUST finding with exact evidence is admissible", () => {
    expect(validateFinding(finding(), context)).toEqual({
      ok: true,
      rule: expect.objectContaining({ id: "148", level: "MUST" }),
    });
  });

  test("a SHOULD finding is admissible", () => {
    const entry = finding({
      title: "Path segment uses camelCase",
      ruleId: "129",
      level: "SHOULD",
      chapter: "URLs",
      directive: "Write path segments in lower-case kebab-case.",
    });
    expect(validateFinding(entry, context).ok).toBe(true);
  });

  test("a MAY-level deviation is never filed", () => {
    const entry = finding({
      ruleId: "100",
      level: "MAY",
      chapter: "HTTP requests",
      directive: "Offer an optional OpenAPI document.",
    });
    expect(validateFinding(entry, context)).toEqual({
      ok: false,
      reason: "may-level",
      detail: expect.stringContaining("100"),
    });
  });

  test("an invented rule id, level, chapter, or directive is dropped", () => {
    expect(validateFinding(finding({ ruleId: "9999" }), context)).toEqual({
      ok: false,
      reason: "missing-citation",
      detail: expect.stringContaining("9999"),
    });
    expect(validateFinding(finding({ level: "SHOULD" }), context).ok).toBe(false);
    expect(validateFinding(finding({ chapter: "Pagination" }), context).ok).toBe(false);
    expect(validateFinding(finding({ directive: "Use methods." }), context).ok).toBe(false);
  });

  test("a finding without an endpoint or with inexact evidence is dropped", () => {
    expect(validateFinding(finding({ endpoints: [] }), context).ok).toBe(false);
    const wrongQuote = finding({
      evidence: [{ path: ".devboard/server/app.ts", lines: "1", quote: "not in the file" }],
    });
    expect(validateFinding(wrongQuote, context)).toEqual({
      ok: false,
      reason: "missing-evidence",
      detail: expect.stringContaining("not copied"),
    });
    const outsideSpan = finding({
      evidence: [
        { path: ".devboard/server/app.ts", lines: "1", quote: "if (url.pathname" },
      ],
    });
    expect(validateFinding(outsideSpan, context).ok).toBe(false);
    const unknownFile = finding({
      evidence: [{ path: ".devboard/server/nope.ts", lines: "1", quote: "x" }],
    });
    expect(validateFinding(unknownFile, context).ok).toBe(false);
  });

  test("a title longer than 200 characters is dropped", () => {
    expect(validateFinding(finding({ title: "a".repeat(201) }), context).ok).toBe(false);
    expect(validateFinding(finding({ title: "  " }), context).ok).toBe(false);
  });

  test("dedupe normalizes case, whitespace runs, and edges", () => {
    expect(normalizeTitle("  POST   /api/ready ignores  ")).toBe("post /api/ready ignores");
    expect(normalizeTitle("POST /api/ready ignores")).toBe("post /api/ready ignores");
  });
});

describe("api-standards capacity", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  function row(
    number: number,
    createdAt: string,
    state: "pending" | "implemented",
  ): ApiStandardsIssueRow {
    return {
      number,
      title: `issue ${number}`,
      url: `https://forge.test/acme/fixture/issues/${number}`,
      createdAt,
      state,
      category: "URLs",
      version: null,
    };
  }

  test("the hourly cap counts every api-standards issue in the rolling hour", () => {
    const issues = [
      row(1, "2026-01-01T11:30:00.000Z", "implemented"),
      row(2, "2026-01-01T11:45:00.000Z", "pending"),
      row(3, "2026-01-01T09:00:00.000Z", "implemented"),
    ];
    const capacity = capacityFor(issues, { maxPerHour: 3, maxPending: 5 }, now);
    expect(capacity.windowCount).toBe(2);
    expect(capacity.hourlyRoom).toBe(1);
    expect(capacity.batch).toBe(1);
  });

  test("the smaller room wins, zero room is zero, and clearing a cap restores room", () => {
    const issues = [
      row(1, "2026-01-01T11:30:00.000Z", "pending"),
      row(2, "2026-01-01T11:40:00.000Z", "pending"),
    ];
    expect(capacityFor(issues, { maxPerHour: 10, maxPending: 2 }, now).batch).toBe(0);
    expect(capacityFor(issues, { maxPerHour: 2, maxPending: 10 }, now).batch).toBe(0);
    expect(capacityFor(issues, { maxPerHour: null, maxPending: null }, now).batch).toBe(100);
    expect(capacityFor(issues, { maxPerHour: 10, maxPending: null }, now).batch).toBe(8);
  });
});

function worker(
  repo: string,
  stateDir: string,
  forge: ApiStandardsForgeClient,
  connect: NonNullable<ApiStandardsWorkerOptions["connect"]>,
  options: Partial<ApiStandardsWorkerOptions> = {},
): ApiStandardsWorker {
  return new ApiStandardsWorker({
    repoDir: repo,
    stateDir,
    harnessVersion: workerVersion,
    cadenceMs: 60 * 60_000,
    syncMs: 10_000,
    manualCycles: true,
    forge,
    connect,
    ...options,
  });
}

describe("api-standards worker", () => {
  test("a MUST finding is filed with provenance and recorded in activity", async () => {
    const { repo, stateDir } = await fixture("worker-must");
    const toolForge = fakeForge(7);
    const harness = forgeHarness();
    const counter: PeerCounter = { connects: 0 };
    const entry = finding();
    const cycle = worker(
      repo,
      stateDir,
      harness.client,
      fakePeer(async (directory) => {
        await fileFinding(repo, stateDir, directory, toolForge, entry);
        harness.issues.push({
          number: 7,
          title: entry.title,
          url: "https://forge.test/acme/fixture/issues/7",
          state: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
          body: "## Chapter\n\nHTTP requests\n",
        });
        decisions(directory, [{ ...entry, decision: "filed", issueNumber: 7, issueUrl: "https://forge.test/acme/fixture/issues/7" }]);
      }, counter),
    );
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      await cycle.beginCycle();
      await cycle.waitForCycle();
    } finally {
      await cycle.stop();
    }

    expect(counter.connects).toBe(1);
    expect(toolForge.issues).toHaveLength(1);
    const issue = toolForge.issues[0]!;
    expect(issue.labels).toEqual(["api-standards"]);
    expect(issue.title).toBe(entry.title);
    expect(issue.title.length).toBeLessThanOrEqual(200);
    expect(issue.body).toContain("## Chapter\n\nHTTP requests");
    expect(issue.body).toContain("## Rule\n\n**148 — MUST**");
    expect(issue.body).toContain("> Use HTTP methods according to RFC 9110.");
    expect(issue.body).toContain(".omp/skills/restful-api-implementation/SKILL.md");
    expect(issue.body).toContain("`.devboard/server/app.ts:6-7`");
    expect(issue.body).toContain("- `POST /api/ready`");
    expect(issue.body).toContain("## Proposed change");
    expect(issue.body).toContain("## Acceptance criteria");

    const state = readState(versionedStatePath(stateDir, repo, workerVersion));
    expect(state?.issues.map((row) => row.title)).toEqual([entry.title]);
    expect(state?.issues[0]?.category).toBe("HTTP requests");
    expect(state?.sync.state).toBe("ok");
    const lines = readActivity(
      cycleDirectory(repo, state?.newestCycleId ?? ""),
    ).join("\n");
    expect(lines).toContain("route(s)");
    expect(lines).toContain("5 rule(s) from");
    expect(lines).toContain("admissible rule 148 MUST · HTTP requests");
    expect(lines).toContain("filed #7 https://forge.test/acme/fixture/issues/7");
  });

  test("a SHOULD finding is filed and a MAY-level candidate is only recorded", async () => {
    const { repo, stateDir } = await fixture("worker-should-may");
    const toolForge = fakeForge();
    const harness = forgeHarness();
    const counter: PeerCounter = { connects: 0 };
    const should = finding({
      title: "Collection path uses a plural noun",
      ruleId: "129",
      level: "SHOULD",
      chapter: "URLs",
      directive: "Write path segments in lower-case kebab-case.",
      evidence: [
        { path: ".devboard/server/app.ts", lines: "6-7", quote: 'if (url.pathname === "/api/ready")' },
      ],
      endpoints: [{ method: "GET", path: "/api/ready" }],
    });
    const may = finding({
      title: "No OpenAPI document is served",
      ruleId: "100",
      level: "MAY",
      chapter: "HTTP requests",
      directive: "Offer an optional OpenAPI document.",
    });
    const cycle = worker(
      repo,
      stateDir,
      harness.client,
      fakePeer(async (directory) => {
        await fileFinding(repo, stateDir, directory, toolForge, should);
        decisions(directory, [
          { ...should, decision: "filed", issueNumber: 1, issueUrl: "https://forge.test/acme/fixture/issues/1" },
          { ...may, decision: "skipped", reason: "may-level" },
        ]);
      }, counter),
    );
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      await cycle.beginCycle();
      await cycle.waitForCycle();
    } finally {
      await cycle.stop();
    }

    expect(toolForge.issues.map((issue) => issue.title)).toEqual([should.title]);
    const state = readState(versionedStatePath(stateDir, repo, workerVersion));
    const lines = readActivity(cycleDirectory(repo, state?.newestCycleId ?? "")).join("\n");
    expect(lines).toContain("skipped (may-level) rule 100 MAY");
    expect(lines).not.toContain("admissible rule 100");
  });

  test("a duplicate title files nothing and is counted in activity", async () => {
    const { repo, stateDir } = await fixture("worker-duplicate");
    const toolForge = fakeForge();
    const harness = forgeHarness();
    harness.issues.push({
      number: 4,
      title: "post  /api/READY ignores the method",
      url: "https://forge.test/acme/fixture/issues/4",
      state: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      body: "",
    });
    const counter: PeerCounter = { connects: 0 };
    const duplicate = finding({ title: "POST /api/ready ignores the method" });
    let requestRoom: number | undefined;
    const cycle = worker(
      repo,
      stateDir,
      harness.client,
      fakePeer(async (directory) => {
        const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as {
          issueRoom: number;
          knownTitles: string[];
        };
        requestRoom = request.issueRoom;
        expect(request.knownTitles.map(normalizeTitle)).toContain(
          "post /api/ready ignores the method",
        );
        decisions(directory, [{ ...duplicate, decision: "skipped", reason: "duplicate" }]);
      }, counter),
    );
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      await cycle.beginCycle();
      await cycle.waitForCycle();
    } finally {
      await cycle.stop();
    }

    expect(requestRoom).toBe(4);
    expect(toolForge.issues).toEqual([]);
    const state = readState(versionedStatePath(stateDir, repo, workerVersion));
    const lines = readActivity(cycleDirectory(repo, state?.newestCycleId ?? "")).join("\n");
    expect(lines).toContain("skipped (duplicate)");
  });

  test("a full pending cap files nothing; clearing it resumes filing", async () => {
    const { repo, stateDir } = await fixture("worker-cap");
    const toolForge = fakeForge();
    const harness = forgeHarness();
    for (let index = 1; index <= 5; index += 1) {
      harness.issues.push({
        number: index,
        title: `Existing finding ${index}`,
        url: `https://forge.test/acme/fixture/issues/${index}`,
        state: "open",
        createdAt: "2026-01-01T00:00:00.000Z",
        body: "",
      });
    }
    const counter: PeerCounter = { connects: 0 };
    const entry = finding();
    const rooms: number[] = [];
    const connect = fakePeer(async (directory) => {
      const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8")) as {
        issueRoom: number;
      };
      rooms.push(request.issueRoom);
      if (request.issueRoom > 0) {
        await fileFinding(repo, stateDir, directory, toolForge, entry);
        decisions(directory, [
          { ...entry, decision: "filed", issueNumber: 1, issueUrl: "https://forge.test/acme/fixture/issues/1" },
        ]);
        return;
      }
      decisions(directory, [{ ...entry, decision: "skipped", reason: "no-room" }]);
    }, counter);
    const cycle = worker(repo, stateDir, harness.client, connect);
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      await cycle.beginCycle();
      await cycle.waitForCycle();
      expect(rooms).toEqual([0]);
      expect(toolForge.issues).toEqual([]);
      let lines = readActivity(
        cycleDirectory(repo, cycle.currentState.newestCycleId ?? ""),
      ).join("\n");
      expect(lines).toContain("skipped (no-room)");
      expect(lines).toContain("room 0");

      writeCommand(versionedControlDirectory(stateDir, repo, workerVersion), {
        type: "settings",
        intervalMinutes: 60,
        maxPerHour: 10,
        maxPending: null,
      });
      await cycle.tickNow();
      await cycle.beginCycle();
      await cycle.waitForCycle();
      expect(rooms).toEqual([0, 10]);
      expect(toolForge.issues.map((issue) => issue.title)).toEqual([entry.title]);
      lines = readActivity(
        cycleDirectory(repo, cycle.currentState.newestCycleId ?? ""),
      ).join("\n");
      expect(lines).toContain("filed #");
    } finally {
      await cycle.stop();
    }
  });

  test("a filed claim without a tool record is never reported as filed", async () => {
    const { repo, stateDir } = await fixture("worker-claim");
    const harness = forgeHarness();
    const counter: PeerCounter = { connects: 0 };
    const entry = finding();
    const cycle = worker(
      repo,
      stateDir,
      harness.client,
      fakePeer(async (directory) => {
        decisions(directory, [
          { ...entry, decision: "filed", issueNumber: 9, issueUrl: "https://forge.test/issues/9" },
        ]);
      }, counter),
    );
    let lastError: string | null = null;
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      await cycle.beginCycle();
      await cycle.waitForCycle();
      lastError = cycle.currentState.lastError;
    } finally {
      await cycle.stop();
    }
    expect(lastError).toContain("recorded no filing");
    const state = readState(versionedStatePath(stateDir, repo, workerVersion));
    const lines = readActivity(cycleDirectory(repo, state?.newestCycleId ?? "")).join("\n");
    expect(lines).toContain("failed: no issue was created");
    expect(lines).not.toContain("filed #9");
  });

  test("a MAY-only and an outside-HTTP deviation file nothing", async () => {
    const { repo, stateDir } = await fixture("worker-may-only");
    const toolForge = fakeForge();
    const harness = forgeHarness();
    const counter: PeerCounter = { connects: 0 };
    const may = finding({ title: "Optional OpenAPI document", ruleId: "100", level: "MAY", directive: "Offer an optional OpenAPI document." });
    const outside = finding({
      title: "A WebSocket frame carries camelCase",
      ruleId: "134",
      level: "MUST",
      chapter: "URLs",
      directive: "Use plural resource names for collections.",
      endpoints: [],
      evidence: [],
    });
    const cycle = worker(
      repo,
      stateDir,
      harness.client,
      fakePeer(async (directory) => {
        decisions(directory, [
          { ...may, decision: "skipped", reason: "may-level" },
          { ...outside, decision: "skipped", reason: "outside-http" },
        ]);
      }, counter),
    );
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      await cycle.beginCycle();
      await cycle.waitForCycle();
    } finally {
      await cycle.stop();
    }
    expect(toolForge.issues).toEqual([]);
    const state = readState(versionedStatePath(stateDir, repo, workerVersion));
    const lines = readActivity(cycleDirectory(repo, state?.newestCycleId ?? "")).join("\n");
    expect(lines).toContain("skipped (may-level)");
    expect(lines).toContain("skipped (outside-http)");
  });

  test("single flight: two begin attempts start one cycle", async () => {
    const { repo, stateDir } = await fixture("worker-single-flight");
    const harness = forgeHarness();
    const counter: PeerCounter = { connects: 0 };
    const cycle = worker(
      repo,
      stateDir,
      harness.client,
      fakePeer(async (directory) => {
        decisions(directory, []);
      }, counter),
    );
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      const first = cycle.beginCycle();
      const second = cycle.beginCycle();
      await Promise.all([first, second]);
      await cycle.waitForCycle();
      expect(counter.connects).toBe(1);
    } finally {
      await cycle.stop();
    }
  });

  test("a cycle writes nothing in the checkout and leaves git clean", async () => {
    const { repo, stateDir } = await fixture("worker-readonly");
    const harness = forgeHarness();
    const counter: PeerCounter = { connects: 0 };
    const before = run("git", ["status", "--porcelain"], repo);
    const trackedBefore = readFileSync(join(repo, "tracked.txt"), "utf8");
    const cycle = worker(
      repo,
      stateDir,
      harness.client,
      fakePeer(async (directory) => {
        await fileFinding(repo, stateDir, directory, fakeForge(), finding());
        decisions(directory, []);
      }, counter),
    );
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      await cycle.beginCycle();
      await cycle.waitForCycle();
    } finally {
      await cycle.stop();
    }
    expect(run("git", ["status", "--porcelain"], repo)).toBe(before);
    expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe(trackedBefore);
    expect(run("git", ["rev-parse", "HEAD"], repo)).toBeTruthy();
    expect(existsSync(workDirectory(repo))).toBe(true);
    expect(readdirSync(cyclesDirectory(repo)).length).toBeGreaterThan(0);
    const writes = readdirSync(cyclesDirectory(repo)).sort();
    expect(writes.length).toBe(1);
  });

  test("a failed forge read keeps the last known rows and records the failure", async () => {
    const { repo, stateDir } = await fixture("worker-sync-failure");
    const harness = forgeHarness();
    harness.issues.push({
      number: 2,
      title: "Existing finding",
      url: "https://forge.test/acme/fixture/issues/2",
      state: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      body: "",
    });
    const counter: PeerCounter = { connects: 0 };
    const cycle = worker(repo, stateDir, harness.client, fakePeer(async (directory) => {
      decisions(directory, []);
    }, counter));
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      expect(cycle.currentState.issues.map((row) => row.title)).toEqual(["Existing finding"]);
      harness.failAll = "the forge read timed out";
      await cycle.refresh();
      expect(cycle.currentState.sync.state).toBe("stale");
      expect(cycle.currentState.issues.map((row) => row.title)).toEqual(["Existing finding"]);
      harness.failAll = "Bad credentials";
      for (let attempt = 0; attempt < 5; attempt += 1) await cycle.refresh();
      expect(cycle.currentState.sync.state).toBe("error");
      expect(cycle.currentState.sync.error).toContain("Bad credentials");
      expect(cycle.currentState.issues.map((row) => row.title)).toEqual(["Existing finding"]);
    } finally {
      await cycle.stop();
    }
  });

  test("activity survives a reconnect through the bridge replay", async () => {
    const { repo, stateDir } = await fixture("worker-activity");
    const harness = forgeHarness();
    const counter: PeerCounter = { connects: 0 };
    const entry = finding();
    const cycle = worker(
      repo,
      stateDir,
      harness.client,
      fakePeer(async (directory) => {
        await fileFinding(repo, stateDir, directory, fakeForge(3), entry);
        decisions(directory, [
          { ...entry, decision: "filed", issueNumber: 3, issueUrl: "https://forge.test/acme/fixture/issues/3" },
        ]);
      }, counter),
    );
    try {
      expect(cycle.start("acme/fixture")).toBe(true);
      await cycle.refresh();
      await cycle.beginCycle();
      await cycle.waitForCycle();
    } finally {
      await cycle.stop();
    }
    const descriptor = agentRegistry.require("api-standards");
    const bridge = new ApiStandardsBridge({
      descriptor,
      repoDir: repo,
      stateDir,
      agentCommand: "omp acp",
      agentEnvironment: async () => ({}),
      runningVersion: workerVersion,
      harnessDir: join(harnessRoot),
      send: () => undefined,
      environment: {},
    });
    const events: Array<{ type?: string; replay?: boolean; entries?: Array<{ text: string }> }> = [];
    bridge.replay({ send: (data: string) => events.push(JSON.parse(data)) });
    const activity = events.find((event) => event.type === "agentActivity");
    expect(activity?.replay).toBe(true);
    expect(activity?.entries?.some((line) => line.text.includes("filed #3"))).toBe(true);
  });
});

describe("api-standards preflight", () => {
  const origin = { forge: "gitea" as const, host: "forge.test", project: "acme/fixture" };

  function giteaFetch(labels: string[] = ["api-standards"]): {
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
    writes: string[];
  } {
    const names = [...labels];
    const writes: string[] = [];
    return {
      writes,
      fetch: async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        if (init?.method === "POST" && path.endsWith("/labels")) {
          const body = JSON.parse(String(init.body)) as { name: string };
          names.push(body.name);
          writes.push(body.name);
          return Response.json({ id: 9, name: body.name, color: "0e8a16" });
        }
        if (path.endsWith("/labels")) {
          return Response.json(names.map((name, index) => ({ id: index + 1, name, color: "0e8a16" })));
        }
        if (path === "/api/v1/repos/acme/fixture") {
          return Response.json({ permissions: { push: true } });
        }
        return Response.json({ message: "not found" }, { status: 404 });
      },
    };
  }

  test("refuses a missing API source directory and names it", async () => {
    const { repo, stateDir } = await fixture("preflight-server");
    rmSync(join(repo, ".devboard", "server"), { recursive: true, force: true });
    const result = await preflightApiStandards({ repoDir: repo, stateDir, origin });
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining(".devboard/server"),
    });
  });

  test("refuses a missing skill or reference and names the path", async () => {
    const { repo, stateDir } = await fixture("preflight-skill");
    rmSync(join(repo, ".omp", "skills", "restful-api-implementation", "SKILL.md"));
    const missingSkill = await preflightApiStandards({ repoDir: repo, stateDir, origin });
    expect(missingSkill).toEqual({
      ok: false,
      message: expect.stringContaining("SKILL.md is not readable"),
    });

    const other = await fixture("preflight-reference");
    rmSync(
      join(other.repo, ".omp", "skills", "restful-api-implementation", "references", "zalando-rest-rules.md"),
    );
    const missingRules = await preflightApiStandards({
      repoDir: other.repo,
      stateDir: other.stateDir,
      origin,
    });
    expect(missingRules).toEqual({
      ok: false,
      message: expect.stringContaining("zalando-rest-rules.md is not readable"),
    });
  });

  test("refuses a header-only rule table", async () => {
    const { repo, stateDir } = await fixture("preflight-empty-rules");
    writeFileSync(
      join(repo, ".omp", "skills", "restful-api-implementation", "references", "zalando-rest-rules.md"),
      "## URLs\n\n| Rule | Level | Directive |\n| --- | --- | --- |\n",
    );
    const result = await preflightApiStandards({ repoDir: repo, stateDir, origin });
    expect(result).toEqual({ ok: false, message: expect.stringContaining("no rule table") });
  });

  test("refuses an installed npm prefix and an unsupported origin", async () => {
    const { repo, stateDir } = await fixture("preflight-prefix");
    rmSync(join(repo, ".devboard", "server"), { recursive: true, force: true });
    const prefix = await preflightApiStandards({ repoDir: repo, stateDir, origin });
    expect(prefix).toEqual({
      ok: false,
      message: expect.stringContaining("installed npm prefix"),
    });

    const { repo: gitlabRepo, stateDir: gitlabState } = await fixture("preflight-gitlab");
    const gitlab = await preflightApiStandards({
      repoDir: gitlabRepo,
      stateDir: gitlabState,
      origin: { forge: "gitlab", host: "gitlab.test", project: "acme/fixture" },
    });
    expect(gitlab).toEqual({ ok: false, message: expect.stringContaining("GitLab") });
  });

  test("refuses a read-only account and creates a missing label when it can write", async () => {
    const readOnly = await fixture("preflight-readonly");
    const denied = await preflightApiStandards({
      repoDir: readOnly.repo,
      stateDir: readOnly.stateDir,
      origin,
      environment: { DEVBOARD_GITEA_URL: "http://forge.test", GITEA_TOKEN: "t" },
      giteaFetch: async () => Response.json({ permissions: { push: false } }),
    });
    expect(denied).toEqual({ ok: false, message: expect.stringContaining("cannot write") });

    const writable = await fixture("preflight-label");
    const stub = giteaFetch(["design"]);
    const allowed = await preflightApiStandards({
      repoDir: writable.repo,
      stateDir: writable.stateDir,
      origin,
      environment: { DEVBOARD_GITEA_URL: "http://forge.test", GITEA_TOKEN: "t" },
      giteaFetch: stub.fetch,
    });
    expect(allowed).toEqual({ ok: true, repository: "acme/fixture" });
    expect(stub.writes).toEqual(["api-standards"]);
  });

  test("Start refuses before spawning or writing worker state", async () => {
    const { repo, stateDir } = await fixture("preflight-start");
    rmSync(join(repo, ".devboard", "server"), { recursive: true, force: true });
    let spawned = 0;
    const bridge = new ApiStandardsBridge({
      descriptor: agentRegistry.require("api-standards"),
      repoDir: repo,
      stateDir,
      agentCommand: "omp acp",
      agentEnvironment: async () => ({}),
      runningVersion: workerVersion,
      harnessDir: harnessRoot,
      send: () => undefined,
      environment: {},
      spawnWorker: () => {
        spawned += 1;
        return 1;
      },
    });
    const result = await bridge.start();
    expect(result).toEqual({ ok: false, message: expect.stringContaining(".devboard/server") });
    expect(spawned).toBe(0);
    expect(existsSync(statePath(stateDir, repo))).toBe(false);
    expect(existsSync(join(stateDir, "api-standards"))).toBe(false);
    expect(existsSync(lockPath(repo))).toBe(false);
  });
});

describe("api-standards MCP projection", () => {
  test("projects the fifth agent from its persisted state with no dashboard", async () => {
    const { repo, stateDir } = await fixture("mcp-projection");
    writeSettings(settingsPath(stateDir, repo), {
      intervalMinutes: 45,
      maxPerHour: 4,
      maxPending: 2,
    });
    const state = emptyState({ repo: "acme/fixture", root: repo });
    state.lifecycle = "stopped";
    state.enabled = false;
    state.limits = { maxPerHour: 4, maxPending: 2 };
    state.intervalMinutes = 45;
    state.sync = { state: "ok", at: "2026-01-01T12:00:00.000Z", error: null };
    state.issues = [
      {
        number: 3,
        title: "POST /api/ready ignores the method",
        url: "https://forge.test/acme/fixture/issues/3",
        createdAt: "2026-01-01T11:00:00.000Z",
        state: "pending",
        category: "HTTP requests",
        version: null,
      },
    ];
    writeState(versionedStatePath(stateDir, repo, workerVersion), state);
    const context: McpContext = {
      repoDir: repo,
      harnessDir: join(harnessRoot),
      stateDir,
      environment: {},
      dashboards: [],
    };
    const agents = await backgroundAgentsList(context);
    expect(agents.map((agent) => agent.id)).toEqual([
      "scout",
      "watchdog",
      "design",
      "coach",
      "api-standards",
      "release-train",
    ]);
    const snapshot = agents.find((agent) => agent.id === "api-standards");
    expect(snapshot?.lifecycle).toBe("stopped");
    expect(snapshot?.cadence.minutes).toBe(45);
    expect(snapshot?.limits).toEqual({ maxPerHour: 4, maxPending: 2 });
    expect(snapshot?.pending).toBe(1);
    expect(snapshot?.sync).toEqual({
      state: "ok",
      at: "2026-01-01T12:00:00.000Z",
      error: null,
    });
    expect(snapshot?.issues.map((row) => row.title)).toEqual([
      "POST /api/ready ignores the method",
    ]);
    expect(snapshot?.detail.panel).toBe("activity");
  });

  test("the shared page projection has no documentation and no timer gate", () => {
    const descriptor = agentRegistry.require("api-standards");
    expect(descriptor.documentation).toBeUndefined();
    expect(descriptor.timerGate).toBeUndefined();
    expect(descriptor.detail.panel).toBe("activity");
    expect(descriptor.lifecycle).toEqual(["stopped", "starting", "running", "stopping", "failed"]);
  });
});

describe("api-standards forge reading", () => {
  test("the Gitea reader lists only api-standards issues and every open title", async () => {
    const calls: string[] = [];
    const forge = createApiStandardsForge({
      repository: "acme/fixture",
      repoDir: harnessRoot,
      environment: { DEVBOARD_GITEA_URL: "http://forge.test", GITEA_TOKEN: "t" },
      forge: "gitea",
      giteaFetch: async (input: string) => {
        const url = new URL(input);
        calls.push(`${url.pathname}${url.search}`);
        if (url.pathname.endsWith("/issues")) {
          const state = url.searchParams.get("state");
          if (state === "open") {
            return Response.json([
              {
                number: 2,
                title: "Open non-label issue",
                body: "",
                state: "open",
                labels: [{ id: 1, name: "design" }],
                html_url: "http://forge.test/acme/fixture/issues/2",
                created_at: "2026-01-01T00:00:00.000Z",
              },
            ]);
          }
          return Response.json([
            {
              number: 1,
              title: "HTTP method violation",
              body: "body",
              state: "closed",
              labels: [{ id: 2, name: "api-standards" }],
              html_url: "http://forge.test/acme/fixture/issues/1",
              created_at: "2026-01-01T00:00:00.000Z",
            },
            {
              number: 2,
              title: "Open non-label issue",
              body: "",
              state: "open",
              labels: [{ id: 1, name: "design" }],
              html_url: "http://forge.test/acme/fixture/issues/2",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ]);
        }
        return Response.json([]);
      },
    });
    expect((await forge.listIssues()).map((issue) => issue.title)).toEqual([
      "HTTP method violation",
    ]);
    expect(await forge.listOpenIssueTitles()).toEqual(["Open non-label issue"]);
    expect(calls.length).toBeGreaterThan(0);
  });
});
