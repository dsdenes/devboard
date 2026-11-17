import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { issues } = await import("../issues.svelte");

/** The queue page, which lists one lifecycle badge per open issue. */
const QUEUE = { id: "queue", kind: "queue", resourceId: "queue", title: "Queue" };

function queued(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://tracker.test/issues/${number}`,
    createdAt: "2026-11-01T00:00:00Z",
    labels: [],
    handled: false,
    runId: null,
    agentRunId: null,
    ...overrides,
  };
}

/** A stopped worker's snapshot carrying only the rows a test provides. */
function snapshot(queue: Record<string, unknown>[]): Record<string, unknown> {
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
      error: null,
    },
    queue,
    runs: [],
    agents: [],
    cooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    updatedAt: "2026-11-04T21:52:24.395Z",
    workers: [],
    sync: { intervalMs: 30000, lastSyncAt: "2026-11-05T08:57:10.477Z", error: null },
  };
}

afterEach(() => {
  cleanup();
  issues.snapshot = null;
});

test("a handled row shows one handled badge in the success tone and no pending badge", () => {
  issues.handleEvent(snapshot([queued(42, { handled: true, runId: "run-42" })]));

  const view = render(IssuesWorkspace, { props: { tab: QUEUE } });

  const meta = view.getByTestId("issues-queue-item").querySelector(".issues-queue__meta");
  const badges = [...(meta?.querySelectorAll(".badge") ?? [])];
  expect(badges).toHaveLength(1);
  expect(badges[0]?.textContent?.trim()).toBe("handled");
  expect(badges[0]?.getAttribute("data-tone")).toBe("success");
  expect(view.queryByTestId("issues-pending-marker")).toBeNull();
});

test("a processing row stays running when the ledger also says handled", () => {
  issues.handleEvent(
    snapshot([queued(42, { labels: ["processing"], handled: true, runId: "run-42" })]),
  );

  const view = render(IssuesWorkspace, { props: { tab: QUEUE } });

  const meta = view.getByTestId("issues-queue-item").querySelector(".issues-queue__meta");
  const badges = [...(meta?.querySelectorAll(".badge") ?? [])];
  expect(badges).toHaveLength(1);
  expect(badges[0]?.textContent?.trim()).toBe("running");
  expect(badges[0]?.getAttribute("data-tone")).toBe("accent");
  expect(view.queryByTestId("issues-handled-marker")).toBeNull();
});

test("the header summary does not count a handled row as pending", () => {
  issues.handleEvent(snapshot([queued(42, { handled: true, runId: "run-42" })]));

  const view = render(IssuesWorkspace, { props: { tab: QUEUE } });

  expect(view.getByTestId("issues-queue-summary").textContent?.trim()).toBe("0 pending");
});
