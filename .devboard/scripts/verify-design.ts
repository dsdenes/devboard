#!/usr/bin/env bun
/**
 * The deterministic Design System gate. It builds the client, starts a source
 * dashboard against a fixture checkout, and drives headless Chrome against a
 * stub ACP peer, a stub Gitea API, a local smart-HTTP git origin, and a stub
 * publisher. It proves the shared page shape, the audit and filing caps, the
 * normative documents, the autonomous worktree/push/release/publish path,
 * single flight, every failure surface, and freshness without a reload.
 *
 * Every fixture, state directory, browser profile, and log lives under
 * `.devboard/.tmp`. It never contacts a real forge, npm, Gitea, or model.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertTrue, freePort, harnessRoot, makeRoot, run, waitFor } from "./verification";
import { seedVerificationProvider, verificationProviderUsageEnv } from "./provider-fixture";

const stubAcp = join(harnessRoot, "tests", "fixtures", "design-stub-acp.ts");
const stubPublisher = join(harnessRoot, "tests", "fixtures", "design-stub-publisher.ts");
const stubForge = join(harnessRoot, "tests", "fixtures", "design-stub-forge.ts");
const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function check(condition: boolean, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    const detail = evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`;
    throw new Error(`verify:design: ${message}${detail}`);
  }
}

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("verify:design: Chrome is unavailable");
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
    return element === null ? "" : (element.textContent ?? '').replace(/\\s+/g, ' ').trim();
  })()`);
  return typeof value === "string" ? value : "";
}

async function stateOf(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.dataset.state ?? ''`,
  );
  return typeof value === "string" ? value : "";
}

/** The element's text with every byte preserved, for an exact diff. */
async function rawText(devtools: Devtools, testid: string): Promise<string> {
  const value = await devtools.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.textContent ?? null`,
  );
  return typeof value === "string" ? value : "";
}

/** The documentation panel sits immediately above the filed issues panel. */
async function documentationLayout(devtools: Devtools): Promise<{
  present: boolean;
  adjacent: boolean;
  empty: boolean;
  entries: number;
}> {
  const value = await devtools.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="agent-documentation"]');
    const issues = document.querySelector('[data-testid="agent-issues"]');
    const next = panel === null ? null : panel.nextElementSibling;
    return {
      present: panel !== null,
      adjacent: next !== null && issues !== null && next.contains(issues),
      empty: document.querySelector('[data-testid="agent-documentation-empty"]') !== null,
      entries: document.querySelectorAll('[data-testid="agent-documentation-entry"]').length,
    };
  })()`);
  return (value ?? { present: false, adjacent: false, empty: false, entries: 0 }) as {
    present: boolean;
    adjacent: boolean;
    empty: boolean;
    entries: number;
  };
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
  "agent-start",
  "agent-stop",
  "agent-cadence",
  "agent-last-run",
  "agent-next-run",
  "agent-save-cadence",
  "agent-limit-hour",
  "agent-limit-pending",
  "agent-save-limits",
  "agent-issues-count",
  "agent-issues",
  "agent-detail",
];

async function coreOrder(devtools: Devtools): Promise<string[]> {
  const value = await devtools.evaluate(`(() => {
    const all = [...document.querySelectorAll('[data-testid]')]
      .map((element) => element.getAttribute('data-testid') ?? '');
    const core = ${JSON.stringify(CORE_IDS)};
    return all.filter((id) => core.includes(id));
  })()`);
  return Array.isArray(value) ? (value as string[]) : [];
}

async function rows(devtools: Devtools): Promise<
  Array<{ url: string; state: string; version: string; title: string; category: string }>
