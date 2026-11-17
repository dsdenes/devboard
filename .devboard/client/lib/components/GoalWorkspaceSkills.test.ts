import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The component and the testing library mount into the window happy-dom
// registers above, so they load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: GoalWorkspace } = await import("./GoalWorkspace.svelte");
const { goal } = await import("../goal.svelte");
import type { SkillContradiction } from "../types";

/** One reported (skill pair, directive pair) contradiction. */
function contradiction(
  skills: [string, string],
  directives: [string, string],
): SkillContradiction {
  return { skills, directives };
}

/** The Goal document page, or the Skills page, with its own tab. */
function mount(kind: "goal-document" | "skills") {
  const tab = {
    id: kind,
    kind,
    resourceId: kind,
    title: kind === "skills" ? "Skills" : "Goal document",
  };
  return render(GoalWorkspace, {
    props: { tab, openTab: () => undefined, closeTab: () => undefined },
  });
}

/** A Discover row whose manifest entry has no `SKILL.md` on disk. */
const PLACEHOLDER = {
  name: "discover-glossary",
  description: "",
  family: "discover" as const,
  state: "missing" as const,
  content: "",
};

const INSTALLED = {
  name: "fixture-conventions",
  description: "Fixture.",
  family: "prepare" as const,
  state: "generated" as const,
};

afterEach(() => {
  cleanup();
  goal.skills = [];
  goal.contradictions = [];
  goal.skillsPrepActive = false;
  goal.goalReady = false;
});

test("a Discover placeholder leaves the document page on Prepare skills", () => {
  goal.goalReady = true;
  goal.skills = [PLACEHOLDER];
  const view = mount("goal-document");

  expect(goal.skillsPrepared).toBe(false);
  expect(goal.startLifecycleTitle).toBe("Prepare skills before starting the lifecycle.");
  expect(view.queryByTestId("show-skills")).toBeNull();
  expect(view.getByTestId("prepare-skills").textContent?.trim()).toBe("Prepare skills");
});

test("one installed skill replaces Prepare skills with its count", () => {
  goal.goalReady = true;
  goal.skills = [INSTALLED];
  const view = mount("goal-document");

  expect(goal.skillsPrepared).toBe(true);
  expect(goal.startLifecycleTitle).toBeUndefined();
  expect(view.getByTestId("show-skills").textContent?.trim()).toBe("Show skills (1)");
});

test("the Skills page counts installed rows and still lists the placeholder", () => {
  goal.skills = [PLACEHOLDER, INSTALLED];
  const view = mount("skills");

  expect(view.getByTestId("skills-count").textContent?.trim()).toBe("1");
  expect(view.getByTestId("skills-table").textContent).toContain("discover-glossary");
});

test("two contradictions sharing one skill pair render two rows", () => {
  goal.skills = [INSTALLED];
  goal.contradictions = [
    contradiction(["alpha", "beta"], ["use tabs", "use spaces"]),
    contradiction(["alpha", "beta"], ["commit often", "commit once"]),
  ];
  const view = mount("skills");

  const list = view.getByTestId("skills-contradictions");
  expect(list.querySelectorAll("li")).toHaveLength(2);
  expect(list.textContent).toContain("use tabs");
  expect(list.textContent).toContain("commit once");
});

test("contradictions with distinct skill pairs render in frame order", () => {
  goal.skills = [INSTALLED];
  goal.contradictions = [
    contradiction(["alpha", "beta"], ["use tabs", "use spaces"]),
    contradiction(["gamma", "delta"], ["log freely", "log never"]),
  ];
  const view = mount("skills");

  const rows = [...view.getByTestId("skills-contradictions").querySelectorAll("li")];
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("alpha");
  expect(rows[0]?.textContent).toContain("use tabs");
  expect(rows[1]?.textContent).toContain("gamma");
  expect(rows[1]?.textContent).toContain("log never");
});
