import { FeedbackRequestError } from "./feedback";

/**
 * The `X-Flow-ID` header: one opaque token a call flow carries across the
 * services it touches, so one client call is recognisable in every log along
 * the way.
 *
 * The dashboard accepts the header on every request, echoes it on the
 * response, forwards it on the outbound Gitea call a filing makes, and names
 * it in the journal record a failed request writes. The value leaves the
 * process as a header line, so only a bounded printable token is accepted: a
 * control character never reaches a response, a journal line, or an outbound
 * request.
 */

/**
 * The longest flow id a client may send. A UUID needs 36 characters, and the
 * bound keeps one request from turning a header into journal noise.
 */
export const MAX_FLOW_ID = 200;

/** An HTTP token: printable ASCII, which excludes spaces and control characters. */
const PRINTABLE_TOKEN = /^[\x21-\x7e]+$/;

/** The header a client sends and the dashboard echoes. */
export const FLOW_ID_HEADER = "X-Flow-ID";

/**
 * Reads one request's `X-Flow-ID`. An absent header means the request joins
 * no call flow and keeps the plain behavior; a present one must be a non-empty
 * printable token of at most `MAX_FLOW_ID` characters, and the surrounding
 * whitespace an HTTP client may add is trimmed. A malformed value is refused
 * with HTTP 400 before any handler runs.
 */
export function parseFlowId(value: string | null): string | null {
  if (value === null) return null;
  const flowId = value.trim();
  if (flowId.length === 0) {
    throw new FeedbackRequestError(400, `${FLOW_ID_HEADER} must not be empty.`);
  }
  if (flowId.length > MAX_FLOW_ID) {
    throw new FeedbackRequestError(
      400,
      `${FLOW_ID_HEADER} is longer than ${MAX_FLOW_ID} characters.`,
    );
  }
  if (!PRINTABLE_TOKEN.test(flowId)) {
    throw new FeedbackRequestError(400, `${FLOW_ID_HEADER} must be a printable token.`);
  }
  return flowId;
}

/**
 * The same answer with the request's flow id echoed on it, so the client can
 * match its own call to the server's record. A body stream and every other
 * header carry over unchanged.
 */
export function echoFlowId(response: Response, flowId: string): Response {
  const headers = new Headers(response.headers);
  headers.set(FLOW_ID_HEADER, flowId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
