import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { journalFile } from "../server/journal";
import { agentRegistry } from "../server/agents/registry";
import { saveSubscriptions, writeSelectionSnapshot } from "../server/providers";
import { OPENCODE_GO_MODEL } from "../server/providers/catalog";
import { openCodePeers } from "../coach/providers";
import { CoachActivity, preflightCoach } from "../server/coach";
import type { ForgeIssueReader } from "../server/agents/forge-reader";
import {
  coachDirectory,
  controlDirectory,
  cycleLockPath,
  lockPath,
  versionedControlDirectory,
  versionedLockPath,
  versionedWorkerDirectory,
} from "../coach/paths";
import { writeCoachCommand, takeCoachCommands } from "../coach/control";
import { runWorker, CYCLE_BUSY_NOTICE } from "../coach/worker";
import { liveLockOwner } from "../issues/lock";
import { readHarnessVersion } from "../server/version";
import {
  DEFAULT_COACH_SETTINGS,
  isValidAllowlist,
  isValidIssuesPerCycle,
  parseCoachSettings,
  readCoachSettings,
  writeCoachSettings,
} from "../coach/settings";
import { readWorkerState, writeWorkerState, type CoachWorkerState } from "../coach/worker-state";
import { emptyLedger, loadLedger, saveLedger } from "../coach/ledger";
import { readCoachStatus } from "../coach/status";
import { describeCycle, runCycle, type CoachReport, type CycleResult } from "../coach/coordinator";
import {
  buildFamilies,
  familyKey,
  isTrivialCommand,
  normalizeCommandSignature,
  TRIVIAL_COMMANDS,
  type CoachFamily,
} from "../coach/families";
import { familyTag } from "../coach/issue";
import {
  COACH_PROMPT_ISSUES_UNAVAILABLE,
  coachIssues,
  coachPromptTemplate,
  synthesisPrompt,
  SYNTHESIS_PROMPT_MAX_BYTES,
  synthesizeFamily,
  type SynthesisPaths,
  type Synthesize,
} from "../coach/synthesize";
import { readToolLog } from "../lib/tool-log";
import { MCP_COVERS, MCP_TOOLS } from "../mcp/catalog";
import type { AgentSession, SessionToolCall, SessionToolResult } from "../lib/agent-sessions";
import type { CoachCollection, CoachJournalRecord } from "../coach/collect";
import type { CoachDelivery, DeliveryResult } from "../coach/delivery";
import type { CoachOpenIssue } from "../coach/issue";

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
const START = new Date(NOW.getTime() - 24 * 60 * 60_000);

function instant(minutesAgo: number, from = NOW): string {
  return new Date(from.getTime() - minutesAgo * 60_000).toISOString();
}

async function workspace(): Promise<{ root: string; repoDir: string; stateDir: string }> {
  const root = await temporaryRoot();
  const repoDir = join(root, "checkout");
  const stateDir = join(root, "state");
  await mkdir(join(repoDir, ".devboard"), { recursive: true });
  await mkdir(coachDirectory(stateDir), { recursive: true });
  return { root, repoDir, stateDir };
}

/** The harness version this checkout's worker publishes. */
function sourceVersion(): string | null {
  return readHarnessVersion(harnessRoot);
}

function versionedState(coachDir: string, version: string | null): CoachWorkerState | undefined {
  return readWorkerState(versionedWorkerDirectory(coachDir, version));
}

/** The state this checkout's own worker publishes. */
function currentWorkerState(coachDir: string): CoachWorkerState | undefined {
  return versionedState(coachDir, sourceVersion());
}

/**
 * Publishes a live lock for `pid` at the version's lock path, exactly like a
 * worker that took it. The recorded start is the process's real start, from
 * `/proc` (or this process's own uptime), so the owner reads as alive.
 */
function writeOwnerLock(path: string, options: {
  pid: number;
  repoDir: string;
  stateDir: string;
  harnessVersion: string | null;
}): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      pid: options.pid,
      startedAt: processStartedAt(options.pid),
      repo: options.repoDir,
      stateDir: options.stateDir,
      harnessVersion: options.harnessVersion,
      argv: [],
      token: `test-${options.pid}-${Math.random().toString(36).slice(2)}`,
    })}\n`,
  );
}

/** The instant `pid` started, in the form the lock records it. */
function processStartedAt(pid: number): string {
  if (pid === process.pid) {
    return new Date(Date.now() - process.uptime() * 1000).toISOString();
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const startTicks = Number(stat.slice(close + 2).split(" ")[19]);
      const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
      if (Number.isFinite(startTicks) && Number.isFinite(uptime)) {
        return new Date(Date.now() - uptime * 1000 + startTicks * 10).toISOString();
      }
    } catch {
      // Fall through to the write instant.
    }
  }
  return new Date().toISOString();
}

function spawnSleeper(): { pid: number; kill: () => void } {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  return {
    pid: child.pid!,
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    },
  };
}

/** Publishes a versioned (or legacy) worker state as that worker would. */
function publishWorkerState(options: {
  coachDir: string;
  version: string;
  pid: number;
  repoDir: string;
  stateDir: string;
  lifecycle: CoachWorkerState["lifecycle"];
  legacy?: boolean;
}): void {
  const directory =
    options.legacy === true
      ? options.coachDir
      : versionedWorkerDirectory(options.coachDir, options.version);
  writeWorkerState(directory, {
    version: 1,
    pid: options.pid,
    startedAt: new Date().toISOString(),
    root: options.repoDir,
    stateDir: options.stateDir,
    lifecycle: options.lifecycle,
    enabled: options.lifecycle !== "stopped",
    harnessVersion: options.version,
    argv: [],
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    notice: null,
    updatedAt: new Date().toISOString(),
  });
}

function controlFileCount(directory: string): number {
  try {
    return readdirSync(directory).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** A completed cycle with no filings, enough for the worker loop's report. */
function emptyCycleResult(): CycleResult {
  const now = new Date().toISOString();
  return {
    exitCode: 0,
    report: {
      cycle: now,
      window: { start: now, end: now, minutes: 60 },
      sessions: 0,
      sessionFiles: 0,
      truncated: false,
      skipped: 0,
      malformed: 0,
      journalRecords: 0,
      families: 0,
      findings: [],
      selected: [],
      omitted: 0,
      ledgerReset: false,
      synthesis: [],
      validations: [],
      action: "none",
      reason: "test cycle",
      issues: [],
      duplicates: [],
      dropped: 0,
      pending: 0,
      reportPath: "",
    },
  };
}

/** One filed family, so the Coach projection has an issue URL to read. */
function seedCoachIssue(stateDir: string, url: string): void {
  const ledger = emptyLedger();
  ledger.families["bun run publish"] = {
    firstSeen: NOW.toISOString(),
    lastSeen: NOW.toISOString(),
    calls: 1,
    sessions: 1,
    kind: "command",
    lastAction: "filed",
    lastIssueUrl: url,
    lastTitle: "[coach] bun run publish",
    lastFiledAt: NOW.toISOString(),
  };
  saveLedger(coachDirectory(stateDir), ledger);
}

interface CoachRetryReader extends ForgeIssueReader {
  calls: number;
  /** One queued failure per attempt, consumed in order. */
  failures: string[];
  /** A failure every attempt uses until cleared. */
  failAll: string | null;
}

function coachRetryReader(): CoachRetryReader {
  const reader: CoachRetryReader = {
    calls: 0,
    failures: [],
    failAll: null,
    async project(urls: string[]): Promise<Array<{ url: string; state: "pending"; version: null }>> {
      reader.calls += 1;
      const message = reader.failures.shift() ?? reader.failAll;
      if (message !== null) throw new Error(message);
      return urls.map((url) => ({ url, state: "pending" as const, version: null }));
    },
  };
  return reader;
}

function coachActivity(options: {
  repoDir: string;
  stateDir: string;
  reader: ForgeIssueReader;
  now: () => number;
}): CoachActivity {
  return new CoachActivity({
    descriptor: agentRegistry.require("coach"),
    repoDir: options.repoDir,
    stateDir: options.stateDir,
    harnessDir: harnessRoot,
    send: () => undefined,
    reader: options.reader,
    hasClients: () => true,
    now: options.now,
    intervalMs: 60_000,
    staleAfterMs: 120_000,
  });
}

async function readCoachOnce(activity: CoachActivity): Promise<void> {
  activity.snapshot();
  await activity.settled();
}

async function waitFor<T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await Bun.sleep(50);
  }
}

interface CallSeed {
  command: string;
  name?: string;
  isError?: boolean;
  text?: string;
  at?: string;
}

function sessionOf(options: {
  id: string;
  startedAt: string;
  title?: string;
  calls: CallSeed[];
}): AgentSession {
  const calls: SessionToolCall[] = [];
  const results: SessionToolResult[] = [];
  options.calls.forEach((seed, index) => {
    const name = seed.name ?? "bash";
    calls.push({
      id: `call-${index}`,
      name,
      argumentsText: JSON.stringify(
        name === "bash" ? { command: seed.command } : { path: seed.command },
      ),
      command: name === "bash" ? seed.command : null,
      index,
      timestamp: seed.at ?? options.startedAt,
    });
    results.push({
      toolCallId: `call-${index}`,
      toolName: name,
      text: seed.text ?? (seed.isError === true ? "ERROR: failed" : "ok"),
      isError: seed.isError === true,
      index,
      timestamp: seed.at ?? options.startedAt,
    });
  });
  return {
    id: options.id,
    path: `/fixture/${options.id}.jsonl`,
    relativePath: `providers/agents/fixture/sessions/bucket/${options.id}.jsonl`,
    startedAt: options.startedAt,
    title: options.title ?? `session ${options.id}`,
    cwd: "/checkout",
    relativeCwd: ".",
    messages: [],
    calls,
    results,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    cost: 0,
    messageCount: 0,
    toolErrorCount: results.filter((result) => result.isError).length,
    malformed: 0,
  };
}

function collectionOf(
  sessions: AgentSession[],
  journal: CoachJournalRecord[] = [],
): CoachCollection {
  return {
    window: { start: START.toISOString(), end: NOW.toISOString() },
    sessions,
    journal,
    sessionFiles: sessions.length,
    sessionsOmitted: 0,
    truncated: false,
    skipped: 0,
    malformed: 0,
    journalRecords: journal.length,
  };
}

function familiesOf(sessions: AgentSession[], journal: CoachJournalRecord[] = []): CoachFamily[] {
  return buildFamilies({
    sessions,
    journal,
    window: { start: START.toISOString(), end: NOW.toISOString() },
    repoDir: "/checkout",
  }).families;
}

function memoryDelivery(
  open: CoachOpenIssue[] = [],
): CoachDelivery & { created: Array<{ title: string; body: string }> } {
  const created: Array<{ title: string; body: string }> = [];
  const issues = open.slice();
  return {
    repository: "acme/fixture",
    created,
    async list() {
      return issues.slice();
    },
    async create(title: string, body: string): Promise<DeliveryResult> {
      created.push({ title, body });
      issues.push({
        number: issues.length + 1,
        title,
        body,
        url: `https://forge.test/acme/fixture/issues/${issues.length + 1}`,
      });
      return { ok: true, url: issues[issues.length - 1]!.url };
    },
  };
}

