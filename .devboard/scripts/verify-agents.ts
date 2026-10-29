#!/usr/bin/env bun
/**
 * The shared background-agent gate. It builds the client, seeds both agents,
 * starts a source dashboard, and drives headless Chrome over the DevTools
 * protocol: the Background agents sidebar section, the identical page shape,
 * Start/Stop lifecycle, cadence and limits persistence, the shared filed-issue
 * table, the detail panels, freshness without a reload, the legacy timer gate
 * against a stub systemctl, and the footer indicator.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { saveLedger, type Ledger } from "../watchdog/ledger";
import { statePath } from "../issues/scout/paths";
import { emptyState, writeState } from "../issues/scout/state";
import { writeProjection } from "../watchdog/projection";
import { watchdogDirectory } from "../watchdog/paths";
import { assertTrue, freePort, harnessRoot, makeHost, makeRoot, run, waitFor } from "./verification";
import { seedVerificationProvider, verificationProviderUsageEnv } from "./provider-fixture";

const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("verify:agents: Chrome is unavailable");
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

async function present(devtools: Devtools, testid: string): Promise<boolean> {
  return (
    (await devtools.evaluate(
      `document.querySelector('[data-testid="${testid}"]') !== null`,
    )) === true
  );
}

async function text(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    return element === null ? "" : (element.textContent ?? "").replace(/\\s+/g, " ").trim();
  })()`);
  return typeof value === "string" ? value : "";
}

async function stateOf(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.dataset.state ?? ''`,
  );
  return typeof value === "string" ? value : "";
}

async function click(devtools: Devtools, testid: string): Promise<void> {
  await waitFor(
    async () =>
      (await devtools.evaluate(
        `document.querySelector('[data-testid="${testid}"]') !== null`,
      )) === true
        ? true
        : undefined,
    `${testid} to render`,
    15_000,
  );
  const clicked = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    if (element === null || element.disabled) return false;
    element.click();
    return true;
  })()`);
  assertTrue(clicked === true, `${testid} is not clickable`);
}

async function setInput(devtools: Devtools, testid: string, value: string): Promise<void> {
  await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    if (element === null) return false;
    element.value = ${JSON.stringify(value)};
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

const CORE_IDS = [
  "agent-header",
  "agent-lifecycle",
  "agent-sync",
  "agent-sync-at",
  "agent-last-run",
  "agent-start",
  "agent-stop",
  "agent-cadence",
  "agent-next-run",
  "agent-save-cadence",
  "agent-limit-hour",
  "agent-limit-pending",
  "agent-save-limits",
  "agent-issues-count",
  "agent-issues",
  "agent-detail",
];

async function coreSequence(devtools: Devtools): Promise<string[]> {
  const value = await devtools.evaluate(`(() => {
    const all = [...document.querySelectorAll('[data-testid]')]
      .map((element) => element.getAttribute('data-testid') ?? '');
    const core = ${JSON.stringify(CORE_IDS)};
    return all.filter((id) => core.includes(id));
  })()`);
  return Array.isArray(value) ? (value as string[]) : [];
}

async function columns(devtools: Devtools): Promise<string[]> {
  const value = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="agent-issues"] th')
  ].map((cell) => (cell.textContent ?? '').trim()))()`);
  return Array.isArray(value) ? (value as string[]) : [];
}

async function rows(devtools: Devtools): Promise<
  Array<{ url: string; state: string; version: string; title: string }>
> {
  const value = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="agent-issue"]')
  ].map((row) => ({
    url: row.dataset.url ?? '',
    state: row.dataset.state ?? '',
    version: row.dataset.version ?? '',
    title: row.querySelector('[data-testid="agent-issue-title"]')?.textContent?.trim() ?? '',
  })))()`);
  return Array.isArray(value)
    ? (value as Array<{ url: string; state: string; version: string; title: string }>)
    : [];
}

const ISSUE_URLS = [
  "https://github.com/acme/fixture/issues/101",
  "https://github.com/acme/fixture/issues/102",
];

function ledger(entries: Array<{ category: string; line: string; url: string; filedAt: string }>): Ledger {
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
          disposition: `filed:${entry.url}`,
          url: entry.url,
          filedAt: entry.filedAt,
          instances: [],
        },
      ]),
    ),
    pendingFiling: [],
  };
}

const GH_STUB = `#!/bin/sh
set -u
args="$*"
case "$args" in
  *"repos/acme/fixture --jq .permissions.push"*) echo true ;;
  *"repos/acme/fixture/issues"*"--json"*) echo "HTTP 500: fixture read failure" >&2; exit 1 ;;
  *"repos/acme/fixture/releases"*) echo "HTTP 500: fixture read failure" >&2; exit 1 ;;
  *"repos/acme/fixture/issues"*) echo "HTTP 500: fixture read failure" >&2; exit 1 ;;
  *) echo "unexpected gh arguments: $args" >&2; exit 1 ;;
esac
`;

const SYSTEMCTL_STUB = `#!/bin/sh
marker="$(dirname "$0")/timer-active"
case "$2" in
  is-active)
    if [ -f "$marker" ]; then echo active; else echo inactive; fi ;;
  is-enabled)
    if [ -f "$marker" ]; then echo enabled; else echo disabled; fi ;;
  disable)
    rm -f "$marker"; exit 0 ;;
esac
exit 0
`;

const root = await makeRoot("verify-agents");
let dashboardPid = 0;
let chromePid = 0;
let devtools: Devtools | undefined;

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:agents: bun run build failed: ${build.stderr}`);
  assertTrue(
    Bun.file(join(harnessRoot, "dist", "index.html")).size > 0,
    "verify:agents: the build produced dist/index.html",
  );

  const host = await makeHost(root, "host");
  await mkdir(join(host.directory, ".devboard"), { recursive: true });
  await mkdir(join(host.directory, ".omp", "commands"), { recursive: true });
  await writeFile(
    join(host.directory, ".omp", "commands", "scout-recommendations.md"),
    "# scout\n",
  );
  run("git", [
    "-C",
    host.directory,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/fixture.git",
  ]);

  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, GH_STUB);
  chmodSync(ghPath, 0o755);
  const systemctlPath = join(binDir, "systemctl");
  await writeFile(systemctlPath, SYSTEMCTL_STUB);
  chmodSync(systemctlPath, 0o755);
  const ompPath = join(binDir, "omp");
  await writeFile(ompPath, "#!/bin/sh\nexit 0\n");
  chmodSync(ompPath, 0o755);

  const stateDir = join(host.directory, ".devboard", ".tmp", "state");
  await mkdir(stateDir, { recursive: true });
  const watchdogDir = watchdogDirectory(host.directory);
  await mkdir(watchdogDir, { recursive: true });

  seedVerificationProvider(stateDir);
  const port = await freePort();
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      ...verificationProviderUsageEnv(),
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

  devtools = new Devtools(await pageTarget(debugPort, port));
  await devtools.connect();
  await devtools.send("Runtime.enable");
  await devtools.send("Page.enable");

  /* 1. The sidebar section and both entries. */
  await waitFor(
    async () => ((await present(devtools!, "mode-issues")) ? true : undefined),
    "the Issues mode control",
    30_000,
  );
  await click(devtools, "mode-issues");
  await waitFor(
    async () => ((await present(devtools!, "sidebar-background-agents")) ? true : undefined),
    "the Background agents section",
    15_000,
  );
  const groups = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="sidebar-background-agents"]')
  ].map((section) => ({
    heading: section.querySelector('.sidebar-group__title')?.textContent?.trim() ?? '',
    ids: [...section.querySelectorAll('[data-testid^="open-issues-"]')]
      .map((button) => button.getAttribute('data-testid') ?? ''),
  })))()`);
  assertTrue(
    Array.isArray(groups) &&
      (groups as Array<{ heading: string; ids: string[] }>)[0]?.heading === "Background agents" &&
      JSON.stringify((groups as Array<{ ids: string[] }>)[0]?.ids) ===
        JSON.stringify(["open-issues-scout", "open-issues-watchdog", "open-issues-design"]),
    `the Background agents section is wrong: ${JSON.stringify(groups)}`,
  );
  const sidebarOrder = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="sidebar"] .sidebar-group')
  ].map((section) => section.getAttribute('aria-label') ?? ''))()`);
  assertTrue(
    JSON.stringify(sidebarOrder) ===
      JSON.stringify(["Issues surfaces", "Background agents", "Issues work"]),
    `the Issues sidebar groups are out of order: ${JSON.stringify(sidebarOrder)}`,
  );
  for (const [id, label] of [
    ["scout", "Auto Scout"],
    ["watchdog", "Watchdog"],
    ["design", "Design System"],
  ]) {
    const entry = await devtools.evaluate(`(() => {
      const button = document.querySelector('[data-testid="open-issues-${id}"]');
      if (button === null) return null;
      return {
        label: button.querySelector('.sidebar-item__label')?.textContent?.trim() ?? '',
        state: button.querySelector('[data-testid="agent-state-${id}"]')?.dataset.state ?? '',
        count: button.querySelector('[data-testid="agent-count-${id}"]')?.textContent?.trim() ?? '',
      };
    })()`);
    const record = entry as Record<string, unknown> | null;
    assertTrue(record?.label === label, `${id} entry label is ${String(record?.label)}`);
    assertTrue(record?.state === "stopped", `${id} starts ${String(record?.state)}`);
    assertTrue(record?.count === "0", `${id} pending count starts at ${String(record?.count)}`);
  }
  console.log("PASS sidebar-background-agents");

  /* 2. Both pages share one empty shape and their detail panels. */
  await click(devtools, "open-issues-scout");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Auto Scout page",
    10_000,
  );
  const scoutPage = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
  );
  assertTrue(scoutPage === "scout", `the Auto Scout page names ${String(scoutPage)}`);
  assertTrue(await present(devtools, "agent-issues-empty"), "Auto Scout has no empty table");
  assertTrue(await present(devtools, "scout-activity"), "Auto Scout has no activity panel");
  const scoutCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(scoutCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the Auto Scout core ids differ: ${JSON.stringify(scoutCore)}`,
  );

  await click(devtools, "open-issues-design");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Design System page",
    10_000,
  );
  const designPage = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
  );
  assertTrue(designPage === "design", `the Design System page names ${String(designPage)}`);
  assertTrue(await present(devtools, "agent-issues-empty"), "Design System has no empty table");
  assertTrue(await present(devtools, "design-activity"), "Design System has no activity panel");
  const designCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(designCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the Design System core ids differ: ${JSON.stringify(designCore)}`,
  );

  await click(devtools, "open-issues-watchdog");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Watchdog page",
    10_000,
  );
  const watchdogPage = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
  );
  assertTrue(watchdogPage === "watchdog", `the Watchdog page names ${String(watchdogPage)}`);
  assertTrue(await present(devtools, "agent-issues-empty"), "Watchdog has no empty table");
  assertTrue(await present(devtools, "watchdog-cycles"), "Watchdog has no cycle history");
  assertTrue(await present(devtools, "watchdog-cycles-empty"), "Watchdog has no empty history");
  const watchdogCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(watchdogCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the Watchdog core ids differ: ${JSON.stringify(watchdogCore)}`,
  );
  assertTrue(
    (await text(devtools, "agent-lifecycle")).includes("stopped"),
    "Watchdog does not start stopped",
  );
  console.log("PASS shared-page-shape");

  /* 3. Cadence and limits: invalid sends nothing, valid persists. */
  await setInput(devtools, "agent-cadence", "0");
  await click(devtools, "agent-save-cadence");
  const cadenceError = await waitFor(
    async () => {
      const value = await text(devtools!, "agent-cadence-error");
      return value.length > 0 ? value : undefined;
    },
    "the cadence error",
    10_000,
  );
  assertTrue(cadenceError.includes("1 through 1440"), "the cadence error is wrong");
  await setInput(devtools, "agent-limit-hour", "0");
  await click(devtools, "agent-save-limits");
  const limitsError = await waitFor(
    async () => {
      const value = await text(devtools!, "agent-limits-error");
      return value.length > 0 ? value : undefined;
    },
    "the limits error",
    10_000,
  );
  assertTrue(limitsError.includes("1 through 100"), "the limits error is wrong");

  await setInput(devtools, "agent-cadence", "30");
  await click(devtools, "agent-save-cadence");
  await setInput(devtools, "agent-limit-hour", "");
  await setInput(devtools, "agent-limit-pending", "");
  await click(devtools, "agent-save-limits");
  await waitFor(
    () => {
      try {
        const settings = JSON.parse(
          readFileSync(join(watchdogDir, "settings.json"), "utf8"),
        ) as Record<string, unknown>;
        return settings.intervalMinutes === 30 &&
          settings.maxPerHour === null &&
          settings.maxPending === null
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    },
    "the persisted Watchdog settings",
    10_000,
  );
  await devtools.send("Page.reload");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.readyState === 'complete' && document.querySelector('[data-testid="agent-cadence"]') !== null`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the reloaded Watchdog page",
    30_000,
  );
  const persisted = await devtools.evaluate(`(() => ({
    cadence: document.querySelector('[data-testid="agent-cadence"]')?.value ?? '',
    hour: document.querySelector('[data-testid="agent-limit-hour"]')?.value ?? '',
    pending: document.querySelector('[data-testid="agent-limit-pending"]')?.value ?? '',
    next: document.querySelector('[data-testid="agent-next-run"]')?.textContent?.trim() ?? '',
  }))()`);
  const values = persisted as Record<string, string>;
  assertTrue(values.cadence === "30", `the cadence did not survive: ${values.cadence}`);
  assertTrue(values.hour === "" && values.pending === "", "empty limits did not render empty");
  console.log("PASS cadence-limits");

  /* 4. No mutating command is sent on a reload. */
  await devtools.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__agentCommands = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const message = JSON.parse(String(data));
          if (message && typeof message.type === 'string') window.__agentCommands.push(message.type);
        } catch {}
        return send.call(this, data);
      };`,
  });
  await devtools.send("Page.reload");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.readyState === 'complete' && document.querySelector('[data-testid="agent-page"]') !== null`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the instrumented reload",
    30_000,
  );
  const sent = await devtools.evaluate(`window.__agentCommands ?? []`);
  assertTrue(
    Array.isArray(sent) &&
      !(sent as string[]).some((type) =>
        ["startAgent", "stopAgent", "setAgentLimits", "setAgentCadence", "disableAgentTimer"].includes(
          type,
        ),
      ),
    `a mutating command ran on reload: ${JSON.stringify(sent)}`,
  );
  console.log("PASS no-mutation-on-reload");

  /* 5. Start -> starting -> running, then Stop -> stopping -> stopped. */
  await devtools.evaluate(`(() => {
    window.__lifecycles = [];
    clearInterval(window.__lifecycleTimer);
    window.__lifecycleTimer = setInterval(() => {
      const element = document.querySelector('[data-testid="agent-lifecycle"]');
      const state = element?.dataset.state ?? '';
      const seen = window.__lifecycles[window.__lifecycles.length - 1];
      if (state.length > 0 && state !== seen) window.__lifecycles.push(state);
    }, 5);
    return true;
  })()`);
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the running lifecycle",
    10_000,
  );
  const startStates = await devtools.evaluate(`window.__lifecycles ?? []`);
  assertTrue(
    Array.isArray(startStates) && (startStates as string[]).includes("starting"),
    `Start never published starting: ${JSON.stringify(startStates)}`,
  );
  assertTrue(await present(devtools, "agent-stop"), "Stop is not rendered while running");
  assertTrue(!(await present(devtools, "agent-start")), "Start is still rendered while running");
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped lifecycle",
    10_000,
  );
  const stopStates = await devtools.evaluate(`window.__lifecycles ?? []`);
  assertTrue(
    Array.isArray(stopStates) && (stopStates as string[]).includes("stopping"),
    `Stop never published stopping: ${JSON.stringify(stopStates)}`,
  );
  console.log("PASS lifecycle");

  await click(devtools, "open-issues-scout");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Auto Scout page",
    10_000,
  );
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the running Auto Scout",
    10_000,
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped Auto Scout",
    10_000,
  );
  console.log("PASS scout-lifecycle");

  /* 6. Seed both agents while the page is open: freshness and tables. */
  const now = new Date().toISOString();
  saveLedger(
    watchdogDir,
    ledger([
      { category: "server-error", line: "Synthetic error A", url: ISSUE_URLS[0]!, filedAt: now },
      {
        category: "stall",
        line: "lane-1 implementing",
        url: ISSUE_URLS[1]!,
        filedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ]),
  );
  await writeFile(
    join(watchdogDir, "latest.json"),
    JSON.stringify({
      cycle: now,
      window: { start: now, end: now, minutes: 10 },
      instances: [],
      findings: [],
      action: "filed",
      issues: [],
      pending: 0,
      malformed: 0,
      unattributed: 0,
    }),
  );
  writeProjection(watchdogDir, {
    version: 1,
    state: "ok",
    at: now,
    error: null,
    issues: [{ url: ISSUE_URLS[0]!, state: "pending", version: null }],
  });
  await click(devtools, "open-issues-watchdog");
  await waitFor(
    async () => ((await rows(devtools!)).length === 2 ? true : undefined),
    "the seeded Watchdog rows without a reload",
    60_000,
  );
  const watchdogRows = await rows(devtools);
  assertTrue(
    watchdogRows[0]?.url === ISSUE_URLS[0] && watchdogRows[0]?.state === "unknown",
    `the Watchdog rows are wrong: ${JSON.stringify(watchdogRows)}`,
  );
  assertTrue(
    watchdogRows[0]?.title === "[watchdog] server-error: Synthetic error A",
    `the Watchdog title is wrong: ${String(watchdogRows[0]?.title)}`,
  );
  assertTrue(
    (await text(devtools, "agent-issues-count")).startsWith("2 filed"),
    "the filed count did not refresh",
  );
  const scoutState = emptyState({ repo: "acme/fixture", root: host.directory });
  scoutState.issues = [
    {
      number: 101,
      title: "Auto Scout fixture one",
      url: ISSUE_URLS[0]!,
      createdAt: now,
      state: "pending",
      category: "clarity",
      version: null,
    },
    {
      number: 102,
      title: "Auto Scout fixture two",
      url: ISSUE_URLS[1]!,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      state: "implemented",
      category: "tests",
      version: "v1.0.0",
    },
  ];
  writeState(statePath(stateDir, host.directory), scoutState);
  await click(devtools, "open-issues-scout");
  await waitFor(
    async () => ((await rows(devtools!)).length === 2 ? true : undefined),
    "the seeded Auto Scout rows without a reload",
    60_000,
  );
  const scoutRows = await rows(devtools);
  assertTrue(
    scoutRows[0]?.url === ISSUE_URLS[0] &&
      scoutRows[0]?.state === "pending" &&
      scoutRows[0]?.version === "",
    `the Auto Scout rows are wrong: ${JSON.stringify(scoutRows)}`,
  );
  assertTrue(
    scoutRows[1]?.version === "v1.0.0",
    `the Auto Scout shipped version is wrong: ${JSON.stringify(scoutRows)}`,
  );
  assertTrue(
    (await text(devtools, "agent-issues-count")).startsWith("2 filed"),
    "the Auto Scout count did not refresh",
  );
  assertTrue(
    JSON.stringify(await columns(devtools)) ===
      JSON.stringify(["Title", "Category", "Filed", "State", "Shipped"]),
    "the Auto Scout table columns differ",
  );
  console.log("PASS freshness-and-table");

  /* 7. Watchdog cap keeps a fingerprint pending. */
  await click(devtools, "open-issues-watchdog");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Watchdog page",
    10_000,
  );
  saveLedger(watchdogDir, {
    version: 2,
    findings: {
      "fingerprint-pending": {
        category: "server-error",
        line: "Synthetic error pending",
        firstSeen: now,
        lastSeen: now,
        count: 1,
        disposition: "none",
        instances: [],
      },
    },
    pendingFiling: ["fingerprint-pending"],
  });
  writeProjection(watchdogDir, {
    version: 1,
    state: "error",
    at: null,
    error: "gh: authentication failed",
    issues: [],
  });
  await setInput(devtools, "agent-limit-hour", "1");
  await click(devtools, "agent-save-limits");
  await waitFor(
    () => {
      try {
        const settings = JSON.parse(
          readFileSync(join(watchdogDir, "settings.json"), "utf8"),
        ) as Record<string, unknown>;
        return settings.maxPerHour === 1 ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the Watchdog cap",
    10_000,
  );
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the capped Watchdog",
    10_000,
  );
  await waitFor(
    () => {
      try {
        const ledgerFile = JSON.parse(
          readFileSync(join(watchdogDir, "state.json"), "utf8"),
        ) as { pendingFiling?: string[] };
        return ledgerFile.pendingFiling?.includes("fingerprint-pending") ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the pending fingerprint",
    30_000,
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped capped Watchdog",
    10_000,
  );
  console.log("PASS watchdog-cap");

  /* 8. The legacy timer gate and its one-click disable. */
  await writeFile(join(binDir, "timer-active"), "");
  await waitFor(
    async () => ((await present(devtools!, "agent-blocked")) ? true : undefined),
    "the timer block",
    15_000,
  );
  assertTrue(
    (await text(devtools, "agent-blocked")).includes("devboard-watchdog.timer"),
    "the block does not name the timer",
  );
  const startDisabled = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-start"]')?.disabled ?? null`,
  );
  assertTrue(startDisabled === true, "Start is not disabled while the timer is active");
  await click(devtools, "agent-disable-timer");
  await waitFor(
    async () => ((await present(devtools!, "agent-blocked")) ? undefined : true),
    "the cleared timer block",
    15_000,
  );
  assertTrue(!existsSync(join(binDir, "timer-active")), "the disable did not run");
  console.log("PASS timer-gate");

  /* 9. The footer indicator and popover. */
  await click(devtools, "status-watchdog");
  await waitFor(
    async () => ((await present(devtools!, "watchdog-popover")) ? true : undefined),
    "the watchdog popover",
    10_000,
  );
  await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
  await devtools.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape" });
  await waitFor(
    async () => ((await present(devtools!, "watchdog-popover")) ? undefined : true),
    "Escape to close the popover",
    10_000,
  );
  assertTrue(
    devtools.errors.length === 0,
    `the page reported console errors: ${JSON.stringify(devtools.errors)}`,
  );
  console.log("PASS footer-indicator");

  console.log(
    "verify:agents: the Background agents section, all three shared pages, lifecycle, cadence, " +
      "nullable limits, the Watchdog cap, the shared table, freshness, no mutation on reload, " +
      "the timer gate, and the footer indicator all hold",
  );
} finally {
  for (const pid of [chromePid, dashboardPid]) {
    if (pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  devtools?.close();
  if (process.env.AGENTS_VERIFY_KEEP !== "1") {
    await rm(root, { recursive: true, force: true });
  } else {
    console.error(`verify:agents: kept ${root}`);
  }
}
