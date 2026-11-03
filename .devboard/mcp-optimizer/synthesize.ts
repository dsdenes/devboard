import { readFileSync } from "node:fs";
import { AcpConnection } from "../server/acp";
import type { PeerBinding } from "../server/providers/selection";
import { MCP_COVERS, MCP_TOOLS } from "../mcp/catalog";
import type { McpOptimizerFamily } from "./families";
import type { McpOptimizerOpenIssue } from "./issue";
import { familyTag } from "./issue";
import { openCodePeers } from "./providers";
import type { McpOptimizerSettings } from "./settings";

/**
 * One ACP peer call per selected family. The peer is `AGENT_COMMAND` (default
 * `omp acp`) built from every enabled OpenCode Go subscription in the
 * operator's list order, pinned to the same model as every other agent;
 * permission and elicitation requests are denied. It reads open MCP optimizer issues
 * through the MCP server and files at most one proposal itself, or records why
 * it filed nothing. There is no answer object and no deterministic proposal
 * validator.
 */

export const SYNTHESIS_TIMEOUT_MS = 120_000;
export const SYNTHESIS_CONCURRENCY = 4;
export const SYNTHESIS_PROMPT_MAX_BYTES = 24 * 1024;

export interface SynthesisResult {
  ok: boolean;
  model: string;
  durationMs: number;
  text?: string;
  reason?: string;
}

export interface SynthesisPaths {
  /** The MCP tool log for this family's issue-creation calls. */
  toolLogPath: string;
  /** The MCP skip log for this family's recorded no-proposal reason. */
  skipLogPath: string;
}

/** The coordinator injects a deterministic stub in tests. */
export type Synthesize = (family: McpOptimizerFamily, prompt: string, paths: SynthesisPaths) => Promise<SynthesisResult>;

export interface SynthesizeOptions {
  repoDir: string;
  stateDir: string;
  family: McpOptimizerFamily;
  prompt: string;
  environment?: Record<string, string | undefined>;
  command?: string;
  timeoutMs?: number;
  toolLogPath?: string;
  skipLogPath?: string;
  /** Test seam: replaces the ACP peer with a deterministic function. */
  run?: (prompt: string) => Promise<string>;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const PROPOSAL_TOOL_RULES = [
  "- A tool proposal names a capability, not a wrapper around this one command. Never reuse a",
  "  name from the catalog. `covers` entries are the normalized command prefixes the tool",
  "  replaces; at least one must match the family key. The family must be covered by the",
  "  command allowlist; the body carries the exact allowlist entry to add.",
  "- A prompt proposal names one instruction and a target under `.devboard/prompts/` or an",
  "  agent id.",
];

interface PromptSections {
  family: string;
  fragments: string;
  excerpts: string;
  catalog: string;
  issues: string;
  allowlist: string;
  limits: string;
}

/** Every fixed line and dynamic section of the one synthesis prompt. */
function promptText(sections: PromptSections): string {
  return [
    "## Manifesto",
    "",
    "You are the Devboard MCP optimizer synthesizer for one family. Your goal is to remove the",
    "recurring friction this family evidences, and your observable result is at most one proposal",
    "issue filed through the Devboard MCP issue tool, or one recorded reason the family needs no",
    "issue.",
    "",
    "Read this family's evidence, read the open MCP optimizer issues yourself, then act. Never",
    "answer with a JSON document, fragment, diff, or summary.",
    "",
    "Family:",
    sections.family,
    "",
    "Fragments:",
    sections.fragments,
    "",
    "Excerpts:",
    sections.excerpts,
    "",
    "MCP catalog:",
    sections.catalog,
    "",
    "Open MCP optimizer issues:",
    sections.issues,
    "",
    "Command allowlist:",
    sections.allowlist,
    "",
    "Limits:",
    sections.limits,
    "",
    "Rules:",
    "- Read the open issues with `issues_list` and `issue_get`. A proposal duplicates an open",
    "  issue when that issue carries this family's tag or the same title. A duplicate files and",
    "  comments on nothing.",
    "- File at most one issue for this family, and only when `filingRoom` is greater than zero.",
    "- Prefer the smaller change: \"tool\" when a stable named capability removes the recurrence,",
    "  \"prompt\" when one instruction is enough.",
    ...PROPOSAL_TOOL_RULES,
    "- The issue title is exactly `[mcp-optimizer] <family key>` for a tool proposal or",
    "  `[mcp-optimizer] prompt: <family key>` for a prompt proposal.",
    "- The issue body has exactly these level-two sections in order: `## Family`,",
    "  `## Evidence`, `## Proposed tool` or `## Proposed prompt`, `## Acceptance`, `## Rationale`.",
    "  `## Family` states the key, kind, call and session counts, first and last timestamps,",
    "  and the family tag. `## Evidence` carries the fragments and the excerpts. `## Acceptance`",
    "  carries one to five `- [ ]` criteria checkable from the evidence.",
    "- File with `issue_create` and no labels. Its returned number and URL are the record.",
    "- When the family needs no change, a duplicate exists, a cap leaves no room, or filing",
    "  fails, call `mcp_optimizer_proposal_skip` with the family key and one reason sentence.",
    "  Call either `issue_create` or `mcp_optimizer_proposal_skip` for this family, never both.",
    "",
  ].join("\n");
}

/** The catalog JSON every prompt carries: name/title pairs in catalog order. */
function catalogJson(): string {
  return json({
    tools: MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title })),
    covers: [...MCP_COVERS],
  });
}

