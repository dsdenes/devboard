import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { issues } = await import("../issues.svelte");

/** The overview tab, which carries the Automation panel. */
const OVERVIEW = { id: "overview", kind: "overview", resourceId: "overview", title: "Overview" };

/** A snapshot with no open work, overlaid with the fields a test needs. */
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
    poll: {
      intervalMs: 10000,
      lastPollAt: "2026-11-04T21:51:57.182Z",
      nextPollAt: "2026-11-04T21:52:07.182Z",
      etag: null,
      notModified: false,
      rateLimitedUntil: null,
      error: "the tracker did not answer within 20000 ms",
    },
    queue: [],
    runs: [],
    agents: [],
    cooldowns: {},
    lastError: "the tracker did not answer within 20000 ms",
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    updatedAt: "2026-11-04T21:52:24.395Z",
    workers: [],
    sync: { intervalMs: 30000, lastSyncAt: "2026-11-05T08:57:10.477Z", error: null },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  issues.snapshot = null;
});

test("a stopped worker's last poll error is not a current failure", () => {
  issues.handleEvent(snapshot());

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });

  expect(view.queryByTestId("issues-poll-error")).toBeNull();
  expect(view.queryByTestId("issues-error")).toBeNull();
});

test("a stopped worker names the dashboard's own tracker sync failure", () => {
  issues.handleEvent(
    snapshot({
      sync: {
        intervalMs: 30000,
        lastSyncAt: "2026-11-05T08:57:10.477Z",
        error: "Gitea open-issue read for acme/app failed: connection refused",
      },
    }),
  );

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });

  expect(view.queryByTestId("issues-error")).toBeNull();
  expect(view.getByTestId("issues-poll-error").textContent?.trim()).toBe(
    "Gitea open-issue read for acme/app failed: connection refused",
  );
});

test("a live worker still shows its poll error", () => {
  issues.handleEvent(
    snapshot({
      lifecycle: "running",
      enabled: true,
      attached: true,
      lastError: "a different worker failure",
    }),
  );

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });

  expect(view.getByTestId("issues-poll-error").textContent?.trim()).toBe(
    "the tracker did not answer within 20000 ms",
  );
  expect(view.getByTestId("issues-error").textContent?.trim()).toBe("a different worker failure");
});
