import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRevision, serverVersion } from "./version";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "devboard-version-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function committedCheckout(name: string): Promise<string> {
  const directory = join(await temporaryDirectory(), name);
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--quiet");
  git(directory, "config", "user.email", "devboard@example.test");
  git(directory, "config", "user.name", "Devboard Test");
  await writeFile(join(directory, "server.ts"), `export const version = ${JSON.stringify(name)};\n`);
  git(directory, "add", "server.ts");
  git(directory, "commit", "--quiet", "-m", name);
  return directory;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("serverVersion", () => {
  test("reports a stale version when the host link names another commit", async () => {
    const running = await committedCheckout("running");
    const installed = await committedCheckout("installed");
    const host = await temporaryDirectory();
    await symlink(installed, join(host, ".devboard"));

    const runningRevision = git(running, "rev-parse", "HEAD");
    const installedRevision = git(installed, "rev-parse", "HEAD");

    expect(serverVersion(host, runningRevision)).toEqual({
      running: runningRevision,
      current: installedRevision,
      stale: true,
    });
  });

  test("reports no stale version when the link names the running commit", async () => {
    const running = await committedCheckout("current");
    const host = await temporaryDirectory();
    await symlink(running, join(host, ".devboard"));

    const revision = git(running, "rev-parse", "HEAD");

    expect(serverVersion(host, revision)).toEqual({
      running: revision,
      current: revision,
      stale: false,
    });
  });

  test("reports no revision for a directory that does not exist", async () => {
    const host = await temporaryDirectory();

    expect(gitRevision(join(host, "missing"))).toBeNull();
  });
});
