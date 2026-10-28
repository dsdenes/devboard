import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The watchdog's retained cycle history, read from the run directories the
 * coordinator writes. It is a read-only projection: no file is created,
 * repaired, or locked while the dashboard renders it.
 */

/** The dashboard never lists more than the newest 100 run directories. */
export const CYCLE_HISTORY_LIMIT = 100;

export interface WatchdogCycleWindow {
  start: string | null;
  end: string | null;
}

export interface WatchdogCycle {
  /** The cycle's start, UTC ISO 8601, taken from its report. */
  at: string;
  window: WatchdogCycleWindow;
  action: string;
  findings: number;
  /** The GitHub issues this cycle's findings map to, in finding order. */
  issues: string[];
  /** The report's optional reason, absent when the report carries none. */
  reason?: string;
}

/** Resolves a finding fingerprint to the GitHub issue that covers it. */
export type WatchdogIssueResolver = (fingerprint: string) => string | undefined;

/** The cycle rows never repeat an issue link. */
function connectedIssues(
  report: Record<string, unknown>,
  resolve?: WatchdogIssueResolver,
): string[] {
  const urls: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !urls.includes(value)) urls.push(value);
  };
  if (Array.isArray(report.findings)) {
    for (const value of report.findings) {
      const finding = record(value);
      if (typeof finding?.fingerprint !== "string") continue;
      add(resolve?.(finding.fingerprint));
    }
  }
  if (Array.isArray(report.issues)) {
    for (const value of report.issues) add(record(value)?.url);
  }
  return urls;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function windowOf(value: unknown): WatchdogCycleWindow {
  const window = record(value);
  return {
    start: typeof window?.start === "string" ? window.start : null,
    end: typeof window?.end === "string" ? window.end : null,
  };
}

/** One report, or undefined when it cannot be rendered as a cycle row. */
function cycleFromReport(
  value: unknown,
  resolve?: WatchdogIssueResolver,
): WatchdogCycle | undefined {
  const report = record(value);
  if (report === undefined) return undefined;
  if (typeof report.cycle !== "string" || report.cycle.length === 0) return undefined;
  return {
    at: report.cycle,
    window: windowOf(report.window),
    action: typeof report.action === "string" ? report.action : "none",
    findings: Array.isArray(report.findings) ? report.findings.length : 0,
    issues: connectedIssues(report, resolve),
    ...(typeof report.reason === "string" ? { reason: report.reason } : {}),
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The newest run directory names first, capped before any file is read. */
function runDirectories(watchdogDir: string): string[] {
  try {
    return readdirSync(join(watchdogDir, "runs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))
      .slice(0, CYCLE_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * The newest-first cycle history. When no run directory exists at all, the
 * cycle already projected from `latest.json` is the single row; a run
 * directory whose `report.json` is missing or unparsable is skipped without
 * hiding every other row.
 */
export function readWatchdogCycles(
  watchdogDir: string,
  latestCycle: WatchdogCycle | undefined,
  resolve?: WatchdogIssueResolver,
): WatchdogCycle[] {
  const directories = runDirectories(watchdogDir);
  if (directories.length === 0) return latestCycle === undefined ? [] : [latestCycle];
  const cycles: WatchdogCycle[] = [];
  for (const directory of directories) {
    const cycle = cycleFromReport(
      readJson(join(watchdogDir, "runs", directory, "report.json")),
      resolve,
    );
    if (cycle !== undefined) cycles.push(cycle);
  }
  return cycles;
}

/** The cycle `latest.json` carries, when it carries a usable one. */
export function latestWatchdogCycle(
  latest: unknown,
  resolve?: WatchdogIssueResolver,
): WatchdogCycle | undefined {
  return cycleFromReport(latest, resolve);
}
