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

/** One project-level measurement as the complexity page renders it. */
export interface ComplexityProjectRow {
  files: number;
  functions: number;
  loc: number;
  meanCyclomatic: number;
  maxCyclomatic: number;
  functionsOverThreshold: number;
  duplicatedLineRatio: number;
  meanMaintainability: number;
}

/** One recorded date in the complexity time series. */
export interface ComplexityPoint {
  date: string;
  recordedAt: string;
  project: ComplexityProjectRow;
}

/** One analyzed file in the newest snapshot. */
export interface ComplexityFileRow {
  path: string;
  loc: number;
  functions: number;
  duplicatedLineRatio: number;
  maintainability: number;
}

/** The newest snapshot with its per-file detail. */
export interface ComplexityLatest {
  date: string;
  recordedAt: string;
  project: ComplexityProjectRow;
  files: ComplexityFileRow[];
}

/** Every recorded date plus the newest snapshot's detail. */
export interface ComplexityView {
  points: ComplexityPoint[];
  latest: ComplexityLatest | null;
}

/** No recorded snapshot yet. */
export const EMPTY_COMPLEXITY_VIEW: ComplexityView = { points: [], latest: null };

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

/** The complexity dashboard's own metrics page. */
export const DEVBOARD_COMPLEXITY_TAB: WorkspaceTab = {
  id: "complexity",
  kind: "devboard-complexity",
  resourceId: "complexity",
  title: "Complexity",
};

export const DEVBOARD_SIDEBAR: readonly DevboardSidebarEntry[] = [
  { id: "tools", label: "MCP tools", command: "devboard.tab.tools", tab: DEVBOARD_TAB },
  { id: "skills", label: "Skills", command: "devboard.tab.skills", tab: DEVBOARD_SKILLS_TAB },
  {
    id: "complexity",
    label: "Complexity",
    command: "devboard.tab.complexity",
    tab: DEVBOARD_COMPLEXITY_TAB,
  },
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

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** One project-level row, or `undefined` when any figure is malformed. */
function projectRow(value: unknown): ComplexityProjectRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const {
    files,
    functions,
    loc,
    meanCyclomatic,
    maxCyclomatic,
    functionsOverThreshold,
    duplicatedLineRatio,
    meanMaintainability,
  } = value as Record<string, unknown>;
  if (
    !isCount(files) ||
    !isCount(functions) ||
    !isCount(loc) ||
    !isCount(meanCyclomatic) ||
    !isCount(maxCyclomatic) ||
    !isCount(functionsOverThreshold) ||
    typeof duplicatedLineRatio !== "number" ||
    typeof meanMaintainability !== "number"
  ) {
    return undefined;
  }
  return {
    files,
    functions,
    loc,
    meanCyclomatic,
    maxCyclomatic,
    functionsOverThreshold,
    duplicatedLineRatio,
    meanMaintainability,
  };
}

/** One analyzed file, or `undefined` when any figure is malformed. */
function fileRow(value: unknown): ComplexityFileRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.path !== "string" || row.path.length === 0) return undefined;
  if (!isCount(row.loc) || !isCount(row.functions)) return undefined;
  if (typeof row.duplicatedLineRatio !== "number" || typeof row.maintainability !== "number") {
    return undefined;
  }
  return {
    path: row.path,
    loc: row.loc,
    functions: row.functions,
    duplicatedLineRatio: row.duplicatedLineRatio,
    maintainability: row.maintainability,
  };
}

/**
 * The complexity frame the server pushes: one point per recorded date, oldest
 * first, and the newest snapshot's per-file detail. A malformed point or file
 * row is dropped rather than charted with a value the server never measured.
 */
export function complexityView(value: unknown): ComplexityView {
  if (typeof value !== "object" || value === null) return EMPTY_COMPLEXITY_VIEW;
  const frame = value as Record<string, unknown>;
  const points: ComplexityPoint[] = [];
  if (Array.isArray(frame.snapshots)) {
    for (const entry of frame.snapshots) {
      if (typeof entry !== "object" || entry === null) continue;
      const point = entry as Record<string, unknown>;
      if (typeof point.date !== "string" || typeof point.recordedAt !== "string") continue;
      const project = projectRow(point.project);
      if (project === undefined) continue;
      points.push({ date: point.date, recordedAt: point.recordedAt, project });
    }
  }
  const latestEntry = frame.latest;
  let latest: ComplexityLatest | null = null;
  if (typeof latestEntry === "object" && latestEntry !== null) {
    const record = latestEntry as Record<string, unknown>;
    const project = projectRow(record.project);
    if (
      project !== undefined &&
      typeof record.date === "string" &&
      typeof record.recordedAt === "string"
    ) {
      const files: ComplexityFileRow[] = [];
      if (Array.isArray(record.files)) {
        for (const entry of record.files) {
          const row = fileRow(entry);
          if (row !== undefined) files.push(row);
        }
      }
      latest = { date: record.date, recordedAt: record.recordedAt, project, files };
    }
  }
  return { points, latest };
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
  complexity = $state<ComplexityView>(EMPTY_COMPLEXITY_VIEW);
  complexityLoaded = $state(false);

  request(): void {
    connection.send({ type: "getMcpTools" });
  }

  requestSkills(): void {
    connection.send({ type: "getInstalledSkills" });
  }

  requestComplexity(): void {
    connection.send({ type: "getComplexity" });
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
    if (message.type === "complexityState") {
      this.complexity = complexityView(message.state);
      this.complexityLoaded = true;
      return;
    }
    if (message.type !== "installedSkills") return;
    this.skills = skillRows(message.skills);
    this.skillsLoaded = true;
  }
}

export const devboard = new DevboardStore();
