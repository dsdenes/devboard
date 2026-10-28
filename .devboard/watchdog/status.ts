import { readFileSync } from "node:fs";
import { join } from "node:path";
import { latestWatchdogCycle, readWatchdogCycles, type WatchdogCycle } from "./history";
import { loadLedger } from "./ledger";

/**
 * The read-only watchdog view the dashboard serves. It is derived from the
 * newest cycle report, the retained run directories, and the ledger, and it
 * never carries an environment value: only the action, the counts, and the
 * issue URLs.
 */

export interface WatchdogIssue {
  url: string;
  category: string;
  line: string;
  filedAt: string;
}

export interface WatchdogStatus {
  /** The newest cycle's start, UTC ISO 8601, or null before the first cycle. */
  cycle: string | null;
  action: string;
  reason?: string;
  /** Findings in the newest cycle. */
  findings: number;
  /** Every issue the watchdog filed, newest first. */
  issues: WatchdogIssue[];
  /** Fingerprints still waiting for a successful filing. */
  pending: number;
  /** The retained cycles, newest first; empty before the first cycle. */
  cycles: WatchdogCycle[];
}

export function readWatchdogStatus(watchdogDir: string): WatchdogStatus {
  let latest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(watchdogDir, "latest.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      latest = parsed as Record<string, unknown>;
    }
  } catch {
    // No cycle has run yet.
  }
  const ledger = loadLedger(watchdogDir);
  const issues = Object.values(ledger.findings)
    .filter(
      (entry): entry is typeof entry & { url: string } =>
        entry.disposition.startsWith("filed:") && typeof entry.url === "string",
    )
    .map((entry) => ({
      url: entry.url,
      category: entry.category,
      line: entry.line,
      filedAt: entry.filedAt ?? entry.firstSeen,
    }))
    .sort((left, right) => right.filedAt.localeCompare(left.filedAt) || left.url.localeCompare(right.url));
  return {
    cycle: typeof latest.cycle === "string" ? latest.cycle : null,
    action: typeof latest.action === "string" ? latest.action : "none",
    ...(typeof latest.reason === "string" ? { reason: latest.reason } : {}),
    findings: Array.isArray(latest.findings) ? latest.findings.length : 0,
    issues,
    pending: ledger.pendingFiling.length,
    cycles: readWatchdogCycles(
      watchdogDir,
      latestWatchdogCycle(latest, (fingerprint) => ledger.findings[fingerprint]?.url),
      (fingerprint) => ledger.findings[fingerprint]?.url,
    ),
  };
}
