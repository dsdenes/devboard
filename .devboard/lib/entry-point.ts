import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { designSourcePaths, DesignInputError } from "../issues/design/audit";
import { designConfig } from "../issues/design/paths";
import { readIgnoreRules } from "./ignore-rules";

/**
 * The one seeded entry-point picker every crawling background agent shares.
 *
 * The picker is read-only and deterministic given its surface, its seed, and
 * the eligible set: one surface and seed over an unchanged corpus always
 * return the same repository-relative path and line. It never creates,
 * edits, or deletes a file, and every eligible path is proven inside the
 * repository root before it is chosen.
 */

export const ENTRY_POINT_SURFACES = [
  "scout",
  "design",
  "dead-code",
  "single-responsibility",
  "consistent-naming",
] as const;

export type EntryPointSurface = (typeof ENTRY_POINT_SURFACES)[number];

export function isEntryPointSurface(value: unknown): value is EntryPointSurface {
  return (
    typeof value === "string" && (ENTRY_POINT_SURFACES as readonly string[]).includes(value)
  );
}

export class EntryPointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntryPointError";
  }
}

export interface EntryPoint {
  /** Repository-relative, `/`-separated. */
  path: string;
  /** A 1-based line inside that file. */
  line: number;
  surface: EntryPointSurface;
  seed: string;
}

export interface EntryPointRequest {
  repoDir: string;
  surface: unknown;
  /** Omitted or empty asks for a fresh pseudo-random seed, returned in the pick. */
  seed?: unknown;
  environment?: Record<string, string | undefined>;
}

/**
 * Directories no pool descends into. Generated output, vendored packages,
 * temporary state, and per-task worktrees are not the repository under review.
 */
const SKIPPED_DIRECTORIES: Record<string, true> = {
  ".git": true,
  node_modules: true,
  dist: true,
  ".worktree": true,
  ".tmp": true,
};

/** One harness temporary tree is excluded by its full relative path. */
const SKIPPED_PREFIXES = [".devboard/.tmp"] as const;

/** Every tree the pools skip in any checkout, whether or not it exists yet. */
const EXCLUDED_TREES: readonly string[] = [
  ...Object.keys(SKIPPED_DIRECTORIES),
  ...SKIPPED_PREFIXES,
];

/** The bytes read to decide whether a file is text. */
const TEXT_SAMPLE_BYTES = 8192;

function inside(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local.length === 0 || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
}

function skipped(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => SKIPPED_DIRECTORIES[part] === true)) return true;
  return SKIPPED_PREFIXES.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function byteOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Lists one directory; the walk's seam for an injected unreadable subtree. */
export type DirectoryReader = (directory: string) => Dirent[];

const listDirectory: DirectoryReader = (directory) =>
  readdirSync(directory, { withFileTypes: true });

interface PoolWalk {
  /** Every regular file the fixed and ignore-rule exclusions admit. */
  files: string[];
  /** Every directory the walk refused to descend into, repository-relative. */
  excludedTrees: string[];
}

/**
 * One root's pool, walked through its own ignore rules: a directory the fixed
 * exclusions or a `.gitignore` excludes is pruned and named, so no file under
 * it can enter a pool. A directory the walk cannot read is never dropped: the
 * walk throws one `EntryPointError` naming every such directory by its
 * repository-relative path and the reason, so a pool that omits a subtree can
 * never pass for a repository that lacks those files.
 */
function walkPool(root: string, readDirectory: DirectoryReader): PoolWalk {
  const rules = readIgnoreRules(root);
  const unreadable: { path: string; reason: string }[] = [];
  const files: string[] = [];
  const excludedTrees: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let children;
    try {
      children = readDirectory(directory);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (prefix.length === 0) {
        throw new EntryPointError(`the repository root ${directory} is not readable: ${reason}`);
      }
      unreadable.push({ path: prefix, reason });
      return;
    }
    children.sort((left, right) => byteOrder(left.name, right.name));
    for (const entry of children) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (skipped(relativePath) || rules.ignored(relativePath, true)) {
          excludedTrees.push(relativePath);
          continue;
        }
        visit(join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (skipped(relativePath) || rules.ignored(relativePath, false)) continue;
      files.push(relativePath);
    }
  };
  visit(root, "");
  if (unreadable.length > 0) {
    unreadable.sort((left, right) => byteOrder(left.path, right.path));
    const paths = unreadable.map((entry) => entry.path);
    const detail = unreadable.map((entry) => `${entry.path}: ${entry.reason}`).join("; ");
    throw new EntryPointError(
      `the repository ${paths.length === 1 ? "directory" : "directories"} ${paths.join(", ")} ` +
        `${paths.length === 1 ? "is" : "are"} not readable: ${detail}`,
    );
  }
  files.sort(byteOrder);
  excludedTrees.sort(byteOrder);
  return { files, excludedTrees };
}

