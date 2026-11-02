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
import type { Server } from "bun";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { remoteCloneName } from "../server/discover";
import {
  drainMarkerPath,
  lockPath,
  runsDirectory,
  statePath as issueStatePath,
  versionedStatePath,
  workerStateDirectories,
} from "../issues/paths";
import { readState, type QueuedIssue } from "../issues/state";
import { versionLockPath } from "../issues/lock";
import { writeDrainMarker } from "../issues/control";
import { fixtureRecord, pendingRecord } from "../server/fixtures/adr-source";
import { journalKey } from "../server/journal";
import { saveSubscriptions } from "../server/providers";
import { REDESIGN_INSTRUCTION as redesignInstruction, REMOVAL_INSTRUCTION as removalInstruction } from "../server/feedback";
import { toolListPayload } from "../mcp/catalog";
import { recordToolInvocation } from "../mcp/invocations";
import { stateFile } from "../server/state";
import { statePath } from "../issues/scout/paths";
import { readHarnessVersion, runningHarnessDir } from "../server/version";
import {
  VERIFY_DASHBOARD_AUTHORIZATION,
  dashboardSocket,
  dashboardsFor,
  freePort,
  processRunning,
  run,
  waitFor,
} from "./verification";

const harnessRoot = resolve(import.meta.dir, "..");
const stubAgent = join(harnessRoot, "server", "fixtures", "stub-agent.ts");
// The source dashboard reports the commit-count version, not the unpacked
// manifest's placeholder.
const sourceVersion = readHarnessVersion(runningHarnessDir());
/** The version every seeded fixture worker records. */
const seedVersion = sourceVersion ?? "0.1.0";
/** The version the fixture installs, distinct from the source checkout's. */
const INSTALLED_VERSION = "9.9.9";
/** A newer install that makes the running replacement stale again. */
const NEXT_INSTALLED_VERSION = "9.9.10";
/** The older harness version a mixed-version takeover fixture keeps live. */
const MIXED_OLD_VERSION = "0.1.900";
const MIXED_OLD_RUN = "2026-10-27T10-10-01-000Z";
const MIXED_NEW_RUN = "2026-10-27T10-10-02-000Z";
// The deterministic `gh` stub always answers with this issue URL.
const stubIssueUrl = "https://gitea.example/dsdenes/devboard/issues/42";
// A tracker title longer than any supported line: it must truncate instead of
// widening a page or pushing a header's trailing controls outside the pane.
const longIssueTitle = "long".repeat(60);
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
  "5": [53, "Digit5"],
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

  async hover(selector: string, index = 0): Promise<void> {
    const point = await this.rect(selector, index);
    if (point === null) throw new Error(`verify:interface: cannot hover ${selector}[${index}]`);
    await this.devtools.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
    await delay(80);
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

/** Visible markers only: a hidden mode workspace is not the operator's surface. */
async function sourceOnlyMarkers(page: Page): Promise<number> {
  return page.eval<number>(`(() => {
    const badges = [...document.querySelectorAll('[data-testid="source-only-badge"]')];
    return badges.filter((badge) =>
      typeof badge.checkVisibility === "function"
        ? badge.checkVisibility()
        : badge.getBoundingClientRect().width > 0,
    ).length;
  })()`);
}

interface FlowGoalMeasure {
  goalHeight: number;
  pageHeight: number;
  goalWidth: number;
  pageWidth: number;
  minHeight: string;
  goalText: boolean;
  cancel: boolean;
  createActions: number;
  state: string;
  nextTop: number;
  viewportHeight: number;
  error: boolean;
  onboarding: {
    text: string;
    width: number;
    scrollWidth: number;
    clientWidth: number;
  } | null;
}

/** The Flow goal panel against its page: size, states, and onboarding card. */
async function measureFlowGoal(page: Page): Promise<FlowGoalMeasure> {
  return page.eval<FlowGoalMeasure>(`(() => {
    const goal = document.querySelector('#workspace-flow [data-testid="flow-goal"]');
    const overview = document.querySelector('#workspace-flow .flow-overview');
    const card = document.querySelector('[data-testid="flow-goal-onboarding"]');
    const next = document.querySelector('#workspace-flow [data-testid="flow-pr-section"]');
    const goalBox = goal?.getBoundingClientRect();
    const pageBox = overview?.getBoundingClientRect();
    const nextBox = next?.getBoundingClientRect();
    return {
      goalHeight: Math.round(goalBox?.height ?? -1),
      pageHeight: Math.round(pageBox?.height ?? -1),
      goalWidth: Math.round(goalBox?.width ?? -1),
      pageWidth: Math.round(pageBox?.width ?? -1),
      minHeight: goal === null ? "" : getComputedStyle(goal).minHeight,
      goalText: document.querySelector('[data-testid="flow-goal-text"]') !== null,
      cancel: document.querySelector('[data-testid="cancel-flow-goal"]') !== null,
      createActions: document.querySelectorAll('#workspace-flow [data-testid="create-flow-goal"]').length,
      state: document.querySelector('[data-testid="flow-goal-state"]')?.textContent?.trim() ?? "",
      nextTop: Math.round(nextBox?.top ?? -1),
      viewportHeight: innerHeight,
      error: document.querySelector('[data-testid="flow-error"]') !== null,
      onboarding: card === null
        ? null
        : {
            text: (card.textContent ?? "").replace(/\\s+/g, " ").trim(),
            width: Math.round(card.getBoundingClientRect().width),
            scrollWidth: card.scrollWidth,
            clientWidth: card.clientWidth,
          },
    };
  })()`);
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  const current = await page.eval<string>(`document.documentElement.dataset.theme`);
  if (current === theme) return;
  await page.click('[data-testid="theme-toggle"]');
  await page.wait(`document.documentElement.dataset.theme === "${theme}"`, `the ${theme} theme`);
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
    `${JSON.stringify({ name: "@dsdenes/devboard", version: INSTALLED_VERSION }, null, 2)}\n`,
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
  // delete control owns; the six Discover skills are managed by Discover.
  const prepareSkill = [
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
  ].join("\n");
  await mkdir(join(host, ".omp", "skills", "fixture-conventions"), { recursive: true });
  await writeFile(join(host, ".omp", "skills", "fixture-conventions", "SKILL.md"), prepareSkill);
  // The Devboard Skills page deletes this prepare-family skill in one click;
  // fixture-conventions stays for the Goal page's confirming delete.
  await mkdir(join(host, ".omp", "skills", "fixture-deletable"), { recursive: true });
  await writeFile(
    join(host, ".omp", "skills", "fixture-deletable", "SKILL.md"),
    prepareSkill
      .replaceAll("fixture-conventions", "fixture-deletable")
      .replace("Prefer the smallest observable change.", "Delete this prepared fixture skill."),
  );
  // A hand-authored skill and a symlinked skill are never deletable, and a
  // shipped built-in is rendered with its Managed marker.
  await mkdir(join(host, ".omp", "skills", "fixture-handwritten"), { recursive: true });
  await writeFile(
    join(host, ".omp", "skills", "fixture-handwritten", "SKILL.md"),
    "---\nname: fixture-handwritten\ndescription: The fixture developer's own policy.\n---\n\n# House style\n\n- Keep it.\n",
  );
  await symlink("fixture-conventions", join(host, ".omp", "skills", "fixture-linked"));
  for (const name of [
    "devboard-ui-ux",
    "devboard-restful-api-implementation",
    "devboard-single-responsibility-principle",
  ]) {
    await cp(join(harnessRoot, "omp", "skills", name), join(host, ".omp", "skills", name), {
      recursive: true,
    });
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
        verification: "not-run",
      },
    ],
    verification: {
      command: "bun test",
      status: "not-run",
      timestamp: now,
      output: "",
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
  await writeFile(join(sessionDir, "goal.md"), session.goal);
}

/**
 * The fixture forge's open issues: the seeded worker states' queue merged into
 * one list, with the `processing` label on each issue a seeded agent owns.
 * This is the one read the dashboard's Open issues page and counts use.
 */
function fixtureOpenIssues(
  stateDir: string,
  host: string,
): Array<Record<string, unknown>> {
  const root = resolve(host);
  const paths = [
    issueStatePath(stateDir, root),
    ...workerStateDirectories(stateDir, root).map((directory) => join(directory, "state.json")),
  ];
  const merged = new Map<number, { issue: QueuedIssue; labels: Set<string> }>();
  for (const path of paths) {
    const state = readState(path);
    if (state === undefined) continue;
    for (const issue of state.queue) {
      const labels = new Set(issue.labels ?? []);
      if (issue.agentRunId !== null) labels.add("processing");
      const entry = merged.get(issue.number);
      if (entry === undefined) {
        merged.set(issue.number, { issue, labels });
        continue;
      }
      for (const label of labels) entry.labels.add(label);
    }
  }
  return [...merged.values()]
    .sort((left, right) => left.issue.number - right.issue.number)
    .map(({ issue, labels }) => ({
      number: issue.number,
      title: issue.title,
      html_url: issue.url,
      created_at: issue.createdAt,
      state: "open",
      body: "",
      labels: [...labels].map((name) => ({ name })),
    }));
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
    question:
      answeredRunId === "*" || agent.runId === answeredRunId ? null : agent.question,
  }));
  const queue = running
    ? [
        ...["17", "18", "19"].map((value) => Number(value)).map((number) => ({
          number,
          title: number === 17 ? longIssueTitle : `Fixture issue ${number}`,
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
          harnessVersion: seedVersion,
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
        harnessVersion: seedVersion,
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
  // The lock proves ownership by matching this process's actual start time;
  // a fixed date would go stale as the calendar moves.
  const lockStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  await writeFile(
    join(lockDirectory, "lock"),
    JSON.stringify({
      pid: process.pid,
      startedAt: lockStartedAt,
      repo: resolve(host),
      stateDir,
      harnessVersion: seedVersion,
      argv: ["bun", join(harnessRoot, "issues", "worker.ts")],
    }),
  );
}

/**
 * Two live issues workers of different harness versions, exactly as a takeover
 * leaves them: the older one drained with its unit still running, the newer
 * one polling and working. The older document predates the pause source, so
 * only the dashboard's drain marker can tell its pause from an operator Pause.
 */
let mixedWorkerPids: number[] = [];

function fixtureProcessStartedAt(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const ticks = Number(stat.slice(close + 2).split(" ")[19]);
  const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  return new Date(Date.now() - uptime * 1000 + ticks * 10).toISOString();
}

async function liveFixtureProcess(): Promise<{ pid: number; startedAt: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", "setTimeout(() => undefined, 600000)"],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      readFileSync(`/proc/${child.pid}/stat`, "utf8");
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("verify:interface: the fixture worker did not start");
      await Bun.sleep(20);
    }
  }
  mixedWorkerPids.push(child.pid);
  return { pid: child.pid, startedAt: fixtureProcessStartedAt(child.pid) };
}

async function seedMixedIssuesState(stateDir: string, host: string): Promise<void> {
  const root = resolve(host);
  const oldWorker = await liveFixtureProcess();
  const newWorker = await liveFixtureProcess();
  const runsDir = runsDirectory(stateDir, root);
  const now = new Date().toISOString();
  const queue = (issueNumber: number, runId: string) =>
    [17, 18, 20, 21].map((number) => ({
      number,
      title: `Fixture issue ${number}`,
      url: `https://github.com/fixture/host/issues/${number}`,
      createdAt: "2026-10-26T00:00:00Z",
      labels: [] as string[],
      handled: false,
      runId: null,
      agentRunId: number === issueNumber ? runId : null,
    }));
  const state = (options: {
    version: string;
    pid: number;
    startedAt: string;
    lifecycle: "running" | "pausing";
    paused: boolean;
    issueNumber: number;
    runId: string;
    lastPollAt: string;
    pauseSource?: "drain" | null;
  }) => ({
    version: 2,
    repo: "fixture/host",
    root,
    lifecycle: options.lifecycle,
    enabled: true,
    paused: options.paused,
    ...(options.pauseSource === undefined ? {} : { pauseSource: options.pauseSource }),
    worker: {
      pid: options.pid,
      startedAt: options.startedAt,
      stateDir,
      harnessVersion: options.version,
      argv: ["bun", join(harnessRoot, "issues", "worker.ts")],
    },
    poll: {
      intervalMs: 10_000,
      lastPollAt: options.lastPollAt,
      nextPollAt: new Date(Date.parse(options.lastPollAt) + 10_000).toISOString(),
      etag: null,
      notModified: false,
      rateLimitedUntil: null,
      error: null,
    },
    queue: queue(options.issueNumber, options.runId),
    runs: [
      {
        runId: options.runId,
        status: "running",
        startedAt: "2026-10-27T10:10:00.000Z",
        finishedAt: null,
        exitCode: null,
        issueNumbers: [options.issueNumber],
        activity: 2,
        firstStderrLine: null,
        harnessVersion: options.version,
        workerPid: options.pid,
      },
    ],
    agents: [
      {
        runId: options.runId,
        issueNumber: options.issueNumber,
        startedAt: "2026-10-27T10:10:00.000Z",
        question: null,
        acp: null,
      },
    ],
    cooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    updatedAt: now,
  });
  const publish = async (path: string, document: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`);
    await rename(temporary, path);
  };
  // The older worker's document predates the pause source on purpose.
  await publish(
    versionedStatePath(stateDir, root, MIXED_OLD_VERSION),
    state({
      version: MIXED_OLD_VERSION,
      pid: oldWorker.pid,
      startedAt: oldWorker.startedAt,
      lifecycle: "pausing",
      paused: true,
      issueNumber: 17,
      runId: MIXED_OLD_RUN,
      lastPollAt: "2026-10-27T10:09:00.000Z",
    }),
  );
  await publish(
    versionedStatePath(stateDir, root, seedVersion),
    state({
      version: seedVersion,
      pid: newWorker.pid,
      startedAt: newWorker.startedAt,
      lifecycle: "running",
      paused: false,
      pauseSource: null,
      issueNumber: 18,
      runId: MIXED_NEW_RUN,
      lastPollAt: new Date(Date.now() - 1_000).toISOString(),
    }),
  );
  for (const [runId, issueNumber, version, workerPid] of [
    [MIXED_OLD_RUN, 17, MIXED_OLD_VERSION, oldWorker.pid],
    [MIXED_NEW_RUN, 18, seedVersion, newWorker.pid],
  ] as const) {
    const directory = join(runsDir, runId);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "run.json"),
      JSON.stringify({
        version: 1,
        runId,
        repo: "fixture/host",
        status: "running",
        argv: ["omp", "acp"],
        cwd: root,
        startedAt: "2026-10-27T10:10:00.000Z",
        finishedAt: null,
        exitCode: null,
        issues: [
          {
            number: issueNumber,
            title: `Fixture issue ${issueNumber}`,
            url: `https://github.com/fixture/host/issues/${issueNumber}`,
            createdAt: "2026-10-26T00:00:00Z",
            labels: [],
          },
        ],
        firstStderrLine: null,
        workerPid,
        harnessVersion: version,
      }),
    );
    await writeFile(
      join(directory, "activity.json"),
      JSON.stringify([`Reading issue ${issueNumber}`, `Implementing issue ${issueNumber}`]),
    );
  }
  // The dashboard wrote this before sending the drain, so the merge reports the
  // family's running work while the older worker's own state says `pausing`.
  writeDrainMarker(drainMarkerPath(stateDir, root, MIXED_OLD_VERSION), {
    version: MIXED_OLD_VERSION,
    pid: oldWorker.pid,
    by: seedVersion,
    at: now,
  });
  for (const worker of [
    { version: MIXED_OLD_VERSION, ...oldWorker },
    { version: seedVersion, ...newWorker },
  ]) {
    const path = versionLockPath(lockPath(root), worker.version);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        pid: worker.pid,
        startedAt: worker.startedAt,
        repo: root,
        stateDir,
        harnessVersion: worker.version,
        argv: ["bun", join(harnessRoot, "issues", "worker.ts")],
      }),
    );
  }
}

/** Ends the mixed-version fixture: every worker, lock, and its records. */
async function clearMixedIssuesState(stateDir: string, host: string): Promise<void> {
  for (const pid of mixedWorkerPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  mixedWorkerPids = [];
  await rm(join(stateDir, "issues", journalKey(host)), { recursive: true, force: true });
  await rm(join(resolve(host), ".devboard", ".tmp", "issues"), { recursive: true, force: true });
}

async function clearIssuesState(stateDir: string, host: string): Promise<void> {
  await rm(join(stateDir, "issues", journalKey(host)), { recursive: true, force: true });
  await rm(join(host, ".devboard", ".tmp", "issues", "lock"), { force: true });
}

/**
 * Deterministic drafts for the parallel phase: a question draft that keeps
 * running after its answer, three hanging drafts, and one failing draft.
 */
async function seedGoalDrafts(host: string): Promise<string> {
  const directory = join(host, ".devboard", "goal-proposals");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "001-question.md"),
    "# Question draft\n\n> Unprocessed draft. STUB-QUESTION STUB-HANG\n\nAsk about the scope before finalizing, then keep running.\n",
  );
  await writeFile(
    join(directory, "002-hang.md"),
    "# Hang draft\n\n> Unprocessed draft. STUB-HANG\n\nKeep this elaboration running until it is stopped.\n",
  );
  await writeFile(
    join(directory, "003-hang.md"),
    "# Third hang draft\n\n> Unprocessed draft. STUB-HANG\n\nKeep this elaboration running until it is stopped.\n",
  );
  await writeFile(
    join(directory, "004-hang.md"),
    "# Fourth hang draft\n\n> Unprocessed draft. STUB-HANG\n\nKeep this elaboration running until it is stopped.\n",
  );
  await writeFile(
    join(directory, "005-fail.md"),
    "# Failing draft\n\n> Unprocessed draft. STUB-FAIL\n\nFail the label verification.\n",
  );
  return directory;
}

/** The package a host prefix holds, under the public package name. */
function installedPackageHome(host: string): string {
  return join(host, ".devboard", "node_modules", "@dsdenes", "devboard");
}

/** Rewrites the installed manifest, as an automatic update would. */
async function writeInstalledVersion(host: string, version: string): Promise<void> {
  await writeFile(
    join(installedPackageHome(host), "package.json"),
    `${JSON.stringify({ name: "@dsdenes/devboard", version, type: "module" }, null, 2)}\n`,
  );
}

/**
 * A complete harness copy under the fixture host's `.devboard`, shaped like an
 * npm prefix package whose version differs from the running source, so the
 * reload control starts a replacement from it.
 */
