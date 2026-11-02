import { createHash } from "node:crypto";

/**
 * The stable identity a filed MCP optimizer proposal carries. The body's `## Family`
 * section states `family:<tag>`, and the deduplication read matches it. The
 * proposal body and title are composed by the synthesis turn through the MCP
 * issue tool; no deterministic renderer or validator remains.
 */

export interface McpOptimizerOpenIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** The tag a filed body carries: `family:` plus the first 12 hex of SHA-256. */
export function familyTag(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
