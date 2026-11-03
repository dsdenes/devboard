import { createForgeIssues, ForgeIssueError, type ForgeIssues } from "../lib/forge-issues";
import { redactSecrets } from "../lib/secret-redaction";
import { join } from "node:path";
import type { McpContext } from "../mcp/context";
import { createIssue } from "../mcp/issues";
import {
  recordWatchdogDuplicate,
  recordWatchdogFiling,
  recordWatchdogRead,
} from "../mcp/watchdog";

/**
 * The watchdog deduplication peer's MCP server.
 *
 * It exposes the repository's open issues for reading, one issue-creation tool
 * for the candidates the turn finds unique, and one disposition tool for the
 * candidates it finds duplicate. It has no close, label, edit, control, or
 * verification tool. The peer starts it through its generated agent directory,
 * so the deduplication pass can read the tracker and perform only those two
 * writes.
 *
 * Only JSON-RPC messages reach stdout; diagnostics go to stderr.
 */

export const DEDUP_SERVER_NAME = "devboard-dedup";
export const DEDUP_PROTOCOL_VERSION = "2024-11-05";

export const DEDUP_TOOLS = [
  {
    name: "issues_list",
    title: "List open issues",
    description:
      "Lists the repository's open issues with number, title, state, labels, URL, " +
      "and creation time. Closed issues are never listed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: { type: "string", enum: ["open"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "issue_get",
    title: "Read one issue",
    description: "Returns one issue's title, body, labels, state, and URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { number: { type: "integer", minimum: 1 } },
      required: ["number"],
    },
  },
  {
    name: "issue_create",
    title: "File one candidate issue",
    description:
      "Creates the unique candidate's implementation issue with the candidate's " +
      "fingerprint, title, full Markdown body, and labels. The created issue's " +
      "number and URL are recorded for the cycle and returned.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fingerprint: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        labels: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      required: ["fingerprint", "title", "body"],
    },
  },
  {
    name: "watchdog_duplicate_record",
    title: "Record a duplicate candidate",
    description:
      "Records that one candidate duplicates an open issue or another candidate " +
      "in this set. A duplicate creates and comments on nothing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fingerprint: { type: "string" },
        issue: { type: "string" },
        representative: { type: "string" },
      },
      required: ["fingerprint"],
    },
  },
] as const;

export interface DedupStdioOptions {
  /** The repository whose forge the tools read; defaults to `REPO_DIR` or cwd. */
  repoDir?: string;
  environment?: Record<string, string | undefined>;
  input?: AsyncIterable<Uint8Array>;
  output?: { write(text: string): unknown };
  diagnostics?: { write(text: string): unknown };
  /** Test seam: the forge issue store a request must use. */
  issues?: ForgeIssues;
}

type Json = Record<string, unknown>;

