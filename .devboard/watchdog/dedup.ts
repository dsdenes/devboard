import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AcpConnection } from "../server/acp";
import { openCodePeerBindings } from "../server/providers/peers";
import type { AgentMcp } from "../server/providers/selection";
import type { LedgerInstance } from "./ledger";

/**
 * The watchdog's deduplication gate.
 *
 * Before a cycle files anything it sends the complete candidate set to one ACP
 * peer. The peer reads the repository's open issues itself through a read-only
 * MCP server and answers, for every candidate, whether it is unique or a
 * duplicate of an open issue or of another candidate. The cycle files only the
 * unique ones; a duplicate is suppressed silently. Any failure to obtain a
 * complete, valid answer fails the cycle closed: nothing is filed, nothing is
 * commented, and every candidate stays pending.
 */

export const DEDUP_TIMEOUT_MS = 240_000;

/**
 * A JSON file that answers every deduplication call. Tests and verification
 * scripts use it so no test starts a model; `"fingerprint": "*"` expands to
 * every candidate in the request.
 */
export const DEDUP_STUB_ENV = "DEVBOARD_WATCHDOG_DEDUP_STUB";

/** The MCP server name the peer's generated agent directory registers. */
export const DEDUP_MCP_SERVER = "devboard";

export interface DedupWindow {
  start: string;
  end: string;
}

export interface DedupCandidate {
  fingerprint: string;
  category: string;
  line: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  instances: LedgerInstance[];
  window: DedupWindow;
}

/** The complete request. It carries no issue list, snapshot, or summary. */
export interface DedupRequest {
  repository: string;
  window: DedupWindow;
  candidates: DedupCandidate[];
}

export interface ResolvedDedupDecision {
  fingerprint: string;
  decision: "unique" | "duplicate";
  /** The open issue the candidate duplicates, when the chain ends at one. */
  issue?: string;
  /** The candidate the agent named as the representative, when it named one. */
  representative?: string;
}

export interface DedupAnswer {
  /** Every open issue URL the agent reported reading. */
  openIssues: string[];
  openIssueNumbers: number[];
  decisions: Map<string, ResolvedDedupDecision>;
}

/** The agent turn. Tests and verification inject a deterministic replacement. */
export type Dedup = (request: DedupRequest) => Promise<string>;

function promptPath(): string {
  return resolve(import.meta.dir, "..", "prompts", "watchdog-dedup.md");
}

/** The complete prompt: the role, the repository, and the candidate set. */
export function dedupPrompt(request: DedupRequest): string {
  const template = readFileSync(promptPath(), "utf8");
  return template
    .replace("{{repository}}", request.repository)
    .replace("{{candidates}}", JSON.stringify(request.candidates, null, 2));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The issue number a URL names in `repository`, or undefined when the URL is
 * not that repository's issue. Host aliases (localhost, 127.0.0.1) do not
 * matter; the owner/name path and the number do.
 */
export function issueNumberInRepository(
  url: string,
  repository: string,
): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  const match = /\/issues\/(\d+)\/?$/.exec(parsed.pathname);
  if (match === null) return undefined;
  const number = Number(match[1]);
  const suffix = `/${repository}/issues/${number}`;
  const path = parsed.pathname.replace(/\/+$/, "");
  return path.endsWith(suffix) ? number : undefined;
}

interface RawDecision {
  action: "unique" | "duplicate";
  issue?: string;
  representative?: string;
}

/**
 * Parses and validates one agent answer. Every rejection is a fail-closed
 * reason: a missing candidate, an unknown candidate, an unknown action, a
 * matched issue that was not reported open, or a representative cycle.
 */
