import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ENTRY_POINT_SURFACES,
  EntryPointError,
  eligibleFiles,
  pickEntryPoint,
  singleResponsibilityPool,
} from "../lib/entry-point";
import type {
  SingleResponsibilityForgeClient,
  SingleResponsibilityForgeIssue,
} from "../issues/single-responsibility/forge";
import { writeCommand } from "../issues/single-responsibility/control";
import { SingleResponsibilityWorker } from "../issues/single-responsibility/worker";
import {
  cyclesDirectory,
  DEFAULT_INTERVAL_MINUTES,
  SINGLE_RESPONSIBILITY_CATEGORIES,
  SINGLE_RESPONSIBILITY_LABEL,
  requestPath,
  settingsPath,
  versionedControlDirectory,
  versionedStatePath,
} from "../issues/single-responsibility/paths";
import {
  capacityFor,
  emptyState,
  parseState,
  readSettings,
  writeSettings,
  type SingleResponsibilityIssueRow,
} from "../issues/single-responsibility/state";
import {
  readSkillDirectives,
  verifyFiling,
} from "../issues/single-responsibility/provenance";
import { agentRegistry } from "../server/agents/registry";
import { MCP_TOOL_NAMES } from "../mcp/catalog";
import { callTool } from "../mcp/tools";
import type { McpContext } from "../mcp/context";
import type { AcpPeer, IssuesPeerOptions } from "../issues/worker";
import type { ForgeIssueSummary, ForgeIssues } from "../lib/forge-issues";
import { preflightSingleResponsibility } from "../issues/single-responsibility/preflight";
import { makeRepository } from "./fixtures/scout-helpers";

const harnessRoot = join(import.meta.dir, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function temporaryRoot(name: string): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", `single-responsibility-${name}-`));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const SKILL = [
  "# Single Responsibility Principle",
  "",
  "## Architectural Violations",
  "",
  "- **Mixed responsibilities:** A function, class, or module performs operations belonging to " +
    "conceptually unrelated concerns.",
  "- **Divergent change:** A component requires modifications for multiple independent reasons.",
  "- **Accidental aggregation:** Unrelated functionality is grouped together for convenience " +
    "rather than shared responsibility.",
  "- **Responsibility leakage:** A component implements behavior that belongs to another " +
    "component's responsibility.",
  "- **Artificial fragmentation:** A cohesive responsibility is unnecessarily split into " +
    "trivial components without establishing meaningful separation.",
  "",
].join("\n");

const SKILL_PATH = ".omp/skills/devboard-single-responsibility-principle/SKILL.md";

function repositoryFiles(root: string): void {
  write(join(root, SKILL_PATH), SKILL);
  write(join(root, "src", "handler.ts"), "export const handle = 1;\nexport const parse = 2;\n");
  write(join(root, "src", "renderer.ts"), "export const renderRow = 1;\n");
  write(join(root, "src", "formatter.ts"), "export const formatCell = 1;\n");
  write(join(root, "src", "reader.ts"), "export const readOne = 1;\n");
  write(join(root, "GOAL.md"), "# Goal\n");
}

function bodyFor(
  root: string,
  options: {
    category: string;
    title: string;
    path: string;
    line: number;
    component?: string;
    extra?: string;
  },
): string {
  const source = readFileSync(join(root, options.path), "utf8").split("\n");
  const quote = (source[options.line - 1] ?? "").trim();
  const title =
    options.category === "mixed-responsibilities"
      ? "Mixed responsibilities"
      : options.category === "divergent-change"
        ? "Divergent change"
        : options.category === "accidental-aggregation"
          ? "Accidental aggregation"
          : options.category === "responsibility-leakage"
            ? "Responsibility leakage"
            : "Artificial fragmentation";
  return [
    "## Category",
    "",
    options.category,
    "",
    "## Component",
    "",
    options.component ?? `${options.path} — the fixture component`,
    "",
    "## Skill",
    "",
    SKILL_PATH,
    "",
    "## Directive",
    "",
    `> - **${title}:** ${SKILL.split("\n").find((line) => line.startsWith(`- **${title}:**`))!.slice(`- **${title}:** `.length)}`,
    "",
    "## Why the responsibilities are mixed",
    "",
    options.title,
    "",
    "## Evidence",
    "",
    `- \`${options.path}:${options.line}-${options.line}\``,
    `  > ${quote}`,
    "",
    "## Refactor",
    "",
    "Move the unrelated behavior into its own component.",
    "",
    "## Acceptance criteria",
    "",
    "- The component no longer contains the moved behavior.",
    "",
    ...(options.extra === undefined ? [] : [options.extra, ""]),
  ].join("\n");
}

