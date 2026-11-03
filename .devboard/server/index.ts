import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import { configuredGiteaToken } from "../lib/forge";
import {
  sourceRefreshDirectory,
  writeAppliedSourceRefresh,
  type SourceRefreshRequest,
} from "../lib/source-refresh";
import { createApp, type FeedbackOptions } from "./app";
import type { ForgeTarget } from "./forge-pr";
import { StubForge } from "./fixtures/stub-forge";
import { openJournal } from "./journal";
import { sourceCheckoutGiteaUrl } from "./local-gitea";
import { relaunch, relaunchConfirmed, replacementController } from "./relaunch";
import { startSourceRefresher } from "./source-refresh";
import { snapshotStaticDir } from "./static-snapshot";
import { startUpdater, type Updater } from "./updates";
import { runOrphanReaper } from "../watchdog/reaper";
import {
  hostHarnessDir,
  isHarnessSourceCheckout,
  readHarnessVersion,
  runningHarnessDir,
  serverVersion,
} from "./version";

const hostname = process.env.HOST ?? "127.0.0.1";
const allowedHosts = (process.env.DEVBOARD_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const port = Number(process.env.PORT ?? 8080);
const adrDir = resolve(process.env.ADRS_DIR ?? "/repo/adrs");
const repoDir = resolve(process.env.REPO_DIR ?? dirname(adrDir));
const goalFile = process.env.GOAL_FILE
  ? resolve(process.env.GOAL_FILE)
  : join(repoDir, "GOAL.md");
const staticDir = process.env.STATIC_DIR ?? join(import.meta.dir, "..", "dist");
const agentCommand = process.env.AGENT_COMMAND ?? "omp acp";
const stateDir = resolve(process.env.STATE_DIR ?? join(import.meta.dir, "..", ".tmp"));

/**
 * The credential the launcher's readiness probe, the mutating endpoints, and
 * the socket upgrade require. The launcher supplies it to the dashboard it
 * spawns; otherwise this process generates one and keeps it in its own
 * environment, so a replacement inherits the same credential and an open
 * page's cookie keeps working across it.
 */
const dashboardToken =
  process.env.DEVBOARD_DASHBOARD_TOKEN?.trim() || randomBytes(32).toString("base64url");
if (!/^[A-Za-z0-9._~+/=:-]+$/.test(dashboardToken)) {
  throw new Error(
    "DEVBOARD_DASHBOARD_TOKEN must carry RFC 6750 characters only: no whitespace, ';', or ','.",
  );
}
process.env.DEVBOARD_DASHBOARD_TOKEN = dashboardToken;

/**
 * The credential a browser presents when it opens the page. It is distinct
 * from the dashboard token, so the token the mutating endpoints and the socket
 * upgrade trust never rides in a URL, and this process keeps it in its own
 * environment so a replacement accepts the address the launcher printed.
 * Without it, the document would answer only a caller that already holds the
 * token's cookie, and a fresh browser could never get one.
 */
const bootstrapToken =
  process.env.DEVBOARD_BOOTSTRAP_TOKEN?.trim() || randomBytes(32).toString("base64url");
if (!/^[A-Za-z0-9._~+/=:-]+$/.test(bootstrapToken)) {
  throw new Error(
    "DEVBOARD_BOOTSTRAP_TOKEN must carry RFC 6750 characters only: no whitespace, ';', or ','.",
  );
}
process.env.DEVBOARD_BOOTSTRAP_TOKEN = bootstrapToken;

function isAddressInUse(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "EADDRINUSE") return true;
  }
  return /EADDRINUSE|address already in use|port .* in use/i.test(String(error));
}

/**
 * Replaces this process with the harness the host now points at. The
 * replacement starts before the listener stops; if it cannot start, this
 * process keeps serving and the restart error stays recoverable.
 */
const relaunchSettings = { hostname, port, adrDir, repoDir, goalFile, stateDir };

function restart(server: Dashboard) {
  relaunch(server, relaunchSettings, {
    stop: (current) => current.stop(true),
    exit: (code) => process.exit(code),
    beforeStop: () => {
      server.prepareReplacement();
    },
  });
}

/**
 * Replaces a source dashboard with the checkout's published revision after a
 * successful publish wrote its request. The old process stops only once the
 * replacement has signaled that its code and inputs are ready; a replacement
 * that never signals leaves this process serving the old bundle.
 */
async function replaceFromPublish(request: SourceRefreshRequest): Promise<void> {
  const running = server;
  if (running === undefined) throw new Error("the source refresh has no running server");
  await relaunchConfirmed(
    running,
    relaunchSettings,
    {
      stop: (current) => current.stop(true),
      exit: (code) => process.exit(code),
      beforeStop: () => {
        running.prepareReplacement();
        // Recorded before the listener stops: the replacement, and every
        // later delivery of this revision, must never restart again.
        writeAppliedSourceRefresh(stateDir, request);
      },
    },
    {
      readyFile: join(
        sourceRefreshDirectory(stateDir),
        `ready-${process.pid}-${Date.now()}.json`,
      ),
    },
  );
}

/**
 * A deterministic forge for browser verification: `DEVBOARD_FLOW_FORGE=stub`
 * replaces the real `gh`/`glab` adapter and logs every operation. Production
 * runs leave it unset and use the host forge.
 */
function flowOptions() {
  if (process.env.DEVBOARD_FLOW_FORGE !== "stub") return undefined;
  const target: ForgeTarget = {
    forge: process.env.DEVBOARD_FLOW_FORGE_KIND === "gitlab" ? "gitlab" : "github",
    host: "forge.test",
    project: "acme/fixture",
  };
  const watch = Number(process.env.DEVBOARD_FLOW_WATCH_MS ?? "");
  return {
    forge: new StubForge({ logPath: process.env.DEVBOARD_FLOW_FORGE_LOG }),
    forgeTarget: target,
    ...(Number.isFinite(watch) && watch > 0 ? { watchMs: watch } : {}),
  };
}

