import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveForgeAuth } from "../lib/forge-auth.ts";
import { giteaBaseUrl, parseForgeRemote } from "../lib/forge.ts";
import { createForgeIssues } from "../lib/forge-issues.ts";
import {
  giteaClosingCommit,
  giteaClosingCommits,
  closingCommitFromGiteaTimeline,
  closingCommitsFromGiteaTimeline,
  giteaCreateRelease,
  giteaLabels,
  giteaListIssues,
  giteaListReleases,
  type FetchLike,
} from "../lib/gitea.ts";
import { shippedVersion, resolveShippedVersion } from "../lib/github-release.ts";
import { createGiteaVersionClient } from "../lib/gitea-release.ts";
import { createScoutGitHub } from "../issues/scout/github.ts";
import { createDesignForge } from "../issues/design/forge.ts";
import { pollOpenIssues } from "../issues/tracker";
import { closeIssue } from "../server/issue-close";
import { listIssues } from "../mcp/issues";
import { fakeGiteaPull } from "../server/fixtures/fake-gitea-pull";
import { CommandFlowForge } from "../server/forge-pr";
import { fileScoutIssue } from "../issues/scout/actions";
import { createWatchdogDelivery } from "../watchdog/delivery";
import { createForgeIssueReader } from "../server/agents/forge-reader";

/**
 * Gitea is a first-class forge: resolution, issue polling and closing, Flow's
 * pull requests, scout filing, and watchdog delivery all speak its API. The
 * transport is injected, so no test reaches an instance or reads a token.
 */

