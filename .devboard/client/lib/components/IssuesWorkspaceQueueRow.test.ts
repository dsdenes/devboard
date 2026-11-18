import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The row's geometry lives in the client's global stylesheet, which only
// `main.ts` imports. Mounting the same sheet makes the tracks this file reads
// the tracks the page ships, so a reverted rule fails here.
const sheet = document.createElement("style");
sheet.textContent = readFileSync(new URL("../../app.css", import.meta.url), "utf8");
document.head.append(sheet);

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket so each dispatched command is readable. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: FakeEnvelope) => void) | null = null;
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

  deliver(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const globals = globalThis as unknown as Record<string, unknown>;

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: IssuesWorkspace } = await import("./IssuesWorkspace.svelte");
const { connection } = await import("../connection.svelte");
const { issues } = await import("../issues.svelte");

/** The Issues mode's Queue tab. */
const QUEUE = { id: "issues", kind: "queue", resourceId: "issues", title: "Issues" };

/** A title only the flexible track can ellipsize, so the row keeps three tracks. */
const LONG_TITLE =
  "Queue row title long enough that only the flexible track may ellipsize it inside one line";

/** The words the row's single state badge may carry. */
const STATE_WORDS: Record<string, true> = { running: true, pending: true, handled: true };

/** A snapshot whose queue holds a goal+running issue and a handled issue. */
function state(): Record<string, unknown> {
  return {
    type: "issuesState",
    root: "/repo",
    repo: "dsdenes/devboard",
    lifecycle: "running",
    enabled: true,
    queue: [
      {
        number: 19,
        title: LONG_TITLE,
        url: "https://tracker.test/issues/19",
        createdAt: "2026-11-01T00:00:00Z",
        labels: ["goal", "processing"],
        handled: false,
        runId: null,
        agentRunId: "run-19",
      },
      {
        number: 20,
        title: "Handled issue 20",
        url: "https://tracker.test/issues/20",
        createdAt: "2026-11-01T00:00:00Z",
        labels: [],
        handled: true,
        runId: "run-7",
        agentRunId: null,
      },
    ],
    runs: [],
    agents: [
      {
        runId: "run-19",
        issueNumber: 19,
        startedAt: "2026-11-01T00:00:00Z",
        question: null,
        acp: null,
      },
    ],
  };
}

/** Every badge the row carries, in document order. */
function badges(root: Element): Element[] {
  return [...root.querySelectorAll(".badge")];
}

/** The row's state badges: the ones whose text is a lifecycle word. */
function stateBadges(root: Element): Element[] {
  return badges(root).filter((badge) => STATE_WORDS[badge.textContent?.trim() ?? ""] === true);
}

connection.onMessage((message) => {
  issues.handleEvent(message as Record<string, unknown>);
});

afterEach(() => {
  cleanup();
  connection.dispose();
  FakeSocket.instances = [];
});

test("a goal and running row keeps both badges inside one trailing meta group", async () => {
  // The preload restores the native WebSocket before every test.
  globals.WebSocket = FakeSocket;
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  socket.deliver(state());

  const view = render(IssuesWorkspace, { props: { tab: QUEUE } });
  const rows = await view.findAllByTestId("issues-queue-item");
  if (rows[0] === undefined) throw new Error("no queue row rendered");

  // The row is three fixed tracks: the number link, the title, and one meta
  // group. A badge rendered beside the meta group instead of inside it is a
  // fourth grid child, which pushes the state word onto a second line.
  const row = rows[0];
  const children = [...row.children];
  expect(children.map((child) => child.tagName)).toEqual(["A", "SPAN", "SPAN"]);
  expect(children[0]?.className).toBe("issues-queue__number mono");
  expect(children[1]?.className).toBe("issues-queue__title");
  expect(children[2]?.className).toBe("issues-queue__meta");
  expect(badges(row).filter((badge) => !children[2]?.contains(badge))).toEqual([]);

  // The one meta group carries the goal badge and exactly one state badge.
  const meta = children[2];
  if (meta === undefined) throw new Error("no meta group rendered");
  expect(meta.querySelector('[data-testid="issues-goal-badge"]')?.textContent?.trim()).toBe("goal");
  const states = stateBadges(meta);
  expect(states.length).toBe(1);
  expect(states[0]?.getAttribute("data-testid")).toBe("issues-running-marker");
  expect(states[0]?.textContent?.trim()).toBe("running");
  expect(badges(meta).length).toBe(2);

  // The stylesheet is the rest of the contract: three tracks with the leading
  // number track at 44px keep the state word beside the title on the first
  // line, and the meta group must not wrap. Reverting the column list to the
  // pre-fix `68px minmax(0, 1fr) auto` is the 56px row the queue was fixed for.
  const rowStyle = getComputedStyle(row);
  expect(rowStyle.display).toBe("grid");
  expect(rowStyle.gridTemplateColumns).toBe("44px minmax(0, 1fr) auto");
  expect(getComputedStyle(meta).whiteSpace).toBe("nowrap");

  // The only flexible track ellipsizes; the full title stays in `title`.
  expect(children[1]?.getAttribute("title")).toBe(LONG_TITLE);
  expect(children[1]?.textContent).toBe(LONG_TITLE);
});

test("a handled row keeps the same three tracks and one meta-group state badge", async () => {
  globals.WebSocket = FakeSocket;
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  socket.deliver(state());

  const view = render(IssuesWorkspace, { props: { tab: QUEUE } });
  const rows = await view.findAllByTestId("issues-queue-item");
  const handled = rows.find((row) => row.getAttribute("data-number") === "20");
  if (handled === undefined) throw new Error("no handled row rendered");

  const children = [...handled.children];
  expect(children.length).toBe(3);
  expect(children[2]?.className).toBe("issues-queue__meta");
  expect(badges(handled).filter((badge) => !children[2]?.contains(badge))).toEqual([]);
  expect(handled.querySelector('[data-testid="issues-goal-badge"]')).toBeNull();
  const states = stateBadges(handled);
  expect(states.length).toBe(1);
  expect(states[0]?.getAttribute("data-testid")).toBe("issues-handled-marker");
  expect(states[0]?.textContent?.trim()).toBe("handled");
  expect(states[0]?.getAttribute("data-tone")).toBe("success");
  expect(handled.getAttribute("data-goal")).toBe("false");
});