/**
 * Every regular file under the root, as repository-relative paths in one
 * stable order. A symbolic link is never followed, so no file outside the
 * repository can enter a pool, and a path the root's own ignore rules exclude
 * is never returned.
 */
export function walkRegularFiles(
  repoDir: string,
  readDirectory: DirectoryReader = listDirectory,
): string[] {
  return walkPool(resolve(repoDir), readDirectory).files;
}

/** One spawn of git in the root; null keeps the caller on its fallback. */
function gitOutput(root: string, args: readonly string[]): Buffer | null {
  const result = spawnSync("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) return null;
  return result.stdout;
}

/** NUL-separated git paths, so no repository filename is ever split. */
function gitPaths(root: string, args: readonly string[]): string[] | null {
  const output = gitOutput(root, args);
  if (output === null) return null;
  return output.toString("utf8").split("\0").filter((path) => path.length > 0);
}

/**
 * Whether the root is itself the top of a git work tree. A directory inside
 * another checkout is not: it would borrow that checkout's index and rules.
 */
function gitWorkTree(root: string): boolean {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return false;
  }
  const output = gitOutput(root, ["rev-parse", "--show-toplevel"]);
  if (output === null) return false;
  const top = output.toString("utf8").replace(/\n$/, "");
  if (top.length === 0) return false;
  try {
    return realpathSync(top) === real;
  } catch {
    return false;
  }
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The paths among the given candidates that any of the root's ignore rules
 * matches, whether or not git tracks them. Null keeps the caller on its
 * fallback when git cannot answer.
 */
function gitIgnoredAmong(root: string, paths: readonly string[]): Set<string> | null {
  if (paths.length === 0) return new Set();
  const result = spawnSync("git", ["-C", root, "check-ignore", "-z", "--no-index", "--stdin"], {
    input: paths.map((path) => `${path}\0`).join(""),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) return null;
  if (result.status !== 0 && result.status !== 1) return null;
  return new Set(result.stdout.toString("utf8").split("\0").filter((path) => path.length > 0));
}

/**
 * The tracked, untracked, and non-ignored files of a git work tree, or null
 * when the root is not one. This set is the repository's own answer to what
 * its content is, so a file its ignore rules exclude never enters a pool.
 */
function gitAdmittedFiles(root: string): string[] | null {
  if (!gitWorkTree(root)) return null;
  const paths = gitPaths(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (paths === null) return null;
  const ignored = gitIgnoredAmong(root, paths);
  if (ignored === null) return null;
  const files: string[] = [];
  for (const path of paths) {
    if (skipped(path) || ignored.has(path)) continue;
    const absolute = resolve(root, path);
    if (!inside(root, absolute)) continue;
    if (!regularFile(absolute)) continue;
    files.push(path);
  }
  files.sort(byteOrder);
  return files;
}

/**
 * Every directory git's ignore rules exclude, or null when it is no work
 * tree. A whole untracked tree is one entry; an ignored path inside a tracked
 * tree names each of its excluded parent directories, so the published list
 * covers every tree the pool skipped whatever git tracks.
 */
function gitIgnoredTrees(root: string): string[] | null {
  if (!gitWorkTree(root)) return null;
  const collapsed = gitPaths(root, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (collapsed === null) return null;
  const trees = new Set(
    collapsed.filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1)),
  );
  const candidates = gitPaths(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (candidates === null) return null;
  const ignored = gitIgnoredAmong(root, candidates);
  if (ignored === null) return null;
  const parents = new Set<string>();
  for (const path of ignored) {
    const segments = path.split("/").slice(0, -1);
    for (let length = 1; length <= segments.length; length += 1) {
      parents.add(segments.slice(0, length).join("/"));
    }
  }
  const ignoredParents = gitIgnoredAmong(root, [...parents]);
  if (ignoredParents === null) return null;
  for (const tree of ignoredParents) trees.add(tree);
  return [...trees].sort(byteOrder);
}

/** Whether a repository-relative path is excluded by any of the root's rules. */
function isIgnoredPath(root: string, relativePath: string): boolean {
  if (gitWorkTree(root)) {
    const result = spawnSync(
      "git",
      ["-C", root, "check-ignore", "-q", "--no-index", "--", relativePath],
      { stdio: "ignore" },
    );
    if (result.status === 0) return true;
    if (result.status === 1) return false;
  }
  return readIgnoreRules(root).ignored(relativePath, false);
}

function sample(path: string): Buffer | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(TEXT_SAMPLE_BYTES);
    const read = readSync(descriptor, buffer, 0, TEXT_SAMPLE_BYTES, 0);
    return buffer.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * A regular file whose first bytes carry no NUL, almost no control bytes, and
 * at least one non-whitespace byte. A file with nothing to read has no line to
 * name, so it never enters a pool.
 */
function isTextFile(path: string): boolean {
  const bytes = sample(path);
  if (bytes === undefined) return false;
  if (bytes.includes(0)) return false;
  let control = 0;
  let visible = false;
  for (const byte of bytes) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) control += 1;
    if (byte > 32) visible = true;
  }
  return visible && control / bytes.length < 0.1;
}

/**
 * Every regular text file the scout pool admits: git's own view of a work
 * tree, where an ignored path is never listed, and the ignore-aware walk for a
 * root git does not own.
 */
export function scoutPool(repoDir: string): string[] {
  const root = resolve(repoDir);
  const files = gitAdmittedFiles(root) ?? walkRegularFiles(root);
  return files.filter((path) => isTextFile(join(root, path)));
}

/**
 * Every tree the pools skip for one root: the fixed directories and every tree
 * the root's own ignore rules exclude. A scan request publishes this list, so
 * its prompt and the pool cannot disagree about what the repository is.
 */
export function excludedRoots(repoDir: string): string[] {
  const root = resolve(repoDir);
  const derived = gitIgnoredTrees(root) ?? walkPool(root, listDirectory).excludedTrees;
  const roots: string[] = [...EXCLUDED_TREES];
  for (const path of derived) {
    if (!roots.includes(path)) roots.push(path);
  }
  return roots;
}

/**
 * The design pool: the configured Design System source set, read through the
 * same audit input the Design System cycle audits.
 */
export function designPool(
  repoDir: string,
  environment: Record<string, string | undefined> = process.env,
): string[] {
  try {
    const root = resolve(repoDir);
    return designSourcePaths(root, designConfig(environment))
      .filter((path) => isTextFile(resolve(root, path)))
      .sort(byteOrder);
  } catch (error) {
    if (error instanceof DesignInputError) {
      throw new EntryPointError(`the design pool is empty: ${error.message}`);
    }
    throw error;
  }
}

const CODE_LINE =
  /^\s*(?:import|export|from|class|def|function|const|let|var|interface|type|enum|package|use|#include|public|private|protected|func|fn|impl|module|namespace|struct|trait|async|await|return|if|for|while|switch|case)\b/m;
const RULE_LINE = /^\s*[.#@&*:a-zA-Z][^{}\n]*\{[^}\n]*$/m;

function readHead(path: string): string {
  const bytes = sample(path);
  return bytes === undefined ? "" : bytes.toString("utf8");
}

/**
 * The source extensions the host actually uses, discovered from the files
 * themselves: an extension is eligible when at least one file with it carries
 * a line shaped like code or like a style rule. No project layout is assumed.
 */
export function discoverSourceExtensions(repoDir: string): string[] {
  const root = resolve(repoDir);
  const extensions = new Set<string>();
  for (const path of scoutPool(root)) {
    const extension = extname(path).toLowerCase();
    if (extension.length === 0) continue;
    if (extensions.has(extension)) continue;
    const head = readHead(join(root, path));
    if (CODE_LINE.test(head) || RULE_LINE.test(head)) extensions.add(extension);
  }
  return [...extensions].sort(byteOrder);
}

/** The dead-code pool: text files whose extension the host uses as source. */
export function deadCodePool(repoDir: string): string[] {
  const root = resolve(repoDir);
  const extensions = new Set(discoverSourceExtensions(root));
  return scoutPool(root)
    .filter((path) => extensions.has(extname(path).toLowerCase()))
    .sort(byteOrder);
}

/**
 * Directories whose files are evidence of behavior, never the component under
 * audit: a test, a fixture, and a stub each describe another unit's contract.
 */
const NON_COMPONENT_DIRECTORIES = new Set(["fixtures", "tests", "stubs"]);

/** A test or spec file names the behavior of another component. */
function isTestFile(path: string): boolean {
  return /\.(test|spec)\./.test(path);
}

/** Formats that are documentation or configuration, never audited source. */
const NON_SOURCE_EXTENSIONS: Record<string, true> = {
  ".md": true,
  ".markdown": true,
  ".txt": true,
  ".json": true,
  ".yml": true,
  ".yaml": true,
  ".toml": true,
  ".lock": true,
};

/** A path outside every fixtures, tests, or stubs directory. */
function isComponentPath(path: string): boolean {
  const directories = path.split("/").slice(0, -1);
  return !directories.some((directory) => NON_COMPONENT_DIRECTORIES.has(directory));
}

/**
 * The single-responsibility pool: source files the host actually writes as
 * components, excluding test, specification, fixture, stub, and documentation
 * files.
 */
export function singleResponsibilityPool(repoDir: string): string[] {
  return deadCodePool(repoDir)
    .filter(
      (path) =>
        !isTestFile(path) &&
        isComponentPath(path) &&
        !NON_SOURCE_EXTENSIONS[extname(path).toLowerCase()],
    )
    .sort(byteOrder);
}

/**
 * The consistent-naming pool: the same component source set, because a
 * concept's name is audited in code, never in a test, a fixture, or a stub. It
 * covers every source tree the host writes — the server and the client alike.
 */
export function consistentNamingPool(repoDir: string): string[] {
  return singleResponsibilityPool(repoDir);
}

/** One pool by surface; an unknown surface is refused before any read. */
export function eligibleFiles(
  repoDir: string,
  surface: EntryPointSurface,
  environment: Record<string, string | undefined> = process.env,
): string[] {
  switch (surface) {
    case "scout":
      return scoutPool(repoDir);
    case "design":
      return designPool(repoDir, environment);
    case "dead-code":
      return deadCodePool(repoDir);
    case "single-responsibility":
      return singleResponsibilityPool(repoDir);
    case "consistent-naming":
      return consistentNamingPool(repoDir);
  }
}

function freshSeed(): string {
  return randomBytes(16).toString("hex");
}

function digest(surface: EntryPointSurface, seed: string): Buffer {
  return createHash("sha256").update(`${surface}\u0000${seed}`).digest();
}

function withoutTrailingNewline(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

/** A deterministic line inside the chosen file among its non-blank lines. */
function lineInside(text: string, path: string, hash: Buffer): number {
  const candidates = withoutTrailingNewline(text)
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.trim().length > 0);
  if (candidates.length === 0) {
    throw new EntryPointError(`the entry point ${path} has no non-blank line to name`);
  }
  const offset = hash.readUInt32BE(4) % candidates.length;
  return candidates[offset]!.index + 1;
}

/**
 * Picks one eligible file and a line inside it. The same surface and seed over
 * an unchanged eligible set return the same path and line; an omitted seed
 * produces a fresh one and returns it so the pick can be replayed.
 */
export function pickEntryPoint(request: EntryPointRequest): EntryPoint {
  if (!isEntryPointSurface(request.surface)) {
    throw new EntryPointError(
      `unknown entry-point surface ${String(request.surface)}; use one of ` +
        `${ENTRY_POINT_SURFACES.join(", ")}`,
    );
  }
  if (request.seed !== undefined && typeof request.seed !== "string") {
    throw new EntryPointError("the entry-point seed must be a string when it is given");
  }
  const root = resolve(request.repoDir);
  const rootReal = (() => {
    try {
      return realpathSync(root);
    } catch {
      throw new EntryPointError(`the repository root ${root} does not exist`);
    }
  })();
  const environment = request.environment ?? process.env;
  const surface = request.surface;
  const files = eligibleFiles(root, surface, environment);
  if (files.length === 0) {
    throw new EntryPointError(`the ${surface} entry-point pool has no eligible file`);
  }
  const seed = request.seed === undefined || request.seed.length === 0 ? freshSeed() : request.seed;
  const hash = digest(surface, seed);
  const path = files[hash.readUInt32BE(0) % files.length]!;
  const absolute = resolve(root, path);
  if (!inside(root, absolute)) {
    throw new EntryPointError(`the ${surface} entry point leaves the repository: ${path}`);
  }
  if (isIgnoredPath(root, path)) {
    throw new EntryPointError(
      `the ${surface} entry point ${path} is excluded by the repository's ignore rules`,
    );
  }
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new EntryPointError(`the ${surface} entry point ${path} is not readable`);
  }
  if (!inside(rootReal, real)) {
    throw new EntryPointError(`the ${surface} entry point resolves outside the repository: ${path}`);
  }
  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    throw new EntryPointError(`the ${surface} entry point ${path} is not readable`);
  }
  return { path, line: lineInside(text, path, hash), surface, seed };
}
