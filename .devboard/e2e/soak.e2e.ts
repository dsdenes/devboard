/**
 * The soak: five consecutive start/stop cycles in one dashboard session.
 *
 * After every cycle the same dashboard answers `/ready`, the real client
 * bundle still loads, and the notification region holds no error entry. After
 * the final cycle the process table holds no worker for the fixture
 * repository and exactly one dashboard serves it. The soak files no
 * `[ui] Error notification:` issue: the open set is unchanged, and when the
 * board is empty before the run it is empty after it.
 */

import { expect, test } from "@playwright/test";

import { ALL_FAMILIES, openDashboard, startFamily, stopFamily } from "./dashboard.ts";
import {
  escapePattern,
  openIssues,
  processesMatching,
  readState,
  type GiteaIssue,
} from "./support.ts";

const ERROR_NOTIFICATION = "[ui] Error notification:";

function errorNotifications(issues: GiteaIssue[]): GiteaIssue[] {
  return issues.filter((issue) => issue.title.includes(ERROR_NOTIFICATION));
}

test("five start/stop cycles keep one ready dashboard and file nothing", async ({ page }) => {
  const state = readState();
  await openDashboard(page);

  const before = await openIssues();
  // The proof's precondition: the board is empty before the soak. A run that
  // left an error notification behind has already failed this.
  expect(before).toEqual([]);
  const errorsBefore = new Set(errorNotifications(before).map((issue) => issue.number));

  for (let cycle = 0; cycle < 5; cycle += 1) {
    const family = ALL_FAMILIES[cycle % ALL_FAMILIES.length];
    await startFamily(page, family);
    await stopFamily(page, family);

    const ready = await page.request.get(`${state.baseUrl}/ready`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toMatchObject({ pid: state.pid });

    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.notification[data-severity="error"]')).toHaveCount(0);
  }

  const workerPattern = `devboard worker .*--repo ${escapePattern(state.repoDir)}`;
  const workers = () =>
    processesMatching(workerPattern).filter((match) => !match.command.includes("pgrep"));
  await expect.poll(workers, { timeout: 30_000 }).toEqual([]);

  const dashboardPattern = `devboard serve .*--repo-dir ${escapePattern(state.repoDir)}`;
  expect(
    processesMatching(dashboardPattern).filter((match) => !match.command.includes("pgrep")),
  ).toHaveLength(1);

  const after = await openIssues();
  expect(after.length).toBe(before.length);
  // No issue the soak could have caused exists; on an empty board this is
  // exactly the empty error set.
  for (const issue of errorNotifications(after)) {
    expect(errorsBefore.has(issue.number)).toBe(true);
  }

  // The history keeps every notification this session raised, not only the
  // four the live region shows.
  await page.locator('[data-testid="notification-indicator"]').click();
  const history = page.locator('[data-testid="notification-history"]');
  await expect(history).toBeVisible();
  await expect(history.locator('.notification[data-severity="error"]')).toHaveCount(0);
});
