import { describe, expect, test } from "bun:test";
import { statusTone, verificationTone } from "./status-tone";

describe("status tone", () => {
  test("marks active work as accent", () => {
    expect(statusTone("running")).toBe("accent");
    expect(statusTone("restoring")).toBe("accent");
    expect(statusTone("scanning")).toBe("accent");
    expect(statusTone("pausing")).toBe("accent");
    expect(statusTone("retrying")).toBe("accent");
  });

  test("marks successful completion as success", () => {
    expect(statusTone("succeeded")).toBe("success");
    expect(statusTone("merged")).toBe("success");
    expect(statusTone("handled")).toBe("success");
    expect(statusTone("accepted")).toBe("success");
    expect(statusTone("implemented")).toBe("success");
  });

  test("marks failures as error", () => {
    expect(statusTone("failed")).toBe("error");
    // The agent sync verdict names its failed read `error`.
    expect(statusTone("error")).toBe("error");
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

describe("verification tone", () => {
  test("marks a passing verification as success", () => {
    expect(verificationTone("passed")).toBe("success");
  });

  test("marks a failing verification as error", () => {
    expect(verificationTone("failed")).toBe("error");
  });

  test("keeps a verification that never ran out of the success color", () => {
    expect(verificationTone("not-run")).toBe("warning");
    expect(verificationTone("not-run")).not.toBe("success");
  });

  test("normalizes the verification word", () => {
    expect(verificationTone(" Passed ")).toBe("success");
    expect(verificationTone("NOT-RUN")).toBe("warning");
  });

  test("keeps an unknown verification status neutral", () => {
    expect(verificationTone("deferred")).toBeUndefined();
    expect(verificationTone("")).toBeUndefined();
  });
});
