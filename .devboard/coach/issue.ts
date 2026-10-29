import type { AgentSession } from "../lib/agent-sessions";
import { COACH_SESSION_EXCERPT_MAX, sessionExcerpt } from "../lib/agent-sessions";
import type { CoachFinding } from "./findings";
import { FINDING_LINE_MAX } from "./findings";

/**
 * The filed artifact for one finding: one title line, one body with exactly
 * four level-two sections, and the recurrence comment. Nothing here performs
 * I/O; the delivery module sends the bytes.
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

export interface CoachIssueInput {
  finding: CoachFinding;
  evidence: CoachEvidence;
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

function firstToolLine(finding: CoachFinding): string {
  const newline = finding.subject.indexOf("\n");
  return newline < 0 ? finding.subject : finding.subject.slice(0, newline);
}

interface Proposal {
  statement: string[];
  acceptance: string[];
}

function proposal(finding: CoachFinding): Proposal {
  const name = finding.fingerprint;
  switch (finding.category) {
    case "tool-failure": {
      const tool = firstToolLine(finding) || "the failing tool";
      return {
        statement: [
          `Add a prompt guardrail named \`precheck-${name}\` to the implementation`,
          `prompt: before calling \`${tool}\`, restate the target and the expected`,
          "result in one line and stop when the result contradicts it.",
          "",
          `Add a failure-avoidance helper MCP tool \`devboard_failure_hint\` with`,
          "inputs `{ tool: string, message: string }` that returns the recorded",
          "first-line fingerprints and the guardrail for that tool.",
        ],
        acceptance: [
          `- [ ] Repeating the \`${tool}\` call with the recorded signature either succeeds or stops before the second identical failure.`,
          "- [ ] `devboard_failure_hint` is listed by `tools/list` with the documented inputs.",
          "- [ ] The guardrail appears exactly once in the implementation prompt.",
        ],
      };
    }
    case "retry-loop":
      return {
        statement: [
          `Add a prompt guardrail named \`stop-retry-${name}\` to the implementation`,
          "prompt: after the second error for one tool-call identity, stop repeating",
          "it and re-plan or ask the operator.",
          "",
          "Add a failure-avoidance helper MCP tool `devboard_retry_guard` with",
          "inputs `{ tool: string, signature: string, session: string }` that",
          "returns the recorded retry count and the stop threshold.",
        ],
        acceptance: [
          "- [ ] A session repeating the recorded identity stops by its third call.",
          "- [ ] `devboard_retry_guard` is listed by `tools/list` with the documented inputs.",
          "- [ ] The guardrail appears exactly once in the implementation prompt.",
        ],
      };
    case "repeat-question":
      return {
        statement: [
          `Add a prompt guardrail named \`ask-once-${name}\` to the implementation`,
          "prompt: answer a question the run already asked from the recorded answer",
          "instead of asking it again.",
          "",
          "Add a deterministic MCP tool `devboard_question_lookup` with inputs",
          "`{ scope: string, question?: string }` that returns the recorded",
          "question and answer for one run or lane scope.",
        ],
        acceptance: [
          "- [ ] The same normalized question is not asked in two scopes again.",
          "- [ ] `devboard_question_lookup` is listed by `tools/list` with the documented inputs.",
          "- [ ] The guardrail appears exactly once in the implementation prompt.",
        ],
      };
    case "run-failure":
      return {
        statement: [
          `Add a prompt guardrail named \`fail-fast-${name}\` to the implementation`,
          "prompt: when the recorded stderr line appears, stop the turn and report",
          "the failing command instead of retrying it.",
          "",
          "Add a failure-avoidance helper MCP tool `verification_run` with input",
          "`{ check: \"test\" | \"check\" | \"build\" | \"typecheck\" | \"verify:<name>\" }`",
          "that returns the bounded output and exit code.",
        ],
        acceptance: [
          "- [ ] The recorded stderr line no longer ends two separate runs.",
          "- [ ] `verification_run` is listed by `tools/list` and accepts the documented check.",
          "- [ ] The guardrail appears exactly once in the implementation prompt.",
        ],
      };
    case "tool-gap":
      return {
        statement: [
          `Add MCP tool \`devboard_run_${name}\` with inputs`,
          "`{ command: string, cwd?: string, timeoutMs?: number }` that runs the",
          "documented command deterministically, bounds its output at 16 KiB, and",
          "returns the exit code and output. It is a deterministic tool, not an LLM",
          "step.",
        ],
        acceptance: [
          `- [ ] \`devboard_run_${name}\` is listed by \`tools/list\` with the documented inputs.`,
          "- [ ] The recorded command produces the same output through the tool.",
          "- [ ] The implementation prompt names the tool instead of the shell command.",
        ],
      };
  }
}

interface BodyParts {
  finding: string[];
  evidence: string[];
  proposal: string[];
  acceptance: string[];
}

function parts(finding: CoachFinding, evidence: CoachEvidence, excerptLimit: number): BodyParts {
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
  const change = proposal(finding);
  return {
    finding: findingLines,
    evidence: evidenceLines,
    proposal: change.statement,
    acceptance: change.acceptance,
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
    const body = render(parts(input.finding, input.evidence, limit));
    if (bytes(body) <= ISSUE_BODY_MAX_BYTES || limit === 0) {
      return bytes(body) <= ISSUE_BODY_MAX_BYTES
        ? body
        : `${body.slice(0, ISSUE_BODY_MAX_BYTES - 1)}…`;
    }
    limit = Math.floor(limit / 2);
  }
}

/** A recurrence: the newest window and count, never a second filing. */
export function coachComment(input: CoachIssueInput): string {
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
