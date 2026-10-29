import { readFileSync } from "node:fs";
import { boundBytes } from "../lib/text-budget";
import { AcpConnection } from "../server/acp";
import type { PeerBinding } from "../server/providers/selection";
import { MCP_COVERS, MCP_TOOLS } from "../mcp/catalog";
import type { CoachFamily } from "./families";
import type { CoachOpenIssue } from "./issue";
import { openCodePeers } from "./providers";
import type { CoachSettings } from "./settings";

/**
 * One ACP peer call per selected family. The peer is `AGENT_COMMAND` (default
 * `omp acp`) built from every enabled OpenCode Go subscription in the
 * operator's list order, pinned to the same model as every other agent;
 * permission and elicitation requests are denied. It receives one family's
 * evidence bundle and must answer one JSON object. Nothing here decides
 * whether a proposal is acceptable: the deterministic validator does that.
 */

export const SYNTHESIS_TIMEOUT_MS = 120_000;
export const SYNTHESIS_CONCURRENCY = 4;
export const SYNTHESIS_PROMPT_MAX_BYTES = 24 * 1024;

export interface ProposedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  covers: string[];
}

export interface ProposedPrompt {
  instruction: string;
  target: string;
}

export interface Proposal {
  family: string;
  action: "tool" | "prompt" | "none";
  tool?: ProposedTool;
  prompt?: ProposedPrompt;
  rationale: string;
  acceptance: string[];
}

export interface SynthesisResult {
  ok: boolean;
  model: string;
  durationMs: number;
  text?: string;
  reason?: string;
}

/** The coordinator injects a deterministic stub in tests. */
export type Synthesize = (family: CoachFamily, prompt: string) => Promise<SynthesisResult>;

export interface SynthesizeOptions {
  repoDir: string;
  stateDir: string;
  family: CoachFamily;
  prompt: string;
  environment?: Record<string, string | undefined>;
  command?: string;
  timeoutMs?: number;
  /** Test seam: replaces the ACP peer with a deterministic function. */
  run?: (prompt: string) => Promise<string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * The prompt. It carries one family's summary, fragments, at most five
 * excerpts, the catalog, every open Coach issue, and the configured allowlist.
 * Identical family and settings bytes produce an identical prompt.
 */
export function synthesisPrompt(input: {
  family: CoachFamily;
  settings: CoachSettings;
  openIssues: CoachOpenIssue[];
}): string {
  const family = input.family;
  let excerpts = family.excerpts.slice();
  let issues = input.openIssues.slice().sort((left, right) => left.number - right.number);
  const render = (): string =>
    [
      "You are the Devboard Coach synthesizer. You do not run tools. Answer with one",
      "JSON object and nothing else: no prose, no Markdown outside the JSON strings.",
      "",
      "Family:",
      json({
        key: family.key,
        kind: family.kind,
        calls: family.calls,
        sessions: family.sessions.length,
        days: family.days,
        first_at: family.firstAt,
        last_at: family.lastAt,
      }),
      "",
      "Fragments:",
      json(family.fragments),
      "",
      "Excerpts:",
      json(excerpts),
      "",
      "MCP catalog:",
      json({
        tools: MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title })),
        covers: [...MCP_COVERS],
      }),
      "",
      "Open Coach issues:",
      json(issues.map((issue) => ({ number: issue.number, title: issue.title, url: issue.url }))),
      "",
      "Command allowlist:",
      json(input.settings.allowlist),
      "",
      "Rules:",
      "- One issue for this family. Choose \"tool\" when a stable named capability removes",
      "  the recurrence, \"prompt\" when one instruction is enough, and \"none\" when the",
      "  family needs no change. Prefer the smaller change.",
      "- A tool is a capability, not a wrapper around this one command. Never reuse a name",
      "  from the catalog. `covers` entries are the normalized command prefixes the tool",
      "  replaces; at least one must match the family key.",
      "- A prompt names an instruction and a target under `.devboard/prompts/` or an agent id.",
      "- Acceptance criteria are checkable from the evidence.",
      "- When action is \"tool\", the family must be covered by the command allowlist.",
      "",
      "Shape:",
      '{"family":"<key>","action":"tool|prompt|none","tool":{"name":"^[a-z][a-z0-9_]{2,40}$",' +
        '"title":"...","description":"...","inputSchema":{"type":"object",' +
        '"additionalProperties":false,"properties":{}},"covers":["<key>"]},' +
        '"prompt":{"instruction":"...","target":".devboard/prompts/example.md"},' +
        '"rationale":"...","acceptance":["- [ ] ..."]}',
      "",
    ].join("\n");

  let text = render();
  while (Buffer.byteLength(text, "utf8") >= SYNTHESIS_PROMPT_MAX_BYTES) {
    if (excerpts.length > 0) {
      excerpts = excerpts.slice(0, -1);
    } else if (issues.length > 1) {
      issues = issues.slice(0, -1);
    } else {
      text = boundBytes(text, SYNTHESIS_PROMPT_MAX_BYTES - 1, "…").text;
      break;
    }
    text = render();
  }
  return text;
}