interface SynthesisCall {
  key: string;
  prompt: string;
  paths: SynthesisPaths;
}

type Decision =
  | { action: "file"; title?: string; number?: number; url?: string }
  | { action: "skip"; reason?: string }
  | { action: "fail"; reason: string };

/**
 * A peer replacement that performs the same MCP writes a real turn would: one
 * `issue_create` record in the tool log, or one `coach_proposal_skip` record in
 * the skip log. Nothing reads an answer document.
 */
function stubSynthesis(
  decide: (family: CoachFamily, prompt: string) => Decision,
  calls: SynthesisCall[] = [],
): Synthesize {
  return async (family, prompt, paths) => {
    calls.push({ key: family.key, prompt, paths });
    const decision = decide(family, prompt);
    if (decision.action === "fail") {
      return { ok: false, model: "stub", durationMs: 1, reason: decision.reason };
    }
    if (decision.action === "skip") {
      await writeFile(
        paths.skipLogPath,
        `${JSON.stringify({
          tool: "coach_proposal_skip",
          at: NOW.toISOString(),
          ok: true,
          value: {
            family: family.key,
            status: "skipped",
            reason: decision.reason ?? "the family needs no proposal",
          },
        })}\n`,
      );
      return { ok: true, model: "stub", durationMs: 1, text: "" };
    }
    const number = decision.number ?? 1;
    const title = decision.title ?? `[coach] ${family.key}`;
    const url = decision.url ?? `https://forge.test/acme/fixture/issues/${number}`;
    await writeFile(
      paths.toolLogPath,
      `${JSON.stringify({
        tool: "issue_create",
        at: NOW.toISOString(),
        ok: true,
        value: { number, url, title, labels: [] },
      })}\n`,
    );
    return { ok: true, model: "stub", durationMs: 1, text: "" };
  };
}

function filingRoomOf(prompt: string): number {
  const match = /"filingRoom": (\d+)/.exec(prompt);
  if (match === null) throw new Error("the prompt carries no filingRoom");
  return Number(match[1]);
}

/** Files only when the prompt grants filing room, as the peer rules instruct. */
function fileWhileRoom(calls: SynthesisCall[] = []): Synthesize {
  return stubSynthesis((_family, prompt) => {
    const room = filingRoomOf(prompt);
    if (room <= 0) {
      return { action: "skip", reason: "the cycle's filing room is zero" };
    }
    return { action: "file" };
  }, calls);
}

function threeFamilies(): AgentSession[] {
  return [
    sessionOf({
      id: "a1",
      startedAt: instant(60),
      calls: [
        { command: "bun run publish 2>&1 | tail -40" },
        { command: "bun install --frozen-lockfile 2>&1 | tail -10" },
      ],
    }),
    sessionOf({
      id: "a2",
      startedAt: instant(30),
      calls: [{ command: "bun .devboard/scripts/forge-auth.ts check --host 127.0.0.1" }],
    }),
  ];
}

