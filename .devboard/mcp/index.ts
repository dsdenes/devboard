import { readHarnessVersion } from "../server/version";
import { MCP_TOOL_NAMES, toolDefinition, toolListPayload } from "./catalog";
import { resolveContext, type McpContext } from "./context";
import { redactSecrets } from "../lib/secret-redaction";
import { callTool } from "./tools";
import { recordToolInvocation } from "./invocations";

/**
 * The Devboard stdio MCP server.
 *
 * Only JSON-RPC messages reach stdout; diagnostics go to stderr. The server
 * answers initialize, tools/list, and tools/call, exits cleanly on stdin EOF,
 * and starts no HTTP listener.
 */

export const SERVER_NAME = "devboard";
export const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface StdioOptions {
  context?: McpContext;
  input?: AsyncIterable<Uint8Array>;
  output?: { write(text: string): unknown };
  diagnostics?: { write(text: string): unknown };
}

type Json = Record<string, unknown>;

function response(id: unknown, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function failure(id: unknown, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;
}

function toolText(value: unknown, environment: Record<string, string | undefined>): string {
  return redactSecrets(JSON.stringify(value, null, 2), environment);
}

async function handle(
  line: string,
  context: McpContext,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, -32700, "Parse error");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failure(null, -32600, "Invalid Request");
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id;
  const notification = id === undefined;
  const method = request.method;
  if (typeof method !== "string") {
    return notification ? undefined : failure(id, -32600, "Invalid Request");
  }

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return undefined;
  }

  if (method === "initialize") {
    const params =
      typeof request.params === "object" && request.params !== null
        ? (request.params as Json)
        : {};
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === "string" && requested.length > 0 ? requested : PROTOCOL_VERSION;
    return response(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: SERVER_NAME,
        version: readHarnessVersion(context.harnessDir) ?? "0.0.0",
      },
    });
  }

  if (method === "ping") {
    return notification ? undefined : response(id, {});
  }

  if (method === "tools/list") {
    return response(id, toolListPayload());
  }

  if (method === "tools/call") {
    const params =
      typeof request.params === "object" && request.params !== null
        ? (request.params as Json)
        : {};
    if (typeof params.name === "string" && toolDefinition(params.name) !== undefined) {
      // Statistics are diagnostics: a tool call never fails because its
      // counter could not be written.
      try {
        recordToolInvocation(context.stateDir, context.repoDir, params.name);
      } catch {
        // Ignore: the tool result is decided below.
      }
    }
    const result = await callTool(context, params.name, params.arguments);
    if (result.error !== undefined) {
      return response(id, {
        content: [{ type: "text", text: toolText({ error: result.error }, context.environment) }],
        isError: true,
      });
    }
    return response(id, {
      content: [{ type: "text", text: toolText(result.value, context.environment) }],
    });
  }

  return notification ? undefined : failure(id, -32601, `Method not found: ${method}`);
}

/** The whole stdio loop; returns at stdin EOF. */
export async function startStdio(options: StdioOptions = {}): Promise<void> {
  const context = options.context ?? resolveContext();
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
      const reply = await handle(line, context);
      if (reply !== undefined) output.write(reply);
    }
    if (final) {
      const line = buffer.trim();
      buffer = "";
      if (line.length > 0) {
        const reply = await handle(line, context);
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
      `${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** Tool names in catalog order, for a lightweight diagnostics line. */
export function toolNames(): readonly string[] {
  return MCP_TOOL_NAMES;
}

if (import.meta.main) {
  await startStdio();
}
