import { readFileSync } from "node:fs";
import { AcpConnection } from "../server/acp";
import { MCP_COVERS, MCP_TOOLS } from "../mcp/catalog";
import type { CoachFinding } from "./findings";
import { openCodePeers } from "./providers";
import type { PeerBinding } from "../server/providers/selection";

/**
 * The finalizer. One ACP peer call per cycle over the findings the gate
 * accepted: it deduplicates survivors, rewrites the proposal, and returns the
 * acceptance criteria. It is the only place Coach spends model prose, and it
 * is fail-closed: a missing answer, an invalid decision, a refused permission,
 * a timeout, or an unavailable provider files nothing.
 */

export const FINALIZER_TIMEOUT_MS = 180_000;
export const FINALIZER_MAX_PROPOSAL = 4_000;
export const FINALIZER_MAX_ACCEPTANCE = 8;
export const FINALIZER_MAX_CRITERION = 400;

export interface Recommendation {
  action: "file" | "drop";
  proposal: string;
  acceptance: string[];
  /** For a drop: the survivor fingerprint that covers the same behavior. */
  duplicateOf?: string;
}

export interface FinalizeResult {
  recommendations: Map<string, Recommendation>;
  /** The peer's model, from the provider binding. */
  model: string;
  durationMs: number;
}

/** One finalizer call. The coordinator injects a stub in tests. */
export type Finalize = (survivors: CoachFinding[]) => Promise<FinalizeResult>;

export interface FinalizeOptions {
  repoDir: string;
  stateDir: string;
  survivors: CoachFinding[];
  environment?: Record<string, string | undefined>;
  command?: string;
  timeoutMs?: number;
  /** Test seam: replaces the ACP peer with a deterministic function. */
  run?: (prompt: string, survivors: CoachFinding[]) => Promise<string>;
}

