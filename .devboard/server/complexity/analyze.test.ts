import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeComplexity, utcDate } from "./analyze";

const temporaryRoot = join(import.meta.dir, "..", "..", ".tmp");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** The fixture that repeats one line in two files, so duplication is non-zero. */
const SHARED_LINE = "  const total = items.length + offset;";

async function fixture(): Promise<string> {
  const root = await temporaryDirectory("complexity-analyze-");
  const write = async (path: string, text: string): Promise<void> => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  };

  await write(
    "server/keep.ts",
    [
      "export function keep(items: string[], offset: number): number {",
      SHARED_LINE,
      "  if (total > 0) {",
      "    return total;",
      "  }",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
  );
  await write("server/keep.test.ts", "export function ignored(): void {}\n");
  await write("server/node_modules/pkg/index.ts", "export function dependency(): void {}\n");
  await write("server/dist/bundle.js", "export function built(): void {}\n");
  await write("server/.tmp/scratch.ts", "export function scratch(): void {}\n");
  await write(
    "client/Widget.svelte",
    [
      '<script lang="ts">',
      "  export function widget(a: number): number {",
      "    return a > 0 ? a : 0;",
      "  }",
      "</script>",
      "",
      "<p>widget</p>",
      "",
    ].join("\n"),
  );
  await write(
    "lib/util.mjs",
    ["export const identity = (value) => {", "  return value;", "};", ""].join("\n"),
  );
  await write(
    "scripts/tool.js",
    [
      "export function tool(items, offset) {",
      SHARED_LINE,
      "  return total;",
      "}",
      "",
    ].join("\n"),
  );
  await write("public/asset.js", "export function shipped(): void {}\n");
  return root;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("analyzeComplexity", () => {
  test("measures application source only, excluding tests and build output", async () => {
    const root = await fixture();

    const analysis = analyzeComplexity(root);

    expect(analysis.files.map((file) => file.path)).toEqual([
      ".devboard/client/Widget.svelte",
      ".devboard/lib/util.mjs",
      ".devboard/scripts/tool.js",
      ".devboard/server/keep.ts",
    ]);
    expect(analysis.functions.map((entry) => entry.name)).toEqual([
      "widget",
      "identity",
      "tool",
      "keep",
    ]);
    expect(analysis.project.files).toBe(4);
    expect(analysis.project.functions).toBe(4);
    expect(analysis.project.loc).toBe(
      analysis.files.reduce((total, file) => total + file.loc, 0),
    );
  });

  test("two analyses of the same tree are identical", async () => {
    const root = await fixture();

    expect(analyzeComplexity(root)).toEqual(analyzeComplexity(root));
  });

  test("the shared line counts as duplication in both files and in the project", async () => {
    const analysis = analyzeComplexity(await fixture());
    const measured = new Map(analysis.files.map((file) => [file.path, file]));

    expect(measured.get(".devboard/server/keep.ts")?.duplicatedLineRatio).toBeGreaterThan(0);
    expect(measured.get(".devboard/scripts/tool.js")?.duplicatedLineRatio).toBeGreaterThan(0);
    expect(analysis.project.duplicatedLineRatio).toBeGreaterThan(0);
  });

  test("per-function values aggregate into the project figures", async () => {
    const analysis = analyzeComplexity(await fixture());
    const complexity = analysis.functions.map((entry) => entry.cyclomatic);
    const mean = complexity.reduce((total, value) => total + value, 0) / complexity.length;

    expect(analysis.project.maxCyclomatic).toBe(Math.max(...complexity));
    expect(analysis.project.meanCyclomatic).toBe(Math.round(mean * 100) / 100);
    expect(analysis.project.functionsOverThreshold).toBe(
      complexity.filter((value) => value > 10).length,
    );
    expect(analysis.project.meanMaintainability).toBeGreaterThanOrEqual(0);
    expect(analysis.project.meanMaintainability).toBeLessThanOrEqual(100);
    for (const file of analysis.files) {
      expect(file.maintainability).toBeGreaterThanOrEqual(0);
      expect(file.maintainability).toBeLessThanOrEqual(100);
    }
  });

  test("a file's named functions carry its own path", async () => {
    const analysis = analyzeComplexity(await fixture());

    expect(analysis.functions.map((entry) => entry.path)).toContain(".devboard/server/keep.ts");
    expect(analysis.functions.every((entry) => entry.path.startsWith(".devboard/"))).toBe(true);
  });
});

test("utcDate reads the UTC calendar day, never the local one", () => {
  expect(utcDate(new Date("2026-11-01T23:59:59.999Z"))).toBe("2026-11-01");
  expect(utcDate(new Date("2026-11-02T00:00:00.000Z"))).toBe("2026-11-02");
});