const testRoot = join(import.meta.dir, "..", ".tmp", "gitea-tests");
const created: string[] = [];
afterAll(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

interface Recorded {
  method: string;
  url: string;
  body?: string;
}

function repository(): string {
  mkdirSync(testRoot, { recursive: true });
  const directory = join(testRoot, `repo-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  created.push(directory);
  const git = (args: string[]) => {
    const result = Bun.spawnSync({ cmd: ["git", "-C", directory, ...args], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git(["init", "-q"]);
  git(["remote", "add", "origin", "ssh://git@localhost:2223/acme/fixture.git"]);
  return directory;
}

function committedRepository(): { directory: string; commit: string } {
  const directory = repository();
  const git = (args: string[]): string => {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", directory, ...args],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git([
    "-c",
    "user.name=Devboard Tests",
    "-c",
    "user.email=tests@example.invalid",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "shipped",
  ]);
  return { directory, commit: git(["rev-parse", "HEAD"]) };
}

function taggedRepository(tag: string): { directory: string; commit: string } {
  const { directory, commit } = committedRepository();
  const result = Bun.spawnSync({
    cmd: ["git", "-C", directory, "tag", tag],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return { directory, commit };
}

/**
 * A Gitea transport whose release response is capped at 50 entries: page 1 is
 * full, page 2 carries the tag under test, and page 3 is empty. When `commit`
 * is supplied it also serves the closed issue and its timeline.
 */
function fakeReleasePages(tag: string, calls: string[], commit?: string): FetchLike {
  return async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const json = (value: unknown) => Response.json(value);
    if (url.pathname.endsWith("/releases")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      if (page === 1) {
        return json(
          Array.from({ length: limit }, (_, index) => ({
            tag_name: `v9.${index}.0`,
            published_at: "2026-10-20T00:00:00Z",
          })),
        );
      }
      if (page === 2) return json([{ tag_name: tag, published_at: "2026-09-01T00:00:00Z" }]);
      return json([]);
    }
    if (commit !== undefined && /\/issues\/5$/.test(url.pathname)) {
      return json({ number: 5, state: "closed" });
    }
    if (commit !== undefined && url.pathname.endsWith("/issues/5/timeline")) {
      return json([
        { type: "commit_ref", commit_id: "f".repeat(40) },
        { type: "close", commit_id: commit },
      ]);
    }
    return json({ message: `unexpected ${url}` });
  };
}

function requestedReleasePages(calls: string[]): string[] {
  return calls
    .filter((call) => call.includes("/releases?"))
    .map((call) => new URL(call, "http://gitea.test").searchParams.get("page") ?? "");
}

/**
 * A Gitea transport for closed issues: every `/issues/<n>` reads closed, every
 * timeline names `commit`, and each repository's release scan is one release
 * followed by the terminating empty page.
 */
function fakeClosedIssues(commit: string, calls: string[]): FetchLike {
  return async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (/^\/api\/v1\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)) {
      return Response.json({ state: "closed" });
    }
    if (/^\/api\/v1\/repos\/[^/]+\/[^/]+\/issues\/\d+\/timeline$/.test(url.pathname)) {
      return Response.json([
        { type: "commit_ref", commit_id: "f".repeat(40) },
        { type: "close", commit_id: commit },
      ]);
    }
    if (url.pathname.endsWith("/releases")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      return Response.json(
        page === 1 ? [{ tag_name: "v1.0.0", published_at: "2026-09-01T00:00:00Z" }] : [],
      );
    }
    return Response.json({ message: `unexpected ${url}` });
  };
}

/** Release page requests per repository, so a shared cache is visible. */
function releasePagesByRepository(calls: string[]): Record<string, string[]> {
  const pages: Record<string, string[]> = {};
  for (const call of calls) {
    const url = new URL(call, "http://gitea.test");
    const match = /^\/api\/v1\/repos\/([^/]+\/[^/]+)\/releases$/.exec(url.pathname);
    if (match === null) continue;
    (pages[match[1]!] ??= []).push(url.searchParams.get("page") ?? "");
  }
  return pages;
}

function fakeGitea(
  calls: Recorded[] = [],
  permissions: { push: boolean; pull: boolean } = { push: true, pull: true },
): FetchLike {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof FormData
          ? "form"
          : undefined;
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/api/v1/repos/acme/fixture")) {
      return json({ full_name: "acme/fixture", private: false, permissions });
    }
    if (url.endsWith("/api/v1/user")) return json({ login: "acme-bot" });
    if (method === "GET" && /\/issues\/5$/.test(url)) {
      return json({
        number: 5,
        title: "Live Gitea issue",
        html_url: "http://gitea.test/acme/fixture/issues/5",
        created_at: "2026-10-01T00:00:00Z",
        state: "open",
        body: "body",
        labels: [{ name: "goal" }],
      });
    }
    if (url.includes("/issues?state=open")) {
      return json([
        {
          number: 5,
          title: "Live Gitea issue",
          html_url: "http://gitea.test/acme/fixture/issues/5",
          created_at: "2026-10-01T00:00:00Z",
          state: "open",
          body: "body",
          labels: [{ name: "goal" }],
        },
      ]);
    }
    if (method === "PATCH" && /\/issues\/5$/.test(url)) return json({ state: "closed" });
    if (method === "GET" && /\/labels\?limit=50&page=\d+$/.test(url)) return json([]);
    if (method === "POST" && /\/labels$/.test(url)) return json({ id: 9, name: "scout" }, 201);
    if (method === "POST" && /\/issues$/.test(url)) {
      return json(
        {
          number: 12,
          title: "filed",
          html_url: "http://gitea.test/acme/fixture/issues/12",
          created_at: "2026-10-01T00:00:00Z",
          state: "open",
          body: "body",
          labels: [],
        },
        201,
      );
    }
    if (method === "POST" && /\/issues\/12\/comments$/.test(url)) return json({ id: 1 }, 201);
    if (method === "POST" && /\/pulls$/.test(url)) {
      return json(
        {
          number: 3,
          html_url: "http://gitea.test/acme/fixture/pulls/3",
          title: "WIP: Flow change",
          state: "open",
          merged: false,
        },
        201,
      );
    }
    if (method === "GET" && /\/pulls\/3$/.test(url)) {
      return json({
        number: 3,
        html_url: "http://gitea.test/acme/fixture/pulls/3",
        title: "WIP: Flow change",
        state: "open",
        merged: false,
      });
    }
    if (method === "PATCH" && /\/pulls\/3$/.test(url)) return json({});
    if (method === "POST" && /\/pulls\/3\/merge$/.test(url)) return new Response("", { status: 200 });
    return json({ message: `unexpected ${method} ${url}` }, 500);
  };
}

describe("Gitea forge resolution", () => {
  test("classifies an SSH origin and resolves the HTTP address from configuration", () => {
    const remote = parseForgeRemote("ssh://git@localhost:2223/acme/fixture.git", {
      DEVBOARD_GITEA_URL: "http://gitea.test/",
    });
    expect(remote).toEqual({ forge: "gitea", host: "localhost", project: "acme/fixture" });
    expect(giteaBaseUrl(remote, { DEVBOARD_GITEA_URL: "http://gitea.test/" })).toBe(
      "http://gitea.test",
    );
    expect(parseForgeRemote("https://github.com/owner/repo.git", {})).toEqual({
      forge: "github",
      host: "github.com",
      project: "owner/repo",
      originUrl: "https://github.com",
    });
    expect(parseForgeRemote("git@github.com:owner/repo.git", {})).toEqual({
      forge: "github",
      host: "github.com",
      project: "owner/repo",
    });
    expect(parseForgeRemote("ssh://git@gitlab.example.com:2222/group/sub/project.git", {})).toEqual({
      forge: "gitlab",
      host: "gitlab.example.com",
      project: "group/sub/project",
    });
    expect(parseForgeRemote("ssh://git@localhost:2223/group/sub/project.git", {})).toEqual({
      forge: "gitea",
      host: "localhost",
      project: "sub/project",
    });
  });

  test("selects a write-capable Gitea token against the exact repository", async () => {
    const auth = await resolveForgeAuth(async () => ({ code: 1, stdout: "", stderr: "" }), {
      forge: "gitea",
      host: "localhost",
      project: "acme/fixture",
      cwd: "/repo",
      required: "write",
      env: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
      giteaFetch: fakeGitea(),
    });
    expect(auth).toMatchObject({
      forge: "gitea",
      login: "acme-bot",
      permission: "push",
      canWrite: true,
      baseUrl: "http://gitea.test",
    });
  });
});

describe("Gitea issues", () => {
  test("polls open issues without a pull request", async () => {
    const result = await pollOpenIssues({
      repository: "acme/fixture",
      forge: "gitea",
      baseUrl: "http://gitea.test",
      environment: { GITEA_TOKEN: "gitea-token" },
      giteaFetch: fakeGitea(),
    });
    expect(result.kind).toBe("issues");
    if (result.kind !== "issues") return;
    expect(result.issues).toEqual([
      {
        number: 5,
        title: "Live Gitea issue",
        url: "http://gitea.test/acme/fixture/issues/5",
        createdAt: "2026-10-01T00:00:00Z",
        labels: ["goal"],
      },
    ]);
  });

  test("closes an issue through the Gitea API", async () => {
    const calls: Recorded[] = [];
    await closeIssue({
      repoDir: repository(),
      repository: "acme/fixture",
      number: 5,
      environment: {
        DEVBOARD_GITEA_URL: "http://gitea.test",
        GITEA_TOKEN: "gitea-token",
      },
      giteaFetch: fakeGitea(calls),
    });
    expect(
      calls.some((call) => call.method === "PATCH" && call.url.endsWith("/issues/5")),
    ).toBe(true);
  });
});

describe("Gitea forge issue client", () => {
  test("reads issues on a public repository without a token", async () => {
    const calls: Recorded[] = [];
    const issues = createForgeIssues({
      repoDir: repository(),
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      fetchImpl: fakeGitea(calls, { push: false, pull: true }),
    });

    expect(await issues.list("open")).toEqual([
      {
        number: 5,
        title: "Live Gitea issue",
        state: "open",
        labels: ["goal"],
        url: "http://gitea.test/acme/fixture/issues/5",
        createdAt: "2026-10-01T00:00:00Z",
      },
    ]);
    expect(await issues.get(5)).toMatchObject({
      number: 5,
      title: "Live Gitea issue",
      state: "open",
      body: "body",
      labels: ["goal"],
    });
    expect(calls.some((call) => call.method === "GET" && call.url.endsWith("/issues/5"))).toBe(
      true,
    );

    await expect(issues.ensureLabel("goal")).rejects.toThrow("writing needs GITEA_TOKEN");
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/labels"))).toBe(
      false,
    );
  });

  test("reads issues with a pull-only token but refuses to write", async () => {
    const calls: Recorded[] = [];
    const issues = createForgeIssues({
      repoDir: repository(),
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
      fetchImpl: fakeGitea(calls, { push: false, pull: true }),
    });

    expect(await issues.list("open")).toHaveLength(1);
    expect((await issues.get(5)).number).toBe(5);
    await expect(issues.ensureLabel("goal")).rejects.toThrow("cannot write");
  });
});

describe("Gitea pagination", () => {
  /**
   * A server with `MAX_RESPONSE_ITEMS` set to `cap`: it never returns more
   * than that, even when the caller asks for a larger page.
   */
  function capped(total: number, cap = 50): FetchLike {
    return async (input) => {
      const url = new URL(String(input));
      const requested = Number(url.searchParams.get("limit") ?? cap);
      const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : cap, cap);
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * limit;
      const count = Math.max(0, Math.min(limit, total - start));
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname.endsWith("/api/v1/repos/acme/fixture")) {
        return json({
          full_name: "acme/fixture",
          private: false,
          permissions: { pull: true, push: false },
        });
      }
      if (url.pathname.endsWith("/issues")) {
        return json(
          Array.from({ length: count }, (_, offset) => {
            const number = start + offset + 1;
            return {
              number,
              title: `issue ${number}`,
              html_url: `http://gitea.test/acme/fixture/issues/${number}`,
              created_at: new Date(Date.UTC(2026, 0, 1) + (number - 1) * 60_000).toISOString(),
              state: "open",
              body: "",
              labels: [],
            };
          }),
        );
      }
      if (url.pathname.endsWith("/labels")) {
        return json(
          Array.from({ length: count }, (_, offset) => {
            const id = start + offset + 1;
            return { id, name: `label-${id}` };
          }),
        );
      }
      return json({ message: `unexpected ${url}` });
    };
  }

  test("lists every issue when the server caps a response below the request", async () => {
    const calls: Recorded[] = [];
    const fetchImpl = capped(120);
    const issues = await giteaListIssues(
      { baseUrl: "http://gitea.test", project: "acme/fixture" },
      "open",
      async (input, init) => {
        calls.push({ method: init?.method ?? "GET", url: String(input) });
        return fetchImpl(input, init);
      },
    );
    expect(issues).toHaveLength(120);
    expect(issues.map((issue) => issue.number)).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 1),
    );
    expect(calls.length).toBe(4);
    expect(calls[0]!.url).toContain("limit=50");
  });

  test("serves the newest issues to the forge list and the MCP issues_list path", async () => {
    const repoDir = repository();
    const forge = createForgeIssues({
      repoDir,
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      fetchImpl: capped(150),
    });

    // Coach's duplicate check reads exactly this window.
    const window = await forge.list("open", 100);
    expect(window.map((issue) => issue.number)).toEqual(
      Array.from({ length: 100 }, (_, index) => 150 - index),
    );

    const listed = await listIssues(
      { repoDir, harnessDir: repoDir, stateDir: repoDir, environment: {}, forgeIssues: forge },
      { state: "open", limit: 100 },
    );
    expect(listed.truncated).toBe(true);
    expect(listed.issues[0]!.number).toBe(150);
    expect(listed.issues.at(-1)!.number).toBe(51);
  });

  test("lists every label when the server caps a response below the request", async () => {
    const labels = await giteaLabels(
      { baseUrl: "http://gitea.test", project: "acme/fixture" },
      capped(60),
    );
    expect(labels.map((label) => label.id)).toEqual(
      Array.from({ length: 60 }, (_, index) => index + 1),
    );
  });

  test("lists every release page until a page adds no new tag", async () => {
    const target = { baseUrl: "http://gitea.test", project: "acme/fixture" };
    const calls: string[] = [];
    const releases = await giteaListReleases(target, fakeReleasePages("v0.1.713", calls));

    expect(releases).toHaveLength(51);
    expect(releases.at(-1)).toEqual({
      tag: "v0.1.713",
      publishedAt: "2026-09-01T00:00:00Z",
    });
    expect(requestedReleasePages(calls)).toEqual(["1", "2", "3"]);
    expect(calls[0]).toContain("limit=50");
  });
});

