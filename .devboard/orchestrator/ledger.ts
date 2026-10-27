import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orchestratorDirectory } from "./state";

/**
 * The ledger remembers which issue numbers a successful run already handled,
 * so a poll never retriggers one while it stays open. It is harness state
 * under the orchestrator directory, never committed, and it survives restarts.
 * It controls triggers only: it never scopes the spawned command.
 */

export const LEDGER_VERSION = 1;

export interface HandledIssue {
  number: number;
  /** The run directory that handled it, a UTC timestamp name. */
  runId: string;
  at: string;
}

export interface Ledger {
  version: 1;
  handled: Record<string, HandledIssue>;
}

export function ledgerPath(stateDir: string): string {
  return join(orchestratorDirectory(stateDir), "ledger.json");
}

function isEntry(value: unknown): value is HandledIssue {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.number === "number" &&
    Number.isInteger(entry.number) &&
    typeof entry.runId === "string" &&
    typeof entry.at === "string"
  );
}

export function parseLedger(text: string): Ledger | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== LEDGER_VERSION) return undefined;
  if (typeof record.handled !== "object" || record.handled === null) return undefined;
  const handled: Record<string, HandledIssue> = {};
  for (const [key, value] of Object.entries(record.handled as Record<string, unknown>)) {
    if (!isEntry(value)) return undefined;
    handled[key] = value;
  }
  return { version: LEDGER_VERSION, handled };
}

function emptyLedger(): Ledger {
  return { version: LEDGER_VERSION, handled: {} };
}

/** A missing or unusable ledger reads as empty and is left exactly as found. */
export function readLedger(stateDir: string): Ledger {
  try {
    return parseLedger(readFileSync(ledgerPath(stateDir), "utf8")) ?? emptyLedger();
  } catch {
    return emptyLedger();
  }
}

/** A missing, damaged, or foreign ledger reads as empty and is kept aside. */
export function loadLedger(stateDir: string): Ledger {
  const path = ledgerPath(stateDir);
  if (!existsSync(path)) return emptyLedger();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyLedger();
  }
  const ledger = parseLedger(text);
  if (ledger !== undefined) return ledger;
  try {
    renameSync(path, `${path}.invalid-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  } catch {
    // The next successful run writes a fresh ledger anyway.
  }
  return emptyLedger();
}

export function writeLedger(stateDir: string, ledger: Ledger): void {
  const directory = orchestratorDirectory(stateDir);
  mkdirSync(directory, { recursive: true });
  const path = ledgerPath(stateDir);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, path);
}

export function handledNumbers(ledger: Ledger): Set<number> {
  return new Set(Object.values(ledger.handled).map((entry) => entry.number));
}

export function recordHandled(
  ledger: Ledger,
  issues: Array<{ number: number }>,
  runId: string,
  now: Date,
): Ledger {
  const handled = { ...ledger.handled };
  const at = now.toISOString();
  for (const issue of issues) {
    handled[String(issue.number)] = { number: issue.number, runId, at };
  }
  return { version: LEDGER_VERSION, handled };
}

/**
 * Drops entries whose issue is no longer open. A closed issue that reopens is
 * therefore new again, while one that stays open is never retriggered.
 */
export function pruneLedger(ledger: Ledger, open: Set<number>): Ledger {
  const handled: Record<string, HandledIssue> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(ledger.handled)) {
    if (open.has(entry.number)) {
      handled[key] = entry;
      continue;
    }
    changed = true;
  }
  return changed ? { version: LEDGER_VERSION, handled } : ledger;
}
