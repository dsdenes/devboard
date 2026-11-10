/**
 * The suite's `.env` walk stays inside the checkout that bounds it.
 *
 * The operator suite files and closes issues on a live Gitea board, so a
 * `.env` above the repository root must never decide the URL or the token.
 * These cases build their own trees under `.devboard/.tmp`, so no real
 * checkout's `.env` takes part.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  dotEnvCandidates,
  dotEnvRootFor,
  giteaUrl,
  loadDotEnv,
  repoRoot,
  tmpDir,
} from "./support.ts";

const scratch = path.join(tmpDir, "dotenv");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function tree(...parts: string[]): string {
  const directory = path.join(scratch, ...parts);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function dotEnv(directory: string, body: string): void {
  writeFileSync(path.join(directory, ".env"), body);
}

describe("the suite's .env search", () => {
  test("yields only candidates at or below the root, nearest first", () => {
    const root = tree("bounded", "repo");
    const harness = tree("bounded", "repo", ".devboard");
    const candidates = dotEnvCandidates(harness, root);
    expect(candidates).toEqual([path.join(harness, ".env"), path.join(root, ".env")]);
    for (const candidate of candidates) {
      const relative = path.relative(root, candidate);
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
  });

  test("stops above the root even when several .env ancestors exist", () => {
    const base = tree("outside");
    dotEnv(base, "DEVBOARD_GITEA_URL=http://outside.test\n");
    dotEnv(tree("outside", "middle"), "DEVBOARD_GITEA_URL=http://middle.test\n");
    const root = tree("outside", "middle", "repo");
    const harness = tree("outside", "middle", "repo", ".devboard");
    expect(dotEnvCandidates(harness, root)).toEqual([
      path.join(harness, ".env"),
      path.join(root, ".env"),
    ]);
  });

  test("leaves the environment unchanged for a .env above the root", () => {
    const base = tree("adopted");
    dotEnv(base, "DEVBOARD_GITEA_URL=http://outside.test\n");
    const root = tree("adopted", "middle", "repo");
    const harness = tree("adopted", "middle", "repo", ".devboard");
    const saved = process.env.DEVBOARD_GITEA_URL;
    delete process.env.DEVBOARD_GITEA_URL;
    try {
      loadDotEnv({ start: harness, root });
      expect(process.env.DEVBOARD_GITEA_URL).toBeUndefined();
      expect(() => giteaUrl()).toThrow("the suite needs DEVBOARD_GITEA_URL");
    } finally {
      if (saved === undefined) delete process.env.DEVBOARD_GITEA_URL;
      else process.env.DEVBOARD_GITEA_URL = saved;
    }
  });

  test("reads a .env at the root", () => {
    const root = tree("supplied", "repo");
    dotEnv(root, "DEVBOARD_GITEA_URL='http://supplied.test/'\n");
    const harness = tree("supplied", "repo", ".devboard");
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ start: harness, root, env });
    expect(env.DEVBOARD_GITEA_URL).toBe("http://supplied.test/");
  });

  test("prefers the nearest .env and never overrides a set value", () => {
    const root = tree("nearest", "repo");
    dotEnv(root, "DEVBOARD_GITEA_URL=http://root.test\nGITEA_TOKEN=root-token\n");
    const worktree = tree("nearest", "repo", ".worktree", "issue-1");
    dotEnv(worktree, "DEVBOARD_GITEA_URL=http://worktree.test\n");
    const harness = tree("nearest", "repo", ".worktree", "issue-1", ".devboard");
    const env: NodeJS.ProcessEnv = { GITEA_TOKEN: "caller-token" };
    loadDotEnv({ start: harness, root: dotEnvRootFor(worktree), env });
    expect(env.DEVBOARD_GITEA_URL).toBe("http://worktree.test");
    expect(env.GITEA_TOKEN).toBe("caller-token");
  });

  test("a worktree resolves the checkout that spawned it", () => {
    const checkout = tree("worktree", "checkout");
    dotEnv(checkout, "DEVBOARD_GITEA_URL=http://checkout.test\n");
    const worktree = tree("worktree", "checkout", ".worktree", "issue-1");
    const harness = tree("worktree", "checkout", ".worktree", "issue-1", ".devboard");
    expect(dotEnvRootFor(worktree)).toBe(checkout);
    const candidates = dotEnvCandidates(harness, dotEnvRootFor(worktree));
    expect(candidates).toContain(path.join(checkout, ".env"));
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv({ start: harness, root: dotEnvRootFor(worktree), env });
    expect(env.DEVBOARD_GITEA_URL).toBe("http://checkout.test");
  });

  test("this checkout bounds its own search", () => {
    const root = dotEnvRootFor(repoRoot);
    expect(path.relative(root, repoRoot).startsWith("..")).toBe(false);
    const candidates = dotEnvCandidates(path.join(repoRoot, ".devboard"), root);
    expect(candidates.at(-1)).toBe(path.join(root, ".env"));
    for (const candidate of candidates) {
      const relative = path.relative(root, candidate);
      expect(relative.startsWith("..")).toBe(false);
    }
  });
});
