#!/usr/bin/env bun
/**
 * Browser verification for the complexity dashboard. Seeds three dated
 * snapshots under a fixture state directory, starts the built dashboard with
 * its clock pinned to the newest seeded day, and drives headless Chrome over
 * the DevTools protocol: the sidebar entry directly after Skills, one card per
 * project metric with the latest value, one series per metric with a point per
 * seeded date and a marked latest point, the per-file table sorted by a chosen
 * metric column, and no fourth snapshot after a restart on the recorded day.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ComplexitySnapshot } from "../server/complexity/analyze";
import { complexityDirectory, writeSnapshot } from "../server/complexity/store";
import {
  VERIFY_DASHBOARD_AUTHORIZATION,
  assertEquals,
  assertTrue,
  dashboardPageUrl,
  freePort,
  harnessRoot,
  makeRoot,
  repoRoot,
  run,
  waitFor,
} from "./verification";

const DATES = ["2026-11-01", "2026-11-02", "2026-11-03"];

/** Each seeded day differs from the last, so every series must move. */
const PROJECTS = [
  {
    files: 3,
    functions: 4,
    loc: 100,
    meanCyclomatic: 2,
    maxCyclomatic: 5,
    functionsOverThreshold: 0,
    duplicatedLineRatio: 0.02,
    meanMaintainability: 90,
  },
  {
    files: 3,
    functions: 5,
    loc: 110,
    meanCyclomatic: 2.5,
    maxCyclomatic: 6,
    functionsOverThreshold: 1,
    duplicatedLineRatio: 0.04,
    meanMaintainability: 85,
  },
  {
    files: 3,
    functions: 6,
    loc: 120,
    meanCyclomatic: 3,
    maxCyclomatic: 7,
    functionsOverThreshold: 2,
    duplicatedLineRatio: 0.06,
    meanMaintainability: 80,
  },
];

const FILES = [
  {
    path: ".devboard/server/alpha.ts",
    loc: 30,
    functions: 2,
    duplicatedLineRatio: 0.5,
    maintainability: 91,
  },
  {
    path: ".devboard/server/beta.ts",
    loc: 10,
    functions: 1,
    duplicatedLineRatio: 0,
    maintainability: 88,
  },
  {
    path: ".devboard/server/gamma.ts",
    loc: 20,
    functions: 3,
    duplicatedLineRatio: 0.25,
    maintainability: 80,
  },
];

/** The newest seeded day's cards, in the page's order. */
const EXPECTED_CARDS: Array<[string, string]> = [
  ["files", "3"],
  ["functions", "6"],
  ["loc", "120"],
  ["meanCyclomatic", "3.00"],
  ["maxCyclomatic", "7"],
  ["functionsOverThreshold", "2"],
  ["duplicatedLineRatio", "0.0600"],
  ["meanMaintainability", "80.00"],
];

const LINES_ASCENDING = [
  ".devboard/server/beta.ts",
  ".devboard/server/gamma.ts",
  ".devboard/server/alpha.ts",
];

const PATH_ORDER = [
  ".devboard/server/alpha.ts",
  ".devboard/server/beta.ts",
  ".devboard/server/gamma.ts",
];

const root = await makeRoot("verify-complexity");
let chromePid = 0;
let dashboard: ChildProcess | undefined;
let devtools: Devtools | undefined;

function seeded(date: string, index: number): ComplexitySnapshot {
  const project = PROJECTS[index];
  if (project === undefined) throw new Error(`no project fixture for ${date}`);
  return {
    version: 1,
    date,
    recordedAt: `${date}T00:00:00.000Z`,
    project,
    files: FILES,
    functions: [
      {
        path: ".devboard/server/alpha.ts",
        name: "alpha",
        line: 1,
        lines: 3,
        cyclomatic: index + 1,
        nesting: 0,
        parameters: 1,
      },
    ],
  };
}

function chromePath(): string {
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ]) {
    if (Bun.file(candidate).size > 0) return candidate;
  }
  throw new Error("verify:complexity: /usr/bin/google-chrome is unavailable");
}

