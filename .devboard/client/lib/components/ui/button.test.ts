import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render, within } = await import("@testing-library/svelte");
const { default: Button } = await import("./button.svelte");

afterEach(() => {
  cleanup();
});

test("the primitive renders one button and keeps every resting attribute", () => {
  const view = render(Button, {
    props: {
      variant: "outline",
      size: "sm",
      "data-testid": "goal-start",
      "data-command": "goal.start",
      title: "Start the run",
      disabled: true,
      children: undefined,
    },
  });
  const button = view.container.querySelector("button");
  if (button === null) throw new Error("no button");
  expect(view.container.querySelectorAll("button").length).toBe(1);
  expect(button.getAttribute("type")).toBe("button");
  expect(button.getAttribute("data-slot")).toBe("button");
  expect(button.getAttribute("data-variant")).toBe("outline");
  expect(button.getAttribute("data-testid")).toBe("goal-start");
  expect(button.getAttribute("data-command")).toBe("goal.start");
  expect(button.getAttribute("title")).toBe("Start the run");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(button.className).toContain("h-6");
});

test("pointer and keyboard activation paint the pressed fill until release", async () => {
  const view = render(Button, { props: {} });
  const button = within(view.container).getByRole("button");

  await fireEvent.pointerDown(button);
  expect(button.getAttribute("data-pressed")).toBe("true");
  await fireEvent.pointerUp(button);
  expect(button.hasAttribute("data-pressed")).toBe(false);

  await fireEvent.pointerDown(button);
  await fireEvent.pointerLeave(button);
  expect(button.hasAttribute("data-pressed")).toBe(false);

  await fireEvent.keyDown(button, { key: " " });
  expect(button.getAttribute("data-pressed")).toBe("true");
  await fireEvent.keyUp(button, { key: " " });
  expect(button.hasAttribute("data-pressed")).toBe(false);

  await fireEvent.keyDown(button, { key: "Enter" });
  expect(button.getAttribute("data-pressed")).toBe("true");
  await fireEvent.blur(button);
  expect(button.hasAttribute("data-pressed")).toBe(false);
});

test("a busy control states its verb and dispatches one frame per activation", async () => {
  const socket = {
    frames: [] as string[],
    send(frame: string): void {
      this.frames.push(frame);
    },
  };
  const view = render(Button, {
    props: {
      label: "Start",
      busy: true,
      "data-testid": "issues-start",
      onclick: () => socket.send("startIssues"),
    },
  });
  const button = within(view.container).getByTestId("issues-start");
  expect(button.textContent?.trim()).toBe("Starting…");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-label")).toBe("Starting…");

  await fireEvent.click(button);
  await fireEvent.click(button);
  expect(socket.frames).toEqual([]);
  expect(button.hasAttribute("disabled")).toBe(false);
});

test("an idle control dispatches every activation", async () => {
  const socket = {
    frames: [] as string[],
    send(frame: string): void {
      this.frames.push(frame);
    },
  };
  const view = render(Button, {
    props: {
      label: "Save",
      "data-testid": "save",
      onclick: () => socket.send("setAgentSettings"),
    },
  });
  const button = within(view.container).getByTestId("save");
  expect(button.textContent?.trim()).toBe("Save");
  await fireEvent.click(button);
  await fireEvent.click(button);
  expect(socket.frames).toEqual(["setAgentSettings", "setAgentSettings"]);
});

test("a busy phrase can name an icon control without adding inline text", () => {
  const view = render(Button, {
    props: {
      bare: true,
      label: "Reload",
      busy: true,
      busyLabel: "Reloading…",
      class: "status-item status-item--button",
    },
  });
  const button = within(view.container).getByRole("button");
  expect(button.textContent?.trim()).toBe("Reloading…");
  expect(button.getAttribute("aria-label")).toBe("Reloading…");
  expect(button.getAttribute("data-variant")).toBe("bare");
  expect(button.className).toBe("status-item status-item--button");
});
