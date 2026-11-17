import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the stores load after registration.
const { cleanup, fireEvent, render, within } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: StatusBar } = await import("./StatusBar.svelte");
const { connection } = await import("../connection.svelte");
const { applyFrames } = await import("../frames");

afterEach(() => {
  cleanup();
  connection.version = null;
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
function stubTransport(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/server-restarts") return new Response(null, { status: 202 });
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

test("a failure frame settles the reload busy word instead of the ceiling notice", async () => {
  jest.useFakeTimers();
  const previous = globalThis.fetch;
  try {
    stubTransport();
    const button = await presentReload();
    await fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent?.trim()).toBe("Reloading…");

    // The answered retry: `running` is unchanged, so only the frame's arrival
    // proves the server answered.
    applyFrames([failureFrame]);
    await tick();

    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.textContent?.trim()).toBe("reload");
    expect(button.closest("footer")?.querySelector(".command-notice")).toBeNull();
  } finally {
    release(previous);
  }
});

test("a retry no frame answers still shows the ceiling notice", async () => {
  jest.useFakeTimers();
  const previous = globalThis.fetch;
  try {
    stubTransport();
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
