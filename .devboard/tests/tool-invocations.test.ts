import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  recordToolInvocation,
  toolInvocationCounts,
  toolInvocationFile,
} from "../mcp/invocations";

const harnessRoot = resolve(import.meta.dir, "..");
const directories: string[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; stateDir: string; repoDir: string }> {
  await mkdir(join(harnessRoot, ".tmp"), { recursive: true });
  const root = await mkdtemp(join(harnessRoot, ".tmp", "invocations-"));
  directories.push(root);
  return { root, stateDir: join(root, "state"), repoDir: join(root, "checkout") };
}

test("counts every call per tool and keeps repositories that share a state directory apart", async () => {
  const { root, stateDir, repoDir } = await workspace();
  expect(toolInvocationCounts(stateDir, repoDir)).toEqual({});

  recordToolInvocation(stateDir, repoDir, "journal_search");
  recordToolInvocation(stateDir, repoDir, "journal_search");
  recordToolInvocation(stateDir, repoDir, "journal_search");
  recordToolInvocation(stateDir, repoDir, "devboard_status");
  recordToolInvocation(stateDir, repoDir, "");

  expect(toolInvocationCounts(stateDir, repoDir)).toEqual({
    journal_search: 3,
    devboard_status: 1,
  });

  const other = join(root, "other-checkout");
  recordToolInvocation(stateDir, other, "journal_search");
  expect(toolInvocationCounts(stateDir, other)).toEqual({ journal_search: 1 });
  expect(toolInvocationCounts(stateDir, repoDir)).toEqual({
    journal_search: 3,
    devboard_status: 1,
  });
});

test("a damaged counter file reports no counts instead of failing the tool panel", async () => {
  const { stateDir, repoDir } = await workspace();
  const path = toolInvocationFile(stateDir, repoDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "this is not a sqlite database");

  expect(toolInvocationCounts(stateDir, repoDir)).toEqual({});
});

test("peer processes increment one row atomically", async () => {
  const { stateDir, repoDir } = await workspace();
  const modulePath = join(harnessRoot, "mcp", "invocations.ts");
  const program =
    `import { recordToolInvocation } from ${JSON.stringify(modulePath)};\n` +
    `const stateDir = process.env.STATE_DIR_FOR_TEST ?? "";\n` +
    `const repoDir = process.env.REPO_DIR_FOR_TEST ?? "";\n` +
    `for (let index = 0; index < 40; index += 1) recordToolInvocation(stateDir, repoDir, "journal_search");\n`;
  const children = Array.from({ length: 4 }, () =>
    Bun.spawn({
      cmd: ["bun", "-e", program],
      cwd: harnessRoot,
      env: {
        ...process.env,
        STATE_DIR_FOR_TEST: stateDir,
        REPO_DIR_FOR_TEST: repoDir,
      },
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const exits = await Promise.all(children.map((child) => child.exited));
  const failures = exits.filter((code) => code !== 0);
  expect(failures).toEqual([]);
  expect(toolInvocationCounts(stateDir, repoDir)).toEqual({ journal_search: 160 });
});
