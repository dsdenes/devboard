#!/usr/bin/env bun
/**
 * The deterministic Discover gate. It builds the client, starts source and
 * installed dashboards against fixture hosts with the stub ACP peer, and drives
 * headless Chrome. It proves the six-entry Discovery group, one complete prompt
 * per card, independent triggers with per-agent publication, the one-at-a-time
 * rule, the fixed Run all order and its stop-at-first-failure rule, prompt chat
 * and save on a source checkout, and the read-only prompt of an installed host.
 *
 * Every fixture, state directory, browser profile, and log lives under
 * `.devboard/.tmp`. It never contacts a forge, npm, or a real model.
 *
 * `DISCOVER_VERIFY_ONLY=<scenario>[,<scenario>]` narrows a pass to the named
 * scenarios, so a failure is diagnosed by rerunning its scenario instead of the
 * whole suite; `DISCOVER_VERIFY_KEEP=1` keeps the fixtures for inspection.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { assertTrue, freePort, harnessRoot, makeHost, makeRoot, run, waitFor } from "./verification";
import { seedVerificationProvider, verificationProviderUsageEnv } from "./provider-fixture";

const stubAcp = join(harnessRoot, "server", "fixtures", "stub-agent.ts");
const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

const AGENTS = [
  { id: "sheet", label: "Data Sheet", command: "/discover-sheet" },
  { id: "discover-testing-strategy", label: "Testing Strategy", command: "/discover-testing-strategy" },
  { id: "discover-naming-conventions", label: "Naming Conventions", command: "/discover-naming-conventions" },
  { id: "discover-coding-conventions", label: "Coding Conventions", command: "/discover-coding-conventions" },
  {
    id: "discover-architecture-boundaries",
    label: "Architecture & Boundaries",
    command: "/discover-architecture-boundaries",
  },
  { id: "discover-glossary", label: "Glossary Agent", command: "/discover-glossary" },
];

const PROMPT_FILES = AGENTS.map((agent) =>
  agent.id === "sheet" ? "discover-sheet.md" : `${agent.id}.md`,
);

const BOOKKEEPING = new Set([".omp/discover/manifest.json", ".omp/discover/decisions.json"]);

/**
 * The scenarios this gate proves, in run order, under the names their `PASS`
 * lines carry. `DISCOVER_VERIFY_ONLY` narrows a rerun to the named ones, so a
 * diagnosis never costs the whole suite.
 */
const SCENARIOS = [
  "discovery-group",
  "per-agent-prompts",
  "run-all-order",
  "per-agent-publication",
  "one-at-a-time",
  "run-all-halt",
  "skill-read-only",
  "installed-read-only",
] as const;

type Scenario = (typeof SCENARIOS)[number];

/** The scenarios `DISCOVER_VERIFY_ONLY` selects; an empty set means every one. */
function scenarioSelection(): Set<Scenario> {
  const requested = (process.env.DISCOVER_VERIFY_ONLY ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const selected = new Set<Scenario>();
  for (const name of requested) {
    if (!(SCENARIOS as readonly string[]).includes(name)) {
      console.error(
        `verify:discover: unknown scenario ${name}; choose from ${SCENARIOS.join(", ")}`,
      );
      process.exit(1);
    }
    selected.add(name as Scenario);
  }
  return selected;
}

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`;
    throw new Error(`verify:discover: ${message}${detail}`);
  }
}

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("verify:discover: Chrome is unavailable");
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

async function countOf(devtools: Devtools, testid: string): Promise<number> {
  const value = await devtools.evaluate(
    `document.querySelectorAll('[data-testid="${testid}"]').length`,
  );
  return typeof value === "number" ? value : 0;
}

async function text(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    return element === null ? "" : (element.textContent ?? '');
  })()`);
  return typeof value === "string" ? value : "";
}

