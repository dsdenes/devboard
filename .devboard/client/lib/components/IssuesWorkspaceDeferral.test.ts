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

const DEFERRAL =
  "issue #1453 deferred: 24 agent peer(s) already run at the cap of 24 " +
  "(Watchdog 12, Auto Scout 12); the start is deferred";

/** A snapshot with a live worker and no open work. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "issuesState",
    present: true,
    repo: "acme/app",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    paused: false,
    attached: true,
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
    deferral: null,
    updatedAt: "2026-11-07T18:00:00.000Z",
    workers: [],
    sync: { intervalMs: 30000, lastSyncAt: null, error: null },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  issues.snapshot = null;
});

test("the deferral in force is its own line", () => {
  issues.handleEvent(snapshot({ deferral: DEFERRAL }));

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });

  expect(view.getByTestId("issues-deferral").textContent?.trim()).toBe(DEFERRAL);
  expect(view.getByTestId("issues-deferral").getAttribute("role")).toBe("status");
  expect(view.queryByTestId("issues-notice")).toBeNull();
});

test("a resolved deferral leaves no line behind", () => {
  issues.handleEvent(snapshot({ deferral: null, notice: "Check now is unavailable while paused." }));

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });

  expect(view.queryByTestId("issues-deferral")).toBeNull();
  expect(view.getByTestId("issues-notice").textContent?.trim()).toBe(
    "Check now is unavailable while paused.",
  );
});

test("a deferral-shaped notice from an older harness is never shown", () => {
  issues.handleEvent(snapshot({ deferral: null, notice: DEFERRAL }));

  const view = render(IssuesWorkspace, { props: { tab: OVERVIEW } });

  expect(view.queryByTestId("issues-deferral")).toBeNull();
  expect(view.queryByTestId("issues-notice")).toBeNull();
});
