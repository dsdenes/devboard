#!/usr/bin/env bun
/**
 * The deterministic Auto Scout gate. It drives the built dashboard in headless
 * Chrome against a fixture checkout, a stub ACP peer, and a stub `gh`: sidebar
 * order and palette entry, the first scan's shortfall and Scan now, Approve's
 * single issue with the `scout` label, Draft goal's single file, Reject, a
 * refill back to nine, a second dashboard attaching instead of spawning, Stop,
 * and a reload that preserves the board and the open tab.
 *
 * Every fixture, state directory, browser profile, and log lives under
 * `.devboard/.tmp`. It never contacts GitHub and never starts a real agent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lockPath, scansDirectory, statePath } from "../issues/scout/paths";
import { readState, type ScoutState } from "../issues/scout/state";
import { freePort, run, waitFor } from "./verification";

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
  { count: 3, shortfall: "Only three significant gaps remain." },
  { count: 9 },
  { count: 1 },
  { count: 1 },
  { count: 1 },
  { count: 1 },
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

interface Fixture {
  repo: string;
  stateDir: string;
  home: string;
  bin: string;
  pool: string;
  ghLog: string;
  acpLog: string;
  acpCounter: string;
  issues: string;
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

function recommendation(index: number): Record<string, unknown> {
  const module = (index % MODULES) + 1;
  return {
    category: ["clarity", "structure", "naming", "tests", "robustness", "correctness"][
      index % 6
    ],
    title: `Scout fixture recommendation ${index + 1}`,
    summary: `Module ${module} repeats the same rule in several branches, which hides its intent.`,
    impact: "One rule with one owner is cheaper to change and harder to break.",
    evidence: [
      {
        path: `src/module-${module}.ts`,
        lines: "1-5",
        quote: `export const value${module} = ${module};`,
      },
    ],
    proposedChange: `Extract the repeated rule in module ${module} into one named unit.`,
    files: [`src/module-${module}.ts`],
    acceptanceCriteria: [`Module ${module} states the rule once and the suite still passes.`],
  };
}

async function makeRepository(base: string): Promise<string> {
  const directory = join(base, "repo");
  await mkdir(join(directory, ".devboard", ".tmp"), { recursive: true });
  await mkdir(join(directory, ".omp", "commands"), { recursive: true });
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(join(directory, "GOAL.md"), "# Fixture goal\n");
  await writeFile(join(directory, ".omp", "commands", "scout-recommendations.md"), "# scout\n");
  for (let index = 1; index <= MODULES; index += 1) {
    await writeFile(
      join(directory, "src", `module-${index}.ts`),
      Array.from({ length: 20 }, (_value, line) => `export const value${index}_${line + 1} = ${line + 1};`).join(
        "\n",
      ),
    );
  }
  const git = (args: string[]): void => {
    const result = run("git", ["-C", directory, ...args]);
    check(result.code === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "devboard@example.test"]);
  git(["config", "user.name", "Devboard Verify"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  git(["remote", "add", "origin", "https://github.com/acme/fixture-scout.git"]);
  return directory;
}

async function makeFixture(base: string): Promise<Fixture> {
  const tools = await makeToolBin(base);
  const repo = await makeRepository(base);
  const pool = join(base, "pool.json");
  await writeFile(
    pool,
    `${JSON.stringify(Array.from({ length: 24 }, (_value, index) => recommendation(index)), null, 2)}\n`,
  );
  return {
    repo,
    stateDir: join(repo, ".devboard", ".tmp", "state"),
    home: tools.home,
    bin: tools.bin,
    pool,
    ghLog: join(base, "gh.log"),
    acpLog: join(base, "acp.log"),
    acpCounter: join(base, "acp-counter.log"),
    issues: join(base, "issues.log"),
  };
}

interface Dashboard {
  child: ChildProcess;
  port: number;
}

async function startDashboard(fixture: Fixture): Promise<Dashboard> {
  const port = await freePort();
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
      SCOUT_STUB_POOL: fixture.pool,
      SCOUT_STUB_WAVES: JSON.stringify(WAVES),
      SCOUT_STUB_GH_LOG: fixture.ghLog,
      SCOUT_STUB_ISSUES: fixture.issues,
      SCOUT_STUB_ACP_LOG: fixture.acpLog,
      SCOUT_STUB_ACP_COUNTER: fixture.acpCounter,
      SCOUT_STUB_QUESTION: "1",
      DEVBOARD_UPDATE_INTERVAL_MS: "600000",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
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
    () => (dashboard.child.exitCode !== null || dashboard.child.signalCode !== null ? true : undefined),
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
    return await waitFor(() => this.messages.slice(from).find(predicate), description, timeoutMs, 25);
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

interface WidgetSnapshot {
  id: string;
  title: string;
  category: string;
  approveCommand: string;
}

async function widgets(devtools: Devtools): Promise<WidgetSnapshot[]> {
  const value = await devtools
    .evaluate(
      `(() => Array.from(document.querySelectorAll('[data-testid="scout-widget"]')).map((element) => ({
        id: element.dataset.id ?? "",
        title: element.querySelector('.panel__title')?.textContent?.trim() ?? "",
        category: element.dataset.category ?? "",
        approveCommand: element.querySelector('[data-testid="scout-approve"]')?.dataset.command ?? "",
      })))()`,
    )
    .catch(() => undefined);
  return Array.isArray(value) ? (value as WidgetSnapshot[]) : [];
}

async function waitWidgets(devtools: Devtools, count: number, description: string): Promise<void> {
  await waitFor(
    async () => ((await widgets(devtools)).length === count ? true : undefined),
    description,
    20_000,
  );
}

/**
 * A decision removes one widget and the refill appends another, so the count
 * only dips for a moment. Wait for the board back at nine without the decided
 * item instead of racing the transient count.
 */
