import type {
  Concept,
  ConceptSignificance,
  ConceptUsage,
  DiscoverTab,
  Glossary,
  GlossarySignificance,
  GlossaryUsage,
  Leaf,
  Labelled,
} from "./types";

/** Tabs that show the published sheet or glossary rather than a skill. */
export const SECTION_TABS: DiscoverTab[] = [
  { id: "overview", label: "Overview", skill: null },
  { id: "glossary", label: "Glossary", skill: null },
];

/** The five generated skills; the sidebar groups them under Skills. */
export const SKILL_TABS: DiscoverTab[] = [
  {
    id: "testing-strategy",
    label: "Testing Strategy",
    skill: "discover-testing-strategy",
  },
  {
    id: "naming-conventions",
    label: "Naming Conventions",
    skill: "discover-naming-conventions",
  },
  {
    id: "coding-conventions",
    label: "Coding Conventions",
    skill: "discover-coding-conventions",
  },
  {
    id: "architecture-boundaries",
    label: "Architecture & Boundaries",
    skill: "discover-architecture-boundaries",
  },
  { id: "glossary-skill", label: "Glossary", skill: "discover-glossary" },
];

export const TABS: DiscoverTab[] = [...SECTION_TABS, ...SKILL_TABS];

/** Leaves already shown elsewhere or too detailed for the operator's scan. */
export const HIDDEN_LEAVES: Record<string, string[]> = {
  deployment: ["pipelineSources"],
  runtime: ["versions"],
  ci: ["qualityGates"],
};

export const COMMAND_LABELS: Record<string, string> = {
  install: "Install",
  build: "Build",
  test: "Test",
  lint: "Lint",
  typecheck: "Typecheck",
  dev: "Dev / run",
  tryOut: "Try it out",
  release: "Release",
};

/** Pyramid tiers from the base (widest) to the apex (narrowest). */
export const PYRAMID_LEVELS = ["unit", "integration", "contract", "end-to-end", "other"];

export function labelText(labels: Labelled[] | undefined): string {
  if (!Array.isArray(labels)) return "";
  const match = labels.find((label) => label.language === "en") ?? labels[0];
  return match?.text ?? "";
}

export function labelTexts(labels: Labelled[] | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => label.text).filter((text) => typeof text === "string");
}

export function isLeaf(value: unknown): value is Leaf {
  return (
    typeof value === "object" &&
    value !== null &&
    "confidence" in value &&
    "evidence" in value &&
    Array.isArray((value as { evidence: unknown }).evidence)
  );
}

export function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Human elapsed time for an ISO timestamp, such as `3 minutes ago`. A future
 * timestamp (clock skew between the server and the browser) reads `just now`.
 */
export function relativeTime(value: string, now: number = Date.now()): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "";
  const elapsed = now - timestamp;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < 2 * MINUTE) return "a minute ago";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} minutes ago`;
  if (elapsed < 2 * HOUR) return "an hour ago";
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} hours ago`;
  if (elapsed < 2 * DAY) return "yesterday";
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
  if (elapsed < 60 * DAY) return "a month ago";
  if (elapsed < 365 * DAY) return `${Math.floor(elapsed / (30 * DAY))} months ago`;
  return `${Math.floor(elapsed / (365 * DAY))} years ago`;
}

export function scalarText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function objectEntries(value: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(value)
    .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "")
    .map(([key, entry]) => [
      key,
      Array.isArray(entry)
        ? entry.map((item) => scalarText(item)).join(", ")
        : typeof entry === "object" && entry !== null
          ? ""
          : scalarText(entry),
    ] as [string, string])
    .filter(([, text]) => text.length > 0);
}

/** Renders a scalar or scalar list as one display line per item. */
export function leafLines(value: unknown): string[] {
  if (value === null || value === undefined) return ["Not recorded."];
  if (typeof value === "string") return value.length === 0 ? ["Not recorded."] : [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) {
    if (value.length === 0) return ["None detected."];
    return value
      .map((item) => (typeof item === "object" && item !== null ? "" : scalarText(item)))
      .filter((line) => line.length > 0);
  }
  if (typeof value === "object") {
    const lines = objectEntries(value as Record<string, unknown>).map(
      ([key, text]) => `${humanize(key)}: ${text}`,
    );
    return lines.length === 0 ? ["Not recorded."] : lines;
  }
  return [String(value)];
}

export function recordItems(leaf: Leaf | null | undefined): Array<Record<string, unknown>> {
  if (leaf === null || leaf === undefined || !Array.isArray(leaf.value)) return [];
  return leaf.value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

export function sectionEntries(section: unknown, hidden: string[]): Array<[string, Leaf]> {
  if (typeof section !== "object" || section === null) return [];
  return Object.entries(section).filter(
    (entry): entry is [string, Leaf] => isLeaf(entry[1]) && !hidden.includes(entry[0]),
  );
}

export function sectionLeaf(section: unknown, key: string): Leaf | undefined {
  if (typeof section !== "object" || section === null) return undefined;
  const leaf = (section as Record<string, unknown>)[key];
  return isLeaf(leaf) ? leaf : undefined;
}

/** The text one unknown leaf carries. */
export function unknownText(leaf: Leaf): string {
  return typeof leaf.reason === "string" && leaf.reason.length > 0
    ? `unknown — ${leaf.reason}`
    : "unknown";
}

export interface RecordColumn {
  key: string;
  label: string;
}

/** One table column per field any record carries, in first-seen order. */
export function recordColumns(records: Array<Record<string, unknown>>): RecordColumn[] {
  const columns = new Map<string, string>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (value === null || value === undefined || value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (!columns.has(key)) columns.set(key, humanize(key));
    }
  }
  return [...columns].map(([key, label]) => ({ key, label }));
}

