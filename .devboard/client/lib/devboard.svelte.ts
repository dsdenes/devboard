import { connection } from "./connection.svelte";
import type { WorkspaceTab } from "./layout.svelte";

/** One catalog tool as the page renders it: no schema, no `covers`. */
export interface McpToolRow {
  name: string;
  title: string;
  description: string;
  /** How many `tools/call` requests named this tool. */
  invocations: number;
}

/** One navigation entry the Devboard mode's sidebar renders. */
export interface DevboardSidebarEntry {
  id: string;
  label: string;
  command: string;
  tab: WorkspaceTab;
}

/** One row of the Skills page: an installed skill, whether OMP loads it, and its file. */
export interface DevboardSkillRow {
  name: string;
  enabled: boolean;
  /** The whole SKILL.md; empty when an older server sends no content. */
  content: string;
  /** The package ships this skill; the row shows `Managed` and no delete. */
  builtin: boolean;
  /** The server would accept a delete command for this prepare-family row. */
  deletable: boolean;
}

/** The read-only MCP catalog page. */
export const DEVBOARD_TAB: WorkspaceTab = {
  id: "tools",
  kind: "mcp-tools",
  resourceId: "tools",
  title: "MCP tools",
};

/** Every skill installed under the repository's `.omp/skills` root. */
export const DEVBOARD_SKILLS_TAB: WorkspaceTab = {
  id: "devboard-skills",
  kind: "devboard-skills",
  resourceId: "devboard-skills",
  title: "Skills",
};

export const DEVBOARD_SIDEBAR: readonly DevboardSidebarEntry[] = [
  { id: "tools", label: "MCP tools", command: "devboard.tab.tools", tab: DEVBOARD_TAB },
  { id: "skills", label: "Skills", command: "devboard.tab.skills", tab: DEVBOARD_SKILLS_TAB },
];

/**
 * The server's installed skills, managed rows first and each group by name, so
 * the package's own skills lead the table whatever the server sends. A
 * malformed row is dropped rather than rendered with a name the filesystem
 * never had.
 */
export function skillRows(value: unknown): DevboardSkillRow[] {
  if (!Array.isArray(value)) return [];
  const rows: DevboardSkillRow[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || row.name.length === 0) continue;
    if (typeof row.enabled !== "boolean") continue;
    rows.push({
      name: row.name,
      enabled: row.enabled,
      content: typeof row.content === "string" ? row.content : "",
      builtin: row.builtin === true,
      deletable: row.deletable === true,
    });
  }
  return rows.sort(
    (left, right) =>
      Number(right.builtin) - Number(left.builtin) || left.name.localeCompare(right.name),
  );
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
 * client never carries its own list: it asks once per connection and renders
 * the reply in arrival order.
 */
export class DevboardStore {
  tools = $state<McpToolRow[]>([]);
  loaded = $state(false);
  skills = $state<DevboardSkillRow[]>([]);
  skillsLoaded = $state(false);

  request(): void {
    connection.send({ type: "getMcpTools" });
  }

  requestSkills(): void {
    connection.send({ type: "getInstalledSkills" });
  }

  /**
   * Flips one row immediately and asks the server to persist the same state.
   * The server's authoritative frame replaces the guess; a frame that never
   * arrives still leaves the checkbox usable for the next click.
   */
  setSkillEnabled(name: string, enabled: boolean): void {
    const previous = this.skills;
    this.skills = this.skills.map((row) =>
      row.name === name ? { ...row, enabled } : row,
    );
    if (!connection.send({ type: "setInstalledSkillEnabled", name, enabled })) {
      this.skills = previous;
    }
  }

  /**
   * Asks the server to delete one prepare-family skill. The row leaves when
   * the server's authoritative frame arrives, so a refused command leaves it
   * in place instead of hiding a skill that still exists.
   */
  deleteSkill(name: string): void {
    connection.send({ type: "deleteSkill", name });
  }

  handleEvent(message: Record<string, unknown>): void {
    if (message.type === "mcpTools") {
      this.tools = toolRows(message.tools, message.invocations);
      this.loaded = true;
      return;
    }
    if (message.type !== "installedSkills") return;
    this.skills = skillRows(message.skills);
    this.skillsLoaded = true;
  }
}

export const devboard = new DevboardStore();
