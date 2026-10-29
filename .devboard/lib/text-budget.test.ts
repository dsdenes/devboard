import { describe, expect, test } from "bun:test";
import { boundBytes } from "./text-budget";

const cjk = "界";

describe("boundBytes", () => {
  test("leaves text within the budget untouched", () => {
    expect(boundBytes("hello", 5)).toEqual({ text: "hello", truncated: false });
    expect(boundBytes(cjk, 3)).toEqual({ text: cjk, truncated: false });
  });

  test("cuts multibyte text to the byte budget on a code point boundary", () => {
    const result = boundBytes(cjk.repeat(10), 10, "…");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(10);
    expect(result.text.endsWith("…")).toBe(true);
    expect(result.text).not.toContain("\uFFFD");
  });

  test("never exceeds the budget when the marker alone would", () => {
    const result = boundBytes(cjk.repeat(10), 2, "...");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(2);
  });
});