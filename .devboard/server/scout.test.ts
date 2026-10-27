import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityDelta } from "./activity";
import { preflightScout, scoutCommandPaths, stateInsideRepository } from "../issues/scout/preflight";
import { MAX_STAGED, requestPath, scansDirectory } from "../issues/scout/paths";
import {
  normalizeTitle,
  parseScanResult,
  recommendationId,
} from "../issues/scout/recommendation";
import {
  buildRequest,
  createScanDirectory,
  promptFor,
  readDraftGoalHeadings,
  writeRequest,
} from "../issues/scout/scan";
import {
  createdDirectories,
  makeRepository,
  recommendation,
  scanDocument,
  sourceFiles,
  temporaryDirectory,
  type DraftRecommendation,
} from "../tests/fixtures/scout-helpers";

const findings = 12;

afterAll(async () => {
  await Promise.all(
    createdDirectories().map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function repository(): Promise<string> {
  const root = await makeRepository({ files: sourceFiles(findings), origin: "acme/fixture" });
  const home = await temporaryDirectory("scout-home");
  await mkdir(join(home, ".omp", "commands"), { recursive: true });
  await writeFile(
    join(home, ".omp", "commands", "scout-recommendations.md"),
    "# scout recommendations\n",
  );
  return root;
}

function items(count: number): DraftRecommendation[] {
  return Array.from({ length: count }, (_value, index) => recommendation(index + 1));
}

describe("recommendation identity", () => {
  test("the same finding keeps its id and a different category does not", () => {
    const id = recommendationId("clarity", ["src/b.ts", "src/a.ts"], "  A  Title ");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(recommendationId("clarity", ["src/a.ts", "src/b.ts"], "a title")).toBe(id);
    expect(recommendationId("structure", ["src/a.ts", "src/b.ts"], "a title")).not.toBe(id);
    expect(normalizeTitle("  A  Title ")).toBe("a title");
  });
});

describe("scan result validation", () => {
  test("accepts at most the requested count and derives ids", async () => {
    const root = await repository();
    const result = parseScanResult(scanDocument(items(3)), { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(3);
    expect(result.items[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(result.shortfall).toBeNull();
  });

  test("refuses more recommendations than requested and keeps the board unchanged", async () => {
    const root = await repository();
    const result = parseScanResult(scanDocument(items(10)), { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("10 recommendations");
    expect(result.error).toContain(`${MAX_STAGED} requested`);
  });

  test("a malformed item names itself", async () => {
    const root = await repository();
    const document = scanDocument(items(2));
    const first = (document.recommendations as Record<string, unknown>[])[0]!;
    delete first.category;
    const result = parseScanResult(document, { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('item 1 ("Simplify module 1 control flow")');
    expect(result.error).toContain("category");
  });

  test("a title that spans more than one line is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.title = "One line\nand another";
    const result = parseScanResult(document, { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("more than one line");
  });

  test("a path that escapes the repository is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.evidence = [
      { path: "../outside.ts", lines: "1" },
    ];
    const result = parseScanResult(document, { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("escapes the repository");
  });

  test("a path under node_modules is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.evidence = [
      { path: "node_modules/pkg/index.js", lines: "1" },
    ];
    const result = parseScanResult(document, { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("excluded tree");
  });

  test("a duplicate id inside one result is refused", async () => {
    const root = await repository();
    const first = recommendation(1);
    const document = scanDocument([first, { ...first }]);
    const result = parseScanResult(document, { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("repeats the id of item 1");
    expect(result.error).toContain(recommendationId("clarity", ["src/module-1.ts"], first.title));
  });

  test("an out-of-range line span is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.evidence = [
      { path: "src/module-1.ts", lines: "18-999" },
    ];
    const result = parseScanResult(document, { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("outside the file's 20 line(s)");
  });

  test("a file list entry the evidence does not cite is refused", async () => {
    const root = await repository();
    const document = scanDocument([recommendation(1)]);
    (document.recommendations as Record<string, unknown>[])[0]!.files = ["src/module-2.ts"];
    const result = parseScanResult(document, { missing: MAX_STAGED, repoDir: root });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("which its evidence does not cite");
  });

  test("a non-empty shortfall is preserved and an empty one is dropped", async () => {
    const root = await repository();
    const withReason = parseScanResult(scanDocument(items(1), "Only one real gap."), {
      missing: MAX_STAGED,
      repoDir: root,
    });
    expect(withReason.ok && withReason.shortfall).toBe("Only one real gap.");
    const empty = parseScanResult(scanDocument(items(1), "   "), {
      missing: MAX_STAGED,
      repoDir: root,
    });
    expect(empty.ok && empty.shortfall).toBeNull();
  });
});

describe("scan request", () => {
  test("carries the missing count, excluded roots, staged items, and headings", async () => {
    const root = await repository();
    await mkdir(join(root, ".devboard", "goal-proposals"), { recursive: true });
    await writeFile(
      join(root, ".devboard", "goal-proposals", "one.md"),
      "# Proposed goal: Merge the two trackers\n\n> draft\n",
    );
    const scan = createScanDirectory(root, new Date("2026-10-27T10:00:00Z"));
    expect(scan.directory.startsWith(scansDirectory(root))).toBe(true);
    const staged = parseScanResult(scanDocument(items(2)), {
      missing: MAX_STAGED,
      repoDir: root,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const request = buildRequest({
      scan,
      repository: "acme/fixture",
      repoDir: root,
      missing: 7,
      staged: staged.items.map((item) => ({ ...item, stagedAt: "2026-10-27T10:00:00Z" })),
      openIssueTitles: ["Open issue"],
      draftGoalHeadings: readDraftGoalHeadings(root),
    });
    expect(request.missing).toBe(7);
    expect(request.repository).toBe("acme/fixture");
    expect(request.repositoryPath).toBe(root);
    expect(request.excludedRoots).toContain("node_modules");
    expect(request.categories).toContain("correctness");
    expect(request.staged.map((item) => item.title)).toEqual([
      "Simplify module 1 control flow",
      "Simplify module 2 control flow",
    ]);
    expect(request.draftGoalHeadings).toEqual(["Proposed goal: Merge the two trackers"]);
    writeRequest(scan.directory, request);
    const written = JSON.parse(readFileSync(requestPath(scan.directory), "utf8"));
    expect(written.openIssueTitles).toEqual(["Open issue"]);
    expect(promptFor(scan.directory)).toBe(`/scout-recommendations ${scan.directory}`);
  });
});

describe("preflight", () => {
  /**
   * A PATH that always carries the two tools preflight looks up, so the test
   * exercises the fact it names rather than the host's installed binaries.
   */
  async function pathWithTools(): Promise<string> {
    const bin = await temporaryDirectory("scout-bin");
    await writeFile(join(bin, "omp"), "");
    await writeFile(join(bin, "gh"), "");
    return bin;
  }

  test("a state directory outside the repository is refused by name", async () => {
    const root = await repository();
    const outside = await temporaryDirectory("scout-state");
    expect(stateInsideRepository(root, outside)).toBe(false);
    const result = await preflightScout({
      repoDir: root,
      stateDir: outside,
      environment: { PATH: await pathWithTools(), HOME: outside },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("STATE_DIR");
    expect(result.message).toContain("is not inside REPO_DIR");
  });

  test("a missing scan command is named with the paths it looked in", async () => {
    const root = await repository();
    const home = await temporaryDirectory("scout-home");
    const environment = { PATH: await pathWithTools(), HOME: home };
    const result = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("/scout-recommendations command is not installed");
    expect(result.message).toContain(scoutCommandPaths(root, environment)[0]!);
  });

  test("a checkout with no GitHub origin is refused", async () => {
    const root = await makeRepository({ files: sourceFiles(1), origin: null });
    const result = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment: { PATH: await pathWithTools(), HOME: root },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("origin does not name a GitHub repository");
  });

  test("a write permission is required, and a granted one passes", async () => {
    const root = await repository();
    const home = await temporaryDirectory("scout-home");
    await mkdir(join(home, ".omp", "commands"), { recursive: true });
    await writeFile(join(home, ".omp", "commands", "scout-recommendations.md"), "# command\n");
    const environment = { PATH: await pathWithTools(), HOME: home };
    const deny = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment,
      run: async () => ({ code: 0, stdout: "false", stderr: "" }),
    });
    expect(deny.ok).toBe(false);
    if (!deny.ok) expect(deny.message).toContain("did not return true");
    const allow = await preflightScout({
      repoDir: root,
      stateDir: join(root, ".devboard", ".tmp", "state"),
      environment,
      run: async () => ({ code: 0, stdout: "true", stderr: "" }),
    });
    expect(allow).toEqual({ ok: true, repository: "acme/fixture" });
  });
});

describe("activity delta", () => {
  test("appends growth, continues a streamed chunk, and replays a trim", () => {
    expect(activityDelta([], ["a"])).toEqual({
      replay: true,
      entries: [{ text: "a", append: false }],
    });
    expect(activityDelta(["a"], ["a", "b"])).toEqual({
      replay: false,
      entries: [{ text: "b", append: false }],
    });
    expect(activityDelta(["x", "ab"], ["x", "abcd"])).toEqual({
      replay: false,
      entries: [{ text: "cd", append: true }],
    });
    expect(activityDelta(["a", "b"], ["b"])).toEqual({
      replay: true,
      entries: [{ text: "b", append: false }],
    });
    expect(activityDelta(["a"], ["a"])).toEqual({ replay: false, entries: [] });
  });
});
