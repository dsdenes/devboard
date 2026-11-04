import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: DevboardComplexity } = await import("./DevboardComplexity.svelte");
const { devboard, EMPTY_COMPLEXITY_VIEW } = await import("../devboard.svelte");

const EARLIER = {
  files: 3,
  functions: 4,
  loc: 120,
  meanCyclomatic: 2.5,
  maxCyclomatic: 7,
  functionsOverThreshold: 0,
  duplicatedLineRatio: 0.05,
  meanMaintainability: 82.5,
};

const LATEST = {
  files: 3,
  functions: 4,
  loc: 140,
  meanCyclomatic: 3.5,
  maxCyclomatic: 9,
  functionsOverThreshold: 1,
  duplicatedLineRatio: 0.125,
  meanMaintainability: 78.25,
};

const FILES = [
  { path: ".devboard/server/a.ts", loc: 40, functions: 2, duplicatedLineRatio: 0.1, maintainability: 90 },
  { path: ".devboard/server/b.ts", loc: 80, functions: 1, duplicatedLineRatio: 0, maintainability: 70 },
  { path: ".devboard/server/c.ts", loc: 20, functions: 1, duplicatedLineRatio: 0.25, maintainability: 95 },
];

function seed(): void {
  devboard.complexity = {
    points: [
      { date: "2026-11-01", recordedAt: "2026-11-01T00:00:00.000Z", project: EARLIER },
      { date: "2026-11-02", recordedAt: "2026-11-02T00:00:00.000Z", project: LATEST },
    ],
    latest: {
      date: "2026-11-02",
      recordedAt: "2026-11-02T00:00:00.000Z",
      project: LATEST,
      files: FILES,
    },
  };
  devboard.complexityLoaded = true;
}

afterEach(() => {
  cleanup();
  devboard.complexity = EMPTY_COMPLEXITY_VIEW;
  devboard.complexityLoaded = false;
});

test("renders one card per project metric with the latest value and its unit", () => {
  seed();

  const { container } = render(DevboardComplexity);
  const cards = [...container.querySelectorAll('[data-testid="complexity-card"]')];

  expect(cards.map((card) => card.getAttribute("data-metric"))).toEqual([
    "files",
    "functions",
    "loc",
    "meanCyclomatic",
    "maxCyclomatic",
    "functionsOverThreshold",
    "duplicatedLineRatio",
    "meanMaintainability",
  ]);
  expect(cards.map((card) => card.getAttribute("data-value"))).toEqual([
    "3",
    "4",
    "140",
    "3.50",
    "9",
    "1",
    "0.1250",
    "78.25",
  ]);
  expect(container.textContent ?? "").toContain("cc > 10");
  expect(container.textContent ?? "").toContain("Mi 0-100".toUpperCase());
});

test("reports the newest snapshot's date, timestamp, and recorded count", () => {
  seed();

  const { container } = render(DevboardComplexity);
  const summary = container.querySelector('[data-testid="complexity-summary"]');

  expect(summary?.getAttribute("data-count")).toBe("2");
  expect(summary?.getAttribute("data-date")).toBe("2026-11-02");
  expect(summary?.getAttribute("data-recorded-at")).toBe("2026-11-02T00:00:00.000Z");
  expect(summary?.textContent?.replace(/\s+/g, " ") ?? "").toContain("2 recorded dates");
});

test("draws one series per project metric with every date and a latest marker", () => {
  seed();

  const { container } = render(DevboardComplexity);
  const series = [...container.querySelectorAll('[data-testid="complexity-series"]')];

  expect(series.map((entry) => entry.getAttribute("data-metric"))).toEqual([
    "files",
    "functions",
    "loc",
    "meanCyclomatic",
    "maxCyclomatic",
    "functionsOverThreshold",
    "duplicatedLineRatio",
    "meanMaintainability",
  ]);
  for (const entry of series) {
    expect(entry.getAttribute("data-points")).toBe("2");
    const points = [...entry.querySelectorAll('[data-testid="complexity-series-point"]')];
    expect(points.map((point) => point.getAttribute("data-date"))).toEqual([
      "2026-11-01",
      "2026-11-02",
    ]);
    const markers = [...entry.querySelectorAll('[data-testid="complexity-series-latest"]')];
    expect(markers.map((marker) => marker.getAttribute("data-date"))).toEqual(["2026-11-02"]);
  }
});

test("a changed value moves its point and a flat one keeps its line level", () => {
  seed();

  const { container } = render(DevboardComplexity);
  const pointY = (metric: string): number[] =>
    [
      ...container.querySelectorAll(
        `[data-testid="complexity-series"][data-metric="${metric}"] ` +
          '[data-testid="complexity-series-point"]',
      ),
    ].map((point) => Number(point.getAttribute("cy")));

  const rising = pointY("meanCyclomatic");
  expect(rising).toHaveLength(2);
  expect(rising[0]).not.toBe(rising[1]);

  const flat = pointY("files");
  expect(flat[0]).toBe(flat[1]);
});

test("the per-file table sorts by any metric column and by path", async () => {
  seed();

  const { container } = render(DevboardComplexity);
  const paths = (): string[] =>
    [...container.querySelectorAll('[data-testid="complexity-file-row"]')].map(
      (row) => row.getAttribute("data-path") ?? "",
    );
  const sort = async (key: string): Promise<void> => {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="complexity-sort"][data-sort="${key}"]`,
    );
    expect(button).not.toBeNull();
    if (button !== null) fireEvent.click(button);
    await tick();
  };

  // The default order is the path, ascending.
  expect(paths()).toEqual([
    ".devboard/server/a.ts",
    ".devboard/server/b.ts",
    ".devboard/server/c.ts",
  ]);

  await sort("loc");
  expect(paths()).toEqual([
    ".devboard/server/c.ts",
    ".devboard/server/a.ts",
    ".devboard/server/b.ts",
  ]);

  await sort("loc");
  expect(paths()).toEqual([
    ".devboard/server/b.ts",
    ".devboard/server/a.ts",
    ".devboard/server/c.ts",
  ]);

  await sort("maintainability");
  expect(paths()).toEqual([
    ".devboard/server/b.ts",
    ".devboard/server/a.ts",
    ".devboard/server/c.ts",
  ]);

  const row = container.querySelector('[data-testid="complexity-file-row"]');
  expect(
    [...row?.querySelectorAll('[data-testid="complexity-cell"]') ?? []].map((cell) =>
      cell.getAttribute("data-metric"),
    ),
  ).toEqual(["loc", "functions", "duplicatedLineRatio", "maintainability"]);
});

test("an empty history renders the loading state without inventing a value", () => {
  const { container } = render(DevboardComplexity);

  expect(container.querySelectorAll('[data-testid="complexity-file-row"]')).toHaveLength(0);
  expect(
    container.querySelector('[data-testid="complexity-card"]')?.getAttribute("data-value"),
  ).toBe("");
  expect(container.textContent ?? "").toContain("Loading the complexity history…");
});
