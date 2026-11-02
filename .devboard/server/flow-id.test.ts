import { describe, expect, test } from "bun:test";
import { FeedbackRequestError } from "./feedback";
import { MAX_FLOW_ID, parseFlowId } from "./flow-id";

describe("flow id parsing", () => {
  test("treats an absent header as no call flow", () => {
    expect(parseFlowId(null)).toBeNull();
  });

  test("keeps a printable token verbatim, trimming surrounding whitespace", () => {
    expect(parseFlowId(" 4d1c ")).toBe("4d1c");
    expect(parseFlowId("4d1c-9f3a.2_a~b")).toBe("4d1c-9f3a.2_a~b");
  });

  test("refuses an empty, oversized, or non-printable value", () => {
    for (const value of [
      "",
      "   ",
      "x".repeat(MAX_FLOW_ID + 1),
      "line\nbreak",
      "two words",
    ]) {
      expect(() => parseFlowId(value)).toThrow(FeedbackRequestError);
    }
  });
});
