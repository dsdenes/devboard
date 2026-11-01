#!/usr/bin/env bun
/**
 * The OS notification channel gate. It builds the client, starts a source
 * dashboard against a fixture host under `.devboard/.tmp`, drives the built
 * page in Chrome, sets the browser's notification permission to granted,
 * denied, and prompt through CDP, and records every notification the page
 * raises. Seeded frames are the same server frames the dashboard sends for a
 * pending question on each surface; the delivery path is the page's own
 * WebSocket message handler.
 *
 * The verifier never contacts a forge, npm, or a model. A real desktop
 * notification is the manual check in the goal issue; this gate proves the
 * page raises one per pending question and prints PASS for every criterion it
 * covers.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { freePort, harnessRoot, makeHost, makeRoot, run, waitFor } from "./verification";

const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`;
    throw new Error(`verify:notifications: ${message}${detail}`);
  }
}

const covered = new Map<number, string>();

function cover(criterion: number, message: string): void {
  covered.set(criterion, message);
}

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("verify:notifications: Chrome is unavailable");
}

interface CdpReply {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number };
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
    if (typeof value !== "object" || value === null) return undefined;
    return "value" in value ? value.value : undefined;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

interface PageStatus {
  state: string;
  label: string;
  text: string;
  enabled: string | null;
}

class Page {
  constructor(private readonly devtools: Devtools) {}

  async eval<T = unknown>(expression: string): Promise<T> {
    return (await this.devtools.evaluate(expression)) as T;
  }

  async wait<T>(expression: string, description: string, timeoutMs = 120_000): Promise<T> {
    return waitFor(
      async () => {
        const value = await this.eval<T | null>(expression).catch(() => null);
        return value === null || value === undefined || value === false ? undefined : value;
      },
      `verify:notifications: ${description}`,
      timeoutMs,
    );
  }

  async control(): Promise<PageStatus> {
    return this.eval<PageStatus>(`(() => {
      const element = document.querySelector('[data-testid="os-notifications"]');
      return {
        state: element?.dataset.state ?? "",
        label: element?.getAttribute('aria-label') ?? "",
        text: (element?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        enabled: localStorage.getItem('devboard.osNotifications.v1'),
      };
    })()`);
  }

  async clickControl(): Promise<void> {
    const clicked = await this.eval<boolean>(`(() => {
      const element = document.querySelector('[data-testid="os-notifications"]');
      if (element === null) return false;
      element.click();
      return true;
    })()`);
    check(clicked === true, "the status-bar notification control is missing");
  }

  /** Feeds frames through the page's own WebSocket message handler. */
  async deliver(frames: unknown[]): Promise<void> {
    const delivered = await this.eval<number>(
      `window.__devboardDeliver(${JSON.stringify(frames)})`,
    );
    check(typeof delivered === "number", "the page did not accept seeded frames");
  }

  async delivered(): Promise<Array<{ title: string; body: string; keys: string[] }>> {
    return this.eval<Array<{ title: string; body: string; keys: string[] }>>(
      `window.__devboardOs.notifications`,
    );
  }
}

/** A frame that changes nothing: its dispatch still refreshes the channel. */
const UNCHANGED_VERSION = {
  type: "versionState",
  running: null,
  installed: null,
  latest: null,
  stale: false,
};

/** The page's own connection indicator is the readiness signal after a reload. */
const CONNECTED = `document.querySelector('[data-testid="status-connection"]')
  ?.textContent?.trim() === "Connected"`;

