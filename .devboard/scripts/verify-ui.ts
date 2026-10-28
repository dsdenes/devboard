#!/usr/bin/env bun
/**
 * Browser verification for the reload control. Installs an old fixture, lets
 * the running server install a newer release, drives headless Chrome over the
 * DevTools protocol, waits for `[data-testid="reload-devboard"]`, clicks it,
 * and proves the page reloaded on the restarted server with `stale: false`.
 */

import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReleaseDirectory } from "./harness-package";
import {
  assertEquals,
  assertTrue,
  freePort,
  installState,
  installedVersion,
  launcher,
  makeHost,
  makeRoot,
  readVersion,
  releaseDirectory,
  startInstalledDashboard,
  stopDashboard,
  waitFor,
  waitForInstalledVersion,
} from "./verification";

const OLD = "0.1.920";
const NEW = "0.1.921";
const root = await makeRoot("verify-ui");
let dashboardPid = 0;
let chromePid = 0;
let hostPath = "";

function chromePath(): string {
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ]) {
    if (Bun.file(candidate).size > 0) return candidate;
  }
  throw new Error("verify:ui: /usr/bin/google-chrome is unavailable");
}

interface CdpReply {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class Devtools {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (reply: CdpReply) => void>();

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
      if (typeof reply.id !== "number") return;
      this.pending.get(reply.id)?.(reply);
      this.pending.delete(reply.id);
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

try {
  const oldRelease = releaseDirectory(root, OLD);
  const newRelease = releaseDirectory(root, NEW);
  await createReleaseDirectory(OLD, oldRelease);
  await createReleaseDirectory(NEW, newRelease);
  const failingNpm = join(root, "failing-npm");
  await writeFile(failingNpm, "#!/bin/sh\ncase \"$1\" in view) echo 'simulated npm outage' >&2; exit 1;; esac\nexec npm \"$@\"\n");
  await chmod(failingNpm, 0o755);

  const host = await makeHost(root, "ui");
  hostPath = host.directory;
  const installed = launcher(["install", "--host", host.directory], {
    DEVBOARD_RELEASE_DIR: oldRelease,
    DEVBOARD_NPM: failingNpm,
  });
  assertTrue(installed.code === 0, `fixture install failed: ${installed.stderr}`);
  const prefix = join(host.directory, ".devboard");
  const port = Number(installState(prefix).port);
  await stopDashboard(host.directory);
  const server = await startInstalledDashboard(host.directory, {
    DEVBOARD_RELEASE_DIR: newRelease,
    DEVBOARD_UPDATE_INTERVAL_MS: "200",
  }, port);
  dashboardPid = server.pid;
  await waitForInstalledVersion(prefix, NEW);
  const before = await readVersion(port);
  assertEquals(
    [before.running, before.installed, before.stale],
    [OLD, NEW, true],
    "the dashboard starts stale after an automatic install",
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
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chromePid = chrome.pid ?? 0;

  const socketUrl = await pageTarget(debugPort, port);
  const devtools = new Devtools(socketUrl);
  await devtools.connect();
  try {
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");

    const control = await waitFor(
      async () => {
        const value = await devtools
          .evaluate(`(() => {
            const button = document.querySelector('[data-testid="reload-devboard"]');
            return button ? { title: button.title } : null;
          })()`)
          .catch(() => null);
        return value !== null && typeof value === "object" && "title" in value ? value : undefined;
      },
      "the reload control",
      30_000,
    );
    const title = String(control.title);
    assertTrue(title.includes(OLD), `reload title names the running version: ${title}`);
    assertTrue(title.includes(NEW), `reload title names the installed version: ${title}`);

    await devtools.evaluate(`window.__devboardVerifyToken = "before"; true`);
    await devtools.evaluate(
      `document.querySelector('[data-testid="reload-devboard"]').click(); true`,
    );

    await waitFor(
      async () => {
        const value = await devtools
          .evaluate(`(() => ({
            token: window.__devboardVerifyToken,
            button: document.querySelector('[data-testid="reload-devboard"]') !== null,
            ready: document.readyState,
          }))()`)
          .catch(() => undefined);
        if (value === null || typeof value !== "object") return undefined;
        if (!("button" in value)) return undefined;
        // A reloaded document loses the old token; the new state has no reload
        // control because the replacement runs the installed version.
        return (
          ("token" in value ? value.token : undefined) === undefined &&
          value.button === false &&
          "ready" in value &&
          value.ready === "complete"
        )
          ? true
          : undefined;
      },
      "the reloaded page without a reload control",
      30_000,
    );

    const after = await readVersion(port);
    assertEquals(
      [after.running, after.installed, after.latest, after.stale],
      [NEW, NEW, NEW, false],
      "the restarted server reports the installed release",
    );
    assertTrue(
      Bun.spawnSync({ cmd: ["kill", "-0", String(server.pid)] }).exitCode !== 0,
      "the original server exited for its replacement",
    );
  } finally {
    devtools.close();
  }

  console.log("verify:ui: reload control, restart, and page reload passed");
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
  if (hostPath.length > 0) await stopDashboard(hostPath).catch(() => undefined);
}
