#!/usr/bin/env bun
/**
 * The orchestrator gate. Without `--live` it drives the real command line over
 * a stub tracker and a stub agent in a throwaway checkout, asserts the report,
 * the run directory, the argv and cwd, the state and ledger shape, the
 * singleton refusal, and containment, and writes no GitHub object.
 *
 * With `--live` it proves the whole chain against the real tracker: it seeds
 * one throwaway issue in the canonical repository, runs a source dashboard and
 * the orchestrator over it, and asserts that the first run captures the open
 * backlog, that the status item shows the run, that the issue created during
 * that run earns exactly one follow-up run, and that the state returns to idle
 * with no third run. The seeded issue is always closed in a finally path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadLedger } from "../orchestrator/ledger";
import { originRepository } from "../orchestrator/repository";
import { readStateFile, statePath, type OrchestratorIssue, type OrchestratorState } from "../orchestrator/state";
import { freePort, run, waitFor } from "./verification";

const harnessRoot = resolve(import.meta.dir, "..");
const stubAgent = join(harnessRoot, "tests", "fixtures", "stub-orchestrator-agent.ts");
const mainScript = join(harnessRoot, "orchestrator", "main.ts");
const live = process.argv.slice(2).includes("--live");

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const suffix = evidence === undefined ? "" : `: ${JSON.stringify(evidence)}`;
    throw new Error(`verify:orchestrator: ${message}${suffix}`);
  }
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

async function temporaryDirectory(name: string): Promise<string> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const directory = await mkdtemp(join(harnessRoot, ".tmp", `verify-orchestrator-${name}-`));
  return directory;
}

function readStateFileAt(path: string): OrchestratorState | undefined {
  return readStateFile(path);
}

function runDirectories(stateDir: string): string[] {
  const directory = join(stateDir, "orchestrator", "runs");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function readAgentLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function starts(path: string): Array<Record<string, unknown>> {
  return readAgentLog(path).filter((entry) => entry.event === "start");
}

function cli(args: string[], env: NodeJS.ProcessEnv = process.env): { code: number; stdout: string; stderr: string } {
  return run(process.execPath, [mainScript, ...args], { cwd: harnessRoot, env });
}

/** The canonical checkout of this harness, even when the script runs in a worktree. */
function canonicalRoot(): string {
  const result = run(
    "git",
    ["-C", harnessRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: harnessRoot },
  );
  check(result.code === 0, "the canonical checkout could not be discovered", result.stderr);
  return resolve(result.stdout.trim(), "..");
}

function git(directory: string, ...args: string[]): string {
  const result = run("git", ["-C", directory, ...args], { cwd: harnessRoot });
  check(result.code === 0, `git ${args.join(" ")} failed`, result.stderr);
  return result.stdout.trim();
}

/** A fake tracker and a fake agent, each recording what it was asked to do. */
async function toolBin(
  directory: string,
  issues: OrchestratorIssue[],
): Promise<{ bin: string; ompLog: string }> {
  const bin = join(directory, "bin");
  await mkdir(bin, { recursive: true });
  const ompLog = join(directory, "omp.log");
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh\ncat <<'JSON'\n${issues.map((entry) => JSON.stringify(entry)).join("\n")}\nJSON\n`,
  );
  await writeFile(
    join(bin, "omp"),
    `#!/bin/sh\npwd >> ${ompLog}\necho "$@" >> ${ompLog}\nexit 0\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "omp"), 0o755);
  return { bin, ompLog };
}

// ---------------------------------------------------------------------------
// Deterministic: the command line over a stub tracker and a stub agent.
// ---------------------------------------------------------------------------

