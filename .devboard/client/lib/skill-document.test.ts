import { describe, expect, test } from "bun:test";
import { renderSkillDocument, skillBody } from "./skill-document";

const skill = [
  "---",
  "name: fixture-conventions",
  "description: Conventions every fixture implementation agent follows.",
  "metadata:",
  '  devboard-managed: "true"',
  "---",
  "",
  "# Fixture conventions",
  "",
  "- Prefer the smallest observable change.",
  "- Run `bun test` before pushing.",
].join("\n");

describe("skillBody", () => {
  test("drops the frontmatter and keeps the instructions", () => {
    expect(skillBody(skill)).toBe(
      [
        "# Fixture conventions",
        "",
        "- Prefer the smallest observable change.",
        "- Run `bun test` before pushing.",
      ].join("\n"),
    );
  });

  test("keeps a document without frontmatter whole", () => {
    expect(skillBody("# Plain\n\n- One rule.")).toBe("# Plain\n\n- One rule.");
  });

  test("normalizes CRLF before reading the fence", () => {
    expect(skillBody(skill.replaceAll("\n", "\r\n"))).toContain("# Fixture conventions");
    expect(skillBody(skill.replaceAll("\n", "\r\n"))).not.toContain("devboard-managed");
  });

  test("treats an unclosed fence as ordinary content", () => {
    expect(skillBody("---\nname: broken\n\n# Body")).toBe("---\nname: broken\n\n# Body");
  });
});

describe("renderSkillDocument", () => {
  test("renders headings, list items, and inline code as markup", () => {
    const html = renderSkillDocument(skill);
    expect(html).toContain("<h1>Fixture conventions</h1>");
    expect(html).toContain("<li>Prefer the smallest observable change.</li>");
    expect(html).toContain("<code>bun test</code>");
    expect(html).not.toContain("devboard-managed");
  });

  test("renders fenced code without touching its text", () => {
    const html = renderSkillDocument("```ts\nconst a = 1 < 2;\n```");
    expect(html).toContain("language-ts");
    expect(html).toContain("const a = 1 &lt; 2;");
  });

  test("shows raw HTML as text instead of executing it", () => {
    const html = renderSkillDocument('<script>alert("x")</script>\n\nAfter.');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("keeps a safe link and strips a script link to its label", () => {
    expect(renderSkillDocument("[docs](https://example.com/x)")).toContain(
      'href="https://example.com/x" target="_blank" rel="noreferrer noopener"',
    );
    const script = renderSkillDocument("[click](javascript:alert(1))");
    expect(script).not.toContain("javascript:");
    expect(script).toContain("click");
  });

  test("returns no markup for a frontmatter-only skill", () => {
    expect(renderSkillDocument("---\nname: empty\n---\n")).toBe("");
  });
});
