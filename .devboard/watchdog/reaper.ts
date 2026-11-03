import { appendFileSync, mkdirSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { isInteger, isRecord } from "../issues/guards";
import { liveLockOwners, pidAlive } from "../issues/lock";
import {
  DETACHED_HANDOFF_GRACE_MS,
  detachedRunsRoot,
  readDetachedHandoff,
  readDetachedLease,
} from "../server/detached-run";
import {
  HANDOFF_GRACE_MS,
  goalDraftStateDirectory,
  readGoalDraftHandoff,
  readGoalDraftLease,
} from "../server/goal-draft-owner";
import { coveredStateDirs } from "./cleanup";
import { ancestry, discoverInstances, type Instance, type ProcessSnapshot } from "./discovery";
import {
  reapOrphans,
  startOrphanSupervisor,
  supervisionDirectory,
  SUPERVISION_INTERVAL_MS,
  type OrphanSupervisor,
  type ReapDecision,
  type ReapReport,
  type SupervisionScope,
} from "./supervision";

/**
 * The reaper's composition: discovers the state directories and repositories a
 * pass covers, collects the pids a live lease, handoff, or worker lock still
 * protects, and calls the one `reapOrphans` implementation. Both activations
 * (the watchdog's own interval and every dashboard start) enter here, as does
 * `bun run cleanup -- --processes`.
 */

const RUN_STATE_DEPTH = 3;
const LOCK_DEPTH = 4;

/** Adds the owner and peer pids a run recorded under `directory`. */
function addRunPids(directory: string, depth: number, pids: Set<number>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth > 1) addRunPids(path, depth - 1, pids);
      continue;
    }
    if (entry.name !== "state.json") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    for (const child of [parsed.owner, parsed.peer]) {
      if (isRecord(child) && isInteger(child.pid) && child.pid > 0) pids.add(child.pid);
    }
  }
}

function addLockPids(directory: string, depth: number, pids: Set<number>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth > 1) addLockPids(path, depth - 1, pids);
      continue;
    }
    const named = entry.name === "lock" || entry.name.startsWith("lock.");
    if (!named && !/^devboard-\d+\.lock$/.test(entry.name)) continue;
    for (const owner of liveLockOwners(path)) pids.add(owner.pid);
  }
}

/**
 * True while a handoff still belongs to the replacement: the marker names the
 * process that began it, which has usually exited, so its age is the proof that
 * the successor is about to adopt the runs.
 */
function handoffHeld(handoff: { at: number } | null, graceMs: number, now: number): boolean {
  return handoff !== null && now - handoff.at <= graceMs;
}

/**
 * Every pid a live detached run, goal-draft owner, or worker lock still holds.
 * The reaper never signals one of them: the run outlives a dashboard
 * replacement, and an older version's worker finishes its own unit.
 */
export function orphanClaims(scopes: SupervisionScope[]): Set<number> {
  const pids = new Set<number>();
  const now = Date.now();
  for (const scope of scopes) {
    const runsLease = readDetachedLease(scope.stateDir, scope.repoDir);
    const runsHandoff = readDetachedHandoff(scope.stateDir, scope.repoDir);
    const runsHeld =
      (runsLease !== null && pidAlive(runsLease.pid)) ||
      handoffHeld(runsHandoff, DETACHED_HANDOFF_GRACE_MS, now);
    if (runsHeld) {
      addRunPids(detachedRunsRoot(scope.stateDir, scope.repoDir), RUN_STATE_DEPTH, pids);
    }

    const draftLease = readGoalDraftLease(scope.stateDir, scope.repoDir);
    const draftHandoff = readGoalDraftHandoff(scope.stateDir, scope.repoDir);
    const draftsHeld =
      (draftLease !== null && pidAlive(draftLease.pid)) ||
      handoffHeld(draftHandoff, HANDOFF_GRACE_MS, now);
    if (draftsHeld) {
      addRunPids(goalDraftStateDirectory(scope.stateDir, scope.repoDir), RUN_STATE_DEPTH, pids);
    }

    // Worker locks are repository-anchored under a host's `.devboard/.tmp` or
    // state-anchored under a dashboard's own STATE_DIR; both are scanned.
    addLockPids(scope.stateDir, LOCK_DEPTH, pids);
    addLockPids(join(scope.repoDir, ".devboard", ".tmp"), LOCK_DEPTH, pids);
  }
  return pids;
}

