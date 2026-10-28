#!/usr/bin/env bun
/**
 * Publishes one harness release from a `main` commit.
 *
 * The version is `0.1.<commit-count>` over the full history, so every commit
 * has its own immutable version. The harness tarball and its `.sha256` go to
 * the canonical Gitea release; the public launcher tarball goes to npmjs.
 * Re-running the same commit is a no-op: an existing npm version and an
 * existing release with both assets are left untouched.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  configuredGiteaToken,
  configuredGiteaUrl,
  parseForgeRemote,
} from "../lib/forge";
import {
  GiteaError,
  giteaCreateRelease,
  giteaReleaseByTag,
  giteaUploadAsset,
  type GiteaTarget,
} from "../lib/gitea";
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

function releaseTarget(token?: string): GiteaTarget {
  let baseUrl = configuredGiteaUrl(process.env);
  if (baseUrl === undefined) {
    const origin = run("git", ["remote", "get-url", "origin"], repoRoot);
    if (origin.code === 0) {
      baseUrl = parseForgeRemote(origin.stdout)?.originUrl;
    }
  }
  if (baseUrl === undefined) {
    fail("the Gitea address is not configured; set DEVBOARD_GITEA_URL");
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    project: process.env.DEVBOARD_RELEASE_REPO ?? RELEASE_REPO,
    ...(token === undefined ? {} : { token }),
  };
}

const head = run("git", ["rev-parse", "HEAD"], repoRoot);
if (head.code !== 0) fail("could not read HEAD");

const count = run("git", ["rev-list", "--count", "HEAD"], repoRoot);
if (count.code !== 0) fail("could not count commits; fetch the full history");
const version = `0.1.${Number(count.stdout)}`;
if (!/^0\.1\.[0-9]+$/.test(version)) fail(`computed an invalid version: ${version}`);
const tag = `v${version}`;

const token = configuredGiteaToken(process.env);
const target = releaseTarget(token);

const publishable = run("npm", ["view", `${LAUNCHER_PACKAGE}@${version}`, "version"]);
const launcherExists = publishable.code === 0 && publishable.stdout === version;

let existing;
try {
  existing = await giteaReleaseByTag(target, tag);
} catch (error) {
  fail(error instanceof GiteaError ? error.message : String(error));
}
const releaseExists = existing !== undefined;

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
  const assets = new Set((existing?.assets ?? []).map((asset) => asset.name));
  const missing = [tarball, checksum].filter((path) => !assets.has(path.split("/").pop() ?? ""));
  if (missing.length > 0) {
    if (token === undefined) fail("GITEA_TOKEN is required to add a missing release asset");
    if (existing?.id === undefined) fail(`release ${tag} has no identifier`);
    for (const path of missing) {
      await giteaUploadAsset(target, existing.id, path.split("/").pop() ?? "", await readFile(path));
      console.log(`release: uploaded missing asset ${path.split("/").pop()}`);
    }
  }
  console.log(`release: ${tag} already exists; its assets are intact`);
} else {
  if (token === undefined) fail("GITEA_TOKEN is required to create a release");
  const created = await giteaCreateRelease(target, {
    tag,
    title: `Devboard harness ${version}`,
    notes: `Harness package ${version}\n\nLauncher: ${LAUNCHER_PACKAGE}@${version}`,
  });
  if (created.id === undefined) fail("the created release has no identifier");
  await giteaUploadAsset(target, created.id, tarball.split("/").pop() ?? "", await readFile(tarball));
  await giteaUploadAsset(target, created.id, checksum.split("/").pop() ?? "", await readFile(checksum));
  console.log(`release: created ${tag} with the harness tarball and checksum`);
}

console.log(`release: v${version} is published`);
