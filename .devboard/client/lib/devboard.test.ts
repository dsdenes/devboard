import { expect, test } from "bun:test";
import { toolListPayload } from "../../mcp/catalog";
import { DevboardStore, DEVBOARD_SIDEBAR, toolRows } from "./devboard.svelte";

test("renders every catalog tool in the payload's order with its name, title, and description", () => {
  const payload = toolListPayload();

  const rows = toolRows(payload.tools);

  expect(rows).toEqual(
    payload.tools.map(({ name, title, description }) => ({
      name,
      title,
      description,
      invocations: 0,
    })),
  );
  expect(rows.length).toBe(payload.tools.length);
  expect(rows.map((row) => row.name)).toEqual(payload.tools.map((tool) => tool.name));
});

test("attaches the server's count to each tool and defaults an absent count to zero", () => {
  const rows = toolRows(
    [
      { name: "first", title: "First", description: "One" },
      { name: "second", title: "Second", description: "Two" },
    ],
    { first: 7, second: -1, unknown: 4 },
  );

  expect(rows).toEqual([
    { name: "first", title: "First", description: "One", invocations: 7 },
    { name: "second", title: "Second", description: "Two", invocations: 0 },
  ]);
});

test("drops malformed catalog entries instead of inventing rows", () => {
  const rows = toolRows([
    { name: "first", title: "First", description: "One" },
    { name: "missing-title", description: "Two" },
    { name: "missing-description", title: "Three" },
    "not-an-object",
    { name: "second", title: "Second", description: "Four" },
  ]);

  expect(rows).toEqual([
    { name: "first", title: "First", description: "One", invocations: 0 },
    { name: "second", title: "Second", description: "Four", invocations: 0 },
  ]);
  expect(toolRows(undefined)).toEqual([]);
});

test("the mode's sidebar carries exactly one entry that opens the list", () => {
  expect(DEVBOARD_SIDEBAR).toEqual([
    { id: "tools", label: "MCP tools", command: "devboard.tab.tools" },
  ]);
  const catalogNames = new Set(toolListPayload().tools.map((tool) => tool.name));
  for (const entry of DEVBOARD_SIDEBAR) {
    expect(catalogNames.has(entry.label)).toBe(false);
  }
});

test("a catalog frame replaces the rows; every other frame is ignored", () => {
  const store = new DevboardStore();
  const payload = toolListPayload();

  store.handleEvent({ type: "versionState", running: "a", installed: "a", latest: "a", stale: false });
  expect(store.loaded).toBe(false);
  expect(store.tools).toEqual([]);

  store.handleEvent({ type: "mcpTools", tools: payload.tools, invocations: { journal_search: 3 } });

  expect(store.loaded).toBe(true);
  expect(store.tools.map((row) => row.name)).toEqual(payload.tools.map((tool) => tool.name));
  expect(store.tools[0]?.description).toBe(payload.tools[0]?.description);
  expect(store.tools.find((row) => row.name === "journal_search")?.invocations).toBe(3);
});