function bounded(value: string, max: number): string {
  const single = value.trim();
  return single.length <= max ? single : `${single.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The prompt. It names the only two allowed actions, forbids prose, and states
 * the naming rule the generator used to violate: never one tool per command.
 */
export function finalizerPrompt(survivors: CoachFinding[]): string {
  const findings = survivors.map((finding) => ({
    fingerprint: finding.fingerprint,
    category: finding.category,
    subject: bounded(finding.subject, 600),
    line: bounded(finding.line, 200),
    count: finding.count,
    sessions: finding.sessions.length,
    scopes: finding.scopes.length,
    first_at: finding.firstAt,
    last_at: finding.lastAt,
  }));
  const catalog = {
    tools: MCP_TOOLS.map((tool) => tool.name),
    covers: [...MCP_COVERS],
  };
  return [
    "You are the Devboard Coach finalizer. You do not run tools. Answer with one JSON",
    "object and nothing else: no prose, no Markdown outside the JSON string values.",
    "",
    "Findings that passed the deterministic gate:",
    JSON.stringify(findings),
    "",
    "Existing MCP catalog:",
    JSON.stringify(catalog),
    "",
    "Rules:",
    "- One issue per recurring behavior. When two findings describe the same behavior,",
    "  keep the lowest fingerprint with action \"file\" and mark the other \"drop\" with",
    "  \"duplicate_of\" set to that fingerprint.",
    "- \"proposal\" is Markdown of at most 1,200 characters. It names a stable capability",
    "  or an existing catalog tool. Never invent a tool named after a fingerprint or",
    "  after one command string; a tool that wraps a single shell command is not useful.",
    "- Prefer the smaller change: a prompt instruction before a new tool.",
    "- \"acceptance\" is 1 to 5 lines, each starting with \"- [ ] \", and each checkable",
    "  from the evidence the finding reports.",
    "- Use every fingerprint exactly once. Never invent a fingerprint.",
    "",
    "Shape:",
    '{"decisions":[{"fingerprint":"...","action":"file","proposal":"...",' +
      '"acceptance":["- [ ] ..."]},{"fingerprint":"...","action":"drop",' +
      '"duplicate_of":"..."}]}',
    "",
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Parses the peer's answer; any deviation from the shape throws. */
export function parseFinalizerAnswer(
  text: string,
  survivors: CoachFinding[],
): Map<string, Recommendation> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the finalizer returned no JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("the finalizer returned invalid JSON");
  }
  const decisions = record(parsed)?.["decisions"];
  if (!Array.isArray(decisions)) throw new Error("the finalizer returned no decisions array");

  const known = new Set(survivors.map((finding) => finding.fingerprint));
  const recommendations = new Map<string, Recommendation>();
  for (const entry of decisions) {
    const decision = record(entry);
    const fingerprint = decision?.["fingerprint"];
    if (typeof fingerprint !== "string" || !known.has(fingerprint)) {
      throw new Error("the finalizer named a fingerprint that is not a survivor");
    }
    if (recommendations.has(fingerprint)) {
      throw new Error(`the finalizer decided ${fingerprint} twice`);
    }
    const action = decision?.["action"];
    if (action !== "file" && action !== "drop") {
      throw new Error(`the finalizer returned an unknown action for ${fingerprint}`);
    }
    const duplicateOf = decision?.["duplicate_of"];
    if (action === "drop" && duplicateOf !== undefined) {
      if (typeof duplicateOf !== "string" || !known.has(duplicateOf)) {
        throw new Error(`the finalizer named an unknown duplicate for ${fingerprint}`);
      }
      if (duplicateOf === fingerprint) {
        throw new Error(`the finalizer marked ${fingerprint} a duplicate of itself`);
      }
    }
    if (action === "drop") {
      recommendations.set(fingerprint, {
        action,
        proposal: "",
        acceptance: [],
        ...(typeof duplicateOf === "string" ? { duplicateOf } : {}),
      });
      continue;
    }
    const proposal = decision?.["proposal"];
    if (typeof proposal !== "string" || proposal.trim().length === 0) {
      throw new Error(`the finalizer filed ${fingerprint} with no proposal`);
    }
    const acceptance = decision?.["acceptance"];
    if (!Array.isArray(acceptance) || acceptance.length === 0) {
      throw new Error(`the finalizer filed ${fingerprint} with no acceptance criteria`);
    }
    const criteria = acceptance.map((criterion) => {
      if (typeof criterion !== "string" || criterion.trim().length === 0) {
        throw new Error(`the finalizer filed ${fingerprint} with an empty criterion`);
      }
      return bounded(criterion, FINALIZER_MAX_CRITERION);
    });
    if (criteria.length > FINALIZER_MAX_ACCEPTANCE) {
      throw new Error(`the finalizer filed ${fingerprint} with too many criteria`);
    }
    recommendations.set(fingerprint, {
      action,
      proposal: bounded(proposal, FINALIZER_MAX_PROPOSAL),
      acceptance: criteria,
    });
  }
  for (const fingerprint of known) {
    if (!recommendations.has(fingerprint)) {
      throw new Error(`the finalizer did not decide ${fingerprint}`);
    }
  }
  for (const [fingerprint, recommendation] of recommendations) {
    if (recommendation.action !== "drop" || recommendation.duplicateOf === undefined) continue;
    if (recommendations.get(recommendation.duplicateOf)?.action !== "file") {
      throw new Error(
        `the finalizer marked ${fingerprint} a duplicate of a finding it did not file`,
      );
    }
  }
  return recommendations;
}

/** Verification seam: a JSON file that answers every finalizer call. */
export const FINALIZER_STUB_ENV = "DEVBOARD_COACH_FINALIZER_STUB";

export interface FinalizerStub {
  proposal: string;
  acceptance: string[];
  action?: "file" | "drop";
  error?: string;
}

/** Reads the stub file and returns the peer replacement it describes. */
export function readFinalizerStub(
  path: string,
): (prompt: string, survivors: CoachFinding[]) => Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`the finalizer stub could not be read: ${String(error)}`);
  }
  const document = record(parsed);
  if (document === undefined) throw new Error("the finalizer stub is not an object");
  const proposal = document["proposal"];
  const acceptance = document["acceptance"];
  if (typeof proposal !== "string" || proposal.trim().length === 0) {
    throw new Error("the finalizer stub carries no proposal");
  }
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    throw new Error("the finalizer stub carries no acceptance criteria");
  }
  const criteria = acceptance.filter((entry): entry is string => typeof entry === "string");
  if (criteria.length !== acceptance.length) {
    throw new Error("the finalizer stub carries a non-string acceptance criterion");
  }
  const action = document["action"] === "drop" ? "drop" : "file";
  const error = typeof document["error"] === "string" ? document["error"] : undefined;
  return async (_prompt, survivors) => {
    if (error !== undefined) throw new Error(error);
    return JSON.stringify({
      decisions: survivors.map((finding) => ({
        fingerprint: finding.fingerprint,
        action,
        ...(action === "file" ? { proposal, acceptance: criteria } : {}),
      })),
    });
  };
}

/**
 * Runs one finalizer peer. Without `options.run`, the harness selects an
 * OpenCode Go binding and starts `AGENT_COMMAND` with permissions denied.
 */
export async function finalizeFindings(options: FinalizeOptions): Promise<FinalizeResult> {
  const { survivors } = options;
  if (survivors.length === 0) return { recommendations: new Map(), model: "", durationMs: 0 };
  const prompt = finalizerPrompt(survivors);
  const started = Date.now();
  if (options.run !== undefined) {
    const recommendations = parseFinalizerAnswer(
      await options.run(prompt, survivors),
      survivors,
    );
    return { recommendations, model: "stub", durationMs: Date.now() - started };
  }

  const environment = options.environment ?? process.env;
  const peers = openCodePeers(options.stateDir, environment);
  if (!peers.ok) throw new Error(peers.reason);

  const command = options.command ?? environment.AGENT_COMMAND ?? "omp acp";
  let text: string | undefined;
  let lastError: Error | undefined;
  for (let index = 0; index < peers.value.length; index += 1) {
    const binding = peers.value[index]!;
    try {
      const answer = await runFinalizerPeer({
        binding,
        command,
        repoDir: options.repoDir,
        prompt,
        timeoutMs: options.timeoutMs ?? FINALIZER_TIMEOUT_MS,
      });
      if (/invalid credential|invalid api key|unauthorized|\b401\b/i.test(answer)) {
        const detail = answer
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        lastError = new Error(`the finalizer key was rejected: ${detail ?? "no diagnostic"}`);
        if (index < peers.value.length - 1) continue;
        throw lastError;
      }
      text = answer;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const message = lastError.message;
      const rotate = /invalid credential|invalid api key|unauthorized|\b401\b/i.test(message);
      if (!rotate || index === peers.value.length - 1) throw lastError;
    }
  }
  if (text === undefined) throw lastError ?? new Error("the finalizer peer returned no answer");

  const recommendations = parseFinalizerAnswer(text, survivors);
  return { recommendations, model: peers.value[0]!.model, durationMs: Date.now() - started };
}

interface FinalizerPeerRun {
  binding: PeerBinding;
  command: string;
  repoDir: string;
  prompt: string;
  timeoutMs: number;
}

/** One peer turn. Returns the assistant text and always closes the process. */
async function runFinalizerPeer(run: FinalizerPeerRun): Promise<string> {
  let connection: AcpConnection | undefined;
  const aborted = Promise.withResolvers<never>();
  let text = "";
  let stderr = "";
  connection = new AcpConnection({
    command: run.command,
    cwd: run.repoDir,
    env: run.binding.env,
    permissionPolicy: "deny",
    onActivity: () => undefined,
    onText: (chunk) => {
      text += chunk;
    },
    onStderr: (chunk) => {
      stderr = (stderr + chunk).slice(-2_000);
    },
    onQuestion: () => {
      aborted.reject(new Error("the finalizer peer asked a question; refusing"));
      connection?.close();
    },
  });

  const timer = setTimeout(() => {
    aborted.reject(new Error(`the finalizer peer timed out after ${run.timeoutMs}ms`));
    connection?.close();
  }, run.timeoutMs);
  try {
    await Promise.race([connection.run(run.prompt), aborted.promise]);
  } catch (error) {
    const detail = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-1)[0];
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(detail === undefined ? message : `${message} (${detail})`, { cause: error });
  } finally {
    clearTimeout(timer);
    connection.close();
  }
  return text;
}