function response(id: unknown, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function failure(id: unknown, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;
}

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function toolText(value: unknown, environment: Record<string, string | undefined>): string {
  return redactSecrets(JSON.stringify(value, null, 2), environment);
}

async function callDedupTool(
  issues: ForgeIssues,
  context: McpContext,
  name: string,
  args: Json,
): Promise<{ value: unknown; error?: string }> {
  if (name === "issues_list") {
    if (args.state !== undefined && args.state !== "open") {
      return { value: undefined, error: "issues_list reads only open issues" };
    }
    const limit = args.limit === undefined ? 200 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return { value: undefined, error: "issues_list limit must be 1..200" };
    }
    const issues_ = await issues.list("open", limit);
    recordWatchdogRead(context, issues_.length);
    return { value: { issues: issues_ } };
  }
  if (name === "issue_get") {
    const number = Number(args.number);
    if (!Number.isInteger(number) || number < 1) {
      return { value: undefined, error: "issue_get needs a positive issue number" };
    }
    const issue = await issues.get(number);
    if (issue.state !== "open") {
      return { value: undefined, error: `issue ${number} is not open` };
    }
    return { value: issue };
  }
  if (name === "issue_create") {
    // The fingerprint is the cycle's ledger key, so it is validated before the
    // forge mutation: a malformed call files nothing instead of leaving an
    // issue no record owns.
    const fingerprint = args.fingerprint;
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      return { value: undefined, error: "issue_create needs the candidate fingerprint" };
    }
    try {
      const created = await createIssue(context, {
        title: args.title,
        body: args.body,
        labels: args.labels,
      });
      try {
        recordWatchdogFiling(context, {
          fingerprint,
          number: created.number,
          url: created.url,
          title: created.title,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          value: undefined,
          error:
            `issue #${created.number} (${created.url}) was created, but its filing ` +
            `record could not be appended: ${detail}. The tracker holds an issue this ` +
            `cycle did not record.`,
        };
      }
      return { value: { ...created, fingerprint } };
    } catch (error) {
      return {
        value: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (name === "watchdog_duplicate_record") {
    try {
      return {
        value: recordWatchdogDuplicate(context, {
          fingerprint: args.fingerprint,
          issue: args.issue,
          representative: args.representative,
        }),
      };
    } catch (error) {
      return {
        value: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { value: undefined, error: `Unknown tool: ${name}` };
}

async function handle(
  line: string,
  issues: () => ForgeIssues,
  context: McpContext,
  environment: Record<string, string | undefined>,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, -32700, "Parse error");
  }
  const request = record(parsed);
  if (request === undefined) return failure(null, -32600, "Invalid Request");
  const id = request.id;
  const notification = id === undefined;
  const method = request.method;
  if (typeof method !== "string") {
    return notification ? undefined : failure(id, -32600, "Invalid Request");
  }
  if (method.startsWith("notifications/")) return undefined;
  if (method === "initialize") {
    return response(id, {
      protocolVersion: DEDUP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: DEDUP_SERVER_NAME, version: "1" },
    });
  }
  if (method === "ping") return notification ? undefined : response(id, {});
  if (method === "tools/list") {
    return response(id, { tools: DEDUP_TOOLS.map((tool) => ({ ...tool })) });
  }
  if (method === "tools/call") {
    const params = record(request.params) ?? {};
    const name = params.name;
    if (typeof name !== "string" || !DEDUP_TOOLS.some((tool) => tool.name === name)) {
      return response(id, {
        content: [{ type: "text", text: toolText({ error: `Unknown tool: ${String(name)}` }, environment) }],
        isError: true,
      });
    }
    const args = record(params.arguments) ?? {};
    try {
      const result = await callDedupTool(issues(), context, name, args);
      if (result.error !== undefined) {
        return response(id, {
          content: [{ type: "text", text: toolText({ error: result.error }, environment) }],
          isError: true,
        });
      }
      return response(id, {
        content: [{ type: "text", text: toolText(result.value, environment) }],
      });
    } catch (error) {
      const detail =
        error instanceof ForgeIssueError || error instanceof Error
          ? error.message
          : String(error);
      return response(id, {
        content: [{ type: "text", text: toolText({ error: detail }, environment) }],
        isError: true,
      });
    }
  }
  return notification ? undefined : failure(id, -32601, `Method not found: ${method}`);
}

/** The whole stdio loop; returns at stdin EOF. */
export async function startDedupStdio(options: DedupStdioOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const repoDir = options.repoDir ?? environment.REPO_DIR ?? process.cwd();
  let issues = options.issues;
  const store = (): ForgeIssues => {
    if (issues === undefined) issues = createForgeIssues({ repoDir, environment });
    return issues;
  };
  const context: McpContext = {
    repoDir,
    harnessDir: join(repoDir, ".devboard"),
    stateDir: environment.STATE_DIR ?? join(repoDir, ".devboard", ".tmp"),
    environment,
    ...(options.issues === undefined ? {} : { forgeIssues: options.issues }),
  };
  const input = options.input ?? Bun.stdin.stream();
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? {
    write: (text: string) => process.stderr.write(text),
  };
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = async (text: string, final: boolean): Promise<void> => {
    buffer += text;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const reply = await handle(line, store, context, environment);
      if (reply !== undefined) output.write(reply);
    }
    if (final) {
      const line = buffer.trim();
      buffer = "";
      if (line.length > 0) {
        const reply = await handle(line, store, context, environment);
        if (reply !== undefined) output.write(reply);
      }
    }
  };
  try {
    for await (const chunk of input) {
      await drain(decoder.decode(chunk, { stream: true }), false);
    }
    await drain(decoder.decode(), true);
  } catch (error) {
    diagnostics.write(
      `${DEDUP_SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

if (import.meta.main) {
  await startDedupStdio();
}
