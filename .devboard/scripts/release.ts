#!/usr/bin/env bun
/**
 * Publishes one Devboard release from a `main` commit.
 *
 * The version is `0.1.<commit-count>` over the full history, so every commit
 * has its own immutable version. One public npm package carries the launcher,
 * server, client sources, built bundle, prompts, wrappers, extensions,
 * templates, and installer. The canonical Gitea release records the same tag
 * with notes plus the npm tarball and its `.sha256`, kept as a fallback when
 * npm cannot serve the artifact. Re-running the same commit is a no-op.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const PACKAGE_NAME = "@dsdenes/devboard";
const releaseRoot = join(harnessRoot, ".tmp", "release");

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

const publishable = run("npm", [
  "view",
  `${PACKAGE_NAME}@${version}`,
  "version",
  "--cache",
  join(harnessRoot, ".tmp", "npm-cache"),
  "--prefer-online",
]);
const packageExists = publishable.code === 0 && publishable.stdout === version;

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
const { tarball, checksum } = await createReleaseDirectory(version, releaseRoot);
console.log(`release: packed ${tarball}`);

if (packageExists) {
  console.log(`release: ${PACKAGE_NAME}@${version} already exists on npm; skipping publish`);
} else {
  if (process.env.NPM_TOKEN === undefined && process.env.NODE_AUTH_TOKEN === undefined) {
    fail("no npm token in NPM_TOKEN or NODE_AUTH_TOKEN; cannot publish the package");
  }
  console.log(`release: publishing ${PACKAGE_NAME}@${version}`);
  // npm reads ~/.npmrc, which can hold a stale token that shadows the release
  // credential. Use an explicit, private userconfig for this publish instead.
  const npmToken = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN ?? "";
  const npmrc = join(releaseRoot, "npmrc");
  await writeFile(npmrc, `//registry.npmjs.org/:_authToken=${npmToken}\n`, { mode: 0o600 });
  const published = run(
    "npm",
    ["publish", tarball, "--access", "public", "--userconfig", npmrc],
    harnessRoot,
  );
  await rm(npmrc, { force: true });
  if (published.code !== 0) {
    fail(`npm publish failed: ${published.stderr.split("\n").slice(-3).join(" ")}`);
  }
}

const assets = new Set((existing?.assets ?? []).map((asset) => asset.name));
const names = [tarball, checksum].map((path) => path.split("/").pop() ?? "");

if (releaseExists) {
  const missing = names.filter((name) => !assets.has(name));
  if (missing.length > 0) {
    if (token === undefined) fail("GITEA_TOKEN is required to add a missing release asset");
    if (existing?.id === undefined) fail(`release ${tag} has no identifier`);
    for (const name of missing) {
      const path = name === names[0] ? tarball : checksum;
      await giteaUploadAsset(target, existing.id, name, await readFile(path));
      console.log(`release: uploaded missing asset ${name}`);
    }
  } else {
    console.log(`release: ${tag} already exists; its assets are intact`);
  }
} else {
  if (token === undefined) fail("GITEA_TOKEN is required to create a release");
  const created = await giteaCreateRelease(target, {
    tag,
    title: `Devboard ${version}`,
    notes:
      `Devboard ${version}\n\n` +
      `npm: ${PACKAGE_NAME}@${version}\n` +
      `Fallback: the attached tarball and its .sha256`,
  });
  if (created.id === undefined) fail("the created release has no identifier");
  await giteaUploadAsset(target, created.id, names[0] ?? "", await readFile(tarball));
  await giteaUploadAsset(target, created.id, names[1] ?? "", await readFile(checksum));
  console.log(`release: created ${tag} with the tarball and checksum`);
}

console.log(`release: v${version} is published`);
