import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { Event as DomEvent } from "happy-dom";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket so the page sees a real open connection. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: FakeEnvelope) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

const globals = globalThis as unknown as Record<string, unknown>;

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render, within } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { agents } = await import("../agents.svelte");
// Loaded after the DOM globals, like every other store the component reads.
const { connection } = await import("../connection.svelte");
const { layout } = await import("../layout.svelte");
const { pageVisibility } = await import("../page-visibility.svelte");
const { default: AgentPage } = await import("./AgentPage.svelte");
const { default: QueryHarness } = await import("./QueryHarness.svelte");

/**
 * Opens the shared connection over a stub socket, the one path that makes
 * `connection.open` true without a live server. A bare `state = "open"` would
 * leave the store with no socket, so the page's own refresh send would report
 * a connection failure instead.
 */
function openConnection(): FakeSocket {
  globals.WebSocket = FakeSocket;
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  return socket;
}

afterEach(() => {
  cleanup();
  connection.dispose();
  FakeSocket.instances = [];
  agents.requestedPrompts = [];
  agents.releaseRuns = {};
  agents.releaseGates = {};
  connection.state = "connecting";
  layout.setMode("goal");
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

// The page reads the shared connection store, and Start is disabled unless that
// store is open, so a test that leaves it at its "connecting" default can never
// see an enabled control. A test that cares names the state; an omitted one
// leaves whatever the test set up, and every test starts from "connecting".
function present(agent: Record<string, unknown>, state?: typeof connection.state) {
  if (state === "open") openConnection();
  else if (state !== undefined) connection.state = state;
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

test("the header states the forge sync verdict beside the last read", () => {
  const at = "2026-11-03T10:15:00.000Z";
  const stale = present(releaseSnapshot({ sync: { state: "stale", at, error: null } }));
  const staleState = within(stale.container).getByTestId("agent-sync-state");
  expect(staleState.textContent?.trim()).toBe("stale");
  expect(staleState.getAttribute("data-tone")).toBe("stale");

  const fresh = present(releaseSnapshot({ sync: { state: "ok", at, error: null } }));
  const freshState = within(fresh.container).getByTestId("agent-sync-state");
  expect(freshState.textContent?.trim()).toBe("ok");
  expect(freshState.getAttribute("data-tone")).toBeNull();
});

test("Start is enabled for a stopped agent on an open connection", () => {
  const view = present(
    releaseSnapshot({ lifecycle: "stopped", attached: false, owned: false, notice: null }),
    "open",
  );
  const start = within(view.container).getByTestId("agent-start");
  expect(start.hasAttribute("disabled")).toBe(false);
});

test("Start is disabled while the agent is starting", () => {
  const view = present(
    releaseSnapshot({ lifecycle: "starting", attached: false, owned: false, notice: null }),
    "open",
  );
  const start = within(view.container).getByTestId("agent-start");
  expect(start.hasAttribute("disabled")).toBe(true);
});

test("Start is disabled while the connection is closed", () => {
  const view = present(
    releaseSnapshot({ lifecycle: "stopped", attached: false, owned: false, notice: null }),
    "closed",
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

test("a frame without workers renders the page with no live worker row", () => {
  const withoutWorkers = releaseSnapshot({});
  delete withoutWorkers.workers;
  const view = present(withoutWorkers);
  expect(within(view.container).getByTestId("agent-header")).toBeTruthy();
  expect(within(view.container).queryByTestId("agent-workers")).toBeNull();
  expect(agents.snapshot("release-train")?.workers).toEqual([]);
});

/** Stub the socket so a test observes exactly what a Save control sent. */
function recordSettingsSends(): { sent: unknown[]; restore: () => void } {
  const previous = connection.send;
  const sent: unknown[] = [];
  connection.send = (command: unknown) => {
    sent.push(command);
    return true;
  };
  return {
    sent,
    restore: () => {
      connection.send = previous;
    },
  };
}

function settingsFrames(sent: unknown[]): unknown[] {
  return sent.filter(
    (command) =>
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      command.type === "setAgentSettings",
  );
}

test("Save limits with an invalid cadence states the refusal and never claims no answer", async () => {
  const previous = connection.state;
  connection.state = "open";
  const socket = recordSettingsSends();
  jest.useFakeTimers();
  try {
    const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }));
    const cadenceField = within(view.container).getByTestId("agent-cadence") as HTMLInputElement;
    await fireEvent.input(cadenceField, { target: { value: "" } });
    const limits = within(view.container).getByTestId("agent-save-limits");
    await fireEvent.click(limits);
    expect(within(view.container).getByTestId("agent-settings-error").textContent).toContain(
      "The cadence must be an integer from 1 through 1440 minutes.",
    );
    // Nothing was dispatched, so the control is not busy and asks for no answer.
    expect(settingsFrames(socket.sent)).toEqual([]);
    expect(limits.hasAttribute("disabled")).toBe(false);
    expect(limits.getAttribute("aria-busy")).toBeNull();
    expect(view.container.querySelector('[data-slot="button-busy"]')).toBeNull();
    expect(within(view.container).queryByTestId("command-notice")).toBeNull();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(within(view.container).queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
    socket.restore();
    connection.state = previous;
  }
});

test("Save limits dispatches one settings command and waits for its answer", async () => {
  const previous = connection.state;
  connection.state = "open";
  const socket = recordSettingsSends();
  jest.useFakeTimers();
  try {
    const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }));
    const limits = within(view.container).getByTestId("agent-save-limits");
    await fireEvent.click(limits);
    expect(settingsFrames(socket.sent)).toEqual([
      {
        type: "setAgentSettings",
        id: "release-train",
        minutes: 10,
        maxPerHour: null,
        maxPending: null,
      },
    ]);
    expect(limits.getAttribute("aria-busy")).toBe("true");
    expect(limits.textContent?.trim()).toBe("Saving…");
    // No confirming frame arrives, so the ceiling is the only answer.
    expect(within(view.container).queryByTestId("command-notice")).toBeNull();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(within(view.container).getByTestId("command-notice").textContent).toContain(
      "Save limits received no answer.",
    );
  } finally {
    jest.useRealTimers();
    socket.restore();
    connection.state = previous;
  }
});

test("a non-numeric limit entry is refused instead of being saved as unlimited", async () => {
  const previous = connection.state;
  connection.state = "open";
  const socket = recordSettingsSends();
  try {
    const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }));
    const hourField = within(view.container).getByTestId("agent-limit-hour") as HTMLInputElement;
    const pendingField = within(view.container).getByTestId(
      "agent-limit-pending",
    ) as HTMLInputElement;
    await fireEvent.input(hourField, { target: { value: "-" } });
    await fireEvent.input(pendingField, { target: { value: "." } });
    // The fields keep what the operator typed, so the refusal stays reachable.
    expect(hourField.value).toBe("-");
    expect(pendingField.value).toBe(".");

    const limits = within(view.container).getByTestId("agent-save-limits");
    await fireEvent.click(limits);

    const error = within(view.container).getByTestId("agent-settings-error");
    expect(error.textContent).toContain(
      "Both limits must be empty or integers from 1 through 100.",
    );
    // The refusal sits beside the limit fields, not in the page alert stack.
    expect(error.closest('[aria-label="Filing limits"]')).not.toBeNull();
    // Nothing was dispatched, so no save is confirmed and none is awaited.
    expect(settingsFrames(socket.sent)).toEqual([]);
    expect(limits.getAttribute("aria-busy")).toBeNull();
    expect(within(view.container).queryByTestId("command-notice")).toBeNull();
    // The refused save leaves the visible text where the operator left it.
    expect(hourField.value).toBe("-");
    expect(pendingField.value).toBe(".");
  } finally {
    socket.restore();
    connection.state = previous;
  }
});

