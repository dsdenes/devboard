import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SlowUiActionContext } from "../slow-ui-action";

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
const { slowUiAction } = await import("../slow-ui-action");
const { default: NotificationRegion } = await import("./NotificationRegion.svelte");

type PendingRequest = {
  url: string;
  body: string;
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

/** Replaces the document URL; `about:blank` refuses a relative history push. */
function setPageURL(url: string): void {
  const { happyDOM } = window as unknown as { happyDOM: { setURL(value: string): void } };
  happyDOM.setURL(url);
}

beforeEach(() => {
  notifications.clear();
  notificationFiler.reset();
  pending.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    pending.push({ url: String(input), body: String(init?.body ?? ""), resolve });
    return promise;
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  notifications.clear();
  notificationFiler.reset();
  slowUiAction.uninstall();
  document.body.replaceChildren();
  setPageURL("about:blank");
  globalThis.fetch = originalFetch;
});

test("an error notification files itself once without a click and links to the issue", async () => {
  notifications.push("Flow", "error", "The socket closed.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  expect(pending.map((request) => request.url)).toEqual(["/reports"]);
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
  expect(pending.map((request) => request.url)).toEqual(["/reports"]);
  pending[0]!.resolve(reply({ links: { issue: { href: issueHref } } }));
  await waitFor(() => {
    expect(view.container.querySelector(".notification__link")?.getAttribute("href")).toBe(issueHref);
  });
});

test("a warning's failed manual filing is cleared by a successful retry", async () => {
  notifications.push("Connection", "warning", "Connection lost. Reconnecting…");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();
  expect(pending).toHaveLength(0);

  const button = view.getByLabelText("File an issue from this notification") as HTMLButtonElement;
  await fireEvent.click(button);
  expect(pending).toHaveLength(1);
  expect(view.container.querySelector(".notification__error")).toBeNull();

  pending[0]!.resolve(refuse("The issue could not be filed."));
  await waitFor(() => {
    expect(view.container.querySelector(".notification__error")?.textContent).toContain(
      "Issue not filed: The issue could not be filed.",
    );
  });
  expect(view.container.querySelector(".notification__link")).toBeNull();

  await fireEvent.click(button);
  expect(pending).toHaveLength(2);
  pending[1]!.resolve(reply({ links: { issue: { href: issueHref } } }));
  await waitFor(() => {
    expect(view.container.querySelector(".notification__link")?.getAttribute("href")).toBe(issueHref);
  });
  expect(view.container.querySelector(".notification__error")).toBeNull();
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

test("a slow action notice links its issue and stays in history", async () => {
  const item = notifications.push(
    "Performance",
    "notice",
    "Slow UI action: startAgent scout exceeded the 1000 ms budget.",
  );
  if (item === null) throw new Error("the notice was not stored");
  notifications.setIssue(item.id, { status: "filed", href: issueHref });
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  expect(view.getByText(/Slow UI action: startAgent scout/)).toBeTruthy();
  const link = view.getByText("Open issue") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(issueHref);
  expect(view.container.querySelector(".notification__file")).toBeNull();
  expect(notifications.items.find((entry) => entry.id === item.id)?.issue).toEqual({
    status: "filed",
    href: issueHref,
  });
  expect(pending).toHaveLength(0);
});

test("a disabled slow action notice states why and offers no link or filing control", async () => {
  const item = notifications.push(
    "Performance",
    "notice",
    "Slow UI action: startAgent scout exceeded the 1000 ms budget.",
  );
  if (item === null) throw new Error("the notice was not stored");
  notifications.setIssue(item.id, { status: "disabled" });
  const view = render(NotificationRegion, { props: { feedbackenabled: false } });
  await tick();

  expect(view.container.querySelector(".notification__error")?.textContent).toContain(
    "Issue not filed: reporting is disabled.",
  );
  expect(view.container.querySelector(".notification__link")).toBeNull();
  expect(view.container.querySelector(".notification__file")).toBeNull();
});

test("a slow action filing failure offers a retry that links the issue", async () => {
  const posts: Array<{ report: string; key: string }> = [];
  let outcome: { ok: true; url: string } | { ok: false; error: string } = {
    ok: false,
    error: "The issue could not be filed.",
  };
  const page: SlowUiActionContext = {
    route: "/",
    url: "http://localhost:3001/",
    selector: "#issues-start",
    domExcerpt: "<button>Start</button>",
    visibleText: "Start",
    viewport: "1365x768 @1x",
    capturedAt: "2026-11-07T12:00:00.000Z",
  };
  slowUiAction.install(
    {
      reportingEnabled: () => true,
      captureContext: () => page,
      show: (notice) => {
        const created = notifications.push("Performance", "notice", notice.text);
        return created?.id ?? 0;
      },
      update: (id, issue) => notifications.setIssue(id, issue),
      file: async (report, key) => {
        posts.push({ report, key });
        return outcome;
      },
    },
    { budgetMs: 1 },
  );
  slowUiAction.dispatch({ type: "startAgent", id: "scout" }, "operator");

  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await waitFor(() => {
    expect(view.container.querySelector(".notification__error")?.textContent).toContain(
      "Issue not filed: The issue could not be filed.",
    );
  });
  expect(view.container.querySelector(".notification__link")).toBeNull();
  expect(posts).toHaveLength(1);

  outcome = { ok: true, url: issueHref };
  const button = view.getByLabelText("File an issue from this notification") as HTMLButtonElement;
  await fireEvent.click(button);
  await waitFor(() => {
    expect(view.container.querySelector(".notification__link")?.getAttribute("href")).toBe(issueHref);
  });
  expect(view.container.querySelector(".notification__error")).toBeNull();
  expect(view.container.querySelector(".notification__file")).toBeNull();
  expect(posts).toHaveLength(2);
  expect(posts[1]?.key).toBe(posts[0]?.key);
});

/** The posted report body, decoded the way the server reads it. */
function postedBody(request: PendingRequest): Record<string, string> {
  return JSON.parse(request.body) as Record<string, string>;
}

/** The capture text as the shared builder's own cut sees it: collapsed. */
function collapsed(value: string): string {
  return value.replace(/[ \t]+/g, " ").trim();
}

/** The index of the first lone surrogate in `value`, or null when it has none. */
function loneSurrogate(value: string): number | null {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return index;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return index;
  }
  return null;
}

test("a captured card cuts its excerpt and visible text on code-point boundaries", async () => {
  notifications.push("Flow", "warning", "The excerpt subject.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  const item = notifications.items[0];
  if (item === undefined) throw new Error("the notification was not stored");
  const card = view.container.querySelector(
    `.notification[data-notification-id="${item.id}"]`,
  ) as HTMLElement;
  const text = card.querySelector(".notification__text") as HTMLElement;

  // Measure where a text-node character lands in both captured strings, so
  // each cut below straddles the high half of an emoji's surrogate pair.
  text.textContent = "😀".repeat(3000);
  const excerptStart = collapsed(card.outerHTML).indexOf("😀");
  const visibleStart = collapsed(card.innerText).indexOf("😀");
  expect(excerptStart).toBeGreaterThanOrEqual(0);
  expect(visibleStart).toBeGreaterThanOrEqual(0);

  const visiblePair = 1500 - 1 - visibleStart;
  const excerptPair = 4000 - 1 - excerptStart;
  expect(visiblePair).toBeGreaterThanOrEqual(0);
  expect(excerptPair).toBeGreaterThan(visiblePair + 2);

  const padding = excerptPair - visiblePair - 2;
  text.textContent = `${"x".repeat(visiblePair)}😀${"y".repeat(padding)}${"😀".repeat(3000)}`;

  const button = view.getByLabelText("File an issue from this notification") as HTMLButtonElement;
  await fireEvent.click(button);
  expect(pending).toHaveLength(1);

  const context = postedBody(pending[0]!);
  expect(loneSurrogate(context.dom_excerpt ?? "")).toBeNull();
  expect(loneSurrogate(context.visible_text ?? "")).toBeNull();
  expect(pending[0]!.body).not.toMatch(/\\ud[89ab]/i);
});

test("a captured card bounds its route and URL to the server's limits", async () => {
  setPageURL(`http://localhost:3000/${"deep-".repeat(700)}`);
  notifications.push("Flow", "warning", "The bound subject.");
  const view = render(NotificationRegion, { props: { feedbackenabled: true } });
  await tick();

  const button = view.getByLabelText("File an issue from this notification") as HTMLButtonElement;
  await fireEvent.click(button);
  expect(pending).toHaveLength(1);

  const context = postedBody(pending[0]!);
  expect(window.location.pathname.length).toBeGreaterThan(2000);
  expect(context.route?.length).toBe(2000);
  expect(context.url?.length).toBe(2000);
  expect(context.selector?.length).toBeLessThanOrEqual(2000);
  expect(context.viewport?.length).toBeLessThanOrEqual(500);
  expect(context.route?.endsWith("…")).toBe(true);
});
