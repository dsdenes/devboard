import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// The preload registers DOM globals before these modules evaluate; a static
// import would load them first and capture the wrong document.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: DraftsPage } = await import("./components/DraftsPage.svelte");
const { default: QueryHarness } = await import("./components/QueryHarness.svelte");
const { agents } = await import("./agents.svelte");
const { connection } = await import("./connection.svelte");
const { goalDrafts } = await import("./goal-drafts.svelte");
const { issues } = await import("./issues.svelte");
const { layout } = await import("./layout.svelte");
const { queryClient } = await import("./query-client");
const { queryKeyFor } = await import("./query-keys");

const DRAFT_A = ".devboard/goal-proposals/alpha.md";
const DRAFT_B = ".devboard/goal-proposals/beta.md";
const RUN = "run-42";
const PROMPT_AGENT = "dead-code";

const realWindow = (globalThis as unknown as Record<string, unknown>).window;

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
}

/** The filters one store call passes to `invalidateQueries`. */
async function invalidatedFilters(call: () => void): Promise<unknown[]> {
  const filters: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((value?: { queryKey?: unknown[] }) => {
    filters.push(value?.queryKey);
    return Promise.resolve();
  }) as typeof queryClient.invalidateQueries;
  try {
    call();
    return filters;
  } finally {
    queryClient.invalidateQueries = original;
  }
}

/** The path one draft read requests, exactly as the operation derives it. */
function draftRead(path: string): string {
  return queryKeyFor({ type: "getGoalDraft", path })?.[1] ?? path;
}

// The store projection every fetched frame reaches, as the app root's own
// listener delivers it.
connection.onMessage((message) => {
  const frame = message as Record<string, unknown>;
  goalDrafts.handleEvent(frame);
  issues.handleEvent(frame);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  connection.dispose();
  layout.reset();
  delete (connection as unknown as Record<string, unknown>).open;
  issues.selectedRun = null;
  issues.resetActiveOperations();
  issues.run = null;
  goalDrafts.clearDraft();
  agents.forgetPrompt(PROMPT_AGENT);
  setGlobal("window", realWindow);
});

test("opening a draft invalidates the key its document is cached under", async () => {
  expect(await invalidatedFilters(() => goalDrafts.openDraft(DRAFT_A))).toEqual([
    queryKeyFor({ type: "getGoalDraft", path: DRAFT_A }),
  ]);
});

test("reopening a run invalidates the key its history is cached under", async () => {
  Object.defineProperty(connection, "open", { get: () => true, configurable: true });
  issues.openRun("run-first");

  expect(await invalidatedFilters(() => issues.openRun(RUN))).toEqual([
    queryKeyFor({ type: "getIssuesRun", runId: RUN }),
  ]);
});

test("opening an agent prompt invalidates the key its document is cached under", async () => {
  expect(await invalidatedFilters(() => agents.readPrompt(PROMPT_AGENT))).toEqual([
    queryKeyFor({ type: "getAgentPrompt", id: PROMPT_AGENT }),
  ]);
});

test("a reopened draft is read again and its panel names the reopened document", async () => {
  const reads: string[] = [];
  setGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = String(input);
    reads.push(path);
    const draftPath = decodeURIComponent(
      path.slice(path.indexOf("/goal-drafts/") + "/goal-drafts/".length),
    );
    return new Response(
      JSON.stringify({
        frames: [
          {
            type: "issuesDraftDetail",
            draft: {
              path: draftPath,
              name: draftPath.slice(draftPath.lastIndexOf("/") + 1),
              text: "text",
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
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
  const page = render(DraftsPage);
  connection.connect();
  await settle();
  goalDrafts.openDraft(DRAFT_A);
  await settle();
  expect(reads.filter((path) => path === draftRead(DRAFT_A))).toHaveLength(1);
  expect(page.getByTestId("issues-draft-detail").getAttribute("data-path")).toBe(DRAFT_A);

  goalDrafts.openDraft(DRAFT_B);
  await settle();
  expect(page.getByTestId("issues-draft-detail").getAttribute("data-path")).toBe(DRAFT_B);

  // Back to A: its cached entry is invalidated under the key the operation
  // derives, so the stored document is read again and the panel returns
  // instead of the fresh cache entry serving a copy the store already cleared.
  goalDrafts.openDraft(DRAFT_A);
  await settle();
  expect(reads.filter((path) => path === draftRead(DRAFT_A))).toHaveLength(2);
  expect(page.getByTestId("issues-draft-detail").getAttribute("data-path")).toBe(DRAFT_A);
});
