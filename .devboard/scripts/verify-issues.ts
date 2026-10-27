#!/usr/bin/env bun
/**
 * The deterministic Issues mode gate. It runs the real detached worker against
 * throwaway git checkouts, a stub `gh`, and a stub ACP peer: Start, 2-second
 * pickup, live activity, pause drain, resume, stop, server-restart reattach,
 * per-repository isolation, same-repository attach, another-state-directory
 * refusal, legacy-lock refusal, and the absence of any systemd write.
 *
 * Every fixture, state directory, browser profile, and log lives under
 * `.devboard/.tmp`. It never contacts GitHub and never starts a real agent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  await writeFile(join(directory, "adrs", "0001-fixture.md"), "# Fixture\n\n- Status: Accepted\n");
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
}

function issue(number: number): Issue {
  return {
    number,
    title: `Fixture issue ${number}`,
    html_url: `https://github.com/acme/fixture/issues/${number}`,
    created_at: `2026-10-${String(20 + (number % 5)).padStart(2, "0")}T00:00:00Z`,
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
  await mkdir(join(home, ".omp", "agent", "commands"), { recursive: true });
  await writeFile(
    join(home, ".omp", "agent", "commands", "implement-all-issues.md"),
    "# implement all issues\n\nFixture command.\n",
  );
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
  /* 1. Start the dashboard, open Issues from the rail, and click Start */
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

  /* ------------------------------------------------------- */
  /* 2. A new issue reaches the queue and triggers a run      */
  /* ------------------------------------------------------- */
  const pickupStarted = Date.now();
  await writeStore(a.store, [issue(1)]);
  const running = await waitState(
    a,
    "the new issue to start a run",
    (state) => state.lifecycle === "running" && state.activeRun !== null,
    2500,
  );
  const pickup = Date.now() - pickupStarted;
  check(pickup <= 2500, `the issue took ${pickup}ms to trigger`, running.poll);
  check(running.queue.some((entry) => entry.number === 1), "the queue lacks the new issue", running.queue);

  const socketA = new Socket(dashboardA.port);
  await socketA.open();
  const activityFrom = socketA.mark();
  const activity = await socketA.waitFrom(
    activityFrom,
    (message) =>
      message.type === "issuesActivity" &&
      Array.isArray(message.entries) &&
      message.entries.some(
        (entry) => typeof entry === "object" && entry !== null && String(entry.text).includes("activity"),
      ),
    "the live ACP activity",
    1500,
  );
  check(activity.type === "issuesActivity", "the activity event is malformed", activity);
  const screenshot = await devtools.send("Page.captureScreenshot", { format: "png" });
  const shotResult = screenshot.result;
  if (typeof shotResult === "object" && shotResult !== null && "data" in shotResult) {
    const data = shotResult.data;
    if (typeof data === "string") {
      await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
      await writeFile(join(harnessRoot, ".tmp", "issues-mode.png"), Buffer.from(data, "base64"));
    }
  }

  await waitFor(
    () => {
      try {
        return /prompt \/implement-all-issues/.test(readFileSync(a.acpLog, "utf8")) ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the exact /implement-all-issues prompt",
    10_000,
    50,
  );
  const acpLog = readFileSync(a.acpLog, "utf8");
  check(acpLog.split("\n").some((line) => line === `start ${running.acp?.pid} ${resolve(a.repo)}`), "the ACP peer did not start in REPO_DIR", acpLog);
  check(/permission \{"outcome":\{"outcome":"selected","optionId":"allow-once"\}\}/.test(acpLog), "the permission was not auto-approved", acpLog);

  // Conditional polling: a second poll carries If-None-Match and gets a 304.
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

  /* ------------------------------------------------------- */
  /* 3. Pause drains the run without killing the ACP peer     */
  /* ------------------------------------------------------- */
  const acpPid = running.acp?.pid ?? 0;
  check(acpPid > 0, "the state does not record the ACP child", running.acp);
  await click(devtools, "issues-pause");
  await waitState(a, "pausing", (state) => state.lifecycle === "pausing");
  check(processAlive(acpPid), "Pause killed the ACP peer");
  await writeFile(a.finish, "finish\n");
  const paused = await waitState(a, "paused after the drain", (state) => state.lifecycle === "paused");
  check(paused.paused, "the worker is not paused", paused);
  check(paused.runs.some((entry) => entry.status === "succeeded"), "the drained run did not succeed", paused.runs);
  await waitFor(() => (!processAlive(acpPid) ? true : undefined), "the ACP peer to finish", 5_000, 50);
  await rm(a.finish, { force: true });

  /* ------------------------------------------------------- */
  /* 4. Resume polls, and an issue opened then runs           */
  /* ------------------------------------------------------- */
  await click(devtools, "issues-resume");
  await writeStore(a.store, [issue(1), issue(2)]);
  const resumed = await waitState(
    a,
    "the resumed run",
    (state) => state.lifecycle === "running" && state.activeRun?.issueNumbers.join(",") === "2",
    10_000,
  );
  check(resumed.paused === false, "Resume did not clear the pause", resumed);
  await writeFile(a.finish, "finish\n");
  const bothHandled = await waitState(
    a,
    "both issues handled",
    (state) =>
      state.lifecycle === "idle" &&
      state.queue.length === 2 &&
      state.queue.every((entry) => entry.handled),
    10_000,
  );
  check(bothHandled.lastExitCode === 0, "the resumed run did not succeed", bothHandled);
  await rm(a.finish, { force: true });

  /* ------------------------------------------------------- */
  /* 5. Stop ends the peer and the worker, leaving the issue */
  /* ------------------------------------------------------- */
  await writeStore(a.store, [issue(1), issue(2), issue(3)]);
  await waitState(
    a,
    "the run to stop",
    (state) => state.lifecycle === "running" && state.activeRun?.issueNumbers.includes(3) === true,
    10_000,
  );
  const stoppingPid = stateOf(a)!.worker!.pid;
  await click(devtools, "issues-stop");
  const stopped = await waitState(a, "stopped", (state) => state.lifecycle === "stopped", 10_000);
  check(stopped.enabled === false, "Stop left the worker enabled", stopped);
  check(stopped.nextAttemptAt === null, "Stop recorded a cooldown", stopped);
  check(stopped.runs.some((entry) => entry.status === "stopped"), "Stop did not record a stopped run", stopped.runs);
  check(
    stopped.queue.find((entry) => entry.number === 3)?.handled === false,
    "Stop marked the captured issue handled",
    stopped.queue,
  );
  check(!existsSync(lockPath(a.repo)), "Stop did not release the repo lock");
  await waitFor(() => (!processAlive(stoppingPid) ? true : undefined), "the worker to exit", 10_000, 50);

  /* ------------------------------------------------------------- */
  /* 6. A killed dashboard leaves the worker; the replacement attaches */
  /* ------------------------------------------------------------- */
  await rm(a.finish, { force: true });
  socketA.send({ type: "startIssues" });
  await waitState(a, "the restarted worker", (state) => state.lifecycle === "idle" && state.enabled, 15_000);
  await writeStore(a.store, [issue(1), issue(2), issue(3), issue(4)]);
  await waitState(
    a,
    "the reattachment run",
    (state) => state.lifecycle === "running" && state.activeRun?.issueNumbers.includes(4) === true,
    10_000,
  );
  const survivingPid = stateOf(a)!.worker!.pid;
  await stopDashboard(dashboardA);
  check(processAlive(survivingPid), "killing the dashboard killed its worker");

  const replacement = await startDashboard(a, tools, tools.marker);
  startedDashboards.push(replacement);
  const socketReplacement = new Socket(replacement.port);
  await socketReplacement.open();
  const replayed = await socketReplacement.waitFrom(
    0,
    (message) => message.type === "issuesActivity" && message.replay === true,
    "the replayed active-run activity",
    10_000,
  );
  check(
    Array.isArray(replayed.entries) &&
      replayed.entries.some(
        (entry) => typeof entry === "object" && entry !== null && String(entry.text).includes("activity"),
      ),
    "the replayed activity is empty",
    replayed,
  );
  const attachedState = stateOf(a)!;
  check(attachedState.worker?.pid === survivingPid, "the replacement attached to another worker", attachedState.worker);
  await writeFile(a.finish, "finish\n");
  await waitState(a, "the reattached run to finish", (state) => state.lifecycle === "idle", 10_000);
  await rm(a.finish, { force: true });
  socketReplacement.send({ type: "stopIssues" });
  await waitState(a, "the reattached worker to stop", (state) => state.lifecycle === "stopped", 10_000);
  socketReplacement.close();

  /* ------------------------------------------------------- */
  /* 7. Another repository has its own worker                 */
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
  /* 8. Same repository and state attach to one worker        */
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
  /* 9. Another STATE_DIR for the same checkout is refused    */
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
  /* 10. A live legacy orchestrator lock refuses Start        */
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
  /* 11. No systemd unit, timer, or call was ever written      */
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
    "verify:issues: Start, 2-second pickup, live ACP activity, pause drain, resume, stop, " +
      "server-restart reattach, per-repository isolation, same-repository attach, " +
      "other-state-directory refusal, legacy-lock refusal, and no systemd write passed",
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
