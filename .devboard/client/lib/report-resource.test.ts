import { expect, test } from "bun:test";
import { beginReport, delivered, deliverReport, postReport } from "./report-resource.ts";

/** One recorded request: its URL and method. */
interface Asked {
  url: string;
  method: string;
}

/**
 * Stands in for the dashboard: one `POST /reports` answer and the record reads
 * that follow it.
 */
function dashboard(
  post: { status: number; body: unknown },
  reads: { status: number; body: unknown }[],
): { asked: Asked[]; fetch: typeof fetch } {
  const asked: Asked[] = [];
  const queued = [...reads];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    asked.push({ url, method });
    if (method === "POST") {
      return new Response(JSON.stringify(post.body), {
        status: post.status,
        headers: { "content-type": "application/json" },
      });
    }
    const read = queued.shift();
    if (read === undefined) throw new Error("no queued record read");
    return new Response(JSON.stringify(read.body), {
      status: read.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { asked, fetch: fetchImpl };
}

test("a report the dashboard owns is read again until the issue exists", async () => {
  const stub = dashboard(
    {
      status: 202,
      body: {
        id: 7,
        status: "FILING",
        delivery_timeout_ms: 5000,
        links: { report: { href: "http://dashboard.test/reports/7" } },
      },
    },
    [
      {
        status: 200,
        body: { id: 7, status: "FILING", links: { report: { href: "http://dash.test/r/7" } } },
      },
      {
        status: 200,
        body: {
          id: 7,
          status: "FILED",
          links: { issue: { href: "https://forge.test/issues/9" } },
        },
      },
    ],
  );
  const outcome = await deliverReport(
    { action: "REPORT", report: "Fix it" },
    undefined,
    stub.fetch,
  );
  expect(outcome).toEqual({ ok: true, url: "https://forge.test/issues/9" });
  expect(stub.asked.map((asked) => asked.method)).toEqual(["POST", "GET", "GET"]);
  expect(stub.asked[1]?.url).toBe("http://dashboard.test/reports/7");
});

test("an accepted report answers before its delivery settles", async () => {
  const stub = dashboard(
    {
      status: 202,
      body: {
        id: 8,
        status: "FILING",
        delivery_timeout_ms: 5000,
        links: { report: { href: "http://dashboard.test/reports/8" } },
      },
    },
    [
      {
        status: 200,
        body: {
          id: 8,
          status: "FILED",
          links: { issue: { href: "https://forge.test/issues/8" } },
        },
      },
    ],
  );
  const filing = await beginReport({ action: "REPORT", report: "Fix it" }, undefined, stub.fetch);
  expect(filing.ok).toBe(true);
  expect(
    stub.asked.filter((asked) => asked.method === "GET"),
    "the action answers before the delivery's first read",
  ).toHaveLength(0);
  if (!filing.ok) return;
  expect(await filing.delivery).toEqual({ ok: true, url: "https://forge.test/issues/8" });
});

test("an already filed report answers without a second read", async () => {
  const stub = dashboard(
    {
      status: 200,
      body: {
        id: 3,
        status: "FILED",
        links: { issue: { href: "https://forge.test/issues/3" } },
      },
    },
    [],
  );
  const outcome = await deliverReport({ action: "REPORT", report: "Fix it" }, "key-1", stub.fetch);
  expect(outcome).toEqual({ ok: true, url: "https://forge.test/issues/3" });
  expect(stub.asked).toHaveLength(1);
  expect(stub.asked[0]?.method).toBe("POST");
});

test("a failed delivery answers the record's own reason", async () => {
  const stub = dashboard(
    {
      status: 202,
      body: {
        id: 4,
        status: "FILING",
        delivery_timeout_ms: 5000,
        links: { report: { href: "http://dashboard.test/reports/4" } },
      },
    },
    [
      {
        status: 200,
        body: { id: 4, status: "FAILED", detail: "The issue could not be filed." },
      },
    ],
  );
  const outcome = await deliverReport(
    { action: "REPORT", report: "Fix it" },
    undefined,
    stub.fetch,
  );
  expect(outcome).toEqual({ ok: false, error: "The issue could not be filed." });
});

test("a refused report is a Problem detail, never a read", async () => {
  const stub = dashboard(
    {
      status: 503,
      body: { detail: "Harness reporting is disabled.", status: 503 },
    },
    [],
  );
  const outcome = await deliverReport(
    { action: "REPORT", report: "Fix it" },
    undefined,
    stub.fetch,
  );
  expect(outcome).toEqual({ ok: false, error: "Harness reporting is disabled." });
  expect(stub.asked).toHaveLength(1);
});

test("a record that vanished answers the server's own reason", async () => {
  const reply = await postReport(
    { action: "REPORT", report: "Fix it" },
    undefined,
    dashboard(
      {
        status: 202,
        body: {
          id: 5,
          status: "FILING",
          links: { report: { href: "http://dashboard.test/reports/5" } },
        },
      },
      [],
    ).fetch,
  );
  expect("error" in reply).toBe(false);
  if ("error" in reply) return;
  const outcome = await delivered(
    reply,
    (async () =>
      new Response(JSON.stringify({ detail: "The requested report was not found." }), {
        status: 404,
        headers: { "content-type": "application/problem+json" },
      })) as unknown as typeof fetch,
  );
  expect(outcome).toEqual({ ok: false, error: "The requested report was not found." });
});