async function waitRefilled(devtools: Devtools, removed: string, description: string): Promise<void> {
  await waitFor(
    async () => {
      const current = await widgets(devtools);
      return current.length === 9 && !current.some((widget) => widget.id === removed)
        ? true
        : undefined;
    },
    description,
    20_000,
  );
}

function ghCalls(fixture: Fixture): string[][] {
  try {
    return readFileSync(fixture.ghLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

const dashboards: Dashboard[] = [];
let chrome: ChildProcess | undefined;
let devtools: Devtools | undefined;

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
  /* 1. Sidebar order and the palette entry                            */
  /* ---------------------------------------------------------------- */
  await click(devtools, "mode-issues");
  const sidebar = await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `(() => {
            const ids = ['open-issues-overview', 'open-issues-scout', 'open-issues-queue', 'open-issues-runs'];
            const found = ids.map((id) => document.querySelector('[data-testid="' + id + '"]'));
            if (found.some((element) => element === null)) return null;
            const labels = found.map((element) => element.querySelector('.sidebar-item__label')?.textContent?.trim() ?? '');
            const ordered = ids.every((_id, index) => index === ids.length - 1 ||
              (found[index].compareDocumentPosition(found[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
            const scoutButton = found[1];
            return {
              labels,
              ordered,
              scoutLabel: scoutButton.getAttribute('aria-label') ?? '',
              command: scoutButton.dataset.command ?? '',
              count: scoutButton.querySelector('[data-testid="scout-count"]')?.textContent?.trim() ?? '',
              current: scoutButton.getAttribute('aria-current'),
            };
          })()`,
        )
        .catch(() => undefined)) as Record<string, unknown> | null,
    "the Issues sidebar",
    15_000,
  );
  check(
    JSON.stringify(sidebar.labels) === JSON.stringify(["Overview", "Auto Scout", "Issues", "Runs"]),
    "the sidebar order is not Overview, Auto Scout, Issues, Runs",
    sidebar,
  );
  check(sidebar.ordered === true, "the sidebar entries are out of document order", sidebar);
  check(sidebar.command === "open.issues.scout", "the Auto Scout button has no command", sidebar);
  check(String(sidebar.scoutLabel).includes("Issues"), "the accessible name omits the mode", sidebar);
  check(sidebar.count === "0", "the staged count does not start at zero", sidebar);
  check(sidebar.current !== "true", "an inactive Auto Scout button claims aria-current", sidebar);
  check(workerPids(fixture.repo).length === 0, "opening the mode started a worker");
  check(!existsSync(lockPath(fixture.repo)), "opening the mode took the repository lock");

  await devtools.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })), true`,
  );
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.querySelector('[data-testid="command-palette"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    "the command palette",
    10_000,
  );
  const palette = await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `(() => {
            const input = document.querySelector('[data-testid="command-palette-input"]');
            if (input === null) return null;
            input.value = 'auto scout';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            const item = document.querySelector('[data-testid="command-palette"] [data-command="open.issues.scout"]');
            if (item === null) return null;
            let group = '';
            for (let node = item.previousElementSibling; node !== null; node = node.previousElementSibling) {
              if (node.classList.contains('palette__group')) {
                group = node.textContent?.trim() ?? '';
                break;
              }
            }
            return {
              title: item.querySelector('.palette__item-title')?.textContent?.trim() ?? '',
              group,
            };
          })()`,
        )
        .catch(() => undefined)) as Record<string, unknown> | null,
    "the Auto Scout palette entry",
    10_000,
  );
  check(palette.title === "Open Auto Scout", "the palette title is wrong", palette);
  check(palette.group === "Workspace", "the palette entry is not in Workspace", palette);
  await devtools.evaluate(
    `(() => { document.querySelector('[data-testid="command-palette"] [data-command="open.issues.scout"]').click(); return true; })()`,
  );
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.querySelector('[data-testid="issues-scout"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Auto Scout page",
    10_000,
  );
  check(workerPids(fixture.repo).length === 0, "opening the page started a worker");

  /* ---------------------------------------------------------------- */
  /* 2. Start, the shortfall, and Scan now                             */
  /* ---------------------------------------------------------------- */
  await click(devtools, "scout-start");
  await waitWidgets(devtools, 3, "the first scan's three findings");
  const shortfall = await devtools.evaluate(
    `document.querySelector('[data-testid="scout-shortfall"]')?.textContent?.trim() ?? ''`,
  );
  check(typeof shortfall === "string", "the shortfall element is missing", shortfall);
  check(shortfall.includes("3") && shortfall.includes("9"), "the shortfall does not name 3 and 9", shortfall);
  const count = await devtools.evaluate(
    `document.querySelector('[data-testid="scout-count"]')?.textContent?.trim() ?? ''`,
  );
  check(count === "3", "the staged count does not match the widgets", count);
  await waitState(fixture, "the shortfall state", (state) => state.staged.length === 3);
  check(workerPids(fixture.repo).length === 1, "Start did not spawn exactly one worker");
  await waitFor(
    () => {
      const log = existsSync(fixture.acpLog) ? readFileSync(fixture.acpLog, "utf8") : "";
      return /permission \{"outcome":\{"outcome":"selected","optionId":"allow-once"\}\}/.test(log)
        ? true
        : undefined;
    },
    "the auto-approved permission",
    10_000,
    50,
  );
  const firstActivity = await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.querySelector('[data-testid="scout-activity"]')?.textContent ?? ''`)
        .catch(() => "")) as string,
    "the scan activity",
    15_000,
  ).catch(() => "");
  check(
    firstActivity.includes("scout activity") &&
      firstActivity.includes("question:") &&
      firstActivity.includes("answer: correctness"),
    "the question and its answer are not in the activity",
    firstActivity,
  );

  await click(devtools, "scout-scan-now");
  await waitWidgets(devtools, 9, "the forced scan's nine findings");
  const fullCount = await devtools.evaluate(
    `document.querySelector('[data-testid="scout-count"]')?.textContent?.trim() ?? ''`,
  );
  check(fullCount === "9", "the staged count is not nine", fullCount);
  check(
    (await devtools.evaluate(`document.querySelector('[data-testid="scout-shortfall"]') === null`)) === true,
    "a full board still shows a shortfall",
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="scout-lifecycle"]')?.textContent?.trim() ?? ''`,
    )) === "idle",
    "the page does not report idle after the scan",
  );

  /* ---------------------------------------------------------------- */
  /* 3. Approve files one issue and the refill restores nine           */
  /* ---------------------------------------------------------------- */
  const beforeApprove = await widgets(devtools);
  const approved = beforeApprove[0]!;
  check(approved.approveCommand === `issues.scout.approve.${approved.id}`, "the approve command is wrong", approved);
  await devtools.evaluate(
    `(() => { document.querySelector('[data-testid="scout-widget"] [data-testid="scout-approve"]').click(); return true; })()`,
  );
  const issueRecord = await waitFor(
    () => {
      const lines = existsSync(fixture.issues)
        ? readFileSync(fixture.issues, "utf8").split("\n").filter(Boolean)
        : [];
      if (lines.length === 0) return undefined;
      return JSON.parse(lines[0]!) as { repo: string; title: string; label: string; body: string };
    },
    "the filed issue",
    15_000,
  );
  check(issueRecord.repo === "acme/fixture-scout", "the issue was not filed in the host origin", issueRecord);
  check(issueRecord.label === "scout", "the issue does not carry the scout label", issueRecord);
  check(issueRecord.title === approved.title, "the issue title is not the recommendation's", {
    issueRecord,
    approved,
  });
  check(issueRecord.body.includes("## Evidence"), "the issue body has no evidence", issueRecord.body);
  check(
    ghCalls(fixture).some((argv) => argv[0] === "label" && argv[1] === "create"),
    "the missing scout label was not created",
  );
  await waitRefilled(devtools, approved.id, "the refill after the approval");
  const notified = await devtools.evaluate(
    `document.querySelector('[data-testid="notifications"]')?.textContent ?? ''`,
  );
  check(
    typeof notified === "string" &&
      notified.includes("https://github.com/acme/fixture-scout/issues/1"),
    "no notification states the filed issue's URL",
    notified,
  );
  const afterApprove = await widgets(devtools);
  check(
    JSON.stringify(afterApprove.slice(0, 8).map((widget) => widget.id)) ===
      JSON.stringify(beforeApprove.slice(1).map((widget) => widget.id)),
    "the remaining widgets did not keep their positions",
    { beforeApprove, afterApprove },
  );

  /* ---------------------------------------------------------------- */
  /* 4. Draft goal writes one file and the refill restores nine        */
  /* ---------------------------------------------------------------- */
  const beforeDraft = await widgets(devtools);
  const drafted = beforeDraft[0]!;
  await devtools.evaluate(
    `(() => { document.querySelector('[data-testid="scout-widget"] [data-testid="scout-draft-goal"]').click(); return true; })()`,
  );
  const proposals = join(fixture.repo, ".devboard", "goal-proposals");
  const draftFile = await waitFor(
    () => {
      if (!existsSync(proposals)) return undefined;
      const names = readdirSync(proposals);
      return names.length === 1 ? join(proposals, names[0]!) : undefined;
    },
    "the drafted goal file",
    15_000,
  );
  const draftText = readFileSync(draftFile, "utf8");
  check(draftText.includes(drafted.title), "the draft does not carry the recommendation", draftText.slice(0, 400));
  check(
    draftText.includes("> Unprocessed draft. Refine it with `/goal-spec` before it becomes a goal."),
    "the draft has no draft notice",
  );
  await waitRefilled(devtools, drafted.id, "the refill after the draft");
  const draftNotified = await devtools.evaluate(
    `document.querySelector('[data-testid="notifications"]')?.textContent ?? ''`,
  );
  check(
    typeof draftNotified === "string" &&
      draftNotified.includes(".devboard/goal-proposals/"),
    "no notification states the draft's path",
    draftNotified,
  );

  /* ---------------------------------------------------------------- */
  /* 5. Reject removes the widget and the refill restores nine         */
  /* ---------------------------------------------------------------- */
  const rejected = (await widgets(devtools))[0]!;
  await devtools.evaluate(
    `(() => { document.querySelector('[data-testid="scout-widget"] [data-testid="scout-reject"]').click(); return true; })()`,
  );
  await waitRefilled(devtools, rejected.id, "the refill after the rejection");
  const decisions = await waitState(
    fixture,
    "the recorded decisions",
    (state) => state.decisions.length === 3,
  );
  check(decisions.staged.length === 9, "the board is not full after the refill", decisions.staged.length);
  check(
    decisions.decisions.map((entry) => entry.kind).join(",") === "approve,draft,reject",
    "the decisions are not recorded in order",
    decisions.decisions,
  );
  check(
    decisions.decisions.some((entry) => entry.kind === "reject" && entry.title === rejected.title),
    "the rejection did not record its title",
    decisions.decisions,
  );

  /* ---------------------------------------------------------------- */
  /* 6. A second dashboard attaches instead of spawning                */
  /* ---------------------------------------------------------------- */
  const second = await startDashboard(fixture);
  dashboards.push(second);
  const socket = new Socket(second.port);
  await socket.open();
  socket.send({ type: "startScout" });
  const attached = await socket.waitFrom(
    0,
    (message) => message.type === "scoutState" && message.attached === true,
    "the attach reply",
    15_000,
  );
  check(attached.attached === true, "the second dashboard did not attach", attached);
  check(Array.isArray(attached.staged) && attached.staged.length === 9, "the attach reply has no board", attached);
  check(workerPids(fixture.repo).length === 1, "the second dashboard spawned a worker", workerPids(fixture.repo));

  const attachedStage = attached.staged as Array<{ id: string; title: string }>;
  const rejectedElsewhere = attachedStage[0]!;
  socket.send({ type: "rejectScout", id: rejectedElsewhere.id });
  await waitRefilled(devtools, rejectedElsewhere.id, "the board updating from the other dashboard");
  const crossDecision = await waitState(
    fixture,
    "the decision from the other dashboard",
    (state) => state.decisions.length === 4,
  );
  check(
    crossDecision.decisions.at(-1)?.id === rejectedElsewhere.id,
    "the other dashboard's decision was not recorded",
    crossDecision.decisions,
  );
  socket.close();

  /* ---------------------------------------------------------------- */
  /* 7. Stop ends the worker and keeps the board                       */
  /* ---------------------------------------------------------------- */
  const stoppingPid = stateOf(fixture)?.worker?.pid ?? 0;
  await click(devtools, "scout-stop");
  const stopped = await waitState(
    fixture,
    "the stopped scout",
    (state) => state.lifecycle === "stopped",
  );
  check(stopped.enabled === false, "Stop left the scout enabled", stopped);
  check(stopped.staged.length === 9, "Stop discarded the staged board", stopped.staged);
  check(!existsSync(lockPath(fixture.repo)), "Stop did not release the repository lock");
  await waitFor(
    () => (workerPids(fixture.repo).length === 0 ? true : undefined),
    "the worker to exit",
    10_000,
  );
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelector('[data-testid="scout-lifecycle"]')?.textContent?.trim() ?? ''`,
        )
        .catch(() => "")) === "stopped"
        ? true
        : undefined,
    "the page to report stopped",
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

  /* ---------------------------------------------------------------- */
  /* 8. Reload preserves the board and the open tab                    */
  /* ---------------------------------------------------------------- */
  await devtools.send("Page.reload");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.readyState === "complete" && document.querySelector('[data-testid="app-shell"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    "the reloaded dashboard",
    30_000,
  );
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(`document.querySelector('[data-testid="issues-scout"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Auto Scout tab after a reload",
    20_000,
  );
  await waitWidgets(devtools, 9, "the staged board after a reload");
  check(
    workerPids(fixture.repo).length === 0,
    "reloading the dashboard started a worker",
    workerPids(fixture.repo),
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="scout-count"]')?.textContent?.trim() ?? ''`,
    )) === "9",
    "the sidebar count does not survive a reload",
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="open-issues-scout"]')?.getAttribute('aria-current') ?? ''`,
    )) === "true",
    "the Auto Scout tab is not current after a reload",
  );
  const prompts = readFileSync(fixture.acpLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("prompt /scout-recommendations "));
  check(prompts.length === 6, "a scan did not send exactly one prompt", prompts);
  check(
    readdirSync(scansDirectory(fixture.repo)).length === 6,
    "the checkout does not hold one directory per scan",
    readdirSync(scansDirectory(fixture.repo)),
  );

  console.log(
    "verify:scout: sidebar order, palette entry, shortfall, Scan now, Approve with the scout " +
      "label, Draft goal, Reject, refill to nine, second-dashboard attach and decision, Stop, and " +
      "reload passed",
  );
} finally {
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
