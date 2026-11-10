/**
 * The transport is REST: the page opens no WebSocket at all.
 *
 * A page with no live run opens none across five polling intervals, and a page
 * with one live family run opens none either. The run's activity reaches the
 * page as `issuesActivity` frames on the connection's own reads, and
 * `GET /agent-runs` stays a REST read no page polls.
 */

import { expect, test, type Page } from "@playwright/test";

import { openDashboard, startFamily, stopFamily } from "./dashboard.ts";
import { readState } from "./support.ts";

interface ObservedSocket {
  url: string;
}

function observe(page: Page): ObservedSocket[] {
  const sockets: ObservedSocket[] = [];
  page.on("websocket", (socket) => {
    sockets.push({ url: socket.url() });
  });
  return sockets;
}

async function liveRunIds(page: Page): Promise<string[]> {
  const state = readState();
  const response = await page.request.get(`${state.baseUrl}/agent-runs`);
  const body = (await response.json()) as {
    runs?: Array<{ id?: unknown; live?: unknown }>;
  };
  return (body.runs ?? [])
    .filter((run) => run.live === true && typeof run.id === "string")
    .map((run) => run.id as string);
}

test("a page with no live run opens no WebSocket", async ({ page }) => {
  const sockets = observe(page);
  await openDashboard(page);
  await expect.poll(async () => (await liveRunIds(page)).length, { timeout: 20_000 }).toBe(0);
  // Five polling intervals with no live run.
  await page.waitForTimeout(5_500);
  expect(sockets).toEqual([]);
});

test("a live family run opens no WebSocket", async ({ page }) => {
  const sockets = observe(page);
  await openDashboard(page);
  await startFamily(page, "dead-code");
  await expect.poll(async () => (await liveRunIds(page)).length, { timeout: 60_000 }).toBe(1);
  // Five polling intervals with one live run.
  await page.waitForTimeout(5_500);
  expect(sockets).toEqual([]);

  await stopFamily(page, "dead-code");
  await expect.poll(async () => (await liveRunIds(page)).length, { timeout: 30_000 }).toBe(0);
});
