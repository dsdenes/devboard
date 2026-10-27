import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pruneJournal } from "../server/journal";
import { collectEvidence, WINDOW_MS, type Collection, type Window } from "./collect";
import { coveredStateDirs, runCleanup, type CleanupReport } from "./cleanup";
import { discoverInstances, type Instance } from "./discovery";
import { analyzeEvidence } from "./findings";
import { commentIssue, createIssue, runGh, type GhRun, type IssueInput } from "./github";
import {
  loadLedger,
  markCommented,
  markFiled,
  markPending,
  recordFindings,
  saveLedger,
  type LedgerEntry,
} from "./ledger";

/**
 * One watchdog cycle: discover live dashboards, collect the previous ten
 * minutes of machine-checkable evidence, and file or comment one GitHub issue
 * per distinct signal. It never spawns an agent, creates a worktree, commits,
 * merges, pushes, or publishes.
 */

/** How long an existing issue waits before a recurrence comments on it. */
export const COMMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface CycleContext {
  root: string;
  harness: string;
  stateDir: string;
  runDir: string;
  now: Date;
  window: Window;
  log: (line: string) => void;
}

export interface CycleDeps {
  discover: (root: string) => Instance[];
  collect: (root: string, instances: Instance[], window: Window) => Collection;
  gh: GhRun;
}

export interface ReportInstance {
  pid: number;
  port: number;
  repoDir: string;
  harness: string;
  instrumented: boolean;
  journal: string;
  legacyLog?: string;
}

export interface ReportFinding {
  category: string;
  ts: string;
  quote: string;
  fingerprint: string;
  instances: { repoDir: string; port: number; pid: number; journal: string }[];
}

export interface ReportIssue {
  url: string;
  category: string;
  fingerprint: string;
  line: string;
}

export type CycleAction = "none" | "duplicate" | "filed" | "commented" | "failed";

export interface Report {
  cycle: string;
  window: { start: string; end: string; minutes: number };
  instances: ReportInstance[];
  findings: ReportFinding[];
  action: CycleAction;
  issues: ReportIssue[];
  /** Fingerprints still waiting for a successful filing. */
  pending: number;
  /** This cycle's report; the issue body points at it. */
  reportPath: string;
  reason?: string;
  malformed: number;
  unattributed: number;
  /** Age-based retention over every covered state directory. */
  cleanup: CleanupReport;
}

export interface CycleOptions {
  root?: string;
  now?: Date;
  stateDir?: string;
  dryRun?: boolean;
  deps?: Partial<CycleDeps>;
}

