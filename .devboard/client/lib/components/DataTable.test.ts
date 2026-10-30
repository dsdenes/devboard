import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the components and
// the testing library load after registration.
const { cleanup, render, fireEvent } = await import("@testing-library/svelte");
const userEvent = (await import("@testing-library/user-event")).default;
const { default: DataTable } = await import("./DataTable.svelte");
const { createRawSnippet } = await import("svelte");

afterEach(() => cleanup());

const columns = [{ id: "name", header: "Name", accessorKey: "name" }];
const rows = [{ name: "Row one" }];

function renderTable(onRowActivate: (row: Record<string, unknown>) => void) {
  return render(DataTable, {
    props: {
      columns,
      rows,
      rowTestId: "data-row",
      onRowActivate,
      cell: createRawSnippet(() => ({
        render: () => `<button data-testid="inner">Inner</button>`,
      })),
    },
  });
}

test("Enter on an inner control leaves the row unactivated", () => {
  const activated: Array<Record<string, unknown>> = [];
  const view = renderTable((row) => activated.push(row));
  const button = view.getByTestId("inner");
  button.focus();
  expect(document.activeElement).toBe(button);

  fireEvent.keyDown(button, { key: "Enter" });

  expect(activated).toEqual([]);
});

test("Enter on the row itself activates it", async () => {
  const activated: Array<Record<string, unknown>> = [];
  const view = renderTable((row) => activated.push(row));
  view.getByTestId("data-row").focus();

  await userEvent.setup().keyboard("[Enter]");

  expect(activated).toEqual(rows);
});
