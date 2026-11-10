import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// These imports evaluate after the DOM globals exist, which the component and
// the testing library both need.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: FeedbackOverlay } = await import("./FeedbackOverlay.svelte");
// The connection store reads `document` as it constructs, so it loads here for
// the same reason as the component.
const { connection } = await import("./lib/connection.svelte");

const originalFetch = globalThis.fetch;
const originalElementFromPoint = document.elementFromPoint;
const originalWebSocket = (globalThis as Record<string, unknown>).WebSocket;

interface Posted {
  url: string;
  body: string;
}

/** The captured page fields a filing body carries. */
interface CapturedBody {
  route: string;
  url: string;
  selector: string;
  viewport: string;
}

/** Records every mutation the panel posts and answers it with a filed issue. */
function stubFetch(): Posted[] {
  const posted: Posted[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ links: { issue: { href: "http://forge.test/issues/1" } } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return posted;
}

/** The page's only socket, so a test can deliver the frames the server sends. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** Installs and opens one transport socket for the page under test. */
function openTransport(): FakeSocket {
  (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
  connection.connect();
  const socket = FakeSocket.instances.at(-1);
  if (socket === undefined) throw new Error("the page opened no socket");
  socket.open();
  return socket;
}

/** Arms report mode and picks one element, which opens the composer. */
async function openComposerView() {
  const target = document.createElement("div");
  target.textContent = "the picked element";
  document.body.append(target);
  document.elementFromPoint = () => target;

  const view = render(FeedbackOverlay, { props: { phase: "idle", action: null } });
  view.component.startPicking();
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await tick();
    const composer = view.container.querySelector("textarea");
    if (composer !== null) return { view, composer };
  }
  throw new Error("the report panel opened no composer");
}

/** Replaces the document URL; `about:blank` refuses a relative history push. */
function setPageURL(url: string): void {
  const { happyDOM } = window as unknown as { happyDOM: { setURL(value: string): void } };
  happyDOM.setURL(url);
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  document.elementFromPoint = originalElementFromPoint;
  (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  FakeSocket.instances = [];
  setPageURL("about:blank");
});

/**
 * A page whose route and URL exceed the server's 2000-unit bound and whose
 * generated selector exceeds the client's 500-unit bound, composer open.
 */
async function openLongPageComposer() {
  setPageURL(`http://localhost:3000/${"deep-".repeat(700)}`);
  const target = document.createElement("div");
  target.id = "e".repeat(3000);
  target.textContent = "the picked element";
  document.body.append(target);
  document.elementFromPoint = () => target;

  const view = render(FeedbackOverlay, { props: { phase: "idle", action: null } });
  view.component.startPicking();
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await tick();
    const composer = view.container.querySelector("textarea");
    if (composer !== null) return { view, composer };
  }
  throw new Error("the report panel opened no composer");
}

test("a filing bounds a long route, URL, and selector", async () => {
  const posted = stubFetch();
  const { composer } = await openLongPageComposer();
  composer.value = "This page cannot be reported.";
  await fireEvent.input(composer);
  await fireEvent.keyDown(composer, { key: "Enter" });
  await tick();

  expect(posted.length).toBe(1);
  expect(posted[0]?.url).toContain("/reports");
  const body = JSON.parse(posted[0]?.body ?? "{}") as CapturedBody;
  expect(body.route.length).toBe(2000);
  expect(body.url.length).toBe(2000);
  expect(body.selector.length).toBe(500);
  expect(body.viewport.length).toBeLessThanOrEqual(500);
});

test("a goal proposal carries the same bounded context", async () => {
  const posted = stubFetch();
  const { view, composer } = await openLongPageComposer();
  composer.value = "A goal for this page.";
  await fireEvent.input(composer);

  const goal = view.container.querySelector('[data-testid="feedback-goal"]');
  if (goal === null) throw new Error("the panel has no Goal control");
  await fireEvent.click(goal);
  await tick();

  expect(posted.length).toBe(1);
  expect(posted[0]?.url).toContain("/goal-proposals");
  const body = JSON.parse(posted[0]?.body ?? "{}") as CapturedBody;
  expect(body.route.length).toBe(2000);
  expect(body.url.length).toBe(2000);
  expect(body.selector.length).toBe(500);
  expect(body.viewport.length).toBeLessThanOrEqual(500);
});

test("Enter in the composer files the report instead of asking", async () => {
  const posted = stubFetch();
  const { composer } = await openComposerView();
  composer.value = "The status bar overlaps the toolbar.";
  await fireEvent.input(composer);

  await fireEvent.keyDown(composer, { key: "Enter" });
  await tick();

  expect(posted.length).toBe(1);
  expect(posted[0]?.url).toContain("/reports");
  const body = JSON.parse(posted[0]?.body ?? "{}");
  expect(body.action).toBe("REPORT");
  expect(body.report).toBe("The status bar overlaps the toolbar.");
});

test("Shift+Enter keeps the composer's newline and posts nothing", async () => {
  const posted = stubFetch();
  const { composer } = await openComposerView();
  composer.value = "A first line";
  await fireEvent.input(composer);

  await fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
  await tick();

  expect(posted.length).toBe(0);
});

test("an Ask renders the answer the page's conversation reports", async () => {
  const socket = openTransport();
  const { view, composer } = await openComposerView();
  composer.value = "What does this tab do?";
  await fireEvent.input(composer);

  const askButton = view.container.querySelector('[aria-label="Ask the agent about this element"]');
  if (askButton === null) throw new Error("the panel has no Ask control");
  await fireEvent.click(askButton);
  await tick();

  const ask = socket.sent
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .find((frame) => frame.type === "ask");
  if (ask === undefined) throw new Error("the page sent no ask");
  const conversationId = ask.conversationId as string;
  // The read waits for the creation's own answer, so it never names a
  // conversation the server has not stored yet — an inquiry missing for that
  // id would drop the registration and leave the turn unwatched.
  expect(socket.sent.some((frame) => JSON.parse(frame).type === "getInquiry")).toBe(false);

  // The creation answers with its accepted conversation, and the page follows
  // it: the turn streams in while the control still shows the busy word.
  socket.deliver({
    type: "inquiry",
    conversationId,
    busy: true,
    answer: "The tab opens the issues ",
    error: null,
    transcript: [{ role: "developer", text: "What does this tab do?" }],
  });
  await tick();
  expect(socket.sent.some((frame) => JSON.parse(frame).type === "getInquiry")).toBe(true);
  expect(view.container.textContent).toContain("The tab opens the issues");
  expect(view.container.textContent).toContain("Asking…");

  // The settled conversation carries the final turns and releases the control.
  socket.deliver({
    type: "inquiry",
    conversationId,
    busy: false,
    answer: "",
    error: null,
    transcript: [
      { role: "developer", text: "What does this tab do?" },
      { role: "agent", text: "The tab opens the issues mode." },
    ],
  });
  await tick();
  expect(view.container.textContent).toContain("The tab opens the issues mode.");
  expect(view.container.textContent).not.toContain("Asking…");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
});
