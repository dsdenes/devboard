import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import { configuredGiteaToken } from "../lib/forge";
import { createApp, type FeedbackOptions } from "./app";
import type { ForgeTarget } from "./forge-pr";
import { StubForge } from "./fixtures/stub-forge";
import { openJournal } from "./journal";
import { sourceCheckoutGiteaUrl } from "./local-gitea";
import { relaunch } from "./relaunch";
import { snapshotStaticDir } from "./static-snapshot";
import { startUpdater, type Updater } from "./updates";
import {
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
function restart(server: Server<unknown>) {
  relaunch(
    server,
    { hostname, port, adrDir, repoDir, goalFile, stateDir },
    { stop: (current) => current.stop(true), exit: (code) => process.exit(code) },
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
const runningVersion = readHarnessVersion(runningHarnessDir());
// The updater replaces the installed package while this process serves. The
// bundle is copied out of it first, so an update changes what a restart loads
// and never what a running dashboard answers with.
const staticSnapshot = await snapshotStaticDir({ staticDir, stateDir, version: runningVersion });
process.once("exit", staticSnapshot.removeSync);
let updater: Updater | undefined;
let server: Server<unknown> | undefined;
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
      port,
      journal,
      runningVersion,
      versionState: () =>
        serverVersion(
          repoDir,
          // A source checkout's version is a property of the tree, so a release
          // created while this process runs is what `running` reports. An
          // installed prefix keeps reporting the version it loaded until a
          // restart, which is what makes the reload control appear.
          isHarnessSourceCheckout(repoDir)
            ? readHarnessVersion(runningHarnessDir())
            : runningVersion,
          updater?.latest() ?? null,
        ),
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

updater = startUpdater({
  repoDir,
  prefixDir: join(repoDir, ".devboard"),
  stateDir,
  currentVersion: runningVersion,
  journal,
});

console.log(`ADR interface listening on http://${hostname}:${server.port}`);
