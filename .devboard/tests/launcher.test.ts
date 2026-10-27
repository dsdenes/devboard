import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createReleaseDirectory, packedPaths } from "../scripts/harness-package";

/**
 * Package boundaries: the launcher carries bootstrap code only, the harness
 * carries the interface and its assets, and neither tarball leaks a development
 * directory.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(harnessRoot, "..");
const testRoot = join(harnessRoot, ".tmp");
const launcherRoot = join(harnessRoot, "launcher");
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

function packBytes(stdout: string): { size: number; unpackedSize: number } {
  const parsed: unknown = JSON.parse(stdout);
  const values =
    Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === "object"
        ? Object.values(parsed)
        : [];
  const entry = values[0] as { size?: number; unpackedSize?: number } | undefined;
  return { size: entry?.size ?? Number.POSITIVE_INFINITY, unpackedSize: entry?.unpackedSize ?? 0 };
}

function tarballBytes(tarball: string): { compressed: number; unpacked: number } {
  const listing = Bun.spawnSync({ cmd: ["tar", "-tvzf", tarball], stdout: "pipe", stderr: "pipe" });
  expect(listing.exitCode).toBe(0);
  let unpacked = 0;
  for (const line of listing.stdout.toString().split("\n")) {
    if (line.trim().length === 0) continue;
    const size = Number(line.trim().split(/\s+/)[2]);
    if (Number.isFinite(size)) unpacked += size;
  }
  return { compressed: Bun.file(tarball).size, unpacked };
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("launcher package", () => {
  test("packs only the bootstrap files, under the size ceiling", async () => {
    const destination = await temporaryDirectory("pack-launcher");
    const result = npm(["pack", "--json", "--dry-run"], launcherRoot);
    expect(result.code).toBe(0);
    const files = packFiles(result.stdout);
    const sizes = packBytes(result.stdout);
    expect(files.map((file) => file.path).sort()).toEqual([
      "README.md",
      "bin/devboard.mjs",
      "package.json",
    ]);
    expect(sizes.size).toBeLessThanOrEqual(100 * 1024);
    expect(files.some((file) => file.path.startsWith("server/"))).toBe(false);
    expect(files.some((file) => file.path.startsWith("client/"))).toBe(false);
    expect(files.some((file) => file.path.startsWith("dist/"))).toBe(false);
    expect(files.some((file) => file.path.startsWith("prompts/"))).toBe(false);
    expect(files.some((file) => file.path.startsWith("omp/"))).toBe(false);
    expect(files.some((file) => file.path.startsWith("tests/"))).toBe(false);
    expect(await readdir(destination)).toEqual([]);
  });

  test("declares a Node 20 bin package without dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(launcherRoot, "package.json"), "utf8"));
    expect(manifest.name).toBe("@dsdenes/devboard");
    expect(manifest.private).toBeUndefined();
    expect(manifest.bin).toEqual({ devboard: "bin/devboard.mjs" });
    expect(manifest.engines.node).toBe(">=20");
    expect(manifest.dependencies).toBeUndefined();
  });

  test("--help lists install, update, and doctor", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(launcherRoot, "bin", "devboard.mjs"), "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const help = result.stdout.toString();
    for (const command of ["install", "update", "doctor"]) expect(help).toContain(command);
  });
});

describe("harness package", () => {
  // The bundle is a build artifact; a fresh checkout has no dist yet.
  const built = existsSync(join(harnessRoot, "dist", "index.html"));
  test.skipIf(!built)("packs every runtime file and stays under the size ceilings", async () => {
    const directory = await temporaryDirectory("pack-harness");
    const release = await createReleaseDirectory("0.1.999", directory);
    const files = await packedPaths(release.tarball);
    const present = new Set(files);
    for (const required of [
      "package.json",
      "AGENTS.md",
      "templates/host-AGENTS.md",
      "server/index.ts",
      "server/updates.ts",
      "orchestrator/main.ts",
      "orchestrator/units/devboard-orchestrator.service",
      "dist/index.html",
      "install.sh",
    ]) {
      expect(present.has(required)).toBe(true);
    }
    expect(files.some((path) => path.startsWith("prompts/"))).toBe(true);
    expect(files.some((path) => path.startsWith("omp/commands/"))).toBe(true);
    expect(files.some((path) => path.startsWith("omp/extensions/"))).toBe(true);
    for (const forbidden of ["node_modules/", ".tmp/", "goals/", "tests/", "launcher/", ".worktree/"]) {
      expect(files.some((path) => path.startsWith(forbidden))).toBe(false);
    }
    const html = readFileSync(join(harnessRoot, "dist", "index.html"), "utf8");
    for (const match of html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)) {
      expect(present.has(`dist/${match[1]}`)).toBe(true);
    }
    const sizes = tarballBytes(release.tarball);
    expect(sizes.compressed).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(sizes.unpacked).toBeLessThanOrEqual(20 * 1024 * 1024);
  });

  test("keeps templates/host-AGENTS.md byte-identical to the root contract", () => {
    expect(
      readFileSync(join(harnessRoot, "templates", "host-AGENTS.md")).equals(
        readFileSync(join(repoRoot, "AGENTS.md")),
      ),
    ).toBe(true);
    expect(existsSync(join(harnessRoot, "templates", "host-AGENTS.md"))).toBe(true);
  });
});
