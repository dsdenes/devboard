import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeEach(() => {
  // The test preload restores Bun's native globals before every test and Bun has
  // no RequestAnimationFrame, while xterm's DOM renderer refreshes through it.
  let frame = 0;
  const timers = new Map<number, Timer>();
  globalThis.requestAnimationFrame = (callback) => {
    frame += 1;
    timers.set(
      frame,
      setTimeout(() => {
        timers.delete(frame);
        callback(Date.now());
      }, 0),
    );
    return frame;
  };
  globalThis.cancelAnimationFrame = (handle) => {
    const timer = timers.get(handle);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(handle);
  };
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: Terminal } = await import("./Terminal.svelte");

afterEach(() => cleanup());

const LONG = "agent output ".repeat(30).trim();
const WIDER = "a wrapped replacement ".repeat(20).trim();
const SHORT = "Done";

function mount(testid: string, lines: string[]) {
  return render(Terminal, {
    props: { lines, "data-testid": testid, label: "Activity" },
  });
}

/** xterm parses queued writes on a timer, so a buffer read waits for it. */
async function settle(testid: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return window.__devboardTerminals?.get(testid)?.getBuffer() ?? "";
}

test("replacing a wrapped line with a short one leaves only the short line", async () => {
  const view = mount("wrapped-short", [LONG]);

  const wrapped = await settle("wrapped-short");
  expect(wrapped.split("\n").length).toBeGreaterThan(1);

  await view.rerender({ lines: [SHORT] });

  expect(await settle("wrapped-short")).toBe(SHORT);
});

test("replacing a wrapped line with another wrapped line keeps only the replacement", async () => {
  const view = mount("wrapped-wrapped", [LONG]);
  expect((await settle("wrapped-wrapped")).split("\n").length).toBeGreaterThan(1);

  await view.rerender({ lines: [WIDER] });
  const replaced = await settle("wrapped-wrapped");
  expect(replaced.split("\n").length).toBeGreaterThan(1);

  mount("wrapped-fresh", [WIDER]);
  expect(replaced).toBe(await settle("wrapped-fresh"));

  await view.rerender({ lines: [SHORT] });
  expect(await settle("wrapped-wrapped")).toBe(SHORT);
});

test("appending after a wrapped line matches a full rewrite of both lines", async () => {
  const appended = mount("appended", [LONG]);
  expect((await settle("appended")).split("\n").length).toBeGreaterThan(1);

  await appended.rerender({ lines: [LONG, SHORT] });
  const appendedBuffer = await settle("appended");

  const rewritten = mount("rewritten", [LONG, SHORT]);
  const rewrittenBuffer = await settle("rewritten");

  expect(appendedBuffer).toBe(rewrittenBuffer);
  expect(appendedBuffer.split("\n").at(-1)).toBe(SHORT);
});

test("a replacement scheduled with a write still pending clears every row", async () => {
  const view = mount("pending", [LONG]);
  await view.rerender({ lines: [SHORT] });

  expect(await settle("pending")).toBe(SHORT);
});
