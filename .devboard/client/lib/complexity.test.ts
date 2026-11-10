import { expect, test } from "bun:test";
import {
  ComplexityStore,
  EMPTY_COMPLEXITY_VIEW,
  complexityView,
  type ComplexityProjectRow,
} from "./complexity.svelte";

const PROJECT: ComplexityProjectRow = {
  files: 3,
  functions: 4,
  loc: 140,
  meanCyclomatic: 3.5,
  maxCyclomatic: 9,
  functionsOverThreshold: 1,
  duplicatedLineRatio: 0.125,
  meanMaintainability: 78.25,
};

const FILE = {
  path: ".devboard/server/a.ts",
  loc: 40,
  functions: 2,
  duplicatedLineRatio: 0.1,
  maintainability: 90,
};

/** One `complexityState` payload; a caller overrides one part at a time. */
function frame(
  options: { snapshots?: unknown[]; latest?: Record<string, unknown> | null } = {},
): Record<string, unknown> {
  return {
    snapshots:
      options.snapshots ??
      [
        { date: "2026-11-01", recordedAt: "2026-11-01T00:00:00.000Z", project: PROJECT },
        { date: "2026-11-02", recordedAt: "2026-11-02T00:00:00.000Z", project: PROJECT },
      ],
    latest:
      options.latest === undefined
        ? {
            date: "2026-11-02",
            recordedAt: "2026-11-02T00:00:00.000Z",
            project: PROJECT,
            files: [FILE],
          }
        : options.latest,
  };
}

test("a readable frame yields every dated point and the newest detail", () => {
  const result = complexityView(frame());

  if (result.status !== "recorded") throw new Error(`read as ${result.status}`);
  expect(result.view.points.map((point) => point.date)).toEqual(["2026-11-01", "2026-11-02"]);
  expect(result.view.latest?.project).toEqual(PROJECT);
  expect(result.view.latest?.files).toEqual([FILE]);
});

test("a snapshot with one malformed project figure is dropped, not charted", () => {
  const result = complexityView(
    frame({
      snapshots: [
        { date: "2026-11-01", recordedAt: "2026-11-01T00:00:00.000Z", project: PROJECT },
        {
          date: "2026-11-02",
          recordedAt: "2026-11-02T00:00:00.000Z",
          project: { ...PROJECT, loc: "140" },
        },
      ],
      latest: null,
    }),
  );

  if (result.status !== "recorded") throw new Error(`read as ${result.status}`);
  expect(result.view.points.map((point) => point.date)).toEqual(["2026-11-01"]);
  expect(result.view.latest).toBeNull();
});

test("a snapshot with no readable project at all makes the frame unreadable", () => {
  const result = complexityView(
    frame({
      snapshots: [
        {
          date: "2026-11-02",
          recordedAt: "2026-11-02T00:00:00.000Z",
          project: { ...PROJECT, maxCyclomatic: null },
        },
      ],
      latest: null,
    }),
  );

  expect(result).toEqual({ status: "unreadable" });
});

test("a malformed file row is dropped from the newest detail", () => {
  const result = complexityView(
    frame({
      latest: {
        date: "2026-11-02",
        recordedAt: "2026-11-02T00:00:00.000Z",
        project: PROJECT,
        files: [FILE, { ...FILE, path: "" }, { ...FILE, maintainability: "90" }],
      },
    }),
  );

  if (result.status !== "recorded") throw new Error(`read as ${result.status}`);
  expect(result.view.latest?.files).toEqual([FILE]);
});

test("a state that is not an object is unreadable", () => {
  expect(complexityView(null)).toEqual({ status: "unreadable" });
  expect(complexityView("complexity")).toEqual({ status: "unreadable" });
});

test("a readable frame without a snapshot array is unreadable", () => {
  expect(complexityView({ latest: null })).toEqual({ status: "unreadable" });
});

test("a readable frame with zero snapshots is empty", () => {
  expect(complexityView({ snapshots: [], latest: null })).toEqual({ status: "empty" });
});

test("the store starts loading and reports what each frame carried", () => {
  const store = new ComplexityStore();
  expect(store.complexityStatus).toBe("loading");
  expect(store.complexity).toEqual(EMPTY_COMPLEXITY_VIEW);

  store.handleEvent({ type: "complexityState", state: frame() });
  expect(store.complexityStatus).toBe("recorded");
  expect(store.complexity.points).toHaveLength(2);

  store.handleEvent({ type: "complexityState", state: { snapshots: [], latest: null } });
  expect(store.complexityStatus).toBe("empty");
  expect(store.complexity).toEqual(EMPTY_COMPLEXITY_VIEW);
});

test("an unreadable frame leaves the last known view in place", () => {
  const store = new ComplexityStore();
  store.handleEvent({ type: "complexityState", state: frame() });
  const shown = store.complexity;

  store.handleEvent({
    type: "complexityState",
    state: {
      snapshots: [
        {
          date: "2026-11-03",
          recordedAt: "2026-11-03T00:00:00.000Z",
          project: { ...PROJECT, files: "3" },
        },
      ],
      latest: null,
    },
  });

  expect(store.complexityStatus).toBe("unreadable");
  expect(store.complexity).toBe(shown);
  expect(store.complexity.points).toHaveLength(2);
});

test("a message that is not a complexity frame changes nothing", () => {
  const store = new ComplexityStore();
  store.handleEvent({ type: "complexityState", state: frame() });
  const shown = store.complexity;

  store.handleEvent({ type: "versionState", state: { snapshots: [], latest: null } });

  expect(store.complexityStatus).toBe("recorded");
  expect(store.complexity).toBe(shown);
});
