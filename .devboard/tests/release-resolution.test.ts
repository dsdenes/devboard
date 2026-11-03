import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createRepositoryGitHub,
  resolveShippedVersion,
  type GitHubCommandRunner,
  type GitHubRelease,
} from "../lib/github-release";
import { createGiteaVersionClient } from "../lib/gitea-release";
import type { FetchLike, GiteaTarget } from "../lib/gitea";

/**
 * A shipped version is an assertion about the forge's history. A commit read
 * that failed is not the same answer as a commit the forge does not have: the
 * first keeps the version unresolved and records the reason, and only the
 * second may fall back to the release published nearest the close. GitHub and
 * Gitea answer one outage the same way.
 */

const testRoot = join(import.meta.dir, "..", ".tmp", "release-resolution-tests");
const created: string[] = [];
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

const target: GiteaTarget = { baseUrl: "http://gitea.test", project: "acme/fixture" };
const sha = "a".repeat(40);
const releases: GitHubRelease[] = [
  { tag: "v1.0.0", publishedAt: "2026-09-01T00:00:00Z" },
];
/** Closed after the release, so the timeline fallback would name v1.0.0. */
const issue = {
  number: 9,
  state: "closed" as const,
  createdAt: "2026-08-01T00:00:00Z",
  closedAt: "2026-10-01T00:00:00Z",
};

function checkout(): string {
  mkdirSync(testRoot, { recursive: true });
  const directory = join(testRoot, `repo-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  created.push(directory);
  const git = (args: string[]) => {
    const result = Bun.spawnSync({
      cmd: [
        "git",
        "-C",
        directory,
        "-c",
        "user.name=Devboard Tests",
        "-c",
        "user.email=tests@example.invalid",
        ...args,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git(["init", "-q"]);
  git(["commit", "--allow-empty", "-q", "-m", "init"]);
  return directory;
}

/** A `gh` runner whose timeline names the commit and whose commit read fails. */
function githubRunner(commitFailure: string | null): GitHubCommandRunner {
  return async (argv) => {
    const endpoint = argv[1] ?? "";
    if (endpoint === `repos/acme/fixture/issues/${issue.number}/timeline`) {
      return { code: 0, stdout: `${sha}\n`, stderr: "" };
    }
    if (endpoint === `repos/acme/fixture/commits/${sha}`) {
      return commitFailure === null
        ? { code: 0, stdout: `${sha}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: commitFailure };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh api ${endpoint}` };
  };
}

/** A Gitea transport whose timeline names the commit and whose commit read answers `status`. */
function giteaFetch(status: number): FetchLike {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/issues/${issue.number}/timeline`)) {
      return Response.json([{ type: "close", ref_commit_sha: sha }]);
    }
    if (url.pathname.endsWith(`/git/commits/${sha}`)) {
      return Response.json({ message: "API rate limit exceeded" }, { status });
    }
    return Response.json({ message: `unexpected ${url.pathname}` }, { status: 404 });
  };
}

function githubClient(commitFailure: string | null) {
  return createRepositoryGitHub({
    repository: "acme/fixture",
    repoDir: checkout(),
    run: githubRunner(commitFailure),
    environment: {},
  });
}

test("a rate-limited commit read never fabricates a shipped version", async () => {
  const fromGitHub = await resolveShippedVersion(
    issue,
    githubClient("HTTP 403: API rate limit exceeded"),
    releases,
  );
  expect(fromGitHub.version).toBeNull();
  expect(fromGitHub.inferred).toBe(false);
  expect(fromGitHub.error).toContain("HTTP 403: API rate limit exceeded");

  const fromGitea = await resolveShippedVersion(
    issue,
    createGiteaVersionClient(target, checkout(), giteaFetch(403)),
    releases,
  );
  expect(fromGitea).toEqual({ version: null, error: expect.any(String), inferred: false });
  expect(fromGitea.error).toContain("HTTP 403");
  expect({ version: fromGitHub.version, inferred: fromGitHub.inferred }).toEqual({
    version: fromGitea.version,
    inferred: fromGitea.inferred,
  });
});

test("a commit the forge does not have is still skipped for the timeline fallback", async () => {
  for (const failure of ["gh: Not Found (HTTP 404)", "gh: Validation Failed (HTTP 422)"]) {
    expect(
      await resolveShippedVersion(issue, githubClient(failure), releases),
    ).toEqual({ version: "v1.0.0", error: null, inferred: true });
  }

  for (const status of [404, 422]) {
    expect(
      await resolveShippedVersion(
        issue,
        createGiteaVersionClient(target, checkout(), giteaFetch(status)),
        releases,
      ),
    ).toEqual({ version: "v1.0.0", error: null, inferred: true });
  }
});

test("a blanket gh failure is an error, not an absent commit", async () => {
  expect(
    await resolveShippedVersion(issue, githubClient("HTTP 500: Internal Server Error"), releases),
  ).toEqual({ version: null, error: "HTTP 500: Internal Server Error", inferred: false });
});
