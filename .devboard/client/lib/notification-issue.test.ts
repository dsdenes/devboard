import { describe, expect, test } from "bun:test";
import type { AppNotification } from "./notifications.svelte";
import { MAX_NOTIFICATION_REPORT, notificationReport } from "./notification-issue";

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 1,
    severity: "error",
    text: 'item 1 ("Flow restore re-adds checkpoints.jsonl entries") evidence: server/flow.ts does not exist',
    at: "2026-10-28T11:29:44.932Z",
    ...overrides,
  };
}

describe("notification issue report", () => {
  test("leads with the severity and notification text for the issue title", () => {
    const report = notificationReport(notification());
    expect(report.split("\n")[0]).toBe(
      'Error notification: item 1 ("Flow restore re-adds checkpoints.jsonl entries") evidence: server/flow.ts does not exist',
    );
    expect(report).toContain("\n\nRaised at: 2026-10-28T11:29:44.932Z");
  });

  test("labels every severity without changing the notification text", () => {
    expect(
      notificationReport(notification({ severity: "warning" })).startsWith(
        "Warning notification: ",
      ),
    ).toBe(true);
    expect(
      notificationReport(notification({ severity: "notice" })).startsWith(
        "Notice notification: ",
      ),
    ).toBe(true);
    expect(
      notificationReport(notification({ severity: "success" })).startsWith(
        "Success notification: ",
      ),
    ).toBe(true);
  });

  test("trims surrounding whitespace and keeps a long message inside the server bound", () => {
    const long = notification({ text: `  ${"x".repeat(MAX_NOTIFICATION_REPORT)}  ` });
    const report = notificationReport(long);
    expect(report.length).toBeLessThanOrEqual(MAX_NOTIFICATION_REPORT);
    expect(report.endsWith("…\n\nRaised at: 2026-10-28T11:29:44.932Z")).toBe(true);
  });

  test("a long first line is truncated without losing the timestamp", () => {
    const report = notificationReport(notification({ text: "y".repeat(10_000) }));
    expect(report.split("\n")[0]!.length).toBeLessThanOrEqual(MAX_NOTIFICATION_REPORT);
  });
});