describe("Gitea release creation", () => {
  test("tags the released commit, never whatever main points at", async () => {
    const calls: Recorded[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return Response.json({ id: 7, tag_name: "v1.0.0" }, { status: 201 });
    };
    const commit = "a".repeat(40);
    await giteaCreateRelease(
      { baseUrl: "http://gitea.test", project: "acme/fixture" },
      { tag: "v1.0.0", title: "Devboard 1.0.0", notes: "notes", targetCommitish: commit },
      fetchImpl,
    );
    expect(JSON.parse(calls[0]?.body ?? "")).toMatchObject({
      tag_name: "v1.0.0",
      target_commitish: commit,
    });
  });

  test("defaults the target to main when the caller names no commit", async () => {
    const calls: Recorded[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return Response.json({ id: 7, tag_name: "v1.0.0" }, { status: 201 });
    };
    await giteaCreateRelease(
      { baseUrl: "http://gitea.test", project: "acme/fixture" },
      { tag: "v1.0.0", title: "Devboard 1.0.0", notes: "notes" },
      fetchImpl,
    );
    expect(JSON.parse(calls[0]?.body ?? "")).toMatchObject({ target_commitish: "main" });
  });
});

describe("Gitea Flow pull requests", () => {
  test("creates a draft, marks it ready, views it, and merges it", async () => {
    const calls: Recorded[] = [];
    const forge = new CommandFlowForge(
      async () => ({ code: 1, stdout: "", stderr: "" }),
      {
        env: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
        giteaFetch: fakeGitea(calls),
      },
    );
    const target = {
      forge: "gitea" as const,
      host: "localhost",
      project: "acme/fixture",
      baseUrl: "http://gitea.test",
    };
    const input = {
      cwd: "/repo",
      target,
      head: "flow-branch",
      base: "main",
      title: "Flow change",
      body: "## Goal",
    };
    const created = await forge.createDraft(input);
    expect(created).toMatchObject({ number: 3, draft: true });
    await forge.markReady(input.cwd, target, 3);
    const viewed = await forge.view(input.cwd, target, 3);
    expect(viewed.state).toBe("open");
    await forge.merge(input.cwd, target, 3);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/pulls/3/merge")))
      .toBe(true);
  });

  test("a checkpoint after Ready updates a live pull request without readding WIP", async () => {
    const fake = fakeGiteaPull();
    const forge = new CommandFlowForge(
      async () => ({ code: 1, stdout: "", stderr: "" }),
      {
        resolve: async () => ({
          forge: "gitea",
          host: "localhost",
          project: "acme/fixture",
          login: "fixture",
          token: "fixture-secret-token",
          source: "test",
          baseUrl: "http://gitea.test",
          active: true,
          permission: "push",
          canWrite: true,
        }),
        giteaFetch: fake.fetch,
      },
    );
    const input = {
      cwd: "/repo",
      target: {
        forge: "gitea" as const,
        host: "localhost",
        project: "acme/fixture",
        baseUrl: "http://gitea.test",
      },
      head: "flow-branch",
      base: "main",
      title: "Flow change",
      body: "## Goal",
    };

    await forge.createDraft(input);
    expect(fake.title()).toBe("WIP: Flow change");
    await forge.markReady(input.cwd, input.target, 3);
    expect(fake.title()).toBe("Flow change");

    await forge.update({ ...input, number: 3, body: "## Goal\n\nsecond checkpoint" });
    const patch = fake.calls
      .filter((call) => call.method === "PATCH" && call.url.endsWith("/pulls/3"))
      .at(-1);
    expect(JSON.parse(patch?.body ?? "{}")).toMatchObject({
      title: "Flow change",
      body: "## Goal\n\nsecond checkpoint",
    });
    expect(JSON.parse(patch?.body ?? "{}").title).not.toContain("WIP:");
    expect((await forge.view(input.cwd, input.target, 3)).draft).toBe(false);
  });
});

