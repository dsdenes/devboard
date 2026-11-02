import { expect, test } from "bun:test";
import { toolListPayload } from "../../mcp/catalog";
import {
  DevboardStore,
  DEVBOARD_SIDEBAR,
  DEVBOARD_SKILLS_TAB,
  DEVBOARD_TAB,
  skillRows,
  toolRows,
} from "./devboard.svelte";

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

test("the mode's sidebar carries one entry per page and no per-skill entry", () => {
  expect(DEVBOARD_SIDEBAR.map((entry) => entry.label)).toEqual(["MCP tools", "Skills"]);
  expect(DEVBOARD_SIDEBAR.map((entry) => entry.command)).toEqual([
    "devboard.tab.tools",
    "devboard.tab.skills",
  ]);
  expect(DEVBOARD_SIDEBAR[0]?.tab).toEqual(DEVBOARD_TAB);
  expect(DEVBOARD_SIDEBAR[1]?.tab).toEqual(DEVBOARD_SKILLS_TAB);
  expect(DEVBOARD_SKILLS_TAB).toEqual({
    id: "devboard-skills",
    kind: "devboard-skills",
    resourceId: "devboard-skills",
    title: "Skills",
  });
  const catalogNames = new Set(toolListPayload().tools.map((tool) => tool.name));
  for (const entry of DEVBOARD_SIDEBAR) {
    expect(catalogNames.has(entry.label)).toBe(false);
  }
});

test("installed-skill rows keep the server's names and states and drop malformed entries", () => {
  expect(
    skillRows([
      { name: "benchmark-methodology", enabled: true },
      { name: "wire-format-conformance", enabled: false },
      { name: "", enabled: true },
      { name: "missing-state" },
      { name: "wrong-state", enabled: "true" },
      "not-an-object",
    ]),
  ).toEqual([
    { name: "benchmark-methodology", enabled: true, content: "" },
    { name: "wire-format-conformance", enabled: false, content: "" },
  ]);
  expect(skillRows(undefined)).toEqual([]);
});

test("an installed-skill row keeps the SKILL.md text it was sent", () => {
  expect(
    skillRows([{ name: "benchmark-methodology", enabled: true, content: "# Benchmark\n" }]),
  ).toEqual([{ name: "benchmark-methodology", enabled: true, content: "# Benchmark\n" }]);
});

test("each frame replaces its own rows and leaves the other page alone", () => {
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

  expect(store.skillsLoaded).toBe(false);
  store.handleEvent({
    type: "installedSkills",
    skills: [
      { name: "benchmark-methodology", enabled: true },
      { name: "wire-format-conformance", enabled: false },
    ],
  });

  expect(store.skillsLoaded).toBe(true);
  expect(store.skills).toEqual([
    { name: "benchmark-methodology", enabled: true, content: "" },
    { name: "wire-format-conformance", enabled: false, content: "" },
  ]);
  expect(store.tools.length).toBe(payload.tools.length);
});