export function parseDedupAnswer(text: string, request: DedupRequest): DedupAnswer {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("the deduplication agent returned no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("the deduplication agent returned invalid JSON");
  }
  const document = asRecord(parsed);
  if (document === undefined) throw new Error("the deduplication agent returned no JSON object");

  const read = asRecord(document["read"]);
  const listed = read?.["open_issues"];
  if (!Array.isArray(listed)) {
    throw new Error("the deduplication agent reported no open-issue read");
  }
  const openIssues: string[] = [];
  const openIssueNumbers: number[] = [];
  for (const entry of listed) {
    if (typeof entry !== "string") {
      throw new Error("the deduplication agent reported a non-string open issue");
    }
    const number = issueNumberInRepository(entry, request.repository);
    if (number === undefined) {
      throw new Error(
        `the deduplication agent reported an open issue that is not in ` +
          `${request.repository}: ${entry}`,
      );
    }
    openIssues.push(entry);
    openIssueNumbers.push(number);
  }

  const raw = document["decisions"];
  if (!Array.isArray(raw)) {
    throw new Error("the deduplication agent returned no decisions array");
  }
  const known = new Set(request.candidates.map((candidate) => candidate.fingerprint));
  const openNumbers = new Set(openIssueNumbers);
  const decided = new Map<string, RawDecision>();
  for (const entry of raw) {
    const decision = asRecord(entry);
    const fingerprint = decision?.["fingerprint"];
    if (typeof fingerprint !== "string" || !known.has(fingerprint)) {
      throw new Error(
        `the deduplication agent decided an unknown candidate: ${String(fingerprint)}`,
      );
    }
    if (decided.has(fingerprint)) {
      throw new Error(`the deduplication agent decided ${fingerprint} twice`);
    }
    const action = decision?.["action"];
    if (action !== "unique" && action !== "duplicate") {
      throw new Error(`the deduplication agent returned an unknown action for ${fingerprint}`);
    }
    if (action === "unique") {
      decided.set(fingerprint, { action });
      continue;
    }
    const issue = decision?.["issue"];
    const representative = decision?.["representative"];
    const hasIssue = issue !== undefined;
    const hasRepresentative = representative !== undefined;
    if (hasIssue === hasRepresentative) {
      throw new Error(
        `the deduplication agent marked ${fingerprint} a duplicate without exactly one ` +
          "matched issue or representative",
      );
    }
    if (hasIssue) {
      if (typeof issue !== "string") {
        throw new Error(`the deduplication agent returned a non-string issue for ${fingerprint}`);
      }
      const number = issueNumberInRepository(issue, request.repository);
      if (number === undefined || !openNumbers.has(number)) {
        throw new Error(
          `the deduplication agent named an issue that is not open in ` +
            `${request.repository}: ${issue}`,
        );
      }
      decided.set(fingerprint, { action, issue });
      continue;
    }
    if (typeof representative !== "string" || !known.has(representative)) {
      throw new Error(
        `the deduplication agent named an unknown representative for ${fingerprint}: ` +
          String(representative),
      );
    }
    if (representative === fingerprint) {
      throw new Error(`the deduplication agent marked ${fingerprint} a duplicate of itself`);
    }
    decided.set(fingerprint, { action, representative });
  }
  for (const candidate of request.candidates) {
    if (!decided.has(candidate.fingerprint)) {
      throw new Error(`the deduplication agent did not decide ${candidate.fingerprint}`);
    }
  }

  // Resolve representative chains once. A cycle, or a chain longer than the
  // set, is an invalid answer, never a partial filing.
  const resolved = new Map<string, ResolvedDedupDecision>();
  for (const candidate of request.candidates) {
    const fingerprint = candidate.fingerprint;
    const first = decided.get(fingerprint);
    if (first === undefined) {
      throw new Error(`the deduplication agent did not decide ${fingerprint}`);
    }
    if (first.action === "unique") {
      resolved.set(fingerprint, { fingerprint, decision: "unique" });
      continue;
    }
    if (first.issue !== undefined) {
      resolved.set(fingerprint, { fingerprint, decision: "duplicate", issue: first.issue });
      continue;
    }
    let current = first.representative as string;
    const seen = new Set<string>([fingerprint, current]);
    let rootIssue: string | undefined;
    for (;;) {
      const decision = decided.get(current);
      if (decision === undefined) {
        throw new Error(`the deduplication agent did not decide ${current}`);
      }
      if (decision.action === "unique") break;
      if (decision.issue !== undefined) {
        rootIssue = decision.issue;
        break;
      }
      const next = decision.representative as string;
      if (seen.has(next)) {
        throw new Error(
          `the deduplication agent described a representative cycle through ${fingerprint}`,
        );
      }
      seen.add(next);
      if (seen.size > request.candidates.length + 1) {
        throw new Error(
          `the deduplication agent described a representative chain longer than the set ` +
            `through ${fingerprint}`,
        );
      }
      current = next;
    }
    resolved.set(fingerprint, {
      fingerprint,
      decision: "duplicate",
      representative: first.representative,
      ...(rootIssue === undefined ? {} : { issue: rootIssue }),
    });
  }
  return { openIssues, openIssueNumbers, decisions: resolved };
}

