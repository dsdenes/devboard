import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isRecord } from "../issues/guards";
import type { CoachFinding } from "./findings";
import { LEDGER_VERSION, ledgerPath } from "./paths";

/**
 * The ledger remembers every fingerprint Coach has seen and the issue it owns.
 * It is written atomically after every successful filing or comment, so a hard
 * kill can never lose the fact that an issue already exists.
 *
 * A disposition is exactly `pending` or `filed:<url>`; the pending queue holds
 * fingerprints still waiting for a successful filing or comment.
 */

export interface CoachLedgerEntry {
  category: string;
  /** The finding's one-line summary, bounded to 80 characters. */
  line: string;
  /** The full normalized signature the fingerprint covers. */
  subject: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  disposition: "pending" | `filed:${string}`;
  url?: string;
  filedAt?: string;
  lastCommentAt?: string;
  /** Why the last filing or comment failed, or absent after a success. */
  reason?: string;
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

function parseEntry(value: unknown): CoachLedgerEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.category !== "string" || typeof value.line !== "string") return undefined;
  if (typeof value.subject !== "string") return undefined;
  if (typeof value.firstSeen !== "string" || typeof value.lastSeen !== "string") return undefined;
  const disposition = value.disposition;
  if (
    disposition !== "pending" &&
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
  if (typeof disposition === "string" && disposition.startsWith("filed:") && (url === undefined || url.length === 0)) {
    return undefined;
  }
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
