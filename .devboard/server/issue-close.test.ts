import { describe, expect, test } from "bun:test";
import type { Exec } from "../lib/forge-auth";
import { closeIssue, type GhRunner } from "./issue-close";

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

describe("closing an issue", () => {
  test("closes the origin issue as not planned with the write credential", async () => {
    const calls: string[][] = [];
    const environments: Array<Record<string, string | undefined>> = [];
    const run: GhRunner = async (argv, environment) => {
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
