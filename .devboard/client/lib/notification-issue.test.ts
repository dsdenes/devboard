import { describe, expect, test } from "bun:test";
import type { AppNotification } from "./notifications.svelte";
import {
  AUTOMATIC_ISSUE_INSTRUCTION,
  MAX_NOTIFICATION_REPORT,
  NotificationFiler,
  notificationFingerprint,
  notificationIdempotencyKey,
  notificationIssueRequest,
  notificationReport,
  fileSlowUiAction,
  slowUiActionIdempotencyKey,
  type NotificationContext,
} from "./notification-issue";

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 1,
    severity: "error",
    source: "Flow",
    text: 'item 1 ("Flow restore re-adds checkpoints.jsonl entries") evidence: server/flow.ts does not exist',
    at: "2026-10-28T11:29:44.932Z",
    ...overrides,
  };
}

const context: NotificationContext = {
  route: "/",
  url: "http://localhost:3001/",
  selector: '.notification[data-notification-id="1"]',
  domExcerpt: "<div class=\"notification\">…</div>",
  visibleText: "error · Flow",
  viewport: "1440x900 @1x",
  capturedAt: "2026-10-28T11:29:45.000Z",
};

function created(href = "http://localhost:3001/dsdenes/devboard/issues/42"): Response {
  return new Response(JSON.stringify({ links: { issue: { href } } }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

function refused(detail = "The issue could not be filed."): Response {
  return new Response(JSON.stringify({ detail }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });
}

describe("notification issue report", () => {
  test("leads with the severity and notification text for the issue title", () => {
    const report = notificationReport(notification());
    expect(report.split("\n")[0]).toBe(
      'Error notification: item 1 ("Flow restore re-adds checkpoints.jsonl entries") evidence: server/flow.ts does not exist',
    );
    expect(report).toContain("\n\nSource: Flow\nRaised at: 2026-10-28T11:29:44.932Z");
  });

  test("names the agent that raised the notification", () => {
    const report = notificationReport(
      notification({ severity: "success", source: "Auto Scout", text: "Filed 2 issues." }),
    );
    expect(report).toBe(
      "Success notification: Filed 2 issues.\n\nSource: Auto Scout\n" +
        "Raised at: 2026-10-28T11:29:44.932Z",
    );
  });

  test("closes an error report with the fixed instruction", () => {
    const report = notificationReport(notification(), AUTOMATIC_ISSUE_INSTRUCTION);
    expect(report).toBe(
      "Error notification: " +
        'item 1 ("Flow restore re-adds checkpoints.jsonl entries") evidence: server/flow.ts does not exist' +
        "\n\nSource: Flow\nRaised at: 2026-10-28T11:29:44.932Z" +
        `\n\n${AUTOMATIC_ISSUE_INSTRUCTION}`,
    );
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
    const report = notificationReport(long, AUTOMATIC_ISSUE_INSTRUCTION);
    expect(report.length).toBeLessThanOrEqual(MAX_NOTIFICATION_REPORT);
    expect(report.endsWith(`Raised at: 2026-10-28T11:29:44.932Z\n\n${AUTOMATIC_ISSUE_INSTRUCTION}`)).toBe(true);
  });

  test("a long first line is truncated without losing the timestamp", () => {
    const report = notificationReport(notification({ text: "y".repeat(10_000) }));
    expect(report.split("\n")[0]!.length).toBeLessThanOrEqual(MAX_NOTIFICATION_REPORT);
  });
});

describe("notification issue request", () => {
  test("carries the error instruction and the captured page context", () => {
    const request = notificationIssueRequest(notification(), context);
    expect(request).toEqual({
      action: "REPORT",
      report: notificationReport(notification(), AUTOMATIC_ISSUE_INSTRUCTION),
      route: "/",
      url: "http://localhost:3001/",
      selector: '.notification[data-notification-id="1"]',
      dom_excerpt: "<div class=\"notification\">…</div>",
      visible_text: "error · Flow",
      viewport: "1440x900 @1x",
      captured_at: "2026-10-28T11:29:45.000Z",
    });
    expect(request.report).toContain(AUTOMATIC_ISSUE_INSTRUCTION);
    expect(request.report.split("\n")[0]!.startsWith("Error notification: ")).toBe(true);
  });

  test("a warning report keeps today's text without the error instruction", () => {
    const request = notificationIssueRequest(notification({ severity: "warning" }), context);
    expect(request.report).not.toContain(AUTOMATIC_ISSUE_INSTRUCTION);
    expect(request.report.split("\n")[0]).toBe(
      "Warning notification: " +
        'item 1 ("Flow restore re-adds checkpoints.jsonl entries") evidence: server/flow.ts does not exist',
    );
  });
});

describe("automatic notification filing", () => {
  test("files one issue per severity, source, and text", async () => {
    const filer = new NotificationFiler();
    const calls: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, body: JSON.parse(String(init?.body)) });
      return created();
    }) as typeof fetch;

    const first = await filer.autoFile(notification(), () => context, fetchImpl);
    expect(first).toEqual({
      status: "filed",
      href: "http://localhost:3001/dsdenes/devboard/issues/42",
    });
    const again = await filer.autoFile(
      notification({ id: 2, at: "2026-10-28T11:30:00.000Z" }),
      () => context,
      fetchImpl,
    );
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: "/reports",
      body: { action: "REPORT", report: expect.stringContaining(AUTOMATIC_ISSUE_INSTRUCTION) },
    });
  });

  test("a different severity, source, or text files its own issue", async () => {
    const filer = new NotificationFiler();
    const bodies: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return created(`http://localhost:3001/dsdenes/devboard/issues/${bodies.length + 10}`);
    }) as typeof fetch;

    await filer.autoFile(notification(), () => context, fetchImpl);
    await filer.autoFile(notification({ id: 2, source: "Issues" }), () => context, fetchImpl);
    await filer.autoFile(notification({ id: 3, text: "Another failure." }), () => context, fetchImpl);
    await filer.autoFile(notification({ id: 4, severity: "warning" }), () => context, fetchImpl);

    expect(bodies).toHaveLength(4);
    expect(new Set(bodies).size).toBe(4);
  });

  test("a failed filing records the server's detail and a retry replaces it", async () => {
    const filer = new NotificationFiler();
    let outcome: "fail" | "ok" = "fail";
    const calls: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(init?.body));
      return outcome === "fail" ? refused() : created();
    }) as typeof fetch;

    const failed = await filer.autoFile(notification(), () => context, fetchImpl);
    expect(failed).toEqual({ status: "failed", detail: "The issue could not be filed." });
    expect(filer.state(notification())).toEqual(failed);

    outcome = "ok";
    const retried = await filer.file(notification(), () => context, fetchImpl);
    expect(retried).toEqual({
      status: "filed",
      href: "http://localhost:3001/dsdenes/devboard/issues/42",
    });
    expect(filer.state(notification())).toEqual(retried);

    const later = await filer.autoFile(notification({ id: 9 }), () => context, fetchImpl);
    expect(later).toEqual(retried);
    expect(calls).toHaveLength(2);
  });

  test("a network failure keeps the error and sends nothing more for the identical error", async () => {
    const filer = new NotificationFiler();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const failed = await filer.autoFile(notification(), () => context, fetchImpl);
    expect(failed).toEqual({ status: "failed", detail: "Failed to fetch" });
    await filer.autoFile(notification({ id: 7 }), () => context, fetchImpl);
    expect(calls).toBe(1);
  });

  test("the fingerprint ignores the raise time and the notification id", () => {
    expect(
      notificationFingerprint(notification({ id: 1 })),
    ).toBe(
      notificationFingerprint(notification({ id: 2, at: "2026-10-29T00:00:00.000Z" })),
    );
    expect(notificationFingerprint(notification({ source: "Server" }))).not.toBe(
      notificationFingerprint(notification()),
    );
  });

  test("two page sessions send the same idempotency key for one error", async () => {
    const keys: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      keys.push(headers["idempotency-key"] ?? "");
      return created();
    }) as typeof fetch;

    await new NotificationFiler().autoFile(notification({ id: 5 }), () => context, fetchImpl);
    await new NotificationFiler().autoFile(
      notification({ id: 7, at: "2026-10-28T11:29:47.000Z" }),
      () => context,
      fetchImpl,
    );

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^notification-error:[0-9a-f]{16}$/);
    expect(keys[0]).toBe(notificationIdempotencyKey(notification()));
  });

  test("a different severity, source, or text sends a different key", () => {
    const keys = new Set([
      notificationIdempotencyKey(notification()),
      notificationIdempotencyKey(notification({ source: "Issues" })),
      notificationIdempotencyKey(notification({ text: "Another failure." })),
      notificationIdempotencyKey(notification({ severity: "warning" })),
    ]);
    expect(keys.size).toBe(4);
  });

  test("a manual warning filing sends no idempotency key", async () => {
    const filer = new NotificationFiler();
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>);
      return created();
    }) as typeof fetch;
    const warning = notification({ severity: "warning", source: "Connection" });

    await filer.submit(warning, () => context, fetchImpl);

    expect(headers).toHaveLength(1);
    expect(headers[0]).not.toHaveProperty("idempotency-key");
    expect(headers[0]).toMatchObject({ "content-type": "application/json" });
  });
});

