import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { walkRegularFiles } from "../../lib/entry-point";

/**
 * The repository-wide occurrence search behind every naming issue. One concept
 * rename must touch every place the name in use appears, in every layer, so a
 * filing lists them all: server, client, tests, and documentation alike. The
 * walk skips `.git`, `node_modules`, `dist`, `.worktree`, and `.devboard/.tmp`,
 * follows no symbolic link, and honours the repository's own ignore rules.
 *
 * The published glossaries are the authority that names the concept, never a
 * rename target: Discover owns those files, and a rename must not rewrite the
 * vocabulary it obeys.
 */

/** A file larger than this is generated output, never a rename target. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Repository-relative path to the 1-based lines that use the term. */
export type OccurrenceIndex = Map<string, number[]>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The term as a whole word: `price` matches `price` and `The price`, never
 * `priceless` or `unitPrice`. Comparison is case-insensitive, because a
 * vocabulary change covers every capitalization of the same name.
 */
export function termPattern(term: string): RegExp | undefined {
  const trimmed = term.trim();
  if (trimmed.length === 0) return undefined;
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(trimmed)}(?![A-Za-z0-9_])`, "i");
}

/**
 * Every regular text file under the repository root that uses the term, with
 * the lines that use it. A path no line matches is absent from the index.
 */
export function occurrencesFor(repoDir: string, term: string): OccurrenceIndex {
  const pattern = termPattern(term);
  const index: OccurrenceIndex = new Map();
  if (pattern === undefined) return index;
  const root = resolve(repoDir);
  for (const path of walkRegularFiles(root)) {
    if (path.startsWith(".omp/discover/glossary/")) continue;
    const absolute = join(root, path);
    let text: string;
    try {
      if (statSync(absolute).size > MAX_FILE_BYTES) continue;
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const lines: number[] = [];
    const split = text.split(/\r?\n/);
    for (let index = 0; index < split.length; index += 1) {
      if (pattern.test(split[index] ?? "")) lines.push(index + 1);
    }
    if (lines.length > 0) index.set(path, lines);
  }
  return index;
}

/** The per-read cache the worker hands to every filing it proves. */
export type OccurrenceCache = Map<string, OccurrenceIndex>;

export function cachedOccurrences(
  cache: OccurrenceCache,
  repoDir: string,
  term: string,
): OccurrenceIndex {
  const key = `${resolve(repoDir)}\u0000${term.trim().toLowerCase()}`;
  const found = cache.get(key);
  if (found !== undefined) return found;
  const index = occurrencesFor(repoDir, term);
  cache.set(key, index);
  return index;
}

/**
 * True when the occurrence list covers every line the search found: each
 * matching line lies inside one listed span, and each listed span carries at
 * least one matching line. A path the search found and the list omits fails.
 */
export function occurrencesComplete(
  found: OccurrenceIndex,
  listed: ReadonlyMap<string, Array<[number, number]>>,
): string | undefined {
  for (const [path, lines] of found) {
    const spans = listed.get(path);
    if (spans === undefined || spans.length === 0) {
      return `the occurrence list omits ${path}`;
    }
    for (const line of lines) {
      if (!spans.some(([start, end]) => line >= start && line <= end)) {
        return `the occurrence list omits ${path}:${line}`;
      }
    }
  }
  for (const [path, spans] of listed) {
    const lines = found.get(path) ?? [];
    for (const [start, end] of spans) {
      if (!lines.some((line) => line >= start && line <= end)) {
        return `the occurrence ${path}:${start}${end === start ? "" : `-${end}`} names no use of the term`;
      }
    }
  }
  return undefined;
}
