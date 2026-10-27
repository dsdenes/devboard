import { describe, expect, test } from "bun:test";
import {
  conceptSignificance,
  conceptUsage,
  filterContexts,
  glossaryHasSignificance,
  implementedTiers,
  pyramidTiers,
  relativeTime,
  SIGNIFICANCE_FLOOR,
} from "./discover-format";
import type { Concept, Glossary, GlossarySignificance, GlossaryUsage, Leaf } from "./types";

function concept(id: string, status: string, label: string): Concept {
  return {
    id,
    prefLabels: [{ language: "en", text: label }],
    altLabels: [],
    definitions: [{ language: "en", text: `${label} definition.` }],
    status,
    origin: "owner",
    kind: "entity",
    grounding: [],
  };
}

const glossary: Glossary = {
  boundedContext: "orders",
  titles: [{ language: "en", text: "Orders" }],
  concepts: [
    concept("page-action", "confirmed", "Page Action"),
    concept("order-total", "confirmed", "Order Total"),
    concept("option", "confirmed", "Option"),
    concept("unscored-term", "confirmed", "Unscored Term"),
    concept("stale-term", "invalidated", "Stale Term"),
  ],
};

/** Deliberately inverted: the generic term is used most and scores lowest. */
const usage: GlossaryUsage = {
  orders: {
    "page-action": { count: 9, files: 3, examples: ["PageAction", "getPageActions"] },
    "order-total": { count: 1, files: 1, examples: ["orderTotal"] },
    option: { count: 999, files: 40, examples: ["option"] },
    "unscored-term": { count: 3, files: 1, examples: ["unscoredTerm"] },
    "stale-term": { count: 20, files: 4, examples: ["staleTerm"] },
  },
};

const significance: GlossarySignificance = {
  orders: {
    "order-total": { score: 90, reason: "The order total is the domain's central value." },
    "page-action": { score: 60, reason: "Page actions drive the order workflow." },
    option: { score: 10, reason: "A framework option token, not a domain term." },
  },
};

const ids = (contexts: Glossary[]) =>
  contexts.flatMap((context) => context.concepts.map((entry) => entry.id));

describe("glossary significance", () => {
  test("lists a high-score term with one use ahead of a low-score term with 999 uses", () => {
    expect(conceptUsage(usage, "orders", "option").count).toBe(999);
    expect(conceptUsage(usage, "orders", "order-total").count).toBe(1);

    const contexts = filterContexts([glossary], {
      search: "",
      significantOnly: true,
      floor: SIGNIFICANCE_FLOOR,
      significance,
    });
    expect(ids(contexts)).toEqual(["order-total", "page-action", "unscored-term"]);
  });

  test("reveals the low-score term when the significant-only filter is cleared", () => {
    const contexts = filterContexts([glossary], {
      search: "",
      significantOnly: false,
      floor: SIGNIFICANCE_FLOOR,
      significance,
    });
    expect(ids(contexts)).toEqual([
      "order-total",
      "page-action",
      "option",
      "unscored-term",
    ]);
    expect(ids(filterContexts([glossary], { search: "", significantOnly: true, floor: 0, significance })))
      .toEqual(["order-total", "page-action", "option", "unscored-term"]);
  });

  test("never lists an invalidated term and breaks a tie by the displayed term label", () => {
    const tied: GlossarySignificance = {
      orders: {
        "page-action": { score: 70, reason: "One evidence line." },
        "order-total": { score: 70, reason: "One evidence line." },
      },
    };
    const contexts = filterContexts([glossary], {
      search: "",
      significantOnly: true,
      floor: SIGNIFICANCE_FLOOR,
      significance: tied,
    });
    expect(ids(contexts)).toEqual(["order-total", "page-action", "option", "unscored-term"]);
    expect(ids(contexts)).not.toContain("stale-term");
  });

  test("composes the floor with the search", () => {
    expect(
      ids(
        filterContexts([glossary], {
          search: "total",
          significantOnly: true,
          floor: SIGNIFICANCE_FLOOR,
          significance,
        }),
      ),
    ).toEqual(["order-total"]);
    expect(
      filterContexts([glossary], {
        search: "option",
        significantOnly: true,
        floor: SIGNIFICANCE_FLOOR,
        significance,
      }),
    ).toEqual([]);
    expect(
      ids(
        filterContexts([glossary], {
          search: "option",
          significantOnly: false,
          floor: SIGNIFICANCE_FLOOR,
          significance,
        }),
      ),
    ).toEqual(["option"]);
  });

  test("hides nothing when no concept is scored", () => {
    expect(glossaryHasSignificance([glossary], significance)).toBe(true);
    expect(glossaryHasSignificance([glossary], {})).toBe(false);

    const contexts = filterContexts([glossary], {
      search: "",
      significantOnly: true,
      floor: SIGNIFICANCE_FLOOR,
      significance: {},
    });
    expect(ids(contexts)).toEqual([
      "option",
      "order-total",
      "page-action",
      "unscored-term",
    ]);
    for (const context of contexts) {
      for (const entry of context.concepts) {
        expect(conceptSignificance({}, context.boundedContext, entry.id)).toBeUndefined();
      }
    }
  });

  test("reports the measured usage the term page keeps", () => {
    expect(conceptUsage(usage, "orders", "page-action")).toEqual({
      count: 9,
      files: 3,
      examples: ["PageAction", "getPageActions"],
    });
    expect(conceptUsage(usage, "orders", "missing")).toEqual({
      count: 0,
      files: 0,
      examples: [],
    });
  });
});

describe("test levels", () => {
  const levels: Leaf = {
    value: [
      { level: "contract", tests: "0", command: "npm run test:contract" },
      { level: "unit", tests: "118", command: "node --test" },
      { level: "integration", tests: "4", command: "node --test" },
    ],
    evidence: ["package.json"],
    confidence: "observed",
  };

  test("lists a level only when it carries a test", () => {
    expect(pyramidTiers(levels).map((tier) => tier.level)).toEqual([
      "unit",
      "integration",
      "contract",
    ]);
    expect(implementedTiers(pyramidTiers(levels)).map((tier) => tier.level)).toEqual([
      "unit",
      "integration",
    ]);
  });

  test("keeps an unparsable count out of the implemented levels", () => {
    const unknown: Leaf = {
      value: [{ level: "unit", tests: "unknown" }],
      evidence: ["package.json"],
      confidence: "observed",
    };
    expect(implementedTiers(pyramidTiers(unknown))).toEqual([]);
  });
});

describe("relative time", () => {
  const started = "2026-10-27T10:00:00.000Z";
  const at = Date.parse(started);

  test("reads a recent start as just now", () => {
    expect(relativeTime(started, at + 5_000)).toBe("just now");
    expect(relativeTime(started, at - 30_000)).toBe("just now");
  });

  test("names the elapsed minutes, hours, and days", () => {
    expect(relativeTime(started, at + 60_000)).toBe("a minute ago");
    expect(relativeTime(started, at + 5 * 60_000)).toBe("5 minutes ago");
    expect(relativeTime(started, at + 3 * 3_600_000)).toBe("3 hours ago");
    expect(relativeTime(started, at + 30 * 3_600_000)).toBe("yesterday");
    expect(relativeTime(started, at + 5 * 86_400_000)).toBe("5 days ago");
  });

  test("returns nothing for a timestamp it cannot read", () => {
    expect(relativeTime("", at)).toBe("");
    expect(relativeTime("not a date", at)).toBe("");
  });
});