describe("Gitea scout filing", () => {
  test("creates the scout label and files the issue through the API", async () => {
    const calls: Recorded[] = [];
    const result = await fileScoutIssue({
      repoDir: repository(),
      repository: "acme/fixture",
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
      giteaFetch: fakeGitea(calls),
      recommendation: {
        id: "0123456789abcdef",
        category: "reliability",
        title: "Keep the poll bounded",
        summary: "A poll can outlive its interval.",
        impact: "",
        evidence: [{ path: "issues/tracker.ts", lines: "1-20" }],
        proposedChange: "Bound the poll.",
        files: ["issues/tracker.ts"],
        acceptanceCriteria: ["The poll settles."],
        significance: 4,
        significanceReason: "It blocks every other read.",
      },
    });
    expect(result).toEqual({ url: "http://gitea.test/acme/fixture/issues/12", number: 12 });
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/labels"))).toBe(true);
  });

  test("aborting the settle signal cancels an in-flight Gitea request", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const filing = fileScoutIssue({
      repoDir: repository(),
      repository: "acme/fixture",
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
      giteaFetch: (_input, init) => {
        started.resolve(init?.signal ?? undefined);
        return new Promise<Response>(() => {});
      },
      signal: controller.signal,
      recommendation: {
        id: "0123456789abcdef",
        category: "reliability",
        title: "Keep the poll bounded",
        summary: "A poll can outlive its interval.",
        impact: "",
        evidence: [{ path: "issues/tracker.ts", lines: "1-20" }],
        proposedChange: "Bound the poll.",
        files: ["issues/tracker.ts"],
        acceptanceCriteria: ["The poll settles."],
        significance: 4,
        significanceReason: "It blocks every other read.",
      },
    });
    const seen = await started.promise;
    controller.abort();
    await expect(filing).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
  });

  test("a filing whose signal is already aborted sends no request", async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    const filing = fileScoutIssue({
      repoDir: repository(),
      repository: "acme/fixture",
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
      giteaFetch: () => {
        requests += 1;
        return Promise.reject(new Error("no request expected"));
      },
      signal: controller.signal,
      recommendation: {
        id: "0123456789abcdef",
        category: "reliability",
        title: "Keep the poll bounded",
        summary: "A poll can outlive its interval.",
        impact: "",
        evidence: [{ path: "issues/tracker.ts", lines: "1-20" }],
        proposedChange: "Bound the poll.",
        files: ["issues/tracker.ts"],
        acceptanceCriteria: ["The poll settles."],
        significance: 4,
        significanceReason: "It blocks every other read.",
      },
    });
    await expect(filing).rejects.toThrow();
    expect(requests).toBe(0);
  });
});

