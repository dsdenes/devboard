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
        id: "change-size",
        label: "Change size",
        facts: [
          {
            key: "testFileShare",
            label: "Test-file share",
            value: { median: 3, min: 1, max: 9 },
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
    ],
    sample: [],
  };
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

test("a percent-shaped record fact renders its rows and a numeric one renders a percentage", () => {
  discover.state = state();
  const view = render(DiscoverContribution);

  const share = factValue(view.container, "testFileShare");
  expect(share).toContain("median: 3");
  expect(share).toContain("min: 1");
  expect(share).toContain("max: 9");
  expect(factValue(view.container, "testsShare")).toBe("40%");
});
