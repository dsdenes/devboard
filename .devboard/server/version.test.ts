import { afterAll, describe, expect, test } from "bun:test";
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
      "@dsdenes/devboard-harness",
      "0.1.9",
    );

    expect(serverVersion(host, "0.1.8", "0.1.9")).toEqual({
      running: "0.1.8",
      installed: "0.1.9",
      latest: "0.1.9",
      stale: true,
    });
  });

  test("reports no stale version when the prefix holds the running version", async () => {
    const host = await temporaryDirectory();
    await writePackage(
      installedPackageDir(join(host, ".devboard")),
      "@dsdenes/devboard-harness",
      "0.1.9",
    );

    expect(serverVersion(host, "0.1.9", "0.1.9")).toEqual({
      running: "0.1.9",
      installed: "0.1.9",
      latest: "0.1.9",
      stale: false,
    });
  });

  test("uses the source tree as the harness of a canonical checkout", async () => {
    const host = await temporaryDirectory();
    await writePackage(join(host, ".devboard"), "@dsdenes/devboard-harness", "0.1.0");

    expect(hostHarnessDir(host)).toBe(join(host, ".devboard"));
    expect(serverVersion(host, "0.1.0")).toEqual({
      running: "0.1.0",
      installed: "0.1.0",
      latest: null,
      stale: false,
    });
  });

  test("falls back to the running checkout for a host without a harness", async () => {
    const host = await temporaryDirectory();

    expect(hostHarnessDir(host)).toBe(runningHarnessDir());
    expect(readHarnessVersion(host)).toBeNull();
  });
});
