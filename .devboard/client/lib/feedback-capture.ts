/**
 * The page context every filing and ask carries, bounded to the server's
 * limits. `POST /reports` and `POST /goal-proposals` refuse a whole request
 * whose route, URL, selector, or viewport is over its bound, so a page with a
 * long URL or a deep selector would make every filing fail. Both builders take
 * these values from one function, so the two payloads cannot drift apart.
 */

import { codePointPrefix } from "./notification-issue.ts";

/** The server's bound on `route`, `url`, and `selector`. */
export const MAX_ROUTE = 2000;
export const MAX_URL = 2000;
export const MAX_SELECTOR = 500;
/** The server's bound on the viewport label. */
export const MAX_VIEWPORT = 500;

/** The page values a capture reads, as the browser reports them. */
export interface PageSource {
  pathname: string;
  href: string;
  viewport: string;
}

/** The four bounded page and element fields. */
export interface PageContext {
  route: string;
  url: string;
  selector: string;
  viewport: string;
}

/**
 * Collapses runs of spaces and tabs, trims, and cuts to `limit`, marking a cut
 * with an ellipsis so the result is never longer than the limit. The cut keeps
 * whole code points: a bound that lands inside a surrogate pair stops before
 * the pair, so `JSON.stringify` never emits the lone `\ud8`–`\udb` escape that
 * the server's `serde_json` refuses to parse.
 */
export function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/[ \t]+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${codePointPrefix(collapsed, limit - 1)}…`;
}

/** The four page and element fields, each truncated to its server bound. */
export function pageContext(page: PageSource, selector: string): PageContext {
  return {
    route: truncate(page.pathname, MAX_ROUTE),
    url: truncate(page.href, MAX_URL),
    selector: truncate(selector, MAX_SELECTOR),
    viewport: truncate(page.viewport, MAX_VIEWPORT),
  };
}
