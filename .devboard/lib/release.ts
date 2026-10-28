import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { configuredGiteaToken, configuredGiteaUrl } from "./forge";
import {
  GiteaError,
  giteaDownloadAsset,
  giteaLatestRelease,
  giteaReleaseByTag,
  type GiteaAsset,
  type GiteaReleaseDocument,
  type GiteaTarget,
} from "./gitea";

/**
 * Release transport shared by the dashboard server and its verification
 * scripts. npm is the authority for the version and artifact. A configured
 * Gitea release is only a fallback for hosts where npm cannot resolve or
 * serve the package; it is never required for an update check.
 */

export const RELEASE_REPO = "dsdenes/devboard";
export const PACKAGE_NAME = "@dsdenes/devboard";
export const RELEASE_PREFIX = "devboard-";
export const CHECKSUM_SUFFIX = ".sha256";

export interface GiteaSource {
  kind: "gitea";
  baseUrl: string;
  repo: string;
  token?: string;
}

export type ReleaseSource =
  | { kind: "npm"; env: NodeJS.ProcessEnv; fallback?: GiteaSource }
  | { kind: "dir"; directory: string }
  | GiteaSource;

export interface ReleaseAsset {
  name: string;
  id?: number;
  size?: number;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  assets: ReleaseAsset[];
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}

export class ReleaseError extends Error {}

/**
 * The feed answered, but not with a release description the harness can read:
 * a proxy or captive-portal page, a truncated body, or a payload that is not a
 * release object. The cause is outside the harness, so a check that hits it is
 * retried as feed context instead of being reported as a defect.
 */
export class ReleaseFeedError extends ReleaseError {}

/**
 * The registry's metadata advertised a version whose own tarball it does not
 * serve yet: a fresh publish whose artifact has not propagated. The cause is
 * outside the harness, so an install that hits it is retried as context
 * instead of being reported as a defect. Any other install failure remains a
 * release defect.
 */
export class ReleaseNotServedError extends ReleaseError {}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text.length > 0 ? text.replace(/\/+$/, "") : undefined;
}

function giteaFallback(env: NodeJS.ProcessEnv): GiteaSource | undefined {
  const baseUrl = trimmed(configuredGiteaUrl(env)) ?? trimmed(env.DEVBOARD_RELEASE_URL);
  if (baseUrl === undefined) return undefined;
  const token = configuredGiteaToken(env);
  return {
    kind: "gitea",
    baseUrl,
    repo: env.DEVBOARD_RELEASE_REPO ?? RELEASE_REPO,
    ...(token === undefined ? {} : { token }),
  };
}

/**
 * The release backend the environment asks for. A directory overrides every
 * network source for CI and fixtures. Otherwise npm is the authority, with a
 * configured Gitea release available as a fallback.
 */
export function releaseSource(
  env: NodeJS.ProcessEnv = process.env,
  stateDir?: string,
): ReleaseSource {
  const directory = env.DEVBOARD_RELEASE_DIR;
  if (directory !== undefined && directory.length > 0) {
    return { kind: "dir", directory: resolve(directory) };
  }
  const cache = env.npm_config_cache ??
    (stateDir === undefined ? undefined : join(resolve(stateDir), "npm-cache"));
  const fallback = giteaFallback(env);
  return {
    kind: "npm",
    env: {
      ...env,
      ...(cache === undefined ? {} : { npm_config_cache: cache }),
    },
    ...(fallback === undefined ? {} : { fallback }),
  };
}

/** Runs one command without a shell; stdout is bounded so a hung tool cannot exhaust memory. */
export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<CommandResult> {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  return new Promise((settle, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    timer?.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes >= maxBytes) return;
      outBytes += chunk.length;
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errBytes >= maxBytes) return;
      errBytes += chunk.length;
      err.push(chunk);
    });
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      settle({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        killed,
      });
    });
  });
}

function failure(tool: string, result: CommandResult): ReleaseError {
  const detail = (result.stderr || result.stdout || "no output").trim().split("\n")[0] ?? "";
  return new ReleaseError(
    `${tool} failed${result.killed ? " (timed out)" : ""}: ${detail.length > 0 ? detail : "no output"}`,
  );
}

