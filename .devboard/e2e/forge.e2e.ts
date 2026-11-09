/**
 * The forge boundary: this checkout's Gitea origin is the only tracker the
 * Issues surface reads, and an origin that names no forge refuses with the
 * origin as the reason.
 *
 * A `gh` or `glab` on the fixture's `PATH` records itself and exits 1, so a
 * forge CLI start both shows up in the log and cannot answer. Each case starts
 * its own throwaway dashboard over a repository chosen for the case; the
 * global setup's dashboard keeps serving on the live Gitea fixture.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  binary,
  forgeRecorderDir,
  forgeRecorderForgeLines,
  forgeRecorderLines,
  harnessDir,
  loadDotEnv,
  readState,
  scratchRoot,
  sleep,
  staticDir,
  waitFor,
} from "./support.ts";

loadDotEnv();

interface Dashboard {
  baseUrl: string;
  child: ChildProcess;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => {
      if (address === null || typeof address === "string") reject(new Error("no free port"));
      else resolve(address.port);
    });
  });
  return promise;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const result = spawn(
    "git",
    ["-c", "user.name=Forge Fixture", "-c", "user.email=forge@example.test", ...args],
    { cwd, stdio: ["ignore", "ignore", "pipe"] },
  );
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
  await promise;
}

interface FixtureRepo {
  repoDir: string;
  stateDir: string;
  adrsDir: string;
  goalFile: string;
}

async function prepareRepo(label: string, origin: string | null): Promise<FixtureRepo> {
  const root = path.join(scratchRoot, "forge", label);
  rmSync(root, { recursive: true, force: true });
  const repoDir = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  const adrsDir = path.join(root, "adrs");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(adrsDir, { recursive: true });
  writeFileSync(path.join(repoDir, ".gitkeep"), "");
  writeFileSync(path.join(repoDir, "GOAL.md"), "# Fixture goal\n");
  await runGit(repoDir, ["init", "-q"]);
  await runGit(repoDir, ["add", "-A"]);
  await runGit(repoDir, ["commit", "-q", "-m", "chore: forge fixture"]);
  if (origin !== null) await runGit(repoDir, ["remote", "add", "origin", origin]);
  return { repoDir, stateDir, adrsDir, goalFile: path.join(repoDir, "GOAL.md") };
}

async function startDashboard(
  repo: { repoDir: string; stateDir: string; adrsDir: string; goalFile: string },
  extra: NodeJS.ProcessEnv = {},
): Promise<Dashboard> {
  const port = await freePort();
  const env = {
    ...process.env,
    ...extra,
    PATH: `${forgeRecorderDir}:${process.env.PATH ?? ""}`,
    REPO_DIR: repo.repoDir,
    STATE_DIR: repo.stateDir,
    GOAL_FILE: repo.goalFile,
    ADRS_DIR: repo.adrsDir,
    STATIC_DIR: staticDir,
    DEVBOARD_DASHBOARD_SINGLETON_FIXTURE: "1",
    DEVBOARD_ALLOWED_HOSTS: "127.0.0.1,localhost",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
  const child = spawn(
    binary,
    [
      "serve",
      "--port",
      String(port),
      "--repo-dir",
      repo.repoDir,
      "--state-dir",
      repo.stateDir,
      "--adrs-dir",
      repo.adrsDir,
      "--static-dir",
      staticDir,
    ],
    { cwd: harnessDir, env, stdio: ["ignore", "ignore", "ignore"] },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    "the throwaway dashboard readiness probe",
    async () => {
      try {
        return (await fetch(`${baseUrl}/ready`)).ok;
      } catch {
        return false;
      }
    },
    30_000,
  );
  return { baseUrl, child };
}

async function stopDashboard(dashboard: Dashboard): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (dashboard.child.exitCode !== null) {
    resolve();
    return promise;
  }
  dashboard.child.once("exit", () => resolve());
  dashboard.child.kill("SIGTERM");
  const timer = setTimeout(() => {
    dashboard.child.kill("SIGKILL");
    resolve();
  }, 15_000);
  timer.unref();
  return promise;
}

async function openIssues(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/`);
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="mode-issues"]').click();
  await expect(page.locator('[data-testid="issues-overview"]')).toBeVisible({ timeout: 30_000 });
}

test("the family warm-ups start no forge CLI on the Gitea origin", async () => {
  expect(forgeRecorderForgeLines()).toEqual([]);
});

interface IssuesFrame {
  enabled?: boolean;
  lifecycle?: string;
  queue?: unknown[];
  poll?: { error?: string | null } | null;
}

async function issuesFrame(baseUrl: string): Promise<IssuesFrame> {
  const response = await fetch(`${baseUrl}/issues`);
  const body = (await response.json()) as { frames?: { type?: string } & IssuesFrame }[];
  const frame = body.frames?.find((entry) => entry.type === "issuesState");
  if (frame === undefined) throw new Error("the issues frame is absent");
  return frame;
}

test("the Issues surface reads the live Gitea origin and starts no forge CLI", async ({ page }) => {
  test.setTimeout(420_000);
  const state = readState();
  const before = forgeRecorderLines();

  await openIssues(page, state.baseUrl);
  await expect(page.locator('[data-testid="issues-poll-error"]')).toHaveCount(0);

  // The queue is the worker's own read; start it so the Overview lists the
  // origin's open issues through the Gitea API.
  const start = page.locator('[data-testid="issues-start"]');
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();

  // The published frame is the same snapshot the Overview renders: a poll
  // through the Gitea API lists the origin's open issues with no error.
  let frame: IssuesFrame | null = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && frame === null) {
    const current = await issuesFrame(state.baseUrl);
    if (
      current.enabled === true &&
      (current.queue?.length ?? 0) > 0 &&
      (current.poll?.error ?? null) === null
    ) {
      frame = current;
      break;
    }
    await sleep(500);
  }
  expect(frame, "the issues worker's Gitea poll").not.toBeNull();

  await page.locator('[data-testid="open-issues-queue"]').click();
  await expect
    .poll(async () => page.locator('[data-testid="issues-queue-item"]').count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect(page.locator('[data-testid="issues-poll-error"]')).toHaveCount(0);

  // Two poll intervals are 60 s; a forge CLI start in either would land here.
  await sleep(65_000);
  expect(forgeRecorderLines().slice(before.length)).toEqual([]);

  await page.locator('[data-testid="open-issues-overview"]').click();
  await page.locator('[data-testid="issues-stop"]').click();
  // Later suites expect no live run: wait for the stop to settle.
  await expect(page.locator('[data-testid="issues-stop"]')).toBeDisabled({ timeout: 60_000 });
  await expect(page.locator('[data-testid="issues-start"]')).toBeEnabled({ timeout: 60_000 });
});

test("an origin that names no forge refuses and names the origin", async ({ page }) => {
  const repo = await prepareRepo("no-origin", null);
  const before = forgeRecorderLines();
  const dashboard = await startDashboard(repo);
  try {
    await openIssues(page, dashboard.baseUrl);
    const error = page.locator('[data-testid="issues-poll-error"]');
    await expect(error).toBeVisible({ timeout: 60_000 });
    const text = (await error.textContent()) ?? "";
    expect(text).toContain("origin does not name a supported forge");
    expect(text).toContain("has no `origin` remote");
    expect(forgeRecorderLines().slice(before.length)).toEqual([]);
  } finally {
    await stopDashboard(dashboard);
    rmSync(path.join(scratchRoot, "forge", "no-origin"), { recursive: true, force: true });
  }
});

test("a refused Gitea connection names the forge and the cause", async ({ page }) => {
  const state = readState();
  const repo = {
    repoDir: state.repoDir,
    stateDir: path.join(scratchRoot, "forge", "refused-gitea-state"),
    adrsDir: state.adrsDir,
    goalFile: state.goalFile,
  };
  mkdirSync(repo.stateDir, { recursive: true });
  const before = forgeRecorderLines();
  const dashboard = await startDashboard(repo, {
    DEVBOARD_GITEA_URL: "http://127.0.0.1:1",
    GITEA_TOKEN: process.env.GITEA_TOKEN ?? "fixture-token",
  });
  try {
    await openIssues(page, dashboard.baseUrl);
    const error = page.locator('[data-testid="issues-poll-error"]');
    await expect(error).toBeVisible({ timeout: 60_000 });
    const text = (await error.textContent()) ?? "";
    expect(text).toContain("Gitea open-issue read");
    expect(text.toLowerCase()).toContain("connection refused");
    expect(forgeRecorderLines().slice(before.length)).toEqual([]);
  } finally {
    await stopDashboard(dashboard);
    rmSync(path.join(scratchRoot, "forge", "refused-gitea-state"), {
      recursive: true,
      force: true,
    });
  }
});
