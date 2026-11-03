import { describe, expect, test } from "bun:test";
import { GOAL_PROPOSALS_DIRECTORY, draftPathFromHref } from "./goal-proposals";

describe("draft path from link", () => {
  test("maps a draft's file URI to its repository-relative path", () => {
    expect(
      draftPathFromHref("file:///home/operator/repo/.devboard/goal-proposals/draft.md"),
    ).toBe(`${GOAL_PROPOSALS_DIRECTORY}/draft.md`);
  });

  test("refuses a value that is not an absolute file URI naming a draft", () => {
    for (const href of [
      ".devboard/goal-proposals/draft.md",
      "https://example.com/.devboard/goal-proposals/draft.md",
      "file:///home/operator/repo/.devboard/goal-proposals/draft.txt",
      "file:///home/operator/repo/.devboard/goal-proposals/.md",
    ]) {
      expect(draftPathFromHref(href)).toBeNull();
    }
  });
});
