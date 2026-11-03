#!/usr/bin/env bun
/**
 * The deterministic API Standards gate. It builds the client, starts a source
 * dashboard against a fixture checkout, and drives headless Chrome with a stub
 * ACP peer, a stub Gitea API, and a fixture REST skill. It proves the shared
 * page shape, the audited surface, MUST/SHOULD admissibility, provenance,
 * dedupe, the filing caps, single flight, the read-only guarantee, the
 * preflight refusals, activity freshness, and the lifecycle without a reload.
 *
 * Every fixture, state directory, browser profile, and log lives under
 * `.devboard/.tmp`. It never contacts a real forge, npm, Gitea, or model.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertTrue,
  VERIFY_DASHBOARD_AUTHORIZATION,
  dashboardPageUrl,
  dashboardSocket,
  freePort,
  harnessRoot,
  makeRoot,
  run,
  waitFor,
} from "./verification";
import { seedVerificationProvider, verificationProviderUsageEnv } from "./provider-fixture";
import {
  API_STANDARDS_LABEL,
  cyclesDirectory,
  lockPath,
  versionedStatePath,
} from "../issues/api-standards/paths";
import { readState } from "../issues/api-standards/state";
import { readHarnessVersion } from "../server/version";

const stubAcp = join(harnessRoot, "tests", "fixtures", "api-standards-stub-acp.ts");
const stubForge = join(harnessRoot, "tests", "fixtures", "api-standards-stub-forge.ts");
const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`;
    throw new Error(`verify:api-standards: ${message}${detail}`);
  }
}

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("verify:api-standards: Chrome is unavailable");
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
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        settle({ id, error: { message: `the ${method} reply did not arrive within 15s` } });
      }
    }, 15_000);
    timer.unref?.();
    this.pending.set(id, (reply) => {
      clearTimeout(timer);
      settle(reply);
    });
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

async function count(devtools: Devtools, selector: string): Promise<number> {
  const value = await devtools.evaluate(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
  return typeof value === "number" ? value : -1;
}

async function text(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    return element === null ? "" : (element.textContent ?? '').trim();
  })()`);
  return typeof value === "string" ? value : "";
}

async function rawText(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.textContent ?? null`,
  );
  return typeof value === "string" ? value : "";
}

async function stateOf(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.dataset.state ?? ''`,
  );
  return typeof value === "string" ? value : "";
}

async function click(devtools: Devtools, testid: string): Promise<void> {
  await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    if (element === null) return false;
    element.click();
    return true;
  })()`);
}

async function setInput(devtools: Devtools, testid: string, value: string): Promise<void> {
  await devtools.evaluate(`(() => {
    const element = document.querySelector('[data-testid="${testid}"]');
    if (element === null) return false;
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(element, ${JSON.stringify(value)});
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

async function coreOrder(devtools: Devtools): Promise<string[]> {
  const value = await devtools.evaluate(`(() => {
    const page = document.querySelector('[data-testid="agent-page"]');
    const all = [...(page?.querySelectorAll('[data-testid]') ?? [])]
      .map((element) => element.getAttribute('data-testid') ?? '');
    const core = ${JSON.stringify(CORE_IDS)};
    return all.filter((id) => core.includes(id));
  })()`);
  return Array.isArray(value) ? (value as string[]) : [];
}

async function rows(devtools: Devtools): Promise<
  Array<{ url: string; state: string; title: string; category: string }>
> {
  const value = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="agent-issue"]')
  ].map((row) => ({
    url: row.dataset.url ?? '',
    state: row.dataset.state ?? '',
    title: row.querySelector('[data-testid="agent-issue-title"]')?.textContent?.trim() ?? '',
    category: row.querySelector('[data-testid="agent-issue-category"]')?.textContent?.trim() ?? '',
  })))()`);
  return Array.isArray(value)
    ? (value as Array<{ url: string; state: string; title: string; category: string }>)
    : [];
}

async function barLog(devtools: Devtools): Promise<string> {
  const expanded = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-log"]') !== null`,
  );
  if (expanded !== true) {
    const diagnostic = await devtools.evaluate(`(() => {
      const page = document.querySelector('[data-testid="agent-page"]');
      const toggle = page?.querySelector('[data-testid="agent-activity-toggle"]');
      if (toggle === null || toggle === undefined) return { toggle: false, page: page !== null };
      toggle.click();
      return {
        toggle: true,
        page: page !== null,
        tag: toggle.tagName,
        expanded: toggle.getAttribute('aria-expanded'),
        logs: page.querySelectorAll('[data-testid="agent-activity-log"]').length,
      };
    })()`);
    if (typeof diagnostic === "object" && diagnostic !== null) {
      const record = diagnostic as Record<string, unknown>;
      if (record.toggle !== true || record.page !== true) {
        throw new Error(`verify:api-standards: the activity toggle is unreachable: ${JSON.stringify(record)}`);
      }
    }
  }
  await waitFor(
    async () =>
      (await devtools.evaluate(
        `document.querySelector('[data-testid="agent-page"] [data-testid="agent-activity-log"]') !== null`,
      )) === true
        ? true
        : undefined,
    "the activity bar log",
    15_000,
  );
  return rawText(devtools, "agent-activity-log");
}

interface StubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  createdAt: string;
  labels: string[];
}

const root = await makeRoot("verify-api-standards");
console.error(`verify-api-standards: fixture ${root}`);
let dashboardPid = 0;
let chromePid = 0;
let forgePid = 0;
let devtools: Devtools | undefined;

const STUB_FORGE_START = 30_000;

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:api-standards: bun run build failed: ${build.stderr}`);
  assertTrue(
    Bun.file(join(harnessRoot, "dist", "index.html")).size > 0,
    "verify:api-standards: the build produced dist/index.html",
  );

  const repo = join(root, "repo");
  const stateDir = join(repo, ".devboard", ".tmp", "state");
  const stubDir = join(root, "stub");
  const acpLog = join(root, "acp.log");
  const forgeStatePath = join(root, "forge-state.json");
  await mkdir(join(repo, ".devboard", "server"), { recursive: true });
  await mkdir(join(repo, ".devboard", "prompts"), { recursive: true });
  await mkdir(join(repo, ".devboard", ".tmp"), { recursive: true });
  await mkdir(join(repo, ".omp", "skills", "devboard-restful-api-implementation", "references"), {
    recursive: true,
  });
  await mkdir(join(repo, "adrs"), { recursive: true });
  await mkdir(stubDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await cp(
    join(harnessRoot, "prompts", "api-standards.md"),
    join(repo, ".devboard", "prompts", "api-standards.md"),
  );
  await writeFile(
    join(repo, ".devboard", ".gitignore"),
    ".tmp/\n",
  );
  await writeFile(
    join(repo, ".devboard", "server", "app.ts"),
    [
      "export function handle(request: Request, url: URL): Response {",
      '  if (url.pathname === "/api/feedback") {',
      '    if (request.method === "POST") return Response.json({ ok: true }, { status: 202 });',
      '    return new Response("Method Not Allowed", { status: 405 });',
      "  }",
      '  if (url.pathname === "/api/ready") {',
      "    return Response.json({ pid: 1 });",
      "  }",
      '  if (url.pathname === "/api/goal-proposals") {',
      '    if (request.method === "POST") return Response.json({ slug: "one" }, { status: 201 });',
      '    return new Response("Method Not Allowed", { status: 405 });',
      "  }",
      '  if (url.pathname === "/ws") {',
      '    if (request.method === "GET") return new Response(null, { status: 426 });',
      '    return new Response("Bad Request", { status: 400 });',
      "  }",
      '  return new Response(Bun.file("dist/index.html"));',
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, ".omp", "skills", "devboard-restful-api-implementation", "SKILL.md"),
    [
      "# RESTful API Implementation",
      "",
      "Audit the HTTP API against this skill's rule table. The skill is the sole normative text.",
      "",
      "## URLs",
      "",
      "- Pluralize collection names and write segments in lower-case kebab-case.",
      "",
      "## HTTP requests",
      "",
      "- Use HTTP methods according to RFC 9110 and preserve their safety and idempotency.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, ".omp", "skills", "devboard-restful-api-implementation", "references", "zalando-rest-rules.md"),
    [
      "# Zalando RESTful API Guidelines — REST rule set",
      "",
      "## URLs",
      "",
      "| Rule | Level | Directive |",
      "| --- | --- | --- |",
      "| 134 | MUST | Use plural resource names for collections. |",
      "| 129 | SHOULD | Write path segments in lower-case kebab-case. |",
      "",
      "## HTTP requests",
      "",
      "| Rule | Level | Directive |",
      "| --- | --- | --- |",
      "| 148 | MUST | Use HTTP methods according to RFC 9110. |",
      "| 149 | MUST | Preserve the safety and idempotency of each method. |",
      "| 100 | MAY | Offer an optional OpenAPI document. |",
      "",
    ].join("\n"),
  );
  await writeFile(join(repo, "adrs", "keep.txt"), "adrs\n");
  await writeFile(join(repo, "GOAL.md"), "# Goal\n");
  await writeFile(join(repo, "tracked.txt"), "fixture\n");

  const git = (args: string[], cwd = repo): string => {
    const result = run("git", ["-C", cwd, ...args]);
    check(result.code === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  run("git", ["init", "-q", repo]);
  git(["config", "user.email", "verify@example.test"]);
  git(["config", "user.name", "Devboard Verify"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);

  const forgePort = await freePort();
  await writeFile(forgeStatePath, JSON.stringify({ next: 1, nextLabel: 2, labels: [
    { id: 1, name: API_STANDARDS_LABEL, color: "0e8a16", description: "" },
  ], issues: [] }, null, 2));
  const forge = spawn(process.execPath, [stubForge], {
    env: {
      ...process.env,
      PORT: String(forgePort),
      API_STANDARDS_STUB_FORGE_STATE: forgeStatePath,
      API_STANDARDS_STUB_FORGE_LOG: join(root, "forge.log"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  forgePid = forge.pid ?? 0;
  forge.stderr?.on("data", (chunk) => {
    writeFileSync(join(root, "forge.stderr"), String(chunk));
  });
  forge.on("exit", (code, signal) => {
    writeFileSync(join(root, "forge.exit"), `${String(code)} ${String(signal)}\n`);
  });
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${forgePort}/admin/health`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the stub forge",
    STUB_FORGE_START,
  );
  git(["remote", "add", "origin", `http://127.0.0.1:${forgePort}/acme/fixture.git`]);

  const forgeState = async (): Promise<{ issues: StubIssue[] }> => {
    const response = await fetch(`http://127.0.0.1:${forgePort}/admin/state`);
    return (await response.json()) as { issues: StubIssue[] };
  };
  const seedIssue = async (title: string): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${forgePort}/admin/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, state: "open", labels: [API_STANDARDS_LABEL] }),
    });
    check(response.ok, "the stub forge refused a seeded issue");
  };
  const setMode = (mode: string): void => {
    writeFileSync(join(stubDir, "mode"), `${mode}\n`);
  };
  const cycleIds = (): string[] => {
    try {
      return readdirSync(cyclesDirectory(repo)).sort();
    } catch {
      return [];
    }
  };
  const waitForCycleAfter = (previous: string | undefined): Promise<string> =>
    waitFor(
      () => {
        const ids = cycleIds();
        const newest = ids.at(-1);
        return newest !== undefined && newest !== previous ? newest : undefined;
      },
      "the next api-standards cycle",
      90_000,
    );
  const cycleRequest = (cycleId: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(join(cyclesDirectory(repo), cycleId, "request.json"), "utf8"),
    ) as Record<string, unknown>;

  const workerVersion = readHarnessVersion(harnessRoot);
  const publishedState = () => readState(versionedStatePath(stateDir, repo, workerVersion));
  const modeLock = lockPath(repo);

  const gitStatusBefore = git(["status", "--porcelain"]);
  const headBefore = git(["rev-parse", "HEAD"]);

  setMode("must");
  await writeFile(acpLog, "");
  await seedIssue("POST /api/ready ignores the method");

  seedVerificationProvider(stateDir);
  const port = await freePort();
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      ...verificationProviderUsageEnv(),
      HOST: "127.0.0.1",
      PORT: String(port),
      REPO_DIR: repo,
      ADRS_DIR: join(repo, "adrs"),
      GOAL_FILE: join(repo, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: stateDir,
      AGENT_COMMAND: `${process.execPath} ${stubAcp}`,
      DEVBOARD_GITEA_URL: `http://127.0.0.1:${forgePort}`,
      GITEA_TOKEN: "verification-token",
      API_STANDARDS_STUB_DIR: stubDir,
      API_STANDARDS_STUB_LOG: acpLog,
      API_STANDARDS_STUB_DELAY_MS: "800",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  dashboardPid = dashboard.pid ?? 0;
  const dashboardErrors: string[] = [];
  dashboard.stderr?.on("data", (chunk) => dashboardErrors.push(String(chunk)));

  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`, {
          headers: { ...VERIFY_DASHBOARD_AUTHORIZATION },
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
      dashboardPageUrl(port),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromePid = chrome.pid ?? 0;

  devtools = new Devtools(await pageTarget(debugPort, port));
  await devtools.connect();
  await devtools.send("Runtime.enable");
  await devtools.send("Page.enable");

  await waitFor(
    async () => ((await present(devtools!, "mode-devboard")) ? true : undefined),
    "the Devboard mode control",
    30_000,
  );
  await click(devtools, "mode-devboard");
  await waitFor(
    async () => ((await present(devtools!, "open-devboard-api-standards")) ? true : undefined),
    "the API Standards sidebar entry",
    15_000,
  );

  /* 1. The sidebar lists the fifth audit agent in order with its badge and count. */
  const sidebar = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="sidebar-background-agents"] [data-testid^="open-devboard-"]')
  ].map((button) => button.getAttribute('data-testid') ?? ''))()`);
  check(
    JSON.stringify(sidebar) ===
      JSON.stringify([
        "open-devboard-scout",
        "open-devboard-watchdog",
        "open-devboard-design",
        "open-devboard-dead-code",
        "open-devboard-mcp-optimizer",
        "open-devboard-api-standards",
        "open-devboard-single-responsibility",
        "open-devboard-consistent-naming",
        "open-devboard-release-train",
      ]),
    "the Background agents order is wrong",
    sidebar,
  );
  const entry = await devtools.evaluate(`(() => {
    const button = document.querySelector('[data-testid="open-devboard-api-standards"]');
    return {
      label: button?.querySelector('.sidebar-item__label')?.textContent?.trim() ?? '',
      state: button?.querySelector('[data-testid="agent-state-api-standards"]')?.dataset.state ?? '',
      count: button?.querySelector('[data-testid="agent-count-api-standards"]')?.textContent?.trim() ?? '',
    };
  })()`) as Record<string, string>;
  check(
    entry.label === "API Standards" && entry.state === "stopped" && entry.count === "0",
    "the API Standards sidebar entry is wrong",
    entry,
  );
  console.log("PASS sidebar-entry");

  /* 2. The shared page shape, with no per-agent panel fork. */
  await click(devtools, "open-devboard-api-standards");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the API Standards page",
    10_000,
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
    )) === "api-standards",
    "the page is not the API Standards page",
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-cadence"]')?.value ?? ''`,
    )) === "60",
    "the API Standards cadence does not default to 60 minutes",
  );
  const order = await coreOrder(devtools);
  check(
    JSON.stringify(order.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    "the API Standards core id order differs",
    order,
  );
  check(
    !(await present(devtools, "agent-detail")),
    "the removed agent detail panel is still rendered",
  );
  check(
    !(await present(devtools, "agent-documentation")),
    "API Standards renders a documentation panel",
  );
  const startStop = (await count(devtools, '[data-testid="agent-start"]')) +
    (await count(devtools, '[data-testid="agent-stop"]'));
  check(startStop === 1, `the page renders ${startStop} start/stop controls`);
  check(await present(devtools, "agent-issues-empty"), "the filed issues empty state is missing");
  for (const testid of ["agent-issues", "agent-issues-count", "agent-sync-at", "agent-activity-bar"]) {
    check(await present(devtools, testid), `${testid} is missing`);
  }
  await click(devtools, "agent-prompt-summary");
  await waitFor(
    async () => ((await present(devtools!, "agent-prompt-text")) ? true : undefined),
    "the API Standards prompt bytes",
    10_000,
  );
  const promptBytes = readFileSync(join(harnessRoot, "prompts", "api-standards.md"), "utf8");
  check(
    (await rawText(devtools, "agent-prompt-text")) === promptBytes,
    "the API Standards prompt bytes differ",
  );
  for (const testid of ["agent-prompt-editor", "agent-prompt-save", "agent-prompt-chat"]) {
    check(!(await present(devtools, testid)), `the prompt is editable through ${testid}`);
  }
  console.log("PASS page-shape");

  console.log("STEP start-lifecycle");
  /* 3. Start → starting → running, one cycle, and the MUST finding's provenance. */
  // The server's own lifecycle frames are the authoritative sequence: a
  // page may coalesce a short state, but the bridge publishes each one.
  const lifecycleSocket = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
  const lifecycleStates: string[] = [];
  lifecycleSocket.onmessage = (event) => {
    let frame: { type?: string; agent?: { id?: string; lifecycle?: string } };
    try {
      frame = JSON.parse(String(event.data)) as typeof frame;
    } catch {
      return;
    }
    if (frame.type !== "agentState" || frame.agent?.id !== "api-standards") return;
    const lifecycle = frame.agent.lifecycle ?? "";
    if (lifecycle.length > 0 && lifecycleStates.at(-1) !== lifecycle) {
      lifecycleStates.push(lifecycle);
    }
  };
  const lifecycleOpen = Promise.withResolvers<void>();
  lifecycleSocket.onopen = () => lifecycleOpen.resolve();
  lifecycleSocket.onerror = () => lifecycleOpen.resolve();
  await lifecycleOpen.promise;
  await click(devtools, "agent-start");
  const firstCycle = await waitForCycleAfter(undefined);
  await waitFor(
    async () =>
      (await stateOf(devtools!, "agent-state-api-standards")) === "running" ? true : undefined,
    "API Standards to run",
    30_000,
  );
  const request = cycleRequest(firstCycle);
  check(
    Array.isArray(request.routes) && (request.routes as unknown[]).length === 5,
    "the cycle's route inventory is wrong",
    request.routes,
  );
  check(
    Array.isArray(request.rules) && (request.rules as unknown[]).length === 5,
    "the cycle did not read the skill's rule table",
    request.rules,
  );
  check(
    request.issueRoom === 4,
    `the first cycle's filing room is ${String(request.issueRoom)}`,
  );

  // A second Start request during the running cycle must not spawn another turn.
  const beforeStarts = readFileSync(acpLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("start ")).length;
  const ws = dashboardSocket(`ws://127.0.0.1:${port}/ws`);
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  ws.onerror = () => opened.resolve();
  await opened.promise;
  const handled = Promise.withResolvers<void>();
  let messages = 0;
  ws.onmessage = () => {
    messages += 1;
    if (messages >= 2) handled.resolve();
  };
  ws.send(JSON.stringify({ type: "startAgent", id: "api-standards" }));
  const handledTimer = setTimeout(handled.resolve, 3000);
  await handled.promise;
  clearTimeout(handledTimer);
  ws.close();
  const afterStarts = readFileSync(acpLog, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("start ")).length;
  check(afterStarts === beforeStarts, "a second Start spawned another audit turn");

  const mustIssue = await waitFor(
    async () => {
      const state = await forgeState();
      return state.issues.find(
        (entry) => entry.title === "GET /api/ready answers POST without 405",
      );
    },
    "the MUST issue",
    60_000,
  );
  check(mustIssue.labels.includes(API_STANDARDS_LABEL), "the filed issue lacks the api-standards label", mustIssue);
  check(mustIssue.title === "GET /api/ready answers POST without 405", `title is ${mustIssue.title}`);
  for (const expected of [
    "## Chapter",
    "HTTP requests",
    "**148 — MUST**",
    "> Use HTTP methods according to RFC 9110.",
    ".omp/skills/devboard-restful-api-implementation/SKILL.md",
    ".omp/skills/devboard-restful-api-implementation/references/zalando-rest-rules.md",
    ".devboard/server/app.ts:1",
    "- `POST /api/ready`",
    "## Proposed change",
    "## Acceptance criteria",
  ]) {
    check(mustIssue.body.includes(expected), `the MUST issue body lacks ${expected}`, mustIssue.body);
  }
  console.log(
    "verify-api-standards: the MUST issue names " +
      ".omp/skills/devboard-restful-api-implementation/SKILL.md and " +
      ".omp/skills/devboard-restful-api-implementation/references/zalando-rest-rules.md",
  );
  await waitFor(
    async () => ((await rows(devtools!)).length === 2 ? true : undefined),
    "the filed-issue rows",
    60_000,
  );
  const rendered = await rows(devtools);
  check(
    (await text(devtools, "agent-issues-count")) === "2 filed",
    `the filed count says ${await text(devtools, "agent-issues-count")}`,
  );
  const sidebarCount = await devtools.evaluate(
    `document.querySelector('[data-testid="agent-count-api-standards"]')?.textContent?.trim() ?? ''`,
  );
  check(
    sidebarCount === String(rendered.length),
    `the sidebar count ${String(sidebarCount)} differs from ${rendered.length} rows`,
  );
  const firstActivity = await barLog(devtools);
  for (const expected of [
    "route(s) and 1 source file(s)",
    "5 rule(s) from",
    "admissible rule 148 MUST · HTTP requests",
    "filed #",
  ]) {
    check(firstActivity.includes(expected), `the activity log lacks ${expected}`, firstActivity);
  }
  // A 1-minute cadence keeps the verification's cycles bounded; the worker
  // applies it without a restart and starts no cycle sooner than that interval.
  await setInput(devtools, "agent-cadence", "1");
  await click(devtools, "agent-save-cadence");
  await waitFor(
    async () => {
      const saved = await devtools!.evaluate(
        `document.querySelector('[data-testid="agent-cadence"]')?.value ?? ''`,
      );
      return publishedState()?.intervalMinutes === 1 && saved === "1" ? true : undefined;
    },
    "the one-minute cadence",
    20_000,
  );
  console.log("PASS must-finding");

  console.log("STEP should");
  /* 4. A SHOULD violation files one issue. */
  setMode("should");
  const shouldCycle = await waitForCycleAfter(firstCycle);
  const shouldIssue = await waitFor(
    async () => {
      const state = await forgeState();
      const issue = state.issues.find((entry) => entry.title === "Collection paths do not use kebab-case");
      return issue === undefined ? undefined : issue;
    },
    "the SHOULD issue",
    90_000,
  );
  check(shouldIssue.labels.includes(API_STANDARDS_LABEL), "the SHOULD issue lacks its label");
  check(
    shouldIssue.body.includes("**129 — SHOULD**") &&
      shouldIssue.body.includes("> Write path segments in lower-case kebab-case."),
    "the SHOULD issue body is wrong",
    shouldIssue.body,
  );
  check(
    cycleRequest(shouldCycle).rules !== undefined,
    "the SHOULD cycle carried no rule table",
  );
  console.log("PASS should-finding");

  console.log("STEP duplicate");
  /* 5. A duplicate title files nothing and is recorded. */
  const beforeDuplicate = (await forgeState()).issues.length;
  setMode("duplicate");
  const duplicateCycle = await waitForCycleAfter(shouldCycle);
  const duplicateTitles = cycleRequest(duplicateCycle).knownTitles as string[];
  check(
    Array.isArray(duplicateTitles) &&
      duplicateTitles.map((title) => title.toLowerCase().replace(/\s+/g, " ").trim()).includes(
        "post /api/ready ignores the method",
      ),
    "the duplicate cycle's known titles lack the seeded title",
    duplicateTitles,
  );
  await waitFor(
    async () => ((await barLog(devtools!)).includes("skipped (duplicate)") ? true : undefined),
    "the duplicate decision",
    60_000,
  );
  const duplicateCount = (await forgeState()).issues.length;
  check(
    duplicateCount === beforeDuplicate,
    `a duplicate was filed: ${duplicateCount} issues, was ${beforeDuplicate}`,
  );
  check(
    cycleRequest(duplicateCycle).issueRoom !== undefined,
    "the duplicate cycle carried no request",
  );
  console.log("PASS duplicate");

  console.log("STEP may");
  /* 6. A MAY-only deviation files nothing and appears in activity. */
  const beforeMay = (await forgeState()).issues.length;
  setMode("may");
  const mayCycle = await waitForCycleAfter(duplicateCycle);
  await waitFor(
    async () => ((await barLog(devtools!)).includes("skipped (may-level)") ? true : undefined),
    "the MAY decision",
    60_000,
  );
  check(
    (await forgeState()).issues.length === beforeMay,
    "a MAY-level deviation was filed",
  );
  check(cycleRequest(mayCycle).issueRoom !== undefined, "the MAY cycle carried no request");
  console.log("PASS may-only");

  console.log("STEP caps");
  /* 7. A full pending cap files nothing; clearing it resumes filing. */
  await seedIssue("A seeded open conformance finding");
  const openBeforeCap = (await forgeState()).issues.filter((issue) => issue.state === "open").length;
  await setInput(devtools, "agent-limit-pending", "1");
  await click(devtools, "agent-save-limits");
  await waitFor(
    async () => {
      const snapshot = await devtools!.evaluate(
        `document.querySelector('[data-testid="agent-limit-pending"]')?.value ?? ''`,
      );
      return snapshot === "1" ? true : undefined;
    },
    "the pending limit field",
    10_000,
  );
  setMode("cap");
  const capCycle = await waitForCycleAfter(mayCycle);
  await waitFor(
    async () => ((await barLog(devtools!)).includes("skipped (no-room)") ? true : undefined),
    "the no-room decision",
    90_000,
  );
  check(
    (await forgeState()).issues.filter((issue) => issue.state === "open").length ===
      openBeforeCap,
    "a cycle filed under a full pending cap",
  );
  check(cycleRequest(capCycle).issueRoom === 0, "the capped cycle's room is not zero");

  await setInput(devtools, "agent-limit-pending", "");
  await click(devtools, "agent-save-limits");
  await waitFor(
    async () => {
      const state = publishedState();
      return state?.limits.maxPending === null ? true : undefined;
    },
    "the cleared pending limit",
    15_000,
  );
  setMode("single");
  const resumedCycle = await waitForCycleAfter(capCycle);
  const resumed = await waitFor(
    async () => {
      const state = await forgeState();
      const issue = state.issues.find(
        (entry) => entry.title === "Response body omits the required snake_case names",
      );
      return issue === undefined ? undefined : issue;
    },
    "the resumed filing",
    90_000,
  );
  check(resumed.labels.includes(API_STANDARDS_LABEL), "the resumed issue lacks its label");
  const resumedRoom = cycleRequest(resumedCycle).issueRoom;
  check(
    typeof resumedRoom === "number" && resumedRoom > 0,
    "clearing the cap did not restore the room",
  );
  console.log("PASS caps");

  /* 10. The checkout and its git state are unchanged after every cycle. */
  check(git(["status", "--porcelain"]) === gitStatusBefore, "a cycle changed the checkout");
  check(git(["rev-parse", "HEAD"]) === headBefore, "a cycle changed HEAD");
  check(cyclesDirectory(repo).length > 0, "the cycles directory is empty");
  console.log("PASS read-only");

  console.log("STEP route");
  /* 8. A route added to the fixture source appears in the next cycle's input. */
  await writeFile(
    join(repo, ".devboard", "server", "health.ts"),
    [
      "export function health(request: Request, url: URL): Response | undefined {",
      '  if (url.pathname === "/api/health") {',
      '    if (request.method === "GET") return Response.json({ ok: true });',
      "    return new Response(null, { status: 405 });",
      "  }",
      "  return undefined;",
      "}",
      "",
    ].join("\n"),
  );
  setMode("none");
  const activityBeforeRoute = await barLog(devtools);
  const routeCycle = await waitForCycleAfter(resumedCycle);
  const routes = cycleRequest(routeCycle).routes as Array<{ path: string }>;
  check(
    Array.isArray(routes) && routes.some((route) => route.path === "/api/health"),
    "the added route is absent from the next cycle's input",
    routes,
  );
  await waitFor(
    async () => {
      const log = await barLog(devtools!);
      return log !== activityBeforeRoute ? true : undefined;
    },
    "the activity bar to change without a reload",
    60_000,
  );
  console.log("PASS route-and-freshness");

  check(
    git(["status", "--porcelain", "--untracked-files=no"]) === gitStatusBefore,
    "a cycle changed a tracked file after the route was added",
  );
  check(git(["rev-parse", "HEAD"]) === headBefore, "a cycle changed HEAD after the route");

  console.log("STEP stop");
  /* 9. Stop ends the worker; the page reports stopping and stopped. */
  await click(devtools, "agent-stop");
  await waitFor(
    async () =>
      (await stateOf(devtools!, "agent-state-api-standards")) === "stopped" ? true : undefined,
    "API Standards to stop",
    30_000,
  );
  check(
    JSON.stringify(lifecycleStates) ===
      JSON.stringify(["stopped", "starting", "running", "stopping", "stopped"]),
    `the lifecycle states were not reported in order: ${JSON.stringify(lifecycleStates)}`,
  );
  lifecycleSocket.close();
  check(
    (await stateOf(devtools, "agent-state-api-standards")) === "stopped",
    "the sidebar badge did not reach stopped",
  );
  await waitFor(
    async () => (existsSync(modeLock) ? undefined : true),
    "the repository lock to be released",
    20_000,
  );
  console.log("PASS lifecycle");

  console.log("STEP refusals");
  /* 11. Preflight refusals name the missing fact, spawn nothing, and record no cycle. */
  const refusals: Array<{ name: string; breakIt: () => void; restore: () => void; expected: string }> = [
    {
      name: "missing skill",
      breakIt: () => renameSync(
        join(repo, ".omp", "skills", "devboard-restful-api-implementation", "SKILL.md"),
        join(root, "SKILL.md.aside"),
      ),
      restore: () => renameSync(
        join(root, "SKILL.md.aside"),
        join(repo, ".omp", "skills", "devboard-restful-api-implementation", "SKILL.md"),
      ),
      expected: "SKILL.md is not readable",
    },
    {
      name: "missing reference",
      breakIt: () => renameSync(
        join(repo, ".omp", "skills", "devboard-restful-api-implementation", "references", "zalando-rest-rules.md"),
        join(root, "rules.md.aside"),
      ),
      restore: () => renameSync(
        join(root, "rules.md.aside"),
        join(repo, ".omp", "skills", "devboard-restful-api-implementation", "references", "zalando-rest-rules.md"),
      ),
      expected: "zalando-rest-rules.md is not readable",
    },
    {
      name: "missing server",
      breakIt: () => renameSync(join(repo, ".devboard", "server"), join(root, "server.aside")),
      restore: () => renameSync(join(root, "server.aside"), join(repo, ".devboard", "server")),
      expected: ".devboard/server",
    },
    {
      name: "installed prefix",
      breakIt: () => {
        renameSync(join(repo, ".devboard", "server"), join(root, "server.aside"));
        mkdirSync(join(repo, ".devboard", "node_modules", "@dsdenes", "devboard"), {
          recursive: true,
        });
      },
      restore: () => {
        rmSync(join(repo, ".devboard", "node_modules"), { recursive: true, force: true });
        renameSync(join(root, "server.aside"), join(repo, ".devboard", "server"));
      },
      expected: "installed npm prefix",
    },
  ];
  for (const refusal of refusals) {
    // A refused Start stays busy for its ceiling; wait for the control to
    // accept a new activation before breaking the next prerequisite.
    await waitFor(
      async () => {
        const busy = await devtools!.evaluate(`(() => {
          const start = document.querySelector('[data-testid="agent-start"]');
          return start === null ? null : start.getAttribute('aria-busy') === 'true';
        })()`);
        return busy === false ? true : undefined;
      },
      `the Start control before the ${refusal.name} refusal`,
      20_000,
    );
    const beforeCycles = cycleIds().length;
    const previousError = await text(devtools, "agent-error");
    refusal.breakIt();
    try {
      await click(devtools, "agent-start");
      const deadline = Date.now() + 30_000;
      let message: string | undefined;
      let observed: unknown;
      while (Date.now() < deadline) {
        observed = await devtools.evaluate(`(() => {
          const start = document.querySelector('[data-testid="agent-start"]');
          const stop = document.querySelector('[data-testid="agent-stop"]');
          const error = document.querySelector('[data-testid="agent-error"]');
          return {
            error: (error?.textContent ?? '').trim(),
            start: start !== null,
            stop: stop !== null,
            disabled: start === null ? null : start.disabled,
            state: document.querySelector('[data-testid="agent-state-api-standards"]')?.dataset.state ?? '',
          };
        })()`);
        const value = (observed as { error?: string }).error ?? "";
        const acceptable =
          value.length > 0 &&
          (value !== previousError || refusal.expected === "installed npm prefix");
        if (acceptable && value.includes(refusal.expected)) {
          message = value;
          break;
        }
        await Bun.sleep(300);
      }
      if (message === undefined) {
        throw new Error(
          `verify:api-standards: no ${refusal.name} error appeared: ${JSON.stringify(observed)}`,
        );
      }
      check(
        message.includes(refusal.expected),
        `the ${refusal.name} refusal does not name ${refusal.expected}: ${message}`,
      );
      check(cycleIds().length === beforeCycles, `the ${refusal.name} refusal wrote a cycle`);
      check(!existsSync(modeLock), `the ${refusal.name} refusal spawned a worker`);
    } finally {
      refusal.restore();
    }
    console.log(`PASS refusal-${refusal.name.replace(/\s+/g, "-")}`);
  }

  check(devtools.errors.length === 0, "the run logged a console error", devtools.errors);
  console.log("PASS no-console-errors");

  console.log(
    "verify:api-standards: the sidebar entry, shared page ids, the read-only prompt, Start → " +
      "starting → running → stopping → stopped without a second concurrent cycle, the MUST and " +
      "SHOULD filings with provenance, MAY-only and duplicate skips, the pending cap and its " +
      "clearing, the added route in the next cycle, the unchanged checkout and git state, the " +
      "named preflight refusals with no spawn or cycle, and activity freshness without a reload " +
      "all hold",
  );
} finally {
  for (const pid of [chromePid, dashboardPid, forgePid]) {
    if (pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  devtools?.close();
  if (process.env.API_STANDARDS_VERIFY_KEEP !== "1") {
    await rm(root, { recursive: true, force: true });
  } else {
    console.error(`verify:api-standards: kept ${root}`);
  }
}
