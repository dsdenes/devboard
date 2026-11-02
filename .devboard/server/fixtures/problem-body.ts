/**
 * The media type every failure response declares (Zalando rule 176).
 */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/**
 * The Problem JSON body a failure response carries, as a test states the
 * expected outcome. A response whose type has no profile-specific semantics
 * names `about:blank`, which is what this server sends.
 */
export function problemBody(title: string, status: number, detail: string) {
  return { type: "about:blank", title, status, detail };
}