describe("Coach registration and lifecycle", () => {
  test("the registry declares coach with its defaults", () => {
    expect(agentRegistry.ids()).toEqual([
      "scout",
      "watchdog",
      "design",
      "coach",
      "api-standards",
      "release-train",
    ]);
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
    const version = "test-version";
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
        writeOwnerLock(versionedLockPath(coachDir, version), {
          pid: process.pid,
          repoDir,
          stateDir,
          harnessVersion: version,
        });
        writeWorkerState(versionedWorkerDirectory(coachDir, version), {
          version: 1,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          root: repoDir,
          stateDir,
          lifecycle: "running",
          enabled: true,
          harnessVersion: version,
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
    expect(running.workers?.map((worker) => worker.version)).toEqual([version]);
    expect(spawned).toBe(1);

    expect(adapter.stop().ok).toBe(true);
    expect(adapter.snapshot().lifecycle).toBe("stopping");
    expect(controlFileCount(versionedControlDirectory(coachDir, version))).toBe(1);
    writeWorkerState(versionedWorkerDirectory(coachDir, version), {
      ...readWorkerState(versionedWorkerDirectory(coachDir, version))!,
      lifecycle: "stopped",
      enabled: false,
    });
    expect(adapter.snapshot().lifecycle).toBe("stopped");
    adapter.dispose();
  });

  test("a slow prerequisite check is not charged to the worker's publication", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    const version = "test-version";
    let clock = 1_000_000;
    const preflight = Promise.withResolvers<{ ok: true }>();
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
      now: () => clock,
      preflight: () => preflight.promise,
      spawnWorker: (argv) => {
        writeOwnerLock(versionedLockPath(coachDir, version), {
          pid: process.pid,
          repoDir,
          stateDir,
          harnessVersion: version,
        });
        writeWorkerState(versionedWorkerDirectory(coachDir, version), {
          version: 1,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          root: repoDir,
          stateDir,
          lifecycle: "running",
          enabled: true,
          harnessVersion: version,
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
    // No worker exists yet: the forge's answer is not the worker's failure.
    clock += 30_000;
    const waiting = adapter.snapshot();
    expect(waiting.lifecycle).toBe("starting");
    expect(waiting.error).toBeNull();
    preflight.resolve({ ok: true });
    expect((await pending).ok).toBe(true);
    const running = adapter.snapshot();
    expect(running.lifecycle).toBe("running");
    expect(running.error).toBeNull();
    adapter.dispose();
  });

  test("a start proof that expired clears once the worker publishes", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    const version = "test-version";
    let clock = 1_000_000;
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
      now: () => clock,
      preflight: async () => ({ ok: true }),
      spawnWorker: () => 999_999,
    });
    expect((await adapter.start()).ok).toBe(true);
    clock += 6_000;
    const expired = adapter.snapshot();
    expect(expired.error).toBe("the Coach worker did not publish its state within 5 seconds");
    expect(expired.lifecycle).toBe("stopped");
    writeOwnerLock(versionedLockPath(coachDir, version), {
      pid: process.pid,
      repoDir,
      stateDir,
      harnessVersion: version,
    });
    writeWorkerState(versionedWorkerDirectory(coachDir, version), {
      version: 1,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      root: repoDir,
      stateDir,
      lifecycle: "running",
      enabled: true,
      harnessVersion: version,
      argv: [],
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
      notice: null,
      updatedAt: new Date().toISOString(),
    });
    const running = adapter.snapshot();
    expect(running.lifecycle).toBe("running");
    expect(running.error).toBeNull();
    adapter.dispose();
  });

  test("a refused preflight writes no state and spawns nothing", async () => {
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
    adapter.dispose();
  });

  test("cadence and limits persist without dropping the family settings", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    await writeCoachSettings(coachDir, {
      ...DEFAULT_COACH_SETTINGS,
      maxIssuesPerCycle: 5,
      allowlist: ["bun "],
    });
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      send: () => undefined,
    });
    expect(adapter.setSettings(30, 5, null).ok).toBe(true);
    expect(readCoachSettings(coachDir)).toEqual({
      ...DEFAULT_COACH_SETTINGS,
      intervalMinutes: 30,
      maxPerHour: 5,
      maxPending: null,
      maxIssuesPerCycle: 5,
      allowlist: ["bun "],
    });
    expect(adapter.setSettings(0, 5, 5).ok).toBe(false);
    expect(adapter.setSettings(30, 101, 5).ok).toBe(false);
    adapter.dispose();
  });

  test("a settings command keeps a dashboard save the worker has not read back", async () => {
    // Integration: the real detached worker process is the subject, so the
    // test polls its published state instead of controlling a clock.
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    await writeCoachSettings(coachDir, { ...DEFAULT_COACH_SETTINGS, allowlist: [] });
    const child = spawn(
      process.execPath,
      [join(harnessRoot, "coach", "worker.ts"), "--root", repoDir, "--state-dir", stateDir],
      { cwd: repoDir, stdio: "ignore" },
    );
    try {
      await waitFor(
        () => {
          const state = currentWorkerState(coachDir);
          const afterCycle =
            state !== undefined &&
            state.lastRunAt !== null &&
            state.notice === "no family in the window";
          return afterCycle ? state : undefined;
        },
        "the worker to finish its first cycle",
      );
      // The dashboard rewrites the file after the worker's last read; the
      // command that follows must not persist the worker's older copy.
      await writeCoachSettings(coachDir, {
        ...DEFAULT_COACH_SETTINGS,
        allowlist: ["bun ", "git "],
        maxIssuesPerCycle: 7,
      });
      writeCoachCommand(versionedControlDirectory(coachDir, sourceVersion()), {
        type: "settings",
        intervalMinutes: 30,
        maxPerHour: 5,
        maxPending: null,
      });
      const saved = await waitFor(
        () => {
          const current = readCoachSettings(coachDir);
          return current.intervalMinutes === 30 && current.maxPerHour === 5 &&
            current.maxPending === null
            ? current
            : undefined;
        },
        "the settings command to reach the file",
      );
      expect(saved).toEqual({
        ...DEFAULT_COACH_SETTINGS,
        intervalMinutes: 30,
        maxPerHour: 5,
        maxPending: null,
        maxIssuesPerCycle: 7,
        allowlist: ["bun ", "git "],
      });
      writeCoachCommand(versionedControlDirectory(coachDir, sourceVersion()), { type: "stop" });
      await waitFor(
        () => (currentWorkerState(coachDir)?.lifecycle === "stopped" ? true : undefined),
        "the worker to stop",
      );
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  test("preflight names a GitLab origin as unsupported", async () => {
    const { repoDir } = await workspace();
    Bun.spawnSync({ cmd: ["git", "init", "-q", repoDir], stdout: "ignore", stderr: "ignore" });
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

describe("Coach worker versions and takeover", () => {
  test("lists every live version, reaches both controls, and has no mismatch notice", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    const legacyVersion = "0.0.1";
    const versionedVersion = "0.0.2";
    const first = spawnSleeper();
    const second = spawnSleeper();
    try {
      writeOwnerLock(lockPath(coachDir), {
        pid: first.pid,
        repoDir,
        stateDir,
        harnessVersion: legacyVersion,
      });
      writeOwnerLock(versionedLockPath(coachDir, versionedVersion), {
        pid: second.pid,
        repoDir,
        stateDir,
        harnessVersion: versionedVersion,
      });
      publishWorkerState({
        coachDir,
        version: legacyVersion,
        pid: first.pid,
        repoDir,
        stateDir,
        lifecycle: "running",
        legacy: true,
      });
      publishWorkerState({
        coachDir,
        version: versionedVersion,
        pid: second.pid,
        repoDir,
        stateDir,
        lifecycle: "running",
      });
      let spawned = 0;
      const adapter = new CoachActivity({
        descriptor: agentRegistry.require("coach"),
        repoDir,
        stateDir,
        harnessDir: harnessRoot,
        send: () => undefined,
        preflight: async () => ({ ok: true }),
        spawnWorker: () => {
          spawned += 1;
          return undefined;
        },
      });
      const snapshot = adapter.snapshot();
      expect(snapshot.lifecycle).toBe("running");
      expect(snapshot.attached).toBe(true);
      expect(snapshot.workers).toEqual([
        { pid: first.pid, version: legacyVersion, stateDir, lifecycle: "running" },
        { pid: second.pid, version: versionedVersion, stateDir, lifecycle: "running" },
      ]);
      expect(snapshot.notice ?? null).toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain("mismatch");

      const started = await adapter.start();
      expect(started.ok).toBe(true);
      expect(spawned).toBe(0);

      expect(adapter.stop().ok).toBe(true);
      expect(adapter.setSettings(15, 4, 2).ok).toBe(true);
      expect(controlFileCount(controlDirectory(coachDir))).toBe(2);
      expect(controlFileCount(versionedControlDirectory(coachDir, versionedVersion))).toBe(2);
      expect(adapter.snapshot().notice ?? null).toBeNull();
      adapter.dispose();
    } finally {
      first.kill();
      second.kill();
    }
  });

  test("a newer harness starts once and drains the older worker", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    const oldVersion = "0.0.1";
    const newest = sourceVersion();
    const old = spawnSleeper();
    try {
      writeOwnerLock(versionedLockPath(coachDir, oldVersion), {
        pid: old.pid,
        repoDir,
        stateDir,
        harnessVersion: oldVersion,
      });
      publishWorkerState({
        coachDir,
        version: oldVersion,
        pid: old.pid,
        repoDir,
        stateDir,
        lifecycle: "running",
      });
      const spawned: string[][] = [];
      const adapter = new CoachActivity({
        descriptor: agentRegistry.require("coach"),
        repoDir,
        stateDir,
        harnessDir: harnessRoot,
        runningVersion: newest,
        send: () => undefined,
        preflight: async () => ({ ok: true }),
        spawnWorker: (argv) => {
          spawned.push(argv);
          return process.pid;
        },
      });
      adapter.begin();
      await adapter.settled();
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toContain(join(harnessRoot, "coach", "worker.ts"));
      expect(takeCoachCommands(versionedControlDirectory(coachDir, oldVersion))).toEqual([
        { type: "drain" },
      ]);

      adapter.begin();
      await adapter.settled();
      expect(spawned).toHaveLength(1);
      adapter.dispose();
    } finally {
      old.kill();
    }
  });

  test("without a live worker the bridge starts nothing automatically", async () => {
    const { repoDir, stateDir } = await workspace();
    let spawned = 0;
    const adapter = new CoachActivity({
      descriptor: agentRegistry.require("coach"),
      repoDir,
      stateDir,
      harnessDir: harnessRoot,
      runningVersion: sourceVersion(),
      send: () => undefined,
      preflight: async () => ({ ok: true }),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
    });
    adapter.begin();
    await adapter.settled();
    expect(spawned).toBe(0);
    adapter.dispose();
  });

  test("a drained worker finishes its cycle, exits, and the next version claims the next one", async () => {
    const { repoDir, stateDir } = await workspace();
    const coachDir = coachDirectory(stateDir);
    const oldVersion = "1.0.0";
    const newVersion = "1.0.1";
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    let oldCycles = 0;
    let newCycles = 0;
    const oldRun = runWorker({
      root: repoDir,
      stateDir,
      harnessVersion: oldVersion,
      controlPollMs: 20,
      log: () => undefined,
      cycle: async () => {
        oldCycles += 1;
        order.push("old:start");
        await gate.promise;
        order.push("old:end");
        return emptyCycleResult();
      },
    });
    await waitFor(() => (oldCycles === 1 ? true : undefined), "the old worker's cycle");
    expect(liveLockOwner(cycleLockPath(coachDir))).toBeDefined();

    const newRun = runWorker({
      root: repoDir,
      stateDir,
      harnessVersion: newVersion,
      controlPollMs: 20,
      log: () => undefined,
      cycle: async () => {
        newCycles += 1;
        order.push("new:cycle");
        return emptyCycleResult();
      },
    });
    await waitFor(
      () => {
        const state = versionedState(coachDir, newVersion);
        return state?.notice === CYCLE_BUSY_NOTICE ? true : undefined;
      },
      "the new worker to find the cycle claimed",
    );
    // The old worker's in-flight cycle owns the one claim; the new version
    // must not start a second cycle beside it.
    expect(newCycles).toBe(0);
    expect(order).toEqual(["old:start"]);

    writeCoachCommand(versionedControlDirectory(coachDir, oldVersion), { type: "drain" });
    const draining = await waitFor(
      () => {
        const state = versionedState(coachDir, oldVersion);
        return state?.draining === true ? state : undefined;
      },
      "the old worker to publish draining",
    );
    expect(draining.lifecycle).toBe("stopping");
    expect(newCycles).toBe(0);

    gate.resolve();
    await oldRun;
    expect(versionedState(coachDir, oldVersion)?.lifecycle).toBe("stopped");
    expect(liveLockOwner(versionedLockPath(coachDir, oldVersion))).toBeUndefined();
    expect(order[0]).toBe("old:start");
    expect(order[1]).toBe("old:end");

    await waitFor(() => (newCycles === 1 ? true : undefined), "the new worker's cycle");
    expect(order).toEqual(["old:start", "old:end", "new:cycle"]);

    writeCoachCommand(versionedControlDirectory(coachDir, newVersion), { type: "drain" });
    await newRun;
    expect(versionedState(coachDir, newVersion)?.lifecycle).toBe("stopped");
    expect(liveLockOwner(versionedLockPath(coachDir, newVersion))).toBeUndefined();
    expect(oldCycles).toBe(1);
    expect(newCycles).toBe(1);
  }, 20_000);
});

describe("Coach normalization", () => {
  const repo = "/checkout";

  test("pipes and redirections are output handling, not the family", () => {
    expect(normalizeCommandSignature("bun run publish 2>&1 | tail -40", repo)).toBe(
      "bun run publish",
    );
    expect(normalizeCommandSignature("bun run publish | tail -60", repo)).toBe("bun run publish");
    expect(normalizeCommandSignature("bun install --frozen-lockfile 2>&1 | tail -10", repo)).toBe(
      "bun install",
    );
    expect(
      normalizeCommandSignature(
        "bun .devboard/scripts/forge-auth.ts check --host 127.0.0.1 --project p --required write",
        repo,
      ),
    ).toBe("bun .devboard/scripts/forge-auth.ts check");
  });

  test("segments keep the first non-trivial command and drop the directory change", () => {
    expect(
      normalizeCommandSignature(
        "git push origin HEAD:main && git ls-remote origin refs/heads/main",
        repo,
      ),
    ).toBe("git push origin HEAD:main");
    expect(normalizeCommandSignature("cd .devboard && bun test", repo)).toBe("bun test");
    expect(
      normalizeCommandSignature(`( cd /checkout && bun run publish 2>&1 | tail -5 )`, repo),
    ).toBe("bun run publish");
  });

  test("the environment prefix, root, worktree, and volatile tokens are replaced", () => {
    expect(normalizeCommandSignature(`ADRS_DIR=${repo}/adrs bun run build`, repo)).toBe(
      "bun run build",
    );
    expect(
      normalizeCommandSignature(
        `DEVBOARD_GITEA_URL=x ${repo}/.worktree/task/bin/tool --run 2026-01-10T12:00:00Z`,
        repo,
      ),
    ).toBe("<repo>/.worktree/<worktree>/bin/tool");
    expect(normalizeCommandSignature("git -C /checkout status", repo)).toBe("git status");
    expect(normalizeCommandSignature("tool 1234567890", repo)).toBe("tool <hex>");
  });

  test("trivial prefixes stay trivial and a different prefix is a different family", () => {
    expect(isTrivialCommand("git status --short --branch")).toBe(true);
    expect(isTrivialCommand("git push origin main")).toBe(false);
    expect(familyKey("git push origin main")).toBe("git push origin main");
    expect(familyKey("git push origin other")).not.toBe(familyKey("git push origin main"));
  });

  test("a flag-bearing allowlist entry stays trivial in the key it is compared against", () => {
    for (const entry of TRIVIAL_COMMANDS.filter((candidate) => candidate.includes("--"))) {
      expect(isTrivialCommand(normalizeCommandSignature(entry, repo))).toBe(true);
    }
    expect(normalizeCommandSignature("bunx tsc --noEmit", repo)).toBe("bunx tsc");
    expect(isTrivialCommand(normalizeCommandSignature("bunx tsc --noEmit", repo))).toBe(true);
  });

  test("volatile prefixes are removed before a segment is judged trivial", () => {
    expect(normalizeCommandSignature(`ADRS_DIR=${repo}/adrs bunx tsc --noEmit`, repo)).toBe(
      "bunx tsc",
    );
    expect(
      normalizeCommandSignature(
        `ADRS_DIR=${repo}/adrs bunx tsc --noEmit && git push origin main`,
        repo,
      ),
    ).toBe("git push origin main");
  });
});

describe("Coach families", () => {
  test("groups one normalized command and counts fragments", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [
          { command: "bun run publish 2>&1 | tail -40" },
          { command: "bun run publish --watch" },
          { command: "bun install --frozen-lockfile" },
        ],
      }),
      sessionOf({ id: "b", startedAt: instant(30), calls: [{ command: "bun run publish" }] }),
    ]);
    expect(families.map((family) => family.key).sort()).toEqual([
      "bun install",
      "bun run publish",
    ]);
    const publish = families.find((family) => family.key === "bun run publish")!;
    expect(publish.kind).toBe("command");
    expect(publish.calls).toBe(3);
    expect(publish.sessions).toEqual(["a", "b"]);
    expect(publish.days).toBe(1);
    expect(publish.score).toBe(3 * 2 * 1);
    expect(publish.fragments.reduce((total, fragment) => total + fragment.count, 0)).toBe(3);
  });

  test("a nonzero trivial command and a read-only error produce no family", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [
          { command: "bun run build", isError: true },
          { command: "/some/path.ts", name: "read", isError: true },
        ],
      }),
    ]);
    expect(families).toEqual([]);
  });

  test("a typechecking session produces no bunx tsc family", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [{ command: "bunx tsc --noEmit" }],
      }),
    ]);
    expect(families).toEqual([]);
  });

  test("a mutating tool error attaches to its family and a retry adds weight", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [
          { command: "src/app.ts", name: "edit", isError: true, text: "ERROR: no match" },
          { command: "git push origin HEAD:main", isError: true, text: "ERROR: rejected" },
          { command: "git push origin HEAD:main", isError: true, text: "ERROR: rejected" },
          { command: "git push origin HEAD:main", isError: true, text: "ERROR: rejected" },
        ],
      }),
    ]);
    expect(families.map((family) => family.key).sort()).toEqual(["edit", "git push origin HEAD:main"]);
    const push = families.find((family) => family.key === "git push origin HEAD:main")!;
    expect(push.calls).toBe(4);
    expect(push.fragments.some((fragment) => fragment.text === "retry ×3")).toBe(true);
  });

  test("a failure in one command never makes another command's calls a retry", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [
          { command: "bun run publish", isError: true, text: "EXIT:1" },
          { command: "git push origin task-7" },
          { command: "git push origin task-7" },
          { command: "git push origin task-7" },
        ],
      }),
    ]);
    const push = families.find((family) => family.key === "git push origin task-7")!;
    expect(push.calls).toBe(3);
    expect(push.fragments.some((fragment) => fragment.text.startsWith("retry"))).toBe(false);
    expect(push.excerpts.every((excerpt) => excerpt.status === "ok")).toBe(true);
  });

  test("a success after a failure of the same command does not count as a retry", () => {
    const families = familiesOf([
      sessionOf({
        id: "a",
        startedAt: instant(60),
        calls: [
          { command: "git push origin task-7", isError: true, text: "rejected" },
          { command: "git push origin task-7" },
          { command: "git push origin task-7" },
          { command: "git push origin task-7" },
        ],
      }),
    ]);
    const push = families.find((family) => family.key === "git push origin task-7")!;
    expect(push.fragments.some((fragment) => fragment.text.startsWith("retry"))).toBe(false);
    expect(push.calls).toBe(4);
  });

  test("journal questions and run failures need two scopes", () => {
    const journal: CoachJournalRecord[] = [
      { kind: "question", text: "Should I rewrite it?", scope: "run-a", ts: instant(30) },
      { kind: "question", text: "Should I rewrite it?", scope: "run-b", ts: instant(20) },
      { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-a", ts: instant(30) },
      { kind: "acp-stderr", text: "fatal: provider exploded\nmore", scope: "run-b", ts: instant(20) },
      { kind: "question", text: "One scope only?", scope: "run-a", ts: instant(10) },
    ];
    const families = familiesOf([], journal);
    expect(families.map((family) => family.key).sort()).toEqual([
      "question: Should I rewrite it?",
      "run-failure: fatal: provider exploded",
    ]);
    const question = families.find((family) => family.kind === "question")!;
    expect(question.sessions).toEqual(["run-a", "run-b"]);
    expect(question.score).toBe(2 * 1 * 2);
  });

  test("coach-owned, worktree, tmp, and fixture evidence is excluded", () => {
    const families = familiesOf(
      [
        sessionOf({
          id: "a",
          startedAt: instant(60),
          calls: [
            { command: "bun run verify:coach" },
            { command: `cd ${"/checkout/.worktree/task"} && bun run publish` },
            { command: "bun .devboard/.tmp/script.ts" },
            { command: "true" },
            { command: "echo hello" },
            { command: "i: noop" },
          ],
        }),
      ],
    );
    expect(families).toEqual([]);
  });

  test("the score orders families and ties break by key ascending", () => {
    const selection = buildFamilies({
      sessions: [
        sessionOf({
          id: "a1",
          startedAt: instant(120),
          calls: [{ command: "aaa --one" }, { command: "aaa --two" }],
        }),
        sessionOf({ id: "a2", startedAt: instant(100), calls: [{ command: "aaa --three" }] }),
        sessionOf({
          id: "b1",
          startedAt: instant(60),
          calls: [
            { command: "bbb --one", at: instant(1_400) },
            { command: "bbb --two", at: instant(700) },
            { command: "bbb --three", at: instant(600) },
          ],
        }),
      ],
      journal: [],
      window: { start: START.toISOString(), end: NOW.toISOString() },
      repoDir: "/checkout",
    });
    expect(selection.families.map((family) => family.key)).toEqual(["aaa", "bbb"]);
    expect(selection.families.map((family) => family.score)).toEqual([6, 6]);
    expect(selection.selected.map((family) => family.key)).toEqual(["aaa", "bbb"]);
  });

  test("selects at most 20 and reports the omitted count", () => {
    const sessions: AgentSession[] = [];
    for (let index = 0; index < 21; index += 1) {
      sessions.push(
        sessionOf({
          id: `s${index}`,
          startedAt: instant(60 + index),
          calls: [{ command: `cmd-${String(index).padStart(2, "0")}` }],
        }),
      );
    }
    const selection = buildFamilies({
      sessions,
      journal: [],
      window: { start: START.toISOString(), end: NOW.toISOString() },
      repoDir: "/checkout",
    });
    expect(selection.families).toHaveLength(21);
    expect(selection.selected).toHaveLength(20);
    expect(selection.omitted).toBe(1);
    expect(selection.selected.map((family) => family.key)).toEqual(
      selection.selected.map((family) => family.key).slice().sort(),
    );
  });
});

