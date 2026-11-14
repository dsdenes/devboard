import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

const { cleanup, render } = await import("@testing-library/svelte");
const { default: QueryHarness } = await import("./components/QueryHarness.svelte");
const { connection } = await import("./connection.svelte");
const { applyFrames } = await import("./frames");
const { issues } = await import("./issues.svelte");
const { layout } = await import("./layout.svelte");
const { queryClient } = await import("./query-client");

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

const realWindow = (globalThis as unknown as Record<string, unknown>).window;

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/** The page the plan mounts; every run read is one fetch of its path. */
function installFetch(): string[] {
  const reads: string[] = [];
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    reads.push(String(input));
    return new Response(JSON.stringify({ frames: [] }), {
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

/** A run that already ended: its snapshot lists it as history, not a live agent. */
function finishedState(): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    lifecycle: "idle",
    enabled: true,
    queue: [],
    runs: [
      {
        runId: "run-42",
        status: "succeeded",
        startedAt: "2026-11-09T10:00:00Z",
        finishedAt: "2026-11-09T10:04:00Z",
        exitCode: 0,
        issueNumbers: [42],
        activity: 2,
        firstStderrLine: null,
        harnessVersion: "1.44.10",
      },
    ],
    agents: [],
  };
}

/** One run's persisted history, as the `issuesRun` frame carries it. */
function finishedRun(): Record<string, unknown> {
  return {
    runId: "run-42",
    status: "succeeded",
    startedAt: "2026-11-09T10:00:00Z",
    finishedAt: "2026-11-09T10:04:00Z",
    exitCode: 0,
    issueNumbers: [42],
    activity: 2,
    firstStderrLine: null,
    harnessVersion: "1.44.10",
    repo: "dsdenes/devboard",
    argv: ["omp", "acp"],
    cwd: "/repo",
    issues: [],
    workerPid: 4242,
    activityLines: ["$ cargo test", "2 passed"],
  };
}

// The reconnect reset App.svelte installs: a lost answer is asked for again.
connection.onOpen(() => issues.resetActiveOperations());
connection.onMessage((message) => issues.handleEvent(message as Record<string, unknown>));

async function openPage(): Promise<string[]> {
  const reads = installFetch();
  // The runs surface is the one that shows a selected run's history: the plan
  // claims that read only while this tab is on screen.
  layout.reset();
  layout.setMode("issues");
  layout.openTab("issues", { id: "runs", kind: "runs", resourceId: "runs", title: "Runs" });
  render(QueryHarness);
  connection.connect();
  await settle();
  applyFrames([finishedState() as { type: string } & Record<string, unknown>]);
  await settle();
  return reads;
}

/** A reconnect revalidates every shown resource, once. */
async function reconnect(): Promise<void> {
  connection.connect();
  await settle();
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  connection.dispose();
  layout.reset();
  issues.selectedRun = null;
  issues.run = null;
  issues.runError = null;
  issues.resetActiveOperations();
  setGlobal("window", realWindow);
});

test("a reconnect re-requests a run whose history answer was lost", async () => {
  const reads = await openPage();
  issues.loadRun("run-42");
  await settle();
  expect(runReads(reads, "run-42")).toBe(1);
  expect(issues.run).toBeNull();

  await reconnect();
  issues.loadRun("run-42");
  await settle();
  expect(runReads(reads, "run-42")).toBe(2);

  applyFrames([{ type: "issuesRun", run: finishedRun() }]);
  expect(issues.run?.activityLines).toEqual(["$ cargo test", "2 passed"]);
  expect(issues.runError).toBeNull();

  // The answered detail is what the next effect pass reads; it asks again
  // only after another reconnect.
  issues.loadRun("run-42");
  await settle();
  expect(runReads(reads, "run-42")).toBe(2);
});

test("an unanswered run asks once per open transition, never per render", async () => {
  const reads = await openPage();

  // The effect re-runs on every snapshot poll while the answer is missing.
  issues.loadRun("run-42");
  issues.loadRun("run-42");
  issues.loadRun("run-42");
  await settle();
  expect(runReads(reads, "run-42")).toBe(1);

  await reconnect();
  issues.loadRun("run-42");
  issues.loadRun("run-42");
  await settle();
  expect(runReads(reads, "run-42")).toBe(2);
});

test("a missing run asks once per open transition and then stays unavailable", async () => {
  const reads = await openPage();

  issues.loadRun("run-gone");
  await settle();
  applyFrames([
    { type: "issuesRunMissing", runId: "run-gone", message: "No such issues run." },
  ]);
  expect(issues.runError).toBe("No such issues run.");

  issues.loadRun("run-gone");
  await settle();
  expect(runReads(reads, "run-gone")).toBe(1);

  await reconnect();
  issues.loadRun("run-gone");
  await settle();
  expect(runReads(reads, "run-gone")).toBe(2);
});

test("a request the closed socket refused leaves the run free to ask again", async () => {
  const reads = await openPage();
  connection.dispose();
  issues.loadRun("run-42");
  await settle();
  expect(runReads(reads, "run-42")).toBe(0);

  connection.connect();
  await settle();
  issues.loadRun("run-42");
  await settle();
  expect(runReads(reads, "run-42")).toBe(1);
});
