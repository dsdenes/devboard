import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { createRawSnippet } = await import("svelte");
const { default: CommandButton } = await import("./CommandButton.svelte");

afterEach(() => {
  cleanup();
});

test("a control with no content of its own shows its resting label", () => {
  const view = render(CommandButton, {
    props: {
      variant: "destructive",
      label: "Delete skill",
      evidence: () => 0,
      command: () => {},
      "data-command": "devboard.skills.delete.confirm",
    },
  });
  const button = view.container.querySelector("button");
  if (button === null) throw new Error("no button");
  expect(button.textContent?.trim()).toBe("Delete skill");
  expect(button.getAttribute("aria-busy")).toBeNull();
});

test("caller content replaces the resting label", () => {
  const children = createRawSnippet(() => ({ render: () => "<span>reload</span>" }));
  const view = render(CommandButton, {
    props: {
      bare: true,
      label: "Reload",
      evidence: () => 0,
      command: () => {},
      children,
      "data-testid": "reload-devboard",
    },
  });
  const button = view.container.querySelector("button");
  if (button === null) throw new Error("no button");
  expect(button.textContent?.trim()).toBe("reload");
  expect(button.querySelectorAll("span").length).toBe(1);
});
