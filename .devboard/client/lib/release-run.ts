/**
 * The Release Train's live run and gate, as the server projects them onto the
 * agent snapshot. The page renders them beside the shared snapshot fields: the
 * run answers which phase `devboard publish` reached, and the gate answers
 * which verdict started the run.
 */

/** One recorded phase of a release, as `devboard publish` wrote it. */
export interface ReleaseProgressRecord {
  /** ISO 8601, from publish's own clock. */
  at: string;
  phase: string;
  detail: string;
  /** The suite attempt this record describes, when it is one. */
  attempt: number | null;
  passed: number | null;
  failed: number | null;
  /** The CI run this record describes, when it is one. */
  ciRun: number | null;
  conclusion: string | null;
  /** How many GitHub assets the check verified. */
  assets: number | null;
}

/** The active release run the page follows. */
export interface ReleaseRunView {
  id: string;
  state: string;
  range: string;
  target: string;
  version: string | null;
  peerPid: number | null;
  startedAt: string;
  elapsedMs: number | null;
  /** The newest recorded phase, or null before publish records one. */
  phase: string | null;
  /**
   * ISO 8601 of the record that opened that phase, or null when no phase is
   * recorded. The page measures the phase's duration from this instant.
   */
  phaseStartedAt: string | null;
  phaseElapsedMs: number | null;
  records: ReleaseProgressRecord[];
}

/** The gate verdict that produced the newest run. */
export interface ReleaseGateView {
  state: string;
  at: string | null;
  detail: string | null;
  target: string | null;
  range: string | null;
  version: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): ReleaseProgressRecord | null {
  if (!isObject(value)) return null;
  const at = text(value.at);
  const phase = text(value.phase);
  const detail = text(value.detail);
  if (at === null || phase === null || detail === null) return null;
  return {
    at,
    phase,
    detail,
    attempt: count(value.attempt),
    passed: count(value.passed),
    failed: count(value.failed),
    ciRun: count(value.ciRun),
    conclusion: text(value.conclusion),
    assets: count(value.assets),
  };
}

/**
 * The run a snapshot carries, or null when no run is active. A frame whose
 * run is outside the shape is null rather than a half-rendered panel.
 */
export function releaseRunFrom(value: unknown): ReleaseRunView | null {
  if (!isObject(value)) return null;
  const id = text(value.id);
  const state = text(value.state);
  const range = text(value.range);
  const target = text(value.target);
  const startedAt = text(value.startedAt);
  if (id === null || state === null || range === null || target === null || startedAt === null) {
    return null;
  }
  if (!Array.isArray(value.records)) return null;
  const records: ReleaseProgressRecord[] = [];
  for (const entry of value.records) {
    const parsed = record(entry);
    if (parsed === null) return null;
    records.push(parsed);
  }
  return {
    id,
    state,
    range,
    target,
    version: text(value.version),
    peerPid: count(value.peerPid),
    startedAt,
    elapsedMs: count(value.elapsedMs),
    phase: text(value.phase),
    phaseStartedAt: text(value.phaseStartedAt),
    phaseElapsedMs: count(value.phaseElapsedMs),
    records,
  };
}

/** The gate record a snapshot carries, or null when the gate never ran. */
export function releaseGateFrom(value: unknown): ReleaseGateView | null {
  if (!isObject(value)) return null;
  const state = text(value.state);
  if (state === null) return null;
  return {
    state,
    at: text(value.at),
    detail: text(value.detail),
    target: text(value.target),
    range: text(value.range),
    version: text(value.version),
  };
}

/** A compact duration for an elapsed count: `0s`, `42s`, `3m 12s`, `1h 4m`. */
export function elapsedText(millis: number | null): string {
  if (millis === null || !Number.isFinite(millis) || millis < 0) return "—";
  const seconds = Math.floor(millis / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
