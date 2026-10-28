import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createReleaseDirectory, packedPaths } from "../scripts/harness-package";

/**
 * Package boundaries for the single public package: one tarball carries the
 * launcher, interface, assets, wrappers, templates, and installer, and never a
 * development directory.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(harnessRoot, "..");
const testRoot = join(harnessRoot, ".tmp");
const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
  await mkdir(testRoot, { recursive: true });
  const directory = join(testRoot, `${name}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

function npm(args: string[], cwd: string) {
  const result = Bun.spawnSync({
    cmd: ["npm", ...args],
    cwd,
    env: {
      ...process.env,
      NODE_AUTH_TOKEN: "",
      NPM_TOKEN: "",
      npm_config_cache: join(testRoot, "npm-cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function packFiles(stdout: string): Array<{ path: string; size: number }> {
  const parsed: unknown = JSON.parse(stdout);
  const values =
    Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  const entry = values[0] as { files?: Array<{ path: string; size: number }> } | undefined;
  return entry?.files ?? [];
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("public package", () => {
  test("declares the public single-package manifest and the launcher bin", () => {
    const manifest = JSON.parse(readFileSync(join(harnessRoot, "package.json"), "utf8"));
    expect(manifest.name).toBe("@dsdenes/devboard");
    expect(manifest.private).toBeUndefined();
    expect(manifest.bin).toEqual({ devboard: "bin/devboard.mjs" });
    expect(manifest.engines.node).toBe(">=20");
    expect(manifest.publishConfig).toEqual({ access: "public" });
  });

  test("packs the whole runtime and no development directory", async () => {
    const destination = await temporaryDirectory("pack");
    const result = npm(["pack", "--json", "--pack-destination", destination], harnessRoot);
    expect(result.code).toBe(0);
    const paths = packFiles(result.stdout).map((file) => file.path);
    const tarballs = await readdir(destination);
    expect(tarballs).toHaveLength(1);
    const tarball = join(destination, tarballs[0]!);
    const files = (await packedPaths(tarball)).filter((path) => path.length > 0);
    const present = new Set(files);

    for (const required of [
      "package.json",
      "bin/devboard.mjs",
      "server/index.ts",
      "dist/index.html",
      "lib/release.ts",
      "issues/worker.ts",
      "watchdog/main.ts",
      "templates/host-AGENTS.md",
      "install.sh",
      "tsconfig.json",
      "vite.config.ts",
    ]) {
      expect(present.has(required)).toBe(true);
    }
    expect(files.some((path) => path.startsWith("prompts/"))).toBe(true);
    expect(files.some((path) => path.startsWith("omp/commands/"))).toBe(true);
    expect(files.some((path) => path.startsWith("omp/extensions/"))).toBe(true);
    expect(files.some((path) => path.startsWith("extensions/"))).toBe(true);
    for (const forbidden of ["node_modules/", ".tmp/", "goals/", "tests/", "launcher/", ".worktree/"]) {
      expect(files.some((path) => path.startsWith(forbidden))).toBe(false);
    }
    expect(paths).toContain("bin/devboard.mjs");
  });

  test("--help lists install, update, and doctor", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(harnessRoot, "bin", "devboard.mjs"), "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const help = result.stdout.toString();
    for (const command of ["install", "update", "doctor"]) expect(help).toContain(command);
  });
});

describe("fallback tarball", () => {
  test.skipIf(!existsSync(join(harnessRoot, "dist", "index.html")))(
    "is the npm tarball under the release asset name",
    async () => {
      const directory = await temporaryDirectory("release");
      const release = await createReleaseDirectory("0.1.999", directory);
      expect(release.tarball.endsWith("devboard-0.1.999.tgz")).toBe(true);
      expect(existsSync(release.checksum)).toBe(true);
      const files = await packedPaths(release.tarball);
      expect(files).toContain("bin/devboard.mjs");
      expect(files).toContain("server/index.ts");
      expect(files).toContain("dist/index.html");
    },
  );

  test("keeps templates/host-AGENTS.md byte-identical to the root contract", () => {
    expect(
      readFileSync(join(harnessRoot, "templates", "host-AGENTS.md")).equals(
        readFileSync(join(repoRoot, "AGENTS.md")),
      ),
    ).toBe(true);
    expect(existsSync(join(harnessRoot, "templates", "host-AGENTS.md"))).toBe(true);
  });
});
