/**
 * A user report, filed end to end through the overlay.
 *
 * The browser arms the report action, picks the status bar, writes the report,
 * and files it. The server answers 201; the issue exists on the live Gitea
 * with the operator report in its body; the UI shows the issue link; the suite
 * closes the issue so the board returns to its previous open set.
 */

import { expect, test } from "@playwright/test";

import { openDashboard } from "./dashboard.ts";
import { closeIssue, issueNumber, readIssue } from "./support.ts";

test("the report overlay files an issue the UI links and the suite closes", async ({ page }) => {
  await openDashboard(page);
  const report = `Operator suite proof: the report overlay files and links an issue (${Date.now()})`;

  const filed = page.waitForResponse(
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

  const response = await filed;
  expect(response.status()).toBe(201);

  const toast = page.locator('[data-testid="feedback-result"]');
  await expect(toast).toBeVisible({ timeout: 60_000 });
  const link = toast.locator("a.feedback-result__link");
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).not.toBeNull();
  const number = issueNumber(href ?? "");
  const issue = await readIssue(number);
  expect(issue.state).toBe("open");
  expect(issue.body).toContain(report);

  await closeIssue(number);
  await expect.poll(async () => (await readIssue(number)).state, { timeout: 30_000 }).toBe(
    "closed",
  );

  // Leave the selection mode and the toast behind.
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="feedback-result"]').getByRole("button", { name: "Dismiss" }).click();
});
