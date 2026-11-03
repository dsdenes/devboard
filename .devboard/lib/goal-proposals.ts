import { GOAL_PROPOSALS_ENDPOINT } from "./endpoints";

/**
 * The repository-relative directory holding every proposed-goal draft. The
 * server writes drafts there, serves one draft on the dashboard's own host, the
 * client derives a draft's repository-relative path from that link, and the
 * draft readers resolve it under the repository root.
 */
export const GOAL_PROPOSALS_DIRECTORY = ".devboard/goal-proposals";

/**
 * The repository-relative draft path a `links.draft.href` names, or `null`
 * when the value is not an absolute HTTP URI selecting one draft on
 * `<GOAL_PROPOSALS_ENDPOINT>/<name>`. Drafts live directly under the proposals
 * directory, so the URL's last segment is the whole repository-relative
 * remainder. A `file:` URI shapes the server's own disk and is refused: no
 * client can dereference it.
 */
export function draftPathFromHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.host.length === 0) return null;
  const prefix = `${GOAL_PROPOSALS_ENDPOINT}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (!name.endsWith(".md") || name === ".md" || name.includes("/") || name.includes("\\")) {
    return null;
  }
  return `${GOAL_PROPOSALS_DIRECTORY}/${name}`;
}
