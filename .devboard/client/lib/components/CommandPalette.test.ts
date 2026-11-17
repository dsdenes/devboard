import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/svelte");
const { default: CommandPalette } = await import("./CommandPalette.svelte");

type Command = {
  id: string;
  title: string;
  group: string;
  run: () => void;
  disabled?: () => string | null;
};

const commands = (count: number): Command[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `test-command-${index}`,
    title: `Test command ${index}`,
    group: "Test",
    run: () => {},
  }));

/**
 * The dialog moves focus on the next animation frame, and the test runtime's
 * native-runtime restore leaves no frame callback behind.
 */
function installFrameShim(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.requestAnimationFrame ??= (callback: (time: number) => void) => {
    queueMicrotask(() => callback(0));
    return 0;
  };
  globals.cancelAnimationFrame ??= () => undefined;
}

const openPalette = async (list: Command[]): Promise<HTMLInputElement> => {
  installFrameShim();
  render(CommandPalette, { open: true, commands: list, onclose: () => {} });
  return waitFor(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="command-palette-input"]',
    );
    if (input === null) throw new Error("no palette input");
    return input;
  });
};

let scrolls: Array<{ id: string; block: unknown }> = [];
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  scrolls = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options?: ScrollIntoViewOptions) {
      scrolls.push({ id: this.id, block: options?.block });
    },
  });
});

afterEach(() => {
  cleanup();
  if (original === undefined) delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
});

test("End selects the last command and scrolls it into view", async () => {
  const input = await openPalette(commands(40));

  await fireEvent.keyDown(input, { key: "End" });

  const selected = document.querySelector('[aria-selected="true"]');
  expect(selected?.id).toBe("palette-item-39");
  await waitFor(() => expect(scrolls).toEqual([{ id: "palette-item-39", block: "nearest" }]));
});

test("Home returns to the first command and scrolls it into view", async () => {
  const input = await openPalette(commands(40));

  await fireEvent.keyDown(input, { key: "End" });
  await fireEvent.keyDown(input, { key: "Home" });

  const selected = document.querySelector('[aria-selected="true"]');
  expect(selected?.id).toBe("palette-item-0");
  await waitFor(() =>
    expect(scrolls).toEqual([
      { id: "palette-item-39", block: "nearest" },
      { id: "palette-item-0", block: "nearest" },
    ]),
  );
});

test("End skips a disabled trailing command and scrolls the enabled row", async () => {
  const list = commands(6).map((command, index) =>
    index === 5 ? { ...command, disabled: () => "Not now" } : command,
  );
  const input = await openPalette(list);

  await fireEvent.keyDown(input, { key: "End" });

  const selected = document.querySelector('[aria-selected="true"]');
  expect(selected?.id).toBe("palette-item-4");
  await waitFor(() => expect(scrolls).toEqual([{ id: "palette-item-4", block: "nearest" }]));
});

test("an arrow key still scrolls the row it moves to", async () => {
  const input = await openPalette(commands(40));

  await fireEvent.keyDown(input, { key: "ArrowDown" });

  await waitFor(() => expect(scrolls).toEqual([{ id: "palette-item-1", block: "nearest" }]));
});
