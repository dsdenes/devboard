import { readFileSync } from "node:fs";
import { isInteger, isRecord } from "../issues/guards";
import { writeJsonAtomic } from "../watchdog/settings";
import { settingsPath } from "./paths";

/**
 * What the dashboard persists and the worker applies without a restart. The
 * deterministic detectors stay fixed; only the cadence, the filing caps, and
 * the decision gate's model and thresholds are settings.
 */

/** The pinned Jev model. The alias is never used: thresholds are tuned per version. */
export const JEV_DECISION_MODEL = "typesafe/jev-1.14";
/** Every positive question at or above this files; every negative one at or below it. */
export const DECISION_APPROVE_AT = 0.9;
/** Any positive question at or below this rejects; any negative one at or above it. */
export const DECISION_REJECT_AT = 0.1;
/** A rejected fingerprint waits this long before it is asked again. */
export const REJECT_COOLDOWN_HOURS = 168;
export const DEFAULT_MAX_PER_HOUR = 10;
export const DEFAULT_MAX_PENDING = 20;

export interface CoachSettings {
  intervalMinutes: number;
  maxPerHour: number | null;
  maxPending: number | null;
  /** The decision model every finding is gated through. */
  decisionModel: string;
  /** The gate files only when every question is this confident. */
  approveAt: number;
  /** The gate rejects when any question is this confident the other way. */
  rejectAt: number;
  /** Hours a rejected fingerprint stays out of the gate. */
  rejectCooldownHours: number;
}

export const DEFAULT_COACH_SETTINGS: CoachSettings = Object.freeze({
  intervalMinutes: 60,
  maxPerHour: DEFAULT_MAX_PER_HOUR,
  maxPending: DEFAULT_MAX_PENDING,
  decisionModel: JEV_DECISION_MODEL,
  approveAt: DECISION_APPROVE_AT,
  rejectAt: DECISION_REJECT_AT,
  rejectCooldownHours: REJECT_COOLDOWN_HOURS,
});

export function isValidCadence(value: unknown): value is number {
  return isInteger(value) && value >= 1 && value <= 1440;
}

export function isValidLimit(value: unknown): value is number | null {
  return value === null || (isInteger(value) && value >= 1 && value <= 100);
}

export function isValidDecisionModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200;
}

export function isValidThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

export function isValidCooldown(value: unknown): value is number {
  return isInteger(value) && value >= 1 && value <= 8760;
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
  const approveAt = isValidThreshold(parsed.approveAt)
    ? parsed.approveAt
    : DEFAULT_COACH_SETTINGS.approveAt;
  const rejectAt = isValidThreshold(parsed.rejectAt)
    ? parsed.rejectAt
    : DEFAULT_COACH_SETTINGS.rejectAt;
  return {
    intervalMinutes: parsed.intervalMinutes,
    maxPerHour: parsed.maxPerHour,
    maxPending: parsed.maxPending,
    decisionModel: isValidDecisionModel(parsed.decisionModel)
      ? parsed.decisionModel.trim()
      : DEFAULT_COACH_SETTINGS.decisionModel,
    approveAt: rejectAt < approveAt ? approveAt : DEFAULT_COACH_SETTINGS.approveAt,
    rejectAt: rejectAt < approveAt ? rejectAt : DEFAULT_COACH_SETTINGS.rejectAt,
    rejectCooldownHours: isValidCooldown(parsed.rejectCooldownHours)
      ? parsed.rejectCooldownHours
      : DEFAULT_COACH_SETTINGS.rejectCooldownHours,
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
