import { readFileSync } from "node:fs";
import { isInteger, isRecord } from "../issues/guards";
import { writeJsonAtomic } from "../watchdog/settings";
import { settingsPath } from "./paths";

/** What the dashboard persists and the worker applies without a restart. */
export interface CoachSettings {
  intervalMinutes: number;
  /** Empty means unlimited. */
  maxPerHour: number | null;
  /** Empty means unlimited. */
  maxPending: number | null;
}

export const DEFAULT_COACH_SETTINGS: CoachSettings = Object.freeze({
  intervalMinutes: 60,
  maxPerHour: null,
  maxPending: null,
});

export function isValidCadence(value: unknown): value is number {
  return isInteger(value) && value >= 1 && value <= 1440;
}

export function isValidLimit(value: unknown): value is number | null {
  return value === null || (isInteger(value) && value >= 1 && value <= 100);
}

export function parseCoachSettings(text: string): CoachSettings | undefined {
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

export function readCoachSettings(directory: string): CoachSettings {
  try {
    return (
      parseCoachSettings(readFileSync(settingsPath(directory), "utf8")) ?? {
        ...DEFAULT_COACH_SETTINGS,
      }
    );
  } catch {
    return { ...DEFAULT_COACH_SETTINGS };
  }
}

export function writeCoachSettings(directory: string, settings: CoachSettings): void {
  writeJsonAtomic(settingsPath(directory), settings);
}
