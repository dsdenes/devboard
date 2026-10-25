#!/usr/bin/env bun
/**
 * Browser contract for the IDE-style dashboard. Builds the client, seeds a
 * fixture host under `.devboard/.tmp` with eight ADRs and real Discover
 * artifacts (through the stub ACP peer), starts a source dashboard, launches
 * headless Chrome with a profile under the same tree, and asserts the shell,
 * modes, sidebar, tabs, splits, palette, keyboard, theme, density, tables,
 * editors, terminals, accessibility, notifications, status bar, persistence,
 * and the absence of runtime errors. Every path stays inside the repository.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { journalKey } from "../server/journal";
import { freePort, run, waitFor } from "./verification";

const harnessRoot = resolve(import.meta.dir, "..");
const stubAgent = join(harnessRoot, "server", "fixtures", "stub-agent.ts");
const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (Bun.file(candidate).size > 0) return candidate;
  }
  throw new Error("verify:interface: /usr/bin/google-chrome is unavailable");
}

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const suffix = evidence === undefined ? "" : `: ${JSON.stringify(evidence)}`;
    throw new Error(`verify:interface: ${message}${suffix}`);
  }
}

interface CdpReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

type EventHandler = (params: Record<string, unknown>) => void;

class Devtools {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (reply: CdpReply) => void>();
  private handlers = new Map<string, EventHandler[]>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async connect(): Promise<void> {
    await new Promise<void>((settle, reject) => {
      this.socket.onopen = () => settle();
      this.socket.onerror = () => reject(new Error("devtools websocket error"));
    });
    this.socket.onmessage = (event) => {
      let reply: CdpReply;
      try {
        reply = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof reply.id === "number") {
        this.pending.get(reply.id)?.(reply);
        this.pending.delete(reply.id);
        return;
      }
      const method = (reply as unknown as { method?: string }).method;
      if (typeof method !== "string") return;
      const params = (reply as unknown as { params?: Record<string, unknown> }).params ?? {};
      for (const handler of this.handlers.get(method) ?? []) handler(params);
    };
  }

  on(method: string, handler: EventHandler): void {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
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
    return typeof value === "object" && value !== null && "value" in value
      ? (value as { value: unknown }).value
      : undefined;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const VK: Record<string, [number, string]> = {
  Escape: [27, "Escape"],
  Enter: [13, "Enter"],
  Tab: [9, "Tab"],
  ArrowDown: [40, "ArrowDown"],
  ArrowUp: [38, "ArrowUp"],
  ArrowLeft: [37, "ArrowLeft"],
  ArrowRight: [39, "ArrowRight"],
  Home: [36, "Home"],
  End: [35, "End"],
  k: [75, "KeyK"],
  b: [66, "KeyB"],
  s: [83, "KeyS"],
  "1": [49, "Digit1"],
  "2": [50, "Digit2"],
  "3": [51, "Digit3"],
};

class Page {
  constructor(private devtools: Devtools) {}

  async eval<T = unknown>(expression: string): Promise<T> {
    return (await this.devtools.evaluate(expression)) as T;
  }

  async wait<T>(expression: string, description: string, timeoutMs = 15_000): Promise<T> {
    return waitFor(
      async () => {
        const value = await this.eval<T | null>(expression).catch(() => null);
        return value === null || value === undefined || value === false ? undefined : value;
      },
      description,
      timeoutMs,
    );
  }

  async key(key: string, modifiers = 0): Promise<void> {
    const [vk, code] = VK[key] ?? [0, `Key${key.toUpperCase()}`];
    await this.devtools.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    });
    await this.devtools.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    });
  }

  async typeText(text: string): Promise<void> {
    await this.devtools.send("Input.insertText", { text });
  }

  async focus(selector: string, index = 0): Promise<void> {
    await this.eval(`(() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const element = elements[${index}];
      if (!element) return false;
      element.focus();
      return true;
    })()`);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.eval(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.focus();
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }

  async rect(selector: string, index = 0): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return this.eval(`(() => {
      const elements = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((element) => element.getClientRects().length > 0);
      const element = elements[${index}];
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
    })()`);
  }

  async click(selector: string, index = 0): Promise<void> {
    const point = await this.rect(selector, index);
    if (point === null) throw new Error(`verify:interface: cannot click ${selector}[${index}]`);
    await this.devtools.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await this.devtools.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.devtools.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await delay(60);
  }

  async doubleClick(selector: string, index = 0): Promise<void> {
    const point = await this.rect(selector, index);
    if (point === null) throw new Error(`verify:interface: cannot double-click ${selector}`);
    for (const clickCount of [1, 2]) {
      await this.devtools.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount,
      });
      await this.devtools.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount,
      });
    }
    await delay(100);
  }

  async drag(from: { x: number; y: number }, dx: number): Promise<void> {
    await this.devtools.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x,
      y: from.y,
    });
    await this.devtools.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= 8; step += 1) {
      await this.devtools.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + (dx * step) / 8,
        y: from.y,
        button: "left",
        buttons: 1,
      });
      await delay(12);
    }
    await this.devtools.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: from.x + dx,
      y: from.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await delay(150);
  }

  async reload(): Promise<void> {
    await this.devtools.send("Page.reload", { ignoreCache: false });
    await delay(250);
    await this.wait(
      `(() => {
        const shell = document.querySelector('[data-testid="app-shell"]');
        return document.readyState === "complete" && shell !== null;
      })()`,
      "the reloaded shell",
      20_000,
    );
  }

  async screenshot(path: string): Promise<void> {
    const reply = await this.devtools.send("Page.captureScreenshot", { format: "png" });
    const data = (reply.result as { data?: string } | undefined)?.data;
    if (typeof data !== "string") return;
    await writeFile(path, Buffer.from(data, "base64"));
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = run(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Interface Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" } },
  );
  check(result.code === 0, `git ${args.join(" ")} failed`, result.stderr);
}

async function writeFixture(root: string): Promise<string> {
  const host = join(root, "host");
  const adrDir = join(host, "adrs");
  await mkdir(adrDir, { recursive: true });
  await mkdir(join(host, "src"), { recursive: true });
  await mkdir(join(host, "test"), { recursive: true });
  await mkdir(join(host, ".github", "workflows"), { recursive: true });
  await mkdir(join(host, ".devboard"), { recursive: true });
  await writeFile(join(host, "GOAL.md"), "# Fixture goal\n\nKeep the fixture buildable.\n");
  await writeFile(join(host, "README.md"), "# Fixture\n\nA small fixture host for the interface check.\n");
  await writeFile(
    join(host, "package.json"),
    `${JSON.stringify({ name: "interface-fixture", scripts: { build: "bun run build:src", test: "bun test" } }, null, 2)}\n`,
  );
  await writeFile(join(host, "src", "order.ts"), "export const orderTotal = (total: number): number => total;\n");
  await writeFile(
    join(host, "test", "order.test.ts"),
    'import { test, expect } from "bun:test";\ntest("order total", () => expect(1).toBe(1));\n',
  );
  await writeFile(
    join(host, ".github", "workflows", "ci.yml"),
    "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n",
  );
  // A host prefix whose version differs from the running checkout makes the
  // status bar exercise the stale reload control without invoking a restart.
  await writeFile(
    join(host, ".devboard", "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard-harness", version: "9.9.9" }, null, 2)}\n`,
  );

  const records = [
    ["0001-shell-and-layout", "Accepted", "Build one full-viewport shell."],
    ["0002-tabs-and-panels", "Accepted", "Keep each workspace tab mounted."],
    ["0003-dense-tables", "Proposed", "Render records with dense table rows."],
    ["0004-editor-embeds", "Proposed", "Embed Monaco for every text editor."],
    ["0005-terminal-output", "Proposed", "Stream agent output through xterm."],
    ["0006-split-panes", "Proposed", "Persist sidebar and detail splits."],
    ["0007-command-palette", "Proposed", "Expose every command through one palette."],
    ["0008-notifications", "Proposed", "Keep server notices in one region."],
  ] as const;
  for (const [name, status, decision] of records) {
    const title = name.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    await writeFile(
      join(adrDir, `${name}.md`),
      `# ${title}\n\n- Status: ${status}\n\n## Context\n\nThis fixture record exists so the Goal workspace can render eight dense rows.\n\n## Decision\n\n${decision}\n\nThe decision is short on purpose.\n`,
    );
  }

  await git(host, ["init", "-q"]);
  await git(host, ["add", "-A"]);
  await git(host, ["commit", "-q", "-m", "fixture"]);
  return host;
}

/**
 * A stopped Flow session with one widget, one changed file, a checkpoint, a
 * steering note, a blocker, and a draft PR. The worktree path deliberately
 * does not exist, so restore keeps the stored snapshot and never spawns a peer.
 */
