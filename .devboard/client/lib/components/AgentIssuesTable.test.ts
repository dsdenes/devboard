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
const { cleanup, render } = await import("@testing-library/svelte");
const { default: AgentIssuesTable } = await import("./AgentIssuesTable.svelte");

afterEach(() => cleanup());

const readAt = "2026-11-03T10:15:00.000Z";

test("an unread tracker says it was never read instead of claiming zero issues", () => {
  const view = render(AgentIssuesTable, {
    props: {
      issues: [],
      agentLabel: "Auto Scout",
      sync: { state: "stale" as const, at: null, error: null },
    },
  });
  const empty = view.getByTestId("agent-issues-empty");
  expect(empty.getAttribute("data-sync")).toBe("stale");
  expect(empty.textContent).not.toContain("No issues filed yet");
  expect(view.getByTestId("agent-issues-unread").textContent?.trim()).toBe(
    "The tracker has not been read yet",
  );
  expect(view.getByTestId("agent-issues-unread-copy").textContent).toContain(
    "Last read never.",
  );
});

test("a failed read names its reason and the last successful read", () => {
  const view = render(AgentIssuesTable, {
    props: {
      issues: [],
      agentLabel: "Auto Scout",
      sync: { state: "error" as const, at: readAt, error: "gh: not found" },
    },
  });
  expect(view.getByTestId("agent-issues-empty").textContent).not.toContain(
    "No issues filed yet",
  );
  expect(view.getByTestId("agent-issues-unread").textContent?.trim()).toBe(
    "The tracker could not be read",
  );
  const copy = view.getByTestId("agent-issues-unread-copy").textContent ?? "";
  expect(copy).toContain("Last read");
  expect(copy).toContain("gh: not found");
});

test("a successful read keeps the confirmed-empty composition", () => {
  const view = render(AgentIssuesTable, {
    props: {
      issues: [],
      agentLabel: "Auto Scout",
      sync: { state: "ok" as const, at: readAt, error: null },
    },
  });
  const empty = view.getByTestId("agent-issues-empty");
  expect(empty.getAttribute("data-sync")).toBe("ok");
  expect(empty.textContent).toContain("No issues filed yet");
  expect(empty.textContent).toContain("files significant findings here after each scan");
  expect(view.queryByTestId("agent-issues-unread")).toBeNull();
});

test("an aged read with surviving rows keeps the table", () => {
  const view = render(AgentIssuesTable, {
    props: {
      issues: [
        {
          title: "A finding",
          category: "correctness",
          filedAt: readAt,
          url: "https://forge.test/issues/1",
          state: "pending",
          version: null,
        },
      ],
      agentLabel: "Auto Scout",
      sync: { state: "stale" as const, at: readAt, error: null },
    },
  });
  expect(view.getAllByTestId("agent-issue")).toHaveLength(1);
  expect(view.queryByTestId("agent-issues-empty")).toBeNull();
  expect(view.queryByTestId("agent-issues-unread")).toBeNull();
});
