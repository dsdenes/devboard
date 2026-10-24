import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./findings";

/**
 * The ledger remembers what the watchdog already did about each distinct
 * signal. It is harness state under `.tmp`, never committed, and it survives
 * cycles so an unchanged window does not publish the same fix twice.
 */

export interface LedgerEntry {
  category: string;
  source: string;
  /** Normalized evidence line the disposition was decided on. */
  line: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  /** `published:<sha>`, `blocked:<reason>`, or `none`. */
  disposition: string;
  /** HEAD when a block was recorded; a new HEAD permits a retry. */
  head?: string;
}

export interface PendingPublish {
  /** The pushed commit whose publish failed. */
  commit: string;
  /** The findings that commit fixes. */
  findings: string[];
}

export interface Ledger {
  version: 1;
  findings: Record<string, LedgerEntry>;
  /** Session ids of earlier watchdog agent runs, excluded from evidence. */
  selfSessions: string[];
  /** A pushed revision whose publish has not succeeded yet. */
  pendingPublish?: PendingPublish;
}

export function loadLedger(stateDir: string): Ledger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const record = parsed as Partial<Ledger> & { findings?: unknown };
    const findings: Record<string, LedgerEntry> = {};
    if (typeof record.findings === "object" && record.findings !== null) {
      for (const [key, value] of Object.entries(record.findings)) {
        if (typeof value !== "object" || value === null) continue;
        findings[key] = value as LedgerEntry;
      }
    }
    const selfSessions = Array.isArray(record.selfSessions)
      ? record.selfSessions.filter((entry): entry is string => typeof entry === "string")
      : [];
    const pending = record.pendingPublish;
    const pendingPublish =
      typeof pending === "object" &&
      pending !== null &&
      typeof (pending as PendingPublish).commit === "string" &&
      Array.isArray((pending as PendingPublish).findings)
        ? {
            commit: (pending as PendingPublish).commit,
            findings: (pending as PendingPublish).findings.filter(
              (entry): entry is string => typeof entry === "string",
            ),
          }
        : undefined;
    return {
      version: 1,
      findings,
      selfSessions,
      ...(pendingPublish === undefined ? {} : { pendingPublish }),
    };
  } catch {
    return { version: 1, findings: {}, selfSessions: [] };
  }
}

export function saveLedger(stateDir: string, ledger: Ledger): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "state.json");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Records every finding in the window, creating or extending its entry. */
export function recordFindings(ledger: Ledger, findings: Finding[], now: Date): void {
  const stamp = now.toISOString();
  for (const finding of findings) {
    const entry = ledger.findings[finding.fingerprint];
    if (entry === undefined) {
      ledger.findings[finding.fingerprint] = {
        category: finding.category,
        source: finding.source,
        line: finding.quote,
        firstSeen: stamp,
        lastSeen: stamp,
        count: 1,
        disposition: "none",
      };
      continue;
    }
    entry.category = finding.category;
    entry.source = finding.source;
    entry.lastSeen = stamp;
    entry.count += 1;
  }
}

/** Marks an entry published at a commit. */
export function markPublished(ledger: Ledger, findings: Finding[], commit: string): void {
  for (const finding of findings) {
    const entry = ledger.findings[finding.fingerprint];
    if (entry === undefined) continue;
    entry.disposition = `published:${commit}`;
    entry.line = finding.quote;
    entry.head = commit;
  }
}

/** Marks an entry blocked for the current HEAD so the next cycle can retry it. */
export function markBlocked(
  ledger: Ledger,
  findings: Finding[],
  reason: string,
  head: string | null,
): void {
  for (const finding of findings) {
    const entry = ledger.findings[finding.fingerprint];
    if (entry === undefined) continue;
    entry.disposition = `blocked:${reason}`;
    entry.line = finding.quote;
    if (head !== null) entry.head = head;
  }
}

/** True when this exact evidence was already published or blocked at this HEAD. */
export function isSettled(
  entry: LedgerEntry | undefined,
  finding: Finding,
  head: string | null,
): boolean {
  if (entry === undefined) return false;
  if (entry.line !== finding.quote) return false;
  if (entry.disposition.startsWith("published:")) return true;
  if (entry.disposition.startsWith("blocked:")) {
    return head !== null && entry.head === head;
  }
  return false;
}