async function installHarnessCopy(host: string, version = INSTALLED_VERSION): Promise<string> {
  const prefix = join(host, ".devboard");
  const home = installedPackageHome(host);
  await rm(join(prefix, "node_modules"), { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  for (const entry of [
    "server",
    "issues",
    "lib",
    "watchdog",
    "coach",
    "mcp",
    "release-train",
    "dist",
  ]) {
    await cp(join(harnessRoot, entry), join(home, entry), {
      recursive: true,
      filter: (source) => !source.endsWith(".test.ts"),
    });
  }
  await writeInstalledVersion(host, version);
  // The copied server resolves its runtime dependencies through the source
  // checkout's installed packages; nothing is published or fetched.
  await symlink(join(harnessRoot, "node_modules"), join(home, "node_modules"));
  return home;
}

async function removeHarnessCopy(host: string): Promise<void> {
  await rm(join(host, ".devboard", "node_modules"), { recursive: true, force: true });
}

async function agentLogLines(log: string): Promise<string[]> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** The detached elaboration owners this checkout currently runs. */
function goalDraftOwnerPids(host: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number(entry);
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (!argv.some((argument) => argument.endsWith("goal-draft-owner.ts"))) continue;
    if (!argv.includes(host)) continue;
    found.push(pid);
  }
  return found;
}

/** Stops every dashboard serving this fixture host, including a replacement. */
async function stopHostDashboards(host: string): Promise<void> {
  for (const entry of dashboardsFor(host)) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await waitFor(
    () => (dashboardsFor(host).length === 0 ? true : undefined),
    "the fixture dashboards to stop",
    15_000,
  );
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
  const socket = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
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
  const directory = join(stateDir, "discover-remote", remoteCloneName(owner, repo));
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

/**
 * Stages a retained project's external boundaries. The crawl's own sheet
 * records the systems the card bands, so one retained copy carries the observed
 * empty list the card renders as its own line.
 */
async function stageRetainedBoundaries(directory: string, systems: string[]): Promise<void> {
  const path = join(directory, ".omp", "discover", "sheet.json");
  const sheet = JSON.parse(await readFile(path, "utf8")) as {
    architecture?: { externalBoundaries?: { value?: unknown } };
  };
  const leaf = sheet.architecture?.externalBoundaries;
  check(
    typeof leaf === "object" && leaf !== null,
    "the retained sheet carries no external boundaries leaf",
    path,
  );
  leaf.value = systems;
  await writeFile(path, `${JSON.stringify(sheet, null, 2)}\n`);
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

/** Writes one parked Goal lane into the stopped dashboard's durable state. */
async function seedLane(stateDir: string, host: string): Promise<void> {
  const path = stateFile(stateDir, resolve(host));
  const envelope = JSON.parse(await readFile(path, "utf8")) as {
    state?: Record<string, unknown>;
  };
  check(
    typeof envelope.state === "object" && envelope.state !== null,
    "the dashboard state file is missing before seeding a lane",
    path,
  );
  envelope.state.laneSequence = 1;
  envelope.state.lanes = [
    {
      id: "lane-1",
      kind: "implementation",
      epic: { number: 77, title: "Restored lane", url: "https://forge.test/acme/fixture/issues/77" },
      record: null,
      attempt: 1,
      status: "parked",
      activity: ["Working on epic 77", "Lane parked"],
      question: null,
      blocked: false,
      failure: null,
      retainUntil: null,
    },
  ];
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

/** One recorded call of the deterministic Gitea API stub. */
interface FeedbackCall {
  url: string;
  title: string;
  body: string;
}

const PROVIDER_GO_KEY = "sk-go-verify-interface-0000abcd";
const PROVIDER_GO_EDGE_KEY = "sk-go-verify-interface-edge-1111cafe";
const PROVIDER_OR_KEY = "sk-or-verify-interface-0000beef";
const PROVIDER_OR_SECOND_KEY = "sk-or-verify-interface-second-2222f00d";
const PROVIDER_INVALID_KEY = "sk-verify-interface-invalid-3333dead";
/** Refused slowly, so another client's state frame lands during the save. */
const PROVIDER_SLOW_INVALID_KEY = "sk-verify-interface-slow-invalid-4444f00d";

const providerBehaviors = new Map<
  string,
  {
    status?: number;
    delayMs?: number;
    go?: number[];
    or?: { limit: number | null; remaining: number };
  }
>();
providerBehaviors.set(PROVIDER_GO_KEY, { go: [10, 20, 30] });
providerBehaviors.set(PROVIDER_GO_EDGE_KEY, { go: [99, 99, 99] });
providerBehaviors.set(PROVIDER_OR_KEY, { or: { limit: 100, remaining: 40 } });
providerBehaviors.set(PROVIDER_OR_SECOND_KEY, { or: { limit: 100, remaining: 0 } });
providerBehaviors.set(PROVIDER_INVALID_KEY, { status: 401 });
providerBehaviors.set(PROVIDER_SLOW_INVALID_KEY, { status: 401, delayMs: 400 });

const runId = `verify-interface-${Date.now()}`;
const root = join(harnessRoot, ".tmp", runId);
/** Waits on the server's own snapshot until no Discover run is active. */
async function waitDiscoverIdle(port: number, timeoutMs = 120_000): Promise<void> {
  const socket = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((settle, reject) => {
    socket.onopen = () => settle();
    socket.onerror = () => reject(new Error("verify:interface: discover idle socket failed"));
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const state = await new Promise<Record<string, unknown> | null>((settle) => {
        const guard = setTimeout(() => settle(null), 5_000);
        socket.onmessage = (event) => {
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(String(event.data)) as Record<string, unknown>;
          } catch {
            return;
          }
          if (message.type !== "discoverState") return;
          clearTimeout(guard);
          settle(message.state as Record<string, unknown>);
        };
        socket.send(JSON.stringify({ type: "getDiscover" }));
      });
      if (state !== null && state.active !== true) return;
      await Bun.sleep(250);
    }
    throw new Error("verify:interface: the Discover run did not become idle");
  } finally {
    socket.close();
  }
}

let serverProcess: ReturnType<typeof spawn> | undefined;
let fixtureHost: string | undefined;
/** The second fixture the sidebar run-state phase drives. */
let extraServerProcess: ReturnType<typeof spawn> | undefined;
let extraFixtureHost: string | undefined;
let feedbackApi: ReturnType<typeof Bun.serve> | undefined;
let gateOffProcess: ReturnType<typeof spawn> | undefined;
let feedbackOffProcess: ReturnType<typeof spawn> | undefined;
let chromeProcess: ReturnType<typeof spawn> | undefined;
let providerUsage: Server<unknown> | undefined;

try {
  const build = run("bun", ["run", "build"], { cwd: harnessRoot });
  check(build.code === 0, "the client build failed", build.stderr);

  await mkdir(root, { recursive: true });
  await mkdir(join(harnessRoot, ".tmp", "interface"), { recursive: true });
  // The update check reads a local release directory, so the stale control and
  // its replacement never depend on the npm registry being reachable.
  const releaseDir = join(root, "release");
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, `devboard-${INSTALLED_VERSION}.tgz`), "fixture release\n");
  await writeFile(
    join(releaseDir, `devboard-${INSTALLED_VERSION}.tgz.sha256`),
    `${"0".repeat(64)}\n`,
  );
  const host = await writeFixture(root);
  fixtureHost = host;
  // Discover's remote scratch root must resolve inside REPO_DIR; the harness
  // state stays under the excluded `.devboard/` tree.
  const stateDir = join(host, ".devboard", ".tmp", "state");
  await mkdir(stateDir, { recursive: true });
  // Two tools carry recorded calls so the page renders both a plural and a
  // singular label, and every other catalog tool renders zero.
  const expectedInvocations: Record<string, number> = {
    journal_search: 2,
    devboard_status: 1,
  };
  for (const [name, count] of Object.entries(expectedInvocations)) {
    for (let call = 0; call < count; call += 1) recordToolInvocation(stateDir, host, name);
  }
  const providerStamp = new Date().toISOString();
  saveSubscriptions(stateDir, [
    {
      id: "verify-go",
      provider: "opencode-go",
      label: "Primary Go",
      key: PROVIDER_GO_KEY,
      enabled: true,
      createdAt: providerStamp,
      updatedAt: providerStamp,
    },
    {
      id: "verify-go-edge",
      provider: "opencode-go",
      label: "Near-limit Go",
      key: PROVIDER_GO_EDGE_KEY,
      enabled: true,
      createdAt: providerStamp,
      updatedAt: providerStamp,
    },
    {
      id: "verify-openrouter",
      provider: "openrouter",
      label: "Fallback",
      key: PROVIDER_OR_KEY,
      enabled: true,
      createdAt: providerStamp,
      updatedAt: providerStamp,
    },
  ]);
  providerUsage = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const behavior = providerBehaviors.get(token);
      if (behavior?.delayMs !== undefined) await Bun.sleep(behavior.delayMs);
      if (behavior?.status !== undefined) {
        return new Response(JSON.stringify({ error: { message: "rejected" } }), {
          status: behavior.status,
        });
      }
      if (url.pathname === "/zen/go/v1/usage" && behavior?.go !== undefined) {
        const [rolling, weekly, monthly] = behavior.go;
        return Response.json({
          usage: {
            rolling: { percent: rolling, status: "ok", resetsAt: "2030-01-01T00:00:00Z" },
            weekly: { percent: weekly, status: "ok", resetsAt: "2030-01-07T00:00:00Z" },
            monthly: { percent: monthly, status: "ok", resetsAt: "2030-02-01T00:00:00Z" },
          },
        });
      }
      if (url.pathname === "/api/v1/key" && behavior?.or !== undefined) {
        return Response.json({
          data: { limit: behavior.or.limit, limit_remaining: behavior.or.remaining },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const agentLog = join(root, "agent.log");
  const flowGoalGate = join(root, "flow-goal-hang");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const serverLog = join(root, "server.log");
  const logHandle = Bun.file(serverLog);
  const logWriter = logHandle.writer();

  const feedbackCalls: FeedbackCall[] = [];
  let feedbackMode = "ok";
  const feedbackServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      // The dashboard's own Issues read, served from the seeded worker states.
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/repos/fixture/host/issues"
      ) {
        return Response.json(fixtureOpenIssues(stateDir, host));
      }
      if (
        request.method !== "POST" ||
        !/^\/api\/v1\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname)
      ) {
        return new Response("not found", { status: 404 });
      }
      const payload = (await request.json().catch(() => ({}))) as {
        title?: unknown;
        body?: unknown;
      };
      const record = {
        url: request.url,
        title: typeof payload.title === "string" ? payload.title : "",
        body: typeof payload.body === "string" ? payload.body : "",
      };
      feedbackCalls.push(record);
      if (feedbackMode === "fail") {
        return Response.json({ message: "boom" }, { status: 500 });
      }
      if (feedbackMode === "delay") await delay(500);
      return Response.json({
        number: feedbackCalls.length + 41,
        title: record.title,
        html_url: stubIssueUrl,
        state: "open",
      });
    },
  });
  feedbackApi = feedbackServer;
  // The host's origin names the fixture forge, so the dashboard's Issues read
  // resolves to the stub instead of an unconfigured GitHub repository.
  await git(host, [
    "remote",
    "add",
    "origin",
    `http://127.0.0.1:${feedbackServer.port}/fixture/host.git`,
  ]);
  const serverEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    ADRS_DIR: join(host, "adrs"),
    REPO_DIR: host,
    GOAL_FILE: join(host, "GOAL.md"),
    STATIC_DIR: join(harnessRoot, "dist"),
    STATE_DIR: stateDir,
    AGENT_COMMAND: `bun ${stubAgent} --log=${agentLog} --discover --discover-delay-ms=1500 --discover-versioned-names --ask --ask-delay-ms=600 --goal-draft --flow-goal --flow-goal-hang=${flowGoalGate}`,
    // Harness-owned reporting goes through the local Gitea API stub, never
    // through `gh`, and the recorded requests stay under `.tmp`.
    DEVBOARD_GITEA_URL: `http://127.0.0.1:${feedbackServer.port}`,
    GITEA_TOKEN: "verify-token",
    DEVBOARD_RELEASE_REPO: "dsdenes/devboard",
    DEVBOARD_RELEASE_DIR: releaseDir,
    DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
    // The Issues queue follows the dashboard's own forge read; a one-second
    // cadence keeps the fixture's seeded changes visible without a 30-second wait.
    DEVBOARD_ISSUES_SYNC_INTERVAL_MS: "1000",
    DEVBOARD_OPENCODE_GO_USAGE_BASE_URL: `http://127.0.0.1:${providerUsage.port}/zen/go`,
    DEVBOARD_OPENROUTER_USAGE_BASE_URL: `http://127.0.0.1:${providerUsage.port}/api`,
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
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
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
  // The reload control's page retries the root while the replacement binds;
  // those refusals are the handoff working, not a broken asset.
  let expectedReloadFailures = false;
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
      request.url.endsWith("/feedback")
    ) {
      feedbackPosts.push(request.url);
    }
    if (typeof requestId === "string" && typeof request?.url === "string") {
      requestUrls.set(requestId, request.url);
    }
    if (
      request?.method === "POST" &&
      (request.url ?? "").endsWith("/feedback") &&
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
      (request.url ?? "").endsWith("/goal-proposals") &&
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
    if (expectedReloadFailures && String(params.errorText ?? "").includes("ERR_CONNECTION_REFUSED")) {
      return;
    }
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
      if (url.endsWith("/feedback")) return;
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

  // The deterministic feedback store: the in-process Gitea stub records every
  // filing, and a mode variable switches its answer between calls.
  const clearFeedback = async (): Promise<void> => {
    feedbackCalls.length = 0;
    feedbackRequests.length = 0;
  };
  const setFeedbackMode = async (mode: string): Promise<void> => {
    feedbackMode = mode;
  };
  const waitForFeedbackCalls = async (count: number): Promise<void> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (feedbackCalls.length >= count) return;
      if (Date.now() > deadline) {
        throw new Error(
          `verify:interface: the feedback stub recorded ${feedbackCalls.length} of ${count} calls`,
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
    backgrounds: string[];
    marker: boolean[];
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
        backgrounds: buttons.map((button) => getComputedStyle(button).backgroundColor),
        marker: buttons.map(
          (button) => getComputedStyle(button, "::before").content !== "none",
        ),
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
  check((await sourceOnlyMarkers(page)) === 0, "the Goal surface renders a source-only marker");

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
  check(activity.count === 5, "the activity bar does not present exactly five modes", activity);
  const brand = await page.eval<string>(`document.querySelector('[data-testid="activity-bar"]')?.textContent?.replace(/\\s+/g, "") ?? ""`);
  check(brand === "GoalIssuesFlowDiscoverDevboard", "the activity bar does not name its five modes", brand);
  const expectedModes = [
    ["mode-goal", "true", "Goal"],
    ["mode-issues", "false", "Issues"],
    ["mode-flow", "false", "Flow"],
    ["mode-discover", "false", "Discover"],
    ["mode-devboard", "false", "Devboard"],
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
    railLabels.length === 5 && railLabels.every((label) => label.overflow <= 1 && label.inside),
    "a mode label overflows or leaves its tab",
    railLabels,
  );
  check(
    railLabels.every((label) => label.height === 52 && label.width === 64),
    "a mode tab does not keep its padded 64×52 box",
    railLabels,
  );

  // 3. Status bar, reload control, and shortcut discoverability.
  await page.wait(
    `document.querySelector('[data-testid="status-project"]')?.textContent?.trim() === "host"`,
    "the status bar project label",
  );
  await page.wait(
    `document.querySelector('[data-testid="reload-devboard"]') !== null`,
    "the stale reload control",
    20_000,
  );
  const statusBar = await page.eval<{
    connection: string;
    project: string;
    projectTitle: string;
    projectIcon: boolean;
    barRight: number;
    metricsRight: number;
    work: string;
    mode: boolean;
    versions: string;
    reload: {
      label: string;
      title: string;
      text: string;
      fontSize: number;
      height: number;
      top: number;
      bottom: number;
    } | null;
    itemHeights: number[];
    barTop: number;
    barBottom: number;
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
      metricsRight: Math.round(
        document.querySelector('[data-testid="status-bar"] .status-group--metrics')
          ?.getBoundingClientRect().right ?? -1,
      ),
      work: text('[data-testid="status-bar"] .status-item[title="Running lanes and open epics"]'),
      mode: document.querySelector('[data-testid="status-mode"]') !== null,
      versions: text('[data-testid="status-bar"] .status-versions'),
      reload: (() => {
        if (reload === null) return null;
        const label = reload.querySelector("span");
        const rect = reload.getBoundingClientRect();
        return {
          label: reload.getAttribute("aria-label") ?? "",
          title: reload.getAttribute("title") ?? "",
          text: reload.textContent?.replace(/\\s+/g, " ").trim() ?? "",
          fontSize: label === null ? 0 : parseFloat(getComputedStyle(label).fontSize),
          height: Math.round(rect.height),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        };
      })(),
      itemHeights: [...document.querySelectorAll('[data-testid="status-bar"] .status-item')].map(
        (item) => Math.round(item.getBoundingClientRect().height),
      ),
      barTop: Math.round(bar?.getBoundingClientRect().top ?? -1),
      barBottom: Math.round(bar?.getBoundingClientRect().bottom ?? -1),
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
    statusBar.barRight - statusBar.metricsRight <= 48,
    "the status bar leaves an empty tail after its right group",
    statusBar,
  );
  check(
    statusBar.versions.includes("running") && statusBar.versions.includes("source"),
    "the status bar does not show the running version and the source version",
    statusBar,
  );
  check(
    sourceVersion !== null &&
      statusBar.versions.includes(`running ${sourceVersion}`) &&
      statusBar.versions.includes(`source ${INSTALLED_VERSION}`),
    "the source status bar does not read running <served> and source <source>",
    { sourceVersion, installed: INSTALLED_VERSION, versions: statusBar.versions },
  );
  check(statusBar.reload !== null, "the stale reload control is missing");
  check(
    sourceVersion !== null &&
      statusBar.reload!.label.includes(sourceVersion) &&
      statusBar.reload!.label.includes(INSTALLED_VERSION),
    "the reload label does not name both versions",
    { sourceVersion, reload: statusBar.reload },
  );
  check(
    sourceVersion !== null &&
      statusBar.reload!.title.includes(sourceVersion) &&
      statusBar.reload!.title.includes(INSTALLED_VERSION),
    "the reload title does not name both versions",
    { sourceVersion, reload: statusBar.reload },
  );
  check(
    statusBar.reload !== null &&
      statusBar.reload.text === "reload" &&
      statusBar.reload.fontSize === 11 &&
      statusBar.reload.height <= 20 &&
      statusBar.reload.top >= statusBar.barTop &&
      statusBar.reload.bottom <= statusBar.barBottom,
    "the reload control is not a 20px status item with an 11px label",
    statusBar,
  );
  check(
    statusBar.itemHeights.every((height) => height <= 20),
    "a status-bar control is taller than 20px",
    statusBar,
  );
  check(
    statusBar.groups === 2 && statusBar.divider && statusBar.barHeight === 26,
    "the status bar is not two grouped regions in its 26px bar",
    statusBar,
  );
  check(
    statusBar.labels.includes("lanes") &&
      statusBar.labels.filter((label) => label === "running").length === 1 &&
      statusBar.labels.filter((label) => label === "source").length === 1,
    "a status metric does not state its meaning",
    statusBar,
  );
  check(statusBar.issuesDot.length > 0, "the issues indicator has no state dot", statusBar);
  check(statusBar.themeLabel.length > 0 && statusBar.notificationLabel.includes("Notifications"), "a status-bar icon lacks a name", statusBar);
  const sidebarToggle = await page.eval<boolean>(`document.querySelector('[data-testid="sidebar-toggle"]') !== null`);
  check(!sidebarToggle, "the sidebar still renders a hide control");
  check((await sourceOnlyMarkers(page)) === 0, "the status bar or reload control renders a source-only marker");

  // 4b. Providers: dialog, exactly two providers, masked keys,
  // usage rows, validation, edit, enable, delete, refresh, palette entry,
  // and focus trapping.
  const statusLeft = await page.eval<{ items: string[]; indicator: string; title: string }>(`(() => {
    const group = document.querySelectorAll('[data-testid="status-bar"] .status-group')[0];
    const indicator = document.querySelector('[data-testid="providers-indicator"]');
    return {
      items: group === undefined ? [] : [...group.querySelectorAll(".status-item")].map((item) => item.textContent?.replace(/\\s+/g, " ").trim() ?? ""),
      indicator: indicator?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      title: indicator?.getAttribute("title") ?? "",
    };
  })()`);
  check(
    statusLeft.items.length === 3 &&
      statusLeft.items[0]?.includes("Connected") &&
      statusLeft.items[1]?.includes("host") &&
      statusLeft.items[2]?.includes("OpenCode Go"),
    "the status bar left group does not hold the connection, the project, and the provider",
    statusLeft,
  );
  check(
    statusLeft.indicator.includes("OpenCode Go") && statusLeft.indicator.includes("70%"),
    "the provider indicator does not show the selection and lowest remaining percentage",
    statusLeft,
  );
  check(
    statusLeft.title.includes("opencode-go/deepseek-v4.1-flash") &&
      statusLeft.title.includes("70%"),
    "the provider indicator tooltip does not name the selected model and headroom",
    statusLeft,
  );

  await page.click('[data-testid="providers-indicator"]');
  await page.wait(
    `document.querySelector('[data-testid="providers-dialog"]') !== null`,
    "the providers dialog",
  );
  await page.wait(
    `document.activeElement?.closest('[data-testid="providers-dialog"]') !== null`,
    "the providers dialog to take focus",
    2_000,
  );
  const providers = await page.eval<{
    options: Array<{ value: string; label: string }>;
    rule: string;
    model: string;
    rowModels: string[];
    rows: number;
    masks: string[];
    statuses: string[];
    windows: string[];
    checked: string[];
    text: string;
    html: string;
    focusInside: boolean;
  }>(`(() => {
    const dialog = document.querySelector('[data-testid="providers-dialog"]');
    const select = document.querySelector('[data-testid="provider-select"]');
    return {
      options: select === null ? [] : [...select.options].map((option) => ({ value: option.value, label: option.textContent?.trim() ?? "" })),
      rule: document.querySelector('[data-testid="provider-rule"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      model: document.querySelector('[data-testid="provider-model"]')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      rowModels: [...document.querySelectorAll('[data-testid="provider-row-model"]')].map((node) => node.textContent?.trim() ?? ""),
      rows: document.querySelectorAll('[data-testid="provider-row"]').length,
      masks: [...document.querySelectorAll('[data-testid="provider-mask"]')].map((node) => node.textContent?.trim() ?? ""),
      statuses: [...document.querySelectorAll('[data-testid="provider-status"]')].map((node) => node.textContent?.trim() ?? ""),
      windows: [...document.querySelectorAll('[data-testid="provider-window"]')].map((node) => node.textContent?.replace(/\\s+/g, " ").trim() ?? ""),
      checked: [...document.querySelectorAll('[data-testid="provider-last-checked"]')].map((node) => node.textContent?.replace(/\\s+/g, " ").trim() ?? ""),
      text: dialog?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      html: document.body.innerHTML,
      focusInside: document.activeElement?.closest('[data-testid="providers-dialog"]') !== null,
    };
  })()`);
  check(
    providers.options.length === 2 &&
      providers.options[0]?.value === "opencode-go" &&
      providers.options[0]?.label === "OpenCode Go" &&
      providers.options[1]?.value === "openrouter" &&
      providers.options[1]?.label === "OpenRouter",
    "the provider control does not offer exactly OpenCode Go and OpenRouter",
    providers.options,
  );
  check(providers.rule.includes("rotates at 1% remaining"), "the dialog omits the 1% rule", providers.rule);
  check(
    providers.model.includes("opencode-go/deepseek-v4.1-flash"),
    "the provider control does not name the selected provider's model",
    providers.model,
  );
  check(
    providers.rowModels.length === 3 &&
      providers.rowModels.filter((model) => model === "opencode-go/deepseek-v4.1-flash").length === 2 &&
      providers.rowModels.includes("openrouter/deepseek/deepseek-v4.1-flash-1017"),
    "a provider row does not name its model",
    providers.rowModels,
  );
  check(providers.rows === 3, "the dialog does not list every saved subscription", providers.rows);
  check(
    providers.masks.some((mask) => mask.endsWith(PROVIDER_GO_KEY.slice(-4))) &&
      providers.masks.some((mask) => mask.endsWith(PROVIDER_OR_KEY.slice(-4))),
    "the dialog does not carry masked keys",
    providers.masks,
  );
  for (const key of [PROVIDER_GO_KEY, PROVIDER_GO_EDGE_KEY, PROVIDER_OR_KEY]) {
    check(!providers.text.includes(key) && !providers.html.includes(key), "a full key reached the DOM", key);
  }
  check(
    providers.statuses.includes("ok") && providers.statuses.includes("near limit"),
    "the dialog does not show per-key status",
    providers.statuses,
  );
  check(
    providers.windows.some((row) => row.includes("Rolling 5h")) &&
      providers.windows.some((row) => row.includes("Weekly")) &&
      providers.windows.some((row) => row.includes("Monthly")),
    "the dialog does not show per-window remaining",
    providers.windows,
  );
  check(
    providers.checked.every((value) => value.includes("checked") && !value.includes("never")),
    "the dialog does not show the last check time",
    providers.checked,
  );
  check(providers.focusInside, "the dialog does not take focus");
  await page.key("Tab");
  await page.key("Tab");
  const focusTrapped = await page.eval<boolean>(
    `document.activeElement?.closest('[data-testid="providers-dialog"]') !== null`,
  );
  check(focusTrapped, "the providers dialog does not trap focus");
  await saveShot("providers");

  // An invalid key is refused with a visible error.
  await page.fill('[data-testid="provider-key-input"]', PROVIDER_INVALID_KEY);
  await page.click('[data-testid="provider-save"]');
  await page.wait(
    `document.querySelector('[data-testid="provider-error"]')?.textContent?.includes("401") === true`,
    "the invalid-key error",
  );
  const errorPaint = await page.eval<{
    background: string;
    border: string;
    surface: string;
    error: string;
  }>(`(() => {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.background = "var(--error-surface)";
    probe.style.borderTop = "1px solid var(--error)";
    document.body.append(probe);
    const expected = getComputedStyle(probe);
    const band = document.querySelector('[data-testid="provider-error"]');
    const style = band === null ? null : getComputedStyle(band);
    const result = {
      background: style?.backgroundColor ?? "",
      border: style?.borderTopColor ?? "",
      surface: expected.backgroundColor,
      error: expected.borderTopColor,
    };
    probe.remove();
    return result;
  })()`);
  check(
    errorPaint.background === errorPaint.surface && errorPaint.border === errorPaint.error,
    "the provider error band does not pair the error surface with the error border",
    errorPaint,
  );

  // While the server validates a new key, another client's state frame answers
  // no save: it must not announce success or clear the typed key.
  await page.fill('[data-testid="provider-key-input"]', PROVIDER_SLOW_INVALID_KEY);
  await page.click('[data-testid="provider-save"]');
  await page.eval(`(async () => {
    const socket = new WebSocket("ws://" + location.host + "/ws");
    const { promise, resolve } = Promise.withResolvers();
    socket.onopen = () => socket.send(JSON.stringify({ type: "getProviders" }));
    socket.onmessage = (event) => {
      if (JSON.parse(event.data).type !== "providersState") return;
      socket.close();
      resolve(null);
    };
    await promise;
  })()`);
  const duringSave = await page.eval<{ feedback: string | null; key: string }>(`(() => ({
    feedback: document.querySelector('[data-testid="save-feedback"]')?.textContent?.trim() ?? null,
    key: document.querySelector('[data-testid="provider-key-input"]').value,
  }))()`);
  check(
    duringSave.feedback === null && duringSave.key === PROVIDER_SLOW_INVALID_KEY,
    "a state frame announced a provider save the server had not applied",
    duringSave,
  );
  await page.wait(
    `document.querySelector('[data-testid="provider-error"]')?.textContent?.includes("401") === true`,
    "the slow invalid-key error",
  );
  const refusedKey = await page.eval<string>(
    `document.querySelector('[data-testid="provider-key-input"]').value`,
  );
  check(
    refusedKey === PROVIDER_SLOW_INVALID_KEY,
    "a refused provider save discarded the typed key",
    refusedKey,
  );

  // Add a second OpenRouter key: exhausted usage is saved but displayed as such.
  await page.fill('[data-testid="provider-key-input"]', PROVIDER_OR_SECOND_KEY);
  await page.fill('[data-testid="provider-label-input"]', "Second fallback");
  await page.eval(`(() => {
    const select = document.querySelector('[data-testid="provider-select"]');
    select.value = "openrouter";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value;
  })()`);
  await page.click('[data-testid="provider-save"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="provider-row"]').length === 4`,
    "the added provider row",
  );
  const providerConfirmation = await page.eval<{
    scope: string;
    parent: string;
    position: string;
    insideDialog: boolean;
    text: string;
    frame: { top: number; right: number; bottom: number; left: number; leftColor: string; topColor: string };
  }>(`(() => {
    const node = document.querySelector('[data-testid="save-feedback"]');
    const style = node === null ? null : getComputedStyle(node);
    return {
      scope: node?.getAttribute("data-scope") ?? "",
      parent: node?.parentElement?.className ?? "",
      position: style?.position ?? "",
      insideDialog: node?.closest('[data-testid="providers-dialog"]') !== null,
      text: node?.textContent?.trim() ?? "",
      frame: {
        top: style === null ? 0 : parseFloat(style.borderTopWidth),
        right: style === null ? 0 : parseFloat(style.borderRightWidth),
        bottom: style === null ? 0 : parseFloat(style.borderBottomWidth),
        left: style === null ? 0 : parseFloat(style.borderLeftWidth),
        leftColor: style?.borderLeftColor ?? "",
        topColor: style?.borderTopColor ?? "",
      },
    };
  })()`);
  check(
    providerConfirmation.scope === "providers.form" &&
      providerConfirmation.parent.includes("providers-form-actions") &&
      providerConfirmation.position === "static" &&
      providerConfirmation.insideDialog &&
      providerConfirmation.text.includes("Provider saved."),
    "the provider save confirmation is not beside its Save control",
    providerConfirmation,
  );
  check(
    providerConfirmation.frame.top === 1 &&
      providerConfirmation.frame.right === 1 &&
      providerConfirmation.frame.bottom === 1 &&
      providerConfirmation.frame.left === 1 &&
      providerConfirmation.frame.leftColor === providerConfirmation.frame.topColor,
    "the save confirmation does not carry a uniform 1px frame",
    providerConfirmation.frame,
  );
  const added = await page.eval<{ statuses: string[]; text: string; inputs: string[]; html: string }>(`(() => ({
    statuses: [...document.querySelectorAll('[data-testid="provider-status"]')].map((node) => node.textContent?.trim() ?? ""),
    text: document.querySelector('[data-testid="providers-dialog"]')?.textContent ?? "",
    inputs: [...document.querySelectorAll('[data-testid="providers-dialog"] input')].map((input) => input.value),
    html: document.body.innerHTML,
  }))()`);
  check(added.statuses.includes("exhausted"), "an exhausted subscription has no status", added.statuses);
  const exhaustedPaint = await page.eval<{ color: string; error: string }>(`(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;color:var(--error)";
    document.body.append(probe);
    const error = getComputedStyle(probe).color;
    probe.remove();
    const row = [...document.querySelectorAll('[data-testid="provider-row"]')].find(
      (candidate) => candidate.querySelector('[data-testid="provider-status"]')?.textContent?.trim() === "exhausted",
    );
    const status = row?.querySelector('[data-testid="provider-status"]');
    return {
      color: status === null || status === undefined ? "" : getComputedStyle(status).color,
      error,
    };
  })()`);
  check(
    exhaustedPaint.color === exhaustedPaint.error,
    "the exhausted provider status does not use the error color",
    exhaustedPaint,
  );
  check(!added.text.includes(PROVIDER_OR_SECOND_KEY), "the added key is rendered in the dialog text");
  for (const key of [PROVIDER_GO_KEY, PROVIDER_OR_KEY, PROVIDER_OR_SECOND_KEY]) {
    check(!added.inputs.some((value) => value.includes(key)), "a key stayed in a form field", key);
    check(!added.html.includes(key), "a key stayed in the DOM", key);
  }

  // Editing a label changes only the label.
  await page.click('[data-testid="provider-edit"]', 0);
  await page.fill('[data-testid="provider-label-input"]', "Primary renamed");
  await page.click('[data-testid="provider-save"]');
  await page.wait(
    `[...document.querySelectorAll('[data-testid="provider-row"]')].some((row) => row.textContent?.includes("Primary renamed"))`,
    "the edited provider label",
  );

  // Enable/disable and refresh.
  await page.click('[data-testid="provider-enabled"]', 0);
  await page.wait(
    `document.querySelectorAll('[data-testid="provider-enabled"]')[0]?.checked === false`,
    "the disabled provider",
  );
  await page.click('[data-testid="provider-enabled"]', 0);
  await page.wait(
    `document.querySelectorAll('[data-testid="provider-enabled"]')[0]?.checked === true`,
    "the re-enabled provider",
  );
  await page.click('[data-testid="provider-refresh"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="provider-row"]').length === 4`,
    "the refreshed provider rows",
  );

  // Delete with confirmation.
  await page.click('[data-testid="provider-delete"]', 3);
  await page.wait(
    `document.querySelector('[data-testid="provider-delete-confirm"]') !== null`,
    "the delete confirmation",
  );
  const confirmPaint = await page.eval<{ background: string; destructive: string }>(`(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;background:var(--destructive)";
    document.body.append(probe);
    const destructive = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const button = document.querySelector('[data-testid="provider-delete-confirm"]');
    return {
      background: button === null ? "" : getComputedStyle(button).backgroundColor,
      destructive,
    };
  })()`);
  check(
    confirmPaint.background === confirmPaint.destructive,
    "the confirm delete button does not keep the destructive variant",
    confirmPaint,
  );
  await page.click('[data-testid="provider-delete-confirm"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="provider-row"]').length === 3`,
    "the deleted provider row",
  );
  const afterProviderDelete = await page.eval<{ masks: string[]; text: string }>(`(() => ({
    masks: [...document.querySelectorAll('[data-testid="provider-mask"]')].map((node) => node.textContent?.trim() ?? ""),
    text: document.querySelector('[data-testid="providers-dialog"]')?.textContent ?? "",
  }))()`);
  check(
    !afterProviderDelete.masks.some((mask) => mask.endsWith(PROVIDER_OR_SECOND_KEY.slice(-4))),
    "the deleted subscription is still listed",
    afterProviderDelete.masks,
  );

  // The palette reaches the same dialog.
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="providers-dialog"]') === null`, "the dialog to close");
  await page.key("k", 2);
  await page.wait(
    `document.querySelector('[data-testid="command-palette"]') !== null`,
    "the palette for Providers",
  );
  await page.fill('[data-testid="command-palette-input"]', "Providers");
  await page.wait(
    `[...document.querySelectorAll('[data-testid="command-item"]')].some((item) => item.getAttribute("data-command") === "settings.providers")`,
    "the Providers palette entry",
  );
  await page.key("Enter");
  await page.wait(
    `document.querySelector('[data-testid="providers-dialog"]') !== null`,
    "the palette-opened providers dialog",
  );
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="providers-dialog"]') === null`, "the palette dialog to close");
  const providerLeaks = await page.eval<string[]>(`(() => {
    const keys = ${JSON.stringify([
      PROVIDER_GO_KEY,
      PROVIDER_GO_EDGE_KEY,
      PROVIDER_OR_KEY,
      PROVIDER_OR_SECOND_KEY,
      PROVIDER_INVALID_KEY,
    ])};
    const found = keys.filter((key) => document.body.innerHTML.includes(key));
    for (const input of document.querySelectorAll("input")) {
      const value = input instanceof HTMLInputElement ? input.value : "";
      for (const key of keys) if (value.includes(key)) found.push(key);
    }
    return found;
  })()`);
  check(providerLeaks.length === 0, "a full key remains in the rendered DOM", providerLeaks);

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
    search: { height: number; fontSize: number; className: string };
    shortcutType: {
      fontSize: number;
      fontWeight: string;
      lineHeight: number;
      fontFamily: string;
    } | null;
    reasonType: {
      fontSize: number;
      fontWeight: string;
      lineHeight: number;
      letterSpacing: string;
    } | null;
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
    const search = document.querySelector('[data-testid="command-palette-input"]');
    const searchStyle = search === null ? null : getComputedStyle(search);
    const shortcut = document.querySelector(".palette__shortcut");
    const shortcutStyle = shortcut === null ? null : getComputedStyle(shortcut);
    const reason = document.querySelector(".palette__item-reason");
    const reasonStyle = reason === null ? null : getComputedStyle(reason);
    return {
      items,
      input: search !== null,
      focus: document.activeElement?.getAttribute("data-testid") ?? "",
      search: {
        height: searchStyle === null ? 0 : search.getBoundingClientRect().height,
        fontSize: searchStyle === null ? 0 : Number.parseFloat(searchStyle.fontSize),
        className: search?.className ?? "",
      },
      shortcutType: shortcutStyle === null ? null : {
        fontSize: Number.parseFloat(shortcutStyle.fontSize),
        fontWeight: shortcutStyle.fontWeight,
        lineHeight: Number.parseFloat(shortcutStyle.lineHeight),
        fontFamily: shortcutStyle.fontFamily,
      },
      reasonType: reasonStyle === null ? null : {
        fontSize: Number.parseFloat(reasonStyle.fontSize),
        fontWeight: reasonStyle.fontWeight,
        lineHeight: Number.parseFloat(reasonStyle.lineHeight),
        letterSpacing: reasonStyle.letterSpacing,
      },
    };
  })()`);
  check(palette.input && palette.focus === "command-palette-input", "the palette input is not focused", palette);
  check(
    palette.search.height === 28 && palette.search.fontSize === 12,
    "the palette search field does not use the 28px input at 12px control type",
    palette.search,
  );
  check(
    !palette.search.className.includes("h-8") && !palette.search.className.includes("text-[13px]"),
    "the palette search field still carries the superseded size classes",
    palette.search.className,
  );
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
    "view.mode.devboard", "devboard.tab.tools", "devboard.tab.skills",
    "issues.start", "issues.pause", "issues.resume", "issues.stop", "issues.check",
    "open.issues.overview", "open.issues.agents", "open.issues.issues", "open.issues.runs",
    "open.issues.drafts",
    "view.theme.toggle", "view.layout.reset",
    "app.reload", "app.report", "app.notifications.open",
    "goal.create", "goal.revise", "goal.skills.prepare",
    "goal.adr.start-next", "goal.lifecycle.start", "goal.lifecycle.pause",
    "goal.lifecycle.resume", "goal.lifecycle.stop", "goal.reset",
    "flow.goal.create", "flow.start", "flow.stop",
    "flow.pr.retry", "flow.pr.ready", "flow.pr.merge",
    "flow.steering.focus", "discover.start", "discover.stop",
    "discover.tab.contribution", "discover.tab.contribution-skill",
  ];
  const missingCommands = requiredCommands.filter((id) => !ids.has(id));
  check(missingCommands.length === 0, "the palette misses required commands", missingCommands);
  const removedCommands = [
    "goal.save", "goal.revision.focus", "flow.goal.save", "flow.decisions.save",
    "discover.skill.save.discover-testing-strategy",
    "discover.skill.restore.discover-testing-strategy",
    "discover.skill.save.discover-contribution",
    "tab.close.confirm", "tab.close.cancel",
  ].filter((id) => ids.has(id));
  check(removedCommands.length === 0, "the palette still lists a removed editor command", removedCommands);
  check(!ids.has("view.sidebar.toggle"), "the palette still offers a sidebar toggle");
  check((await sourceOnlyMarkers(page)) === 0, "the command palette renders a source-only marker");
  const agentsCommand = palette.items.find((item) => item.id === "open.issues.agents");
  check(
    agentsCommand?.title === "Open Agents" && agentsCommand?.group === "Workspace",
    "the palette does not list Open Agents in the Workspace group",
    agentsCommand,
  );
  const disabledMirror = palette.items.find((item) => item.id === "flow.pr.merge");
  check(disabledMirror?.disabled === true && disabledMirror.reason.length > 0, "a disabled control is not mirrored with a reason", disabledMirror);
  check(
    palette.shortcutType !== null &&
      Math.abs(palette.shortcutType.fontSize - 11.5) < 0.05 &&
      palette.shortcutType.fontWeight === "400" &&
      Math.abs(palette.shortcutType.lineHeight - 16.1) < 0.05 &&
      palette.shortcutType.fontFamily.toLowerCase().includes("mono"),
    "the palette shortcut does not render the mono-small type",
    palette.shortcutType,
  );
  check(
    palette.reasonType !== null &&
      Math.abs(palette.reasonType.fontSize - 12) < 0.05 &&
      palette.reasonType.fontWeight === "400" &&
      Math.abs(palette.reasonType.lineHeight - 17.4) < 0.05 &&
      palette.reasonType.letterSpacing === "normal",
    "the palette disabled reason does not render the body-small type",
    palette.reasonType,
  );

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

  // 5b. Devboard mode: fifth tab, the background agents with the MCP entry, read-only tool list.
  const catalog = toolListPayload().tools.map(({ name, title, description }) => ({
    name,
    title,
    description,
    invocations: expectedInvocations[name] ?? 0,
  }));
  await page.click('[data-testid="mode-devboard"]');
  await page.wait(
    `document.querySelector('[data-testid="mode-devboard"]')?.getAttribute("aria-selected") === "true"`,
    "the Devboard mode from its tab",
  );
  await page.wait(
    `document.querySelectorAll('[data-testid="mcp-tool"]').length === ${catalog.length}`,
    "the MCP tool list",
  );
  const devboardTab = await page.eval<{
    label: string;
    ariaLabel: string;
    title: string;
    controls: string;
    controlsExists: boolean;
    selected: string;
    width: number;
    height: number;
    overflow: number;
    inside: boolean;
  }>(`(() => {
    const tab = document.querySelector('[data-testid="mode-devboard"]');
    const label = tab?.querySelector('.activity-tab__label');
    const tabRect = tab?.getBoundingClientRect();
    const labelRect = label?.getBoundingClientRect();
    return {
      label: label?.textContent?.trim() ?? "",
      ariaLabel: tab?.getAttribute("aria-label") ?? "",
      title: tab?.getAttribute("title") ?? "",
      controls: tab?.getAttribute("aria-controls") ?? "",
      controlsExists: document.getElementById(tab?.getAttribute("aria-controls") ?? "") !== null,
      selected: tab?.getAttribute("aria-selected") ?? "",
      width: tabRect === undefined ? 0 : Math.round(tabRect.width),
      height: tabRect === undefined ? 0 : Math.round(tabRect.height),
      overflow: label === null || label === undefined ? 1 : label.scrollWidth - label.clientWidth,
      inside:
        labelRect !== undefined &&
        tabRect !== undefined &&
        labelRect.left >= tabRect.left - 0.5 &&
        labelRect.right <= tabRect.right + 0.5,
    };
  })()`);
  check(devboardTab.label === "Devboard", "the fifth tab does not render its label", devboardTab);
  check(
    devboardTab.ariaLabel.includes("Alt+5") && devboardTab.title.includes("Alt+5"),
    "the fifth tab does not name Alt+5",
    devboardTab,
  );
  check(
    devboardTab.controls === "workspace-devboard" && devboardTab.controlsExists,
    "the fifth tab does not control workspace-devboard",
    devboardTab,
  );
  check(
    devboardTab.selected === "true" &&
      devboardTab.width === 64 &&
      devboardTab.height === 52 &&
      devboardTab.overflow <= 1 &&
      devboardTab.inside,
    "the fifth tab is not a selected 64×52 control with an inside label",
    devboardTab,
  );

  const toolPage = await page.eval<{
    workspace: boolean;
    list: boolean;
    count: number;
    rows: Array<{
      tool: string;
      name: string;
      title: string;
      description: string;
      invocations: string;
      label: string;
    }>;
    controls: number;
    commands: number;
  }>(`(() => {
    const workspace = document.querySelector('[data-testid="devboard-workspace"]');
    const list = workspace?.querySelector('[data-testid="mcp-tools-list"]') ?? null;
    const rows = [...(list?.querySelectorAll('[data-testid="mcp-tool"]') ?? [])];
    return {
      workspace: workspace !== null,
      list: list !== null,
      count: rows.length,
      rows: rows.map((row) => {
        const stats = row.querySelector('[data-testid="mcp-tool-invocations"]');
        return {
          tool: row.getAttribute("data-tool") ?? "",
          name: row.querySelector('.devboard-tool__name')?.textContent ?? "",
          title: row.querySelector('.devboard-tool__title')?.textContent ?? "",
          description: row.querySelector('.devboard-tool__description')?.textContent ?? "",
          invocations: stats?.getAttribute("data-invocations") ?? "",
          label: stats?.textContent?.trim() ?? "",
        };
      }),
      controls:
        workspace === null
          ? -1
          : workspace.querySelectorAll('button, input, textarea, select, a, [role="button"]').length,
      commands: workspace === null ? -1 : workspace.querySelectorAll("[data-command]").length,
    };
  })()`);
  check(toolPage.workspace && toolPage.list, "the Devboard workspace or list is missing", toolPage);
  check(toolPage.count === catalog.length, "the MCP tool rows do not match the catalog count", {
    rendered: toolPage.count,
    expected: catalog.length,
  });
  check(toolPage.controls === 0 && toolPage.commands === 0, "the MCP tool list exposes an action", toolPage);
  const toolMismatch = catalog.findIndex((expected, index) => {
    const row = toolPage.rows[index];
    return (
      row === undefined ||
      row.tool !== expected.name ||
      row.name !== expected.name ||
      row.title !== expected.title ||
      row.description !== expected.description ||
      row.invocations !== String(expected.invocations)
    );
  });
  check(toolMismatch < 0, "a rendered MCP tool differs from the catalog", {
    index: toolMismatch,
    rendered: toolPage.rows[toolMismatch],
    expected: catalog[toolMismatch],
  });
  const journalLabel = toolPage.rows.find((row) => row.tool === "journal_search")?.label ?? "";
  const statusLabel = toolPage.rows.find((row) => row.tool === "devboard_status")?.label ?? "";
  check(
    journalLabel === "2 invocations" && statusLabel === "1 invocation",
    "a rendered invocation count is not the server's count with its singular or plural label",
    { journalLabel, statusLabel },
  );
  recordToolInvocation(stateDir, host, "journal_search");
  await page.wait(
    `document.querySelector('[data-testid="mcp-tool"][data-tool="journal_search"] ` +
      `[data-testid="mcp-tool-invocations"]')?.getAttribute("data-invocations") === "3"`,
    "the refreshed invocation count",
  );

  const devboardSidebar = await page.eval<{
    entries: number;
    items: number;
    labels: string[];
    commands: string[];
    agentLabels: string[];
    agentCommands: string[];
    toolNames: string[];
  }>(`(() => {
    const sidebar = document.querySelector('[data-testid="sidebar"]');
    const entries = [...(sidebar?.querySelectorAll('[data-testid="devboard-tab"]') ?? [])];
    const agents = [...(sidebar?.querySelectorAll('[data-testid^="open-devboard-"]') ?? [])];
    const text = sidebar?.textContent ?? "";
    return {
      entries: entries.length,
      items: sidebar?.querySelectorAll('.sidebar-item').length ?? 0,
      labels: entries.map(
        (entry) => entry.querySelector('.sidebar-item__label')?.textContent?.trim() ?? "",
      ),
      commands: entries.map((entry) => entry.getAttribute("data-command") ?? ""),
      agentLabels: agents.map(
        (button) =>
          button.querySelector('.sidebar-item__label')?.textContent?.trim() ?? "",
      ),
      agentCommands: agents.map((button) => button.getAttribute("data-command") ?? ""),
      toolNames: ${JSON.stringify(catalog.map((tool) => tool.name))}.filter((name) =>
        text.includes(name),
      ),
    };
  })()`);
  check(
    devboardSidebar.entries === 2 &&
      devboardSidebar.items === 9 &&
      JSON.stringify(devboardSidebar.agentLabels) ===
        JSON.stringify([
          "Auto Scout",
          "Watchdog",
          "Design System",
          "Dead Code",
          "Coach",
          "API Standards",
          "Release Train",
        ]) &&
      JSON.stringify(devboardSidebar.agentCommands) ===
        JSON.stringify([
          "open.devboard.scout",
          "open.devboard.watchdog",
          "open.devboard.design",
          "open.devboard.dead-code",
          "open.devboard.coach",
          "open.devboard.api-standards",
          "open.devboard.release-train",
        ]),
    "the Devboard sidebar does not carry the background agents beside the two page entries",
    devboardSidebar,
  );
  check(
    JSON.stringify(devboardSidebar.labels) === JSON.stringify(["MCP tools", "Skills"]) &&
      JSON.stringify(devboardSidebar.commands) ===
        JSON.stringify(["devboard.tab.tools", "devboard.tab.skills"]),
    "the Devboard sidebar entries are not the MCP tools and Skills pages",
    devboardSidebar,
  );
  check(devboardSidebar.toolNames.length === 0, "a tool name leaked into the sidebar", devboardSidebar);
  check((await sourceOnlyMarkers(page)) === 0, "the Devboard MCP tools page renders a source-only marker");

  // 5c. The Skills page lists the fixture host's installed skills, one entry
  // opens it, and the checkbox mirrors and writes the project-level exclusion.
  async function showDevboardSkills(): Promise<void> {
    await page.click('[data-testid="mode-devboard"]');
    await page.wait(
      `document.querySelector('[data-testid="mode-devboard"]')?.getAttribute("aria-selected") === "true"`,
      "the Devboard mode before the Skills page",
    );
    await page.click('[data-testid="devboard-tab"][data-command="devboard.tab.skills"]');
    await page.wait(`document.querySelector('[data-testid="skills-table"]') !== null`, "the Skills table");
  }

  await showDevboardSkills();

  const devboardSkillsTable = await page.eval<{
    tables: number;
    columns: number;
    names: string[];
    checked: boolean[];
    cells: number[];
    managed: string[];
    deletables: Array<{ name: string; label: string }>;
    perRowControls: string[][];
    text: string;
    headType: {
      fontSize: number;
      fontWeight: string;
      letterSpacing: number;
      lineHeight: number;
    } | null;
  }>(`(() => {
    const table = document.querySelector('[data-testid="skills-table"]');
    const rows = [...document.querySelectorAll('[data-testid="skill-row"]')];
    const head = table?.querySelector("th") ?? null;
    const headStyle = head === null ? null : getComputedStyle(head);
    return {
      tables: document.querySelectorAll('[data-testid="skills-table"] table, [data-testid="skills-table"]').length,
      columns: table?.rows[0]?.cells.length ?? -1,
      names: rows.map((row) => row.getAttribute("data-skill") ?? ""),
      checked: rows.map((row) => row.querySelector('[data-testid="skill-enabled"]')?.checked === true),
      cells: rows.map((row) => row.querySelectorAll("td").length),
      managed: rows
        .filter((row) => row.querySelector('[data-testid="skill-managed"]') !== null)
        .map((row) => row.getAttribute("data-skill") ?? ""),
      deletables: rows
        .map((row) => ({
          name: row.getAttribute("data-skill") ?? "",
          label: row.querySelector('[data-testid="delete-skill"]')?.getAttribute("aria-label") ?? "",
        }))
        .filter((entry) => entry.label.length > 0),
      perRowControls: rows.map((row) =>
        [...row.querySelectorAll('button, input, select, textarea, a, [role="button"]')].map(
          (control) => control.getAttribute("data-testid") ?? control.tagName,
        ),
      ),
      text: table?.textContent ?? "",
      headType: headStyle === null ? null : {
        fontSize: parseFloat(headStyle.fontSize),
        fontWeight: headStyle.fontWeight,
        letterSpacing: parseFloat(headStyle.letterSpacing),
        lineHeight: parseFloat(headStyle.lineHeight),
      },
    };
  })()`);
  const devboardInstalledSkills = readdirSync(join(host, ".omp", "skills")).sort();
  const devboardBuiltins = [
    "devboard-restful-api-implementation",
    "devboard-single-responsibility-principle",
    "devboard-ui-ux",
  ];
  check(devboardSkillsTable.tables === 1, "the Skills page does not render one table", devboardSkillsTable);
  check(devboardSkillsTable.columns === 3, "the Skills table does not have three columns", devboardSkillsTable);
  check(
    devboardSkillsTable.headType !== null &&
      Math.abs(devboardSkillsTable.headType.fontSize - 11) < 0.05 &&
      devboardSkillsTable.headType.fontWeight === "600" &&
      Math.abs(devboardSkillsTable.headType.letterSpacing / devboardSkillsTable.headType.fontSize - 0.03) <
        0.005 &&
      Math.abs(devboardSkillsTable.headType.lineHeight - 14.3) < 0.05,
    "the Skills table head does not render the label type",
    devboardSkillsTable.headType,
  );
  check(
    JSON.stringify(devboardSkillsTable.names) === JSON.stringify(devboardInstalledSkills),
    "the Skills rows do not equal the installed directories",
    { rendered: devboardSkillsTable.names, installed: devboardInstalledSkills },
  );
  check(
    devboardSkillsTable.cells.every((cells) => cells === 3) &&
      devboardSkillsTable.perRowControls.every(
        (controls) =>
          controls.filter((control) => control === "skill-disclosure").length === 1 &&
          controls.filter((control) => control === "skill-enabled").length === 1 &&
          controls.filter((control) => control !== "skill-disclosure" && control !== "skill-enabled" && control !== "delete-skill").length === 0,
      ),
    "a Skills row does not hold one disclosure, one checkbox, and at most one delete",
    devboardSkillsTable,
  );
  check(
    devboardSkillsTable.checked.every((checked) => checked),
    "an installed skill does not start checked",
    devboardSkillsTable,
  );
  check(
    JSON.stringify(devboardSkillsTable.managed) === JSON.stringify(devboardBuiltins),
    "the Managed marker does not belong to exactly the three built-in rows",
    devboardSkillsTable,
  );
  check(
    JSON.stringify(devboardSkillsTable.deletables) ===
      JSON.stringify([
        { name: "fixture-conventions", label: "Delete fixture-conventions" },
        { name: "fixture-deletable", label: "Delete fixture-deletable" },
      ]),
    "the delete control does not belong to exactly the prepare-family rows",
    devboardSkillsTable,
  );
  check(
    devboardSkillsTable.text.includes("Managed") &&
      !/devboard-managed|devboard-family|description/i.test(devboardSkillsTable.text),
    "the Skills table renders skill content, family, or the wrong marker",
    devboardSkillsTable,
  );

  const devboardDisclosurePaint = await page.eval<{
    slots: string[];
    variants: string[];
    resting: string[];
    pressed: string[];
    released: string[];
  }>(`(async () => {
    const disclosures = [...document.querySelectorAll('[data-testid="skill-disclosure"]')];
    const settle = async () => {
      const { promise, resolve } = Promise.withResolvers();
      setTimeout(resolve, 50);
      return promise;
    };
    const resting = disclosures.map((control) => getComputedStyle(control).backgroundColor);
    for (const control of disclosures) {
      control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    }
    await settle();
    const pressed = disclosures.map((control) => getComputedStyle(control).backgroundColor);
    for (const control of disclosures) {
      control.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    }
    await settle();
    return {
      slots: disclosures.map((control) => control.getAttribute("data-slot") ?? ""),
      variants: disclosures.map((control) => control.getAttribute("data-variant") ?? ""),
      resting,
      pressed,
      released: disclosures.map((control) => getComputedStyle(control).backgroundColor),
    };
  })()`);
  check(
    devboardDisclosurePaint.slots.every((slot) => slot === "button") &&
      devboardDisclosurePaint.variants.every((variant) => variant === "bare"),
    "a Skills disclosure is not the shared Button primitive",
    devboardDisclosurePaint,
  );
  check(
    devboardDisclosurePaint.pressed.every((paint, index) => paint !== devboardDisclosurePaint.resting[index]) &&
      JSON.stringify(devboardDisclosurePaint.released) ===
        JSON.stringify(devboardDisclosurePaint.resting),
    "a Skills disclosure does not paint a pressed fill",
    devboardDisclosurePaint,
  );

  const devboardFirstSkill = devboardInstalledSkills[0] ?? "";
  const devboardSkillRow = (name: string): string =>
    `[data-testid="skill-row"][data-skill="${name}"]`;
  const devboardDisclosure = (name: string): string =>
    `${devboardSkillRow(name)} [data-testid="skill-disclosure"]`;
  await page.click(devboardDisclosure(devboardFirstSkill));
  await page.wait(
    `document.querySelector('[data-testid="skill-content"]') !== null`,
    "the expanded skill content",
  );
  const devboardSkillExpanded = await page.eval<{
    text: string;
    skill: string;
    expanded: boolean;
    contentRows: number;
  }>(`(() => {
    const content = document.querySelector('[data-testid="skill-content"]');
    const row = document.querySelector('${devboardSkillRow(devboardFirstSkill)}');
    return {
      text: content?.textContent ?? "",
      skill: content?.getAttribute("data-skill") ?? "",
      expanded: row?.getAttribute("aria-expanded") === "true",
      contentRows: document.querySelectorAll('[data-testid="skill-content-row"]').length,
    };
  })()`);
  const devboardFirstSkillSentence =
    readFileSync(join(host, ".omp", "skills", devboardFirstSkill, "SKILL.md"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          line.length > 3 && !line.startsWith("#") && !line.startsWith("---") && !line.includes(":"),
      ) ?? "";
  check(
    devboardSkillExpanded.skill === devboardFirstSkill &&
      devboardSkillExpanded.expanded &&
      devboardSkillExpanded.contentRows === 1 &&
      devboardFirstSkillSentence.length > 0 &&
      devboardSkillExpanded.text.includes(devboardFirstSkillSentence.replace(/^-\s*/, "")),
    "the expanded skill row does not show its SKILL.md body",
    { expanded: devboardSkillExpanded, expected: devboardFirstSkillSentence },
  );
  await page.click(devboardDisclosure(devboardFirstSkill));
  await page.wait(
    `document.querySelector('[data-testid="skill-content"]') === null`,
    "the collapsed skill content",
  );

  const devboardSettingsFile = join(host, ".omp", "settings.json");
  const devboardSkillCheckbox = (name: string): string =>
    `[data-testid="skill-row"][data-skill="${name}"] [data-testid="skill-enabled"]`;
  await page.click(devboardSkillCheckbox(devboardFirstSkill));
  await page.wait(
    `document.querySelector('${devboardSkillCheckbox(devboardFirstSkill)}')?.checked === false`,
    "the unchecked skill",
  );
  const devboardIgnoredAfterUncheck = (): unknown =>
    JSON.parse(readFileSync(devboardSettingsFile, "utf8")).skills?.ignoredSkills;
  await waitFor(() => {
    try {
      const ignored = devboardIgnoredAfterUncheck();
      return Array.isArray(ignored) && ignored.length === 1 && ignored[0] === devboardFirstSkill
        ? true
        : undefined;
    } catch {
      return undefined;
    }
  }, "the unchecked skill in the project OMP settings");
  await page.click(devboardSkillCheckbox(devboardFirstSkill));
  await page.wait(
    `document.querySelector('${devboardSkillCheckbox(devboardFirstSkill)}')?.checked === true`,
    "the rechecked skill",
  );
  await waitFor(() => {
    try {
      const ignored = devboardIgnoredAfterUncheck();
      return Array.isArray(ignored) && !ignored.includes(devboardFirstSkill) && ignored.length === 0
        ? true
        : undefined;
    } catch {
      return undefined;
    }
  }, "the rechecked skill removed from the project OMP settings");

  const devboardExtraSkill = join(host, ".omp", "skills", "extra-skill");
  await mkdir(devboardExtraSkill, { recursive: true });
  await writeFile(
    join(devboardExtraSkill, "SKILL.md"),
    "---\nname: extra-skill\ndescription: Extra fixture guidance.\n---\n\n# Extra skill\n",
  );
  await page.reload();
  await showDevboardSkills();
  await page.wait(
    `document.querySelectorAll('[data-testid="skill-row"]').length === ${devboardInstalledSkills.length + 1}`,
    "the added skill row",
  );
  const devboardWithExtra = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="skill-row"]')].map((row) => row.getAttribute("data-skill") ?? "")`,
  );
  check(
    JSON.stringify(devboardWithExtra) === JSON.stringify([...devboardInstalledSkills, "extra-skill"].sort()),
    "an added skill directory does not add exactly its row",
    devboardWithExtra,
  );
  const devboardSidebarAfterAdd = await page.eval<number>(
    `document.querySelectorAll('[data-testid="sidebar"] [data-testid="devboard-tab"]').length`,
  );
  check(devboardSidebarAfterAdd === 2, "a skill directory changed the sidebar entry count", devboardSidebarAfterAdd);
  await rm(devboardExtraSkill, { recursive: true, force: true });
  await page.reload();
  await showDevboardSkills();
  await page.wait(
    `document.querySelectorAll('[data-testid="skill-row"]').length === ${devboardInstalledSkills.length}`,
    "the removed skill row",
  );

  await writeFile(devboardSettingsFile, `${JSON.stringify({ skills: { ignoredSkills: ["ghost-skill"] } })}\n`);
  await page.reload();
  await showDevboardSkills();
  const devboardGhostRows = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="skill-row"]')].map((row) => row.getAttribute("data-skill") ?? "")`,
  );
  check(
    JSON.stringify(devboardGhostRows) === JSON.stringify(devboardInstalledSkills) && !devboardGhostRows.includes("ghost-skill"),
    "an exclusion name without a directory produced a row",
    devboardGhostRows,
  );

  await page.click(devboardSkillCheckbox(devboardFirstSkill));
  await page.wait(
    `document.querySelector('${devboardSkillCheckbox(devboardFirstSkill)}')?.checked === false`,
    "the unchecked skill before a reload",
  );
  await page.reload();
  await showDevboardSkills();
  await page.wait(
    `document.querySelector('${devboardSkillCheckbox(devboardFirstSkill)}')?.checked === false`,
    "the unchecked skill after a reload",
  );
  await rm(devboardSettingsFile, { force: true });
  await page.click(devboardSkillCheckbox(devboardFirstSkill));
  await page.wait(
    `document.querySelector('${devboardSkillCheckbox(devboardFirstSkill)}')?.checked === true`,
    "the rechecked skill after the persistence check",
  );
  // Every owner but the prepare family is refused by the server itself, and
  // the refusal leaves the directory, the link, and the settings untouched.
  const refusalSettings = `${JSON.stringify({
    skills: { ignoredSkills: ["kept-entry"] },
    unrelated: { keep: true },
  })}\n`;
  await writeFile(devboardSettingsFile, refusalSettings);
  const refusals = await page.eval<Array<{ name: string; message: string }>>(`(async () => {
    const socket = new WebSocket(
      (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/ws",
    );
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const names = [
      "devboard-ui-ux",
      "discover-testing-strategy",
      "fixture-handwritten",
      "fixture-linked",
      "not-installed",
    ];
    const results = [];
    for (const name of names) {
      const message = await new Promise((resolve) => {
        const onMessage = (event) => {
          let frame;
          try {
            frame = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (frame.type !== "error") return;
          socket.removeEventListener("message", onMessage);
          resolve(String(frame.message));
        };
        socket.addEventListener("message", onMessage);
        socket.send(JSON.stringify({ type: "deleteSkill", name }));
      });
      results.push({ name, message });
    }
    socket.close();
    return results;
  })()`);
  check(
    refusals.length === 5 &&
      refusals[0]?.message === '"devboard-ui-ux" is a built-in skill and cannot be deleted.' &&
      refusals.slice(1).every(
        (entry) => entry.message === `No prepared skill named "${entry.name}" is installed.`,
      ),
    "the server did not refuse the built-in, Discover, hand-authored, symlinked, and unknown names",
    refusals,
  );
  for (const name of ["devboard-ui-ux", "fixture-handwritten", "fixture-conventions"]) {
    check(existsSync(join(host, ".omp", "skills", name)), `the refused ${name} directory was removed`);
  }
  check(
    lstatSync(join(host, ".omp", "skills", "fixture-linked")).isSymbolicLink(),
    "the refused symlink was removed",
  );
  check(
    readFileSync(devboardSettingsFile, "utf8") === refusalSettings,
    "a refused delete rewrote the project settings",
  );

  // One click removes the prepare-family directory with no confirmation and
  // clears exactly its exclusion entry, and the row stays gone after a reload.
  const deleteSettings = {
    modelRoles: { commit: "provider/model" },
    skills: { includeSkills: ["kept"], ignoredSkills: ["fixture-deletable", "kept-pattern"] },
    unrelated: { keep: true },
  };
  await writeFile(devboardSettingsFile, `${JSON.stringify(deleteSettings)}\n`);
  await page.reload();
  await showDevboardSkills();
  check(
    (await page.eval<number>(
      `document.querySelectorAll('[data-testid="delete-skill"][data-name="fixture-deletable"]').length`,
    )) === 1,
    "the prepare-family delete control is missing",
  );
  check(
    existsSync(join(host, ".omp", "skills", "fixture-deletable")),
    "the deletable fixture skill is missing before the click",
  );
  await page.click('[data-testid="delete-skill"][data-name="fixture-deletable"]');
  await page.wait(
    `document.querySelector('[data-testid="skill-row"][data-skill="fixture-deletable"]') === null`,
    "the deleted prepared skill row",
  );
  check(
    !existsSync(join(host, ".omp", "skills", "fixture-deletable")),
    "one click did not remove the prepared skill directory",
  );
  check(
    JSON.stringify(JSON.parse(readFileSync(devboardSettingsFile, "utf8"))) ===
      JSON.stringify({
        modelRoles: { commit: "provider/model" },
        skills: { includeSkills: ["kept"], ignoredSkills: ["kept-pattern"] },
        unrelated: { keep: true },
      }),
    "deleting a prepared skill did not remove exactly its ignored name",
    readFileSync(devboardSettingsFile, "utf8"),
  );
  await page.reload();
  await showDevboardSkills();
  await page.wait(
    `document.querySelectorAll('[data-testid="skill-row"][data-skill="fixture-deletable"]').length === 0`,
    "the deleted prepared skill row after a reload",
  );

  await page.click('[data-testid="devboard-tab"][data-command="devboard.tab.tools"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="mcp-tool"]').length === ${catalog.length}`,
    "the MCP tool list after the Skills page",
  );

  const layoutBeforeDevboard = await page.eval<string>(
    `localStorage.getItem("devboard.layout.v1") ?? ""`,
  );
  const framesBeforeDevboard = await page.eval<string[]>(
    `(window.__viFrames ?? []).filter((frame) => !String(frame).includes("getVersion") && !String(frame).includes("getMcpTools") && !String(frame).includes("getInstalledSkills"))`,
  );

  await page.key("1", 1);
  await page.wait(
    `document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`,
    "Goal before Alt+5",
  );
  await page.key("5", 1);
  await page.wait(
    `document.querySelector('[data-testid="mode-devboard"]')?.getAttribute("aria-selected") === "true"`,
    "Alt+5",
  );
  await page.key("1", 1);
  await page.wait(
    `document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`,
    "Goal before the Devboard palette command",
  );
  await page.key("k", 2);
  await page.wait(
    `document.querySelector('[data-testid="command-palette"]') !== null`,
    "the palette for Devboard",
  );
  const devboardPalette = await page.eval<{ title: string; shortcut: string; group: string }>(`(() => {
    const item = document.querySelector('[data-testid="command-item"][data-command="view.mode.devboard"]');
    return {
      title: item?.querySelector('.palette__item-title')?.textContent?.trim() ?? "",
      shortcut: item?.querySelector('.palette__shortcut')?.textContent?.trim() ?? "",
      group: (() => {
        if (item === null) return "";
        let sibling = item.previousElementSibling;
        while (sibling !== null && !sibling.classList.contains('palette__group')) {
          sibling = sibling.previousElementSibling;
        }
        return sibling?.textContent?.trim() ?? "";
      })(),
    };
  })()`);
  check(
    devboardPalette.shortcut === "Alt+5" && devboardPalette.title === "Switch to Devboard",
    "the palette does not list view.mode.devboard with Alt+5",
    devboardPalette,
  );
  await page.key("Escape");
  await page.wait(
    `document.querySelector('[data-testid="command-palette"]') === null`,
    "the palette to close after Devboard",
  );
  await runPalette("view.mode.devboard");
  await page.wait(
    `document.querySelector('[data-testid="mode-devboard"]')?.getAttribute("aria-selected") === "true"`,
    "Devboard from the palette",
  );
  const framesAfterDevboard = await page.eval<string[]>(
    `(window.__viFrames ?? []).filter((frame) => !String(frame).includes("getVersion") && !String(frame).includes("getMcpTools") && !String(frame).includes("getInstalledSkills"))`,
  );
  check(
    JSON.stringify(framesAfterDevboard) === JSON.stringify(framesBeforeDevboard),
    "a Devboard switch sent a WebSocket frame",
    { framesBeforeDevboard, framesAfterDevboard },
  );
  check(
    framesAfterDevboard.every((frame) => !frame.includes("tools/call")),
    "the Devboard page called an MCP tool",
    framesAfterDevboard,
  );
  await delay(150);
  const devboardLayout = await page.eval<{ before: string; after: string }>(`(() => {
    const before = ${JSON.stringify(layoutBeforeDevboard)};
    let parsed = null;
    try {
      parsed = JSON.parse(before);
    } catch {
      parsed = null;
    }
    const stored = localStorage.getItem("devboard.layout.v1") ?? "";
    let next = null;
    try {
      next = JSON.parse(stored);
    } catch {
      next = null;
    }
    return {
      before: JSON.stringify({ tabs: parsed?.tabs ?? null, activeTab: parsed?.activeTab ?? null }),
      after: JSON.stringify({ tabs: next?.tabs ?? null, activeTab: next?.activeTab ?? null }),
    };
  })()`);
  check(
    devboardLayout.before === devboardLayout.after &&
      devboardLayout.after.includes('"devboard"'),
    "a Devboard switch changed another mode's stored page",
    devboardLayout,
  );

  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="mode-devboard"]')?.getAttribute("aria-selected") === "true"`,
    "Devboard after reload",
  );
  await page.wait(
    `document.querySelectorAll('[data-testid="mcp-tool"]').length === ${catalog.length}`,
    "the MCP tool list after reload",
  );
  const reloadedDevboard = await page.eval<{ mode: string; rows: number; sidebar: boolean; label: string }>(`(() => ({
    mode: ["goal", "issues", "flow", "discover", "devboard"].find(
      (mode) => document.querySelector('[data-testid="mode-' + mode + '"]')?.getAttribute("aria-selected") === "true",
    ) ?? "",
    rows: document.querySelectorAll('[data-testid="mcp-tool"]').length,
    sidebar: document.querySelector('[data-testid="sidebar"] [data-testid="devboard-tab"]') !== null,
    label: document.querySelector('[data-testid="sidebar"] [data-testid="devboard-tab"] .sidebar-item__label')?.textContent?.trim() ?? "",
  }))()`);
  check(
    reloadedDevboard.mode === "devboard" &&
      reloadedDevboard.rows === catalog.length &&
      reloadedDevboard.sidebar &&
      reloadedDevboard.label === "MCP tools",
    "a reload did not restore Devboard and its list",
    reloadedDevboard,
  );
  await page.key("4", 1);
  await page.wait(
    `document.querySelector('[data-testid="mode-discover"]')?.getAttribute("aria-selected") === "true"`,
    "Discover after Devboard",
  );
  await page.wait(
    `document.querySelector('#discover-glossary-search') !== null`,
    "the preserved Discover page after Devboard",
  );

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

  // 6b. The sidebar's default and bounds follow the 72px rail at the floor.
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(
    `innerWidth === 1024 && innerHeight === 720`,
    "the 1024×720 viewport for the sidebar bounds",
  );
  await page.doubleClick('[data-testid="pane-handle"]');
  const floorDefaultWidth = await sidebarWidth();
  check(floorDefaultWidth === 300, `the sidebar default is ${floorDefaultWidth}px at 1024×720`, floorDefaultWidth);
  const maximumSeparator = await page.rect('[data-testid="pane-handle"]');
  check(maximumSeparator !== null, "the sidebar separator is missing at 1024×720");
  await page.drag(maximumSeparator!, 320);
  const floorMaximumWidth = await sidebarWidth();
  check(floorMaximumWidth === 600, `the sidebar maximum is ${floorMaximumWidth}px at 1024×720`, floorMaximumWidth);
  const minimumSeparator = await page.rect('[data-testid="pane-handle"]');
  check(minimumSeparator !== null, "the sidebar separator is missing at its maximum");
  await page.drag(minimumSeparator!, -500);
  const floorMinimumWidth = await sidebarWidth();
  check(floorMinimumWidth === 200, `the sidebar minimum is ${floorMinimumWidth}px at 1024×720`, floorMinimumWidth);
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the desktop viewport after the sidebar bounds");
  await page.doubleClick('[data-testid="pane-handle"]');

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
    headers: string[];
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
      headers: [...document.querySelectorAll('[data-testid="adr-table"] thead th')].map(
        (cell) => cell.textContent?.trim() ?? "",
      ),
    };
  })()`);
  check(adr.rows === 8, "the fixture does not render eight ADR rows", adr);
  check(!adr.eyebrow, "the ADRs header still carries its Plan eyebrow", adr);
  check(
    adr.headers.join("|") === "Title|Document status|Implementation|File|Decision summary|Action",
    "the ADR table does not render its declared column labels",
    adr.headers,
  );
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
  const startControls = await page.eval<{
    buttons: Array<{
      file: string;
      text: string;
      aria: string;
      next: boolean;
      height: number;
      radius: string;
      fontSize: string;
      cursor: string;
      primaryFill: boolean;
      strongOutline: boolean;
      topGap: number;
      bottomGap: number;
      leftGap: number;
      rightGap: number;
    }>;
    resolvedActions: string[];
  }>(`(() => {
    const root = getComputedStyle(document.documentElement);
    const primary = root.getPropertyValue("--primary").trim();
    const borderStrong = root.getPropertyValue("--border-strong").trim();
    const rgb = (hex) => {
      const value = Number.parseInt(hex.slice(1), 16);
      return "rgb(" + (value >> 16 & 255) + ", " + (value >> 8 & 255) + ", " + (value & 255) + ")";
    };
    const buttons = [...document.querySelectorAll('[data-testid="start"]')].map((button) => {
      const box = button.getBoundingClientRect();
      const row = button.closest("tr").getBoundingClientRect();
      const cell = button.closest("td").getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        file: button.getAttribute("data-file") ?? "",
        text: button.textContent?.trim() ?? "",
        aria: button.getAttribute("aria-label") ?? "",
        next: button.closest("tr")?.getAttribute("data-next") === "true",
        height: Math.round(box.height),
        radius: style.borderRadius,
        fontSize: style.fontSize,
        cursor: style.cursor,
        primaryFill: style.backgroundColor === rgb(primary),
        strongOutline: style.borderTopColor === rgb(borderStrong),
        topGap: box.top - row.top,
        bottomGap: row.bottom - box.bottom,
        leftGap: box.left - cell.left,
        rightGap: cell.right - box.right,
      };
    });
    return {
      buttons,
      resolvedActions: [...document.querySelectorAll('[data-testid="record"]')]
        .filter((row) => row.getAttribute("data-pending") === "false")
        .map((row) => row.querySelector("td:last-child")?.textContent?.trim() ?? ""),
    };
  })()`);
  check(startControls.buttons.length === 4, "the table does not render one Start per pending record", startControls);
  check(
    startControls.buttons.every(
      (button) =>
        button.text === "Start" &&
        button.aria.startsWith("Start the implementation of ") &&
        button.aria.length > "Start the implementation of ".length &&
        button.file.length > 0 &&
        button.height === 24 &&
        button.radius === "4px" &&
        button.fontSize === "11px" &&
        button.cursor === "pointer" &&
        Math.abs(button.topGap - button.bottomGap) <= 1,
    ),
    "a Start control is not a centered 24px Button with a record-naming accessible name",
    startControls,
  );
  check(
    startControls.buttons.every((button) => Math.abs(button.leftGap - button.rightGap) <= 1),
    "a Start control is not horizontally centered in the Action column",
    startControls,
  );
  const filledStarts = startControls.buttons.filter((button) => button.primaryFill);
  check(
    filledStarts.length === 1 &&
      filledStarts[0]?.next === true &&
      startControls.buttons.filter((button) => button.next).length === 1 &&
      startControls.buttons.filter((button) => !button.next && button.strongOutline).length === 3,
    "the Start emphasis is not one filled primary on the Next record",
    startControls,
  );
  check(
    startControls.resolvedActions.length > 0 &&
      startControls.resolvedActions.every((text) => text === ""),
    "a resolved row repeats its state in the action column",
    startControls,
  );
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

  // The Goal sidebar has one Skills entry that opens the prepared-skills table.
  const goalSkills = await page.eval<{
    sections: number;
    entry: null | { expanded: string; menu: boolean; label: string; command: string };
  }>(`(() => {
    const entry = document.querySelector('[data-testid="goal-skills-open"]');
    return {
      sections: document.querySelectorAll('[data-testid="sidebar"] section[aria-label="Skills"]').length,
      entry: entry === null ? null : {
        expanded: entry.getAttribute("aria-expanded") ?? "",
        menu: document.querySelector('[data-testid="goal-skills-menu"]') !== null,
        label: entry.querySelector(".sidebar-item__label")?.textContent?.trim() ?? "",
        command: entry.getAttribute("data-command") ?? "",
      },
    };
  })()`);
  check(
    goalSkills.sections === 0 &&
      goalSkills.entry !== null &&
      goalSkills.entry.expanded === "" &&
      !goalSkills.entry.menu &&
      goalSkills.entry.label === "Skills" &&
      goalSkills.entry.command === "goal.skills.open",
    "the Goal sidebar does not open the skills table from one Skills entry",
    goalSkills,
  );
  await page.click('[data-testid="goal-skills-open"]');
  await page.wait(`document.querySelector('[data-testid="skills-overlay"]') !== null`, "the Skills page from the sidebar entry");
  const skillsHeaderText = await page.eval<string>(`document.querySelector('[data-testid="skills-header"]')?.textContent ?? ""`);
  check(!skillsHeaderText.includes(".omp/skills/"), "the Skills header still shows the skills path", skillsHeaderText);
  const skillsTable = await page.eval<{ table: boolean; rows: number; names: string[]; descriptions: string[] }>(`(() => {
    const table = document.querySelector('[data-testid="skills-table"]');
    const rows = [...(table?.querySelectorAll('[data-testid="skill"]') ?? [])];
    return {
      table: table !== null,
      rows: rows.length,
      names: rows.map((row) => row.getAttribute("data-name") ?? ""),
      descriptions: rows.map((row) => row.querySelector(".skill-table__description")?.textContent?.trim() ?? ""),
    };
  })()`);
  check(
    skillsTable.table &&
      skillsTable.rows >= 5 &&
      skillsTable.descriptions.every((description) => description.length > 0),
    "the prepared skills table does not list every skill with its description",
    skillsTable,
  );
  const expandingRows = await page.eval<number>(`[...document.querySelectorAll('[data-testid="skill"]')].filter(
    (row) => row.hasAttribute("aria-expanded") || row.hasAttribute("data-selected"),
  ).length`);
  check(expandingRows === 0, "a prepared skills row still expands in place", expandingRows);
  const clickedSkill = await page.eval<string>(`(() => {
    const item = document.querySelector('[data-testid="skill"]');
    item?.click();
    return item?.getAttribute("data-name") ?? "";
  })()`);
  await page.wait(
    `document.querySelector('[data-testid="skill-content"]') !== null && document.querySelector('[data-testid="skills-table"]') === null`,
    "the skill page opened from its table row",
  );
  const skillPage = await page.eval<{
    name: string;
    title: string;
    text: string;
    blocks: number;
    path: string;
    frontmatter: boolean;
    back: string;
  }>(`(() => {
    const detail = document.querySelector('[data-testid="skill-content"]');
    const doc = detail?.querySelector('[data-testid="skill-content-text"]') ?? null;
    return {
      name: detail?.getAttribute("data-name") ?? "",
      title: document.querySelector('[data-testid="skill-header"] .page-header__title')?.textContent?.trim() ?? "",
      text: doc?.textContent?.trim() ?? "",
      blocks: doc?.querySelectorAll('h1, h2, h3, p, li, pre').length ?? 0,
      path: detail?.querySelector('.skill__path')?.textContent?.trim() ?? "",
      frontmatter: (doc?.textContent ?? "").includes("devboard-managed"),
      back: document.querySelector('[data-testid="back-to-skills"]')?.textContent?.trim() ?? "",
    };
  })()`);
  check(
    skillPage.name === clickedSkill && skillPage.title === clickedSkill,
    "clicking a prepared skill does not open that skill's own page",
    { clickedSkill, skillPage },
  );
  check(
    skillPage.text.length > 0 && skillPage.blocks > 0,
    "the skill page does not render the whole document",
    { clickedSkill, skillPage },
  );
  check(!skillPage.frontmatter, "the skill page renders the document with its frontmatter", skillPage);
  check(
    skillPage.path === `.omp/skills/${clickedSkill}/SKILL.md`,
    "the skill page does not name its file",
    skillPage,
  );
  check(skillPage.back === "Back to skills", "the skill page has no way back to the skills table", skillPage);
  await page.click('[data-testid="back-to-skills"]');
  await page.wait(
    `document.querySelector('[data-testid="skills-table"]') !== null && document.querySelector('[data-testid="skill-content"]') === null`,
    "the skills table after going back",
  );
  await runPalette(`goal.skill.open.${clickedSkill}`);
  await page.wait(
    `document.querySelector('[data-testid="skill-content"]')?.getAttribute("data-name") === "${clickedSkill}"`,
    "the skill page from the command palette",
  );
  await page.click('[data-testid="back-to-skills"]');
  await page.wait(`document.querySelector('[data-testid="skills-table"]') !== null`, "the skills table from the palette page");
  const deletion = await page.eval<{ rows: number; controls: string[]; discoverControls: number }>(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="skill"]')];
    const controls = rows
      .map((row) => row.closest("tr")?.querySelector('[data-testid="delete-skill"]')?.getAttribute("data-name") ?? "")
      .filter((name) => name.length > 0);
    return {
      rows: rows.length,
      controls,
      discoverControls: rows.filter(
        (row) =>
          (row.getAttribute("data-name") ?? "").startsWith("discover-") &&
          row.closest("tr")?.querySelector('[data-testid="delete-skill"]') !== null,
      ).length,
    };
  })()`);
  check(
    deletion.rows > 1 && deletion.controls.join(",") === "fixture-conventions" && deletion.discoverControls === 0,
    "the delete control does not belong only to prepared skills",
    deletion,
  );
  const skillsBeforeDelete = await page.eval<number>(`document.querySelectorAll('[data-testid="skill"]').length`);
  await page.click('[data-testid="delete-skill"][data-name="fixture-conventions"]');
  await page.wait(`document.querySelector('[data-testid="delete-skill-confirmation"]') !== null`, "the skill deletion confirmation");
  await page.click('[data-command="goal.skills.delete.confirm"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="skill"]').length === ${skillsBeforeDelete - 1}`,
    "the deleted skill",
  );
  const afterDelete = await page.eval<{ names: string[]; page: boolean; files: number }>(`(() => ({
    names: [...document.querySelectorAll('[data-testid="skill"]')].map((row) => row.getAttribute("data-name") ?? ""),
    page: document.querySelector('[data-testid="skill-content"]') !== null,
    files: Number(window.__viSkillFiles ?? -1),
  }))()`);
  check(
    !afterDelete.names.includes("fixture-conventions") && !afterDelete.page,
    "deleting a skill left its row or its page open",
    afterDelete,
  );

  // 9. Goal document: reset arm/cancel, read-only bytes, and a plain tab close.
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
  await page.wait(`document.querySelector('[data-testid="goal-text"]') !== null`, "the Goal document");
  const goalLayout = await page.eval<{
    tag: string;
    editor: number;
    panel: number;
    revision: number;
    eyebrow: boolean;
    chrome: number;
    dirty: string | null;
  }>(`(() => {
    const editor = document.querySelector('[data-testid="goal-text"]');
    const panel = document.querySelector('[data-testid="goal-editor"]');
    return {
      tag: editor?.tagName ?? "",
      editor: editor === null ? 0 : Math.round(editor.getBoundingClientRect().height),
      panel: panel === null ? 0 : Math.round(panel.getBoundingClientRect().height),
      revision: document.querySelector('[data-testid="revision-request"]') === null ? 0 : 1,
      eyebrow: document.querySelector('[data-testid="document-header"] .page-header__eyebrow') !== null,
      chrome: editor?.querySelectorAll("textarea, input, [contenteditable], .monaco-editor").length ?? -1,
      dirty: editor?.getAttribute("data-dirty") ?? null,
    };
  })()`);
  check(!goalLayout.eyebrow, "the goal document header still carries its Plan eyebrow", goalLayout);
  check(goalLayout.tag === "PRE", "the Goal document is not a read-only PRE", goalLayout);
  check(goalLayout.editor >= 400 && goalLayout.editor >= goalLayout.panel * 0.6, "the goal document does not fill the page", goalLayout);
  check(goalLayout.revision === 0, "the revision guidance field still exists", goalLayout);
  check(goalLayout.chrome === 0 && goalLayout.dirty === null, "the Goal document carries editor chrome", goalLayout);
  await saveShot("goal-document");
  const goalBytes = await readFile(join(host, "GOAL.md"), "utf8");
  const shownGoal = await page.eval<string>(`document.querySelector('[data-testid="goal-text"]')?.textContent ?? ""`);
  check(shownGoal === goalBytes, "the Goal document does not show the GOAL.md bytes", { shownGoal, goalBytes });
  const goalLabel = await page.eval<string>(`document.querySelector('[data-testid="goal-text"]')?.getAttribute("aria-label") ?? ""`);
  check(goalLabel.length > 0, "the Goal document has no accessible label", goalLabel);
  const goalCreate = await page.eval<{ present: boolean; command: string }>(`(() => {
    const button = document.querySelector('[data-testid="create-goal"]');
    return { present: button !== null, command: button?.getAttribute("data-command") ?? "" };
  })()`);
  const goalRevise = await page.eval<{ present: boolean; command: string }>(`(() => {
    const button = document.querySelector('[data-testid="revise-goal"]');
    return { present: button !== null, command: button?.getAttribute("data-command") ?? "" };
  })()`);
  check(
    goalCreate.present && goalCreate.command === "goal.create" &&
      goalRevise.present && goalRevise.command === "goal.revise",
    "the Goal agent actions are missing",
    { goalCreate, goalRevise },
  );
  check(
    (await page.eval<number>(`document.querySelectorAll('[data-testid="save-goal"]').length`)) === 0,
    "the Save goal control still exists",
  );
  const framesBeforeGoalSave = await page.eval<number>("window.__viFrames.length");
  await page.key("s", 2);
  await delay(150);
  check(
    (await page.eval<number>("window.__viFrames.length")) === framesBeforeGoalSave,
    "Ctrl+S sent a frame from the read-only Goal document",
  );
  check(
    (await readFile(join(host, "GOAL.md"), "utf8")) === goalBytes,
    "Ctrl+S changed GOAL.md",
  );

  // Closing the document never asks to discard anything.
  await runPalette("tab.close.goal.goal-document");
  await page.wait(`document.querySelector('[data-testid="goal-text"]') === null`, "the closed Goal document");
  check(
    (await page.eval<boolean>(`document.querySelector('[data-testid="confirm-close-tab"]') !== null`)) === false,
    "closing the read-only Goal document asked to discard changes",
  );
  await runPalette("goal.document.open");
  await page.wait(`document.querySelector('[data-testid="goal-text"]') !== null`, "the reopened Goal document");
  const reopened = await page.eval<string>(`document.querySelector('[data-testid="goal-text"]')?.textContent ?? ""`);
  check(reopened === goalBytes, "reopening the Goal document changed its bytes", reopened);

  // 10. Flow surfaces, the empty-goal onboarding card, and goal cancellation.
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 2101,
    height: 1017,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(
    `innerWidth === 2101 && innerHeight === 1017`,
    "the 2101×1017 viewport for the Flow goal panel",
  );
  await runPalette("open.flow.overview");
  await page.wait(`document.querySelector('[data-testid="mode-flow"]')?.getAttribute("aria-selected") === "true"`, "Flow overview");
  await page.wait(`document.querySelector('[data-testid="flow-goal-onboarding"]') !== null`, "the empty Flow goal onboarding");

  await setTheme(page, "light");
  const emptyLight = await measureFlowGoal(page);
  check(emptyLight.onboarding !== null, "the no-goal Flow panel has no onboarding card", emptyLight);
  check(
    ["interview", "goal", "implementation", "Create flow goal"].every((word) =>
      emptyLight.onboarding!.text.includes(word),
    ),
    "the onboarding card does not name the interview, goal, implementation, and Create action",
    emptyLight.onboarding,
  );
  check(!emptyLight.goalText, "the empty Flow goal renders a read-only goal element", emptyLight);
  check(!emptyLight.cancel, "the empty Flow goal renders a cancel control", emptyLight);
  check(emptyLight.state === "No goal yet", "the empty Flow goal header is not 'No goal yet'", emptyLight);
  check(emptyLight.createActions === 1, "the no-goal header does not hold exactly one Create action", emptyLight);
  check(emptyLight.minHeight !== "360px", "the no-goal panel still carries the 360px minimum", emptyLight);
  check(emptyLight.goalHeight * 2 < emptyLight.pageHeight, "the no-goal panel is not under half its page", emptyLight);
  check(
    emptyLight.nextTop < emptyLight.viewportHeight,
    "the content after the goal starts below the fold",
    emptyLight,
  );
  check(
    emptyLight.onboarding!.scrollWidth <= emptyLight.onboarding!.clientWidth + 1,
    "the onboarding card overflows horizontally in the light theme",
    emptyLight.onboarding,
  );

  await setTheme(page, "dark");
  const emptyDark = await measureFlowGoal(page);
  check(
    emptyDark.goalHeight * 2 < emptyDark.pageHeight && emptyDark.minHeight !== "360px",
    "the no-goal panel reclaims no space in the dark theme",
    emptyDark,
  );
  check(
    emptyDark.onboarding !== null &&
      emptyDark.onboarding.scrollWidth <= emptyDark.onboarding.clientWidth + 1,
    "the onboarding card overflows horizontally in the dark theme",
    emptyDark,
  );

  // Cancel while the interview is working: the panel disappears, the empty
  // state returns, and no error is reported.
  await writeFile(flowGoalGate, "");
  await page.click('[data-testid="create-flow-goal"]');
  await page.wait(
    `document.querySelector('[data-testid="flow-goal-active"]') !== null &&
      document.querySelector('[data-testid="cancel-flow-goal"]') !== null`,
    "the working goal interview panel",
  );
  check(
    !(await page.eval<boolean>(`document.querySelector('[data-testid="cancel-flow-goal"]').disabled`)),
    "the cancel control is disabled while the interview works",
  );
  await page.click('[data-testid="cancel-flow-goal"]');
  await page.wait(
    `document.querySelector('[data-testid="flow-goal-active"]') === null &&
      document.querySelector('[data-testid="flow-goal-onboarding"]') !== null &&
      document.querySelector('[data-testid="flow-goal-state"]')?.textContent?.trim() === "No goal yet"`,
    "the empty Flow goal after canceling a working interview",
  );
  check(
    !(await page.eval<boolean>(`document.querySelector('[data-testid="flow-error"]') !== null`)),
    "canceling a working goal interview reported an error",
  );

  // Cancel while a question waits: its panel and question disappear at once.
  await rm(flowGoalGate, { force: true });
  await page.click('[data-testid="create-flow-goal"]');
  await page.wait(
    `document.querySelector('[data-testid="flow-goal-question"]') !== null &&
      document.querySelector('[data-testid="cancel-flow-goal"]') !== null`,
    "the waiting goal question with a cancel control",
  );
  check(
    !(await page.eval<boolean>(`document.querySelector('[data-testid="cancel-flow-goal"]').disabled`)),
    "the cancel control is disabled while a goal question waits",
  );
  await page.click('[data-testid="cancel-flow-goal"]');
  await page.wait(
    `document.querySelector('[data-testid="flow-goal-question"]') === null &&
      document.querySelector('[data-testid="flow-goal-active"]') === null &&
      document.querySelector('[data-testid="flow-goal-onboarding"]') !== null`,
    "the empty Flow goal after canceling a waiting question",
  );
  check(
    !(await page.eval<boolean>(`document.querySelector('[data-testid="flow-error"]') !== null`)),
    "canceling a waiting goal question reported an error",
  );

  // The seeded saved-goal session arrives once the dashboard restores it.
  await stopServer();
  await seedFlow(stateDir, host);
  startServer();
  await waitForHttp(baseUrl);
  await page.reload();
  await runPalette("open.flow.overview");
  await page.wait(
    `document.querySelector('[data-testid="flow-goal-text"]')?.textContent?.includes("Seeded flow goal") === true`,
    "the seeded saved Flow goal",
  );

  const flowSurfaces = await page.eval<Record<string, boolean>>(`(() => {
    const has = (testid) => document.querySelector('[data-testid="' + testid + '"]') !== null;
    return {
      pr: has("flow-pr-section"),
      widgets: has("flow-widgets-section"),
      files: has("flow-files-section"),
      bar: document.querySelectorAll('#workspace-flow [data-testid="agent-activity-bar"]').length === 1,
      removed:
        has("flow-status") || has("flow-activity-section") || has("flow-activity") ||
        has("flow-goal-activity") || has("flow-conversation-activity"),
    };
  })()`);
  check(
    flowSurfaces.pr && flowSurfaces.widgets && flowSurfaces.files && flowSurfaces.bar,
    "a Flow surface or the activity bar is missing",
    flowSurfaces,
  );
  check(!flowSurfaces.session, "the removed Flow session facts panel is still rendered", flowSurfaces);
  check(!flowSurfaces.removed, "a removed Flow activity surface is still rendered", flowSurfaces);
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
  const flowData = await page.eval<{
    status: string;
    pr: string;
    widgets: number;
    files: number;
    checkpoints: number;
    blockers: number;
    readyEnabled: boolean;
  }>(`(() => ({
    status: document.querySelector('[data-testid="flow-view"]')?.getAttribute("data-status") ?? "",
    pr: document.querySelector('[data-testid="flow-pr"]')?.getAttribute("data-state") ?? "",
    widgets: document.querySelectorAll('[data-testid="flow-widget"]').length,
    files: document.querySelectorAll('[data-testid="flow-file"]').length,
    checkpoints: document.querySelectorAll('[data-testid="flow-checkpoints"]').length,
    blockers: document.querySelectorAll('[data-testid="flow-blocker"]').length,
    readyEnabled: !(document.querySelector('[data-testid="mark-flow-pr-ready"]')?.disabled ?? true),
  }))()`);
  check(flowData.status === "stopped" && flowData.pr === "draft", "the Flow session is not restored", flowData);
  check(flowData.widgets === 1 && flowData.files === 1 && flowData.blockers === 1 && flowData.readyEnabled, "Flow data surfaces are incomplete", flowData);
  check((await sourceOnlyMarkers(page)) === 0, "the Flow surface renders a source-only marker");
  const flowVerification = await page.eval<{ status: string; text: string; tone: string }>(`(() => {
    const panel = document.querySelector('[data-testid="flow-verification"]');
    const badge = panel?.querySelector(".badge");
    return {
      status: panel?.getAttribute("data-status") ?? "",
      text: badge?.textContent?.trim() ?? "",
      tone: badge?.getAttribute("data-tone") ?? "",
    };
  })()`);
  check(
    flowVerification.status === "not-run" && flowVerification.text === "not-run" && flowVerification.tone === "warning",
    "the Verification badge does not read an unrun check as pending",
    flowVerification,
  );

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
  const fileVerification = await page.eval<{ text: string; tone: string }>(`(() => {
    const badge = document.querySelector('[data-testid="flow-file-verification"]');
    return { text: badge?.textContent?.trim() ?? "", tone: badge?.getAttribute("data-tone") ?? "" };
  })()`);
  check(
    fileVerification.text === "not-run" && fileVerification.tone === "warning",
    "the focused-file badge does not read an unrun check as pending",
    fileVerification,
  );
  await page.click('[data-testid="close-flow-diff"]');
  await page.wait(
    `document.querySelector('[data-testid="flow-diff"]') === null`,
    "the diff page to close",
  );

  await runPalette("flow.checkpoint.open.cp-1");
  await page.wait(`document.querySelector('[data-testid="flow-checkpoint"]') !== null`, "the Flow checkpoint tab");
  const checkpoint = await page.eval<string>(`document.querySelector('[data-testid="flow-checkpoint"]')?.textContent ?? ""`);
  check(checkpoint.includes("abcdef1"), "the checkpoint lost its commit", checkpoint);
  const checkpointVerification = await page.eval<{ text: string; tone: string }>(`(() => {
    const badge = document.querySelector('[data-testid="flow-checkpoints"] .badge');
    return { text: badge?.textContent?.trim() ?? "", tone: badge?.getAttribute("data-tone") ?? "" };
  })()`);
  check(
    checkpointVerification.text === "not-run" && checkpointVerification.tone === "warning",
    "the Checkpoint badge does not read an unrun check as pending",
    checkpointVerification,
  );
  await runPalette("open.flow.steering");
  await page.wait(`document.querySelector('[data-testid="flow-steering-note"]') !== null`, "the Flow steering note");

  await runPalette("open.flow.overview");
  await page.wait(`document.querySelector('[data-testid="dismiss-flow-blocker"]') !== null`, "the Flow blocker control");
  const flowGoalSurface = await page.eval<{
    tag: string;
    collapsed: string;
    sidebar: number;
    goalTop: number;
    pageTop: number;
    goalHeight: number;
    pageHeight: number;
    startPadding: string;
  }>(`(() => {
    const goal = document.querySelector('#workspace-flow [data-testid="flow-goal"]');
    const page = document.querySelector('#workspace-flow .flow-overview');
    const start = document.querySelector('[data-testid="start-flow-implementation"]');
    const text = document.querySelector('[data-testid="flow-goal-text"]');
    const goalBox = goal?.getBoundingClientRect();
    const pageBox = page?.getBoundingClientRect();
    return {
      tag: text?.tagName ?? "",
      collapsed: goal?.getAttribute("data-collapsed") ?? "",
      sidebar: document.querySelectorAll('[data-testid="sidebar"] [data-command="open.flow.flow-goal"]').length,
      goalTop: Math.round(goalBox?.top ?? -1),
      pageTop: Math.round(pageBox?.top ?? -1),
      goalHeight: Math.round(goalBox?.height ?? 0),
      pageHeight: Math.round(pageBox?.height ?? 0),
      startPadding: start === null ? "" : getComputedStyle(start).paddingLeft,
    };
  })()`);
  check(flowGoalSurface.tag === "PRE" && flowGoalSurface.collapsed === "false", "the Flow overview does not hold the read-only goal", flowGoalSurface);
  check(flowGoalSurface.sidebar === 0, "the Flow goal is still a separate sidebar entry", flowGoalSurface);
  check(Math.abs(flowGoalSurface.goalTop - flowGoalSurface.pageTop) <= 1, "the Flow goal does not lead the overview", flowGoalSurface);
  check(flowGoalSurface.goalHeight >= flowGoalSurface.pageHeight - 1, "the Flow goal does not fill the page", flowGoalSurface);
  check(
    flowGoalSurface.startPadding === "10px",
    "a Flow action does not use the design-system horizontal padding",
    flowGoalSurface.startPadding,
  );
  const flowGoalText = await page.eval<string>(`document.querySelector('[data-testid="flow-goal-text"]')?.textContent ?? ""`);
  check(
    flowGoalText === "# Seeded flow goal\n\nExercise the Flow workspace.",
    "the Flow goal does not show the session goal bytes",
    flowGoalText,
  );
  const flowGoalHeader = await page.eval<{
    state: string;
    badge: boolean;
    tone: string;
    headerHeight: number;
    aligned: boolean;
    chrome: number;
  }>(`(() => {
    const state = document.querySelector('[data-testid="flow-goal-state"]');
    const header = state?.closest(".flow-goal__header");
    const title = header?.querySelector(".flow-goal__title");
    const text = document.querySelector('[data-testid="flow-goal-text"]');
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
      chrome: text?.querySelectorAll("textarea, input, [contenteditable], .monaco-editor").length ?? -1,
    };
  })()`);
  check(
    flowGoalHeader.state === "Saved" && flowGoalHeader.badge && flowGoalHeader.tone === "success",
    "the Flow goal header does not state its saved state",
    flowGoalHeader,
  );
  check(
    flowGoalHeader.headerHeight === 44 && flowGoalHeader.aligned && flowGoalHeader.chrome === 0,
    "the Flow goal header is not one read-only row",
    flowGoalHeader,
  );
  const flowLabel = await page.eval<string>(`document.querySelector('[data-testid="flow-goal-text"]')?.getAttribute("aria-label") ?? ""`);
  check(flowLabel.length > 0, "the Flow goal has no accessible label", flowLabel);
  check(
    (await page.eval<number>(`document.querySelectorAll('[data-testid="save-flow-goal"]').length`)) === 0,
    "the Save flow goal control still exists",
  );
  check(
    (await page.eval<string>(`document.querySelector('[data-testid="create-flow-goal"]')?.getAttribute("data-command") ?? ""`)) ===
      "flow.goal.create",
    "the Create flow goal control is missing",
  );

  // The saved goal keeps the full-height read-only editor in both themes.
  await setTheme(page, "light");
  const savedLight = await measureFlowGoal(page);
  check(
    savedLight.goalText && !savedLight.cancel && savedLight.onboarding === null,
    "the saved Flow goal renders the wrong panel",
    savedLight,
  );
  check(savedLight.state === "Saved", "the saved Flow goal header is not 'Saved'", savedLight);
  check(savedLight.createActions === 1, "the saved header does not hold exactly one goal action", savedLight);
  check(
    savedLight.goalHeight >= savedLight.pageHeight - 1,
    "the saved Flow goal does not fill the page",
    savedLight,
  );
  await setTheme(page, "dark");
  const savedDark = await measureFlowGoal(page);
  check(
    savedDark.goalText &&
      savedDark.state === "Saved" &&
      savedDark.goalHeight >= savedDark.pageHeight - 1,
    "the saved Flow goal does not fill the page in the dark theme",
    savedDark,
  );
  await setTheme(page, "light");

  // Re-create and cancel: the accepted bytes and the Saved header return.
  const seededGoalPath = join(stateDir, "flow", journalKey(host), "seed", "goal.md");
  const seededBytes = await readFile(seededGoalPath, "utf8");
  await page.click('[data-testid="create-flow-goal"]');
  await page.wait(
    `document.querySelector('[data-testid="flow-goal-question"]') !== null &&
      document.querySelector('[data-testid="cancel-flow-goal"]') !== null`,
    "the re-created goal question",
  );
  check(
    !(await page.eval<boolean>(`document.querySelector('[data-testid="cancel-flow-goal"]').disabled`)),
    "the cancel control is disabled during a re-created interview",
  );
  await page.click('[data-testid="cancel-flow-goal"]');
  await page.wait(
    `document.querySelector('[data-testid="flow-goal-active"]') === null &&
      document.querySelector('[data-testid="flow-goal-state"]')?.textContent?.trim() === "Saved" &&
      document.querySelector('[data-testid="flow-goal-text"]')?.textContent?.includes("Exercise the Flow workspace.") === true`,
    "the restored saved Flow goal after cancel",
  );
  check(
    !(await page.eval<boolean>(`document.querySelector('[data-testid="flow-error"]') !== null`)),
    "canceling a re-created goal reported an error",
  );
  check(
    (await readFile(seededGoalPath, "utf8")) === seededBytes,
    "canceling a re-created goal changed goal.md",
  );

  await page.click('[data-testid="dismiss-flow-blocker"]');
  await page.wait(`document.querySelector('[data-testid="flow-blocker"]')?.getAttribute("data-dismissed") === "true"`, "the dismissed blocker");
  await page.click('[data-testid="sidebar"] [data-command="flow.blocker.open.block-1"]');
  await page.wait(
    `document.activeElement?.id === "flow-blocker-block-1"`,
    "the sidebar blocker did not open its row",
  );

  await runPalette("open.flow.decisions");
  await page.wait(`document.querySelector('[data-testid="flow-decisions"]') !== null`, "the Flow decision board");
  const decisionState = await page.eval<{
    tag: string;
    state: string;
    badge: boolean;
    tone: string;
    headerHeight: number;
    aligned: boolean;
    startPadding: string;
    chrome: number;
  }>(`(() => {
    const text = document.querySelector('[data-testid="flow-decisions"]');
    const state = document.querySelector('[data-testid="flow-decisions-state"]');
    const header = state?.closest(".flow-decisions__header");
    const title = header?.querySelector(".flow-decisions__title");
    const center = (element) => {
      const box = element?.getBoundingClientRect();
      return box === undefined ? Number.NaN : box.top + box.height / 2;
    };
    return {
      tag: text?.tagName ?? "",
      state: state?.textContent?.trim() ?? "",
      badge: state?.classList.contains("badge") ?? false,
      tone: state?.getAttribute("data-tone") ?? "",
      headerHeight: Math.round(header?.getBoundingClientRect().height ?? 0),
      aligned: Math.abs(center(state) - center(title)) <= 1,
      startPadding: header ? getComputedStyle(header).paddingLeft : "",
      chrome: text?.querySelectorAll("textarea, input, [contenteditable], .monaco-editor").length ?? -1,
    };
  })()`);
  check(decisionState.tag === "PRE", "the decision board is not a read-only PRE", decisionState);
  check(
    decisionState.state === "Saved" && decisionState.badge && decisionState.tone === "success",
    "the decision board header does not state its saved state",
    decisionState,
  );
  check(
    decisionState.headerHeight === 44 && decisionState.aligned &&
      decisionState.startPadding === "12px" && decisionState.chrome === 0,
    "the decision board header is not a read-only row",
    decisionState,
  );
  const decisionLabel = await page.eval<string>(`document.querySelector('[data-testid="flow-decisions"]')?.getAttribute("aria-label") ?? ""`);
  check(decisionLabel.length > 0, "the decision board has no accessible label", decisionLabel);
  check(
    (await page.eval<number>(`document.querySelectorAll('[data-testid="save-flow-decisions"]').length`)) === 0,
    "the Save Flow decisions control still exists",
  );
  const seededDecisions = await page.eval<string>(`document.querySelector('[data-testid="flow-decisions"]')?.textContent ?? ""`);
  check(
    seededDecisions === "# Decisions\n\n- Seeded decision.",
    "the decision board does not show decisions.md",
    seededDecisions,
  );

  // A decision the server appends while work proceeds appears and survives reload.
  const appendResult = await page.eval<{ started: boolean; appended: boolean; types: string[] }>(`(async () => {
    const socket = new WebSocket("ws://" + location.host + "/ws");
    const events = [];
    socket.onmessage = (event) => {
      try { events.push(JSON.parse(String(event.data))); } catch (error) { /* ignored */ }
    };
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const until = (predicate, timeout) => new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (predicate()) { clearInterval(timer); resolve(true); return; }
        if (Date.now() - started > timeout) { clearInterval(timer); resolve(false); }
      }, 20);
    });
    socket.send(JSON.stringify({ type: "openFlowWidget", id: "widget-1" }));
    const started = await until(
      () => events.some((event) => event.type === "flowConversationStarted"),
      15_000,
    );
    socket.send(JSON.stringify({ type: "sendFlowConclusion", text: "Server appended decision." }));
    const appended = await until(
      () => events.some(
        (event) => event.type === "flowDecisions" &&
          String(event.text).includes("Server appended decision."),
      ),
      15_000,
    );
    socket.send(JSON.stringify({ type: "closeFlowWidget" }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    socket.close();
    return { started, appended, types: events.map((event) => event.type) };
  })()`);
  check(
    appendResult.started && appendResult.appended,
    "the server did not append the widget conclusion",
    appendResult,
  );
  await runPalette("open.flow.decisions");
  await page.wait(
    `(document.querySelector('[data-testid="flow-decisions"]')?.textContent ?? "").includes("Server appended decision.")`,
    "the server-appended decision",
  );
  const appended = await page.eval<string>(`document.querySelector('[data-testid="flow-decisions"]')?.textContent ?? ""`);
  check(appended.startsWith(seededDecisions) && appended.includes("## "), "the appended decision replaced developer text", appended);
  await page.reload();
  await runPalette("open.flow.decisions");
  await page.wait(
    `(document.querySelector('[data-testid="flow-decisions"]')?.textContent ?? "").includes("Server appended decision.")`,
    "the server-appended decision after reload",
  );
  check(
    (await page.eval<string>(`document.querySelector('[data-testid="flow-decisions-state"]')?.textContent?.trim() ?? ""`)) ===
      "Saved",
    "the reloaded decision board is not read-only saved",
  );
  const framesBeforeDecisionKey = await page.eval<number>("window.__viFrames.length");
  await page.key("s", 2);
  await delay(150);
  check(
    (await page.eval<number>("window.__viFrames.length")) === framesBeforeDecisionKey,
    "Ctrl+S sent a frame from the read-only decision board",
  );
  check(
    (await page.eval<string>(`document.querySelector('[data-testid="flow-decisions"]')?.textContent ?? ""`)).includes(
      "Server appended decision.",
    ),
    "Ctrl+S changed the decision board",
  );

  await runPalette("tab.close.flow.decisions");
  await page.wait(`document.querySelector('[data-testid="flow-decisions"]') === null`, "the closed decision board");
  check(
    (await page.eval<boolean>(`document.querySelector('[data-testid="confirm-close-tab"]') !== null`)) === false,
    "closing the read-only decision board asked to discard changes",
  );
  await runPalette("open.flow.decisions");
  await page.wait(
    `(document.querySelector('[data-testid="flow-decisions"]')?.textContent ?? "").includes("Server appended decision.")`,
    "the reopened decision board",
  );

  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the desktop viewport after Flow");

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
    definitionText: string;
    definitionBelowTitle: boolean;
    dirtyBadges: number;
    evidence: number;
    confidence: number;
    fieldHeaders: number;
    innerScrollers: number;
    clippedCards: number;
    stackLinks: number;
    stackHref: string;
    stackTexts: string[];
    platformFacts: Record<string, string>;
    commandHeaders: number;
    contextHeader: string;
    contextRows: number;
    boundaryFacts: number;
    sharedKernelTitle: string;
    sharedKernelChips: number;
    sharedKernelTexts: string[];
    externalBoundaryTitle: string;
    externalBoundaryChips: number;
    externalBoundaryTexts: string[];
    stackedSections: number;
    staticText: number;
    sidebarTitle: string;
    sidebarHeader: boolean;
    commandChips: number;
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
    const stackTexts = card === null
      ? []
      : [...card.querySelectorAll('.code-chip')].map((chip) => chip.textContent.trim());
    const platform = document.querySelector('#workspace-discover [data-field="runtime"]');
    const platformFacts = platform === null
      ? {}
      : Object.fromEntries([...platform.querySelectorAll('.discover-fact')].map((fact) => [
        fact.querySelector('dt')?.textContent?.trim() ?? "",
        fact.querySelector('dd')?.textContent?.trim() ?? "",
      ]));
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
      definitionText: document.querySelector('#workspace-discover .discover-head__definition')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      definitionBelowTitle: (() => {
        const title = document.querySelector('#workspace-discover .discover-head__title');
        const definition = document.querySelector('#workspace-discover .discover-head__definition');
        if (title === null || definition === null) return false;
        return definition.getBoundingClientRect().top >= title.getBoundingClientRect().bottom - 1;
      })(),
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
      stackTexts,
      platformFacts,
      commandHeaders: document.querySelectorAll('[data-testid="discover-command-list"] thead').length,
      contextHeader: document.querySelector('#workspace-discover [data-field="architecture"] th')?.textContent?.trim() ?? "",
      contextRows: document.querySelectorAll('#workspace-discover [data-testid="discover-contexts"] .discover-context').length,
      boundaryFacts: document.querySelectorAll('#workspace-discover [data-field="architecture"] .discover-fact').length,
      sharedKernelTitle: document.querySelector('#workspace-discover [data-field="shared-kernels"] .panel__title')?.textContent?.trim() ?? "",
      sharedKernelChips: document.querySelectorAll('#workspace-discover [data-testid="discover-shared-kernels"] code.code-chip').length,
      sharedKernelTexts: [...document.querySelectorAll('#workspace-discover [data-testid="discover-shared-kernels"] code.code-chip')]
        .map((chip) => chip.textContent.trim()),
      externalBoundaryTitle: document.querySelector('#workspace-discover [data-field="external-boundaries"] .panel__title')?.textContent?.trim() ?? "",
      externalBoundaryChips: document.querySelectorAll('#workspace-discover [data-testid="discover-external-boundaries"] code.code-chip').length,
      externalBoundaryTexts: [...document.querySelectorAll('#workspace-discover [data-testid="discover-external-boundaries"] code.code-chip')]
        .map((chip) => chip.textContent.trim()),
      stackedSections: document.querySelectorAll('#workspace-discover [data-field="unknowns"], #workspace-discover [data-field="dependencyMap"]').length,
      staticText: document.querySelectorAll('#workspace-discover [data-tab="overview"] .discover-lead, #workspace-discover [data-tab="overview"] .discover-note').length,
      sidebarTitle: document.querySelector('[data-testid="sidebar"] .sidebar__title')?.textContent?.trim() ?? "",
      sidebarHeader: document.querySelector('[data-testid="sidebar"] .sidebar__header') !== null,
      commandChips: document.querySelectorAll('[data-testid="discover-command-list"] code.code-chip').length,
      contextPathChips: document.querySelectorAll('#workspace-discover [data-testid="discover-contexts"] .discover-context__head code').length,
      sectionsHeading: sections === null ? -1 : sections.querySelectorAll('.sidebar-group__title').length,
      sectionTabs: sections === null ? -1 : sections.querySelectorAll('[data-testid="discover-tab"]').length,
      skillTabs: skills === null ? -1 : skills.querySelectorAll('[data-testid="discover-tab"]').length,
      sidebarFreshness: document.querySelector('[data-testid="sidebar"] section[aria-label="Freshness"]') !== null,
    };
  })()`);
  await page.wait(
    `document.querySelector('[data-testid="discover-shared-kernels"] code.code-chip') !== null`,
    "the shared kernel chips",
  );
  check(discoverTables.cards >= 5, "Discover sections are missing from the overview", discoverTables);
  check(discoverTables.commands > 0, "the Discover command table is empty", discoverTables);
  check(discoverTables.commandText.every((text) => text.replace(/[|\s]/g, "").length > 0), "a Discover command row renders no values", discoverTables.commandText);
  check(discoverTables.pyramid > 0, "the Discover testing tables are empty", discoverTables);
  check(!discoverTables.suite, "the removed whole-suite line is still rendered", discoverTables);
  check(discoverTables.pyramidText.every((text) => text.replace(/[|\s]/g, "").length > 0), "a Discover pyramid row renders no values", discoverTables.pyramidText);
  check(discoverTables.pyramidText.every((text) => !text.toLowerCase().includes("unknown")), "a Discover test level still reports an unknown count", discoverTables.pyramidText);
  check(
    discoverTables.qualityGateHeaders.length === 0,
    "the quality gate table still renders column headers",
    discoverTables.qualityGateHeaders,
  );
  check(
    discoverTables.qualityGateRows.length > 0 &&
      discoverTables.qualityGateRows.every((cells) =>
        cells.length === 1 && cells[0]?.trim().length > 0
      ),
    "a quality gate row does not render exactly one name",
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
  check(
    discoverTables.stackTexts.join(",") === "Bun,TypeScript",
    "a stack chip still carries the version the crawl recorded",
    discoverTables.stackTexts,
  );
  check(
    discoverTables.platformFacts.Languages === "TypeScript" &&
      discoverTables.platformFacts.Runtimes === "Bun",
    "a Platform fact still carries the version the crawl recorded",
    discoverTables.platformFacts,
  );
  check(discoverTables.stackedSections === 0, "Discover still renders the duplicated dependency or unknown sections", discoverTables.stackedSections);
  check(
    discoverTables.definitionText ===
      "A fixture host with a small order domain used to verify the Discover crawl.",
    "the Discover header does not render the project definition",
    discoverTables.definitionText,
  );
  check(
    discoverTables.definitionBelowTitle,
    "the Discover definition does not sit below the project title",
    discoverTables,
  );
  check(discoverTables.staticText === 0, "Discover still renders static lead or note prose", discoverTables.staticText);
  check(discoverTables.commandHeaders === 0, "the command table still renders a header row", discoverTables.commandHeaders);
  check(discoverTables.contextHeader === "", "the bounded-context card still renders a table header", discoverTables.contextHeader);
  check(discoverTables.contextRows > 0, "the bounded-context list is empty", discoverTables);
  check(discoverTables.boundaryFacts === 0, "the removed boundary facts line is still rendered", discoverTables);
  check(discoverTables.externalBoundaryTitle === "External boundaries", "external boundaries is not a separate Discover widget", discoverTables.externalBoundaryTitle);
  check(discoverTables.externalBoundaryChips === 2, "the External boundaries widget does not render one chip per system", discoverTables.externalBoundaryChips);
  check(
    JSON.stringify(discoverTables.externalBoundaryTexts) ===
      JSON.stringify(["PostgreSQL", "api.stripe.com"]),
    "the External boundaries widget does not render the recorded systems",
    discoverTables.externalBoundaryTexts,
  );
  check(!(discoverTables.externalBoundaryTexts.join("")).includes("node:"), "the External boundaries block names a runtime built-in", discoverTables.externalBoundaryTexts);
  check(discoverTables.sharedKernelTitle === "Shared kernels", "shared kernels is not a separate Discover widget", discoverTables.sharedKernelTitle);
  check(discoverTables.sharedKernelChips === 1, "the Shared kernels widget does not render one chip per kernel", discoverTables.sharedKernelChips);
  check(
    JSON.stringify(discoverTables.sharedKernelTexts) === JSON.stringify(["src/shared"]),
    "the Shared kernels widget does not render the recorded kernel",
    discoverTables.sharedKernelTexts,
  );
  check(!discoverTables.sidebarHeader, "the sidebar still repeats the mode and project header", discoverTables);
  check(
    discoverTables.commandChips === discoverTables.commands,
    "a command row is not drawn with the shared code chip",
    discoverTables,
  );
  check(discoverTables.contextPathChips === 0, "a bounded context still renders its repository path", discoverTables);
  check(discoverTables.sectionsHeading === 0, "the sidebar still renders a Sections heading", discoverTables.sectionsHeading);
  check(discoverTables.sectionTabs === 3 && discoverTables.skillTabs === 6, "the sidebar does not split sections from skills", discoverTables);
  check(!discoverTables.sidebarFreshness, "the sidebar still renders a freshness group");
  const discoverChrome = await page.eval<{
    eyebrow: boolean;
    stale: boolean;
    railLeft: number;
    railWidth: number;
    columnLeft: number;
    headers: string[];
    subtitle: string;
    rows: number;
    versions: boolean;
    levelCommand: string;
    levelChips: number;
    statLabels: string[];
  }>(`(() => {
    const head = document.querySelector('#workspace-discover .discover-head');
    const sheet = document.querySelector('[data-testid="discover-sheet"]');
    const rail = sheet?.querySelector('.discover-rail');
    const column = sheet?.querySelector('.discover-col');
    const testing = document.querySelector('#workspace-discover [data-field="testing"]');
    const statLabels = [...(testing?.querySelectorAll('.discover-stat__label') ?? [])]
      .map((label) => label.textContent?.trim() ?? "");
    const commandCell = testing?.querySelector('[data-testid="discover-pyramid"] tbody td code.code-chip');
    return {
      eyebrow: head?.querySelector('.discover-page__eyebrow') !== null,
      stale: document.querySelector('[data-testid="discover-stale"]') !== null,
      railLeft: Math.round(rail?.getBoundingClientRect().left ?? -1),
      railWidth: Math.round(rail?.getBoundingClientRect().width ?? -1),
      columnLeft: Math.round(column?.getBoundingClientRect().left ?? -1),
      headers: [...document.querySelectorAll('[data-testid="discover-pyramid"] thead th')]
        .map((header) => header.textContent.trim()),
      subtitle: testing?.querySelector('.panel__subtitle')?.textContent?.replace(/\\s+/g, " ").trim() ?? "",
      rows: document.querySelectorAll('[data-testid="discover-pyramid"] tbody tr').length,
      versions: [...document.querySelectorAll('#workspace-discover [data-field="runtime"] dt')]
        .some((term) => term.textContent.trim() === "Versions"),
      levelCommand: commandCell?.textContent?.trim() ?? "",
      levelChips: testing?.querySelectorAll('[data-testid="discover-pyramid"] tbody td code.code-chip').length ?? 0,
      statLabels,
    };
  })()`);
  check(!discoverChrome.eyebrow && !discoverChrome.stale, "the sheet still renders removed masthead chrome", discoverChrome);
  check(discoverChrome.railLeft < discoverChrome.columnLeft, "the sheet column is not to the right of the facts rail", discoverChrome);
  check(
    discoverChrome.railWidth >= 320,
    "the Discover facts rail is narrower than its approved track",
    discoverChrome,
  );
  check(
    discoverChrome.headers.join("|") === "Level|Tests|Command",
    "the test level table does not carry its level, test count, and command columns",
    discoverChrome.headers,
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
    discoverChrome.statLabels.length === 1 &&
      (discoverChrome.statLabels[0] === "test" || discoverChrome.statLabels[0] === "tests"),
    "the testing summary does not list exactly the test total",
    discoverChrome.statLabels,
  );
  check(
    discoverChrome.subtitle.startsWith(`${discoverChrome.rows} level`) &&
      !discoverChrome.subtitle.includes("0 tests"),
    "the level count disagrees with the listed levels",
    discoverChrome,
  );
  check(!discoverChrome.versions, "the Platform rail still repeats the runtime versions", discoverChrome);

  // Every existing checkout path the Overview renders hands off to VS Code.
  const overviewLinks = await page.eval<{
    file: string;
    manifest: string;
    directory: string;
    anchors: number;
    hrefs: string[];
    stackLinks: number;
    stackHrefs: Array<string | null>;
    plainKernel: boolean;
    kernelHasHref: boolean;
    commandAnchors: number;
    boundaryAnchors: number;
    levelAnchors: number;
    directionAnchors: number;
    location: string;
  }>(`(() => {
    const panel = document.querySelector('#workspace-discover [data-testid="discover-panel"][data-tab="overview"]');
    const links = [...panel.querySelectorAll('a[href^="vscode://"]')];
    const mapped = (text) => {
      const anchor = links.find((entry) => entry.textContent.trim() === text);
      if (anchor === undefined) return "";
      const href = anchor.getAttribute("href") ?? "";
      return href.startsWith("vscode://file/")
        ? decodeURIComponent(href.slice("vscode://file/".length))
        : "";
    };
    const kernels = panel.querySelector('[data-testid="discover-shared-kernels"]');
    const kernel = kernels === null
      ? null
      : [...kernels.querySelectorAll(".code-chip")].find((chip) => chip.textContent.trim() === "src/shared") ?? null;
    const stack = panel.querySelector('[data-field="stack"]');
    const anchorsIn = (selector) => {
      const scope = panel.querySelector(selector);
      return scope === null ? 0 : scope.querySelectorAll('a[href^="vscode://"]').length;
    };
    return {
      file: mapped("src/checkout/flow.ts"),
      manifest: mapped("package.json"),
      directory: mapped("src"),
      anchors: links.length,
      hrefs: links.map((entry) => entry.getAttribute("href")),
      stackLinks: stack === null ? 0 : stack.querySelectorAll("a.code-chip--link").length,
      stackHrefs: stack === null
        ? []
        : [...stack.querySelectorAll("a.code-chip--link")].map((entry) => entry.getAttribute("href")),
      plainKernel: kernel !== null && kernel.tagName === "CODE",
      kernelHasHref: kernel !== null && kernel.hasAttribute("href"),
      commandAnchors: anchorsIn('[data-field="commands"]'),
      boundaryAnchors: anchorsIn('[data-field="external-boundaries"]'),
      levelAnchors: anchorsIn('[data-field="testing"]'),
      directionAnchors: panel.querySelectorAll('[data-field="architecture"] .discover-facts a[href^="vscode://"]').length,
      location: location.href,
    };
  })()`);
  const fixtureCheckout = resolve(host);
  check(
    overviewLinks.file === join(fixtureCheckout, "src", "checkout", "flow.ts"),
    "the Overview entry point does not hand off its file to VS Code",
    overviewLinks,
  );
  check(
    overviewLinks.manifest === join(fixtureCheckout, "package.json"),
    "the Overview manifest does not hand off its file to VS Code",
    overviewLinks,
  );
  check(
    overviewLinks.directory === join(fixtureCheckout, "src"),
    "the Overview entry point does not hand off its directory to VS Code",
    overviewLinks,
  );
  check(
    overviewLinks.anchors === 3,
    "the Overview links a reference that is not an existing checkout path",
    overviewLinks.hrefs,
  );
  check(
    overviewLinks.stackLinks === 1 &&
      (overviewLinks.stackHrefs[0] ?? "").startsWith("https://github.com/"),
    "a stack chip lost its repository link",
    overviewLinks,
  );
  check(
    overviewLinks.plainKernel && !overviewLinks.kernelHasHref,
    "the missing shared kernel renders as a link",
    overviewLinks,
  );
  check(
    overviewLinks.commandAnchors === 0 &&
      overviewLinks.boundaryAnchors === 0 &&
      overviewLinks.levelAnchors === 0 &&
      overviewLinks.directionAnchors === 0,
    "a command, boundary, level, or dependency-direction value became a link",
    overviewLinks,
  );
  // Activating the link would raise Chrome's external-protocol prompt, which
  // owns the window and makes the page inert for the rest of this gate. The
  // capture listener records the URL the click requests and cancels the OS
  // handoff; the operator walkthrough proves that handoff opens VS Code.
  const activation = await page.eval<{
    requested: string;
    target: string;
    location: string;
  }>(`(() => {
    const link = [...document.querySelectorAll('#workspace-discover [data-tab="overview"] a[href^="vscode://"]')]
      .find((entry) => entry.textContent.trim() === "src/checkout/flow.ts");
    if (link === undefined) return { requested: "missing", target: "missing", location: location.href };
    let requested = "";
    const capture = (event) => {
      requested = event.target instanceof Element
        ? event.target.getAttribute("href") ?? ""
        : "";
      event.preventDefault();
    };
    document.addEventListener("click", capture, { capture: true, once: true });
    link.click();
    document.removeEventListener("click", capture, { capture: true });
    return { requested, target: link.getAttribute("href") ?? "", location: location.href };
  })()`);
  check(
    activation.requested === activation.target &&
      activation.requested.startsWith("vscode://file/"),
    "activating a file link did not request its VS Code URL",
    activation,
  );
  check(
    activation.location === overviewLinks.location,
    "activating a file link navigated the dashboard away",
    activation,
  );

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

  // An agent page is a workspace, not a sheet: it takes the window's full
  // height, and the read-only prompt absorbs what the header and activity
  // leave, so the lower half of the window is never empty.
  const agentTab = '[data-testid="discover-agent-tab"]';
  await page.click(agentTab);
  await page.wait(
    `document.querySelector('[data-testid="discover-agent-prompt-text"]') !== null`,
    "the Discover agent prompt text",
  );
  const agentFill = await page.eval<{
    pageScroll: number;
    pageClient: number;
    contentGap: number;
    editorHeight: number;
  }>(`(() => {
    const page = document.querySelector('#workspace-discover .discover-agent');
    const prompt = page.querySelector('.discover-agent__prompt');
    const editor = page.querySelector('[data-testid="discover-agent-prompt-text"]');
    const contentBottom = page.getBoundingClientRect().bottom -
      parseFloat(getComputedStyle(page).paddingBottom);
    return {
      pageScroll: page.scrollHeight,
      pageClient: page.clientHeight,
      contentGap: Math.round(contentBottom - prompt.getBoundingClientRect().bottom),
      editorHeight: Math.round(editor.getBoundingClientRect().height),
    };
  })()`);
  check(
    agentFill.pageScroll <= agentFill.pageClient + 1,
    "the agent page overflows the window at its supported size",
    agentFill,
  );
  check(
    Math.abs(agentFill.contentGap) <= 1,
    "the agent page leaves the lower part of the window empty",
    agentFill,
  );
  check(
    agentFill.editorHeight > 220,
    "the read-only prompt does not take the height the agent page leaves",
    agentFill,
  );
  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null`,
    "the Discover overview after the agent page check",
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
  const discoverScrollBefore = await page.eval<{
    top: number;
    scroll: number;
    client: number;
    clipped: number;
    overflow: number[];
  }>(`(() => {
    const scroller = document.querySelector('#workspace-discover .scroll-column');
    if (scroller === null) return { top: 0, scroll: 0, client: 0, clipped: 0, overflow: [0, 0] };
    scroller.scrollTop = 160;
    const bounds = scroller.getBoundingClientRect();
    const clipped = [...scroller.querySelectorAll('a[href^="vscode://"]')].filter((link) => {
      const rect = link.getBoundingClientRect();
      return rect.width > 0 && (rect.right > bounds.right + 0.5 || rect.left < bounds.left - 0.5);
    }).length;
    return {
      top: Math.round(scroller.scrollTop),
      scroll: scroller.scrollHeight,
      client: scroller.clientHeight,
      clipped,
      overflow: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    };
  })()`);
  check(
    discoverScrollBefore.top > 0,
    "the Discover page does not scroll",
    discoverScrollBefore,
  );
  check(
    discoverScrollBefore.clipped === 0 &&
      discoverScrollBefore.overflow[0]! <= discoverScrollBefore.overflow[1]!,
    "a Discover file link overflows its page at 1024×720",
    discoverScrollBefore,
  );
  await page.click('[data-testid="mode-goal"]');
  await page.wait(`document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`, "Goal for the scroll check");

  // A narrow workspace must wrap the page-header actions, never crop one at
  // the right edge: the Start implementation action is the widest row.
  if (!(await page.eval<boolean>(`document.querySelector('[data-testid="lifecycle-control"]') !== null`))) {
    await runPalette("open.goal.overview");
    await page.wait(`document.querySelector('[data-testid="lifecycle-control"]') !== null`, "the Goal overview for the narrow header check");
  }
  await page.focus('[data-testid="pane-handle"]');
  await page.key("End");
  await page.wait(
    `Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width) >= 500`,
    "the widest sidebar for the narrow header check",
  );
  const goalHeader = await page.eval<{
    left: number;
    right: number;
    top: number;
    bottom: number;
    scrollWidth: number;
    clientWidth: number;
    buttons: Array<{ label: string; left: number; right: number; top: number; bottom: number }>;
  } | null>(`(() => {
    const header = document.querySelector('#workspace-goal .page-header');
    if (header === null) return null;
    const rect = header.getBoundingClientRect();
    const actions = header.querySelector('.page-header__actions');
    if (actions === null) return null;
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      scrollWidth: header.scrollWidth,
      clientWidth: header.clientWidth,
      buttons: [...actions.querySelectorAll('button')].map((button) => {
        const box = button.getBoundingClientRect();
        return {
          label: button.textContent.trim(),
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        };
      }),
    };
  })()`);
  check(goalHeader !== null && goalHeader.buttons.length >= 3, "the narrow Goal header lost its actions", goalHeader);
  const header = goalHeader!;
  check(
    header.scrollWidth <= header.clientWidth + 1 &&
      header.buttons.every(
        (button) =>
          button.left >= header.left - 0.5 &&
          button.right <= header.right + 0.5 &&
          button.top >= header.top - 0.5 &&
          button.bottom <= header.bottom + 0.5,
      ),
    "a page-header action is clipped when the workspace is narrow",
    header,
  );
  await page.doubleClick('[data-testid="pane-handle"]');
  await page.wait(
    `Math.abs(Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width) - 300) <= 12`,
    "the default sidebar after the narrow header check",
  );

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

  // Like the Issues overview, the Discover overview names a run in progress.
  // The fixture holds the turn open so the state is observable.
  const discoverIdleBadge = await page.eval<string>(
    `document.querySelector('[data-testid="discover-running"]')?.textContent?.trim() ?? ""`,
  );
  check(discoverIdleBadge === "", "the Discover sidebar shows a running label while idle", discoverIdleBadge);
  await page.click('[data-testid="discover-start"]');
  await page.wait(
    `(() => {
      const badge = document.querySelector('[data-testid="sidebar"] button[data-tab="overview"] [data-testid="discover-running"]');
      return badge?.textContent?.trim() === "running";
    })()`,
    "the running label on the Discover overview",
    15_000,
  );
  const discoverBar = await page.eval<{
    dot: string;
    last: string;
    stop: boolean;
    tag: boolean;
  }>(`(() => ({
    dot: document.querySelector('#workspace-discover [data-testid="agent-activity-dot"]')?.getAttribute('data-state') ?? "",
    last: document.querySelector('#workspace-discover [data-testid="agent-activity-last"]')?.textContent?.trim() ?? "",
    stop: document.querySelector('#workspace-discover [data-testid="discover-stop"]') !== null,
    tag: document.querySelector('[data-testid="discover-run-tag"]') !== null,
  }))()`);
  check(
    discoverBar.dot === "running" && discoverBar.stop && discoverBar.last.length > 0,
    "the Discover activity bar does not follow the run",
    discoverBar,
  );
  check(!discoverBar.tag, "the removed Discover run tag is still rendered", discoverBar);
  await page.wait(
    `(() => {
      const tabs = [...document.querySelectorAll('[data-testid="discover-agent-tab"]')];
      return (
        tabs.length >= 6 &&
        tabs.every((tab) => tab.getAttribute("data-state") === "succeeded") &&
        document.querySelector('#workspace-discover [data-testid="discover-start"]') !== null
      );
    })()`,
    "all six Discover agents to succeed and the start control to return",
    120_000,
  );
  // The server's own snapshot proves every agent finished; a DOM badge can
  // move off the active tab while the run is still advancing.
  await waitDiscoverIdle(port);

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
    tableScrolls: number[];
    clippedCards: number;
    rowsOutside: number;
    searchPadding: string[];
    toolbar: { background: string; border: string };
    floorChip: { fontSize: string; lineHeight: string };
    filterRows: number[];
  }>(`(() => {
    const rows = [...document.querySelectorAll('#workspace-discover [data-testid="discover-term"]')];
    const termCells = rows.map((row) => row.querySelector('td:nth-child(1)'));
    const significanceCells = rows.map((row) => row.querySelector('td:nth-child(2)'));
    const exampleCells = rows.map((row) => row.querySelector('td:nth-child(4)'));
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
      floorChip: (() => {
        const value = document.querySelector('#workspace-discover .discover-floor__value');
        const style = value === null ? null : getComputedStyle(value);
        return { fontSize: style?.fontSize ?? "", lineHeight: style?.lineHeight ?? "" };
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
    glossary.headers.join("|") === "Term|Significance|Definition|",
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
  check(
    Math.abs(Number.parseFloat(glossary.floorChip.fontSize) - 11.5) < 0.05 &&
      Math.abs(Number.parseFloat(glossary.floorChip.lineHeight) - 16.1) < 0.05,
    "the glossary floor chip does not render the mono-small type",
    glossary.floorChip,
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
      significance: rows.map((row) => row.querySelector("td:nth-child(2)")?.textContent?.trim() ?? ""),
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
  await page.click('#workspace-discover [data-testid="discover-term"] td:nth-child(1)');
  await delay(100);
  const stillGlossary = await page.eval<boolean>(
    `document.querySelector('#workspace-discover [data-testid="discover-panel"][data-tab="glossary"]') !== null`,
  );
  check(stillGlossary, "clicking a glossary row navigated away from the table");

  await runPalette("discover.tab.testing-strategy");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"]') !== null`, "the Discover skill text");
  const skillLabel = await page.eval<string>(`document.querySelector('[data-testid="discover-skill-text"]')?.getAttribute("aria-label") ?? ""`);
  check(skillLabel.length > 0, "the skill text has no accessible label", skillLabel);
  const liveSkillPath = join(host, ".omp", "skills", "discover-testing-strategy", "SKILL.md");
  const baselineSkillPath = join(host, ".omp", "discover", "skills", "discover-testing-strategy", "SKILL.md");
  const originalSkill = await readFile(liveSkillPath, "utf8");
  const readSkillStatePill = () =>
    page.eval<{
      count: number;
      word: string;
      tone: string;
      background: string;
      color: string;
      fontSize: string;
      radius: string;
      dot: { width: string; height: string; background: string } | null;
      success: string;
      warning: string;
      error: string;
      successSurface: string;
      warningSurface: string;
      errorSurface: string;
    }>(`(() => {
      const pill = document.querySelector('[data-testid="discover-skill-state"]');
      const dot = pill === null ? null : pill.querySelector('.discover-skill__state-dot');
      const token = (name) => {
        const probe = document.createElement("div");
        probe.style.background = \`var(\${name})\`;
        document.body.append(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
      };
      const pillStyle = pill === null ? null : getComputedStyle(pill);
      const dotStyle = dot === null ? null : getComputedStyle(dot);
      return {
        count: document.querySelectorAll('[data-testid="discover-skill-state"]').length,
        word: pill?.querySelector('.discover-skill__state-word')?.textContent?.trim() ?? "",
        tone: pill?.getAttribute("data-tone") ?? "",
        background: pillStyle?.backgroundColor ?? "",
        color: pillStyle?.color ?? "",
        fontSize: pillStyle?.fontSize ?? "",
        radius: pillStyle?.borderRadius ?? "",
        dot: dotStyle === null ? null : {
          width: dotStyle.width,
          height: dotStyle.height,
          background: dotStyle.backgroundColor,
        },
        success: token("--success"),
        warning: token("--warning"),
        error: token("--error"),
        successSurface: token("--success-surface"),
        warningSurface: token("--warning-surface"),
        errorSurface: token("--error-surface"),
      };
    })()`);
  const skillText = await page.eval<string>(`document.querySelector('[data-testid="discover-skill-text"]')?.textContent ?? ""`);
  check(skillText === originalSkill, "the skill page does not show the live file bytes");
  const generatedPill = await readSkillStatePill();
  check(generatedPill.count === 1, "the skill header does not render exactly one state pill", generatedPill);
  check(
    generatedPill.word === "generated" && generatedPill.tone === "success",
    "the generated skill header does not name its state",
    generatedPill,
  );
  check(
    generatedPill.background === generatedPill.successSurface &&
      generatedPill.color === generatedPill.success &&
      generatedPill.dot?.background === generatedPill.success,
    "the generated skill state is not on the success tint",
    generatedPill,
  );
  check(
    generatedPill.fontSize === "11px" &&
      generatedPill.radius === "999px" &&
      generatedPill.dot?.width === "6px" &&
      generatedPill.dot?.height === "6px",
    "the skill state pill does not take the 11px pill shape with a 6px dot",
    generatedPill,
  );
  check(
    (await page.eval<number>(`document.querySelectorAll('[data-testid="discover-skill-status"]').length`)) === 0,
    "the skill page still names a draft state",
  );
  for (const testid of ["discover-skill-save", "discover-skill-restore", "discover-skill-dirty"]) {
    check(
      (await page.eval<number>(`document.querySelectorAll('[data-testid="${testid}"]').length`)) === 0,
      `${testid} is rendered on the skill page`,
    );
  }
  const skillChrome = await page.eval<number>(`document.querySelector('[data-testid="discover-skill-text"]')?.querySelectorAll("textarea, input, [contenteditable], .monaco-editor").length ?? -1`);
  check(skillChrome === 0, "the skill page holds an editor");
  const framesBeforeSkillKey = await page.eval<number>("window.__viFrames.length");
  await page.key("s", 2);
  await delay(150);
  check(
    (await page.eval<number>("window.__viFrames.length")) === framesBeforeSkillKey,
    "Ctrl+S sent a frame from the read-only skill page",
  );
  check(
    (await readFile(liveSkillPath, "utf8")) === originalSkill,
    "Ctrl+S changed the live skill file",
  );

  // An edited live file names its own state on the warning tint.
  await writeFile(liveSkillPath, `${originalSkill.trimEnd()}\n- Edited for the state pill.\n`);
  await page.reload();
  await runPalette("discover.tab.testing-strategy");
  await page.wait(
    `document.querySelector('[data-testid="discover-tab"][data-skill="discover-testing-strategy"]')?.getAttribute("data-state") === "edited"`,
    "the edited skill state",
  );
  const editedPill = await readSkillStatePill();
  check(
    editedPill.word === "edited" && editedPill.tone === "warning",
    "the edited skill header does not name its state",
    editedPill,
  );
  check(
    editedPill.background === editedPill.warningSurface &&
      editedPill.color === editedPill.warning &&
      editedPill.dot?.background === editedPill.warning,
    "the edited skill state is not on the warning tint",
    editedPill,
  );
  await writeFile(liveSkillPath, originalSkill);
  await page.reload();
  await runPalette("discover.tab.testing-strategy");
  await page.wait(
    `document.querySelector('[data-testid="discover-tab"][data-skill="discover-testing-strategy"]')?.getAttribute("data-state") === "generated"`,
    "the restored generated skill state",
  );

  // A missing live file names its state and renders the generated baseline.
  await rm(liveSkillPath);
  await page.reload();
  await runPalette("discover.tab.testing-strategy");
  await page.wait(
    `document.querySelector('[data-testid="discover-tab"][data-skill="discover-testing-strategy"]')?.getAttribute("data-state") === "missing"`,
    "the missing skill state",
  );
  const baselineSkill = await readFile(baselineSkillPath, "utf8");
  check(
    (await page.eval<string>(`document.querySelector('[data-testid="discover-skill-text"]')?.textContent ?? ""`)) ===
      baselineSkill,
    "the missing skill does not render its generated baseline",
  );
  const missingPill = await readSkillStatePill();
  check(
    missingPill.word === "Live file missing" && missingPill.tone === "error",
    "the missing skill header does not name its state",
    missingPill,
  );
  check(
    missingPill.background === missingPill.errorSurface &&
      missingPill.color === missingPill.error &&
      missingPill.dot?.background === missingPill.error,
    "the missing skill state is not on the error tint",
    missingPill,
  );
  for (const testid of ["discover-skill-save", "discover-skill-restore", "discover-skill-dirty"]) {
    check(
      (await page.eval<number>(`document.querySelectorAll('[data-testid="${testid}"]').length`)) === 0,
      `${testid} is rendered against the missing skill`,
    );
  }
  await writeFile(liveSkillPath, baselineSkill);
  await page.reload();
  await runPalette("discover.tab.testing-strategy");
  await page.wait(
    `document.querySelector('[data-testid="discover-tab"][data-skill="discover-testing-strategy"]')?.getAttribute("data-state") === "generated"`,
    "the restored generated skill state",
  );

  const skillLayout = await page.eval<{
    preview: boolean;
    split: number;
    statePill: boolean;
    status: boolean;
    editor: number;
    panel: number;
    header: number;
    title: string;
    eyebrow: boolean;
    meta: boolean;
    name: boolean;
    headerSurface: string;
    raised: string;
    chip: boolean;
    chipRadius: string;
  }>(`(() => {
    const editor = document.querySelector('[data-testid="discover-skill-text"]');
    const panel = document.querySelector('[data-testid="discover-skill"]');
    const index = document.querySelector('#workspace-discover .discover-skill-page');
    const header = panel?.querySelector('.discover-skill__header');
    const chip = header?.querySelector('.discover-skill__path');
    const token = (name) => {
      const probe = document.createElement("div");
      probe.style.background = \`var(\${name})\`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    return {
      preview: document.querySelector('[data-testid="discover-skill-preview"]') !== null,
      split: document.querySelectorAll('#workspace-discover [data-testid="discover-skill"] [data-testid="pane-handle"]').length,
      statePill: document.querySelector('[data-testid="discover-skill-state"]') !== null,
      status: Boolean(header?.querySelector('[data-testid="discover-skill-status"]')),
      editor: editor === null ? 0 : Math.round(editor.getBoundingClientRect().height),
      panel: panel === null ? 0 : Math.round(panel.getBoundingClientRect().height),
      header: header === null ? 0 : Math.round(header.getBoundingClientRect().height),
      title: panel?.querySelector('.panel__title')?.textContent?.trim() ?? "",
      eyebrow: index?.querySelector('.discover-page__eyebrow') !== null,
      meta: index?.querySelector('.discover-skill__meta') !== null,
      name: panel?.querySelector('.panel__header .muted') !== null,
      headerSurface: header === null ? "" : getComputedStyle(header).backgroundColor,
      raised: token("--surface-raised"),
      chip: chip !== null && chip !== undefined && chip.classList.contains("code-chip"),
      chipRadius: chip === null || chip === undefined ? "" : getComputedStyle(chip).borderRadius,
    };
  })()`);
  check(!skillLayout.preview && skillLayout.split === 0, "the skill tab still renders a preview split", skillLayout);
  check(skillLayout.statePill, "the skill header does not render its state pill");
  check(!skillLayout.status, "the skill tab still renders a status pill");
  check(
    skillLayout.title === "discover-testing-strategy/SKILL.md",
    "the skill panel is not titled with the relative path",
    skillLayout.title,
  );
  check(skillLayout.header === 44, "the skill header is not one 44px row", skillLayout);
  check(
    skillLayout.headerSurface === skillLayout.raised,
    "the skill header is not a surface-raised band",
    skillLayout,
  );
  check(
    skillLayout.chip && skillLayout.chipRadius === "3px",
    "the skill header does not read as a path chip",
    skillLayout,
  );
  check(!skillLayout.eyebrow && !skillLayout.meta && !skillLayout.name, "the skill page still renders removed labels", skillLayout);
  check(skillLayout.editor >= skillLayout.panel - 48, "the skill editor does not use the full pane", skillLayout);

  // Closing the read-only skill page never asks to discard anything.
  await runPalette("tab.close.discover.testing-strategy");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"]') === null`, "the closed skill page");
  check(
    (await page.eval<boolean>(`document.querySelector('[data-testid="confirm-close-tab"]') !== null`)) === false,
    "closing the read-only skill page asked to discard changes",
  );
  await runPalette("discover.tab.testing-strategy");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"]') !== null`, "the reopened skill page");

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
    text: string;
    tabs: number;
  }>(`(() => ({
    mode: ["goal", "flow", "discover"].find((mode) => document.querySelector('[data-testid="mode-' + mode + '"]')?.getAttribute("aria-selected") === "true") ?? "",
    surface: document.querySelector('#workspace-discover [data-testid="discover-skill"]')?.getAttribute("data-name") ?? "",
    sidebar: Math.round(document.querySelector('[data-testid="sidebar"]').getBoundingClientRect().width),
    panes: [...document.querySelectorAll('#workspace-discover [data-pane]')].map((pane) => Math.round(pane.getBoundingClientRect().width)),
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem("devboard.layout.v1") ?? "",
    text: (document.querySelector('[data-testid="discover-skill-text"]')?.textContent ?? "").slice(-20),
    tabs: document.querySelectorAll('[data-testid="workspace-tab"]').length,
  }))()`);
  check(afterReload.mode === beforeReload.mode && afterReload.theme === beforeReload.theme, "mode or theme did not survive reload", { beforeReload, afterReload });
  check(afterReload.surface === beforeReload.surface && afterReload.tabs === 0, "the open page did not survive reload", { before: beforeReload, after: afterReload });
  check(Math.abs(afterReload.sidebar - beforeReload.sidebar) <= 2, "the sidebar width did not survive reload", { before: beforeReload.sidebar, after: afterReload.sidebar });
  check(afterReload.panes.length === beforeReload.panes.length && afterReload.panes.every((width, index) => Math.abs(width - (beforeReload.panes[index] ?? 0)) <= 2), "split sizes did not survive reload", { before: beforeReload.panes, after: afterReload.panes });
  const restoredBaseline = (await readFile(join(host, ".omp", "discover", "skills", "discover-testing-strategy", "SKILL.md"), "utf8")).slice(-20);
  check(
    afterReload.text === restoredBaseline,
    "the restored skill text did not survive reload",
    { text: afterReload.text, baseline: restoredBaseline },
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
  await stageRetainedBoundaries(helloRetained, []);
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
    `document.querySelector('[data-testid="discover-remote-clear"]') !== null`,
    "the retained remote target",
  );
  // A restart may resume a run the previous server was holding. Let it finish
  // before reading the remote controls, which are disabled while a run is live.
  await waitDiscoverIdle(port);
  const remoteStrip = await page.eval<{
    select: boolean;
    options: string[];
    selected: string;
    selectedIndex: number;
    removes: Array<string | null>;
    error: string | null;
    active: string;
    removed: boolean;
    input: boolean;
    placeholder: string;
    label: string;
    start: string;
    disabled: boolean;
    title: string;
    clear: boolean;
    sheet: boolean;
    first: boolean;
    badgeCount: number;
    badgeText: string;
    badgeTitle: string | null;
    badgeAfterTitle: boolean;
    trailing: string;
    trailingIsSubtitle: boolean;
  }>(`(() => {
    const select = document.querySelector('[data-testid="discover-remote-select"]');
    const input = document.querySelector('[data-testid="discover-remote-url"]');
    const start = document.querySelector('[data-testid="discover-remote-start"]');
    const error = document.querySelector('[data-testid="discover-error"]');
    const header = document.querySelector('[data-testid="discover-remote"] .panel__header');
    const title = header?.querySelector('.panel__title') ?? null;
    const badges = header === null
      ? []
      : [...header.querySelectorAll('[data-testid="source-only-badge"]')];
    return {
      select: select !== null,
      options: select === null ? [] : [...select.options].map((option) => option.value),
      selected: select?.value ?? "",
      selectedIndex: select?.selectedIndex ?? -2,
      removes: [...document.querySelectorAll('[data-testid="discover-remote-remove"]')].map(
        (button) => button.getAttribute("data-url"),
      ),
      error: error?.textContent ?? null,
      active:
        document.querySelector('.discover-remote__item--active .discover-remote__url')
          ?.textContent?.trim() ?? "",
      removed: document.querySelector('[data-testid="discover-remote-target"]') === null,
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
      badgeCount: badges.length,
      badgeText: (badges[0]?.textContent ?? "").trim(),
      badgeTitle: badges[0]?.getAttribute("title") ?? null,
      badgeAfterTitle: title !== null && title.nextElementSibling === badges[0],
      trailing: (header?.lastElementChild?.textContent ?? "").trim(),
      trailingIsSubtitle:
        header?.lastElementChild?.classList.contains("panel__subtitle") === true,
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
  check(remoteStrip.removed, "the removed remote target banner still renders", remoteStrip);
  check(
    remoteStrip.active === helloUrl,
    "the active retained project is not marked in the retained list",
    remoteStrip,
  );
  check(
    remoteStrip.badgeCount === 1 &&
      remoteStrip.badgeText === "devboard" &&
      remoteStrip.badgeTitle === "Only available when Devboard serves a harness source checkout" &&
      remoteStrip.badgeAfterTitle,
    "the manual-testing panel header does not carry the one source-only marker",
    remoteStrip,
  );
  check(
    remoteStrip.trailing === "2 retained" && remoteStrip.trailingIsSubtitle,
    "the retained count left the header's trailing edge",
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
  // A retained remote publishes bytes for no live tree, so its references stay text.
  const retainedLinks = await page.eval<{ anchors: number; plain: boolean; texts: string[] }>(`(() => {
    const panel = document.querySelector('#workspace-discover [data-testid="discover-panel"][data-tab="overview"]');
    const chips = [...panel.querySelectorAll(".code-chip")];
    const entry = chips.find((chip) => chip.textContent.trim() === "src/checkout/flow.ts") ?? null;
    return {
      anchors: panel.querySelectorAll('a[href^="vscode://"]').length,
      plain: entry !== null && entry.tagName === "CODE",
      texts: chips.map((chip) => chip.textContent.trim()),
    };
  })()`);
  check(
    retainedLinks.anchors === 0 && retainedLinks.plain,
    "the retained remote Overview linked one of its path references",
    retainedLinks,
  );
  const retainedBoundaries = await page.eval<{ text: string; bands: number }>(`(() => {
    const block = document.querySelector('#workspace-discover [data-testid="discover-external-boundaries"]');
    return {
      text: block === null ? "" : block.textContent.replace(/\\s+/g, " ").trim(),
      bands: document.querySelectorAll('#workspace-discover [data-testid="discover-external-boundaries"] .discover-context').length,
    };
  })()`);
  check(
    retainedBoundaries.text === "None detected." && retainedBoundaries.bands === 0,
    "the retained External boundaries card does not render the observed empty list",
    retainedBoundaries,
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
    `document.querySelector('.discover-remote__item--active .discover-remote__url')?.textContent?.trim() === ${JSON.stringify(secondUrl)}`,
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
  const switchedActive = await page.eval<string>(
    `document.querySelector('.discover-remote__item--active .discover-remote__url')?.textContent?.trim() ?? ""`,
  );
  check(
    switchedActive === secondUrl,
    "switching a retained option did not mark the new target",
    switchedActive,
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
      JSON.stringify(["octocat~hello-world", "octocat~second-project"]),
    "switching created a checkout or removed a retained project",
    scratchAfterSwitch,
  );

  // The retained project's skill renders read-only and nothing writes it.
  await runPalette("discover.tab.testing-strategy");
  await page.wait(`document.querySelector('[data-testid="discover-skill-text"]') !== null`, "the retained skill text");
  const retainedSkillPath = join(
    secondRetained,
    ".omp",
    "skills",
    "discover-testing-strategy",
    "SKILL.md",
  );
  const retainedBytes = readFileSync(retainedSkillPath);
  check(
    (await page.eval<string>(`document.querySelector('[data-testid="discover-skill-text"]')?.textContent ?? ""`)) ===
      retainedBytes.toString("utf8"),
    "the retained skill page does not show its live bytes",
  );
  for (const testid of ["discover-skill-save", "discover-skill-restore", "discover-skill-dirty"]) {
    check(
      (await page.eval<number>(`document.querySelectorAll('[data-testid="${testid}"]').length`)) === 0,
      `${testid} is rendered on the retained skill page`,
    );
  }
  check(
    readFileSync(retainedSkillPath).equals(retainedBytes),
    "opening the retained skill page wrote its file",
  );
  check(await ompDigest(host) === hostOmpBefore, "a retained skill page changed this checkout's .omp");

  // Removing the active project deletes exactly it and returns to the host.
  await runPalette("discover.tab.overview");
  await page.eval(`document.querySelector('[data-testid="discover-remote-remove"][data-url="${secondUrl}"]').click()`);
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-clear"]') === null`,
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
  const afterRestart = await page.eval<{
    options: string[];
    clear: boolean;
    selectedIndex: number;
    error: string | null;
  }>(`(() => {
    const select = document.querySelector('[data-testid="discover-remote-select"]');
    return {
      options: [...select.options].map((option) => option.value),
      clear: document.querySelector('[data-testid="discover-remote-clear"]') !== null,
      selectedIndex: select.selectedIndex,
      error: document.querySelector('[data-testid="discover-error"]')?.textContent ?? null,
    };
  })()`);
  check(
    JSON.stringify(afterRestart.options) === JSON.stringify([helloUrl]),
    "the removed project returned after a restart",
    afterRestart,
  );
  check(!afterRestart.clear, "a restart reactivated a removed project", afterRestart);
  check(afterRestart.selectedIndex === -1, "a restart selected a removed project", afterRestart);
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
    `document.querySelector('.discover-remote__item--active .discover-remote__url')?.textContent?.trim() === ${JSON.stringify(helloUrl)}`,
    "the selected remaining retained project",
    20_000,
  );
  await page.click('[data-testid="discover-remote-clear"]');
  await page.wait(
    `document.querySelector('[data-testid="discover-remote-clear"]') === null`,
    "the cleared remote target",
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
  // Returning to the host restores the links without a reload.
  await page.wait(
    `document.querySelectorAll('#workspace-discover [data-testid="discover-panel"][data-tab="overview"] a[href^="vscode://"]').length === 3`,
    "the host links after clearing the remote target",
    20_000,
  );
  const restoredLinks = await page.eval<{ file: string; anchors: number }>(`(() => {
    const links = [...document.querySelectorAll('#workspace-discover [data-testid="discover-panel"][data-tab="overview"] a[href^="vscode://"]')];
    const anchor = links.find((entry) => entry.textContent.trim() === "src/checkout/flow.ts");
    const href = anchor?.getAttribute("href") ?? "";
    return {
      anchors: links.length,
      file: href.startsWith("vscode://file/")
        ? decodeURIComponent(href.slice("vscode://file/".length))
        : "",
    };
  })()`);
  check(
    restoredLinks.anchors === 3 &&
      restoredLinks.file === join(resolve(host), "src", "checkout", "flow.ts"),
    "returning to the host did not restore the Overview links",
    restoredLinks,
  );
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
    JSON.stringify(scratchAfterInvalid.sort()) === JSON.stringify(["octocat~hello-world"]),
    "an invalid URL created or removed a retained project",
    scratchAfterInvalid,
  );

  // A published-sheet value that is absolute is refused by the sheet schema, so
  // it never reaches the page; the parent-escaping values pass the schema and
  // must still render as plain text rather than a link.
  const containmentSheetPath = join(host, ".omp", "discover", "sheet.json");
  const publishedSheet = await readFile(containmentSheetPath, "utf8");
  const seededSheet = JSON.parse(publishedSheet) as {
    architecture?: { contexts?: { value?: Array<Record<string, unknown>> } };
  };
  const seededContexts = seededSheet.architecture?.contexts?.value;
  const escapees = ["../outside.ts", "src/../../escape.ts"];
  const seededEntries = seededContexts?.[0]?.entryPoints;
  check(
    Array.isArray(seededEntries),
    "the fixture sheet carries no entry point to seed",
    containmentSheetPath,
  );
  (seededEntries as string[]).push("/etc/passwd", ...escapees);
  await writeFile(containmentSheetPath, `${JSON.stringify(seededSheet, null, 2)}\n`);
  await page.navigate(baseUrl);
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnection after seeding the absolute reference",
    30_000,
  );
  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null`,
    "the Overview with the seeded absolute reference",
  );
  const absoluteRefusal = await page.eval<{ anchors: number; error: string }>(`(() => {
    const panel = document.querySelector('#workspace-discover [data-testid="discover-panel"][data-tab="overview"]');
    return {
      anchors: panel.querySelectorAll('a[href^="vscode://"]').length,
      error: document.querySelector('[data-testid="discover-error"]')?.textContent ?? "",
    };
  })()`);
  check(
    absoluteRefusal.anchors === 0 &&
      absoluteRefusal.error.includes("must not be an absolute path"),
    "an absolute sheet value was not refused before it could become a link",
    absoluteRefusal,
  );

  const escapeSheet = JSON.parse(publishedSheet) as {
    architecture?: { contexts?: { value?: Array<Record<string, unknown>> } };
  };
  const escapeEntries = escapeSheet.architecture?.contexts?.value?.[0]?.entryPoints;
  check(
    Array.isArray(escapeEntries),
    "the fixture sheet carries no entry point to seed",
    containmentSheetPath,
  );
  (escapeEntries as string[]).push(...escapees);
  await writeFile(containmentSheetPath, `${JSON.stringify(escapeSheet, null, 2)}\n`);
  await page.navigate(baseUrl);
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnection after seeding the escaping references",
    30_000,
  );
  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null`,
    "the Overview with the seeded escaping references",
  );
  await page.wait(
    `[...document.querySelectorAll('#workspace-discover [data-tab="overview"] .code-chip')].some((chip) => chip.textContent.trim() === ${JSON.stringify(escapees[0])})`,
    "the seeded escaping reference text",
    20_000,
  );
  const containment = await page.eval<{ anchors: number; rendered: string[]; linked: string[] }>(`(() => {
    const panel = document.querySelector('#workspace-discover [data-testid="discover-panel"][data-tab="overview"]');
    const escapees = ${JSON.stringify(escapees)};
    const chips = [...panel.querySelectorAll(".code-chip")];
    return {
      anchors: panel.querySelectorAll('a[href^="vscode://"]').length,
      rendered: chips
        .map((chip) => chip.textContent.trim())
        .filter((text) => escapees.includes(text)),
      linked: [...panel.querySelectorAll('a[href^="vscode://"]')]
        .map((entry) => entry.textContent.trim()),
    };
  })()`);
  check(
    containment.rendered.length === escapees.length &&
      containment.anchors === 3 &&
      containment.linked.every((text) => !escapees.includes(text)),
    "a sheet value that escapes the checkout became a link",
    containment,
  );
  await writeFile(containmentSheetPath, publishedSheet);
  await page.navigate(baseUrl);
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnection after restoring the fixture sheet",
    30_000,
  );
  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelectorAll('#workspace-discover [data-testid="discover-panel"][data-tab="overview"] a[href^="vscode://"]').length === 3`,
    "the restored Overview links",
    20_000,
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
    remote: document.querySelector('[data-testid="discover-remote"]') !== null,
    clear: document.querySelector('[data-testid="discover-remote-clear"]') !== null,
    select: document.querySelector('[data-testid="discover-remote-select"]') !== null,
    remove: document.querySelector('[data-testid="discover-remote-remove"]') !== null,
    panel: document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null,
    skills: document.querySelector('[data-testid="sidebar"] section[aria-label="Skills"]') !== null,
    badge: document.querySelectorAll('[data-testid="source-only-badge"]').length,
  })`);
  check(gateOff.panel, "the gate-off host has no Discover overview", gateOff);
  check(
    !gateOff.url && !gateOff.start && !gateOff.remote && !gateOff.clear && !gateOff.select && !gateOff.remove,
    "the gate-off host renders a remote control",
    gateOff,
  );
  check(gateOff.badge === 0, "the installed gate-off host renders a source-only marker", gateOff);

  // Harness-owned reporting is absent without DEVBOARD_GITEA_URL: the client
  // renders no report control and the endpoint refuses without a request.
  const feedbackOffHost = await writeGateOffHost(join(root, "feedback-off"));
  const feedbackOffPort = await freePort();
  const feedbackOffWriter = Bun.file(join(root, "feedback-off-server.log")).writer();
  const feedbackOffEnv = { ...serverEnv, PORT: String(feedbackOffPort) };
  delete feedbackOffEnv.DEVBOARD_GITEA_URL;
  delete feedbackOffEnv.GITEA_TOKEN;
  feedbackOffProcess = spawn("bun", ["run", "server/index.ts"], {
    cwd: harnessRoot,
    env: {
      ...feedbackOffEnv,
      ADRS_DIR: join(feedbackOffHost, "adrs"),
      REPO_DIR: feedbackOffHost,
      GOAL_FILE: join(feedbackOffHost, "GOAL.md"),
      STATE_DIR: join(root, "feedback-off-state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  feedbackOffProcess.stdout?.on("data", (chunk) => feedbackOffWriter.write(chunk));
  feedbackOffProcess.stderr?.on("data", (chunk) => feedbackOffWriter.write(chunk));
  await waitForHttp(`http://127.0.0.1:${feedbackOffPort}/`);
  await page.navigate(`http://127.0.0.1:${feedbackOffPort}/`);
  await page.wait(
    `document.readyState === "complete" && document.querySelector('[data-testid="app-shell"]') !== null`,
    "the shell without harness reporting",
    30_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the connection without harness reporting",
    20_000,
  );
  const reportingOff = await page.eval<Record<string, boolean>>(`({
    report: document.querySelector('[data-testid="activity-report"]') !== null,
    remove: document.querySelector('[data-testid="activity-remove"]') !== null,
    redesign: document.querySelector('[data-testid="activity-redesign"]') !== null,
  })`);
  check(
    !reportingOff.report && !reportingOff.remove && !reportingOff.redesign,
    "the client rendered a reporting control without DEVBOARD_GITEA_URL",
    reportingOff,
  );
  const refused = await fetch(`http://127.0.0.1:${feedbackOffPort}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...VERIFY_DASHBOARD_AUTHORIZATION },
    body: JSON.stringify({ action: "REPORT", report: "disabled check" }),
  });
  const refusal = await refused.text();
  check(
    refused.status === 503 && refusal.includes("DEVBOARD_GITEA_URL"),
    "the disabled feedback endpoint did not name DEVBOARD_GITEA_URL",
    { status: refused.status, refusal },
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
  await page.wait(
    `(() => {
      const report = document.querySelector('[data-testid="activity-report"]');
      const remove = document.querySelector('[data-testid="activity-remove"]');
      return report !== null && remove !== null &&
        getComputedStyle(report).backgroundColor !== getComputedStyle(remove).backgroundColor;
    })()`,
    "the armed report action to paint its active surface",
  );
  check((await sourceOnlyMarkers(page)) === 0, "the feedback controls render a source-only marker");
  const reportActive = await issueState();
  check(
    reportActive.pressed.join(",") === "true,false,false",
    "the report action is not pressed in selection mode",
    reportActive,
  );
  check(
    reportActive.marker[0] &&
      !reportActive.marker[1] &&
      !reportActive.marker[2] &&
      reportActive.backgrounds[0] !== reportActive.backgrounds[1] &&
      reportActive.backgrounds[0] !== reportActive.backgrounds[2],
    "the armed report action does not read as active",
    reportActive,
  );
  await page.wait(
    `(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;background:var(--secondary-hover)";
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const button = document.querySelector('[data-testid="activity-report"]');
      return button !== null && getComputedStyle(button).backgroundColor === expected;
    })()`,
    "the armed report action to settle on the secondary-hover fill",
  );
  const activePaint = await page.eval<{
    background: string;
    border: string;
    color: string;
    surface: string;
    strongBorder: string;
    foreground: string;
    accentSurface: string;
    ghost: { background: string; border: string; color: string; pressed: boolean };
  }>(`(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;background:var(--secondary-hover);border-top:1px solid var(--border-strong);" +
      "color:var(--foreground)";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const accentProbe = document.createElement("div");
    accentProbe.style.cssText = "position:absolute;background:var(--accent-surface)";
    document.body.append(accentProbe);
    const expected = {
      surface: style.backgroundColor,
      strongBorder: style.borderTopColor,
      foreground: style.color,
      accentSurface: getComputedStyle(accentProbe).backgroundColor,
    };
    accentProbe.remove();
    probe.remove();
    const button = document.querySelector('[data-testid="activity-report"]');
    const ghost = document.querySelector('[data-testid="theme-toggle"]');
    const buttonStyle = button === null ? null : getComputedStyle(button);
    const ghostStyle = ghost === null ? null : getComputedStyle(ghost);
    return {
      background: buttonStyle?.backgroundColor ?? "",
      border: buttonStyle?.borderTopColor ?? "",
      color: buttonStyle?.color ?? "",
      ...expected,
      ghost: {
        background: ghostStyle?.backgroundColor ?? "",
        border: ghostStyle?.borderTopColor ?? "",
        color: ghostStyle?.color ?? "",
        pressed: ghost?.getAttribute("aria-pressed") === "true",
      },
    };
  })()`);
  check(
    activePaint.background === activePaint.surface &&
      activePaint.background !== activePaint.accentSurface &&
      activePaint.border === activePaint.strongBorder &&
      activePaint.color === activePaint.foreground,
    "the armed issue action does not paint the secondary-hover fill with foreground text and a strong border",
    activePaint,
  );
  check(
    !activePaint.ghost.pressed &&
      activePaint.ghost.background === "rgba(0, 0, 0, 0)" &&
      activePaint.ghost.border === "rgba(0, 0, 0, 0)" &&
      activePaint.ghost.color === activePaint.foreground,
    "an idle ghost icon button no longer reads as unchanged",
    activePaint,
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
    idleIssue.pressed.every((value) => !value) &&
      idleIssue.marker.every((value) => !value) &&
      idleIssue.inside,
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
  const panelChrome = await page.eval<{
    title: string;
    placeholder: string;
    buttons: string[];
    selector: string;
    radius: string;
  }>(`(() => ({
    title: document.querySelector('.feedback-drag')?.textContent?.trim() ?? "",
    placeholder: document.querySelector('.feedback-panel textarea')?.getAttribute("placeholder") ?? "",
    buttons: [...document.querySelectorAll('.feedback-actions button')].map((button) => button.textContent.trim()),
    selector: document.querySelector('.feedback-selector')?.textContent?.trim() ?? "",
    radius: getComputedStyle(document.querySelector('.feedback-panel')).borderRadius,
  }))()`);
  check(panelChrome.title === "Report a UI issue", "the report panel title changed", panelChrome);
  check(panelChrome.placeholder === "What is wrong with this element?", "the report panel placeholder changed", panelChrome);
  check(
    panelChrome.buttons.join("|") === "File issue|Ask|Goal|Cancel",
    "the report panel actions changed",
    panelChrome,
  );
  check(panelChrome.selector.length > 0, "the report panel shows no selector", panelChrome);
  const panelRadius = Number.parseFloat(panelChrome.radius);
  check(
    Number.isFinite(panelRadius) && panelRadius > 0 && panelRadius <= 6,
    "the report panel exceeds the 6px functional radius",
    panelChrome,
  );
  const composing = await issueState();
  check(
    composing.disabled.join(",") === "false,true,true",
    "the quick actions are not disabled while composing",
    composing,
  );
  check(
    feedbackCalls.length === 0 && feedbackRequests.length === 0,
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
  const reportCall = feedbackCalls[0]!;
  check(
    reportCall.title.includes("[ui] The status bar is clipped at the boundary."),
    "the report title is wrong",
    reportCall.title,
  );
  check(reportCall.body.startsWith("## Operator report"), "the report body lost its heading", reportCall.body);
  check(
    reportCall.url.includes("/repos/dsdenes/devboard/issues"),
    "the report was filed in another repository",
    reportCall.url,
  );
  check(
    feedbackRequests.length === 1 &&
      feedbackRequests[0]?.action === "REPORT" &&
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
    feedbackRequests.length === 0 && feedbackCalls.length === 0,
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
  const canceledIssue = await issueState();
  check(
    canceledIssue.pressed.every((value) => !value) &&
      canceledIssue.marker.every((value) => !value),
    "a canceled mode is still pressed",
    canceledIssue,
  );

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
  const removalCalls = feedbackCalls;
  check(removalCalls.length === 2, "the second removal was not filed", removalCalls.length);
  for (const call of removalCalls) {
    check(call.url.includes("/repos/dsdenes/devboard/issues"), "a removal was filed in another repository", call.url);
    check(call.title.startsWith("[ui] Remove element: "), "a removal title is wrong", call.title);
    check(call.body.startsWith("## Removal request\n\n"), "a removal body lost its heading", call.body);
    check(call.body.includes(`\n${removalInstruction}\n`), "a removal body lost its instruction", call.body);
    check(call.body.includes("## Captured UI context"), "a removal body lost the captured context", call.body);
    check(call.body.includes("### DOM excerpt"), "a removal body lost the DOM excerpt", call.body);
  }
  const removalRequests = feedbackRequests.filter((entry) => entry.action === "REMOVE");
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
  check(feedbackCalls.length === 0, "switching actions filed an issue");
  await page.click('[data-testid="status-connection"]');
  await waitForFeedbackCalls(1);
  await delay(150);
  await page.click('[data-testid="status-bar"]');
  await waitForFeedbackCalls(2);
  await delay(150);
  const redesignCalls = feedbackCalls;
  check(redesignCalls.length === 2, "the second redesign was not filed", redesignCalls.length);
  for (const call of redesignCalls) {
    check(call.url.includes("/repos/dsdenes/devboard/issues"), "a redesign was filed in another repository", call.url);
    check(call.title.startsWith("[ui] Redesign element: "), "a redesign title is wrong", call.title);
    check(call.body.startsWith("## Redesign request\n\n"), "a redesign body lost its heading", call.body);
    check(call.body.includes(redesignInstruction), "a redesign body lost its instruction", call.body);
    check(call.body.includes("## Captured UI context"), "a redesign body lost the captured context", call.body);
  }
  const redesignRequests = feedbackRequests.filter((entry) => entry.action === "REDESIGN");
  check(redesignRequests.length === 2, "the issue actions did not send two redesign requests", feedbackRequests);
  const redesignStatus = await page.eval<{ text: string; href: string; color: string; foreground: string }>(`(() => {
    const status = document.querySelector('.feedback-result');
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;color:var(--foreground)";
    document.body.append(probe);
    const foreground = getComputedStyle(probe).color;
    probe.remove();
    const message = status?.querySelector(".feedback-result__text");
    return {
      text: (status?.textContent ?? "").split("\\n").map((value) => value.trim()).filter((value) => value.length > 0).join(" "),
      href: status?.querySelector("a")?.getAttribute("href") ?? "",
      color: message === null || message === undefined ? "" : getComputedStyle(message).color,
      foreground,
    };
  })()`);
  check(redesignStatus.text.startsWith("Redesign issue filed."), "the redesign success text is wrong", redesignStatus);
  check(redesignStatus.href === stubIssueUrl, "the redesign success carries no stub issue URL", redesignStatus);
  check(
    redesignStatus.color === redesignStatus.foreground,
    "the successful filing's message text does not use the foreground color",
    redesignStatus,
  );
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
  const delayedCalls = feedbackCalls;
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
    color: string;
    errorColor: string;
  }>(`(() => {
    const alert = document.querySelector('.feedback-result[role="alert"]');
    const ids = ["activity-report", "activity-remove", "activity-redesign"];
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;color:var(--error)";
    document.body.append(probe);
    const errorColor = getComputedStyle(probe).color;
    probe.remove();
    const message = alert?.querySelector(".feedback-result__text");
    return {
      text: (alert?.textContent ?? "").split("\\n").map((value) => value.trim()).filter((value) => value.length > 0).join(" "),
      link: alert?.querySelector("a") !== null,
      hint: document.querySelector('.feedback-hint')?.textContent ?? "",
      pressed: ids.map((id) => document.querySelector('[data-testid="' + id + '"]')?.getAttribute("aria-pressed") ?? ""),
      disabled: ids.map((id) => document.querySelector('[data-testid="' + id + '"]')?.disabled === true),
      color: message === null || message === undefined ? "" : getComputedStyle(message).color,
      errorColor,
    };
  })()`);
  check(
    failure.text.startsWith("Redesign issue failed: Issue creation failed:") &&
      failure.text.includes("boom"),
    "the redesign failure alert is wrong",
    failure,
  );
  check(!failure.link, "a failed redesign rendered an issue link", failure);
  check(failure.hint.includes("to redesign"), "a failed redesign left the mode", failure);
  check(failure.pressed.join(",") === "false,false,true", "a failed redesign lost its pressed state", failure);
  check(failure.disabled.every((value) => !value), "a failed redesign left the actions disabled", failure);
  check(
    failure.color === failure.errorColor,
    "the failed filing's message text does not use the error color",
    failure,
  );
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
  check(feedbackPosts.length === postsBeforeAsk, "an ask posted to /feedback", feedbackPosts);

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
    transcriptSurface.roles.join(",") === "DEVELOPER,AGENT,DEVELOPER,AGENT" &&
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
  // Every peer in this run starts with --ask, so count the peers that answered
  // a first ask turn rather than the ask-start marker on process startup.
  const askSpawns = askLog.split("\n").filter((line) => line.startsWith("ask-prompt 1 ")).length;
  const askPrompts = askLog.split("\n").filter((line) => line.startsWith("ask-prompt ")).length;
  check(askSpawns === 1, `the ask stub started ${askSpawns} peers`, askLog);
  check(askPrompts === 2, `the ask stub answered ${askPrompts} prompts`, askLog);

  // Filing after asking carries the conversation into the issue as context.
  const callsBeforeAsking = feedbackCalls.length;
  await page.click('.feedback-actions button');
  await delay(150);
  await page.wait(
    `document.querySelector('.feedback-panel') === null && document.querySelector('.feedback-hint') !== null`,
    "the selection mode after filing the asked issue",
  );
  await waitForFeedbackCalls(callsBeforeAsking + 1);
  const askedCall = feedbackCalls[callsBeforeAsking]!;
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
  check(
    stoppedConsole.poll === "Not polling" || stoppedConsole.poll.startsWith("Tracker "),
    "the stopped poll line claims the worker is polling",
    stoppedConsole,
  );
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
  check((await sourceOnlyMarkers(page)) === 0, "the Issues overview renders a source-only marker");

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
  try {
    await page.wait(
      `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues idle"`,
      "the idle issues indicator",
      8_000,
    );
  } catch (error) {
    console.log("DEBUG idle", await page.eval(`({
      indicator: document.querySelector('[data-testid="issues-indicator"]')?.outerHTML ?? null,
      frames: (window.__viFrames ?? []).filter((frame) => frame.includes("issues") || frame.includes("Issues")).slice(-8),
      errors: window.__viExceptions ?? [],
      mode: document.querySelector('[data-testid="mode-issues"]')?.getAttribute("aria-selected") ?? null,
    })`));
    throw error;
  }
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
  // The status bar counts workers; the queue counts the forge read. Wait for
  // that read to list the seeded issues before its rows and links are read.
  await page.wait(
    `document.querySelector('[data-testid="open-issues-queue"] .sidebar-item__meta')?.textContent?.trim() === "2 pending · 3 running"`,
    "the forge-derived queue summary",
    10_000,
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
    facts: string[];
    summaryIssues: string[];
    summaryVersions: string[];
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
      facts: [...(side?.querySelectorAll(".issues-facts > div") ?? [])].map(
        (row) => row.querySelector("dt")?.textContent?.trim() ?? "",
      ),
      summaryIssues: [...(summary?.querySelectorAll(".issues-agent-row") ?? [])].map(
        (item) => item.getAttribute("data-issue") ?? "",
      ),
      summaryVersions: [...(summary?.querySelectorAll('[data-testid="issues-agent-row-version"]') ?? [])].map(
        (item) => item.textContent?.trim() ?? "",
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
    overview.facts.join(",") === "Worker,Agents,Queue,Cooldowns",
    "the automation facts no longer read Worker, Agents, Queue, and Cooldowns only",
    overview.facts,
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
    overview.summaryVersions.length === 3 &&
      overview.summaryVersions.every((version) => version === seedVersion),
    "an overview running row does not name its worker version",
    overview.summaryVersions,
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
      version: string;
    }>
  >(`[...document.querySelectorAll('[data-testid="issues-agent"]')].map((card) => ({
    issue: card.getAttribute("data-issue") ?? "",
    run: card.getAttribute("data-run") ?? "",
    status: card.getAttribute("data-status") ?? "",
    activity: card.querySelector('[data-testid="issues-agent-activity"]')?.textContent ?? "",
    question: card.querySelector('[data-testid="issues-agent-question"]')?.textContent ?? "",
    linked: card.querySelector("a")?.getAttribute("href") ?? "",
    version: card.querySelector('[data-testid="issues-agent-version"]')?.textContent?.trim() ?? "",
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
  check(
    cards.every((card) => card.version.includes(seedVersion)),
    "an Agents card does not name its worker version",
    cards.map((card) => card.version),
  );
  const agentsHeader = await page.eval<{ count: string; asking: string; title: string; eyebrow: string }>(`(() => ({
    count: document.querySelector('[data-testid="issues-agents-count"]')?.textContent?.trim() ?? "",
    asking: document.querySelector('[data-testid="issues-agents-asking"]')?.textContent?.trim() ?? "",
    title: document.querySelector('[data-testid="issues-agents-header"] h1')?.textContent?.trim() ?? "",
    eyebrow: document.querySelector('[data-testid="issues-agents-header"] .page-header__eyebrow')?.textContent?.trim() ?? "",
  }))()`);
  check(
    agentsHeader.count === "3 running" && agentsHeader.asking === "3 need answers",
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
    ) === "2 need answers",
    "the Agents header did not follow the remaining questions",
  );
  check(
    await page.eval<number>(
      `document.querySelectorAll('[data-testid="issues-agent"][data-asked="true"]').length`,
    ) === 2,
    "the question marker did not follow the remaining questions",
  );

  // A card opens one focus tab whose single agent follows in the shared bar.
  await page.click('[data-testid="issues-agent-open"][data-run="2026-10-27T10-00-01-000Z"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-agent-focus"]') !== null`,
    "the agent focus tab",
    8_000,
  );
  const focus = await page.eval<{
    bars: number;
    dot: string;
    last: string;
    question: string;
    closeCommand: string;
    runIdText: boolean;
    removed: boolean;
    padding: string[];
  }>(`(() => {
    const surface = document.querySelector('#workspace-issues [data-testid="issues-agent-focus"]');
    const text = surface?.textContent ?? "";
    const style = surface === null ? null : getComputedStyle(surface);
    return {
      bars: surface?.querySelectorAll('[data-testid="agent-activity-bar"]').length ?? 0,
      dot: surface?.querySelector('[data-testid="agent-activity-dot"]')?.getAttribute("data-state") ?? "",
      last: surface?.querySelector('[data-testid="agent-activity-last"]')?.textContent?.trim() ?? "",
      question: surface?.querySelector('[data-testid="issues-agent-focus-question"]')?.textContent ?? "",
      closeCommand: surface?.querySelector('[data-testid="issues-agent-focus-close"]')?.getAttribute("data-command") ?? "",
      runIdText: text.includes("2026-10-27T10-00-01-000Z"),
      padding:
        surface === null
          ? []
          : [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      removed:
        surface?.querySelector('[data-testid="issues-agent-focus-status"]') !== null ||
        surface?.querySelector('[data-testid="issues-agent-focus-run"]') !== null ||
        surface?.querySelector('[data-testid="issues-agent-focus-run-id"]') !== null ||
        surface?.querySelector('[data-testid="issues-agent-focus-run-started"]') !== null ||
        surface?.querySelector('[data-testid="issues-agent-focus-activity"]') !== null,
    };
  })()`);
  check(focus.bars === 1 && focus.dot === "running", "the focus bar does not follow the run", focus);
  check(focus.last.includes("Implementing issue 17"), "the focus bar lost the run activity", focus);
  check(
    focus.question.includes("Which scope should issue 17 take?"),
    "the focus tab lost the run question",
    focus,
  );
  check(focus.closeCommand === "tab.close", "the focus tab has no close control", focus);
  check(
    JSON.stringify(focus.padding) === JSON.stringify(["16px", "16px", "16px", "16px"]),
    "the Issues agent focus does not use the page padding",
    focus,
  );
  check(!focus.removed, "a removed focus run surface is still rendered", focus);
  check(!focus.runIdText, "the focus tab still renders its run identifier", focus);
  const longFocusTitle = await page.eval<{
    text: string;
    tooltip: string;
    clipped: boolean;
    closeInside: boolean;
    scrollWidth: number;
    clientWidth: number;
  }>(`(() => {
    const surface = document.querySelector('[data-testid="issues-agent-focus"]');
    const title = surface?.querySelector('.issues-overview__title');
    const close = document.querySelector('[data-testid="issues-agent-focus-close"]');
    const surfaceRect = surface?.getBoundingClientRect();
    const closeRect = close?.getBoundingClientRect();
    return {
      text: title?.textContent ?? "",
      tooltip: title?.getAttribute("title") ?? "",
      clipped: title !== null && title !== undefined && title.scrollWidth > title.clientWidth,
      closeInside:
        surfaceRect !== undefined &&
        closeRect !== undefined &&
        closeRect.right <= surfaceRect.right + 0.5,
      scrollWidth: surface?.scrollWidth ?? 0,
      clientWidth: surface?.clientWidth ?? 0,
    };
  })()`);
  check(
    longFocusTitle.text === `#17 ${longIssueTitle}`,
    "the focus tab lost the issue title",
    longFocusTitle,
  );
  check(
    longFocusTitle.tooltip === `#17 ${longIssueTitle}`,
    "the focus tab does not expose the full issue title",
    longFocusTitle,
  );
  check(longFocusTitle.clipped, "a long issue title is not truncated", longFocusTitle);
  check(
    longFocusTitle.closeInside,
    "a long issue title pushes the focus header controls outside the pane",
    longFocusTitle,
  );
  check(
    longFocusTitle.scrollWidth <= longFocusTitle.clientWidth + 1,
    "a long issue title widens the focus page",
    longFocusTitle,
  );
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
  const narrowBar = await page.eval<{
    right: number;
    surfaceRight: number;
    title: number;
  }>(`(() => {
    const surface = document.querySelector('[data-testid="issues-agent-focus"]');
    const bar = surface?.querySelector('[data-testid="agent-activity-bar"]');
    return {
      right: bar?.getBoundingClientRect().right ?? 0,
      surfaceRight: surface?.getBoundingClientRect().right ?? 0,
      title: surface?.querySelector('.issues-overview__title')?.getBoundingClientRect().width ?? 0,
    };
  })()`);
  check(
    narrowBar.title > 0 &&
      narrowBar.right <= narrowBar.surfaceRight + 0.5 &&
      narrowBar.right >= narrowBar.surfaceRight - 20,
    "the activity bar breaks the focus page at 1024×720",
    narrowBar,
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
    `document.querySelector('[data-testid="issues-agent-focus"] [data-testid="agent-activity-last"]')?.textContent?.includes("Implementing issue 17") === true`,
    "the focus bar after reload",
    20_000,
  );
  check(
    await page.eval<boolean>(
      `document.querySelector('[data-testid="issues-agent-focus"] [data-testid="agent-activity-dot"]')?.getAttribute("data-state") === "running"`,
    ),
    "reload lost the focus run state",
  );

  // A finished run restored from a persisted agent tab requests its history
  // only after the socket opens: exactly one frame, no connection error, and
  // the run detail instead of the permanent loading state.
  await seedIssuesState(stateDir, host, "paused");
  await page.wait(
    `document.querySelector('[data-testid="issues-agent-focus"] [data-testid="agent-activity-dot"]')?.getAttribute("data-state") === "succeeded"`,
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
    `document.querySelector('[data-testid="issues-agent-focus"] [data-testid="agent-activity-last"]')?.textContent?.includes("Implementing issue 17") === true &&
     document.querySelector('[data-testid="issues-agent-focus"] [data-testid="agent-activity-dot"]')?.getAttribute("data-state") === "succeeded"`,
    "the restored finished run",
    20_000,
  );
  const restoredRun = await page.eval<{
    frames: Array<{ type?: unknown; runId?: unknown }>;
    loading: boolean;
    last: string;
    notifications: string;
  }>(`(() => ({
    frames: (window.__devboardSentCommands ?? []).filter((command) => command.type === "getIssuesRun"),
    loading: (document.querySelector('[data-testid="issues-agent-focus"]')?.textContent ?? "").includes("Loading the run from history"),
    last: document.querySelector('[data-testid="issues-agent-focus"] [data-testid="agent-activity-last"]')?.textContent?.trim() ?? "",
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
    restoredRun.last.includes("Implementing issue 17"),
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
    `document.querySelector('[data-testid="issues-agent-focus"] [data-testid="agent-activity-dot"]')?.getAttribute("data-state") === "running"`,
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
  await page.wait(
    `document.querySelectorAll('[data-testid="issues-queue-item"]').length === 5`,
    "the issues queue rows",
    8_000,
  );
  const queue = await page.eval<Array<{ number: string; processing: string; goal: string }>>(
    `[...document.querySelectorAll('[data-testid="issues-queue-item"]')].map((item) => ({
      number: item.getAttribute("data-number") ?? "",
      processing: item.getAttribute("data-processing") ?? "",
      goal: item.getAttribute("data-goal") ?? "",
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
  check(
    queue.every((entry, index) => entry.processing === (index < 3 ? "true" : "false")),
    "a row's state is not the forge's processing label",
    queue,
  );
  check(
    await page.eval<number>(`document.querySelectorAll('[data-testid="issues-running-marker"]').length`) === 3,
    "the queue has no running marker for a processing label",
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
  check((await sourceOnlyMarkers(page)) === 0, "the Issues queue renders a source-only marker");
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
  const queueHeader = await page.eval<{ text: string; tone: string }>(`(() => {
    const badge = document.querySelector('.issues-queue-page > .issues-overview__header > .badge');
    return {
      text: badge?.textContent?.trim() ?? "",
      tone: badge?.getAttribute("data-tone") ?? "",
    };
  })()`);
  check(
    queueHeader.text === "2 pending · 3 running" && queueHeader.tone === "accent",
    "the queue header does not separate waiting from running issues",
    queueHeader,
  );
  const pendingMeta = await page.eval<string>(
    `document.querySelector('[data-testid="open-issues-queue"] .sidebar-item__meta')?.textContent ?? ""`,
  );
  check(
    pendingMeta.trim() === "2 pending · 3 running",
    "the sidebar does not separate waiting from running issues",
    pendingMeta,
  );

  // The indicator reports issue automation state, so activating it lands on the
  // Overview even when Issues mode kept another surface open.
  check(
    await page.eval<boolean>(`document.querySelector('[data-testid="issues-queue"]') !== null`),
    "the Issues queue is not the surface before the indicator click",
  );
  await page.click('[data-testid="issues-indicator"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-overview"]') !== null`,
    "the Issues overview from the indicator on another surface",
    8_000,
  );

  // The sidebar no longer lists Runs; the palette still opens the tab.
  check(
    await page.eval<boolean>(`document.querySelector('[data-testid="open-issues-runs"]') === null`),
    "the Issues sidebar still lists Runs",
  );
  await runPalette("open.issues.runs");
  await page.wait(`document.querySelector('[data-testid="issues-runs"]') !== null`, "the runs page");
  const runsHeader = await page.eval<string[]>(
    `[...document.querySelectorAll('.issues-runs-page > .issues-overview__header > div > *')].map((node) => \`\${node.tagName}:\${node.className}\`)`,
  );
  check(
    runsHeader[0]?.startsWith("H1:") === true && runsHeader.every((entry) => !entry.includes("muted")),
    "the runs header still carries a label above its title",
    runsHeader,
  );
  const headerBadges = await page.eval<number>(
    `document.querySelectorAll('.issues-runs-page > .issues-overview__header > .badge').length`,
  );
  check(headerBadges === 0, "the runs header still carries a count badge", headerBadges);
  const runCount = await page.eval<number>(`document.querySelectorAll('[data-testid="issues-run"]').length`);
  check(runCount === 4, "the runs page does not list every concurrent run", runCount);
  const goalRunCount = await page.eval<number>(
    `[...document.querySelectorAll('[data-testid="issues-run"]')].filter((run) => run.getAttribute("data-status") === "running").length`,
  );
  check(goalRunCount === 3, "the runs page lost a running agent", goalRunCount);
  const runPadding = await page.eval<{ top: string; right: string }>(`(() => {
    const row = document.querySelector('[data-testid="issues-run"]');
    if (row === null) return { top: "", right: "" };
    const style = getComputedStyle(row);
    return { top: style.paddingTop, right: style.paddingRight };
  })()`);
  check(
    runPadding.top === "6px" && runPadding.right === "10px",
    "an issues runs row does not use the design-system dense row padding",
    runPadding,
  );
  await page.click('[data-testid="issues-run"]');
  await page.wait(`document.querySelector('[data-testid="issues-run-detail"]') !== null`, "the run detail");
  const runActivity = await page.eval<string>(
    `document.querySelector('[data-testid="issues-run-activity"]')?.textContent ?? ""`,
  );
  check(runActivity.includes("Implementing issue"), "the run detail does not show its activity", runActivity);
  const runVersions = await page.eval<{ rows: string[]; detail: string }>(`(() => ({
    rows: [...document.querySelectorAll('[data-testid="issues-run-version"]')].map((item) => item.textContent?.trim() ?? ""),
    detail: document.querySelector('[data-testid="issues-run-version-detail"]')?.textContent?.trim() ?? "",
  }))()`);
  check(
    runVersions.rows.length === 4 && runVersions.rows.every((version) => version === seedVersion),
    "an issues run row does not name its worker version",
    runVersions.rows,
  );
  check(
    runVersions.detail.includes(seedVersion),
    "the run detail does not name the worker that owns it",
    runVersions.detail,
  );
  await page.click('[data-testid="open-issues-overview"]');
  await page.wait(`document.querySelector('[data-testid="issues-overview"]') !== null`, "the issues overview again");

  // Drafts: parallel elaborations, switching, independent answer and stop, restart.
  await seedGoalDrafts(host);
  await page.click('[data-testid="open-issues-drafts"]');
  await page.wait(`document.querySelector('[data-testid="issues-drafts"]') !== null`, "the drafts page");
  await page.wait(
    `document.querySelector('[data-testid="open-issues-drafts"] .sidebar-item__meta')?.textContent?.trim() === "6"`,
    "the six seeded drafts to reach the sidebar",
    15_000,
  );
  const draftsChrome = await page.eval<{
    entryTestid: string;
    command: string;
    label: string;
    count: string;
    afterIssues: boolean;
    palette: boolean;
  }>(`(() => {
    const entry = document.querySelector('[data-testid="open-issues-drafts"]');
    const issuesEntry = document.querySelector('[data-testid="open-issues-queue"]');
    return {
      entryTestid: entry?.getAttribute("data-testid") ?? "",
      command: entry?.getAttribute("data-command") ?? "",
      label: entry?.getAttribute("aria-label") ?? "",
      count: entry?.querySelector(".sidebar-item__meta")?.textContent?.trim() ?? "",
      afterIssues: issuesEntry !== null && issuesEntry.nextElementSibling === entry,
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
  check(draftsChrome.count === "6", "the Drafts entry does not count the listed drafts", draftsChrome);
  check(draftsChrome.afterIssues, "the Drafts entry is not after Issues", draftsChrome);

  const listedDrafts = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="issues-draft"]')].map((item) => item.getAttribute("data-path") ?? "")`,
  );
  const draftDirectory = join(host, ".devboard", "goal-proposals");
  const expectedDrafts = (await readdir(draftDirectory))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `.devboard/goal-proposals/${name}`);
  check(
    listedDrafts.join(",") === expectedDrafts.join(",") && listedDrafts.length === 6,
    "the drafts list is missing, unsorted, or lists the wrong files",
    { listedDrafts, expectedDrafts },
  );
  check((await sourceOnlyMarkers(page)) === 0, "the Draft goals page renders a source-only marker");
  const draftHeadings = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="issues-draft"]')].map((item) => item.textContent ?? "")`,
  );
  check(
    draftHeadings[0]?.includes("Question draft") === true &&
      draftHeadings[1]?.includes("Hang draft") === true &&
      draftHeadings[2]?.includes("Third hang draft") === true &&
      draftHeadings[3]?.includes("Fourth hang draft") === true &&
      draftHeadings[4]?.includes("Failing draft") === true,
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
    detailStart: boolean;
    rowStartCommand: string;
    stop: boolean;
    pathLabel: string;
    proposal: string;
    contextSection: boolean;
  }>(`(() => {
    const panel = document.querySelector('[data-testid="issues-draft-detail"]');
    const rowStart = document.querySelector(
      '[data-testid="issues-draft-row-start"][data-path="${reportDraftPath}"]',
    );
    return {
      path: panel?.getAttribute("data-path") ?? "",
      detailStart: document.querySelector('[data-testid="issues-draft-start"]') !== null,
      rowStartCommand: rowStart?.getAttribute("data-command") ?? "",
      stop: document.querySelector('[data-testid="issues-draft-stop"]') !== null,
      pathLabel: panel?.querySelector(".issues-draft-detail__path")?.textContent?.trim() ?? "",
      proposal: panel?.querySelector(".issues-draft-detail__prose")?.textContent ?? "",
      contextSection: panel?.querySelector('section[aria-label="Captured UI context"]') !== null,
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
    !detail.contextSection,
    "the draft detail still shows the captured UI context",
    detail,
  );
  check(
    detail.pathLabel.endsWith(".md") &&
      !detail.proposal.includes("## Captured UI context") &&
      !detail.proposal.includes("Unprocessed draft"),
    "the detail does not separate identity and proposal from the evidence",
    detail,
  );
  await dismissNotifications();
  await saveShot("issues-draft-detail");
  check(
    !detail.detailStart &&
      detail.rowStartCommand === "issues.draft.start" &&
      !detail.stop,
    "the draft detail still carries a start control or the row lost its own",
    detail,
  );

  // Two drafts elaborate at once; each row carries only its own state.
  const draftRow = (name: string): string =>
    `[data-testid="issues-draft"][data-path=".devboard/goal-proposals/${name}"]`;
  const draftRowStart = (name: string): string =>
    `[data-testid="issues-draft-row-start"][data-path=".devboard/goal-proposals/${name}"]`;
  const draftStatus = (name: string): string =>
    `(document.querySelector('${draftRow(name)}')?.getAttribute("data-status") ?? "")`;

  await page.click(draftRowStart("001-question.md"));
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/001-question.md"`,
    "the started draft's own detail",
    8_000,
  );
  await page.click(draftRow("002-hang.md"));
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/002-hang.md"`,
    "the second running draft detail",
  );
  await page.click(draftRowStart("002-hang.md"));
  await page.wait(
    `${draftStatus("001-question.md")} === "running" && ${draftStatus("002-hang.md")} === "running"`,
    "two drafts running at once",
    8_000,
  );

  const startStates = await page.eval<Record<string, boolean>>(`(() => {
    const state = {};
    for (const name of ["001-question.md", "002-hang.md", "003-hang.md", "004-hang.md", "005-fail.md"]) {
      const start = document.querySelector(
        '[data-testid="issues-draft-row-start"][data-path=".devboard/goal-proposals/' + name + '"]',
      );
      state[name] = start instanceof HTMLButtonElement ? start.disabled : true;
    }
    return state;
  })()`);
  check(
    startStates["001-question.md"] === true && startStates["002-hang.md"] === true,
    "a running draft keeps its own start control enabled",
    startStates,
  );
  check(
    ["003-hang.md", "004-hang.md", "005-fail.md"].every(
      (name) => startStates[name] === false,
    ),
    "an idle draft's start control is disabled while another elaborates",
    startStates,
  );
  const blockers = await page.eval<number>(
    `document.querySelectorAll('[data-testid="issues-draft-blocked"]').length`,
  );
  check(
    blockers === 0,
    "a draft row still renders an elaboration blocker",
    blockers,
  );

  // A question for an unselected draft appears on its own row within two seconds.
  const draftAnswer = (name: string): string =>
    `(document.querySelector('${draftRow(name)} [data-testid="issues-draft-waiting"]')?.textContent?.trim() ?? "")`;
  await page.wait(
    `${draftStatus("002-hang.md")} === "running" &&
      document.querySelector('${draftRow("001-question.md")}')?.getAttribute("data-question") === "true" &&
      ${draftAnswer("001-question.md")} === "answer"`,
    "the unselected draft's waiting state",
    2_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent?.includes("002-hang.md") === true`,
    "the hang draft's own activity",
    8_000,
  );
  const hangActivity = await page.eval<string>(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? ""`,
  );
  check(
    hangActivity.includes("002-hang.md") && !hangActivity.includes("001-question.md"),
    "the hang detail shows another draft's activity",
    hangActivity,
  );

  // Selecting the question draft shows only its own state, activity, and question.
  await page.click(draftRow("001-question.md"));
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/001-question.md" &&
      document.querySelector('[data-testid="issues-draft-question"]') !== null`,
    "the question draft's own detail",
    8_000,
  );
  const questionDetail = await page.eval<{
    state: string;
    activity: string;
    question: string;
    ordered: boolean;
    messageTag: string;
    messageSize: number;
  }>(`(() => {
    const panel = document.querySelector('[data-testid="issues-draft-detail"]');
    const question = document.querySelector('[data-testid="issues-draft-question"]');
    const activity = document.querySelector('[data-testid="issues-draft-activity"]');
    const message = question?.querySelector(".issues-question__message");
    return {
      state: document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() ?? "",
      activity: activity?.textContent ?? "",
      question: question?.textContent ?? "",
      ordered: question !== null && activity !== null &&
        (question.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      messageTag: message?.tagName ?? "",
      messageSize: message === null || message === undefined
        ? 0
        : Number.parseFloat(getComputedStyle(message).fontSize),
    };
  })()`);
  check(
    questionDetail.state === "running" &&
      questionDetail.activity.includes("001-question.md") &&
      !questionDetail.activity.includes("002-hang.md"),
    "the switched detail does not show the selected draft's own activity",
    questionDetail,
  );
  check(
    questionDetail.question.includes("Choose an answer") && questionDetail.ordered,
    "the selected question is missing or below the activity log",
    questionDetail,
  );
  check(
    /^H[1-6]$/.test(questionDetail.messageTag) && questionDetail.messageSize >= 13,
    "the question is not a header at body size or larger",
    questionDetail,
  );
  await dismissNotifications();
  await saveShot("issues-draft-detail-question");

  // Reload while both drafts run and one waits: both states and the question replay.
  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="issues-drafts"]') !== null &&
      ${draftStatus("001-question.md")} === "running" &&
      ${draftStatus("002-hang.md")} === "running" &&
      document.querySelector('${draftRow("001-question.md")}')?.getAttribute("data-question") === "true" &&
      document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") ===
        ".devboard/goal-proposals/001-question.md" &&
      document.querySelector('[data-testid="issues-draft-question"]') !== null`,
    "the parallel runs and pending question replayed after reload",
    20_000,
  );
  const replayedQuestion = await page.eval<{ activity: string; question: string }>(`(() => ({
    activity: document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? "",
    question: document.querySelector('[data-testid="issues-draft-question"]')?.textContent ?? "",
  }))()`);
  check(
    replayedQuestion.activity.includes("001-question.md") &&
      !replayedQuestion.activity.includes("002-hang.md") &&
      replayedQuestion.question.includes("Choose an answer"),
    "a replayed detail lost its own activity or question",
    replayedQuestion,
  );

  // Answer only the question draft; its waiting state clears and the hang draft is untouched.
  await page.click('[data-testid="issues-draft-choice"]');
  await page.wait(
    `document.querySelector('${draftRow("001-question.md")}')?.getAttribute("data-question") !== "true" &&
      ${draftAnswer("001-question.md")} === ""`,
    "the waiting state and badge to clear after the answer",
    4_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-question"]') === null &&
      document.querySelector('[data-testid="issues-draft-activity"]')?.textContent?.includes("Answer received: Alpha")
      === true`,
    "the answered question draft to keep running",
    8_000,
  );
  check(
    (await readFile(agentLog, "utf8")).includes("answer Alpha"),
    "the answer did not reach the elaboration peer",
  );

  await page.click(draftRow("002-hang.md"));
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/002-hang.md"`,
    "the hang draft after the other answer",
  );
  const hangAfterAnswer = await page.eval<{ state: string; activity: string; question: boolean }>(`(() => ({
    state: document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() ?? "",
    activity: document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? "",
    question: document.querySelector('[data-testid="issues-draft-question"]') !== null,
  }))()`);
  check(
    hangAfterAnswer.state === "running" &&
      hangAfterAnswer.activity === hangActivity &&
      !hangAfterAnswer.activity.includes("Answer received") &&
      !hangAfterAnswer.question,
    "answering one draft changed another running elaboration",
    hangAfterAnswer,
  );

  // Stop only the selected hang; the question draft keeps running.
  await page.click('[data-testid="issues-draft-stop"]');
  await page.wait(`${draftStatus("002-hang.md")} === "stopped"`, "the stopped elaboration", 8_000);
  await page.wait(`${draftStatus("001-question.md")} === "running"`, "the other elaboration stays running");
  const stopped = await page.eval<{ stop: boolean; start: boolean; present: boolean }>(`(() => ({
    stop: document.querySelector('[data-testid="issues-draft-stop"]') !== null,
    start: document.querySelector('${draftRowStart("002-hang.md")}')?.disabled === false,
    present: document.querySelector('${draftRow("002-hang.md")}') !== null,
  }))()`);
  check(
    !stopped.stop && stopped.start && stopped.present,
    "Stop lost the draft or kept its peer",
    stopped,
  );
  await page.click(draftRow("001-question.md"));
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/001-question.md"`,
    "the unaffected question draft",
  );
  const questionAfterStop = await page.eval<{ state: string; activity: string; question: boolean }>(`(() => ({
    state: document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() ?? "",
    activity: document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? "",
    question: document.querySelector('[data-testid="issues-draft-question"]') !== null,
  }))()`);
  check(
    questionAfterStop.state === "running" &&
      questionAfterStop.activity.includes("001-question.md") &&
      questionAfterStop.activity.includes("Answer received: Alpha") &&
      !questionAfterStop.activity.includes("002-hang.md") &&
      !questionAfterStop.question,
    "stopping another draft changed the question draft",
    questionAfterStop,
  );

  // Third, fourth, and restarted drafts elaborate at the same time; no cap.
  await page.click(draftRowStart("003-hang.md"));
  await page.click(draftRowStart("004-hang.md"));
  await page.click(draftRowStart("002-hang.md"));
  await page.wait(
    ["001-question.md", "002-hang.md", "003-hang.md", "004-hang.md"]
      .map((name) => `(${draftStatus(name)} === "running")`)
      .join(" && "),
    "four drafts running at once",
    8_000,
  );
  const runningRows = await page.eval<number>(
    `[...document.querySelectorAll('[data-testid="issues-draft"]')]
      .filter((row) => row.getAttribute("data-status") === "running").length`,
  );
  check(runningRows === 4, "the page does not run four elaborations at once", runningRows);

  // A reload replays every draft's own running state and the selected path.
  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="issues-drafts"]') !== null &&
      ${["001-question.md", "002-hang.md", "003-hang.md", "004-hang.md"]
        .map((name) => `(${draftStatus(name)} === "running")`)
        .join(" && ")}`,
    "every running draft replayed after reload",
    20_000,
  );
  const replayed = await page.eval<Array<{ path: string; status: string; question: boolean }>>(
    `[...document.querySelectorAll('[data-testid="issues-draft"]')].map((row) => ({
      path: row.getAttribute("data-path") ?? "",
      status: row.getAttribute("data-status") ?? "",
      question: row.getAttribute("data-question") === "true",
    }))`,
  );
  check(
    replayed.filter((row) => row.status === "running").length === 4 &&
      replayed.some((row) => row.path.endsWith("001-question.md") && row.status === "running"),
    "a replayed row lost its own state",
    replayed,
  );
  await page.click(draftRow("003-hang.md"));
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/003-hang.md" &&
      document.querySelector('[data-testid="issues-draft-activity"]')?.textContent?.includes("003-hang.md") === true`,
    "the switched running detail after reload",
    8_000,
  );
  const thirdActivity = await page.eval<string>(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? ""`,
  );
  await dismissNotifications();
  await saveShot("issues-draft-parallel");

  // A failed draft records its own error while the others keep running.
  await page.click(draftRowStart("005-fail.md"));
  await page.wait(`${draftStatus("005-fail.md")} === "failed"`, "the failing draft", 8_000);
  await page.click(draftRow("005-fail.md"));
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ".devboard/goal-proposals/005-fail.md" &&
      document.querySelector('[data-testid="issues-draft-error"]') !== null`,
    "the failed draft detail",
    8_000,
  );
  const draftFailure = await page.eval<{ state: string; error: string; running: number; third: string }>(`(() => ({
    state: document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() ?? "",
    error: document.querySelector('[data-testid="issues-draft-error"]')?.textContent ?? "",
    running: [...document.querySelectorAll('[data-testid="issues-draft"]')]
      .filter((row) => row.getAttribute("data-status") === "running").length,
    third: document.querySelector(${JSON.stringify(draftRow("003-hang.md"))})?.getAttribute("data-status") ?? "",
  }))()`);
  check(
    draftFailure.state === "failed" &&
      draftFailure.error.includes("goal label verification failed") &&
      draftFailure.running === 4 &&
      draftFailure.third === "running",
    "a failed draft disturbed the running elaborations",
    draftFailure,
  );

  // A successful draft disappears while the other runs keep their state.
  const reportName = reportDraftPath.split("/").pop() ?? "";
  const reportSpec = join(host, ".devboard", "goals", reportName);
  await page.click(draftRowStart(reportName));
  await page.wait(`document.querySelector('${draftRow(reportName)}') === null`, "the finished draft to disappear", 8_000);
  check(existsSync(reportSpec), "the successful elaboration did not keep its spec");
  check(
    (await page.eval<number>(
      `[...document.querySelectorAll('[data-testid="issues-draft"]')]
        .filter((row) => row.getAttribute("data-status") === "running").length`,
    )) === 4,
    "a successful draft cleared another draft's running state",
  );
  check(
    (await page.eval<string>(
      `document.querySelector('${draftRow("003-hang.md")}')?.getAttribute("data-status") ?? ""`,
    )) === "running" && thirdActivity.includes("003-hang.md"),
    "the third elaboration lost its state after another success",
  );

  // Stopping the dashboard closes every live peer, not only the newest.
  const dashboardPeerPids = async (): Promise<number[]> => {
    const pids: number[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = (await readFile(join("/proc", entry, "cmdline"))).toString("utf8");
        if (cmdline.includes(stubAgent) && cmdline.includes(agentLog)) pids.push(Number(entry));
      } catch {
        // The process exited while its command line was read.
      }
    }
    return pids;
  };
  const livePeers = await dashboardPeerPids();
  check(livePeers.length === 4, "the dashboard does not own one peer per running draft", livePeers);
  serverProcess?.kill("SIGTERM");
  const peersDeadline = Date.now() + 10_000;
  let survivingPeers = await dashboardPeerPids();
  while (survivingPeers.length > 0 && Date.now() < peersDeadline) {
    await delay(50);
    survivingPeers = await dashboardPeerPids();
  }
  check(survivingPeers.length === 0, "an elaboration peer survived the dashboard stop", survivingPeers);

  startServer();
  await waitForHttp(baseUrl);
  await page.reload();
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "reconnection after the restart",
    30_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-drafts"]') !== null &&
      [...document.querySelectorAll('[data-testid="issues-draft"]')]
        .every((row) => row.getAttribute("data-status") !== "running")`,
    "no replayed running draft after the restart",
    10_000,
  );
  const draftsAfterRestart = await page.eval<{ statuses: string[]; count: number }>(`(() => ({
    statuses: [...document.querySelectorAll('[data-testid="issues-draft"]')]
      .map((row) => row.getAttribute("data-status") ?? ""),
    count: document.querySelectorAll('[data-testid="issues-draft"]').length,
  }))()`);
  check(
    draftsAfterRestart.count === 5 &&
      draftsAfterRestart.statuses.every((status) => status === "failed"),
    "the replacement server restored a running draft or started one",
    draftsAfterRestart,
  );
  const firstInterruptedPath = await page.eval<string>(
    `document.querySelector('[data-testid="issues-draft"]')?.getAttribute("data-path") ?? ""`,
  );
  check(firstInterruptedPath.length > 0, "the replacement listed no interrupted draft", firstInterruptedPath);
  await page.click(`[data-testid="issues-draft"][data-path="${firstInterruptedPath}"]`);
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${firstInterruptedPath}" &&
      document.querySelector('[data-testid="issues-draft-error"]') !== null`,
    "the interrupted draft's error",
  );
  const interruptedError = await page.eval<string>(
    `document.querySelector('[data-testid="issues-draft-error"]')?.textContent ?? ""`,
  );
  check(
    interruptedError.includes("server exit interrupted the elaboration"),
    "the interrupted draft does not name the server exit",
    interruptedError,
  );

  // The Draft goals page creates a goal and starts its elaboration in one step.
  const listDraftFiles = async (): Promise<string[]> =>
    (await readdir(draftDirectory)).filter((name) => name.endsWith(".md")).sort();
  const draftTurns = async (): Promise<number> =>
    (await readFile(agentLog, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("goal-draft ")).length;
  const popoverOpen = `document.querySelector('[data-testid="issues-draft-new-popover"]') !== null`;
  const createdPath = ".devboard/goal-proposals/stub-question-add-a-keyboard-shortcut.md";
  const busyPath = ".devboard/goal-proposals/stub-hang-add-a-shortcut-for.md";
  const createdInstructions =
    "STUB-QUESTION Add a keyboard shortcut for creating a goal.\n\nKeep the drafts list in place.";
  const busyInstructions = "STUB-HANG Add a shortcut for the draft list.";

  const beforeNewGoal = await listDraftFiles();
  check(beforeNewGoal.length === 5, "the one-step creation phase starts with the wrong drafts", beforeNewGoal);
  await page.click('[data-testid="issues-draft-new"]');
  await page.wait(
    `${popoverOpen} && document.querySelector('[data-testid="issues-draft-new-input"]') !== null`,
    "the New goal popover",
  );
  const newGoalChrome = await page.eval<{
    testid: string;
    command: string;
    submit: string;
    cancel: string;
  }>(`(() => ({
    testid: document.querySelector('[data-testid="issues-draft-new"]')?.getAttribute("data-testid") ?? "",
    command: document.querySelector('[data-testid="issues-draft-new"]')?.getAttribute("data-command") ?? "",
    submit: document.querySelector('[data-testid="issues-draft-new-submit"]') !== null ? "yes" : "",
    cancel: document.querySelector('[data-testid="issues-draft-new-cancel"]') !== null ? "yes" : "",
  }))()`);
  check(
    newGoalChrome.testid === "issues-draft-new" &&
      newGoalChrome.command === "issues.draft.new" &&
      newGoalChrome.submit === "yes" &&
      newGoalChrome.cancel === "yes",
    "the New goal control or its popover fields have the wrong ids",
    newGoalChrome,
  );
  check(
    (await listDraftFiles()).join(",") === beforeNewGoal.join(","),
    "opening the New goal popover wrote a draft",
  );
  await page.fill('[data-testid="issues-draft-new-input"]', createdInstructions);
  await dismissNotifications();
  await saveShot("issues-draft-new-goal");
  await page.key("Escape");
  await page.wait(`!(${popoverOpen})`, "Escape to close the New goal popover");
  check(
    (await listDraftFiles()).join(",") === beforeNewGoal.join(","),
    "Escape wrote a draft or started a peer",
  );
  await page.click('[data-testid="issues-draft-new"]');
  await page.wait(popoverOpen, "the New goal popover after Escape");
  await page.click('[data-testid="issues-draft-new-cancel"]');
  await page.wait(`!(${popoverOpen})`, "Cancel to close the New goal popover");
  check(
    (await listDraftFiles()).join(",") === beforeNewGoal.join(","),
    "Cancel wrote a draft or started a peer",
  );

  // One submit writes one context-free draft and starts exactly one peer.
  const turnsBeforeCreate = await draftTurns();
  await page.click('[data-testid="issues-draft-new"]');
  await page.wait(popoverOpen, "the New goal popover for the created draft");
  await page.fill('[data-testid="issues-draft-new-input"]', createdInstructions);
  await page.click('[data-testid="issues-draft-new-submit"]');
  await page.wait(`!(${popoverOpen})`, "the popover to close after creating the goal");
  await page.wait(
    `document.querySelector('[data-testid="issues-draft"][data-path="${createdPath}"]') !== null`,
    "the created draft without a reload",
    8_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${createdPath}" &&
      document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() === "running"`,
    "the created draft's running detail",
    8_000,
  );
  const createdText = await readFile(join(host, createdPath), "utf8");
  check(
    createdText.startsWith(
      "# Proposed goal: STUB-QUESTION Add a keyboard shortcut for creating a goal.\n\n> Unprocessed draft. ",
    ),
    "the created draft has no heading or unprocessed notice",
    createdText,
  );
  check(
    createdText.includes(createdInstructions),
    "the created draft lost the typed instructions",
    createdText,
  );
  check(
    createdText.includes("## Captured UI context\n\nNo page context was captured.\n"),
    "the created draft does not state that no page context was captured",
    createdText,
  );
  check(
    !createdText.includes("- Route:") &&
      !createdText.includes("- URL:") &&
      !createdText.includes("- Selected element:") &&
      !createdText.includes("- Viewport:") &&
      !createdText.includes("- Captured at:") &&
      !createdText.includes("### Visible text") &&
      !createdText.includes("### DOM excerpt"),
    "the created draft invents captured page context",
    createdText,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent?.includes("Reading the draft")`,
    "the created draft's activity",
    8_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-stop"]') !== null`,
    "the created draft's stop control",
  );
  check(
    (await draftTurns()) === turnsBeforeCreate + 1,
    "one submit did not start exactly one elaboration",
  );
  await dismissNotifications();
  await saveShot("issues-draft-new-goal-detail");

  // A question reaches the created draft and its answer advances the turn.
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-question"]') !== null`,
    "the created draft's question",
    8_000,
  );
  const createdActivity = await page.eval<string>(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? ""`,
  );
  const createdQuestion = await page.eval<string>(
    `document.querySelector('[data-testid="issues-draft-question"]')?.textContent ?? ""`,
  );

  // A second submit while the first runs starts its own peer; both keep running.
  const turnsBeforeBusy = await draftTurns();
  await page.click('[data-testid="issues-draft-new"]');
  await page.wait(popoverOpen, "the New goal popover while an elaboration runs");
  await page.fill('[data-testid="issues-draft-new-input"]', busyInstructions);
  await page.click('[data-testid="issues-draft-new-submit"]');
  await page.wait(`!(${popoverOpen})`, "the second popover to close");
  await page.wait(
    `document.querySelector('[data-testid="issues-draft"][data-path="${busyPath}"]') !== null`,
    "the second submit's draft without a reload",
    8_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${busyPath}" &&
      document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() === "running"`,
    "the second submit's running detail",
    8_000,
  );
  const busyStart = await page.eval<{ disabled: boolean; title: string; blockers: number }>(`(() => {
    const start = document.querySelector(
      '[data-testid="issues-draft-row-start"][data-path="${busyPath}"]',
    );
    return {
      disabled: start?.disabled === true,
      title: start?.getAttribute("title") ?? "",
      blockers: document.querySelectorAll('[data-testid="issues-draft-blocked"]').length,
    };
  })()`);
  check(
    existsSync(join(host, busyPath)) &&
      busyStart.disabled &&
      busyStart.title === "This draft is being elaborated." &&
      busyStart.blockers === 0,
    "the second submit did not start its own elaboration",
    busyStart,
  );
  await waitFor(
    async () =>
      (await draftTurns()) === turnsBeforeBusy + 1 ? true : undefined,
    "the second submit's peer",
    15_000,
  );
  check(
    (await draftTurns()) === turnsBeforeBusy + 1,
    "the second submit did not start exactly one more elaboration",
    { before: turnsBeforeBusy, after: await draftTurns() },
  );
  check(
    (await page.eval<string>(
      `document.querySelector('[data-testid="issues-draft"][data-path="${createdPath}"]')?.getAttribute("data-status") ?? ""`,
    )) === "running",
    "the second submit stopped the first elaboration",
  );

  await page.click(`[data-testid="issues-draft"][data-path="${createdPath}"]`);
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${createdPath}" &&
      document.querySelector('[data-testid="issues-draft-question"]') !== null`,
    "the running elaboration after the second submit",
  );
  const undisturbed = await page.eval<{ activity: string; question: string; state: string }>(`(() => ({
    activity: document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? "",
    question: document.querySelector('[data-testid="issues-draft-question"]')?.textContent ?? "",
    state: document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() ?? "",
  }))()`);
  check(
    undisturbed.activity === createdActivity &&
      undisturbed.question === createdQuestion &&
      undisturbed.state === "running",
    "the second submit disturbed the first elaboration",
    undisturbed,
  );
  await page.click('[data-testid="issues-draft-choice"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft"][data-path="${createdPath}"]') === null`,
    "the answered draft to disappear",
    8_000,
  );
  check(
    existsSync(join(host, ".devboard", "goals", "stub-question-add-a-keyboard-shortcut.md")),
    "the answered elaboration did not advance to its spec",
  );

  // The second elaboration outlives the first and stops on its own.
  await page.click(`[data-testid="issues-draft"][data-path="${busyPath}"]`);
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${busyPath}" &&
      document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() === "running"`,
    "the second elaboration after the first finished",
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent?.includes("Reading the draft")`,
    "the second draft's hang activity",
    8_000,
  );
  await page.click('[data-testid="issues-draft-stop"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() === "stopped"`,
    "the second draft's stop",
    8_000,
  );
  const afterCreatedStop = await page.eval<{ stop: boolean; startDisabled: boolean; present: boolean }>(`(() => ({
    stop: document.querySelector('[data-testid="issues-draft-stop"]') !== null,
    startDisabled: document.querySelector(
      '[data-testid="issues-draft-row-start"][data-path="${busyPath}"]',
    )?.disabled === false,
    present: document.querySelector('[data-testid="issues-draft"][data-path="${busyPath}"]') !== null,
  }))()`);
  check(
    !afterCreatedStop.stop && afterCreatedStop.startDisabled && afterCreatedStop.present,
    "stopping the second draft left it unstartable or removed it",
    afterCreatedStop,
  );
  await page.click('[data-testid="issues-draft"][data-path=".devboard/goal-proposals/002-hang.md"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === ` +
      `".devboard/goal-proposals/002-hang.md"`,
    "the selected draft before the report-panel refresh",
  );

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
  check(refreshedCount === "7", "the Drafts count did not follow the new draft", refreshedCount);

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

  // A version reload hands a running elaboration to the replacement.
  await installHarnessCopy(host);
  const questionPath = ".devboard/goal-proposals/010-question.md";
  const hangPath = ".devboard/goal-proposals/011-hang.md";
  await mkdir(join(host, ".devboard", "goal-proposals"), { recursive: true });
  await writeFile(
    join(host, questionPath),
    "# Question draft\n\n> Unprocessed draft. STUB-QUESTION\n\nAsk about the scope before finalizing.\n",
  );
  await writeFile(
    join(host, hangPath),
    "# Hang draft\n\n> Unprocessed draft. STUB-HANG\n\nKeep this elaboration running until it is stopped.\n",
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft"][data-path="${questionPath}"]') !== null`,
    "the question draft after reseeding",
    10_000,
  );
  await page.click(`[data-testid="issues-draft"][data-path="${questionPath}"]`);
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${questionPath}"`,
    "the question draft detail before the version reload",
  );
  const startLines = async (): Promise<string[]> =>
    (await agentLogLines(agentLog)).filter((line) => line.startsWith("goal-draft-start "));
  const startsBeforeQuestion = (await startLines()).length;
  await page.click(
    `[data-testid="issues-draft-row-start"][data-path="${questionPath}"]`,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-activity"]')?.textContent?.includes("Reading the draft") === true`,
    "the streamed elaboration activity before the version reload",
    10_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-question"]') !== null`,
    "the pending question before the version reload",
    10_000,
  );
  const questionPeerPid = await waitFor(
    async () => {
      const pids = (await startLines()).map((line) =>
        Number(line.slice("goal-draft-start ".length)),
      );
      return pids[startsBeforeQuestion];
    },
    "the question peer's pid",
    10_000,
  );
  type DraftQuestionSurface = {
    activity: string;
    message: string;
    options: string[];
    recommended: number;
    labelFont: number;
    descriptionFont: number;
  };
  const readQuestionSurface = (): Promise<DraftQuestionSurface> =>
    page.eval<DraftQuestionSurface>(`(() => {
      const question = document.querySelector('[data-testid="issues-draft-question"]');
      const choices = [...document.querySelectorAll('[data-testid="issues-draft-choice"]')];
      const label = choices[0]?.querySelector('.choice__label');
      const description = choices[0]?.querySelector('.choice__description');
      return {
        activity: document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? "",
        message: question?.textContent?.trim() ?? "",
        options: choices.map((choice) => choice.textContent?.trim() ?? ""),
        recommended: choices.findIndex(
          (choice) => choice.querySelector('.choice__recommended') !== null,
        ),
        labelFont: label ? parseFloat(getComputedStyle(label).fontSize) : 0,
        descriptionFont: description ? parseFloat(getComputedStyle(description).fontSize) : 0,
      };
    })()`);
  const questionSurfaceBefore = await readQuestionSurface();
  check(
    questionSurfaceBefore.options.length === 2,
    "the elaboration question has no options",
    questionSurfaceBefore,
  );
  check(
    questionSurfaceBefore.labelFont >= 13 && questionSurfaceBefore.descriptionFont >= 13,
    "the elaboration question options are too small to read",
    questionSurfaceBefore,
  );

  expectedReloadFailures = true;
  await page.click('[data-testid="reload-devboard"]');
  await page.wait(
    `(() => {
      const entries = [...document.querySelectorAll('[data-testid="status-bar"] .status-versions__entry')];
      const version = (label) => entries
        .find((entry) => entry.querySelector('.status-metric__label')?.textContent === label)
        ?.querySelector('.mono')?.textContent ?? "";
      return version("running") === "${INSTALLED_VERSION}" &&
        version("installed") === "${INSTALLED_VERSION}" &&
        document.querySelector('[data-testid="reload-devboard"]') === null;
    })()`,
    "the installed replacement without a stale reload control",
    40_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the replacement connection",
    30_000,
  );
  expectedReloadFailures = false;
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${questionPath}"`,
    "the same draft after the version reload",
    20_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() === "running"`,
    "the running state after the version reload",
    20_000,
  );
  await page.wait(
    `(document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? "")
      .startsWith(${JSON.stringify(questionSurfaceBefore.activity)})`,
    "the retained activity after the version reload",
    20_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-question"]') !== null`,
    "the retained question after the version reload",
    20_000,
  );
  const questionSurfaceAfter = await readQuestionSurface();
  check(
    questionSurfaceAfter.message === questionSurfaceBefore.message &&
      JSON.stringify(questionSurfaceAfter.options) ===
        JSON.stringify(questionSurfaceBefore.options) &&
      questionSurfaceAfter.recommended === questionSurfaceBefore.recommended,
    "the pending question changed across the version reload",
    { before: questionSurfaceBefore, after: questionSurfaceAfter },
  );
  check(
    processRunning(questionPeerPid),
    "the original elaboration peer did not survive the version reload",
    questionPeerPid,
  );
  const startsAfterQuestion = await startLines();
  check(
    startsAfterQuestion.length === startsBeforeQuestion + 1,
    "the version reload started a second elaboration peer",
    startsAfterQuestion,
  );
  const questionPrompts = (await agentLogLines(agentLog)).filter(
    (line) => line === `goal-draft ${questionPath}`,
  );
  check(
    questionPrompts.length === 1,
    "the version reload sent the elaboration prompt again",
    questionPrompts,
  );
  const runningControls = await page.eval<{
    startDisabled: boolean;
    startTitle: string;
    stop: boolean;
  }>(`(() => {
    const start = document.querySelector(
      '[data-testid="issues-draft-row-start"][data-path="${questionPath}"]',
    );
    return {
      startDisabled: start instanceof HTMLButtonElement ? start.disabled : false,
      startTitle: start?.getAttribute("title") ?? "",
      stop: document.querySelector('[data-testid="issues-draft-stop"]') !== null,
    };
  })()`);
  check(
    runningControls.startDisabled &&
      runningControls.startTitle === "This draft is being elaborated." &&
      runningControls.stop,
    "the running draft's controls changed after the version reload",
    runningControls,
  );

  const answersBefore = (await agentLogLines(agentLog)).filter((line) => line === "answer Alpha")
    .length;
  await page.click('[data-testid="issues-draft-choice"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft"][data-path="${questionPath}"]') === null`,
    "the answered draft to leave the list",
    10_000,
  );
  check(
    existsSync(join(host, ".devboard", "goals", "010-question.md")),
    "the answered elaboration did not keep its spec",
  );
  const answersAfter = (await agentLogLines(agentLog)).filter((line) => line === "answer Alpha")
    .length;
  check(
    answersAfter === answersBefore + 1,
    "the answer after the version reload did not reach exactly one peer",
    { answersBefore, answersAfter },
  );

  // A newer install makes the running replacement stale again. A replacement
  // that cannot start leaves the same fallback control available.
  await writeInstalledVersion(host, NEXT_INSTALLED_VERSION);
  await page.wait(
    `document.querySelector('[data-testid="reload-devboard"]') !== null`,
    "the reload control for the newer install",
    10_000,
  );

  await page.click(`[data-testid="issues-draft"][data-path="${hangPath}"]`);
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${hangPath}"`,
    "the hanging draft detail before its reload",
  );
  const startsBeforeHang = (await startLines()).length;
  await page.click(`[data-testid="issues-draft-row-start"][data-path="${hangPath}"]`);
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-stop"]') !== null &&
      (document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? "")
        .includes("Reading the draft")`,
    "the hanging elaboration before its reload",
    10_000,
  );
  const hangPeerPid = await waitFor(
    async () => {
      const pids = (await startLines()).map((line) =>
        Number(line.slice("goal-draft-start ".length)),
      );
      return pids[startsBeforeHang];
    },
    "the hanging peer's pid",
    10_000,
  );
  expectedReloadFailures = true;
  await page.click('[data-testid="reload-devboard"]');
  await page.wait(
    `(() => {
      const entries = [...document.querySelectorAll('[data-testid="status-bar"] .status-versions__entry')];
      const version = (label) => entries
        .find((entry) => entry.querySelector('.status-metric__label')?.textContent === label)
        ?.querySelector('.mono')?.textContent ?? "";
      return version("running") === "${NEXT_INSTALLED_VERSION}" &&
        version("installed") === "${NEXT_INSTALLED_VERSION}" &&
        document.querySelector('[data-testid="reload-devboard"]') === null;
    })()`,
    "the installed replacement for the hanging draft",
    40_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-detail"]')?.getAttribute("data-path") === "${hangPath}" &&
      document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() === "running"`,
    "the hanging elaboration after its reload",
    20_000,
  );
  expectedReloadFailures = false;
  await page.wait(
    `(document.querySelector('[data-testid="issues-draft-activity"]')?.textContent ?? "")
      .includes("Reading the draft")`,
    "the retained hanging activity after its reload",
    20_000,
  );
  check(processRunning(hangPeerPid), "the hanging peer did not survive its reload", hangPeerPid);
  await saveShot("issues-draft-after-reload");

  await page.click('[data-testid="issues-draft-stop"]');
  await page.wait(
    `document.querySelector('[data-testid="issues-draft-state"]')?.textContent?.trim() === "stopped"`,
    "the stopped elaboration after its reload",
    10_000,
  );
  const stoppedSurface = await page.eval<{
    stop: boolean;
    startDisabled: boolean;
    listed: boolean;
  }>(`(() => {
    const start = document.querySelector(
      '[data-testid="issues-draft-row-start"][data-path="${hangPath}"]',
    );
    return {
      stop: document.querySelector('[data-testid="issues-draft-stop"]') !== null,
      startDisabled: start instanceof HTMLButtonElement ? start.disabled : true,
      listed: document.querySelector('[data-testid="issues-draft"][data-path="${hangPath}"]') !== null,
    };
  })()`);
  check(
    !stoppedSurface.stop && !stoppedSurface.startDisabled && stoppedSurface.listed,
    "Stop after a reload did not stop its peer and keep the draft",
    stoppedSurface,
  );
  await waitFor(
    () => (processRunning(hangPeerPid) ? undefined : true),
    "the stopped elaboration peer",
    5_000,
  );
  check(
    goalDraftOwnerPids(host).length === 0,
    "the stopped elaboration left its owner process",
    goalDraftOwnerPids(host),
  );

  // Return to the source dashboard so the remaining checks see its gate.
  await stopHostDashboards(host);
  await removeHarnessCopy(host);
  serverProcess = undefined;
  startServer();
  await waitForHttp(baseUrl);
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnected source dashboard",
    40_000,
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

  // 15b. Two live worker versions: every running task names the version that
  // owns it, and the older worker's drain never becomes the family's pause.
  await seedMixedIssuesState(stateDir, host);
  await page.wait(
    `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues working (2)"`,
    "the family headline during the mixed-version takeover",
    10_000,
  );
  const mixedIndicator = await page.eval<{
    text: string;
    title: string;
    label: string;
  }>(`(() => {
    const item = document.querySelector('[data-testid="issues-indicator"]');
    return {
      text: item?.textContent?.trim() ?? "",
      title: item?.getAttribute("title") ?? "",
      label: item?.getAttribute("aria-label") ?? "",
    };
  })()`);
  check(
    mixedIndicator.text === "issues working (2)" &&
      mixedIndicator.title.includes("2 running agent") &&
      !/pausing|draining|drain/i.test(mixedIndicator.text) &&
      !/pausing|draining|drain/i.test(mixedIndicator.title) &&
      !/pausing|draining|drain/i.test(mixedIndicator.label),
    "the status indicator reports the older worker's drain instead of the family's work",
    mixedIndicator,
  );
  await page.wait(
    `document.querySelector('[data-testid="issues-poll-text"]')?.textContent?.trim()?.startsWith("Every 10s · checked ") === true`,
    "the takeover poll line to report polling",
    10_000,
  );
  const mixedPoll = await page.eval<{ text: string; title: string }>(`(() => {
    const poll = document.querySelector('[data-testid="issues-poll"]');
    return {
      text: poll?.querySelector('[data-testid="issues-poll-text"]')?.textContent?.trim() ?? "",
      title: poll?.getAttribute("title") ?? "",
    };
  })()`);
  check(
    !/pausing|draining|drain/i.test(mixedPoll.text) && !/pausing|draining|drain/i.test(mixedPoll.title),
    "the takeover poll line reports the drained worker as paused",
    mixedPoll,
  );
  const mixedRows = await page.eval<Array<{ issue: string; version: string }>>(
    `[...document.querySelectorAll('[data-testid="issues-agent-summary"] .issues-agent-row')].map((row) => ({
      issue: row.getAttribute("data-issue") ?? "",
      version: row.querySelector('[data-testid="issues-agent-row-version"]')?.textContent?.trim() ?? "",
    }))`,
  );
  check(
    mixedRows.length === 2 &&
      mixedRows.some((row) => row.issue === "17" && row.version === MIXED_OLD_VERSION) &&
      mixedRows.some((row) => row.issue === "18" && row.version === seedVersion),
    "the overview does not attribute a mixed-version takeover's tasks",
    mixedRows,
  );
  await saveShot("issues-mixed-version-overview");

  await runPalette("open.issues.agents");
  await page.wait(
    `document.querySelectorAll('[data-testid="issues-agent"]').length === 2`,
    "the two mixed-version agent cards",
    8_000,
  );
  const mixedCards = await page.eval<Array<{ issue: string; version: string }>>(
    `[...document.querySelectorAll('[data-testid="issues-agent"]')].map((card) => ({
      issue: card.getAttribute("data-issue") ?? "",
      version: card.querySelector('[data-testid="issues-agent-version"]')?.textContent?.trim() ?? "",
    }))`,
  );
  check(
    mixedCards.some((card) => card.issue === "17" && card.version.includes(MIXED_OLD_VERSION)) &&
      mixedCards.some((card) => card.issue === "18" && card.version.includes(seedVersion)),
    "an agents card does not attribute a mixed-version takeover's task",
    mixedCards,
  );
  const mixedWorkerList = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="issues-worker"]')].map((item) => item.textContent?.trim() ?? "")`,
  );
  check(
    mixedWorkerList.includes(MIXED_OLD_VERSION) && mixedWorkerList.includes(seedVersion),
    "the Agents header does not list both live worker versions",
    mixedWorkerList,
  );

  await page.click('[data-testid="open-issues-queue"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="issues-queue-item"]').length === 4`,
    "the takeover queue rows",
    8_000,
  );
  const mixedQueue = await page.eval<Array<{ issue: string; processing: string }>>(
    `[...document.querySelectorAll('[data-testid="issues-queue-item"]')].map((item) => ({
      issue: item.getAttribute("data-number") ?? "",
      processing: item.getAttribute("data-processing") ?? "",
    }))`,
  );
  check(
    mixedQueue.length === 4 &&
      mixedQueue.some((row) => row.issue === "17" && row.processing === "true") &&
      mixedQueue.some((row) => row.issue === "18" && row.processing === "true") &&
      mixedQueue.filter((row) => row.processing === "true").length === 2,
    "the queue does not show the takeover's processing labels",
    mixedQueue,
  );

  await runPalette("open.issues.runs");
  await page.wait(`document.querySelector('[data-testid="issues-runs"]') !== null`, "the takeover runs page");
  const mixedRunRows = await page.eval<Array<{ run: string; version: string }>>(
    `[...document.querySelectorAll('[data-testid="issues-run"]')].map((item) => ({
      run: item.getAttribute("data-run") ?? "",
      version: item.querySelector('[data-testid="issues-run-version"]')?.textContent?.trim() ?? "",
    }))`,
  );
  check(
    mixedRunRows.some((row) => row.run === MIXED_OLD_RUN && row.version === MIXED_OLD_VERSION) &&
      mixedRunRows.some((row) => row.run === MIXED_NEW_RUN && row.version === seedVersion),
    "the run history does not name both owning versions",
    mixedRunRows,
  );
  await page.click(`[data-testid="issues-run"][data-run="${MIXED_OLD_RUN}"]`);
  await page.wait(`document.querySelector('[data-testid="issues-run-detail"]') !== null`, "the old run detail");
  const mixedDetail = await page.eval<{ run: string; status: string; version: string }>(`(() => {
    const detail = document.querySelector('[data-testid="issues-run-detail"]');
    return {
      run: detail?.getAttribute("data-run") ?? "",
      status: detail?.querySelector('.badge')?.textContent?.trim() ?? "",
      version: detail?.querySelector('[data-testid="issues-run-version-detail"]')?.textContent?.trim() ?? "",
    };
  })()`);
  check(
    mixedDetail.run === MIXED_OLD_RUN &&
      mixedDetail.status === "running" &&
      mixedDetail.version.includes(MIXED_OLD_VERSION),
    "the draining task's run detail is not intact and attributed",
    mixedDetail,
  );

  const drainVocabulary = await page.eval<string[]>(`(() => {
    const found = [];
    const scan = (scope, name) => {
      if (scope === null) return;
      const text = scope.innerText ?? "";
      if (/pausing|draining|drain/i.test(text)) found.push(name + ":text:" + text.slice(0, 160));
      for (const node of [scope, ...scope.querySelectorAll("[title], [aria-label]")]) {
        if (!(node instanceof Element)) continue;
        for (const attribute of ["title", "aria-label"]) {
          const value = node.getAttribute(attribute) ?? "";
          if (/pausing|draining|drain/i.test(value)) found.push(name + ":" + attribute + ":" + value);
        }
      }
    };
    scan(document.getElementById("workspace-issues"), "issues");
    scan(document.querySelector('[data-testid="issues-indicator"]'), "indicator");
    return found;
  })()`);
  check(drainVocabulary.length === 0, "the takeover renders drain vocabulary", drainVocabulary);

  // The older worker retires: its run stays readable with its own version,
  // the live list drops it, and every running task names the newer version.
  try {
    process.kill(mixedWorkerPids[0]!, "SIGKILL");
  } catch {
    // Already gone.
  }
  await rm(versionLockPath(lockPath(resolve(host)), MIXED_OLD_VERSION), { force: true });
  await page.wait(
    `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues working (1)"`,
    "the family headline after the older worker retired",
    10_000,
  );
  await runPalette("open.issues.agents");
  await page.wait(
    `document.querySelectorAll('[data-testid="issues-agent"]').length === 1`,
    "the single running task after retirement",
    8_000,
  );
  const retiredWorkers = await page.eval<string[]>(
    `[...document.querySelectorAll('[data-testid="issues-worker"]')].map((item) => item.textContent?.trim() ?? "")`,
  );
  check(
    retiredWorkers.length === 1 && retiredWorkers[0] === seedVersion,
    "the live worker list still contains the retired worker",
    retiredWorkers,
  );
  const retiredCard = await page.eval<string>(
    `document.querySelector('[data-testid="issues-agent"] [data-testid="issues-agent-version"]')?.textContent?.trim() ?? ""`,
  );
  check(retiredCard.includes(seedVersion), "the surviving task does not name the newer version", retiredCard);
  await runPalette("open.issues.runs");
  await page.wait(`document.querySelector('[data-testid="issues-runs"]') !== null`, "the history after retirement");
  const retiredRuns = await page.eval<Array<{ run: string; version: string }>>(
    `[...document.querySelectorAll('[data-testid="issues-run"]')].map((item) => ({
      run: item.getAttribute("data-run") ?? "",
      version: item.querySelector('[data-testid="issues-run-version"]')?.textContent?.trim() ?? "",
    }))`,
  );
  check(
    retiredRuns.some((row) => row.run === MIXED_OLD_RUN && row.version === MIXED_OLD_VERSION),
    "the retired worker's run lost its version in history",
    retiredRuns,
  );
  await clearMixedIssuesState(stateDir, host);
  await page.wait(
    `document.querySelector('[data-testid="issues-indicator"]')?.textContent?.trim() === "issues stopped"`,
    "the stopped indicator after the mixed-version fixture",
    10_000,
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
  await page.wait(`document.querySelector('[data-testid="goal-text"]') !== null`, "the Goal document while disconnected");
  await page.click('[data-testid="revise-goal"]');
  await page.wait(
    `[...document.querySelectorAll('[data-testid="notifications"] .notification')].some((entry) => entry.textContent.includes("Not connected"))`,
    "the disconnected-command notification",
    20_000,
  );
  const notification = await page.eval<{
    severity: string;
    text: string;
    count: number;
    live: string;
    frame: { top: number; right: number; bottom: number; left: number; leftColor: string; topColor: string };
  }>(`(() => {
    const entries = [...document.querySelectorAll('[data-testid="notifications"] .notification')];
    const entry = entries.find((item) => item.textContent.includes("Not connected")) ?? entries[0];
    const style = entry === undefined ? null : getComputedStyle(entry);
    return {
      severity: entry?.getAttribute("data-severity") ?? "",
      text: entry?.textContent?.trim() ?? "",
      count: entries.length,
      live: document.querySelector('[data-testid="notifications"]')?.getAttribute("aria-live") ?? "",
      frame: {
        top: style === null ? 0 : parseFloat(style.borderTopWidth),
        right: style === null ? 0 : parseFloat(style.borderRightWidth),
        bottom: style === null ? 0 : parseFloat(style.borderBottomWidth),
        left: style === null ? 0 : parseFloat(style.borderLeftWidth),
        leftColor: style?.borderLeftColor ?? "",
        topColor: style?.borderTopColor ?? "",
      },
    };
  })()`);
  check(notification.severity.length > 0 && notification.text.length > 0, "the notification region has no severity or text", notification);
  check(notification.live === "polite", "the notification region is not a live region", notification);
  check(
    notification.frame.top === 1 &&
      notification.frame.right === 1 &&
      notification.frame.bottom === 1 &&
      notification.frame.left === 1 &&
      notification.frame.leftColor === notification.frame.topColor,
    "the notification card does not carry a uniform 1px frame",
    notification.frame,
  );
  const notificationFocus = await page.eval<boolean>(`document.activeElement?.closest('[data-testid="notifications"]') === null`);
  check(notificationFocus, "a notification stole focus");
  // The card closes itself after five seconds; a fresh refusal keeps the
  // dismiss control measurable while its hover state is forced.
  const cardsBefore = await page.eval<number>(
    `document.querySelectorAll('[data-testid="notifications"] .notification').length`,
  );
  await page.click('[data-testid="revise-goal"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="notifications"] .notification').length > ${cardsBefore}`,
    "a fresh disconnected notification",
    15_000,
  );
  const dismissControl = await page.eval<{
    width: number;
    height: number;
    background: string;
    color: string;
    foreground: string;
    label: string;
    title: string;
    command: string;
    id: string;
    target: boolean;
  }>(`(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;color:var(--foreground)";
    document.body.append(probe);
    const foreground = getComputedStyle(probe).color;
    probe.remove();
    const button = document.querySelector('[data-testid="notifications"] [data-command="app.notifications.dismiss"]');
    const rect = button?.getBoundingClientRect();
    const style = button === null ? null : getComputedStyle(button);
    return {
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      background: style?.backgroundColor ?? "",
      color: style?.color ?? "",
      foreground,
      label: button?.getAttribute("aria-label") ?? "",
      title: button?.getAttribute("title") ?? "",
      command: button?.getAttribute("data-command") ?? "",
      id: button?.closest(".notification")?.getAttribute("data-notification-id") ?? "",
      target: (button?.closest(".notification")?.textContent ?? "").includes("Not connected"),
    };
  })()`);
  check(
    dismissControl.width === 28 &&
      dismissControl.height === 28 &&
      dismissControl.background === "rgba(0, 0, 0, 0)" &&
      dismissControl.color === dismissControl.foreground,
    "the notification dismiss control is not a 28px ghost icon button",
    dismissControl,
  );
  check(
    dismissControl.label === "Dismiss notification" &&
      dismissControl.title === "Dismiss notification" &&
      dismissControl.command === "app.notifications.dismiss" &&
      dismissControl.id.length > 0,
    "the notification dismiss control lost its accessible name or command",
    dismissControl,
  );
  // Headless Chrome keeps the pointer off a fixed overlay here, so the hover
  // wiring is read from the control's own classes and the live hover media.
  const dismissHover = await page.eval<{ classes: string; hoverMedia: boolean }>(`(() => {
    const button = [...document.querySelectorAll('[data-testid="notifications"] [data-command="app.notifications.dismiss"]')]
      .find((entry) => entry.getClientRects().length > 0);
    return {
      classes: button === undefined ? "" : button.className,
      hoverMedia: matchMedia("(hover: hover)").matches,
    };
  })()`);
  check(
    dismissHover.classes.includes("hover:bg-[var(--secondary-hover)]") && dismissHover.hoverMedia,
    "the notification dismiss control is not wired to the secondary-hover fill",
    dismissHover,
  );
  if (!dismissControl.target) {
    await page.click('[data-testid="notifications"] [data-command="app.notifications.dismiss"]');
    await page.wait(
      `document.querySelector('[data-testid="notifications"] .notification[data-notification-id="${dismissControl.id}"]') === null`,
      "the dismissed notification",
    );
  } else {
    // The filing flow below needs this card's history entry, so let the card
    // close itself instead of dismissing it from the history too.
    await page.wait(
      `document.querySelector('[data-testid="notifications"] .notification[data-notification-id="${dismissControl.id}"]') === null`,
      "the expired notification card",
      10_000,
    );
  }
  // The card closes itself after five seconds, so the rest of the filing flow
  // runs on its history entry, where the same controls stay available.
  await saveShot("notification-issue-file");
  await page.click('[data-testid="notification-indicator"]');
  await page.wait(
    `document.querySelector('[data-testid="notification-history"]') !== null`,
    "the notification history",
  );
  startServer();
  await waitForHttp(baseUrl);
  await page.wait(`document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`, "reconnection", 30_000);
  await clearFeedback();
  const notificationFile = await page.eval<{
    present: boolean;
    label: string;
    text: string;
    disabled: boolean;
  }>(`(() => {
    const entry = [...document.querySelectorAll('[data-testid="notification-history"] .notification')].find(
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
      const entry = [...document.querySelectorAll('[data-testid="notification-history"] .notification')].find(
        (item) => item.textContent.includes("Not connected"),
      );
      entry?.querySelector(".notification__file")?.click();
    })()`);

  // A failed filing keeps the card and returns the button for a retry.
  await setFeedbackMode("fail");
  await clickNotificationFile();
  await page.wait(
    `[...document.querySelectorAll('[data-testid="notification-history"] .notification')].some(
      (entry) =>
        entry.textContent.includes("Not connected") &&
        entry.querySelector(".notification__error")?.textContent?.includes("Issue creation failed") === true,
    )`,
    "the notification filing error",
    20_000,
  );
  const notificationFailure = await page.eval<{ text: string; retry: boolean }>(`(() => {
    const entry = [...document.querySelectorAll('[data-testid="notification-history"] .notification')].find(
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
    `[...document.querySelectorAll('[data-testid="notification-history"] .notification')].some(
      (entry) => entry.textContent.includes("Not connected") && entry.querySelector(".notification__link") !== null,
    )`,
    "the notification issue link",
    20_000,
  );
  const notificationCall = feedbackCalls[1]!;
  check(
    notificationCall.title.includes("[ui] Error notification: ") &&
      notificationCall.title.includes("Not connected"),
    "a notification issue has the wrong title",
    notificationCall.title,
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
      feedbackRequests.every((request) => request.action === "REPORT") &&
      String(feedbackRequests[1]?.report).startsWith("Error notification: ") &&
      String(feedbackRequests[1]?.report).includes("Raised at: "),
    "the notification filing request is wrong",
    feedbackRequests,
  );
  const notificationLink = await page.eval<{ text: string; href: string }>(`(() => {
    const entry = [...document.querySelectorAll('[data-testid="notification-history"] .notification')].find(
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
  const dismiss = await page.eval<boolean>(`(() => {
    const button = document.querySelector(
      '[data-testid="notification-history"] .notification [aria-label="Dismiss notification"]',
    );
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  check(dismiss, "the notification history has no dismissal control");
  await page.key("Escape");
  await page.wait(`document.querySelector('[data-testid="notification-history"]') === null`, "the history to close");

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

  // 19. One shared single-agent activity bar, and no bar on a fleet page.
  const barIn = async (mode: string): Promise<{
    bars: number;
    dot: string;
    last: string;
    expanded: string;
    control: boolean;
    question: boolean;
    outsideScroll: boolean;
    removed: boolean;
  }> =>
    page.eval<{
      bars: number;
      dot: string;
      last: string;
      expanded: string;
      control: boolean;
      question: boolean;
      outsideScroll: boolean;
      removed: boolean;
    }>(`(() => {
      const root = document.querySelector('#workspace-${mode}');
      const bar = root?.querySelector('[data-testid="agent-activity-bar"]');
      return {
        bars: root?.querySelectorAll('[data-testid="agent-activity-bar"]').length ?? 0,
        dot: bar?.querySelector('[data-testid="agent-activity-dot"]')?.getAttribute('data-state') ?? '',
        last: bar?.querySelector('[data-testid="agent-activity-last"]')?.textContent?.trim() ?? '',
        expanded:
          bar?.querySelector('[data-testid="agent-activity-toggle"]')?.getAttribute('aria-expanded') ?? '',
        control: bar?.querySelector('[data-testid="agent-activity-control"]') !== null,
        question: bar?.querySelector('[data-testid="agent-activity-question"]') !== null,
        outsideScroll: bar !== null && bar.closest('.scroll-column') === null,
        removed:
          root?.querySelector('[data-testid="agent-lifecycle"]') !== null ||
          root?.querySelector('[data-testid="agent-detail"]') !== null ||
          root?.querySelector('[data-testid="discover-run-tag"]') !== null ||
          root?.querySelector('[data-testid="discover-agent-run-tag"]') !== null ||
          root?.querySelector('[data-testid="discover-agent-status"]') !== null ||
          root?.querySelector('[data-testid="issues-agent-focus-run"]') !== null ||
          root?.querySelector('[data-testid="issues-agent-focus-activity"]') !== null ||
          root?.querySelector('[data-testid="lane-status"]') !== null ||
          root?.querySelector('[data-testid="lane-activity"]') !== null ||
          root?.querySelector('[data-testid="flow-status"]') !== null ||
          root?.querySelector('[data-testid="flow-activity-section"]') !== null ||
          root?.querySelector('[data-testid="flow-goal-activity"]') !== null ||
          root?.querySelector('[data-testid="flow-conversation-activity"]') !== null,
      };
    })()`);

  await runPalette("discover.tab.overview");
  await page.wait(
    `document.querySelector('[data-testid="discover-panel"][data-tab="overview"]') !== null`,
    "the Discover overview for the activity bar",
  );
  const idleDiscover = await barIn("discover");
  check(
    idleDiscover.bars === 1 &&
      idleDiscover.outsideScroll &&
      !idleDiscover.removed &&
      idleDiscover.expanded === "false",
    "the Discover overview does not render one collapsed activity bar",
    idleDiscover,
  );
  const discoverRunStart = Date.now();
  await page.click('#workspace-discover [data-testid="discover-start"]');
  await page.wait(
    `document.querySelector('#workspace-discover [data-testid="agent-activity-dot"]')?.getAttribute("data-state") === "running" &&
     document.querySelector('#workspace-discover [data-testid="discover-stop"]') !== null`,
    "the running Discover activity bar",
    30_000,
  );
  const runningDiscover = await page.eval<{
    dot: string;
    title: string;
    label: string;
    color: string;
    accent: string;
    animation: string;
    duration: string;
    rowText: string;
  }>(`(() => {
    const dot = document.querySelector('#workspace-discover [data-testid="agent-activity-dot"]');
    const toggle = document.querySelector('#workspace-discover [data-testid="agent-activity-toggle"]');
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;background:var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = dot === null ? null : getComputedStyle(dot);
    return {
      dot: dot?.getAttribute("data-state") ?? "",
      title: toggle?.getAttribute("title") ?? "",
      label: dot?.getAttribute("aria-label") ?? "",
      color: style?.backgroundColor ?? "",
      accent,
      animation: style?.animationName ?? "",
      duration: style?.animationDuration ?? "",
      rowText: document.querySelector('#workspace-discover [data-testid="agent-activity-bar"]')?.textContent ?? "",
    };
  })()`);
  const dotStarted = Date.parse(runningDiscover.title);
  check(
    runningDiscover.dot === "running" &&
      Number.isFinite(dotStarted) &&
      dotStarted >= discoverRunStart - 1_000 &&
      dotStarted <= Date.now() + 1_000,
    "the running dot does not carry the run's ISO start time",
    runningDiscover,
  );
  check(
    runningDiscover.label.includes(runningDiscover.title),
    "the dot's accessible name does not state the start time",
    runningDiscover,
  );
  check(
    runningDiscover.color === runningDiscover.accent,
    "the running dot does not use the accent token",
    runningDiscover,
  );
  check(runningDiscover.animation !== "none", "the running dot does not pulse", runningDiscover);
  const pulseSeconds = Math.max(
    ...runningDiscover.duration.split(",").map((value) => Number.parseFloat(value) || 0),
  );
  check(
    pulseSeconds >= 1.2 && pulseSeconds <= 2.5,
    "the pulse period is outside 1.2–2.5 seconds",
    runningDiscover,
  );
  check(
    !runningDiscover.rowText.includes("Run in progress") &&
      !runningDiscover.rowText.includes("Running") &&
      !runningDiscover.rowText.includes("started ") &&
      !runningDiscover.rowText.includes("2026-"),
    "the collapsed row repeats run status text",
    runningDiscover,
  );

  // Click, keyboard, and a second activation all toggle the inline panel.
  await page.click('#workspace-discover [data-testid="agent-activity-toggle"]');
  await page.wait(
    `document.querySelector('#workspace-discover [data-testid="agent-activity-toggle"]')?.getAttribute("aria-expanded") === "true" &&
     document.querySelector('#workspace-discover [data-testid="agent-activity-log"]') !== null`,
    "the expanded Discover activity log",
  );
  const expandedDiscover = await page.eval<{
    lines: number;
    scrolls: boolean;
    inBody: boolean;
  }>(`(() => {
    const log = document.querySelector('#workspace-discover [data-testid="agent-activity-log"]');
    return {
      lines: log?.querySelectorAll('.agent-activity-bar__line').length ?? 0,
      scrolls: log !== null && log.scrollHeight > log.clientHeight,
      inBody: log !== null && log.closest('.scroll-column') === null,
    };
  })()`);
  check(
    expandedDiscover.lines > 1 && expandedDiscover.inBody,
    "the expanded Discover log has no multi-line activity",
    expandedDiscover,
  );
  await page.click('#workspace-discover [data-testid="agent-activity-toggle"]');
  await page.wait(
    `document.querySelector('#workspace-discover [data-testid="agent-activity-toggle"]')?.getAttribute("aria-expanded") === "false"`,
    "the collapsed Discover bar",
  );
  await page.focus('#workspace-discover [data-testid="agent-activity-toggle"]');
  await page.keyWithText("Enter", "\r");
  await page.wait(
    `document.querySelector('#workspace-discover [data-testid="agent-activity-toggle"]')?.getAttribute("aria-expanded") === "true"`,
    "the keyboard-expanded Discover bar",
  );
  await page.keyWithText("Enter", "\r");
  await page.wait(
    `document.querySelector('#workspace-discover [data-testid="agent-activity-toggle"]')?.getAttribute("aria-expanded") === "false"`,
    "the keyboard-collapsed Discover bar",
  );

  // The bar is pinned above the scrolling column.
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1024 && innerHeight === 720`, "the short viewport for the scroll check");
  const pinned = await page.eval<{ before: number; after: number; visible: boolean; scrolled: boolean }>(`(async () => {
    const bar = document.querySelector('#workspace-discover [data-testid="agent-activity-bar"]');
    const column = document.querySelector('#workspace-discover .scroll-column');
    const before = Math.round(bar?.getBoundingClientRect().top ?? -1);
    if (column !== null) column.scrollTop = 400;
    await new Promise((settle) => requestAnimationFrame(() => settle(true)));
    const rect = bar?.getBoundingClientRect();
    return {
      before,
      after: Math.round(rect?.top ?? -1),
      visible: rect !== undefined && rect.top >= 0 && rect.bottom <= innerHeight,
      scrolled: column !== null && column.scrollTop > 0,
    };
  })()`);
  check(
    pinned.before === pinned.after && pinned.visible && pinned.scrolled,
    "scrolling the Discover page moves the activity bar",
    pinned,
  );
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.wait(`innerWidth === 1440 && innerHeight === 900`, "the viewport after the scroll check");

  // Reduced motion stops the pulse and keeps the running state.
  await devtools.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reducedBar = await page.eval<{ state: string; animation: string; color: string; accent: string }>(`(() => {
    const dot = document.querySelector('#workspace-discover [data-testid="agent-activity-dot"]');
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;background:var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = dot === null ? null : getComputedStyle(dot);
    return {
      state: dot?.getAttribute("data-state") ?? "",
      animation: style?.animationName ?? "",
      color: style?.backgroundColor ?? "",
      accent,
    };
  })()`);
  check(
    reducedBar.state === "running" &&
      reducedBar.animation === "none" &&
      reducedBar.color === reducedBar.accent,
    "reduced motion does not keep the running state without the pulse",
    reducedBar,
  );
  await devtools.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });

  // Stop from the bar, then the idle color and the control swap.
  await page.click('#workspace-discover [data-testid="discover-stop"]');
  await page.wait(
    `document.querySelector('#workspace-discover [data-testid="discover-start"]') !== null &&
     document.querySelector('#workspace-discover [data-testid="agent-activity-dot"]')?.getAttribute("data-state") !== "running"`,
    "the stopped Discover bar",
    30_000,
  );
  const stoppedDiscover = await page.eval<{
    title: string;
    lastTitle: string;
    animation: string;
    color: string;
    muted: string;
  }>(`(() => {
    const dot = document.querySelector('#workspace-discover [data-testid="agent-activity-dot"]');
    const toggle = document.querySelector('#workspace-discover [data-testid="agent-activity-toggle"]');
    const last = document.querySelector('#workspace-discover [data-testid="agent-activity-last"]');
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;background:var(--muted-foreground)";
    document.body.append(probe);
    const muted = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = dot === null ? null : getComputedStyle(dot);
    return {
      title: toggle?.getAttribute("title") ?? "",
      lastTitle: last?.getAttribute("title") ?? "",
      animation: style?.animationName ?? "",
      color: style?.backgroundColor ?? "",
      muted,
    };
  })()`);
  check(
    stoppedDiscover.animation === "none" && stoppedDiscover.color === stoppedDiscover.muted,
    "the idle dot does not use the muted token without animating",
    stoppedDiscover,
  );
  check(
    stoppedDiscover.title === stoppedDiscover.lastTitle,
    "the idle bar still claims a start time",
    stoppedDiscover,
  );

  // Every Discover agent page and run page carries one bar.
  for (const agent of [
    "sheet",
    "discover-contribution",
    "discover-testing-strategy",
    "discover-naming-conventions",
    "discover-coding-conventions",
    "discover-architecture-boundaries",
    "discover-glossary",
  ]) {
    await page.eval(`(() => {
      const button = document.querySelector('[data-testid="discover-agent-tab"][data-agent="${agent}"]');
      if (button === null) return false;
      button.click();
      return true;
    })()`);
    await page.wait(
      `document.querySelector('[data-testid="discover-agent"]')?.getAttribute("data-agent") === "${agent}"`,
      `the ${agent} agent page`,
    );
    const bar = await barIn("discover");
    check(
      bar.bars === 1 && bar.outsideScroll && !bar.removed && bar.control,
      `the ${agent} agent page does not render the shared bar`,
      bar,
    );
    check(
      await page.eval<boolean>(
        `document.querySelector('#workspace-discover [data-testid="agent-activity-control"] [data-testid="discover-agent-start"]') !== null`,
      ),
      `the ${agent} Start control is outside the activity bar`,
    );
  }
  for (const command of [
    "discover.tab.glossary",
    "discover.tab.testing-strategy",
    "open.discover.warnings",
  ]) {
    await runPalette(command);
    await page.wait(
      `document.querySelector('#workspace-discover [data-testid="agent-activity-bar"]') !== null`,
      `the activity bar for ${command}`,
    );
    const bar = await barIn("discover");
    check(bar.bars === 1 && bar.outsideScroll && !bar.removed, `the ${command} page lost the bar`, bar);
  }

  // Background agents keep their settings and move Start/Stop into the bar.
  for (const [command, id] of [
    ["open.devboard.scout", "scout"],
    ["open.devboard.watchdog", "watchdog"],
    ["open.devboard.design", "design"],
    ["open.devboard.coach", "coach"],
    ["open.devboard.api-standards", "api-standards"],
    ["open.devboard.release-train", "release-train"],
  ]) {
    await runPalette(command);
    await page.wait(
      `document.querySelector('[data-testid="agent-page"]')?.getAttribute("data-agent") === "${id}"`,
      `the ${id} page`,
    );
    const bar = await barIn("devboard");
    check(
      bar.bars === 1 && bar.outsideScroll && !bar.removed && bar.control,
      `the ${id} page does not render the shared bar`,
      bar,
    );
    const control = await page.eval<{ testIds: string[]; starts: number }>(`(() => {
        const bar = document.querySelector('#workspace-devboard [data-testid="agent-activity-bar"]');
        const control = bar?.querySelector('[data-testid="agent-activity-control"]');
        return {
          testIds: [...(control?.querySelectorAll('button') ?? [])].map(
            (button) => button.getAttribute('data-testid') ?? '',
          ),
          starts: document.querySelectorAll('#workspace-devboard [data-testid="agent-start"]').length,
        };
      })()`);
    check(
      control.testIds.length === 1 &&
        (control.testIds[0] === "agent-start" || control.testIds[0] === "agent-stop"),
      `the ${id} activity bar control is not exactly Start or Stop`,
      control,
    );
    check(
      control.testIds[0] !== "agent-start" || control.starts === 1,
      `the ${id} Start control is outside the activity bar`,
      control,
    );
    check(
      await page.eval<boolean>(
        `document.querySelector('[data-testid="agent-cadence"]') !== null && document.querySelector('[data-testid="agent-sync-at"]') !== null`,
      ),
      `the ${id} page lost its settings`,
    );
  }

  // The Goal single-record page moves its Start control into the bar. Earlier
  // goal work resolves the seeded records, so a pending one is written and the
  // reconnect read publishes it before the page opens.
  await writeFile(
    join(host, "adrs", "0010-bar-pending.md"),
    pendingRecord("0010-bar-pending.md", "Bar pending record", "Bar context", "Bar decision"),
  );
  await page.reload();
  await page.wait(
    `document.readyState === "complete" && document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reloaded dashboard with the pending record",
    30_000,
  );
  await page.click('[data-testid="mode-goal"]');
  await page.wait(
    `document.querySelector('[data-testid="sidebar-adr"][data-file="0010-bar-pending.md"]') !== null`,
    "the pending record in the sidebar",
    15_000,
  );
  await runPalette("goal.adr.open.0010-bar-pending.md");
  await page.wait(`document.querySelector('[data-testid="record-header"]') !== null`, "the pending record page");
  const recordBar = await barIn("goal");
  check(
    recordBar.bars === 1 && recordBar.outsideScroll && !recordBar.removed && recordBar.control,
    "the Goal record page does not render the shared bar",
    recordBar,
  );
  const recordControl = await page.eval<{
    start: boolean;
    starts: number;
    inControl: boolean;
    pending: boolean;
    control: boolean;
    file: string;
    status: string;
  }>(`(() => {
    const root = document.querySelector('#workspace-goal');
    const control = root?.querySelector('[data-testid="agent-activity-control"]');
    const start = root?.querySelector('[data-testid="start"]');
    return {
      start: start !== null && start !== undefined,
      starts: root?.querySelectorAll('[data-testid="start"]').length ?? 0,
      inControl: control?.querySelector('[data-testid="start"]') !== null,
      pending: document.querySelector('[data-testid="record-action"]') !== null,
      control: control !== null,
      file: document.querySelector('[data-testid="record-file"]')?.textContent?.trim() ?? "",
      status: document.querySelector('[data-testid="record-status"]')?.textContent?.trim() ?? "",
    };
  })()`);
  check(
    recordControl.start && recordControl.starts === 1 && recordControl.inControl,
    "the Goal record Start control is outside the activity bar",
    recordControl,
  );

  // An Issues focus tab follows its run in the bar, keeps its question in the
  // page, and offers no control.
  await runPalette("open.issues.agents");
  await page.wait(`document.querySelector('[data-testid="issues-agent-open"]') !== null`, "the Issues agents grid");
  await page.click('[data-testid="issues-agent-open"]');
  await page.wait(`document.querySelector('[data-testid="issues-agent-focus"]') !== null`, "the Issues focus tab");
  await page.wait(
    `document.querySelector('[data-testid="issues-agent-focus"] [data-testid="agent-activity-last"]')?.textContent?.trim().length > 0`,
    "the Issues focus activity",
    15_000,
  );
  const focusBar = await barIn("issues");
  check(
    focusBar.bars === 1 &&
      focusBar.outsideScroll &&
      !focusBar.removed &&
      !focusBar.control &&
      focusBar.dot === "running",
    "the Issues focus bar is not a control-free running bar",
    focusBar,
  );
  check(
    await page.eval<boolean>(
      `document.querySelector('[data-testid="issues-agent-focus-question"]') !== null && document.querySelector('#workspace-issues [data-testid="agent-activity-question"]') !== null`,
    ),
    "the Issues question is not kept in the page beside the bar marker",
  );
  await page.click('#workspace-issues [data-testid="agent-activity-toggle"]');
  await page.wait(
    `(document.querySelector('#workspace-issues [data-testid="agent-activity-log"]')?.querySelectorAll('.agent-activity-bar__line').length ?? 0) > 1`,
    "the Issues multi-line activity log",
  );

  // The Flow overview moves Start/Stop into the bar, keeps its goal launcher,
  // and gives a conversation its own activity bar.
  await runPalette("open.flow.overview");
  await page.wait(`document.querySelector('[data-testid="flow-goal"]') !== null`, "the Flow overview");
  const flowBar = await barIn("flow");
  check(
    flowBar.bars === 1 && flowBar.outsideScroll && !flowBar.removed,
    "the Flow overview does not render the shared bar",
    flowBar,
  );
  check(
    await page.eval<boolean>(`(() => {
      const bar = document.querySelector('#workspace-flow [data-testid="agent-activity-bar"]');
      return (
        bar?.querySelector('[data-testid="agent-activity-control"] [data-testid="start-flow-implementation"]') !== null &&
        bar?.querySelector('[data-testid="agent-activity-control"] [data-testid="stop-flow-implementation"]') !== null &&
        document.querySelectorAll('[data-testid="start-flow-implementation"]').length === 1 &&
        document.querySelector('[data-testid="create-flow-goal"]') !== null
      );
    })()`),
    "the Flow implementation controls are not exclusive to the bar, or the goal launcher moved",
  );
  await page.click('[data-testid="flow-widget-discuss"]');
  await page.wait(`document.querySelector('[data-testid="flow-conversation"]') !== null`, "the widget conversation", 20_000);
  await page.wait(
    `document.querySelector('#workspace-flow [data-testid="agent-activity-last"]')?.textContent?.trim().length > 0`,
    "the conversation activity in the bar",
    20_000,
  );
  const conversationBar = await barIn("flow");
  check(
    conversationBar.bars === 1 &&
      conversationBar.outsideScroll &&
      !conversationBar.control &&
      !conversationBar.removed,
    "the Flow conversation does not render one control-free bar",
    conversationBar,
  );
  await page.click('[data-testid="close-flow-conversation"]');
  await page.wait(`document.querySelector('[data-testid="flow-conversation"]') === null`, "the closed conversation");

  // Fleet and agentless pages keep their surfaces and render no bar.
  for (const [command, mode] of [
    ["open.goal.overview", "goal"],
    ["goal.adrs.open", "goal"],
    ["goal.document.open", "goal"],
    ["open.goal.skills", "goal"],
    ["open.issues.overview", "issues"],
    ["open.issues.agents", "issues"],
    ["open.issues.drafts", "issues"],
    ["open.issues.issues", "issues"],
    ["open.issues.runs", "issues"],
    ["devboard.tab.tools", "devboard"],
    ["devboard.tab.skills", "devboard"],
    ["open.discover.contribution", "discover"],
    ["open.flow.decisions", "flow"],
    ["flow.checkpoint.open.cp-1", "flow"],
    ["flow.file.open.src/order.ts", "flow"],
  ]) {
    await runPalette(command);
    await delay(120);
    const bar = await barIn(mode);
    check(bar.bars === 0, `the ${command} page still renders an activity bar`, bar);
  }

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

  // 20. A Goal lane follows its own activity in the bar, without a control or
  // a status badge. The lane is seeded in durable state, so the server is
  // restarted before opening it.
  expectedReloadFailures = true;
  await stopServer();
  await seedLane(stateDir, host);
  startServer();
  await waitForHttp(baseUrl);
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnection after the lane restart",
    30_000,
  );
  await delay(2_000);
  expectedReloadFailures = false;
  await page.wait(
    `document.querySelector('[data-testid="lane-tab"][data-lane="lane-1"]') !== null`,
    "the restored lane entry",
    30_000,
  );
  await page.eval(`(() => {
    const button = document.querySelector('[data-testid="lane-tab"][data-lane="lane-1"]');
    if (button === null) return false;
    button.click();
    return true;
  })()`);
  await page.wait(`document.querySelector('[data-testid="lane-header"]') !== null`, "the lane page");
  const laneBar = await barIn("goal");
  check(
    laneBar.bars === 1 &&
      laneBar.outsideScroll &&
      !laneBar.control &&
      !laneBar.removed &&
      laneBar.last.includes("Lane parked"),
    "the Goal lane does not follow its activity in one control-free bar",
    laneBar,
  );
  check(
    await page.eval<boolean>(
      `document.querySelector('[data-testid="lane-status"]') === null && document.querySelector('[data-testid="lane-activity"]') === null`,
    ),
    "the Goal lane still renders its status badge or activity panel",
  );
  await runPalette("open.goal.overview");
  await delay(120);
  check((await barIn("goal")).bars === 0, "the Goal implementation page rendered an activity bar");

  // 21. Sidebar run state: each entry follows only its own page's run.
  // A second fixture keeps these live runs from disturbing the main one.
  const runStateRoot = join(root, "run-state");
  const runStateHost = await writeFixture(runStateRoot);
  extraFixtureHost = runStateHost;
  const runStateDir = join(runStateHost, ".devboard", ".tmp", "state");
  await mkdir(runStateDir, { recursive: true });
  // Every live operation needs a configured provider before it spawns a peer.
  const runStateProviderStamp = new Date().toISOString();
  saveSubscriptions(runStateDir, [
    {
      id: "verify-go",
      provider: "opencode-go",
      label: "Primary Go",
      key: PROVIDER_GO_KEY,
      enabled: true,
      createdAt: runStateProviderStamp,
      updatedAt: runStateProviderStamp,
    },
  ]);
  await seedFlow(runStateDir, runStateHost);
  // One failed background agent proves the Devboard failure mapping; every
  // other entry starts stopped.
  await mkdir(dirname(statePath(runStateDir, runStateHost)), { recursive: true });
  await writeFile(
    statePath(runStateDir, runStateHost),
    `${JSON.stringify(
      {
        version: 2,
        repo: "fixture/run-state",
        root: runStateHost,
        lifecycle: "failed",
        enabled: true,
        worker: null,
        limits: { maxPerHour: 10, maxPending: 5 },
        intervalMinutes: 60,
        lastScanStartedAt: null,
        issues: [],
        openTitles: [],
        releaseSignature: null,
        sync: { state: "ok", at: "2026-01-01T00:00:00.000Z", error: null },
        scan: null,
        newestScanId: null,
        nextAttemptAt: null,
        lastError: "fixture failure",
        notice: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  const runStatePort = await freePort();
  const runStateBase = `http://127.0.0.1:${runStatePort}`;
  const runStateLog = join(root, "run-state-acp.log");
  extraServerProcess = spawn("bun", ["run", "server/index.ts"], {
    cwd: harnessRoot,
    env: {
      ...serverEnv,
      PORT: String(runStatePort),
      REPO_DIR: runStateHost,
      ADRS_DIR: join(runStateHost, "adrs"),
      GOAL_FILE: join(runStateHost, "GOAL.md"),
      STATE_DIR: runStateDir,
      AGENT_COMMAND:
        `bun ${stubAgent} --log=${runStateLog} --delay-ms=2500 --questions=1 ` +
        `--prepare-skills --discover --discover-delay-ms=15000 --goal-draft ` +
        `--flow-implement --flow-question`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  extraServerProcess.stdout?.on("data", (chunk) => logWriter.write(chunk));
  extraServerProcess.stderr?.on("data", (chunk) => logWriter.write(chunk));
  await waitForHttp(runStateBase);
  await devtools.send("Page.navigate", { url: runStateBase });
  await page.wait(
    `location.port === "${runStatePort}" &&
      document.readyState === "complete" &&
      document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected" &&
      document.querySelector('[data-testid="mode-goal"]')?.getAttribute("aria-selected") === "true"`,
    "the run-state fixture dashboard",
    40_000,
  );
  /** Sends one product command over a page socket, exactly as a control does. */
  const pageCommand = async (command: Record<string, unknown>): Promise<void> => {
    const sent = await page.eval<boolean>(`(async () => {
      const socket = new WebSocket("ws://" + location.host + "/ws");
      const opened = await new Promise((resolve) => {
        socket.onopen = () => resolve(true);
        socket.onerror = () => resolve(false);
      });
      if (!opened) return false;
      socket.send(${JSON.stringify(JSON.stringify(command))});
      await new Promise((resolve) => setTimeout(resolve, 120));
      socket.close();
      return true;
    })()`);
    check(sent, "the page command socket did not open");
  };

  const runStateOf = (selector: string): Promise<string> =>
    page.eval<string>(
      `document.querySelector(${JSON.stringify(selector)})?.getAttribute("data-run-state") ?? ""`,
    );
  // Periodic reads (the 3s version poll and the MCP page's count refresh) are
  // not caused by a click, so a menu check counts only the frames a click could
  // have sent.
  const countedFrames = `(window.__viFrames ?? []).filter((frame) => !/getVersion|getMcpTools/.test(String(frame)))`;
  const framesNow = (): Promise<number> => page.eval<number>(`${countedFrames}.length`);
  const framesSince = (count: number): Promise<string[]> =>
    page.eval<string[]>(`${countedFrames}.slice(${count})`);

  // Goal: the Skills row and Implementation read only the Goal store, and
  // opening a menu entry sends nothing.
  check(
    (await runStateOf('[data-testid="open-implementation"]')) === "idle" &&
      (await runStateOf('[data-testid="goal-skills-open"]')) === "idle",
    "the idle Goal entries are not idle",
  );
  const menuFrames = await framesNow();
  await page.click('[data-testid="open-implementation"]');
  await page.click('[data-testid="goal-skills-open"]');
  await delay(200);
  check((await framesNow()) === menuFrames, "opening a Goal sidebar entry sent a frame");
  await page.wait(
    `document.querySelector('[data-testid="prepare-skills-overlay"]') !== null`,
    "the Skills page prepare control",
    20_000,
  );
  await page.wait(
    `(() => {
      const button = document.querySelector('[data-testid="prepare-skills-overlay"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`,
    "the enabled Skills prepare control",
    20_000,
  );
  await pageCommand({ type: "prepareSkills" });
  await page.wait(
    `document.querySelector('[data-testid="goal-skills-open"]')?.getAttribute("data-run-state") === "running"`,
    "the running Skills entry",
    20_000,
  );
  check(
    (await runStateOf('[data-testid="open-implementation"]')) === "idle",
    "skills preparation marked the Implementation entry",
  );
  const skillsBadge = await page.eval<string>(
    `document.querySelector('[data-testid="goal-skills-open"] [data-testid="run-state-badge"]')?.textContent?.trim() ?? ""`,
  );
  check(skillsBadge === "running", "the Skills entry has no running badge", skillsBadge);
  await page.wait(
    `document.querySelector('[data-testid="choice"]') !== null`,
    "the preparation question",
    20_000,
  );
  await page.click('[data-testid="choice"]');
  await page.wait(
    `document.querySelector('[data-testid="goal-skills-open"]')?.getAttribute("data-run-state") === "idle"`,
    "the finished skills preparation",
    30_000,
  );

  await runPalette("open.goal.overview");
  await page.wait(
    `document.querySelector('[data-testid="start-next"]') !== null`,
    "the Goal overview start control",
    20_000,
  );
  await page.wait(
    `(() => {
      const button = document.querySelector('[data-testid="start-next"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`,
    "the enabled Goal start control",
    20_000,
  );
  await pageCommand({ type: "startRun" });
  await page.wait(
    `document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state") === "running"`,
    "the running Implementation entry",
    20_000,
  );
  check(
    (await runStateOf('[data-testid="goal-skills-open"]')) === "idle",
    "a manual run marked the Skills entry",
  );
  const implementationMeta = await page.eval<string>(
    `document.querySelector('[data-testid="open-implementation"] .sidebar-item__meta')?.textContent?.trim() ?? ""`,
  );
  check(implementationMeta === "manual", "the running Implementation meta changed", implementationMeta);
  await page.wait(
    `document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state") === "answer"`,
    "the Implementation answer state",
    30_000,
  );
  const implementationBadge = await page.eval<string>(
    `document.querySelector('[data-testid="open-implementation"] [data-testid="run-state-badge"]')?.textContent?.trim() ?? ""`,
  );
  check(implementationBadge === "answer", "the Implementation entry has no answer badge", implementationBadge);
  // The manual sequence resolves every pending ADR, asking after each one;
  // answer each question and stop when the sequence reports idle.
  // A sequence hands off between records with a brief idle gap, so only an
  // idle window that outlasts the handoff ends the loop.
  const manualDeadline = Date.now() + 120_000;
  let manualSnapshot = { state: "", choices: 0, question: "" };
  let idleSince: number | null = null;
  while (Date.now() < manualDeadline) {
    manualSnapshot = await page.eval<{ state: string; choices: number; question: string }>(`(() => ({
      state:
        document.querySelector('[data-testid="open-implementation"]')?.getAttribute("data-run-state") ?? "",
      choices: document.querySelectorAll('[data-testid="choice"]').length,
      question: document.querySelector('[data-testid="question"]')?.textContent?.trim() ?? "",
    }))()`);
    if (manualSnapshot.state === "idle") {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 1_500) break;
    } else {
      idleSince = null;
      if (manualSnapshot.state === "answer" && manualSnapshot.choices > 0) {
        await page.eval(`document.querySelector('[data-testid="choice"]')?.click()`);
        await delay(200);
        continue;
      }
    }
    await delay(100);
  }
  check(
    manualSnapshot.state === "idle",
    "the manual run did not finish",
    manualSnapshot,
  );

  // Discover: a contribution run marks exactly its three entries, a reload
  // restores them, and the finished suite-less run clears them.
  await page.click('[data-testid="mode-discover"]');
  await page.wait(
    `document.querySelector('[data-testid="discover-agents"]') !== null`,
    "the Discover sidebar on the run-state fixture",
    20_000,
  );
  // One published slice makes the six skill entries render, so the
  // contribution run below can mark its own skill entry too.
  await pageCommand({ type: "discoverAgent", agent: "sheet" });
  await page.wait(
    `document.querySelector('[data-testid="discover-agent-tab"][data-agent="sheet"]')
      ?.getAttribute("data-run-state") === "running"`,
    "the Data Sheet run before the contribution pass",
    20_000,
  );
  await page.wait(
    `(() => {
      const tab = document.querySelector('[data-testid="discover-agent-tab"][data-agent="sheet"]');
      return tab?.getAttribute("data-state") === "succeeded" &&
        tab?.getAttribute("data-run-state") === "idle";
    })()`,
    "the finished Data Sheet run",
    60_000,
  );
  const discoverFrames = await framesNow();
  await page.click('[data-testid="discover-agent-tab"][data-agent="discover-contribution"]');
  await page.wait(
    `document.querySelector('[data-testid="discover-agent"][data-agent="discover-contribution"]') !== null`,
    "the Contribution card",
    20_000,
  );
  await delay(200);
  check(
    (await framesNow()) === discoverFrames,
    `opening a Discover sidebar entry sent a frame: ${JSON.stringify(await framesSince(discoverFrames))}`,
  );
  const contributionStart = await page.eval<{ present: boolean; disabled: boolean; title: string }>(
    `(() => {
      const button = document.querySelector('[data-testid="discover-agent-start"]');
      return {
        present: button !== null,
        disabled: button instanceof HTMLButtonElement ? button.disabled : true,
        title: button?.getAttribute("title") ?? "",
      };
    })()`,
  );
  check(
    contributionStart.present,
    "the Contribution start control is missing",
    contributionStart,
  );
  await pageCommand({ type: "discoverAgent", agent: "discover-contribution" });
  await page.wait(
    `document.querySelector('[data-testid="discover-agent-tab"][data-agent="discover-contribution"]')
      ?.getAttribute("data-run-state") === "running"`,
    "the running Contribution entries",
    30_000,
  );

  const discoverStates = async (): Promise<{
    tabs: Record<string, string>;
    agents: Record<string, string>;
  }> =>
    page.eval<{ tabs: Record<string, string>; agents: Record<string, string> }>(`(() => {
      const tabs = {};
      for (const element of document.querySelectorAll('[data-testid="discover-tab"]')) {
        tabs[element.getAttribute("data-tab") ?? ""] = element.getAttribute("data-run-state") ?? "";
      }
      const agents = {};
      for (const element of document.querySelectorAll('[data-testid="discover-agent-tab"]')) {
        agents[element.getAttribute("data-agent") ?? ""] = element.getAttribute("data-run-state") ?? "";
      }
      return { tabs, agents };
    })()`);
  const contributionRunState = await discoverStates();
  check(
    contributionRunState.tabs.contribution === "running" &&
      contributionRunState.tabs["contribution-skill"] === "running" &&
      contributionRunState.agents["discover-contribution"] === "running" &&
      contributionRunState.tabs.overview === "idle" &&
      contributionRunState.agents.sheet === "idle" &&
      contributionRunState.tabs.glossary === "idle" &&
      contributionRunState.tabs["glossary-skill"] === "idle" &&
      Object.entries(contributionRunState.tabs).every(
        ([id, state]) => ["contribution", "contribution-skill"].includes(id) === (state === "running"),
      ) &&
      Object.entries(contributionRunState.agents).every(
        ([id, state]) => (id === "discover-contribution") === (state === "running"),
      ),
    "a contribution-only run marked another Discover entry",
    contributionRunState,
  );

  // No other mode is marked by the live Discover run.
  await page.click('[data-testid="mode-devboard"]');
  await page.wait(
    `document.querySelector('[data-testid="open-devboard-scout"]') !== null`,
    "the Devboard sidebar beside the Discover run",
    20_000,
  );
  const devboardMapping: Record<string, string> = {
    running: "running",
    starting: "running",
    failed: "failed",
    stopped: "idle",
    stopping: "idle",
  };
  const devboardEntries = await page.eval<Array<{ id: string; lifecycle: string; run: string }>>(
    `[...document.querySelectorAll('[data-testid^="open-devboard-"]')].map((button) => ({
      id: button.getAttribute("data-testid") ?? "",
      lifecycle:
        button.querySelector('[data-testid^="agent-state-"]')?.getAttribute("data-state") ?? "",
      run: button.getAttribute("data-run-state") ?? "",
    }))`,
  );
  check(
    devboardEntries.length === 7 &&
      devboardEntries.every(
        (entry) => entry.run === devboardMapping[entry.lifecycle],
      ) &&
      devboardEntries.some(
        (entry) => entry.id === "open-devboard-scout" && entry.run === "failed" && entry.lifecycle === "failed",
      ),
    "a background-agent entry's run state does not match its lifecycle",
    devboardEntries,
  );
  await page.click('[data-testid="mode-discover"]');
  await page.wait(
    `document.querySelector('[data-testid="discover-agent-tab"][data-agent="discover-contribution"]')
      ?.getAttribute("data-run-state") === "running"`,
    "the Contribution entries after the mode switch",
    20_000,
  );

  // A reload during the live run restores the same entries.
  await devtools.send("Page.reload");
  await page.wait(
    `document.querySelector('[data-testid="status-connection"]')?.textContent?.trim() === "Connected"`,
    "the reconnected run-state dashboard",
    40_000,
  );
  await page.wait(
    `document.querySelector('[data-testid="discover-agent-tab"][data-agent="discover-contribution"]')
      ?.getAttribute("data-run-state") === "running"`,
    "the Contribution entries after the reconnect",
    30_000,
  );
  const reconnected = await discoverStates();
  check(
    reconnected.tabs.contribution === "running" &&
      reconnected.tabs["contribution-skill"] === "running" &&
      reconnected.agents["discover-contribution"] === "running" &&
      reconnected.tabs.overview === "idle",
    "a reconnect changed the running Discover entries",
    reconnected,
  );
  await page.wait(
    `(() => {
      const tabs = [...document.querySelectorAll('[data-testid="discover-tab"][data-run-state]')];
      const agents = [...document.querySelectorAll('[data-testid="discover-agent-tab"]')];
      return [...tabs, ...agents].every((element) => element.getAttribute("data-run-state") === "idle");
    })()`,
    "the finished contribution run to clear its entries",
    40_000,
  );

  // Issues: the Overview follows the issues lifecycle and its agents' questions.
  await page.click('[data-testid="mode-issues"]');
  await page.wait(
    `document.querySelector('[data-testid="open-issues-overview"]') !== null`,
    "the Issues sidebar",
    20_000,
  );
  await seedIssuesState(runStateDir, runStateHost, "running", "*");
  await page.wait(
    `document.querySelector('[data-testid="open-issues-overview"]')?.getAttribute("data-run-state") === "running"`,
    "the running Issues Overview entry",
    20_000,
  );
  check(
    (await runStateOf('[data-testid="open-issues-drafts"]')) === "idle",
    "the running issues lifecycle marked Draft goals",
  );
  await seedIssuesState(runStateDir, runStateHost, "running");
  await page.wait(
    `document.querySelector('[data-testid="open-issues-overview"]')?.getAttribute("data-run-state") === "answer"`,
    "the answering Issues Overview entry",
    20_000,
  );
  const issuesAnswerBadge = await page.eval<string>(
    `document.querySelector('[data-testid="open-issues-overview"] [data-testid="run-state-badge"]')?.textContent?.trim() ?? ""`,
  );
  check(issuesAnswerBadge === "answer", "the Issues Overview has no answer badge", issuesAnswerBadge);
  await seedIssuesState(runStateDir, runStateHost, "failed");
  await page.wait(
    `document.querySelector('[data-testid="open-issues-overview"]')?.getAttribute("data-run-state") === "failed"`,
    "the failed Issues Overview entry",
    20_000,
  );

  // Issues: Draft goals follows each elaboration's own run.
  const draftsDirectory = join(runStateHost, ".devboard", "goal-proposals");
  await mkdir(draftsDirectory, { recursive: true });
  const questionDraft = ".devboard/goal-proposals/010-question.md";
  const hangDraft = ".devboard/goal-proposals/011-hang.md";
  const failDraft = ".devboard/goal-proposals/012-fail.md";
  await writeFile(
    join(runStateHost, questionDraft),
    "# Question draft\n\n> Unprocessed draft. STUB-QUESTION\n\nAsk about the scope.\n",
  );
  await writeFile(
    join(runStateHost, hangDraft),
    "# Hang draft\n\n> Unprocessed draft. STUB-HANG\n\nKeep this elaboration running.\n",
  );
  await writeFile(
    join(runStateHost, failDraft),
    "# Failing draft\n\n> Unprocessed draft. STUB-FAIL\n\nFail the label verification.\n",
  );
  await page.click('[data-testid="open-issues-drafts"]');
  await page.wait(
    `document.querySelectorAll('[data-testid="issues-draft"]').length >= 3`,
    "the three run-state drafts",
    20_000,
  );
  const sendCommand = async (command: Record<string, unknown>): Promise<void> => {
    await page.eval(`(async () => {
      const socket = new WebSocket("ws://" + location.host + "/ws");
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = reject;
      });
      socket.send(${JSON.stringify(JSON.stringify(command))});
      await new Promise((resolve) => setTimeout(resolve, 150));
      socket.close();
    })()`);
  };
  await sendCommand({ type: "startGoalDraft", path: hangDraft });
  await page.wait(
    `document.querySelector('[data-testid="open-issues-drafts"]')?.getAttribute("data-run-state") === "running"`,
    "the running Draft goals entry",
    20_000,
  );
  await sendCommand({ type: "stopGoalDraft", path: hangDraft });
  await page.wait(
    `document.querySelector('[data-testid="open-issues-drafts"]')?.getAttribute("data-run-state") === "idle"`,
    "the stopped Draft goals entry",
    20_000,
  );
  await sendCommand({ type: "startGoalDraft", path: questionDraft });
  await page.wait(
    `document.querySelector('[data-testid="open-issues-drafts"]')?.getAttribute("data-run-state") === "answer"`,
    "the answering Draft goals entry",
    20_000,
  );
  await sendCommand({ type: "stopGoalDraft", path: questionDraft });
  await page.wait(
    `document.querySelector('[data-testid="open-issues-drafts"]')?.getAttribute("data-run-state") === "idle"`,
    "the stopped question draft",
    20_000,
  );
  await sendCommand({ type: "startGoalDraft", path: failDraft });
  await page.wait(
    `document.querySelector('[data-testid="open-issues-drafts"]')?.getAttribute("data-run-state") === "failed"`,
    "the failed Draft goals entry",
    30_000,
  );
  const draftsFailedBadge = await page.eval<string>(
    `document.querySelector('[data-testid="open-issues-drafts"] [data-testid="run-state-badge"]')?.textContent?.trim() ?? ""`,
  );
  check(draftsFailedBadge === "failed", "the Draft goals entry has no failed badge", draftsFailedBadge);
  await seedIssuesState(runStateDir, runStateHost, "stopped");

  // Flow: the Overview and Session Status follow flow.status and its question.
  await page.click('[data-testid="mode-flow"]');
  await page.wait(
    `document.querySelector('[data-testid="flow-goal"]') !== null`,
    "the Flow overview on the run-state fixture",
    20_000,
  );
  const flowEntries = (): Promise<Array<{ label: string; run: string; badge: string }>> =>
    page.eval<Array<{ label: string; run: string; badge: string }>>(
      `[...document.querySelectorAll('[data-command="open.flow.overview"][data-run-state]')].map((entry) => ({
        label: entry.querySelector(".sidebar-item__label")?.textContent?.trim() ?? "",
        run: entry.getAttribute("data-run-state") ?? "",
        badge:
          entry.querySelector('[data-testid="run-state-badge"]')?.textContent?.trim() ??
          entry.querySelector(".badge")?.textContent?.trim() ??
          "",
      }))`,
    );
  check(
    JSON.stringify(await flowEntries()) ===
      JSON.stringify([
        { label: "Overview", run: "idle", badge: "stopped" },
        { label: "Status", run: "idle", badge: "stopped" },
      ]),
    "the idle Flow entries are wrong",
    await flowEntries(),
  );
  const flowSequence = await page.eval<string[]>(`(async () => {
    const socket = new WebSocket("ws://" + location.host + "/ws");
    const opened = await new Promise((resolve) => {
      socket.onopen = () => resolve(true);
      socket.onerror = () => resolve(false);
    });
    if (!opened) return [];
    socket.send(JSON.stringify({ type: "startFlowImplementation" }));
    const seen = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const states = [...document.querySelectorAll('[data-command="open.flow.overview"][data-run-state]')]
        .map((entry) => entry.getAttribute("data-run-state") ?? "")
        .join(",");
      if (seen[seen.length - 1] !== states) seen.push(states);
      if (states === "answer,answer" || states === "failed,failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    socket.close();
    return seen;
  })()`);
  check(
    flowSequence.includes("running,running") && flowSequence.includes("answer,answer"),
    "the Flow entries never ran and then waited for the question",
    flowSequence,
  );
  const answeringFlow = await flowEntries();
  check(
    answeringFlow.every((entry) => entry.run === "answer" && entry.badge === "answer"),
    "the Flow entries do not show the answer state and badge",
    answeringFlow,
  );
  await pageCommand({ type: "stopFlowImplementation" });
  await page.wait(
    `(() => {
      const entries = [...document.querySelectorAll('[data-command="open.flow.overview"][data-run-state]')];
      return entries.length === 2 && entries.every((entry) => entry.getAttribute("data-run-state") === "idle");
    })()`,
    "the stopped Flow entries",
    20_000,
  );


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
    "verify:interface: shell, modes, sidebar, pages, splits, palette, keyboard, theme, tables, read-only documents, terminals, accessibility, notifications, status bar, issues mode, ask transcript, persistence, sidebar run state, and boundary passed",
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
    feedbackOffProcess?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  try {
    extraServerProcess?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  try {
    serverProcess?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  for (const host of [fixtureHost, extraFixtureHost]) {
    if (host === undefined) continue;
    for (const entry of dashboardsFor(host)) {
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    for (const pid of goalDraftOwnerPids(host)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  feedbackApi?.stop(true);
  providerUsage?.stop(true);
}