type FamilyFragmentList = McpOptimizerFamily["fragments"];
type FamilyFragment = FamilyFragmentList[number];

/** The marker a cut fragment string ends with, so the cut is visible to the peer. */
const FRAGMENT_CUT_MARKER = "…";

/** The first `units` UTF-16 code units of `text`, never splitting a surrogate pair. */
function prefixOf(text: string, units: number): string {
  if (units >= text.length) return text;
  const code = text.charCodeAt(units - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? units - 1 : units);
}

/**
 * One fragment whose text is cut to the longest prefix that still fits beside
 * `kept`, or `undefined` when not even the marker fits.
 */
function cutFragmentJson(
  fragment: FamilyFragment,
  kept: FamilyFragmentList,
  allowance: number,
): string | undefined {
  const render = (units: number): string | undefined => {
    const text = json([...kept, { text: `${prefixOf(fragment.text, units)}${FRAGMENT_CUT_MARKER}`, count: fragment.count }]);
    return Buffer.byteLength(text, "utf8") <= allowance ? text : undefined;
  };
  let best = render(0);
  let low = 0;
  let high = fragment.text.length;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = render(mid);
    if (candidate === undefined) {
      high = mid - 1;
    } else {
      best = candidate;
      low = mid + 1;
    }
  }
  return best;
}

/**
 * The fragments section, bounded to `allowance` UTF-8 bytes. The highest-count
 * fragments survive; the least frequent are dropped first, and the one that
 * straddles the budget keeps the prefix of its text that fits, closed with a
 * marker, so the section stays a JSON array instead of a document cut
 * mid-token. When not even `[]` fits, the fixed sections alone exceed the
 * budget and nothing inside this value can bring the prompt under it.
 */
function boundedFragmentsJson(fragments: FamilyFragmentList, allowance: number): string {
  const ordered = fragments
    .slice()
    .sort((left, right) => right.count - left.count || left.text.localeCompare(right.text));
  const kept: FamilyFragmentList = [];
  let text = json(kept);
  for (const fragment of ordered) {
    const next = json([...kept, fragment]);
    if (Buffer.byteLength(next, "utf8") > allowance) {
      return cutFragmentJson(fragment, kept, allowance) ?? text;
    }
    kept.push(fragment);
    text = next;
  }
  return text;
}

/** The three fields of one open issue the prompt and the template publish. */
function issueRows(issues: McpOptimizerOpenIssue[]): Array<{
  number: number;
  title: string;
  url: string;
}> {
  return issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    url: issue.url,
  }));
}

/** The open issues one synthesis call sees. */
export function mcpOptimizerIssues(issues: McpOptimizerOpenIssue[]): McpOptimizerOpenIssue[] {
  return issues.filter(
    (issue) => issue.title.startsWith("[mcp-optimizer]") || issue.body.includes("family:"),
  );
}

