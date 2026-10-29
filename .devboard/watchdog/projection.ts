import { readFileSync } from "node:fs";
import { isRecord } from "../issues/guards";
import { projectionPath, PROJECTION_VERSION } from "./paths";
import { writeJsonAtomic } from "./settings";

/**
 * The last GitHub projection the dashboard computed, persisted where the
 * worker can read it. A Watchdog cap counts open state only from this file and
 * files nothing new while its sync is not `ok`; without a cap the file is
 * ignored, so the default cycle is unchanged.
 */
export interface ProjectionIssue {
  url: string;
  state: "pending" | "implemented";
  version: string | null;
}

export interface WatchdogProjection {
  version: 1;
  state: "ok" | "error" | "stale";
  at: string | null;
  error: string | null;
  issues: ProjectionIssue[];
}

export function readProjection(directory: string): WatchdogProjection | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(projectionPath(directory), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== PROJECTION_VERSION) return undefined;
  if (parsed.state !== "ok" && parsed.state !== "error" && parsed.state !== "stale") {
    return undefined;
  }
  if (!(parsed.at === null || typeof parsed.at === "string")) return undefined;
  if (!(parsed.error === null || typeof parsed.error === "string")) return undefined;
  if (!Array.isArray(parsed.issues)) return undefined;
  const issues: ProjectionIssue[] = [];
  for (const entry of parsed.issues) {
    if (!isRecord(entry)) continue;
    if (typeof entry.url !== "string") continue;
    if (entry.state !== "pending" && entry.state !== "implemented") continue;
    if (!(entry.version === null || typeof entry.version === "string")) continue;
    issues.push({ url: entry.url, state: entry.state, version: entry.version });
  }
  return {
    version: PROJECTION_VERSION,
    state: parsed.state,
    at: parsed.at,
    error: parsed.error,
    issues,
  };
}

export function writeProjection(directory: string, projection: WatchdogProjection): void {
  writeJsonAtomic(projectionPath(directory), projection);
}
