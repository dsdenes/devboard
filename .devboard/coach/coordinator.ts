import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeSessionLine } from "../lib/agent-sessions";
import { MCP_COVERS } from "../mcp/catalog";
import { readProjection } from "../watchdog/projection";
import { collectEvidence, type CoachCollection, type EvidenceWindow } from "./collect";
import {
  createCoachDelivery,
  type CoachDelivery,
  type CommentResult,
  type DeliveryResult,
} from "./delivery";
import {
  analyzeEvidence,
  EVIDENCE_WINDOW_MS,
  isCoachCategory,
  type CoachFinding,
} from "./findings";
import { coachBody, coachComment, coachTitle, type CoachEvidence } from "./issue";
import {
  isFiled,
  loadLedger,
  markCommented,
  markFiled,
  markPending,
  recordFindings,
  saveLedger,
  type CoachLedger,
} from "./ledger";
import { coachDirectory, latestPath, runsDirectory } from "./paths";
import { readCoachSettings, type CoachSettings } from "./settings";

/**
 * One Coach cycle: collect the 24-hour evidence window, run the deterministic
 * detectors, and file or comment one issue per fingerprint. It never starts an
 * ACP peer, calls a model, or writes outside the Coach state directory.
 */

/** How long an existing issue waits before a recurrence comments again. */
export const COMMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CoachReport {
  cycle: string;
  window: { start: string; end: string; minutes: number };
  sessions: number;
  sessionFiles: number;
  truncated: boolean;
  skipped: number;
  malformed: number;
  journalRecords: number;
  findings: CoachFinding[];
  action: "none" | "duplicate" | "filed" | "commented" | "capped" | "failed";
  issues: Array<{ url: string; category: string; fingerprint: string; line: string }>;
  pending: number;
  reportPath: string;
  reason?: string;
}

export interface CycleOptions {
  /** The repository root the cycle reads. */
  root: string;
  /** The dashboard's STATE_DIR; Coach files live under its `coach/`. */
  stateDir: string;
  now?: Date;
  dryRun?: boolean;
  settings?: CoachSettings;
  environment?: Record<string, string | undefined>;
  /** Test seams. */
  collect?: (window: EvidenceWindow) => CoachCollection;
  delivery?: CoachDelivery;
  projection?: { state: "ok" | "error" | "stale"; issues: Array<{ url: string; state: "pending" | "implemented" }> };
}

export interface CycleResult {
  report: CoachReport;
  exitCode: number;
  runDir?: string;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

function scopeEvidence(
  collection: CoachCollection,
  root: string,
  finding: CoachFinding,
): Map<string, string> {
  const kind = finding.category === "repeat-question" ? "question" : "acp-stderr";
  const scopes = new Map<string, string>();
  for (const record of collection.journal) {
    const scope = record.scope;
    if (scope === null || record.kind !== kind) continue;
    const excerpt = normalizeSessionLine(record.text, { repoDir: root }).slice(0, 2_000);
    if (excerpt.length === 0) continue;
    const current = scopes.get(scope);
    if (current === undefined) {
      scopes.set(scope, excerpt);
      continue;
    }
    // Prefer the record whose normalized text the fingerprint was built from.
    if (excerpt.includes(finding.subject) || finding.subject.includes(excerpt)) {
      scopes.set(scope, excerpt);
    }
  }
  return scopes;
}

function evidenceFor(
  collection: CoachCollection,
  root: string,
  finding: CoachFinding,
): CoachEvidence {
  const sessions = new Map<
    string,
    CoachCollection["sessions"][number]
  >();
  for (const id of finding.sessions) {
    const session = collection.sessions.find((candidate) => candidate.id === id);
    if (session !== undefined) sessions.set(id, session);
  }
  return {
    window: collection.window,
    sessions,
    scopes: scopeEvidence(collection, root, finding),
    repoDir: resolve(root),
  };
}

function renderMarkdown(report: CoachReport): string {
  return [
    `# Coach cycle ${report.cycle}`,
    "",
    `- Window: ${report.window.start} .. ${report.window.end}`,
    `- Action: ${report.action}`,
    `- Reason: ${report.reason ?? "none"}`,
    `- Sessions: ${report.sessions} of ${report.sessionFiles} selected` +
      `${report.truncated ? " (truncated)" : ""}`,
    `- Skips: ${report.skipped}, malformed lines: ${report.malformed}`,
    `- Journal records: ${report.journalRecords}`,
    `- Findings: ${report.findings.length}`,
    `- Pending filings: ${report.pending}`,
    "",
    "## Findings",
    "",
    ...(report.findings.length === 0
      ? ["None."]
      : report.findings.map(
          (finding) =>
            `- ${finding.category} \`${finding.fingerprint}\` (${finding.count}): ${finding.line}`,
        )),
    "",
    "## Issues",
    "",
    ...(report.issues.length === 0
      ? ["None."]
      : report.issues.map((issue) => `- ${issue.url} (${issue.category})`)),
    "",
  ].join("\n");
}

/** Runs one Coach cycle. The caller owns the singleton lock. */
export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const root = resolve(options.root);
  const stateDir = resolve(options.stateDir);
  const coachDir = coachDirectory(stateDir);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const window: EvidenceWindow = {
    start: new Date(now.getTime() - EVIDENCE_WINDOW_MS),
    end: now,
  };
  const settings = options.settings ?? readCoachSettings(coachDir);
  const collection =
    options.collect?.(window) ??
    collectEvidence({
      stateDir,
      repoDir: root,
      window,
    });
  const findings = analyzeEvidence({
    sessions: collection.sessions,
    journal: collection.journal,
    window: collection.window,
    repoDir: root,
    covers: MCP_COVERS,
  });
  const ledger = loadLedger(coachDir);
  if (!dryRun) recordFindings(ledger, findings, now);