interface CdpReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class Devtools {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (reply: CdpReply) => void>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.socket.onopen = () => resolve();
    this.socket.onerror = () => reject(new Error("devtools websocket error"));
    await promise;
    this.socket.onmessage = (event) => {
      let reply: CdpReply;
      try {
        reply = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof reply.id !== "number") return;
      this.pending.get(reply.id)?.(reply);
      this.pending.delete(reply.id);
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpReply> {
    const { promise, resolve } = Promise.withResolvers<CdpReply>();
    const id = this.nextId;
    this.nextId += 1;
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
    if (reply.error !== undefined) throw new Error(reply.error.message ?? "evaluation failed");
    const result = reply.result;
    if (result === undefined || !("result" in result)) return undefined;
    const value = result.result;
    if (typeof value !== "object" || value === null || !("value" in value)) return undefined;
    return value.value;
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
  return waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        const targets = (await response.json()) as Array<{
          type?: string;
          url?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.webSocketDebuggerUrl === "string" &&
            target.url?.includes(`:${dashboardPort}/`),
        );
        return page?.webSocketDebuggerUrl;
      } catch {
        return undefined;
      }
    },
    "the Chrome page target",
    30_000,
  );
}

async function stopDashboard(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  child.once("exit", () => resolve());
  child.kill("SIGTERM");
  await promise;
}

