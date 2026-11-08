import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { ConnectionStore } from "./connection.svelte";
import { fileFeedback, writeGoalDraft } from "./feedback-transport";
import { GoalDraftsStore } from "./goal-drafts.svelte";
import { notifications } from "./notifications.svelte";
import { slowUiActionIdempotencyKey } from "./notification-issue";
import {
  SLOW_UI_ACTION_BUDGET_MS,
  SLOW_UI_ACTION_INSTRUCTION,
  SlowUiActionGuard,
  actionIdentity,
  actionSubject,
  slowActionReport,
  slowUiAction,
  type SlowUiActionContext,
  type SlowUiActionNotice,
  type SlowUiActionSink,
} from "./slow-ui-action";
import type { NotificationIssueState } from "./types";

const DISPATCHED_AT = Date.parse("2026-11-07T12:00:00.000Z");

const context: SlowUiActionContext = {
  route: "/issues",
  url: "http://localhost:3001/issues",
  selector: "#issues-start",
  domExcerpt: '<button id="issues-start">Start</button>',
  visibleText: "Start",
  viewport: "1365x768 @1.25x",
  capturedAt: "2026-11-07T12:00:00.000Z",
};

class FakeSink implements SlowUiActionSink {
  notices: SlowUiActionNotice[] = [];
  updates: Array<{ id: number; issue: NotificationIssueState }> = [];
  posts: Array<{ report: string; key: string }> = [];
  enabled = true;
  outcome: { ok: true; url: string } | { ok: false; error: string } = {
    ok: true,
    url: "http://localhost:3001/dsdenes/devboard/issues/42",
  };
  page = context;

  reportingEnabled(): boolean {
    return this.enabled;
  }

  captureContext(): SlowUiActionContext {
    return this.page;
  }

  show(notice: SlowUiActionNotice): number {
    this.notices.push(notice);
    return this.notices.length;
  }

  update(id: number, issue: NotificationIssueState): void {
    this.updates.push({ id, issue });
  }

  async file(
    report: string,
    key: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    this.posts.push({ report, key });
    return this.outcome;
  }
}

function guarded(sink: FakeSink, options: { budgetMs?: number } = {}): SlowUiActionGuard {
  const guard = new SlowUiActionGuard();
  guard.install(sink, { budgetMs: options.budgetMs, now: () => DISPATCHED_AT });
  return guard;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  slowUiAction.uninstall();
  notifications.clear();
  FakeSocket.instances = [];
  restoreGlobals();
});

test("operator and initial dispatches start an action; refresh and reconnect do not", () => {
  installGlobals();
  const sink = new FakeSink();
  slowUiAction.install(sink, { now: () => DISPATCHED_AT });
  const connection = new ConnectionStore();
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  // Six first-paint reads on the first open.
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.notices).toHaveLength(6);
  expect(sink.notices.map((notice) => notice.command)).toEqual([
    "listRecords",
    "getGoal",
    "getSkills",
    "getProject",
    "getVersion",
    "getProviders",
  ]);

  connection.send({ type: "startAgent", id: "scout" });
  connection.send({ type: "getMcpTools" });
  connection.send({ type: "getGoalDrafts" });
  connection.send({ type: "stopAgent", id: "scout" }, "refresh");
  connection.send({ type: "getComplexity" }, "reconnect");
  connection.send({ type: "getResources" }, "initial");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);

  const commands = sink.notices.slice(6).map((notice) => notice.command);
  expect(commands).toEqual(["startAgent", "getResources"]);

  socket.close();
  connection.connect();
  const replacement = FakeSocket.instances[1];
  if (replacement === undefined) throw new Error("no replacement socket created");
  replacement.open();
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.notices).toHaveLength(8);
});

test("a confirming frame at 999 ms files nothing and completes the action", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatch({ type: "startAgent", id: "scout" }, "operator");

  jest.advanceTimersByTime(999);
  expect(sink.posts).toHaveLength(0);
  expect(sink.notices).toHaveLength(0);

  guard.observe({ type: "agentState", agent: { id: "scout", lifecycle: "starting" } });
  jest.advanceTimersByTime(2000);
  expect(sink.posts).toHaveLength(0);
  expect(sink.notices).toHaveLength(0);
});

