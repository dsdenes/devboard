import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { cachedRepository, repositoryFromUrl } from "../issues/repository";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A fresh checkout whose origin is `origin`, or an origin-free checkout. */
async function repositoryFixture(origin?: string): Promise<string> {
  const root = await mkdtemp(join(import.meta.dir, ".tmp-repository-"));
  temporaryDirectories.push(root);
  Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
  if (origin !== undefined) pointOrigin(root, origin);
  return root;
}

/** Re-points the fixture's `origin`, adding it when the checkout has none. */
function pointOrigin(root: string, url: string): void {
  Bun.spawnSync({ cmd: ["git", "-C", root, "remote", "remove", "origin"] });
  const added = Bun.spawnSync({ cmd: ["git", "-C", root, "remote", "add", "origin", url] });
  if (added.exitCode !== 0) {
    throw new Error(`git remote add origin failed: ${added.stderr.toString()}`);
  }
}

test("re-reads an origin added after the first lookup", async () => {
  const root = await repositoryFixture();

  const repository = cachedRepository(root, 0);
  expect(repository()).toBeNull();

  pointOrigin(root, "https://github.com/acme/fixture.git");
  expect(repository()).toBe("acme/fixture");
});

test("serves the cached origin while the ttl has not elapsed", async () => {
  const root = await repositoryFixture("https://github.com/acme/first.git");
  const ttlMs = 60_000;
  const start = 1_000_000;
  try {
    setSystemTime(new Date(start));
    const repository = cachedRepository(root, ttlMs);
    expect(repository()).toBe("acme/first");

    pointOrigin(root, "https://github.com/acme/second.git");
    setSystemTime(new Date(start + ttlMs - 1));
    expect(repository()).toBe("acme/first");
    expect(repository()).toBe("acme/first");
  } finally {
    setSystemTime();
  }
});

test("re-reads the origin once the ttl has elapsed", async () => {
  const root = await repositoryFixture("https://github.com/acme/first.git");
  const ttlMs = 60_000;
  const start = 1_000_000;
  try {
    setSystemTime(new Date(start));
    const repository = cachedRepository(root, ttlMs);
    expect(repository()).toBe("acme/first");

    pointOrigin(root, "https://github.com/acme/second.git");
    setSystemTime(new Date(start + ttlMs));
    expect(repository()).toBe("acme/second");
    expect(repository()).toBe("acme/second");
  } finally {
    setSystemTime();
  }
});

test("keeps a GitLab subgroup in the repository identity", () => {
  expect(repositoryFromUrl("git@gitlab.com:group/sub/project.git")).toBe("group/sub/project");
  expect(repositoryFromUrl("https://gitlab.com/group/sub/project.git")).toBe("group/sub/project");
  expect(repositoryFromUrl("git@gitlab.com:first/team/service.git")).not.toBe(
    repositoryFromUrl("git@gitlab.com:second/team/service.git"),
  );
});

test("keeps owner/name for GitHub and Gitea remotes", () => {
  expect(repositoryFromUrl("git@github.com:owner/repo.git")).toBe("owner/repo");
  expect(repositoryFromUrl("ssh://git@localhost:2223/owner/repo.git")).toBe("owner/repo");
});