test("a limit field holding an integer sends that integer", async () => {
  const previous = connection.state;
  connection.state = "open";
  const socket = recordSettingsSends();
  jest.useFakeTimers();
  try {
    const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }));
    const hourField = within(view.container).getByTestId("agent-limit-hour") as HTMLInputElement;
    const pendingField = within(view.container).getByTestId(
      "agent-limit-pending",
    ) as HTMLInputElement;
    await fireEvent.input(hourField, { target: { value: "5" } });
    await fireEvent.input(pendingField, { target: { value: "7" } });
    await fireEvent.click(within(view.container).getByTestId("agent-save-limits"));
    expect(settingsFrames(socket.sent)).toEqual([
      {
        type: "setAgentSettings",
        id: "release-train",
        minutes: 10,
        maxPerHour: 5,
        maxPending: 7,
      },
    ]);
    expect(within(view.container).queryByTestId("agent-settings-error")).toBeNull();
  } finally {
    jest.useRealTimers();
    socket.restore();
    connection.state = previous;
  }
});

test("switching to an agent with the same saved settings rewrites the fields from its snapshot", async () => {
  const previous = connection.state;
  connection.state = "open";
  const socket = recordSettingsSends();
  try {
    const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }));
    const cadenceField = within(view.container).getByTestId("agent-cadence") as HTMLInputElement;
    const hourField = within(view.container).getByTestId("agent-limit-hour") as HTMLInputElement;
    await fireEvent.input(cadenceField, { target: { value: "20" } });
    await fireEvent.input(hourField, { target: { value: "5" } });
    // A refused save leaves an error the next agent must not inherit.
    await fireEvent.input(cadenceField, { target: { value: "" } });
    await fireEvent.click(within(view.container).getByTestId("agent-save-limits"));
    expect(within(view.container).getByTestId("agent-settings-error")).toBeTruthy();
    expect(settingsFrames(socket.sent)).toEqual([]);

    // Watchdog's saved settings carry the same 10/null/null signature, so the
    // signature alone would keep the text typed for the Release Train.
    agents.handleEvent({
      type: "agentState",
      agent: releaseSnapshot({
        id: "watchdog",
        label: "Watchdog",
        detail: { panel: "cycles", cycles: [] },
      }),
    });
    await view.rerender({ agentId: "watchdog" });

    const switchedCadence = within(view.container).getByTestId(
      "agent-cadence",
    ) as HTMLInputElement;
    const switchedHour = within(view.container).getByTestId(
      "agent-limit-hour",
    ) as HTMLInputElement;
    expect(switchedCadence.value).toBe("10");
    expect(switchedHour.value).toBe("");
    expect(within(view.container).queryByTestId("agent-settings-error")).toBeNull();

    await fireEvent.click(within(view.container).getByTestId("agent-save-limits"));
    expect(settingsFrames(socket.sent)).toEqual([
      {
        type: "setAgentSettings",
        id: "watchdog",
        minutes: 10,
        maxPerHour: null,
        maxPending: null,
      },
    ]);
  } finally {
    socket.restore();
    connection.state = previous;
  }
});

