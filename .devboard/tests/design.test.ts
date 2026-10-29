import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAudit, readAuditInput, type DesignFinding } from "../issues/design/audit";
import { issueBody } from "../issues/design/actions";
import { createDesignForge } from "../issues/design/forge";
import { preflightDesign } from "../issues/design/preflight";
import { releaseDocuments, type RunCommand } from "../issues/design/release";
import { capacityFor, writeSettings, type DesignIssueRow } from "../issues/design/state";
import { DesignWorker } from "../issues/design/worker";
import { designConfig, settingsPath } from "../issues/design/paths";

const harnessRoot = join(import.meta.dir, "..");
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

function editDecision(): Record<string, unknown> {
  return {
    findings: [],
    documentation: {
      decision: "edit",
      summary: "Document the accent standard",
      rationale: "Two interface surfaces share the same token.",
      surfaces: [".devboard/client/App.svelte", ".devboard/client/index.html"],
      contradiction: false,
      evidence: [],
      addsTokens: [],
    },
  };
}

describe("design audit input and answer", () => {
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

  test("accepts a category finding and drops invalid ones with reasons", async () => {
    const { repo, config } = await fixture("parse");
    const input = readAuditInput(repo, config);
    const parsed = parseAudit(
      {
        findings: [
          finding(),
          { ...finding(), category: "performance", title: "Backend cache" },
          { ...finding(), title: "Wrong quote", evidence: [{ ...finding().evidence[0], quote: "nope" }] },
          { ...finding(), title: "Already known" },
        ],
        documentation: { decision: "none" },
      },
      { input, knownTitles: ["already known"] },
    );
    expect(parsed.findings.map((entry) => entry.title)).toEqual([finding().title]);
    expect(parsed.dropped.map((entry) => entry.title)).toContain("Backend cache");
    expect(parsed.dropped).toHaveLength(3);
    expect(parsed.documentation).toEqual({ decision: "none" });
  });

  test("requires two surfaces or a document contradiction for an edit", async () => {
    const { repo, config } = await fixture("decision");
    const input = readAuditInput(repo, config);
    const base = {
      findings: [],
      documentation: {
        decision: "edit",
        summary: "Document the accent standard",
        rationale: "Two surfaces use it.",
        surfaces: [".devboard/client/App.svelte"],
        contradiction: false,
        evidence: [],
        addsTokens: [],
      },
    };
    const refused = parseAudit(base, { input, knownTitles: [] });
    expect(refused.documentation).toEqual({ decision: "none" });
    expect(refused.documentationError).toContain("two distinct interface surfaces");

    const contradicted = parseAudit(
      {
        ...base,
        documentation: {
          ...base.documentation,
          contradiction: true,
          evidence: ["Use tokens for every color."],
        },
      },
      { input, knownTitles: [] },
    );
    expect(contradicted.documentation.decision).toBe("edit");

    const two = parseAudit(
      {
        ...base,
        documentation: {
          ...base.documentation,
          surfaces: [".devboard/client/App.svelte", ".devboard/client/index.html"],
        },
      },
      { input, knownTitles: [] },
    );
    expect(two.documentation.decision).toBe("edit");
  });

  test("never legalizes a drift the same cycle reports", async () => {
    const { repo, config } = await fixture("drift");
    const input = readAuditInput(repo, config);
    const drift: DesignFinding = { ...finding(), token: { name: "accent", value: "#58a6ff" } };
    const parsed = parseAudit(
      {
        findings: [drift],
        documentation: {
          decision: "edit",
          summary: "Add accent",
          rationale: "Two surfaces.",
          surfaces: [".devboard/client/App.svelte", ".devboard/client/index.html"],
          contradiction: false,
          evidence: [],
          addsTokens: ["accent"],
        },
      },
      { input, knownTitles: [] },
    );
    expect(parsed.documentation).toEqual({ decision: "none" });
    expect(parsed.documentationError).toContain("legalize");
    expect(parsed.findings).toHaveLength(1);
  });

  test("the issue body carries category, standard, evidence, files, and criteria", () => {
    const body = issueBody(finding());
    expect(body).toContain("## Category\n\ncolor");
    expect(body).toContain("Use tokens for every color");
    expect(body).toContain("`.devboard/client/App.svelte:2`");
    expect(body).toContain('> const accent = "#58a6ff";');
    expect(body).toContain("- `.devboard/client/App.svelte`");
    expect(body).toContain("## Proposed change");
    expect(body).toContain("- App.svelte contains no hardcoded color literal.");
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
  write: (directory: string) => void,
  counter: { connects: number },
): FakePeer {
  return {
    peer: {
      pid: undefined,
      argv: [],
      async run(prompt: string) {
        counter.connects += 1;
        write(prompt.slice("/design-system-audit ".length));
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

describe("design worker", () => {
  test("files a valid finding, records activity, and skips the release on no decision", async () => {
    const { repo, stateDir } = await fixture("worker");
    const filed: Array<{ title: string; url: string }> = [];
    const counter = { connects: 0 };
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => [],
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async (options) => {
        filed.push({ title: options.finding.title, url: "https://forge.test/acme/fixture/issues/7" });
        return { number: 7, url: "https://forge.test/acme/fixture/issues/7" };
      },
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "https://forge.test/released", sha: "a", branch: "b" };
      },
      connect: () =>
        fakePeer((directory) => {
          writeFileSync(
            join(directory, "audit.json"),
            JSON.stringify({ findings: [finding()], documentation: { decision: "none" } }),
          );
        }, counter).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(filed.map((entry) => entry.title)).toEqual([finding().title]);
    expect(released).toBe(0);
    expect(worker.currentState.issues[0]?.number).toBe(7);
    expect(worker.currentState.release).toBeNull();
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("filed #7");
    await worker.stop();
  });

  test("a single flight never starts a second cycle", async () => {
    const { repo, stateDir } = await fixture("single-flight");
    const counter = { connects: 0 };
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => [],
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async () => ({ number: 1, url: "https://forge.test/issues/1" }),
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b" }),
      connect: () =>
        fakePeer((directory) => {
          writeFileSync(
            join(directory, "audit.json"),
            JSON.stringify({ findings: [], documentation: { decision: "none" } }),
          );
        }, counter).peer as never,
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
    const filed: string[] = [];
    let now = new Date("2026-03-01T12:00:00.000Z");
    const audit = Promise.withResolvers<void>();
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      now: () => now,
      github: {
        listIssues: async () => [],
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async (options) => {
        filed.push(options.finding.title);
        return { number: 7, url: "https://forge.test/acme/fixture/issues/7" };
      },
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b" }),
      connect: () => ({
        pid: undefined,
        argv: [],
        async run(prompt: string) {
          await audit.promise;
          writeFileSync(
            join(prompt.slice("/design-system-audit ".length), "audit.json"),
            JSON.stringify({ findings: [finding()], documentation: { decision: "none" } }),
          );
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
    expect(filed).toEqual([finding().title]);
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).not.toContain("skipped filing");
    await worker.stop();
  });

  test("a failed forge read still skips filing and records why", async () => {
    const { repo, stateDir } = await fixture("read-failure");
    const filed: string[] = [];
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => {
          throw new Error("the forge read was refused");
        },
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async (options) => {
        filed.push(options.finding.title);
        return { number: 1, url: "https://forge.test/issues/1" };
      },
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b" }),
      connect: () =>
        fakePeer((directory) => {
          writeFileSync(
            join(directory, "audit.json"),
            JSON.stringify({ findings: [finding()], documentation: { decision: "none" } }),
          );
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    expect(worker.currentState.sync.error).not.toBeNull();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(filed).toEqual([]);
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("skipped filing");
    await worker.stop();
  });

  test("a malformed audit files nothing and records the reason", async () => {
    const { repo, stateDir } = await fixture("bad-audit");
    const filed: string[] = [];
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => [],
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async (options) => {
        filed.push(options.finding.title);
        return { number: 1, url: "https://forge.test/issues/1" };
      },
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b" }),
      connect: () =>
        fakePeer((directory) => {
          writeFileSync(join(directory, "audit.json"), "{ not json");
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(filed).toEqual([]);
    expect(worker.currentState.issues).toEqual([]);
    expect(worker.currentState.lastError).toContain("not valid JSON");
    await worker.stop();
  });

  test("a draft change without an admissible decision is not released", async () => {
    const { repo, stateDir } = await fixture("bless-drift");
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => [],
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async () => ({ number: 1, url: "https://forge.test/issues/1" }),
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b" };
      },
      connect: () =>
        fakePeer((directory) => {
          const draft = join(directory, "draft", "DESIGN.md");
          writeFileSync(draft, "legalized drift\n");
          writeFileSync(
            join(directory, "audit.json"),
            JSON.stringify({ findings: [], documentation: { decision: "none" } }),
          );
        }, { connects: 0 }).peer as never,
    });
    expect(worker.start("acme/fixture")).toBe(true);
    await worker.refresh();
    await worker.beginCycle();
    await worker.waitForCycle();
    expect(released).toBe(0);
    expect(readFileSync(join(repo, "DESIGN.md"), "utf8")).toContain("Use tokens for every color");
    await worker.stop();
  });

  test("a rejecting release settles the cycle, records the failure, and a later cycle runs", async () => {
    const { repo, stateDir } = await fixture("release-throws");
    const counter = { connects: 0 };
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => [],
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async () => ({ number: 1, url: "https://forge.test/issues/1" }),
      release: async () => {
        released += 1;
        throw new Error("boom");
      },
      connect: () =>
        fakePeer((directory) => {
          writeFileSync(
            join(directory, "draft", "DESIGN.md"),
            `${readFileSync(join(directory, "draft", "DESIGN.md"), "utf8")}\n- One accent token.\n`,
          );
          writeFileSync(join(directory, "audit.json"), JSON.stringify(editDecision()));
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

    await worker.beginCycle();
    await worker.waitForCycle();
    expect(counter.connects).toBe(2);
    await worker.stop();
  });

  test("a missing draft document fails the cycle instead of rejecting it", async () => {
    const { repo, stateDir } = await fixture("missing-draft");
    const counter = { connects: 0 };
    let released = 0;
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => [],
        listReleases: async () => [],
        listOpenIssueTitles: async () => [],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async () => ({ number: 1, url: "https://forge.test/issues/1" }),
      release: async () => {
        released += 1;
        return { ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b" };
      },
      connect: () =>
        fakePeer((directory) => {
          writeFileSync(
            join(directory, "draft", "DESIGN.md"),
            `${readFileSync(join(directory, "draft", "DESIGN.md"), "utf8")}\n- One accent token.\n`,
          );
          rmSync(join(directory, "draft", "design", "tokens.json"));
          writeFileSync(join(directory, "audit.json"), JSON.stringify(editDecision()));
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

  test("a zero room files nothing and records each skipped finding", async () => {
    const { repo, stateDir } = await fixture("zero-room");
    const filed: string[] = [];
    const worker = new DesignWorker({
      repoDir: repo,
      stateDir,
      cadenceMs: 60 * 60_000,
      syncMs: 10_000,
      manualCycles: true,
      github: {
        listIssues: async () => [
          {
            number: 1,
            title: "existing open design issue",
            url: "https://forge.test/acme/fixture/issues/1",
            state: "open",
            createdAt: new Date().toISOString(),
            body: "",
          },
        ],
        listReleases: async () => [],
        listOpenIssueTitles: async () => ["existing open design issue"],
        closingCommit: async () => null,
        resolveCommit: async () => null,
        containingReleaseTags: async () => [],
      },
      fileIssue: async (options) => {
        filed.push(options.finding.title);
        return { number: 2, url: "https://forge.test/acme/fixture/issues/2" };
      },
      release: async () => ({ ok: true, version: "0.1.9", url: "u", sha: "a", branch: "b" }),
      connect: () =>
        fakePeer((directory) => {
          writeFileSync(
            join(directory, "audit.json"),
            JSON.stringify({ findings: [finding()], documentation: { decision: "none" } }),
          );
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
    expect(filed).toEqual([]);
    const cycleId = worker.currentState.newestCycleId!;
    const activity = readFileSync(
      join(repo, ".devboard", ".tmp", "design", "cycles", cycleId, "activity.json"),
      "utf8",
    );
    expect(activity).toContain("cap leaves no room");
    await worker.stop();
  });
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

    const noLabel = await preflightDesign({
      repoDir: repo,
      stateDir,
      config,
      environment,
      giteaFetch: ((input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/repos/acme/fixture")) {
          return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 });
        }
        return new Response(JSON.stringify([{ id: 1, name: "scout" }]), { status: 200 });
      }) as never,
      origin: { forge: "gitea", host: "forge.test", project: "acme/fixture" },
    });
    expect(noLabel.ok).toBe(false);
    if (!noLabel.ok) expect(noLabel.message).toContain('"design" label');

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
    expect(result.version).toBe("0.1.2");
    expect(published).toHaveLength(1);
    expect(published[0]?.version).toBe("0.1.2");
    const bareHead = run("git", ["--git-dir", bare, "rev-parse", "main"]);
    expect(bareHead).toBe(result.sha);
    const bareFiles = run("git", ["--git-dir", bare, "show", "--name-only", "--format=", "main"]);
    expect(bareFiles.split("\n").sort()).toEqual(["DESIGN.md", "design/tokens.json"].sort());
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
        if (argv.includes("commit") && argv.some((value) => value.startsWith("design:"))) {
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
    expect(run("git", ["--git-dir", bare, "log", "-1", "--format=%s", "main"])).toContain("design:");
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
    expect(run("git", ["--git-dir", bare, "log", "-1", "--format=%s", "main"])).toContain("design:");
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