describe("Gitea watchdog delivery", () => {
  test("files and comments through the API instead of a hardcoded repository", async () => {
    const calls: Recorded[] = [];
    const delivery = createWatchdogDelivery({
      root: repository(),
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
      gh: () => {
        throw new Error("gh must not run for a Gitea origin");
      },
      fetchImpl: fakeGitea(calls),
    });
    expect(delivery.repository).toBe("acme/fixture");
    expect(delivery.owns("http://gitea.test/acme/fixture/issues/12")).toBe(true);
    const filed = await delivery.create({
      category: "server-error",
      fingerprint: "fingerprint",
      line: "Synthetic error",
      firstSeen: "2026-10-01T00:00:00Z",
      lastSeen: "2026-10-01T00:00:00Z",
      count: 1,
      window: { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-01T00:01:00Z") },
      instances: [],
      reportPath: "/report.json",
    });
    expect(filed).toEqual({ ok: true, url: "http://gitea.test/acme/fixture/issues/12" });
    const commented = await delivery.comment("http://gitea.test/acme/fixture/issues/12", {
      category: "server-error",
      fingerprint: "fingerprint",
      line: "Synthetic error",
      firstSeen: "2026-10-01T00:00:00Z",
      lastSeen: "2026-10-01T00:00:00Z",
      count: 2,
      window: { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-01T00:01:00Z") },
      instances: [],
      reportPath: "/report.json",
    });
    expect(commented).toEqual({ ok: true });
    expect(
      calls.filter(
        (call) =>
          call.method === "POST" &&
          call.url === "http://gitea.test/api/v1/repos/acme/fixture/issues/12/comments",
      ),
    ).toHaveLength(1);
  });

  test("refuses a ledger URL filed through another forge", async () => {
    const calls: Recorded[] = [];
    const delivery = createWatchdogDelivery({
      root: repository(),
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
      gh: () => {
        throw new Error("gh must not run for a Gitea origin");
      },
      fetchImpl: fakeGitea(calls),
    });
    const url = "https://github.com/acme/fixture/issues/12";
    expect(delivery.owns(url)).toBe(false);
    const commented = await delivery.comment(url, {
      category: "server-error",
      fingerprint: "fingerprint",
      line: "Synthetic error",
      firstSeen: "2026-10-01T00:00:00Z",
      lastSeen: "2026-10-01T00:00:00Z",
      count: 2,
      window: { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-01T00:01:00Z") },
      instances: [],
      reportPath: "/report.json",
    });
    expect(commented.ok).toBe(false);
    if (!commented.ok) expect(commented.reason).toContain(url);
    expect(calls).toEqual([]);
  });

  test("recognises its own issue through a loopback alias", async () => {
    const calls: Recorded[] = [];
    const delivery = createWatchdogDelivery({
      root: repository(),
      environment: { DEVBOARD_GITEA_URL: "http://localhost:3001", GITEA_TOKEN: "gitea-token" },
      gh: () => {
        throw new Error("gh must not run for a Gitea origin");
      },
      fetchImpl: fakeGitea(calls),
    });
    expect(delivery.owns("http://127.0.0.1:3001/acme/fixture/issues/12")).toBe(true);
    expect(delivery.owns("http://localhost:3001/acme/fixture/issues/12")).toBe(true);
    expect(delivery.owns("http://127.0.0.1:3001/other/fixture/issues/12")).toBe(false);
    expect(delivery.owns("http://localhost:3002/acme/fixture/issues/12")).toBe(false);
    expect(calls).toEqual([]);
  });

  test("refuses a ledger URL from another repository on the same origin", async () => {
    const calls: Recorded[] = [];
    const delivery = createWatchdogDelivery({
      root: repository(),
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test", GITEA_TOKEN: "gitea-token" },
      gh: () => {
        throw new Error("gh must not run for a Gitea origin");
      },
      fetchImpl: fakeGitea(calls),
    });
    const url = "http://gitea.test/other/fixture/issues/12";
    expect(delivery.owns(url)).toBe(false);
    const commented = await delivery.comment(url, {
      category: "server-error",
      fingerprint: "fingerprint",
      line: "Synthetic error",
      firstSeen: "2026-10-01T00:00:00Z",
      lastSeen: "2026-10-01T00:00:00Z",
      count: 2,
      window: { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-10-01T00:01:00Z") },
      instances: [],
      reportPath: "/report.json",
    });
    expect(commented.ok).toBe(false);
    if (!commented.ok) expect(commented.reason).toContain(url);
    expect(calls).toEqual([]);
  });
});

describe("Gitea watchdog activity", () => {
  const openIssue: FetchLike = async (input) =>
    /\/issues\/\d+$/.test(String(input))
      ? Response.json({ number: 5, state: "open" })
      : Response.json({ message: "unexpected" }, 500);

  const noGh = async () => {
    throw new Error("gh must not run for a Gitea origin");
  };

  test("reads only the issues its own instance serves", async () => {
    const reader = createForgeIssueReader({
      repoDir: repository(),
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      run: noGh,
      fetchImpl: openIssue,
    });
    const facts = await reader.project([
      "https://github.com/acme/fixture/issues/377",
      "http://gitea.test/acme/fixture/issues/5",
    ]);
    expect(facts).toEqual([
      { url: "http://gitea.test/acme/fixture/issues/5", state: "pending", version: null },
    ]);
  });

  test("treats loopback aliases as the same instance", async () => {
    const reader = createForgeIssueReader({
      repoDir: repository(),
      environment: { DEVBOARD_GITEA_URL: "http://127.0.0.1:3001" },
      run: noGh,
      fetchImpl: openIssue,
    });
    const facts = await reader.project(["http://localhost:3001/acme/fixture/issues/5"]);
    expect(facts).toEqual([
      { url: "http://localhost:3001/acme/fixture/issues/5", state: "pending", version: null },
    ]);
  });

  test("reads a shipped version from a release page behind the response cap", async () => {
    const tagged = taggedRepository("v1.0.0");
    const calls: string[] = [];
    const reader = createForgeIssueReader({
      repoDir: tagged.directory,
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      run: noGh,
      fetchImpl: fakeReleasePages("v1.0.0", calls, tagged.commit),
    });
    const facts = await reader.project(["http://gitea.test/acme/fixture/issues/5"]);

    expect(facts).toEqual([
      { url: "http://gitea.test/acme/fixture/issues/5", state: "implemented", version: "v1.0.0" },
    ]);
    expect(requestedReleasePages(calls)).toContain("2");
  });

  test("reads the commit a comment names past a later fingerprint and epoch stamp", async () => {
    const tagged = taggedRepository("v1.0.0");
    const short = tagged.commit.slice(0, 7);
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      if (/\/issues\/5$/.test(url.pathname)) return Response.json({ state: "closed" });
      if (url.pathname.endsWith("/issues/5/timeline")) {
        return Response.json([{ type: "close", ref_commit_sha: "" }]);
      }
      if (url.pathname.endsWith("/issues/5/comments")) {
        return Response.json([
          {
            body:
              `Shipped in ${short}.\n\n` +
              `- fingerprint \`${"d".repeat(32)}\`\n` +
              "- worker pid 2692176 at 1793310097358",
          },
        ]);
      }
      if (url.pathname.endsWith("/releases")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        return Response.json(
          page === 1 ? [{ tag_name: "v1.0.0", published_at: "2026-09-01T00:00:00Z" }] : [],
        );
      }
      return Response.json({ message: `unexpected ${url}` });
    };
    const reader = createForgeIssueReader({
      repoDir: tagged.directory,
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      run: noGh,
      fetchImpl,
    });

    expect(await reader.project(["http://gitea.test/acme/fixture/issues/5"])).toEqual([
      {
        url: "http://gitea.test/acme/fixture/issues/5",
        state: "implemented",
        version: "v1.0.0",
      },
    ]);
  });

  test("skips a SHA-shaped token the forge reports as no such commit", async () => {
    const tagged = taggedRepository("v1.0.0");
    const short = tagged.commit.slice(0, 7);
    const target = { baseUrl: "http://gitea.test", project: "acme/fixture" };
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/issues/7/timeline")) {
        return Response.json([{ type: "close", ref_commit_sha: "" }]);
      }
      if (url.pathname.endsWith("/issues/7/comments")) {
        return Response.json([{ body: `shipped in ${short}; epoch 1793310097358` }]);
      }
      if (url.pathname.endsWith(`/git/commits/${short}`)) {
        return Response.json({ sha: tagged.commit });
      }
      if (url.pathname.includes("/git/commits/")) {
        return new Response(JSON.stringify({ message: "commit does not exist" }), {
          status: 404,
        });
      }
      return Response.json({ message: `unexpected ${url}` });
    };
    const client = createGiteaVersionClient(target, tagged.directory, fetchImpl);
    const resolution = await resolveShippedVersion(
      { number: 7, state: "closed" },
      client,
      [{ tag: "v1.0.0", publishedAt: "2026-09-01T00:00:00Z" }],
    );
    expect(resolution).toEqual({ version: "v1.0.0", error: null, inferred: false });
  });

  test("reads the commit the forge linked when an API close names none", async () => {
    const tagged = taggedRepository("v1.0.0");
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      if (/\/issues\/6$/.test(url.pathname)) return Response.json({ state: "closed" });
      if (url.pathname.endsWith("/issues/6/timeline")) {
        return Response.json([
          { type: "label" },
          { type: "commit_ref", ref_commit_sha: tagged.commit },
          { type: "close", ref_commit_sha: "" },
        ]);
      }
      if (url.pathname.endsWith("/releases")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        return Response.json(
          page === 1 ? [{ tag_name: "v1.0.0", published_at: "2026-09-01T00:00:00Z" }] : [],
        );
      }
      return Response.json({ message: `unexpected ${url}` });
    };
    const reader = createForgeIssueReader({
      repoDir: tagged.directory,
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      run: noGh,
      fetchImpl,
    });

    expect(await reader.project(["http://gitea.test/acme/fixture/issues/6"])).toEqual([
      {
        url: "http://gitea.test/acme/fixture/issues/6",
        state: "implemented",
        version: "v1.0.0",
      },
    ]);
  });

  test("resolves a shipped version through the forge when no local tag names the release", async () => {
    const checkout = committedRepository();
    const shipped = "9".repeat(40);
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (/\/issues\/9$/.test(url.pathname)) return Response.json({ state: "closed" });
      if (url.pathname.endsWith("/issues/9/timeline")) {
        return Response.json([
          { type: "commit_ref", ref_commit_sha: shipped },
          { type: "close", ref_commit_sha: "" },
        ]);
      }
      if (url.pathname.endsWith("/releases")) {
        const page = Number(url.searchParams.get("page") ?? "1");
        return Response.json(
          page === 1
            ? [
                { tag_name: "v2.0.0", published_at: "2026-10-01T00:00:00Z" },
                { tag_name: "v1.0.0", published_at: "2026-09-01T00:00:00Z" },
              ]
            : [],
        );
      }
      if (url.pathname.endsWith(`/git/commits/${shipped}`)) {
        return Response.json({ sha: shipped });
      }
      if (url.pathname.endsWith(`/compare/v1.0.0...${shipped}`)) {
        return Response.json({ total_commits: 0, commits: [] });
      }
      if (url.pathname.endsWith(`/compare/v2.0.0...${shipped}`)) {
        return Response.json({ total_commits: 4, commits: [] });
      }
      return Response.json({ message: `unexpected ${url}` }, 404);
    };
    const reader = createForgeIssueReader({
      repoDir: checkout.directory,
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      run: noGh,
      fetchImpl,
    });

    expect(await reader.project(["http://gitea.test/acme/fixture/issues/9"])).toEqual([
      {
        url: "http://gitea.test/acme/fixture/issues/9",
        state: "implemented",
        version: "v1.0.0",
      },
    ]);
    expect(calls).toContain(`/api/v1/repos/acme/fixture/compare/v1.0.0...${shipped}`);
    expect(calls).not.toContain(`/api/v1/repos/acme/fixture/compare/${shipped}...v1.0.0`);
  });

  test("scans a repository's releases once for all of its closed issues", async () => {
    const tagged = taggedRepository("v1.0.0");
    const calls: string[] = [];
    const reader = createForgeIssueReader({
      repoDir: tagged.directory,
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      run: noGh,
      fetchImpl: fakeClosedIssues(tagged.commit, calls),
    });
    const facts = await reader.project([
      "http://gitea.test/acme/fixture/issues/5",
      "http://gitea.test/acme/fixture/issues/6",
      "http://gitea.test/acme/fixture/issues/7",
    ]);

    expect(facts.map((fact) => fact.version)).toEqual(["v1.0.0", "v1.0.0", "v1.0.0"]);
    expect(releasePagesByRepository(calls)).toEqual({ "acme/fixture": ["1", "2"] });
  });

  test("scans each repository's releases once when the ledger names two", async () => {
    const tagged = taggedRepository("v1.0.0");
    const calls: string[] = [];
    const reader = createForgeIssueReader({
      repoDir: tagged.directory,
      environment: { DEVBOARD_GITEA_URL: "http://gitea.test" },
      run: noGh,
      fetchImpl: fakeClosedIssues(tagged.commit, calls),
    });
    const facts = await reader.project([
      "http://gitea.test/acme/alpha/issues/5",
      "http://gitea.test/acme/alpha/issues/6",
      "http://gitea.test/acme/beta/issues/5",
    ]);

    expect(facts.map((fact) => fact.version)).toEqual(["v1.0.0", "v1.0.0", "v1.0.0"]);
    expect(releasePagesByRepository(calls)).toEqual({
      "acme/alpha": ["1", "2"],
      "acme/beta": ["1", "2"],
    });
  });

  test("the scout reads releases behind the response cap", async () => {
    const tagged = taggedRepository("v1.0.0");
    const calls: string[] = [];
    const client = createScoutGitHub({
      repository: "acme/fixture",
      repoDir: tagged.directory,
      forge: "gitea",
      baseUrl: "http://gitea.test",
      environment: {},
      giteaFetch: fakeReleasePages("v1.0.0", calls, tagged.commit),
    });

    const releases = await client.listReleases();
    expect(releases.map((release) => release.tag)).toContain("v1.0.0");
    expect(await shippedVersion({ number: 5, state: "closed" }, client, releases)).toBe("v1.0.0");
    expect(requestedReleasePages(calls)).toContain("2");
  });
});