/** The exact top-level and nested key sets the contract allows. */
const PROPOSAL_KEYS: ReadonlySet<string> = new Set([
  "family",
  "action",
  "tool",
  "prompt",
  "rationale",
  "acceptance",
]);
const TOOL_KEYS: ReadonlySet<string> = new Set([
  "name",
  "title",
  "description",
  "inputSchema",
  "covers",
]);
const PROMPT_KEYS: ReadonlySet<string> = new Set(["instruction", "target"]);
const TOOL_NAME = /^[a-z][a-z0-9_]{2,40}$/;
const AGENT_TARGET = /^[a-z][a-z0-9-]{1,40}$/;

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function acceptanceOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return undefined;
  const lines: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    if (!entry.startsWith("- [ ] ") || entry.length < 7) return undefined;
    if (entry.length > 400) return undefined;
    lines.push(entry);
  }
  return lines;
}

function toolOf(value: unknown): ProposedTool | undefined {
  const tool = record(value);
  if (tool === undefined || !exactKeys(tool, TOOL_KEYS)) return undefined;
  const name = tool["name"];
  const title = tool["title"];
  const description = tool["description"];
  const inputSchema = record(tool["inputSchema"]);
  const covers = tool["covers"];
  if (typeof name !== "string" || !TOOL_NAME.test(name)) return undefined;
  if (typeof title !== "string" || title.length < 1 || title.length > 120) return undefined;
  if (
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > 600
  ) {
    return undefined;
  }
  if (inputSchema === undefined) return undefined;
  if (!Array.isArray(covers) || covers.length < 1 || covers.length > 12) return undefined;
  const entries: string[] = [];
  for (const entry of covers) {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 120) return undefined;
    entries.push(entry);
  }
  return {
    name,
    title,
    description,
    inputSchema,
    covers: entries,
  };
}

function promptOf(value: unknown): ProposedPrompt | undefined {
  const prompt = record(value);
  if (prompt === undefined || !exactKeys(prompt, PROMPT_KEYS)) return undefined;
  const instruction = prompt["instruction"];
  const target = prompt["target"];
  if (
    typeof instruction !== "string" ||
    instruction.length < 1 ||
    instruction.length > 1_200
  ) {
    return undefined;
  }
  if (typeof target !== "string" || target.length < 1 || target.length > 200) return undefined;
  if (!target.startsWith(".devboard/prompts/") && !AGENT_TARGET.test(target)) return undefined;
  return { instruction, target };
}

/**
 * Parses the peer's answer. The answer is one JSON object and nothing else;
 * any missing field, extra field, or wrong type throws.
 */
export function parseSynthesisAnswer(text: string, familyKey: string): Proposal {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("the synthesizer returned no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("the synthesizer returned invalid JSON");
  }
  const document = record(parsed);
  if (document === undefined) throw new Error("the synthesizer returned no JSON object");
  if (!exactKeys(document, PROPOSAL_KEYS)) {
    throw new Error("the synthesizer returned an unknown field");
  }
  const family = document["family"];
  const action = document["action"];
  const rationale = document["rationale"];
  if (family !== familyKey) {
    throw new Error(`the synthesizer answered for ${String(family)} instead of ${familyKey}`);
  }
  if (action !== "tool" && action !== "prompt" && action !== "none") {
    throw new Error("the synthesizer returned an unknown action");
  }
  if (typeof rationale !== "string" || rationale.length < 1 || rationale.length > 1_000) {
    throw new Error("the synthesizer returned no usable rationale");
  }
  const acceptance = acceptanceOf(document["acceptance"]);
  if (acceptance === undefined) {
    throw new Error("the synthesizer returned malformed acceptance criteria");
  }
  if (action === "tool") {
    if (document["prompt"] !== undefined) {
      throw new Error("a tool proposal must not carry a prompt");
    }
    const tool = toolOf(document["tool"]);
    if (tool === undefined) throw new Error("the synthesizer returned an invalid tool");
    return { family, action, tool, rationale, acceptance };
  }
  if (action === "prompt") {
    if (document["tool"] !== undefined) {
      throw new Error("a prompt proposal must not carry a tool");
    }
    const prompt = promptOf(document["prompt"]);
    if (prompt === undefined) throw new Error("the synthesizer returned an invalid prompt");
    return { family, action, prompt, rationale, acceptance };
  }
  if (document["tool"] !== undefined || document["prompt"] !== undefined) {
    throw new Error("a none proposal must not carry a tool or a prompt");
  }
  return { family, action, rationale, acceptance };
}

