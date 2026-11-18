import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: DevboardResources } = await import("./DevboardResources.svelte");
const { resources } = await import("../resources.svelte");
const { connection } = await import("../connection.svelte");

// The app root hands every frame to every store; the refusal the server sends
// for a save reaches this store the same way here.
connection.onMessage((message) => {
  resources.handleEvent(message as Record<string, unknown>);
});

/** Stands in for the dispatch path: the test delivers the answer it expects. */
function recordSends(): { sent: unknown[]; restore: () => void } {
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

const REFUSAL = "Memory max plus reserve exceeds this host's 65536 MB.";

const BUDGET = {
  maxAgentPeers: 4,
  memoryHighMb: 38587,
  memoryMaxMb: 48234,
  memoryReserveMb: 24117,
};

/** One complete `resourcesState` frame; a caller overrides the saved or live section. */
function deliver(
  effective: typeof BUDGET,
  live: Record<string, unknown> = {},
  saved: Record<string, unknown> | null = null,
): Promise<void> {
  resources.handleEvent({
    type: "resourcesState",
    state: {
      saved,
      effective,
      live: {
        activeAgents: 0,
        exemptAgents: 0,
        availableMb: 50000,
        slicePresent: true,
        memoryHighMb: 38587,
        memoryMaxMb: 48234,
        memoryCurrentMb: 0,
        ...live,
      },
    },
  });
  return tick();
}

afterEach(() => {
  cleanup();
  resources.state = null;
  resources.refusal = null;
  resources.confirmed = 0;
});

test("a live-only poll frame leaves an edit in progress alone", async () => {
  const view = render(DevboardResources);
  await tick();
  await deliver(BUDGET);

  const input = view.getByTestId("resource-max-agents") as HTMLInputElement;
  expect(input.value).toBe("4");
  await fireEvent.input(input, { target: { value: "12" } });
  expect(input.value).toBe("12");

  // The page polls `/resources` once a second; a repeated budget with a new
  // live section must not erase the operator's edit.
  await deliver(BUDGET, { availableMb: 49000 });
  expect(input.value).toBe("12");
  expect(view.getByTestId("resource-live-available").textContent).toBe("49000 MB");
});

test("a changed budget still reseeds the form", async () => {
  const view = render(DevboardResources);
  await tick();
  await deliver(BUDGET);

  const input = view.getByTestId("resource-max-agents") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: "12" } });
  expect(input.value).toBe("12");

  // A save made by another client changes the budget and lands here.
  await deliver({ ...BUDGET, maxAgentPeers: 8 });
  expect(input.value).toBe("8");
});

test("the live panel keeps the cap count beside the exempt Discover count", async () => {
  const view = render(DevboardResources);
  await tick();
  await deliver(BUDGET, { activeAgents: 3, exemptAgents: 1 });

  expect(view.getByTestId("resource-live-agents").textContent).toBe("3");
  expect(view.getByTestId("resource-live-exempt-agents").textContent).toBe("1");
});

test("a refused save renders the server's message and ends the latch without a notice", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    const view = render(DevboardResources);
    await tick();
    await deliver(BUDGET);

    const input = view.getByTestId("resource-memory-max") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "50000" } });
    const button = view.getByTestId("resource-save");
    await fireEvent.click(button);
    await tick();

    expect(sends.sent).toContainEqual(
      expect.objectContaining({ type: "setResources", memoryMaxMb: 50000 }),
    );
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent?.trim()).toBe("Saving…");

    // The server refused the save in the lone `error` frame, which names the
    // command it refused; no `resourcesState` frame confirms the budget.
    connection.receiveFrame({ type: "error", message: REFUSAL, command: "setResources" });
    await tick();

    const alert = view.getByTestId("resource-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(REFUSAL);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.textContent?.trim()).toBe("Save");
    expect(view.queryByTestId("save-feedback")).toBeNull();

    // The refusal is the answer: the ceiling has nothing left to report.
    jest.advanceTimersByTime(10_000);
    await tick();
    expect(view.queryByTestId("command-notice")).toBeNull();
    expect(view.queryByTestId("save-feedback")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("an unanswered save keeps its ceiling when a poll lands with the old budget", async () => {
  const sends = recordSends();
  jest.useFakeTimers();
  try {
    const view = render(DevboardResources);
    await tick();
    await deliver(BUDGET);

    const input = view.getByTestId("resource-memory-max") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "50000" } });
    const button = view.getByTestId("resource-save");
    await fireEvent.click(button);
    await tick();
    expect(button.getAttribute("aria-busy")).toBe("true");

    // The invalidation refetch a refused answer triggers answers this poll.
    // The unchanged budget is not a confirmation, so the latch stays armed.
    await deliver(BUDGET);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(view.queryByTestId("save-feedback")).toBeNull();

    jest.advanceTimersByTime(10_000);
    await tick();
    expect(view.getByTestId("command-notice").textContent).toContain(
      "Save received no answer.",
    );
    expect(view.queryByTestId("save-feedback")).toBeNull();
  } finally {
    jest.useRealTimers();
    sends.restore();
  }
});

test("a saved row that carries one figure still renders the form and the live panel", async () => {
  const view = render(DevboardResources);
  await tick();

  // A settings file holding only `maxAgentPeers` is the shape the server
  // documents; the page must not stay at "Loading the resource budget…".
  await deliver({ ...BUDGET, maxAgentPeers: 2 }, { activeAgents: 1 }, { maxAgentPeers: 2 });

  expect(view.getByTestId("resource-origin").textContent).toContain("Saved settings");
  expect((view.getByTestId("resource-max-agents") as HTMLInputElement).value).toBe("2");
  expect((view.getByTestId("resource-memory-high") as HTMLInputElement).value).toBe("38587");
  expect((view.getByTestId("resource-memory-max") as HTMLInputElement).value).toBe("48234");
  expect((view.getByTestId("resource-reserve") as HTMLInputElement).value).toBe("24117");
  expect(view.getByTestId("resource-saved").textContent).toContain("2 agents");
  expect(view.getByTestId("resource-live-agents").textContent).toBe("1");
  expect(view.queryByText("Loading the resource budget…")).toBeNull();
});
