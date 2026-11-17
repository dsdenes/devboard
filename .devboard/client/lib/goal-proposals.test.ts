import { expect, test } from "bun:test";

import { draftPathFromHref, isGoalDraftName } from "../../lib/goal-proposals.ts";

const BASE = "http://127.0.0.1:8080";

// The server's `is_goal_draft_name` is the same rule, and its list publishes
// `alpha.md` while refusing the backslash name, so one name is proven through
// every reader here and in the server's route test.
test("the name the drafts list publishes decodes to the path the readers open", () => {
  expect(isGoalDraftName("alpha.md")).toBe(true);
  expect(draftPathFromHref(`${BASE}/goal-proposals/alpha.md`)).toBe(
    ".devboard/goal-proposals/alpha.md",
  );
});

test("a backslash name is no draft name, so its link decodes to nothing", () => {
  expect(isGoalDraftName("a\\b.md")).toBe(false);
  expect(draftPathFromHref(`${BASE}/goal-proposals/a%5Cb.md`)).toBeNull();
});

test("a name that is not one .md segment stays refused", () => {
  expect(isGoalDraftName("..")).toBe(false);
  expect(isGoalDraftName("draft.txt")).toBe(false);
  expect(draftPathFromHref(`${BASE}/goal-proposals/..%2Fetc%2Fpasswd.md`)).toBeNull();
  expect(draftPathFromHref(`file:///repo/.devboard/goal-proposals/alpha.md`)).toBeNull();
});
