import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { isInteger } from "../guards";
import {
  CATEGORIES,
  EXCLUDED_ROOTS,
  SIGNIFICANCE_MAX,
  SIGNIFICANCE_MIN,
  type ScoutCategory,
} from "./paths";

/**
 * The scan contract's answer: every recommendation the agent produced, checked
 * against the repository before anything is filed. Validation is atomic — one
 * malformed item rejects the whole answer, so a partial or invented result can
 * never become an issue.
 */

export const TITLE_MAX = 200;
const ID_LENGTH = 16;
const MAX_SUMMARY = 4000;
const MAX_QUOTE = 2000;
const MAX_SIGNIFICANCE_REASON = 2000;

export interface ScoutEvidence {
  /** Repository-relative path, `/` separators. */
  path: string;
  /** `N` or `N-M`, inside the file's line count. */
  lines: string;
  quote?: string;
}

export interface ScoutRecommendation {
  /** First 16 hex characters of the finding's identity hash. */
  id: string;
  category: ScoutCategory;
  title: string;
  summary: string;
  impact: string;
  evidence: ScoutEvidence[];
  proposedChange: string;
  files: string[];
  acceptanceCriteria: string[];
  /** 1–5; only a 4 or a 5 earns an issue. */
  significance: number;
  significanceReason: string;
}

export type ScanResult =
  | { ok: true; items: ScoutRecommendation[]; shortfall: string | null }
  | { ok: false; error: string };

export function isCategory(value: unknown): value is ScoutCategory {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/** Lowercase, whitespace-collapsed, trimmed: the one title identity everywhere. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The `## Category` line of an issue body, for an issue Auto Scout adopted
 * rather than filed. A missing heading or a blank value yields null.
 */
export function categoryFromBody(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim().toLowerCase() === "## category");
  if (heading < 0) return null;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const value = lines[index]!.trim();
    if (value.length === 0) continue;
    if (value.startsWith("#")) return null;
    return value.length <= 40 ? value : null;
  }
  return null;
}

/**
 * The same finding produced twice keeps its id: the hash covers the category,
 * the sorted evidence paths, and the normalized title, and nothing that a new
 * scan may legitimately change, such as the summary or the significance score.
 */
export function recommendationId(
  category: ScoutCategory,
  evidencePaths: string[],
  title: string,
): string {
  const paths = [...new Set(evidencePaths)].sort().join("\n");
  return createHash("sha256")
    .update([category, paths, normalizeTitle(title)].join("\u0000"))
    .digest("hex")
    .slice(0, ID_LENGTH);
}

/** Normalizes a repository-relative path for display and comparison. */
export function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function excluded(relativePath: string): boolean {
  const segments = relativePath.split("/");
  for (const root of EXCLUDED_ROOTS) {
    const parts = root.split("/");
    if (parts.length === 1) {
      if (segments.includes(root)) return true;
      continue;
    }
    for (let index = 0; index + parts.length <= segments.length; index += 1) {
      let matched = true;
      for (const [offset, part] of parts.entries()) {
        if (segments[index + offset] !== part) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }
  return false;
}

export interface EvidenceCheck {
  ok: boolean;
  /** Repository-relative path when the check passed. */
  path: string;
  detail?: string;
}

const LINE_SPAN = /^(\d+)(?:-(\d+))?$/;

/**
 * Resolves one cited path inside the repository and checks the cited lines
 * against the file's real length. A path escape, a missing or non-file target,
 * an excluded tree, and an out-of-range span are all refusals.
 */
export function checkEvidencePath(repoDir: string, rawPath: string, lines: string): EvidenceCheck {
  const path = normalizePath(rawPath);
  if (path.length === 0) return { ok: false, path, detail: "the evidence path is empty" };
  if (path.includes("\u0000")) return { ok: false, path, detail: "the evidence path is malformed" };
  if (isAbsolute(path)) return { ok: false, path, detail: `${path} is absolute` };
  const segments = path.split("/");
  if (segments.includes("..")) return { ok: false, path, detail: `${path} escapes the repository` };
  if (excluded(path)) {
    return { ok: false, path, detail: `${path} is inside an excluded tree` };
  }

  let root: string;
  try {
    root = realpathSync(repoDir);
  } catch {
    return { ok: false, path, detail: `${repoDir} is not readable` };
  }
  // Both sides of the containment check use the canonical root: a repository
  // reached through a symlink would otherwise reject every cited path.
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    return { ok: false, path, detail: `${path} escapes the repository` };
  }

  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    return { ok: false, path, detail: `${path} does not exist` };
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    return { ok: false, path, detail: `${path} escapes the repository` };
  }
  let stats;
  try {
    stats = lstatSync(real);
  } catch {
    return { ok: false, path, detail: `${path} does not exist` };
  }
  if (!stats.isFile()) return { ok: false, path, detail: `${path} is not a regular file` };

  const span = LINE_SPAN.exec(lines.trim());
  if (span === null) {
    return { ok: false, path, detail: `${path}:${lines} is not a line span` };
  }
  const first = Number(span[1]);
  const last = span[2] === undefined ? first : Number(span[2]);
  let count: number;
  try {
    const text = readFileSync(real, "utf8");
    count = text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
  } catch {
    return { ok: false, path, detail: `${path} is not readable` };
  }
  if (first < 1 || last < first || last > count) {
    return {
      ok: false,
      path,
      detail: `${path}:${lines} is outside the file's ${count} line(s)`,
    };
  }
  return { ok: true, path };
}

function boundedText(
  value: unknown,
  field: string,
  limit: number,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: `${label} has no ${field}` };
  const text = value.trim();
  if (text.length === 0) return { ok: false, error: `${label} has an empty ${field}` };
  if (text.length > limit) {
    return { ok: false, error: `${label} has a ${field} longer than ${limit} characters` };
  }
  return { ok: true, value: text };
}

