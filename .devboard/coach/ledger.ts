import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isRecord } from "../issues/guards";
import type { CoachFinding } from "./findings";
import { LEDGER_VERSION, ledgerPath } from "./paths";

/**
 * The ledger remembers every fingerprint Coach has seen, the issue it owns,
 * and the gate decision that kept it out. It is written atomically after every
 * filing, rejection, or comment, so a hard kill can never lose an outcome.
 *
 * A disposition is `pending`, `filed:<url>`, or `rejected`. A rejected entry
 * carries the probabilities that rejected it and the count at that moment, so
 * a doubled recurrence re-opens it before its cool-down ends.
 */

export interface CoachDecisionRecord {
  at: string;
  model: string;
  /** `file` is kept for audit; a filed entry is `filed:<url>`. */
  outcome: "file" | "reject" | "review";
  probabilities: Record<string, number>;
  /** The finding's window count when the gate decided. */
  count: number;
  requestId?: string;
  costUsd?: number;
  reason?: string;
  /** The instant a rejection may be asked again. */
  rejectedUntil?: string;
}

export interface CoachLedgerEntry {
  category: string;
  /** The finding's one-line summary, bounded to 80 characters. */
  line: string;
  /** The full normalized signature the fingerprint covers. */
  subject: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  disposition: "pending" | `filed:${string}` | "rejected";
  url?: string;
  filedAt?: string;
  lastCommentAt?: string;
  /** Why the last filing, comment, or gate call failed, or absent after a success. */
  reason?: string;
  decision?: CoachDecisionRecord;
}

export interface CoachLedger {
  version: typeof LEDGER_VERSION;
  findings: Record<string, CoachLedgerEntry>;
  /** Fingerprints waiting for a successful filing or comment. */
  pendingFiling: string[];
}

export function emptyLedger(): CoachLedger {
  return { version: LEDGER_VERSION, findings: {}, pendingFiling: [] };
}

function parseProbabilities(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const probabilities: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1) {
      return undefined;
    }
    probabilities[key] = entry;
  }
  return probabilities;
}

function parseDecision(value: unknown): CoachDecisionRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.at !== "string" || typeof value.model !== "string") return undefined;
  if (value.outcome !== "file" && value.outcome !== "reject" && value.outcome !== "review") {
    return undefined;
  }
  const probabilities = parseProbabilities(value.probabilities);
  if (probabilities === undefined) return undefined;
  const count = Number(value.count);
  return {
    at: value.at,
    model: value.model,
    outcome: value.outcome,
    probabilities,
    count: Number.isFinite(count) && count > 0 ? count : 1,
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
    ...(typeof value.costUsd === "number" && Number.isFinite(value.costUsd)
      ? { costUsd: value.costUsd }
      : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.rejectedUntil === "string" ? { rejectedUntil: value.rejectedUntil } : {}),
  };
}

function parseEntry(value: unknown): CoachLedgerEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.category !== "string" || typeof value.line !== "string") return undefined;
  if (typeof value.subject !== "string") return undefined;
  if (typeof value.firstSeen !== "string" || typeof value.lastSeen !== "string") return undefined;
  const disposition = value.disposition;
  if (
    disposition !== "pending" &&
    disposition !== "rejected" &&
    !(typeof disposition === "string" && disposition.startsWith("filed:"))
  ) {
    return undefined;
  }
  const count = Number(value.count);
  const url =
    typeof value.url === "string"
      ? value.url
      : typeof disposition === "string" && disposition.startsWith("filed:")
        ? disposition.slice("filed:".length)
        : undefined;
  if (
    typeof disposition === "string" &&
    disposition.startsWith("filed:") &&
    (url === undefined || url.length === 0)
  ) {
    return undefined;
  }
  const decision = parseDecision(value.decision);
  return {
    category: value.category,
    line: value.line,
    subject: value.subject,
    firstSeen: value.firstSeen,
    lastSeen: value.lastSeen,
    count: Number.isFinite(count) && count > 0 ? count : 1,
    disposition: disposition as CoachLedgerEntry["disposition"],
    ...(url === undefined || url.length === 0 ? {} : { url }),
    ...(typeof value.filedAt === "string" ? { filedAt: value.filedAt } : {}),
    ...(typeof value.lastCommentAt === "string" ? { lastCommentAt: value.lastCommentAt } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(decision === undefined ? {} : { decision }),
  };
}

