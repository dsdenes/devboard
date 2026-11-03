import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SINGLE_RESPONSIBILITY_CATEGORIES,
  SINGLE_RESPONSIBILITY_LABEL,
  TITLE_MAX,
  type SingleResponsibilityCategory,
} from "./paths";

/**
 * The skill's five violation directives and one filing's provenance. The
 * worker reads the skill once per cycle and proves every issue it publishes
 * against it: one category, the skill path, the category's directive copied
 * verbatim, and one evidence quote copied verbatim from the named file span.
 */

export class SkillInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInputError";
  }
}

const CATEGORY_TITLES: ReadonlyArray<readonly [string, SingleResponsibilityCategory]> = [
  ["mixed responsibilities", "mixed-responsibilities"],
  ["divergent change", "divergent-change"],
  ["accidental aggregation", "accidental-aggregation"],
  ["responsibility leakage", "responsibility-leakage"],
  ["artificial fragmentation", "artificial-fragmentation"],
];

export interface SkillDirectives {
  /** Repository-relative path of the skill document. */
  path: string;
  /** Every category with the skill's directive bullet, verbatim. */
  directives: ReadonlyMap<SingleResponsibilityCategory, string>;
}

/**
 * Reads the skill's `## Architectural Violations` bullets. The directive is
 * the whole bullet line, verbatim, so a filing can quote it without inventing
 * a word. A skill that does not publish all five is unusable: an audit with a
 * missing category would silently drop findings.
 */
export function readSkillDirectives(repoDir: string, skillPath: string): SkillDirectives {
  const root = resolve(repoDir);
  const normalized = skillPath.replace(/\\/g, "/");
  if (isAbsolute(normalized) || !inside(root, resolve(root, normalized))) {
    throw new SkillInputError(`${skillPath} resolves outside the repository`);
  }
  let text: string;
  try {
    text = readFileSync(join(root, normalized), "utf8");
  } catch {
    throw new SkillInputError(`${skillPath} is not readable`);
  }
  if (text.trim().length === 0) throw new SkillInputError(`${skillPath} is empty`);
  const directives = new Map<SingleResponsibilityCategory, string>();
  let inViolations = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      inViolations = line.slice(3).trim().toLowerCase() === "architectural violations";
      continue;
    }
    if (!inViolations) continue;
    const trimmed = line.trim();
    const match = /^-\s+\*\*(.+?):\*\*\s*(.+)$/.exec(trimmed);
    if (match === null) continue;
    const label = (match[1] ?? "").trim().toLowerCase();
    const entry = CATEGORY_TITLES.find(([title]) => title === label);
    if (entry === undefined) continue;
    directives.set(entry[1], trimmed);
  }
  for (const category of SINGLE_RESPONSIBILITY_CATEGORIES) {
    if (!directives.has(category)) {
      throw new SkillInputError(
        `${skillPath} publishes no Architectural Violations bullet for ${category}`,
      );
    }
  }
  return { path: normalized, directives };
}

function inside(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local.length === 0 || (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local));
}

/** Paths no evidence quote may come from; they are outside the crawl region. */
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", "dist", ".worktree"]);

function crawlable(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return false;
  return !relativePath.startsWith(".devboard/.tmp/") && relativePath !== ".devboard/.tmp";
}

export interface FilingProvenance {
  title: string;
  body: string;
  labels: readonly string[];
}

export type ProvenanceResult =
  | { ok: true; category: SingleResponsibilityCategory }
  | { ok: false; detail: string };

function section(body: string, heading: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase(),
  );
  if (start < 0) return undefined;
  const content: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().startsWith("## ")) break;
    content.push(line);
  }
  return content.join("\n").trim();
}

function lineSpan(value: string): [number, number] | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return undefined;
  }
  return [start, end];
}

interface EvidenceEntry {
  path: string;
  lines: string;
  quote: string;
}

