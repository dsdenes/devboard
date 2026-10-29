import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./findings";

/**
 * The ledger remembers every distinct signal and the GitHub issue it owns. It
 * is harness state under `.tmp`, never committed, and it survives cycles so a
 * recurrence comments on the existing issue instead of filing another one.
 */

export const LEDGER_VERSION = 2;

export interface LedgerInstance {
  repoDir: string;
  port: number;
  pid: number;
  journal: string;
}

export interface LedgerEntry {
  category: string;
  /** Last observed normalized evidence line. */
  line: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  /**
   * `filed:<url>` once the issue exists, `duplicate:<url>` while the
   * deduplication agent reports an open issue covering the finding, `none`
   * before the first decision.
   */
  disposition: string;
  url?: string;
  filedAt?: string;
  lastCommentAt?: string;
  /** The open issue the deduplication agent matched; never a filed issue. */
  duplicateOf?: string;
  matchedAt?: string;
  /** Every dashboard that has produced this signal. */
  instances: LedgerInstance[];
}

export interface Ledger {
  version: typeof LEDGER_VERSION;
  findings: Record<string, LedgerEntry>;
  /** Fingerprints whose `gh issue create` failed and are retried first. */
  pendingFiling: string[];
}

/** The version 2 ledger, used when no file exists or the file is unusable. */
export function emptyLedger(): Ledger {
  return { version: LEDGER_VERSION, findings: {}, pendingFiling: [] };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function instances(value: unknown): LedgerInstance[] {
  if (!Array.isArray(value)) return [];
  const parsed: LedgerInstance[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.repoDir !== "string" || typeof record.journal !== "string") continue;
    const port = Number(record.port);
    const pid = Number(record.pid);
    if (!Number.isInteger(port) || !Number.isInteger(pid)) continue;
    parsed.push({ repoDir: record.repoDir, port, pid, journal: record.journal });
  }
  return parsed;
}

/** One entry, or undefined when the record cannot be trusted. */
function parseEntry(fingerprint: string, value: unknown): LedgerEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const disposition = text(record.disposition, "");
  if (
    disposition !== "none" &&
    !disposition.startsWith("filed:") &&
    !disposition.startsWith("duplicate:")
  ) {
    return undefined;
  }
  const url =
    typeof record.url === "string"
      ? record.url
      : disposition.startsWith("filed:")
        ? disposition.slice("filed:".length)
        : undefined;
  if (disposition.startsWith("filed:") && (url === undefined || url.length === 0)) return undefined;
  const duplicateOf = disposition.startsWith("duplicate:")
    ? disposition.slice("duplicate:".length)
    : typeof record.duplicateOf === "string"
      ? record.duplicateOf
      : undefined;
  if (disposition.startsWith("duplicate:") && (duplicateOf === undefined || duplicateOf.length === 0)) {
    return undefined;
  }
  if (typeof record.category !== "string" || typeof record.line !== "string") return undefined;
  if (typeof record.firstSeen !== "string" || typeof record.lastSeen !== "string") return undefined;
  const count = Number(record.count);
  return {
    category: record.category,
    line: record.line,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
    count: Number.isFinite(count) && count > 0 ? count : 1,
    disposition,
    ...(url === undefined ? {} : { url }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
    ...(typeof record.filedAt === "string" ? { filedAt: record.filedAt } : {}),
    ...(typeof record.lastCommentAt === "string" ? { lastCommentAt: record.lastCommentAt } : {}),
    ...(typeof record.matchedAt === "string" ? { matchedAt: record.matchedAt } : {}),
    instances: instances(record.instances),
  };
}

/**
 * Reads the ledger. A version 1 file recorded `blocked:*` and `published:<sha>`
 * dispositions from the retired fix pipeline: those entries describe prose, not
 * issues, so they are discarded instead of migrated.
 */
export function loadLedger(stateDir: string): Ledger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return emptyLedger();
    const record = parsed as Record<string, unknown>;
    if (record.version !== LEDGER_VERSION) return emptyLedger();
    const findings: Record<string, LedgerEntry> = {};
    const source = record.findings;
    if (typeof source === "object" && source !== null) {
      for (const [fingerprint, value] of Object.entries(source)) {
        const entry = parseEntry(fingerprint, value);
        if (entry !== undefined) findings[fingerprint] = entry;
      }
    }
    const pending = Array.isArray(record.pendingFiling)
      ? record.pendingFiling.filter(
          (value): value is string => typeof value === "string" && findings[value] !== undefined,
        )
      : [];
    return { version: LEDGER_VERSION, findings, pendingFiling: [...new Set(pending)] };
  } catch {
    return emptyLedger();
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
    const contributed = finding.instances.map((instance) => ({
      repoDir: instance.repoDir,
      port: instance.port,
      pid: instance.pid,
      journal: instance.journal,
    }));
    if (entry === undefined) {
      ledger.findings[finding.fingerprint] = {
        category: finding.category,
        line: finding.quote,
        firstSeen: stamp,
        lastSeen: stamp,
        count: 1,
        disposition: "none",
        instances: contributed,
      };
      continue;
    }
    entry.category = finding.category;
    entry.line = finding.quote;
    entry.lastSeen = stamp;
    entry.count += 1;
    for (const instance of contributed) {
      if (!entry.instances.some((known) => known.journal === instance.journal)) {
        entry.instances.push(instance);
      }
    }
  }
}

export function markFiled(ledger: Ledger, fingerprint: string, url: string, now: Date): void {
  const entry = ledger.findings[fingerprint];
  if (entry === undefined) return;
  entry.disposition = `filed:${url}`;
  entry.url = url;
  entry.filedAt = now.toISOString();
  ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
}

/**
 * Records that the deduplication agent found an open issue covering this
 * finding. The entry is not filed: it keeps no issue URL, takes no recurrence
 * comment, and becomes a candidate again once that issue is closed.
 */
export function markDuplicate(
  ledger: Ledger,
  fingerprint: string,
  url: string,
  now: Date,
): void {
  const entry = ledger.findings[fingerprint];
  if (entry === undefined) return;
  entry.disposition = `duplicate:${url}`;
  entry.duplicateOf = url;
  entry.matchedAt = now.toISOString();
  ledger.pendingFiling = ledger.pendingFiling.filter((pending) => pending !== fingerprint);
}

export function markCommented(ledger: Ledger, fingerprint: string, now: Date): void {
  const entry = ledger.findings[fingerprint];
  if (entry === undefined) return;
  entry.lastCommentAt = now.toISOString();
}

/** The fingerprint is waiting for a retry until its filing succeeds. */
export function markPending(ledger: Ledger, fingerprint: string): void {
  if (!ledger.pendingFiling.includes(fingerprint)) ledger.pendingFiling.push(fingerprint);
}
