import { describe, expect, test } from "bun:test";
import { IssuesStore } from "./issues.svelte";

/** One snapshot as the server writes it, with the fields this test varies. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "issuesState",
    present: true,
    repo: "acme/app",
    root: "/repo",
    lifecycle: "stopped",
    enabled: false,
    paused: false,
    attached: false,
    worker: null,
    poll: null,
    queue: [],
    runs: [],
    agents: [],
    cooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    starting: false,
    startError: null,
    deferral: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("origin label", () => {
  test("an unresolved repository names no forge", () => {
    const store = new IssuesStore();
    store.handleEvent(snapshot({ repo: null }));
    const label = store.repoLabel;
    expect(label).toBe("Origin not resolved");
    expect(label).not.toContain("GitHub");
  });

  test("a resolved repository is its own label", () => {
    const store = new IssuesStore();
    store.handleEvent(snapshot({ repo: "acme/app" }));
    expect(store.repoLabel).toBe("acme/app");
  });

  test("no snapshot yet claims nothing about the origin", () => {
    expect(new IssuesStore().repoLabel).toBe("…");
  });
});
