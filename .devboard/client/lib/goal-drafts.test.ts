import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { connection } = await import("./connection.svelte");
const { goalDrafts } = await import("./goal-drafts.svelte");
const { queryClient } = await import("./query-client");

const PATH = ".devboard/goal-proposals/example.md";

const originalSend = connection.send;

afterEach(() => {
  // The test shadows the class getter with an own property; remove it so the
  // prototype getter (and every later test's closed connection) is back.
  delete (connection as unknown as Record<string, unknown>).open;
  connection.send = originalSend;
  goalDrafts.clearDraft();
});

test("a stored draft is not read again while its first read is unanswered", () => {
  const reads: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
    reads.push(filters?.queryKey);
    return Promise.resolve();
  }) as typeof queryClient.invalidateQueries;
  Object.defineProperty(connection, "open", { get: () => true, configurable: true });

  try {
    goalDrafts.openDraft(PATH);
    expect(reads).toEqual([["getGoalDraft", PATH]]);

    // The drafts page's two-second restore runs while that read is
    // outstanding; it must not ask for another copy every tick.
    goalDrafts.restoreDraft();
    goalDrafts.restoreDraft();
    expect(reads).toHaveLength(1);

    goalDrafts.handleEvent({
      type: "issuesDraftDetail",
      draft: { path: PATH, name: "example.md", text: "text" },
    });
    expect(goalDrafts.draft?.path).toBe(PATH);

    // A read the server refused is answered too, so the restore retries it.
    goalDrafts.clearDraft();
    goalDrafts.openDraft(PATH);
    goalDrafts.handleEvent({
      type: "issuesDraftError",
      path: PATH,
      message: "The draft is being elaborated.",
    });
    goalDrafts.restoreDraft();
    expect(reads).toHaveLength(3);
    expect(reads[2]).toEqual(["getGoalDraft", PATH]);
  } finally {
    queryClient.invalidateQueries = original;
  }
});

test("a refused draft answer reports nothing sent and its refusal frame answers the control", () => {
  const sent: unknown[] = [];
  Object.defineProperty(connection, "open", { get: () => true, configurable: true });
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;

  const question = { id: 3, message: "Which name?", options: [] };
  goalDrafts.draftPath = PATH;
  goalDrafts.draftRuns = {
    [PATH]: {
      status: "running",
      path: PATH,
      startedAt: null,
      finishedAt: null,
      error: null,
      activity: [],
      question,
    },
  };

  expect(goalDrafts.answerRevision(PATH)).toBe(0);
  expect(goalDrafts.submitDraftAnswer("Aurora")).toBe(true);
  expect(sent).toEqual([{ type: "answerGoalDraft", path: PATH, id: 3, value: "Aurora" }]);

  // The refusal names the draft, so the waiting control's revision moves while
  // the draft run and its question stay untouched.
  goalDrafts.handleEvent({
    type: "issuesDraftError",
    path: PATH,
    message: "That question is no longer waiting for an answer.",
  });
  expect(goalDrafts.answerRevision(PATH)).toBe(1);
});

test("a failed draft-list read keeps the selection and reports its message", () => {
  const drafts = [{ path: PATH, name: "example.md", heading: "Example" }];
  const detail = { path: PATH, name: "example.md", heading: "Example", text: "# Example" };
  const runs = {
    [PATH]: {
      status: "idle" as const,
      path: PATH,
      startedAt: null,
      finishedAt: null,
      error: null,
      activity: [],
      question: null,
    },
  };
  goalDrafts.drafts = drafts;
  goalDrafts.draft = detail;
  goalDrafts.draftPath = PATH;
  goalDrafts.draftRuns = runs;

  try {
    // `read_dir` failed: the frame carries the message and no list, so the
    // page keeps what it showed instead of claiming the directory is empty.
    goalDrafts.handleEvent({
      type: "issuesDrafts",
      error: "Could not read .devboard/goal-proposals: Not a directory (os error 20)",
    });
    expect(goalDrafts.draftsReadError).toContain(".devboard/goal-proposals");
    expect(goalDrafts.drafts).toEqual(drafts);
    expect(goalDrafts.draftPath).toBe(PATH);
    expect(goalDrafts.draft).toEqual(detail);
    expect(goalDrafts.draftRuns).toEqual(runs);

    // A frame with neither a list nor a message is not authoritative either.
    goalDrafts.handleEvent({ type: "issuesDrafts" });
    expect(goalDrafts.draftPath).toBe(PATH);
    expect(goalDrafts.draft).toEqual(detail);

    // The absent directory's authoritative empty list clears the vanished
    // selection and the recorded failure.
    goalDrafts.handleEvent({ type: "issuesDrafts", drafts: [] });
    expect(goalDrafts.draftsReadError).toBeNull();
    expect(goalDrafts.drafts).toEqual([]);
    expect(goalDrafts.draftPath).toBeNull();
    expect(goalDrafts.draft).toBeNull();
  } finally {
    goalDrafts.drafts = [];
    goalDrafts.draftRuns = {};
  }
});

test("a draft answer with no selected draft or no question sends nothing", () => {
  const sent: unknown[] = [];
  Object.defineProperty(connection, "open", { get: () => true, configurable: true });
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;

  goalDrafts.clearDraft();
  expect(goalDrafts.submitDraftAnswer("Aurora")).toBe(false);

  goalDrafts.draftPath = PATH;
  goalDrafts.draftRuns = {
    [PATH]: {
      status: "idle",
      path: PATH,
      startedAt: null,
      finishedAt: null,
      error: null,
      activity: [],
      question: null,
    },
  };
  expect(goalDrafts.submitDraftAnswer("Aurora")).toBe(false);
  expect(sent).toEqual([]);
});
