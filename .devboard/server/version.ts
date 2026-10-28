import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ServerVersion {
  /** The harness package version this process loaded at startup. */
  running: string | null;
  /** The harness package version the host's prefix holds now. */
  installed: string | null;
  /** The newest release the update check has seen, when it has seen one. */
  latest: string | null;
  /** True when a restart would load different code. */
  stale: boolean;
}

const HARNESS_NAME = "@dsdenes/devboard";
/**
 * The version the checked-in manifest records. A release writes its real
 * version into the packed copy, so this value marks an unpacked source tree.
 */
const SOURCE_VERSION = "0.1.0";
const GIT_TIMEOUT_MS = 5_000;

/** The installed package a host prefix holds. */
export function installedPackageDir(prefix: string): string {
  return join(prefix, "node_modules", "@dsdenes", "devboard");
}

/** The checkout that contains this server's source code. */
export function runningHarnessDir(): string {
  return resolve(import.meta.dir, "..");
}

interface HarnessManifest {
  name: string | null;
  version: string | null;
}

function readManifest(directory: string): HarnessManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      name: "name" in parsed && typeof parsed.name === "string" ? parsed.name : null,
      version:
        "version" in parsed && typeof parsed.version === "string" && parsed.version.length > 0
          ? parsed.version
          : null,
    };
  } catch {
    return null;
  }
}

function git(directory: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) return null;
    const output = result.stdout.trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

/** Git roots never move while a process runs, so the lookup is cached. */
const gitRoots = new Map<string, string | null>();

/**
 * The release version an unpacked source tree represents: `0.1.<commit-count>`,
 * the same value the release script writes into the packed manifest. Only the
 * canonical `<repo>/.devboard` source tree derives it; an npm prefix under a
 * host's `node_modules` keeps the packed version, so the host's own commit
 * count can never leak into a dashboard version.
 */
function sourceVersion(directory: string): string | null {
  const harness = resolve(directory);
  let root = gitRoots.get(harness);
  if (root === undefined) {
    const top = git(harness, ["rev-parse", "--show-toplevel"]);
    root = top === null ? null : resolve(top);
    gitRoots.set(harness, root);
  }
  if (root === null || resolve(root, ".devboard") !== harness) return null;
  const count = git(harness, ["rev-list", "--count", "HEAD"]);
  if (count === null || !/^[0-9]+$/.test(count)) return null;
  const commits = Number(count);
  return Number.isSafeInteger(commits) && commits > 0 ? `0.1.${commits}` : null;
}

export function readHarnessVersion(directory: string): string | null {
  const manifest = readManifest(directory);
  if (manifest === null) return null;
  if (manifest.name === HARNESS_NAME && manifest.version === SOURCE_VERSION) {
    return sourceVersion(directory) ?? manifest.version;
  }
  return manifest.version;
}

function isHarnessSource(directory: string): boolean {
  return readManifest(directory)?.name === HARNESS_NAME;
}

/**
 * True when the host serves a harness source checkout rather than an npm
 * prefix: `.devboard/package.json` names the harness package and no installed
 * copy sits in its `node_modules`. The predicate reads no repository name,
 * remote, or other host fact, so a host that installs the harness never
 * exposes source-checkout-only tooling.
 */
export function isHarnessSourceCheckout(repoDir: string): boolean {
  const prefix = join(resolve(repoDir), ".devboard");
  return isHarnessSource(prefix) && !existsSync(installedPackageDir(prefix));
}

/**
 * The harness a host would start next. An installed host keeps the package
 * under its npm prefix; the canonical checkout keeps its source tree. Without
 * either, the running checkout is the only code there is.
 */
export function hostHarnessDir(repoDir: string): string {
  const prefix = join(resolve(repoDir), ".devboard");
  const installed = installedPackageDir(prefix);
  if (existsSync(join(installed, "package.json"))) return installed;
  if (isHarnessSource(prefix)) return prefix;
  return runningHarnessDir();
}

/**
 * Compares the version this process started with against the version the
 * host's prefix holds now. A missing version never reports stale: the reload
 * control only appears when a restart would change code.
 */
export function serverVersion(
  repoDir: string,
  running: string | null,
  latest: string | null = null,
): ServerVersion {
  const installed = readHarnessVersion(hostHarnessDir(repoDir));
  return {
    running,
    installed,
    latest,
    stale: running !== null && installed !== null && running !== installed,
  };
}