test("no frame at 1000 ms files exactly one issue", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatch({ type: "stopAgent", id: "scout" }, "operator");

  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS - 1);
  expect(sink.posts).toHaveLength(0);
  jest.advanceTimersByTime(1);
  expect(sink.posts).toHaveLength(1);
  expect(sink.notices).toHaveLength(1);
  expect(sink.updates[0]).toEqual({ id: 1, issue: { status: "pending" } });
  expect(sink.updates.at(-1)?.issue.status).toBe("filed");
});

test("a frame at 1001 ms neither cancels nor duplicates the filed issue", async () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatch({ type: "stopAgent", id: "scout" }, "operator");

  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.posts).toHaveLength(1);
  await flush();

  guard.observe({ type: "agentState", agent: { id: "scout", lifecycle: "stopping" } });
  jest.advanceTimersByTime(2000);
  await flush();

  expect(sink.posts).toHaveLength(1);
  expect(sink.notices).toHaveLength(1);
  expect(sink.updates.at(-1)).toEqual({
    id: 1,
    issue: { status: "filed", href: "http://localhost:3001/dsdenes/devboard/issues/42" },
  });
});

test("head-of-line queueing: a fast startAgent acknowledgement is not filed while the action behind it is", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatch({ type: "startAgent", id: "scout" }, "operator");
  guard.dispatch({ type: "getComplexity" }, "operator");

  guard.observe({ type: "agentState", agent: { id: "scout", lifecycle: "starting" } });
  jest.advanceTimersByTime(2000);

  expect(sink.notices).toHaveLength(1);
  expect(sink.notices[0]?.command).toBe("getComplexity");
  expect(sink.posts).toHaveLength(1);
});

test("an unrelated frame or a broadcast for another action does not complete it", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatch({ type: "startAgent", id: "scout" }, "operator");

  guard.observe({ type: "agentState", agent: { id: "watchdog", lifecycle: "starting" } });
  guard.observe({ type: "versionState", running: "1", installed: "1", latest: "1", stale: false });
  guard.observe({ type: "error", message: "Something else failed." });
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);

  expect(sink.posts).toHaveLength(1);
  expect(sink.notices).toHaveLength(1);
});

test("a draft answer completes on the state frame that answers it", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  // The wire command names the draft path and the question it answers; the
  // answering frame echoes only the path.
  guard.dispatch(
    { type: "answerGoalDraft", path: ".devboard/goal-proposals/a.md", id: 9, value: "Alpha" },
    "operator",
  );

  jest.advanceTimersByTime(400);
  guard.observe({
    type: "issuesDraftState",
    draft: { path: ".devboard/goal-proposals/a.md", status: "running", question: null },
  });
  jest.advanceTimersByTime(2000);

  expect(sink.notices).toHaveLength(0);
  expect(sink.posts).toHaveLength(0);
});

test("a draft answer stays pending until its own draft answers it", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatch(
    { type: "answerGoalDraft", path: ".devboard/goal-proposals/a.md", id: 9, value: "Alpha" },
    "operator",
  );

  guard.observe({
    type: "issuesDraftState",
    draft: { path: ".devboard/goal-proposals/b.md", status: "running", question: null },
  });
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);

  expect(sink.notices).toHaveLength(1);
  expect(sink.notices[0]?.subject).toBe(".devboard/goal-proposals/a.md");
});