/** Every `- \`path:lines\`` entry followed by a `> quote` line, in body order. */
function evidenceEntries(body: string): EvidenceEntry[] {
  const lines = body.split(/\r?\n/);
  const entries: EvidenceEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*-\s+`([^`]+)`\s*$/.exec(lines[index] ?? "");
    if (match === null) continue;
    const location = /^(.+?):(\d+(?:-\d+)?)$/.exec((match[1] ?? "").trim());
    if (location === null) continue;
    let quote = "";
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? "";
      if (candidate.trim().length === 0) continue;
      const quoted = /^\s*>\s?(.*)$/.exec(candidate);
      if (quoted !== null) quote = (quoted[1] ?? "").trim();
      break;
    }
    entries.push({ path: (location[1] ?? "").trim(), lines: location[2] ?? "", quote });
  }
  return entries;
}

function proveEvidence(repoDir: string, entry: EvidenceEntry): string | undefined {
  const path = entry.path.replace(/\\/g, "/");
  if (path.length === 0 || isAbsolute(path) || path.startsWith("../")) {
    return `evidence path ${entry.path} is not repository-relative`;
  }
  if (!crawlable(path)) return `evidence path ${path} is outside the crawl region`;
  const root = resolve(repoDir);
  const absolute = resolve(root, path);
  if (!inside(root, absolute)) return `evidence path ${path} leaves the repository`;
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return `evidence path ${path} does not exist`;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return `evidence path ${path} is not a regular file`;
  }
  const span = lineSpan(entry.lines);
  if (span === undefined) return `evidence path ${path} names no line range`;
  if (entry.quote.length === 0) return `evidence path ${path} carries no quote`;
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    return `evidence path ${path} is not readable`;
  }
  const lines = text.split(/\r?\n/);
  const [start, end] = span;
  if (end > lines.length) return `evidence path ${path}:${start}-${end} runs past the file`;
  if (!lines.slice(start - 1, end).join("\n").includes(entry.quote)) {
    return `the quote at ${path}:${start}-${end} is not copied from those lines`;
  }
  return undefined;
}

/**
 * Proves one read-back filing: one category from the skill's five, the skill
 * path, that category's directive verbatim, one component and one violation,
 * the affected component, the mixed-responsibility reason, the concrete
 * refactor, binary acceptance criteria, and at least one verbatim evidence
 * quote whose file is inside the crawl region.
 */
export function verifyFiling(
  repoDir: string,
  skill: SkillDirectives,
  filing: FilingProvenance,
): ProvenanceResult {
  const labels = [...new Set(filing.labels)];
  if (
    labels.length !== 1 ||
    labels[0] !== SINGLE_RESPONSIBILITY_LABEL
  ) {
    return {
      ok: false,
      detail: `the labels are ${JSON.stringify([...filing.labels])}, not exactly ["${SINGLE_RESPONSIBILITY_LABEL}"]`,
    };
  }
  const title = filing.title.trim();
  if (title.length === 0 || /[\r\n]/.test(filing.title) || [...title].length > TITLE_MAX) {
    return { ok: false, detail: `the title is not one plain line of at most ${TITLE_MAX} characters` };
  }
  if (/^\[[^\]]+\]/.test(title) || /^single-responsibility\s*:/i.test(title)) {
    return { ok: false, detail: "the title carries a prefix" };
  }
  const body = filing.body;
  const mentioned = SINGLE_RESPONSIBILITY_CATEGORIES.filter((category) =>
    body.includes(category),
  );
  if (mentioned.length !== 1) {
    return {
      ok: false,
      detail:
        mentioned.length === 0
          ? "the body names none of the five categories"
          : `the body names ${mentioned.length} categories: ${mentioned.join(", ")}`,
    };
  }
  const category = mentioned[0]!;
  if (section(body, "Category")?.trim() !== category) {
    return { ok: false, detail: `the Category section is not exactly ${category}` };
  }
  if (!body.includes(skill.path)) {
    return { ok: false, detail: `the body does not cite the skill path ${skill.path}` };
  }
  const directive = skill.directives.get(category);
  if (directive === undefined || !body.includes(directive)) {
    return {
      ok: false,
      detail: `the body does not quote the ${category} directive verbatim`,
    };
  }
  for (const heading of [
    "Component",
    "Why the responsibilities are mixed",
    "Refactor",
    "Acceptance criteria",
  ]) {
    const content = section(body, heading);
    if (content === undefined || content.trim().length === 0) {
      return { ok: false, detail: `the body has no ${heading} section` };
    }
  }
  const criteria = section(body, "Acceptance criteria") ?? "";
  if (!criteria.split(/\r?\n/).some((line) => /^\s*-\s+\S/.test(line))) {
    return { ok: false, detail: "the acceptance criteria carry no binary statement" };
  }
  const evidence = evidenceEntries(body);
  if (evidence.length === 0) {
    return { ok: false, detail: "the body carries no evidence entry with a line span and quote" };
  }
  for (const entry of evidence) {
    const problem = proveEvidence(repoDir, entry);
    if (problem !== undefined) return { ok: false, detail: problem };
  }
  return { ok: true, category };
}
