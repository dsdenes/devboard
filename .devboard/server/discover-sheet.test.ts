import { describe, expect, test } from "bun:test";
import { normalizeSheet, type Freshness } from "./discover";

const FRESHNESS: Freshness = {
  project: "fixture",
  commit: "abc1234",
  dirty: false,
  discoveredAt: "2026-10-27T12:00:00.000Z",
  fingerprint: "0123456789abcdef",
};

function leaf(value: unknown): Record<string, unknown> {
  return { value, evidence: ["README.md"], confidence: "observed" };
}

function sheet(dependencies?: unknown): Record<string, unknown> {
  const architecture: Record<string, unknown> = {
    contexts: leaf([
      {
        name: "Checkout",
        path: "src/checkout",
        responsibility: "Places the order.",
        entryPoints: ["src/checkout/flow.ts"],
      },
      {
        name: "Orders",
        path: "src",
        responsibility: "Owns the order record.",
        entryPoints: ["src"],
      },
    ]),
    dependencyDirection: leaf("Checkout depends on Orders."),
    externalBoundaries: leaf([]),
    sharedKernels: leaf([]),
  };
  if (dependencies !== undefined) architecture.dependencies = dependencies;
  return {
    schemaVersion: 1,
    definition: leaf("The fixture places orders."),
    stack: leaf(["TypeScript"]),
    deployment: {
      class: leaf("package"),
      artifact: leaf("fixture"),
      target: leaf("npm"),
      pipelineSources: leaf([]),
    },
    environments: leaf([{ name: "production", purpose: "Publishes the package." }]),
    commands: {
      install: leaf("bun install"),
      build: leaf("bun run build"),
      test: leaf("bun test"),
      lint: leaf("bun run lint"),
      typecheck: leaf("bunx tsc --noEmit"),
      dev: leaf("bun run dev"),
      tryOut: leaf("bun run start"),
      release: leaf("bun run release"),
    },
    branching: {
      defaultBranch: leaf("main"),
      mergeMethod: leaf("squash"),
      releaseBranches: leaf([]),
      model: leaf("direct"),
    },
    testing: {
      levels: leaf([
        {
          level: "unit",
          tests: "1",
          happyPath: "1",
          paths: ["test"],
          command: "bun test",
          fixtures: [],
        },
      ]),
      pyramid: leaf("Unit tests only."),
    },
    architecture,
    ci: {
      provider: leaf("GitHub Actions"),
      triggers: leaf(["push"]),
      jobs: leaf(["test"]),
      qualityGates: leaf(["bun test"]),
      artifacts: leaf([]),
    },
    runtime: {
      languages: leaf(["TypeScript"]),
      runtimes: leaf(["Bun"]),
      packageManagers: leaf(["bun"]),
      versions: leaf([]),
      manifests: leaf(["package.json"]),
    },
    dependencyMap: {
      binaries: leaf([]),
      packages: leaf([]),
      routes: leaf([]),
      jobs: leaf([]),
      externalServices: leaf([]),
      dataStores: leaf([]),
      keyDependencies: leaf([]),
    },
    delivery: {
      artifactTarget: leaf("npm"),
      releaseChannels: leaf([]),
      versionScheme: leaf("semver"),
      migrationPolicy: leaf("none detected"),
    },
  };
}

function normalize(raw: Record<string, unknown>): Record<string, unknown> {
  return normalizeSheet(raw, FRESHNESS).architecture as Record<string, unknown>;
}

describe("architecture dependencies", () => {
  test("publishes directed edges sorted by both endpoints", () => {
    const architecture = normalize(
      sheet(
        leaf([
          { from: "Orders", to: "Checkout" },
          { from: "Checkout", to: "Orders" },
        ]),
      ),
    );
    expect((architecture.dependencies as { value: unknown }).value).toEqual([
      { from: "Checkout", to: "Orders" },
      { from: "Orders", to: "Checkout" },
    ]);
  });

  test("loads a sheet published before dependencies existed", () => {
    const architecture = normalize(sheet());
    expect(architecture.dependencies).toBeUndefined();
  });

  test("accepts an unknown graph", () => {
    const architecture = normalize(
      sheet({
        value: null,
        evidence: [],
        confidence: "unknown",
        reason: "No import crosses a context boundary.",
      }),
    );
    expect(architecture.dependencies).toEqual({
      value: null,
      evidence: [],
      confidence: "unknown",
      reason: "No import crosses a context boundary.",
    });
  });

  test("rejects an edge that depends on its own context", () => {
    expect(() =>
      normalize(sheet(leaf([{ from: "Orders", to: "Orders" }]))),
    ).toThrow("must differ from the source context");
  });

  test("rejects an endpoint that is not a bounded context", () => {
    expect(() =>
      normalize(sheet(leaf([{ from: "Checkout", to: "Shipping" }]))),
    ).toThrow('must name a bounded context; "Shipping" is not one');
  });

  test("rejects a repeated edge", () => {
    expect(() =>
      normalize(
        sheet(
          leaf([
            { from: "Checkout", to: "Orders" },
            { from: "Checkout", to: "Orders" },
          ]),
        ),
      ),
    ).toThrow("repeats the dependency Checkout -> Orders");
  });
});
