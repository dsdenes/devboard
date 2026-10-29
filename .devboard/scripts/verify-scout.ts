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
import { lockPath, scansDirectory, settingsPath, statePath } from "../issues/scout/paths";
import { readSettings, readState, type ScoutState } from "../issues/scout/state";
import { freePort, run, waitFor } from "./verification";
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

function stateOf(fixture: Fixture): ScoutState | undefined {
  return readState(statePath(fixture.stateDir, fixture.repo));
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

interface SocketMessage {
  type?: string;
  message?: string;
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

  /* ---------------------------------------------------------------- */
  /* 1. Open Auto Scout without starting a worker                      */
  /* ---------------------------------------------------------------- */
  await click(devtools, "mode-issues");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.querySelector('[data-testid="open-issues-scout"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Auto Scout sidebar entry",
    15_000,
  );
  const scoutEntry = await devtools.evaluate(
    `(() => {
      const button = document.querySelector('[data-testid="open-issues-scout"]');
      if (button === null) return null;
      return {
        command: button.dataset.command ?? '',
        count: button.querySelector('[data-testid="agent-count-scout"]')?.textContent?.trim() ?? '',
        label: button.getAttribute('aria-label') ?? '',
      };
    })()`,
  );
  check(
    (scoutEntry as Record<string, unknown> | null)?.command === "open.issues.scout",
    "the Auto Scout button has no command",
    scoutEntry,
  );
  check(
    (scoutEntry as Record<string, unknown> | null)?.count === "0",
    "the pending count does not start at zero",
    scoutEntry,
  );
  check(
    String((scoutEntry as Record<string, unknown> | null)?.label).includes("Issues"),
    "the accessible name omits the mode",
    scoutEntry,
  );
  await devtools.evaluate(
    `(() => { document.querySelector('[data-testid="open-issues-scout"]').click(); return true; })()`,
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
  check(!existsSync(lockPath(fixture.repo)), "opening the page took the repository lock");
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
  await click(devtools, "agent-save-settings");
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
  check((await rows(devtools)).length === 0, "a second scan started before the cadence interval");
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
      const value = await text(devtools!, "scout-activity");
      return value.includes("filed #") ? value : undefined;
    },
    "the filings in the activity",
    15_000,
  );
  check(activity.includes("filed #"), "the filings are not in the activity", activity);
  const createdBodies = readStore(fixture).issues.map((issue) => issue.body);
  check(
    createdBodies.every((body) => body.includes("## Significance") && body.includes("5/5")),
    "a filed issue body has no significance section",
    createdBodies,
  );
  // Every scan keeps its own activity; the page shows the newest one, so the
  // drops from the first scan are read from its recorded file.
  const recorded = readdirSync(scansDirectory(fixture.repo))
    .map((scanId) => {
      try {
        return readFileSync(join(scansDirectory(fixture.repo), scanId, "activity.json"), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  check(recorded.includes("dropped duplicate"), "the duplicate was not recorded", recorded);
  check(recorded.includes("significance 2/5"), "the low score was not recorded", recorded);

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
  await click(devtools, "agent-save-settings");
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
  await setInput(devtools, "agent-limit-hour", "3");
  await setInput(devtools, "agent-limit-pending", "1");
  await click(devtools, "agent-save-settings");
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
  check(
    (await text(devtools, "agent-count-scout")) === "1",
    "the pending count did not fall after a close",
    await text(devtools, "agent-count-scout"),
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
  const syncError = await waitFor(
    async () => {
      const value = await text(devtools, "agent-sync-error");
      return value.length > 0 ? value : undefined;
    },
    "the sync error reason",
    10_000,
  );
  check(
    syncError.includes("unavailable"),
    "the sync error does not carry the reason",
    syncError,
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
  await waitFor(
    async () => {
      const value = await text(devtools, "agent-sync-error");
      return value.length === 0 ? true : undefined;
    },
    "the recovered sync",
    15_000,
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
  check(!existsSync(lockPath(fixture.repo)), "Stop did not release the repository lock");
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
    Array.isArray(agentFrame.agents) && agentFrame.agents.length === 4,
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
