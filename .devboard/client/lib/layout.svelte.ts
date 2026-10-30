import type { Mode, Theme } from "./types";
import { agentRegistry } from "../../server/agents/registry";

export interface WorkspaceTab {
  id: string;
  kind: string;
  resourceId: string;
  title: string;
}

interface LayoutSnapshot {
  version: 1;
  mode: Mode;
  theme: Theme;
  tabs: Record<Mode, WorkspaceTab[]>;
  activeTab: Record<Mode, string | null>;
}

export const LAYOUT_KEY = "devboard.layout.v1";
export const THEME_KEY = "devboard.theme";
export const PANE_KEY_PREFIX = "paneforge:";

const MODES: Mode[] = ["goal", "issues", "flow", "discover", "devboard"];

function defaultTab(mode: Mode): WorkspaceTab {
  if (mode === "devboard") {
    return { id: "tools", kind: "mcp-tools", resourceId: "tools", title: "MCP tools" };
  }
  return {
    id: "overview",
    kind: "overview",
    resourceId: "overview",
    title: mode === "goal" ? "Implementation" : "Overview",
  };
}

export function defaultTabs(): Record<Mode, WorkspaceTab[]> {
  return {
    goal: [defaultTab("goal")],
    issues: [defaultTab("issues")],
    flow: [defaultTab("flow")],
    discover: [defaultTab("discover")],
    devboard: [defaultTab("devboard")],
  };
}

function defaultActive(): Record<Mode, string | null> {
  return {
    goal: "overview",
    issues: "overview",
    flow: "overview",
    discover: "overview",
    devboard: "tools",
  };
}

function isMode(value: unknown): value is Mode {
  return (
    value === "goal" ||
    value === "issues" ||
    value === "flow" ||
    value === "discover" ||
    value === "devboard"
  );
}

function validTab(value: unknown): value is WorkspaceTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    typeof tab.kind === "string" &&
    typeof tab.resourceId === "string" &&
    typeof tab.title === "string"
  );
}

/** A tab a previous revision could persist but this one no longer renders. */
function normalizeTab(mode: Mode, tab: WorkspaceTab): WorkspaceTab {
  if (mode === "flow" && tab.id === "flow-goal") return defaultTab("flow");
  if (mode === "issues" && agentRegistry.get(tab.kind) !== undefined) {
    return defaultTab("issues");
  }
  if (mode === "issues" && tab.kind === "issues") {
    return { ...tab, kind: "queue", id: "issues" };
  }
  if (mode === "discover" && tab.kind === "term") {
    return { id: "glossary", kind: "glossary", resourceId: "glossary", title: "Glossary" };
  }
  if (mode === "goal" && tab.id === "overview") return { ...tab, title: "Implementation" };
  return tab;
}

function readSnapshot(): LayoutSnapshot | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const snapshot = parsed as Record<string, unknown>;
    if (!isMode(snapshot.mode)) return null;
    const tabs = snapshot.tabs as Record<string, unknown> | undefined;
    const active = snapshot.activeTab as Record<string, unknown> | undefined;
    if (tabs === undefined || active === undefined) return null;
    const nextTabs = defaultTabs();
    const nextActive = defaultActive();
    for (const mode of MODES) {
      const list = tabs[mode];
      if (Array.isArray(list)) {
        const clean = list.filter(validTab);
        const id = active[mode];
        const chosen = clean.find((tab) => tab.id === id) ?? clean[0];
        if (chosen !== undefined) {
          const restored = normalizeTab(mode, chosen);
          nextTabs[mode] = [restored];
          nextActive[mode] = restored.id;
        }
      }
    }
    const theme: Theme = snapshot.theme === "light" ? "light" : "dark";
    return {
      version: 1,
      mode: snapshot.mode,
      theme,
      tabs: nextTabs,
      activeTab: nextActive,
    };
  } catch {
    return null;
  }
}

export class LayoutStore {
  mode = $state<Mode>("goal");
  theme = $state<Theme>("dark");
  tabs = $state<Record<Mode, WorkspaceTab[]>>(defaultTabs());
  activeTab = $state<Record<Mode, string | null>>(defaultActive());
  /** Bumping the epoch remounts PaneForge groups so stored split sizes are gone. */
  epoch = $state(0);

  constructor() {
    const snapshot = readSnapshot();
    if (snapshot !== null) {
      this.mode = snapshot.mode;
      this.theme = snapshot.theme;
      this.tabs = snapshot.tabs;
      this.activeTab = snapshot.activeTab;
    } else {
      try {
        const stored = localStorage.getItem(THEME_KEY);
        if (stored === "light" || stored === "dark") this.theme = stored;
      } catch {
        // A blocked localStorage leaves the dark default.
      }
    }
  }

  get activeTabId(): string | null {
    return this.activeTab[this.mode];
  }

  get activeWorkspaceTab(): WorkspaceTab | null {
    const id = this.activeTab[this.mode];
    return this.tabs[this.mode].find((tab) => tab.id === id) ?? null;
  }

  tab(mode: Mode, id: string): WorkspaceTab | null {
    return this.tabs[mode].find((tab) => tab.id === id) ?? null;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The theme still applies for this session.
    }
  }

  toggleTheme(): void {
    this.setTheme(this.theme === "dark" ? "light" : "dark");
  }

  /** One surface per mode: opening a tab replaces the visible page. */
  openTab(mode: Mode, tab: WorkspaceTab, activate = true): void {
    this.tabs[mode] = [tab];
    if (activate) this.activeTab[mode] = tab.id;
  }

  activateTab(mode: Mode, id: string): void {
    if (!this.tabs[mode].some((tab) => tab.id === id)) return;
    this.activeTab[mode] = id;
  }

  /** Removes a tab and returns the new active id so callers can move focus. */
  closeTab(mode: Mode, id: string): string | null {
    const list = this.tabs[mode];
    const index = list.findIndex((tab) => tab.id === id);
    if (index < 0) return this.activeTab[mode];
    const remaining = list.filter((tab) => tab.id !== id);
    this.tabs[mode] = remaining;
    if (this.activeTab[mode] === id) {
      const next = remaining[Math.min(index, remaining.length - 1)] ?? null;
      this.activeTab[mode] = next?.id ?? null;
    }
    return this.activeTab[mode];
  }

  reset(): void {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(PANE_KEY_PREFIX)) localStorage.removeItem(key);
      }
      localStorage.removeItem(LAYOUT_KEY);
    } catch {
      // Reset still resets the in-memory layout.
    }
    this.mode = "goal";
    this.tabs = defaultTabs();
    this.activeTab = defaultActive();
    this.setTheme("dark");
    this.epoch += 1;
  }

  serialize(): LayoutSnapshot {
    return {
      version: 1,
      mode: this.mode,
      theme: this.theme,
      tabs: this.tabs,
      activeTab: this.activeTab,
    };
  }

  persist(): void {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.serialize()));
    } catch {
      // Layout persistence is best effort; the session keeps working.
    }
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export const layout = new LayoutStore();
