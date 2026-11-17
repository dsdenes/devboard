import { afterEach, expect, jest, test } from "bun:test";
import { Event as DomEvent } from "happy-dom";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { connection } from "../connection.svelte";
import { providers } from "../providers.svelte";
import { queryClient } from "../query-client";
import { saveFeedback } from "../save-feedback.svelte";
import type { ProviderSubscription } from "../types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The dialog renders a bits-ui portal into the document body, so the component
// and the testing library load after the DOM runtime is registered.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: QueryHarness } = await import("./QueryHarness.svelte");
const { default: ProvidersDialog } = await import("./ProvidersDialog.svelte");

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWebSocket = globals.WebSocket;

afterEach(() => {
  cleanup();
  providers.open = false;
  providers.subscriptions = [];
  providers.resetActiveOperations();
  queryClient.clear();
  connection.dispose();
  globalThis.fetch = originalFetch;
  globals.WebSocket = originalWebSocket;
  saveFeedback.dismiss();
  jest.useRealTimers();
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
 * The dialog moves focus on the next animation frame, and the test runtime's
 * native-runtime restore leaves no frame callback behind.
 */
function installFrameShim(): void {
  globals.requestAnimationFrame ??= (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
  globals.cancelAnimationFrame ??= () => undefined;
}

/**
 * Installs the REST double and mounts the dialog over the shipping HTTP
 * transport. `answer` receives every request and returns the frames it carries;
 * a request it does not name answers empty.
 */
async function mount(
  answer: (request: RestRequest) => Response | null | Promise<Response | null>,
): Promise<HTMLInputElement> {
  installFrameShim();
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

test("a reset refusal settles an enable, and a later save still confirms", async () => {
  const gate = Promise.withResolvers<void>();
  const checkbox = await mount(async ({ method, url, body }) => {
    if (method === "PATCH" && url === "/providers/subscription-1") {
      return frameResponse([
        {
          type: "error",
          message: "An implementation reset is active.",
          requestId: body?.requestId,
        },
      ]);
    }
    if (method === "POST" && url === "/providers") {
      await gate.promise;
      return frameResponse([{ type: "providerChanged", requestId: body?.requestId }]);
    }
    return null;
  });

  toggle(checkbox, false);
  await settle();
  // The refusal names the enable's own id and no state frame arrives: the row
  // is back on the stored value and usable again.
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(false);
  expect(document.body.querySelector('[data-testid="provider-error"]')?.textContent).toBe(
    "An implementation reset is active.",
  );

  const label = document.body.querySelector<HTMLInputElement>(
    '[data-testid="provider-label-input"]',
  );
  const key = document.body.querySelector<HTMLInputElement>('[data-testid="provider-key-input"]');
  const save = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-save"]');
  if (label === null || key === null || save === null) throw new Error("the form did not render");
  await fireEvent.input(label, { target: { value: "Work" } });
  await fireEvent.input(key, { target: { value: "sk-good" } });
  await fireEvent.click(save);
  await tick();
  expect(save.getAttribute("aria-busy")).toBe("true");
  expect(save.textContent?.trim()).toBe("Adding…");

  gate.resolve();
  await settle();
  // The save confirms on its own answer, before the ten-second ceiling.
  expect(save.getAttribute("aria-busy")).toBeNull();
  expect(save.textContent?.trim()).toBe("Add key");
  expect(document.body.querySelector(".command-notice")).toBeNull();
  expect(saveFeedback.text).toBe("Provider saved.");
});

/**
 * Stands in for a socket that never opens, so `connection.send` refuses every
 * command before a frame leaves the page: the refusal a dropped connection or a
 * stale bundle produces, with no request behind it.
 */
class RefusingSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: RefusingSocket[] = [];

  readyState = RefusingSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    RefusingSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = RefusingSocket.CLOSED;
    this.onclose?.();
  }
}

/** The open dialog behind a transport that refuses every dispatch. */
function mountRefusing(): { save: HTMLButtonElement; sent: () => number } {
  installFrameShim();
  RefusingSocket.instances = [];
  globals.WebSocket = RefusingSocket;
  connection.connect();
  providers.open = true;
  render(ProvidersDialog);
  const save = document.body.querySelector<HTMLButtonElement>('[data-testid="provider-save"]');
  if (save === null) throw new Error("the save control did not render");
  return {
    save,
    sent: () => RefusingSocket.instances.flatMap((socket) => socket.sent).length,
  };
}

test("a refused save leaves the control at rest and keeps the draft", async () => {
  jest.useFakeTimers();
  const { save, sent } = mountRefusing();
  const label = document.body.querySelector<HTMLInputElement>(
    '[data-testid="provider-label-input"]',
  );
  const key = document.body.querySelector<HTMLInputElement>('[data-testid="provider-key-input"]');
  if (label === null || key === null) throw new Error("the provider fields did not render");
  await fireEvent.input(label, { target: { value: "Work" } });
  await fireEvent.input(key, { target: { value: "sk-refused" } });
  expect(save.disabled).toBe(false);

  await fireEvent.click(save);

  // The dispatch did reach the transport, which refused it: nothing was sent.
  expect(connection.lastError).toBe("Not connected to the server.");
  expect(sent()).toBe(0);

  // The control never enters busy, and the ceiling raises no notice.
  expect(save.textContent?.trim()).toBe("Add key");
  expect(save.getAttribute("aria-busy")).toBeNull();
  jest.advanceTimersByTime(10_000);
  await Promise.resolve();
  expect(save.textContent?.trim()).toBe("Add key");
  expect(save.getAttribute("aria-busy")).toBeNull();
  expect(document.body.querySelector(".command-notice")).toBeNull();

  // The refusal claims no success and keeps the typed draft for a retry.
  expect(saveFeedback.text).toBeNull();
  expect(key.value).toBe("sk-refused");
  expect(label.value).toBe("Work");
});