describe("manual notification filing", () => {
  test("two identical warnings can each be filed by hand", async () => {
    const filer = new NotificationFiler();
    const calls: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(init?.body));
      return created();
    }) as typeof fetch;
    const warning = notification({ severity: "warning", source: "Connection" });
    await filer.submit(warning, () => context, fetchImpl);
    await filer.submit(warning, () => context, fetchImpl);
    expect(calls).toHaveLength(2);
    // A manual warning filing never joins the automatic error identities.
    expect(filer.state(warning)).toBeUndefined();
  });
});

describe("slow UI action filing", () => {
  test("posts the bounded report under the stable action key", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return created("http://localhost:3001/dsdenes/devboard/issues/88");
    }) as typeof fetch;
    const key = slowUiActionIdempotencyKey("startAgent|scout|/issues");
    const outcome = await fileSlowUiAction(
      "Slow UI action: startAgent scout exceeded the 1000 ms budget.",
      key,
      fetchImpl,
    );

    expect(outcome).toEqual({
      ok: true,
      url: "http://localhost:3001/dsdenes/devboard/issues/88",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/reports");
    expect(calls[0]?.init?.headers).toEqual({
      "content-type": "application/json",
      "idempotency-key": key,
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      action: "REPORT",
      report: "Slow UI action: startAgent scout exceeded the 1000 ms budget.",
    });
    expect(key).toMatch(/^slow-ui-action:[0-9a-f]{16}$/);
  });

  test("returns the server detail and keeps the same key for one identity", async () => {
    const keys: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      keys.push((init?.headers as Record<string, string>)["idempotency-key"] ?? "");
      return refused("The Gitea reporting address is not configured.");
    }) as typeof fetch;
    const identity = "stopAgent|scout|/issues";

    const outcome = await fileSlowUiAction("Slow report", slowUiActionIdempotencyKey(identity), fetchImpl);
    expect(outcome).toEqual({
      ok: false,
      error: "The Gitea reporting address is not configured.",
    });
    await fileSlowUiAction("Slow report", slowUiActionIdempotencyKey(identity), fetchImpl);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(slowUiActionIdempotencyKey(identity));
  });
});
