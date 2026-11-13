/**
 * The Issues worker's own controls: Start issues the run, Stop ends it.
 *
 * The worker is a different component with its own lifecycle; it gets the
 * same 60 s / 30 s bounds and the same no-surviving-process assertion.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { openDashboard } from "./dashboard.ts";
import {
  clearFamilyRuntime,
  escapePattern,
  pidAlive,
  processesMatching,
  readState,
  sleep,
} from "./support.ts";

test("the Issues worker starts and stops from its workspace", async ({ page }) => {
  const state = readState();
  await openDashboard(page);
  await page.locator('[data-testid="mode-issues"]').click();

  const start = page.locator('[data-testid="issues-start"]');
  await expect(start).toBeEnabled({ timeout: 30_000 });
  clearFamilyRuntime("issues", state);
  await start.click();
  await expect
    .poll(async () => (await page.locator('[data-testid="issues-stop"]').count()) > 0, {
      timeout: 60_000,
    })
    .toBe(true);

  const pattern = `--repo ${escapePattern(state.repoDir)}`;
  const workerPids = () =>
    processesMatching(pattern)
      .filter((match) => !match.command.includes("pgrep"))
      .map((match) => match.pid);
  await expect.poll(workerPids, { timeout: 30_000 }).not.toEqual([]);
  const pids = workerPids();

  const stop = page.locator('[data-testid="issues-stop"]');
  await stop.click();
  await expect
    .poll(async () => (await page.locator('[data-testid="issues-start"]').count()) > 0, {
      timeout: 30_000,
    })
    .toBe(true);
  for (const pid of pids) {
    await expect.poll(() => pidAlive(pid), { timeout: 30_000 }).toBe(false);
  }
});

/**
 * Start always answers on the panel: a worker pid, or the named refusal.
 *
 * The page may never wait out the ten-second ceiling for an answer the server
 * already gave, and a refused Start must leave Start available for a retry.
 */
test("a Start shows its worker or its named refusal, never the ceiling", async ({ page }) => {
  const state = readState();
  await openDashboard(page);
  await page.locator('[data-testid="mode-issues"]').click();
  clearFamilyRuntime("issues", state);

  const start = page.locator('[data-testid="issues-start"]');
  const stop = page.locator('[data-testid="issues-stop"]');
  const refusal = page.locator('[data-testid="issues-start-error"]');
  const worker = page.locator('[data-testid="issues-worker-pid"]');
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();

  // Either the worker's pid or the named refusal, inside the two seconds the
  // shared Start control's answer budget allows. The Stop control is on the
  // panel throughout; its enabling is the worker's own state, proven below.
  let answer = "waiting";
  const deadline = Date.now() + 2_000;
  while (answer === "waiting" && Date.now() < deadline) {
    const refused =
      (await refusal.count()) > 0 ? ((await refusal.textContent()) ?? "").trim() : "";
    if (refused !== "") answer = "refused";
    else if ((await stop.count()) > 0 && /pid \d+/.test((await worker.textContent()) ?? "")) {
      answer = "started";
    } else await sleep(50);
  }
  expect(answer).not.toBe("waiting");
  await expect(page.getByText("received no answer")).toHaveCount(0);

  if (answer === "started") {
    // The worker's own published state settles the panel, and Stop removes it.
    await expect(stop).toBeEnabled({ timeout: 30_000 });
    await stop.click();
    await expect(start).toBeEnabled({ timeout: 30_000 });
    clearFamilyRuntime("issues", state);
  }

  // A foreign worker lock owns this checkout: Start refuses by name on the
  // card and stays available for the retry after the lock is gone.
  const foreign = spawn("sleep", ["120"], { stdio: "ignore" });
  const foreignPid = foreign.pid;
  if (foreignPid === undefined) throw new Error("the foreign worker has no pid");
  const lockPath = path.join(state.repoDir, ".devboard", ".tmp", "issues", "lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const foreignState = path.join(state.repoDir, ".devboard", ".tmp", "foreign-state");
  writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        pid: foreignPid,
        startedAt: new Date().toISOString(),
        repo: state.repoDir,
        stateDir: foreignState,
        harnessVersion: null,
        argv: ["sleep", "120"],
      },
      null,
      2,
    )}\n`,
  );
  try {
    await start.click();
    await expect(refusal).toContainText("already has an issues worker", { timeout: 2_000 });
    await expect(refusal).toContainText(`pid ${foreignPid}`);
    await expect(start).toBeEnabled();
    await expect(page.getByText("received no answer")).toHaveCount(0);
  } finally {
    rmSync(lockPath, { force: true });
    foreign.kill();
  }
});
