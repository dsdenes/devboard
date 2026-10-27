import { basename } from "node:path";
import { lintCorpus, type Adr } from "@adrkit/core";

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

/** Projects one adrkit record onto the interface's record contract. */
export function recordFromAdr(adr: Adr): AdrRecord {
  const { status } = adr.frontmatter;
  return {
    file: basename(adr.path),
    title: adr.frontmatter.title,
    // The interface renders a capitalized status; adrkit stores the lowercase enum.
    status: status.charAt(0).toUpperCase() + status.slice(1),
    pending: status === "draft" || status === "proposed",
    summary: readDecision(adr.body.split(/\r?\n/)),
  };
}

/** Reads the corpus through adrkit and lists only the records it accepts. */
export async function readRecords(directory: string): Promise<AdrList> {
  let records: Adr[];
  try {
    ({ records } = await lintCorpus({ dir: directory }));
  } catch (error) {
    // An implementation reset removes the record directory. An absent
    // directory is an empty record set, not a read failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], next: null };
    }
    throw error;
  }

  const list = records.map(recordFromAdr).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return {
    records: list,
    next: list.find((record) => record.pending)?.file ?? null,
  };
}
