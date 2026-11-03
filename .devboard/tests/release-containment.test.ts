import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createRepositoryGitHub,
  type GitHubCommandRunner,
} from "../lib/github-release";
import { resolveShippedVersion, type PublishedRelease } from "../lib/release-resolution";
import { createGiteaVersionClient } from "../lib/gitea-release";
import type { FetchLike, GiteaTarget } from "../lib/gitea";

/**
 * A checkout that fetched only some published release tags must not treat the
 * tags it happens to hold as the complete answer: an earlier release whose tag
 * it never fetched still contains the closing commit, and `earliestRelease`
 * has to see it. Both resolvers share one local split and ask the forge only
 * about the releases the checkout cannot answer.
 */

const testRoot = join(import.meta.dir, "..", ".tmp", "release-containment-tests");
const created: string[] = [];
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

const target: GiteaTarget = { baseUrl: "http://gitea.test", project: "acme/fixture" };

const releases: PublishedRelease[] = [
  { tag: "v1.4.0", publishedAt: "2026-09-01T00:00:00Z" },
  { tag: "v1.5.0", publishedAt: "2026-10-01T00:00:00Z" },
];

function runGit(directory: string, args: string[]): string {
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
  return result.stdout.toString().trim();
}

/** A repository with commits A then B, and no tags. */
function createRepository(): { directory: string; earlier: string; later: string } {
  mkdirSync(testRoot, { recursive: true });
  const directory = join(testRoot, `repo-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  created.push(directory);
  runGit(directory, ["init", "-q"]);
  runGit(directory, ["commit", "--allow-empty", "-q", "-m", "earlier"]);
  const earlier = runGit(directory, ["rev-parse", "HEAD"]);
  runGit(directory, ["commit", "--allow-empty", "-q", "-m", "later"]);
  const later = runGit(directory, ["rev-parse", "HEAD"]);
  return { directory, earlier, later };
}

function tagAt(directory: string, tag: string, commit: string): void {
  runGit(directory, ["tag", tag, commit]);
}

/** A Gitea transport that compares release tags and serves one closing timeline. */
function giteaForge(contained: Set<string>, calls: string[], earlier: string): FetchLike {
  return async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const compare = /\/compare\/([^/]+)\.\.\.([0-9a-f]{40})$/.exec(url.pathname);
    if (compare !== null) {
      const tag = decodeURIComponent(compare[1]!);
      return Response.json({ total_commits: contained.has(tag) ? 0 : 1 });
    }
    if (url.pathname.endsWith("/issues/7/timeline")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json(page === 1 ? [{ type: "close", commit_id: earlier }] : []);
    }
    return Response.json({ message: `unexpected ${url.pathname}` }, { status: 404 });
  };
}

/** A GitHub command runner that compares release tags and serves one timeline. */
function githubForge(
  contained: Set<string>,
  calls: string[],
  earlier: string,
): GitHubCommandRunner {
  return async (argv) => {
    calls.push(argv.join(" "));
    const endpoint = argv.find((arg) => arg.startsWith("repos/acme/fixture/")) ?? "";
    if (endpoint === "repos/acme/fixture/issues/7/timeline") {
      return { code: 0, stdout: `${earlier}\n`, stderr: "" };
    }
    const compare = /^repos\/acme\/fixture\/compare\/[0-9a-f]+\.\.\.(.+)$/.exec(endpoint);
    if (compare !== null) {
      const tag = decodeURIComponent(compare[1]!);
      const status = contained.has(tag) ? "identical" : "behind";
      return { code: 0, stdout: `${status}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh api ${endpoint}` };
  };
}

function sorted(tags: string[]): string[] {
  return [...tags].sort();
}

test("Gitea includes an earlier release whose tag the checkout never fetched", async () => {
  const { directory, earlier, later } = createRepository();
  tagAt(directory, "v1.5.0", later);
  const calls: string[] = [];
  const client = createGiteaVersionClient(
    target,
    directory,
    giteaForge(new Set(["v1.4.0"]), calls, earlier),
  );

  expect(sorted(await client.containingReleaseTags(earlier, releases))).toEqual([
    "v1.4.0",
    "v1.5.0",
  ]);
  expect(calls.filter((call) => call.includes("compare/v1.5.0"))).toEqual([]);

  const resolution = await resolveShippedVersion({ number: 7, state: "closed" }, client, releases);
  expect(resolution).toEqual({ version: "v1.4.0", error: null, inferred: false });
});

test("GitHub includes an earlier release whose tag the checkout never fetched", async () => {
  const { directory, earlier, later } = createRepository();
  tagAt(directory, "v1.5.0", later);
  const calls: string[] = [];
  const github = createRepositoryGitHub({
    repository: "acme/fixture",
    repoDir: directory,
    run: githubForge(new Set(["v1.4.0"]), calls, earlier),
    environment: {},
  });

  expect(sorted(await github.containingReleaseTags(earlier, releases))).toEqual([
    "v1.4.0",
    "v1.5.0",
  ]);
  expect(calls.filter((call) => call.includes("compare/") && call.endsWith("v1.5.0"))).toEqual([]);

  const resolution = await resolveShippedVersion({ number: 7, state: "closed" }, github, releases);
  expect(resolution).toEqual({ version: "v1.4.0", error: null, inferred: false });
});

test("both forges report the same containing set for a partial local tag list", async () => {
  const { directory, earlier, later } = createRepository();
  tagAt(directory, "v1.5.0", later);

  const gitea = createGiteaVersionClient(
    target,
    directory,
    giteaForge(new Set(["v1.4.0"]), [], earlier),
  );
  const github = createRepositoryGitHub({
    repository: "acme/fixture",
    repoDir: directory,
    run: githubForge(new Set(["v1.4.0"]), [], earlier),
    environment: {},
  });

  const giteaTags = sorted(await gitea.containingReleaseTags(earlier, releases));
  const githubTags = sorted(await github.containingReleaseTags(earlier, releases));
  expect(giteaTags).toEqual(githubTags);
  expect(giteaTags).toEqual(["v1.4.0", "v1.5.0"]);
});

test("a checkout that names every release tag answers without the forge", async () => {
  const { directory, earlier, later } = createRepository();
  tagAt(directory, "v1.4.0", earlier);
  tagAt(directory, "v1.5.0", later);
  const forgeCalled = (): never => {
    throw new Error("the forge must not be asked when the checkout names every release tag");
  };

  const gitea = createGiteaVersionClient(target, directory, forgeCalled);
  expect(await gitea.containingReleaseTags(earlier, releases)).toEqual(["v1.4.0", "v1.5.0"]);
  expect(await gitea.containingReleaseTags(later, releases)).toEqual(["v1.5.0"]);

  const github = createRepositoryGitHub({
    repository: "acme/fixture",
    repoDir: directory,
    run: forgeCalled,
    environment: {},
  });
  expect(await github.containingReleaseTags(earlier, releases)).toEqual(["v1.4.0", "v1.5.0"]);
  expect(await github.containingReleaseTags(later, releases)).toEqual(["v1.5.0"]);
});
