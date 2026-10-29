import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "./state";

const GOAL_FILE_NAME = "GOAL.md";

export function defaultGoalPath(repoDir: string): string {
  return join(repoDir, GOAL_FILE_NAME);
}

export function readGoal(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/**
 * Replaces the goal document wholesale. The submitted text is written
 * verbatim: no trimming, newline insertion, or other normalization. The text
 * is staged beside the destination and renamed into place, so a failed or
 * interrupted save leaves the previous complete goal readable and a concurrent
 * reader never observes a partial document.
 */
export function writeGoal(path: string, text: string): Promise<void> {
  return writeFileAtomically(path, text);
}