describe("Coach synthesis contract and prompt", () => {
  const family = familiesOf([
    sessionOf({
      id: "a",
      startedAt: instant(60),
      calls: [{ command: "bun run publish", isError: true, text: "ERROR: boom" }],
    }),
  ])[0]!;

  /** The six headings whose following lines are a prompt's dynamic sections. */
  const DYNAMIC_HEADINGS = [
    "Family:",
    "Fragments:",
    "Excerpts:",
    "MCP catalog:",
    "Open Coach issues:",
    "Command allowlist:",
    "Limits:",
  ];

  /** One section's value lines, joined; a dynamic value never contains a blank line. */
  function sectionValue(text: string, heading: string): string {
    const lines = text.split("\n");
    const start = lines.indexOf(heading);
    if (start < 0) return "";
    const value: string[] = [];
    for (let index = start + 1; index < lines.length && lines[index] !== ""; index += 1) {
      value.push(lines[index]!);
    }
    return value.join("\n");
  }

  /** Every line outside the six dynamic sections, in order. */
  function fixedLines(text: string): string[] {
    const lines = text.split("\n");
    return lines.filter((line, index) => {
      if (DYNAMIC_HEADINGS.includes(line)) return true;
      for (let back = index - 1; back >= 0 && lines[back] !== ""; back -= 1) {
        if (DYNAMIC_HEADINGS.includes(lines[back]!)) return false;
      }
      return true;
    });
  }

  test("the prompt opens with the manifesto and states the allowlist, caps, tag, body and tool rules", () => {
    const openIssues: CoachOpenIssue[] = [
      {
        number: 7,
        title: "[coach] bun run publish",
        body: `family:${familyTag(family.key)}`,
        url: "https://forge.test/acme/fixture/issues/7",
      },
    ];
    const settings = {
      ...DEFAULT_COACH_SETTINGS,
      allowlist: ["bun "],
      maxIssuesPerCycle: 3,
      maxPerHour: 4,
    };
    const prompt = synthesisPrompt({ family, settings, openIssues, filingRoom: 1 });
    expect(prompt.startsWith("## Manifesto")).toBe(true);
    expect(prompt).toContain(family.key);
    expect(prompt).toContain("bun run verify:mcp");
    expect(prompt).toContain("https://forge.test/acme/fixture/issues/7");
    expect(prompt).toContain("Command allowlist:");
    expect(prompt).toContain('"bun "');
    expect(prompt).toContain('"maxIssuesPerCycle": 3');
    expect(prompt).toContain('"maxPerHour": 4');
    expect(prompt).toContain('"filingRoom": 1');
    expect(prompt).toContain("Limits:");
    expect(prompt).toContain(`family:${familyTag(family.key)}`);
    for (const section of [
      "## Family",
      "## Evidence",
      "## Proposed tool",
      "## Acceptance",
      "## Rationale",
    ]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("issue_create");
    expect(prompt).toContain("coach_proposal_skip");
    expect(prompt).toContain("covers");
    expect(prompt).toContain("no labels");
    expect(prompt).not.toContain("pendingFiling");
    expect(prompt).not.toContain("pending queue");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(SYNTHESIS_PROMPT_MAX_BYTES);
    expect(synthesisPrompt({ family, settings, openIssues, filingRoom: 1 })).toBe(prompt);
  });

  test("filingRoom is the cycle cap's remaining allowance for this family", () => {
    const settings = { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 2, maxPerHour: 10 };
    const room = synthesisPrompt({ family, settings, openIssues: [], filingRoom: 0 });
    expect(room).toContain('"filingRoom": 0');
    expect(room).toContain("only when `filingRoom` is greater than zero");
  });

  test("the page template repeats the prompt's fixed lines character for character", () => {
    const settings = { ...DEFAULT_COACH_SETTINGS, allowlist: ["bun ", "git "] };
    const openIssues: CoachOpenIssue[] = [
      {
        number: 7,
        title: "[coach] bun run publish",
        body: `family:${familyTag(family.key)}`,
        url: "https://forge.test/acme/fixture/issues/7",
      },
    ];
    const prompt = synthesisPrompt({ family, settings, openIssues, filingRoom: 1 });
    const template = coachPromptTemplate({ settings, openIssues });
    expect(fixedLines(template)).toEqual(fixedLines(prompt));
    expect(fixedLines(template)).toContain("## Manifesto");
    expect(fixedLines(template)).toContain(
      "- File with `issue_create` and no labels. Its returned number and URL are the record.",
    );
    expect(
      fixedLines(template).some((line) => line.includes("call `coach_proposal_skip`")),
    ).toBe(true);
    expect(sectionValue(template, "MCP catalog:")).toBe(sectionValue(prompt, "MCP catalog:"));
    expect(sectionValue(template, "Command allowlist:")).toBe(
      JSON.stringify(settings.allowlist, null, 2),
    );
    expect(JSON.parse(sectionValue(template, "MCP catalog:"))).toEqual({
      tools: MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title })),
      covers: [...MCP_COVERS],
    });
  });

  test("the template names its three per-family sections with placeholders", () => {
    const template = coachPromptTemplate({
      settings: { ...DEFAULT_COACH_SETTINGS, allowlist: ["bun "] },
      openIssues: [],
    });
    expect(sectionValue(template, "Family:")).toBe("<family>");
    expect(sectionValue(template, "Fragments:")).toBe("<fragments>");
    expect(sectionValue(template, "Excerpts:")).toBe("<excerpts>");
    expect(template).not.toContain(family.key);
    expect(template).not.toContain(family.firstAt);
    for (const excerpt of family.excerpts) {
      expect(template).not.toContain(excerpt.command);
    }
  });

  test("the open-issue section filters, sorts, and states an unavailable read", () => {
    const settings = { ...DEFAULT_COACH_SETTINGS, allowlist: ["bun "] };
    const issues: CoachOpenIssue[] = [
      { number: 9, title: "unrelated", body: "no tag", url: "https://forge.test/9" },
      { number: 5, title: "family evidence", body: "see family:abc", url: "https://forge.test/5" },
      { number: 3, title: "[coach] later", body: "", url: "https://forge.test/3" },
    ];
    expect(coachIssues(issues).map((issue) => issue.number)).toEqual([5, 3]);
    const template = coachPromptTemplate({ settings, openIssues: issues });
    const value = sectionValue(template, "Open Coach issues:");
    expect(JSON.parse(value)).toEqual([
      { number: 3, title: "[coach] later", url: "https://forge.test/3" },
      { number: 5, title: "family evidence", url: "https://forge.test/5" },
    ]);
    expect(value).not.toContain("unrelated");
    expect(
      sectionValue(coachPromptTemplate({ settings, openIssues: [] }), "Open Coach issues:"),
    ).toBe("[]");
    const unavailable = sectionValue(
      coachPromptTemplate({ settings, openIssues: null }),
      "Open Coach issues:",
    );
    expect(unavailable).toBe(COACH_PROMPT_ISSUES_UNAVAILABLE);
    expect(unavailable).not.toBe("[]");
  });

  test("a prompt above the byte budget is cut to the budget", () => {
    const huge: CoachFamily = {
      key: family.key,
      kind: "command",
      calls: 1,
      sessions: ["a"],
      days: 1,
      firstAt: family.firstAt,
      lastAt: family.lastAt,
      score: 1,
      fragments: [{ text: "界".repeat(30_000), count: 1 }],
      excerpts: [],
    };
    const prompt = synthesisPrompt({
      family: huge,
      settings: DEFAULT_COACH_SETTINGS,
      openIssues: [],
      filingRoom: 1,
    });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(SYNTHESIS_PROMPT_MAX_BYTES);
  });
});

