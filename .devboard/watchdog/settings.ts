import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isInteger, isRecord } from "../issues/guards";
import { settingsPath } from "./paths";

/** What the dashboard persists and the worker applies without a restart. */
export interface WatchdogSettings {
  intervalMinutes: number;
  /** Empty means unlimited. */
  maxPerHour: number | null;
  /** Empty means unlimited. */
  maxPending: number | null;
}

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettings = Object.freeze({
  intervalMinutes: 10,
  maxPerHour: null,
  maxPending: null,
});

export function isValidCadence(value: unknown): value is number {
  return isInteger(value) && value >= 1 && value <= 1440;
}

export function isValidLimit(value: unknown): value is number | null {
  return value === null || (isInteger(value) && value >= 1 && value <= 100);
}

export function parseWatchdogSettings(text: string): WatchdogSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (!isValidCadence(parsed.intervalMinutes)) return undefined;
  if (!isValidLimit(parsed.maxPerHour) || !isValidLimit(parsed.maxPending)) return undefined;
  return {
    intervalMinutes: parsed.intervalMinutes,
    maxPerHour: parsed.maxPerHour,
    maxPending: parsed.maxPending,
  };
}

export function readWatchdogSettings(directory: string): WatchdogSettings {
  try {
    return parseWatchdogSettings(readFileSync(settingsPath(directory), "utf8")) ?? {
      ...DEFAULT_WATCHDOG_SETTINGS,
    };
  } catch {
    return { ...DEFAULT_WATCHDOG_SETTINGS };
  }
}

export function writeWatchdogSettings(directory: string, settings: WatchdogSettings): void {
  writeJsonAtomic(settingsPath(directory), settings);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
