
/** One catalog tool as the page renders it: no schema, no `covers`. */
export interface McpToolRow {
  name: string;
  title: string;
  description: string;
  /** How many `tools/call` requests named this tool. */
  invocations: number;
}

/**
 * Invocation counts keyed by tool name. A missing or malformed entry is
 * dropped; an absent count renders as zero, never as a guessed number.
 */
export function invocationCounts(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const counts: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
      counts[name] = count;
    }
  }
  return counts;
}

/**
 * The catalog entries in the order the server sent them. A malformed entry is
 * dropped rather than rendered with a placeholder the catalog never declared.
 */
export function toolRows(
  value: unknown,
  invocations: unknown = {},
): McpToolRow[] {
  if (!Array.isArray(value)) return [];
  const counts = invocationCounts(invocations);
  const rows: McpToolRow[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const tool = entry as Record<string, unknown>;
    const { name, title, description } = tool;
    if (typeof name !== "string" || typeof title !== "string" || typeof description !== "string") {
      continue;
    }
    rows.push({ name, title, description, invocations: counts[name] ?? 0 });
  }
  return rows;
}

/**
 * Holds the catalog the dashboard server reads from its one MCP catalog. The
 * client never carries its own list: the scheduler reads it at the MCP tools
 * page's cadence, and the reply renders in arrival order.
 */
export class McpToolsStore {
  tools = $state<McpToolRow[]>([]);
  loaded = $state(false);

  handleEvent(message: Record<string, unknown>): void {
    if (message.type !== "mcpTools") return;
    this.tools = toolRows(message.tools, message.invocations);
    this.loaded = true;
  }
}

export const mcpTools = new McpToolsStore();
