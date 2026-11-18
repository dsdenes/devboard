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

/** An open socket that keeps every frame the control dispatched. */
class RecordingSocket {
  open = true;
  readonly sent: unknown[] = [];

  send(command: unknown): boolean {
    this.sent.push(command);
    return true;
  }
}

function payload(changes: Partial<DiscoverStatePayload>): DiscoverStatePayload {
  return {
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
  } as DiscoverStatePayload;
}

/** Applies one snapshot the way the connect replay and every poll deliver it. */
function store(changes: Partial<DiscoverStatePayload>): DiscoverStore {
  const discover = new DiscoverStore(new OpenSocket() as unknown as ConnectionStore);
  discover.handleEvent({ type: "discoverState", state: payload(changes) });
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

describe("discover remote change senders", () => {
  const retainedUrl = "https://github.com/acme/retained";
  const otherUrl = "https://github.com/acme/other";

  function recording(changes: Partial<DiscoverStatePayload> = {}) {
    const socket = new RecordingSocket();
    const discover = new DiscoverStore(socket as unknown as ConnectionStore);
    discover.handleEvent({ type: "discoverState", state: payload(changes) });
    return { discover, socket };
  }

  test("an idle strip sends each change command under the server's own name", () => {
    const { discover, socket } = recording();

    discover.switchRemote(otherUrl);
    expect(socket.sent).toEqual([{ type: "switchDiscoverRemote", url: otherUrl }]);

    discover.removeRemote(retainedUrl);
    expect(socket.sent).toEqual([
      { type: "switchDiscoverRemote", url: otherUrl },
      { type: "removeDiscoverRemote", url: retainedUrl },
    ]);

    discover.remoteUrl = "https://github.com/acme/draft";
    discover.clearRemote();
    expect(socket.sent).toEqual([
      { type: "switchDiscoverRemote", url: otherUrl },
      { type: "removeDiscoverRemote", url: retainedUrl },
      { type: "clearDiscoverRemote" },
    ]);
    expect(discover.remoteUrl).toBe("");
  });

  test("switching to the project already selected sends nothing", () => {
    const { discover, socket } = recording({
      target: { kind: "remote", url: retainedUrl, owner: "acme", repo: "retained", checkout: false },
    });

    discover.switchRemote(retainedUrl);

    expect(socket.sent).toEqual([]);
  });

  test("an empty URL sends neither a switch nor a remove", () => {
    const { discover, socket } = recording();

    discover.switchRemote("");
    discover.removeRemote("");

    expect(socket.sent).toEqual([]);
  });
});

describe("discover remote start", () => {
  function recording(changes: Partial<DiscoverStatePayload> = {}) {
    const socket = new RecordingSocket();
    const discover = new DiscoverStore(socket as unknown as ConnectionStore);
    discover.handleEvent({ type: "discoverState", state: payload(changes) });
    return { discover, socket };
  }

  test("an accepted submission sends one trimmed frame and keeps the field", () => {
    const { discover, socket } = recording();
    discover.remoteUrl = "  https://github.com/acme/fresh  ";

    expect(discover.startRemote()).toBe(true);
    expect(socket.sent).toEqual([{ type: "discoverRemote", url: "https://github.com/acme/fresh" }]);
    expect(discover.remoteUrl).toBe("  https://github.com/acme/fresh  ");
  });

  test("the field clears only when the snapshot names that clone", () => {
    const { discover } = recording();
    const url = "https://github.com/acme/fresh";
    discover.remoteUrl = url;
    discover.startRemote();

    discover.handleEvent({
      type: "discoverState",
      state: payload({ cloning: { url: "https://github.com/acme/other" } }),
    });
    expect(discover.remoteUrl).toBe(url);

    discover.handleEvent({ type: "discoverState", state: payload({ cloning: { url } }) });
    expect(discover.remoteUrl).toBe("");
  });

  test("a refused submission sends nothing and reports it", () => {
    const { discover, socket } = recording();

    expect(discover.startRemote()).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  test("Run all refuses the remote start without dispatching", () => {
    const { discover, socket } = recording({
      active: false,
      runningAll: true,
      cloning: null,
      busy: null,
    });
    discover.remoteUrl = "https://github.com/acme/fresh";

    expect(discover.remoteStartTitle).toBe("Run all is running");
    expect(discover.remoteStartDisabled).toBe(true);
    expect(discover.startRemote()).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  test("the clone-to-first-run handoff refuses the remote start too", () => {
    const { discover, socket } = recording({ active: false, runningAll: false, starting: true });
    discover.remoteUrl = "https://github.com/acme/fresh";

    expect(discover.remoteStartTitle).toBe("A Discover run is active");
    expect(discover.remoteStartDisabled).toBe(true);
    expect(discover.startRemote()).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  test("every error frame bumps the refusal revision, the repeated message included", () => {
    const { discover } = recording();
    const before = discover.errorRevision;

    discover.handleEvent({ type: "discoverError", message: "Could not clone the repository." });
    discover.handleEvent({ type: "discoverError", message: "Could not clone the repository." });

    expect(discover.errorRevision).toBe(before + 2);
  });
});

describe("discover start controls", () => {
  test("an idle state leaves both start controls enabled", () => {
    const discover = store({ active: false, starting: false, cloning: null, busy: null });

    expect(discover.startDisabled).toBe(false);
    expect(discover.startTitle).toBeUndefined();
    expect(discover.agentStartDisabled("sheet")).toBe(false);
    expect(discover.agentStartTitle("sheet")).toBeUndefined();
  });

  test("a running clone refuses both starts without dispatching", () => {
    const socket = new RecordingSocket();
    const discover = new DiscoverStore(socket as unknown as ConnectionStore);
    discover.handleEvent({
      type: "discoverState",
      state: payload({ active: false, cloning: { url: "https://github.com/acme/repo" } }),
    });

    expect(discover.startDisabled).toBe(true);
    expect(discover.startTitle).toBe("A repository clone is running");
    expect(discover.agentStartDisabled("sheet")).toBe(true);
    expect(discover.agentStartTitle("sheet")).toBe("A repository clone is running");
    expect(discover.start()).toBe(false);
    expect(discover.startAgent("sheet")).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  test("the clone-to-first-run handoff refuses both starts too", () => {
    const socket = new RecordingSocket();
    const discover = new DiscoverStore(socket as unknown as ConnectionStore);
    discover.handleEvent({
      type: "discoverState",
      state: payload({ active: false, starting: true }),
    });

    expect(discover.startDisabled).toBe(true);
    expect(discover.startTitle).toBe("A Discover run is active");
    expect(discover.agentStartDisabled("sheet")).toBe(true);
    expect(discover.agentStartTitle("sheet")).toBe("A Discover run is active");
    expect(discover.start()).toBe(false);
    expect(discover.startAgent("sheet")).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  test("an active run keeps its agent-specific wording", () => {
    const discover = store({
      active: true,
      activeAgent: "sheet",
      agents: [
        {
          id: "sheet",
          label: "Data Sheet",
          command: "/discover-sheet",
          state: "running",
          startedAt: null,
          endedAt: null,
          error: null,
          prompt: null,
        },
      ],
    });

    expect(discover.startTitle).toBe("Data Sheet is running");
    expect(discover.agentStartTitle("sheet")).toBe("Data Sheet is running");
    expect(discover.agentStartTitle("discover-glossary")).toBe("Data Sheet is running");
  });
});
