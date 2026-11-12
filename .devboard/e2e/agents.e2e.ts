/**
 * Every background agent family the suite drives, through the two controls an
 * operator uses.
 *
 * Start must move the family to `running` with a recorded worker pid within
 * 2,000 ms; Stop must move it to `stopped` within 30 s; the worker process the page recorded must be gone
 * and no `devboard worker <family>` process for the fixture repository may
 * survive. The page, the server, and the worker are the real artifacts. The
 * Release Train is not driven here: its gate reads the fixture's live origin,
 * so starting it would run a real release.
 */

import { expect, test } from "@playwright/test";

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

/** The worker processes for one family and the fixture repository. */
function processed(pattern: string) {
  const matches = processesMatching(pattern);
  return matches.filter((match) => !match.command.includes("pgrep"));
}
