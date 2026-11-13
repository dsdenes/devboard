import { expect, test } from "bun:test";
import { TABS } from "./discover-format";
import { buildCommands, type CommandContext } from "./commands";

/**
 * The fewest store fields `buildCommands` reads at build time: no open pages,
 * no runs, no records. Dynamic rows stay absent, so the assertions cover the
 * static palette plus one row per workspace tab.
 */
const context = {
  goal: {
    goalReady: false,
    revisionDisabled: false,
    prepareDisabled: false,
    next: null,
    runStartDisabled: false,
    lifecycleActive: false,
    lifecycleButtonDisabled: false,
    lifecycleButtonTitle: null,
    lifecycle: { paused: false },
    resetDisabled: false,
    resetArmed: false,
    question: null,
    records: [],
    skills: [],
    lanes: [],
  },
  flow: {
    goal: "",
    startDisabled: false,
    stopDisabled: false,
    restoring: false,
    steeringDraft: "",
    prError: null,
    readyDisabled: false,
    mergeDisabled: false,
    conversation: null,
    conclusionDraft: "",
    widgets: [],
    files: [],
    checkpoints: [],
    blockers: [],
    goalCreation: null,
    question: null,
    refusingId: null,
  },
  discover: {
    hasArtifacts: false,
    startDisabled: false,
    startTitle: null,
    active: false,
    question: null,
    answerDraft: "",
  },
  issues: {
    canStart: false,
    canPause: false,
    canResume: false,
    canStop: false,
    canCheck: false,
    selectedRun: null,
  },
  layout: {
    theme: "dark",
    tabs: { goal: [], issues: [], flow: [], discover: [], devboard: [] },
    setMode: () => {},
    activateTab: () => {},
  },
  connection: { feedbackEnabled: true, version: null },
  notifications: { live: [], items: [] },
  openTab: () => {},
  closeTab: () => {},
  focusLater: () => {},
  resetLayout: () => {},
  reportIssue: () => {},
  removeElement: () => {},
  redesignElement: () => {},
  cancelReport: () => {},
} as unknown as CommandContext;

test("no two palette commands share a title", () => {
  const titles = buildCommands(context).map((command) => command.title);

  const repeated = titles.filter((title, index) => titles.indexOf(title) !== index);

  expect(repeated).toEqual([]);
});

test("every workspace tab is reachable under a title that names its mode", () => {
  const commands = buildCommands(context);

  const overviews = commands
    .filter((command) => command.title.includes("Overview"))
    .map((command) => [command.id, command.title]);

  expect(overviews).toEqual([
    ["open.issues.overview", "Open Issues: Overview"],
    ["open.flow.overview", "Open Flow: Overview"],
    ["discover.tab.overview", "Open Discover: Overview"],
  ]);
});

test("registers every Discover page once, keeping the sidebar ids", () => {
  const ids = new Set(buildCommands(context).map((command) => command.id));

  expect(TABS.map((tab) => tab.id).filter((id) => !ids.has(`discover.tab.${id}`))).toEqual([]);
  expect(ids.has("open.discover.warnings")).toBe(true);
  expect(
    ["open.discover.overview", "open.discover.glossary", "open.discover.contribution"].filter((id) =>
      ids.has(id),
    ),
  ).toEqual([]);
});

test("a restoring Flow session disables the steering command despite a typed note", () => {
  const restoring = {
    ...context,
    flow: { ...context.flow, restoring: true, steeringDraft: "Steer left" },
  } as unknown as CommandContext;
  const command = buildCommands(restoring).find((entry) => entry.id === "flow.steering.send");

  expect(command?.disabled?.()).toBe("Wait for the stored Flow session to finish restoring.");
});