/** What the template states when no successful open-issue read is available. */
export const MCP_OPTIMIZER_PROMPT_ISSUES_UNAVAILABLE =
  "Open MCP optimizer issues could not be read.";

const FAMILY_PLACEHOLDER = "<family>";
const FRAGMENTS_PLACEHOLDER = "<fragments>";
const EXCERPTS_PLACEHOLDER = "<excerpts>";
const FILING_ROOM_PLACEHOLDER = "<filingRoom>";

/**
 * The prompt. It carries one family's summary, fragments, at most five
 * excerpts, the catalog, every open MCP optimizer issue, the configured allowlist, and
 * the cycle's filing room. Identical family and settings bytes produce an
 * identical prompt.
 */
export function synthesisPrompt(input: {
  family: McpOptimizerFamily;
  settings: McpOptimizerSettings;
  openIssues: McpOptimizerOpenIssue[];
  filingRoom: number;
}): string {
  const family = input.family;
  let excerpts = family.excerpts.slice();
  let issues = input.openIssues.slice().sort((left, right) => left.number - right.number);
  const render = (fragmentText: string): string =>
    promptText({
      family: json({
        key: family.key,
        kind: family.kind,
        calls: family.calls,
        sessions: family.sessions.length,
        days: family.days,
        first_at: family.firstAt,
        last_at: family.lastAt,
        tag: `family:${familyTag(family.key)}`,
      }),
      fragments: fragmentText,
      excerpts: json(excerpts),
      catalog: catalogJson(),
      issues: json(issueRows(issues)),
      allowlist: json(input.settings.allowlist),
      limits: json({
        maxIssuesPerCycle: input.settings.maxIssuesPerCycle,
        maxPerHour: input.settings.maxPerHour,
        maxPending: input.settings.maxPending,
        filingRoom: input.filingRoom,
      }),
    });

  const fragments = json(family.fragments);
  let text = render(fragments);
  while (Buffer.byteLength(text, "utf8") >= SYNTHESIS_PROMPT_MAX_BYTES) {
    if (excerpts.length > 0) {
      excerpts = excerpts.slice(0, -1);
    } else if (issues.length > 1) {
      issues = issues.slice(0, -1);
    } else {
      // Evidence shrinks; the filing contract never does. The fragments value is
      // the last unbounded section, so the budget is spent there: the section is
      // cut inside its own JSON string and closed, and every heading that follows
      // it, `Rules:` first among them, survives with a parseable JSON section.
      const allowance =
        SYNTHESIS_PROMPT_MAX_BYTES - 1 - Buffer.byteLength(render(""), "utf8");
      text = render(boundedFragmentsJson(family.fragments, allowance));
      break;
    }
    text = render(fragments);
  }
  return text;
}

/**
 * The one read-only template the MCP optimizer page shows: the same fixed lines and
 * live catalog, allowlist, limits, and open-issue sections a synthesis call
 * sends, with the per-family sections named as placeholders. It reads nothing,
 * writes nothing, and starts nothing.
 */
export function mcpOptimizerPromptTemplate(input: {
  settings: McpOptimizerSettings;
  openIssues: McpOptimizerOpenIssue[] | null;
}): string {
  const issues =
    input.openIssues === null
      ? MCP_OPTIMIZER_PROMPT_ISSUES_UNAVAILABLE
      : json(issueRows(mcpOptimizerIssues(input.openIssues).sort((left, right) => left.number - right.number)));
  return promptText({
    family: FAMILY_PLACEHOLDER,
    fragments: FRAGMENTS_PLACEHOLDER,
    excerpts: EXCERPTS_PLACEHOLDER,
    catalog: catalogJson(),
    issues,
    allowlist: json(input.settings.allowlist),
    limits: json({
      maxIssuesPerCycle: input.settings.maxIssuesPerCycle,
      maxPerHour: input.settings.maxPerHour,
      maxPending: input.settings.maxPending,
      filingRoom: FILING_ROOM_PLACEHOLDER,
    }),
  });
}

