import { describe, expect, test } from "bun:test";
import { GOAL_PROPOSALS_DIRECTORY, draftPathFromHref } from "./goal-proposals";

describe("draft path from link", () => {
  test("maps a draft's dashboard URL to its repository-relative path", () => {
    expect(draftPathFromHref("http://127.0.0.1:8080/goal-proposals/draft.md")).toBe(
      `${GOAL_PROPOSALS_DIRECTORY}/draft.md`,
    );
    expect(
      draftPathFromHref("https://devboard.example/goal-proposals/two-words-2.md"),
    ).toBe(`${GOAL_PROPOSALS_DIRECTORY}/two-words-2.md`);
  });

  test("refuses a value that is not an absolute dashboard URL naming a draft", () => {
    for (const href of [
      ".devboard/goal-proposals/draft.md",
      "file:///home/operator/repo/.devboard/goal-proposals/draft.md",
      "https://example.com/.devboard/goal-proposals/draft.md",
      "https://example.com/goal-proposals/draft.txt",
      "https://example.com/goal-proposals/.md",
      "https://example.com/goal-proposals/a/b.md",
      "https://example.com/goal-proposals/..%2Fescape.md",
    ]) {
      expect(draftPathFromHref(href)).toBeNull();
    }
  });
});
