#!/usr/bin/env bun
/**
 * The deterministic Issues mode gate. It runs the real detached worker against
 * throwaway git checkouts, a stub `gh`, and stub ACP peers: Start, one peer per
 * open unhandled issue in the same poll, per-agent activity and answers, the
 * per-issue cooldown, an issue opened mid-run, pause draining every peer, Stop
 * closing every peer, server-restart reattach, per-repository isolation,
 * same-repository attach, another-state-directory refusal, legacy-lock refusal,
 * and the absence of any systemd write.
 *
 * Every fixture, state directory, browser profile, and log lives under
 * `.devboard/.tmp`. It never contacts GitHub and never starts a real agent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fixtureRecord } from "../server/fixtures/adr-source";
import { writeCommand } from "../issues/control";
import { lockPath, controlDirectory, runsDirectory, statePath } from "../issues/paths";
import { readState, type IssuesState } from "../issues/state";
import { freePort, run, waitFor } from "./verification";

const harnessRoot = resolve(import.meta.dir, "..");
const root = join(harnessRoot, ".tmp", `verify-issues-${Date.now()}`);
const stubGh = join(harnessRoot, "tests", "fixtures", "issues-stub-gh.ts");
const stubAcp = join(harnessRoot, "tests", "fixtures", "issues-stub-acp.ts");
const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`;
    throw new Error(`verify:issues: ${message}${detail}`);
  }
}

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("verify:issues: Chrome is unavailable");
}

async function repository(name: string, origin: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(join(directory, "adrs"), { recursive: true });
  await mkdir(join(directory, ".devboard"), { recursive: true });
  await writeFile(join(directory, "GOAL.md"), "# Fixture goal\n");
  await writeFile(join(directory, "adrs", "0001-fixture.md"), fixtureRecord("0001-fixture.md", "Fixture"));
  const git = (args: string[]) => {
    const result = run("git", ["-C", directory, ...args]);
    check(result.code === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "devboard@example.test"]);
  git(["config", "user.name", "Devboard Verify"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  git(["remote", "add", "origin", `https://github.com/${origin}.git`]);
  return directory;
}

interface Issue {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  labels: string[];
}

function issue(number: number, labels: string[] = []): Issue {
  return {
    number,
    title: `Fixture issue ${number}`,
    html_url: `https://github.com/acme/fixture/issues/${number}`,
    created_at: `2026-10-${String(20 + (number % 5)).padStart(2, "0")}T00:00:00Z`,
    labels,
  };
}

async function writeStore(path: string, issues: Issue[]): Promise<void> {
  await writeFile(path, `${JSON.stringify(issues, null, 2)}\n`);
}

async function makeToolBin(): Promise<{ bin: string; marker: string; home: string }> {
  const bin = join(root, "bin");
  const home = join(root, "home");
  const marker = join(root, "systemd-invoked");
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, ".omp", "commands"), { recursive: true });
  await mkdir(join(home, ".omp", "extensions"), { recursive: true });
  await writeFile(
    join(home, ".omp", "commands", "implement-issue.md"),
    "# implement issue\n\nFixture command.\n",
  );
  await writeFile(join(home, ".omp", "extensions", "implement-goal-issue.ts"), "export {};\n");
  await writeFile(join(bin, "gh"), `#!/bin/sh\nexec ${process.execPath} ${stubGh} "$@"\n`);
  await writeFile(join(bin, "omp"), "#!/bin/sh\nexit 0\n");
  for (const name of ["systemctl", "loginctl"]) {
    await writeFile(
      join(bin, name),
      `#!/bin/sh\necho "${name} $@" >> "${marker}"\nexit 0\n`,
    );
  }
  for (const name of ["gh", "omp", "systemctl", "loginctl"]) {
    run("chmod", ["+x", join(bin, name)]);
  }
  return { bin, marker, home };
}

interface FixturePaths {
  repo: string;
  stateDir: string;
  store: string;
  ghLog: string;
  acpLog: string;
  finish: string;
  failMarker: string;
}

async function fixture(name: string, origin: string): Promise<FixturePaths> {
  const repo = await repository(name, origin);
  const base = join(root, name);
  const paths = {
    repo,
    stateDir: join(base, "state"),
    store: join(base, "issues.json"),
    ghLog: join(base, "gh.log"),
    acpLog: join(base, "acp.log"),
    finish: join(base, "acp.finish"),
    failMarker: join(base, "acp.failed-once"),
  };
  fixtures.push(paths);
  return paths;
}

interface Dashboard {
  child: ChildProcess;
  port: number;
}

async function startDashboard(
  paths: FixturePaths,
  tools: { bin: string; home: string },
  marker: string,
): Promise<Dashboard> {
  const port = await freePort();
  const staticDir = join(harnessRoot, "dist");
  const child = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ADRS_DIR: join(paths.repo, "adrs"),
      REPO_DIR: paths.repo,
      GOAL_FILE: join(paths.repo, "GOAL.md"),
      STATIC_DIR: staticDir,
      STATE_DIR: paths.stateDir,
      HOME: tools.home,
      PATH: `${tools.bin}:${process.env.PATH ?? ""}`,
      AGENT_COMMAND: `${process.execPath} ${stubAcp}`,
      ISSUES_STUB_STORE: paths.store,
      ISSUES_STUB_GH_LOG: paths.ghLog,
      ISSUES_STUB_ACP_LOG: paths.acpLog,
      ISSUES_STUB_ACP_FINISH: paths.finish,
      ISSUES_STUB_ACP_QUESTION: "1",
      ISSUES_STUB_ACP_FAIL_PROMPT: "/implement-issue 6",
      ISSUES_STUB_ACP_FAIL_MARKER: paths.failMarker,
      ISSUES_STUB_SYSTEMD_MARKER: marker,
      DEVBOARD_UPDATE_INTERVAL_MS: "600000",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    `dashboard ${paths.repo}`,
    30_000,
  );
  return { child, port };
}

async function stopDashboard(dashboard: Dashboard): Promise<void> {
  if (dashboard.child.exitCode !== null) return;
  dashboard.child.kill("SIGTERM");
  await waitFor(
    () => (dashboard.child.exitCode !== null || dashboard.child.signalCode !== null ? true : undefined),
    "the dashboard to exit",
    10_000,
  ).catch(() => undefined);
}

function stateOf(paths: FixturePaths): IssuesState | undefined {
  return readState(statePath(paths.stateDir, paths.repo));
}

async function waitState(
  paths: FixturePaths,
  description: string,
  predicate: (state: IssuesState) => boolean,
  timeoutMs = 10_000,
): Promise<IssuesState> {
  try {
    return await waitFor(
      () => {
        const state = stateOf(paths);
        return state !== undefined && predicate(state) ? state : undefined;
      },
      description,
      timeoutMs,
      50,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstate: ${JSON.stringify(stateOf(paths))}`,
    );
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function workerPids(repo: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    let argv: string;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (argv.includes(join("issues", "worker.ts")) && argv.includes(repo)) pids.push(pid);
  }
  return pids.sort((left, right) => left - right);
}

function acpLogLines(paths: FixturePaths): string[] {
  try {
    return readFileSync(paths.acpLog, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function promptLines(paths: FixturePaths): string[] {
  return acpLogLines(paths)
    .filter((line) => line.startsWith("prompt "))
    .map((line) => line.slice("prompt ".length));
}

interface SocketMessage {
  type?: string;
  [key: string]: unknown;
}

class Socket {
  private readonly socket: WebSocket;
  readonly messages: SocketMessage[] = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  }

  async open(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    this.socket.onopen = () => {
      this.socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as SocketMessage;
          this.messages.push(message);
        } catch {
          // An unparseable frame is not part of the contract under test.
        }
      };
      opened.resolve();
    };
    this.socket.onerror = () => opened.reject(new Error("websocket failed"));
    await opened.promise;
  }

  mark(): number {
    return this.messages.length;
  }

  send(command: unknown): void {
    this.socket.send(JSON.stringify(command));
  }

  async waitFrom(
    from: number,
    predicate: (message: SocketMessage) => boolean,
    description: string,
    timeoutMs = 10_000,
  ): Promise<SocketMessage> {
    return await waitFor(
      () => this.messages.slice(from).find(predicate),
      description,
      timeoutMs,
      25,
    );
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

class Devtools {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (reply: Record<string, unknown>) => void>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    this.socket.onopen = () => opened.resolve();
    this.socket.onerror = () => opened.reject(new Error("devtools websocket failed"));
    await opened.promise;
    this.socket.onmessage = (event) => {
      let reply: Record<string, unknown>;
      try {
        reply = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof reply.id !== "number") return;
      this.pending.get(reply.id)?.(reply);
      this.pending.delete(reply.id);
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    const id = this.nextId++;
    this.pending.set(id, resolve);
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
    const result = reply.result;
    if (typeof result !== "object" || result === null || !("result" in result)) return undefined;
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
  return await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
          signal: AbortSignal.timeout(1500),
        });
        const targets = (await response.json()) as Array<Record<string, unknown>>;
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.webSocketDebuggerUrl === "string" &&
            typeof target.url === "string" &&
            target.url.includes(`:${dashboardPort}/`),
        );
        return typeof page?.webSocketDebuggerUrl === "string" ? page.webSocketDebuggerUrl : undefined;
      } catch {
        return undefined;
      }
    },
    "the Chrome page target",
    30_000,
  );
}

async function click(devtools: Devtools, testid: string): Promise<void> {
  await waitFor(
    async () =>
      (await devtools
        .evaluate(
          `(() => {
            const element = document.querySelector('[data-testid="${testid}"]');
            return element !== null && element.disabled !== true;
          })()`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    `${testid} to be enabled`,
    15_000,
  );
  await devtools.evaluate(
    `(() => { const element = document.querySelector('[data-testid="${testid}"]'); if (element === null) return false; element.click(); return true; })()`,
  );
}

async function stopWorker(paths: FixturePaths): Promise<void> {
  const state = stateOf(paths);
  if (state !== undefined && state.enabled) {
    writeCommand(controlDirectory(paths.stateDir, paths.repo), { type: "stop" });
    await waitFor(
      () => {
        const current = stateOf(paths);
        return current !== undefined && current.lifecycle === "stopped" ? true : undefined;
      },
      `worker for ${paths.repo} to stop`,
      10_000,
    ).catch(() => undefined);
  }
  const owner = (() => {
    try {
      return JSON.parse(readFileSync(lockPath(paths.repo), "utf8")) as { pid?: unknown };
    } catch {
      return undefined;
    }
  })();
  if (typeof owner?.pid === "number" && processAlive(owner.pid)) {
    process.kill(owner.pid, "SIGTERM");
  }
}

const startedDashboards: Dashboard[] = [];
const fixtures: FixturePaths[] = [];
let chrome: ChildProcess | undefined;
let devtools: Devtools | undefined;

try {
  await mkdir(root, { recursive: true });
  const tools = await makeToolBin();

  /* ---------------------------------------------------------------- */
  /* 1. Start the dashboard, open Issues, and click Start             */
  /* ---------------------------------------------------------------- */
  const a = await fixture("repo-a", "acme/fixture-a");
  await writeStore(a.store, []);
  const dashboardA = await startDashboard(a, tools, tools.marker);
  startedDashboards.push(dashboardA);

  const debugPort = await freePort();
  const profile = join(root, "chrome-profile");
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
      "--window-size=1440,900",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${dashboardA.port}/`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const socketUrl = await pageTarget(debugPort, dashboardA.port);
  devtools = new Devtools(socketUrl);
  await devtools.connect();
  await devtools.send("Runtime.enable");
  await devtools.send("Page.enable");

  await click(devtools, "mode-issues");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.querySelector('[data-testid="issues-overview"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Issues overview",
    15_000,
  );
  check(workerPids(a.repo).length === 0, "starting the dashboard started a worker");
  check(!existsSync(lockPath(a.repo)), "starting the dashboard took the repo lock");
  await click(devtools, "issues-start");

  const idle = await waitState(
    a,
    "the worker to start idle",
    (state) => state.lifecycle === "idle" && state.worker !== null,
    15_000,
  );
  check(idle.worker!.pid !== dashboardA.child.pid, "the worker is the dashboard process", idle.worker);
  check(existsSync(lockPath(a.repo)), "the repo-anchored lock is missing");
  check(idle.poll.intervalMs === 2000, "the poll interval is not two seconds", idle.poll);
  check(workerPids(a.repo).length === 1, "Start did not spawn exactly one worker");

  /* ---------------------------------------------------------- */
  /* 2. Four open issues start four peers in one poll            */
  /* ---------------------------------------------------------- */
  await writeStore(a.store, [issue(1), issue(2), issue(3, ["goal"]), issue(4, ["goal"])]);
  const fleet = await waitState(
    a,
    "four peers in one poll",
    (state) => state.lifecycle === "running" && state.agents.length === 4,
    5000,
  );
  const issueNumbers = fleet.agents.map((agent) => agent.issueNumber).sort((left, right) => left - right);
  check(
    issueNumbers.join(",") === "1,2,3,4",
    "the four peers do not cover the four open issues",
    fleet.agents,
  );
  check(
    new Set(fleet.agents.map((agent) => agent.runId)).size === 4,
    "two agents share a run id",
    fleet.agents,
  );
  check(
    fleet.queue.every((entry) => entry.agentRunId !== null),
    "the queue does not name each issue's agent run",
    fleet.queue,
  );

  const prompts = promptLines(a);
  for (const expected of [
    "/implement-issue 1",
    "/implement-issue 2",
    "/implement-goal-issue 3",
    "/implement-goal-issue 4",
  ]) {
    check(prompts.includes(expected), `the ${expected} prompt is missing`, prompts);
  }
  check(
    !prompts.some((prompt) => prompt.startsWith("/implement-all-issues")),
    "an /implement-all-issues prompt was sent",
    prompts,
  );

  const starts = acpLogLines(a).filter((line) => line.startsWith("start "));
  check(starts.length === 4, `the four peers did not all start in one poll: ${starts.length}`, starts);
  check(
    starts.every((line) => line.includes(` ${resolve(a.repo)}`)),
    "an ACP peer did not start in REPO_DIR",
    starts,
  );
  check(
    acpLogLines(a).some((line) =>
      line.startsWith("permission ") &&
      line.includes('"optionId":"allow-once"'),
    ),
    "a permission was not auto-approved",
    acpLogLines(a),
  );

  // Per-agent run directories, each covering exactly its own issue.
  const runsBase = runsDirectory(a.stateDir, a.repo);
  for (const agent of fleet.agents) {
    const directory = join(runsBase, agent.runId);
    check(existsSync(join(directory, "run.json")), `run ${agent.runId} has no run.json`, agent);
    check(existsSync(join(directory, "activity.json")), `run ${agent.runId} has no activity`, agent);
    const run = JSON.parse(readFileSync(join(directory, "run.json"), "utf8")) as {
      issues?: Array<{ number: number }>;
    };
    check(
      run.issues?.length === 1 && run.issues[0]?.number === agent.issueNumber,
      `run ${agent.runId} does not cover only issue ${agent.issueNumber}`,
      run.issues,
    );
  }

  // Conditional polling: a later poll carries If-None-Match and gets a 304.
  await waitFor(
    () => {
      try {
        return readFileSync(a.ghLog, "utf8").includes('"If-None-Match:') ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "a conditional poll",
    8_000,
    50,
  );

  // Two polls later, no issue received a second peer.
  await Bun.sleep(2500);
  const secondStarts = acpLogLines(a).filter((line) => line.startsWith("start "));
  check(secondStarts.length === 4, "a second poll started a duplicate peer", secondStarts);

  /* ---------------------------------------------------------- */
  /* 3. Per-agent questions and per-run answers                 */
  /* ---------------------------------------------------------- */
  const asking = await waitState(
    a,
    "four pending questions",
    (state) => state.agents.every((agent) => agent.question !== null),
    8000,
  );
  const firstAgent = asking.agents[0]!;
  const otherAgents = asking.agents.slice(1);
  const socketA = new Socket(dashboardA.port);
  await socketA.open();

  /** Answers every pending question so no peer waits on one before finishing. */
  const answerPending = async (socket: Socket): Promise<void> => {
    for (;;) {
      const current = stateOf(a);
      if (current === undefined) return;
      const pending = current.agents.filter((agent) => agent.question !== null);
      if (pending.length === 0) return;
      for (const agent of pending) {
        socket.send({
          type: "answerIssues",
          id: agent.question!.id,
          value: `scope for ${agent.issueNumber}`,
          runId: agent.runId,
        });
      }
      await waitState(
        a,
        "every pending question to clear",
        (state) =>
          pending.every(
            (agent) =>
              state.agents.find((candidate) => candidate.runId === agent.runId)?.question == null,
          ),
        8000,
      );
    }
  };
  socketA.send({
    type: "answerIssues",
    id: firstAgent.question!.id,
    value: "the whole issue",
    runId: firstAgent.runId,
  });
  const answered = await waitState(
    a,
    "the first agent's question to clear",
    (state) =>
      state.agents.find((agent) => agent.runId === firstAgent.runId)?.question === null,
    8000,
  );
  check(
    otherAgents.every(
      (agent) =>
        answered.agents.find((candidate) => candidate.runId === agent.runId)?.question !== null,
    ),
    "answering one agent cleared another agent's question",
    answered.agents,
  );

  for (const agent of otherAgents) {
    const current = stateOf(a)!;
    const pending = current.agents.find((candidate) => candidate.runId === agent.runId);
    if (pending?.question == null) continue;
    socketA.send({
      type: "answerIssues",
      id: pending.question.id,
      value: `answer for ${agent.issueNumber}`,
      runId: agent.runId,
    });
    await waitState(
      a,
      `the question for #{agent.issueNumber} to clear`,
      (state) =>
        state.agents.find((candidate) => candidate.runId === agent.runId)?.question === null,
      8000,
    );
  }

  // Activity streams only once a peer has passed its question; every agent's
  // own file then carries its own lines.
  await waitFor(
    () => {
      const current = stateOf(a);
      if (current === undefined || current.agents.length !== 4) return undefined;
      const ready = current.agents.every((agent) => {
        try {
          const activity = JSON.parse(
            readFileSync(join(runsBase, agent.runId, "activity.json"), "utf8"),
          ) as unknown;
          return Array.isArray(activity) && activity.length > 0;
        } catch {
          return false;
        }
      });
      return ready ? true : undefined;
    },
    "every agent's activity file",
    10_000,
    50,
  );

  // A connect-time replay carries every running agent's activity.
  const replaySocket = new Socket(dashboardA.port);
  await replaySocket.open();
  const replays = await waitFor(
    () => {
      const messages = replaySocket.messages.filter(
        (message) => message.type === "issuesActivity" && message.replay === true,
      );
      return messages.length >= 4 ? messages : undefined;
    },
    "the replayed activity of every agent",
    10_000,
    25,
  );
  check(replays.length === 4, `the replay carried ${replays.length} agents`, replays);
  const replayRuns = replays.map((message) => String(message.runId)).sort();
  check(
    replayRuns.join(",") === fleet.agents.map((agent) => agent.runId).sort().join(","),
    "the replay does not cover every agent",
    replayRuns,
  );
  replaySocket.close();

  // The Overview names the running-agent count and shows no singular activity.
  const overviewChrome = await devtools.evaluate(
    `(() => ({
      agents: document.querySelector('[data-testid="issues-running-agents"]')?.textContent?.trim() ?? "",
      cooldowns: document.querySelector('[data-testid="issues-cooldowns"]')?.textContent?.trim() ?? "",
      singularActivity: document.querySelectorAll('[data-testid="issues-activity"]').length,
      singularQuestion: document.querySelectorAll('[data-testid="issues-question"]').length,
    }))()`,
  ) as { agents: string; cooldowns: string; singularActivity: number; singularQuestion: number };
  check(overviewChrome.agents.startsWith("4 running"), "the overview lost the running-agent count", overviewChrome);
  check(overviewChrome.singularActivity === 0, "the overview still renders one activity log", overviewChrome);
  check(overviewChrome.singularQuestion === 0, "the overview still renders one question", overviewChrome);

  await click(devtools, "open-issues-agents");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelectorAll('[data-testid="issues-agent"]').length === 4 &&
           document.querySelector('[data-testid="issues-agents-page"]') !== null`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the four agent cards",
    10_000,
  );
  const cardOrder = (await devtools.evaluate(
    `[...document.querySelectorAll('[data-testid="issues-agent"]')].map((card) => card.getAttribute("data-issue"))`,
  )) as string[];
  check(cardOrder.join(",") === "1,2,3,4", "the agent cards are not sorted by issue", cardOrder);

  /* ---------------------------------------------------------- */
  /* 4. An issue opened mid-run gets its own peer               */
  /* ---------------------------------------------------------- */
  await writeStore(a.store, [
    issue(1),
    issue(2),
    issue(3, ["goal"]),
    issue(4, ["goal"]),
    issue(5),
  ]);
  const withNewcomer = await waitState(
    a,
    "the newly opened issue to get its own peer",
    (state) => state.agents.length === 5,
    8000,
  );
  await waitFor(
    () => (promptLines(a).includes("/implement-issue 5") ? true : undefined),
    "the new issue's own prompt",
    8000,
    50,
  );
  const originalRuns = fleet.agents.map((agent) => agent.runId);
  check(
    originalRuns.every((runId) =>
      withNewcomer.runs.some((run) => run.runId === runId && run.status === "running"),
    ),
    "starting the new peer shortened or restarted another agent",
    withNewcomer.runs,
  );

  /* ---------------------------------------------------------- */
  /* 5. One failure cools down only its own issue                */
  /* ---------------------------------------------------------- */
  await writeStore(a.store, [
    issue(1),
    issue(2),
    issue(3, ["goal"]),
    issue(4, ["goal"]),
    issue(5),
    issue(6),
  ]);
  const cooled = await waitState(
    a,
    "issue 6's per-issue cooldown",
    (state) => typeof state.cooldowns["6"] === "string",
    8000,
  );
  check(
    Object.keys(cooled.cooldowns).join(",") === "6",
    "a failure cooled another issue",
    cooled.cooldowns,
  );
  check(cooled.agents.length === 5, "the failure removed another agent", cooled.agents);
  const failingRun = cooled.runs.find(
    (run) => run.issueNumbers.includes(6) && run.status === "failed",
  );
  check(failingRun !== undefined, "the failed run was not recorded", cooled.runs);
  check(
    failingRun!.firstStderrLine === "stub failure for /implement-issue 6",
    "the failed run lost its first stderr line",
    failingRun,
  );

  // Check now clears the cooldown and retries the issue.
  await click(devtools, "open-issues-overview");
  await click(devtools, "issues-check-now");
  await waitState(
    a,
    "the cooldown to clear",
    (state) => Object.keys(state.cooldowns).length === 0,
    8000,
  );
  await waitFor(
    () => (promptLines(a).filter((prompt) => prompt === "/implement-issue 6").length >= 2 ? true : undefined),
    "the retried issue 6 peer",
    8000,
    50,
  );
  await waitState(
    a,
    "the retried issue 6 to ask its question",
    (state) => state.agents.some((agent) => agent.issueNumber === 6 && agent.question !== null),
    8000,
  );
  await answerPending(socketA);

  /* ---------------------------------------------------------- */
  /* 6. Pause drains every peer                                  */
  /* ---------------------------------------------------------- */
  const beforePause = stateOf(a)!;
  const peerPids = beforePause.agents
    .map((agent) => agent.acp?.pid)
    .filter((pid): pid is number => typeof pid === "number" && pid > 0);
  check(peerPids.length >= 4, "the state does not record every ACP child", beforePause.agents);
  await click(devtools, "issues-pause");
  await waitState(a, "pausing", (state) => state.lifecycle === "pausing");
  check(peerPids.every(processAlive), "Pause killed an ACP peer");
  await writeFile(a.finish, "finish\n");
  const paused = await waitState(a, "paused after the drain", (state) => state.lifecycle === "paused", 20_000);
  check(paused.paused, "the worker is not paused", paused);
  check(paused.agents.length === 0, "a peer survived the drain", paused.agents);
  check(
    paused.runs.filter((run) => run.status === "succeeded").length >= 4,
    "the drained runs did not succeed",
    paused.runs,
  );
  await waitFor(
    () => (peerPids.every((pid) => !processAlive(pid)) ? true : undefined),
    "every ACP peer to exit",
    10_000,
    50,
  );
  await rm(a.finish, { force: true });

  /* ---------------------------------------------------------- */
  /* 7. Stop closes every peer and writes no cooldown            */
  /* ---------------------------------------------------------- */
  await writeStore(a.store, [
    issue(1),
    issue(2),
    issue(3, ["goal"]),
    issue(4, ["goal"]),
    issue(5),
    issue(6),
    issue(7),
  ]);
  await click(devtools, "issues-resume");
  const restarting = await waitState(
    a,
    "issue 7 to start",
    (state) => state.agents.some((agent) => agent.issueNumber === 7),
    15_000,
  );
  const stopPids = restarting.agents
    .map((agent) => agent.acp?.pid)
    .filter((pid): pid is number => typeof pid === "number" && pid > 0);
  const stoppingPid = stateOf(a)!.worker!.pid;
  await click(devtools, "issues-stop");
  const stopped = await waitState(a, "stopped", (state) => state.lifecycle === "stopped", 10_000);
  check(stopped.enabled === false, "Stop left the worker enabled", stopped);
  check(Object.keys(stopped.cooldowns).length === 0, "Stop recorded a cooldown", stopped.cooldowns);
  check(stopped.agents.length === 0, "an agent survived Stop", stopped.agents);
  check(
    stopped.runs.some((entry) => entry.status === "stopped"),
    "Stop did not record a stopped run",
    stopped.runs,
  );
  check(
    stopped.queue.find((entry) => entry.number === 7)?.handled === false,
    "Stop marked the captured issue handled",
    stopped.queue,
  );
  check(!existsSync(lockPath(a.repo)), "Stop did not release the repo lock");
  await waitFor(
    () => (stopPids.every((pid) => !processAlive(pid)) ? true : undefined),
    "every ACP peer to exit on Stop",
    10_000,
    50,
  );
  await waitFor(() => (!processAlive(stoppingPid) ? true : undefined), "the worker to exit", 10_000, 50);

  /* ------------------------------------------------------------- */
  /* 8. A killed dashboard leaves the worker; the replacement attaches */
  /* ------------------------------------------------------------- */
  await rm(a.finish, { force: true });
  socketA.send({ type: "startIssues" });
  await waitState(a, "the restarted worker", (state) => state.lifecycle === "idle" && state.enabled, 15_000);
  await writeStore(a.store, [
    issue(1),
    issue(2),
    issue(3, ["goal"]),
    issue(4, ["goal"]),
    issue(5),
    issue(6),
    issue(7),
    issue(8),
  ]);
  const reattachedRun = await waitState(
    a,
    "the reattachment run",
    (state) => state.agents.some((agent) => agent.issueNumber === 8),
    15_000,
  );
  await waitState(
    a,
    "the reattached agents to ask",
    (state) => state.agents.some((agent) => agent.question !== null),
    8000,
  );
  await answerPending(socketA);
  const survivingPid = stateOf(a)!.worker!.pid;
  await stopDashboard(dashboardA);
  check(processAlive(survivingPid), "killing the dashboard killed its worker");

  const replacement = await startDashboard(a, tools, tools.marker);
  startedDashboards.push(replacement);
  const socketReplacement = new Socket(replacement.port);
  await socketReplacement.open();
  const replayed = await socketReplacement.waitFrom(
    0,
    (message) =>
      message.type === "issuesActivity" &&
      message.replay === true &&
      message.runId === reattachedRun.agents.find((agent) => agent.issueNumber === 8)?.runId,
    "the replayed active-run activity",
    10_000,
  );
  check(
    Array.isArray(replayed.entries) && replayed.entries.length > 0,
    "the replayed activity is empty",
    replayed,
  );
  const attachedState = stateOf(a)!;
  check(attachedState.worker?.pid === survivingPid, "the replacement attached to another worker", attachedState.worker);
  await writeFile(a.finish, "finish\n");
  await waitState(a, "the reattached run to finish", (state) => state.lifecycle === "idle", 15_000);
  await rm(a.finish, { force: true });
  socketReplacement.send({ type: "stopIssues" });
  await waitState(a, "the reattached worker to stop", (state) => state.lifecycle === "stopped", 10_000);
  socketReplacement.close();
  socketA.close();

  /* ------------------------------------------------------- */
  /* 9. Another repository has its own worker                 */
  /* ------------------------------------------------------- */
  const b = await fixture("repo-b", "acme/fixture-b");
  await writeStore(b.store, []);
  const dashboardB = await startDashboard(b, tools, tools.marker);
  startedDashboards.push(dashboardB);
  const socketB = new Socket(dashboardB.port);
  await socketB.open();
  socketB.send({ type: "startIssues" });
  const stateB = await waitState(b, "repository B's worker", (state) => state.lifecycle === "idle", 15_000);
  check(stateB.worker!.pid !== survivingPid, "two repositories shared a worker", {
    a: survivingPid,
    b: stateB.worker?.pid,
  });
  check(existsSync(lockPath(b.repo)), "repository B has no repo lock");
  socketB.send({ type: "stopIssues" });
  await waitState(b, "repository B to stop", (state) => state.lifecycle === "stopped", 10_000);
  socketB.close();

  /* ------------------------------------------------------- */
  /* 10. Same repository and state attach to one worker       */
  /* ------------------------------------------------------- */
  const socketA2 = new Socket(replacement.port);
  await socketA2.open();
  socketA2.send({ type: "startIssues" });
  const oneWorker = await waitState(a, "the same-state worker", (state) => state.lifecycle === "idle", 15_000);
  const dashboardC = await startDashboard(a, tools, tools.marker);
  startedDashboards.push(dashboardC);
  const socketC = new Socket(dashboardC.port);
  await socketC.open();
  const attachedFrom = socketC.mark();
  socketC.send({ type: "startIssues" });
  const attachedReply = await socketC.waitFrom(
    attachedFrom,
    (message) => message.type === "issuesState",
    "the attach reply",
    10_000,
  );
  check(attachedReply.attached === true, "a same-state dashboard did not attach", attachedReply);
  check(
    stateOf(a)?.worker?.pid === oneWorker.worker?.pid,
    "the same-state dashboard spawned a second worker",
    stateOf(a)?.worker,
  );
  check(workerPids(a.repo).length === 1, "the checkout has two workers", workerPids(a.repo));

  /* ------------------------------------------------------- */
  /* 11. Another STATE_DIR for the same checkout is refused    */
  /* ------------------------------------------------------- */
  const aOther: FixturePaths = {
    ...a,
    stateDir: join(root, "repo-a-other-state"),
  };
  await mkdir(aOther.stateDir, { recursive: true });
  const dashboardD = await startDashboard(aOther, tools, tools.marker);
  startedDashboards.push(dashboardD);
  const socketD = new Socket(dashboardD.port);
  await socketD.open();
  const refusedFrom = socketD.mark();
  socketD.send({ type: "startIssues" });
  const refused = await socketD.waitFrom(
    refusedFrom,
    (message) => message.type === "error",
    "the other-state refusal",
    10_000,
  );
  check(
    String(refused.message).includes(a.stateDir) &&
      String(refused.message).includes(aOther.stateDir),
    "the refusal does not name both state directories",
    refused,
  );
  check(workerPids(a.repo).length === 1, "the refusal spawned a second worker");
  socketD.close();

  /* ------------------------------------------------------- */
  /* 12. A live legacy orchestrator lock refuses Start        */
  /* ------------------------------------------------------- */
  const e = await fixture("repo-e", "acme/fixture-e");
  await mkdir(join(e.stateDir, "orchestrator"), { recursive: true });
  await writeFile(
    join(e.stateDir, "orchestrator", "lock"),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  const dashboardE = await startDashboard(e, tools, tools.marker);
  startedDashboards.push(dashboardE);
  const socketE = new Socket(dashboardE.port);
  await socketE.open();
  const legacyFrom = socketE.mark();
  socketE.send({ type: "startIssues" });
  const legacy = await socketE.waitFrom(
    legacyFrom,
    (message) => message.type === "error",
    "the legacy-lock refusal",
    10_000,
  );
  check(String(legacy.message).includes("legacy devboard-orchestrator"), "the legacy refusal is not precise", legacy);
  check(
    String(legacy.message).includes("systemctl --user stop devboard-orchestrator.service"),
    "the legacy refusal omits the cleanup command",
    legacy,
  );
  check(!existsSync(lockPath(e.repo)), "the legacy refusal spawned a worker");
  socketE.close();

  /* ------------------------------------------------------- */
  /* 13. No systemd unit, timer, or call was ever written      */
  /* ------------------------------------------------------- */
  check(!existsSync(tools.marker), "a systemd command was invoked", {
    marker: tools.marker,
    content: existsSync(tools.marker) ? readFileSync(tools.marker, "utf8") : "",
  });
  const config = join(tools.home, ".config", "systemd", "user");
  check(!existsSync(config), "a systemd unit directory was written");
  const unit = join(config, "devboard-orchestrator.service");
  check(!existsSync(unit), "a systemd unit was written");

  console.log(
    "verify:issues: per-issue fleet with four simultaneous peers in one poll, exact prompts, " +
      "per-agent activity and answers, per-issue cooldown, an issue opened mid-run, pause " +
      "draining all, Stop closing all, server-restart reattach, per-repository isolation, " +
      "same-repository attach, other-state-directory refusal, legacy-lock refusal, and no " +
      "systemd write passed",
  );
} finally {
  for (const dashboard of startedDashboards) {
    await stopDashboard(dashboard);
  }
  devtools?.close();
  if (chrome?.pid !== undefined) {
    try {
      process.kill(chrome.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const fixtureUnderTest of fixtures) {
    await stopWorker(fixtureUnderTest).catch(() => undefined);
  }
  for (const fixtureUnderTest of fixtures) {
    for (const pid of workerPids(fixtureUnderTest.repo)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The worker already exited.
      }
    }
  }
  await rm(root, { recursive: true, force: true });
}
