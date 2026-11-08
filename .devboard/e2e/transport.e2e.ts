/**
 * The transport is REST, and the only WebSocket is a live run's own output.
 *
 * A page with no live run opens none across five polling intervals. Starting
 * one family opens exactly one socket whose URL names that run; every frame
 * carries that run's identity; stopping the run closes it.
 */

import { expect, test, type Page } from "@playwright/test";

import { openDashboard, startFamily, stopFamily } from "./dashboard.ts";
import { readState } from "./support.ts";

interface ObservedSocket {
  url: string;
  closed: boolean;
  runs: string[];
}

function observe(page: Page): ObservedSocket[] {
  const sockets: ObservedSocket[] = [];
  page.on("websocket", (socket) => {
    const url = socket.url();
    const observed: ObservedSocket = { url, closed: false, runs: [] };
    sockets.push(observed);
    socket.on("framereceived", (event) => {
      const text =
        typeof event.payload === "string"
          ? event.payload
          : Buffer.from(event.payload as Buffer).toString("utf8");
      try {
        const frame = JSON.parse(text) as Record<string, unknown>;
        if (typeof frame.run === "string") observed.runs.push(frame.run);
      } catch {
        // A binary or partial frame is not a run frame.
      }
    });
    socket.on("close", () => {
      observed.closed = true;
    });
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

test("one live family run opens one socket and stopping it closes it", async ({ page }) => {
  const sockets = observe(page);
  await openDashboard(page);
  await startFamily(page, "dead-code");
  await expect
    .poll(async () => sockets.filter((socket) => !socket.closed).length, { timeout: 60_000 })
    .toBe(1);
  const live = await liveRunIds(page);
  expect(live.length).toBe(1);
  const id = live[0];
  const socket = sockets.find((candidate) => !candidate.closed);
  expect(socket?.url).toContain(`/agent-runs/${id}/output`);
  await expect.poll(() => socket?.runs.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
  for (const run of socket?.runs ?? []) {
    expect(run).toBe(id);
  }

  await stopFamily(page, "dead-code");
  await expect
    .poll(() => sockets.every((candidate) => candidate.closed), { timeout: 30_000 })
    .toBe(true);
  await expect.poll(async () => (await liveRunIds(page)).length, { timeout: 30_000 }).toBe(0);
});
