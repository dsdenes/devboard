import { REPORTS_ENDPOINT, GOAL_PROPOSALS_ENDPOINT } from "../../lib/endpoints.ts";
import { draftPathFromHref } from "../../lib/goal-proposals.ts";
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
    issue?: { href?: unknown };
    draft?: { href?: unknown };
  };
  detail?: unknown;
} | null;

type Reply = { response: Response; body: ReplyBody } | { error: string };

/** Posts one JSON payload and decodes its body; a transport failure is returned. */
async function post(endpoint: string, payload: Record<string, unknown>): Promise<Reply> {
  const action = slowUiAction.dispatchHttp(`POST ${endpoint}`);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    action?.complete();
    const body = (await response.json().catch(() => null)) as ReplyBody;
    return { response, body };
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
 * Files one issue report. The server answers `links.issue.href`; an OK status
 * without that link is a refusal exactly like a non-OK status.
 */
export async function fileFeedback(
  payload: Record<string, unknown>,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const reply = await post(REPORTS_ENDPOINT, payload);
  if ("error" in reply) return { ok: false, error: reply.error };
  const href = reply.body?.links?.issue?.href;
  if (!reply.response.ok || typeof href !== "string") {
    return {
      ok: false,
      error: refusal(reply.body, reply.response.status, "The server refused the report"),
    };
  }
  return { ok: true, url: href };
}

/**
 * Writes one proposed-goal draft and maps its `links.draft.href` to the
 * repository-relative path a draft reader opens.
 */
export async function writeGoalDraft(
  payload: Record<string, unknown>,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const reply = await post(GOAL_PROPOSALS_ENDPOINT, payload);
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