test("a draft answer is identified by the draft it answers, not its question id", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatch({ type: "answerGoalDraft", path: "drafts/a.md", id: 9, value: "Alpha" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);

  expect(sink.notices[0]?.subject).toBe("drafts/a.md");
  expect(sink.notices[0]?.label).toBe("answerGoalDraft drafts/a.md");
  expect(sink.posts[0]?.report).toContain("Subject: drafts/a.md");
  expect(sink.posts[0]?.key).toBe(
    slowUiActionIdempotencyKey(actionIdentity("answerGoalDraft", "drafts/a.md", "/issues")),
  );

  // Question 9 in another draft is another action, so it files its own card.
  guard.dispatch({ type: "answerGoalDraft", path: "drafts/b.md", id: 9, value: "Alpha" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.notices).toHaveLength(2);
  expect(sink.notices[1]?.label).toBe("answerGoalDraft drafts/b.md");
});

test("one identity files once while a different identity files its own issue", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);

  guard.dispatch({ type: "startAgent", id: "scout" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  guard.dispatch({ type: "startAgent", id: "scout" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.posts).toHaveLength(1);
  expect(sink.notices).toHaveLength(1);

  guard.dispatch({ type: "startAgent", id: "watchdog" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.posts).toHaveLength(2);
  expect(sink.notices).toHaveLength(2);
});

test("the idempotency key is stable across instances and ignores elapsed time", () => {
  const first = new FakeSink();
  const firstGuard = guarded(first);
  firstGuard.dispatch({ type: "startAgent", id: "scout" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);

  const second = new FakeSink();
  const secondGuard = new SlowUiActionGuard();
  secondGuard.install(second, { now: () => DISPATCHED_AT + 399_000 });
  secondGuard.dispatch({ type: "startAgent", id: "scout" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);

  expect(first.posts[0]?.key).toBe(second.posts[0]?.key);
  expect(first.posts[0]?.key).toMatch(/^slow-ui-action:[0-9a-f]{16}$/);
  expect(first.posts[0]?.key).toBe(
    slowUiActionIdempotencyKey(actionIdentity("startAgent", "scout", "/issues")),
  );
});

test("the report leads with the action and carries the exact instruction inside 8000 units", () => {
  const sink = new FakeSink();
  sink.page = {
    route: `/${"r".repeat(20_000)}`,
    url: `http://localhost:3001/${"u".repeat(20_000)}`,
    selector: "s".repeat(20_000),
    domExcerpt: "d".repeat(100_000),
    visibleText: "v".repeat(100_000),
    viewport: "1".repeat(10_000),
    capturedAt: "2026-11-07T12:00:00.000Z",
  };
  const guard = guarded(sink);
  guard.dispatch({ type: "startAgent", id: "x".repeat(20_000) }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);

  const report = sink.posts[0]?.report ?? "";
  expect(report.length).toBeLessThanOrEqual(8000);
  expect(report.split("\n").find((line) => line.trim().length > 0)?.startsWith("Slow UI action: ")).toBe(
    true,
  );
  expect(report).toContain("exceeded the 1000 ms budget.");
  expect(report).toContain("Command: startAgent");
  expect(report).toContain("Budget: 1000 ms");
  expect(report).toContain("Dispatched at: 2026-11-07T12:00:00.000Z");
  expect(report).toContain(SLOW_UI_ACTION_INSTRUCTION);
  expect(report.split(SLOW_UI_ACTION_INSTRUCTION)).toHaveLength(2);
});

test("disabled reporting sends no request and states why the card has no issue", async () => {
  const sink = new FakeSink();
  sink.enabled = false;
  const guard = guarded(sink);
  guard.dispatch({ type: "startAgent", id: "scout" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  await flush();

  expect(sink.posts).toHaveLength(0);
  expect(sink.notices).toHaveLength(1);
  expect(sink.updates.at(-1)).toEqual({ id: 1, issue: { status: "disabled" } });
});

test("a failed filing keeps its detail and a retry replaces it with the issue link", async () => {
  const sink = new FakeSink();
  sink.outcome = { ok: false, error: "The issue could not be filed." };
  const guard = guarded(sink);
  guard.dispatch({ type: "startAgent", id: "scout" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  await flush();
  expect(sink.updates.at(-1)).toEqual({
    id: 1,
    issue: { status: "failed", detail: "The issue could not be filed." },
  });

  sink.outcome = { ok: true, url: "http://localhost:3001/dsdenes/devboard/issues/42" };
  await guard.retry(1);
  expect(sink.posts).toHaveLength(2);
  expect(sink.posts[1]?.key).toBe(sink.posts[0]?.key);
  expect(sink.updates.at(-1)).toEqual({
    id: 1,
    issue: { status: "filed", href: "http://localhost:3001/dsdenes/devboard/issues/42" },
  });
});

test("no recursion: the guard never monitors its own filing request", async () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatch({ type: "startAgent", id: "scout" }, "operator");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  await flush();
  const posts = sink.posts.length;

  jest.advanceTimersByTime(10_000);
  await flush();
  expect(sink.posts).toHaveLength(posts);
  expect(sink.notices).toHaveLength(1);
});

test("restart exclusion: a reconnect clears every pending action without filing", () => {
  installGlobals();
  const sink = new FakeSink();
  slowUiAction.install(sink, { now: () => DISPATCHED_AT });
  const connection = new ConnectionStore();
  connection.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("no socket created");
  socket.open();

  connection.send({ type: "startAgent", id: "scout" });
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS - 10);
  socket.close();
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.posts).toHaveLength(0);
  expect(sink.notices).toHaveLength(0);

  connection.connect();
  const replacement = FakeSocket.instances[1];
  if (replacement === undefined) throw new Error("no replacement socket created");
  replacement.open();
  connection.restarting = true;
  expect(connection.send({ type: "startAgent", id: "scout" })).toBe(true);
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.posts).toHaveLength(0);
});

test("the subject reads the identifying field and leaves elapsed time out", () => {
  expect(actionSubject({ type: "startAgent", id: "scout" })).toBe("scout");
  expect(actionSubject({ type: "getIssuesRun", runId: "run-1" })).toBe("run-1");
  expect(actionSubject({ type: "getGoalDraft", path: "drafts/a.md" })).toBe("drafts/a.md");
  expect(actionSubject({ type: "answerGoalDraft", path: "drafts/a.md", id: 9 })).toBe(
    "drafts/a.md",
  );
  expect(actionSubject({ type: "closeIssue", number: 1535 })).toBe("1535");
  expect(actionSubject({ type: "getVersion" })).toBe("");
  expect(actionIdentity("startAgent", "scout", "/issues")).toBe("startAgent|scout|/issues");
  expect(slowActionReport(
    {
      label: "startAgent scout",
      command: "startAgent",
      subject: "scout",
      route: "/issues",
      budgetMs: SLOW_UI_ACTION_BUDGET_MS,
      dispatchedAt: "2026-11-07T12:00:00.000Z",
    },
    context,
  )).toContain("Slow UI action: startAgent scout exceeded the 1000 ms budget.");
});

/** Stands in for the browser socket: the frames the page sends are explicit. */
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

test("an operator POST is registered and completes only when its response arrives", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  const action = guard.dispatchHttp("POST /reports");
  expect(action).not.toBeNull();

  guard.observe({ type: "versionState", running: "1", installed: "1", latest: "1", stale: false });
  jest.advanceTimersByTime(999);
  expect(sink.posts).toHaveLength(0);
  action?.complete();
  jest.advanceTimersByTime(2_000);
  expect(sink.posts).toHaveLength(0);

  guard.dispatchHttp("POST /reports");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.posts).toHaveLength(1);
  expect(sink.notices[0]?.text).toBe(
    "Slow UI action: POST /reports exceeded the 1000 ms budget.",
  );
  expect(sink.posts[0]?.report.split("\n")[0]).toBe(
    "Slow UI action: POST /reports exceeded the 1000 ms budget.",
  );
  expect(sink.posts[0]?.report).toContain("Command: POST /reports");
  expect(sink.posts[0]?.report).toContain("Subject: (none)");
});

test("one endpoint identity files once while another endpoint files its own issue", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  guard.dispatchHttp("POST /reports");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  guard.dispatchHttp("POST /reports");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.posts).toHaveLength(1);

  guard.dispatchHttp("POST /goal-proposals");
  jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  expect(sink.posts).toHaveLength(2);
  expect(sink.posts[1]?.report).toContain("Command: POST /goal-proposals");
});

test("the two operator POST helpers register their endpoint actions", () => {
  const sink = new FakeSink();
  const guard = guarded(sink);
  slowUiAction.install(sink, { now: () => DISPATCHED_AT });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  try {
    void fileFeedback({ action: "REPORT", report: "Slow report" });
    void writeGoalDraft({ report: "Slow draft" });
    void new GoalDraftsStore().createDraft("Slow draft");
    jest.advanceTimersByTime(SLOW_UI_ACTION_BUDGET_MS);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(sink.notices.map((notice) => notice.command)).toEqual([
    "POST /reports",
    "POST /goal-proposals",
  ]);
  expect(sink.posts).toHaveLength(2);
  guard.reset();
});