describe("Gitea closing commit", () => {
  const closed = "a".repeat(40);

  test("a close entry's commit outranks the commit_ref entries around it", () => {
    expect(
      closingCommitFromGiteaTimeline([
        { type: "commit_ref", ref_commit_sha: "b".repeat(40) },
        { type: "close", commit_id: closed },
        { type: "comment", commit_id: "c".repeat(40) },
      ]),
    ).toBe(closed);
  });

  test("every commit_ref before the newest close is a candidate, newest first", () => {
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    expect(
      closingCommitsFromGiteaTimeline([
        { type: "commit_ref", ref_commit_sha: first },
        { type: "label" },
        { type: "commit_ref", ref_commit_sha: second },
        { type: "commit_ref", ref_commit_sha: second },
        { type: "close", ref_commit_sha: "" },
      ]),
    ).toEqual([second, first]);
  });

  test("a commit_ref after the close never outranks the closure", () => {
    const shipped = "3".repeat(40);
    const followUp = "4".repeat(40);
    expect(
      closingCommitsFromGiteaTimeline([
        { type: "commit_ref", ref_commit_sha: shipped },
        { type: "close", ref_commit_sha: "" },
        { type: "commit_ref", ref_commit_sha: followUp },
      ]),
    ).toEqual([shipped]);
  });

  test("reads commit_ref entries when the API close names no commit", async () => {
    const shipped = "5".repeat(40);
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/issues/12/timeline")) {
        return Response.json([
          { type: "commit_ref", ref_commit_sha: shipped },
          { type: "close", ref_commit_sha: "" },
        ]);
      }
      return Response.json({ message: `unexpected ${path}` });
    };

    expect(
      await giteaClosingCommits(
        { baseUrl: "http://gitea.test", project: "acme/fixture" },
        12,
        fetchImpl,
      ),
    ).toEqual([shipped]);
  });

  test("the newest close entry wins across a reopen", () => {
    expect(
      closingCommitFromGiteaTimeline([
        { type: "close", commit_id: "d".repeat(40) },
        { type: "reopen" },
        { type: "close", commit_id: closed },
      ]),
    ).toBe(closed);
  });

  test("reads the close entry's ref_commit_sha, the field current Gitea emits", () => {
    expect(
      closingCommitFromGiteaTimeline([
        { type: "comment_ref", ref_commit_sha: "b".repeat(40) },
        { type: "close", ref_commit_sha: closed },
      ]),
    ).toBe(closed);
    expect(
      closingCommitFromGiteaTimeline([
        { type: "close", commit_id: null, ref_commit_sha: "" },
      ]),
    ).toBeNull();
  });

  test("offers every comment token newest first when no close entry names a commit", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/issues/9/timeline")) {
        return Response.json([{ type: "close", ref_commit_sha: "" }]);
      }
      if (path.endsWith("/issues/9/comments")) {
        return Response.json([
          { body: "older thread names 1234567 then 7654321" },
          { body: `fingerprint ${"d".repeat(32)} pid 2692176 at 1793310097358` },
        ]);
      }
      return Response.json({ message: `unexpected ${path}` });
    };

    expect(
      await giteaClosingCommits(
        { baseUrl: "http://gitea.test", project: "acme/fixture" },
        9,
        fetchImpl,
      ),
    ).toEqual(["1793310097358", "2692176", "d".repeat(32), "7654321", "1234567"]);
  });

  test("a close entry's commit is the only candidate", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/issues/11/timeline")) {
        return Response.json([{ type: "close", ref_commit_sha: closed }]);
      }
      return Response.json({ message: `unexpected ${path}` });
    };

    expect(
      await giteaClosingCommits(
        { baseUrl: "http://gitea.test", project: "acme/fixture" },
        11,
        fetchImpl,
      ),
    ).toEqual([closed]);
  });

  test("falls back to comments only when no close entry carries a commit", async () => {
    const commentCommit = "e".repeat(40);
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/issues/7/timeline")) {
        return Response.json([
          { type: "comment", commit_id: "b".repeat(40) },
          { type: "close", commit_id: null },
        ]);
      }
      if (path.endsWith("/issues/7/comments")) {
        return Response.json([{ body: "in progress" }, { body: `Shipped in ${commentCommit}.` }]);
      }
      return Response.json({ message: `unexpected ${path}` });
    };

    expect(
      await giteaClosingCommit(
        { baseUrl: "http://gitea.test", project: "acme/fixture" },
        7,
        fetchImpl,
      ),
    ).toBe(commentCommit);
  });

  test("pages the timeline until the closing entry", async () => {
    const calls: string[] = [];
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      type: "comment",
      commit_id: "b".repeat(40),
    }));
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/issues/10/timeline")) {
        const page = url.searchParams.get("page");
        if (page === "1") return Response.json(firstPage);
        if (page === "2") return Response.json([{ id: 51, type: "close", commit_id: closed }]);
        return Response.json([]);
      }
      return Response.json({ message: `unexpected ${url}` });
    };

    expect(
      await giteaClosingCommit(
        { baseUrl: "http://gitea.test", project: "acme/fixture" },
        10,
        fetchImpl,
      ),
    ).toBe(closed);

    const timelineCalls = calls.filter((call) => call.includes("/issues/10/timeline?"));
    const params = timelineCalls.map(
      (call) => new URL(call, "http://gitea.test").searchParams,
    );
    expect(params.map((query) => query.get("page"))).toEqual(["1", "2", "3"]);
    expect(params.map((query) => query.get("limit"))).toEqual(["50", "50", "50"]);
  });

  test("stops after a page that adds no new entry", async () => {
    const calls: string[] = [];
    const repeated = [
      { id: 1, type: "comment", commit_id: "b".repeat(40) },
      { id: 2, type: "commit_ref", commit_id: "b".repeat(40) },
    ];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (
        url.pathname.endsWith("/issues/11/timeline") ||
        url.pathname.endsWith("/issues/11/comments")
      ) {
        return Response.json(repeated);
      }
      return Response.json({ message: `unexpected ${url}` });
    };

    expect(
      await giteaClosingCommit(
        { baseUrl: "http://gitea.test", project: "acme/fixture" },
        11,
        fetchImpl,
      ),
    ).toBeNull();
    expect(calls.filter((call) => call.includes("/issues/11/timeline?")).length).toBe(2);
    expect(calls.filter((call) => call.includes("/issues/11/comments?")).length).toBe(2);
  });

  test("never returns a commit named only by non-closing entries", async () => {
    const referenced = "b".repeat(40);
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/issues/8/timeline")) {
        return Response.json([
          { type: "commit_ref", commit_id: referenced },
          { type: "comment", commit_id: referenced },
          { type: "review", commit_id: referenced },
        ]);
      }
      return Response.json([]);
    };

    expect(
      await giteaClosingCommit(
        { baseUrl: "http://gitea.test", project: "acme/fixture" },
        8,
        fetchImpl,
      ),
    ).toBeNull();
  });

  test("the design reader resolves through the shared helper", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/issues/9/timeline")) {
        return Response.json([
          { type: "commit_ref", commit_id: "b".repeat(40) },
          { type: "close", commit_id: closed },
        ]);
      }
      return Response.json({ message: `unexpected ${path}` });
    };
    const client = createDesignForge({
      forge: "gitea",
      repository: "acme/fixture",
      repoDir: repository(),
      baseUrl: "http://gitea.test",
      environment: {},
      giteaFetch: fetchImpl,
    });

    expect(await client.closingCommit(9)).toBe(closed);
  });
});
