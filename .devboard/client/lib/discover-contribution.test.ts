import { describe, expect, test } from "bun:test";
import { SECTION_TABS, SKILL_TABS, TABS } from "./discover-format";

describe("discover contribution tabs", () => {
  test("places the contribution page directly after the glossary", () => {
    expect(SECTION_TABS.map((tab) => tab.id)).toEqual(["overview", "glossary", "contribution"]);
    expect(SECTION_TABS[2]).toEqual({
      id: "contribution",
      label: "Contribution",
      skill: null,
    });
  });

  test("places the contribution skill directly after the glossary skill", () => {
    expect(SKILL_TABS.map((tab) => tab.id)).toEqual([
      "testing-strategy",
      "naming-conventions",
      "coding-conventions",
      "architecture-boundaries",
      "glossary-skill",
      "contribution-skill",
    ]);
    expect(SKILL_TABS[5]).toEqual({
      id: "contribution-skill",
      label: "Contribution",
      skill: "discover-contribution",
    });
  });

  test("keeps the combined tab list in sidebar order", () => {
    expect(TABS.map((tab) => tab.id)).toEqual([
      "overview",
      "glossary",
      "contribution",
      "testing-strategy",
      "naming-conventions",
      "coding-conventions",
      "architecture-boundaries",
      "glossary-skill",
      "contribution-skill",
    ]);
  });
});