async function valueOf(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.value ?? ''`,
  );
  return typeof value === "string" ? value : "";
}

async function attribute(
  devtools: Devtools,
  testid: string,
  name: string,
): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.getAttribute(${JSON.stringify(name)}) ?? ''`,
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
    20_000,
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

/** Sends one command over a fresh socket and returns the named frame. */
async function wsCommand(
  devtools: Devtools,
  port: number,
  command: Record<string, unknown>,
  frame: string,
): Promise<Record<string, unknown>> {
  const value = await devtools.evaluate(`new Promise((resolve) => {
    const socket = new WebSocket('ws://127.0.0.1:${port}/ws');
    const guard = setTimeout(() => { socket.close(); resolve(null); }, 15000);
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

/** Every byte under `.omp/discover` and `.omp/skills`, keyed by relative path. */
function ompBytes(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, next);
      else if (entry.isFile()) {
        files.set(next, readFileSync(absolute).toString("base64"));
      }
    }
  };
  walk(join(root, ".omp", "discover"), ".omp/discover");
  walk(join(root, ".omp", "skills"), ".omp/skills");
  return files;
}

function ownedPaths(agent: string): Set<string> {
  if (agent === "sheet") return new Set([".omp/discover/sheet.json"]);
  if (agent === "discover-glossary") {
    return new Set([
      ".omp/discover/glossary/orders.glossary.yaml",
      ".omp/discover/significance.json",
      ".omp/discover/skills/discover-glossary/SKILL.md",
      ".omp/skills/discover-glossary/SKILL.md",
    ]);
  }
  return new Set([
    `.omp/discover/skills/${agent}/SKILL.md`,
    `.omp/skills/${agent}/SKILL.md`,
  ]);
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(path) !== after.get(path)) changed.push(path);
  }
  return changed.sort();
}

function otherChanges(
  changed: string[],
  agent: string,
): string[] {
  const owned = ownedPaths(agent);
  return changed.filter((path) => !owned.has(path) && !BOOKKEEPING.has(path));
}

interface Dashboard {
  process: ReturnType<typeof spawn>;
  port: number;
}

async function startDashboard(options: {
  repoDir: string;
  stateDir: string;
  logPath: string;
  extraStub?: string[];
  agentCommand?: string;
}): Promise<Dashboard> {
  await mkdir(options.stateDir, { recursive: true });
  seedVerificationProvider(options.stateDir);
  const port = await freePort();
  const command =
    options.agentCommand ??
    `${process.execPath} ${stubAcp} --log=${options.logPath} --discover ${(options.extraStub ?? []).join(" ")}`;
  const child = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      ...verificationProviderUsageEnv(),
      HOST: "127.0.0.1",
      PORT: String(port),
      REPO_DIR: options.repoDir,
      ADRS_DIR: join(options.repoDir, "adrs"),
      GOAL_FILE: join(options.repoDir, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: options.stateDir,
      AGENT_COMMAND: command,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk) => writeFileSync(String(options.stateDir) + "/server.stderr", String(chunk), { flag: "a" }));
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
    `the dashboard on ${port}`,
    30_000,
  );
  return { process: child, port };
}

function logPrompts(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("prompt /discover"))
    .map((line) => line.slice("prompt ".length));
}

/** A git host whose `.devboard` makes it a harness source checkout. */
async function makeSourceHost(root: string, name: string): Promise<string> {
  const host = await makeHost(root, name);
  const prompts = join(host.directory, ".devboard", "prompts");
  await mkdir(prompts, { recursive: true });
  await writeFile(
    join(host.directory, ".devboard", "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" }, null, 2)}\n`,
  );
  for (const file of PROMPT_FILES) {
    await cp(join(harnessRoot, "prompts", file), join(prompts, file));
  }
  await mkdir(join(host.directory, ".omp", "commands"), { recursive: true });
  return host.directory;
}

/** An installed prefix: the same prompts, read-only. */
async function makeInstalledHost(root: string, name: string): Promise<string> {
  const host = await makeHost(root, name);
  const prefix = join(host.directory, ".devboard");
  await mkdir(join(prefix, "prompts"), { recursive: true });
  await writeFile(
    join(prefix, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" }, null, 2)}\n`,
  );
  const installed = join(prefix, "node_modules", "@dsdenes", "devboard");
  await mkdir(installed, { recursive: true });
  await writeFile(
    join(installed, "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version: "0.1.0" }, null, 2)}\n`,
  );
  for (const file of PROMPT_FILES) {
    await cp(join(harnessRoot, "prompts", file), join(prefix, "prompts", file));
  }
  return host.directory;
}

async function openCard(devtools: Devtools, agent: string): Promise<void> {
  await waitFor(
    async () =>
      (await countOf(devtools, "discover-agent-tab")) === 6 ? true : undefined,
    "the six Discovery entries",
    20_000,
  );
  const clicked = await devtools.evaluate(`(() => {
    const button = document.querySelector('[data-testid="discover-agent-tab"][data-agent="${agent}"]');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  assertTrue(clicked === true, `the ${agent} sidebar entry is missing`);
  await waitFor(
    async () =>
      (await attribute(devtools, "discover-agent", "data-agent")) === agent ? true : undefined,
    `the ${agent} card`,
    15_000,
  );
}

/** Opens the Overview page, which owns the single Run all control. */
async function openOverview(devtools: Devtools): Promise<void> {
  const clicked = await devtools.evaluate(`(() => {
    const button = document.querySelector('[data-testid="discover-tab"][data-tab="overview"]');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  assertTrue(clicked === true, "the Overview sidebar entry is missing");
  await waitFor(
    async () =>
      (await attribute(devtools, "discover-panel", "data-tab")) === "overview" ? true : undefined,
    "the Overview panel",
    15_000,
  );
}

/** Selects Discover on a freshly loaded dashboard. */
async function openDiscoverMode(devtools: Devtools, description: string): Promise<void> {
  await waitFor(
    async () =>
      (await devtools
        .evaluate(
          `document.readyState === 'complete' && document.querySelector('[data-testid="mode-discover"]') !== null`,
        )
        .catch(() => false)) === true
        ? true
        : undefined,
    description,
    30_000,
  );
  await click(devtools, "mode-discover");
  await waitFor(
    async () => ((await present(devtools, "discover-agents")) ? true : undefined),
    `${description}: the Discovery group`,
    15_000,
  );
}

async function waitStatus(devtools: Devtools, agent: string, state: string): Promise<void> {
  await waitFor(
    async () =>
      (await devtools.evaluate(`(() => {
        const tab = document.querySelector('[data-testid="discover-agent-tab"][data-agent="${agent}"]');
        return tab?.getAttribute('data-state') ?? '';
      })()`)) === state
        ? true
        : undefined,
    `${agent} to reach ${state}`,
    30_000,
  );
}

const root = await makeRoot("verify-discover");
const only = scenarioSelection();
/** True when this pass runs the scenario: no filter, or the filter names it. */
const selected = (...names: Scenario[]): boolean =>
  only.size === 0 || names.some((name) => only.has(name));
const pids: number[] = [];
let chromePid = 0;
let devtools: Devtools | undefined;

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:discover: bun run build failed: ${build.stderr}`);
  assertTrue(
    Bun.file(join(harnessRoot, "dist", "index.html")).size > 0,
    "verify:discover: the build produced dist/index.html",
  );

  /* --- source checkout: the six cards and their independent triggers --- */
  const source = await makeSourceHost(root, "source-host");
  const sourceState = join(source, ".devboard", ".tmp", "state");
  const sourceLog = join(root, "source-acp.log");
  const dashboard = await startDashboard({
    repoDir: source,
    stateDir: sourceState,
    logPath: sourceLog,
  });
  pids.push(dashboard.process.pid ?? 0);

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
      `http://127.0.0.1:${dashboard.port}/`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromePid = chrome.pid ?? 0;
  devtools = new Devtools(await pageTarget(debugPort, dashboard.port));
  await devtools.connect();
  await devtools.send("Runtime.enable");
  await devtools.send("Page.enable");

  await waitFor(
    async () => ((await present(devtools!, "mode-discover")) ? true : undefined),
    "the Discover mode control",
    30_000,
  );
  await click(devtools, "mode-discover");
  await waitFor(
    async () => ((await present(devtools!, "discover-agents")) ? true : undefined),
    "the Discovery group",
    15_000,
  );

  if (selected("discovery-group")) {
    /* 1. The Discovery group holds exactly six entries with the declared ids. */
    const entries = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="discover-agents"] [data-testid="discover-agent-tab"]')
  ].map((button) => ({
    agent: button.getAttribute('data-agent') ?? '',
    label: button.querySelector('.sidebar-item__label')?.textContent?.trim() ?? '',
  })))()`);
    check(
      JSON.stringify(entries) ===
        JSON.stringify(AGENTS.map((agent) => ({ agent: agent.id, label: agent.label }))),
      "the Discovery group is not exactly the six declared entries",
      entries,
    );
    // Before any publication the always-present section entries are the two
    // established pages; the five skill entries arrive with their artifacts.
    const sectionsBefore = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="discover-tab"]')
  ].map((button) => button.getAttribute('data-tab') ?? ''))()`);
    check(
      JSON.stringify(sectionsBefore) === JSON.stringify(["overview", "glossary"]),
      "the existing Discover section entries changed",
      sectionsBefore,
    );
    // The published pages lead the sidebar; the agent triggers follow them.
    const leadingGroup = await devtools.evaluate(`(() => {
    const group = document.querySelector('[data-testid="sidebar"] .sidebar-group');
    if (group === null) return null;
    return {
      label: group.getAttribute('aria-label') ?? '',
      tabs: [...group.querySelectorAll('[data-testid="discover-tab"]')]
        .map((button) => button.getAttribute('data-tab') ?? ''),
    };
  })()`);
    check(
      JSON.stringify(leadingGroup) ===
        JSON.stringify({ label: "Discover sections", tabs: ["overview", "glossary"] }),
      "Overview and Glossary are not the first sidebar entries",
      leadingGroup,
    );
    console.log("PASS discovery-group");
  }

  if (selected("per-agent-prompts")) {
    /* 2. Each card shows, in a source checkout, its own read-only prompt bytes. */
    const expectedPrompts = new Map(
      AGENTS.map((agent) => {
        const file = agent.id === "sheet" ? "discover-sheet.md" : `${agent.id}.md`;
        return [agent.id, readFileSync(join(harnessRoot, "prompts", file), "utf8")];
      }),
    );
    const shown = new Set<string>();
    for (const agent of AGENTS) {
      await openCard(devtools, agent.id);
      await waitFor(
        async () =>
          (await countOf(devtools, "discover-agent-prompt-text")) === 1 ? true : undefined,
        `${agent.id} prompt text`,
        15_000,
      );
      const promptText = await text(devtools, "discover-agent-prompt-text");
      check(
        promptText === expectedPrompts.get(agent.id),
        `the ${agent.id} prompt does not show its file bytes`,
      );
      shown.add(promptText);
      check(
        (await countOf(devtools, "discover-agent-prompt-command")) === 0,
        `the ${agent.id} card still shows its command chip`,
        await text(devtools, "discover-agent-prompt-command"),
      );
      for (const testid of [
        "discover-agent-prompt-editor",
        "discover-agent-prompt-save",
        "discover-agent-prompt-chat-log",
        "discover-agent-prompt-message",
        "discover-agent-prompt-send",
        "discover-agent-prompt-chat-error",
        "discover-agent-prompt-reset",
      ]) {
        check(
          (await countOf(devtools, testid)) === 0,
          `${testid} is rendered on the ${agent.id} card`,
        );
      }
      const chrome = await devtools.evaluate(`(() => {
        const section = document.querySelector('[data-testid="discover-agent-prompt"]');
        return {
          fields: section?.querySelectorAll('textarea, input, [contenteditable], .monaco-editor').length ?? -1,
          tag: section?.querySelector('[data-testid="discover-agent-prompt-text"]')?.tagName ?? '',
          overflow: section === null ? '' :
            getComputedStyle(section.querySelector('[data-testid="discover-agent-prompt-text"]')).overflowY,
          font: section === null ? '' :
            getComputedStyle(section.querySelector('[data-testid="discover-agent-prompt-text"]')).fontFamily,
        };
      })()`);
      check(
        (chrome as Record<string, unknown>).fields === 0 &&
          (chrome as Record<string, unknown>).tag === "PRE" &&
          ["auto", "scroll"].includes(String((chrome as Record<string, unknown>).overflow)) &&
          String((chrome as Record<string, unknown>).font).toLowerCase().includes("mono"),
        `the ${agent.id} prompt is not a scrollable monospace PRE`,
        chrome,
      );
      check(
        (await countOf(devtools, "discover-agent-activity")) === 0,
        `the ${agent.id} card still renders an activity log`,
      );
    }
    check(shown.size === 6, "two cards share one prompt text");
    const promptBytes = PROMPT_FILES.map((file) =>
      readFileSync(join(source, ".devboard", "prompts", file), "utf8"),
    );
    check(
      PROMPT_FILES.every(
        (file, index) =>
          readFileSync(join(source, ".devboard", "prompts", file), "utf8") === promptBytes[index],
      ),
      "opening the cards wrote a prompt file",
    );
    console.log("PASS per-agent-prompts");
  }

  if (selected("run-all-order")) {
    /* 3. Run all runs the six in the fixed order and publishes each slice. */
    check(
      (await countOf(devtools, "discover-run-all")) === 0,
      "the sidebar still carries a Run all control",
    );
    await openOverview(devtools);
    check(
      (await countOf(devtools, "discover-start")) === 1,
      "the Overview page does not carry the Run all control",
    );
    await click(devtools, "discover-start");
    await waitFor(
      async () =>
        (await devtools.evaluate(`(() => {
        const tabs = [...document.querySelectorAll('[data-testid="discover-agent-tab"]')];
        return tabs.every((tab) => tab.getAttribute('data-state') === 'succeeded');
      })()`)) === true
          ? true
          : undefined,
      "all six agents to succeed",
      120_000,
    );
    const orderedPrompts = logPrompts(sourceLog);
    check(
      JSON.stringify(orderedPrompts.map((prompt) => prompt.split(" ")[0])) ===
        JSON.stringify([
          "/discover-sheet",
          "/discover-glossary",
          "/discover-testing-strategy",
          "/discover-naming-conventions",
          "/discover-coding-conventions",
          "/discover-architecture-boundaries",
        ]),
      "Run all did not run the six in the fixed order",
      orderedPrompts.map((prompt) => prompt.split(" ")[0]),
    );
    check(
      existsSync(join(source, ".omp", "discover", "sheet.json")) &&
        existsSync(join(source, ".omp", "discover", "glossary", "orders.glossary.yaml")) &&
        existsSync(join(source, ".omp", "skills", "discover-glossary", "SKILL.md")),
      "Run all did not publish its slices",
    );
    // Every established Discover page keeps its entry and its panel.
    const sections = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="discover-tab"]')
  ].map((button) => button.getAttribute('data-tab') ?? ''))()`);
    check(
      JSON.stringify(sections) ===
        JSON.stringify([
          "overview",
          "glossary",
          "testing-strategy",
          "naming-conventions",
          "coding-conventions",
          "architecture-boundaries",
          "glossary-skill",
        ]),
      "the existing Discover section entries changed after publication",
      sections,
    );
    for (const tab of [
      "overview",
      "glossary",
      "testing-strategy",
      "naming-conventions",
      "coding-conventions",
      "architecture-boundaries",
      "glossary-skill",
    ]) {
      const opened = await devtools.evaluate(`(() => {
      const button = document.querySelector('[data-testid="discover-tab"][data-tab="${tab}"]');
      if (button === null) return false;
      button.click();
      return true;
    })()`);
      check(opened === true, `the ${tab} page entry is missing after publication`);
      await waitFor(
        async () =>
          (await attribute(devtools, "discover-panel", "data-tab")) === tab ? true : undefined,
        `the ${tab} panel`,
        15_000,
      );
    }
    console.log("PASS run-all-order");
  }

  if (selected("per-agent-publication")) {
    /* 4. Each trigger publishes only its own slice. */
    for (const agent of AGENTS) {
      await openCard(devtools, agent.id);
      const before = ompBytes(source);
      const promptsBefore = logPrompts(sourceLog).length;
      await click(devtools, "discover-agent-start");
      // The card still shows the previous success for a moment; the peer's own
      // prompt line is the first proof this trigger started.
      await waitFor(
        async () => (logPrompts(sourceLog).length === promptsBefore + 1 ? true : undefined),
        `the ${agent.id} peer to receive its prompt`,
        30_000,
      );
      await waitStatus(devtools, agent.id, "succeeded");
      const after = ompBytes(source);
      const changed = changedPaths(before, after);
      check(
        otherChanges(changed, agent.id).length === 0,
        `the ${agent.id} trigger changed another agent's artifacts`,
        otherChanges(changed, agent.id),
      );
      const sent = logPrompts(sourceLog).slice(promptsBefore);
      check(
        sent.length === 1 && sent[0]?.startsWith(`${agent.command} `),
        `the ${agent.id} trigger did not send exactly its own prompt`,
        sent,
      );
      const stage = sent[0]?.slice(agent.command.length).trim() ?? "";
      check(
        stage.includes(`${join(source, ".omp", "discover", "staging", "")}`),
        `the ${agent.id} staging directory is not under the target`,
        stage,
      );
      check(
        !existsSync(stage),
        `the ${agent.id} staging directory survived its publication`,
      );
    }
    console.log("PASS per-agent-publication");
  }

  if (selected("one-at-a-time")) {
    /* 5. A second trigger while one runs is refused, and Run all is disabled. */
    const refusalHost = await makeSourceHost(root, "refusal-host");
    const refusal = await startDashboard({
      repoDir: refusalHost,
      stateDir: join(refusalHost, ".devboard", ".tmp", "state"),
      logPath: join(root, "refusal-acp.log"),
      extraStub: ["--discover-delay-ms=4000"],
    });
    pids.push(refusal.process.pid ?? 0);
    await devtools.send("Page.navigate", { url: `http://127.0.0.1:${refusal.port}/` });
    await openDiscoverMode(devtools, "the refusal dashboard");
    await openCard(devtools, "sheet");
    await click(devtools, "discover-agent-start");
    await waitStatus(devtools, "sheet", "running");
    const runningActivity = await devtools.evaluate(
      `document.querySelectorAll('[data-testid="discover-agent-activity"]').length`,
    );
    check(
      runningActivity === 0,
      "a running agent's card still renders an activity log",
      { runningActivity },
    );
    await waitFor(
      async () => (logPrompts(join(root, "refusal-acp.log")).length === 1 ? true : undefined),
      "the refusal peer to start",
      30_000,
    );
    const refused = await wsCommand(
      devtools,
      refusal.port,
      { type: "discoverAgent", agent: "discover-glossary" },
      "discoverError",
    );
    check(
      String(refused.message ?? "").toLowerCase().includes("active"),
      "a second trigger while one runs was not refused",
      refused,
    );
    await openOverview(devtools);
    const runAllDisabled = await devtools.evaluate(
      `document.querySelector('[data-testid="discover-start"]')?.disabled === true`,
    );
    check(runAllDisabled === true, "Run all is enabled while an agent runs");
    console.log("PASS one-at-a-time");
  }

  if (selected("run-all-halt")) {
    /* 6. Run all halts at the first seeded failure and keeps earlier slices. */
    const haltHost = await makeSourceHost(root, "halt-host");
    const haltLog = join(root, "halt-acp.log");
    const halt = await startDashboard({
      repoDir: haltHost,
      stateDir: join(haltHost, ".devboard", ".tmp", "state"),
      logPath: haltLog,
      extraStub: ["--discover-fail-agent=discover-naming-conventions"],
    });
    pids.push(halt.process.pid ?? 0);
    await devtools.send("Page.navigate", { url: `http://127.0.0.1:${halt.port}/` });
    await openDiscoverMode(devtools, "the halt dashboard");
    await openOverview(devtools);
    await click(devtools, "discover-start");
    await waitStatus(devtools, "discover-naming-conventions", "failed");
    const haltedPrompts = logPrompts(haltLog).map((prompt) => prompt.split(" ")[0]);
    check(
      JSON.stringify(haltedPrompts) ===
        JSON.stringify([
          "/discover-sheet",
          "/discover-glossary",
          "/discover-testing-strategy",
          "/discover-naming-conventions",
        ]),
      "Run all did not halt at the first failure",
      haltedPrompts,
    );
    const states = await devtools.evaluate(`(() => Object.fromEntries(
    [...document.querySelectorAll('[data-testid="discover-agent-tab"]')].map((tab) => [
      tab.getAttribute('data-agent') ?? '',
      tab.getAttribute('data-state') ?? '',
    ]),
  ))()`);
    check(
      JSON.stringify(states) ===
        JSON.stringify({
          sheet: "succeeded",
          "discover-testing-strategy": "succeeded",
          "discover-naming-conventions": "failed",
          "discover-coding-conventions": "idle",
          "discover-architecture-boundaries": "idle",
          "discover-glossary": "succeeded",
        }),
      "the halted Run all states are wrong",
      states,
    );
    check(
      existsSync(join(haltHost, ".omp", "skills", "discover-testing-strategy", "SKILL.md")) &&
        !existsSync(join(haltHost, ".omp", "discover", "skills", "discover-naming-conventions")),
      "Run all did not keep the published slices and skip the later agents",
    );
    console.log("PASS run-all-halt");
  }

  if (selected("skill-read-only")) {
    /* 7. The skill page shows the published file as read-only text. */
    await devtools.send("Page.navigate", { url: `http://127.0.0.1:${dashboard.port}/` });
    await openDiscoverMode(devtools, "the source dashboard");
    const skillName = "discover-testing-strategy";
    await waitFor(
      async () =>
        (await devtools.evaluate(
          `document.querySelector('[data-testid="discover-tab"][data-skill="${skillName}"]') !== null`,
        )) === true
          ? true
          : undefined,
      "the published skill entry",
      20_000,
    );
    const opened = await devtools.evaluate(`(() => {
      const button = document.querySelector('[data-testid="discover-tab"][data-skill="${skillName}"]');
      if (button === null) return false;
      button.click();
      return true;
    })()`);
    check(opened === true, "the skill entry is not clickable");
    await waitFor(
      async () =>
        (await countOf(devtools, "discover-skill-text")) === 1 ? true : undefined,
      "the skill text",
      20_000,
    );
    const live = readFileSync(
      join(source, ".omp", "skills", skillName, "SKILL.md"),
      "utf8",
    );
    check(
      (await text(devtools, "discover-skill-text")) === live,
      "the skill page does not show the live file bytes",
    );
    check(
      (await text(devtools, "discover-skill-status")) === "generated",
      "the generated skill status is not named",
      await text(devtools, "discover-skill-status"),
    );
    for (const testid of [
      "discover-skill-save",
      "discover-skill-restore",
      "discover-skill-dirty",
    ]) {
      check(
        (await countOf(devtools, testid)) === 0,
        `${testid} is rendered on the skill page`,
      );
    }
    const skillChrome = await devtools.evaluate(`(() => ({
      fields: document.querySelector('[data-testid="discover-skill-text"]')
        ?.querySelectorAll('textarea, input, [contenteditable], .monaco-editor').length ?? -1,
      tag: document.querySelector('[data-testid="discover-skill-text"]')?.tagName ?? '',
    }))()`);
    check(
      (skillChrome as Record<string, unknown>).fields === 0 &&
        (skillChrome as Record<string, unknown>).tag === "PRE",
      "the skill page holds an editor",
      skillChrome,
    );

    // A live file the manifest reports as edited is rendered as such.
    writeFileSync(
      join(source, ".omp", "skills", skillName, "SKILL.md"),
      `${live}\n- External edit.\n`,
    );
    const manifestPath = join(source, ".omp", "discover", "manifest.json");
    const manifestBefore = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBefore.toString("utf8")) as {
      skills: Array<{ name: string; state: string }>;
    };
    manifest.skills = manifest.skills.map((entry) =>
      entry.name === skillName ? { ...entry, state: "edited" } : entry,
    );
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await devtools.send("Page.reload");
    await openDiscoverMode(devtools, "the reloaded source dashboard");
    await devtools.evaluate(`document.querySelector('[data-testid="discover-tab"][data-skill="${skillName}"]')?.click()`);
    await waitFor(
      async () =>
        (await text(devtools, "discover-skill-status")) === "edited" ? true : undefined,
      "the edited skill status",
      20_000,
    );
    check(
      (await text(devtools, "discover-skill-text")).endsWith("- External edit.\n"),
      "the edited skill text is not shown",
    );

    // The UI wrote nothing: the seeded bytes are the only change, and restoring
    // them leaves the fixture exactly as the tests started.
    writeFileSync(join(source, ".omp", "skills", skillName, "SKILL.md"), live);
    writeFileSync(manifestPath, manifestBefore);
    check(
      readFileSync(join(source, ".omp", "skills", skillName, "SKILL.md"), "utf8") === live &&
        readFileSync(manifestPath).equals(manifestBefore),
      "the read-only skill page wrote a skill file",
    );
    console.log("PASS skill-read-only");
  }

  if (selected("installed-read-only")) {
    /* 8. An installed host renders no prompt editor and refuses a save. */
    const installed = await makeInstalledHost(root, "installed-host");
    const installedPrompts = new Map(
      PROMPT_FILES.map((file) => [
        file,
        readFileSync(join(installed, ".devboard", "prompts", file), "utf8"),
      ]),
    );
    const installedDashboard = await startDashboard({
      repoDir: installed,
      stateDir: join(installed, ".devboard", ".tmp", "state"),
      logPath: join(root, "installed-acp.log"),
    });
    pids.push(installedDashboard.process.pid ?? 0);
    await devtools.send("Page.navigate", { url: `http://127.0.0.1:${installedDashboard.port}/` });
    await openDiscoverMode(devtools, "the installed dashboard");
    for (const agent of AGENTS) {
      await openCard(devtools, agent.id);
      const file = agent.id === "sheet" ? "discover-sheet.md" : `${agent.id}.md`;
      check(
        (await text(devtools, "discover-agent-prompt-text")) ===
          installedPrompts.get(file),
        `the installed ${agent.id} prompt differs`,
      );
      for (const testid of [
        "discover-agent-prompt-editor",
        "discover-agent-prompt-chat-log",
        "discover-agent-prompt-message",
        "discover-agent-prompt-send",
        "discover-agent-prompt-save",
      ]) {
        check(
          (await countOf(devtools, testid)) === 0,
          `${testid} is rendered in an installed host`,
        );
      }
    }
    const refusedSave = await wsCommand(
      devtools,
      installedDashboard.port,
      { type: "saveDiscoverPrompt", agent: "sheet", text: "installed bytes\n" },
      "error",
    );
    check(
      refusedSave.message === "Invalid WebSocket message.",
      "the removed installed save was not refused as unknown",
      refusedSave,
    );
    for (const [file, bytes] of installedPrompts) {
      check(
        readFileSync(join(installed, ".devboard", "prompts", file), "utf8") === bytes,
        `the installed ${file} changed`,
      );
    }
    console.log("PASS installed-read-only");
  }

  check(devtools.errors.length === 0, "the browser reported an error", devtools.errors);

  if (only.size > 0) {
    console.log(`verify:discover: ran only ${[...only].join(", ")}`);
  } else {
    console.log(
      "verify:discover: the six-entry Discovery group, per-agent read-only prompts and " +
        "publication, the one-at-a-time rule, Run all order and stop-at-first-failure, the " +
        "read-only skill page, and the installed prompt and save refusal all hold",
    );
  }
} finally {
  for (const pid of [...pids, chromePid]) {
    if (pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  devtools?.close();
  if (process.env.DISCOVER_VERIFY_KEEP !== "1") {
    await rm(root, { recursive: true, force: true });
  } else {
    console.error(`verify:discover: kept ${root}`);
  }
}
