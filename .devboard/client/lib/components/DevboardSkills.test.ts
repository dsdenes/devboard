import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { default: DevboardSkills } = await import("./DevboardSkills.svelte");
const { devboard } = await import("../devboard.svelte");

afterEach(() => {
  cleanup();
  devboard.skills = [];
  devboard.skillsLoaded = false;
});

test("renders one row per installed skill with a name cell and one checkbox", () => {
  devboard.skills = [
    { name: "benchmark-methodology", enabled: true, content: "" },
    { name: "wire-format-conformance", enabled: false, content: "" },
  ];
  devboard.skillsLoaded = true;

  const { container } = render(DevboardSkills);
  const tables = container.querySelectorAll('[data-testid="skills-table"]');
  expect(tables.length).toBe(1);

  const rows = [...container.querySelectorAll<HTMLTableRowElement>('[data-testid="skill-row"]')];
  expect(rows.map((row) => row.getAttribute("data-skill"))).toEqual([
    "benchmark-methodology",
    "wire-format-conformance",
  ]);

  for (const row of rows) {
    const cells = [...row.querySelectorAll("td")];
    expect(cells.length).toBe(2);
    expect(cells[0]?.textContent?.trim() ?? null).toBe(row.getAttribute("data-skill"));
    const controls = cells[1]?.querySelectorAll(
      'button, input, select, textarea, a, [role="button"]',
    );
    expect(controls?.length).toBe(1);
    const checkbox = cells[1]?.querySelector<HTMLInputElement>('[data-testid="skill-enabled"]');
    expect(checkbox?.type).toBe("checkbox");
    expect(checkbox?.checked).toBe(row.getAttribute("data-skill") === "benchmark-methodology");
  }

  const text = container.textContent ?? "";
  expect(text).not.toContain("devboard-managed");
  expect(text).not.toContain("delete");
});

test("the disclosure is the shared Button primitive and paints a press", async () => {
  devboard.skills = [{ name: "benchmark-methodology", enabled: true, content: "" }];
  devboard.skillsLoaded = true;

  const { container } = render(DevboardSkills);
  const disclosure = container.querySelector<HTMLButtonElement>(
    '[data-testid="skill-disclosure"]',
  );
  expect(disclosure?.getAttribute("data-slot")).toBe("button");
  expect(disclosure?.getAttribute("data-variant")).toBe("bare");
  expect(disclosure?.type).toBe("button");

  await fireEvent.pointerDown(disclosure!);
  expect(disclosure?.getAttribute("data-pressed")).toBe("true");
  await fireEvent.pointerUp(disclosure!);
  expect(disclosure?.hasAttribute("data-pressed")).toBe(false);
});

test("clicking a skill row reveals its SKILL.md body and clicking again hides it", async () => {
  devboard.skills = [
    {
      name: "benchmark-methodology",
      enabled: true,
      content: [
        "---",
        "name: benchmark-methodology",
        "description: Measure before claiming a speedup.",
        "---",
        "",
        "# Benchmark methodology",
        "",
        "- Measure first.",
        "",
      ].join("\n"),
    },
  ];
  devboard.skillsLoaded = true;

  const { container } = render(DevboardSkills);
  const row = container.querySelector<HTMLTableRowElement>('[data-testid="skill-row"]');
  const disclosure = container.querySelector<HTMLButtonElement>(
    '[data-testid="skill-disclosure"]',
  );
  expect(container.querySelector('[data-testid="skill-content"]')).toBeNull();
  expect(disclosure?.getAttribute("aria-expanded")).toBe("false");

  await fireEvent.click(disclosure!);
  const content = container.querySelector('[data-testid="skill-content"]');
  expect(content).not.toBeNull();
  expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
  expect(content?.textContent ?? "").toContain("Benchmark methodology");
  expect(content?.textContent ?? "").toContain("Measure first.");
  expect(content?.textContent ?? "").not.toContain("description:");

  await fireEvent.click(disclosure!);
  expect(container.querySelector('[data-testid="skill-content"]')).toBeNull();

  await fireEvent.click(row!);
  expect(container.querySelectorAll('[data-testid="skill-content"]').length).toBe(1);

  await fireEvent.click(
    container.querySelector('[data-testid="skill-enabled"]')!,
  );
  expect(container.querySelectorAll('[data-testid="skill-content"]').length).toBe(1);
});
