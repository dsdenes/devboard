/**
 * The OpenRouter Decisions transport. Jev answers typed `noul` questions with
 * a probability each; it never returns prose. This module owns the request
 * shape, the response validation, and the timeout, and nothing else: the
 * questions and the thresholds belong to the gate.
 *
 * The endpoint is alpha, so every field is validated before it reaches the
 * ledger. A malformed answer is an error, never a silent approval.
 */

export const DECISIONS_URL_ENV = "DEVBOARD_OPENROUTER_DECISIONS_URL";
export const DEFAULT_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_TIMEOUT_MS = 15_000;

export interface JevNoulQuestion {
  type: "noul";
  /** One proposition about `state`, complete on its own. */
  instructions: string;
  criteria?: { true: string; false: string };
}

export type JevQuestions = Record<string, JevNoulQuestion>;

export interface JevResult {
  /** One probability per question name, in the order asked. */
  answers: Record<string, number>;
  requestId: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
}

export interface JevRequestInput {
  model: string;
  state: unknown;
  questions: JevQuestions;
}

export type JevRequest = (input: JevRequestInput) => Promise<JevResult>;

export interface JevClientOptions {
  apiKey: string;
  url?: string;
  timeoutMs?: number;
  /** Test seam. */
  fetch?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads `answers.<name>.noul` for every asked question. Any other answer type,
 * a missing key, or a probability outside 0..1 throws.
 */
export function parseDecisionsDocument(document: unknown, questions: JevQuestions): JevResult {
  const root = record(document);
  if (root === undefined) throw new Error("Decisions API returned no document");
  const answers = record(root.answers);
  if (answers === undefined) throw new Error("Decisions API returned no answers");

  const probabilities: Record<string, number> = {};
  const missing: string[] = [];
  for (const name of Object.keys(questions)) {
    const answer = record(answers[name]);
    const probability = answer?.type === "noul" ? answer.noul : undefined;
    if (
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      missing.push(name);
      continue;
    }
    probabilities[name] = probability;
  }
  if (missing.length > 0) {
    throw new Error(`Decisions API did not answer: ${missing.join(", ")}`);
  }

  const usage = record(root.usage);
  const requestId = root.id;
  const provider = root.provider;
  const model = root.model;
  return {
    answers: probabilities,
    requestId: typeof requestId === "string" && requestId.length > 0 ? requestId : null,
    provider: typeof provider === "string" && provider.length > 0 ? provider : null,
    model: typeof model === "string" && model.length > 0 ? model : null,
    costUsd:
      typeof usage?.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : null,
    inputTokens:
      typeof usage?.input_tokens === "number" && Number.isFinite(usage.input_tokens)
        ? usage.input_tokens
        : null,
  };
}

/** The live Decisions client. It throws on any non-2xx, timeout, or bad answer. */
export function createJevClient(options: JevClientOptions): JevRequest {
  const url = options.url ?? DEFAULT_DECISIONS_URL;
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;

  return async (input) => {
    let text: string;
    let status: number;
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          state: input.state,
          questions: input.questions,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error))
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      throw new Error(`Decisions request failed: ${detail ?? "no diagnostic"}`, { cause: error });
    }
    if (status < 200 || status >= 300) {
      const detail = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      throw new Error(`Decisions API ${status}: ${detail ?? "no diagnostic"}`);
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw new Error("Decisions API returned invalid JSON");
    }
    return parseDecisionsDocument(document, input.questions);
  };
}
