import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CONSISTENT_NAMING_CATEGORIES,
  CONSISTENT_NAMING_LABEL,
  TITLE_MAX,
  type ConsistentNamingCategory,
} from "./paths";
import {
  conceptsDefinedAs,
  conceptsUsingTerm,
  normalizeName,
  preferredLabel,
  type Glossary,
  type GlossaryConcept,
} from "./glossary";
import {
  cachedOccurrences,
  occurrencesComplete,
  type OccurrenceCache,
  type OccurrenceIndex,
} from "./occurrences";

/**
 * The skill's seven violation directives and one filing's provenance. The
 * worker reads the skill once per cycle and proves every issue it publishes
 * against it: one category, the skill path, the category's directive copied
 * verbatim, one concept, the name in use and the proposed name, a verbatim
 * evidence quote, the complete repository-wide occurrence list, and — where
 * the repository publishes glossaries — the glossary's preferred label.
 */

export class SkillInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInputError";
  }
}

const CATEGORY_TITLES: ReadonlyArray<readonly [string, ConsistentNamingCategory]> = [
  ["synonymous naming", "synonymous naming"],
  ["semantic ambiguity", "semantic ambiguity"],
  ["inconsistent vocabulary", "inconsistent vocabulary"],
  ["misleading naming", "misleading naming"],
  ["unnecessary terminology", "unnecessary terminology"],
  ["conceptual collision", "conceptual collision"],
  ["implementation-driven naming", "implementation-driven naming"],
];

export interface SkillDirectives {
  /** Repository-relative path of the skill document. */
  path: string;
  /** Every category with the skill's directive, verbatim and unwrapped. */
  directives: ReadonlyMap<ConsistentNamingCategory, string>;
}

/**
 * Reads the skill's `## Architectural Violations` bullets. A bullet wraps over
 * several lines, so its directive is the whole bullet text with the wrapped
 * lines joined by single spaces: the same sentence a reader copies out of the
 * file. A skill that does not publish all seven is unusable, because an audit
 * with a missing category would silently drop findings.
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
  const directives = new Map<ConsistentNamingCategory, string>();
  const lines = text.split(/\r?\n/);
  let inViolations = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      inViolations = line.slice(3).trim().toLowerCase() === "architectural violations";
      index += 1;
      continue;
    }
    if (!inViolations) {
      index += 1;
      continue;
    }
    const match = /^-\s+\*\*(.+?):\*\*\s*(.+)$/.exec(line.trim());
    if (match === null) {
      index += 1;
      continue;
    }
    const parts = [(match[2] ?? "").trim()];
    let next = index + 1;
    while (next < lines.length) {
      const continuation = lines[next] ?? "";
      const trimmed = continuation.trim();
      if (
        trimmed.length === 0 ||
        trimmed.startsWith("- ") ||
        continuation.startsWith("#")
      ) {
        break;
      }
      parts.push(trimmed);
      next += 1;
    }
    index = next;
    const label = (match[1] ?? "").trim().toLowerCase();
    const entry = CATEGORY_TITLES.find(([title]) => title === label);
    if (entry === undefined) continue;
    directives.set(entry[1], parts.join(" ").replace(/\s+/g, " ").trim());
  }
  for (const category of CONSISTENT_NAMING_CATEGORIES) {
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

/** Paths no evidence quote or occurrence may come from. */
const EXCLUDED_SEGMENTS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  dist: true,
  ".worktree": true,
};

function crawlable(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => EXCLUDED_SEGMENTS[part] === true)) return false;
  return !relativePath.startsWith(".devboard/.tmp/") && relativePath !== ".devboard/.tmp";
}

export interface FilingProvenance {
  title: string;
  body: string;
  labels: readonly string[];
}

export interface FilingOptions {
  /** Every glossary the repository publishes, read once per forge read. */
  glossaries?: readonly Glossary[];
  /** The per-read occurrence cache, so one term is searched once. */
  occurrences?: OccurrenceCache;
}

export type ProvenanceResult =
  | { ok: true; category: ConsistentNamingCategory }
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

/** One value section: exactly one non-empty line, without a list marker. */
function singleLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return undefined;
  return lines[0];
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

interface LocationEntry {
  path: string;
  lines: string;
  quote: string;
}

/** Every `- \`path:lines\`` entry in one section, in body order. */
function locationEntries(content: string, quoteRequired: boolean): LocationEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: LocationEntry[] = [];
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
    if (quoteRequired && quote.length === 0) continue;
    entries.push({ path: (location[1] ?? "").trim(), lines: location[2] ?? "", quote });
  }
  return entries;
}