  const runDir = join(runsDirectory(coachDir), stamp(now));
  const reportPath = join(runDir, "report.json");
  const report: CoachReport = {
    cycle: now.toISOString(),
    window: { ...collection.window, minutes: EVIDENCE_WINDOW_MS / 60_000 },
    sessions: collection.sessions.length,
    sessionFiles: collection.sessionFiles,
    truncated: collection.truncated,
    skipped: collection.skipped,
    malformed: collection.malformed,
    journalRecords: collection.journalRecords,
    findings,
    action: "none",
    issues: [],
    pending: ledger.pendingFiling.length,
    reportPath,
  };

  if (dryRun) {
    const settled = findings.every((finding) => isFiled(ledger.findings[finding.fingerprint]));
    if (findings.length === 0) report.reason = "no finding in the window";
    else if (settled) {
      report.action = "duplicate";
      report.reason = "every finding already has an issue";
    } else {
      report.reason = `dry run: ${findings.length} finding(s) not filed`;
    }
    return { report, exitCode: 0 };
  }

  let delivery = options.delivery;
  let deliveryFailure: string | undefined;
  const deliveryFor = (): CoachDelivery | undefined => {
    if (delivery !== undefined) return delivery;
    if (deliveryFailure !== undefined) return undefined;
    try {
      delivery = createCoachDelivery({
        repoDir: root,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
    } catch (error) {
      deliveryFailure = firstLine(error);
    }
    return delivery;
  };

  const capsActive = settings.maxPerHour !== null || settings.maxPending !== null;
  const projection = options.projection ?? readProjection(coachDir);
  let room = Number.POSITIVE_INFINITY;
  if (capsActive) {
    if (projection === undefined || projection.state !== "ok") {
      room = 0;
      report.reason = "a filing cap is set and the forge projection is not ok; nothing new was filed";
    } else {
      const hourStart = now.getTime() - 60 * 60_000;
      let filedThisHour = 0;
      for (const entry of Object.values(ledger.findings)) {
        if (!entry.disposition.startsWith("filed:")) continue;
        const filedAt = Date.parse(entry.filedAt ?? "");
        if (Number.isFinite(filedAt) && filedAt > hourStart) filedThisHour += 1;
      }
      const open = projection.issues.filter((issue) => issue.state === "pending").length;
      const hourlyRoom =
        settings.maxPerHour === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, settings.maxPerHour - filedThisHour);
      const openRoom =
        settings.maxPending === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, settings.maxPending - open);
      room = Math.min(hourlyRoom, openRoom);
    }
  }

  const queue = [
    ...ledger.pendingFiling.filter((fingerprint) => !isFiled(ledger.findings[fingerprint])),
    ...findings
      .map((finding) => finding.fingerprint)
      .filter(
        (fingerprint) =>
          !isFiled(ledger.findings[fingerprint]) &&
          !ledger.pendingFiling.includes(fingerprint),
      ),
  ];
  let failure: string | undefined;
  if (queue.length > 0 && room > 0) deliveryFor();

