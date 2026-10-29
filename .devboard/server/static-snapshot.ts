import { rmSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * The static bundle a dashboard serves belongs to the process, not to the
 * installed package. An update renames the prefix's `node_modules` away and
 * deletes the old tree while this process keeps running, so a path into the
 * package would resolve to the new release between the install and the
 * operator's restart. The server copies its bundle into the state directory
 * once at startup and serves that copy for its whole life.
 */

export const STATIC_SNAPSHOT_DIRECTORY = "serving";

export interface SnapshotOptions {
  /** The installed (or source) bundle to copy. */
  staticDir: string;
  /** The dashboard's state directory; the copy lives under `serving/` there. */
  stateDir: string;
  /** The harness version this process runs; part of the copy's name. */
  version?: string | null;
  /** Test seam; production uses this process's id. */
  pid?: number;
}

export interface StaticSnapshot {
  /** Directory to hand to `createApp` as `staticDir`. */
  dir: string;
  /** Removes the copy; safe to call more than once. */
  remove: () => Promise<void>;
  /** Synchronous removal for `process.on("exit", …)`. */
  removeSync: () => void;
}

/** Directory that holds every process's snapshot in one state directory. */
export function snapshotRoot(stateDir: string): string {
  return join(resolve(stateDir), STATIC_SNAPSHOT_DIRECTORY);
}

/** The version is a package string, but a snapshot name must stay a file name. */
function versionTag(version: string | null | undefined): string {
  const safe = (version ?? "").replace(/[^0-9A-Za-z._-]+/g, "_");
  return safe.length > 0 ? safe : "unknown";
}

export function snapshotName(pid: number, version: string | null | undefined): string {
  return `${pid}-${versionTag(version)}`;
}

function snapshotPid(name: string): number | null {
  const match = /^([0-9]+)-/.exec(name);
  return match === null ? null : Number(match[1]);
}

/** True when a snapshot directory name still names a running process. */
export function snapshotInUse(name: string): boolean {
  const pid = snapshotPid(name);
  return pid !== null && processAlive(pid);
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process owned by another user is alive but cannot be signalled.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes snapshots whose process no longer runs. A snapshot of a live
 * process is left alone: a restart's replacement starts before the old
 * process exits, and both still serve requests in that window. The current
 * process's own leftovers are removed because this call recreates them.
 */
export async function pruneStaticSnapshots(
  stateDir: string,
  livePid: number = process.pid,
): Promise<string[]> {
  const root = snapshotRoot(stateDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pid = snapshotPid(entry.name);
    if (pid === null) continue;
    if (pid !== livePid && processAlive(pid)) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

/**
 * Copies `staticDir` into the state directory and returns the copy. Failing
 * to copy is a start failure: a dashboard without its own bundle would either
 * serve another release or none at all.
 */
export async function snapshotStaticDir(options: SnapshotOptions): Promise<StaticSnapshot> {
  const source = resolve(options.staticDir);
  const pid = options.pid ?? process.pid;
  const stateDir = resolve(options.stateDir);
  const root = snapshotRoot(stateDir);
  await mkdir(root, { recursive: true });
  await pruneStaticSnapshots(stateDir, pid);
  const dir = join(root, snapshotName(pid, options.version));
  await rm(dir, { recursive: true, force: true });
  try {
    // A bundle directory may itself be a symlink; copying the link would leave
    // the snapshot pointing at the tree an update replaces.
    await cp(source, dir, { recursive: true, dereference: true });
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not snapshot the static bundle at ${source}: ${detail}`, {
      cause: error,
    });
  }

  let removed = false;
  const removeSync = () => {
    if (removed) return;
    removed = true;
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    dir,
    remove: async () => {
      if (removed) return;
      removed = true;
      await rm(dir, { recursive: true, force: true });
    },
    removeSync,
  };
}
