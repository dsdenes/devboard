import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dependencyName, normalizeRepositoryUrl } from "../lib/dependencies.ts";
import { dependencyRepositories, packageRepository } from "./discover.ts";

const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "dependencies-tests");
mkdirSync(TEST_ROOT, { recursive: true });

const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) rmSync(directory, { force: true, recursive: true });
  rmSync(TEST_ROOT, { force: true, recursive: true });
});

function fixture(name: string): string {
  const directory = join(
    TEST_ROOT,
    `${name}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
  );
  mkdirSync(directory, { recursive: true });
  cleanup.push(directory);
  return directory;
}

function manifest(
  root: string,
  name: string,
  value: Record<string, unknown>,
): void {
  const directory = join(root, "node_modules", ...name.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(value)}\n`);
}

describe("dependency names", () => {
  test("derives the package name a stack entry starts with", () => {
    expect(dependencyName("TypeScript")).toBe("TypeScript");
    expect(dependencyName("@babel/parser ^7.29.9")).toBe("@babel/parser");
    expect(dependencyName("typescript@5.4.2")).toBe("typescript");
    expect(dependencyName("  ")).toBe("");
  });
});

describe("repository URLs", () => {
  test("normalizes the forms package manifests use", () => {
    expect(normalizeRepositoryUrl("git+https://github.com/babel/babel.git")).toBe(
      "https://github.com/babel/babel",
    );
    expect(normalizeRepositoryUrl("git@github.com:microsoft/TypeScript.git")).toBe(
      "https://github.com/microsoft/TypeScript",
    );
    expect(normalizeRepositoryUrl("github:owner/repo")).toBe("https://github.com/owner/repo");
    expect(normalizeRepositoryUrl("ssh://git@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
  });

  test("keeps a GitHub monorepo directory in the link", () => {
    expect(
      normalizeRepositoryUrl("git+https://github.com/babel/babel.git", "packages/babel-parser"),
    ).toBe("https://github.com/babel/babel/tree/HEAD/packages/babel-parser");
    expect(normalizeRepositoryUrl("git+https://gitlab.com/owner/repo.git", "packages/core")).toBe(
      "https://gitlab.com/owner/repo",
    );
  });

  test("rejects values with no browsable repository", () => {
    expect(normalizeRepositoryUrl("")).toBeNull();
    expect(normalizeRepositoryUrl("file:///srv/repo")).toBeNull();
    expect(normalizeRepositoryUrl("not a url")).toBeNull();
    expect(normalizeRepositoryUrl("https://github.com")).toBeNull();
  });
});

describe("installed package repositories", () => {
  test("reads the repository an installed manifest declares", () => {
    const root = fixture("manifest");
    manifest(root, "@scope/pkg", {
      name: "@scope/pkg",
      repository: {
        type: "git",
        url: "git+https://github.com/scope/monorepo.git",
        directory: "packages/pkg",
      },
    });
    expect(packageRepository(root, "@scope/pkg")).toBe(
      "https://github.com/scope/monorepo/tree/HEAD/packages/pkg",
    );
    expect(packageRepository(root, "missing")).toBeNull();
    expect(packageRepository(root, "../escape")).toBeNull();
  });

  test("links only the sheet entries an installed package backs", () => {
    const root = fixture("sheet");
    manifest(root, "typescript", {
      name: "typescript",
      repository: "git+https://github.com/microsoft/TypeScript.git",
    });
    manifest(root, "zod", {
      name: "zod",
      repository: "git+https://github.com/colinhacks/zod.git",
    });
    const links = dependencyRepositories(root, {
      stack: { value: ["TypeScript", "Bun"], confidence: "declared", evidence: [] },
      dependencyMap: {
        keyDependencies: {
          value: ["zod ^4.0.0", "vitest ^3"],
          confidence: "declared",
          evidence: [],
        },
      },
    });
    // Only stack entries render as chips, so only stack names get links.
    expect(links).toEqual({ TypeScript: "https://github.com/microsoft/TypeScript" });
  });
});
