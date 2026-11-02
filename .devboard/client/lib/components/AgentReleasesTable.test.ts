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
const { default: AgentReleasesTable } = await import("./AgentReleasesTable.svelte");

afterEach(() => cleanup());

function cell(row: Element, testId: string): Element | null {
  return row.querySelector(`[data-testid="${testId}"]`);
}

test("lists each release's date, version, and commit count as given", () => {
  const view = render(AgentReleasesTable, {
    props: {
      releases: [
        {
          at: "2026-11-02T10:00:00.000Z",
          version: "1.1.0",
          commits: 4,
          url: "https://forge.test/releases/tag/v1.1.0",
        },
        { at: "2026-11-01T09:00:00.000Z", version: "1.0.0", commits: null, url: null },
      ],
    },
  });
  const rows = view.getAllByTestId("agent-release");
  expect(rows).toHaveLength(2);

  const newest = rows[0]!;
  expect(newest.getAttribute("data-version")).toBe("1.1.0");
  expect(cell(newest, "agent-release-at")?.getAttribute("datetime")).toBe(
    "2026-11-02T10:00:00.000Z",
  );
  expect(cell(newest, "agent-release-commits")?.textContent).toBe("4");
  expect(cell(newest, "agent-release-version")?.getAttribute("href")).toBe(
    "https://forge.test/releases/tag/v1.1.0",
  );

  // An unknown count and an absent release page stay explicit rather than
  // reading as zero or a broken link.
  const oldest = rows[1]!;
  expect(cell(oldest, "agent-release-commits")?.textContent).toBe("—");
  expect(cell(oldest, "agent-release-version")?.tagName).toBe("SPAN");
  expect(cell(oldest, "agent-release-version")?.textContent?.trim()).toBe("1.0.0");
});

test("an agent with no release yet says so", () => {
  const view = render(AgentReleasesTable, { props: { releases: [] } });
  expect(view.getByTestId("agent-releases-empty")).toBeTruthy();
  expect(view.queryAllByTestId("agent-release")).toHaveLength(0);
});
