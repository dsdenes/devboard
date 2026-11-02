#!/usr/bin/env bun
/**
 * The deterministic Auto Scout gate. It drives the built dashboard in headless
 * Chrome against a fixture checkout, a stub ACP peer, and a stub `gh`: Start
 * files significant items with no click, the issue table shows title, creation,
 * category, state, and shipped version, both limits save and survive a reload,
 * a close and a later release update the row, and no review widget or command
 * remains.
 *
 * Every fixture, state directory, browser profile, and log lives under
 * `.devboard/.tmp`. It never contacts GitHub and never starts a real agent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { liveLockOwners } from "../issues/lock";
import {
  lockPath,
  scansDirectory,
  settingsPath,
  statePath,
  versionedStatePath,
  workerStateDirectories,
} from "../issues/scout/paths";
import { readSettings, readState, type ScoutState } from "../issues/scout/state";
import { readHarnessVersion } from "../server/version";
import { pickEntryPoint } from "../lib/entry-point";
import {
  dashboardSocket,
  freePort,
  run,
  waitFor,
  websocketCommand,
} from "./verification";
import { seedVerificationProvider, verificationProviderUsageEnv } from "./provider-fixture";

const harnessRoot = resolve(import.meta.dir, "..");
const root = join(harnessRoot, ".tmp", `verify-scout-${Date.now()}`);
const stubGh = join(harnessRoot, "tests", "fixtures", "scout-stub-gh.ts");
const stubAcp = join(harnessRoot, "tests", "fixtures", "scout-stub-acp.ts");
const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

const MODULES = 24;
const WAVES = [
  { count: 2, shortfall: "The first two candidates were not filable." },
  { count: 2 },
  { count: 0 },
];

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`;
    throw new Error(`verify:scout: ${message}${detail}`);
  }
}

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("verify:scout: Chrome is unavailable");
}

interface StubIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  createdAt: string;
  body: string;
  labels: string[];
}

interface StubStore {
  nextNumber: number;
  issues: StubIssue[];
  openTitles: string[];
  releases: Array<{ tag: string; publishedAt: string; draft?: boolean }>;
  closing: Record<string, string>;
  comments: Record<string, string[]>;
  failReads?: boolean;
}

interface Fixture {
  repo: string;
  stateDir: string;
  home: string;
  bin: string;
  pool: string;
  store: string;
  ghLog: string;
  acpLog: string;
  acpCounter: string;
  head: string;
}

async function makeToolBin(base: string): Promise<{ bin: string; home: string }> {
  const bin = join(base, "bin");
  const home = join(base, "home");
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, ".omp", "commands"), { recursive: true });
  await writeFile(join(home, ".omp", "commands", "scout-recommendations.md"), "# scout\n");
  await writeFile(join(bin, "gh"), `#!/bin/sh\nexec ${process.execPath} ${stubGh} "$@"\n`);
  await writeFile(join(bin, "omp"), "#!/bin/sh\nexit 0\n");
  for (const name of ["gh", "omp"]) run("chmod", ["+x", join(bin, name)]);
  return { bin, home };
}

function candidate(
  index: number,
  title: string,
  category: string,
  significance: number,
  reason: string,
): Record<string, unknown> {
  const module = (index % MODULES) + 1;
  return {
    category,
    title,
    summary: `Module ${module} repeats the same rule in several branches, which hides its intent.`,
    impact: "One rule with one owner is cheaper to change and harder to break.",
    significance,
    significanceReason: reason,
    evidence: [
      {
        path: `src/module-${module}.ts`,
        lines: "1-5",
        quote: `export const value${module}_1 = 1;`,
      },
    ],
    proposedChange: `Extract the repeated rule in module ${module} into one named unit.`,
    files: [`src/module-${module}.ts`],
    acceptanceCriteria: [`Module ${module} states the rule once and the suite still passes.`],
  };
}

async function makeRepository(base: string): Promise<{ repo: string; head: string }> {
  const directory = join(base, "repo");
  await mkdir(join(directory, ".devboard", ".tmp"), { recursive: true });
  await mkdir(join(directory, ".omp", "commands"), { recursive: true });
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "GOAL.md"), "# Fixture goal\n");
  await writeFile(join(directory, ".omp", "commands", "scout-recommendations.md"), "# scout\n");
  for (let index = 1; index <= MODULES; index += 1) {
    await writeFile(
      join(directory, "src", `module-${index}.ts`),
      Array.from(
        { length: 20 },
        (_value, line) => `export const value${index}_${line + 1} = ${line + 1};`,
      ).join("\n"),
    );
  }
  const git = (args: string[]): string => {
    const result = run("git", ["-C", directory, ...args]);
    check(result.code === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["config", "user.email", "devboard@example.test"]);
  git(["config", "user.name", "Devboard Verify"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  git(["remote", "add", "origin", "https://github.com/acme/fixture-scout.git"]);
  return { repo: directory, head: git(["rev-parse", "HEAD"]) };
}

async function makeFixture(base: string): Promise<Fixture> {
  const tools = await makeToolBin(base);
  const { repo, head } = await makeRepository(base);
  const pool = join(base, "pool.json");
  await writeFile(
    pool,
    `${JSON.stringify(
      [
        candidate(0, "Existing open issue", "tests", 5, "The same issue title is already open."),
        candidate(1, "Scout polish only", "clarity", 2, "Polishing code that is already correct."),
        candidate(
          2,
          "Scout fixture recommendation one",
          "clarity",
          5,
          "The duplicate rule rejects a trailing slash that the second copy accepts.",
        ),
        candidate(
          3,
          "Scout fixture recommendation two",
          "clarity",
          5,
          "The unhandled failure path returns a partial file on a write error.",
        ),
        candidate(4, "Scout spare one", "robustness", 5, "A real failure mode."),
        candidate(5, "Scout spare two", "robustness", 5, "A real failure mode."),
      ],
      null,
      2,
    )}\n`,
  );
  const store = join(base, "store.json");
  writeFileSync(
    store,
    `${JSON.stringify(
      {
        nextNumber: 1,
        issues: [],
        openTitles: ["Existing open issue"],
        releases: [],
        closing: {},
        comments: {},
      } satisfies StubStore,
      null,
      2,
    )}\n`,
  );
  return {
    repo,
    stateDir: join(repo, ".devboard", ".tmp", "state"),
    home: tools.home,
    bin: tools.bin,
    pool,
    store,
    ghLog: join(base, "gh.log"),
    acpLog: join(base, "acp.log"),
    acpCounter: join(base, "acp-counter.log"),
    head,
  };
}

function readStore(fixture: Fixture): StubStore {
  return JSON.parse(readFileSync(fixture.store, "utf8")) as StubStore;
}

function writeStore(fixture: Fixture, store: StubStore): void {
  writeFileSync(fixture.store, `${JSON.stringify(store, null, 2)}\n`);
}

interface Dashboard {
  child: ChildProcess;
  port: number;
}

async function startDashboard(fixture: Fixture): Promise<Dashboard> {
  const port = await freePort();
  seedVerificationProvider(fixture.stateDir);
  const child = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    cwd: harnessRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ADRS_DIR: join(fixture.repo, "adrs"),
      REPO_DIR: fixture.repo,
      GOAL_FILE: join(fixture.repo, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: fixture.stateDir,
      HOME: fixture.home,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      AGENT_COMMAND: `${process.execPath} ${stubAcp}`,
      ...verificationProviderUsageEnv(),
      SCOUT_STUB_POOL: fixture.pool,
      SCOUT_STUB_WAVES: JSON.stringify(WAVES),
      SCOUT_STUB_GH_LOG: fixture.ghLog,
      SCOUT_STUB_STATE: fixture.store,
      SCOUT_STUB_ACP_LOG: fixture.acpLog,
      SCOUT_STUB_ACP_COUNTER: fixture.acpCounter,
      SCOUT_STUB_QUESTION: "1",
      SCOUT_SYNC_MS: "1000",
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
    `dashboard ${fixture.repo}`,
    30_000,
  );
  return { child, port };
}

async function stopDashboard(dashboard: Dashboard): Promise<void> {
  if (dashboard.child.exitCode !== null) return;
  dashboard.child.kill("SIGTERM");
  await waitFor(
    () =>
      dashboard.child.exitCode !== null || dashboard.child.signalCode !== null ? true : undefined,
    "the dashboard to exit",
    10_000,
  ).catch(() => undefined);
}

/** The newest state any live-or-recent worker version published. */
function stateOf(fixture: Fixture): ScoutState | undefined {
  const states: ScoutState[] = [];
  const legacy = readState(statePath(fixture.stateDir, fixture.repo));
  if (legacy !== undefined) states.push(legacy);
  for (const directory of workerStateDirectories(fixture.stateDir, fixture.repo)) {
    const state = readState(join(directory, "state.json"));
    if (state !== undefined) states.push(state);
  }
  return states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

async function waitState(
  fixture: Fixture,
  description: string,
  predicate: (state: ScoutState) => boolean,
  timeoutMs = 15_000,
): Promise<ScoutState> {
  try {
    return await waitFor(
      () => {
        const state = stateOf(fixture);
        return state !== undefined && predicate(state) ? state : undefined;
      },
      description,
      timeoutMs,
      50,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstate: ${JSON.stringify(stateOf(fixture))}`,
    );
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
    if (argv.includes(join("issues", "scout", "worker.ts")) && argv.includes(repo)) pids.push(pid);
  }
  return pids.sort((left, right) => left - right);
}

/** One Auto Scout worker of an arbitrary harness version, as a fixture. */
function spawnScoutWorker(
  fixture: Fixture,
  version: string,
  extra: Record<string, string> = {},
): ChildProcess {
  return spawn(
    process.execPath,
    [
      join(harnessRoot, "issues", "scout", "worker.ts"),
      "--repo",
      fixture.repo,
      "--state-dir",
      fixture.stateDir,
    ],
    {
      cwd: harnessRoot,
      env: {
        ...process.env,
        DEVBOARD_HARNESS_VERSION: version,
        HOME: fixture.home,
        PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
        AGENT_COMMAND: `${process.execPath} ${stubAcp}`,
        ...verificationProviderUsageEnv(),
        SCOUT_STUB_POOL: fixture.pool,
        SCOUT_STUB_WAVES: JSON.stringify(WAVES),
        SCOUT_STUB_GH_LOG: fixture.ghLog,
        SCOUT_STUB_STATE: fixture.store,
        SCOUT_STUB_ACP_LOG: fixture.acpLog,
        SCOUT_STUB_ACP_COUNTER: fixture.acpCounter,
        SCOUT_STUB_QUESTION: "0",
        SCOUT_SYNC_MS: "500",
        ...extra,
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
}

interface SocketMessage {
  type?: string;
  message?: string;
  [key: string]: unknown;
}

class Socket {
  private readonly socket: WebSocket;
  readonly messages: SocketMessage[] = [];

  constructor(port: number) {
    this.socket = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
  }

  async open(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    this.socket.onopen = () => {
      this.socket.onmessage = (event) => {
        try {
          this.messages.push(JSON.parse(String(event.data)) as SocketMessage);
        } catch {
          // An unparseable frame is not part of the contract under test.
        }
      };
      opened.resolve();
    };
    this.socket.onerror = () => opened.reject(new Error("websocket failed"));
    await opened.promise;
  }

  send(command: unknown): void {
    this.socket.send(JSON.stringify(command));
  }

  async waitFrom(
    from: number,
    predicate: (message: SocketMessage) => boolean,
    description: string,
    timeoutMs = 15_000,
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
    const { promise, resolve: settle } = Promise.withResolvers<Record<string, unknown>>();
    const id = this.nextId++;
    this.pending.set(id, settle);
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

async function setInput(devtools: Devtools, testid: string, value: string): Promise<void> {
  await devtools.evaluate(
    `(() => {
      const element = document.querySelector('[data-testid="${testid}"]');
      if (element === null) return false;
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
}

async function text(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools
    .evaluate(
      `document.querySelector('[data-testid="${testid}"]')?.textContent?.trim() ?? ''`,
    )
    .catch(() => "");
  return typeof value === "string" ? value : "";
}

async function barLog(devtools: Devtools): Promise<string> {
  const expanded = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-toggle"]')?.getAttribute('aria-expanded') === 'true'`,
  );
  if (expanded !== true) {
    await devtools.evaluate(`(() => {
      const button = document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-toggle"]');
      if (button === null) return false;
      button.click();
      return true;
    })()`);
  }
  await devtools.evaluate(`new Promise((settle) => requestAnimationFrame(() => settle(true)))`);
  const value = await devtools
    .evaluate(
      `document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-log"]')?.textContent?.trim() ?? ''`,
    )
    .catch(() => "");
  return typeof value === "string" ? value : "";
}

interface RowSnapshot {
  number: string;
  url: string;
  state: string;
  version: string;
  title: string;
  href: string;
  created: string;
  type: string;
  stateText: string;
  versionText: string;
}

async function rows(devtools: Devtools): Promise<RowSnapshot[]> {
  const value = await devtools
    .evaluate(
      `(() => Array.from(document.querySelectorAll('[data-testid="agent-issue"]')).map((row) => ({
        number: (row.dataset.url ?? '').split('/').pop() ?? '',
        url: row.dataset.url ?? '',
        state: row.dataset.state ?? '',
        version: row.dataset.version ?? '',
        title: row.querySelector('[data-testid="agent-issue-title"]')?.textContent?.trim() ?? '',
        href: row.querySelector('[data-testid="agent-issue-title"]')?.getAttribute('href') ?? '',
        created: row.querySelector('[data-testid="agent-issue-filed"]')?.textContent?.trim() ?? '',
        type: row.querySelector('[data-testid="agent-issue-category"]')?.textContent?.trim() ?? '',
        stateText: row.querySelector('[data-testid="agent-issue-state"]')?.textContent?.trim() ?? '',
        versionText: row.querySelector('[data-testid="agent-issue-version"]')?.textContent?.trim() ?? '',
      })))()`,
    )
    .catch(() => undefined);
  return Array.isArray(value) ? (value as RowSnapshot[]) : [];
}

async function waitRows(
  devtools: Devtools,
  count: number,
  description: string,
  timeoutMs = 30_000,
): Promise<RowSnapshot[]> {
  return await waitFor(
    async () => {
      const current = await rows(devtools);
      return current.length === count ? current : undefined;
    },
    description,
    timeoutMs,
  );
}

function issueCreateCalls(fixture: Fixture): string[][] {
  try {
    return readFileSync(fixture.ghLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as string[])
      .filter((argv) => argv[0] === "issue" && argv[1] === "create");
  } catch {
    return [];
  }
}

const dashboards: Dashboard[] = [];
let chrome: ChildProcess | undefined;
let devtools: Devtools | undefined;
let socket: Socket | undefined;

try {
  await mkdir(root, { recursive: true });
  const fixture = await makeFixture(root);
  await mkdir(fixture.stateDir, { recursive: true });
  const dashboard = await startDashboard(fixture);
  dashboards.push(dashboard);

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
      `http://127.0.0.1:${dashboard.port}/`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const socketUrl = await pageTarget(debugPort, dashboard.port);
  devtools = new Devtools(socketUrl);
  await devtools.connect();
  await devtools.send("Runtime.enable");
  await devtools.send("Page.enable");
  await devtools.send("Page.navigate", { url: `http://127.0.0.1:${dashboard.port}/` });
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.readyState === "complete" && (document.getElementById("app")?.childElementCount ?? 0) > 0`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the dashboard page to render",
    30_000,
  );
  /* ---------------------------------------------------------------- */
  /* 1. Open Auto Scout without starting a worker                      */
  /* ---------------------------------------------------------------- */
  await click(devtools, "mode-devboard");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.querySelector('[data-testid="open-devboard-scout"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Auto Scout sidebar entry",
    15_000,
  );
  const scoutEntry = await devtools.evaluate(
    `(() => {
      const button = document.querySelector('[data-testid="open-devboard-scout"]');
      if (button === null) return null;
      return {
        command: button.dataset.command ?? '',
        count: button.querySelector('[data-testid="agent-count-scout"]')?.textContent?.trim() ?? '',
        label: button.getAttribute('aria-label') ?? '',
      };
    })()`,
  );
  check(
    (scoutEntry as Record<string, unknown> | null)?.command === "open.devboard.scout",
    "the Auto Scout button has no command",
    scoutEntry,
  );
  check(
    (scoutEntry as Record<string, unknown> | null)?.count === "0",
    "the pending count does not start at zero",
    scoutEntry,
  );
  check(
    String((scoutEntry as Record<string, unknown> | null)?.label).includes("Devboard"),
    "the accessible name omits the mode",
    scoutEntry,
  );
  await devtools.evaluate(
    `(() => { document.querySelector('[data-testid="open-devboard-scout"]').click(); return true; })()`,
  );
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.querySelector('[data-testid="agent-page"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Auto Scout page",
    10_000,
  );
  check(workerPids(fixture.repo).length === 0, "opening the page started a worker");
  check(liveLockOwners(lockPath(fixture.repo)).length === 0, "opening the page took the repository lock");
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-issues-empty"]') !== null`,
    )) === true,
    "an empty table renders no empty state",
  );

  /* ---------------------------------------------------------------- */
  /* 2. Save both limits, then Start files significant items           */
  /* ---------------------------------------------------------------- */
  await setInput(devtools, "agent-limit-hour", "10");
  await setInput(devtools, "agent-limit-pending", "2");
  await click(devtools, "agent-save-limits");
  await waitFor(
    () => {
      const saved = readSettings(settingsPath(fixture.stateDir, fixture.repo));
      return saved?.maxPerHour === 10 && saved.maxPending === 2 ? true : undefined;
    },
    "the saved limits",
    10_000,
  );

  await click(devtools, "agent-start");
  // The default cadence is one minute: the first scan files nothing, and the
  // second must not start before the interval. Prove the throttle before the
  // second scan's rows arrive.
  await Bun.sleep(3_000);
  const earlyRows = await rows(devtools);
  check(earlyRows.length === 0, "a second scan started before the cadence interval", {
    rows: earlyRows,
    store: readStore(fixture),
    scans: readdirSync(scansDirectory(fixture.repo)),
  });
  const filedRows = await waitRows(devtools, 2, "the two filed issues", 90_000);
  check(workerPids(fixture.repo).length === 1, "Start did not spawn exactly one worker");
  const numbers = filedRows.map((row) => row.number).sort();
  check(
    JSON.stringify(numbers) === JSON.stringify(["1", "2"]),
    "the table does not hold the two filed issues",
    filedRows,
  );
  for (const row of filedRows) {
    check(row.title.length > 0, "a row has no title", row);
    check(row.href.includes("/issues/"), "the title is not an anchor to the issue", row);
    check(row.created.length > 0, "a row has no creation time", row);
    check(row.type === "clarity", "a row has the wrong category", row);
    check(row.state === "pending", "a pending issue has the wrong state", row);
    check(row.stateText === "pending", "a pending issue renders the wrong state", row);
    check(row.version === "", "a pending issue has a shipped version", row);
    check(row.versionText === "—", "a pending issue renders a shipped version", row);
  }
  check(
    (await text(devtools, "agent-count-scout")) === "2",
    "the sidebar count does not match the pending rows",
    await text(devtools, "agent-count-scout"),
  );
  const created = issueCreateCalls(fixture);
  check(created.length === 2, "a non-significant or duplicate item was filed", created);
  check(
    created.every(
      (argv) =>
        argv[argv.indexOf("--repo") + 1] === "acme/fixture-scout" &&
        argv[argv.indexOf("--label") + 1] === "scout",
    ),
    "an issue was filed without the host origin and the scout label",
    created,
  );
  const filingNotice = await waitFor(
    async () => {
      const entry = (await devtools.evaluate(`(() => {
        const card = [...document.querySelectorAll('[data-testid="notifications"] .notification')]
          .find((item) => item.textContent?.includes("Filed 2 issues"));
        return card === undefined
          ? null
          : {
              text: card.querySelector(".notification__text")?.textContent ?? "",
              source: card.getAttribute("data-source"),
              meta: card.querySelector(".notification__meta")?.textContent ?? "",
            };
      })()`)) as { text: string; source: string | null; meta: string } | null;
      return entry ?? undefined;
    },
    "the filing notification",
    10_000,
  );
  check(
    filingNotice.text === "Filed 2 issues in acme/fixture-scout: #1, #2" &&
      filingNotice.source === "Auto Scout" &&
      filingNotice.meta.includes("Auto Scout"),
    "the filing notification does not name its source and the filed issues",
    filingNotice,
  );
  const activity = await waitFor(
    async () => {
      const value = await barLog(devtools!);
      return value.includes("filed #") ? value : undefined;
    },
    "the filings in the activity",
    15_000,
  );
  check(activity.includes("filed #"), "the filings are not in the activity", activity);
  const scanIds = readdirSync(scansDirectory(fixture.repo)).sort();
  const newestScan = scanIds.at(-1);
  check(newestScan !== undefined, "the scan wrote no directory");
  const scanDirectoryPath = join(scansDirectory(fixture.repo), newestScan!);
  const scanRequest = JSON.parse(
    readFileSync(join(scanDirectoryPath, "request.json"), "utf8"),
  ) as {
    surface?: unknown;
    seed?: unknown;
    entryPoint?: { path?: unknown; line?: unknown };
  };
  check(
    scanRequest.surface === "scout" &&
      typeof scanRequest.seed === "string" &&
      typeof scanRequest.entryPoint?.path === "string" &&
      typeof scanRequest.entryPoint?.line === "number",
    "the scan request records no seeded entry point",
    scanRequest,
  );
  const entryPath = scanRequest.entryPoint!.path as string;
  const entryLine = scanRequest.entryPoint!.line as number;
  check(
    existsSync(join(fixture.repo, entryPath)),
    "the entry point is not a repository file",
    entryPath,
  );
  const replayed = pickEntryPoint({
    repoDir: fixture.repo,
    surface: "scout",
    seed: scanRequest.seed as string,
  });
  check(
    replayed.path === entryPath && replayed.line === entryLine,
    "the recorded seed does not replay its entry point",
    { recorded: scanRequest.entryPoint, replayed },
  );
  const activityText = readFileSync(join(scanDirectoryPath, "activity.json"), "utf8");
  check(
    activityText.includes(entryPath) && activityText.includes(scanRequest.seed as string),
    "the activity does not name the entry point and seed",
  );
  console.log(
    `verify:scout: entry point ${entryPath}:${entryLine} seed ${String(scanRequest.seed)}`,
  );
  const createdBodies = readStore(fixture).issues.map((issue) => issue.body);
  check(
    createdBodies.every((body) => body.includes("## Significance") && body.includes("5/5")),
    "a filed issue body has no significance section",
    createdBodies,
  );
  // Every scan keeps its own activity; the page shows the newest one.
  const reviewIds = [
    "scout-widget",
    "scout-approve",
    "scout-draft-goal",
    "scout-reject",
    "scout-shortfall",
  ];
  const remaining = await devtools.evaluate(
    `(() => ${JSON.stringify(reviewIds)}.filter((id) => document.querySelector('[data-testid="' + id + '"]') !== null))()`,
  );
  check(
    Array.isArray(remaining) && remaining.length === 0,
    "a review widget or control remains",
    remaining,
  );

  /* ---------------------------------------------------------------- */
  /* 3. No approve, draft, or reject command is accepted               */
  /* ---------------------------------------------------------------- */
  socket = new Socket(dashboard.port);
  await socket.open();
  const beforeCommands = issueCreateCalls(fixture).length;
  socket.send({ type: "approveScout", id: "1" });
  socket.send({ type: "draftScoutGoal", id: "1" });
  socket.send({ type: "rejectScout", id: "1" });
  await waitUntilErrors(socket, 3);
  check(
    issueCreateCalls(fixture).length === beforeCommands,
    "a review command filed an issue",
    issueCreateCalls(fixture),
  );
  socket.close();
  socket = undefined;

  /* ---------------------------------------------------------------- */
  /* 4. An invalid save shows the error and sends nothing              */
  /* ---------------------------------------------------------------- */
  await setInput(devtools, "agent-limit-hour", "0");
  await click(devtools, "agent-save-limits");
  const limitsError = await waitFor(
    async () => {
      const value = await text(devtools, "agent-settings-error");
      return value.includes("1 through 100") ? value : undefined;
    },
    "the limits error",
    10_000,
  );
  check(
    limitsError.includes("1 through 100"),
    "the limits error does not name the accepted range",
    limitsError,
  );
  const stillSaved = readSettings(settingsPath(fixture.stateDir, fixture.repo));
  check(
    stillSaved?.maxPerHour === 10 && stillSaved.maxPending === 2,
    "an invalid save changed the persisted limits",
    stillSaved,
  );

  /* ---------------------------------------------------------------- */
  /* 5. A valid save survives a reload                                 */
  /* ---------------------------------------------------------------- */
  await waitFor(
    async () =>
      (await devtools
        .evaluate(
          `document.querySelector('[data-testid="agent-save-limits"]')?.getAttribute('aria-busy') !== 'true'`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Save limits control to settle",
    15_000,
  );
  await setInput(devtools, "agent-limit-hour", "3");
  await Bun.sleep(100);
  await setInput(devtools, "agent-limit-pending", "1");
  await Bun.sleep(100);
  await click(devtools, "agent-save-limits");
  await waitFor(
    () => {
      const saved = readSettings(settingsPath(fixture.stateDir, fixture.repo));
      return saved?.maxPerHour === 3 && saved.maxPending === 1 ? true : undefined;
    },
    "the second saved limits",
    10_000,
  );
  const applied = await waitState(
    fixture,
    "the running worker's limits",
    (state) => state.limits.maxPerHour === 3 && state.limits.maxPending === 1,
  );
  check(applied.limits.maxPending === 1, "the running worker did not apply the saved limits", applied);
  await devtools.send("Page.reload");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.readyState === "complete" && document.querySelector('[data-testid="agent-page"]') !== null`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the reloaded Auto Scout page",
    30_000,
  );
  await waitRows(devtools, 2, "the table after a reload");
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-limit-hour"]')?.value ?? ''`,
    )) === "3",
    "the hourly limit did not survive a reload",
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-limit-pending"]')?.value ?? ''`,
    )) === "1",
    "the pending limit did not survive a reload",
  );

  /* ---------------------------------------------------------------- */
  /* 6. A close makes the row implemented; a later release fills it    */
  /* ---------------------------------------------------------------- */
  const store = readStore(fixture);
  const first = store.issues[0]!;
  first.state = "closed";
  store.closing[String(first.number)] = fixture.head;
  writeStore(fixture, store);
  const implemented = await waitFor(
    async () => {
      const current = await rows(devtools);
      const row = current.find((entry) => entry.number === String(first.number));
      return row?.state === "implemented" ? row : undefined;
    },
    "the implemented row",
    15_000,
  );
  check(
    implemented.version === "" && implemented.versionText === "—",
    "a closed issue with no release shows a version",
    implemented,
  );
  const afterClose = await waitState(
    fixture,
    "the pending count after a close",
    (state) => state.issues.filter((row) => row.state === "pending").length === 1,
  );
  check(
    afterClose.issues.filter((row) => row.state === "pending").length === 1,
    "the pending count did not fall after a close",
    afterClose,
  );

  run("git", ["-C", fixture.repo, "tag", "v0.1.0", fixture.head]);
  const released = readStore(fixture);
  released.releases.push({ tag: "v0.1.0", publishedAt: new Date().toISOString() });
  writeStore(fixture, released);
  const shipped = await waitFor(
    async () => {
      const current = await rows(devtools);
      const row = current.find((entry) => entry.number === String(first.number));
      return row?.version === "v0.1.0" ? row : undefined;
    },
    "the shipped version",
    20_000,
  );
  check(
    shipped.versionText === "v0.1.0",
    "the shipped version is not rendered",
    shipped,
  );

  /* ---------------------------------------------------------------- */
  /* 7. A failed read surfaces the reason and keeps the rows           */
  /* ---------------------------------------------------------------- */
  const syncAt = await text(devtools, "agent-sync-at");
  const failing = readStore(fixture);
  failing.failReads = true;
  writeStore(fixture, failing);
  // A page opened this table: the dashboard reads now instead of at its next
  // cadence, so the retry schedule below starts from this activation.
  await websocketCommand(
    dashboard.port,
    { type: "refreshAgent", id: "scout" },
    "agentState",
    10_000,
  );
  const retrying = await waitState(
    fixture,
    "the retrying read",
    (state) => state.sync.state === "stale" && state.sync.error === null,
  );
  check(
    retrying.sync.error === null,
    "the retry window carries a sync reason",
    retrying.sync,
  );
  check(
    (await text(devtools, "agent-sync-error")) === "",
    "agent-sync-error is rendered during the retry window",
  );
  check(
    (await text(devtools, "agent-sync-at")) === syncAt,
    "a retry discarded the last success time",
    await text(devtools, "agent-sync-at"),
  );
  await waitRows(devtools, 2, "the rows during the retry window");
  const syncError = await waitFor(
    async () => {
      const value = await text(devtools, "agent-sync-error");
      return value.length > 0 ? value : undefined;
    },
    "the exhausted sync error reason",
    90_000,
  );
  check(syncError.length > 0, "the sync error carries no reason", syncError);
  const workerFailure = stateOf(fixture);
  check(
    typeof workerFailure?.sync.error === "string" &&
      /unavailable|unexpected api endpoint/.test(workerFailure.sync.error),
    "the worker's sync error does not carry its reason",
    workerFailure?.sync,
  );
  check(
    (await text(devtools, "agent-sync-at")) === syncAt,
    "a failed read discarded the last success time",
    await text(devtools, "agent-sync-at"),
  );
  await waitRows(devtools, 2, "the rows after a failed read");
  const recovered = readStore(fixture);
  recovered.failReads = false;
  writeStore(fixture, recovered);
  await websocketCommand(
    dashboard.port,
    { type: "refreshAgent", id: "scout" },
    "agentState",
    10_000,
  );
  await waitFor(
    async () => {
      const value = await text(devtools, "agent-sync-error");
      return value.length === 0 ? true : undefined;
    },
    "the recovered sync",
    90_000,
  );

  /* ---------------------------------------------------------------- */
  /* 8. Stop ends the worker and the table survives                    */
  /* ---------------------------------------------------------------- */
  const stoppingPid = stateOf(fixture)?.worker?.pid ?? 0;
  await click(devtools, "agent-stop");
  const stopped = await waitState(
    fixture,
    "the stopped scout",
    (state) => state.lifecycle === "stopped",
  );
  check(stopped.enabled === false, "Stop left the scout enabled", stopped);
  check(liveLockOwners(lockPath(fixture.repo)).length === 0, "Stop did not release the repository lock");
  await waitFor(
    () => (workerPids(fixture.repo).length === 0 ? true : undefined),
    "the worker to exit",
    10_000,
  );
  if (stoppingPid > 0) {
    let alive = true;
    try {
      process.kill(stoppingPid, 0);
    } catch {
      alive = false;
    }
    check(!alive, "the stopped worker process still runs", stoppingPid);
  }
  await waitRows(devtools, 2, "the table after Stop");

  await devtools.send("Page.reload");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.readyState === "complete" && document.querySelector('[data-testid="agent-page"]') !== null`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the final reloaded page",
    30_000,
  );
  await waitRows(devtools, 2, "the table after the final reload");
  check(
    workerPids(fixture.repo).length === 0,
    "reloading the dashboard started a worker",
    workerPids(fixture.repo),
  );

  socket = new Socket(dashboard.port);
  await socket.open();
  socket.send({ type: "getAgents" });
  const agentFrame = await waitFor(
    () => socket!.messages.find((message) => message.type === "agentsState"),
    "the shared agentsState replay",
    10_000,
  );
  check(
    Array.isArray(agentFrame.agents) &&
      JSON.stringify((agentFrame.agents as Array<{ id?: string }>).map((agent) => agent.id)) ===
        JSON.stringify([
          "scout",
          "watchdog",
          "design",
          "dead-code",
          "mcp-optimizer",
          "api-standards",
          "release-train",
        ]),
    "agentsState does not carry all background agents",
    agentFrame,
  );
  check(
    !socket.messages.some(
      (message) => message.type === "scoutState" || message.type === "scoutActivity",
    ),
    "a removed scout transport message is still sent",
    socket.messages.map((message) => message.type),
  );
  socket.close();
  socket = undefined;

  /* ---------------------------------------------------------------- */
  /* 10. An older worker hands over to this version, one scan at a time */
  /* ---------------------------------------------------------------- */
  const fleet = await makeFixture(join(root, "fleet"));
  await mkdir(fleet.stateDir, { recursive: true });
  const oldVersion = "0.1.900";
  const newVersion = readHarnessVersion(harnessRoot) ?? "unknown";
  const oldWorker = spawnScoutWorker(fleet, oldVersion, { SCOUT_STUB_ACP_DELAY_MS: "4000" });
  let fleetSocket: Socket | undefined;
  try {
    const started = await waitFor(
      () => {
        const state = stateOf(fleet);
        return state?.scan?.scanId !== undefined ? state : undefined;
      },
      "the old worker's in-flight scan",
      20_000,
      50,
    );
    const oldScanId = started.scan!.scanId;
    const fleetDashboard = await startDashboard(fleet);
    dashboards.push(fleetDashboard);
    console.log(`verify:scout: takeover: the live ${oldVersion} worker holds scan ${oldScanId}`);

    fleetSocket = new Socket(fleetDashboard.port);
    await fleetSocket.open();
    fleetSocket.send({ type: "getAgents" });
    const scout = await waitFor(
      () => {
        // The first agentsState can precede the automatic takeover; every
        // later change arrives as one agentState broadcast.
        let found: Record<string, unknown> | undefined;
        for (const message of fleetSocket!.messages) {
          if (message.type === "agentsState") {
            const agents = Array.isArray(message.agents)
              ? (message.agents as Array<Record<string, unknown>>)
              : [];
            const entry = agents.find((agent) => agent.id === "scout");
            if (Array.isArray(entry?.workers) && (entry.workers as unknown[]).length >= 2) {
              found = entry;
            }
            continue;
          }
          if (message.type === "agentState") {
            const entry =
              typeof message.agent === "object" && message.agent !== null
                ? (message.agent as Record<string, unknown>)
                : undefined;
            if (
              entry?.id === "scout" &&
              Array.isArray(entry.workers) &&
              (entry.workers as unknown[]).length >= 2
            ) {
              found = entry;
            }
          }
        }
        return found;
      },
      "the merged Auto Scout worker view",
      30_000,
      50,
    );
    const versions = (scout.workers as Array<{ version: string | null }>)
      .map((worker) => worker.version)
      .sort();
    check(versions.includes(oldVersion), "the merged view lost the old worker", versions);
    check(versions.includes(newVersion), "the newer worker did not become live", versions);
    check(
      !JSON.stringify(scout).includes("this dashboard loaded") &&
        !JSON.stringify(scout).includes("It is left running"),
      "the merged view carries a version divergence notice",
      scout,
    );
    console.log(
      `verify:scout: takeover: old ${oldVersion} and new ${newVersion} are both live with no divergence notice`,
    );

    const newState = readState(versionedStatePath(fleet.stateDir, fleet.repo, newVersion));
    check(
      newState === undefined || newState.scan === null,
      "the newer worker claimed a scan while the old unit was in flight",
      newState,
    );

    await waitFor(
      () => (workerPids(fleet.repo).length === 1 ? true : undefined),
      "the retired worker to exit",
      30_000,
      100,
    );
    const retired = readState(versionedStatePath(fleet.stateDir, fleet.repo, oldVersion));
    check(retired !== undefined, "the retired worker's state was removed", retired);
    check(retired?.scan === null, "the old worker's in-flight scan did not finish", retired);
    console.log("verify:scout: takeover: the old in-flight scan finished and the old worker exited");

    const claimed = await waitFor(
      () => {
        const state = readState(versionedStatePath(fleet.stateDir, fleet.repo, newVersion));
        const scanId = state?.newestScanId ?? state?.scan?.scanId ?? undefined;
        return scanId !== undefined && scanId !== oldScanId ? state : undefined;
      },
      "the newer worker's own scan",
      30_000,
      100,
    );
    check(
      claimed.scan === null || claimed.scan?.scanId !== oldScanId,
      "the new worker reused the old scan",
      claimed,
    );
    console.log(
      `verify:scout: takeover: the issue opened after the newer worker was live is claimed once (${claimed.newestScanId ?? claimed.scan?.scanId})`,
    );
  } finally {
    if (oldWorker.pid !== undefined) {
      try {
        process.kill(oldWorker.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    fleetSocket?.close();
  }

  console.log(
    "verify:scout: Start filed significant items with no click, the shared page and table ids " +
      "held, both limits saved and survived a reload, a close and a later release updated the " +
      "row, a failed read surfaced its reason, agentsState replaced scoutState, and no review " +
      "widget or command remains",
  );
} finally {
  socket?.close();
  for (const dashboard of dashboards) {
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
  for (const pid of workerPids(join(root, "repo"))) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The worker already exited.
    }
  }
  if (process.env.SCOUT_VERIFY_KEEP !== "1") {
    await rm(root, { recursive: true, force: true });
  } else {
    console.error(`verify:scout: kept ${root}`);
  }
}

/** Waits for the dashboard to answer each refused review command with an error. */
async function waitUntilErrors(target: Socket, count: number): Promise<void> {
  await waitFor(
    () => {
      const errors = target.messages.filter((message) => message.type === "error");
      return errors.length >= count ? errors : undefined;
    },
    `${count} refused review commands`,
    10_000,
    25,
  );
}
