import type { WorkspaceTab } from "./layout.svelte";

/** One navigation entry the Devboard mode's sidebar renders. */
export interface DevboardSidebarEntry {
  id: string;
  label: string;
  command: string;
  tab: WorkspaceTab;
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

/** The complexity dashboard's own metrics page. */
export const DEVBOARD_COMPLEXITY_TAB: WorkspaceTab = {
  id: "complexity",
  kind: "devboard-complexity",
  resourceId: "complexity",
  title: "Complexity",
};

/** The resource governor's budget page. */
export const DEVBOARD_RESOURCES_TAB: WorkspaceTab = {
  id: "resources",
  kind: "devboard-resources",
  resourceId: "resources",
  title: "Resources",
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
  {
    id: "resources",
    label: "Resources",
    command: "devboard.tab.resources",
    tab: DEVBOARD_RESOURCES_TAB,
  },
];