/** Verification seam: a JSON file that answers every synthesis call. */
export const SYNTHESIS_STUB_ENV = "DEVBOARD_COACH_SYNTHESIS_STUB";

interface SynthesisStub {
  families?: Record<string, unknown>;
  default?: unknown;
  error?: string;
}

function substitute(value: unknown, family: string): unknown {
  if (typeof value === "string") return value.split("{{family}}").join(family);
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, family));
  if (record(value) !== undefined) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = substitute(entry, family);
    }
    return result;
  }
  return value;
}

/** Reads the stub file and returns the peer replacement it describes. */
export function readSynthesisStub(
  path: string,
  family: string,
): (prompt: string) => Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`the synthesis stub could not be read: ${String(error)}`);
  }
  const document = record(parsed) as SynthesisStub | undefined;
  if (document === undefined) throw new Error("the synthesis stub is not an object");
  const answer =
    document.families?.[family] ??
    (document.families === undefined ? document.default : undefined);
  return async () => {
    if (typeof document.error === "string") throw new Error(document.error);
    if (answer === undefined) throw new Error("the synthesis stub has no answer for the family");
    return JSON.stringify(substitute(answer, family));
  };
}

/** Runs one family's synthesis peer. */
export async function synthesizeFamily(options: SynthesizeOptions): Promise<SynthesisResult> {
  const started = Date.now();
  if (options.run !== undefined) {
    try {
      return {
        ok: true,
        text: await options.run(options.prompt),
        model: "stub",
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        model: "stub",
        durationMs: Date.now() - started,
      };
    }
  }

  const environment = options.environment ?? process.env;
  const peers = openCodePeers(options.stateDir, environment);
  if (!peers.ok) {
    return { ok: false, reason: peers.reason, model: "", durationMs: 0 };
  }
  const command = options.command ?? environment.AGENT_COMMAND ?? "omp acp";
  let text: string | undefined;
  let lastError: Error | undefined;
  for (let index = 0; index < peers.value.length; index += 1) {
    const binding = peers.value[index]!;
    try {
      const answer = await runSynthesisPeer({
        binding,
        command,
        repoDir: options.repoDir,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs ?? SYNTHESIS_TIMEOUT_MS,
      });
      if (/invalid credential|invalid api key|unauthorized|\b401\b/i.test(answer)) {
        const detail = answer
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        lastError = new Error(`the synthesizer key was rejected: ${detail ?? "no diagnostic"}`);
        if (index < peers.value.length - 1) continue;
        throw lastError;
      }
      text = answer;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const rotate = /invalid credential|invalid api key|unauthorized|\b401\b/i.test(
        lastError.message,
      );
      if (!rotate || index === peers.value.length - 1) throw lastError;
    }
  }
  if (text === undefined) {
    return {
      ok: false,
      reason: lastError?.message ?? "the synthesizer peer returned no answer",
      model: peers.value[0]?.model ?? "",
      durationMs: Date.now() - started,
    };
  }
  return {
    ok: true,
    text,
    model: peers.value[0]?.model ?? "",
    durationMs: Date.now() - started,
  };
}

interface SynthesisPeerRun {
  binding: PeerBinding;
  command: string;
  repoDir: string;
  prompt: string;
  timeoutMs: number;
}

/** One peer turn. Returns the assistant text and always closes the process. */
async function runSynthesisPeer(run: SynthesisPeerRun): Promise<string> {
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
      aborted.reject(new Error("the synthesizer peer asked a question; refusing"));
      connection?.close();
    },
  });

  const timer = setTimeout(() => {
    aborted.reject(new Error(`the synthesizer peer timed out after ${run.timeoutMs}ms`));
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
