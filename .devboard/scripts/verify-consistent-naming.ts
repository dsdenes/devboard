#!/usr/bin/env bun
/**
 * The deterministic Consistent Naming gate. It builds the client, starts a
 * source dashboard against a fixture checkout, and drives headless Chrome with
 * a stub ACP peer and a stub `gh`. It proves the sidebar entry, the shared
 * page shape, the seeded entry point, the excluded test and fixture files, the
 * both-layer occurrence list, one issue per concept and violation with
 * provenance, the seven-category restriction, the glossary authority and
 * conflict rule, the vocabulary-only proposed change, dedupe, the caps, the
 * label, the preflight refusals, the read-only checkout, single flight, and
 * activity freshness.
 *
 * Every fixture, state directory, browser profile, and log lives under
 * `.devboard/.tmp`. It never contacts a real forge, npm, Gitea, or model.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eligibleFiles, pickEntryPoint, consistentNamingPool } from "../lib/entry-point";
import {
  CONSISTENT_NAMING_CATEGORIES,
  CONSISTENT_NAMING_LABEL,
  cyclesDirectory,
  versionedStatePath,
} from "../issues/consistent-naming/paths";
import { capacityFor, readState } from "../issues/consistent-naming/state";
import { readSkillDirectives, verifyFiling } from "../issues/consistent-naming/provenance";
import { readGlossaries } from "../issues/consistent-naming/glossary";
import { occurrencesFor } from "../issues/consistent-naming/occurrences";
import { preflightConsistentNaming } from "../issues/consistent-naming/preflight";
import { createIssue } from "../mcp/issues";
import type { McpContext } from "../mcp/context";
import type { ForgeIssueSummary, ForgeIssues } from "../lib/forge-issues";
import { readHarnessVersion } from "../server/version";
import {
  assertTrue,
  dashboardSocket,
  freePort,
  harnessRoot,
  makeRoot,
  run,
  waitFor,
} from "./verification";
import { seedVerificationProvider, verificationProviderUsageEnv } from "./provider-fixture";

const stubAcp = join(harnessRoot, "tests", "fixtures", "consistent-naming-stub-acp.ts");
const stubGh = join(harnessRoot, "tests", "fixtures", "consistent-naming-stub-gh.ts");
const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`;
    throw new Error(`verify:consistent-naming: ${message}${detail}`);
  }
}

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("verify:consistent-naming: Chrome is unavailable");
}

interface CdpReply {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class Devtools {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (reply: CdpReply) => void>();
  readonly errors: string[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    this.socket.onopen = () => opened.resolve();
    this.socket.onerror = () => opened.reject(new Error("devtools websocket error"));
    await opened.promise;
    this.socket.onmessage = (event) => {
      let reply: CdpReply;
      try {
        reply = JSON.parse(String(event.data)) as CdpReply;
      } catch {
        return;
      }
      if (typeof reply.id === "number") {
        this.pending.get(reply.id)?.(reply);
        this.pending.delete(reply.id);
        return;
      }
      if (reply.method === "Runtime.exceptionThrown") {
        this.errors.push(JSON.stringify(reply.result ?? {}));
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpReply> {
    const { promise, resolve: settle } = Promise.withResolvers<CdpReply>();
    const id = this.nextId;
    this.nextId += 1;
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        settle({ id, error: { message: `the ${method} reply did not arrive within 15s` } });
      }
    }, 15_000);
    timer.unref?.();
    this.pending.set(id, (reply) => {
      clearTimeout(timer);
      settle(reply);
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression: string): Promise<unknown> {
    const reply = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (reply.error !== undefined) throw new Error(reply.error.message ?? "evaluation failed");
    const result = reply.result;
    if (result === undefined || !("result" in result)) return undefined;
    const value = result.result;
    return typeof value === "object" && value !== null && "value" in value ? value.value : undefined;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

async function pageTarget(debugPort: number, dashboardPort: number): Promise<string> {
  return waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        const targets = (await response.json()) as Array<{
          type?: string;
          url?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.webSocketDebuggerUrl === "string" &&
            target.url?.includes(`:${dashboardPort}/`),
        );
        return page?.webSocketDebuggerUrl;
      } catch {
        return undefined;
      }
    },
    "the Chrome page target",
    30_000,
  );
}

async function present(devtools: Devtools, testid: string): Promise<boolean> {
  return (
    (await devtools.evaluate(
      `document.querySelector('[data-testid="${testid}"]') !== null`,
    )) === true
  );
}

async function count(devtools: Devtools, selector: string): Promise<number> {
  const value = await devtools.evaluate(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
  return typeof value === "number" ? value : -1;
}

async function text(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    return element === null ? "" : (element.textContent ?? '').trim();
  })()`);
  return typeof value === "string" ? value : "";
}

async function rawText(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.textContent ?? null`,
  );
  return typeof value === "string" ? value : "";
}

async function valueOf(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.value ?? ''`,
  );
  return typeof value === "string" ? value : "";
}

async function pageState(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.dataset.state ?? ''`,
  );
  return typeof value === "string" ? value : "";
}

async function click(devtools: Devtools, testid: string): Promise<void> {
  await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    if (element === null) return false;
    element.click();
    return true;
  })()`);
}

async function coreOrder(devtools: Devtools): Promise<string[]> {
  const core = [
    "agent-activity-bar",
    "agent-activity-toggle",
    "agent-activity-dot",
    "agent-activity-last",
    "agent-activity-control",
    "agent-start",
    "agent-stop",
    "agent-header",
    "agent-sync-at",
    "agent-cadence",
    "agent-last-run",
    "agent-next-run",
    "agent-save-cadence",
    "agent-limit-hour",
    "agent-limit-pending",
    "agent-save-limits",
    "agent-issues-count",
    "agent-issues",
  ];
  const value = await devtools.evaluate(`(() => {
    const page = document.querySelector('[data-testid="agent-page"]');
    const all = [...(page?.querySelectorAll('[data-testid]') ?? [])]
      .map((element) => element.getAttribute('data-testid') ?? '');
    const core = ${JSON.stringify(core)};
    return all.filter((id) => core.includes(id));
  })()`);
  return Array.isArray(value) ? (value as string[]) : [];
}

async function rows(
  devtools: Devtools,
): Promise<Array<{ url: string; state: string; title: string; category: string }>> {
  const value = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="agent-issue"]')
  ].map((row) => ({
    url: row.dataset.url ?? '',
    state: row.dataset.state ?? '',
    title: row.querySelector('[data-testid="agent-issue-title"]')?.textContent?.trim() ?? '',
    category: row.querySelector('[data-testid="agent-issue-category"]')?.textContent?.trim() ?? '',
  })))()`);
  return Array.isArray(value)
    ? (value as Array<{ url: string; state: string; title: string; category: string }>)
    : [];
}

async function barLog(devtools: Devtools): Promise<string> {
  const logSelector = `[data-testid="agent-page"] [data-testid="agent-activity-log"]`;
  const toggleSelector = `[data-testid="agent-page"] [data-testid="agent-activity-toggle"]`;
  const logPresent = async (): Promise<boolean> =>
    (await devtools.evaluate(`document.querySelector(${JSON.stringify(logSelector)}) !== null`)) ===
    true;
  if (!(await logPresent())) {
    await waitFor(
      async () =>
        (await devtools.evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}) !== null`)) ===
        true
          ? true
          : undefined,
      "the page's activity toggle",
      15_000,
    );
    const expanded = await devtools.evaluate(
      `document.querySelector(${JSON.stringify(toggleSelector)})?.getAttribute('aria-expanded') ?? ''`,
    );
    if (expanded !== "true") {
      await devtools.evaluate(`(() => {
        const toggle = document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-toggle"]');
        if (toggle === null) return false;
        toggle.click();
        return true;
      })()`);
    }
  }
  await waitFor(
    async () => ((await logPresent()) ? true : undefined),
    "the page's activity bar log",
    15_000,
  );
  const value = await devtools.evaluate(
    `document.querySelector(${JSON.stringify(logSelector)})?.textContent ?? null`,
  );
  return typeof value === "string" ? value : "";
}

interface StubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  createdAt: string;
  labels: string[];
}

const SKILL_PATH = ".omp/skills/devboard-consistent-naming/SKILL.md";
const GLOSSARY_PATH = ".omp/discover/glossary/orders.glossary.yaml";
const GLOSSARY_TEXT = [
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

interface FixtureCandidate {
  title: string;
  category: string;
  concept: string;
  nameInUse: string;
  proposed: string;
  glossary?: { label: string; id: string; conflict: boolean };
}

const root = await makeRoot("verify-consistent-naming");
console.error(`verify-consistent-naming: fixture ${root}`);
let dashboardPid = 0;
let chromePid = 0;
let devtools: Devtools | undefined;

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  check(build.code === 0, `bun run build failed: ${build.stderr}`);
  check(
    Bun.file(join(harnessRoot, "dist", "index.html")).size > 0,
    "the build produced no dist/index.html",
  );

  const repo = join(root, "repo");
  const stateDir = join(repo, ".devboard", ".tmp", "state");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const storePath = join(root, "gh-store.json");
  const acpLog = join(root, "acp.log");
  await mkdir(join(repo, "server", "fixtures"), { recursive: true });
  await mkdir(join(repo, "server", "stubs"), { recursive: true });
  await mkdir(join(repo, "client"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await mkdir(join(repo, ".devboard", "prompts"), { recursive: true });
  await mkdir(join(repo, ".devboard", ".tmp"), { recursive: true });
  await mkdir(join(repo, ".omp", "commands"), { recursive: true });
  await mkdir(join(repo, ".omp", "skills", "devboard-consistent-naming"), { recursive: true });
  await mkdir(join(repo, ".omp", "discover", "glossary"), { recursive: true });
  await mkdir(join(repo, "adrs"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await writeFile(join(repo, ".devboard", ".gitignore"), ".tmp/\n");
  await writeFile(
    join(repo, ".devboard", "prompts", "consistent-naming.md"),
    await Bun.file(join(harnessRoot, "prompts", "consistent-naming.md")).text(),
  );
  await writeFile(
    join(repo, ".omp", "commands", "consistent-naming.md"),
    await Bun.file(join(harnessRoot, "omp", "commands", "consistent-naming.md")).text(),
  );
  await writeFile(join(repo, SKILL_PATH), await Bun.file(join(harnessRoot, "..", SKILL_PATH)).text());
  await writeFile(join(repo, GLOSSARY_PATH), GLOSSARY_TEXT);
  await writeFile(join(repo, "GOAL.md"), "# Goal\n");
  await writeFile(
    join(repo, "server", "handler.ts"),
    [
      "// The order sum is computed here.",
      "// The bill is sent after payment.",
      "// The price is per item.",
      "export const handler = 1;",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, "client", "view.ts"),
    ["// The price label.", "export const view = 1;", ""].join("\n"),
  );
  await writeFile(
    join(repo, "client", "summary.ts"),
    ["// The order sum in the summary.", "export const summary = 1;", ""].join("\n"),
  );
  await writeFile(
    join(repo, "tests", "handler.test.ts"),
    ["// The order sum fixture.", "export const test = 1;", ""].join("\n"),
  );
  await writeFile(
    join(repo, "README.md"),
    ["# Fixture", "", "The bill is issued after checkout.", "The order sum appears here.", ""].join(
      "\n",
    ),
  );
  await writeFile(join(repo, "server", "handler.test.ts"), "export const test = 1;\n");
  await writeFile(join(repo, "server", "handler.spec.ts"), "export const spec = 1;\n");
  await writeFile(join(repo, "server", "fixtures", "row.ts"), "export const fixture = 1;\n");
  await writeFile(join(repo, "server", "stubs", "join.ts"), "export const stub = 1;\n");
  await writeFile(join(repo, "tests", "legacy.ts"), "export const legacy = 1;\n");
  await writeFile(join(repo, "adrs", "keep.txt"), "adrs\n");
  await writeFile(
    storePath,
    `${JSON.stringify({ nextNumber: 1, issues: [], openTitles: [] }, null, 2)}\n`,
  );
  await writeFile(join(bin, "gh"), `#!/bin/sh\nexec ${process.execPath} ${stubGh} "$@"\n`);
  await writeFile(join(bin, "omp"), "#!/bin/sh\nexit 0\n");
  run("chmod", ["+x", join(bin, "gh")]);
  run("chmod", ["+x", join(bin, "omp")]);

  const git = (args: string[], cwd = repo): string => {
    const result = run("git", ["-C", cwd, ...args]);
    check(result.code === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  run("git", ["init", "-q", repo]);
  git(["config", "user.email", "verify@example.test"]);
  git(["config", "user.name", "Devboard Verify"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  git(["remote", "add", "origin", "https://github.com/acme/fixture-consistent-naming.git"]);
  await writeFile(join(repo, ".devboard", ".tmp", ".gitkeep"), "");

  const skill = readSkillDirectives(repo, SKILL_PATH);
  const glossaries = readGlossaries(repo);

  /** One valid body for the fixture, built the way a cycle builds it. */
  const fixtureBody = (candidate: FixtureCandidate): string => {
    const found = occurrencesFor(repo, candidate.nameInUse);
    const occurrences: string[] = [];
    let evidence: { path: string; line: number } | undefined;
    const preferred = found.get("server/handler.ts")?.[0];
    if (preferred !== undefined) evidence = { path: "server/handler.ts", line: preferred };
    for (const [path, lines] of [...found].sort(([left], [right]) => left.localeCompare(right))) {
      for (const line of lines) occurrences.push(`- \`${path}:${line}\``);
      if (evidence === undefined && lines[0] !== undefined) evidence = { path, line: lines[0] };
    }
    check(evidence !== undefined, `the fixture has no occurrence of ${candidate.nameInUse}`);
    const quote = (
      readFileSync(join(repo, evidence.path), "utf8").split(/\r?\n/)[evidence.line - 1] ?? ""
    ).trim();
    const directive = skill.directives.get(
      candidate.category as (typeof CONSISTENT_NAMING_CATEGORIES)[number],
    );
    check(directive !== undefined, `the skill publishes no ${candidate.category} directive`);
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
              `${GLOSSARY_PATH} assigns the name in use to “${glossary.label}” (concept id ` +
                `\`${glossary.id}\`).`,
              "",
            ]
          : [
              "## Glossary",
              "",
              `${GLOSSARY_PATH} — preferred label “${glossary.label}”, concept id ` +
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
  };

  /* 1. Entry point: the pool, both layers, determinism, and the excluded files. */
  const bad = eligibleFiles(repo, "consistent-naming").filter(
    (path) => /\.(test|spec)\./.test(path) || /(^|\/)(fixtures|tests|stubs)\//.test(path),
  );
  check(bad.length === 0, "the pool admits a test or fixture file", bad);
  const pool = consistentNamingPool(repo);
  check(pool.length >= 3, "the pool is smaller than the fixture's component set", pool);
  const layers = [
    pool.some((path) => path.startsWith("server/")) ? "server" : "",
    pool.some((path) => path.startsWith("client/")) ? "client" : "",
  ].filter((layer) => layer.length > 0);
  check(
    layers.length === 2,
    "the pool does not cover both the server and the client trees",
    pool,
  );
  const seeded = pickEntryPoint({
    repoDir: repo,
    surface: "consistent-naming",
    seed: "naming-proof",
  });
  const replay = pickEntryPoint({
    repoDir: repo,
    surface: "consistent-naming",
    seed: "naming-proof",
  });
  check(
    seeded.path === replay.path && seeded.line === replay.line,
    "the same seed moved the entry point",
    [seeded, replay],
  );
  const distinct = new Set(
    Array.from({ length: 10 }, (_value, index) =>
      pickEntryPoint({
        repoDir: repo,
        surface: "consistent-naming",
        seed: `naming-${index}`,
      }).path,
    ),
  );
  check(distinct.size >= 2, "ten seeds never chose a different file", [...distinct]);
  console.log(
    `PASS entry-point surface=consistent-naming seed=naming-proof ` +
      `path=${seeded.path}:${seeded.line} distinct-seeds=${distinct.size} ` +
      `excluded=${JSON.stringify(bad)} pool=${pool.length} layers=${layers.join(",")}`,
  );

  /* 2. Preflight refusals, before any worker or state write. */
  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: home,
  } as Record<string, string | undefined>;
  const base = {
    repoDir: repo,
    stateDir,
    environment,
    origin: { forge: "github" as const, host: "github.com", project: "acme/fixture" },
  };
  const refusingRun = (answer: {
    permission?: string;
    label?: number;
    create?: number;
  }) => async (argv: string[]) => {
    const line = argv.join(" ");
    if (line.includes(".permissions.push")) {
      return { code: 0, stdout: `${answer.permission ?? "true"}\n`, stderr: "" };
    }
    if (line.includes("/labels/")) {
      return { code: answer.label ?? 1, stdout: "", stderr: "HTTP 404: Not Found" };
    }
    if (line.startsWith("label create")) {
      return {
        code: answer.create ?? 0,
        stdout: "",
        stderr: answer.create === undefined ? "" : "label forbidden",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const refusal = async (name: string, options: Record<string, unknown>) => {
    const result = await preflightConsistentNaming({
      ...base,
      run: refusingRun({}),
      ...options,
    } as Parameters<typeof preflightConsistentNaming>[0]);
    check(!result.ok, `${name} did not refuse`, result);
    return result.message;
  };
  const missingSkill = await refusal("a missing skill", {
    config: {
      skillDir: ".omp/skills/missing",
      skillDocument: ".omp/skills/missing/SKILL.md",
      glossaryDir: ".omp/discover/glossary",
    },
  });
  check(missingSkill.includes("skill"), `the missing-skill refusal is ${missingSkill}`);
  const outsideRepo = join(root, "outside-skill.md");
  await writeFile(outsideRepo, readFileSync(join(harnessRoot, "..", SKILL_PATH), "utf8"));
  const linked = join(repo, ".omp", "skills", "linked-skill.md");
  run("ln", ["-s", outsideRepo, linked]);
  const outsideSkill = await refusal("a skill outside the repository", {
    config: {
      skillDir: ".omp/skills",
      skillDocument: ".omp/skills/linked-skill.md",
      glossaryDir: ".omp/discover/glossary",
    },
  });
  check(
    outsideSkill.includes("outside the repository"),
    `the outside-skill refusal is ${outsideSkill}`,
  );
  unlinkSync(linked);
  const outsideState = await refusal("a state directory outside the checkout", {
    stateDir: join(root, "state"),
  });
  check(outsideState.includes("STATE_DIR"), `the state refusal is ${outsideState}`);
  const gitlab = await refusal("an unsupported forge", {
    origin: { forge: "gitlab" as const, host: "gitlab.example", project: "acme/fixture" },
  });
  check(gitlab.includes("GitLab"), `the forge refusal is ${gitlab}`);
  const withoutOmp = await refusal("a missing omp", {
    environment: { ...environment, PATH: "/usr/bin:/bin" },
  });
  check(withoutOmp.includes("omp is not on PATH"), `the omp refusal is ${withoutOmp}`);
  const commandPath = join(repo, ".omp", "commands", "consistent-naming.md");
  const commandBytes = readFileSync(commandPath);
  unlinkSync(commandPath);
  let noCommand = "";
  try {
    noCommand = await refusal("a missing command", {
      environment: { ...environment, HOME: join(root, "empty-home") },
    });
  } finally {
    writeFileSync(commandPath, commandBytes);
  }
  check(
    noCommand.includes("/consistent-naming command"),
    `the command refusal is ${noCommand}`,
  );
  const unwritable = await refusal("an account without write", {
    run: refusingRun({ permission: "false" }),
  });
  check(unwritable.includes(".permissions.push"), `the write refusal is ${unwritable}`);
  const labelFailed = await refusal("a label that cannot be created", {
    run: refusingRun({ permission: "true", label: 1, create: 1 }),
  });
  check(
    labelFailed.includes("label could not be created"),
    `the label refusal is ${labelFailed}`,
  );
  console.log(
    "PASS preflight-refusals skill-missing skill-outside state-outside forge-gitlab " +
      "omp-missing command-missing account-readonly label-create-failed",
  );

  /* 3. The seven categories, the caps, and the vocabulary-only proof, in process. */
  const outsideCategory = verifyFiling(
    repo,
    skill,
    {
      title: "Report a fixture concern outside the seven categories",
      body: "## Category\n\nunlisted-category\n\n## Concept\n\nthe fixture\n",
      labels: [CONSISTENT_NAMING_LABEL],
    },
    { glossaries },
  );
  check(!outsideCategory.ok, "a category outside the seven was accepted", outsideCategory);
  const capacity = capacityFor(
    [
      {
        number: 1,
        title: "recent",
        url: "u1",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        state: "pending",
        category: "synonymous naming",
        version: null,
      },
    ],
    { maxPerHour: 10, maxPending: 5 },
    new Date(),
  );
  check(
    capacity.batch === 4 && capacity.hourlyRoom === 9 && capacity.pendingRoom === 4,
    "the caps do not shrink the room",
    capacity,
  );
  check(
    capacityFor([], { maxPerHour: null, maxPending: null }, new Date()).batch === 100,
    "the empty caps do not allow 100",
  );
  const orderTotal: FixtureCandidate = {
    title: "Use order total for the order sum concept",
    category: "synonymous naming",
    concept: "order total",
    nameInUse: "order sum",
    proposed: "Order Total",
    glossary: { label: "Order Total", id: "order-total", conflict: false },
  };
  const valid = fixtureBody(orderTotal);
  const accepted = verifyFiling(
    repo,
    skill,
    { title: orderTotal.title, body: valid, labels: [CONSISTENT_NAMING_LABEL] },
    { glossaries },
  );
  check(accepted.ok, "the fixture's valid body was refused", accepted);
  const incomplete = verifyFiling(
    repo,
    skill,
    {
      title: orderTotal.title,
      body: valid.replace("- `README.md:4`\n", ""),
      labels: [CONSISTENT_NAMING_LABEL],
    },
    { glossaries },
  );
  check(!incomplete.ok, "an incomplete occurrence list was accepted", incomplete);
  const newSynonym = verifyFiling(
    repo,
    skill,
    {
      title: orderTotal.title,
      body: fixtureBody({ ...orderTotal, proposed: "order amount" }),
      labels: [CONSISTENT_NAMING_LABEL],
    },
    { glossaries },
  );
  check(!newSynonym.ok, "a proposed name outside the glossary was accepted", newSynonym);
  const structural = verifyFiling(
    repo,
    skill,
    {
      title: orderTotal.title,
      body: valid.replace(
        "## Acceptance criteria",
        "## Refactor\n\n1. Extract a service.\n\n## Acceptance criteria",
      ),
      labels: [CONSISTENT_NAMING_LABEL],
    },
    { glossaries },
  );
  check(!structural.ok, "a step-by-step structural refactor was accepted", structural);
  const conflictCandidate: FixtureCandidate = {
    title: "Report the bill conflict with the invoice concept",
    category: "misleading naming",
    concept: "order total",
    nameInUse: "bill",
    proposed: "Invoice",
    glossary: { label: "Invoice", id: "invoice", conflict: true },
  };
  const conflictBody = fixtureBody(conflictCandidate);
  const conflictAccepted = verifyFiling(
    repo,
    skill,
    { title: conflictCandidate.title, body: conflictBody, labels: [CONSISTENT_NAMING_LABEL] },
    { glossaries },
  );
  check(conflictAccepted.ok, "the reported glossary conflict was refused", conflictAccepted);
  const unreported = verifyFiling(
    repo,
    skill,
    {
      title: conflictCandidate.title,
      body: conflictBody.replace(/## Glossary conflict[\s\S]*?\n\n/, ""),
      labels: [CONSISTENT_NAMING_LABEL],
    },
    { glossaries },
  );
  check(!unreported.ok, "a silent glossary conflict was accepted", unreported);
  console.log(
    `PASS categories seven=${JSON.stringify([...CONSISTENT_NAMING_CATEGORIES])} ` +
      `outside=refused caps batch=${capacity.batch} hourlyRoom=${capacity.hourlyRoom} ` +
      `pendingRoom=${capacity.pendingRoom} ` +
      `unlimited=${capacityFor([], { maxPerHour: null, maxPending: null }, new Date()).batch} ` +
      "occurrences=complete-refused glossary=authority-and-conflict vocabulary-only=refactor-refused",
  );

  /* 4. Dedupe guard: a normalized duplicate files nothing. */
  let created = 0;
  const duplicateRows: ForgeIssueSummary[] = [
    {
      number: 7,
      title: "Use  ORDER total for the order sum concept",
      state: "closed",
      labels: [CONSISTENT_NAMING_LABEL],
      url: "https://github.com/acme/fixture-consistent-naming/issues/7",
      createdAt: null,
    },
  ];
  const fakeForge: ForgeIssues = {
    forge: "github",
    repository: "acme/fixture-consistent-naming",
    list: async () => duplicateRows,
    listAll: async () => duplicateRows,
    get: async (number) => ({
      number,
      title: "existing",
      body: "body",
      state: "open",
      labels: [CONSISTENT_NAMING_LABEL],
      url: `https://github.com/acme/fixture-consistent-naming/issues/${number}`,
      createdAt: null,
    }),
    ensureLabel: async () => undefined,
    create: async (input) => {
      created += 1;
      return {
        number: 99,
        title: input.title,
        body: input.body,
        state: "open",
        labels: input.labels ?? [],
        url: "https://github.com/acme/fixture-consistent-naming/issues/99",
        createdAt: null,
      };
    },
    comment: async () => undefined,
    close: async (number) => ({
      number,
      title: "existing",
      body: "body",
      state: "closed",
      labels: [],
      url: `https://github.com/acme/fixture-consistent-naming/issues/${number}`,
      createdAt: null,
    }),
  };
  const mcpContext: McpContext = {
    repoDir: repo,
    harnessDir: harnessRoot,
    stateDir,
    environment: {},
    forgeIssues: fakeForge,
  };
  let refusedDuplicate = "";
  try {
    await createIssue(mcpContext, {
      title: "use order total for the order sum concept",
      body: valid,
      labels: [CONSISTENT_NAMING_LABEL],
    });
  } catch (error) {
    refusedDuplicate = error instanceof Error ? error.message : String(error);
  }
  check(refusedDuplicate.includes("already exists"), "the dedupe guard did not refuse", {
    refusedDuplicate,
    created,
  });
  check(created === 0, "the dedupe guard still created an issue", created);
  console.log(
    `PASS dedupe guard=refused created=${created} message=${JSON.stringify(refusedDuplicate)}`,
  );

  /* 5. The shared page, then Start. */
  seedVerificationProvider(stateDir);
  const port = await freePort();
  const statusBefore = git(["status", "--porcelain"]);
  const headBefore = git(["rev-parse", "HEAD"]);
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      ...verificationProviderUsageEnv(),
      HOST: "127.0.0.1",
      PORT: String(port),
      REPO_DIR: repo,
      ADRS_DIR: join(repo, "adrs"),
      GOAL_FILE: join(repo, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: stateDir,
      AGENT_COMMAND: `${process.execPath} ${stubAcp}`,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: home,
      CONSISTENT_NAMING_STUB_STATE: storePath,
      CONSISTENT_NAMING_STUB_ACP_LOG: acpLog,
      CONSISTENT_NAMING_STUB_DELAY_MS: "2500",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  dashboardPid = dashboard.pid ?? 0;
  const dashboardErrors: string[] = [];
  dashboard.stderr?.on("data", (chunk) => dashboardErrors.push(String(chunk)));
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the seeded dashboard",
    30_000,
  );

  const debugPort = await freePort();
  const profile = join(root, "chrome-profile");
  await mkdir(profile, { recursive: true });
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromePid = chrome.pid ?? 0;
  devtools = new Devtools(await pageTarget(debugPort, port));
  await devtools.connect();
  await devtools.send("Runtime.enable");
  await devtools.send("Page.enable");

  await waitFor(
    async () => ((await present(devtools!, "mode-devboard")) ? true : undefined),
    "the Devboard mode control",
    30_000,
  );
  await click(devtools, "mode-devboard");
  await waitFor(
    async () => ((await present(devtools!, "open-devboard-consistent-naming")) ? true : undefined),
    "the Consistent Naming sidebar entry",
    15_000,
  );
  const sidebar = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="sidebar-background-agents"] [data-testid^="open-devboard-"]')
  ].map((button) => button.getAttribute('data-testid') ?? ''))()`);
  check(
    JSON.stringify(sidebar) ===
      JSON.stringify([
        "open-devboard-scout",
        "open-devboard-watchdog",
        "open-devboard-design",
        "open-devboard-dead-code",
        "open-devboard-mcp-optimizer",
        "open-devboard-api-standards",
        "open-devboard-single-responsibility",
        "open-devboard-consistent-naming",
        "open-devboard-release-train",
      ]),
    "the Background agents order is wrong",
    sidebar,
  );
  const entry = (await devtools.evaluate(`(() => {
    const button = document.querySelector('[data-testid="open-devboard-consistent-naming"]');
    return {
      label: button?.querySelector('.sidebar-item__label')?.textContent?.trim() ?? '',
      state: button?.querySelector('[data-testid="agent-state-consistent-naming"]')?.dataset.state ?? '',
      count: button?.querySelector('[data-testid="agent-count-consistent-naming"]')?.textContent?.trim() ?? '',
    };
  })()`)) as Record<string, string>;
  check(
    entry.label === "Consistent Naming" && entry.state === "stopped" && entry.count === "0",
    "the Consistent Naming sidebar entry is wrong",
    entry,
  );
  console.log("PASS sidebar-entry open-devboard-consistent-naming label=Consistent Naming");

  await click(devtools, "open-devboard-consistent-naming");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Consistent Naming page",
    10_000,
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
    )) === "consistent-naming",
    "the page is not the Consistent Naming page",
  );
  check((await valueOf(devtools, "agent-cadence")) === "60", "the cadence is not 60 minutes");
  check((await valueOf(devtools, "agent-limit-hour")) === "10", "the hourly limit is not 10");
  check((await valueOf(devtools, "agent-limit-pending")) === "5", "the pending limit is not 5");
  const core = await coreOrder(devtools);
  check(core.length >= 14, "the page is missing core ids", core);
  const startStop =
    (await count(devtools, '[data-testid="agent-start"]')) +
    (await count(devtools, '[data-testid="agent-stop"]'));
  check(startStop === 1, `the page renders ${startStop} start/stop controls`);
  check(await present(devtools, "agent-start"), "Start is not offered while stopped");
  check(!(await present(devtools, "agent-stop")), "Stop is offered while stopped");
  for (const testid of [
    "agent-issues",
    "agent-issues-count",
    "agent-sync-at",
    "agent-last-run",
    "agent-next-run",
  ]) {
    check(await present(devtools, testid), `${testid} is missing`);
  }
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-bar"]') !== null`,
    )) === true,
    "the page's pinned activity bar is missing",
  );
  check(await present(devtools, "agent-issues-empty"), "the filed issues table is not empty");
  check((await count(devtools, '[data-testid="agent-issue"]')) === 0, "a filed row is present");
  const promptBody = readFileSync(join(harnessRoot, "prompts", "consistent-naming.md"), "utf8");
  await click(devtools, "agent-prompt-summary");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt-text")) ? true : undefined),
    "the Consistent Naming prompt bytes",
    10_000,
  );
  check((await rawText(devtools, "agent-prompt-text")) === promptBody, "the prompt bytes differ");
  for (const testid of ["agent-prompt-editor", "agent-prompt-save", "agent-prompt-chat"]) {
    check(!(await present(devtools, testid)), `the prompt is editable through ${testid}`);
  }
  console.log("PASS page-shape consistent-naming core-ids prompt-read-only empty-table");

  /* 6. Start, single flight, and one cycle's filings. */
  const cycleIds = (): string[] => {
    try {
      return readdirSync(cyclesDirectory(repo)).sort();
    } catch {
      return [];
    }
  };
  const ws = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  ws.onerror = () => opened.resolve();
  await opened.promise;
  const observer = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
  const activityFrames: Array<{ scanId?: string; count: number }> = [];
  let lastDetail: unknown;
  observer.onmessage = (event) => {
    let frame: {
      type?: string;
      id?: string;
      scanId?: string;
      entries?: unknown[];
      agent?: { id?: string; detail?: unknown };
    };
    try {
      frame = JSON.parse(String(event.data)) as typeof frame;
    } catch {
      return;
    }
    if (frame.type === "agentState" && frame.agent?.id === "consistent-naming") {
      lastDetail = frame.agent.detail;
      return;
    }
    if (frame.type !== "agentActivity" || frame.id !== "consistent-naming") return;
    activityFrames.push({
      ...(typeof frame.scanId === "string" ? { scanId: frame.scanId } : {}),
      count: Array.isArray(frame.entries) ? frame.entries.length : 0,
    });
  };
  const observerOpen = Promise.withResolvers<void>();
  observer.onopen = () => observerOpen.resolve();
  observer.onerror = () => observerOpen.resolve();
  await observerOpen.promise;
  await click(devtools, "agent-start");
  const firstCycle = await waitFor(
    () => cycleIds()[0],
    "the first consistent-naming cycle",
    30_000,
  );
  ws.send(JSON.stringify({ type: "startAgent", id: "consistent-naming" }));
  ws.send(JSON.stringify({ type: "startAgent", id: "consistent-naming" }));
  await waitFor(
    async () =>
      (await pageState(devtools!, "agent-state-consistent-naming")) === "running"
        ? true
        : undefined,
    "Consistent Naming to run",
    30_000,
  );
  // A cadence change and a page open while the cycle runs start no second cycle.
  await devtools.evaluate(`(() => {
    const input = document.querySelector('[data-testid="agent-cadence"]');
    if (input === null) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '30');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await click(devtools, "agent-save-cadence");
  await click(devtools, "open-devboard-consistent-naming");
  ws.send(JSON.stringify({ type: "refreshAgent", id: "consistent-naming" }));
  await waitFor(
    () => {
      const state = readState(versionedStatePath(stateDir, repo, readHarnessVersion(harnessRoot)));
      return state !== undefined && state.lifecycle !== "auditing" && state.issues.length > 0
        ? state
        : undefined;
    },
    "the first cycle to publish its filings",
    90_000,
  );
  await waitFor(
    async () =>
      (await count(devtools!, '[data-testid="agent-issue"]')) === 5 ? true : undefined,
    "five filed rows",
    30_000,
  );
  check(cycleIds().length === 1, "a second cycle started", cycleIds());
  check(
    readFileSync(acpLog, "utf8").split("\n").filter((line) => line.startsWith("start ")).length ===
      1,
    "a second ACP peer started",
  );
  check(
    (await text(devtools, "agent-count-consistent-naming")) === "5",
    "the sidebar count does not match the rows",
  );
  check(
    (await text(devtools, "agent-issues-count")) === "5 filed",
    "the page count does not match the rows",
  );
  const request = JSON.parse(
    readFileSync(join(cyclesDirectory(repo), firstCycle, "request.json"), "utf8"),
  ) as Record<string, unknown>;
  const entryPoint = request.entryPoint as { path: string; line: number };
  const log = await barLog(devtools);
  const barDiagnostic = await devtools.evaluate(`(() => ({
    pages: [...document.querySelectorAll('[data-testid="agent-page"]')].map((page) => page.dataset.agent ?? ''),
    bars: document.querySelectorAll('[data-testid="agent-activity-bar"]').length,
    logs: document.querySelectorAll('[data-testid="agent-activity-log"]').length,
    toggles: [...document.querySelectorAll('[data-testid="agent-activity-toggle"]')].map(
      (toggle) => toggle.getAttribute('aria-expanded') ?? '',
    ),
    last: [...document.querySelectorAll('[data-testid="agent-activity-last"]')].map(
      (last) => last.textContent?.trim() ?? '',
    ),
  }))()`);
  check(
    log.includes("filed #"),
    `the activity bar does not carry the filings; frames=${JSON.stringify(activityFrames)} ` +
      `detail=${JSON.stringify(lastDetail)} dom=${JSON.stringify(barDiagnostic)}`,
    log,
  );
  check(log.includes(entryPoint.path), "the activity bar does not name the entry point", log);
  check(
    (await text(devtools, "agent-last-run")) !== "never",
    "agent-last-run shows no cycle",
  );
  console.log(
    `PASS activity-freshness files=${cycleIds().length} filings=5 bar=${JSON.stringify(
      log.slice(-160),
    )}`,
  );

  /* 7. One request, one issue per concept and violation, both layers, glossary. */
  check(request.surface === "consistent-naming", "the request surface is wrong", request);
  check(request.skillPath === SKILL_PATH, "the request skill path is wrong", request.skillPath);
  check(
    JSON.stringify(request.categories) === JSON.stringify([...CONSISTENT_NAMING_CATEGORIES]),
    "the request categories are wrong",
    request.categories,
  );
  check(
    JSON.stringify(request.glossaries) === JSON.stringify([GLOSSARY_PATH]),
    "the request does not name every published glossary",
    request.glossaries,
  );
  check(request.issueRoom === 5, `the request room is ${String(request.issueRoom)}`);
  check(request.maxPerHour === 10 && request.maxPending === 5, "the request caps are wrong");
  check(Array.isArray(request.knownTitles), "the request carries no known titles");
  check(typeof request.createdAt === "string", "the request carries no creation time");
  const replayed = pickEntryPoint({
    repoDir: repo,
    surface: "consistent-naming",
    seed: request.seed as string,
  });
  check(
    replayed.path === entryPoint.path && replayed.line === entryPoint.line,
    "the request seed does not replay its entry point",
    { entryPoint, replayed },
  );

  const store = JSON.parse(readFileSync(storePath, "utf8")) as { issues: StubIssue[] };
  check(store.issues.length === 5, "the forge holds another number of issues", store.issues);
  const pairs = new Map<string, Set<string>>();
  const categoriesAcross = new Map<string, Set<string>>();
  let occurrenceLayers: string[] = [];
  let conflictReported = false;
  let authorityReported = false;
  for (const issue of store.issues) {
    check(
      JSON.stringify(issue.labels) === JSON.stringify([CONSISTENT_NAMING_LABEL]),
      `issue #${issue.number} labels are ${JSON.stringify(issue.labels)}`,
    );
    check(
      issue.title.length <= 200 && !/[\r\n]/.test(issue.title),
      `issue #${issue.number} title is not one plain line`,
    );
    const verified = verifyFiling(
      repo,
      skill,
      { title: issue.title, body: issue.body, labels: issue.labels },
      { glossaries },
    );
    check(verified.ok, `issue #${issue.number} lost its provenance`, verified);
    const concept = /## Concept\s*\n+([^\n]+)/.exec(issue.body)?.[1]?.trim() ?? "";
    const categories = CONSISTENT_NAMING_CATEGORIES.filter((category) =>
      issue.body.includes(category),
    );
    check(
      categories.length === 1 && categories[0] === verified.category,
      `issue #${issue.number} names ${categories.length} categories`,
    );
    const known = pairs.get(concept) ?? new Set<string>();
    check(
      !known.has(verified.category),
      `issue #${issue.number} repeats ${concept} and ${verified.category}`,
    );
    known.add(verified.category);
    pairs.set(concept, known);
    const across = categoriesAcross.get(verified.category) ?? new Set<string>();
    across.add(concept);
    categoriesAcross.set(verified.category, across);
    if (/## Glossary conflict/.test(issue.body)) {
      conflictReported = true;
      check(
        issue.body.includes(GLOSSARY_PATH) &&
          issue.body.includes("Invoice") &&
          issue.body.includes("invoice"),
        `issue #${issue.number} reports no glossary conflict`,
      );
    }
    if (/## Glossary\b/.test(issue.body) && !/## Glossary conflict/.test(issue.body)) {
      authorityReported = true;
      check(
        issue.body.includes(GLOSSARY_PATH) &&
          /Order Total|Invoice/.test(issue.body),
        `issue #${issue.number} names no glossary authority`,
      );
    }
    const occurrences = /## Occurrences\s*\n([\s\S]*?)\n## /.exec(issue.body)?.[1] ?? "";
    const paths = [...occurrences.matchAll(/- `([^`]+):\d+/g)].map((match) => match[1] ?? "");
    if (paths.includes("README.md") && paths.includes("tests/handler.test.ts")) {
      occurrenceLayers = ["server", "client", "tests", "documentation"].filter(
        (layer) =>
          layer === "documentation" ||
          paths.some((path) => path.startsWith(`${layer}/`)),
      );
    }
  }
  check(
    [...pairs.values()].some((set) => set.size > 1),
    "no concept carries two separately filed violations",
    [...pairs.entries()],
  );
  check(
    [...categoriesAcross.values()].some((set) => set.size > 1),
    "one category never split across two concepts",
    [...categoriesAcross.entries()],
  );
  check(conflictReported, "no filed issue reports the glossary conflict");
  check(authorityReported, "no filed issue names the glossary authority");
  check(
    occurrenceLayers.length === 4,
    "no filed issue lists the occurrence in every layer",
    occurrenceLayers,
  );
  const found = occurrencesFor(repo, "order sum");
  check(
    [...found.keys()].sort().join(",") ===
      ["README.md", "client/summary.ts", "server/handler.ts", "tests/handler.test.ts"].join(","),
    "the independent search does not cover both layers",
    [...found.keys()],
  );
  console.log(
    `PASS filings=5 concepts=${JSON.stringify([...pairs.keys()])} ` +
      `categories=${JSON.stringify([...categoriesAcross.keys()])} ` +
      `labels=${JSON.stringify([CONSISTENT_NAMING_LABEL])} ` +
      `occurrence-layers=${occurrenceLayers.join(",")} ` +
      `both-layer=${JSON.stringify([...found.keys()].sort())} ` +
      "glossary=authority-and-conflict",
  );

  /* 8. The checkout is unchanged. */
  const statusAfter = git(["status", "--porcelain"]);
  const headAfter = git(["rev-parse", "HEAD"]);
  check(statusAfter === statusBefore, "the cycle changed git status", {
    statusBefore,
    statusAfter,
  });
  check(headAfter === headBefore, "the cycle moved HEAD", { headBefore, headAfter });
  const stateDocument = readState(
    versionedStatePath(stateDir, repo, readHarnessVersion(harnessRoot)),
  );
  check(stateDocument !== undefined, "the worker published no state");
  check(stateDocument.issues.length === 5, "the published rows are not the proved filings");
  check(
    stateDocument.issues.every((issue) => issue.category !== null),
    "a published row carries no category",
  );
  console.log(
    `PASS checkout-read-only gitStatus=${JSON.stringify(statusBefore)} ` +
      `head=${headBefore} rows=${stateDocument.issues.length}`,
  );

  /* 9. Stop ends the worker and leaves the settings and the filed rows. */
  ws.send(JSON.stringify({ type: "stopAgent", id: "consistent-naming" }));
  const stopped = await waitFor(
    () => {
      const state = readState(versionedStatePath(stateDir, repo, readHarnessVersion(harnessRoot)));
      return state !== undefined && state.lifecycle === "stopped" ? state : undefined;
    },
    "the consistent-naming worker to stop",
    30_000,
  );
  check(stopped.issues.length === 5, "Stop dropped the filed rows", stopped.issues.length);
  check(
    stopped.intervalMinutes === 30 && stopped.limits.maxPerHour === 10,
    "Stop dropped the saved settings",
    { intervalMinutes: stopped.intervalMinutes, limits: stopped.limits },
  );
  await waitFor(
    async () => ((await present(devtools!, "agent-start")) ? true : undefined),
    "Start to return after Stop",
    15_000,
  );
  check(
    (await text(devtools, "agent-count-consistent-naming")) === "5",
    "the sidebar count changed after Stop",
  );
  console.log(
    `PASS stop leaves rows=5 cadence=${stopped.intervalMinutes} ` +
      `limits=${stopped.limits.maxPerHour}/${stopped.limits.maxPending}`,
  );

  console.log(
    "verify:consistent-naming: family consistent-naming " +
      `entry=${seeded.path}:${seeded.line} seed=${seeded.seed} ` +
      "categories=" +
      CONSISTENT_NAMING_CATEGORIES.join(", "),
  );
  console.log("verify:consistent-naming: OK");
  ws.close();
} finally {
  devtools?.close();
  if (chromePid > 0) {
    try {
      process.kill(chromePid, "SIGTERM");
    } catch {
      // It already exited.
    }
  }
  if (dashboardPid > 0) {
    try {
      process.kill(dashboardPid, "SIGTERM");
    } catch {
      // It already exited.
    }
  }
  if (process.env.DEVBOARD_KEEP_FIXTURES === "1") {
    console.error(`verify-consistent-naming: kept ${root}`);
  } else {
    await rm(root, { recursive: true, force: true });
  }
}
