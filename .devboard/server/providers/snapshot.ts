import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProviderId, type ProviderId } from "./catalog";
import { providersDirectory } from "./store";

/**
 * The dashboard's last provider decision, written beside the credential store.
 * A detached worker that outlives the credential list (the Coach finalizer, for
 * one) reads it so every peer it starts follows the same selection the status
 * bar reports, without probing the usage endpoint itself.
 */

export interface SelectionSnapshot {
  version: 1;
  provider: ProviderId;
  subscriptionId: string;
  label: string;
  model: string;
  remainingFraction: number | null;
  checkedAt: string;
}

export function selectionSnapshotPath(stateDir: string): string {
  return join(providersDirectory(stateDir), "selection.json");
}

function isSnapshot(value: unknown): value is SelectionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    isProviderId(record.provider) &&
    typeof record.subscriptionId === "string" &&
    record.subscriptionId.length > 0 &&
    typeof record.label === "string" &&
    typeof record.model === "string" &&
    (record.remainingFraction === null ||
      (typeof record.remainingFraction === "number" &&
        Number.isFinite(record.remainingFraction))) &&
    typeof record.checkedAt === "string"
  );
}

/** Writes the selection atomically; the file carries no key material. */
export function writeSelectionSnapshot(
  stateDir: string,
  selection: Omit<SelectionSnapshot, "version">,
): void {
  const directory = providersDirectory(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = selectionSnapshotPath(stateDir);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...selection })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file never existed or the rename already consumed it.
    }
    throw error;
  }
}

export function readSelectionSnapshot(stateDir: string): SelectionSnapshot | undefined {
  let text: string;
  try {
    text = readFileSync(selectionSnapshotPath(stateDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isSnapshot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Removes a selection that is no longer valid (no eligible provider). */
export function removeSelectionSnapshot(stateDir: string): void {
  try {
    unlinkSync(selectionSnapshotPath(stateDir));
  } catch {
    // Nothing to remove.
  }
}
