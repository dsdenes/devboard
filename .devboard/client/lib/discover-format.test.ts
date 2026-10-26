import { describe, expect, test } from "bun:test";
import { conceptUsage, filterContexts, glossaryMaxUses } from "./discover-format";
import type { Concept, Glossary, GlossaryUsage } from "./types";

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
    concept("stale-term", "invalidated", "Stale Term"),
  ],
};

const usage: GlossaryUsage = {
  orders: {
    "page-action": { count: 9, files: 3, examples: ["PageAction", "getPageActions"] },
    "order-total": { count: 4, files: 2, examples: ["orderTotal"] },
    option: { count: 1, files: 1, examples: ["option"] },
    "stale-term": { count: 20, files: 4, examples: ["staleTerm"] },
  },
};

describe("glossary significance", () => {
  test("hides terms below the threshold and never lists an invalidated term", () => {
    const contexts = filterContexts([glossary], "", 2, usage);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.concepts.map((entry) => entry.id)).toEqual([
      "page-action",
      "order-total",
    ]);

    const stricter = filterContexts([glossary], "", 5, usage);
    expect(stricter[0]?.concepts.map((entry) => entry.id)).toEqual(["page-action"]);

    expect(filterContexts([glossary], "", 100, usage)).toEqual([]);
  });

  test("composes the threshold with the search", () => {
    const contexts = filterContexts([glossary], "total", 2, usage);
    expect(contexts[0]?.concepts.map((entry) => entry.id)).toEqual(["order-total"]);
  });

  test("reports the measured usage and a slider range", () => {
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
    expect(glossaryMaxUses([glossary], usage)).toBe(9);
    expect(glossaryMaxUses([glossary], {})).toBe(2);
  });
});