/** The artifact URL npm names when it refuses a fetch, from either report line. */
function failedArtifactUrl(result: CommandResult): string | undefined {
  const text = `${result.stderr}\n${result.stdout}`;
  const fetched = /- GET (https?:\/\/\S+)/.exec(text);
  if (fetched?.[1] !== undefined) return fetched[1];
  const resource = /@(https?:\/\/[^\s']+)/.exec(text);
  return resource?.[1];
}

/**
 * The error for one failed npm install. A 404 or 410 for the package's own
 * versioned tarball means the registry advertises a release whose artifact has
 * not propagated yet; that is external and temporary, so it is retried as
 * context. A missing dependency tarball or any other npm failure is a defect
 * in the release and stays a plain install failure.
 */
export function npmInstallError(result: CommandResult, version: string): ReleaseError {
  const url = /\b(?:E?404|E?410)\b/i.test(result.stderr) ? failedArtifactUrl(result) : undefined;
  if (url !== undefined) {
    let path: string | undefined;
    try {
      path = new URL(url).pathname;
    } catch {
      path = undefined;
    }
    if (path?.endsWith(`/${tarballName(version)}`) === true) {
      return new ReleaseNotServedError(
        `npm does not serve the advertised ${PACKAGE_NAME}@${version} artifact yet: ${url}`,
      );
    }
  }
  return failure("npm install", result);
}

/**
 * Text the tools print when the host cannot reach the registry or feed at all:
 * no route, DNS or proxy failure, refused or reset connection, or a timeout.
 * The cause is the network, not the harness, so it is retried without being
 * reported as a defect.
 */
const UNREACHABLE_PATTERNS = [
  "network is unreachable",
  "no route to host",
  "error connecting to",
  "connection refused",
  "connection reset",
  "connection timed out",
  "i/o timeout",
  "no such host",
  "server misbehaving",
  "temporary failure in name resolution",
  "tls handshake timeout",
  "context deadline exceeded",
  "enotfound",
  "eai_again",
  "(timed out)",
];

/** True when a release check failed because the network was unreachable. */
export function isReleaseUnreachable(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (UNREACHABLE_PATTERNS.some((pattern) => message.includes(pattern))) return true;
  // A host without the release client cannot reach the registry at all. Node
  // and Bun report the failed spawn as ENOENT before the tool prints anything.
  const failure = error as (NodeJS.ErrnoException & { syscall?: unknown }) | undefined;
  const syscall = typeof failure?.syscall === "string" ? failure.syscall : "";
  return failure?.code === "ENOENT" && (message.includes("spawn") || syscall.startsWith("spawn"));
}

/**
 * Text the release registry or feed prints when it refuses requests because
 * the caller exceeded a quota. The feed is reachable; the refusal is temporary
 * and caused by shared or rapid polling, not by the harness, so the check is
 * retried without being reported as a defect.
 */
const RATE_LIMIT_PATTERNS = [
  "rate limit exceeded",
  "secondary rate limit",
  "rate-limited",
  "http 429",
  "429 too many requests",
  "too many requests",
  "code e429",
];

/** True when a release check failed because the registry or feed rate-limited the caller. */
export function isReleaseRateLimited(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return RATE_LIMIT_PATTERNS.some((pattern) => message.includes(pattern));
}

export function tarballName(version: string): string {
  return `${RELEASE_PREFIX}${version}.tgz`;
}

export function checksumName(version: string): string {
  return `${tarballName(version)}${CHECKSUM_SUFFIX}`;
}

/** True when `candidate` is a later release than `installed`. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const left = candidate.split("-")[0]?.split(".").map(Number) ?? [];
  const right = installed.split("-")[0]?.split(".").map(Number) ?? [];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) break;
    if (a !== b) return a > b;
  }
  return false;
}

function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

function versionFromTarball(name: string): string | undefined {
  const match = new RegExp(`^(?:dsdenes-)?${RELEASE_PREFIX}(.+)\\.tgz$`).exec(name);
  return match?.[1];
}

/** The newest release a directory holds; used by fixtures and offline checks. */
async function directoryRelease(directory: string): Promise<ReleaseInfo> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throw new ReleaseError(
      `release directory is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tarballs = names
    .filter((name) => name.endsWith(".tgz") && versionFromTarball(name) !== undefined)
    .map((name) => ({ name, version: versionFromTarball(name) as string }))
    .sort((left, right) => (isNewerVersion(left.version, right.version) ? -1 : 1));
  const newest = tarballs[0];
  if (newest === undefined) throw new ReleaseError("no release tarball in DEVBOARD_RELEASE_DIR");
  const checksum = `${newest.name}${CHECKSUM_SUFFIX}`;
  if (!existsSync(join(directory, checksum))) {
    throw new ReleaseError(`release checksum is missing: ${checksum}`);
  }
  return {
    version: newest.version,
    tag: `v${newest.version}`,
    assets: [{ name: newest.name }, { name: checksum }],
  };
}

function npmResultText(result: CommandResult): string {
  const text = (result.stderr || result.stdout).trim().split("\n")[0]?.trim() ?? "";
  return text.length > 0 ? text : "no output";
}

/** The newest version npm publishes for this package. */
export async function npmLatestVersion(env: NodeJS.ProcessEnv): Promise<string> {
  const npm = env.DEVBOARD_NPM ?? "npm";
  const result = await exec(
    npm,
    ["view", PACKAGE_NAME, "version", "--prefer-online"],
    { env, timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new ReleaseError(`npm could not resolve ${PACKAGE_NAME}: ${npmResultText(result)}`);
  }
  const lines = result.stdout.trim().split("\n").filter((line) => line.trim().length > 0);
  const version = lines.at(-1)?.trim() ?? "";
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ReleaseError(`npm returned an unreadable version: ${npmResultText(result)}`);
  }
  return version;
}

/**
 * The dist-tag a release publishes under when a newer version already exists.
 * npm refuses to move `latest` backwards, so an older release must name a
 * side tag explicitly instead of relying on the implicit default.
 */
export const SIDE_RELEASE_TAG = "next";

/** Orders two dotted numeric versions; undefined when either is unreadable. */
export function compareReleaseVersions(
  left: string,
  right: string,
): number | undefined {
  const parse = (version: string): number[] | undefined => {
    const parts = version.split(".").map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part))) {
      return undefined;
    }
    return parts;
  };
  const first = parse(left);
  const second = parse(right);
  if (first === undefined || second === undefined) return undefined;
  for (let index = 0; index < first.length; index += 1) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The highest release version among published tags; malformed tags are ignored. */
export function highestReleaseVersion(versions: Iterable<string>): string | undefined {
  let highest: string | undefined;
  for (const version of versions) {
    if (compareReleaseVersions(version, version) === undefined) continue;
    if (highest === undefined || (compareReleaseVersions(version, highest) ?? 0) > 0) {
      highest = version;
    }
  }
  return highest;
}

/**
 * The dist-tag one release publishes under. `latest` only moves forward, so a
 * version at or below the newest published one publishes under a side tag.
 */
export function publishTagFor(
  version: string,
  newest: string | undefined,
): "latest" | typeof SIDE_RELEASE_TAG {
  if (newest === undefined) return "latest";
  const order = compareReleaseVersions(version, newest);
  if (order === undefined) {
    throw new ReleaseError(`cannot order release version ${version} against ${newest}`);
  }
  return order > 0 ? "latest" : SIDE_RELEASE_TAG;
}

/** The tarball npm advertises for one published version. */
export async function npmArtifactUrl(
  env: NodeJS.ProcessEnv,
  version: string,
): Promise<string> {
  const npm = env.DEVBOARD_NPM ?? "npm";
  const result = await exec(
    npm,
    ["view", `${PACKAGE_NAME}@${version}`, "dist.tarball", "--prefer-online"],
    { env, timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new ReleaseError(
      `npm could not serve ${PACKAGE_NAME}@${version}: ${npmResultText(result)}`,
    );
  }
  const value = result.stdout.trim().split("\n").filter((line) => line.length > 0).at(-1) ?? "";
  if (!/^https?:\/\//.test(value)) {
    throw new ReleaseError(`npm returned no tarball for ${PACKAGE_NAME}@${version}`);
  }
  return value;
}

/**
 * The error for a body that is not one JSON release object: a proxy page, a
 * truncated response, or a payload from a different tool. The first line is
 * kept, bounded, so the journal names what arrived instead of just failing.
 */
function unreadableDescription(stdout: string): ReleaseFeedError {
  const first = stdout.trim().split("\n")[0]?.trim() ?? "";
  const snippet =
    first.length === 0 ? "no output" : first.length > 200 ? `${first.slice(0, 200)}…` : first;
  return new ReleaseFeedError(`the release feed returned an unreadable description: ${snippet}`);
}

function releaseAssets(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) return [];
  const assets: ReleaseAsset[] = [];
  for (const asset of value) {
    if (typeof asset !== "object" || asset === null) continue;
    const name = "name" in asset ? asset.name : undefined;
    const id = "id" in asset ? asset.id : undefined;
    const size = "size" in asset ? asset.size : undefined;
    if (typeof name !== "string") continue;
    assets.push({
      name,
      ...(typeof id === "number" ? { id } : {}),
      ...(typeof size === "number" ? { size } : {}),
    });
  }
  return assets;
}

/**
 * Reads a release document the Gitea API prints. Anything that is not one JSON
 * release object is a feed the harness cannot use, not a harness defect.
 */
export function parseReleaseDescription(stdout: string): ReleaseInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw unreadableDescription(stdout);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw unreadableDescription(stdout);
  }
  if (!("tag_name" in parsed) || typeof parsed.tag_name !== "string") {
    throw new ReleaseError("the latest release has no tag");
  }
  return {
    version: versionFromTag(parsed.tag_name),
    tag: parsed.tag_name,
    assets: releaseAssets("assets" in parsed ? parsed.assets : undefined),
  };
}

function releaseFromDocument(document: GiteaReleaseDocument): ReleaseInfo {
  if (typeof document.tag_name !== "string") {
    throw new ReleaseError("the latest release has no tag");
  }
  return {
    version: versionFromTag(document.tag_name),
    tag: document.tag_name,
    assets: releaseAssets(document.assets),
  };
}

function giteaTarget(source: GiteaSource): GiteaTarget {
  return {
    baseUrl: source.baseUrl,
    project: source.repo,
    ...(source.token === undefined ? {} : { token: source.token }),
  };
}

async function giteaRelease(source: GiteaSource): Promise<ReleaseInfo> {
  if (source.baseUrl.length === 0) {
    throw new ReleaseError(
      "the Gitea release address is not configured; set DEVBOARD_GITEA_URL",
    );
  }
  let document: GiteaReleaseDocument;
  try {
    document = await giteaLatestRelease(giteaTarget(source));
  } catch (error) {
    // A 2xx answer that is not JSON is feed context, not a harness defect,
    // exactly like the command-based feed's unreadable description. A status
    // error still names a rejected request.
    if (error instanceof GiteaError && error.status === undefined) {
      throw new ReleaseFeedError(
        `the release feed returned an unreadable description: ${error.message}`,
      );
    }
    throw error;
  }
  return releaseFromDocument(document);
}

async function giteaReleaseForVersion(
  source: GiteaSource,
  version: string,
): Promise<ReleaseInfo> {
  const document = await giteaReleaseByTag(giteaTarget(source), `v${version}`);
  if (document === undefined) {
    throw new ReleaseError(`the release feed has no ${PACKAGE_NAME}@${version}`);
  }
  return releaseFromDocument(document);
}

/** Metadata for the latest version npm publishes, or its configured fallback. */
export async function latestRelease(source: ReleaseSource): Promise<ReleaseInfo> {
  if (source.kind === "dir") return directoryRelease(source.directory);
  if (source.kind === "gitea") return giteaRelease(source);
  try {
    const version = await npmLatestVersion(source.env);
    return { version, tag: `v${version}`, assets: [] };
  } catch (error) {
    if (source.fallback === undefined) throw error;
    return giteaRelease(source.fallback);
  }
}

/** How long one release asset download may run before it is killed. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface DownloadReleaseOptions {
  /** Deadline for each asset download; defaults to `DEFAULT_DOWNLOAD_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Copies the release tarball and checksum into `destination`. */
export async function downloadRelease(
  source: ReleaseSource,
  release: ReleaseInfo,
  destination: string,
  options: DownloadReleaseOptions = {},
): Promise<{ tarball: string; checksum: string }> {
  if (source.kind === "npm") {
    throw new ReleaseError("npm installs the registry artifact directly; no tarball download");
  }
  const tarball = join(destination, tarballName(release.version));
  const checksum = join(destination, checksumName(release.version));
  const names = new Set(release.assets.map((asset) => asset.name));
  if (!names.has(basename(tarball)) || !names.has(basename(checksum))) {
    throw new ReleaseError(
      `release ${release.tag} lacks ${basename(tarball)} or ${basename(checksum)}`,
    );
  }
  if (source.kind === "dir") {
    await mkdir(destination, { recursive: true });
    await copyFile(join(source.directory, basename(tarball)), tarball);
    await copyFile(join(source.directory, basename(checksum)), checksum);
    return { tarball, checksum };
  }
  if (source.baseUrl.length === 0) {
    throw new ReleaseError(
      "the Gitea release address is not configured; set DEVBOARD_GITEA_URL",
    );
  }
  const target = giteaTarget(source);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const [name, path] of [
    [basename(tarball), tarball],
    [basename(checksum), checksum],
  ] as const) {
    const asset = byName.get(name);
    if (asset === undefined) throw new ReleaseError(`release ${release.tag} lacks ${name}`);
    const giteaAsset: GiteaAsset = {
      name: asset.name,
      ...(asset.id === undefined ? {} : { id: asset.id }),
      ...(asset.size === undefined ? {} : { size: asset.size }),
    };
    try {
      await giteaDownloadAsset(target, giteaAsset, path, { timeoutMs });
    } catch (error) {
      throw error instanceof ReleaseError
        ? error
        : new ReleaseError(error instanceof Error ? error.message : String(error));
    }
  }
  return { tarball, checksum };
}

/** Parses the digest from a `sha256sum` file. */
export function parseChecksum(text: string): string | undefined {
  return /^([0-9a-fA-F]{64})\b/.exec(text.trim())?.[1]?.toLowerCase();
}

export async function fileSha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

/** Verifies a downloaded tarball; a mismatch is fatal and never installs anything. */
export async function verifyChecksum(tarball: string, checksumFile: string): Promise<string> {
  const expected = parseChecksum(await readFile(checksumFile, "utf8"));
  if (expected === undefined) {
    throw new ReleaseError(`unreadable checksum file: ${basename(checksumFile)}`);
  }
  const actual = await fileSha256(tarball);
  if (actual !== expected) {
    throw new ReleaseError(
      `checksum mismatch for ${basename(tarball)}: expected ${expected}, got ${actual}`,
    );
  }
  return actual;
}

export async function readPackageVersion(directory: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

export function packageDir(prefix: string): string {
  return join(prefix, "node_modules", "@dsdenes", "devboard");
}

/** The package directory under a host's npm prefix, kept for older callers. */
export const harnessPackageDir = packageDir;

export async function installedHarnessVersion(prefix: string): Promise<string | null> {
  return readPackageVersion(packageDir(prefix));
}

/** Records the devboard dependency the host prefix holds. */
export async function writePrefixPackage(prefix: string, version: string): Promise<void> {
  const path = join(prefix, "package.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null) existing = parsed as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const current = existing.dependencies;
  const dependencies =
    typeof current === "object" && current !== null
      ? { ...(current as Record<string, unknown>) }
      : {};
  delete dependencies[`@dsdenes/${"devboard-harness"}`];
  dependencies[PACKAGE_NAME] = version;
  await writeFile(
    path,
    `${JSON.stringify(
      {
        ...existing,
        name: typeof existing.name === "string" ? existing.name : "devboard-host",
        private: true,
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
}

export interface InstallTarballOptions {
  /** npm prefix that will hold `node_modules/@dsdenes/devboard`. */
  prefix: string;
  tarball: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Replaces the prefix's whole dependency tree with the staged one, so the
 * package and its runtime dependencies move together.
 */
async function swapNodeModules(prefix: string, staged: string): Promise<string> {
  const updates = join(prefix, ".tmp", "updates");
  await mkdir(updates, { recursive: true });
  const target = join(prefix, "node_modules");
  const backup = join(updates, `previous-${Date.now()}-${randomUUID()}`);
  let moved = false;
  if (existsSync(target)) {
    await rename(target, backup);
    moved = true;
  }
  try {
    await rename(staged, target);
  } catch (error) {
    if (moved) await rename(backup, target).catch(() => undefined);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
  return packageDir(prefix);
}

async function stagedInstall(
  prefix: string,
  spec: string,
  version: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const updates = join(prefix, ".tmp", "updates");
  await mkdir(updates, { recursive: true });
  const staging = join(updates, `stage-${version}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  const npm = env.DEVBOARD_NPM ?? "npm";
  try {
    const result = await exec(
      npm,
      [
        "install",
        "--prefix",
        staging,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
        spec,
      ],
      {
        // The server's working directory can be the package directory that an
        // earlier update replaced and deleted. npm inherits that process cwd
        // and cannot start in a missing directory, so run it in the staging
        // directory this call just created.
        cwd: staging,
        env,
        timeoutMs,
      },
    );
    if (result.code !== 0) throw npmInstallError(result, version);
    const staged = packageDir(staging);
    const stagedVersion = await readPackageVersion(staged);
    if (stagedVersion !== version) {
      throw new ReleaseError(
        `installed package reports ${stagedVersion ?? "no version"}, expected ${version}`,
      );
    }
    return await swapNodeModules(prefix, join(staging, "node_modules"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Installs one verified tarball through npm into a staging prefix and only then
 * moves the dependency tree into place. A failed install never damages the
 * package the running server still has open.
 */
export async function installHarnessTarball(options: InstallTarballOptions): Promise<string> {
  return await stagedInstall(
    options.prefix,
    options.tarball,
    options.version,
    options.env ?? process.env,
    options.timeoutMs ?? 10 * 60_000,
  );
}

async function installDirectoryRelease(
  source: Extract<ReleaseSource, { kind: "dir" }>,
  release: ReleaseInfo,
  prefix: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  downloadTimeoutMs?: number,
): Promise<string> {
  const downloadDir = join(stateDir, "updates", `download-${randomUUID()}`);
  await mkdir(downloadDir, { recursive: true });
  try {
    const files = await downloadRelease(source, release, downloadDir, {
      ...(downloadTimeoutMs === undefined ? {} : { timeoutMs: downloadTimeoutMs }),
    });
    await verifyChecksum(files.tarball, files.checksum);
    return await installHarnessTarball({
      prefix,
      tarball: files.tarball,
      version: release.version,
      env,
    });
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

async function installGiteaRelease(
  source: GiteaSource,
  release: ReleaseInfo,
  prefix: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  downloadTimeoutMs?: number,
): Promise<string> {
  const downloadDir = join(stateDir, "updates", `download-${randomUUID()}`);
  await mkdir(downloadDir, { recursive: true });
  try {
    const files = await downloadRelease(source, release, downloadDir, {
      ...(downloadTimeoutMs === undefined ? {} : { timeoutMs: downloadTimeoutMs }),
    });
    await verifyChecksum(files.tarball, files.checksum);
    return await installHarnessTarball({
      prefix,
      tarball: files.tarball,
      version: release.version,
      env,
    });
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}

/** Downloads, verifies, and installs one release; returns the installed version. */
export async function installRelease(options: {
  source: ReleaseSource;
  release: ReleaseInfo;
  prefix: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  /** Deadline for each asset download; defaults to `DEFAULT_DOWNLOAD_TIMEOUT_MS`. */
  downloadTimeoutMs?: number;
}): Promise<string> {
  const env = options.env ?? process.env;
  let installed: string;
  if (options.source.kind === "npm") {
    try {
      await stagedInstall(
        options.prefix,
        `${PACKAGE_NAME}@${options.release.version}`,
        options.release.version,
        options.source.env,
        10 * 60_000,
      );
      installed = options.release.version;
    } catch (error) {
      if (options.source.fallback === undefined) throw error;
      const release = await giteaReleaseForVersion(
        options.source.fallback,
        options.release.version,
      );
      installed = await installGiteaRelease(
        options.source.fallback,
        release,
        options.prefix,
        options.stateDir,
        options.source.env,
        options.downloadTimeoutMs,
      );
    }
  } else if (options.source.kind === "dir") {
    installed = await installDirectoryRelease(
      options.source,
      options.release,
      options.prefix,
      options.stateDir,
      env,
      options.downloadTimeoutMs,
    );
  } else {
    installed = await installGiteaRelease(
      options.source,
      options.release,
      options.prefix,
      options.stateDir,
      env,
      options.downloadTimeoutMs,
    );
  }
  await writePrefixPackage(options.prefix, installed);
  return installed;
}