async function deterministic(): Promise<void> {
  const base = await temporaryDirectory("stub");
  try {
    const root = join(base, "repo");
    await mkdir(join(root, ".devboard"), { recursive: true });
    await writeFile(join(root, ".devboard", "marker"), "harness\n");
    const init = run("git", ["init", "-q", root], { cwd: harnessRoot });
    check(init.code === 0, "the fixture checkout could not be created", init.stderr);
    git(root, "config", "user.email", "devboard@example.test");
    git(root, "config", "user.name", "Devboard Verify");
    git(root, "remote", "add", "origin", "https://github.com/acme/fixture.git");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "fixture");

    const issues: OrchestratorIssue[] = [
      { number: 41, title: "First stub issue", url: "https://example.test/41", createdAt: "2026-10-20T00:00:00Z" },
      { number: 42, title: "Second stub issue", url: "https://example.test/42", createdAt: "2026-10-21T00:00:00Z" },
      { number: 43, title: "Third stub issue", url: "https://example.test/43", createdAt: "2026-10-22T00:00:00Z" },
    ];
    const { bin, ompLog } = await toolBin(base, issues);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };

    const help = cli(["--help"], env);
    check(help.code === 0, "--help did not exit 0", help.stderr);

    const dry = cli(
      ["--once", "--dry-run", "--root", root, "--repo", "acme/fixture"],
      env,
    );
    check(dry.code === 0, "--dry-run did not exit 0", dry.stderr);
    const report = readReport(dry.stdout);
    check(report !== undefined, "the dry run did not print a report", dry.stdout);
    check(report.repo === "acme/fixture", "the report names another repository", report.repo);
    check(report.open === issues.length, "the report's open count is wrong", report);
    check(report.issues.length === issues.length, "the report's issue list is short", report);
    check(
      report.issues.every(
        (entry) =>
          typeof entry.number === "number" &&
          typeof entry.title === "string" &&
          typeof entry.url === "string" &&
          typeof entry.createdAt === "string",
      ),
      "an issue in the report has the wrong shape",
      report.issues[0],
    );
    check(report.action === "trigger", "the dry run does not want to trigger", report.action);
    const stateDir = join(root, ".devboard", ".tmp");
    check(
      !existsSync(join(stateDir, "orchestrator")),
      "the dry run created an orchestrator directory",
    );

    // A live singleton: the same state directory refuses the second process.
    const lockDir = join(stateDir, "orchestrator");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    const blocked = cli(["--once", "--root", root, "--repo", "acme/fixture"], env);
    check(blocked.code === 0, "a second invocation did not exit 0", blocked.stderr);
    check(blocked.stdout.includes("already running"), "a second invocation did not report the owner", blocked.stdout);
    check(!existsSync(statePath(stateDir)), "a blocked invocation wrote state");
    check(runDirectories(stateDir).length === 0, "a blocked invocation created a run directory");
    await rm(join(lockDir, "lock"));

    const once = cli(["--once", "--root", root, "--repo", "acme/fixture"], env);
    check(once.code === 0, "--once did not exit 0", once.stderr || once.stdout);

    const lines = readFileSync(ompLog, "utf8").trim().split("\n");
    check(lines[0] === root, "the agent did not run from the checkout root", lines[0]);
    check(
      lines[1] === "--print --auto-approve /implement-all-issues",
      "the default argv is not used verbatim",
      lines[1],
    );

    const state = readStateFileAt(statePath(stateDir));
    check(state !== undefined, "no state file was written");
    check(state.version === 1, "the state version is wrong", state.version);
    check(state.root === root && state.repo === "acme/fixture", "the state names another checkout", state);
    check(state.status === "idle", "a successful run did not return the state to idle", state.status);
    check(state.lastExitCode === 0 && state.lastError === null, "the state keeps a failure", state);
    check(state.open === 0 && state.issues.length === 0, "an idle state names issues", state);

    const ledger = loadLedger(stateDir);
    check(ledger.version === 1, "the ledger version is wrong", ledger.version);
    check(
      Object.keys(ledger.handled).sort().join(",") === "41,42,43",
      "the ledger does not record every captured issue",
      ledger.handled,
    );
    const runs = runDirectories(stateDir);
    check(runs.length === 1, "exactly one run directory was expected", runs);
    for (const name of ["command.json", "stdout.log", "stderr.log", "result.json"]) {
      check(existsSync(join(stateDir, "orchestrator", "runs", runs[0]!, name)), `the run lacks ${name}`);
    }
    const command = readRunCommand(join(stateDir, "orchestrator", "runs", runs[0]!));
    check(command !== undefined, "the run recorded an unreadable command");
    check(
      command.argv.join(" ") === "omp --print --auto-approve /implement-all-issues",
      "the run recorded another argv",
      command.argv,
    );
    check(command.cwd === root, "the run recorded another cwd", command.cwd);

    // Nothing the run wrote may leave the state directory inside `.devboard`.
    const harnessEntries = readdirSync(join(root, ".devboard")).sort();
    check(
      harnessEntries.join(",") === ".tmp,marker",
      "the run wrote outside .devboard/.tmp",
      harnessEntries,
    );

    console.log("verify:orchestrator: report, argv, cwd, state, ledger, runs, and singleton held");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Live: the real tracker, a real seeded issue, a source dashboard, a stub agent.
