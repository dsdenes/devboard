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
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { notifications } = await import("../notifications.svelte");
const { notificationFiler } = await import("../notification-issue");
const { default: NotificationRegion } = await import("./NotificationRegion.svelte");

type PendingRequest = {
  url: string;
  resolve: (response: Response) => void;
};

const pending: PendingRequest[] = [];
const originalFetch = globalThis.fetch;

function reply(body: unknown): Response {
  return { ok: true, status: 201, json: async () => body } as unknown as Response;
}

function refuse(detail: string): Response {
  return {
    ok: false,
    status: 502,
    json: async () => ({ detail }),
  } as unknown as Response;
}

const issueHref = "http://localhost:3001/dsdenes/devboard/issues/7";

beforeEach(() => {
  notifications.clear();
  notificationFiler.reset();
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
  notificationFiler.reset();
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
});

test("an error notification files itself once without a click and links to the issue", async () => {
  notifications.push("Flow", "error", "The socket closed.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  expect(pending.map((request) => request.url)).toEqual(["/feedback"]);
  expect(view.container.querySelector(".notification__file")).toBeNull();
  expect(view.container.querySelector(".notification__link")).toBeNull();

  pending[0]!.resolve(reply({ links: { issue: { href: issueHref } } }));
  await waitFor(() => {
    expect(view.container.querySelector(".notification__link")).not.toBeNull();
  });

  const link = view.getByText("Open issue") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(issueHref);
  expect(view.container.querySelector(".notification__file")).toBeNull();
  expect(pending).toHaveLength(1);
});

test("an identical error in the same session posts nothing and shares the filed link", async () => {
  notifications.push("Flow", "error", "The socket closed.");
  notifications.push("Flow", "error", "The socket closed.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  expect(pending).toHaveLength(1);
  pending[0]!.resolve(reply({ links: { issue: { href: issueHref } } }));
  await waitFor(() => {
    expect(view.getAllByText("Open issue")).toHaveLength(2);
  });
  expect(
    view.getAllByText("Open issue").every((link) => link.getAttribute("href") === issueHref),
  ).toBe(true);
  expect(view.container.querySelector(".notification__file")).toBeNull();
});

test("a different error files its own issue", async () => {
  notifications.push("Flow", "error", "The socket closed.");
  notifications.push("Issues", "error", "The socket closed.");
  notifications.push("Flow", "error", "The connection failed.");
  render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  expect(pending).toHaveLength(3);
});

test("a warning keeps the manual File issue control and filing flow", async () => {
  notifications.push("Connection", "warning", "Connection lost. Reconnecting…");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  expect(pending).toHaveLength(0);
  const button = view.getByLabelText("File an issue from this notification") as HTMLButtonElement;
  expect(button.textContent).toBe("File issue");
  expect(button.disabled).toBe(false);

  await fireEvent.click(button);
  expect(pending.map((request) => request.url)).toEqual(["/feedback"]);
  pending[0]!.resolve(reply({ links: { issue: { href: issueHref } } }));
  await waitFor(() => {
    expect(view.container.querySelector(".notification__link")?.getAttribute("href")).toBe(issueHref);
  });
});

test("notice and success notifications carry no filing control and send nothing", async () => {
  notifications.push("Flow", "notice", "Flow restored.");
  notifications.push("Issues", "success", "Closed issue #12.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  expect(pending).toHaveLength(0);
  expect(view.container.querySelector(".notification__file")).toBeNull();
  expect(view.container.querySelector(".notification__link")).toBeNull();
});

test("a failed automatic filing shows the detail and a retry that files", async () => {
  notifications.push("Flow", "error", "The socket closed.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();
  pending[0]!.resolve(refuse("The issue could not be filed."));
  await waitFor(() => {
    expect(view.container.querySelector(".notification__error")?.textContent).toContain(
      "Issue not filed: The issue could not be filed.",
    );
  });
  expect(view.container.querySelector(".notification__link")).toBeNull();

  const button = view.getByLabelText("File an issue from this notification") as HTMLButtonElement;
  expect(button.textContent).toBe("File issue");
  expect(button.disabled).toBe(false);

  await fireEvent.click(button);
  expect(pending).toHaveLength(2);
  pending[1]!.resolve(reply({ links: { issue: { href: issueHref } } }));
  await waitFor(() => {
    expect(view.container.querySelector(".notification__link")?.getAttribute("href")).toBe(issueHref);
  });
  expect(view.container.querySelector(".notification__error")).toBeNull();
  expect(view.container.querySelector(".notification__file")).toBeNull();
});

test("disabled reporting sends no automatic request and reveals the retry button", async () => {
  notifications.push("Flow", "error", "The socket closed.");
  const view = render(NotificationRegion, { props: { feedbackenabled: false } });
  await tick();

  expect(pending).toHaveLength(0);
  expect(view.container.querySelector(".notification__error")?.textContent).toContain(
    "Issue not filed: reporting is disabled.",
  );
  const button = view.getByLabelText("File an issue from this notification") as HTMLButtonElement;
  expect(button.textContent).toBe("File issue");
  expect(view.container.querySelector(".notification__link")).toBeNull();
});
