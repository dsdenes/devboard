import { expect, test } from "bun:test";
import { IssuesStore } from "./issues.svelte";

/** One snapshot as the server writes it, with the fields this test varies. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "issuesState",
    present: true,
    repo: "acme/app",
    root: "/repo",
    lifecycle: "stopped",
    enabled: false,
    paused: false,
    attached: false,
    worker: null,
    poll: null,
    queue: [],
    runs: [],
    agents: [],
    cooldowns: {},
    lastError: null,
    lastExitCode: null,
    finishedAt: null,
    notice: null,
    starting: false,
    startError: null,
    deferral: null,
    updatedAt: null,
    ...overrides,
  };
}

test("a Start answer names the start in flight and releases its control", () => {
  const store = new IssuesStore();
  store.handleEvent(snapshot());
  const resting = store.startEvidence;

  store.handleEvent(snapshot({ starting: true }));
  expect(store.starting).toBe(true);
  expect(store.startEvidence).not.toBe(resting);
  const inFlight = store.startEvidence;

  store.handleEvent(
    snapshot({ starting: false, startError: "missing prerequisite: omp is not on PATH" }),
  );
  expect(store.starting).toBe(false);
  expect(store.startError).toBe("missing prerequisite: omp is not on PATH");
  expect(store.startEvidence).not.toBe(inFlight);
});

test("a snapshot no Start asked for is not a Start answer", () => {
  const store = new IssuesStore();
  const refusal = "missing prerequisite: omp is not on PATH";
  store.handleEvent(snapshot({ startError: refusal }));
  // A read is not an answer to a Start this page dispatched: it bumps no
  // revision, so it can never settle a Start control's latch by arriving.
  expect(store.startAnswerRevision).toBe(0);
  store.handleEvent(snapshot({ startError: refusal }));
  expect(store.startAnswerRevision).toBe(0);
});

test("a snapshot from an older server names no start in flight", () => {
  const store = new IssuesStore();
  const legacy = snapshot();
  delete legacy.starting;
  delete legacy.startError;
  store.handleEvent(legacy);
  expect(store.starting).toBe(false);
  expect(store.startError).toBeNull();
});
