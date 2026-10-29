import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile as readBytes, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { journalFile } from "../server/journal";
import { agentRegistry } from "../server/agents/registry";
import { saveSubscriptions } from "../server/providers";
import { CoachActivity, preflightCoach } from "../server/coach";
import { coachDirectory } from "../coach/paths";
import { readCoachSettings, writeCoachSettings, DEFAULT_COACH_SETTINGS } from "../coach/settings";
import { readWorkerState, writeWorkerState } from "../coach/worker-state";
import { loadLedger } from "../coach/ledger";
import { readCoachStatus } from "../coach/status";
import { runCycle, COMMENT_INTERVAL_MS } from "../coach/coordinator";
import {
  analyzeEvidence,
  normalizeCommandSignature,
  isCovered,
  isTrivialCommand,
  type CoachFinding,
} from "../coach/findings";
import { MCP_COVERS } from "../mcp/catalog";
import { coachBody, coachTitle, ISSUE_BODY_MAX_BYTES } from "../coach/issue";
import { selectSessions } from "../lib/agent-sessions";
import type { CoachDelivery, DeliveryResult } from "../coach/delivery";
import type { GateRun } from "../coach/gate";
import { gateVerdict } from "../coach/gate";
import { parseDecisionsDocument } from "../coach/jev";
import { parseFinalizerAnswer } from "../coach/finalize";
import type { FinalizeResult } from "../coach/finalize";

const harnessRoot = resolve(import.meta.dir, "..");
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const directory = await mkdtemp(join(harnessRoot, ".tmp", "coach-"));
  directories.push(directory);
  return directory;
}

const NOW = new Date("2026-01-10T12:00:00.000Z");

function instant(minutesAgo: number, from = NOW): string {
  return new Date(from.getTime() - minutesAgo * 60_000).toISOString();
}

interface SessionSeed {
  id: string;
  startedAt: string;
  calls?: number;
  command?: string;
  errorText?: string;
  errors?: boolean;
}

async function writeSession(
  stateDir: string,
  repoDir: string,
  seed: SessionSeed,
): Promise<string> {
  const directory = join(stateDir, "providers", "agents", "fixture", "sessions", "bucket");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${seed.id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: seed.id, timestamp: seed.startedAt, cwd: repoDir }),
    JSON.stringify({ type: "title", v: 1, title: `session ${seed.id}`, updatedAt: seed.startedAt }),
  ];
  for (let index = 0; index < (seed.calls ?? 0); index += 1) {
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: seed.startedAt,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "bash",
              arguments: { command: seed.command ?? "echo fixture" },
            },
          ],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 1,
            cacheWrite: 0,
            totalTokens: 16,
            cost: { total: 0.01 },
          },
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        timestamp: seed.startedAt,
        message: {
          role: "toolResult",
          toolCallId: `call-${index}`,
          toolName: "bash",
          content: [{ type: "text", text: seed.errorText ?? "ok" }],
          isError: seed.errors === true,
        },
      }),
    );
  }
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

async function writeJournal(
  stateDir: string,
  repoDir: string,
  rows: Array<{ kind: string; text: string; scope: string; ts: string }>,
  suffix = "",
): Promise<void> {
  const path = `${journalFile(stateDir, repoDir)}${suffix}`;
  await mkdir(join(stateDir, "journal"), { recursive: true });
  const content = rows
    .map((row) => JSON.stringify({ repo: repoDir, port: 1, pid: 1, ...row }))
    .join("\n");
  await writeFile(path, `${content}\n`, { flag: "a" });
}

async function workspace(now = NOW): Promise<{ root: string; repoDir: string; stateDir: string }> {
  const root = await temporaryRoot();
  const repoDir = join(root, "checkout");
  const stateDir = join(root, "state");
  await mkdir(join(repoDir, ".devboard"), { recursive: true });
  await mkdir(join(repoDir, ".worktree", "task"), { recursive: true });
  await mkdir(coachDirectory(stateDir), { recursive: true });
  await writeFile(
    join(coachDirectory(stateDir), "projection.json"),
    `${JSON.stringify({
      version: 1,
      state: "ok",
      at: now.toISOString(),
      error: null,
      issues: [],
    })}\n`,
  );
  return { root, repoDir, stateDir };
}

async function directoryHash(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      hash.update(`d:${entry.name}:`);
      hash.update(await directoryHash(path));
    } else {
      hash.update(`f:${entry.name}:`);
      hash.update(await readBytes(path));
    }
  }
  return hash.digest("hex");
}

function memoryDelivery(): CoachDelivery & { created: Array<{ title: string; body: string }>; comments: string[] } {
  const created: Array<{ title: string; body: string }> = [];
  const comments: string[] = [];
  return {
    repository: "acme/fixture",
    created,
    comments,
    async create(title: string, body: string): Promise<DeliveryResult> {
      created.push({ title, body });
      return { ok: true, url: `https://forge.test/acme/fixture/issues/${created.length}` };
    },
    async comment(_url: string, body: string) {
      comments.push(body);
      return { ok: true };
    },
  };
}

