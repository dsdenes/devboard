import { beforeEach, expect, test } from "bun:test";
import { LAYOUT_KEY, LayoutStore } from "./layout.svelte";

class MemoryStorage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  return storage;
}

const MODE_NAMES = ["goal", "issues", "flow", "discover", "devboard"];

beforeEach(() => {
  installStorage();
});

test("a fresh profile starts on Goal with one page in every mode", () => {
  const store = new LayoutStore();

  expect(store.mode).toBe("goal");
  expect(Object.keys(store.tabs).sort()).toEqual([...MODE_NAMES].sort());
  expect(store.activeWorkspaceTab?.title).toBe("Implementation");
  for (const mode of MODE_NAMES) {
    expect(store.tabs[mode as keyof typeof store.tabs]).toHaveLength(1);
    expect(store.activeTab[mode as keyof typeof store.activeTab]).not.toBeNull();
  }
  expect(store.tabs.devboard).toEqual([
    { id: "tools", kind: "mcp-tools", resourceId: "tools", title: "MCP tools" },
  ]);
  expect(store.activeTab.devboard).toBe("tools");
});

test("persists the active Devboard mode and every mode's page", () => {
  const storage = installStorage();
  const store = new LayoutStore();
  store.setMode("devboard");
  store.openTab("goal", { id: "adrs", kind: "adrs", resourceId: "adrs", title: "ADRs" });
  store.persist();

  const stored = JSON.parse(storage.getItem(LAYOUT_KEY) ?? "{}") as {
    mode?: string;
    tabs?: Record<string, unknown[]>;
    activeTab?: Record<string, string | null>;
  };
  expect(stored.mode).toBe("devboard");
  expect(Object.keys(stored.tabs ?? {}).sort()).toEqual([...MODE_NAMES].sort());
  expect(stored.activeTab?.devboard).toBe("tools");
  expect(stored.tabs?.goal).toEqual([
    { id: "adrs", kind: "adrs", resourceId: "adrs", title: "ADRs" },
  ]);
});

test("restores a stored five-mode snapshot", () => {
  const storage = installStorage();
  storage.setItem(
    LAYOUT_KEY,
    JSON.stringify({
      version: 1,
      mode: "devboard",
      theme: "light",
      tabs: {
        goal: [{ id: "adrs", kind: "adrs", resourceId: "adrs", title: "ADRs" }],
        issues: [{ id: "drafts", kind: "drafts", resourceId: "drafts", title: "Draft goals" }],
        flow: [{ id: "history", kind: "history", resourceId: "history", title: "History" }],
        discover: [
          { id: "glossary", kind: "glossary", resourceId: "glossary", title: "Glossary" },
        ],
        devboard: [{ id: "tools", kind: "mcp-tools", resourceId: "tools", title: "MCP tools" }],
      },
      activeTab: {
        goal: "adrs",
        issues: "drafts",
        flow: "history",
        discover: "glossary",
        devboard: "tools",
      },
    }),
  );

  const store = new LayoutStore();

  expect(store.mode).toBe("devboard");
  expect(store.theme).toBe("light");
  expect(store.activeWorkspaceTab?.id).toBe("tools");
  expect(store.tabs.goal[0]?.id).toBe("adrs");
  expect(store.tabs.issues[0]?.id).toBe("drafts");
  expect(store.tabs.flow[0]?.id).toBe("history");
  expect(store.tabs.discover[0]?.id).toBe("glossary");
});

test("restores a snapshot written before Devboard existed without losing a mode", () => {
  const storage = installStorage();
  storage.setItem(
    LAYOUT_KEY,
    JSON.stringify({
      version: 1,
      mode: "discover",
      theme: "dark",
      tabs: {
        goal: [{ id: "overview", kind: "overview", resourceId: "overview", title: "Implementation" }],
        issues: [{ id: "agents", kind: "agents", resourceId: "agents", title: "Agents" }],
        flow: [{ id: "overview", kind: "overview", resourceId: "overview", title: "Overview" }],
        discover: [
          {
            id: "testing-strategy",
            kind: "skill",
            resourceId: "discover-testing-strategy",
            title: "Testing strategy",
          },
        ],
      },
      activeTab: {
        goal: "overview",
        issues: "agents",
        flow: "overview",
        discover: "testing-strategy",
      },
    }),
  );

  const store = new LayoutStore();

  expect(store.mode).toBe("discover");
  expect(store.tabs.issues[0]?.id).toBe("agents");
  expect(store.tabs.discover[0]?.id).toBe("testing-strategy");
  // The absent mode keeps its default page rather than a lost mode.
  expect(store.tabs.devboard).toEqual([
    { id: "tools", kind: "mcp-tools", resourceId: "tools", title: "MCP tools" },
  ]);
  expect(store.activeTab.devboard).toBe("tools");
});

test("drops a Background agent page stored in Issues mode", () => {
  const storage = installStorage();
  storage.setItem(
    LAYOUT_KEY,
    JSON.stringify({
      version: 1,
      mode: "issues",
      theme: "dark",
      tabs: {
        issues: [{ id: "scout", kind: "scout", resourceId: "scout", title: "Auto Scout" }],
      },
      activeTab: { issues: "scout" },
    }),
  );

  const store = new LayoutStore();

  expect(store.mode).toBe("issues");
  expect(store.tabs.issues).toEqual([
    { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" },
  ]);
  expect(store.activeTab.issues).toBe("overview");
});
