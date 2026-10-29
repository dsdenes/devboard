import { readFileSync } from "node:fs";
import { MCP_COVERS, MCP_TOOLS } from "../mcp/catalog";
import { TRIVIAL_COMMANDS, type CoachFinding } from "./findings";
import type { JevQuestions, JevRequest, JevResult } from "./jev";

/**
 * The decision gate. Every finding is turned into one typed Decisions request:
 * a bounded state object plus three propositions. The probabilities decide
 * file, reject, or review; nothing here generates text or trusts prose.
 *
 * The questions are deliberately narrow. A negative question asks whether the
 * capability already exists, and a high probability rejects. The two positive
 * questions ask about recurrence and about whether an issue changes behavior.
 */

export const GATE_QUESTIONS: JevQuestions = Object.freeze({
  existing_capability: {
    type: "noul",
    instructions:
      "The capability described by `finding.subject` is already provided by a tool " +
      "listed in `catalog.tools`, or by a command prefix listed in `catalog.covers`, " +
      "or by the plain inspection commands in `inspection_commands`.",
  },
  recurring_behavior: {
    type: "noul",
    instructions:
      "`finding.subject` describes a recurring behavior across the sessions, scopes, and " +
      "count in `finding`, rather than one incidental command, one transient failure, or " +
      "one environment problem.",
  },
  worth_filing: {
    type: "noul",
    instructions:
      "Filing one issue for `finding` would change what an implementer does next in this " +
      "repository, and the change is checkable from the evidence `finding` reports.",
  },
});

/** A proposition whose truth means the finding should not be filed. */
const NEGATIVE_QUESTIONS: Readonly<Record<string, true>> = Object.freeze({
  existing_capability: true,
});

export interface GateState {
  finding: {
    category: string;
    subject: string;
    line: string;
    count: number;
    sessions: number;
    scopes: number;
    first_at: string;
    last_at: string;
  };
  catalog: {
    tools: Array<{ name: string; title: string }>;
    covers: string[];
  };
  inspection_commands: string[];
  policy: string;
}

/** The exact state one Decisions request carries. It is well under 32 KiB. */
export function gateState(finding: CoachFinding): GateState {
  return {
    finding: {
      category: finding.category,
      subject: finding.subject,
      line: finding.line,
      count: finding.count,
      sessions: finding.sessions.length,
      scopes: finding.scopes.length,
      first_at: finding.firstAt,
      last_at: finding.lastAt,
    },
    catalog: {
      tools: MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title })),
      covers: [...MCP_COVERS],
    },
    inspection_commands: [...TRIVIAL_COMMANDS],
    policy:
      "One issue per finding. A useful tool replaces a recurring behavior with a stable " +
      "name a reader can use; a tool named after one command string is not useful. " +
      "Prefer a prompt instruction when no tool is needed.",
  };
}

export type GateOutcome = "accept" | "reject" | "review" | "error";

export interface GateVerdict {
  outcome: "accept" | "reject" | "review";
  /** The questions that failed the threshold, with their probabilities. */
  failed: string[];
}

/** Maps probabilities to a verdict with the two thresholds the settings carry. */
export function gateVerdict(
  answers: Record<string, number>,
  thresholds: { approveAt: number; rejectAt: number },
): GateVerdict {
  const positives = Object.entries(answers).filter(([name]) => NEGATIVE_QUESTIONS[name] !== true);
  const negatives = Object.entries(answers).filter(([name]) => NEGATIVE_QUESTIONS[name] === true);

  const weakPositive = positives.filter(([, probability]) => probability <= thresholds.rejectAt);
  const weakNegative = negatives.filter(([, probability]) => probability <= thresholds.rejectAt);
  const strongPositive = positives.filter(([, probability]) => probability >= thresholds.approveAt);
  const strongNegative = negatives.filter(([, probability]) => probability >= thresholds.approveAt);

  const failed = [
    ...weakPositive.map(([name, probability]) => `${name}=${probability.toFixed(2)}`),
    ...strongNegative.map(([name, probability]) => `${name}=${probability.toFixed(2)}`),
  ];
  if (failed.length > 0) return { outcome: "reject", failed };
  if (strongPositive.length === positives.length && weakNegative.length === negatives.length) {
    return { outcome: "accept", failed: [] };
  }
  return { outcome: "review", failed: [] };
}