describe("Coach cycle", () => {
  test("one synthesis call per family, recording each filed issue from its tool log", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const calls: SynthesisCall[] = [];
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: stubSynthesis(() => ({ action: "file" }), calls),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    const families = buildFamilies({ ...collection, repoDir });
    expect(result.report.action).toBe("filed");
    expect(calls.map((call) => call.key).sort()).toEqual(
      families.selected.map((family) => family.key).sort(),
    );
    expect(result.report.families).toBeGreaterThanOrEqual(3);
    expect(result.report.selected).toHaveLength(families.selected.length);
    expect(result.report.issues).toHaveLength(families.selected.length);
    // Filing is the peer's MCP write; the coordinator never posts through the delivery.
    expect(delivery.created).toEqual([]);
    for (const call of calls) {
      expect(call.prompt.startsWith("## Manifesto")).toBe(true);
      expect(call.prompt).toContain(`family:${familyTag(call.key)}`);
      expect(call.prompt).toContain('"filingRoom": 1');
      const records = readToolLog(call.paths.toolLogPath);
      expect(records).toHaveLength(1);
      expect(records[0]?.tool).toBe("issue_create");
      expect(records[0]?.ok).toBe(true);
    }
    for (const issue of result.report.issues) {
      expect(issue.title).toBe(`[coach] ${issue.family}`);
      expect(issue.url).toContain("https://forge.test/");
      expect(issue.kind).toBe("command");
    }
    expect(result.report.validations.filter((entry) => entry.outcome === "filed")).toHaveLength(
      families.selected.length,
    );
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    for (const issue of result.report.issues) {
      const entry = ledger.families[issue.family];
      expect(entry?.lastAction).toBe("filed");
      expect(entry?.lastIssueUrl).toBe(issue.url);
      expect(entry?.lastTitle).toBe(issue.title);
    }
  });

  test("a cycle whose families record a skip files nothing and keeps the reason", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const calls: SynthesisCall[] = [];
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: stubSynthesis(() => ({
        action: "skip",
        reason: "the recurrence is expected and needs no change",
      }), calls),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("none");
    expect(result.report.issues).toEqual([]);
    expect(delivery.created).toEqual([]);
    expect(result.report.validations).toHaveLength(calls.length);
    for (const entry of result.report.validations) {
      expect(entry.outcome).toBe("skipped");
      expect(entry.rule).toBe("tool");
      expect(entry.reason).toBe("the recurrence is expected and needs no change");
    }
    for (const call of calls) {
      const records = readToolLog(call.paths.skipLogPath);
      expect(records).toHaveLength(1);
      expect(records[0]?.tool).toBe("coach_proposal_skip");
      expect(records[0]?.ok).toBe(true);
    }
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(Object.values(ledger.families).every((entry) => entry.lastAction === "none")).toBe(true);
  });

  test("duplicate detection reads the title and the body family tag", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const families = buildFamilies({ ...collection, repoDir });
    const first = families.selected[0]!;
    const second = families.selected[1]!;
    const delivery = memoryDelivery([
      {
        number: 1,
        title: `[coach] ${first.key}`,
        body: "unrelated",
        url: "https://forge.test/acme/fixture/issues/1",
      },
      {
        number: 2,
        title: "Unrelated title",
        body: `evidence family:${familyTag(second.key)}`,
        url: "https://forge.test/acme/fixture/issues/2",
      },
      {
        number: 3,
        title: "Fix the login page",
        body: "unrelated to any coach family",
        url: "https://forge.test/acme/fixture/issues/3",
      },
    ]);
    const calls: SynthesisCall[] = [];
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: stubSynthesis(() => ({ action: "file" }), calls),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    for (const call of calls) {
      // Only the two Coach-relevant open issues reach the prompt.
      expect(call.prompt).toContain("https://forge.test/acme/fixture/issues/1");
      expect(call.prompt).toContain("https://forge.test/acme/fixture/issues/2");
      expect(call.prompt).not.toContain("https://forge.test/acme/fixture/issues/3");
    }
    expect(result.report.duplicates.map((entry) => entry.family).sort()).toEqual(
      [first.key, second.key].sort(),
    );
    expect(result.report.issues.map((entry) => entry.family)).not.toContain(first.key);
    expect(result.report.issues.map((entry) => entry.family)).not.toContain(second.key);
    expect(
      result.report.validations.filter((entry) => entry.outcome === "duplicate"),
    ).toHaveLength(2);
  });

  test("two families recording one title file it once and record the duplicate", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const selected = buildFamilies({ ...collection, repoDir }).selected;
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: stubSynthesis(() => ({ action: "file", title: "[coach] shared tool" })),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.issues).toHaveLength(1);
    expect(result.report.issues[0]?.title).toBe("[coach] shared tool");
    expect(
      result.report.validations.filter((entry) => entry.outcome === "duplicate"),
    ).toHaveLength(selected.length - 1);
    expect(result.report.validations.filter((entry) => entry.outcome === "filed")).toHaveLength(1);
  });

  test("a failed synthesis call files nothing and leaves the ledger consistent", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collectionOf(threeFamilies()),
      delivery,
      synthesize: async (family) => ({
        ok: false,
        model: "stub",
        durationMs: 3,
        reason: `peer failed for ${family.key}`,
      }),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("failed");
    expect(result.report.reason).toContain("synthesis failed");
    expect(delivery.created).toEqual([]);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.pendingFiling).toEqual([]);
  });

  test("a peer turn that quotes HTTP 401 is not a credential rejection", async () => {
    const { root, repoDir, stateDir } = await workspace();
    const now = NOW.toISOString();
    saveSubscriptions(stateDir, [
      {
        id: "alpha",
        provider: "opencode-go",
        label: "Alpha",
        key: "key-alpha",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const family = familiesOf(threeFamilies())[0]!;
    const answer =
      "The command exits 7 whenever the API answers HTTP 401; no change is needed.";
    const script = join(root, "stub-acp.ts");
    await writeFile(
      script,
      `#!/usr/bin/env bun
const sessionId = "stub-session";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (typeof message.method !== "string" || message.id === undefined) continue;
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "stub-message",
            content: { type: "text", text: ${JSON.stringify(JSON.stringify(answer))} },
          },
        },
      });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    }
  }
}
`,
    );
    const result = await synthesizeFamily({
      repoDir,
      stateDir,
      family,
      prompt: "propose one family issue",
      command: `${process.execPath} ${script}`,
      environment: {},
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe(JSON.stringify(answer));
    expect(result.text).toContain("HTTP 401");
  });

  test("a peer credential error rotates to the next subscription", async () => {
    const { root, repoDir, stateDir } = await workspace();
    const now = NOW.toISOString();
    const row = (id: string, key: string) => ({
      id,
      provider: "opencode-go" as const,
      label: id,
      key,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    saveSubscriptions(stateDir, [row("alpha", "key-alpha"), row("beta", "key-beta")]);
    const script = join(root, "stub-acp.ts");
    await writeFile(
      script,
      `#!/usr/bin/env bun
const sessionId = "stub-session";
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (typeof message.method !== "string" || message.id === undefined) continue;
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === "session/new") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    } else if (message.method === "session/prompt") {
      if (process.env.OPENCODE_API_KEY === "key-alpha") {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "401 Unauthorized: invalid api key" },
        });
      } else {
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "stub-message",
              content: { type: "text", text: '{"family":"probe","action":"none"}' },
            },
          },
        });
        write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      }
    }
  }
}
`,
    );
    const family = familiesOf(threeFamilies())[0]!;
    const result = await synthesizeFamily({
      repoDir,
      stateDir,
      family,
      prompt: "propose one family issue",
      command: `${process.execPath} ${script}`,
      environment: {},
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('"family":"probe"');
  });

  test("one failed synthesis call does not discard the tool records that filed", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const families = buildFamilies({ ...collection, repoDir });
    const failed = families.selected[0]!;
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: stubSynthesis((family) =>
        family.key === failed.key
          ? { action: "fail", reason: "the synthesizer peer timed out after 5000ms" }
          : { action: "file" },
      ),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    expect(result.report.issues).toHaveLength(families.selected.length - 1);
    expect(result.report.issues.some((entry) => entry.family === failed.key)).toBe(false);
    expect(result.report.synthesis.filter((entry) => !entry.ok)).toHaveLength(1);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.families[failed.key]?.lastAction).toBe("failed");
    expect(ledger.families[failed.key]?.lastIssueUrl).toBeUndefined();
  });

  test("maxIssuesPerCycle grants filing room to only that many families", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const settings = {
      ...DEFAULT_COACH_SETTINGS,
      maxIssuesPerCycle: 1,
      allowlist: ["bun "],
    };
    const calls: SynthesisCall[] = [];
    const first = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: fileWhileRoom(calls),
      settings,
    });
    expect(first.report.action).toBe("filed");
    expect(first.report.issues).toHaveLength(1);
    expect(calls.map((call) => filingRoomOf(call.prompt)).sort()).toEqual([0, 0, 1]);
    expect(calls.filter((call) => filingRoomOf(call.prompt) > 0)).toHaveLength(1);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.pendingFiling).toEqual([]);
    expect(first.report.pending).toBe(0);
  });

  test("the rolling-hour cap empties every family's filing room until the hour passes", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const settings = {
      ...DEFAULT_COACH_SETTINGS,
      maxPerHour: 1,
      maxIssuesPerCycle: 3,
      allowlist: ["bun "],
    };
    const firstCalls: SynthesisCall[] = [];
    const first = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: fileWhileRoom(firstCalls),
      settings,
    });
    expect(first.report.action).toBe("filed");
    expect(first.report.issues).toHaveLength(1);
    expect(firstCalls.map((call) => filingRoomOf(call.prompt)).sort()).toEqual([0, 0, 1]);

    const secondCalls: SynthesisCall[] = [];
    const second = await runCycle({
      root: repoDir,
      stateDir,
      now: new Date(NOW.getTime() + 30 * 60_000),
      collect: () => collection,
      delivery,
      synthesize: fileWhileRoom(secondCalls),
      settings,
    });
    expect(second.report.action).toBe("none");
    expect(second.report.issues).toEqual([]);
    expect(secondCalls.every((call) => filingRoomOf(call.prompt) === 0)).toBe(true);

    const thirdCalls: SynthesisCall[] = [];
    const third = await runCycle({
      root: repoDir,
      stateDir,
      now: new Date(NOW.getTime() + 61 * 60_000),
      collect: () => collection,
      delivery,
      synthesize: fileWhileRoom(thirdCalls),
      settings,
    });
    expect(third.report.action).not.toBe("failed");
    expect(third.report.issues).toHaveLength(1);
    expect(thirdCalls.filter((call) => filingRoomOf(call.prompt) > 0)).toHaveLength(1);
  });

  test("a pending queue written by an older revision is dropped and recorded", async () => {
    const { repoDir, stateDir } = await workspace();
    const collection = collectionOf(threeFamilies());
    const delivery = memoryDelivery();
    const now = new Date().toISOString();
    saveLedger(coachDirectory(stateDir), {
      version: 3,
      families: {},
      pendingFiling: [
        {
          family: "bun run publish",
          kind: "command",
          title: "[coach] bun run publish",
          body: "## Family\n\nstored bytes\n",
          score: 6,
          createdAt: now,
        },
      ],
    });
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: stubSynthesis(() => ({ action: "skip", reason: "already covered" })),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.dropped).toBe(1);
    expect(result.report.pending).toBe(0);
    expect(result.report.issues).toEqual([]);
    expect(delivery.created).toEqual([]);
    const dropped = result.report.validations.filter((entry) => entry.outcome === "dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.rule).toBe("pending-queue-removed");
    expect(dropped[0]?.family).toBe("bun run publish");
    expect(loadLedger(coachDirectory(stateDir)).ledger.pendingFiling).toEqual([]);
  });

  test("a version-2 ledger is discarded and the report says so", async () => {
    const { repoDir, stateDir } = await workspace();
    await writeFile(
      join(coachDirectory(stateDir), "state.json"),
      JSON.stringify({ version: 2, findings: { old: {} }, pendingFiling: [] }),
    );
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      dryRun: true,
      collect: () => collectionOf(threeFamilies()),
    });
    expect(result.report.ledgerReset).toBe(true);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.families).toEqual({});
  });

  test("legacy decision environment variables are never read", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const legacyEnvironment = {
      ["DEVBOARD_OPENROUTER_" + "DECISIONS_URL"]: "http://127.0.0.1:9/decisions",
      ["DEVBOARD_COACH_" + "DECISIONS" + "_STUB"]: "/does/not/exist.json",
      ["JEV_" + "DECISION_MODEL"]: "typesafe/legacy-1.14",
    };
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      environment: legacyEnvironment,
      collect: () => collectionOf(threeFamilies()),
      delivery,
      synthesize: stubSynthesis(() => ({ action: "file" })),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    expect(result.report.issues.length).toBeGreaterThan(0);
    expect(delivery.created).toEqual([]);
  });

  test("the report and status carry the family shapes", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collectionOf(threeFamilies()),
      delivery,
      synthesize: stubSynthesis(() => ({ action: "file" })),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    const report: CoachReport = result.report;
    expect(report).toMatchObject({
      action: "filed",
      families: 3,
      omitted: 0,
      ledgerReset: false,
      dropped: 0,
      pending: 0,
    });
    expect(report.window.start).toBe(START.toISOString());
    expect(report.journalRecords).toBe(0);
    expect(report.synthesis).toHaveLength(3);
    expect(report.selected.map((entry) => entry.key)).toEqual(
      report.selected.map((entry) => entry.key),
    );
    for (const entry of report.validations) {
      expect(["filed", "duplicate", "skipped", "dropped", "failed"]).toContain(entry.outcome);
    }
    expect(describeCycle(result)).toContain("filed");
    expect(existsSync(join(coachDirectory(stateDir), "runs", report.cycle.replace(/[:.]/g, "-"), "report.json"))).toBe(true);

    const status = readCoachStatus(coachDirectory(stateDir));
    expect(status.families).toBe(3);
    expect(status.selected).toBe(3);
    expect(status.filed).toBe(3);
    expect(status.pending).toBe(0);
    expect(status.issues).toHaveLength(3);
    for (const issue of status.issues) {
      expect(issue.title.startsWith("[coach] ")).toBe(true);
      expect(issue.kind).toBe("command");
      expect(issue.family.length).toBeGreaterThan(0);
      expect(issue.url).toContain("https://forge.test/");
    }
  });

  test("a filed issue keeps the tool record's title and URL verbatim", async () => {
    const { repoDir, stateDir } = await workspace();
    const delivery = memoryDelivery();
    const longTitle = `[coach] ${"z".repeat(300)}`;
    const url = "https://forge.test/acme/fixture/issues/42";
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () =>
        collectionOf([
          sessionOf({
            id: "a",
            startedAt: instant(60),
            calls: [{ command: "bun run publish" }],
          }),
        ]),
      delivery,
      synthesize: stubSynthesis(() => ({ action: "file", title: longTitle, number: 42, url })),
      settings: { ...DEFAULT_COACH_SETTINGS, maxIssuesPerCycle: 20, allowlist: ["bun "] },
    });
    expect(result.report.action).toBe("filed");
    expect(delivery.created).toEqual([]);
    expect(result.report.issues).toHaveLength(1);
    expect(result.report.issues[0]?.title).toBe(longTitle);
    expect(result.report.issues[0]?.url).toBe(url);
    const ledger = loadLedger(coachDirectory(stateDir)).ledger;
    expect(ledger.families["bun run publish"]?.lastTitle).toBe(longTitle);
    expect(ledger.families["bun run publish"]?.lastIssueUrl).toBe(url);
    expect(ledger.pendingFiling).toEqual([]);
  });
});

