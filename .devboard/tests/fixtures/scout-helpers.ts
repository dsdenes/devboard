import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../../scripts/verification";
import type { ScoutCategory } from "../../issues/scout/paths";

/**
 * Fixtures shared by the Auto Scout tests. Every directory lives under
 * `.devboard/.tmp`; nothing contacts GitHub, starts a real agent, or writes
 * outside the repository.
 */

export const harnessRoot = join(import.meta.dir, "..", "..");
export const testRoot = join(harnessRoot, ".tmp");

const created: string[] = [];

export function createdDirectories(): string[] {
  return created;
}

export async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${prefix}-`));
  created.push(directory);
  return directory;
}

/** A checkout with the supplied files, committed, and a GitHub origin. */
export async function makeRepository(options: {
  files: Record<string, string>;
  origin?: string | null;
}): Promise<string> {
  const directory = await temporaryDirectory("scout-repo");
  await mkdir(join(directory, ".devboard"), { recursive: true });
  for (const [path, content] of Object.entries(options.files)) {
    const target = join(directory, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  const git = (args: string[]): void => {
    const result = run("git", ["-C", directory, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "devboard@example.test"]);
  git(["config", "user.name", "Devboard Verify"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  if (options.origin !== null && options.origin !== undefined) {
    git(["remote", "add", "origin", `https://github.com/${options.origin}.git`]);
  }
  return directory;
}

/** A source tree with `count` file/line pairs a recommendation can cite. */
export function sourceFiles(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 1; index <= count; index += 1) {
    files[`src/module-${index}.ts`] = Array.from(
      { length: 20 },
      (_value, line) => `export const value${index}_${line + 1} = ${line + 1};`,
    ).join("\n");
  }
  return files;
}

export interface DraftRecommendation {
  category: ScoutCategory;
  title: string;
  summary: string;
  impact: string;
  significance: number;
  significanceReason: string;
  evidence: Array<{ path: string; lines: string; quote?: string }>;
  proposedChange: string;
  files: string[];
  acceptanceCriteria: string[];
}

/** One valid recommendation over `src/module-<index>.ts`. */
export function recommendation(index: number): DraftRecommendation {
  return {
    category: "clarity",
    title: `Simplify module ${index} control flow`,
    summary: `Module ${index} nests its branches until the intent is hidden.`,
    impact: "A flatter unit is cheaper to change and to test.",
    significance: 5,
    significanceReason:
      `Module ${index} reaches its third nested branch on every call, so an ` +
      "inverted condition silently skips the second half of the file.",
    evidence: [{ path: `src/module-${index}.ts`, lines: "2-6", quote: "export const" }],
    proposedChange: `Extract the branches of module ${index} into named steps.`,
    files: [`src/module-${index}.ts`],
    acceptanceCriteria: [`Module ${index} has no nested branch deeper than two levels.`],
  };
}

/** A complete recommendations.json document. */
export function scanDocument(
  items: DraftRecommendation[],
  shortfall?: string,
): Record<string, unknown> {
  return {
    recommendations: items,
    ...(shortfall === undefined ? {} : { shortfall }),
  };
}
