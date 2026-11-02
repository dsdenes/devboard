import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  hostHarnessDir,
  installedPackageDir,
  readHarnessVersion,
  runningHarnessDir,
  serverVersion,
} from "./version";

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = join(testRoot, `version-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

async function writePackage(directory: string, name: string, version: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
}

function git(directory: string, args: string[]): void {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Version Test",
      "-c",
      "user.email=version@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}

async function commit(directory: string, message: string): Promise<void> {
  await writeFile(join(directory, `${message}.txt`), `${message}\n`);
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-q", "-m", message]);
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("serverVersion", () => {
  test("reports a stale version when the installed prefix holds another version", async () => {
    const host = await temporaryDirectory();
    await writePackage(
      installedPackageDir(join(host, ".devboard")),
      "@dsdenes/devboard",
      "0.1.9",
    );

    expect(serverVersion(host, "0.1.8", "0.1.9")).toEqual({
      running: "0.1.8",
      installed: "0.1.9",
      latest: "0.1.9",
      stale: true,
      source: true,
    });
  });

  test("reports no stale version when the prefix holds the running version", async () => {
    const host = await temporaryDirectory();
    await writePackage(
      installedPackageDir(join(host, ".devboard")),
      "@dsdenes/devboard",
      "0.1.9",
    );

    expect(serverVersion(host, "0.1.9", "0.1.9")).toEqual({
      running: "0.1.9",
      installed: "0.1.9",
      latest: "0.1.9",
      stale: false,
      source: true,
    });
  });

  test("uses the source tree as the harness of a canonical checkout", async () => {
    const host = await temporaryDirectory();
    await writePackage(join(host, ".devboard"), "@dsdenes/devboard", "0.1.0");

    expect(hostHarnessDir(host)).toBe(join(host, ".devboard"));
    expect(serverVersion(host, "0.1.0")).toEqual({
      running: "0.1.0",
      installed: "0.1.0",
      latest: null,
      stale: false,
      source: true,
    });
  });

  test("derives an unpacked source version from the newest reachable release tag", async () => {
    const host = await temporaryDirectory();
    git(host, ["init", "-q"]);
    await writePackage(join(host, ".devboard"), "@dsdenes/devboard", "0.1.0");
    await commit(host, "feat: first");

    expect(readHarnessVersion(join(host, ".devboard"))).toBe("0.1.0");

    git(host, ["tag", "v1.0.0"]);
    expect(readHarnessVersion(join(host, ".devboard"))).toBe("1.0.0");

    await commit(host, "fix: second");
    expect(readHarnessVersion(join(host, ".devboard"))).toBe("1.0.0");

    git(host, ["tag", "v1.0.1"]);
    expect(readHarnessVersion(join(host, ".devboard"))).toBe("1.0.1");
    expect(serverVersion(host, "1.0.1", "1.0.1")).toEqual({
      running: "1.0.1",
      installed: "1.0.1",
      latest: "1.0.1",
      stale: false,
      source: true,
    });

    await commit(host, "chore: unreleased change");
    expect(readHarnessVersion(join(host, ".devboard"))).toBe("1.0.1");
  });

  test("never reads a host release tag into an installed package version", async () => {
    const host = await temporaryDirectory();
    git(host, ["init", "-q"]);
    await commit(host, "feat: first");
    git(host, ["tag", "v9.9.9"]);
    const installed = installedPackageDir(join(host, ".devboard"));
    await writePackage(installed, "@dsdenes/devboard", "0.1.0");

    expect(readHarnessVersion(installed)).toBe("0.1.0");
  });

  test("falls back to the running checkout for a host without a harness", async () => {
    const host = await temporaryDirectory();

    expect(hostHarnessDir(host)).toBe(runningHarnessDir());
    expect(readHarnessVersion(host)).toBeNull();
  });
});
