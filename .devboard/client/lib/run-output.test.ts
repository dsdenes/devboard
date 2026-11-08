import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { RunOutputStore } = await import("./run-output.svelte");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a slow run read is not stacked by the next tick", async () => {
  // A slow `/agent-runs` answer used to leave a fresh request every second.
  // Those stacked reads competed with the page's polls for the browser's six
  // connections, so an operator action queued behind them.
  let calls = 0;
  const answers: Array<(response: Response) => void> = [];
  globalThis.fetch = (() => {
    calls += 1;
    const { promise, resolve } = Promise.withResolvers<Response>();
    answers.push(resolve);
    return promise;
  }) as unknown as typeof fetch;

  const store = new RunOutputStore();
  const poll = (): Promise<void> => (store as unknown as { poll(): Promise<void> }).poll();

  const first = poll();
  await Promise.resolve();
  const second = poll();
  await Promise.resolve();
  expect(calls).toBe(1);

  answers.shift()?.(
    new Response(JSON.stringify({ runs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await first;
  await second;

  const third = poll();
  await Promise.resolve();
  expect(calls).toBe(2);
  answers.shift()?.(
    new Response(JSON.stringify({ runs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await third;
});
