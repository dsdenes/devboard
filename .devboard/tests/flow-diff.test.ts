import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  diffFiles,
  diffHash,
  splitDiffFiles,
  type FlowFile,
} from "../server/flow";

/**
 * A real git repository proves the header shapes git actually emits for a
 * non-ASCII path and for a path holding a double quote. Fixtures stay under
 * the harness's own `.tmp`.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryRepository(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "test-flow-diff-"));
  temporaryDirectories.push(directory);
  git(directory, "init", "-q");
  git(directory, "config", "user.email", "test@example.invalid");
  git(directory, "config", "user.name", "Test");
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function commit(directory: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(directory, path), content);
  }
  git(directory, "add", "-A");
  git(directory, "commit", "-qm", "commit");
}

function diff(directory: string, ...paths: string[]): string {
  return git(directory, "-c", "core.quotePath=true", "diff", "--no-color", "HEAD", "--", ...paths);
}

function fileOf(files: FlowFile[], path: string): FlowFile {
  const file = files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`missing ${path} in ${files.map((f) => f.path).join(", ")}`);
  return file;
}

describe("git diff paths", () => {
  test("splits quoted headers into their own chunks", () => {
    const text = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      "@@ -1 +1,2 @@",
      " one",
      "+two",
      'diff --git "a/quote\\"name.txt" "b/quote\\"name.txt"',
      '--- "a/quote\\"name.txt"',
      '+++ "b/quote\\"name.txt"',
      "@@ -1 +1,2 @@",
      " alpha",
      "+beta",
    ].join("\n");
    const chunks = splitDiffFiles(text);
    expect([...chunks.keys()]).toEqual(["café.txt", 'quote"name.txt']);
    expect(chunks.get('quote"name.txt')).not.toContain("café");
    expect(chunks.get('quote"name.txt')).toContain("+beta");
  });

  test("keeps a quoted file's chunk out of its predecessor and out of diffHash", async () => {
    const repository = await temporaryRepository();
    commit(repository, {
      "café.txt": "one\n",
      'quote"name.txt': "two\n",
      "plain.txt": "three\n",
    });
    writeFileSync(join(repository, "café.txt"), "one\nmore\n");
    writeFileSync(join(repository, 'quote"name.txt'), "two\nmore\n");
    writeFileSync(join(repository, "plain.txt"), "three\nmore\n");

    const tracked = diff(repository);
    expect(tracked).toContain('diff --git "a/caf\\303\\251.txt"');
    const files = diffFiles(tracked);
    expect(files.map((file) => file.path).sort()).toEqual([
      "café.txt",
      "plain.txt",
      'quote"name.txt',
    ].sort());

    for (const path of ["café.txt", 'quote"name.txt', "plain.txt"]) {
      const file = fileOf(files, path);
      expect(file.insertions).toBe(1);
      expect(file.deletions).toBe(0);
      expect(file.diff.startsWith("diff --git ")).toBe(true);
      expect(file.diff).not.toContain("diff --git a/caf");
    }

    const plainOnly = diffFiles(diff(repository, "plain.txt"));
    expect(fileOf(plainOnly, "plain.txt").diff).toBe(fileOf(files, "plain.txt").diff);
    expect([...splitDiffFiles(tracked).keys()].every((path) => files.some((f) => f.path === path))).toBe(
      true,
    );

    const baseline = diffHash(files);
    expect(baseline).toBe(diffHash(diffFiles(tracked)));

    writeFileSync(join(repository, "café.txt"), "one\nmore\nagain\n");
    const changed = diffFiles(diff(repository));
    expect(diffHash(changed)).not.toBe(baseline);
    expect(fileOf(changed, "café.txt").insertions).toBe(2);
    expect(fileOf(changed, "plain.txt").diff).toBe(fileOf(files, "plain.txt").diff);
  });
});