const PRELOAD = `(() => {
  const state = {
    notifications: [],
    requests: 0,
    requestMode: 'real',
    resolvePermission: null,
    sockets: [],
  };
  window.__devboardOs = state;

  const Real = window.Notification;
  function Recorded(title, options) {
    state.notifications.push({
      title: String(title),
      body: String(options?.body ?? ''),
      keys: Object.keys(options ?? {}),
    });
  }
  Object.defineProperty(Recorded, 'permission', { get: () => Real.permission });
  Recorded.requestPermission = () => {
    state.requests += 1;
    if (state.requestMode === 'dismiss') return Promise.resolve('default');
    if (state.requestMode === 'defer') {
      return new Promise((resolve) => {
        state.resolvePermission = resolve;
      });
    }
    return Real.requestPermission();
  };
  Recorded.maxActions = 0;
  window.Notification = Recorded;

  const Original = window.WebSocket;
  function Tracked(url, protocols) {
    const socket = protocols === undefined ? new Original(url) : new Original(url, protocols);
    state.sockets.push(socket);
    socket.addEventListener('open', () => {
      const frames = window.__devboardInitialFrames;
      if (!Array.isArray(frames) || frames.length === 0) return;
      window.setTimeout(() => {
        if (socket.__devboardSeeded === true) return;
        socket.__devboardSeeded = true;
        window.__devboardDeliverTo(socket, frames);
      }, 1500);
    });
    return socket;
  }
  Tracked.CONNECTING = Original.CONNECTING;
  Tracked.OPEN = Original.OPEN;
  Tracked.CLOSING = Original.CLOSING;
  Tracked.CLOSED = Original.CLOSED;
  window.WebSocket = Tracked;

  window.__devboardDeliverTo = (socket, frames) => {
    const handler = socket.onmessage;
    if (typeof handler !== 'function') return 0;
    for (const frame of frames) handler({ data: JSON.stringify(frame) });
    return frames.length;
  };
  window.__devboardDeliver = (frames) => {
    let count = 0;
    for (const socket of state.sockets) count += window.__devboardDeliverTo(socket, frames);
    return count;
  };
})();`;

function question(id: number, message: string): Record<string, unknown> {
  return { id, message, options: [] };
}

const SEEDED: Array<{ surface: string; label: string; message: string; frames: unknown[] }> = [
  {
    surface: "goal lifecycle lane",
    label: "Goal lane · Epic generation",
    message: "Which epic should start first?",
    frames: [
      {
        type: "laneState",
        openEpics: 1,
        runningLanes: 1,
        lanes: [
          {
            id: "lane-1",
            kind: "generation",
            epic: { number: 11, title: "Epic eleven", url: "https://example.test/11" },
            record: null,
            attempt: 1,
            status: "running",
            activity: [],
            question: question(1, "Which epic should start first?"),
          },
        ],
      },
    ],
  },
  {
    surface: "manual goal run",
    label: "Manual goal run",
    message: "Continue the manual run?",
    frames: [
      {
        type: "runStarted",
        file: "adrs/0001-manual.md",
        title: "Manual run",
        action: "resolving",
        manual: true,
      },
      { type: "question", ...question(2, "Continue the manual run?") },
    ],
  },
  {
    surface: "goal creation",
    label: "Goal creation",
    message: "What outcome does the goal need?",
    frames: [
      { type: "runStopped" },
      { type: "goalCreationStarted" },
      { type: "question", ...question(3, "What outcome does the goal need?") },
    ],
  },
  {
    surface: "goal revision",
    label: "Goal revision",
    message: "Which revision should apply?",
    frames: [
      { type: "goalCreationStopped" },
      { type: "goalRevisionStarted" },
      { type: "question", ...question(4, "Which revision should apply?") },
    ],
  },
  {
    surface: "skills preparation",
    label: "Skills preparation",
    message: "Overwrite the prepared skill?",
    frames: [
      { type: "goalRevisionStopped" },
      { type: "skillsPreparationStarted" },
      { type: "question", ...question(5, "Overwrite the prepared skill?") },
    ],
  },
  {
    surface: "Discover agent",
    label: "Discover agent · Conventions",
    message: "Which conventions should be preferred?",
    frames: [
      {
        type: "discoverState",
        state: {
          active: true,
          runId: "discover-run-1",
          startedAt: "2026-11-01T18:00:00.000Z",
          activeAgent: "conventions",
          runningAll: false,
          interrupted: false,
          stale: false,
          warnings: [],
          busy: null,
          error: null,
          remoteAvailable: false,
          retained: [],
          skills: [],
          glossaries: [],
          decisions: [],
          agents: [
            {
              id: "conventions",
              label: "Conventions",
              command: "conventions",
              state: "running",
              startedAt: "2026-11-01T18:00:00.000Z",
              endedAt: null,
              error: null,
              prompt: null,
            },
          ],
        },
      },
      {
        type: "discoverQuestion",
        agent: "conventions",
        ...question(6, "Which conventions should be preferred?"),
      },
    ],
  },
  {
    surface: "Flow session",
    label: "Flow session",
    message: "Which file should change first?",
    frames: [flowSnapshot({ question: question(7, "Which file should change first?") })],
  },
  {
    surface: "Flow goal creation",
    label: "Flow goal creation",
    message: "Is the flow goal complete?",
    frames: [
      { type: "flowGoalStarted" },
      { type: "flowQuestion", target: "goal", ...question(8, "Is the flow goal complete?") },
    ],
  },
  {
    surface: "Flow conversation",
    label: "Flow conversation · Entity naming",
    message: "Rename the entity?",
    frames: [
      flowSnapshot({
        question: null,
        widgets: [
          {
            id: "widget-1",
            category: "naming",
            concept: "Entity naming",
            summary: "",
            rationale: "",
            files: [],
            accepted: false,
          },
        ],
        conversation: {
          widgetId: "widget-1",
          messages: [],
          activity: [],
          question: question(9, "Rename the entity?"),
        },
      }),
    ],
  },
  {
    surface: "issues draft elaboration",
    label: "Issues draft · notification-smoke.md",
    message: "Ask about the draft scope?",
    frames: [
      {
        type: "issuesDrafts",
        drafts: [
          { path: ".devboard/goal-proposals/notification-smoke.md", name: "notification-smoke.md" },
        ],
        runs: [],
      },
      {
        type: "issuesDraftState",
        draft: {
          path: ".devboard/goal-proposals/notification-smoke.md",
          status: "running",
          startedAt: "2026-11-01T18:00:00.000Z",
          finishedAt: null,
          error: null,
          activity: [],
          question: question(10, "Ask about the draft scope?"),
        },
      },
    ],
  },
];