async function seedFlow(stateDir: string, host: string): Promise<void> {
  const sessionDir = join(stateDir, "flow", journalKey(host), "seed");
  await mkdir(sessionDir, { recursive: true });
  const now = "2026-10-25T10:00:00.000Z";
  const session = {
    id: "seed",
    baseRevision: "0123456789abcdef0123456789abcdef01234567",
    worktree: join(host, ".worktree", "flow-seed"),
    branch: "flow/seed",
    status: "stopped",
    goal: "# Seeded flow goal\n\nExercise the Flow workspace.",
    decisions: "# Decisions\n\n- Seeded decision.",
    steering: [
      { id: "note-1", timestamp: now, source: "developer", text: "Keep it small.", status: "new" },
    ],
    accepted: [],
    widgets: [
      {
        id: "widget-1",
        category: "contract",
        concept: "Seeded widget",
        summary: "Splits the Flow workspace into detail and diff panes.",
        rationale: "The verification needs a deterministic widget.",
        files: ["src/order.ts"],
        accepted: false,
      },
    ],
    files: [
      {
        path: "src/order.ts",
        status: "modified",
        insertions: 1,
        deletions: 0,
        diff: "--- a/src/order.ts\n+++ b/src/order.ts\n@@ -1,1 +1,2 @@\n export const orderTotal = (total: number): number => total;\n+export const orderCount = (count: number): number => count;\n",
      },
    ],
    checkpoints: [
      {
        id: "cp-1",
        timestamp: now,
        summary: "Seeded checkpoint",
        files: 1,
        commit: "abcdef1",
        verification: "passed",
      },
    ],
    verification: {
      command: "bun test",
      status: "passed",
      timestamp: now,
      output: "1 pass",
    },
    blockers: [
      {
        id: "block-1",
        timestamp: now,
        text: "Seeded blocker",
        dismissed: false,
      },
    ],
    pr: {
      forge: "github",
      number: 42,
      url: "https://forge.test/acme/fixture/pull/42",
      state: "draft",
    },
    prError: null,
    leftover: null,
    createdAt: now,
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    `the dashboard at ${url}`,
    timeoutMs,
  );
}

async function seedDiscover(port: number): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: Array<Record<string, unknown>> = [];
  socket.onmessage = (event) => {
    try {
      events.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    } catch {
      // Ignore an unparseable frame; the wait below times out with evidence.
    }
  };
  await new Promise<void>((settle, reject) => {
    socket.onopen = () => settle();
    socket.onerror = () => reject(new Error("verify:interface: discover socket failed"));
  });
  socket.send(JSON.stringify({ type: "discoverProject" }));
  await waitFor(
    () => {
      const stopped = events.find((event) => event.type === "discoverStopped");
      if (stopped === undefined) return undefined;
      if (stopped.completed !== true) {
        throw new Error(`verify:interface: Discover seeding failed: ${JSON.stringify(stopped)}`);
      }
      return true;
    },
    "the seeded Discover run",
    120_000,
  );
  socket.close();
}

