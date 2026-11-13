import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReleaseProgressRecord } from "../release-run";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: ReleaseProgressLog } = await import("./ReleaseProgressLog.svelte");

afterEach(() => cleanup());

const VIEWPORT = 160;

function record(phase: string, detail: string): ReleaseProgressRecord {
  return {
    at: "2026-11-13T10:00:00.000Z",
    phase,
    detail,
    attempt: null,
    passed: null,
    failed: null,
    ciRun: null,
    conclusion: null,
    assets: null,
  };
}

/**
 * happy-dom has no layout, so the log gets the metrics a browser computes for
 * it: a growing scroll height, a fixed client height, and a scrollTop clamped
 * to the scrollable range.
 */
function layout(log: HTMLElement): { grow: (by: number) => void } {
  let content = VIEWPORT * 3;
  let top = 0;
  Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => content });
  Object.defineProperty(log, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(log, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.min(Math.max(value, 0), content - VIEWPORT);
    },
  });
  return {
    grow: (by: number) => {
      content += by;
    },
  };
}

async function mount(records: ReleaseProgressRecord[], identity = "run-1") {
  const view = render(ReleaseProgressLog, { props: { records, identity } });
  const log = view.getByTestId("release-progress-log");
  const pane = layout(log);
  await tick();
  return { view, log, pane };
}

test("the progress log follows appended records while the operator stays at the tail", async () => {
  const { view, log, pane } = await mount([record("fetch", "fetched origin/main")]);

  pane.grow(VIEWPORT);
  await view.rerender({
    records: [record("fetch", "fetched origin/main"), record("suite", "attempt 1/9")],
    identity: "run-1",
  });
  await tick();

  expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight);
  expect(log.querySelectorAll(".release-log__line").length).toBe(2);
});

test("scrolling up keeps the operator's position when a record arrives", async () => {
  const { view, log, pane } = await mount([record("fetch", "fetched origin/main")]);

  log.scrollTop = 40;
  await fireEvent.scroll(log);
  await tick();

  pane.grow(VIEWPORT);
  await view.rerender({
    records: [record("fetch", "fetched origin/main"), record("suite", "attempt 1/9")],
    identity: "run-1",
  });
  await tick();

  expect(log.scrollTop).toBe(40);
});

test("another run starts the log at its newest record", async () => {
  const { view, log, pane } = await mount([record("fetch", "fetched origin/main")]);

  log.scrollTop = 40;
  await fireEvent.scroll(log);
  await tick();

  pane.grow(VIEWPORT);
  await view.rerender({
    records: [record("tag", "pushed v1.1.0")],
    identity: "run-2",
  });
  await tick();

  expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight);
});
