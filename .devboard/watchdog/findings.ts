import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  normalizeEvidenceLine,
  parseTimestamp,
  type EvidenceEvent,
  type Window,
} from "./collect";
import type { Instance } from "./discovery";

/**
 * Findings are derived from what the evidence says, never from which project
 * produced it. Each category is a distinct signal the watchdog can fix.
 */
export const FINDING_CATEGORIES = [
  "error",
  "failed-command",
  "retry",
  "blocker",
  "confusion",
  "question-loop",
  "stall",
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface Finding {
  category: FindingCategory;
  /** Normalized source path. */
  source: string;
  /** Event timestamp, UTC ISO 8601. */
  ts: string;
  /** The shortest quote that carries the signal. */
  quote: string;
  /** Stable identity across cycles: category, source, normalized line. */
  fingerprint: string;
  instance?: Instance;
}

const SIGNALS: [FindingCategory, RegExp][] = [
  [
    "error",
    /\b(error|exception|traceback|fatal|panic|crash(?:ed)?)\b|\b(?:ENOENT|ECONNREFUSED|EACCES|ETIMEDOUT|EADDRINUSE|EPERM)\b/i,
  ],
  [
    "failed-command",
    /command failed|failed to (?:run|execute|spawn|start|write|read|parse)|exit(?:ed)? with (?:code )?[1-9]|non-zero exit|command not found|no such file/i,
  ],
  ["retry", /\b(retry|retrying|retries|backoff)\b|\battempt \d+/i],
  [
    "blocker",
    /\b(blocker|blocked|cannot proceed|needs? (?:a )?(?:human|operator|decision)|parked)\b/i,
  ],
  ["confusion", /(confus|unclear|ambiguous|not sure|don'?t understand|unsure|which one)/i],
];

/** Source paths are reported relative to the repository when they live inside it. */
export function normalizeSource(root: string, path: string): string {
  const resolved = resolve(path);
  const prefix = `${resolve(root)}/`;
  return resolved.startsWith(prefix) ? resolved.slice(prefix.length) : resolved;
}

export function findingFingerprint(
  category: FindingCategory,
  source: string,
  line: string,
): string {
  return createHash("sha256")
    .update(`${category}\n${source}\n${normalizeEvidenceLine(line)}`)
    .digest("hex")
    .slice(0, 32);
}

function classify(text: string): FindingCategory | undefined {
  for (const [category, pattern] of SIGNALS) {
    if (pattern.test(text)) return category;
  }
  return undefined;
}

function eventKey(event: EvidenceEvent): string {
  return event.instance === undefined
    ? event.source
    : `${event.instance.repoDir}:${event.instance.port}`;
}

function startKind(event: EvidenceEvent): boolean {
  return event.kind === "run-start" || event.kind === "lane-start";
}

function stopKind(event: EvidenceEvent): boolean {
  return event.kind === "run-stop" || event.kind === "lane-stop";
}

/**
 * Turns a window of evidence into one finding per distinct signal. Repeated
 * copies of the same line collapse to one finding; a clean window yields none.
 */
export function analyzeEvidence(
  events: EvidenceEvent[],
  options: { root: string; window: Window },
): Finding[] {
  const findings = new Map<string, Finding>();
  const questions = new Map<string, EvidenceEvent[]>();
  const starts = new Map<string, EvidenceEvent[]>();
  const stops = new Map<string, number[]>();

  const add = (category: FindingCategory, event: EvidenceEvent, line: string) => {
    const source = normalizeSource(options.root, event.source);
    const fingerprint = findingFingerprint(category, source, line);
    if (findings.has(fingerprint)) return;
    findings.set(fingerprint, {
      category,
      source,
      ts: event.ts,
      quote: normalizeEvidenceLine(line).slice(0, 300),
      fingerprint,
      ...(event.instance === undefined ? {} : { instance: event.instance }),
    });
  };

  for (const event of events) {
    if (event.kind === "question") {
      const key = eventKey(event);
      const list = questions.get(key) ?? [];
      list.push(event);
      questions.set(key, list);
      continue;
    }
    if (startKind(event)) {
      const key = eventKey(event);
      const list = starts.get(key) ?? [];
      list.push(event);
      starts.set(key, list);
      continue;
    }
    if (stopKind(event)) {
      const key = eventKey(event);
      const list = stops.get(key) ?? [];
      const parsed = parseTimestamp(event.ts);
      if (parsed !== undefined) list.push(parsed);
      stops.set(key, list);
      continue;
    }
    const category = classify(event.text);
    if (category !== undefined) add(category, event, event.text);
  }

  for (const list of questions.values()) {
    if (list.length < 3) continue;
    const last = list[list.length - 1];
    if (last !== undefined) add("question-loop", last, last.text);
  }

  const stallCutoff = options.window.end.getTime() - 5 * 60 * 1000;
  for (const [key, list] of starts) {
    const finished = stops.get(key) ?? [];
    for (const event of list) {
      const started = parseTimestamp(event.ts);
      if (started === undefined || started > stallCutoff) continue;
      if (finished.some((stopped) => stopped >= started)) continue;
      add("stall", event, event.text);
      break;
    }
  }

  return [...findings.values()].sort(
    (left, right) =>
      left.ts.localeCompare(right.ts) ||
      left.category.localeCompare(right.category) ||
      left.source.localeCompare(right.source),
  );
}
