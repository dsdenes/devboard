import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RunQuestion } from "../types";

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
const { default: IssuesQuestion } = await import("./IssuesQuestion.svelte");
const { issues } = await import("../issues.svelte");

afterEach(() => {
  cleanup();
});

const QUESTION_A: RunQuestion = {
  id: 7,
  message: "Which file should change first?",
  options: [],
};

const QUESTION_B: RunQuestion = {
  id: 8,
  message: "Which suite proves the change?",
  options: [],
};

interface Answer {
  runId: string;
  questionId: number | string;
  value: string;
}

/** Answers reach the live agent through the store, so that call is the frame. */
function captureAnswers(): Answer[] {
  const answers: Answer[] = [];
  issues.submitAgentAnswer = (runId, questionId, value) => {
    answers.push({ runId, questionId, value });
  };
  return answers;
}

function restoreAnswers(original: typeof issues.submitAgentAnswer): void {
  issues.submitAgentAnswer = original;
}

async function mount(runId: string, question: RunQuestion) {
  const view = render(IssuesQuestion, {
    props: { runId, question, testid: "issues-question" },
  });
  const input = view.getByTestId("issues-agent-answer-input") as HTMLInputElement;
  const submit = view.getByTestId("issues-agent-answer-submit") as HTMLButtonElement;
  return { view, input, submit };
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await fireEvent.input(input, { target: { value } });
  await tick();
}

async function submitForm(input: HTMLInputElement): Promise<void> {
  const form = input.closest("form");
  if (form === null) throw new Error("the answer field is not inside its form");
  // The test preload restores the native globals after happy-dom registers, so
  // a constructed `Event` is not the document's class; `createEvent` is.
  const event = form.ownerDocument.createEvent("Event");
  event.initEvent("submit", true, true);
  form.dispatchEvent(event);
  await tick();
}

test("a switch to another agent's question clears the draft and answers the new subject", async () => {
  const original = issues.submitAgentAnswer;
  const answers = captureAnswers();
  try {
    const { view, input, submit } = await mount("run-a", QUESTION_A);

    await type(input, "answer for A");
    expect(input.value).toBe("answer for A");
    expect(submit.disabled).toBe(false);

    // The Overview pane keeps one instance as the selected agent changes.
    await view.rerender({ runId: "run-b", question: QUESTION_B });
    await tick();

    expect(input.value).toBe("");
    expect(submit.disabled).toBe(true);

    await type(input, "  answer for B  ");
    await submitForm(input);

    expect(answers).toEqual([{ runId: "run-b", questionId: 8, value: "answer for B" }]);
  } finally {
    restoreAnswers(original);
  }
});

test("a new question under the same run starts empty and never restores the old draft", async () => {
  const { view, input } = await mount("run-a", QUESTION_A);

  await type(input, "answer for A");
  await view.rerender({ runId: "run-a", question: QUESTION_B });
  await tick();
  expect(input.value).toBe("");

  await view.rerender({ runId: "run-a", question: QUESTION_A });
  await tick();
  expect(input.value).toBe("");
});
