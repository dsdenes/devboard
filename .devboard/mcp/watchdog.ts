import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { McpContext } from "./context";

/**
 * The watchdog deduplication disposition record. The dedup turn records each
 * decision here instead of answering with a coverage object; the coordinator
 * reads the records and treats any candidate without one as pending.
 *
 * `DEVBOARD_DEDUP_RUN_DIR` names the cycle's run directory. A call without it
 * is refused: a disposition must land in the cycle that asked for it.
 */

export const DEDUP_RECORD_FILE = "dedup-records.jsonl";

function inside(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local.length === 0 || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
}

export function dedupRunDirectory(context: McpContext): string | undefined {
  const configured = context.environment.DEVBOARD_DEDUP_RUN_DIR;
  if (typeof configured !== "string" || configured.length === 0) return undefined;
  const absolute = resolve(isAbsolute(configured) ? configured : resolve(context.repoDir, configured));
  let root: string;
  try {
    root = realpathSync(context.stateDir);
  } catch {
    return undefined;
  }
  let target = absolute;
  try {
    const parent = dirname(absolute);
    target = join(realpathSync(parent), absolute.slice(parent.length + 1));
  } catch {
    // The directory is created below; its lexical path is already checked.
  }
  return inside(root, target) ? target : undefined;
}

function dedupRecordPath(context: McpContext): string {
  const directory = dedupRunDirectory(context);
  if (directory === undefined) {
    throw new Error("DEVBOARD_DEDUP_RUN_DIR does not name a directory in the state root.");
  }
  mkdirSync(directory, { recursive: true });
  return join(directory, DEDUP_RECORD_FILE);
}

function appendDedupRecord(context: McpContext, value: Record<string, unknown>): void {
  appendFileSync(dedupRecordPath(context), `${JSON.stringify(value)}\n`);
}

/** Records the issue a dedup turn filed for one candidate. */
export function recordWatchdogFiling(
  context: McpContext,
  input: { fingerprint: string; number: number; url: string; title: string },
): void {
  appendDedupRecord(context, {
    fingerprint: input.fingerprint,
    action: "filed",
    number: input.number,
    url: input.url,
    title: input.title,
    at: new Date().toISOString(),
  });
}

/** Records how many open issues a dedup turn read. */
export function recordWatchdogRead(context: McpContext, count: number): void {
  const directory = dedupRunDirectory(context);
  if (directory === undefined) return;
  mkdirSync(directory, { recursive: true });
  appendFileSync(join(directory, "dedup-reads.jsonl"), `${JSON.stringify({ count })}\n`);
}

export function recordWatchdogDuplicate(
  context: McpContext,
  options: { fingerprint?: unknown; issue?: unknown; representative?: unknown },
) {
  const fingerprint = options.fingerprint;
  if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
    throw new Error("fingerprint must be a non-empty candidate fingerprint.");
  }
  const issue = options.issue;
  const representative = options.representative;
  if ((issue === undefined) === (representative === undefined)) {
    throw new Error("A duplicate names exactly one issue or one representative fingerprint.");
  }
  if (issue !== undefined && (typeof issue !== "string" || issue.trim().length === 0)) {
    throw new Error("issue must be an open issue URL.");
  }
  if (
    representative !== undefined &&
    (typeof representative !== "string" || representative.trim().length === 0)
  ) {
    throw new Error("representative must be a candidate fingerprint.");
  }
  appendDedupRecord(context, {
    fingerprint: fingerprint.trim(),
    action: "duplicate",
    ...(issue === undefined ? {} : { issue: issue.trim() }),
    ...(representative === undefined ? {} : { representative: representative.trim() }),
    at: new Date().toISOString(),
  });
  return {
    fingerprint: fingerprint.trim(),
    decision: "duplicate",
    ...(issue === undefined ? {} : { issue }),
    ...(representative === undefined ? {} : { representative }),
  };
}
