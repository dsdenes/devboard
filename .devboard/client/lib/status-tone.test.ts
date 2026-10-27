import { describe, expect, test } from "bun:test";
import { statusTone } from "./status-tone";

describe("status tone", () => {
  test("marks active work as accent", () => {
    expect(statusTone("running")).toBe("accent");
    expect(statusTone("scanning")).toBe("accent");
    expect(statusTone("pausing")).toBe("accent");
    expect(statusTone("retrying")).toBe("accent");
  });

  test("marks successful completion as success", () => {
    expect(statusTone("succeeded")).toBe("success");
    expect(statusTone("merged")).toBe("success");
    expect(statusTone("handled")).toBe("success");
    expect(statusTone("accepted")).toBe("success");
  });

  test("marks failures as error", () => {
    expect(statusTone("failed")).toBe("error");
  });

  test("keeps stopped and paused work neutral instead of the running color", () => {
    for (const status of ["stopped", "paused", "parked", "idle", "closed", "unknown", "none"]) {
      expect(statusTone(status)).toBeUndefined();
    }
    expect(statusTone("stopped")).not.toBe(statusTone("running"));
  });

  test("normalizes the status word", () => {
    expect(statusTone(" Running ")).toBe("accent");
    expect(statusTone("FAILED")).toBe("error");
  });

  test("keeps pending and stale distinct", () => {
    expect(statusTone("pending")).toBe("pending");
    expect(statusTone("stale")).toBe("stale");
    expect(statusTone("deferred")).toBeUndefined();
  });
});
