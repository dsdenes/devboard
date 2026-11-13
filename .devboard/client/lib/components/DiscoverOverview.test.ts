import { afterEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DiscoverStatePayload } from "../types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, fireEvent, render } = await import("@testing-library/svelte");
const { tick } = await import("svelte");
const { default: DiscoverOverview } = await import("./DiscoverOverview.svelte");
const { discover } = await import("../discover.svelte");
const { connection } = await import("../connection.svelte");

afterEach(() => {
  cleanup();
  discover.state = null;
  discover.active = false;
  discover.starting = false;
  discover.runningAll = false;
  discover.remoteUrl = "";
  discover.error = null;
  discover.errorAgent = null;
});

function leaf(value: unknown): Record<string, unknown> {
  return { value, evidence: ["."], confidence: "observed" };
}

function sheet(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    definition: leaf("A fixture host that places orders."),
    stack: leaf(["TypeScript", "Bun"]),
    commands: {
      test: leaf("bun test"),
      build: leaf("bun run build"),
    },
    testing: {
      levels: leaf([
        { level: "unit", tests: "1", happyPath: "1", paths: ["test"], command: "bun test", fixtures: [] },
      ]),
    },
    architecture: {
      contexts: leaf([
        {
          name: "Checkout",
          path: "src/checkout",
          responsibility: "Places the order.",
          entryPoints: ["src/checkout/flow.ts"],
        },
        { name: "Orders", path: "src", responsibility: "Owns records.", entryPoints: ["src"] },
      ]),
      dependencyDirection: leaf("Checkout depends on Orders."),
      externalBoundaries: leaf(["PostgreSQL"]),
      sharedKernels: leaf(["src/shared"]),
    },
    runtime: {
      languages: leaf(["TypeScript"]),
      manifests: leaf(["package.json"]),
    },
  };
}

function state(overviewLinks: Record<string, string>): DiscoverStatePayload {
  return {
    active: false,
    runId: null,
    startedAt: null,
    activeAgent: null,
    runningAll: false,
    agents: [],
    interrupted: false,
    stale: false,
    warnings: [],
    busy: null,
    error: null,
    remoteAvailable: false,
    retained: [],
    repository: null,
    target: { kind: "host" },
    cloning: null,
    manifest: null,
    freshness: null,
    sheet: sheet(),
    dependencyRepositories: { TypeScript: "https://github.com/microsoft/TypeScript" },
    overviewLinks,
    contribution: null,
    glossaries: [],
    glossaryUsage: {},
    glossarySignificance: {},
    decisions: [],
    skills: [],
  };
}

const FILE = "vscode://file//host/src/checkout/flow.ts";
const DIRECTORY = "vscode://file//host/src";
const MANIFEST = "vscode://file//host/package.json";

function anchor(container: HTMLElement, text: string): HTMLAnchorElement | null {
  return (
    [...container.querySelectorAll("a")].find(
      (candidate) => candidate.textContent?.trim() === text,
    ) ?? null
  );
}

function chip(container: HTMLElement, text: string): Element | null {
  return (
    [...container.querySelectorAll(".code-chip")].find(
      (candidate) => candidate.textContent?.trim() === text,
    ) ?? null
  );
}

test("an existing file, directory, and manifest render as VS Code anchors", () => {
  discover.state = state({
    "src/checkout/flow.ts": FILE,
    src: DIRECTORY,
    "package.json": MANIFEST,
  });
  const view = render(DiscoverOverview);

  expect(anchor(view.container, "src/checkout/flow.ts")?.getAttribute("href")).toBe(FILE);
  expect(anchor(view.container, "src")?.getAttribute("href")).toBe(DIRECTORY);
  expect(anchor(view.container, "package.json")?.getAttribute("href")).toBe(MANIFEST);
  expect(view.container.querySelectorAll('a[href^="vscode://"]')).toHaveLength(3);
});

test("a missing path, a command, and a boundary stay plain", () => {
  discover.state = state({
    "src/checkout/flow.ts": FILE,
    src: DIRECTORY,
    "package.json": MANIFEST,
  });
  const view = render(DiscoverOverview);

  const kernel = chip(view.container, "src/shared");
  expect(kernel?.tagName).toBe("CODE");
  expect(kernel?.hasAttribute("href")).toBe(false);
  expect(anchor(view.container, "PostgreSQL")).toBeNull();
  expect(anchor(view.container, "bun test")).toBeNull();
  expect(anchor(view.container, "Checkout depends on Orders.")).toBeNull();
});

