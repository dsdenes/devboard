import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { connection } from "./lib/connection.svelte";
import type { FeedbackAction, FeedbackPhase } from "./lib/types";

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
const { default: FeedbackOverlayHarness } = await import(
  "../tests/fixtures/feedback-overlay-harness.svelte"
);
const { default: FeedbackOverlay } = await import("./FeedbackOverlay.svelte");

/** Stands in for the browser socket so one server frame arrives on demand. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];

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

  open(): FakeSocket {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    return this;
  }

  deliver(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

/** One connected socket the overlay's Ask conversation sends on. */
function connectOverFakeSocket(): FakeSocket {
  FakeSocket.instances = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  connection.connect();
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (socket === undefined) throw new Error("no socket created");
  return socket.open();
}

type PendingRequest = {
  url: string;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

const pending: PendingRequest[] = [];
const originalFetch = globalThis.fetch;
const originalElementFromPoint = document.elementFromPoint;
const originalWebSocket = globalThis.WebSocket;

function reply(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  pending.length = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    pending.push({ url: String(input), resolve, reject });
    return promise;
  }) as typeof fetch;
});

afterEach(() => {
  connection.dispose();
  FakeSocket.instances = [];
  globalThis.WebSocket = originalWebSocket;
  cleanup();
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
  document.elementFromPoint = originalElementFromPoint;
  document.body.style.cursor = "";
});

/** Renders the overlay, arms reporting, and picks the target element. */
async function openPanel() {
  const snapshot: { phase: FeedbackPhase; action: FeedbackAction | null } = {
    phase: "idle",
    action: null,
  };
  const view = render(FeedbackOverlayHarness, { props: { snapshot } });
  const { startPicking } = view.component as unknown as { startPicking(): void };

  startPicking();
  await tick();
  expect(snapshot.phase).toBe("picking");
  expect(snapshot.action).toBe("REPORT");
  expect(document.body.style.cursor).toBe("crosshair");

  const target = document.createElement("button");
  target.textContent = "Target";
  document.body.appendChild(target);
  document.elementFromPoint = () => target;
  fireEvent.click(target);
  await tick();
  expect(snapshot.phase).toBe("composing");

  const textarea = view.getByLabelText("Issue description");
  fireEvent.input(textarea, { target: { value: "The target is broken." } });
  await tick();
  return { view, snapshot };
}

/** A closed panel leaves no armed action, no cursor, and nothing announced. */
function expectClosed(snapshot: { phase: FeedbackPhase; action: FeedbackAction | null }) {
  expect(snapshot.phase).toBe("idle");
  expect(snapshot.action).toBeNull();
  expect(document.body.style.cursor).toBe("");
}

test("a goal answer names the created draft from its hypertext link", async () => {
  const { view } = await openPanel();

  fireEvent.click(view.getByTestId("feedback-goal"));
  await tick();
  expect(pending.map((request) => request.url)).toEqual(["/goal-proposals"]);

  pending[0]?.resolve(
    reply({ links: { draft: { href: "http://127.0.0.1:8080/goal-proposals/draft.md" } } }),
  );
  // Each await hop (fetch, json, postGoal, proposeGoal) needs its own turn.
  for (let hop = 0; hop < 4; hop++) await tick();

  expect(view.getByTestId("feedback-result").textContent?.trim()).toBe(
    "Goal proposed: .devboard/goal-proposals/draft.md",
  );
});

test("a goal answer that lands after Close leaves the overlay idle and unarmed", async () => {
  const { view, snapshot } = await openPanel();

  fireEvent.click(view.getByTestId("feedback-goal"));
  await tick();
  expect(pending.map((request) => request.url)).toEqual(["/goal-proposals"]);

  fireEvent.click(view.getByLabelText("Close"));
  await tick();
  expectClosed(snapshot);

  pending[0]?.resolve(
    reply({ links: { draft: { href: "http://127.0.0.1:8080/goal-proposals/draft.md" } } }),
  );
  await tick();
  await tick();

  expectClosed(snapshot);
  expect(view.queryByTestId("feedback-result")).toBeNull();
  expect(view.container.querySelector(".feedback-panel")).toBeNull();
  expect(view.container.querySelector(".feedback-hint")).toBeNull();
});

test("a report answer that lands after Close leaves the overlay idle and unarmed", async () => {
  const { view, snapshot } = await openPanel();

  fireEvent.click(view.getByRole("button", { name: "File issue" }));
  await tick();
  expect(pending.map((request) => request.url)).toEqual(["/feedback"]);
  expect(snapshot.phase).toBe("sending");

  fireEvent.click(view.getByLabelText("Close"));
  await tick();
  expectClosed(snapshot);

  pending[0]?.resolve(
    reply({ links: { issue: { href: "http://localhost:3001/dsdenes/devboard/issues/1" } } }),
  );
  await tick();
  await tick();

  expectClosed(snapshot);
  expect(view.queryByTestId("feedback-result")).toBeNull();
  expect(view.container.querySelector(".feedback-panel")).toBeNull();
  expect(view.container.querySelector(".feedback-hint")).toBeNull();
});

test("a rejected goal post after Close leaves no error an absent panel cannot show", async () => {
  const { view, snapshot } = await openPanel();

  fireEvent.click(view.getByTestId("feedback-goal"));
  await tick();
  expect(pending).toHaveLength(1);

  fireEvent.click(view.getByLabelText("Close"));
  await tick();
  expectClosed(snapshot);

  pending[0]?.reject(new Error("network down"));
  await tick();
  await tick();

  expectClosed(snapshot);
  expect(view.container.querySelector(".feedback-error")).toBeNull();
  expect(view.queryByTestId("feedback-result")).toBeNull();
});

test("a failed ask returns its question to the composer and re-enables every action", async () => {
  const { view } = await openPanel();
  const socket = connectOverFakeSocket();
  const composer = view.getByLabelText("Issue description") as HTMLTextAreaElement;
  fireEvent.input(composer, { target: { value: "Why is the target broken?" } });
  await tick();

  fireEvent.click(view.getByTestId("feedback-ask"));
  await tick();
  const first = socket.frames().find((frame) => frame.type === "ask");
  expect(first?.question).toBe("Why is the target broken?");

  socket.deliver({
    type: "askError",
    conversationId: first?.conversationId,
    message: "The ask agent did not answer within 120 seconds.",
  });
  await tick();

  expect(composer.value).toBe("Why is the target broken?");
  expect(view.getByText("The ask agent did not answer within 120 seconds.")).toBeTruthy();
  const buttons = [
    ...view.container.querySelectorAll<HTMLButtonElement>(".feedback-actions button"),
  ];
  expect(buttons.map((button) => button.textContent?.trim())).toEqual([
    "File issue",
    "Ask",
    "Goal",
    "Cancel",
  ]);
  expect(buttons.map((button) => button.disabled)).toEqual([false, false, false, false]);

  // Re-asking is one click: the restored question goes back over the socket.
  fireEvent.click(view.getByTestId("feedback-ask"));
  await tick();
  const asks = socket.frames().filter((frame) => frame.type === "ask");
  expect(asks).toHaveLength(2);
  expect(asks[1]?.question).toBe("Why is the target broken?");
});
