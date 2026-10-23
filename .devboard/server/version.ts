import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ServerVersion {
  running: string | null;
  current: string | null;
  stale: boolean;
}

/** The checkout that contains this server's source code. */
export function runningHarnessDir(): string {
  return resolve(import.meta.dir, "..");
}

/**
 * The harness the served project points at now. A host installs it as the
 * `.devboard` symlink, so resolving that link is what names the version the
 * next start would run. Without one, the running checkout is the harness.
 */
export function hostHarnessDir(repoDir: string): string {
  const candidate = join(resolve(repoDir), ".devboard");
  try {
    if (statSync(candidate).isDirectory()) return realpathSync(candidate);
  } catch {
    // The host may not install the harness at that path.
  }
  return runningHarnessDir();
}

/** The commit a checkout names, or null when it is not a readable git worktree. */
export function gitRevision(directory: string): string | null {
  try {
    const result = spawnSync("git", ["-C", directory, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return null;
    const revision = result.stdout.trim();
    return revision.length > 0 ? revision : null;
  } catch {
    return null;
  }
}

/**
 * Compares the harness commit this process started from with the commit the
 * project's harness link names now. Unreadable checkouts never report a stale
 * version: the reload control only appears when a restart would change code.
 */
export function serverVersion(
  repoDir: string,
  runningRevision: string | null = gitRevision(runningHarnessDir()),
): ServerVersion {
  const current = gitRevision(hostHarnessDir(repoDir));
  return {
    running: runningRevision,
    current,
    stale: runningRevision !== null && current !== null && runningRevision !== current,
  };
}
