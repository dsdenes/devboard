import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the stores load after registration.
const { cleanup, render, within } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: StatusBar } = await import("./StatusBar.svelte");
const { connection } = await import("../connection.svelte");

afterEach(() => {
  cleanup();
  connection.version = null;
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
