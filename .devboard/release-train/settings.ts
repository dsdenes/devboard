import { readFileSync } from "node:fs";
import { isInteger, isRecord } from "../issues/guards";
import { writeJsonAtomic } from "../watchdog/settings";
import { settingsPath } from "./paths";

/**
 * The Release Train's cadence and filing caps. The train files no issues, but
 * it keeps the same settings shape as every background family so the shared
 * page's cadence and limit fields work unchanged. A missing or invalid file
 * falls back to the defaults; it never prevents a tick.
 */

/** Ten minutes: the scheduled release cadence. */
export const DEFAULT_INTERVAL_MINUTES = 10;
export const CADENCE_MIN_MINUTES = 1;
export const CADENCE_MAX_MINUTES = 1440;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;

export interface ReleaseTrainSettings {
  intervalMinutes: number;
  maxPerHour: number | null;
  maxPending: number | null;
}

export const DEFAULT_SETTINGS: ReleaseTrainSettings = Object.freeze({
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  maxPerHour: null,
  maxPending: null,
});

export function isValidCadence(value: unknown): value is number {
  return isInteger(value) && value >= CADENCE_MIN_MINUTES && value <= CADENCE_MAX_MINUTES;
}

export function isValidLimit(value: unknown): value is number | null {
  return value === null || (isInteger(value) && value >= LIMIT_MIN && value <= LIMIT_MAX);
}

export function parseSettings(text: string): ReleaseTrainSettings | undefined {
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
      : DEFAULT_INTERVAL_MINUTES,
    maxPerHour: isValidLimit(parsed.maxPerHour) ? parsed.maxPerHour : null,
    maxPending: isValidLimit(parsed.maxPending) ? parsed.maxPending : null,
  };
}

export function readSettings(directory: string): ReleaseTrainSettings {
  try {
    return parseSettings(readFileSync(settingsPath(directory), "utf8")) ?? { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(directory: string, settings: ReleaseTrainSettings): void {
  writeJsonAtomic(settingsPath(directory), settings);
}
