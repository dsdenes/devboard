import { REPORTS_ENDPOINT } from "../../lib/endpoints.ts";
import { queryClient } from "./query-client";

/**
 * The client side of the report resource. `POST /reports` answers as soon as
 * the dashboard owns the delivery, because filing one issue is a forge write
 * and a forge is not bound by the operator action's budget. The record it links
 * is then read again at the page's cadence until it settles. No Svelte state
 * and no latency guard live here, so a card that files without an operator
 * action shares exactly this decoding.
 */

/** One report record as the server serves it. */
export interface ReportBody {
  id?: unknown;
  status?: unknown;
  detail?: unknown;
  delivery_timeout_ms?: unknown;
  links?: {
    report?: { href?: unknown };
    issue?: { href?: unknown };
  };
}

/** The server's answer to one report request, whatever its status. */
export interface ReportReply {
  status: number;
  body: ReportBody | null;
}

export type ReportOutcome = { ok: true; url: string } | { ok: false; error: string };

type FetchLike = typeof fetch;

/**
 * How often the page re-reads a report the dashboard is filing. It is the
 * page's own refresh cadence: the record is one resource like any other, and
 * its answer is the issue the forge created.
 */
export const REPORT_REFRESH_MS = 1000;

/** The delivery bound used when a record carries none. */
const REPORT_BOUND_MS = 60_000;

/** The server's own reason, or the refusal the status stands for. */
function refusal(body: ReportBody | null, status: number, fallback: string): string {
  return typeof body?.detail === "string" ? body.detail : `${fallback} (${status}).`;
}

/** One settled filing, or the reason this report has none. */
function settled(body: ReportBody | null, status: number, fallback: string): ReportOutcome | null {
  const href = body?.links?.issue?.href;
  if (typeof href === "string") return { ok: true, url: href };
  if (body?.status === "FAILED") return { ok: false, error: refusal(body, status, fallback) };
  return null;
}

/** Posts one report and decodes its answer; a transport failure is returned. */
export async function postReport(
  payload: object,
  idempotencyKey?: string,
  fetchImpl: FetchLike = fetch,
): Promise<ReportReply | { error: string }> {
  try {
    const response = await fetchImpl(REPORTS_ENDPOINT, {
      method: "POST",
      headers:
        idempotencyKey === undefined
          ? { "content-type": "application/json" }
          : { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as ReportBody | null;
    return { status: response.status, body };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One report's filing: the operator action's own answer, and the delivery the
 * dashboard owns afterwards.
 *
 * `ok: false` is the refused action — nothing was filed. `ok: true` means the
 * dashboard accepted the report, so the action is complete and `delivery`
 * resolves with the issue once the forge created it.
 */
export type Filing =
  | { ok: false; error: string }
  | { ok: true; delivery: Promise<ReportOutcome> };

/** Posts one report and answers with what the dashboard accepted. */
export async function beginReport(
  payload: object,
  idempotencyKey?: string,
  fetchImpl: FetchLike = fetch,
): Promise<Filing> {
  const reply = await postReport(payload, idempotencyKey, fetchImpl);
  if ("error" in reply) return { ok: false, error: reply.error };
  if (reply.status < 200 || reply.status >= 300) {
    return {
      ok: false,
      error: refusal(reply.body, reply.status, "The server refused the report"),
    };
  }
  return { ok: true, delivery: delivered(reply, fetchImpl) };
}

/**
 * Files one report without a latency guard, for a card that files by itself.
 *
 * The card's filing is not an operator action, so it is measured by neither the
 * background latency guard nor the action's budget.
 */
export async function deliverReport(
  payload: object,
  idempotencyKey?: string,
  fetchImpl: FetchLike = fetch,
): Promise<ReportOutcome> {
  const filing = await beginReport(payload, idempotencyKey, fetchImpl);
  if (!filing.ok) return filing;
  return filing.delivery;
}

/**
 * Reads the report resource again until the delivery settles.
 *
 * A refused request, an already filed record, and a failed one answer without a
 * read. A `FILING` record is re-read at the page's cadence, bounded by the
 * deadline the server states for its own delivery.
 */
export async function delivered(
  reply: ReportReply,
  fetchImpl: FetchLike = fetch,
): Promise<ReportOutcome> {
  if (reply.status < 200 || reply.status >= 300) {
    return {
      ok: false,
      error: refusal(reply.body, reply.status, "The server refused the report"),
    };
  }
  let record = reply.body;
  let status = reply.status;
  const bound =
    typeof record?.delivery_timeout_ms === "number"
      ? record.delivery_timeout_ms
      : REPORT_BOUND_MS;
  const deadline = Date.now() + bound;
  while (true) {
    const answered = settled(record, status, "The issue could not be filed.");
    if (answered !== null) return answered;
    if (record?.status !== "FILING") {
      return { ok: false, error: refusal(record, status, "The server answered no report") };
    }
    const href = record.links?.report?.href;
    if (typeof href !== "string") {
      return { ok: false, error: refusal(record, status, "The server linked no report") };
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: `The report was not filed within ${bound} ms.` };
    }
    const cadence = Promise.withResolvers<void>();
    setTimeout(cadence.resolve, REPORT_REFRESH_MS);
    await cadence.promise;
    let response: Response;
    try {
      // The report record is a backend resource like any other: it is read
      // through the query cache, keyed by its own href, and never fetched by
      // the caller.
      response = await queryClient.fetchQuery({
        queryKey: ["report", href],
        queryFn: () =>
          fetchImpl(href, {
            method: "GET",
            headers: { accept: "application/json" },
            cache: "no-store",
          }),
        staleTime: 0,
        gcTime: 0,
        retry: false,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const answer = (await response.json().catch(() => null)) as ReportBody | null;
    if (response.ok) {
      record = answer;
      status = response.status;
      continue;
    }
    return {
      ok: false,
      error: refusal(answer, response.status, "The server answered no report"),
    };
  }
}
