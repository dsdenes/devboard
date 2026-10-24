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

/** The installed package a host prefix holds. */
export function installedPackageDir(prefix: string): string {
  return join(prefix, "node_modules", "@dsdenes", "devboard-harness");
}

/** The checkout that contains this server's source code. */
export function runningHarnessDir(): string {
  return resolve(import.meta.dir, "..");
}

export function readHarnessVersion(directory: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("version" in parsed)) return null;
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

function isHarnessSource(directory: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "name" in parsed &&
      parsed.name === "@dsdenes/devboard-harness"
    );
  } catch {
    return false;
  }
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
