import { describe, expect, test } from "bun:test";
import { dependencyChart, dependencyEdges } from "./dependency-diagram";

describe("dependency edges", () => {
  test("reads directed records and sorts them by both endpoints", () => {
    expect(
      dependencyEdges([
        { from: "Orders", to: "Checkout" },
        { from: "Checkout", to: "Orders" },
      ]),
    ).toEqual([
      { from: "Checkout", to: "Orders" },
      { from: "Orders", to: "Checkout" },
    ]);
  });

  test("drops malformed, blank, self, and repeated edges", () => {
    expect(
      dependencyEdges([
        { from: " Checkout ", to: " Orders " },
        { from: "Checkout", to: "Orders" },
        { from: "Orders", to: "Orders" },
        { from: "", to: "Orders" },
        { from: "Orders" },
        "Checkout -> Orders",
        null,
      ]),
    ).toEqual([{ from: "Checkout", to: "Orders" }]);
  });

  test("reads nothing from a non-list value", () => {
    expect(dependencyEdges(null)).toEqual([]);
    expect(dependencyEdges({ from: "Checkout", to: "Orders" })).toEqual([]);
  });
});

describe("dependency chart", () => {
  test("draws every context and each directed edge", () => {
    expect(
      dependencyChart(
        ["Checkout", "Orders"],
        [
          { from: "Checkout", to: "Orders" },
          { from: "Orders", to: "Billing" },
        ],
      ),
    ).toBe(
      [
        "flowchart LR",
        '  n0("Checkout")',
        '  n1("Orders")',
        '  n2("Billing")',
        "  n0 --> n1",
        "  n1 --> n2",
      ].join("\n"),
    );
  });

  test("keeps a context label from injecting Mermaid syntax", () => {
    const hostile = 'Checkout"] --> Billing["x';
    expect(dependencyChart([hostile, "Safe"], [{ from: "Safe", to: hostile }])).toBe(
      [
        "flowchart LR",
        '  n0("Checkout#quot;] --> Billing[#quot;x")',
        '  n1("Safe")',
        "  n1 --> n0",
      ].join("\n"),
    );
  });

  test("keeps isolated contexts beside the recorded edges", () => {
    expect(
      dependencyChart(["Orders", "Shipping"], [{ from: "Checkout", to: "Orders" }]),
    ).toBe(
      [
        "flowchart LR",
        '  n0("Orders")',
        '  n1("Shipping")',
        '  n2("Checkout")',
        "  n2 --> n0",
      ].join("\n"),
    );
  });

  test("has nothing to draw without a recorded edge", () => {
    expect(dependencyChart(["Orders"], [])).toBeNull();
    expect(dependencyChart([], [])).toBeNull();
    expect(dependencyChart(["  "], [])).toBeNull();
  });
});
