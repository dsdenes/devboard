/**
 * A user report, filed end to end through the overlay.
 *
 * The browser arms the report action, picks the status bar, writes the report,
 * and files it. The dashboard owns the delivery, so it answers 202 and the
 * issue exists on the live Gitea once the record settles; the UI then shows the
 * issue link. Every issue this spec filed is closed in a `finally`, so a failed
 * assertion still leaves the board's open set as it found it: a leftover proof
 * issue would reach the Issues worker as real work and would break the soak's
 * empty-board precondition.
 */

import { expect, test } from "@playwright/test";

import { openDashboard } from "./dashboard.ts";
import { closeIssue, issueNumber, openIssues, readIssue, waitFor } from "./support.ts";

/**
 * The issue number the board holds for one report, found by its title.
 *
 * The cleanup reads the board itself rather than the toast, so the proof issue
 * is closed even when the assertion that failed was the toast's own.
 */
async function filedReport(report: string): Promise<number | undefined> {
  try {
    return await waitFor(
      "the report's issue on the board",
      async () => {
        const match = (await openIssues()).find((issue) => issue.title.includes(report));
        return match === undefined ? null : match.number;
      },
      60_000,
    );
  } catch {
    // A board that never shows the issue leaves the cleanup nothing to close.
    return undefined;
  }
}

test("the report overlay files an issue the UI links and the suite closes", async ({ page }) => {
  await openDashboard(page);
  const report = `Operator suite proof: the report overlay files and links an issue (${Date.now()})`;

  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/reports"),
    { timeout: 60_000 },
  );
  await page.locator('[data-testid="activity-report"]').click();
  await expect(page.locator(".feedback-hint")).toBeVisible();
  await page.locator('[data-testid="status-bar"]').click();

  const panel = page.locator('[role="dialog"][aria-label="Report a UI issue"]');
  await expect(panel).toBeVisible();
  const composer = panel.locator('textarea[aria-label="Issue description"]');
  await composer.fill(report);
  // Enter files the report; asking the agent stays an explicit click.
  await composer.press("Enter");

  const response = await posted;
  // The dashboard answers as soon as it owns the delivery, so one accepted
  // report answers 202 and the issue exists once the record settles.
  expect(response.status()).toBe(202);

  let number: number | undefined;
  try {
    const toast = page.locator('[data-testid="feedback-result"]');
    await expect(toast).toBeVisible({ timeout: 60_000 });
    const link = toast.locator("a.feedback-result__link");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    if (href === null) throw new Error("the report toast linked no issue");
    number = issueNumber(href);

    const issue = await readIssue(number);
    expect(issue.state).toBe("open");
    expect(issue.body).toContain(report);
  } finally {
    // The close belongs to the proof, not to the happy path: whether an
    // assertion above passed or threw, the board is left with its previous
    // open set.
    number ??= await filedReport(report);
    if (number !== undefined) await closeIssue(number);
  }
  if (number === undefined) throw new Error("the report's issue never appeared on the board");

  const filed = number;
  await expect.poll(async () => (await readIssue(filed)).state, { timeout: 30_000 }).toBe(
    "closed",
  );

  // Leave the selection mode and the toast behind.
  await page.keyboard.press("Escape");
  const toast = page.locator('[data-testid="feedback-result"]');
  if (await toast.isVisible()) {
    await toast.getByRole("button", { name: "Dismiss" }).click();
  }
});
