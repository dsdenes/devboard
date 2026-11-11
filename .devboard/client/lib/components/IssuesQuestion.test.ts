import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RunQuestion } from "../types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: IssuesQuestion } = await import("./IssuesQuestion.svelte");
const { issues } = await import("../issues.svelte");
const { connection } = await import("../connection.svelte");

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;

/** Stands in for the browser socket, so a dispatch is sent or refused. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = SOCKET_CLOSED;
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
    this.readyState = SOCKET_CLOSED;
  }
}

let socket: FakeSocket;

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  (globalThis as unknown as Record<string, unknown>).WebSocket = FakeSocket;
  connection.connect();
  const created = FakeSocket.instances[0];
  if (created === undefined) throw new Error("no socket created");
  socket = created;
  socket.readyState = SOCKET_OPEN;
});

afterAll(() => {
  connection.dispose();
  delete (globalThis as unknown as Record<string, unknown>).WebSocket;
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

afterEach(() => {
  socket.readyState = SOCKET_OPEN;
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
    return true;
  };
  return answers;
}

function restoreAnswers(original: typeof issues.submitAgentAnswer): void {
  issues.submitAgentAnswer = original;
}

async function mount(
  runId: string,
  question: RunQuestion,
  answerRevision?: () => number,
) {
  const view = render(IssuesQuestion, {
    props: { runId, question, answerRevision, testid: "issues-question" },
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

test("a closed transport keeps the typed answer and never arms the busy word", async () => {
  socket.readyState = SOCKET_CLOSED;
  const { view, input, submit } = await mount("run-a", QUESTION_A);

  await type(input, "keep this answer");
  await submitForm(input);

  expect(input.value).toBe("keep this answer");
  expect(submit.getAttribute("aria-busy")).toBeNull();
  expect(view.container.textContent).not.toContain("Answer received no answer.");
});

test("a server refusal frame releases the Answer control and keeps the typed answer", async () => {
  const { view, input, submit } = await mount("run-a", QUESTION_A, () =>
    issues.answerRevision("run-a"),
  );

  await type(input, "answer still unsent");
  await submitForm(input);
  expect(submit.getAttribute("aria-busy")).toBe("true");

  issues.handleEvent({
    type: "error",
    message: "That question is no longer waiting for an answer.",
  });
  await tick();

  expect(submit.getAttribute("aria-busy")).toBeNull();
  expect(input.value).toBe("answer still unsent");
  expect(view.container.textContent).not.toContain("Answer received no answer.");
});