export function recordColumnValues(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (Array.isArray(value)) {
    return value.map((item) => scalarText(item)).filter((text) => text.length > 0);
  }
  const text = scalarText(value);
  return text.length > 0 ? [text] : [];
}

export interface PyramidTier {
  level: string;
  tests: string;
  /** The recorded command that runs this level. */
  command: string;
}

/** Pyramid tiers ordered from the base to the apex. */
export function pyramidTiers(leaf: Leaf | null | undefined): PyramidTier[] {
  return recordItems(leaf)
    .map((record) => ({
      level: scalarText(record.level) || "other",
      tests: scalarText(record.tests) || "unknown",
      command: scalarText(record.command),
    }))
    .sort(
      (left, right) =>
        (PYRAMID_LEVELS.indexOf(left.level) + 1 || PYRAMID_LEVELS.length) -
        (PYRAMID_LEVELS.indexOf(right.level) + 1 || PYRAMID_LEVELS.length),
    );
}

/** Tiers that actually carry tests; a recorded level with zero tests is not implemented. */
export function implementedTiers(tiers: PyramidTier[]): PyramidTier[] {
  return tiers.filter((tier) => (Number.parseInt(tier.tests, 10) || 0) > 0);
}

export interface CommandAlias {
  command: string;
  alias: string;
}

/** The installed invocation for a recorded command, when the manifest declares one. */
export function commandAlias(
  aliases: readonly CommandAlias[] | undefined,
  command: string,
): string {
  if (aliases === undefined) return command;
  const target = command.replace(/\s+/g, " ").trim();
  return aliases.find((entry) => entry.command === target)?.alias ?? command;
}

/** A bounded context's display name; never its raw identifier when a title exists. */
export function contextTitle(glossary: Glossary): string {
  return labelText(glossary.titles) || humanize(glossary.boundedContext);
}

/** Sum of the numeric test counts a pyramid declares, or null when none is known. */
export function pyramidTestCount(tiers: PyramidTier[]): number | null {
  let total = 0;
  let known = false;
  for (const tier of tiers) {
    const count = Number.parseInt(tier.tests, 10);
    if (!Number.isFinite(count)) continue;
    known = true;
    total += count;
  }
  return known ? total : null;
}

/** Usage for one concept; zeroes when the server has not measured it. */
export function conceptUsage(
  usage: GlossaryUsage | undefined,
  context: string,
  id: string,
): ConceptUsage {
  return usage?.[context]?.[id] ?? { count: 0, files: 0, examples: [] };
}

/** The score at or above which the page calls a concept significant. */
export const SIGNIFICANCE_FLOOR = 50;

/** The crawl's judgment for one concept, or undefined when it is unscored. */
export function conceptSignificance(
  significance: GlossarySignificance | undefined,
  context: string,
  id: string,
): ConceptSignificance | undefined {
  return significance?.[context]?.[id];
}

/** True when at least one listed concept carries a crawl-authored score. */
export function glossaryHasSignificance(
  glossaries: Glossary[],
  significance: GlossarySignificance | undefined,
): boolean {
  return glossaries.some((context) =>
    (Array.isArray(context.concepts) ? context.concepts : []).some(
      (concept) =>
        concept.status !== "invalidated" &&
        conceptSignificance(significance, context.boundedContext, concept.id) !== undefined,
    ),
  );
}

export interface GlossaryFilter {
  search: string;
  /** Hide a scored concept below the floor; ignored while nothing is scored. */
  significantOnly: boolean;
  floor: number;
  significance?: GlossarySignificance;
}

function matchesSearch(concept: Concept, needle: string): boolean {
  if (needle.length === 0) return true;
  const haystack = [
    concept.id,
    labelText(concept.prefLabels),
    ...labelTexts(concept.altLabels),
    ...labelTexts(concept.definitions),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Terms matching the search and the significance floor, ordered by the crawl's
 * score with unscored terms last. Usage never decides inclusion or order.
 */
export function filterContexts(glossaries: Glossary[], filter: GlossaryFilter): Glossary[] {
  const needle = filter.search.trim().toLowerCase();
  const floorActive =
    filter.significantOnly && glossaryHasSignificance(glossaries, filter.significance);
  return glossaries
    .map((context) => ({
      ...context,
      concepts: (Array.isArray(context.concepts) ? context.concepts : [])
        .filter((concept) => concept.status !== "invalidated")
        .filter((concept) => matchesSearch(concept, needle))
        .filter((concept) => {
          if (!floorActive) return true;
          const entry = conceptSignificance(filter.significance, context.boundedContext, concept.id);
          return entry === undefined || entry.score >= filter.floor;
        })
        .sort((left, right) => {
          const leftScore = conceptSignificance(
            filter.significance,
            context.boundedContext,
            left.id,
          )?.score;
          const rightScore = conceptSignificance(
            filter.significance,
            context.boundedContext,
            right.id,
          )?.score;
          if (leftScore !== rightScore) {
            if (leftScore === undefined) return 1;
            if (rightScore === undefined) return -1;
            return rightScore - leftScore;
          }
          return conceptTitle(left).localeCompare(conceptTitle(right));
        }),
    }))
    .filter((context) => context.concepts.length > 0);
}

export function conceptTitle(concept: Concept): string {
  return labelText(concept.prefLabels) || concept.id;
}
