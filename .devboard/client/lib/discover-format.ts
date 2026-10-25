import type { Concept, Confidence, DiscoverTab, Glossary, Leaf, Labelled } from "./types";

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

export const SECTION_KEYS = [
  "definition",
  "stack",
  "deployment",
  "environments",
  "commands",
  "branching",
  "testing",
  "architecture",
  "ci",
  "runtime",
  "dependencyMap",
  "delivery",
];

export const SECTION_LABELS: Record<string, string> = {
  definition: "Project definition",
  stack: "Stack",
  deployment: "Customer-facing deployment",
  environments: "Environments",
  commands: "Main commands",
  branching: "Branching strategy",
  testing: "Testing strategy",
  architecture: "Architecture & boundaries",
  ci: "CI strategy",
  runtime: "Runtime inventory",
  dependencyMap: "Entry points & dependency map",
  delivery: "Delivery & versioning",
};

/** The delivery card repeats facts shown by deployment, CI, and runtime. */
export const HIDDEN_SECTIONS = new Set(["delivery"]);

/** The runtime inventory is the first thing an operator scans for. */
export const SECTION_ORDER = [
  "runtime",
  ...SECTION_KEYS.filter((key) => key !== "runtime" && !HIDDEN_SECTIONS.has(key)),
];

/** Leaves already shown elsewhere or too detailed for the operator's scan. */
export const HIDDEN_LEAVES: Record<string, string[]> = {
  dependencyMap: ["binaries", "packages", "jobs"],
  deployment: ["pipelineSources"],
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

export const COMMAND_HINTS: Record<string, string> = {
  test: "Runs the whole test suite.",
  tryOut: "Starts the project for a hands-on try; it is not the test suite.",
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

/** Every leaf below a section, minus the leaves a surface intentionally hides. */
export function sectionLeaves(section: unknown, hidden: string[] = []): Leaf[] {
  if (isLeaf(section)) return [section];
  if (typeof section !== "object" || section === null || Array.isArray(section)) return [];
  return Object.entries(section)
    .filter(([key]) => !hidden.includes(key))
    .flatMap(([, entry]) => sectionLeaves(entry, hidden));
}

export interface SectionProvenance {
  counts: Record<Confidence, number>;
  evidence: string[];
}

/** Confidence tally and de-duplicated evidence for one section, used as its provenance line. */
export function sectionProvenance(section: unknown, hidden: string[] = []): SectionProvenance {
  const counts: Record<Confidence, number> = {
    observed: 0,
    declared: 0,
    inferred: 0,
    unknown: 0,
  };
  const evidence = new Set<string>();
  for (const leaf of sectionLeaves(section, hidden)) {
    // Unknown leaves are listed in the unknowns ledger, not in a section's provenance line.
    if (leaf.confidence === "unknown") continue;
    counts[leaf.confidence] += 1;
    for (const path of leaf.evidence) {
      if (typeof path === "string" && path.length > 0) evidence.add(path);
    }
  }
  return { counts, evidence: [...evidence].sort() };
}

/** Unknown leaves below a section, with the field key that carries each reason. */
export function sectionUnknowns(
  section: unknown,
  hidden: string[] = [],
): Array<[string, Leaf]> {
  if (typeof section !== "object" || section === null || Array.isArray(section)) return [];
  return Object.entries(section)
    .filter(([key]) => !hidden.includes(key))
    .flatMap(([key, entry]) => {
      if (isLeaf(entry)) {
        return entry.confidence === "unknown" ? [[key, entry] as [string, Leaf]] : [];
      }
      return sectionUnknowns(entry, hidden);
    });
}

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
  command: string;
  detail: string;
}

/** Pyramid tiers ordered from the base to the apex. */
export function pyramidTiers(leaf: Leaf | null | undefined): PyramidTier[] {
  return recordItems(leaf)
    .map((record) => {
      const paths = Array.isArray(record.paths)
        ? record.paths.map((item) => scalarText(item)).filter(Boolean)
        : [];
      const fixtures = Array.isArray(record.fixtures)
        ? record.fixtures.map((item) => scalarText(item)).filter(Boolean)
        : [];
      return {
        level: scalarText(record.level) || "other",
        tests: scalarText(record.tests) || "unknown",
        command: scalarText(record.command),
        detail: [...paths, ...fixtures].join(" · "),
      };
    })
    .sort(
      (left, right) =>
        (PYRAMID_LEVELS.indexOf(left.level) + 1 || PYRAMID_LEVELS.length) -
        (PYRAMID_LEVELS.indexOf(right.level) + 1 || PYRAMID_LEVELS.length),
    );
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

export function filterContexts(glossaries: Glossary[], query: string): Glossary[] {
  const needle = query.trim().toLowerCase();
  return glossaries
    .map((context) => ({
      ...context,
      concepts: (Array.isArray(context.concepts) ? context.concepts : []).filter((concept) => {
        if (concept.status === "invalidated") return false;
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
      }),
    }))
    .filter((context) => context.concepts.length > 0);
}

export function conceptTitle(concept: Concept): string {
  return labelText(concept.prefLabels) || concept.id;
}
