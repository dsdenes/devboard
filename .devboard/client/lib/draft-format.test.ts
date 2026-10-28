import { describe, expect, test } from "bun:test";
import { draftParts, parseDraftContext, splitDraftText } from "./draft-format";

const DRAFT = `# Proposed goal: persist remote discoveries

Persist every remote project and offer a switcher.

## Captured UI context

- Route: \`/\`
- URL: \`http://127.0.0.1:8081/\`
- Selected element: \`section.panel:nth-of-type(2)\`
- Viewport: \`2101x1017 @1.21875x\`
- Captured at: \`2026-10-28T10:30:03.635Z\`

### Visible text

The remote clone is missing.

### DOM excerpt

\`\`\`html
<section class="panel"></section>
\`\`\`
`;

describe("draft parts", () => {
  test("splits the proposal from the captured context", () => {
    const parts = draftParts(DRAFT);
    expect(parts.proposal).toBe("Persist every remote project and offer a switcher.");
    expect(parts.proposal).not.toContain("Proposed goal:");
    expect(parts.proposal).not.toContain("Captured UI context");
    expect(parts.rawContext).toStartWith("- Route:");
    expect(parts.facts).toEqual([
      { label: "Route", value: "/" },
      { label: "URL", value: "http://127.0.0.1:8081/" },
      { label: "Selected element", value: "section.panel:nth-of-type(2)" },
      { label: "Viewport", value: "2101x1017 @1.21875x" },
      { label: "Captured at", value: "2026-10-28T10:30:03.635Z" },
    ]);
    expect(parts.sections).toEqual([
      { title: "Visible text", body: "The remote clone is missing." },
      { title: "DOM excerpt", body: '<section class="panel"></section>' },
    ]);
  });

  test("keeps a draft without the marker whole and gives it no context", () => {
    expect(splitDraftText("# Question draft\n\nAsk about the scope.\n")).toEqual({
      proposal: "Ask about the scope.",
      rawContext: "",
    });
  });

  test("leaves a captured message without facts or headings as raw context", () => {
    const parts = draftParts(
      "# Draft\n\n## Captured UI context\n\nNo page context was captured.\n",
    );
    expect(parts.facts).toEqual([]);
    expect(parts.sections).toEqual([]);
    expect(parts.rawContext).toBe("No page context was captured.");
  });
});

describe("captured context", () => {
  test("keeps an embedded capture's headings inside the visible text", () => {
    const context = `- Route: \`/\`

### Visible text

Outer text.

### Visible text

Inner text.

### DOM excerpt

\`\`\`html
<p>inner</p>
\`\`\`

### DOM excerpt

\`\`\`html
<div>outer</div>
\`\`\`
`;
    const parsed = parseDraftContext(context);
    expect(parsed.facts).toEqual([{ label: "Route", value: "/" }]);
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]?.title).toBe("Visible text");
    expect(parsed.sections[0]?.body).toContain("Outer text.");
    expect(parsed.sections[0]?.body).toContain("Inner text.");
    expect(parsed.sections[0]?.body).toContain("### DOM excerpt");
    expect(parsed.sections[1]?.title).toBe("DOM excerpt");
    expect(parsed.sections[1]?.body).toBe("<div>outer</div>");
  });

  test("reads a DOM excerpt without visible text", () => {
    const parsed = parseDraftContext("### DOM excerpt\n\n```html\n<p>only</p>\n```\n");
    expect(parsed.facts).toEqual([]);
    expect(parsed.sections).toEqual([{ title: "DOM excerpt", body: "<p>only</p>" }]);
  });

  test("reads an empty context", () => {
    expect(parseDraftContext("")).toEqual({ facts: [], sections: [] });
  });
});