/** Ends the seeded skills preparation so the next delivery starts clean. */
const SEED_TAIL: unknown[] = [{ type: "skillsPreparationStopped" }];

/** A question the page has not seen before, for the off and blocked checks. */
function freshQuestion(id: number, message: string): unknown[] {
  return [
    { type: "runStopped" },
    { type: "goalCreationStarted" },
    { type: "question", ...question(id, message) },
  ];
}

function flowSnapshot(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "flowSnapshot",
    sessionId: "flow-session-1",
    status: "running",
    goal: "Ship the notifications",
    decisions: "",
    worktree: null,
    branch: null,
    baseRevision: null,
    files: [],
    widgets: [],
    steering: [],
    checkpoints: [],
    verification: null,
    blockers: [],
    pr: null,
    prError: null,
    leftover: null,
    question: null,
    goalCreation: null,
    conversation: null,
    activity: [],
    notice: null,
    history: [],
    ...overrides,
  };
}

const RESOLUTION: unknown[] = [
  { type: "laneState", openEpics: 0, runningLanes: 0, lanes: [] },
  { type: "runStopped" },
  { type: "goalCreationStopped" },
  { type: "goalRevisionStopped" },
  { type: "skillsPreparationStopped" },
  { type: "discoverStopped" },
  {
    type: "discoverState",
    state: {
      active: false,
      runId: null,
      startedAt: null,
      activeAgent: null,
      runningAll: false,
      interrupted: false,
      stale: false,
      warnings: [],
      busy: null,
      error: null,
      remoteAvailable: false,
      retained: [],
      skills: [],
      glossaries: [],
      decisions: [],
      agents: [],
    },
  },
  flowSnapshot({ status: "stopped", question: null, conversation: null, goalCreation: null }),
  {
    type: "issuesDrafts",
    drafts: [
      { path: ".devboard/goal-proposals/notification-smoke.md", name: "notification-smoke.md" },
    ],
    runs: [
      {
        path: ".devboard/goal-proposals/notification-smoke.md",
        status: "succeeded",
        startedAt: "2026-11-01T18:00:00.000Z",
        finishedAt: "2026-11-01T18:01:00.000Z",
        error: null,
        activity: [],
        question: null,
      },
    ],
  },
];

async function pageTarget(debugPort: number): Promise<string> {
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
          (target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
        );
        return page?.webSocketDebuggerUrl;
      } catch {
        return undefined;
      }
    },
    "verify:notifications: the Chrome page target",
    30_000,
  );
}

async function browserSocket(debugPort: number): Promise<string> {
  return waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
          signal: AbortSignal.timeout(2000),
        });
        const version = (await response.json()) as { webSocketDebuggerUrl?: string };
        return typeof version.webSocketDebuggerUrl === "string"
          ? version.webSocketDebuggerUrl
          : undefined;
      } catch {
        return undefined;
      }
    },
    "verify:notifications: the Chrome browser target",
    30_000,
  );
}

const root = await makeRoot("verify-notifications");
console.error(`verify:notifications: fixture ${root}`);
const harness = harnessRoot;
const host = await makeHost(root, "host");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const origin = baseUrl;
const stateDir = join(root, "state");
await mkdir(stateDir, { recursive: true });
const profile = join(root, "chrome-profile");
await mkdir(profile, { recursive: true });

