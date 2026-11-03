/**
 * The repository-relative directory holding every proposed-goal draft. The
 * server writes drafts there, the client derives a draft's repository-relative
 * path from the file link it receives, and the draft readers resolve it under
 * the repository root.
 */
export const GOAL_PROPOSALS_DIRECTORY = ".devboard/goal-proposals";

/**
 * The repository-relative draft path a `links.draft.href` names, or `null`
 * when the value is not an absolute URI naming a Markdown draft. Drafts live
 * directly under the proposals directory, so the URI's last segment is the
 * whole repository-relative remainder.
 */
export function draftPathFromHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  const name = url.pathname.split("/").pop() ?? "";
  if (!name.endsWith(".md") || name === ".md") return null;
  return `${GOAL_PROPOSALS_DIRECTORY}/${name}`;
}
