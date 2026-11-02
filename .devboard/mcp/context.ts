import { realpathSync } from "node:fs";
import type { LiveDashboard } from "./dashboard";
import { createForgeIssues, type ForgeIssues } from "../lib/forge-issues";
import { hostHarnessDir } from "../server/version";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The Devboard MCP server's resolved roots. Every path argument is judged
 * against them; nothing is read or written outside.
 */

export interface McpContext {
  repoDir: string;
  harnessDir: string;
  stateDir: string;
  environment: Record<string, string | undefined>;
  /** Test seam: the live dashboards a request must use instead of discovery. */
  dashboards?: LiveDashboard[];
  /** Test seam: the forge issue store a request must use. */
  forgeIssues?: ForgeIssues;
}

export function issuesFor(context: McpContext): ForgeIssues {
  return (
    context.forgeIssues ??
    createForgeIssues({ repoDir: context.repoDir, environment: context.environment })
  );
}

function gitTopLevel(directory: string): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", directory, "rev-parse", "--show-toplevel"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const top = result.stdout.toString().trim();
  return result.exitCode === 0 && top.length > 0 ? top : undefined;
}

function real(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function resolveContext(environment: Record<string, string | undefined> = process.env): McpContext {
  const cwd = process.cwd();
  const repoDir = resolve(
    environment.REPO_DIR ?? gitTopLevel(cwd) ?? cwd,
  );
  const configuredHarness = environment.DEVBOARD_HARNESS_DIR;
  const harnessDir =
    configuredHarness !== undefined && configuredHarness.length > 0
      ? resolve(configuredHarness)
      : hostHarnessDir(repoDir);
  // An installed host keeps the package under its prefix's `node_modules`, and
  // that copy is replaceable code, not host state. The default therefore names
  // the host prefix the launcher and dashboard share, never `harnessDir`.
  const stateDir = resolve(environment.STATE_DIR ?? join(repoDir, ".devboard", ".tmp"));
  return { repoDir, harnessDir, stateDir, environment };
}

/** A path argument that cannot leave one allowed root. */
export class PathRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathRefusal";
  }
}

function inside(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local.length === 0 || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
}

/**
 * Resolves a repository-relative path and refuses an absolute path, `..`, or a
 * symlink whose real target leaves the root. `mustExist` is for reads; a write
 * checks the deepest existing ancestor's real path.
 */
export function resolveContained(
  root: string,
  value: unknown,
  label: string,
  options: { mustExist?: boolean } = {},
): { absolute: string; relative: string } {
  if (typeof value !== "string" || value.length === 0) {
    throw new PathRefusal(`${label} must be a non-empty repository-relative path.`);
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new PathRefusal(`${label} must be relative, not absolute: ${normalized}`);
  }
  const parts = normalized.split("/");
  if (parts.includes("..")) {
    throw new PathRefusal(`${label} must not contain "..": ${normalized}`);
  }
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, normalized);
  if (!inside(absoluteRoot, absolute)) {
    throw new PathRefusal(`${label} leaves its root: ${normalized}`);
  }
  const rootReal = real(absoluteRoot);
  if (rootReal === undefined) {
    throw new PathRefusal(`${label} root does not exist: ${absoluteRoot}`);
  }
  let probe = absolute;
  for (;;) {
    const realProbe = real(probe);
    if (realProbe !== undefined) {
      if (!inside(rootReal, realProbe)) {
        throw new PathRefusal(`${label} resolves outside its root: ${normalized}`);
      }
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (options.mustExist === true && real(absolute) === undefined) {
    throw new PathRefusal(`${label} does not exist: ${normalized}`);
  }
  return { absolute, relative: relative(absoluteRoot, absolute).split(sep).join("/") };
}

/** One path reported relative to the repository, `/`-separated. */
export function repositoryRelative(repoDir: string, path: string): string {
  const local = relative(resolve(repoDir), resolve(path));
  return local.length === 0 || local.startsWith("..") ? resolve(path) : local.split(sep).join("/");
}

/**
 * Resolves a path argument that may be absolute or root-relative, refusing any
 * target whose real location leaves `root`. Agent prompts receive absolute
 * working directories, so the write tools accept them while keeping the same
 * confinement as the repository-relative tools.
 */
export function resolveWithin(
  root: string,
  value: unknown,
  label: string,
  options: { mustExist?: boolean } = {},
): { absolute: string; relative: string } {
  if (typeof value !== "string" || value.length === 0) {
    throw new PathRefusal(`${label} must be a non-empty path.`);
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new PathRefusal(`${label} must not contain "..": ${normalized}`);
  }
  const absoluteRoot = resolve(root);
  const absolute = resolve(isAbsolute(normalized) ? normalized : resolve(absoluteRoot, normalized));
  if (!inside(absoluteRoot, absolute)) {
    throw new PathRefusal(`${label} leaves its root: ${normalized}`);
  }
  const rootReal = real(absoluteRoot);
  if (rootReal === undefined) {
    throw new PathRefusal(`${label} root does not exist: ${absoluteRoot}`);
  }
  let probe = absolute;
  for (;;) {
    const realProbe = real(probe);
    if (realProbe !== undefined) {
      if (!inside(rootReal, realProbe)) {
        throw new PathRefusal(`${label} resolves outside its root: ${normalized}`);
      }
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (options.mustExist === true && real(absolute) === undefined) {
    throw new PathRefusal(`${label} does not exist: ${normalized}`);
  }
  return { absolute, relative: relative(absoluteRoot, absolute).split(sep).join("/") };
}