> {
  const value = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="agent-issue"]')
  ].map((row) => ({
    url: row.dataset.url ?? '',
    state: row.dataset.state ?? '',
    version: row.dataset.version ?? '',
    title: row.querySelector('[data-testid="agent-issue-title"]')?.textContent?.trim() ?? '',
    category: row.querySelector('[data-testid="agent-issue-category"]')?.textContent?.trim() ?? '',
  })))()`);
  return Array.isArray(value)
    ? (value as Array<{ url: string; state: string; version: string; title: string; category: string }>)
    : [];
}

/** A minimal git smart-HTTP origin backed by `git http-backend`. */
function startGitServer(projectRoot: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/acme/fixture.git")) {
        return new Response("not found", { status: 404 });
      }
      const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.replace(/^\?/, ""),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body?.byteLength ?? 0),
        REMOTE_USER: "verifier",
        REMOTE_ADDR: "127.0.0.1",
      };
      const child = Bun.spawn(["git", "http-backend"], {
        env,
        stdin: body === undefined ? "ignore" : new Blob([body]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) return new Response(stderr, { status: 500 });
      const bytes = new Uint8Array(stdout);
      const marker = bytes.findIndex(
        (value, index) =>
          value === 13 &&
          bytes[index + 1] === 10 &&
          bytes[index + 2] === 13 &&
          bytes[index + 3] === 10,
      );
      if (marker < 0) return new Response(stdout, { status: 200 });
      const headers = new TextDecoder().decode(bytes.slice(0, marker));
      const payload = bytes.slice(marker + 4);
      const responseHeaders = new Headers();
      let status = 200;
      for (const line of headers.split("\r\n")) {
        const split = line.indexOf(":");
        if (split <= 0) continue;
        const key = line.slice(0, split).trim();
        const value = line.slice(split + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else responseHeaders.set(key, value);
      }
      return new Response(payload, { status, headers: responseHeaders });
    },
  });
}

const GIT_WRAPPER = (realGit: string): string => `#!/bin/sh
log="$DESIGN_GIT_LOG"
if [ -n "$log" ]; then printf '%s\\n' "$*" >> "$log"; fi
case "$*" in
  *" push "*)
    mode="$(cat "$DESIGN_STUB_DIR/push-mode" 2>/dev/null || echo ok)"
    marker="$DESIGN_STUB_DIR/push-marker"
    if [ "$mode" = "reject" ] && [ ! -f "$marker" ]; then
      touch "$marker"
      tmp="$DESIGN_STUB_REPO/.worktree/git-stub-$$"
      ${realGit} -C "$DESIGN_STUB_REPO" worktree add -q --detach "$tmp" main
      printf '\\nconcurrent main edit\\n' >> "$tmp/DESIGN.md"
      ${realGit} -C "$tmp" add DESIGN.md
      ${realGit} -C "$tmp" -c user.email=verify@example.test -c user.name=Verify commit -q -m concurrent
      ${realGit} -C "$tmp" push -q origin HEAD:main
      ${realGit} -C "$DESIGN_STUB_REPO" worktree remove --force "$tmp"
    fi
    ;;
