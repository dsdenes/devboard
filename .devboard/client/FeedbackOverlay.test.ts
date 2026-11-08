import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// These imports evaluate after the DOM globals exist, which the component and
// the testing library both need.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: FeedbackOverlay } = await import("./FeedbackOverlay.svelte");

const originalFetch = globalThis.fetch;
const originalElementFromPoint = document.elementFromPoint;

interface Posted {
  url: string;
  body: string;
}

/** Records every mutation the panel posts and answers it with a filed issue. */
function stubFetch(): Posted[] {
  const posted: Posted[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ links: { issue: { href: "http://forge.test/issues/1" } } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return posted;
}

/** Arms report mode and picks one element, which opens the composer. */
async function openComposer(): Promise<HTMLTextAreaElement> {
  const target = document.createElement("div");
  target.textContent = "the picked element";
  document.body.append(target);
  document.elementFromPoint = () => target;

  const view = render(FeedbackOverlay, { props: { phase: "idle", action: null } });
  view.component.startPicking();
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await tick();
    const composer = view.container.querySelector("textarea");
    if (composer !== null) return composer;
  }
  throw new Error("the report panel opened no composer");
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  document.elementFromPoint = originalElementFromPoint;
});

test("Enter in the composer files the report instead of asking", async () => {
  const posted = stubFetch();
  const composer = await openComposer();
  composer.value = "The status bar overlaps the toolbar.";
  await fireEvent.input(composer);

  await fireEvent.keyDown(composer, { key: "Enter" });
  await tick();

  expect(posted.length).toBe(1);
  expect(posted[0]?.url).toContain("/reports");
  const body = JSON.parse(posted[0]?.body ?? "{}");
  expect(body.action).toBe("REPORT");
  expect(body.report).toBe("The status bar overlaps the toolbar.");
});

test("Shift+Enter keeps the composer's newline and posts nothing", async () => {
  const posted = stubFetch();
  const composer = await openComposer();
  composer.value = "A first line";
  await fireEvent.input(composer);

  await fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
  await tick();

  expect(posted.length).toBe(0);
});