  for (const fingerprint of queue) {
    const entry = ledger.findings[fingerprint];
    if (entry === undefined) {
      ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
      continue;
    }
    if (room <= 0) {
      markPending(ledger, fingerprint);
      continue;
    }
    const active = deliveryFor();
    if (active === undefined) {
      const reason = deliveryFailure ?? "the Coach delivery is unavailable";
      failure ??= reason;
      markPending(ledger, fingerprint, reason);
      continue;
    }
    if (!isCoachCategory(entry.category)) {
      const reason = `the ledger entry has an unknown category: ${entry.category}`;
      failure ??= reason;
      ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
      continue;
    }
    const recorded: CoachFinding = {
      category: entry.category,
      fingerprint,
      line: entry.line,
      subject: entry.subject,
      firstAt: entry.firstSeen,
      lastAt: entry.lastSeen,
      count: entry.count,
      sessions: [],
      scopes: [],
    };
    const finding = findings.find((candidate) => candidate.fingerprint === fingerprint);
    const issued = finding ?? recorded;
    const input: CoachEvidence =
      finding === undefined
        ? { window: collection.window, sessions: new Map(), scopes: new Map(), repoDir: root }
        : evidenceFor(collection, root, finding);
    let filed: DeliveryResult;
    try {
      filed = await active.create(coachTitle(issued), coachBody({ finding: issued, evidence: input }));
    } catch (error) {
      filed = { ok: false, reason: firstLine(error) };
    }
    if (filed.ok) {
      room -= 1;
      markFiled(ledger, fingerprint, filed.url, now);
      saveLedger(coachDir, ledger);
      report.issues.push({
        url: filed.url,
        category: entry.category,
        fingerprint,
        line: entry.line,
      });
      continue;
    }
    failure ??= filed.reason;
    markPending(ledger, fingerprint, filed.reason);
  }

  const filedThisCycle = new Set(report.issues.map((issue) => issue.fingerprint));
  let commented = 0;
  for (const finding of findings) {
    if (filedThisCycle.has(finding.fingerprint)) continue;
    const entry = ledger.findings[finding.fingerprint];
    if (entry === undefined || entry.url === undefined || !isFiled(entry)) continue;
    const baseline = Date.parse(entry.lastCommentAt ?? entry.filedAt ?? "");
    if (!Number.isFinite(baseline) || now.getTime() - baseline < COMMENT_INTERVAL_MS) continue;
    const active = deliveryFor();
    if (active === undefined) {
      const reason = deliveryFailure ?? "the Coach delivery is unavailable";
      failure ??= reason;
      markPending(ledger, finding.fingerprint, reason);
      continue;
    }
    let comment: CommentResult;
    try {
      comment = await active.comment(
        entry.url,
        coachComment({ finding, evidence: evidenceFor(collection, root, finding) }),
      );
    } catch (error) {
      comment = { ok: false, reason: firstLine(error) };
    }
    if (comment.ok) {
      markCommented(ledger, finding.fingerprint, now);
      saveLedger(coachDir, ledger);
      commented += 1;
      continue;
    }
    failure ??= comment.reason;
    markPending(ledger, finding.fingerprint, comment.reason);
  }

  if (failure !== undefined) {
    report.action = "failed";
    report.reason = failure;
  } else if (report.issues.length > 0) {
    report.action = "filed";
    report.reason = `filed ${report.issues.length} issue(s)`;
  } else if (commented > 0) {
    report.action = "commented";
    report.reason = `commented on ${commented} issue(s)`;
  } else if (capsActive && ledger.pendingFiling.length > 0) {
    report.action = "capped";
    report.reason =
      report.reason ?? `filing cap reached; ${ledger.pendingFiling.length} finding(s) stay pending`;
  } else if (findings.length > 0 || ledger.pendingFiling.length > 0) {
    report.action = "duplicate";
    report.reason = "every finding already has an issue";
  } else {
    report.reason = "no finding in the window";
  }
  report.pending = ledger.pendingFiling.length;

  saveLedger(coachDir, ledger);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(latestPath(coachDir), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(runDir, "report.md"), renderMarkdown(report));
  return { report, exitCode: report.action === "failed" ? 1 : 0, runDir };
}

/** Re-reads the report to render the CLI's human line. */
export function describeCycle(result: CycleResult): string {
  const report = result.report;
  return (
    `coach: ${report.action} — ${report.reason ?? "no reason"} ` +
    `(${report.findings.length} finding(s), ${report.sessions} session(s), ` +
    `${report.pending} pending)`
  );
}

export type { CoachLedger };
