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
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { saveLedger, type Ledger } from "../watchdog/ledger";
import {
  controlDirectory,
  lockPath,
  settingsPath,
  statePath,
  versionedControlDirectory,
  versionedStatePath,
  workerStateDirectories,
} from "../issues/scout/paths";
import { writeCommand } from "../issues/scout/control";
import { acquireLock, versionLockPath } from "../issues/lock";
import { emptyState, readState, writeSettings, writeState } from "../issues/scout/state";
import { readHarnessVersion } from "../server/version";
import { writeProjection } from "../watchdog/projection";
import { watchdogDirectory } from "../watchdog/paths";
import { mcpOptimizerDirectory } from "../mcp-optimizer/paths";
import { MCP_TOOLS } from "../mcp/catalog";
import {
  assertTrue,
  VERIFY_DASHBOARD_AUTHORIZATION,
  dashboardPageUrl,
  dashboardSocket,
  freePort,
  harnessRoot,
  makeHost,
  makeRoot,
  run,
  waitFor,
} from "./verification";
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

/** The scope of the one visible save confirmation, or the empty string. */
async function saveNoticeScope(devtools: Devtools): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="save-feedback"]')?.dataset.scope ?? ''`,
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

/** An element's exact text, preserving whitespace, or the empty string. */
async function rawText(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.textContent ?? null`,
  );
  return typeof value === "string" ? value : "";
}

/** The prompt region is a scrollable monospaced block with no editor chrome. */
async function assertPromptTextRegion(
  devtools: Devtools,
  testid: string,
  expected: string,
  page: string,
): Promise<void> {
  await waitFor(
    async () =>
      (await devtools
        .evaluate(`document.querySelector('[data-testid="${testid}"]') !== null`)
        .catch(() => false)) === true
        ? true
        : undefined,
    `${page} prompt text`,
    15_000,
  );
  const actual = await rawText(devtools, testid);
  assertTrue(actual === expected, `${page} prompt bytes differ: ${JSON.stringify(actual)}`);
  const style = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    if (element === null) return null;
    const computed = getComputedStyle(element);
    return {
      whiteSpace: computed.whiteSpace,
      overflow: computed.overflowY,
      font: computed.fontFamily,
      tag: element.tagName,
    };
  })()`);
  assertTrue(
    style !== null &&
      (style as Record<string, unknown>).whiteSpace === "pre" &&
      ["auto", "scroll"].includes(String((style as Record<string, unknown>).overflow)) &&
      String((style as Record<string, unknown>).font).toLowerCase().includes("mono") &&
      (style as Record<string, unknown>).tag === "PRE",
    `${page} prompt region is not a scrollable monospace PRE: ${JSON.stringify(style)}`,
  );
}

/**
 * One digest of every file under a fixture tree, excluding `.git`: a prompt
 * sequence that writes anything changes it, and an identical sequence does not.
 * A connected dashboard's provider refresh rewrites `selection.json` with a
 * fresh `checkedAt` on any connection, so that one timestamp is normalized
 * away; every other byte of the selection, and every other file, is compared.
 * The dashboard also rewrites its own `runs/<id>/lease.json` heartbeat every
 * second for as long as it serves, which no prompt action causes.
 */
async function treeEntries(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      if (relative === "" && entry.name === ".git") continue;
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        if (path.includes("/runs/") && path.endsWith("/lease.json")) continue;
        const bytes = await readFile(join(root, path), "utf8");
        let content = bytes;
        if (path.endsWith("/providers/selection.json")) {
          try {
            const selection = JSON.parse(bytes) as Record<string, unknown>;
            delete selection["checkedAt"];
            content = JSON.stringify(selection);
          } catch {
            content = bytes;
          }
        }
        entries.set(path, createHash("sha256").update(content).digest("hex"));
      }
    }
  };
  await walk("");
  return entries;
}