test("an agent page asks for that agent's prompt and renders its answer", async () => {
  delete agents.prompts["release-train"];
  delete agents.promptErrors["release-train"];
  const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }), "open");
  // The prompt section is a one-shot query in the plan; opening it records the
  // agent whose document the plan mounts.
  expect(agents.requestedPrompts).toContain("release-train");
  expect(within(view.container).getByText("Loading the prompt…")).toBeTruthy();

  agents.handleEvent({
    type: "agentPromptState",
    id: "release-train",
    prompt: { id: "release-train", absent: false, text: "Release the train.", error: null },
  });
  await tick();
  expect(within(view.container).getByTestId("agent-prompt-text").textContent).toBe(
    "Release the train.",
  );
  expect(within(view.container).queryByText("Loading the prompt…")).toBeNull();
});

test("a refused prompt read states the refusal instead of the loading hint", async () => {
  delete agents.prompts["release-train"];
  delete agents.promptErrors["release-train"];
  const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }), "open");
  agents.handleEvent({
    type: "agentPromptError",
    id: "release-train",
    message: "Unknown background agent: release-train.",
  });
  await tick();
  const error = within(view.container).getByTestId("agent-prompt-error");
  expect(error.getAttribute("role")).toBe("alert");
  expect(error.textContent).toBe("Unknown background agent: release-train.");
  expect(within(view.container).queryByText("Loading the prompt…")).toBeNull();
});

