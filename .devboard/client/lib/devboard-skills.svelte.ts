import { connection } from "./connection.svelte";

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
 * Holds every skill installed under the repository's `.omp/skills` root. The
 * page asks once per connection and after every reconnect; the server pushes
 * the authoritative frame after each toggle and delete.
 */
export class DevboardSkillsStore {
  skills = $state<DevboardSkillRow[]>([]);
  skillsLoaded = $state(false);

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
    if (message.type !== "installedSkills") return;
    this.skills = skillRows(message.skills);
    this.skillsLoaded = true;
  }
}

export const devboardSkills = new DevboardSkillsStore();
