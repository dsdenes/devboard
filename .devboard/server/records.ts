import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AdrRecord {
  file: string;
  title: string;
  status: string;
  pending: boolean;
}

export interface AdrList {
  records: AdrRecord[];
  next: string | null;
}

const TITLE_PATTERN = /^#\s+(.+?)\s*$/;
const STATUS_PATTERN = /^\s*(?:[-*+]\s+)?status\s*:\s*(.+?)\s*$/i;

export function parseRecord(file: string, source: string): AdrRecord {
  let title: string | undefined;
  let status: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    title ??= TITLE_PATTERN.exec(line)?.[1];
    status ??= STATUS_PATTERN.exec(line)?.[1];
    if (title !== undefined && status !== undefined) break;
  }

  return {
    file,
    title: title ?? file.replace(/\.md$/i, ""),
    status: status ?? "",
    pending: status?.toLowerCase() === "proposed",
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
