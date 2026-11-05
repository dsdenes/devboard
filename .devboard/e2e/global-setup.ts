/**
 * Starts the one dashboard the suite drives.
 *
 * The fixture repository is a throwaway git checkout under
 * `.devboard/.test-tmp/e2e/`. Its origin names the live Gitea repository, so
 * every family's forge read and write preflight runs against the real board.
 * Each family is warmed once before the dashboard exists and then seeded far
 * from its next cycle: the suite proves the controls, not a release, and a
 * warm-up cycle's failure would raise the very error notification the suite
 * exists to forbid. `devboard acp-stub` answers every agent prompt, so no
 * family needs a model.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  binary,
  FAMILIES,
  escapePattern,
  giteaToken,
  giteaUrl,
  harnessDir,
  jsonFiles,
  loadDotEnv,
  processesMatching,
  repository,
  scratchRoot,
  sleep,
  staticDir,
  tmpDir,
  waitFor,
  writeState,
  type Family,
  type SuiteState,
} from "./support.ts";

const TOKEN = "operator-suite-dashboard-token";
const BOOTSTRAP = "operator-suite-bootstrap-token";
const FAR_FUTURE_MS = 24 * 60 * 60 * 1000;

interface Prepared {
  repoDir: string;
  stateDir: string;
  adrsDir: string;
  goalFile: string;
  binDir: string;
  workerVersion: string;
}

function git(cwd: string, args: string[]): void {
  const result = spawn("git", ["-c", "user.name=Suite Fixture", "-c", "user.email=suite@example.test", ...args], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  result.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  result.once("error", reject);
  result.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`));
  });
  return promise;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => {
      if (address === null || typeof address === "string") {
        reject(new Error("no free port"));
      } else {
        resolve(address.port);
      }
    });
  });
  return promise;
}

async function prepareFixture(): Promise<Prepared> {
  rmSync(scratchRoot, { recursive: true, force: true });
  mkdirSync(path.join(scratchRoot, "bin"), { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const repoDir = path.join(scratchRoot, "repo");
  cpSync(path.join(import.meta.dirname, "fixtures", "repo"), repoDir, { recursive: true });
  const binDir = path.join(scratchRoot, "bin");
  writeFileSync(path.join(binDir, "omp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(binDir, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  await git(repoDir, ["init", "-q"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "fixture: operator suite"]);
  await git(repoDir, ["remote", "add", "origin", `${giteaUrl()}/${repository()}.git`]);

  const stateDir = path.join(repoDir, ".devboard", ".tmp", "state");
  mkdirSync(stateDir, { recursive: true });
  const adrsDir = path.join(repoDir, "adrs");
  const goalFile = path.join(repoDir, "GOAL.md");
  const version = spawn(binary, ["version"], { stdio: ["ignore", "pipe", "ignore"] });
  let text = "";
  version.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  version.once("exit", () => resolve());
  await promise;
  const workerVersion = text.trim().split(/\s+/).pop() ?? "unknown";
  return { repoDir, stateDir, adrsDir, goalFile, binDir, workerVersion };
}

/** One deterministic provider so every family can spawn its stub peer. */
function seedProvider(stateDir: string): void {
  const directory = path.join(stateDir, "providers");
  mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  const credentials = {
    version: 1,
    subscriptions: [
      {
        id: "operator-suite",
        provider: "opencode-go",
        label: "Operator suite",
        key: "suite-key-000000000000",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  writeFileSync(path.join(directory, "credentials.json"), `${JSON.stringify(credentials)}\n`);
}

function workerEnvironment(prepared: Prepared): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEVBOARD_OPENCODE_GO_USAGE_BASE_URL: "http://127.0.0.1:1",
    PATH: `${prepared.binDir}:${process.env.PATH ?? ""}`,
    REPO_DIR: prepared.repoDir,
    STATE_DIR: prepared.stateDir,
    GOAL_FILE: prepared.goalFile,
    ADRS_DIR: prepared.adrsDir,
    AGENT_COMMAND: `${binary} acp-stub`,
    DEVBOARD_GITEA_URL: giteaUrl(),
    GITEA_TOKEN: giteaToken(),
    DEVBOARD_HARNESS_VERSION: prepared.workerVersion,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The directory a family's worker publishes under, for the warm-up. */
function familyRoot(family: Family, prepared: Prepared): string {
  if (family === "watchdog") {
    return path.join(prepared.repoDir, ".devboard", ".tmp", "watchdog");
  }
  if (family === "mcp-optimizer") {
    return path.join(prepared.stateDir, "coach");
  }
  if (family === "release-train") {
    return path.join(prepared.stateDir, "release-train");
  }
  return path.join(prepared.stateDir, family);
}

function familyArgs(family: Family, prepared: Prepared): string[] {
  if (family === "watchdog") {
    return [
      "worker",
      family,
      "--repo",
      prepared.repoDir,
      "--state-dir",
      path.join(prepared.repoDir, ".devboard", ".tmp", "watchdog"),
      "--owner-state-dir",
      prepared.stateDir,
    ];
  }
  return ["worker", family, "--repo", prepared.repoDir, "--state-dir", prepared.stateDir];
}

/** One short warm-up: the worker publishes its state, then leaves cleanly. */
async function warmUp(family: Family, prepared: Prepared): Promise<void> {
  const log = path.join(tmpDir, `warmup-${family}.log`);
  const child = spawn(binary, familyArgs(family, prepared), {
    cwd: prepared.repoDir,
    env: workerEnvironment(prepared),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const root = familyRoot(family, prepared);
  try {
    await waitFor(`${family} to publish state`, () => jsonFiles(root).length > 0 || !child.killed, 10_000);
    // Let the immediate cycle start and record its outcome, whatever it is.
    await sleep(1_500);
  } finally {
    child.kill("SIGTERM");
    const { promise, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10_000);
    await promise;
    clearTimeout(timer);
  }
  writeFileSync(log, stderr);
}

function settle(value: unknown, now: string, later: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => settle(entry, now, later));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "lastError" || key === "notice" || key === "error") {
      record[key] = null;
      continue;
    }
    if (key === "lifecycle") {
      record[key] = "stopped";
      continue;
    }
    if (key === "enabled" || key === "stopping" || key === "draining") {
      record[key] = false;
      continue;
    }
    if (key === "sync") {
      const sync = record[key];
      if (sync !== null && typeof sync === "object") {
        record[key] = { ...(sync as Record<string, unknown>), state: "ok", at: now, error: null };
      }
      continue;
    }
    if (/^next.*At$/i.test(key)) {
      record[key] = later;
      continue;
    }
    if (/^(last|active).*At$/i.test(key) && typeof record[key] === "string") {
      record[key] = now;
      continue;
    }
    record[key] = settle(record[key], now, later);
  }
  return record;
}

/** Removes a warm-up's leftover lock and pending control files. */
function clearWarmupLocks(family: Family, prepared: Prepared): void {
  const directory =
    family === "watchdog"
      ? path.join(prepared.repoDir, ".devboard", ".tmp", "watchdog")
      : family === "mcp-optimizer"
        ? path.join(prepared.stateDir, "coach")
        : family === "release-train"
          ? path.join(prepared.stateDir, "release-train")
          : path.join(prepared.repoDir, ".devboard", ".tmp", family);
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (entry.startsWith("lock") || entry === "control") {
      rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
  }
}

/** Seeds every family far from its next cycle and clears warm-up noise. */
function seedCadence(family: Family, prepared: Prepared): void {
  const root = familyRoot(family, prepared);
  if (!existsSync(root)) return;
  const now = new Date().toISOString();
  const later = new Date(Date.now() + FAR_FUTURE_MS).toISOString();
  const records = jsonFiles(root).filter((file) => path.basename(file) !== "settings.json");
  for (const file of records) {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    writeFileSync(file, `${JSON.stringify(settle(value, now, later), null, 2)}\n`);
  }
  const settings = { intervalMinutes: 1440, maxPerHour: null, maxPending: null };
  const directories = new Set(records.map((file) => path.dirname(file)));
  directories.add(root);
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "settings.json"), `${JSON.stringify(settings)}\n`);
  }
}

