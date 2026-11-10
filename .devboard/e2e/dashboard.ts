/**
 * Browser helpers shared by the operator suite's specs.
 *
 * Every control is addressed by the test hook it already renders, never by
 * visible prose: the busy word replaces the resting label while a command is
 * in flight.
 */

import { expect, type Page } from "@playwright/test";

import {
  clearFamilyRuntime,
  FAMILY_LABELS,
  readState,
  sleep,
  SUITE_FAMILIES,
  type Family,
} from "./support.ts";

/** Opens the dashboard document. */
export async function openDashboard(page: Page): Promise<void> {
  const state = readState();
  await page.goto(`${state.baseUrl}/`);
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="unsupported-viewport"]')).toHaveCount(0);
}

/** Shows one background family's page from the Devboard sidebar. */
export async function showFamily(page: Page, family: Family): Promise<void> {
  await page.locator('[data-testid="mode-devboard"]').click();
  const row = page.locator(`[data-testid="open-devboard-${family}"]`);
  await expect(row).toBeVisible();
  await row.click();
  const familyPage = page.locator(`[data-testid="agent-page"][data-agent="${family}"]`);
  await expect(familyPage).toBeVisible();
  await expect(familyPage).toHaveAttribute("aria-label", FAMILY_LABELS[family]);
}

export async function familyLifecycle(page: Page, family: Family): Promise<string> {
  const badge = page.locator(`[data-testid="agent-state-${family}"]`);
  await expect(badge).toHaveCount(1);
  return (await badge.getAttribute("data-state")) ?? "stopped";
}

/** Waits for the family's published lifecycle to reach one of the states. */
export async function waitForLifecycle(
  page: Page,
  family: Family,
  states: string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let current = await familyLifecycle(page, family);
  while (!states.includes(current)) {
    if (Date.now() > deadline) {
      throw new Error(
        `${FAMILY_LABELS[family]} stayed ${current}; expected ${states.join(" or ")} within ${timeoutMs} ms`,
      );
    }
    await sleep(200);
    current = await familyLifecycle(page, family);
  }
  return current;
}

/** The worker pids the family's page records while it runs. */
export async function recordedWorkers(page: Page, family: Family): Promise<number[]> {
  const workers = page.locator(
    `[data-testid="agent-page"][data-agent="${family}"] [data-testid="agent-worker"]`,
  );
  const count = await workers.count();
  const pids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const pid = Number.parseInt((await workers.nth(index).getAttribute("data-pid")) ?? "", 10);
    if (Number.isFinite(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** Starts one family through its own page and waits for the running state. */
export async function startFamily(page: Page, family: Family): Promise<number[]> {
  await showFamily(page, family);
  clearFamilyRuntime(family, readState());
  const start = page.locator(
    `[data-testid="agent-page"][data-agent="${family}"] [data-testid="agent-start"]`,
  );
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();
  await waitForLifecycle(page, family, ["running", "starting"], 60_000);
  await waitForLifecycle(page, family, ["running"], 60_000);
  return recordedWorkers(page, family);
}

/** Stops one family through its own page and waits for the stopped state. */
export async function stopFamily(page: Page, family: Family): Promise<number[]> {
  await showFamily(page, family);
  const pids = await recordedWorkers(page, family);
  const stop = page.locator(
    `[data-testid="agent-page"][data-agent="${family}"] [data-testid="agent-stop"]`,
  );
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();
  await waitForLifecycle(page, family, ["stopping", "stopped"], 30_000);
  await waitForLifecycle(page, family, ["stopped"], 30_000);
  return pids;
}

/** Every family the suite drives starts and stops through its own control. */
export const ALL_FAMILIES = SUITE_FAMILIES;
