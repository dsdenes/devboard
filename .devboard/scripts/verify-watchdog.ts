#!/usr/bin/env bun
/**
 * Browser contract for the watchdog indicator. Builds the client, seeds a
 * watchdog state directory with a cycle report and more filed issues than the
 * popover shows, starts a source dashboard, drives headless Chrome over the
 * DevTools protocol, and asserts the footer indicator, its popover, the issue
 * links, Escape, and the absence of an uncaught console error.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { saveLedger } from "../watchdog/ledger";
import { assertTrue, freePort, harnessRoot, makeHost, makeRoot, run, waitFor } from "./verification";

const MAX_ISSUES = 10;
const ISSUE_COUNT = 12;
const CYCLE_AGE_MS = 3 * 60 * 1000;

const chromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
];

function chromePath(): string {
  for (const candidate of chromeCandidates) {
    if (Bun.file(candidate).size > 0) return candidate;
  }
  throw new Error("verify:watchdog: /usr/bin/google-chrome is unavailable");
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

  /** Every uncaught exception and console error the page reported. */
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

interface RenderedLink {
  href?: string;
  target?: string;
  rel?: string;
}

/** Narrow the browser's link snapshot without trusting its shape. */
function renderedLinks(value: unknown): RenderedLink[] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("links" in value) || !Array.isArray(value.links)) return undefined;
  const links: RenderedLink[] = [];
  for (const link of value.links) {
    if (typeof link !== "object" || link === null) continue;
    links.push({
      ...("href" in link && typeof link.href === "string" ? { href: link.href } : {}),
      ...("target" in link && typeof link.target === "string" ? { target: link.target } : {}),
      ...("rel" in link && typeof link.rel === "string" ? { rel: link.rel } : {}),
    });
  }
  return links;
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

const root = await makeRoot("verify-watchdog");
let dashboardPid = 0;
let chromePid = 0;

/** The newest issue is first; the popover renders only the first ten. */
function issueUrl(index: number): string {
  return `https://github.com/dsdenes/devboard/issues/${900 - index}`;
}

try {
  const build = run(process.execPath, ["run", "build"], { cwd: harnessRoot });
  assertTrue(build.code === 0, `verify:watchdog: bun run build failed: ${build.stderr}`);
  assertTrue(
    Bun.file(join(harnessRoot, "dist", "index.html")).size > 0,
    "verify:watchdog: the build produced dist/index.html",
  );

  const host = await makeHost(root, "host");
  const stateDir = join(root, "state");
  const watchdogDir = join(stateDir, "watchdog");
  await mkdir(watchdogDir, { recursive: true });

  const cycle = new Date(Date.now() - CYCLE_AGE_MS).toISOString();
  await writeFile(
    join(watchdogDir, "latest.json"),
    JSON.stringify(
      {
        cycle,
        window: { start: cycle, end: cycle, minutes: 10 },
        action: "filed",
        findings: [{}, {}],
        issues: [],
        pending: 0,
        reason: "filed 2 issue(s)",
      },
      null,
      2,
    ),
  );
  saveLedger(watchdogDir, {
    version: 2,
    findings: Object.fromEntries(
      Array.from({ length: ISSUE_COUNT }, (_unused, index) => [
        `fingerprint-${index}`,
        {
          category: index % 2 === 0 ? "server-error" : "update-error",
          line: `fixture finding ${index}`,
          firstSeen: cycle,
          lastSeen: cycle,
          count: 1,
          disposition: `filed:${issueUrl(index)}`,
          url: issueUrl(index),
          filedAt: new Date(Date.now() - index * 60_000).toISOString(),
          instances: [],
        },
      ]),
    ),
    pendingFiling: [],
  });

  const port = await freePort();
  const dashboard = spawn(process.execPath, [join(harnessRoot, "server", "index.ts")], {
    env: {
      ...process.env,
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

  const devtools = new Devtools(await pageTarget(debugPort, port));
  await devtools.connect();
  try {
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const indicator = await waitFor(
      async () => {
        const value = await devtools
          .evaluate(`(() => {
            const element = document.querySelector('[data-testid="status-watchdog"]');
            return element === null ? null : (element.textContent ?? "");
          })()`)
          .catch(() => undefined);
        return typeof value === "string" && value.includes("filed") ? value : undefined;
      },
      "the watchdog indicator",
      30_000,
    ).catch(async (error: unknown) => {
      const page = await devtools
        .evaluate(`document.body === null ? "" : document.body.innerText.slice(0, 1500)`)
        .catch(() => "");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}` +
          `\nconsole: ${devtools.errors.join(" | ") || "none"}` +
          `\npage: ${String(page)}`,
      );
    });
    const text = indicator.replace(/\s+/g, " ").trim();
    assertTrue(text.includes("filed"), `the indicator names the last action: ${text}`);
    assertTrue(/(just now|\d+m ago|\d+h ago)/.test(text), `the indicator shows the age: ${text}`);
    console.log("PASS status-watchdog");

    await devtools.evaluate(
      `document.querySelector('[data-testid="status-watchdog"]').click(); true`,
    );
    const links = await waitFor(
      async () => {
        const value = await devtools
          .evaluate(`(() => {
            const element = document.querySelector('[data-testid="watchdog-popover"]');
            if (element === null) return null;
            return {
              links: [...element.querySelectorAll("a")].map((anchor) => ({
                href: anchor.getAttribute("href"),
                target: anchor.getAttribute("target"),
                rel: anchor.getAttribute("rel"),
              })),
            };
          })()`)
          .catch(() => undefined);
        return renderedLinks(value);
      },
      "the watchdog popover",
      10_000,
    );
    console.log("PASS watchdog-popover");

    assertTrue(
      links.length === MAX_ISSUES,
      `the popover lists at most ten issues: found ${links.length}`,
    );
    for (const link of links) {
      assertTrue(link.target === "_blank", `an issue link opens a new tab: ${JSON.stringify(link)}`);
      assertTrue(
        link.rel?.includes("noopener") === true && link.rel?.includes("noreferrer") === true,
        `an issue link is rel="noopener noreferrer": ${JSON.stringify(link)}`,
      );
      assertTrue(
        link.href?.startsWith("https://github.com/dsdenes/devboard/issues/") === true,
        `an issue link is a filed URL: ${String(link.href)}`,
      );
    }
    assertTrue(links[0]?.href === issueUrl(0), `the newest issue comes first: ${String(links[0]?.href)}`);
    console.log("PASS issue-links");

    await devtools.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await devtools.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await waitFor(
      async () => {
        const value = await devtools
          .evaluate(
            `document.querySelector('[data-testid="watchdog-popover"]') === null ? true : undefined`,
          )
          .catch(() => undefined);
        return value === true ? true : undefined;
      },
      "the popover to close on Escape",
      10_000,
    );
    console.log("PASS escape-closes");

    assertTrue(
      devtools.errors.length === 0,
      `the page logged no uncaught console error: ${devtools.errors.join("\n")}`,
    );
    console.log("PASS no-console-error");
  } finally {
    devtools.close();
  }

  console.log("verify:watchdog: indicator, popover, issue links, and Escape passed");
} finally {
  if (chromePid > 0) {
    try {
      process.kill(chromePid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  if (dashboardPid > 0) {
    try {
      process.kill(dashboardPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  await rm(root, { recursive: true, force: true });
}
