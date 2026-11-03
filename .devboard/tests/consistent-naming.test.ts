import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ENTRY_POINT_SURFACES,
  EntryPointError,
  consistentNamingPool,
  eligibleFiles,
  pickEntryPoint,
} from "../lib/entry-point";
import type {
  ConsistentNamingForgeClient,
  ConsistentNamingForgeIssue,
} from "../issues/consistent-naming/forge";
import { writeCommand } from "../issues/consistent-naming/control";
import { ConsistentNamingWorker } from "../issues/consistent-naming/worker";
import {
  CONSISTENT_NAMING_CATEGORIES,
  CONSISTENT_NAMING_LABEL,
  DEFAULT_INTERVAL_MINUTES,
  cyclesDirectory,
  requestPath,
  settingsPath,
  versionedControlDirectory,
} from "../issues/consistent-naming/paths";
import {
  capacityFor,
  emptyState,
  parseState,
  readSettings,
  writeSettings,
  type ConsistentNamingIssueRow,
} from "../issues/consistent-naming/state";
import { readGlossaries } from "../issues/consistent-naming/glossary";
import { occurrencesFor } from "../issues/consistent-naming/occurrences";
import { readSkillDirectives, verifyFiling } from "../issues/consistent-naming/provenance";
import { agentRegistry } from "../server/agents/registry";
import { MCP_TOOL_NAMES } from "../mcp/catalog";
import { callTool } from "../mcp/tools";
import type { McpContext } from "../mcp/context";
import type { AcpPeer, IssuesPeerOptions } from "../issues/worker";
import type { ForgeIssueSummary, ForgeIssues } from "../lib/forge-issues";

const harnessRoot = join(import.meta.dir, "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function temporaryRoot(name: string): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", `consistent-naming-${name}-`));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const SKILL_PATH = ".omp/skills/devboard-consistent-naming/SKILL.md";
const GLOSSARY_PATH = ".omp/discover/glossary/orders.glossary.yaml";
const GLOSSARY = [
  "boundedContext: orders",
  "concepts:",
  "  - id: order-total",
  "    prefLabels:",
  "      - language: en",
  "        text: Order Total",
  "    altLabels:",
  "      - language: en",
  "        text: order sum",
  "  - id: invoice",
  "    prefLabels:",
  "      - language: en",
  "        text: Invoice",
  "    altLabels:",
  "      - language: en",
  "        text: bill",
  "",
].join("\n");

function repositoryFiles(root: string): void {
  write(join(root, SKILL_PATH), readFileSync(join(harnessRoot, "..", SKILL_PATH), "utf8"));
  write(join(root, GLOSSARY_PATH), GLOSSARY);
  write(
    join(root, "server", "handler.ts"),
    [
      "// The order sum is computed here.",
      "// The bill is sent after payment.",
      "// The price is per item.",
      "export const handler = 1;",
      "",
    ].join("\n"),
  );
  write(
    join(root, "client", "view.ts"),
    ["// The price label.", "export const view = 1;", ""].join("\n"),
  );
  write(
    join(root, "client", "summary.ts"),
    ["// The order sum in the summary.", "export const summary = 1;", ""].join("\n"),
  );
  write(
    join(root, "tests", "handler.test.ts"),
    ["// The order sum fixture.", "export const test = 1;", ""].join("\n"),
  );
  write(
    join(root, "README.md"),
    ["# Fixture", "", "The bill is issued after checkout.", "The order sum appears here.", ""].join(
      "\n",
    ),
  );
  write(join(root, "GOAL.md"), "# Goal\n");
}

interface Candidate {
  title: string;
  category: string;
  concept: string;
  nameInUse: string;
  proposed: string;
  glossary?: { path: string; label: string; id: string; conflict: boolean };
}

const CATEGORY_TITLES: Record<string, string> = {
  "synonymous naming": "Synonymous naming",
  "semantic ambiguity": "Semantic ambiguity",
  "inconsistent vocabulary": "Inconsistent vocabulary",
  "misleading naming": "Misleading naming",
  "unnecessary terminology": "Unnecessary terminology",
  "conceptual collision": "Conceptual collision",
  "implementation-driven naming": "Implementation-driven naming",
};