/** The calls the stub forge recorded for one operation. */
async function stubCalls(
  directory: string,
  op: "create" | "comment",
): Promise<Array<{ title?: string; body: string }>> {
  const source = await readBytes(join(directory, "calls.jsonl"), "utf8");
  return source
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      const parsed = JSON.parse(line) as { op?: string; title?: string; body?: string };
      if (parsed.op !== op) return [];
      return [
        {
          ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
          body: typeof parsed.body === "string" ? parsed.body : "",
        },
      ];
    });
}

/** A gate that accepts every finding, for tests about everything downstream. */
function acceptingGate(): (findings: CoachFinding[]) => Promise<GateRun> {
  return async (findings) => ({
    ok: true,
    decisions: findings.map((finding) => ({
      finding,
      outcome: "accept" as const,
      probabilities: {
        existing_capability: 0.02,
        recurring_behavior: 0.97,
        worth_filing: 0.95,
      },
      model: "stub-decision",
    })),
    costUsd: 0,
  });
}

/** A finalizer that files every survivor with a stable recommendation. */
function filingFinalizer(): (survivors: CoachFinding[]) => Promise<FinalizeResult> {
  return async (survivors) => ({
    recommendations: new Map(
      survivors.map((finding) => [
        finding.fingerprint,
        {
          action: "file" as const,
          proposal: "Add the documented guardrail and keep the recorded behavior out of later runs.",
          acceptance: ["- [ ] The recorded behavior stops in the next run."],
        },
      ]),
    ),
    model: "stub-finalizer",
    durationMs: 0,
  });
}

/** A gate that answers one outcome for every finding. */
function fixedGate(outcome: "reject" | "review" | "error"): (findings: CoachFinding[]) => Promise<GateRun> {
  return async (findings) => ({
    ok: outcome !== "error",
    ...(outcome === "error" ? { reason: "Decisions API 503: unavailable" } : {}),
    decisions: findings.map((finding) => {
      const probabilities: Record<string, number> =
        outcome === "error"
          ? {}
          : { existing_capability: 0.95, recurring_behavior: 0.4, worth_filing: 0.5 };
      return {
        finding,
        outcome,
        probabilities,
        model: "stub-decision",
        ...(outcome === "error" ? { reason: "Decisions API 503: unavailable" } : {}),
      };
    }),
    costUsd: 0,
  });
}

describe("Coach registration and lifecycle", () => {
  test("the registry declares coach with its defaults", () => {
    expect(agentRegistry.ids()).toEqual(["scout", "watchdog", "design", "coach"]);
    const coach = agentRegistry.require("coach");
    expect(coach.label).toBe("Coach");
    expect(coach.scope).toBe("repository");
    expect(coach.cadence.defaultMinutes).toBe(60);
    expect(coach.limits.default).toEqual({ maxPerHour: 10, maxPending: 20 });
    expect(coach.detail.panel).toBe("cycles");
    expect(coach.tab.id).toBe("coach");
  });

  test("start reaches starting before the worker and running once its state exists", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    let spawned = 0;
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
      preflight: async () => ({ ok: true }),
      spawnWorker: (argv) => {
        spawned += 1;
        expect(argv).toContain(join(harnessRoot, "coach", "worker.ts"));
        writeWorkerState(coachDir, {
          version: 1,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          root: repoDir,
          stateDir,
          lifecycle: "running",
          enabled: true,
          harnessVersion: "test",
          argv,
          lastRunAt: null,
          nextRunAt: null,
          lastError: null,
          notice: null,
          updatedAt: new Date().toISOString(),
        });
        return process.pid;
      },
    });
    const pending = adapter.start();
    expect(adapter.snapshot().lifecycle).toBe("starting");
    const result = await pending;
    expect(result.ok).toBe(true);
    const running = adapter.snapshot();
    expect(running.lifecycle).toBe("running");
    expect(running.owned).toBe(true);
    expect(running.attached).toBe(true);
    expect(spawned).toBe(1);

    expect(adapter.stop().ok).toBe(true);
    expect(adapter.snapshot().lifecycle).toBe("stopping");
    writeWorkerState(coachDir, {
      ...readWorkerState(coachDir)!,
      lifecycle: "stopped",
      enabled: false,
    });
    const stopped = adapter.snapshot();
    expect(stopped.lifecycle).toBe("stopped");
    expect(stopped.owned).toBe(false);
    adapter.dispose();
  });

  test("a worker owned by another state directory is not commandable", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    writeWorkerState(coachDir, {
      version: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      root: repoDir,
      stateDir: join(stateDir, "elsewhere"),
      lifecycle: "running",
      enabled: true,
      harnessVersion: "test",
      argv: [],
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
      notice: null,
      updatedAt: new Date().toISOString(),
    });
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
      preflight: async () => ({ ok: true }),
      spawnWorker: () => undefined,
    });
    const snapshot = adapter.snapshot();
    expect(snapshot.lifecycle).toBe("running");
    expect(snapshot.owned).toBe(false);
    expect(snapshot.notice).toContain("another dashboard");
    const started = await adapter.start();
    expect(started.ok).toBe(true);
    expect(started.notice).toContain("another dashboard");
    expect(adapter.stop().ok).toBe(false);
    adapter.dispose();
  });

  test("a refused preflight writes no state, spawns nothing, and renders the error", async () => {
    const { repoDir, stateDir } = await workspace();
    let spawned = 0;
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
      preflight: async () => ({ ok: false, message: "missing prerequisite: no origin" }),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
    });
    const result = await adapter.start();
    expect(result.ok).toBe(false);
    expect(spawned).toBe(0);
    expect(existsSync(join(coachDirectory(stateDir), "worker.json"))).toBe(false);
    expect(adapter.snapshot().error).toContain("missing prerequisite");
    adapter.dispose();
  });

  test("cadence and limits persist, and an invalid value changes nothing", async () => {
    const { repoDir, stateDir } = await workspace();
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
    });
    expect(adapter.setSettings(30, 5, null).ok).toBe(true);
    expect(readCoachSettings(coachDirectory(stateDir))).toEqual({
      ...DEFAULT_COACH_SETTINGS,
      intervalMinutes: 30,
      maxPerHour: 5,
      maxPending: null,
    });
    expect(adapter.setSettings(0, 5, 5).ok).toBe(false);
    expect(adapter.setSettings(30, 101, 5).ok).toBe(false);
    expect(readCoachSettings(coachDirectory(stateDir)).intervalMinutes).toBe(30);
    adapter.dispose();
  });

  test("preflight names a GitLab origin as unsupported", async () => {
    const { repoDir } = await workspace();
    Bun.spawnSync({
      cmd: ["git", "init", "-q", repoDir],
      stdout: "ignore",
      stderr: "ignore",
    });
    Bun.spawnSync({
      cmd: ["git", "-C", repoDir, "remote", "add", "origin", "https://gitlab.example/acme/fixture.git"],
      stdout: "ignore",
      stderr: "ignore",
    });
    const result = await preflightCoach({ repoDir, environment: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("GitLab");
  });
});

