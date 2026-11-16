/**
 * The Delivery mode switch on the real surface.
 *
 * One built dashboard is started against a host fixture — a checkout with no
 * harness source manifest — so the group is enabled. The spec proves the group
 * order above Background agents, the single switch row, both flips (pointer to
 * pull request and keyboard back to merge), the computed track and thumb states
 * for each mode, the un-clipped label at a 1024×720 viewport with the default
 * 300px sidebar, both transient save notes, the server's persisted mode after
 * each save, and that each mode survives a reload. The disabled harness-source
 * checkout is covered by the client suite.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { binary, harnessDir, scratchRoot, staticDir } from "./support.ts";

const HOST_ROOT = path.join(scratchRoot, "delivery-host");

async function freePort(): Promise<number> {
  const server = net.createServer();
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => {
      if (address === null || typeof address === "string") {
        reject(new Error("no free port"));
      } else {
        resolve(address.port);
      }
    });
  });
  return promise;
}

async function waitForReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/ready`, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // The server has not bound yet.
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 100);
    await promise;
  }
  throw new Error(`the fixture dashboard at ${baseUrl} never became ready`);
}

/** One dashboard over a host fixture; the harness manifest is absent. */
async function startHost(): Promise<{ child: ChildProcess; baseUrl: string }> {
  rmSync(HOST_ROOT, { recursive: true, force: true });
  const repo = path.join(HOST_ROOT, "repo");
  const state = path.join(HOST_ROOT, "state");
  const adrs = path.join(repo, "adrs");
  mkdirSync(adrs, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(repo, "GOAL.md"), "# Host goal\n\nA fixture.\n");
  writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  const port = await freePort();
  const child = spawn(
    binary,
    [
      "serve",
      "--port",
      String(port),
      "--repo-dir",
      repo,
      "--state-dir",
      state,
      "--adrs-dir",
      adrs,
      "--static-dir",
      staticDir,
    ],
    {
      cwd: harnessDir,
      env: { ...process.env, HOST: "127.0.0.1", DEVBOARD_ALLOWED_HOSTS: "127.0.0.1,localhost" },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.on("data", () => {});
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForReady(baseUrl);
  return { child, baseUrl };
}

async function open(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/`);
  await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="mode-devboard"]').click();
}

async function serverMode(baseUrl: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/project`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const body = (await response.json()) as {
    frames?: Array<Record<string, unknown>>;
    deliveryMode?: unknown;
  };
  if (Array.isArray(body.frames)) {
    return body.frames.find((frame) => frame.type === "project")?.deliveryMode;
  }
  return body.deliveryMode;
}

function toggle(page: Page) {
  return page.locator('[data-testid="delivery-mode-toggle"]');
}

function feedback(page: Page) {
  return page.locator('[data-testid="save-feedback"][data-scope="delivery.mode"]');
}

/** The switch's rendered state: the track's fill and the thumb's offset. */
async function switchStyle(page: Page): Promise<{ track: string; thumbLeft: string }> {
  return page.evaluate(() => {
    const track = document.querySelector('[data-testid="delivery-mode-track"]');
    const thumb = document.querySelector('[data-testid="delivery-mode-thumb"]');
    if (track === null || thumb === null) throw new Error("the switch has no track or thumb");
    return {
      track: getComputedStyle(track).backgroundColor,
      thumbLeft: getComputedStyle(thumb).left,
    };
  });
}

/** The label is fully visible: no ellipsis at the sidebar's default width. */
async function expectLabelUnclipped(page: Page): Promise<void> {
  const metrics = await page.locator('[data-testid="delivery-mode-label"]').evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(metrics.clientWidth).toBeGreaterThan(0);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

test("the Delivery mode switch flips both ways and persists", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 });
  const { child, baseUrl } = await startHost();
  try {
    await open(page, baseUrl);
    const group = page.locator('[data-testid="sidebar-delivery-mode"]');
    await expect(group).toBeVisible();
    await expect(group.locator(".sidebar-group__title")).toHaveText("Delivery mode");

    // One control, no per-mode rows.
    await expect(toggle(page)).toHaveCount(1);
    await expect(page.locator('[data-testid="delivery-mode-merge"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="delivery-mode-pull-request"]')).toHaveCount(0);

    const order = await page.evaluate(() =>
      [...document.querySelectorAll(".sidebar-group")].map((entry) =>
        entry.getAttribute("aria-label"),
      ),
    );
    const index = order.indexOf("Delivery mode");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(order[index + 1]).toBe("Background agents");

    const control = toggle(page);
    await expect(control).toHaveAttribute("role", "switch");
    await expect(control).toHaveAttribute("aria-checked", "false");
    await expect(control).toHaveAttribute("data-mode", "merge");
    await expect(control).toHaveAccessibleName("Merge to main");
    await expect(control).toHaveAttribute("title", "Switch to Open pull request");
    await expect(control.locator('[data-testid="delivery-mode-track"]')).toHaveCount(1);
    await expect(control.locator('[data-testid="delivery-mode-thumb"]')).toHaveCount(1);
    await expect(feedback(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="delivery-mode-saving"]')).toHaveCount(0);
    await expectLabelUnclipped(page);
    const mergeStyle = await switchStyle(page);

    // Pointer flip to pull request, confirmed by the server and the note.
    await control.click();
    await expect(control).toHaveAttribute("data-mode", "pull-request");
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect(control).toHaveAccessibleName("Open pull request");
    await expect(control).toHaveAttribute("title", "Switch to Merge to main");
    const saved = feedback(page);
    await expect(saved).toBeVisible();
    await expect(saved).toHaveAttribute("role", "status");
    await expect(saved).toHaveAttribute("aria-live", "polite");
    await expect(saved.locator(".save-feedback__icon svg")).toHaveCount(1);
    await expect(saved).toHaveText("Delivery mode saved: Open pull request.");
    await expectLabelUnclipped(page);
    await expect.poll(() => serverMode(baseUrl), { timeout: 20_000 }).toBe("pull-request");

    // The rendered state changed, not only the typed one.
    await page.waitForTimeout(200);
    const pullStyle = await switchStyle(page);
    expect(pullStyle.track).not.toBe(mergeStyle.track);
    expect(pullStyle.thumbLeft).not.toBe(mergeStyle.thumbLeft);

    await expect(saved).toBeHidden({ timeout: 5_000 });

    // Pull request survives a reload, with no stale confirmation.
    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="mode-devboard"]').click();
    const reloaded = toggle(page);
    await expect(reloaded).toHaveAttribute("data-mode", "pull-request");
    await expect(reloaded).toHaveAttribute("aria-checked", "true");
    await expect(reloaded).toHaveAccessibleName("Open pull request");
    await expect(page.locator('[data-testid="save-feedback"]')).toHaveCount(0);
    expect(await serverMode(baseUrl)).toBe("pull-request");

    // Keyboard flip back to merge.
    await reloaded.focus();
    await page.keyboard.press("Enter");
    await expect(reloaded).toHaveAttribute("data-mode", "merge");
    await expect(reloaded).toHaveAttribute("aria-checked", "false");
    await expect(reloaded).toHaveAccessibleName("Merge to main");
    const back = feedback(page);
    await expect(back).toBeVisible();
    await expect(back).toHaveText("Delivery mode saved: Merge to main.");
    await expect.poll(() => serverMode(baseUrl), { timeout: 20_000 }).toBe("merge");
    await expect(back).toBeHidden({ timeout: 5_000 });

    // Merge survives a reload too.
    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="mode-devboard"]').click();
    await expect(toggle(page)).toHaveAttribute("data-mode", "merge");
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    expect(await serverMode(baseUrl)).toBe("merge");
  } finally {
    child.kill("SIGTERM");
    const { promise, resolve } = Promise.withResolvers<void>();
    child.once("exit", resolve);
    await promise;
    rmSync(HOST_ROOT, { recursive: true, force: true });
  }
});
