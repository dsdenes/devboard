/**
 * Browser helpers shared by the operator suite's specs.
 *
 * Every control is addressed by the test hook it already renders, never by
 * visible prose: the busy word replaces the resting label while a command is
 * in flight.
 */

import { readFileSync } from "node:fs";

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
      const server = await readServerAgent(family);
      throw new Error(
        `${FAMILY_LABELS[family]} stayed ${current}; expected ${states.join(" or ")} within ${timeoutMs} ms; server=${server}`,
      );
    }
    await sleep(200);
    current = await familyLifecycle(page, family);
  }
  return current;
}

/** The server's own snapshot for one family, for a timeout diagnostic. */
async function readServerAgent(family: Family): Promise<string> {
  try {
    const response = await fetch(`${readState().baseUrl}/agents`);
    const body = (await response.json()) as {
      frames?: { type?: string; agents?: { id?: string }[] }[];
    };
    const agent = body.frames?.[0]?.agents?.find((entry) => entry.id === family) as
      | { workers?: { pid?: number }[] }
      | undefined;
    const pid = agent?.workers?.[0]?.pid;
    let stat = "";
    if (typeof pid === "number") {
      try {
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch (error) {
        stat = `unreadable: ${String(error)}`;
      }
    }
    return `${JSON.stringify(agent ?? null)} proc=${stat}`;
  } catch (error) {
    return `unreadable: ${String(error)}`;
  }
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

/**
 * Starts one family through its own page. Start must show `running` with a
 * recorded worker pid within 2,000 ms of the click; the preflight runs beside
 * the spawned worker, so a slow forge read never holds the observable start.
 */
export async function startFamily(page: Page, family: Family): Promise<number[]> {
  await showFamily(page, family);
  clearFamilyRuntime(family, readState());
  const start = page.locator(
    `[data-testid="agent-page"][data-agent="${family}"] [data-testid="agent-start"]`,
  );
  await expect(start).toBeEnabled({ timeout: 30_000 });
  const started = Date.now();
  await start.click();
  const deadline = started + 2_000;
  for (;;) {
    const lifecycle = await familyLifecycle(page, family);
    const pids = await recordedWorkers(page, family);
    if (lifecycle === "running" && pids.length > 0) return pids;
    if (Date.now() > deadline) {
      throw new Error(
        `${FAMILY_LABELS[family]} was ${lifecycle} with ${pids.length} worker pids 2,000 ms after Start`,
      );
    }
    await sleep(100);
  }
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
