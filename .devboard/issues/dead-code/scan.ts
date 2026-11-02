import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pickEntryPoint, type EntryPointSurface } from "../../lib/entry-point";
import {
  CYCLE_VERSION,
  DEAD_CODE_CATEGORIES,
  cycleDirectory,
  requestPath,
} from "./paths";

/**
 * One cycle's request. It is written before the prompt and read by the agent,
 * so the contract between the worker and `/dead-code-removal` is a file, not a
 * convention. The request names the seeded entry point, the caps, and the
 * titles that already exist.
 */

export interface CycleRequest {
  version: 1;
  cycleId: string;
  repository: string;
  repoDir: string;
  /** The surface and seeded entry point every crawl starts from. */
  surface: EntryPointSurface;
  seed: string;
  entryPoint: { path: string; line: number };
  categories: readonly string[];
  knownTitles: string[];
  issueRoom: number;
  maxPerHour: number | null;
  maxPending: number | null;
  createdAt: string;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
}

let sequence = 0;

export function createCycleDirectory(
  repoDir: string,
  now: Date,
): { cycleId: string; directory: string } {
  const base = `${stamp(now)}-${String(process.pid).padStart(6, "0")}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    sequence += 1;
    const cycleId = `${base}-${String(sequence).padStart(4, "0")}`;
    const directory = cycleDirectory(repoDir, cycleId);
    if (existsSync(directory)) continue;
    mkdirSync(directory, { recursive: true });
    return { cycleId, directory };
  }
  throw new Error("could not allocate a unique dead-code cycle directory");
}

/** Writes the request with its seeded entry point and effective caps. */
export function writeCycle(
  directory: string,
  options: {
    cycleId: string;
    repository: string;
    repoDir: string;
    knownTitles: string[];
    issueRoom: number;
    maxPerHour: number | null;
    maxPending: number | null;
    now: Date;
    environment?: Record<string, string | undefined>;
  },
): CycleRequest {
  const repoDir = resolve(options.repoDir);
  const pick = pickEntryPoint({
    repoDir,
    surface: "dead-code",
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  const request: CycleRequest = {
    version: CYCLE_VERSION,
    cycleId: options.cycleId,
    repository: options.repository,
    repoDir,
    surface: pick.surface,
    seed: pick.seed,
    entryPoint: { path: pick.path, line: pick.line },
    categories: DEAD_CODE_CATEGORIES,
    knownTitles: [...options.knownTitles].sort(),
    issueRoom: options.issueRoom,
    maxPerHour: options.maxPerHour,
    maxPending: options.maxPending,
    createdAt: options.now.toISOString(),
  };
  writeFileSync(requestPath(directory), `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

export function promptFor(directory: string): string {
  return `/dead-code-removal ${directory}`;
}
