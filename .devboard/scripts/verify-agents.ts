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
import { settingsPath, statePath } from "../issues/scout/paths";
import { emptyState, writeSettings, writeState } from "../issues/scout/state";
import { writeProjection } from "../watchdog/projection";
import { watchdogDirectory } from "../watchdog/paths";
import { coachDirectory } from "../coach/paths";
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

async function valueOf(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.value ?? null`,
  );
  return typeof value === "string" ? value : "";
}

async function countOf(devtools: Devtools, testid: string): Promise<number> {
  const value = await devtools.evaluate(
    `document.querySelectorAll('[data-testid="${testid}"]').length`,
  );
  return typeof value === "number" ? value : 0;
}

/** The prompt section is one node directly after the header, before alerts and main. */
async function promptLayout(
  devtools: Devtools,
): Promise<{ one: boolean; afterHeader: boolean; beforeAlerts: boolean; beforeMain: boolean }> {
  const value = await devtools.evaluate(`(() => {
    const prompt = document.querySelector('[data-testid="agent-prompt"]');
    const header = document.querySelector('[data-testid="agent-header"]');
    const alerts = document.querySelector('.agent-page__alerts');
    const main = document.querySelector('.agent-page__main');
    if (prompt === null || header === null) return null;
    const before = (other) =>
      other === null ? true : (prompt.compareDocumentPosition(other) & 4) === 4;
    return {
      one: document.querySelectorAll('[data-testid="agent-prompt"]').length === 1,
      afterHeader: header.nextElementSibling === prompt,
      beforeAlerts: before(alerts),
      beforeMain: before(main),
    };
  })()`);
  return (value ?? { one: false, afterHeader: false, beforeAlerts: false, beforeMain: false }) as {
    one: boolean;
    afterHeader: boolean;
    beforeAlerts: boolean;
    beforeMain: boolean;
  };
}

/** Sends one prompt command over a fresh socket and returns the named frame. */
async function promptCommand(
  devtools: Devtools,
  port: number,
  command: Record<string, unknown>,
  frame: string,
): Promise<Record<string, unknown>> {
  const value = await devtools.evaluate(`new Promise((resolve) => {
    const socket = new WebSocket('ws://127.0.0.1:${port}/ws');
    const guard = setTimeout(() => { socket.close(); resolve(null); }, 10000);
    socket.onopen = () => socket.send(${JSON.stringify(JSON.stringify(command))});
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type !== ${JSON.stringify(frame)}) return;
      clearTimeout(guard);
      socket.close();
      resolve(message);
    };
    socket.onerror = () => { clearTimeout(guard); resolve(null); };
  })`);
  return (value ?? {}) as Record<string, unknown>;
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
  "agent-sync-at",
  "agent-last-run",
  "agent-start",
  "agent-stop",
  "agent-cadence",
  "agent-next-run",
  "agent-limit-hour",
  "agent-limit-pending",
  "agent-save-settings",
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

const INSTALLED_PROMPT =
  "---\ndescription: installed fixture\n---\n\n# Installed Auto Scout prompt\n\nRead-only here.\n";
const SOURCE_PROMPT =
  "---\ndescription: source fixture\n---\n\n# Source Auto Scout prompt\n\nKeep every byte.\n";
const CHAT_PROPOSAL =
  "---\ndescription: revised\n---\n\n# Revised Auto Scout prompt\n\nSaved by the gate.\n";
const SOURCE_ACP = join(import.meta.dir, "..", "tests", "fixtures", "verify-source-acp.ts");
const SCOUT_STUB_GH = join(import.meta.dir, "..", "tests", "fixtures", "scout-stub-gh.ts");

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
let sourceDashboardPid = 0;
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
  await mkdir(join(host.directory, ".devboard", "prompts"), { recursive: true });
  await writeFile(
    join(host.directory, ".devboard", "prompts", "scout-recommendations.md"),
    INSTALLED_PROMPT,
  );
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

  /* A second host is a harness source checkout: its prompt is editable. */
  const sourceHost = await makeHost(root, "source");
  await mkdir(join(sourceHost.directory, ".devboard", "prompts"), { recursive: true });
  await writeFile(
    join(sourceHost.directory, ".devboard", "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" }, null, 2)}\n`,
  );
  await writeFile(
    join(sourceHost.directory, ".devboard", "prompts", "scout-recommendations.md"),
    SOURCE_PROMPT,
  );
  await mkdir(join(sourceHost.directory, ".devboard", "goal-proposals"), { recursive: true });
  await writeFile(
    join(sourceHost.directory, ".devboard", "goal-proposals", "draft.md"),
    "# A Draft Heading\n\nbody\n",
  );
  await mkdir(join(sourceHost.directory, ".omp", "commands"), { recursive: true });
  await writeFile(
    join(sourceHost.directory, ".omp", "commands", "scout-recommendations.md"),
    "# scout\n",
  );
  run("git", [
    "-C",
    sourceHost.directory,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/fixture.git",
  ]);
  const sourceStateDir = join(sourceHost.directory, ".devboard", ".tmp", "state");
  await mkdir(sourceStateDir, { recursive: true });
  seedVerificationProvider(sourceStateDir);
  const sourceState = emptyState({ repo: "acme/fixture", root: sourceHost.directory });
  sourceState.issues = [
    {
      number: 101,
      title: "Open  Scout Issue",
      url: ISSUE_URLS[0]!,
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      state: "pending",
      category: "clarity",
      version: null,
    },
    {
      number: 102,
      title: "Shipped Scout Issue",
      url: ISSUE_URLS[1]!,
      createdAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      state: "implemented",
      category: "tests",
      version: "v1.0.0",
    },
  ];
  sourceState.openTitles = ["Existing open issue"];
  writeState(statePath(sourceStateDir, sourceHost.directory), sourceState);
  writeSettings(settingsPath(sourceStateDir, sourceHost.directory), {
    maxPerHour: 10,
    maxPending: 5,
    intervalMinutes: 1,
  });
  const sourceBin = join(root, "source-bin");
  await mkdir(sourceBin, { recursive: true });
  const sourceGh = join(sourceBin, "gh");
  await writeFile(sourceGh, `#!/bin/sh\nexec bun ${SCOUT_STUB_GH} "$@"\n`);
  chmodSync(sourceGh, 0o755);
  const sourceOmp = join(sourceBin, "omp");
  await writeFile(sourceOmp, "#!/bin/sh\nexit 0\n");
  chmodSync(sourceOmp, 0o755);
  const ghStore = join(root, "source-gh-store.json");
  await writeFile(
    ghStore,
    JSON.stringify({
      nextNumber: 200,
      issues: [
        {
          number: 101,
          title: "Open  Scout Issue",
          url: ISSUE_URLS[0]!,
          state: "open",
          createdAt: sourceState.issues[0]!.createdAt,
          body: "",
          labels: ["scout"],
        },
        {
          number: 102,
          title: "Shipped Scout Issue",
          url: ISSUE_URLS[1]!,
          state: "closed",
          createdAt: sourceState.issues[1]!.createdAt,
          body: "",
          labels: ["scout"],
        },
      ],
      openTitles: ["Existing open issue"],
      releases: [{ tag: "v1.0.0", publishedAt: new Date().toISOString() }],
      closing: {},
      comments: {},
    }),
  );
  const sourcePort = await freePort();
  const sourceDashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      ...verificationProviderUsageEnv(),
      PATH: `${sourceBin}:${process.env.PATH ?? ""}`,
      HOST: "127.0.0.1",
      PORT: String(sourcePort),
      REPO_DIR: sourceHost.directory,
      ADRS_DIR: join(sourceHost.directory, "adrs"),
      GOAL_FILE: join(sourceHost.directory, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: sourceStateDir,
      AGENT_COMMAND: `bun ${SOURCE_ACP}`,
      SCOUT_STUB_STATE: ghStore,
      PROMPT_STUB_PROPOSAL: CHAT_PROPOSAL,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  sourceDashboardPid = sourceDashboard.pid ?? 0;
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${sourcePort}/`, {
          signal: AbortSignal.timeout(2000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the source dashboard",
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
        JSON.stringify([
          "open-issues-scout",
          "open-issues-watchdog",
          "open-issues-design",
          "open-issues-coach",
        ]),
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
    ["coach", "Coach"],
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

  await click(devtools, "open-issues-coach");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Coach page",
    10_000,
  );
  const coachPage = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
  );
  assertTrue(coachPage === "coach", `the Coach page names ${String(coachPage)}`);
  assertTrue(await present(devtools, "agent-issues-empty"), "Coach has no empty table");
  assertTrue(await present(devtools, "watchdog-cycles"), "Coach has no cycle history");
  assertTrue(await present(devtools, "watchdog-cycles-empty"), "Coach has no empty history");
  const coachCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(coachCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the Coach core ids differ: ${JSON.stringify(coachCore)}`,
  );
  assertTrue(
    (await text(devtools, "agent-lifecycle")).includes("stopped"),
    "Coach does not start stopped",
  );
  console.log("PASS coach-page");

  /* 2b. The prompt section: read-only here. */
  await click(devtools, "open-issues-scout");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt")) ? true : undefined),
    "the Auto Scout prompt section",
    10_000,
  );
  const installedLayout = await promptLayout(devtools);
  assertTrue(
    installedLayout.one &&
      installedLayout.afterHeader &&
      installedLayout.beforeAlerts &&
      installedLayout.beforeMain,
    `the installed prompt section is misplaced: ${JSON.stringify(installedLayout)}`,
  );
  for (const testid of [
    "agent-prompt-editor",
    "agent-prompt-chat",
    "agent-prompt-save",
  ]) {
    assertTrue(
      (await countOf(devtools, testid)) === 0,
      `${testid} is rendered in an installed host`,
    );
  }
  const refusedSave = await promptCommand(
    devtools,
    port,
    { type: "saveAgentPrompt", id: "scout", text: "changed\n" },
    "agentPromptError",
  );
  assertTrue(
    typeof refusedSave.message === "string" &&
      refusedSave.message.includes("harness source checkout"),
    `the installed save was not refused: ${JSON.stringify(refusedSave)}`,
  );
  assertTrue(
    readFileSync(join(host.directory, ".devboard", "prompts", "scout-recommendations.md"), "utf8") ===
      INSTALLED_PROMPT,
    "the installed prompt file changed",
  );

  await click(devtools, "open-issues-watchdog");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt-absent")) ? true : undefined),
    "the Watchdog prompt absence",
    10_000,
  );
  assertTrue(
    (await text(devtools, "agent-prompt-absent")).includes("runs no agent"),
    "the Watchdog absence does not name its promptless behavior",
  );
  for (const testid of [
    "agent-prompt-editor",
    "agent-prompt-chat",
    "agent-prompt-save",
  ]) {
    assertTrue(
      (await countOf(devtools, testid)) === 0,
      `${testid} is rendered on the Watchdog page`,
    );
  }
  console.log("PASS prompt-read-only");

  /* 3. Cadence and limits: one Save validates both, then persists them. */
  const settingsButton = await devtools.evaluate(
    `document.querySelectorAll('[data-testid="agent-save-settings"]').length`,
  );
  assertTrue(settingsButton === 1, `the page renders ${String(settingsButton)} save buttons`);
  await setInput(devtools, "agent-cadence", "0");
  await click(devtools, "agent-save-settings");
  const cadenceError = await waitFor(
    async () => {
      const value = await text(devtools!, "agent-settings-error");
      return value.includes("1 through 1440") ? value : undefined;
    },
    "the cadence error",
    10_000,
  );
  assertTrue(cadenceError.includes("1 through 1440"), "the cadence error is wrong");
  await setInput(devtools, "agent-cadence", "30");
  await setInput(devtools, "agent-limit-hour", "0");
  await click(devtools, "agent-save-settings");
  const limitsError = await waitFor(
    async () => {
      const value = await text(devtools!, "agent-settings-error");
      return value.includes("1 through 100") ? value : undefined;
    },
    "the limits error",
    10_000,
  );
  assertTrue(limitsError.includes("1 through 100"), "the limits error is wrong");

  await setInput(devtools, "agent-limit-hour", "");
  await setInput(devtools, "agent-limit-pending", "");
  await click(devtools, "agent-save-settings");
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
        [
          "startAgent",
          "stopAgent",
          "setAgentSettings",
          "disableAgentTimer",
          "saveAgentPrompt",
          "sendAgentPromptChat",
        ].includes(type),
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
  const coachDir = coachDirectory(stateDir);
  await mkdir(coachDir, { recursive: true });
  await writeFile(
    join(coachDir, "state.json"),
    JSON.stringify({
      version: 1,
      findings: {
        "fingerprint-coach": {
          category: "tool-failure",
          line: "bash failed: Synthetic Coach finding",
          subject: "bash\nSynthetic Coach finding",
          firstSeen: now,
          lastSeen: now,
          count: 2,
          disposition: "filed:https://github.com/acme/fixture/issues/103",
          url: "https://github.com/acme/fixture/issues/103",
          filedAt: now,
        },
      },
      pendingFiling: [],
    }),
  );
  await writeFile(
    join(coachDir, "latest.json"),
    JSON.stringify({
      cycle: now,
      window: { start: now, end: now, minutes: 1440 },
      findings: [{}],
      action: "filed",
      issues: [{ url: "https://github.com/acme/fixture/issues/103" }],
      pending: 0,
    }),
  );
  await click(devtools, "open-issues-coach");
  await waitFor(
    async () => ((await rows(devtools!)).length === 1 ? true : undefined),
    "the seeded Coach row without a reload",
    60_000,
  );
  const coachRows = await rows(devtools);
  assertTrue(
    coachRows[0]?.title === "[coach] tool-failure: bash failed: Synthetic Coach finding",
    `the Coach title is wrong: ${JSON.stringify(coachRows)}`,
  );
  await waitFor(
    async () => ((await present(devtools!, "watchdog-cycle")) ? true : undefined),
    "the Coach cycle detail",
    10_000,
  );
  await setInput(devtools, "agent-cadence", "90");
  await setInput(devtools, "agent-limit-hour", "2");
  await click(devtools, "agent-save-settings");
  await waitFor(
    () => {
      try {
        const settings = JSON.parse(
          readFileSync(join(coachDir, "settings.json"), "utf8"),
        ) as Record<string, unknown>;
        return settings.intervalMinutes === 90 && settings.maxPerHour === 2 ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the persisted Coach settings",
    10_000,
  );
  await devtools.send("Page.reload");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.readyState === 'complete' && document.querySelector('[data-testid="agent-cadence"]')?.value === '90'`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the reloaded Coach settings",
    30_000,
  );
  console.log("PASS coach-detail");
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
  await click(devtools, "agent-save-settings");
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

  /* 10. The source checkout's editable prompt: chat and save. */
  await devtools.send("Page.navigate", { url: `http://127.0.0.1:${sourcePort}/` });
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.readyState === 'complete' && document.querySelector('[data-testid="mode-issues"]') !== null`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the source dashboard",
    30_000,
  );
  await click(devtools, "mode-issues");
  await click(devtools, "open-issues-scout");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt-editor")) ? true : undefined),
    "the source prompt editor",
    15_000,
  );
  const sourceLayout = await promptLayout(devtools);
  assertTrue(
    sourceLayout.one &&
      sourceLayout.afterHeader &&
      sourceLayout.beforeAlerts &&
      sourceLayout.beforeMain,
    `the source prompt section is misplaced: ${JSON.stringify(sourceLayout)}`,
  );
  assertTrue(
    readFileSync(
      join(sourceHost.directory, ".devboard", "prompts", "scout-recommendations.md"),
      "utf8",
    ) === SOURCE_PROMPT,
    "opening the page wrote the prompt file",
  );
  assertTrue(
    (await valueOf(devtools, "agent-prompt-editor")) === SOURCE_PROMPT,
    "the editor does not start at the file's bytes",
  );
  for (const testid of [
    "agent-prompt-chat",
    "agent-prompt-chat-log",
    "agent-prompt-message",
    "agent-prompt-send",
    "agent-prompt-save",
  ]) {
    assertTrue((await countOf(devtools, testid)) === 1, `${testid} is missing on the source page`);
  }
  assertTrue(
    (await countOf(devtools, "agent-prompt-reset")) === 0,
    "the removed Reset control is still rendered on the source page",
  );

  const sourcePromptFile = join(
    sourceHost.directory,
    ".devboard",
    "prompts",
    "scout-recommendations.md",
  );

  await setInput(devtools, "agent-prompt-message", "Tighten the evidence rule.");
  await click(devtools, "agent-prompt-send");
  await waitFor(
    async () =>
      (await text(devtools, "agent-prompt-chat-log")).includes("Here is the revision.")
        ? true
        : undefined,
    "the prompt chat reply",
    30_000,
  );
  await waitFor(
    async () => ((await valueOf(devtools, "agent-prompt-editor")) === CHAT_PROPOSAL ? true : undefined),
    "the proposed prompt in the editor",
    15_000,
  );
  assertTrue(
    readFileSync(sourcePromptFile, "utf8") === SOURCE_PROMPT,
    "the chat wrote the prompt file before Save",
  );
  const assistantEntries = await devtools.evaluate(
    `document.querySelectorAll('[data-testid="agent-prompt-chat-log"] [data-role="assistant"]').length`,
  );
  assertTrue(
    assistantEntries === 1,
    `the chat log shows ${String(assistantEntries)} assistant entries for one turn`,
  );
  console.log("PASS prompt-chat");

  await click(devtools, "agent-prompt-save");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt-notice")) ? true : undefined),
    "the prompt save notice",
    15_000,
  );
  assertTrue(
    readFileSync(sourcePromptFile, "utf8") === CHAT_PROPOSAL,
    "Save did not write the editor's bytes",
  );
  await devtools.send("Page.reload");
  await waitFor(
    async () =>
      (await valueOf(devtools!, "agent-prompt-editor").catch(() => "")) === CHAT_PROPOSAL
        ? true
        : undefined,
    "the saved prompt after a reload",
    30_000,
  );
  console.log("PASS prompt-save");

  console.log(
    "verify:agents: the Background agents section, all four shared pages, lifecycle, cadence, " +
      "nullable limits, the Watchdog cap, the shared table, Coach detail and settings, " +
      "freshness, no mutation on reload, the timer gate, and the footer indicator all hold",
  );
} finally {
  for (const pid of [chromePid, dashboardPid, sourceDashboardPid]) {
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
