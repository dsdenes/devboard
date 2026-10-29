import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncTree } from "../bin/devboard.mjs";

/**
 * Wrapper sync protects every git-tracked host path, including files nested
 * below a directory the installed package does not ship.
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