function directiveOf(skillText: string, title: string): string {
  const lines = skillText.split(/\r?\n/);
  let inViolations = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      inViolations = line.slice(3).trim().toLowerCase() === "architectural violations";
      continue;
    }
    if (!inViolations) continue;
    const match = /^-\s+\*\*(.+?):\*\*\s*(.+)$/.exec(line.trim());
    if (match === null || (match[1] ?? "").trim().toLowerCase() !== title.toLowerCase()) continue;
    const parts = [(match[2] ?? "").trim()];
    let next = index + 1;
    while (next < lines.length) {
      const continuation = lines[next] ?? "";
      const trimmed = continuation.trim();
      if (trimmed.length === 0 || trimmed.startsWith("- ") || continuation.startsWith("#")) break;
      parts.push(trimmed);
      next += 1;
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function bodyFor(root: string, candidate: Candidate): string {
  const found = occurrencesFor(root, candidate.nameInUse);
  const occurrences: string[] = [];
  let evidence: { path: string; line: number } | undefined;
  const preferred = found.get("server/handler.ts")?.[0];
  if (preferred !== undefined) evidence = { path: "server/handler.ts", line: preferred };
  for (const [path, lines] of [...found].sort(([left], [right]) => left.localeCompare(right))) {
    for (const line of lines) occurrences.push(`- \`${path}:${line}\``);
    if (evidence === undefined && lines[0] !== undefined) evidence = { path, line: lines[0] };
  }
  if (evidence === undefined) throw new Error(`no occurrence of ${candidate.nameInUse}`);
  const quote = (
    readFileSync(join(root, evidence.path), "utf8").split(/\r?\n/)[evidence.line - 1] ?? ""
  ).trim();
  const skillText = readFileSync(join(root, SKILL_PATH), "utf8");
  const directive = directiveOf(skillText, CATEGORY_TITLES[candidate.category] ?? "");
  const glossary = candidate.glossary;
  return [
    "## Category",
    "",
    candidate.category,
    "",
    "## Concept",
    "",
    candidate.concept,
    "",
    "## Name in use",
    "",
    candidate.nameInUse,
    "",
    "## Proposed name",
    "",
    candidate.proposed,
    "",
    "## Skill",
    "",
    SKILL_PATH,
    "",
    "## Directive",
    "",
    `> ${directive}`,
    "",
    ...(glossary === undefined
      ? []
      : glossary.conflict
        ? [
            "## Glossary conflict",
            "",
            `${glossary.path} assigns the name in use to “${glossary.label}” (concept id ` +
              `\`${glossary.id}\`).`,
            "",
          ]
        : [
            "## Glossary",
            "",
            `${glossary.path} — preferred label “${glossary.label}”, concept id ` +
              `\`${glossary.id}\`.`,
            "",
          ]),
    "## Why the name is inconsistent",
    "",
    `“${candidate.nameInUse}” is not the one name the ${candidate.concept} concept carries.`,
    "",
    "## Evidence",
    "",
    `- \`${evidence.path}:${evidence.line}\``,
    `  > ${quote}`,
    "",
    "## Occurrences",
    "",
    ...occurrences,
    "",
    "## Rename",
    "",
    `Rename every occurrence of “${candidate.nameInUse}” to “${candidate.proposed}”; ` +
      "behavior is unchanged.",
    "",
    "## Acceptance criteria",
    "",
    `- No occurrence of “${candidate.nameInUse}” remains in the repository.`,
    "",
  ].join("\n");
}

const ORDER_TOTAL: Candidate = {
  title: "Use order total for the order sum concept",
  category: "synonymous naming",
  concept: "order total",
  nameInUse: "order sum",
  proposed: "Order Total",
  glossary: { path: GLOSSARY_PATH, label: "Order Total", id: "order-total", conflict: false },
};

const PRICE: Candidate = {
  title: "Name the price concept unit price",
  category: "synonymous naming",
  concept: "price",
  nameInUse: "price",
  proposed: "unit price",
};

describe("consistent-naming entry point", () => {
  test("ships the fifth surface", () => {
    expect([...ENTRY_POINT_SURFACES]).toEqual([
      "scout",
      "design",
      "dead-code",
      "single-responsibility",
      "consistent-naming",
    ]);
  });

  test("the pool covers the server and client trees and excludes tests and fixtures", async () => {
    const root = await temporaryRoot("pool");
    repositoryFiles(root);
    write(join(root, "server", "handler.test.ts"), "export const test = 1;\n");
    write(join(root, "server", "handler.spec.ts"), "export const spec = 1;\n");
    write(join(root, "server", "fixtures", "row.ts"), "export const fixture = 1;\n");
    write(join(root, "server", "stubs", "join.ts"), "export const stub = 1;\n");
    write(join(root, "node_modules", "pkg", "index.ts"), "export const vendored = 1;\n");
    write(join(root, "dist", "bundle.ts"), "export const built = 1;\n");
    write(join(root, ".worktree", "task", "file.ts"), "export const worktree = 1;\n");
    write(join(root, ".devboard", ".tmp", "state.ts"), "export const temporary = 1;\n");
    const pool = consistentNamingPool(root);
    expect(pool).toEqual([
      "client/summary.ts",
      "client/view.ts",
      "server/handler.ts",
    ]);
    expect(eligibleFiles(root, "consistent-naming")).toEqual(pool);
    expect(pool.some((path) => path.startsWith("server/"))).toBe(true);
    expect(pool.some((path) => path.startsWith("client/"))).toBe(true);
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
      surface: "consistent-naming",
      seed: "naming-proof",
    });
    const second = pickEntryPoint({
      repoDir: root,
      surface: "consistent-naming",
      seed: "naming-proof",
    });
    expect(second).toEqual(first);
    const paths = new Set(
      Array.from({ length: 10 }, (_value, index) =>
        pickEntryPoint({
          repoDir: root,
          surface: "consistent-naming",
          seed: `naming-${index}`,
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

describe("consistent-naming provenance", () => {
  test("accepts one concept, one category, the complete occurrence list, and the glossary", async () => {
    const root = await temporaryRoot("provenance-ok");
    repositoryFiles(root);
    const skill = readSkillDirectives(root, SKILL_PATH);
    expect([...skill.directives.keys()]).toEqual([...CONSISTENT_NAMING_CATEGORIES]);
    expect(skill.directives.get("synonymous naming")).toBe(
      "The same concept appears under two or more names, so a reader must learn that the names " +
        "denote one thing.",
    );
    const glossaries = readGlossaries(root);
    expect(glossaries.map((entry) => entry.path)).toEqual([GLOSSARY_PATH]);
    const result = verifyFiling(
      root,
      skill,
      { title: ORDER_TOTAL.title, body: bodyFor(root, ORDER_TOTAL), labels: [CONSISTENT_NAMING_LABEL] },
      { glossaries },
    );
    expect(result).toEqual({ ok: true, category: "synonymous naming" });
  });

  test("lists every occurrence in server, client, tests, and documentation", async () => {
    const root = await temporaryRoot("occurrences");
    repositoryFiles(root);
    const found = occurrencesFor(root, "order sum");
    expect([...found.keys()].sort()).toEqual([
      "README.md",
      "client/summary.ts",
      "server/handler.ts",
      "tests/handler.test.ts",
    ]);
    const body = bodyFor(root, ORDER_TOTAL);
    expect(body).toContain("- `README.md:4`");
    expect(body).toContain("- `client/summary.ts:1`");
    expect(body).toContain("- `server/handler.ts:1`");
    expect(body).toContain("- `tests/handler.test.ts:1`");
  });

  test("refuses two categories, a stale quote, wrong labels, and an incomplete list", async () => {
    const root = await temporaryRoot("provenance-refusals");
    repositoryFiles(root);
    const skill = readSkillDirectives(root, SKILL_PATH);
    const glossaries = readGlossaries(root);
    const valid = bodyFor(root, ORDER_TOTAL);
    const filing = (body: string) => ({
      title: ORDER_TOTAL.title,
      body,
      labels: [CONSISTENT_NAMING_LABEL],
    });
    const twoCategories = verifyFiling(
      root,
      skill,
      filing(`${valid}\n\nmisleading naming\n`),
      { glossaries },
    );
    expect(twoCategories.ok).toBe(false);
    const staleQuote = verifyFiling(
      root,
      skill,
      filing(valid.replace("> // The order sum is computed here.", "> // The order sum is absent.")),
      { glossaries },
    );
    expect(staleQuote.ok).toBe(false);
    const wrongLabels = verifyFiling(root, skill, {
      ...filing(valid),
      labels: [CONSISTENT_NAMING_LABEL, "bug"],
    }, { glossaries });
    expect(wrongLabels.ok).toBe(false);
    const incomplete = verifyFiling(
      root,
      skill,
      filing(valid.replace("- `README.md:4`\n", "")),
      { glossaries },
    );
    expect(incomplete.ok).toBe(false);
    expect(incomplete.ok === false ? incomplete.detail : "").toContain("README.md");
  });

  test("requires the glossary label and reports a conflict instead of a new synonym", async () => {
    const root = await temporaryRoot("glossary");
    repositoryFiles(root);
    const skill = readSkillDirectives(root, SKILL_PATH);
    const glossaries = readGlossaries(root);
    const withoutGlossary = bodyFor(root, { ...ORDER_TOTAL, glossary: undefined });
    const missing = verifyFiling(
      root,
      skill,
      { title: ORDER_TOTAL.title, body: withoutGlossary, labels: [CONSISTENT_NAMING_LABEL] },
      { glossaries },
    );
    expect(missing.ok).toBe(false);
    const wrongLabel = verifyFiling(
      root,
      skill,
      {
        title: ORDER_TOTAL.title,
        body: bodyFor(root, { ...ORDER_TOTAL, proposed: "order amount" }),
        labels: [CONSISTENT_NAMING_LABEL],
      },
      { glossaries },
    );
    expect(wrongLabel.ok).toBe(false);
    const conflictCandidate: Candidate = {
      title: "Report the bill conflict with the invoice concept",
      category: "misleading naming",
      concept: "order total",
      nameInUse: "bill",
      proposed: "Invoice",
      glossary: { path: GLOSSARY_PATH, label: "Invoice", id: "invoice", conflict: true },
    };
    const conflict = verifyFiling(
      root,
      skill,
      {
        title: conflictCandidate.title,
        body: bodyFor(root, conflictCandidate),
        labels: [CONSISTENT_NAMING_LABEL],
      },
      { glossaries },
    );
    expect(conflict).toEqual({ ok: true, category: "misleading naming" });
    const unreported = verifyFiling(
      root,
      skill,
      {
        title: conflictCandidate.title,
        body: bodyFor(root, { ...conflictCandidate, glossary: undefined }),
        labels: [CONSISTENT_NAMING_LABEL],
      },
      { glossaries },
    );
    expect(unreported.ok).toBe(false);
  });

  test("refuses a step-by-step structural refactor", async () => {
    const root = await temporaryRoot("vocabulary-only");
    repositoryFiles(root);
    const skill = readSkillDirectives(root, SKILL_PATH);
    const glossaries = readGlossaries(root);
    const body = bodyFor(root, ORDER_TOTAL).replace(
      "## Acceptance criteria",
      "## Refactor\n\n1. Extract a service.\n\n## Acceptance criteria",
    );
    const result = verifyFiling(
      root,
      skill,
      { title: ORDER_TOTAL.title, body, labels: [CONSISTENT_NAMING_LABEL] },
      { glossaries },
    );
    expect(result.ok).toBe(false);
  });
});

function issueRow(
  overrides: Partial<ConsistentNamingIssueRow> = {},
): ConsistentNamingIssueRow {
  return {
    number: 1,
    title: "Use order total for the order sum concept",
    url: "https://github.com/acme/fixture/issues/1",
    createdAt: new Date().toISOString(),
    state: "pending",
    category: "synonymous naming",
    version: null,
    ...overrides,
  };
}

class FakeForge implements ConsistentNamingForgeClient {
  readonly issues: ConsistentNamingForgeIssue[] = [];
  openTitles: string[] = [];

  async listIssues(): Promise<ConsistentNamingForgeIssue[]> {
    return [...this.issues];
  }

  async listOpenIssueTitles(): Promise<string[]> {
    return [...this.openTitles];
  }

  add(root: string, candidate: Candidate): number {
    const number = this.issues.length + 1;
    this.issues.push({
      number,
      title: candidate.title,
      url: `https://github.com/acme/fixture/issues/${number}`,
      state: "open",
      createdAt: new Date().toISOString(),
      body: bodyFor(root, candidate),
      labels: [CONSISTENT_NAMING_LABEL],
    });
    return number;
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
      const directory = prompt.slice("/consistent-naming ".length);
      const request = JSON.parse(readFileSync(requestPath(directory), "utf8")) as Record<
        string,
        unknown
      >;
      onRequest?.(request, directory);
      const repoDir = String(request.repoDir ?? "");
      const room = Number(request.issueRoom);
      const records: string[] = [];
      if (room >= 1) {
        const number = forge.add(repoDir, ORDER_TOTAL);
        records.push(
          JSON.stringify({
            tool: "issue_create",
            ok: true,
            value: { number, title: ORDER_TOTAL.title },
          }),
        );
      }
      if (room >= 2) {
        const number = forge.add(repoDir, PRICE);
        records.push(
          JSON.stringify({
            tool: "issue_create",
            ok: true,
            value: { number, title: PRICE.title },
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
}): ConsistentNamingWorker {
  return new ConsistentNamingWorker({
    repoDir: options.repo,
    stateDir: options.stateDir,
    manualCycles: options.manual ?? true,
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    syncMs: 60_000,
    cadenceMs: 60 * 60_000,
    now: options.now ?? (() => new Date("2026-01-01T12:00:00Z")),
    harnessVersion: "test",
    github: options.forge,
    connect: peerFor(options.forge, options.onRequest),
  });
}

describe("consistent-naming descriptor", () => {
  test("declares the label, categories, cadence, and defaults", () => {
    const descriptor = agentRegistry.require("consistent-naming");
    expect(descriptor.label).toBe("Consistent Naming");
    expect(descriptor.description).toContain("naming skill");
    expect(descriptor.scope).toBe("repository");
    expect(descriptor.cadence.defaultMinutes).toBe(DEFAULT_INTERVAL_MINUTES);
    expect(descriptor.cadence.minMinutes).toBe(1);
    expect(descriptor.cadence.maxMinutes).toBe(1440);
    expect(descriptor.limits.default).toEqual({ maxPerHour: 10, maxPending: 5 });
    expect(descriptor.detail.panel).toBe("activity");
    expect(descriptor.prompt).toEqual({ kind: "file", file: "consistent-naming.md" });
    expect(descriptor.tab).toEqual({
      id: "consistent-naming",
      kind: "consistent-naming",
      title: "Consistent Naming",
    });
    expect(CONSISTENT_NAMING_LABEL).toBe("consistent-naming");
    expect([...CONSISTENT_NAMING_CATEGORIES]).toEqual([
      "synonymous naming",
      "semantic ambiguity",
      "inconsistent vocabulary",
      "misleading naming",
      "unnecessary terminology",
      "conceptual collision",
      "implementation-driven naming",
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
    expect(agentRegistry.ids()).toContain("consistent-naming");
  });
});

describe("consistent-naming worker", () => {
  test("one cycle files one issue per concept and violation with provenance", async () => {
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
      new Set(["synonymous naming"]),
    );
    expect(seen?.surface).toBe("consistent-naming");
    expect(seen?.skillPath).toBe(SKILL_PATH);
    expect(JSON.stringify(seen?.categories)).toBe(JSON.stringify([...CONSISTENT_NAMING_CATEGORIES]));
    expect(JSON.stringify(seen?.glossaries)).toBe(JSON.stringify([GLOSSARY_PATH]));
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

  test("a filing with an incomplete occurrence list is never published", async () => {
    const root = await temporaryRoot("verification-failure");
    const repo = join(root, "repo");
    repositoryFiles(repo);
    const stateDir = join(repo, ".devboard", ".tmp", "state");
    mkdirSync(stateDir, { recursive: true });
    const forge = new FakeForge();
    forge.issues.push({
      number: 1,
      title: ORDER_TOTAL.title,
      url: "https://github.com/acme/fixture/issues/1",
      state: "open",
      createdAt: new Date().toISOString(),
      body: bodyFor(repo, ORDER_TOTAL).replace("- `README.md:4`\n", ""),
      labels: [CONSISTENT_NAMING_LABEL],
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
      forge.add(repo, { ...ORDER_TOTAL, title: `Open fixture violation ${index}` });
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

describe("consistent-naming dedupe guard", () => {
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
        labels: [CONSISTENT_NAMING_LABEL],
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
        title: "Use  ORDER total for the order sum concept",
        state: "closed",
        labels: [CONSISTENT_NAMING_LABEL],
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
      title: ORDER_TOTAL.title,
      body: bodyFor(root, ORDER_TOTAL),
      labels: [CONSISTENT_NAMING_LABEL],
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
      body: bodyFor(root, ORDER_TOTAL),
      labels: [CONSISTENT_NAMING_LABEL],
    });
    expect(result.error).toContain("already exists");
  });
});