export function loadLedger(directory: string): CoachLedger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(directory), "utf8"));
    if (!isRecord(parsed) || parsed.version !== LEDGER_VERSION) return emptyLedger();
    const findings: Record<string, CoachLedgerEntry> = {};
    if (isRecord(parsed.findings)) {
      for (const [fingerprint, value] of Object.entries(parsed.findings)) {
        const entry = parseEntry(value);
        if (entry !== undefined) findings[fingerprint] = entry;
      }
    }
    const pending = Array.isArray(parsed.pendingFiling)
      ? parsed.pendingFiling.filter(
          (value): value is string => typeof value === "string" && findings[value] !== undefined,
        )
      : [];
    return { version: LEDGER_VERSION, findings, pendingFiling: [...new Set(pending)] };
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(directory: string, ledger: CoachLedger): void {
  mkdirSync(directory, { recursive: true });
  const path = ledgerPath(directory);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, path);
}

/** True when the fingerprint already owns an issue. */
export function isFiled(entry: CoachLedgerEntry | undefined): boolean {
  return entry !== undefined && entry.disposition.startsWith("filed:");
}

/** True when the gate rejected the fingerprint and its cool-down has not ended. */
export function isRejected(entry: CoachLedgerEntry | undefined): boolean {
  return entry !== undefined && entry.disposition === "rejected";
}

/**
 * Whether this cycle's evidence deserves a gate call. A filed fingerprint never
 * does; a rejection waits for its cool-down, unless the evidence at least
 * doubled since the rejection.
 */
export function needsDecision(
  entry: CoachLedgerEntry | undefined,
  finding: CoachFinding,
  now: Date,
): boolean {
  if (entry === undefined) return true;
  if (isFiled(entry)) return false;
  if (entry.disposition === "pending") return true;
  const decision = entry.decision;
  if (decision === undefined) return true;
  if (decision.count > 0 && finding.count >= decision.count * 2) return true;
  const until = decision.rejectedUntil === undefined ? Number.NaN : Date.parse(decision.rejectedUntil);
  return !Number.isFinite(until) || until <= now.getTime();
}

/**
 * Records every finding in the window. A fingerprint keeps its first sighting
 * and extends its last sighting and count; the line and subject follow the
 * newest evidence so the owned issue's title stays current.
 */
export function recordFindings(ledger: CoachLedger, findings: CoachFinding[], now: Date): void {
  const stamp = now.toISOString();
  for (const finding of findings) {
    const entry = ledger.findings[finding.fingerprint];
    if (entry === undefined) {
      ledger.findings[finding.fingerprint] = {
        category: finding.category,
        line: finding.line,
        subject: finding.subject,
        firstSeen: finding.firstAt < stamp ? finding.firstAt : stamp,
        lastSeen: stamp,
        count: finding.count,
        disposition: "pending",
      };
      continue;
    }
    entry.category = finding.category;
    entry.line = finding.line;
    entry.subject = finding.subject;
    entry.lastSeen = stamp;
    entry.count += finding.count;
  }
}

export function markFiled(
  ledger: CoachLedger,
  fingerprint: string,
  url: string,
  now: Date,
): void {
  const entry = ledger.findings[fingerprint];
  if (entry === undefined) return;
  entry.disposition = `filed:${url}`;
  entry.url = url;
  entry.filedAt = now.toISOString();
  delete entry.reason;
  ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
}

export function markCommented(ledger: CoachLedger, fingerprint: string, now: Date): void {
  const entry = ledger.findings[fingerprint];
  if (entry === undefined) return;
  entry.lastCommentAt = now.toISOString();
  delete entry.reason;
  ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
}

/** The fingerprint waits for the next cycle; the reason stays visible. */
export function markPending(ledger: CoachLedger, fingerprint: string, reason?: string): void {
  const entry = ledger.findings[fingerprint];
  if (entry !== undefined && reason !== undefined && reason.length > 0) entry.reason = reason;
  if (!ledger.pendingFiling.includes(fingerprint)) ledger.pendingFiling.push(fingerprint);
}

/** The gate said no, or could not decide. The record is the audit trail. */
export function markRejected(
  ledger: CoachLedger,
  fingerprint: string,
  decision: CoachDecisionRecord,
): void {
  const entry = ledger.findings[fingerprint];
  if (entry === undefined) return;
  entry.disposition = "rejected";
  entry.decision = decision;
  if (decision.reason !== undefined) entry.reason = decision.reason;
  else delete entry.reason;
  ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
}