test("a stack chip keeps its repository link and target", () => {
  discover.state = state({});
  const view = render(DiscoverOverview);
  const stack = anchor(view.container, "TypeScript");

  expect(stack?.getAttribute("href")).toBe("https://github.com/microsoft/TypeScript");
  expect(stack?.getAttribute("target")).toBe("_blank");
});

function stackValue(value: unknown): void {
  (discover.state!.sheet as Record<string, unknown>).stack = leaf(value);
}

function stackSubtitle(container: HTMLElement): string {
  const subtitle = container.querySelector('[data-field="stack"] .panel__subtitle');
  return subtitle?.textContent?.trim().replace(/\s+/g, " ") ?? "";
}

test("an observed empty stack renders no Stack card and no sentinel chip", () => {
  discover.state = state({});
  stackValue([]);
  const view = render(DiscoverOverview);

  expect(card(view.container, "stack")).toBeNull();
  expect(chip(view.container, "None detected.")).toBeNull();
  expect(view.container.textContent).not.toContain("1 entries");
});

test("a stack whose only entry is the sentinel renders no Stack card", () => {
  discover.state = state({});
  stackValue(["None detected."]);
  const view = render(DiscoverOverview);

  expect(card(view.container, "stack")).toBeNull();
  expect(chip(view.container, "None detected.")).toBeNull();
});

test("a one-entry stack counts one entry and renders one chip", () => {
  discover.state = state({});
  stackValue(["Redis 7"]);
  const view = render(DiscoverOverview);
  const stack = card(view.container, "stack");

  expect(stackSubtitle(view.container)).toBe("1 entry");
  expect(stack?.querySelectorAll(".code-chip")).toHaveLength(1);
  expect(chip(view.container, "Redis")).not.toBeNull();
});

test("a three-entry stack counts three entries and one chip each", () => {
  discover.state = state({});
  stackValue(["TypeScript", "Bun", "Vite"]);
  const view = render(DiscoverOverview);
  const stack = card(view.container, "stack");

  expect(stackSubtitle(view.container)).toBe("3 entries");
  expect(stack?.querySelectorAll(".code-chip")).toHaveLength(3);
});

test("an absolute or escaping value stays plain text", () => {
  discover.state = state({});
  const payload = discover.state as DiscoverStatePayload;
  const architecture = payload.sheet?.architecture as {
    contexts: { value: Array<Record<string, unknown>> };
  };
  const escapees = ["/etc/passwd", "../outside.ts", "src/../../escape.ts"];
  architecture.contexts.value[0]!.entryPoints = escapees;
  const view = render(DiscoverOverview);

  for (const text of escapees) {
    expect(chip(view.container, text)?.tagName).toBe("CODE");
  }
  expect(view.container.querySelectorAll('a[href^="vscode://"]')).toHaveLength(0);
});

test("a remote target renders no path link and keeps its text", () => {
  discover.state = state({});
  const view = render(DiscoverOverview);

  expect(view.container.querySelectorAll('a[href^="vscode://"]')).toHaveLength(0);
  expect(chip(view.container, "src/checkout/flow.ts")?.tagName).toBe("CODE");
  expect(chip(view.container, "package.json")).toBeNull();
  expect(view.container.textContent).toContain("package.json");
});

test("an in-flight clone keeps the selected row and its option", () => {
  const retained = "https://github.com/acme/retained";
  const fresh = "https://github.com/acme/fresh";
  discover.state = {
    ...state({}),
    remoteAvailable: true,
    retained: [
      { url: retained, owner: "acme", repo: "retained", completedAt: "2026-05-01T00:00:00.000Z" },
    ],
    target: { kind: "remote", url: retained, owner: "acme", repo: "retained", checkout: false },
    cloning: { url: fresh },
    repository: "acme/fresh",
  };
  const view = render(DiscoverOverview);

  const rows = view.container.querySelectorAll(".discover-remote__item--active");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.textContent).toContain(retained);
  const select = view.container.querySelector<HTMLSelectElement>(
    '[data-testid="discover-remote-select"]',
  );
  expect(select?.value).toBe(retained);
  expect(select?.selectedIndex).toBe(0);
  expect(view.container.querySelector('[data-testid="discover-remote-clear"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="discover-remote-cloning"]')?.textContent).toContain(
    fresh,
  );
  // The header keeps naming the project being discovered.
  const title = view.container.querySelector("h1");
  expect(title?.textContent?.trim()).toBe("acme/fresh");
  expect(title?.getAttribute("title")).toBe(fresh);
});

