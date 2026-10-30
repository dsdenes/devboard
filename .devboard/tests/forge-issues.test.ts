import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ForgeTimeoutError, type Exec } from "../lib/forge-auth.ts";
import { createForgeIssues, type ForgeRunner } from "../lib/forge-issues.ts";
import type { FetchLike } from "../lib/gitea.ts";
import { listIssues } from "../mcp/issues";

/**
 * Both forges answer `list("all", limit)` from two different transports: `gh
 * issue list` serves one state per call, while Gitea serves both states from
 * one API. The shared contract is the newest `limit` issues across states.
 */

interface CorpusIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  createdAt: string;
}

const testRoot = join(import.meta.dir, "..", ".tmp", "forge-issues-tests");
const created: string[] = [];
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

function repository(remote: string): string {
  mkdirSync(testRoot, { recursive: true });
  const directory = join(testRoot, `repo-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  created.push(directory);
  const git = (args: string[]) => {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", directory, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git(["init", "-q"]);
  git(["remote", "add", "origin", remote]);
  return directory;
}

function corpus(count: number): CorpusIssue[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    return {
      number,
      title: `issue ${number}`,
      state: number % 2 === 0 ? "closed" : "open",
      url: `https://example.test/acme/fixture/issues/${number}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + (number - 1) * 60_000).toISOString(),
    };
  });
}

/** The `gh` identity probes plus `gh issue list` for one corpus. */
function github(issues: CorpusIssue[]): { exec: Exec; run: ForgeRunner } {
  const exec: Exec = async (command, args) => {
    if (command !== "gh") {
      return { code: 1, stdout: "", stderr: `unexpected ${command}`, killed: false };
    }
    if (args[0] === "auth" && args[1] === "status") {
      return {
        code: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [{ login: "owner", active: true, state: "success", error: "" }],
          },
        }),
        stderr: "",
        killed: false,
      };
    }
    if (args[0] === "auth" && args[1] === "token") {
      return { code: 0, stdout: "gho_test\n", stderr: "", killed: false };
    }
    if (args[0] === "api") {
      return {
        code: 0,
        stdout: JSON.stringify({
          admin: true,
          maintain: true,
          push: true,
          triage: true,
          pull: true,
        }),
        stderr: "",
        killed: false,
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}`, killed: false };
  };
  const run: ForgeRunner = async (argv) => {
    const state = argv[argv.indexOf("--state") + 1];
    const limit = Number(argv[argv.indexOf("--limit") + 1]);
    const rows = issues
      .filter((issue) => issue.state === state)
      .sort((left, right) => right.number - left.number)
      .slice(0, limit);
    return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
  };
  return { exec, run };
}

/** A Gitea transport that paginates one corpus, capped at the page size. */
function gitea(issues: CorpusIssue[]): FetchLike {
  return async (input) => {
    const url = new URL(String(input));
    const json = (value: unknown) => Response.json(value);
    if (url.pathname.endsWith("/api/v1/repos/acme/fixture")) {
      return json({
        full_name: "acme/fixture",
        private: false,
        permissions: { pull: true, push: false },
      });
    }
    if (url.pathname.endsWith("/issues")) {
      const state = url.searchParams.get("state") ?? "open";
      const page = Number(url.searchParams.get("page") ?? "1");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const rows = issues.filter((issue) => state === "all" || issue.state === state);
      const start = (page - 1) * limit;
      return json(
        rows.slice(start, start + limit).map((issue) => ({
          number: issue.number,
          title: issue.title,
          body: "",
          state: issue.state,
          labels: [],
          html_url: issue.url,
          created_at: issue.createdAt,
        })),
      );
    }
    return json({ message: `unexpected ${url}` });
  };
}

function githubForge(issues: CorpusIssue[]) {
  const stub = github(issues);
  return createForgeIssues({
    repoDir: repository("https://github.com/acme/fixture.git"),
    environment: {},
    exec: stub.exec,
    run: stub.run,
  });
}

function giteaForge(issues: CorpusIssue[]) {
  return createForgeIssues({
    repoDir: repository("ssh://git@localhost:2223/acme/fixture.git"),
    environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
    fetchImpl: gitea(issues),
  });
}

describe("forge issue listing across states", () => {
  test("merges GitHub states into createdAt order before slicing", async () => {
    const forge = githubForge(corpus(6));

    const listed = await forge.list("all", 4);

    expect(listed.map((issue) => issue.number)).toEqual([6, 5, 4, 3]);
    expect(listed.map((issue) => issue.state)).toEqual(["closed", "open", "closed", "open"]);
    const created = listed.map((issue) => Date.parse(issue.createdAt ?? ""));
    expect(created).toEqual([...created].sort((left, right) => right - left));
  });

  test("selects the same newest 50 issues on GitHub and Gitea", async () => {
    const issues = corpus(100);
    const expected = Array.from({ length: 50 }, (_, index) => 100 - index);

    const githubWindow = await githubForge(issues).list("all", 50);
    const giteaWindow = await giteaForge(issues).list("all", 50);

    expect(githubWindow.map((issue) => issue.number)).toEqual(expected);
    expect(giteaWindow.map((issue) => issue.number)).toEqual(expected);
    expect(githubWindow.map((issue) => issue.state)).toEqual(
      giteaWindow.map((issue) => issue.state),
    );
  });

  test("reports truncation from a newest-first window with mixed states", async () => {
    const repoDir = repository("https://github.com/acme/fixture.git");
    const stub = github(corpus(51));
    const forge = createForgeIssues({
      repoDir,
      environment: {},
      exec: stub.exec,
      run: stub.run,
    });

    const listed = await listIssues(
      { repoDir, harnessDir: repoDir, stateDir: repoDir, environment: {}, forgeIssues: forge },
      { state: "all", limit: 50 },
    );

    expect(listed.truncated).toBe(true);
    expect(listed.issues.map((issue) => issue.number)).toEqual(
      Array.from({ length: 50 }, (_, index) => 51 - index),
    );
    expect([...new Set(listed.issues.map((issue) => issue.state))].sort()).toEqual([
      "closed",
      "open",
    ]);
  });
});

describe("forge issue deadlines", () => {
  const TIMEOUT_MS = 25;

  test("rejects a read whose credential probe never settles", async () => {
    const forge = createForgeIssues({
      repoDir: repository("https://github.com/acme/fixture.git"),
      environment: {},
      exec: () => new Promise(() => {}),
      run: async () => ({ code: 0, stdout: "[]", stderr: "" }),
      timeoutMs: TIMEOUT_MS,
    });

    const started = Date.now();
    await expect(forge.get(1)).rejects.toBeInstanceOf(ForgeTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("rejects a list whose forge command never settles", async () => {
    const stub = github(corpus(1));
    const forge = createForgeIssues({
      repoDir: repository("https://github.com/acme/fixture.git"),
      environment: {},
      exec: stub.exec,
      run: () => new Promise(() => {}),
      timeoutMs: TIMEOUT_MS,
    });

    const started = Date.now();
    await expect(forge.list("open")).rejects.toBeInstanceOf(ForgeTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
