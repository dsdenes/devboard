import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createWatchdogDelivery } from "../watchdog/delivery";
import { loadRootEnvironment } from "../watchdog/env";

/**
 * The watchdog runs from the harness directory, so the host root's `.env`
 * never reached it by working directory. These tests pin the explicit load
 * and the delivery it unblocks; every fixture stays under `.devboard/.tmp`.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, `${prefix}-${randomUUID()}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const noGh = () => ({ code: 0, stdout: "", stderr: "" });

describe("root environment", () => {
  test("loads the host file and keeps explicitly set values", async () => {
    const root = await temporaryDirectory("test-watchdog-env");
    await writeFile(
      join(root, ".env"),
      [
        "# host configuration",
        "DEVBOARD_GITEA_URL=http://127.0.0.1:3001",
        "export GITEA_TOKEN=\"file-token\"",
        "UNUSED=a=b",
        "EMPTY=",
        "",
      ].join("\n"),
    );
    const environment: Record<string, string | undefined> = {
      GITEA_TOKEN: "explicit-token",
      EMPTY: "kept",
    };

    loadRootEnvironment(root, environment);

    expect(environment.DEVBOARD_GITEA_URL).toBe("http://127.0.0.1:3001");
    expect(environment.GITEA_TOKEN).toBe("explicit-token");
    expect(environment.UNUSED).toBe("a=b");
    expect(environment.EMPTY).toBe("kept");
  });

  test("a root without .env changes nothing", async () => {
    const root = await temporaryDirectory("test-watchdog-env-missing");
    const environment: Record<string, string | undefined> = { PATH: "/usr/bin" };

    expect(() => loadRootEnvironment(root, environment)).not.toThrow();
    expect(environment).toEqual({ PATH: "/usr/bin" });
  });

  test("an SSH Gitea origin delivers once the host file supplies the address", async () => {
    const root = await temporaryDirectory("test-watchdog-env-origin");
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "remote", "add", "origin", "ssh://git@example.test:2222/acme/fixture.git");
    await writeFile(
      join(root, ".env"),
      "DEVBOARD_GITEA_URL=http://127.0.0.1:3001\nGITEA_TOKEN=file-token\n",
    );

    const environment: Record<string, string | undefined> = {};
    expect(() =>
      createWatchdogDelivery({ root, environment, gh: noGh }),
    ).toThrow("the watchdog needs DEVBOARD_GITEA_URL for a Gitea origin");

    loadRootEnvironment(root, environment);
    const delivery = createWatchdogDelivery({ root, environment, gh: noGh });
    expect(delivery.repository).toBe("acme/fixture");
  });
});
