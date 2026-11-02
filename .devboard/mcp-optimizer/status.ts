import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCycle } from "../server/agents/registry";
import { latestWatchdogCycle, readWatchdogCycles } from "../watchdog/history";
import type { FamilyKind } from "./families";
import { loadLedger } from "./ledger";

/**
 * The read-only MCP optimizer view the dashboard serves: the newest cycle, the filed
 * families from the ledger, the pending depth, and the retained cycle history.
 * It never carries an environment value.
 */

export interface McpOptimizerIssue {
  url: string;
  family: string;
  /** The exact title the filed issue carries. */
  title: string;
  kind: FamilyKind;
  filedAt: string;
}

export interface McpOptimizerStatus {
  cycle: string | null;
  action: string;
  reason?: string;
  /** Total families in the newest window. */
  families: number;
  /** Families selected for synthesis in the newest window. */
  selected: number;
  /** Issues filed by the newest cycle. */
  filed: number;
  /** Pending proposals dropped by the newest cycle. */
  dropped: number;
  pending: number;
  issues: McpOptimizerIssue[];
  cycles: AgentCycle[];
}

export function readMcpOptimizerStatus(mcpOptimizerDir: string): McpOptimizerStatus {
  let latest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(mcpOptimizerDir, "latest.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      latest = parsed as Record<string, unknown>;
    }
  } catch {
    // No cycle has run yet.
  }
  const ledger = loadLedger(mcpOptimizerDir).ledger;
  const issues = Object.entries(ledger.families)
    .filter(([, entry]) => entry.lastIssueUrl !== undefined)
    .map(([family, entry]) => ({
      url: entry.lastIssueUrl!,
      family,
      title: entry.lastTitle ?? `[mcp-optimizer] ${family}`,
      kind: entry.kind,
      filedAt: entry.lastFiledAt ?? entry.lastSeen,
    }))
    .sort(
      (left, right) =>
        right.filedAt.localeCompare(left.filedAt) || left.url.localeCompare(right.url),
    );
  return {
    cycle: typeof latest.cycle === "string" ? latest.cycle : null,
    action: typeof latest.action === "string" ? latest.action : "none",
    ...(typeof latest.reason === "string" ? { reason: latest.reason } : {}),
    families: typeof latest.families === "number" ? latest.families : 0,
    selected: Array.isArray(latest.selected) ? latest.selected.length : 0,
    filed: Array.isArray(latest.issues) ? latest.issues.length : 0,
    dropped: typeof latest.dropped === "number" ? latest.dropped : 0,
    pending: ledger.pendingFiling.length,
    issues,
    cycles: readWatchdogCycles(
      mcpOptimizerDir,
      latestWatchdogCycle(latest, (family) => ledger.families[family]?.lastIssueUrl),
      (family) => ledger.families[family]?.lastIssueUrl,
    ),
  };
}
