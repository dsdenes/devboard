import { afterEach, expect, test } from "bun:test";
import { Event as DomEvent } from "happy-dom";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { connection } from "../connection.svelte";
import { providers } from "../providers.svelte";
import { queryClient } from "../query-client";
import type { ProviderSubscription } from "../types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The dialog renders a bits-ui portal into the document body, so the component
// and the testing library load after the DOM runtime is registered.
const { cleanup, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: QueryHarness } = await import("./QueryHarness.svelte");
const { default: ProvidersDialog } = await import("./ProvidersDialog.svelte");

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  providers.open = false;
  providers.subscriptions = [];
  providers.resetActiveOperations();
  queryClient.clear();
  connection.dispose();
  globalThis.fetch = originalFetch;
});

function subscription(enabled: boolean): ProviderSubscription {
  return {
    id: "subscription-1",
    provider: "openrouter",
    providerName: "OpenRouter",
    label: "Work",
    enabled,
    maskedKey: "sk-…abcd",
    status: "ok",
    windows: [],
    remainingFraction: 1,
    lastCheckedAt: null,
    error: null,
  };
}

function frameResponse(frames: unknown[]): Response {
  return new Response(JSON.stringify({ frames }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Resolves the promise chains one command's answer starts. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
  await tick();
}

/** One request the REST double answers. */
interface RestRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/**
 * Installs the REST double and mounts the dialog over the shipping HTTP
 * transport. `answer` receives every request and returns the frames it carries;
 * a request it does not name answers empty.
 */
async function mount(
  answer: (request: RestRequest) => Response | null | Promise<Response | null>,
): Promise<HTMLInputElement> {
  // The dialog moves focus on the next animation frame, and the test runtime's
  // native-runtime restore leaves no frame callback behind.
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame ??= (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
  globals.cancelAnimationFrame ??= () => undefined;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const answered = await answer({
        method: init?.method ?? "GET",
        url: String(input),
        body,
      });
      return answered ?? frameResponse([]);
    },
  });
  render(QueryHarness);
  connection.connect();
  connection.onMessage((message) => {
    providers.handleEvent(message);
  });
  providers.open = true;
  providers.subscriptions = [subscription(true)];
  render(ProvidersDialog);
  const checkbox = document.body.querySelector<HTMLInputElement>(
    '[data-testid="provider-enabled"]',
  );
  if (checkbox === null) throw new Error("the enabled checkbox did not render");
  return checkbox;
}

/** Clicks the checkbox the way a browser does, on the DOM runtime's own event. */
function toggle(checkbox: HTMLInputElement, checked: boolean): void {
  checkbox.checked = checked;
  checkbox.dispatchEvent(new DomEvent("change", { bubbles: true }) as unknown as Event);
}

test("a refused disable returns the checkbox to the stored value", async () => {
  // The answer waits on the test, so the row's in-flight state is observable.
  const gate = Promise.withResolvers<void>();
  const checkbox = await mount(async ({ method, url, body }) => {
    if (method !== "PATCH" || url !== "/providers/subscription-1") return null;
    await gate.promise;
    return frameResponse([
      {
        type: "providerError",
        requestId: body?.requestId,
        message: "The credentials file could not be written: disk full",
      },
    ]);
  });

  toggle(checkbox, false);
  await tick();
  expect(checkbox.disabled).toBe(true);

  gate.resolve();
  await settle();
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(false);
  expect(document.body.querySelector('[data-testid="provider-error"]')?.textContent).toBe(
    "The credentials file could not be written: disk full",
  );
});

test("a successful disable sticks, and a later refused enable leaves it unchecked", async () => {
  let patches = 0;
  const checkbox = await mount(({ method, url, body }) => {
    if (method !== "PATCH" || url !== "/providers/subscription-1") return null;
    patches += 1;
    if (patches === 1) {
      return frameResponse([
        { type: "providerChanged", requestId: body?.requestId },
        { type: "providersState", subscriptions: [subscription(false)], selection: null },
      ]);
    }
    return frameResponse([
      {
        type: "providerError",
        requestId: body?.requestId,
        message: "The credentials file could not be written: disk full",
      },
    ]);
  });

  toggle(checkbox, false);
  await settle();
  expect(checkbox.checked).toBe(false);

  toggle(checkbox, true);
  await settle();
  expect(checkbox.checked).toBe(false);
  expect(patches).toBe(2);
  expect(document.body.querySelector('[data-testid="provider-error"]')?.textContent).toBe(
    "The credentials file could not be written: disk full",
  );
});
