import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pruneJournal } from "../server/journal";
import {
  collectEvidence,
  WINDOW_MS,
  type Collection,
  type Window,
} from "./collect";
import {
  discoverInstances,
  type Instance,
} from "./discovery";
import { analyzeEvidence, type Finding } from "./findings";
import {
  isSettled,
  loadLedger,
  markBlocked,
  markPublished,
  recordFindings,
  saveLedger,
  type Ledger,
} from "./ledger";

/**
 * One watchdog cycle: discover, collect, decide, and — only when the evidence
 * is new and the checkout is clean — hand a fresh worktree to a headless
 * agent, verify its change, merge, push, and publish.
 */

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgentResult extends CommandOutput {
  /** Session ids the agent's omp process created. */
  sessions?: string[];
}

export interface GateOutcome {
  ok: boolean;
  failed?: string;
  detail?: string;
}

export interface IntegrateOutcome {
  ok: boolean;
  /** The merged commit, when the merge happened. */
  commit?: string;
  /** True once the local merge was pushed. */
  pushed?: boolean;
  refreshed: number;
  deferred: string[];
  detail?: string;
}

export interface CycleContext {
  root: string;
  harness: string;
  stateDir: string;
  runDir: string;
  now: Date;
  window: Window;
  log: (line: string) => void;
}

export interface CycleDeps {
  git: (argv: string[], cwd: string) => CommandOutput;
  discover: (root: string) => Instance[];
  collect: (
    root: string,
    instances: Instance[],
    window: Window,
    selfSessions: Set<string>,
  ) => Collection;
  agent: (prompt: string, worktree: string, context: CycleContext) => Promise<AgentResult>;
  gate: (worktree: string, context: CycleContext) => Promise<GateOutcome>;
  integrate: (
    context: CycleContext,
    branch: string,
    base: string,
  ) => Promise<IntegrateOutcome>;
}

export interface ReportInstance {
  pid: number;
  port: number;
  repoDir: string;
  harness: string;
  instrumented: boolean;
  journal: string;
  legacyLog?: string;
}

export interface ReportFinding {
  category: string;
  source: string;
  ts: string;
  quote: string;
  fingerprint: string;
}

export interface Report {
  cycle: string;
  window: { start: string; end: string; minutes: number };
  instances: ReportInstance[];
  findings: ReportFinding[];
  action: "none" | "duplicate" | "blocked" | "published" | "failed";
  commit: string | null;
  dashboards: { refreshed: number; deferred: string[] };
  head: string | null;
  reason?: string;
  blocked?: string[];
  worktree?: string;
  malformed: number;
  unattributed: number;
}

export interface CycleOptions {
  root?: string;
  now?: Date;
  stateDir?: string;
  dryRun?: boolean;
  deps?: Partial<CycleDeps>;
}

export interface CycleResult {
  report: Report;
  exitCode: number;
  runDir?: string;
}

function gitTopLevel(): string {
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--show-toplevel"],
    cwd: dirname(import.meta.dir),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const top = result.stdout.toString().trim();
  if (result.exitCode !== 0 || top.length === 0) {
    throw new Error("watchdog: the harness is not inside a git checkout");
  }
  return top;
}

function defaultGit(argv: string[], cwd: string): CommandOutput {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...argv],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function commandFailure(result: CommandOutput): string | undefined {
  if (result.code === 0) return undefined;
  return result.stderr || result.stdout || `exit ${result.code}`;
}

