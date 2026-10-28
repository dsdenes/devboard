#!/usr/bin/env bun
/**
 * Browser contract for the watchdog: the Issues-mode Watchdog page and the
 * footer indicator. Builds the client, seeds watchdog run directories, a
 * ledger, and a stub `gh`, starts a source dashboard, and drives headless
 * Chrome over the DevTools protocol. It proves the empty states, the newest
 * cycle, the cycle history, the filed-issue table with GitHub state and
 * shipped version, the 60-second background refresh, a failed read that keeps
 * the rows, a later release that fills a blank version, freshness without a
 * reload, and the unchanged footer indicator and popover.
 */

import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { saveLedger, type Ledger } from "../watchdog/ledger";
import { assertTrue, freePort, harnessRoot, makeHost, makeRoot, run, waitFor } from "./verification";

const MAX_ISSUES = 10;
const ISSUE_COUNT = 12;
const FIRST_ISSUE = 901;

const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (Bun.file(candidate).size > 0) return candidate;
  }
  throw new Error("verify:watchdog: /usr/bin/google-chrome is unavailable");
}

interface CdpReply {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class Devtools {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (reply: CdpReply) => void>();

  /** Every uncaught exception and console error the page reported. */
  readonly errors: string[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(): Promise<void> {
    const opened = Promise.withResolvers<void>();
    this.socket.onopen = () => opened.resolve();
    this.socket.onerror = () => opened.reject(new Error("devtools websocket error"));
    await opened.promise;
    this.socket.onmessage = (event) => {
      let reply: CdpReply;
      try {
        reply = JSON.parse(String(event.data)) as CdpReply;
      } catch {
        return;
      }
      if (typeof reply.id === "number") {
        this.pending.get(reply.id)?.(reply);
        this.pending.delete(reply.id);
        return;
      }
      if (reply.method === "Runtime.exceptionThrown") {
        this.errors.push(JSON.stringify(reply.result ?? {}));
      }
      if (reply.method === "Runtime.consoleAPICalled") {
        const type = (reply.result as { type?: unknown } | undefined)?.type;
        if (type === "error") this.errors.push(JSON.stringify(reply.result ?? {}));
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpReply> {
    const { promise, resolve: settle } = Promise.withResolvers<CdpReply>();
    const id = this.nextId;
    this.nextId += 1;
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
    if (reply.error !== undefined) throw new Error(reply.error.message ?? "evaluation failed");
    const result = reply.result;
    if (result === undefined || !("result" in result)) return undefined;
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

async function click(devtools: Devtools, testid: string): Promise<void> {
  const clicked = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    if (element === null) return false;
    element.click();
    return true;
  })()`);
  assertTrue(clicked === true, `verify:watchdog: ${testid} is not clickable`);
}

async function text(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    return element === null ? "" : (element.textContent ?? "").replace(/\\s+/g, " ").trim();
  })()`);
  return typeof value === "string" ? value : "";
}

async function present(devtools: Devtools, testid: string): Promise<boolean> {
  return (
    (await devtools.evaluate(
      `document.querySelector('[data-testid="${testid}"]') !== null`,
    )) === true
  );
}

interface RenderedLink {
  href?: string;
  target?: string;
  rel?: string;
}

/** Narrow the browser's link snapshot without trusting its shape. */
function renderedLinks(value: unknown): RenderedLink[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("links" in value) || !Array.isArray(value.links)) return undefined;
  const links: RenderedLink[] = [];
  for (const link of value.links) {
    if (typeof link !== "object" || link === null) continue;
    links.push({
      ...("href" in link && typeof link.href === "string" ? { href: link.href } : {}),
      ...("target" in link && typeof link.target === "string" ? { target: link.target } : {}),
      ...("rel" in link && typeof link.rel === "string" ? { rel: link.rel } : {}),
    });
  }
  return links;
}

interface RenderedCycleIssue {
  href: string;
  text: string;
}

interface RenderedCycle {
  action: string;
  at: string;
  datetime: string;
  actionText: string;
  issues: RenderedCycleIssue[];
  /** True when the removed interval, finding count, and reason render nothing. */
  compact: boolean;
}

interface RenderedIssue {
  url: string;
  state: string;
  version: string;
  title: string;
  href: string;
  category: string;
  filed: string;
  filedText: string;
  stateText: string;
  versionText: string;
}

function renderedCycleIssues(value: unknown): RenderedCycleIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: RenderedCycleIssue[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    issues.push({ href: String(record.href ?? ""), text: String(record.text ?? "") });
  }
  return issues;
}

function renderedCycles(value: unknown): RenderedCycle[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cycles: RenderedCycle[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    cycles.push({
      action: String(record.action ?? ""),
      at: String(record.at ?? ""),
      datetime: String(record.datetime ?? ""),
      actionText: String(record.actionText ?? ""),
      issues: renderedCycleIssues(record.issues),
      compact: record.compact === true,
    });
  }
  return cycles;
}

function renderedIssues(value: unknown): RenderedIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: RenderedIssue[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    issues.push({
      url: String(record.url ?? ""),
      state: String(record.state ?? ""),
      version: String(record.version ?? ""),
      title: String(record.title ?? ""),
      href: String(record.href ?? ""),
      category: String(record.category ?? ""),
      filed: String(record.filed ?? ""),
      filedText: String(record.filedText ?? ""),
      stateText: String(record.stateText ?? ""),
      versionText: String(record.versionText ?? ""),
    });
  }
  return issues;
}

const readCycles = `(() => [...document.querySelectorAll('[data-testid="watchdog-cycle"]')].map((row) => ({
  action: row.dataset.action ?? '',
  at: row.querySelector('[data-testid="watchdog-cycle-at"]')?.textContent?.trim() ?? '',
  datetime: row.querySelector('[data-testid="watchdog-cycle-at"] time')?.getAttribute('datetime') ?? '',
  actionText: row.querySelector('[data-testid="watchdog-cycle-action"]')?.textContent?.trim() ?? '',
  issues: [...row.querySelectorAll('[data-testid="watchdog-cycle-issue"]')].map((link) => ({
    href: link.getAttribute('href') ?? '',
    text: link.textContent?.trim() ?? '',
  })),
  compact: row.querySelector('[data-testid="watchdog-cycle-window"]') === null &&
    row.querySelector('[data-testid="watchdog-cycle-findings"]') === null &&
    row.querySelector('[data-testid="watchdog-cycle-reason"]') === null,
})))()`;

const readIssues = `(() => [...document.querySelectorAll('[data-testid="watchdog-issue"]')].map((row) => ({
  url: row.dataset.url ?? '',
  state: row.dataset.state ?? '',
  version: row.dataset.version ?? '',
  title: row.querySelector('[data-testid="watchdog-issue-title"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
  href: row.querySelector('[data-testid="watchdog-issue-title"]')?.getAttribute('href') ?? '',
  category: row.querySelector('[data-testid="watchdog-issue-category"]')?.textContent?.trim() ?? '',
  filed: row.querySelector('[data-testid="watchdog-issue-filed"]')?.getAttribute('datetime') ?? '',
  filedText: row.querySelector('[data-testid="watchdog-issue-filed"]')?.textContent?.trim() ?? '',
  stateText: row.querySelector('[data-testid="watchdog-issue-state"]')?.textContent?.trim() ?? '',
  versionText: row.querySelector('[data-testid="watchdog-issue-version"]')?.textContent?.trim() ?? '',
})))()`;

function issueUrl(index: number): string {
  return `https://github.com/dsdenes/devboard/issues/${FIRST_ISSUE + index}`;
}

interface EntryFixture {
  category: string;
  line: string;
  url: string;
  filedAt: string;
  disposition?: string;
}

function ledgerFixture(entries: EntryFixture[], pending: string[]): Ledger {
  return {
    version: 2,
    findings: Object.fromEntries(
      entries.map((entry, index) => [
        `fingerprint-${index}`,
        {
          category: entry.category,
          line: entry.line,
          firstSeen: entry.filedAt,
          lastSeen: entry.filedAt,
          count: 1,
          disposition: entry.disposition ?? `filed:${entry.url}`,
          ...(entry.disposition === "none" ? {} : { url: entry.url }),
          ...(entry.disposition === "none" ? {} : { filedAt: entry.filedAt }),
          instances: [],
        },
      ]),
    ),
    pendingFiling: pending,
  };
}

const GH_STUB = `#!/bin/sh
set -u
fixtures="$(cd "$(dirname "$0")/.." && pwd)/gh"
args="$*"
# The fail marker simulates an expired credential for the tracker reads the
# watchdog page makes. The dashboard's update check shares this stub, so keep
# answering its latest-release read or the fixture journals an update-error.
if [ -f "$fixtures/fail" ]; then
  case "$args" in
    *"repos/dsdenes/devboard/releases/latest"*) ;;
    *) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;
  esac
fi
case "$args" in
  *"repos/dsdenes/devboard/issues/901 --jq .state"*) echo open ;;
  *"repos/dsdenes/devboard/issues/902 --jq .state"*) echo closed ;;
  *"repos/dsdenes/devboard/issues/903 --jq .state"*) echo closed ;;
  *"repos/dsdenes/devboard/issues/904 --jq .state"*) echo open ;;
  *"/issues/"*"--jq .state"*) echo open ;;
  *"repos/dsdenes/devboard/issues/901/timeline"*) : ;;
  *"repos/dsdenes/devboard/issues/902/timeline"*) echo 1111111 ;;
  *"repos/dsdenes/devboard/issues/903/timeline"*) : ;;
  *"repos/dsdenes/devboard/issues/901/comments"*) : ;;
  *"repos/dsdenes/devboard/issues/902/comments"*) : ;;
  *"repos/dsdenes/devboard/issues/903/comments"*) printf '%s\\n' '{"body":"fixed by 2222222"}' ;;
  *"repos/dsdenes/devboard/commits/1111111 --jq .sha"*) echo 1111111111111111111111111111111111111111 ;;
  *"repos/dsdenes/devboard/commits/2222222 --jq .sha"*) echo 2222222222222222222222222222222222222222 ;;
  *"repos/dsdenes/devboard/releases/latest"*) cat "$fixtures/release.json" ;;
  *"repos/dsdenes/devboard/releases"*) cat "$fixtures/releases.jsonl" ;;
  *"compare/1111111111111111111111111111111111111111...v1.0.0"*) echo ahead ;;
  *"compare/2222222222222222222222222222222222222222...v1.2.0"*) echo ahead ;;
  *"compare/"*) echo behind ;;
  *) echo "unexpected gh arguments: $args" >&2; exit 1 ;;
esac
`;

const root = await makeRoot("verify-watchdog");
let dashboardPid = 0;
let chromePid = 0;

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:watchdog: bun run build failed: ${build.stderr}`);
  assertTrue(
    Bun.file(join(harnessRoot, "dist", "index.html")).size > 0,
    "verify:watchdog: the build produced dist/index.html",
  );

  const host = await makeHost(root, "host");
  run("git", ["-C", host.directory, "remote", "add", "origin", "https://github.com/acme/fixture.git"]);
  const stateDir = join(root, "state");
  const watchdogDir = join(stateDir, "watchdog");
  await mkdir(watchdogDir, { recursive: true });
  const binDir = join(root, "bin");
  const ghFixtures = join(root, "gh");
  await mkdir(binDir, { recursive: true });
  await mkdir(ghFixtures, { recursive: true });
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, GH_STUB);
  chmodSync(ghPath, 0o755);
  await writeFile(
    join(ghFixtures, "releases.jsonl"),
    '{"tag":"v1.0.0","publishedAt":"2026-10-20T00:00:00Z","draft":false}\n' +
      '{"tag":"v1.1.0","publishedAt":"2026-10-21T00:00:00Z","draft":false}\n',
  );
  // The update check reads the newest release as one object, not the listing.
  await writeFile(
    join(ghFixtures, "release.json"),
    '{"tag_name":"v1.1.0","assets":[]}\n',
  );

  const port = await freePort();
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      REPO_DIR: host.directory,
      ADRS_DIR: join(host.directory, "adrs"),
      GOAL_FILE: join(host.directory, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: stateDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  dashboardPid = dashboard.pid ?? 0;

  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the seeded dashboard",
    30_000,
  );

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
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromePid = chrome.pid ?? 0;

  const devtools = new Devtools(await pageTarget(debugPort, port));
  await devtools.connect();
  try {
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    /* ---------------------------------------------------------------- */
    /* 1. The sidebar entry and an empty page                            */
    /* ---------------------------------------------------------------- */
    await waitFor(
      async () => ((await present(devtools, "mode-issues")) ? true : undefined),
      "the Issues mode control",
      30_000,
    );
    await click(devtools, "mode-issues");
    await waitFor(
      async () => ((await present(devtools, "open-issues-watchdog")) ? true : undefined),
      "the Watchdog sidebar entry",
      15_000,
    );
    const entry = await devtools.evaluate(`(() => {
      const button = document.querySelector('[data-testid="open-issues-watchdog"]');
      if (button === null) return null;
      const previous = button.previousElementSibling;
      return {
        command: button.dataset.command ?? '',
        label: button.textContent?.trim() ?? '',
        previous: previous?.getAttribute('data-testid') ?? '',
      };
    })()`);
    const entryRecord = entry as Record<string, unknown> | null;
    assertTrue(
      entryRecord?.command === "open.issues.watchdog",
      `the Watchdog entry has no command: ${JSON.stringify(entryRecord)}`,
    );
    assertTrue(
      entryRecord?.label === "Watchdog",
      `the Watchdog entry label is ${String(entryRecord?.label)}`,
    );
    assertTrue(
      entryRecord?.previous === "open-issues-scout",
      `the Watchdog entry does not follow Auto Scout: ${String(entryRecord?.previous)}`,
    );
    console.log("PASS open-issues-watchdog");

    await click(devtools, "open-issues-watchdog");
    await waitFor(
      async () => ((await present(devtools, "watchdog-page")) ? true : undefined),
      "the Watchdog page",
      10_000,
    );
    assertTrue(
      (await devtools.evaluate(
        `document.querySelector('[data-testid="watchdog-header"] h1')?.textContent?.trim() ?? ''`,
      )) === "Watchdog",
      "the page title is Watchdog",
    );
    assertTrue(await present(devtools, "watchdog-cycles-empty"), "no cycle renders no empty state");
    assertTrue(await present(devtools, "watchdog-issues-empty"), "no issue renders no empty state");
    // The first projection arrives asynchronously; "none" is the server's answer.
    const emptyAction = await waitFor(
      async () => {
        const value = await text(devtools, "watchdog-last-action").catch(() => "");
        return value === "none" ? value : undefined;
      },
      "the empty watchdog projection",
      10_000,
    );
    assertTrue(emptyAction === "none", "an empty page invents an action");
    assertTrue(
      (await text(devtools, "watchdog-last-cycle-at")) === "never",
      "an empty page does not show `never`",
    );
    const current = await devtools.evaluate(
      `document.querySelector('[data-testid="open-issues-watchdog"]')?.getAttribute('aria-current') ?? ''`,
    );
    assertTrue(current === "true", "the Watchdog entry is not the active tab");
    console.log("PASS watchdog-page-empty");

    /* ---------------------------------------------------------------- */
    /* 2. Seed the local facts while the page is open                    */
    /* ---------------------------------------------------------------- */
    const cycleTimes = ["2026-10-24T10:00:00.000Z", "2026-10-24T11:00:00.000Z", "2026-10-24T12:00:00.000Z"];
    const reports = [
      { cycle: cycleTimes[0], action: "failed", findings: 2, reason: "gh unavailable" },
      { cycle: cycleTimes[1], action: "duplicate", findings: 0 },
      { cycle: cycleTimes[2], action: "filed", findings: 1, reason: "filed 1 issue(s)" },
    ];
    for (const report of reports) {
      const name = report.cycle.replace(/[:.]/g, "-");
      await mkdir(join(watchdogDir, "runs", name), { recursive: true });
      await writeFile(
        join(watchdogDir, "runs", name, "report.json"),
        JSON.stringify({
          ...report,
          window: { start: report.cycle, end: report.cycle, minutes: 10 },
          instances: [],
          findings: Array.from({ length: report.findings }, (_unused, index) => ({
            fingerprint: `fingerprint-${index}`,
          })),
          issues: [],
          pending: 0,
          malformed: 0,
          unattributed: 0,
        }),
      );
    }
    const broken = "2026-10-24T13-00-00-000Z";
    await mkdir(join(watchdogDir, "runs", broken), { recursive: true });
    await writeFile(join(watchdogDir, "runs", broken, "report.json"), "{not json");

    const latest = {
      cycle: "2026-10-24T12:00:00.000Z",
      window: { start: "2026-10-24T11:50:00.000Z", end: "2026-10-24T12:00:00.000Z", minutes: 10 },
      instances: [],
      findings: [{ fingerprint: "1" }, { fingerprint: "2" }],
      action: "filed",
      issues: [],
      pending: 0,
      reason: "filed 2 issue(s)",
      malformed: 0,
      unattributed: 0,
    };
    await writeFile(join(watchdogDir, "latest.json"), JSON.stringify(latest));

    const entries: EntryFixture[] = [
      { category: "server-error", line: "Synthetic error A", url: issueUrl(0), filedAt: "2026-10-24T12:00:00.000Z" },
      { category: "stall", line: "lane-1 implementing", url: issueUrl(1), filedAt: "2026-10-24T11:00:00.000Z" },
      { category: "update-error", line: "release check failed", url: issueUrl(2), filedAt: "2026-10-24T10:00:00.000Z" },
      { category: "omp-warn", line: "slow response", url: issueUrl(3), filedAt: "2026-10-24T09:00:00.000Z", disposition: "none" },
    ];
    saveLedger(watchdogDir, ledgerFixture(entries, ["fingerprint-3"]));

    const seededCycles = await waitFor(
      async () => {
        const value = renderedCycles(await devtools.evaluate(readCycles).catch(() => undefined));
        return value !== undefined && value.length === 3 ? value : undefined;
      },
      "the cycle history",
      20_000,
    );
    assertTrue(
      JSON.stringify(seededCycles.map((cycle) => cycle.action)) ===
        JSON.stringify(["filed", "duplicate", "failed"]),
      `the cycle history is not newest first: ${JSON.stringify(seededCycles)}`,
    );
    assertTrue(
      seededCycles[0]?.datetime === cycleTimes[2] &&
        seededCycles[1]?.datetime === cycleTimes[1] &&
        seededCycles[2]?.datetime === cycleTimes[0],
      "a cycle row carries the wrong start time",
    );
    assertTrue(
      seededCycles.every((cycle) => cycle.compact),
      "a cycle row still renders its interval or finding count",
    );
    assertTrue(
      JSON.stringify(seededCycles.map((cycle) => cycle.issues.map((issue) => issue.href))) ===
        JSON.stringify([[issueUrl(0)], [], [issueUrl(0), issueUrl(1)]]),
      `a cycle row links the wrong GitHub issue: ${JSON.stringify(seededCycles)}`,
    );
    assertTrue(
      seededCycles[2]?.issues.map((issue) => issue.text).join(" ") === "#901 #902",
      "a connected issue link does not name its number",
    );
    assertTrue(
      !(await devtools.evaluate(
        `document.querySelector('[data-testid="watchdog-cycle-reason"]') !== null`,
      )),
      "a cycle row still renders a reason",
    );
    console.log("PASS watchdog-cycles");

    const localIssues = await waitFor(
      async () => {
        const value = renderedIssues(await devtools.evaluate(readIssues).catch(() => undefined));
        return value !== undefined && value.length === 3 ? value : undefined;
      },
      "the filed issues from the ledger",
      20_000,
    );
    assertTrue(
      JSON.stringify(localIssues.map((issue) => issue.url)) ===
        JSON.stringify([issueUrl(0), issueUrl(1), issueUrl(2)]),
      `the table is not newest first: ${JSON.stringify(localIssues.map((issue) => issue.url))}`,
    );
    assertTrue(
      (await devtools.evaluate(
        `document.querySelector('[data-testid="watchdog-last-cycle-at"] time')?.getAttribute('datetime') ?? ''`,
      )) === "2026-10-24T12:00:00.000Z",
      "the newest cycle does not show its start time",
    );
    assertTrue((await text(devtools, "watchdog-last-action")) === "filed", "the newest action is wrong");
    assertTrue((await text(devtools, "watchdog-last-findings")) === "2", "the newest finding count is wrong");
    assertTrue((await text(devtools, "watchdog-last-pending")) === "1", "the pending filing count is wrong");
    assertTrue(
      (await text(devtools, "watchdog-last-reason")) === "filed 2 issue(s)",
      "the newest reason is missing",
    );
    console.log("PASS watchdog-fresh-ledger");

    /* ---------------------------------------------------------------- */
    /* 3. GitHub states and shipped versions arrive on a later request   */
    /* ---------------------------------------------------------------- */
    const projected = await waitFor(
      async () => {
        const value = renderedIssues(await devtools.evaluate(readIssues).catch(() => undefined));
        if (value === undefined || value.length !== 3) return undefined;
        const sync = await devtools
          .evaluate(`document.querySelector('[data-testid="watchdog-sync"]')?.dataset.state ?? ''`)
          .catch(() => "");
        const states = value.map((issue) => `${issue.url}:${issue.state}:${issue.version}`);
        return sync === "ok" && states[0] === `${issueUrl(0)}:pending:` &&
          states[1] === `${issueUrl(1)}:implemented:v1.0.0` &&
          states[2] === `${issueUrl(2)}:implemented:`
          ? value
          : undefined;
      },
      "the GitHub projection",
      90_000,
    );
    assertTrue(
      projected[0]?.title === "[watchdog] server-error: Synthetic error A",
      `an issue title is wrong: ${String(projected[0]?.title)}`,
    );
    assertTrue(
      projected[0]?.href === issueUrl(0) &&
        projected.every((issue) => issue.category.length > 0),
      "an issue row is missing its URL or category",
    );
    assertTrue(
      projected[1]?.filed === "2026-10-24T11:00:00.000Z" &&
        (projected[1]?.filedText ?? "").length > 0,
      "an issue row is missing its filed time",
    );
    assertTrue(
      projected[0]?.stateText === "pending" && projected[1]?.stateText === "implemented",
      "an issue row renders the wrong state",
    );
    assertTrue(
      projected[1]?.versionText === "v1.0.0" && projected[2]?.versionText === "—",
      "an issue row renders the wrong shipped version",
    );
    assertTrue(
      (await text(devtools, "watchdog-sync-at")) !== "never",
      "a successful read leaves the last-success time at never",
    );
    console.log("PASS watchdog-issues");

    /* ---------------------------------------------------------------- */
    /* 4. A failed read keeps the rows and reports its reason            */
    /* ---------------------------------------------------------------- */
    await writeFile(join(ghFixtures, "fail"), "");
    // The marker fakes an expired credential for tracker reads. The update
    // check shares the same gh, so prove its release read still succeeds:
    // otherwise the fixture itself journals an update-error the watchdog files.
    const failEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
    const releaseWhileFailing = run(
      join(binDir, "gh"),
      ["api", "repos/dsdenes/devboard/releases/latest"],
      { env: failEnv },
    );
    assertTrue(
      releaseWhileFailing.code === 0 && releaseWhileFailing.stdout.includes('"tag_name"'),
      `the fail fixture broke the update release check: ${releaseWhileFailing.stderr}`,
    );
    const trackerWhileFailing = run(
      join(binDir, "gh"),
      ["api", "repos/dsdenes/devboard/issues/901"],
      { env: failEnv },
    );
    assertTrue(
      trackerWhileFailing.code !== 0 && trackerWhileFailing.stderr.includes("Bad credentials"),
      "the fail fixture no longer fails tracker reads",
    );
    const failed = await waitFor(
      async () => {
        const state = await devtools
          .evaluate(`document.querySelector('[data-testid="watchdog-sync"]')?.dataset.state ?? ''`)
          .catch(() => "");
        return state === "error" ? state : undefined;
      },
      "the failed sync badge",
      90_000,
    );
    assertTrue(failed === "error", "the sync badge did not report an error");
    const failureText = await text(devtools, "watchdog-sync-error");
    assertTrue(
      failureText.includes("Bad credentials"),
      `the sync error does not show the failure reason: ${failureText}`,
    );
    const afterFailure = renderedIssues(await devtools.evaluate(readIssues));
    assertTrue(
      afterFailure !== undefined && afterFailure.length === 3,
      "a failed read hid the filed issues",
    );
    assertTrue(
      afterFailure[1]?.version === "v1.0.0" && afterFailure[1]?.state === "implemented",
      "a failed read dropped a last known state or version",
    );
    console.log("PASS watchdog-sync-error");

    /* ---------------------------------------------------------------- */
    /* 5. Recovery and a release published later fill a blank version    */
    /* ---------------------------------------------------------------- */
    await rm(join(ghFixtures, "fail"), { force: true });
    await writeFile(
      join(ghFixtures, "releases.jsonl"),
      '{"tag":"v1.0.0","publishedAt":"2026-10-20T00:00:00Z","draft":false}\n' +
        '{"tag":"v1.1.0","publishedAt":"2026-10-21T00:00:00Z","draft":false}\n' +
        '{"tag":"v1.2.0","publishedAt":"2026-10-28T00:00:00Z","draft":false}\n',
    );
    const recovered = await waitFor(
      async () => {
        const value = renderedIssues(await devtools.evaluate(readIssues).catch(() => undefined));
        const sync = await devtools
          .evaluate(`document.querySelector('[data-testid="watchdog-sync"]')?.dataset.state ?? ''`)
          .catch(() => "");
        return sync === "ok" && value?.[2]?.version === "v1.2.0" ? value : undefined;
      },
      "the recovered GitHub projection",
      90_000,
    );
    assertTrue(
      recovered[1]?.version === "v1.0.0",
      "the earliest release changed after a later one was published",
    );
    assertTrue(
      !(await present(devtools, "watchdog-sync-error")),
      "a successful read did not clear the failure reason",
    );
    console.log("PASS watchdog-sync-recovered");

    /* ---------------------------------------------------------------- */
    /* 6. A new run directory and a new ledger entry appear without a reload */
    /* ---------------------------------------------------------------- */
    const newestCycle = "2026-10-24T14:00:00.000Z";
    const newestName = newestCycle.replace(/[:.]/g, "-");
    await mkdir(join(watchdogDir, "runs", newestName), { recursive: true });
    await writeFile(
      join(watchdogDir, "runs", newestName, "report.json"),
      JSON.stringify({
        cycle: newestCycle,
        window: { start: newestCycle, end: newestCycle, minutes: 10 },
        instances: [],
        findings: [{ fingerprint: "9" }],
        action: "filed",
        issues: [],
        pending: 0,
        reason: "filed 1 issue(s)",
        malformed: 0,
        unattributed: 0,
      }),
    );
    await writeFile(
      join(watchdogDir, "latest.json"),
      JSON.stringify({
        ...latest,
        cycle: newestCycle,
        window: { start: newestCycle, end: newestCycle, minutes: 10 },
        findings: [{ fingerprint: "9" }, { fingerprint: "10" }, { fingerprint: "11" }],
        reason: "filed 3 issue(s)",
      }),
    );
    entries.push({
      category: "server-error",
      line: "Synthetic error B",
      url: issueUrl(3),
      filedAt: "2026-10-24T13:00:00.000Z",
    });
    saveLedger(watchdogDir, ledgerFixture(entries, []));

    const fresh = await waitFor(
      async () => {
        const cycles = renderedCycles(await devtools.evaluate(readCycles).catch(() => undefined));
        const issues = renderedIssues(await devtools.evaluate(readIssues).catch(() => undefined));
        return cycles?.length === 4 && issues?.length === 4 ? { cycles, issues } : undefined;
      },
      "the new run directory and ledger entry",
      20_000,
    );
    assertTrue(
      fresh.cycles[0]?.datetime === newestCycle,
      "a newly written run directory did not become the newest cycle",
    );
    assertTrue(
      fresh.issues[0]?.url === issueUrl(3),
      "a newly filed ledger entry did not become the newest row",
    );
    assertTrue(
      (await text(devtools, "watchdog-last-findings")) === "3",
      "the newest cycle did not refresh without a reload",
    );
    console.log("PASS watchdog-freshness");

    /* ---------------------------------------------------------------- */
    /* 7. The footer indicator and popover are unchanged                 */
    /* ---------------------------------------------------------------- */
    saveLedger(
      watchdogDir,
      ledgerFixture(
        Array.from({ length: ISSUE_COUNT }, (_unused, index) => ({
          category: index % 2 === 0 ? "server-error" : "update-error",
          line: `fixture finding ${index}`,
          url: issueUrl(index),
          filedAt: new Date(Date.parse("2026-10-24T12:00:00.000Z") - index * 60_000).toISOString(),
        })),
        [],
      ),
    );
    await click(devtools, "status-watchdog");
    const links = await waitFor(
      async () => {
        const value = await devtools
          .evaluate(`(() => {
            const element = document.querySelector('[data-testid="watchdog-popover"]');
            if (element === null) return null;
            return {
              links: [...element.querySelectorAll('a')].map((anchor) => ({
                href: anchor.getAttribute('href'),
                target: anchor.getAttribute('target'),
                rel: anchor.getAttribute('rel'),
              })),
            };
          })()`)
          .catch(() => undefined);
        const links = renderedLinks(value);
        return links !== undefined && links.length === MAX_ISSUES ? links : undefined;
      },
      "the watchdog popover to refresh with the seeded issues",
      15_000,
    );
    console.log("PASS watchdog-popover");

    const indicatorText = await text(devtools, "status-watchdog");
    assertTrue(indicatorText.includes("filed"), `the indicator names the last action: ${indicatorText}`);
    assertTrue(
      /(just now|\d+m ago|\d+h ago|\d+d ago)/.test(indicatorText),
      `the indicator shows the age: ${indicatorText}`,
    );
    assertTrue(
      links.length === MAX_ISSUES,
      `the popover lists at most ten issues: found ${links.length}`,
    );
    for (const link of links) {
      assertTrue(link.target === "_blank", `an issue link opens a new tab: ${JSON.stringify(link)}`);
      assertTrue(
        link.rel?.includes("noopener") === true && link.rel?.includes("noreferrer") === true,
        `an issue link is rel="noopener noreferrer": ${JSON.stringify(link)}`,
      );
      assertTrue(
        link.href?.startsWith("https://github.com/dsdenes/devboard/issues/") === true,
        `an issue link is a filed URL: ${String(link.href)}`,
      );
    }
    assertTrue(
      links[0]?.href === issueUrl(0),
      `the newest issue comes first: ${String(links[0]?.href)}`,
    );
    console.log("PASS issue-links");

    await devtools.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await devtools.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await waitFor(
      async () =>
        (await devtools
          .evaluate(
            `document.querySelector('[data-testid="watchdog-popover"]') === null ? true : undefined`,
          )
          .catch(() => undefined)) === true
          ? true
          : undefined,
      "the popover to close on Escape",
      10_000,
    );
    console.log("PASS escape-closes");

    assertTrue(
      devtools.errors.length === 0,
      `the page logged no uncaught console error: ${devtools.errors.join("\n")}`,
    );
    console.log("PASS no-console-error");
  } finally {
    devtools.close();
  }

  console.log("verify:watchdog: page, history, issues, sync, refresh, indicator, and popover passed");
} finally {
  if (chromePid > 0) {
    try {
      process.kill(chromePid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (dashboardPid > 0) {
    try {
      process.kill(dashboardPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await rm(root, { recursive: true, force: true });
}
