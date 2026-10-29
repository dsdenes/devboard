import { connection } from "./connection.svelte";
import type { WorkspaceTab } from "./layout.svelte";

/** One catalog tool as the page renders it: no schema, no `covers`. */
export interface McpToolRow {
  name: string;
  title: string;
  description: string;
}

/** One navigation entry the Devboard mode's sidebar renders. */
export interface DevboardSidebarEntry {
  id: string;
  label: string;
  command: string;
}

/** The mode's only page; the sidebar entry and the palette command open it. */
export const DEVBOARD_TAB: WorkspaceTab = {
  id: "tools",
  kind: "mcp-tools",
  resourceId: "tools",
  title: "MCP tools",
};

export const DEVBOARD_SIDEBAR: readonly DevboardSidebarEntry[] = [
  { id: "tools", label: "MCP tools", command: "devboard.tab.tools" },
];

/**
 * The catalog entries in the order the server sent them. A malformed entry is
 * dropped rather than rendered with a placeholder the catalog never declared.
 */
export function toolRows(value: unknown): McpToolRow[] {
  if (!Array.isArray(value)) return [];
  const rows: McpToolRow[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const tool = entry as Record<string, unknown>;
    const { name, title, description } = tool;
    if (typeof name !== "string" || typeof title !== "string" || typeof description !== "string") {
      continue;
    }
    rows.push({ name, title, description });
  }
  return rows;
}

/**
 * Holds the catalog the dashboard server reads from its one MCP catalog. The
 * client never carries its own list: it asks once per connection and renders
 * the reply in arrival order.
 */
export class DevboardStore {
  tools = $state<McpToolRow[]>([]);
  loaded = $state(false);

  request(): void {
    connection.send({ type: "getMcpTools" });
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type !== "mcpTools") return;
    this.tools = toolRows(message.tools);
    this.loaded = true;
  }
}

export const devboard = new DevboardStore();