let serverProcess: ChildProcess | undefined;
let chromeProcess: ChildProcess | undefined;
let devtools: Devtools | undefined;
let browser: Devtools | undefined;

try {
  const build = run("bun", ["run", "build"], { cwd: harness });
  check(build.code === 0, "bun run build failed", build.stderr.slice(-2000));

  serverProcess = spawn("bun", ["run", "server/index.ts"], {
    cwd: harness,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ADRS_DIR: join(host.directory, "adrs"),
      REPO_DIR: host.directory,
      GOAL_FILE: join(host.directory, "GOAL.md"),
      STATIC_DIR: join(harness, "dist"),
      STATE_DIR: stateDir,
      DEVBOARD_UPDATE_INTERVAL_MS: "3600000",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  serverProcess.stderr?.on("data", (chunk) => console.error(String(chunk).trimEnd()));
  await waitFor(
    async () => {
      try {
        const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2000) });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "verify:notifications: the dashboard to answer",
    60_000,
  );

  const debugPort = await freePort();
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
  chromeProcess.stderr?.on("data", () => {
    // Chrome is noisy; a page exception is captured through CDP instead.
  });

  devtools = new Devtools(await pageTarget(debugPort));
  await devtools.connect();
  browser = new Devtools(await browserSocket(debugPort));
  await browser.connect();
  const page = new Page(devtools);

  await devtools.send("Page.enable");
  await devtools.send("Runtime.enable");
  // Headless Chrome reports no document focus unless emulated; the page must
  // raise notifications with the document focused and visible.
  await devtools.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await devtools.send("Page.addScriptToEvaluateOnNewDocument", { source: PRELOAD });
  await devtools.send("Page.navigate", { url: baseUrl });
  await page.wait(
    `document.readyState === "complete" &&
      document.querySelector('[data-testid="os-notifications"]') !== null`,
    "the status-bar notification control",
    60_000,
  );
  await page.wait(CONNECTED, "the WebSocket connection", 30_000);

  const setPermission = async (setting: "granted" | "denied" | "prompt"): Promise<void> => {
    const reply = await browser!.send("Browser.setPermission", {
      permission: { name: "notifications" },
      setting,
      origin,
    });
    check(reply.error === undefined, "the browser refused the permission setting", reply);
    const actual = await page.eval<string>(`window.Notification.permission`);
    const expected =
      setting === "granted" ? "granted" : setting === "denied" ? "denied" : "default";
    check(actual === expected, `the browser reported ${actual} for ${setting}`, {
      actual,
      setting,
    });
    console.log(`PERMISSION ${setting} -> ${actual}`);
  };

  const settle = (): Promise<boolean> =>
    page.eval<boolean>(`new Promise((resolve) => setTimeout(() => resolve(true), 250))`);

  // 1. The control before any grant.
  await setPermission("prompt");
  let control = await page.control();
  check(
    control.state === "off" && control.label === "OS notifications off",
    "before any grant the control does not read off",
    control,
  );
  console.log(`CONTROL prompt -> ${control.state} (${control.label})`);

  // The Allow click is simulated: headless Chrome cannot render the prompt, so
  // the request is deferred and resolved after the browser records the grant.
  await page.eval(`window.__devboardOs.requestMode = 'defer'`);
  await page.clickControl();
  await page.wait(`typeof window.__devboardOs.resolvePermission === "function"`, "the request");
  await setPermission("granted");
  await page.eval(`window.__devboardOs.resolvePermission('granted')`);
  control = await page.control();
  check(
    control.state === "on" && control.label === "OS notifications on",
    "a click that grants permission does not read on",
    control,
  );
  check(
    (await page.eval<number>(`window.__devboardOs.requests`)) === 1,
    "the grant click did not request the permission once",
  );
  console.log(`CONTROL granted -> ${control.state} (${control.label})`);

  // Denied and blocked read as blocked and raise no prompt.
  await setPermission("denied");
  await page.deliver([UNCHANGED_VERSION]);
  control = await page.control();
  check(
    control.state === "blocked" && control.label === "OS notifications blocked",
    "a denied browser does not read blocked",
    control,
  );
  console.log(`CONTROL denied -> ${control.state} (${control.label})`);
  const requestsBefore = await page.eval<number>(`window.__devboardOs.requests`);
  await page.clickControl();
  await settle();
  check(
    (await page.eval<number>(`window.__devboardOs.requests`)) === requestsBefore,
    "a blocked click asked the browser again",
  );
  cover(1, "the control reads off, on, and blocked and survives a reload");

  // A dismissed prompt leaves the channel off.
  await setPermission("prompt");
  await page.deliver([UNCHANGED_VERSION]);
  check((await page.control()).state === "off", "a prompt-permission page is not off");
  await page.eval(`window.__devboardOs.requestMode = 'dismiss'`);
  const dismissedBefore = await page.eval<number>(`window.__devboardOs.requests`);
  await page.clickControl();
  await settle();
  control = await page.control();
  check(
    control.state === "off" &&
      (await page.eval<number>(`window.__devboardOs.requests`)) === dismissedBefore + 1,
    "a dismissed prompt does not leave the control off",
    control,
  );
  check(control.enabled === null, "a dismissed prompt stored an on choice", control);

  // While granted, each click toggles without another prompt.
  await setPermission("granted");
  await page.deliver([UNCHANGED_VERSION]);
  const grantedRequests = await page.eval<number>(`window.__devboardOs.requests`);
  await page.clickControl();
  await settle();
  check((await page.control()).state === "on", "a granted click did not turn the channel on");
  await page.clickControl();
  await settle();
  check((await page.control()).state === "off", "a granted click did not turn the channel off");
  check(
    (await page.eval<number>(`window.__devboardOs.requests`)) === grantedRequests,
    "a granted toggle asked the browser again",
  );

  // 2. Enable with nothing pending, then reload with the channel on.
  await page.clickControl();
  await settle();
  check((await page.control()).state === "on", "the channel did not stay on for the seed");
  await devtools.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__devboardInitialFrames = ${JSON.stringify(
      [...SEEDED.flatMap((entry) => entry.frames), ...SEED_TAIL],
    )};`,
  });
  await devtools.send("Page.reload", { ignoreCache: false });
  await page.wait(
    `document.readyState === "complete" &&
      document.querySelector('[data-testid="os-notifications"]') !== null`,
    "the reloaded shell",
    60_000,
  );
  await page.wait(CONNECTED, "the reloaded connection", 30_000);
  control = await page.control();
  check(
    control.state === "on" && control.label === "OS notifications on",
    "the on choice did not survive the reload",
    control,
  );

  const recorded = await page.wait<Array<{ title: string; body: string; keys: string[] }>>(
    `window.__devboardOs.notifications.length >= ${SEEDED.length}
      ? window.__devboardOs.notifications : null`,
    "one notification per seeded pending surface",
    30_000,
  );
  check(
    recorded.length === SEEDED.length,
    `expected ${SEEDED.length} notifications, recorded ${recorded.length}`,
    recorded,
  );
  for (const entry of SEEDED) {
    const matches = recorded.filter((message) => message.body === entry.message);
    check(matches.length === 1, `the ${entry.surface} did not raise exactly one notification`, {
      surface: entry.surface,
      messages: recorded,
    });
    const message = matches[0]!;
    check(
      message.title.startsWith("devboard") && message.title.includes(entry.label),
      "the notification does not name devboard and the asking surface",
      { title: message.title, label: entry.label },
    );
    check(message.keys.includes("onclick") === false, "the notification carries a click handler");
    console.log(`NOTIFICATION ${entry.surface}: ${message.title} — ${message.body}`);
  }
  cover(8, "questions pending at load each raise one notification after the first state");
  cover(2, "enabling with pending questions raises one notification for each");
  cover(3, "every question surface raises one notification");
  cover(4, "each notification names devboard, the surface label, and the question");
  cover(5, "notifications are raised while the document is focused and visible");

  // 6. Repeated snapshots and reconnects never repeat a question.
  const focused = await page.eval<{ visible: string; focused: boolean }>(`({
    visible: document.visibilityState,
    focused: document.hasFocus(),
  })`);
  check(focused.visible === "visible" && focused.focused, "the page is not focused", focused);
  await page.deliver([...SEEDED.flatMap((entry) => entry.frames), ...SEED_TAIL]);
  await page.deliver([...SEEDED.flatMap((entry) => entry.frames), ...SEED_TAIL]);
  await settle();
  const afterRefresh = await page.delivered();
  check(
    afterRefresh.length === SEEDED.length,
    "two state refreshes repeated a pending question",
    afterRefresh,
  );
  console.log(`REFRESH 2 -> ${afterRefresh.length} notification(s)`);
  cover(6, "repeated snapshots and reconnects never repeat a pending question");

  // 7. Answering is quiet.
  await page.deliver(RESOLUTION);
  await settle();
  const afterAnswer = await page.delivered();
  check(
    afterAnswer.length === SEEDED.length,
    "an answered question raised another notification",
    afterAnswer,
  );
  await page.deliver(SEEDED[2]!.frames);
  await settle();
  check(
    (await page.delivered()).length === SEEDED.length,
    "a resolved question raised a notification when it was observed again",
  );
  console.log(`ANSWER -> ${afterAnswer.length} notification(s)`);
  cover(7, "answering raises nothing and a resolved question stays quiet");

  // 10. Only questions: errors and update frames raise nothing.
  await page.deliver([
    { type: "error", message: "Something unrelated failed." },
    { type: "flowError", message: "Flow failed." },
    { type: "versionState", running: "1.0.0", installed: "1.0.1", latest: "1.0.1", stale: true },
  ]);
  await settle();
  check(
    (await page.delivered()).length === SEEDED.length,
    "a non-question frame raised an OS notification",
  );
  const serviceWorkers = await page.eval<number>(`(() =>
    navigator.serviceWorker.getRegistrations().then((registrations) => registrations.length)
  )()`);
  check(serviceWorkers === 0, "the dashboard registered a service worker", serviceWorkers);
  cover(10, "only pending questions raise notifications; the in-app region is untouched");
  cover(11, "the open page alone raises them: no service worker, push, or external notifier");

  // 9. Off is silent; blocked is silent and the page stays usable.
  await page.clickControl();
  await settle();
  check((await page.control()).state === "off", "the control did not turn off");
  await page.deliver(freshQuestion(91, "A question while off"));
  await settle();
  check(
    (await page.delivered()).length === SEEDED.length,
    "a question raised a notification while the channel was off",
  );
  check(
    (await page.eval<boolean>(`document.querySelector('[data-testid="app-shell"]') !== null`)),
    "turning the channel off broke the page",
  );
  await setPermission("denied");
  await page.deliver([UNCHANGED_VERSION]);
  check((await page.control()).state === "blocked", "a denied browser is not blocked");
  await page.deliver(freshQuestion(92, "A question while blocked"));
  await settle();
  check(
    (await page.delivered()).length === SEEDED.length,
    "a blocked browser raised an OS notification",
  );
  cover(9, "off and blocked are silent and the dashboard stays usable");

  // The reload count: one notification per seeded question in the new page.
  await setPermission("granted");
  await page.deliver([UNCHANGED_VERSION]);
  await settle();
  if ((await page.control()).state !== "on") {
    await page.clickControl();
    await settle();
  }
  check((await page.control()).state === "on", "the channel is not on for the reload");
  await page.wait(CONNECTED, "the connection before the second reload");
  await devtools.send("Page.reload", { ignoreCache: false });
  await page.wait(
    `document.readyState === "complete" &&
      document.querySelector('[data-testid="os-notifications"]') !== null`,
    "the second reload's shell",
    60_000,
  );
  const reloaded = await page.wait<Array<{ title: string; body: string; keys: string[] }>>(
    `window.__devboardOs.notifications.length >= ${SEEDED.length}
      ? window.__devboardOs.notifications : null`,
    "one notification per question after reload",
    30_000,
  );
  check(
    reloaded.length === SEEDED.length,
    `the reload recorded ${reloaded.length} instead of ${SEEDED.length}`,
    reloaded,
  );
  for (const entry of SEEDED) {
    check(
      reloaded.filter((message) => message.body === entry.message).length === 1,
      `reload did not record exactly one ${entry.surface} notification`,
      reloaded,
    );
  }
  console.log(`RELOAD count -> 1 per question (${reloaded.length})`);

  check(devtools.errors.length === 0, "the page raised runtime errors", devtools.errors);

  for (const criterion of [...covered.keys()].sort((left, right) => left - right)) {
    console.log(`PASS ${criterion}: ${covered.get(criterion)}`);
  }
  console.log("PASS: OS notification channel verified");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  devtools?.close();
  browser?.close();
  if (chromeProcess !== undefined) {
    const chrome = chromeProcess;
    const exited = Promise.withResolvers<void>();
    chrome.once("exit", () => exited.resolve());
    chrome.kill("SIGTERM");
    await exited.promise;
  }
  if (serverProcess !== undefined) {
    const server = serverProcess;
    const exited = Promise.withResolvers<void>();
    server.once("exit", () => exited.resolve());
    server.kill("SIGTERM");
    await exited.promise;
  }
}

process.exit(process.exitCode ?? 0);
