import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findOpenEpics, type OpenEpic } from "./tracker";

/** Every temporary host lives inside the worktree, never the system temp directory. */
const TEST_ROOT = join(import.meta.dir, "..", ".tmp", "tracker-epics");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

/**
 * A host whose `origin` remote names the fixture repository, with a CLI stub
 * first on PATH. `answers` maps the exact argument string to its stdout; any
 * other invocation fails, so an unexpected query fails the test loudly.
 */
async function fixtureHost(remote: string, cli: "gh" | "glab", answers: Record<string, string>): Promise<string> {
  await mkdir(TEST_ROOT, { recursive: true });
  const root = await mkdtemp(join(TEST_ROOT, "host-"));
  temporaryDirectories.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["remote", "add", "origin", remote]);

  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const cases = Object.entries(answers)
    .map(([args, stdout]) => `  '${args}') echo '${stdout}' ;;`)
    .join("\n");
  const script = `#!/bin/sh
case "$*" in
${cases}
  *) echo "unexpected ${cli} $*" >&2; exit 1 ;;
esac
`;
  await writeFile(join(bin, cli), script);
  await chmod(join(bin, cli), 0o755);
  return root;
}

/** Runs one read with the fixture CLI first on PATH. */
async function withFixturePath<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  process.env.PATH = `${join(root, "bin")}:${previousPath ?? ""}`;
  try {
    return await run();
  } finally {
    process.env.PATH = previousPath;
  }
}

const GITHUB_AUTH = {
  "auth status --hostname github.com --json hosts":
    '{"hosts":{"github.com":[{"login":"reviewer","active":true,"state":"success"}]}}',
  "auth token --hostname github.com --user reviewer": "gho_test",
  "api --hostname github.com repos/owner/repo --jq .permissions":
    '{"admin":false,"maintain":false,"push":true,"triage":true,"pull":true}',
};

const GITLAB_AUTH = {
  "auth status --hostname gitlab.com --show-token": "  ✓ Token: glpat-test",
  "api --hostname gitlab.com user": '{"username":"gitlab-user"}',
  "api --hostname gitlab.com projects/owner%2Frepo":
    '{"visibility":"private","permissions":{"project_access":{"access_level":40}}}',
};

function numbers(epics: OpenEpic[]): number[] {
  return epics.map((epic) => epic.number).sort((left, right) => left - right);
}

const BODY_SEARCH =
  "search issues --repo owner/repo --match body --state open devboard-epic --json number,title,url --limit 100";
const LABEL_LIST = "label list --search epic --limit 100 --json name";
const LABELLED_LIST = "issue list --label epic --state open --json number,title,url --limit 100";

const LABELLED_ROW = '{"number":42,"title":"Labelled epic","url":"https://github.com/owner/repo/issues/42"}';
const BODY_ROW = '{"number":43,"title":"Body epic","url":"https://github.com/owner/repo/issues/43"}';

test("returns the union of labelled and body-marked epics on GitHub", async () => {
  const root = await fixtureHost("https://github.com/owner/repo.git", "gh", {
    ...GITHUB_AUTH,
    [LABEL_LIST]: '[{"name":"epic"}]',
    [LABELLED_LIST]: `[${LABELLED_ROW}]`,
    // The search repeats the labelled issue: the union keeps one row per number.
    [BODY_SEARCH]: `[${LABELLED_ROW},${BODY_ROW}]`,
  });

  const epics = await withFixturePath(root, () => findOpenEpics(root, { timeoutMs: 10_000 }));

  expect(numbers(epics)).toEqual([42, 43]);
  expect(epics.find((epic) => epic.number === 43)?.title).toBe("Body epic");
});

test("returns the body-marked epic when no epic label exists on GitHub", async () => {
  const root = await fixtureHost("https://github.com/owner/repo.git", "gh", {
    ...GITHUB_AUTH,
    [LABEL_LIST]: "[]",
    [BODY_SEARCH]: `[${BODY_ROW}]`,
  });

  const epics = await withFixturePath(root, () => findOpenEpics(root, { timeoutMs: 10_000 }));

  expect(numbers(epics)).toEqual([43]);
});

test("returns the union of labelled and body-marked epics on GitLab", async () => {
  const root = await fixtureHost("https://gitlab.com/owner/repo.git", "glab", {
    ...GITLAB_AUTH,
    "label list --output json": '[{"name":"Epic"}]',
    "issue list --label Epic --output json":
      '[{"iid":7,"title":"Labelled epic","web_url":"https://gitlab.com/owner/repo/-/issues/7"}]',
    "issue list --search devboard-epic --in description --output json":
      '[{"iid":8,"title":"Body epic","web_url":"https://gitlab.com/owner/repo/-/issues/8"}]',
  });

  const epics = await withFixturePath(root, () => findOpenEpics(root, { timeoutMs: 10_000 }));

  expect(numbers(epics)).toEqual([7, 8]);
});

test("returns the same union from a Gitea origin", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== "/api/v1/repos/owner/repo/issues") {
        return new Response("Not Found", { status: 404 });
      }
      const page = url.searchParams.get("page");
      if (page !== "1") return Response.json([]);
      return Response.json([
        {
          number: 42,
          title: "Labelled epic",
          html_url: "https://gitea.example/owner/repo/issues/42",
          body: "A labelled epic.",
          labels: [{ name: "epic" }],
        },
        {
          number: 43,
          title: "Body epic",
          html_url: "https://gitea.example/owner/repo/issues/43",
          body: "A body-marked epic.\n\n<!-- devboard-epic -->",
          labels: [],
        },
      ]);
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const previousUrl = process.env.DEVBOARD_GITEA_URL;
  process.env.DEVBOARD_GITEA_URL = baseUrl;
  try {
    const root = await fixtureHost(`${baseUrl}/owner/repo.git`, "gh", {});
    const epics = await findOpenEpics(root, { timeoutMs: 10_000 });
    expect(numbers(epics)).toEqual([42, 43]);
  } finally {
    if (previousUrl === undefined) delete process.env.DEVBOARD_GITEA_URL;
    else process.env.DEVBOARD_GITEA_URL = previousUrl;
    server.stop(true);
  }
});
