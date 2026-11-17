import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { cleanup, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: DraftsPage } = await import("./components/DraftsPage.svelte");
const { default: QueryHarness } = await import("./components/QueryHarness.svelte");
const { connection } = await import("./connection.svelte");
const { goalDrafts } = await import("./goal-drafts.svelte");
const { layout } = await import("./layout.svelte");
const { queryClient } = await import("./query-client");
const { queryKeyFor } = await import("./query-keys");

const DRAFT = ".devboard/goal-proposals/alpha.md";

const realWindow = (globalThis as unknown as Record<string, unknown>).window;

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

/** The path one draft read requests, exactly as the operation derives it. */
function draftRead(path: string): string {
  return queryKeyFor({ type: "getGoalDraft", path })?.[1] ?? path;
}

/** The drafts surface on screen; its first `failures` draft reads reject. */
async function openPage(failures: number) {
  const reads: string[] = [];
  const failing = draftRead(DRAFT);
  let remainingFailures = failures;
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    reads.push(path);
    if (path === failing && remainingFailures > 0) {
      remainingFailures -= 1;
      throw new TypeError("Failed to fetch");
    }
    const frames =
      path === failing
        ? [
            {
              type: "issuesDraftDetail",
              draft: { path: DRAFT, name: "alpha.md", heading: "Alpha", text: "## Goal" },
            },
          ]
        : [];
    return new Response(JSON.stringify({ frames }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  setGlobal("window", {
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  setGlobal("location", { protocol: "http:", host: "test.invalid", reload: () => undefined });

  // The drafts surface is the one that shows a selected draft's document: the
  // plan claims that read only while this tab is on screen.
  layout.reset();
  layout.setMode("issues");
  layout.openTab("issues", {
    id: "drafts",
    kind: "drafts",
    resourceId: "drafts",
    title: "Draft goals",
  });
  render(QueryHarness);
  const view = render(DraftsPage);
  connection.connect();
  await settle();
  goalDrafts.drafts = [{ path: DRAFT, name: "alpha.md", heading: "Alpha" }];
  goalDrafts.openDraft(DRAFT);
  await settle();
  await tick();
  return { reads, view };
}

function draftReads(reads: readonly string[]): number {
  return reads.filter((path) => path === draftRead(DRAFT)).length;
}

// The store projection every fetched frame reaches, as the app root's own
// listener delivers it.
connection.onMessage((message) => goalDrafts.handleEvent(message as Record<string, unknown>));

afterEach(() => {
  cleanup();
  queryClient.clear();
  connection.dispose();
  layout.reset();
  goalDrafts.drafts = [];
  goalDrafts.draftRuns = {};
  goalDrafts.draftErrors = {};
  goalDrafts.clearDraft();
  setGlobal("window", realWindow);
});

test("a draft read that never answers reports its message and stops latching", async () => {
  const { reads, view } = await openPage(1);

  // The GET rejects in the transport, so no frame ever arrives; the read is
  // answered by its failure instead of leaving the selection waiting forever.
  expect(draftReads(reads)).toBe(1);
  expect(goalDrafts.draft).toBeNull();
  expect(view.getByTestId("issues-draft-error").textContent?.trim()).toBe(
    "Could not reach the server.",
  );
  expect(view.queryByTestId("issues-draft-detail")).toBeNull();

  // The failed read answered the restore's question, so the next restore asks
  // again instead of returning on the path it already read. That read answers,
  // and the panel shows the document with the failure cleared.
  goalDrafts.restoreDraft();
  await settle();
  await tick();
  expect(draftReads(reads)).toBe(2);
  expect(view.getByTestId("issues-draft-detail").getAttribute("data-path")).toBe(DRAFT);
  expect(view.queryByTestId("issues-draft-error")).toBeNull();
});
