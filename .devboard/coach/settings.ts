import { readFileSync } from "node:fs";
import { isInteger, isRecord } from "../issues/guards";
import { writeJsonAtomic } from "../watchdog/settings";
import { settingsPath } from "./paths";

/**
 * What the dashboard persists and the worker applies without a restart. The
 * deterministic family pipeline stays fixed; only the cadence, the filing
 * caps, the per-cycle cap, and the command allowlist are settings.
 */

export const DEFAULT_INTERVAL_MINUTES = 60;
export const DEFAULT_MAX_PER_HOUR = 10;
export const DEFAULT_MAX_PENDING = 20;
export const DEFAULT_MAX_ISSUES_PER_CYCLE = 2;
export const MAX_ALLOWLIST_ENTRIES = 50;
export const MAX_ALLOWLIST_ENTRY = 200;

export interface CoachSettings {
  intervalMinutes: number;
  /** Filings per rolling hour; null is unlimited. */
  maxPerHour: number | null;
  /** Pending proposals kept; null is unlimited. */
  maxPending: number | null;
  /** Issues filed in one cycle, 1 through 20. */
  maxIssuesPerCycle: number;
  /** Command prefixes a tool proposal must match to be filed. */
  allowlist: string[];
}

export const DEFAULT_COACH_SETTINGS: CoachSettings = Object.freeze({
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  maxPerHour: DEFAULT_MAX_PER_HOUR,
  maxPending: DEFAULT_MAX_PENDING,
  maxIssuesPerCycle: DEFAULT_MAX_ISSUES_PER_CYCLE,
  allowlist: [],
});

export function isValidCadence(value: unknown): value is number {
  return isInteger(value) && value >= 1 && value <= 1440;
}

export function isValidLimit(value: unknown): value is number | null {
  return value === null || (isInteger(value) && value >= 1 && value <= 100);
}

export function isValidIssuesPerCycle(value: unknown): value is number {
  return isInteger(value) && value >= 1 && value <= 20;
}

export function isValidAllowlist(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ALLOWLIST_ENTRIES &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.trim().length > 0 &&
        entry.length <= MAX_ALLOWLIST_ENTRY,
    )
  );
}

/**
 * Parses a settings file. A missing or unknown key falls back to its default
 * and never rejects the file; an invalid known key falls back on its own.
 */
export function parseCoachSettings(text: string): CoachSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  return {
    intervalMinutes: isValidCadence(parsed.intervalMinutes)
      ? parsed.intervalMinutes
      : DEFAULT_COACH_SETTINGS.intervalMinutes,
    maxPerHour: isValidLimit(parsed.maxPerHour)
      ? parsed.maxPerHour
      : DEFAULT_COACH_SETTINGS.maxPerHour,
    maxPending: isValidLimit(parsed.maxPending)
      ? parsed.maxPending
      : DEFAULT_COACH_SETTINGS.maxPending,
    maxIssuesPerCycle: isValidIssuesPerCycle(parsed.maxIssuesPerCycle)
      ? parsed.maxIssuesPerCycle
      : DEFAULT_COACH_SETTINGS.maxIssuesPerCycle,
    allowlist: isValidAllowlist(parsed.allowlist)
      ? [...parsed.allowlist]
      : [...DEFAULT_COACH_SETTINGS.allowlist],
  };
}

export function readCoachSettings(directory: string): CoachSettings {
  try {
    return (
      parseCoachSettings(readFileSync(settingsPath(directory), "utf8")) ?? {
        ...DEFAULT_COACH_SETTINGS,
        allowlist: [],
      }
    );
  } catch {
    return { ...DEFAULT_COACH_SETTINGS, allowlist: [] };
  }
}

export function writeCoachSettings(directory: string, settings: CoachSettings): void {
  writeJsonAtomic(settingsPath(directory), settings);
}
