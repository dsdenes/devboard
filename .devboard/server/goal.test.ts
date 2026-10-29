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

  test("overlapping saves both resolve and publish one complete goal", async () => {
    const directory = await temporaryDirectory();
    const path = defaultGoalPath(directory);
    await writeFile(path, "# Original\n");
    const first = `# First\n${"first writer's line\n".repeat(50_000)}`;
    const second = `# Second\n${"second writer's line\n".repeat(50_000)}`;

    await Promise.all([writeGoal(path, first), writeGoal(path, second)]);

    expect([first, second]).toContain(await readGoal(path));
    // Both writers staged beside the destination; neither left its sibling
    // behind after the rename published the winner.
    expect(readdirSync(directory)).toEqual(["GOAL.md"]);
  });

  test("a failed rename removes only its own staging file", async () => {
    const directory = await temporaryDirectory();
    // Renaming a file over a directory fails after the text is staged.
    const blocked = join(directory, "blocked-goal");
    await mkdir(blocked);
    // Another writer's staging file, as an in-flight save would leave it.
    const foreignName = `GOAL.md.${process.pid}.0.tmp`;
    const foreign = join(directory, foreignName);
    const foreignText = "another writer's staging file\n";
    await writeFile(foreign, foreignText);

    await expect(writeGoal(blocked, "# Never published\n")).rejects.toThrow();

    expect(readdirSync(directory).sort()).toEqual(["blocked-goal", foreignName].sort());
    expect(await readFile(foreign, "utf8")).toBe(foreignText);
  });

  test("a failed save leaves a concurrent successful save's goal intact", async () => {
    const directory = await temporaryDirectory();
    const blocked = join(directory, "blocked");
    await mkdir(blocked);
    const path = defaultGoalPath(directory);
    const surviving = "# Surviving goal\n";

    const [failed, succeeded] = await Promise.allSettled([
      writeGoal(blocked, "# Never published\n"),
      writeGoal(path, surviving),
    ]);

    expect(failed.status).toBe("rejected");
    expect(succeeded.status).toBe("fulfilled");
    expect(await readGoal(path)).toBe(surviving);
    expect(readdirSync(directory).sort()).toEqual(["GOAL.md", "blocked"]);
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
