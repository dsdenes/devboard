import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

const { cleanup, render, within } = await import("@testing-library/svelte");
const { default: AgentDeploysTable } = await import("./AgentDeploysTable.svelte");

afterEach(() => {
  cleanup();
});

function label(value: string): string {
  const date = new Date(value);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

test("an empty history renders one empty state", () => {
  const view = render(AgentDeploysTable, { props: { deploys: [] } });
  const page = within(view.container);
  expect(page.getByTestId("agent-deploys")).toBeTruthy();
  expect(page.getByTestId("agent-deploys-empty")).toBeTruthy();
  expect(page.queryAllByTestId("agent-deploy")).toHaveLength(0);
});

test("each run renders its completion date, state, and commit count", () => {
  const endedAt = "2026-11-04T10:05:00.000Z";
  const view = render(AgentDeploysTable, {
    props: {
      deploys: [
        {
          id: "run-2",
          commit: "bbbbbbb",
          startedAt: "2026-11-04T10:00:00.000Z",
          endedAt,
          state: "failed",
          commits: 3,
        },
        {
          id: "run-1",
          commit: "aaaaaaa",
          startedAt: "2026-11-03T09:00:00.000Z",
          endedAt: "2026-11-03T09:05:00.000Z",
          state: "succeeded",
          commits: 0,
        },
      ],
    },
  });
  const rows = within(view.container).getAllByTestId("agent-deploy");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.getAttribute("data-state")).toBe("failed");
  expect(rows[1]?.getAttribute("data-state")).toBe("succeeded");
  const at = within(rows[0] as HTMLElement).getByTestId("agent-deploy-at");
  expect(at.getAttribute("datetime")).toBe(endedAt);
  expect(at.textContent?.trim()).toBe(label(endedAt));
  expect(within(rows[0] as HTMLElement).getByTestId("agent-deploy-commits").textContent?.trim()).toBe(
    "3",
  );
  expect(within(rows[1] as HTMLElement).getByTestId("agent-deploy-commits").textContent?.trim()).toBe(
    "0",
  );
});

test("a running run shows its start, and an unknown count is a dash", () => {
  const startedAt = "2026-11-05T11:00:00.000Z";
  const view = render(AgentDeploysTable, {
    props: {
      deploys: [
        {
          id: "run-3",
          commit: "ccccccc",
          startedAt,
          endedAt: null,
          state: "running",
          commits: null,
        },
        {
          id: "run-4",
          commit: "ddddddd",
          startedAt: null,
          endedAt: null,
          state: "stopped",
          commits: null,
        },
      ],
    },
  });
  const rows = within(view.container).getAllByTestId("agent-deploy");
  const at = within(rows[0] as HTMLElement).getByTestId("agent-deploy-at");
  expect(at.getAttribute("datetime")).toBe(startedAt);
  expect(within(rows[0] as HTMLElement).getByTestId("agent-deploy-commits").textContent?.trim()).toBe(
    "—",
  );
  expect(within(rows[1] as HTMLElement).queryByTestId("agent-deploy-at")).toBeNull();
  expect(within(rows[1] as HTMLElement).getByTestId("agent-deploy-date").textContent?.trim()).toBe(
    "—",
  );
});
