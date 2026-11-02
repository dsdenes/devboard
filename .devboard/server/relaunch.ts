import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostHarnessDir } from "./version";

/**
 * The replacement is started before this process gives up its listener. A
 * failed spawn therefore leaves the dashboard serving instead of turning a
 * reported restart error into a permanently unreachable process.
 *
 * `relaunchConfirmed` adds a readiness handshake for the publish-driven source
 * refresh: the replacement writes a marker once its modules and startup inputs
 * are ready to bind, and the old process keeps serving until that marker
 * exists. A replacement that never becomes ready is ended and the old process
 * stays on the original port. Installed hosts and the reload control keep the
 * immediate `relaunch` path unchanged.
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
  pid?: number;
  unref(): void;
  kill?(signal?: NodeJS.Signals | number): void;
}

export interface RelaunchHooks {
  /** Stops the listener only after the replacement process exists. */
  stop: (server: Listener) => void;
  /** Ends this process so the replacement owns the port. */
  exit: (code: number) => void;
  /**
   * Runs after the replacement exists but before the listener stops, so
   * connected pages can be told to expect the new process.
   */
  beforeStop?: () => void;
  /** Test seams; production uses Bun and the host's harness lookup. */
  spawn?: (options: ReplacementOptions) => Replacement;
  exists?: (path: string) => boolean;
  harnessDir?: (repoDir: string) => string;
}

/** The fixture's replacement mode; absent means a real replacement. */
export function replacementStubMode(): string {
  const stub = process.env.DEVBOARD_REPLACEMENT_STUB;
  if (stub === undefined || stub.length === 0) return "";
  try {
    return readFileSync(stub, "utf8").trim();
  } catch {
    return "fail";
  }
}

function spawnReplacement(
  settings: RelaunchSettings,
  harness: string,
  spawn: (options: ReplacementOptions) => Replacement,
  extraEnv: Record<string, string | undefined> = {},
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
      ...extraEnv,
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

/** Resolves the harness entry a replacement would run, or throws its absence. */
function replacementEntry(
  settings: RelaunchSettings,
  hooks: RelaunchHooks,
): { harness: string; entry: string } {
  const harness = (hooks.harnessDir ?? hostHarnessDir)(settings.repoDir);
  const entry = join(harness, "server", "index.ts");
  if (!(hooks.exists ?? existsSync)(entry)) {
    throw new Error(`The replacement server is missing at ${entry}.`);
  }
  return { harness, entry };
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
  // Fixtures can make the launcher fail without breaking the running process.
  if (replacementStubMode() === "fail") throw new Error("stubbed replacement failure");
  const { harness } = replacementEntry(settings, hooks);
  const child = spawnReplacement(
    settings,
    harness,
    hooks.spawn ?? ((options) => Bun.spawn(options)),
  );
  child.unref();
  hooks.beforeStop?.();
  hooks.stop(server);
  hooks.exit(0);
}

export interface ReadyRelaunchOptions {
  /** Marker the replacement writes once it is ready to take the port. */
  readyFile: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Test seams; production polls the filesystem and the child's pid. */
  sleep?: (delayMs: number) => Promise<void>;
  alive?: (pid: number) => boolean;
}

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 50;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Starts a replacement and waits for its readiness marker before giving up the
 * listener. The marker means the child loaded its code and prepared its inputs;
 * it then retries the bind until this process exits. A child that exits first,
 * or never signals, is ended and the caller keeps serving on the old bundle.
 */
export async function relaunchConfirmed(
  server: Listener,
  settings: RelaunchSettings,
  hooks: RelaunchHooks,
  options: ReadyRelaunchOptions,
): Promise<void> {
  const stub = replacementStubMode();
  if (stub === "fail") throw new Error("stubbed replacement failure");
  const { harness } = replacementEntry(settings, hooks);
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? READY_POLL_MS;
  const sleep =
    options.sleep ?? ((delayMs: number) => Bun.sleep(delayMs));
  const alive = options.alive ?? pidAlive;
  rmSync(options.readyFile, { force: true });
  const child = spawnReplacement(
    settings,
    harness,
    hooks.spawn ?? ((spawned) => Bun.spawn(spawned)),
    // A fixture can prove the never-ready path with a live child that never
    // signals; production always hands the marker path to the replacement.
    stub === "never-ready" ? {} : { DEVBOARD_REPLACEMENT_READY_FILE: options.readyFile },
  );
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (existsSync(options.readyFile)) {
      ready = true;
      break;
    }
    if (child.pid !== undefined && !alive(child.pid)) break;
    await sleep(pollMs);
  }
  if (!ready) {
    if (child.pid !== undefined) child.kill?.("SIGTERM");
    throw new Error("the replacement did not become ready; the running server keeps serving");
  }
  rmSync(options.readyFile, { force: true });
  hooks.beforeStop?.();
  hooks.stop(server);
  hooks.exit(0);
}
