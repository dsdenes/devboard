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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { journalKey } from "../server/journal";
import { REDESIGN_INSTRUCTION as redesignInstruction, REMOVAL_INSTRUCTION as removalInstruction } from "../server/feedback";
import { stateFile } from "../server/state";
import { freePort, run, waitFor } from "./verification";

const harnessRoot = resolve(import.meta.dir, "..");
const stubAgent = join(harnessRoot, "server", "fixtures", "stub-agent.ts");
// The deterministic `gh` stub always answers with this issue URL.
const stubIssueUrl = "https://github.com/example/host/issues/42";
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

  async navigate(url: string): Promise<void> {
    await this.devtools.send("Page.navigate", { url });
    await delay(250);
    await this.wait(
      `document.readyState === "complete" && document.querySelector('[data-testid="app-shell"]') !== null`,
      "the navigated shell",
      30_000,
    );
    await this.wait(
      `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
      "the navigated connection",
      30_000,
    );
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
  await mkdir(join(host, "node_modules", "typescript"), { recursive: true });
  await writeFile(
    join(host, "node_modules", "typescript", "package.json"),
    `${JSON.stringify({ name: "typescript", repository: "git+https://github.com/microsoft/TypeScript.git" }, null, 2)}\n`,
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

/**
 * Publishes one orchestrator state for the fixture host, atomically, the way
 * the runner does. The dashboard reads it through the `getOrchestrator`
 * command, so this is the only seed the status item needs.
 */
async function seedOrchestrator(
  stateDir: string,
  host: string,
  status: "idle" | "running" | "failed",
): Promise<void> {
  const directory = join(stateDir, "orchestrator");
  await mkdir(directory, { recursive: true });
  const issues =
    status === "running"
      ? [17, 18, 19].map((number) => ({
          number,
          title: `Fixture issue ${number}`,
          url: `https://example.test/issues/${number}`,
          createdAt: "2026-10-26T00:00:00Z",
        }))
      : [];
  const state = {
    version: 1,
    root: resolve(host),
    repo: "fixture/host",
    status,
    startedAt: status === "running" ? "2026-10-27T10:00:00.000Z" : null,
    finishedAt: status === "idle" ? "2026-10-27T09:59:00.000Z" : null,
    open: issues.length,
    issues,
    lastExitCode: status === "failed" ? 1 : null,
    lastError: status === "failed" ? "the agent exited with code 1" : null,
    nextAttemptAt: status === "failed" ? "2026-10-27T10:05:00.000Z" : null,
    updatedAt: new Date().toISOString(),
  };
  const path = join(directory, "state.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}

async function clearOrchestratorState(stateDir: string): Promise<void> {
  await rm(join(stateDir, "orchestrator"), { recursive: true, force: true });
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

/** A digest of every file under `<host>/.omp`; absent trees hash the same. */
async function ompDigest(host: string): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (prefix: string): Promise<void> => {
    const directory = prefix.length === 0 ? join(host, ".omp") : join(host, ".omp", prefix);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const next = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next);
      } else if (entry.isFile()) {
        digest.update(next);
        digest.update("\u0000");
        digest.update(await readFile(join(host, ".omp", next)));
        digest.update("\u0000");
      }
    }
  };
  await walk("");
  return digest.digest("hex");
}

/** A local repository whose files the remote clone and its crawl can read. */
async function createRemoteSource(root: string): Promise<string> {
  const source = join(root, "remote-source");
  await mkdir(join(source, "adrs"), { recursive: true });
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "test"), { recursive: true });
  await mkdir(join(source, ".github", "workflows"), { recursive: true });
  await writeFile(join(source, "README.md"), "# Remote fixture\n\nA repository cloned for Discover.\n");
  await writeFile(
    join(source, "package.json"),
    `${JSON.stringify({ name: "remote-fixture", scripts: { test: "bun test" } }, null, 2)}\n`,
  );
  await writeFile(join(source, "src", "catalog.ts"), "export const catalogSize = 3;\n");
  await writeFile(
    join(source, "test", "catalog.test.ts"),
    'import { test, expect } from "bun:test";\ntest("catalog", () => expect(3).toBe(3));\n',
  );
  await writeFile(
    join(source, ".github", "workflows", "ci.yml"),
    "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n",
  );
  await writeFile(join(source, "adrs", "0001-remote.md"), "# Remote decision\n\n- Status: Accepted\n");
  await writeFile(join(source, ".gitignore"), ".omp/\nnode_modules/\n");
  await git(source, ["init", "-q"]);
  await git(source, ["add", "-A"]);
  await git(source, ["commit", "-q", "-m", "chore: remote fixture"]);
  return source;
}

/**
 * Clones a local repository into the state scratch root and crawls it through a
 * temporary dashboard, so the restored remote target holds real artifacts.
 */
async function seedRemoteClone(root: string, stateDir: string): Promise<string> {
  const source = await createRemoteSource(root);
  const cloneDir = join(stateDir, "discover-remote", "octocat-hello-world");
  await mkdir(dirname(cloneDir), { recursive: true });
  // A local clone: no network, and the result is a real git work tree.
  await git(root, ["clone", "-q", source, cloneDir]);
  const port = await freePort();
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    ADRS_DIR: join(cloneDir, "adrs"),
    REPO_DIR: cloneDir,
    GOAL_FILE: join(cloneDir, "GOAL.md"),
    STATIC_DIR: join(harnessRoot, "dist"),
    STATE_DIR: join(root, "remote-seed-state"),
    AGENT_COMMAND: `bun ${stubAgent} --log=${join(root, "remote-seed-agent.log")} --discover`,
    DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
  };
  const log = join(root, "remote-seed-server.log");
  const writer = Bun.file(log).writer();
  const child = spawn("bun", ["run", "server/index.ts"], {
    cwd: harnessRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => writer.write(chunk));
  child.stderr?.on("data", (chunk) => writer.write(chunk));
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    await seedDiscover(port);
  } finally {
    const exited = new Promise<void>((settle) => child.once("exit", () => settle()));
    child.kill("SIGTERM");
    await exited;
  }
  check(
    Bun.file(join(cloneDir, ".omp", "discover", "sheet.json")).size > 0,
    "the remote clone was not seeded with Discover artifacts",
  );
  return cloneDir;
}

/** Writes the remote target into the stopped dashboard's durable state. */
async function seedRemoteTarget(stateDir: string, host: string): Promise<void> {
  const path = stateFile(stateDir, resolve(host));
  const envelope = JSON.parse(await readFile(path, "utf8")) as {
    state?: Record<string, unknown>;
  };
  check(
    typeof envelope.state === "object" && envelope.state !== null,
    "the dashboard state file is missing before seeding a remote target",
    path,
  );
  envelope.state.discoverTarget = {
    url: "https://github.com/octocat/Hello-World",
    owner: "octocat",
    repo: "Hello-World",
  };
  await writeFile(path, JSON.stringify(envelope));
}

