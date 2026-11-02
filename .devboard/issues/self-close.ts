import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoStateDirectory } from "./paths";

/**
 * A close an issues run made on its own issue. The tracker cannot say who
 * closed an issue, and a poll that drops a running issue's number looks the
 * same whether the operator closed it to cancel the run or the run closed it
 * as the last step of its work. The run's own close records itself here, so a
 * worker or dashboard can tell the finished run from a cancellation and let it
 * settle instead of stopping it. One record per issue: a later run's record
 * replaces an earlier run's, and a run only matches its own id.
 */

export const CLOSED_BY_RUN_DIRECTORY = "closed-by-run";

export function closedByRunDirectory(stateDir: string, repoDir: string): string {
  return join(repoStateDirectory(stateDir, repoDir), CLOSED_BY_RUN_DIRECTORY);
}

function recordPath(stateDir: string, repoDir: string, number: number): string {
  return join(closedByRunDirectory(stateDir, repoDir), `${number}.json`);
}

/** Records that `runId` closed issue `number`; written after the close lands. */
export function recordClosedByRun(
  stateDir: string,
  repoDir: string,
  number: number,
  runId: string,
): void {
  const directory = closedByRunDirectory(stateDir, repoDir);
  mkdirSync(directory, { recursive: true });
  const path = recordPath(stateDir, repoDir, number);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ runId })}\n`);
  renameSync(temporary, path);
}

/** The run that closed issue `number`, or null when no record survives. */
export function closedByRun(
  stateDir: string,
  repoDir: string,
  number: number,
): string | null {
  let text: string;
  try {
    text = readFileSync(recordPath(stateDir, repoDir, number), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || !("runId" in parsed)) return null;
    const runId = parsed.runId;
    return typeof runId === "string" && runId.length > 0 ? runId : null;
  } catch {
    // A half-written record is treated as absent.
    return null;
  }
}

/** Drops issue `number`'s record when it names `runId`. */
export function clearClosedByRun(
  stateDir: string,
  repoDir: string,
  number: number,
  runId: string,
): void {
  if (closedByRun(stateDir, repoDir, number) !== runId) return;
  try {
    rmSync(recordPath(stateDir, repoDir, number), { force: true });
  } catch {
    // A record left behind names a finished run and exempts nothing else.
  }
}
