#!/usr/bin/env bun
/**
 * Publishes one harness release from a `main` commit.
 *
 * The version is `0.1.<commit-count>` over the full history, so every commit
 * has its own immutable version. The harness tarball and its `.sha256` go to
 * GitHub Releases; the public launcher tarball goes to npmjs. Re-running the
 * same commit is a no-op: an existing npm version and an existing release are
 * left untouched.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReleaseDirectory, harnessRoot, repoRoot } from "./harness-package";

const RELEASE_REPO = "dsdenes/devboard";
const LAUNCHER_PACKAGE = "@dsdenes/devboard";
const releaseRoot = join(harnessRoot, ".tmp", "release");
const launcherRoot = join(harnessRoot, "launcher");

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd = harnessRoot): Result {
  const child = Bun.spawnSync({
    cmd: [command, ...args],
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    code: child.exitCode ?? 1,
    stdout: child.stdout.toString().trim(),
    stderr: child.stderr.toString().trim(),
  };
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

const head = run("git", ["rev-parse", "HEAD"], repoRoot);
if (head.code !== 0) fail("could not read HEAD");

const count = run("git", ["rev-list", "--count", "HEAD"], repoRoot);
if (count.code !== 0) fail("could not count commits; fetch the full history");
const version = `0.1.${Number(count.stdout)}`;
if (!/^0\.1\.[0-9]+$/.test(version)) fail(`computed an invalid version: ${version}`);
const tag = `v${version}`;

const publishable = run("npm", ["view", `${LAUNCHER_PACKAGE}@${version}`, "version"]);
const launcherExists = publishable.code === 0 && publishable.stdout === version;
const releaseView = run("gh", [
  "release",
  "view",
  tag,
  "--repo",
  RELEASE_REPO,
  "--json",
  "tagName",
  "--jq",
  ".tagName",
]);
const releaseExists = releaseView.code === 0;

console.log(`release: ${tag} at ${head.stdout.slice(0, 7)}`);

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
const { tarball, checksum } = await createReleaseDirectory(version, join(releaseRoot, "harness"));
console.log(`release: packed ${tarball}`);

if (launcherExists) {
  console.log(`release: ${LAUNCHER_PACKAGE}@${version} already exists on npm; skipping publish`);
} else {
  if (process.env.NPM_TOKEN === undefined && process.env.NODE_AUTH_TOKEN === undefined) {
    fail("no npm token in NPM_TOKEN or NODE_AUTH_TOKEN; cannot publish the launcher");
  }
  const staged = join(releaseRoot, `launcher-${version}`);
  await mkdir(join(staged, "bin"), { recursive: true });
  await cp(join(launcherRoot, "package.json"), join(staged, "package.json"));
  await cp(join(launcherRoot, "README.md"), join(staged, "README.md"));
  await cp(join(launcherRoot, "bin", "devboard.mjs"), join(staged, "bin", "devboard.mjs"));
  const manifestPath = join(staged, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`release: publishing ${LAUNCHER_PACKAGE}@${version}`);
  const published = run("npm", ["publish", "--access", "public"], staged);
  if (published.code !== 0) {
    fail(`npm publish failed: ${published.stderr.split("\n").slice(-3).join(" ")}`);
  }
}

if (releaseExists) {
  console.log(`release: ${tag} already exists; leaving its assets untouched`);
} else {
  const created = run("gh", [
    "release",
    "create",
    tag,
    "--repo",
    RELEASE_REPO,
    "--title",
    `Devboard harness ${version}`,
    "--notes",
    `Harness package ${version}\n\nLauncher: ${LAUNCHER_PACKAGE}@${version}`,
    tarball,
    checksum,
  ]);
  if (created.code !== 0) fail(`gh release create failed: ${created.stderr}`);
  console.log(`release: created ${tag} with the harness tarball and checksum`);
}

console.log(`release: v${version} is published`);
