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
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fixtureRecord } from "../server/fixtures/adr-source";
import { journalKey } from "../server/journal";
import { REDESIGN_INSTRUCTION as redesignInstruction, REMOVAL_INSTRUCTION as removalInstruction } from "../server/feedback";
import { stateFile } from "../server/state";
import { readHarnessVersion, runningHarnessDir } from "../server/version";
import { freePort, run, waitFor } from "./verification";

const harnessRoot = resolve(import.meta.dir, "..");
const stubAgent = join(harnessRoot, "server", "fixtures", "stub-agent.ts");
// The source dashboard reports the commit-count version, not the unpacked
// manifest's placeholder.
const sourceVersion = readHarnessVersion(runningHarnessDir());
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

  /** A key that also inserts text, so Enter can perform its default action. */
  async keyWithText(key: string, text: string, modifiers = 0): Promise<void> {
    const [vk, code] = VK[key] ?? [0, `Key${key.toUpperCase()}`];
    await this.devtools.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      text,
      unmodifiedText: text,
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
    `${JSON.stringify({ name: "interface-fixture", scripts: { build: "bun run build:src", test: "bun test", "test:unit": "bun test" } }, null, 2)}\n`,
  );
  await mkdir(join(host, "node_modules", "typescript"), { recursive: true });
  await writeFile(
    join(host, "node_modules", "typescript", "package.json"),
    `${JSON.stringify({ name: "typescript", repository: "git+https://github.com/microsoft/TypeScript.git" }, null, 2)}\n`,
  );
  await mkdir(join(host, "src", "checkout"), { recursive: true });
  await writeFile(join(host, "src", "order.ts"), "export const orderTotal = (total: number): number => total;\n");
  await writeFile(
    join(host, "src", "checkout", "flow.ts"),
    'export { orderTotal } from "../order";\n',
  );
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
    ["0001-shell-and-layout", "accepted", "Build one full-viewport shell."],
    ["0002-tabs-and-panels", "accepted", "Keep each workspace tab mounted."],
    ["0003-dense-tables", "proposed", "Render records with dense table rows."],
    ["0004-editor-embeds", "proposed", "Embed Monaco for every text editor."],
    ["0005-terminal-output", "proposed", "Stream agent output through xterm."],
    ["0006-split-panes", "superseded", "Persist sidebar and detail splits.", { supersededBy: '"0008"' }],
    ["0007-command-palette", "rejected", "Expose every command through one palette."],
    ["0008-notifications", "proposed", "Keep server notices in one region."],
  ] as const;
  for (const [name, status, decision, extra] of records) {
    const title = name.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    await writeFile(
      join(adrDir, `${name}.md`),
      fixtureRecord(
        `${name}.md`,
        title,
        status,
        `## Context\n\nThis fixture record exists so the Goal workspace can render eight dense rows.\n\n## Decision\n\n${decision}\n\nThe decision is short on purpose.\n`,
        extra,
      ),
    );
  }

  // One prepare-family managed skill, so the Goal skills panel has a row the
  // delete control owns; the five Discover skills are managed by Discover.
  await mkdir(join(host, ".omp", "skills", "fixture-conventions"), { recursive: true });
  await writeFile(
    join(host, ".omp", "skills", "fixture-conventions", "SKILL.md"),
    [
      "---",
      "name: fixture-conventions",
      "description: Conventions every fixture implementation agent follows.",
      "metadata:",
      '  devboard-managed: "true"',
      "  devboard-family: prepare",
      "---",
      "",
      "# Fixture conventions",
      "",
      "- Prefer the smallest observable change.",
      "",
    ].join("\n"),
  );
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
 * Publishes one repo-scoped issues state for the fixture host and holds its
 * repo-anchored lock with this process's live pid, exactly the shape a worker
 * leaves. The dashboard reads it through `getIssues` and its events.
 */
async function seedIssuesState(
  stateDir: string,
  host: string,
  lifecycle: "stopped" | "idle" | "running" | "paused" | "failed",
  answeredRunId?: string,
): Promise<void> {
  const directory = join(stateDir, "issues", journalKey(host));
  await mkdir(join(directory, "runs"), { recursive: true });
  const enabled = lifecycle !== "stopped";
  const running = lifecycle === "running";
  const agents = [
    {
      runId: "2026-10-27T10-00-01-000Z",
      issueNumber: 17,
      question: {
        id: 1,
        message: "Which scope should issue 17 take?",
        options: [
          { label: "The whole issue", description: "Every criterion", recommended: true },
          { label: "One criterion", description: "Only the first", recommended: false },
        ],
      },
      activity: ["Reading issue 17", "Implementing issue 17"],
    },
    {
      runId: "2026-10-27T10-00-02-000Z",
      issueNumber: 18,
      question: {
        id: 2,
        message: "Which scope should issue 18 take?",
        options: [{ label: "The whole issue", recommended: true }],
      },
      activity: ["Reading issue 18", "Implementing issue 18"],
    },
    {
      runId: "2026-10-27T10-00-03-000Z",
      issueNumber: 19,
      question: {
        id: 3,
        message: "Which scope should issue 19 take?",
        options: [{ label: "The whole issue", recommended: true }],
      },
      activity: ["Reading issue 19", "Implementing issue 19"],
    },
  ].map((agent) => ({
    ...agent,
    question: agent.runId === answeredRunId ? null : agent.question,
  }));
  const queue = running
    ? [
        ...["17", "18", "19"].map((value) => Number(value)).map((number) => ({
          number,
          title: `Fixture issue ${number}`,
          url: `https://github.com/fixture/host/issues/${number}`,
          createdAt: "2026-10-26T00:00:00Z",
          labels: number === 19 ? ["goal"] : ([] as string[]),
          handled: false,
          runId: null,
          agentRunId: agents.find((agent) => agent.issueNumber === number)?.runId ?? null,
        })),
        ...["20", "21"].map((value) => Number(value)).map((number) => ({
          number,
          title: `Goal issue ${number}`,
          url: `https://github.com/fixture/host/issues/${number}`,
          createdAt: "2026-10-26T00:00:00Z",
          labels: ["goal"],
          handled: false,
          runId: null,
          agentRunId: null,
        })),
      ]
    : [];
  const runs = enabled
    ? [
        {
          runId: "2026-10-27T10-00-00-000Z",
          status: lifecycle === "failed" ? "failed" : "succeeded",
          startedAt: "2026-10-27T10:00:00.000Z",
          finishedAt: "2026-10-27T10:01:00.000Z",
          exitCode: lifecycle === "failed" ? 1 : 0,
          issueNumbers: [16],
          activity: 2,
          firstStderrLine: lifecycle === "failed" ? "the agent exited with code 1" : null,
        },
        ...agents.map((agent) => ({
          runId: agent.runId,
          status: running ? "running" : "succeeded",
          startedAt: "2026-10-27T10:00:01.000Z",
          finishedAt: running ? null : "2026-10-27T10:01:00.000Z",
          exitCode: running ? null : 0,
          issueNumbers: [agent.issueNumber],
          activity: agent.activity.length,
          firstStderrLine: null,
        })),
      ]
    : [];
  const state = {
    version: 2,
    repo: "fixture/host",
    root: resolve(host),
    lifecycle,
    enabled,
    paused: lifecycle === "paused",
    worker: enabled
      ? {
          pid: process.pid,
          startedAt: "2026-10-27T10:00:00.000Z",
          stateDir,
          harnessVersion: sourceVersion ?? "0.1.0",
          argv: ["bun", join(harnessRoot, "issues", "worker.ts")],
        }
      : null,
    poll: {
      intervalMs: 10_000,
      lastPollAt: enabled ? new Date(Date.now() - 1_000).toISOString() : null,
      nextPollAt: enabled ? new Date(Date.now() + 1_000).toISOString() : null,
      etag: enabled ? '"etag"' : null,
      notModified: false,
      rateLimitedUntil: null,
      error: null,
    },
    queue,
    runs,
    agents: running
      ? agents.map((agent) => ({
          runId: agent.runId,
          issueNumber: agent.issueNumber,
          startedAt: "2026-10-27T10:00:01.000Z",
          question: agent.question,
          acp: { pid: process.pid, argv: ["omp", "acp"], cwd: resolve(host) },
        }))
      : [],
    cooldowns: lifecycle === "failed" ? { "21": "2026-10-27T10:05:00.000Z" } : {},
    lastError: lifecycle === "failed" ? "the agent exited with code 1" : null,
    lastExitCode: lifecycle === "failed" ? 1 : running ? null : 0,
    finishedAt: running ? null : "2026-10-27T10:01:00.000Z",
    notice: null,
    updatedAt: new Date().toISOString(),
  };
  const path = join(directory, "state.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
  const seedRun = async (
    runId: string,
    status: string,
    issueNumber: number,
    activity: string[],
  ): Promise<void> => {
    await mkdir(join(directory, "runs", runId), { recursive: true });
    await writeFile(join(directory, "runs", runId, "activity.json"), JSON.stringify(activity));
    await writeFile(
      join(directory, "runs", runId, "run.json"),
      JSON.stringify({
        version: 1,
        runId,
        repo: "fixture/host",
        status,
        argv: ["omp", "acp"],
        cwd: resolve(host),
        startedAt: "2026-10-27T10:00:00.000Z",
        finishedAt: status === "running" ? null : "2026-10-27T10:01:00.000Z",
        exitCode: status === "running" ? null : status === "failed" ? 1 : 0,
        issues: [
          {
            number: issueNumber,
            title: `Fixture issue ${issueNumber}`,
            url: `https://github.com/fixture/host/issues/${issueNumber}`,
            createdAt: "2026-10-26T00:00:00Z",
            labels: [],
          },
        ],
        firstStderrLine: status === "failed" ? "the agent exited with code 1" : null,
        workerPid: process.pid,
        harnessVersion: sourceVersion ?? "0.1.0",
      }),
    );
  };
  await seedRun("2026-10-27T10-00-00-000Z", state.runs[0]?.status ?? "succeeded", 16, [
    "Reading the open issue",
    "Implementing issue 16",
  ]);
  for (const agent of agents) {
    await seedRun(agent.runId, running ? "running" : "succeeded", agent.issueNumber, agent.activity);
  }
  const lockDirectory = join(host, ".devboard", ".tmp", "issues");
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(
    join(lockDirectory, "lock"),
    JSON.stringify({
      pid: process.pid,
      startedAt: "2026-10-27T10:00:00.000Z",
      repo: resolve(host),
      stateDir,
      harnessVersion: sourceVersion ?? "0.1.0",
      argv: ["bun", join(harnessRoot, "issues", "worker.ts")],
    }),
  );
}

async function clearIssuesState(stateDir: string, host: string): Promise<void> {
  await rm(join(stateDir, "issues", journalKey(host)), { recursive: true, force: true });
  await rm(join(host, ".devboard", ".tmp", "issues", "lock"), { force: true });
}

/** Two deterministic drafts: one asks a question, one waits for Stop. */
async function seedGoalDrafts(host: string): Promise<string> {
  const directory = join(host, ".devboard", "goal-proposals");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "001-question.md"),
    "# Question draft\n\n> Unprocessed draft. STUB-QUESTION\n\nAsk about the scope before finalizing.\n",
  );
  await writeFile(
    join(directory, "002-hang.md"),
    "# Hang draft\n\n> Unprocessed draft. STUB-HANG\n\nKeep this elaboration running until it is stopped.\n",
  );
  return directory;
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

/**
 * Seeds one retained remote project from this checkout's published Discover
 * trees. The fixture has no checkout: the dashboard must render and switch
 * from the retained bytes alone.
 */
