import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pruneJournal } from "../server/journal";
import { collectEvidence, WINDOW_MS, type Collection, type Window } from "./collect";
import { coveredStateDirs, runCleanup, type CleanupReport } from "./cleanup";
import { discoverInstances, type Instance } from "./discovery";
import { analyzeEvidence, STALL_MS } from "./findings";
import { runGh, type GhRun, type IssueInput } from "./github";
import { createWatchdogDelivery, type WatchdogDelivery } from "./delivery";
import {
  loadLedger,
  markCommented,
  markFiled,
  markPending,
  recordFindings,
  saveLedger,
  type LedgerEntry,
} from "./ledger";
import { readProjection } from "./projection";
import { DEFAULT_WATCHDOG_SETTINGS, readWatchdogSettings, type WatchdogSettings } from "./settings";

/**
 * One watchdog cycle: discover live dashboards, collect the previous ten
 * minutes of machine-checkable evidence plus one stall lookback for starts and
 * their stops, and file or comment one GitHub issue per distinct signal. It
 * never spawns an agent, creates a worktree, commits, merges, pushes, or
 * publishes.
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
  collect: (root: string, instances: Instance[], evidenceWindow: Window) => Collection;
  gh: GhRun;
  delivery?: WatchdogDelivery;
  /** Environment for delivery construction; defaults to `process.env`. */
  environment?: Record<string, string | undefined>;
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

export type CycleAction =
  | "none"
  | "duplicate"
  | "filed"
  | "commented"
  | "capped"
  | "failed";

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
  /** The evidence window; a running worker passes its cadence interval. */
  windowMs?: number;
  /** Persisted cadence and caps; read from the state directory when omitted. */
  settings?: WatchdogSettings;
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

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

/** Runs one watchdog cycle. The caller owns the singleton lock. */
export async function runCycle(options: CycleOptions = {}): Promise<CycleResult> {
  const root = resolve(options.root ?? join(import.meta.dir, "..", ".."));
  const harness = join(root, ".devboard");
  const now = options.now ?? new Date();
  const windowMs = Math.max(60_000, options.windowMs ?? WINDOW_MS);
  const window: Window = {
    start: new Date(now.getTime() - windowMs),
    end: now,
  };
  // A start in the window's final five minutes is not a stall yet, and the
  // next window begins at this one's end, so collection reads one stall
  // interval further back for starts and their matching stops.
  const stallLookback: Window = {
    start: new Date(window.start.getTime() - STALL_MS),
    end: now,
  };
  const stateDir = resolve(options.stateDir ?? join(harness, ".tmp", "watchdog"));
  const settings = options.settings ?? readWatchdogSettings(stateDir);
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
        // A rotated file still inside the stall lookback is evidence this
        // cycle's collection needs.
        windowStart: stallLookback.start,
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

  const collection = deps.collect(root, instances, stallLookback);
  const findings = analyzeEvidence(collection.events, { window, stallLookback });
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
      minutes: windowMs / 60 / 1000,
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

  let delivery = deps.delivery;
  let deliveryFailure: string | undefined;
  const deliveryFor = (): WatchdogDelivery | undefined => {
    if (delivery !== undefined) return delivery;
    if (deliveryFailure !== undefined) return undefined;
    try {
      delivery = createWatchdogDelivery({
        root,
        gh: deps.gh,
        ...(deps.environment === undefined ? {} : { environment: deps.environment }),
      });
    } catch (error) {
      deliveryFailure = firstLine(error);
    }
    return delivery;
  };
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
  // A configuration failure is a per-fingerprint failure, not a lost cycle:
  // build once here so every queued fingerprint can stay pending below.
  if (queue.length > 0) deliveryFor();

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

  // Caps: with no cap the queue is filed exactly as before. A cap counts new
  // issues per rolling hour and open issues from the last successful
  // projection; an unavailable projection files nothing new.
  const capsActive = settings.maxPerHour !== null || settings.maxPending !== null;
  const filingRoom = (): number => {
    if (!capsActive) return Number.POSITIVE_INFINITY;
    const hourStart = now.getTime() - 60 * 60_000;
    let filedThisHour = 0;
    for (const candidate of Object.values(ledger.findings)) {
      if (!candidate.disposition.startsWith("filed:")) continue;
      const filedAt = Date.parse(candidate.filedAt ?? "");
      if (Number.isFinite(filedAt) && filedAt > hourStart) filedThisHour += 1;
    }
    const projection = readProjection(stateDir);
    if (projection === undefined || projection.state !== "ok") {
      report.reason = "a filing cap is set and the GitHub projection is not ok; nothing new was filed";
      return 0;
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
    return Math.min(hourlyRoom, openRoom);
  };
  let room = filingRoom();

  // Pending filings are retried first: a failed `gh` call never loses evidence.
  for (const fingerprint of queue) {
    if (room <= 0) {
      markPending(ledger, fingerprint);
      continue;
    }
    const entry = ledger.findings[fingerprint];
    if (entry === undefined) {
      ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
      continue;
    }
    const active = deliveryFor();
    if (active === undefined) {
      const reason = deliveryFailure ?? "the watchdog delivery is unavailable";
      failure ??= reason;
      markPending(ledger, fingerprint);
      context.log(`filing ${entry.category} failed: ${reason}`);
      continue;
    }
    const filed = await active.create(issueInput(fingerprint, entry));
    if (filed.ok) {
      room -= 1;
      markFiled(ledger, fingerprint, filed.url, now);
      // Persist each success before the next call: a hard kill after this
      // point must not refile an issue the forge already accepted.
      saveLedger(context.stateDir, ledger);
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
    const active = deliveryFor();
    if (active === undefined) {
      const reason = deliveryFailure ?? "the watchdog delivery is unavailable";
      failure ??= reason;
      context.log(`comment on ${entry.url} failed: ${reason}`);
      continue;
    }
    const comment = await active.comment(
      entry.url,
      issueInput(finding.fingerprint, entry),
    );
    if (comment.ok) {
      markCommented(ledger, finding.fingerprint, now);
      saveLedger(context.stateDir, ledger);
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
