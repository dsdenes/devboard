import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One stdio MCP server in the shape an ACP `session/new` request accepts. The
 * transport takes `env` as name/value pairs rather than a map.
 */
export interface SessionMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * The MCP servers one ACP peer's session must be opened with.
 *
 * An ACP session disables the agent's on-disk MCP discovery: the client owns
 * the definitions, so the registration the peer's generated agent directory
 * carries in `mcp.json` reaches the session only through `session/new`. A
 * session opened with an empty list has no Devboard tools at all, and every
 * lifecycle prompt that reads or closes an issue fails at its first call.
 */
export function sessionMcpServers(
  environment: Record<string, string | undefined> | undefined,
): SessionMcpServer[] {
  const agentDir = environment?.PI_CODING_AGENT_DIR;
  if (agentDir === undefined || agentDir.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
  } catch {
    return [];
  }
  const servers = asRecord(asRecord(parsed)?.mcpServers);
  if (servers === undefined) return [];
  const resolved: SessionMcpServer[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const entry = asRecord(value);
    if (entry === undefined || entry.enabled === false) continue;
    const command = entry.command;
    if (typeof command !== "string" || command.length === 0) continue;
    const configured = asRecord(entry.env) ?? {};
    resolved.push({
      name,
      command,
      args: Array.isArray(entry.args)
        ? entry.args.filter((arg): arg is string => typeof arg === "string")
        : [],
      env: Object.entries(configured)
        .filter((pair): pair is [string, string] => typeof pair[1] === "string")
        .map(([key, envValue]) => ({ name: key, value: envValue })),
    });
  }
  return resolved;
}
