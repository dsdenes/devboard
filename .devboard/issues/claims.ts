import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInteger, isRecord } from "./guards";
import { pidAlive } from "./lock";

/**
 * Repository-anchored claims for issue runs. Every worker version, whichever
 * state directory it serves, claims an issue before starting its peer, so one
 * issue never produces two peers. A claim whose owner is gone is reclaimable.
 */

export interface IssueClaim {
  number: number;
  pid: number;
  runId: string;
  harnessVersion: string | null;
}

/** `<REPO_DIR>/.devboard/.tmp/issues/claims`. */
export function claimsDirectory(repoDir: string): string {
  return join(resolve(repoDir), ".devboard", ".tmp", "issues", "claims");
}

function claimPath(repoDir: string, number: number): string {
  return join(claimsDirectory(repoDir), `${number}.json`);
}

function parseClaim(text: string): IssueClaim | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isInteger(parsed.number) || !isInteger(parsed.pid)) return undefined;
    if (typeof parsed.runId !== "string") return undefined;
    return {
      number: parsed.number,
      pid: parsed.pid,
      runId: parsed.runId,
      harnessVersion: typeof parsed.harnessVersion === "string" ? parsed.harnessVersion : null,
    };
  } catch {
    return undefined;
  }
}

export function readIssueClaim(repoDir: string, number: number): IssueClaim | undefined {
  try {
    return parseClaim(readFileSync(claimPath(repoDir, number), "utf8"));
  } catch {
    return undefined;
  }
}

/** Every claim still held by a live process; stale files are removed. */
export function liveIssueClaims(repoDir: string): IssueClaim[] {
  let names: string[];
  try {
    names = readdirSync(claimsDirectory(repoDir));
  } catch {
    return [];
  }
  const claims: IssueClaim[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(claimsDirectory(repoDir), name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const claim = parseClaim(text);
    if (claim === undefined || !pidAlive(claim.pid)) {
      try {
        unlinkSync(path);
      } catch {
        // Another worker reclaimed it.
      }
      continue;
    }
    claims.push(claim);
  }
  return claims;
}

/**
 * Claims one issue for this process. Returns false when another live worker
 * already holds it; an existing claim by this same run is idempotent.
 */
export function claimIssue(
  repoDir: string,
  number: number,
  details: { runId: string; harnessVersion: string | null },
): boolean {
  mkdirSync(claimsDirectory(repoDir), { recursive: true });
  const path = claimPath(repoDir, number);
  const claim: IssueClaim = { number, pid: process.pid, ...details };
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
      const existing = readIssueClaim(repoDir, number);
      if (existing === undefined) continue;
      if (existing.pid === process.pid && existing.runId === details.runId) return true;
      if (pidAlive(existing.pid)) return false;
      try {
        unlinkSync(path);
      } catch {
        // Another worker reclaimed it.
      }
    }
  }
  return false;
}

/** Releases a claim this process owns; another owner's claim is untouched. */
export function releaseIssueClaim(repoDir: string, number: number): void {
  const existing = readIssueClaim(repoDir, number);
  if (existing === undefined || existing.pid !== process.pid) return;
  try {
    unlinkSync(claimPath(repoDir, number));
  } catch {
    // Already released.
  }
}
