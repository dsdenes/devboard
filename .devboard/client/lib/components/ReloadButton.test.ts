import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the stores load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { createRawSnippet, tick } = await import("svelte");
const { default: ReloadButton } = await import("./ReloadButton.svelte");
const { connection } = await import("../connection.svelte");
const { applyFrames } = await import("../frames");

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

/** The unsupported-viewport copy: the failed replacement's default-variant retry. */
async function presentUnsupportedReset(): Promise<HTMLButtonElement> {
  connection.version = {
    running: "1.45.1",
    installed: "1.46.0",
    latest: "1.46.0",
    stale: true,
    source: true,
    replacement: failureFrame.replacement,
  };
  const children = createRawSnippet(() => ({ render: () => "<span>Restart devboard</span>" }));
  const { container } = render(ReloadButton, {
    props: {
      variant: "default",
      label: "Reload",
      children,
      "data-command": "app.reload",
      "data-testid": "reload-devboard",
      disabled: false,
    },
  });
  await tick();
  const button = container.querySelector<HTMLButtonElement>('[data-testid="reload-devboard"]');
  if (button === null) throw new Error("no reload control");
  return button;
}

afterEach(() => {
  cleanup();
  connection.version = null;
  connection.restarting = false;
  connection.awaitingRestart = false;
  jest.useRealTimers();
});

test("the unsupported-viewport reload settles on the frame that reports the failure", async () => {
  jest.useFakeTimers();
  const previous = globalThis.fetch;
  try {
    stubTransport();
    const button = await presentUnsupportedReset();
    await fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent?.trim()).toBe("Reloading…");

    // The answered retry: `running` is unchanged, so only the frame's arrival
    // proves the server answered.
    applyFrames([failureFrame]);
    await tick();

    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.textContent?.trim()).toBe("Restart devboard");
    expect(button.parentElement?.querySelector(".command-notice") ?? null).toBeNull();
  } finally {
    globalThis.fetch = previous;
  }
});

test("the unsupported-viewport reload still reports a retry no frame answers", async () => {
  jest.useFakeTimers();
  const previous = globalThis.fetch;
  try {
    stubTransport();
    const button = await presentUnsupportedReset();
    await fireEvent.click(button);
    expect(button.getAttribute("aria-busy")).toBe("true");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    await tick();

    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.parentElement?.querySelector(".command-notice")?.textContent).toContain(
      "Reload received no answer.",
    );
  } finally {
    globalThis.fetch = previous;
  }
});
