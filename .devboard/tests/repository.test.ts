import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { cachedRepository, repositoryFromUrl } from "../issues/repository";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("re-reads an origin added after the first lookup", async () => {
  const root = await mkdtemp(join(import.meta.dir, ".tmp-repository-"));
  temporaryDirectories.push(root);
  Bun.spawnSync({ cmd: ["git", "init", "-q", root] });

  const repository = cachedRepository(root, 0);
  expect(repository()).toBeNull();

  Bun.spawnSync({
    cmd: ["git", "-C", root, "remote", "add", "origin", "https://github.com/acme/fixture.git"],
  });
  expect(repository()).toBe("acme/fixture");
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
