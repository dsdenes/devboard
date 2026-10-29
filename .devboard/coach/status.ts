import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentCycle } from "../server/agents/registry";
import { latestWatchdogCycle, readWatchdogCycles } from "../watchdog/history";
import { loadLedger } from "./ledger";

/**
 * The read-only Coach view the dashboard serves: the newest cycle, the ledger's
 * filed issues, the pending count, and the retained cycle history. It never
 * carries an environment value.
 */

export interface CoachIssue {
  url: string;
  category: string;
  line: string;
  filedAt: string;
}

export interface CoachStatus {
  cycle: string | null;
  action: string;
  reason?: string;
  findings: number;
  issues: CoachIssue[];
  pending: number;
  cycles: AgentCycle[];
}

export function readCoachStatus(coachDir: string): CoachStatus {
  let latest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(coachDir, "latest.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      latest = parsed as Record<string, unknown>;
    }
  } catch {
    // No cycle has run yet.
  }
  const ledger = loadLedger(coachDir);
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
    .sort(
      (left, right) =>
        right.filedAt.localeCompare(left.filedAt) || left.url.localeCompare(right.url),
    );
  return {
    cycle: typeof latest.cycle === "string" ? latest.cycle : null,
    action: typeof latest.action === "string" ? latest.action : "none",
    ...(typeof latest.reason === "string" ? { reason: latest.reason } : {}),
    findings: Array.isArray(latest.findings) ? latest.findings.length : 0,
    issues,
    pending: ledger.pendingFiling.length,
    cycles: readWatchdogCycles(
      coachDir,
      latestWatchdogCycle(latest, (fingerprint) => ledger.findings[fingerprint]?.url),
      (fingerprint) => ledger.findings[fingerprint]?.url,
    ),
  };
}