/**
 * Harness-owned reporting is disabled unless `DEVBOARD_GITEA_URL` names the
 * Gitea instance. `GITEA_URL` alone is not enough: it is host-forge context,
 * not permission to file harness issues.
 */
function feedbackOptions(): FeedbackOptions | undefined {
  const baseUrl = process.env.DEVBOARD_GITEA_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;
  const token = configuredGiteaToken(process.env);
  const timeoutMs = Number(process.env.DEVBOARD_FEEDBACK_TIMEOUT_MS ?? "");
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    repo: process.env.DEVBOARD_RELEASE_REPO ?? "dsdenes/devboard",
    ...(token === undefined ? {} : { token }),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}

// A source checkout with a Gitea origin supplies its own HTTP address when the
// operator configures none: the local Gitea instance is already listening.
const discoveredGiteaUrl = await sourceCheckoutGiteaUrl({ repoDir });
if (discoveredGiteaUrl !== undefined) {
  process.env.DEVBOARD_GITEA_URL = discoveredGiteaUrl;
  console.log(`Gitea reporting origin discovered at ${discoveredGiteaUrl}`);
}

const injectedFlow = flowOptions();
const injectedFeedback = feedbackOptions();
const journal = openJournal({ stateDir, repoDir, port });
// Every dashboard start reaps what a killed owner left behind. The pass is
// process-only, bounded, and never blocks the listener: a state directory that
// cannot be read only leaves the candidates for the next tick.
try {
  const reaped = runOrphanReaper({ root: repoDir, stateDir });
  if (reaped.killed.length > 0) {
    journal.write(
      "lifecycle",
      `reaped ${reaped.killed.length} orphaned process(es): ${reaped.killed.join(", ")}`,
    );
  }
} catch {
  // A failed pass is the watchdog's job on its next interval.
}
const runningVersion = readHarnessVersion(runningHarnessDir());
// The updater replaces the installed package while this process serves. The
// bundle is copied out of it first, so an update changes what a restart loads
// and never what a running dashboard answers with.
const staticSnapshot = await snapshotStaticDir({ staticDir, stateDir, version: runningVersion });
process.once("exit", staticSnapshot.removeSync);
type Dashboard = ReturnType<typeof createApp>;
let updater: Updater | undefined;
let server: Dashboard | undefined;
// The automatic replacement is one attempt per installed version; the reload
// control retries. The controller owns that policy, so this module only wires.
const replacement = replacementController({
  restart,
  journal,
  runningVersion,
  liveServer: () => server,
});
// The publish-driven source refresh waits for this marker before the old
// listener stops. A replacement that never writes it is ended by the parent.
const replacementReadyFile = process.env.DEVBOARD_REPLACEMENT_READY_FILE;
if (replacementReadyFile !== undefined && replacementReadyFile.length > 0) {
  try {
    mkdirSync(dirname(replacementReadyFile), { recursive: true });
    writeFileSync(
      replacementReadyFile,
      `${JSON.stringify({ pid: process.pid, readyAt: new Date().toISOString() })}\n`,
    );
  } catch {
    // No marker means the parent keeps serving; this process still starts.
  }
}
for (let attempt = 0; ; attempt += 1) {
  try {
    server = createApp({
      adrDir,
      repoDir,
      goalFile,
      agentCommand,
      staticDir: staticSnapshot.dir,
      stateDir,
      hostname,
      allowedHosts,
      token: dashboardToken,
      bootstrap: bootstrapToken,
      port,
      journal,
      runningVersion,
      // `running` is always the version this process loaded. `installed` is
      // what a restart would load now, so a source checkout turns stale once
      // its released source version changes, and an installed prefix turns
      // stale once a newer package sits under the prefix.
      versionState: () => serverVersion(repoDir, runningVersion, updater?.latest() ?? null),
      latestVersion: () => updater?.latest() ?? null,
      ...(injectedFlow === undefined ? {} : { flow: injectedFlow }),
      ...(injectedFeedback === undefined ? {} : { feedback: injectedFeedback }),
      restart: () => {
        if (server !== undefined) restart(server);
      },
    });
    break;
  } catch (error) {
    // A replacement process can reach the bind before this one has exited.
    if (attempt >= 50 || !isAddressInUse(error)) throw error;
    await Bun.sleep(100);
  }
}

// Only a publish refresh replaces a source dashboard. The harness that would
// replace it must be this checkout's own `.devboard`, never another checkout
// or an installed package.
const sourceHarness = hostHarnessDir(repoDir);
if (
  isHarnessSourceCheckout(repoDir) &&
  resolve(sourceHarness) === resolve(runningHarnessDir())
) {
  startSourceRefresher({
    stateDir,
    distDir: join(sourceHarness, "dist"),
    journal,
    replace: replaceFromPublish,
    // A replacement's first check waits one interval, so the process it
    // replaced has recorded the applied commit before this one can read the
    // same request. Without this, one publish could replace twice.
    startImmediately: replacementReadyFile === undefined || replacementReadyFile.length === 0,
  });
}

updater = startUpdater({
  repoDir,
  prefixDir: join(repoDir, ".devboard"),
  stateDir,
  currentVersion: runningVersion,
  journal,
  onInstalled: replacement.replace,
  onStale: replacement.replace,
});

// The document answers only a caller that presents the page's credential, so
// the printed address is the one a browser opens to receive its cookie.
console.log(
  `ADR interface listening on http://${hostname}:${server.port}/?bootstrap=${bootstrapToken}`,
);
