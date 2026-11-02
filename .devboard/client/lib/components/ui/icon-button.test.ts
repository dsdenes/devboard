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
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { createRawSnippet } = await import("svelte");
const { default: IconButton } = await import("./icon-button.svelte");

afterEach(() => {
  cleanup();
});

const icon = createRawSnippet(() => ({ render: () => "<svg aria-hidden=\"true\"></svg>" }));

test("an idle icon control keeps its label and square", () => {
  const view = render(IconButton, { props: { label: "Reload", children: icon } });
  const button = view.container.querySelector("button");
  if (button === null) throw new Error("no button");
  expect(button.getAttribute("aria-label")).toBe("Reload");
  expect(button.getAttribute("title")).toBe("Reload");
  expect(button.hasAttribute("aria-busy")).toBe(false);
  expect(button.className).toContain("size-7");
  expect(button.textContent).toBe("");
});

test("a busy icon control names the phrase and sends no second frame", async () => {
  let frames = 0;
  const view = render(IconButton, {
    props: {
      label: "File issue",
      busy: true,
      busyLabel: "Filing issue…",
      children: icon,
      onclick: () => {
        frames += 1;
      },
    },
  });
  const button = view.container.querySelector("button");
  if (button === null) throw new Error("no button");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.getAttribute("aria-label")).toBe("Filing issue…");
  expect(button.getAttribute("title")).toBe("Filing issue…");
  expect(button.className).toContain("size-7");
  expect(button.textContent).toBe("");
  await fireEvent.click(button);
  expect(frames).toBe(0);
});
