import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: DevboardResources } = await import("./DevboardResources.svelte");
const { resources } = await import("../resources.svelte");

const BUDGET = {
  maxAgentPeers: 4,
  memoryHighMb: 38587,
  memoryMaxMb: 48234,
  memoryReserveMb: 24117,
};

/** One complete `resourcesState` frame; a caller overrides the live section. */
function deliver(
  effective: typeof BUDGET,
  live: Record<string, unknown> = {},
): Promise<void> {
  resources.handleEvent({
    type: "resourcesState",
    state: {
      saved: null,
      effective,
      live: {
        activeAgents: 0,
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
