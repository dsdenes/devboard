import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A root's own ignore rules: every `.gitignore` from the root down to a path's
 * directory, applied in order so the last matching rule wins.
 *
 * This is the answer for a root that is not a git work tree, where git cannot
 * report which untracked paths its rules exclude. A checkout with no `.git`
 * directory still keeps its secrets file and generated trees behind
 * `.gitignore`, so the pool must read those rules rather than admit them.
 */

export interface IgnoreRules {
  /** Whether one repository-relative, `/`-separated path is excluded. */
  ignored(relativePath: string, isDirectory: boolean): boolean;
}

interface Rule {
  /** Repository-relative directory whose `.gitignore` declared the rule. */
  base: string;
  negate: boolean;
  directoryOnly: boolean;
  /** A pattern without a slash matches the entry's own name at any depth. */
  basenameOnly: boolean;
  pattern: RegExp;
}

const IGNORE_FILE = ".gitignore";

class RootIgnoreRules implements IgnoreRules {
  private readonly parsed = new Map<string, Rule[]>();

  constructor(private readonly root: string) {}

  ignored(relativePath: string, isDirectory: boolean): boolean {
    const segments = relativePath.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const candidate = segments.slice(0, length).join("/");
      const candidateIsDirectory = length < segments.length || isDirectory;
      if (this.decides(candidate, candidateIsDirectory)) return true;
    }
    return false;
  }

  /** The last rule matching the path decides, deepest `.gitignore` last. */
  private decides(relativePath: string, isDirectory: boolean): boolean {
    let ignored = false;
    const segments = relativePath.split("/");
    const directories: string[] = [""];
    let base = "";
    for (const segment of segments.slice(0, -1)) {
      base = base.length === 0 ? segment : `${base}/${segment}`;
      directories.push(base);
    }
    for (const directory of directories) {
      for (const rule of this.rules(directory)) {
        if (matches(rule, relativePath, isDirectory)) ignored = !rule.negate;
      }
    }
    return ignored;
  }

  private rules(base: string): Rule[] {
    const cached = this.parsed.get(base);
    if (cached !== undefined) return cached;
    const rules = parseIgnoreFile(this.root, base);
    this.parsed.set(base, rules);
    return rules;
  }
}

/** The ignore rules one root's `.gitignore` files declare. */
export function readIgnoreRules(root: string): IgnoreRules {
  return new RootIgnoreRules(resolve(root));
}

function parseIgnoreFile(root: string, base: string): Rule[] {
  const directory = base.length === 0 ? root : join(root, base);
  let text: string;
  try {
    text = readFileSync(join(directory, IGNORE_FILE), "utf8");
  } catch {
    return [];
  }
  const rules: Rule[] = [];
  for (const line of text.split("\n")) {
    const rule = parseRule(line, base);
    if (rule !== undefined) rules.push(rule);
  }
  return rules;
}

function parseRule(line: string, base: string): Rule | undefined {
  let source = line.replace(/\r$/, "");
  if (source.startsWith("#")) return undefined;
  source = trimTrailingSpaces(source);
  if (source.length === 0) return undefined;
  let negate = false;
  if (source.startsWith("!")) {
    negate = true;
    source = source.slice(1);
  }
  let directoryOnly = false;
  if (source.endsWith("/")) {
    directoryOnly = true;
    source = source.slice(0, -1);
  }
  if (source.length === 0) return undefined;
  const basenameOnly = !source.includes("/");
  if (source.startsWith("/")) source = source.slice(1);
  if (source.length === 0) return undefined;
  return { base, negate, directoryOnly, basenameOnly, pattern: globToRegExp(source) };
}

/** Trailing spaces are stripped unless the last one is escaped. */
function trimTrailingSpaces(source: string): string {
  let end = source.length;
  while (end > 0 && source[end - 1] === " ") {
    let escapes = 0;
    let index = end - 2;
    while (index >= 0 && source[index] === "\\") {
      escapes += 1;
      index -= 1;
    }
    if (escapes % 2 === 1) break;
    end -= 1;
  }
  return source.slice(0, end);
}

function matches(rule: Rule, relativePath: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  const local = rule.base.length === 0 ? relativePath : relativePath.slice(rule.base.length + 1);
  if (rule.basenameOnly) {
    const slash = local.lastIndexOf("/");
    return rule.pattern.test(slash === -1 ? local : local.slice(slash + 1));
  }
  return rule.pattern.test(local);
}

function escapeLiteral(character: string): string {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

/** One `.gitignore` glob, anchored to the directory that declared it. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    const character = glob[index]!;
    if (character === "\\") {
      const literal = glob[index + 1];
      source += literal === undefined ? "\\\\" : escapeLiteral(literal);
      index += literal === undefined ? 1 : 2;
      continue;
    }
    if (character === "*") {
      let stars = 1;
      while (glob[index + stars] === "*") stars += 1;
      const after = index + stars;
      const segmentStart = index === 0 || glob[index - 1] === "/";
      const segmentEnd = after === glob.length || glob[after] === "/";
      if (stars > 1 && segmentStart && segmentEnd) {
        if (glob[after] === "/") {
          source += "(?:[^/]+/)*";
          index = after + 1;
        } else {
          source += ".*";
          index = after;
        }
        continue;
      }
      source += "[^/]*";
      index = after;
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (character === "[") {
      const close = glob.indexOf("]", index + 2);
      if (close === -1) {
        source += "\\[";
        index += 1;
        continue;
      }
      let body = glob.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      source += `[${negated ? "^" : ""}${body.replace(/\\/g, "\\\\")}]`;
      index = close + 1;
      continue;
    }
    source += escapeLiteral(character);
    index += 1;
  }
  return new RegExp(`^${source}$`);
}
