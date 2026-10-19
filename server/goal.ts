import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GOAL_FILE_NAME = "GOAL.md";

export function defaultGoalPath(repoDir: string): string {
  return join(repoDir, GOAL_FILE_NAME);
}

export function readGoal(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * Replaces the goal document wholesale. The submitted text is written
 * verbatim: no trimming, newline insertion, or other normalization.
 */
export function writeGoal(path: string, text: string): Promise<void> {
  return writeFile(path, text, "utf8");
}
