import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the components and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const userEvent = (await import("@testing-library/user-event")).default;
const { default: AdrTable } = await import("./AdrTable.svelte");
// The store reaches the connection module, so it loads after the DOM globals exist.
const { goal } = await import("../goal.svelte");

afterEach(() => cleanup());

beforeEach(() => {
  goal.records = [];
  goal.next = null;
  goal.goalText = "";
  goal.goalReady = true;
  goal.creationActive = false;
  goal.revisionActive = false;
  goal.skillsPrepActive = false;
  goal.runFile = null;
  goal.runTitle = null;
  goal.runState = "idle";
  goal.manualRunActive = false;
  goal.lifecycle = { stage: "goal", pass: 1, work: null, paused: false };
  goal.lifecycleSeen = false;
  goal.skills = [];
});

const record = {
  file: "0001-keyboard.md",
  title: "Keyboard record",
  status: "Accepted",
  pending: true,
  summary: "Summary",
};

function renderTable() {
  const opened: string[] = [];
  const started: string[] = [];
  const view = render(AdrTable, {
    props: {
      records: [record],
      onopen: (row: typeof record) => opened.push(row.file),
      onstart: (row: typeof record) => started.push(row.file),
    },
  });
  return { view, opened, started };
}

test("Enter on the row's Start button starts the record without opening it", async () => {
  const { view, opened, started } = renderTable();
  const button = view.getByTestId("start");
  button.focus();
  expect(document.activeElement).toBe(button);

  await userEvent.setup().keyboard("[Enter]");

  expect(started).toEqual([record.file]);
  expect(opened).toEqual([]);
});

test("Space on the row's Start button starts the record without opening it", async () => {
  const { view, opened, started } = renderTable();
  view.getByTestId("start").focus();

  await userEvent.setup().keyboard("[Space]");

  expect(started).toEqual([record.file]);
  expect(opened).toEqual([]);
});

test("Enter on the row itself opens the record", async () => {
  const { view, opened, started } = renderTable();
  view.getByTestId("record").focus();

  await userEvent.setup().keyboard("[Enter]");

  expect(opened).toEqual([record.file]);
  expect(started).toEqual([]);
});

test("a pending row's Start is enabled and untitled when no operation is active", () => {
  const { view } = renderTable();
  const button = view.getByTestId("start");

  expect(button.hasAttribute("disabled")).toBe(false);
  expect(button.hasAttribute("title")).toBe(false);
});

test("a pending row's Start is disabled and names the active manual run", () => {
  goal.manualRunActive = true;
  const { view } = renderTable();
  const button = view.getByTestId("start");

  expect(button.hasAttribute("disabled")).toBe(true);
  expect(button.getAttribute("title")).toContain("A run is active");
});
