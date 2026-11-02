import { CATEGORIES, type ScoutCategory } from "./paths";

/**
 * Scout identity helpers that survive the tool-driven flow: the normalized
 * title every deduplication comparison uses, and the category line the page
 * reads from an issue body. Answer parsing lived here and is gone; the agent
 * files through the MCP issue tool and the forge is the record.
 */

export function isCategory(value: unknown): value is ScoutCategory {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

/** Lowercase, whitespace-collapsed, trimmed: the one title identity everywhere. */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The `## Category` line of an issue body, for an issue Auto Scout adopted
 * rather than filed. A missing heading or a blank value yields null.
 */
export function categoryFromBody(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const heading = lines.findIndex((line) => line.trim().toLowerCase() === "## category");
  if (heading < 0) return null;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const value = lines[index]!.trim();
    if (value.length === 0) continue;
    if (value.startsWith("#")) return null;
    return value.length <= 40 ? value : null;
  }
  return null;
}
