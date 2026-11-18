import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the stores load after registration.
const { cleanup, fireEvent, render, within } = await import("@testing-library/svelte");
const { flushSync, tick } = await import("svelte");
const { default: StatusBar } = await import("./StatusBar.svelte");
const { connection } = await import("../connection.svelte");
const { applyFrames } = await import("../frames");

afterEach(() => {
  cleanup();
  connection.version = null;
  connection.state = "connecting";
  connection.lastError = null;
});

const REPLACEMENT_FAILURE = "The replacement could not start: the port was taken.";

/** A version frame the failing process still serves; only the replacement differs. */
const failureFrame = {
  type: "versionState",
  running: "1.45.1",
  installed: "1.46.0",
  latest: "1.46.0",
  stale: true,
  replacement: { running: "1.45.1", installed: "1.46.0", error: REPLACEMENT_FAILURE },
};

/** The server's twin endpoints, answered without a network. */
function stubTransport(
  restart: () => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ frames: [] }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/server-restarts") return restart();
    if (url === "/ready") {
      return new Response(JSON.stringify({ pid: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

/** The failed replacement's fallback control, already rendered. */
async function presentReload(): Promise<HTMLButtonElement> {
  connection.version = {
    running: "1.45.1",
    installed: "1.46.0",
    latest: "1.46.0",
    stale: true,
    source: true,
    replacement: failureFrame.replacement,
  };
  const { container } = render(StatusBar);
  await tick();
  const button = container.querySelector<HTMLButtonElement>('[data-testid="reload-devboard"]');
  if (button === null) throw new Error("no reload control");
  return button;
}

/** Ends one reload test without leaking its transport, timers, or latch. */
function release(previous: typeof globalThis.fetch): void {
  globalThis.fetch = previous;
  connection.restarting = false;
  connection.awaitingRestart = false;
  jest.useRealTimers();
}

/** Drains the restart request's own answer, then the render it settles. */
async function settleAnswer(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  await tick();
}

test("a refused restart reports the server's reason instead of the ceiling notice", async () => {
  jest.useFakeTimers();
  const previous = globalThis.fetch;
  const refusal = "A server restart is already in progress.";
  try {
    stubTransport(
      () =>
        new Response(
          JSON.stringify({
            frames: [{ type: "error", message: refusal, command: "restartServer" }],
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
    );
    const button = await presentReload();
    await fireEvent.click(button);
    await settleAnswer();

    // The refusal travels under the route's success status, so only the
    // answer's own frame names it; there is no version frame to wait for.
    expect(connection.lastError).toBe(refusal);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.textContent?.trim()).toBe("reload");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    await tick();
    expect(button.closest("footer")?.querySelector(".command-notice")).toBeNull();
  } finally {
    release(previous);
  }
});

test("a version frame settles a reload whose request is still unanswered", async () => {
  jest.useFakeTimers();
  const previous = globalThis.fetch;
  try {
    stubTransport(() => new Promise<Response>(() => undefined));
    const button = await presentReload();
    await fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");

    // The server's own frame answers a request that is still in flight, so the
    // control still latches on the version revision it carries.
    applyFrames([failureFrame]);
    await tick();

    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.textContent?.trim()).toBe("reload");
    expect(button.closest("footer")?.querySelector(".command-notice")).toBeNull();
  } finally {
    release(previous);
  }
});

test("a retry no answer reaches still shows the ceiling notice", async () => {
  jest.useFakeTimers();
  const previous = globalThis.fetch;
  try {
    stubTransport(() => new Promise<Response>(() => undefined));
    const button = await presentReload();
    await fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    await tick();

    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.closest("footer")?.querySelector(".command-notice")?.textContent).toContain(
      "Reload received no answer.",
    );
  } finally {
    release(previous);
  }
});

async function present(version: NonNullable<typeof connection.version>): Promise<HTMLElement> {
  connection.version = version;
  const { container } = render(StatusBar);
  await tick();
  return container;
}

test("a dashboard behind the newest published release renders the drift", async () => {
  const container = await present({
    running: "1.53.0",
    installed: "1.55.0",
    latest: "1.55.0",
    stale: true,
    source: true,
  });
  const versions = within(container).getByTestId("status-versions");
  expect(versions.getAttribute("data-stale")).toBe("true");
  const drift = within(container).getByTestId("status-version-drift");
  expect(drift.textContent).toContain("latest");
  expect(drift.textContent).toContain("1.55.0");
  expect(drift.getAttribute("title")).toContain("1.53.0");
  expect(drift.getAttribute("title")).toContain("1.55.0");
});

test("a dashboard running the newest release renders no drift", async () => {
  const container = await present({
    running: "1.55.0",
    installed: "1.55.0",
    latest: "1.55.0",
    stale: false,
    source: true,
  });
  const versions = within(container).getByTestId("status-versions");
  expect(versions.getAttribute("data-stale")).toBe("false");
  expect(within(container).queryByTestId("status-version-drift")).toBeNull();
});

test("a lost transport renders Disconnected and the next answer restores Connected", () => {
  // Files in the suite run concurrently over one connection store, so each
  // state change is flushed synchronously: the render asserted is the state set.
  connection.lastError = null;
  connection.state = "open";
  const { container } = render(StatusBar);
  flushSync();
  const word = within(container).getByTestId("status-connection");
  const dot = container.querySelector<HTMLElement>(".status-dot");
  if (dot === null) throw new Error("no status dot");
  expect(word.textContent).toBe("Connected");
  expect(dot.getAttribute("data-state")).toBe("open");

  connection.noticeTransportFailure();
  flushSync();
  expect(word.textContent).toBe("Disconnected");
  expect(dot.getAttribute("data-state")).toBe("closed");
  expect(dot.parentElement?.getAttribute("title")).toBe("Could not reach the server.");

  connection.noticeTransportAnswer();
  flushSync();
  expect(word.textContent).toBe("Connected");
  expect(dot.getAttribute("data-state")).toBe("open");
  expect(dot.parentElement?.getAttribute("title")).toBe("The server is answering requests.");
});