export interface GateDecision {
  finding: CoachFinding;
  outcome: GateOutcome;
  probabilities: Record<string, number>;
  model: string;
  requestId?: string;
  costUsd?: number;
  reason?: string;
}

export interface GateRun {
  /** False when any call failed; the caller then files nothing this cycle. */
  ok: boolean;
  reason?: string;
  decisions: GateDecision[];
  costUsd: number;
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "no diagnostic"
  );
}

/**
 * One Decisions request per finding, in order, bounded concurrency. Any
 * failure marks the run failed and keeps every decision that did succeed so
 * the ledger records them; the coordinator files nothing.
 */
export async function runGate(options: {
  findings: CoachFinding[];
  model: string;
  approveAt: number;
  rejectAt: number;
  request: JevRequest;
  concurrency?: number;
}): Promise<GateRun> {
  const decisions: GateDecision[] = new Array(options.findings.length);
  let failure: string | undefined;
  let costUsd = 0;
  let next = 0;
  const workers = Math.max(1, Math.min(4, options.concurrency ?? 4));

  const one = async (finding: CoachFinding, index: number): Promise<void> => {
    let result: JevResult;
    try {
      result = await options.request({
        model: options.model,
        state: gateState(finding),
        questions: GATE_QUESTIONS,
      });
    } catch (error) {
      failure ??= describeError(error);
      decisions[index] = {
        finding,
        outcome: "error",
        probabilities: {},
        model: options.model,
        reason: describeError(error),
      };
      return;
    }
    const verdict = gateVerdict(result.answers, options);
    if (result.costUsd !== null) costUsd += result.costUsd;
    const decision: GateDecision = {
      finding,
      outcome: verdict.outcome,
      probabilities: result.answers,
      model: result.model ?? options.model,
      ...(result.requestId === null ? {} : { requestId: result.requestId }),
      ...(result.costUsd === null ? {} : { costUsd: result.costUsd }),
      ...(verdict.failed.length === 0
        ? {}
        : { reason: `threshold: ${verdict.failed.join(", ")}` }),
    };
    decisions[index] = decision;
  };

  await Promise.all(
    Array.from({ length: Math.min(workers, options.findings.length) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        const finding = options.findings[index];
        if (finding === undefined) return;
        await one(finding, index);
      }
    }),
  );

  return {
    ok: failure === undefined,
    ...(failure === undefined ? {} : { reason: failure }),
    decisions,
    costUsd,
  };
}

/** Verification seam: a JSON file that answers every Decisions request. */
export const DECISIONS_STUB_ENV = "DEVBOARD_COACH_DECISIONS_STUB";

export interface DecisionStub {
  answers: Record<string, number>;
  error?: string;
  requestId?: string;
  costUsd?: number;
}

/** Reads the stub file. A path that is set but unreadable throws. */
export function readDecisionStub(path: string): DecisionStub {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `the decisions stub could not be read: ${describeError(error)}`,
    );
  }
  const document = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
  const answers = document?.answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new Error("the decisions stub carries no answers object");
  }
  const probabilities: Record<string, number> = {};
  for (const [name, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`the decisions stub has an invalid probability for ${name}`);
    }
    probabilities[name] = value;
  }
  return {
    answers: probabilities,
    ...(typeof document?.error === "string" ? { error: document.error } : {}),
    ...(typeof document?.requestId === "string" ? { requestId: document.requestId } : {}),
    ...(typeof document?.costUsd === "number" && Number.isFinite(document.costUsd)
      ? { costUsd: document.costUsd }
      : {}),
  };
}

/** A stub request that validates exactly like the live one. */
export function stubRequest(stub: DecisionStub): JevRequest {
  return async (input) => {
    if (stub.error !== undefined) throw new Error(stub.error);
    const answers: Record<string, number> = {};
    for (const name of Object.keys(input.questions)) {
      const probability = stub.answers[name];
      if (probability === undefined) {
        throw new Error(`the decisions stub did not answer ${name}`);
      }
      answers[name] = probability;
    }
    return {
      answers,
      requestId: stub.requestId ?? "stub-decision",
      provider: "stub",
      model: input.model,
      costUsd: stub.costUsd ?? 0,
      inputTokens: null,
    };
  };
}