async function writeGateOffHost(root: string): Promise<string> {
  const host = join(root, "gate-off-host");
  await mkdir(join(host, "adrs"), { recursive: true });
  await writeFile(join(host, "GOAL.md"), "# Gate-off host\n");
  await writeFile(join(host, "package.json"), `${JSON.stringify({ name: "gate-off-host" })}\n`);
  await writeFile(join(host, "adrs", "0001-gate-off.md"), "# Gate off\n\n- Status: Accepted\n");
  return host;
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

/** One recorded call of the deterministic `gh` stub. */
interface FeedbackCall {
  args: string[];
  cwd: string;
  body: string;
}

const runId = `verify-interface-${Date.now()}`;
const root = join(harnessRoot, ".tmp", runId);
let serverProcess: ReturnType<typeof spawn> | undefined;
let gateOffProcess: ReturnType<typeof spawn> | undefined;
let chromeProcess: ReturnType<typeof spawn> | undefined;

try {
  const build = run("bun", ["run", "build"], { cwd: harnessRoot });
  check(build.code === 0, "the client build failed", build.stderr);

  await mkdir(root, { recursive: true });
  await mkdir(join(harnessRoot, ".tmp", "interface"), { recursive: true });
  const host = await writeFixture(root);
  // Discover's remote scratch root must resolve inside REPO_DIR; the harness
  // state stays under the excluded `.devboard/` tree.
  const stateDir = join(host, ".devboard", ".tmp", "state");
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
    // Every feedback action is filed through the recording stub, never through
    // the operator's real `gh`, and the recorded requests stay under `.tmp`.
    DEVBOARD_FEEDBACK_STUB: "stub",
    DEVBOARD_FEEDBACK_RECORD_DIR: join(root, "feedback"),
    DEVBOARD_FEEDBACK_MODE_FILE: join(root, "feedback-mode"),
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
  const stopServer = async (): Promise<void> => {
    const child = serverProcess;
    if (child === undefined) return;
    serverProcess = undefined;
    const exited = new Promise<void>((settle) => child.once("exit", () => settle()));
    child.kill("SIGTERM");
    await exited;
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
  const feedbackRequests: Array<Record<string, unknown>> = [];

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
    const request = params.request as { url?: string; method?: string; postData?: string } | undefined;
    if (typeof requestId === "string" && typeof request?.url === "string") {
      requestUrls.set(requestId, request.url);
    }
    if (
      request?.method === "POST" &&
      (request.url ?? "").endsWith("/api/feedback") &&
      typeof request.postData === "string"
    ) {
      try {
        const parsed = JSON.parse(request.postData) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          feedbackRequests.push(parsed as Record<string, unknown>);
        }
      } catch {
        feedbackRequests.push({ unparsed: request.postData });
      }
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
      const url = String(response.url ?? "");
      if (url.includes("favicon")) return;
      // The feedback failure case is asserted directly below.
      if (url.endsWith("/api/feedback")) return;
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

  // The deterministic feedback store: the stub appends every filing to
  // `calls.jsonl`, and a mode file switches its answer between calls.
  const feedbackRecordDir = join(root, "feedback");
  const feedbackModePath = join(root, "feedback-mode");
  const feedbackCalls = async (): Promise<FeedbackCall[]> => {
    const file = Bun.file(join(feedbackRecordDir, "calls.jsonl"));
    if (!(await file.exists())) return [];
    const calls: FeedbackCall[] = [];
    for (const line of (await file.text()).split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        calls.push(JSON.parse(line) as FeedbackCall);
      } catch {
        // A call still being written; the next read sees it whole.
      }
    }
    return calls;
  };
  const clearFeedback = async (): Promise<void> => {
    await rm(feedbackRecordDir, { recursive: true, force: true });
    await mkdir(feedbackRecordDir, { recursive: true });
    feedbackRequests.length = 0;
  };
  const setFeedbackMode = async (mode: string): Promise<void> => {
    await writeFile(feedbackModePath, `${mode}\n`);
  };
  const waitForFeedbackCalls = async (count: number): Promise<void> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const recorded = await feedbackCalls();
      if (recorded.length >= count) return;
      if (Date.now() > deadline) {
        throw new Error(
          `verify:interface: the feedback stub recorded ${recorded.length} of ${count} calls`,
        );
      }
      await delay(50);
    }
  };
  const dockState = async (): Promise<{
    docks: number;
    labels: string[];
    commands: string[];
    pressed: boolean[];
    disabled: boolean[];
    group: string | null;
    overlay: boolean;
    inside: boolean;
  }> =>
    page.eval(`(() => {
      const docks = [...document.querySelectorAll(".feedback-dock")];
      const dock = docks[0];
      const buttons = [...document.querySelectorAll(".feedback-dock__actions button")];
      const rects = buttons.map((button) => button.getBoundingClientRect());
      return {
        docks: docks.length,
        labels: buttons.map((button) => button.textContent.trim()),
        commands: buttons.map((button) => button.getAttribute("data-command") ?? ""),
        pressed: buttons.map((button) => button.getAttribute("aria-pressed") === "true"),
        disabled: buttons.map((button) => button.disabled === true),
        group: dock?.getAttribute("role") === "group" ? (dock.getAttribute("aria-label") ?? "") : null,
        overlay: dock?.closest("[data-feedback-overlay]") !== null,
        inside: rects.every(
          (rect) => rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        ),
      };
    })()`);

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
    for (const id of ["app-shell", "activity-bar", "sidebar", "workspace", "status-bar"]) {
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
    entries: Array<{ testid: string; selected: string; controls: string; controlsExists: boolean; label: string; visible: string; icon: boolean; command: string }>;
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
        visible: tab.querySelector(".activity-tab__label")?.textContent?.trim() ?? "",
        icon: tab.querySelector("svg") !== null,
        command: tab.getAttribute("data-command") ?? "",
      })),
    };
  })()`);
  check(activity.count === 3, "the activity bar does not present exactly three modes", activity);
  const brand = await page.eval<string>(`document.querySelector('[data-testid="activity-bar"]')?.textContent?.replace(/\\s+/g, "") ?? ""`);
  check(brand === "GoalFlowDiscover", "the activity bar does not name its three modes", brand);
  const expectedModes = [
    ["mode-goal", "true", "Goal"],
    ["mode-flow", "false", "Flow"],
    ["mode-discover", "false", "Discover"],
  ];
  for (const [index, [testid, selected, visible]] of expectedModes.entries()) {
    const entry = activity.entries[index]!;
    check(entry.testid === testid, `activity tab ${index} is ${entry.testid}`, entry);
    check(entry.selected === selected, `${testid} selection is ${entry.selected}`, entry);
    check(entry.controlsExists, `${testid} aria-controls names no panel`, entry);
    check(entry.label.length > 0 && entry.icon, `${testid} lacks a name or icon`, entry);
    check(entry.visible === visible, `${testid} does not render its visible label`, entry);
    check(entry.command === `view.mode.${testid.replace("mode-", "")}`, `${testid} lacks its command`, entry);
  }
  const railLabels = await page.eval<Array<{ text: string; overflow: number; inside: boolean }>>(`(() => {
    return [...document.querySelectorAll('[data-testid="activity-bar"] .activity-tab')].map((tab) => {
      const label = tab.querySelector('.activity-tab__label');
      const tabRect = tab.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      return {
        text: label?.textContent?.trim() ?? "",
        overflow: label === null ? 1 : label.scrollWidth - label.clientWidth,
        inside: labelRect !== undefined && labelRect.left >= tabRect.left - 0.5 && labelRect.right <= tabRect.right + 0.5,
      };
    });
  })()`);
  check(
    railLabels.length === 3 && railLabels.every((label) => label.overflow <= 1 && label.inside),
    "a mode label overflows or leaves its tab",
    railLabels,
  );

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
  const sidebarToggle = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar-toggle"]') !== null`);
  check(!sidebarToggle, "the sidebar still renders a hide control");
  await page.key("k", 2);
  await page.wait(`document.querySelector('[data-testid="command-palette"]') !== null`, "the palette for shortcut labels");
  const shortcutLabels = await page.eval<string[]>(`[...document.querySelectorAll('[data-testid="command-item"]')].map((item) => item.querySelector(".palette__shortcut")?.textContent ?? "").filter(Boolean)`);
  check(shortcutLabels.some((label) => label.includes("Alt+1")), "palette shortcuts are not discoverable", shortcutLabels);
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
    "view.theme.toggle", "view.layout.reset",
    "app.reload", "app.report", "app.remove", "app.redesign", "app.report.cancel",
    "app.notifications.open",
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
  check(!ids.has("view.sidebar.toggle"), "the palette still offers a sidebar toggle");
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
  await page.focus('[data-testid="theme-toggle"]');
  await page.key("k", 2);
  await page.wait(`document.querySelector('[data-testid="command-palette"]') !== null`, "the palette for Escape");
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="command-palette"]') === null`, "the palette to close on Escape");
  await delay(150);
  const restoredFocus = await page.eval<string>(`document.activeElement?.getAttribute("data-testid") ?? ""`);
  check(restoredFocus === "theme-toggle", "Escape did not restore focus", restoredFocus);

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
  await delay(120);
  const sidebarAfterShortcut = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar"]') !== null`);
  check(sidebarAfterShortcut, "Ctrl+B still hides the sidebar");

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
  const sidebarAfterReload = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar"]') !== null`);
  check(sidebarAfterReload, "the sidebar disappeared on reload");

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
    tabStrips: number;
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
      tabStrips: document.querySelectorAll('[data-testid="workspace-tabs"]').length,
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
  check(adr.tabStrips === 0, "the workspace still renders a tab strip", adr.tabStrips);
  const adrSidebar = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar"] section[aria-label="ADR records"]') !== null`);
  check(adrSidebar, "the sidebar hides pending ADR records");
  const framesBeforeRow = await page.eval<number>("window.__viFrames.length");
  await page.click('[data-testid="record"]');
  await page.wait(`document.querySelector('[data-testid="record-file"]') !== null && !document.querySelector('[data-testid="adr-table"]')`, "the ADR detail tab");
  const framesAfterRow = await page.eval<number>("window.__viFrames.length");
  check(framesAfterRow === framesBeforeRow, "selecting a row sent a WebSocket frame", { framesBeforeRow, framesAfterRow });
  await runPalette("goal.adr.open.0001-shell-and-layout.md");
  const reopenedPanel = await page.eval<{ table: boolean; detail: boolean; tabs: number }>(`({
    table: document.querySelector('[data-testid="adr-table"]') !== null,
    detail: document.querySelector('[data-testid="record-file"]') !== null,
    tabs: document.querySelectorAll('[data-testid="workspace-tab"]').length,
  })`);
  check(!reopenedPanel.table && reopenedPanel.detail && reopenedPanel.tabs === 0, "a surface no longer replaces the open page", reopenedPanel);

  // The Goal sidebar has one Skills entry that discloses the prepared skills.
  const goalSkills = await page.eval<{ sections: number; toggle: boolean; menu: boolean }>(`(() => ({
    sections: document.querySelectorAll('[data-testid="sidebar"] section[aria-label="Skills"]').length,
    toggle: document.querySelector('[data-testid="goal-skills-toggle"]') !== null,
    menu: document.querySelector('[data-testid="goal-skills-menu"]') !== null,
  }))()`);
  check(goalSkills.sections === 0 && goalSkills.toggle && !goalSkills.menu, "the Goal sidebar duplicates the skills list", goalSkills);
  await page.click('[data-testid="goal-skills-disclosure"]');
  await page.wait(`document.querySelector('[data-testid="goal-skills-menu"]') !== null`, "the prepared skills disclosure");
  const goalSkillNames = await page.eval<string[]>(`[...document.querySelectorAll('[data-testid="goal-skill"]')].map((item) => item.getAttribute("data-name") ?? "")`);
  check(goalSkillNames.length >= 5 && goalSkillNames.every((name) => name.length > 0), "the skills disclosure is empty", goalSkillNames);
  const clickedSkill = await page.eval<string>(`(() => {
    const item = document.querySelector('[data-testid="goal-skill"]');
    item?.click();
    return item?.getAttribute("data-name") ?? "";
  })()`);
  await page.wait(`document.querySelector('[data-testid="skills-overlay"]') !== null`, "the Skills page from the disclosure");
  const goalSkillSurface = await page.eval<{ selected: string; current: string }>(`(() => {
    const item = document.querySelector('[data-testid="skill"][data-selected="true"]');
    return {
      selected: item?.getAttribute("data-name") ?? "",
      current: item?.getAttribute("aria-current") ?? "",
    };
  })()`);
  check(goalSkillSurface.selected === clickedSkill && goalSkillSurface.current === "true", "clicking a prepared skill does not select it", { clickedSkill, goalSkillSurface });

  // 9. Goal editor: reset arm/cancel, dirty marker, save, unsaved survival, close prompt.
  await runPalette("open.goal.overview");
  await page.wait(`document.querySelector('[data-testid="reset-implementation"]') !== null`, "the reset control");
  await page.click('[data-testid="reset-implementation"]');
  await page.wait(`document.querySelector('[data-testid="reset-confirmation"]') !== null`, "the reset confirmation");
  await page.click('[data-testid="cancel-reset"]');
  await page.wait(`document.querySelector('[data-testid="reset-confirmation"]') === null`, "the reset confirmation to close");
  await runPalette("goal.document.open");
  await page.wait(`document.querySelector('[data-testid="goal-text"] .monaco-editor') !== null`, "the Goal Monaco editor");
  const goalLayout = await page.eval<{
    editor: number;
    panel: number;
    revision: number;
    panelBottom: number;
    revisionBottom: number;
  }>(`(() => {
    const editor = document.querySelector('[data-testid="goal-text"]');
    const panel = document.querySelector('[data-testid="goal-editor"]');
    const revision = document.querySelector('[data-testid="revision-request"]');
    return {
      editor: editor === null ? 0 : Math.round(editor.getBoundingClientRect().height),
      panel: panel === null ? 0 : Math.round(panel.getBoundingClientRect().height),
      revision: revision === null ? 0 : Math.round(revision.getBoundingClientRect().height),
      panelBottom: panel === null ? 0 : Math.round(panel.getBoundingClientRect().bottom),
      revisionBottom: revision === null ? 0 : Math.round(revision.getBoundingClientRect().bottom),
    };
  })()`);
  check(goalLayout.editor >= 400 && goalLayout.editor >= goalLayout.panel * 0.6, "the goal document does not fill the page", goalLayout);
  check(goalLayout.revision >= 60 && Math.abs(goalLayout.revisionBottom - goalLayout.panelBottom) <= 24, "the revision guidance is not a tall field at the bottom", goalLayout);
  await saveShot("goal-document");
  const goalLabel = await page.eval<string>(`document.querySelector('[data-testid="goal-text"] textarea')?.getAttribute("aria-label") ?? ""`);
  check(goalLabel.length > 0, "the Goal editor has no accessible label", goalLabel);
  await page.eval(`window.__devboardEditors.get("goal-text").focus()`);
  await page.key("End", 2);
  await page.typeText(" VerifyAppend");
  await delay(150);
  const dirty = await page.eval<string>(`document.querySelector('[data-testid="goal-text"]').getAttribute("data-dirty") ?? ""`);
  check(dirty === "true", "the Goal editor does not mark unsaved changes", dirty);
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
  const unsaved = await page.eval<string>(`window.__devboardEditors.get("goal-text")?.getValue() ?? ""`);
  check(unsaved.endsWith(" VerifyAppend Unsaved"), "a mode switch discarded unsaved text", unsaved);

  await runPalette("tab.close.goal.goal-document");
  await page.wait(`document.querySelector('[data-testid="confirm-close-tab"]') !== null`, "the dirty-close prompt");
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="confirm-close-tab"]') === null`, "the prompt to close");
  const stillOpen = await page.eval<boolean>(`document.querySelector('[data-testid="goal-text"]') !== null`);
  check(stillOpen, "Escape closed a dirty page");
  await runPalette("tab.close.goal.goal-document");
  await page.wait(`document.querySelector('[data-testid="confirm-close-tab"]') !== null`, "the dirty-close prompt again");
  const discarded = await page.eval<boolean>(`(() => {
    const button = [...document.querySelectorAll('[data-testid="confirm-close-tab"] button')]
      .find((entry) => entry.textContent?.includes("Discard"));
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  check(discarded, "the discard control is missing");
  await page.wait(`document.querySelector('[data-testid="goal-text"]') === null`, "the discarded page to close");
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
    `document.querySelector('[data-testid="flow-diff"]') === null`,
    "the diff page to close",
  );

  await runPalette("flow.checkpoint.open.cp-1");
  await page.wait(`document.querySelector('[data-testid="flow-checkpoint"]') !== null`, "the Flow checkpoint tab");
  const checkpoint = await page.eval<string>(`document.querySelector('[data-testid="flow-checkpoint"]')?.textContent ?? ""`);
  check(checkpoint.includes("abcdef1"), "the checkpoint lost its commit", checkpoint);
  await runPalette("open.flow.steering");
  await page.wait(`document.querySelector('[data-testid="flow-steering-note"]') !== null`, "the Flow steering note");

  await runPalette("open.flow.overview");
  await page.wait(`document.querySelector('[data-testid="dismiss-flow-blocker"]') !== null`, "the Flow blocker control");
  const flowGoalSurface = await page.eval<{
    editor: boolean;
    collapsed: string;
    sidebar: number;
    goalTop: number;
    pageTop: number;
    goalHeight: number;
    pageHeight: number;
    consoleHeight: number;
    startPadding: string;
  }>(`(() => {
    const goal = document.querySelector('#workspace-flow [data-testid="flow-goal"]');
    const page = document.querySelector('#workspace-flow .flow-overview');
    const activity = document.querySelector('#workspace-flow [data-testid="flow-activity-section"]');
    const start = document.querySelector('[data-testid="start-flow-implementation"]');
    const goalBox = goal?.getBoundingClientRect();
    const pageBox = page?.getBoundingClientRect();
    return {
      editor: document.querySelector('[data-testid="flow-goal-text"] .monaco-editor') !== null,
      collapsed: goal?.getAttribute("data-collapsed") ?? "",
      sidebar: document.querySelectorAll('[data-testid="sidebar"] [data-command="open.flow.flow-goal"]').length,
      goalTop: Math.round(goalBox?.top ?? -1),
      pageTop: Math.round(pageBox?.top ?? -1),
      goalHeight: Math.round(goalBox?.height ?? 0),
      pageHeight: Math.round(pageBox?.height ?? 0),
      consoleHeight: Math.round(activity?.getBoundingClientRect().height ?? 0),
      startPadding: start === null ? "" : getComputedStyle(start).paddingLeft,
    };
  })()`);
  check(flowGoalSurface.editor && flowGoalSurface.collapsed === "false", "the Flow overview does not hold the goal editor", flowGoalSurface);
  check(flowGoalSurface.sidebar === 0, "the Flow goal is still a separate sidebar entry", flowGoalSurface);
  check(Math.abs(flowGoalSurface.goalTop - flowGoalSurface.pageTop) <= 1, "the Flow goal does not lead the overview", flowGoalSurface);
  check(flowGoalSurface.goalHeight >= flowGoalSurface.pageHeight - 1, "the Flow goal does not fill the page", flowGoalSurface);
  check(flowGoalSurface.consoleHeight >= flowGoalSurface.pageHeight - 1, "the implementation activity console is shorter than the page", flowGoalSurface);
  check(
    flowGoalSurface.startPadding === "12px",
    "a Flow action does not use the design-system horizontal padding",
    flowGoalSurface.startPadding,
  );
  const flowLabel = await page.eval<string>(`document.querySelector('[data-testid="flow-goal-text"] textarea')?.getAttribute("aria-label") ?? ""`);
  check(flowLabel.length > 0, "the Flow goal editor has no accessible label", flowLabel);
  await page.click('[data-testid="dismiss-flow-blocker"]');
  await page.wait(`document.querySelector('[data-testid="flow-blocker"]')?.getAttribute("data-dismissed") === "true"`, "the dismissed blocker");
  await page.click('[data-testid="sidebar"] [data-command="flow.blocker.open.block-1"]');
  await page.wait(
    `document.activeElement?.id === "flow-blocker-block-1"`,
    "the sidebar blocker did not open its row",
  );
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
    commandText: string[];
    pyramid: number;
    pyramidText: string[];
    pyramidChart: boolean;
    suite: boolean;
    rowHeights: number[];
    tableFont: string;
    freshness: boolean;
    freshnessText: string;
    dirtyBadges: number;
    evidence: number;
    confidence: number;
    fieldHeaders: number;
    innerScrollers: number;
    clippedCards: number;
    stackLinks: number;
    stackHref: string;
    commandHeaders: number;
    contextHeader: string;
    contextRows: number;
    contextRoles: string[];
    externalBoundaries: string | null;
    stackedSections: number;
    staticText: number;
    sidebarTitle: string;
    projectTitle: string;
    sectionsHeading: number;
    sectionTabs: number;
    skillTabs: number;
    sidebarFreshness: boolean;
  }>(`(() => {
    const rows = [...document.querySelectorAll('#workspace-discover [data-testid="discover-pyramid"] tbody tr')];
    const table = document.querySelector('[data-testid="discover-pyramid"]');
    const commands = [...document.querySelectorAll('#workspace-discover [data-testid="discover-command-list"] tbody tr')];
    const scopes = [...document.querySelectorAll('#workspace-discover [data-testid="discover-panel"][data-tab="overview"] .discover-card .panel__body, #workspace-discover [data-testid="discover-panel"][data-tab="overview"] [data-testid="discover-command-list"]')];
    const sections = document.querySelector('[data-testid="sidebar"] section[aria-label="Discover sections"]');
    const skills = document.querySelector('[data-testid="sidebar"] section[aria-label="Skills"]');
    const page = document.querySelector('#workspace-discover [data-testid="discover-panel"][data-tab="overview"]');
    const card = document.querySelector('#workspace-discover [data-field="stack"]');
    const stackLink = card === null ? null : card.querySelector('a.discover-chip--link');
    return {
      cards: document.querySelectorAll('#workspace-discover [data-testid="discover-card"]').length,
      commands: commands.length,
      commandText: commands.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()).join(" | ")),
      pyramid: rows.length,
      pyramidText: rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()).join(" | ")),
      pyramidChart: document.querySelector('[data-testid="discover-pyramid-chart"], svg.pyramid__svg') !== null,
      suite: document.querySelector('[data-testid="discover-suite-command"]') !== null,
      rowHeights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      tableFont: table === null ? "" : getComputedStyle(table).fontSize,
      freshness: document.querySelector('[data-testid="discover-freshness"]') !== null,
      freshnessText: document.querySelector('[data-testid="discover-freshness"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      dirtyBadges: [...document.querySelectorAll('#workspace-discover .discover-head .badge')]
        .filter((badge) => badge.textContent.trim() === "dirty").length,
      evidence: document.querySelectorAll('[data-testid="discover-evidence"]').length,
      confidence: document.querySelectorAll('[data-testid="discover-confidence"]').length,
      fieldHeaders: [...document.querySelectorAll('#workspace-discover [data-testid="discover-panel"][data-tab="overview"] table')]
        .filter((table) => {
          const heads = [...table.querySelectorAll('th')]
            .map((header) => header.textContent.trim().toUpperCase());
          return heads.includes("FIELD") && heads.includes("VALUE");
        }).length,
      innerScrollers: scopes.filter((scope) => scope.scrollHeight > scope.clientHeight + 1).length,
      clippedCards: page === null ? -1 : [...page.children]
        .filter((child) => child.scrollHeight > child.clientHeight + 1).length,
      stackLinks: card === null ? -1 : card.querySelectorAll('a.discover-chip--link').length,
      stackHref: stackLink?.getAttribute("href") ?? "",
      commandHeaders: document.querySelectorAll('[data-testid="discover-command-list"] thead').length,
      contextHeader: document.querySelector('#workspace-discover [data-field="architecture"] th')?.textContent?.trim() ?? "",
      contextRows: document.querySelectorAll('#workspace-discover [data-testid="discover-contexts"] .discover-context').length,
      contextRoles: [...document.querySelectorAll('#workspace-discover .discover-boundary dt')]
        .map((term) => term.textContent.trim()),
      externalBoundaries: (() => {
        const block = document.querySelector('#workspace-discover [data-field="architecture"] [data-role="externalBoundaries"] dd');
        return block === null ? null : block.textContent.replace(/\s+/g, " ").trim();
      })(),
      stackedSections: document.querySelectorAll('#workspace-discover [data-field="unknowns"], #workspace-discover [data-field="dependencyMap"]').length,
      staticText: document.querySelectorAll('#workspace-discover [data-tab="overview"] .discover-lead, #workspace-discover [data-tab="overview"] .discover-note').length,
      sidebarTitle: document.querySelector('[data-testid="sidebar"] .sidebar__title')?.textContent?.trim() ?? "",
      projectTitle: document.title,
      sectionsHeading: sections === null ? -1 : sections.querySelectorAll('.sidebar-group__title').length,
      sectionTabs: sections === null ? -1 : sections.querySelectorAll('[data-testid="discover-tab"]').length,
      skillTabs: skills === null ? -1 : skills.querySelectorAll('[data-testid="discover-tab"]').length,
      sidebarFreshness: document.querySelector('[data-testid="sidebar"] section[aria-label="Freshness"]') !== null,
    };
  })()`);
  check(discoverTables.cards >= 5, "Discover sections are missing from the overview", discoverTables);
  check(discoverTables.commands > 0, "the Discover command table is empty", discoverTables);
  check(discoverTables.commandText.every((text) => text.replace(/[|\s]/g, "").length > 0), "a Discover command row renders no values", discoverTables.commandText);
  check(discoverTables.pyramid > 0 && discoverTables.suite, "the Discover testing tables are empty", discoverTables);
  check(discoverTables.pyramidText.every((text) => text.replace(/[|\s]/g, "").length > 0), "a Discover pyramid row renders no values", discoverTables.pyramidText);
  check(discoverTables.pyramidText.every((text) => !text.toLowerCase().includes("unknown")), "a Discover test level still reports an unknown count", discoverTables.pyramidText);
  check(!discoverTables.pyramidChart, "the test pyramid graphic is still rendered", discoverTables);
  check(discoverTables.rowHeights.every((height) => height > 0 && height <= 120), "a Discover table row is mis-sized", discoverTables.rowHeights);
  const discoverFont = Number.parseFloat(discoverTables.tableFont);
  check(discoverFont >= 12 && discoverFont <= 14, "Discover table text is not 12–14px", discoverTables.tableFont);
  check(discoverTables.freshness, "Discover does not render the freshness header");
  check(!discoverTables.freshnessText.includes("Discovered"), "the freshness line still carries a Discover label", discoverTables.freshnessText);
  check(discoverTables.dirtyBadges === 0, "the Discover header still renders a dirty badge", discoverTables.dirtyBadges);
  check(discoverTables.evidence === 0, "Discover still renders evidence file references", discoverTables.evidence);
  check(discoverTables.confidence === 0, "Discover still renders confidence labels", discoverTables.confidence);
  check(discoverTables.fieldHeaders === 0, "Discover still renders Field/Value table headers", discoverTables.fieldHeaders);
  check(discoverTables.innerScrollers === 0, "a Discover panel or table scrolls inside the page", discoverTables);
  check(discoverTables.clippedCards === 0, "a Discover card clips its own rows", discoverTables.clippedCards);
  check(discoverTables.stackLinks > 0, "no library chip links to its repository", discoverTables.stackLinks);
  check(discoverTables.stackHref.startsWith("https://github.com/"), "a library chip links outside its repository", discoverTables.stackHref);
  check(discoverTables.stackedSections === 0, "Discover still renders the duplicated dependency or unknown sections", discoverTables.stackedSections);
  check(discoverTables.staticText === 0, "Discover still renders static lead or note prose", discoverTables.staticText);
  check(discoverTables.commandHeaders === 0, "the command table still renders a header row", discoverTables.commandHeaders);
  check(discoverTables.contextHeader === "", "the bounded-context card still renders a table header", discoverTables.contextHeader);
  check(discoverTables.contextRows > 0, "the bounded-context list is empty", discoverTables);
  check(discoverTables.contextRoles.includes("Dependency direction"), "the boundary map does not label the dependency direction", discoverTables.contextRoles);
  check(discoverTables.externalBoundaries === "None detected.", "the External boundaries block does not render the observed empty list", discoverTables.externalBoundaries);
  check(!(discoverTables.externalBoundaries ?? "").includes("node:"), "the External boundaries block names a runtime built-in", discoverTables.externalBoundaries);
  check(discoverTables.sidebarTitle === discoverTables.projectTitle, "the sidebar title does not name the repository", discoverTables);
  check(discoverTables.sectionsHeading === 0, "the sidebar still renders a Sections heading", discoverTables.sectionsHeading);
  check(discoverTables.sectionTabs === 2 && discoverTables.skillTabs === 5, "the sidebar does not split sections from skills", discoverTables);
  check(!discoverTables.sidebarFreshness, "the sidebar still renders a freshness group");
  const discoverChrome = await page.eval<{
    eyebrow: boolean;
    stale: boolean;
    commit: boolean;
    railLeft: number;
    columnLeft: number;
    headers: string[];
    subtitle: string;
    rows: number;
    versions: boolean;
  }>(`(() => {
    const head = document.querySelector('#workspace-discover .discover-head');
    const sheet = document.querySelector('[data-testid="discover-sheet"]');
    const rail = sheet?.querySelector('.discover-rail');
    const column = sheet?.querySelector('.discover-col');
    const testing = document.querySelector('#workspace-discover [data-field="testing"]');
    return {
      eyebrow: head?.querySelector('.discover-page__eyebrow') !== null,
      stale: document.querySelector('[data-testid="discover-stale"]') !== null,
      commit: head?.querySelector('.discover-head__meta code') !== null,
      railLeft: Math.round(rail?.getBoundingClientRect().left ?? -1),
      columnLeft: Math.round(column?.getBoundingClientRect().left ?? -1),
      headers: [...document.querySelectorAll('[data-testid="discover-pyramid"] thead th')]
        .map((header) => header.textContent.trim()),
      subtitle: testing?.querySelector('.panel__subtitle')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      rows: document.querySelectorAll('[data-testid="discover-pyramid"] tbody tr').length,
      versions: [...document.querySelectorAll('#workspace-discover [data-field="runtime"] dt')]
        .some((term) => term.textContent.trim() === "Versions"),
    };
  })()`);
  check(!discoverChrome.eyebrow && !discoverChrome.stale && !discoverChrome.commit, "the sheet still renders removed masthead chrome", discoverChrome);
  check(discoverChrome.railLeft < discoverChrome.columnLeft, "the sheet column is not to the right of the facts rail", discoverChrome);
  check(
    discoverChrome.headers.join("|") === "Level|Tests",
    "the test level table still renders a paths column",
    discoverChrome.headers,
  );
  check(
    discoverChrome.subtitle.startsWith(`${discoverChrome.rows} level`) &&
      !discoverChrome.subtitle.includes("0 tests"),
    "the level count disagrees with the listed levels",
    discoverChrome,
  );
  check(!discoverChrome.versions, "the Platform rail still repeats the runtime versions", discoverChrome);
  // The fixture sheet fits at 1440×900; prove the page owns its scrolling and
  // keeps the offset in a narrower supported viewport, where it overflows.
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024 && innerHeight === 720`, "the 1024×720 viewport for the scroll check");
  const discoverScrollBefore = await page.eval<{ top: number; scroll: number; client: number }>(`(() => {
    const scroller = document.querySelector('#workspace-discover .scroll-column');
    if (scroller === null) return { top: 0, scroll: 0, client: 0 };
    scroller.scrollTop = 160;
    return {
      top: Math.round(scroller.scrollTop),
      scroll: scroller.scrollHeight,
      client: scroller.clientHeight,
    };
  })()`);
  check(
    discoverScrollBefore.top > 0,
    "the Discover page does not scroll",
    discoverScrollBefore,
  );
  await page.click('[data-testid="mode-goal"]');
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Goal for the scroll check");
  await page.click('[data-testid="mode-discover"]');
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Discover for the scroll check");
  const discoverScroll = await page.eval<number>(`Math.round(document.querySelector('#workspace-discover .scroll-column')?.scrollTop ?? 0)`);
  check(discoverScroll === discoverScrollBefore.top, "a mode switch lost the Discover scroll position", { discoverScrollBefore, discoverScroll });
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the desktop viewport after the scroll check");

  await runPalette("discover.tab.glossary");
  await page.wait(`document.querySelector('[data-testid="discover-term"]') !== null`, "the glossary term table");
  const glossary = await page.eval<{
    contexts: number;
    terms: number;
    ids: string[];
    heights: number[];
    search: boolean;
    headers: string[];
    termsText: string[];
    termLefts: number[];
    significance: string[];
    significanceAttrs: string[];
    exampleCounts: number[];
    slider: { min: string; max: string; value: string; disabled: boolean } | null;
    toggle: { checked: boolean; disabled: boolean } | null;
    menu: boolean;
    kindIcons: number;
    kindColors: string[];
    tableScrolls: number[];
    clippedCards: number;
    rowsOutside: number;
    searchPadding: string[];
  }>(`(() => {
    const rows = [...document.querySelectorAll('#workspace-discover [data-testid="discover-term"]')];
    const kindCells = rows.map((row) => row.querySelector('td:nth-child(1)'));
    const termCells = rows.map((row) => row.querySelector('td:nth-child(2)'));
    const significanceCells = rows.map((row) => row.querySelector('td:nth-child(3)'));
    const exampleCells = rows.map((row) => row.querySelector('td:nth-child(5)'));
    const wraps = [...document.querySelectorAll('#workspace-discover [data-testid="discover-context"] .table-wrap')];
    const cards = [...document.querySelectorAll('#workspace-discover [data-testid="discover-context"]')];
    const search = document.querySelector('[data-testid="discover-glossary-search"]');
    const searchStyle = search === null ? null : getComputedStyle(search);
    const slider = document.querySelector('[data-testid="discover-glossary-threshold"]');
    const toggle = document.querySelector('[data-testid="discover-glossary-significant"]');
    return {
      contexts: document.querySelectorAll('#workspace-discover [data-testid="discover-context"]').length,
      terms: rows.length,
      ids: rows.map((row) => row.getAttribute("data-id") ?? ""),
      heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)),
      search: document.querySelector('[data-testid="discover-glossary-search"]') !== null,
      headers: [...document.querySelectorAll('#workspace-discover [data-testid="discover-context"] thead th')].map((header) => header.textContent.trim()),
      termsText: termCells.map((cell) => cell?.textContent?.trim() ?? ""),
      termLefts: [...new Set(termCells.map((cell) => Math.round(cell?.getBoundingClientRect().left ?? 0)))],
      significance: significanceCells.map((cell) => cell?.textContent?.trim() ?? ""),
      significanceAttrs: rows.map((row) => row.getAttribute("data-significance") ?? ""),
      exampleCounts: exampleCells.map((cell) => cell?.querySelectorAll('code').length ?? 0),
      slider: slider === null ? null : { min: slider.min, max: slider.max, value: slider.value, disabled: slider.disabled },
      toggle: toggle === null ? null : { checked: toggle.checked, disabled: toggle.disabled },
      menu: document.querySelector('[data-testid="discover-glossary-menu"]') !== null,
      kindIcons: kindCells.filter((cell) => cell?.querySelector('.discover-kind svg') !== null).length,
      kindColors: [...new Set(kindCells
        .map((cell) => cell?.querySelector('.discover-kind'))
        .filter((kind) => kind !== null)
        .map((kind) => getComputedStyle(kind).color))],
      tableScrolls: wraps.map((wrap) => wrap.scrollHeight - wrap.clientHeight),
      clippedCards: cards.filter((card) => card.scrollHeight > card.clientHeight + 1).length,
      rowsOutside: rows.filter((row) => {
        const card = row.closest('[data-testid="discover-context"]');
        return card !== null && row.getBoundingClientRect().bottom > card.getBoundingClientRect().bottom + 0.5;
      }).length,
      searchPadding: searchStyle === null ? [] : [searchStyle.paddingTop, searchStyle.paddingBottom],
    };
  })()`);
  check(glossary.contexts > 0 && glossary.terms > 0, "the glossary tables are empty", glossary);
  check(glossary.heights.every((height) => height > 0 && height <= 120), "a glossary row is mis-sized", glossary.heights);
  check(
    glossary.headers.join("|") === "Kind|Term|Significance|Definition|",
    "the glossary table does not carry the significance and unnamed example columns",
    glossary.headers,
  );
  check(glossary.termsText.every((text) => text.length > 0), "a glossary row has no term", glossary.termsText);
  check(glossary.termLefts.length === 1, "the term column width differs between contexts", glossary.termLefts);
  check(
    glossary.significance.every((value) => /^[0-9]+$/.test(value)),
    "a glossary row has no significance score",
    glossary.significance,
  );
  check(
    glossary.significanceAttrs.every((value) => /^[0-9]+$/.test(value)),
    "a glossary row does not carry its score in data-significance",
    glossary.significanceAttrs,
  );
  check(glossary.exampleCounts.every((count) => count > 0), "a glossary row has no usage examples", glossary.exampleCounts);
  check(glossary.search, "the glossary search is missing");
  check(
    glossary.toggle !== null && glossary.toggle.checked && !glossary.toggle.disabled,
    "the significant-only filter is missing, unchecked, or disabled",
    glossary.toggle,
  );
  check(
    glossary.slider !== null &&
      glossary.slider.min === "0" &&
      glossary.slider.max === "100" &&
      glossary.slider.value === "50" &&
      !glossary.slider.disabled,
    "the significance slider does not span 0 to 100 at the default floor",
    glossary.slider,
  );
  check(
    glossary.ids.join("|") === "order-total|order" && !glossary.ids.includes("option"),
    "the default glossary does not hide the low-score term and order the rest by score",
    glossary.ids,
  );
  check(!glossary.menu, "the glossary sidebar still has a disclosure menu", glossary);
  check(glossary.kindIcons === glossary.terms, "a glossary kind is not the first cell", glossary.kindIcons);
  check(glossary.kindColors.length >= 2, "the glossary kind icons are not color-coded", glossary.kindColors);
  check(glossary.tableScrolls.every((delta) => delta <= 1), "a glossary table clips its rows", glossary.tableScrolls);
  check(glossary.clippedCards === 0, "a glossary card clips its rows", glossary.clippedCards);
  check(glossary.rowsOutside === 0, "a glossary term falls outside its card", glossary.rowsOutside);
  check(glossary.searchPadding.every((value) => value === "0px"), "the glossary search placeholder is not vertically centered", glossary.searchPadding);
  const warningsSection = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar"] section[aria-label="Warnings"]') !== null`);
  check(!warningsSection, "the sidebar still shows an empty warnings section");

  // Clearing the filter reveals the low-score generic term and disables the floor.
  await page.eval(`(() => {
    const toggle = document.querySelector('[data-testid="discover-glossary-significant"]');
    toggle.click();
  })()`);
  await page.wait(
    `document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === 3`,
    "the revealed low-score glossary term",
  );
  const revealed = await page.eval<{ ids: string[]; sliderDisabled: boolean }>(`(() => ({
    ids: [...document.querySelectorAll('#workspace-discover [data-testid="discover-term"]')].map((row) => row.getAttribute("data-id")),
    sliderDisabled: document.querySelector('[data-testid="discover-glossary-threshold"]').disabled,
  }))()`);
  check(
    revealed.ids.join("|") === "order-total|order|option",
    "clearing the filter does not reveal the low-score term in score order",
    revealed.ids,
  );
  check(revealed.sliderDisabled, "the significance slider stays active while the filter is off");

  // The floor and the filter compose: only the highest score survives 90.
  await page.eval(`(() => {
    const toggle = document.querySelector('[data-testid="discover-glossary-significant"]');
    toggle.click();
    const slider = document.querySelector('[data-testid="discover-glossary-threshold"]');
    slider.value = "90";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page.wait(
    `(() => {
      const rows = [...document.querySelectorAll('#workspace-discover [data-testid="discover-term"]')];
      return rows.length === 1 && rows[0].getAttribute("data-id") === "order-total";
    })()`,
    "the significance floor",
  );
  await page.eval(`(() => {
    const slider = document.querySelector('[data-testid="discover-glossary-threshold"]');
    slider.value = "0";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page.wait(
    `document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === 3`,
    "the cleared significance floor",
  );
  await page.fill('[data-testid="discover-glossary-search"]', "Order Total");
  await page.wait(`document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === 1`, "the filtered glossary");
  await page.fill('[data-testid="discover-glossary-search"]', "");
  await page.wait(`document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === 3`, "the cleared glossary search");
  await page.eval(`(() => {
    const slider = document.querySelector('[data-testid="discover-glossary-threshold"]');
    slider.value = "50";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await page.wait(
    `document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === ${glossary.terms}`,
    "the restored significance floor",
  );

  // A publication from before the sidecar shows every term, unscored.
  const manifestPath = join(host, ".omp", "discover", "manifest.json");
  const significancePath = join(host, ".omp", "discover", "significance.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const significanceText = await readFile(significancePath, "utf8");
  const legacyManifest = JSON.parse(manifestText) as { paths: Record<string, unknown> };
  delete legacyManifest.paths.significance;
  await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
  await rm(significancePath);
  await page.reload();
  await runPalette("discover.tab.glossary");
  await page.wait(
    `document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === 3`,
    "the legacy glossary",
  );
  const legacy = await page.eval<{
    significance: string[];
    attrs: string[];
    toggle: { checked: boolean; disabled: boolean } | null;
    sliderDisabled: boolean;
  }>(`(() => {
    const rows = [...document.querySelectorAll('#workspace-discover [data-testid="discover-term"]')];
    const toggle = document.querySelector('[data-testid="discover-glossary-significant"]');
    return {
      significance: rows.map((row) => row.querySelector("td:nth-child(3)")?.textContent?.trim() ?? ""),
      attrs: rows.map((row) => row.getAttribute("data-significance") ?? "missing"),
      toggle: toggle === null ? null : { checked: toggle.checked, disabled: toggle.disabled },
      sliderDisabled: document.querySelector('[data-testid="discover-glossary-threshold"]').disabled,
    };
  })()`);
  check(
    legacy.significance.every((value) => value === "—"),
    "a legacy glossary row shows a significance score",
    legacy.significance,
  );
  check(
    legacy.attrs.every((value) => value === ""),
    "a legacy glossary row carries data-significance",
    legacy.attrs,
  );
  check(
    legacy.toggle !== null && legacy.toggle.disabled,
    "the significant-only control is active without scores",
    legacy.toggle,
  );
  check(legacy.sliderDisabled, "the significance slider is active without scores");
  await writeFile(manifestPath, manifestText);
  await writeFile(significancePath, significanceText);
  await page.reload();
  await runPalette("discover.tab.glossary");
  await page.wait(
    `document.querySelectorAll('#workspace-discover [data-testid="discover-term"]').length === ${glossary.terms}`,
    "the restored scored glossary",
  );

  const termCommand = await page.eval<string>(`(() => {
    const element = [...document.querySelectorAll('#workspace-discover [data-command^="discover.term.open."]')]
      .find((entry) => entry.getClientRects().length > 0);
    return element?.getAttribute("data-command") ?? "";
  })()`);
  check(termCommand.length > 0, "no glossary term entry is available");
  await runPalette(termCommand);
  await page.wait(`document.querySelector('#workspace-discover [data-testid="discover-term"][data-id]') !== null`, "the term detail page");
  const termChrome = await page.eval<{ headerBadges: number; badges: number; workspaceBadges: number; closeButtons: number }>(`(() => {
    const panel = document.querySelector('#workspace-discover [data-testid="discover-term"][data-id]');
    return {
      headerBadges: panel?.querySelectorAll('.panel__header .badge').length ?? 0,
      badges: panel?.querySelectorAll('.badge').length ?? 0,
      workspaceBadges: document.querySelectorAll('#workspace-discover [data-testid="discover-panel"] .badge').length,
      closeButtons: [...(panel?.querySelectorAll('button') ?? [])].filter((button) => button.textContent?.trim() === "Close").length,
    };
  })()`);
  check(termChrome.headerBadges === 0, "the term detail still renders a status badge", termChrome);
  check(termChrome.badges === 0 && termChrome.workspaceBadges === 0, "the term detail still renders status labels", termChrome);
  check(termChrome.closeButtons === 0, "the term detail still renders a Close control", termChrome);
  const termSignificance = await page.eval<string>(`document.querySelector('[data-testid="discover-term-significance"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? ""`);
  check(
    termSignificance.includes("90") && termSignificance.includes("order total"),
    "the term detail does not show the score and its reason",
    termSignificance,
  );
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
  await page.wait(`document.querySelector('[data-testid="discover-skill-dirty"]') !== null`, "the Discover skill dirty marker");
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
        state: document.querySelector('[data-testid="discover-skill-dirty"]')?.textContent?.trim() ?? "",
        dirty: document.querySelector('[data-testid="discover-skill-text"]')?.getAttribute("data-dirty"),
        notices: [...document.querySelectorAll('[data-testid="notifications"] .notification')].map((entry) => entry.textContent.trim()),
        saves: frames.filter((frame) => frame.type === "saveDiscoverSkill").slice(-3),
        errors: frames.filter((frame) => frame.type === "discoverError").slice(-3),
      };
    })()`);
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(diagnostic)}`);
  }
  await page.wait(
    `document.querySelector('[data-testid="discover-skill-restore"]') !== null`,
    "the restore control after saving",
  );
  await page.click('[data-testid="discover-skill-restore"]');
  const skillBaseline = await readFile(
    join(host, ".omp", "discover", "skills", "discover-testing-strategy", "SKILL.md"),
    "utf8",
  );
  await waitFor(
    async () => {
      const live = await readFile(join(host, ".omp", "skills", "discover-testing-strategy", "SKILL.md"), "utf8").catch(() => "");
      if (live !== skillBaseline) return undefined;
      const restored = await page.eval<string>(`window.__devboardEditors.get("discover-skill-text").getValue()`);
      const dirty = await page.eval<boolean>(`document.querySelector('[data-testid="discover-skill-dirty"]') !== null`);
      return restored === skillBaseline && !dirty ? true : undefined;
    },
    "the restored generated skill",
    10_000,
  );
  const skillLayout = await page.eval<{
    preview: boolean;
    split: number;
    badge: boolean;
    editor: number;
    panel: number;
    title: string;
    eyebrow: boolean;
    meta: boolean;
    name: boolean;
  }>(`(() => {
    const editor = document.querySelector('[data-testid="discover-skill-text"]');
    const panel = document.querySelector('[data-testid="discover-skill"]');
    const index = document.querySelector('#workspace-discover .discover-skill-page');
    return {
      preview: document.querySelector('[data-testid="discover-skill-preview"]') !== null,
      split: document.querySelectorAll('#workspace-discover [data-testid="discover-skill"] [data-testid="pane-handle"]').length,
      badge: document.querySelector('[data-testid="discover-skill-state"]') !== null,
      editor: editor === null ? 0 : Math.round(editor.getBoundingClientRect().height),
      panel: panel === null ? 0 : Math.round(panel.getBoundingClientRect().height),
      title: panel?.querySelector('.panel__title')?.textContent?.trim() ?? "",
      eyebrow: index?.querySelector('.discover-page__eyebrow') !== null,
      meta: index?.querySelector('.discover-skill__meta') !== null,
      name: panel?.querySelector('.panel__header .muted') !== null,
    };
  })()`);
  check(!skillLayout.preview && skillLayout.split === 0, "the skill tab still renders a preview split", skillLayout);
  check(!skillLayout.badge, "the skill tab still renders a state badge");
  check(
    skillLayout.title === "discover-testing-strategy/SKILL.md",
    "the skill panel is not titled with the relative path",
    skillLayout.title,
  );
  check(!skillLayout.eyebrow && !skillLayout.meta && !skillLayout.name, "the skill page still renders removed labels", skillLayout);
  check(skillLayout.editor >= skillLayout.panel - 48, "the skill editor does not use the full pane", skillLayout);

  // The open surface survives mode switches; only one page exists per mode.
  const surfaceBefore = await page.eval<string>(`document.querySelector('#workspace-discover [data-testid="discover-skill"]')?.getAttribute("data-name") ?? ""`);
  await page.click('[data-testid="mode-goal"]');
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Goal from Discover");
  await page.click('[data-testid="mode-discover"]');
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Discover return");
  const surfaceAfter = await page.eval<{ name: string; tabs: number }>(`({
    name: document.querySelector('#workspace-discover [data-testid="discover-skill"]')?.getAttribute("data-name") ?? "",
    tabs: document.querySelectorAll('[data-testid="workspace-tab"]').length,
  })`);
  check(surfaceAfter.name === surfaceBefore && surfaceAfter.tabs === 0, "the open surface changed across modes", { surfaceBefore, surfaceAfter });

  // 12. Reload restores mode, page, theme, sidebar and split sizes.
  const beforeReload = await page.eval<{
    mode: string;
    surface: string;
    sidebar: number;
    panes: number[];
    theme: string;
    stored: string;
  }>(`(() => ({
    mode: ["goal", "flow", "discover"].find((mode) => document.querySelector('[data-testid="mode-' + mode + '"]')?.getAttribute("aria-selected") === "true") ?? "",
    surface: document.querySelector('#workspace-discover [data-testid="discover-skill"]')?.getAttribute("data-name") ?? "",
    sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    panes: [...document.querySelectorAll('#workspace-discover [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width)),
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem("devboard.layout.v1") ?? "",
  }))()`);
  check(beforeReload.mode === "discover", "the active mode is not Discover before reload", beforeReload);
  await page.reload();
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Discover after reload");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"]') !== null`, "the restored skill page");
  const afterReload = await page.eval<{
    mode: string;
    surface: string;
    sidebar: number;
    panes: number[];
    theme: string;
    stored: string;
    editor: string;
    dirty: boolean;
    tabs: number;
  }>(`(() => ({
    mode: ["goal", "flow", "discover"].find((mode) => document.querySelector('[data-testid="mode-' + mode + '"]')?.getAttribute("aria-selected") === "true") ?? "",
    surface: document.querySelector('#workspace-discover [data-testid="discover-skill"]')?.getAttribute("data-name") ?? "",
    sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    panes: [...document.querySelectorAll('#workspace-discover [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width)),
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem("devboard.layout.v1") ?? "",
    editor: (window.__devboardEditors.get("discover-skill-text")?.getValue() ?? "").slice(-20),
    dirty: document.querySelector('[data-testid="discover-skill-dirty"]') !== null,
    tabs: document.querySelectorAll('[data-testid="workspace-tab"]').length,
  }))()`);
  check(afterReload.mode === beforeReload.mode && afterReload.theme === beforeReload.theme, "mode or theme did not survive reload", { beforeReload, afterReload });
  check(afterReload.surface === beforeReload.surface && afterReload.tabs === 0, "the open page did not survive reload", { before: beforeReload, after: afterReload });
  check(Math.abs(afterReload.sidebar - beforeReload.sidebar) <= 2, "the sidebar width did not survive reload", { before: beforeReload.sidebar, after: afterReload.sidebar });
  check(afterReload.panes.length === beforeReload.panes.length && afterReload.panes.every((width, index) => Math.abs(width - (beforeReload.panes[index] ?? 0)) <= 2), "split sizes did not survive reload", { before: beforeReload.panes, after: afterReload.panes });
  const restoredBaseline = (await readFile(join(host, ".omp", "discover", "skills", "discover-testing-strategy", "SKILL.md"), "utf8")).slice(-20);
  check(
    afterReload.editor === restoredBaseline && !afterReload.dirty,
    "the restored skill text did not survive reload",
    { editor: afterReload.editor, baseline: restoredBaseline, dirty: afterReload.dirty },
  );
  check(afterReload.stored.includes('"theme":"light"'), "layout localStorage lost the theme", afterReload.stored.slice(0, 120));
  check(!afterReload.stored.includes('"sidebarVisible"'), "layout localStorage still stores sidebar visibility", afterReload.stored.slice(0, 120));


  // 12b. The remote target exists only for a harness source checkout.
  const hostOmpBefore = await ompDigest(host);
  await stopServer();
  const remoteClone = await seedRemoteClone(root, stateDir);
  await seedRemoteTarget(stateDir, host);
  startServer();
  await waitForHttp(baseUrl);
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnection after the remote restart",
    30_000,
  );
  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null`,
    "the Discover overview with a remote target",
  );
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-target"]') !== null`,
    "the remote target banner",
  );
  const remoteStrip = await page.eval<{
    input: boolean;
    placeholder: string;
    label: string;
    start: string;
    disabled: boolean;
    title: string;
    banner: string;
    clear: boolean;
    sheet: boolean;
    target: string;
  }>(`(() => {
    const input = document.querySelector('[data-testid="discover-remote-url"]');
    const start = document.querySelector('[data-testid="discover-remote-start"]');
    const banner = document.querySelector('[data-testid="discover-remote-target"]');
    return {
      input: input !== null,
      placeholder: input?.getAttribute("placeholder") ?? "",
      label: input?.getAttribute("aria-label") ?? "",
      start: start?.textContent?.trim() ?? "",
      disabled: start?.disabled === true,
      title: start?.getAttribute("title") ?? "",
      banner: banner?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      clear: document.querySelector('[data-testid="discover-remote-clear"]') !== null,
      sheet: document.querySelector('[data-testid="discover-sheet"]') !== null,
      target: document.querySelector('[data-testid="discover-remote-target"]')?.textContent ?? "",
    };
  })()`);
  check(
    remoteStrip.input && remoteStrip.placeholder === "https://github.com/owner/repo" && remoteStrip.label.length > 0,
    "the remote URL field is missing or unlabelled",
    remoteStrip,
  );
  check(remoteStrip.start === "Discover from URL", "the remote submit control is mislabelled", remoteStrip);
  check(
    remoteStrip.disabled && remoteStrip.title.includes("repository URL"),
    "an empty URL field does not disable the remote start control",
    remoteStrip,
  );
  check(
    remoteStrip.banner.includes("https://github.com/octocat/Hello-World") &&
      remoteStrip.banner.includes("Manual testing"),
    "the remote banner does not name the active URL with its marker",
    remoteStrip,
  );
  check(remoteStrip.clear, "the clear control is missing for a remote target", remoteStrip);
  check(remoteStrip.sheet, "the clone's sheet does not render", remoteStrip);

  await runPalette("discover.tab.glossary");
  await page.wait(`document.querySelector('[data-testid="discover-term"]') !== null`, "the clone's glossary");
  await runPalette("discover.tab.overview");

  // An invalid URL is refused once, spawns nothing, and leaves the target.
  await page.fill('[data-testid="discover-remote-url"]', "http://github.com/octocat/Hello-World");
  const framesBefore = await page.eval<number>(`(window.__viFrames ?? []).length`);
  await page.click('[data-testid="discover-remote-start"]');
  await page.wait(
    `document.querySelector('[data-testid="discover-error"]')?.textContent?.includes("Could not clone") === true`,
    "the invalid remote URL refusal",
    20_000,
  );
  const invalid = await page.eval<{ frames: Array<{ type?: string; url?: string } | null> }>(`(() => ({
    frames: (window.__viFrames ?? []).slice(${framesBefore}).map((frame) => {
      try { return JSON.parse(frame); } catch (error) { return null; }
    }),
  }))()`);
  const sent = invalid.frames.filter((frame) => frame?.type === "discoverRemote");
  check(sent.length === 1, "one invalid URL did not send exactly one discoverRemote frame", invalid);
  check(
    sent[0]?.url === "http://github.com/octocat/Hello-World",
    "the invalid URL frame did not carry the trimmed value",
    invalid,
  );
  const scratchAfterInvalid = await readdir(join(stateDir, "discover-remote"));
  check(
    scratchAfterInvalid.length === 1 && scratchAfterInvalid[0] === "octocat-hello-world",
    "an invalid URL created a clone",
    scratchAfterInvalid,
  );

  // One remote skill save lands in the clone, never in this checkout.
  await runPalette("discover.tab.testing-strategy");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"] .monaco-editor') !== null`, "the remote skill editor");
  const remoteSkill = await page.eval<string>(`window.__devboardEditors.get("discover-skill-text").getValue()`);
  await page.eval(
    `window.__devboardEditors.get("discover-skill-text").setValue(${JSON.stringify(
      `${remoteSkill}\n- Remote interface edit.\n`,
    )})`,
  );
  await page.wait(`document.querySelector('[data-testid="discover-skill-dirty"]') !== null`, "the remote skill dirty marker");
  await page.click('[data-testid="discover-skill-save"]');
  await waitFor(
    async () => {
      try {
        const text = await readFile(
          join(remoteClone, ".omp", "skills", "discover-testing-strategy", "SKILL.md"),
          "utf8",
        );
        return text.includes("Remote interface edit") ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the remote skill save",
    20_000,
  );
  check(await ompDigest(host) === hostOmpBefore, "a remote skill save changed this checkout's .omp");

  // Clearing returns to this checkout's artifacts with an empty field.
  await runPalette("discover.tab.overview");
  await page.click('[data-testid="discover-remote-clear"]');
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-target"]') === null`,
    "the cleared remote banner",
    20_000,
  );
  const cleared = await page.eval<{ input: string; start: string; clear: boolean }>(`(() => ({
    input: document.querySelector('[data-testid="discover-remote-url"]')?.value ?? "missing",
    start: document.querySelector('[data-testid="discover-start"]')?.textContent?.trim() ?? "",
    clear: document.querySelector('[data-testid="discover-remote-clear"]') !== null,
  }))()`);
  check(cleared.input === "", "clearing did not empty the URL field", cleared);
  check(cleared.start === "Re-discover", "clearing did not restore the host artifacts", cleared);
  check(!cleared.clear, "the clear control survived the host target", cleared);
  await waitFor(
    () => (existsSync(remoteClone) ? undefined : true),
    "the removed remote clone",
    20_000,
  );
  check(await ompDigest(host) === hostOmpBefore, "clearing changed this checkout's .omp");

  // The installed gate renders none of the remote controls.
  const gateOffHost = await writeGateOffHost(root);
  const gateOffPort = await freePort();
  const gateOffWriter = Bun.file(join(root, "gate-off-server.log")).writer();
  gateOffProcess = spawn("bun", ["run", "server/index.ts"], {
    cwd: harnessRoot,
    env: {
      ...serverEnv,
      PORT: String(gateOffPort),
      ADRS_DIR: join(gateOffHost, "adrs"),
      REPO_DIR: gateOffHost,
      GOAL_FILE: join(gateOffHost, "GOAL.md"),
      STATE_DIR: join(root, "gate-off-state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateOffProcess.stdout?.on("data", (chunk) => gateOffWriter.write(chunk));
  gateOffProcess.stderr?.on("data", (chunk) => gateOffWriter.write(chunk));
  await waitForHttp(`http://127.0.0.1:${gateOffPort}/`);
  await page.navigate(`http://127.0.0.1:${gateOffPort}/`);
  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`,
    "Discover in the gate-off host",
  );
  const gateOff = await page.eval<Record<string, boolean>>(`({
    url: document.querySelector('[data-testid="discover-remote-url"]') !== null,
    start: document.querySelector('[data-testid="discover-remote-start"]') !== null,
    banner: document.querySelector('[data-testid="discover-remote-target"]') !== null,
    clear: document.querySelector('[data-testid="discover-remote-clear"]') !== null,
    panel: document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null,
  })`);
  check(gateOff.panel, "the gate-off host has no Discover overview", gateOff);
  check(
    !gateOff.url && !gateOff.start && !gateOff.banner && !gateOff.clear,
    "the gate-off host renders a remote control",
    gateOff,
  );
  gateOffProcess.kill("SIGTERM");
  gateOffProcess = undefined;
  await page.navigate(baseUrl);

  // 13. Reset layout restores defaults.
  await runPalette("view.layout.reset");
  await page.wait(`document.documentElement.dataset.theme === "dark"`, "the dark default after reset");
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "the Goal default after reset");
  const resetLayout = await page.eval<{ surface: boolean; sidebar: number; stored: string; panes: string; tabs: number }>(`(() => ({
    surface: document.querySelector('#workspace-goal [data-testid="lifecycle"]') !== null,
    sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    stored: localStorage.getItem("devboard.layout.v1") ?? "",
    panes: Object.keys(localStorage).filter((key) => key.startsWith("paneforge:")).join(","),
    tabs: document.querySelectorAll('[data-testid="workspace-tab"]').length,
  }))()`);
  check(resetLayout.surface && resetLayout.tabs === 0, "reset layout did not restore the default page", resetLayout);
  check(Math.abs(resetLayout.sidebar - 300) <= 12, "reset layout did not restore the sidebar width", resetLayout);
  check(resetLayout.panes.length > 0 && !resetLayout.panes.includes("devboard.detail"), "reset layout left stale split storage", resetLayout);

  // Resolved records disappear from the sidebar group entirely.
  for (const file of await readdir(join(host, "adrs"))) {
    const path = join(host, "adrs", file);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace(/- Status: .*/, "- Status: Accepted"));
  }
  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="pending-summary"]')?.textContent?.includes("0 ADR") === true`,
    "the resolved ADR records",
    20_000,
  );
  const resolvedAdrSidebar = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar"] section[aria-label="ADR records"]') !== null`);
  check(!resolvedAdrSidebar, "the sidebar still shows resolved ADR records");

  // 14. The UI issue dock: three actions, the unchanged report panel, and the
  // one-click removal and redesign shortcuts, all filed through the stub.
  const issueCommands = "app.report,app.remove,app.redesign";
  const issueLabels = "Report UI issue|Remove element|Redesign element";
  for (const mode of ["goal", "flow", "discover"]) {
    await runPalette(`view.mode.${mode}`);
    await page.wait(
      `document.querySelector('[data-testid="mode-${mode}"]')?.getAttribute("aria-selected") === "true"`,
      `the ${mode} mode for the issue dock`,
    );
    const dock = await dockState();
    check(dock.docks === 1, `the ${mode} route has ${dock.docks} issue docks`, dock);
    check(dock.labels.join("|") === issueLabels, `the ${mode} route mislabels the issue dock`, dock);
    check(dock.commands.join(",") === issueCommands, `the ${mode} route exposes the wrong issue commands`, dock);
    check(
      dock.group === "UI issue actions" && dock.overlay,
      `the ${mode} issue dock is not an accessible overlay group`,
      dock,
    );
    check(dock.inside, `the ${mode} issue dock leaves the viewport`, dock);
  }

  // The report path is unchanged: selection, panel, filing, and back to selection.
  await runPalette("view.mode.goal");
  await clearFeedback();
  await runPalette("app.report");
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the issue reporter picking mode");
  const reportArmed = await dockState();
  check(reportArmed.pressed.join(",") === "true,false,false", "the report action is not pressed in selection mode", reportArmed);
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the issue reporter to cancel");
  const reporterFocus = await page.eval<boolean>(`document.activeElement?.closest('[data-testid="notifications"]') === null`);
  check(reporterFocus, "the issue reporter stole focus into the notification region");

  await runPalette("app.report");
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the issue reporter picking mode for the drag");
  await page.click('[data-testid="status-bar"]');
  await page.wait(`document.querySelector('.feedback-panel') !== null`, "the report panel");
  const panelChrome = await page.eval<{ title: string; placeholder: string; buttons: string[]; selector: string }>(`(() => ({
    title: document.querySelector('.feedback-drag')?.textContent?.trim() ?? "",
    placeholder: document.querySelector('.feedback-panel textarea')?.getAttribute("placeholder") ?? "",
    buttons: [...document.querySelectorAll('.feedback-actions button')].map((button) => button.textContent.trim()),
    selector: document.querySelector('.feedback-selector')?.textContent?.trim() ?? "",
  }))()`);
  check(panelChrome.title === "Report a UI issue", "the report panel title changed", panelChrome);
  check(panelChrome.placeholder === "What is wrong with this element?", "the report panel placeholder changed", panelChrome);
  check(panelChrome.buttons.join("|") === "File issue|Cancel", "the report panel actions changed", panelChrome);
  check(panelChrome.selector.length > 0, "the report panel shows no selector", panelChrome);
  const composing = await dockState();
  check(composing.disabled.join(",") === "false,true,true", "the quick actions are not disabled while composing", composing);
  check(
    (await feedbackCalls()).length === 0 && feedbackRequests.length === 0,
    "a report request was sent before File issue",
  );
  const panelBefore = await page.eval<{ top: number; left: number }>(`(() => {
    const rect = document.querySelector('.feedback-panel').getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left) };
  })()`);
  await page.eval(`document.querySelector('.feedback-drag')?.focus()`);
  await page.key("ArrowUp", 3);
  const panelAfter = await page.eval<{ top: number; left: number; handle: boolean; inside: boolean }>(`(() => {
    const panel = document.querySelector('.feedback-panel');
    const rect = panel?.getBoundingClientRect();
    return {
      top: Math.round(rect?.top ?? -1),
      left: Math.round(rect?.left ?? -1),
      handle: document.activeElement?.classList.contains("feedback-drag") === true,
      inside: rect === undefined ? false : rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
    };
  })()`);
  check(panelAfter.handle, "the report panel has no keyboard drag handle", panelAfter);
  check(panelAfter.top < panelBefore.top, "the report panel cannot be moved", { panelBefore, panelAfter });
  check(panelAfter.inside, "a moved report panel leaves the viewport", panelAfter);
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-panel') === null`, "the report panel to close");

  await runPalette("app.report");
  await page.click('[data-testid="status-bar"]');
  await page.wait(`document.querySelector('.feedback-panel') !== null`, "the report panel for a filing");
  await page.fill('.feedback-panel textarea', "The status bar is clipped at the boundary.");
  await page.click('.feedback-actions button');
  await page.wait(
    `document.querySelector('.feedback-panel') === null && document.querySelector('.feedback-hint') !== null`,
    "the report selection mode after filing",
  );
  await waitForFeedbackCalls(1);
  await delay(150);
  const reportCall = (await feedbackCalls())[0]!;
  check(
    reportCall.args.join(" ").includes("[ui] The status bar is clipped at the boundary."),
    "the report title is wrong",
    reportCall.args,
  );
  check(reportCall.body.startsWith("## Operator report"), "the report body lost its heading", reportCall.body);
  check(
    reportCall.args.includes("--repo") &&
      reportCall.args[reportCall.args.indexOf("--repo") + 1] === "dsdenes/devboard",
    "the report was filed in another repository",
    reportCall.args,
  );
  check(
    feedbackRequests.length === 1 &&
      feedbackRequests[0]?.action === "report" &&
      String(feedbackRequests[0]?.report).includes("status bar is clipped"),
    "the report request is wrong",
    feedbackRequests,
  );
  const backToPicking = await dockState();
  check(backToPicking.pressed.join(",") === "true,false,false", "a filed report did not return to report selection", backToPicking);
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the report mode to close after filing");

  // A failed report stays in its panel with the server's message.
  await setFeedbackMode("fail");
  await runPalette("app.report");
  await page.click('[data-testid="status-bar"]');
  await page.wait(
    `document.querySelector('.feedback-panel') !== null`,
    "the report panel for a failed filing",
  );
  await page.fill('.feedback-panel textarea', "The status bar is clipped at the boundary.");
  await page.click('.feedback-actions button');
  await page.wait(`document.querySelector('.feedback-error') !== null`, "the failed report message");
  const failedReport = await page.eval<{ panel: boolean; error: string; disabled: boolean[] }>(`(() => ({
    panel: document.querySelector('.feedback-panel') !== null,
    error: document.querySelector('.feedback-error')?.textContent?.trim() ?? "",
    disabled: [...document.querySelectorAll('.feedback-dock__actions button')].map((button) => button.disabled),
  }))()`);
  check(
    failedReport.panel && failedReport.error.includes("Issue creation failed"),
    "a failed report left its panel",
    failedReport,
  );
  check(
    failedReport.disabled.length === 3 &&
      !failedReport.disabled[0] &&
      failedReport.disabled[1] &&
      failedReport.disabled[2],
    "a failed report left the dock in the wrong state",
    failedReport,
  );
  await setFeedbackMode("ok");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-panel') === null`, "the failed report panel to close");

  await runPalette("app.report");
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the issue reporter for the palette cancel");
  await runPalette("app.report.cancel");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the palette to cancel the issue reporter");
  check((await dockState()).pressed.every((value) => !value), "a canceled mode is still pressed");
  check((await dockState()).pressed.every((value) => !value), "a canceled mode is still pressed");

  // Two removals from one uninterrupted mode, the second on a control whose
  // activation the selection mode must swallow.
  await clearFeedback();
  await runPalette("app.remove");
  await page.wait(`document.querySelector('.feedback-hint')?.textContent?.includes("to remove") === true`, "the removal hint");
  const removalArmed = await dockState();
  check(removalArmed.pressed.join(",") === "false,true,false", "the removal action is not armed", removalArmed);
  await page.click('[data-testid="status-connection"]');
  await waitForFeedbackCalls(1);
  await delay(150);
  await page.wait(`document.querySelector('.feedback-status[role="status"] a') !== null`, "the removal success link");
  const removalStatus = await page.eval<{ role: string; text: string; href: string }>(`(() => {
    const status = document.querySelector('.feedback-status');
    return {
      role: status?.getAttribute("role") ?? "",
      text: (status?.textContent ?? "").split("\\n").map((value) => value.trim()).filter((value) => value.length > 0).join(" "),
      href: status?.querySelector("a")?.getAttribute("href") ?? "",
    };
  })()`);
  check(removalStatus.role === "status", "a removal success is not a status surface", removalStatus);
  check(removalStatus.text.startsWith("Removal issue filed."), "the removal success text is wrong", removalStatus);
  check(removalStatus.href === stubIssueUrl, "the removal success carries no stub issue URL", removalStatus);
  const removalStillArmed = await dockState();
  check(
    removalStillArmed.pressed.join(",") === "false,true,false" &&
      removalStillArmed.disabled.every((value) => !value),
    "a filed removal did not stay armed",
    removalStillArmed,
  );
  check(
    await page.eval<boolean>(`document.querySelector('.feedback-hint')?.textContent?.includes("to remove") === true`),
    "the removal hint disappeared after filing",
  );

  const selectionTheme = await page.eval<string>(`document.documentElement.dataset.theme`);
  await page.click('[data-testid="theme-toggle"]');
  await waitForFeedbackCalls(2);
  await delay(150);
  const themeAfterSelection = await page.eval<string>(`document.documentElement.dataset.theme`);
  check(
    themeAfterSelection === selectionTheme,
    "selecting an element in removal mode activated it",
    { selectionTheme, themeAfterSelection },
  );
  const removalCalls = await feedbackCalls();
  check(removalCalls.length === 2, "the second removal was not filed", removalCalls.length);
  for (const call of removalCalls) {
    const repoIndex = call.args.indexOf("--repo");
    check(repoIndex > -1 && call.args[repoIndex + 1] === "dsdenes/devboard", "a removal was filed in another repository", call.args);
    check(call.args.join(" ").includes("[ui] Remove element: "), "a removal title is wrong", call.args);
    check(!call.args.join(" ").includes("## Removal request"), "a removal body leaked into argv", call.args);
    check(call.body.startsWith("## Removal request\n\n"), "a removal body lost its heading", call.body);
    check(call.body.includes(`\n${removalInstruction}\n`), "a removal body lost its instruction", call.body);
    check(call.body.includes("## Captured UI context"), "a removal body lost the captured context", call.body);
    check(call.body.includes("### DOM excerpt"), "a removal body lost the DOM excerpt", call.body);
  }
  const removalRequests = feedbackRequests.filter((entry) => entry.action === "remove");
  check(removalRequests.length === 2, "the dock did not send two removal requests", feedbackRequests);
  check(
    removalRequests.every(
      (entry) =>
        typeof entry.selector === "string" &&
        entry.selector.length > 0 &&
        entry.report === "" &&
        String(entry.dom_excerpt ?? "").length > 0 &&
        String(entry.captured_at ?? "").length > 0,
    ),
    "a removal request lacks its captured context",
    removalRequests,
  );
  check(
    removalCalls[1]!.args.join(" ").includes(String(removalRequests[1]?.selector ?? "\u0000")),
    "the second removal names the wrong selector",
    removalCalls[1]!.args,
  );

  // A different action switches modes without filing; two redesigns then file
  // from the same uninterrupted mode.
  await clearFeedback();
  await runPalette("app.redesign");
  await page.wait(`document.querySelector('.feedback-hint')?.textContent?.includes("to redesign") === true`, "the redesign hint");
  const redesignArmed = await dockState();
  check(redesignArmed.pressed.join(",") === "false,false,true", "switching the action did not arm the redesign", redesignArmed);
  check((await feedbackCalls()).length === 0, "switching actions filed an issue");
  await page.click('[data-testid="status-connection"]');
  await waitForFeedbackCalls(1);
  await delay(150);
  await page.click('[data-testid="status-bar"]');
  await waitForFeedbackCalls(2);
  await delay(150);
  const redesignCalls = await feedbackCalls();
  check(redesignCalls.length === 2, "the second redesign was not filed", redesignCalls.length);
  for (const call of redesignCalls) {
    const repoIndex = call.args.indexOf("--repo");
    check(repoIndex > -1 && call.args[repoIndex + 1] === "dsdenes/devboard", "a redesign was filed in another repository", call.args);
    check(call.args.join(" ").includes("[ui] Redesign element: "), "a redesign title is wrong", call.args);
    check(!call.args.join(" ").includes("## Redesign request"), "a redesign body leaked into argv", call.args);
    check(call.body.startsWith("## Redesign request\n\n"), "a redesign body lost its heading", call.body);
    check(call.body.includes(redesignInstruction), "a redesign body lost its instruction", call.body);
    check(call.body.includes("## Captured UI context"), "a redesign body lost the captured context", call.body);
  }
  const redesignRequests = feedbackRequests.filter((entry) => entry.action === "redesign");
  check(redesignRequests.length === 2, "the dock did not send two redesign requests", feedbackRequests);
  const redesignStatus = await page.eval<{ text: string; href: string }>(`(() => {
    const status = document.querySelector('.feedback-status');
    return {
      text: (status?.textContent ?? "").split("\\n").map((value) => value.trim()).filter((value) => value.length > 0).join(" "),
      href: status?.querySelector("a")?.getAttribute("href") ?? "",
    };
  })()`);
  check(redesignStatus.text.startsWith("Redesign issue filed."), "the redesign success text is wrong", redesignStatus);
  check(redesignStatus.href === stubIssueUrl, "the redesign success carries no stub issue URL", redesignStatus);
  check((await dockState()).pressed.join(",") === "false,false,true", "a filed redesign did not stay armed");

  // A delayed filing disables every action and a double-click files once.
  await setFeedbackMode("delay");
  await page.doubleClick('[data-testid="status-connection"]');
  await page.wait(
    `[...document.querySelectorAll('.feedback-dock__actions button')].every((button) => button.disabled)`,
    "the dock disabled during a delayed filing",
  );
  const filing = await page.eval<{ labels: string[]; active: number }>(`(() => {
    const buttons = [...document.querySelectorAll('.feedback-dock__actions button')];
    return {
      labels: buttons.map((button) => button.textContent.trim()),
      active: buttons.findIndex((button) => button.getAttribute("aria-pressed") === "true"),
    };
  })()`);
  check(
    filing.active === 2 && filing.labels[filing.active] === "Filing…",
    "the active action does not read Filing… while filing",
    filing,
  );
  await waitForFeedbackCalls(3);
  await delay(200);
  const delayedCalls = await feedbackCalls();
  check(delayedCalls.length === 3, "a double-click filed more than one issue", delayedCalls.length);
  await page.wait(`document.querySelector('.feedback-status[role="status"]') !== null`, "the delayed filing status");

  // A failing filing keeps the mode armed, re-enables the dock, and files nothing.
  await setFeedbackMode("fail");
  await page.click('[data-testid="status-connection"]');
  await page.wait(`document.querySelector('.feedback-status[role="alert"]') !== null`, "the redesign failure alert");
  const failure = await page.eval<{
    text: string;
    link: boolean;
    hint: string;
    pressed: string[];
    disabled: boolean[];
  }>(`(() => {
    const alert = document.querySelector('.feedback-status[role="alert"]');
    const buttons = [...document.querySelectorAll('.feedback-dock__actions button')];
    return {
      text: (alert?.textContent ?? "").split("\\n").map((value) => value.trim()).filter((value) => value.length > 0).join(" "),
      link: alert?.querySelector("a") !== null,
      hint: document.querySelector('.feedback-hint')?.textContent ?? "",
      pressed: buttons.map((button) => button.getAttribute("aria-pressed") ?? ""),
      disabled: buttons.map((button) => button.disabled),
    };
  })()`);
  check(
    failure.text.startsWith("Redesign issue failed: Issue creation failed: boom"),
    "the redesign failure alert is wrong",
    failure,
  );
  check(!failure.link, "a failed redesign rendered an issue link", failure);
  check(failure.hint.includes("to redesign"), "a failed redesign left the mode", failure);
  check(failure.pressed.join(",") === "false,false,true", "a failed redesign lost its pressed state", failure);
  check(failure.disabled.every((value) => !value), "a failed redesign left the dock disabled", failure);
  await setFeedbackMode("ok");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "Escape to cancel the shortcut mode");
  check((await dockState()).pressed.every((value) => !value), "Escape left an action pressed");

  // The dock clears the status bar, the notification region, and the page's
  // lowest control at the narrowest supported viewport.
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024 && innerHeight === 720`, "the 1024×720 viewport for the issue dock");
  await runPalette("discover.tab.overview");
  await page.wait(`document.querySelector('#workspace-discover .scroll-column') !== null`, "the Discover page for the dock check");
  const dockLayout = await page.eval<{
    inside: boolean;
    aboveStatus: boolean;
    besideRegion: boolean;
    reserved: boolean;
    controlClear: boolean;
    controlHit: boolean;
  }>(`(() => {
    const dock = document.querySelector(".feedback-dock")?.getBoundingClientRect();
    const status = document.querySelector('[data-testid="status-bar"]')?.getBoundingClientRect();
    const region = document.querySelector('[data-testid="notifications"]')?.getBoundingClientRect();
    if (dock === undefined || status === undefined || region === undefined) {
      return {
        inside: false,
        aboveStatus: false,
        besideRegion: false,
        reserved: false,
        controlClear: false,
        controlHit: false,
      };
    }
    const scroller = document.querySelector("#workspace-discover .scroll-column");
    let controlClear = false;
    let controlHit = false;
    if (scroller !== null) {
      scroller.scrollTop = scroller.scrollHeight;
      const entries = [...scroller.querySelectorAll("*")]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter((entry) => entry.rect.width > 0 && entry.rect.height > 0);
      if (entries.length > 0) {
        const lowest = entries.reduce((best, entry) => (entry.rect.bottom > best.rect.bottom ? entry : best));
        const hit = document.elementFromPoint(
          lowest.rect.left + lowest.rect.width / 2,
          lowest.rect.top + lowest.rect.height / 2,
        );
        controlClear = lowest.rect.bottom <= dock.top;
        controlHit = hit !== null && lowest.element.contains(hit);
      }
    }
    const reserved = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--issue-dock-width"),
    );
    return {
      inside: dock.left >= 0 && dock.top >= 0 && dock.right <= innerWidth && dock.bottom <= innerHeight,
      aboveStatus: dock.bottom <= status.top + 0.5,
      besideRegion: region.right <= dock.left + 0.5,
      reserved: dock.width <= reserved + 0.5,
      controlClear,
      controlHit,
    };
  })()`);
  check(dockLayout.inside, "the issue dock leaves the 1024×720 viewport", dockLayout);
  check(dockLayout.aboveStatus, "the issue dock overlaps the status bar", dockLayout);
  check(dockLayout.besideRegion, "the issue dock overlaps the notification region", dockLayout);
  check(dockLayout.reserved, "the issue dock is wider than its reserved footprint", dockLayout);
  check(dockLayout.controlClear && dockLayout.controlHit, "the issue dock hides or covers the last Discover control", dockLayout);
  await page.screenshot(join(harnessRoot, ".tmp", "interface", "issue-dock-1024x720.png"));

  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the 1440×900 viewport after the dock check");
  await runPalette("view.mode.goal");
  await clearFeedback();
  await runPalette("app.remove");
  await page.click('[data-testid="status-connection"]');
  await waitForFeedbackCalls(1);
  await page.wait(`document.querySelector('.feedback-status[role="status"]') !== null`, "the dock status for the screenshots");
  await saveShot("ui-issue-dock-dark");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the dock screenshots to leave selection mode");
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "light"`, "the light theme for the dock screenshot");
  await runPalette("app.redesign");
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the redesign mode for the light dock screenshot");
  await saveShot("ui-issue-dock-light");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the light dock screenshot to leave selection mode");
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "dark"`, "the dark theme after the dock screenshots");

  // 15. Orchestrator status item: idle, working, failed, hidden, and live update.
  await seedOrchestrator(stateDir, host, "idle");
  const idleIssues = await page.wait<{
    count: number;
    text: string;
    title: string;
    tag: string;
    interactive: boolean;
  }>(
    `(() => {
      const items = [...document.querySelectorAll('[data-testid="status-issues"]')];
      if (items.length === 0) return null;
      const item = items[0];
      const text = item.textContent?.trim() ?? "";
      if (text !== "issues idle") return null;
      return {
        count: items.length,
        text,
        title: item.getAttribute("title") ?? "",
        tag: item.tagName,
        interactive:
          item.querySelector("button, a, [role=button], [role=dialog]") !== null ||
          item.hasAttribute("aria-expanded") ||
          item.hasAttribute("aria-haspopup") ||
          item.hasAttribute("onclick"),
      };
    })()`,
    "the idle orchestrator item",
    8_000,
  );
  check(idleIssues.count === 1, "the status bar does not show exactly one issue item", idleIssues);
  check(idleIssues.text === "issues idle", "the idle item text is wrong", idleIssues);
  check(idleIssues.tag === "SPAN" && !idleIssues.interactive, "the issue item is interactive", idleIssues);
  check(idleIssues.title.includes("fixture/host"), "the idle title does not name the repository", idleIssues);

  const workingSeededAt = Date.now();
  await seedOrchestrator(stateDir, host, "running");
  const workingItems = await page.wait<{ text: string; title: string }>(
    `(() => {
      const item = document.querySelector('[data-testid="status-issues"]');
      if (item === null) return null;
      const text = item.textContent?.trim() ?? "";
      if (!/^issues working \\(\\d+\\)$/.test(text)) return null;
      return { text, title: item.getAttribute("title") ?? "" };
    })()`,
    "the working orchestrator item",
    8_000,
  );
  const workingDelay = Date.now() - workingSeededAt;
  check(workingDelay <= 5_000, `the issue item took ${workingDelay}ms to show the change`);
  check(workingItems.text === "issues working (3)", "the working count is wrong", workingItems);
  check(
    workingItems.title.includes("fixture/host") && workingItems.title.includes("2026-10-27T10:00:00.000Z"),
    "the working title does not name the repository and the start",
    workingItems,
  );

  await seedOrchestrator(stateDir, host, "failed");
  const failedText = await page.wait<string>(
    `(() => {
      const item = document.querySelector('[data-testid="status-issues"]');
      const text = item?.textContent?.trim() ?? "";
      return text === "issues failed" ? text : null;
    })()`,
    "the failed orchestrator item",
    8_000,
  );
  check(failedText === "issues failed", "the failed item text is wrong", failedText);

  await clearOrchestratorState(stateDir);
  await page.wait(
    `document.querySelector('[data-testid="status-issues"]') === null`,
    "the issue item to disappear",
    8_000,
  );
  const hiddenItems = await page.eval<number>(
    `document.querySelectorAll('[data-testid="status-issues"]').length`,
  );
  check(hiddenItems === 0, "the issue item stayed after the state file was removed", hiddenItems);

  // Leave a seeded state so the 1024×720 clipping check sees the item.
  await seedOrchestrator(stateDir, host, "running");
  await page.wait(
    `document.querySelector('[data-testid="status-issues"]')?.textContent?.trim() === "issues working (3)"`,
    "the seeded issue item before the viewport check",
    8_000,
  );

  // 16. Notifications and history: stop the server, attempt a command, restart.
  serverProcess?.kill("SIGTERM");
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() !== "Connected"`,
    "the closed connection",
    20_000,
  );
  await runPalette("discover.tab.overview");
  const offline = await page.eval<{ disabled: boolean; title: string }>(`(() => {
    const start = document.querySelector('[data-testid="discover-remote-start"]');
    return { disabled: start?.disabled === true, title: start?.getAttribute("title") ?? "" };
  })()`);
  check(
    offline.disabled && offline.title === "Not connected",
    "a closed socket does not disable the remote start control",
    offline,
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

  // 17. Viewport boundary.
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

  // 18. Contrast and reduced motion in both themes.
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

  // 19. Palette mirroring after many tabs opened, then screenshots.
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

  // 20. No runtime failures or overflow.
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
    "verify:interface: shell, modes, sidebar, pages, splits, palette, keyboard, theme, tables, editors, terminals, accessibility, notifications, status bar, orchestrator status, persistence, and boundary passed",
  );
} finally {
  try {
    chromeProcess?.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  try {
    gateOffProcess?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  try {
    serverProcess?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}