describe("single-responsibility entry point", () => {
  test("ships the fourth surface", () => {
    expect([...ENTRY_POINT_SURFACES]).toEqual([
      "scout",
      "design",
      "dead-code",
      "single-responsibility",
      "consistent-naming",
    ]);
  });

  test("the pool holds component sources and excludes tests, specs, fixtures, and stubs", async () => {
    const root = await temporaryRoot("pool");
    repositoryFiles(root);
    write(join(root, "src", "handler.test.ts"), "export const test = 1;\n");
    write(join(root, "src", "handler.spec.ts"), "export const spec = 1;\n");
    write(join(root, "src", "fixtures", "row.ts"), "export const fixture = 1;\n");
    write(join(root, "tests", "legacy.ts"), "export const legacy = 1;\n");
    write(join(root, "src", "stubs", "join.ts"), "export const stub = 1;\n");
    write(join(root, "node_modules", "pkg", "index.ts"), "export const vendored = 1;\n");
    write(join(root, "dist", "bundle.ts"), "export const built = 1;\n");
    write(join(root, ".worktree", "task", "file.ts"), "export const worktree = 1;\n");
    write(join(root, ".devboard", ".tmp", "state.ts"), "export const temporary = 1;\n");
    const pool = singleResponsibilityPool(root);
    expect(pool).toEqual([
      "src/formatter.ts",
      "src/handler.ts",
      "src/reader.ts",
      "src/renderer.ts",
    ]);
    expect(eligibleFiles(root, "single-responsibility")).toEqual(pool);
    for (const path of pool) {
      expect(/\.(test|spec)\./.test(path)).toBe(false);
      expect(/(^|\/)(fixtures|tests|stubs)\//.test(path)).toBe(false);
    }
  });

  test("the same seed returns the identical path and line; another seed moves", async () => {
    const root = await temporaryRoot("seeded");
    repositoryFiles(root);
    const first = pickEntryPoint({
      repoDir: root,
      surface: "single-responsibility",
      seed: "srp-proof",
    });
    const second = pickEntryPoint({
      repoDir: root,
      surface: "single-responsibility",
      seed: "srp-proof",
    });
    expect(second).toEqual(first);
    const paths = new Set(
      Array.from({ length: 10 }, (_value, index) =>
        pickEntryPoint({
          repoDir: root,
          surface: "single-responsibility",
          seed: `srp-${index}`,
        }).path,
      ),
    );
    expect(paths.size).toBeGreaterThanOrEqual(2);
  });

  test("an unknown surface is refused before any read", async () => {
    const root = await temporaryRoot("refusal");
    repositoryFiles(root);
    expect(() => pickEntryPoint({ repoDir: root, surface: "nope", seed: "s" })).toThrow(
      EntryPointError,
    );
  });
});

describe("provenance", () => {
  test("accepts one component, one category, the directive, and a verbatim quote", async () => {
    const root = await temporaryRoot("provenance-ok");
    repositoryFiles(root);
    const skill = readSkillDirectives(root, SKILL_PATH);
    expect([...skill.directives.keys()]).toEqual([...SINGLE_RESPONSIBILITY_CATEGORIES]);
    const result = verifyFiling(root, skill, {
      title: "Split parsing out of the fixture handler",
      body: bodyFor(root, {
        category: "mixed-responsibilities",
        title: "The handler parses and renders.",
        path: "src/handler.ts",
        line: 1,
      }),
      labels: [SINGLE_RESPONSIBILITY_LABEL],
    });
    expect(result).toEqual({ ok: true, category: "mixed-responsibilities" });
  });

  test("refuses a second category, a missing skill path, and a stale quote", async () => {
    const root = await temporaryRoot("provenance-refusals");
    repositoryFiles(root);
    const skill = readSkillDirectives(root, SKILL_PATH);
    const valid = bodyFor(root, {
      category: "mixed-responsibilities",
      title: "The handler parses and renders.",
      path: "src/handler.ts",
      line: 1,
    });
    const filing = (body: string) => ({
      title: "Split parsing out of the fixture handler",
      body,
      labels: [SINGLE_RESPONSIBILITY_LABEL],
    });
    const twoCategories = verifyFiling(root, skill, filing(`${valid}\n\ndivergent-change\n`));
    expect(twoCategories.ok).toBe(false);
    const noSkill = verifyFiling(
      root,
      skill,
      filing(valid.replace(SKILL_PATH, "somewhere/else.md")),
    );
    expect(noSkill.ok).toBe(false);
    const staleQuote = verifyFiling(
      root,
      skill,
      filing(valid.replace("> export const handle = 1;", "> export const absent = 0;")),
    );
    expect(staleQuote.ok).toBe(false);
    const wrongLabels = verifyFiling(root, skill, {
      ...filing(valid),
      labels: ["single-responsibility", "bug"],
    });
    expect(wrongLabels.ok).toBe(false);
  });
});

function issueRow(overrides: Partial<SingleResponsibilityIssueRow> = {}): SingleResponsibilityIssueRow {
  return {
    number: 1,
    title: "Split the fixture handler",
    url: "https://github.com/acme/fixture/issues/1",
    createdAt: new Date().toISOString(),
    state: "pending",
    category: "mixed-responsibilities",
    version: null,
    ...overrides,
  };
}

class FakeForge implements SingleResponsibilityForgeClient {
  readonly issues: SingleResponsibilityForgeIssue[] = [];
  openTitles: string[] = [];

  async listIssues(): Promise<SingleResponsibilityForgeIssue[]> {
    return [...this.issues];
  }

  async listOpenIssueTitles(): Promise<string[]> {
    return [...this.openTitles];
  }

  add(root: string, options: { category: string; title: string; path: string; line: number }): void {
    const number = this.issues.length + 1;
    this.issues.push({
      number,
      title: options.title,
      url: `https://github.com/acme/fixture/issues/${number}`,
      state: "open",
      createdAt: new Date().toISOString(),
      body: bodyFor(root, options),
      labels: [SINGLE_RESPONSIBILITY_LABEL],
    });
  }
}

function peerFor(
  forge: FakeForge,
  onRequest?: (request: Record<string, unknown>, directory: string) => void,
): (options: IssuesPeerOptions) => AcpPeer {
  return () => ({
    pid: undefined,
    argv: [],
    async run(prompt: string): Promise<unknown> {
      const directory = prompt.slice("/single-responsibility ".length);
      const request = JSON.parse(readFileSync(requestPath(directory), "utf8")) as Record<
        string,
        unknown
      >;
      onRequest?.(request, directory);
      const repoDir = String(request.repoDir ?? "");
      const room = Number(request.issueRoom);
      const records: string[] = [];
      if (room >= 1) {
        forge.add(repoDir, {
          category: "mixed-responsibilities",
          title: "Split the fixture handler",
          path: "src/handler.ts",
          line: 1,
        });
        records.push(
          JSON.stringify({
            tool: "issue_create",
            ok: true,
            value: { number: 1, title: "Split the fixture handler" },
          }),
        );
      }
      if (room >= 2) {
        forge.add(repoDir, {
          category: "responsibility-leakage",
          title: "Move rendering out of the fixture handler",
          path: "src/renderer.ts",
          line: 1,
        });
        records.push(
          JSON.stringify({
            tool: "issue_create",
            ok: true,
            value: { number: 2, title: "Move rendering out of the fixture handler" },
          }),
        );
      }
      if (records.length > 0) {
        writeFileSync(join(directory, "tool-log.jsonl"), `${records.join("\n")}\n`);
      }
      return {};
    },
    async prompt(): Promise<unknown> {
      return {};
    },
    answer(): boolean {
      return true;
    },
    close(): void {},
  });
}

function workerFor(options: {
  repo: string;
  stateDir: string;
  forge: FakeForge;
  now?: () => Date;
  manual?: boolean;
  tickMs?: number;
  onRequest?: (request: Record<string, unknown>, directory: string) => void;
  connect?: (options: IssuesPeerOptions) => AcpPeer;
}): SingleResponsibilityWorker {
  return new SingleResponsibilityWorker({
    repoDir: options.repo,
    stateDir: options.stateDir,
    manualCycles: options.manual ?? true,
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    syncMs: 60_000,
    cadenceMs: 60 * 60_000,
    now: options.now ?? (() => new Date("2026-01-01T12:00:00Z")),
    harnessVersion: "test",
    github: options.forge,
    connect: options.connect ?? peerFor(options.forge, options.onRequest),
  });
}

describe("single-responsibility descriptor", () => {
  test("declares the label, categories, cadence, and defaults", () => {
    const descriptor = agentRegistry.require("single-responsibility");
    expect(descriptor.label).toBe("Single Responsibility");
    expect(descriptor.description).toContain("Single Responsibility skill");
    expect(descriptor.scope).toBe("repository");
    expect(descriptor.cadence.defaultMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(descriptor.cadence.minMinutes).toBe(1);
    expect(descriptor.cadence.maxMinutes).toBe(1440);
    expect(descriptor.limits.default).toEqual({ maxPerHour: 10, maxPending: 5 });
    expect(descriptor.detail.panel).toBe("activity");
    expect(descriptor.prompt).toEqual({ kind: "file", file: "single-responsibility.md" });
    expect(descriptor.tab).toEqual({
      id: "single-responsibility",
      kind: "single-responsibility",
      title: "Single Responsibility",
    });
    expect(SINGLE_RESPONSIBILITY_LABEL).toBe("single-responsibility");
    expect([...SINGLE_RESPONSIBILITY_CATEGORIES]).toEqual([
      "mixed-responsibilities",
      "divergent-change",
      "accidental-aggregation",
      "responsibility-leakage",
      "artificial-fragmentation",
    ]);
  });

  test("the capacity is the smaller room, capped at 100", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const rows = Array.from({ length: 4 }, (_value, index) =>
      issueRow({ number: index + 1, createdAt: "2026-01-01T11:30:00Z" }),
    );
    expect(capacityFor(rows, { maxPerHour: 10, maxPending: 5 }, now).batch).toBe(1);
    expect(capacityFor([], { maxPerHour: null, maxPending: null }, now).batch).toBe(100);
    expect(capacityFor([], { maxPerHour: 1, maxPending: 1 }, now).batch).toBe(1);
  });

  test("state parsing refuses a foreign version and keeps the defaults", () => {
    const state = emptyState({ repo: "acme/fixture", root: "/fixture" });
    expect(parseState(JSON.stringify(state))?.limits).toEqual({ maxPerHour: 10, maxPending: 5 });
    expect(parseState(JSON.stringify({ ...state, version: 99 }))).toBeUndefined();
  });

  test("the MCP catalog accepts the surface and the family is listed", () => {
    expect(MCP_TOOL_NAMES).toContain("entry_point");
    expect(agentRegistry.ids()).toContain("single-responsibility");
  });
});

describe("single-responsibility worker", () => {
  test("one cycle files one issue per component and violation with provenance", async () => {
    const root = await temporaryRoot("cycle");
    const repo = join(root, "repo");
    repositoryFiles(repo);
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    let seen: Record<string, unknown> | undefined;
    const worker = workerFor({ repo, stateDir, forge, onRequest: (request) => (seen = request) });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();

    const state = worker.currentState;
    expect(state.issues.length).toBe(2);
    expect(new Set(state.issues.map((issue) => issue.category))).toEqual(
      new Set(["mixed-responsibilities", "responsibility-leakage"]),
    );
    expect(state.issues.every((issue) => issue.title.length <= 200)).toBe(true);
    expect(seen?.surface).toBe("single-responsibility");
    expect(seen?.skillPath).toBe(SKILL_PATH);
    expect(JSON.stringify(seen?.categories)).toBe(
      JSON.stringify([...SINGLE_RESPONSIBILITY_CATEGORIES]),
    );
    expect(seen?.issueRoom).toBe(5);
    const cycleIds = readdirSync(cyclesDirectory(repo)).sort();
    expect(cycleIds.length).toBe(1);
    const request = JSON.parse(
      readFileSync(join(cyclesDirectory(repo), cycleIds[0]!, "request.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(request.maxPerHour).toBe(10);
    expect(request.maxPending).toBe(5);
    expect(typeof request.createdAt).toBe("string");
    const activity = readFileSync(join(cyclesDirectory(repo), cycleIds[0]!, "activity.json"), "utf8");
    expect(activity).toContain("filed #1");
    expect(activity).toContain("filed #2");

    await worker.stop();
    expect(worker.currentState.issues.length).toBe(2);
  });

  test("a filing without the five-category provenance is never published", async () => {
    const root = await temporaryRoot("verification-failure");
    const repo = join(root, "repo");
    repositoryFiles(repo);
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    forge.issues.push({
      number: 1,
      title: "Report a concern outside the five categories",
      url: "https://github.com/acme/fixture/issues/1",
      state: "open",
      createdAt: new Date().toISOString(),
      body: [
        "## Category",
        "",
        "unlisted-category",
        "",
        "## Component",
        "",
        "the fixture",
        "",
        "## Evidence",
        "",
        "- `src/handler.ts:1-1`",
        "  > export const handle = 1;",
      ].join("\n"),
      labels: [SINGLE_RESPONSIBILITY_LABEL],
    });
    const worker = workerFor({ repo, stateDir, forge });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    expect(worker.currentState.issues).toEqual([]);
    await worker.beginCycle();
    await worker.waitForCycle();
    const cycleIds = readdirSync(cyclesDirectory(repo)).sort();
    const activity = readFileSync(join(cyclesDirectory(repo), cycleIds[0]!, "activity.json"), "utf8");
    expect(activity).toContain("verification failure");
    expect(worker.currentState.issues.map((issue) => issue.number).sort()).toEqual([2, 3]);
    await worker.stop();
  });

  test("the cadence blocks a second cycle and a zero room files nothing", async () => {
    const root = await temporaryRoot("cadence");
    const repo = join(root, "repo");
    repositoryFiles(repo);
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    for (let index = 1; index <= 5; index += 1) {
      forge.add(repo, {
        category: "mixed-responsibilities",
        title: `Open fixture violation ${index}`,
        path: "src/handler.ts",
        line: index === 1 ? 1 : 2,
      });
    }
    const clock = { now: new Date("2026-01-01T12:00:00Z") };
    const worker = workerFor({
      repo,
      stateDir,
      forge,
      now: () => clock.now,
      manual: false,
      tickMs: 60_000,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    writeSettings(settingsPath(stateDir, repo), {
      maxPerHour: 10,
      maxPending: 5,
      intervalMinutes: 60,
    });
    await worker.refresh();
    expect(worker.currentState.issues.length).toBe(5);
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(forge.issues.length).toBe(5);
    const cycleIds = readdirSync(cyclesDirectory(repo)).sort();
    const activity = readFileSync(join(cyclesDirectory(repo), cycleIds[0]!, "activity.json"), "utf8");
    expect(activity).toContain("no filing room");
    clock.now = new Date("2026-01-01T12:30:00Z");
    await worker.tickNow();
    expect(readdirSync(cyclesDirectory(repo)).length).toBe(1);
    await worker.stop();
  });

  test("the caps count a labelled issue whose proof fails, and the read records it", async () => {
    const silentPeer = (): AcpPeer => ({
      pid: undefined,
      argv: [],
      async run(): Promise<unknown> {
        return {};
      },
      async prompt(): Promise<unknown> {
        return {};
      },
      answer(): boolean {
        return true;
      },
      close(): void {},
    });
    const filing = (repo: string, drifted: boolean): SingleResponsibilityForgeIssue => {
      const body = bodyFor(repo, {
        category: "mixed-responsibilities",
        title: "Mixed responsibilities",
        path: "src/handler.ts",
        line: 1,
      });
      return {
        number: 1,
        title: "Split the fixture handler",
        url: "https://github.com/acme/fixture/issues/1",
        state: "open",
        createdAt: new Date().toISOString(),
        body: drifted
          ? body.replace("> export const handle = 1;", "> export const absent = 0;")
          : body,
        labels: [SINGLE_RESPONSIBILITY_LABEL],
      };
    };
    const setup = async (state: "none" | "proven" | "drifted") => {
      const root = await temporaryRoot(`capacity-${state}`);
      const repo = join(root, "repo");
      repositoryFiles(repo);
      const stateDir = join(repo, ".devboard", ".tmp", "state");
      mkdirSync(stateDir, { recursive: true });
      const forge = new FakeForge();
      if (state !== "none") forge.issues.push(filing(repo, state === "drifted"));
      writeSettings(settingsPath(stateDir, repo), {
        maxPerHour: 10,
        maxPending: 1,
        intervalMinutes: 60,
      });
      const worker = workerFor({ repo, stateDir, forge, connect: () => silentPeer() });
      expect(existsSync(versionedStatePath(stateDir, repo, "test"))).toBe(false);
      expect(worker.start("acme/fixture")).toBe(true);
      return { repo, forge, worker };
    };
    const roomAfterOneRead = async (state: "none" | "proven" | "drifted") => {
      const context = await setup(state);
      await context.worker.refresh();
      await context.worker.beginCycle();
      await context.worker.waitForCycle();
      const cycleIds = readdirSync(cyclesDirectory(context.repo)).sort();
      const request = JSON.parse(
        readFileSync(requestPath(join(cyclesDirectory(context.repo), cycleIds.at(-1)!)), "utf8"),
      ) as Record<string, unknown>;
      return { ...context, request };
    };

    const none = await roomAfterOneRead("none");
    expect(none.request.issueRoom).toBe(1);
    expect(none.worker.currentState.issues).toEqual([]);
    await none.worker.stop();

    const proven = await roomAfterOneRead("proven");
    expect(proven.request.issueRoom).toBe(0);
    expect(proven.worker.currentState.issues.map((row) => row.number)).toEqual([1]);
    await proven.worker.stop();

    const drifted = await roomAfterOneRead("drifted");
    expect(drifted.request.issueRoom).toBe(0);
    expect(drifted.worker.currentState.issues).toEqual([]);
    await drifted.worker.stop();

    // The periodic read appends the rejection to the newest cycle's activity.
    const late = await setup("none");
    await late.worker.refresh();
    await late.worker.beginCycle();
    await late.worker.waitForCycle();
    const [cycleId] = readdirSync(cyclesDirectory(late.repo)).sort();
    const activityPath = join(cyclesDirectory(late.repo), cycleId!, "activity.json");
    expect(readFileSync(activityPath, "utf8")).not.toContain("verification failure");
    late.forge.issues.push(filing(late.repo, true));
    await late.worker.refresh();
    expect(readFileSync(activityPath, "utf8")).toContain(
      "verification failure: #1 “Split the fixture handler”",
    );
    await late.worker.stop();
  });

  test("a cycle leaves git status and HEAD unchanged", async () => {
    const root = await temporaryRoot("read-only");
    const repo = join(root, "repo");
    repositoryFiles(repo);
    write(join(repo, ".devboard", ".gitignore"), ".tmp/\n");
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const git = (args: string[]): string => {
      const child = Bun.spawnSync({
        cmd: ["git", "-C", repo, ...args],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
      return child.stdout.toString().trim();
    };
    git(["init", "-q"]);
    git(["config", "user.email", "verify@example.test"]);
    git(["config", "user.name", "Devboard Verify"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "fixture"]);
    const statusBefore = git(["status", "--porcelain"]);
    const headBefore = git(["rev-parse", "HEAD"]);

    const forge = new FakeForge();
    const worker = workerFor({ repo, stateDir, forge });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(worker.currentState.issues.length).toBe(2);
    expect(git(["status", "--porcelain"])).toBe(statusBefore);
    expect(git(["rev-parse", "HEAD"])).toBe(headBefore);
    await worker.stop();
  });

  test("a drain during an in-flight cycle exits once that cycle ends", async () => {
    const root = await temporaryRoot("drain");
    const repo = join(root, "repo");
    repositoryFiles(repo);
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    const release = Promise.withResolvers<void>();
    const worker = new SingleResponsibilityWorker({
      repoDir: repo,
      stateDir,
      syncMs: 60_000,
      cadenceMs: 60 * 60_000,
      now: () => new Date("2026-01-01T12:00:00Z"),
      harnessVersion: "test",
      github: forge,
      connect: () => ({
        pid: undefined,
        argv: [],
        async run(): Promise<unknown> {
          await release.promise;
          return {};
        },
        async prompt(): Promise<unknown> {
          return {};
        },
        answer(): boolean {
          return true;
        },
        close(): void {},
      }),
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.tickNow();
    expect(worker.cyclingNow).toBe(true);
    writeCommand(versionedControlDirectory(stateDir, repo, "test"), { type: "drain" });
    await worker.tickNow();
    expect(worker.currentState.draining).toBe(true);
    expect(worker.cyclingNow).toBe(true);
    release.resolve();
    await worker.waitForCycle();
    expect(worker.currentState.lifecycle).toBe("stopped");
    expect(readdirSync(cyclesDirectory(repo)).length).toBe(1);
  });

  test("settings persist and apply to the running worker", async () => {
    const root = await temporaryRoot("settings");
    const repo = join(root, "repo");
    repositoryFiles(repo);
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    const worker = workerFor({ repo, stateDir, forge });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    writeCommand(versionedControlDirectory(stateDir, repo, "test"), {
      type: "settings",
      intervalMinutes: 15,
      maxPerHour: 3,
      maxPending: 2,
    });
    await worker.tickNow();
    expect(worker.currentState.intervalMinutes).toBe(15);
    expect(worker.currentState.limits).toEqual({ maxPerHour: 3, maxPending: 2 });
    expect(readSettings(settingsPath(stateDir, repo))).toEqual({
      intervalMinutes: 15,
      maxPerHour: 3,
      maxPending: 2,
    });
    await worker.stop();
  });
});

describe("single-responsibility dedupe guard", () => {
  function context(root: string, forge: ForgeIssues): McpContext {
    return {
      repoDir: root,
      harnessDir: harnessRoot,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment: {},
      forgeIssues: forge,
    };
  }

  function forgeWith(rows: ForgeIssueSummary[]): ForgeIssues {
    return {
      forge: "github",
      repository: "acme/fixture",
      list: async () => rows,
      listAll: async () => rows,
      get: async (number) => ({
        number,
        title: "existing",
        body: "body",
        state: "open",
        labels: [SINGLE_RESPONSIBILITY_LABEL],
        url: `https://github.com/acme/fixture/issues/${number}`,
        createdAt: null,
      }),
      ensureLabel: async () => undefined,
      create: async (input) => ({
        number: 99,
        title: input.title,
        body: input.body,
        state: "open",
        labels: input.labels ?? [],
        url: "https://github.com/acme/fixture/issues/99",
        createdAt: null,
      }),
      comment: async () => undefined,
      close: async (number) => ({
        number,
        title: "existing",
        body: "body",
        state: "closed",
        labels: [],
        url: `https://github.com/acme/fixture/issues/${number}`,
        createdAt: null,
      }),
    };
  }

  test("a normalized duplicate of a labeled issue files nothing", async () => {
    const root = await temporaryRoot("dedupe");
    repositoryFiles(root);
    const forge = forgeWith([
      {
        number: 4,
        title: "Split  the FIXTURE handler",
        state: "closed",
        labels: [SINGLE_RESPONSIBILITY_LABEL],
        url: "https://github.com/acme/fixture/issues/4",
        createdAt: null,
      },
    ]);
    let created = 0;
    const original = forge.create;
    forge.create = async (input) => {
      created += 1;
      return original(input);
    };
    const result = await callTool(context(root, forge), "issue_create", {
      title: "split the fixture handler",
      body: bodyFor(root, {
        category: "mixed-responsibilities",
        title: "The handler parses and renders.",
        path: "src/handler.ts",
        line: 1,
      }),
      labels: [SINGLE_RESPONSIBILITY_LABEL],
    });
    expect(result.error).toContain("already exists");
    expect(created).toBe(0);
  });

  test("a normalized duplicate of an open issue files nothing", async () => {
    const root = await temporaryRoot("dedupe-open");
    repositoryFiles(root);
    const forge = forgeWith([
      {
        number: 5,
        title: "A plain open concern",
        state: "open",
        labels: [],
        url: "https://github.com/acme/fixture/issues/5",
        createdAt: null,
      },
    ]);
    const result = await callTool(context(root, forge), "issue_create", {
      title: "A plain open concern",
      body: bodyFor(root, {
        category: "mixed-responsibilities",
        title: "The handler parses and renders.",
        path: "src/handler.ts",
        line: 1,
      }),
      labels: [SINGLE_RESPONSIBILITY_LABEL],
    });
    expect(result.error).toContain("already exists");
  });
});

describe("single-responsibility preflight", () => {
  test("accepts a command installed under the checkout's .omp/agent/commands", async () => {
    const root = await makeRepository({
      files: {
        [SKILL_PATH]: SKILL,
        ".omp/agent/commands/single-responsibility.md": "# command\n",
      },
      origin: "acme/fixture",
    });
    roots.push(root);
    const bin = join(root, "bin");
    write(join(bin, "omp"), "");
    write(join(bin, "gh"), "");
    const result = await preflightSingleResponsibility({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment: { PATH: bin, HOME: join(root, "home") },
      run: async (argv) => ({
        code: 0,
        stdout: argv.at(-1) === ".permissions.push" ? "true" : SINGLE_RESPONSIBILITY_LABEL,
        stderr: "",
      }),
    });
    expect(result).toEqual({ ok: true, repository: "acme/fixture" });
  });
});