// ---------------------------------------------------------------------------

interface DevtoolsMessage {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
}

/** The smallest CDP client this proof needs: evaluate one expression. */
class Evaluation {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (value: Record<string, unknown>) => void>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    this.socket.onopen = () => opened.resolve();
    this.socket.onerror = () => opened.reject(new Error("the devtools socket failed"));
    this.socket.onmessage = (event) => {
      let reply: DevtoolsMessage;
      try {
        reply = JSON.parse(String(event.data)) as DevtoolsMessage;
      } catch {
        return;
      }
      if (typeof reply.id !== "number") return;
      this.pending.get(reply.id)?.(reply.result ?? {});
      this.pending.delete(reply.id);
    };
    await opened.promise;
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    const settled = Promise.withResolvers<Record<string, unknown>>();
    this.pending.set(id, settled.resolve);
    this.socket.send(JSON.stringify({ id, method, params }));
    return settled.promise;
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = result.result;
    if (typeof value !== "object" || value === null) return undefined;
    return (value as { value?: unknown }).value;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

function chromePath(): string {
  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) {
    if (Bun.file(candidate).size > 0) return candidate;
  }
  throw new Error("verify:orchestrator: Chrome is unavailable for the live proof");
}

/** A Chrome target with a devtools socket; anything else is not a page. */
function pageSocket(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const target = value as Record<string, unknown>;
  if (target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return undefined;
  return target.webSocketDebuggerUrl;
}

async function pageTarget(debugPort: number): Promise<string> {
  return waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
        const targets: unknown = await response.json();
        if (!Array.isArray(targets)) return undefined;
        for (const target of targets) {
          const socket = pageSocket(target);
          if (socket !== undefined) return socket;
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    "the Chrome page target",
    30_000,
  );
}

/** The argv and cwd a run directory recorded, or undefined for a damaged file. */
function readRunCommand(runDir: string): { argv: string[]; cwd: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runDir, "command.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.argv)) return undefined;
    if (!record.argv.every((entry): entry is string => typeof entry === "string")) return undefined;
    if (typeof record.cwd !== "string") return undefined;
    return { argv: record.argv, cwd: record.cwd };
  } catch {
    return undefined;
  }
}

/** The `--dry-run` report, validated rather than trusted. */
function readReport(text: string): {
  repo: string;
  open: number;
  issues: OrchestratorIssue[];
  action: string;
} | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.repo !== "string") return undefined;
    if (typeof record.open !== "number" || typeof record.action !== "string") return undefined;
    if (!Array.isArray(record.issues)) return undefined;
    const issues: OrchestratorIssue[] = [];
    for (const entry of record.issues) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const issue = entry as Record<string, unknown>;
      if (typeof issue.number !== "number") return undefined;
      if (typeof issue.title !== "string" || typeof issue.url !== "string") return undefined;
      if (typeof issue.createdAt !== "string") return undefined;
      issues.push({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        createdAt: issue.createdAt,
      });
    }
    return { repo: record.repo, open: record.open, issues, action: record.action };
  } catch {
    return undefined;
  }
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      try {
        const response = await fetch(url, { method: "HEAD" });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    url,
    timeoutMs,
  );
}

