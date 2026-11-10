/**
 * The soak: five consecutive start/stop cycles in one dashboard session.
 *
 * After every cycle the same dashboard answers `/ready`, the real client
 * bundle still loads, and the notification region holds no error entry. After
 * the final cycle the process table holds no worker for the fixture
 * repository and exactly one dashboard serves it. The soak files nothing: the
 * open set after the five cycles equals the snapshot taken before them, so an
 * issue of any shape that was not already open is a failure.
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

  // The board's own contents are not the soak's precondition: Auto Scout keeps
  // up to its pending limit of scout issues open there by design. The snapshot
  // taken here names the issues the run may not add.
  const before = await openIssues();
  const beforeNumbers = new Set(before.map((issue) => issue.number));

  for (let cycle = 0; cycle < 5; cycle += 1) {
    const family = ALL_FAMILIES[cycle % ALL_FAMILIES.length];
    await startFamily(page, family);
    await stopFamily(page, family);

    const ready = await page.request.get(`${state.baseUrl}/ready`);
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
  const afterNumbers = new Set(after.map((issue) => issue.number));

  // An error notification filed during the cycles is the failure this proof
  // exists to catch, on a busy board and an empty one alike.
  expect(
    errorNotifications(after).filter((issue) => !beforeNumbers.has(issue.number)),
  ).toEqual([]);
  // No issue outside the notification shape was filed either.
  expect(
    after.filter(
      (issue) => !beforeNumbers.has(issue.number) && !issue.title.includes(ERROR_NOTIFICATION),
    ),
  ).toEqual([]);
  // Every issue the board held before the cycles is still open, so the open set
  // after the soak equals the snapshot it started from.
  expect(before.filter((issue) => !afterNumbers.has(issue.number))).toEqual([]);

  // The history keeps every notification this session raised, not only the
  // four the live region shows.
  await page.locator('[data-testid="notification-indicator"]').click();
  const history = page.locator('[data-testid="notification-history"]');
  await expect(history).toBeVisible();
  await expect(history.locator('.notification[data-severity="error"]')).toHaveCount(0);
});
