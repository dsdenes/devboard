import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GOAL_PROPOSALS_DIRECTORY } from "./goal-proposals";

/**
 * The `# heading` of every draft under `<REPO_DIR>/.devboard/goal-proposals/`.
 * A crawling agent skips a finding whose normalized title equals one of these
 * headings, exactly as it skips an existing issue.
 */
export function readDraftGoalHeadings(repoDir: string): string[] {
  const directory = join(resolve(repoDir), GOAL_PROPOSALS_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const headings: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(directory, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.startsWith("# ")) headings.push(trimmed.slice(2).trim());
      break;
    }
  }
  return headings;
}