test("switching agents requests the newly shown agent's prompt", async () => {
  delete agents.prompts["scout"];
  delete agents.promptErrors["scout"];
  const view = present(releaseSnapshot({ attached: true, owned: true, notice: null }), "open");
  expect(agents.requestedPrompts).toContain("release-train");

  await view.rerender({ agentId: "scout" });
  await tick();
  expect(agents.requestedPrompts).toContain("scout");
  expect(within(view.container).getByTestId("agent-prompt").getAttribute("data-agent")).toBe(
    "scout",
  );
});

// The page-open read is one command per open, and nothing a frame writes may
// send it again. These tests count the wire commands a stub socket received.

function refreshFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .filter((command) => command.type === "refreshAgent");
}

/** Flushes Svelte's effect queue and the microtasks a mutation schedules. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

/** Answers the plan's reads so a mounted QueryHarness stays quiet. */
function emptyFetch(): () => void {
  const previous = globalThis.fetch;
  globals.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ frames: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  return () => {
    globals.fetch = previous;
  };
}

test("an agent page refresh sends once per open, not once per pushed frame", async () => {
  const restoreFetch = emptyFetch();
  try {
    // The page's own workspace is the one on screen; only a shown page asks
    // for its read.
    layout.setMode("devboard");
    const socket = openConnection();
    agents.handleEvent({
      type: "agentState",
      agent: releaseSnapshot({ attached: true, owned: true, notice: null }),
    });
    render(QueryHarness);
    await tick();
    const view = render(AgentPage, { props: { agentId: "release-train" } });
    await settle();
    expect(refreshFrames(socket).map((command) => command.id)).toEqual(["release-train"]);

    // The answer to that refresh is one pushed agents frame; it must not send.
    agents.handleEvent({
      type: "agentsState",
      agents: [releaseSnapshot({ attached: true, owned: true, notice: null })],
    });
    await settle();
    expect(refreshFrames(socket)).toHaveLength(1);

    // A second page is a second open: the next agent id asks for its own read.
    agents.handleEvent({
      type: "agentState",
      agent: releaseSnapshot({
        id: "watchdog",
        label: "Watchdog",
        detail: { panel: "cycles", cycles: [] },
      }),
    });
    await view.rerender({ agentId: "watchdog" });
    await settle();
    expect(refreshFrames(socket).map((command) => command.id)).toEqual([
      "release-train",
      "watchdog",
    ]);
  } finally {
    restoreFetch();
  }
});

test("the Release Train page renders the live phase and follows new records without a reload", async () => {
  const started = "2026-11-13T10:00:00.000Z";
  const fetched = {
    at: started,
    phase: "fetch",
    detail: "fetched origin/main at abc",
    attempt: null,
    passed: null,
    failed: null,
    ciRun: null,
    conclusion: null,
    assets: null,
  };
  const suite = {
    at: started,
    phase: "suite",
    detail: "attempt 1/9: 2 fail, 98 pass, 0 skip",
    attempt: 1,
    passed: 98,
    failed: 2,
    ciRun: null,
    conclusion: null,
    assets: null,
  };
  const tag = {
    at: started,
    phase: "tag",
    detail: "pushed v1.1.0",
    attempt: null,
    passed: null,
    failed: null,
    ciRun: null,
    conclusion: null,
    assets: null,
  };
  const live = (phase: string, phaseElapsedMs: number, records: unknown[]) =>
    releaseSnapshot({
      cadence: {
        minutes: 10,
        defaultMinutes: 10,
        lastRunAt: started,
        nextRunAt: "2026-11-13T10:10:00.000Z",
      },
      run: {
        id: "run-1",
        state: "running",
        range: "v1.0.0..abc",
        target: "abc",
        version: "1.1.0",
        peerPid: 4242,
        startedAt: new Date(Date.parse(started) - 125_000).toISOString(),
        elapsedMs: 125_000,
        phase,
        phaseStartedAt: new Date(Date.parse(started) - phaseElapsedMs).toISOString(),
        phaseElapsedMs,
        records,
      },
      gate: {
        state: "unreleased",
        at: started,
        detail: null,
        target: "abc",
        range: "v1.0.0..abc",
        version: "1.1.0",
      },
    });

  jest.useFakeTimers();
  jest.setSystemTime(Date.parse(started));
  try {
    const view = present(live("suite", 45_000, [fetched, suite]));
    const page = within(view.container);
    const phase = page.getByTestId("release-run-phase");
    expect(phase.getAttribute("data-phase")).toBe("suite");
    expect(page.getByTestId("release-run-phase-elapsed").textContent).toContain("45s");
    expect(page.getByTestId("release-run-elapsed").textContent).toContain("2m 5s");
    expect(page.getByTestId("release-run-range").textContent).toContain("v1.0.0..abc");
    expect(page.getByTestId("release-run-target").textContent).toContain("abc");
    expect(page.getByTestId("release-run-version").textContent).toContain("1.1.0");
    expect(page.getByTestId("release-run-peer").textContent).toContain("4242");
    expect(page.getByTestId("release-run-gate-state").textContent).toContain("unreleased");
    expect(page.getByTestId("release-run-gate-range").textContent).toContain("v1.0.0..abc");
    expect(page.getByTestId("release-run-gate-version").textContent).toContain("1.1.0");
    expect(page.getByTestId("release-run-next").textContent).toContain("10:10");
    expect(
      page.getByTestId("release-progress-log").querySelectorAll(".release-log__line").length,
    ).toBe(2);

    // A pushed frame is the only thing that changes: no operator reload.
    agents.handleEvent({
      type: "agentState",
      agent: live("tag", 3_000, [fetched, suite, tag]),
    });
    await tick();
    expect(page.getByTestId("release-run-phase").getAttribute("data-phase")).toBe("tag");
    expect(page.getByTestId("release-run-phase-elapsed").textContent).toContain("3s");
    expect(
      page.getByTestId("release-progress-log").querySelectorAll(".release-log__line").length,
    ).toBe(3);
  } finally {
    jest.useRealTimers();
  }
});

