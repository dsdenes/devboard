import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { journalKey } from "../server/journal";

/**
 * Per-tool invocation counts for the Devboard MCP server. Counts live in a
 * SQLite table keyed by the resolved repository, so every peer process that
 * shares one harness increments the same row without clobbering another
 * process's read-modify-write. The table holds one bounded row per tool name.
 */

const BUSY_TIMEOUT_MS = 5000;

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS tool_invocations (" +
  "name TEXT PRIMARY KEY NOT NULL, count INTEGER NOT NULL)";

const INCREMENT_QUERY =
  "INSERT INTO tool_invocations (name, count) VALUES (?, 1) " +
  "ON CONFLICT(name) DO UPDATE SET count = count + 1";

/** `<stateDir>/mcp/tool-invocations/<24-hex repository key>.db` */
export function toolInvocationFile(stateDir: string, repoDir: string): string {
  return join(resolve(stateDir), "mcp", "tool-invocations", `${journalKey(resolve(repoDir))}.db`);
}

function open(path: string, options: { create?: boolean; readonly?: boolean }): Database {
  const database = new Database(path, options);
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return database;
}

/**
 * Counts one `tools/call` for a catalog tool. A write failure throws to the
 * caller; the stdio server treats statistics as diagnostics and never fails a
 * tool call because its counter could not be written.
 */
export function recordToolInvocation(stateDir: string, repoDir: string, name: string): void {
  if (name.length === 0) return;
  const path = toolInvocationFile(stateDir, repoDir);
  mkdirSync(dirname(path), { recursive: true });
  const database = open(path, { create: true });
  try {
    database.exec(CREATE_TABLE);
    database.query(INCREMENT_QUERY).run(name);
  } finally {
    database.close();
  }
}

/**
 * The counts a dashboard renders. A missing file is an empty table; an
 * unreadable or damaged file is reported as empty rather than breaking the
 * tool panel, because counts are never live state a control depends on.
 */
export function toolInvocationCounts(stateDir: string, repoDir: string): Record<string, number> {
  const path = toolInvocationFile(stateDir, repoDir);
  if (!existsSync(path)) return {};
  let database: Database | undefined;
  try {
    database = open(path, { readonly: true });
    const rows = database.query("SELECT name, count FROM tool_invocations").all() as Array<{
      name: unknown;
      count: unknown;
    }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      if (
        typeof row.name === "string" &&
        row.name.length > 0 &&
        typeof row.count === "number" &&
        Number.isSafeInteger(row.count) &&
        row.count >= 0
      ) {
        counts[row.name] = row.count;
      }
    }
    return counts;
  } catch {
    return {};
  } finally {
    database?.close();
  }
}
