import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { dashboardInventory, describeInventory } from "./inventory";

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = join(testRoot, `inventory-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

async function writePackage(directory: string, version: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ version })}\n`);
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dashboardInventory", () => {
  test("reports the loaded package and the package the host prefix holds", async () => {
    const host = await temporaryDirectory();
    const running = join(host, "running");
    await writePackage(running, "0.1.7");
    await writePackage(
      join(host, ".devboard", "node_modules", "@dsdenes", "devboard-harness"),
      "0.1.8",
    );

    expect(
      dashboardInventory([{ pid: 41, port: 8084, repoDir: host, harness: running }]),
    ).toEqual([
      {
        host,
        port: 8084,
        pid: 41,
        running: "0.1.7",
        installed: "0.1.8",
        stale: true,
      },
    ]);
  });

  test("reports a current dashboard without a stale flag", async () => {
    const host = await temporaryDirectory();
    const prefix = join(host, ".devboard", "node_modules", "@dsdenes", "devboard-harness");
    await writePackage(prefix, "0.1.8");

    const [entry] = dashboardInventory([{ pid: 42, port: 8085, repoDir: host, harness: prefix }]);
    expect(entry?.stale).toBe(false);
    expect(describeInventory(entry!)).toBe(
      `publish: ${host} port 8085 (pid 42) running 0.1.8 installed 0.1.8`,
    );
  });

  test("describes a stale dashboard with the literal stale marker", async () => {
    const host = await temporaryDirectory();
    const running = join(host, "running");
    await writePackage(running, "0.1.7");
    await writePackage(
      join(host, ".devboard", "node_modules", "@dsdenes", "devboard-harness"),
      "0.1.8",
    );

    const [entry] = dashboardInventory([{ pid: 43, port: 8086, repoDir: host, harness: running }]);
    expect(describeInventory(entry!)).toContain("stale");
    expect(describeInventory(entry!)).toContain("running 0.1.7 installed 0.1.8");
  });
});
