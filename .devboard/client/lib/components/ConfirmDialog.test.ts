import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The dialog renders a bits-ui portal into the document body, so the component
// and the testing library load after the DOM runtime is registered.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { default: ConfirmDialog } = await import("./ConfirmDialog.svelte");
const { connection } = await import("../connection.svelte");

const globals = globalThis as unknown as Record<string, unknown>;

/** The dialog moves focus on the next animation frame, which this runtime lacks. */
function installFrameShim(): void {
  globals.requestAnimationFrame ??= (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
  globals.cancelAnimationFrame ??= () => undefined;
}

interface Props {
  evidence: () => unknown;
  refusal?: () => unknown;
  onconfirm: () => void;
}

/** Mounts the open dialog; `onconfirm` records the dispatch and stays open. */
function dialog(args: Props) {
  return render(ConfirmDialog, {
    props: {
      open: true,
      title: "Delete skill",
      message: "Delete the fixture skill?",
      confirmLabel: "Delete skill",
      testid: "delete-skill-confirmation",
      confirmCommand: "goal.skills.delete.confirm",
      cancelCommand: "goal.skills.delete.cancel",
      evidence: args.evidence,
      refusal: args.refusal,
      onconfirm: args.onconfirm,
      oncancel: () => undefined,
    },
  });
}

beforeEach(() => installFrameShim());
afterEach(() => cleanup());

function confirmControl(view: ReturnType<typeof dialog>): HTMLButtonElement {
  const button = view
    .getByTestId("delete-skill-confirmation")
    .querySelector<HTMLButtonElement>('button[data-command="goal.skills.delete.confirm"]');
  if (button === null) throw new Error("no confirm control");
  return button;
}

test("a refusal revision passed to the dialog settles its confirm control", async () => {
  const calls: number[] = [];
  const view = dialog({
    evidence: () => 0,
    refusal: () => connection.refusalRevision("deleteSkill"),
    onconfirm: () => calls.push(1),
  });
  const confirm = confirmControl(view);
  await fireEvent.click(confirm);
  expect(calls).toHaveLength(1);
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect(confirm.textContent?.trim()).toBe("Deleting…");

  connection.receiveFrame({
    type: "error",
    message: "Flow Mode is active. Finish or stop its work first.",
    command: "deleteSkill",
  });
  await Promise.resolve();
  expect(confirm.getAttribute("aria-busy")).toBeNull();
  expect(confirm.textContent?.trim()).toBe("Delete skill");

  jest.useFakeTimers();
  try {
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.queryByTestId("command-notice")).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test("a refusal of another command leaves the confirm control at its ceiling", async () => {
  const calls: number[] = [];
  const view = dialog({
    evidence: () => 0,
    refusal: () => connection.refusalRevision("deleteSkill"),
    onconfirm: () => calls.push(1),
  });
  const confirm = confirmControl(view);
  jest.useFakeTimers();
  try {
    await fireEvent.click(confirm);
    expect(confirm.getAttribute("aria-busy")).toBe("true");

    connection.receiveFrame({
      type: "error",
      message: "A goal revision is already active.",
      command: "reviseGoal",
    });
    await Promise.resolve();
    expect(confirm.getAttribute("aria-busy")).toBe("true");

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(view.getByTestId("command-notice").textContent).toContain(
      "Delete skill received no answer.",
    );
  } finally {
    jest.useRealTimers();
  }
});