test("a live release run's durations tick without a new frame", async () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  jest.useFakeTimers();
  jest.setSystemTime(now);
  try {
    const view = present(
      releaseSnapshot({
        run: {
          id: "run-1",
          state: "running",
          range: "v1.0.0..abc",
          target: "abc",
          version: "1.1.0",
          peerPid: 4242,
          startedAt: new Date(now - 125_000).toISOString(),
          elapsedMs: 125_000,
          phase: "suite",
          phaseStartedAt: new Date(now - 45_000).toISOString(),
          phaseElapsedMs: 45_000,
          records: [],
        },
      }),
    );
    const page = within(view.container);
    expect(page.getByTestId("release-run-phase-elapsed").textContent).toContain("45s");
    expect(page.getByTestId("release-run-elapsed").textContent).toContain("2m 5s");

    // The projection froze when the suite heartbeat last wrote; a minute of
    // page time advances both durations with nothing new on disk.
    jest.advanceTimersByTime(60_000);
    await tick();
    expect(page.getByTestId("release-run-phase-elapsed").textContent).toContain("1m 45s");
    expect(page.getByTestId("release-run-elapsed").textContent).toContain("3m 5s");
  } finally {
    jest.useRealTimers();
  }
});

test("a page mounted while the connection connects refresh sends once when it opens", async () => {
  const restoreFetch = emptyFetch();
  try {
    layout.setMode("devboard");
    render(QueryHarness);
    await tick();
    globals.WebSocket = FakeSocket;
    connection.connect();
    const socket = FakeSocket.instances[0];
    if (socket === undefined) throw new Error("no socket created");
    agents.handleEvent({
      type: "agentState",
      agent: releaseSnapshot({ attached: true, owned: true, notice: null }),
    });
    render(AgentPage, { props: { agentId: "release-train" } });
    await settle();
    expect(refreshFrames(socket)).toEqual([]);

    socket.open();
    await settle();
    expect(refreshFrames(socket).map((command) => command.id)).toEqual(["release-train"]);

    agents.handleEvent({
      type: "agentsState",
      agents: [releaseSnapshot({ attached: true, owned: true, notice: null })],
    });
    await settle();
    expect(refreshFrames(socket)).toHaveLength(1);
  } finally {
    restoreFetch();
  }
});

