/**
 * The per-repository delivery switch on the real surface.
 *
 * One built dashboard is started against a host fixture — a checkout with no
 * harness source manifest — so the group is enabled. The spec proves the DOM
 * order above Background agents, both labels, the selected state, the save,
 * its survival across a reload, and the switch back to merge. A harness source
 * checkout is covered by the client suite; this spec is the host surface the
 * operator uses.
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

test("the delivery switch is above Background agents and survives a reload", async ({ page }) => {
  const { child, baseUrl } = await startHost();
  try {
    await open(page, baseUrl);
    const group = page.locator('[data-testid="sidebar-delivery-mode"]');
    await expect(group).toBeVisible();
    await expect(group.locator(".sidebar-group__title")).toHaveText("Delivery mode");
    await expect(
      group.locator('[data-testid="delivery-mode-merge"]'),
    ).toContainText("Merge to main");
    await expect(
      group.locator('[data-testid="delivery-mode-pull-request"]'),
    ).toContainText("Open pull request");
    await expect(group.locator('[data-testid="delivery-mode-merge"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const order = await page.evaluate(() => {
      const groups = [...document.querySelectorAll(".sidebar-group")];
      return groups.map((entry) => entry.getAttribute("aria-label"));
    });
    const index = order.indexOf("Delivery mode");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(order[index + 1]).toBe("Background agents");

    await group.locator('[data-testid="delivery-mode-pull-request"]').click();
    await expect.poll(() => serverMode(baseUrl), { timeout: 20_000 }).toBe("pull-request");
    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid="delivery-mode-pull-request"]'),
    ).toHaveAttribute("aria-checked", "true");
    expect(await serverMode(baseUrl)).toBe("pull-request");

    await page.locator('[data-testid="delivery-mode-merge"]').click();
    await expect.poll(() => serverMode(baseUrl), { timeout: 20_000 }).toBe("merge");
    await page.reload();
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="delivery-mode-merge"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await serverMode(baseUrl)).toBe("merge");
  } finally {
    child.kill("SIGTERM");
    const { promise, resolve } = Promise.withResolvers<void>();
    child.once("exit", resolve);
    await promise;
    rmSync(HOST_ROOT, { recursive: true, force: true });
  }
});
