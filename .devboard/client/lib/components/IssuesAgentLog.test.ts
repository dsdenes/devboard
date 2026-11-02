import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const { default: IssuesAgentLog } = await import("./IssuesAgentLog.svelte");

afterEach(() => cleanup());

const VIEWPORT = 160;

/**
 * happy-dom has no layout, so the pane gets the metrics a browser computes for
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

async function mount(lines: string[], runId: string) {
  const view = render(IssuesAgentLog, { props: { lines, testid: "activity", runId } });
  const log = view.getByTestId("activity");
  const pane = layout(log);
  await tick();
  return { view, log, pane };
}

test("selecting another run returns the log to that run's tail", async () => {
  const { view, log } = await mount(["first run line"], "run-1");

  log.scrollTop = 40;
  await fireEvent.scroll(log);
  await tick();
  expect(log.scrollTop).toBe(40);

  await view.rerender({ lines: ["second run line"], runId: "run-2" });
  await tick();

  expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight);
});

test("the selected run keeps following its appended lines", async () => {
  const { view, log, pane } = await mount(["first run line"], "run-1");

  log.scrollTop = 40;
  await fireEvent.scroll(log);
  await tick();

  await view.rerender({ lines: ["second run line"], runId: "run-2" });
  await tick();

  pane.grow(VIEWPORT);
  await view.rerender({ lines: ["second run line", "appended line"], runId: "run-2" });
  await tick();

  expect(log.scrollTop).toBe(log.scrollHeight - log.clientHeight);
});

test("scrolling up inside one run keeps the operator's offset", async () => {
  const { view, log, pane } = await mount(["line one"], "run-1");

  log.scrollTop = 40;
  await fireEvent.scroll(log);
  await tick();

  pane.grow(VIEWPORT);
  await view.rerender({ lines: ["line one", "line two"], runId: "run-1" });
  await tick();

  expect(log.scrollTop).toBe(40);
});