describe("Coach settings compatibility", () => {
  test("an old file falls back on the new keys and ignores removed ones", async () => {
    const { stateDir } = await workspace();
    const legacy = Object.fromEntries([
      ["intervalMinutes", 45],
      ["maxPerHour", 2],
      ["maxPending", null],
      ["decision" + "Model", "typesafe/legacy-1.14"],
      ["approve" + "At", 0.9],
      ["reject" + "At", 0.1],
      ["reject" + "CooldownHours", 168],
    ]);
    await writeFile(
      join(coachDirectory(stateDir), "settings.json"),
      JSON.stringify(legacy),
    );
    expect(readCoachSettings(coachDirectory(stateDir))).toEqual({
      intervalMinutes: 45,
      maxPerHour: 2,
      maxPending: null,
      maxIssuesPerCycle: 2,
      allowlist: [],
    });
  });

  test("missing and invalid values fall back without rejecting the file", () => {
    expect(parseCoachSettings("{}")).toEqual(DEFAULT_COACH_SETTINGS);
    expect(
      parseCoachSettings(
        JSON.stringify({ intervalMinutes: 0, maxPerHour: 500, maxIssuesPerCycle: 99, allowlist: [""] }),
      ),
    ).toEqual(DEFAULT_COACH_SETTINGS);
    expect(parseCoachSettings("not json")).toBeUndefined();
    expect(isValidIssuesPerCycle(20)).toBe(true);
    expect(isValidIssuesPerCycle(21)).toBe(false);
    expect(isValidAllowlist(["bun "])).toBe(true);
  });
});

