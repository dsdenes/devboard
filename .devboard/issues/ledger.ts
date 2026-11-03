import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isInteger, isRecord } from "./guards";
import { LEDGER_VERSION, ledgerPath } from "./paths";

/**
 * The ledger records which issue numbers a successful ACP prompt already
 * handled, keyed by the repository's state directory. It controls triggers
 * only; the prompt itself is never scoped. A closed issue that reopens is new
 * again because pruning drops entries that are no longer open.
 */

export interface HandledIssue {
  number: number;
  /** The run that handled it, or `legacy` for a migrated entry. */
  runId: string;
  at: string;
}

export interface Ledger {
  version: 1;
  handled: Record<string, HandledIssue>;
}

export function emptyLedger(): Ledger {
  return { version: LEDGER_VERSION, handled: {} };
}

function isEntry(value: unknown): value is HandledIssue {
  return (
    isRecord(value) &&
    isInteger(value.number) &&
    typeof value.runId === "string" &&
    typeof value.at === "string"
  );
}

export function parseLedger(text: string): Ledger | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== LEDGER_VERSION) return undefined;
  if (!isRecord(parsed.handled)) return undefined;
  const handled: Record<string, HandledIssue> = {};
  for (const [key, value] of Object.entries(parsed.handled)) {
    if (!isEntry(value)) return undefined;
    handled[key] = value;
  }
  return { version: LEDGER_VERSION, handled };
}

/** A missing or unusable ledger reads as empty. */
export function readLedger(stateDir: string, repoDir: string): Ledger {
  try {
    return parseLedger(readFileSync(ledgerPath(stateDir, repoDir), "utf8")) ?? emptyLedger();
  } catch {
    return emptyLedger();
  }
}

/** A damaged ledger is renamed aside, preserved, and read as empty. */
export function loadLedger(stateDir: string, repoDir: string): Ledger {
  const path = ledgerPath(stateDir, repoDir);
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

export function writeLedger(stateDir: string, repoDir: string, ledger: Ledger): void {
  const path = ledgerPath(stateDir, repoDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, path);
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

/** Drops entries whose issue is no longer open. */
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
