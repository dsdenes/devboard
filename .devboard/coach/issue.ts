import type { AgentSession } from "../lib/agent-sessions";
import { COACH_SESSION_EXCERPT_MAX, sessionExcerpt } from "../lib/agent-sessions";
import type { CoachFinding } from "./findings";
import { FINDING_LINE_MAX } from "./findings";

/**
 * The filed artifact for one finding: one title line, one body with exactly
 * four level-two sections, and the recurrence comment. The proposal and the
 * acceptance criteria come from the finalizer; this module never invents them.
 * Nothing here performs I/O; the delivery module sends the bytes.
 */

export const ISSUE_BODY_MAX_BYTES = 64 * 1024;
export const ISSUE_TITLE_MAX = 80;

export interface CoachEvidence {
  window: { start: string; end: string };
  sessions: Map<string, AgentSession>;
  /** Journal scopes that contributed, with their newest normalised excerpt. */
  scopes: Map<string, string>;
  repoDir: string;
}

export interface CoachEvidenceInput {
  finding: CoachFinding;
  evidence: CoachEvidence;
}

export interface CoachIssueInput extends CoachEvidenceInput {
  /** The finalizer's proposal and criteria; never generated here. */
  recommendation: { proposal: string; acceptance: string[] };
}

/** `[coach] <category>: <line>`, one line, never longer than 80 characters. */
export function coachTitle(finding: CoachFinding): string {
  const title = `[coach] ${finding.category}: ${finding.line.replace(/\s+/g, " ").trim()}`;
  if (title.length <= ISSUE_TITLE_MAX) return title;
  return `${title.slice(0, ISSUE_TITLE_MAX - 1).trimEnd()}…`;
}

/** Escapes a line that would otherwise open a new Markdown section. */
function safeQuoteLine(line: string): string {
  return line.replace(/^(#{1,6})(\s)/, "\\$1$2");
}

function sessionLines(session: AgentSession, excerpt: string): string[] {
  return [
    `- Session \`${session.id}\``,
    `  - Start: ${session.startedAt}`,
    `  - CWD: \`${session.relativeCwd}\``,
    `  - Tokens: input ${session.usage.input}, output ${session.usage.output}, ` +
      `cache read ${session.usage.cacheRead}, cache write ${session.usage.cacheWrite}, ` +
      `total ${session.usage.totalTokens}`,
    `  - Cost: ${session.cost}`,
    ...(excerpt.length === 0
      ? []
      : ["", "```text", ...excerpt.split("\n").map(safeQuoteLine), "```"]),
  ];
}

function scopeLines(scope: string, excerpt: string): string[] {
  return [
    `- Scope \`${scope}\``,
    ...(excerpt.length === 0
      ? []
      : ["", "```text", ...excerpt.split("\n").map(safeQuoteLine), "```"]),
  ];
}

interface BodyParts {
  finding: string[];
  evidence: string[];
  proposal: string[];
  acceptance: string[];
}

function parts(input: CoachIssueInput, excerptLimit: number): BodyParts {
  const { finding, evidence, recommendation } = input;
  const findingLines = [
    `- Fingerprint: \`${finding.fingerprint}\``,
    `- Category: \`${finding.category}\``,
    `- Count: ${finding.count}`,
    `- First occurrence: ${finding.firstAt}`,
    `- Last occurrence: ${finding.lastAt}`,
    `- Window: ${evidence.window.start} .. ${evidence.window.end}`,
  ];
  const evidenceLines: string[] = [];
  for (const id of finding.sessions) {
    const session = evidence.sessions.get(id);
    if (session === undefined) {
      evidenceLines.push(`- Session \`${id}\` (transcript unavailable)`);
      continue;
    }
    const excerpt =
      excerptLimit <= 0
        ? ""
        : sessionExcerpt(session, evidence.repoDir).slice(0, excerptLimit);
    evidenceLines.push(...sessionLines(session, excerpt));
  }
  for (const scope of finding.scopes) {
    const excerpt = evidence.scopes.get(scope) ?? "";
    evidenceLines.push(...scopeLines(scope, excerpt.slice(0, excerptLimit)));
  }
  if (evidenceLines.length === 0) evidenceLines.push("No contributing evidence remains.");
  return {
    finding: findingLines,
    evidence: evidenceLines,
    proposal: recommendation.proposal
      .split("\n")
      .map((line) => safeQuoteLine(line.trimEnd())),
    acceptance: recommendation.acceptance.map((criterion) => {
      const single = criterion.replace(/\s+/g, " ").trim();
      return safeQuoteLine(single.startsWith("- [ ]") ? single : `- [ ] ${single}`);
    }),
  };
}

function render(partsToRender: BodyParts): string {
  return [
    "## Finding",
    "",
    ...partsToRender.finding,
    "",
    "## Evidence",
    "",
    ...partsToRender.evidence,
    "",
    "## Proposed change",
    "",
    ...partsToRender.proposal,
    "",
    "## Acceptance criteria",
    "",
    ...partsToRender.acceptance,
    "",
  ].join("\n");
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The issue body. Four level-two sections appear exactly once; each session's
 * excerpt is at most 2,000 characters, and the whole body stays under 64 KiB.
 */
export function coachBody(input: CoachIssueInput): string {
  let limit = COACH_SESSION_EXCERPT_MAX;
  for (;;) {
    const body = render(parts(input, limit));
    if (bytes(body) <= ISSUE_BODY_MAX_BYTES || limit === 0) {
      return bytes(body) <= ISSUE_BODY_MAX_BYTES
        ? body
        : `${body.slice(0, ISSUE_BODY_MAX_BYTES - 1)}…`;
    }
    limit = Math.floor(limit / 2);
  }
}

/** A recurrence: the newest window and count, never a second filing. */
export function coachComment(input: CoachEvidenceInput): string {
  const body = [
    `Another occurrence of \`${input.finding.fingerprint}\` (\`${input.finding.category}\`).`,
    "",
    `- Count: ${input.finding.count}`,
    `- Last occurrence: ${input.finding.lastAt}`,
    `- Window: ${input.evidence.window.start} .. ${input.evidence.window.end}`,
    "",
    "```text",
    safeQuoteLine(input.finding.line.slice(0, FINDING_LINE_MAX)),
    "```",
    "",
    "Filed by the Devboard Coach from machine-checkable evidence; it never edits",
    "a prompt, a wrapper, or source.",
    "",
  ].join("\n");
  return bytes(body) <= ISSUE_BODY_MAX_BYTES
    ? body
    : `${body.slice(0, ISSUE_BODY_MAX_BYTES - 1)}…`;
}