function treeDigest(entries: Map<string, string>): string {
  const lines = [...entries.entries()].map(([path, digest]) => `${path}:${digest}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

async function treeHash(root: string): Promise<string> {
  return treeDigest(await treeEntries(root));
}

/** The paths whose digest or presence differ between two tree reads. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

/** The tree digest once two reads a moment apart agree, so reads may settle. */
async function settledTreeHash(root: string): Promise<string> {
  let previous = await treeHash(root);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(500);
    const next = await treeHash(root);
    if (next === previous) return next;
    previous = next;
  }
  return previous;
}

/** The prompt disclosure's state: one closed-by-default element per page. */
async function promptDisclosure(devtools: Devtools): Promise<{
  present: boolean;
  open: boolean;
  summary: string;
  contentHidden: boolean;
  badgeCount: number;
  badgeText: string;
  badgeTitle: string | null;
}> {
  const value = await devtools.evaluate(`(() => {
    const all = document.querySelectorAll('[data-testid="agent-prompt"]');
    const details = all[0] ?? null;
    const summary = document.querySelector('[data-testid="agent-prompt-summary"]');
    const body = document.querySelector('[data-testid="agent-prompt-body"]');
    const badges = summary === null
      ? []
      : [...summary.querySelectorAll('[data-testid="source-only-badge"]')];
    return {
      present: all.length === 1 && details !== null,
      open: details !== null && details.open === true,
      summary:
        summary?.querySelector('.agent-prompt__title')?.textContent?.trim() ?? '',
      contentHidden:
        body === null
          ? true
          : typeof body.checkVisibility === "function"
            ? !body.checkVisibility()
            : body.getBoundingClientRect().height === 0,
      badgeCount: badges.length,
      badgeText: (badges[0]?.textContent ?? '').trim(),
      badgeTitle: badges[0]?.getAttribute('title') ?? null,
    };
  })()`);
  return (value ?? {
    present: false,
    open: false,
    summary: "",
    contentHidden: false,
    badgeCount: 0,
    badgeText: "",
    badgeTitle: null,
  }) as {
    present: boolean;
    open: boolean;
    summary: string;
    contentHidden: boolean;
    badgeCount: number;
    badgeText: string;
    badgeTitle: string | null;
  };
}

/** The summary is the only marker site: none or exactly the one shared word. */
async function assertPromptMarker(
  devtools: Devtools,
  page: string,
  expected: boolean,
): Promise<void> {
  const disclosure = await promptDisclosure(devtools);
  assertTrue(disclosure.present, `${page} renders no single agent-prompt disclosure`);
  assertTrue(
    disclosure.badgeCount === (expected ? 1 : 0),
    `${page} carries ${disclosure.badgeCount} source-only markers`,
  );
  if (!expected) return;
  assertTrue(disclosure.badgeText === "devboard", `${page} marker is ${disclosure.badgeText}`);
  assertTrue(
    disclosure.badgeTitle === "Only available when Devboard serves a harness source checkout",
    `${page} marker tooltip is ${String(disclosure.badgeTitle)}`,
  );
}

async function assertPromptClosed(devtools: Devtools, page: string): Promise<void> {
  const disclosure = await promptDisclosure(devtools);
  assertTrue(disclosure.present, `${page} renders no single agent-prompt disclosure`);
  assertTrue(!disclosure.open, `${page} opens its prompt on load`);
  assertTrue(disclosure.summary === "Prompt", `${page} prompt summary is ${disclosure.summary}`);
  assertTrue(disclosure.contentHidden, `${page} shows its prompt content while closed`);
}

async function openPrompt(devtools: Devtools, page: string): Promise<void> {
  await click(devtools, "agent-prompt-summary");
  const disclosure = await waitFor(
    async () => {
      const current = await promptDisclosure(devtools);
      return current.open && !current.contentHidden ? current : undefined;
    },
    `${page} prompt to open`,
    10_000,
  );
  assertTrue(disclosure.open, `${page} did not open its prompt`);
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

/** Waits for a command control's busy label to clear, by evidence or ceiling. */
async function settleControl(devtools: Devtools, testid: string): Promise<void> {
  await waitFor(
    async () =>
      (await devtools
        .evaluate(
          `document.querySelector('[data-testid="${testid}"]')?.getAttribute('aria-busy') !== 'true'`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    `the ${testid} control to settle`,
    15_000,
  );
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
  "agent-activity-bar",
  "agent-activity-toggle",
  "agent-activity-dot",
  "agent-activity-last",
  "agent-activity-control",
  "agent-start",
  "agent-stop",
  "agent-header",
  "agent-sync-at",
  "agent-cadence",
  "agent-last-run",
  "agent-next-run",
  "agent-save-cadence",
  "agent-limit-hour",
  "agent-limit-pending",
  "agent-save-limits",
  "agent-issues-count",
  "agent-issues",
];

async function pageLifecycle(devtools: Devtools): Promise<string> {
  const value = await devtools.evaluate(`(() => {
    const page = document.querySelector('[data-testid="agent-page"]');
    const id = page?.dataset.agent ?? '';
    return id.length === 0
      ? ''
      : document.querySelector('[data-testid="agent-state-' + id + '"]')?.dataset.state ?? '';
  })()`);
  return typeof value === "string" ? value : "";
}

async function agentLast(devtools: Devtools): Promise<string> {
  const value = await devtools.evaluate(`(() => {
    const page = document.querySelector('[data-testid="agent-page"]');
    return page?.querySelector('[data-testid="agent-activity-last"]')?.textContent?.trim() ?? '';
  })()`);
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      (await devtools.evaluate(
        `document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-log"]') !== null`,
      )) === true
    ) {
      break;
    }
    await Bun.sleep(100);
  }
  const shape = await devtools.evaluate(`(() => {
    const page = document.querySelector('[data-testid="agent-page"]');
    const toggle = page?.querySelector('[data-testid="agent-activity-toggle"]');
    return {
      agent: page?.getAttribute('data-agent') ?? '',
      toggles: page?.querySelectorAll('[data-testid="agent-activity-toggle"]').length ?? 0,
      expanded: toggle?.getAttribute('aria-expanded') ?? '',
      log: page?.querySelector('[data-testid="agent-activity-log"]') !== null,
    };
  })()`);
  if ((shape as { log?: boolean }).log !== true) {
    throw new Error(`the activity bar log never opened: ${JSON.stringify(shape)}`);
  }
  const value = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-log"]');
    return element === null ? "" : (element.textContent ?? '').trim();
  })()`);
  return typeof value === "string" ? value : "";
}

async function coreSequence(devtools: Devtools): Promise<string[]> {
  const value = await devtools.evaluate(`(() => {
    const page = document.querySelector('[data-testid="agent-page"]');
    const all = [...(page?.querySelectorAll('[data-testid]') ?? [])]
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
  Array<{ url: string; state: string; tone: string; version: string; title: string }>
> {
  const value = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="agent-issue"]')
  ].map((row) => ({
    url: row.dataset.url ?? '',
    state: row.dataset.state ?? '',
    tone: row.querySelector('[data-testid="agent-issue-state"]')?.dataset.tone ?? '',
    version: row.dataset.version ?? '',
    title: row.querySelector('[data-testid="agent-issue-title"]')?.textContent?.trim() ?? '',
  })))()`);
  return Array.isArray(value)
    ? (value as Array<{ url: string; state: string; tone: string; version: string; title: string }>)
    : [];
}

interface ScoutSyncState {
  state: "ok" | "error" | "stale";
  at: string | null;
  error: string | null;
}

/** The Auto Scout worker state the source page renders. */
function scoutSync(stateDir: string, root: string): ScoutSyncState | undefined {
  const candidates: Array<{ updatedAt: string; sync: ScoutSyncState }> = [];
  const legacy = readState(statePath(stateDir, root));
  if (legacy !== undefined) candidates.push({ updatedAt: legacy.updatedAt, sync: legacy.sync });
  for (const directory of workerStateDirectories(stateDir, root)) {
    const state = readState(join(directory, "state.json"));
    if (state !== undefined) candidates.push({ updatedAt: state.updatedAt, sync: state.sync });
  }
  return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.sync;
}

/** Edits the mutable gh store the source dashboard's stub reads. */
async function updateGhStore(
  path: string,
  update: (store: Record<string, unknown>) => void,
): Promise<void> {
  const store = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  update(store);
  await writeFile(path, JSON.stringify(store, null, 2));
}

const INSTALLED_PROMPT =
  "---\ndescription: installed fixture\n---\n\n## Manifesto\n\nLeave the host with the improvements Auto Scout found.\n\nRead-only here.\n";
const SOURCE_PROMPT =
  "---\ndescription: source fixture\n---\n\n## Manifesto\n\nLeave the host with the improvements Auto Scout found.\n\nKeep every byte.\n";
const INSTALLED_DESIGN_PROMPT =
  "## Manifesto\n\nLeave the interface consistent with its documented standard.\n\nRead-only here.\n";
const SOURCE_DESIGN_PROMPT =
  "## Manifesto\n\nLeave the interface consistent with its documented standard.\n\nKeep every byte.\n";
const INSTALLED_DEAD_CODE_PROMPT =
  "## Manifesto\n\nLeave the host without the dead code the agent proves.\n\nRead-only here.\n";
const SOURCE_DEAD_CODE_PROMPT =
  "## Manifesto\n\nLeave the host without the dead code the agent proves.\n\nKeep every byte.\n";
const SOURCE_ACP = join(import.meta.dir, "..", "tests", "fixtures", "verify-source-acp.ts");
const SCOUT_STUB_GH = join(import.meta.dir, "..", "tests", "fixtures", "scout-stub-gh.ts");

const ISSUE_URLS = [
  "https://github.com/acme/fixture/issues/101",
  "https://github.com/acme/fixture/issues/102",
];

/** The MCP optimizer settings the template's allowlist section must show live. */
const MCP_OPTIMIZER_ALLOWLIST = ["gh pr merge", "systemctl restart devboard"];

/** The dashboard's open-issue read for the fixture: two MCP optimizer and one unrelated. */
const MCP_OPTIMIZER_ISSUES = [
  {
    number: 201,
    title: "[mcp-optimizer] bun run publish",
    body: "family:aaaaaaaaaaaa",
    url: "https://github.com/acme/fixture/issues/201",
  },
  {
    number: 202,
    title: "[mcp-optimizer] prompt: retry loop",
    body: "family:bbbbbbbbbbbb",
    url: "https://github.com/acme/fixture/issues/202",
  },
  {
    number: 203,
    title: "Unrelated fixture issue",
    body: "Nothing to do with the MCP optimizer.",
    url: "https://github.com/acme/fixture/issues/203",
  },
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
  *"repos/acme/fixture/issues?state=open"*)
    printf 'HTTP/2.0 200 OK\\ncontent-type: application/json\\netag: "fixture"\\n\\n'
${MCP_OPTIMIZER_ISSUES.map(
  (issue) =>
    `    printf '%s\\n' '${JSON.stringify({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      createdAt: "2026-10-01T00:00:00Z",
      labels: ["mcp-optimizer"],
      body: issue.body,
    })}'`,
).join("\n")}
    ;;
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
  await writeFile(
    join(host.directory, ".devboard", "prompts", "design-system.md"),
    INSTALLED_DESIGN_PROMPT,
  );
  await writeFile(
    join(host.directory, ".devboard", "prompts", "dead-code-removal.md"),
    INSTALLED_DEAD_CODE_PROMPT,
  );
  assertTrue(
    run("git", ["-C", host.directory, "add", ".devboard/prompts"]).code === 0 &&
      run("git", ["-C", host.directory, "commit", "-q", "-m", "installed prompts"]).code === 0,
    "verify:agents: could not commit the installed prompt fixture",
  );
  await mkdir(join(host.directory, ".omp", "commands"), { recursive: true });
  await writeFile(
    join(host.directory, ".omp", "commands", "scout-recommendations.md"),
    "# scout\n",
  );
  await writeFile(
    join(host.directory, ".omp", "commands", "dead-code-removal.md"),
    "# dead code\n",
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
  const seededMcpOptimizerDir = mcpOptimizerDirectory(stateDir);
  await mkdir(seededMcpOptimizerDir, { recursive: true });
  await writeFile(
    join(seededMcpOptimizerDir, "settings.json"),
    `${JSON.stringify(
      { allowlist: MCP_OPTIMIZER_ALLOWLIST, maxPerHour: null, maxPending: null },
      null,
      2,
    )}\n`,
  );

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
        const response = await fetch(`http://127.0.0.1:${port}/ready`, {
          ...VERIFY_DASHBOARD_AUTHORIZATION,
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
  await writeFile(
    join(sourceHost.directory, ".devboard", "prompts", "design-system.md"),
    SOURCE_DESIGN_PROMPT,
  );
  await writeFile(
    join(sourceHost.directory, ".devboard", "prompts", "dead-code-removal.md"),
    SOURCE_DEAD_CODE_PROMPT,
  );
  assertTrue(
    run("git", ["-C", sourceHost.directory, "add", ".devboard/prompts"]).code === 0 &&
      run("git", ["-C", sourceHost.directory, "commit", "-q", "-m", "source prompts"]).code === 0,
    "verify:agents: could not commit the source prompt fixture",
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
  await writeFile(
    join(sourceHost.directory, ".omp", "commands", "dead-code-removal.md"),
    "# dead code\n",
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
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  sourceDashboardPid = sourceDashboard.pid ?? 0;
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${sourcePort}/ready`, {
          ...VERIFY_DASHBOARD_AUTHORIZATION,
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
      dashboardPageUrl(port),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromePid = chrome.pid ?? 0;

  devtools = new Devtools(await pageTarget(debugPort, port));
  await devtools.connect();
  await devtools.send("Runtime.enable");
  await devtools.send("Page.enable");

  /* 1. The sidebar section and all four entries. */
  await waitFor(
    async () => ((await present(devtools!, "mode-issues")) ? true : undefined),
    "the Issues mode control",
    30_000,
  );
  await click(devtools, "mode-issues");
  await waitFor(
    async () => ((await present(devtools!, "open-issues-queue")) ? true : undefined),
    "the Issues sidebar",
    15_000,
  );
  assertTrue(
    !(await present(devtools!, "sidebar-background-agents")),
    "the Issues sidebar still carries the Background agents section",
  );
  const issuesSurfaces = await devtools.evaluate(`(() => {
    const section = document.querySelector(
      '[data-testid="sidebar"] section[aria-label="Issues surfaces"]',
    );
    const groups = [...document.querySelectorAll('[data-testid="sidebar"] .sidebar-group')]
      .map((group) => group.getAttribute('aria-label') ?? '');
    if (section === null) return { groups };
    return {
      heading: section.querySelector('.sidebar-group__title')?.textContent?.trim() ?? '',
      ids: [...section.querySelectorAll('[data-testid^="open-issues-"]')]
        .map((button) => button.getAttribute('data-testid') ?? ''),
      groups,
    };
  })()`);
  assertTrue(
    (issuesSurfaces as Record<string, unknown> | null)?.heading === "Issues surfaces" &&
      JSON.stringify((issuesSurfaces as { ids: string[] } | null)?.ids) ===
        JSON.stringify(["open-issues-overview", "open-issues-queue", "open-issues-drafts"]) &&
      JSON.stringify((issuesSurfaces as { groups: string[] } | null)?.groups) ===
        JSON.stringify(["Issues surfaces"]),
    `the Issues entries are not below Overview in one section: ${JSON.stringify(issuesSurfaces)}`,
  );
  await click(devtools, "mode-devboard");
  await waitFor(
    async () => ((await present(devtools!, "sidebar-background-agents")) ? true : undefined),
    "the Background agents section",
    15_000,
  );
  const groups = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="sidebar-background-agents"]')
  ].map((section) => ({
    heading: section.querySelector('.sidebar-group__title')?.textContent?.trim() ?? '',
    ids: [...section.querySelectorAll('[data-testid^="open-devboard-"]')]
      .map((button) => button.getAttribute('data-testid') ?? ''),
  })))()`);
  assertTrue(
    Array.isArray(groups) &&
      (groups as Array<{ heading: string; ids: string[] }>)[0]?.heading === "Background agents" &&
      JSON.stringify((groups as Array<{ ids: string[] }>)[0]?.ids) ===
        JSON.stringify([
          "open-devboard-scout",
          "open-devboard-watchdog",
          "open-devboard-design",
          "open-devboard-dead-code",
          "open-devboard-mcp-optimizer",
          "open-devboard-api-standards",
          "open-devboard-single-responsibility",
          "open-devboard-release-train",
        ]),
    `the Background agents section is wrong: ${JSON.stringify(groups)}`,
  );
  const sidebarOrder = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="sidebar"] .sidebar-group')
  ].map((section) => section.getAttribute('aria-label') ?? ''))()`);
  assertTrue(
    JSON.stringify(sidebarOrder) ===
      JSON.stringify(["Background agents", "Devboard sections"]),
    `the Devboard sidebar groups are out of order: ${JSON.stringify(sidebarOrder)}`,
  );
  for (const [id, label] of [
    ["scout", "Auto Scout"],
    ["watchdog", "Watchdog"],
    ["design", "Design System"],
    ["dead-code", "Dead Code"],
    ["mcp-optimizer", "MCP optimizer"],
    ["api-standards", "API Standards"],
    ["single-responsibility", "Single Responsibility"],
    ["release-train", "Release Train"],
  ]) {
    const entry = await devtools.evaluate(`(() => {
      const button = document.querySelector('[data-testid="open-devboard-${id}"]');
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
    assertTrue(record?.count === "0", `${id} filed count starts at ${String(record?.count)}`);
  }
  console.log("PASS sidebar-background-agents");

  /* 2. Both pages share one empty shape and their detail panels. */
  await click(devtools, "open-devboard-scout");
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
  assertTrue(!(await present(devtools, "agent-detail")), "Auto Scout still renders the detail panel");
  assertTrue(!(await present(devtools, "agent-lifecycle")), "Auto Scout still renders a lifecycle badge");
  const scoutCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(scoutCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the Auto Scout core ids differ: ${JSON.stringify(scoutCore)}`,
  );

  await click(devtools, "open-devboard-design");
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
  assertTrue(!(await present(devtools, "agent-detail")), "Design System still renders the detail panel");
  assertTrue(!(await present(devtools, "agent-lifecycle")), "Design System still renders a lifecycle badge");
  const designCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(designCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the Design System core ids differ: ${JSON.stringify(designCore)}`,
  );

  await click(devtools, "open-devboard-dead-code");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Dead Code page",
    10_000,
  );
  const deadCodePage = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
  );
  assertTrue(deadCodePage === "dead-code", `the Dead Code page names ${String(deadCodePage)}`);
  assertTrue(await present(devtools, "agent-issues-empty"), "Dead Code has no empty table");
  assertTrue(!(await present(devtools, "agent-detail")), "Dead Code still renders the detail panel");
  assertTrue(!(await present(devtools, "agent-lifecycle")), "Dead Code still renders a lifecycle badge");
  const deadCodeCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(deadCodeCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the Dead Code core ids differ: ${JSON.stringify(deadCodeCore)}`,
  );
  assertTrue(
    (await valueOf(devtools, "agent-cadence")) === "60",
    `the Dead Code cadence is ${await valueOf(devtools, "agent-cadence")}`,
  );
  assertTrue(
    (await valueOf(devtools, "agent-limit-hour")) === "10",
    `the Dead Code hourly limit is ${await valueOf(devtools, "agent-limit-hour")}`,
  );
  assertTrue(
    (await valueOf(devtools, "agent-limit-pending")) === "5",
    `the Dead Code pending limit is ${await valueOf(devtools, "agent-limit-pending")}`,
  );
  console.log("PASS dead-code-descriptor open-devboard-dead-code agent-page agent-cadence=60 agent-limit-hour=10 agent-limit-pending=5");

  await click(devtools, "open-devboard-watchdog");
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
  assertTrue(!(await present(devtools, "agent-detail")), "Watchdog still renders the detail panel");
  assertTrue((await agentLast(devtools)) === "No activity yet.", "Watchdog has no empty bar activity");
  const watchdogCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(watchdogCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the Watchdog core ids differ: ${JSON.stringify(watchdogCore)}`,
  );
  assertTrue(
    (await pageLifecycle(devtools)) === "stopped",
    "Watchdog does not start stopped",
  );
  const pagePadding = (await devtools.evaluate(`(() => {
    const page = document.querySelector('[data-testid="agent-page"]');
    if (page === null) return null;
    const style = getComputedStyle(page);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
  })()`)) as string[] | null;
  assertTrue(
    JSON.stringify(pagePadding) === JSON.stringify(["16px", "16px", "16px", "16px"]),
    `the agent page padding is ${JSON.stringify(pagePadding)}`,
  );
  console.log("PASS shared-page-shape");

  await click(devtools, "open-devboard-mcp-optimizer");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the MCP optimizer page",
    10_000,
  );
  const mcpOptimizerPage = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
  );
  assertTrue(mcpOptimizerPage === "mcp-optimizer", `the MCP optimizer page names ${String(mcpOptimizerPage)}`);
  assertTrue(await present(devtools, "agent-issues-empty"), "MCP optimizer has no empty table");
  assertTrue(!(await present(devtools, "agent-detail")), "MCP optimizer still renders the detail panel");
  assertTrue((await agentLast(devtools)) === "No activity yet.", "MCP optimizer has no empty bar activity");
  const mcpOptimizerCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(mcpOptimizerCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the MCP optimizer core ids differ: ${JSON.stringify(mcpOptimizerCore)}`,
  );
  assertTrue(
    (await pageLifecycle(devtools)) === "stopped",
    "MCP optimizer does not start stopped",
  );
  await click(devtools, "open-devboard-api-standards");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the API Standards page",
    10_000,
  );
  const apiStandardsPage = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
  );
  assertTrue(
    apiStandardsPage === "api-standards",
    `the API Standards page names ${String(apiStandardsPage)}`,
  );
  assertTrue(await present(devtools, "agent-issues-empty"), "API Standards has no empty table");
  assertTrue(
    !(await present(devtools, "agent-detail")),
    "API Standards still renders the detail panel",
  );
  assertTrue(
    !(await present(devtools, "agent-documentation")),
    "API Standards renders a documentation panel",
  );
  assertTrue(
    (await agentLast(devtools)) === "No activity yet.",
    "API Standards has no empty bar activity",
  );
  const apiStandardsCore = await coreSequence(devtools);
  assertTrue(
    JSON.stringify(apiStandardsCore.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    `the API Standards core ids differ: ${JSON.stringify(apiStandardsCore)}`,
  );
  assertTrue(
    (await pageLifecycle(devtools)) === "stopped",
    "API Standards does not start stopped",
  );
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt")) ? true : undefined),
    "the API Standards prompt section",
    10_000,
  );
  await assertPromptClosed(devtools, "API Standards");
  await assertPromptMarker(devtools, "API Standards", false);
  await click(devtools, "open-devboard-mcp-optimizer");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the MCP optimizer page",
    10_000,
  );
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt")) ? true : undefined),
    "the MCP optimizer prompt section",
    10_000,
  );
  await assertPromptClosed(devtools, "MCP optimizer");
  await assertPromptMarker(devtools, "MCP optimizer", false);
  const mcpOptimizerTemplate = await waitFor(
    async () => {
      const body = await rawText(devtools, "agent-prompt-template-text");
      return body.includes(MCP_OPTIMIZER_ISSUES[0]!.url) ? body : undefined;
    },
    "the MCP optimizer template's live open-issue section",
    30_000,
  );
  const treeBefore = await settledTreeHash(host.directory);
  const treeBeforeEntries = await treeEntries(host.directory);
  await openPrompt(devtools, "MCP optimizer");
  assertTrue(
    (await countOf(devtools, "agent-prompt-template")) === 1,
    "the MCP optimizer template is not rendered exactly once",
  );
  assertTrue(
    (await countOf(devtools, "agent-prompt-absent")) === 0,
    "the MCP optimizer prompt still states an absence",
  );
  for (const testid of [
    "agent-prompt-editor",
    "agent-prompt-chat",
    "agent-prompt-message",
    "agent-prompt-send",
    "agent-prompt-save",
  ]) {
    assertTrue(
      (await countOf(devtools, testid)) === 0,
      `${testid} is rendered on the MCP optimizer page`,
    );
  }
  for (const line of [
    "## Manifesto",
    "You are the Devboard MCP optimizer synthesizer for one family. Your goal is to remove the",
    "Family:",
    "<family>",
    "Fragments:",
    "<fragments>",
    "Excerpts:",
    "<excerpts>",
    "MCP catalog:",
    "Open MCP optimizer issues:",
    "Command allowlist:",
    "Limits:",
    "Rules:",
    "- File with `issue_create` and no labels. Its returned number and URL are the record.",
    "- When the family needs no change, a duplicate exists, a cap leaves no room, or filing",
  ]) {
    assertTrue(mcpOptimizerTemplate.includes(line), `the MCP optimizer template is missing ${line}`);
  }
  for (const tool of MCP_TOOLS) {
    assertTrue(
      mcpOptimizerTemplate.includes(`"name": "${tool.name}"`),
      `the MCP optimizer template omits the ${tool.name} tool`,
    );
  }
  assertTrue(
    mcpOptimizerTemplate.includes(`Command allowlist:\n${JSON.stringify(MCP_OPTIMIZER_ALLOWLIST, null, 2)}`),
    "the MCP optimizer template does not show the live allowlist",
  );
  for (const issue of MCP_OPTIMIZER_ISSUES.slice(0, 2)) {
    assertTrue(
      mcpOptimizerTemplate.includes(`"title": "${issue.title}"`),
      `the MCP optimizer template omits ${issue.title}`,
    );
    assertTrue(mcpOptimizerTemplate.includes(issue.url), `the MCP optimizer template omits ${issue.url}`);
  }
  assertTrue(
    !mcpOptimizerTemplate.includes(MCP_OPTIMIZER_ISSUES[2]!.title),
    "the MCP optimizer template lists an unrelated issue",
  );

  await devtools.send("Page.reload");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt")) ? true : undefined),
    "the reloaded MCP optimizer prompt section",
    30_000,
  );
  await assertPromptClosed(devtools, "MCP optimizer");
  await openPrompt(devtools, "MCP optimizer");
  await waitFor(
    async () =>
      (await rawText(devtools!, "agent-prompt-template-text")) === mcpOptimizerTemplate
        ? true
        : undefined,
    "the reloaded MCP optimizer template",
    30_000,
  );
  const treeAfterEntries = await treeEntries(host.directory);
  assertTrue(
    treeDigest(treeAfterEntries) === treeBefore,
    `opening and reloading the MCP optimizer template changed the fixture tree: ${JSON.stringify(
      changedPaths(treeBeforeEntries, treeAfterEntries),
    )}`,
  );
  console.log("PASS mcp-optimizer-page");

  /* 2b. The prompt section: read-only here. */
  await click(devtools, "open-devboard-scout");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt")) ? true : undefined),
    "the Auto Scout prompt section",
    10_000,
  );
  await assertPromptClosed(devtools, "Auto Scout");
  await assertPromptMarker(devtools, "Auto Scout", false);
  const installedLayout = await promptLayout(devtools);
  assertTrue(
    installedLayout.one &&
      installedLayout.afterHeader &&
      installedLayout.beforeAlerts &&
      installedLayout.beforeMain,
    `the installed prompt section is misplaced: ${JSON.stringify(installedLayout)}`,
  );
  await openPrompt(devtools, "Auto Scout");
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
    "error",
  );
  assertTrue(
    refusedSave.message === "Invalid WebSocket message.",
    `the installed save was not refused: ${JSON.stringify(refusedSave)}`,
  );
  assertTrue(
    readFileSync(join(host.directory, ".devboard", "prompts", "scout-recommendations.md"), "utf8") ===
      INSTALLED_PROMPT,
    "the installed prompt file changed",
  );

  await click(devtools, "open-devboard-design");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `(() => {
            const section = document.querySelector('[data-testid="agent-prompt"]');
            return section?.dataset.agent === "design";
          })()`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Design System prompt section",
    10_000,
  );
  await assertPromptClosed(devtools, "Design System");
  await assertPromptMarker(devtools, "Design System", false);
  await openPrompt(devtools, "Design System");
  assertTrue(
    (await countOf(devtools, "agent-prompt-absent")) === 0,
    "the Design System prompt is declared absent",
  );
  for (const testid of [
    "agent-prompt-editor",
    "agent-prompt-chat",
    "agent-prompt-save",
  ]) {
    assertTrue(
      (await countOf(devtools, testid)) === 0,
      `${testid} is rendered for Design System in an installed host`,
    );
  }
  console.log("PASS design-prompt-read-only");

  await click(devtools, "open-devboard-dead-code");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelector('[data-testid="agent-page"]')?.dataset.agent === "dead-code"`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Dead Code page after the prompt section",
    10_000,
  );
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `(() => {
            const section = document.querySelector('[data-testid="agent-prompt"]');
            return section?.dataset.agent === "dead-code";
          })()`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Dead Code prompt section",
    10_000,
  );
  await assertPromptClosed(devtools, "Dead Code");
  await assertPromptMarker(devtools, "Dead Code", false);
  await openPrompt(devtools, "Dead Code");
  assertTrue(
    (await countOf(devtools, "agent-prompt-absent")) === 0,
    "the Dead Code prompt is declared absent",
  );
  for (const testid of [
    "agent-prompt-editor",
    "agent-prompt-chat",
    "agent-prompt-save",
  ]) {
    assertTrue(
      (await countOf(devtools, testid)) === 0,
      `${testid} is rendered for Dead Code in an installed host`,
    );
  }
  assertTrue(
    (await rawText(devtools, "agent-prompt-text")).includes("dead code"),
    "the Dead Code prompt text does not render dead-code-removal.md",
  );
  console.log("PASS dead-code-prompt-read-only dead-code-removal.md");

  await click(devtools, "open-devboard-watchdog");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelector('[data-testid="agent-page"]')?.dataset.agent === "watchdog"`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Watchdog page after the prompt section",
    10_000,
  );
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt")) ? true : undefined),
    "the Watchdog prompt section",
    10_000,
  );
  await assertPromptClosed(devtools, "Watchdog");
  await assertPromptMarker(devtools, "Watchdog", false);
  await openPrompt(devtools, "Watchdog");
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

  /* 3. Cadence and limits: two labelled groups, each ending in its own Save. */
  const band = await devtools.evaluate(`(() => {
    const container = document.querySelector('.agent-settings');
    if (container === null) return null;
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--secondary)';
    document.body.append(probe);
    const secondary = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const group = (label) => {
      const element = [...container.querySelectorAll('[role="group"]')]
        .find((candidate) => candidate.getAttribute('aria-label') === label) ?? null;
      if (element === null) return null;
      const save = element.lastElementChild;
      const style = getComputedStyle(element);
      return {
        title: element.querySelector('.agent-settings__title')?.textContent?.trim() ?? '',
        columnGap: style.columnGap,
        rowGap: style.rowGap,
        save: save?.getAttribute('data-testid') ?? '',
        saveLabel: (save?.textContent ?? '').trim(),
        saveBackground: save === null ? '' : getComputedStyle(save).backgroundColor,
      };
    };
    const style = getComputedStyle(container);
    return {
      outer: container.getAttribute('aria-label') ?? '',
      columnGap: style.columnGap,
      rowGap: style.rowGap,
      secondary,
      cadence: group('Cadence'),
      limits: group('Filing limits'),
    };
  })()`);
  const bandRecord = band as {
    outer: string;
    columnGap: string;
    rowGap: string;
    secondary: string;
    cadence: Record<string, string> | null;
    limits: Record<string, string> | null;
  } | null;
  assertTrue(
    bandRecord?.outer === "Cadence and filing limits",
    `the settings band is unnamed: ${JSON.stringify(bandRecord)}`,
  );
  assertTrue(
    bandRecord?.columnGap === "24px" && bandRecord?.rowGap === "24px",
    `the settings groups are not 24px apart: ${JSON.stringify(bandRecord)}`,
  );
  for (const [label, expected, save, saveLabel] of [
    ["cadence", "Cadence", "agent-save-cadence", "Save cadence"],
    ["limits", "Filing limits", "agent-save-limits", "Save limits"],
  ] as const) {
    const group = bandRecord?.[label];
    assertTrue(group?.title === expected, `the ${label} group title is ${String(group?.title)}`);
    assertTrue(
      group?.columnGap === "10px" && group?.rowGap === "6px",
      `the ${label} group gaps are ${String(group?.columnGap)} / ${String(group?.rowGap)}`,
    );
    assertTrue(
      group?.save === save && group?.saveLabel === saveLabel,
      `the ${label} group does not end in ${save}: ${JSON.stringify(group)}`,
    );
    assertTrue(
      group?.saveBackground === bandRecord?.secondary,
      `the ${label} save is not the secondary variant: ${String(group?.saveBackground)}`,
    );
  }

  await setInput(devtools, "agent-cadence", "0");
  await click(devtools, "agent-save-cadence");
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
  await click(devtools, "agent-save-limits");
  const limitsError = await waitFor(
    async () => {
      const value = await text(devtools!, "agent-settings-error");
      return value.includes("1 through 100") ? value : undefined;
    },
    "the limits error",
    10_000,
  );
  assertTrue(limitsError.includes("1 through 100"), "the limits error is wrong");
  await settleControl(devtools, "agent-save-limits");

  // A rejected save still holds its control's busy word until the shared
  // ceiling releases it; the next activation must wait for that release.
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelector('[data-testid="agent-save-limits"]')?.getAttribute('aria-busy') !== 'true'`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the Save limits control after a rejected save",
    15_000,
  );

  await setInput(devtools, "agent-limit-hour", "");
  await Bun.sleep(250);
  await setInput(devtools, "agent-limit-pending", "");
  await Bun.sleep(250);
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
      const id = document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? '';
      const state = id.length === 0
        ? ''
        : document.querySelector('[data-testid="agent-state-' + id + '"]')?.dataset.state ?? '';
      const seen = window.__lifecycles[window.__lifecycles.length - 1];
      if (state.length > 0 && state !== seen) window.__lifecycles.push(state);
    }, 5);
    return true;
  })()`);
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await pageLifecycle(devtools!)) === "running" ? true : undefined),
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
  const runningControls = (await devtools.evaluate(`(() => {
    const page = document.querySelector('[data-testid="agent-page"]');
    const control = page?.querySelector('[data-testid="agent-activity-control"]');
    return {
      testIds: [...(control?.querySelectorAll('button') ?? [])].map(
        (button) => button.getAttribute('data-testid') ?? '',
      ),
      extras: [...(page?.querySelectorAll(
        '[data-testid="agent-check-now"], [data-testid="agent-pause"], [data-testid="agent-resume"]',
      ) ?? [])].length,
    };
  })()`)) as { testIds: string[]; extras: number };
  assertTrue(
    JSON.stringify(runningControls.testIds) === JSON.stringify(["agent-stop"]) &&
      runningControls.extras === 0,
    `the running activity bar control is not exactly Stop: ${JSON.stringify(runningControls)}`,
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await pageLifecycle(devtools!)) === "stopped" ? true : undefined),
    "the stopped lifecycle",
    10_000,
  );
  const stopStates = await devtools.evaluate(`window.__lifecycles ?? []`);
  assertTrue(
    Array.isArray(stopStates) && (stopStates as string[]).includes("stopping"),
    `Stop never published stopping: ${JSON.stringify(stopStates)}`,
  );
  console.log("PASS lifecycle");

  await click(devtools, "open-devboard-scout");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Auto Scout page",
    10_000,
  );
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await pageLifecycle(devtools!)) === "running" ? true : undefined),
    "the running Auto Scout",
    10_000,
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await pageLifecycle(devtools!)) === "stopped" ? true : undefined),
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
  await click(devtools, "open-devboard-watchdog");
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
  assertTrue(
    (await text(devtools, "agent-count-watchdog")) === "2",
    "the Watchdog sidebar count does not match its filed rows",
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
  await click(devtools, "open-devboard-scout");
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
    scoutRows[0]?.version === "" && scoutRows[0]?.tone === "pending",
    `the pending Auto Scout row is wrong: ${JSON.stringify(scoutRows)}`,
  );
  assertTrue(
    scoutRows[1]?.version === "v1.0.0" && scoutRows[1]?.tone === "success",
    `the implemented Auto Scout row is wrong: ${JSON.stringify(scoutRows)}`,
  );
  assertTrue(
    (await text(devtools, "agent-issues-count")).startsWith("2 filed"),
    "the Auto Scout count did not refresh",
  );
  assertTrue(
    (await text(devtools, "agent-count-scout")) === "2",
    "the Auto Scout sidebar count does not match its filed rows",
  );
  assertTrue(
    JSON.stringify(await columns(devtools)) ===
      JSON.stringify(["Title", "Category", "Filed", "State", "Shipped"]),
    "the Auto Scout table columns differ",
  );
  const mcpOptimizerDir = mcpOptimizerDirectory(stateDir);
  await mkdir(mcpOptimizerDir, { recursive: true });
  await writeFile(
    join(mcpOptimizerDir, "state.json"),
    JSON.stringify({
      version: 3,
      families: {
        "bun run publish": {
          firstSeen: now,
          lastSeen: now,
          calls: 2,
          sessions: 2,
          kind: "command",
          lastAction: "filed",
          lastIssueUrl: "https://github.com/acme/fixture/issues/103",
          lastTitle: "[mcp-optimizer] bun run publish",
          lastFiledAt: now,
        },
      },
      pendingFiling: [],
    }),
  );
  await writeFile(
    join(mcpOptimizerDir, "latest.json"),
    JSON.stringify({
      cycle: now,
      window: { start: now, end: now, minutes: 1440 },
      families: 3,
      selected: [{ key: "bun run publish", kind: "command", score: 4 }],
      findings: [{ key: "bun run publish", kind: "command", score: 4 }],
      action: "filed",
      issues: [{ url: "https://github.com/acme/fixture/issues/103" }],
      pending: 0,
    }),
  );
  await click(devtools, "open-devboard-mcp-optimizer");
  await waitFor(
    async () => ((await rows(devtools!)).length === 1 ? true : undefined),
    "the seeded MCP optimizer row without a reload",
    60_000,
  );
  const mcpOptimizerRows = await rows(devtools);
  assertTrue(
    mcpOptimizerRows[0]?.title === "[mcp-optimizer] bun run publish",
    `the MCP optimizer title is wrong: ${JSON.stringify(mcpOptimizerRows)}`,
  );
  assertTrue(
    (await text(devtools, "agent-count-mcp-optimizer")) === "1",
    "the MCP optimizer sidebar count does not match its filed rows",
  );
  await waitFor(
    async () => {
      const log = await barLog(devtools!);
      return log.includes("filed") ? log : undefined;
    },
    "the MCP optimizer cycle detail",
    10_000,
  );
  await setInput(devtools, "agent-cadence", "90");
  await setInput(devtools, "agent-limit-hour", "2");
  await click(devtools, "agent-save-cadence");
  await waitFor(
    () => {
      try {
        const settings = JSON.parse(
          readFileSync(join(mcpOptimizerDir, "settings.json"), "utf8"),
        ) as Record<string, unknown>;
        return settings.intervalMinutes === 90 && settings.maxPerHour === 2 ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the persisted MCP optimizer settings",
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
    "the reloaded MCP optimizer settings",
    30_000,
  );
  /* The template's allowlist section is the settings file's live value. */
  const savedSettings = JSON.parse(
    readFileSync(join(mcpOptimizerDir, "settings.json"), "utf8"),
  ) as Record<string, unknown>;
  const nextAllowlist = ["gh pr review", "systemctl status devboard"];
  await writeFile(
    join(mcpOptimizerDir, "settings.json"),
    `${JSON.stringify({ ...savedSettings, allowlist: nextAllowlist }, null, 2)}\n`,
  );
  await devtools.send("Page.reload");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt")) ? true : undefined),
    "the MCP optimizer page after the settings edit",
    30_000,
  );
  await openPrompt(devtools, "MCP optimizer");
  await waitFor(
    async () =>
      (await rawText(devtools!, "agent-prompt-template-text")).includes(
        JSON.stringify(nextAllowlist, null, 2),
      )
        ? true
        : undefined,
    "the reconnected MCP optimizer template allowlist",
    30_000,
  );
  assertTrue(
    !(await rawText(devtools, "agent-prompt-template-text")).includes(MCP_OPTIMIZER_ALLOWLIST[0]!),
    "the MCP optimizer template kept a stale allowlist entry",
  );
  console.log("PASS mcp-optimizer-template-settings");
  console.log("PASS mcp-optimizer-detail");
  console.log("PASS freshness-and-table");

  /* 7. Watchdog cap keeps a fingerprint pending. */
  await click(devtools, "open-devboard-watchdog");
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
    async () => ((await pageLifecycle(devtools!)) === "running" ? true : undefined),
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
    async () => ((await pageLifecycle(devtools!)) === "stopped" ? true : undefined),
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
  const blockedFrame = (await devtools.evaluate(`(() => {
    const node = document.querySelector('[data-testid="agent-blocked"]');
    const style = node === null ? null : getComputedStyle(node);
    return {
      top: style === null ? 0 : parseFloat(style.borderTopWidth),
      right: style === null ? 0 : parseFloat(style.borderRightWidth),
      bottom: style === null ? 0 : parseFloat(style.borderBottomWidth),
      left: style === null ? 0 : parseFloat(style.borderLeftWidth),
      leftColor: style?.borderLeftColor ?? "",
      topColor: style?.borderTopColor ?? "",
    };
  })()`)) as {
    top: number;
    right: number;
    bottom: number;
    left: number;
    leftColor: string;
    topColor: string;
  };
  assertTrue(
    blockedFrame.top === 1 &&
      blockedFrame.right === 1 &&
      blockedFrame.bottom === 1 &&
      blockedFrame.left === 1 &&
      blockedFrame.leftColor === blockedFrame.topColor,
    `the block does not carry a uniform 1px frame: ${JSON.stringify(blockedFrame)}`,
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

  /* 10. The source checkout renders the same read-only prompt bytes. */
  await devtools.send("Page.navigate", { url: dashboardPageUrl(sourcePort) });
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.readyState === 'complete' && document.querySelector('[data-testid="mode-devboard"]') !== null`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the source dashboard",
    30_000,
  );
  await click(devtools, "mode-devboard");
  await click(devtools, "open-devboard-scout");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt")) ? true : undefined),
    "the source Auto Scout prompt section",
    15_000,
  );
  await assertPromptClosed(devtools, "source Auto Scout");
  await assertPromptMarker(devtools, "source Auto Scout", false);
  const sourceLayout = await promptLayout(devtools);
  assertTrue(
    sourceLayout.one &&
      sourceLayout.afterHeader &&
      sourceLayout.beforeAlerts &&
      sourceLayout.beforeMain,
    `the source prompt section is misplaced: ${JSON.stringify(sourceLayout)}`,
  );
  await openPrompt(devtools, "source Auto Scout");
  await assertPromptTextRegion(devtools, "agent-prompt-text", SOURCE_PROMPT, "source Auto Scout");
  for (const testid of [
    "agent-prompt-editor",
    "agent-prompt-save",
    "agent-prompt-chat",
    "agent-prompt-chat-log",
    "agent-prompt-message",
    "agent-prompt-send",
    "agent-prompt-chat-error",
    "agent-prompt-notice",
    "agent-prompt-reset",
  ]) {
    assertTrue(
      (await countOf(devtools, testid)) === 0,
      `${testid} is rendered on the source page`,
    );
  }
  const sourceChrome = await devtools.evaluate(`(() => {
    const section = document.querySelector('[data-testid="agent-prompt"]');
    return {
      fields: section?.querySelectorAll('textarea, input, [contenteditable], .monaco-editor').length ?? -1,
    };
  })()`);
  assertTrue(
    (sourceChrome as { fields: number }).fields === 0,
    `the source prompt section holds an editor: ${JSON.stringify(sourceChrome)}`,
  );
  const sourcePromptFile = join(
    sourceHost.directory,
    ".devboard",
    "prompts",
    "scout-recommendations.md",
  );
  const refusedSourceSave = await promptCommand(
    devtools,
    sourcePort,
    { type: "saveAgentPrompt", id: "scout", text: "changed\n" },
    "error",
  );
  assertTrue(
    refusedSourceSave.message === "Invalid WebSocket message.",
    `the removed source save was not refused: ${JSON.stringify(refusedSourceSave)}`,
  );
  assertTrue(
    readFileSync(sourcePromptFile, "utf8") === SOURCE_PROMPT,
    "the removed save wrote the source prompt file",
  );
  console.log("PASS prompt-read-only-source");

  /* The source checkout's MCP optimizer prompt is the same read-only template. */
  await click(devtools, "open-devboard-mcp-optimizer");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelector('[data-testid="agent-prompt"]')?.dataset.agent === "mcp-optimizer"`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the source MCP optimizer prompt section",
    15_000,
  );
  await assertPromptClosed(devtools, "source MCP optimizer");
  await assertPromptMarker(devtools, "source MCP optimizer", false);
  await openPrompt(devtools, "source MCP optimizer");
  const sourceTemplate = await waitFor(
    async () => {
      const body = await rawText(devtools!, "agent-prompt-template-text");
      return body.includes("<family>") ? body : undefined;
    },
    "the source MCP optimizer template",
    15_000,
  );
  assertTrue(
    (await countOf(devtools, "agent-prompt-template")) === 1,
    "the source MCP optimizer template is not rendered exactly once",
  );
  assertTrue(
    (await countOf(devtools, "agent-prompt-absent")) === 0,
    "the source MCP optimizer prompt states an absence",
  );
  for (const testid of [
    "agent-prompt-editor",
    "agent-prompt-chat",
    "agent-prompt-message",
    "agent-prompt-send",
    "agent-prompt-save",
  ]) {
    assertTrue(
      (await countOf(devtools, testid)) === 0,
      `${testid} is rendered on the source MCP optimizer page`,
    );
  }
  assertTrue(
    sourceTemplate.includes("## Manifesto") && sourceTemplate.includes("You are the Devboard MCP optimizer synthesizer for one family."),
    "the source MCP optimizer template is missing its intro",
  );
  console.log("PASS mcp-optimizer-template-source");

  /* 11. The source checkout's Design System prompt is the same read-only surface. */
  await click(devtools, "open-devboard-design");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelector('[data-testid="agent-prompt"]')?.dataset.agent === "design"`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the source Design System prompt section",
    15_000,
  );
  await assertPromptClosed(devtools, "source Design System");
  await assertPromptMarker(devtools, "source Design System", false);
  const designLayout = await promptLayout(devtools);
  assertTrue(
    designLayout.one &&
      designLayout.afterHeader &&
      designLayout.beforeAlerts &&
      designLayout.beforeMain,
    `the source Design System prompt section is misplaced: ${JSON.stringify(designLayout)}`,
  );
  await openPrompt(devtools, "source Design System");
  await assertPromptTextRegion(
    devtools,
    "agent-prompt-text",
    SOURCE_DESIGN_PROMPT,
    "source Design System",
  );
  assertTrue(
    (await countOf(devtools, "agent-prompt-absent")) === 0,
    "the source Design System prompt is declared absent",
  );
  for (const testid of [
    "agent-prompt-editor",
    "agent-prompt-save",
    "agent-prompt-chat",
    "agent-prompt-message",
    "agent-prompt-send",
  ]) {
    assertTrue(
      (await countOf(devtools, testid)) === 0,
      `${testid} is rendered on the source Design System page`,
    );
  }
  assertTrue(
    readFileSync(
      join(sourceHost.directory, ".devboard", "prompts", "design-system.md"),
      "utf8",
    ) === SOURCE_DESIGN_PROMPT,
    "the Design System prompt file changed",
  );
  assertTrue(
    readFileSync(sourcePromptFile, "utf8") === SOURCE_PROMPT,
    "the Design System page changed the Auto Scout prompt file",
  );
  for (const fixture of [host, sourceHost]) {
    const diff = run("git", [
      "-C",
      fixture.directory,
      "diff",
      "--exit-code",
      "--",
      ".devboard/prompts",
    ]);
    assertTrue(
      diff.code === 0,
      `${fixture.directory} prompt files changed during the walkthrough: ${diff.stdout}${diff.stderr}`,
    );
  }
  console.log("PASS design-prompt-source");

  /* 12. A transient forge read is retried before any alert; exhaustion alerts. */
  await click(devtools, "open-devboard-scout");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelector('[data-testid="agent-page"]')?.dataset.agent === "scout"`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the source Auto Scout page",
    15_000,
  );
  const syncAtBeforeRetry = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-sync-at"]')?.getAttribute('title') ?? ''`,
  );
  await updateGhStore(ghStore, (store) => {
    store.failReads = true;
    store.failMessage = "the GitHub read is unavailable";
  });
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await pageLifecycle(devtools!)) === "running" ? true : undefined),
    "the retrying Auto Scout",
    15_000,
  );
  await waitFor(
    async () => ((await rows(devtools!)).length === 2 ? true : undefined),
    "the preserved Auto Scout rows",
    15_000,
  );
  const retrying = await waitFor(
    () => {
      const sync = scoutSync(sourceStateDir, sourceHost.directory);
      return sync?.state === "stale" && sync.error === null ? sync : undefined;
    },
    "the stale sync state during a retry",
    20_000,
  );
  const previousAt = retrying.at;
  const preservedRows = await rows(devtools);
  assertTrue(
    !(await present(devtools, "agent-sync-error")),
    "agent-sync-error is rendered during the retry window",
  );
  const retrySyncAt = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-sync-at"]')?.getAttribute('title') ?? ''`,
  );
  assertTrue(
    retrySyncAt === syncAtBeforeRetry,
    `the retry changed the last read time: ${String(retrySyncAt)} was ${String(syncAtBeforeRetry)}`,
  );
  console.log("PASS sync-retry-stale-state");
  console.log("PASS sync-retry-no-alert");
  console.log("PASS sync-retry-preserved-rows");

  await updateGhStore(ghStore, (store) => {
    store.failReads = false;
  });
  const recovered = await waitFor(
    () => {
      const sync = scoutSync(sourceStateDir, sourceHost.directory);
      return sync?.state === "ok" && sync.error === null && sync.at !== previousAt
        ? sync
        : undefined;
    },
    "the recovered read",
    20_000,
  );
  await waitFor(
    async () => ((await present(devtools!, "agent-sync-error")) ? undefined : true),
    "the cleared retry alert",
    10_000,
  );
  const recoveredRows = await rows(devtools);
  assertTrue(
    preservedRows.length === 2 && recoveredRows.length === 2,
    `the retry changed the filed rows: ${JSON.stringify({ preservedRows, recoveredRows })}`,
  );
  console.log("PASS sync-retry-clears");

  /* No page shows an error for the retry that just succeeded. */
  for (const id of [
    "scout",
    "watchdog",
    "design",
    "mcp-optimizer",
    "api-standards",
    "single-responsibility",
    "release-train",
  ]) {
    await click(devtools, `open-devboard-${id}`);
    await waitFor(
      async () =>
        (await devtools!
          .evaluate(
            `document.querySelector('[data-testid="agent-page"]')?.dataset.agent === ${JSON.stringify(id)}`,
          )
          .catch(() => false)) === true
          ? true
          : undefined,
      `the ${id} page after a successful retry`,
      10_000,
    );
    assertTrue(
      !(await present(devtools, "agent-sync-error")),
      `${id} shows agent-sync-error after a successful retry`,
    );
  }
  console.log("PASS sync-retry-all-pages");

  /* A read that keeps failing exhausts the schedule into one alert. */
  await click(devtools, "open-devboard-scout");
  await waitFor(
    async () =>
      (await devtools!
        .evaluate(
          `document.querySelector('[data-testid="agent-page"]')?.dataset.agent === "scout"`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    "the source Auto Scout page",
    15_000,
  );
  await updateGhStore(ghStore, (store) => {
    store.failReads = true;
    store.failMessage = "the GitHub read is unavailable";
  });
  writeCommand(controlDirectory(sourceStateDir, sourceHost.directory), { type: "refresh" });
  await waitFor(
    () => {
      const sync = scoutSync(sourceStateDir, sourceHost.directory);
      return sync?.state === "stale" && sync.error === null ? sync : undefined;
    },
    "the first failure of the exhausted schedule",
    15_000,
  );
  assertTrue(
    !(await present(devtools, "agent-sync-error")),
    "agent-sync-error is rendered while retries remain",
  );
  const exhausted = await waitFor(
    () => {
      const sync = scoutSync(sourceStateDir, sourceHost.directory);
      return sync?.state === "error" && sync.error !== null ? sync : undefined;
    },
    "the exhausted retry schedule",
    40_000,
  );
  assertTrue(
    exhausted.at === recovered.at,
    `the exhausted schedule changed the last read time: ${String(exhausted.at)}`,
  );
  assertTrue(
    (await rows(devtools)).length === 2,
    "the exhausted schedule dropped the last known rows",
  );
  console.log("PASS sync-retry-exhausted-alert");

  /* A permanent failure appears on the first attempt, and a success clears it. */
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await pageLifecycle(devtools!)) === "stopped" ? true : undefined),
    "the stopped retrying Auto Scout",
    15_000,
  );
  await updateGhStore(ghStore, (store) => {
    store.failReads = true;
    store.failMessage = "gh: HTTP 401: Bad credentials";
  });
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await pageLifecycle(devtools!)) === "running" ? true : undefined),
    "the permanently failing Auto Scout",
    15_000,
  );
  const permanent = await waitFor(
    () => {
      const sync = scoutSync(sourceStateDir, sourceHost.directory);
      return sync?.state === "error" && sync.error?.includes("Bad credentials")
        ? sync
        : undefined;
    },
    "the permanent failure to surface",
    15_000,
  );
  assertTrue(
    permanent.error?.includes("Bad credentials"),
    `the permanent failure did not surface at once: ${JSON.stringify(permanent)}`,
  );
  assertTrue(
    (await rows(devtools)).length === 2,
    "the permanent failure dropped the last known rows",
  );
  console.log("PASS sync-retry-permanent-alert");

  await updateGhStore(ghStore, (store) => {
    store.failReads = false;
  });
  writeCommand(controlDirectory(sourceStateDir, sourceHost.directory), { type: "refresh" });
  await waitFor(
    () => {
      const sync = scoutSync(sourceStateDir, sourceHost.directory);
      return sync?.state === "ok" && sync.error === null ? sync : undefined;
    },
    "the read after the permanent failure",
    15_000,
  );
  console.log("PASS sync-retry-permanent-clears");
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await pageLifecycle(devtools!)) === "stopped" ? true : undefined),
    "the stopped verified Auto Scout",
    15_000,
  );

  /* ---------------------------------------------------------------- */
  /* The shared page lists every live version and its controls address  */
  /* both, with no version-divergence notice                            */
  /* ---------------------------------------------------------------- */
  const newestVersion = readHarnessVersion(harnessRoot) ?? "unknown";
  const seededVersions = ["0.1.900", newestVersion];
  const held = seededVersions.map((version) => {
    const lock = acquireLock(versionLockPath(lockPath(host.directory), version), {
      repo: host.directory,
      stateDir,
      harnessVersion: version,
      argv: [],
    });
    assertTrue(lock.acquired, `verify:agents: could not seed the ${version} worker lock`);
    const state = emptyState({ repo: "acme/fixture", root: host.directory });
    state.lifecycle = "idle";
    state.enabled = true;
    state.worker = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      stateDir,
      harnessVersion: version,
      argv: [],
    };
    writeState(versionedStatePath(stateDir, host.directory, version), state);
    return lock;
  });
  try {
    const snapshotReady = Promise.withResolvers<Record<string, unknown>>();
    const snapshotSocket = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
    const snapshotTimer = setTimeout(() => {
      snapshotSocket.close();
      snapshotReady.reject(new Error("verify:agents: timed out reading agentsState"));
    }, 15_000);
    snapshotSocket.onopen = () => snapshotSocket.send(JSON.stringify({ type: "getAgents" }));
    snapshotSocket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type !== "agentsState") return;
      clearTimeout(snapshotTimer);
      snapshotSocket.close();
      snapshotReady.resolve(message);
    };
    snapshotSocket.onerror = () => {
      clearTimeout(snapshotTimer);
      snapshotReady.reject(new Error("verify:agents: websocket failed"));
    };
    const snapshot = await snapshotReady.promise;
    const scoutAgent = (snapshot.agents as Array<Record<string, unknown>>).find(
      (agent) => agent.id === "scout",
    );
    const shown = ((scoutAgent?.workers ?? []) as Array<{ version: string | null }>)
      .map((worker) => worker.version ?? "unknown")
      .sort();
    for (const version of seededVersions) {
      assertTrue(
        shown.includes(version),
        `verify:agents: the shared page lost the ${version} worker: ${JSON.stringify(shown)}`,
      );
    }
    assertTrue(
      !JSON.stringify(snapshot).includes("this dashboard loaded") &&
        !JSON.stringify(snapshot).includes("It is left running"),
      "verify:agents: the shared page shows a version divergence notice",
    );
    const stopped = Promise.withResolvers<void>();
    const stopSocket = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
    const stopTimer = setTimeout(() => {
      stopSocket.close();
      stopped.reject(new Error("verify:agents: timed out sending stopAgent"));
    }, 15_000);
    stopSocket.onopen = () => {
      stopSocket.send(JSON.stringify({ type: "stopAgent", id: "scout" }));
      clearTimeout(stopTimer);
      stopSocket.close();
      stopped.resolve();
    };
    stopSocket.onerror = () => {
      clearTimeout(stopTimer);
      stopped.reject(new Error("verify:agents: websocket failed"));
    };
    await stopped.promise;
    await waitFor(
      () =>
        seededVersions.every((version) => {
          try {
            return readdirSync(
              versionedControlDirectory(stateDir, host.directory, version),
            ).some((name) => name.endsWith(".json"));
          } catch {
            return false;
          }
        })
          ? true
          : undefined,
      "Stop to reach every live worker's control directory",
      15_000,
    );
    console.log(
      `verify:agents: takeover: the shared page lists ${shown.join(" and ")} and Stop addressed both, with no divergence notice`,
    );
  } finally {
    for (const lock of held) {
      if (lock.acquired) lock.release();
    }
  }

  console.log(
    "verify:agents: the Background agents section, all seven shared pages, lifecycle, cadence, " +
      "nullable limits, the Watchdog cap, the shared table, MCP optimizer detail and settings, " +
      "freshness, no mutation on reload, the timer gate, the footer indicator, and the " +
      "periodic-read retry window and exhausted alert all hold",
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