try {
  const build = run("bun", ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `the client build failed: ${build.stderr.slice(-2000)}`);

  const stateDir = join(root, "state");
  const directory = complexityDirectory(stateDir, repoRoot);
  for (const [index, date] of DATES.entries()) {
    await writeSnapshot(directory, seeded(date, index));
  }
  assertEquals(
    (await readdir(directory)).sort(),
    DATES.map((date) => `${date}.json`),
    "seeded days",
  );
  console.log(`PASS seeded=${DATES.length} directory=${directory}`);

  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    REPO_DIR: repoRoot,
    ADRS_DIR: join(repoRoot, "adrs"),
    GOAL_FILE: join(repoRoot, "GOAL.md"),
    STATIC_DIR: join(harnessRoot, "dist"),
    STATE_DIR: stateDir,
    // The daily rule follows this pinned day, so the seeded day is "today".
    DEVBOARD_COMPLEXITY_NOW: `${DATES[2]}T12:00:00.000Z`,
    DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
    DEVBOARD_ISSUES_SYNC_INTERVAL_MS: "3600000",
    DEVBOARD_SOURCE_REFRESH_INTERVAL_MS: "3600000",
    GIT_TERMINAL_PROMPT: "0",
  };
  const start = (): ChildProcess => {
    const child = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors += String(chunk);
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) process.stderr.write(errors.slice(-2000));
    });
    return child;
  };
  const ready = async (): Promise<void> => {
    await waitFor(
      async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/ready`, {
            headers: VERIFY_DASHBOARD_AUTHORIZATION,
            signal: AbortSignal.timeout(2000),
          });
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      "the complexity dashboard",
      30_000,
    );
  };

  dashboard = start();
  await ready();

  const debugPort = await freePort();
  const profile = join(root, "chrome-profile");
  await mkdir(profile, { recursive: true });
  const chrome = spawn(
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
      dashboardPageUrl(port),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromePid = chrome.pid ?? 0;
  devtools = new Devtools(await pageTarget(debugPort, port));
  await devtools.connect();
  await devtools.send("Runtime.enable");
  await devtools.send("Page.enable");

  const openComplexityPage = async (): Promise<void> => {
    await waitFor(
      async () =>
        (await devtools
          ?.evaluate(`document.querySelector('[data-testid="app-shell"]') !== null`)
          .catch(() => false)) === true
          ? true
          : undefined,
      "the dashboard shell",
      30_000,
    );
    await devtools.evaluate(
      `document.querySelector('[data-testid="mode-devboard"]')?.click(); true`,
    );
    const labels = await waitFor(
      async () => {
        const value = await devtools
          ?.evaluate(
            `[...document.querySelectorAll('[data-testid="devboard-tab"]')]` +
              `.map((entry) => entry.textContent.trim())`,
          )
          .catch(() => undefined);
        return Array.isArray(value) && value.length >= 3 ? value : undefined;
      },
      "the Devboard sidebar entries",
      30_000,
    );
    assertEquals(
      labels,
      ["MCP tools", "Skills", "Complexity"],
      "the complexity entry sits directly after Skills",
    );
    await devtools.evaluate(
      `document.querySelectorAll('[data-testid="devboard-tab"]')[2]?.click(); true`,
    );
    await waitFor(
      async () =>
        (await devtools
          ?.evaluate(`(() => {
            const series = document.querySelectorAll('[data-testid="complexity-series"]');
            const summary = document.querySelector('[data-testid="complexity-summary"]');
            return series.length === 8 && summary?.getAttribute('data-count') === '3';
          })()`)
          .catch(() => false)) === true
          ? true
          : undefined,
      "the complexity page's eight series and recorded frame",
      30_000,
    );
  };

  const summary = async (): Promise<{ count: string | null; date: string | null }> =>
    (await devtools?.evaluate(`(() => {
      const node = document.querySelector('[data-testid="complexity-summary"]');
      if (node === null) return { count: null, date: null };
      return {
        count: node.getAttribute('data-count'),
        date: node.getAttribute('data-date'),
      };
    })()`)) as { count: string | null; date: string | null };

  const rowPaths = async (): Promise<string[]> =>
    (await devtools?.evaluate(
      `[...document.querySelectorAll('[data-testid="complexity-file-row"]')]` +
        `.map((row) => row.getAttribute('data-path'))`,
    )) as string[];

  await openComplexityPage();
  console.log("PASS sidebar=MCP tools,Skills,Complexity page=complexity");

  const cards = await devtools.evaluate(
    `[...document.querySelectorAll('[data-testid="complexity-card"]')]` +
      `.map((card) => [card.getAttribute('data-metric'), card.getAttribute('data-value')])`,
  );
  assertEquals(cards, EXPECTED_CARDS, "one card per project metric with the latest value");
  console.log(`PASS cards=${JSON.stringify(cards)}`);

  const series = (await devtools.evaluate(
    `[...document.querySelectorAll('[data-testid="complexity-series"]')].map((entry) => {
      const points = [...entry.querySelectorAll('[data-testid="complexity-series-point"]')];
      return {
        metric: entry.getAttribute('data-metric'),
        points: entry.getAttribute('data-points'),
        dates: points.map((point) => point.getAttribute('data-date')),
        latest: [...entry.querySelectorAll('[data-testid="complexity-series-latest"]')]
          .map((marker) => marker.getAttribute('data-date')),
        levels: points.map((point) => Number(point.getAttribute('cy'))),
      };
    })`,
  )) as Array<{
    metric: string | null;
    points: string | null;
    dates: Array<string | null>;
    latest: Array<string | null>;
    levels: number[];
  }>;
  assertEquals(
    series.map((entry) => entry.metric),
    EXPECTED_CARDS.map(([metric]) => metric),
    "one series per project metric",
  );
  for (const entry of series) {
    assertEquals(entry.points, String(DATES.length), `points for ${entry.metric}`);
    assertEquals(entry.dates, DATES, `dates for ${entry.metric}`);
    assertEquals(entry.latest, [DATES[2]], `latest marker for ${entry.metric}`);
  }
  const rising = series.find((entry) => entry.metric === "meanCyclomatic");
  assertTrue(
    rising !== undefined && new Set(rising.levels).size === DATES.length,
    "a changed value moves its point, so the latest date is not flat",
  );
  console.log(`PASS series=${series.length} points=${DATES.length} latest=${DATES[2]}`);

  const initial = await summary();
  assertEquals([initial.count, initial.date], ["3", DATES[2]], "the recorded summary");
  assertEquals(await rowPaths(), PATH_ORDER, "the per-file table's default order");
  await devtools.evaluate(
    `document.querySelector('[data-testid="complexity-sort"][data-sort="loc"]')?.click(); true`,
  );
  await waitFor(
    async () => {
      const paths = await rowPaths();
      return JSON.stringify(paths) === JSON.stringify(LINES_ASCENDING) ? true : undefined;
    },
    "the per-file table sorted by lines",
    10_000,
  );
  console.log(`PASS files=${LINES_ASCENDING.length} sorted=loc`);

  await stopDashboard(dashboard);
  dashboard = start();
  await ready();
  await devtools.send("Page.reload", { ignoreCache: true });
  await openComplexityPage();
  await waitFor(
    async () => {
      const state = await summary();
      return state.count === "3" && state.date === DATES[2] ? true : undefined;
    },
    "the reloaded page's recorded summary",
    30_000,
  );
  assertEquals(
    (await readdir(directory)).sort(),
    DATES.map((date) => `${date}.json`),
    "a restart on the recorded day adds no fourth snapshot",
  );
  console.log(`PASS restart=no-new-snapshot count=3`);

  console.log("verify:complexity: the complexity dashboard's page and daily rule passed");
} finally {
  devtools?.close();
  if (chromePid > 0) {
    try {
      process.kill(chromePid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await stopDashboard(dashboard).catch(() => undefined);
}