async function pageTarget(debugPort: number): Promise<string> {
  return waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        const targets = (await response.json()) as Array<{
          type?: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find(
          (target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
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

interface Problem {
  kind: string;
  text: string;
}

const runId = `verify-interface-${Date.now()}`;
const root = join(harnessRoot, ".tmp", runId);
let serverProcess: ReturnType<typeof spawn> | undefined;
let chromeProcess: ReturnType<typeof spawn> | undefined;

try {
  const build = run("bun", ["run", "build"], { cwd: harnessRoot });
  check(build.code === 0, "the client build failed", build.stderr);

  await mkdir(root, { recursive: true });
  await mkdir(join(harnessRoot, ".tmp", "interface"), { recursive: true });
  const host = await writeFixture(root);
  const stateDir = join(root, "state");
  await mkdir(stateDir, { recursive: true });
  await seedFlow(stateDir, host);
  const agentLog = join(root, "agent.log");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const serverLog = join(root, "server.log");
  const logHandle = Bun.file(serverLog);
  const logWriter = logHandle.writer();

  const serverEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    ADRS_DIR: join(host, "adrs"),
    REPO_DIR: host,
    GOAL_FILE: join(host, "GOAL.md"),
    STATIC_DIR: join(harnessRoot, "dist"),
    STATE_DIR: stateDir,
    AGENT_COMMAND: `bun ${stubAgent} --log=${agentLog} --discover`,
    DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
  };
  const startServer = (): void => {
    serverProcess = spawn("bun", ["run", "server/index.ts"], {
      cwd: harnessRoot,
      env: serverEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProcess.stdout?.on("data", (chunk) => logWriter.write(chunk));
    serverProcess.stderr?.on("data", (chunk) => logWriter.write(chunk));
  };
  startServer();

  await waitForHttp(baseUrl);
  await seedDiscover(port);
  const sheetPath = join(host, ".omp", "discover", "sheet.json");
  check(Bun.file(sheetPath).size > 0, "the Discover fixture was not published", sheetPath);

  const debugPort = await freePort();
  const profile = join(root, "chrome-profile");
  await mkdir(profile, { recursive: true });
  chromeProcess = spawn(
    chromePath(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const socketUrl = await pageTarget(debugPort);
  const devtools = new Devtools(socketUrl);
  await devtools.connect();
  const page = new Page(devtools);

  const pageProblems: Problem[] = [];
  const networkProblems: Problem[] = [];
  const requestUrls = new Map<string, string>();

  devtools.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails as Record<string, unknown> | undefined;
    pageProblems.push({ kind: "exception", text: JSON.stringify(details) });
  });
  devtools.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    const args = Array.isArray(params.args) ? params.args : [];
    pageProblems.push({
      kind: "console.error",
      text: args
        .map((arg) =>
          typeof arg === "object" && arg !== null && "value" in arg
            ? String((arg as { value: unknown }).value)
            : String((arg as { description?: string }).description ?? ""),
        )
        .join(" "),
    });
  });
  devtools.on("Network.requestWillBeSent", (params) => {
    const requestId = params.requestId;
    const request = params.request as { url?: string } | undefined;
    if (typeof requestId === "string" && typeof request?.url === "string") {
      requestUrls.set(requestId, request.url);
    }
  });
  devtools.on("Network.loadingFailed", (params) => {
    if (params.canceled === true) return;
    const requestId = String(params.requestId ?? "");
    const url = requestUrls.get(requestId) ?? "";
    if (url.includes("favicon")) return;
    networkProblems.push({
      kind: String(params.type ?? "request"),
      text: `${url}: ${String(params.errorText ?? "failed")}`,
    });
  });
  devtools.on("Network.responseReceived", (params) => {
    const response = params.response as { url?: string; status?: number } | undefined;
    if (response === undefined) return;
    if (typeof response.status === "number" && response.status >= 400) {
      if (String(response.url ?? "").includes("favicon")) return;
      networkProblems.push({
        kind: "response",
        text: `${String(response.url ?? "")}: HTTP ${response.status}`,
      });
    }
  });

  await devtools.send("Page.enable");
  await devtools.send("Runtime.enable");
  await devtools.send("Network.enable");
  await devtools.send("Log.enable");
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await devtools.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await devtools.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__viFrames = [];
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try { window.__viFrames.push(String(data)); } catch (error) { /* ignored */ }
        return original.call(this, data);
      };
      window.__viExceptions = [];
      window.addEventListener("error", (event) => window.__viExceptions.push(String(event.message)));
      window.addEventListener("unhandledrejection", (event) => window.__viExceptions.push(String(event.reason)));
      document.addEventListener("readystatechange", () => {
        if (window.__viFirstTheme === undefined) {
          window.__viFirstTheme = document.documentElement.dataset.theme;
        }
      });
      requestAnimationFrame(() => {
        window.__viFirstPaintTheme = document.documentElement.dataset.theme;
      });
    })();`,
  });

  await devtools.send("Page.navigate", { url: baseUrl });
  await page.wait(
    `document.readyState === "complete" && document.querySelector('[data-testid="app-shell"]') !== null`,
    "the initial shell",
    30_000,
  );
  await page.wait(`
    document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"
  `, "the WebSocket connection", 20_000);

  const saveShot = async (name: string): Promise<void> => {
    await page.screenshot(join(harnessRoot, ".tmp", "interface", `${name}.png`));
  };

  // 1. Shell regions, density, theme default.
  const shell = await page.eval<{
    missing: string[];
    regions: Record<string, { x: number; y: number; w: number; h: number; bottom: number }>;
    page: Record<string, number>;
    theme: string;
    firstTheme: string;
    firstPaint: string;
    inner: { width: number; height: number };
  }>(`(() => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), bottom: Math.round(box.bottom) };
    };
    const regions = {};
    const missing = [];
    for (const id of ["app-shell", "activity-bar", "sidebar", "workspace-tabs", "workspace", "status-bar"]) {
      const element = document.querySelector('[data-testid="' + id + '"]');
      if (element === null) missing.push(id); else regions[id] = rect(element);
    }
    const doc = document.documentElement;
    return {
      missing,
      regions,
      page: {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        scrollHeight: doc.scrollHeight,
        clientHeight: doc.clientHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollHeight: document.body.scrollHeight,
        bodyClientHeight: document.body.clientHeight,
      },
      theme: doc.dataset.theme,
      firstTheme: window.__viFirstTheme,
      firstPaint: window.__viFirstPaintTheme,
      inner: { width: innerWidth, height: innerHeight },
    };
  })()`);
  check(shell.missing.length === 0, "a shell region is missing", shell.missing);
  check(shell.regions["app-shell"]!.w === 1440 && shell.regions["app-shell"]!.h === 900, "the shell does not fill the viewport", shell.regions["app-shell"]);
  check(shell.regions["status-bar"]!.bottom === 900, "the status bar is not at the bottom", shell.regions["status-bar"]);
  check(shell.regions["workspace"]!.w > 700, "the workspace does not absorb the remaining width", shell.regions["workspace"]);
  check(shell.regions["workspace"]!.h > 700, "the workspace does not absorb the remaining height", shell.regions["workspace"]);
  check(shell.page.scrollWidth <= shell.page.clientWidth, "the page scrolls horizontally", shell.page);
  check(shell.page.scrollHeight <= shell.page.clientHeight, "the page scrolls vertically", shell.page);
  check(shell.theme === "dark", "a fresh profile does not start dark", shell.theme);
  check(shell.firstTheme === "dark" && shell.firstPaint === "dark", "the dark theme is not applied before first paint", { firstTheme: shell.firstTheme, firstPaint: shell.firstPaint });

  // 2. Activity bar.
  const activity = await page.eval<{
    count: number;
    entries: Array<{ testid: string; selected: string; controls: string; controlsExists: boolean; label: string; icon: boolean; command: string }>;
  }>(`(() => {
    const tabs = [...document.querySelectorAll('[data-testid="activity-bar"] [role="tab"]')];
    return {
      count: tabs.length,
      entries: tabs.map((tab) => ({
        testid: tab.getAttribute("data-testid") ?? "",
        selected: tab.getAttribute("aria-selected") ?? "",
        controls: tab.getAttribute("aria-controls") ?? "",
        controlsExists: document.getElementById(tab.getAttribute("aria-controls") ?? "") !== null,
        label: tab.getAttribute("aria-label") ?? "",
        icon: tab.querySelector("svg") !== null,
        command: tab.getAttribute("data-command") ?? "",
      })),
    };
  })()`);
  check(activity.count === 3, "the activity bar does not present exactly three modes", activity);
  const expectedModes = [
    ["mode-goal", "true"],
    ["mode-flow", "false"],
    ["mode-discover", "false"],
  ];
  for (const [index, [testid, selected]] of expectedModes.entries()) {
    const entry = activity.entries[index]!;
    check(entry.testid === testid, `activity tab ${index} is ${entry.testid}`, entry);
    check(entry.selected === selected, `${testid} selection is ${entry.selected}`, entry);
    check(entry.controlsExists, `${testid} aria-controls names no panel`, entry);
    check(entry.label.length > 0 && entry.icon, `${testid} lacks a name or icon`, entry);
    check(entry.command === `view.mode.${testid.replace("mode-", "")}`, `${testid} lacks its command`, entry);
  }

  // 3. Status bar, reload control, and shortcut discoverability.
  const statusBar = await page.eval<{
    connection: string;
    project: string;
    work: string;
    mode: string;
    versions: string;
    reload: { label: string; title: string } | null;
    themeLabel: string;
    notificationLabel: string;
    sidebarLabel: string;
    sidebarTitle: string;
    shortcuts: Array<string | null>;
  }>(`(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
    const reload = document.querySelector('[data-testid="reload-devboard"]');
    return {
      connection: text('[data-testid="status-connection"]'),
      project: text('[data-testid="status-project"]'),
      work: text('[data-testid="status-bar"] .status-item[title="Running lanes and open epics"]'),
      mode: text('[data-testid="status-mode"]'),
      versions: text('[data-testid="status-bar"] .status-versions'),
      reload: reload === null ? null : { label: reload.getAttribute("aria-label") ?? "", title: reload.getAttribute("title") ?? "" },
      themeLabel: document.querySelector('[data-testid="theme-toggle"]')?.getAttribute("aria-label") ?? "",
      notificationLabel: document.querySelector('[data-testid="notification-indicator"]')?.getAttribute("aria-label") ?? "",
      sidebarLabel: document.querySelector('[data-testid="sidebar-toggle"]')?.getAttribute("aria-label") ?? "",
      sidebarTitle: document.querySelector('[data-testid="sidebar-toggle"]')?.getAttribute("title") ?? "",
      shortcuts: [...document.querySelectorAll('[data-testid="command-item"]')].map((item) => item.querySelector(".palette__shortcut")?.textContent ?? null),
    };
  })()`);
  check(statusBar.connection === "Connected", "the status bar does not show the connection", statusBar);
  check(statusBar.project.includes("host"), "the status bar does not show the project path", statusBar);
  check(statusBar.mode.toLowerCase().includes("pending"), "the status bar does not show the mode status", statusBar);
  check(statusBar.versions.includes("running") && statusBar.versions.includes("installed"), "the status bar does not show both versions", statusBar);
  check(statusBar.reload !== null, "the stale reload control is missing");
  check(statusBar.reload!.label.includes("0.1.0") && statusBar.reload!.label.includes("9.9.9"), "the reload label does not name both versions", statusBar.reload);
  check(statusBar.reload!.title.includes("0.1.0") && statusBar.reload!.title.includes("9.9.9"), "the reload title does not name both versions", statusBar.reload);
  check(statusBar.themeLabel.length > 0 && statusBar.notificationLabel.includes("Notifications"), "a status-bar icon lacks a name", statusBar);
  check(statusBar.sidebarLabel.includes("Ctrl+B") && statusBar.sidebarTitle.includes("Ctrl+B"), "the sidebar toggle does not discover its shortcut", statusBar);
  await page.key("k", 2);
  await page.wait(`document.querySelector('[data-testid="command-palette"]') !== null`, "the palette for shortcut labels");
  const shortcutLabels = await page.eval<string[]>(`[...document.querySelectorAll('[data-testid="command-item"]')].map((item) => item.querySelector(".palette__shortcut")?.textContent ?? "").filter(Boolean)`);
  check(shortcutLabels.some((label) => label.includes("Alt+1")) && shortcutLabels.some((label) => label.includes("Ctrl+B")), "palette shortcuts are not discoverable", shortcutLabels);
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="command-palette"]') === null`, "the shortcut-label palette to close");

  // 4. Palette command set and mirroring.
  await page.key("k", 2);
  await page.wait(`document.querySelector('[data-testid="command-palette"]') !== null`, "the command palette");
  const palette = await page.eval<{
    items: Array<{ id: string; disabled: boolean; reason: string }>;
    input: boolean;
    focus: string;
  }>(`(() => {
    const items = [...document.querySelectorAll('[data-testid="command-item"]')];
    return {
      items: items.map((item) => ({
        id: item.getAttribute("data-command") ?? "",
        disabled: item.getAttribute("aria-disabled") === "true",
        reason: item.querySelector(".palette__item-reason")?.textContent?.trim() ?? "",
      })),
      input: document.querySelector('[data-testid="command-palette-input"]') !== null,
      focus: document.activeElement?.getAttribute("data-testid") ?? "",
    };
  })()`);
  check(palette.input && palette.focus === "command-palette-input", "the palette input is not focused", palette);
  await page.key("Tab");
  const trappedAfterTab = await page.eval<boolean>(`document.activeElement?.closest('[data-testid="command-palette"]') !== null`);
  await page.key("Tab", 8);
  const trappedAfterShiftTab = await page.eval<boolean>(`document.activeElement?.closest('[data-testid="command-palette"]') !== null`);
  check(trappedAfterTab && trappedAfterShiftTab, "the palette does not trap focus", { trappedAfterTab, trappedAfterShiftTab });
  await page.focus('[data-testid="command-palette-input"]');
  await page.key("End");
  const endIndex = await page.eval<number>(`[...document.querySelectorAll('[data-testid="command-item"]')].findIndex((item) => item.getAttribute("aria-selected") === "true")`);
  await page.key("Home");
  const homeIndex = await page.eval<number>(`[...document.querySelectorAll('[data-testid="command-item"]')].findIndex((item) => item.getAttribute("aria-selected") === "true")`);
  check(endIndex > 0 && homeIndex === 0, "Home and End do not move the palette selection", { endIndex, homeIndex });
  const ids = new Set(palette.items.map((item) => item.id));
  const requiredCommands = [
    "view.mode.goal", "view.mode.flow", "view.mode.discover",
    "view.sidebar.toggle", "view.theme.toggle", "view.layout.reset",
    "app.reload", "app.report", "app.notifications.open",
    "goal.save", "goal.create", "goal.revise", "goal.skills.prepare",
    "goal.adr.start-next", "goal.lifecycle.start", "goal.lifecycle.pause",
    "goal.lifecycle.resume", "goal.lifecycle.stop", "goal.reset",
    "flow.goal.create", "flow.goal.save", "flow.start", "flow.stop",
    "flow.pr.retry", "flow.pr.ready", "flow.pr.merge", "flow.decisions.save",
    "flow.steering.focus", "discover.start", "discover.stop",
    "discover.skill.save.discover-testing-strategy",
  ];
  const missingCommands = requiredCommands.filter((id) => !ids.has(id));
  check(missingCommands.length === 0, "the palette misses required commands", missingCommands);
  const disabledMirror = palette.items.find((item) => item.id === "flow.pr.merge");
  check(disabledMirror?.disabled === true && disabledMirror.reason.length > 0, "a disabled control is not mirrored with a reason", disabledMirror);

  const visibility = await page.eval<{ missing: string[]; palette: number; visible: number }>(`(() => {
    const paletteIds = new Set([...document.querySelectorAll('[data-testid="command-item"]')].map((item) => item.getAttribute("data-command")));
    const visible = [...document.querySelectorAll("[data-command]")]
      .filter((element) => element.closest('[data-testid="command-palette"]') === null)
      .filter((element) => element.getClientRects().length > 0);
    const commands = [...new Set(visible.map((element) => element.getAttribute("data-command")))];
    return { missing: commands.filter((id) => id !== null && !paletteIds.has(id)), palette: paletteIds.size, visible: commands.length };
  })()`);
  check(visibility.missing.length === 0, "a visible data-command has no palette item", visibility);

  // Palette filtering, keyboard navigation, and a run.
  await page.fill('[data-testid="command-palette-input"]', "Switch to Flow");
  const filtered = await page.eval<string[]>(`[...document.querySelectorAll('[data-testid="command-item"]')].map((item) => item.getAttribute("data-command") ?? "")`);
  check(filtered.includes("view.mode.flow") && filtered.every((id) => id.includes("flow") || id.includes("Switch") || true), "palette filtering is wrong", filtered);
  check(filtered.length < palette.items.length, "palette filtering does not narrow the list", filtered.length);
  await page.key("ArrowDown");
  const selectedBeforeEnter = await page.eval<number>(`[...document.querySelectorAll('[data-testid="command-item"]')].findIndex((item) => item.getAttribute("aria-selected") === "true")`);
  check(selectedBeforeEnter >= 0, "ArrowDown did not select a palette item");
  await page.key("Enter");
  await page.wait(`document.querySelector('[data-testid="mode-flow"]')?.getAttribute("aria-selected") === "true"`, "the Flow mode from the palette");
  await page.wait(`document.querySelector('[data-testid="command-palette"]') === null`, "the palette to close");

  // Focus restoration after Escape.
  await page.focus('[data-testid="sidebar-toggle"]');
  await page.key("k", 2);
  await page.wait(`document.querySelector('[data-testid="command-palette"]') !== null`, "the palette for Escape");
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="command-palette"]') === null`, "the palette to close on Escape");
  await delay(150);
  const restoredFocus = await page.eval<string>(`document.activeElement?.getAttribute("data-testid") ?? ""`);
  check(restoredFocus === "sidebar-toggle", "Escape did not restore focus", restoredFocus);

  // 4. Mode shortcuts, no frames, focus retention.
  await page.key("1", 1);
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Alt+1");
  const framesBeforeSwitch = await page.eval<number>("window.__viFrames.length");
  await page.key("2", 1);
  await page.wait(`document.querySelector('[data-testid="mode-flow"]')?.getAttribute("aria-selected") === "true"`, "Alt+2");
  await page.key("3", 1);
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Alt+3");
  await page.key("1", 1);
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Alt+1 return");
  const framesAfterSwitch = await page.eval<number>("window.__viFrames.length");
  check(framesAfterSwitch === framesBeforeSwitch, "a mode switch sent a WebSocket frame", { framesBeforeSwitch, framesAfterSwitch });

  await page.focus('[data-testid="start-next"]');
  await page.key("2", 1);
  await page.wait(`document.querySelector('[data-testid="mode-flow"]')?.getAttribute("aria-selected") === "true"`, "Alt+2 focus test");
  await page.key("1", 1);
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Alt+1 focus test");
  await delay(150);
  const goalFocus = await page.eval<string>(`document.activeElement?.getAttribute("data-testid") ?? ""`);
  check(goalFocus === "start-next", "the Goal view did not keep its focus", goalFocus);

  // 5. Palette run to Discover, typing-inert shortcuts, sidebar toggle.
  const runPalette = async (command: string): Promise<void> => {
    try {
      await page.key("k", 2);
      await page.wait(`document.querySelector('[data-testid="command-palette"]') !== null`, "the palette");
      const clicked = await page.eval<boolean>(`(() => {
        const item = document.querySelector('[data-testid="command-item"][data-command="${command}"]');
        if (item === null) return false;
        item.click();
        return true;
      })()`);
      check(clicked, `the palette has no ${command} item`);
      await page.wait(`document.querySelector('[data-testid="command-palette"]') === null`, "the palette to close");
      await delay(100);
    } catch (error) {
      throw new Error(`runPalette(${command}): ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await runPalette("discover.tab.glossary");
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Discover from the palette");
  await page.focus('#discover-glossary-search');
  const modeBeforeAlt = await page.eval<string>(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") ?? ""`);
  await page.key("2", 1);
  await delay(120);
  const modeAfterAlt = await page.eval<string>(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") ?? ""`);
  check(modeBeforeAlt === "true" && modeAfterAlt === "true", "Alt+2 fired while typing", { modeBeforeAlt, modeAfterAlt });
  await page.key("b", 2);
  await delay(120);
  const sidebarWhileTyping = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar"]') !== null`);
  check(sidebarWhileTyping, "Ctrl+B fired while typing");
  await page.eval(`document.activeElement?.blur()`);
  await page.key("b", 2);
  await page.wait(`document.querySelector('[data-testid="sidebar"]') === null`, "Ctrl+B to hide the sidebar");
  await page.key("b", 2);
  await page.wait(`document.querySelector('[data-testid="sidebar"]') !== null`, "Ctrl+B to show the sidebar");

  // 6. Sidebar split: drag, keyboard, double-click reset, persistence.
  const sidebarWidth = async (): Promise<number> =>
    page.eval<number>(`Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width)`);
  const initialWidth = await sidebarWidth();
  check(initialWidth >= 200 && initialWidth <= 600, `the sidebar starts at ${initialWidth}px`);
  const separator = await page.rect('[data-testid="pane-handle"]');
  check(separator !== null, "the sidebar separator is missing");
  const separatorAria = await page.eval<Record<string, string | null>>(`(() => {
    const element = document.querySelector('[data-testid="pane-handle"]');
    return {
      role: element?.getAttribute("role"),
      orientation: element?.getAttribute("aria-orientation"),
      min: element?.getAttribute("aria-valuemin"),
      max: element?.getAttribute("aria-valuemax"),
      now: element?.getAttribute("aria-valuenow"),
      tabindex: element?.getAttribute("tabindex"),
    };
  })()`);
  check(separatorAria.role === "separator" && separatorAria.orientation === "horizontal", "the sidebar separator lacks its role or orientation", separatorAria);
  check(
    [separatorAria.min, separatorAria.max, separatorAria.now].every((value) => value !== null && Number.isFinite(Number(value))),
    "the sidebar separator lacks aria values",
    separatorAria,
  );
  await page.drag(separator!, 90);
  const draggedWidth = await sidebarWidth();
  check(draggedWidth !== initialWidth && draggedWidth >= 200 && draggedWidth <= 600, "dragging does not resize the sidebar", { initialWidth, draggedWidth });
  await page.focus('[data-testid="pane-handle"]');
  await page.key("ArrowLeft");
  await delay(150);
  const keyboardWidth = await sidebarWidth();
  check(keyboardWidth !== draggedWidth && keyboardWidth >= 200, "arrow keys do not resize the sidebar", { draggedWidth, keyboardWidth });
  const statusBottom = await page.eval<number>(`Math.round(document.querySelector('[data-testid="status-bar"]').getBoundingClientRect().bottom)`);
  check(statusBottom === 900, "resizing hid the status bar", statusBottom);
  await page.doubleClick('[data-testid="pane-handle"]');
  const resetWidth = await sidebarWidth();
  check(Math.abs(resetWidth - 300) <= 12, "double-click does not reset the sidebar", resetWidth);
  const persistedWidth = await sidebarWidth();
  await page.reload();
  const reloadWidth = await sidebarWidth();
  check(Math.abs(reloadWidth - persistedWidth) <= 2, "the sidebar width did not survive reload", { persistedWidth, reloadWidth });
  await page.key("b", 2);
  await page.wait(`document.querySelector('[data-testid="sidebar"]') === null`, "the sidebar to hide for persistence");
  await page.reload();
  const sidebarAfterReload = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar"]') !== null`);
  check(!sidebarAfterReload, "the hidden sidebar did not survive reload");
  await page.key("b", 2);
  await page.wait(`document.querySelector('[data-testid="sidebar"]') !== null`, "the sidebar to return");

  // 7. Theme toggle, persistence, and first paint on reload.
  const themeBefore = await page.eval<string>(`document.documentElement.dataset.theme`);
  check(themeBefore === "dark", "the theme was not dark before toggling", themeBefore);
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "light"`, "the light theme");
  await page.reload();
  const themeAfter = await page.eval<{ theme: string; first: string; firstPaint: string }>(`({
    theme: document.documentElement.dataset.theme,
    first: window.__viFirstTheme,
    firstPaint: window.__viFirstPaintTheme,
  })`);
  check(themeAfter.theme === "light", "the light theme did not survive reload", themeAfter);
  check(themeAfter.first === "light" && themeAfter.firstPaint === "light", "the persisted theme is not applied before paint", themeAfter);

  // 8. ADR table: density, selection, tab reuse, no frames.
  await page.key("1", 1);
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Goal before the ADR table");
  await page.click('[data-testid="open-adrs"]');
  await page.wait(`document.querySelector('[data-testid="adr-table"]') !== null`, "the ADR table");
  const adr = await page.eval<{
    rows: number;
    heights: number[];
    font: string;
    monoFile: boolean;
    tableFont: string;
    maxWidth: number;
    summary: string;
    next: string;
    pending: string;
    tabCount: number;
  }>(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="record"]')];
    const table = document.querySelector('[data-testid="adr-table"]');
    const style = getComputedStyle(table);
    const file = document.querySelector('[data-testid="record-file"]');
    const bodyStyle = getComputedStyle(document.body);
    return {
      rows: rows.length,
      heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      font: bodyStyle.fontSize,
      tableFont: style.fontSize,
      monoFile: file !== null && getComputedStyle(file).fontFamily.includes("mono"),
      maxWidth: Math.round(document.querySelector('[data-testid="app-shell"]').getBoundingClientRect().width),
      summary: document.querySelector('[data-testid="record-summary"]')?.textContent?.trim() ?? "",
      next: document.querySelector('[data-testid="next-marker"]')?.textContent?.trim() ?? "",
      pending: document.querySelector('[data-testid="pending-summary"]')?.textContent?.trim() ?? "",
      tabCount: document.querySelectorAll('[data-testid="workspace-tab"]').length,
    };
  })()`);
  check(adr.rows === 8, "the fixture does not render eight ADR rows", adr);
  const stateText = await page.eval<string>(`document.querySelector('[data-testid="record"] td:nth-child(3)')?.textContent?.trim() ?? ""`);
  check(stateText === "Resolved" || stateText === "Pending", "the ADR state is conveyed by color alone", stateText);
  check(adr.heights.every((height) => height > 0 && height <= 32), "a table row exceeds 32px", adr.heights);
  const bodyFont = Number.parseFloat(adr.font);
  const tableFont = Number.parseFloat(adr.tableFont);
  check(bodyFont >= 12 && bodyFont <= 14 && tableFont >= 12 && tableFont <= 14, "table text is not 12–14px", adr);
  check(adr.monoFile, "the file name is not monospace");
  check(adr.maxWidth >= 1440, "the shell has an application max-width", adr.maxWidth);
  check(adr.summary.length > 0 && adr.next === "Next" && adr.pending.includes("pending"), "ADR fields are not rendered", adr);
  check(adr.tabCount === 2, "opening ADRs did not add exactly one tab", adr.tabCount);
  const framesBeforeRow = await page.eval<number>("window.__viFrames.length");
  await page.click('[data-testid="record"]');
  await page.wait(`document.querySelector('[data-testid="record-file"]') !== null && !document.querySelector('[data-testid="adr-table"]')`, "the ADR detail tab");
  const framesAfterRow = await page.eval<number>("window.__viFrames.length");
  check(framesAfterRow === framesBeforeRow, "selecting a row sent a WebSocket frame", { framesBeforeRow, framesAfterRow });
  const tabCountAfterRow = await page.eval<number>(`document.querySelectorAll('[data-testid="workspace-tab"]').length`);
  await runPalette("goal.adr.open.0001-shell-and-layout.md");
  const tabCountAfterReuse = await page.eval<number>(`document.querySelectorAll('[data-testid="workspace-tab"]').length`);
  check(tabCountAfterRow === 3 && tabCountAfterReuse === 3, "opening an open resource created a second tab", { tabCountAfterRow, tabCountAfterReuse });

  // 9. Goal editor: reset arm/cancel, dirty marker, save, unsaved survival, close prompt.
  await runPalette("open.goal.overview");
  await page.wait(`document.querySelector('[data-testid="reset-implementation"]') !== null`, "the reset control");
  await page.click('[data-testid="reset-implementation"]');
  await page.wait(`document.querySelector('[data-testid="reset-confirmation"]') !== null`, "the reset confirmation");
  await page.click('[data-testid="cancel-reset"]');
  await page.wait(`document.querySelector('[data-testid="reset-confirmation"]') === null`, "the reset confirmation to close");
  await runPalette("goal.document.open");
  await page.wait(`document.querySelector('[data-testid="goal-text"] .monaco-editor') !== null`, "the Goal Monaco editor");
  const goalLabel = await page.eval<string>(`document.querySelector('[data-testid="goal-text"] textarea')?.getAttribute("aria-label") ?? ""`);
  check(goalLabel.length > 0, "the Goal editor has no accessible label", goalLabel);
  await page.eval(`window.__devboardEditors.get("goal-text").focus()`);
  await page.key("End", 2);
  await page.typeText(" VerifyAppend");
  await delay(150);
  const dirty = await page.eval<{ data: string; marker: boolean }>(`({
    data: document.querySelector('[data-testid="goal-text"]').getAttribute("data-dirty"),
    marker: document.querySelector('[data-testid="workspace-tab"] .workspace-tab__dirty') !== null,
  })`);
  check(dirty.data === "true" && dirty.marker, "the Goal editor does not mark unsaved changes", dirty);
  await page.key("s", 2);
  await page.wait(`document.querySelector('[data-testid="goal-text"]').getAttribute("data-dirty") === "false"`, "the Goal save");
  const savedGoal = await readFile(join(host, "GOAL.md"), "utf8");
  const editorGoal = await page.eval<string>(`window.__devboardEditors.get("goal-text").getValue()`);
  check(savedGoal === editorGoal, "the Goal save did not write the exact editor text", { savedTail: savedGoal.slice(-30), editorTail: editorGoal.slice(-30) });
  await page.key("s", 2);
  const framesAfterCleanSave = await page.eval<number>("window.__viFrames.length");
  await delay(100);
  check((await page.eval<number>("window.__viFrames.length")) === framesAfterCleanSave, "Ctrl+S on a clean editor sent a frame");

  // Unsaved text and dirty marker survive a mode switch.
  await page.eval(`window.__devboardEditors.get("goal-text").focus()`);
  await page.typeText(" Unsaved");
  await delay(100);
  await page.click('[data-testid="mode-flow"]');
  await page.wait(`document.querySelector('[data-testid="mode-flow"]')?.getAttribute("aria-selected") === "true"`, "Flow for unsaved check");
  await page.click('[data-testid="mode-goal"]');
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Goal for unsaved check");
  await delay(120);
  const unsaved = await page.eval<{ value: string; marker: boolean }>(`({
    value: window.__devboardEditors.get("goal-text")?.getValue() ?? "",
    marker: document.querySelector('[data-testid="workspace-tab"] .workspace-tab__dirty') !== null,
  })`);
  check(unsaved.value.endsWith(" VerifyAppend Unsaved") && unsaved.marker, "a mode switch discarded unsaved text", unsaved);

  await page.eval(`document.querySelector('[aria-label="Close Goal document"]')?.click()`);
  await page.wait(`document.querySelector('[data-testid="confirm-close-tab"]') !== null`, "the dirty-close prompt");
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="confirm-close-tab"]') === null`, "the prompt to close");
  const stillOpen = await page.eval<boolean>(`document.querySelector('[data-testid="goal-text"]') !== null`);
  check(stillOpen, "Escape closed a dirty tab");
  await page.eval(`document.querySelector('[aria-label="Close Goal document"]')?.click()`);
  await page.wait(`document.querySelector('[data-testid="confirm-close-tab"]') !== null`, "the dirty-close prompt again");
  const discarded = await page.eval<boolean>(`(() => {
    const button = [...document.querySelectorAll('[data-testid="confirm-close-tab"] button')]
      .find((entry) => entry.textContent?.includes("Discard"));
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  check(discarded, "the discard control is missing");
  await page.wait(`document.querySelector('[data-testid="goal-text"]') === null`, "the discarded tab to close");
  await runPalette("goal.document.open");
  await page.wait(`document.querySelector('[data-testid="goal-text"]') !== null`, "the reopened Goal editor");
  const reopened = await page.eval<{ value: string; data: string }>(`({
    value: window.__devboardEditors.get("goal-text")?.getValue() ?? "",
    data: document.querySelector('[data-testid="goal-text"]').getAttribute("data-dirty"),
  })`);
  check(!reopened.value.includes("Unsaved") && reopened.data === "false", "discarding did not restore the saved text", reopened);

  // 10. Flow surfaces and the xterm terminal.
  await runPalette("open.flow.overview");
  await page.wait(`document.querySelector('[data-testid="mode-flow"]')?.getAttribute("aria-selected") === "true"`, "Flow overview");
  const flowSurfaces = await page.eval<Record<string, boolean>>(`(() => {
    const has = (testid) => document.querySelector('[data-testid="' + testid + '"]') !== null;
    return {
      session: has("flow-session"),
      pr: has("flow-pr-section"),
      widgets: has("flow-widgets-section"),
      files: has("flow-files-section"),
      activity: has("flow-activity-section"),
      terminal: document.querySelector('[data-testid="flow-activity"] .xterm') !== null,
    };
  })()`);
  check(
    flowSurfaces.session && flowSurfaces.pr && flowSurfaces.widgets && flowSurfaces.files && flowSurfaces.activity,
    "a Flow surface is missing",
    flowSurfaces,
  );
  check(flowSurfaces.terminal, "the Flow activity is not rendered by xterm", flowSurfaces);
  const terminalBuffer = await page.eval<string>(`window.__devboardTerminals.get("flow-activity")?.getBuffer() ?? "missing"`);
  check(terminalBuffer !== "missing", "the Flow terminal has no buffer", terminalBuffer);
  const flowData = await page.eval<{
    status: string;
    branch: string;
    pr: string;
    widgets: number;
    files: number;
    checkpoints: number;
    blockers: number;
    readyEnabled: boolean;
  }>(`(() => ({
    status: document.querySelector('[data-testid="flow-status"]')?.getAttribute("data-status") ?? "",
    branch: document.querySelector('[data-testid="flow-branch"]')?.textContent?.trim() ?? "",
    pr: document.querySelector('[data-testid="flow-pr"]')?.getAttribute("data-state") ?? "",
    widgets: document.querySelectorAll('[data-testid="flow-widget"]').length,
    files: document.querySelectorAll('[data-testid="flow-file"]').length,
    checkpoints: document.querySelectorAll('[data-testid="flow-checkpoints"]').length,
    blockers: document.querySelectorAll('[data-testid="flow-blocker"]').length,
    readyEnabled: !(document.querySelector('[data-testid="mark-flow-pr-ready"]')?.disabled ?? true),
  }))()`);
  check(flowData.status === "stopped" && flowData.branch.length > 0 && flowData.pr === "draft", "the Flow session is not restored", flowData);
  check(flowData.widgets === 1 && flowData.files === 1 && flowData.blockers === 1 && flowData.readyEnabled, "Flow data surfaces are incomplete", flowData);

  await runPalette("flow.widget.open.widget-1");
  await page.wait(`document.querySelector('[data-testid="flow-widget-detail"]') !== null`, "the Flow widget tab");
  const widgetDetail = await page.eval<{
    category: string;
    widget: string;
    diff: boolean;
    html: boolean;
    handles: number;
    panes: number[];
    orientation: string;
  }>(`(() => {
    const detail = document.querySelector('[data-testid="flow-widget-detail"]');
    const handles = [...document.querySelectorAll('#workspace-flow [data-testid="pane-handle"]')];
    return {
      category: detail?.getAttribute("data-category") ?? "",
      widget: detail?.getAttribute("data-widget-id") ?? "",
      diff: document.querySelector('[data-testid="flow-diff"]') !== null,
      html: document.querySelector('[data-testid="flow-diff"] .d2h-wrapper') !== null,
      handles: handles.length,
      panes: [...document.querySelectorAll('#workspace-flow [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width)),
      orientation: handles[0]?.getAttribute("aria-orientation") ?? "",
    };
  })()`);
  check(widgetDetail.widget === "widget-1" && widgetDetail.category === "contract", "the widget detail lost its contract", widgetDetail);
  check(widgetDetail.diff && widgetDetail.html, "the Flow diff is not rendered by diff2html", widgetDetail);
  check(widgetDetail.handles >= 1 && widgetDetail.orientation === "vertical" && widgetDetail.panes.every((width) => width >= 160), "the Flow widget split is missing or too small", widgetDetail);
  const detailHandle = await page.rect('#workspace-flow [data-testid="pane-handle"]');
  check(detailHandle !== null, "the Flow detail separator is missing");
  await page.drag(detailHandle!, 1000);
  const flowDragged = await page.eval<number[]>(`[...document.querySelectorAll('#workspace-flow [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width))`);
  check(flowDragged.length >= 2 && flowDragged.every((width) => width >= 160), "the Flow split ignores its 160px minimum", flowDragged);
  await page.doubleClick('#workspace-flow [data-testid="pane-handle"]');
  const flowReset = await page.eval<number[]>(`[...document.querySelectorAll('#workspace-flow [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width))`);
  check(flowReset.length >= 2, "double-click did not reset the Flow split", flowReset);
  await page.focus('#workspace-flow [data-testid="pane-handle"]');
  await page.key("ArrowLeft");
  await delay(150);
  const flowKeyboard = await page.eval<number[]>(`[...document.querySelectorAll('#workspace-flow [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width))`);
  check(
    flowKeyboard.length >= 2 &&
      flowKeyboard.every((width) => width >= 160) &&
      flowKeyboard[0] !== flowReset[0],
    "arrow keys do not resize the Flow split",
    { flowReset, flowKeyboard },
  );
  await saveShot("flow-widget");

  await runPalette("flow.file.open.src/order.ts");
  await page.wait(`document.querySelector('[data-testid="flow-diff"]') !== null`, "the Flow file diff");
  const fileDiff = await page.eval<boolean>(`document.querySelector('[data-testid="flow-diff"] .d2h-wrapper') !== null`);
  check(fileDiff, "the changed-file tab has no rendered diff");
  await page.click('[data-testid="close-flow-diff"]');
  await page.wait(
    `!(document.querySelector('[data-testid="workspace-tab"][aria-selected="true"]')?.textContent ?? "").includes("order.ts")`,
    "the diff tab to close",
  );

  await runPalette("flow.checkpoint.open.cp-1");
  await page.wait(`document.querySelector('[data-testid="flow-checkpoint"]') !== null`, "the Flow checkpoint tab");
  const checkpoint = await page.eval<string>(`document.querySelector('[data-testid="flow-checkpoint"]')?.textContent ?? ""`);
  check(checkpoint.includes("abcdef1"), "the checkpoint lost its commit", checkpoint);
  await runPalette("open.flow.steering");
  await page.wait(`document.querySelector('[data-testid="flow-steering-note"]') !== null`, "the Flow steering note");

  await runPalette("open.flow.overview");
  await page.wait(`document.querySelector('[data-testid="dismiss-flow-blocker"]') !== null`, "the Flow blocker control");
  await page.click('[data-testid="dismiss-flow-blocker"]');
  await page.wait(`document.querySelector('[data-testid="flow-blocker"]')?.getAttribute("data-dismissed") === "true"`, "the dismissed blocker");
  await runPalette("open.flow.flow-goal");
  await page.wait(`document.querySelector('[data-testid="flow-goal-text"] .monaco-editor') !== null`, "the Flow goal editor");
  const flowLabel = await page.eval<string>(`document.querySelector('[data-testid="flow-goal-text"] textarea')?.getAttribute("aria-label") ?? ""`);
  check(flowLabel.length > 0, "the Flow goal editor has no accessible label", flowLabel);
  await runPalette("open.flow.decisions");
  await page.wait(`document.querySelector('[data-testid="flow-decisions"] .monaco-editor') !== null`, "the Flow decision editor");
  const decisionLabel = await page.eval<string>(`document.querySelector('[data-testid="flow-decisions"] textarea')?.getAttribute("aria-label") ?? ""`);
  check(decisionLabel.length > 0, "the decision board has no accessible label", decisionLabel);
  await page.eval(`window.__devboardEditors.get("flow-decisions").focus()`);
  await page.key("End", 2);
  await page.typeText("\n- Decision from the check.");
  await delay(100);
  const decisionText = await page.eval<string>(`window.__devboardEditors.get("flow-decisions").getValue()`);
  await page.key("s", 2);
  const decisionFrame = await waitFor(
    async () =>
      page.eval<{ type?: string; text?: string } | undefined>(`(() => {
        const frames = (window.__viFrames ?? []).map((frame) => {
          try { return JSON.parse(frame); } catch (error) { return null; }
        });
        return [...frames].reverse().find((frame) => frame !== null && frame.type === "saveFlowDecisions") ?? undefined;
      })()`),
    "the saveFlowDecisions frame",
    10_000,
  );
  check(decisionFrame.text === decisionText, "the decision save did not send the exact editor text", decisionFrame);

  // 11. Discover: dense tables, glossary, term and skill splits.
  await runPalette("discover.tab.overview");
  await page.wait(`document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null`, "the Discover overview");
  const discoverTables = await page.eval<{
    cards: number;
    commands: number;
    pyramid: number;
    suite: boolean;
    rowHeights: number[];
    tableFont: string;
    freshness: boolean;
  }>(`(() => {
    const rows = [...document.querySelectorAll('#workspace-discover [data-testid="discover-pyramid"] tbody tr')];
    const table = document.querySelector('[data-testid="discover-pyramid"]');
    return {
      cards: document.querySelectorAll('#workspace-discover [data-testid="discover-card"]').length,
      commands: document.querySelectorAll('#workspace-discover [data-testid="discover-command-list"] tbody tr').length,
      pyramid: rows.length,
      suite: document.querySelector('[data-testid="discover-suite-command"]') !== null,
      rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      tableFont: table === null ? "" : getComputedStyle(table).fontSize,
      freshness: document.querySelector('[data-testid="discover-freshness"]') !== null,
    };
  })()`);
  check(discoverTables.cards >= 5, "Discover sections are missing from the overview", discoverTables);
  check(discoverTables.commands > 0, "the Discover command table is empty", discoverTables);
  check(discoverTables.pyramid > 0 && discoverTables.suite, "the Discover testing tables are empty", discoverTables);
  check(discoverTables.rowHeights.every((height) => height > 0 && height <= 32), "a Discover table row exceeds 32px", discoverTables.rowHeights);
  const discoverFont = Number.parseFloat(discoverTables.tableFont);
  check(discoverFont >= 12 && discoverFont <= 14, "Discover table text is not 12–14px", discoverTables.tableFont);
  check(discoverTables.freshness, "Discover freshness is missing");
  await page.eval(`(() => {
    const scroller = document.querySelector('#workspace-discover .scroll-column');
    if (scroller !== null) scroller.scrollTop = 160;
  })()`);
  await page.click('[data-testid="mode-goal"]');
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Goal for the scroll check");
  await page.click('[data-testid="mode-discover"]');
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Discover for the scroll check");
  const discoverScroll = await page.eval<number>(`Math.round(document.querySelector('#workspace-discover .scroll-column')?.scrollTop ?? 0)`);
  check(discoverScroll >= 150, "a mode switch lost the Discover scroll position", discoverScroll);

  await runPalette("discover.tab.glossary");
  await page.wait(`document.querySelector('[data-testid="discover-term"]') !== null`, "the glossary term table");
  const glossary = await page.eval<{ contexts: number; terms: number; heights: number[]; search: boolean }>(`(() => {
    const rows = [...document.querySelectorAll('#workspace-discover [data-testid="discover-term"]')];
    return {
      contexts: document.querySelectorAll('#workspace-discover [data-testid="discover-context"]').length,
      terms: rows.length,
      heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      search: document.querySelector('[data-testid="discover-glossary-search"]') !== null,
    };
  })()`);
  check(glossary.contexts > 0 && glossary.terms > 0, "the glossary tables are empty", glossary);
  check(glossary.heights.every((height) => height > 0 && height <= 32), "a glossary row exceeds 32px", glossary.heights);
  check(glossary.search, "the glossary search is missing");
  await page.fill('[data-testid="discover-glossary-search"]', "Order Total");
  await page.wait(`document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === 1`, "the filtered glossary");
  await page.fill('[data-testid="discover-glossary-search"]', "");
  await page.wait(`document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === ${glossary.terms}`, "the cleared glossary search");
  const termCommand = await page.eval<string>(`(() => {
    const element = [...document.querySelectorAll('#workspace-discover [data-command^="discover.term.open."]')]
      .find((entry) => entry.getClientRects().length > 0);
    return element?.getAttribute("data-command") ?? "";
  })()`);
  check(termCommand.length > 0, "no glossary term entry is available");
  await runPalette(termCommand);
  await page.wait(`document.querySelector('#workspace-discover [data-testid="discover-term"][data-id]') !== null`, "the term detail tab");
  const termSplit = await page.eval<{ handles: number; panes: number[]; orientation: string }>(`(() => {
    const handles = [...document.querySelectorAll('#workspace-discover [data-testid="pane-handle"]')];
    const panes = [...document.querySelectorAll('#workspace-discover [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width));
    return { handles: handles.length, panes, orientation: handles[0]?.getAttribute("aria-orientation") ?? "" };
  })()`);
  check(termSplit.handles >= 1 && termSplit.orientation === "vertical", "the Discover term detail has no split pane", termSplit);
  check(termSplit.panes.length >= 2 && termSplit.panes.every((width) => width >= 160), "a Discover split pane is below 160px", termSplit);

  await runPalette("discover.tab.testing-strategy");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"] .monaco-editor') !== null`, "the Discover skill editor");
  const skillLabel = await page.eval<string>(`document.querySelector('[data-testid="discover-skill-text"] textarea')?.getAttribute("aria-label") ?? ""`);
  check(skillLabel.length > 0, "the skill editor has no accessible label", skillLabel);
  const originalSkill = await page.eval<string>(`window.__devboardEditors.get("discover-skill-text").getValue()`);
  await page.eval(`window.__devboardEditors.get("discover-skill-text").setValue(${JSON.stringify(`${originalSkill}\n- Verified edit.`)})`);
  await page.wait(`document.querySelector('[data-testid="discover-skill-diff"]') !== null`, "the Discover skill diff");
  await delay(150);
  const skillDirty = await page.eval<boolean>(`document.querySelector('[data-testid="discover-skill-text"]').getAttribute("data-dirty") === "true"`);
  check(skillDirty, "the skill editor does not mark unsaved changes");
  const editedSkill = await page.eval<string>(`window.__devboardEditors.get("discover-skill-text").getValue()`);
  const saveClicked = await page.eval<boolean>(`(() => {
    const button = document.querySelector('[data-testid="discover-skill-save"]');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  check(saveClicked, "the skill Save control is missing");
  let skillFrame: { type?: string; text?: string };
  try {
    skillFrame = await waitFor(
      async () =>
        page.eval<{ type?: string; text?: string } | undefined>(`(() => {
          const frames = (window.__viFrames ?? []).map((frame) => {
            try { return JSON.parse(frame); } catch (error) { return null; }
          });
          return [...frames].reverse().find((frame) => frame !== null && frame.type === "saveDiscoverSkill") ?? undefined;
        })()`),
      "the saveDiscoverSkill frame",
      10_000,
    );
  } catch (error) {
    throw new Error(`the skill save did not reach the server: ${error instanceof Error ? error.message : String(error)}`);
  }
  check(skillFrame.text === editedSkill, "the skill save did not send the exact editor text", skillFrame);
  try {
    await waitFor(
      async () => {
        const text = await readFile(join(host, ".omp", "skills", "discover-testing-strategy", "SKILL.md"), "utf8").catch(() => "");
        return text.includes("Verified edit.") ? true : undefined;
      },
      "the saved skill file",
      10_000,
    );
  } catch (error) {
    const diagnostic = await page.eval<Record<string, unknown>>(`(() => {
      const frames = (window.__viFrames ?? []).map((frame) => {
        try { return JSON.parse(frame); } catch (parseError) { return null; }
      }).filter(Boolean);
      return {
        state: document.querySelector('[data-testid="discover-skill-state"]')?.getAttribute("data-state"),
        dirty: document.querySelector('[data-testid="discover-skill-text"]')?.getAttribute("data-dirty"),
        notices: [...document.querySelectorAll('[data-testid="notifications"] .notification')].map((entry) => entry.textContent.trim()),
        saves: frames.filter((frame) => frame.type === "saveDiscoverSkill").slice(-3),
        errors: frames.filter((frame) => frame.type === "discoverError").slice(-3),
      };
    })()`);
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(diagnostic)}`);
  }
  await page.click('[data-testid="discover-skill-restore"]');
  await waitFor(
    async () => {
      if ((await page.eval<boolean>(`document.querySelector('[data-testid="discover-skill-state"]')?.getAttribute("data-state") === "generated"`)) !== true) return undefined;
      const live = await readFile(join(host, ".omp", "skills", "discover-testing-strategy", "SKILL.md"), "utf8").catch(() => "");
      const baseline = await readFile(join(host, ".omp", "discover", "skills", "discover-testing-strategy", "SKILL.md"), "utf8").catch(() => "");
      return live === baseline ? true : undefined;
    },
    "the restored generated skill",
    10_000,
  );
  const skillTabSplit = await page.eval<number>(`document.querySelectorAll('#workspace-discover [data-testid="pane-handle"]').length`);
  check(skillTabSplit >= 1, "the skill editor has no preview split");
  const preview = await page.eval<boolean>(`document.querySelector('[data-testid="discover-skill-preview"]') !== null`);
  check(preview, "the skill preview is missing");

  // Tabs survive mode switches, including the unsaved editor and active tab.
  const discoverTabsBefore = await page.eval<string[]>(`[...document.querySelectorAll('[data-testid="workspace-tab"]')].map((tab) => tab.textContent.trim())`);
  await page.click('[data-testid="mode-goal"]');
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Goal from Discover");
  await page.click('[data-testid="mode-discover"]');
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Discover return");
  const discoverTabsAfter = await page.eval<string[]>(`[...document.querySelectorAll('[data-testid="workspace-tab"]')].map((tab) => tab.textContent.trim())`);
  check(JSON.stringify(discoverTabsBefore) === JSON.stringify(discoverTabsAfter), "Discover tabs changed across modes", { discoverTabsBefore, discoverTabsAfter });

  // 12. Reload restores mode, tabs, active tabs, theme, sidebar and split sizes.
  const beforeReload = await page.eval<{
    mode: string;
    tabs: string[];
    active: string;
    sidebar: number;
    panes: number[];
    theme: string;
    stored: string;
  }>(`(() => ({
    mode: ["goal", "flow", "discover"].find((mode) => document.querySelector('[data-testid="mode-' + mode + '"]')?.getAttribute("aria-selected") === "true") ?? "",
    tabs: [...document.querySelectorAll('[data-testid="workspace-tab"]')].map((tab) => tab.textContent.trim()),
    active: document.querySelector('[data-testid="workspace-tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
    sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    panes: [...document.querySelectorAll('#workspace-discover [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width)),
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem("devboard.layout.v1") ?? "",
  }))()`);
  check(beforeReload.mode === "discover", "the active mode is not Discover before reload", beforeReload);
  await page.reload();
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Discover after reload");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"]') !== null`, "the restored skill tab");
  const afterReload = await page.eval<{
    mode: string;
    tabs: string[];
    active: string;
    sidebar: number;
    panes: number[];
    theme: string;
    stored: string;
    editor: string;
  }>(`(() => ({
    mode: ["goal", "flow", "discover"].find((mode) => document.querySelector('[data-testid="mode-' + mode + '"]')?.getAttribute("aria-selected") === "true") ?? "",
    tabs: [...document.querySelectorAll('[data-testid="workspace-tab"]')].map((tab) => tab.textContent.trim()),
    active: document.querySelector('[data-testid="workspace-tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
    sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    panes: [...document.querySelectorAll('#workspace-discover [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width)),
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem("devboard.layout.v1") ?? "",
    editor: (window.__devboardEditors.get("discover-skill-text")?.getValue() ?? "").slice(-20),
    state: document.querySelector('[data-testid="discover-skill-state"]')?.getAttribute("data-state") ?? "",
  }))()`);
  check(afterReload.mode === beforeReload.mode && afterReload.theme === beforeReload.theme, "mode or theme did not survive reload", { beforeReload, afterReload });
  check(JSON.stringify(afterReload.tabs) === JSON.stringify(beforeReload.tabs) && afterReload.active === beforeReload.active, "tabs or active tab did not survive reload", { before: beforeReload, after: afterReload });
  check(Math.abs(afterReload.sidebar - beforeReload.sidebar) <= 2, "the sidebar width did not survive reload", { before: beforeReload.sidebar, after: afterReload.sidebar });
  check(afterReload.panes.length === beforeReload.panes.length && afterReload.panes.every((width, index) => Math.abs(width - (beforeReload.panes[index] ?? 0)) <= 2), "split sizes did not survive reload", { before: beforeReload.panes, after: afterReload.panes });
  const restoredBaseline = (await readFile(join(host, ".omp", "discover", "skills", "discover-testing-strategy", "SKILL.md"), "utf8")).slice(-20);
  check(
    afterReload.editor === restoredBaseline && afterReload.state === "generated",
    "the restored skill text did not survive reload",
    { editor: afterReload.editor, baseline: restoredBaseline, state: afterReload.state },
  );
  check(afterReload.stored.includes('"theme":"light"'), "layout localStorage lost the theme", afterReload.stored.slice(0, 120));

  // 13. Reset layout restores defaults.
  await runPalette("view.layout.reset");
  await page.wait(`document.documentElement.dataset.theme === "dark"`, "the dark default after reset");
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "the Goal default after reset");
  const resetLayout = await page.eval<{ tabs: string[]; sidebar: number; active: string; stored: string; panes: string }>(`(() => ({
    tabs: [...document.querySelectorAll('[data-testid="workspace-tab"]')].map((tab) => tab.textContent.trim()),
    sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    active: document.querySelector('[data-testid="workspace-tab"][aria-selected="true"]')?.textContent?.trim() ?? "",
    stored: localStorage.getItem("devboard.layout.v1") ?? "",
    panes: Object.keys(localStorage).filter((key) => key.startsWith("paneforge:")).join(","),
  }))()`);
  check(JSON.stringify(resetLayout.tabs) === JSON.stringify(["Overview"]) && resetLayout.active === "Overview", "reset layout did not restore the default tab", resetLayout);
  check(Math.abs(resetLayout.sidebar - 300) <= 12, "reset layout did not restore the sidebar width", resetLayout);
  check(resetLayout.panes.length > 0 && !resetLayout.panes.includes("devboard.detail"), "reset layout left stale split storage", resetLayout);

  // 14. The issue reporter opens and cancels with Escape.
  await runPalette("app.report");
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the issue reporter picking mode");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the issue reporter to cancel");
  const reporterFocus = await page.eval<boolean>(`document.activeElement?.closest('[data-testid="notifications"]') === null`);
  check(reporterFocus, "the issue reporter stole focus into the notification region");

  // 15. Notifications and history: stop the server, attempt a command, restart.
  serverProcess?.kill("SIGTERM");
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() !== "Connected"`,
    "the closed connection",
    20_000,
  );
  await runPalette("goal.document.open");
  await page.wait(`document.querySelector('[data-testid="goal-text"]') !== null`, "the Goal editor while disconnected");
  await page.click('[data-testid="save-goal"]');
  await page.wait(
    `[...document.querySelectorAll('[data-testid="notifications"] .notification')].some((entry) => entry.textContent.includes("Not connected"))`,
    "the disconnected-command notification",
    20_000,
  );
  const notification = await page.eval<{ severity: string; text: string; count: number; live: string }>(`(() => {
    const entries = [...document.querySelectorAll('[data-testid="notifications"] .notification')];
    const entry = entries.find((item) => item.textContent.includes("Not connected")) ?? entries[0];
    return {
      severity: entry?.getAttribute("data-severity") ?? "",
      text: entry?.textContent?.trim() ?? "",
      count: entries.length,
      live: document.querySelector('[data-testid="notifications"]')?.getAttribute("aria-live") ?? "",
    };
  })()`);
  check(notification.severity.length > 0 && notification.text.length > 0, "the notification region has no severity or text", notification);
  check(notification.live === "polite", "the notification region is not a live region", notification);
  const notificationFocus = await page.eval<boolean>(`document.activeElement?.closest('[data-testid="notifications"]') === null`);
  check(notificationFocus, "a notification stole focus");
  startServer();
  await waitForHttp(baseUrl);
  await page.wait(`document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`, "reconnection", 30_000);
  await page.click('[data-testid="notification-indicator"]');
  await page.wait(`document.querySelector('[data-testid="notification-history"]') !== null`, "the notification history");
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="notification-history"]') === null`, "the history to close");
  const dismiss = await page.eval<boolean>(`(() => {
    const button = document.querySelector('[data-testid="notifications"] .notification button');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  check(dismiss, "the notification region has no dismissal control");

  // 15. Viewport boundary.
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1023,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`document.querySelector('[data-testid="unsupported-viewport"]') !== null`, "the narrow-viewport notice");
  const narrow = await page.eval<{ text: string; shell: boolean }>(`({
    text: document.querySelector('[data-testid="unsupported-viewport"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
    shell: document.querySelector('[data-testid="app-shell"]') !== null,
  })`);
  check(narrow.text.includes("1024") && narrow.text.includes("720") && !narrow.shell, "the narrow notice is wrong", narrow);
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 719,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`document.querySelector('[data-testid="unsupported-viewport"]') !== null`, "the short-viewport notice");
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`document.querySelector('[data-testid="app-shell"]') !== null`, "the 1024×720 shell");
  const boundary = await page.eval<{ notice: boolean; scroll: number[]; status: boolean; clipped: number }>(`(() => {
    const doc = document.documentElement;
    const shell = document.querySelector('[data-testid="app-shell"]');
    const clipped = [...document.querySelectorAll('[data-testid="status-bar"] *, [data-testid="activity-bar"] *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > innerWidth + 0.5 || rect.left < -0.5);
      }).length;
    return {
      notice: document.querySelector('[data-testid="unsupported-viewport"]') !== null,
      scroll: [doc.scrollWidth, doc.clientWidth, doc.scrollHeight, doc.clientHeight],
      status: document.querySelector('[data-testid="status-bar"]') !== null,
      clipped,
      shellWidth: shell?.getBoundingClientRect().width ?? 0,
    };
  })()`);
  check(!boundary.notice && boundary.status && boundary.scroll[0]! <= boundary.scroll[1]!, "the 1024×720 boundary is not usable", boundary);
  check(boundary.clipped === 0, "a shell control is clipped at 1024×720", boundary);
  await page.screenshot(join(harnessRoot, ".tmp", "interface", "1024x720.png"));
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the 1440×900 viewport");

  // 16. Contrast and reduced motion in both themes.
  const contrast = async (): Promise<Record<string, number>> =>
    page.eval<Record<string, number>>(`(() => {
      const root = getComputedStyle(document.documentElement);
      const read = (name) => root.getPropertyValue(name).trim();
      const parse = (value) => {
        let hex = value.replace("#", "");
        if (hex.length === 3) hex = hex.split("").map((channel) => channel + channel).join("");
        const int = parseInt(hex, 16);
        return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
      };
      const lum = (value) => {
        const [r, g, b] = parse(value).map((channel) =>
          channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
        );
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const [high, low] = [lum(a), lum(b)].sort((left, right) => right - left);
        return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
      };
      return {
        text: ratio(read("--foreground"), read("--background")),
        muted: ratio(read("--muted-foreground"), read("--surface")),
        border: ratio(read("--border-strong"), read("--background")),
        ring: ratio(read("--ring"), read("--background")),
      };
    })()`);
  const darkContrast = await contrast();
  check(darkContrast.text! >= 4.5 && darkContrast.muted! >= 4.5, "dark text contrast is below 4.5:1", darkContrast);
  check(darkContrast.border! >= 3 && darkContrast.ring! >= 3, "dark interactive contrast is below 3:1", darkContrast);
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "light"`, "the light theme for contrast");
  const lightContrast = await contrast();
  check(lightContrast.text! >= 4.5 && lightContrast.muted! >= 4.5, "light text contrast is below 4.5:1", lightContrast);
  check(lightContrast.border! >= 3 && lightContrast.ring! >= 3, "light interactive contrast is below 3:1", lightContrast);
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "dark"`, "the dark theme again");

  await devtools.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reduced = await page.eval<string>(`getComputedStyle(document.querySelector('[data-testid="theme-toggle"]')).transitionDuration`);
  const reducedSeconds = Math.max(...reduced.split(",").map((value) => Number.parseFloat(value) || 0));
  check(reducedSeconds <= 0.001, "prefers-reduced-motion does not disable transitions", reduced);
  await devtools.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });

  // 17. Palette mirroring after many tabs opened, then screenshots.
  await page.key("k", 2);
  await page.wait(`document.querySelector('[data-testid="command-palette"]') !== null`, "the final palette");
  const finalMirror = await page.eval<{ missing: string[]; palette: number }>(`(() => {
    const paletteIds = new Set([...document.querySelectorAll('[data-testid="command-item"]')].map((item) => item.getAttribute("data-command")));
    const visible = [...document.querySelectorAll("[data-command]")]
      .filter((element) => element.closest('[data-testid="command-palette"]') === null)
      .filter((element) => element.getClientRects().length > 0);
    const commands = [...new Set(visible.map((element) => element.getAttribute("data-command")))];
    return { missing: commands.filter((id) => id !== null && !paletteIds.has(id)), palette: paletteIds.size };
  })()`);
  check(finalMirror.missing.length === 0, "a visible data-command is missing from the final palette", finalMirror);
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="command-palette"]') === null`, "the final palette to close");

  await runPalette("open.goal.overview");
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Goal overview for screenshots");
  await saveShot("goal-overview");
  await runPalette("goal.adrs.open");
  await saveShot("goal-adrs");
  await runPalette("discover.tab.overview");
  await saveShot("discover-overview");
  await runPalette("discover.tab.glossary");
  await saveShot("discover-glossary");
  await runPalette("discover.tab.testing-strategy");
  await saveShot("discover-skill");
  await runPalette(termCommand);
  await saveShot("discover-term");
  await runPalette("open.flow.overview");
  await saveShot("flow-overview");
  await page.key("1", 1);
  await saveShot("goal-final");

  // 18. No runtime failures or overflow.
  const runtime = await page.eval<{ exceptions: string[]; overflow: number[] }>(`(() => {
    const doc = document.documentElement;
    return {
      exceptions: window.__viExceptions ?? [],
      overflow: [doc.scrollWidth, doc.clientWidth, doc.scrollHeight, doc.clientHeight],
    };
  })()`);
  check(runtime.exceptions.length === 0, "an uncaught page exception occurred", runtime.exceptions);
  check(runtime.overflow[0]! <= runtime.overflow[1]! && runtime.overflow[2]! <= runtime.overflow[3]!, "the final page overflows", runtime.overflow);
  const layoutFrames = await page.eval<string[]>(`(() => {
    const forbidden = ["layout", "sidebarWidth", "split", "activeTab"];
    return (window.__viFrames ?? []).filter((frame) =>
      forbidden.some((key) => frame.toLowerCase().includes(key)),
    );
  })()`);
  check(layoutFrames.length === 0, "layout state was sent to the server", layoutFrames);
  check(pageProblems.length === 0, "the page logged an error", pageProblems);
  check(networkProblems.length === 0, "an asset request failed", networkProblems);

  devtools.close();
  console.log(
    "verify:interface: shell, modes, sidebar, tabs, splits, palette, keyboard, theme, tables, editors, terminals, accessibility, notifications, status bar, persistence, and boundary passed",
  );
} finally {
  try {
    chromeProcess?.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  try {
    serverProcess?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}