esac
exec ${realGit} "$@"
`;

const root = await makeRoot("verify-design");
console.error(`verify-design: fixture ${root}`);
let dashboardPid = 0;
let chromePid = 0;
let devtools: Devtools | undefined;
let forgeProcess: ReturnType<typeof spawn> | undefined;
let gitServer: ReturnType<typeof Bun.serve> | undefined;

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:design: bun run build failed: ${build.stderr}`);
  assertTrue(
    Bun.file(join(harnessRoot, "dist", "index.html")).size > 0,
    "verify:design: the build produced dist/index.html",
  );

  const repo = join(root, "repo");
  const projectRoot = join(root, "projects");
  const bare = join(projectRoot, "acme", "fixture.git");
  const stubDir = join(root, "stub");
  const binDir = join(root, "bin");
  const stateDir = join(repo, ".devboard", ".tmp", "state");
  await mkdir(join(repo, ".devboard"), { recursive: true });
  await mkdir(join(repo, "design"), { recursive: true });
  await mkdir(join(repo, "adrs"), { recursive: true });
  await mkdir(join(repo, ".worktree"), { recursive: true });
  await mkdir(join(repo, ".omp", "commands"), { recursive: true });
  await mkdir(stubDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(projectRoot, "acme"), { recursive: true });
  await cp(join(harnessRoot, "client"), join(repo, ".devboard", "client"), { recursive: true });
  await cp(
    join(harnessRoot, "index.html"),
    join(repo, ".devboard", "index.html"),
  );
  await writeFile(join(repo, "adrs", "keep.txt"), "adrs\n");
  await writeFile(join(repo, "GOAL.md"), "# Goal\n");
  await writeFile(join(repo, ".omp", "commands", "scout-recommendations.md"), "# scout\n");

  const initialDesign = [
    "# Fixture interface",
    "",
    "## Colors",
    "",
    "The interface uses the documented accent token `#58a6ff`.",
    "",
    "## Components",
    "",
    "- **Panel** — a 1px `border` on `surface`.",
    "",
  ].join("\n");
  const initialTokens = {
    color: { accent: { $type: "color", $value: { hex: "#58a6ff" } } },
    spacing: { panel: { $type: "dimension", $value: "8px" } },
  };
  const admitDesign = [
    initialDesign.replace(
      "- **Panel** — a 1px `border` on `surface`.",
      "- **Panel** — a 1px `border` on `surface` with 8px padding.",
    ),
    "## Design principles",
    "",
    "- One accent token governs emphasis; no surface hardcodes a color.",
    "",
    "## UX principles",
    "",
    "- Every state carries a word as well as a color.",
    "- Controls keep their action beside the field they change.",
    "",
    "## Spacing",
    "",
    "| Token | Value | Use |",
    "|---|---|---|",
    "| `compact` | 4px | Tight rows and badges. |",
    "",
  ].join("\n");
  const admitTokens = {
    ...initialTokens,
    spacing: { ...initialTokens.spacing, compact: { $type: "dimension", $value: "4px" } },
  };
  await writeFile(join(repo, "DESIGN.md"), initialDesign);
  await writeFile(join(repo, "design", "tokens.json"), `${JSON.stringify(initialTokens, null, 2)}\n`);
  await writeFile(join(stubDir, "admit-DESIGN.md"), admitDesign);
  await writeFile(join(stubDir, "admit-tokens.json"), `${JSON.stringify(admitTokens, null, 2)}\n`);
  await writeFile(join(stubDir, "mode"), "issue\n");
  await writeFile(join(stubDir, "push-mode"), "ok\n");
  await writeFile(join(stubDir, "publish-mode"), "ok\n");
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
  run("git", ["init", "--bare", "-q", bare]);
  run("git", ["--git-dir", bare, "config", "http.receivepack", "true"]);
  git(["remote", "add", "origin", "http://127.0.0.1:0/acme/fixture.git"]);

  const forgeState = join(root, "forge-state.json");
  await writeFile(forgeState, JSON.stringify({ next: 1, issues: [] }, null, 2));
  const apiPort = await freePort();
  await writeFile(join(root, "api-port"), String(apiPort));
  forgeProcess = spawn(process.execPath, [stubForge], {
    env: {
      ...process.env,
      PORT: String(apiPort),
      DESIGN_STUB_FORGE_STATE: forgeState,
      DESIGN_STUB_FORGE_LOG: join(root, "forge.log"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  forgeProcess.stderr?.on("data", (chunk) => {
    writeFileSync(join(root, "forge.stderr"), String(chunk));
  });
  forgeProcess.on("exit", (code, signal) => {
    writeFileSync(join(root, "forge.exit"), `${String(code)} ${String(signal)}\n`);
  });
  await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${apiPort}/admin/health`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    "the stub forge",
    20_000,
  );
  gitServer = startGitServer(projectRoot);
  git(["remote", "set-url", "origin", `http://127.0.0.1:${gitServer.port}/acme/fixture.git`]);
  // The in-process git server must answer while this push runs, so the push
  // is asynchronous; spawnSync would block the server's event loop.
  const initialPush = Bun.spawn({
    cmd: ["git", "-C", repo, "push", "-q", "origin", "HEAD:main"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const pushCode = await initialPush.exited;
  check(
    pushCode === 0,
    `the fixture origin refused its first push: ${await new Response(initialPush.stderr).text()}`,
  );

  const realGit = run("which", ["git"]).stdout.trim();
  check(realGit.length > 0, "the real git binary was not found");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, GIT_WRAPPER(realGit));
  chmodSync(gitPath, 0o755);

  const gitLog = join(root, "git.log");
  const publishLog = join(root, "publish.log");
  const acpLog = join(root, "acp.log");
  await writeFile(gitLog, "");
  await writeFile(publishLog, "");
  await writeFile(acpLog, "");

  seedVerificationProvider(stateDir);
  const port = await freePort();
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
      ...verificationProviderUsageEnv(),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      REPO_DIR: repo,
      ADRS_DIR: join(repo, "adrs"),
      GOAL_FILE: join(repo, "GOAL.md"),
      STATIC_DIR: join(harnessRoot, "dist"),
      STATE_DIR: stateDir,
      AGENT_COMMAND: `${process.execPath} ${stubAcp}`,
      DEVBOARD_GITEA_URL: `http://127.0.0.1:${apiPort}`,
      GITEA_TOKEN: "verification-token",
      DESIGN_STUB_DIR: stubDir,
      DESIGN_STUB_LOG: acpLog,
      DESIGN_STUB_DELAY_MS: "0",
      DESIGN_CADENCE_MS: "3000",
      DESIGN_PUBLISH_COMMAND: stubPublisher,
      DESIGN_PUBLISH_LOG: publishLog,
      DESIGN_GIT_LOG: gitLog,
      DESIGN_STUB_REPO: repo,
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

  await waitFor(
    async () => ((await present(devtools!, "mode-devboard")) ? true : undefined),
    "the Devboard mode control",
    30_000,
  );
  await click(devtools, "mode-devboard");
  await waitFor(
    async () => ((await present(devtools!, "open-devboard-design")) ? true : undefined),
    "the Design System sidebar entry",
    15_000,
  );
  const sidebar = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="sidebar-background-agents"] [data-testid^="open-devboard-"]')
  ].map((button) => button.getAttribute('data-testid') ?? ''))()`);
  check(
    JSON.stringify(sidebar) ===
      JSON.stringify([
        "open-devboard-scout",
        "open-devboard-watchdog",
        "open-devboard-design",
        "open-devboard-coach",
      ]),
    "the Background agents order is wrong",
    sidebar,
  );
  const entry = await devtools.evaluate(`(() => {
    const button = document.querySelector('[data-testid="open-devboard-design"]');
    return {
      label: button?.querySelector('.sidebar-item__label')?.textContent?.trim() ?? '',
      state: button?.querySelector('[data-testid="agent-state-design"]')?.dataset.state ?? '',
      count: button?.querySelector('[data-testid="agent-count-design"]')?.textContent?.trim() ?? '',
    };
  })()`);
  check(
    (entry as Record<string, string>).label === "Design System" &&
      (entry as Record<string, string>).state === "stopped" &&
      (entry as Record<string, string>).count === "0",
    "the Design System sidebar entry is wrong",
    entry,
  );
  console.log("PASS sidebar-entry");

  await click(devtools, "open-devboard-design");
  await waitFor(
    async () => ((await present(devtools!, "agent-page")) ? true : undefined),
    "the Design System page",
    10_000,
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-page"]')?.dataset.agent ?? ''`,
    )) === "design",
    "the page is not the Design System page",
  );
  const order = await coreOrder(devtools);
  check(
    JSON.stringify(order.filter((id) => id !== "agent-stop")) ===
      JSON.stringify(CORE_IDS.filter((id) => id !== "agent-stop")),
    "the Design System core id order differs",
    order,
  );
  check(await present(devtools, "design-activity"), "design-activity is missing");
  const emptyDocumentation = await documentationLayout(devtools);
  check(
    emptyDocumentation.present &&
      emptyDocumentation.adjacent &&
      emptyDocumentation.empty &&
      emptyDocumentation.entries === 0,
    "the empty documentation panel is missing or misplaced",
    emptyDocumentation,
  );
  check(
    await present(devtools, "agent-issues-empty"),
    "the filed issues empty state is missing below the documentation panel",
  );
  console.log("PASS page-shape");

  const lifecycle: string[] = [];
  const recordLifecycle = async (): Promise<void> => {
    const states = await devtools!.evaluate(`(() => {
      window.__designStates = window.__designStates ?? [];
      const element = document.querySelector('[data-testid="agent-lifecycle"]');
      const state = element?.dataset.state ?? '';
      if (state.length > 0 && window.__designStates[window.__designStates.length - 1] !== state) {
        window.__designStates.push(state);
      }
      clearInterval(window.__designTimer);
      window.__designTimer = setInterval(() => {
        const next = document.querySelector('[data-testid="agent-lifecycle"]')?.dataset.state ?? '';
        if (next.length > 0 && window.__designStates[window.__designStates.length - 1] !== next) {
          window.__designStates.push(next);
        }
      }, 5);
      return window.__designStates;
    })()`);
    if (Array.isArray(states)) lifecycle.splice(0, lifecycle.length, ...(states as string[]));
  };

  /* 1. Start -> starting -> running, one divergence filed, Stop. */
  await recordLifecycle();
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the running Design System",
    15_000,
  );
  await recordLifecycle();
  check(lifecycle.includes("starting"), "Start never published starting", lifecycle);
  await waitFor(
    async () => ((await rows(devtools!)).length >= 1 ? true : undefined),
    "the first filed design issue without a reload",
    30_000,
  );
  const firstRows = await rows(devtools);
  check(firstRows[0]?.state === "pending", "the new design issue is not pending", firstRows);
  check(firstRows[0]?.category === "color", "the new design issue lost its category", firstRows);
  check(
    (await text(devtools, "design-activity")).includes("filed #"),
    "the activity did not record the filing",
  );
  const firstIssueUrl = firstRows[0]?.url ?? "";
  check(/\/issues\/\d+$/.test(firstIssueUrl), "the filed issue has no URL", firstRows);
  const columns = await devtools.evaluate(`(() => [
    ...document.querySelectorAll('[data-testid="agent-issues"] th')
  ].map((cell) => (cell.textContent ?? '').trim()))()`);
  check(
    JSON.stringify(columns) === JSON.stringify(["Title", "Category", "Filed", "State", "Shipped"]),
    "the shared table columns differ",
    columns,
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped Design System",
    15_000,
  );
  await recordLifecycle();
  check(lifecycle.includes("stopping"), "Stop never published stopping", lifecycle);
  console.log("PASS lifecycle-and-first-issue");

  /* 2. A full pending cap files nothing; clearing it resumes filing. */
  await setInput(devtools, "agent-limit-pending", "1");
  await click(devtools, "agent-save-limits");
  const beforeCap = (await rows(devtools)).length;
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the capped Design System",
    15_000,
  );
  await waitFor(
    async () =>
      (await text(devtools!, "design-activity")).includes("cap leaves no room") ? true : undefined,
    "the capped cycle to record its skips",
    30_000,
  );
  check(
    (await rows(devtools)).length === beforeCap,
    "a full pending cap still filed an issue",
    await rows(devtools),
  );
  await setInput(devtools, "agent-limit-pending", "");
  await click(devtools, "agent-save-limits");
  await waitFor(
    async () => ((await rows(devtools!)).length > beforeCap ? true : undefined),
    "filing to resume after the cap is cleared",
    30_000,
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped capped Design System",
    15_000,
  );
  console.log("PASS filing-caps");

  /* 3. A single literal yields an issue and no document diff. */
  const headBeforeSingle = git(["rev-parse", "HEAD"]);
  const publishBeforeSingle = readFileSync(publishLog, "utf8").split("\n").filter(Boolean).length;
  await writeFile(join(stubDir, "mode"), "single\n");
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the single-literal Design System",
    15_000,
  );
  await waitFor(
    async () => ((await rows(devtools!)).length > beforeCap + 1 ? true : undefined),
    "the single-literal finding to file",
    30_000,
  );
  check(git(["rev-parse", "HEAD"]) === headBeforeSingle, "a single literal released a document change");
  check(
    readFileSync(publishLog, "utf8").split("\n").filter(Boolean).length === publishBeforeSingle,
    "a single literal invoked the publisher",
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped single-literal Design System",
    15_000,
  );
  console.log("PASS normative-documents");

  /* 4. An admissible standard releases only the two documents. */
  await writeFile(join(stubDir, "mode"), "admit\n");
  const headBeforeRelease = git(["rev-parse", "HEAD"]);
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the releasing Design System",
    15_000,
  );
  await waitFor(
    async () =>
      (await text(devtools!, "design-activity")).includes("released 0.1.") ? true : undefined,
    "the documented standard to release",
    90_000,
  );
  const activity = await text(devtools, "design-activity");
  const released = /released (0\.1\.\d+): (\S+)/.exec(activity);
  check(released !== null, "the activity does not name the release", activity);
  const version = released![1]!;
  const releaseUrl = released![2]!;
  check(
    git(["--git-dir", bare, "rev-parse", "main"]) !== headBeforeRelease,
    "the release did not push a commit",
  );
  const changed = git(["--git-dir", bare, "show", "--name-only", "--format=", "main"])
    .split("\n")
    .filter(Boolean)
    .sort();
  check(
    JSON.stringify(changed) === JSON.stringify(["DESIGN.md", "design/tokens.json"]),
    "the release touched more than the two documents",
    changed,
  );
  const prose = git(["--git-dir", bare, "show", "main:DESIGN.md"]);
  check(prose.includes("## Design principles"), "the released prose lacks Design principles");
  check(prose.includes("## UX principles"), "the released prose lacks UX principles");
  check(
    existsSync(join(repo, "DESIGN.md")),
    "the integration checkout lost DESIGN.md",
  );
  check(
    readdirSync(join(repo, ".worktree")).every((entry) => !entry.startsWith("design-")),
    "the cycle worktree was not removed",
    readdirSync(join(repo, ".worktree")),
  );
  check(git(["branch", "--list", "design/*"]) === "", "the cycle branch was not removed");
  const publishLines = readFileSync(publishLog, "utf8").split("\n").filter(Boolean);
  check(
    publishLines.some((line) => line.includes(version) && line.startsWith("ok ")),
    "the stub publisher was not invoked for the released version",
    publishLines,
  );
  check(version.startsWith("0.1."), "the recorded version is not a release version", version);
  check(releaseUrl.includes(`v${version}`), "the release URL does not name the version", releaseUrl);
  const releasedDocumentation = await documentationLayout(devtools);
  check(
    releasedDocumentation.present &&
      releasedDocumentation.adjacent &&
      !releasedDocumentation.empty &&
      releasedDocumentation.entries === 1,
    "the documentation panel did not gain exactly one entry above the issues",
    releasedDocumentation,
  );
  const releasedEntryView = await devtools.evaluate(`(() => {
    const summary = document.querySelector('[data-testid="agent-documentation-summary"]');
    const link = document.querySelector('[data-testid="agent-documentation-version"]');
    const files = document.querySelector('[data-testid="agent-documentation-files"]');
    const details = document.querySelector('[data-testid="agent-documentation-entry"] details');
    const diff = document.querySelector('[data-testid="agent-documentation-diff"]');
    return {
      summary: summary === null ? '' : (summary.textContent ?? '').trim(),
      version: link === null ? '' : (link.textContent ?? '').trim(),
      href: link instanceof HTMLAnchorElement ? link.href : '',
      files: files === null ? '' : (files.textContent ?? '').trim(),
      open: details instanceof HTMLDetailsElement ? details.open : true,
      diffHidden:
        diff === null ||
        (typeof diff.checkVisibility === "function"
          ? !diff.checkVisibility()
          : diff.getBoundingClientRect().height === 0),
    };
  })()`);
  const releasedEntry = releasedEntryView as Record<string, unknown>;
  check(
    typeof releasedEntry.summary === "string" &&
      releasedEntry.summary.includes("Document the fixture standard"),
    "the released entry does not show the cycle summary",
    releasedEntry,
  );
  check(releasedEntry.version === version, "the entry version link text is wrong", releasedEntry);
  check(
    typeof releasedEntry.href === "string" &&
      releasedEntry.href.includes(`/releases/tag/v${version}`),
    "the entry version link does not name the release",
    releasedEntry,
  );
  check(
    releasedEntry.files === "DESIGN.md, design/tokens.json",
    "the entry does not name both changed documents",
    releasedEntry,
  );
  check(
    releasedEntry.open === false && releasedEntry.diffHidden === true,
    "the entry diff is not hidden until the entry is opened",
    releasedEntry,
  );
  const expectedDiff = git([
    "--git-dir",
    bare,
    "diff",
    "--no-color",
    "main^",
    "main",
    "--",
    "DESIGN.md",
    "design/tokens.json",
  ]);
  check(
    expectedDiff.includes("-- **Panel** — a 1px `border` on `surface`."),
    "the released diff does not remove the edited line",
    expectedDiff,
  );
  check(
    expectedDiff.includes("+- **Panel** — a 1px `border` on `surface` with 8px padding."),
    "the released diff does not add the edited line",
    expectedDiff,
  );
  check(
    expectedDiff.includes("+## Design principles") && expectedDiff.includes("+## UX principles"),
    "the released diff does not add the documented standards",
    expectedDiff,
  );
  await click(devtools, "agent-documentation-summary");
  await waitFor(
    async () =>
      (await rawText(devtools!, "agent-documentation-diff")) === expectedDiff.trim()
        ? true
        : undefined,
    "the exact released diff in the opened entry",
    10_000,
  );
  await click(devtools, "agent-documentation-summary");
  await waitFor(
    async () => {
      const hidden = await devtools!.evaluate(
        `(() => {
          const diff = document.querySelector('[data-testid="agent-documentation-diff"]');
          if (diff === null) return true;
          return typeof diff.checkVisibility === "function"
            ? !diff.checkVisibility()
            : diff.getBoundingClientRect().height === 0;
        })()`,
      );
      return hidden === true ? true : undefined;
    },
    "the entry diff to hide again",
    10_000,
  );
  const worktreeLines = readFileSync(gitLog, "utf8")
    .split("\n")
    .filter((line) => line.includes("worktree add"));
  check(
    worktreeLines.some(
      (line) =>
        line.includes("-b design/") && line.includes(join(repo, ".worktree", "design-")),
    ),
    "the release did not use one worktree under .worktree/",
    worktreeLines,
  );
  check(
    (await devtools.evaluate(
      `document.querySelector('[data-testid="agent-lifecycle"]')?.dataset.state ?? ''`,
    )) !== "",
    "the page lost its lifecycle",
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped releasing Design System",
    15_000,
  );
  console.log("PASS documentation-release");

  /* 5. Single flight: no two cycles overlap. */
  const acpLines = readFileSync(acpLog, "utf8").split("\n").filter(Boolean);
  let open = 0;
  for (const line of acpLines) {
    if (line.startsWith("start ")) {
      open += 1;
      check(open <= 1, "two design cycles ran concurrently", acpLines);
    } else if (line.startsWith("end ")) {
      open -= 1;
    }
  }
  console.log("PASS single-flight");

  /* 6. A cycle with no admissible decision makes no commit, push, or publish. */
  await writeFile(join(stubDir, "mode"), "none\n");
  const headBeforeNoop = git(["rev-parse", "HEAD"]);
  const publishBeforeNoop = readFileSync(publishLog, "utf8").split("\n").filter(Boolean).length;
  const cyclesDir = join(repo, ".devboard", ".tmp", "design", "cycles");
  const cyclesBefore = new Set(readdirSync(cyclesDir));
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the no-op Design System",
    15_000,
  );
  await waitFor(
    () => {
      const fresh = readdirSync(cyclesDir).filter((entry) => !cyclesBefore.has(entry));
      return fresh.some((entry) => {
        try {
          return readFileSync(join(cyclesDir, entry, "activity.json"), "utf8").includes("read ");
        } catch {
          return false;
        }
      })
        ? true
        : undefined;
    },
    "the no-op cycle to run",
    30_000,
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped no-op Design System",
    15_000,
  );
  check(git(["rev-parse", "HEAD"]) === headBeforeNoop, "a no-op cycle committed a change");
  check(
    readFileSync(publishLog, "utf8").split("\n").filter(Boolean).length === publishBeforeNoop,
    "a no-op cycle invoked the publisher",
  );
  check(
    (await documentationLayout(devtools)).entries === 1,
    "a no-op cycle added a documentation history entry",
  );
  console.log("PASS no-op");

  /* 7. A rejected push is integrated and retried without force. */
  await writeFile(join(stubDir, "mode"), "admit\n");
  await writeFile(join(stubDir, "push-mode"), "reject\n");
  rmSync(join(stubDir, "push-marker"), { force: true });
  const pushesBefore = readFileSync(gitLog, "utf8").split("\n").filter((line) => line.includes(" push ")).length;
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the rejecting Design System",
    15_000,
  );
  await waitFor(
    async () =>
      (await text(devtools!, "design-activity")).includes("push rejected") ? true : undefined,
    "the rejected push to be recorded",
    60_000,
  );
  await waitFor(
    async () =>
      (await text(devtools!, "design-activity")).includes("released 0.1.") ? true : undefined,
    "the retried push to release",
    90_000,
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped rejecting Design System",
    15_000,
  );
  const pushes = readFileSync(gitLog, "utf8").split("\n").filter((line) => line.includes(" push "));
  check(pushes.length > pushesBefore, "the rejected push never reached git", pushes);
  check(!pushes.some((line) => line.includes("--force")), "a push used --force", pushes);
  await writeFile(join(stubDir, "push-mode"), "ok\n");
  console.log("PASS rejected-push");

  /* 8. A failed publish leaves the pushed commit and surfaces agent-error. */
  await writeFile(join(stubDir, "mode"), "admit\n");
  await writeFile(join(stubDir, "publish-mode"), "fail\n");
  const entriesBeforePublishFailure = (await documentationLayout(devtools)).entries;
  const headBeforePublishFailure = git(["rev-parse", "HEAD"]);
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the failing-publish Design System",
    15_000,
  );
  await waitFor(
    async () => {
      const value = await text(devtools!, "agent-error");
      return value.includes("publish") ? value : undefined;
    },
    "the publish failure in agent-error",
    90_000,
  );
  check(
    git(["rev-parse", "HEAD"]) !== headBeforePublishFailure,
    "the failed publish did not leave the pushed commit",
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped failing-publish Design System",
    15_000,
  );
  await writeFile(join(stubDir, "publish-mode"), "ok\n");
  check(
    (await documentationLayout(devtools)).entries === entriesBeforePublishFailure,
    "a failed release added a documentation history entry",
  );
  console.log("PASS publish-failure");

  /* 9. A dirty integration checkout names its blocking paths. */
  await writeFile(join(stubDir, "mode"), "admit\n");
  await writeFile(join(repo, "DESIGN.md"), "local uncommitted edit\n");
  const publishBeforeDirty = readFileSync(publishLog, "utf8").split("\n").filter(Boolean).length;
  await click(devtools, "agent-start");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "running" ? true : undefined),
    "the dirty-checkout Design System",
    15_000,
  );
  await waitFor(
    async () => {
      const value = await text(devtools!, "agent-error");
      return value.includes("DESIGN.md") && value.includes("block") ? value : undefined;
    },
    "the dirty checkout to be reported",
    90_000,
  );
  check(
    readFileSync(join(repo, "DESIGN.md"), "utf8") === "local uncommitted edit\n",
    "the dirty integration checkout discarded its edit",
  );
  check(
    readFileSync(publishLog, "utf8").split("\n").filter(Boolean).length === publishBeforeDirty,
    "a dirty checkout still published",
  );
  await click(devtools, "agent-stop");
  await waitFor(
    async () => ((await stateOf(devtools!, "agent-lifecycle")) === "stopped" ? true : undefined),
    "the stopped dirty-checkout Design System",
    15_000,
  );
  git(["checkout", "--", "DESIGN.md"]);
  console.log("PASS dirty-integration");

  /* 10. Preflight refusals name the missing fact and spawn no worker. */
  const refuse = async (path: string, expected: string): Promise<void> => {
    const moved = `${path}.hidden`;
    run("mv", [path, moved]);
    try {
      await click(devtools!, "agent-start");
      await waitFor(
        async () => {
          const value = await text(devtools!, "agent-error");
          return value.includes(expected) ? value : undefined;
        },
        `the refusal naming ${expected}`,
        20_000,
      );
      check(
        (await stateOf(devtools, "agent-lifecycle")) !== "running",
        "a refused Start spawned a worker",
      );
    } finally {
      run("mv", [moved, path]);
    }
  };
  await refuse(join(repo, ".devboard", "client"), ".devboard/client");
  await refuse(join(repo, "DESIGN.md"), "DESIGN.md");
  console.log("PASS preflight-refusals");

  check(
    devtools.errors.length === 0,
    `the page reported console errors: ${JSON.stringify(devtools.errors)}`,
  );

  console.log(
    "verify:design: the sidebar entry, shared page ids, design-activity, the filed-issue table, " +
      "lifecycle, caps, the normative documents, the autonomous release, single flight, no-op, " +
      "rejected push, failed publish, dirty integration, preflight refusals, and freshness hold",
  );
} finally {
  if (forgeProcess !== undefined && forgeProcess.pid !== undefined) {
    try {
      process.kill(forgeProcess.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  // The design worker is detached, so it is not a child of this script.
  const fixtureState = join(root, "repo", ".devboard", ".tmp", "state", "design");
  try {
    for (const entry of readdirSync(fixtureState)) {
      try {
        const state = JSON.parse(
          readFileSync(join(fixtureState, entry, "state.json"), "utf8"),
        ) as { worker?: { pid?: number } };
        const pid = state.worker?.pid;
        if (typeof pid === "number" && pid > 0) process.kill(pid, "SIGKILL");
      } catch {
        // No state for this repository.
      }
    }
  } catch {
    // No design state was written.
  }
  for (const pid of [chromePid, dashboardPid]) {
    if (pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  devtools?.close();
  gitServer?.stop(true);
  if (process.env.DESIGN_VERIFY_KEEP !== "1") {
    await rm(root, { recursive: true, force: true });
  } else {
    console.error(`verify:design: kept ${root}`);
  }
}

// Open handles (detached workers, child pipes) must not keep the gate alive.
process.exit(0);
