import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncHarnessTrees, syncTree } from "../bin/devboard.mjs";

/**
 * Wrapper and harness-tree sync protect every git-tracked host path,
 * including files nested below a directory the installed package does not
 * ship.
 */

const testRoot = join(resolve(import.meta.dir, ".."), ".tmp");
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ source: string; destination: string }> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "wrapper-sync-"));
  roots.push(root);
  return {
    source: join(root, "package", "commands"),
    destination: join(root, "host", ".omp", "commands"),
  };
}

describe("syncTree", () => {
  test("keeps a tracked file nested in a directory the package does not ship", async () => {
    const { source, destination } = await fixture();
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "shared.md"), "package\n");
    const tracked = join(destination, "custom", "deploy.md");
    await mkdir(join(destination, "custom"), { recursive: true });
    await writeFile(tracked, "tracked\n");

    await syncTree(source, destination, new Set([tracked]));

    expect(readFileSync(tracked, "utf8")).toBe("tracked\n");
    expect(existsSync(join(destination, "custom"))).toBe(true);
    expect(readFileSync(join(destination, "shared.md"), "utf8")).toBe("package\n");
  });

  test("still syncs a directory that holds a tracked file", async () => {
    const { source, destination } = await fixture();
    await mkdir(join(source, "custom"), { recursive: true });
    await writeFile(join(source, "custom", "shared.md"), "package\n");
    const tracked = join(destination, "custom", "deploy.md");
    await mkdir(join(destination, "custom"), { recursive: true });
    await writeFile(tracked, "tracked\n");
    await writeFile(join(destination, "custom", "stale.txt"), "stale\n");

    await syncTree(source, destination, new Set([tracked]));

    expect(readFileSync(tracked, "utf8")).toBe("tracked\n");
    expect(readFileSync(join(destination, "custom", "shared.md"), "utf8")).toBe("package\n");
    expect(existsSync(join(destination, "custom", "stale.txt"))).toBe(false);
  });
});

describe("syncHarnessTrees", () => {
  async function harnessFixture(): Promise<{ harness: string; host: string }> {
    await mkdir(testRoot, { recursive: true });
    const root = await mkdtemp(join(testRoot, "harness-sync-"));
    roots.push(root);
    return { harness: join(root, "package"), host: join(root, "host") };
  }

  test("keeps a tracked prompt and copies the prompts the package ships", async () => {
    const { harness, host } = await harnessFixture();
    const prompts = join(host, ".devboard", "prompts");
    await mkdir(join(harness, "prompts"), { recursive: true });
    await writeFile(join(harness, "prompts", "shipped.md"), "package\n");
    await writeFile(join(harness, "prompts", "added.md"), "added\n");
    await mkdir(prompts, { recursive: true });
    const trackedShipped = join(prompts, "shipped.md");
    const trackedLocal = join(prompts, "local.md");
    await writeFile(trackedShipped, "host\n");
    await writeFile(trackedLocal, "local\n");
    await writeFile(join(prompts, "stale.md"), "stale\n");

    await syncHarnessTrees(host, harness, new Set([trackedShipped, trackedLocal]));

    expect(readFileSync(trackedShipped, "utf8")).toBe("host\n");
    expect(readFileSync(trackedLocal, "utf8")).toBe("local\n");
    expect(readFileSync(join(prompts, "added.md"), "utf8")).toBe("added\n");
    expect(existsSync(join(prompts, "stale.md"))).toBe(false);
  });

  test("keeps a tracked single-file harness path", async () => {
    const { harness, host } = await harnessFixture();
    await mkdir(join(harness, "scripts"), { recursive: true });
    await writeFile(join(harness, "scripts", "forge-auth.ts"), "package\n");
    const tracked = join(host, ".devboard", "scripts", "forge-auth.ts");
    await mkdir(join(host, ".devboard", "scripts"), { recursive: true });
    await writeFile(tracked, "host\n");

    await syncHarnessTrees(host, harness, new Set([tracked]));

    expect(readFileSync(tracked, "utf8")).toBe("host\n");
  });
});