test("an agent page refresh is not retriggered by the mutation that sends it", async () => {
  // No stub socket here: this is the app root's real command path, where
  // `connection.send` runs the TanStack mutation. Hang the POST so only the
  // local reactive state can resend, then count the requests.
  const previousFetch = globalThis.fetch;
  const posts: string[] = [];
  const held = Promise.withResolvers<Response>();
  globals.fetch = (input: RequestInfo | URL) => {
    const path = String(input);
    posts.push(path);
    if (path.endsWith("/refreshes")) return held.promise;
    return Promise.resolve(
      new Response(JSON.stringify({ frames: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    layout.setMode("devboard");
    agents.handleEvent({
      type: "agentState",
      agent: releaseSnapshot({ attached: true, owned: true, notice: null }),
    });
    render(QueryHarness);
    await tick();
    // No socket double: `connect` opens without a transport, so every command
    // runs the app root's mutation, as it does in the browser.
    const previousSocket = globals.WebSocket;
    delete globals.WebSocket;
    connection.connect();
    render(AgentPage, { props: { agentId: "release-train" } });
    await settle();
    expect(posts.filter((path) => path.endsWith("/refreshes"))).toHaveLength(1);

    connection.receiveFrame({
      type: "agentsState",
      agents: [releaseSnapshot({ attached: true, owned: true, notice: null })],
    });
    await settle();
    expect(posts.filter((path) => path.endsWith("/refreshes"))).toHaveLength(1);
    globals.WebSocket = previousSocket;
  } finally {
    globals.fetch = previousFetch;
    held.resolve(
      new Response(JSON.stringify({ frames: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }
});

// A page the operator cannot see asks for nothing. Every mode workspace stays
// mounted, so a page left behind a shown mode used to nudge its worker while
// another mode rendered — and the browser defers and throttles that work, so
// the page-open action was measured against its own first paint.

test("an agent page behind another mode sends no refresh until the workspace is shown", async () => {
  const restoreFetch = emptyFetch();
  try {
    layout.setMode("issues");
    const socket = openConnection();
    agents.handleEvent({
      type: "agentState",
      agent: releaseSnapshot({ attached: true, owned: true, notice: null }),
    });
    render(QueryHarness);
    await tick();
    render(AgentPage, { props: { agentId: "release-train" } });
    await settle();
    expect(refreshFrames(socket)).toEqual([]);

    // The first moment the workspace is on screen is the page's own open; the
    // boot that mounted it hidden asks for nothing.
    layout.setMode("devboard");
    await settle();
    expect(refreshFrames(socket).map((command) => command.id)).toEqual(["release-train"]);

    agents.handleEvent({
      type: "agentsState",
      agents: [releaseSnapshot({ attached: true, owned: true, notice: null })],
    });
    await settle();
    expect(refreshFrames(socket)).toHaveLength(1);
  } finally {
    restoreFetch();
  }
});

test("a page opened in a hidden document sends no refresh until the document is visible", async () => {
  const restoreFetch = emptyFetch();
  const stopVisibility = pageVisibility.install();
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    layout.setMode("devboard");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new DomEvent("visibilitychange") as unknown as Event);
    expect(pageVisibility.visible).toBe(false);

    const socket = openConnection();
    agents.handleEvent({
      type: "agentState",
      agent: releaseSnapshot({ attached: true, owned: true, notice: null }),
    });
    render(QueryHarness);
    await tick();
    render(AgentPage, { props: { agentId: "release-train" } });
    await settle();
    expect(refreshFrames(socket)).toEqual([]);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new DomEvent("visibilitychange") as unknown as Event);
    await settle();
    expect(refreshFrames(socket).map((command) => command.id)).toEqual(["release-train"]);

    agents.handleEvent({
      type: "agentsState",
      agents: [releaseSnapshot({ attached: true, owned: true, notice: null })],
    });
    await settle();
    expect(refreshFrames(socket)).toHaveLength(1);
  } finally {
    stopVisibility();
    if (visibility === undefined) Reflect.deleteProperty(document, "visibilityState");
    else Object.defineProperty(document, "visibilityState", visibility);
    document.dispatchEvent(new DomEvent("visibilitychange") as unknown as Event);
    restoreFetch();
  }
});