function stringList(
  value: unknown,
  field: string,
  label: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: `${label} has no ${field}` };
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return { ok: false, error: `${label} has a blank ${field} entry` };
    }
    items.push(entry.trim());
  }
  return { ok: true, value: items };
}

function validateItem(
  value: unknown,
  index: number,
  repoDir: string,
): { ok: true; item: ScoutRecommendation } | { ok: false; error: string } {
  const fallback = `item ${index + 1}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `${fallback} is not an object` };
  }
  const source = value as Record<string, unknown>;
  const rawTitle = source.title;
  const label =
    typeof rawTitle === "string" && rawTitle.trim().length > 0
      ? `item ${index + 1} ("${rawTitle.trim().slice(0, TITLE_MAX)}")`
      : fallback;

  if (!isCategory(source.category)) {
    return { ok: false, error: `${label} has no valid category` };
  }
  const category = source.category;

  const title = boundedText(rawTitle, "title", TITLE_MAX, label);
  if (!title.ok) return title;
  if (/[\r\n]/.test(rawTitle as string)) {
    return { ok: false, error: `${label} has a title that spans more than one line` };
  }

  const summary = boundedText(source.summary, "summary", MAX_SUMMARY, label);
  if (!summary.ok) return summary;
  const proposedChange = boundedText(source.proposedChange, "proposed change", MAX_SUMMARY, label);
  if (!proposedChange.ok) return proposedChange;

  let impact = "";
  if (source.impact !== undefined) {
    const checked = boundedText(source.impact, "impact", MAX_SUMMARY, label);
    if (!checked.ok) return checked;
    impact = checked.value;
  }

  const significance = source.significance;
  if (
    !isInteger(significance) ||
    significance < SIGNIFICANCE_MIN ||
    significance > SIGNIFICANCE_MAX
  ) {
    return {
      ok: false,
      error: `${label} has no significance score from ${SIGNIFICANCE_MIN} to ${SIGNIFICANCE_MAX}`,
    };
  }
  const reason = boundedText(
    source.significanceReason,
    "significance reason",
    MAX_SIGNIFICANCE_REASON,
    label,
  );
  if (!reason.ok) return reason;

  if (!Array.isArray(source.evidence) || source.evidence.length === 0) {
    return { ok: false, error: `${label} cites no evidence` };
  }
  const evidence: ScoutEvidence[] = [];
  for (const [position, entry] of source.evidence.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `${label} evidence ${position + 1} is not an object` };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string") {
      return { ok: false, error: `${label} evidence ${position + 1} has no path` };
    }
    if (typeof record.lines !== "string") {
      return { ok: false, error: `${label} evidence ${position + 1} has no line span` };
    }
    if (record.quote !== undefined && typeof record.quote !== "string") {
      return { ok: false, error: `${label} evidence ${position + 1} has a non-text quote` };
    }
    const check = checkEvidencePath(repoDir, record.path, record.lines);
    if (!check.ok) return { ok: false, error: `${label} evidence: ${check.detail}` };
    const quote =
      typeof record.quote === "string" && record.quote.trim().length > 0
        ? record.quote.trim().slice(0, MAX_QUOTE)
        : undefined;
    evidence.push({
      path: check.path,
      lines: record.lines.trim(),
      ...(quote === undefined ? {} : { quote }),
    });
  }

  const files = stringList(source.files, "file list", label);
  if (!files.ok) return files;
  const cited = new Set(evidence.map((entry) => entry.path));
  const normalizedFiles = files.value.map(normalizePath);
  for (const file of normalizedFiles) {
    if (!cited.has(file)) {
      return { ok: false, error: `${label} lists ${file}, which its evidence does not cite` };
    }
  }

  const criteria = stringList(source.acceptanceCriteria, "acceptance criteria", label);
  if (!criteria.ok) return criteria;

  return {
    ok: true,
    item: {
      id: recommendationId(category, evidence.map((entry) => entry.path), title.value),
      category,
      title: title.value,
      summary: summary.value,
      impact,
      evidence,
      proposedChange: proposedChange.value,
      files: [...new Set(normalizedFiles)],
      acceptanceCriteria: criteria.value,
      significance,
      significanceReason: reason.value,
    },
  };
}

/**
 * Parses `<scan-dir>/recommendations.json`. A result may carry at most the
 * count the request asked for; anything else fails the whole scan.
 */
export function parseScanResult(
  value: unknown,
  options: { requested: number; repoDir: string },
): ScanResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "the result is not a JSON object" };
  }
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.recommendations)) {
    return { ok: false, error: "the result has no recommendations array" };
  }
  if (source.recommendations.length > options.requested) {
    return {
      ok: false,
      error:
        `the result carried ${source.recommendations.length} recommendations, ` +
        `more than the ${options.requested} requested`,
    };
  }

  const items: ScoutRecommendation[] = [];
  const ids = new Map<string, number>();
  for (const [index, entry] of source.recommendations.entries()) {
    const checked = validateItem(entry, index, options.repoDir);
    if (!checked.ok) return { ok: false, error: checked.error };
    const seen = ids.get(checked.item.id);
    if (seen !== undefined) {
      return {
        ok: false,
        error:
          `item ${index + 1} ("${checked.item.title}") repeats the id of item ${seen + 1}: ` +
          checked.item.id,
      };
    }
    ids.set(checked.item.id, index);
    items.push(checked.item);
  }

  const shortfall =
    typeof source.shortfall === "string" && source.shortfall.trim().length > 0
      ? source.shortfall.trim()
      : null;
  return { ok: true, items, shortfall };
}
