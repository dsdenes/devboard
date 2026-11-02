#!/usr/bin/env bun
/**
 * Browser verification for the reload control. Installs an old fixture, lets
 * the running server install a newer release, drives headless Chrome over the
 * DevTools protocol, waits for `[data-testid="reload-devboard"]`, clicks it,
 * and proves the page reloaded on the restarted server with `stale: false`.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  lockPath,
  versionedControlDirectory,
  versionedStatePath,
} from "../issues/scout/paths";
import { acquireLock, versionLockPath } from "../issues/lock";
import { emptyState, writeState } from "../issues/scout/state";
import { createReleaseDirectory } from "./harness-package";
import {
  assertEquals,
  assertTrue,
  freePort,
  harnessRoot,
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
  const env = { DEVBOARD_NPM: failingNpm };

  // The normal path: a dashboard connected while the newer package arrives
  // reloads once on its own, with no reload control anywhere.
  const host = await makeHost(root, "ui");
  hostPath = host.directory;
  const installed = launcher(["install", "--host", host.directory], {
    ...env,
    DEVBOARD_RELEASE_DIR: oldRelease,
  });
  assertTrue(installed.code === 0, `fixture install failed: ${installed.stderr}`);
  const prefix = join(host.directory, ".devboard");
  const port = Number(installState(prefix).port);
  await stopDashboard(host.directory);
  const server = await startInstalledDashboard(host.directory, {
    ...env,
    DEVBOARD_RELEASE_DIR: oldRelease,
    DEVBOARD_UPDATE_INTERVAL_MS: "300",
  }, port);
  dashboardPid = server.pid;

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

  const socketUrl = await pageTarget(debugPort, port);
  const devtools = new Devtools(socketUrl);
  await devtools.connect();
  try {
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");
    await waitFor(
      async () => {
        const ready = await devtools
          .evaluate(`document.querySelector('[data-testid="app-shell"]') !== null`)
          .catch(() => false);
        return ready === true ? true : undefined;
      },
      "the dashboard shell",
      30_000,
    );
    const forbidden = await devtools.evaluate(`(() => {
      const text = document.body.innerText;
      return {
        mismatch: text.includes("is running;" + " this dashboard loaded"),
        left: text.includes("It is left running;" + " Stop it to launch"),
        reload: document.querySelector('[data-testid="reload-devboard"]') !== null,
      };
    })()`);
    assertTrue(
      typeof forbidden === "object" && forbidden !== null && !("mismatch" in forbidden && forbidden.mismatch) && !("left" in forbidden && forbidden.left),
      `the normal page shows no version divergence notice: ${JSON.stringify(forbidden)}`,
    );
    assertTrue(
      typeof forbidden === "object" && forbidden !== null && "reload" in forbidden && forbidden.reload === false,
      "the normal page renders no reload control",
    );

    await devtools.evaluate(`window.__devboardVerifyToken = "before"; true`);
    const updated = launcher(["update", "--host", host.directory], {
      ...env,
      DEVBOARD_RELEASE_DIR: newRelease,
    });
    assertTrue(updated.code === 0, `fixture update failed: ${updated.stderr}`);
    await waitFor(
      async () => {
        const value = await devtools
          .evaluate(`(() => ({
            token: window.__devboardVerifyToken,
            reload: document.querySelector('[data-testid="reload-devboard"]') !== null,
            ready: document.readyState,
          }))()`)
          .catch(() => undefined);
        if (value === null || typeof value !== "object") return undefined;
        // The automatic replacement reloads the page once; the new document
        // lost the token and carries no fallback control.
        return ("token" in value ? value.token : undefined) === undefined &&
          "reload" in value &&
          value.reload === false &&
          "ready" in value &&
          value.ready === "complete"
          ? true
          : undefined;
      },
      "the automatically reloaded page",
      60_000,
    );
    const after = await readVersion(port);
    assertEquals(
      [after.running, after.installed, after.stale],
      [NEW, NEW, false],
      "the automatic replacement reports the installed release",
    );
    assertTrue(after.replacement === undefined, "the normal path carries no replacement failure");
    assertTrue(
      Bun.spawnSync({ cmd: ["kill", "-0", String(server.pid)] }).exitCode !== 0,
      "the original server exited for its replacement",
    );

    // The shared page lists every live version and its controls address both,
    // with no version-divergence notice.
    // The fifth background agent is visible in the replaced bundle: its
    // sidebar entry and page render, and one screenshot records both.
    await devtools.evaluate(`document.querySelector('[data-testid="mode-devboard"]')?.click(); true`);
    await waitFor(
      async () =>
        (await devtools
          .evaluate(`document.querySelector('[data-testid="open-devboard-dead-code"]') !== null`)
          .catch(() => false)) === true
          ? true
          : undefined,
      "the Dead Code sidebar entry",
      30_000,
    );
    await devtools.evaluate(
      `document.querySelector('[data-testid="open-devboard-dead-code"]')?.click(); true`,
    );
    await waitFor(
      async () =>
        (await devtools
          .evaluate(
            `document.querySelector('[data-testid="agent-page"]')?.dataset.agent === "dead-code"`,
          )
          .catch(() => false)) === true
          ? true
          : undefined,
      "the Dead Code page",
      30_000,
    );
    const screenshot = await devtools.send("Page.captureScreenshot", { format: "png" });
    const data = (screenshot.result as { data?: unknown }).data;
    assertTrue(typeof data === "string" && data.length > 0, "the Dead Code screenshot is empty");
    const screenshotDir = join(harnessRoot, ".tmp", "interface");
    await mkdir(screenshotDir, { recursive: true });
    const screenshotPath = join(screenshotDir, "dead-code.png");
    await writeFile(screenshotPath, Buffer.from(data as string, "base64"));
    assertTrue(existsSync(screenshotPath), `the Dead Code screenshot was not written: ${screenshotPath}`);
    console.log(`verify:ui: dead-code sidebar entry and page written to ${screenshotPath}`);

    const installedState = join(prefix, ".tmp");
    const liveVersions = [OLD, NEW];
    const held = liveVersions.map((version) => {
      const lock = acquireLock(versionLockPath(lockPath(host.directory), version), {
        repo: host.directory,
        stateDir: installedState,
        harnessVersion: version,
        argv: [],
      });
      assertTrue(lock.acquired, `verify:ui: could not seed the ${version} worker lock`);
      const state = emptyState({ repo: "acme/fixture", root: host.directory });
      state.lifecycle = "idle";
      state.enabled = true;
      state.worker = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        stateDir: installedState,
        harnessVersion: version,
        argv: [],
      };
      writeState(versionedStatePath(installedState, host.directory, version), state);
      return lock;
    });
    try {
      // The shared contract first: both versions are live and the page data
      // carries no divergence notice.
      const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("verify:ui: timed out reading agentsState"));
        }, 15_000);
        socket.onopen = () => socket.send(JSON.stringify({ type: "getAgents" }));
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type !== "agentsState") return;
          clearTimeout(timer);
          socket.close();
          resolve(message);
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("verify:ui: websocket failed"));
        };
      });
      const scoutAgent = (snapshot.agents as Array<Record<string, unknown>>).find(
        (agent) => agent.id === "scout",
      );
      const shown = ((scoutAgent?.workers ?? []) as Array<{ version: string | null }>)
        .map((worker) => worker.version ?? "unknown")
        .sort();
      for (const version of liveVersions) {
        assertTrue(
          shown.includes(version),
          `verify:ui: the shared contract lost the ${version} worker: ${JSON.stringify(shown)}`,
        );
      }
      assertTrue(
        !JSON.stringify(snapshot).includes("this dashboard loaded") &&
          !JSON.stringify(snapshot).includes("It is left running"),
        "verify:ui: the shared contract shows a version divergence notice",
      );
      const notice = await devtools.evaluate(
        `document.body.innerText.includes('this dashboard ' + 'loaded') ||
          document.body.innerText.includes('It is left ' + 'running')`,
      );
      assertTrue(notice === false, "verify:ui: the page shows a version divergence notice");
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("verify:ui: timed out sending stopAgent"));
        }, 15_000);
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: "stopAgent", id: "scout" }));
          clearTimeout(timer);
          socket.close();
          resolve();
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("verify:ui: websocket failed"));
        };
      });
      await waitFor(
        () =>
          liveVersions.every((version) => {
            try {
              return readdirSync(versionedControlDirectory(installedState, host.directory, version)).some(
                (name) => name.endsWith(".json"),
              );
            } catch {
              return false;
            }
          })
            ? true
            : undefined,
        "Stop to reach every live worker's control directory",
        15_000,
      );
      console.log(
        `verify:ui: merged: the page lists ${shown.join(" and ")} and Stop addressed both, with no divergence notice`,
      );
    } finally {
      for (const lock of held) {
        if (lock.acquired) lock.release();
      }
    }

    // The fallback path: a replacement that cannot start keeps the old
    // version serving, names both versions, and the click retries it.
    const fallbackHost = await makeHost(root, "ui-fallback");
    const fallbackInstalled = launcher(["install", "--host", fallbackHost.directory], {
      ...env,
      DEVBOARD_RELEASE_DIR: oldRelease,
    });
    assertTrue(fallbackInstalled.code === 0, `fallback install failed: ${fallbackInstalled.stderr}`);
    const fallbackPrefix = join(fallbackHost.directory, ".devboard");
    const fallbackPort = Number(installState(fallbackPrefix).port);
    await stopDashboard(fallbackHost.directory);
    const stub = join(root, "replacement-stub");
    await writeFile(stub, "fail\n");
    const fallback = await startInstalledDashboard(fallbackHost.directory, {
      ...env,
      DEVBOARD_RELEASE_DIR: newRelease,
      DEVBOARD_UPDATE_INTERVAL_MS: "200",
      DEVBOARD_REPLACEMENT_STUB: stub,
    }, fallbackPort);
    await waitForInstalledVersion(fallbackPrefix, NEW);
    const fallbackDebugPort = await freePort();
    const fallbackProfile = join(root, "chrome-fallback");
    await mkdir(fallbackProfile, { recursive: true });
    const fallbackChrome = spawn(
      chromePath(),
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,900",
        `--remote-debugging-port=${fallbackDebugPort}`,
        `--user-data-dir=${fallbackProfile}`,
        `http://127.0.0.1:${fallbackPort}/`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const fallbackChromePid = fallbackChrome.pid ?? 0;
    try {
      const fallbackUrl = await pageTarget(fallbackDebugPort, fallbackPort);
      const fallbackDevtools = new Devtools(fallbackUrl);
      await fallbackDevtools.connect();
      try {
        await fallbackDevtools.send("Runtime.enable");
        await fallbackDevtools.send("Page.enable");
        const control = await waitFor(
          async () => {
            const value = await fallbackDevtools
              .evaluate(`(() => {
                const button = document.querySelector('[data-testid="reload-devboard"]');
                return button
                  ? { title: button.title, label: button.getAttribute("aria-label") }
                  : null;
              })()`)
              .catch(() => null);
            return value !== null && typeof value === "object" && "title" in value
              ? value
              : undefined;
          },
          "the fallback reload control",
          30_000,
        );
        const title = String(control.title);
        const label = String(control.label);
        assertTrue(title.includes(OLD) && title.includes(NEW), `fallback title names both versions: ${title}`);
        assertTrue(label.includes(OLD) && label.includes(NEW), `fallback label names both versions: ${label}`);
        const failed = await readVersion(fallbackPort);
        assertEquals(
          [failed.running, failed.installed, failed.replacement?.running, failed.replacement?.installed],
          [OLD, NEW, OLD, NEW],
          "the failed replacement keeps the old server and names both versions",
        );
        await writeFile(stub, "ok\n");
        await fallbackDevtools.evaluate(
          `document.querySelector('[data-testid="reload-devboard"]').click(); true`,
        );
        await waitFor(
          async () => {
            const value = await fallbackDevtools
              .evaluate(`(() => ({
                reload: document.querySelector('[data-testid="reload-devboard"]') !== null,
                ready: document.readyState,
              }))()`)
              .catch(() => undefined);
            return value !== null &&
              typeof value === "object" &&
              "reload" in value &&
              value.reload === false &&
              "ready" in value &&
              value.ready === "complete"
              ? true
              : undefined;
          },
          "the retried replacement page",
          60_000,
        );
        const retried = await readVersion(fallbackPort);
        assertEquals(
          [retried.running, retried.installed, retried.stale],
          [NEW, NEW, false],
          "the retried replacement runs the installed release",
        );
      } finally {
        fallbackDevtools.close();
      }
    } finally {
      try {
        process.kill(fallbackChromePid, "SIGKILL");
      } catch {
        // Already gone.
      }
      await stopDashboard(fallbackHost.directory).catch(() => undefined);
      try {
        process.kill(fallback.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  } finally {
    devtools.close();
  }

  console.log("verify:ui: automatic replacement, fallback control, and no divergence notice passed");
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
