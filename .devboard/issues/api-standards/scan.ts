import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  CYCLE_VERSION,
  TITLE_MAX,
  cycleDirectory,
  findingsPath,
  inputPath,
  requestPath,
  type ApiStandardsConfig,
  type RestRule,
  type RuleLevel,
} from "./paths";
import type { AuditInput, RouteEntry } from "./audit";

/**
 * One cycle's on-disk request and answer. The peer reads the request and the
 * input, files its own admissible findings through the MCP issue tool, and
 * writes one decision per candidate. The worker records every decision and
 * never files anything itself.
 */

export interface CycleRequest {
  version: 1;
  cycleId: string;
  repository: string;
  repoDir: string;
  sourceDir: string;
  skillDocument: string;
  rulesDocument: string;
  chapters: string[];
  rules: Array<{ id: string; level: RuleLevel; chapter: string }>;
  routes: RouteEntry[];
  sources: Array<{ path: string; lines: number }>;
  knownTitles: string[];
  issueRoom: number;
  createdAt: string;
}

export type SkipReason =
  | "may-level"
  | "duplicate"
  | "no-room"
  | "outside-http"
  | "missing-citation"
  | "missing-evidence"
  | "tool-error";

export interface FindingEndpoint {
  method: string;
  path: string;
}

export interface FindingEvidence {
  path: string;
  lines: string;
  quote: string;
}

export interface Finding {
  title: string;
  ruleId: string;
  level: string;
  chapter: string;
  /** The rule's directive, verbatim from the skill. */
  directive: string;
  endpoints: FindingEndpoint[];
  evidence: FindingEvidence[];
  proposedChange: string;
  acceptanceCriteria: string[];
}

export interface FindingDecision extends Finding {
  decision: "filed" | "skipped";
  reason?: string;
  issueNumber?: number;
  issueUrl?: string;
}

export interface FindingsAnswer {
  version: 1;
  findings: FindingDecision[];
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
}

let sequence = 0;

