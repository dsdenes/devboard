/**
 * The Issues worker's own controls: Start issues the run, Stop ends it.
 *
 * The worker is a different component with its own lifecycle; it gets the
 * same 60 s / 30 s bounds and the same no-surviving-process assertion.
 */

import { expect, test } from "@playwright/test";

import { openDashboard } from "./dashboard.ts";
import { escapePattern, pidAlive, processesMatching, readState } from "./support.ts";

test("the Issues worker starts and stops from its workspace", async ({ page }) => {
  const state = readState();
  await openDashboard(page);
  await page.locator('[data-testid="mode-issues"]').click();

  const start = page.locator('[data-testid="issues-start"]');
  await expect(start).toBeEnabled({ timeout: 30_000 });
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
