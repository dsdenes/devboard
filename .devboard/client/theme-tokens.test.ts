import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** The shipped stylesheet, read the way `IssuesWorkspaceAgents.test.ts` mounts it. */
const CSS = readFileSync(new URL("./app.css", import.meta.url), "utf8");

/** The custom properties one `:root[data-theme="<theme>"]` block declares. */
function themeTokens(theme: string): Map<string, string> {
  const open = `:root[data-theme="${theme}"] {`;
  const start = CSS.indexOf(open);
  if (start < 0) throw new Error(`app.css declares no ${theme} theme block`);
  const end = CSS.indexOf("}", start + open.length);
  if (end < 0) throw new Error(`the ${theme} theme block is unterminated`);
  const declared = new Map<string, string>();
  for (const match of CSS.slice(start + open.length, end).matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;
    declared.set(name, value.trim());
  }
  return declared;
}

// Every row hover sits on a `--surface` panel, so a hover that repaints the
// panel's own color is invisible feedback. Both themes must keep them apart.
for (const theme of ["dark", "light"]) {
  test(`the ${theme} theme keeps row hover distinct from surface`, () => {
    const tokens = themeTokens(theme);
    const hover = tokens.get("row-hover");
    const surface = tokens.get("surface");
    expect(hover).toBeDefined();
    expect(surface).toBeDefined();
    expect(hover).not.toBe(surface);
  });
}