function openIssueNumbers(repository: string): number[] {
  const result = run(
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repository}/issues?state=open&per_page=100`,
      "--jq",
      ".[] | select(.pull_request == null) | .number",
    ],
    { cwd: harnessRoot },
  );
  check(result.code === 0, "the live tracker read failed", result.stderr);
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

async function liveProof(): Promise<void> {
  const marker = `[verify-orchestrator] ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;
  const base = await temporaryDirectory("live");
  const stateDir = join(base, "state");
  const agentLog = join(base, "agent.log");
  const profile = join(base, "chrome-profile");
  const root = canonicalRoot();
  const repository = originRepository(root) ?? "";
  let issueUrl: string | undefined;
  let dashboard: ChildProcess | undefined;
  let orchestrator: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  let evaluation: Evaluation | undefined;

  try {
    check(repository.length > 0, "the canonical checkout names no repository");
    const build = run("bun", ["run", "build"], { cwd: harnessRoot });
    check(build.code === 0, "the client build failed", build.stderr);

    // The first run must be earned by the backlog that is already open, so the
    // seeded issue can arrive while it runs.
    const backlog = openIssueNumbers(repository);
    check(backlog.length > 0, "the canonical repository has no open issue to start the first run");

    const port = await freePort();
    const browserPort = await freePort();
    dashboard = spawn("bun", ["run", "server/index.ts"], {
      cwd: harnessRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(port),
        ADRS_DIR: join(root, "adrs"),
        REPO_DIR: root,
        GOAL_FILE: join(root, "GOAL.md"),
        STATIC_DIR: join(harnessRoot, "dist"),
        STATE_DIR: stateDir,
        DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const dashboardLog = join(base, "dashboard.log");
    dashboard.stdout?.on("data", (chunk: Buffer) => {
      void Bun.write(dashboardLog, chunk, { createPath: true });
    });
    await waitForHttp(`http://127.0.0.1:${port}/`);

    await mkdir(profile, { recursive: true });
    chrome = spawn(
      chromePath(),
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--metrics-recording-only",
        `--remote-debugging-port=${browserPort}`,
        `--user-data-dir=${profile}`,
        "--window-size=1024,720",
        `http://127.0.0.1:${port}/`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const browser = new Evaluation(await pageTarget(browserPort));
    await browser.connect();
    evaluation = browser;
    // A raw window is smaller than its CSS viewport, and the shell refuses to
    // render below 1024x720; pin the metrics instead of trusting the window.
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(
      async () => {
        const ready = await browser.evaluate(
          "document.querySelector('[data-testid=\"app-shell\"]') !== null",
        );
        return ready === true ? true : undefined;
      },
      "the dashboard shell to render",
      30_000,
      100,
    );
    const hiddenBefore = await browser.evaluate(
      "document.querySelector('[data-testid=\"status-issues\"]') === null",
    );
    check(hiddenBefore === true, "the issue item is present before any state exists", hiddenBefore);

    const stubCommand =
      `${process.execPath} ${stubAgent} --log=${agentLog} --sleep=6000 ` +
      "--prompt=/implement-all-issues --exit=0";
    orchestrator = spawn(
      process.execPath,
      [
        mainScript,
        "--root",
        root,
        "--repo",
        repository,
        "--state-dir",
        stateDir,
        "--interval",
        "1s",
      ],
      {
        cwd: harnessRoot,
        env: { ...process.env, ORCHESTRATOR_AGENT_COMMAND: stubCommand },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const orchestratorLog = join(base, "orchestrator.log");
    const orchestratorOut = Bun.file(orchestratorLog).writer();
    orchestrator.stdout?.on("data", (chunk: Buffer) => orchestratorOut.write(chunk));
    orchestrator.stderr?.on("data", (chunk: Buffer) => orchestratorOut.write(chunk));

    const firstRun = await waitFor(
      () => {
        const state = readStateFileAt(statePath(stateDir));
        return state?.status === "running" ? state : undefined;
      },
      "the first run to start",
      30_000,
      100,
    );
    check(
      firstRun.issues.map((entry) => entry.number).sort((left, right) => left - right).join(",") ===
        backlog.join(","),
      "the first run did not capture the whole open backlog",
      { captured: firstRun.issues.map((entry) => entry.number), backlog },
    );
    check(firstRun.open === backlog.length, "the running state's open count is wrong", firstRun);

    const workingSince = Date.now();
    const workingText = await waitFor(
      async () => {
        const text = await browser.evaluate(
          "document.querySelector('[data-testid=\"status-issues\"]')?.textContent ?? null",
        );
        return typeof text === "string" && /^issues working \(\d+\)$/.test(text.trim())
          ? text.trim()
          : undefined;
      },
      "the status item to show the running state",
      5_000,
      200,
    );
    const runningDelay = Date.now() - workingSince;
    const runningState = readStateFileAt(statePath(stateDir));
    check(runningDelay <= 5_000, `the issue item took ${runningDelay}ms to show the run`);
    check(
      workingText === `issues working (${runningState?.open})`,
      "the status item does not show the state's open count",
      { workingText, open: runningState?.open },
    );

    const created = run(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        repository,
        "--title",
        `${marker} orchestrator live proof`,
        "--body",
        `${marker}\n\nThrowaway issue created by \`bun run verify:orchestrator -- --live\`. It is closed by the same run.`,
      ],
      { cwd: harnessRoot },
    );
    check(created.code === 0, "the throwaway issue could not be created", created.stderr);
    issueUrl = created.stdout.trim().split("\n").pop()?.trim();
    check(issueUrl !== undefined && issueUrl.startsWith("https://"), "the issue URL was not printed", created.stdout);
    const seeded = Number(issueUrl.split("/").pop());
    check(Number.isInteger(seeded) && seeded > 0, "the seeded issue number is unreadable", issueUrl);

    const followUp = await waitFor(
      () => {
        const state = readStateFileAt(statePath(stateDir));
        if (state?.status !== "running") return undefined;
        return state.issues.some((entry) => entry.number === seeded) ? state : undefined;
      },
      "the follow-up run to capture the seeded issue",
      40_000,
      200,
    );
    check(followUp.status === "running", "the follow-up state is not running", followUp);

    const closedAtIdle = await waitFor(
      () => {
        const state = readStateFileAt(statePath(stateDir));
        return state?.status === "idle" ? state : undefined;
      },
      "the state to return to idle",
      40_000,
      200,
    );
    check(closedAtIdle.lastExitCode === 0, "the final run did not succeed", closedAtIdle);

    const idleText = await waitFor(
      async () => {
        const text = await evaluation!.evaluate(
          "document.querySelector('[data-testid=\"status-issues\"]')?.textContent ?? null",
        );
        return typeof text === "string" && text.trim() === "issues idle" ? text.trim() : undefined;
      },
      "the status item to show the idle state",
      5_000,
      200,
    );
    check(idleText === "issues idle", "the status item does not show idle", idleText);

    const log = readAgentLog(agentLog);
    const invoked = log.filter((entry) => entry.event === "start");
    check(invoked.length === 2, "the stub agent was not invoked exactly twice", invoked.length);
    check(
      log.map((entry) => entry.event).join(",") === "start,end,start,end",
      "a second agent ran concurrently",
      log.map((entry) => entry.event),
    );
    check(
      invoked.every((entry) => entry.prompt === "/implement-all-issues"),
      "an invocation did not record the unscoped prompt",
      invoked.map((entry) => entry.prompt),
    );
    check(
      invoked.every((entry) => entry.cwd === root),
      "an invocation ran outside the canonical root",
      invoked.map((entry) => entry.cwd),
    );
    const ledger = loadLedger(stateDir);
    check(ledger.handled[String(seeded)] !== undefined, "the ledger does not record the seeded issue", ledger);

    const runs = runDirectories(stateDir);
    check(runs.length === 2, "exactly two run directories were expected", runs);
    const secondCommand = readRunCommand(join(stateDir, "orchestrator", "runs", runs[1]!));
    check(secondCommand !== undefined, "the follow-up recorded an unreadable command");
    check(secondCommand.argv.join(" ").includes("stub-orchestrator-agent"), "the follow-up ran another argv", secondCommand);

    // No third run within three intervals.
    await sleep(4_000);
    check(readAgentLog(agentLog).filter((entry) => entry.event === "start").length === 2, "a third run started");
    const finalState = readStateFileAt(statePath(stateDir));
    check(finalState?.status === "idle", "the state left idle on its own", finalState);
  } finally {
    if (issueUrl !== undefined) {
      const closed = run(
        "gh",
        [
          "issue",
          "close",
          issueUrl,
          "--repo",
          repository,
          "--reason",
          "not planned",
          "--comment",
          "Closed by `bun run verify:orchestrator -- --live`: this throwaway issue only proved the orchestrator's trigger chain.",
        ],
        { cwd: harnessRoot },
      );
      if (closed.code !== 0) {
        console.error(`verify:orchestrator: the throwaway issue was not closed: ${closed.stderr}`);
      } else {
        console.log(`verify:orchestrator: closed ${issueUrl}`);
      }
    }
    evaluation?.close();
    for (const child of [orchestrator, dashboard, chrome]) {
      try {
        child?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(base, { recursive: true, force: true });
  }

  const viewed = run("gh", ["issue", "view", issueUrl!, "--repo", repository, "--json", "state"], {
    cwd: harnessRoot,
  });
  check(viewed.code === 0, "the seeded issue could not be read back", viewed.stderr);
  check(viewed.stdout.includes('"CLOSED"'), "the seeded issue is not closed", viewed.stdout);
  console.log(`verify:orchestrator: live chain passed for ${issueUrl}`);
}

if (live) {
  await liveProof();
} else {
  await deterministic();
}
