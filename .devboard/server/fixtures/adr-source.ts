import { basename } from "node:path";

/** The status vocabulary a fixture record may carry. */
export type AdrStatus = "draft" | "proposed" | "accepted" | "rejected" | "superseded" | "deprecated";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Builds a fixture decision record with the YAML frontmatter the corpus format requires.
 * The four-digit id is taken from the file name, so the record passes corpus validation
 * exactly where the fixture writes it.
 */
export function fixtureRecord(
  file: string,
  title: string,
  status: AdrStatus = "accepted",
  body = "",
): string {
  const id = /^(\d{4,})-/.exec(basename(file))?.[1];
  if (id === undefined) throw new Error(`Fixture record name needs a numeric id: ${file}`);
  return [
    "---",
    "schemaVersion: 0.2.0",
    `id: "${id}"`,
    `title: ${title}`,
    `status: ${status}`,
    "date: 2026-10-19",
    'deciders: ["@dsdenes"]',
    "affects: []",
    "---",
    `# ${title}`,
    "",
    body,
  ].join("\n");
}

/** A record that is still waiting for a decision. */
export function pendingRecord(file: string, title: string, context = "", decision = ""): string {
  return fixtureRecord(
    file,
    title,
    "proposed",
    `## Context\n\n${context}\n\n## Decision\n\n${decision}\n`,
  );
}

/** The status field of a record's leading YAML frontmatter block, if it has one. */
export function frontmatterStatus(source: string): AdrStatus | undefined {
  const block = FRONTMATTER.exec(source)?.[1];
  if (block === undefined) return undefined;
  return /^status:\s*([a-z]+)\s*$/m.exec(block)?.[1] as AdrStatus | undefined;
}

/** Whether a status is waiting for a decision. */
export function isPendingStatus(status: AdrStatus | undefined): boolean {
  return status === "draft" || status === "proposed";
}

/** Rewrites the status field inside the frontmatter, leaving the rest of the file untouched. */
export function setFrontmatterStatus(source: string, status: AdrStatus): string {
  const match = FRONTMATTER.exec(source);
  if (match === null) throw new Error("Record has no YAML frontmatter to update.");
  const block = match[1] ?? "";
  if (!/^status:\s*[a-z]+\s*$/m.test(block)) throw new Error("Record frontmatter has no status field.");
  const updated = block.replace(/^status:\s*[a-z]+\s*$/m, `status: ${status}`);
  const start = match[0].indexOf(block);
  const head = match[0].slice(0, start) + updated + match[0].slice(start + block.length);
  return head + source.slice(match[0].length);
}
