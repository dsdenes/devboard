import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AdrRecord {
  file: string;
  title: string;
  status: string;
  pending: boolean;
  /** The first paragraph of the Decision section, shortened for the record dropdown. */
  summary: string;
}

export interface AdrList {
  records: AdrRecord[];
  next: string | null;
}

const TITLE_PATTERN = /^#\s+(.+?)\s*$/;
const STATUS_PATTERN = /^\s*(?:[-*+]\s+)?status\s*:\s*(.+?)\s*$/i;
const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*$/;
const DECISION_HEADING = /^decision$/i;
const SUMMARY_LIMIT = 280;

/** Collapses the first decision paragraph to the short form the dropdown shows. */
function summarizeDecision(paragraph: string[]): string {
  if (paragraph.length === 0) return "";
  const text = paragraph
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/^[-+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= SUMMARY_LIMIT) return text;
  const cut = text.slice(0, SUMMARY_LIMIT);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).replace(/[.,;:!?-]+$/, "")}…`;
}

/** Reads the first paragraph under the record's Decision heading. */
function readDecision(lines: string[]): string {
  let inDecision = false;
  let started = false;
  const paragraph: string[] = [];

  for (const line of lines) {
    const heading = HEADING_PATTERN.exec(line)?.[1];
    if (heading !== undefined) {
      if (DECISION_HEADING.test(heading)) {
        inDecision = true;
        continue;
      }
      if (inDecision) break;
      continue;
    }
    if (!inDecision) continue;

    if (line.trim().length === 0) {
      if (started) break;
      continue;
    }
    started = true;
    paragraph.push(line.trim());
  }

  return summarizeDecision(paragraph);
}

export function parseRecord(file: string, source: string): AdrRecord {
  let title: string | undefined;
  let status: string | undefined;
  const lines = source.split(/\r?\n/);

  for (const line of lines) {
    title ??= TITLE_PATTERN.exec(line)?.[1];
    status ??= STATUS_PATTERN.exec(line)?.[1];
    if (title !== undefined && status !== undefined) break;
  }

  return {
    file,
    title: title ?? file.replace(/\.md$/i, ""),
    status: status ?? "",
    pending: status?.toLowerCase() === "proposed",
    summary: readDecision(lines),
  };
}

export async function readRecords(directory: string): Promise<AdrList> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    // An implementation reset removes the record directory. An absent
    // directory is an empty record set, not a read failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], next: null };
    }
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const records = await Promise.all(
    files.map(async (file) => parseRecord(file, await readFile(join(directory, file), "utf8"))),
  );

  return {
    records,
    next: records.find((record) => record.pending)?.file ?? null,
  };
}
