import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Checkout facts the issues worker and its dashboard discover at runtime.
 * Nothing here names a host, a user, or a repository: every value comes from
 * git, the caller, or the runtime environment.
 */

export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(directory: string, ...args: string[]): CommandOutcome {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", directory, ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode ?? 1,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** The checkout root containing `directory`, or undefined outside a checkout. */
export function topLevel(directory: string): string | undefined {
  const result = git(directory, "rev-parse", "--show-toplevel");
  return result.code === 0 && result.stdout.length > 0 ? result.stdout : undefined;
}

/** True when the checkout at `root` is a linked worktree, not the canonical one. */
export function isLinkedWorktree(root: string): boolean {
  const absolute = git(root, "rev-parse", "--absolute-git-dir");
  const common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (absolute.code !== 0 || common.code !== 0) return false;
  return absolute.stdout.length > 0 && absolute.stdout !== common.stdout;
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `owner/name` from any git remote URL form, or undefined. */
export function repositoryFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  const scp = /^[A-Za-z0-9_.-]+@[^:/]+:(.+)$/.exec(trimmed);
  const path = scp !== null ? scp[1]! : trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+\//, "");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return undefined;
  const name = segments[segments.length - 1]!.replace(/\.git$/, "");
  const owner = segments[segments.length - 2]!;
  const repository = `${owner}/${name}`;
  return REPOSITORY.test(repository) ? repository : undefined;
}

/** The remote URL of `origin`, if the checkout has one. */
export function originRemoteUrl(root: string): string | undefined {
  const remote = git(root, "remote", "get-url", "origin");
  return remote.code === 0 && remote.stdout.length > 0 ? remote.stdout : undefined;
}

/**
 * True only for a GitHub remote. GitLab, a local path, and an unreadable URL
 * are all refused: this harness supports one tracker and adds no webhook.
 */
export function isGitHubRemote(url: string): boolean {
  const trimmed = url.trim();
  const scp = /^[A-Za-z0-9_.-]+@([^:/]+):/.exec(trimmed);
  if (scp !== null) return scp[1]!.toLowerCase() === "github.com";
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

/** The `owner/name` the checkout's origin names, or undefined. */
export function originRepository(root: string): string | undefined {
  const url = originRemoteUrl(root);
  return url === undefined ? undefined : repositoryFromUrl(url);
}

/**
 * A live `owner/name` lookup for a process that outlives the origin's setup.
 * A remote can be added or re-pointed while a dashboard runs, so the answer
 * is re-read at most every `ttlMs` instead of frozen at startup. The reads
 * are cached: a dashboard polls its snapshot far more often than an origin
 * can change.
 */
export function cachedRepository(
  root: string,
  ttlMs = 10_000,
): () => string | null {
  let value: string | null = originRepository(root) ?? null;
  let checkedAt = Date.now();
  return () => {
    const now = Date.now();
    if (now - checkedAt >= ttlMs) {
      value = originRepository(root) ?? null;
      checkedAt = now;
    }
    return value;
  };
}

export function isRepositoryName(value: string): boolean {
  return REPOSITORY.test(value);
}

/** The harness directory a canonical checkout carries. */
export function harnessDirectory(root: string): string {
  return join(root, ".devboard");
}

/**
 * Validates a root exactly as the removed orchestrator did: a git checkout at
 * that exact path, not a linked worktree, carrying `.devboard/`.
 */
export function rootProblem(root: string): string | undefined {
  const absolute = resolve(root);
  if (!existsSync(absolute)) return `${absolute} does not exist`;
  const top = topLevel(absolute);
  if (top === undefined) return `${absolute} is not a git checkout`;
  if (resolve(top) !== absolute) return `${absolute} is not the checkout root (${top} is)`;
  if (isLinkedWorktree(absolute)) {
    return `${absolute} is a linked git worktree, not the canonical checkout`;
  }
  if (!existsSync(harnessDirectory(absolute))) {
    return `${absolute} has no .devboard directory`;
  }
  return undefined;
}

/** Resolves symlinks so a worker started from a link sees the real harness. */
export function realDirectory(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Finds an executable the way a shell would, using the supplied environment. */
export function findOnPath(
  name: string,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  const path = environment.PATH ?? "";
  for (const directory of path.split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Every directory an omp command may be installed in, checkout first. */
export function ompCommandPaths(
  root: string,
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const home = environment.HOME ?? homedir();
  return [
    join(resolve(root), ".omp", "commands"),
    join(resolve(root), ".omp", "agent", "commands"),
    join(home, ".omp", "commands"),
    join(home, ".omp", "agent", "commands"),
  ];
}

/** Every directory an omp extension may be installed in, checkout first. */
export function ompExtensionPaths(
  root: string,
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const home = environment.HOME ?? homedir();
  return [join(resolve(root), ".omp", "extensions"), join(home, ".omp", "extensions")];
}
