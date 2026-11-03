import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { designSourcePaths, DesignInputError } from "../issues/design/audit";
import { designConfig } from "../issues/design/paths";

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
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", ".worktree", ".tmp"]);

/** One harness temporary tree is excluded by its full relative path. */
const SKIPPED_PREFIXES = [".devboard/.tmp"] as const;

/** The bytes read to decide whether a file is text. */
const TEXT_SAMPLE_BYTES = 8192;

function inside(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local.length === 0 || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
}

function skipped(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) return true;
  return SKIPPED_PREFIXES.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function byteOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every regular file under the root, as repository-relative paths in one
 * stable order. A symbolic link is never followed, so no file outside the
 * repository can enter a pool.
 */
function walkRegularFiles(repoDir: string): string[] {
  const root = resolve(repoDir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new EntryPointError(
      `the repository root ${root} is not readable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    let children;
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((left, right) => byteOrder(left.name, right.name));
    for (const entry of children) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (skipped(relativePath)) continue;
        visit(join(directory, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (skipped(relativePath)) continue;
      found.push(relativePath);
    }
  };
  visit(root, "");
  found.sort(byteOrder);
  return found;
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

/** A regular file whose first bytes carry no NUL and almost no control bytes. */
function isTextFile(path: string): boolean {
  const bytes = sample(path);
  if (bytes === undefined) return false;
  if (bytes.includes(0)) return false;
  let control = 0;
  for (const byte of bytes) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) control += 1;
  }
  return bytes.length === 0 || control / bytes.length < 0.1;
}

/** Every regular text file the scout pool admits. */
export function scoutPool(repoDir: string): string[] {
  const root = resolve(repoDir);
  return walkRegularFiles(root).filter((path) => {
    try {
      return isTextFile(join(root, path));
    } catch {
      return false;
    }
  });
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
    return designSourcePaths(repoDir, designConfig(environment)).sort(byteOrder);
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
function lineInside(text: string, hash: Buffer): number {
  const lines = withoutTrailingNewline(text);
  if (lines.length === 0) return 1;
  const meaningful = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.trim().length > 0);
  const candidates = meaningful.length > 0 ? meaningful : lines.map((line, index) => ({ line, index }));
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
  return { path, line: lineInside(text, hash), surface, seed };
}
