import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultGoalPath, readGoal, writeGoal } from "./goal";

/**
 * Every fixture lives under the harness `.tmp`, so no test writes outside the
 * repository.
 */
const testRoot = join(import.meta.dir, "..", ".tmp", "goal-write-tests");
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "case-"));
  directories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("writeGoal", () => {
  test("replaces the goal verbatim and leaves no temporary file behind", async () => {
    const directory = await temporaryDirectory();
    const path = defaultGoalPath(directory);
    await writeFile(path, "# Original\n");
    const edited = "  Edited goal\n\nthird line";

    await writeGoal(path, edited);

    expect(await readGoal(path)).toBe(edited);
    expect(readdirSync(directory)).toEqual(["GOAL.md"]);
  });

  test("creates a missing goal directory", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested", "GOAL.md");

    await writeGoal(path, "# Created\n");

    expect(await readGoal(path)).toBe("# Created\n");
    expect(readdirSync(join(directory, "nested"))).toEqual(["GOAL.md"]);
  });

  test("a failed staged write leaves the previous goal intact and rejects", async () => {
    const directory = await temporaryDirectory();
    const path = defaultGoalPath(directory);
    const previous = "# Previous\n";
    await writeFile(path, previous);
    // A directory where the staged sibling goes fails the write the way a full
    // or read-only goal directory does, after the temporary path is chosen.
    const blocked = `${path}.${process.pid}.tmp`;
    await mkdir(blocked);

    try {
      await expect(writeGoal(path, "# Never written\n")).rejects.toThrow();
      expect(await readGoal(path)).toBe(previous);
    } finally {
      await rm(blocked, { recursive: true, force: true });
    }
  });

  test("a reader sees only the previous or the new complete goal during a save", async () => {
    const directory = await temporaryDirectory();
    const path = defaultGoalPath(directory);
    const previous = "# Previous\n";
    await writeFile(path, previous);
    const replacement = `# Replacement\n${"a line of the new goal\n".repeat(200_000)}`;
    let settled = false;
    const saving = writeGoal(path, replacement).finally(() => {
      settled = true;
    });

    const seen = new Set<string>();
    do {
      seen.add(await readFile(path, "utf8"));
    } while (!settled);
    await saving;

    for (const text of seen) {
      expect(text === previous || text === replacement).toBe(true);
    }
    expect(await readGoal(path)).toBe(replacement);
  });
});
