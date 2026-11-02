import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
  /** How many unique candidates this cycle may file, after the caps. */
  filingRoom: number;
}

/** One record the dedup peer's MCP write tools append. */
export interface DedupRecord {
  fingerprint: string;
  action: "filed" | "duplicate";
  issue?: string;
  representative?: string;
  number?: number;
  url?: string;
  title?: string;
}

/** The agent turn. Tests and verification inject a deterministic replacement. */
export type Dedup = (request: DedupRequest, runDir: string) => Promise<string>;

function promptPath(): string {
  return resolve(import.meta.dir, "..", "prompts", "watchdog-dedup.md");
}

/** The complete prompt: the role, the repository, and the candidate set. */
export function dedupPrompt(request: DedupRequest): string {
  const template = readFileSync(promptPath(), "utf8");
  // Replacement functions insert the text literally. A string replacement
  // would interpret `$&`, `$'`, and `` $` `` inside a repository name or a
  // captured log line as substitution patterns and corrupt the prompt.
  return template
    .replace("{{repository}}", () => request.repository)
    .replace("{{filingRoom}}", () => String(request.filingRoom))
    .replace("{{candidates}}", () => JSON.stringify(request.candidates, null, 2));
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

/**
 * Reads the records the dedup peer's MCP write tools appended. A candidate
 * with neither a filing nor a duplicate record stays pending; there is no
 * coverage object to validate.
 */
export function readDedupRecords(runDir: string): DedupRecord[] {
  let text: string;
  try {
    text = readFileSync(join(runDir, "dedup-records.jsonl"), "utf8");
  } catch {
    return [];
  }
  const records: DedupRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record === undefined) continue;
    const fingerprint = record["fingerprint"];
    const action = record["action"];
    if (typeof fingerprint !== "string") continue;
    if (action !== "filed" && action !== "duplicate") continue;
    records.push({
      fingerprint,
      action,
      ...(typeof record["issue"] === "string" ? { issue: record["issue"] } : {}),
      ...(typeof record["representative"] === "string"
        ? { representative: record["representative"] }
        : {}),
      ...(typeof record["number"] === "number" ? { number: record["number"] } : {}),
      ...(typeof record["url"] === "string" ? { url: record["url"] } : {}),
      ...(typeof record["title"] === "string" ? { title: record["title"] } : {}),
    });
  }
  return records;
}

/** Counts of open issues each dedup turn read, oldest first. */
export function readDedupReads(runDir: string): number[] {
  let text: string;
  try {
    text = readFileSync(join(runDir, "dedup-reads.jsonl"), "utf8");
  } catch {
    return [];
  }
  const counts: number[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && "count" in parsed) {
        const count = parsed.count;
        if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
          counts.push(count);
        }
      }
    } catch {
      // A torn line is diagnostic.
    }
  }
  return counts;
}

/** Reads the verification stub and performs its tool writes deterministically. */
export function readDedupStub(path: string): Dedup {
  return async (request, runDir) => {
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
    const decisions = Array.isArray(document.decisions) ? document.decisions : [];
    const records: unknown[] = [];
    for (const entry of decisions) {
      const decision = asRecord(entry);
      if (decision === undefined) continue;
      if (decision.fingerprint === "*") {
        for (const candidate of request.candidates) {
          records.push({ ...decision, fingerprint: candidate.fingerprint });
        }
        continue;
      }
      records.push(decision);
    }
    mkdirSync(runDir, { recursive: true });
    if (records.length > 0) {
      appendFileSync(
        join(runDir, "dedup-records.jsonl"),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
    }
    return "";
  };
}

export interface DedupRunOptions {
  root: string;
  /** The dashboard STATE_DIR whose `providers/` holds the selected key. */
  stateDir: string;
  /** The cycle's run directory the write tools record into. */
  runDir: string;
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
  runDir: string;
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
    env: {
      ...run.binding.env,
      REPO_DIR: run.root,
      STATE_DIR: run.stateDir,
      DEVBOARD_DEDUP_RUN_DIR: run.runDir,
    },
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
        runDir: options.runDir,
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
