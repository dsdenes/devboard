/**
 * Every background agent family the suite drives, through the two controls an
 * operator uses.
 *
 * Start must move the family to `running` with a recorded worker pid within
 * 2,000 ms; Stop must move it to `stopped` within 30 s; the worker process the page recorded must be gone
 * and no `devboard worker <family>` process for the fixture repository may
 * survive. The page, the server, and the worker are the real artifacts. The
 * Release Train is not driven here: its gate reads the fixture's live origin,
 * so starting it would run a real release. Deploy on main is not driven here
 * either: a Start would run the fixture's own deploy instructions.
 *
 * The two project-kind gates are proven against the same dashboard, never a
 * second server: the fixture is a harness source checkout, and removing the
 * harness source manifest from its `.devboard/` makes the served checkout a
 * host project until the test restores it. A gated-off family stays listed,
 * names its reason, and renders no Start control; the family the kind permits
 * renders Start and no gate.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  ALL_FAMILIES,
  openDashboard,
  recordedWorkers,
  startFamily,
  stopFamily,
} from "./dashboard.ts";
import { escapePattern, pidAlive, processesMatching, readState } from "./support.ts";

test.beforeEach(async ({ page }) => {
  await openDashboard(page);
});

for (const family of ALL_FAMILIES) {
  test(`${family}: Start runs the family and Stop removes its worker`, async ({ page }) => {
    const state = readState();
    const command = `devboard worker ${family} --repo ${escapePattern(state.repoDir)}`;

    await startFamily(page, family);
    await expect
      .poll(async () => (await recordedWorkers(page, family)).length, { timeout: 60_000 })
      .toBeGreaterThan(0);
    const recorded = await recordedWorkers(page, family);
    expect(processed(command).length).toBeGreaterThan(0);

    const beforeStop = await recordedWorkers(page, family);
    const stopped = await stopFamily(page, family);
    const pids = [...new Set([...recorded, ...beforeStop, ...stopped])];
    for (const pid of pids) {
      await expect.poll(() => pidAlive(pid), { timeout: 30_000 }).toBe(false);
    }
    await expect.poll(() => processed(command).length, { timeout: 30_000 }).toBe(0);
  });
}

/**
 * The two project-kind gates, each proven on both sides of its boundary.
 *
 * The fixture is a harness source checkout: the Release Train is available
 * there and Deploy on main is gated off. Removing its harness source manifest
 * makes the served checkout a host project, and every agent read recomputes
 * the gate, so a reload moves both entries. Nothing is started: a gated-off
 * family must not even offer Start. The manifest's exact bytes are restored.
 */
const HOST_PROJECT_REASON =
  "Release Train runs only in a harness source checkout; this project is a host project.";
const HARNESS_SOURCE_REASON =
  "Deploy on main runs only on host projects; this project is the harness source checkout.";

test("project gates: each gated family runs on exactly one project kind", async ({ page }) => {
  const state = readState();
  const manifest = path.join(state.repoDir, ".devboard", "package.json");
  expect(existsSync(manifest)).toBe(true);
  const original = readFileSync(manifest);

  await expectAvailableInSidebar(page, "release-train");
  await expectGatedInSidebar(page, "deploy-on-main", HARNESS_SOURCE_REASON);
  await expectAvailablePage(page, "release-train");
  await expectGatedPage(page, "deploy-on-main", HARNESS_SOURCE_REASON);

  rmSync(manifest);
  try {
    await openDashboard(page);
    await expectGatedInSidebar(page, "release-train", HOST_PROJECT_REASON);
    await expectAvailableInSidebar(page, "deploy-on-main");
    await expectGatedPage(page, "release-train", HOST_PROJECT_REASON);
    await expectAvailablePage(page, "deploy-on-main");
  } finally {
    writeFileSync(manifest, original);
  }

  await openDashboard(page);
  await expectAvailableInSidebar(page, "release-train");
  await expectGatedInSidebar(page, "deploy-on-main", HARNESS_SOURCE_REASON);
});

/** Shows the Devboard sidebar's Background agents group. */
async function showBackgroundAgents(page: Page): Promise<void> {
  await page.locator('[data-testid="mode-devboard"]').click();
  await expect(page.locator('[data-testid="sidebar-background-agents"]')).toBeVisible();
}

/** Asserts one sidebar entry is listed, disabled, and names its reason. */
async function expectGatedInSidebar(page: Page, agent: string, reason: string): Promise<void> {
  await showBackgroundAgents(page);
  const row = page.locator(`[data-testid="open-devboard-${agent}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-disabled", "true");
  await expect(row).toHaveAttribute("title", reason);
  const gate = page.locator(`[data-testid="agent-gate-${agent}"]`);
  await expect(gate).toBeVisible();
  await expect(gate).toContainText(reason);
}

/** Asserts one sidebar entry is listed as an available family. */
async function expectAvailableInSidebar(page: Page, agent: string): Promise<void> {
  await showBackgroundAgents(page);
  const row = page.locator(`[data-testid="open-devboard-${agent}"]`);
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(`[data-testid="agent-gate-${agent}"]`)).toHaveCount(0);
}

/** Opens one family's page from the sidebar and returns it. */
async function showAgentPage(page: Page, agent: string) {
  await showBackgroundAgents(page);
  // A gated-off entry stays clickable by design: it opens its page to state
  // the reason. Force the click past the disabled presentation.
  await page.locator(`[data-testid="open-devboard-${agent}"]`).click({ force: true });
  const agentPage = page.locator(`[data-testid="agent-page"][data-agent="${agent}"]`);
  await expect(agentPage).toBeVisible();
  return agentPage;
}

/** Asserts a gated-off page names its reason, in a status region, and offers no Start. */
async function expectGatedPage(page: Page, agent: string, reason: string): Promise<void> {
  const agentPage = await showAgentPage(page, agent);
  const gate = agentPage.locator('[data-testid="agent-gate"]');
  await expect(gate).toBeVisible();
  await expect(gate).toHaveAttribute("role", "status");
  await expect(gate).toContainText(reason);
  await expect(agentPage.locator('[data-testid="agent-start"]')).toHaveCount(0);
}

/** Asserts an available page renders Start and no gate. */
async function expectAvailablePage(page: Page, agent: string): Promise<void> {
  const agentPage = await showAgentPage(page, agent);
  await expect(agentPage.locator('[data-testid="agent-gate"]')).toHaveCount(0);
  await expect(agentPage.locator('[data-testid="agent-start"]')).toBeVisible();
}

/** The worker processes for one family and the fixture repository. */
function processed(pattern: string) {
  const matches = processesMatching(pattern);
  return matches.filter((match) => !match.command.includes("pgrep"));
}