/** Resolves one repository-relative path to a readable regular file inside the root. */
function regularFile(
  repoDir: string,
  path: string,
  noun: string,
): { absolute: string } | { detail: string } {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.length === 0 || isAbsolute(normalized) || normalized.startsWith("../")) {
    return { detail: `${noun} path ${path} is not repository-relative` };
  }
  if (!crawlable(normalized)) return { detail: `${noun} path ${normalized} is outside the repository` };
  const root = resolve(repoDir);
  const absolute = resolve(root, normalized);
  if (!inside(root, absolute)) return { detail: `${noun} path ${normalized} leaves the repository` };
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return { detail: `${noun} path ${normalized} does not exist` };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { detail: `${noun} path ${normalized} is not a regular file` };
  }
  return { absolute };
}

function proveEvidence(repoDir: string, entry: LocationEntry): string | undefined {
  const resolved = regularFile(repoDir, entry.path, "evidence");
  if ("detail" in resolved) return resolved.detail;
  const path = entry.path.replace(/\\/g, "/");
  const span = lineSpan(entry.lines);
  if (span === undefined) return `evidence path ${path} names no line range`;
  let text: string;
  try {
    text = readFileSync(resolved.absolute, "utf8");
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

/** Every occurrence entry, resolved to a path and span inside the repository. */
function proveOccurrences(
  repoDir: string,
  content: string,
): { listed: Map<string, Array<[number, number]>> } | { detail: string } {
  const entries = locationEntries(content, false);
  if (entries.length === 0) return { detail: "the body carries no occurrence entry" };
  const listed = new Map<string, Array<[number, number]>>();
  for (const entry of entries) {
    const resolved = regularFile(repoDir, entry.path, "occurrence");
    if ("detail" in resolved) return { detail: resolved.detail };
    const path = entry.path.replace(/\\/g, "/");
    const span = lineSpan(entry.lines);
    if (span === undefined) return { detail: `the occurrence ${path} names no line range` };
    const spans = listed.get(path) ?? [];
    spans.push(span);
    listed.set(path, spans);
  }
  return { listed };
}

/** The glossary verdict for one filing's concept and name in use. */
type GlossaryCheck =
  | { kind: "none" }
  | { kind: "ambiguous"; detail: string }
  | { kind: "conflict"; concept: GlossaryConcept };

/** Whether the term belongs to a concept other than the one the issue names. */
function glossaryConflict(
  glossaries: readonly Glossary[],
  concept: string,
  nameInUse: string,
): GlossaryCheck {
  const defined = conceptsDefinedAs(glossaries, concept);
  const elsewhere = conceptsUsingTerm(glossaries, nameInUse).filter(
    (candidate) => !defined.some((entry) => entry.id === candidate.id && entry.path === candidate.path),
  );
  if (elsewhere.length === 0) return { kind: "none" };
  if (elsewhere.length > 1) {
    return {
      kind: "ambiguous",
      detail:
        `the glossaries assign “${nameInUse}” to ${elsewhere.length} concepts: ` +
        elsewhere.map((entry) => `${entry.path}:${entry.id}`).join(", "),
    };
  }
  return { kind: "conflict", concept: elsewhere[0]! };
}

/**
 * Proves one read-back filing: one of the skill's seven categories, the skill
 * path, that category's directive verbatim, one concept, one name in use and
 * one proposed name, the reason, the concrete rename, binary acceptance
 * criteria, at least one verbatim evidence quote, the complete
 * repository-wide occurrence list, and the glossary authority or conflict the
 * published glossaries require.
 */
export function verifyFiling(
  repoDir: string,
  skill: SkillDirectives,
  filing: FilingProvenance,
  options: FilingOptions = {},
): ProvenanceResult {
  const labels = [...new Set(filing.labels)];
  if (labels.length !== 1 || labels[0] !== CONSISTENT_NAMING_LABEL) {
    return {
      ok: false,
      detail: `the labels are ${JSON.stringify([...filing.labels])}, not exactly ["${CONSISTENT_NAMING_LABEL}"]`,
    };
  }
  const title = filing.title.trim();
  if (title.length === 0 || /[\r\n]/.test(filing.title) || [...title].length > TITLE_MAX) {
    return {
      ok: false,
      detail: `the title is not one plain line of at most ${TITLE_MAX} characters`,
    };
  }
  if (/^\[[^\]]+\]/.test(title) || /^consistent-naming\s*:/i.test(title)) {
    return { ok: false, detail: "the title carries a prefix" };
  }
  const body = filing.body;
  const mentioned = CONSISTENT_NAMING_CATEGORIES.filter((category) => body.includes(category));
  if (mentioned.length !== 1) {
    return {
      ok: false,
      detail:
        mentioned.length === 0
          ? "the body names none of the seven categories"
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
    "Concept",
    "Name in use",
    "Proposed name",
    "Why the name is inconsistent",
    "Rename",
    "Evidence",
    "Occurrences",
    "Acceptance criteria",
  ]) {
    const content = section(body, heading);
    if (content === undefined || content.trim().length === 0) {
      return { ok: false, detail: `the body has no ${heading} section` };
    }
  }
  const concept = singleLine(section(body, "Concept"));
  if (concept === undefined) return { ok: false, detail: "the body names no single concept" };
  const nameInUse = singleLine(section(body, "Name in use"));
  if (nameInUse === undefined) return { ok: false, detail: "the body names no single name in use" };
  const proposed = singleLine(section(body, "Proposed name"));
  if (proposed === undefined) return { ok: false, detail: "the body names no single proposed name" };
  if (normalizeName(nameInUse) === normalizeName(proposed)) {
    return { ok: false, detail: "the proposed name does not differ from the name in use" };
  }
  const rename = section(body, "Rename") ?? "";
  if (!/\b(rename|replace|spell|label|identifier)\b/i.test(rename)) {
    return { ok: false, detail: "the Rename section prescribes no rename" };
  }
  const forbidden = body
    .split(/\r?\n/)
    .map((line) => /^##\s+(.+)$/.exec(line.trim())?.[1]?.trim().toLowerCase() ?? "")
    .filter((heading) => heading === "refactor" || heading === "implementation plan");
  if (forbidden.length > 0) {
    return {
      ok: false,
      detail: `the body carries a step-by-step ${forbidden[0]} section, not a vocabulary change`,
    };
  }
  const criteria = section(body, "Acceptance criteria") ?? "";
  if (!criteria.split(/\r?\n/).some((line) => /^\s*-\s+\S/.test(line))) {
    return { ok: false, detail: "the acceptance criteria carry no binary statement" };
  }
  const evidence = locationEntries(section(body, "Evidence") ?? "", true);
  if (evidence.length === 0) {
    return { ok: false, detail: "the body carries no evidence entry with a line span and quote" };
  }
  for (const entry of evidence) {
    const problem = proveEvidence(repoDir, entry);
    if (problem !== undefined) return { ok: false, detail: problem };
  }
  const occurrences = proveOccurrences(repoDir, section(body, "Occurrences") ?? "");
  if ("detail" in occurrences) return { ok: false, detail: occurrences.detail };
  let found: OccurrenceIndex;
  try {
    found = cachedOccurrences(options.occurrences ?? new Map(), repoDir, nameInUse);
  } catch (error) {
    return {
      ok: false,
      detail: `the occurrence search failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const missing = occurrencesComplete(found, occurrences.listed);
  if (missing !== undefined) return { ok: false, detail: missing };

  const glossaries = options.glossaries ?? [];
  const conflict = glossaryConflict(glossaries, concept, nameInUse);
  if (conflict.kind === "ambiguous") return { ok: false, detail: conflict.detail };
  if (conflict.kind === "conflict") {
    const label = preferredLabel(conflict.concept);
    const reported = section(body, "Glossary conflict") ?? "";
    for (const fact of [conflict.concept.path, conflict.concept.id, label]) {
      if (!reported.includes(fact)) {
        return {
          ok: false,
          detail:
            `the glossary assigns “${nameInUse}” to ${conflict.concept.id}; the body must report ` +
            `${conflict.concept.path}, ${label}, and ${conflict.concept.id} in a Glossary conflict ` +
            "section",
        };
      }
    }
    if (normalizeName(proposed) !== normalizeName(label)) {
      return {
        ok: false,
        detail: `the proposed name must be the glossary's preferred label ${label}`,
      };
    }
    return { ok: true, category };
  }
  const defined = conceptsDefinedAs(glossaries, concept);
  if (defined.length > 1) {
    return {
      ok: false,
      detail:
        `the glossaries define ${concept} as ${defined.length} concepts: ` +
        defined.map((entry) => `${entry.path}:${entry.id}`).join(", "),
    };
  }
  if (defined.length === 1) {
    const entry = defined[0]!;
    const label = preferredLabel(entry);
    const reported = section(body, "Glossary") ?? "";
    for (const fact of [entry.path, entry.id, label]) {
      if (!reported.includes(fact)) {
        return {
          ok: false,
          detail:
            `the glossaries define ${concept}; the body must name ${entry.path}, ${label}, ` +
            `and ${entry.id} in a Glossary section`,
        };
      }
    }
    if (normalizeName(proposed) !== normalizeName(label)) {
      return {
        ok: false,
        detail: `the proposed name must be the glossary's preferred label ${label}`,
      };
    }
  }
  return { ok: true, category };
}