async function seedRetainedProject(
  stateDir: string,
  host: string,
  owner: string,
  repo: string,
  completedAt: string,
): Promise<string> {
  const directory = join(stateDir, "discover-remote", `${owner}-${repo}`.toLowerCase());
  await mkdir(join(directory, ".omp"), { recursive: true });
  await cp(join(host, ".omp", "discover"), join(directory, ".omp", "discover"), {
    recursive: true,
  });
  await cp(join(host, ".omp", "skills"), join(directory, ".omp", "skills"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "project.json"),
    `${JSON.stringify(
      {
        url: `https://github.com/${owner}/${repo}`,
        owner,
        repo,
        completedAt,
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

/** Writes the active remote target into the stopped dashboard's durable state. */
async function seedRemoteTarget(
  stateDir: string,
  host: string,
  owner: string,
  repo: string,
): Promise<void> {
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
    url: `https://github.com/${owner}/${repo}`,
    owner,
    repo,
  };
  await writeFile(path, JSON.stringify(envelope));
}

async function writeGateOffHost(root: string): Promise<string> {
  const host = join(root, "gate-off-host");
  await mkdir(join(host, "adrs"), { recursive: true });
  await writeFile(join(host, "GOAL.md"), "# Gate-off host\n");
  await writeFile(join(host, "package.json"), `${JSON.stringify({ name: "gate-off-host" })}\n`);
  await writeFile(join(host, "adrs", "0001-gate-off.md"), fixtureRecord("0001-gate-off.md", "Gate off"));
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
    AGENT_COMMAND: `bun ${stubAgent} --log=${agentLog} --discover --ask --ask-delay-ms=600 --goal-draft`,
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
  const feedbackPosts: string[] = [];
  const goalRequests: Array<Record<string, unknown>> = [];
  const goalPosts: string[] = [];

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
    if (
      typeof request?.url === "string" &&
      request.method === "POST" &&
      request.url.includes("/api/feedback")
    ) {
      feedbackPosts.push(request.url);
    }
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
    if (
      request?.method === "POST" &&
      (request.url ?? "").endsWith("/api/goal-proposals") &&
      typeof request.postData === "string"
    ) {
      goalPosts.push(request.url ?? "");
      try {
        const parsed = JSON.parse(request.postData) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          goalRequests.push(parsed as Record<string, unknown>);
        }
      } catch {
        goalRequests.push({ unparsed: request.postData });
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

  // A screenshot should show the surface, not an earlier test's notification.
  const dismissNotifications = async (): Promise<void> => {
    await page.eval<number>(`(() => {
      const buttons = [...document.querySelectorAll('[data-command="app.notifications.dismiss"]')];
      for (const button of buttons) button instanceof HTMLElement && button.click();
      return buttons.length;
    })()`);
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
  const issueState = async (): Promise<{
    present: boolean;
    commands: string[];
    labels: string[];
    pressed: boolean[];
    disabled: boolean[];
    inside: boolean;
  }> =>
    page.eval(`(() => {
      const ids = ["activity-report", "activity-remove", "activity-redesign"];
      const buttons = ids.map((id) => document.querySelector('[data-testid="' + id + '"]'));
      const rail = document.querySelector('[data-testid="activity-bar"]')?.getBoundingClientRect();
      return {
        present: buttons.every((button) => button !== null),
        commands: buttons.map((button) => button?.getAttribute("data-command") ?? ""),
        labels: buttons.map((button) => button?.getAttribute("aria-label") ?? ""),
        pressed: buttons.map((button) => button?.getAttribute("aria-pressed") === "true"),
        disabled: buttons.map((button) => button?.disabled === true),
        inside: buttons.every((button) => {
          const rect = button?.getBoundingClientRect();
          return (
            rect !== undefined &&
            rail !== undefined &&
            rect.top >= rail.top - 0.5 &&
            rect.bottom <= rail.bottom + 0.5 &&
            rect.left >= rail.left - 0.5 &&
            rect.right <= rail.right + 0.5
          );
        }),
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
  check(activity.count === 4, "the activity bar does not present exactly four modes", activity);
  const brand = await page.eval<string>(`document.querySelector('[data-testid="activity-bar"]')?.textContent?.replace(/\\s+/g, "") ?? ""`);
  check(brand === "GoalIssuesFlowDiscover", "the activity bar does not name its four modes", brand);
  const expectedModes = [
    ["mode-goal", "true", "Goal"],
    ["mode-issues", "false", "Issues"],
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
  const railLabels = await page.eval<Array<{ text: string; overflow: number; inside: boolean; height: number; width: number }>>(`(() => {
    return [...document.querySelectorAll('[data-testid="activity-bar"] .activity-tab')].map((tab) => {
      const label = tab.querySelector('.activity-tab__label');
      const tabRect = tab.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      return {
        text: label?.textContent?.trim() ?? "",
        overflow: label === null ? 1 : label.scrollWidth - label.clientWidth,
        inside: labelRect !== undefined && labelRect.left >= tabRect.left - 0.5 && labelRect.right <= tabRect.right + 0.5,
        height: Math.round(tabRect.height),
        width: Math.round(tabRect.width),
      };
    });
  })()`);
  check(
    railLabels.length === 4 && railLabels.every((label) => label.overflow <= 1 && label.inside),
    "a mode label overflows or leaves its tab",
    railLabels,
  );
  check(
    railLabels.every((label) => label.height === 52 && label.width === 64),
    "a mode tab does not keep its padded 64×52 box",
    railLabels,
  );

  // 3. Status bar, reload control, and shortcut discoverability.
  const statusBar = await page.eval<{
    connection: string;
    project: string;
    projectTitle: string;
    projectIcon: boolean;
    barRight: number;
    versionsRight: number;
    work: string;
    mode: boolean;
    versions: string;
    reload: { label: string; title: string } | null;
    themeLabel: string;
    notificationLabel: string;
    shortcuts: Array<string | null>;
    groups: number;
    divider: boolean;
    labels: string[];
    issuesDot: string;
    barHeight: number;
  }>(`(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\\s+/g, " ").trim() ?? "";
    const reload = document.querySelector('[data-testid="reload-devboard"]');
    const project = document.querySelector('[data-testid="status-project"]');
    const bar = document.querySelector('[data-testid="status-bar"]');
    const versions = document.querySelector('[data-testid="status-bar"] .status-versions');
    return {
      connection: text('[data-testid="status-connection"]'),
      project: text('[data-testid="status-project"]'),
      projectTitle: project?.closest(".status-project")?.getAttribute("title") ?? "",
      projectIcon: project?.closest(".status-project")?.querySelector("svg") !== null,
      barRight: Math.round(bar?.getBoundingClientRect().right ?? -1),
      versionsRight: Math.round(versions?.getBoundingClientRect().right ?? -1),
      work: text('[data-testid="status-bar"] .status-item[title="Running lanes and open epics"]'),
      mode: document.querySelector('[data-testid="status-mode"]') !== null,
      versions: text('[data-testid="status-bar"] .status-versions'),
      reload: reload === null ? null : { label: reload.getAttribute("aria-label") ?? "", title: reload.getAttribute("title") ?? "" },
      themeLabel: document.querySelector('[data-testid="theme-toggle"]')?.getAttribute("aria-label") ?? "",
      notificationLabel: document.querySelector('[data-testid="notification-indicator"]')?.getAttribute("aria-label") ?? "",
      shortcuts: [...document.querySelectorAll('[data-testid="command-item"]')].map((item) => item.querySelector(".palette__shortcut")?.textContent ?? null),
      groups: document.querySelectorAll('[data-testid="status-bar"] .status-group').length,
      divider: document.querySelector('[data-testid="status-bar"] .status-divider') !== null,
      labels: [...document.querySelectorAll('[data-testid="status-bar"] .status-metric__label')]
        .map((label) => label.textContent?.trim() ?? ""),
      issuesDot: (() => {
        const dot = document.querySelector('[data-testid="issues-indicator"] .status-issues__dot');
        return dot === null ? "" : getComputedStyle(dot).backgroundColor;
      })(),
      barHeight: Math.round(bar?.getBoundingClientRect().height ?? -1),
    };
  })()`);
  check(statusBar.connection === "Connected", "the status bar does not show the connection", statusBar);
  check(
    statusBar.project === "host" && statusBar.projectTitle.includes("host") && statusBar.projectIcon,
    "the status bar does not name the project compactly",
    statusBar,
  );
  check(!statusBar.mode, "the status bar still repeats the active mode status", statusBar);
  check(
    statusBar.barRight - statusBar.versionsRight <= 48,
    "the status bar leaves an empty tail after the versions",
    statusBar,
  );
  check(statusBar.versions.includes("running") && statusBar.versions.includes("installed"), "the status bar does not show both versions", statusBar);
  check(statusBar.reload !== null, "the stale reload control is missing");
  check(
    sourceVersion !== null &&
      statusBar.reload!.label.includes(sourceVersion) &&
      statusBar.reload!.label.includes("9.9.9"),
    "the reload label does not name both versions",
    { sourceVersion, reload: statusBar.reload },
  );
  check(
    sourceVersion !== null &&
      statusBar.reload!.title.includes(sourceVersion) &&
      statusBar.reload!.title.includes("9.9.9"),
    "the reload title does not name both versions",
    { sourceVersion, reload: statusBar.reload },
  );
  check(
    statusBar.groups === 2 && statusBar.divider && statusBar.barHeight === 26,
    "the status bar is not two grouped regions in its 26px bar",
    statusBar,
  );
  check(
    statusBar.labels.includes("lanes") &&
      statusBar.labels.filter((label) => label === "running").length === 1 &&
      statusBar.labels.filter((label) => label === "installed").length === 1,
    "a status metric does not state its meaning",
    statusBar,
  );
  check(statusBar.issuesDot.length > 0, "the issues indicator has no state dot", statusBar);
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
    items: Array<{ id: string; title: string; group: string; disabled: boolean; reason: string }>;
    input: boolean;
    focus: string;
  }>(`(() => {
    const list = [...document.querySelectorAll('.palette__group, [data-testid="command-item"]')];
    let group = "";
    const items = list.map((element) => {
      if (element.classList.contains("palette__group")) {
        group = element.textContent?.trim() ?? "";
        return null;
      }
      return {
        id: element.getAttribute("data-command") ?? "",
        title: element.querySelector(".palette__item-title")?.textContent?.trim() ?? "",
        group,
        disabled: element.getAttribute("aria-disabled") === "true",
        reason: element.querySelector(".palette__item-reason")?.textContent?.trim() ?? "",
      };
    }).filter((item) => item !== null);
    return {
      items,
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
    "view.mode.goal", "view.mode.issues", "view.mode.flow", "view.mode.discover",
    "issues.start", "issues.pause", "issues.resume", "issues.stop", "issues.check",
    "open.issues.overview", "open.issues.agents", "open.issues.issues", "open.issues.runs",
    "open.issues.drafts",
    "view.theme.toggle", "view.layout.reset",
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
  check(!ids.has("view.sidebar.toggle"), "the palette still offers a sidebar toggle");
  const agentsCommand = palette.items.find((item) => item.id === "open.issues.agents");
  check(
    agentsCommand?.title === "Open Agents" && agentsCommand?.group === "Workspace",
    "the palette does not list Open Agents in the Workspace group",
    agentsCommand,
  );
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
  await page.wait(`document.querySelector('[data-testid="mode-issues"]')?.getAttribute("aria-selected") === "true"`, "Alt+2");
  await page.key("3", 1);
  await page.wait(`document.querySelector('[data-testid="mode-flow"]')?.getAttribute("aria-selected") === "true"`, "Alt+3");
  await page.key("4", 1);
  await page.wait(`document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`, "Alt+4");
  await page.key("1", 1);
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Alt+1 return");
  const framesAfterSwitch = await page.eval<number>("window.__viFrames.length");
  check(framesAfterSwitch === framesBeforeSwitch, "a mode switch sent a WebSocket frame", { framesBeforeSwitch, framesAfterSwitch });

  await page.focus('[data-testid="start-next"]');
  await page.key("2", 1);
  await page.wait(`document.querySelector('[data-testid="mode-issues"]')?.getAttribute("aria-selected") === "true"`, "Alt+2 focus test");
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
    eyebrow: boolean;
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
      eyebrow: document.querySelector('[data-testid="adrs-header"] .page-header__eyebrow') !== null,
    };
  })()`);
  check(adr.rows === 8, "the fixture does not render eight ADR rows", adr);
  check(!adr.eyebrow, "the ADRs header still carries its Plan eyebrow", adr);
  const stateText = await page.eval<string>(`document.querySelector('[data-testid="record"] td:nth-child(3)')?.textContent?.trim() ?? ""`);
  check(stateText === "Resolved" || stateText === "Pending", "the ADR state is conveyed by color alone", stateText);
  const tableTones = await page.eval<Array<{ file: string; text: string; tone: string }>>(`(() => {
    return [...document.querySelectorAll('[data-testid="record"]')].map((row) => {
      const badge = row.querySelector('[data-testid="record-status-badge"]');
      return {
        file: row.getAttribute("data-file") ?? "",
        text: badge?.textContent?.trim() ?? "",
        tone: badge?.getAttribute("data-tone") ?? "",
      };
    });
  })()`);
  const toneOf = (file: string) => tableTones.find((entry) => entry.file.startsWith(file));
  check(
    toneOf("0001")?.text === "Accepted" && toneOf("0001")?.tone === "success",
    "an accepted record is not colored as accepted",
    tableTones,
  );
  check(
    toneOf("0003")?.text === "Proposed" && toneOf("0003")?.tone === "pending",
    "a proposed record is not colored as pending",
    tableTones,
  );
  check(
    toneOf("0006")?.text === "Superseded" && toneOf("0006")?.tone === "stale",
    "a superseded record is not colored as stale",
    tableTones,
  );
  check(
    toneOf("0007")?.text === "Rejected" && toneOf("0007")?.tone === "error",
    "a rejected record is not colored as rejected",
    tableTones,
  );
  check(
    tableTones.every((entry) => entry.tone !== "resolved"),
    "the table still colors its status badge by implementation state",
    tableTones,
  );
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
  const recordSurface = await page.eval<{
    close: boolean;
    status: string;
    tone: string;
    resolved: number;
    nextFact: number;
  }>(`(() => {
    const header = document.querySelector('[data-testid="record-header"]');
    const badges = [...(header?.querySelectorAll('.badge') ?? [])].map((badge) => badge.textContent?.trim() ?? "");
    const status = document.querySelector('[data-testid="record-status"]');
    const facts = [...document.querySelectorAll('[data-testid="record-meta"] dt')].map((term) => term.textContent?.trim() ?? "");
    return {
      close: document.querySelector('[data-testid="close-adrs"]') !== null,
      status: status?.textContent?.trim() ?? "",
      tone: status?.getAttribute("data-tone") ?? "",
      resolved: badges.filter((text) => text === "Resolved" || text === "Pending").length,
      nextFact: facts.filter((text) => text === "Next").length,
    };
  })()`);
  check(!recordSurface.close, "the decision-records header still carries its own close button", recordSurface);
  check(
    recordSurface.status === "Accepted" && recordSurface.tone === "success" && recordSurface.resolved === 0,
    "the record header repeats its status instead of coloring it",
    recordSurface,
  );
  check(recordSurface.nextFact === 0, "the record facts still repeat the next marker", recordSurface);
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
  const skillDocument = await page.eval<{ name: string; text: string }>(`(() => ({
    name: document.querySelector('[data-testid="skill-content-name"]')?.textContent?.trim() ?? "",
    text: document.querySelector('[data-testid="skill-content-text"]')?.textContent?.trim() ?? "",
  }))()`);
  check(
    skillDocument.name === clickedSkill && skillDocument.text.length > 0,
    "selecting a prepared skill does not open its document",
    { clickedSkill, skillDocument },
  );
  const deletion = await page.eval<{ rows: number; controls: string[]; discoverControls: number }>(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="skill"]')];
    const controls = rows
      .map((row) => row.closest("li")?.querySelector('[data-testid="delete-skill"]')?.getAttribute("data-name") ?? "")
      .filter((name) => name.length > 0);
    return {
      rows: rows.length,
      controls,
      discoverControls: rows.filter(
        (row) =>
          (row.getAttribute("data-name") ?? "").startsWith("discover-") &&
          row.closest("li")?.querySelector('[data-testid="delete-skill"]') !== null,
      ).length,
    };
  })()`);
  check(
    deletion.rows > 1 && deletion.controls.join(",") === "fixture-conventions" && deletion.discoverControls === 0,
    "the delete control does not belong only to prepared skills",
    deletion,
  );
  await page.click('[data-testid="skill"][data-name="fixture-conventions"]');
  await page.wait(
    `document.querySelector('[data-testid="skill-content-name"]')?.textContent?.trim() === "fixture-conventions"`,
    "the prepared skill detail",
  );
  const skillsBeforeDelete = await page.eval<number>(`document.querySelectorAll('[data-testid="skill"]').length`);
  await page.click('[data-testid="delete-skill"][data-name="fixture-conventions"]');
  await page.wait(`document.querySelector('[data-testid="delete-skill-confirmation"]') !== null`, "the skill deletion confirmation");
  await page.click('[data-command="goal.skills.delete.confirm"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="skill"]').length === ${skillsBeforeDelete - 1}`,
    "the deleted skill",
  );
  const afterDelete = await page.eval<{ names: string[]; detail: boolean; files: number }>(`(() => ({
    names: [...document.querySelectorAll('[data-testid="skill"]')].map((row) => row.getAttribute("data-name") ?? ""),
    detail: document.querySelector('[data-testid="skill-content"]') !== null,
    files: Number(window.__viSkillFiles ?? -1),
  }))()`);
  check(
    !afterDelete.names.includes("fixture-conventions") && !afterDelete.detail,
    "deleting a skill left its row or its detail open",
    afterDelete,
  );

  // 9. Goal editor: reset arm/cancel, dirty marker, save, unsaved survival, close prompt.
  await runPalette("open.goal.overview");
  await page.wait(`document.querySelector('[data-testid="reset-implementation"]') !== null`, "the reset control");
  const resetPlacement = await page.eval<{ inHeader: boolean; danger: boolean; eyebrow: boolean }>(`(() => ({
    inHeader: document.querySelector('[data-testid="implementation-header"] [data-testid="reset-implementation"]') !== null,
    danger: document.querySelector('[data-testid="danger-zone"]') !== null,
    eyebrow: document.querySelector('[data-testid="implementation-header"] .page-header__eyebrow') !== null,
  }))()`);
  check(
    resetPlacement.inHeader && !resetPlacement.danger,
    "the reset control is not in the page header",
    resetPlacement,
  );
  check(!resetPlacement.eyebrow, "the implementation header still carries its Goal eyebrow", resetPlacement);
  await page.click('[data-testid="reset-implementation"]');
  await page.wait(`document.querySelector('[data-testid="reset-confirmation"]') !== null`, "the reset confirmation");
  await page.click('[data-command="goal.reset.cancel"]');
  await page.wait(`document.querySelector('[data-testid="reset-confirmation"]') === null`, "the reset confirmation to close");
  await runPalette("goal.document.open");
  await page.wait(`document.querySelector('[data-testid="goal-text"] .monaco-editor') !== null`, "the Goal Monaco editor");
  const documentHeader = await page.eval<{ title: string; eyebrow: boolean }>(`(() => {
    const header = document.querySelector('[data-testid="document-header"]');
    return {
      title: header?.querySelector(".page-header__title")?.textContent?.trim() ?? "",
      eyebrow: header !== null && header.querySelector(".page-header__eyebrow") !== null,
    };
  })()`);
  check(
    documentHeader.title === "Goal document" && !documentHeader.eyebrow,
    "the Goal document header still carries its Plan eyebrow",
    documentHeader,
  );
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
  const flowMenu = await page.eval<{ items: number; icons: number }>(`(() => {
    const group = document.querySelector('[data-testid="sidebar"] section[aria-label="Flow surfaces"]');
    const items = [...(group?.querySelectorAll('button.sidebar-item') ?? [])];
    return { items: items.length, icons: items.filter((item) => item.querySelector('svg') !== null).length };
  })()`);
  check(
    flowMenu.items >= 4 && flowMenu.icons === 0,
    "the Flow menu still carries decorative icons",
    flowMenu,
  );
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
  const flowGoalHeader = await page.eval<{
    state: string;
    badge: boolean;
    tone: string;
    headerHeight: number;
    aligned: boolean;
    saveDisabled: boolean;
  }>(`(() => {
    const state = document.querySelector('[data-testid="flow-goal-state"]');
    const save = document.querySelector('[data-testid="save-flow-goal"]');
    const header = state?.closest(".flow-goal__header");
    const title = header?.querySelector(".flow-goal__title");
    const center = (element) => {
      const box = element?.getBoundingClientRect();
      return box === undefined ? Number.NaN : box.top + box.height / 2;
    };
    return {
      state: state?.textContent?.trim() ?? "",
      badge: state?.classList.contains("badge") ?? false,
      tone: state?.getAttribute("data-tone") ?? "",
      headerHeight: Math.round(header?.getBoundingClientRect().height ?? 0),
      aligned: Math.abs(center(state) - center(title)) <= 1,
      saveDisabled: save?.disabled !== false,
    };
  })()`);
  check(
    flowGoalHeader.state === "Saved" && flowGoalHeader.saveDisabled,
    "the Flow goal header does not state its saved state",
    flowGoalHeader,
  );
  check(
    flowGoalHeader.badge && flowGoalHeader.tone === "success",
    "the Flow goal saved state is not a success badge",
    flowGoalHeader,
  );
  check(
    flowGoalHeader.headerHeight === 44 && flowGoalHeader.aligned,
    "the Flow goal header does not hold the redesigned single row",
    flowGoalHeader,
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
  const decisionHeader = () =>
    page.eval<{ state: string; saveDisabled: boolean }>(`(() => {
      const state = document.querySelector('[data-testid="flow-decisions-state"]');
      const save = document.querySelector('[data-testid="save-flow-decisions"]');
      return {
        state: state?.textContent?.trim() ?? "",
        saveDisabled: save?.disabled !== false,
      };
    })()`);
  const decisionSaved = await decisionHeader();
  check(
    decisionSaved.state === "Saved" && decisionSaved.saveDisabled,
    "the decision board header does not state its saved state",
    decisionSaved,
  );
  await page.eval(`window.__devboardEditors.get("flow-decisions").focus()`);
  await page.key("End", 2);
  await page.typeText("\n- Decision from the check.");
  await delay(100);
  const decisionDirty = await decisionHeader();
  check(
    decisionDirty.state === "Unsaved changes" && !decisionDirty.saveDisabled,
    "the decision board header does not state its unsaved state",
    decisionDirty,
  );
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
    qualityGateHeaders: string[];
    qualityGateRows: string[][];
    deliveryFacts: string[];
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
    sidebarHeader: boolean;
    commandChips: number;
    suiteChip: boolean;
    contextPathChips: number;
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
    const stackLink = card === null ? null : card.querySelector('a.code-chip--link');
    return {
      cards: document.querySelectorAll('#workspace-discover [data-testid="discover-card"]').length,
      commands: commands.length,
      commandText: commands.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()).join(" | ")),
      pyramid: rows.length,
      pyramidText: rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()).join(" | ")),
      pyramidChart: document.querySelector('[data-testid="discover-pyramid-chart"], svg.pyramid__svg') !== null,
      qualityGateHeaders: [
        ...document.querySelectorAll('[data-testid="discover-quality-gates"] thead th'),
      ].map((header) => header.textContent.trim()),
      qualityGateRows: [
        ...document.querySelectorAll('[data-testid="discover-quality-gates"] tbody tr'),
      ].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim())),
      deliveryFacts: [
        ...document.querySelectorAll('#workspace-discover [data-field="delivery"] dt'),
      ].map((term) => term.textContent.trim()),
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
      stackLinks: card === null ? -1 : card.querySelectorAll('a.code-chip--link').length,
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
      sidebarHeader: document.querySelector('[data-testid="sidebar"] .sidebar__header') !== null,
      commandChips: document.querySelectorAll('[data-testid="discover-command-list"] code.code-chip').length,
      suiteChip: document.querySelector('[data-testid="discover-suite-command"] code.code-chip') !== null,
      contextPathChips: document.querySelectorAll('#workspace-discover [data-testid="discover-contexts"] .discover-context__head code').length,
      sectionsHeading: sections === null ? -1 : sections.querySelectorAll('.sidebar-group__title').length,
      sectionTabs: sections === null ? -1 : sections.querySelectorAll('[data-testid="discover-tab"]').length,
      skillTabs: skills === null ? -1 : skills.querySelectorAll('[data-testid="discover-tab"]').length,
      sidebarFreshness: document.querySelector('[data-testid="sidebar"] section[aria-label="Freshness"]') !== null,
    };
  })()`);
  await page.wait(
    `document.querySelector('[data-testid="discover-dependency-diagram"] svg') !== null`,
    "the dependency diagram",
  );
  const dependencyDiagram = await page.eval<{ nodes: number; edges: number; text: string }>(`(() => {
    const root = document.querySelector('[data-testid="discover-dependency-diagram"]');
    return {
      nodes: root === null ? 0 : root.querySelectorAll('g.node').length,
      edges: root === null ? 0 : root.querySelectorAll('path.flowchart-link, g.edgePath').length,
      text: root?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
    };
  })()`);
  check(dependencyDiagram.nodes >= 2, "the dependency diagram does not draw every bounded context", dependencyDiagram);
  check(dependencyDiagram.edges >= 1, "the dependency diagram draws no recorded edge", dependencyDiagram);
  check(
    dependencyDiagram.text.includes("Checkout") && dependencyDiagram.text.includes("Orders"),
    "the dependency diagram does not label its contexts",
    dependencyDiagram,
  );
  check(discoverTables.cards >= 5, "Discover sections are missing from the overview", discoverTables);
  check(discoverTables.commands > 0, "the Discover command table is empty", discoverTables);
  check(discoverTables.commandText.every((text) => text.replace(/[|\s]/g, "").length > 0), "a Discover command row renders no values", discoverTables.commandText);
  check(discoverTables.pyramid > 0 && discoverTables.suite, "the Discover testing tables are empty", discoverTables);
  check(discoverTables.pyramidText.every((text) => text.replace(/[|\s]/g, "").length > 0), "a Discover pyramid row renders no values", discoverTables.pyramidText);
  check(discoverTables.pyramidText.every((text) => !text.toLowerCase().includes("unknown")), "a Discover test level still reports an unknown count", discoverTables.pyramidText);
  check(
    discoverTables.qualityGateHeaders.join("|") === "Quality gate|What it checks",
    "the quality gate table does not carry its gate and check columns",
    discoverTables.qualityGateHeaders,
  );
  check(
    discoverTables.qualityGateRows.length > 0 &&
      discoverTables.qualityGateRows.every((cells) =>
        cells[0]?.trim().length > 0 && cells[1]?.trim().length > 0
      ),
    "a quality gate row renders no name or check",
    discoverTables.qualityGateRows,
  );
  check(
    !discoverTables.deliveryFacts.includes("Quality gates"),
    "the Delivery facts still repeat the quality gates",
    discoverTables.deliveryFacts,
  );
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
  check(!discoverTables.sidebarHeader, "the sidebar still repeats the mode and project header", discoverTables);
  check(
    discoverTables.commandChips === discoverTables.commands,
    "a command row is not drawn with the shared code chip",
    discoverTables,
  );
  check(discoverTables.suiteChip, "the whole-suite command is not drawn with the shared code chip", discoverTables);
  check(discoverTables.contextPathChips === 0, "a bounded context still renders its repository path", discoverTables);
  check(discoverTables.sectionsHeading === 0, "the sidebar still renders a Sections heading", discoverTables.sectionsHeading);
  check(discoverTables.sectionTabs === 2 && discoverTables.skillTabs === 5, "the sidebar does not split sections from skills", discoverTables);
  check(!discoverTables.sidebarFreshness, "the sidebar still renders a freshness group");
  const discoverChrome = await page.eval<{
    eyebrow: boolean;
    stale: boolean;
    commit: boolean;
    railLeft: number;
    railWidth: number;
    columnLeft: number;
    headers: string[];
    subtitle: string;
    rows: number;
    versions: boolean;
    suite: string;
    levelCommand: string;
    suiteLeft: number;
    commandLeft: number;
    levelChips: number;
    happyPath: string;
  }>(`(() => {
    const head = document.querySelector('#workspace-discover .discover-head');
    const sheet = document.querySelector('[data-testid="discover-sheet"]');
    const rail = sheet?.querySelector('.discover-rail');
    const column = sheet?.querySelector('.discover-col');
    const testing = document.querySelector('#workspace-discover [data-field="testing"]');
    const stats = [...(testing?.querySelectorAll('.discover-stat') ?? [])].map((stat) => ({
      value: stat.querySelector('.discover-stat__value')?.textContent?.trim() ?? "",
      label: stat.querySelector('.discover-stat__label')?.textContent?.trim() ?? "",
    }));
    const commandCell = testing?.querySelector('[data-testid="discover-pyramid"] tbody td code.code-chip');
    const suiteChip = document.querySelector('[data-testid="discover-suite-command"] code.code-chip');
    const commandChip = document.querySelector('[data-testid="discover-command-list"] tbody tr code.code-chip');
    return {
      eyebrow: head?.querySelector('.discover-page__eyebrow') !== null,
      stale: document.querySelector('[data-testid="discover-stale"]') !== null,
      commit: head?.querySelector('.discover-head__meta code') !== null,
      railLeft: Math.round(rail?.getBoundingClientRect().left ?? -1),
      railWidth: Math.round(rail?.getBoundingClientRect().width ?? -1),
      columnLeft: Math.round(column?.getBoundingClientRect().left ?? -1),
      headers: [...document.querySelectorAll('[data-testid="discover-pyramid"] thead th')]
        .map((header) => header.textContent.trim()),
      subtitle: testing?.querySelector('.panel__subtitle')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      rows: document.querySelectorAll('[data-testid="discover-pyramid"] tbody tr').length,
      versions: [...document.querySelectorAll('#workspace-discover [data-field="runtime"] dt')]
        .some((term) => term.textContent.trim() === "Versions"),
      suite: suiteChip?.textContent?.trim() ?? "",
      levelCommand: commandCell?.textContent?.trim() ?? "",
      suiteLeft: Math.round(suiteChip?.getBoundingClientRect().left ?? -1),
      commandLeft: Math.round(commandChip?.getBoundingClientRect().left ?? -1),
      levelChips: testing?.querySelectorAll('[data-testid="discover-pyramid"] tbody td code.code-chip').length ?? 0,
      happyPath: stats.find((stat) => stat.label === "happy path")?.value ?? "",
    };
  })()`);
  check(!discoverChrome.eyebrow && !discoverChrome.stale && !discoverChrome.commit, "the sheet still renders removed masthead chrome", discoverChrome);
  check(discoverChrome.railLeft < discoverChrome.columnLeft, "the sheet column is not to the right of the facts rail", discoverChrome);
  check(
    discoverChrome.railWidth >= 320,
    "the Discover facts rail is narrower than its approved track",
    discoverChrome,
  );
  check(
    discoverChrome.headers.join("|") === "Level|Tests|Happy path|Command",
    "the test level table does not carry its happy-path and command columns",
    discoverChrome.headers,
  );
  check(
    discoverChrome.suite === "$ npm test",
    "the whole-suite line does not carry the runnable prompt",
    discoverChrome,
  );
  check(
    discoverChrome.levelCommand === "$ npm run test:unit",
    "a test level does not show the declared command that runs it",
    discoverChrome,
  );
  check(
    discoverChrome.levelChips === discoverChrome.rows && discoverChrome.rows > 0,
    "a test level command is not drawn with the shared code chip",
    discoverChrome,
  );
  check(
    discoverChrome.suiteLeft === discoverChrome.commandLeft,
    "the suite command does not start on the commands' own column",
    discoverChrome,
  );
  check(
    discoverChrome.happyPath === "100%",
    "the testing summary does not carry the happy-path share",
    discoverChrome,
  );
  check(
    discoverChrome.subtitle.startsWith(`${discoverChrome.rows} level`) &&
      !discoverChrome.subtitle.includes("0 tests"),
    "the level count disagrees with the listed levels",
    discoverChrome,
  );
  check(!discoverChrome.versions, "the Platform rail still repeats the runtime versions", discoverChrome);

  // The command count discloses every slot, including the ones not found.
  const collapsedCommands = await page.eval<number>(
    `document.querySelectorAll('[data-testid="discover-command-list"] tbody tr').length`,
  );
  await page.click('[data-testid="discover-command-coverage"]');
  await page.wait(`document.querySelectorAll('[data-testid="discover-command-list"] tbody tr').length === 8`, "the full command coverage list");
  const coverage = await page.eval<{ rows: number; missing: number; placeholders: string[]; expanded: string }>(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="discover-command-list"] tbody tr')];
    const gaps = rows.filter((row) => row.getAttribute("data-found") === "false");
    return {
      rows: rows.length,
      missing: gaps.length,
      placeholders: gaps.map((row) => row.textContent.replace(/\\s+/g, " ").trim()),
      expanded: document.querySelector('[data-testid="discover-command-coverage"]')?.getAttribute("aria-expanded") ?? "",
    };
  })()`);
  check(coverage.rows === 8 && coverage.expanded === "true", "the command count does not disclose every slot", coverage);
  check(
    coverage.missing === 8 - collapsedCommands &&
      coverage.placeholders.every((text) => text.includes("not found")),
    "a command slot that was not found renders no placeholder",
    coverage,
  );
  await page.click('[data-testid="discover-command-coverage"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="discover-command-list"] tbody tr').length === ${collapsedCommands}`,
    "the command list to collapse",
  );

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
    toolbar: { background: string; border: string };
    filterRows: number[];
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
      toolbar: (() => {
        const controls = document.querySelector('#workspace-discover .discover-glossary-controls');
        const style = controls === null ? null : getComputedStyle(controls);
        return { background: style?.backgroundColor ?? "", border: style?.borderTopWidth ?? "" };
      })(),
      filterRows: [
        search,
        document.querySelector('[data-testid="discover-glossary-significant"]')?.closest(".discover-toggle"),
        document.querySelector('[data-testid="discover-glossary-threshold"]')?.closest(".discover-floor"),
      ].map((element) => {
        const box = element?.getBoundingClientRect();
        return box === undefined ? -1 : Math.round(box.top + box.height / 2);
      }),
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
  check(
    glossary.toolbar.background !== "rgba(0, 0, 0, 0)" && glossary.toolbar.border === "1px",
    "the glossary filters are not one bounded toolbar",
    glossary.toolbar,
  );
  check(
    glossary.filterRows.every((center) => Math.abs(center - glossary.filterRows[0]!) <= 1),
    "the glossary search, switch, and floor do not sit on one row",
    glossary.filterRows,
  );
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

  const glossaryActivation = await page.eval<{ commands: number; tabindex: number }>(`(() => {
    const rows = [...document.querySelectorAll('#workspace-discover [data-testid="discover-term"]')];
    return {
      commands: document.querySelectorAll('#workspace-discover [data-command^="discover.term.open."]').length,
      tabindex: rows.filter((row) => row.getAttribute("tabindex") !== null).length,
    };
  })()`);
  check(
    glossaryActivation.commands === 0 && glossaryActivation.tabindex === 0,
    "a glossary row is still an interactive term page",
    glossaryActivation,
  );
  await page.click('#workspace-discover [data-testid="discover-term"] td:nth-child(2)');
  await delay(100);
  const stillGlossary = await page.eval<boolean>(
    `document.querySelector('#workspace-discover [data-testid="discover-panel"][data-tab="glossary"]') !== null`,
  );
  check(stillGlossary, "clicking a glossary row navigated away from the table");

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
  const dirtyHeader = await page.eval<{ enabled: boolean; state: string }>(`(() => {
    const button = document.querySelector('[data-testid="discover-skill-save"]');
    return {
      enabled: button !== null && !button.disabled,
      state: button
        ?.closest('.discover-skill__header')
        ?.querySelector('[data-testid="discover-skill-dirty"]')
        ?.textContent?.trim() ?? "",
    };
  })()`);
  check(
    dirtyHeader.enabled && dirtyHeader.state === "Unsaved changes",
    "the skill header does not enable Save for an unsaved draft",
    dirtyHeader,
  );
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
    state: string;
    saveDisabled: boolean;
    eyebrow: boolean;
    meta: boolean;
    name: boolean;
  }>(`(() => {
    const editor = document.querySelector('[data-testid="discover-skill-text"]');
    const panel = document.querySelector('[data-testid="discover-skill"]');
    const index = document.querySelector('#workspace-discover .discover-skill-page');
    const save = document.querySelector('[data-testid="discover-skill-save"]');
    return {
      preview: document.querySelector('[data-testid="discover-skill-preview"]') !== null,
      split: document.querySelectorAll('#workspace-discover [data-testid="discover-skill"] [data-testid="pane-handle"]').length,
      badge: document.querySelector('[data-testid="discover-skill-state"]') !== null,
      editor: editor === null ? 0 : Math.round(editor.getBoundingClientRect().height),
      panel: panel === null ? 0 : Math.round(panel.getBoundingClientRect().height),
      title: panel?.querySelector('.panel__title')?.textContent?.trim() ?? "",
      state: panel
        ?.querySelector('[data-testid="discover-skill-status"]')
        ?.textContent?.trim() ?? "",
      saveDisabled: save === null || save.disabled,
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
  check(
    skillLayout.state === "No unsaved changes" && skillLayout.saveDisabled,
    "the clean skill header does not state the draft is saved and disable Save",
    skillLayout,
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


  // 12b. Retained remote projects render without a clone, switch, and remove.
  const hostOmpBefore = await ompDigest(host);
  const helloUrl = "https://github.com/octocat/Hello-World";
  const secondUrl = "https://github.com/octocat/Second-Project";
  await stopServer();
  const helloRetained = await seedRetainedProject(
    stateDir,
    host,
    "octocat",
    "Hello-World",
    "2026-01-02T00:00:00.000Z",
  );
  const secondRetained = await seedRetainedProject(
    stateDir,
    host,
    "octocat",
    "Second-Project",
    "2026-01-03T00:00:00.000Z",
  );
  const helloBytes = await ompDigest(helloRetained);
  await seedRemoteTarget(stateDir, host, "octocat", "Hello-World");
  startServer();
  await waitForHttp(baseUrl);
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnection after the retained remote restart",
    30_000,
  );
  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null`,
    "the Discover overview with a retained remote project",
  );
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-target"]') !== null`,
    "the retained remote target banner",
  );
  const remoteStrip = await page.eval<{
    select: boolean;
    options: string[];
    selected: string;
    selectedIndex: number;
    removes: Array<string | null>;
    error: string | null;
    banner: string;
    input: boolean;
    placeholder: string;
    label: string;
    start: string;
    disabled: boolean;
    title: string;
    clear: boolean;
    sheet: boolean;
    first: boolean;
  }>(`(() => {
    const select = document.querySelector('[data-testid="discover-remote-select"]');
    const banner = document.querySelector('[data-testid="discover-remote-target"]');
    const input = document.querySelector('[data-testid="discover-remote-url"]');
    const start = document.querySelector('[data-testid="discover-remote-start"]');
    const error = document.querySelector('[data-testid="discover-error"]');
    return {
      select: select !== null,
      options: select === null ? [] : [...select.options].map((option) => option.value),
      selected: select?.value ?? "",
      selectedIndex: select?.selectedIndex ?? -2,
      removes: [...document.querySelectorAll('[data-testid="discover-remote-remove"]')].map(
        (button) => button.getAttribute("data-url"),
      ),
      error: error?.textContent ?? null,
      banner: banner?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      input: input !== null,
      placeholder: input?.getAttribute("placeholder") ?? "",
      label: input?.getAttribute("aria-label") ?? "",
      start: start?.textContent?.trim() ?? "",
      disabled: start?.disabled === true,
      title: start?.getAttribute("title") ?? "",
      clear: document.querySelector('[data-testid="discover-remote-clear"]') !== null,
      sheet: document.querySelector('[data-testid="discover-sheet"]') !== null,
      first:
        document.querySelector('[data-testid="discover-panel"][data-tab="overview"]')
          ?.firstElementChild?.getAttribute("data-testid") === "discover-remote",
    };
  })()`);
  check(remoteStrip.select, "the retained-project dropdown is missing", remoteStrip);
  check(
    JSON.stringify(remoteStrip.options) === JSON.stringify([secondUrl, helloUrl]),
    "the retained dropdown does not list both projects newest first",
    remoteStrip,
  );
  check(
    remoteStrip.selected === helloUrl && remoteStrip.selectedIndex === 1,
    "the active retained project is not the selected option",
    remoteStrip,
  );
  check(
    JSON.stringify(remoteStrip.removes) === JSON.stringify([secondUrl, helloUrl]),
    "the remove controls do not carry each retained project's URL",
    remoteStrip,
  );
  check(
    remoteStrip.error === null || !remoteStrip.error.includes("missing"),
    "a retained project produced a missing-clone error",
    remoteStrip,
  );
  check(
    remoteStrip.banner.includes(helloUrl) && remoteStrip.banner.includes("Manual testing"),
    "the retained banner does not name the active URL with its marker",
    remoteStrip,
  );
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
  check(remoteStrip.clear, "the clear control is missing for a remote target", remoteStrip);
  check(remoteStrip.sheet, "the retained project's sheet does not render", remoteStrip);
  check(
    remoteStrip.first,
    "the remote target strip is not the first region of the Discover overview",
    remoteStrip,
  );
  const retainedTitle = await page.eval<string>(
    `document.querySelector('#workspace-discover .discover-head__title')?.textContent?.trim() ?? ""`,
  );
  check(
    retainedTitle === "octocat/Hello-World",
    "the Discover head does not name the restored repository",
    retainedTitle,
  );
  await runPalette("discover.tab.glossary");
  await page.wait(`document.querySelector('[data-testid="discover-term"]') !== null`, "the retained glossary");
  await runPalette("discover.tab.overview");

  // Selecting another retained option switches with no clone and no crawl.
  const framesBeforeRetainedSwitch = await page.eval<number>(`(window.__viFrames ?? []).length`);
  await page.eval(`(() => {
    const select = document.querySelector('[data-testid="discover-remote-select"]');
    select.value = ${JSON.stringify(secondUrl)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-target"]')?.textContent?.includes(${JSON.stringify(secondUrl)}) === true`,
    "the switched retained project",
    20_000,
  );
  const switchedTitle = await page.eval<string>(
    `document.querySelector('#workspace-discover .discover-head__title')?.textContent?.trim() ?? ""`,
  );
  check(
    switchedTitle === "octocat/Second-Project",
    "switching a retained option did not render that project",
    switchedTitle,
  );
  const switchedBanner = await page.eval<string>(
    `document.querySelector('[data-testid="discover-remote-target"]')?.textContent ?? ""`,
  );
  check(
    switchedBanner.includes(secondUrl),
    "switching a retained option did not move the target banner",
    switchedBanner,
  );
  const switchFrames = await page.eval<{ frames: Array<{ type?: string; url?: string } | null> }>(`(() => ({
    frames: (window.__viFrames ?? []).slice(${framesBeforeRetainedSwitch}).map((frame) => {
      try { return JSON.parse(frame); } catch (error) { return null; }
    }),
  }))()`);
  const switchSpawns = switchFrames.frames.filter(
    (frame) => frame?.type === "discoverRemote" || frame?.type === "discoverProject",
  );
  check(switchSpawns.length === 0, "switching a retained option spawned a clone or crawl", switchFrames);
  const switchCommands = switchFrames.frames.filter((frame) => frame?.type === "switchDiscoverRemote");
  check(
    switchCommands.length === 1 && switchCommands[0]?.url === secondUrl,
    "one selection did not send exactly one switchDiscoverRemote",
    switchFrames,
  );
  const scratchAfterSwitch = await readdir(join(stateDir, "discover-remote"));
  check(
    JSON.stringify(scratchAfterSwitch.sort()) ===
      JSON.stringify(["octocat-hello-world", "octocat-second-project"]),
    "switching created a checkout or removed a retained project",
    scratchAfterSwitch,
  );

  // One remote skill save lands in the active retained project, never this checkout.
  await runPalette("discover.tab.testing-strategy");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"] .monaco-editor') !== null`, "the retained skill editor");
  const retainedSkill = await page.eval<string>(`window.__devboardEditors.get("discover-skill-text").getValue()`);
  await page.eval(
    `window.__devboardEditors.get("discover-skill-text").setValue(${JSON.stringify(
      `${retainedSkill}\n- Retained interface edit.\n`,
    )})`,
  );
  await page.wait(`document.querySelector('[data-testid="discover-skill-dirty"]') !== null`, "the retained skill dirty marker");
  await page.click('[data-testid="discover-skill-save"]');
  await waitFor(
    async () => {
      try {
        const text = await readFile(
          join(secondRetained, ".omp", "skills", "discover-testing-strategy", "SKILL.md"),
          "utf8",
        );
        return text.includes("Retained interface edit") ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the retained skill save",
    20_000,
  );
  check(await ompDigest(host) === hostOmpBefore, "a retained skill save changed this checkout's .omp");

  // Removing the active project deletes exactly it and returns to the host.
  await runPalette("discover.tab.overview");
  await page.eval(`document.querySelector('[data-testid="discover-remote-remove"][data-url="${secondUrl}"]').click()`);
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-target"]') === null`,
    "the host target after removing the active retained project",
    20_000,
  );
  await waitFor(
    () => (existsSync(secondRetained) ? undefined : true),
    "the removed retained project",
    20_000,
  );
  const afterRemove = await page.eval<{ options: string[]; removes: Array<string | null>; selectedIndex: number }>(`(() => {
    const select = document.querySelector('[data-testid="discover-remote-select"]');
    return {
      options: select === null ? [] : [...select.options].map((option) => option.value),
      removes: [...document.querySelectorAll('[data-testid="discover-remote-remove"]')].map(
        (button) => button.getAttribute("data-url"),
      ),
      selectedIndex: select?.selectedIndex ?? -2,
    };
  })()`);
  check(
    JSON.stringify(afterRemove.options) === JSON.stringify([helloUrl]),
    "removing the active project kept its dropdown entry",
    afterRemove,
  );
  check(
    JSON.stringify(afterRemove.removes) === JSON.stringify([helloUrl]),
    "removing the active project kept its remove control",
    afterRemove,
  );
  check(afterRemove.selectedIndex === -1, "the host target still selects a retained option", afterRemove);
  check(existsSync(helloRetained), "removing one project deleted another");
  check(await ompDigest(helloRetained) === helloBytes, "removing one project changed another");

  // The removal survives a restart.
  await stopServer();
  startServer();
  await waitForHttp(baseUrl);
  await page.navigate(baseUrl);
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnection after the removal restart",
    30_000,
  );
  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-select"]') !== null`,
    "the retained dropdown after the removal restart",
  );
  const afterRestart = await page.eval<{ options: string[]; target: boolean; error: string | null }>(`(() => ({
    options: [...document.querySelector('[data-testid="discover-remote-select"]').options].map(
      (option) => option.value,
    ),
    target: document.querySelector('[data-testid="discover-remote-target"]') !== null,
    error: document.querySelector('[data-testid="discover-error"]')?.textContent ?? null,
  }))()`);
  check(
    JSON.stringify(afterRestart.options) === JSON.stringify([helloUrl]),
    "the removed project returned after a restart",
    afterRestart,
  );
  check(!afterRestart.target, "a restart reactivated a removed project", afterRestart);
  check(
    afterRestart.error === null || !afterRestart.error.includes("missing"),
    "the removal restart reported a missing checkout",
    afterRestart,
  );
  check(!existsSync(secondRetained) && existsSync(helloRetained), "a restart changed the retained directories");

  // Selecting the remaining project renders it; clearing keeps every byte.
  await page.eval(`(() => {
    const select = document.querySelector('[data-testid="discover-remote-select"]');
    select.value = ${JSON.stringify(helloUrl)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-target"]')?.textContent?.includes(${JSON.stringify(helloUrl)}) === true`,
    "the selected remaining retained project",
    20_000,
  );
  await page.click('[data-testid="discover-remote-clear"]');
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-target"]') === null`,
    "the cleared remote banner",
    20_000,
  );
  const cleared = await page.eval<{ input: string; clear: boolean; options: string[] }>(`(() => ({
    input: document.querySelector('[data-testid="discover-remote-url"]')?.value ?? "missing",
    clear: document.querySelector('[data-testid="discover-remote-clear"]') !== null,
    options: [...document.querySelector('[data-testid="discover-remote-select"]').options].map(
      (option) => option.value,
    ),
  }))()`);
  check(cleared.input === "", "clearing did not empty the URL field", cleared);
  check(!cleared.clear, "the clear control survived the host target", cleared);
  check(
    JSON.stringify(cleared.options) === JSON.stringify([helloUrl]),
    "clearing removed a retained project",
    cleared,
  );
  check(await ompDigest(helloRetained) === helloBytes, "clearing changed a retained project");
  check(await ompDigest(host) === hostOmpBefore, "clearing changed this checkout's .omp");

  // An invalid URL is refused once and creates no checkout.
  await page.fill('[data-testid="discover-remote-url"]', "http://github.com/octocat/Hello-World");
  const framesBeforeInvalid = await page.eval<number>(`(window.__viFrames ?? []).length`);
  await page.click('[data-testid="discover-remote-start"]');
  await page.wait(
    `document.querySelector('[data-testid="discover-error"]')?.textContent?.includes("Could not clone") === true`,
    "the invalid remote URL refusal",
    20_000,
  );
  const invalid = await page.eval<{ frames: Array<{ type?: string; url?: string } | null> }>(`(() => ({
    frames: (window.__viFrames ?? []).slice(${framesBeforeInvalid}).map((frame) => {
      try { return JSON.parse(frame); } catch (error) { return null; }
    }),
  }))()`);
  const invalidSent = invalid.frames.filter((frame) => frame?.type === "discoverRemote");
  check(invalidSent.length === 1, "one invalid URL did not send exactly one discoverRemote frame", invalid);
  check(
    invalidSent[0]?.url === "http://github.com/octocat/Hello-World",
    "the invalid URL frame did not carry the trimmed value",
    invalid,
  );
  const scratchAfterInvalid = await readdir(join(stateDir, "discover-remote"));
  check(
    JSON.stringify(scratchAfterInvalid.sort()) === JSON.stringify(["octocat-hello-world"]),
    "an invalid URL created or removed a retained project",
    scratchAfterInvalid,
  );

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
    select: document.querySelector('[data-testid="discover-remote-select"]') !== null,
    remove: document.querySelector('[data-testid="discover-remote-remove"]') !== null,
    panel: document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null,
    skills: document.querySelector('[data-testid="sidebar"] section[aria-label="Skills"]') !== null,
  })`);
  check(gateOff.panel, "the gate-off host has no Discover overview", gateOff);
  check(
    !gateOff.url && !gateOff.start && !gateOff.banner && !gateOff.clear && !gateOff.select && !gateOff.remove,
    "the gate-off host renders a remote control",
    gateOff,
  );
  check(!gateOff.skills, "the host without Discover artifacts renders a Skills group", gateOff);
  check(
    !existsSync(join(root, "gate-off-state", "discover-remote")),
    "the gate-off host read or wrote the retained root",
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
    await writeFile(path, text.replace(/^status:\s*[a-z]+\s*$/m, "status: accepted"));
  }
  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="pending-summary"]')?.textContent?.includes("0 ADR") === true`,
    "the resolved ADR records",
    20_000,
  );
  const resolvedAdrSidebar = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar"] section[aria-label="ADR records"]') !== null`);
  check(!resolvedAdrSidebar, "the sidebar still shows resolved ADR records");

  // 14. The three issue actions live in the activity bar and toggle themselves.
  await page.click('[data-testid="activity-report"]');
  await page.wait(
    `document.querySelector('.feedback-hint') !== null`,
    "the activity-bar report control picking mode",
  );
  const reportActive = await issueState();
  check(
    reportActive.pressed.join(",") === "true,false,false",
    "the report action is not pressed in selection mode",
    reportActive,
  );
  await page.click('[data-testid="activity-report"]');
  await page.wait(
    `document.querySelector('.feedback-hint') === null`,
    "the activity-bar report control to cancel",
  );

  await runPalette("view.mode.goal");
  const idleIssue = await issueState();
  check(idleIssue.present, "an issue action is missing from the activity bar", idleIssue);
  check(
    idleIssue.commands.join(",") === "app.report,app.remove,app.redesign",
    "the activity bar exposes the wrong issue commands",
    idleIssue,
  );
  check(
    idleIssue.labels[0]?.includes("Report a UI issue") &&
      idleIssue.labels[1]?.includes("Remove element") &&
      idleIssue.labels[2]?.includes("Redesign element"),
    "an issue action lacks its accessible name",
    idleIssue,
  );
  check(
    idleIssue.pressed.every((value) => !value) && idleIssue.inside,
    "the issue actions are not idle inside the rail",
    idleIssue,
  );

  // The report path is unchanged: selection, panel, filing, and back to selection.
  await clearFeedback();
  await runPalette("app.report");
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the issue reporter picking mode");
  const reportArmed = await issueState();
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
  check(
    panelChrome.buttons.join("|") === "File issue|Ask|Goal|Cancel",
    "the report panel actions changed",
    panelChrome,
  );
  check(panelChrome.selector.length > 0, "the report panel shows no selector", panelChrome);
  const composing = await issueState();
  check(
    composing.disabled.join(",") === "false,true,true",
    "the quick actions are not disabled while composing",
    composing,
  );
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
  const backToPicking = await issueState();
  check(backToPicking.pressed.join(",") === "true,false,false", "a filed report did not return to report selection", backToPicking);
  const reportToast = await page.eval<{ role: string; text: string; href: string }>(`(() => {
    const toast = document.querySelector('.feedback-result');
    return {
      role: toast?.getAttribute("role") ?? "",
      text: (toast?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      href: toast?.querySelector("a")?.getAttribute("href") ?? "",
    };
  })()`);
  check(reportToast.role === "status", "a filed report shows no status toast", reportToast);
  check(reportToast.text.startsWith("Report filed."), "the report success toast is wrong", reportToast);
  check(reportToast.href === stubIssueUrl, "the report success toast carries no issue URL", reportToast);
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
    disabled: ["activity-report", "activity-remove", "activity-redesign"].map(
      (id) => document.querySelector('[data-testid="' + id + '"]')?.disabled === true,
    ),
  }))()`);
  check(
    failedReport.panel && failedReport.error.includes("Issue creation failed"),
    "a failed report left its panel",
    failedReport,
  );
  check(
    !failedReport.disabled[0] && failedReport.disabled[1] && failedReport.disabled[2],
    "a failed report left the issue actions in the wrong state",
    failedReport,
  );
  await setFeedbackMode("ok");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-panel') === null`, "the failed report panel to close");

  // The Goal action writes one raw draft and returns to picking.
  const goalDir = join(host, ".devboard", "goal-proposals");
  await rm(goalDir, { recursive: true, force: true });
  await clearFeedback();
  goalRequests.length = 0;
  goalPosts.length = 0;
  const goalSentence = "The status bar should name the keyboard hints.";
  await runPalette("app.report");
  await page.click('[data-testid="status-bar"]');
  await page.wait(
    `document.querySelector('.feedback-panel') !== null`,
    "the report panel for a goal draft",
  );
  const goalChrome = await page.eval<{
    buttons: string[];
    present: boolean;
    label: string;
    disabled: boolean;
  }>(`(() => {
    const button = document.querySelector('[data-testid="feedback-goal"]');
    return {
      buttons: [...document.querySelectorAll('.feedback-actions button')].map(
        (entry) => entry.textContent.trim(),
      ),
      present: button !== null,
      label: button?.getAttribute("aria-label") ?? "",
      disabled: button?.disabled === true,
    };
  })()`);
  check(
    goalChrome.buttons.join("|") === "File issue|Ask|Goal|Cancel",
    "the report panel action order changed",
    goalChrome,
  );
  check(
    goalChrome.present && goalChrome.label.includes("Goal"),
    "the Goal action has no test id or accessible name",
    goalChrome,
  );
  check(goalChrome.disabled, "the Goal action is enabled without text", goalChrome);
  await page.fill('.feedback-panel textarea', goalSentence);
  check(
    await page.eval<boolean>(
      `document.querySelector('[data-testid="feedback-goal"]')?.disabled === false`,
    ),
    "the Goal action stays disabled with composer text",
  );
  await page.click('[data-testid="feedback-goal"]');
  await page.wait(
    `document.querySelector('.feedback-panel') === null && document.querySelector('.feedback-hint') !== null`,
    "the report selection mode after proposing a goal",
  );
  const goalDeadline = Date.now() + 20_000;
  let goalFiles: string[] = [];
  for (;;) {
    if (existsSync(goalDir)) {
      goalFiles = (await readdir(goalDir)).filter((name) => name.endsWith(".md"));
      if (goalFiles.length > 0) break;
    }
    if (Date.now() > goalDeadline) {
      throw new Error("verify:interface: the Goal action wrote no draft");
    }
    await delay(50);
  }
  check(goalFiles.length === 1, "the Goal action wrote more than one draft", goalFiles);
  await page.wait(
    `document.querySelector('.feedback-result')?.textContent?.includes("Goal proposed:") === true`,
    "the goal result line",
  );
  const goalStatus = await page.eval<{
    text: string;
    role: string;
    anchor: boolean;
    hint: string;
    cursor: string;
  }>(`(() => {
    const status = document.querySelector('.feedback-result');
    return {
      text: (status?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      role: status?.getAttribute("role") ?? "",
      anchor: status?.querySelector("a") !== null,
      hint: document.querySelector('.feedback-hint')?.textContent ?? "",
      cursor: document.body.style.cursor,
    };
  })()`);
  const goalPath = `.devboard/goal-proposals/${goalFiles[0]!}`;
  check(goalStatus.role === "status", "the goal result is not a status surface", goalStatus);
  check(
    goalStatus.text === `Goal proposed: ${goalPath}`,
    "the goal result line does not name the draft",
    goalStatus,
  );
  check(!goalStatus.anchor, "the goal result line rendered an anchor", goalStatus);
  check(
    goalStatus.hint.length > 0 && goalStatus.cursor === "crosshair",
    "a proposed goal left selection mode",
    goalStatus,
  );
  const goalText = await readFile(join(goalDir, goalFiles[0]!), "utf8");
  check(
    goalText.startsWith(`# Proposed goal: ${goalSentence}\n`),
    "the draft heading is wrong",
    goalText,
  );
  check(
    !goalText.includes("Unprocessed draft") && !goalText.includes("/goal-spec"),
    "the draft carries a notice line",
    goalText,
  );
  check(goalText.includes(goalSentence), "the draft lost the operator text", goalText);
  check(goalText.includes("## Captured UI context"), "the draft lost its captured context", goalText);
  check(goalText.includes("- Route: `/`"), "the draft lost its route", goalText);
  check(goalText.includes("- Selected element: `"), "the draft lost its selector", goalText);
  check(goalText.includes("### Visible text"), "the draft lost its visible text", goalText);
  check(goalText.includes("### DOM excerpt"), "the draft lost its DOM excerpt", goalText);
  check(
    !/^## (Success criteria|Verification|Boundaries|Stop conditions)$/m.test(goalText),
    "the draft carries a goal-spec section",
    goalText,
  );
  check(
    goalRequests.length === 1 &&
      goalRequests[0]?.report === goalSentence &&
      typeof goalRequests[0]?.selector === "string" &&
      String(goalRequests[0]?.selector ?? "").length > 0 &&
      String(goalRequests[0]?.dom_excerpt ?? "").length > 0 &&
      String(goalRequests[0]?.captured_at ?? "").length > 0,
    "the goal request lacks its text or captured context",
    goalRequests,
  );
  check(goalPosts.length === 1, "the Goal action sent more than one request", goalPosts);
  check(
    feedbackRequests.length === 0 && (await feedbackCalls()).length === 0,
    "the Goal action filed an issue or ran gh",
    feedbackRequests,
  );
  check(
    (await issueState()).pressed.join(",") === "true,false,false",
    "a proposed goal did not return to report selection",
  );
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the goal mode to close");

  await runPalette("app.report");
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the issue reporter for the palette cancel");
  await runPalette("app.report.cancel");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the palette to cancel the issue reporter");
  check((await issueState()).pressed.every((value) => !value), "a canceled mode is still pressed");

  // Two removals from one uninterrupted mode, the second on a control whose
  // activation the selection mode must swallow.
  await clearFeedback();
  await runPalette("app.remove");
  await page.wait(`document.querySelector('.feedback-hint')?.textContent?.includes("to remove") === true`, "the removal hint");
  const removalArmed = await issueState();
  check(removalArmed.pressed.join(",") === "false,true,false", "the removal action is not armed", removalArmed);
  await page.click('[data-testid="status-connection"]');
  await waitForFeedbackCalls(1);
  await delay(150);
  await page.wait(
    `document.querySelector('.feedback-result')?.textContent?.includes("Removal issue filed.") === true`,
    "the removal success link",
  );
  const removalStatus = await page.eval<{ role: string; text: string; href: string }>(`(() => {
    const status = document.querySelector('.feedback-result');
    return {
      role: status?.getAttribute("role") ?? "",
      text: (status?.textContent ?? "").split("\\n").map((value) => value.trim()).filter((value) => value.length > 0).join(" "),
      href: status?.querySelector("a")?.getAttribute("href") ?? "",
    };
  })()`);
  check(removalStatus.role === "status", "a removal success is not a status surface", removalStatus);
  check(removalStatus.text.startsWith("Removal issue filed."), "the removal success text is wrong", removalStatus);
  check(removalStatus.href === stubIssueUrl, "the removal success carries no stub issue URL", removalStatus);
  const removalStillArmed = await issueState();
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
  check(removalRequests.length === 2, "the issue actions did not send two removal requests", feedbackRequests);
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

  // A different action switches modes without filing; two redesigns then file
  // from the same uninterrupted mode.
  await clearFeedback();
  await runPalette("app.redesign");
  await page.wait(`document.querySelector('.feedback-hint')?.textContent?.includes("to redesign") === true`, "the redesign hint");
  const redesignArmed = await issueState();
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
  check(redesignRequests.length === 2, "the issue actions did not send two redesign requests", feedbackRequests);
  const redesignStatus = await page.eval<{ text: string; href: string }>(`(() => {
    const status = document.querySelector('.feedback-result');
    return {
      text: (status?.textContent ?? "").split("\\n").map((value) => value.trim()).filter((value) => value.length > 0).join(" "),
      href: status?.querySelector("a")?.getAttribute("href") ?? "",
    };
  })()`);
  check(redesignStatus.text.startsWith("Redesign issue filed."), "the redesign success text is wrong", redesignStatus);
  check(redesignStatus.href === stubIssueUrl, "the redesign success carries no stub issue URL", redesignStatus);
  check((await issueState()).pressed.join(",") === "false,false,true", "a filed redesign did not stay armed");

  // A delayed filing disables every action and a double-click files once.
  await setFeedbackMode("delay");
  await page.doubleClick('[data-testid="status-connection"]');
  await page.wait(
    `["activity-report", "activity-remove", "activity-redesign"].every((id) => document.querySelector('[data-testid="' + id + '"]')?.disabled === true)`,
    "the issue actions disabled during a delayed filing",
  );
  const filing = await page.eval<{ labels: string[]; active: number }>(`(() => {
    const ids = ["activity-report", "activity-remove", "activity-redesign"];
    const buttons = ids.map((id) => document.querySelector('[data-testid="' + id + '"]'));
    return {
      labels: buttons.map((button) => button?.getAttribute("aria-label") ?? ""),
      active: buttons.findIndex((button) => button?.getAttribute("aria-pressed") === "true"),
    };
  })()`);
  check(
    filing.active === 2 && (filing.labels[filing.active] ?? "").startsWith("Filing"),
    "the active action does not read Filing while filing",
    filing,
  );
  await waitForFeedbackCalls(3);
  await delay(200);
  const delayedCalls = await feedbackCalls();
  check(delayedCalls.length === 3, "a double-click filed more than one issue", delayedCalls.length);
  await page.wait(`document.querySelector('.feedback-result')?.textContent?.includes("Redesign issue filed.") === true`, "the delayed filing status");

  // A failing filing keeps the mode armed, re-enables the actions, and files nothing.
  await setFeedbackMode("fail");
  await page.click('[data-testid="status-connection"]');
  await page.wait(`document.querySelector('.feedback-result[role="alert"]') !== null`, "the redesign failure alert");
  const failure = await page.eval<{
    text: string;
    link: boolean;
    hint: string;
    pressed: string[];
    disabled: boolean[];
  }>(`(() => {
    const alert = document.querySelector('.feedback-result[role="alert"]');
    const ids = ["activity-report", "activity-remove", "activity-redesign"];
    return {
      text: (alert?.textContent ?? "").split("\\n").map((value) => value.trim()).filter((value) => value.length > 0).join(" "),
      link: alert?.querySelector("a") !== null,
      hint: document.querySelector('.feedback-hint')?.textContent ?? "",
      pressed: ids.map((id) => document.querySelector('[data-testid="' + id + '"]')?.getAttribute("aria-pressed") ?? ""),
      disabled: ids.map((id) => document.querySelector('[data-testid="' + id + '"]')?.disabled === true),
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
  check(failure.disabled.every((value) => !value), "a failed redesign left the actions disabled", failure);
  await setFeedbackMode("ok");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "Escape to cancel the shortcut mode");
  check((await issueState()).pressed.every((value) => !value), "Escape left an action pressed");
  // The outcome toast outlives the mode, and its dismiss control closes it.
  check(
    await page.eval<boolean>(`document.querySelector('.feedback-result[role="alert"]') !== null`),
    "Escape hid the failing filing's toast",
  );
  await page.click('.feedback-result__close');
  await page.wait(`document.querySelector('.feedback-result') === null`, "the dismissed filing toast");

  // The result line fits the supported viewport without covering the status
  // bar or the notification region, and the actions stay inside the rail.
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024 && innerHeight === 720`, "the 1024×720 viewport for the issue actions");
  await clearFeedback();
  await runPalette("app.remove");
  await page.click('[data-testid="status-connection"]');
  await waitForFeedbackCalls(1);
  await page.wait(`document.querySelector('.feedback-result[role="status"]') !== null`, "the issue result at 1024×720");
  const issueLayout = await page.eval<{
    resultInside: boolean;
    aboveStatus: boolean;
    clearsRegion: boolean;
    insideRail: boolean;
    label: string;
  }>(`(() => {
    const box = document.querySelector(".feedback-result")?.getBoundingClientRect();
    const status = document.querySelector('[data-testid="status-bar"]')?.getBoundingClientRect();
    const region = document.querySelector('[data-testid="notifications"]')?.getBoundingClientRect();
    const rail = document.querySelector('[data-testid="activity-bar"]')?.getBoundingClientRect();
    const actions = ["activity-report", "activity-remove", "activity-redesign"].map(
      (id) => document.querySelector('[data-testid="' + id + '"]')?.getBoundingClientRect(),
    );
    const overlap = (a, b) =>
      a !== undefined && b !== undefined &&
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return {
      resultInside:
        box !== undefined && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      aboveStatus: box !== undefined && status !== undefined && box.bottom <= status.top + 0.5,
      clearsRegion: !overlap(box, region),
      insideRail: actions.every(
        (rect) =>
          rect !== undefined && rail !== undefined &&
          rect.top >= rail.top - 0.5 && rect.bottom <= rail.bottom + 0.5 &&
          rect.left >= rail.left - 0.5 && rect.right <= rail.right + 0.5,
      ),
      label: document.querySelector('[data-testid="activity-remove"]')?.getAttribute("aria-label") ?? "",
    };
  })()`);
  check(issueLayout.resultInside && issueLayout.aboveStatus, "the issue result leaves the viewport or covers the status bar", issueLayout);
  check(issueLayout.clearsRegion, "the issue result overlaps the notification region", issueLayout);
  check(issueLayout.insideRail, "an issue action leaves the activity bar", issueLayout);
  check(issueLayout.label.includes("Cancel element removal"), "the armed action is not labelled as a cancel", issueLayout);
  await page.screenshot(join(harnessRoot, ".tmp", "interface", "issue-actions-1024x720.png"));
  // A successful filing toast dismisses itself, so it never lingers.
  await page.wait(
    `document.querySelector('.feedback-result') === null`,
    "the success toast to dismiss itself",
    12_000,
  );

  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the 1440×900 viewport after the issue actions");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the issue actions to leave selection mode");
  await page.click('[data-testid="activity-remove"]');
  await page.click('[data-testid="status-connection"]');
  await waitForFeedbackCalls(2);
  await page.wait(`document.querySelector('.feedback-result[role="status"]') !== null`, "the issue result for the screenshots");
  await saveShot("issue-actions-dark");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the issue screenshots to leave selection mode");
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "light"`, "the light theme for the issue screenshot");
  await page.click('[data-testid="activity-redesign"]');
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the redesign mode for the light issue screenshot");
  await saveShot("issue-actions-light");
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the light issue screenshot to leave selection mode");
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "dark"`, "the dark theme after the issue screenshots");

  // 14b. Ask mode: the same panel streams a background agent's plain-text answer.
  const postsBeforeAsk = feedbackPosts.length;
  await runPalette("app.report");
  await page.wait(`document.querySelector('.feedback-hint') !== null`, "the issue reporter picking mode for Ask");
  await page.click('[data-testid="status-bar"]');
  await page.wait(`document.querySelector('.feedback-panel') !== null`, "the report panel for Ask");
  const askActions = await page.eval<string[]>(
    `[...document.querySelectorAll('.feedback-panel .feedback-actions button')].map((button) => button.textContent.trim())`,
  );
  check(
    JSON.stringify(askActions) === JSON.stringify(["File issue", "Ask", "Goal", "Cancel"]),
    "the report panel actions are not File issue, Ask, Goal, Cancel",
    askActions,
  );
  const askControl = await page.eval<{ present: boolean; name: string; label: string; disabled: boolean }>(`(() => {
    const button = document.querySelector('[data-testid="feedback-ask"]');
    return {
      present: button !== null,
      name: button?.getAttribute("aria-label") ?? "",
      label: button?.textContent?.trim() ?? "",
      disabled: button === null || button.disabled,
    };
  })()`);
  check(
    askControl.present && askControl.label === "Ask" && askControl.name.includes("Ask"),
    "the Ask control is missing or unnamed",
    askControl,
  );
  check(askControl.disabled, "Ask is enabled with an empty question", askControl);

  const composer = ".feedback-panel textarea";
  await page.fill(composer, "What does the StatusBar issues label mean?");
  await page.wait(`document.querySelector('[data-testid="feedback-ask"]')?.disabled === false`, "Ask to enable on a question");
  await page.key("Enter");
  const asking = await page.wait<{
    status: string;
    ask: string;
    askDisabled: boolean;
    fileDisabled: boolean;
    textareaDisabled: boolean;
    cancelDisabled: boolean;
    value: string;
  }>(`(() => {
    const status = document.querySelector('.feedback-panel [role="status"]');
    if (status?.textContent?.trim() !== "Asking…") return null;
    const ask = document.querySelector('[data-testid="feedback-ask"]');
    const buttons = [...document.querySelectorAll('.feedback-panel .feedback-actions button')];
    const textarea = document.querySelector('.feedback-panel textarea');
    return {
      status: status.textContent.trim(),
      ask: ask?.textContent?.trim() ?? "",
      askDisabled: ask === null || ask.disabled,
      fileDisabled: buttons[0]?.disabled !== false,
      textareaDisabled: textarea?.disabled !== false,
      cancelDisabled: buttons[3]?.disabled !== false,
      value: textarea?.value ?? "",
    };
  })()`, "the pending ask controls", 8_000);
  check(asking.status === "Asking…" && asking.ask === "Asking…", "the pending ask does not read Asking…", asking);
  check(
    asking.askDisabled && asking.fileDisabled && asking.textareaDisabled && !asking.cancelDisabled,
    "the pending ask controls are wrong",
    asking,
  );
  check(asking.value === "", "the composer did not clear when the question was sent", asking);

  const streaming = await page.wait<{ text: string; pending: boolean; first: string }>(`(() => {
    const agent = document.querySelector('.feedback-panel .feedback-turn--agent');
    const text = agent?.textContent ?? "";
    if (text.length === 0) return null;
    return {
      text,
      pending: document.querySelector('.feedback-panel [role="status"]') !== null,
      first: document.querySelector('.feedback-panel .feedback-turn')?.textContent ?? "",
    };
  })()`, "the first streamed answer chunk", 12_000);
  check(streaming.pending, "the answer appeared only after the turn ended", streaming);
  check(streaming.first === "What does the StatusBar issues label mean?", "the question bubble is wrong", streaming);

  const firstAnswer = await page.wait<{ turns: string[]; focused: string; value: string }>(`(() => {
    const turns = [...document.querySelectorAll('.feedback-panel .feedback-turn')].map((turn) => turn.textContent);
    if (turns.length < 2) return null;
    if ((turns[1] ?? "").length === 0) return null;
    if (document.querySelector('.feedback-panel [role="status"]') !== null) return null;
    return {
      turns,
      focused: document.activeElement?.tagName ?? "",
      value: document.querySelector('.feedback-panel textarea')?.value ?? "",
    };
  })()`, "the completed first answer", 20_000);
  check(firstAnswer.turns[1]!.includes("The issues indicator shows"), "the first answer text is wrong", firstAnswer);
  check(
    !firstAnswer.turns[1]!.includes("Considering the captured element") &&
      !firstAnswer.turns[1]!.includes("Reading the captured element"),
    "thought or tool activity reached the transcript",
    firstAnswer,
  );
  check(!firstAnswer.turns[1]!.includes("```"), "the transcript interpreted Markdown", firstAnswer);
  check(firstAnswer.value === "" && firstAnswer.focused === "TEXTAREA", "the composer did not clear and refocus", firstAnswer);

  await page.fill(composer, "Which file renders it?");
  await page.key("Enter");
  const followUp = await page.wait<{ turns: string[]; value: string }>(`(() => {
    const turns = [...document.querySelectorAll('.feedback-panel .feedback-turn')].map((turn) => turn.textContent);
    if (turns.length < 4) return null;
    if ((turns[3] ?? "").length === 0) return null;
    if (document.querySelector('.feedback-panel [role="status"]') !== null) return null;
    return { turns, value: document.querySelector('.feedback-panel textarea')?.value ?? "" };
  })()`, "the follow-up answer", 20_000);
  check(followUp.turns[2] === "Which file renders it?", "the follow-up question bubble is wrong", followUp);
  check(followUp.turns[3]!.includes("StatusBar.svelte"), "the follow-up answer is wrong", followUp);
  check(followUp.turns[1]!.includes("The issues indicator shows"), "the first answer disappeared", followUp);
  check(followUp.value === "", "the follow-up composer did not clear", followUp);

  await page.focus(composer);
  await page.fill(composer, "Shift newline check");
  const turnsBeforeShift = await page.eval<number>(
    `document.querySelectorAll('.feedback-panel .feedback-turn').length`,
  );
  await page.keyWithText("Enter", "\r", 8);
  await delay(200);
  const shifted = await page.eval<{ value: string; turns: number; askDisabled: boolean }>(`(() => ({
    value: document.querySelector('.feedback-panel textarea')?.value ?? "",
    turns: document.querySelectorAll('.feedback-panel .feedback-turn').length,
    askDisabled: document.querySelector('[data-testid="feedback-ask"]')?.disabled !== false,
  }))()`);
  check(shifted.value.includes("\n"), "Shift+Enter did not insert a newline", shifted);
  check(shifted.turns === turnsBeforeShift, "Shift+Enter sent the question", shifted);
  check(!shifted.askDisabled, "Shift+Enter left Ask disabled with a question", shifted);

  await page.fill(composer, "The Start button is clipped.");
  const filingReady = await page.wait<{ file: boolean; ask: boolean; hint: boolean }>(`(() => {
    const buttons = [...document.querySelectorAll('.feedback-panel .feedback-actions button')];
    const ready = buttons[0]?.textContent?.trim() === "File issue" && buttons[0].disabled === false && buttons[1]?.disabled === false;
    return ready ? {
      file: buttons[0].disabled === false,
      ask: buttons[1]?.disabled === false,
      hint: document.querySelector('.feedback-hint') !== null,
    } : null;
  })()`, "File issue and Ask to stay usable after the answers");
  check(
    filingReady.file && filingReady.ask && !filingReady.hint,
    "the ask broke the filing path",
    filingReady,
  );
  check(feedbackPosts.length === postsBeforeAsk, "an ask posted to /api/feedback", feedbackPosts);

  const transcriptSurface = await page.eval<{
    role: string;
    name: string;
    maxHeight: string;
    overflow: string;
    turns: number;
    roles: string[];
    who: string[];
    developerFill: string;
    agentFill: string;
  }>(`(() => {
    const log = document.querySelector('.feedback-panel [role="log"]');
    const style = log === null ? null : getComputedStyle(log);
    const messages = [...document.querySelectorAll('.feedback-panel .feedback-message')];
    const developer = document.querySelector('.feedback-panel .feedback-turn--developer');
    const agent = document.querySelector('.feedback-panel .feedback-turn--agent');
    return {
      role: log?.getAttribute("role") ?? "",
      name: log?.getAttribute("aria-label") ?? "",
      maxHeight: style?.maxHeight ?? "",
      overflow: style?.overflowY ?? "",
      turns: log?.querySelectorAll('.feedback-turn').length ?? 0,
      roles: messages.map((message) => message.getAttribute("data-role") ?? ""),
      who: messages.map((message) => message.querySelector('.feedback-message__who')?.textContent?.trim() ?? ""),
      developerFill: developer === null ? "" : getComputedStyle(developer).backgroundColor,
      agentFill: agent === null ? "" : getComputedStyle(agent).backgroundColor,
    };
  })()`);
  check(transcriptSurface.role === "log" && transcriptSurface.name.length > 0, "the transcript is not an accessible log", transcriptSurface);
  check(transcriptSurface.maxHeight === "180px" && transcriptSurface.overflow === "auto", "the transcript does not scroll inside 180px", transcriptSurface);
  check(transcriptSurface.turns === 4, "the transcript lost a turn", transcriptSurface);
  check(
    transcriptSurface.roles.join(",") === "developer,agent,developer,agent" &&
      transcriptSurface.who.join(",") === "You,Agent,You,Agent",
    "the transcript does not label who spoke",
    transcriptSurface,
  );
  check(
    transcriptSurface.developerFill.length > 0 &&
      transcriptSurface.agentFill.length > 0 &&
      transcriptSurface.developerFill !== transcriptSurface.agentFill,
    "the question and answer bubbles look the same",
    transcriptSurface,
  );

  const panelFits = (): Promise<{ inside: boolean; width: number; top: number; bottom: number; scroll: boolean }> =>
    page.eval<{ inside: boolean; width: number; top: number; bottom: number; scroll: boolean }>(`(() => {
      const panel = document.querySelector('.feedback-panel');
      const rect = panel?.getBoundingClientRect();
      const log = panel?.querySelector('[role="log"]');
      return {
        inside: rect === undefined ? false : rect.top >= -0.5 && rect.left >= -0.5 && rect.bottom <= innerHeight + 0.5 && rect.right <= innerWidth + 0.5,
        width: Math.round(rect?.width ?? -1),
        top: Math.round(rect?.top ?? -1),
        bottom: Math.round(rect?.bottom ?? -1),
        scroll: log === null ? false : log.scrollHeight >= log.clientHeight,
      };
    })()`);
  const fitsDesktop = await panelFits();
  check(fitsDesktop.inside && fitsDesktop.width === 380, "the ask panel leaves the 1440×900 viewport", fitsDesktop);
  check(fitsDesktop.scroll, "the transcript does not use its scroll surface", fitsDesktop);
  await saveShot("ask-transcript");

  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024 && innerHeight === 720`, "the 1024×720 viewport for the ask transcript");
  await delay(150);
  const fitsNarrow = await panelFits();
  check(fitsNarrow.inside && fitsNarrow.width === 380, "the ask panel leaves the 1024×720 viewport", fitsNarrow);
  await saveShot("ask-transcript-1024");
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the desktop viewport after the ask transcript");
  await delay(150);
  const fitsRestored = await panelFits();
  check(fitsRestored.inside && fitsRestored.width === 380, "the ask panel leaves the restored viewport", fitsRestored);

  const askLog = await readFile(agentLog, "utf8");
  const askSpawns = askLog.split("\n").filter((line) => line.startsWith("ask-spawn ")).length;
  const askPrompts = askLog.split("\n").filter((line) => line.startsWith("ask-prompt ")).length;
  check(askSpawns === 1, `the ask stub started ${askSpawns} peers`, askLog);
  check(askPrompts === 2, `the ask stub answered ${askPrompts} prompts`, askLog);

  // Filing after asking carries the conversation into the issue as context.
  const callsBeforeAsking = (await feedbackCalls()).length;
  await page.click('.feedback-actions button');
  await page.wait(
    `document.querySelector('.feedback-panel') === null && document.querySelector('.feedback-hint') !== null`,
    "the selection mode after filing the asked issue",
  );
  await waitForFeedbackCalls(callsBeforeAsking + 1);
  const askedCall = (await feedbackCalls())[callsBeforeAsking]!;
  check(askedCall.body.includes("## Ask conversation"), "the issue body lost the ask conversation", askedCall.body);
  check(
    askedCall.body.includes("**You:**\n\nWhat does the StatusBar issues label mean?") &&
      askedCall.body.includes("**Agent:**\n\nThe issues indicator shows"),
    "the issue body does not carry the visible turns",
    askedCall.body,
  );
  check(
    askedCall.body.indexOf("## Ask conversation") <
      askedCall.body.indexOf("## Captured UI context"),
    "the ask conversation is not context before the captured element",
    askedCall.body,
  );
  await page.key("Escape");
  await page.wait(`document.querySelector('.feedback-hint') === null`, "the ask selection mode to close");

  // 15. Issues mode: the console, queue, runs, status indicator, and live state.
  await seedIssuesState(stateDir, host, "stopped");
  const stoppedIndicator = await page.wait<{ text: string; title: string; command: string; tag: string }>(
    `(() => {
      const item = document.querySelector('[data-testid="issues-indicator"]');
      if (item === null) return null;
      const text = item.textContent?.trim() ?? "";
      const title = item.getAttribute("title") ?? "";
      if (text !== "issues stopped" || !title.includes("fixture/host")) return null;
      return {
        text,
        title,
        command: item.getAttribute("data-command") ?? "",
        tag: item.tagName,
      };
    })()`,
    "the stopped issues indicator",
    8_000,
  );
  check(stoppedIndicator.command === "view.mode.issues", "the issues indicator has no command", stoppedIndicator);
  check(stoppedIndicator.tag === "BUTTON", "the issues indicator is not a control", stoppedIndicator);
  check(stoppedIndicator.title.includes("fixture/host"), "the issues title does not name the repository", stoppedIndicator);

  await page.click('[data-testid="issues-indicator"]');
  await page.wait(
    `document.querySelector('[data-testid="mode-issues"]')?.getAttribute("aria-selected") === "true"`,
    "Issues from the status indicator",
    8_000,
  );
  const stoppedConsole = await page.eval<{
    visible: boolean;
    overview: boolean;
    repo: string;
    start: boolean;
    pause: boolean;
    resume: boolean;
    stop: boolean;
    check: boolean;
    poll: string;
  }>(`(() => {
    const workspace = document.getElementById("workspace-issues");
    const button = (testid) => document.querySelector('[data-testid="' + testid + '"]');
    return {
      visible: workspace !== null && !workspace.hasAttribute("hidden"),
      overview: button("issues-overview") !== null,
      repo: button("issues-repo")?.textContent?.trim() ?? "",
      start: button("issues-start")?.disabled === true,
      pause: button("issues-pause")?.disabled === true,
      resume: button("issues-resume")?.disabled === true,
      stop: button("issues-stop")?.disabled === true,
      check: button("issues-check-now")?.disabled === true,
      poll: button("issues-poll-text")?.textContent?.trim() ?? "",
    };
  })()`);
  check(stoppedConsole.visible && stoppedConsole.overview, "the Issues pane or overview is missing", stoppedConsole);
  check(stoppedConsole.repo === "fixture/host", "the Issues overview does not name the repository", stoppedConsole);
  check(stoppedConsole.poll === "Not polling", "the stopped poll line does not say it is not polling", stoppedConsole);
  check(
    await page.eval<boolean>(`document.querySelector('[data-testid="issues-state"]') === null`),
    "the Issues overview kept the lifecycle badge",
    stoppedConsole,
  );
  check(
    !stoppedConsole.start && stoppedConsole.pause && stoppedConsole.resume && stoppedConsole.stop && stoppedConsole.check,
    "the stopped controls are not in their exact states",
    stoppedConsole,
  );

  // With no active agent the Agents page explains the empty fleet and links back.
  await runPalette("open.issues.agents");
  await page.wait(
    `document.querySelector('[data-testid="issues-agents-empty"]') !== null`,
    "the empty Agents page",
    8_000,
  );
  const emptyAgents = await page.eval<{ grid: boolean; text: string; action: string; label: string }>(`(() => {
    const action = document.querySelector('[data-testid="issues-agents-overview"]');
    return {
      grid: document.querySelector('[data-testid="issues-agents"]') !== null,
      text: document.querySelector('[data-testid="issues-agents-empty"]')?.textContent ?? "",
      action: action?.getAttribute("data-command") ?? "",
      label: action?.textContent?.trim() ?? "",
    };
  })()`);
  check(!emptyAgents.grid, "the empty Agents page still renders the grid", emptyAgents);
  check(emptyAgents.text.includes("No agents running"), "the empty Agents page has no explanation", emptyAgents);
  check(
    emptyAgents.action === "open.issues.overview" && emptyAgents.label === "Open Overview",
    "the empty Agents page has no Overview recovery",
    emptyAgents,
  );
  await saveShot("issues-agents-page-empty");
  await page.click('[data-testid="issues-agents-overview"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-overview"]') !== null`,
    "the Overview from the empty Agents page",
    8_000,
  );

  await seedIssuesState(stateDir, host, "idle");
  await page.wait(
    `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues idle"`,
    "the idle issues indicator",
    8_000,
  );
  const idleControls = await page.eval<{ start: boolean; check: boolean }>(`(() => ({
    start: document.querySelector('[data-testid="issues-start"]')?.disabled === true,
    check: document.querySelector('[data-testid="issues-check-now"]')?.disabled === true,
  }))()`);
  check(idleControls.start && !idleControls.check, "the idle controls are wrong", idleControls);

  const runningSeededAt = Date.now();
  await seedIssuesState(stateDir, host, "running");
  await page.wait(
    `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues working (3)"`,
    "the working issues indicator",
    8_000,
  );
  const runningDelay = Date.now() - runningSeededAt;
  check(runningDelay <= 2_000, `the issues indicator took ${runningDelay}ms to update`);
  const runningIndicatorTitle = await page.eval<string>(
    `document.querySelector('[data-testid="issues-indicator"]')?.getAttribute("title") ?? ""`,
  );
  check(
    runningIndicatorTitle.includes("running") && runningIndicatorTitle.includes("3 running agent"),
    "the issues indicator title omits the lifecycle or the agent count",
    runningIndicatorTitle,
  );

  // The Overview counts the fleet, lists it in the left column below the
  // Automation panel, and streams the selected agent's output on the right.
  await page.wait(
    `document.querySelector('[data-testid="issues-running-agents"]')?.textContent?.trim() === "3 running"`,
    "the overview running-agent count",
    8_000,
  );
  const overview = await page.eval<{
    cooldowns: string;
    summaryIssues: string[];
    summaryIssueLinks: Array<{ tag: string; text: string; href: string; target: string }>;
    sideBeforeOutput: boolean;
    leftOfOutput: boolean;
    summaryBelowAutomation: boolean;
    outputRun: string;
    outputActivity: string;
    outputQuestion: string;
    selected: string;
    asking: { text: string; tone: string };
    poll: { text: string; tone: string; title: string; dot: number };
  }>(`(() => {
    const side = document.querySelector('[data-testid="issues-overview-side"]');
    const output = document.querySelector('[data-testid="issues-overview-output"]');
    const summary = document.querySelector('[data-testid="issues-agent-summary"]');
    const automation = side?.querySelector(".panel");
    const selected = summary?.querySelector('[aria-current="true"]');
    const sideRect = side?.getBoundingClientRect();
    const outputRect = output?.getBoundingClientRect();
    const automationRect = automation?.getBoundingClientRect();
    const summaryRect = summary?.getBoundingClientRect();
    const poll = document.querySelector('[data-testid="issues-poll"]');
    const asking = document.querySelector('[data-testid="issues-overview-asking"]');
    return {
      cooldowns: document.querySelector('[data-testid="issues-cooldowns"]')?.textContent ?? "",
      summaryIssues: [...(summary?.querySelectorAll(".issues-agent-row") ?? [])].map(
        (item) => item.getAttribute("data-issue") ?? "",
      ),
      summaryIssueLinks: [...(summary?.querySelectorAll(".issues-agent-row__issue") ?? [])].map(
        (link) => ({
          tag: link.tagName,
          text: link.textContent?.trim() ?? "",
          href: link.getAttribute("href") ?? "",
          target: link.getAttribute("target") ?? "",
        }),
      ),
      sideBeforeOutput: side !== null && output !== null && side.nextElementSibling === output,
      leftOfOutput:
        sideRect !== undefined && outputRect !== undefined &&
        sideRect.left < outputRect.left && sideRect.right <= outputRect.left + 1,
      summaryBelowAutomation:
        automationRect !== undefined && summaryRect !== undefined &&
        summaryRect.top >= automationRect.bottom - 1,
      outputRun: output?.getAttribute("data-run") ?? "",
      outputActivity: document.querySelector('[data-testid="issues-overview-activity"]')?.textContent ?? "",
      outputQuestion: document.querySelector('[data-testid="issues-overview-question"]')?.textContent ?? "",
      selected: selected?.getAttribute("data-run") ?? "",
      asking: {
        text: asking?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
        tone: asking?.getAttribute("data-tone") ?? "",
      },
      poll: {
        text: poll?.querySelector(".issues-poll__label")?.textContent?.trim() ?? "",
        tone: poll?.getAttribute("data-tone") ?? "",
        title: poll?.getAttribute("title") ?? "",
        dot: parseFloat(getComputedStyle(poll?.querySelector(".issues-poll__dot") ?? document.body).width),
      },
    };
  })()`);
  check(
    overview.cooldowns.includes("0 cooling") && overview.cooldowns.includes("none"),
    "the overview does not name the cooldown count and earliest time",
    overview,
  );
  check(
    overview.asking.text === "3 need answers" && overview.asking.tone === "warning",
    "the running-agent header does not count the blocked agents",
    overview.asking,
  );
  check(
    overview.poll.tone === "active" &&
      /^Every 10s · checked .+$/.test(overview.poll.text) &&
      /Poll interval 10s · last check \d{4}-\d{2}-\d{2}T/.test(overview.poll.title) &&
      overview.poll.dot === 6,
    "the poll line does not state the cadence, last check, and active dot",
    overview.poll,
  );
  await saveShot("issues-poll");

  // The poll line is the right end of a 30px header: it must not collide with
  // the title or lose its dot at the narrow supported viewport.
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024`, "the 1024×720 poll line");
  const narrowPoll = await page.eval<{
    header: number;
    inside: boolean;
    separated: boolean;
    labelClipped: boolean;
  }>(`(() => {
    const poll = document.querySelector('[data-testid="issues-poll"]');
    const header = poll?.closest(".panel__header");
    const title = header?.querySelector(".panel__title");
    const label = poll?.querySelector(".issues-poll__label");
    const pollRect = poll?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const titleRect = title?.getBoundingClientRect();
    return {
      header: headerRect?.height ?? 0,
      inside: pollRect !== undefined && headerRect !== undefined &&
        pollRect.top >= headerRect.top - 0.5 && pollRect.bottom <= headerRect.bottom + 0.5 &&
        pollRect.right <= headerRect.right + 0.5,
      separated: pollRect !== undefined && titleRect !== undefined && pollRect.left >= titleRect.right,
      labelClipped: label !== null && label !== undefined && label.scrollWidth > label.clientWidth,
    };
  })()`);
  check(
    narrowPoll.header === 30 && narrowPoll.inside && narrowPoll.separated && !narrowPoll.labelClipped,
    "the poll line collides with its title or clips at 1024×720",
    narrowPoll,
  );
  await page.screenshot(join(harnessRoot, ".tmp", "interface", "issues-poll-1024x720.png"));
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the 1440×900 viewport after the poll line");
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "light"`, "the light theme for the poll line");
  await saveShot("issues-poll-light");
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "dark"`, "the dark theme after the poll line");

  check(
    overview.summaryIssues.join(",") === "17,18,19",
    "the overview does not list every running agent",
    overview,
  );
  check(
    overview.summaryIssueLinks.length === 3 &&
      overview.summaryIssueLinks.every(
        (link, index) =>
          link.tag === "A" &&
          link.text === `#${[17, 18, 19][index]}` &&
          link.href === `https://github.com/fixture/host/issues/${[17, 18, 19][index]}` &&
          link.target === "_blank",
      ),
    "the overview running-agent issue numbers are not tracker links",
    overview.summaryIssueLinks,
  );
  check(overview.sideBeforeOutput, "the agent list is not in the left column", overview);
  check(overview.leftOfOutput, "the side column does not sit to the left of the output", overview);
  check(
    overview.summaryBelowAutomation,
    "the agent list is not directly after the Automation panel",
    overview,
  );
  check(
    overview.outputRun === "2026-10-27T10-00-01-000Z" && overview.selected === overview.outputRun,
    "the overview does not stream the first agent by default",
    overview,
  );
  check(
    overview.outputActivity.includes("Implementing issue 17") &&
      overview.outputActivity.includes("Implementing issue 18") === false,
    "the overview output does not hold the selected agent's activity",
    overview,
  );
  check(
    overview.outputQuestion.includes("Which scope should issue 17 take?"),
    "the overview output does not hold the selected agent's question",
    overview,
  );

  await page.click('[data-testid="issues-agent-summary"] .issues-agent-row__open[data-issue="18"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-overview-output"]')?.getAttribute("data-run") ===
       "2026-10-27T10-00-02-000Z" &&
     document.querySelector('[data-testid="issues-overview-activity"]')?.textContent?.includes("Implementing issue 18") === true`,
    "the output of the clicked agent",
    8_000,
  );
  const switched = await page.eval<{ activity: string; question: string; selected: string }>(`(() => ({
    activity: document.querySelector('[data-testid="issues-overview-activity"]')?.textContent ?? "",
    question: document.querySelector('[data-testid="issues-overview-question"]')?.textContent ?? "",
    selected: document.querySelector('[data-testid="issues-agent-summary"] [aria-current="true"]')?.getAttribute("data-run") ?? "",
  }))()`);
  check(
    switched.activity.includes("Implementing issue 17") === false,
    "the output kept another agent's activity",
    switched,
  );
  check(
    switched.question.includes("Which scope should issue 18 take?") &&
      switched.question.includes("Which scope should issue 17 take?") === false,
    "the output kept another agent's question",
    switched,
  );
  check(
    switched.selected === "2026-10-27T10-00-02-000Z",
    "the agent list does not mark the selected agent",
    switched,
  );

  const closeControls = await page.eval<
    Array<{ issue: string; label: string; title: string; disabled: boolean }>
  >(`[...document.querySelectorAll('[data-testid="issues-close-issue"]')].map((button) => ({
    issue: button.getAttribute("data-issue") ?? "",
    label: button.getAttribute("aria-label") ?? "",
    title: button.getAttribute("title") ?? "",
    disabled: button.disabled === true,
  }))`);
  check(
    closeControls.map((control) => control.issue).join(",") === "17,18,19",
    "the running-agent rows lack a close control for every agent",
    closeControls,
  );
  check(
    closeControls.every(
      (control) =>
        control.label === `Close issue #${control.issue}` &&
        control.title.includes("not planned") &&
        !control.disabled,
    ),
    "a close control is mislabeled or disabled",
    closeControls,
  );

  // The sidebar no longer lists Agents; the palette still opens the tab.
  check(
    await page.eval<boolean>(`document.querySelector('[data-testid="open-issues-agents"]') === null`),
    "the Issues sidebar still lists Agents",
  );

  await runPalette("open.issues.agents");
  await page.wait(
    `document.querySelector('[data-testid="issues-agents-page"]') !== null &&
     document.querySelectorAll('[data-testid="issues-agent"]').length === 3`,
    "the three agent cards",
    8_000,
  );
  const cards = await page.eval<
    Array<{
      issue: string;
      run: string;
      status: string;
      activity: string;
      question: string;
      linked: string;
    }>
  >(`[...document.querySelectorAll('[data-testid="issues-agent"]')].map((card) => ({
    issue: card.getAttribute("data-issue") ?? "",
    run: card.getAttribute("data-run") ?? "",
    status: card.getAttribute("data-status") ?? "",
    activity: card.querySelector('[data-testid="issues-agent-activity"]')?.textContent ?? "",
    question: card.querySelector('[data-testid="issues-agent-question"]')?.textContent ?? "",
    linked: card.querySelector("a")?.getAttribute("href") ?? "",
  }))`);
  check(cards.length === 3, "the Agents page lost an agent", cards);
  check(cards.map((card) => card.issue).join(",") === "17,18,19", "the cards are not sorted by issue", cards);
  check(
    cards.every((card, index) => card.activity.includes(`Implementing issue ${17 + index}`)),
    "a card does not render its own activity",
    cards,
  );
  check(
    cards[0]?.activity.includes("Implementing issue 18") === false &&
      cards[1]?.activity.includes("Implementing issue 17") === false,
    "two cards share activity",
    cards,
  );
  check(
    cards.every((card, index) => card.question.includes(`Which scope should issue ${17 + index} take?`)),
    "a card does not render its own question",
    cards,
  );
  check(
    cards.every((card, index) => card.linked === `https://github.com/fixture/host/issues/${17 + index}`),
    "a card's issue number does not link to its tracker URL",
    cards,
  );
  check(cards.every((card) => card.status === "running"), "a card has the wrong status", cards);
  const agentsHeader = await page.eval<{ count: string; asking: string; title: string; eyebrow: string }>(`(() => ({
    count: document.querySelector('[data-testid="issues-agents-count"]')?.textContent?.trim() ?? "",
    asking: document.querySelector('[data-testid="issues-agents-asking"]')?.textContent?.trim() ?? "",
    title: document.querySelector('[data-testid="issues-agents-header"] h1')?.textContent?.trim() ?? "",
    eyebrow: document.querySelector('[data-testid="issues-agents-header"] .page-header__eyebrow')?.textContent?.trim() ?? "",
  }))()`);
  check(
    agentsHeader.count === "3 running" && agentsHeader.asking === "3 need an answer",
    "the Agents header does not count the fleet and its questions",
    agentsHeader,
  );
  check(agentsHeader.title === "Agents" && agentsHeader.eyebrow === "Issues", "the Agents header identity is wrong", agentsHeader);
  const cardsFit = await page.eval<
    Array<{
      issue: string;
      activityInside: boolean;
      asked: boolean;
      stateBadge: string;
      activityLabel: string;
      titleHeight: number;
      cardHeight: number;
      cardBottom: number;
      logHeight: number;
    }>
  >(
    `[...document.querySelectorAll('[data-testid="issues-agent"]')].map((card) => {
      const cardBox = card.getBoundingClientRect();
      const activityBox = card.querySelector('[data-testid="issues-agent-activity"]')?.getBoundingClientRect();
      return {
        issue: card.getAttribute("data-issue") ?? "",
        activityInside: activityBox !== undefined && activityBox.bottom <= cardBox.bottom + 0.5,
        asked: card.getAttribute("data-asked") === "true",
        stateBadge: card.querySelector(".issues-agent__head .badge")?.textContent?.trim() ?? "",
        activityLabel: card.querySelector(".issues-agent__activity-label")?.textContent?.trim() ?? "",
        titleHeight: card.querySelector(".issues-agent__title")?.getBoundingClientRect().height ?? 0,
        cardHeight: cardBox.height,
        cardBottom: cardBox.bottom,
        logHeight: activityBox?.height ?? 0,
      };
    })`,
  );
  check(
    cardsFit.every((card) => card.activityInside),
    "an agent card clips its activity",
    cardsFit,
  );
  check(
    cardsFit.every((card) => card.asked),
    "a card with a pending question does not mark it",
    cardsFit,
  );
  check(
    cardsFit.every((card) => card.stateBadge === ""),
    "a card repeats the fleet state in a badge",
    cardsFit,
  );
  check(
    cardsFit.every((card) => card.activityLabel === "Latest activity"),
    "an agent card does not label its activity",
    cardsFit,
  );
  check(
    new Set(cardsFit.map((card) => Math.round(card.titleHeight))).size === 1,
    "agent titles do not reserve the same height",
    cardsFit,
  );
  check(
    Math.round(cardsFit[0]?.cardHeight ?? 0) === Math.round(cardsFit[1]?.cardHeight ?? 0) &&
      Math.abs((cardsFit[0]?.cardBottom ?? 0) - (cardsFit[1]?.cardBottom ?? 0)) <= 0.5,
    "agent cards in one row do not share a height",
    cardsFit,
  );
  check(
    cardsFit.every((card) => Math.round(card.logHeight) === 64),
    "a waiting card's activity log is not the compact 64px block",
    cardsFit,
  );
  await saveShot("issues-agents-page");
  check(
    await page.eval<boolean>(
      `(() => {
        const grid = document.querySelector('[data-testid="issues-agents"]');
        return grid !== null && grid.scrollWidth <= grid.clientWidth + 1;
      })()`,
    ),
    "the Agents grid overflows horizontally",
  );
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024 && innerHeight === 720`, "the supported floor on the Agents page");
  check(
    await page.eval<number>(
      `getComputedStyle(document.querySelector('[data-testid="issues-agents"]')).gridTemplateColumns.split(" ").length`,
    ) === 1,
    "the Agents grid does not fall to one column at 1024px",
  );
  check(
    await page.eval<boolean>(
      `(() => {
        const grid = document.querySelector('[data-testid="issues-agents"]');
        return grid !== null && grid.scrollWidth <= grid.clientWidth + 1;
      })()`,
    ),
    "the Agents grid overflows horizontally at 1024px",
  );
  await saveShot("issues-agents-page-1024");
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the desktop viewport after the Agents check");
  check(
    await page.eval<number>(`document.querySelectorAll('[data-testid="issues-activity"]').length`) === 0,
    "the Agents page renders a singular activity log",
  );
  check(
    await page.eval<number>(`document.querySelectorAll('[data-testid="issues-question"]').length`) === 0,
    "the Agents page renders a singular question",
  );

  // An answer carries its run id and clears only that agent's question.
  await page.fill(
    '[data-testid="issues-agent-answer-input"][data-run="2026-10-27T10-00-02-000Z"]',
    "The whole issue",
  );
  await page.click('[data-testid="issues-agent-answer-submit"][data-run="2026-10-27T10-00-02-000Z"]');
  const controlDir = join(stateDir, "issues", journalKey(host), "control");
  const answerDeadline = Date.now() + 8_000;
  let answerCommand: { runId?: unknown; value?: unknown } | undefined;
  while (Date.now() < answerDeadline) {
    if (existsSync(controlDir)) {
      const names = (await readdir(controlDir)).filter((name) => name.endsWith(".json")).sort();
      for (const name of names) {
        const parsed = JSON.parse(await readFile(join(controlDir, name), "utf8")) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "value" in parsed &&
          "runId" in parsed
        ) {
          answerCommand = { runId: parsed.runId, value: parsed.value };
        }
      }
      if (answerCommand !== undefined) break;
    }
    await delay(50);
  }
  check(
    answerCommand?.runId === "2026-10-27T10-00-02-000Z" &&
      answerCommand?.value === "The whole issue",
    "the answer did not carry its run id",
    answerCommand,
  );

  // The worker would clear only the asking agent's question.
  await seedIssuesState(stateDir, host, "running", "2026-10-27T10-00-02-000Z");
  await page.wait(
    `document.querySelectorAll('[data-testid="issues-agent-question"]').length === 2`,
    "the two remaining questions",
    8_000,
  );
  const afterAnswer = await page.eval<Array<{ run: string; asked: boolean }>>(
    `[...document.querySelectorAll('[data-testid="issues-agent"]')].map((card) => ({
      run: card.getAttribute("data-run") ?? "",
      asked: card.querySelector('[data-testid="issues-agent-question"]') !== null,
    }))`,
  );
  check(
    afterAnswer.length === 3 &&
      afterAnswer[0]?.asked === true &&
      afterAnswer[1]?.asked === false &&
      afterAnswer[2]?.asked === true,
    "answering one agent changed another agent's question",
    afterAnswer,
  );
  check(
    await page.eval<string>(
      `document.querySelector('[data-testid="issues-agents-asking"]')?.textContent?.trim() ?? ""`,
    ) === "2 need an answer",
    "the Agents header did not follow the remaining questions",
  );
  check(
    await page.eval<number>(
      `document.querySelectorAll('[data-testid="issues-agent"][data-asked="true"]').length`,
    ) === 2,
    "the question marker did not follow the remaining questions",
  );

  // A card opens a focus tab that keeps its own status, activity, and question.
  await page.click('[data-testid="issues-agent-open"][data-run="2026-10-27T10-00-01-000Z"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-agent-focus"]') !== null`,
    "the agent focus tab",
    8_000,
  );
  const focus = await page.eval<{
    status: string;
    activity: string;
    question: string;
    closeCommand: string;
    runLabel: string;
    runId: string;
    runIdTitle: string;
    runIdClass: string;
    runStarted: string;
    runStartedTitle: string;
    rawSubtitle: string;
  }>(`(() => ({
    status: document.querySelector('[data-testid="issues-agent-focus-status"]')?.textContent?.trim() ?? "",
    activity: document.querySelector('[data-testid="issues-agent-focus-activity"]')?.textContent ?? "",
    question: document.querySelector('[data-testid="issues-agent-focus-question"]')?.textContent ?? "",
    closeCommand: document.querySelector('[data-testid="issues-agent-focus-close"]')?.getAttribute("data-command") ?? "",
    runLabel: document.querySelector('[data-testid="issues-agent-focus-run"] .issues-run-identity__label')?.textContent?.trim() ?? "",
    runId: document.querySelector('[data-testid="issues-agent-focus-run-id"]')?.textContent?.trim() ?? "",
    runIdTitle: document.querySelector('[data-testid="issues-agent-focus-run-id"]')?.getAttribute("title") ?? "",
    runIdClass: document.querySelector('[data-testid="issues-agent-focus-run-id"]')?.getAttribute("class") ?? "",
    runStarted: document.querySelector('[data-testid="issues-agent-focus-run-started"]')?.textContent?.trim() ?? "",
    runStartedTitle: document.querySelector('[data-testid="issues-agent-focus-run-started"]')?.getAttribute("title") ?? "",
    rawSubtitle: document.querySelector('.issues-agent-focus .panel__subtitle')?.textContent?.trim() ?? "",
  }))()`);
  check(focus.status === "running", "the focus tab lost the run status", focus);
  check(focus.activity.includes("Implementing issue 17"), "the focus tab lost the run activity", focus);
  check(
    focus.question.includes("Which scope should issue 17 take?"),
    "the focus tab lost the run question",
    focus,
  );
  check(focus.closeCommand === "tab.close", "the focus tab has no close control", focus);
  check(
    focus.runLabel === "Run" &&
      focus.runId === "2026-10-27T10-00-01-000Z" &&
      focus.runIdTitle.includes("2026-10-27T10-00-01-000Z") &&
      focus.runIdClass.includes("code-chip"),
    "the focus tab does not name its run as a chip",
    focus,
  );
  check(
    focus.runStarted.startsWith("Started ") &&
      focus.runStartedTitle === "Started 2026-10-27T10:00:01.000Z",
    "the focus tab does not state when the run started",
    focus,
  );
  check(focus.rawSubtitle === "", "the focus tab still renders a bare run-id subtitle", focus);
  await saveShot("issues-agent-focus");
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(
    `document.documentElement.dataset.theme === "light"`,
    "the light theme for the focus screenshot",
  );
  await saveShot("issues-agent-focus-light");
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(
    `document.documentElement.dataset.theme === "dark"`,
    "the dark theme after the focus screenshot",
  );

  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024`, "the focus tab at 1024×720");
  const narrowIdentity = await page.eval<{
    right: number;
    headerRight: number;
    chip: number;
    title: number;
  }>(`(() => {
    const header = document.querySelector('[data-testid="issues-agent-focus"] .panel__header');
    const identity = document.querySelector('[data-testid="issues-agent-focus-run"]');
    const chip = document.querySelector('[data-testid="issues-agent-focus-run-id"]');
    return {
      right: identity?.getBoundingClientRect().right ?? 0,
      headerRight: header?.getBoundingClientRect().right ?? 0,
      chip: chip?.getBoundingClientRect().width ?? 0,
      title: document.querySelector('[data-testid="issues-agent-focus"] .panel__title')
        ?.getBoundingClientRect().width ?? 0,
    };
  })()`);
  check(
    narrowIdentity.title > 0 &&
      narrowIdentity.right <= narrowIdentity.headerRight &&
      narrowIdentity.chip <= 220.5,
    "the run identity breaks the panel header at 1024×720",
    narrowIdentity,
  );
  await saveShot("issues-agent-focus-1024x720");
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the desktop viewport after the focus check");

  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="issues-agent-focus-activity"]')?.textContent?.includes("Implementing issue 17") === true`,
    "the focus tab after reload",
    20_000,
  );
  check(
    await page.eval<boolean>(
      `document.querySelector('[data-testid="issues-agent-focus-status"]')?.textContent?.trim() === "running"`,
    ),
    "reload lost the focus status",
  );

  // A finished run restored from a persisted agent tab requests its history
  // only after the socket opens: exactly one frame, no connection error, and
  // the run detail instead of the permanent loading state.
  await seedIssuesState(stateDir, host, "paused");
  await page.wait(
    `document.querySelector('[data-testid="issues-agent-focus-status"]')?.textContent?.trim() === "succeeded"`,
    "the finished run before the restore",
    8_000,
  );
  await devtools.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const frames = [];
      window.__devboardSentCommands = frames;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const command = JSON.parse(String(data));
          if (command !== null && typeof command === "object") frames.push(command);
        } catch {
          // A non-JSON frame is not a client command.
        }
        return send.call(this, data);
      };
    })();`,
  });
  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="issues-agent-focus-activity"]')?.textContent?.includes("Implementing issue 17") === true &&
     document.querySelector('[data-testid="issues-agent-focus-status"]')?.textContent?.trim() === "succeeded"`,
    "the restored finished run",
    20_000,
  );
  const restoredRun = await page.eval<{
    frames: Array<{ type?: unknown; runId?: unknown }>;
    loading: boolean;
    activity: string;
    notifications: string;
  }>(`(() => ({
    frames: (window.__devboardSentCommands ?? []).filter((command) => command.type === "getIssuesRun"),
    loading: (document.querySelector('[data-testid="issues-agent-focus"]')?.textContent ?? "").includes("Loading the run from history"),
    activity: document.querySelector('[data-testid="issues-agent-focus-activity"]')?.textContent ?? "",
    notifications: document.querySelector('[data-testid="notifications"]')?.textContent ?? "",
  }))()`);
  check(
    restoredRun.frames.length === 1 &&
      restoredRun.frames[0]?.runId === "2026-10-27T10-00-01-000Z",
    "restoring the agent tab did not send exactly one run request",
    restoredRun.frames,
  );
  check(!restoredRun.loading, "the restored run stayed in the loading state", restoredRun);
  check(
    restoredRun.activity.includes("Implementing issue 17"),
    "the restored run lost its activity",
    restoredRun,
  );
  check(
    !restoredRun.notifications.includes("Not connected to the server."),
    "restoring the agent tab raised a connection error",
    restoredRun.notifications,
  );
  await seedIssuesState(stateDir, host, "running");
  await page.wait(
    `document.querySelector('[data-testid="issues-agent-focus-status"]')?.textContent?.trim() === "running"`,
    "the running focus tab after the restore check",
    8_000,
  );

  await page.click('[data-testid="issues-agent-focus-close"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-agents-page"]') !== null`,
    "the Agents page after closing the focus tab",
    8_000,
  );

  await page.click('[data-testid="open-issues-queue"]');
  await page.wait(`document.querySelector('[data-testid="issues-queue"]') !== null`, "the issues queue");
  const queue = await page.eval<Array<{ number: string; handled: string; goal: string; run: string }>>(
    `[...document.querySelectorAll('[data-testid="issues-queue-item"]')].map((item) => ({
      number: item.getAttribute("data-number") ?? "",
      handled: item.getAttribute("data-handled") ?? "",
      goal: item.getAttribute("data-goal") ?? "",
      run: item.getAttribute("data-run") ?? "",
    }))`,
  );
  check(queue.length === 5, "the queue does not list every open issue", queue);
  check(
    queue.map((entry) => entry.number).join(",") === "17,18,19,20,21",
    "the queue is not sorted by number",
    queue,
  );
  check(
    queue.every((entry, index) => entry.goal === (index >= 2 ? "true" : "false")),
    "a goal label is not visible on its issue",
    queue,
  );
  check(queue.every((entry) => entry.handled === "false"), "a pending issue is not marked pending", queue);
  check(
    queue.slice(0, 3).every((entry) => entry.run.length > 0) &&
      queue.slice(3).every((entry) => entry.run === ""),
    "the queue does not show each issue's running agent",
    queue,
  );
  check(
    await page.eval<number>(`document.querySelectorAll('[data-testid="issues-running-marker"]').length`) === 3,
    "the queue has no running marker for an active agent",
  );
  const goalBadges = await page.eval<number>(
    `document.querySelectorAll('[data-testid="issues-goal-badge"]').length`,
  );
  check(goalBadges === 3, "the goal issues carry no goal badge", goalBadges);
  const queueGeometry = await page.eval<{
    heights: number[];
    goalTop: number | null;
    stateTop: number | null;
    stateRight: number | null;
    panelRight: number | null;
  }>(`(() => {
    const items = [...document.querySelectorAll('[data-testid="issues-queue-item"]')];
    const goalItem = items.find((item) => item.querySelector('[data-testid="issues-goal-badge"]') && item.querySelector('[data-testid="issues-running-marker"]'));
    const goal = goalItem?.querySelector('[data-testid="issues-goal-badge"]')?.getBoundingClientRect();
    const state = goalItem?.querySelector('[data-testid="issues-running-marker"]')?.getBoundingClientRect();
    const panel = document.querySelector('[data-testid="issues-queue"]')?.getBoundingClientRect();
    return {
      heights: items.map((item) => Math.round(item.getBoundingClientRect().height)),
      goalTop: goal ? Math.round(goal.top) : null,
      stateTop: state ? Math.round(state.top) : null,
      stateRight: state ? Math.round(state.right) : null,
      panelRight: panel ? Math.round(panel.right) : null,
    };
  })()`);
  check(
    new Set(queueGeometry.heights).size === 1,
    "the queue rows do not share one height",
    queueGeometry.heights,
  );
  check(
    queueGeometry.goalTop !== null &&
      queueGeometry.stateTop !== null &&
      Math.abs(queueGeometry.goalTop - queueGeometry.stateTop) <= 1,
    "the goal and state badges do not sit on one line",
    queueGeometry,
  );
  check(
    queueGeometry.stateRight !== null &&
      queueGeometry.panelRight !== null &&
      Math.abs(queueGeometry.stateRight - queueGeometry.panelRight) <= 13,
    "the state badge is not on the row's trailing edge",
    queueGeometry,
  );
  const pendingMeta = await page.eval<string>(
    `document.querySelector('[data-testid="open-issues-queue"] .sidebar-item__meta')?.textContent ?? ""`,
  );
  check(pendingMeta.trim() === "5 pending", "the sidebar does not count every pending issue", pendingMeta);

  await page.click('[data-testid="open-issues-runs"]');
  await page.wait(`document.querySelector('[data-testid="issues-runs"]') !== null`, "the runs page");
  const runCount = await page.eval<number>(`document.querySelectorAll('[data-testid="issues-run"]').length`);
  check(runCount === 4, "the runs page does not list every concurrent run", runCount);
  const goalRunCount = await page.eval<number>(
    `[...document.querySelectorAll('[data-testid="issues-run"]')].filter((run) => run.getAttribute("data-status") === "running").length`,
  );
  check(goalRunCount === 3, "the runs page lost a running agent", goalRunCount);
  await page.click('[data-testid="issues-run"]');
  await page.wait(`document.querySelector('[data-testid="issues-run-detail"]') !== null`, "the run detail");
  const runActivity = await page.eval<string>(
    `document.querySelector('[data-testid="issues-run-activity"]')?.textContent ?? ""`,
  );
  check(runActivity.includes("Implementing issue 16"), "the run detail does not show its activity", runActivity);
  await page.click('[data-testid="open-issues-overview"]');
  await page.wait(`document.querySelector('[data-testid="issues-overview"]') !== null`, "the issues overview again");

  // Drafts: list, read, elaborate, answer, stop, refresh, reload, and empty.
  await seedGoalDrafts(host);
  await page.click('[data-testid="open-issues-drafts"]');
  await page.wait(`document.querySelector('[data-testid="issues-drafts"]') !== null`, "the drafts page");
  const draftsChrome = await page.eval<{
    entryTestid: string;
    command: string;
    label: string;
    count: string;
    afterRuns: boolean;
    palette: boolean;
  }>(`(() => {
    const entry = document.querySelector('[data-testid="open-issues-drafts"]');
    const runs = document.querySelector('[data-testid="open-issues-runs"]');
    return {
      entryTestid: entry?.getAttribute("data-testid") ?? "",
      command: entry?.getAttribute("data-command") ?? "",
      label: entry?.getAttribute("aria-label") ?? "",
      count: entry?.querySelector(".sidebar-item__meta")?.textContent?.trim() ?? "",
      afterRuns: runs !== null && runs.nextElementSibling === entry,
      palette: window.__viFrames.some((frame) => frame.includes("open.issues.drafts")) ||
        [...document.querySelectorAll('[data-command="open.issues.drafts"]')].length > 0,
    };
  })()`);
  check(draftsChrome.entryTestid === "open-issues-drafts", "the Drafts entry has no test id", draftsChrome);
  check(draftsChrome.command === "open.issues.drafts", "the Drafts entry has the wrong command", draftsChrome);
  check(
    draftsChrome.label.includes("Issues") && draftsChrome.label.includes("Alt+2"),
    "the Drafts entry does not name its mode and shortcut",
    draftsChrome,
  );
  check(draftsChrome.count === "3", "the Drafts entry does not count the listed drafts", draftsChrome);
  check(draftsChrome.afterRuns, "the Drafts entry is not after Runs", draftsChrome);

  const listedDrafts = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="issues-draft"]')].map((item) => item.getAttribute("data-path") ?? "")`,
  );
  const draftDirectory = join(host, ".devboard", "goal-proposals");
  const expectedDrafts = (await readdir(draftDirectory))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `.devboard/goal-proposals/${name}`);
  check(
    listedDrafts.join(",") === expectedDrafts.join(",") && listedDrafts.length === 3,
    "the drafts list is missing, unsorted, or lists the wrong files",
    { listedDrafts, expectedDrafts },
  );
  const draftHeadings = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="issues-draft"]')].map((item) => item.textContent ?? "")`,
  );
  check(
    draftHeadings[0]?.includes("Question draft") === true &&
      draftHeadings[1]?.includes("Hang draft") === true,
    "a draft does not show its first heading",
    draftHeadings,
  );

  // The report panel's earlier write is listed and its bytes are exact.
  const reportDraftPath = expectedDrafts.find((path) => path.includes(goalFiles[0]!));
  check(reportDraftPath !== undefined, "the report panel's draft is missing from the list", expectedDrafts);
  await page.click(`[data-testid="issues-draft"][data-path="${reportDraftPath}"]`);
  await page.wait(`document.querySelector('[data-testid="issues-draft-detail"]') !== null`, "the draft detail");
  const detail = await page.eval<{
    path: string;
    context: string;
    start: string;
    startCommand: string;
    stop: boolean;
    pathLabel: string;
    proposal: string;
    facts: number;
    evidence: number;
    evidenceDisclosure: boolean;
  }>(`(() => {
    const panel = document.querySelector('[data-testid="issues-draft-detail"]');
    const start = document.querySelector('[data-testid="issues-draft-start"]');
    return {
      path: panel?.getAttribute("data-path") ?? "",
      context: document.querySelector('[data-testid="issues-draft-context"]')?.textContent ?? "",
      start: document.querySelector('[data-testid="issues-draft-start"]') !== null ? "yes" : "",
      startCommand: start?.getAttribute("data-command") ?? "",
      stop: document.querySelector('[data-testid="issues-draft-stop"]') !== null,
      pathLabel: panel?.querySelector(".issues-draft-detail__path")?.textContent?.trim() ?? "",
      proposal: panel?.querySelector(".issues-draft-detail__prose")?.textContent ?? "",
      facts: panel?.querySelectorAll('[data-testid="issues-draft-context"] dt').length ?? 0,
      evidence: panel?.querySelectorAll(".issues-draft-evidence__section").length ?? 0,
      evidenceDisclosure: panel?.querySelector("details.issues-draft-evidence") !== null,
    };
  })()`);
  check(detail.path === reportDraftPath, "the detail does not name the selected draft", detail);
  const storedSelection = await page.eval<{ path: string | null; page: string | null }>(`(() => ({
    path: localStorage.getItem("devboard.issues.draft.v1"),
    page: localStorage.getItem("devboard.issues.draftsPage.v1"),
  }))()`);
  check(
    storedSelection.path === reportDraftPath && storedSelection.page === "1",
    "the draft selection is not persisted",
    storedSelection,
  );
  check(
    detail.context.includes("Route:") &&
      detail.context.includes("Selected element:") &&
      detail.context.includes("Visible text"),
    "the detail lost the captured UI context",
    detail,
  );
  check(
    detail.pathLabel.endsWith(".md") &&
      !detail.proposal.includes("## Captured UI context") &&
      !detail.proposal.includes("Unprocessed draft"),
    "the detail does not separate identity and proposal from the evidence",
    detail,
  );
  check(
    detail.facts > 0 && detail.evidence > 0 && !detail.evidenceDisclosure,
    "the compact context or the inline evidence is missing",
    detail,
  );
  await dismissNotifications();
  await saveShot("issues-draft-detail");
  check(
    detail.start === "yes" && detail.startCommand === "issues.draft.start" && !detail.stop,
    "the draft detail has the wrong controls",
    detail,
  );

  // The question draft asks, answers, writes the spec, and disappears.
  await page.click('[data-testid="issues-draft"][data-path=".devboard/goal-proposals/001-question.md"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/001-question.md"`,
    "the question draft detail",
  );
  await page.click('[data-testid="issues-draft-start"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent?.includes("Reading the draft")`,
    "the streamed elaboration activity",
    8_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-question"]') !== null`,
    "the elaboration question",
    8_000,
  );
  const draftQuestion = await page.eval<{ message: string; options: number; recommended: boolean }>(`(() => ({
    message: document.querySelector('[data-testid="issues-draft-question"]')?.textContent?.includes("Choose an answer") ?? false,
    options: document.querySelectorAll('[data-testid="issues-draft-choice"]').length,
    recommended:
      document.querySelector('[data-testid="issues-draft-choice"]')?.querySelector('.choice__recommended') !== null,
  }))()`);
  check(
    draftQuestion.message && draftQuestion.options === 2 && draftQuestion.recommended,
    "the elaboration question is not surfaced with a recommended first option",
    draftQuestion,
  );
  const questionLayout = await page.eval<{
    ordered: boolean;
    contextEmpty: string;
  }>(`(() => {
    const question = document.querySelector('[data-testid="issues-draft-question"]');
    const activity = document.querySelector('[data-testid="issues-draft-activity"]');
    return {
      ordered: question !== null && activity !== null &&
        (question.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      contextEmpty: document.querySelector('[data-testid="issues-draft-context"]')?.textContent?.trim() ?? "",
    };
  })()`);
  check(
    questionLayout.ordered,
    "the pending question is not above the activity log",
    questionLayout,
  );
  check(
    questionLayout.contextEmpty === "No captured UI context.",
    "a draft without captured context does not say so",
    questionLayout,
  );
  await dismissNotifications();
  await saveShot("issues-draft-detail-question");
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024 && innerHeight === 720`, "the draft detail at 1024×720");
  const narrowDraft = await page.eval<{
    headerRight: number;
    actionsRight: number;
    pathWidth: number;
    bodyOverflow: number;
  }>(`(() => {
    const panel = document.querySelector('[data-testid="issues-draft-detail"]');
    const header = panel?.querySelector(".issues-draft-detail__header");
    const actions = panel?.querySelector(".issues-draft-detail__actions");
    const path = panel?.querySelector(".issues-draft-detail__path");
    const body = panel?.querySelector(".issues-draft-detail__body");
    return {
      headerRight: header?.getBoundingClientRect().right ?? 0,
      actionsRight: actions?.getBoundingClientRect().right ?? 0,
      pathWidth: path?.getBoundingClientRect().width ?? 0,
      bodyOverflow: body === null ? 0 : body.scrollWidth - body.clientWidth,
    };
  })()`);
  check(
    narrowDraft.pathWidth > 0 &&
      narrowDraft.actionsRight <= narrowDraft.headerRight + 0.5 &&
      narrowDraft.bodyOverflow <= 1,
    "the draft detail header or body overflows at 1024×720",
    narrowDraft,
  );
  await dismissNotifications();
  await saveShot("issues-draft-detail-1024x720");
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the desktop viewport after the draft check");

  // Another draft's run is not this draft's state.
  await page.click('[data-testid="issues-draft"][data-path=".devboard/goal-proposals/002-hang.md"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/002-hang.md"`,
    "the idle draft beside a running elaboration",
  );
  const otherState = await page.eval<string | null>(
    `document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() ?? null`,
  );
  check(otherState === null, "an idle draft still shows a run-state badge", otherState);
  await page.click('[data-testid="issues-draft"][data-path=".devboard/goal-proposals/001-question.md"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/001-question.md" &&
      document.querySelector('[data-testid="issues-draft-question"]') !== null`,
    "the running draft's question after reselecting it",
  );
  const runningState = await page.eval<string>(
    `document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() ?? ""`,
  );
  check(runningState === "running", "a running draft hides its run-state badge", runningState);

  const blocked = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="issues-draft-blocked"]')].map((item) => item.textContent ?? "")`,
  );
  check(
    blocked.length === 3 &&
      blocked.some((reason) => reason.includes("001-question.md")) &&
      blocked.some((reason) => reason === "This draft is being elaborated."),
    "another draft's start control has no stated reason",
    blocked,
  );
  await page.click('[data-testid="issues-draft-choice"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft"][data-path=".devboard/goal-proposals/001-question.md"]') === null`,
    "the elaborated draft to disappear",
    8_000,
  );
  check(
    existsSync(join(host, ".devboard", "goals", "001-question.md")),
    "the elaboration did not keep its finalized spec",
  );
  check(
    (await readFile(agentLog, "utf8")).includes("answer Alpha"),
    "the answer did not reach the elaboration peer",
  );

  // A hanging elaboration exposes Stop, keeps the draft, and re-enables start.
  await page.click('[data-testid="issues-draft"][data-path=".devboard/goal-proposals/002-hang.md"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/002-hang.md"`,
    "the hanging draft detail",
  );
  await page.click('[data-testid="issues-draft-start"]');
  await page.wait(`document.querySelector('[data-testid="issues-draft-stop"]') !== null`, "the stop control");
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent?.includes("Reading the draft")`,
    "the hanging activity",
    8_000,
  );
  await page.click('[data-testid="issues-draft-stop"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() === "stopped"`,
    "the stopped elaboration",
    8_000,
  );
  const afterStop = await page.eval<{ stop: boolean; startDisabled: boolean; present: boolean }>(`(() => ({
    stop: document.querySelector('[data-testid="issues-draft-stop"]') !== null,
    startDisabled: document.querySelector('[data-testid="issues-draft-start"]')?.disabled === false,
    present: document.querySelector('[data-testid="issues-draft"][data-path=".devboard/goal-proposals/002-hang.md"]') !== null,
  }))()`);
  check(!afterStop.stop && afterStop.startDisabled && afterStop.present, "Stop lost the draft or kept the peer", afterStop);

  // A report-panel write reaches the open Drafts page without a reload.
  await runPalette("app.report");
  await page.click('[data-testid="status-bar"]');
  await page.wait(`document.querySelector('.feedback-panel') !== null`, "the report panel for a second draft");
  await page.fill('.feedback-panel textarea', "Drafts should refresh without a reload.");
  await page.click('[data-testid="feedback-goal"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft"][data-path=".devboard/goal-proposals/drafts-should-refresh-without-a-reload.md"]') !== null`,
    "the draft written through POST to appear without a reload",
    8_000,
  );
  await page.key("Escape");
  const refreshedCount = await page.eval<string>(
    `document.querySelector('[data-testid="open-issues-drafts"] .sidebar-item__meta')?.textContent?.trim() ?? ""`,
  );
  check(refreshedCount === "3", "the Drafts count did not follow the new draft", refreshedCount);

  // Reload restores the drafts page and the selected path.
  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/002-hang.md"`,
    "the selected draft after reload",
    20_000,
  );

  // A vanished draft leaves the list and selection; a reload opens the list.
  await rm(draftDirectory, { recursive: true, force: true });
  await page.wait(
    `document.querySelector('[data-testid="issues-drafts-empty"]') !== null`,
    "the empty drafts state after the files vanished",
    8_000,
  );
  check(
    await page.eval<boolean>(`document.querySelector('[data-testid="issues-draft-detail"]') === null`),
    "a vanished draft kept its detail",
  );
  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="issues-drafts"]') !== null && document.querySelector('[data-testid="issues-drafts-empty"]') !== null`,
    "the empty drafts page after reload",
    20_000,
  );
  check(
    await page.eval<boolean>(`document.querySelector('[data-testid="issues-draft-detail"]') === null`),
    "a missing restored path opened a detail",
  );

  await page.click('[data-testid="open-issues-overview"]');
  await page.wait(`document.querySelector('[data-testid="issues-overview"]') !== null`, "the overview before the failed state");
  await seedIssuesState(stateDir, host, "failed");
  await page.wait(
    `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues failed"`,
    "the failed issues indicator",
    8_000,
  );
  const failed = await page.eval<{ indicator: string; error: string }>(`(() => ({
    indicator: document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() ?? "",
    error: document.querySelector('[data-testid="issues-error"]')?.textContent?.trim() ?? "",
  }))()`);
  check(failed.indicator === "issues failed", "the failed indicator is wrong", failed);
  check(failed.error.includes("the agent exited with code 1"), "the failure is not shown", failed);

  await clearIssuesState(stateDir, host);
  await page.wait(
    `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues stopped"`,
    "the stopped indicator after the state was removed",
    8_000,
  );

  // Leave a running state so the 1024×720 clipping check sees the item.
  await seedIssuesState(stateDir, host, "running");
  await page.wait(
    `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues working (3)"`,
    "the seeded issues indicator before the viewport check",
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
  await clearFeedback();
  await saveShot("notification-issue-file");
  const notificationFile = await page.eval<{
    present: boolean;
    label: string;
    text: string;
    disabled: boolean;
  }>(`(() => {
    const entry = [...document.querySelectorAll('[data-testid="notifications"] .notification')].find(
      (item) => item.textContent.includes("Not connected"),
    );
    const button = entry?.querySelector(".notification__file");
    return {
      present: button instanceof HTMLButtonElement,
      label: button?.getAttribute("aria-label") ?? "",
      text: button?.textContent?.trim() ?? "",
      disabled: button instanceof HTMLButtonElement ? button.disabled : true,
    };
  })()`);
  check(
    notificationFile.present &&
      notificationFile.label === "File an issue from this notification" &&
      notificationFile.text === "File issue" &&
      !notificationFile.disabled,
    "an error notification has no filing control",
    notificationFile,
  );
  const clickNotificationFile = (): Promise<unknown> =>
    page.eval(`(() => {
      const entry = [...document.querySelectorAll('[data-testid="notifications"] .notification')].find(
        (item) => item.textContent.includes("Not connected"),
      );
      entry?.querySelector(".notification__file")?.click();
    })()`);

  // A failed filing keeps the card and returns the button for a retry.
  await setFeedbackMode("fail");
  await clickNotificationFile();
  await page.wait(
    `[...document.querySelectorAll('[data-testid="notifications"] .notification')].some(
      (entry) =>
        entry.textContent.includes("Not connected") &&
        entry.querySelector(".notification__error")?.textContent?.includes("Issue creation failed") === true,
    )`,
    "the notification filing error",
    20_000,
  );
  const notificationFailure = await page.eval<{ text: string; retry: boolean }>(`(() => {
    const entry = [...document.querySelectorAll('[data-testid="notifications"] .notification')].find(
      (item) => item.textContent.includes("Not connected"),
    );
    const retry = entry?.querySelector(".notification__file");
    return {
      text: entry?.querySelector(".notification__error")?.textContent?.trim() ?? "",
      retry: retry instanceof HTMLButtonElement && !retry.disabled && retry.textContent?.trim() === "File issue",
    };
  })()`);
  check(
    notificationFailure.text.startsWith("Issue not filed: Issue creation failed") &&
      notificationFailure.retry,
    "a failed notification filing does not offer a retry",
    notificationFailure,
  );

  await setFeedbackMode("ok");
  await clickNotificationFile();
  await waitForFeedbackCalls(2);
  await page.wait(
    `[...document.querySelectorAll('[data-testid="notifications"] .notification')].some(
      (entry) => entry.textContent.includes("Not connected") && entry.querySelector(".notification__link") !== null,
    )`,
    "the notification issue link",
    20_000,
  );
  const notificationCall = (await feedbackCalls())[1]!;
  check(
    notificationCall.args.join(" ").includes("[ui] Error notification: ") &&
      notificationCall.args.join(" ").includes("Not connected"),
    "a notification issue has the wrong title",
    notificationCall.args,
  );
  check(
    notificationCall.body.startsWith("## Operator report") &&
      notificationCall.body.includes("Not connected") &&
      notificationCall.body.includes("### DOM excerpt") &&
      notificationCall.body.includes(`- Selected element: \`.notification[data-notification-id=`) &&
      notificationCall.body.includes("- Route: `/"),
    "a notification issue lost its text or captured context",
    notificationCall.body,
  );
  check(
    feedbackRequests.length === 2 &&
      feedbackRequests.every((request) => request.action === "report") &&
      String(feedbackRequests[1]?.report).startsWith("Error notification: ") &&
      String(feedbackRequests[1]?.report).includes("Raised at: "),
    "the notification filing request is wrong",
    feedbackRequests,
  );
  const notificationLink = await page.eval<{ text: string; href: string }>(`(() => {
    const entry = [...document.querySelectorAll('[data-testid="notifications"] .notification')].find(
      (item) => item.textContent.includes("Not connected"),
    );
    const link = entry?.querySelector(".notification__link");
    return {
      text: link?.textContent?.trim() ?? "",
      href: link?.getAttribute("href") ?? "",
    };
  })()`);
  await saveShot("notification-issue-filed");
  check(
    notificationLink.text === "Open issue" && notificationLink.href === stubIssueUrl,
    "the notification does not link to the filed issue",
    notificationLink,
  );
  await page.click('[data-testid="notification-indicator"]');
  await page.wait(`document.querySelector('[data-testid="notification-history"]') !== null`, "the notification history");
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="notification-history"]') === null`, "the history to close");
  const dismiss = await page.eval<boolean>(`(() => {
    const button = document.querySelector(
      '[data-testid="notifications"] .notification [aria-label="Dismiss notification"]',
    );
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
    "verify:interface: shell, modes, sidebar, pages, splits, palette, keyboard, theme, tables, editors, terminals, accessibility, notifications, status bar, issues mode, ask transcript, persistence, and boundary passed",
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
