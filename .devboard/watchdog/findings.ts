import { createHash } from "node:crypto";
import {
  normalizeEvidenceLine,
  parseTimestamp,
  type EvidenceEvent,
  type Window,
} from "./collect";
import type { Instance } from "./discovery";

/**
 * Findings are machine-checkable signals, never prose. A category names the
 * evidence kind that produced it, so one text produces one fingerprint no
 * matter which dashboard or which checkout observed it.
 */
export const FINDING_CATEGORIES = [
  "server-error",
  "update-error",
  "acp-stderr",
  "lane-failed",
  "omp-error",
  "omp-warn",
  "omp-fatal",
  "stall",
  "question-loop",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** Journal kinds that are a finding on their own. */
const SIGNAL_KINDS: Record<string, FindingCategory> = {
  "server-error": "server-error",
  "update-error": "update-error",
  "acp-stderr": "acp-stderr",
};

/** A start this long before window end with no matching stop is a stall. */
export const STALL_MS = 5 * 60 * 1000;

/**
 * Stall candidates come from the lookback the coordinator collected, so a
 * start in one cycle's final stall interval is judged by the next cycle
 * instead of disappearing with the window. Every other category stays on the
 * cycle window, which keeps recurrence counts tied to the evidence it covers.
 */
export interface AnalysisOptions {
  window: Window;
  /** Stall candidates; defaults to the window itself. */
  stallLookback?: Window;
}

/** This many questions for one instance in one window is a loop. */
export const QUESTION_LOOP_COUNT = 3;

export interface Finding {
  category: FindingCategory;
  /** The normalized evidence line, truncated for a report body. */
  quote: string;
  /** Earliest event timestamp the finding was derived from, UTC ISO 8601. */
  ts: string;
  /** Every dashboard that contributed the same signal. */
  instances: Instance[];
  /** Stable identity across cycles and hosts: category and normalized line. */
  fingerprint: string;
}

/**
 * `sha256(category + "\n" + normalized line)`, first 32 hex characters. The
 * source path is deliberately absent: the same error on two dashboards is one
 * fingerprint, and so is the same error after a dashboard moves.
 */
export function findingFingerprint(category: string, line: string): string {
  return createHash("sha256")
    .update(`${category}\n${normalizeEvidenceLine(line)}`)
    .digest("hex")
    .slice(0, 32);
}

/** The last whitespace-separated token of a `lane-stop` line is its status. */
export function laneStatus(text: string): string | undefined {
  const tokens = text.trim().split(/\s+/);
  return tokens.length < 2 ? undefined : tokens[tokens.length - 1];
}

/**
 * omp's thinking-loop guard aborts the repeated stream and schedules the retry
 * itself, so the notice records a recovery, never a defect. A turn that cannot
 * recover still ends with its own provider-error record; filing an issue for
 * each discarded attempt would ask a maintainer to change the model's
 * repetition, which no repository change can do.
 */
function recoveredStreamWarning(event: EvidenceEvent): boolean {
  return (
    event.kind === "omp-log" &&
    event.level === "warn" &&
    /^Thinking loop detected\b/.test(normalizeEvidenceLine(event.text))
  );
}

/** omp's Python runner reports its stderr under this one message. */
const PYTHON_RUNNER_STDERR = "Python runner stderr";

/** The last line of a traceback names the exception it ended with. */
function tracebackException(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[lines.length - 1];
}

/**
 * omp's Python runner writes a traceback to stderr whenever the cell it runs is
 * interrupted, which is how it stops at the end of a session. That traceback
 * records an ordinary shutdown — the operator's Stop, or the run's last cell —
 * never a defect the repository could fix, so it is not a finding. A traceback
 * that ends in an exception still is: the runner failing to complete a cell is
 * evidence, and the interrupt names itself as the exception.
 */
function interruptedPythonRunner(event: EvidenceEvent): boolean {
  return (
    event.kind === "omp-log" &&
    event.level === "warn" &&
    normalizeEvidenceLine(event.text) === PYTHON_RUNNER_STDERR &&
    tracebackException(event.detail) === "KeyboardInterrupt"
  );
}

function eventKey(event: EvidenceEvent): string {
  return event.instance === undefined
    ? event.source
    : `${event.instance.repoDir}:${event.instance.port}`;
}

/**
 * Questions belong to one run, lane, or peer when the journal recorded a
 * scope. Separate work streams on one dashboard are separate conversations,
 * never one loop.
 */
function questionKey(event: EvidenceEvent): string {
  return event.scope === undefined ? eventKey(event) : `${eventKey(event)}\n${event.scope}`;
}

/**
 * A start is finished only by a stop of the same work stream on the same
 * dashboard. Lane records begin with the lane id; run records begin with the
 * run file before the `file: title` separator. A lane and a run never share a
 * stream, so a `run-stop` cannot end a lane and a sibling lane's stop cannot
 * end another lane's stall.
 */
function streamKey(event: EvidenceEvent): string {
  const text = normalizeEvidenceLine(event.text);
  if (event.kind.startsWith("lane-")) {
    const lane = text.split(/\s+/, 1)[0] ?? "";
    return `${eventKey(event)}\nlane\n${lane}`;
  }
  const separator = text.indexOf(":");
  const file = separator === -1 ? "" : text.slice(0, separator).trim();
  return `${eventKey(event)}\nrun\n${file}`;
}

/**
 * Turns a window of evidence into one finding per distinct signal. Only the
 * evidence kinds in `FINDING_CATEGORIES` can produce one: activity, lifecycle,
 * update, run and lane records, and questions below the loop threshold are
 * context, never findings.
 */
export function analyzeEvidence(
  events: EvidenceEvent[],
  options: AnalysisOptions,
): Finding[] {
  const findings = new Map<string, Finding>();
  const questions = new Map<string, EvidenceEvent[]>();
  const starts = new Map<string, EvidenceEvent[]>();
  const stops = new Map<string, number[]>();
  const windowStart = options.window.start.getTime();
  const windowEnd = options.window.end.getTime();
  const lookback = options.stallLookback ?? options.window;
  const lookbackStart = lookback.start.getTime();
  const lookbackEnd = lookback.end.getTime();

  /** A non-stall signal counts only inside the cycle window. */
  const inWindow = (instant: number | undefined): instant is number =>
    instant !== undefined && instant >= windowStart && instant <= windowEnd;

  /** A start or stop is stall evidence anywhere in the collected lookback. */
  const inLookback = (instant: number | undefined): instant is number =>
    instant !== undefined && instant >= lookbackStart && instant <= lookbackEnd;

  const add = (category: FindingCategory, event: EvidenceEvent) => {
    const quote = normalizeEvidenceLine(event.text);
    if (quote.length === 0) return;
    const fingerprint = findingFingerprint(category, quote);
    const existing = findings.get(fingerprint);
    if (existing !== undefined) {
      if (event.ts < existing.ts) existing.ts = event.ts;
      if (
        event.instance !== undefined &&
        !existing.instances.some(
          (instance) =>
            instance.repoDir === event.instance?.repoDir && instance.port === event.instance.port,
        )
      ) {
        existing.instances.push(event.instance);
      }
      return;
    }
    findings.set(fingerprint, {
      category,
      quote: quote.slice(0, 300),
      ts: event.ts,
      instances: event.instance === undefined ? [] : [event.instance],
      fingerprint,
    });
  };

  for (const event of events) {
    const occurred = parseTimestamp(event.ts);
    switch (event.kind) {
      case "question": {
        if (!inWindow(occurred)) continue;
        const key = questionKey(event);
        questions.set(key, [...(questions.get(key) ?? []), event]);
        continue;
      }
      case "run-start":
      case "lane-start": {
        if (!inLookback(occurred)) continue;
        const key = streamKey(event);
        starts.set(key, [...(starts.get(key) ?? []), event]);
        continue;
      }
      case "run-stop":
      case "lane-stop": {
        if (!inLookback(occurred)) continue;
        const key = streamKey(event);
        stops.set(key, [...(stops.get(key) ?? []), occurred]);
        // A stop is only a stall terminator; a failed lane is a finding.
        if (
          event.kind === "lane-stop" &&
          occurred >= windowStart &&
          laneStatus(event.text) === "failed"
        ) {
          add("lane-failed", event);
        }
        continue;
      }
      default:
        break;
    }
    if (!inWindow(occurred)) continue;
    if (event.kind === "omp-log" && event.level !== undefined) {
      if (!recoveredStreamWarning(event) && !interruptedPythonRunner(event)) {
        add(`omp-${event.level}` as FindingCategory, event);
      }
      continue;
    }
    const category = SIGNAL_KINDS[event.kind];
    if (category !== undefined) add(category, event);
  }

  for (const list of questions.values()) {
    if (list.length < QUESTION_LOOP_COUNT) continue;
    const last = list[list.length - 1];
    if (last !== undefined) add("question-loop", last);
  }

  const stallCutoff = options.window.end.getTime() - STALL_MS;
  for (const [key, list] of starts) {
    const finished = stops.get(key) ?? [];
    for (const event of list) {
      const started = parseTimestamp(event.ts);
      if (started === undefined || started > stallCutoff) continue;
      if (finished.some((stopped) => stopped >= started)) continue;
      add("stall", event);
    }
  }

  return [...findings.values()].sort(
    (left, right) =>
      left.ts.localeCompare(right.ts) ||
      left.category.localeCompare(right.category) ||
      left.fingerprint.localeCompare(right.fingerprint),
  );
}