/** Every `(stateDir, repoDir)` one pass reads records and proofs from. */
export function reaperScopes(
  root: string,
  stateDir: string | undefined,
  instances: Instance[],
): SupervisionScope[] {
  const repos = new Map<string, string>();
  for (const instance of instances) {
    repos.set(resolve(instance.stateDir), resolve(instance.repoDir));
  }
  const scopes: SupervisionScope[] = [];
  const seen = new Set<string>();
  const add = (directory: string, repoDir: string): void => {
    const real = resolve(directory);
    if (seen.has(real)) return;
    seen.add(real);
    scopes.push({ stateDir: real, repoDir });
  };
  for (const covered of coveredStateDirs(root, instances)) {
    add(covered.stateDir, repos.get(resolve(covered.stateDir)) ?? resolve(root));
  }
  if (stateDir !== undefined) add(stateDir, resolve(root));
  return scopes;
}

export interface OrphanReaperRunOptions {
  root: string;
  /** The caller's own state directory, scanned even when nothing is live. */
  stateDir?: string;
  dryRun?: boolean;
  /** Test seam; production discovers the live dashboards itself. */
  instances?: Instance[];
  /** Test seam; production reads `/proc`. */
  processes?: ProcessSnapshot[];
  /** Test seam; production uses `/proc`. */
  alive?: (pid: number) => boolean;
  orphanGraceMs?: number;
  killGraceMs?: number;
}

/** One durable line per candidate the reaper acted on or deliberately left. */
function logDecisions(stateDir: string, decisions: ReapDecision[]): void {
  const reportable = decisions.filter((decision) => decision.action !== "removed-record");
  if (reportable.length === 0) return;
  const directory = supervisionDirectory(stateDir);
  const path = join(directory, "reaped.jsonl");
  try {
    mkdirSync(directory, { recursive: true });
    const now = new Date().toISOString();
    appendFileSync(
      path,
      reportable
        .map((decision) => `${JSON.stringify({ ts: now, ...decision })}\n`)
        .join(""),
    );
  } catch {
    // A state directory that cannot be written must not stop the reap.
  }
}

/** One reaping pass over every covered state directory. */
export function runOrphanReaper(options: OrphanReaperRunOptions): ReapReport {
  if (process.platform !== "linux") {
    return { available: false, decisions: [], killed: [], removedRecords: [] };
  }
  const root = resolve(options.root);
  const instances =
    options.instances ??
    discoverInstances({ selfPids: new Set([process.pid, ...ancestry(process.pid)]) });
  const scopes = reaperScopes(root, options.stateDir, instances);
  const report = reapOrphans({
    scopes,
    protectedPids: orphanClaims(scopes),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.processes === undefined ? {} : { processes: options.processes }),
    ...(options.alive === undefined ? {} : { alive: options.alive }),
    ...(options.orphanGraceMs === undefined ? {} : { orphanGraceMs: options.orphanGraceMs }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  });
  logDecisions(join(root, ".devboard", ".tmp"), report.decisions);
  if (options.stateDir !== undefined) logDecisions(options.stateDir, report.decisions);
  return report;
}

export interface OrphanReaperOptions extends OrphanReaperRunOptions {
  intervalMs?: number;
  /** Test seam; production uses the real timer. */
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}

/**
 * The watchdog's activation: one pass now, then one every
 * `SUPERVISION_INTERVAL_MS`, independent of the cycle cadence.
 */
export function startOrphanReaper(options: OrphanReaperOptions): OrphanSupervisor {
  return startOrphanSupervisor({
    reap: () => {
      try {
        runOrphanReaper(options);
      } catch {
        // A failed pass must never end the worker that schedules it.
      }
    },
    intervalMs: options.intervalMs ?? SUPERVISION_INTERVAL_MS,
    ...(options.setInterval === undefined ? {} : { setInterval: options.setInterval }),
    ...(options.clearInterval === undefined ? {} : { clearInterval: options.clearInterval }),
  });
}
