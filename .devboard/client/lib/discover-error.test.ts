import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectionStore } from "./connection.svelte";
import { DiscoverStore } from "./discover.svelte";
import { notifications } from "./notifications.svelte";

function connect(): DiscoverStore {
  return new DiscoverStore({} as unknown as ConnectionStore);
}

afterEach(() => notifications.clear());

describe("discover failures", () => {
  test("a run failure stays on its agent's card and off every other surface", () => {
    const discover = connect();
    const message = "The Contribution Agent run failed: the server exit interrupted the run.";
    discover.handleEvent({ type: "discoverError", agent: "discover-contribution", message });
    expect(discover.errorAgent).toBe("discover-contribution");
    expect(discover.displayError).toBe(message);
    expect(discover.noticeError).toBeNull();
    expect(notifications.items).toHaveLength(0);
    expect(notifications.live).toHaveLength(0);
  });

  test("a failure that names no agent reaches the notice stack", () => {
    const discover = connect();
    const message = "Could not clone https://example.com/repo: git exited with status 128.";
    discover.handleEvent({ type: "discoverError", message });
    expect(discover.errorAgent).toBeNull();
    expect(discover.noticeError).toBe(message);
    expect(notifications.items).toHaveLength(0);
  });

  test("a snapshot read failure reaches the notice stack", () => {
    const discover = connect();
    discover.handleEvent({
      type: "discoverState",
      state: { active: false, error: "The published artifacts could not be read." },
    });
    expect(discover.noticeError).toBe("The published artifacts could not be read.");
  });

  test("a new run clears the previous failure", () => {
    const discover = connect();
    discover.handleEvent({
      type: "discoverError",
      agent: "sheet",
      message: "The Data Sheet run failed.",
    });
    discover.handleEvent({ type: "discoverStarted", agent: "sheet" });
    expect(discover.displayError).toBeNull();
    expect(discover.noticeError).toBeNull();
  });
});