async function startDashboard(prepared: Prepared): Promise<ChildProcess> {
  const port = await freePort();
  const env = {
    ...workerEnvironment(prepared),
    DEVBOARD_DASHBOARD_TOKEN: TOKEN,
    DEVBOARD_BOOTSTRAP_TOKEN: BOOTSTRAP,
    DEVBOARD_ALLOWED_HOSTS: "127.0.0.1,localhost",
    DEVBOARD_FEEDBACK_TIMEOUT_MS: "30000",
    STATIC_DIR: staticDir,
  };
  const log = path.join(tmpDir, "dashboard.log");
  const child = spawn(
    binary,
    [
      "serve",
      "--port",
      String(port),
      "--repo-dir",
      prepared.repoDir,
      "--state-dir",
      prepared.stateDir,
      "--adrs-dir",
      prepared.adrsDir,
      "--static-dir",
      staticDir,
      "--token",
      TOKEN,
    ],
    { cwd: harnessDir, env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(
      "the dashboard readiness probe",
      async () => {
        const response = await fetch(`${baseUrl}/ready`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        return response.ok;
      },
      30_000,
    );
  } catch (error) {
    child.kill("SIGKILL");
    writeFileSync(log, stderr);
    throw error;
  }
  writeFileSync(log, stderr);
  const state: SuiteState = {
    baseUrl,
    port,
    token: TOKEN,
    bootstrap: BOOTSTRAP,
    repository: repository(),
    repoDir: prepared.repoDir,
    stateDir: prepared.stateDir,
    adrsDir: prepared.adrsDir,
    goalFile: prepared.goalFile,
    workerVersion: prepared.workerVersion,
    pid: child.pid ?? 0,
  };
  writeState(state);
  return child;
}

function stopDashboard(child: ChildProcess): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (child.exitCode !== null) {
    resolve();
    return promise;
  }
  child.once("exit", () => resolve());
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    resolve();
  }, 15_000);
  timer.unref();
  return promise;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  loadDotEnv();
  mkdirSync(tmpDir, { recursive: true });
  const prepared = await prepareFixture();
  seedProvider(prepared.stateDir);
  for (const family of FAMILIES) {
    await warmUp(family, prepared);
    seedCadence(family, prepared);
    clearWarmupLocks(family, prepared);
  }
  const dashboard = await startDashboard(prepared);
  return async () => {
    await stopDashboard(dashboard);
    const pattern = `devboard worker .*--repo ${escapePattern(prepared.repoDir)}`;
    for (const match of processesMatching(pattern)) {
      try {
        process.kill(match.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };
}