function card(container: HTMLElement, field: string): HTMLElement | null {
  return container.querySelector(`[data-field="${field}"]`);
}

function architectureSection(): Record<string, unknown> {
  return (discover.state!.sheet as Record<string, unknown>).architecture as Record<string, unknown>;
}

test("an unknown shared-kernels leaf renders its reason instead of the empty line", () => {
  discover.state = state({});
  architectureSection().sharedKernels = {
    value: null,
    evidence: ["."],
    confidence: "unknown",
    reason: "The crawl could not read the workspace layout.",
  };
  const view = render(DiscoverOverview);
  const kernels = card(view.container, "shared-kernels");
  const text = kernels?.textContent?.replace(/\s+/g, " ").trim() ?? "";

  expect(kernels).not.toBeNull();
  expect(text).toContain("unknown — The crawl could not read the workspace layout.");
  expect(text).not.toContain("No shared kernel was detected.");
  expect(kernels?.querySelector('[data-testid="discover-shared-kernels"]')).toBeNull();
});

test("an observed empty shared-kernels leaf renders the empty line", () => {
  discover.state = state({});
  architectureSection().sharedKernels = leaf([]);
  const view = render(DiscoverOverview);
  const kernels = card(view.container, "shared-kernels");

  expect(kernels?.textContent).toContain("No shared kernel was detected.");
  expect(kernels?.querySelector(".panel__subtitle")).toBeNull();
  expect(kernels?.querySelector('[data-testid="discover-shared-kernels"]')).toBeNull();
});

test("one shared kernel links to VS Code and counts one kernel", () => {
  discover.state = state({ "src/shared": DIRECTORY });
  const view = render(DiscoverOverview);
  const kernels = card(view.container, "shared-kernels");
  const link = kernels === null ? null : anchor(kernels, "src/shared");

  expect(link?.getAttribute("href")).toBe(DIRECTORY);
  expect(link?.getAttribute("title")).toBe("Open in VS Code");
  expect(
    kernels?.querySelector(".panel__subtitle")?.textContent?.trim().replace(/\s+/g, " "),
  ).toBe("1 kernel");
});

test("two shared kernels stay plain and count two kernels", () => {
  discover.state = state({});
  architectureSection().sharedKernels = leaf(["src/shared", "src/orders"]);
  const view = render(DiscoverOverview);
  const kernels = card(view.container, "shared-kernels");

  expect(
    kernels?.querySelector(".panel__subtitle")?.textContent?.trim().replace(/\s+/g, " "),
  ).toBe("2 kernels");
  expect(kernels === null ? null : chip(kernels, "src/shared")?.tagName).toBe("CODE");
  expect(kernels === null ? null : chip(kernels, "src/orders")?.tagName).toBe("CODE");
  expect(view.container.querySelectorAll('a[href^="vscode://"]')).toHaveLength(0);
});

test("a missing shared-kernels leaf drops only that card", () => {
  discover.state = state({});
  delete architectureSection().sharedKernels;
  const view = render(DiscoverOverview);

  expect(card(view.container, "shared-kernels")).toBeNull();
  expect(card(view.container, "external-boundaries")).not.toBeNull();
  expect(chip(view.container, "PostgreSQL")).not.toBeNull();
});

function contextsValue(value: Array<Record<string, unknown>>): void {
  const payload = discover.state as DiscoverStatePayload;
  const architecture = payload.sheet?.architecture as {
    contexts: { value: Array<Record<string, unknown>> };
  };
  architecture.contexts.value = value;
}

test("a context record with only a path renders no row and no count", () => {
  discover.state = state({});
  contextsValue([{ name: "", path: "src/orders" }]);
  const view = render(DiscoverOverview);

  expect(view.container.querySelectorAll("li.discover-context")).toHaveLength(0);
  expect(view.container.querySelector('[data-testid="discover-contexts"]')).toBeNull();
  const counts = [...view.container.querySelectorAll(".panel__subtitle")].map((element) =>
    element.textContent?.trim().replace(/\s+/g, " ") ?? "",
  );
  expect(counts.some((text) => /^\d+ contexts?$/.test(text))).toBe(false);
});

