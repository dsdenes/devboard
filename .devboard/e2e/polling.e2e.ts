/**
 * Page-scoped polling: the dashboard reads only what its surfaces show.
 *
 * The default Goal page is the surface every operator lands on, so it proves
 * the background chrome's slow poll and the Implementation body's page
 * cadence together — and that the four Devboard-only resources and the run
 * details are read by no page that does not render them. Opening the Auto
 * Scout page reads the agents resource at once; returning to Goal drops it
 * back to the background cadence.
 */

import { expect, test, type Page } from "@playwright/test";

import { openDashboard, showFamily } from "./dashboard.ts";

/** The window every count below is measured over. */
const WINDOW_MS = 20_000;

/** Every GET path the page issued, in order. */
function observeGets(page: Page): string[] {
  const paths: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") return;
    try {
      paths.push(new URL(request.url()).pathname);
    } catch {
      // A request with no readable URL is not a resource read.
    }
  });
  return paths;
}

function reads(paths: readonly string[], path: string): number {
  return paths.filter((entry) => entry === path).length;
}

/** Every recorded path and its count, for a failure that shows the window. */
function tally(paths: readonly string[]): string {
  const counts: Record<string, number> = {};
  for (const path of paths) counts[path] = (counts[path] ?? 0) + 1;
  return JSON.stringify(counts);
}

test("the dashboard polls only the surfaces it shows", async ({ page }) => {
  const paths = observeGets(page);
  await openDashboard(page);
  await page.waitForTimeout(WINDOW_MS);
  const goalWindow = [...paths];

  // Nothing on the Goal page renders these four resources or any run detail.
  for (const path of ["/installed-skills", "/resources", "/complexity", "/mcp-tools"]) {
    expect(reads(goalWindow, path), `${path} over ${WINDOW_MS} ms in ${tally(goalWindow)}`).toBe(0);
  }
  expect(
    goalWindow.filter((path) => path.startsWith("/issues/runs/")),
    `run details over ${WINDOW_MS} ms in ${tally(goalWindow)}`,
  ).toEqual([]);

  // Background chrome: agents and providers change in minutes, not seconds.
  for (const path of ["/agents", "/providers"]) {
    expect(
      reads(goalWindow, path),
      `${path} over ${WINDOW_MS} ms in ${tally(goalWindow)}`,
    ).toBeLessThanOrEqual(1);
  }
  for (const path of ["/records", "/issues"]) {
    expect(
      reads(goalWindow, path),
      `${path} over ${WINDOW_MS} ms in ${tally(goalWindow)}`,
    ).toBeLessThanOrEqual(3);
  }
  // The Implementation body's own resource polls at its two-second cadence.
  expect(
    reads(goalWindow, "/goal"),
    `/goal over ${WINDOW_MS} ms in ${tally(goalWindow)}`,
  ).toBeGreaterThanOrEqual(6);

  // Opening a surface reads it at once instead of waiting for a tick.
  await showFamily(page, "scout");
  const openedAt = paths.length;
  await expect
    .poll(() => paths.slice(openedAt).includes("/agents"), {
      timeout: 6_000,
      intervals: [250],
      message: `no /agents read within 6 s of the Auto Scout page opening`,
    })
    .toBe(true);

  // Returning to Goal keeps the agents resource at its background cadence.
  await page.locator('[data-testid="mode-goal"]').click();
  await page.waitForTimeout(500);
  const returnedAt = paths.length;
  await page.waitForTimeout(WINDOW_MS);
  const returnedWindow = paths.slice(returnedAt);
  expect(
    reads(returnedWindow, "/agents"),
    `/agents over ${WINDOW_MS} ms after returning to Goal in ${tally(returnedWindow)}`,
  ).toBeLessThanOrEqual(1);
});