/** Verification seam: a JSON file that answers every synthesis call. */
export const SYNTHESIS_STUB_ENV = "DEVBOARD_MCP_OPTIMIZER_SYNTHESIS_STUB";

interface SynthesisStub {
  families?: Record<string, unknown>;
  default?: unknown;
  error?: string;
}

interface StubAnswer {
  action?: unknown;
  title?: unknown;
  body?: unknown;
  reason?: unknown;
  number?: unknown;
  url?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

/**
 * Reads the verification stub and returns a peer replacement that performs the
 * same tool writes a real peer would: one issue record or one skip record.
 */
export function readSynthesisStub(
  path: string,
  family: string,
  paths: SynthesisPaths,
): (prompt: string) => Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`the synthesis stub could not be read: ${String(error)}`);
  }
  const document = record(parsed) as SynthesisStub | undefined;
  if (document === undefined) throw new Error("the synthesis stub is not an object");
  const answer = document.families?.[family] ?? document.default;
  return async () => {
    if (typeof document.error === "string") throw new Error(document.error);
    if (answer === undefined) throw new Error("the synthesis stub has no answer for the family");
    const entry = substitute(answer, family) as StubAnswer;
    if (entry.action === "tool" || entry.action === "prompt") {
      const title = typeof entry.title === "string" ? entry.title : `[mcp-optimizer] ${family}`;
      const body = typeof entry.body === "string" ? entry.body : "";
      const number =
        typeof entry.number === "number" && Number.isInteger(entry.number) ? entry.number : 1;
      const url =
        typeof entry.url === "string"
          ? entry.url
          : `https://forge.test/fixture/fixture/issues/${number}`;
      await Bun.write(
        paths.toolLogPath,
        `${JSON.stringify({
          tool: "issue_create",
          at: new Date().toISOString(),
          ok: true,
          value: { number, url, title, labels: [] },
        })}\n`,
      );
      return "";
    }
    const reason =
      typeof entry.reason === "string" && entry.reason.length > 0
        ? entry.reason
        : "the family needs no proposal";
    await Bun.write(
      paths.skipLogPath,
      `${JSON.stringify({
        tool: "mcp_optimizer_proposal_skip",
        at: new Date().toISOString(),
        ok: true,
        value: { family, status: "skipped", reason },
      })}\n`,
    );
    return "";
  };
}

/**
 * A peer run whose own ACP error frame or stderr names a credential rejection.
 * Only this failure rotates to the next subscription; the assistant text of a
 * completed turn never does, because it may legitimately quote a journal 401.
 */
class SynthesisCredentialError extends Error {}

const CREDENTIAL_REJECTION = /invalid credential|invalid api key|unauthorized|\b401\b/i;

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
        toolLogPath: options.toolLogPath,
        skipLogPath: options.skipLogPath,
      });
      text = answer;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!(error instanceof SynthesisCredentialError) || index === peers.value.length - 1) {
        throw lastError;
      }
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
  toolLogPath?: string;
  skipLogPath?: string;
}

/** One peer turn. Returns the assistant text and always closes the process. */
async function runSynthesisPeer(run: SynthesisPeerRun): Promise<string> {
  let connection: AcpConnection | undefined;
  const aborted = Promise.withResolvers<never>();
  let text = "";
  let stderr = "";
  const extra: Record<string, string> = {};
  if (run.toolLogPath !== undefined) extra.DEVBOARD_TOOL_LOG = run.toolLogPath;
  if (run.skipLogPath !== undefined) extra.DEVBOARD_MCP_OPTIMIZER_SKIP_LOG = run.skipLogPath;
  connection = new AcpConnection({
    command: run.command,
    cwd: run.repoDir,
    env: { ...run.binding.env, ...extra },
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
    const diagnostic = detail === undefined ? message : `${message} (${detail})`;
    if (CREDENTIAL_REJECTION.test(diagnostic)) {
      const first =
        diagnostic
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? "no diagnostic";
      throw new SynthesisCredentialError(`the synthesizer key was rejected: ${first}`, {
        cause: error,
      });
    }
    throw new Error(diagnostic, { cause: error });
  } finally {
    clearTimeout(timer);
    connection.close();
  }
  return text;
}
