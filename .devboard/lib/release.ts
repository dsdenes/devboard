import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Private release transport shared by the harness server, its release script,
 * and the verification fixtures. The harness package itself is never published
 * to a registry: each release is a tarball plus a `.sha256` asset on GitHub
 * Releases, read through the authenticated `gh` CLI.
 */

export const RELEASE_REPO = "dsdenes/devboard";
export const HARNESS_PACKAGE = "@dsdenes/devboard-harness";
export const RELEASE_PREFIX = "devboard-harness-";
export const CHECKSUM_SUFFIX = ".sha256";

export type ReleaseSource =
  | { kind: "dir"; directory: string }
  | { kind: "gh"; repo: string };

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

/** The release backend the environment asks for; CI and tests use a directory. */
export function releaseSource(env: NodeJS.ProcessEnv = process.env): ReleaseSource {
  const directory = env.DEVBOARD_RELEASE_DIR;
  if (directory !== undefined && directory.length > 0) {
    return { kind: "dir", directory: resolve(directory) };
  }
  return { kind: "gh", repo: env.DEVBOARD_RELEASE_REPO ?? RELEASE_REPO };
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

/**
 * Text the release tools print when the host cannot reach the feed at all:
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
  "(timed out)",
];

/** True when a release check failed because the feed was unreachable. */
export function isReleaseUnreachable(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return UNREACHABLE_PATTERNS.some((pattern) => message.includes(pattern));
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

interface GithubRelease {
  tag_name?: unknown;
  assets?: unknown;
}

async function githubRelease(repo: string): Promise<ReleaseInfo> {
  const result = await exec(
    "gh",
    ["api", `repos/${repo}/releases/latest`],
    { cwd: homedir(), timeoutMs: 60_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
  );
  if (result.code !== 0) throw failure("gh api releases/latest", result);
  let parsed: GithubRelease;
  try {
    parsed = JSON.parse(result.stdout) as GithubRelease;
  } catch {
    throw new ReleaseError("gh returned an unreadable release description");
  }
  if (typeof parsed.tag_name !== "string") {
    throw new ReleaseError("the latest release has no tag");
  }
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(parsed.assets)) {
    for (const asset of parsed.assets) {
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
  }
  return { version: versionFromTag(parsed.tag_name), tag: parsed.tag_name, assets };
}

/** Metadata for the latest release the configured backend exposes. */
export async function latestRelease(source: ReleaseSource): Promise<ReleaseInfo> {
  return source.kind === "dir" ? directoryRelease(source.directory) : githubRelease(source.repo);
}

async function downloadAsset(
  repo: string,
  asset: ReleaseAsset,
  destination: string,
): Promise<void> {
  if (asset.id === undefined) {
    throw new ReleaseError(`release asset ${asset.name} has no id`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await new Promise<void>((settle, reject) => {
    const child = spawn(
      "gh",
      [
        "api",
        "-H",
        "Accept: application/octet-stream",
        `repos/${repo}/releases/assets/${asset.id}`,
      ],
      {
        cwd: dirname(destination),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    );
    const sink = createWriteStream(destination);
    const err: Buffer[] = [];
    child.stdout.pipe(sink);
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      sink.destroy();
      reject(error);
    });
    sink.on("error", reject);
    child.on("close", (code) => {
      sink.end(() => {
        if (code === 0) settle();
        else {
          const detail = Buffer.concat(err).toString("utf8").trim().split("\n")[0] ?? "";
          reject(new ReleaseError(`gh asset download failed: ${detail || `exit ${code}`}`));
        }
      });
    });
  });
}

/** Copies the release tarball and checksum into `destination`. */
export async function downloadRelease(
  source: ReleaseSource,
  release: ReleaseInfo,
  destination: string,
): Promise<{ tarball: string; checksum: string }> {
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
  const tarballAsset = release.assets.find((asset) => asset.name === basename(tarball));
  const checksumAsset = release.assets.find((asset) => asset.name === basename(checksum));
  if (tarballAsset === undefined || checksumAsset === undefined) {
    throw new ReleaseError(`release ${release.tag} lacks a required asset`);
  }
  await downloadAsset(source.repo, tarballAsset, tarball);
  await downloadAsset(source.repo, checksumAsset, checksum);
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

export function harnessPackageDir(prefix: string): string {
  return join(prefix, "node_modules", "@dsdenes", "devboard-harness");
}

export async function installedHarnessVersion(prefix: string): Promise<string | null> {
  return readPackageVersion(harnessPackageDir(prefix));
}

/** Records the harness dependency the host prefix holds. */
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
  dependencies[HARNESS_PACKAGE] = version;
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
  /** npm prefix that will hold `node_modules/@dsdenes/devboard-harness`. */
  prefix: string;
  tarball: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Installs one verified tarball through npm into a staging prefix and only then
 * moves the package into place. A failed install never damages the package the
 * running server still has open.
 */
export async function installHarnessTarball(options: InstallTarballOptions): Promise<string> {
  const updates = join(options.prefix, ".tmp", "updates");
  await mkdir(updates, { recursive: true });
  const staging = join(updates, `stage-${options.version}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  const npm = options.env?.DEVBOARD_NPM ?? "npm";
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
        options.tarball,
      ],
      {
        // The server's working directory can be the package directory that an
        // earlier update replaced and deleted. npm inherits that process cwd
        // and cannot start in a missing directory, so run it in the staging
        // directory this call just created.
        cwd: staging,
        env: options.env ?? process.env,
        timeoutMs: options.timeoutMs ?? 10 * 60_000,
      },
    );
    if (result.code !== 0) throw failure("npm install", result);
    const staged = harnessPackageDir(staging);
    const stagedVersion = await readPackageVersion(staged);
    if (stagedVersion !== options.version) {
      throw new ReleaseError(
        `installed package reports ${stagedVersion ?? "no version"}, expected ${options.version}`,
      );
    }
    const parent = join(options.prefix, "node_modules", "@dsdenes");
    await mkdir(parent, { recursive: true });
    const target = join(parent, "devboard-harness");
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
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Downloads, verifies, and installs one release; returns the installed version. */
export async function installRelease(options: {
  source: ReleaseSource;
  release: ReleaseInfo;
  prefix: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const downloadDir = join(options.stateDir, "updates", `download-${randomUUID()}`);
  await mkdir(downloadDir, { recursive: true });
  try {
    const files = await downloadRelease(options.source, options.release, downloadDir);
    await verifyChecksum(files.tarball, files.checksum);
    await installHarnessTarball({
      prefix: options.prefix,
      tarball: files.tarball,
      version: options.release.version,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    await writePrefixPackage(options.prefix, options.release.version);
    return options.release.version;
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}
