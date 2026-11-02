import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { discoverInstances, type Instance } from "../watchdog/discovery";
import { isHarnessSourceCheckout } from "../server/version";

/**
 * The publish-only source refresh. A dashboard that serves a harness source
 * checkout never installs a package and never replaces itself on an update
 * check. One successful `bun run publish` writes a request into the state
 * directory of every live dashboard for that checkout; a dashboard that finds
 * a valid, unapplied request verifies the built bundle digest and restarts
 * through the ordinary replacement path. Nothing else on the source path
 * triggers a restart.
 *
 * The request and the applied marker are plain JSON files under the
 * dashboard's own `STATE_DIR`, so the writer never needs to talk to the
 * dashboard and a dashboard never needs to trust a path outside its state.
 */

export const SOURCE_REFRESH_SCHEMA = 1;
export const SOURCE_REFRESH_DIRECTORY = "source-refresh";
export const SOURCE_REFRESH_REQUEST_FILE = "request.json";
export const SOURCE_REFRESH_APPLIED_FILE = "applied.json";
export const DEFAULT_SOURCE_REFRESH_INTERVAL_MS = 60_000;
export const MIN_SOURCE_REFRESH_INTERVAL_MS = 1_000;

const COMMIT = /^[0-9a-f]{7,64}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

export interface SourceRefreshRequest {
  schema: number;
  /** The published commit the built bundle belongs to. */
  commit: string;
  /** The released version the commit was published as. */
  version: string;
  /** SHA-256 of the built `.devboard/dist` tree the request authorizes. */
  distDigest: string;
  /** ISO instant the successful publish wrote the request. */
  requestedAt: string;
}

export interface AppliedSourceRefresh {
  commit: string;
  version: string;
  distDigest: string;
  appliedAt: string;
}

export type SourceRefreshRequestRead =
  | { state: "missing" }
  | { state: "invalid"; error: string; key: string }
  | { state: "valid"; request: SourceRefreshRequest; key: string };

export function sourceRefreshDirectory(stateDir: string): string {
  return join(resolve(stateDir), SOURCE_REFRESH_DIRECTORY);
}

export function sourceRefreshRequestPath(stateDir: string): string {
  return join(sourceRefreshDirectory(stateDir), SOURCE_REFRESH_REQUEST_FILE);
}

export function sourceRefreshAppliedPath(stateDir: string): string {
  return join(sourceRefreshDirectory(stateDir), SOURCE_REFRESH_APPLIED_FILE);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parses one request document; anything malformed is not a request. */
export function parseSourceRefreshRequest(value: unknown): SourceRefreshRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const commit = nonEmptyString(record.commit);
  const version = nonEmptyString(record.version);
  const distDigest = nonEmptyString(record.distDigest);
  const requestedAt = nonEmptyString(record.requestedAt);
  if (record.schema !== SOURCE_REFRESH_SCHEMA) return null;
  if (commit === null || !COMMIT.test(commit)) return null;
  if (version === null) return null;
  if (distDigest === null || !DIGEST.test(distDigest)) return null;
  if (requestedAt === null) return null;
  return { schema: SOURCE_REFRESH_SCHEMA, commit, version, distDigest, requestedAt };
}

/**
 * Reads the request a publish wrote. A missing file is not a failure: the
 * dashboard simply has nothing to do. An unreadable or malformed file is
 * reported with a stable key so the failure is journaled once, never once per
 * poll.
 */