export function createCycleDirectory(
  repoDir: string,
  now: Date,
): { cycleId: string; directory: string } {
  const base = `${stamp(now)}-${String(process.pid).padStart(6, "0")}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    sequence += 1;
    const cycleId = `${base}-${String(sequence).padStart(4, "0")}`;
    const directory = cycleDirectory(repoDir, cycleId);
    if (existsSync(directory)) continue;
    mkdirSync(directory, { recursive: true });
    return { cycleId, directory };
  }
  throw new Error("could not allocate a unique api-standards cycle directory");
}

/** Writes the input snapshot and the request naming the surface and the caps. */
export function writeCycle(
  directory: string,
  options: {
    cycleId: string;
    repository: string;
    repoDir: string;
    input: AuditInput;
    config: ApiStandardsConfig;
    knownTitles: string[];
    issueRoom: number;
    now: Date;
  },
): CycleRequest {
  const request: CycleRequest = {
    version: CYCLE_VERSION,
    cycleId: options.cycleId,
    repository: options.repository,
    repoDir: options.repoDir,
    sourceDir: options.config.sourceDir,
    skillDocument: options.input.skill.skillPath,
    rulesDocument: options.input.skill.rulesPath,
    chapters: [...options.input.skill.chapters],
    rules: options.input.skill.rules.map((rule) => ({
      id: rule.id,
      level: rule.level,
      chapter: rule.chapter,
    })),
    routes: options.input.routes,
    sources: options.input.sources.map((file) => ({ path: file.path, lines: file.lines })),
    knownTitles: [...options.knownTitles].sort(),
    issueRoom: options.issueRoom,
    createdAt: options.now.toISOString(),
  };
  writeFileSync(
    inputPath(directory),
    `${JSON.stringify(
      {
        sources: options.input.sources,
        routes: options.input.routes,
        documents: [
          { path: options.input.skill.skillPath, text: options.input.skill.skillText },
          { path: options.input.skill.rulesPath, text: options.input.skill.rulesText },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(requestPath(directory), `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

export function promptFor(directory: string): string {
  return `/api-standards-audit ${directory}`;
}

/** The line span a citation names, as `[start, end]`, or undefined. */
function lineSpan(value: string): [number, number] | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return undefined;
  }
  return [start, end];
}

export interface FindingContext {
  rules: readonly RestRule[];
  /** Every audited file's text, by repository-relative path. */
  sources: ReadonlyMap<string, string>;
}

export type FindingProblem =
  | { ok: true; rule: RestRule }
  | { ok: false; reason: SkipReason; detail: string };

/**
 * Proves one candidate finding before its decision is recorded: a rule the
 * skill actually publishes with that id, level, chapter, and directive, an
 * HTTP endpoint, and evidence copied verbatim from the named file and span.
 * A candidate that fails any proof is never recorded as filed.
 */
export function validateFinding(finding: unknown, context: FindingContext): FindingProblem {
  if (typeof finding !== "object" || finding === null || Array.isArray(finding)) {
    return { ok: false, reason: "missing-citation", detail: "the finding is not an object" };
  }
  const record = finding as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (title.length === 0 || title.length > TITLE_MAX) {
    return {
      ok: false,
      reason: "missing-citation",
      detail: `the title must be 1 through ${TITLE_MAX} characters`,
    };
  }
  const ruleId = typeof record.ruleId === "string" ? record.ruleId.trim() : "";
  const level = typeof record.level === "string" ? record.level.trim() : "";
  if (!/^\d+$/.test(ruleId) || (level !== "MUST" && level !== "SHOULD" && level !== "MAY")) {
    return {
      ok: false,
      reason: "missing-citation",
      detail: "the finding cites no numeric rule id with its MUST, SHOULD, or MAY level",
    };
  }
  if (level === "MAY") {
    return { ok: false, reason: "may-level", detail: `rule ${ruleId} is MAY` };
  }
  const rule = context.rules.find((entry) => entry.id === ruleId && entry.level === level);
  if (rule === undefined) {
    return {
      ok: false,
      reason: "missing-citation",
      detail: `the skill publishes no rule ${ruleId} at level ${level}`,
    };
  }
  if (record.chapter !== rule.chapter) {
    return {
      ok: false,
      reason: "missing-citation",
      detail: `rule ${ruleId} sits under ${rule.chapter}, not ${String(record.chapter)}`,
    };
  }
  if (record.directive !== rule.directive) {
    return {
      ok: false,
      reason: "missing-citation",
      detail: `the quoted directive for rule ${ruleId} is not the skill's verbatim directive`,
    };
  }
  const endpoints = record.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return { ok: false, reason: "outside-http", detail: "the finding names no HTTP endpoint" };
  }
  for (const endpoint of endpoints) {
    if (typeof endpoint !== "object" || endpoint === null) {
      return { ok: false, reason: "outside-http", detail: "an endpoint is not an object" };
    }
    const method = (endpoint as Record<string, unknown>).method;
    const path = (endpoint as Record<string, unknown>).path;
    if (typeof method !== "string" || !/^[A-Z*]+$/.test(method)) {
      return { ok: false, reason: "outside-http", detail: "an endpoint names no HTTP method" };
    }
    if (typeof path !== "string" || !path.startsWith("/")) {
      return { ok: false, reason: "outside-http", detail: "an endpoint names no request path" };
    }
  }
  const evidence = record.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, reason: "missing-evidence", detail: "the finding carries no evidence" };
  }
  for (const entry of evidence) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, reason: "missing-evidence", detail: "an evidence entry is not an object" };
    }
    const item = entry as Record<string, unknown>;
    const path = typeof item.path === "string" ? item.path : "";
    const text = context.sources.get(path);
    if (text === undefined) {
      return {
        ok: false,
        reason: "missing-evidence",
        detail: `${path.length === 0 ? "an evidence entry" : path} is not an audited source file`,
      };
    }
    const span = typeof item.lines === "string" ? lineSpan(item.lines) : undefined;
    if (span === undefined) {
      return { ok: false, reason: "missing-evidence", detail: `${path} names no line range` };
    }
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    if (quote.length === 0) {
      return { ok: false, reason: "missing-evidence", detail: `${path} carries an empty quote` };
    }
    const lines = text.split(/\r?\n/);
    const [start, end] = span;
    if (end > lines.length) {
      return {
        ok: false,
        reason: "missing-evidence",
        detail: `${path}:${start}-${end} runs past the file`,
      };
    }
    if (!lines.slice(start - 1, end).join("\n").includes(quote)) {
      return {
        ok: false,
        reason: "missing-evidence",
        detail: `the quote at ${path}:${start}-${end} is not copied from those lines`,
      };
    }
  }
  const proposed = typeof record.proposedChange === "string" ? record.proposedChange.trim() : "";
  if (proposed.length === 0) {
    return {
      ok: false,
      reason: "missing-citation",
      detail: "the finding carries no proposed change",
    };
  }
  const criteria = record.acceptanceCriteria;
  if (
    !Array.isArray(criteria) ||
    criteria.length === 0 ||
    !criteria.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    return {
      ok: false,
      reason: "missing-citation",
      detail: "the finding carries no acceptance criteria",
    };
  }
  return { ok: true, rule };
}

/** Reads the answer the peer wrote. A missing or malformed answer has none. */
export function readFindings(directory: string): FindingsAnswer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(findingsPath(directory), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.findings)) return undefined;
  const findings: FindingDecision[] = [];
  for (const entry of record.findings) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (candidate.decision !== "filed" && candidate.decision !== "skipped") continue;
    findings.push({
      title: typeof candidate.title === "string" ? candidate.title : "",
      ruleId: typeof candidate.ruleId === "string" ? candidate.ruleId : "",
      level: typeof candidate.level === "string" ? candidate.level : "",
      chapter: typeof candidate.chapter === "string" ? candidate.chapter : "",
      directive: typeof candidate.directive === "string" ? candidate.directive : "",
      endpoints: Array.isArray(candidate.endpoints)
        ? (candidate.endpoints as FindingEndpoint[])
        : [],
      evidence: Array.isArray(candidate.evidence) ? (candidate.evidence as FindingEvidence[]) : [],
      proposedChange:
        typeof candidate.proposedChange === "string" ? candidate.proposedChange : "",
      acceptanceCriteria: Array.isArray(candidate.acceptanceCriteria)
        ? (candidate.acceptanceCriteria as string[])
        : [],
      decision: candidate.decision,
      ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
      ...(typeof candidate.issueNumber === "number" && Number.isInteger(candidate.issueNumber)
        ? { issueNumber: candidate.issueNumber }
        : {}),
      ...(typeof candidate.issueUrl === "string" ? { issueUrl: candidate.issueUrl } : {}),
    });
  }
  return { version: 1, findings };
}
