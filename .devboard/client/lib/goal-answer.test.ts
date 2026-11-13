import { afterEach, expect, test } from "bun:test";
import { createCommandBusy } from "./command-busy.svelte";
import { connection } from "./connection.svelte";
import { GoalStore } from "./goal.svelte";

interface FakeEnvelope {
  data: string;
}

/** Stands in for the browser socket: the frames the page sends are explicit. */
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
}

const originalGlobals = {
  WebSocket: (globalThis as unknown as Record<string, unknown>).WebSocket,
  window: (globalThis as unknown as Record<string, unknown>).window,
  location: (globalThis as unknown as Record<string, unknown>).location,
};

function installGlobals(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  target.WebSocket = FakeSocket;
  target.window = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  target.location = { protocol: "http:", host: "test.invalid" };
}

function restoreGlobals(): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

function openSocket(): FakeSocket {
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();
  return socket;
}

afterEach(() => {
  FakeSocket.instances = [];
  connection.dispose();
  restoreGlobals();
});

/** The started frame the polled `/goal` read replays for a live manual run. */
function started(question: unknown): Record<string, unknown> {
  return {
    type: "runStarted",
    file: "a.md",
    title: "Adopt the fixture decision",
    action: "resolving",
    manual: true,
    question,
  };
}

const QUESTION = {
  id: 7,
  message: "Choose an answer",
  options: [{ label: "Alpha", recommended: true }],
};

test("an accepted answer keeps the prompt and the draft until its frame", () => {
  installGlobals();
  const store = new GoalStore();
  const socket = openSocket();
  store.handleEvent(started(QUESTION));
  store.draft = "Alpha";

  expect(store.submitAnswer(store.draft)).toBe(true);
  expect(socket.sent).toContain(JSON.stringify({ type: "answer", id: 7, value: "Alpha" }));
  expect(store.question?.id).toBe(7);
  expect(store.draft).toBe("Alpha");

  // The accepted answer's own frame is the only one that clears them.
  store.handleEvent({ type: "questionCleared", id: 7 });
  expect(store.question).toBeNull();
  expect(store.draft).toBe("");
});

test("a refused answer keeps both and releases the control at once", () => {
  installGlobals();
  const store = new GoalStore();
  openSocket();
  store.handleEvent(started(QUESTION));
  store.draft = "Alpha";

  const control = createCommandBusy({ label: "Submit answer", evidence: () => store.answerRevision });
  control.start();
  expect(control.busy).toBe(true);
  expect(store.submitAnswer(store.draft)).toBe(true);

  store.handleEvent({ type: "error", message: "No pending question with that id." });

  expect(control.busy).toBe(false);
  expect(control.notice).toBeNull();
  expect(store.question?.id).toBe(7);
  expect(store.draft).toBe("Alpha");
});

test("an answer the page could not send leaves the draft for the retry", () => {
  const store = new GoalStore();
  store.handleEvent(started(QUESTION));
  store.draft = "Alpha";

  expect(store.submitAnswer(store.draft)).toBe(false);
  expect(store.question?.id).toBe(7);
  expect(store.draft).toBe("Alpha");
});

test("a poll repeating the question keeps the draft and one that drops it clears it", () => {
  const store = new GoalStore();
  store.handleEvent(started(QUESTION));
  store.draft = "Alpha";

  // Every polled read replays the live run with the question it still holds.
  store.handleEvent(started(QUESTION));
  expect(store.question?.id).toBe(7);
  expect(store.draft).toBe("Alpha");

  // The read that follows an accepted answer carries no question.
  store.handleEvent(started(null));
  expect(store.question).toBeNull();
  expect(store.draft).toBe("");
});

test("a question cleared in another tab leaves a later question alone", () => {
  const store = new GoalStore();
  store.handleEvent(started(QUESTION));
  store.handleEvent({
    type: "question",
    id: 9,
    message: "Choose another",
    options: [],
  });

  store.handleEvent({ type: "questionCleared", id: 7 });
  expect(store.question?.id).toBe(9);
});

const LANE = {
  id: "lane-1",
  kind: "adr",
  epic: null,
  record: { file: "a.md", title: "Adopt the fixture decision" },
  attempt: 1,
  status: "running",
  activity: ["Inspecting a.md"],
  question: QUESTION,
};

function laneState(question: unknown): Record<string, unknown> {
  return {
    type: "laneState",
    lanes: [{ ...LANE, question }],
    openEpics: 0,
    runningLanes: 1,
  };
}

test("a lane answer keeps its prompt and draft until the frame that names it", () => {
  installGlobals();
  const store = new GoalStore();
  const socket = openSocket();
  store.handleEvent(laneState(QUESTION));
  store.laneDraft = "Alpha";

  expect(store.submitLaneAnswer("lane-1", store.laneDraft)).toBe(true);
  expect(socket.sent).toContain(
    JSON.stringify({ type: "answer", lane: "lane-1", id: 7, value: "Alpha" }),
  );
  expect(store.lane("lane-1")?.question?.id).toBe(7);
  expect(store.laneDraft).toBe("Alpha");

  store.handleEvent({ type: "questionCleared", lane: "lane-1", id: 7 });
  expect(store.lane("lane-1")?.question).toBeNull();
  expect(store.laneDraft).toBe("");
});

test("a lane snapshot without the question clears the draft that answered it", () => {
  const store = new GoalStore();
  store.handleEvent(laneState(QUESTION));
  store.laneDraft = "Alpha";

  store.handleEvent(laneState(null));
  expect(store.lane("lane-1")?.question).toBeNull();
  expect(store.laneDraft).toBe("");
});

test("a refused lane answer keeps the prompt and releases the control", () => {
  installGlobals();
  const store = new GoalStore();
  openSocket();
  store.handleEvent(laneState(QUESTION));
  store.laneDraft = "Alpha";

  const control = createCommandBusy({ label: "Submit answer", evidence: () => store.answerRevision });
  control.start();
  expect(store.submitLaneAnswer("lane-1", store.laneDraft)).toBe(true);
  store.handleEvent({ type: "error", message: "No pending question with that id." });

  expect(control.busy).toBe(false);
  expect(store.lane("lane-1")?.question?.id).toBe(7);
  expect(store.laneDraft).toBe("Alpha");
});
