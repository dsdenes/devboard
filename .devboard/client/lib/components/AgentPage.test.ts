import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render, within } = await import("@testing-library/svelte");
const { agents } = await import("../agents.svelte");
// Loaded after the DOM globals, like every other store the component reads.
const { connection } = await import("../connection.svelte");
const { default: AgentPage } = await import("./AgentPage.svelte");

afterEach(() => {
  cleanup();
});

const FOREIGN_NOTICE =
  "Release Train is running for this root from another dashboard (STATE_DIR /elsewhere).";

function releaseSnapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "release-train",
    label: "Release Train",
    description: "",
    scope: "repository",
    lifecycle: "running",
    paused: false,
    enabled: true,
    owned: true,
    attached: true,
    cadence: { minutes: 10, defaultMinutes: 10, lastRunAt: null, nextRunAt: null },
    limits: { maxPerHour: null, maxPending: null },
    issues: [],
    documentation: [],
    releases: [],
    pending: 0,
    sync: { state: "ok", at: null, error: null },
    detail: { panel: "activity", scanId: "idle:0", entries: [] },
    notice: null,
    error: null,
    timer: null,
    workers: [],
    ...overrides,
  };
}

function present(agent: Record<string, unknown>) {
  agents.handleEvent({ type: "agentState", agent });
  return render(AgentPage, { props: { agentId: "release-train" } });
}

test("a worker another dashboard owns reads running and says why Start starts nothing", () => {
  const view = present(
    releaseSnapshot({ attached: true, owned: false, notice: FOREIGN_NOTICE }),
  );
  const notice = within(view.container).getByTestId("agent-notice");
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.textContent).toContain("another dashboard");
  expect(notice.textContent).toContain("/elsewhere");
  // The page offers Start because this dashboard owns no worker.
  expect(within(view.container).queryByTestId("agent-stop")).toBeNull();
  expect(within(view.container).getByTestId("agent-start")).toBeTruthy();
});

test("an owned worker shows Stop and no ownership notice", () => {
  const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }));
  expect(within(view.container).queryByTestId("agent-notice")).toBeNull();
  expect(within(view.container).getByTestId("agent-stop")).toBeTruthy();
});

test("Start is disabled while the agent is starting", () => {
  const view = present(
    releaseSnapshot({ lifecycle: "starting", attached: false, owned: false, notice: null }),
  );
  const start = within(view.container).getByTestId("agent-start");
  expect(start.hasAttribute("disabled")).toBe(true);
});

test("both settings Save controls are disabled and send nothing with the socket closed", async () => {
  const previous = connection.state;
  connection.state = "closed";
  try {
    const view = present(releaseSnapshot({ attached: false, owned: false, notice: null }));
    const cadenceField = within(view.container).getByTestId("agent-cadence") as HTMLInputElement;
    await fireEvent.input(cadenceField, { target: { value: "42" } });
    expect(cadenceField.value).toBe("42");
    const cadence = within(view.container).getByTestId("agent-save-cadence");
    const limits = within(view.container).getByTestId("agent-save-limits");
    expect(cadence.hasAttribute("disabled")).toBe(true);
    expect(limits.hasAttribute("disabled")).toBe(true);
    await fireEvent.click(cadence);
    expect(within(view.container).queryByTestId("command-notice")).toBeNull();
    expect(view.container.querySelector('[data-slot="button-busy"]')).toBeNull();
    // The refused save never claims the field's value as saved.
    expect(cadenceField.value).toBe("42");
  } finally {
    connection.state = previous;
  }
});