describe("Coach journal families", () => {
  test("the journal path records scopes and writes no comment", async () => {
    const { repoDir, stateDir } = await workspace();
    await mkdir(join(stateDir, "journal"), { recursive: true });
    await writeFile(
      `${journalFile(stateDir, repoDir)}`,
      [
        { kind: "question", text: "Same?", scope: "run-a", ts: instant(30) },
        { kind: "question", text: "Same?", scope: "run-b", ts: instant(20) },
      ]
        .map((row) => JSON.stringify({ repo: repoDir, port: 1, pid: 1, ...row }))
        .join("\n") + "\n",
    );
    const collection = collectionOf([], [
      { kind: "question", text: "Same?", scope: "run-a", ts: instant(30) },
      { kind: "question", text: "Same?", scope: "run-b", ts: instant(20) },
    ]);
    const delivery = memoryDelivery();
    const result = await runCycle({
      root: repoDir,
      stateDir,
      now: NOW,
      collect: () => collection,
      delivery,
      synthesize: stubSynthesis(() => ({ action: "file", title: "[coach] question: Same?" })),
      settings: { ...DEFAULT_COACH_SETTINGS, allowlist: ["question:"] },
    });
    expect(result.report.action).toBe("filed");
    expect(result.report.issues[0]?.title).toBe("[coach] question: Same?");
    expect(result.report.findings[0]?.kind).toBe("question");
  });
});

