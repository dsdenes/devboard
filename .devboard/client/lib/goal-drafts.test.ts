import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { connection } = await import("./connection.svelte");
const { goalDrafts } = await import("./goal-drafts.svelte");

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
  const sent: unknown[] = [];
  Object.defineProperty(connection, "open", { get: () => true, configurable: true });
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;

  goalDrafts.openDraft(PATH);
  expect(sent).toEqual([{ type: "getGoalDraft", path: PATH }]);

  // The drafts page's two-second restore runs while that read is outstanding;
  // it used to send another copy every tick.
  goalDrafts.restoreDraft();
  goalDrafts.restoreDraft();
  expect(sent).toHaveLength(1);

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
  expect(sent).toHaveLength(3);
  expect(sent[2]).toEqual({ type: "getGoalDraft", path: PATH });
});
