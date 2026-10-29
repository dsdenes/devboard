import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isRecord } from "../issues/guards";
import type { CoachFamily, FamilyKind } from "./families";
import { LEDGER_VERSION, ledgerPath } from "./paths";

/**
 * The version-3 ledger: the newest evidence per family, the last action taken
 * for it, and the proposals a cap held back. It is written atomically after
 * every filing or queue change, so a hard kill never loses an outcome. A
 * version-2 ledger is discarded; deduplication then relies on the forge.
 */

export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const FAMILY_KINDS: readonly FamilyKind[] = Object.freeze([
  "command",
  "question",
  "run-failure",
]);

export type FamilyLastAction =
  | "filed"
  | "capped"
  | "none"
  | "duplicate"
  | "invalid"
  | "failed";

export const FAMILY_LAST_ACTIONS: readonly FamilyLastAction[] = Object.freeze([
  "filed",
  "capped",
  "none",
  "duplicate",
  "invalid",
  "failed",
]);

export interface CoachFamilyEntry {
  firstSeen: string;
  lastSeen: string;
  calls: number;
  sessions: number;
  kind: FamilyKind;
  lastAction: FamilyLastAction;
  lastIssueUrl?: string;
  /** The exact title the last filed issue carries; status renders it. */
  lastTitle?: string;
  /** When the last issue was filed, for the rolling-hour cap. */
  lastFiledAt?: string;
}

/** A validated proposal a cap held back; filed with its original bytes. */
export interface PendingFiling {
  family: string;
  kind: FamilyKind;
  title: string;
  body: string;
  score: number;
  createdAt: string;
}

export interface CoachLedger {
  version: typeof LEDGER_VERSION;
  families: Record<string, CoachFamilyEntry>;
  pendingFiling: PendingFiling[];
}

export interface LedgerLoad {
  ledger: CoachLedger;
  /** True when a non-version-3 ledger was discarded. */
  reset: boolean;
}

export function emptyLedger(): CoachLedger {
  return { version: LEDGER_VERSION, families: {}, pendingFiling: [] };
}

function isKind(value: unknown): value is FamilyKind {
  return typeof value === "string" && (FAMILY_KINDS as readonly string[]).includes(value);
}

function isLastAction(value: unknown): value is FamilyLastAction {
  return typeof value === "string" && (FAMILY_LAST_ACTIONS as readonly string[]).includes(value);
}

function parseEntry(value: unknown): CoachFamilyEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.firstSeen !== "string" ||
    typeof value.lastSeen !== "string" ||
    typeof value.calls !== "number" ||
    !Number.isFinite(value.calls) ||
    typeof value.sessions !== "number" ||
    !Number.isFinite(value.sessions)
  ) {
    return undefined;
  }
  if (!isKind(value.kind) || !isLastAction(value.lastAction)) return undefined;
  return {
    firstSeen: value.firstSeen,
    lastSeen: value.lastSeen,
    calls: value.calls,
    sessions: value.sessions,
    kind: value.kind,
    lastAction: value.lastAction,
    ...(typeof value.lastIssueUrl === "string" ? { lastIssueUrl: value.lastIssueUrl } : {}),
    ...(typeof value.lastTitle === "string" ? { lastTitle: value.lastTitle } : {}),
    ...(typeof value.lastFiledAt === "string" ? { lastFiledAt: value.lastFiledAt } : {}),
  };
}

function parsePending(value: unknown): PendingFiling | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.family !== "string" ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return undefined;
  }
  return {
    family: value.family,
    kind: isKind(value.kind) ? value.kind : "command",
    title: value.title,
    body: value.body,
    score: value.score,
    createdAt: value.createdAt,
  };
}

export function loadLedger(directory: string): LedgerLoad {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath(directory), "utf8"));
  } catch {
    return { ledger: emptyLedger(), reset: false };
  }
  if (!isRecord(parsed) || parsed.version !== LEDGER_VERSION) {
    return { ledger: emptyLedger(), reset: true };
  }
  const families: Record<string, CoachFamilyEntry> = {};
  if (isRecord(parsed.families)) {
    for (const [key, value] of Object.entries(parsed.families)) {
      const entry = parseEntry(value);
      if (entry !== undefined) families[key] = entry;
    }
  }
  const pending = Array.isArray(parsed.pendingFiling)
    ? parsed.pendingFiling
        .map((value) => parsePending(value))
        .filter((value): value is PendingFiling => value !== undefined)
    : [];
  return {
    ledger: { version: LEDGER_VERSION, families, pendingFiling: pending },
    reset: false,
  };
}

export function saveLedger(directory: string, ledger: CoachLedger): void {
  mkdirSync(directory, { recursive: true });
  const path = ledgerPath(directory);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * Records this cycle's families. A family keeps its earliest sighting and
 * carries the newest window's counts; the last action is untouched.
 */
export function recordFamilies(
  ledger: CoachLedger,
  families: CoachFamily[],
  now: Date,
): void {
  const stamp = now.toISOString();
  for (const family of families) {
    const entry = ledger.families[family.key];
    if (entry === undefined) {
      ledger.families[family.key] = {
        firstSeen: family.firstAt < stamp ? family.firstAt : stamp,
        lastSeen: family.lastAt,
        calls: family.calls,
        sessions: family.sessions.length,
        kind: family.kind,
        lastAction: "none",
      };
      continue;
    }
    if (family.firstAt < entry.firstSeen) entry.firstSeen = family.firstAt;
    entry.lastSeen = family.lastAt;
    entry.calls = family.calls;
    entry.sessions = family.sessions.length;
    entry.kind = family.kind;
  }
}

export interface MarkFamilyOptions {
  at: Date;
  issueUrl?: string;
  title?: string;
}

export function markFamily(
  ledger: CoachLedger,
  key: string,
  action: FamilyLastAction,
  options: MarkFamilyOptions,
): void {
  const entry = ledger.families[key];
  if (entry === undefined) return;
  entry.lastAction = action;
  if (action === "filed") {
    if (options.issueUrl !== undefined) entry.lastIssueUrl = options.issueUrl;
    if (options.title !== undefined) entry.lastTitle = options.title;
    entry.lastFiledAt = options.at.toISOString();
  }
}

export function removePending(ledger: CoachLedger, family: string): void {
  ledger.pendingFiling = ledger.pendingFiling.filter((entry) => entry.family !== family);
}

/** The queue keeps the highest-scoring entries up to `maxPending`. */
export function enqueuePending(
  ledger: CoachLedger,
  entry: PendingFiling,
  maxPending: number | null,
): PendingFiling[] {
  const all = [...ledger.pendingFiling.filter((value) => value.family !== entry.family), entry].sort(
    (left, right) =>
      right.score - left.score || left.createdAt.localeCompare(right.createdAt),
  );
  const kept = maxPending === null ? all : all.slice(0, maxPending);
  ledger.pendingFiling = kept;
  return all.slice(kept.length);
}

/** Drops queue entries older than seven days or absent from the window. */
export function dropStalePending(
  ledger: CoachLedger,
  familyKeys: ReadonlySet<string>,
  now: Date,
): PendingFiling[] {
  const kept: PendingFiling[] = [];
  const dropped: PendingFiling[] = [];
  for (const entry of ledger.pendingFiling) {
    const created = Date.parse(entry.createdAt);
    const stale =
      !Number.isFinite(created) ||
      now.getTime() - created > PENDING_MAX_AGE_MS ||
      !familyKeys.has(entry.family);
    if (stale) dropped.push(entry);
    else kept.push(entry);
  }
  ledger.pendingFiling = kept;
  return dropped;
}
