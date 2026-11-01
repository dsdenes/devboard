import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isInteger, isRecord } from "../guards";
import { pidAlive } from "../lock";

/**
 * Repository-anchored claims for Auto Scout scans. A checkout runs one scan at
 * a time, whichever worker version and state directory hosts it, so two
 * harness versions alive during a takeover never scan the same repository
 * concurrently. The old worker holds the claim for its in-flight scan; the
 * newest worker claims the next scan after the old worker finishes and exits.
 */

export interface ScoutScanClaim {
  pid: number;
  startedAt: string;
  harnessVersion: string | null;
  /** The scan this worker is running, or null until its directory exists. */
  scanId: string | null;
}

/** `<REPO_DIR>/.devboard/.tmp/scout/scan-claim.json`: the one scan slot. */
export function scanClaimPath(repoDir: string): string {
  return join(resolve(repoDir), ".devboard", ".tmp", "scout", "scan-claim.json");
}

function parseClaim(text: string): ScoutScanClaim | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isInteger(parsed.pid)) return undefined;
    if (typeof parsed.startedAt !== "string") return undefined;
    if (!(parsed.harnessVersion === null || typeof parsed.harnessVersion === "string")) {
      return undefined;
    }
    if (!(parsed.scanId === null || typeof parsed.scanId === "string")) return undefined;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      harnessVersion: parsed.harnessVersion,
      scanId: parsed.scanId,
    };
  } catch {
    return undefined;
  }
}

export function readScanClaim(repoDir: string): ScoutScanClaim | undefined {
  try {
    return parseClaim(readFileSync(scanClaimPath(repoDir), "utf8"));
  } catch {
    return undefined;
  }
}

/** The claim while its owner is alive; a dead owner's file is removed. */
export function liveScanClaim(repoDir: string): ScoutScanClaim | undefined {
  const claim = readScanClaim(repoDir);
  if (claim === undefined) return undefined;
  if (pidAlive(claim.pid)) return claim;
  clearScanClaim(repoDir, claim.pid);
  return undefined;
}

function clearScanClaim(repoDir: string, pid: number): void {
  const existing = readScanClaim(repoDir);
  if (existing !== undefined && existing.pid !== pid) return;
  try {
    unlinkSync(scanClaimPath(repoDir));
  } catch {
    // Another worker reclaimed it.
  }
}

/**
 * Claims the repository's one scan slot. Returns false when another live
 * worker holds it; the caller starts no scan and retries on a later tick.
 */
export function claimScan(
  repoDir: string,
  details: { harnessVersion: string | null; scanId: string | null },
): boolean {
  const path = scanClaimPath(repoDir);
  mkdirSync(dirname(path), { recursive: true });
  const claim: ScoutScanClaim = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...details,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx");
      try {
        writeSync(descriptor, `${JSON.stringify(claim)}\n`);
      } finally {
        closeSync(descriptor);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      const existing = readScanClaim(repoDir);
      if (existing === undefined) {
        try {
          unlinkSync(path);
        } catch {
          // Another worker reclaimed the unreadable file.
        }
        continue;
      }
      if (pidAlive(existing.pid)) return false;
      clearScanClaim(repoDir, existing.pid);
    }
  }
  return false;
}

/** Records the scan id once the claimed scan directory exists. */
export function updateScanClaim(repoDir: string, scanId: string): void {
  const existing = readScanClaim(repoDir);
  if (existing === undefined || existing.pid !== process.pid) return;
  const path = scanClaimPath(repoDir);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...existing, scanId })}\n`);
    renameSync(temporary, path);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary name is harmless when the write itself failed.
    }
  }
}

/** Releases the claim this process owns; another owner's claim is untouched. */
export function releaseScanClaim(repoDir: string): void {
  const existing = readScanClaim(repoDir);
  if (existing === undefined || existing.pid !== process.pid) return;
  try {
    unlinkSync(scanClaimPath(repoDir));
  } catch {
    // Already released.
  }
}