/** Reads a deterministic agent answer from a JSON file on every call. */
export function readDedupStub(path: string): Dedup {
  return async (request) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`the deduplication agent stub could not be read: ${detail}`);
    }
    const document = asRecord(parsed);
    if (document === undefined) throw new Error("the deduplication agent stub is not an object");
    if (typeof document.error === "string") throw new Error(document.error);
    const read = asRecord(document.read);
    const openIssues = Array.isArray(read?.open_issues) ? read.open_issues : [];
    const decisions = Array.isArray(document.decisions) ? document.decisions : [];
    const expanded: unknown[] = [];
    for (const entry of decisions) {
      const decision = asRecord(entry);
      if (decision === undefined) continue;
      if (decision.fingerprint === "*") {
        for (const candidate of request.candidates) {
          expanded.push({ ...decision, fingerprint: candidate.fingerprint });
        }
        continue;
      }
      expanded.push(decision);
    }
    return JSON.stringify({ read: { open_issues: openIssues }, decisions: expanded });
  };
}

export interface DedupRunOptions {
  root: string;
  /** The dashboard STATE_DIR whose `providers/` holds the selected key. */
  stateDir: string;
  environment?: Record<string, string | undefined>;
  command?: string;
  timeoutMs?: number;
}

/** The read-only MCP registration the deduplication peer's directory carries. */
export function dedupMcp(): AgentMcp {
  const wrapperName = "dedup-mcp.ts";
  return {
    wrapperName,
    servers: {
      [DEDUP_MCP_SERVER]: {
        type: "stdio",
        command: "sh",
        args: ["-c", `exec bun "$PI_CODING_AGENT_DIR/${wrapperName}"`],
      },
    },
    wrapper: [
      "// Generated by devboard for the watchdog deduplication peer. Do not edit.",
      `import { startDedupStdio } from ${JSON.stringify(join(import.meta.dir, "dedup-mcp.ts"))};`,
      "",
      "await startDedupStdio();",
      "",
    ].join("\n"),
  };
}

/** One peer turn. Returns the assistant text and always closes the process. */
async function runDedupPeer(run: {
  binding: { env: Record<string, string | undefined> };
  command: string;
  root: string;
  stateDir: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  let connection: AcpConnection | undefined;
  const aborted = Promise.withResolvers<never>();
  let text = "";
  let stderr = "";
  connection = new AcpConnection({
    command: run.command,
    cwd: run.root,
    env: { ...run.binding.env, REPO_DIR: run.root, STATE_DIR: run.stateDir },
    permissionPolicy: "read-only",
    onActivity: () => undefined,
    onText: (chunk) => {
      text += chunk;
    },
    onStderr: (chunk) => {
      stderr = (stderr + chunk).slice(-2_000);
    },
    onQuestion: () => {
      aborted.reject(new Error("the deduplication agent asked a question; refusing"));
      connection?.close();
    },
  });
  const timer = setTimeout(() => {
    aborted.reject(
      new Error(`the deduplication agent timed out after ${run.timeoutMs}ms`),
    );
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

/**
 * Runs one deduplication turn. Without a configured provider or a startable
 * peer it throws; the cycle then files nothing.
 */
export async function runDedupAgent(
  request: DedupRequest,
  options: DedupRunOptions,
): Promise<string> {
  const environment = options.environment ?? process.env;
  const peers = openCodePeerBindings(options.stateDir, environment, {
    subject: "the deduplication agent",
    agentSuffix: "watchdog-dedup",
    mcp: dedupMcp(),
  });
  if (!peers.ok) throw new Error(peers.reason);
  const command = options.command ?? environment.AGENT_COMMAND ?? "omp acp";
  const timeoutMs = options.timeoutMs ?? DEDUP_TIMEOUT_MS;
  const prompt = dedupPrompt(request);

  let text: string | undefined;
  let lastError: Error | undefined;
  for (let index = 0; index < peers.value.length; index += 1) {
    const binding = peers.value[index]!;
    try {
      const answer = await runDedupPeer({
        binding,
        command,
        root: options.root,
        stateDir: options.stateDir,
        prompt,
        timeoutMs,
      });
      if (/invalid credential|invalid api key|unauthorized|\b401\b/i.test(answer)) {
        const detail = answer
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        lastError = new Error(
          `the deduplication agent key was rejected: ${detail ?? "no diagnostic"}`,
        );
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
    throw lastError ?? new Error("the deduplication agent returned no answer");
  }
  return text;
}
