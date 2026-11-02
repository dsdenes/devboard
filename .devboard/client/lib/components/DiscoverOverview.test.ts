import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DiscoverStatePayload } from "../types";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Static imports evaluate before the DOM globals exist, so the component and
// the testing library load after registration.
const { cleanup, render } = await import("@testing-library/svelte");
const { default: DiscoverOverview } = await import("./DiscoverOverview.svelte");
const { discover } = await import("../discover.svelte");

afterEach(() => {
  cleanup();
  discover.state = null;
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
