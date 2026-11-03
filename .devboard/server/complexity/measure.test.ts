import { describe, expect, test } from "bun:test";
import { measureSource, tokenize } from "./measure";

/**
 * A fixture whose decision points, nesting, and comment/string noise are all
 * known by hand:
 * - `decide` has `if`, `for`, `if`, a ternary, and `else if` (6), three levels
 *   of blocks, twelve lines, two parameters;
 * - `twice` and `nested`'s inner arrow each own their own decisions;
 * - the header comment, the block comment's `while (true)`, and the template
 *   literal's `//` never contribute a token.
 */
const SOURCE = [
  "// a header comment with if (x) {",
  "export function decide(a: number, b: number): number {",
  "  if (a > 0) {",
  "    for (let i = 0; i < b; i += 1) {",
  "      if (a === i) {",
  "        return a ? 1 : 0;",
  "      }",
  "    }",
  "  } else if (b < 0) {",
  "    return -1;",
  "  }",
  "  return b;",
  "}",
  "",
  "/*",
  "  while (true) { }",
  "*/",
  "const twice = (value: number): number => {",
  "  return value * 2;",
  "};",
  "",
  "export function nested(flag: boolean): number {",
  "  const decide = (value: number): number => {",
  "    return value ? 1 : 0;",
  "  };",
  "  if (flag) {",
  "    return decide(flag ? 1 : 0);",
  "  }",
  "  return 0;",
  "}",
].join("\n");

describe("function measurement", () => {
  test("reports cyclomatic complexity, length, nesting, and parameters", () => {
    const measured = measureSource(SOURCE).functions;

    expect(measured).toEqual([
      { name: "decide", line: 2, lines: 12, cyclomatic: 6, nesting: 3, parameters: 2 },
      { name: "twice", line: 18, lines: 3, cyclomatic: 1, nesting: 0, parameters: 1 },
      { name: "nested", line: 22, lines: 9, cyclomatic: 3, nesting: 1, parameters: 1 },
      { name: "decide", line: 23, lines: 3, cyclomatic: 2, nesting: 0, parameters: 1 },
    ]);
  });

  test("a nested function's decisions belong to it, never to its parent", () => {
    const measured = measureSource(SOURCE).functions;
    const outer = measured.find((entry) => entry.name === "nested");
    const inner = measured.filter((entry) => entry.name === "decide")[1];

    // The parent keeps its own `if` and ternary; the inner arrow keeps the
    // ternary in its body, so neither value absorbs the other.
    expect(outer?.cyclomatic).toBe(3);
    expect(inner?.cyclomatic).toBe(2);
  });

  test("comments, strings, and template literals contribute no decision", () => {
    const measured = measureSource(
      [
        "function quiet(value: string): string {",
        "  // if (this) || (that) ? 1 : 2",
        "  const text = value ?? 'a ? b : c';",
        "  return text;",
        "}",
      ].join("\n"),
    );

    // The `??` operator is one decision; the commented `if`, `||`, and `?`,
    // and the quoted ternary are none.
    expect(measured.functions).toEqual([
      { name: "quiet", line: 1, lines: 5, cyclomatic: 2, nesting: 0, parameters: 1 },
    ]);
  });
});

describe("file measurement", () => {
  test("counts non-blank, non-comment code lines", () => {
    // Every line above holds code except the two inside the block comment,
    // the blank lines, and the comment-only header.
    expect(measureSource(SOURCE).loc).toBe(24);
  });

  test("halstead counts operands and operators separately", () => {
    const counts = measureSource("const a = 1;\n").halstead;

    expect(counts.operators).toBe(3);
    expect(counts.distinctOperators).toBe(3);
    expect(counts.operands).toBe(2);
    expect(counts.distinctOperands).toBe(2);
  });

  test("the same text measures the same values twice", () => {
    expect(measureSource(SOURCE)).toEqual(measureSource(SOURCE));
  });

  test("an optional marker is not a ternary branch", () => {
    const measured = measureSource(
      "function optional(value?: string): number {\n  return 0;\n}\n",
    ).functions;

    expect(measured[0]?.cyclomatic).toBe(1);
    expect(measured[0]?.parameters).toBe(1);
  });

  test("a regular expression's braces and parentheses never open a block", () => {
    const measured = measureSource(
      "function match(text: string): boolean {\n  return /[{}()]/.test(text);\n}\n",
    ).functions;

    expect(measured).toEqual([
      { name: "match", line: 1, lines: 3, cyclomatic: 1, nesting: 0, parameters: 1 },
    ]);
  });
});

describe("tokenizer", () => {
  test("skips comments and keeps one token per literal", () => {
    const tokens = tokenize('/* one */ // two\n const value = "three";\n');

    expect(tokens.map((token) => token.text)).toEqual([
      "const",
      "value",
      "=",
      '"three"',
      ";",
    ]);
    expect(tokens.map((token) => token.line)).toEqual([2, 2, 2, 2, 2]);
  });

  test("keeps the template literal as one token across its lines", () => {
    const tokens = tokenize("const text = `line\nif (x) {`;\n");

    expect(tokens.filter((token) => token.kind === "string").length).toBe(1);
    expect(tokens.some((token) => token.text === "if")).toBe(false);
  });
});
