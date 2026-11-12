import { GOAL_PROPOSALS_ENDPOINT } from "../../lib/endpoints.ts";
import { draftPathFromHref } from "../../lib/goal-proposals.ts";
import { beginReport, type Filing } from "./report-resource.ts";
import { postJson } from "./rest-transport";
import { slowUiAction } from "./slow-ui-action";

/**
 * The client side of the feedback overlay's two mutations. Each endpoint owns
 * one request body and one response link, so each function here decodes only
 * its own contract and returns either the created resource or the server's
 * reason. No Svelte state lives here: a caller passes its payload in and
 * renders the outcome.
 */

type ReplyBody = {
  links?: {
    draft?: { href?: unknown };
  };
  detail?: unknown;
} | null;

type Reply = { response: Response; body: ReplyBody } | { error: string };

/** Posts one proposed-goal draft and decodes its body. */
async function post(payload: object): Promise<Reply> {
  const action = slowUiAction.dispatchHttp(`POST ${GOAL_PROPOSALS_ENDPOINT}`);
  try {
    const reply = await postJson(GOAL_PROPOSALS_ENDPOINT, payload);
    action?.complete();
    return {
      response: { ok: reply.ok, status: reply.status } as Response,
      body: reply.body as ReplyBody,
    };
  } catch (error) {
    action?.complete();
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The server's own reason, or the refusal the status stands for. */
function refusal(body: ReplyBody, status: number, fallback: string): string {
  return typeof body?.detail === "string" ? body.detail : `${fallback} (${status}).`;
}

/**
 * Files one issue report and answers with what the dashboard accepted.
 *
 * The operator's action is measured to the server's answer, which the dashboard
 * sends as soon as it owns the delivery; `delivery` resolves with the issue the
 * forge created, on the deadline the server states, and never holds the action.
 */
export async function fileReport(
  payload: object,
  fetchImpl: typeof fetch = fetch,
): Promise<Filing> {
  const action = slowUiAction.dispatchHttp("POST /reports");
  const filing = await beginReport(payload, undefined, fetchImpl);
  action?.complete();
  return filing;
}

/**
 * Writes one proposed-goal draft and maps its `links.draft.href` to the
 * repository-relative path a draft reader opens.
 */
export async function writeGoalDraft(
  payload: object,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const reply = await post(payload);
  if ("error" in reply) return { ok: false, error: reply.error };
  const href = reply.body?.links?.draft?.href;
  const path = typeof href === "string" ? draftPathFromHref(href) : null;
  if (!reply.response.ok || path === null) {
    return {
      ok: false,
      error: refusal(reply.body, reply.response.status, "The server refused the proposal"),
    };
  }
  return { ok: true, path };
}
