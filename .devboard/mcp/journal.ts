import { journalFile, JOURNAL_KINDS } from "../server/journal";
import { readJournalEvidence } from "../watchdog/collect";
import type { Instance } from "../watchdog/discovery";
import type { McpContext } from "./context";

/**
 * The dashboard journal read tool. It uses the watchdog's journal reader, so a
 * record present in both a rotated file and the live one is counted once, and
 * it never writes.
 */

export interface JournalRow {
  ts: string;
  kind: string;
  text: string;
  scope: string | null;
}

export interface JournalPage {
  records: JournalRow[];
  total: number;
  truncated: boolean;
}

export const JOURNAL_SEARCH_MAX_RECORDS = 200;
export const JOURNAL_SEARCH_MAX_BYTES = 64 * 1024;

function instance(context: McpContext): Instance {
  return {
    pid: 0,
    port: 0,
    repoDir: context.repoDir,
    host: "127.0.0.1",
    harness: context.harnessDir,
    stateDir: context.stateDir,
    journal: journalFile(context.stateDir, context.repoDir),
    instrumented: true,
  };
}

function instant(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`);
  }
  return Date.parse(value);
}

export function searchJournal(
  context: McpContext,
  options: {
    kind?: unknown;
    scope?: unknown;
    since?: unknown;
    until?: unknown;
    query?: unknown;
    limit?: unknown;
  },
): JournalPage {
  const since = instant(options.since, "since");
  const until = instant(options.until, "until");
  const kind = options.kind;
  if (
    kind !== undefined &&
    (typeof kind !== "string" || !(JOURNAL_KINDS as readonly string[]).includes(kind))
  ) {
    throw new Error(`kind must be one of: ${JOURNAL_KINDS.join(", ")}`);
  }
  const scope = typeof options.scope === "string" && options.scope.length > 0 ? options.scope : undefined;
  const query =
    typeof options.query === "string" && options.query.length > 0
      ? options.query.toLowerCase()
      : undefined;
  const limit =
    typeof options.limit === "number" && Number.isInteger(options.limit)
      ? Math.max(1, Math.min(JOURNAL_SEARCH_MAX_RECORDS, options.limit))
      : JOURNAL_SEARCH_MAX_RECORDS;
  const end = until === undefined ? Date.now() : until;
  const start = since === undefined ? 0 : since;
  const evidence = readJournalEvidence(instance(context), {
    window: { start: new Date(start), end: new Date(end) },
    root: context.repoDir,
  });
  const rows = evidence.events
    .filter((event) => {
      if (kind !== undefined && event.kind !== kind) return false;
      if (scope !== undefined && event.scope !== scope) return false;
      if (query !== undefined && !event.text.toLowerCase().includes(query)) return false;
      return true;
    })
    .map((event) => ({
      ts: event.ts,
      kind: event.kind,
      text: event.text,
      scope: event.scope ?? null,
    }))
    .sort(
      (left, right) =>
        right.ts.localeCompare(left.ts) ||
        left.kind.localeCompare(right.kind) ||
        (left.scope ?? "").localeCompare(right.scope ?? "") ||
        left.text.localeCompare(right.text),
    );
  const records: JournalRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (records.length >= limit) break;
    const cost = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (records.length > 0 && bytes + cost > JOURNAL_SEARCH_MAX_BYTES) break;
    bytes += cost;
    records.push(row);
  }
  return { records, total: rows.length, truncated: records.length < rows.length };
}
