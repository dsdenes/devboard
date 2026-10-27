import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { cachedRepository } from "../issues/repository";

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