export function readSourceRefreshRequest(stateDir: string): SourceRefreshRequestRead {
  const path = sourceRefreshRequestPath(stateDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return {
      state: "invalid",
      error: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      key: `unreadable:${path}`,
    };
  }
  const key = createHash("sha256").update(text).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      state: "invalid",
      error: `could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
      key,
    };
  }
  const request = parseSourceRefreshRequest(parsed);
  return request === null
    ? { state: "invalid", error: `${path} is not a source refresh request`, key }
    : { state: "valid", request, key };
}

export function readAppliedSourceRefresh(stateDir: string): AppliedSourceRefresh | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sourceRefreshAppliedPath(stateDir), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const commit = nonEmptyString(record.commit);
  const version = nonEmptyString(record.version);
  const distDigest = nonEmptyString(record.distDigest);
  const appliedAt = nonEmptyString(record.appliedAt);
  if (commit === null || version === null || distDigest === null || appliedAt === null) {
    return null;
  }
  return { commit, version, distDigest, appliedAt };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, path);
}

/** Writes the request atomically. A partial file is never observable. */
export function writeSourceRefreshRequest(
  stateDir: string,
  request: SourceRefreshRequest,
): string {
  const validated = parseSourceRefreshRequest(request);
  if (validated === null) throw new Error("the source refresh request is not valid");
  const path = sourceRefreshRequestPath(stateDir);
  writeJsonAtomic(path, validated);
  return path;
}

/**
 * Records the request a dashboard actually applied, so re-delivering the same
 * publish or restarting again on the same revision never replaces the process
 * a second time.
 */
export function writeAppliedSourceRefresh(
  stateDir: string,
  request: SourceRefreshRequest,
  appliedAt: string = new Date().toISOString(),
): string {
  const path = sourceRefreshAppliedPath(stateDir);
  writeJsonAtomic(path, {
    commit: request.commit,
    version: request.version,
    distDigest: request.distDigest,
    appliedAt,
  } satisfies AppliedSourceRefresh);
  return path;
}

/**
 * True when the dashboard already applied this request. The commit is the
 * published revision: a repeated publish of the same commit, with the same or
 * a rebuilt bundle, never restarts the dashboard again.
 */
export function alreadyAppliedSourceRefresh(
  applied: AppliedSourceRefresh | null,
  request: SourceRefreshRequest,
): boolean {
  return applied !== null && applied.commit === request.commit;
}

function relativeFiles(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...relativeFiles(path, name));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

/**
 * A deterministic SHA-256 of a built bundle tree: every relative path and its
 * bytes, in path order. Two builds with identical output digest identically;
 * added, removed, renamed, or edited files never do.
 */
export function distDigest(directory: string): string {
  const root = resolve(directory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`the bundle directory is missing at ${root}`);
  }
  const hash = createHash("sha256");
  for (const relative of relativeFiles(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The poll interval: the default, a configured value, and never below 1s. */
export function sourceRefreshIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DEVBOARD_SOURCE_REFRESH_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SOURCE_REFRESH_INTERVAL_MS;
  return Math.max(MIN_SOURCE_REFRESH_INTERVAL_MS, Math.floor(parsed));
}

export interface SourceRefreshDeliveryOptions {
  /** The checkout a dashboard must serve to receive the request. */
  repoRoot: string;
  /** That checkout's serving harness directory, `<repoRoot>/.devboard`. */
  harnessRoot: string;
  commit: string;
  version: string;
  /** The built bundle whose digest authorizes the refresh. */
  distDir?: string;
  /** Injectable process table; production discovers every live dashboard. */
  instances?: readonly Instance[];
  now?: () => Date;
}

/** One dashboard whose request could not be written, and why. */
export interface SourceRefreshFailure {
  stateDir: string;
  pid: number;
  port: number;
  error: string;
}

export interface SourceRefreshDelivery {
  request: SourceRefreshRequest;
  digest: string;
  written: Array<{ stateDir: string; pid: number; port: number }>;
  /** Every dashboard that kept serving because its request was not written. */
  failed: SourceRefreshFailure[];
}

function samePath(left: string, right: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(left) === real(right);
}

/**
 * Writes one request for every live dashboard that serves this checkout's
 * source harness. An installed prefix, another checkout, and a fixture that
 * discovery hides never receive a request. An unwritable state directory is
 * recorded in `failed` and never stops delivery to the remaining dashboards.
 * Callers write only after a publish has verified every release step.
 */
export function deliverSourceRefresh(
  options: SourceRefreshDeliveryOptions,
): SourceRefreshDelivery {
  const request: SourceRefreshRequest = {
    schema: SOURCE_REFRESH_SCHEMA,
    commit: options.commit,
    version: options.version,
    distDigest: distDigest(options.distDir ?? join(options.harnessRoot, "dist")),
    requestedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const validated = parseSourceRefreshRequest(request);
  if (validated === null) {
    throw new Error(
      `not a source refresh request: commit ${options.commit}, version ${options.version}`,
    );
  }
  const repoRoot = resolve(options.repoRoot);
  const harnessRoot = resolve(options.harnessRoot);
  const instances =
    options.instances ??
    discoverInstances({ selfPids: new Set([process.pid]) });
  const written: SourceRefreshDelivery["written"] = [];
  const failed: SourceRefreshFailure[] = [];
  const outcomes = new Map<string, { ok: true } | { ok: false; error: string }>();
  for (const instance of instances) {
    if (!samePath(instance.repoDir, repoRoot)) continue;
    if (!samePath(instance.harness, harnessRoot)) continue;
    if (!isHarnessSourceCheckout(repoRoot)) continue;
    const stateDir = resolve(instance.stateDir);
    const outcome = outcomes.get(stateDir);
    if (outcome !== undefined) {
      if (outcome.ok) written.push({ stateDir, pid: instance.pid, port: instance.port });
      else failed.push({ stateDir, pid: instance.pid, port: instance.port, error: outcome.error });
      continue;
    }
    try {
      writeSourceRefreshRequest(stateDir, validated);
      outcomes.set(stateDir, { ok: true });
      written.push({ stateDir, pid: instance.pid, port: instance.port });
    } catch (error) {
      // One unwritable state directory is that dashboard's problem: the
      // remaining instances still receive their request.
      const message = error instanceof Error ? error.message : String(error);
      outcomes.set(stateDir, { ok: false, error: message });
      failed.push({ stateDir, pid: instance.pid, port: instance.port, error: message });
    }
  }
  return { request: validated, digest: validated.distDigest, written, failed };
}