describe("Coach synthesizer provider order", () => {
  test("leads with the dashboard's published selection", async () => {
    const stateDir = await temporaryRoot();
    const now = NOW.toISOString();
    const row = (id: string, label: string) => ({
      id,
      provider: "opencode-go" as const,
      label,
      key: `key-${id}`,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    saveSubscriptions(stateDir, [row("alpha", "Alpha"), row("bravo", "Bravo")]);
    writeSelectionSnapshot(stateDir, {
      provider: "opencode-go",
      subscriptionId: "bravo",
      label: "Bravo",
      model: OPENCODE_GO_MODEL,
      remainingFraction: 1,
      checkedAt: now,
    });
    const peers = openCodePeers(stateDir, {});
    expect(peers.ok).toBe(true);
    if (peers.ok) expect(peers.value[0]?.subscriptionId).toBe("bravo");
  });
});

describe("Coach periodic read retries", () => {
  const ISSUE_URL = "https://github.com/acme/fixture/issues/41";

  async function seededActivity(reader: ForgeIssueReader, now: () => number) {
    const { repoDir, stateDir } = await workspace();
    seedCoachIssue(stateDir, ISSUE_URL);
    return coachActivity({ repoDir, stateDir, reader, now });
  }

  test("retries a transient read without an error and keeps the rows and read time", async () => {
    const reader = coachRetryReader();
    let clock = 1_000_000;
    const activity = await seededActivity(reader, () => clock);
    await readCoachOnce(activity);
    const successAt = clock;
    const before = activity.snapshot().issues;
    expect(before).toHaveLength(1);
    const reads = reader.calls;

    reader.failures.push("gh: HTTP 503: Service Unavailable");
    clock += 60_000;
    await readCoachOnce(activity);
    const retrying = activity.snapshot();
    expect(retrying.sync).toEqual({
      state: "stale",
      at: new Date(successAt).toISOString(),
      error: null,
    });
    expect(retrying.issues).toEqual(before);

    clock += 999;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(reads + 1);

    clock += 1;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(reads + 2);
    const recovered = activity.snapshot();
    expect(recovered.sync).toEqual({
      state: "ok",
      at: new Date(clock).toISOString(),
      error: null,
    });
    expect(recovered.issues).toEqual(before);
  });

  test("retries a transient read four times and surfaces the fifth failure", async () => {
    const reader = coachRetryReader();
    reader.failAll = "gh: HTTP 503: Service Unavailable";
    let clock = 5_000_000;
    const activity = await seededActivity(reader, () => clock);
    await readCoachOnce(activity);
    expect(reader.calls).toBe(1);
    expect(activity.snapshot().sync).toEqual({ state: "stale", at: null, error: null });

    let now = clock;
    let attempts = 1;
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      clock = now + delay - 1;
      await readCoachOnce(activity);
      expect(reader.calls).toBe(attempts);
      expect(activity.snapshot().sync.state).toBe("stale");
      expect(activity.snapshot().sync.error).toBeNull();

      clock = now + delay;
      await readCoachOnce(activity);
      now += delay;
      attempts += 1;
      expect(reader.calls).toBe(attempts);
      if (delay !== 8_000) {
        expect(activity.snapshot().sync).toEqual({ state: "stale", at: null, error: null });
      }
    }
    expect(attempts).toBe(5);
    const failed = activity.snapshot();
    expect(failed.sync.state).toBe("error");
    expect(failed.sync.error).toContain("Service Unavailable");
    expect(failed.error).toBeNull();

    clock = now + 1_000;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(attempts);
    expect(activity.snapshot().sync.state).toBe("error");
    clock = now + 60_000;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(attempts + 1);
    expect(activity.snapshot().sync.state).toBe("error");
  });

  test("a success during the retry schedule clears the state", async () => {
    const reader = coachRetryReader();
    reader.failures.push("gh: HTTP 502: Bad Gateway", "gh: HTTP 502: Bad Gateway");
    let clock = 7_000_000;
    const activity = await seededActivity(reader, () => clock);
    const start = clock;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(1);
    expect(activity.snapshot().sync).toEqual({ state: "stale", at: null, error: null });
    clock = start + 1_000;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(2);
    expect(activity.snapshot().sync).toEqual({ state: "stale", at: null, error: null });
    clock = start + 3_000;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(3);
    expect(activity.snapshot().sync).toEqual({
      state: "ok",
      at: new Date(clock).toISOString(),
      error: null,
    });
  });

  for (const [label, message] of [
    ["credentials", "gh: HTTP 401: Bad credentials"],
    ["a missing repository", "gh: HTTP 404: Not Found"],
    ["a malformed answer", "gh issue list did not print a JSON array"],
    ["missing configuration", "the coach activity needs DEVBOARD_GITEA_URL for a Gitea origin"],
  ] as const) {
    test(`a permanent read failure (${label}) is attempted once and surfaces at once`, async () => {
      const reader = coachRetryReader();
      reader.failAll = message;
      let clock = 9_000_000;
      const activity = await seededActivity(reader, () => clock);
      await readCoachOnce(activity);
      expect(reader.calls).toBe(1);
      const failed = activity.snapshot();
      expect(failed.sync).toEqual({ state: "error", at: null, error: message });
      expect(failed.error).toBeNull();

      clock += 1_000;
      await readCoachOnce(activity);
      expect(reader.calls).toBe(1);
      expect(activity.snapshot().sync.error).toBe(message);
    });
  }

  test("a rate-limited read surfaces once, raises no error, and waits a cadence", async () => {
    const reader = coachRetryReader();
    reader.failAll = "You have exceeded a secondary rate limit.";
    let clock = 11_000_000;
    const activity = await seededActivity(reader, () => clock);
    const start = clock;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(1);
    const limited = activity.snapshot();
    expect(limited.sync.state).toBe("error");
    expect(limited.sync.error).toContain("secondary rate limit");
    expect(limited.error).toBeNull();

    clock = start + 1_000;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(1);
    expect(activity.snapshot().sync.state).toBe("error");

    reader.failAll = null;
    clock = start + 60_000;
    await readCoachOnce(activity);
    expect(reader.calls).toBe(2);
    expect(activity.snapshot().sync).toEqual({
      state: "ok",
      at: new Date(clock).toISOString(),
      error: null,
    });
  });

  test("never runs two projection reads at once", async () => {
    const gate = Promise.withResolvers<void>();
    let calls = 0;
    const reader: ForgeIssueReader = {
      async project(urls: string[]) {
        calls += 1;
        await gate.promise;
        return urls.map((url) => ({ url, state: "pending" as const, version: null }));
      },
    };
    let clock = 13_000_000;
    const activity = await seededActivity(reader, () => clock);
    activity.snapshot();
    activity.snapshot();
    activity.snapshot();
    expect(calls).toBe(1);
    gate.resolve();
    await activity.settled();
    expect(calls).toBe(1);
    expect(activity.snapshot().sync.state).toBe("ok");
  });
});
