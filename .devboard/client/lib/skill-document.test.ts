import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

  test("finds the fence behind a UTF-8 byte-order mark", () => {
    expect(skillBody(`\uFEFF${skill}`)).toBe(
      [
        "# Fixture conventions",
        "",
        "- Prefer the smallest observable change.",
        "- Run `bun test` before pushing.",
      ].join("\n"),
    );
  });
});

describe("renderSkillDocument", () => {
  test("renders headings, list items, and inline code as markup", () => {
    const html = renderSkillDocument(skill);
    expect(html).toContain('<h1 id="fixture-conventions">Fixture conventions</h1>');
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

  test("strips a script link whose scheme hides a control character", () => {
    const obfuscated = [
      "[click](<java\tscript:alert(1)>)",
      "[click](<java\u000bscript:alert(1)>)",
      "[click](<java\u001fscript:alert(1)>)",
      "[click](<java\u007fscript:alert(1)>)",
      "[click](<\u0001javascript:alert(1)>)",
    ];
    for (const source of obfuscated) {
      const html = renderSkillDocument(source);
      expect(html).not.toContain("<a ");
      expect(html).not.toContain("script:");
      expect(html).toContain("click");
    }
  });

  test("normalizes an external destination and keeps it in its own tab", () => {
    expect(renderSkillDocument("[docs](<https://exa\tmple.com/x>)")).toContain(
      'href="https://example.com/x" target="_blank" rel="noreferrer noopener"',
    );
    expect(renderSkillDocument("[mail](mailto:a@b.c)")).toContain(
      'href="mailto:a@b.c" target="_blank" rel="noreferrer noopener"',
    );
    expect(renderSkillDocument("[data](data:text/html,<b>x</b>)")).not.toContain("<a ");
  });

  test("renders a relative destination as text instead of an app-navigable anchor", () => {
    const html = renderSkillDocument("[rel](../x.md)");
    expect(html).not.toContain("<a ");
    expect(html).toContain("rel (../x.md)");
  });

  test("renders a fragment destination in page with the heading id it names", () => {
    const html = renderSkillDocument(
      ["## Durable state", "", "See [Durable state](#durable-state)."].join("\n"),
    );
    expect(html).toContain('<h2 id="durable-state">Durable state</h2>');
    expect(html).toContain('<a href="#durable-state">Durable state</a>');
    expect(html).not.toContain('target="_blank"');
  });

  test("suffixes a heading id the same document repeats", () => {
    const html = renderSkillDocument(["## Notes", "", "## Notes"].join("\n"));
    expect(html).toContain('<h2 id="notes">Notes</h2>');
    expect(html).toContain('<h2 id="notes-1">Notes</h2>');
  });

  test("renders the shipped reference's fragments in page", async () => {
    const source = await Bun.file(
      join(import.meta.dir, "..", "..", "omp", "skills", "devboard-harness-reference", "SKILL.md"),
    ).text();
    const html = renderSkillDocument(source);
    for (const fragment of ["#durable-state", "#skills", "#devboard-mcp-server"]) {
      expect(html).toContain(`<a href="${fragment}">`);
      expect(html).toContain(`id="${fragment.slice(1)}"`);
    }
    expect(html).not.toMatch(/<a href="#[^"]*"[^>]*\starget="_blank"/);
  });

  test("returns no markup for a frontmatter-only skill", () => {
    expect(renderSkillDocument("---\nname: empty\n---\n")).toBe("");
  });
});
