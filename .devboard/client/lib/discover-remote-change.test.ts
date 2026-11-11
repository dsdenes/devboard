import { describe, expect, test } from "bun:test";
import type { ConnectionStore } from "./connection.svelte";
import { DiscoverStore } from "./discover.svelte";
import type { DiscoverStatePayload } from "./types";

/** An open socket, so only the server's state decides the disabled set. */
class OpenSocket {
  open = true;

  send(): boolean {
    return true;
  }
}

/** Applies one snapshot the way the connect replay and every poll deliver it. */
function store(changes: Partial<DiscoverStatePayload>): DiscoverStore {
  const discover = new DiscoverStore(new OpenSocket() as unknown as ConnectionStore);
  discover.handleEvent({
    type: "discoverState",
    state: {
      active: false,
      starting: false,
      runId: null,
      startedAt: null,
      activeAgent: null,
      runningAll: false,
      agents: [],
      interrupted: false,
      stale: false,
      warnings: [],
      busy: null,
      error: null,
      remoteAvailable: true,
      retained: [],
      repository: null,
      target: { kind: "host" },
      cloning: null,
      manifest: null,
      freshness: null,
      sheet: null,
      dependencyRepositories: {},
      overviewLinks: {},
      contribution: null,
      glossaries: [],
      glossaryUsage: {},
      glossarySignificance: {},
      decisions: [],
      skills: [],
      ...changes,
    },
  });
  return discover;
}

describe("discover remote change controls", () => {
  test("Run all disables the strip before any agent's run exists", () => {
    const discover = store({ active: false, runningAll: true, cloning: null, busy: null });

    expect(discover.remoteChangeDisabled).toBe(true);
    expect(discover.remoteChangeTitle).toBe("Run all is running");
  });

  test("an idle state leaves the strip's controls enabled", () => {
    const discover = store({ active: false, runningAll: false, cloning: null, busy: null });

    expect(discover.remoteChangeDisabled).toBe(false);
    expect(discover.remoteChangeTitle).toBeUndefined();
  });

  test("the clone-to-first-run handoff keeps the strip disabled", () => {
    const discover = store({ active: false, runningAll: false, starting: true });

    expect(discover.remoteChangeDisabled).toBe(true);
    expect(discover.remoteChangeTitle).toBe("A Discover run is active");
  });
});
