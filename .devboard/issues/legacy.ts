import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isRecord } from "./guards";
import { parseLedger, type HandledIssue } from "./ledger";
import { pidAlive, readLock, type LockOwner } from "./lock";
import { legacyLedgerPath, legacyLockPath, legacyStatePath, ledgerPath } from "./paths";

/**
 * The removed systemd orchestrator left three facts worth reading exactly
 * once: its handled issue numbers, its state's root, and a live lock. Nothing
 * here starts, stops, or edits that process; the operator owns its cleanup.
 */

export function legacyLiveLock(stateDir: string): LockOwner | undefined {
  const path = legacyLockPath(stateDir);
  const owner = readLock(path);
  if (owner === undefined || !pidAlive(owner.pid)) return undefined;
  return owner;
}

export function legacyLockRefusal(owner: LockOwner, stateDir: string): string {
  return (
    `the legacy devboard-orchestrator still holds ${legacyLockPath(stateDir)} (pid ${owner.pid}). ` +
    "Stop it with 'systemctl --user stop devboard-orchestrator.service', disable it with " +
    "'systemctl --user disable devboard-orchestrator.service', remove " +
    "'$HOME/.config/systemd/user/devboard-orchestrator.service', then run " +
    "'systemctl --user daemon-reload'."
  );
}

function legacyRootMatches(stateDir: string, repoDir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(legacyStatePath(stateDir), "utf8"));
    if (!isRecord(parsed) || typeof parsed.root !== "string") return false;
    return resolve(parsed.root) === resolve(repoDir);
  } catch {
    return false;
  }
}

/**
 * Copies the legacy handled numbers into the repository-keyed ledger, but only
 * when that ledger does not exist yet, the legacy state parses, and its root
 * names this checkout. Missing, damaged, or mismatched legacy files are
 * ignored; the legacy bytes are never rewritten.
 */
export function migrateLegacyLedger(options: {
  stateDir: string;
  repoDir: string;
  now?: Date;
}): HandledIssue[] | undefined {
  if (existsSync(ledgerPath(options.stateDir, options.repoDir))) return undefined;
  if (!legacyRootMatches(options.stateDir, options.repoDir)) return undefined;
  let text: string;
  try {
    text = readFileSync(legacyLedgerPath(options.stateDir), "utf8");
  } catch {
    return undefined;
  }
  const ledger = parseLedger(text);
  if (ledger === undefined) return undefined;
  const at = (options.now ?? new Date()).toISOString();
  return Object.values(ledger.handled).map((entry) => ({
    number: entry.number,
    runId: entry.runId,
    at: entry.at.length > 0 ? entry.at : at,
  }));
}
