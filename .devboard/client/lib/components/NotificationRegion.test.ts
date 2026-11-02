import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component, the
// store, and the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { notifications } = await import("../notifications.svelte");
const { default: NotificationRegion } = await import("./NotificationRegion.svelte");

type PendingRequest = {
  url: string;
  resolve: (response: Response) => void;
};

const pending: PendingRequest[] = [];
const originalFetch = globalThis.fetch;

function reply(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  notifications.clear();
  pending.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    pending.push({ url: String(input), resolve });
    return promise;
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  notifications.clear();
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
});

/** Renders the region with one filing error notification and its button. */
async function renderErrorCard() {
  notifications.push("server", "error", "The socket closed.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();
  const button = view.getByLabelText("File an issue from this notification") as HTMLButtonElement;
  return { view, button };
}

test("the notification being filed is disabled and reads Filing…", async () => {
  const { button } = await renderErrorCard();
  expect(button.disabled).toBe(false);

  await fireEvent.click(button);
  await tick();

  expect(pending.map((request) => request.url)).toEqual(["/feedback"]);
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.textContent).toBe("Filing…");
});

test("a second activation while filing sends no second request", async () => {
  notifications.push("server", "error", "The socket closed.");
  notifications.push("server", "error", "The connection failed.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();
  const buttons = [...view.container.querySelectorAll<HTMLButtonElement>(".notification__file")];
  expect(buttons).toHaveLength(2);

  await fireEvent.click(buttons[0]!);
  await tick();
  expect(buttons.every((button) => button.disabled)).toBe(true);

  await fireEvent.click(buttons[0]!);
  await fireEvent.click(buttons[1]!);
  expect(pending).toHaveLength(1);

  pending[0]!.resolve(
    reply({ links: { issue: { href: "http://localhost:3001/dsdenes/devboard/issues/7" } } }),
  );
  await tick();
  await tick();

  const link = view.getByText("Open issue") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("http://localhost:3001/dsdenes/devboard/issues/7");
  const remaining = view.container.querySelector<HTMLButtonElement>(".notification__file");
  expect(remaining?.disabled).toBe(false);
});
