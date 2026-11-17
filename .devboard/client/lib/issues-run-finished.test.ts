import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: QueryHarness } = await import("./components/QueryHarness.svelte");
const { default: IssuesAgentFocus } = await import("./components/IssuesAgentFocus.svelte");
const { connection } = await import("./connection.svelte");
const { applyFrames } = await import("./frames");
const { issues } = await import("./issues.svelte");
const { layout } = await import("./layout.svelte");
const { queryClient } = await import("./query-client");

type Frame = { type: string } & Record<string, unknown>;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

const RUN_ID = "run-42";
const TAB = {
  id: "agent:run-42",
  kind: "agent",
  resourceId: RUN_ID,
  title: "#42 Fix the focus stream",
};

const realWindow = (globalThis as unknown as Record<string, unknown>).window;
/** The globals this file replaces; every one is restored for the next file. */
const originalGlobals = {
  window: realWindow,
  fetch: (globalThis as unknown as Record<string, unknown>).fetch,
  location: (globalThis as unknown as Record<string, unknown>).location,
};

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/**
 * The page the plan mounts. Every run read is one fetch of its path, and its
 * answers come in order: the first reports the run still running, the history
 * read the page asks for once the run ends carries the closing output.
 */
function installFetch(answers: ReadonlyArray<Frame>): string[] {
  const reads: string[] = [];
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    reads.push(path);
    const answer = path === `/issues/runs/${RUN_ID}` ? (answers[runReads(reads, RUN_ID) - 1] ?? {}) : {};
    return new Response(JSON.stringify({ frames: [answer] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  setGlobal("window", {
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  setGlobal("location", { protocol: "http:", host: "test.invalid", reload: () => undefined });
  return reads;
}

function runReads(reads: readonly string[], runId: string): number {
  return reads.filter((path) => path === `/issues/runs/${runId}`).length;
}

/** The replay names the live agent, so its tab follows the live read. */
function liveState(): Frame {
  return {
    type: "issuesState",
    root: "/repo",
    lifecycle: "running",
    enabled: true,
    queue: [],
    runs: [{ runId: RUN_ID, status: "running", issueNumbers: [42] }],
    agents: [
      {
        runId: RUN_ID,
        issueNumber: 42,
        startedAt: "2026-11-09T10:00:00Z",
        question: null,
        acp: null,
        harnessVersion: "1.44.10",
      },
    ],
  };
}

/** The run ended: its record holds the terminal status and its agent is gone. */
function finishedState(): Frame {
  return {
    type: "issuesState",
    root: "/repo",
    lifecycle: "idle",
    enabled: true,
    queue: [],
    runs: [
      {
        runId: RUN_ID,
        status: "succeeded",
        startedAt: "2026-11-09T10:00:00Z",
        finishedAt: "2026-11-09T10:04:00Z",
        exitCode: 0,
        issueNumbers: [42],
        activity: 3,
        firstStderrLine: null,
        harnessVersion: "1.44.10",
      },
    ],
    agents: [],
  };
}

function runAnswer(status: string, activityLines: string[]): Frame {
  return {
    type: "issuesRun",
    run: {
      runId: RUN_ID,
      status,
      startedAt: "2026-11-09T10:00:00Z",
      finishedAt: null,
      exitCode: null,
      issueNumbers: [42],
      activity: activityLines.length,
      firstStderrLine: null,
      harnessVersion: "1.44.10",
      repo: "dsdenes/devboard",
      argv: ["omp", "acp"],
      cwd: "/repo",
      issues: [],
      workerPid: 4242,
      activityLines,
    },
  };
}

/** Mounts the reads the page makes and the run's two answers, in order. */
function openLivePage(): string[] {
  const reads = installFetch([
    runAnswer("running", ["$ cargo test", "running tests"]),
    runAnswer("succeeded", ["$ cargo test", "running tests", " 2 passed"]),
  ]);
  layout.reset();
  layout.setMode("issues");
  layout.openTab("issues", TAB);
  render(QueryHarness);
  render(IssuesAgentFocus, {
    props: { tab: TAB, close: () => undefined, openRuns: () => undefined },
  });
  return reads;
}

/** One rendered element, by test id. */
function testId(id: string): Element {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (element === null) throw new Error(`No element with test id ${id}.`);
  return element;
}

connection.onOpen(() => issues.resetActiveOperations());
connection.onMessage((message) => issues.handleEvent(message as Record<string, unknown>));

afterEach(() => {
  cleanup();
  queryClient.clear();
  connection.dispose();
  layout.reset();
  issues.snapshot = null;
  issues.agentActivity = {};
  issues.run = null;
  issues.missingRun = null;
  issues.selectedRun = null;
  issues.shownRun = null;
  issues.resetActiveOperations();
  for (const [key, value] of Object.entries(originalGlobals)) setGlobal(key, value);
});

test("a run that ends reads its history again and shows its closing output", async () => {
  const reads = openLivePage();
  connection.connect();
  await settle();
  applyFrames([liveState()]);
  await settle();

  expect(runReads(reads, RUN_ID)).toBe(1);
  expect(issues.run?.status).toBe("running");
  const dot = testId("agent-activity-dot");
  expect(dot.getAttribute("data-state")).toBe("running");

  // The run ends while its tab is open: the live claim stops, and the detail
  // the live read left behind never carries the run's final status.
  applyFrames([finishedState()]);
  await settle();

  expect(runReads(reads, RUN_ID)).toBe(2);
  expect(issues.run?.status).toBe("succeeded");
  expect(dot.getAttribute("data-state")).toBe("succeeded");
  expect(testId("issues-agent-focus-activity").textContent).toContain(" 2 passed");
});

test("a late live answer never replaces the history the run already answered", async () => {
  const reads = openLivePage();
  connection.connect();
  await settle();
  applyFrames([liveState()]);
  await settle();
  expect(issues.run?.status).toBe("running");

  applyFrames([finishedState()]);
  await settle();
  expect(runReads(reads, RUN_ID)).toBe(2);
  expect(issues.run?.status).toBe("succeeded");

  // A live read issued before the run ended lands last: it answers a moment
  // that is already past, so the terminal history stays on screen.
  applyFrames([runAnswer("running", ["$ cargo test", "running tests"])]);
  expect(issues.run?.status).toBe("succeeded");
  expect(issues.run?.activityLines).toContain(" 2 passed");
});