export interface CycleResult {
  report: Report;
  exitCode: number;
  runDir?: string;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function isFiled(entry: LedgerEntry | undefined): boolean {
  return entry !== undefined && entry.disposition.startsWith("filed:");
}

/** Runs one watchdog cycle. The caller owns the singleton lock. */
export async function runCycle(options: CycleOptions = {}): Promise<CycleResult> {
  const root = resolve(options.root ?? join(import.meta.dir, "..", ".."));
  const harness = join(root, ".devboard");
  const now = options.now ?? new Date();
  const window: Window = {
    start: new Date(now.getTime() - WINDOW_MS),
    end: now,
  };
  const stateDir = resolve(options.stateDir ?? join(harness, ".tmp", "watchdog"));
  const runDir = join(stateDir, "runs", stamp(now));
  const reportPath = join(runDir, "report.json");
  const deps: CycleDeps = {
    discover: () => discoverInstances({ selfPids: new Set([process.pid]) }),
    collect: (target, instances, collectedWindow) =>
      collectEvidence({
        root: target,
        instances,
        window: collectedWindow,
        selfPids: new Set([process.pid]),
      }),
    gh: runGh,
    ...options.deps,
  };
  const dryRun = options.dryRun === true;
  if (!dryRun) mkdirSync(runDir, { recursive: true });
  const coordinatorLog = dryRun ? undefined : join(runDir, "coordinator.log");
  const context: CycleContext = {
    root,
    harness,
    stateDir,
    runDir,
    now,
    window,
    log(line: string) {
      const stamped = `${new Date().toISOString()} ${line}\n`;
      if (coordinatorLog !== undefined) {
        try {
          appendFileSync(coordinatorLog, stamped);
        } catch {
          // Reporting must not fail the cycle.
        }
      }
      process.stderr.write(`watchdog: ${line}\n`);
    },
  };

  const ledger = loadLedger(stateDir);
  const instances = deps.discover(root);
  context.log(`discovered ${instances.length} instance(s)`);

  const covered = coveredStateDirs(root, instances);
  if (!dryRun) {
    for (const entry of covered) {
      const removed = pruneJournal(entry.stateDir, {
        now,
        windowStart: window.start,
      });
      if (removed.length > 0) {
        context.log(`pruned ${removed.length} old journal file(s) in ${entry.stateDir}`);
      }
    }
  }

  const cleanup = runCleanup({
    root,
    now,
    dryRun,
    instances,
    covered,
    watchdogRunDir: runDir,
  });
  for (const entry of cleanup.roots) {
    context.log(
      `cleanup ${entry.stateDir}: ${dryRun ? "would remove" : "removed"} ` +
        `${entry.files} file(s), ${entry.directories} directory/directories, ` +
        `${entry.bytes} byte(s)` +
        (entry.errors.length > 0 ? `, ${entry.errors.length} error(s)` : ""),
    );
    for (const error of entry.errors) context.log(`cleanup ${entry.stateDir}: ${error}`);
  }

  const collection = deps.collect(root, instances, window);
  const findings = analyzeEvidence(collection.events, { window });
  context.log(
    `collected ${collection.events.length} event(s), ${findings.length} finding(s), ` +
      `${collection.malformed} malformed, ${collection.unattributed} unattributed`,
  );
  recordFindings(ledger, findings, now);

  const report: Report = {
    cycle: now.toISOString(),
    window: {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      minutes: WINDOW_MS / 60 / 1000,
    },
    instances: instances.map((instance) => ({
      pid: instance.pid,
      port: instance.port,
      repoDir: instance.repoDir,
      harness: instance.harness,
      instrumented: instance.instrumented,
      journal: instance.journal,
      ...(instance.legacyLog === undefined ? {} : { legacyLog: instance.legacyLog }),
    })),
    findings: findings.map((finding) => ({
      category: finding.category,
      ts: finding.ts,
      quote: finding.quote,
      fingerprint: finding.fingerprint,
      instances: finding.instances.map((instance) => ({
        repoDir: instance.repoDir,
        port: instance.port,
        pid: instance.pid,
        journal: instance.journal,
      })),
    })),
    action: "none",
    issues: [],
    pending: ledger.pendingFiling.length,
    reportPath,
    malformed: collection.malformed,
    unattributed: collection.unattributed,
    cleanup,
  };

  if (dryRun) {
    const settled = findings.every((finding) => isFiled(ledger.findings[finding.fingerprint]));
    if (findings.length === 0 && ledger.pendingFiling.length === 0) {
      report.reason = "no finding in the window";
    } else if (settled && ledger.pendingFiling.length === 0) {
      report.action = "duplicate";
      report.reason = "every finding already has an issue";
    } else {
      report.reason =
        `dry run: ${findings.length} finding(s) and ` +
        `${ledger.pendingFiling.length} pending filing(s) not attempted`;
    }
    return { report, exitCode: 0 };
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

  const issueInput = (fingerprint: string, entry: LedgerEntry): IssueInput => ({
    category: entry.category,
    fingerprint,
    line: entry.line,
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    count: entry.count,
    window,
    instances: entry.instances,
    reportPath,
  });

  let failure: string | undefined;
  let commented = 0;

  // Pending filings are retried first: a failed `gh` call never loses evidence.
  for (const fingerprint of queue) {
    const entry = ledger.findings[fingerprint];
    if (entry === undefined) {
      ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
      continue;
    }
    const filed = createIssue(deps.gh, issueInput(fingerprint, entry));
    if (filed.ok) {
      markFiled(ledger, fingerprint, filed.url, now);
      report.issues.push({
        url: filed.url,
        category: entry.category,
        fingerprint,
        line: entry.line,
      });
      context.log(`filed ${filed.url} for ${entry.category}: ${entry.line}`);
      continue;
    }
    failure ??= filed.reason;
    markPending(ledger, fingerprint);
    context.log(`filing ${entry.category} failed: ${filed.reason}`);
  }

  const filedThisCycle = new Set(report.issues.map((issue) => issue.fingerprint));
  for (const finding of findings) {
    const entry = ledger.findings[finding.fingerprint];
    if (entry === undefined || entry.url === undefined) continue;
    if (filedThisCycle.has(finding.fingerprint)) continue;
    const baseline = Date.parse(entry.lastCommentAt ?? entry.filedAt ?? "");
    if (!Number.isFinite(baseline) || now.getTime() - baseline < COMMENT_INTERVAL_MS) continue;
    const comment = commentIssue(deps.gh, entry.url, issueInput(finding.fingerprint, entry));
    if (comment.ok) {
      markCommented(ledger, finding.fingerprint, now);
      commented += 1;
      context.log(`commented on ${entry.url}`);
      continue;
    }
    failure ??= comment.reason;
    context.log(`comment on ${entry.url} failed: ${comment.reason}`);
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
  } else if (findings.length > 0 || ledger.pendingFiling.length > 0) {
    report.action = "duplicate";
    report.reason = "every finding already has an issue";
  } else {
    report.reason = "no finding in the window";
  }
  report.pending = ledger.pendingFiling.length;

  saveLedger(context.stateDir, ledger);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(context.stateDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(context.runDir, "report.md"), renderMarkdown(report));
  context.log(`cycle ${report.action}: ${report.reason ?? "no reason"}`);
  return {
    report,
    exitCode: report.action === "failed" ? 1 : 0,
    runDir: context.runDir,
  };
}

function renderMarkdown(report: Report): string {
  const lines = [
    `# Watchdog cycle ${report.cycle}`,
    "",
    `- Window: ${report.window.start} .. ${report.window.end} (${report.window.minutes} minutes)`,
    `- Action: ${report.action}`,
    `- Reason: ${report.reason ?? "none"}`,
    `- Findings: ${report.findings.length}`,
    `- Pending filings: ${report.pending}`,
    "",
    "## Instances",
    "",
    ...(report.instances.length === 0
      ? ["No dashboard was running."]
      : report.instances.map(
          (instance) =>
            `- port ${instance.port}: ${instance.repoDir} (pid ${instance.pid}, ` +
            `${instance.instrumented ? "instrumented" : "uninstrumented"})`,
        )),
    "",
    "## Findings",
    "",
    ...(report.findings.length === 0
      ? ["None."]
      : report.findings.map(
          (finding) => `- ${finding.category} at ${finding.ts}: ${finding.quote}`,
        )),
    "",
    "## Issues",
    "",
    ...(report.issues.length === 0
      ? ["None."]
      : report.issues.map((issue) => `- ${issue.url} (${issue.category})`)),
    "",
  ];
  return `${lines.join("\n")}\n`;
}
