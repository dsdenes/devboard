import { describe, expect, test } from "bun:test";
import { draftProposal } from "./draft-format";

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

describe("draft proposal", () => {
  test("drops the captured context and the heading the panel shows", () => {
    const proposal = draftProposal(DRAFT);
    expect(proposal).toBe("Persist every remote project and offer a switcher.");
    expect(proposal).not.toContain("Proposed goal:");
    expect(proposal).not.toContain("Captured UI context");
    expect(proposal).not.toContain("Route:");
    expect(proposal).not.toContain("Unprocessed draft");
  });

  test("keeps a draft without the marker whole", () => {
    expect(draftProposal("# Question draft\n\nAsk about the scope.\n")).toBe("Ask about the scope.");
  });

  test("returns nothing for a draft that is only captured context", () => {
    expect(draftProposal("# Draft\n\n## Captured UI context\n\nNo page context was captured.\n")).toBe("");
  });

  test("drops a section that opens with the visible-text evidence heading", () => {
    expect(
      draftProposal(
        "# Proposed goal: x\n\nReport.\n\n## Captured UI context\n\n### Visible text\n\nHello.\n",
      ),
    ).toBe("Report.");
  });

  test("drops a section that opens with the DOM-excerpt evidence heading", () => {
    expect(
      draftProposal(
        "# Proposed goal: x\n\nReport.\n\n## Captured UI context\n\n### DOM excerpt\n\n```html\n<main></main>\n```\n",
      ),
    ).toBe("Report.");
  });

  test("keeps a report that quotes an evidence-heading section", () => {
    const quoted = `# Proposed goal: keep my quote

My pasted evidence follows.

## Captured UI context

### Visible text

Quoted once.

## Captured UI context

### Visible text

The writer's own capture.
`;
    expect(draftProposal(quoted)).toBe(
      "My pasted evidence follows.\n\n" +
        "## Captured UI context\n\n" +
        "### Visible text\n\n" +
        "Quoted once.",
    );
  });

  test("returns nothing for an empty draft", () => {
    expect(draftProposal("")).toBe("");
  });

  test("keeps a report that quotes the marker and drops only the writer's section", () => {
    const quoted = `# Proposed goal: stop the truncated proposal

The detail cuts my report at the marker line I pasted below.

## Captured UI context

- Route: \`/issues\`
- URL: \`http://127.0.0.1:8081/issues\`

That earlier block scrolled away with the paragraph after it.

## Captured UI context

- Route: \`/\`
- URL: \`http://127.0.0.1:8081/\`
- Selected element: \`section.panel\`
- Viewport: \`1440x900\`
- Captured at: \`2026-11-03T09:00:00.000Z\`
`;
    expect(draftProposal(quoted)).toBe(
      "The detail cuts my report at the marker line I pasted below.\n\n" +
        "## Captured UI context\n\n" +
        "- Route: `/issues`\n" +
        "- URL: `http://127.0.0.1:8081/issues`\n\n" +
        "That earlier block scrolled away with the paragraph after it.",
    );
  });

  test("ignores a marker and facts inside a fenced block of the report", () => {
    const fenced = `# Proposed goal: show the fence

The quote follows.

\`\`\`md
## Captured UI context

- Route: \`/\`
\`\`\`

It ends at the fence.

## Captured UI context

No page context was captured.
`;
    expect(draftProposal(fenced)).toBe(
      "The quote follows.\n\n\`\`\`md\n## Captured UI context\n\n- Route: `/`\n\`\`\`\n\nIt ends at the fence.",
    );
  });

  test("keeps a marker line whose body is not a captured section", () => {
    expect(draftProposal("# Draft\n\n## Captured UI context\n\nMentioned in prose.\n")).toBe(
      "## Captured UI context\n\nMentioned in prose.",
    );
  });
});
