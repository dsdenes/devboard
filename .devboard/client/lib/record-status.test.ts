import { describe, expect, test } from "bun:test";
import { recordStatusTone } from "./record-status";

describe("record status tone", () => {
  test("maps each decision status to its badge tone", () => {
    expect(recordStatusTone("Accepted")).toBe("success");
    expect(recordStatusTone(" accepted ")).toBe("success");
    expect(recordStatusTone("Proposed")).toBe("pending");
    expect(recordStatusTone("Superseded")).toBe("stale");
    expect(recordStatusTone("Deprecated")).toBe("stale");
    expect(recordStatusTone("Rejected")).toBe("error");
  });

  test("leaves a status it does not know neutral", () => {
    expect(recordStatusTone("")).toBeUndefined();
    expect(recordStatusTone("Draft")).toBeUndefined();
  });
});