describe("Coach decision gate", () => {
  const thresholds = { approveAt: 0.9, rejectAt: 0.1 };

  test("the negative question inverts the two thresholds", () => {
    expect(
      gateVerdict(
        { existing_capability: 0.05, recurring_behavior: 0.95, worth_filing: 0.92 },
        thresholds,
      ).outcome,
    ).toBe("accept");
    expect(
      gateVerdict(
        { existing_capability: 0.95, recurring_behavior: 0.95, worth_filing: 0.92 },
        thresholds,
      ).outcome,
    ).toBe("reject");
    expect(
      gateVerdict(
        { existing_capability: 0.05, recurring_behavior: 0.05, worth_filing: 0.92 },
        thresholds,
      ).outcome,
    ).toBe("reject");
    expect(
      gateVerdict(
        { existing_capability: 0.3, recurring_behavior: 0.95, worth_filing: 0.92 },
        thresholds,
      ).outcome,
    ).toBe("review");
  });

  test("a Decisions answer is validated before it can approve anything", () => {
    const questions = {
      existing_capability: { type: "noul" as const, instructions: "x" },
      recurring_behavior: { type: "noul" as const, instructions: "x" },
      worth_filing: { type: "noul" as const, instructions: "x" },
    };
    const document = (answers: Record<string, unknown>) => ({
      id: "gen-dec-1",
      model: "typesafe/jev-1.14",
      provider: "TypeSafe",
      usage: { cost: 0.00002, input_tokens: 100, output_tokens: 5 },
      answers,
    });
    const parsed = parseDecisionsDocument(
      document({
        existing_capability: { type: "noul", noul: 0.05 },
        recurring_behavior: { type: "noul", noul: 0.95 },
        worth_filing: { type: "noul", noul: 0.92 },
      }),
      questions,
    );
    expect(parsed.answers.worth_filing).toBe(0.92);
    expect(parsed.costUsd).toBe(0.00002);
    expect(() =>
      parseDecisionsDocument(
        document({
          existing_capability: { type: "noul", noul: 0.05 },
          recurring_behavior: { type: "noul", noul: 1.5 },
          worth_filing: { type: "noul", noul: 0.92 },
        }),
        questions,
      ),
    ).toThrow("did not answer");
    expect(() =>
      parseDecisionsDocument(document({ existing_capability: { type: "noul", noul: 0.05 } }), questions),
    ).toThrow("did not answer");
  });

  test("the finalizer must decide every survivor and name real duplicates", () => {
    const survivor = (fingerprint: string) =>
      ({
        category: "tool-gap" as const,
        fingerprint,
        line: `manual command repeated: ${fingerprint}`,
        subject: fingerprint,
        firstAt: NOW.toISOString(),
        lastAt: NOW.toISOString(),
        count: 3,
        sessions: ["a", "b"],
        scopes: [],
      });
    const [first, second] = [survivor("aaaaaaaaaaaaaaaa"), survivor("bbbbbbbbbbbbbbbb")];
    expect(() => parseFinalizerAnswer('{"decisions":[]}', [first!, second!])).toThrow(
      "did not decide",
    );
    expect(() =>
      parseFinalizerAnswer(
        JSON.stringify({
          decisions: [
            { fingerprint: first!.fingerprint, action: "file", proposal: "p", acceptance: ["- [ ] a"] },
            {
              fingerprint: second!.fingerprint,
              action: "drop",
              duplicate_of: "cccccccccccccccc",
            },
          ],
        }),
        [first!, second!],
      ),
    ).toThrow("unknown duplicate");
    const parsed = parseFinalizerAnswer(
      JSON.stringify({
        decisions: [
          { fingerprint: first!.fingerprint, action: "file", proposal: "p", acceptance: ["- [ ] a"] },
          { fingerprint: second!.fingerprint, action: "drop", duplicate_of: first!.fingerprint },
        ],
      }),
      [first!, second!],
    );
    expect(parsed.get(first!.fingerprint)?.action).toBe("file");
    expect(parsed.get(second!.fingerprint)?.duplicateOf).toBe(first!.fingerprint);
  });
});