function run(arguments_: string[], cwd: string, context: CycleContext): CommandOutput {
  context.log(`$ ${arguments_.join(" ")} (${cwd})`);
  const result = Bun.spawnSync({
    cmd: arguments_,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function createWorktree(root: string, now: Date, git: CycleDeps["git"]): {
  path: string;
  branch: string;
} {
  const name = `watchdog-${stamp(now)}`;
  const path = join(root, ".worktree", name);
  const branch = `watchdog/${stamp(now)}`;
  const added = git(
    ["worktree", "add", "--no-track", "-b", branch, path, "HEAD"],
    root,
  );
  const failure = commandFailure(added);
  if (failure !== undefined) throw new Error(`could not create the worktree: ${failure}`);
  return { path, branch };
}

/** Runs one watchdog cycle. The caller owns the singleton lock. */
export async function runCycle(options: CycleOptions = {}): Promise<CycleResult> {
  const root = resolve(options.root ?? gitTopLevel());
  const harness = join(root, ".devboard");
  const now = options.now ?? new Date();
  const window: Window = {
    start: new Date(now.getTime() - WINDOW_MS),
    end: now,
  };
  const stateDir = resolve(options.stateDir ?? join(harness, ".tmp", "watchdog"));
  const runDir = join(stateDir, "runs", stamp(now));
  const deps: CycleDeps = {
    git: defaultGit,
    discover: (target) => discoverInstances({ selfPids: new Set([process.pid]) }),
    collect: (target, instances, collectedWindow, selfSessions) =>
      collectEvidence({
        root: target,
        instances,
        window: collectedWindow,
        selfPids: new Set([process.pid]),
        selfSessions,
      }),
    agent: defaultAgent,
    gate: defaultGate,
    integrate: defaultIntegrate,
    ...options.deps,
  };
  if (!options.dryRun) mkdirSync(runDir, { recursive: true });
  const coordinatorLog = options.dryRun ? undefined : join(runDir, "coordinator.log");
  const context: CycleContext = {
    root,
    harness,
    stateDir,
    runDir,
    now,
    window,
    log(line: string) {
      const stamped = `${new Date().toISOString()} ${line}\n`;
      if (coordinatorLog !== undefined) {
        try {
          appendFileSync(coordinatorLog, stamped);
        } catch {
          // Reporting must not fail the cycle.
        }
      }
      process.stderr.write(`watchdog: ${line}\n`);
    },
  };

  const ledger = loadLedger(stateDir);
  const instances = deps.discover(root);
  context.log(`discovered ${instances.length} instance(s)`);

  if (!options.dryRun) {
    const harnesses = new Set([harness, ...instances.map((instance) => instance.harness)]);
    for (const served of harnesses) {
      const removed = pruneJournal(join(served, ".tmp"), {
        now,
        windowStart: window.start,
      });
      if (removed.length > 0) {
        context.log(`pruned ${removed.length} old journal file(s) in ${served}`);
      }
    }
  }

  const collection = deps.collect(root, instances, window, new Set(ledger.selfSessions));
  const findings = analyzeEvidence(collection.events, { root, window });
  context.log(
    `collected ${collection.events.length} event(s), ${findings.length} finding(s), ` +
      `${collection.malformed} malformed, ${collection.unattributed} unattributed`,
  );

  const headResult = deps.git(["rev-parse", "HEAD"], root);
  const head = headResult.code === 0 ? headResult.stdout : null;
  recordFindings(ledger, findings, now);

  const report: Report = {
    cycle: now.toISOString(),
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      minutes: 10,
    },
    instances: instances.map((instance) => ({
      pid: instance.pid,
      port: instance.port,
      repoDir: instance.repoDir,
      harness: instance.harness,
      instrumented: instance.instrumented,
      journal: instance.journal,
      ...(instance.legacyLog === undefined ? {} : { legacyLog: instance.legacyLog }),
    })),
    findings: findings.map((finding) => ({
      category: finding.category,
      source: finding.source,
      ts: finding.ts,
      quote: finding.quote,
      fingerprint: finding.fingerprint,
    })),
    action: "none",
    commit: null,
    dashboards: { refreshed: 0, deferred: [] },
    head,
    malformed: collection.malformed,
    unattributed: collection.unattributed,
  };

  const actionable = findings.filter(
    (finding) => !isSettled(ledger.findings[finding.fingerprint], finding, head),
  );

  if (findings.length === 0) {
    report.reason = "no actionable finding";
    context.log("clean window; no action");
    return finish(context, ledger, report, 0, options.dryRun);
  }

  if (actionable.length === 0) {
    report.action = "duplicate";
    report.reason = "every finding was already published or blocked at this HEAD";
    context.log("duplicate window; no action");
    return finish(context, ledger, report, 0, options.dryRun);
  }

  if (options.dryRun) {
    report.action = "blocked";
    report.reason = `dry run: ${actionable.length} actionable finding(s) not attempted`;
    context.log(report.reason);
    return { report, exitCode: 0 };
  }

  const dirty = deps
    .git(["status", "--porcelain"], root)
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (dirty.length > 0) {
    const paths = dirty.map((line) => line.slice(3).trim());
    report.action = "blocked";
    report.blocked = paths;
    report.reason = "uncommitted operator work blocks merge, push, and publish";
    markBlocked(ledger, actionable, "uncommitted operator work", head);
    context.log(`${report.reason}: ${paths.join(", ")}`);
    return finish(context, ledger, report, 0, options.dryRun);
  }

  let worktree: { path: string; branch: string };
  try {
    worktree = createWorktree(root, now, deps.git);
  } catch (error) {
    report.action = "failed";
    report.reason = error instanceof Error ? error.message : String(error);
    return finish(context, ledger, report, 1, options.dryRun);
  }
  report.worktree = worktree.path;
  context.log(`worktree ${worktree.path} on ${worktree.branch}`);

  const prompt = buildPrompt({
    root,
    harness,
    worktree: worktree.path,
    window,
    instances,
    findings: actionable,
  });
  const sessionsBefore = sessionFiles();
  const agent = await deps.agent(prompt, worktree.path, context);
  const sessionsAfter = sessionFiles();
  const newSessions = [...sessionsAfter].filter((name) => !sessionsBefore.has(name));
  for (const name of newSessions) {
    const match = /_([^_/]+)\.jsonl$/.exec(name);
    if (match?.[1] !== undefined && !ledger.selfSessions.includes(match[1])) {
      ledger.selfSessions.push(match[1]);
    }
  }
  if (agent.code !== 0) {
    report.action = "failed";
    report.reason = `agent session failed with exit ${agent.code}`;
    context.log(`${report.reason}${agent.stderr.length > 0 ? `: ${agent.stderr}` : ""}`);
    return finish(context, ledger, report, 1, options.dryRun);
  }

  const status = deps.git(["status", "--porcelain"], worktree.path);
  const changed = status.stdout.split("\n").filter((line) => line.trim().length > 0);
  if (changed.length === 0) {
    report.action = "blocked";
    report.reason = "agent made no change";
    report.worktree = worktree.path;
    markBlocked(ledger, actionable, "agent made no change", head);
    context.log(report.reason);
    return finish(context, ledger, report, 0, options.dryRun);
  }

  const committed = deps.git(["add", "-A"], worktree.path);
  if (committed.code !== 0) {
    report.action = "failed";
    report.reason = `could not stage the agent change: ${commandFailure(committed)}`;
    return finish(context, ledger, report, 1, options.dryRun);
  }
  const decision = deps.git(
    [
      "-c",
      "user.name=Devboard Watchdog",
      "-c",
      "user.email=watchdog@devboard.invalid",
      "commit",
      "-m",
      "watchdog: harden the harness",
    ],
    worktree.path,
  );
  const commitFailure = commandFailure(decision);
  if (commitFailure !== undefined) {
    report.action = "failed";
    report.reason = `could not commit the agent change: ${commitFailure}`;
    return finish(context, ledger, report, 1, options.dryRun);
  }

  const base = head ?? "HEAD";
  const diff = deps.git(["diff", "--name-only", `${base}..HEAD`], worktree.path);
  const paths = diff.stdout.split("\n").filter((line) => line.length > 0);
  const outside = paths.filter((path) => !path.startsWith(".devboard/"));
  if (paths.length === 0) {
    report.action = "blocked";
    report.reason = "agent's worktree branch has no committed change";
    markBlocked(ledger, actionable, "no committed change", head);
    return finish(context, ledger, report, 0, options.dryRun);
  }
  if (outside.length > 0) {
    report.action = "blocked";
    report.blocked = outside;
    report.reason = "agent changed paths outside .devboard";
    markBlocked(ledger, actionable, "outside .devboard", head);
    context.log(`${report.reason}: ${outside.join(", ")}`);
    return finish(context, ledger, report, 0, options.dryRun);
  }

  const gate = await deps.gate(worktree.path, context);
  if (!gate.ok) {
    report.action = "failed";
    report.reason = `verification failed at ${gate.failed ?? "a gate"}${
      gate.detail === undefined ? "" : `: ${gate.detail}`
    }`;
    context.log(report.reason);
    return finish(context, ledger, report, 1, options.dryRun);
  }
  context.log("verification passed");

  const integrated = await deps.integrate(context, worktree.branch, base);
  report.dashboards = {
    refreshed: integrated.refreshed,
    deferred: integrated.deferred,
  };
  if (!integrated.ok) {
    report.action = "failed";
    report.commit = integrated.commit ?? null;
    report.reason = integrated.pushed
      ? `push succeeded but publish failed: ${integrated.detail ?? "unknown error"}`
      : `integration failed: ${integrated.detail ?? "unknown error"}`;
    context.log(report.reason);
    return finish(context, ledger, report, 1, options.dryRun, actionable);
  }

  const commit = integrated.commit ?? head ?? null;
  report.action = "published";
  report.commit = commit;
  report.reason = `published ${commit ?? "the harness change"}`;

  if (integrated.refreshed > 0 || integrated.deferred.length > 0) {
    context.log(
      `refreshed ${integrated.refreshed} dashboard(s)` +
        (integrated.deferred.length > 0
          ? `; deferred ${integrated.deferred.join(", ")}`
          : ""),
    );
  }
  deps.git(["worktree", "remove", worktree.path], root);
  deps.git(["branch", "-d", worktree.branch], root);
  return finish(context, ledger, report, 0, options.dryRun, actionable);
}

function finish(
  context: CycleContext,
  ledger: Ledger,
  report: Report,
  exitCode: number,
  dryRun: boolean | undefined,
  published: Finding[] = [],
): CycleResult {
  if (published.length > 0 && report.commit !== null) {
    markPublished(ledger, published, report.commit);
  }
  saveLedger(context.stateDir, ledger);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (dryRun === true) return { report, exitCode };
  mkdirSync(context.runDir, { recursive: true });
  writeFileSync(join(context.runDir, "report.json"), json);
  writeFileSync(join(context.stateDir, "latest.json"), json);
  writeFileSync(join(context.runDir, "report.md"), renderMarkdown(report));
  return { report, exitCode, runDir: context.runDir };
}

function renderMarkdown(report: Report): string {
  const lines = [
    `# Watchdog cycle ${report.cycle}`,
    "",
    `- Window: ${report.window.start} .. ${report.window.end} (${report.window.minutes} minutes)`,
    `- Action: ${report.action}`,
    `- Commit: ${report.commit ?? "none"}`,
    `- Dashboards: ${report.dashboards.refreshed} refreshed, ` +
      `${report.dashboards.deferred.length} deferred`,
    `- Reason: ${report.reason ?? "none"}`,
    "",
    "## Instances",
    "",
    ...(report.instances.length === 0
      ? ["No dashboard was running."]
      : report.instances.map(
          (instance) =>
            `- port ${instance.port}: ${instance.repoDir} (pid ${instance.pid}, ` +
            `${instance.instrumented ? "instrumented" : "uninstrumented"})`,
        )),
    "",
    "## Findings",
    "",
    ...(report.findings.length === 0
      ? ["None."]
      : report.findings.map(
          (finding) =>
            `- ${finding.category} in ${finding.source} at ${finding.ts}: ${finding.quote}`,
        )),
    "",
  ];
  for (const path of report.blocked ?? []) lines.push(`- blocked path: ${path}`);
  return `${lines.join("\n")}\n`;
}

function buildPrompt(input: {
  root: string;
  harness: string;
  worktree: string;
  window: Window;
  instances: Instance[];
  findings: Finding[];
}): string {
  const findings = input.findings
    .map(
      (finding) =>
        `- [${finding.category}] ${finding.source} @ ${finding.ts}\n  ${finding.quote}`,
    )
    .join("\n");
  const instances =
    input.instances.length === 0
      ? "- none"
      : input.instances
          .map(
            (instance) =>
              `- port ${instance.port}: ${instance.repoDir} (pid ${instance.pid}, ` +
              `harness ${instance.harness})`,
          )
          .join("\n");
  return `You are the Devboard watchdog. Harden the harness from the evidence below.

# Window
${input.window.start.toISOString()} .. ${input.window.end.toISOString()} (UTC, inclusive)

# Repository
${input.root}

# Worktree
${input.worktree}
Work only in this worktree. It is a fresh git worktree on branch created from HEAD.

# Harness
${input.harness}

# Live dashboards
${instances}

# Evidence
${findings}

# Change policy
- Edit only paths under .devboard/** in the worktree. Never edit host files, root
  AGENTS.md, WATCHDOG.yml, adrs/, GOAL.md, .gitignore, or .github/.
- Follow AGENTS.md at the repository root and .devboard/AGENTS.md.
- Treat the schedule, ten-minute window, singleton lock, self-exclusion,
  verification gate, and scope limits as invariants: improve them, never weaken them.
- Fix the evidence, not the symptom: no suppression, special-casing, or deletion of
  the failing test or signal.
- Keep behavior invisible to the dashboard UI, HTTP/WebSocket event shapes, lifecycle
  stages, run/interview behavior, and publish semantics.
- Add or update deterministic tests for the change. No network, no real model.
- Commit nothing; the coordinator stages and commits your worktree changes and runs
  bun install --frozen-lockfile, bun test, bun run build, and
  bun run watchdog -- --collect --dry-run before merging.

# Output
Explain briefly what you changed and why. Do not ask questions.
`;
}

function sessionDirectory(): string {
  return join(homedir(), ".omp", "agent", "sessions", "-devboard");
}

function sessionFiles(): Set<string> {
  try {
    return new Set(readdirSync(sessionDirectory()).filter((name) => name.endsWith(".jsonl")));
  } catch {
    return new Set();
  }
}

async function defaultAgent(
  prompt: string,
  worktree: string,
  context: CycleContext,
): Promise<AgentResult> {
  const command = process.env.WATCHDOG_AGENT_COMMAND ?? "omp --print --auto-approve --max-time 45m";
  const argv = command.split(/\s+/).filter((part) => part.length > 0);
  context.log(`agent $ ${command}`);
  const child = Bun.spawn({
    cmd: argv,
    cwd: context.root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WATCHDOG_WORKTREE: worktree,
      WATCHDOG_WINDOW_START: context.window.start.toISOString(),
      WATCHDOG_WINDOW_END: context.window.end.toISOString(),
      WATCHDOG_RUN_DIR: context.runDir,
    },
  });
  child.stdin.write(prompt);
  await child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (stdout.length > 0) context.log(`agent stdout: ${stdout.slice(0, 4000)}`);
  if (stderr.length > 0) context.log(`agent stderr: ${stderr.slice(0, 4000)}`);
  return { code, stdout, stderr };
}

async function defaultGate(worktree: string, context: CycleContext): Promise<GateOutcome> {
  const harness = join(worktree, ".devboard");
  if (!existsSync(join(harness, "node_modules"))) {
    const installed = run(["bun", "install", "--frozen-lockfile"], harness, context);
    const failure = commandFailure(installed);
    if (failure !== undefined) return { ok: false, failed: "bun install", detail: failure };
  }
  const steps: [string, string[]][] = [
    ["bun test", ["bun", "test"]],
    ["bun run build", ["bun", "run", "build"]],
    [
      "watchdog self-check",
      ["bun", "run", "watchdog", "--", "--collect", "--dry-run"],
    ],
  ];
  for (const [name, argv] of steps) {
    const result = run(argv, harness, context);
    const failure = commandFailure(result);
    if (failure !== undefined) return { ok: false, failed: name, detail: failure };
  }
  return { ok: true };
}

async function defaultIntegrate(
  context: CycleContext,
  branch: string,
  base: string,
): Promise<IntegrateOutcome> {
  const git = (argv: string[]) => defaultGit(argv, context.root);
  const merged = git(["merge", "--ff-only", branch]);
  const mergeFailure = commandFailure(merged);
  if (mergeFailure !== undefined) {
    return { ok: false, refreshed: 0, deferred: [], detail: mergeFailure };
  }
  const commit = git(["rev-parse", "HEAD"]).stdout;
  const remotes = git(["remote"]).stdout.split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (remote === undefined) {
    return { ok: false, commit, refreshed: 0, deferred: [], detail: "no git remote" };
  }
  const pushed = git(["push", remote, "main"]);
  const pushFailure = commandFailure(pushed);
  if (pushFailure !== undefined) {
    return {
      ok: false,
      commit,
      refreshed: 0,
      deferred: [],
      detail: `push failed: ${pushFailure}`,
    };
  }
  const tip = git(["ls-remote", remote, "refs/heads/main"]).stdout.split(/\s+/)[0];
  if (tip !== commit) {
    return {
      ok: false,
      commit,
      pushed: true,
      refreshed: 0,
      deferred: [],
      detail: `the remote tip ${tip ?? "unknown"} does not name ${commit}`,
    };
  }
  const published = run(["bun", "run", "publish"], join(context.root, ".devboard"), context);
  const refreshed = Number(/refreshing (\d+) dashboard/.exec(published.stdout)?.[1] ?? "0");
  const deferred = [...published.stdout.matchAll(/^publish: port (\d+) .* has active work/gm)].map(
    (match) => match[1] ?? "",
  );
  const publishFailure = commandFailure(published);
  if (publishFailure !== undefined) {
    return {
      ok: false,
      commit,
      pushed: true,
      refreshed,
      deferred,
      detail: publishFailure,
    };
  }
  return { ok: true, commit, pushed: true, refreshed, deferred };
}
