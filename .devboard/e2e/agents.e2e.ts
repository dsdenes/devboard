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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  ALL_FAMILIES,
  openDashboard,
  recordedWorkers,
  startFamily,
  stopFamily,
} from "./dashboard.ts";
import { escapePattern, pidAlive, processesMatching, readState, run } from "./support.ts";

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

/**
 * The Deploy on main page on a host project: its prompt plus one deploy
 * history panel. The fixture's harness source manifest is removed for the
 * duration, so the family is available; its state file and worker record are
 * seeded, then the fixture manifest and state bytes are restored.
 */
test("Deploy on main history: seeded runs fill one panel and nothing else", async ({ page }) => {
  const state = readState();
  const manifest = path.join(state.repoDir, ".devboard", "package.json");
  expect(existsSync(manifest)).toBe(true);
  const originalManifest = readFileSync(manifest);

  const directory = path.join(state.stateDir, "deploy-on-main");
  const stateFile = path.join(directory, "state.json");
  const originalState = existsSync(stateFile) ? readFileSync(stateFile) : null;
  const head = run("git", ["rev-parse", "HEAD"], state.repoDir);
  const runningStarted = "2026-11-05T11:00:00.000Z";
  const skippedAt = "2026-11-04T10:30:00.000Z";
  const stoppedAt = "2026-11-04T10:05:00.000Z";
  const failedAt = "2026-11-03T09:05:00.000Z";
  const succeededAt = "2026-11-02T08:05:00.000Z";
  const runRecord = (
    id: string,
    state_: string,
    at: string,
    endedAt: string | null,
    commits: number | null,
  ) => ({
    version: 1,
    id,
    startedAt: at,
    endedAt,
    state: state_,
    commit: head,
    worktree: path.join(state.repoDir, ".worktree", "deploy-main"),
    detail: "seeded",
    peer: null,
    commits,
  });
  const seeded = {
    version: 1,
    repo: state.repoDir,
    root: state.repoDir,
    updatedAt: runningStarted,
    activity: [],
    runs: [
      runRecord("run-running", "running", runningStarted, null, 1),
      runRecord("run-skipped", "skipped", skippedAt, skippedAt, null),
      runRecord("run-stopped", "stopped", stoppedAt, stoppedAt, 2),
      runRecord("run-failed", "failed", failedAt, failedAt, 3),
      runRecord("run-succeeded", "succeeded", succeededAt, succeededAt, 0),
    ],
    issues: [
      {
        title: "Deploy on main failed at 1234567",
        category: "deploy",
        createdAt: failedAt,
        url: "https://example.test/issues/7",
        state: "filed",
        version: null,
        note: null,
      },
    ],
    issuedCommits: [head],
    lastCommit: head,
  };
  const workerDirectory = path.join(directory, "workers", state.harnessVersion);
  const workerFile = path.join(workerDirectory, "worker.json");
  const originalWorker = existsSync(workerFile) ? readFileSync(workerFile) : null;
  mkdirSync(workerDirectory, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(seeded, null, 2)}\n`);
  writeFileSync(
    workerFile,
    `${JSON.stringify(
      {
        version: 1,
        pid: process.pid,
        startTicks: null,
        startedAt: runningStarted,
        root: state.repoDir,
        stateDir: state.stateDir,
        lifecycle: "running",
        enabled: true,
        paused: false,
        harnessVersion: state.harnessVersion,
        argv: ["devboard", "worker", "deploy-on-main"],
        lastRunAt: runningStarted,
        lastError: null,
        notice: "deploy failed: the seeded run failed",
        activeRun: null,
        baseline: head,
        updatedAt: runningStarted,
      },
      null,
      2,
    )}\n`,
  );
  rmSync(manifest);
  try {
    await openDashboard(page);
    const agentPage = await showAgentPage(page, "deploy-on-main");

    await expect(agentPage.locator('[data-testid="agent-prompt"]')).toBeVisible();
    await expect(agentPage.getByRole("heading", { name: "Deploy history" })).toBeVisible();
    await expect(agentPage.locator('[data-testid="agent-deploys"]')).toHaveCount(1);
    await expect(agentPage.locator('[aria-label="Filing limits"]')).toHaveCount(0);
    await expect(agentPage.locator('[data-testid="agent-limit-hour"]')).toHaveCount(0);
    await expect(agentPage.locator('[data-testid="agent-limit-pending"]')).toHaveCount(0);
    await expect(agentPage.locator('[data-testid="agent-save-limits"]')).toHaveCount(0);
    await expect(agentPage.locator('[data-testid="agent-issues"]')).toHaveCount(0);
    await expect(agentPage.locator('[data-testid="agent-issues-count"]')).toHaveCount(0);
    await expect(agentPage.getByRole("heading", { name: "Filed issues" })).toHaveCount(0);
    // The seeded worker notice names a run status; the page keeps it out.
    await expect(agentPage.locator('[data-testid="agent-notice"]')).toHaveCount(0);

    const rows = agentPage.locator('[data-testid="agent-deploy"]');
    await expect(rows).toHaveCount(4);
    const expected = [
      { state: "running", at: runningStarted, commits: "1" },
      { state: "stopped", at: stoppedAt, commits: "2" },
      { state: "failed", at: failedAt, commits: "3" },
      { state: "succeeded", at: succeededAt, commits: "0" },
    ];
    for (const [index, row] of expected.entries()) {
      const locator = rows.nth(index);
      await expect(locator).toHaveAttribute("data-state", row.state);
      const at = locator.locator('[data-testid="agent-deploy-at"]');
      await expect(at).toHaveAttribute("datetime", row.at);
      await expect(at).not.toHaveText(row.at);
      await expect(at).not.toHaveText("");
      await expect(locator.locator('[data-testid="agent-deploy-commits"]')).toHaveText(row.commits);
    }
    await expect(agentPage.locator('[data-state="skipped"]')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="agent-count-deploy-on-main"]'),
    ).toHaveText("4");

    // The page's Filed issues panel is gone, and the Issues workspace still
    // opens over the same dashboard.
    await page.locator('[data-testid="mode-issues"]').click();
    await expect(page.locator('[data-testid="issues-overview"]')).toBeVisible();
  } finally {
    writeFileSync(manifest, originalManifest);
    if (originalState === null) rmSync(stateFile, { force: true });
    else writeFileSync(stateFile, originalState);
    if (originalWorker === null) rmSync(workerFile, { force: true });
    else writeFileSync(workerFile, originalWorker);
  }
});
