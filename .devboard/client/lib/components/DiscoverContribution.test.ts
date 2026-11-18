import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Contribution, DiscoverStatePayload } from "../types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: DiscoverContribution } = await import("./DiscoverContribution.svelte");
const { discover } = await import("../discover.svelte");

afterEach(() => {
  cleanup();
  discover.state = null;
});

function contribution(): Contribution {
  return {
    schemaVersion: 1,
    freshness: {
      project: "checkout",
      commit: "0123456789abcdef",
      dirty: false,
      discoveredAt: "2026-11-02T15:20:23.238Z",
    },
    sections: [
      {
        id: "pull-request-size",
        label: "Pull request size",
        facts: [
          {
            key: "testFileShare",
            label: "Test-file share",
            value: { median: 35, min: 1, max: 9 },
            confidence: "observed",
            evidence: ["."],
          },
          {
            key: "additions",
            label: "Additions",
            value: { median: 40, min: 2, max: 900 },
            confidence: "observed",
            evidence: ["."],
          },
          {
            key: "testsShare",
            label: "Tests share",
            value: 40,
            confidence: "observed",
            evidence: ["."],
          },
        ],
      },
      {
        id: "pull-request-style",
        label: "Pull request style",
        facts: [
          {
            key: "issueLinking",
            label: "Issue linking",
            value: { referenceShare: 100, closingShare: 0 },
            confidence: "observed",
            evidence: ["."],
          },
        ],
      },
    ],
    sample: [],
  };
}

function unknownContribution(): Contribution {
  const sheet = contribution();
  sheet.sections = [
    {
      id: "provenance",
      label: "Provenance",
      facts: [
        {
          key: "forge",
          label: "Forge",
          confidence: "unknown",
          evidence: [],
          reason: "The forge could not be determined.",
        },
        {
          key: "style",
          label: "Style",
          confidence: "unknown",
          evidence: [],
        },
      ],
    },
  ];
  return sheet;
}

function state(): DiscoverStatePayload {
  return {
    active: false,
    runId: null,
    startedAt: null,
    activeAgent: null,
    runningAll: false,
    agents: [],
    interrupted: false,
    stale: false,
    warnings: [],
    busy: null,
    error: null,
    remoteAvailable: false,
    retained: [],
    repository: null,
    target: { kind: "host" },
    cloning: null,
    manifest: null,
    freshness: null,
    sheet: null,
    dependencyRepositories: {},
    overviewLinks: {},
    contribution: contribution(),
    glossaries: [],
    glossaryUsage: {},
    glossarySignificance: {},
    decisions: [],
    skills: [],
  };
}

function factValue(container: HTMLElement, key: string): string {
  return container.querySelector(`[data-fact="${key}"] dd`)?.textContent?.trim() ?? "";
}

test("a share held as a spread or a record carries its unit on every share row", () => {
  discover.state = state();
  const view = render(DiscoverContribution);

  const share = factValue(view.container, "testFileShare");
  expect(share).toContain("median: 35%");
  expect(share).toContain("min: 1%");
  expect(share).toContain("max: 9%");
  expect(factValue(view.container, "testsShare")).toBe("40%");

  const linking = factValue(view.container, "issueLinking");
  expect(linking).toContain("referenceShare: 100%");
  expect(linking).toContain("closingShare: 0%");

  const additions = factValue(view.container, "additions");
  expect(additions).toContain("median: 40");
  expect(additions).toContain("min: 2");
  expect(additions).toContain("max: 900");
});

test("an unpublished contribution shows the empty state and no page-level freshness stamp", () => {
  const payload = state();
  payload.contribution = null;
  payload.freshness = {
    project: "checkout",
    commit: "fedcba9876543210",
    dirty: false,
    discoveredAt: "2026-11-17T09:00:00.000Z",
  };
  discover.state = payload;
  const view = render(DiscoverContribution);

  expect(view.queryByTestId("discover-contribution-empty")).not.toBeNull();
  expect(view.queryByTestId("discover-freshness")).toBeNull();
});

test("a damaged contribution artifact names its read error instead of the empty state", () => {
  const payload = state();
  payload.contribution = null;
  payload.error =
    ".omp/discover/contribution.json is not valid JSON: expected value at line 1 column 2";
  discover.state = payload;
  const view = render(DiscoverContribution);

  expect(view.getByTestId("discover-contribution-error").textContent).toContain(
    ".omp/discover/contribution.json is not valid JSON",
  );
  expect(view.queryByTestId("discover-contribution-empty")).toBeNull();
});

test("a published contribution stamps its own discovery time, not the page-level crawl", () => {
  const payload = state();
  payload.freshness = {
    project: "checkout",
    commit: "fedcba9876543210",
    dirty: false,
    discoveredAt: "2026-11-17T09:00:00.000Z",
  };
  discover.state = payload;
  const view = render(DiscoverContribution);

  expect(view.getByTestId("discover-freshness").getAttribute("title")).toBe(
    "2026-11-02T15:20:23.238Z",
  );
});

test("an unknown fact renders its reason and keeps the bare wording when absent", () => {
  const payload = state();
  payload.contribution = unknownContribution();
  discover.state = payload;
  const view = render(DiscoverContribution);

  expect(factValue(view.container, "forge")).toBe(
    "Not recorded. The forge could not be determined.",
  );
  expect(factValue(view.container, "style")).toBe("Not recorded.");
});
