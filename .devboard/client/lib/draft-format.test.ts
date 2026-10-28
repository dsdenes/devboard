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

  test("returns nothing for an empty draft", () => {
    expect(draftProposal("")).toBe("");
  });
});
