import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostHarnessDir } from "./version";

/**
 * The replacement is started before this process gives up its listener. A
 * failed spawn therefore leaves the dashboard serving instead of turning a
 * reported restart error into a permanently unreachable process.
 */

export interface Listener {
  stop(closeActiveConnections?: boolean): void;
}

export interface RelaunchSettings {
  hostname: string;
  port: number;
  adrDir: string;
  repoDir: string;
  goalFile: string;
  stateDir: string;
}

export interface ReplacementOptions {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: "ignore";
  stdout: "ignore";
  stderr: "ignore";
}

export interface Replacement {
  unref(): void;
}

export interface RelaunchHooks {
  /** Stops the listener only after the replacement process exists. */
  stop: (server: Listener) => void;
  /** Ends this process so the replacement owns the port. */
  exit: (code: number) => void;
  /** Test seams; production uses Bun and the host's harness lookup. */
  spawn?: (options: ReplacementOptions) => Replacement;
  exists?: (path: string) => boolean;
  harnessDir?: (repoDir: string) => string;
}

function spawnReplacement(
  settings: RelaunchSettings,
  harness: string,
  spawn: (options: ReplacementOptions) => Replacement,
): Replacement {
  // A new session protects the replacement when the launcher itself was
  // started inside a process group that is being shut down.
  const setsid = process.platform === "win32" ? null : Bun.which("setsid");
  return spawn({
    cmd: [
      ...(setsid === null ? [] : [setsid]),
      process.execPath,
      join(harness, "server", "index.ts"),
    ],
    // Never start from the replaceable package directory: an update can
    // rename and delete it, and a child cannot start from a missing cwd.
    cwd: settings.repoDir,
    env: {
      ...process.env,
      HOST: settings.hostname,
      PORT: String(settings.port),
      ADRS_DIR: settings.adrDir,
      REPO_DIR: settings.repoDir,
      GOAL_FILE: settings.goalFile,
      STATIC_DIR: join(harness, "dist"),
      STATE_DIR: settings.stateDir,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * Replaces this process with the harness the host now points at. The child
 * starts while the old listener still holds the port and retries the bind
 * until this process exits. Any failure before the child exists propagates,
 * leaving the caller serving.
 */
export function relaunch(
  server: Listener,
  settings: RelaunchSettings,
  hooks: RelaunchHooks,
): void {
  const harness = (hooks.harnessDir ?? hostHarnessDir)(settings.repoDir);
  const entry = join(harness, "server", "index.ts");
  if (!(hooks.exists ?? existsSync)(entry)) {
    throw new Error(`The replacement server is missing at ${entry}.`);
  }
  const child = spawnReplacement(
    settings,
    harness,
    hooks.spawn ?? ((options) => Bun.spawn(options)),
  );
  child.unref();
  hooks.stop(server);
  hooks.exit(0);
}
