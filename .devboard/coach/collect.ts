import { journalFile } from "../server/journal";
import type { AgentSession } from "../lib/agent-sessions";
import { selectSessions } from "../lib/agent-sessions";
import type { Instance } from "../watchdog/discovery";
import { parseTimestamp, readJournalEvidence } from "../watchdog/collect";
import type { CoachJournalRecord } from "./findings";

/**
 * One cycle's evidence. Sessions come from the shared ACP transcript reader
 * (selected by working directory, newest 1,000 files); journal records come
 * from the same reader the watchdog uses, so a rotation de-duplicates the same
 * way. Nothing outside the repository and state directory is read.
 */

/** Journal kinds a Coach cycle keeps. */
export const COACH_JOURNAL_KINDS = new Set([
  "question",
  "acp-stderr",
  "activity",
  "run-start",
  "run-stop",
]);

export interface EvidenceWindow {
  start: Date;
  end: Date;
}

export interface CoachCollection {
  window: { start: string; end: string };
  sessions: AgentSession[];
  journal: CoachJournalRecord[];
  /** Selected transcript files, before the newest-file cap. */
  sessionFiles: number;
  /** Transcripts left out by the newest-file cap. */
  sessionsOmitted: number;
  truncated: boolean;
  /** Transcripts with no usable session record, timestamp, cwd, or id. */
  skipped: number;
  /** Malformed JSONL lines across sessions and journal files. */
  malformed: number;
  journalRecords: number;
}

export interface CollectOptions {
  stateDir: string;
  repoDir: string;
  window: EvidenceWindow;
  maxFiles?: number;
  /** Test seam: replaces the shared journal read. */
  journal?: (window: EvidenceWindow) => { records: CoachJournalRecord[]; malformed: number };
}

function journalInstance(stateDir: string, repoDir: string): Instance {
  return {
    pid: 0,
    port: 0,
    repoDir,
    host: "127.0.0.1",
    harness: "",
    stateDir,
    journal: journalFile(stateDir, repoDir),
    instrumented: true,
  };
}

function readJournal(
  stateDir: string,
  repoDir: string,
  window: EvidenceWindow,
): { records: CoachJournalRecord[]; malformed: number } {
  const evidence = readJournalEvidence(journalInstance(stateDir, repoDir), {
    window,
    root: repoDir,
  });
  const records: CoachJournalRecord[] = [];
  for (const event of evidence.events) {
    if (!COACH_JOURNAL_KINDS.has(event.kind)) continue;
    const instant = parseTimestamp(event.ts);
    if (instant === undefined) continue;
    records.push({
      kind: event.kind,
      ts: new Date(instant).toISOString(),
      text: event.text,
      scope: event.scope ?? null,
    });
  }
  records.sort(
    (left, right) =>
      left.ts.localeCompare(right.ts) ||
      left.kind.localeCompare(right.kind) ||
      (left.scope ?? "").localeCompare(right.scope ?? "") ||
      left.text.localeCompare(right.text),
  );
  return { records, malformed: evidence.malformed };
}

/** Collects the evidence for one cycle; it never writes and never spawns. */
export function collectEvidence(options: CollectOptions): CoachCollection {
  const selection = selectSessions({
    stateDir: options.stateDir,
    repoDir: options.repoDir,
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });
  const journal =
    options.journal?.(options.window) ??
    readJournal(options.stateDir, options.repoDir, options.window);
  return {
    window: {
      start: options.window.start.toISOString(),
      end: options.window.end.toISOString(),
    },
    sessions: selection.sessions,
    journal: journal.records,
    sessionFiles: selection.selected,
    sessionsOmitted: selection.omitted,
    truncated: selection.truncated,
    skipped: selection.skipped,
    malformed: selection.malformed + journal.malformed,
    journalRecords: journal.records.length,
  };
}
