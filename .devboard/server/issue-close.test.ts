import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "../lib/forge-auth";
import { closeIssue, type ForgeRunner } from "./issue-close";

const authExec: Exec = async (command, args) => {
  if (command !== "gh") return { stdout: "", stderr: "unexpected", code: 1 };
  if (args[0] === "auth" && args[1] === "status") {
    return {
      stdout: JSON.stringify({
        hosts: { "github.com": [{ login: "acme-bot", active: true, state: "success" }] },
      }),
      stderr: "",
      code: 0,
    };
  }
  if (args[0] === "auth" && args[1] === "token") {
    return { stdout: "stub-token\n", stderr: "", code: 0 };
  }
  if (args[0] === "api" && args.includes(".permissions")) {
    return { stdout: JSON.stringify({ admin: true, push: true }), stderr: "", code: 0 };
  }
  return { stdout: "", stderr: "unexpected", code: 1 };
};

/**
 * A GitLab auth probe that never answers `gh`: a close that fell through to
 * `gh` would fail here instead of recording a command.
 */
const gitlabExec: Exec = async (command, args) => {
  if (command !== "glab") return { stdout: "", stderr: `unexpected ${command}`, code: 1 };
  if (args[0] === "auth" && args[1] === "status") {
    return { stdout: "  ✓ Token: glpat-stub\n", stderr: "", code: 0 };
  }
  if (args[0] === "api" && args.includes("user")) {
    return { stdout: JSON.stringify({ username: "acme-bot" }), stderr: "", code: 0 };
  }
  if (args[0] === "api") {
    return {
      stdout: JSON.stringify({
        visibility: "private",
        permissions: { project_access: { access_level: 40 } },
      }),
      stderr: "",
      code: 0,
    };
  }
  return { stdout: "", stderr: `unexpected glab ${args.join(" ")}`, code: 1 };
};

const checkouts: string[] = [];

/** A real checkout whose origin names a GitLab project. */
async function gitlabCheckout(): Promise<string> {
  const root = await mkdtemp(join(import.meta.dir, ".tmp-issue-close-"));
  checkouts.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", [
    "-C",
    root,
    "remote",
    "add",
    "origin",
    "git@gitlab.com:acme/fixture.git",
  ]);
  return root;
}

async function cleanupCheckouts(): Promise<void> {
  await Promise.all(checkouts.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

describe("closing an issue", () => {
  test("closes the origin issue as not planned with the write credential", async () => {
    const calls: string[][] = [];
    const environments: Array<Record<string, string | undefined>> = [];
    const run: ForgeRunner = async (argv, environment) => {
      calls.push(argv);
      environments.push(environment);
      return { code: 0, stdout: "", stderr: "" };
    };

    await closeIssue({
      repoDir: "/repo",
      repository: "acme/fixture",
      number: 42,
      environment: { HOME: "/home/acme", PATH: "/usr/bin" },
      exec: authExec,
      run,
    });

    expect(calls).toEqual([
      ["issue", "close", "42", "--repo", "acme/fixture", "--reason", "not planned"],
    ]);
    expect(environments[0]?.GH_TOKEN).toBe("stub-token");
    expect(environments[0]?.GH_HOST).toBe("github.com");
  });

  test("refuses a number that is not a positive integer", async () => {
    for (const number of [0, -1, 1.5, Number.NaN]) {
      await expect(
        closeIssue({
          repoDir: "/repo",
          repository: "acme/fixture",
          number,
          environment: { HOME: "/home/acme", PATH: "/usr/bin" },
          exec: authExec,
          run: async () => ({ code: 0, stdout: "", stderr: "" }),
        }),
      ).rejects.toThrow("Closing an issue needs a positive issue number.");
    }
  });

  test("reports the first diagnostic line when gh refuses the closure", async () => {
    await expect(
      closeIssue({
        repoDir: "/repo",
        repository: "acme/fixture",
        number: 42,
        environment: { HOME: "/home/acme", PATH: "/usr/bin" },
        exec: authExec,
        run: async () => ({
          code: 1,
          stdout: "",
          stderr: "HTTP 403: Resource not accessible\nmore detail",
        }),
      }),
    ).rejects.toThrow("Could not close issue #42: HTTP 403: Resource not accessible");
  });

  test("reports an unavailable write credential without running gh", async () => {
    let ran = false;
    await expect(
      closeIssue({
        repoDir: "/repo",
        repository: "acme/fixture",
        number: 42,
        environment: { HOME: "/home/acme", PATH: "/usr/bin" },
        exec: async () => ({ stdout: "", stderr: "not logged in", code: 1 }),
        run: async () => {
          ran = true;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });
});

describe("closing a GitLab issue", () => {
  afterEach(cleanupCheckouts);

  test("runs glab with the GitLab credential and no gh argument", async () => {
    const calls: string[][] = [];
    const environments: Array<Record<string, string | undefined>> = [];
    const run: ForgeRunner = async (argv, environment) => {
      calls.push(argv);
      environments.push(environment);
      return { code: 0, stdout: "", stderr: "" };
    };

    await closeIssue({
      repoDir: await gitlabCheckout(),
      repository: "acme/fixture",
      number: 7,
      environment: { HOME: "/home/acme", PATH: "/usr/bin" },
      exec: gitlabExec,
      run,
    });

    expect(calls).toEqual([["glab", "issue", "close", "7", "--repo", "acme/fixture"]]);
    expect(calls[0]).not.toContain("--reason");
    expect(environments[0]?.GITLAB_TOKEN).toBe("glpat-stub");
    expect(environments[0]?.GITLAB_HOST).toBe("gitlab.com");
  });

  test("never spawns gh when the environment also holds a GitHub token", async () => {
    const calls: string[][] = [];
    const run: ForgeRunner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };

    await closeIssue({
      repoDir: await gitlabCheckout(),
      repository: "acme/fixture",
      number: 8,
      environment: {
        HOME: "/home/acme",
        PATH: "/usr/bin",
        GH_TOKEN: "gho_ambient",
        GITHUB_TOKEN: "ambient",
      },
      exec: gitlabExec,
      run,
    });

    expect(calls).toEqual([["glab", "issue", "close", "8", "--repo", "acme/fixture"]]);
    expect(calls.every((argv) => argv[0] === "glab")).toBe(true);
  });
});