describe("Coach detection", () => {
  test("finds every category at its threshold and no other", async () => {
    const { repoDir, stateDir } = await workspace();
    await writeSession(stateDir, repoDir, {
      id: "a",
      startedAt: instant(120),
      calls: 3,
      command: "./scripts/long-command --flag value",
      errorText: "ERROR: cannot find module xyz",
      errors: true,
    });
    await writeSession(stateDir, repoDir, {
      id: "b",
      startedAt: instant(60),
      calls: 1,
      command: "./scripts/long-command --flag value",
      errorText: "ERROR: cannot find module xyz",
      errors: true,
    });
    await writeSession(stateDir, repoDir, {
      id: "c",
      startedAt: instant(50),
      calls: 2,
      command: "./scripts/other-command --run",
      errorText: "different error",
      errors: true,
    });
    await writeJournal(stateDir, repoDir, [
      { kind: "question", text: "Should I rewrite it?", scope: "run-a", ts: instant(30) },
      { kind: "question", text: "Should I rewrite it?", scope: "run-b", ts: instant(20) },
      { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-a", ts: instant(30) },
      { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-b", ts: instant(20) },
    ]);
    const selected = selectSessions({ stateDir, repoDir });
    const journal = [
      { kind: "question", text: "Should I rewrite it?", scope: "run-a", ts: instant(30) },
      { kind: "question", text: "Should I rewrite it?", scope: "run-b", ts: instant(20) },
      { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-a", ts: instant(30) },
      { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-b", ts: instant(20) },
    ];
    const findings = analyzeEvidence({
      sessions: selected.sessions,
      journal,
      window: { start: instant(1440), end: NOW.toISOString() },
      repoDir,
    });
    expect(findings.map((finding) => finding.category)).toEqual([
      "repeat-question",
      "retry-loop",
      "run-failure",
      "tool-failure",
      "tool-gap",
    ]);
    expect(findings.find((finding) => finding.category === "tool-failure")?.count).toBe(4);
    expect(findings.find((finding) => finding.category === "retry-loop")?.sessions).toEqual(["a"]);
    expect(findings.find((finding) => finding.category === "tool-gap")?.count).toBe(4);
    expect(findings.find((finding) => finding.category === "tool-gap")?.subject).toBe(
      "./scripts/long-command --flag value",
    );
    for (const finding of findings) {
      expect(finding.line.length).toBeLessThanOrEqual(80);
      expect(finding.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test("below-threshold evidence produces no finding", async () => {
    const { repoDir, stateDir } = await workspace();
    await writeSession(stateDir, repoDir, {
      id: "one",
      startedAt: instant(10),
      calls: 2,
      command: "./scripts/repeat-command",
      errorText: "ERROR: unique",
      errors: true,
    });
    const selected = selectSessions({ stateDir, repoDir });
    expect(
      analyzeEvidence({
        sessions: selected.sessions,
        journal: [],
        window: { start: instant(1440), end: NOW.toISOString() },
        repoDir,
      }),
    ).toEqual([]);
  });

  test("two cycles over identical evidence with one clock produce identical findings", async () => {
    const { repoDir, stateDir } = await workspace();
    await writeSession(stateDir, repoDir, {
      id: "a",
      startedAt: instant(120),
      calls: 3,
      command: "some/manual/command --with args",
      errorText: "ERROR: same",
      errors: true,
    });
    await writeSession(stateDir, repoDir, {
      id: "b",
      startedAt: instant(60),
      calls: 1,
      command: "some/manual/command --with args",
      errorText: "ERROR: same",
      errors: true,
    });
    const options = {
      repoDir,
      window: { start: instant(1440), end: NOW.toISOString() },
      journal: [],
    };
    const first = analyzeEvidence({ ...options, sessions: selectSessions({ stateDir, repoDir }).sessions });
    const second = analyzeEvidence({
      ...options,
      sessions: selectSessions({ stateDir, repoDir }).sessions,
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("a command covered by the MCP catalog produces no tool-gap finding", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: "bun run verify:mcp",
      });
    }
    const selected = selectSessions({ stateDir, repoDir });
    const findings = analyzeEvidence({
      sessions: selected.sessions,
      journal: [],
      window: { start: instant(1440), end: NOW.toISOString() },
      repoDir,
      covers: MCP_COVERS,
    });
    expect(findings.filter((finding) => finding.category === "tool-gap")).toEqual([]);
    expect(isCovered("bun run verify:mcp", ["bun run verify:mcp"])).toBe(true);
    expect(normalizeCommandSignature(`cd ${repoDir}/.worktree/x && ls 1234567890`, repoDir)).toBe(
      "ls <hex>",
    );
    expect(normalizeCommandSignature(`DEVBOARD_GITEA_URL=x ${repoDir}/bin/tool --run`, repoDir)).toBe(
      "<env> <repo>/bin/tool --run",
    );
    expect(isTrivialCommand("git status --short --branch")).toBe(true);
    expect(isTrivialCommand("git worktree list")).toBe(true);
    expect(isTrivialCommand("git push origin main")).toBe(false);
  });
});

describe("Coach issue bytes and filing", () => {
  test("title and body carry one line and exactly four sections", async () => {
    const { repoDir, stateDir } = await workspace();
    await writeSession(stateDir, repoDir, {
      id: "a",
      startedAt: instant(30),
      calls: 3,
      command: "./scripts/one-command --x",
      errorText: "## not a section\nERROR: bad",
      errors: true,
    });
    await writeSession(stateDir, repoDir, {
      id: "b",
      startedAt: instant(20),
      calls: 1,
      command: "./scripts/one-command --x",
      errorText: "## not a section\nERROR: bad",
      errors: true,
    });
    const selected = selectSessions({ stateDir, repoDir });
    const findings = analyzeEvidence({
      sessions: selected.sessions,
      journal: [],
      window: { start: instant(1440), end: NOW.toISOString() },
      repoDir,
    });
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      const title = coachTitle(finding);
      expect(title.split("\n")).toHaveLength(1);
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title.startsWith(`[coach] ${finding.category}: `)).toBe(true);
      const body = coachBody({
        finding,
        evidence: {
          window: { start: instant(1440), end: NOW.toISOString() },
          sessions: new Map(selected.sessions.map((session) => [session.id, session])),
          scopes: new Map(),
          repoDir,
        },
        recommendation: {
          proposal: "Add the documented guardrail to the implementation prompt.",
          acceptance: ["- [ ] The recorded behavior stops in the next run."],
        },
      });
      for (const section of ["## Finding", "## Evidence", "## Proposed change", "## Acceptance criteria"]) {
        expect(body.split(section).length - 1).toBe(1);
      }
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(ISSUE_BODY_MAX_BYTES);
      expect(body).toContain("- [ ]");
    }
  });

  test("finalizer prose cannot open a fifth section or hide a criterion", () => {
    const finding: CoachFinding = {
      category: "tool-gap",
      fingerprint: "aaaaaaaaaaaaaaaa",
      line: "manual command repeated: ./scripts/thing --flag",
      subject: "./scripts/thing --flag",
      firstAt: NOW.toISOString(),
      lastAt: NOW.toISOString(),
      count: 3,
      sessions: ["a", "b"],
      scopes: [],
    };
    const body = coachBody({
      finding,
      evidence: {
        window: { start: instant(1440), end: NOW.toISOString() },
        sessions: new Map(),
        scopes: new Map(),
        repoDir: "/repo",
      },
      recommendation: {
        proposal: "## Injected heading\nAdd the documented guardrail.",
        acceptance: ["- [ ] first line\nsecond line"],
      },
    });
    for (const section of ["## Finding", "## Evidence", "## Proposed change", "## Acceptance criteria"]) {
      expect(body.split(section).length - 1).toBe(1);
    }
    expect(body).toContain("- [ ] first line second line");
  });

  test("a first cycle files once, a second files nothing, and a recurrence comments", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: `./scripts/${id}-manual-command --go`,
        errorText: "ERROR: shared",
        errors: true,
      });
    }
    await writeJournal(stateDir, repoDir, [
      { kind: "question", text: "Same question?", scope: "run-a", ts: instant(30) },
      { kind: "question", text: "Same question?", scope: "run-b", ts: instant(20) },
    ]);
    const delivery = memoryDelivery();
    const first = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
    });
    expect(first.report.action).toBe("filed");
    expect(first.report.findings.map((finding) => finding.category)).toContain("repeat-question");
    expect(first.report.issues.length).toBe(delivery.created.length);
    const before = await directoryHash(join(stateDir, "providers"));
    const journalBefore = await directoryHash(join(stateDir, "journal"));
    const second = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
    });
    expect(second.report.action).toBe("duplicate");
    expect(delivery.created.length).toBe(first.report.issues.length);
    expect(await directoryHash(join(stateDir, "providers"))).toBe(before);
    expect(await directoryHash(join(stateDir, "journal"))).toBe(journalBefore);

    // A recurrence needs the same evidence inside the next window.
    await writeSession(stateDir, repoDir, {
      id: "late-a",
      startedAt: instant(60, new Date(NOW.getTime() + COMMENT_INTERVAL_MS)),
      calls: 3,
      command: "./scripts/a-manual-command --go",
      errorText: "ERROR: shared",
      errors: true,
    });
    await writeSession(stateDir, repoDir, {
      id: "late-b",
      startedAt: instant(50, new Date(NOW.getTime() + COMMENT_INTERVAL_MS)),
      calls: 3,
      command: "./scripts/b-manual-command --go",
      errorText: "ERROR: shared",
      errors: true,
    });
    await writeJournal(stateDir, repoDir, [
      {
        kind: "question",
        text: "Same question?",
        scope: "run-a",
        ts: instant(40, new Date(NOW.getTime() + COMMENT_INTERVAL_MS)),
      },
      {
        kind: "question",
        text: "Same question?",
        scope: "run-b",
        ts: instant(30, new Date(NOW.getTime() + COMMENT_INTERVAL_MS)),
      },
    ]);
    const later = new Date(NOW.getTime() + COMMENT_INTERVAL_MS + 60 * 60_000);
    const recurrence = await runCycle({
      root: repoDir,
      stateDir,
      now: later,
      delivery,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
    });
    expect(recurrence.report.action).not.toBe("failed");
    expect(delivery.comments.length).toBeGreaterThan(0);
    expect(delivery.created.length).toBe(first.report.issues.length + 2);
  });

  test("a registered provider key echoed in evidence never reaches the forge", async () => {
    const { root, repoDir, stateDir } = await workspace();
    const key = "provider-store-only-key-0001";
    const stamp = new Date().toISOString();
    saveSubscriptions(stateDir, [
      {
        id: "openrouter-fixture",
        provider: "openrouter",
        label: "Fixture",
        key,
        enabled: true,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ]);
    const forge = join(root, "forge");
    const environment = { DEVBOARD_COACH_FORGE_STUB: forge };
    const leak = (id: string, startedAt: string): Promise<string> =>
      writeSession(stateDir, repoDir, {
        id,
        startedAt,
        calls: 1,
        errorText: `ERROR: printed ${key}`,
        errors: true,
      });
    await leak("a", instant(30));
    await leak("b", instant(20));
    const first = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      environment,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
    });
    expect(first.report.action).toBe("filed");
    expect(first.report.issues.length).toBeGreaterThan(0);
    const created = await stubCalls(forge, "create");
    expect(created.length).toBe(first.report.issues.length);
    const assertRedacted = (text: string): void => {
      expect(text).toContain("<redacted>");
      expect(text).not.toContain(key);
      expect(text).not.toContain(key.slice(0, 12));
    };
    for (const call of created) {
      assertRedacted(call.title ?? "");
      assertRedacted(call.body);
    }

    const later = new Date(NOW.getTime() + COMMENT_INTERVAL_MS + 60 * 60_000);
    await leak("late-a", instant(30, later));
    await leak("late-b", instant(20, later));
    const recurrence = await runCycle({
      root: repoDir,
      stateDir,
      now: later,
      environment,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
    });
    expect(recurrence.report.action).not.toBe("failed");
    const comments = await stubCalls(forge, "comment");
    expect(comments.length).toBeGreaterThan(0);
    for (const call of comments) assertRedacted(call.body);
  });

  test("caps keep excess fingerprints pending and never file without a projection", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 3,
        command: `./scripts/${id}-capped-command --run`,
        errorText: "ERROR: capped",
        errors: true,
      });
    }
    await writeCoachSettings(coachDirectory(stateDir), {
      ...DEFAULT_COACH_SETTINGS,
      intervalMinutes: 60,
      maxPerHour: 1,
      maxPending: 1,
    });
    await rm(join(coachDirectory(stateDir), "projection.json"), { force: true });
    const delivery = memoryDelivery();
    const capped = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
    });
    expect(capped.report.action).toBe("capped");
    expect(delivery.created.length).toBe(0);
    expect(capped.report.pending).toBeGreaterThan(0);

    await mkdir(coachDirectory(stateDir), { recursive: true });
    await writeFile(
      join(coachDirectory(stateDir), "projection.json"),
      JSON.stringify({ version: 1, state: "ok", at: NOW.toISOString(), error: null, issues: [] }),
    );
    const filed = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
    });
    expect(filed.report.action).toBe("filed");
    expect(delivery.created.length).toBeLessThanOrEqual(1);
    const ledger = loadLedger(coachDirectory(stateDir));
    expect(ledger.pendingFiling.length).toBeGreaterThan(0);
    expect(Object.values(ledger.findings).filter((entry) => entry.disposition.startsWith("filed:")).length).toBeLessThanOrEqual(1);
    expect(readCoachStatus(coachDirectory(stateDir)).pending).toBeGreaterThan(0);
  });

  test("a failed filing stays pending and records the reason", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: `./scripts/${id}-failing-command`,
        errorText: "ERROR: filing",
        errors: true,
      });
    }
    const delivery: CoachDelivery = {
      repository: "acme/fixture",
      create: async () => ({ ok: false, reason: "forge rejected the issue" }),
      comment: async () => ({ ok: false, reason: "forge rejected the comment" }),
    };
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
    });
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toContain("forge rejected");
    const ledger = loadLedger(coachDirectory(stateDir));
    expect(ledger.pendingFiling.length).toBeGreaterThan(0);
    const reasons = Object.values(ledger.findings)
      .map((entry) => entry.reason)
      .filter((reason) => reason !== undefined);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]).toContain("forge rejected");
  });

  test("a cycle with injected seams spawns no peer and writes only the coach directory", async () => {
    const { root, repoDir, stateDir } = await workspace();
    await writeSession(stateDir, repoDir, {
      id: "a",
      startedAt: instant(30),
      calls: 3,
      command: "./scripts/no-spawn-command",
      errorText: "ERROR: no spawn",
      errors: true,
    });
    await writeSession(stateDir, repoDir, {
      id: "b",
      startedAt: instant(20),
      calls: 1,
      command: "./scripts/no-spawn-command",
      errorText: "ERROR: no spawn",
      errors: true,
    });
    const marker = join(root, "spawned");
    const stubAgent = join(root, "stub-agent");
    await writeFile(stubAgent, `#!/bin/sh\necho spawned > ${JSON.stringify(marker)}\nexit 1\n`);
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      finalize: filingFinalizer(),
      environment: { AGENT_COMMAND: stubAgent, PATH: process.env.PATH ?? "" },
    });
    expect(result.report.action).toBe("filed");
    expect(existsSync(marker)).toBe(false);
    const written = await readdir(stateDir);
    expect(written.sort()).toEqual(["coach", "providers"]);
  });

  test("a rejected finding is not filed and re-gates only after its cool-down", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: `./scripts/${id}-rejected-command`,
        errorText: "ERROR: rejected",
        errors: true,
      });
    }
    const delivery = memoryDelivery();
    const first = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: fixedGate("reject"),
      finalize: async () => {
        throw new Error("the finalizer must not run for a rejected finding");
      },
    });
    expect(first.report.action).toBe("rejected");
    expect(delivery.created.length).toBe(0);
    expect(first.report.gate?.rejected).toBeGreaterThan(0);
    const ledger = loadLedger(coachDirectory(stateDir));
    const rejected = Object.values(ledger.findings).filter(
      (entry) => entry.disposition === "rejected",
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.decision?.probabilities.existing_capability).toBe(0.95);
    expect(rejected[0]?.decision?.rejectedUntil).toBeDefined();

    // Inside the cool-down the same evidence asks the gate nothing.
    let calls = 0;
    const second = await runCycle({
      root: repoDir,
      stateDir,
      now: new Date(NOW.getTime() + 60 * 60_000),
      delivery,
      gate: async (findings) => {
        calls += findings.length;
        return acceptingGate()(findings);
      },
      finalize: filingFinalizer(),
    });
    expect(calls).toBe(0);
    expect(second.report.action).toBe("duplicate");
    expect(delivery.created.length).toBe(0);

    // After the cool-down the same fingerprint is asked again.
    const after = new Date(
      NOW.getTime() + (DEFAULT_COACH_SETTINGS.rejectCooldownHours + 1) * 60 * 60_000,
    );
    for (const id of ["late-a", "late-b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "late-a" ? 40 : 30, after),
        calls: 2,
        command: `./scripts/${id.replace("late-", "")}-rejected-command`,
        errorText: "ERROR: rejected",
        errors: true,
      });
    }
    calls = 0;
    const third = await runCycle({
      root: repoDir,
      stateDir,
      now: after,
      delivery,
      gate: async (findings) => {
        calls += findings.length;
        return fixedGate("reject")(findings);
      },
      finalize: filingFinalizer(),
    });
    expect(calls).toBeGreaterThan(0);
    expect(third.report.action).toBe("rejected");
  });

  test("an ambiguous answer rejects the finding and flags it in the report", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: `./scripts/${id}-review-command`,
        errorText: "ERROR: review",
        errors: true,
      });
    }
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: fixedGate("review"),
      finalize: filingFinalizer(),
    });
    expect(result.report.action).toBe("rejected");
    expect(delivery.created.length).toBe(0);
    expect(result.report.decisions.every((decision) => decision.outcome === "review")).toBe(true);
    expect(result.report.gate?.review).toBeGreaterThan(0);
    const ledger = loadLedger(coachDirectory(stateDir));
    expect(
      Object.values(ledger.findings).some(
        (entry) => entry.decision?.outcome === "review" && entry.disposition === "rejected",
      ),
    ).toBe(true);
  });

  test("a gate failure files nothing and keeps every finding pending", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: `./scripts/${id}-gate-failure`,
        errorText: "ERROR: gate",
        errors: true,
      });
    }
    const delivery = memoryDelivery();
    let finalized = 0;
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: fixedGate("error"),
      finalize: async (survivors) => {
        finalized += survivors.length;
        return filingFinalizer()(survivors);
      },
    });
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toContain("Decisions API");
    expect(delivery.created.length).toBe(0);
    expect(finalized).toBe(0);
    expect(result.report.pending).toBeGreaterThan(0);
    const ledger = loadLedger(coachDirectory(stateDir));
    expect(ledger.pendingFiling.length).toBeGreaterThan(0);
  });

  test("the finalizer deduplicates survivors and the duplicate stays unfiled", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: "./scripts/duplicate-command --one",
        errorText: "ERROR: duplicate",
        errors: true,
      });
      await writeSession(stateDir, repoDir, {
        id: `${id}-two`,
        startedAt: instant(id === "a" ? 25 : 15),
        calls: 2,
        command: "./scripts/duplicate-command --two",
        errorText: "ERROR: duplicate",
        errors: true,
      });
    }
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      finalize: async (survivors) => {
        const [first, ...rest] = survivors;
        const recommendations = new Map<
          string,
          { action: "file" | "drop"; proposal: string; acceptance: string[]; duplicateOf?: string }
        >();
        recommendations.set(first!.fingerprint, {
          action: "file",
          proposal: "Add one documented guardrail for the duplicated behavior.",
          acceptance: ["- [ ] The duplicated behavior stops."],
        });
        for (const finding of rest) {
          recommendations.set(finding.fingerprint, {
            action: "drop",
            proposal: "",
            acceptance: [],
            duplicateOf: first!.fingerprint,
          });
        }
        return { recommendations, model: "stub-finalizer", durationMs: 0 };
      },
    });
    expect(result.report.action).toBe("filed");
    expect(delivery.created.length).toBe(1);
    expect(result.report.gate?.dropped).toBeGreaterThan(0);
    const ledger = loadLedger(coachDirectory(stateDir));
    expect(
      Object.values(ledger.findings).some(
        (entry) => entry.decision?.reason?.startsWith("duplicate of"),
      ),
    ).toBe(true);
  });

  test("a finalizer peer that elicits once still files the accepted findings", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: `./scripts/${id}-denied-elicitation`,
        errorText: "ERROR: denied elicitation",
        errors: true,
      });
    }
    const providerDir = join(stateDir, "providers");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      join(providerDir, "credentials.json"),
      `${JSON.stringify({
        version: 1,
        subscriptions: [
          {
            id: "fixture-opencode",
            provider: "opencode-go",
            label: "Fixture",
            key: "sk-fixture",
            enabled: true,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
        ],
      })}\n`,
    );
    const probe = join(stateDir, "finalizer-answer.json");
    const peer = join(harnessRoot, "tests", "fixtures", "finalizer-elicitation-acp.ts");
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      environment: {
        AGENT_COMMAND: `${process.execPath} ${peer}`,
        COACH_FINALIZER_ANSWER: probe,
        PATH: process.env.PATH ?? "",
      },
    });
    expect(result.report.action).toBe("filed");
    expect(delivery.created.length).toBeGreaterThan(0);
    expect(JSON.parse(await readBytes(probe, "utf8"))).toEqual({ action: "cancel" });
  });

  test("an invalid finalizer answer files nothing", async () => {
    const { repoDir, stateDir } = await workspace();
    for (const id of ["a", "b"]) {
      await writeSession(stateDir, repoDir, {
        id,
        startedAt: instant(id === "a" ? 30 : 20),
        calls: 2,
        command: `./scripts/${id}-invalid-final`,
        errorText: "ERROR: invalid finalizer",
        errors: true,
      });
    }
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      delivery,
      gate: acceptingGate(),
      finalize: async () => {
        throw new Error("the finalizer returned invalid JSON");
      },
    });
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toContain("finalizer");
    expect(delivery.created.length).toBe(0);
    expect(result.report.pending).toBeGreaterThan(0);
  });

  test("read tools leave evidence bytes identical", async () => {
    const { repoDir, stateDir } = await workspace();
    await writeSession(stateDir, repoDir, {
      id: "a",
      startedAt: instant(30),
      calls: 1,
      command: "echo stable",
    });
    const beforeSessions = await directoryHash(join(stateDir, "providers"));
    const beforeStatus = readCoachStatus(coachDirectory(stateDir));
    expect(beforeStatus.pending).toBe(0);
    expect(await directoryHash(join(stateDir, "providers"))).toBe(beforeSessions);
  });
});