test("a named context without a path still renders its row", () => {
  discover.state = state({});
  contextsValue([{ name: "Orders", responsibility: "Owns records." }]);
  const view = render(DiscoverOverview);

  const row = view.container.querySelector("li.discover-context");
  expect(row?.getAttribute("data-context")).toBe("Orders");
  expect(row?.textContent).toContain("Owns records.");
});

function commandsValue(value: Record<string, unknown>): void {
  (discover.state!.sheet as Record<string, unknown>).commands = value;
}

function coverageText(container: HTMLElement): string {
  return (
    container
      .querySelector('[data-testid="discover-command-coverage"]')
      ?.textContent?.trim()
      .replace(/\s+/g, " ") ?? ""
  );
}

test("a try-out that aliases the suite counts one slot and lists one row", async () => {
  discover.state = state({});
  commandsValue({
    test: leaf("bun test"),
    tryOut: leaf("bun test"),
    build: leaf("bun run build"),
  });
  const view = render(DiscoverOverview);
  const rows = (): number =>
    view.container.querySelectorAll('[data-testid="discover-command-list"] tbody tr').length;

  expect(coverageText(view.container)).toBe("2 of 7 found");
  expect(rows()).toBe(2);

  await fireEvent.click(view.container.querySelector('[data-testid="discover-command-coverage"]')!);

  expect(coverageText(view.container)).toBe("2 of 7 found");
  expect(rows()).toBe(7);
});

test("a sheet that records no command reads zero of every slot", () => {
  discover.state = state({});
  commandsValue({});
  const view = render(DiscoverOverview);

  expect(coverageText(view.container)).toBe("0 of 8 found");
});

function remoteState(): DiscoverStatePayload {
  const payload = state({});
  payload.remoteAvailable = true;
  payload.retained = [
    {
      url: "https://github.com/acme/retained",
      owner: "acme",
      repo: "retained",
      completedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  payload.target = {
    kind: "remote",
    url: "https://github.com/acme/retained",
    owner: "acme",
    repo: "retained",
    checkout: false,
  };
  return payload;
}

test("Run all disables the remote strip's switch, remove, and clear", () => {
  const previous = connection.state;
  connection.state = "open";
  try {
    discover.state = remoteState();
    discover.active = false;
    discover.starting = false;
    discover.runningAll = true;
    const view = render(DiscoverOverview);

    for (const testid of [
      "discover-remote-select",
      "discover-remote-remove",
      "discover-remote-clear",
    ]) {
      const control = view.container.querySelector(`[data-testid="${testid}"]`);
      expect(control).not.toBeNull();
      expect(control?.hasAttribute("disabled")).toBe(true);
      expect(control?.getAttribute("title")).toBe("Run all is running");
    }
  } finally {
    connection.state = previous;
  }
});

test("a refused remote submission keeps the typed URL and never claims no answer", async () => {
  const previousSend = connection.send;
  const previousState = connection.state;
  const sent: unknown[] = [];
  connection.send = ((command: unknown) => {
    sent.push(command);
    return true;
  }) as typeof connection.send;
  connection.state = "open";
  jest.useFakeTimers();
  try {
    discover.state = remoteState();
    const view = render(DiscoverOverview);
    const refused = "http://github.com/octocat/Hello-World";
    const input = view.container.querySelector(
      '[data-testid="discover-remote-url"]',
    ) as HTMLInputElement;

    await fireEvent.input(input, { target: { value: refused } });
    await fireEvent.click(
      view.container.querySelector('[data-testid="discover-remote-start"]')!,
    );
    await tick();

    expect(sent).toEqual([{ type: "discoverRemote", url: refused }]);
    expect(input.value).toBe(refused);

    discover.handleEvent({
      type: "discoverError",
      message: "Could not clone the repository: the URL must start with https://.",
    });
    await tick();
    jest.advanceTimersByTime(10_000);
    await tick();

    expect(input.value).toBe(refused);
    expect(view.container.querySelector('[data-testid="command-notice"]')).toBeNull();
  } finally {
    jest.useRealTimers();
    connection.send = previousSend;
    connection.state = previousState;
  }
});
