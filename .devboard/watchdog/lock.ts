import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { isInteger, isRecord } from "../issues/guards";
import { pidAlive } from "../issues/lock";

/**
 * The watchdog family's cycle lease. Worker versions run side by side during a
 * takeover, so the legacy machine-wide worker lock no longer proves that no
 * other version is in the middle of a cycle. This one claim, published
 * atomically and held only for the duration of a cycle, is what makes a unit
 * run exactly once even while two versions are live.
 */

export interface CycleClaim {
  pid: number;
  startedAt: string;
  harnessVersion: string | null;
  /** Per-acquisition identity, so a release never removes a newer claim. */
  token: string;
}

function parseClaim(text: string): CycleClaim | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
  if (typeof parsed.startedAt !== "string" || typeof parsed.token !== "string") return undefined;
  return {
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    harnessVersion: typeof parsed.harnessVersion === "string" ? parsed.harnessVersion : null,
    token: parsed.token,
  };
}

/** The claim at `path`, live or stale, when it is readable. */
export function readCycleClaim(path: string): CycleClaim | undefined {
  try {
    return parseClaim(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The claim at `path` while its owner is still alive. */
export function liveCycleClaim(path: string): CycleClaim | undefined {
  const claim = readCycleClaim(path);
  if (claim === undefined || !pidAlive(claim.pid)) return undefined;
  return claim;
}

function sameClaim(path: string, token: string): boolean {
  const current = readCycleClaim(path);
  return current !== undefined && current.token === token;
}

/**
 * Claims the family's next cycle, or reports undefined when another live
 * worker holds it. A claim whose owner exited is reclaimed once; the returned
 * release removes only this acquisition's claim.
 */
export function claimCycle(
  path: string,
  details: { harnessVersion: string | null },
): { claim: CycleClaim; release: () => void } | undefined {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  const claim: CycleClaim = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    harnessVersion: details.harnessVersion,
    token,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Publish a complete claim atomically: a reader must never see the empty
    // window of a live claim and discard the owner's cycle.
    const staged = `${path}.new-${process.pid}-${randomUUID()}`;
    try {
      try {
        const descriptor = openSync(staged, "wx");
        try {
          writeSync(descriptor, `${JSON.stringify(claim)}\n`);
        } finally {
          closeSync(descriptor);
        }
        linkSync(staged, path);
      } finally {
        try {
          unlinkSync(staged);
        } catch {
          // The staged name is removed whether the link won or lost.
        }
      }
      return {
        claim,
        release() {
          if (!sameClaim(path, token)) return;
          try {
            unlinkSync(path);
          } catch {
            // The operator or a reclaimer already removed it.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      const current = readCycleClaim(path);
      if (current !== undefined && pidAlive(current.pid)) return undefined;
      try {
        unlinkSync(path);
      } catch {
        // A concurrent claimant already reclaimed it.
      }
    }
  }
  return undefined;
}
